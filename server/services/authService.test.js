import assert from 'node:assert/strict'
import test from 'node:test'
import argon2 from 'argon2'
import { ARGON2_OPTIONS, AuthError, AuthService, hashOpaqueToken, normalizeEmail, normalizeUsername, validateRegistrationInput } from './authService.js'

class FakePool {
  users = []
  sessions = []
  failSessionInsert = false
  async connect() {
    let userSnapshot
    let sessionSnapshot
    return {
      query: async (sql, values = []) => {
        if (sql === 'BEGIN') { userSnapshot = this.users.length; sessionSnapshot = this.sessions.length; return { rows: [] } }
        if (sql === 'COMMIT') return { rows: [] }
        if (sql === 'ROLLBACK') { this.users.length = userSnapshot; this.sessions.length = sessionSnapshot; return { rows: [] } }
        return this.query(sql, values)
      },
      release() {},
    }
  }
  async query(sql, values = []) {
    if (sql.includes('INSERT INTO auth_users')) {
      const [username, email, password_hash] = values
      if (this.users.some((user) => user.username.toLowerCase() === username.toLowerCase() || user.email.toLowerCase() === email.toLowerCase())) {
        const error = new Error('unique constraint'); error.code = '23505'; throw error
      }
      const row = { id: `user-${this.users.length + 1}`, username, email, password_hash, created_at: new Date() }
      this.users.push(row)
      return { rows: [row], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO auth_sessions')) {
      if (this.failSessionInsert) throw new Error('synthetic session insert failure')
      const [id, token_hash, csrf_token_hash, user_id, created_at, expires_at] = values
      this.sessions.push({ id, token_hash, csrf_token_hash, user_id, created_at, expires_at, revoked_at: null })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('FROM auth_users')) {
      const row = this.users.find((user) => user.username === values[0] || user.email === values[0])
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('FROM auth_sessions')) {
      const session = this.sessions.find((item) => item.token_hash === values[0] && !item.revoked_at && new Date(item.expires_at) > new Date(values[1]))
      const user = this.users.find((item) => item.id === session?.user_id)
      return { rows: session && user ? [{ ...session, session_id: session.id, ...user }] : [], rowCount: session && user ? 1 : 0 }
    }
    if (sql.includes('UPDATE auth_sessions SET csrf_token_hash')) {
      const session = this.sessions.find((item) => item.id === values[0])
      if (session) session.csrf_token_hash = values[1]
      return { rows: [], rowCount: session ? 1 : 0 }
    }
    if (sql.includes('UPDATE auth_sessions SET revoked_at')) {
      const session = this.sessions.find((item) => item.id === values[0])
      if (session) session.revoked_at = values[1]
      return { rows: [], rowCount: session ? 1 : 0 }
    }
    throw new Error(`Unexpected SQL in fake pool: ${sql}`)
  }
}

test('username/email normalize consistently and registration validates bounds', () => {
  assert.equal(normalizeUsername('  MiNa_42 '), 'mina_42')
  assert.equal(normalizeEmail(' Mina@Example.COM '), 'mina@example.com')
  assert.deepEqual(validateRegistrationInput({ username: ' Alice_1 ', email: 'ALICE@example.com', password: 'abcdefghijkl' }), {
    username: 'alice_1', email: 'alice@example.com', password: 'abcdefghijkl',
  })
  assert.throws(() => validateRegistrationInput({ username: 'x', email: 'bad', password: 'tiny' }), AuthError)
})

test('register stores Argon2id hash, issues opaque session and handles normalized duplicates', async () => {
  const pool = new FakePool()
  const auth = new AuthService(pool)
  const result = await auth.register({ username: ' MIna ', email: 'Mina@Example.COM', password: 'a sufficiently long password' })
  assert.equal(result.user.username, 'mina')
  assert.equal(result.user.email, 'mina@example.com')
  assert.equal(result.user.password_hash, undefined)
  const storedHash = pool.users[0].password_hash
  assert.match(storedHash, /^\$argon2id\$/)
  assert.notEqual(storedHash, 'a sufficiently long password')
  assert.equal(await argon2.verify(storedHash, 'a sufficiently long password'), true)
  assert.equal(pool.sessions[0].token_hash, hashOpaqueToken(result.session.token))
  assert.notEqual(pool.sessions[0].token_hash, result.session.token)
  assert.match(result.session.token, /^[A-Za-z0-9_-]{43}$/)
  await assert.rejects(auth.register({ username: 'mina', email: 'other@example.com', password: 'a sufficiently long password' }), (error) => error.code === 'ACCOUNT_EXISTS')
  await assert.rejects(auth.register({ username: 'other', email: 'MINA@example.com', password: 'a sufficiently long password' }), (error) => error.code === 'ACCOUNT_EXISTS')
  const races = await Promise.allSettled([
    auth.register({ username: 'racer', email: 'one@example.com', password: 'a sufficiently long password' }),
    auth.register({ username: 'RACER', email: 'two@example.com', password: 'a sufficiently long password' }),
  ])
  assert.equal(races.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(races.filter((result) => result.status === 'rejected' && result.reason.code === 'ACCOUNT_EXISTS').length, 1)
})

test('registration rolls back the user row when session creation fails', async () => {
  const pool = new FakePool()
  pool.failSessionInsert = true
  const auth = new AuthService(pool)
  await assert.rejects(auth.register({ username: 'mina', email: 'mina@example.com', password: 'a sufficiently long password' }), /synthetic session insert failure/)
  assert.equal(pool.users.length, 0)
  assert.equal(pool.sessions.length, 0)
})

test('login error is generic and sessions enforce expiry, CSRF rotation, and revocation', async () => {
  let now = new Date('2026-01-01T00:00:00Z')
  const pool = new FakePool()
  const auth = new AuthService(pool, { now: () => now })
  const registered = await auth.register({ username: 'mina', email: 'mina@example.com', password: 'a sufficiently long password' })
  await assert.rejects(auth.login('missing', 'wrong'), (error) => error.status === 401 && error.message === 'Invalid username/email or password.')
  const login = await auth.login(' MINA@EXAMPLE.COM ', 'a sufficiently long password')
  assert.equal((await auth.resolveSession(login.session.token)).user.id, registered.user.id)
  const csrf = await auth.rotateCsrfToken(pool.sessions.at(-1).id)
  const resolved = await auth.resolveSession(login.session.token)
  assert.equal(auth.validateCsrf(resolved, csrf), true)
  assert.equal(auth.validateCsrf(resolved, 'incorrect'), false)
  await auth.revokeSession(resolved)
  assert.equal(await auth.resolveSession(login.session.token), null)
  now = new Date('2026-02-01T00:00:00Z')
  assert.equal(await auth.resolveSession(registered.session.token), null)
})

test('account routes report unavailable when PostgreSQL is not configured', async () => {
  await assert.rejects(new AuthService(null).login('mina', 'password'), (error) => error.status === 503)
  await assert.rejects(
    new AuthService(null, { unavailableMessage: 'PostgreSQL configuration is invalid.' }).login('mina', 'password'),
    (error) => error.status === 503 && error.message === 'PostgreSQL configuration is invalid.',
  )
})

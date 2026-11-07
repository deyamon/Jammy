import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import cors from 'cors'
import test from 'node:test'
import { createAuthRouter, createRateLimiter } from './auth.js'
import { AuthService } from '../services/authService.js'

class TestPool {
  users = []
  sessions = []
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
      if (this.users.some((user) => user.username === username || user.email === email)) { const error = new Error(); error.code = '23505'; throw error }
      const row = { id: 'user-1', username, email, password_hash, created_at: new Date() }
      this.users.push(row); return { rows: [row], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO auth_sessions')) {
      const [id, token_hash, csrf_token_hash, user_id, created_at, expires_at] = values
      this.sessions.push({ id, token_hash, csrf_token_hash, user_id, created_at, expires_at, revoked_at: null }); return { rows: [], rowCount: 1 }
    }
    if (sql.includes('FROM auth_users')) {
      const row = this.users.find((user) => user.username === values[0] || user.email === values[0]); return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('FROM auth_sessions')) {
      const session = this.sessions.find((item) => item.token_hash === values[0] && !item.revoked_at && item.expires_at > values[1])
      const user = this.users.find((item) => item.id === session?.user_id)
      return { rows: session && user ? [{ ...session, session_id: session.id, ...user }] : [], rowCount: session && user ? 1 : 0 }
    }
    if (sql.includes('UPDATE auth_sessions SET csrf_token_hash')) {
      const session = this.sessions.find((item) => item.id === values[0]); session.csrf_token_hash = values[1]; return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE auth_sessions SET revoked_at')) {
      const session = this.sessions.find((item) => item.id === values[0]); session.revoked_at = values[1]; return { rows: [], rowCount: 1 }
    }
    throw new Error('Unexpected query')
  }
}

async function setup({ loginLimit = 10 } = {}) {
  const pool = new TestPool()
  const authService = new AuthService(pool)
  const app = express()
  const allowedOrigins = ['https://jammy.test']
  app.use(cors({ origin: allowedOrigins, credentials: true }))
  app.use(express.json())
  app.use('/api/auth', createAuthRouter({
    authService, allowedOrigins, secureCookies: false,
    loginRateLimiter: createRateLimiter({ limit: loginLimit, windowMs: 60_000 }),
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/auth`
  return { pool, server, base, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('registration sets HttpOnly session cookie; session and CSRF logout revoke it', async (t) => {
  const app = await setup(); t.after(app.close)
  const origin = 'https://jammy.test'
  const registered = await fetch(`${app.base}/register`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Mina', email: 'MINA@example.com', password: 'a sufficiently long password' }),
  })
  assert.equal(registered.status, 201)
  const payload = await registered.json()
  assert.equal(payload.user.username, 'mina')
  assert.equal(payload.session, undefined)
  assert.equal(registered.headers.get('access-control-allow-credentials'), 'true')
  assert.equal(registered.headers.get('access-control-allow-origin'), origin)
  const cookie = registered.headers.get('set-cookie')
  assert.match(cookie, /HttpOnly/i)
  assert.match(cookie, /SameSite=Lax/i)
  const sessionCookie = cookie.match(/jammy_session=([^;]+)/)[1]
  assert.equal(sessionCookie.length, 43)
  const session = await fetch(`${app.base}/session`, { headers: { cookie: `jammy_session=${sessionCookie}` } })
  assert.equal(session.status, 200)
  const inspected = await session.json()
  assert.equal(inspected.authenticated, true)
  assert.equal(app.pool.sessions[0].token_hash.includes(sessionCookie), false)

  const blockedLogout = await fetch(`${app.base}/logout`, { method: 'POST', headers: { origin, cookie: `jammy_session=${sessionCookie}` } })
  assert.equal(blockedLogout.status, 403)
  const logout = await fetch(`${app.base}/logout`, {
    method: 'POST', headers: { origin, cookie: `jammy_session=${sessionCookie}`, 'x-csrf-token': inspected.csrfToken },
  })
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/)
  const afterLogout = await fetch(`${app.base}/session`, { headers: { cookie: `jammy_session=${sessionCookie}` } })
  assert.equal(afterLogout.status, 401)
})

test('origin protection rejects disallowed and missing origins before account creation', async (t) => {
  const app = await setup(); t.after(app.close)
  for (const origin of ['https://evil.test', undefined]) {
    const response = await fetch(`${app.base}/register`, {
      method: 'POST', headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', email: 'a@example.com', password: 'a sufficiently long password' }),
    })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'ORIGIN_NOT_ALLOWED')
  }
  assert.equal(app.pool.users.length, 0)
})

test('login errors are generic and login attempts are rate limited', async (t) => {
  const app = await setup({ loginLimit: 2 }); t.after(app.close)
  const request = () => fetch(`${app.base}/login`, {
    method: 'POST', headers: { origin: 'https://jammy.test', 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'unknown', password: 'incorrect' }),
  })
  const first = await request(); const second = await request(); const third = await request()
  assert.equal(first.status, 401)
  assert.deepEqual(await first.json(), { error: 'Invalid username/email or password.', code: 'AUTH_INVALID_CREDENTIALS' })
  assert.equal(second.status, 401)
  assert.equal(third.status, 429)
})

test('CORS omits credential access for unlisted origins and auth failures hide database details', async (t) => {
  const app = await setup(); t.after(app.close)
  const blockedCors = await fetch(`${app.base}/session`, { headers: { origin: 'https://evil.test' } })
  assert.equal(blockedCors.headers.get('access-control-allow-origin'), null)
  app.pool.query = async () => { throw new Error('database password and SQL details') }
  const failure = await fetch(`${app.base}/login`, {
    method: 'POST', headers: { origin: 'https://jammy.test', 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'mina', password: 'valid length' }),
  })
  assert.equal(failure.status, 503)
  const payload = await failure.text()
  assert.match(payload, /temporarily unavailable/)
  assert.doesNotMatch(payload, /database password|SQL details/)
})

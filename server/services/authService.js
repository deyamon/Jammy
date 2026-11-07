import argon2 from 'argon2'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'jammy_session'
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }
const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export class AuthError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function validateRegistrationInput(body) {
  const username = normalizeUsername(body?.username)
  const email = normalizeEmail(body?.email)
  const password = body?.password
  if (!USERNAME_PATTERN.test(username)) {
    throw new AuthError(400, 'Username must be 3–24 characters using letters, numbers, or underscores.', 'USERNAME_INVALID')
  }
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new AuthError(400, 'Enter a valid email address.', 'EMAIL_INVALID')
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new AuthError(400, 'Password must be 12–128 characters.', 'PASSWORD_INVALID')
  }
  return { username, email, password }
}

export function hashOpaqueToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function safeUser(row) {
  return { id: row.id, username: row.username, email: row.email, createdAt: row.created_at }
}

export class AuthService {
  constructor(pool, { now = () => new Date(), hashPassword = (password) => argon2.hash(password, ARGON2_OPTIONS), verifyPassword = (hash, password) => argon2.verify(hash, password), unavailableMessage } = {}) {
    this.pool = pool
    this.unavailableMessage = unavailableMessage ?? 'Account authentication is unavailable until PostgreSQL is configured.'
    this.now = now
    this.hashPassword = hashPassword
    this.verifyPassword = verifyPassword
    this.sessionRevokers = new Set()
  }

  addSessionRevoker(callback) {
    this.sessionRevokers.add(callback)
    return () => this.sessionRevokers.delete(callback)
  }

  requireDatabase() {
    if (!this.pool) throw new AuthError(503, this.unavailableMessage, 'AUTH_UNAVAILABLE')
  }

  async createSession(userId, queryable = this.pool) {
    const token = randomBytes(32).toString('base64url')
    const csrfToken = randomBytes(32).toString('base64url')
    const sessionId = randomUUID()
    const expiresAt = new Date(this.now().getTime() + SESSION_LIFETIME_MS)
    await queryable.query(
      `INSERT INTO auth_sessions (id, token_hash, csrf_token_hash, user_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, hashOpaqueToken(token), hashOpaqueToken(csrfToken), userId, this.now(), expiresAt],
    )
    return { token, csrfToken, expiresAt }
  }

  async register(body) {
    this.requireDatabase()
    const { username, email, password } = validateRegistrationInput(body)
    const passwordHash = await this.hashPassword(password)
    const client = await this.pool.connect()
    let inTransaction = false
    try {
      await client.query('BEGIN')
      inTransaction = true
      const result = await client.query(
        `INSERT INTO auth_users (username, email, password_hash)
         VALUES ($1, $2, $3) RETURNING id, username, email, created_at`,
        [username, email, passwordHash],
      )
      const session = await this.createSession(result.rows[0].id, client)
      await client.query('COMMIT')
      inTransaction = false
      return { user: safeUser(result.rows[0]), session }
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => {})
      if (error.code === '23505') throw new AuthError(409, 'That username or email is already registered.', 'ACCOUNT_EXISTS')
      throw error
    } finally {
      client.release()
    }
  }

  async login(identifier, password) {
    this.requireDatabase()
    if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier.trim() || identifier.trim().length > 254 || password.length > 128) {
      throw new AuthError(401, 'Invalid username/email or password.', 'AUTH_INVALID_CREDENTIALS')
    }
    const normalized = identifier.trim().toLowerCase()
    let result
    try {
      result = await this.pool.query(
        `SELECT id, username, email, password_hash, created_at FROM auth_users
         WHERE username = $1 OR email = $1 LIMIT 1`, [normalized],
      )
    } catch (error) {
      throw error
    }
    const row = result.rows[0]
    const hash = row?.password_hash ?? '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    let verified = false
    try { verified = await this.verifyPassword(hash, password) } catch { verified = false }
    if (!row || !verified) throw new AuthError(401, 'Invalid username/email or password.', 'AUTH_INVALID_CREDENTIALS')
    return { user: safeUser(row), session: await this.createSession(row.id) }
  }

  async resolveSession(token) {
    this.requireDatabase()
    if (typeof token !== 'string' || !SESSION_TOKEN_PATTERN.test(token)) return null
    const result = await this.pool.query(
      `SELECT s.id AS session_id, s.token_hash, s.csrf_token_hash, s.expires_at,
              u.id, u.username, u.email, u.created_at
       FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 LIMIT 1`,
      [hashOpaqueToken(token), this.now()],
    )
    return result.rows[0] ? { sessionId: result.rows[0].session_id, tokenHash: result.rows[0].token_hash, csrfTokenHash: result.rows[0].csrf_token_hash, expiresAt: result.rows[0].expires_at, user: safeUser(result.rows[0]) } : null
  }

  async rotateCsrfToken(sessionId) {
    this.requireDatabase()
    const token = randomBytes(32).toString('base64url')
    await this.pool.query('UPDATE auth_sessions SET csrf_token_hash = $2 WHERE id = $1 AND revoked_at IS NULL AND expires_at > $3', [sessionId, hashOpaqueToken(token), this.now()])
    return token
  }

  async validateSessionHash(tokenHash) {
    this.requireDatabase()
    const result = await this.pool.query(
      `SELECT s.id AS session_id, s.token_hash, s.expires_at,
              u.id, u.username, u.email, u.created_at
       FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 LIMIT 1`,
      [tokenHash, this.now()],
    )
    const row = result.rows[0]
    return row ? { sessionId: row.session_id, tokenHash: row.token_hash, expiresAt: row.expires_at, user: safeUser(row) } : null
  }

  validateCsrf(session, token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false
    const expected = Buffer.from(session.csrfTokenHash, 'hex')
    const actual = Buffer.from(hashOpaqueToken(token), 'hex')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  async revokeSession(session) {
    this.requireDatabase()
    await this.pool.query('UPDATE auth_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [session.sessionId, this.now()])
    for (const revoke of this.sessionRevokers) revoke(session.tokenHash)
  }
}

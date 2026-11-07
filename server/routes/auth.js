import { Router } from 'express'
import { AuthError, SESSION_COOKIE } from '../services/authService.js'

export function readCookie(request, name) {
  const cookieHeader = request?.get?.('cookie') ?? request?.headers?.cookie ?? ''
  for (const item of cookieHeader.split(';')) {
    const [key, ...value] = item.trim().split('=')
    if (key === name) {
      try { return decodeURIComponent(value.join('=')) } catch { return null }
    }
  }
  return null
}

export function createRateLimiter({ limit, windowMs, now = Date.now } = {}) {
  const attempts = new Map()
  return (request, response, next) => {
    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown'
    const time = now()
    const bucket = (attempts.get(key) ?? []).filter((timestamp) => timestamp > time - windowMs)
    if (attempts.size > 1000) {
      for (const [candidate, timestamps] of attempts) {
        if (!timestamps.some((timestamp) => timestamp > time - windowMs)) attempts.delete(candidate)
      }
    }
    if (bucket.length >= limit) return response.status(429).json({ error: 'Too many attempts. Please try again later.', code: 'RATE_LIMITED' })
    bucket.push(time)
    attempts.set(key, bucket)
    next()
  }
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next)
}

function safeFailure(error, _request, response, _next) {
  if (error instanceof AuthError) return response.status(error.status).json({ error: error.message, code: error.code })
  return response.status(503).json({ error: 'Account authentication is temporarily unavailable.', code: 'AUTH_UNAVAILABLE' })
}

export function createAuthMiddleware({ authService, allowedOrigins }) {
  const originSet = new Set(allowedOrigins)
  const validateOrigin = (request, response, next) => {
    const origin = request.get('origin')
    let valid = false
    try {
      const parsed = new URL(origin)
      valid = parsed.origin === origin && originSet.has(origin)
    } catch {}
    if (!valid) return response.status(403).json({ error: 'Request origin is not allowed.', code: 'ORIGIN_NOT_ALLOWED' })
    next()
  }
  const resolveSession = asyncRoute(async (request, _response, next) => {
    request.authSession = await authService.resolveSession(readCookie(request, SESSION_COOKIE))
    next()
  })
  const requireAuthentication = (request, response, next) => {
    if (!request.authSession) return response.status(401).json({ error: 'Authentication is required.', code: 'AUTH_REQUIRED' })
    next()
  }
  const validateCsrf = (request, response, next) => {
    if (!request.authSession || !authService.validateCsrf(request.authSession, request.get('x-csrf-token'))) {
      return response.status(403).json({ error: 'A valid CSRF token is required.', code: 'CSRF_INVALID' })
    }
    next()
  }
  return { validateOrigin, resolveSession, requireAuthentication, validateCsrf }
}

function writeSessionCookie(response, session, secure) {
  response.cookie(SESSION_COOKIE, session.token, {
    httpOnly: true, sameSite: 'lax', secure, path: '/', expires: session.expiresAt,
  })
}

function clearSessionCookie(response, secure) {
  response.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: '/' })
}

export function createAuthRouter({ authService, allowedOrigins, secureCookies = process.env.NODE_ENV === 'production', loginRateLimiter, registrationRateLimiter } = {}) {
  const router = Router()
  const { validateOrigin, resolveSession, validateCsrf } = createAuthMiddleware({ authService, allowedOrigins })
  const validateCsrfWhenAuthenticated = (request, response, next) => request.authSession ? validateCsrf(request, response, next) : next()

  router.post('/register', validateOrigin, registrationRateLimiter ?? createRateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 }), asyncRoute(async (request, response) => {
    const result = await authService.register(request.body)
    writeSessionCookie(response, result.session, secureCookies)
    response.status(201).json({ user: result.user, csrfToken: result.session.csrfToken })
  }))

  router.post('/login', validateOrigin, loginRateLimiter ?? createRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 }), asyncRoute(async (request, response) => {
    const result = await authService.login(request.body?.identifier, request.body?.password)
    writeSessionCookie(response, result.session, secureCookies)
    response.json({ user: result.user, csrfToken: result.session.csrfToken })
  }))

  router.get('/session', resolveSession, asyncRoute(async (request, response) => {
    if (!request.authSession) return response.status(401).json({ authenticated: false })
    const csrfToken = await authService.rotateCsrfToken(request.authSession.sessionId)
    response.json({ authenticated: true, user: request.authSession.user, csrfToken })
  }))

  router.post('/logout', validateOrigin, resolveSession, validateCsrfWhenAuthenticated, asyncRoute(async (request, response) => {
    clearSessionCookie(response, secureCookies)
    if (request.authSession) await authService.revokeSession(request.authSession)
    response.json({ ok: true })
  }))

  router.use(safeFailure)
  return router
}

export class AuthApiError extends Error {
  constructor(message, { status = 0, code = 'REQUEST_FAILED' } = {}) {
    super(message)
    this.name = 'AuthApiError'
    this.status = status
    this.code = code
  }
}

function userPayload(user) {
  if (!user || typeof user.id !== 'string') {
    throw new AuthApiError('Neon Auth returned an incomplete account response.')
  }
  const username = typeof user.name === 'string' ? user.name : ''
  if (!username) throw new AuthApiError('Your account is missing a display name.')
  return {
    user: {
      id: user.id,
      username,
      ...(typeof user.email === 'string' ? { email: user.email } : {}),
      ...(typeof user.emailVerified === 'boolean' ? { emailVerified: user.emailVerified } : {}),
      ...(user.createdAt ? { createdAt: new Date(user.createdAt).toISOString() } : {}),
    },
  }
}

function throwAuthError(error) {
  const status = Number.isInteger(error?.status) ? error.status : 0
  const code = typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED'
  const message = typeof error?.message === 'string' && error.message.trim()
    ? sanitizeAuthMessage(error.message)
    : 'The account request could not be completed. Please try again.'
  throw new AuthApiError(message, { status, code })
}

function sanitizeAuthMessage(message) {
  return String(message)
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[Neon Auth endpoint]')
    .replace(/\b(access|refresh|id)?_?token\s*[:=]\s*[^\s,;]+/gi, '$1token=[redacted]')
    .slice(0, 240)
}

function isCompactJwt(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
}

function authTransportError(error, action) {
  if (error instanceof AuthApiError) return error
  const status = Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.statusCode) ? error.statusCode : 0
  const sdkCode = typeof error?.code === 'string' ? error.code : ''
  const transportCode = typeof error?.cause?.code === 'string' ? error.cause.code : sdkCode
  if (status) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code) ? error.code : `NEON_AUTH_HTTP_${status}`
    return new AuthApiError(`Neon Auth returned HTTP ${status} during ${action}${code.startsWith('NEON_AUTH_') ? ` (${code})` : ''}. Check the Auth branch and account response.`, { status, code })
  }
  const detail = transportCode && /^[A-Z0-9_]{2,48}$/.test(transportCode) ? ` (${transportCode})` : ''
  const stage = error?.name === 'TypeError' ? ' before receiving an HTTP response' : ' during client initialization'
  return new AuthApiError(`Neon Auth ${action} failed${stage}${detail}. Check the configured Auth URL, browser network, and origin access.`, { status: 503, code: transportCode || 'NEON_AUTH_TRANSPORT_FAILED' })
}

function resolveAuthUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return { url: '', error: null }
  try {
    const parsed = new URL(value.trim())
    if ((parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('invalid-url')
    }
    if (parsed.hostname.toLowerCase().includes('neonauth.') && !/\/[^/]+\/auth\/?$/.test(parsed.pathname)) {
      throw new Error('missing-neon-auth-service-path')
    }
    return { url: parsed.href.replace(/\/+$/, ''), error: null }
  } catch {
    return { url: '', error: new AuthApiError('Neon Auth URL configuration is invalid. Use the full Auth base URL from the intended Neon branch, including its database/auth path (usually /neondb/auth), then restart Vite.', { status: 503, code: 'NEON_AUTH_URL_INVALID' }) }
  }
}

export function createAccountApi(authClient) {
  let pendingSessionRequest = null
  const authInstance = async () => {
    if (!authClient) throw new AuthApiError('Neon Auth is not configured for this app.', { status: 503, code: 'AUTH_UNAVAILABLE' })
    return typeof authClient === 'function' ? authClient() : authClient
  }
  // createAuthClient() already returns the public Neon Auth API. Its `.adapter`
  // property is internal and routes through `/adapter/*`; calling that object
  // bypasses the SDK's public endpoint paths and produces 404s on Managed Auth.
  const client = async () => {
    const auth = await authInstance()
    return auth?.adapter ?? auth
  }

  async function unwrap(operation, action) {
    let result
    try {
      result = await operation()
    } catch (error) {
      throw authTransportError(error, action)
    }
    if (result?.error) throwAuthError(result.error)
    return result?.data
  }

  return {
    getAuthSession() {
      if (!pendingSessionRequest) {
        pendingSessionRequest = (async () => {
          const data = await unwrap(async () => (await client()).getSession(), 'session restoration')
          return data?.user ? { authenticated: true, ...userPayload(data.user) } : { authenticated: false }
        })().finally(() => { pendingSessionRequest = null })
      }
      return pendingSessionRequest
    },
    async registerAccount({ username, email, password }) {
      const data = await unwrap(async () => (await client()).signUp.email({ name: username, email, password }), 'registration')
      return userPayload(data?.user)
    },
    async loginAccount({ identifier, password }) {
      const data = await unwrap(async () => (await client()).signIn.email({ email: identifier, password }), 'login')
      return userPayload(data?.user)
    },
    async logoutAccount() {
      await unwrap(async () => (await client()).signOut(), 'sign out')
    },
    async requestPasswordReset({ email, redirectTo }) {
      await unwrap(async () => (await client()).requestPasswordReset({ email, redirectTo }), 'password reset request')
    },
    async resetPassword({ token, newPassword }) {
      await unwrap(async () => (await client()).resetPassword({ token, newPassword }), 'password reset')
    },
    async changePassword({ currentPassword, newPassword }) {
      await unwrap(async () => (await client()).changePassword({ currentPassword, newPassword, revokeOtherSessions: true }), 'password change')
    },
    async resendVerificationEmail({ email, callbackURL }) {
      await unwrap(async () => (await client()).sendVerificationEmail({ email, callbackURL }), 'verification email')
    },
    async getBearerToken() {
      let neonAuth
      try { neonAuth = await authInstance() }
      catch (error) { throw authTransportError(error, 'client initialization') }
      const instance = neonAuth?.adapter ?? neonAuth
      if (typeof neonAuth?.getJWTToken !== 'function') {
        throw new AuthApiError('The configured Neon Auth client cannot retrieve access tokens. Update the Neon Auth SDK configuration.', { status: 503, code: 'AUTH_SDK_CONFIGURATION' })
      }
      // @neon/auth 0.8.2 has two similarly named APIs: createAuthClient().token()
      // is Better Auth's `/token` endpoint, while createInternalNeonAuth()
      // exposes the Neon adapter's getJWTToken() wrapper. Use the latter; it
      // reads the JWT injected into the server session by `set-auth-jwt`.
      let tokenFailure = null
      try {
        const token = await neonAuth.getJWTToken()
        if (isCompactJwt(token)) return token
      } catch (error) {
        tokenFailure = authTransportError(error, 'access-token retrieval')
      }

      // Reconcile a missing token with the session before calling it expired.
      // Verify the session separately when the SDK has no JWT. Never send an
      // opaque Better Auth session id as a bearer token.
      if (typeof instance.getSession !== 'function') {
        if (tokenFailure) throw tokenFailure
        throw new AuthApiError('Neon Auth returned no usable JWT and this client cannot verify the session.', { status: 503, code: 'AUTH_TOKEN_UNAVAILABLE' })
      }
      const session = await unwrap(() => instance.getSession(), 'session verification')
      if (!session?.user) {
        throw new AuthApiError('Your Neon Auth session has expired. Sign in again to continue.', { status: 401, code: 'AUTH_SESSION_EXPIRED' })
      }
      const expiresAt = Date.parse(session?.session?.expiresAt)
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        throw new AuthApiError('Your Neon Auth session has expired. Sign in again to continue.', { status: 401, code: 'AUTH_SESSION_EXPIRED' })
      }
      if (tokenFailure) throw tokenFailure
      throw new AuthApiError('Neon Auth confirmed your account but did not provide a usable JWT. Refresh your session and try again.', { status: 503, code: 'AUTH_TOKEN_UNAVAILABLE' })
    },
  }
}

const { url: authUrl, error: authUrlError } = resolveAuthUrl(import.meta.env?.VITE_NEON_AUTH_URL || '')

let neonAuthClientPromise = null
const loadNeonAuthClient = authUrl || authUrlError ? async () => {
  if (authUrlError) throw authUrlError
  if (!neonAuthClientPromise) {
    neonAuthClientPromise = import('@neon/auth').then(({ createInternalNeonAuth }) => {
      const neonAuth = createInternalNeonAuth(authUrl)
      const client = neonAuth?.adapter
      if (typeof client?.getSession !== 'function' || typeof neonAuth?.getJWTToken !== 'function' || typeof client?.signIn?.email !== 'function' || typeof client?.signUp?.email !== 'function') {
        throw new AuthApiError('The installed Neon Auth SDK did not initialize the expected session, JWT, and credential methods.', { status: 503, code: 'NEON_AUTH_SDK_INITIALIZATION_FAILED' })
      }
      return neonAuth
    }).catch((error) => {
      neonAuthClientPromise = null
      throw authTransportError(error, 'client initialization')
    })
  }
  return neonAuthClientPromise
} : null
const accountApi = createAccountApi(loadNeonAuthClient)

export const { getAuthSession, loginAccount, logoutAccount, registerAccount, requestPasswordReset, resetPassword, changePassword, resendVerificationEmail } = accountApi

export async function getNeonAuthBearerToken() {
  if (!loadNeonAuthClient) throw new AuthApiError('Neon Auth is not configured for this app.', { status: 503, code: 'AUTH_UNAVAILABLE' })
  return accountApi.getBearerToken()
}

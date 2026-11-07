import assert from 'node:assert/strict'
import test from 'node:test'
import { createInternalNeonAuth } from '@neon/auth'
import { createAccountApi } from './authApi.js'

const validJwt = 'eyJhbGciOiJFZERTQSJ9.eyJleHAiOjQ3MDAwMDAwMDB9.signature'

test('session and sign-in use the public Neon Auth client instead of its internal adapter', async () => {
  let publicSessionCalls = 0
  let publicLoginCalls = 0
  let internalAdapterCalls = 0
  const authClient = {
    adapter: {
      getSession: async () => {
        publicSessionCalls += 1
        return { data: null }
      },
      signIn: { email: async () => {
        publicLoginCalls += 1
        return { data: { user: { id: 'neon-user-1', name: 'jammy-listener' } } }
      } },
    },
    getJWTToken: async () => null,
    getSession: async () => { internalAdapterCalls += 1; return { error: { status: 404 } } },
    signIn: { email: async () => { internalAdapterCalls += 1; return { error: { status: 404 } } } },
  }
  const accountApi = createAccountApi(authClient)

  assert.deepEqual(await accountApi.getAuthSession(), { authenticated: false })
  assert.deepEqual(await accountApi.loginAccount({ identifier: 'listener@example.test', password: 'unused-test-value' }), {
    user: { id: 'neon-user-1', username: 'jammy-listener' },
  })
  assert.equal(publicSessionCalls, 1)
  assert.equal(publicLoginCalls, 1)
  assert.equal(internalAdapterCalls, 0)
})

test('JWT retrieval uses Neon Auth getJWTToken() and distinguishes expired from authenticated sessions without a JWT', async () => {
  let jwtCalls = 0
  let pluginTokenCalls = 0
  const accountApi = createAccountApi({
    getJWTToken: async () => { jwtCalls += 1; return validJwt },
    token: async () => { pluginTokenCalls += 1; throw new Error('The Better Auth plugin token method must not be used') },
  })
  assert.equal(await accountApi.getBearerToken(), validJwt)
  assert.equal(jwtCalls, 1)
  assert.equal(pluginTokenCalls, 0)

  const expired = createAccountApi({ getJWTToken: async () => null, getSession: async () => ({ data: null }) })
  await assert.rejects(expired.getBearerToken(), (error) => error.status === 401 && error.code === 'AUTH_SESSION_EXPIRED')
  const validButNoToken = createAccountApi({ getJWTToken: async () => null, getSession: async () => ({ data: { user: { id: 'u1', name: 'maya' }, session: {} } }) })
  await assert.rejects(validButNoToken.getBearerToken(), (error) => error.status === 503 && error.code === 'AUTH_TOKEN_UNAVAILABLE')
  const opaqueSession = createAccountApi({ getJWTToken: async () => 'opaque-session-cookie-id', getSession: async () => ({ data: { user: { id: 'u1', name: 'maya' }, session: { token: 'opaque-session-cookie-id' } } }) })
  await assert.rejects(opaqueSession.getBearerToken(), (error) => error.status === 503 && error.code === 'AUTH_TOKEN_UNAVAILABLE')

  const failedRefresh = createAccountApi({
    getJWTToken: async () => { throw Object.assign(new Error('temporarily unavailable'), { status: 503, code: 'NEON_AUTH_HTTP_503' }) },
    getSession: async () => ({ data: { user: { id: 'u1', name: 'maya' }, session: { expiresAt: '2099-01-01T00:00:00.000Z' } } }),
  })
  await assert.rejects(failedRefresh.getBearerToken(), (error) => error.status === 503 && error.code === 'NEON_AUTH_HTTP_503')
})

test('installed @neon/auth 0.8.2 uses the Neon wrapper and reads its JWT from session response metadata', async () => {
  const neonAuth = createInternalNeonAuth('https://auth.example.test/neondb/auth')
  const accountApi = createAccountApi(() => neonAuth)
  const originalFetch = globalThis.fetch
  const requestPaths = []
  const requestCredentials = []
  globalThis.fetch = async (url, init) => {
    requestPaths.push(new URL(url).pathname)
    requestCredentials.push(init?.credentials)
    return Response.json({
      session: { token: 'opaque-session-id', expiresAt: '2099-01-01T00:00:00.000Z' },
      user: { id: 'neon-user-1', name: 'maya' },
    }, { headers: { 'set-auth-jwt': validJwt } })
  }
  try {
    assert.equal(await accountApi.getBearerToken(), validJwt)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(requestPaths, ['/neondb/auth/get-session'])
  assert.deepEqual(requestCredentials, ['include'])
  assert.equal(requestPaths.some((path) => path.endsWith('/token') || path.endsWith('/get-jwt-token') || path.includes('/adapter/')), false)
})

test('Better Auth token() may resolve to a cached session payload without any JWT field', async () => {
  const { createAuthClient } = await import('@neon/auth')
  const client = createAuthClient('https://auth.example.test/neondb/auth')
  let requestCount = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    requestCount += 1
    return Response.json({ session: { token: 'opaque-session-id' }, user: { id: 'u1', name: 'maya' } })
  }
  try {
    const result = await client.token()
    assert.equal(Boolean(result.data?.user), true)
    assert.equal(result.data?.token, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(requestCount, 0, 'the Neon adapter serves the active session from its cache for /token')
})

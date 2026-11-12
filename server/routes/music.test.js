import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import express from 'express'
import test from 'node:test'
import { classifyNeonTokenFailure, createMusicRouter, createNeonUserAuthenticator, NeonAuthConfigurationError, validateNeonAuthVerifierConfig, verifyNeonBearerToken } from './music.js'

test('Neon Auth verifier accepts only credential-free HTTPS JWKS configuration', () => {
  assert.equal(validateNeonAuthVerifierConfig({ jwksUrl: 'https://auth.example.test/neondb/auth/.well-known/jwks.json', authBaseUrl: 'https://auth.example.test/neondb/auth' }).issuer, 'https://auth.example.test')
  assert.equal(validateNeonAuthVerifierConfig({ jwksUrl: 'https://auth.example.test/.well-known/jwks.json', issuer: 'https://auth.example.test', audience: 'jammy-api' }).audience, 'jammy-api')
  assert.throws(() => validateNeonAuthVerifierConfig({ jwksUrl: 'https://auth.example.test/.well-known/jwks.json' }), NeonAuthConfigurationError)
  assert.throws(() => validateNeonAuthVerifierConfig({ jwksUrl: 'http://auth.example.test/jwks' }), NeonAuthConfigurationError)
  assert.throws(() => validateNeonAuthVerifierConfig({ jwksUrl: 'https://user:pass@auth.example.test/jwks' }), NeonAuthConfigurationError)
  assert.throws(() => validateNeonAuthVerifierConfig({ jwksUrl: 'https://auth.example.test/jwks', issuer: 'https://auth.example.test', audience: '  ' }), NeonAuthConfigurationError)
})

test('Neon Auth JWT verifier enforces JWKS signature, EdDSA, expiry, issuer, and configured audience', async (t) => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA')
  const jwk = await exportJWK(publicKey)
  Object.assign(jwk, { kid: 'test-neon-key', alg: 'EdDSA', use: 'sig' })
  const issuer = 'https://auth.example.test'
  const audience = 'jammy-api'
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' })
    response.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const jwksUrl = `http://127.0.0.1:${server.address().port}/.well-known/jwks.json`
  const makeToken = ({ tokenIssuer = issuer, tokenAudience = audience, expires = '2m', subject = 'neon-user-1', signingKey = privateKey } = {}) => {
    const jwt = new SignJWT({}).setProtectedHeader({ alg: 'EdDSA', kid: 'test-neon-key' }).setSubject(subject).setIssuer(tokenIssuer).setExpirationTime(expires)
    if (tokenAudience) jwt.setAudience(tokenAudience)
    return jwt.sign(signingKey)
  }

  assert.equal(await verifyNeonBearerToken(await makeToken(), { jwksUrl, issuer, audience }), 'neon-user-1')
  await assert.rejects(verifyNeonBearerToken('not-a-jwt', { jwksUrl, issuer, audience }))
  await assert.rejects(verifyNeonBearerToken(await makeToken({ expires: '-1s' }), { jwksUrl, issuer, audience }))
  await assert.rejects(verifyNeonBearerToken(await makeToken({ tokenIssuer: 'https://other-auth.example.test' }), { jwksUrl, issuer, audience }))
  await assert.rejects(verifyNeonBearerToken(await makeToken({ tokenAudience: 'other-api' }), { jwksUrl, issuer, audience }))
  const { privateKey: wrongPrivateKey } = await generateKeyPair('EdDSA')
  await assert.rejects(verifyNeonBearerToken(await makeToken({ signingKey: wrongPrivateKey }), { jwksUrl, issuer, audience }))
  assert.equal(await verifyNeonBearerToken(await makeToken({ tokenAudience: null }), { jwksUrl, issuer }), 'neon-user-1')
  const wrongAlgorithmToken = await new SignJWT({}).setProtectedHeader({ alg: 'HS256', kid: 'test-neon-key' }).setSubject('neon-user-1').setIssuer(issuer).setAudience(audience).setExpirationTime('2m').sign(new TextEncoder().encode('fixture-secret-that-is-not-used'))
  await assert.rejects(verifyNeonBearerToken(wrongAlgorithmToken, { jwksUrl, issuer, audience }))
})

test('Neon Auth issuer defaults to the Auth URL origin, not its /neondb/auth path', () => {
  assert.equal(validateNeonAuthVerifierConfig({
    jwksUrl: 'https://auth.example.test/neondb/auth/.well-known/jwks.json',
    authBaseUrl: 'https://auth.example.test/neondb/auth',
  }).issuer, 'https://auth.example.test')
})

test('Neon JWT failures distinguish expired sessions from verifier configuration mismatches without exposing claims', () => {
  assert.deepEqual(classifyNeonTokenFailure({ code: 'ERR_JWT_EXPIRED' }), { status: 401, code: 'AUTH_SESSION_EXPIRED' })
  assert.deepEqual(classifyNeonTokenFailure({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 'iss' }), { status: 503, code: 'AUTH_TOKEN_ISSUER_MISMATCH' })
  assert.deepEqual(classifyNeonTokenFailure({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 'aud' }), { status: 503, code: 'AUTH_TOKEN_AUDIENCE_MISMATCH' })
  assert.deepEqual(classifyNeonTokenFailure({ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' }), { status: 503, code: 'AUTH_TOKEN_SIGNING_KEY_MISMATCH' })
  assert.deepEqual(classifyNeonTokenFailure(new Error('unknown')), { status: 401, code: 'AUTH_SESSION_INVALID' })
})

test('personal music writes use the server-authenticated Neon subject, not a client user ID', async (t) => {
  const queries = []
  const pool = { async query(sql, values) { queries.push({ sql, values }); return { rows: [], rowCount: 1 } } }
  const app = express()
  app.use(express.json())
  app.use('/api/music', createMusicRouter({
    pool,
    youtubeService: { async search() { return [] } },
    authenticator(request, _response, next) { request.musicUserId = 'verified-neon-subject'; next() },
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/music/history`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'attacker-selected-id', eventId: 'play-event-001', videoId: 'abcdefghijk', title: 'Fixture track', source: 'standalone' }),
  })
  assert.equal(response.status, 202)
  assert.equal(queries[0].values[0], 'verified-neon-subject')
  assert.equal(queries[0].values.includes('attacker-selected-id'), false)
})

test('custom legacy account identity cannot authenticate Neon music routes without a Bearer JWT', async (t) => {
  const app = express()
  app.use('/api/music', createMusicRouter({ pool: { async query() { throw new Error('must not query') } }, youtubeService: { async search() { return [] } }, authenticator: createNeonUserAuthenticator({ jwksUrl: 'https://auth.example.test/.well-known/jwks.json' }) }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/music/home`, { headers: { cookie: 'jammy_session=legacy-session-cookie' } })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).code, 'AUTH_REQUIRED')
})

test('Home history endpoint reports pending schema instead of a generic server failure', async (t) => {
  const app = express()
  app.use('/api/music', createMusicRouter({
    pool: { async query() { throw Object.assign(new Error('relation missing'), { code: '42P01' }) } },
    youtubeService: { async search() { return [] } },
    authenticator(request, _response, next) { request.musicUserId = 'verified-neon-subject'; next() },
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/music/home`)
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, 'MUSIC_MIGRATION_REQUIRED')
})

test('personal music search preserves the exact user query when taste preferences exist', async (t) => {
  let searchedQuery = ''
  const app = express()
  app.use('/api/music', createMusicRouter({
    pool: { async query() { return { rows: [{ profile_json: { favoriteArtists: [{ name: 'Taylor Swift' }] } }] } } },
    youtubeService: { async search(query) { searchedQuery = query; return [] } },
    authenticator(request, _response, next) { request.musicUserId = 'verified-neon-subject'; next() },
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/music/youtube-search?q=Harry%20Styles%20As%20It%20Was`)
  assert.equal(response.status, 200)
  assert.equal(searchedQuery, 'Harry Styles As It Was')
  assert.equal((await response.json()).personalized, true)
})

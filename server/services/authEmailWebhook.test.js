import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createAuthEmailWebhook } from './authEmailWebhook.js'

function makeSignedEvent(event, { now = Date.now(), privateKey, kid = 'jammy-test-key' } = {}) {
  const rawBody = Buffer.from(JSON.stringify(event))
  const timestamp = String(now)
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid })).toString('base64url')
  const payload = rawBody.toString('base64url')
  const detachedPayload = Buffer.from(`${timestamp}.${payload}`).toString('base64url')
  const signingInput = `${header}.${detachedPayload}`
  const signature = sign(null, Buffer.from(signingInput), privateKey).toString('base64url')
  return {
    rawBody,
    headers: new Headers({ 'x-neon-signature': `${header}..${signature}`, 'x-neon-signature-kid': kid, 'x-neon-timestamp': timestamp }),
  }
}

function setup({ now = Date.now(), resendStatus = 200 } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  let emailCount = 0
  let lastEmail
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/.well-known/jwks.json')) return { ok: true, json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'jammy-test-key' }] }) }
    emailCount += 1
    lastEmail = JSON.parse(options.body)
    return { ok: resendStatus >= 200 && resendStatus < 300, json: async () => ({}) }
  }
  const webhook = createAuthEmailWebhook({
    env: { NEON_AUTH_BASE_URL: 'https://auth.example.test/neondb/auth', RESEND_API_KEY: 'test-key', EMAIL_FROM: 'Jammy <auth@mail.jammy.test>' },
    fetchImpl,
    now: () => now,
  })
  return { webhook, privateKey, getEmailCount: () => emailCount, getLastEmail: () => lastEmail, now }
}

function otpEvent(eventId = 'event-otp-1') {
  return { event_id: eventId, event_type: 'send.otp', user: { email: 'listener@example.test', name: '<Ari>' }, event_data: { otp_type: 'email-verification', otp_code: '123456' } }
}

test('verifies Neon webhook signature and sends a branded verification code through Resend', async () => {
  const state = setup()
  const signed = makeSignedEvent(otpEvent(), state)
  const result = await state.webhook.handle(signed.rawBody, signed.headers)
  assert.deepEqual(result, { duplicate: false })
  assert.equal(state.getEmailCount(), 1)
  const email = state.getLastEmail()
  assert.equal(email.from, 'Jammy <auth@mail.jammy.test>')
  assert.deepEqual(email.to, ['listener@example.test'])
  assert.match(email.subject, /verify/i)
  assert.match(email.html, /&lt;Ari&gt;/)
  assert.match(email.html, /123456/)
  assert.doesNotMatch(JSON.stringify(email), /event-otp-1/)
})

test('does not redeliver a webhook event ID within the retry window', async () => {
  const state = setup()
  const signed = makeSignedEvent(otpEvent(), state)
  await state.webhook.handle(signed.rawBody, signed.headers)
  assert.deepEqual(await state.webhook.handle(signed.rawBody, signed.headers), { duplicate: true })
  assert.equal(state.getEmailCount(), 1)
})

test('rejects a stale webhook before calling Resend', async () => {
  const state = setup()
  const signed = makeSignedEvent(otpEvent(), { ...state, now: state.now - 6 * 60 * 1000 })
  await assert.rejects(state.webhook.handle(signed.rawBody, signed.headers), { status: 401 })
  assert.equal(state.getEmailCount(), 0)
})

test('rejects invalid signatures and non-Neon link hosts', async () => {
  const state = setup()
  const signed = makeSignedEvent(otpEvent(), state)
  const altered = Buffer.from(JSON.stringify(otpEvent('altered-event')))
  await assert.rejects(state.webhook.handle(altered, signed.headers), { status: 401 })

  const event = { event_id: 'event-link-1', event_type: 'send.magic_link', user: { email: 'listener@example.test' }, event_data: { link_type: 'forget-password', link_url: 'https://evil.example.test/reset?token=secret' } }
  const link = makeSignedEvent(event, state)
  await assert.rejects(state.webhook.handle(link.rawBody, link.headers), { status: 400 })
  assert.equal(state.getEmailCount(), 0)
})

test('reports delivery failure without logging or accepting the event', async () => {
  const state = setup({ resendStatus: 422 })
  const signed = makeSignedEvent(otpEvent('event-failed'), state)
  await assert.rejects(state.webhook.handle(signed.rawBody, signed.headers), /delivery failed/i)
  assert.equal(state.getEmailCount(), 1)
})

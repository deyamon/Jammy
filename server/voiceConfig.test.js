import assert from 'node:assert/strict'
import test from 'node:test'
import { getVoiceIceServers } from './voiceConfig.js'

test('voice networking defaults to a public STUN server without requiring credentials', () => {
  assert.deepEqual(getVoiceIceServers({}), [{ urls: ['stun:stun.l.google.com:19302'] }])
  assert.deepEqual(getVoiceIceServers({ VOICE_STUN_URLS: '' }), [])
})

test('voice networking accepts configured STUN and TURN values without exposing them in errors', () => {
  assert.deepEqual(getVoiceIceServers({
    VOICE_STUN_URLS: 'stun:stun.example.com:3478,stuns:stun.example.com:5349',
    VOICE_TURN_URLS: 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349',
    VOICE_TURN_USERNAME: 'temporary-user',
    VOICE_TURN_CREDENTIAL: 'temporary-secret',
  }), [
    { urls: ['stun:stun.example.com:3478', 'stuns:stun.example.com:5349'] },
    { urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349'], username: 'temporary-user', credential: 'temporary-secret' },
  ])
  assert.throws(() => getVoiceIceServers({ VOICE_STUN_URLS: 'https://not-stun.example.com' }), /VOICE_STUN_URLS contains an unsupported ICE URL/)
  assert.throws(() => getVoiceIceServers({ VOICE_TURN_URLS: 'turn:turn.example.com', VOICE_TURN_USERNAME: 'user' }), /VOICE_TURN_USERNAME and VOICE_TURN_CREDENTIAL/)
})

test('Cloudflare TURN credentials are fetched, filtered, cached, and fall back to STUN on failure', async () => {
  const { createVoiceIceServerProvider } = await import('./voiceConfig.js')
  let calls = 0
  let clock = 0
  const fetchImpl = async (url, options) => {
    calls += 1
    assert.match(url, /\/v1\/turn\/keys\/test-key-123\/credentials\/generate-ice-servers$/)
    assert.equal(options.headers.Authorization, 'Bearer secret-token')
    return { ok: true, json: async () => ({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:53?transport=udp', 'turn:turn.cloudflare.com:3478?transport=udp', 'https://bad.example'], username: 'u', credential: 'c' }] }) }
  }
  const provider = createVoiceIceServerProvider({ VOICE_CLOUDFLARE_TURN_KEY_ID: 'test-key-123', VOICE_CLOUDFLARE_TURN_API_TOKEN: 'secret-token' }, { fetchImpl, now: () => clock })
  const servers = await provider()
  assert.deepEqual(servers.at(-1), { urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' })
  await provider()
  assert.equal(calls, 1)
  clock += 13 * 60 * 60 * 1000
  await provider()
  assert.equal(calls, 2)

  const failing = createVoiceIceServerProvider({ VOICE_CLOUDFLARE_TURN_KEY_ID: 'test-key-123', VOICE_CLOUDFLARE_TURN_API_TOKEN: 'secret-token' }, { fetchImpl: async () => ({ ok: false, status: 500 }) })
  const originalError = console.error
  console.error = () => {}
  try { assert.deepEqual(await failing(), [{ urls: ['stun:stun.l.google.com:19302'] }]) } finally { console.error = originalError }
  assert.throws(() => createVoiceIceServerProvider({ VOICE_CLOUDFLARE_TURN_KEY_ID: 'test-key-123' }), /must be set together/)
})

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

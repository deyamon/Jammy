import assert from 'node:assert/strict'
import test from 'node:test'
import { connectAndRedirectToSpotify } from './spotifyConnect.js'

test('Connect Spotify posts for an authorization URL and redirects only to Spotify authorization', async () => {
  let called = 0
  let destination = ''
  await connectAndRedirectToSpotify({
    async startRequest() { called += 1; return { authorizationUrl: 'https://accounts.spotify.com/authorize?client_id=public-id&state=opaque' } },
    redirect(url) { destination = url },
  })
  assert.equal(called, 1)
  assert.equal(destination, 'https://accounts.spotify.com/authorize?client_id=public-id&state=opaque')
})

test('Connect Spotify surfaces backend errors and rejects non-Spotify redirect targets', async () => {
  const missingConfig = Object.assign(new Error('Not configured.'), { status: 503, code: 'SPOTIFY_NOT_CONFIGURED' })
  await assert.rejects(connectAndRedirectToSpotify({ startRequest: async () => { throw missingConfig }, redirect() {} }), (error) => error === missingConfig)
  await assert.rejects(connectAndRedirectToSpotify({ startRequest: async () => ({ authorizationUrl: 'https://attacker.example/authorize' }), redirect() { assert.fail('unsafe redirect') } }), /invalid Spotify authorization link/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanSpotifyQuery, SpotifyApiError, SpotifyService } from './spotifyService.js'

const response = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
})

test('Spotify query validation trims input and rejects empty or oversized searches', () => {
  assert.equal(cleanSpotifyQuery('  Men   I Trust '), 'Men I Trust')
  assert.throws(() => cleanSpotifyQuery('  '), { code: 'SPOTIFY_QUERY_INVALID' })
  assert.throws(() => cleanSpotifyQuery('a'.repeat(101)), { code: 'SPOTIFY_QUERY_INVALID' })
})

test('missing credentials produce an actionable setup error without making a request', async () => {
  let called = false
  const service = new SpotifyService({ clientId: '', clientSecret: '', fetchImpl: async () => { called = true } })
  await assert.rejects(service.search('artist'), (error) => error instanceof SpotifyApiError && error.code === 'SPOTIFY_NOT_CONFIGURED' && /SPOTIFY_CLIENT_ID/.test(error.message))
  assert.equal(called, false)
})

test('search uses the client credentials flow and normalizes track metadata', async () => {
  const calls = []
  const service = new SpotifyService({ clientId: 'test-id', clientSecret: 'test-secret', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('accounts.spotify.com')) return response({ access_token: 'test-token', expires_in: 3600 })
    return response({ tracks: { items: [{
      id: 'track-id', name: 'Song title', uri: 'spotify:track:track-id', duration_ms: 180000,
      artists: [{ name: 'An Artist' }], album: { name: 'An Album', images: [{ url: 'https://i.scdn.co/image/art' }] },
      external_urls: { spotify: 'https://open.spotify.com/track/track-id' },
    }] } })
  } })

  const [track] = await service.search('song')
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /^https:\/\/accounts\.spotify\.com\/api\/token$/)
  assert.match(calls[1].url, /type=track/)
  assert.match(calls[1].url, /limit=10/)
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-token')
  assert.deepEqual(track, {
    id: 'track-id', uri: 'spotify:track:track-id', title: 'Song title', artist: 'An Artist', album: 'An Album',
    durationMs: 180000, artwork: 'https://i.scdn.co/image/art', spotifyUrl: 'https://open.spotify.com/track/track-id', provider: 'spotify',
  })
})

test('Spotify search results are briefly cached and concurrent identical queries are coalesced', async () => {
  let calls = 0
  const service = new SpotifyService({ clientId: 'id', clientSecret: 'secret', fetchImpl: async (url) => {
    calls += 1
    return String(url).includes('accounts.spotify.com')
      ? response({ access_token: 'token', expires_in: 3600 })
      : response({ tracks: { items: [] } })
  } })
  const [first, second] = await Promise.all([service.search('song'), service.search('song')])
  await service.search('song')
  assert.deepEqual(first, second)
  assert.equal(calls, 2)
})

test('Spotify rate limits return a retry delay', async () => {
  const service = new SpotifyService({ clientId: 'id', clientSecret: 'secret', fetchImpl: async (url) =>
    String(url).includes('accounts.spotify.com') ? response({ access_token: 'token', expires_in: 3600 }) : response({}, 429, { 'retry-after': '17' }) })
  await assert.rejects(service.search('song'), (error) => error.status === 429 && error.retryAfter === 17 && error.code === 'SPOTIFY_RATE_LIMITED')
})

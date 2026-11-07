import assert from 'node:assert/strict'
import test from 'node:test'
import { createPersonalMusicApi, PersonalMusicApiError } from './musicApi.js'

test('personal music requests retrieve a Neon JWT and send it as a bearer Authorization header', async () => {
  const calls = []
  const api = createPersonalMusicApi({
    apiBase: 'https://jammy.example.test',
    async getBearerToken() { calls.push('token'); return 'signed-access-token' },
    async fetchImpl(url, options) {
      calls.push({ url, options })
      return { ok: true, async json() { return { history: [] } } }
    },
  })
  assert.deepEqual(await api.getHome(), { history: [] })
  assert.equal(calls[0], 'token')
  assert.equal(calls[1].url, 'https://jammy.example.test/api/music/home')
  assert.equal(calls[1].options.headers.Authorization, 'Bearer signed-access-token')
  assert.equal(calls[1].options.credentials, 'include')
  assert.equal(calls[1].options.cache, 'no-store')
})

test('YouTube search uses the authenticated personal-search endpoint', async () => {
  const calls = []
  const api = createPersonalMusicApi({
    apiBase: 'https://jammy.example.test',
    async getBearerToken() { return 'verified-neon-jwt' },
    async fetchImpl(url, options) {
      calls.push({ url, options })
      return { ok: true, async json() { return { results: [{ videoId: 'abcdefghijk' }] } } }
    },
  })
  const result = await api.request('/api/music/youtube-search?q=quiet%20storm')
  assert.deepEqual(result.results, [{ videoId: 'abcdefghijk' }])
  assert.equal(calls[0].url, 'https://jammy.example.test/api/music/youtube-search?q=quiet%20storm')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer verified-neon-jwt')
})

test('Home history and Spotify Connect share the same bearer-token helper', async () => {
  let tokenCalls = 0
  const requests = []
  const api = createPersonalMusicApi({
    apiBase: 'https://jammy.example.test',
    async getBearerToken() { tokenCalls += 1; return 'verified-neon-jwt' },
    async fetchImpl(url, options) {
      requests.push({ url, options })
      return { ok: true, async json() { return { ok: true } } }
    },
  })
  await api.getHome()
  await api.startSpotifyConnection()
  assert.equal(tokenCalls, 2)
  assert.deepEqual(requests.map(({ url }) => url), [
    'https://jammy.example.test/api/music/home',
    'https://jammy.example.test/api/spotify/connect/start',
  ])
  assert.ok(requests.every(({ options }) => options.headers.Authorization === 'Bearer verified-neon-jwt'))
})

test('personal music API errors preserve sanitized backend authentication and migration codes', async () => {
  const api = createPersonalMusicApi({
    getBearerToken: async () => 'test-token',
    fetchImpl: async () => ({ ok: false, status: 503, async json() { return { error: 'Apply the required migrations.', code: 'MUSIC_MIGRATION_REQUIRED' } } }),
  })
  await assert.rejects(api.getHome(), (error) => error instanceof PersonalMusicApiError && error.status === 503 && error.code === 'MUSIC_MIGRATION_REQUIRED' && error.message === 'Apply the required migrations.')
})

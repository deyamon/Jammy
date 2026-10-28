import test from 'node:test'
import assert from 'node:assert/strict'
import { searchSpotify, spotifyEmbedUrl } from './spotifyApi.js'

test('official Spotify embed URLs accept track IDs and reject unsafe input', () => {
  assert.equal(spotifyEmbedUrl('7abcXYZ012'), 'https://open.spotify.com/embed/track/7abcXYZ012')
  assert.equal(spotifyEmbedUrl('bad/id'), null)
  assert.equal(spotifyEmbedUrl(''), null)
})

test('Spotify frontend search normalizes empty payloads and surfaces API errors', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [] }) })
    assert.deepEqual(await searchSpotify('track'), [])
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'Spotify not configured.' }) })
    await assert.rejects(searchSpotify('track'), /Spotify not configured/)
    globalThis.fetch = async () => ({ ok: false, json: async () => { throw new Error('invalid json') } })
    await assert.rejects(searchSpotify('track'), /unreadable response/)
  } finally { globalThis.fetch = originalFetch }
})

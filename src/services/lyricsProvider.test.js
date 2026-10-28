import assert from 'node:assert/strict'
import test from 'node:test'
import { configureLyricsProvider, getTrackLyrics } from './lyricsProvider.js'

test('lyrics are explicitly unavailable when no provider is connected', async () => {
  configureLyricsProvider(null)
  assert.deepEqual(await getTrackLyrics({ id: 'track-1' }), { status: 'unavailable' })
})

test('lyrics provider results are shown only when marked authorized', async () => {
  configureLyricsProvider(async () => ({ status: 'available', authorized: true, lyrics: 'Authorized sample text' }))
  assert.deepEqual(await getTrackLyrics({ id: 'track-1' }), { status: 'available', lyrics: 'Authorized sample text' })
  configureLyricsProvider(async () => ({ status: 'available', lyrics: 'Unlicensed text' }))
  assert.equal((await getTrackLyrics({ id: 'track-1' })).status, 'error')
})

test('lyrics provider errors are distinct from unavailable lyrics', async () => {
  configureLyricsProvider(async () => { throw new Error('provider unavailable') })
  assert.deepEqual(await getTrackLyrics({ id: 'track-1' }), { status: 'error', message: 'Lyrics could not be loaded. Try again later.' })
  configureLyricsProvider(null)
})

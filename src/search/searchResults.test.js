import test from 'node:test'
import assert from 'node:assert/strict'
import { filterYouTubeResults } from './searchResults.js'

const results = [
  { videoId: 'song', contentType: 'official_audio', musicRelated: true },
  { videoId: 'live', contentType: 'live', musicRelated: true },
  { videoId: 'cover', contentType: 'cover', musicRelated: true },
  { videoId: 'lyrics', contentType: 'lyrics', musicRelated: true },
  { videoId: 'remix', contentType: 'remix', musicRelated: true },
  { videoId: 'unrelated', contentType: 'music', musicRelated: false },
]

test('search filter chips return their matching classified results', () => {
  assert.deepEqual(filterYouTubeResults(results, 'all'), results)
  assert.deepEqual(filterYouTubeResults(results, 'songs').map(({ videoId }) => videoId), ['song', 'lyrics'])
  assert.deepEqual(filterYouTubeResults(results, 'live').map(({ videoId }) => videoId), ['live'])
  assert.deepEqual(filterYouTubeResults(results, 'covers').map(({ videoId }) => videoId), ['cover'])
  assert.deepEqual(filterYouTubeResults(results, 'lyrics').map(({ videoId }) => videoId), ['lyrics'])
  assert.deepEqual(filterYouTubeResults(results, 'remixes').map(({ videoId }) => videoId), ['remix'])
})

test('unknown filters preserve all results and malformed result lists are safe', () => {
  assert.deepEqual(filterYouTubeResults(results, 'other'), results)
  assert.deepEqual(filterYouTubeResults(null, 'live'), [])
})

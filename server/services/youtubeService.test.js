import test from 'node:test'
import assert from 'node:assert/strict'
import { YouTubeApiError, YouTubeService } from './youtubeService.js'
import { QueueService } from './queueService.js'

const mockResult = {
  id: { videoId: 'abcdefghijk' },
  snippet: {
    title: 'A music video', channelTitle: 'Artist channel',
    thumbnails: { default: { url: 'https://img.youtube.com/default.jpg' }, medium: { url: 'https://img.youtube.com/medium.jpg' } },
  },
}

test('search maps only valid video results and requests embeddable videos', async () => {
  let requestedUrl
  let eligibilityUrl
  const service = new YouTubeService({ apiKey: 'test-key', fetchImpl: async (url) => {
    const urlObject = new URL(url)
    if (urlObject.pathname.endsWith('/videos')) {
      eligibilityUrl = urlObject
      return { ok: true, json: async () => ({ items: [{ id: 'abcdefghijk', status: { madeForKids: false, embeddable: true } }] }) }
    }
    requestedUrl = urlObject
    return { ok: true, json: async () => ({ items: [mockResult, { id: { channelId: 'not-a-video' }, snippet: {} }] }) }
  } })
  const results = await service.search('  artist   song ')
  assert.equal(requestedUrl.origin + requestedUrl.pathname, 'https://www.googleapis.com/youtube/v3/search')
  assert.equal(requestedUrl.searchParams.get('type'), 'video')
  assert.equal(requestedUrl.searchParams.get('videoEmbeddable'), 'true')
  assert.equal(requestedUrl.searchParams.get('q'), 'artist song')
  assert.equal(eligibilityUrl.searchParams.get('part'), 'status')
  assert.equal(service.verifySelection(results[0]), true)
  const { selectionToken, ...firstResult } = results[0]
  assert.match(selectionToken, /^\d+\.[A-Za-z0-9_-]+$/)
  assert.deepEqual(firstResult, {
    videoId: 'abcdefghijk', title: 'A music video', channelName: 'Artist channel',
    thumbnails: { default: 'https://img.youtube.com/default.jpg', medium: 'https://img.youtube.com/medium.jpg', high: null },
    provider: 'youtube',
  })
})

test('search excludes Made for Kids and non-embeddable videos', async () => {
  const eligibleVideo = (videoId) => ({ id: { videoId }, snippet: { title: videoId, channelTitle: 'Channel' } })
  const service = new YouTubeService({ apiKey: 'test-key', fetchImpl: async (url) => {
    if (new URL(url).pathname.endsWith('/videos')) return { ok: true, json: async () => ({ items: [
      { id: 'abcdefghijk', status: { madeForKids: false, embeddable: true } },
      { id: 'lmnopqrstuv', status: { madeForKids: true, embeddable: true } },
      { id: 'mnopqrstuvw', status: { madeForKids: false, embeddable: false } },
    ] }) }
    return { ok: true, json: async () => ({ items: [eligibleVideo('abcdefghijk'), eligibleVideo('lmnopqrstuv'), eligibleVideo('mnopqrstuvw')] }) }
  } })
  const results = await service.search('videos')
  assert.deepEqual(results.map((result) => result.videoId), ['abcdefghijk'])
})

test('search coalesces duplicate in-flight requests and caches the response briefly', async () => {
  let calls = 0
  const service = new YouTubeService({ apiKey: 'test-key', fetchImpl: async (url) => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (new URL(url).pathname.endsWith('/videos')) return { ok: true, json: async () => ({ items: [{ id: 'abcdefghijk', status: { madeForKids: false, embeddable: true } }] }) }
    return { ok: true, json: async () => ({ items: [mockResult] }) }
  } })
  const [first, second] = await Promise.all([service.search('same'), service.search('same')])
  assert.deepEqual(first, second)
  await service.search('same')
  assert.equal(calls, 2)
})

test('search validates input and reports missing credentials', async () => {
  const service = new YouTubeService({ apiKey: '', fetchImpl: async () => { throw new Error('must not fetch') } })
  await assert.rejects(service.search('  '), (error) => error instanceof YouTubeApiError && error.status === 400)
  await assert.rejects(service.search('music'), (error) => error.code === 'YOUTUBE_NOT_CONFIGURED' && error.status === 503)
})

test('search reports quota exhaustion clearly', async () => {
  const service = new YouTubeService({ apiKey: 'test-key', fetchImpl: async () => ({
    ok: false, status: 403, json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } }),
  }) })
  await assert.rejects(service.search('music'), (error) => error.code === 'YOUTUBE_QUOTA_EXCEEDED' && error.status === 429)
})

test('signed search results are tamper-resistant, expire, and can enter the room queue', async () => {
  let now = 1_800_000_000_000
  const service = new YouTubeService({ apiKey: 'test-key', now: () => now, fetchImpl: async (url) => {
    if (new URL(url).pathname.endsWith('/videos')) return { ok: true, json: async () => ({ items: [{ id: 'abcdefghijk', status: { madeForKids: false, embeddable: true } }] }) }
    return { ok: true, json: async () => ({ items: [mockResult] }) }
  } })
  const result = (await service.search('song'))[0]
  assert.equal(service.verifySelection({ ...result, title: 'Changed title' }), false)
  const roomService = { authenticate: async () => ({ code: 'ABC123', memberId: 'tester', displayName: 'Tester', role: 'owner' }) }
  const queue = new QueueService({ roomService, youtubeService: service })
  const added = await queue.add({}, { trackId: `youtube:${result.videoId}`, trackData: result })
  assert.equal(added.queue[0].trackData.title, 'A music video')
  const selected = await queue.select({}, { itemId: added.queue[0].itemId })
  assert.equal(selected.playback.currentTrackId, 'youtube:abcdefghijk')
  assert.equal(selected.playback.currentTrack.title, 'A music video')
  now += 11 * 60 * 1000
  assert.equal(service.verifySelection(result), false)
  await assert.rejects(queue.add({}, { trackId: `youtube:${result.videoId}`, trackData: result }), (error) => error.code === 'QUEUE_INPUT_INVALID')
})

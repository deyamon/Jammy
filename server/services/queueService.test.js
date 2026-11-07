import assert from 'node:assert/strict'
import test from 'node:test'
import { QueueService } from './queueService.js'
import { RoomService } from './roomService.js'

function identity(session) {
  return { code: session.room.code, memberId: session.member.id, memberToken: session.memberToken }
}

const fixtureVideoIds = new Map([
  ['youtube:AAAAAAAAAAA', { title: 'Track One', channelName: 'Artist One' }],
  ['youtube:BBBBBBBBBBB', { title: 'Track Two', channelName: 'Artist Two' }],
  ['youtube:CCCCCCCCCCC', { title: 'Track Three', channelName: 'Artist Three' }],
  ['youtube:DDDDDDDDDDD', { title: 'Track Four', channelName: 'Artist Four' }],
])
function trackData(trackId) {
  const details = fixtureVideoIds.get(trackId)
  if (!details) throw new Error(`Unknown YouTube test fixture: ${trackId}`)
  return { provider: 'youtube', videoId: trackId.slice('youtube:'.length), ...details, selectionToken: 'signed-by-test' }
}
function createQueueService(roomService, youtubeService = { verifySelection: () => true }) {
  const service = new QueueService({ roomService, youtubeService })
  return Object.assign(Object.create(service), {
    add(session, input) { return service.add(session, { ...input, trackData: input.trackData ?? trackData(input.trackId) }) },
  })
}

async function setup() {
  const roomService = new RoomService()
  const host = await roomService.createRoom({ name: 'Authorization test', displayName: 'Host' })
  const guest = await roomService.joinRoom({ code: host.room.code, displayName: 'Guest' })
  return { roomService, queue: createQueueService(roomService), host: identity(host), guest: identity(guest) }
}

function mockYouTube(resultsOrError) {
  const calls = []
  return {
    calls,
    async search(query) {
      calls.push(query)
      if (resultsOrError instanceof Error) throw resultsOrError
      if (typeof resultsOrError === 'function') return resultsOrError(query, calls.length)
      return resultsOrError
    },
    verifySelection: () => true,
  }
}

function recommendation(videoId, title = `Related ${videoId}`, channelName = 'Related artist') {
  return { videoId, title, channelName, thumbnails: { default: `https://i.ytimg.com/vi/${videoId}/default.jpg` }, selectionToken: 'signed-by-test' }
}

function addTrack(queue, identity, trackId) { return queue.add(identity, { trackId, trackData: trackData(trackId) }) }

async function startHostTrack(queue, host, trackId = 'youtube:AAAAAAAAAAA') {
  const added = await addTrack(queue, host, trackId)
  return queue.select(host, { itemId: added.queue[0].itemId, playImmediately: true })
}

test('all room members can add, remove, and reorder queue entries', async () => {
  const { queue, guest } = await setup()
  const first = await queue.add(guest, { trackId: 'youtube:AAAAAAAAAAA' })
  const second = await queue.add(guest, { trackId: 'youtube:BBBBBBBBBBB' })
  const third = await queue.add(guest, { trackId: 'youtube:CCCCCCCCCCC' })
  assert.deepEqual(first.queue.map((item) => item.trackId), ['youtube:AAAAAAAAAAA'])
  assert.deepEqual(second.queue.map((item) => item.trackId), ['youtube:AAAAAAAAAAA', 'youtube:BBBBBBBBBBB'])

  const reordered = await queue.reorder(guest, { itemId: third.queue[2].itemId, toIndex: 0 })
  assert.deepEqual(reordered.queue.map((item) => item.trackId), ['youtube:CCCCCCCCCCC', 'youtube:AAAAAAAAAAA', 'youtube:BBBBBBBBBBB'])
  const removed = await queue.remove(guest, { itemId: reordered.queue[1].itemId })
  assert.deepEqual(removed.queue.map((item) => item.trackId), ['youtube:CCCCCCCCCCC', 'youtube:BBBBBBBBBBB'])
})

test('concurrent in-memory additions cannot exceed the queue limit', async () => {
  const { queue, guest } = await setup()
  const results = await Promise.allSettled(Array.from({ length: 55 }, () => queue.add(guest, { trackId: 'youtube:AAAAAAAAAAA' })))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 50)
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'QUEUE_FULL').length, 5)
  assert.equal((await queue.state(guest)).queue.length, 50)
})

test('only the current host can select, control, skip, or change playback settings', async () => {
  const { roomService, queue, host, guest } = await setup()
  const guestAdded = await queue.add(guest, { trackId: 'youtube:AAAAAAAAAAA' })
  await queue.add(host, { trackId: 'youtube:BBBBBBBBBBB' })
  const queueItem = guestAdded.queue[0]

  await assert.rejects(queue.select(guest, { itemId: queueItem.itemId, playImmediately: true }), { code: 'ROOM_HOST_REQUIRED', status: 403 })
  const selected = await queue.select(host, { itemId: queueItem.itemId, playImmediately: true })
  const expectedTrackId = selected.playback.currentTrackId
  const expectedPlaybackToken = selected.playback.playbackToken

  for (const isPlaying of [true, false]) {
    await assert.rejects(queue.setPlayback(guest, { isPlaying, positionMs: 12000, expectedTrackId, expectedPlaybackToken }), { code: 'ROOM_HOST_REQUIRED' })
  }
  await assert.rejects(queue.setPlayback({ ...guest, role: 'owner' }, { isPlaying: true, positionMs: 12000, expectedTrackId, expectedPlaybackToken }), { code: 'ROOM_HOST_REQUIRED' })
  await assert.rejects(queue.next(guest, { expectedTrackId, expectedPlaybackToken }), { code: 'ROOM_HOST_REQUIRED' })
  await assert.rejects(queue.skip(guest, { expectedTrackId, expectedPlaybackToken }), { code: 'ROOM_HOST_REQUIRED' })
  await assert.rejects(queue.setRepeat(guest, { repeatMode: 'all' }), { code: 'ROOM_HOST_REQUIRED' })

  const playing = await queue.setPlayback(host, { isPlaying: true, positionMs: 12000, expectedTrackId, expectedPlaybackToken })
  assert.equal(playing.playback.isPlaying, true)
  assert.equal(playing.playback.positionMs, 12000)
  const next = await queue.next(host, { expectedTrackId, expectedPlaybackToken })
  assert.equal(next.playback.currentTrackId, 'youtube:BBBBBBBBBBB')
  const duplicate = await queue.next(host, { expectedTrackId, expectedPlaybackToken })
  assert.equal(duplicate.playback.currentTrackId, 'youtube:BBBBBBBBBBB')
  await assert.rejects(queue.setPlayback(host, { isPlaying: false, positionMs: 0, expectedTrackId, expectedPlaybackToken }), { code: 'PLAYBACK_STATE_STALE', status: 409 })
  const repeat = await queue.setRepeat(host, { repeatMode: 'one' })
  assert.equal(repeat.playback.repeatMode, 'one')
  assert.equal((await roomService.getRoom(host)).members.find((member) => member.id === host.memberId).role, 'owner')
})

test('playback mutations reject stale track tokens without changing the current state', async () => {
  const { queue, host } = await setup()
  await queue.add(host, { trackId: 'youtube:AAAAAAAAAAA' })
  const queuedSecond = await queue.add(host, { trackId: 'youtube:BBBBBBBBBBB' })
  const firstItem = queuedSecond.queue[0]
  const selected = await queue.select(host, { itemId: firstItem.itemId, playImmediately: true })
  const stale = { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken }
  const changed = await queue.next(host, stale)
  assert.equal(changed.playback.currentTrackId, 'youtube:BBBBBBBBBBB')

  await assert.rejects(queue.setPlayback(host, { isPlaying: false, positionMs: 0, ...stale }), { code: 'PLAYBACK_STATE_STALE' })
  const unchanged = await queue.state(host)
  assert.equal(unchanged.playback.currentTrackId, 'youtube:BBBBBBBBBBB')
  assert.equal(unchanged.playback.isPlaying, true)
})

test('Autoplay off is the default and never searches when the queue runs out', async () => {
  const { roomService, host } = await setup()
  const youtubeService = mockYouTube([recommendation('abcdefghijk')])
  const queue = createQueueService(roomService, youtubeService)
  const selected = await startHostTrack(queue, host)
  const ended = await queue.next(host, { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken })
  assert.equal(ended.playback.currentTrackId, null)
  assert.equal(ended.playback.autoplayEnabled, false)
  assert.equal(youtubeService.calls.length, 0)
})

test('enabling Autoplay persists on the room and adds related recommendations on exhaustion', async () => {
  const { roomService, host } = await setup()
  const youtubeService = mockYouTube([recommendation('abcdefghijk'), recommendation('lmnopqrstuv')])
  const queue = createQueueService(roomService, youtubeService)
  const selected = await startHostTrack(queue, host)
  const toggled = await queue.setAutoplay(host, { enabled: true })
  assert.equal(toggled.playback.autoplayEnabled, true)
  assert.equal(toggled.playback.currentTrackId, selected.playback.currentTrackId)
  assert.equal(toggled.playback.playbackToken, selected.playback.playbackToken)
  const advanced = await queue.next(host, { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken })
  assert.equal(advanced.playback.currentTrackId, 'youtube:abcdefghijk')
  assert.equal(advanced.playback.currentTrackIsAutoplay, true)
  assert.equal(advanced.queue.length, 1)
  assert.equal(advanced.queue[0].isAutoplay, true)
  assert.match(youtubeService.calls[0], /Artist One songs/i)
})

test('a YouTube search result keeps its normalized metadata through playback and Autoplay context', async () => {
  const { roomService, host } = await setup()
  const youtubeService = mockYouTube([recommendation('zyxwvutsrqp', 'Wait (Official Audio) - M83', 'M83 - Topic')])
  const queue = createQueueService(roomService, youtubeService)
  const initial = await startHostTrack(queue, host, 'youtube:AAAAAAAAAAA')
  const selectedResult = {
    videoId: 'abcdefghijk', provider: 'youtube', title: 'Midnight City',
    channelName: 'M83 - Topic', selectionToken: 'signed-by-test',
  }
  const queued = await queue.add(host, { trackId: 'youtube:abcdefghijk', trackData: selectedResult })
  await queue.setAutoplay(host, { enabled: true })
  const advanced = await queue.next(host, { expectedTrackId: initial.playback.currentTrackId, expectedPlaybackToken: initial.playback.playbackToken })
  assert.equal(advanced.playback.currentTrackId, 'youtube:abcdefghijk')
  assert.equal(advanced.playback.currentTrack.title, 'Midnight City')
  assert.equal(advanced.playback.currentTrack.artist, 'M83 - Topic')
  assert.equal(advanced.playback.currentTrack.channelName, 'M83 - Topic')
  const ended = await queue.next(host, { expectedTrackId: advanced.playback.currentTrackId, expectedPlaybackToken: advanced.playback.playbackToken })
  assert.equal(ended.playback.currentTrackId, 'youtube:zyxwvutsrqp')
  assert.match(youtubeService.calls[0], /M83 songs/i)
  assert.equal(queued.queue[0].trackData.title, 'Midnight City')
})

test('Autoplay uses a conservative title-only query when current artist metadata is missing', async () => {
  const { roomService, host } = await setup()
  const youtubeService = mockYouTube([recommendation('abcdefghijk', 'A Different Track', 'A Clear Artist')])
  const queue = createQueueService(roomService, youtubeService)
  const results = await queue.recommend({
    roomCode: host.code,
    playback: { currentTrackId: 'youtube:lmnopqrstuv', currentTrack: { title: 'Midnight City', provider: 'youtube' }, recentTrackIds: [] },
  })
  assert.equal(results.length, 1)
  assert.match(youtubeService.calls[0], /^Midnight City official audio$/i)
  assert.equal(youtubeService.calls.some((query) => /by undefined|undefined songs/i.test(query)), false)
})

test('Autoplay skips a current track with no title without searching', async () => {
  const { roomService, host } = await setup()
  const youtubeService = mockYouTube([recommendation('abcdefghijk')])
  const queue = createQueueService(roomService, youtubeService)
  const results = await queue.recommend({
    roomCode: host.code,
    playback: { currentTrackId: 'youtube:lmnopqrstuv', currentTrack: { artist: 'M83', provider: 'youtube' }, recentTrackIds: [] },
  })
  assert.deepEqual(results, [])
  assert.equal(youtubeService.calls.length, 0)
})

test('manual tracks are inserted before queued Autoplay recommendations', async () => {
  const { roomService, host } = await setup()
  const youtubeService = mockYouTube([recommendation('abcdefghijk'), recommendation('lmnopqrstuv')])
  const queue = createQueueService(roomService, youtubeService)
  const selected = await startHostTrack(queue, host)
  await queue.setAutoplay(host, { enabled: true })
  const advanced = await queue.next(host, { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken })
  const withManual = await queue.add(host, { trackId: 'youtube:BBBBBBBBBBB' })
  assert.deepEqual(withManual.queue.map((item) => [item.trackId, item.isAutoplay]), [
    ['youtube:BBBBBBBBBBB', false], ['youtube:lmnopqrstuv', true],
  ])
  const next = await queue.next(host, { expectedTrackId: advanced.playback.currentTrackId, expectedPlaybackToken: advanced.playback.playbackToken })
  assert.equal(next.playback.currentTrackId, 'youtube:BBBBBBBBBBB')
})

test('turning Autoplay off during a recommendation lookup prevents its results from being queued', async () => {
  const { roomService, host } = await setup()
  let releaseSearch
  let announceSearch
  const searchStarted = new Promise((resolve) => { announceSearch = resolve })
  const youtubeService = {
    verifySelection: () => true,
    calls: [],
    search(query) {
      this.calls.push(query)
      if (this.calls.length === 1) {
        announceSearch()
        return new Promise((resolve) => { releaseSearch = resolve })
      }
      return Promise.resolve([])
    },
  }
  const queue = createQueueService(roomService, youtubeService)
  const selected = await startHostTrack(queue, host)
  await queue.setAutoplay(host, { enabled: true })
  const advancing = queue.next(host, { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken })
  await searchStarted
  const disabled = await queue.setAutoplay(host, { enabled: false })
  assert.equal(disabled.playback.currentTrackId, selected.playback.currentTrackId)
  assert.equal(disabled.playback.playbackToken, selected.playback.playbackToken)
  releaseSearch([recommendation('abcdefghijk')])
  const ended = await advancing
  assert.equal(ended.playback.currentTrackId, null)
  assert.deepEqual(ended.queue, [])
  assert.equal(ended.playback.autoplayEnabled, false)
  assert.equal(youtubeService.calls.length, 3)
})

test('recommendations exclude current, recently played, queued, and duplicate result tracks', async () => {
  const { roomService, host } = await setup()
  const results = [recommendation('abcdefghijk'), recommendation('lmnopqrstuv'), recommendation('lmnopqrstuv'), recommendation('zyxwvutsrqp')]
  const youtubeService = mockYouTube(results)
  const queue = createQueueService(roomService, youtubeService)
  const selected = await startHostTrack(queue, host)
  await queue.setAutoplay(host, { enabled: true })
  const first = await queue.next(host, { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken })
  assert.equal(first.playback.currentTrackId, 'youtube:abcdefghijk')
  const second = await queue.next(host, { expectedTrackId: first.playback.currentTrackId, expectedPlaybackToken: first.playback.playbackToken })
  assert.equal(second.playback.currentTrackId, 'youtube:lmnopqrstuv')
  assert.equal(second.queue.some((item) => item.trackId === 'youtube:lmnopqrstuv'), false)
  assert.equal(new Set(second.queue.map((item) => item.trackId)).size, second.queue.length)
  const third = await queue.next(host, { expectedTrackId: second.playback.currentTrackId, expectedPlaybackToken: second.playback.playbackToken })
  assert.equal(third.playback.currentTrackId, 'youtube:zyxwvutsrqp')
  const exhausted = await queue.next(host, { expectedTrackId: third.playback.currentTrackId, expectedPlaybackToken: third.playback.playbackToken })
  assert.equal(exhausted.playback.currentTrackId, null)
  assert.equal(youtubeService.calls.length, 6)
})

test('Autoplay rejects lyric, live, remastered, and official uploads of the current song', async () => {
  const { roomService, host } = await setup()
  const youtubeService = mockYouTube([
    recommendation('abcdefghijk', 'Track One (Lyrics Video) | Artist One', 'Lyrics Archive'),
    recommendation('lmnopqrstuv', 'Artist One - Track One (Official Audio)', 'Artist One - Topic'),
    recommendation('zyxwvutsrqp', 'Track One (Live Performance) - Artist One', 'Live Sessions'),
    recommendation('mnopqrstvwx', 'Track One (Remastered 2025) | Artist One', 'Fan Uploads'),
    recommendation('opqrstuvwxy', 'Track One Tonight - Artist One', 'Artist One - Topic'),
    recommendation('pqrstuvwxyz', 'Track One - Artist Four', 'Artist Four - Topic'),
  ])
  const queue = createQueueService(roomService, youtubeService)
  const selected = await startHostTrack(queue, host)
  await queue.setAutoplay(host, { enabled: true })
  const next = await queue.next(host, { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken })
  assert.equal(next.playback.currentTrackId, 'youtube:opqrstuvwxy')
  assert.deepEqual(next.queue.map((item) => item.trackId), ['youtube:pqrstuvwxyz'])
  assert.equal(youtubeService.calls.length, 3)
})

test('searches prioritize the current artist, then related artists, and deduplicate songs across searches', async () => {
  const { roomService, host } = await setup()
  const youtubeService = mockYouTube((query, index) => {
    if (index === 1) return [
      recommendation('abcdefghijk', 'North Star - Men I Trust', 'Men I Trust - Topic'),
      recommendation('lmnopqrstuv', 'Daydream - Men I Trust', 'Men I Trust - Topic'),
    ]
    if (index === 2) return [
      recommendation('zyxwvutsrqp', 'Men I Trust - North Star (Official Audio)', 'Men I Trust'),
      recommendation('mnopqrstvwx', 'Soft Landing - Japanese Breakfast', 'Japanese Breakfast'),
    ]
    return [
      recommendation('opqrstuvwxy', 'North Star (Live) | Men I Trust', 'Live Archive'),
      recommendation('pqrstuvwxyz', 'Night Drive - Japanese Breakfast', 'Japanese Breakfast - Topic'),
    ]
  })
  const queue = createQueueService(roomService, youtubeService)
  const selected = await startHostTrack(queue, host, 'youtube:BBBBBBBBBBB')
  await queue.setAutoplay(host, { enabled: true })
  const next = await queue.next(host, { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken })
  assert.match(youtubeService.calls[0], /Artist Two songs/)
  assert.match(youtubeService.calls[1], /artists similar to Artist Two/)
  assert.match(youtubeService.calls[2], /songs like Track Two by Artist Two/)
  assert.equal(new Set([next.playback.currentTrackId, ...next.queue.map((item) => item.trackId)]).size, 4)
  assert.deepEqual(new Set(next.queue.map((item) => item.trackId)), new Set(['youtube:lmnopqrstuv', 'youtube:mnopqrstvwx', 'youtube:pqrstuvwxyz']))
})

test('queued and previously played songs stay excluded across later queue exhaustion', async () => {
  const { roomService, host } = await setup()
  const youtubeService = mockYouTube([
    recommendation('abcdefghijk', 'Track One (Official Audio) - Artist One', 'Artist One'),
    recommendation('lmnopqrstuv', 'Track Two (Live) - Artist Two', 'Live Archive'),
    recommendation('zyxwvutsrqp', 'Different Track - Artist Two', 'Artist Two - Topic'),
  ])
  const queue = createQueueService(roomService, youtubeService)
  const selected = await startHostTrack(queue, host)
  await queue.add(host, { trackId: 'youtube:BBBBBBBBBBB' })
  await queue.setAutoplay(host, { enabled: true })
  const manualTrack = await queue.next(host, { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken })
  assert.equal(manualTrack.playback.currentTrackId, 'youtube:BBBBBBBBBBB')
  const next = await queue.next(host, { expectedTrackId: manualTrack.playback.currentTrackId, expectedPlaybackToken: manualTrack.playback.playbackToken })
  assert.equal(next.playback.currentTrackId, 'youtube:zyxwvutsrqp')
  assert.equal(next.queue.some((item) => item.trackId === 'youtube:abcdefghijk' || item.trackId === 'youtube:lmnopqrstuv'), false)
  const exhausted = await queue.next(host, { expectedTrackId: next.playback.currentTrackId, expectedPlaybackToken: next.playback.playbackToken })
  assert.equal(exhausted.playback.currentTrackId, null)
  assert.equal(youtubeService.calls.length, 4)
})

test('failed search contexts can be retried during the room session', async () => {
  const { roomService, host } = await setup()
  const youtubeService = mockYouTube(new Error('upstream unavailable'))
  const queue = createQueueService(roomService, youtubeService)
  const selected = await startHostTrack(queue, host)
  await queue.setAutoplay(host, { enabled: true })
  const ended = await queue.next(host, { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken })
  assert.equal(ended.playback.currentTrackId, null)
  assert.equal(youtubeService.calls.length, 3)
  assert.equal(queue.pendingAdvances.size, 0)
  const again = await queue.recommend({ roomCode: host.code, playback: { currentTrackId: 'youtube:AAAAAAAAAAA', currentTrack: selected.playback.currentTrack }, queue: [] })
  assert.deepEqual(again, [])
  assert.equal(youtubeService.calls.length, 6)
  await queue.removeRoom(host.code)
  assert.equal(queue.autoplaySessions.has(host.code), false)
})

test('repeat one and repeat all keep their playback transitions without recommendation searches', async () => {
  const { roomService, host } = await setup()
  const youtubeService = mockYouTube([recommendation('abcdefghijk')])
  const queue = createQueueService(roomService, youtubeService)
  const selected = await startHostTrack(queue, host)
  await queue.setAutoplay(host, { enabled: true })
  await queue.setRepeat(host, { repeatMode: 'one' })
  const replay = await queue.next(host, { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken })
  assert.equal(replay.playback.currentTrackId, 'youtube:AAAAAAAAAAA')
  assert.equal(replay.playback.repeatMode, 'one')
  assert.equal(youtubeService.calls.length, 0)
  await queue.setRepeat(host, { repeatMode: 'all' })
  const wrapped = await queue.next(host, { expectedTrackId: replay.playback.currentTrackId, expectedPlaybackToken: replay.playback.playbackToken })
  assert.equal(wrapped.playback.currentTrackId, 'youtube:AAAAAAAAAAA')
  assert.equal(wrapped.playback.repeatMode, 'all')
  assert.equal(youtubeService.calls.length, 0)
})

test('failed searches and invalid or unavailable results stop cleanly without breaking room state', async () => {
  const { roomService, host } = await setup()
  const failedSearch = mockYouTube(new Error('upstream failed'))
  const queue = createQueueService(roomService, failedSearch)
  const selected = await startHostTrack(queue, host)
  await queue.setAutoplay(host, { enabled: true })
  const ended = await queue.next(host, { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken })
  assert.equal(ended.playback.currentTrackId, null)
  assert.equal(ended.playback.autoplayEnabled, true)

  const unavailable = mockYouTube([recommendation('bad id'), recommendation('abcdefghijk')])
  unavailable.verifySelection = (result) => result.videoId !== 'abcdefghijk'
  const secondQueue = createQueueService(roomService, unavailable)
  const nextTrack = await startHostTrack(secondQueue, host, 'youtube:BBBBBBBBBBB')
  await secondQueue.setAutoplay(host, { enabled: true })
  const noEligibleResults = await secondQueue.next(host, { expectedTrackId: nextTrack.playback.currentTrackId, expectedPlaybackToken: nextTrack.playback.playbackToken })
  assert.equal(noEligibleResults.playback.currentTrackId, null)
  assert.deepEqual(noEligibleResults.queue, [])

  const emptySearch = mockYouTube([])
  const thirdQueue = createQueueService(roomService, emptySearch)
  const finalTrack = await startHostTrack(thirdQueue, host, 'youtube:CCCCCCCCCCC')
  await thirdQueue.setAutoplay(host, { enabled: true })
  const exhausted = await thirdQueue.next(host, { expectedTrackId: finalTrack.playback.currentTrackId, expectedPlaybackToken: finalTrack.playback.playbackToken })
  assert.equal(exhausted.playback.currentTrackId, null)
  assert.equal(emptySearch.calls.length, 3)
})

test('simultaneous room end signals advance once and guests cannot advance the shared room', async () => {
  const { roomService, host, guest } = await setup()
  const youtubeService = mockYouTube([recommendation('abcdefghijk')])
  const queue = createQueueService(roomService, youtubeService)
  const selected = await startHostTrack(queue, host)
  await queue.setAutoplay(host, { enabled: true })
  const request = { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken }
  const results = await Promise.allSettled([queue.next(host, request), queue.next(guest, request), queue.next(host, request)])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2)
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'ROOM_HOST_REQUIRED').length, 1)
  assert.equal(youtubeService.calls.length, 3)
  assert.equal((await queue.state(host)).playback.currentTrackId, 'youtube:abcdefghijk')
})

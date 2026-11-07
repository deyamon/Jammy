import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isValidYouTubeVideoId, loadSoloYouTubeTrack } from './soloYouTubePlayback.js'
import { asYouTubeTrack } from '../services/youtubeApi.js'

const app = await readFile(new URL('../App.jsx', import.meta.url), 'utf8')
const embed = await readFile(new URL('./YoutubeEmbed.jsx', import.meta.url), 'utf8')

const searchTrack = {
  id: 'youtube:abcdefghijk',
  provider: 'youtube',
  videoId: 'abcdefghijk',
  title: 'A real search result',
  channelName: 'A real channel',
}

test('first solo YouTube selection initializes from an empty standalone track', () => {
  const actions = []
  const result = loadSoloYouTubeTrack(searchTrack, null, { autoplay: true }, {
    setTrack: (track) => actions.push(['track', track]),
    setAutoplayRequested: (requested) => actions.push(['autoplay', requested]),
    openPlayer: () => actions.push(['open', 'player']),
  })

  assert.deepEqual(result, { ok: true, changed: true })
  assert.deepEqual(actions, [['track', searchTrack], ['autoplay', true], ['open', 'player']])
})

test('an authenticated YouTube search result can be selected for solo playback', () => {
  const track = asYouTubeTrack({ videoId: 'abcdefghijk', title: 'A real song', channelName: 'A real channel' })
  let selectedTrack = null
  const result = loadSoloYouTubeTrack(track, null, { autoplay: true }, {
    setTrack: (nextTrack) => { selectedTrack = nextTrack },
    setAutoplayRequested: () => {},
    openPlayer: () => {},
  })
  assert.deepEqual(result, { ok: true, changed: true })
  assert.equal(selectedTrack.videoId, 'abcdefghijk')
  assert.equal(selectedTrack.provider, 'youtube')
})

test('reselecting the current video uses the ready player without replacing track state', () => {
  let selected = 0
  let played = 0
  const player = { canControl: () => true, playFromUserGesture: () => { played += 1 } }
  const result = loadSoloYouTubeTrack(searchTrack, searchTrack, { autoplay: true, openPlayer: false }, {
    setTrack: () => { selected += 1 },
    setAutoplayRequested: () => {},
    openPlayer: () => {},
    player,
  })

  assert.deepEqual(result, { ok: true, changed: false })
  assert.equal(selected, 0)
  assert.equal(played, 1)
})

test('missing and malformed YouTube IDs fail clearly without starting player setup', () => {
  assert.equal(isValidYouTubeVideoId('abcdefghijk'), true)
  assert.equal(isValidYouTubeVideoId('short'), false)
  assert.equal(isValidYouTubeVideoId('abcdefghij!'), false)

  let selected = false
  const result = loadSoloYouTubeTrack({ ...searchTrack, videoId: '' }, null, {}, { setTrack: () => { selected = true } })
  assert.deepEqual(result, { ok: false, error: 'This YouTube video is missing a valid video ID and cannot be played.' })
  assert.equal(selected, false)
})

test('the App uses the null-safe solo loader and player setup errors reach playback state', () => {
  assert.match(app, /loadSoloYouTubeTrack\(track, standaloneTrack, options/)
  assert.match(app, /track\.id === standaloneTrack\?\.id/)
  assert.match(embed, /track\?\.provider === 'youtube' && !isValidYouTubeVideoId\(track\.videoId\)/)
  assert.match(embed, /The YouTube player could not be initialized/)
})

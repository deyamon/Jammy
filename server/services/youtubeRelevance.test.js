import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyMusicResult, filterMusicResults, parseMusicQuery, rankMusicResults, scoreMusicResult } from './youtubeRelevance.js'

function result(videoId, title, channelName = 'Music Channel', extra = {}) {
  return { videoId, title, channelName, categoryId: '10', durationSeconds: 220, ...extra }
}

test('query parsing separates version intent from the artist and title terms', () => {
  const cases = [
    ['Harry Styles', ['harry', 'styles'], []],
    ['harry style', ['harry', 'style'], []],
    ['Harry Styles As It Was', ['harry', 'styles', 'as', 'it', 'was'], []],
    ['Taylor Swift Style', ['taylor', 'swift', 'style'], []],
    ['The Weeknd Blinding Lights', ['the', 'weeknd', 'blinding', 'lights'], []],
    ['Joji Glimpse of Us', ['joji', 'glimpse', 'of', 'us'], []],
    ['Nirvana Smells Like Teen Spirit', ['nirvana', 'smells', 'like', 'teen', 'spirit'], []],
    ['AC/DC Back in Black', ['ac', 'dc', 'back', 'in', 'black'], []],
    ['Pink Floyd Comfortably Numb', ['pink', 'floyd', 'comfortably', 'numb'], []],
    ['Harry Styles live', ['harry', 'styles'], ['live']],
    ['Harry Styles lyrics', ['harry', 'styles'], ['lyrics']],
    ['Harry Styles cover', ['harry', 'styles'], ['cover']],
    ['Harry Styles remix', ['harry', 'styles'], ['remix']],
  ]
  for (const [query, tokens, intents] of cases) {
    const parsed = parseMusicQuery(query)
    assert.deepEqual(parsed.coreTokens, tokens, query)
    assert.deepEqual(parsed.intents, intents, query)
  }
})

test('artist and exact artist-song matches outrank a one-word collision', () => {
  const candidates = [
    result('aaaaaaaaaaa', 'Harry Styles - As It Was (Official Music Video)', 'HarryStylesVEVO'),
    result('bbbbbbbbbbb', 'Taylor Swift - Style (Official Music Video)', 'Taylor Swift'),
    result('ccccccccccc', 'Style tips for Harry Potter fans', 'Celebrity Edits', { categoryId: '22' }),
  ]
  assert.equal(rankMusicResults('Harry Styles', candidates)[0].videoId, 'aaaaaaaaaaa')
  assert.equal(rankMusicResults('harry style', candidates)[0].videoId, 'aaaaaaaaaaa')
  assert.equal(rankMusicResults('Harry Styles As It Was', candidates)[0].videoId, 'aaaaaaaaaaa')
  assert.equal(rankMusicResults('Taylor Swift Style', candidates)[0].videoId, 'bbbbbbbbbbb')
})

test('supported artist and song searches score exact title and channel matches', () => {
  const cases = [
    ['The Weeknd Blinding Lights', 'The Weeknd - Blinding Lights (Official Video)', 'The Weeknd'],
    ['Joji Glimpse of Us', 'Joji - Glimpse of Us (Official Music Video)', '88rising'],
    ['Nirvana Smells Like Teen Spirit', 'Nirvana - Smells Like Teen Spirit (Official Music Video)', 'Nirvana'],
    ['AC/DC Back in Black', 'AC/DC - Back in Black (Official Audio)', 'AC/DC'],
    ['Pink Floyd Comfortably Numb', 'Pink Floyd - Comfortably Numb (Official Music Video)', 'Pink Floyd'],
  ]
  for (const [query, title, channel] of cases) {
    const candidate = result('abcdefghijk', title, channel)
    const scored = scoreMusicResult(query, candidate)
    assert.equal(scored.titleCoverage, 1, query)
    assert.equal(scored.queryCoverage, 1, query)
    assert.ok(scored.score > 80, `${query}: ${scored.score}`)
  }
})

test('version intent boosts matching live, lyric, cover, and remix results', () => {
  const cases = [
    ['Harry Styles live', 'Harry Styles - As It Was (Live at Wembley)', 'live'],
    ['Harry Styles lyrics', 'Harry Styles - As It Was (Official Lyrics)', 'official_lyrics'],
    ['Harry Styles cover', 'As It Was - Harry Styles (Acoustic Cover)', 'cover'],
    ['Harry Styles remix', 'Harry Styles - As It Was (Dance Remix)', 'remix'],
  ]
  for (const [query, title, type] of cases) {
    const candidate = result('abcdefghijk', title, 'Harry Styles')
    assert.equal(classifyMusicResult(candidate).contentType, type)
    assert.ok(scoreMusicResult(query, candidate).score > scoreMusicResult('Harry Styles', candidate).score, query)
  }
})

test('negative signals and explicit Shorts are suppressed without dropping every short song', () => {
  const proper = result('aaaaaaaaaaa', 'Harry Styles - As It Was (Official Music Video)', 'HarryStylesVEVO')
  const reaction = result('bbbbbbbbbbb', 'Harry Styles reaction and review', 'Reaction Channel')
  const short = result('ccccccccccc', 'Harry Styles song #Shorts', 'Fan Edits', { durationSeconds: 35 })
  const shortSong = result('ddddddddddd', 'Harry Styles - Satellite (Official Audio)', 'Harry Styles', { durationSeconds: 42 })
  const ranked = rankMusicResults('Harry Styles', [reaction, short, proper, shortSong])
  assert.equal(ranked[0].videoId, proper.videoId)
  assert.ok(ranked.find((item) => item.videoId === reaction.videoId).score < ranked[0].score)
  assert.ok(ranked.find((item) => item.videoId === short.videoId).score < ranked[0].score)
  assert.ok(ranked.some((item) => item.videoId === shortSong.videoId))
})

test('duplicate IDs and routine duplicate uploads collapse but alternate versions remain', () => {
  const candidates = [
    result('aaaaaaaaaaa', 'Artist - Song (Official Music Video)', 'Artist VEVO'),
    result('aaaaaaaaaaa', 'duplicate ID title', 'Other'),
    result('bbbbbbbbbbb', 'Artist - Song (Official Audio)', 'Artist - Topic'),
    result('ccccccccccc', 'Artist - Song (Live)', 'Artist'),
    result('ddddddddddd', 'Artist - Song (Acoustic Cover)', 'Artist'),
    result('eeeeeeeeeee', 'Artist - Song (Remix)', 'DJ'),
  ]
  const ranked = rankMusicResults('Artist Song', candidates)
  assert.equal(new Set(ranked.map((item) => item.videoId)).size, ranked.length)
  assert.equal(ranked.filter((item) => item.contentType === 'live').length, 1)
  assert.equal(ranked.filter((item) => item.contentType === 'cover').length, 1)
  assert.equal(ranked.filter((item) => item.contentType === 'remix').length, 1)
  assert.ok(ranked.length < candidates.length)
})

test('meaningful filter chips select results by classified content metadata', () => {
  const items = [
    result('aaaaaaaaaaa', 'Artist - Song (Official Audio)', 'Artist'),
    result('bbbbbbbbbbb', 'Artist - Song (Live)', 'Artist'),
    result('ccccccccccc', 'Artist - Song (Lyrics)', 'Artist'),
    result('ddddddddddd', 'Artist - Song (Cover)', 'Cover Artist'),
    result('eeeeeeeeeee', 'Artist - Song (Remix)', 'DJ'),
  ]
  const ranked = rankMusicResults('Artist Song', items)
  assert.equal(filterMusicResults(ranked, 'all').length, ranked.length)
  assert.deepEqual(filterMusicResults(ranked, 'live').map((item) => item.contentType), ['live'])
  assert.deepEqual(filterMusicResults(ranked, 'covers').map((item) => item.contentType), ['cover'])
  assert.deepEqual(filterMusicResults(ranked, 'lyrics').map((item) => item.contentType), ['lyrics'])
  assert.deepEqual(filterMusicResults(ranked, 'remixes').map((item) => item.contentType), ['remix'])
  assert.ok(filterMusicResults(ranked, 'songs').every((item) => item.musicRelated))
})

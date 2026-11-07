import assert from 'node:assert/strict'
import test from 'node:test'
import { identifySong, normalizeArtistName, normalizeSongText, sameSongIdentity } from './songIdentity.js'

const openArms = identifySong({ title: 'Open Arms', artist: 'SZA' })

test('normalizes case, punctuation, whitespace, and artist channel suffixes', () => {
  assert.equal(normalizeSongText('  OPEN—ARMS!!  '), 'open arms')
  assert.equal(normalizeSongText('Beyoncé & SZA'), 'beyonce and sza')
  assert.equal(normalizeArtistName('SZA - Topic'), 'sza')
})

test('matches official, lyric, live, remastered, and alternate uploads as the same song', () => {
  const variants = [
    { title: 'Open Arms - SZA', channelName: 'Lyrics Archive', provider: 'youtube', artist: 'Lyrics Archive' },
    { title: 'SZA - Open Arms (Official Audio)', channelName: 'Vevo', provider: 'youtube', artist: 'Vevo' },
    { title: 'Open Arms (Lyrics Video) | SZA', channelName: 'Fan Channel', provider: 'youtube', artist: 'Fan Channel' },
    { title: 'Open Arms (Live Performance) - SZA', channelName: 'Live Sessions', provider: 'youtube', artist: 'Live Sessions' },
    { title: 'Open Arms (Remastered 2024) | SZA', channelName: 'Music Channel', provider: 'youtube', artist: 'Music Channel' },
    { title: 'SZA — Open Arms (Visualizer)', channelName: 'Visual Hub', provider: 'youtube', artist: 'Visual Hub' },
  ]
  for (const variant of variants) assert.ok(sameSongIdentity(openArms, identifySong(variant, ['SZA'])), variant.title)
})

test('preserves genuinely different songs with similar titles and different artists', () => {
  const similarTitle = identifySong({ title: 'Open Arms Again', artist: 'SZA' })
  const sameTitleDifferentArtist = identifySong({ title: 'Open Arms', artist: 'Travis Scott' })
  const differentSongSameArtist = identifySong({ title: 'Snooze', artist: 'SZA' })
  assert.equal(sameSongIdentity(openArms, similarTitle), false)
  assert.equal(sameSongIdentity(openArms, sameTitleDifferentArtist), false)
  assert.equal(sameSongIdentity(openArms, differentSongSameArtist), false)
})

test('uses a known artist to parse title-first and artist-first title formats', () => {
  const titleFirst = identifySong({ title: 'Open Arms - SZA', channelName: 'Lyrics Archive', provider: 'youtube', artist: 'Lyrics Archive' }, ['SZA'])
  const artistFirst = identifySong({ title: 'SZA | Open Arms (Official Audio)', channelName: 'SZA - Topic', provider: 'youtube', artist: 'SZA - Topic' })
  assert.ok(sameSongIdentity(openArms, titleFirst))
  assert.ok(sameSongIdentity(openArms, artistFirst))
  const versionBeforeArtist = identifySong({ title: 'Open Arms (Live Version - SZA)', channelName: 'Stage Archive', provider: 'youtube', artist: 'Stage Archive' }, ['SZA'])
  assert.ok(sameSongIdentity(openArms, versionBeforeArtist))
})

test('rejects ambiguous artist metadata and does not strip meaningful title words', () => {
  assert.equal(identifySong({ title: 'Open Arms (Live Version)' }), null)
  assert.equal(identifySong({ title: 'Live', artist: 'SZA' }).titleKey, 'live')
  assert.equal(identifySong({ title: 'Performance', artist: 'SZA' }).titleKey, 'performance')
  const collaboration = identifySong({ title: 'Tadow', artist: 'Masego, FKJ' })
  const fkjUpload = identifySong({ title: 'Tadow - FKJ', channelName: 'FKJ - Topic', provider: 'youtube', artist: 'FKJ - Topic' })
  assert.ok(sameSongIdentity(collaboration, fkjUpload))
})

test('normalizes Jammy and YouTube track metadata shapes into a song identity', () => {
  assert.ok(sameSongIdentity(
    identifySong({ title: 'Midnight City', artist: 'M83' }),
    identifySong({ trackData: { name: 'Midnight City', channelTitle: 'M83 - Topic' } }),
  ))
  assert.ok(sameSongIdentity(
    identifySong({ title: 'Midnight City', artist: 'M83' }),
    identifySong({ provider: 'youtube', snippet: { title: 'M83 - Midnight City (Official Audio)', channelTitle: 'M83 - Topic' } }),
  ))
})

test('allows title-only context when requested and still rejects a missing title', () => {
  const titleOnly = identifySong({ title: 'Midnight City', provider: 'youtube' }, [], { allowTitleOnly: true })
  assert.equal(titleOnly.titleKey, 'midnight city')
  assert.equal(titleOnly.artist, '')
  assert.equal(identifySong({ title: 'Midnight City', provider: 'youtube' }), null)
  assert.equal(identifySong({ name: 42, artist: 'M83' }, [], { allowTitleOnly: true }), null)
  assert.equal(sameSongIdentity(titleOnly, identifySong({ title: 'Midnight City', artist: 'M83' })), true)
  assert.equal(sameSongIdentity(titleOnly, identifySong({ title: 'Midnight City Tonight', artist: 'M83' })), false)
})

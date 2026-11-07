import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMusicTasteProfile, personalizedYouTubeQuery } from './musicTaste.js'

test('taste profile uses only authenticated user Jammy listening history', () => {
  const profile = buildMusicTasteProfile({ jammyHistory: [
    { videoId: 'abcdefghijk', title: 'Night Drive', channelName: 'Artist A' },
    { videoId: 'lmnopqrstuv', title: 'Night Drive', channelName: 'Artist A' },
    { videoId: 'zyxwvutsrqp', title: 'Soft Rain', channelName: 'Artist B' },
  ] })
  assert.equal(profile.favoriteArtists[0].name, 'Artist A')
  assert.equal(profile.frequentTracks[0].title, 'Night Drive')
  assert.deepEqual(profile.duplicateAvoidance.youtubeVideoIds.sort(), ['abcdefghijk', 'lmnopqrstuv', 'zyxwvutsrqp'])
  assert.equal(profile.favoriteArtists.some((artist) => artist.name === 'Spotify Artist'), false)
})

test('Spotify imports are not analyzed into Jammy taste profiles', () => {
  const jammyOnly = buildMusicTasteProfile({ jammyHistory: [{ videoId: 'abcdefghijk', title: 'My Track', channelName: 'Jammy Artist' }] })
  const sameProfile = buildMusicTasteProfile({ jammyHistory: [{ videoId: 'abcdefghijk', title: 'My Track', channelName: 'Jammy Artist' }], spotifyItems: [{ kind: 'top_artist', data: { name: 'Spotify Artist', genres: ['not used'] } }] })
  assert.deepEqual(sameProfile, jammyOnly)
  assert.equal(sameProfile.genreSignals.length, 0)
})

test('personal YouTube search adds only the saved Jammy artist affinity', () => {
  assert.equal(personalizedYouTubeQuery('new music', { favoriteArtists: [{ name: 'Artist A' }] }), 'new music Artist A')
  assert.equal(personalizedYouTubeQuery('new music', { favoriteArtists: [] }), 'new music')
})

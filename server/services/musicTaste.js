function text(value) { return typeof value === 'string' ? value.trim() : '' }
/** Taste is derived only from Jammy activity; Spotify content is displayed separately, not analyzed into a profile. */
export function buildMusicTasteProfile({ jammyHistory = [] } = {}) {
  const artistAffinity = new Map()
  const trackFrequency = new Map()
  const recentlyListenedArtists = []
  const addArtist = (artist, weight, recent = false) => {
    if (!artist.name) return
    const key = artist.id || artist.name.toLocaleLowerCase()
    const current = artistAffinity.get(key) ?? { id: artist.id || null, name: artist.name, score: 0 }
    current.score += weight
    artistAffinity.set(key, current)
    if (recent && !recentlyListenedArtists.some((entry) => entry.key === key)) recentlyListenedArtists.push({ key, name: artist.name })
  }
  for (const item of jammyHistory) {
    const artistName = text(item?.artist || item?.channelName)
    if (artistName) addArtist({ name: artistName }, 2, true)
    if (text(item?.title)) {
      const key = text(item?.videoId || item?.trackId || item?.title).toLocaleLowerCase()
      const current = trackFrequency.get(key) ?? { id: null, title: text(item.title), artists: artistName ? [artistName] : [], score: 0 }
      current.score += 2
      trackFrequency.set(key, current)
    }
  }
  const favoriteArtists = [...artistAffinity.values()].sort((a, b) => b.score - a.score).slice(0, 12)
  const frequentTracks = [...trackFrequency.values()].sort((a, b) => b.score - a.score).slice(0, 20)
  const topNames = favoriteArtists.slice(0, 3).map((artist) => artist.name)
  return {
    version: 1,
    favoriteArtists,
    frequentTracks,
    artistAffinity: favoriteArtists,
    recentlyListenedArtists: recentlyListenedArtists.slice(0, 12).map(({ name }) => name),
    genreSignals: [],
    discoveryPreferences: topNames.length ? { preferredArtists: topNames, strategy: 'related-to-listening-history' } : { preferredArtists: [], strategy: 'broad-youtube-discovery' },
    duplicateAvoidance: { spotifyTrackIds: frequentTracks.flatMap((track) => track.id ? [track.id] : []), youtubeVideoIds: jammyHistory.map((item) => text(item.videoId)).filter(Boolean) },
  }
}

export function personalizedYouTubeQuery(query, tasteProfile) {
  const base = text(query)
  const artists = Array.isArray(tasteProfile?.favoriteArtists) ? tasteProfile.favoriteArtists.slice(0, 2).map((artist) => text(artist?.name)).filter(Boolean) : []
  if (!base || !artists.length) return base
  return `${base} ${artists.join(' ')}`.slice(0, 100)
}

const VERSION_LABELS = new Set([
  'audio', 'official audio', 'official video', 'official music video', 'music video',
  'lyrics', 'lyric', 'lyrics video', 'lyric video', 'live', 'live version',
  'live performance', 'performance', 'visualizer', 'visualiser', 'remaster',
  'remastered', 'alternate version', 'alternative version', 'alternate take',
  'radio edit', 'acoustic version', 'cover', 'karaoke',
])
const CHANNEL_SUFFIXES = /\s+(?:vevo|topic|official|records?)$/i
const GENERIC_CHANNEL = /\b(?:lyrics?|genius|karaoke|various artists|top hits|music video)\b/i

export function normalizeSongText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function normalizeArtistName(value) {
  let artist = String(value ?? '').trim()
  artist = artist.replace(/\s*[-|–—]\s*(?:vevo|topic|official)$/i, '')
  artist = artist.replace(CHANNEL_SUFFIXES, '')
  return normalizeSongText(artist)
}

function isVersionLabel(value) {
  return VERSION_LABELS.has(normalizeSongText(value))
    || /^(?:official\s+)?(?:remaster(?:ed)?)(?:\s+\d{4})?$/i.test(String(value ?? '').trim())
    || /^(?:live\s+(?:at|from)\s+.+)$/i.test(String(value ?? '').trim())
}

function stripVersionLabels(value) {
  let result = String(value ?? '').replace(/\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g, (whole, round, square, curly) => {
    const annotation = round ?? square ?? curly
    if (isVersionLabel(annotation)) return ' '
    const parts = annotation.split(/\s+(?:-|–|—|\|)\s+/)
    if (parts.length > 1 && parts.some(isVersionLabel)) {
      const remaining = parts.filter((part) => !isVersionLabel(part)).join(' - ')
      return remaining ? ` - ${remaining} ` : ' '
    }
    return whole
  })
  const parts = result.split(/\s+(?:-|–|—|\|)\s+/)
  if (parts.length > 1) result = parts.filter((part) => !isVersionLabel(part)).join(' - ')
  const suffixes = [...VERSION_LABELS].sort((a, b) => b.length - a.length)
  for (const suffix of suffixes) {
    const pattern = new RegExp(`(?:\\s*[|–—-]\\s*|\\s+)${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
    const next = result.replace(pattern, '').trim()
    if (next && next !== result.trim()) result = next
  }
  return result.replace(/[|–—-]+\s*$/, '').trim()
}

function channelArtist(channelName) {
  const raw = String(channelName ?? '').trim()
  const artistKey = normalizeArtistName(raw)
  if (!artistKey || GENERIC_CHANNEL.test(raw)) return null
  const artist = raw.replace(/\s*[-|–—]\s*(?:vevo|topic|official)$/i, '').trim()
  return { artist, artistKey, artistKeys: artistAliases(artist) }
}

function artistAliases(value) {
  const aliases = String(value ?? '').split(/\s*,\s*|\s+&\s+|\s+feat(?:uring)?\.?\s+/i).map(normalizeArtistName).filter(Boolean)
  return [...new Set(aliases)]
}

function structuredArtists(track) {
  const values = [
    ...(Array.isArray(track?.artists) ? track.artists : []),
    ...(typeof track?.artist === 'string' && !(track.provider === 'youtube' && track.artist === track.channelName) ? [track.artist] : []),
  ]
  return values.map((artist) => {
    const label = String(artist).trim()
    return { artist: label, artistKey: normalizeArtistName(label), artistKeys: artistAliases(label) }
  }).filter((artist) => artist.artistKey)
}

function firstText(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? ''
}

function canonicalTrackMetadata(track) {
  if (!track || typeof track !== 'object' || Array.isArray(track)) return null
  const source = track.trackData ?? track.metadata ?? track
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const snippet = source.snippet && typeof source.snippet === 'object' ? source.snippet : {}
  return {
    ...source,
    title: firstText(source.title, source.name, snippet.title),
    artist: firstText(source.artist),
    channelName: firstText(source.channelName, source.channelTitle, snippet.channelTitle),
  }
}

export function identifySong(track, artistHints = [], { allowTitleOnly = false } = {}) {
  const metadata = canonicalTrackMetadata(track)
  if (!metadata?.title) return null
  const cleanedTitle = stripVersionLabels(metadata.title)
  if (!cleanedTitle) return null

  const metadataArtists = structuredArtists(metadata)
  const channel = channelArtist(metadata.channelName)
  const hintArtists = artistHints.map((artist) => {
    const label = String(artist).trim()
    return { artist: label, artistKey: normalizeArtistName(label), artistKeys: artistAliases(label) }
  }).filter((artist) => artist.artistKey)
  const knownArtists = [...metadataArtists, ...(channel ? [channel] : []), ...hintArtists]
  const titleParts = cleanedTitle.split(/\s+(?:-|–|—|\|)\s+/).map(stripVersionLabels).filter(Boolean)

  let songTitle = cleanedTitle
  let artist = metadataArtists[0] ?? channel
  if (titleParts.length > 1) {
    const matches = []
    for (let index = 0; index < titleParts.length; index += 1) {
      const segmentArtistKey = normalizeArtistName(titleParts[index])
      const known = knownArtists.find((item) => item.artistKey === segmentArtistKey || item.artistKeys?.includes(segmentArtistKey))
      if (known) {
        const remaining = titleParts.filter((_, partIndex) => partIndex !== index).join(' ')
        matches.push({ artist: known.artist, artistKey: known.artistKey, artistKeys: known.artistKeys, title: remaining })
      }
    }
    const distinct = new Map(matches.map((match) => [`${normalizeSongText(match.title)}|${match.artistKey}`, match]))
    if (distinct.size !== 1) return null
    const match = [...distinct.values()][0]
    songTitle = match.title
    artist = { artist: match.artist, artistKey: match.artistKey, artistKeys: match.artistKeys }
  }

  const titleKey = normalizeSongText(stripVersionLabels(songTitle))
  if (!titleKey) return null
  if (!artist?.artistKey) {
    if (!allowTitleOnly) return null
    return { title: stripVersionLabels(songTitle).trim(), titleKey, artist: '', artistKey: '', artistKeys: [] }
  }
  return { title: stripVersionLabels(songTitle).trim(), titleKey, artist: artist.artist.trim(), artistKey: artist.artistKey, artistKeys: artist.artistKeys ?? artistAliases(artist.artist) }
}

export function sameSongIdentity(left, right) {
  if (!left || !right || left.titleKey !== right.titleKey) return false
  const leftArtists = new Set((left.artistKeys?.length ? left.artistKeys : [left.artistKey]).filter(Boolean))
  const rightArtists = (right.artistKeys?.length ? right.artistKeys : [right.artistKey]).filter(Boolean)
  if (!leftArtists.size || !rightArtists.length) return true
  return rightArtists.some((artist) => leftArtists.has(artist))
}

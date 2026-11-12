const INTENT_TERMS = new Set(['official', 'music', 'video', 'videos', 'song', 'songs', 'audio', 'lyrics', 'lyric', 'live', 'concert', 'performance', 'cover', 'covers', 'acoustic', 'remix', 'remixes', 'version', 'versions', 'album', 'discography', 'tracklist'])

const INTENT_PATTERNS = {
  live: /\b(live|concert|tour|performance)\b/i,
  cover: /\b(covers?|cover version)\b/i,
  lyrics: /\b(lyrics?|lyric video)\b/i,
  acoustic: /\b(acoustic|unplugged)\b/i,
  remix: /\b(remix(?:es)?|extended mix|club mix)\b/i,
  album: /\b(album|discography|tracklist)\b/i,
}

const NEGATIVE_PATTERNS = [
  { pattern: /\b(reaction|reacts?|commentary)\b/i, points: 32 },
  { pattern: /\b(interview|podcast|press conference)\b/i, points: 36 },
  { pattern: /\b(celebrity edit|fan edit|fancam|ship edit|slowed edit)\b/i, points: 36 },
  { pattern: /\b(compilation|top \d+|ranking|mashup compilation)\b/i, points: 20 },
  { pattern: /\b(gameplay|tutorial|dance challenge|prank)\b/i, points: 24 },
]

function normalizeChannelText(value) {
  return normalizeMusicText(String(value ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
}

export function normalizeMusicText(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ')
}

function singular(token) {
  return token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token
}

function sameToken(left, right) {
  return left === right || singular(left) === singular(right)
}

export function parseMusicQuery(query) {
  const normalized = normalizeMusicText(query)
  const intents = Object.entries(INTENT_PATTERNS).filter(([, pattern]) => pattern.test(normalized)).map(([intent]) => intent)
  const tokens = normalized.split(' ').filter(Boolean)
  const coreTokens = tokens.filter((token) => !INTENT_TERMS.has(token))
  return {
    original: String(query ?? '').trim(),
    normalized,
    coreTokens,
    coreQuery: coreTokens.join(' '),
    intents,
    kind: intents.includes('album') ? 'artist_album' : coreTokens.length >= 3 ? 'artist_song' : coreTokens.length <= 2 ? 'artist_or_title' : 'music',
  }
}

function hasAny(text, pattern) { return pattern.test(text) }

export function classifyMusicResult(result = {}) {
  const title = normalizeMusicText(result.title)
  const channel = normalizeChannelText(result.channelName)
  const haystack = `${title} ${normalizeMusicText(result.description)}`
  const officialChannel = /\b(vevo|official|records|recordings|topic)\b/.test(channel)
  const officialVideo = /\b(official music video|official video|music video)\b/.test(title)
  const officialAudio = /\b(official audio|audio only|official visualizer)\b/.test(title)
  const lyric = /\b(lyrics?|lyric video)\b/.test(title)
  const live = /\b(live|concert|tour|festival|session)\b/.test(title)
  const acoustic = /\b(acoustic|unplugged)\b/.test(title)
  const cover = /\b(cover|covered by|cover version)\b/.test(title)
  const remix = /\b(remix|re mix|club mix|extended mix)\b/.test(title)
  const shortTitle = /(^|\s)#?shorts?(\s|$)|\b(tiktok|reel|edit clip)\b/.test(title)
  const durationSeconds = Number.isFinite(result.durationSeconds) ? result.durationSeconds : null
  const shortForm = shortTitle || (durationSeconds !== null && durationSeconds <= 60 && /\b(clip|teaser|edit|snippet|challenge)\b/.test(title))

  const contentTags = []
  if (officialVideo) contentTags.push('official_video')
  if (officialAudio) contentTags.push('official_audio')
  if (lyric) contentTags.push('lyrics', ...(officialChannel || /\bofficial\b/.test(title) ? ['official_lyrics'] : []))
  if (live) contentTags.push('live')
  if (acoustic) contentTags.push('acoustic')
  if (cover) contentTags.push('cover')
  if (remix) contentTags.push('remix')

  let contentType = 'music'
  if (officialVideo) contentType = 'official_video'
  else if (officialAudio) contentType = 'official_audio'
  else if (lyric && (officialChannel || /\bofficial\b/.test(title))) contentType = 'official_lyrics'
  else if (lyric) contentType = 'lyrics'
  else if (live) contentType = 'live'
  else if (cover) contentType = 'cover'
  else if (acoustic) contentType = 'acoustic'
  else if (remix) contentType = 'remix'

  const categoryId = String(result.categoryId ?? '')
  const musicRelated = categoryId === '10' || categoryId === 'Music' ||
    contentType !== 'music' || /\b(song|audio|music|live|cover|remix|acoustic|lyrics?)\b/.test(haystack)
  return { contentType, contentTags, musicRelated, officialChannel, isShort: shortForm, durationSeconds }
}

function tokenCoverage(tokens, text) {
  if (!tokens.length) return 1
  const words = normalizeMusicText(text).split(' ').filter(Boolean)
  const matched = tokens.filter((token) => words.some((word) => sameToken(token, word))).length
  return matched / tokens.length
}

export function scoreMusicResult(query, result) {
  const intent = typeof query === 'string' ? parseMusicQuery(query) : query
  const title = normalizeMusicText(result.title)
  const channel = normalizeChannelText(result.channelName)
  const description = normalizeMusicText(result.description)
  const core = intent.coreTokens
  const titleCoverage = tokenCoverage(core, title)
  const channelCoverage = tokenCoverage(core, channel)
  const allTextCoverage = tokenCoverage(core, `${title} ${channel}`)
  const meta = classifyMusicResult(result)
  let score = 0

  if (intent.coreQuery && title.includes(intent.coreQuery)) score += 42
  if (core.length === 1 && titleCoverage === 1) score += 20
  score += Math.round(titleCoverage * 34)
  score += Math.round(channelCoverage * 26)
  if (allTextCoverage < 0.5 && core.length >= 2) score -= 42
  else if (allTextCoverage < 1 && core.length >= 2) score -= Math.round((1 - allTextCoverage) * 16)

  // Channel matching is a useful artist signal, but never enough by itself to
  // overcome a poor title match or a non-music result.
  if (channelCoverage >= 0.75 && core.length >= 1) score += 8
  if (description && core.length) score += Math.round(tokenCoverage(core, description) * 5)

  const typePoints = {
    official_video: 30, official_audio: 27, official_lyrics: 24,
    lyrics: 20, live: 14, acoustic: 10, cover: 7, remix: 7, music: 5,
  }
  score += typePoints[meta.contentType] ?? 0
  if (meta.officialChannel && channelCoverage > 0) score += 7
  if (String(result.categoryId ?? '') === '10') score += 8
  else if (result.categoryId && String(result.categoryId) !== '10') score -= 12

  for (const [name, pattern] of Object.entries(INTENT_PATTERNS)) {
    const requested = intent.intents.includes(name)
    const present = pattern.test(title)
    if (requested) score += present ? 28 : -10
    else if (present && ['live', 'cover', 'remix', 'acoustic'].includes(name)) score -= 3
  }
  for (const negative of NEGATIVE_PATTERNS) if (hasAny(title, negative.pattern)) score -= negative.points

  // Conservative Shorts handling: explicit labels are strongly suppressed.
  // Short duration alone only gets a small penalty, preserving short songs.
  if (meta.isShort) score -= 48
  else if (meta.durationSeconds !== null && meta.durationSeconds <= 45) score -= 6
  else if (meta.durationSeconds !== null && meta.durationSeconds >= 90 && meta.durationSeconds <= 900) score += 4
  else if (meta.durationSeconds !== null && meta.durationSeconds > 1800) score -= 10

  return { score, ...meta, titleCoverage, channelCoverage, queryCoverage: allTextCoverage }
}

function duplicateKey(result) {
  const title = normalizeMusicText(result.title)
    .replace(/\b(official|music|video|audio|hd|4k|visualizer|topic|vevo)\b/g, ' ')
    .replace(/\s+/g, ' ').trim()
  // Alternate performance forms remain separate, while routine upload labels
  // are ignored so mirrored copies of one song collapse to the best candidate.
  return title || String(result.videoId ?? '')
}

export function rankMusicResults(query, results = []) {
  const uniqueIds = new Set()
  const ranked = []
  for (const result of results) {
    if (!result?.videoId || uniqueIds.has(result.videoId)) continue
    uniqueIds.add(result.videoId)
    const ranking = scoreMusicResult(query, result)
    ranked.push({ ...result, ...ranking })
  }
  ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.videoId.localeCompare(b.videoId))

  const seenContent = new Set()
  return ranked.filter((result) => {
    if ((result.contentTags || []).some((tag) => ['live', 'acoustic', 'cover', 'remix'].includes(tag))) return true
    if (['live', 'acoustic', 'cover', 'remix'].includes(result.contentType)) return true
    const key = duplicateKey(result)
    if (!key || seenContent.has(key)) return false
    seenContent.add(key)
    return true
  })
}

export function filterMusicResults(results, filter = 'all') {
  if (!['songs', 'live', 'covers', 'lyrics', 'remixes'].includes(filter)) return results
  return results.filter((result) => {
    const types = new Set(result.contentTags || [result.contentType])
    if (filter === 'songs') return result.musicRelated && !['live', 'cover', 'remix'].some((type) => types.has(type))
    if (filter === 'live') return types.has('live')
    if (filter === 'covers') return types.has('cover')
    if (filter === 'lyrics') return types.has('lyrics') || types.has('official_lyrics')
    return types.has('remix')
  })
}

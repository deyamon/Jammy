const FILTER_TYPES = {
  live: new Set(['live']),
  covers: new Set(['cover']),
  lyrics: new Set(['lyrics', 'official_lyrics']),
  remixes: new Set(['remix']),
}

export function filterYouTubeResults(results, filter = 'all') {
  if (!Array.isArray(results) || filter === 'all') return Array.isArray(results) ? results : []
  const hasType = (result, type) => (result.contentTags || [result.contentType]).includes(type)
  if (filter === 'songs') return results.filter((result) => result.musicRelated && !['live', 'cover', 'remix'].some((type) => hasType(result, type)))
  const types = FILTER_TYPES[filter]
  return types ? results.filter((result) => [...types].some((type) => hasType(result, type))) : results
}

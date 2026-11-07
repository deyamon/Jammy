const STORAGE_PREFIX = 'jammy:recent-searches:'
export const MAX_RECENT_SEARCHES = 8

export function recentSearchStorageKey(userId) {
  return typeof userId === 'string' && userId.trim()
    ? `${STORAGE_PREFIX}${encodeURIComponent(userId.trim())}`
    : ''
}

function normalizeList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const searches = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const query = entry.trim().slice(0, 120)
    const key = query.toLocaleLowerCase()
    if (!query || seen.has(key)) continue
    seen.add(key)
    searches.push(query)
    if (searches.length === MAX_RECENT_SEARCHES) break
  }
  return searches
}

export function readRecentSearches(storage, userId) {
  const key = recentSearchStorageKey(userId)
  if (!key || !storage) return []
  try { return normalizeList(JSON.parse(storage.getItem(key) || '[]')) }
  catch { return [] }
}

export function rememberRecentSearch(storage, userId, value) {
  const key = recentSearchStorageKey(userId)
  const query = typeof value === 'string' ? value.trim().slice(0, 120) : ''
  if (!key || !storage || !query) return readRecentSearches(storage, userId)
  const searches = normalizeList([query, ...readRecentSearches(storage, userId)])
  try { storage.setItem(key, JSON.stringify(searches)) } catch { /* Search still works when browser storage is unavailable. */ }
  return searches
}

export function removeRecentSearch(storage, userId, value) {
  const key = recentSearchStorageKey(userId)
  if (!key || !storage || typeof value !== 'string') return readRecentSearches(storage, userId)
  const target = value.trim().toLocaleLowerCase()
  const searches = readRecentSearches(storage, userId).filter((query) => query.toLocaleLowerCase() !== target)
  try { storage.setItem(key, JSON.stringify(searches)) } catch { /* Search history is a convenience, not a search prerequisite. */ }
  return searches
}

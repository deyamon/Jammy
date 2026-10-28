const apiBase = import.meta.env?.VITE_API_URL?.replace(/\/$/, '') || 'http://localhost:3001'

export async function searchSpotify(query, { signal } = {}) {
  const response = await fetch(`${apiBase}/api/spotify/search?q=${encodeURIComponent(query)}`, { signal })
  let body
  try { body = await response.json() } catch { throw new Error('The Spotify search service returned an unreadable response.') }
  if (!response.ok) throw new Error(body.error || 'Spotify search failed. Try again shortly.')
  return Array.isArray(body.results) ? body.results : []
}

export function spotifyEmbedUrl(trackId) {
  if (typeof trackId !== 'string' || !/^[A-Za-z0-9]+$/.test(trackId)) return null
  return `https://open.spotify.com/embed/track/${encodeURIComponent(trackId)}`
}

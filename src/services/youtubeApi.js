const apiBase = import.meta.env?.VITE_API_URL?.replace(/\/$/, '') || 'http://localhost:3001'

export async function searchYouTube(query, { signal } = {}) {
  const response = await fetch(`${apiBase}/api/youtube/search?q=${encodeURIComponent(query)}`, { signal })
  let body
  try { body = await response.json() } catch { throw new Error('The YouTube search service returned an unreadable response.') }
  if (!response.ok) throw new Error(body.error || 'YouTube search failed. Try again shortly.')
  return Array.isArray(body.results) ? body.results : []
}

export function asYouTubeTrack(result) {
  return {
    id: `youtube:${result.videoId}`,
    provider: 'youtube',
    videoId: result.videoId,
    title: result.title,
    artist: result.channelName,
    channelName: result.channelName,
    album: 'YouTube video',
    duration: '--:--',
    art: 'lime',
    initials: 'YT',
    thumbnails: result.thumbnails ?? {},
    selectionToken: result.selectionToken,
  }
}

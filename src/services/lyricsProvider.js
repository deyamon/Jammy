let configuredProvider = null

// Register only a lyrics source that is authorized to provide the returned text.
export function configureLyricsProvider(provider) {
  if (provider !== null && typeof provider !== 'function') throw new TypeError('Lyrics provider must be a function or null.')
  configuredProvider = provider
}

export async function getTrackLyrics(track) {
  if (!configuredProvider) return { status: 'unavailable' }
  try {
    const result = await configuredProvider(track)
    if (result?.status === 'unavailable') return { status: 'unavailable' }
    if (result?.status === 'available' && result.authorized === true && typeof result.lyrics === 'string' && result.lyrics.trim()) {
      return { status: 'available', lyrics: result.lyrics.trim() }
    }
    if (result?.status === 'error') return { status: 'error', message: 'Lyrics could not be loaded. Try again later.' }
    return { status: 'error', message: 'The lyrics provider returned an invalid response.' }
  } catch {
    return { status: 'error', message: 'Lyrics could not be loaded. Try again later.' }
  }
}

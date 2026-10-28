const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const SEARCH_URL = 'https://api.spotify.com/v1/search'
const CACHE_TTL_MS = 60_000
const MAX_CACHE_ITEMS = 100

export class SpotifyApiError extends Error {
  constructor(status, message, code, retryAfter = null) {
    super(message)
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

export function cleanSpotifyQuery(value) {
  if (typeof value !== 'string') throw new SpotifyApiError(400, 'Enter a Spotify search query.', 'SPOTIFY_QUERY_INVALID')
  const query = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ')
  if (!query || query.length > 100) throw new SpotifyApiError(400, 'Search text must be between 1 and 100 characters.', 'SPOTIFY_QUERY_INVALID')
  return query
}

function normalizeTrack(track) {
  if (typeof track?.id !== 'string' || !track.id || typeof track.name !== 'string') return null
  const album = track.album ?? {}
  const images = Array.isArray(album.images) ? album.images : []
  const artists = Array.isArray(track.artists) ? track.artists.map((artist) => artist.name).filter(Boolean) : []
  const spotifyUrl = track.external_urls?.spotify
  return {
    id: track.id,
    uri: typeof track.uri === 'string' ? track.uri : `spotify:track:${track.id}`,
    title: track.name,
    artist: artists.join(', ') || 'Unknown artist',
    album: typeof album.name === 'string' ? album.name : '',
    durationMs: Number.isFinite(track.duration_ms) ? track.duration_ms : null,
    artwork: images.find((image) => typeof image?.url === 'string')?.url ?? null,
    spotifyUrl: typeof spotifyUrl === 'string' ? spotifyUrl : `https://open.spotify.com/track/${encodeURIComponent(track.id)}`,
    provider: 'spotify',
  }
}

export class SpotifyService {
  constructor({ clientId = process.env.SPOTIFY_CLIENT_ID, clientSecret = process.env.SPOTIFY_CLIENT_SECRET, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.clientId = clientId?.trim() || ''
    this.clientSecret = clientSecret?.trim() || ''
    this.fetchImpl = fetchImpl
    this.now = now
    this.token = null
    this.tokenExpiresAt = 0
    this.cache = new Map()
    this.inFlight = new Map()
  }

  async search(rawQuery) {
    const query = cleanSpotifyQuery(rawQuery)
    if (!this.clientId || !this.clientSecret) {
      throw new SpotifyApiError(503, 'Spotify search is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the project-root .env file, then restart npm run server.', 'SPOTIFY_NOT_CONFIGURED')
    }
    for (const [key, entry] of this.cache) if (entry.expiresAt <= this.now()) this.cache.delete(key)
    const key = query.toLowerCase()
    const cached = this.cache.get(key)
    if (cached?.expiresAt > this.now()) return cached.results
    if (this.inFlight.has(key)) return this.inFlight.get(key)
    const request = this.fetchResults(query).then((results) => {
      this.cache.set(key, { results, expiresAt: this.now() + CACHE_TTL_MS })
      while (this.cache.size > MAX_CACHE_ITEMS) this.cache.delete(this.cache.keys().next().value)
      return results
    }).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, request)
    return request
  }

  async getToken() {
    if (this.token && this.tokenExpiresAt > this.now() + 30_000) return this.token
    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')
    let response
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
      })
    } catch {
      throw new SpotifyApiError(502, 'Spotify authentication could not be reached. Try again shortly.', 'SPOTIFY_AUTH_UNAVAILABLE')
    }
    let body
    try { body = await response.json() } catch { throw new SpotifyApiError(502, 'Spotify returned an unreadable authentication response.', 'SPOTIFY_AUTH_INVALID') }
    if (!response.ok || typeof body.access_token !== 'string') {
      if (response.status === 401 || response.status === 403) throw new SpotifyApiError(503, 'Spotify rejected the server credentials. Check the app Client ID and Client Secret in the developer dashboard.', 'SPOTIFY_CREDENTIALS_REJECTED')
      throw new SpotifyApiError(502, 'Spotify authentication failed. Try again shortly.', 'SPOTIFY_AUTH_FAILED')
    }
    this.token = body.access_token
    this.tokenExpiresAt = this.now() + Math.max(0, Number(body.expires_in) || 3600) * 1000
    return this.token
  }

  async fetchResults(query) {
    if (typeof this.fetchImpl !== 'function') throw new SpotifyApiError(503, 'Spotify search is unavailable on this server.', 'SPOTIFY_UNAVAILABLE')
    const token = await this.getToken()
    const url = new URL(SEARCH_URL)
    url.search = new URLSearchParams({ q: query, type: 'track', limit: '10' }).toString()
    let response
    try { response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }) }
    catch { throw new SpotifyApiError(502, 'Spotify search could not be reached. Try again shortly.', 'SPOTIFY_UPSTREAM_UNAVAILABLE') }
    let body
    try { body = await response.json() } catch { throw new SpotifyApiError(502, 'Spotify returned an unreadable search response.', 'SPOTIFY_UPSTREAM_INVALID') }
    if (!response.ok) {
      if (response.status === 429) {
        const rawRetryAfter = Number(response.headers?.get?.('retry-after'))
        const retryAfter = Number.isFinite(rawRetryAfter) ? rawRetryAfter : null
        throw new SpotifyApiError(429, 'Spotify search is temporarily rate limited. Try again later.', 'SPOTIFY_RATE_LIMITED', retryAfter)
      }
      if (response.status === 401 || response.status === 403) throw new SpotifyApiError(503, 'Spotify denied this search for the configured developer app. Check its current Development Mode eligibility and dashboard access.', 'SPOTIFY_ACCESS_RESTRICTED')
      throw new SpotifyApiError(502, 'Spotify search failed. Try again shortly.', 'SPOTIFY_UPSTREAM_ERROR')
    }
    return (Array.isArray(body.tracks?.items) ? body.tracks.items : []).map(normalizeTrack).filter(Boolean)
  }
}

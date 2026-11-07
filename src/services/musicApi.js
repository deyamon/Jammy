import { getNeonAuthBearerToken } from './authApi.js'
import { searchYouTube } from './youtubeApi.js'

const API_BASE = import.meta.env?.VITE_API_URL?.replace(/\/$/, '') || 'http://localhost:3001'

export class PersonalMusicApiError extends Error {
  constructor(message, { status = 0, code = 'REQUEST_FAILED' } = {}) {
    super(message)
    this.name = 'PersonalMusicApiError'
    this.status = status
    this.code = code
  }
}

export function createPersonalMusicApi({ getBearerToken = getNeonAuthBearerToken, fetchImpl = globalThis.fetch, apiBase = API_BASE } = {}) {
  async function personalRequest(path, { method = 'GET', body, signal } = {}) {
    const token = await getBearerToken()
    let response
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method,
        signal,
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
      })
    } catch (error) {
      if (error.name === 'AbortError') throw error
      throw new PersonalMusicApiError('Jammy could not reach the personal music service. Try again shortly.')
    }
    let payload
    try { payload = await response.json() } catch { throw new PersonalMusicApiError('The personal music service returned an unreadable response.', { status: response.status, code: 'INVALID_RESPONSE' }) }
    if (!response.ok) throw new PersonalMusicApiError(payload.error || 'The personal music request failed.', { status: response.status, code: payload.code })
    return payload
  }

  return {
    request: personalRequest,
    getHome: (options) => personalRequest('/api/music/home', options),
    getTaste: (options) => personalRequest('/api/music/taste', options),
    startSpotifyConnection: () => personalRequest('/api/spotify/connect/start', { method: 'POST' }),
    getSpotifyStatus: (options) => personalRequest('/api/spotify/status', options),
    syncSpotifyData: () => personalRequest('/api/spotify/sync', { method: 'POST' }),
    disconnectSpotify: () => personalRequest('/api/spotify/connection', { method: 'DELETE' }),
    recordPlayback: (event) => personalRequest('/api/music/history', { method: 'POST', body: event }),
  }
}

const personalMusicApi = createPersonalMusicApi()
export const getPersonalMusicHome = personalMusicApi.getHome
export const getPersonalMusicTaste = personalMusicApi.getTaste
export const getSpotifyStatus = personalMusicApi.getSpotifyStatus
export const startSpotifyConnection = personalMusicApi.startSpotifyConnection
export const syncSpotifyData = personalMusicApi.syncSpotifyData
export const disconnectSpotify = personalMusicApi.disconnectSpotify
export const recordJammyPlayback = personalMusicApi.recordPlayback

export async function searchPersonalizedYouTube(query, options) {
  try { return (await personalMusicApi.request(`/api/music/youtube-search?q=${encodeURIComponent(query)}`, options)).results || [] }
  catch (error) {
    if (error.status === 503 || error.code === 'AUTH_UNAVAILABLE' || error.code === 'AUTH_TOKEN_VERIFIER_UNAVAILABLE') return searchYouTube(query, options)
    throw error
  }
}

import { createHmac, timingSafeEqual } from 'node:crypto'

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search'
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const CACHE_TTL_MS = 60_000
const MAX_CACHE_ITEMS = 100
const SELECTION_TTL_MS = 10 * 60 * 1000

function selectionPayload(result) {
  return JSON.stringify({ videoId: result.videoId, title: result.title, channelName: result.channelName, thumbnails: result.thumbnails })
}

export class YouTubeApiError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function cleanYouTubeQuery(value) {
  if (typeof value !== 'string') throw new YouTubeApiError(400, 'Enter a search query.', 'YOUTUBE_QUERY_INVALID')
  const query = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ')
  if (!query || query.length > 100) throw new YouTubeApiError(400, 'Search text must be between 1 and 100 characters.', 'YOUTUBE_QUERY_INVALID')
  return query
}

function resultFrom(item) {
  const videoId = item?.id?.videoId
  if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) return null
  const snippet = item.snippet ?? {}
  const thumbnails = snippet.thumbnails ?? {}
  const thumb = (size) => typeof thumbnails[size]?.url === 'string' ? thumbnails[size].url : null
  return {
    videoId,
    title: typeof snippet.title === 'string' ? snippet.title : 'Untitled video',
    channelName: typeof snippet.channelTitle === 'string' ? snippet.channelTitle : 'YouTube channel',
    thumbnails: { default: thumb('default'), medium: thumb('medium'), high: thumb('high') },
    provider: 'youtube',
  }
}

export class YouTubeService {
  constructor({ apiKey = process.env.YOUTUBE_API_KEY, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.apiKey = apiKey?.trim() || ''
    this.fetchImpl = fetchImpl
    this.now = now
    this.cache = new Map()
    this.inFlight = new Map()
  }

  async search(rawQuery) {
    const query = cleanYouTubeQuery(rawQuery)
    if (!this.apiKey) throw new YouTubeApiError(503, 'YouTube search is not configured. Set YOUTUBE_API_KEY=your_key in the project-root .env file, then restart npm run server. Do not put the key in .env.example or a VITE_ variable.', 'YOUTUBE_NOT_CONFIGURED')
    const cacheKey = query.toLowerCase()
    for (const [key, entry] of this.cache) if (entry.expiresAt <= this.now()) this.cache.delete(key)
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > this.now()) return cached.results
    if (this.inFlight.has(cacheKey)) return this.inFlight.get(cacheKey)

    const request = this.fetchResults(query).then((results) => {
      const signedResults = results.map((result) => this.signSelection(result))
      this.cache.delete(cacheKey)
      const entry = { results: signedResults, expiresAt: this.now() + CACHE_TTL_MS }
      entry.timer = setTimeout(() => { if (this.cache.get(cacheKey) === entry) this.cache.delete(cacheKey) }, CACHE_TTL_MS)
      entry.timer.unref?.()
      this.cache.set(cacheKey, entry)
      while (this.cache.size > MAX_CACHE_ITEMS) this.cache.delete(this.cache.keys().next().value)
      return signedResults
    }).finally(() => this.inFlight.delete(cacheKey))
    this.inFlight.set(cacheKey, request)
    return request
  }

  signSelection(result) {
    const expiresAt = this.now() + SELECTION_TTL_MS
    const signature = createHmac('sha256', this.apiKey).update(`${expiresAt}.${selectionPayload(result)}`).digest('base64url')
    return { ...result, selectionToken: `${expiresAt}.${signature}` }
  }

  verifySelection(result) {
    if (!this.apiKey || !result || typeof result.selectionToken !== 'string') return false
    const [expiryText, signatureText] = result.selectionToken.split('.')
    const expiresAt = Number(expiryText)
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now() || typeof signatureText !== 'string') return false
    const expected = createHmac('sha256', this.apiKey).update(`${expiresAt}.${selectionPayload(result)}`).digest()
    let actual
    try { actual = Buffer.from(signatureText, 'base64url') } catch { return false }
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  async fetchResults(query) {
    if (typeof this.fetchImpl !== 'function') throw new YouTubeApiError(503, 'YouTube search is unavailable on this server.', 'YOUTUBE_UNAVAILABLE')
    const url = new URL(SEARCH_URL)
    url.search = new URLSearchParams({
      part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '12', q: query, key: this.apiKey,
    }).toString()
    let response
    try { response = await this.fetchImpl(url, { headers: { Accept: 'application/json' } }) }
    catch { throw new YouTubeApiError(502, 'YouTube search could not be reached. Try again shortly.', 'YOUTUBE_UPSTREAM_UNAVAILABLE') }

    let body
    try { body = await response.json() }
    catch { throw new YouTubeApiError(502, 'YouTube returned an unreadable response.', 'YOUTUBE_UPSTREAM_INVALID') }
    if (!response.ok) {
      const reasons = (body?.error?.errors ?? []).map((error) => error.reason)
      if (reasons.some((reason) => ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded'].includes(reason))) {
        throw new YouTubeApiError(429, 'YouTube search quota is temporarily unavailable. Try again later.', 'YOUTUBE_QUOTA_EXCEEDED')
      }
      if (response.status === 403) throw new YouTubeApiError(403, 'YouTube denied this search request. Check API key restrictions and Data API access.', 'YOUTUBE_FORBIDDEN')
      throw new YouTubeApiError(502, 'YouTube search failed. Try again shortly.', 'YOUTUBE_UPSTREAM_ERROR')
    }
    const results = (Array.isArray(body.items) ? body.items : []).map(resultFrom).filter(Boolean)
    if (!results.length) return []

    // YouTube's current API policies require checking Made for Kids status before embedding.
    const statusUrl = new URL('https://www.googleapis.com/youtube/v3/videos')
    statusUrl.search = new URLSearchParams({ part: 'status', id: results.map((item) => item.videoId).join(','), key: this.apiKey }).toString()
    let statusResponse
    try { statusResponse = await this.fetchImpl(statusUrl, { headers: { Accept: 'application/json' } }) }
    catch { throw new YouTubeApiError(502, 'YouTube video eligibility could not be checked. Try again shortly.', 'YOUTUBE_UPSTREAM_UNAVAILABLE') }
    let statusBody
    try { statusBody = await statusResponse.json() }
    catch { throw new YouTubeApiError(502, 'YouTube returned an unreadable video status response.', 'YOUTUBE_UPSTREAM_INVALID') }
    if (!statusResponse.ok) {
      const reasons = (statusBody?.error?.errors ?? []).map((error) => error.reason)
      if (reasons.some((reason) => ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded'].includes(reason))) {
        throw new YouTubeApiError(429, 'YouTube search quota is temporarily unavailable. Try again later.', 'YOUTUBE_QUOTA_EXCEEDED')
      }
      throw new YouTubeApiError(statusResponse.status === 403 ? 403 : 502, 'YouTube video eligibility could not be checked. Try again shortly.', 'YOUTUBE_STATUS_CHECK_FAILED')
    }
    const eligible = new Set((Array.isArray(statusBody.items) ? statusBody.items : [])
      .filter((item) => item.status?.madeForKids === false && item.status?.embeddable === true)
      .map((item) => item.id))
    return results.filter((item) => eligible.has(item.videoId))
  }
}

export const isYouTubeVideoId = (value) => typeof value === 'string' && VIDEO_ID.test(value)

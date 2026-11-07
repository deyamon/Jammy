const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302']

function urlsFrom(value, allowedSchemes, variableName) {
  const urls = String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
  if (urls.some((url) => !allowedSchemes.some((scheme) => url.toLowerCase().startsWith(`${scheme}:`)))) {
    throw new Error(`${variableName} contains an unsupported ICE URL.`)
  }
  return urls
}

export function getVoiceIceServers(environment = process.env) {
  const stunUrls = environment.VOICE_STUN_URLS === undefined
    ? DEFAULT_STUN_URLS
    : urlsFrom(environment.VOICE_STUN_URLS, ['stun', 'stuns'], 'VOICE_STUN_URLS')
  const iceServers = stunUrls.length ? [{ urls: stunUrls }] : []
  const turnUrls = urlsFrom(environment.VOICE_TURN_URLS, ['turn', 'turns'], 'VOICE_TURN_URLS')
  const username = environment.VOICE_TURN_USERNAME?.trim() ?? ''
  const credential = environment.VOICE_TURN_CREDENTIAL ?? ''
  if (turnUrls.length && (!username || !credential)) {
    throw new Error('VOICE_TURN_USERNAME and VOICE_TURN_CREDENTIAL are required when VOICE_TURN_URLS is configured.')
  }
  if (!turnUrls.length && (username || credential)) {
    throw new Error('VOICE_TURN_URLS is required when TURN credentials are configured.')
  }
  if (turnUrls.length) iceServers.push({ urls: turnUrls, username, credential })
  return iceServers
}

const CLOUDFLARE_TURN_TTL_SECONDS = 24 * 60 * 60
const CLOUDFLARE_REFRESH_MS = 12 * 60 * 60 * 1000

// Cloudflare Realtime TURN issues short-lived credentials from a key ID + API token.
// https://developers.cloudflare.com/realtime/turn/generate-credentials/
function cloudflareTurnConfig(environment) {
  const keyId = environment.VOICE_CLOUDFLARE_TURN_KEY_ID?.trim() ?? ''
  const apiToken = environment.VOICE_CLOUDFLARE_TURN_API_TOKEN?.trim() ?? ''
  if (!keyId && !apiToken) return null
  if (!keyId || !apiToken) throw new Error('VOICE_CLOUDFLARE_TURN_KEY_ID and VOICE_CLOUDFLARE_TURN_API_TOKEN must be set together.')
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(keyId)) throw new Error('VOICE_CLOUDFLARE_TURN_KEY_ID is not a valid TURN key ID.')
  return { keyId, apiToken }
}

function sanitizeIceServers(value) {
  if (!Array.isArray(value)) return []
  return value.flatMap((server) => {
    const urls = (Array.isArray(server?.urls) ? server.urls : [server?.urls])
      .filter((url) => typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url))
      // Port 53 is often blocked by browsers/networks; Cloudflare recommends skipping it.
      .filter((url) => !/:53(\?|$)/.test(url))
    if (!urls.length) return []
    const entry = { urls }
    if (typeof server.username === 'string') entry.username = server.username
    if (typeof server.credential === 'string') entry.credential = server.credential
    return [entry]
  })
}

/**
 * Returns a function that resolves the ICE servers to hand to a joining client.
 * Static STUN/TURN from env is always included; Cloudflare TURN credentials are
 * fetched lazily, cached, and refreshed before they expire. If Cloudflare is
 * unreachable the static servers are still returned so voice keeps working on
 * networks that don't need a relay.
 */
export function createVoiceIceServerProvider(environment = process.env, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const staticServers = getVoiceIceServers(environment)
  const cloudflare = cloudflareTurnConfig(environment)
  if (!cloudflare) return async () => staticServers
  let cached = null
  let cachedAt = 0
  let pending = null
  const refresh = async () => {
    const response = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cloudflare.keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cloudflare.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: CLOUDFLARE_TURN_TTL_SECONDS }),
      signal: AbortSignal.timeout?.(5000),
    })
    if (!response.ok) throw new Error(`Cloudflare TURN returned HTTP ${response.status}.`)
    const servers = sanitizeIceServers((await response.json())?.iceServers)
    if (!servers.length) throw new Error('Cloudflare TURN returned no ICE servers.')
    cached = servers
    cachedAt = now()
    return servers
  }
  return async () => {
    if (!cached || now() - cachedAt > CLOUDFLARE_REFRESH_MS) {
      pending ??= refresh().finally(() => { pending = null })
      try { await pending } catch (error) {
        console.error('Could not refresh voice TURN credentials:', error.message)
      }
    }
    return cached ? [...staticServers, ...cached] : staticServers
  }
}

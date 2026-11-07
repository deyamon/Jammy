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

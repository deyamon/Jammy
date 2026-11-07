export function homeMusicErrorMessage(error) {
  if (error?.code === 'AUTH_REQUIRED' || error?.code === 'AUTH_SESSION_INVALID' || error?.code === 'AUTH_SESSION_EXPIRED') {
    return 'Your Neon Auth session is invalid or expired. Sign in again to continue.'
  }
  if (error?.code === 'AUTH_TOKEN_UNAVAILABLE' || error?.code === 'AUTH_TOKEN_ISSUER_MISMATCH' || error?.code === 'AUTH_TOKEN_AUDIENCE_MISMATCH' || error?.code === 'AUTH_TOKEN_SIGNING_KEY_MISMATCH') {
    return 'Jammy received a Neon Auth token it could not verify. Refresh the page; if this continues, the app’s Neon Auth branch configuration needs attention.'
  }
  if (error?.code === 'AUTH_TOKEN_SERVICE_UNAVAILABLE') return 'Jammy could not reach Neon Auth to verify your session. Check your connection and try again; your session has not been cleared.'
  if (error?.code === 'AUTH_TOKEN_VERIFIER_UNAVAILABLE') return 'Jammy could not reach the Neon Auth token verifier. Check the server’s Neon Auth JWKS configuration and try again.'
  if (error?.code === 'MUSIC_MIGRATION_REQUIRED') return 'Jammy listening history is unavailable until database migrations 0001–0004 are applied to the configured database.'
  if (error?.code === 'MUSIC_STORAGE_UNAVAILABLE') return 'Jammy listening history is unavailable until PostgreSQL is configured and the required migrations are applied.'
  if (error?.status >= 500) return 'Jammy could not load your listening history because the server is having trouble. Try again shortly.'
  if (error?.status === 0) return error.message || 'Jammy could not reach the personal music service. Check your connection and try again.'
  return error?.message || 'Jammy could not load your listening history. Try again.'
}

export function spotifyActionErrorMessage(error) {
  if (error?.code === 'SPOTIFY_NOT_CONFIGURED') return 'Spotify Connect is not configured on Jammy’s server. Add SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI, and SPOTIFY_TOKEN_ENCRYPTION_KEY to the server environment, then restart the backend.'
  if (error?.code === 'MUSIC_MIGRATION_REQUIRED') return 'Spotify Connect needs database migrations 0001–0004. Confirm the target database, apply the migrations deliberately, then retry.'
  if (error?.code === 'MUSIC_STORAGE_UNAVAILABLE') return 'Spotify Connect needs PostgreSQL configured on Jammy’s server before it can start.'
  if (error?.code === 'AUTH_TOKEN_VERIFIER_UNAVAILABLE') return 'Jammy could not reach the Neon Auth token verifier. Check the server’s Neon Auth JWKS configuration and try again.'
  if (error?.code === 'AUTH_TOKEN_ISSUER_MISMATCH' || error?.code === 'AUTH_TOKEN_AUDIENCE_MISMATCH' || error?.code === 'AUTH_TOKEN_SIGNING_KEY_MISMATCH' || error?.code === 'AUTH_TOKEN_UNAVAILABLE') return 'Jammy received a Neon Auth token it could not verify for Spotify Connect. Refresh the page; if this continues, the app’s Neon Auth branch configuration needs attention.'
  if (error?.code === 'AUTH_SESSION_INVALID' || error?.code === 'AUTH_SESSION_EXPIRED' || error?.code === 'AUTH_REQUIRED') return 'Your Neon Auth session is invalid or expired. Sign in again before connecting Spotify.'
  if (error?.code === 'AUTH_TOKEN_SERVICE_UNAVAILABLE') return 'Jammy could not reach Neon Auth to verify your session. Check your connection and try again.'
  if (error?.status >= 500) return 'Jammy could not start Spotify Connect because the server is having trouble. Try again shortly.'
  return error?.message || 'Jammy could not start Spotify Connect. Try again.'
}

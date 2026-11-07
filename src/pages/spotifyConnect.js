export async function connectAndRedirectToSpotify({ startRequest, redirect }) {
  const result = await startRequest()
  let target
  try { target = new URL(result?.authorizationUrl) } catch {
    throw new Error('Jammy received an invalid Spotify authorization link. Try again or contact support.')
  }
  if (target.protocol !== 'https:' || target.origin !== 'https://accounts.spotify.com' || target.pathname !== '/authorize') {
    throw new Error('Jammy received an invalid Spotify authorization link. Try again or contact support.')
  }
  redirect(target.href)
}

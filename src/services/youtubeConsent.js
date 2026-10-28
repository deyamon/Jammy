const CONSENT_KEY = 'jammy.youtube-api-consent.v1'

export function hasYouTubeConsent() {
  try { return window.localStorage.getItem(CONSENT_KEY) === 'accepted' } catch { return false }
}

export function acceptYouTubeNotice() {
  try { window.localStorage.setItem(CONSENT_KEY, 'accepted'); return true } catch { return false }
}

export function shouldSkipUnavailableAutoplayTrack({ isHost, track, playback, status, attemptedToken }) {
  return Boolean(isHost
    && track?.provider === 'youtube'
    && playback?.currentTrackIsAutoplay === true
    && ['error', 'unavailable'].includes(status)
    && typeof playback.currentTrackId === 'string'
    && typeof playback.playbackToken === 'string'
    && playback.playbackToken !== attemptedToken)
}

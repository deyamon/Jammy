export function getRoomProgressState(track, { youtubeState, audioState }) {
  const state = track?.provider === 'youtube' ? youtubeState : audioState
  const duration = Number.isFinite(state?.duration) && state.duration > 0 ? state.duration : 0
  const rawTime = Number.isFinite(state?.currentTime) && state.currentTime > 0 ? state.currentTime : 0
  return {
    duration,
    currentTime: duration ? Math.min(rawTime, duration) : rawTime,
    status: state?.status || 'ready',
  }
}

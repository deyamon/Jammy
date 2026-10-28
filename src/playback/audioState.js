export const initialAudioState = Object.freeze({
  status: 'idle',
  currentTime: 0,
  duration: 0,
  volume: 0.72,
  muted: false,
  error: '',
})

export function clampVolume(volume) {
  const numeric = Number(volume)
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 0
}

export function volumeFromSliderValue(value) {
  return clampVolume(Number(value) / 100)
}

export function sliderValueFromVolume(volume) {
  return Math.round(clampVolume(volume) * 100)
}

export function applyAudioVolume(audio, volume, muted = audio?.muted) {
  if (!audio) return
  audio.volume = clampVolume(volume)
  audio.muted = Boolean(muted)
}

export function applyAudioMute(audio, muted) {
  if (audio) audio.muted = Boolean(muted)
}

export function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const wholeSeconds = Math.floor(seconds)
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, '0')}`
}

export function audioStateReducer(state, event) {
  switch (event.type) {
    case 'LOAD_START':
      return { ...state, status: 'loading', currentTime: 0, duration: 0, error: '' }
    case 'UNAVAILABLE':
      return { ...state, status: 'unavailable', currentTime: 0, duration: 0, error: event.message }
    case 'METADATA':
      return { ...state, status: state.status === 'playing' ? 'playing' : 'ready', duration: Number.isFinite(event.duration) ? event.duration : 0, error: '' }
    case 'TIME_UPDATE':
      return { ...state, currentTime: Number.isFinite(event.currentTime) ? Math.max(0, event.currentTime) : 0 }
    case 'PLAY':
      return { ...state, status: 'playing', error: '' }
    case 'PAUSE':
      return { ...state, status: state.duration > 0 ? 'paused' : state.status }
    case 'WAITING':
      return state.status === 'playing' ? { ...state, status: 'loading' } : state
    case 'CAN_PLAY':
      return { ...state, status: state.status === 'playing' ? 'playing' : 'ready', error: '' }
    case 'ERROR':
      return { ...state, status: 'error', error: event.message || 'This audio file could not be loaded.' }
    case 'PLAY_REJECTED':
      return { ...state, status: 'paused', error: event.message || 'Your browser blocked playback. Press Play to allow audio.' }
    case 'SET_VOLUME':
      return { ...state, volume: clampVolume(event.volume) }
    case 'TOGGLE_MUTE':
      return { ...state, muted: !state.muted }
    case 'SET_MUTE':
      return { ...state, muted: Boolean(event.muted) }
    default:
      return state
  }
}

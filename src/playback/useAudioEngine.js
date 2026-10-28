import { useCallback, useEffect, useReducer, useRef } from 'react'
import { audioStateReducer, initialAudioState, clampVolume, applyAudioMute, applyAudioVolume } from './audioState.js'
import { getAudioSource } from './audioSources.js'

function unavailableMessageFor(trackId) {
  if (trackId === 'local-audio-demo') return 'Add an authorized file at public/audio/ and set VITE_JAMMY_DEMO_AUDIO_URL.'
  return 'This sample track has no authorized audio source. Configure the Local audio demo or choose a track with audio.'
}

function playbackError(audio) {
  if (audio.error?.code === 4) return 'This audio format or file could not be played.'
  if (audio.error?.code === 2) return 'The audio file could not be reached. Check the local file path.'
  return 'This audio file could not be loaded.'
}

export function useAudioEngine({ track, roomActive = false, sharedPlayback = null, onEnded }) {
  const audioRef = useRef(null)
  const [state, dispatch] = useReducer(audioStateReducer, initialAudioState)
  const stateRef = useRef(state)
  const sourceRef = useRef({ trackId: null, url: null })
  const autoplayOnLoadRef = useRef(false)
  const endedCallbackRef = useRef(onEnded)
  const roomActiveRef = useRef(roomActive)
  const sharedPlaybackRef = useRef(sharedPlayback)
  const trackIdRef = useRef(track?.id)
  const sourceUrl = getAudioSource(track?.id)

  stateRef.current = state
  endedCallbackRef.current = onEnded
  roomActiveRef.current = roomActive
  sharedPlaybackRef.current = sharedPlayback
  trackIdRef.current = track?.id

  const play = useCallback(async () => {
    const audio = audioRef.current
    if (!audio) return false
    if (!getAudioSource(track?.id)) {
      dispatch({ type: 'UNAVAILABLE', message: unavailableMessageFor(track?.id) })
      return false
    }
    try {
      await audio.play()
      return true
    } catch (error) {
      dispatch({
        type: 'PLAY_REJECTED',
        message: error?.name === 'NotAllowedError'
          ? 'Your browser blocked playback. Press Play in this tab to allow audio.'
          : 'Playback could not start. Check that your audio file can be played by this browser.',
      })
      return false
    }
  }, [track?.id])

  const pause = useCallback(() => audioRef.current?.pause(), [])

  const seek = useCallback((seconds) => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(seconds)) return
    try {
      audio.currentTime = Math.max(0, Math.min(seconds, Number.isFinite(audio.duration) ? audio.duration : seconds))
      dispatch({ type: 'TIME_UPDATE', currentTime: audio.currentTime })
    } catch { /* Metadata is not ready yet; the slider becomes active after it loads. */ }
  }, [])

  const setVolume = useCallback((value) => {
    const volume = clampVolume(value)
    if (audioRef.current) applyAudioVolume(audioRef.current, volume, stateRef.current.muted)
    dispatch({ type: 'SET_VOLUME', volume })
  }, [])

  const toggleMute = useCallback(() => {
    const muted = !stateRef.current.muted
    applyAudioMute(audioRef.current, muted)
    dispatch({ type: 'SET_MUTE', muted })
  }, [])

  const requestAutoplayOnSelection = useCallback(() => {
    autoplayOnLoadRef.current = true
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return undefined

    applyAudioVolume(audio, stateRef.current.volume, stateRef.current.muted)
    const applySharedPlayback = () => {
      const shared = sharedPlaybackRef.current
      if (!roomActiveRef.current || !shared || shared.currentTrackId !== trackIdRef.current) return
      if (Number.isFinite(shared.positionMs) && Number.isFinite(audio.duration)) {
        const position = Math.min(shared.positionMs / 1000, audio.duration)
        if (Math.abs(audio.currentTime - position) > 1.2) audio.currentTime = position
      }
      if (shared.isPlaying && audio.paused) {
        void audio.play().catch(() => dispatch({ type: 'PLAY_REJECTED', message: 'Your browser blocked playback started by the room. Press Play in this tab to allow audio.' }))
      } else if (!shared.isPlaying && !audio.paused) audio.pause()
    }
    const onLoadedMetadata = () => { dispatch({ type: 'METADATA', duration: audio.duration }); applySharedPlayback() }
    const onTimeUpdate = () => dispatch({ type: 'TIME_UPDATE', currentTime: audio.currentTime })
    const onPlay = () => dispatch({ type: 'PLAY' })
    const onPause = () => dispatch({ type: 'PAUSE' })
    const onWaiting = () => dispatch({ type: 'WAITING' })
    const onCanPlay = () => dispatch({ type: 'CAN_PLAY' })
    const onError = () => dispatch({ type: 'ERROR', message: playbackError(audio) })
    const onEndedEvent = () => {
      dispatch({ type: 'PAUSE' })
      endedCallbackRef.current?.()
    }

    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('durationchange', onLoadedMetadata)
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('canplay', onCanPlay)
    audio.addEventListener('error', onError)
    audio.addEventListener('ended', onEndedEvent)
    return () => {
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('durationchange', onLoadedMetadata)
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('canplay', onCanPlay)
      audio.removeEventListener('error', onError)
      audio.removeEventListener('ended', onEndedEvent)
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || sourceRef.current.trackId === track?.id && sourceRef.current.url === sourceUrl) return
    audio.pause()
    sourceRef.current = { trackId: track?.id ?? null, url: sourceUrl }

    if (!sourceUrl) {
      autoplayOnLoadRef.current = false
      audio.removeAttribute('src')
      audio.load()
      dispatch({ type: 'UNAVAILABLE', message: unavailableMessageFor(track?.id) })
      return
    }

    dispatch({ type: 'LOAD_START' })
    audio.src = sourceUrl
    audio.load()
    if (autoplayOnLoadRef.current) {
      const startWhenReady = () => {
        autoplayOnLoadRef.current = false
        void audio.play().catch(() => dispatch({ type: 'PLAY_REJECTED', message: 'The next track could not start automatically.' }))
      }
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) startWhenReady()
      else audio.addEventListener('canplay', startWhenReady, { once: true })
    }
  }, [track?.id, sourceUrl])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    applyAudioVolume(audio, state.volume, state.muted)
  }, [state.volume, state.muted])

  useEffect(() => {
    const audio = audioRef.current
    if (!roomActive || !audio || !sharedPlayback || sharedPlayback.currentTrackId !== track?.id || !sourceUrl) return
    if (Number.isFinite(sharedPlayback.positionMs)) {
      const difference = Math.abs(audio.currentTime * 1000 - sharedPlayback.positionMs)
      if (difference > 1200) seek(sharedPlayback.positionMs / 1000)
    }
    if (sharedPlayback.isPlaying && audio.paused) void play()
    else if (!sharedPlayback.isPlaying && !audio.paused) audio.pause()
  }, [roomActive, sharedPlayback?.updatedAt, sharedPlayback?.isPlaying, sharedPlayback?.positionMs, sharedPlayback?.currentTrackId, track?.id, sourceUrl, play, seek])

  return { audioRef, state, play, pause, seek, setVolume, toggleMute, requestAutoplayOnSelection }
}

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { isRoomCommandEcho } from './roomCommandGuard.js'
import { applyRoomPlaybackCommand, playYouTubeFromUserGesture, restoreYouTubePlayback } from './youtubeCommands.js'
import { isValidYouTubeVideoId } from './soloYouTubePlayback.js'

let apiPromise
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (apiPromise) return apiPromise
  apiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.()
      if (window.YT?.Player) resolve(window.YT)
      else reject(new Error('YouTube player API did not initialize.'))
    }
    let script = document.querySelector('script[src="https://www.youtube.com/iframe_api"]')
    if (!script) {
      script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      script.async = true
      script.onerror = () => reject(new Error('YouTube player API could not be loaded.'))
      document.head.appendChild(script)
    }
  }).catch((error) => { apiPromise = null; throw error })
  return apiPromise
}

const unavailable = {
  2: 'YouTube rejected this video ID.',
  5: 'This video cannot be played in the embedded player.',
  100: 'This video is unavailable or private.',
  101: 'The owner does not allow this video to play in Jammy.',
  150: 'The owner does not allow this video to play in Jammy.',
}

const YoutubeEmbed = forwardRef(function YoutubeEmbed({ track, sharedPlayback, onState, onEnded, autoplayOnReady = false, startAtSeconds = 0, resumeAtSeconds, resumePlaying, placement = 'inline' }, ref) {
  const mountRef = useRef(null)
  const playerRef = useRef(null)
  const playerReadyRef = useRef(false)
  const suppressEventsRef = useRef(false)
  const remoteCommandRef = useRef(null)
  const lastVideoIdRef = useRef(null)
  const playbackObserverRef = useRef(null)
  const pendingPlayRef = useRef(false)
  const pendingRestoreRef = useRef(null)
  const handlersRef = useRef({ onState, onEnded })
  const sharedPlaybackRef = useRef(sharedPlayback)
  handlersRef.current = {
    onState: (state) => onState?.({ ...state, provider: 'youtube', trackId: track?.id }),
    onEnded,
  }
  sharedPlaybackRef.current = sharedPlayback
  const videoId = track?.provider === 'youtube' && isValidYouTubeVideoId(track.videoId) ? track.videoId : null

  useEffect(() => {
    if (track?.provider === 'youtube' && !isValidYouTubeVideoId(track.videoId)) {
      handlersRef.current.onState?.({ status: 'error', error: 'This YouTube video is missing a valid video ID and cannot be played.' })
    }
  }, [track?.id, track?.provider, track?.videoId])

  const cancelPendingPlay = () => {
    pendingPlayRef.current = false
    playbackObserverRef.current?.disconnect?.()
    playbackObserverRef.current = null
  }
  const requestPlayerPlay = (player) => {
    if (!player) return false
    pendingPlayRef.current = true
    const iframe = player.getIframe?.()
    const isMoreThanHalfVisible = () => {
      const rect = iframe?.getBoundingClientRect?.()
      if (!rect || rect.width <= 0 || rect.height <= 0) return false
      const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0))
      const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0))
      return (visibleWidth * visibleHeight) / (rect.width * rect.height) > 0.5
    }
    if (isMoreThanHalfVisible()) {
      cancelPendingPlay()
      player.playVideo?.()
      return true
    }
    playbackObserverRef.current?.disconnect?.()
    if (iframe && typeof IntersectionObserver !== 'undefined') {
      playbackObserverRef.current = new IntersectionObserver((entries) => {
        const visible = entries.some((entry) => entry.target === iframe && entry.intersectionRatio > 0.5)
        if (!visible || !pendingPlayRef.current || playerRef.current !== player) return
        cancelPendingPlay()
        player.playVideo?.()
      }, { threshold: [0, 0.5, 1] })
      playbackObserverRef.current.observe(iframe)
    }
    handlersRef.current.onState?.({ status: 'paused', error: 'Scroll the official YouTube player into view to start playback.' })
    return false
  }

  useImperativeHandle(ref, () => ({
    canControl: () => Boolean(playerReadyRef.current && playerRef.current),
    play: () => requestPlayerPlay(playerRef.current),
    playFromUserGesture: () => {
      const player = playerRef.current
      if (!player || !playerReadyRef.current) return false
      cancelPendingPlay()
      return playYouTubeFromUserGesture(player)
    },
    pause: () => { cancelPendingPlay(); playerRef.current?.pauseVideo?.() },
    applyRoomCommand: ({ isPlaying, positionMs }) => {
      const player = playerRef.current
      if (!player || !playerReadyRef.current) return false
      const desiredPlaying = Boolean(isPlaying)
      remoteCommandRef.current = { isPlaying: desiredPlaying, expiresAt: Date.now() + 60_000 }
      suppressEventsRef.current = true
      cancelPendingPlay()
      applyRoomPlaybackCommand(player, { isPlaying: desiredPlaying, positionMs })
      window.setTimeout(() => { suppressEventsRef.current = false }, 900)
      return true
    },
    seek: (seconds) => playerRef.current?.seekTo?.(Math.max(0, seconds), true),
    setVolume: (volume) => playerRef.current?.setVolume?.(Math.max(0, Math.min(100, volume))),
    getCurrentTime: () => playerRef.current?.getCurrentTime?.() ?? 0,
    getIsPlaying: () => playerRef.current?.getPlayerState?.() === window.YT?.PlayerState?.PLAYING,
    restorePlayback: (snapshot) => {
      if (!snapshot || !Number.isFinite(snapshot.position)) return false
      const player = playerRef.current
      if (!player || !playerReadyRef.current) {
        pendingRestoreRef.current = snapshot
        return true
      }
      cancelPendingPlay()
      return restoreYouTubePlayback(player, snapshot)
    },
    suspend: () => {
      const player = playerRef.current
      if (!player || !playerReadyRef.current) return null
      const snapshot = {
        currentTime: player.getCurrentTime?.() ?? 0,
        duration: player.getDuration?.() ?? 0,
        isPlaying: player.getPlayerState?.() === window.YT?.PlayerState?.PLAYING,
      }
      suppressEventsRef.current = true
      cancelPendingPlay()
      player.pauseVideo?.()
      window.setTimeout(() => { suppressEventsRef.current = false }, 1000)
      return snapshot
    },
    getVolume: () => playerRef.current?.getVolume?.(),
    mute: () => playerRef.current?.mute?.(),
    unMute: () => playerRef.current?.unMute?.(),
    isMuted: () => Boolean(playerRef.current?.isMuted?.()),
    toggle: () => {
      const state = playerRef.current?.getPlayerState?.()
      if (state === window.YT?.PlayerState?.PLAYING) { cancelPendingPlay(); playerRef.current.pauseVideo() }
      else requestPlayerPlay(playerRef.current)
    },
  }), [])

  useEffect(() => {
    if (!videoId || !mountRef.current) return undefined
    let disposed = false
    let pollId
    handlersRef.current.onState?.({ status: 'loading', currentTime: 0, duration: 0, error: '' })
    loadYouTubeApi().then((YT) => {
      if (disposed || !mountRef.current) return
      const player = new YT.Player(mountRef.current, {
        width: 480,
        height: 270,
        videoId,
        playerVars: { controls: 1, playsinline: 1, origin: window.location.origin },
        events: {
          onReady: (event) => {
            playerRef.current = event.target
            playerReadyRef.current = true
            lastVideoIdRef.current = videoId
            const shared = sharedPlaybackRef.current
            const pendingRestore = pendingRestoreRef.current
            let visibleForPlayback = true
            if (pendingRestore?.trackId === track.id) {
              pendingRestoreRef.current = null
              restoreYouTubePlayback(event.target, pendingRestore)
            } else if (shared?.currentTrackId === track.id && shared.updatedAt) {
              lastRoomUpdateRef.current = shared.updatedAt
              const shouldPlay = typeof resumePlaying === 'boolean' ? resumePlaying : Boolean(shared.isPlaying)
              const startAt = Number.isFinite(resumeAtSeconds) ? resumeAtSeconds : shared.positionMs / 1000
              remoteCommandRef.current = { isPlaying: shouldPlay, expiresAt: Date.now() + 60_000 }
              if (Number.isFinite(startAt) && startAt > 0) event.target.seekTo(startAt, true)
              if (shouldPlay) { cancelPendingPlay(); playYouTubeFromUserGesture(event.target) }
              else { cancelPendingPlay(); event.target.pauseVideo() }
            } else {
              const startAt = Number.isFinite(startAtSeconds) ? Math.max(0, startAtSeconds) : 0
              if (startAt > 0) event.target.seekTo(startAt, true)
              if (autoplayOnReady) visibleForPlayback = requestPlayerPlay(event.target)
            }
            handlersRef.current.onState?.({ status: 'ready', currentTime: event.target.getCurrentTime?.() || startAtSeconds || 0, duration: event.target.getDuration?.() || 0, volume: event.target.getVolume?.() ?? 72, muted: Boolean(event.target.isMuted?.()), error: visibleForPlayback ? '' : 'Scroll the official YouTube player into view to start playback.' })
          },
          onStateChange: (event) => {
            const states = YT.PlayerState
            const status = event.data === states.PLAYING ? 'playing'
              : event.data === states.BUFFERING ? 'loading'
                : event.data === states.PAUSED ? 'paused'
                  : event.data === states.ENDED ? 'ended' : 'ready'
            handlersRef.current.onState?.({ status, currentTime: event.target.getCurrentTime?.() || 0, duration: event.target.getDuration?.() || 0, volume: event.target.getVolume?.() ?? 72, muted: Boolean(event.target.isMuted?.()), error: '' })
            if (event.data === states.ENDED) handlersRef.current.onEnded?.()
            const remote = remoteCommandRef.current
            const remoteMatches = isRoomCommandEcho(remote, status)
            if (remote && !remoteMatches) remoteCommandRef.current = null
            if (!suppressEventsRef.current && !remoteMatches && (event.data === states.PLAYING || event.data === states.PAUSED)) {
              handlersRef.current.onState?.({ status, currentTime: event.target.getCurrentTime?.() || 0, duration: event.target.getDuration?.() || 0, userInitiated: true })
            }
          },
          onError: (event) => handlersRef.current.onState?.({ status: 'error', currentTime: 0, duration: 0, error: unavailable[event.data] || `YouTube player error (${event.data}).` }),
          onAutoplayBlocked: () => handlersRef.current.onState?.({ status: 'paused', error: 'Your browser blocked playback. Press Play inside the YouTube player or Jammy controls.' }),
        },
      })
      playerRef.current = player
      pollId = window.setInterval(() => {
        const active = playerRef.current
        if (active?.getPlayerState?.() === YT.PlayerState.PLAYING) handlersRef.current.onState?.({
          status: 'playing', currentTime: active.getCurrentTime?.() || 0, duration: active.getDuration?.() || 0,
          volume: active.getVolume?.() ?? 72, muted: Boolean(active.isMuted?.()),
        })
      }, 1000)
    }).catch((error) => handlersRef.current.onState?.({ status: 'error', error: error?.message || 'The YouTube player could not be initialized. Try selecting the video again.' }))
    return () => {
      disposed = true
      window.clearInterval(pollId)
      cancelPendingPlay()
      playerRef.current?.destroy?.()
      playerRef.current = null
      playerReadyRef.current = false
      lastVideoIdRef.current = null
      pendingRestoreRef.current = null
    }
  }, [videoId])

  useEffect(() => {
    const player = playerRef.current
    if (!player || !playerReadyRef.current || !videoId || lastVideoIdRef.current === videoId) return
    suppressEventsRef.current = true
    lastVideoIdRef.current = videoId
    player.cueVideoById(videoId)
    if (!sharedPlaybackRef.current && autoplayOnReady) requestPlayerPlay(player)
    window.setTimeout(() => { suppressEventsRef.current = false }, 900)
  }, [videoId])

  const lastRoomUpdateRef = useRef(null)
  useEffect(() => {
    const player = playerRef.current
    if (!player || !playerReadyRef.current || !sharedPlayback || sharedPlayback.currentTrackId !== track?.id || !sharedPlayback.updatedAt || sharedPlayback.updatedAt === lastRoomUpdateRef.current) return
    lastRoomUpdateRef.current = sharedPlayback.updatedAt
    suppressEventsRef.current = true
    remoteCommandRef.current = { isPlaying: Boolean(sharedPlayback.isPlaying), expiresAt: Date.now() + 60_000 }
    const currentTime = player.getCurrentTime?.() || 0
    if (Number.isFinite(sharedPlayback.positionMs) && Math.abs(currentTime - sharedPlayback.positionMs / 1000) > 1) player.seekTo(Math.max(0, sharedPlayback.positionMs / 1000), true)
    if (sharedPlayback.isPlaying) { cancelPendingPlay(); player.playVideo?.() }
    else { cancelPendingPlay(); player.pauseVideo() }
    window.setTimeout(() => { suppressEventsRef.current = false }, 900)
  }, [sharedPlayback?.updatedAt, sharedPlayback?.isPlaying, sharedPlayback?.positionMs, sharedPlayback?.currentTrackId, track?.id])

  if (!videoId) return null
  return <div className={`youtube-player-dock youtube-player-${placement}`} aria-label="YouTube video player"><div className="youtube-player-heading"><span>YouTube player</span><a href={`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`} target="_blank" rel="noreferrer">Open on YouTube ↗</a></div><div className="youtube-player-viewport" ref={mountRef}/></div>
})

export default YoutubeEmbed

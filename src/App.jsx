import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from './components/Icon.jsx'
import Sidebar from './components/Sidebar.jsx'
import MusicPlayer from './components/MusicPlayer.jsx'
import RoomDialog from './components/RoomDialog.jsx'
import SearchPage from './pages/SearchPage.jsx'
import SearchBox from './components/SearchBox.jsx'
import LibraryPage from './pages/LibraryPage.jsx'
import AuthPage from './pages/AuthPage.jsx'
import ProfilePage from './pages/ProfilePage.jsx'
import ListeningRoomPage from './pages/ListeningRoomPage.jsx'
import HomeMusicPanel from './pages/HomeMusicPanel.jsx'
import YoutubeEmbed from './playback/YoutubeEmbed.jsx'
import NowPlayingOverlay from './components/NowPlayingOverlay.jsx'
import { useAudioEngine } from './playback/useAudioEngine.js'
import { PlaybackController } from './playback/PlaybackController.js'
import { createPlaybackSnapshot, isCurrentRoomSession, resolveActiveTrack } from './playback/playbackSnapshot.js'
import { attachKeyboardShortcuts } from './keyboard/shortcuts.js'
import { getTrackEndAction, nextRepeatMode } from './playback/repeat.js'
import { loadSoloYouTubeTrack } from './playback/soloYouTubePlayback.js'
import { acceptYouTubeNotice, hasYouTubeConsent } from './services/youtubeConsent.js'
import { getAuthSession, logoutAccount } from './services/authApi.js'
import { recordJammyPlayback } from './services/musicApi.js'
import { accountStateAfterLogout, accountStateAfterSessionError, accountStateFromSession, authenticatedAccountState, guestAccountState } from './account/accountState.js'
import { readRecentSearches, rememberRecentSearch, removeRecentSearch } from './search/recentSearches.js'

function browserLocalStorage() {
  try { return window.localStorage } catch { return null }
}

function getRoomInviteCode() {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('room') ?? params.get('roomCode') ?? ''
  return /^[a-z0-9]{6}$/i.test(code) ? code.toUpperCase() : ''
}

function App() {
  const [activeNav, setActiveNav] = useState('Home')
  const [account, setAccount] = useState(() => guestAccountState('loading'))
  const [libraryTab, setLibraryTab] = useState('Playlists')
  const [standaloneTrack, setStandaloneTrack] = useState(null)
  const playbackControllerRef = useRef(null)
  if (!playbackControllerRef.current) playbackControllerRef.current = new PlaybackController(standaloneTrack)
  const playbackController = playbackControllerRef.current
  const [playbackState, setPlaybackState] = useState(() => playbackController.getState())
  const [query, setQuery] = useState('')
  const [recentSearches, setRecentSearches] = useState([])
  const [toast, setToast] = useState('')
  const [roomDialogMode, setRoomDialogMode] = useState(null)
  const [roomSession, setRoomSession] = useState(null)
  const [roomInviteCode, setRoomInviteCode] = useState(getRoomInviteCode)
  const [roomPlayback, setRoomPlayback] = useState(null)
  const [roomQueue, setRoomQueue] = useState([])
  const [standaloneYoutubeState, setStandaloneYoutubeState] = useState({ status: 'idle', currentTime: 0, duration: 0, volume: 72, muted: false, error: '' })
  const [roomYoutubeState, setRoomYoutubeState] = useState({ status: 'idle', currentTime: 0, duration: 0, volume: 72, muted: false, error: '' })
  const [repeatMode, setRepeatMode] = useState('off')
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false)
  const [expandedTab, setExpandedTab] = useState('player')
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [youtubeAutoplayRequested, setYoutubeAutoplayRequested] = useState(false)
  const [youtubeConsent, setYoutubeConsent] = useState(() => hasYouTubeConsent())
  const [accountBusy, setAccountBusy] = useState(false)
  const roomPlaybackRef = useRef(null)
  const roomSocketRef = useRef(null)
  const roomSessionRef = useRef(null)
  const standaloneSnapshotRef = useRef(null)
  const standaloneYoutubeRef = useRef(null)
  const roomYoutubeRef = useRef(null)
  const pendingRoomTrackRef = useRef(null)
  const searchInputRef = useRef(null)
  const repeatModeRef = useRef('off')
  const autoplayRequestRef = useRef(() => {})
  const restartAudioRef = useRef(() => {})
  const dismissiblesRef = useRef([])
  const shortcutActionsRef = useRef(null)
  const providerActionsRef = useRef({})
  const accountRevisionRef = useRef(0)
  const roomInviteOpenedRef = useRef(false)
  const recordedPlaybackRef = useRef(false)
  const currentTrack = resolveActiveTrack({ roomSession, roomPlayback, standaloneTrack })
  const youtubeState = roomSession ? roomYoutubeState : standaloneYoutubeState
  const notify = (message) => { setToast(message); window.setTimeout(() => setToast(''), 2600) }
  const accountUserId = account.status === 'authenticated' ? account.user.id : ''

  useEffect(() => {
    setRecentSearches(accountUserId ? readRecentSearches(browserLocalStorage(), accountUserId) : [])
  }, [accountUserId])

  const rememberSearch = useCallback((value) => {
    if (accountUserId) setRecentSearches(rememberRecentSearch(browserLocalStorage(), accountUserId, value))
  }, [accountUserId])

  const forgetSearch = useCallback((value) => {
    if (accountUserId) setRecentSearches(removeRecentSearch(browserLocalStorage(), accountUserId, value))
  }, [accountUserId])
  roomPlaybackRef.current = roomPlayback
  const activeRepeatMode = roomSession ? roomPlayback?.repeatMode ?? 'off' : repeatMode
  repeatModeRef.current = activeRepeatMode

  const restoreAccountSession = useCallback(async () => {
    const revision = ++accountRevisionRef.current
    setAccount(guestAccountState('loading'))
    try {
      const result = await getAuthSession()
      if (revision === accountRevisionRef.current) setAccount(accountStateFromSession(result))
    } catch (error) {
      if (revision === accountRevisionRef.current) setAccount(accountStateAfterSessionError(error))
    }
  }, [])

  const refreshAccountSession = useCallback(async () => {
    const revision = accountRevisionRef.current
    try {
      const result = await getAuthSession()
      if (revision === accountRevisionRef.current) setAccount(accountStateFromSession(result))
    } catch (error) {
      if (revision === accountRevisionRef.current) setAccount(accountStateAfterSessionError(error))
    }
  }, [])

  useEffect(() => {
    let active = true
    const revision = accountRevisionRef.current
    getAuthSession().then((result) => {
      if (active && revision === accountRevisionRef.current) setAccount(accountStateFromSession(result))
    }).catch((error) => {
      if (active && revision === accountRevisionRef.current) setAccount(accountStateAfterSessionError(error))
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refreshAccountSession()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [refreshAccountSession])

  useEffect(() => {
    if (account.status !== 'authenticated' || !roomInviteCode || roomInviteOpenedRef.current) return
    roomInviteOpenedRef.current = true
    setActiveNav('Home')
    setRoomDialogMode('join')
  }, [account.status, roomInviteCode])

  useEffect(() => {
    const playing = Boolean(currentTrack?.provider === 'youtube'
      && youtubeState.status === 'playing'
      && (!roomSession || roomPlayback?.isPlaying))
    if (!playing) { recordedPlaybackRef.current = false; return }
    if (recordedPlaybackRef.current || account.status !== 'authenticated') return
    const eventId = globalThis.crypto?.randomUUID?.()
    if (!eventId) return
    recordedPlaybackRef.current = true
    void recordJammyPlayback({ eventId, videoId: currentTrack.videoId, title: currentTrack.title, channelName: currentTrack.channelName || currentTrack.artist || '', source: roomSession ? 'room' : 'standalone' }).catch(() => {})
  }, [account.status, currentTrack?.id, currentTrack?.provider, currentTrack?.videoId, currentTrack?.title, currentTrack?.channelName, currentTrack?.artist, roomSession, roomPlayback?.isPlaying, youtubeState.status])

  const handleAuthenticated = (payload) => {
    try {
      accountRevisionRef.current += 1
      setAccount(authenticatedAccountState(payload))
      setActiveNav('Home')
    } catch (error) {
      setAccount(guestAccountState('error', error.message))
    }
  }
  const handleLogout = async () => {
    if (accountBusy) return
    accountRevisionRef.current += 1
    setAccountBusy(true)
    try {
      await logoutAccount(account.csrfToken)
      accountRevisionRef.current += 1
      setAccount(accountStateAfterLogout())
      setActiveNav('Home')
      notify('You’re logged out.')
    } catch (error) {
      await refreshAccountSession()
      notify(error.message || 'Jammy could not log you out. Try again.')
    } finally {
      setAccountBusy(false)
    }
  }

  const registerDismissible = useCallback((id, dismiss) => {
    dismissiblesRef.current = dismissiblesRef.current.filter((entry) => entry.id !== id)
    if (dismiss) dismissiblesRef.current.push({ id, dismiss })
  }, [])

  const handleAudioEnded = useCallback(() => {
    if (roomSession) {
      const playback = roomPlaybackRef.current
      if (playback?.currentTrackId && playback.playbackToken) roomSocketRef.current?.emit('playback:next', { expectedTrackId: playback.currentTrackId, expectedPlaybackToken: playback.playbackToken })
      return
    }
    const action = getTrackEndAction(repeatModeRef.current, 0, standaloneTrack ? 1 : 0)
    if (action.type === 'replay') { restartAudioRef.current(); return }
  }, [standaloneTrack?.id, roomSession, playbackController])
  const audio = useAudioEngine({ track: currentTrack, roomActive: Boolean(roomSession), sharedPlayback: roomPlayback, onEnded: handleAudioEnded })
  providerActionsRef.current.audioPlay = audio.play
  providerActionsRef.current.audioPause = audio.pause
  providerActionsRef.current.audioSeek = audio.seek
  providerActionsRef.current.audioSetVolume = audio.setVolume
  providerActionsRef.current.audioToggleMute = audio.toggleMute
  providerActionsRef.current.loadTrack = (track, options = {}) => {
    if (roomSession) return false
    if (track.provider === 'youtube') {
      const result = loadSoloYouTubeTrack(track, standaloneTrack, options, {
        setTrack: setStandaloneTrack,
        setAutoplayRequested: setYoutubeAutoplayRequested,
        openPlayer: () => openNowPlaying('player'),
        player: standaloneYoutubeRef.current,
      })
      if (!result.ok) {
        setStandaloneYoutubeState((previous) => ({ ...previous, status: 'error', error: result.error }))
        notify(result.error)
        throw new Error(result.error)
      }
      if (result.changed) setStandaloneYoutubeState((previous) => ({ ...previous, status: 'loading', currentTime: 0, duration: 0, error: '' }))
      return result.ok
    }
    if (track.id === standaloneTrack?.id) { if (options.autoplay) void audio.play(); return true }
    if (options.autoplay) audio.requestAutoplayOnSelection()
    setStandaloneTrack(track)
    return true
  }
  providerActionsRef.current.currentState = () => standaloneTrack?.provider === 'youtube'
    ? { ...standaloneYoutubeState, volume: (standaloneYoutubeState.volume ?? 72) / 100, currentTime: standaloneYoutubeRef.current?.getCurrentTime?.() ?? standaloneYoutubeState.currentTime }
    : { ...playbackState, currentTime: audio.audioRef.current?.currentTime ?? playbackState.currentTime }
  useEffect(() => playbackController.subscribe(setPlaybackState), [playbackController])
  useEffect(() => {
    const audioAdapter = {
      capabilities: { loadTrack: true, play: true, pause: true, seek: true, setVolume: true, toggleMute: true },
      loadTrack: (track, options) => providerActionsRef.current.loadTrack(track, options),
      play: () => providerActionsRef.current.audioPlay(),
      pause: () => providerActionsRef.current.audioPause(),
      seek: (position) => providerActionsRef.current.audioSeek(position),
      setVolume: (volume) => providerActionsRef.current.audioSetVolume(volume),
      toggleMute: () => providerActionsRef.current.audioToggleMute(),
      getCurrentState: () => providerActionsRef.current.currentState(),
    }
    const youtubeAdapter = {
      capabilities: { loadTrack: true, play: true, pause: true, seek: true, setVolume: true, toggleMute: true },
      loadTrack: (track, options) => providerActionsRef.current.loadTrack(track, options),
      play: () => standaloneYoutubeRef.current?.playFromUserGesture?.() ?? standaloneYoutubeRef.current?.play?.() ?? false,
      pause: () => standaloneYoutubeRef.current?.pause?.() ?? false,
      seek: (position) => standaloneYoutubeRef.current?.seek?.(position) ?? false,
      setVolume: (volume) => standaloneYoutubeRef.current?.setVolume?.(volume * 100) ?? false,
      toggleMute: () => {
        const player = standaloneYoutubeRef.current
        if (!player?.canControl?.()) return false
        if (player.isMuted()) player.unMute()
        else player.mute()
        return true
      },
      getCurrentState: () => providerActionsRef.current.currentState(),
    }
    const unregisterAudio = playbackController.registerProvider('audio', audioAdapter)
    const unregisterYouTube = playbackController.registerProvider('youtube', youtubeAdapter)
    return () => { unregisterAudio(); unregisterYouTube() }
  }, [playbackController])
  useEffect(() => { playbackController.setTrack(standaloneTrack) }, [playbackController, standaloneTrack])
  useEffect(() => { playbackController.setRepeatMode(repeatMode) }, [playbackController, repeatMode])
  useEffect(() => {
    if (!roomSession && standaloneTrack?.id) playbackController.reportProviderState('audio', standaloneTrack.id, audio.state)
  }, [playbackController, standaloneTrack?.id, audio.state, roomSession])
  autoplayRequestRef.current = audio.requestAutoplayOnSelection
  restartAudioRef.current = () => {
    const element = audio.audioRef.current
    if (!element) return
    element.currentTime = 0
    void element.play().catch(() => notify('Your browser blocked repeat playback. Press Play to start this track again.'))
  }
  const changeTrack = (direction) => {
    if (roomSession) {
      const currentTrackId = roomPlaybackRef.current?.currentTrackId
      if (direction < 0) { notify('Previous track is not available in listening rooms yet.'); return }
      if (!currentTrackId || !roomPlaybackRef.current?.playbackToken || !roomSocketRef.current?.connected) { notify('Wait for the room playback state to sync before skipping ahead.'); return }
      roomSocketRef.current.emit('playback:skip', { expectedTrackId: currentTrackId, expectedPlaybackToken: roomPlaybackRef.current?.playbackToken }, (result) => {
        if (!result?.ok) notify(result?.error || 'The room queue could not advance.')
      })
      return
    }
    if (!standaloneTrack) { notify('Choose a YouTube video before using track navigation.'); return }
    if (direction < 0 || activeRepeatMode !== 'all') { notify(direction < 0 ? 'Previous track is not available for a standalone YouTube video.' : 'There are no more tracks in your listening history.'); return }
    void playbackController.loadTrack(standaloneTrack, { autoplay: true, openPlayer: false })
  }
  const playTrack = (track) => { if (!roomSession) void playbackController.loadTrack(track, { autoplay: true }) }
  const onRoomPlaybackState = useCallback((nextPlayback, sourceSession) => {
    if (!isCurrentRoomSession(roomSessionRef.current, sourceSession)) return
    if (nextPlayback.currentTrackId !== roomPlaybackRef.current?.currentTrackId) {
      setRoomYoutubeState((previous) => ({ ...previous, status: 'loading', currentTime: 0, duration: 0, error: '' }))
    }
    setRoomPlayback(nextPlayback)
    roomPlaybackRef.current = nextPlayback
  }, [])
  const onRoomQueueState = useCallback((nextQueue, sourceSession) => {
    if (isCurrentRoomSession(roomSessionRef.current, sourceSession)) setRoomQueue(nextQueue)
  }, [])
  const onRoomSocketReady = useCallback((socket, sourceSession) => {
    if (!isCurrentRoomSession(roomSessionRef.current, sourceSession)) {
      socket?.disconnect()
      return
    }
    roomSocketRef.current = socket
    if (!socket) return
    const addPending = () => {
      const track = pendingRoomTrackRef.current
      if (!track || !socket.connected || !isCurrentRoomSession(roomSessionRef.current, sourceSession)) return
      pendingRoomTrackRef.current = null
      socket.emit('queue:add', { trackId: track.id, trackData: track }, (result) => {
        if (!isCurrentRoomSession(roomSessionRef.current, sourceSession)) return
        if (!result?.ok) notify(result?.error || 'The video could not be added to the room queue.')
        else notify('YouTube video added to the room queue.')
      })
    }
    if (socket.connected) addPending()
    else socket.once('connect', addPending)
  }, [])
  const handleRoomPlaybackCommand = useCallback((payload) => {
    const sourceSession = roomSessionRef.current
    const socket = roomSocketRef.current
    if (!sourceSession || !socket?.connected) { notify('Reconnect to the room before changing shared playback.'); return }
    const currentPlayback = roomPlaybackRef.current
    if (!currentPlayback?.currentTrackId || !currentPlayback.playbackToken) { notify('Wait for the room playback state to sync before changing playback.'); return }
    const command = {
      ...payload,
      expectedTrackId: currentPlayback.currentTrackId,
      expectedPlaybackToken: currentPlayback.playbackToken,
    }
    socket.emit('playback:update', command, (result) => {
      if (!isCurrentRoomSession(roomSessionRef.current, sourceSession)) return
      if (!result?.ok) {
        notify(result?.error || 'The room playback command could not be applied.')
        const previous = roomPlaybackRef.current
        if (currentTrack?.provider === 'youtube') {
          if (previous) roomYoutubeRef.current?.applyRoomCommand?.(previous)
        } else {
          if (previous && Number.isFinite(previous.positionMs)) audio.seek(previous.positionMs / 1000)
          if (previous?.isPlaying) void audio.play()
          else audio.pause()
        }
      }
    })
    // Start directly from the user gesture, then reconcile to the server's ack/state.
    if (currentTrack?.provider === 'youtube') {
      roomYoutubeRef.current?.applyRoomCommand?.(command)
    } else {
      if (Number.isFinite(command.positionMs)) audio.seek(command.positionMs / 1000)
      if (command.isPlaying) void audio.play()
      else audio.pause()
    }
  }, [currentTrack?.provider, audio.play, audio.pause, audio.seek])
  const handlePlayerToggle = () => {
    if (roomSession) {
      if (!roomPlayback?.currentTrackId) { notify('Select a track from the shared room queue first.'); return }
      const state = currentTrack?.provider === 'youtube' ? roomYoutubeState : audio.state
      handleRoomPlaybackCommand({ isPlaying: state.status !== 'playing', positionMs: Math.round(state.currentTime * 1000) })
    } else if (currentTrack?.provider === 'youtube') {
      if (!standaloneYoutubeRef.current?.canControl?.()) {
        setYoutubeAutoplayRequested(true)
        openNowPlaying('player')
      } else if (playbackState.status === 'playing') void playbackController.command('pause')
      else void playbackController.command('play')
    } else if (playbackState.status === 'playing') void playbackController.command('pause')
    else void playbackController.command('play')
  }
  const handlePlayerSeek = (seconds) => {
    const playerState = currentTrack?.provider === 'youtube' ? youtubeState : audio.state
    if (!Number.isFinite(playerState.duration) || playerState.duration <= 0) {
      notify('Seeking is unavailable until this player reports a duration.')
      return
    }
    if (roomSession) handleRoomPlaybackCommand({ isPlaying: Boolean(roomPlayback?.isPlaying), positionMs: Math.round(seconds * 1000) })
    else if (currentTrack?.provider === 'youtube') {
      if (standaloneYoutubeRef.current?.canControl?.()) void playbackController.command('seek', seconds)
      else {
        setStandaloneYoutubeState((previous) => ({ ...previous, currentTime: seconds }))
        openNowPlaying('player')
      }
    }
    else void playbackController.command('seek', seconds)
  }

  const cycleRepeat = () => {
    const next = nextRepeatMode(activeRepeatMode)
    if (roomSession) {
      if (!roomSocketRef.current?.connected) { notify('Reconnect to the room before changing repeat mode.'); return }
      roomSocketRef.current.emit('playback:repeat', { repeatMode: next }, (result) => {
        if (!result?.ok) notify(result?.error || 'The room repeat mode could not be changed.')
      })
      return
    }
    setRepeatMode(next)
  }

  const currentVolume = currentTrack?.provider === 'youtube'
    ? (youtubeState.volume ?? 72) / 100
    : audio.state.volume
  const currentMuted = currentTrack?.provider === 'youtube' ? Boolean(youtubeState.muted) : audio.state.muted
  const changeVolume = (value) => {
    if (currentTrack?.provider !== 'youtube') { void playbackController.command('setVolume', value); return }
    const player = roomSession ? roomYoutubeRef.current : standaloneYoutubeRef.current
    if (!player?.canControl?.()) { notify('YouTube volume controls are available when the player is ready.'); return }
    if (roomSession) player.setVolume(value * 100)
    else void playbackController.command('setVolume', value)
    const setState = roomSession ? setRoomYoutubeState : setStandaloneYoutubeState
    setState((previous) => ({ ...previous, volume: value * 100 }))
  }
  const toggleMute = () => {
    if (currentTrack?.provider !== 'youtube') { void playbackController.command('toggleMute'); return }
    const player = roomSession ? roomYoutubeRef.current : standaloneYoutubeRef.current
    if (!player?.canControl?.()) { notify('YouTube mute controls are available when the player is ready.'); return }
    const muted = !player.isMuted()
    if (roomSession) muted ? player.mute() : player.unMute()
    else void playbackController.command('toggleMute')
    const setState = roomSession ? setRoomYoutubeState : setStandaloneYoutubeState
    setState((previous) => ({ ...previous, muted }))
  }
  const seekBy = (deltaSeconds) => {
    const state = currentTrack?.provider === 'youtube' ? youtubeState : audio.state
    if (!Number.isFinite(state.duration) || state.duration <= 0) { notify('Seeking is unavailable until this player reports a duration.'); return }
    handlePlayerSeek(Math.max(0, Math.min(state.duration, state.currentTime + deltaSeconds)))
  }

  const selectRoomQueueItem = (itemId) => {
    if (!roomSocketRef.current?.connected) { notify('Reconnect to the room before selecting a track.'); return }
    roomSocketRef.current.emit('playback:select', { itemId }, (result) => {
      if (!result?.ok) notify(result?.error || 'That room track could not be selected.')
    })
  }

  const openNowPlaying = (tab = 'player') => {
    if (roomSession) return
    setExpandedTab(tab)
    setShortcutsOpen(false)
    setNowPlayingOpen(true)
  }
  const closeNowPlaying = () => {
    setNowPlayingOpen(false)
    setShortcutsOpen(false)
  }
  const handleStandaloneYoutubeState = useCallback((state) => {
    if (state.trackId && state.trackId !== standaloneTrack?.id) return
    setStandaloneYoutubeState((previous) => ({ ...previous, ...state }))
    playbackController.reportProviderState('youtube', state.trackId ?? standaloneTrack?.id, {
      ...state,
      volume: Number.isFinite(state.volume) ? state.volume / 100 : undefined,
    })
    if (state.status === 'ready') setYoutubeAutoplayRequested(false)
  }, [standaloneTrack?.id, playbackController])
  const handleRoomYoutubeState = useCallback((state, sourceSession) => {
    if (!isCurrentRoomSession(roomSessionRef.current, sourceSession)
      || roomPlaybackRef.current?.currentTrackId !== state.trackId) return
    setRoomYoutubeState((previous) => ({ ...previous, ...state }))
    if (state.userInitiated && Number.isFinite(state.currentTime)) {
      const socket = roomSocketRef.current
      if (!socket?.connected) { notify('Reconnect to the room before sharing this playback change.'); return }
      const playback = roomPlaybackRef.current
      if (!playback?.currentTrackId || !playback.playbackToken) return
      socket.emit('playback:update', {
        isPlaying: state.status === 'playing',
        positionMs: Math.round(state.currentTime * 1000),
        expectedTrackId: playback.currentTrackId,
        expectedPlaybackToken: playback.playbackToken,
      }, (result) => {
        if (!isCurrentRoomSession(roomSessionRef.current, sourceSession)) return
        if (!result?.ok) {
          const authoritative = roomPlaybackRef.current
          if (authoritative) roomYoutubeRef.current?.applyRoomCommand?.(authoritative)
          notify(result?.error || 'The room playback command could not be applied.')
        }
      })
    }
  }, [])
  const handleStandaloneYoutubeEnded = useCallback(() => {
    const action = getTrackEndAction(repeatModeRef.current, 0, standaloneTrack ? 1 : 0)
    if (action.type === 'replay') {
      standaloneYoutubeRef.current?.seek(0)
      standaloneYoutubeRef.current?.play()
    }
  }, [standaloneTrack?.id, playbackController])
  const handleRoomYoutubeEnded = useCallback((trackId, sourceSession) => {
    if (!isCurrentRoomSession(roomSessionRef.current, sourceSession)) return
    const playback = roomPlaybackRef.current
    if (playback?.currentTrackId === trackId && playback.playbackToken) {
      roomSocketRef.current?.emit('playback:next', { expectedTrackId: trackId, expectedPlaybackToken: playback.playbackToken })
    }
  }, [])
  const addYouTubeToRoom = (track) => {
    pendingRoomTrackRef.current = track
    setRoomDialogMode('join')
    notify('Join or create a listening room to add this video to its shared queue.')
  }
  const acceptYouTube = () => {
    if (acceptYouTubeNotice()) setYoutubeConsent(true)
    else notify('Browser storage is unavailable. Enable it before using YouTube search.')
  }
  const navigate = (page, tab) => {
    if (page === 'Profile' && account.status !== 'authenticated') {
      setActiveNav('Log in')
      return
    }
    setActiveNav(page)
    if (tab) setLibraryTab(tab)
  }

  shortcutActionsRef.current = {
    escape: () => {
      if (shortcutsOpen) { setShortcutsOpen(false); return }
      if (nowPlayingOpen) { closeNowPlaying(); return }
      const topmost = dismissiblesRef.current.at(-1)
      topmost?.dismiss()
    },
    focusSearch: () => searchInputRef.current?.focus(),
    togglePlay: handlePlayerToggle,
    next: () => changeTrack(1),
    previous: () => changeTrack(-1),
    cycleRepeat,
    toggleMute,
    seekBackward: () => seekBy(-5),
    seekForward: () => seekBy(5),
    volumeUp: () => changeVolume(Math.min(1, currentVolume + 0.05)),
    volumeDown: () => changeVolume(Math.max(0, currentVolume - 0.05)),
    toggleNowPlaying: () => nowPlayingOpen ? closeNowPlaying() : openNowPlaying(),
  }
  useEffect(() => attachKeyboardShortcuts(window, () => shortcutActionsRef.current), [])
  useEffect(() => {
    if (!nowPlayingOpen) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [nowPlayingOpen])

  const openRoomDialog = (mode) => setRoomDialogMode(mode)
  const enterRoom = (session) => {
    setRoomInviteCode('')
    const audioElement = audio.audioRef.current
    let position = standaloneTrack?.provider === 'youtube'
      ? standaloneYoutubeRef.current?.getCurrentTime?.() ?? standaloneYoutubeState.currentTime
      : audioElement?.currentTime ?? audio.state.currentTime
    let isPlaying = standaloneTrack?.provider === 'youtube'
      ? standaloneYoutubeRef.current?.getIsPlaying?.() ?? standaloneYoutubeState.status === 'playing'
      : Boolean(audioElement && !audioElement.paused)
    if (standaloneTrack?.provider === 'youtube') {
      const suspended = standaloneYoutubeRef.current?.suspend?.()
      if (suspended) {
        position = suspended.currentTime
        isPlaying = suspended.isPlaying
        setStandaloneYoutubeState((previous) => ({ ...previous, ...suspended, status: 'paused' }))
      } else {
        standaloneYoutubeRef.current?.pause?.()
      }
    }
    standaloneSnapshotRef.current = createPlaybackSnapshot(standaloneTrack, { position, isPlaying })
    audio.pause()
    setNowPlayingOpen(false)
    setShortcutsOpen(false)
    setYoutubeAutoplayRequested(false)
    roomSessionRef.current = session
    roomPlaybackRef.current = null
    setRoomPlayback(null)
    setRoomQueue([])
    setRoomYoutubeState({ status: 'idle', currentTime: 0, duration: 0, volume: 72, muted: false, error: '' })
    setRoomSession(session)
    setRoomDialogMode(null)
  }
  const leaveRoomView = () => {
    const snapshot = standaloneSnapshotRef.current
    roomSessionRef.current = null
    if (currentTrack?.provider === 'youtube') roomYoutubeRef.current?.suspend?.()
    else audio.pause()
    roomSocketRef.current?.disconnect()
    roomSocketRef.current = null
    roomPlaybackRef.current = null
    setRoomPlayback(null)
    setRoomQueue([])
    setRoomSession(null)
    setActiveNav('Home')
    if (snapshot) {
      if (snapshot.track.provider === 'youtube') {
        setStandaloneYoutubeState((previous) => ({ ...previous, status: snapshot.isPlaying ? 'loading' : 'paused', currentTime: snapshot.position, error: '' }))
        standaloneYoutubeRef.current?.restorePlayback?.(snapshot)
      } else {
        audio.restorePlayback(snapshot)
      }
    }
    standaloneSnapshotRef.current = null
    notify('You left the listening room.')
  }

  return <div className={roomSession ? 'room-app-shell' : account.status === 'authenticated' ? 'app-shell' : 'auth-shell'}>
    <audio ref={audio.audioRef} className="audio-engine-element" preload="metadata" aria-hidden="true" />
    {roomSession ? <ListeningRoomPage session={roomSession} query={query} onQueryChange={setQuery} onLeave={leaveRoomView} onPlaybackState={onRoomPlaybackState} onQueueState={onRoomQueueState} onSocketReady={onRoomSocketReady} onPlaybackCommand={handleRoomPlaybackCommand} onTrackChange={changeTrack} onToggleRepeat={cycleRepeat} repeatMode={activeRepeatMode} volumeLevel={currentVolume} muted={currentMuted} onVolumeChange={changeVolume} onToggleMute={toggleMute} youtubeState={roomYoutubeState} playerState={audio.state} onRegisterDismissible={registerDismissible} youtubePlayer={<YoutubeEmbed ref={roomYoutubeRef} track={currentTrack} sharedPlayback={roomPlayback} onState={(state) => handleRoomYoutubeState(state, roomSession)} onEnded={() => currentTrack && handleRoomYoutubeEnded(currentTrack.id, roomSession)} placement="room"/>}/> : account.status !== 'authenticated' ? account.status === 'loading' ? <main className="auth-loading" aria-live="polite" aria-busy="true"><span className="brand"><span className="brand-mark">j</span><span>jammy<span className="brand-period">.</span></span></span><span className="auth-loading-mark" aria-hidden="true"/><span>Restoring your session…</span></main> : <AuthPage onAuthenticated={handleAuthenticated} sessionError={account.status === 'error' ? account.error : ''} onRetrySession={restoreAccountSession}/> : <>
    <Sidebar active={activeNav} account={account} onNavigate={navigate} onCreatePlaylist={() => notify('Playlist creation will be available when Jammy can save library data.')}/>
    <main className="main-content">
      <header className="topbar"><div className="history-controls"><button className="round-button" aria-label="Go back" onClick={() => notify('You’re at the start')}><span>‹</span></button><button className="round-button" aria-label="Go forward"><span>›</span></button></div><SearchBox inputRef={searchInputRef} query={query} onQueryChange={setQuery} onNavigate={navigate} recentSearches={recentSearches} onRememberSearch={rememberSearch} onRemoveSearch={forgetSearch}/><button className="upgrade-button" onClick={() => notify('Jammy is in preview')}>Explore Jammy <Icon name="arrow" size={14}/></button><button className="top-avatar" aria-label={account.status === 'authenticated' ? `Profile for ${account.user.username}` : 'Log in'} onClick={() => navigate(account.status === 'authenticated' ? 'Profile' : 'Log in')}>{account.status === 'authenticated' ? account.user.username.slice(0, 1).toUpperCase() : 'J'}</button></header>
      {activeNav === 'Home' ? <>
      <section className="welcome-row"><div><h1>Welcome, {account.user.username}<span>.</span></h1><p className="welcome-subtitle">Your Jammy listening, ready when you are.</p></div><div className="welcome-actions"><button className="outline-action" onClick={() => openRoomDialog('join')}><Icon name="users" size={17}/> Join a room</button><button className="primary-action" onClick={() => openRoomDialog('create')}><Icon name="plus" size={18}/> Create a room</button></div></section>
      <section className="hero-card"><div className="hero-copy"><div className="hero-kicker"><span className="hero-spark">✳</span> YOUR SPACE, YOUR SOUND</div><h2>Music hits<br/>different <em>together.</em></h2><p>Set up a listening room, invite your people, and let the good songs find you.</p><button className="hero-button" onClick={() => openRoomDialog('create')}>Start a listening room <Icon name="arrow" size={16}/></button><div className="hero-foot"><span>Shared playback, your people</span></div></div><div className="hero-visual"><div className="hero-sun"/><div className="hero-ring ring-one"/><div className="hero-ring ring-two"/><div className="hero-record"><div className="record-label"><span>side A</span><b>JAM<br/>SESSIONS</b><small>001 · 33⅓ RPM</small></div></div><div className="hero-note note-top">♫</div><div className="hero-note note-bottom">♪</div></div></section>
      <HomeMusicPanel onPlayTrack={playTrack}/>
      <footer className="page-footer"><span>Made for the moments between songs.</span><span>JAMMY <i>●</i> 2026</span></footer>
      </> : activeNav === 'Search' ? <SearchPage query={query} currentTrack={currentTrack} onPlayTrack={playTrack} onNotice={notify} onAddToRoom={addYouTubeToRoom} youtubeConsent={youtubeConsent} onAcceptYouTube={acceptYouTube} onSearchStarted={rememberSearch}/> : activeNav === 'Profile' ? <ProfilePage account={account} onLogout={handleLogout} onRetry={restoreAccountSession} logoutBusy={accountBusy}/> : <LibraryPage activeTab={libraryTab} onTabChange={setLibraryTab} currentTrack={currentTrack} onPlayTrack={playTrack} onNotice={notify}/>}
    </main>
    {roomDialogMode && <RoomDialog key={roomDialogMode} initialMode={roomDialogMode} initialCode={roomInviteCode} onClose={() => { setRoomDialogMode(null); pendingRoomTrackRef.current = null }} onRoomReady={enterRoom} onRegisterDismissible={registerDismissible}/>}
    {toast && <div className="toast" role="status">{toast}</div>}
    </>}
    {!roomSession && account.status === 'authenticated' && currentTrack && <MusicPlayer track={currentTrack} repeatMode={activeRepeatMode} onToggleRepeat={cycleRepeat} onOpenNowPlaying={openNowPlaying} volumeLevel={currentVolume} muted={currentMuted} onTrackChange={changeTrack} onCreateRoom={() => openRoomDialog('create')} audioState={playbackState} onTogglePlay={handlePlayerToggle} onSeek={handlePlayerSeek} onVolumeChange={changeVolume} onToggleMute={toggleMute} youtubeState={standaloneYoutubeState}/>}
    {account.status === 'authenticated' && <NowPlayingOverlay isOpen={nowPlayingOpen && !roomSession} track={standaloneTrack} playerState={playbackState} repeatMode={repeatMode} onTogglePlay={handlePlayerToggle} onSeek={handlePlayerSeek} onToggleRepeat={cycleRepeat} volume={standaloneTrack?.provider === 'youtube' ? (standaloneYoutubeState.volume ?? 72) / 100 : playbackState.volume} muted={standaloneTrack?.provider === 'youtube' ? Boolean(standaloneYoutubeState.muted) : playbackState.muted} onVolumeChange={changeVolume} onToggleMute={toggleMute} roomActive={false} roomQueue={roomQueue} onSelectQueueItem={selectRoomQueueItem} onSelectTrack={(trackOrDirection) => typeof trackOrDirection === 'number' ? changeTrack(trackOrDirection) : playTrack(trackOrDirection)} activeTab={expandedTab} onTabChange={setExpandedTab} onClose={closeNowPlaying} shortcutsOpen={shortcutsOpen} onToggleShortcuts={() => setShortcutsOpen((value) => !value)} youtubePlayer={standaloneTrack?.provider === 'youtube' ? <div className="expanded-youtube-slot"><YoutubeEmbed ref={standaloneYoutubeRef} track={standaloneTrack} onState={handleStandaloneYoutubeState} onEnded={handleStandaloneYoutubeEnded} startAtSeconds={standaloneYoutubeState.currentTime} autoplayOnReady={youtubeAutoplayRequested} placement="inline"/></div> : null}/>}
  </div>
}

export default App

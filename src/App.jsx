import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from './components/Icon.jsx'
import Sidebar from './components/Sidebar.jsx'
import TrackCard from './components/TrackCard.jsx'
import MixCard from './components/MixCard.jsx'
import MusicPlayer from './components/MusicPlayer.jsx'
import RoomDialog from './components/RoomDialog.jsx'
import SearchPage from './pages/SearchPage.jsx'
import LibraryPage from './pages/LibraryPage.jsx'
import ListeningRoomPage from './pages/ListeningRoomPage.jsx'
import YoutubeEmbed from './playback/YoutubeEmbed.jsx'
import NowPlayingOverlay from './components/NowPlayingOverlay.jsx'
import { friends, mixes, tracks } from './data.js'
import { useAudioEngine } from './playback/useAudioEngine.js'
import { PlaybackController } from './playback/PlaybackController.js'
import { attachKeyboardShortcuts } from './keyboard/shortcuts.js'
import { getTrackEndAction, nextRepeatMode } from './playback/repeat.js'
import { acceptYouTubeNotice, hasYouTubeConsent } from './services/youtubeConsent.js'

function App() {
  const [activeNav, setActiveNav] = useState('Home')
  const [libraryTab, setLibraryTab] = useState('Playlists')
  const [currentTrack, setCurrentTrack] = useState(tracks[0])
  const playbackControllerRef = useRef(null)
  if (!playbackControllerRef.current) playbackControllerRef.current = new PlaybackController(tracks[0])
  const playbackController = playbackControllerRef.current
  const [playbackState, setPlaybackState] = useState(() => playbackController.getState())
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState('')
  const [roomDialogMode, setRoomDialogMode] = useState(null)
  const [roomSession, setRoomSession] = useState(null)
  const [roomPlayback, setRoomPlayback] = useState(null)
  const [roomQueue, setRoomQueue] = useState([])
  const [repeatMode, setRepeatMode] = useState('off')
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false)
  const [expandedTab, setExpandedTab] = useState('player')
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [youtubeAutoplayRequested, setYoutubeAutoplayRequested] = useState(false)
  const [youtubeState, setYoutubeState] = useState({ status: 'idle', currentTime: 0, duration: 0, volume: 72, muted: false, error: '' })
  const [youtubeConsent, setYoutubeConsent] = useState(() => hasYouTubeConsent())
  const roomPlaybackRef = useRef(null)
  const roomSocketRef = useRef(null)
  const youtubeRef = useRef(null)
  const suspendedRoomVideoRef = useRef(null)
  const pendingRoomTrackRef = useRef(null)
  const searchInputRef = useRef(null)
  const repeatModeRef = useRef('off')
  const autoplayRequestRef = useRef(() => {})
  const restartAudioRef = useRef(() => {})
  const dismissiblesRef = useRef([])
  const shortcutActionsRef = useRef(null)
  const providerActionsRef = useRef({})
  const notify = (message) => { setToast(message); window.setTimeout(() => setToast(''), 2600) }
  roomPlaybackRef.current = roomPlayback
  const activeRepeatMode = roomSession ? roomPlayback?.repeatMode ?? 'off' : repeatMode
  repeatModeRef.current = activeRepeatMode

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
    const index = tracks.findIndex((track) => track.id === currentTrack.id)
    const action = getTrackEndAction(repeatModeRef.current, index, tracks.length)
    if (action.type === 'replay') { restartAudioRef.current(); return }
    if (action.type === 'select') { void playbackController.loadTrack(tracks[action.index], { autoplay: true, openPlayer: false }) }
  }, [currentTrack.id, roomSession, playbackController])
  const audio = useAudioEngine({ track: currentTrack, roomActive: Boolean(roomSession), sharedPlayback: roomPlayback, onEnded: handleAudioEnded })
  providerActionsRef.current.audioPlay = audio.play
  providerActionsRef.current.audioPause = audio.pause
  providerActionsRef.current.audioSeek = audio.seek
  providerActionsRef.current.audioSetVolume = audio.setVolume
  providerActionsRef.current.audioToggleMute = audio.toggleMute
  providerActionsRef.current.loadTrack = (track, options = {}) => {
    if (roomSession) return false
    if (track.provider === 'youtube') {
      if (track.id !== currentTrack.id) setYoutubeState((previous) => ({ ...previous, status: 'loading', currentTime: 0, duration: 0, error: '' }))
      setCurrentTrack(track)
      setYoutubeAutoplayRequested(Boolean(options.autoplay))
      if (options.openPlayer !== false) openNowPlaying('player')
      if (track.id === currentTrack.id && youtubeRef.current?.canControl?.() && options.autoplay) youtubeRef.current.play()
      return true
    }
    if (track.id === currentTrack.id) { if (options.autoplay) void audio.play(); return true }
    if (options.autoplay) audio.requestAutoplayOnSelection()
    setCurrentTrack(track)
    return true
  }
  providerActionsRef.current.currentState = () => currentTrack.provider === 'youtube'
    ? { ...youtubeState, volume: (youtubeState.volume ?? 72) / 100, currentTime: youtubeRef.current?.getCurrentTime?.() ?? youtubeState.currentTime }
    : { ...audio.state, currentTime: audio.audioRef.current?.currentTime ?? audio.state.currentTime }
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
      capabilities: { loadTrack: true, play: true, pause: true, seek: true, setVolume: true, toggleMute: true, applyRoomCommand: true },
      loadTrack: (track, options) => providerActionsRef.current.loadTrack(track, options),
      play: () => youtubeRef.current?.play?.() ?? false,
      pause: () => youtubeRef.current?.pause?.() ?? false,
      seek: (position) => youtubeRef.current?.seek?.(position) ?? false,
      applyRoomCommand: (command) => youtubeRef.current?.applyRoomCommand?.(command) ?? false,
      setVolume: (volume) => youtubeRef.current?.setVolume?.(volume * 100) ?? false,
      toggleMute: () => {
        const player = youtubeRef.current
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
  useEffect(() => { playbackController.setTrack(currentTrack) }, [playbackController, currentTrack])
  useEffect(() => { playbackController.setRepeatMode(activeRepeatMode) }, [playbackController, activeRepeatMode])
  useEffect(() => { playbackController.reportProviderState('audio', currentTrack.id, audio.state) }, [playbackController, currentTrack.id, audio.state])
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
    const currentIndex = tracks.findIndex((track) => track.id === currentTrack.id)
    if (currentIndex < 0) { notify('Track navigation is unavailable for this standalone YouTube video.'); return }
    let nextIndex = currentIndex + direction
    if (nextIndex < 0 || nextIndex >= tracks.length) {
      if (activeRepeatMode !== 'all') { notify(direction > 0 ? 'You reached the end of Jammy’s listening list.' : 'You are at the first track.'); return }
      nextIndex = (nextIndex + tracks.length) % tracks.length
    }
    void playbackController.loadTrack(tracks[nextIndex], { autoplay: true, openPlayer: false })
  }
  const playTrack = (track) => { if (!roomSession) void playbackController.loadTrack(track, { autoplay: true }) }
  const onRoomPlaybackState = useCallback((nextPlayback) => {
    setRoomPlayback(nextPlayback)
    roomPlaybackRef.current = nextPlayback
    const selectedTrack = nextPlayback.currentTrack ?? tracks.find((track) => track.id === nextPlayback.currentTrackId)
    if (selectedTrack) setCurrentTrack(selectedTrack)
  }, [])
  const suspendRoomYoutube = () => {
    const snapshot = youtubeRef.current?.suspend?.()
    if (!snapshot || currentTrack?.provider !== 'youtube') return
    suspendedRoomVideoRef.current = {
      trackId: currentTrack.id,
      currentTime: snapshot.currentTime,
      isPlaying: snapshot.isPlaying,
      updatedAt: roomPlaybackRef.current?.updatedAt,
    }
    setYoutubeState((previous) => ({ ...previous, ...snapshot, status: 'paused', error: '' }))
  }
  const resumeRoomYoutube = () => { suspendedRoomVideoRef.current = null }
  const onRoomSocketReady = useCallback((socket) => {
    roomSocketRef.current = socket
    if (!socket) return
    const addPending = () => {
      const track = pendingRoomTrackRef.current
      if (!track || !socket.connected) return
      pendingRoomTrackRef.current = null
      socket.emit('queue:add', { trackId: track.id, trackData: track }, (result) => {
        if (!result?.ok) notify(result?.error || 'The video could not be added to the room queue.')
        else notify('YouTube video added to the room queue.')
      })
    }
    if (socket.connected) addPending()
    else socket.once('connect', addPending)
  }, [])
  const handleRoomPlaybackCommand = useCallback((payload) => {
    const socket = roomSocketRef.current
    if (!socket?.connected) { notify('Reconnect to the room before changing shared playback.'); return }
    socket.emit('playback:update', payload, (result) => {
      if (!result?.ok) {
        notify(result?.error || 'The room playback command could not be applied.')
        const previous = roomPlaybackRef.current
        if (currentTrack.provider === 'youtube') {
          if (previous) void playbackController.command('applyRoomCommand', previous)
        } else {
          if (previous && Number.isFinite(previous.positionMs)) void playbackController.command('seek', previous.positionMs / 1000)
          if (previous?.isPlaying) void playbackController.command('play')
          else void playbackController.command('pause')
        }
      }
    })
    // Start directly from the user gesture, then reconcile to the server's ack/state.
    if (currentTrack.provider === 'youtube') {
      void playbackController.command('applyRoomCommand', payload)
    } else {
      if (Number.isFinite(payload.positionMs)) void playbackController.command('seek', payload.positionMs / 1000)
      if (payload.isPlaying) void playbackController.command('play')
      else void playbackController.command('pause')
    }
  }, [currentTrack.provider, playbackController])
  const handlePlayerToggle = () => {
    if (roomSession) {
      if (!roomPlayback?.currentTrackId) { notify('Select a track from the shared room queue first.'); return }
      const state = playbackState
      handleRoomPlaybackCommand({ isPlaying: state.status !== 'playing', positionMs: Math.round(state.currentTime * 1000) })
    } else if (currentTrack.provider === 'youtube') {
      if (!youtubeRef.current?.canControl?.()) {
        setYoutubeAutoplayRequested(true)
        openNowPlaying('player')
      } else if (playbackState.status === 'playing') void playbackController.command('pause')
      else void playbackController.command('play')
    } else if (playbackState.status === 'playing') void playbackController.command('pause')
    else void playbackController.command('play')
  }
  const handlePlayerSeek = (seconds) => {
    const playerState = currentTrack.provider === 'youtube' ? youtubeState : audio.state
    if (!Number.isFinite(playerState.duration) || playerState.duration <= 0) {
      notify('Seeking is unavailable until this player reports a duration.')
      return
    }
    if (roomSession) handleRoomPlaybackCommand({ isPlaying: Boolean(roomPlayback?.isPlaying), positionMs: Math.round(seconds * 1000) })
    else if (currentTrack.provider === 'youtube') {
      if (youtubeRef.current?.canControl?.()) void playbackController.command('seek', seconds)
      else {
        setYoutubeState((previous) => ({ ...previous, currentTime: seconds }))
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

  const currentVolume = currentTrack.provider === 'youtube'
    ? (youtubeState.volume ?? 72) / 100
    : audio.state.volume
  const currentMuted = currentTrack.provider === 'youtube' ? Boolean(youtubeState.muted) : audio.state.muted
  const changeVolume = (value) => {
    if (currentTrack.provider !== 'youtube') { void playbackController.command('setVolume', value); return }
    if (!youtubeRef.current?.canControl?.()) { notify('YouTube volume controls are available when the player is ready.'); return }
    void playbackController.command('setVolume', value)
    setYoutubeState((previous) => ({ ...previous, volume: value * 100 }))
  }
  const toggleMute = () => {
    if (currentTrack.provider !== 'youtube') { void playbackController.command('toggleMute'); return }
    if (!youtubeRef.current?.canControl?.()) { notify('YouTube mute controls are available when the player is ready.'); return }
    const muted = !youtubeRef.current.isMuted()
    void playbackController.command('toggleMute')
    setYoutubeState((previous) => ({ ...previous, muted }))
  }
  const seekBy = (deltaSeconds) => {
    const state = currentTrack.provider === 'youtube' ? youtubeState : audio.state
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
    if (currentTrack.provider === 'youtube' && youtubeRef.current?.canControl?.()) {
      const currentTime = youtubeRef.current.getCurrentTime()
      youtubeRef.current.pause()
      setYoutubeState((previous) => ({ ...previous, status: 'paused', currentTime }))
    }
    setYoutubeAutoplayRequested(false)
    setNowPlayingOpen(false)
    setShortcutsOpen(false)
  }
  const handleYoutubeState = useCallback((state) => {
    setYoutubeState((previous) => ({ ...previous, ...state }))
    playbackController.reportProviderState('youtube', state.trackId ?? currentTrack.id, {
      ...state,
      volume: Number.isFinite(state.volume) ? state.volume / 100 : undefined,
    })
    if (state.status === 'ready') setYoutubeAutoplayRequested(false)
    if (state.userInitiated && roomSession && Number.isFinite(state.currentTime)) {
      const socket = roomSocketRef.current
      if (!socket?.connected) { notify('Reconnect to the room before sharing this playback change.'); return }
      socket?.emit('playback:update', { isPlaying: state.status === 'playing', positionMs: Math.round(state.currentTime * 1000) }, (result) => {
        if (!result?.ok) notify(result?.error || 'The room playback command could not be applied.')
      })
    }
  }, [currentTrack.id, playbackController, roomSession])
  const handleYoutubeEnded = useCallback(() => {
    if (roomSession) {
      const playback = roomPlaybackRef.current
      if (playback?.currentTrackId && playback.playbackToken) roomSocketRef.current?.emit('playback:next', { expectedTrackId: playback.currentTrackId, expectedPlaybackToken: playback.playbackToken })
    } else {
      const index = tracks.findIndex((track) => track.id === currentTrack.id)
      const action = getTrackEndAction(repeatModeRef.current, index, tracks.length)
      if (action.type === 'replay') {
        youtubeRef.current?.seek(0)
        youtubeRef.current?.play()
      } else if (action.type === 'select') {
        void playbackController.loadTrack(tracks[action.index], { autoplay: true, openPlayer: false })
      }
    }
  }, [currentTrack.id, playbackController, roomSession])
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
    suspendedRoomVideoRef.current = null
    audio.pause()
    if (youtubeRef.current?.canControl?.()) {
      const currentTime = youtubeRef.current.getCurrentTime()
      youtubeRef.current.pause()
      setYoutubeState((previous) => ({ ...previous, status: 'paused', currentTime }))
    }
    setNowPlayingOpen(false)
    setShortcutsOpen(false)
    setYoutubeAutoplayRequested(false)
    setRoomPlayback(null)
    setRoomQueue([])
    setRoomSession(session)
    setRoomDialogMode(null)
  }
  const leaveRoomView = () => {
    if (currentTrack.provider === 'youtube' && youtubeRef.current?.canControl?.()) {
      const currentTime = youtubeRef.current.getCurrentTime()
      youtubeRef.current.pause()
      setYoutubeState((previous) => ({ ...previous, status: 'paused', currentTime }))
    }
    setRoomPlayback(null)
    setRoomQueue([])
    suspendedRoomVideoRef.current = null
    setRoomSession(null)
    setActiveNav('Home')
    notify('You left the listening room.')
  }

  return <div className={roomSession ? 'room-app-shell' : 'app-shell'}>
    <audio ref={audio.audioRef} className="audio-engine-element" preload="metadata" aria-hidden="true" />
    {roomSession ? <ListeningRoomPage session={roomSession} query={query} onQueryChange={setQuery} onLeave={leaveRoomView} onPlaybackState={onRoomPlaybackState} onQueueState={setRoomQueue} onSocketReady={onRoomSocketReady} onPlaybackCommand={handleRoomPlaybackCommand} onTrackChange={changeTrack} onToggleRepeat={cycleRepeat} repeatMode={activeRepeatMode} volumeLevel={currentVolume} muted={currentMuted} onVolumeChange={changeVolume} onToggleMute={toggleMute} onSuspendYoutube={suspendRoomYoutube} onResumeYoutube={resumeRoomYoutube} youtubeState={youtubeState} playerState={playbackState} onRegisterDismissible={registerDismissible} youtubePlayer={<YoutubeEmbed ref={youtubeRef} track={currentTrack} sharedPlayback={roomPlayback} resumeAtSeconds={suspendedRoomVideoRef.current?.trackId === currentTrack.id && suspendedRoomVideoRef.current.updatedAt === roomPlayback?.updatedAt ? suspendedRoomVideoRef.current.currentTime : undefined} resumePlaying={suspendedRoomVideoRef.current?.trackId === currentTrack.id && suspendedRoomVideoRef.current.updatedAt === roomPlayback?.updatedAt ? suspendedRoomVideoRef.current.isPlaying : undefined} onState={handleYoutubeState} onEnded={handleYoutubeEnded} placement="room"/>}/> : <>
    <Sidebar active={activeNav} onNavigate={navigate} onCreatePlaylist={() => notify('Playlist creation will be available when Jammy can save library data.')}/>
    <main className="main-content">
      <header className="topbar"><div className="history-controls"><button className="round-button" aria-label="Go back" onClick={() => notify('You’re at the start')}><span>‹</span></button><button className="round-button" aria-label="Go forward"><span>›</span></button></div><label className="search-box"><Icon name="search" size={18}/><input ref={searchInputRef} value={query} onFocus={() => navigate('Search')} onChange={(e) => { setQuery(e.target.value); navigate('Search') }} placeholder="What do you want to hear?" aria-label="Search music"/><kbd>Ctrl K</kbd></label><button className="upgrade-button" onClick={() => notify('Jammy is in preview')}>Explore Jammy <Icon name="arrow" size={14}/></button><button className="top-avatar" aria-label="Your profile">J</button></header>
      {activeNav === 'Home' ? <>
      <section className="welcome-row"><div><p className="eyebrow">TUESDAY, OCTOBER 27</p><h1>Good evening, Jordan<span>.</span></h1><p className="welcome-subtitle">A little music goes a long way. Find your next favorite.</p></div><div className="welcome-actions"><button className="outline-action" onClick={() => openRoomDialog('join')}><Icon name="users" size={17}/> Join a room</button><button className="primary-action" onClick={() => openRoomDialog('create')}><Icon name="plus" size={18}/> Create a room</button></div></section>
      <section className="hero-card"><div className="hero-copy"><div className="hero-kicker"><span className="hero-spark">✳</span> YOUR SPACE, YOUR SOUND</div><h2>Music hits<br/>different <em>together.</em></h2><p>Set up a listening room, invite your people, and let the good songs find you.</p><button className="hero-button" onClick={() => openRoomDialog('create')}>Start a listening room <Icon name="arrow" size={16}/></button><div className="hero-foot"><span className="mini-avatars"><i>M</i><i>L</i><i>N</i><i>+</i></span><span>Good music is better shared</span></div></div><div className="hero-visual"><div className="hero-sun"/><div className="hero-ring ring-one"/><div className="hero-ring ring-two"/><div className="hero-record"><div className="record-label"><span>side A</span><b>JAM<br/>SESSIONS</b><small>001 · 33⅓ RPM</small></div></div><div className="hero-note note-top">♫</div><div className="hero-note note-bottom">♪</div><div className="hero-caption"><i/> NOW PLAYING <b>GOOD THINGS TAKE TIME</b></div></div></section>
      <section className="section-block quick-section"><div className="section-heading"><div><p className="eyebrow">PICK UP WHERE YOU LEFT OFF</p><h2>Recently played</h2></div><button className="text-link" onClick={() => navigate('Your library')}>See all <Icon name="arrow" size={14}/></button></div><div className="track-list"><div className="track-header"><span>#</span><span>TITLE</span><span>ALBUM</span><span><Icon name="queue" size={14}/></span></div>{tracks.slice(0, 4).map((track, index) => <TrackCard key={track.title} track={track} index={index} active={currentTrack.title === track.title} onPlay={playTrack}/>)}</div></section>
      <section className="section-block mixes-section"><div className="section-heading"><div><p className="eyebrow">MADE FOR YOUR MOOD</p><h2>Find your frequency</h2></div><button className="text-link" onClick={() => navigate('Your library')}>All mixes <Icon name="arrow" size={14}/></button></div><div className="mix-grid">{mixes.map((mix) => <MixCard key={mix.title} mix={mix} onPlay={() => notify('This sample mix has no playable audio yet.')}/>)}</div></section>
      <section className="social-section"><div className="social-copy"><div className="social-icon"><Icon name="users" size={19}/></div><div><p className="eyebrow">GOOD TASTE TRAVELS</p><h2>Your friends have the aux.</h2><p>See what your people are into, then join the session.</p></div></div><div className="social-friends">{friends.map((friend) => <div className="social-friend" key={friend.name}><span className={`avatar ${friend.color}`}>{friend.initials}<i/></span><span><b>{friend.name}</b><small><i className="tiny-eq">♫</i> {friend.track}</small></span><button className="listen-button" onClick={() => notify(`Room invites are coming soon`)}>Listen in <Icon name="arrow" size={13}/></button></div>)}</div><button className="social-footer" onClick={() => notify('Friend activity is getting warmed up')}>See everyone’s activity <Icon name="arrow" size={14}/></button></section>
      <footer className="page-footer"><span>Made for the moments between songs.</span><span>JAMMY <i>●</i> 2026</span></footer>
      </> : activeNav === 'Search' ? <SearchPage query={query} currentTrack={currentTrack} onPlayTrack={playTrack} onNotice={notify} onAddToRoom={addYouTubeToRoom} youtubeConsent={youtubeConsent} onAcceptYouTube={acceptYouTube}/> : <LibraryPage activeTab={libraryTab} onTabChange={setLibraryTab} currentTrack={currentTrack} onPlayTrack={playTrack} onNotice={notify}/>}
    </main>
    {roomDialogMode && <RoomDialog key={roomDialogMode} initialMode={roomDialogMode} onClose={() => { setRoomDialogMode(null); pendingRoomTrackRef.current = null }} onRoomReady={enterRoom} onRegisterDismissible={registerDismissible}/>}
    {toast && <div className="toast" role="status">{toast}</div>}
    </>}
    {!roomSession && <MusicPlayer track={currentTrack} repeatMode={activeRepeatMode} onToggleRepeat={cycleRepeat} onOpenNowPlaying={openNowPlaying} volumeLevel={currentVolume} muted={currentMuted} onTrackChange={changeTrack} onCreateRoom={() => openRoomDialog('create')} audioState={playbackState} onTogglePlay={handlePlayerToggle} onSeek={handlePlayerSeek} onVolumeChange={changeVolume} onToggleMute={toggleMute} youtubeState={playbackState}/>}
    {nowPlayingOpen && !roomSession && <NowPlayingOverlay track={currentTrack} playerState={playbackState} repeatMode={activeRepeatMode} onTogglePlay={handlePlayerToggle} onSeek={handlePlayerSeek} onToggleRepeat={cycleRepeat} volume={currentVolume} muted={currentMuted} onVolumeChange={changeVolume} onToggleMute={toggleMute} roomActive={false} roomQueue={roomQueue} onSelectQueueItem={selectRoomQueueItem} onSelectTrack={(trackOrDirection) => typeof trackOrDirection === 'number' ? changeTrack(trackOrDirection) : playTrack(trackOrDirection)} activeTab={expandedTab} onTabChange={setExpandedTab} onClose={closeNowPlaying} shortcutsOpen={shortcutsOpen} onToggleShortcuts={() => setShortcutsOpen((value) => !value)} youtubePlayer={currentTrack.provider === 'youtube' ? <div className="expanded-youtube-slot"><YoutubeEmbed ref={youtubeRef} track={currentTrack} onState={handleYoutubeState} onEnded={handleYoutubeEnded} startAtSeconds={youtubeState.currentTime} autoplayOnReady={youtubeAutoplayRequested} placement="inline"/></div> : null}/>}
  </div>
}

export default App

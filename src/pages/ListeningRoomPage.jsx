import { useEffect, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { tracks } from '../../shared/catalog.js'
import { leaveRoom } from '../services/roomApi.js'
import { connectToRoom } from '../services/roomSocket.js'
import { asYouTubeTrack, searchYouTube } from '../services/youtubeApi.js'
import { getTrackLyrics } from '../services/lyricsProvider.js'
import { acceptYouTubeNotice, hasYouTubeConsent } from '../services/youtubeConsent.js'

const avatarColors = ['avatar-pink', 'avatar-blue', 'avatar-lime']

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

function trackArt(track, className = '') {
  const thumbnail = track?.thumbnails?.medium || track?.thumbnails?.default
  return thumbnail
    ? <img className={`room-track-thumbnail ${className}`} src={thumbnail} alt="" loading="lazy" />
    : <span className={`room-track-art art-${track?.art || 'lime'} ${className}`}>{track?.initials || '♪'}</span>
}

export default function ListeningRoomPage({
  session, query, onQueryChange, sampleTrack, onLeave, onPlaybackState, onSocketReady,
  onPlaybackCommand, onTrackChange, onToggleRepeat, repeatMode = 'off', volumeLevel = 0.72, muted = false,
  onVolumeChange, onToggleMute, onSuspendYoutube, onResumeYoutube, youtubePlayer, youtubeState, playerState, onQueueState, onRegisterDismissible,
}) {
  const [room, setRoom] = useState(session.room)
  const [queue, setQueue] = useState([])
  const [playback, setPlayback] = useState({ currentTrackId: null, isPlaying: false, positionMs: 0, updatedAt: null })
  const [messages, setMessages] = useState([])
  const [chatText, setChatText] = useState('')
  const [chatError, setChatError] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [queueLoading, setQueueLoading] = useState(true)
  const [queueError, setQueueError] = useState('')
  const [connectionStatus, setConnectionStatus] = useState('connecting')
  const [error, setError] = useState('')
  const [leaving, setLeaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [searchResults, setSearchResults] = useState([])
  const [searchStatus, setSearchStatus] = useState('idle')
  const [searchError, setSearchError] = useState('')
  const [youtubeConsent, setYoutubeConsent] = useState(() => hasYouTubeConsent())
  const [activeRoomTab, setActiveRoomTab] = useState('player')
  const [playerView, setPlayerView] = useState('turntable')
  const [lyricsState, setLyricsState] = useState({ trackId: null, status: 'unavailable' })
  const socketRef = useRef(null)
  const searchInputRef = useRef(null)
  const chatEndRef = useRef(null)
  const currentTrack = playback.currentTrack ?? tracks.find((track) => track.id === playback.currentTrackId)
  const duration = playerState?.duration || 0
  const currentTime = Math.min(playerState?.currentTime || 0, duration || 0)

  useEffect(() => {
    if (currentTrack?.provider !== 'youtube' && playerView === 'video') setPlayerView('turntable')
  }, [currentTrack?.id, currentTrack?.provider])

  useEffect(() => {
    if (playerView !== 'lyrics') return undefined
    let active = true
    if (!currentTrack) {
      setLyricsState({ trackId: null, status: 'unavailable' })
      return undefined
    }
    setLyricsState({ trackId: currentTrack.id, status: 'loading' })
    getTrackLyrics(currentTrack).then((result) => { if (active) setLyricsState({ ...result, trackId: currentTrack.id }) })
    return () => { active = false }
  }, [currentTrack?.id, playerView])

  useEffect(() => {
    const socket = connectToRoom(session)
    socketRef.current = socket
    onSocketReady?.(socket)
    socket.on('connect', () => { setConnectionStatus('connected'); setError('') })
    socket.on('disconnect', () => setConnectionStatus('reconnecting'))
    socket.on('connect_error', (connectError) => {
      setConnectionStatus('offline')
      setError(connectError.message === 'ROOM_SESSION_INVALID' ? 'This room session expired. Leave and join the room again.' : 'Can’t reach the room server. Reconnecting…')
    })
    socket.on('room:state', (nextRoom) => setRoom(nextRoom))
    socket.on('queue:state', (state) => { const nextQueue = state.queue ?? []; setQueue(nextQueue); onQueueState?.(nextQueue); setQueueLoading(false) })
    socket.on('playback:state', (state) => { setPlayback(state); onPlaybackState?.(state) })
    socket.on('chat:history', (state) => setMessages(state.messages ?? []))
    socket.on('chat:message', (message) => setMessages((previous) => previous.some((item) => item.id === message.id) ? previous : [...previous, message].slice(-100)))
    socket.on('room:closed', () => { setConnectionStatus('closed'); setError('This room has closed.') })
    return () => { socket.disconnect(); socketRef.current = null; onSocketReady?.(null) }
  }, [session, onPlaybackState, onQueueState, onSocketReady])

  useEffect(() => {
    if (searchStatus === 'idle') return undefined
    const dismiss = () => { setSearchStatus('idle'); setSearchError(''); setSearchResults([]) }
    onRegisterDismissible?.('room-search', dismiss)
    return () => onRegisterDismissible?.('room-search', null)
  }, [searchStatus, onRegisterDismissible])

  useEffect(() => { chatEndRef.current?.scrollIntoView?.({ block: 'nearest' }) }, [messages])

  const emitRoomAction = (eventName, payload, onSuccess) => {
    if (!socketRef.current?.connected) {
      setQueueError('Reconnect to the room before changing the shared queue or playback.')
      return
    }
    setQueueError('')
    socketRef.current.emit(eventName, payload, (result) => {
      if (!result?.ok) setQueueError(result?.error || 'The shared room state could not be updated.')
      else onSuccess?.(result)
    })
  }

  const runSearch = async (event) => {
    event.preventDefault()
    if (!query.trim()) return
    if (!youtubeConsent) { setSearchStatus('consent'); return }
    setSearchError('')
    setSearchStatus('loading')
    try {
      const results = await searchYouTube(query.trim())
      setSearchResults(results)
      setSearchStatus(results.length ? 'ready' : 'empty')
    } catch (searchFailure) {
      setSearchResults([])
      setSearchError(searchFailure.message)
      setSearchStatus('error')
    }
  }

  const addSearchResult = (result, playNow = false) => {
    const track = asYouTubeTrack(result)
    emitRoomAction('queue:add', { trackId: track.id, trackData: track }, (added) => {
      setSearchStatus('idle')
      if (!playNow) return
      const addedItem = [...(added.state?.queue ?? [])].reverse().find((item) => item.trackId === track.id)
      if (addedItem) emitRoomAction('playback:select', { itemId: addedItem.itemId, playImmediately: true })
    })
  }

  const sendMessage = (event) => {
    event.preventDefault()
    if (!socketRef.current?.connected) { setChatError('Reconnect to the room before sending a message.'); return }
    setChatSending(true)
    setChatError('')
    socketRef.current.emit('chat:send', { message: chatText }, (result) => {
      setChatSending(false)
      if (!result?.ok) { setChatError(result?.error || 'The message could not be sent.'); return }
      setChatText('')
    })
  }

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(room.code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch { setError('Clipboard access was blocked. You can still select and copy the room code.') }
  }

  const handleLeave = async () => {
    setLeaving(true)
    setError('')
    try {
      await leaveRoom({ code: room.code, memberId: session.member.id, memberToken: session.memberToken })
      socketRef.current?.disconnect()
      onLeave()
    } catch (leaveError) {
      if (leaveError.message.includes('session is no longer valid')) {
        socketRef.current?.disconnect()
        onLeave()
        return
      }
      setError(leaveError.message)
      setLeaving(false)
    }
  }

  const activePlayerState = currentTrack?.provider === 'youtube' ? youtubeState : playerState
  const playerStatus = activePlayerState?.status || 'ready'
  const youtubeDetached = currentTrack?.provider === 'youtube' && (playerView !== 'video' || activeRoomTab !== 'player')
  const roomIsPlaying = currentTrack?.provider === 'youtube'
    ? playerStatus === 'playing' || (playerStatus === 'loading' && Boolean(playback.isPlaying))
    : Boolean(playback.isPlaying)
  const activeLyricsState = currentTrack ? (lyricsState.trackId === currentTrack.id ? lyricsState : { status: 'loading' }) : lyricsState

  const changePlayerView = (view) => {
    if (view !== 'video' && playerView === 'video') onSuspendYoutube?.()
    setPlayerView(view)
  }
  const changeRoomTab = (tab) => {
    if (tab !== 'player' && activeRoomTab === 'player' && playerView === 'video') onSuspendYoutube?.()
    setActiveRoomTab(tab)
  }
  const handlePlayerTabKeyDown = (event, tab) => {
    const enabledViews = currentTrack?.provider === 'youtube' ? ['turntable', 'lyrics', 'video'] : ['turntable', 'lyrics']
    const index = enabledViews.indexOf(tab)
    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % enabledViews.length
      : event.key === 'ArrowLeft' ? (index - 1 + enabledViews.length) % enabledViews.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? enabledViews.length - 1 : -1
    if (nextIndex < 0) return
    event.preventDefault()
    const nextView = enabledViews[nextIndex]
    changePlayerView(nextView)
    document.getElementById(`room-tab-${nextView}`)?.focus()
  }
  const toggleRoomPlayback = () => {
    if (youtubeDetached) {
      onResumeYoutube?.()
      setActiveRoomTab('player')
      setPlayerView('video')
      onPlaybackCommand?.({ isPlaying: true, positionMs: Math.round(currentTime * 1000) })
      return
    }
    onPlaybackCommand?.({ isPlaying: !roomIsPlaying, positionMs: Math.round(currentTime * 1000) })
  }

  return <main className="listening-room-page">
    <header className="room-header">
      <a className="brand room-brand" href="#home" onClick={(event) => event.preventDefault()} aria-label="Jammy"><span className="brand-mark">j</span><span>jammy<span className="brand-period">.</span></span></a>
      <form className="room-top-search" onSubmit={runSearch} role="search">
        <Icon name="search" size={17}/>
        <input ref={searchInputRef} value={query} onChange={(event) => onQueryChange(event.target.value)} maxLength={100} placeholder="Search songs and artists" aria-label="Search music" />
        <button type="submit" disabled={!query.trim() || searchStatus === 'loading'}>{searchStatus === 'loading' ? 'Searching…' : 'Search'}</button>
        {searchStatus !== 'idle' && <div className="room-search-popover">
          {searchStatus === 'consent' && <div className="room-search-message"><p>Search terms go to Jammy’s server. YouTube results load the official YouTube player. Review YouTube’s <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">Terms of Service</a> and <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.</p><button type="button" onClick={() => { if (acceptYouTubeNotice()) { setYoutubeConsent(true); setSearchStatus('idle') } else setSearchError('Browser storage is unavailable. Enable it before using YouTube search.') }}>Agree and enable search</button></div>}
          {searchStatus === 'error' && <p className="room-search-message" role="status">{searchError}</p>}
          {searchStatus === 'empty' && <p className="room-search-message">No YouTube videos matched that search.</p>}
          {searchStatus === 'ready' && searchResults.map((result) => <article className="room-search-result" key={result.videoId}>
            {result.thumbnails?.default ? <img src={result.thumbnails.default} alt=""/> : <span className="room-search-result-fallback">YT</span>}
            <span className="room-search-result-copy"><b>{result.title}</b><small>{result.channelName} · YouTube</small></span>
            <button type="button" onClick={() => addSearchResult(result)} disabled={queue.length >= 50} aria-label={`Add ${result.title} to queue`}>Add</button>
            <button type="button" className="room-search-play" onClick={() => addSearchResult(result, true)} disabled={queue.length >= 50} aria-label={`Play ${result.title}`}>Play</button>
          </article>)}
        </div>}
      </form>
      <div className="room-header-actions"><span className={`connection-pill ${connectionStatus}`}><i/>{connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'connecting' ? 'Connecting' : connectionStatus === 'closed' ? 'Room closed' : 'Reconnecting'}</span><button className="outline-action room-leave-top" onClick={handleLeave} disabled={leaving}>{leaving ? 'Leaving…' : 'Leave room'}</button></div>
    </header>

    <div className="room-heading">
      <div><p className="eyebrow">LISTENING ROOM</p><h1>{room.name}<span>.</span></h1><p>Playback commands are shared. Each member plays audio in their own browser.</p></div>
      <div className="room-code-card"><span className="eyebrow">ROOM CODE</span><div><strong>{room.code}</strong><button className="outline-action copy-code" onClick={handleCopyCode}>{copied ? 'Copied' : 'Copy code'}</button></div></div>
    </div>

    {error && <p className="room-page-error" role="status">{error}</p>}

    <nav className="room-mobile-tabs" aria-label="Listening room sections">
      {[['queue', 'Queue'], ['player', 'Player'], ['chat', 'Chat']].map(([tab, label]) => <button key={tab} className={activeRoomTab === tab ? 'active' : ''} aria-current={activeRoomTab === tab ? 'page' : undefined} onClick={() => changeRoomTab(tab)}>{label}{tab === 'chat' && messages.length > 0 ? ` · ${messages.length}` : ''}</button>)}
    </nav>

    <div className="room-layout">
      <aside className={`room-panel room-sidebar-panel ${activeRoomTab === 'queue' ? 'mobile-active' : ''}`}>
        <section className="room-members-section">
          <div className="room-panel-heading"><div><p className="eyebrow">THE ROOM</p><h2>Listening together</h2></div><span className="room-count"><Icon name="users" size={15}/>{room.members.length}/{room.maxMembers}</span></div>
          <div className="room-member-list">{room.members.map((member, index) => <div className="room-member" key={member.id}><span className={`avatar ${avatarColors[index % avatarColors.length]}`}>{member.displayName.trim().charAt(0).toUpperCase()}<i className={member.online ? 'member-online' : 'member-offline'}/></span><span className="room-member-name"><b>{member.displayName}{member.id === session.member.id ? ' (you)' : ''}</b><small>{member.role === 'owner' ? 'Room host' : member.online ? 'Here now' : 'Reconnecting'}</small></span>{member.role === 'owner' && <span className="host-tag">HOST</span>}</div>)}</div>
        </section>

        <section className="queue-section">
          <div className="room-panel-heading"><div><p className="eyebrow">UP NEXT</p><h2>Shared queue</h2></div><span className="room-count">{queue.length}/50</span></div>
          <button className="queue-add-music" onClick={() => { setActiveRoomTab('player'); searchInputRef.current?.focus() }}><Icon name="plus" size={15}/> Add music</button>
          {queueError && <p className="queue-error" role="status">{queueError}</p>}
          <div className="queue-current-separator"><span className="eyebrow">NOW PLAYING</span></div>
          <div className={`queue-current-track ${currentTrack ? 'is-playing' : ''}`}>
            {currentTrack ? <>{trackArt(currentTrack)}<span><b>{currentTrack.title}</b><small>{currentTrack.channelName || currentTrack.artist}</small></span><Icon name="volume" size={14}/></> : <><span className="room-empty-icon"><Icon name="queue" size={16}/></span><span><b>Nothing selected</b><small>Select an upcoming track to play</small></span></>}
          </div>
          <div className="queue-current-separator"><span className="eyebrow">UPCOMING TRACKS</span></div>
          <div className="queue-scroll">
            {queueLoading ? <p className="room-empty-queue">Loading shared queue…</p> : queue.length === 0 ? <div className="room-empty-panel"><b>The queue is empty</b><p>Search for music to add a video.</p></div> : <ol className="shared-queue-list">{queue.map((item, index) => {
              const track = item.trackData ?? tracks.find((entry) => entry.id === item.trackId)
              if (!track) return null
              return <li className="shared-queue-item" key={item.itemId}>
                {trackArt(track)}
                <span className="shared-queue-track"><b title={track.title}>{track.title}</b><small title={`${track.channelName || track.artist} · added by ${item.addedBy}`}>{track.channelName || track.artist} · {item.addedBy}</small></span>
                <span className="queue-reorder-actions"><button className="queue-icon-button" onClick={() => emitRoomAction('queue:reorder', { itemId: item.itemId, toIndex: Math.max(0, index - 1) })} disabled={index === 0} aria-label={`Move ${track.title} up`}>↑</button><button className="queue-icon-button" onClick={() => emitRoomAction('queue:reorder', { itemId: item.itemId, toIndex: Math.min(queue.length - 1, index + 1) })} disabled={index === queue.length - 1} aria-label={`Move ${track.title} down`}>↓</button></span>
                <button className="queue-icon-button queue-select-button" onClick={() => emitRoomAction('playback:select', { itemId: item.itemId, playImmediately: true })} aria-label={`Play ${track.title}`}>▶</button>
                <button className="queue-icon-button queue-remove-button" onClick={() => emitRoomAction('queue:remove', { itemId: item.itemId })} aria-label={`Remove ${track.title}`}>×</button>
              </li>
            })}</ol>}
          </div>
        </section>
      </aside>

      <section className={`room-panel room-player-column ${activeRoomTab === 'player' ? 'mobile-active' : ''}`}>
        <div className="room-panel-heading"><div><p className="eyebrow">ON THE TURNTABLE</p><h2>Now playing</h2></div><span className={`playback-status playback-${playerStatus}`}>{playerStatus === 'playing' ? 'Playing' : playerStatus === 'loading' ? 'Buffering' : playerStatus === 'error' ? 'Unavailable' : youtubeDetached ? 'Paused in this view' : playback.isPlaying ? 'Waiting for player' : currentTrack ? 'Paused' : 'Ready when you are'}</span></div>
        <div className="room-player-view-tabs" role="tablist" aria-label="Player views">
          <button type="button" role="tab" id="room-tab-turntable" aria-selected={playerView === 'turntable'} aria-controls="room-panel-turntable" tabIndex={playerView === 'turntable' ? 0 : -1} className={playerView === 'turntable' ? 'active' : ''} onKeyDown={(event) => handlePlayerTabKeyDown(event, 'turntable')} onClick={() => changePlayerView('turntable')}>Turntable</button>
          <button type="button" role="tab" id="room-tab-lyrics" aria-selected={playerView === 'lyrics'} aria-controls="room-panel-lyrics" tabIndex={playerView === 'lyrics' ? 0 : -1} className={playerView === 'lyrics' ? 'active' : ''} onKeyDown={(event) => handlePlayerTabKeyDown(event, 'lyrics')} onClick={() => changePlayerView('lyrics')}>Lyrics</button>
          <button type="button" role="tab" id="room-tab-video" aria-selected={playerView === 'video'} aria-controls="room-panel-video" tabIndex={playerView === 'video' ? 0 : -1} className={playerView === 'video' ? 'active' : ''} onKeyDown={(event) => handlePlayerTabKeyDown(event, 'video')} onClick={() => changePlayerView('video')} disabled={currentTrack?.provider !== 'youtube'}>Video</button>
        </div>
        <div className={`room-media-stage room-media-${playerView}`}>
          <div className="room-view-panel room-turntable-panel" id="room-panel-turntable" role="tabpanel" aria-labelledby="room-tab-turntable" hidden={playerView !== 'turntable'}>
            <div className={`room-vinyl-stage ${currentTrack && playerStatus === 'playing' ? 'record-turning' : ''}`} aria-hidden="true"><div className="room-vinyl"><span className="vinyl-label">{currentTrack ? trackArt(currentTrack, 'vinyl-cover') : <b>J</b>}<small>JAMMY · SIDE A</small></span></div><span className="vinyl-tonearm"/></div>
            {!currentTrack && <p className="room-player-empty">Your turntable is ready for a first track.</p>}
            {currentTrack?.provider === 'youtube' && <p className="room-player-policy-note">YouTube playback pauses in Turntable and Lyrics views. Select Video to resume the official player.</p>}
          </div>
          <div className="room-view-panel room-lyrics-panel" id="room-panel-lyrics" role="tabpanel" aria-labelledby="room-tab-lyrics" hidden={playerView !== 'lyrics'}>
            <div className="room-lyrics-heading"><h3>{currentTrack?.title || 'Lyrics'}</h3><p>{currentTrack ? currentTrack.channelName || currentTrack.artist : 'Select a track from the shared queue.'}</p></div>
            <div className={`room-lyrics-content room-lyrics-${activeLyricsState.status}`} aria-live="polite" aria-busy={activeLyricsState.status === 'loading'}>
              {activeLyricsState.status === 'loading' && <p>Checking for authorized lyrics…</p>}
              {activeLyricsState.status === 'available' && <p className="room-lyrics-text">{activeLyricsState.lyrics}</p>}
              {activeLyricsState.status === 'unavailable' && <><b>Lyrics aren’t available for this track.</b><p>Jammy doesn’t have an authorized lyrics provider connected yet.</p></>}
              {activeLyricsState.status === 'error' && <><b>Lyrics couldn’t be loaded.</b><p>{activeLyricsState.message || 'Try again later.'}</p></>}
            </div>
          </div>
          <div className="room-view-panel room-video-panel" id="room-panel-video" role="tabpanel" aria-labelledby="room-tab-video" hidden={playerView !== 'video'}>
            {playerView === 'video' && currentTrack?.provider === 'youtube' && activeRoomTab === 'player' ? <div className="room-video-shell">{youtubePlayer}</div> : <p className="room-player-empty">Select a YouTube video to use Video view.</p>}
          </div>
        </div>
        {playerView !== 'lyrics' && <div className="room-track-heading">{currentTrack ? <><h3 title={currentTrack.title}>{currentTrack.title}</h3><p>{currentTrack.channelName || currentTrack.artist} <span>·</span> {currentTrack.provider === 'youtube' ? 'YouTube' : currentTrack.album}</p></> : <><h3>Choose the first track</h3><p>Search above or select a track from the shared queue.</p></>}</div>}
        <div className="room-player-controls">
          <div className="room-transport-controls"><button className="icon-button" disabled title="Previous track is not supported by the shared queue yet" aria-label="Previous track unavailable"><Icon name="previous" size={18}/></button><button className="play-button" onClick={toggleRoomPlayback} disabled={!currentTrack} aria-label={youtubeDetached ? 'Open Video view to resume YouTube playback' : roomIsPlaying ? 'Pause shared playback' : 'Play shared playback'}><Icon name={youtubeDetached || !roomIsPlaying ? 'play' : 'pause'} size={17}/></button><button className="icon-button" onClick={() => onTrackChange?.(1)} disabled={!currentTrack} title="Next queued track" aria-label="Next queued track"><Icon name="next" size={18}/></button><button className={`icon-button repeat-control repeat-${repeatMode}`} onClick={onToggleRepeat} aria-label={`${repeatMode === 'all' ? 'Repeat All' : repeatMode === 'one' ? 'Repeat One' : 'Repeat Off'} (R)`} aria-pressed={repeatMode !== 'off'} title={`Cycle repeat mode (R): ${repeatMode === 'all' ? 'Repeat All' : repeatMode === 'one' ? 'Repeat One' : 'Repeat Off'}`}><Icon name="repeat" size={17}/>{repeatMode === 'one' && <span aria-hidden="true">1</span>}</button></div>
          <div className="room-playback-seek"><div><span>{formatTime(currentTime)}</span><span>{duration ? formatTime(duration) : '--:--'}</span></div><input aria-label="Shared playback position" type="range" min="0" max={duration || 1} step="1" value={Math.min(currentTime, duration) || 0} disabled={!currentTrack || !duration} onChange={(event) => onPlaybackCommand?.({ isPlaying: playback.isPlaying, positionMs: Number(event.target.value) * 1000 })}/></div>
        </div>
        <div className="room-volume-control"><button type="button" className="icon-button" onClick={onToggleMute} disabled={youtubeDetached} aria-label={muted ? 'Unmute local playback' : 'Mute local playback'} aria-pressed={muted}><Icon name={muted ? 'volumeMuted' : 'volume'} size={17}/></button><input aria-label="Local playback volume" type="range" min="0" max="100" step="1" value={Math.round(volumeLevel * 100)} disabled={youtubeDetached} onChange={(event) => onVolumeChange?.(Number(event.target.value) / 100)}/></div>
        {currentTrack?.provider !== 'youtube' && <div className="room-player-empty">{currentTrack ? 'This selection uses Jammy’s local audio player.' : 'Your turntable is ready for a first track.'}</div>}
        {youtubeState?.error && <p className="room-player-error" role="status">{youtubeState.error}</p>}
        <p className="room-playback-note">Audio plays separately for each listener. Browser autoplay and video availability may vary.</p>
      </section>

      <aside className={`room-panel room-chat-panel ${activeRoomTab === 'chat' ? 'mobile-active' : ''}`}>
        <div className="room-chat-heading"><div><p className="eyebrow">IN GOOD COMPANY</p><h2>Room chat</h2></div><span className="room-count">{room.members.length} {room.members.length === 1 ? 'listener' : 'listeners'}</span></div>
        <div className="room-chat-avatars" aria-label="Room members">{room.members.map((member, index) => <span className={`avatar ${avatarColors[index % avatarColors.length]}`} key={member.id} title={`${member.displayName}${member.online ? ' · online' : ' · reconnecting'}`}>{member.displayName.trim().charAt(0).toUpperCase()}<i className={member.online ? 'member-online' : 'member-offline'}/></span>)}</div>
        <div className="room-chat-history" aria-live="polite" aria-label="Room messages">
          {messages.length === 0 ? <div className="chat-empty-state"><span>✳</span><b>The room is yours.</b><p>Say hello or share what you think of the track.</p></div> : messages.map((message) => {
            const memberIndex = room.members.findIndex((member) => member.id === message.memberId)
            return <article className="room-chat-message" key={message.id}>
              <span className={`avatar ${avatarColors[Math.max(0, memberIndex) % avatarColors.length]}`}>{message.displayName.trim().charAt(0).toUpperCase()}</span>
              <div><div className="room-chat-meta"><b>{message.displayName}</b><time dateTime={message.sentAt}>{new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(message.sentAt))}</time></div><p>{message.message}</p></div>
            </article>
          })}
          <div ref={chatEndRef}/>
        </div>
        <form className="room-chat-form" onSubmit={sendMessage}><label className="sr-only" htmlFor="room-chat-input">Message the room</label><input id="room-chat-input" value={chatText} onChange={(event) => setChatText(event.target.value)} maxLength={500} placeholder="Message the room…" disabled={connectionStatus !== 'connected' || chatSending}/><button type="submit" aria-label="Send message" disabled={!chatText.trim() || connectionStatus !== 'connected' || chatSending}><Icon name="arrow" size={17}/></button></form>
        {chatError && <p className="chat-error" role="status">{chatError}</p>}
        <div className="voice-placeholder"><span><Icon name="volume" size={15}/> Voice chat</span><small>Not available yet</small></div>
      </aside>
    </div>

    <footer className="room-footer"><span><i/> {room.members.filter((member) => member.online).length} listeners online · {room.code}</span><span>Playback is best-effort and may differ between browsers.</span></footer>
    <button className="room-leave-mobile" onClick={handleLeave} disabled={leaving}>{leaving ? 'Leaving…' : 'Leave room'}</button>
  </main>
}

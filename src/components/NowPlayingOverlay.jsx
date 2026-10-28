import Icon from './Icon.jsx'
import { tracks } from '../../shared/catalog.js'
import { formatAudioTime, sliderValueFromVolume, volumeFromSliderValue } from '../playback/audioState.js'
import { repeatModeLabel } from '../playback/repeat.js'

const tabs = [
  ['player', 'Player'],
  ['lyrics', 'Lyrics'],
  ['queue', 'Queue'],
]

const shortcuts = [
  ['Space', 'Play or pause'], ['Shift + N', 'Next track'], ['Shift + P', 'Previous track'],
  ['R', 'Cycle repeat mode'], ['M', 'Mute or unmute'], ['← / →', 'Seek 5 seconds'],
  ['↑ / ↓', 'Adjust volume'], ['J', 'Open or close Now Playing'], ['Esc', 'Close the top overlay'],
]

function artwork(track) {
  const image = track?.thumbnails?.high || track?.thumbnails?.medium || track?.thumbnails?.default
  return image ? <img src={image} alt=""/> : <span className={`expanded-art-fallback art-${track?.art || 'lime'}`}>{track?.initials || '♪'}</span>
}

export default function NowPlayingOverlay({
  track, playerState, repeatMode, onTogglePlay, onSeek, onToggleRepeat, volume, muted,
  onVolumeChange, onToggleMute, roomActive, roomQueue = [], onSelectQueueItem, onSelectTrack,
  activeTab, onTabChange, onClose, shortcutsOpen, onToggleShortcuts, youtubePlayer,
}) {
  const duration = playerState?.duration || 0
  const currentTime = Math.min(playerState?.currentTime || 0, duration || 0)
  const roomItems = roomQueue.map((item) => ({ key: item.itemId, track: item.trackData ?? tracks.find((entry) => entry.id === item.trackId), item }))
  const libraryItems = tracks.map((item) => ({ key: item.id, track: item }))
  const queueItems = (roomActive ? roomItems : libraryItems).filter((entry) => entry.track)

  const panelClass = (tab) => `expanded-panel expanded-${tab}${activeTab === tab ? ' expanded-panel-active' : ''}`

  return <div className="expanded-player-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="expanded-player" role="dialog" aria-modal="true" aria-labelledby="expanded-player-title">
      <header className="expanded-player-header">
        <div><p className="eyebrow">JAMMY · NOW PLAYING</p><h2 id="expanded-player-title">Your listening space</h2></div>
        <div className="expanded-header-actions"><button className="shortcut-help-button" onClick={onToggleShortcuts} aria-expanded={shortcutsOpen}>Keyboard shortcuts</button><button className="icon-button expanded-close" onClick={onClose} aria-label="Close Now Playing (Escape)"><Icon name="close" size={20}/></button></div>
      </header>

      <nav className="expanded-mobile-tabs" aria-label="Now Playing panels">{tabs.map(([key, label]) => <button key={key} className={activeTab === key ? 'active' : ''} onClick={() => onTabChange(key)}>{label}</button>)}</nav>

      {youtubePlayer}

      <div className="expanded-player-grid">
        <section className={panelClass('player')}>
          <div className="expanded-record-wrap"><div className={`expanded-record ${playerState?.status === 'playing' ? 'is-spinning' : ''}`}>{artwork(track)}<span className="expanded-record-hole"/></div><span className="expanded-tonearm"/></div>
          <div className="expanded-track-copy"><p className="eyebrow">{track?.provider === 'youtube' ? 'YOUTUBE VIDEO' : 'JAMMY CATALOG'}</p><h3>{track?.title || 'Nothing selected'}</h3><p>{track?.channelName || track?.artist || 'Choose a track to begin'}</p><span className={`expanded-status expanded-status-${playerState?.status || 'idle'}`}>{playerState?.status === 'playing' ? 'Playing' : playerState?.status === 'loading' ? 'Buffering' : playerState?.status === 'error' || playerState?.status === 'unavailable' ? 'Playback unavailable' : 'Paused'}</span></div>
          <div className="expanded-progress"><div><span>{formatAudioTime(currentTime)}</span><span>{duration ? formatAudioTime(duration) : track?.duration || '--:--'}</span></div><input aria-label="Track position" type="range" min="0" max={duration || 0} step="0.1" value={currentTime} disabled={!duration} onChange={(event) => onSeek(Number(event.target.value))}/></div>
          <div className="expanded-controls"><button className="icon-button" title={roomActive ? 'Previous track is unavailable in listening rooms' : 'Previous track (Shift+P)'} aria-label="Previous track" disabled={roomActive} onClick={() => onSelectTrack?.(-1)}><Icon name="previous" size={20}/></button><button className="play-button" aria-label={playerState?.status === 'playing' ? 'Pause (Space)' : 'Play (Space)'} onClick={onTogglePlay}><Icon name={playerState?.status === 'playing' ? 'pause' : 'play'} size={19}/></button><button className="icon-button" title="Next track (Shift+N)" aria-label="Next track" onClick={() => onSelectTrack?.(1)}><Icon name="next" size={20}/></button><button className={`icon-button repeat-control repeat-${repeatMode}`} aria-label={`${repeatModeLabel(repeatMode)} (R)`} aria-pressed={repeatMode !== 'off'} title={`Cycle repeat mode: ${repeatModeLabel(repeatMode)} (R)`} onClick={onToggleRepeat}><Icon name="repeat" size={18}/>{repeatMode === 'one' && <span aria-hidden="true">1</span>}</button></div>
          <div className="expanded-volume"><button className="icon-button" aria-label={muted ? 'Unmute (M)' : 'Mute (M)'} title="Mute or unmute (M)" onClick={onToggleMute}><Icon name={muted ? 'volumeMuted' : 'volume'} size={17}/></button><input aria-label="Volume level" type="range" min="0" max="100" step="1" value={sliderValueFromVolume(volume)} onChange={(event) => onVolumeChange(volumeFromSliderValue(event.target.value))}/></div>
        </section>

        <section className={panelClass('lyrics')} aria-labelledby="expanded-lyrics-title"><div className="expanded-section-heading"><div><p className="eyebrow">SING ALONG</p><h3 id="expanded-lyrics-title">Lyrics</h3></div><span className="lyrics-source-note">Jammy preview</span></div><div className="lyrics-unavailable"><span>♪</span><b>Lyrics aren’t available here yet.</b><p>Jammy doesn’t have a licensed lyrics provider connected, so it won’t display or invent song lyrics.</p></div></section>

        <section className={panelClass('queue')} aria-labelledby="expanded-queue-title"><div className="expanded-section-heading"><div><p className="eyebrow">{roomActive ? 'SHARED ROOM' : 'JAMMY PICKS'}</p><h3 id="expanded-queue-title">{roomActive ? 'Room queue' : 'Listening list'}</h3></div><span className="queue-count-label">{queueItems.length} {queueItems.length === 1 ? 'track' : 'tracks'}</span></div>{queueItems.length === 0 ? <div className="expanded-queue-empty">{roomActive ? 'The shared queue is empty.' : 'No tracks are available.'}</div> : <ol className="expanded-queue-list">{queueItems.map(({ key, track: queuedTrack, item }) => <li key={key} className={queuedTrack.id === track?.id ? 'current' : ''}><button onClick={() => roomActive ? onSelectQueueItem?.(item.itemId) : onSelectTrack?.(queuedTrack)} title={`Play ${queuedTrack.title}`}><span className="expanded-queue-art">{artwork(queuedTrack)}</span><span className="expanded-queue-copy"><b>{queuedTrack.title}</b><small>{queuedTrack.channelName || queuedTrack.artist}{roomActive ? ` · ${item.addedBy}` : ''}</small></span><span className="expanded-queue-time">{queuedTrack.duration || '—:—'}</span></button></li>)}</ol>}</section>
      </div>

      {shortcutsOpen && <section className="keyboard-shortcuts-panel" aria-label="Keyboard shortcuts"><div className="expanded-section-heading"><div><p className="eyebrow">QUICK CONTROLS</p><h3>Keyboard shortcuts</h3></div><button className="icon-button" onClick={onToggleShortcuts} aria-label="Close shortcuts"><Icon name="close" size={17}/></button></div><dl>{shortcuts.map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{label}</dd></div>)}</dl><p>Shortcuts pause while you type. Click outside the YouTube player to use Jammy shortcuts; seek and volume need the player to be ready.</p></section>}
    </section>
  </div>
}

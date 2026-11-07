import { useState } from 'react'
import Icon from './Icon.jsx'
import { formatAudioTime, sliderValueFromVolume, volumeFromSliderValue } from '../playback/audioState.js'
import { repeatModeLabel } from '../playback/repeat.js'

export default function MusicPlayer({
  track,
  onTrackChange,
  onCreateRoom,
  audioState,
  onTogglePlay,
  onSeek,
  onVolumeChange,
  onToggleMute,
  roomActive = false,
  youtubeState,
  repeatMode = 'off',
  onToggleRepeat,
  onOpenNowPlaying,
  volumeLevel,
  muted,
}) {
  const [liked, setLiked] = useState(false)
  const youtubeTrack = track.provider === 'youtube'
  const activeState = youtubeTrack ? youtubeState : audioState
  const playing = activeState.status === 'playing'
  const duration = activeState.duration || 0
  const currentTime = Math.min(activeState.currentTime || 0, duration || 0)
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return <footer className="music-player" aria-label="Music player">
      {activeState.error && <div className={`player-status player-status-${activeState.status}`} role="status" aria-live="polite">{activeState.error}</div>}
      <div className="now-playing"><div className={`player-art art-${track.art}`}>{track.initials}</div><button className="now-track" onClick={() => onOpenNowPlaying?.('player')} title="Open Now Playing (J)"><b>{track.title}</b><small>{track.artist}</small></button><button className={`icon-button like-button ${liked ? 'liked' : ''}`} aria-label={liked ? 'Unlike song' : 'Like song'} aria-pressed={liked} onClick={() => setLiked((value) => !value)}><Icon name="heart" size={17}/></button></div>
      <div className="player-center"><div className="player-controls"><button className="icon-button control-subtle" aria-label="Shuffle unavailable" title="Shuffle is not available yet" disabled><Icon name="shuffle" size={17}/></button><button className="icon-button" aria-label="Previous track (Shift+P)" title={roomActive ? 'Previous track is not available in rooms' : 'Previous track (Shift+P)'} onClick={() => onTrackChange(-1)} disabled={roomActive}><Icon name="previous" size={19}/></button><button className="play-button" aria-label={playing ? 'Pause (Space)' : 'Play (Space)'} title="Play or pause (Space)" onClick={onTogglePlay}><Icon name={playing ? 'pause' : 'play'} size={18}/></button><button className="icon-button" aria-label="Next track (Shift+N)" title="Next track (Shift+N)" onClick={() => onTrackChange(1)}><Icon name="next" size={19}/></button><button className={`icon-button repeat-control repeat-${repeatMode}`} aria-label={`${repeatModeLabel(repeatMode)} (R)`} aria-pressed={repeatMode !== 'off'} title={`Cycle repeat mode: ${repeatModeLabel(repeatMode)} (R)`} onClick={onToggleRepeat}><Icon name="repeat" size={17}/>{repeatMode === 'one' && <span aria-hidden="true">1</span>}</button></div><div className="seek-row"><span>{formatAudioTime(currentTime)}</span><input aria-label="Track position (Left/Right Arrow)" title="Seek ±5 seconds with Left/Right Arrow" type="range" min="0" max={duration || 0} step="0.1" value={currentTime} style={{ '--range-progress': `${progress}%` }} disabled={!duration} onChange={(event) => onSeek(Number(event.target.value))}/><span>{duration ? formatAudioTime(duration) : track.duration}</span></div></div>
      <div className="player-extra"><button className="icon-button queue-action" aria-label="Open queue (J)" title="Open Now Playing queue (J)" onClick={() => onOpenNowPlaying?.('queue')}><Icon name="queue" size={18}/></button><button className="icon-button volume-icon" aria-label={`${muted ? 'Unmute' : 'Mute'} (M)`} aria-pressed={muted} title={`Mute or unmute (M)`} onClick={onToggleMute}><Icon name={muted ? 'volumeMuted' : 'volume'} size={18}/></button><input className="volume-slider" aria-label="Volume level (Up/Down Arrow)" title="Change volume with Up/Down Arrow" type="range" min="0" max="100" step="1" value={sliderValueFromVolume(volumeLevel)} style={{ '--range-progress': `${sliderValueFromVolume(volumeLevel)}%` }} onChange={(event) => onVolumeChange(volumeFromSliderValue(event.target.value))}/><button className="room-mini" aria-label="Create a listening room" onClick={onCreateRoom}><span className="room-mini-dot"/><span>Listen together</span><Icon name="arrow" size={14}/></button></div>
    </footer>
}

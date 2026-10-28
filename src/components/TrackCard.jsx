import Icon from './Icon.jsx'

export default function TrackCard({ track, index, onPlay, active }) {
  return <button className={`track-card ${active ? 'is-playing' : ''}`} onClick={() => onPlay(track)}>
    <span className="track-index">{active ? <span className="equalizer"><i/><i/><i/></span> : String(index + 1).padStart(2, '0')}</span>
    <span className={`track-art art-${track.art}`}><span>{track.initials}</span></span>
    <span className="track-info"><b>{track.title}</b><small>{track.artist}</small></span>
    <span className="track-album">{track.album}</span><span className="track-duration">{track.duration}</span>
    <span className="track-play"><Icon name="play" size={16}/></span>
  </button>
}

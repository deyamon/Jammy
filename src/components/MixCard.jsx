import Icon from './Icon.jsx'

export default function MixCard({ mix, onPlay }) {
  return <button className="mix-card" onClick={onPlay}>
    <span className={`mix-art mix-${mix.art}`}><span className="mix-orb"/><span className="mix-art-label">{mix.title}</span></span>
    <span className="mix-meta"><b>{mix.title}</b><small>{mix.subtitle}</small><em>{mix.count}</em></span>
    <span className="mix-play"><Icon name="play" size={18}/></span>
  </button>
}

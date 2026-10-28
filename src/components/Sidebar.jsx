import Icon from './Icon.jsx'

const links = [
  { label: 'Home', icon: 'home' },
  { label: 'Search', icon: 'search' },
  { label: 'Your library', icon: 'library' },
]

export default function Sidebar({ active, onNavigate, onCreatePlaylist }) {
  return <aside className="sidebar">
    <a className="brand" href="#home" onClick={(e) => { e.preventDefault(); onNavigate('Home') }} aria-label="Jammy home"><span className="brand-mark">j</span><span>jammy<span className="brand-period">.</span></span></a>
    <nav className="main-nav" aria-label="Main navigation">
      {links.map((link) => <button key={link.label} className={`nav-link ${active === link.label ? 'active' : ''}`} onClick={() => onNavigate(link.label)}><Icon name={link.icon} size={19}/><span>{link.label}</span>{active === link.label && <i/>}</button>)}
    </nav>
    <div className="sidebar-rule"/>
    <div className="library-heading"><span>YOUR COLLECTION</span><button aria-label="Create playlist" onClick={onCreatePlaylist}><Icon name="plus" size={17}/></button></div>
    <div className="collection-list">
      <button className="collection-item" onClick={() => onNavigate('Your library', 'Tracks')}><span className="collection-cover cover-liked"><Icon name="heart" size={16}/></span><span><b>Liked songs</b><small>Sample collection</small></span></button>
      <button className="collection-item" onClick={() => onNavigate('Your library', 'Playlists')}><span className="collection-cover cover-mix">✳</span><span><b>Made for you</b><small>Starter mixes</small></span></button>
      <button className="collection-item" onClick={() => onNavigate('Your library', 'Playlists')}><span className="collection-cover cover-drive">↗</span><span><b>Late Night Drive</b><small>Sample playlist</small></span></button>
      <button className="collection-item" onClick={() => onNavigate('Your library', 'Playlists')}><span className="collection-cover cover-focus">◌</span><span><b>Soft Focus</b><small>Sample playlist</small></span></button>
    </div>
    <div className="sidebar-spacer"/>
    <div className="friend-activity">
      <div className="friend-head"><div><span className="eyebrow">AROUND YOU</span><h3>Friends listening</h3></div><span className="online-count"><i/> 3</span></div>
      <div className="friend-list">{[
        ['maya', 'avatar-pink', 'Glue Song', 'beabadoobee', 'M'],
        ['leo', 'avatar-blue', 'Tadow', 'Masego, FKJ', 'L'],
        ['nina', 'avatar-lime', 'Bags', 'Clairo', 'N'],
      ].map(([name, color, song, artist, initial]) => <div className="friend-row" key={name}><span className={`avatar ${color}`}>{initial}<i/></span><div className="friend-song"><b>{name}</b><small><span className="tiny-eq">♫</span> {song}</small><small className="friend-artist">{artist}</small></div><button className="icon-button friend-more" aria-label={`More about ${name}`}><Icon name="more" size={16}/></button></div>)}</div>
    </div>
    <div className="user-profile"><div className="profile-pic">J</div><div><b>jordan</b><small>Free account</small></div><button className="icon-button" aria-label="Profile options"><Icon name="more" size={18}/></button></div>
  </aside>
}

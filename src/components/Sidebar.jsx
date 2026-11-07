import Icon from './Icon.jsx'

const primaryLinks = [
  { label: 'Home', icon: 'home' },
  { label: 'Search', icon: 'search' },
  { label: 'Your library', icon: 'library' },
]

export default function Sidebar({ active, account, onNavigate }) {
  const links = [...primaryLinks, ...(account?.status === 'authenticated'
    ? [{ label: 'Profile', icon: 'user' }]
    : [{ label: 'Log in', icon: 'user' }])]
  const identity = account?.status === 'authenticated' ? account.user.username : 'Guest'
  const accountStatus = account?.status === 'authenticated' ? 'Authenticated account'
    : account?.status === 'loading' ? 'Checking account…'
      : account?.status === 'error' ? 'Account status unavailable' : 'Guest access'
  return <aside className="sidebar">
    <a className="brand" href="#home" onClick={(e) => { e.preventDefault(); onNavigate('Home') }} aria-label="Jammy home"><span className="brand-mark">j</span><span>jammy<span className="brand-period">.</span></span></a>
    <nav className="main-nav" aria-label="Main navigation" data-account-count={links.length}>
      {links.map((link) => <button key={link.label} className={`nav-link ${active === link.label ? 'active' : ''}`} onClick={() => onNavigate(link.label)}><Icon name={link.icon} size={19}/><span>{link.label}</span>{active === link.label && <i/>}</button>)}
    </nav>
    <div className="sidebar-rule"/>
    <div className="library-heading"><span>YOUR COLLECTION</span></div>
    <div className="collection-list"><button className="collection-item" onClick={() => onNavigate('Your library', 'Tracks')}><span className="collection-cover cover-liked"><Icon name="library" size={16}/></span><span><b>Jammy history</b><small>Your listening activity</small></span></button></div>
    <div className="sidebar-spacer"/>
    <button className="user-profile" type="button" onClick={() => onNavigate(account?.status === 'authenticated' ? 'Profile' : 'Log in')} aria-label={`${identity}, ${accountStatus}`}><span className="profile-pic">{account?.status === 'authenticated' ? identity.slice(0, 1).toUpperCase() : 'G'}</span><span className="sidebar-account-copy"><b>{identity}</b><small>{accountStatus}</small></span><span className="account-link-hint">{account?.status === 'authenticated' ? 'Profile' : 'Log in'}</span></button>
  </aside>
}

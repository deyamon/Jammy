import { useEffect, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { getPersonalMusicHome } from '../services/musicApi.js'

export default function LibraryPage({ activeTab, onTabChange, onPlayTrack }) {
  const [data, setData] = useState({ history: [], spotify: { connected: false, imports: null } })
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    getPersonalMusicHome().then((value) => {
      if (active) { setData(value); setStatus('ready') }
    }).catch((requestError) => {
      if (active) { setError(requestError.message); setStatus('error') }
    })
    return () => { active = false }
  }, [])

  const history = data.history || []
  const spotifyItems = data.spotify?.items || []
  const showingSpotify = activeTab === 'Playlists'

  return <div className="page-view">
    <div className="page-intro library-intro">
      <div className="library-title-icon"><Icon name="library" size={21}/></div>
      <div><p className="eyebrow">YOUR MUSIC, ALL TOGETHER</p><h1>Your library<span>.</span></h1><p>Your Jammy listening and imported Spotify data stay separate.</p></div>
    </div>
    <div className="library-tabs" role="tablist" aria-label="Music history">
      {[['Tracks', 'Jammy history'], ['Playlists', 'Spotify imports']].map(([tab, label]) => <button key={tab} role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? 'selected' : ''} onClick={() => onTabChange(tab)}>{label}</button>)}
    </div>
    <section className="section-block library-content">
      <div className="section-heading"><div><p className="eyebrow">{showingSpotify ? 'SPOTIFY IMPORTS' : 'JAMMY PLAYBACK'}</p><h2>{showingSpotify ? 'Imported listening data' : 'Recently played'}</h2></div></div>
      {status === 'loading' ? <p className="empty-state" aria-live="polite">Loading your music…</p>
        : status === 'error' ? <p className="empty-state" role="alert">{error}</p>
          : showingSpotify ? !data.spotify?.connected ? <p className="empty-state">Spotify isn’t connected. Connect it from Home to import your listening signals.</p>
            : spotifyItems.length ? <ul className="personal-music-list">{spotifyItems.map((item) => <li key={`${item.kind}:${item.id}`} className="personal-music-row"><span className="personal-music-copy">{item.spotifyUrl ? <a href={item.spotifyUrl} target="_blank" rel="noreferrer"><b>{item.name}</b><span className="spotify-link-mark" aria-label="Spotify"> ↗</span></a> : <b>{item.name}</b>}<small>Spotify · {item.kind.replaceAll('_', ' ')}</small></span></li>)}</ul>
              : <p className="empty-state">No Spotify listening data has been imported yet.</p>
          : history.length ? <ul className="personal-music-list">{history.map((item) => <li key={item.id}><button type="button" onClick={() => onPlayTrack?.(item.track)}><span><b>{item.title}</b><small>{item.artist || item.channelName || 'YouTube'}</small></span><time dateTime={item.playedAt}>{new Date(item.playedAt).toLocaleDateString()}</time></button></li>)}</ul>
            : <p className="empty-state">Tracks you actually play in Jammy will appear here.</p>}
    </section>
  </div>
}

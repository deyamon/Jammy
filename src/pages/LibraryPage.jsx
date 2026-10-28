import Icon from '../components/Icon.jsx'
import MixCard from '../components/MixCard.jsx'
import TrackCard from '../components/TrackCard.jsx'
import { mixes, tracks } from '../data.js'

export default function LibraryPage({ activeTab, onTabChange, currentTrack, onPlayTrack, onNotice }) {
  return <div className="page-view">
    <div className="page-intro library-intro">
      <div className="library-title-icon"><Icon name="library" size={21}/></div>
      <div><p className="eyebrow">YOUR MUSIC, ALL TOGETHER</p><h1>Your library<span>.</span></h1><p>Starter collections for this Jammy preview.</p></div>
    </div>

    <div className="library-tabs" role="tablist" aria-label="Library content">
      {['Playlists', 'Tracks'].map((tab) => <button key={tab} role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? 'selected' : ''} onClick={() => onTabChange(tab)}>{tab}</button>)}
    </div>

    {activeTab === 'Playlists' ? <section className="section-block library-content">
      <div className="section-heading"><div><p className="eyebrow">SAMPLE COLLECTION</p><h2>Playlists & mixes</h2></div><span className="result-count">{mixes.length} mixes</span></div>
      <div className="mix-grid">{mixes.map((mix) => <MixCard key={mix.title} mix={mix} onPlay={() => onNotice('This sample mix has no playable audio yet.')}/>)}</div>
    </section> : <section className="section-block library-content">
      <div className="section-heading"><div><p className="eyebrow">SAMPLE CATALOG</p><h2>Tracks</h2></div><span className="result-count">{tracks.length} tracks</span></div>
      <div className="track-list">
        <div className="track-header"><span>#</span><span>TITLE</span><span>ALBUM</span><span>TIME</span></div>
        {tracks.map((track, index) => <TrackCard key={track.title} track={track} index={index} active={currentTrack.title === track.title} onPlay={onPlayTrack}/>) }
      </div>
    </section>}
    <p className="catalog-footnote">Sample content is stored in this frontend only. Accounts and saved libraries aren’t connected yet.</p>
  </div>
}

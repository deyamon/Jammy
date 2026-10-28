import { useEffect, useMemo, useState } from 'react'
import MixCard from '../components/MixCard.jsx'
import TrackCard from '../components/TrackCard.jsx'
import SpotifyEmbed from '../components/SpotifyEmbed.jsx'
import { mixes, tracks } from '../data.js'
import { asYouTubeTrack, searchYouTube } from '../services/youtubeApi.js'
import { searchSpotify } from '../services/spotifyApi.js'

export default function SearchPage({ query, currentTrack, onPlayTrack, onNotice, onAddToRoom, youtubeConsent, onAcceptYouTube }) {
  const [youtubeResults, setYoutubeResults] = useState([])
  const [spotifyResults, setSpotifyResults] = useState([])
  const [spotifyStatus, setSpotifyStatus] = useState('idle')
  const [spotifyError, setSpotifyError] = useState('')
  const [selectedSpotifyTrack, setSelectedSpotifyTrack] = useState(null)
  const [youtubeStatus, setYoutubeStatus] = useState('idle')
  const [youtubeError, setYoutubeError] = useState('')
  const [showYouTubeNotice, setShowYouTubeNotice] = useState(false)
  const normalizedQuery = query.trim().toLowerCase()
  const results = useMemo(() => ({
    tracks: tracks.filter((track) => `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(normalizedQuery)),
    mixes: mixes.filter((mix) => `${mix.title} ${mix.subtitle}`.toLowerCase().includes(normalizedQuery)),
  }), [normalizedQuery])

  useEffect(() => { setSelectedSpotifyTrack(null) }, [normalizedQuery])

  useEffect(() => {
    if (!normalizedQuery || !youtubeConsent) { setYoutubeResults([]); setYoutubeStatus('idle'); setYoutubeError(''); return undefined }
    const controller = new AbortController()
    setYoutubeStatus('loading')
    setYoutubeError('')
    const timeout = window.setTimeout(() => {
      searchYouTube(query.trim(), { signal: controller.signal }).then((results) => {
        setYoutubeResults(results)
        setYoutubeStatus('ready')
      }).catch((error) => {
        if (error.name === 'AbortError') return
        setYoutubeResults([])
        setYoutubeError(error.message)
        setYoutubeStatus('error')
      })
    }, 350)
    return () => { window.clearTimeout(timeout); controller.abort() }
  }, [normalizedQuery, query, youtubeConsent])

  useEffect(() => {
    if (!normalizedQuery) { setSpotifyResults([]); setSpotifyStatus('idle'); setSpotifyError(''); return undefined }
    const controller = new AbortController()
    setSpotifyStatus('loading')
    setSpotifyError('')
    const timeout = window.setTimeout(() => {
      searchSpotify(normalizedQuery, { signal: controller.signal }).then((results) => {
        setSpotifyResults(results)
        setSpotifyStatus('ready')
      }).catch((error) => {
        if (error.name === 'AbortError') return
        setSpotifyResults([])
        setSpotifyError(error.message)
        setSpotifyStatus('error')
      })
    }, 400)
    return () => { window.clearTimeout(timeout); controller.abort() }
  }, [normalizedQuery])

  return <div className="page-view">
    <div className="page-intro">
      <p className="eyebrow">DISCOVER YOUR NEXT REPEAT</p>
      <h1>Search<span>.</span></h1>
      <p>Search Jammy’s starter catalog and YouTube videos, or explore Spotify track metadata and its separate official player.</p>
    </div>

    {!normalizedQuery && <div className="browse-prompt">Try a track, artist, album, or mix name in the search bar above.</div>}

    <section className="section-block search-results youtube-search-results">
      <div className="section-heading"><div><p className="eyebrow">YOUTUBE</p><h2>{normalizedQuery ? `Videos for “${query.trim()}”` : 'Search YouTube'}</h2></div><span className="youtube-attribution">Powered by YouTube</span></div>
      {!youtubeConsent ? <div className="youtube-consent-card"><p>Jammy uses YouTube Data API search and embeds YouTube players. Search terms go to Jammy’s server; room queues share video IDs and metadata with room members for up to 29 days. Selecting a video loads YouTube’s player, which may send data to YouTube before playback. YouTube’s own privacy terms apply. By continuing, you agree to YouTube’s Terms of Service.</p><p><a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Google Privacy Policy</a> · <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms of Service</a> · <a href="https://developers.google.com/youtube/terms/developer-policies" target="_blank" rel="noreferrer">YouTube API policies</a></p>{showYouTubeNotice ? <button className="youtube-consent-accept" onClick={onAcceptYouTube}>Agree and enable YouTube search</button> : <button onClick={() => setShowYouTubeNotice(true)}>Review YouTube data notice</button>}</div>
        : !normalizedQuery ? <p className="empty-state">Enter a song or artist above to search YouTube.</p>
        : youtubeStatus === 'loading' ? <p className="empty-state">Searching YouTube…</p>
          : youtubeStatus === 'error' ? <p className="empty-state youtube-error" role="status">{youtubeError}</p>
            : youtubeResults.length === 0 ? <p className="empty-state">No YouTube videos matched that search.</p>
              : <div className="youtube-results-grid">{youtubeResults.map((result) => {
                const track = asYouTubeTrack(result)
                return <article className={`youtube-result-card ${currentTrack.id === track.id ? 'active' : ''}`} key={result.videoId}>
                  <button className="youtube-result-play" onClick={() => onPlayTrack(track)} aria-label={`Play ${result.title}`}>
                    {result.thumbnails?.medium || result.thumbnails?.default ? <img src={result.thumbnails.medium || result.thumbnails.default} alt="" loading="lazy"/> : <span className="youtube-thumb-placeholder">▶</span>}
                    <span className="youtube-source-mark">YouTube</span>
                  </button>
                  <div className="youtube-result-copy"><b title={result.title}>{result.title}</b><small>{result.channelName}</small><div className="youtube-result-actions"><button onClick={() => onPlayTrack(track)}>{currentTrack.id === track.id ? 'Play again' : 'Play'}</button><button onClick={() => onAddToRoom(track)}>Add to room</button></div></div>
                </article>
              })}</div>}
    </section>

    <section className="section-block search-results spotify-search-results">
      <div className="section-heading"><div><p className="eyebrow">SPOTIFY CATALOG</p><h2>{normalizedQuery ? `Spotify matches for “${query.trim()}”` : 'Search Spotify metadata'}</h2></div><span className="spotify-attribution">Metadata by Spotify</span></div>
      {!normalizedQuery ? <p className="empty-state">Enter a song or artist to search Spotify’s catalog.</p>
        : spotifyStatus === 'loading' ? <p className="empty-state">Searching Spotify…</p>
          : spotifyStatus === 'error' ? <p className="empty-state spotify-error" role="status">{spotifyError}</p>
            : spotifyResults.length === 0 ? <p className="empty-state">No Spotify tracks matched that search.</p>
              : <div className="spotify-results-list">{spotifyResults.map((track) => <article className="spotify-result-row" key={track.id}>
                {track.artwork ? <img src={track.artwork} alt="" loading="lazy"/> : <span className="spotify-art-placeholder" aria-hidden="true">♫</span>}
                <div className="spotify-result-copy"><b>{track.title}</b><small>{track.artist} · {track.album || 'Spotify track'}</small></div>
                <a href={track.spotifyUrl} target="_blank" rel="noreferrer" aria-label={`Open ${track.title} on Spotify`}>Open Spotify ↗</a>
                <button onClick={() => setSelectedSpotifyTrack(track)} aria-label={`Show official Spotify player for ${track.title}`}>Show embed</button>
              </article>)}</div>}
      {selectedSpotifyTrack && <SpotifyEmbed track={selectedSpotifyTrack}/>}
    </section>

    <section className="section-block search-results">
      <div className="section-heading">
        <div><p className="eyebrow">TRACKS</p><h2>{normalizedQuery ? `Matches for “${query.trim()}”` : 'Starter tracks'}</h2></div>
        <span className="result-count">{results.tracks.length} {results.tracks.length === 1 ? 'track' : 'tracks'}</span>
      </div>
      {results.tracks.length ? <div className="track-list">
        <div className="track-header"><span>#</span><span>TITLE</span><span>ALBUM</span><span>TIME</span></div>
        {results.tracks.map((track, index) => <TrackCard key={track.title} track={track} index={index} active={currentTrack.title === track.title} onPlay={onPlayTrack}/>) }
      </div> : <p className="empty-state">No tracks match that search. Try a different title, artist, or album.</p>}
    </section>

    <section className="section-block search-results">
      <div className="section-heading">
        <div><p className="eyebrow">PLAYLISTS & MIXES</p><h2>{normalizedQuery ? 'Matching mixes' : 'Browse mixes'}</h2></div>
        <span className="result-count">{results.mixes.length} {results.mixes.length === 1 ? 'mix' : 'mixes'}</span>
      </div>
      {results.mixes.length ? <div className="mix-grid">{results.mixes.map((mix) => <MixCard key={mix.title} mix={mix} onPlay={() => onNotice('This sample mix has no playable audio yet.')}/>)}</div> : <p className="empty-state">No mixes match that search.</p>}
    </section>
  </div>
}

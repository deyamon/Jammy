import { useEffect, useRef, useState } from 'react'
import { asYouTubeTrack } from '../services/youtubeApi.js'
import { searchPersonalizedYouTube } from '../services/musicApi.js'
import { filterYouTubeResults } from '../search/searchResults.js'

const SEARCH_FILTERS = [
  ['all', 'All'], ['songs', 'Songs'], ['live', 'Live'],
  ['covers', 'Covers'], ['lyrics', 'Lyrics'], ['remixes', 'Remixes'],
]
const PAGE_SIZE = 12

export default function SearchPage({ query, currentTrack, onPlayTrack, onAddToRoom, youtubeConsent, onAcceptYouTube, onSearchStarted }) {
  const [results, setResults] = useState([])
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [showYouTubeNotice, setShowYouTubeNotice] = useState(false)
  const [filter, setFilter] = useState('all')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const requestIdRef = useRef(0)
  const normalizedQuery = query.trim()
  const filteredResults = filterYouTubeResults(results, filter)
  const visibleResults = filteredResults.slice(0, visibleCount)

  useEffect(() => {
    const requestId = ++requestIdRef.current
    setVisibleCount(PAGE_SIZE)
    setFilter('all')
    if (!normalizedQuery || !youtubeConsent) { setResults([]); setStatus('idle'); setError(''); return undefined }
    const controller = new AbortController()
    setStatus('loading')
    setError('')
    const timeout = window.setTimeout(() => {
      onSearchStarted?.(normalizedQuery)
      searchPersonalizedYouTube(normalizedQuery, { signal: controller.signal }).then((items) => {
        if (requestId !== requestIdRef.current) return
        setResults(items)
        setStatus('ready')
      }).catch((requestError) => {
        if (requestError.name === 'AbortError' || requestId !== requestIdRef.current) return
        setResults([])
        setError(requestError.message)
        setStatus('error')
      })
    }, 350)
    return () => { window.clearTimeout(timeout); controller.abort() }
  }, [normalizedQuery, youtubeConsent, onSearchStarted])

  return <div className="page-view">
    <div className="page-intro">
      <p className="eyebrow">DISCOVER YOUR NEXT REPEAT</p>
      <h1>Search<span>.</span></h1>
      <p>Find YouTube tracks to play in Jammy or add to a listening room.</p>
    </div>
    <section className="section-block search-results youtube-search-results">
      <div className="section-heading"><div><p className="eyebrow">YOUTUBE</p><h2>{normalizedQuery ? `Videos for “${normalizedQuery}”` : 'Search YouTube'}</h2></div><span className="youtube-attribution">Powered by YouTube</span></div>
      {!youtubeConsent ? <div className="youtube-consent-card"><p>Jammy uses YouTube Data API search and embeds YouTube players. Search terms go to Jammy’s server; room queues share video IDs and metadata with room members for up to 29 days. Selecting a video loads YouTube’s player, which may send data to YouTube before playback. YouTube’s own privacy terms apply. By continuing, you agree to YouTube’s Terms of Service.</p><p><a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Google Privacy Policy</a> · <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms of Service</a> · <a href="https://developers.google.com/youtube/terms/developer-policies" target="_blank" rel="noreferrer">YouTube API policies</a></p>{showYouTubeNotice ? <button className="youtube-consent-accept" onClick={onAcceptYouTube}>Agree and enable YouTube search</button> : <button onClick={() => setShowYouTubeNotice(true)}>Review YouTube data notice</button>}</div>
        : !normalizedQuery ? <p className="empty-state">Enter a song or artist above to search YouTube.</p>
          : status === 'loading' ? <p className="empty-state">Searching YouTube…</p>
            : status === 'error' ? <p className="empty-state youtube-error" role="status">{error}</p>
              : results.length === 0 ? <p className="empty-state">No music results matched that search. Try an artist, song title, or a version such as “live” or “acoustic”.</p>
                : <>
                  <div className="youtube-search-filters" role="group" aria-label="Filter music search results">
                    {SEARCH_FILTERS.map(([value, label]) => <button key={value} type="button" className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => { setFilter(value); setVisibleCount(PAGE_SIZE) }}>{label}</button>)}
                  </div>
                  {filteredResults.length === 0 ? <p className="empty-state" role="status">No results in {SEARCH_FILTERS.find(([value]) => value === filter)?.[1]}. Try All or another filter.</p>
                    : <div className="youtube-results-grid">{visibleResults.map((result) => {
                  const track = asYouTubeTrack(result)
                  const active = currentTrack?.id === track.id
                  return <article className={`youtube-result-card ${active ? 'active' : ''}`} key={result.videoId}>
                    <button className="youtube-result-play" onClick={() => onPlayTrack(track)} aria-label={`Play ${result.title}`}>
                      {result.thumbnails?.medium || result.thumbnails?.default ? <img src={result.thumbnails.medium || result.thumbnails.default} alt="" loading="lazy"/> : <span className="youtube-thumb-placeholder">▶</span>}
                      <span className="youtube-source-mark">YouTube</span>
                    </button>
                    <div className="youtube-result-copy"><b title={result.title}>{result.title}</b><small>{result.channelName}</small><div className="youtube-result-actions"><button onClick={() => onPlayTrack(track)}>{active ? 'Play again' : 'Play'}</button><button onClick={() => onAddToRoom(track)}>Add to room</button></div></div>
                  </article>
                  })}</div>}
                  {visibleCount < filteredResults.length && <div className="youtube-search-more"><span>Showing {visibleResults.length} of {filteredResults.length}</span><button type="button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>Load more</button></div>}
                </>}
    </section>
  </div>
}

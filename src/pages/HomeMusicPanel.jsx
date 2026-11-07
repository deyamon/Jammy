import { useCallback, useEffect, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { disconnectSpotify, getPersonalMusicHome, startSpotifyConnection, syncSpotifyData } from '../services/musicApi.js'
import { homeMusicErrorMessage, spotifyActionErrorMessage } from './homeMusicErrors.js'
import { connectAndRedirectToSpotify } from './spotifyConnect.js'

function TrackLine({ item, onPlay }) {
  return <li className="personal-music-row"><button type="button" onClick={() => onPlay(item.track)}><span className="personal-music-play"><Icon name="play" size={13}/></span><span className="personal-music-copy"><b>{item.title}</b><small>{item.channelName || 'YouTube video'} · Jammy</small></span><time dateTime={item.playedAt}>{new Date(item.playedAt).toLocaleDateString()}</time></button></li>
}

export default function HomeMusicPanel({ onPlayTrack }) {
  const [data, setData] = useState(null)
  const [status, setStatus] = useState('loading')
  const [busy, setBusy] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const load = useCallback(async () => {
    setStatus('loading')
    setHistoryError('')
    try { setData(await getPersonalMusicHome()); setStatus('ready') }
    catch (error) { setHistoryError(homeMusicErrorMessage(error)); setStatus('error') }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const result = params.get('spotify')
    if (!result) return
    setMessage(result === 'connected' ? 'Spotify is connected. Import your listening data when you’re ready.' : result === 'cancelled' ? 'Spotify connection was cancelled.' : result === 'setup-required' ? 'Spotify OAuth needs server configuration before it can connect.' : 'Spotify could not connect. You can try again.')
    params.delete('spotify')
    const nextUrl = `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`
    window.history.replaceState({}, '', nextUrl)
  }, [])
  const runAction = async (action, label) => {
    setBusy(label); setActionMessage('')
    try {
      if (label === 'connect') { await connectAndRedirectToSpotify({ startRequest: action, redirect: (url) => window.location.assign(url) }); return }
      const result = await action()
      if (label === 'sync') setActionMessage(result.partial ? `Imported ${result.imported} Spotify items. Some categories were unavailable and their previous data was kept.` : `Imported ${result.imported} Spotify items from Spotify.`)
      if (label === 'disconnect') setActionMessage('Spotify is disconnected. Imported Spotify data was deleted from Jammy.')
      await load()
    } catch (error) { setActionMessage(spotifyActionErrorMessage(error)) }
    finally { setBusy('') }
  }
  const history = data?.history || []
  const topArtists = (data?.spotify?.items || []).filter((item) => item.kind === 'top_artist').slice(0, 6)
  return <>
    <section className="section-block quick-section personal-home-history" aria-labelledby="jammy-history-title">
      <div className="section-heading"><div><p className="eyebrow">YOUR JAMMY LISTENING</p><h2 id="jammy-history-title">Recently played</h2></div></div>
      {status === 'loading' ? <p className="empty-state" aria-live="polite">Loading your listening history…</p>
        : status === 'error' ? <div className="personal-music-empty"><p role="alert">{historyError}</p><button className="text-link" type="button" onClick={() => void load()}>Try again <Icon name="arrow" size={14}/></button></div>
          : history.length ? <ol className="personal-music-list">{history.slice(0, 5).map((item) => <TrackLine key={item.id} item={item} onPlay={onPlayTrack}/>)}</ol>
            : <p className="empty-state">Tracks you play in Jammy will appear here. Spotify listening stays in its own section.</p>}
    </section>
    <section className="section-block spotify-insights" aria-labelledby="spotify-insights-title">
      <div className="section-heading"><div><p className="eyebrow">OPTIONAL IMPORT</p><h2 id="spotify-insights-title">Spotify listening insights</h2></div><span className="spotify-data-label">Spotify data · separate from Jammy history</span></div>
      {status === 'ready' && data?.spotify?.connected ? <>
        <p className="spotify-connection-copy">{data.spotify.needsReauth ? 'Spotify needs to be connected again before imports can be refreshed.' : 'Your Spotify account is connected. Jammy imports read-only listening metadata.'}</p>
        {topArtists.length ? <div className="spotify-artist-list">{topArtists.map((artist) => artist.spotifyUrl ? <a key={artist.id} href={artist.spotifyUrl} target="_blank" rel="noreferrer">{artist.name}<span className="spotify-link-mark" aria-label="Spotify"> ↗</span></a> : <span key={artist.id}>{artist.name}</span>)}</div> : <p className="empty-state">No Spotify top artists have been imported yet.</p>}
        <div className="spotify-actions">{data.spotify.needsReauth ? <button className="primary-action" type="button" disabled={Boolean(busy)} onClick={() => void runAction(startSpotifyConnection, 'connect')}>{busy === 'connect' ? 'Opening Spotify…' : 'Reconnect Spotify'}</button> : <button className="primary-action" type="button" disabled={Boolean(busy)} onClick={() => void runAction(syncSpotifyData, 'sync')}>{busy === 'sync' ? 'Importing…' : 'Import Spotify listening'}</button>}<button className="outline-action" type="button" disabled={Boolean(busy)} onClick={() => void runAction(disconnectSpotify, 'disconnect')}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect Spotify'}</button></div>
      </> : <>
        <p className="spotify-connection-copy">Connect Spotify to import top artists, top tracks, recent listening, saved tracks, and private playlist metadata. Spotify insights stay separate from Jammy history; Jammy personalizes YouTube discovery from your Jammy listening only.</p>
        <button className="primary-action" type="button" disabled={Boolean(busy) || status === 'loading'} onClick={() => void runAction(startSpotifyConnection, 'connect')}>{busy === 'connect' ? 'Opening Spotify…' : 'Connect Spotify'}</button>
      </>}
      {actionMessage && <p className="spotify-action-message" role="status">{actionMessage}</p>}
    </section>
  </>
}

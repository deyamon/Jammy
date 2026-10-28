import { spotifyEmbedUrl } from '../services/spotifyApi.js'

export default function SpotifyEmbed({ track }) {
  const src = spotifyEmbedUrl(track?.id)
  if (!src) return null
  return <section className="spotify-embed-panel" aria-label="Spotify's official player">
    <div className="spotify-embed-heading">
      <div><p className="eyebrow">SEPARATE PLAYER</p><h3>Listen on Spotify</h3><p>Spotify controls this embed. Jammy’s room playback and queue are separate.</p></div>
      <a href={track.spotifyUrl} target="_blank" rel="noreferrer">Open original track ↗</a>
    </div>
    <iframe
      title={`Spotify player: ${track.title} by ${track.artist}`}
      src={src}
      width="100%"
      height="352"
      frameBorder="0"
      allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
      loading="lazy"
    />
    <small>Track metadata provided by Spotify.</small>
  </section>
}

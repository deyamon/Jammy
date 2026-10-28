const paths = {
  home: <><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9M9 20v-6h6v6"/></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></>,
  library: <><path d="M4 4v16M9 7v13M14 5l4 14M19 4l2 1"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  arrow: <><path d="M7 17 17 7M7 7h10v10"/></>,
  play: <path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none"/>,
  pause: <><path d="M8 5v14M16 5v14" strokeWidth="3"/></>,
  previous: <><path d="M6 5v14M19 6l-9 6 9 6z" fill="currentColor" stroke="none"/></>,
  next: <><path d="M18 5v14M5 6l9 6-9 6z" fill="currentColor" stroke="none"/></>,
  shuffle: <><path d="m3 7 3 0c4 0 8 10 12 10h3"/><path d="m17 14 4 3-4 3M3 17h3c1.6 0 3.2-1.6 4.6-3.3M14.5 8.6C15.7 7.6 16.8 7 18 7h3"/><path d="m17 4 4 3-4 3"/></>,
  repeat: <><path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/></>,
  volume: <><path d="M4 10v4h4l5 4V6l-5 4z"/><path d="M17 9a5 5 0 0 1 0 6M19.5 6.5a9 9 0 0 1 0 11"/></>,
  volumeMuted: <><path d="M4 10v4h4l5 4V6l-5 4z"/><path d="m17 9 5 6M22 9l-5 6"/></>,
  queue: <><path d="M4 6h16M4 11h16M4 16h10"/><path d="m17 15 4 3-4 3z" fill="currentColor" stroke="none"/></>,
  heart: <path d="M20.8 8.8c0 5.2-8.8 10.2-8.8 10.2S3.2 14 3.2 8.8a4.6 4.6 0 0 1 8.8-1.9 4.6 4.6 0 0 1 8.8 1.9Z"/>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
  users: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1zM16 5.3a3 3 0 0 1 0 5.4M18 14a5 5 0 0 1 3 4.5v1.5"/></>,
  close: <><path d="m6 6 12 12M18 6 6 18"/></>,
}

export default function Icon({ name, size = 20, className = '' }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/

export function isValidYouTubeVideoId(videoId) {
  return typeof videoId === 'string' && VIDEO_ID_PATTERN.test(videoId)
}

export function loadSoloYouTubeTrack(track, currentTrack, options = {}, actions = {}) {
  if (!track?.id || track.provider !== 'youtube' || !isValidYouTubeVideoId(track.videoId)) {
    return { ok: false, error: 'This YouTube video is missing a valid video ID and cannot be played.' }
  }

  const changed = track.id !== currentTrack?.id
  if (changed) actions.setTrack?.(track)
  actions.setAutoplayRequested?.(Boolean(options.autoplay))
  if (options.openPlayer !== false) actions.openPlayer?.()
  if (!changed && options.autoplay && actions.player?.canControl?.()) actions.player.playFromUserGesture?.()
  return { ok: true, changed }
}

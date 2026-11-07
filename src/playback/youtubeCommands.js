export function playYouTubeFromUserGesture(player) {
  if (typeof player?.playVideo !== 'function') return false
  player.playVideo()
  return true
}

export function applyRoomPlaybackCommand(player, { isPlaying, positionMs } = {}) {
  if (!player) return false
  if (Number.isFinite(positionMs)) player.seekTo?.(Math.max(0, positionMs / 1000), true)
  if (isPlaying) playYouTubeFromUserGesture(player)
  else player.pauseVideo?.()
  return true
}

export function restoreYouTubePlayback(player, snapshot) {
  if (!player || !snapshot || !Number.isFinite(snapshot.position)) return false
  try {
    if (snapshot.position > 0) player.seekTo?.(snapshot.position, true)
    if (snapshot.isPlaying) player.playVideo?.()
    else player.pauseVideo?.()
    return true
  } catch {
    return false
  }
}

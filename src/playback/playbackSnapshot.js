export function createPlaybackSnapshot(track, { position = 0, isPlaying = false } = {}) {
  if (!track?.id) return null
  const safePosition = Number.isFinite(position) && position > 0 ? position : 0
  return Object.freeze({
    track: Object.freeze({ ...track }),
    trackId: track.id,
    position: safePosition,
    isPlaying: Boolean(isPlaying),
  })
}

export function isCurrentRoomSession(activeSession, sourceSession) {
  return Boolean(activeSession && sourceSession && activeSession === sourceSession)
}

export function resolveActiveTrack({ roomSession, roomPlayback, standaloneTrack }) {
  if (!roomSession) return standaloneTrack
  return roomPlayback?.currentTrack ?? null
}

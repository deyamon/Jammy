export function isRoomCommandEcho(remoteCommand, status, now = Date.now()) {
  return Boolean(remoteCommand && remoteCommand.expiresAt > now
    && (status === 'loading' || status === (remoteCommand.isPlaying ? 'playing' : 'paused')))
}

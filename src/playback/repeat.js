export const REPEAT_MODES = Object.freeze(['off', 'all', 'one'])

export function nextRepeatMode(mode) {
  const index = REPEAT_MODES.indexOf(mode)
  return REPEAT_MODES[(index + 1 + REPEAT_MODES.length) % REPEAT_MODES.length]
}

export function repeatModeLabel(mode) {
  return mode === 'all' ? 'Repeat All' : mode === 'one' ? 'Repeat One' : 'Repeat Off'
}

export function getTrackEndAction(mode, currentIndex, totalTracks) {
  if (!Number.isInteger(totalTracks) || totalTracks < 1) return { type: 'stop' }
  if (mode === 'one') return { type: 'replay' }
  if (currentIndex < 0) return mode === 'all' ? { type: 'replay' } : { type: 'stop' }
  if (currentIndex + 1 < totalTracks) return { type: 'select', index: currentIndex + 1 }
  if (mode === 'all') return { type: 'select', index: 0 }
  return { type: 'stop' }
}

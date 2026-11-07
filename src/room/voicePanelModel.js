export function voicePanelMode({ joined, expanded }) {
  if (joined) return expanded ? 'expanded' : 'collapsed'
  return expanded ? 'prejoin' : 'launcher'
}

export function voiceInitials(value) {
  const words = String(value ?? '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '♪'
  return words.length > 1
    ? `${words[0][0]}${words.at(-1)[0]}`.toUpperCase()
    : words[0].slice(0, 2).toUpperCase()
}

export function voiceAvatarTone(value) {
  const text = String(value ?? '')
  let hash = 0
  for (const character of text) hash = ((hash * 31) + character.charCodeAt(0)) | 0
  return Math.abs(hash) % 5
}

export function voiceConnectionLabel(participant, currentMemberId, peerState) {
  if (participant.state !== 'connected') return 'Reconnecting'
  if (participant.memberId === currentMemberId) return 'In voice'
  if (peerState === 'connected') return 'Connected'
  if (peerState === 'failed') return 'Connection failed'
  if (peerState === 'disconnected') return 'Reconnecting'
  return 'Connecting'
}

export function voiceParticipantStatus(participant, currentMemberId, { muted = false, speaking = false } = {}) {
  if (participant.memberId === currentMemberId) return muted ? 'Mic muted' : speaking ? 'Speaking' : 'Mic on'
  return speaking ? 'Speaking' : 'Mic status unavailable'
}

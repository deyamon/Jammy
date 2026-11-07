export function isRoomHost(room, memberId) {
  return Boolean(room?.members?.some((member) => member.id === memberId && member.role === 'owner'))
}

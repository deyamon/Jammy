import assert from 'node:assert/strict'
import test from 'node:test'
import { RoomService, selectNextHost } from './roomService.js'

function identity(session) {
  return { code: session.room.code, memberId: session.member.id, memberToken: session.memberToken }
}

test('host departure promotes the oldest online member and duplicate stale removals do not demote them', async () => {
  const service = new RoomService()
  const host = await service.createRoom({ name: 'Host transfer', displayName: 'Host' })
  const firstGuest = await service.joinRoom({ code: host.room.code, displayName: 'First guest' })
  const secondGuest = await service.joinRoom({ code: host.room.code, displayName: 'Second guest' })
  const hostIdentity = identity(host)

  await service.setOnline(hostIdentity, true)
  await service.setOnline(identity(firstGuest), true)
  await service.setOnline(identity(secondGuest), false)
  const beforeLeave = await service.getRoom(hostIdentity)
  const expected = selectNextHost(beforeLeave.members.filter((member) => member.id !== host.member.id))

  const afterLeave = await service.leaveRoom(hostIdentity)
  assert.equal(afterLeave.members.find((member) => member.id === expected.id).role, 'owner')
  assert.equal(afterLeave.members.filter((member) => member.role === 'owner').length, 1)
  const afterStaleRemoval = await service.leaveRoomIfOffline(hostIdentity)
  assert.equal(afterStaleRemoval.members.find((member) => member.id === expected.id).role, 'owner')
  assert.equal(afterStaleRemoval.members.length, 2)
})

test('a disconnected host retains ownership during grace and transfers only after remaining offline', async () => {
  const service = new RoomService()
  const host = await service.createRoom({ name: 'Reconnect grace', displayName: 'Host' })
  const guest = await service.joinRoom({ code: host.room.code, displayName: 'Guest' })
  const hostIdentity = identity(host)
  const guestIdentity = identity(guest)

  await service.setOnline(hostIdentity, true)
  await service.setOnline(guestIdentity, true)
  const offlineRoom = await service.setOnline(hostIdentity, false)
  assert.equal(offlineRoom.members.find((member) => member.id === host.member.id).role, 'owner')
  const reconnected = await service.setOnline(hostIdentity, true)
  assert.equal(reconnected.members.find((member) => member.id === host.member.id).role, 'owner')

  const notYetExpired = await service.leaveRoomIfOffline(hostIdentity)
  assert.equal(notYetExpired.members.find((member) => member.id === host.member.id).role, 'owner')
  await service.setOnline(hostIdentity, false)
  await service.setOnline(guestIdentity, true)
  await service.leaveRoomIfOffline(hostIdentity)
  const transferred = await service.getRoom(guestIdentity)
  assert.equal(transferred.members.find((member) => member.id === guest.member.id).role, 'owner')
  assert.equal(transferred.members.filter((member) => member.role === 'owner').length, 1)
})

test('the last member leaving closes the room', async () => {
  const service = new RoomService()
  const host = await service.createRoom({ name: 'Empty room', displayName: 'Host' })
  assert.equal(await service.leaveRoom(identity(host)), null)
})

test('host selection is deterministic: online first, then join time, then ID', () => {
  const members = [
    { id: 'z-oldest', role: 'member', online: false, joinedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b-online-later', role: 'member', online: true, joinedAt: '2026-01-03T00:00:00.000Z' },
    { id: 'a-online-first', role: 'member', online: true, joinedAt: '2026-01-02T00:00:00.000Z' },
  ]
  assert.equal(selectNextHost(members).id, 'a-online-first')
  members[1].joinedAt = members[2].joinedAt
  assert.equal(selectNextHost(members).id, 'a-online-first')
})

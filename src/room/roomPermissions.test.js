import assert from 'node:assert/strict'
import test from 'node:test'
import { isRoomHost } from './roomPermissions.js'

test('room host status follows the latest server room roster', () => {
  const room = { members: [{ id: 'host', role: 'owner' }, { id: 'guest', role: 'member' }] }
  assert.equal(isRoomHost(room, 'host'), true)
  assert.equal(isRoomHost(room, 'guest'), false)

  room.members = [{ id: 'host', role: 'member' }, { id: 'guest', role: 'owner' }]
  assert.equal(isRoomHost(room, 'host'), false)
  assert.equal(isRoomHost(room, 'guest'), true)
  assert.equal(isRoomHost(null, 'guest'), false)
})

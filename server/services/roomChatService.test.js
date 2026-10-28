import assert from 'node:assert/strict'
import test from 'node:test'
import { RoomChatService } from './roomChatService.js'

test('room chat validates, sanitizes, timestamps, and isolates messages by room', () => {
  const chat = new RoomChatService({ now: () => new Date('2026-01-02T03:04:05.000Z') })
  const identity = { code: 'ROOM01', memberId: 'member-1', displayName: 'Mina' }

  const message = chat.send(identity, { message: '  hello\u0000 room  ' })
  assert.equal(message.displayName, 'Mina')
  assert.equal(message.memberId, 'member-1')
  assert.equal(message.message, 'hello room')
  assert.equal(message.sentAt, '2026-01-02T03:04:05.000Z')
  assert.deepEqual(chat.history('ROOM01'), [message])
  assert.deepEqual(chat.history('OTHER1'), [])
  assert.throws(() => chat.send(identity, { message: '   ' }), /1 to 500 characters/)
  assert.throws(() => chat.send(identity, { message: 'x'.repeat(501) }), /1 to 500 characters/)

  chat.removeRoom('ROOM01')
  assert.deepEqual(chat.history('ROOM01'), [])
})

test('room chat retains only the newest 100 messages', () => {
  const chat = new RoomChatService()
  const identity = { code: 'ROOM01', memberId: 'member-1', displayName: 'Mina' }
  for (let index = 0; index < 105; index += 1) chat.send(identity, { message: `message ${index}` })
  assert.equal(chat.history('ROOM01').length, 100)
  assert.equal(chat.history('ROOM01')[0].message, 'message 5')
})

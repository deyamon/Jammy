import { Router } from 'express'
import { RoomError } from '../services/roomService.js'

const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/

function cleanString(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ') : ''
}

function parseCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (!ROOM_CODE_PATTERN.test(code)) throw new RoomError(400, 'Enter a valid six-character room code.', 'ROOM_CODE_INVALID')
  return code
}

function parseMemberInput(body) {
  const displayName = cleanString(body?.displayName)
  if (displayName.length < 1 || displayName.length > 24) throw new RoomError(400, 'Enter a name between 1 and 24 characters.', 'DISPLAY_NAME_INVALID')
  return displayName
}

function readBearerToken(request) {
  const header = request.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+([A-Za-z0-9_-]{40,50})$/i)
  if (!match) throw new RoomError(401, 'A room session token is required.', 'ROOM_SESSION_REQUIRED')
  return match[1]
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next)
}

export function createRoomsRouter({ roomService, roomSockets }) {
  const router = Router()

  router.post('/', asyncRoute(async (request, response) => {
    const name = cleanString(request.body?.name)
    if (name.length < 1 || name.length > 60) throw new RoomError(400, 'Enter a room name between 1 and 60 characters.', 'ROOM_NAME_INVALID')
    const displayName = parseMemberInput(request.body)
    const maxMembers = request.body?.maxMembers ?? 8
    if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > 20) {
      throw new RoomError(400, 'Room capacity must be between 2 and 20 people.', 'ROOM_CAPACITY_INVALID')
    }
    const result = await roomService.createRoom({ name, displayName, maxMembers })
    response.status(201).json(result)
  }))

  router.post('/:code/join', asyncRoute(async (request, response) => {
    const code = parseCode(request.params.code)
    const displayName = parseMemberInput(request.body)
    const result = await roomService.joinRoom({ code, displayName })
    roomSockets.publishState(code, result.room)
    response.status(201).json(result)
  }))

  router.get('/:code', asyncRoute(async (request, response) => {
    const identity = await roomService.authenticate({
      code: parseCode(request.params.code),
      memberId: request.get('x-room-member-id'),
      memberToken: readBearerToken(request),
    })
    response.json({ room: await roomService.getRoom(identity) })
  }))

  router.delete('/:code/leave', asyncRoute(async (request, response) => {
    const identity = await roomService.authenticate({
      code: parseCode(request.params.code),
      memberId: request.get('x-room-member-id'),
      memberToken: readBearerToken(request),
    })
    const room = await roomService.leaveRoom(identity)
    roomSockets.removeParticipant(identity.memberId)
    roomSockets.publishState(identity.code, room)
    response.json({ ok: true })
  }))

  return router
}

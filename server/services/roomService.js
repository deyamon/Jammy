import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MEMBER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class RoomError extends Error {
  constructor(status, message, code) {
    super(message)
    this.name = 'RoomError'
    this.status = status
    this.code = code
  }
}

function makeRoomCode() {
  return Array.from({ length: 6 }, () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]).join('')
}

function createMemberToken() {
  return randomBytes(32).toString('base64url')
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function tokenMatches(expectedHash, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return false
  const actual = Buffer.from(hashToken(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function roomSnapshot(room, members) {
  if (!room) return null
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    maxMembers: room.maxMembers,
    settings: room.settings,
    members: members.map(({ id, displayName, role, joinedAt, online }) => ({ id, displayName, role, joinedAt, online })),
  }
}

class MemoryRoomRepository {
  constructor() {
    this.rooms = new Map()
  }

  async createRoom({ name, displayName, maxMembers, memberId, tokenHash }) {
    let code
    do { code = makeRoomCode() } while (this.rooms.has(code))
    const room = {
      id: randomUUID(), code, name, createdAt: new Date().toISOString(), maxMembers,
      settings: { queueMode: 'collaborative' },
      members: [{ id: memberId, displayName, role: 'owner', joinedAt: new Date().toISOString(), online: false, tokenHash }],
    }
    this.rooms.set(code, room)
    return roomSnapshot(room, room.members)
  }

  async joinRoom({ code, displayName, memberId, tokenHash }) {
    const room = this.rooms.get(code)
    if (!room) throw new RoomError(404, 'We couldn’t find a room with that code.', 'ROOM_NOT_FOUND')
    if (room.members.length >= room.maxMembers) throw new RoomError(409, 'This room is full.', 'ROOM_FULL')
    const member = { id: memberId, displayName, role: 'member', joinedAt: new Date().toISOString(), online: false, tokenHash }
    room.members.push(member)
    return roomSnapshot(room, room.members)
  }

  async getRoom(code) {
    const room = this.rooms.get(code)
    return roomSnapshot(room, room?.members ?? [])
  }

  async getMember(code, memberId) {
    const room = this.rooms.get(code)
    const member = room?.members.find((entry) => entry.id === memberId)
    return member ? { ...member, roomCode: code } : null
  }

  async setOnline(code, memberId, online) {
    const room = this.rooms.get(code)
    const member = room?.members.find((entry) => entry.id === memberId)
    if (!member) return null
    member.online = online
    return roomSnapshot(room, room.members)
  }

  async leaveRoom(code, memberId) {
    const room = this.rooms.get(code)
    if (!room) return null
    room.members = room.members.filter((member) => member.id !== memberId)
    if (room.members.length === 0) {
      this.rooms.delete(code)
      return null
    }
    return roomSnapshot(room, room.members)
  }
}

class PostgresRoomRepository {
  constructor(pool) {
    this.pool = pool
  }

  async createRoom({ name, displayName, maxMembers, memberId, tokenHash }) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const client = await this.pool.connect()
      const code = makeRoomCode()
      const roomId = randomUUID()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO rooms (id, code, name, creator_guest_id, capacity)
           VALUES ($1, $2, $3, $4, $5)`,
          [roomId, code, name, memberId, maxMembers],
        )
        await client.query(
          `INSERT INTO room_members (id, room_id, display_name, role, member_token_hash)
           VALUES ($1, $2, $3, 'owner', $4)`,
          [memberId, roomId, displayName, tokenHash],
        )
        await client.query('COMMIT')
        return await this.getRoom(code)
      } catch (error) {
        await client.query('ROLLBACK')
        if (error.code === '23505' && attempt < 4) continue
        throw error
      } finally {
        client.release()
      }
    }
    throw new RoomError(503, 'Could not create a unique room code. Please try again.', 'ROOM_CODE_UNAVAILABLE')
  }

  async joinRoom({ code, displayName, memberId, tokenHash }) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const roomResult = await client.query('SELECT id, capacity FROM rooms WHERE code = $1 FOR UPDATE', [code])
      const room = roomResult.rows[0]
      if (!room) throw new RoomError(404, 'We couldn’t find a room with that code.', 'ROOM_NOT_FOUND')
      const countResult = await client.query('SELECT count(*)::int AS count FROM room_members WHERE room_id = $1', [room.id])
      if (countResult.rows[0].count >= room.capacity) throw new RoomError(409, 'This room is full.', 'ROOM_FULL')
      const role = countResult.rows[0].count === 0 ? 'owner' : 'member'
      await client.query(
        `INSERT INTO room_members (id, room_id, display_name, role, member_token_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [memberId, room.id, displayName, role, tokenHash],
      )
      await client.query('COMMIT')
      return await this.getRoom(code)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getRoom(code) {
    const roomResult = await this.pool.query(
      `SELECT id, code, name, created_at, capacity, settings FROM rooms WHERE code = $1`, [code],
    )
    const room = roomResult.rows[0]
    if (!room) return null
    const memberResult = await this.pool.query(
      `SELECT id, display_name, role, joined_at, online FROM room_members WHERE room_id = $1 ORDER BY joined_at, id`,
      [room.id],
    )
    return roomSnapshot({
      id: room.id, code: room.code, name: room.name, createdAt: room.created_at.toISOString(),
      maxMembers: room.capacity, settings: room.settings,
    }, memberResult.rows.map((member) => ({
      id: member.id, displayName: member.display_name, role: member.role,
      joinedAt: member.joined_at.toISOString(), online: member.online,
    })))
  }

  async getMember(code, memberId) {
    const result = await this.pool.query(
      `SELECT m.id, m.display_name, m.role, m.joined_at, m.online, m.member_token_hash
       FROM room_members m JOIN rooms r ON r.id = m.room_id
       WHERE r.code = $1 AND m.id = $2`, [code, memberId],
    )
    const member = result.rows[0]
    return member ? {
      id: member.id, displayName: member.display_name, role: member.role,
      joinedAt: member.joined_at.toISOString(), online: member.online,
      tokenHash: member.member_token_hash.trim(), roomCode: code,
    } : null
  }

  async setOnline(code, memberId, online) {
    await this.pool.query(
      `UPDATE room_members m SET online = $3 FROM rooms r
       WHERE r.id = m.room_id AND r.code = $1 AND m.id = $2`, [code, memberId, online],
    )
    return this.getRoom(code)
  }

  async leaveRoom(code, memberId) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const roomResult = await client.query('SELECT id FROM rooms WHERE code = $1 FOR UPDATE', [code])
      const room = roomResult.rows[0]
      if (!room) {
        await client.query('COMMIT')
        return null
      }
      await client.query('DELETE FROM room_members WHERE room_id = $1 AND id = $2', [room.id, memberId])
      const countResult = await client.query('SELECT count(*)::int AS count FROM room_members WHERE room_id = $1', [room.id])
      if (countResult.rows[0].count === 0) {
        await client.query('DELETE FROM rooms WHERE id = $1', [room.id])
        await client.query('COMMIT')
        return null
      }
      await client.query('COMMIT')
      return this.getRoom(code)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

export class RoomService {
  constructor({ mode = 'memory', pool } = {}) {
    this.mode = mode
    this.repository = mode === 'postgres' ? new PostgresRoomRepository(pool) : new MemoryRoomRepository()
  }

  async createRoom({ name, displayName, maxMembers = 8 }) {
    const memberId = randomUUID()
    const memberToken = createMemberToken()
    const room = await this.repository.createRoom({ name, displayName, maxMembers, memberId, tokenHash: hashToken(memberToken) })
    return { room, member: room.members.find((entry) => entry.id === memberId), memberToken }
  }

  async joinRoom({ code, displayName }) {
    const memberId = randomUUID()
    const memberToken = createMemberToken()
    const room = await this.repository.joinRoom({ code, displayName, memberId, tokenHash: hashToken(memberToken) })
    return { room, member: room.members.find((entry) => entry.id === memberId), memberToken }
  }

  async authenticate({ code, memberId, memberToken }) {
    if (typeof code !== 'string' || !/^[A-Z0-9]{6}$/.test(code) || typeof memberId !== 'string' || !MEMBER_ID_PATTERN.test(memberId)) {
      throw new RoomError(401, 'Your room session is no longer valid. Join the room again.', 'ROOM_SESSION_INVALID')
    }
    const member = await this.repository.getMember(code, memberId)
    if (!member || !tokenMatches(member.tokenHash, memberToken)) {
      throw new RoomError(401, 'Your room session is no longer valid. Join the room again.', 'ROOM_SESSION_INVALID')
    }
    return { code, memberId, memberToken, displayName: member.displayName }
  }

  async getRoom(identity) {
    const room = await this.repository.getRoom(identity.code)
    if (!room) throw new RoomError(404, 'This room is no longer available.', 'ROOM_NOT_FOUND')
    return room
  }

  async setOnline(identity, online) {
    return this.repository.setOnline(identity.code, identity.memberId, online)
  }

  async leaveRoom(identity) {
    await this.authenticate(identity)
    return this.repository.leaveRoom(identity.code, identity.memberId)
  }
}

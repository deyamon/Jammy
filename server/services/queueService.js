import { randomUUID } from 'node:crypto'
import { tracks } from '../../shared/catalog.js'
import { RoomError } from './roomService.js'
import { isYouTubeVideoId } from './youtubeService.js'

const catalog = new Map(tracks.map((track) => [track.id, track]))
const MAX_QUEUE_ITEMS = 50
const MAX_POSITION_MS = 24 * 60 * 60 * 1000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const emptyPlayback = () => ({ currentTrackId: null, currentTrack: null, isPlaying: false, positionMs: 0, repeatMode: 'off', playbackToken: randomUUID(), updatedAt: new Date().toISOString() })

function repeatQueueItem(playback) {
  if (!playback.currentTrackId) return null
  const trackData = catalog.get(playback.currentTrackId) ?? playback.currentTrack
  if (!trackData) return null
  return {
    itemId: randomUUID(), trackId: playback.currentTrackId, trackData,
    dataExpiresAt: playback.currentTrackDataExpiresAt ?? null,
    addedBy: 'Repeat All', addedAt: new Date().toISOString(),
  }
}

function providerTrack(input) {
  if (typeof input?.trackId !== 'string') throw invalidInput('Select a track from Jammy or YouTube search results.')
  const local = catalog.get(input.trackId)
  if (local) return { trackId: local.id, trackData: local, dataExpiresAt: null }
  const videoId = input.trackId.startsWith('youtube:') ? input.trackId.slice(8) : ''
  const candidate = input.trackData
  const cleanText = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, limit) : ''
  const title = cleanText(candidate?.title, 500)
  const channelName = cleanText(candidate?.channelName, 200)
  if (!isYouTubeVideoId(videoId) || candidate?.provider !== 'youtube' || candidate.videoId !== videoId
    || !title || !channelName) {
    throw invalidInput('Select a valid YouTube search result to add to the queue.')
  }
  const thumbnails = Object.fromEntries(['default', 'medium', 'high'].map((size) => {
    const raw = candidate.thumbnails?.[size]
    try {
      const url = new URL(raw)
      return [size, url.protocol === 'https:' && url.hostname === 'i.ytimg.com' ? url.href : null]
    } catch { return [size, null] }
  }))
  // YouTube API metadata is retained only temporarily, within the policy limit.
  const dataExpiresAt = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString()
  return {
    trackId: input.trackId,
    trackData: {
      id: input.trackId, provider: 'youtube', videoId, title,
      artist: channelName, channelName,
      album: 'YouTube video', duration: '--:--', art: 'lime', initials: 'YT',
      thumbnails,
    },
    dataExpiresAt,
  }
}

function validateCode(code) {
  if (typeof code !== 'string' || !/^[A-Z0-9]{6}$/.test(code)) {
    throw new RoomError(400, 'Enter a valid six-character room code.', 'ROOM_CODE_INVALID')
  }
}

function invalidInput(message = 'The queue request is not valid.') {
  return new RoomError(400, message, 'QUEUE_INPUT_INVALID')
}

class MemoryQueueRepository {
  constructor() { this.rooms = new Map() }
  get(code) {
    if (!this.rooms.has(code)) this.rooms.set(code, { queue: [], playback: emptyPlayback() })
    return this.rooms.get(code)
  }
  async snapshot(code) {
    const { queue, playback } = this.get(code)
    const now = Date.now()
    const liveQueue = queue.filter((item) => !item.dataExpiresAt || Date.parse(item.dataExpiresAt) > now)
    if (liveQueue.length !== queue.length) this.get(code).queue = liveQueue
    if (playback.currentTrackId?.startsWith('youtube:') && playback.currentTrackDataExpiresAt && Date.parse(playback.currentTrackDataExpiresAt) <= now) {
      this.get(code).playback = { ...playback, currentTrackId: null, currentTrack: null, currentTrackDataExpiresAt: null, isPlaying: false, positionMs: 0 }
    }
    return { queue: liveQueue.map((item) => ({ ...item })), playback: { ...this.get(code).playback } }
  }
  async add(code, item) { this.get(code).queue.push(item); return this.snapshot(code) }
  async remove(code, itemId) {
    const state = this.get(code)
    if (!state.queue.some((item) => item.itemId === itemId)) throw new RoomError(404, 'That item is no longer in the queue.', 'QUEUE_ITEM_NOT_FOUND')
    state.queue = state.queue.filter((item) => item.itemId !== itemId)
    return this.snapshot(code)
  }
  async reorder(code, itemId, toIndex) {
    const state = this.get(code)
    const fromIndex = state.queue.findIndex((item) => item.itemId === itemId)
    if (fromIndex < 0) throw new RoomError(404, 'That item is no longer in the queue.', 'QUEUE_ITEM_NOT_FOUND')
    if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= state.queue.length) throw invalidInput('Choose a position within the current queue.')
    const [item] = state.queue.splice(fromIndex, 1)
    state.queue.splice(toIndex, 0, item)
    return this.snapshot(code)
  }
  async select(code, itemId, { playImmediately = false } = {}) {
    const state = this.get(code)
    const index = state.queue.findIndex((item) => item.itemId === itemId)
    if (index < 0) throw new RoomError(404, 'That item is no longer in the queue.', 'QUEUE_ITEM_NOT_FOUND')
    const repeatMode = state.playback.repeatMode ?? 'off'
    const [item] = state.queue.splice(index, 1)
    if (repeatMode === 'all') {
      const repeatItem = repeatQueueItem(state.playback)
      if (repeatItem) state.queue.push(repeatItem)
    }
    state.playback = { currentTrackId: item.trackId, currentTrack: item.trackData, currentTrackDataExpiresAt: item.dataExpiresAt, isPlaying: playImmediately, positionMs: 0, repeatMode, playbackToken: randomUUID(), updatedAt: new Date().toISOString() }
    return this.snapshot(code)
  }
  async next(code, expectedTrackId, expectedPlaybackToken, { manual = false } = {}) {
    const state = this.get(code)
    if (state.playback.currentTrackId !== expectedTrackId || state.playback.playbackToken !== expectedPlaybackToken) return this.snapshot(code)
    if (!manual && state.playback.repeatMode === 'one') {
      state.playback = { ...state.playback, isPlaying: true, positionMs: 0, playbackToken: randomUUID(), updatedAt: new Date().toISOString() }
      return this.snapshot(code)
    }
    if (state.playback.repeatMode === 'all') {
      const repeatItem = repeatQueueItem(state.playback)
      if (repeatItem) state.queue.push(repeatItem)
    }
    const [item] = state.queue.splice(0, 1)
    state.playback = item
      ? { currentTrackId: item.trackId, currentTrack: item.trackData, currentTrackDataExpiresAt: item.dataExpiresAt, isPlaying: true, positionMs: 0, repeatMode: state.playback.repeatMode ?? 'off', playbackToken: randomUUID(), updatedAt: new Date().toISOString() }
      : { ...state.playback, isPlaying: false, positionMs: 0, playbackToken: randomUUID(), updatedAt: new Date().toISOString() }
    return this.snapshot(code)
  }
  async setPlayback(code, next) {
    const state = this.get(code)
    state.playback = { ...state.playback, ...next, updatedAt: new Date().toISOString() }
    return this.snapshot(code)
  }
  async setRepeat(code, repeatMode) {
    const state = this.get(code)
    state.playback = { ...state.playback, repeatMode, updatedAt: new Date().toISOString() }
    return this.snapshot(code)
  }
  async deleteRoom(code) { this.rooms.delete(code) }
  async purgeExpired() { for (const code of this.rooms.keys()) await this.snapshot(code) }
}

class PostgresQueueRepository {
  constructor(pool) { this.pool = pool }

  async withRoom(code, operation) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query('SELECT id FROM rooms WHERE code = $1 FOR UPDATE', [code])
      if (!result.rows[0]) throw new RoomError(404, 'This room is no longer available.', 'ROOM_NOT_FOUND')
      await this.purgeExpired(client, result.rows[0].id)
      const state = await operation(client, result.rows[0].id)
      await client.query('COMMIT')
      return state
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async purgeExpired(client, roomId) {
    await client.query("DELETE FROM room_queue WHERE room_id = $1 AND track_id LIKE 'youtube:%' AND track_data_expires_at <= NOW()", [roomId])
    await client.query(`UPDATE room_playback SET current_track_id = NULL, current_track_data = NULL, current_track_data_expires_at = NULL,
      is_playing = FALSE, position_ms = 0, updated_at = NOW()
      WHERE room_id = $1 AND current_track_id LIKE 'youtube:%' AND current_track_data_expires_at <= NOW()`, [roomId])
  }

  async purgeExpiredAll() {
    await this.pool.query("DELETE FROM room_queue WHERE track_id LIKE 'youtube:%' AND track_data_expires_at <= NOW()")
    await this.pool.query(`UPDATE room_playback SET current_track_id = NULL, current_track_data = NULL, current_track_data_expires_at = NULL,
      is_playing = FALSE, position_ms = 0, updated_at = NOW()
      WHERE current_track_id LIKE 'youtube:%' AND current_track_data_expires_at <= NOW()`)
  }

  async read(client, roomId) {
    const [queueResult, playbackResult] = await Promise.all([
      client.query('SELECT id, track_id, track_data, track_data_expires_at, added_by, added_at FROM room_queue WHERE room_id = $1 ORDER BY position, added_at, id', [roomId]),
      client.query('SELECT current_track_id, current_track_data, current_track_data_expires_at, is_playing, position_ms, repeat_mode, playback_token, updated_at FROM room_playback WHERE room_id = $1', [roomId]),
    ])
    const playbackRow = playbackResult.rows[0]
    return {
      queue: queueResult.rows.map((item) => ({ itemId: item.id, trackId: item.track_id, trackData: item.track_data, dataExpiresAt: item.track_data_expires_at?.toISOString() ?? null, addedBy: item.added_by, addedAt: item.added_at.toISOString() })),
      playback: playbackRow ? {
        currentTrackId: playbackRow.current_track_id,
        currentTrack: playbackRow.current_track_data,
        currentTrackDataExpiresAt: playbackRow.current_track_data_expires_at?.toISOString() ?? null,
        isPlaying: playbackRow.is_playing,
        positionMs: playbackRow.position_ms,
        repeatMode: playbackRow.repeat_mode ?? 'off',
        playbackToken: playbackRow.playback_token,
        updatedAt: playbackRow.updated_at.toISOString(),
      } : emptyPlayback(),
    }
  }

  async ensurePlayback(client, roomId) {
    await client.query('INSERT INTO room_playback (room_id) VALUES ($1) ON CONFLICT (room_id) DO NOTHING', [roomId])
  }

  async snapshot(code) {
    const client = await this.pool.connect()
    try {
      const result = await client.query('SELECT id FROM rooms WHERE code = $1', [code])
      if (!result.rows[0]) throw new RoomError(404, 'This room is no longer available.', 'ROOM_NOT_FOUND')
      await this.purgeExpired(client, result.rows[0].id)
      await this.ensurePlayback(client, result.rows[0].id)
      return await this.read(client, result.rows[0].id)
    } finally { client.release() }
  }

  async add(code, item) {
    return this.withRoom(code, async (client, roomId) => {
      const count = await client.query('SELECT count(*)::int AS count FROM room_queue WHERE room_id = $1', [roomId])
      if (count.rows[0].count >= MAX_QUEUE_ITEMS) throw new RoomError(409, 'The shared queue has reached its 50-track limit.', 'QUEUE_FULL')
      await client.query('INSERT INTO room_queue (id, room_id, track_id, track_data, track_data_expires_at, position, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [item.itemId, roomId, item.trackId, item.trackData, item.dataExpiresAt, count.rows[0].count, item.addedBy])
      return this.read(client, roomId)
    })
  }

  async remove(code, itemId) {
    return this.withRoom(code, async (client, roomId) => {
      const items = await client.query('SELECT id FROM room_queue WHERE room_id = $1 ORDER BY position, added_at, id', [roomId])
      const index = items.rows.findIndex((item) => item.id === itemId)
      if (index < 0) throw new RoomError(404, 'That item is no longer in the queue.', 'QUEUE_ITEM_NOT_FOUND')
      await client.query('DELETE FROM room_queue WHERE room_id = $1 AND id = $2', [roomId, itemId])
      for (let position = index + 1; position < items.rows.length; position += 1) {
        await client.query('UPDATE room_queue SET position = $1 WHERE id = $2', [position - 1, items.rows[position].id])
      }
      return this.read(client, roomId)
    })
  }

  async reorder(code, itemId, toIndex) {
    return this.withRoom(code, async (client, roomId) => {
      const items = await client.query('SELECT id FROM room_queue WHERE room_id = $1 ORDER BY position, added_at, id', [roomId])
      const fromIndex = items.rows.findIndex((item) => item.id === itemId)
      if (fromIndex < 0) throw new RoomError(404, 'That item is no longer in the queue.', 'QUEUE_ITEM_NOT_FOUND')
      if (toIndex >= items.rows.length) throw invalidInput('Choose a position within the current queue.')
      const [item] = items.rows.splice(fromIndex, 1)
      items.rows.splice(toIndex, 0, item)
      for (let position = 0; position < items.rows.length; position += 1) {
        await client.query('UPDATE room_queue SET position = $1 WHERE id = $2', [position, items.rows[position].id])
      }
      return this.read(client, roomId)
    })
  }

  async select(code, itemId, { playImmediately = false } = {}) {
    return this.withRoom(code, async (client, roomId) => {
      const items = await client.query('SELECT id, track_id, track_data, track_data_expires_at FROM room_queue WHERE room_id = $1 ORDER BY position, added_at, id', [roomId])
      const selected = items.rows.find((item) => item.id === itemId)
      if (!selected) throw new RoomError(404, 'That item is no longer in the queue.', 'QUEUE_ITEM_NOT_FOUND')
      await this.ensurePlayback(client, roomId)
      const currentResult = await client.query('SELECT current_track_id, current_track_data, current_track_data_expires_at, repeat_mode FROM room_playback WHERE room_id = $1', [roomId])
      const current = currentResult.rows[0]
      const index = items.rows.findIndex((item) => item.id === itemId)
      await client.query('DELETE FROM room_queue WHERE room_id = $1 AND id = $2', [roomId, itemId])
      for (let position = index + 1; position < items.rows.length; position += 1) {
        await client.query('UPDATE room_queue SET position = $1 WHERE id = $2', [position - 1, items.rows[position].id])
      }
      if (current.repeat_mode === 'all' && current.current_track_id) {
        const endPosition = Math.max(0, items.rows.length - 1)
        await client.query('INSERT INTO room_queue (id, room_id, track_id, track_data, track_data_expires_at, position, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [randomUUID(), roomId, current.current_track_id, current.current_track_data, current.current_track_data_expires_at, endPosition, 'Repeat All'])
      }
      await client.query('UPDATE room_playback SET current_track_id = $2, current_track_data = $3, current_track_data_expires_at = $4, playback_token = $5, is_playing = $6, position_ms = 0, updated_at = NOW() WHERE room_id = $1', [roomId, selected.track_id, selected.track_data, selected.track_data_expires_at, randomUUID(), playImmediately])
      return this.read(client, roomId)
    })
  }

  async next(code, expectedTrackId, expectedPlaybackToken, { manual = false } = {}) {
    return this.withRoom(code, async (client, roomId) => {
      await this.ensurePlayback(client, roomId)
      const playbackResult = await client.query('SELECT current_track_id, current_track_data, current_track_data_expires_at, repeat_mode, playback_token FROM room_playback WHERE room_id = $1', [roomId])
      const current = playbackResult.rows[0]
      if (current.current_track_id !== expectedTrackId || current.playback_token !== expectedPlaybackToken) return this.read(client, roomId)
      if (!manual && current.repeat_mode === 'one') {
        await client.query('UPDATE room_playback SET is_playing = TRUE, position_ms = 0, playback_token = $2, updated_at = NOW() WHERE room_id = $1', [roomId, randomUUID()])
        return this.read(client, roomId)
      }
      if (current.repeat_mode === 'all' && current.current_track_id) {
        const count = await client.query('SELECT count(*)::int AS count FROM room_queue WHERE room_id = $1', [roomId])
        await client.query('INSERT INTO room_queue (id, room_id, track_id, track_data, track_data_expires_at, position, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [randomUUID(), roomId, current.current_track_id, current.current_track_data, current.current_track_data_expires_at, count.rows[0].count, 'Repeat All'])
      }
      const first = await client.query('SELECT id, track_id, track_data, track_data_expires_at FROM room_queue WHERE room_id = $1 ORDER BY position, added_at, id LIMIT 1', [roomId])
      if (!first.rows[0]) {
        await client.query('UPDATE room_playback SET is_playing = FALSE, position_ms = 0, playback_token = $2, updated_at = NOW() WHERE room_id = $1', [roomId, randomUUID()])
        return this.read(client, roomId)
      }
      const rest = await client.query('SELECT id FROM room_queue WHERE room_id = $1 AND id <> $2 ORDER BY position, added_at, id', [roomId, first.rows[0].id])
      await client.query('DELETE FROM room_queue WHERE room_id = $1 AND id = $2', [roomId, first.rows[0].id])
      for (let position = 0; position < rest.rows.length; position += 1) {
        await client.query('UPDATE room_queue SET position = $1 WHERE id = $2', [position, rest.rows[position].id])
      }
      await client.query('UPDATE room_playback SET current_track_id = $2, current_track_data = $3, current_track_data_expires_at = $4, playback_token = $5, is_playing = TRUE, position_ms = 0, updated_at = NOW() WHERE room_id = $1', [roomId, first.rows[0].track_id, first.rows[0].track_data, first.rows[0].track_data_expires_at, randomUUID()])
      return this.read(client, roomId)
    })
  }

  async setPlayback(code, next) {
    return this.withRoom(code, async (client, roomId) => {
      await this.ensurePlayback(client, roomId)
      await client.query(
        `UPDATE room_playback SET is_playing = $2, position_ms = $3, updated_at = NOW()
         WHERE room_id = $1`, [roomId, next.isPlaying, next.positionMs],
      )
      return this.read(client, roomId)
    })
  }

  async setRepeat(code, repeatMode) {
    return this.withRoom(code, async (client, roomId) => {
      await this.ensurePlayback(client, roomId)
      await client.query('UPDATE room_playback SET repeat_mode = $2, updated_at = NOW() WHERE room_id = $1', [roomId, repeatMode])
      return this.read(client, roomId)
    })
  }

  async deleteRoom() { /* rooms and queue rows are removed together by the room foreign key */ }
}

export class QueueService {
  constructor({ roomService, youtubeService, mode = 'memory', pool } = {}) {
    this.roomService = roomService
    this.youtubeService = youtubeService
    this.repository = mode === 'postgres' ? new PostgresQueueRepository(pool) : new MemoryQueueRepository()
  }

  async state(identity) {
    const member = await this.roomService.authenticate(identity)
    return this.repository.snapshot(member.code)
  }

  async add(identity, input) {
    const member = await this.roomService.authenticate(identity)
    if (!input) throw invalidInput('Select a track from Jammy or YouTube search results.')
    if (typeof input.trackId === 'string' && input.trackId.startsWith('youtube:') && !this.youtubeService?.verifySelection(input.trackData)) {
      throw invalidInput('Search for this YouTube video again before adding it to a room.')
    }
    const selected = providerTrack(input)
    const state = await this.repository.snapshot(member.code)
    if (state.queue.length >= MAX_QUEUE_ITEMS) throw new RoomError(409, 'The shared queue has reached its 50-track limit.', 'QUEUE_FULL')
    return this.repository.add(member.code, {
      itemId: randomUUID(), ...selected, addedBy: member.displayName, addedAt: new Date().toISOString(),
    })
  }

  async remove(identity, input) {
    const member = await this.roomService.authenticate(identity)
    if (!input || typeof input.itemId !== 'string' || !UUID_PATTERN.test(input.itemId)) throw invalidInput('Select a valid queue item to remove.')
    return this.repository.remove(member.code, input.itemId)
  }

  async reorder(identity, input) {
    const member = await this.roomService.authenticate(identity)
    if (!input || typeof input.itemId !== 'string' || !UUID_PATTERN.test(input.itemId) || !Number.isInteger(input.toIndex) || input.toIndex < 0 || input.toIndex >= MAX_QUEUE_ITEMS) {
      throw invalidInput('Choose a valid queue item and position.')
    }
    return this.repository.reorder(member.code, input.itemId, input.toIndex)
  }

  async select(identity, input) {
    const member = await this.roomService.authenticate(identity)
    if (!input || typeof input.itemId !== 'string' || !UUID_PATTERN.test(input.itemId)) throw invalidInput('Select a valid queue item.')
    if (input.playImmediately !== undefined && typeof input.playImmediately !== 'boolean') throw invalidInput('Choose whether the selected track should start immediately.')
    return this.repository.select(member.code, input.itemId, { playImmediately: input.playImmediately === true })
  }

  async next(identity, input) {
    const member = await this.roomService.authenticate(identity)
    const expectedTrackId = input?.expectedTrackId
    if (typeof expectedTrackId !== 'string' || !(catalog.has(expectedTrackId) || /^youtube:[A-Za-z0-9_-]{11}$/.test(expectedTrackId))) throw invalidInput('A valid current track is required to advance the room queue.')
    const expectedPlaybackToken = input?.expectedPlaybackToken
    if (typeof expectedPlaybackToken !== 'string' || !UUID_PATTERN.test(expectedPlaybackToken)) throw invalidInput('Refresh the room playback state before advancing the queue.')
    return this.repository.next(member.code, expectedTrackId, expectedPlaybackToken)
  }

  async skip(identity, input) {
    const member = await this.roomService.authenticate(identity)
    const expectedTrackId = input?.expectedTrackId
    if (typeof expectedTrackId !== 'string' || !(catalog.has(expectedTrackId) || /^youtube:[A-Za-z0-9_-]{11}$/.test(expectedTrackId))) throw invalidInput('A valid current track is required to advance the room queue.')
    const expectedPlaybackToken = input?.expectedPlaybackToken
    if (typeof expectedPlaybackToken !== 'string' || !UUID_PATTERN.test(expectedPlaybackToken)) throw invalidInput('Refresh the room playback state before advancing the queue.')
    return this.repository.next(member.code, expectedTrackId, expectedPlaybackToken, { manual: true })
  }

  async setRepeat(identity, input) {
    const member = await this.roomService.authenticate(identity)
    if (!['off', 'all', 'one'].includes(input?.repeatMode)) throw invalidInput('Choose Repeat Off, Repeat All, or Repeat One.')
    return this.repository.setRepeat(member.code, input.repeatMode)
  }

  async setPlayback(identity, input) {
    const member = await this.roomService.authenticate(identity)
    if (!input || typeof input.isPlaying !== 'boolean' || !Number.isInteger(input.positionMs) || input.positionMs < 0 || input.positionMs > MAX_POSITION_MS) {
      throw invalidInput('Playback updates need a valid playing state and position.')
    }
    const state = await this.repository.snapshot(member.code)
    if (!state.playback.currentTrackId && input.isPlaying) throw new RoomError(409, 'Choose a track from the queue before starting playback.', 'PLAYBACK_TRACK_REQUIRED')
    if (!state.playback.currentTrackId && input.positionMs !== 0) throw new RoomError(409, 'Choose a track before changing its playback position.', 'PLAYBACK_TRACK_REQUIRED')
    const track = catalog.get(state.playback.currentTrackId) ?? state.playback.currentTrack
    const trackDuration = track ? durationMs(track) : Number.NaN
    if (Number.isFinite(trackDuration) && input.positionMs > trackDuration) throw invalidInput('Playback position must be within the selected track.')
    return this.repository.setPlayback(member.code, { isPlaying: input.isPlaying, positionMs: input.positionMs })
  }

  async removeRoom(code) { validateCode(code); return this.repository.deleteRoom(code) }
  async purgeExpiredYouTubeData() {
    if (this.repository instanceof PostgresQueueRepository) return this.repository.purgeExpiredAll()
    return this.repository.purgeExpired()
  }
}

export { MAX_QUEUE_ITEMS }

function durationMs(track) {
  const [minutes, seconds] = track.duration.split(':').map(Number)
  return Number.isFinite(minutes) && Number.isFinite(seconds) ? (minutes * 60 + seconds) * 1000 : Number.NaN
}

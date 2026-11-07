import { randomUUID } from 'node:crypto'
import { RoomError } from './roomService.js'
import { isYouTubeVideoId } from './youtubeService.js'
import { identifySong, normalizeSongText, sameSongIdentity } from './songIdentity.js'

const MAX_QUEUE_ITEMS = 50
const MAX_AUTOPLAY_TRACK_IDENTITIES = 240
const MAX_AUTOPLAY_VIDEO_IDS = 240
const MAX_AUTOPLAY_SEARCHES_PER_ROOM = 18
const MAX_AUTOPLAY_SEARCHES_PER_ADVANCE = 3
const MAX_POSITION_MS = 24 * 60 * 60 * 1000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const emptyPlayback = () => ({ currentTrackId: null, currentTrack: null, currentTrackIsAutoplay: false, isPlaying: false, positionMs: 0, repeatMode: 'off', autoplayEnabled: false, recentTrackIds: [], playbackToken: randomUUID(), updatedAt: new Date().toISOString() })

function createAutoplayMemory() {
  return {
    songs: new Map(),
    trackIds: new Map(),
    videoIds: new Set(),
    searches: new Set(),
    saturated: false,
    searchBlocked: false,
  }
}

function targetedSearches(identity) {
  const rawQueries = identity.artist
    ? [
      `${identity.artist} songs official audio`,
      `artists similar to ${identity.artist} songs`,
      `songs like ${identity.title} by ${identity.artist}`,
    ]
    : [
      `${identity.title} official audio`,
      `${identity.title} song`,
      `music similar to ${identity.title}`,
    ]
  const seen = new Set()
  return rawQueries.map((query) => query.trim().slice(0, 100)).filter((query) => {
    const key = normalizeSongText(query)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, MAX_AUTOPLAY_SEARCHES_PER_ADVANCE)
}

function rememberCurrent(playback) {
  const recent = Array.isArray(playback.recentTrackIds) ? playback.recentTrackIds : []
  return playback.currentTrackId
    ? [playback.currentTrackId, ...recent.filter((id) => id !== playback.currentTrackId)].slice(0, 20)
    : recent
}

function prioritizeQueue(queue) {
  return [...queue.filter((item) => !item.isAutoplay), ...queue.filter((item) => item.isAutoplay)]
}

function repeatQueueItem(playback) {
  if (!playback.currentTrackId) return null
  const trackData = playback.currentTrack
  if (!trackData) return null
  return {
    itemId: randomUUID(), trackId: playback.currentTrackId, trackData,
    dataExpiresAt: playback.currentTrackDataExpiresAt ?? null,
    addedBy: 'Repeat All', addedAt: new Date().toISOString(),
  }
}

function providerTrack(input) {
  if (typeof input?.trackId !== 'string') throw invalidInput('Select a track from Jammy or YouTube search results.')
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

function hostRequired() {
  return new RoomError(403, 'Only the current room host can control playback.', 'ROOM_HOST_REQUIRED')
}

function stalePlayback() {
  return new RoomError(409, 'Playback changed before that command arrived. Sync the room and try again.', 'PLAYBACK_STATE_STALE')
}

function requireHost(member) {
  if (member.role !== 'owner') throw hostRequired()
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
    const { recentTrackIds, ...sharedPlayback } = this.get(code).playback
    return { queue: liveQueue.map((item) => ({ ...item })), playback: { ...sharedPlayback } }
  }
  async add(code, item) {
    const state = this.get(code)
    state.queue = state.queue.filter((queued) => !queued.dataExpiresAt || Date.parse(queued.dataExpiresAt) > Date.now())
    if (state.queue.length >= MAX_QUEUE_ITEMS) throw new RoomError(409, 'The shared queue has reached its 50-track limit.', 'QUEUE_FULL')
    state.queue = prioritizeQueue(state.queue.filter((queued) => !(queued.isAutoplay && queued.trackId === item.trackId)))
    const insertAt = state.queue.findIndex((queued) => queued.isAutoplay)
    if (insertAt < 0) state.queue.push(item)
    else state.queue.splice(insertAt, 0, item)
    return this.snapshot(code)
  }
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
    state.queue = prioritizeQueue(state.queue)
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
    state.playback = { ...state.playback, currentTrackId: item.trackId, currentTrack: item.trackData, currentTrackDataExpiresAt: item.dataExpiresAt, currentTrackIsAutoplay: Boolean(item.isAutoplay), isPlaying: playImmediately, positionMs: 0, repeatMode, playbackToken: randomUUID(), updatedAt: new Date().toISOString() }
    return this.snapshot(code)
  }
  async next(code, expectedTrackId, expectedPlaybackToken, { manual = false, getRecommendations } = {}) {
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
    if (!state.queue.length && state.playback.autoplayEnabled && getRecommendations) {
      const recommendations = await getRecommendations({ playback: { ...state.playback }, queue: [] })
      if (state.playback.playbackToken !== expectedPlaybackToken) return this.snapshot(code)
      for (const candidate of (state.playback.autoplayEnabled ? recommendations : [])) {
        if (state.queue.length >= MAX_QUEUE_ITEMS) break
        if (candidate.trackId === state.playback.currentTrackId || state.playback.recentTrackIds.includes(candidate.trackId)) continue
        if (state.queue.some((queued) => queued.trackId === candidate.trackId)) continue
        state.queue.push({ ...candidate, itemId: randomUUID(), addedBy: 'Autoplay', addedAt: new Date().toISOString(), isAutoplay: true })
      }
    }
    const [item] = state.queue.splice(0, 1)
    const recentTrackIds = rememberCurrent(state.playback)
    state.playback = item
      ? { ...state.playback, currentTrackId: item.trackId, currentTrack: item.trackData, currentTrackDataExpiresAt: item.dataExpiresAt, currentTrackIsAutoplay: Boolean(item.isAutoplay), recentTrackIds, isPlaying: true, positionMs: 0, repeatMode: state.playback.repeatMode ?? 'off', playbackToken: randomUUID(), updatedAt: new Date().toISOString() }
      : { ...state.playback, currentTrackId: null, currentTrack: null, currentTrackDataExpiresAt: null, currentTrackIsAutoplay: false, recentTrackIds, isPlaying: false, positionMs: 0, playbackToken: randomUUID(), updatedAt: new Date().toISOString() }
    return this.snapshot(code)
  }
  async setPlayback(code, next) {
    const state = this.get(code)
    if (state.playback.currentTrackId !== next.expectedTrackId || state.playback.playbackToken !== next.expectedPlaybackToken) throw stalePlayback()
    state.playback = { ...state.playback, isPlaying: next.isPlaying, positionMs: next.positionMs, updatedAt: new Date().toISOString() }
    return this.snapshot(code)
  }
  async setRepeat(code, repeatMode) {
    const state = this.get(code)
    state.playback = { ...state.playback, repeatMode, updatedAt: new Date().toISOString() }
    return this.snapshot(code)
  }
  async setAutoplay(code, enabled) {
    const state = this.get(code)
    state.playback = { ...state.playback, autoplayEnabled: enabled }
    return this.snapshot(code)
  }
  async deleteRoom(code) { this.rooms.delete(code) }
  async purgeExpired() { for (const code of this.rooms.keys()) await this.snapshot(code) }
}

class PostgresQueueRepository {
  constructor(pool) { this.pool = pool }

  async withRoom(code, operation, { memberId, hostOnly = false } = {}) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query('SELECT id FROM rooms WHERE code = $1 FOR UPDATE', [code])
      if (!result.rows[0]) throw new RoomError(404, 'This room is no longer available.', 'ROOM_NOT_FOUND')
      const roomId = result.rows[0].id
      await this.purgeExpired(client, roomId)
      if (memberId) {
        const member = await client.query('SELECT role FROM room_members WHERE room_id = $1 AND id = $2 FOR UPDATE', [roomId, memberId])
        if (!member.rows[0]) throw new RoomError(401, 'Your room session is no longer valid. Join the room again.', 'ROOM_SESSION_INVALID')
        if (hostOnly && member.rows[0].role !== 'owner') throw hostRequired()
      }
      const state = await operation(client, roomId)
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
      client.query('SELECT id, track_id, track_data, track_data_expires_at, added_by, added_at, is_autoplay FROM room_queue WHERE room_id = $1 ORDER BY position, added_at, id', [roomId]),
      client.query('SELECT current_track_id, current_track_data, current_track_data_expires_at, current_track_is_autoplay, is_playing, position_ms, repeat_mode, autoplay_enabled, recent_track_ids, playback_token, updated_at FROM room_playback WHERE room_id = $1', [roomId]),
    ])
    const playbackRow = playbackResult.rows[0]
    return {
      queue: queueResult.rows.map((item) => ({ itemId: item.id, trackId: item.track_id, trackData: item.track_data, dataExpiresAt: item.track_data_expires_at?.toISOString() ?? null, addedBy: item.added_by, addedAt: item.added_at.toISOString(), isAutoplay: item.is_autoplay })),
      playback: playbackRow ? {
        currentTrackId: playbackRow.current_track_id,
        currentTrack: playbackRow.current_track_data,
        currentTrackDataExpiresAt: playbackRow.current_track_data_expires_at?.toISOString() ?? null,
        currentTrackIsAutoplay: playbackRow.current_track_is_autoplay,
        isPlaying: playbackRow.is_playing,
        positionMs: playbackRow.position_ms,
        repeatMode: playbackRow.repeat_mode ?? 'off',
        autoplayEnabled: playbackRow.autoplay_enabled,
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

  async add(code, item, memberId) {
    return this.withRoom(code, async (client, roomId) => {
      await client.query('DELETE FROM room_queue WHERE room_id = $1 AND is_autoplay = TRUE AND track_id = $2', [roomId, item.trackId])
      const items = await client.query('SELECT id, is_autoplay FROM room_queue WHERE room_id = $1 ORDER BY position, added_at, id', [roomId])
      if (items.rows.length >= MAX_QUEUE_ITEMS) throw new RoomError(409, 'The shared queue has reached its 50-track limit.', 'QUEUE_FULL')
      const insertAt = items.rows.findIndex((queued) => queued.is_autoplay)
      const position = insertAt < 0 ? items.rows.length : insertAt
      for (let index = items.rows.length - 1; index >= position; index -= 1) await client.query('UPDATE room_queue SET position = $1 WHERE id = $2', [index + 1, items.rows[index].id])
      await client.query('INSERT INTO room_queue (id, room_id, track_id, track_data, track_data_expires_at, position, added_by, is_autoplay) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)', [item.itemId, roomId, item.trackId, item.trackData, item.dataExpiresAt, position, item.addedBy])
      return this.read(client, roomId)
    }, { memberId })
  }

  async remove(code, itemId, memberId) {
    return this.withRoom(code, async (client, roomId) => {
      const items = await client.query('SELECT id, is_autoplay FROM room_queue WHERE room_id = $1 ORDER BY position, added_at, id', [roomId])
      const index = items.rows.findIndex((item) => item.id === itemId)
      if (index < 0) throw new RoomError(404, 'That item is no longer in the queue.', 'QUEUE_ITEM_NOT_FOUND')
      await client.query('DELETE FROM room_queue WHERE room_id = $1 AND id = $2', [roomId, itemId])
      for (let position = index + 1; position < items.rows.length; position += 1) {
        await client.query('UPDATE room_queue SET position = $1 WHERE id = $2', [position - 1, items.rows[position].id])
      }
      return this.read(client, roomId)
    }, { memberId })
  }

  async reorder(code, itemId, toIndex, memberId) {
    return this.withRoom(code, async (client, roomId) => {
      const items = await client.query('SELECT id, is_autoplay FROM room_queue WHERE room_id = $1 ORDER BY position, added_at, id', [roomId])
      const fromIndex = items.rows.findIndex((item) => item.id === itemId)
      if (fromIndex < 0) throw new RoomError(404, 'That item is no longer in the queue.', 'QUEUE_ITEM_NOT_FOUND')
      if (toIndex >= items.rows.length) throw invalidInput('Choose a position within the current queue.')
      const [item] = items.rows.splice(fromIndex, 1)
      items.rows.splice(toIndex, 0, item)
      const ordered = prioritizeQueue(items.rows)
      for (let position = 0; position < ordered.length; position += 1) {
        await client.query('UPDATE room_queue SET position = $1 WHERE id = $2', [position, ordered[position].id])
      }
      return this.read(client, roomId)
    }, { memberId })
  }

  async select(code, itemId, { playImmediately = false, memberId } = {}) {
    return this.withRoom(code, async (client, roomId) => {
      const items = await client.query('SELECT id, track_id, track_data, track_data_expires_at, is_autoplay FROM room_queue WHERE room_id = $1 ORDER BY position, added_at, id', [roomId])
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
      await client.query('UPDATE room_playback SET current_track_id = $2, current_track_data = $3, current_track_data_expires_at = $4, current_track_is_autoplay = $5, playback_token = $6, is_playing = $7, position_ms = 0, updated_at = NOW() WHERE room_id = $1', [roomId, selected.track_id, selected.track_data, selected.track_data_expires_at, selected.is_autoplay, randomUUID(), playImmediately])
      return this.read(client, roomId)
    }, { memberId, hostOnly: true })
  }

  async next(code, expectedTrackId, expectedPlaybackToken, { manual = false, memberId, getRecommendations } = {}) {
    return this.withRoom(code, async (client, roomId) => {
      await this.ensurePlayback(client, roomId)
      const playbackResult = await client.query('SELECT current_track_id, current_track_data, current_track_data_expires_at, repeat_mode, autoplay_enabled, recent_track_ids, playback_token FROM room_playback WHERE room_id = $1 FOR UPDATE', [roomId])
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
      const first = await client.query('SELECT id, track_id, track_data, track_data_expires_at, is_autoplay FROM room_queue WHERE room_id = $1 ORDER BY position, added_at, id LIMIT 1', [roomId])
      if (!first.rows[0] && current.autoplay_enabled && getRecommendations) {
        const recent = current.recent_track_ids ?? []
        const recommendations = await getRecommendations({ playback: { currentTrackId: current.current_track_id, currentTrack: current.current_track_data, recentTrackIds: recent }, queue: [] })
        for (const candidate of recommendations) {
          if (candidate.trackId === current.current_track_id || recent.includes(candidate.trackId)) continue
          const duplicate = await client.query('SELECT 1 FROM room_queue WHERE room_id = $1 AND track_id = $2 LIMIT 1', [roomId, candidate.trackId])
          if (duplicate.rowCount) continue
          const count = await client.query('SELECT count(*)::int AS count FROM room_queue WHERE room_id = $1', [roomId])
          if (count.rows[0].count >= MAX_QUEUE_ITEMS) break
          await client.query('INSERT INTO room_queue (id, room_id, track_id, track_data, track_data_expires_at, position, added_by, is_autoplay) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)', [randomUUID(), roomId, candidate.trackId, candidate.trackData, candidate.dataExpiresAt, count.rows[0].count, 'Autoplay'])
        }
        const suggestions = await client.query('SELECT id, track_id, track_data, track_data_expires_at, is_autoplay FROM room_queue WHERE room_id = $1 ORDER BY position, added_at, id LIMIT 1', [roomId])
        if (suggestions.rows[0]) first.rows[0] = suggestions.rows[0]
      }
      if (!first.rows[0]) {
        const recent = rememberCurrent({ currentTrackId: current.current_track_id, recentTrackIds: current.recent_track_ids ?? [] })
        await client.query('UPDATE room_playback SET current_track_id = NULL, current_track_data = NULL, current_track_data_expires_at = NULL, current_track_is_autoplay = FALSE, recent_track_ids = $3, is_playing = FALSE, position_ms = 0, playback_token = $2, updated_at = NOW() WHERE room_id = $1', [roomId, randomUUID(), JSON.stringify(recent)])
        return this.read(client, roomId)
      }
      const rest = await client.query('SELECT id FROM room_queue WHERE room_id = $1 AND id <> $2 ORDER BY position, added_at, id', [roomId, first.rows[0].id])
      await client.query('DELETE FROM room_queue WHERE room_id = $1 AND id = $2', [roomId, first.rows[0].id])
      for (let position = 0; position < rest.rows.length; position += 1) {
        await client.query('UPDATE room_queue SET position = $1 WHERE id = $2', [position, rest.rows[position].id])
      }
      const recent = rememberCurrent({ currentTrackId: current.current_track_id, recentTrackIds: current.recent_track_ids ?? [] })
      await client.query('UPDATE room_playback SET current_track_id = $2, current_track_data = $3, current_track_data_expires_at = $4, current_track_is_autoplay = $5, recent_track_ids = $6, playback_token = $7, is_playing = TRUE, position_ms = 0, updated_at = NOW() WHERE room_id = $1', [roomId, first.rows[0].track_id, first.rows[0].track_data, first.rows[0].track_data_expires_at, Boolean(first.rows[0].is_autoplay), JSON.stringify(recent), randomUUID()])
      return this.read(client, roomId)
    }, { memberId, hostOnly: true })
  }

  async setPlayback(code, next, memberId) {
    return this.withRoom(code, async (client, roomId) => {
      await this.ensurePlayback(client, roomId)
      const currentResult = await client.query('SELECT current_track_id, playback_token FROM room_playback WHERE room_id = $1 FOR UPDATE', [roomId])
      const current = currentResult.rows[0]
      if (current?.current_track_id !== next.expectedTrackId || current?.playback_token !== next.expectedPlaybackToken) throw stalePlayback()
      await client.query(
        `UPDATE room_playback SET is_playing = $2, position_ms = $3, updated_at = NOW()
         WHERE room_id = $1`, [roomId, next.isPlaying, next.positionMs],
      )
      return this.read(client, roomId)
    }, { memberId, hostOnly: true })
  }

  async setRepeat(code, repeatMode, memberId) {
    return this.withRoom(code, async (client, roomId) => {
      await this.ensurePlayback(client, roomId)
      await client.query('UPDATE room_playback SET repeat_mode = $2, updated_at = NOW() WHERE room_id = $1', [roomId, repeatMode])
      return this.read(client, roomId)
    }, { memberId, hostOnly: true })
  }

  async setAutoplay(code, enabled, memberId) {
    return this.withRoom(code, async (client, roomId) => {
      await this.ensurePlayback(client, roomId)
      await client.query('UPDATE room_playback SET autoplay_enabled = $2 WHERE room_id = $1', [roomId, enabled])
      return this.read(client, roomId)
    }, { memberId, hostOnly: true })
  }

  async deleteRoom() { /* rooms and queue rows are removed together by the room foreign key */ }
}

export class QueueService {
  constructor({ roomService, youtubeService, mode = 'memory', pool } = {}) {
    this.roomService = roomService
    this.youtubeService = youtubeService
    this.repository = mode === 'postgres' ? new PostgresQueueRepository(pool) : new MemoryQueueRepository()
    this.pendingAdvances = new Map()
    this.autoplaySessions = new Map()
  }

  autoplayMemory(code) {
    if (!this.autoplaySessions.has(code)) this.autoplaySessions.set(code, createAutoplayMemory())
    return this.autoplaySessions.get(code)
  }

  rememberIdentity(code, identity, trackId = null) {
    if (!identity) return
    const memory = this.autoplayMemory(code)
    const existing = identity.artistKey
      ? [...memory.songs.values()].find((known) => known.artistKey && sameSongIdentity(known, identity))
      : null
    const storedIdentity = existing ?? identity
    const key = `${identity.artistKey}::${identity.titleKey}`
    if (!existing && !memory.songs.has(key)) {
      if (memory.songs.size >= MAX_AUTOPLAY_TRACK_IDENTITIES) {
        const oldestKey = memory.songs.keys().next().value
        const oldestIdentity = memory.songs.get(oldestKey)

        memory.songs.delete(oldestKey)

        for (const [id, known] of memory.trackIds) {
          if (known === oldestIdentity) memory.trackIds.delete(id)
        }
      }

      memory.songs.set(key, identity)
    }
    if (trackId) memory.trackIds.set(trackId, storedIdentity)
    if (trackId?.startsWith('youtube:')) {
      memory.videoIds.add(trackId.slice(8))
      if (memory.videoIds.size > MAX_AUTOPLAY_VIDEO_IDS) {
        const oldestVideoId = memory.videoIds.values().next().value
        if (oldestVideoId) memory.videoIds.delete(oldestVideoId)
      }
    }
  }

  rememberTrack(code, track, trackId = track?.id) {
    const memory = this.autoplayMemory(code)
    const knownIdentity = trackId ? memory.trackIds.get(trackId) : null
    const artistHints = [...memory.songs.values()].map((identity) => identity.artist)
    this.rememberIdentity(code, knownIdentity ?? identifySong(track, artistHints), trackId)
  }

  async state(identity) {
    const member = await this.roomService.authenticate(identity)
    return this.repository.snapshot(member.code)
  }

  async add(identity, input) {
    let member = await this.roomService.authenticate(identity)
    if (!input) throw invalidInput('Select a track from Jammy or YouTube search results.')
    if (typeof input.trackId === 'string' && input.trackId.startsWith('youtube:') && !this.youtubeService?.verifySelection(input.trackData)) {
      throw invalidInput('Search for this YouTube video again before adding it to a room.')
    }
    const selected = providerTrack(input)
    const state = await this.repository.snapshot(member.code)
    if (state.queue.length >= MAX_QUEUE_ITEMS) throw new RoomError(409, 'The shared queue has reached its 50-track limit.', 'QUEUE_FULL')
    member = await this.roomService.authenticate(identity)
    const addedState = await this.repository.add(member.code, {
      itemId: randomUUID(), ...selected, addedBy: member.displayName, addedAt: new Date().toISOString(), isAutoplay: false,
    }, member.memberId)
    this.rememberTrack(member.code, selected.trackData, selected.trackId)
    return addedState
  }

  async remove(identity, input) {
    const member = await this.roomService.authenticate(identity)
    if (!input || typeof input.itemId !== 'string' || !UUID_PATTERN.test(input.itemId)) throw invalidInput('Select a valid queue item to remove.')
    return this.repository.remove(member.code, input.itemId, member.memberId)
  }

  async reorder(identity, input) {
    const member = await this.roomService.authenticate(identity)
    if (!input || typeof input.itemId !== 'string' || !UUID_PATTERN.test(input.itemId) || !Number.isInteger(input.toIndex) || input.toIndex < 0 || input.toIndex >= MAX_QUEUE_ITEMS) {
      throw invalidInput('Choose a valid queue item and position.')
    }
    return this.repository.reorder(member.code, input.itemId, input.toIndex, member.memberId)
  }

  async select(identity, input) {
    const member = await this.roomService.authenticate(identity)
    requireHost(member)
    if (!input || typeof input.itemId !== 'string' || !UUID_PATTERN.test(input.itemId)) throw invalidInput('Select a valid queue item.')
    if (input.playImmediately !== undefined && typeof input.playImmediately !== 'boolean') throw invalidInput('Choose whether the selected track should start immediately.')
    return this.repository.select(member.code, input.itemId, { playImmediately: input.playImmediately === true, memberId: member.memberId })
  }

  async next(identity, input, { tasteProfile = null } = {}) {
    const member = await this.roomService.authenticate(identity)
    requireHost(member)
    const expectedTrackId = input?.expectedTrackId
    if (typeof expectedTrackId !== 'string' || !/^youtube:[A-Za-z0-9_-]{11}$/.test(expectedTrackId)) throw invalidInput('A valid current track is required to advance the room queue.')
    const expectedPlaybackToken = input?.expectedPlaybackToken
    if (typeof expectedPlaybackToken !== 'string' || !UUID_PATTERN.test(expectedPlaybackToken)) throw invalidInput('Refresh the room playback state before advancing the queue.')
    const key = `${member.code}:${expectedPlaybackToken}`
    if (this.pendingAdvances.has(key)) return this.pendingAdvances.get(key)
    const operation = this.repository.next(member.code, expectedTrackId, expectedPlaybackToken, { memberId: member.memberId, getRecommendations: (context) => this.recommend({ ...context, roomCode: member.code, tasteProfile }) })
    this.pendingAdvances.set(key, operation)
    try { return await operation } finally { this.pendingAdvances.delete(key) }
  }

  async skip(identity, input, { tasteProfile = null } = {}) {
    const member = await this.roomService.authenticate(identity)
    requireHost(member)
    const expectedTrackId = input?.expectedTrackId
    if (typeof expectedTrackId !== 'string' || !/^youtube:[A-Za-z0-9_-]{11}$/.test(expectedTrackId)) throw invalidInput('A valid current track is required to advance the room queue.')
    const expectedPlaybackToken = input?.expectedPlaybackToken
    if (typeof expectedPlaybackToken !== 'string' || !UUID_PATTERN.test(expectedPlaybackToken)) throw invalidInput('Refresh the room playback state before advancing the queue.')
    const key = `${member.code}:${expectedPlaybackToken}`
    if (this.pendingAdvances.has(key)) return this.pendingAdvances.get(key)
    const operation = this.repository.next(member.code, expectedTrackId, expectedPlaybackToken, { manual: true, memberId: member.memberId, getRecommendations: (context) => this.recommend({ ...context, roomCode: member.code, tasteProfile }) })
    this.pendingAdvances.set(key, operation)
    try { return await operation } finally { this.pendingAdvances.delete(key) }
  }

  async setRepeat(identity, input) {
    const member = await this.roomService.authenticate(identity)
    requireHost(member)
    if (!['off', 'all', 'one'].includes(input?.repeatMode)) throw invalidInput('Choose Repeat Off, Repeat All, or Repeat One.')
    return this.repository.setRepeat(member.code, input.repeatMode, member.memberId)
  }

  async setAutoplay(identity, input) {
    const member = await this.roomService.authenticate(identity)
    requireHost(member)
    if (typeof input?.enabled !== 'boolean') throw invalidInput('Choose whether Autoplay is on or off.')
    return this.repository.setAutoplay(member.code, input.enabled, member.memberId)
  }

  async recommend({ playback, queue = [], roomCode, tasteProfile = null }) {
    if (!this.youtubeService || typeof this.youtubeService.search !== 'function') return []
    const memory = this.autoplayMemory(roomCode)
    const currentTrack = playback.currentTrack
    const artistHints = [...memory.songs.values()].map((identity) => identity.artist)
    this.rememberTrack(roomCode, currentTrack, playback.currentTrackId)
    const currentIdentity = memory.trackIds.get(playback.currentTrackId) ?? identifySong(currentTrack, artistHints, { allowTitleOnly: true })
    if (!currentIdentity) {
      console.info('[autoplay] recommendation search skipped', { reason: !currentIdentity ? 'track_title_unavailable' : 'room_history_limit_reached' })
      return []
    }
    this.rememberIdentity(roomCode, currentIdentity, playback.currentTrackId)

    const searches = targetedSearches(currentIdentity)
    const favoriteArtist = Array.isArray(tasteProfile?.favoriteArtists) ? tasteProfile.favoriteArtists.find((artist) => typeof artist?.name === 'string' && artist.name.trim())?.name.trim() : ''
    if (favoriteArtist && currentIdentity.artist) {
      const personalizedQuery = `${currentIdentity.title} ${currentIdentity.artist} related to ${favoriteArtist} official audio`.trim().slice(0, 100)
      const personalizedKey = normalizeSongText(personalizedQuery)
      if (personalizedKey && !searches.some((query) => normalizeSongText(query) === personalizedKey)) searches.splice(Math.max(0, MAX_AUTOPLAY_SEARCHES_PER_ADVANCE - 1), 1, personalizedQuery)
    }
    const recommendations = []
    const diagnostic = { candidates: 0, duplicate: 0, ambiguous: 0, invalid: 0, emptySearches: 0, failures: [] }
    console.info('[autoplay] recommendation search started')
    const seenVideoIds = new Set([
      playback.currentTrackId?.startsWith('youtube:') ? playback.currentTrackId.slice(8) : '',
      ...(playback.recentTrackIds ?? []).map((id) => id.startsWith('youtube:') ? id.slice(8) : ''),
      ...queue.map((item) => item.trackId?.startsWith('youtube:') ? item.trackId.slice(8) : ''),
      ...memory.videoIds,
    ].filter(Boolean))
    const seenSongs = [...memory.songs.values()]
    for (const item of queue) {
      const queuedIdentity = identifySong(item.trackData, artistHints)
      if (queuedIdentity && !seenSongs.some((known) => sameSongIdentity(known, queuedIdentity))) seenSongs.push(queuedIdentity)
    }

    if (memory.searchBlocked) return []

    for (const query of searches) {
      if (recommendations.length >= 5) break

      const queryKey = normalizeSongText(query)
      if (memory.searches.has(queryKey)) continue

      let results
      try {
        results = await this.youtubeService.search(query)

        // Record only completed searches, allowing failed searches to retry.
        memory.searches.add(queryKey)

        // Keep a rolling history instead of permanently exhausting Autoplay.
        if (memory.searches.size > MAX_AUTOPLAY_SEARCHES_PER_ROOM) {
          const oldest = memory.searches.values().next().value
          if (oldest) memory.searches.delete(oldest)
        }
      } catch (error) {
        const failureCode = error?.code

        diagnostic.failures.push(
          typeof failureCode === 'string' && /^[A-Z0-9_]{1,48}$/.test(failureCode)
            ? failureCode
            : 'search_failed'
        )

        if (['YOUTUBE_QUOTA_EXCEEDED', 'YOUTUBE_NOT_CONFIGURED'].includes(error?.code)) {
          memory.searchBlocked = true
          break
        }

        continue
      }

      const candidates = Array.isArray(results) ? results : []
      diagnostic.candidates += candidates.length
      if (!candidates.length) diagnostic.emptySearches += 1
      for (const result of candidates) {
        if (!result || !isYouTubeVideoId(result.videoId)) { diagnostic.invalid += 1; continue }
        if (seenVideoIds.has(result.videoId)) { diagnostic.duplicate += 1; continue }
        seenVideoIds.add(result.videoId)
        const trackId = `youtube:${result.videoId}`
        const candidate = { provider: 'youtube', title: result.title, channelName: result.channelName, artist: result.channelName }
        const candidateIdentity = identifySong(candidate, [currentIdentity.artist, ...artistHints])
        if (!candidateIdentity) {
          diagnostic.ambiguous += 1
          memory.videoIds.add(result.videoId)
          if (memory.videoIds.size > MAX_AUTOPLAY_VIDEO_IDS) {
            const oldestVideoId = memory.videoIds.values().next().value
            if (oldestVideoId) memory.videoIds.delete(oldestVideoId)
          }
          continue
        }
        if (seenSongs.some((known) => sameSongIdentity(known, candidateIdentity))) {
          diagnostic.duplicate += 1
          this.rememberIdentity(roomCode, candidateIdentity, trackId)
          continue
        }
        if (!this.youtubeService.verifySelection?.(result)) {
          diagnostic.invalid += 1
          this.rememberIdentity(roomCode, candidateIdentity, trackId)
          continue
        }

        const selected = providerTrack({
          trackId, trackData: {
            id: trackId, provider: 'youtube', videoId: result.videoId, title: result.title,
            channelName: result.channelName, thumbnails: result.thumbnails,
          }
        })
        this.rememberIdentity(roomCode, candidateIdentity, trackId)
        seenSongs.push(candidateIdentity)
        recommendations.push({ ...selected, isAutoplay: true, addedBy: 'Autoplay', addedAt: new Date().toISOString() })
        if (recommendations.length >= 5) break
      }
    }
    console.info('[autoplay] recommendation search completed', {
      ...diagnostic,
      added: recommendations.length,
    })
    return recommendations
  }

  async setPlayback(identity, input) {
    let member = await this.roomService.authenticate(identity)
    requireHost(member)
    if (!input || typeof input.isPlaying !== 'boolean' || !Number.isInteger(input.positionMs) || input.positionMs < 0 || input.positionMs > MAX_POSITION_MS) {
      throw invalidInput('Playback updates need a valid playing state and position.')
    }
    if (typeof input.expectedTrackId !== 'string' || !/^youtube:[A-Za-z0-9_-]{11}$/.test(input.expectedTrackId)
      || typeof input.expectedPlaybackToken !== 'string' || !UUID_PATTERN.test(input.expectedPlaybackToken)) {
      throw invalidInput('Playback updates need the current track and playback token.')
    }
    const state = await this.repository.snapshot(member.code)
    member = await this.roomService.authenticate(identity)
    requireHost(member)
    if (state.playback.currentTrackId !== input.expectedTrackId || state.playback.playbackToken !== input.expectedPlaybackToken) throw stalePlayback()
    if (!state.playback.currentTrackId && input.isPlaying) throw new RoomError(409, 'Choose a track from the queue before starting playback.', 'PLAYBACK_TRACK_REQUIRED')
    if (!state.playback.currentTrackId && input.positionMs !== 0) throw new RoomError(409, 'Choose a track before changing its playback position.', 'PLAYBACK_TRACK_REQUIRED')
    const track = state.playback.currentTrack
    const trackDuration = track ? durationMs(track) : Number.NaN
    if (Number.isFinite(trackDuration) && input.positionMs > trackDuration) throw invalidInput('Playback position must be within the selected track.')
    return this.repository.setPlayback(member.code, {
      isPlaying: input.isPlaying, positionMs: input.positionMs,
      expectedTrackId: input.expectedTrackId, expectedPlaybackToken: input.expectedPlaybackToken,
    }, member.memberId)
  }

  async removeRoom(code) { validateCode(code); this.autoplaySessions.delete(code); return this.repository.deleteRoom(code) }
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

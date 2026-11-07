import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import pg from 'pg'
import argon2 from 'argon2'
import cors from 'cors'
import express from 'express'
import { applyMigrations, MIGRATIONS } from './migrate.js'
import { createAuthRouter, createRateLimiter } from './routes/auth.js'
import { AuthService, hashOpaqueToken } from './services/authService.js'
import { validateTestDatabaseUrl } from './postgresTestGuard.js'

// Validate before constructing any pool. This file never reads .env or falls back to DATABASE_URL.
const testDatabaseUrl = validateTestDatabaseUrl(process.env)
const { Pool } = pg
const schemaSource = fileURLToPath(new URL('./schema.sql', import.meta.url))
const allowedOrigin = 'http://localhost:5173'
const ownerIndexSql = "CREATE UNIQUE INDEX IF NOT EXISTS room_members_one_owner_idx ON room_members(room_id) WHERE role = 'owner';"
const migrationVersionsExpected = MIGRATIONS.map(({ version }) => version)

function poolForSchema(schema) {
  return new Pool({
    connectionString: testDatabaseUrl,
    options: '-c search_path=' + schema,
    max: 4,
    connectionTimeoutMillis: 5000,
  })
}

async function createIsolatedSchema(adminPool) {
  const schema = 'jammy_it_' + process.pid + '_' + randomBytes(5).toString('hex')
  await adminPool.query('CREATE SCHEMA "' + schema + '"')
  const pool = poolForSchema(schema)
  try {
    const selected = await pool.query('SELECT current_schema() AS schema')
    if (selected.rows[0]?.schema !== schema) {
      await pool.end()
      await adminPool.query('DROP SCHEMA "' + schema + '" CASCADE')
      throw new Error('Could not establish the generated isolated PostgreSQL schema; no test DDL was run.')
    }
  } catch (error) {
    if (error.message === 'Could not establish the generated isolated PostgreSQL schema; no test DDL was run.') throw error
    await pool.end().catch(() => {})
    await adminPool.query('DROP SCHEMA "' + schema + '" CASCADE')
    throw new Error('Could not select the generated isolated PostgreSQL schema; no test DDL was run.')
  }
  let closed = false
  return {
    schema,
    pool,
    async close() {
      if (closed) return
      closed = true
      await pool.end()
      await adminPool.query('DROP SCHEMA "' + schema + '" CASCADE')
    },
  }
}

async function seedRoom(pool, { twoOwners = false } = {}) {
  const roomId = randomUUID()
  const ownerId = randomUUID()
  const memberId = randomUUID()
  await pool.query(
    'INSERT INTO rooms (id, code, name, creator_guest_id, capacity, created_at) VALUES ($1, $2, $3, $4, 8, $5)',
    [roomId, 'TST001', 'Migration fixture', ownerId, new Date('2026-01-01T00:00:00Z')],
  )
  await pool.query(
    'INSERT INTO room_members (id, room_id, display_name, role, joined_at, online, member_token_hash) VALUES ($1, $3, $4, $5, $6, TRUE, $7), ($2, $3, $8, $9, $10, FALSE, $11)',
    [ownerId, memberId, roomId, 'Host', 'owner', new Date('2026-01-01T00:00:01Z'), 'a'.repeat(64), 'Guest', twoOwners ? 'owner' : 'member', new Date('2026-01-01T00:00:02Z'), 'b'.repeat(64)],
  )
  await pool.query(
    'INSERT INTO room_queue (id, room_id, track_id, track_data, position, added_by, added_at) VALUES ($1, $2, $3, $4, 0, $5, $6)',
    [randomUUID(), roomId, 'youtube:fixture', JSON.stringify({ title: 'Fixture track' }), 'Host', new Date('2026-01-01T00:00:03Z')],
  )
  await pool.query(
    'INSERT INTO room_playback (room_id, current_track_id, is_playing, position_ms, repeat_mode, playback_token, updated_at) VALUES ($1, $2, TRUE, 42100, $3, $4, $5)',
    [roomId, 'youtube:fixture', 'all', randomUUID(), new Date('2026-01-01T00:00:04Z')],
  )
  return { roomId }
}

async function snapshotRoom(pool, roomId) {
  const room = await pool.query('SELECT id, code, name, creator_guest_id, created_at, capacity, settings FROM rooms WHERE id = $1', [roomId])
  const members = await pool.query('SELECT id, room_id, display_name, role, joined_at, online, member_token_hash FROM room_members WHERE room_id = $1 ORDER BY id', [roomId])
  const queue = await pool.query('SELECT id, room_id, track_id, track_data, position, added_by, added_at FROM room_queue WHERE room_id = $1 ORDER BY id', [roomId])
  const playback = await pool.query('SELECT room_id, current_track_id, is_playing, position_ms, repeat_mode, playback_token, updated_at FROM room_playback WHERE room_id = $1', [roomId])
  return { room: room.rows, members: members.rows, queue: queue.rows, playback: playback.rows }
}

async function migrationVersions(pool) {
  const result = await pool.query('SELECT version FROM schema_migrations ORDER BY version')
  return result.rows.map((row) => row.version)
}

function startAuthHttp(pool) {
  const app = express()
  const allowedOrigins = [allowedOrigin]
  app.use(cors({ origin: allowedOrigins, credentials: true }))
  app.use(express.json({ limit: '16kb' }))
  app.use('/api/auth', createAuthRouter({
    authService: new AuthService(pool),
    allowedOrigins,
    secureCookies: false,
    registrationRateLimiter: createRateLimiter({ limit: 20, windowMs: 60_000 }),
    loginRateLimiter: createRateLimiter({ limit: 20, windowMs: 60_000 }),
  }))
  const server = createServer(app)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve({
        base: 'http://127.0.0.1:' + server.address().port + '/api/auth',
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

async function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { origin: allowedOrigin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

test('guarded PostgreSQL migration and authentication integration suite', { concurrency: false }, async (t) => {
  const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 2, connectionTimeoutMillis: 5000 })
  try {
    await adminPool.query('SELECT 1')
  } catch {
    await adminPool.end()
    throw new Error('Could not connect to the designated local Jammy test database; connection details are omitted.')
  }
  t.after(() => adminPool.end())

  await t.test('empty schema applies migrations in order and reruns idempotently', async (t) => {
    const isolated = await createIsolatedSchema(adminPool)
    t.after(() => isolated.close())
    const first = await applyMigrations(isolated.pool)
    assert.deepEqual(first.applied, migrationVersionsExpected)
    assert.deepEqual(first.skipped, [])
    assert.deepEqual(await migrationVersions(isolated.pool), migrationVersionsExpected)
    const second = await applyMigrations(isolated.pool)
    assert.deepEqual(second.applied, [])
    assert.deepEqual(second.skipped, migrationVersionsExpected)
    assert.deepEqual(await migrationVersions(isolated.pool), migrationVersionsExpected)
  })

  await t.test('existing room schema without history upgrades and preserves room data through authentication migration', async (t) => {
    const isolated = await createIsolatedSchema(adminPool)
    t.after(() => isolated.close())
    const source = await readFile(schemaSource, 'utf8')
    assert.ok(source.includes(ownerIndexSql))
    const legacySchema = source.replace(ownerIndexSql, '')
    assert.notEqual(legacySchema, source)
    await isolated.pool.query(legacySchema)
    const { roomId } = await seedRoom(isolated.pool)
    const before = await snapshotRoom(isolated.pool, roomId)

    const result = await applyMigrations(isolated.pool)
    assert.deepEqual(result.applied, migrationVersionsExpected)
    assert.deepEqual(await snapshotRoom(isolated.pool, roomId), before)
    assert.deepEqual(await migrationVersions(isolated.pool), migrationVersionsExpected)
  })

  await t.test('personal music migration creates user-scoped Spotify and Jammy tables without changing room state', async (t) => {
    const isolated = await createIsolatedSchema(adminPool)
    t.after(() => isolated.close())
    await isolated.pool.query(await readFile(schemaSource, 'utf8'))
    const { roomId } = await seedRoom(isolated.pool)
    const before = await snapshotRoom(isolated.pool, roomId)
    const result = await applyMigrations(isolated.pool)
    assert.deepEqual(result.applied, migrationVersionsExpected)
    assert.deepEqual(await snapshotRoom(isolated.pool, roomId), before)

    await isolated.pool.query('INSERT INTO jammy_listening_history (user_id, event_id, video_id, title, source) VALUES ($1, $2, $3, $4, $5)', ['neon-user-a', 'play-event-001', 'abcdefghijk', 'Fixture Jammy track', 'standalone'])
    await isolated.pool.query('INSERT INTO spotify_connections (user_id, access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL \'1 hour\')', ['neon-user-a', 'encrypted-access', 'encrypted-refresh'])
    await isolated.pool.query('INSERT INTO spotify_imported_items (user_id, kind, provider_item_id, data) VALUES ($1, $2, $3, $4)', ['neon-user-a', 'top_artist', 'spotify-artist-1', JSON.stringify({ name: 'Fixture artist' })])
    await isolated.pool.query('INSERT INTO music_taste_profiles (user_id, profile_json) VALUES ($1, $2)', ['neon-user-a', JSON.stringify({ favoriteArtists: [] })])
    const history = await isolated.pool.query('SELECT user_id FROM jammy_listening_history WHERE event_id = $1', ['play-event-001'])
    const imported = await isolated.pool.query('SELECT user_id FROM spotify_imported_items WHERE provider_item_id = $1', ['spotify-artist-1'])
    assert.equal(history.rows[0].user_id, 'neon-user-a')
    assert.equal(imported.rows[0].user_id, 'neon-user-a')
  })

  await t.test('legacy multiple-owner state blocks baseline migration without rewriting data or recording the version', async (t) => {
    const isolated = await createIsolatedSchema(adminPool)
    t.after(() => isolated.close())
    const source = await readFile(schemaSource, 'utf8')
    await isolated.pool.query(source.replace(ownerIndexSql, ''))
    const { roomId } = await seedRoom(isolated.pool, { twoOwners: true })
    const before = await isolated.pool.query('SELECT id, role FROM room_members WHERE room_id = $1 ORDER BY id', [roomId])

    await assert.rejects(applyMigrations(isolated.pool, { migrations: [MIGRATIONS[0]] }))
    const after = await isolated.pool.query('SELECT id, role FROM room_members WHERE room_id = $1 ORDER BY id', [roomId])
    assert.deepEqual(after.rows, before.rows)
    assert.deepEqual(await migrationVersions(isolated.pool), [])
    const index = await isolated.pool.query("SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'room_members_one_owner_idx'")
    assert.equal(index.rowCount, 0)
    assert.equal(after.rows.filter((row) => row.role === 'owner').length, 2)
  })

  await t.test('failed authentication migration rolls back preceding DDL and its version record', async (t) => {
    const isolated = await createIsolatedSchema(adminPool)
    t.after(() => isolated.close())
    await applyMigrations(isolated.pool, { migrations: [MIGRATIONS[0]] })
    await isolated.pool.query('CREATE TABLE auth_sessions (fixture_marker INTEGER NOT NULL)')
    await assert.rejects(applyMigrations(isolated.pool, { migrations: [MIGRATIONS[1]] }))
    const users = await isolated.pool.query("SELECT to_regclass(current_schema() || '.auth_users') AS relation")
    assert.equal(users.rows[0].relation, null)
    assert.deepEqual(await migrationVersions(isolated.pool), ['0001_room_schema'])
    const marker = await isolated.pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'auth_sessions'")
    assert.deepEqual(marker.rows.map((row) => row.column_name), ['fixture_marker'])
  })

  await t.test('concurrent runners serialize by the advisory lock', async (t) => {
    const isolated = await createIsolatedSchema(adminPool)
    t.after(() => isolated.close())
    const results = await Promise.all([applyMigrations(isolated.pool), applyMigrations(isolated.pool)])
    assert.deepEqual(await migrationVersions(isolated.pool), migrationVersionsExpected)
    assert.equal(results.flatMap((result) => result.applied).length, 2)
    assert.equal(results.flatMap((result) => result.skipped).length, 2)
  })

  await t.test('normal application startup does not invoke migrations', async () => {
    const source = await readFile(fileURLToPath(new URL('./server.js', import.meta.url)), 'utf8')
    assert.doesNotMatch(source, /from ['"].*migrate\.js['"]|applyMigrations\s*\(/)
    assert.doesNotMatch(source, /initializeSchema\s*\(/)
  })

  await t.test('real HTTP and PostgreSQL account registration, constraints, sessions, expiry, and logout', async (t) => {
    const isolated = await createIsolatedSchema(adminPool)
    t.after(() => isolated.close())
    await applyMigrations(isolated.pool)
    const http = await startAuthHttp(isolated.pool)
    t.after(http.close)

    const registration = await postJson(http.base + '/register', {
      username: ' Mina ', email: ' MINA@example.com ', password: 'a sufficiently long password',
    })
    assert.equal(registration.status, 201)
    const registrationBody = await registration.json()
    assert.equal(registrationBody.user.username, 'mina')
    assert.equal(registrationBody.user.email, 'mina@example.com')
    assert.equal(registrationBody.session, undefined)
    const passwordRow = await isolated.pool.query('SELECT password_hash FROM auth_users WHERE username = $1', ['mina'])
    assert.match(passwordRow.rows[0].password_hash, /^\$argon2id\$/)
    assert.equal(await argon2.verify(passwordRow.rows[0].password_hash, 'a sufficiently long password'), true)

    const cookieHeader = registration.headers.get('set-cookie')
    assert.match(cookieHeader, /HttpOnly/i)
    const token = cookieHeader.match(/jammy_session=([^;]+)/)?.[1]
    assert.ok(token)
    const storedSession = await isolated.pool.query('SELECT token_hash FROM auth_sessions WHERE token_hash = $1', [hashOpaqueToken(token)])
    assert.equal(storedSession.rowCount, 1)
    assert.equal(storedSession.rows[0].token_hash === token, false)
    assert.equal(JSON.stringify(registrationBody).includes(token), false)

    const duplicateUsername = await postJson(http.base + '/register', {
      username: 'MINA', email: 'different@example.com', password: 'a sufficiently long password',
    })
    const duplicateEmail = await postJson(http.base + '/register', {
      username: 'different', email: 'MINA@example.com', password: 'a sufficiently long password',
    })
    assert.equal(duplicateUsername.status, 409)
    assert.equal(duplicateEmail.status, 409)
    const racing = await Promise.all([
      postJson(http.base + '/register', { username: 'racer', email: 'race-one@example.com', password: 'a sufficiently long password' }),
      postJson(http.base + '/register', { username: 'RACER', email: 'race-two@example.com', password: 'a sufficiently long password' }),
    ])
    assert.deepEqual(racing.map((response) => response.status).sort(), [201, 409])

    const inspected = await fetch(http.base + '/session', { headers: { cookie: 'jammy_session=' + token } })
    assert.equal(inspected.status, 200)
    assert.equal((await inspected.json()).user.username, 'mina')
    await isolated.pool.query("UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE token_hash = $1", [hashOpaqueToken(token)])
    assert.equal((await fetch(http.base + '/session', { headers: { cookie: 'jammy_session=' + token } })).status, 401)

    const login = await postJson(http.base + '/login', { identifier: 'MINA@EXAMPLE.COM', password: 'a sufficiently long password' })
    assert.equal(login.status, 200)
    const loginBody = await login.json()
    const loginToken = login.headers.get('set-cookie').match(/jammy_session=([^;]+)/)?.[1]
    assert.ok(loginToken)
    const logout = await fetch(http.base + '/logout', {
      method: 'POST',
      headers: { origin: allowedOrigin, cookie: 'jammy_session=' + loginToken, 'x-csrf-token': loginBody.csrfToken },
    })
    assert.equal(logout.status, 200)
    const revoked = await isolated.pool.query('SELECT revoked_at FROM auth_sessions WHERE token_hash = $1', [hashOpaqueToken(loginToken)])
    assert.ok(revoked.rows[0].revoked_at)
    assert.equal((await fetch(http.base + '/session', { headers: { cookie: 'jammy_session=' + loginToken } })).status, 401)
  })
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createOptionalAuthPool, inspectAccountDatabaseStatus, REQUIRED_MIGRATIONS, validateDatabaseUrl } from './db.js'

test('database URL validation accepts PostgreSQL URLs and requires TLS for Neon', () => {
  const neonUrl = 'postgresql://jammy:synthetic@ep-example-pooler.us-east-1.aws.neon.tech/jammy?sslmode=require'
  assert.equal(validateDatabaseUrl(neonUrl), neonUrl)
  assert.equal(validateDatabaseUrl('postgresql://jammy:synthetic@localhost:5432/jammy'), 'postgresql://jammy:synthetic@localhost:5432/jammy')
  assert.throws(
    () => validateDatabaseUrl('postgresql://private-user:private-password@ep-private.us-east-1.aws.neon.tech/jammy'),
    (error) => /enable TLS/.test(error.message) && !error.message.includes('private-password'),
  )
  assert.throws(() => validateDatabaseUrl('mysql://user:secret@db/jammy'), /PostgreSQL scheme/)
})

test('invalid account database configuration does not prevent memory-room startup', () => {
  const optionalPool = createOptionalAuthPool(null, 'postgresql://app:secret@ep-example.neon.tech/jammy')
  assert.equal(optionalPool.pool, null)
  assert.match(optionalPool.configurationError, /Neon PostgreSQL URLs must enable TLS/)
  assert.doesNotMatch(optionalPool.configurationError, /secret|ep-example/)

  const roomPool = { query() {} }
  assert.deepEqual(createOptionalAuthPool(roomPool, 'not a url'), { pool: roomPool, configurationError: null })
})

test('database status distinguishes missing configuration without exposing connection values', async () => {
  assert.deepEqual(await inspectAccountDatabaseStatus(null), {
    connection: 'not-configured',
    authenticationMigration: 'unknown',
    personalMusicSchema: 'unknown',
    migrations: REQUIRED_MIGRATIONS.map((version) => ({ version, status: 'unknown' })),
    pendingMigrations: [],
    hint: 'Set DATABASE_URL in the project root .env, then run npm run migrate.',
  })
})

test('database status checks all migrations and schemas without applying schema changes', async () => {
  const queries = []
  const pool = { async query(sql, values) {
    queries.push({ sql, values })
    if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] }
    if (sql.includes('unnest')) return { rows: ['rooms', 'room_members', 'room_queue', 'room_playback', 'auth_users', 'auth_sessions', 'jammy_listening_history', 'spotify_connections', 'spotify_oauth_states', 'spotify_imported_items', 'music_taste_profiles'].map((relation_name) => ({ relation_name, present: true })) }
    if (sql.includes('to_regclass')) return { rows: [{ table_name: 'schema_migrations' }] }
    if (sql.includes('FROM schema_migrations')) return { rows: REQUIRED_MIGRATIONS.map((version) => ({ version })) }
    if (sql.includes('information_schema.columns')) return { rows: [['room_queue', 'is_autoplay'], ['room_playback', 'autoplay_enabled'], ['room_playback', 'recent_track_ids'], ['room_playback', 'current_track_is_autoplay']].map(([table_name, column_name]) => ({ table_name, column_name })) }
    return { rowCount: 0, rows: [] }
  } }

  assert.deepEqual(await inspectAccountDatabaseStatus(pool), {
    connection: 'connected',
    authenticationMigration: 'applied',
    personalMusicSchema: 'ready',
    roomSchema: 'ready',
    autoplaySchema: 'ready',
    migrations: REQUIRED_MIGRATIONS.map((version) => ({ version, status: 'applied' })),
    pendingMigrations: [],
    hint: '',
  })
  assert.equal(queries.length, 5)
  assert.deepEqual(queries[2].values[0], REQUIRED_MIGRATIONS)
  assert.equal(queries.some(({ sql }) => /CREATE|ALTER|DROP|DELETE|INSERT/i.test(sql)), false)
})

test('database status reports an unapplied authentication migration and sanitizes connection failures', async () => {
  const pendingPool = { async query(sql) {
    if (sql.includes('to_regclass')) return { rows: [{ table_name: 'schema_migrations' }] }
    if (sql.includes('FROM schema_migrations')) return { rowCount: 0, rows: [] }
    if (sql.includes('unnest')) return { rows: [] }
    if (sql.includes('information_schema.columns')) return { rows: [] }
    return { rows: [{ '?column?': 1 }] }
  } }
  const unavailablePool = { async query() { const error = new Error('postgresql://private-user:private-password@private-host/db'); error.code = '28P01'; throw error } }

  const pending = await inspectAccountDatabaseStatus(pendingPool)
  assert.equal(pending.authenticationMigration, 'pending')
  assert.equal(pending.personalMusicSchema, 'pending')
  assert.deepEqual(pending.pendingMigrations, REQUIRED_MIGRATIONS)
  const unavailable = await inspectAccountDatabaseStatus(unavailablePool)
  assert.equal(unavailable.connection, 'unavailable')
  assert.match(unavailable.hint, /credentials/)
  assert.doesNotMatch(unavailable.hint, /private-user|private-password|private-host/)
})

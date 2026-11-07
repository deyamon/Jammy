import pg from 'pg'

const { Pool } = pg

export const REQUIRED_MIGRATIONS = [
  '0001_room_schema',
  '0002_authentication',
  '0003_room_autoplay',
  '0004_personal_music',
]

const REQUIRED_TABLES = ['rooms', 'room_members', 'room_queue', 'room_playback', 'auth_users', 'auth_sessions', 'jammy_listening_history', 'spotify_connections', 'spotify_oauth_states', 'spotify_imported_items', 'music_taste_profiles']
const REQUIRED_AUTOPLAY_COLUMNS = [
  ['room_queue', 'is_autoplay'],
  ['room_playback', 'autoplay_enabled'],
  ['room_playback', 'recent_track_ids'],
  ['room_playback', 'current_track_is_autoplay'],
]

export function validateDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    throw new Error('A PostgreSQL connection URL is required.')
  }

  let parsed
  try {
    parsed = new URL(databaseUrl.trim())
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
    throw new Error('DATABASE_URL must include a PostgreSQL scheme, host, and database name.')
  }

  if (parsed.hostname.toLowerCase().endsWith('.neon.tech')) {
    const sslMode = parsed.searchParams.get('sslmode')?.toLowerCase()
    const sslEnabled = parsed.searchParams.get('ssl') === 'true' || parsed.searchParams.get('ssl') === '1'
    if (!sslEnabled && !['require', 'verify-full'].includes(sslMode)) {
      throw new Error('Neon PostgreSQL URLs must enable TLS with sslmode=require or sslmode=verify-full.')
    }
  }
  return databaseUrl.trim()
}

export function createPool(databaseUrl) {
  return new Pool({
    connectionString: validateDatabaseUrl(databaseUrl),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
  })
}

export function createOptionalAuthPool(roomPool, databaseUrl) {
  if (roomPool) return { pool: roomPool, configurationError: null }
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) return { pool: null, configurationError: null }
  try {
    return { pool: createPool(databaseUrl), configurationError: null }
  } catch (error) {
    return {
      pool: null,
      configurationError: error instanceof Error ? error.message : 'PostgreSQL connection configuration is invalid.',
    }
  }
}

function databaseFailureHint(error) {
  switch (error?.code) {
    case '28P01':
    case '28000':
      return 'PostgreSQL rejected the configured credentials. Verify DATABASE_URL.'
    case '3D000':
      return 'The configured PostgreSQL database was not found. Verify the database name in DATABASE_URL.'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'The PostgreSQL host could not be resolved. Verify the host and network access.'
    case 'ECONNREFUSED':
      return 'The PostgreSQL server refused the connection. Verify the host, port, and server availability.'
    case 'ETIMEDOUT':
    case 'ECONNRESET':
      return 'The PostgreSQL connection timed out or was reset. Verify network access and TLS settings.'
    default:
      return 'The PostgreSQL connection or authentication schema check failed. Verify DATABASE_URL and apply pending migrations.'
  }
}

export async function inspectAccountDatabaseStatus(pool) {
  if (!pool) {
    return {
      connection: 'not-configured',
      authenticationMigration: 'unknown',
      personalMusicSchema: 'unknown',
      migrations: REQUIRED_MIGRATIONS.map((version) => ({ version, status: 'unknown' })),
      pendingMigrations: [],
      hint: 'Set DATABASE_URL in the project root .env, then run npm run migrate.',
    }
  }

  try {
    await pool.query('SELECT 1')
    const migrationTable = await pool.query("SELECT to_regclass('schema_migrations') AS table_name")
    const migrationTableExists = Boolean(migrationTable.rows?.[0]?.table_name)
    const recorded = migrationTableExists
      ? await pool.query('SELECT version FROM schema_migrations WHERE version = ANY($1::varchar[])', [REQUIRED_MIGRATIONS])
      : { rows: [] }
    const appliedVersions = new Set(recorded.rows.map((row) => row.version))
    const pendingMigrations = REQUIRED_MIGRATIONS.filter((version) => !appliedVersions.has(version))
    const migrationStates = REQUIRED_MIGRATIONS.map((version) => ({ version, status: migrationTableExists ? (appliedVersions.has(version) ? 'applied' : 'pending') : 'pending' }))
    const relations = await pool.query(
      'SELECT relation_name, to_regclass(relation_name) IS NOT NULL AS present FROM unnest($1::text[]) AS relations(relation_name)',
      [REQUIRED_TABLES],
    )
    const relationState = new Map(relations.rows.map((row) => [row.relation_name, row.present]))
    const columns = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND (table_name, column_name) IN
       (('room_queue', 'is_autoplay'), ('room_playback', 'autoplay_enabled'),
        ('room_playback', 'recent_track_ids'), ('room_playback', 'current_track_is_autoplay'))`,
    )
    const presentColumns = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`))
    const roomSchemaReady = ['rooms', 'room_members', 'room_queue', 'room_playback'].every((name) => relationState.get(name))
    const authenticationSchemaReady = ['auth_users', 'auth_sessions'].every((name) => relationState.get(name))
    const autoplaySchemaReady = REQUIRED_AUTOPLAY_COLUMNS.every(([table, column]) => presentColumns.has(`${table}.${column}`))
    const personalMusicSchemaReady = ['jammy_listening_history', 'spotify_connections', 'spotify_oauth_states', 'spotify_imported_items', 'music_taste_profiles'].every((name) => relationState.get(name))
    const schemasReady = roomSchemaReady && authenticationSchemaReady && autoplaySchemaReady && personalMusicSchemaReady
    const authenticationMigration = appliedVersions.has('0002_authentication') && authenticationSchemaReady ? 'applied' : 'pending'
    return {
      connection: 'connected',
      authenticationMigration,
      personalMusicSchema: appliedVersions.has('0004_personal_music') && personalMusicSchemaReady ? 'ready' : 'pending',
      roomSchema: roomSchemaReady ? 'ready' : 'pending',
      autoplaySchema: autoplaySchemaReady ? 'ready' : 'pending',
      migrations: migrationStates,
      pendingMigrations,
      hint: pendingMigrations.length || !schemasReady
        ? `Pending database setup: ${pendingMigrations.join(', ') || 'schema verification'}. Run npm run migrate after confirming this is the intended database.`
        : '',
    }
  } catch (error) {
    return {
      connection: 'unavailable',
      authenticationMigration: 'unknown',
      personalMusicSchema: 'unknown',
      roomSchema: 'unknown',
      autoplaySchema: 'unknown',
      migrations: REQUIRED_MIGRATIONS.map((version) => ({ version, status: 'unknown' })),
      pendingMigrations: [],
      hint: databaseFailureHint(error),
    }
  }
}

export async function clearGuestMemberships(pool) {
  // Guest tokens belong to a running server session. Durable room content remains.
  await pool.query('DELETE FROM room_members')
}

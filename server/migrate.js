import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPool } from './db.js'
import { loadProjectEnvironment } from './config.js'

const migrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url))

export const MIGRATIONS = [
  { version: '0001_room_schema', file: '../schema.sql' },
  { version: '0002_authentication', file: '002_authentication.sql' },
  { version: '0003_room_autoplay', file: '003_room_autoplay.sql' },
  { version: '0004_personal_music', file: '004_personal_music.sql' },
]

export function selectMigrationDatabaseUrl(environment = process.env) {
  const directUrl = typeof environment.DATABASE_URL_UNPOOLED === 'string' ? environment.DATABASE_URL_UNPOOLED.trim() : ''
  const appUrl = typeof environment.DATABASE_URL === 'string' ? environment.DATABASE_URL.trim() : ''
  const databaseUrl = directUrl || appUrl
  if (!databaseUrl) throw new Error('Set DATABASE_URL or DATABASE_URL_UNPOOLED before running migrations.')

  let hostname
  try {
    hostname = new URL(databaseUrl).hostname.toLowerCase()
  } catch {
    throw new Error('The configured PostgreSQL URL is invalid. Verify its format before running migrations.')
  }
  if (hostname.includes('-pooler.')) {
    throw new Error('Neon migrations require a direct connection URL. Set DATABASE_URL_UNPOOLED to the non-pooler Neon URL; no migration was run.')
  }
  return databaseUrl
}

export async function applyMigrations(pool, { migrations = MIGRATIONS, directory = migrationsDirectory } = {}) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(120) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`)

  const applied = []
  const skipped = []
  const lock = await pool.connect()
  try {
    await lock.query('SELECT pg_advisory_lock(726123401)')
    for (const migration of migrations) {
      const found = await lock.query('SELECT 1 FROM schema_migrations WHERE version = $1', [migration.version])
      if (found.rowCount) {
        skipped.push(migration.version)
        continue
      }
      const sql = await readFile(join(directory, migration.file), 'utf8')
      await lock.query('BEGIN')
      try {
        await lock.query(sql)
        await lock.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version])
        await lock.query('COMMIT')
        applied.push(migration.version)
      } catch (error) {
        await lock.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    try { await lock.query('SELECT pg_advisory_unlock(726123401)') } finally { lock.release() }
  }
  return { applied, skipped }
}

export async function runMigrationCommand() {
  loadProjectEnvironment(import.meta.url)
  let migrationUrl
  try {
    migrationUrl = selectMigrationDatabaseUrl()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
    return
  }
  const pool = createPool(migrationUrl)
  try {
    const result = await applyMigrations(pool)
    for (const version of result.applied) console.log(`Applied: ${version}`)
    for (const version of result.skipped) console.log(`Already applied: ${version}`)
  } catch {
    console.error('Database migration failed. No failed migration was recorded as complete.')
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runMigrationCommand()
}

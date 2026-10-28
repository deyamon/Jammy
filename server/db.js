import pg from 'pg'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const { Pool } = pg
const currentDirectory = dirname(fileURLToPath(import.meta.url))

export function createPool(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required when ROOM_STORE=postgres.')
  }

  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
  })
}

export async function initializeSchema(pool) {
  const schema = await readFile(join(currentDirectory, 'schema.sql'), 'utf8')
  await pool.query(schema)
}

export async function clearGuestMemberships(pool) {
  // Guest tokens belong to a running server session. Durable room content remains.
  await pool.query('DELETE FROM room_members')
}

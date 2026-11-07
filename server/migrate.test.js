import assert from 'node:assert/strict'
import test from 'node:test'
import { selectMigrationDatabaseUrl } from './migrate.js'

test('migration URL requires configuration and prefers the direct Neon URL', () => {
  assert.throws(() => selectMigrationDatabaseUrl({}), /Set DATABASE_URL or DATABASE_URL_UNPOOLED/)
  assert.equal(
    selectMigrationDatabaseUrl({
      DATABASE_URL: 'postgresql://app:secret@ep-example-pooler.us-east-1.aws.neon.tech/app?sslmode=require',
      DATABASE_URL_UNPOOLED: 'postgresql://app:secret@ep-example.us-east-1.aws.neon.tech/app?sslmode=require',
    }),
    'postgresql://app:secret@ep-example.us-east-1.aws.neon.tech/app?sslmode=require',
  )
})

test('Neon pooled URLs are rejected for migrations and never echoed', () => {
  const pooledUrl = 'postgresql://private-user:private-password@ep-private-pooler.region.aws.neon.tech/db?sslmode=require'
  assert.throws(
    () => selectMigrationDatabaseUrl({ DATABASE_URL: pooledUrl }),
    (error) => /direct connection URL/.test(error.message)
      && !error.message.includes('private-user')
      && !error.message.includes('private-password')
      && !error.message.includes('ep-private'),
  )
})

test('direct non-Neon PostgreSQL URLs remain supported for migrations', () => {
  const url = 'postgresql://jammy:example@localhost:5432/jammy?sslmode=disable'
  assert.equal(selectMigrationDatabaseUrl({ DATABASE_URL: url }), url)
})

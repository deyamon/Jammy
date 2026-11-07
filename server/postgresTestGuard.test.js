import assert from 'node:assert/strict'
import test from 'node:test'
import { validateTestDatabaseUrl } from './postgresTestGuard.js'

test('PostgreSQL test guard requires its explicit variable and never falls back to DATABASE_URL', () => {
  assert.throws(
    () => validateTestDatabaseUrl({ DATABASE_URL: 'postgresql://localhost/production' }),
    /JAMMY_TEST_DATABASE_URL.*No connection was opened/,
  )
  assert.throws(() => validateTestDatabaseUrl({ JAMMY_TEST_DATABASE_URL: 'not a URL' }), /valid PostgreSQL URL/)
  assert.throws(() => validateTestDatabaseUrl({ JAMMY_TEST_DATABASE_URL: 'postgresql://localhost/production' }), /database names beginning with jammy_test/)
  assert.throws(() => validateTestDatabaseUrl({ JAMMY_TEST_DATABASE_URL: 'postgresql://example.com/jammy_test' }), /localhost or loopback/)
  assert.throws(() => validateTestDatabaseUrl({ JAMMY_TEST_DATABASE_URL: 'postgresql://localhost/jammy_test?host=example.com' }), /cannot override its local target/)
  assert.throws(() => validateTestDatabaseUrl({ JAMMY_TEST_DATABASE_URL: 'postgresql://localhost/jammy_test?options=-csearch_path%3Dpublic' }), /cannot override its local target/)
  assert.throws(() => validateTestDatabaseUrl({ NODE_ENV: 'production', JAMMY_TEST_DATABASE_URL: 'postgresql://localhost/jammy_test' }), /disabled when NODE_ENV=production/)
  assert.equal(validateTestDatabaseUrl({ JAMMY_TEST_DATABASE_URL: 'postgresql://user:synthetic@127.0.0.1/jammy_test_auth' }).startsWith('postgresql://'), true)
})

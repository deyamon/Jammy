const TEST_DATABASE_NAME = /^jammy_test(?:_[a-z0-9_-]+)?$/i
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export function validateTestDatabaseUrl(environment = process.env) {
  if (environment.NODE_ENV === 'production') {
    throw new Error('PostgreSQL integration tests are disabled when NODE_ENV=production. No connection was opened.')
  }
  const value = environment.JAMMY_TEST_DATABASE_URL
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('PostgreSQL integration tests require JAMMY_TEST_DATABASE_URL pointing to a dedicated local database named jammy_test or jammy_test_*. No connection was opened.')
  }

  let parsed
  try { parsed = new URL(value) } catch {
    throw new Error('JAMMY_TEST_DATABASE_URL must be a valid PostgreSQL URL. No connection was opened.')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('JAMMY_TEST_DATABASE_URL must use PostgreSQL. No connection was opened.')
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error('PostgreSQL integration tests only accept localhost or loopback targets. No connection was opened.')
  }
  let databaseName
  try { databaseName = decodeURIComponent(parsed.pathname.slice(1)) } catch {
    throw new Error('JAMMY_TEST_DATABASE_URL must name a dedicated jammy_test database. No connection was opened.')
  }
  if (!TEST_DATABASE_NAME.test(databaseName)) {
    throw new Error('PostgreSQL integration tests only accept database names beginning with jammy_test. No connection was opened.')
  }
  for (const key of ['host', 'hostaddr', 'port', 'database', 'dbname', 'service', 'servicefile', 'options']) {
    if (parsed.searchParams.has(key)) {
      throw new Error('JAMMY_TEST_DATABASE_URL cannot override its local target through query parameters. No connection was opened.')
    }
  }
  return value
}

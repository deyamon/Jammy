import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { homeMusicErrorMessage, spotifyActionErrorMessage } from './homeMusicErrors.js'

const homePanel = await readFile(new URL('./HomeMusicPanel.jsx', import.meta.url), 'utf8')

test('Home distinguishes Neon session, verifier, migration, storage, and server failures', () => {
  assert.match(homeMusicErrorMessage({ status: 401, code: 'AUTH_SESSION_INVALID' }), /session is invalid or expired/)
  assert.match(homeMusicErrorMessage({ status: 401, code: 'AUTH_SESSION_EXPIRED' }), /session is invalid or expired/)
  assert.match(homeMusicErrorMessage({ status: 503, code: 'AUTH_TOKEN_ISSUER_MISMATCH' }), /token it could not verify/)
  assert.match(homeMusicErrorMessage({ status: 503, code: 'AUTH_TOKEN_SERVICE_UNAVAILABLE' }), /session has not been cleared/)
  assert.match(homeMusicErrorMessage({ status: 503, code: 'AUTH_TOKEN_VERIFIER_UNAVAILABLE' }), /token verifier/)
  assert.match(homeMusicErrorMessage({ status: 503, code: 'MUSIC_MIGRATION_REQUIRED' }), /migrations 0001–0004/)
  assert.match(homeMusicErrorMessage({ status: 503, code: 'MUSIC_STORAGE_UNAVAILABLE' }), /PostgreSQL/)
  assert.match(homeMusicErrorMessage({ status: 500, code: 'INTERNAL_ERROR' }), /server is having trouble/)
  assert.match(homeMusicErrorMessage({ status: 0 }), /connection/)
})

test('Home leaves empty listening history as a normal non-error state and gives actionable Spotify setup errors', () => {
  assert.match(homePanel, /history\.length \? <ol[\s\S]*Tracks you play in Jammy will appear here/)
  assert.match(homePanel, /actionMessage && <p className="spotify-action-message" role="status">\{actionMessage\}<\/p>/)
  assert.match(homePanel, /disabled=\{Boolean\(busy\) \|\| status === 'loading'\}/)
  const missing = spotifyActionErrorMessage({ status: 503, code: 'SPOTIFY_NOT_CONFIGURED' })
  for (const name of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REDIRECT_URI', 'SPOTIFY_TOKEN_ENCRYPTION_KEY']) assert.ok(missing.includes(name))
  assert.match(spotifyActionErrorMessage({ code: 'MUSIC_MIGRATION_REQUIRED' }), /migrations 0001–0004/)
  assert.match(spotifyActionErrorMessage({ code: 'AUTH_TOKEN_SIGNING_KEY_MISMATCH' }), /branch configuration/)
})

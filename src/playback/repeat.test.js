import assert from 'node:assert/strict'
import test from 'node:test'
import { getTrackEndAction, nextRepeatMode, repeatModeLabel } from './repeat.js'

test('repeat mode cycles Off, Repeat All, and Repeat One', () => {
  assert.equal(nextRepeatMode('off'), 'all')
  assert.equal(nextRepeatMode('all'), 'one')
  assert.equal(nextRepeatMode('one'), 'off')
  assert.equal(nextRepeatMode('invalid'), 'off')
  assert.equal(repeatModeLabel('all'), 'Repeat All')
  assert.equal(repeatModeLabel('one'), 'Repeat One')
  assert.equal(repeatModeLabel('off'), 'Repeat Off')
})

test('repeat one replays the selected track', () => {
  assert.deepEqual(getTrackEndAction('one', 1, 3), { type: 'replay' })
})

test('repeat all wraps at the end while Off stops at the end', () => {
  assert.deepEqual(getTrackEndAction('all', 2, 3), { type: 'select', index: 0 })
  assert.deepEqual(getTrackEndAction('off', 2, 3), { type: 'stop' })
  assert.deepEqual(getTrackEndAction('off', 0, 3), { type: 'select', index: 1 })
})

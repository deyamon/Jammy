import assert from 'node:assert/strict'
import test from 'node:test'
import { getAnchoredPopupPosition } from './anchoredPopupPosition.js'

test('anchored popup sits below and right-aligns with its trigger in a desktop viewport', () => {
  const anchor = { top: 40, bottom: 76, left: 980, right: 1140 }
  const position = getAnchoredPopupPosition(anchor, 260, 1440, 900)
  assert.equal(position.placement, 'below')
  assert.equal(position.top, anchor.bottom + 8)
  assert.equal(position.left, anchor.right - position.width)
  assert.ok(position.left + position.width <= 1428)
})

test('anchored popup fits narrow viewports and clamps its horizontal edge', () => {
  const position = getAnchoredPopupPosition({ top: 28, bottom: 62, left: 230, right: 310 }, 250, 320, 640)
  assert.equal(position.placement, 'below')
  assert.equal(position.width, 296)
  assert.equal(position.left, 12)
  assert.ok(position.left + position.width <= 308)
})

test('anchored popup flips above a low trigger when that side has more room', () => {
  const anchor = { top: 700, bottom: 736, left: 700, right: 840 }
  const position = getAnchoredPopupPosition(anchor, 260, 900, 800)
  assert.equal(position.placement, 'above')
  assert.ok(position.top + Math.min(260, position.maxHeight) <= anchor.top - 8)
  assert.ok(position.top >= 12)
})

test('anchored popup limits its height to the available viewport space', () => {
  const position = getAnchoredPopupPosition({ top: 12, bottom: 30, left: 10, right: 90 }, 500, 320, 180)
  assert.ok(position.maxHeight <= 138)
  assert.ok(position.top + position.maxHeight <= 168)
})

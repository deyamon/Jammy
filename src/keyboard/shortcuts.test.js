import assert from 'node:assert/strict'
import test from 'node:test'
import { attachKeyboardShortcuts } from './shortcuts.js'

class EventTargetStub {
  listeners = new Set()
  addEventListener(_name, listener) { this.listeners.add(listener) }
  removeEventListener(_name, listener) { this.listeners.delete(listener) }
  dispatch(key, options = {}) {
    const event = {
      key, code: key === ' ' ? 'Space' : key, target: options.target ?? { tagName: 'BODY' },
      shiftKey: Boolean(options.shiftKey), ctrlKey: Boolean(options.ctrlKey), metaKey: Boolean(options.metaKey),
      altKey: Boolean(options.altKey), repeat: Boolean(options.repeat), defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true },
    }
    for (const listener of this.listeners) listener(event)
    return event
  }
}

function actions(overrides = {}) {
  const calls = []
  const handlers = Object.fromEntries(['togglePlay', 'next', 'previous', 'cycleRepeat', 'toggleMute', 'seekBackward', 'seekForward', 'volumeUp', 'volumeDown', 'toggleNowPlaying', 'escape', 'focusSearch'].map((key) => [key, () => calls.push(key)]))
  return { calls, handlers: { ...handlers, ...overrides } }
}

test('playback shortcuts dispatch once and prevent only handled native actions', () => {
  const target = new EventTargetStub()
  const state = actions()
  const cleanup = attachKeyboardShortcuts(target, () => state.handlers)
  const space = target.dispatch(' ')
  target.dispatch('n', { shiftKey: true })
  target.dispatch('p', { shiftKey: true })
  target.dispatch('r')
  target.dispatch('m')
  target.dispatch('ArrowLeft')
  target.dispatch('ArrowRight')
  target.dispatch('ArrowUp')
  target.dispatch('ArrowDown')
  target.dispatch('j')
  assert.equal(space.defaultPrevented, true)
  assert.deepEqual(state.calls, ['togglePlay', 'next', 'previous', 'cycleRepeat', 'toggleMute', 'seekBackward', 'seekForward', 'volumeUp', 'volumeDown', 'toggleNowPlaying'])
  cleanup()
})

test('typing targets and native interactive controls do not trigger player shortcuts', () => {
  const target = new EventTargetStub()
  const state = actions()
  const cleanup = attachKeyboardShortcuts(target, () => state.handlers)
  for (const editable of [
    { tagName: 'INPUT', type: 'search' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true },
    { tagName: 'INPUT', type: 'text' },
  ]) target.dispatch(' ', { target: editable })
  target.dispatch('r', { target: { tagName: 'BUTTON' } })
  target.dispatch('ArrowUp', { target: { tagName: 'INPUT', type: 'range' } })
  assert.deepEqual(state.calls, [])
  cleanup()
})

test('Escape and Ctrl/Cmd+K have their own handling; other modified shortcuts are ignored', () => {
  const target = new EventTargetStub()
  const state = actions()
  const cleanup = attachKeyboardShortcuts(target, () => state.handlers)
  const escape = target.dispatch('Escape', { target: { tagName: 'INPUT' } })
  const search = target.dispatch('k', { ctrlKey: true })
  target.dispatch('m', { ctrlKey: true })
  target.dispatch('m', { altKey: true })
  assert.equal(escape.defaultPrevented, true)
  assert.equal(search.defaultPrevented, true)
  assert.deepEqual(state.calls, ['escape', 'focusSearch'])
  cleanup()
})

test('repeat keydown does not repeat toggles and listener cleanup prevents duplicate execution', () => {
  const target = new EventTargetStub()
  const state = actions()
  const cleanup = attachKeyboardShortcuts(target, () => state.handlers)
  target.dispatch('m', { repeat: true })
  target.dispatch('ArrowUp', { repeat: true })
  assert.deepEqual(state.calls, ['volumeUp'])
  cleanup()
  assert.equal(target.listeners.size, 0)
  target.dispatch('r')
  assert.deepEqual(state.calls, ['volumeUp'])
})

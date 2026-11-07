import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_RECENT_SEARCHES, readRecentSearches, recentSearchStorageKey, rememberRecentSearch, removeRecentSearch } from './recentSearches.js'

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, value) },
    values,
  }
}

test('recent searches are saved per account and newest unique terms appear first', () => {
  const storage = createStorage()
  assert.deepEqual(rememberRecentSearch(storage, 'user/one', '  trip hop  '), ['trip hop'])
  assert.deepEqual(rememberRecentSearch(storage, 'user/one', 'TRIP HOP'), ['TRIP HOP'])
  rememberRecentSearch(storage, 'user/two', 'jazz')

  assert.equal(recentSearchStorageKey('user/one'), 'jammy:recent-searches:user%2Fone')
  assert.deepEqual(readRecentSearches(storage, 'user/one'), ['TRIP HOP'])
  assert.deepEqual(readRecentSearches(storage, 'user/two'), ['jazz'])
})

test('empty, invalid, and over-limit searches are handled safely', () => {
  const storage = createStorage()
  assert.deepEqual(rememberRecentSearch(storage, 'user-1', '   '), [])
  assert.deepEqual(rememberRecentSearch(storage, '', 'valid search'), [])
  for (let index = 0; index < MAX_RECENT_SEARCHES + 2; index += 1) rememberRecentSearch(storage, 'user-1', `track ${index}`)
  assert.equal(readRecentSearches(storage, 'user-1').length, MAX_RECENT_SEARCHES)
  assert.deepEqual(readRecentSearches(storage, 'user-1').slice(0, 2), ['track 9', 'track 8'])
})

test('individual recent searches can be removed without touching another account', () => {
  const storage = createStorage()
  rememberRecentSearch(storage, 'user-1', 'ambient mix')
  rememberRecentSearch(storage, 'user-1', 'jazz set')
  rememberRecentSearch(storage, 'user-2', 'ambient mix')

  assert.deepEqual(removeRecentSearch(storage, 'user-1', ' AMBIENT MIX '), ['jazz set'])
  assert.deepEqual(readRecentSearches(storage, 'user-2'), ['ambient mix'])
})

test('malformed or inaccessible browser storage never prevents a search', () => {
  const key = recentSearchStorageKey('user-1')
  const malformed = createStorage({ [key]: '{not json' })
  assert.deepEqual(readRecentSearches(malformed, 'user-1'), [])
  assert.deepEqual(rememberRecentSearch(malformed, 'user-1', 'shoegaze'), ['shoegaze'])

  const inaccessible = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  assert.deepEqual(readRecentSearches(inaccessible, 'user-1'), [])
  assert.deepEqual(rememberRecentSearch(inaccessible, 'user-1', 'post rock'), ['post rock'])
})

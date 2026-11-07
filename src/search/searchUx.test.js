import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const searchBox = await readFile(new URL('../components/SearchBox.jsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../App.jsx', import.meta.url), 'utf8')
const searchPage = await readFile(new URL('../pages/SearchPage.jsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')
const responsive = await readFile(new URL('../responsive.css', import.meta.url), 'utf8')

test('search focus opens an accessible, per-account recent-search panel', () => {
  assert.ok(searchBox.includes("onFocus={() => { setIsOpen(true); onNavigate('Search') }}"))
  assert.match(searchBox, /role="combobox"[\s\S]*aria-expanded={isOpen}[\s\S]*aria-controls="recent-searches-list"/)
  assert.match(searchBox, /role="dialog" aria-label="Recent searches"/)
  assert.match(app, /readRecentSearches\(browserLocalStorage\(\), accountUserId\)/)
  assert.match(app, /onRemoveSearch={forgetSearch}/)
})

test('recent-search popup supports selection, individual removal, Escape, arrows, and outside dismissal', () => {
  assert.ok(searchBox.includes('onClick={() => chooseSearch(recent)}'))
  assert.ok(searchBox.includes('onClick={() => { onRemoveSearch(recent); searchInputRef.current?.focus() }}'))
  assert.match(searchBox, /event.key === 'Escape'/)
  assert.match(searchBox, /event.key === 'ArrowDown'/)
  assert.match(searchBox, /event.key === 'ArrowUp'/)
  assert.match(searchBox, /document.addEventListener\('pointerdown', dismissOutside\)/)
  assert.ok(searchBox.includes('onBlur={(event) => {'))
  assert.ok(searchBox.includes('contains(event.relatedTarget)'))
  const closeAndFocus = searchBox.match(/const closeAndFocusInput = \(\) => \{([^}]+)\}/)?.[1]
  assert.ok(closeAndFocus)
  assert.ok(closeAndFocus.indexOf('searchInputRef.current?.focus()') < closeAndFocus.indexOf('setIsOpen(false)'))
})

test('YouTube search stays debounced and recent terms are saved when a search starts', () => {
  assert.match(searchPage, /setTimeout\(\(\) => \{\s*onSearchStarted\?\.\(normalizedQuery\)/)
  assert.match(searchPage, /searchPersonalizedYouTube\(normalizedQuery, \{\s*signal: controller\.signal\s*\}\)/)
  assert.match(searchPage, /onPlayTrack\(track\)/)
  assert.match(searchPage, /onAddToRoom\(track\)/)
})

test('the whole search box gets a stable focus treatment that adapts on small screens', () => {
  assert.match(styles, /\.search-box-wrap \.search-box:focus-within\{border-color:var\(--accent-primary\);box-shadow:/)
  assert.match(styles, /\.search-recent-popover\{position:absolute/)
  assert.match(styles, /\.search-box-wrap\{position:relative/)
  assert.match(responsive, /\.search-box-wrap\{width:min\(430px,calc\(100% - 99px\)\)\}/)
  assert.match(responsive, /\.search-box-wrap\{width:auto;flex:1;min-width:0\}/)
})

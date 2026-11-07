import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'

export default function SearchBox({ query, onQueryChange, onNavigate, recentSearches = [], onRememberSearch, onRemoveSearch, inputRef }) {
  const [isOpen, setIsOpen] = useState(false)
  const localInputRef = useRef(null)
  const searchInputRef = inputRef || localInputRef
  const searchBoxRef = useRef(null)
  const recentButtonRefs = useRef([])

  useEffect(() => {
    if (!isOpen) return undefined
    const dismissOutside = (event) => {
      if (!searchBoxRef.current?.contains(event.target)) setIsOpen(false)
    }
    document.addEventListener('pointerdown', dismissOutside)
    return () => document.removeEventListener('pointerdown', dismissOutside)
  }, [isOpen])

  const closeAndFocusInput = () => {
    searchInputRef.current?.focus()
    setIsOpen(false)
  }

  const chooseSearch = (value) => {
    const search = value.trim()
    if (!search) return
    onRememberSearch(search)
    onQueryChange(search)
    onNavigate('Search')
    closeAndFocusInput()
  }

  const handleEntryKeyDown = (event, index) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeAndFocusInput()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      recentButtonRefs.current[index + 1]?.focus()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (index === 0) searchInputRef.current?.focus()
      else recentButtonRefs.current[index - 1]?.focus()
    }
  }

  const handleInputKeyDown = (event) => {
    if (event.key === 'Escape' && isOpen) {
      event.preventDefault()
      setIsOpen(false)
      return
    }
    if (event.key === 'ArrowDown' && isOpen && recentSearches.length) {
      event.preventDefault()
      recentButtonRefs.current[0]?.focus()
      return
    }
    if (event.key === 'ArrowUp' && isOpen && recentSearches.length) {
      event.preventDefault()
      recentButtonRefs.current[recentSearches.length - 1]?.focus()
      return
    }
    if (event.key === 'Enter' && query.trim()) {
      event.preventDefault()
      onRememberSearch(query)
      onNavigate('Search')
      setIsOpen(false)
    }
  }

  return <div className="search-box-wrap" ref={searchBoxRef} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setIsOpen(false)
  }}>
    <label className="search-box">
      <Icon name="search" size={18}/>
      <input ref={searchInputRef} role="combobox" aria-autocomplete="none" aria-haspopup="dialog" aria-expanded={isOpen} aria-controls="recent-searches-list" aria-label="Search music" value={query} onFocus={() => { setIsOpen(true); onNavigate('Search') }} onChange={(event) => { onQueryChange(event.target.value); onNavigate('Search') }} onKeyDown={handleInputKeyDown} placeholder="What do you want to hear?" maxLength={120}/>
      <kbd>Ctrl K</kbd>
    </label>
    {isOpen && <div className="search-recent-popover" id="recent-searches-list" role="dialog" aria-label="Recent searches">
      <div className="search-recent-heading"><span>Recent searches</span>{recentSearches.length > 0 && <span>{recentSearches.length}</span>}</div>
      {recentSearches.length ? <ul className="search-recent-list">
        {recentSearches.map((recent, index) => <li className="search-recent-row" key={`${recent.toLocaleLowerCase()}-${index}`}>
          <button className="search-recent-select" type="button" ref={(node) => { recentButtonRefs.current[index] = node }} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSearch(recent)} onKeyDown={(event) => handleEntryKeyDown(event, index)}>
            <Icon name="clock" size={14}/><span>{recent}</span>
          </button>
          <button className="search-recent-remove" type="button" aria-label={`Remove ${recent} from recent searches`} title="Remove from recent searches" onMouseDown={(event) => event.preventDefault()} onClick={() => { onRemoveSearch(recent); searchInputRef.current?.focus() }} onKeyDown={(event) => handleEntryKeyDown(event, index)}><Icon name="close" size={13}/></button>
        </li>)}
      </ul> : <p className="search-recent-empty">Your searches will appear here.</p>}
      <p className="search-recent-hint">Use ↑ and ↓ to browse · Esc to close</p>
    </div>}
  </div>
}

const DEFAULT_CAPABILITIES = Object.freeze({
  loadTrack: false,
  play: false,
  pause: false,
  seek: false,
  setVolume: false,
  toggleMute: false,
})

function providerFor(track) {
  return track?.provider || 'audio'
}

function normalizeStatus(status) {
  return ['idle', 'loading', 'ready', 'playing', 'paused', 'ended', 'error', 'unavailable'].includes(status)
    ? status
    : 'ready'
}

function normalizePlaybackState(state, track, capabilities, repeatMode) {
  return Object.freeze({
    provider: track ? providerFor(track) : null,
    trackId: track?.id ?? null,
    title: track?.title ?? '',
    artist: track?.channelName || track?.artist || '',
    artwork: track?.thumbnails?.high || track?.thumbnails?.medium || track?.artwork || null,
    duration: Number.isFinite(state.duration) && state.duration > 0 ? state.duration : 0,
    position: Number.isFinite(state.currentTime) && state.currentTime > 0 ? state.currentTime : 0,
    currentTime: Number.isFinite(state.currentTime) && state.currentTime > 0 ? state.currentTime : 0,
    status: normalizeStatus(state.status),
    isPlaying: normalizeStatus(state.status) === 'playing',
    isPaused: normalizeStatus(state.status) === 'paused',
    buffering: normalizeStatus(state.status) === 'loading',
    positionMs: Number.isFinite(state.currentTime) && state.currentTime > 0 ? Math.round(state.currentTime * 1000) : 0,
    repeatMode,
    error: typeof state.error === 'string' ? state.error : '',
    volume: Number.isFinite(state.volume) ? Math.min(1, Math.max(0, state.volume)) : 0.72,
    muted: Boolean(state.muted),
    capabilities: Object.freeze({ ...DEFAULT_CAPABILITIES, ...capabilities }),
  })
}

/** Coordinates provider commands and presents their state in Jammy's common shape. */
export class PlaybackController {
  #providers = new Map()
  #providerSubscriptions = new Map()
  #listeners = new Set()
  #track = null
  #providerState = { status: 'idle', currentTime: 0, duration: 0, error: '' }
  #repeatMode = 'off'

  constructor(initialTrack = null) {
    this.#track = initialTrack
  }

  getState() {
    const provider = this.#providers.get(providerFor(this.#track))
    return normalizePlaybackState(this.#providerState, this.#track, provider?.capabilities, this.#repeatMode)
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Playback listener must be a function.')
    this.#listeners.add(listener)
    listener(this.getState())
    return () => this.#listeners.delete(listener)
  }

  #publish() {
    const state = this.getState()
    for (const listener of this.#listeners) listener(state)
  }

  registerProvider(provider, adapter) {
    if (typeof provider !== 'string' || !provider || !adapter || typeof adapter !== 'object') {
      throw new TypeError('A provider name and adapter are required.')
    }
    const previous = this.#providers.get(provider)
    if (previous) {
      this.#providerSubscriptions.get(provider)?.()
      this.#providerSubscriptions.delete(provider)
      previous.destroy?.()
    }
    this.#providers.set(provider, adapter)
    if (typeof adapter.subscribe === 'function') {
      let active = true
      const unsubscribe = adapter.subscribe((state) => {
        if (!active || !state || typeof state !== 'object') return
        this.reportProviderState(provider, state.trackId ?? this.#track?.id, state)
      })
      this.#providerSubscriptions.set(provider, () => {
        if (!active) return
        active = false
        if (typeof unsubscribe === 'function') unsubscribe()
      })
    }
    this.#publish()
    return () => {
      if (this.#providers.get(provider) !== adapter) return
      this.#providers.delete(provider)
      this.#providerSubscriptions.get(provider)?.()
      this.#providerSubscriptions.delete(provider)
      adapter.destroy?.()
      this.#publish()
    }
  }

  getCurrentState() {
    const provider = providerFor(this.#track)
    const adapter = this.#providers.get(provider)
    const current = adapter?.getCurrentState?.()
    if (current && typeof current === 'object') this.reportProviderState(provider, current.trackId ?? this.#track?.id, current)
    return this.getState()
  }

  setTrack(track, { reset = true } = {}) {
    const changed = track?.id !== this.#track?.id || providerFor(track) !== providerFor(this.#track)
    this.#track = track ?? null
    if (reset && changed) this.#providerState = { status: 'loading', currentTime: 0, duration: 0, error: '' }
    this.#publish()
  }

  async loadTrack(track, options = {}) {
    if (!track) return false
    this.setTrack(track)
    const adapter = this.#providers.get(providerFor(track))
    if (!adapter?.loadTrack) return false
    try {
      return (await adapter.loadTrack(track, options)) !== false
    } catch (error) {
      this.reportProviderState(providerFor(track), track.id, { status: 'error', error: error?.message || 'The selected provider could not load this track.' })
      return false
    }
  }

  reportProviderState(provider, trackId, state) {
    if (!this.#track || provider !== providerFor(this.#track) || trackId !== this.#track.id) return false
    this.#providerState = { ...this.#providerState, ...state, status: normalizeStatus(state.status) }
    this.#publish()
    return true
  }

  setRepeatMode(repeatMode) {
    this.#repeatMode = repeatMode
    this.#publish()
  }

  async command(name, ...args) {
    const provider = providerFor(this.#track)
    const adapter = this.#providers.get(provider)
    const capabilities = adapter?.capabilities ?? DEFAULT_CAPABILITIES
    if (!capabilities[name] || typeof adapter?.[name] !== 'function') return false
    try { return (await adapter[name](...args)) !== false }
    catch (error) {
      this.reportProviderState(provider, this.#track?.id, { status: 'error', error: error?.message || `Playback ${name} failed.` })
      return false
    }
  }

  destroy() {
    for (const [provider, adapter] of this.#providers) {
      this.#providerSubscriptions.get(provider)?.()
      adapter.destroy?.()
    }
    this.#providers.clear()
    this.#providerSubscriptions.clear()
    this.#listeners.clear()
  }
}

export { providerFor as playbackProviderFor }

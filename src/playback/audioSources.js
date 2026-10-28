const demoAudioUrl = import.meta.env.VITE_JAMMY_DEMO_AUDIO_URL?.trim() || null

// Keep source resolution separate from catalog metadata and playback controls.
// Additional authorized providers can be added here without changing the player UI.
const audioSources = Object.freeze({ 'local-audio-demo': demoAudioUrl })

export function getAudioSource(trackId) {
  return audioSources[trackId] ?? null
}

import { useEffect, useState } from 'react'
import Icon from './Icon.jsx'
import { createRoom, joinRoom } from '../services/roomApi.js'

const NAME_KEY = 'jammy-guest-name'

export default function RoomDialog({ initialMode = 'create', initialCode = '', onClose, onRoomReady, onRegisterDismissible }) {
  const [mode, setMode] = useState(initialMode)
  const [displayName, setDisplayName] = useState(() => window.localStorage.getItem(NAME_KEY) || '')
  const [roomName, setRoomName] = useState('Jammy listening room')
  const [roomCode, setRoomCode] = useState(() => String(initialCode).replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase())
  const [maxMembers, setMaxMembers] = useState('8')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const dismiss = loading ? null : onClose
    onRegisterDismissible?.('room-dialog', dismiss)
    return () => onRegisterDismissible?.('room-dialog', null)
  }, [loading, onClose, onRegisterDismissible])

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      const name = displayName.trim()
      window.localStorage.setItem(NAME_KEY, name)
      const session = mode === 'create'
        ? await createRoom({ name: roomName.trim(), displayName: name, maxMembers: Number(maxMembers) })
        : await joinRoom(roomCode.trim().toUpperCase(), { displayName: name })
      onRoomReady(session)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }

  return <div className="room-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !loading) onClose() }}>
    <section className="room-dialog" role="dialog" aria-modal="true" aria-labelledby="room-dialog-title">
      <button type="button" className="icon-button room-dialog-close" aria-label="Close dialog" onClick={onClose} disabled={loading}><Icon name="close" size={18}/></button>
      <p className="eyebrow">GOOD MUSIC, BETTER TOGETHER</p>
      <h2 id="room-dialog-title">{mode === 'create' ? 'Start a room' : 'Join your people'}<span>.</span></h2>
      <p className="room-dialog-copy">Rooms are temporary guest spaces. This prototype doesn’t save them after a server restart.</p>

      <div className="room-dialog-tabs" role="tablist" aria-label="Room action">
        <button type="button" role="tab" aria-selected={mode === 'create'} className={mode === 'create' ? 'selected' : ''} onClick={() => { setMode('create'); setError('') }}>Create</button>
        <button type="button" role="tab" aria-selected={mode === 'join'} className={mode === 'join' ? 'selected' : ''} onClick={() => { setMode('join'); setError('') }}>Join</button>
      </div>

      <form onSubmit={handleSubmit} className="room-form">
        {mode === 'create' ? <>
          <label>Room name<input autoFocus value={roomName} onChange={(event) => setRoomName(event.target.value)} required minLength="1" maxLength="60" placeholder="Friday night listening"/></label>
          <label>Room capacity<select value={maxMembers} onChange={(event) => setMaxMembers(event.target.value)}>{[2, 4, 6, 8, 12, 16, 20].map((count) => <option key={count} value={count}>{count} people</option>)}</select></label>
        </> : <label>Room code<input autoFocus className="room-code-input" value={roomCode} onChange={(event) => setRoomCode(event.target.value.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase())} required minLength="6" maxLength="6" pattern="[A-Z0-9]{6}" placeholder="ABC123" autoComplete="off"/></label>}
        <label>Your name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required minLength="1" maxLength="24" placeholder="How should friends know you?" autoComplete="nickname"/></label>
        {error && <p className="room-form-error" role="alert">{error}</p>}
        <button type="submit" className="primary-action room-submit" disabled={loading}>{loading ? 'Connecting…' : mode === 'create' ? 'Create listening room' : 'Join listening room'}</button>
      </form>
      <p className="room-dialog-footnote">No account needed. Shared playback and text chat are available when you join.</p>
    </section>
  </div>
}

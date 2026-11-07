import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { voiceAvatarTone, voiceConnectionLabel, voiceInitials, voicePanelMode, voiceParticipantStatus } from './voicePanelModel.js'

function useVoiceActivity({ joined, joining, muted, localStream, remoteStreams, participants, peerStates, audioContextRef }) {
  const [speaking, setSpeaking] = useState({})
  const streamEntries = [...(remoteStreams?.entries?.() ?? [])]
  const streamKey = streamEntries.map(([memberId, stream]) => `${memberId}:${stream?.id ?? ''}`).join('|')
  const connectedKey = participants.filter((participant) => participant.state === 'connected').map((participant) => participant.memberId).sort().join('|')
  const peerKey = [...(peerStates?.entries?.() ?? [])].map(([memberId, state]) => `${memberId}:${state}`).sort().join('|')

  useEffect(() => {
    setSpeaking({})
    if (!joined && !joining) {
      const previousContext = audioContextRef.current
      audioContextRef.current = null
      void previousContext?.close?.().catch?.(() => {})
      return undefined
    }
    if (typeof window === 'undefined' || !joined) return undefined
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext
    if (!AudioContextConstructor) return undefined

    let context
    let sampleTimer = 0
    let cancelled = false
    const monitors = []
    try {
      context = audioContextRef.current ?? new AudioContextConstructor()
      audioContextRef.current = context
      const activeParticipants = new Set(connectedKey.split('|').filter(Boolean))
      const sources = [
        ...(!muted && localStream ? [['local', localStream]] : []),
        ...streamEntries.filter(([memberId]) => activeParticipants.has(memberId) && peerStates?.get(memberId) === 'connected'),
      ]
      for (const [memberId, stream] of sources) {
        if (!stream?.getAudioTracks?.().some((track) => track.readyState !== 'ended' && (memberId !== 'local' || track.enabled))) continue
        const analyser = context.createAnalyser()
        analyser.fftSize = 512
        const source = context.createMediaStreamSource(stream)
        source.connect(analyser)
        monitors.push({ memberId, source, analyser, samples: new Uint8Array(analyser.fftSize) })
      }
      const sample = () => {
        if (cancelled) return
        const nextSpeaking = {}
        for (const monitor of monitors) {
          monitor.analyser.getByteTimeDomainData(monitor.samples)
          let energy = 0
          for (const point of monitor.samples) {
            const amplitude = (point - 128) / 128
            energy += amplitude * amplitude
          }
          nextSpeaking[monitor.memberId] = Math.sqrt(energy / monitor.samples.length) > 0.035
        }
        setSpeaking((previous) => {
          const keys = new Set([...Object.keys(previous), ...Object.keys(nextSpeaking)])
          for (const key of keys) if (Boolean(previous[key]) !== Boolean(nextSpeaking[key])) return nextSpeaking
          return previous
        })
      }
      if (context.state === 'suspended') void context.resume().catch(() => {})
      // ~7 checks a second is plenty for a speaking indicator and keeps phones responsive.
      sampleTimer = window.setInterval(sample, 150)
    } catch {
      for (const monitor of monitors) {
        monitor.source.disconnect()
        monitor.analyser.disconnect()
      }
      audioContextRef.current = null
      void context?.close?.().catch?.(() => {})
      return undefined
    }
    return () => {
      cancelled = true
      window.clearInterval(sampleTimer)
      for (const monitor of monitors) {
        monitor.source.disconnect()
        monitor.analyser.disconnect()
      }
    }
  }, [joined, joining, muted, localStream, streamKey, connectedKey, peerKey])

  return speaking
}

function VoiceAvatar({ participant, size = 'regular' }) {
  const [imageFailed, setImageFailed] = useState(false)
  const memberName = participant.displayName || 'Guest listener'
  const imageUrl = participant.avatarUrl || participant.avatar || ''
  const tone = voiceAvatarTone(participant.memberId || memberName)
  return <span className={`voice-avatar voice-avatar-${size} voice-avatar-tone-${tone}`} aria-hidden="true">
    {imageUrl && !imageFailed && <img src={imageUrl} alt="" onError={() => setImageFailed(true)}/>}
    <span>{voiceInitials(memberName)}</span>
  </span>
}

export default function RoomVoicePanel({
  voiceState, currentMemberId, members = [], voiceClientRef, disabled = false,
}) {
  // Phones start with the compact launcher so the panel doesn't cover the room.
  const [expanded, setExpanded] = useState(() => typeof window === 'undefined' || !window.matchMedia?.('(max-width: 650px)').matches)
  const audioContextRef = useRef(null)
  const remoteStreams = voiceState.remoteStreams ?? new Map()
  const peerStates = voiceState.peerStates ?? new Map()
  const localStream = voiceState.joined ? voiceClientRef.current?.localStream : null
  const speaking = useVoiceActivity({
    joined: voiceState.joined,
    joining: voiceState.joining,
    muted: voiceState.muted,
    localStream,
    remoteStreams,
    participants: voiceState.participants,
    peerStates,
    audioContextRef,
  })
  useEffect(() => () => {
    const context = audioContextRef.current
    audioContextRef.current = null
    void context?.close?.().catch?.(() => {})
  }, [])
  const connectedParticipants = useMemo(() => voiceState.participants.filter((participant) => participant.state === 'connected'), [voiceState.participants])
  const mode = voicePanelMode({ joined: voiceState.joined, expanded })
  const anySpeaking = Object.values(speaking).some(Boolean)
  const showParticipants = voiceState.participants
  const byMemberId = new Map(members.map((member) => [member.id, member]))
  const participantInfo = (participant) => {
    const member = byMemberId.get(participant.memberId)
    return { ...participant, avatarUrl: participant.avatarUrl || member?.avatarUrl || member?.avatar }
  }
  const toggleMute = () => { void voiceClientRef.current?.setMuted(!voiceState.muted) }
  const leave = () => { void voiceClientRef.current?.leave() }
  const join = () => {
    const AudioContextConstructor = typeof window === 'undefined' ? null : window.AudioContext || window.webkitAudioContext
    if (AudioContextConstructor && !audioContextRef.current) {
      try {
        audioContextRef.current = new AudioContextConstructor()
        if (audioContextRef.current.state === 'suspended') void audioContextRef.current.resume().catch(() => {})
      } catch {}
    }
    void voiceClientRef.current?.join()
  }

  const audioElements = [...remoteStreams.keys()].map((memberId) => <audio key={memberId} className="voice-remote-audio" autoPlay playsInline ref={(element) => voiceClientRef.current?.attachAudio(memberId, element)}/> )

  if (mode === 'launcher') return <>
    <div className="voice-chat-launcher"><button type="button" onClick={() => setExpanded(true)} aria-label="Open voice chat panel"><Icon name="volume" size={16}/><span>Voice chat</span><small>{connectedParticipants.length} in voice</small></button></div>
    <div className="voice-audio-layer" aria-hidden="true">{audioElements}</div>
  </>

  if (mode === 'collapsed') return <>
    <section className="voice-chat-floating voice-chat-collapsed" aria-label="Voice chat controls">
      <button type="button" className="voice-pill-expand" onClick={() => setExpanded(true)} aria-expanded="false" aria-label="Expand voice chat panel">
        <span className={`voice-activity-indicator ${anySpeaking ? 'is-speaking' : ''}`} aria-hidden="true"><i/><i/><i/></span>
        <span className="voice-avatar-stack">{connectedParticipants.slice(0, 3).map((participant) => <VoiceAvatar key={participant.memberId} participant={participantInfo(participant)} size="small"/>)}{connectedParticipants.length > 3 && <span className="voice-avatar-overflow">+{connectedParticipants.length - 3}</span>}</span>
        <span className="voice-pill-copy"><b>Voice chat</b><small>{voiceState.joining ? 'Joining…' : anySpeaking ? 'Someone is speaking' : 'Connected'}</small></span>
        <span className="voice-pill-chevron"><Icon name="chevron" size={16}/></span>
      </button>
      <button type="button" className={`voice-pill-control ${voiceState.muted ? 'is-muted' : ''}`} onClick={toggleMute} aria-label={voiceState.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={voiceState.muted}><Icon name={voiceState.muted ? 'micMuted' : 'mic'} size={16}/></button>
      <button type="button" className="voice-pill-control voice-pill-leave" onClick={leave} aria-label="Leave voice chat"><Icon name="close" size={16}/></button>
    </section>
    <div className="voice-audio-layer" aria-hidden="true">{audioElements}</div>
  </>

  if (mode === 'prejoin') return <>
    <section className="voice-chat-floating voice-chat-prejoin" aria-labelledby="voice-panel-title">
      <header className="voice-panel-heading"><div><p className="eyebrow">LISTEN TOGETHER</p><h2 id="voice-panel-title">Voice chat</h2></div><button type="button" className="voice-panel-close" onClick={() => setExpanded(false)} aria-label="Close voice chat panel"><Icon name="close" size={18}/></button></header>
      <div className="voice-prejoin-grid" aria-label="Current voice chat participants">
        {showParticipants.length ? showParticipants.map((participant) => {
          const info = participantInfo(participant)
          return <div className="voice-prejoin-person" key={participant.memberId}><VoiceAvatar participant={info}/><b>{info.displayName}{info.memberId === currentMemberId ? ' (you)' : ''}</b><small>{participant.state === 'connected' ? 'In voice' : 'Reconnecting'}</small></div>
        }) : <p className="voice-prejoin-empty">Be the first to join and say hello.</p>}
      </div>
      <button type="button" className="voice-join-button voice-join-now" onClick={join} disabled={disabled || voiceState.joining}>
        {voiceState.joining ? 'Joining voice chat…' : 'Join Now'}
      </button>
      <p className="voice-mic-note"><Icon name="micMuted" size={14}/> Your microphone starts muted. Unmute whenever you’re ready.</p>
      {voiceState.audioBlocked && <button type="button" className="voice-audio-enable" onClick={() => void voiceClientRef.current?.resumeAudio()}>Enable voice audio</button>}
      {voiceState.error && <p className="voice-chat-error" role="status">{voiceState.error}</p>}
    </section>
    <div className="voice-audio-layer" aria-hidden="true">{audioElements}</div>
  </>

  return <>
    <section className="voice-chat-floating voice-chat-expanded" aria-labelledby="voice-panel-title">
      <header className="voice-panel-heading"><div><p className="eyebrow">LISTEN TOGETHER</p><h2 id="voice-panel-title">Voice chat <span className="voice-connected-count">{connectedParticipants.length}/6</span></h2></div><button type="button" className="voice-panel-close" onClick={() => setExpanded(false)} aria-label="Collapse voice chat panel"><Icon name="close" size={18}/></button></header>
      <p className="voice-panel-caption"><span className={`voice-activity-indicator ${anySpeaking ? 'is-speaking' : ''}`} aria-hidden="true"><i/><i/><i/></span>{voiceState.joining ? 'Connecting your microphone…' : anySpeaking ? 'Someone is speaking' : 'Voice chat connected'}</p>
      <ul className="voice-expanded-list" aria-label="Voice chat participants">
        {voiceState.participants.map((participant) => {
          const info = participantInfo(participant)
          const peerState = peerStates.get(participant.memberId)
          const isSelf = participant.memberId === currentMemberId
          const isSpeaking = Boolean(speaking[isSelf ? 'local' : participant.memberId]) && participant.state === 'connected' && (isSelf || peerState === 'connected')
          const connectionLabel = voiceConnectionLabel(participant, currentMemberId, peerState)
          const statusLabel = voiceParticipantStatus(participant, currentMemberId, { muted: voiceState.muted, speaking: isSpeaking })
          return <li key={participant.memberId} className={`${participant.state !== 'connected' ? 'is-reconnecting' : ''} ${isSpeaking ? 'is-speaking' : ''}`}>
            <VoiceAvatar participant={info}/>
            <span className="voice-expanded-copy"><b>{info.displayName}{isSelf ? ' (you)' : ''}</b><small>{connectionLabel}</small></span>
            <span className={`voice-participant-state ${voiceState.muted && isSelf ? 'is-muted' : ''}`}><i aria-hidden="true"/>{statusLabel}</span>
          </li>
        })}
        {!voiceState.participants.length && <li className="voice-prejoin-empty">Waiting for voice participants…</li>}
      </ul>
      <div className="voice-expanded-actions">
        <button type="button" className={`voice-control-button ${voiceState.muted ? 'is-muted' : ''}`} onClick={toggleMute} aria-label={voiceState.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={voiceState.muted}><Icon name={voiceState.muted ? 'micMuted' : 'mic'} size={17}/><span>{voiceState.muted ? 'Unmute' : 'Mute'}</span></button>
        <button type="button" className="voice-control-button voice-leave-button" onClick={leave}><Icon name="close" size={16}/><span>Leave voice</span></button>
      </div>
      {voiceState.audioBlocked && <button type="button" className="voice-audio-enable" onClick={() => void voiceClientRef.current?.resumeAudio()}>Enable voice audio</button>}
      {voiceState.error && <p className="voice-chat-error" role="status">{voiceState.error}</p>}
    </section>
    <div className="voice-audio-layer" aria-hidden="true">{audioElements}</div>
  </>
}

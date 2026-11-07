function microphoneError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'Microphone permission was denied. Allow microphone access in your browser, then try again.'
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return 'No microphone was found. Connect a microphone, then try again.'
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') return 'The microphone is unavailable or being used by another app.'
  if (error?.name === 'OverconstrainedError') return 'The selected microphone is unavailable. Check your audio device settings.'
  return 'The microphone could not be started. Check your browser and device settings.'
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ ok: false, error: 'The room server did not respond. Reconnect and try again.' }), 8000)
    socket.emit(event, payload, (result) => {
      clearTimeout(timeout)
      resolve(result ?? { ok: false, error: 'The room server did not respond.' })
    })
  })
}

export class RoomVoiceClient {
  constructor(socket, memberId, onState, { mediaDevices = globalThis.navigator?.mediaDevices, PeerConnection = globalThis.RTCPeerConnection } = {}) {
    this.socket = socket
    this.memberId = memberId
    this.onState = onState
    this.mediaDevices = mediaDevices
    this.PeerConnection = PeerConnection
    this.localStream = null
    this.pendingStream = null
    this.peers = new Map()
    this.peerStates = new Map()
    this.remoteStreams = new Map()
    this.audioElements = new Map()
    this.pendingCandidates = new Map()
    this.iceServers = []
    this.participants = []
    this.joined = false
    this.joining = false
    this.joinVersion = 0
    this.joinToken = null
    this.muted = false
    this.error = ''
    this.audioBlocked = false
    this.disposed = false
    this.handlers = {
      'voice:participants': (payload) => this.updateParticipants(payload?.participants),
      'voice:offer': (payload) => { void this.receiveOffer(payload) },
      'voice:answer': (payload) => { void this.receiveAnswer(payload) },
      'voice:ice': (payload) => { void this.receiveCandidate(payload) },
      disconnect: () => this.handleDisconnect(),
    }
    for (const [event, handler] of Object.entries(this.handlers)) socket.on(event, handler)
    this.publish()
  }

  publish() {
    if (this.disposed) return
    this.onState?.({
      joined: this.joined,
      joining: this.joining,
      muted: this.muted,
      error: this.error,
      audioBlocked: this.audioBlocked,
      participants: this.participants.map((participant) => ({ ...participant })),
      peerStates: new Map(this.peerStates),
      remoteStreams: new Map(this.remoteStreams),
    })
  }

  async join() {
    if (this.joined) return { ok: true }
    if (this.joining) return { ok: false, error: 'Voice chat is already starting.' }
    if (!this.socket.connected) {
      this.error = 'Reconnect to the room before joining voice chat.'
      this.publish()
      return { ok: false, error: this.error }
    }
    if (!this.mediaDevices?.getUserMedia || !this.PeerConnection) {
      this.error = 'This browser does not support voice chat. Try a current browser with WebRTC enabled.'
      this.publish()
      return { ok: false, error: this.error }
    }

    const joinVersion = ++this.joinVersion
    const joinToken = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${joinVersion}-${Math.random()}`
    this.joinToken = joinToken
    this.joining = true
    this.error = ''
    this.publish()
    let stream
    try {
      stream = await this.mediaDevices.getUserMedia({ audio: true, video: false })
    } catch (error) {
      if (joinVersion !== this.joinVersion) return { ok: false, error: 'Voice chat join was cancelled.' }
      this.joining = false
      this.error = microphoneError(error)
      this.publish()
      return { ok: false, error: this.error }
    }
    this.pendingStream = stream

    if (joinVersion !== this.joinVersion) {
      stream.getTracks().forEach((track) => track.stop())
      if (this.pendingStream === stream) this.pendingStream = null
      return { ok: false, error: 'Voice chat join was cancelled.' }
    }
    if (this.disposed || !this.socket.connected) {
      stream.getTracks().forEach((track) => track.stop())
      if (this.pendingStream === stream) this.pendingStream = null
      this.joining = false
      this.error = 'The room connection changed before voice chat could start. Reconnect and try again.'
      this.publish()
      return { ok: false, error: this.error }
    }

    const result = await emitWithAck(this.socket, 'voice:join', { joinToken })
    if (this.disposed || !this.socket.connected || joinVersion !== this.joinVersion) {
      if (this.socket.connected) this.socket.emit('voice:leave', { joinToken })
      stream.getTracks().forEach((track) => track.stop())
      if (this.pendingStream === stream) this.pendingStream = null
      return { ok: false, error: 'Voice chat join was cancelled.' }
    }
    if (!result.ok) {
      if (this.socket.connected) this.socket.emit('voice:leave', { joinToken })
      stream.getTracks().forEach((track) => track.stop())
      if (this.pendingStream === stream) this.pendingStream = null
      this.joining = false
      this.error = result.error || 'Voice chat could not be joined.'
      this.publish()
      return result
    }

    this.localStream = stream
    this.pendingStream = null
    this.joining = false
    this.iceServers = Array.isArray(result.iceServers) ? result.iceServers : []
    this.joined = true
    this.muted = true
    for (const track of stream.getAudioTracks()) track.enabled = false
    this.error = ''
    this.participants = Array.isArray(result.participants) ? result.participants : []
    this.publish()
    await this.syncPeers()
    return { ok: true }
  }

  async leave() {
    if ((this.joined || this.joining) && this.socket.connected) this.socket.emit('voice:leave', { joinToken: this.joinToken })
    this.joinVersion += 1
    this.joining = false
    this.joinToken = null
    this.releaseMedia()
    this.joined = false
    this.muted = false
    this.audioBlocked = false
    this.error = ''
    this.publish()
  }

  releaseMedia() {
    for (const memberId of [...this.peers.keys()]) this.closePeer(memberId)
    for (const track of this.localStream?.getTracks?.() ?? []) track.stop()
    for (const track of this.pendingStream?.getTracks?.() ?? []) track.stop()
    this.localStream = null
    this.pendingStream = null
    this.pendingCandidates.clear()
  }

  dispose() {
    if (this.disposed) return
    if ((this.joined || this.joining) && this.socket.connected) this.socket.emit('voice:leave', { joinToken: this.joinToken })
    this.joinVersion += 1
    this.joining = false
    this.joinToken = null
    this.releaseMedia()
    this.joined = false
    this.disposed = true
    for (const [event, handler] of Object.entries(this.handlers)) this.socket.off(event, handler)
  }

  handleDisconnect() {
    if (!this.joined && !this.joining) return
    this.releaseMedia()
    this.joinVersion += 1
    this.joinToken = null
    this.joining = false
    this.joined = false
    this.muted = false
    this.error = 'Room connection lost. Rejoin voice chat after the room reconnects.'
    this.publish()
  }

  async setMuted(muted) {
    if (!this.joined || !this.localStream) return
    this.muted = Boolean(muted)
    for (const track of this.localStream.getAudioTracks()) track.enabled = !this.muted
    this.publish()
  }

  updateParticipants(participants) {
    if (!Array.isArray(participants)) return
    this.participants = participants.filter((participant) => participant && typeof participant.memberId === 'string')
    if (this.joined) void this.syncPeers()
    this.publish()
  }

  async syncPeers() {
    if (!this.joined || !this.localStream) return
    const activeIds = new Set(this.participants.filter((participant) => participant.state === 'connected').map((participant) => participant.memberId))
    for (const memberId of [...this.peers.keys()]) if (!activeIds.has(memberId)) this.closePeer(memberId)
    for (const participant of this.participants) {
      if (participant.memberId === this.memberId || participant.state !== 'connected') continue
      const peer = this.ensurePeer(participant.memberId)
      if (!peer || this.memberId.localeCompare(participant.memberId) >= 0 || peer.offerStarted) continue
      peer.offerStarted = true
      try {
        const offer = await peer.connection.createOffer()
        await peer.connection.setLocalDescription(offer)
        if (!this.joined || this.peers.get(participant.memberId) !== peer) return
        const result = await emitWithAck(this.socket, 'voice:offer', {
          toMemberId: participant.memberId,
          description: peer.connection.localDescription?.toJSON?.() ?? peer.connection.localDescription,
        })
        if (!result.ok) throw new Error(result.error || 'The room could not connect this participant.')
      } catch {
        if (!this.joined || this.peers.get(participant.memberId) !== peer) return
        this.error = 'A voice connection could not be started. Check network or TURN settings.'
        this.closePeer(participant.memberId)
        this.publish()
      }
    }
  }

  ensurePeer(memberId) {
    if (this.peers.has(memberId)) return this.peers.get(memberId)
    try {
      const connection = new this.PeerConnection({ iceServers: this.iceServers })
      const peer = { connection, offerStarted: false }
      this.peers.set(memberId, peer)
      this.peerStates.set(memberId, 'connecting')
      for (const track of this.localStream.getAudioTracks()) connection.addTrack(track, this.localStream)
      connection.onicecandidate = (event) => {
        if (event.candidate) void emitWithAck(this.socket, 'voice:ice', { toMemberId: memberId, candidate: event.candidate.toJSON?.() ?? event.candidate })
      }
      connection.ontrack = (event) => {
        if (memberId === this.memberId) return
        const stream = event.streams?.[0]
        if (!stream) return
        this.remoteStreams.set(memberId, stream)
        this.audioBlocked = false
        this.publish()
        this.playAudio(memberId)
      }
      connection.onconnectionstatechange = () => {
        this.peerStates.set(memberId, connection.connectionState)
        this.publish()
        if (connection.connectionState === 'failed') {
          this.error = 'A voice connection failed. This network may require a TURN relay.'
          this.closePeer(memberId)
          this.peerStates.set(memberId, 'failed')
          this.publish()
        }
      }
      return peer
    } catch {
      this.error = 'Your browser could not create a voice connection.'
      this.publish()
      return null
    }
  }

  async receiveOffer(payload) {
    const memberId = payload?.fromMemberId
    if (!this.joined || typeof memberId !== 'string' || memberId === this.memberId
      || !this.participants.some((participant) => participant.memberId === memberId && participant.state === 'connected')) return
    const peer = this.ensurePeer(memberId)
    if (!peer) return
    try {
      await peer.connection.setRemoteDescription(payload.description)
      await this.flushCandidates(memberId)
      if (!this.joined || this.peers.get(memberId) !== peer) return
      const answer = await peer.connection.createAnswer()
      await peer.connection.setLocalDescription(answer)
      if (!this.joined || this.peers.get(memberId) !== peer) return
      const result = await emitWithAck(this.socket, 'voice:answer', {
        toMemberId: memberId,
        description: peer.connection.localDescription?.toJSON?.() ?? peer.connection.localDescription,
      })
      if (!result.ok) throw new Error(result.error)
    } catch {
      if (!this.joined || this.peers.get(memberId) !== peer) return
      this.error = 'A voice offer could not be accepted. Try leaving and rejoining voice chat.'
      this.closePeer(memberId)
      this.publish()
    }
  }

  async receiveAnswer(payload) {
    const memberId = payload?.fromMemberId
    const peer = this.peers.get(memberId)
    if (!peer || !this.joined) return
    try {
      await peer.connection.setRemoteDescription(payload.description)
      await this.flushCandidates(memberId)
    } catch {
      if (!this.joined || this.peers.get(memberId) !== peer) return
      this.error = 'A voice answer could not be applied. Try rejoining voice chat.'
      this.closePeer(memberId)
      this.publish()
    }
  }

  async receiveCandidate(payload) {
    const memberId = payload?.fromMemberId
    if (!this.joined || typeof memberId !== 'string' || memberId === this.memberId
      || !this.participants.some((participant) => participant.memberId === memberId && participant.state === 'connected')) return
    const peer = this.peers.get(memberId)
    if (!peer || !peer.connection.remoteDescription) {
      const pending = this.pendingCandidates.get(memberId) ?? []
      if (pending.length < 64) pending.push(payload.candidate)
      this.pendingCandidates.set(memberId, pending)
      return
    }
    try { if (payload.candidate) await peer.connection.addIceCandidate(payload.candidate) } catch {
      this.error = 'A network route for voice chat could not be added.'
      this.publish()
    }
  }

  async flushCandidates(memberId) {
    const peer = this.peers.get(memberId)
    if (!peer) return
    const candidates = this.pendingCandidates.get(memberId) ?? []
    this.pendingCandidates.delete(memberId)
    for (const candidate of candidates) if (candidate) await peer.connection.addIceCandidate(candidate)
  }

  attachAudio(memberId, element) {
    if (!element) {
      this.audioElements.delete(memberId)
      return
    }
    this.audioElements.set(memberId, element)
    element.autoplay = true
    element.playsInline = true
    element.srcObject = this.remoteStreams.get(memberId) ?? null
    this.playAudio(memberId)
  }

  playAudio(memberId) {
    const element = this.audioElements.get(memberId)
    if (!this.joined || !element || !element.srcObject || typeof element.play !== 'function') return
    element.play().then(() => {
      if (!this.joined || this.audioElements.get(memberId) !== element || !element.srcObject) return
      this.audioBlocked = false
      this.publish()
    }).catch(() => {
      if (!this.joined || this.audioElements.get(memberId) !== element || !element.srcObject) return
      this.audioBlocked = true
      this.publish()
    })
  }

  async resumeAudio() {
    if (!this.joined) return
    this.audioBlocked = false
    for (const memberId of this.audioElements.keys()) this.playAudio(memberId)
  }

  closePeer(memberId) {
    const peer = this.peers.get(memberId)
    if (peer) {
      peer.connection.onicecandidate = null
      peer.connection.ontrack = null
      peer.connection.onconnectionstatechange = null
      peer.connection.close()
      this.peers.delete(memberId)
    }
    this.pendingCandidates.delete(memberId)
    this.peerStates.delete(memberId)
    const audio = this.audioElements.get(memberId)
    if (audio) audio.srcObject = null
    this.audioElements.delete(memberId)
    this.remoteStreams.delete(memberId)
  }
}

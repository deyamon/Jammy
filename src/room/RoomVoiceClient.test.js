import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { RoomVoiceClient } from './RoomVoiceClient.js'

class FakeSocket extends EventEmitter {
  constructor(result = {}) { super(); this.connected = true; this.result = result; this.sent = [] }
  emit(event, ...args) {
    if (event.startsWith('voice:')) {
      this.sent.push({ event, payload: args[0] })
      const acknowledge = args.at(-1)
      if (typeof acknowledge === 'function') acknowledge(this.result)
      return true
    }
    return super.emit(event, ...args)
  }
  receive(event, payload) { return super.emit(event, payload) }
}

class FakePeerConnection {
  static instances = []
  constructor(configuration) {
    this.configuration = configuration
    this.addedTracks = []
    this.remoteDescription = null
    this.localDescription = null
    this.connectionState = 'new'
    this.closed = false
    FakePeerConnection.instances.push(this)
  }
  addTrack(track, stream) { this.addedTracks.push({ track, stream }) }
  async createOffer() { return { type: 'offer', sdp: 'local-offer' } }
  async createAnswer() { return { type: 'answer', sdp: 'local-answer' } }
  async setLocalDescription(description) { this.localDescription = description }
  async setRemoteDescription(description) { this.remoteDescription = description }
  async addIceCandidate(candidate) { this.addedCandidate = candidate }
  close() { this.closed = true }
}

function fakeStream() {
  const audioTrack = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true } }
  return { audioTrack, getTracks: () => [audioTrack], getAudioTracks: () => [audioTrack] }
}

function joinedSocketResult() {
  return {
    ok: true,
    iceServers: [{ urls: ['stun:test.invalid'] }],
    participants: [
      { memberId: 'member-a', displayName: 'Ari', state: 'connected' },
      { memberId: 'member-b', displayName: 'Bea', state: 'connected' },
    ],
  }
}

test('microphone is requested only by explicit join, with audio-only capture and server-provided ICE configuration', async () => {
  FakePeerConnection.instances = []
  const socket = new FakeSocket(joinedSocketResult())
  const stream = fakeStream()
  const constraints = []
  const mediaDevices = { async getUserMedia(value) { constraints.push(value); return stream } }
  const states = []
  const client = new RoomVoiceClient(socket, 'member-a', (state) => states.push(state), { mediaDevices, PeerConnection: FakePeerConnection })
  assert.equal(constraints.length, 0)
  const result = await client.join()
  assert.equal(result.ok, true)
  assert.deepEqual(constraints, [{ audio: true, video: false }])
  assert.deepEqual(FakePeerConnection.instances[0].configuration, { iceServers: joinedSocketResult().iceServers })
  assert.equal(FakePeerConnection.instances[0].addedTracks.length, 1)
  assert.equal(socket.sent.filter((entry) => entry.event === 'voice:offer').length, 1)
  assert.equal(states.at(-1).joined, true)
  assert.equal(states.at(-1).muted, true)
  assert.equal(stream.audioTrack.enabled, false)
  await client.dispose()
  assert.equal(stream.audioTrack.stopped, true)
  assert.equal(FakePeerConnection.instances[0].closed, true)
})

test('mute disables only the outgoing microphone track and leave releases the peer and media resources', async () => {
  const socket = new FakeSocket(joinedSocketResult())
  const stream = fakeStream()
  const client = new RoomVoiceClient(socket, 'member-a', () => {}, {
    mediaDevices: { async getUserMedia() { return stream } }, PeerConnection: FakePeerConnection,
  })
  await client.join()
  assert.equal(client.muted, true)
  assert.equal(stream.audioTrack.enabled, false)
  await client.setMuted(true)
  assert.equal(stream.audioTrack.enabled, false)
  assert.equal(client.muted, true)
  await client.setMuted(false)
  assert.equal(stream.audioTrack.enabled, true)
  const result = await client.leave()
  assert.equal(result, undefined)
  assert.equal(stream.audioTrack.stopped, true)
  assert.equal(client.joined, false)
  assert.equal(socket.sent.some((entry) => entry.event === 'voice:leave'), true)
})

test('microphone permission and missing-device errors become useful UI state', async () => {
  for (const [name, expected] of [
    ['NotAllowedError', 'Microphone permission was denied.'],
    ['NotFoundError', 'No microphone was found.'],
  ]) {
    const socket = new FakeSocket(joinedSocketResult())
    const client = new RoomVoiceClient(socket, 'member-a', () => {}, {
      mediaDevices: { async getUserMedia() { throw Object.assign(new Error('device error'), { name }) } },
      PeerConnection: FakePeerConnection,
    })
    const result = await client.join()
    assert.equal(result.ok, false)
    assert.ok(result.error.startsWith(expected))
    assert.equal(client.joined, false)
  }
})

test('duplicate participant updates do not create duplicate peers; remote audio never loops to self', async () => {
  FakePeerConnection.instances = []
  const socket = new FakeSocket(joinedSocketResult())
  const stream = fakeStream()
  const client = new RoomVoiceClient(socket, 'member-a', () => {}, {
    mediaDevices: { async getUserMedia() { return stream } }, PeerConnection: FakePeerConnection,
  })
  await client.join()
  client.updateParticipants([...joinedSocketResult().participants, { memberId: 'member-b', displayName: 'Bea', state: 'connected' }])
  assert.equal(FakePeerConnection.instances.length, 1)
  const remoteStream = { id: 'remote-stream' }
  FakePeerConnection.instances[0].ontrack({ streams: [remoteStream] })
  assert.equal(client.remoteStreams.get('member-b'), remoteStream)
  assert.equal(client.remoteStreams.has('member-a'), false)
  await client.leave()
})

test('permission or signaling failure leaves the local microphone stopped', async () => {
  const stream = fakeStream()
  const socket = new FakeSocket({ ok: false, error: 'Voice chat is full.' })
  const client = new RoomVoiceClient(socket, 'member-a', () => {}, {
    mediaDevices: { async getUserMedia() { return stream } }, PeerConnection: FakePeerConnection,
  })
  const result = await client.join()
  assert.equal(result.ok, false)
  assert.equal(stream.audioTrack.stopped, true)
  assert.equal(client.joined, false)
})

test('a pending microphone request can be cancelled without leaking capture or joining later', async () => {
  const socket = new FakeSocket(joinedSocketResult())
  const stream = fakeStream()
  let resolveCapture
  let captureCount = 0
  const client = new RoomVoiceClient(socket, 'member-a', () => {}, {
    mediaDevices: { getUserMedia() { captureCount += 1; return new Promise((resolve) => { resolveCapture = resolve }) } },
    PeerConnection: FakePeerConnection,
  })
  const pendingJoin = client.join()
  assert.equal(client.joining, true)
  assert.equal((await client.join()).ok, false)
  assert.equal(captureCount, 1)
  await client.leave()
  resolveCapture(stream)
  const result = await pendingJoin
  assert.equal(result.ok, false)
  assert.equal(stream.audioTrack.stopped, true)
  assert.equal(socket.sent.some((entry) => entry.event === 'voice:join'), false)
})

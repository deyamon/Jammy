import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { voiceAvatarTone, voiceConnectionLabel, voiceInitials, voicePanelMode, voiceParticipantStatus } from './voicePanelModel.js'

const panelSource = await readFile(new URL('./RoomVoicePanel.jsx', import.meta.url), 'utf8')
const roomStyles = await readFile(new URL('../room.css', import.meta.url), 'utf8')

test('voice panel model covers pre-join, launcher, collapsed, and expanded states', () => {
  assert.equal(voicePanelMode({ joined: false, expanded: true }), 'prejoin')
  assert.equal(voicePanelMode({ joined: false, expanded: false }), 'launcher')
  assert.equal(voicePanelMode({ joined: true, expanded: false }), 'collapsed')
  assert.equal(voicePanelMode({ joined: true, expanded: true }), 'expanded')
})

test('guest avatars use stable initials and a repeatable palette tone', () => {
  assert.equal(voiceInitials('Maya Rivers'), 'MR')
  assert.equal(voiceInitials('Ari'), 'AR')
  assert.equal(voiceInitials(' '), '♪')
  assert.equal(voiceAvatarTone('member-1'), voiceAvatarTone('member-1'))
  assert.ok(voiceAvatarTone('member-1') >= 0 && voiceAvatarTone('member-1') < 5)
})

test('participant labels reflect connection, actual speaking, and known local mute state', () => {
  const local = { memberId: 'me', state: 'connected' }
  const remote = { memberId: 'other', state: 'connected' }
  assert.equal(voiceConnectionLabel(local, 'me', undefined), 'In voice')
  assert.equal(voiceConnectionLabel({ ...remote, state: 'reconnecting' }, 'me', 'connected'), 'Reconnecting')
  assert.equal(voiceConnectionLabel(remote, 'me', 'failed'), 'Connection failed')
  assert.equal(voiceConnectionLabel(remote, 'me', 'connected'), 'Connected')
  assert.equal(voiceParticipantStatus(local, 'me', { muted: true }), 'Mic muted')
  assert.equal(voiceParticipantStatus(local, 'me', { speaking: true }), 'Speaking')
  assert.equal(voiceParticipantStatus(remote, 'me', { speaking: true }), 'Speaking')
  assert.equal(voiceParticipantStatus(remote, 'me'), 'Mic status unavailable')
})

test('panel controls join explicitly, mute and leave while collapsed, and close without leaving', () => {
  assert.match(panelSource, /voice-chat-prejoin/)
  assert.match(panelSource, /const join = \(\) => \{[\s\S]*void voiceClientRef\.current\?\.join\(\)/)
  assert.match(panelSource, /voice-chat-collapsed/)
  assert.match(panelSource, /aria-label=\{voiceState\.muted \? 'Unmute microphone' : 'Mute microphone'\}/)
  assert.match(panelSource, /aria-label="Leave voice chat"/)
  assert.match(panelSource, /onClick=\{\(\) => setExpanded\(false\)\}/)
  assert.match(panelSource, /voice-chat-expanded/)
  assert.match(panelSource, /onClick=\{toggleMute\}/)
  assert.match(panelSource, /onClick=\{leave\}/)
  assert.doesNotMatch(panelSource, /getUserMedia/)
})

test('voice activity uses live streams with analyzers and releases nodes/context on cleanup', () => {
  assert.match(panelSource, /createMediaStreamSource\(stream\)/)
  assert.match(panelSource, /source\.connect\(analyser\)/)
  assert.doesNotMatch(panelSource, /connect\(context\.destination\)/)
  assert.match(panelSource, /getByteTimeDomainData/)
  assert.match(panelSource, /monitor\.source\.disconnect\(\)/)
  assert.match(panelSource, /context\?\.close/)
  assert.match(panelSource, /participants\.filter\(\(participant\) => participant\.state === 'connected'\)/)
  assert.match(panelSource, /activeParticipants\.has\(memberId\) && peerStates\?\.get\(memberId\) === 'connected'/)
  assert.match(roomStyles, /@media\(prefers-reduced-motion:reduce\)\{\.voice-chat-floating/)
  assert.match(roomStyles, /@media\(max-width:650px\)\{\.voice-chat-floating/)
})

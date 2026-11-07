import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { AuthApiError, createAccountApi } from '../services/authApi.js'
import {
  accountStateAfterLogout,
  accountStateAfterSessionError,
  accountStateFromSession,
  authenticatedAccountState,
  validateLoginForm,
  validateRegistrationForm,
} from './accountState.js'

const authPage = await readFile(new URL('../pages/AuthPage.jsx', import.meta.url), 'utf8')
const profilePage = await readFile(new URL('../pages/ProfilePage.jsx', import.meta.url), 'utf8')
const sidebar = await readFile(new URL('../components/Sidebar.jsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../App.jsx', import.meta.url), 'utf8')
const turntable = await readFile(new URL('../components/Turntable.jsx', import.meta.url), 'utf8')
const authCss = await readFile(new URL('../auth.css', import.meta.url), 'utf8')

test('login and registration render labeled, accessible credential forms', () => {
  assert.match(authPage, /aria-labelledby="account-heading"/)
  assert.match(authPage, /htmlFor="login-identifier"[\s\S]*Email address/)
  assert.match(authPage, /type=\{showPassword \? 'text' : 'password'\} autoComplete=\{isRegister \? 'new-password' : 'current-password'\}/)
  assert.match(authPage, /htmlFor="register-username"[\s\S]*Username/)
  assert.match(authPage, /type="email"/)
  assert.match(authPage, /htmlFor="confirm-password"[\s\S]*Confirm password/)
  assert.match(authPage, /required minLength=\{isRegister \? 12 : undefined\}/)
  assert.match(authPage, /role="alert"/)
  assert.match(authPage, /disabled=\{busy\}/)
  assert.match(authPage, /role="group" aria-label="Choose account action"/)
  assert.match(authPage, /aria-pressed=\{isRegister\}/)
  assert.match(authPage, /setIsRegister\(register\)/)
  assert.match(authPage, /aria-label=\{showPassword \? 'Hide password' : 'Show password'\}/)
  assert.match(authPage, /Your music\.<br\/>Your people\./)
  assert.match(authPage, /LISTEN TOGETHER\. ANYWHERE\./)
})

test('auth is the guest entry, authenticated sessions land on Home, and room invites survive login', () => {
  assert.match(app, /account\.status !== 'authenticated' \? account\.status === 'loading'/)
  assert.match(app, /setActiveNav\('Home'\)/)
  assert.match(app, /params\.get\('room'\).*params\.get\('roomCode'\)/)
  assert.match(app, /initialCode=\{roomInviteCode\}/)
  assert.match(app, /setRoomDialogMode\('join'\)/)
})

test('client validation mirrors supported server constraints', () => {
  assert.equal(validateLoginForm({ identifier: '', password: 'secret' }), 'Enter a valid email address.')
  assert.equal(validateLoginForm({ identifier: 'maya', password: 'secret' }), 'Enter a valid email address.')
  assert.equal(validateLoginForm({ identifier: 'maya@example.com', password: 'secret' }), '')
  assert.match(validateRegistrationForm({ username: 'x', email: 'bad', password: 'short', confirmPassword: '' }), /Username must/)
  assert.match(validateRegistrationForm({ username: 'Maya_1', email: 'maya@example.com', password: 'a'.repeat(12), confirmPassword: 'different-pass' }), /do not match/)
  assert.equal(validateRegistrationForm({ username: 'Maya_1', email: 'MAYA@example.com', password: 'a'.repeat(12), confirmPassword: 'a'.repeat(12) }), '')
})

test('session restoration and expired-session handling use server response as authority', () => {
  assert.deepEqual(accountStateFromSession({ authenticated: false }), { status: 'guest', user: null, csrfToken: '', error: '' })
  assert.deepEqual(accountStateAfterSessionError(new AuthApiError('expired', { status: 401 })), { status: 'guest', user: null, csrfToken: '', error: '' })
  const state = accountStateFromSession({ authenticated: true, user: { id: 'u1', username: 'maya', email: 'maya@example.com', password_hash: 'must-not-copy' }, csrfToken: 'csrf-in-memory' })
  assert.equal(state.status, 'authenticated')
  assert.deepEqual(state.user, { id: 'u1', username: 'maya', email: 'maya@example.com' })
  assert.equal(state.csrfToken, 'csrf-in-memory')
  assert.throws(() => authenticatedAccountState({ user: { username: 'missing-id' } }), /incomplete session/)
  assert.equal(accountStateAfterSessionError(new Error('server unavailable')).status, 'error')
})

test('authenticated and guest navigation stay visibly distinct', () => {
  assert.match(sidebar, /account\?\.status === 'authenticated'/)
  assert.match(sidebar, /\{ label: 'Profile', icon: 'user' \}/)
  assert.match(sidebar, /\{ label: 'Log in', icon: 'user' \}/)
  assert.doesNotMatch(sidebar, /label: 'Register'/)
  assert.match(sidebar, /'Guest access'/)
  assert.match(sidebar, /'Authenticated account'/)
  assert.match(sidebar, /onNavigate\(account\?\.status === 'authenticated' \? 'Profile' : 'Log in'\)/)
  assert.doesNotMatch(sidebar, /Free account|jordan/)
})

test('authentication uses the reusable Jammy turntable component', () => {
  assert.match(authPage, /import Turntable from '\.\.\/components\/Turntable\.jsx'/)
  assert.match(authPage, /<Turntable playing\/>/)
  assert.match(turntable, /auth-turntable-record/)
  assert.match(turntable, /auth-turntable-arm/)
  assert.match(turntable, /JAMMY · 33⅓/)
})

test('auth inputs preserve dark autofill styling and the background stays layered and responsive', () => {
  assert.match(authCss, /\.auth-page::before[\s\S]*radial-gradient[\s\S]*background-repeat:no-repeat/)
  assert.match(authCss, /@media\(max-width:820px\)[\s\S]*\.auth-page::before[\s\S]*radial-gradient/)
  assert.match(authCss, /input:-webkit-autofill/)
  assert.match(authCss, /input:-webkit-autofill:hover/)
  assert.match(authCss, /input:-webkit-autofill:focus/)
  assert.match(authCss, /input:-webkit-autofill:active/)
  assert.match(authCss, /-webkit-text-fill-color:#f4eee7/)
  assert.match(authCss, /caret-color:#f4eee7/)
  assert.match(authCss, /-webkit-box-shadow:0 0 0 1000px #1b1416 inset/)
  assert.match(authCss, /\.auth-input-wrap:focus-within\{border-color:/)
  assert.doesNotMatch(authPage, /autoComplete="off"/)
})

test('logout cleanup removes account identity and CSRF state', () => {
  assert.deepEqual(accountStateAfterLogout(), { status: 'guest', user: null, csrfToken: '', error: '' })
})

test('profile displays only available server-provided fields and handles loading/error states', () => {
  assert.match(profilePage, /account\.status === 'loading'[\s\S]*aria-busy="true"/)
  assert.match(profilePage, /account\.status === 'error'[\s\S]*role="alert"[\s\S]*Try again/)
  assert.match(profilePage, /account\.status !== 'authenticated' \|\| !account\.user/)
  assert.match(profilePage, /user\.email &&[\s\S]*<dd>\{user\.email\}<\/dd>/)
  assert.match(profilePage, /Authenticated account/)
  assert.match(profilePage, /onClick=\{onLogout\} disabled=\{logoutBusy\}/)
  assert.match(profilePage, /logoutBusy \? 'Logging out…' : 'Log out'/)
  assert.doesNotMatch(profilePage, /Password|Free account/)
})

test('Neon Auth API restores sessions and delegates sign up, sign in, and logout without storing secrets', async () => {
  const calls = []
  const user = { id: 'u1', name: 'maya', email: 'maya@example.com', createdAt: '2026-01-01T00:00:00.000Z' }
  const client = {
    getSession: async () => ({ data: { user, session: { id: 'session-id' } } }),
    signUp: { email: async (input) => { calls.push(['register', input]); return { data: { user } } } },
    signIn: { email: async (input) => { calls.push(['login', input]); return { data: { user } } } },
    signOut: async () => { calls.push(['logout']); return { data: null } },
  }
  const api = createAccountApi(client)
  assert.deepEqual(await api.getAuthSession(), { authenticated: true, user: { id: 'u1', username: 'maya', email: 'maya@example.com', createdAt: '2026-01-01T00:00:00.000Z' } })
  await api.loginAccount({ identifier: 'maya@example.com', password: 'private-password' })
  await api.registerAccount({ username: 'maya', email: 'maya@example.com', password: 'private-password' })
  await api.logoutAccount()
  assert.deepEqual(calls, [
    ['login', { email: 'maya@example.com', password: 'private-password' }],
    ['register', { name: 'maya', email: 'maya@example.com', password: 'private-password' }],
    ['logout'],
  ])
  assert.equal('localStorage' in globalThis, false)
})

test('Neon Auth access token uses the installed adapter getJWTToken contract', async () => {
  const { createAuthClient } = await import('@neon/auth')
  const installedClient = createAuthClient('https://auth.example.test')
  assert.equal(typeof installedClient.getJWTToken, 'function')
  assert.equal(typeof installedClient.token, 'function')
  const api = createAccountApi({
    getJWTToken: async () => 'eyJhbGciOiJFZERTQSJ9.eyJleHAiOjQ3MDAwMDAwMDB9.signature',
    token: async () => { throw new Error('Better Auth plugin token is not the Neon JWT API') },
  })
  assert.equal(await api.getBearerToken(), 'eyJhbGciOiJFZERTQSJ9.eyJleHAiOjQ3MDAwMDAwMDB9.signature')
  const missing = createAccountApi({ getJWTToken: async () => null, getSession: async () => ({ data: null }) })
  await assert.rejects(missing.getBearerToken(), (error) => error instanceof AuthApiError && error.code === 'AUTH_SESSION_EXPIRED' && error.status === 401)
  const wrongContract = createAccountApi({ token: async () => ({ data: { token: 'legacy-token' } }) })
  await assert.rejects(wrongContract.getBearerToken(), (error) => error.code === 'AUTH_SDK_CONFIGURATION' && error.status === 503)
})

test('Neon Auth API surfaces failed login and registration responses safely', async () => {
  const client = {
    signIn: { email: async () => ({ error: { status: 401, code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password.' } }) },
    signUp: { email: async () => ({ error: { status: 409, code: 'USER_ALREADY_EXISTS', message: 'That email is already registered.' } }) },
  }
  const api = createAccountApi(client)
  await assert.rejects(api.loginAccount({ identifier: 'maya@example.com', password: 'bad' }), (error) => error.status === 401 && error.code === 'INVALID_EMAIL_OR_PASSWORD' && /Invalid email/.test(error.message))
  await assert.rejects(api.registerAccount({ username: 'taken', email: 'x@example.com', password: 'long-enough-password' }), (error) => error.status === 409 && error.code === 'USER_ALREADY_EXISTS' && error instanceof AuthApiError)
})

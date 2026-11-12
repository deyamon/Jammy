export function guestAccountState(status = 'guest', error = '') {
  return { status, user: null, csrfToken: '', error }
}

export function authenticatedAccountState(payload) {
  const user = payload?.user
  if (!user || typeof user.id !== 'string' || typeof user.username !== 'string') {
    throw new Error('The account server returned an incomplete session.')
  }
  return {
    status: 'authenticated',
    user: { id: user.id, username: user.username, ...(typeof user.email === 'string' ? { email: user.email } : {}), ...(typeof user.emailVerified === 'boolean' ? { emailVerified: user.emailVerified } : {}), ...(typeof user.createdAt === 'string' ? { createdAt: user.createdAt } : {}) },
    csrfToken: typeof payload.csrfToken === 'string' ? payload.csrfToken : '',
    error: '',
  }
}

export function accountStateFromSession(payload) {
  if (payload?.authenticated !== true) return guestAccountState()
  return authenticatedAccountState(payload)
}

export function accountStateAfterSessionError(error) {
  return error?.status === 401 ? guestAccountState() : guestAccountState('error', error?.message || 'Jammy could not verify your session.')
}

export function accountStateAfterLogout() {
  return guestAccountState()
}

export function validateLoginForm({ identifier, password }) {
  const email = identifier.trim()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.'
  if (!password || password.length > 128) return 'Enter your password.'
  return ''
}

export function validateRegistrationForm({ username, email, password, confirmPassword }) {
  const normalizedUsername = username.trim().toLowerCase()
  const normalizedEmail = email.trim().toLowerCase()
  if (!/^[a-z0-9_]{3,24}$/.test(normalizedUsername)) return 'Username must be 3–24 characters using letters, numbers, or underscores.'
  if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return 'Enter a valid email address.'
  if (password.length < 12 || password.length > 128) return 'Password must be 12–128 characters.'
  if (password !== confirmPassword) return 'Those passwords do not match.'
  return ''
}


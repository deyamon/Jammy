import { useState } from 'react'
import '../auth.css'
import Turntable from '../components/Turntable.jsx'
import { loginAccount, registerAccount, requestPasswordReset, resetPassword, resendVerificationEmail } from '../services/authApi.js'
import { validateLoginForm, validateRegistrationForm } from '../account/accountState.js'

function FieldIcon({ kind }) {
  return <svg className="auth-field-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'identity' ? <><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></> : <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>}
  </svg>
}

function BrandWave() {
  return <span className="auth-brand-wave" aria-hidden="true"><i/><i/><i/><i/><i/><i/><i/></span>
}

export default function AuthPage({ onAuthenticated, sessionError = '', onRetrySession }) {
  const [isRegister, setIsRegister] = useState(false)
  const initialParams = new URLSearchParams(window.location.search)
  const [mode, setMode] = useState(() => ['forgot', 'reset', 'verified', 'verify-pending'].includes(initialParams.get('auth')) ? initialParams.get('auth') : 'account')
  const [showPassword, setShowPassword] = useState(false)
  const [values, setValues] = useState({ username: '', email: initialParams.get('email') || '', identifier: '', password: '', confirmPassword: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const update = (field) => (event) => setValues((previous) => ({ ...previous, [field]: event.target.value }))
  const setAuthMode = (nextMode, { cleanUrl = false } = {}) => {
    setMode(nextMode)
    setError('')
    setNotice('')
    const url = new URL(window.location.href)
    if (nextMode === 'account' || cleanUrl) {
      url.searchParams.delete('auth')
      url.searchParams.delete('token')
      url.searchParams.delete('email')
    } else url.searchParams.set('auth', nextMode)
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  }
  const chooseMode = (register) => { setIsRegister(register); setAuthMode('account') }
  const resetToken = new URLSearchParams(window.location.search).get('token') || ''

  const submit = async (event) => {
    event.preventDefault()
    const validationError = mode === 'forgot' || mode === 'verify-pending'
      ? (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim()) ? 'Enter a valid email address.' : '')
      : mode === 'reset'
        ? (!resetToken ? 'This reset link is invalid or expired. Request a new link.' : values.password.length < 12 || values.password.length > 128 ? 'Password must be 12–128 characters.' : values.password !== values.confirmPassword ? 'Those passwords do not match.' : '')
        : isRegister ? validateRegistrationForm(values) : validateLoginForm(values)
    setError(validationError)
    if (validationError) return
    setBusy(true)
    try {
      if (mode === 'forgot') {
        await requestPasswordReset({ email: values.email.trim(), redirectTo: `${window.location.origin}/?auth=reset` })
        setNotice('If an account exists for this email, a reset link has been sent.')
      } else if (mode === 'verify-pending') {
        await resendVerificationEmail({ email: values.email.trim(), callbackURL: `${window.location.origin}/?auth=verified` })
        setNotice('If this account needs verification, a new email has been sent.')
      } else if (mode === 'reset') {
        await resetPassword({ token: resetToken, newPassword: values.password })
        setAuthMode('account', { cleanUrl: true })
        setNotice('Password updated. Log in with your new password.')
        setIsRegister(false)
        setValues((previous) => ({ ...previous, password: '', confirmPassword: '' }))
      } else {
        const result = isRegister
          ? await registerAccount({ username: values.username, email: values.email, password: values.password })
          : await loginAccount({ identifier: values.identifier, password: values.password })
        if (isRegister && result.user.emailVerified === false) {
          setValues((previous) => ({ ...previous, email: values.email.trim() }))
          setAuthMode('verify-pending')
          setNotice('Check your inbox for a verification email before signing in.')
        } else onAuthenticated(result)
      }
    } catch (requestError) {
      const code = String(requestError.code || '').toLowerCase()
      if (mode === 'reset' && /expired|invalid.*token|token.*invalid/.test(`${code} ${requestError.message || ''}`.toLowerCase())) {
        setError('This reset link is invalid or expired. Request a new link.')
      } else if (!isRegister && mode === 'account' && /email.*verif|verif.*email/.test(`${code} ${requestError.message || ''}`.toLowerCase())) {
        setError('Verify your email before logging in. You can request another verification email below.')
      } else setError(requestError.message || 'Your account request could not be completed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return <main className="auth-page" aria-labelledby="account-heading">
    <div className="auth-atmosphere" aria-hidden="true"><i/><i/><i/></div>
    <div className="auth-layout">
      <section className="auth-visual" aria-label="Jammy turntable">
        <div className="auth-edition-line"><span>JAMMY / STEREO</span><span>33⅓ RPM</span></div>
        <Turntable playing/>
        <div className="auth-record-caption"><span className="auth-caption-rule"/><span>Made for the moments you share</span></div>
      </section>

      <section className="auth-panel">
        <a className="brand auth-brand" href="#jammy" onClick={(event) => event.preventDefault()} aria-label="Jammy">
          <span className="brand-mark">j</span><span>jammy<span className="brand-period">.</span></span><BrandWave/>
        </a>
        <p className="auth-overline">A BETTER WAY TO LISTEN</p>
        <h1 id="account-heading">{mode === 'forgot' ? <>Find your way<br/>back.</> : mode === 'reset' ? <>A fresh start<br/>for your account.</> : mode === 'verified' ? <>You’re all set<span>.</span></> : mode === 'verify-pending' ? <>One quick<br/>check<span>.</span></> : <>Your music.<br/>Your people.</>}</h1>
        {mode === 'account' && <div className="auth-mode-switch" role="group" aria-label="Choose account action">
          <button type="button" aria-pressed={!isRegister} className={!isRegister ? 'selected' : ''} onClick={() => chooseMode(false)}>Log In</button>
          <button type="button" aria-pressed={isRegister} className={isRegister ? 'selected' : ''} onClick={() => chooseMode(true)}>Create Account</button>
        </div>}

        {mode === 'verified' && <div className="auth-session-error" role="status">Your email verification link was opened. You can log in now.</div>}

        {sessionError && <div className="auth-session-error" role="status">
          <span>{sessionError}</span>
          <button type="button" onClick={onRetrySession}>Retry</button>
        </div>}

        {(mode === 'account' || mode === 'forgot' || mode === 'reset' || mode === 'verify-pending') && <form className="account-form auth-form" onSubmit={submit} noValidate>
          {mode === 'forgot' || mode === 'verify-pending' ? <>
            <p className="account-intro">{mode === 'forgot' ? 'Enter the email address associated with your account.' : 'Enter the account email and we’ll send a fresh verification link if one is needed.'}</p>
            <label htmlFor="recovery-email">Email address</label>
            <div className="auth-input-wrap"><FieldIcon kind="identity"/><input id="recovery-email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} value={values.email} onChange={update('email')}/></div>
          </> : mode === 'reset' ? <>
            <p className="account-intro">Choose a new password for your Jammy account.</p>
            <label htmlFor="account-password">New password</label>
            <div className="auth-input-wrap"><FieldIcon kind="lock"/><input id="account-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" placeholder="At least 12 characters" required minLength={12} maxLength={128} value={values.password} onChange={update('password')}/><button className="auth-password-toggle" type="button" onClick={() => setShowPassword((shown) => !shown)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? 'Hide' : 'Show'}</button></div>
            <label htmlFor="confirm-password">Confirm new password</label>
            <div className="auth-input-wrap"><FieldIcon kind="lock"/><input id="confirm-password" name="confirmPassword" type={showPassword ? 'text' : 'password'} autoComplete="new-password" placeholder="Repeat your new password" required minLength={12} maxLength={128} value={values.confirmPassword} onChange={update('confirmPassword')}/></div>
          </> : isRegister ? <>
            <label htmlFor="register-username">Username</label>
            <div className="auth-input-wrap"><FieldIcon kind="identity"/><input id="register-username" name="username" autoComplete="username" placeholder="Choose a username" required minLength={3} maxLength={24} value={values.username} onChange={update('username')} aria-describedby={error ? 'account-error' : 'username-hint'}/></div>
            <small id="username-hint">3–24 letters, numbers, or underscores.</small>
            <label htmlFor="register-email">Email</label>
            <div className="auth-input-wrap"><FieldIcon kind="identity"/><input id="register-email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} value={values.email} onChange={update('email')}/></div>
          </> : <>
            <label htmlFor="login-identifier">Email address</label>
            <div className="auth-input-wrap"><FieldIcon kind="identity"/><input id="login-identifier" name="identifier" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} value={values.identifier} onChange={update('identifier')} aria-describedby={error ? 'account-error' : undefined}/></div>
          </>}
          <label htmlFor="account-password">Password</label>
          <div className="auth-input-wrap"><FieldIcon kind="lock"/><input id="account-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={isRegister ? 'new-password' : 'current-password'} placeholder={isRegister ? 'At least 12 characters' : 'Enter your password'} required minLength={isRegister ? 12 : undefined} maxLength={128} value={values.password} onChange={update('password')} aria-describedby={error ? 'account-error' : undefined}/><button className="auth-password-toggle" type="button" onClick={() => setShowPassword((shown) => !shown)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>{showPassword ? 'Hide' : 'Show'}</button></div>
          {isRegister && <>
            <label htmlFor="confirm-password">Confirm password</label>
            <div className="auth-input-wrap"><FieldIcon kind="lock"/><input id="confirm-password" name="confirmPassword" type={showPassword ? 'text' : 'password'} autoComplete="new-password" placeholder="Repeat your password" required minLength={12} maxLength={128} value={values.confirmPassword} onChange={update('confirmPassword')} aria-describedby={error ? 'account-error' : undefined}/></div>
          </>}
          {error && <p id="account-error" className="account-error" role="alert">{error}</p>}
          {notice && <p className="account-status" role="status">{notice}</p>}
          <button className="account-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'forgot' ? 'Send reset link' : mode === 'verify-pending' ? 'Resend verification email' : mode === 'reset' ? 'Update password' : isRegister ? 'Create Account' : 'Log In'}</button>
          {mode === 'account' && !isRegister && <button className="auth-text-button" type="button" onClick={() => setAuthMode('forgot')}>Forgot password?</button>}
        </form>}
        {mode === 'verified' && <button className="account-submit" type="button" onClick={() => setAuthMode('account', { cleanUrl: true })}>Continue to log in</button>}
        {mode !== 'account' && mode !== 'verified' && <button className="auth-text-button" type="button" onClick={() => { setAuthMode('account', { cleanUrl: true }); setIsRegister(false) }}>Back to log in</button>}
        <p className="auth-footer">LISTEN TOGETHER. ANYWHERE.</p>
      </section>
    </div>
  </main>
}

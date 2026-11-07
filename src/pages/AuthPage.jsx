import { useState } from 'react'
import '../auth.css'
import Turntable from '../components/Turntable.jsx'
import { loginAccount, registerAccount } from '../services/authApi.js'
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
  const [showPassword, setShowPassword] = useState(false)
  const [values, setValues] = useState({ username: '', email: '', identifier: '', password: '', confirmPassword: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const update = (field) => (event) => setValues((previous) => ({ ...previous, [field]: event.target.value }))
  const chooseMode = (register) => { setIsRegister(register); setError('') }

  const submit = async (event) => {
    event.preventDefault()
    const validationError = isRegister ? validateRegistrationForm(values) : validateLoginForm(values)
    setError(validationError)
    if (validationError) return
    setBusy(true)
    try {
      const result = isRegister
        ? await registerAccount({ username: values.username, email: values.email, password: values.password })
        : await loginAccount({ identifier: values.identifier, password: values.password })
      onAuthenticated(result)
    } catch (requestError) {
      setError(requestError.message || 'Your account request could not be completed. Please try again.')
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
        <h1 id="account-heading">Your music.<br/>Your people.</h1>
        <div className="auth-mode-switch" role="group" aria-label="Choose account action">
          <button type="button" aria-pressed={!isRegister} className={!isRegister ? 'selected' : ''} onClick={() => chooseMode(false)}>Log In</button>
          <button type="button" aria-pressed={isRegister} className={isRegister ? 'selected' : ''} onClick={() => chooseMode(true)}>Create Account</button>
        </div>

        {sessionError && <div className="auth-session-error" role="status">
          <span>{sessionError}</span>
          <button type="button" onClick={onRetrySession}>Retry</button>
        </div>}

        <form className="account-form auth-form" onSubmit={submit} noValidate>
          {isRegister ? <>
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
          <button className="account-submit" type="submit" disabled={busy}>{busy ? (isRegister ? 'Creating account…' : 'Logging in…') : (isRegister ? 'Create Account' : 'Log In')}</button>
        </form>
        <p className="auth-footer">LISTEN TOGETHER. ANYWHERE.</p>
      </section>
    </div>
  </main>
}

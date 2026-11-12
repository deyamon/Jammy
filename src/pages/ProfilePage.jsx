import { useState } from 'react'
import { changePassword, resendVerificationEmail } from '../services/authApi.js'

export default function ProfilePage({ account, onLogout, onRetry, logoutBusy = false }) {
  const [passwordValues, setPasswordValues] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordNotice, setPasswordNotice] = useState('')
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [verifyNotice, setVerifyNotice] = useState('')
  const [showPasswords, setShowPasswords] = useState(false)
  if (account.status === 'loading') return <section className="account-page" aria-live="polite" aria-busy="true"><div className="account-card"><p className="eyebrow">YOUR ACCOUNT</p><h1>Loading profile<span>.</span></h1><p className="account-intro">Checking your account with Jammy…</p></div></section>
  if (account.status === 'error') return <section className="account-page" aria-labelledby="profile-heading"><div className="account-card"><p className="eyebrow">YOUR ACCOUNT</p><h1 id="profile-heading">Profile unavailable<span>.</span></h1><p className="account-error" role="alert">{account.error || 'Jammy could not verify your session.'}</p><button className="account-submit" type="button" onClick={onRetry}>Try again</button></div></section>
  if (account.status !== 'authenticated' || !account.user) return <section className="account-page" aria-labelledby="profile-heading"><div className="account-card"><p className="eyebrow">YOUR ACCOUNT</p><h1 id="profile-heading">You’re browsing as a guest<span>.</span></h1><p className="account-intro">Log in or create an account to view your account details.</p></div></section>

  const { user } = account
  const updatePassword = (field) => (event) => setPasswordValues((previous) => ({ ...previous, [field]: event.target.value }))
  const submitPasswordChange = async (event) => {
    event.preventDefault()
    setPasswordError('')
    setPasswordNotice('')
    if (!passwordValues.currentPassword) { setPasswordError('Enter your current password.'); return }
    if (passwordValues.newPassword.length < 12 || passwordValues.newPassword.length > 128) { setPasswordError('New password must be 12–128 characters.'); return }
    if (passwordValues.newPassword !== passwordValues.confirmPassword) { setPasswordError('Those passwords do not match.'); return }
    if (passwordValues.currentPassword === passwordValues.newPassword) { setPasswordError('Choose a password different from your current one.'); return }
    setPasswordBusy(true)
    try {
      await changePassword({ currentPassword: passwordValues.currentPassword, newPassword: passwordValues.newPassword })
      setPasswordValues({ currentPassword: '', newPassword: '', confirmPassword: '' })
      setPasswordNotice('Password changed. Other active sessions have been signed out.')
    } catch (error) { setPasswordError(error.message || 'Password could not be changed. Please try again.') }
    finally { setPasswordBusy(false) }
  }
  const resendVerification = async () => {
    if (!user.email || verifyBusy) return
    setVerifyBusy(true)
    setVerifyNotice('')
    try {
      await resendVerificationEmail({ email: user.email, callbackURL: `${window.location.origin}/?auth=verified` })
      setVerifyNotice('If your email needs verification, a new link has been sent.')
    } catch (error) { setVerifyNotice(error.message || 'A verification email could not be sent.') }
    finally { setVerifyBusy(false) }
  }
  return <section className="account-page" aria-labelledby="profile-heading">
    <div className="account-card profile-card">
      <p className="eyebrow">YOUR ACCOUNT</p>
      <div className="profile-identity"><span className="profile-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span><div><h1 id="profile-heading">{user.username}<span>.</span></h1><span className="account-status"><i/> Authenticated account</span></div></div>
      <dl className="profile-details"><div><dt>Username</dt><dd>{user.username}</dd></div>{user.email && <div><dt>Email</dt><dd>{user.email}</dd></div>}{typeof user.emailVerified === 'boolean' && <div><dt>Email status</dt><dd>{user.emailVerified ? 'Verified' : 'Not verified'}</dd></div>}{user.createdAt && <div><dt>Member since</dt><dd><time dateTime={user.createdAt}>{new Date(user.createdAt).toLocaleDateString()}</time></dd></div>}</dl>
      {user.emailVerified === false && <div className="account-security-section"><p className="account-intro">Verify your email to keep your account recovery details current.</p><button className="auth-text-button" type="button" disabled={verifyBusy} onClick={resendVerification}>{verifyBusy ? 'Sending…' : 'Resend verification email'}</button>{verifyNotice && <p className="account-status" role="status">{verifyNotice}</p>}</div>}
      <div className="account-security-section">
        <h2>Change password</h2>
        <form className="account-form" onSubmit={submitPasswordChange} noValidate>
          <label htmlFor="current-password">Current password</label><input id="current-password" name="currentPassword" type={showPasswords ? 'text' : 'password'} autoComplete="current-password" maxLength={128} value={passwordValues.currentPassword} onChange={updatePassword('currentPassword')} required/>
          <label htmlFor="new-password">New password</label><input id="new-password" name="newPassword" type={showPasswords ? 'text' : 'password'} autoComplete="new-password" minLength={12} maxLength={128} value={passwordValues.newPassword} onChange={updatePassword('newPassword')} required/>
          <label htmlFor="confirm-new-password">Confirm new password</label><input id="confirm-new-password" name="confirmPassword" type={showPasswords ? 'text' : 'password'} autoComplete="new-password" minLength={12} maxLength={128} value={passwordValues.confirmPassword} onChange={updatePassword('confirmPassword')} required/>
          <button className="auth-text-button" type="button" aria-pressed={showPasswords} onClick={() => setShowPasswords((value) => !value)}>{showPasswords ? 'Hide passwords' : 'Show passwords'}</button>
          {passwordError && <p className="account-error" role="alert">{passwordError}</p>}{passwordNotice && <p className="account-status" role="status">{passwordNotice}</p>}
          <button className="account-submit" type="submit" disabled={passwordBusy}>{passwordBusy ? 'Updating…' : 'Update password'}</button>
        </form>
      </div>
      <button className="account-submit account-logout" type="button" onClick={onLogout} disabled={logoutBusy}>{logoutBusy ? 'Logging out…' : 'Log out'}</button>
    </div>
  </section>
}

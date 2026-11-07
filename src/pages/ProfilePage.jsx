export default function ProfilePage({ account, onLogout, onRetry, logoutBusy = false }) {
  if (account.status === 'loading') return <section className="account-page" aria-live="polite" aria-busy="true"><div className="account-card"><p className="eyebrow">YOUR ACCOUNT</p><h1>Loading profile<span>.</span></h1><p className="account-intro">Checking your account with Jammy…</p></div></section>
  if (account.status === 'error') return <section className="account-page" aria-labelledby="profile-heading"><div className="account-card"><p className="eyebrow">YOUR ACCOUNT</p><h1 id="profile-heading">Profile unavailable<span>.</span></h1><p className="account-error" role="alert">{account.error || 'Jammy could not verify your session.'}</p><button className="account-submit" type="button" onClick={onRetry}>Try again</button></div></section>
  if (account.status !== 'authenticated' || !account.user) return <section className="account-page" aria-labelledby="profile-heading"><div className="account-card"><p className="eyebrow">YOUR ACCOUNT</p><h1 id="profile-heading">You’re browsing as a guest<span>.</span></h1><p className="account-intro">Log in or create an account to view your account details.</p></div></section>

  const { user } = account
  return <section className="account-page" aria-labelledby="profile-heading">
    <div className="account-card profile-card">
      <p className="eyebrow">YOUR ACCOUNT</p>
      <div className="profile-identity"><span className="profile-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span><div><h1 id="profile-heading">{user.username}<span>.</span></h1><span className="account-status"><i/> Authenticated account</span></div></div>
      <dl className="profile-details"><div><dt>Username</dt><dd>{user.username}</dd></div>{user.email && <div><dt>Email</dt><dd>{user.email}</dd></div>}{user.createdAt && <div><dt>Member since</dt><dd><time dateTime={user.createdAt}>{new Date(user.createdAt).toLocaleDateString()}</time></dd></div>}</dl>
      <p className="account-intro">Profile editing isn’t available yet.</p>
      <button className="account-submit account-logout" type="button" onClick={onLogout} disabled={logoutBusy}>{logoutBusy ? 'Logging out…' : 'Log out'}</button>
    </div>
  </section>
}

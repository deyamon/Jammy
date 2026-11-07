export default function Turntable({ playing = true, className = '' }) {
  return <figure className={`auth-turntable ${playing ? 'is-playing' : ''} ${className}`.trim()} role="img" aria-label="A Jammy vinyl record on a turntable">
    <div className="auth-turntable-deck">
      <div className="auth-turntable-platter">
        <div className="auth-turntable-record">
          <span className="auth-turntable-label"><b>j.</b><small>JAMMY · 33⅓</small></span>
          <i className="auth-turntable-spindle"/>
        </div>
      </div>
      <span className="auth-turntable-pivot" aria-hidden="true"/>
      <span className="auth-turntable-arm" aria-hidden="true"/>
      <span className="auth-turntable-cartridge" aria-hidden="true"/>
      <span className="auth-turntable-mark">JAMMY <i/> STEREO</span>
    </div>
  </figure>
}

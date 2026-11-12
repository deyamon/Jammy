import crypto from 'node:crypto'
import { isIP } from 'node:net'

const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000
const EVENT_CACHE_MS = 10 * 60 * 1000

function webhookError(message, status) {
  return Object.assign(new Error(message), { status })
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function headerValue(headers, name) {
  return typeof headers?.get === 'function' ? headers.get(name) : headers?.[name.toLowerCase()]
}

export function createAuthEmailWebhook({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let jwksCache = { expiresAt: 0, keys: [] }
  const deliveredEvents = new Map()

  async function verifySignature(rawBody, headers) {
    const signature = headerValue(headers, 'x-neon-signature')
    const kid = headerValue(headers, 'x-neon-signature-kid')
    const timestamp = headerValue(headers, 'x-neon-timestamp')
    if (!signature || !kid || !timestamp || !/^\d{10,16}$/.test(timestamp)) throw webhookError('Invalid webhook signature headers.', 401)
    const timestampNumber = Number(timestamp)
    if (!Number.isSafeInteger(timestampNumber) || Math.abs(now() - timestampNumber) > MAX_WEBHOOK_AGE_MS) throw webhookError('Webhook timestamp outside allowed window.', 401)
    let authBase
    try {
      authBase = new URL(env.NEON_AUTH_BASE_URL)
      if (authBase.protocol !== 'https:' || authBase.username || authBase.password || authBase.search || authBase.hash || authBase.hostname === 'localhost' || authBase.hostname.endsWith('.local') || isIP(authBase.hostname)) throw new Error('invalid')
    } catch { throw webhookError('Neon Auth webhook verification is not configured.', 503) }
    const fetchKeys = async () => {
      const jwksUrl = new URL('.well-known/jwks.json', `${authBase.href.replace(/\/+$/, '')}/`).href
      const response = await fetchImpl(jwksUrl, { headers: { accept: 'application/json' } })
      if (!response.ok) throw webhookError('Neon Auth signing keys are unavailable.', 503)
      const data = await response.json()
      jwksCache = { keys: Array.isArray(data?.keys) ? data.keys : [], expiresAt: now() + 5 * 60 * 1000 }
    }
    if (jwksCache.expiresAt <= now()) await fetchKeys()
    let jwk = jwksCache.keys.find((key) => key.kid === kid && key.kty === 'OKP' && key.crv === 'Ed25519')
    if (!jwk) {
      await fetchKeys()
      jwk = jwksCache.keys.find((key) => key.kid === kid && key.kty === 'OKP' && key.crv === 'Ed25519')
    }
    if (!jwk) throw webhookError('Neon Auth signing key was not found.', 401)
    const [headerPart, emptyPayload, signaturePart] = signature.split('.')
    if (!headerPart || emptyPayload !== '' || !signaturePart) throw webhookError('Invalid detached signature format.', 401)
    const payloadPart = Buffer.from(rawBody, 'utf8').toString('base64url')
    const signedPayload = `${timestamp}.${payloadPart}`
    const signingInput = `${headerPart}.${Buffer.from(signedPayload, 'utf8').toString('base64url')}`
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' })
    if (!crypto.verify(null, Buffer.from(signingInput), publicKey, Buffer.from(signaturePart, 'base64url'))) throw webhookError('Invalid webhook signature.', 401)
  }

  async function sendResendEmail({ to, subject, html }) {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('Transactional email is not configured on this backend.')
    const payload = { from: env.EMAIL_FROM, to: [to], subject, html }
    if (env.EMAIL_REPLY_TO) payload.reply_to = env.EMAIL_REPLY_TO
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error('Transactional email delivery failed.')
  }

  async function handle(rawBody, headers) {
    if (!Buffer.isBuffer(rawBody) || rawBody.length > 16 * 1024) throw Object.assign(new Error('Invalid webhook payload.'), { status: 400 })
    try { await verifySignature(rawBody.toString('utf8'), headers) }
    catch (error) { throw Object.assign(error, { status: Number.isInteger(error?.status) ? error.status : 503 }) }
    let event
    try { event = JSON.parse(rawBody.toString('utf8')) }
    catch { throw Object.assign(new Error('Invalid webhook payload.'), { status: 400 }) }
    if (!event || typeof event.event_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.event_id)) throw Object.assign(new Error('Invalid webhook event.'), { status: 400 })
    for (const [id, expiresAt] of deliveredEvents) if (expiresAt <= now()) deliveredEvents.delete(id)
    if (deliveredEvents.has(event.event_id)) return { duplicate: true }

    const email = typeof event.user?.email === 'string' ? event.user.email.trim() : ''
    if (!email || email.length > 254 || /[\r\n]/.test(email)) throw Object.assign(new Error('Invalid email event.'), { status: 400 })
    const safeName = escapeHtml((typeof event.user?.name === 'string' && event.user.name.trim()) || 'there')
    const kind = event.event_data?.otp_type || event.event_data?.link_type
    let subject
    let content
    if (event.event_type === 'send.otp' && ['email-verification', 'forget-password', 'sign-in'].includes(kind)) {
      const code = String(event.event_data?.otp_code || '')
      if (!/^\d{6}$/.test(code)) throw Object.assign(new Error('Invalid OTP email event.'), { status: 400 })
      subject = kind === 'forget-password' ? 'Reset your Jammy password' : kind === 'sign-in' ? 'Your Jammy sign-in code' : 'Verify your Jammy email'
      content = `<h1>${subject}</h1><p>Hi ${safeName},</p><p>Your one-time code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:8px">${code}</p><p>This code expires soon. If you did not request it, you can ignore this message.</p>`
    } else if (event.event_type === 'send.magic_link' && ['email-verification', 'forget-password', 'sign-in'].includes(kind)) {
      let link
      try { link = new URL(String(event.event_data?.link_url || '')) }
      catch { throw Object.assign(new Error('Invalid auth link.'), { status: 400 }) }
      const authHost = env.NEON_AUTH_BASE_URL ? new URL(env.NEON_AUTH_BASE_URL).host : ''
      if (link.protocol !== 'https:' || !authHost || link.host !== authHost || link.username || link.password) throw Object.assign(new Error('Invalid auth link.'), { status: 400 })
      subject = kind === 'forget-password' ? 'Reset your Jammy password' : kind === 'sign-in' ? 'Your Jammy sign-in link' : 'Verify your Jammy email'
      content = `<h1>${subject}</h1><p>Hi ${safeName},</p><p>Use the secure link below to continue. It expires soon and can only be used once.</p><p><a href="${escapeHtml(link.href)}" style="display:inline-block;padding:12px 18px;background:#a91f31;color:#fff;text-decoration:none;border-radius:6px">Continue to Jammy</a></p><p>If you did not request this, you can ignore this message.</p>`
    } else {
      throw Object.assign(new Error('Unsupported auth email event.'), { status: 400 })
    }

    await sendResendEmail({ to: email, subject, html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#21191a">${content}<p style="margin-top:32px;color:#766b69">Jammy · Listen together, anywhere.</p></div>` })
    deliveredEvents.set(event.event_id, now() + EVENT_CACHE_MS)
    return { duplicate: false }
  }

  return { handle }
}

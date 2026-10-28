const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

async function request(path, options = {}) {
  let response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    })
  } catch {
    throw new Error('Jammy’s room server could not be reached. Start the backend and try again.')
  }

  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.')
  return body
}

export function createRoom({ name, displayName, maxMembers }) {
  return request('/api/rooms', { method: 'POST', body: JSON.stringify({ name, displayName, maxMembers }) })
}

export function joinRoom(code, { displayName }) {
  return request(`/api/rooms/${encodeURIComponent(code)}/join`, {
    method: 'POST', body: JSON.stringify({ displayName }),
  })
}

export function leaveRoom({ code, memberId, memberToken }) {
  return request(`/api/rooms/${encodeURIComponent(code)}/leave`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${memberToken}`, 'X-Room-Member-Id': memberId },
  })
}

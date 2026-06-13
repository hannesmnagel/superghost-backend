import type WebSocket from 'ws'

// userId -> WebSocket (one active socket per user)
const sockets = new Map<string, WebSocket>()
// userId -> timeout for reconnect grace
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function register(userId: string, ws: WebSocket): void {
  // Close any existing socket for this user
  const existing = sockets.get(userId)
  if (existing && existing !== ws) {
    try { existing.close() } catch {}
  }
  sockets.set(userId, ws)
  clearDisconnectTimer(userId)
}

export function unregister(userId: string, ws: WebSocket): void {
  if (sockets.get(userId) === ws) {
    sockets.delete(userId)
  }
}

export function getSocket(userId: string): WebSocket | undefined {
  return sockets.get(userId)
}

export function isOnline(userId: string): boolean {
  const ws = sockets.get(userId)
  return !!ws && ws.readyState === 1 // OPEN
}

export function send(userId: string, msg: object): void {
  const ws = sockets.get(userId)
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg))
  }
}

export function sendToAll(userIds: string[], msg: object): void {
  const payload = JSON.stringify(msg)
  for (const uid of userIds) {
    const ws = sockets.get(uid)
    if (ws && ws.readyState === 1) ws.send(payload)
  }
}

export function setDisconnectTimer(userId: string, ms: number, onExpire: () => void): void {
  clearDisconnectTimer(userId)
  disconnectTimers.set(userId, setTimeout(() => {
    disconnectTimers.delete(userId)
    onExpire()
  }, ms))
}

export function clearDisconnectTimer(userId: string): void {
  const t = disconnectTimers.get(userId)
  if (t) {
    clearTimeout(t)
    disconnectTimers.delete(userId)
  }
}

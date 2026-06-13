import type WebSocket from 'ws'

// userId -> active WebSocket (one socket per user)
const sockets = new Map<string, WebSocket>()
// userId -> reconnect grace timer
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function register(userId: string, ws: WebSocket): void {
  const existing = sockets.get(userId)
  if (existing && existing !== ws) {
    try { existing.close() } catch { /* ignore */ }
  }
  sockets.set(userId, ws)
  clearDisconnectTimer(userId)
}

export function unregister(userId: string, ws: WebSocket): void {
  if (sockets.get(userId) === ws) sockets.delete(userId)
}

export function isOnline(userId: string): boolean {
  const ws = sockets.get(userId)
  return !!ws && ws.readyState === 1
}

export function send(userId: string, msg: object): void {
  const ws = sockets.get(userId)
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
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

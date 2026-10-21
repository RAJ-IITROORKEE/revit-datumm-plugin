// A denial before WebSocket acceptance arrives as HTTP 403, not close 1008.
// Keep terminal authorization failures distinct from recoverable network loss.
export function observeConnection(socket, { onAuthorizationRequired, onUnavailable, onDuplicate }) {
 let denied = false, duplicate = false;
 const deny = () => { if (!denied) { denied = true; onAuthorizationRequired(); } };
 socket.on('error', error => {
  if (/Unexpected server response: (401|403)\b/.test(error.message)) deny();
  else if (!denied) onUnavailable();
 });
 return new Promise(resolve => socket.once('close', (code, reason) => {
  if (code === 1008 && /^(DUPLICATE_ACTIVE_REQUEST|CONNECTOR_REPLACED)$/.test(reason.toString())) {
   duplicate = true;
   onDuplicate?.(reason.toString());
  } else if (code === 1008) deny();
  resolve({ authorizationRequired: denied, duplicate });
 }));
}

// Detect a half-open cloud socket after a backend revision is replaced. A
// quiet connection can otherwise remain "connected" locally while the new
// revision has no device presence.
export function keepConnectionAlive(socket, { intervalMs = 15000, timeoutMs = 10000 } = {}) {
 let pending = null;
 const clearPending = () => { if (pending) clearTimeout(pending); pending = null; };
 const ping = () => {
  if (socket.readyState !== socket.OPEN || pending) return;
  pending = setTimeout(() => socket.terminate(), timeoutMs);
  pending.unref?.();
  socket.ping();
 };
 const start = () => { if (socket.readyState === socket.OPEN) ping(); };
 const interval = setInterval(ping, intervalMs);
 interval.unref?.();
 socket.on('open', start);
 socket.on('pong', clearPending);
 socket.once('close', () => { clearPending(); clearInterval(interval); });
 return () => { clearPending(); clearInterval(interval); socket.off('open', start); };
}

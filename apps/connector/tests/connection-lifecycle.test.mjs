import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { observeConnection, keepConnectionAlive } from '../src/connection-lifecycle.mjs';

for (const status of [401, 403, 503]) {
 test(`HTTP handshake ${status} distinguishes revoked access from outage`, async t => {
  const server = createServer();
  server.on('upgrade', (_request, socket) => socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  let denied = 0, unavailable = 0;
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const result = await observeConnection(socket, {
   onAuthorizationRequired: () => denied++, onUnavailable: () => unavailable++
  });
  assert.equal(result.authorizationRequired, status !== 503);
  assert.equal(denied, status === 503 ? 0 : 1);
  assert.equal(unavailable, status === 503 ? 1 : 0);
 });
}
for (const code of [1000, 1008]) {
 test(`WebSocket close ${code} chooses the correct recovery`, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.on('connection', socket => socket.close(code));
  let denied = 0;
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const result = await observeConnection(socket, {
   onAuthorizationRequired: () => denied++, onUnavailable: () => assert.fail('Unexpected transport error')
  });
  assert.equal(result.authorizationRequired, code === 1008);
  assert.equal(denied, code === 1008 ? 1 : 0);
 });
}
for (const reason of ['DUPLICATE_ACTIVE_REQUEST','CONNECTOR_REPLACED']) {
 test(`duplicate close ${reason} stops reconnect without claiming revocation`, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.on('connection', socket => socket.close(1008,reason));
  let denied = 0, duplicate = '';
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const result = await observeConnection(socket, {
   onAuthorizationRequired: () => denied++, onUnavailable: () => assert.fail('Unexpected transport error'),
   onDuplicate: value => duplicate = value
  });
  assert.equal(result.duplicate,true);
  assert.equal(result.authorizationRequired,false);
  assert.equal(duplicate,reason);
  assert.equal(denied,0);
 });
}

test('half-open connector socket terminates and permits reconnect', async t => {
 const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false });
 await once(server, 'listening');
 t.after(() => new Promise(resolve => server.close(resolve)));
 const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
 keepConnectionAlive(socket, { intervalMs: 10, timeoutMs: 20 });
 const result = await observeConnection(socket, {
  onAuthorizationRequired: () => assert.fail('Half-open is not revoked access'),
  onUnavailable: () => {}
 });
 assert.equal(result.authorizationRequired, false);
 assert.equal(socket.readyState, WebSocket.CLOSED);
});

test('healthy connector pong keeps the socket open', async t => {
 const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
 await once(server, 'listening');
 t.after(() => new Promise(resolve => server.close(resolve)));
 const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
 keepConnectionAlive(socket, { intervalMs: 10, timeoutMs: 30 });
 await once(socket, 'open');
 await new Promise(resolve => setTimeout(resolve, 80));
 assert.equal(socket.readyState, WebSocket.OPEN);
 socket.close();
 await once(socket, 'close');
});

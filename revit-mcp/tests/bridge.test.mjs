import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BridgeClient } from '../dist/bridge.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hostDll = join(root, 'revit-plugin/tests/Datumm.Bridge.TestHost/bin/Release/net8.0-windows/Datumm.Bridge.TestHost.dll');

async function startHost(directory, port) {
  const child = spawn('dotnet', [hostDll, directory, ...(port ? [port] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic += chunk.toString(); });
  const lines = createInterface({ input: child.stdout });
  const next = () => Promise.race([
    once(lines, 'line').then(([line]) => line),
    once(child, 'exit').then(([code]) => { throw new Error(`Test host exited ${code}: ${diagnostic}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Test host timeout')), 15000); timer.unref(); }),
  ]);
  assert.equal(await next(), 'ready');
  return {
    async mode(value) { const pending = next(); child.stdin.write(value + '\n'); assert.equal(await pending, 'mode:' + value); },
    async stop() { const done = once(child, 'exit'); child.stdin.end('exit\n'); await done; lines.close(); },
  };
}

test('production C# bridge transport + actual MCP stdio (simulated Revit callback)', { timeout: 60000 }, async t => {
  const parent = join(root, 'artifacts/test-runs');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'bridge-'));
  const host = await startHost(directory);
  const client = new BridgeClient(directory);
  const descriptorPath = join(directory, (await readdir(directory)).find(name => name.endsWith('.json')));
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  const headers = { Authorization: `Bearer ${descriptor.token}`, 'X-Datumm-Protocol': '1',
    'X-Datumm-Session': descriptor.sessionId, 'X-Operation-Id': randomUUID() };
  async function request(route, overrides = {}, method = 'GET') {
    return fetch(new URL(route, descriptor.baseUrl), { method, headers: { ...headers, ...overrides } });
  }
  try {
    await t.test('authenticated discovery removes secrets and health/context satisfy shared schema', async () => {
      const sessions = await client.sessions();
      assert.equal(sessions.length, 1);
      assert.equal('token' in sessions[0], false);
      assert.equal('baseUrl' in sessions[0], false);
      assert.equal((await client.call('health')).data.readOnly, false);
      assert.equal((await client.call('document-context')).data.title, 'Simulated transport fixture');
    });
    await t.test('rejects invalid credentials, browser origins, protocol/session mismatches and writes', async () => {
      for (const [overrides, status, code] of [
        [{ Authorization: 'Bearer wrong' }, 401, 'UNAUTHORIZED'],
        [{ Origin: 'https://untrusted.example' }, 403, 'BROWSER_ORIGIN_REJECTED'],
        [{ 'X-Datumm-Protocol': '99' }, 409, 'PROTOCOL_MISMATCH'],
        [{ 'X-Datumm-Session': randomUUID() }, 409, 'SESSION_MISMATCH'],
        [{ 'X-Operation-Id': 'invalid' }, 400, 'INVALID_OPERATION_ID'],
      ]) {
        const response = await request('health', overrides);
        assert.equal(response.status, status);
        assert.equal((await response.json()).error.code, code);
      }
      assert.equal((await request('health', {}, 'POST')).status, 400);
      assert.equal((await request('health?unexpected=true')).status, 400);
      assert.equal((await request('execute-code')).status, 404);
    });
    await t.test('strict MCP tool listing, read calls and invalid input', async () => {
      const mcp = new Client({ name: 'datumm-transport-test', version: '1' });
      await mcp.connect(new StdioClientTransport({ command: process.execPath,
        args: [join(root, 'revit-mcp/dist/index.js')],
        env: { ...process.env, DATUMM_SESSION_DIR: directory }, stderr: 'inherit' }));
      try {
        assert.deepEqual((await mcp.listTools()).tools.map(tool => tool.name).sort(),
          ['apply_change_set', 'approve_change_set', 'get_dimension_references', 'get_document_context', 'get_model_catalog', 'get_model_elements', 'get_model_inventory', 'get_model_quantities', 'get_model_views', 'get_native_capabilities', 'get_operation_status', 'get_plan_image', 'get_plan_snapshot', 'get_revit_health', 'get_selection', 'list_revit_sessions', 'preview_changes', 'show_model_elements']);
        const result = await mcp.callTool({ name: 'get_document_context', arguments: { sessionId: descriptor.sessionId } });
        assert.equal(result.isError, false);
        assert.equal(JSON.parse(result.content[0].text).data.title, 'Simulated transport fixture');
        const capabilities = await mcp.callTool({ name: 'get_native_capabilities', arguments: { sessionId: descriptor.sessionId } });
        assert.equal(capabilities.isError, false);
        assert.equal(JSON.parse(capabilities.content[0].text).data.minimumMcpVersion, '0.2.0-alpha.5');
        const invalid = await mcp.callTool({ name: 'get_document_context', arguments: { sessionId: 'invalid' } });
        assert.equal(invalid.isError, true);
        const extra = await mcp.callTool({ name: 'get_document_context', arguments: { code: 'execute' } });
        assert.equal(extra.isError, true);
        const changes = { documentId: randomUUID(), expectedRevision: 0, levelId: 'fixture-level', units: 'mm', coordinateFrame: 'revit-internal-xy', title: 'Test',
          operations: [{ kind: 'floor', key: 'floor', typeId: 'fixture-floor', boundary: [{x:0,y:0},{x:4000,y:0},{x:4000,y:3000},{x:0,y:3000}] }] };
        const preview = await mcp.callTool({ name: 'preview_changes', arguments: { sessionId: descriptor.sessionId, ...changes } });
        assert.equal(preview.isError, false);
        assert.match(JSON.parse(preview.content[0].text).data.approvalHash, /^[a-f0-9]{64}$/);
        const roomMetadata = { ...changes, title: 'Room metadata preview', operations: [
          { kind: 'set_room_metadata', key: 'room-name-number', elementId: 'fixture-room', name: 'Bedroom 3', number: '303' },
        ] };
        const roomPreview = await mcp.callTool({ name: 'preview_changes', arguments: { sessionId: descriptor.sessionId, ...roomMetadata } });
        assert.equal(roomPreview.isError, false);
        const roomProposal = JSON.parse(roomPreview.content[0].text).data;
        assert.equal(roomProposal.changes.operations[0].kind, 'set_room_metadata');
        assert.equal(roomProposal.changes.operations[0].elementId, 'fixture-room');
        assert.equal(roomProposal.changes.operations[0].name, 'Bedroom 3');
        assert.equal(roomProposal.changes.operations[0].number, '303');
        const incompleteRoom = { ...roomMetadata, operations: [{ kind: 'set_room_metadata', key: 'room-name-number', elementId: 'fixture-room' }] };
        const invalidRoom = await mcp.callTool({ name: 'preview_changes', arguments: { sessionId: descriptor.sessionId, ...incompleteRoom } });
        assert.equal(invalidRoom.isError, true);
        const paddedRoom = { ...roomMetadata, operations: [{ kind: 'set_room_metadata', key: 'room-name-number', elementId: 'fixture-room', name: ' Bedroom 3' }] };
        const invalidPadding = await mcp.callTool({ name: 'preview_changes', arguments: { sessionId: descriptor.sessionId, ...paddedRoom } });
        assert.equal(invalidPadding.isError, true);
        changes.operations[0].boundary = [{x:0,y:0},{x:4000,y:3000},{x:4000,y:0},{x:0,y:3000}];
        const crossed = await mcp.callTool({ name: 'preview_changes', arguments: { sessionId: descriptor.sessionId, ...changes } });
        assert.equal(crossed.isError, true);
        assert.equal(JSON.parse(crossed.content[0].text).error.code, 'INVALID_OPERATION');
        const extensionChanges={...changes,operations:[
          {kind:'family_instance',key:'desk',typeId:'loaded-desk',point:{x:1200,y:2000},rotationDegrees:90},
          {kind:'dimension',key:'width',typeId:'linear',viewId:'plan',start:{x:0,y:-1000},end:{x:4000,y:-1000},stableReferences:['face-a','face-b']}]};
        const extension=await mcp.callTool({name:'preview_changes',arguments:{sessionId:descriptor.sessionId,...extensionChanges}});
        assert.equal(extension.isError,false);
        const bound=JSON.parse(extension.content[0].text).data;
        assert.equal(bound.changes.operations[0].rotationDegrees,90);
        assert.deepEqual(bound.changes.operations[1].stableReferences,['face-a','face-b']);
        assert.match(bound.approvalHash,/^[a-f0-9]{64}$/);
        const arbitrary = await mcp.callTool({ name: 'apply_change_set', arguments: { sessionId: descriptor.sessionId, code: 'anything' } });
        assert.equal(arbitrary.isError, true);
        const invalidApproval = await mcp.callTool({ name: 'approve_change_set', arguments: { sessionId: descriptor.sessionId, proposalId: randomUUID(), approvalHash: 'wrong', documentId: randomUUID(), expectedRevision: 0 } });
        assert.equal(invalidApproval.isError, true);
      } finally { await mcp.close(); }
    });
    await t.test('command route rejects unauthorized, malformed and oversized bodies', async () => {
      for (const [body, overrides, code] of [
        ['{}', { Authorization: 'Bearer invalid' }, 401],
        ['{broken', {}, 400],
        [JSON.stringify({ tool: 'preview_changes', arguments: {}, extra: true }), {}, 400],
        ['x'.repeat(65537), {}, 400],
      ]) {
        const response = await fetch(new URL('command', descriptor.baseUrl), { method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json', ...overrides }, body });
        assert.equal(response.status, code);
      }
    });
    await t.test('no-document errors are structured and busy operations expire', async () => {
      await host.mode('no-document');
      assert.equal((await client.call('document-context')).error.code, 'NO_ACTIVE_DOCUMENT');
      await host.mode('busy');
      assert.equal((await client.call('document-context')).error.code, 'REVIT_BUSY');
      await host.mode('normal');
      assert.equal((await client.call('document-context')).ok, true);
    });
    await t.test('port collisions recover and multiple sessions require explicit selection', async () => {
      const second = await startHost(directory, new URL(descriptor.baseUrl).port);
      try {
        await assert.rejects(client.call('health'), { code: 'AMBIGUOUS_SESSION' });
        assert.equal((await client.call('health', descriptor.sessionId)).ok, true);
        await assert.rejects(client.call('health', randomUUID()), { code: 'NO_SESSION' });
      } finally { await second.stop(); }
    });
    await t.test('malformed and off-machine discovery records are ignored', async () => {
      const id = randomUUID();
      await writeFile(join(directory, `${id}.json`), JSON.stringify({ ...descriptor, sessionId: id, baseUrl: 'https://example.com/' }));
      await writeFile(join(directory, `${randomUUID()}.json`), '{broken');
      assert.equal((await client.sessions()).length, 1);
    });
  } finally { await host.stop(); }
  assert.equal((await client.sessions()).length, 0);
  await assert.rejects(client.call('health'), { code: 'NO_SESSION' });
});

test('C# geometry, hash and durable journal checks (no Revit API)', async () => {
  const parent = join(root, 'artifacts/test-runs');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'contracts-'));
  const child = spawn('dotnet', [hostDll, '--contracts', directory]);
  let output = '';
  child.stdout.on('data', b => output += b);
  child.stderr.on('data', b => output += b);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
  assert.match(output, /contracts:passed/);
});

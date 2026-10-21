import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultSessionDirectory, type Descriptor } from './bridge.js';

// Real MCP client -> stdio server -> installed plugin. No mock fallback.
const client = new Client({ name: 'datumm-live-smoke', version: '0.2.0-alpha.1' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('./index.js', import.meta.url))], stderr: 'inherit' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  for (const required of ['get_document_context', 'get_revit_health', 'list_revit_sessions']) assert.ok(tools.includes(required));
  const observations: Record<string, unknown> = { observedAt: new Date().toISOString(), tools };
  for (const name of ['list_revit_sessions', 'get_revit_health', 'get_document_context']) {
    const result = await client.callTool({ name, arguments: {} });
    console.log(JSON.stringify({ tool: name, result }));
    assert.notEqual(result.isError, true, `${name} failed`);
    const content = result.content as Array<{ type: string; text?: string }>;
    const value: unknown = JSON.parse(content[0]?.text ?? 'null');
    observations[name] = value;
  }
  const sessions = observations.list_revit_sessions as Array<{ sessionId: string }>;
  assert.equal(sessions.length, 1, 'Select a single Revit session for this smoke scenario.');
  const firstContext = observations.get_document_context as { data: { documentId: string } };
  for (let attempt = 0; attempt < 3; attempt++) {
    const repeated = await client.callTool({ name: 'get_document_context', arguments: { sessionId: sessions[0]!.sessionId } });
    assert.notEqual(repeated.isError, true);
    const blocks = repeated.content as Array<{ text?: string }>;
    const context = JSON.parse(blocks[0]?.text ?? 'null') as { data: { documentId: string } };
    assert.equal(context.data.documentId, firstContext.data.documentId, 'Document identity changed between consecutive API reads.');
  }
  observations.identityCheck = { consecutiveReads: 4, stable: true };
  const directory = process.env.DATUMM_SESSION_DIR ?? defaultSessionDirectory();
  const filename = (await readdir(directory)).find(name => name === `${sessions[0]!.sessionId}.json`);
  assert.ok(filename);
  const descriptor = JSON.parse(await readFile(join(directory, filename), 'utf8')) as Descriptor;
  const invalidToken = await fetch(new URL('health', descriptor.baseUrl), {
    headers: { Authorization: 'Bearer deliberately-invalid' }, signal: AbortSignal.timeout(3000),
  });
  assert.equal(invalidToken.status, 401);
  assert.equal((await invalidToken.json() as { error: { code: string } }).error.code, 'UNAUTHORIZED');
  const wrongSession = await fetch(new URL('health', descriptor.baseUrl), {
    headers: { Authorization: `Bearer ${descriptor.token}`, 'X-Datumm-Protocol': '1', 'X-Datumm-Session': 'wrong-session' },
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(wrongSession.status, 409);
  assert.equal((await wrongSession.json() as { error: { code: string } }).error.code, 'SESSION_MISMATCH');
  observations.securityChecks = { invalidTokenRejected: true, wrongSessionRejected: true };
  console.log(JSON.stringify({ securityChecks: observations.securityChecks, result: 'PASS' }));
  if (process.argv.includes('--report')) {
    const reportDirectory = fileURLToPath(new URL('../../artifacts/live-evidence/', import.meta.url));
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(join(reportDirectory, 'phase1-live.json'), JSON.stringify(observations, null, 2));
  }
} finally { await client.close(); }

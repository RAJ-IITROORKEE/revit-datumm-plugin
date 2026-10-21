import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Diagnostic MCP client, not a bypass: invokes only server-advertised tools and their validation.
// Usage: pinned-node revit-mcp/dist/invoke.js tool-name [arguments.json]
const [name, path] = process.argv.slice(2);
if (!name) throw new Error('Specify a named MCP tool and optional JSON argument file.');
const client = new Client({ name: 'datumm-local-tool-client', version: '0.2.0-alpha.1' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./index.js', import.meta.url))], stderr: 'inherit' }));
  if (!(await client.listTools()).tools.some(tool => tool.name === name)) throw new Error('Unknown tool.');
  const result = await client.callTool({ name, arguments: path ? JSON.parse(await readFile(path, 'utf8')) : {} }, undefined, { timeout: 30000 });
  for (const block of result.content as Array<{ type: string; text?: string }>) if (block.type === 'text') console.log(block.text);
  if (result.isError) process.exitCode = 1;
} finally { await client.close(); }

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const payload = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(payload)) throw Error('Payload directory is required.');

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const expectedVersions = [
  readJson(join(payload, 'revit-mcp/package.json')).dependencies?.['@modelcontextprotocol/sdk'],
  readJson(join(payload, 'apps/connector/package.json')).dependencies?.['@modelcontextprotocol/sdk'],
];
if (expectedVersions.some(version => typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) ||
    new Set(expectedVersions).size !== 1) {
  throw Error('MCP SDK dependencies must use the same exact version in both runtime packages.');
}
const expectedVersion = expectedVersions[0];
const entryModules = new Map([
  ['revit-mcp/dist/index.js', ['@modelcontextprotocol/sdk/server/mcp.js', '@modelcontextprotocol/sdk/server/stdio.js']],
  ['apps/connector/src/index.mjs', ['@modelcontextprotocol/sdk/client/index.js', '@modelcontextprotocol/sdk/client/stdio.js']],
]);
const resolvedPackages = new Set();
for (const [relativeEntry, modules] of entryModules) {
  const entry = join(payload, relativeEntry);
  const requireFromEntry = createRequire(entry);
  for (const specifier of modules) {
    const resolvedEntry = requireFromEntry.resolve(specifier);
    let directory = dirname(resolvedEntry), packageJson;
    while (directory !== dirname(directory)) {
      const candidate = join(directory, 'package.json');
      if (existsSync(candidate)) {
        const manifest = readJson(candidate);
        if (manifest.name === '@modelcontextprotocol/sdk') {
          packageJson = candidate;
          if (manifest.version !== expectedVersion) {
            throw Error(`${relativeEntry} resolves MCP SDK ${manifest.version}; expected ${expectedVersion}.`);
          }
          break;
        }
      }
      directory = dirname(directory);
    }
    if (!packageJson || !resolve(packageJson).startsWith(payload + sep)) {
      throw Error(`${relativeEntry} does not resolve ${specifier} from inside the release payload.`);
    }
    resolvedPackages.add(resolve(packageJson));
  }
}

for (const relativePackage of [
  'node_modules/@modelcontextprotocol/sdk/package.json',
  'revit-mcp/node_modules/@modelcontextprotocol/sdk/package.json',
  'apps/connector/node_modules/@modelcontextprotocol/sdk/package.json',
]) {
  const path = join(payload, relativePackage);
  if (existsSync(path)) {
    const manifest = readJson(path);
    if (manifest.version !== expectedVersion) {
      throw Error(`${relativePackage} ships MCP SDK ${manifest.version}; expected ${expectedVersion}.`);
    }
  }
}
if (resolvedPackages.size === 0) {
  throw Error('No MCP SDK copy was resolved from the release payload.');
}

const mcpEntry = join(payload, 'revit-mcp/dist/index.js');
const mcpRequire = createRequire(mcpEntry);
const [{ Client }, { StdioClientTransport }] = await Promise.all([
  import(pathToFileURL(mcpRequire.resolve('@modelcontextprotocol/sdk/client/index.js'))),
  import(pathToFileURL(mcpRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js'))),
]);
const client = new Client({ name: 'datumm-release-check', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpEntry] }));
try {
  const { tools } = await client.listTools();
  const preview = tools.find(tool => tool.name === 'preview_changes');
  if (tools.length !== 18 || !preview || !JSON.stringify(preview.inputSchema).includes('set_room_metadata')) {
    throw Error(`Release MCP server returned ${tools.length} tools or preview_changes omitted set_room_metadata.`);
  }
} finally {
  await client.close();
}

const connectorEntry = join(payload, 'apps/connector/src/index.mjs');
const scratch = await mkdtemp(join(tmpdir(), 'datumm-connector-smoke-'));
try {
  const smoke = spawnSync(process.execPath, [connectorEntry], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, LOCALAPPDATA: scratch, DATUMM_MCP_ENTRY: mcpEntry },
  });
  const output = `${smoke.stdout ?? ''}\n${smoke.stderr ?? ''}`;
  if (smoke.error || smoke.status !== 1 || !output.includes('Pair first:')) {
    throw Error('Release connector startup did not reach its expected unauthenticated pairing gate.');
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log(`Payload runtime verified: @modelcontextprotocol/sdk ${expectedVersion} across ${resolvedPackages.size} runtime copies, MCP tools listed, connector pairing gate reached.`);

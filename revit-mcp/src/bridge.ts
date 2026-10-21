import { readFile, readdir, lstat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { validCommandResponse } from './drafting.js';

const schema = JSON.parse(readFileSync(new URL('../../contracts/phase1.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false });
ajv.addSchema(schema);
const validate = (name: string, value: unknown) => {
  if (!ajv.validate(`${schema.$id}#/definitions/${name}`, value))
    throw new BridgeError('INVALID_RESPONSE', `Invalid ${name} contract.`);
};

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export interface Descriptor {
  protocolVersion: string; sessionId: string; processId: number; baseUrl: string;
  token: string; pluginVersion: string; revitVersion: string; startedAt: string;
}
export interface Envelope {
  protocolVersion: string; sessionId: string; operationId: string; ok: boolean;
  data: Record<string, unknown> | null; error: { code: string; message: string } | null;
}
export type Session = Omit<Descriptor, 'token' | 'baseUrl'>;

export function defaultSessionDirectory(): string {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new BridgeError('UNSUPPORTED_PLATFORM', 'LOCALAPPDATA is required on Windows.');
  return join(local, 'DatummAgent', 'sessions');
}

export class BridgeClient {
  constructor(private readonly directory = process.env.DATUMM_SESSION_DIR ?? defaultSessionDirectory(),
    private readonly timeoutMs = 12000) {}

  private async descriptors(): Promise<Descriptor[]> {
    let files: string[];
    try {
      const directoryInfo = await lstat(this.directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
        throw new BridgeError('INVALID_DISCOVERY', 'Session directory must be a real directory.');
      files = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (files.length > 256) throw new BridgeError('INVALID_DISCOVERY', 'Too many discovery entries.');
    const results: Descriptor[] = [];
    for (const file of files.filter(name => /^[0-9a-f-]{36}\.json$/i.test(name))) {
      try {
        const path = join(this.directory, file);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) continue;
        const value: Descriptor = JSON.parse(await readFile(path, 'utf8'));
        validate('descriptor', value);
        if (file !== `${value.sessionId}.json`) continue;
        const url = new URL(value.baseUrl);
        if (!url.port || Number(url.port) < 1024 || Number(url.port) > 65535) continue;
        results.push(value);
      } catch { /* Ignore malformed/incomplete/stale discovery entries. Never print credentials. */ }
    }
    return results;
  }

  async request(descriptor: Descriptor, route: 'health' | 'document-context' | 'command', timeoutMs = this.timeoutMs, payload?: unknown): Promise<Envelope> {
    validate('descriptor', descriptor);
    const operationId = randomUUID();
    try {
      const response = await fetch(new URL(route, descriptor.baseUrl), {
        method: route === 'command' ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        body: payload === undefined ? undefined : JSON.stringify(payload),
        headers: {
          Authorization: `Bearer ${descriptor.token}`,
          'X-Datumm-Protocol': '1', 'X-Datumm-Session': descriptor.sessionId,
          'X-Operation-Id': operationId,
          ...(route === 'command' ? { 'Content-Type': 'application/json' } : {}),
        },
      });
      // Stream with a hard byte limit; never buffer an arbitrary local response.
      const reader = response.body?.getReader();
      if (!reader) throw new BridgeError('INVALID_RESPONSE', 'Plugin returned an empty response.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        const commandTool = route === 'command' ? (payload as {tool:string})?.tool : '';
        const responseLimit = ['get_plan_image','get_plan_snapshot','get_model_elements','get_operation_status','apply_change_set','preview_changes'].includes(commandTool) ? 2_100_000 : 131072;
        if (size > responseLimit) {
          await reader.cancel();
          throw new BridgeError('INVALID_RESPONSE', 'Plugin response exceeded the limit.');
        }
        chunks.push(chunk.value);
      }
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Envelope;
      validate('envelope', envelope);
      if (envelope.sessionId !== descriptor.sessionId || envelope.operationId !== operationId)
        throw new BridgeError('SESSION_MISMATCH', 'Plugin response identity does not match the request.');
      if (envelope.ok !== response.ok)
        throw new BridgeError('INVALID_RESPONSE', 'Plugin status is inconsistent.');
      if (envelope.ok && route !== 'command') validate(route === 'health' ? 'health' : 'documentContext', envelope.data);
      if (envelope.ok && route === 'command' && !validCommandResponse((payload as { tool: string }).tool, envelope.data))
        throw new BridgeError('INVALID_RESPONSE', 'Command response failed validation. Query operation status before retrying writes.');
      if (envelope.ok && route === 'command' && (payload as {tool:string}).tool === 'get_native_capabilities') {
        const requested = (payload as {arguments?:{mirrorProbe?:{documentId:string;expectedRevision:number;levelId:string;viewId:string;elementIds:string[]}}}).arguments?.mirrorProbe;
        const probe = envelope.data?.mirrorProbe as {documentId:string;revision:number;levelId:string;viewId:string;elementIds:string[]} | undefined;
        if (requested ? !probe || probe.documentId !== requested.documentId || probe.revision !== requested.expectedRevision ||
            probe.documentId !== envelope.data?.documentId || probe.revision !== envelope.data?.revision ||
            probe.levelId !== requested.levelId || probe.viewId !== requested.viewId || JSON.stringify(probe.elementIds) !== JSON.stringify(requested.elementIds)
            : probe !== undefined)
          throw new BridgeError('INVALID_RESPONSE', 'Mirror eligibility response does not match the exact probe; no reflection was executed. Install the matching bridge if the probe is unavailable.');
      }
      return envelope;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
        throw new BridgeError('TIMEOUT', 'Request timed out. For writes query the same operation ID; do not blindly retry.');
      throw new BridgeError('UNREACHABLE', 'Could not read plugin response. For writes query operation status before any retry.');
    }
  }

  async sessions(): Promise<Session[]> {
    const candidates = await this.descriptors();
    const checks = await Promise.all(candidates.map(async descriptor => {
      try {
        const result = await this.request(descriptor, 'health', 1500);
        if (!result.ok || result.data?.processId !== descriptor.processId) return null;
        const { token: _token, baseUrl: _url, ...safe } = descriptor;
        return safe;
      } catch { return null; }
    }));
    return checks.filter((value): value is Session => value !== null);
  }

  async call(route: 'health' | 'document-context' | 'command', sessionId?: string, payload?: unknown): Promise<Envelope> {
    const live = await this.sessions();
    if (!sessionId && live.length > 1)
      throw new BridgeError('AMBIGUOUS_SESSION', 'Multiple Revit sessions are connected; provide a sessionId.');
    const session = sessionId ? live.find(item => item.sessionId === sessionId) : live[0];
    if (!session) throw new BridgeError('NO_SESSION', 'No matching DATUMM session. Start Revit and enable DATUMM.');
    const descriptor = (await this.descriptors()).find(item => item.sessionId === session.sessionId);
    if (!descriptor) throw new BridgeError('NO_SESSION', 'The selected session disconnected.');
    if (route === 'command') {
      const command = payload as {tool:string;arguments?:{kind?:string;operations?:{kind:string}[];viewId?:string;phaseId?:string;elementIds?:string[];region?:unknown}};
      if(command.tool==='show_model_elements'||command.tool==='get_model_elements'&&(command.arguments?.elementIds||command.arguments?.region)){
        const manifest=await this.request(descriptor,'command',25000,{tool:'get_native_capabilities',arguments:{}});
        if(!manifest.ok||manifest.data?.inspectionSchemaVersion!==2)throw new BridgeError('UPGRADE_REQUIRED','Install the matching P9 Revit bridge before targeted queries or selection.');
      }
      const extended = ['get_native_capabilities','get_dimension_references'].includes(command.tool) ||
        !!command.arguments?.viewId && command.tool === 'get_model_elements' ||
        !!command.arguments?.phaseId && command.tool === 'get_model_elements' ||
        command.tool === 'get_model_views' && command.arguments?.kind === 'room-color-schemes' ||
        command.tool === 'preview_changes' && command.arguments?.operations?.some(op=>['dimension','family_instance','set_room_color_scheme'].includes(op.kind));
      const roomColorContract = command.tool === 'get_model_views' && command.arguments?.kind === 'room-color-schemes' ||
        command.tool === 'preview_changes' && command.arguments?.operations?.some(op=>op.kind === 'set_room_color_scheme');
      if (roomColorContract && !extended) throw new BridgeError('UPGRADE_REQUIRED','Install the matching MCP and Revit bridge before using room color schemes.');
      if (extended) {
        const health = await this.request(descriptor,'health');
        if (!Array.isArray(health.data?.capabilities) || !health.data.capabilities.includes('get_native_capabilities'))
          throw new BridgeError('UPGRADE_REQUIRED','Install the matching M07 MCP, connector and Revit plugin before using these tools.');
        if (command.tool === 'preview_changes' || roomColorContract) {
          const manifest = await this.request(descriptor,'command',25000,{tool:'get_native_capabilities',arguments:{}});
          const version=manifest.data?.operationSchemaVersion;
          const operations=command.tool === 'preview_changes' ? command.arguments?.operations : [];
          if (!manifest.ok || ![2,3].includes(version as number) || roomColorContract && version !== 3 ||
            !Array.isArray(manifest.data?.operationKinds) ||
            roomColorContract && !(manifest.data!.operationKinds as string[]).includes('set_room_color_scheme') ||
            operations?.some(op=>!(manifest.data!.operationKinds as string[]).includes(op.kind)))
            throw new BridgeError('UPGRADE_REQUIRED','Installed plugin does not support this exact operation contract.');
        }
      }
    }
    return this.request(descriptor, route, route === 'command' ? 25000 : this.timeoutMs, payload);
  }
}

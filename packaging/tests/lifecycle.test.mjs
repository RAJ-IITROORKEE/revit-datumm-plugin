import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {activate,deactivate,verifyRelease,parseRevitCompatibility,assertRevitCompatibility} from '../lifecycle.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const compatibility=parseRevitCompatibility(JSON.parse(await readFile(new URL('../release.json',import.meta.url),'utf8')).revitCompatibility);
async function fixture(version='0.4.0-alpha.1'){
 const parent=resolve('artifacts/installer-tests');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'run-'));
 const root=join(dir,'app'),addins=join(dir,'addins'),releaseDir=join(root,'releases',version);await mkdir(addins,{recursive:true});await mkdir(releaseDir,{recursive:true});
 const bytes=Buffer.from('fixture');await writeFile(join(releaseDir,'fixture.txt'),bytes);await writeFile(join(releaseDir,'release-manifest.json'),JSON.stringify({product:'datumm-agent',version,componentVersion:'0.2.0-alpha.1',files:[{path:'fixture.txt',size:bytes.length,sha256:sha(bytes)}]}));
 return {root,addins,releaseDir,guard:async()=>{}};
}
async function development(ctx){const dll=join(ctx.addins,'DatummAgentDev','Datumm.Revit.dll');await mkdir(join(ctx.addins,'DatummAgentDev'),{recursive:true});await writeFile(join(ctx.addins,'DatummAgentDev','installation.json'),JSON.stringify({owner:'datumm-agent-dev'}));const xml=`<Assembly>${dll}</Assembly><AddInId>F39C9CF1-DB15-47F7-AC4E-6B64F7CA0548</AddInId><FullClassName>Datumm.Revit.Application</FullClassName>`;await writeFile(join(ctx.addins,'DatummAgentDev.addin'),xml);return xml;}
test('Revit API compatibility accepts this annual range and rejects other or malformed versions',()=>{
 for(const version of ['26.0.4.409','26.1.0.0','26.4.0.32','26.5.0.0','26.9.0.0'])assert.doesNotThrow(()=>assertRevitCompatibility('install',version,compatibility));
 for(const version of ['26.0.0.0','26.0.4.0','25.9.9.9','27.0.0.0'])assert.throws(()=>assertRevitCompatibility('check',version,compatibility),/supports Revit 2026/);
 for(const version of ['26.5.0','v26.5.0.0','26.5.0.x'])assert.throws(()=>assertRevitCompatibility('install',version,compatibility),/malformed/);
});
test('uninstall compatibility preflight does not require an installed Revit API',()=>{
 assert.doesNotThrow(()=>assertRevitCompatibility('check-uninstall',undefined,compatibility));
 assert.doesNotThrow(()=>assertRevitCompatibility('uninstall',undefined,compatibility));
});
test('first install, idempotent upgrade and uninstall restore only owned development manifest',async()=>{
 const ctx=await fixture(),original=await development(ctx);await writeFile(join(ctx.addins,'Other.addin'),'unrelated');
 const installed=await activate(ctx);assert.equal(installed.migratedDevelopmentAddin,true);await assert.rejects(access(join(ctx.addins,'DatummAgentDev.addin')));
 await activate(ctx);assert.match(await readFile(join(ctx.addins,'DatummAgent.addin'),'utf8'),/Datumm.Revit.dll/);
 await deactivate(ctx);assert.equal(await readFile(join(ctx.addins,'DatummAgentDev.addin'),'utf8'),original);assert.equal(await readFile(join(ctx.addins,'Other.addin'),'utf8'),'unrelated');await assert.rejects(access(join(ctx.root,'installation.json')));
});
test('injected activation failure restores all previous state',async()=>{
 const ctx=await fixture(),original=await development(ctx);ctx.fault=n=>{if(n===3)throw Error('simulated failure');};await assert.rejects(activate(ctx),/simulated failure/);
 assert.equal(await readFile(join(ctx.addins,'DatummAgentDev.addin'),'utf8'),original);await assert.rejects(access(join(ctx.addins,'DatummAgent.addin')));await assert.rejects(access(join(ctx.addins,'DatummAgentDev.addin.datumm-backup')));await assert.rejects(access(join(ctx.root,'activation-pending.json')));
});
test('tampered payload and path traversal are rejected before registration',async()=>{
 const ctx=await fixture();await writeFile(join(ctx.releaseDir,'fixture.txt'),'tampered');await assert.rejects(activate(ctx),/Payload verification/);
 const file=join(ctx.releaseDir,'release-manifest.json'),data=JSON.parse(await readFile(file));data.files[0].path='../escape';await writeFile(file,JSON.stringify(data));await assert.rejects(verifyRelease(ctx.releaseDir),/Unsafe/);
});
test('guard rejects running Revit before any installation work',async()=>{
 const ctx=await fixture();ctx.guard=async()=>{throw Error('Revit running');};await assert.rejects(activate(ctx),/Revit running/);await assert.rejects(access(join(ctx.addins,'DatummAgent.addin')));
});
test('unmanaged/modified manifests are preserved',async()=>{
 const ctx=await fixture();await writeFile(join(ctx.addins,'DatummAgent.addin'),'user content');await assert.rejects(activate(ctx),/unmanaged/);assert.equal(await readFile(join(ctx.addins,'DatummAgent.addin'),'utf8'),'user content');
});
test('modified installed manifest blocks uninstall; edited config is preserved',async()=>{
 const ctx=await fixture();await activate(ctx);const p=join(ctx.addins,'DatummAgent.addin'),original=await readFile(p);await writeFile(p,'changed');await assert.rejects(deactivate(ctx),/modified/);await writeFile(p,original);
 await writeFile(join(ctx.root,'mcp-config.toml'),'user edited');await deactivate(ctx);assert.equal(await readFile(join(ctx.root,'mcp-config.toml'),'utf8'),'user edited');
});
test('rollback restores the previous active version when an upgrade fails',async()=>{
 const ctx=await fixture();await activate(ctx);const original=await readFile(join(ctx.root,'installation.json'),'utf8');const oldManifest=await readFile(join(ctx.addins,'DatummAgent.addin'),'utf8');
 const next=join(ctx.root,'releases','0.4.0-alpha.2');await mkdir(next);await writeFile(join(next,'fixture.txt'),'fixture');const manifest=JSON.parse(await readFile(join(ctx.releaseDir,'release-manifest.json')));manifest.version='0.4.0-alpha.2';await writeFile(join(next,'release-manifest.json'),JSON.stringify(manifest));
 await assert.rejects(activate({...ctx,releaseDir:next,fault:n=>{if(n===2)throw Error('upgrade failure');}}),/upgrade failure/);assert.equal(await readFile(join(ctx.root,'installation.json'),'utf8'),original);assert.equal(await readFile(join(ctx.addins,'DatummAgent.addin'),'utf8'),oldManifest);
 await activate({...ctx,releaseDir:next});await assert.rejects(activate(ctx),/Downgrades/);
});

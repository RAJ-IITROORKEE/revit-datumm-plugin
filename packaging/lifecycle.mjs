import {readFile,writeFile,mkdir,rename,unlink,lstat,open} from 'node:fs/promises';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const owner='datumm-agent-packaged';
const guid='F39C9CF1-DB15-47F7-AC4E-6B64F7CA0548';
const hash=b=>createHash('sha256').update(b).digest('hex');
const missing=e=>e.code==='ENOENT';
async function optional(path){try{return await readFile(path);}catch(e){if(missing(e))return null;throw e;}}
async function atomic(path,bytes){await mkdir(dirname(path),{recursive:true});const temp=path+'.'+randomUUID()+'.tmp';try{await writeFile(temp,bytes);await rename(temp,path);}finally{await unlink(temp).catch(e=>{if(!missing(e))throw e;});}}
export async function noLinks(path){for(let p=resolve(path);;p=dirname(p)){try{if((await lstat(p)).isSymbolicLink())throw Error('Installation paths cannot contain links or junctions.');}catch(e){if(!missing(e))throw e;}if(dirname(p)===p)break;}}
function paths(ctx){return {state:join(ctx.root,'installation.json'),journal:join(ctx.root,'activation-pending.json'),manifest:join(ctx.addins,'DatummAgent.addin'),dev:join(ctx.addins,'DatummAgentDev.addin'),backup:join(ctx.addins,'DatummAgentDev.addin.datumm-backup'),json:join(ctx.root,'mcp-config.json'),toml:join(ctx.root,'mcp-config.toml')};}
async function stateAt(p){const bytes=await optional(p.state);if(!bytes)return null;const state=JSON.parse(bytes);if(state.owner!==owner)throw Error('Installation directory is not owned by DATUMM.');return state;}
async function restore(ctx,p){const bytes=await optional(p.journal);if(!bytes)return;const journal=JSON.parse(bytes);const allowed=new Set([p.state,p.manifest,p.dev,p.backup,p.json,p.toml]);if(journal.owner!==owner||!Array.isArray(journal.before)||journal.before.some(x=>!allowed.has(x.path)||!(x.content===null||typeof x.content==='string')))throw Error('Unrecognized activation journal; manual recovery is required.');for(const item of [...journal.before].reverse()){if(item.content===null)await unlink(item.path).catch(e=>{if(!missing(e))throw e;});else await atomic(item.path,Buffer.from(item.content,'base64'));}await unlink(p.journal);}
async function transact(ctx,p,changes){const before=[];for(const path of changes.keys()){const b=await optional(path);before.push({path,content:b?.toString('base64')??null});}await atomic(p.journal,JSON.stringify({owner,before}));try{let index=0;for(const [path,bytes] of changes){if(bytes===null)await unlink(path).catch(e=>{if(!missing(e))throw e;});else await atomic(path,bytes);ctx.fault?.(++index);}await unlink(p.journal);}catch(e){await restore(ctx,p);throw e;}}
async function guarded(ctx,action){await ctx.guard();await noLinks(ctx.root);await noLinks(ctx.addins);await mkdir(ctx.root,{recursive:true});const lockPath=join(ctx.root,'.installation-lock');let lock;try{lock=await open(lockPath,'wx');}catch(e){if(e.code==='EEXIST')throw Error('Installation lock exists. Another installer may be active; inspect before removing it.');throw e;}try{const p=paths(ctx);await restore(ctx,p);return await action(p);}finally{await lock.close();await unlink(lockPath);}}
function escapeXml(s){return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');}
function versionTuple(s){if(!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(s))throw Error('Unsupported package version.');return s.split(/\D+/).map(Number);}
function older(a,b){const x=versionTuple(a),y=versionTuple(b);for(let i=0;i<x.length;i++){if(x[i]!==y[i])return x[i]<y[i];}return false;}
function apiVersionTuple(s){if(typeof s!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(s))throw Error('Installed Revit API version is malformed.');const parts=s.split('.').map(Number);if(parts.some(n=>!Number.isSafeInteger(n)))throw Error('Installed Revit API version is malformed.');return parts;}
function compareApiVersions(a,b){for(let i=0;i<a.length;i++){if(a[i]!==b[i])return a[i]-b[i];}return 0;}
export function parseRevitCompatibility(policy){
 if(!policy||!Number.isSafeInteger(policy.year)||policy.year<2000)throw Error('Invalid Revit compatibility metadata.');
 let minimum,maximumExclusive;try{minimum=apiVersionTuple(policy.minimumApiVersion);maximumExclusive=apiVersionTuple(policy.maximumApiVersionExclusive);}catch{throw Error('Invalid Revit compatibility metadata.');}
 const major=policy.year-2000;
 if(minimum[0]!==major||maximumExclusive[0]!==major+1||maximumExclusive.slice(1).some(n=>n!==0)||compareApiVersions(minimum,maximumExclusive)>=0)throw Error('Invalid Revit compatibility metadata.');
 return {year:policy.year,minimumApiVersion:policy.minimumApiVersion,maximumApiVersionExclusive:policy.maximumApiVersionExclusive,minimum,maximumExclusive};
}
export function assertRevitCompatibility(mode,installedVersion,compatibility){
 if(!['check','install'].includes(mode))return;
 compatibility=parseRevitCompatibility(compatibility);
 const installed=apiVersionTuple(installedVersion);
 if(compareApiVersions(installed,compatibility.minimum)<0||compareApiVersions(installed,compatibility.maximumExclusive)>=0)throw Error(`This package supports Revit ${compatibility.year} API versions ${compatibility.minimumApiVersion} up to but not including ${compatibility.maximumApiVersionExclusive}.`);
}
export async function verifyRelease(releaseDir){const release=JSON.parse(await readFile(join(releaseDir,'release-manifest.json'),'utf8'));if(release.product!=='datumm-agent'||!Array.isArray(release.files))throw Error('Invalid release manifest.');versionTuple(release.version);for(const f of release.files){if(typeof f.path!=='string'||f.path.includes('\\')||f.path.split('/').some(p=>p==='..'||p==='.'||!p)||isAbsolute(f.path))throw Error('Unsafe release path.');const path=resolve(releaseDir,f.path);if(relative(releaseDir,path).startsWith('..'))throw Error('Release path escape.');await noLinks(path);const bytes=await readFile(path);if(bytes.length!==f.size||hash(bytes)!==f.sha256)throw Error('Payload verification failed: '+f.path);}return release;}
export async function activate(ctx){return guarded(ctx,async p=>{
 const release=await verifyRelease(ctx.releaseDir);const old=await stateAt(p);
 if(old&&older(release.version,old.version))throw Error('Downgrades are not supported.');
 const existing=await optional(p.manifest);if(existing&&(!old||hash(existing)!==old.manifestHash))throw Error('Existing add-in manifest is unmanaged or modified; refusing to overwrite.');
 if(old){for(const path of [p.json,p.toml]){const bytes=await optional(path);if(bytes&&hash(bytes)!==old.configHashes[path])throw Error('Generated MCP config was modified; preserve edits before upgrading.');}}
 const dev=await optional(p.dev);let devHash=old?.devHash??null;const changes=new Map();
 if(dev){const marker=JSON.parse(await readFile(join(ctx.addins,'DatummAgentDev','installation.json'),'utf8'));const xml=dev.toString('utf8');const match=xml.match(/<Assembly>(.*?)<\/Assembly>/s);const decoded=match?.[1].replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"');if(marker.owner!=='datumm-agent-dev'||!xml.includes(guid)||!xml.includes('Datumm.Revit.Application')||!decoded||resolve(decoded)!==resolve(ctx.addins,'DatummAgentDev','Datumm.Revit.dll'))throw Error('Development add-in is not recognized; refusing migration.');if(await optional(p.backup))throw Error('Development manifest backup already exists.');devHash=hash(dev);changes.set(p.backup,dev);changes.set(p.dev,null);}
 const assembly=join(ctx.releaseDir,'plugin','Datumm.Revit.dll');
 const manifest=Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<RevitAddIns><AddIn Type="Application"><Name>DATUMM Agent Development</Name><Assembly>${escapeXml(assembly)}</Assembly><AddInId>${guid}</AddInId><FullClassName>Datumm.Revit.Application</FullClassName><VendorId>DATM</VendorId><VendorDescription>DATUMM approved local drafting tools</VendorDescription></AddIn></RevitAddIns>\n`);
 const node=join(ctx.releaseDir,'runtime','node.exe'),entry=join(ctx.releaseDir,'revit-mcp','dist','index.js');
 const json=Buffer.from(JSON.stringify({mcpServers:{datumm_revit:{command:node,args:[entry]}}},null,2)+'\n');
 const toml=Buffer.from(`[mcp_servers.datumm_revit]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(entry)}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 30\n`);
 changes.set(p.manifest,manifest);changes.set(p.json,json);changes.set(p.toml,toml);
 changes.set(p.state,Buffer.from(JSON.stringify({owner,version:release.version,componentVersion:release.componentVersion,releaseDir:ctx.releaseDir,payloadHash:hash(await readFile(join(ctx.releaseDir,'release-manifest.json'))),manifestHash:hash(manifest),devHash,configHashes:{[p.json]:hash(json),[p.toml]:hash(toml)}},null,2)));
 await transact(ctx,p,changes);return {version:release.version,migratedDevelopmentAddin:!!dev,configs:[p.json,p.toml]};
});}
export async function deactivate(ctx,{checkOnly=false}={}){return guarded(ctx,async p=>{
 const state=await stateAt(p);if(!state)throw Error('No managed installation record.');
 const manifest=await optional(p.manifest);if(manifest&&hash(manifest)!==state.manifestHash)throw Error('Add-in manifest was modified; refusing to delete.');
 const changes=new Map([[p.manifest,null]]);
 if(state.devHash){const backup=await optional(p.backup);if(!backup||hash(backup)!==state.devHash||await optional(p.dev))throw Error('Development manifest restore conflict.');changes.set(p.dev,backup);changes.set(p.backup,null);}
 for(const file of [p.json,p.toml]){const bytes=await optional(file);if(bytes&&hash(bytes)===state.configHashes[file])changes.set(file,null);}
 changes.set(p.state,null);if(!checkOnly)await transact(ctx,p,changes);return {restoredDevelopmentAddin:!!state.devHash};
});}

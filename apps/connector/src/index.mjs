import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';
import { observeConnection, keepConnectionAlive } from './connection-lifecycle.mjs';
import { decodeToolResult } from './tool-result.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const folder=join(process.env.LOCALAPPDATA??homedir(),'DatummAgent','connector');
const configFile=join(folder,'device.json');
const flag=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const url=new URL(flag('url')??process.env.DATUMM_ORCHESTRATOR_URL??'http://127.0.0.1:8000');
if(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('Cloud connector requires HTTPS.');
await mkdir(folder,{recursive:true});
if(process.platform==='win32')execFileSync('icacls',[folder,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`],{stdio:'ignore',windowsHide:true});
let config;
if(process.argv.includes('--authorize')){
 const verifier=randomBytes(48).toString('base64url');
 const response=await fetch(new URL('/v1/device-authorizations',url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:hostname(),challenge:createHash('sha256').update(verifier).digest('hex')})});
 if(!response.ok)throw new Error('Unable to start browser authorization.');
 const authorization=await response.json();
 const destination=new URL(authorization.verificationUri);
 if(destination.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(destination.hostname))throw new Error('Invalid browser authorization URL.');
 if(process.platform==='win32'){
  // ArgumentList-style invocation; the URI is never interpolated into shell code.
  const opener=spawn('rundll32.exe',['url.dll,FileProtocolHandler',destination.href],{windowsHide:true,stdio:'ignore'});opener.unref();
 }else console.log('Open the dashboard authorization URL:',destination.href);
 console.log('Waiting for browser sign-in and device authorization.');
 const deadline=Date.now()+300000;
 while(Date.now()<deadline){
  await new Promise(resolve=>setTimeout(resolve,3000));
  const claim=await fetch(new URL(`/v1/device-authorizations/${authorization.requestId}/token`,url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({verifier})});
  if(claim.status===202)continue;
  if(!claim.ok)throw new Error('Device authorization expired or was rejected.');
  config={...await claim.json(),url:url.origin};break;
 }
 if(!config)throw new Error('Device authorization timed out. Try again.');
 await writeFile(configFile,JSON.stringify(config),{mode:0o600});
 console.log('Device authorized.');
}else if(flag('pair')){
 const response=await fetch(new URL('/v1/pairing/claim',url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:flag('pair'),name:hostname()})});
 if(!response.ok)throw new Error('Pairing code rejected. Generate a fresh code in the dashboard.');
 config={...await response.json(),url:url.origin};
 await writeFile(configFile,JSON.stringify(config),{mode:0o600});
 console.log('Device paired. Credentials stored in the current-user connector directory.');
}else{
 try{config=JSON.parse(await readFile(configFile,'utf8'));}catch{throw new Error('Pair first: --url=https://your-backend --pair=CODE');}
 if(config.url!==url.origin)throw new Error('This device credential belongs to a different server. Pair with the selected server first.');
}
let entry=process.env.DATUMM_MCP_ENTRY;
if(!entry){
 try{const installed=JSON.parse(await readFile(join(process.env.LOCALAPPDATA,'Programs','DatummAgent','installation.json'),'utf8'));entry=join(installed.releaseDir,'revit-mcp','dist','index.js');}
 catch{entry=join(root,'revit-mcp/dist/index.js');}
}
const client=new Client({name:'datumm-device-connector',version:'0.5.0-alpha.1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[entry],stderr:'inherit'}));
const allowed=new Set((await client.listTools()).tools.map(t=>t.name));
const variableBinderAvailable=existsSync(join(dirname(entry),'variable-bindings.js'));
async function call(name,args){
 if(!allowed.has(name))throw new Error('Unsupported MCP tool.');
 const result=await client.callTool({name,arguments:args},undefined,{timeout:35000});
 return decodeToolResult(name,args,result);
}
async function compile(args,saved=false){
 if(Object.keys(args).some(k=>k!=='sessionId'&&!(saved&&k==='layout'))||typeof args.sessionId!=='string')throw new Error('Invalid compile arguments');
 const catalog=(await call('get_model_catalog',{sessionId:args.sessionId,limit:100})).data;
 if(catalog.nextOffset!==null)throw new Error('Large type catalogs need an explicit binding selection.');
 const metric=catalog.types.some(t=>t.kind==='wall'&&t.name==='Generic - 150mm');
 const type=(kind,name,family)=>{
  const matches=catalog.types.filter(t=>t.kind===kind&&t.name===name&&(!family||t.family===family));
  if(matches.length!==1)throw new Error(`Required unique type missing: ${kind} ${name}`);return matches[0].id;
 };
 const level=catalog.levels.find(l=>l.name==='L1');if(!level)throw new Error('Demonstration requires an L1 level.');
 const layout=saved?structuredClone(args.layout):JSON.parse(await readFile(join(root,'fixtures/3bhk/layout.json'),'utf8'));
 if(saved && layout.wallThicknessMm!==(metric?150:152.4))throw new Error('Saved plan wall thickness does not match this template. Regenerate for the connected project.');
 if(metric&&!saved){layout.wallThicknessMm=150;for(const o of layout.openings){o.widthMm=o.type==='smallWindow'?600:900;o.heightMm=o.kind==='door'?2100:o.type==='smallWindow'?900:1200;}}
 const bindings={documentId:catalog.documentId,revision:catalog.revision,levelId:level.id,
 wall:type('wall',metric?'Generic - 150mm':'Generic - 6"'),floor:type('floor',metric?'Concrete 150mm':'Concrete 4"'),
 door:type('door',metric?'900 x 2100mm':'36" x 80"',metric?'M_Door-Passage-Single-Flush':'Door-Passage-Single-Flush'),
 window:type('window',metric?'900 x 1200mm':'36" x 48"',metric?'M_Window-Fixed':'Window-Fixed'),
 smallWindow:type('window',metric?'600 x 900mm':'24" x 36"',metric?'M_Window-Fixed':'Window-Fixed')};
 const {compileLayout}=await import(pathToFileURL(join(dirname(entry),'layout.js')).href);
 return {...compileLayout(layout,bindings),areaToleranceM2:layout.areaToleranceM2};
}
async function compileVariable(args){
 if(!variableBinderAvailable)throw new Error('Variable graph binding is unavailable in this connector installation.');
 const capability=(await call('get_native_capabilities',{sessionId:args?.sessionId})).data;
 if(capability.roomTagPolicy!=='explicit-reviewed-operations')
  throw Error('UPGRADE_REQUIRED: Install the M08 package before native Plan Build preparation.');
 if(!args||Object.keys(args).some(k=>!['sessionId','graph','expectedDocumentId','expectedRevision','placement'].includes(k))||
    typeof args.sessionId!=='string'||typeof args.expectedDocumentId!=='string'||
    !Number.isSafeInteger(args.expectedRevision)||!args.graph)throw new Error('Invalid variable compile arguments.');
 let offset=0,full=null;
 for(let page=0;page<4;page++){
  const response=(await call('get_model_catalog',{sessionId:args.sessionId,offset,limit:100})).data;
  if(response.documentId!==args.expectedDocumentId||response.revision!==args.expectedRevision)
   throw new Error('Catalog document or revision changed; re-inspect before compiling.');
  if(!full)full={...response,types:[]};
  else if(response.totalTypes!==full.totalTypes||JSON.stringify(response.levels)!==JSON.stringify(full.levels))
   throw new Error('Catalog changed between pages.');
  if(response.types.length>100||response.nextOffset!==null&&response.nextOffset!==offset+response.types.length)
   throw new Error('Catalog paging is incomplete or inconsistent.');
  full.types.push(...response.types);
  if(response.nextOffset===null){full.nextOffset=null;break;}
  offset=response.nextOffset;
 }
 if(!full||full.nextOffset!==null||full.types.length!==full.totalTypes)
  throw new Error('Native type catalog exceeds the supported four-page limit.');
 const plans=(await call('get_model_views',{sessionId:args.sessionId,kind:'plans',limit:100})).data;
 if(plans.documentId!==args.expectedDocumentId||plans.revision!==args.expectedRevision||plans.nextOffset!==null||
   !plans.plans.some(v=>v.id===args.placement?.viewId&&v.levelId===args.placement?.levelId))
   throw Error('PLACEMENT_VIEW_CHANGED: Refresh and confirm the exact host floor-plan view.');
 const {bindVariableGraph}=await import(pathToFileURL(join(dirname(entry),'variable-bindings.js')).href);
 return bindVariableGraph(args.graph,full,{sessionId:args.sessionId,
  expectedDocumentId:args.expectedDocumentId,expectedRevision:args.expectedRevision,placement:args.placement});
}
let stopped=false, socket;
process.on('SIGINT',()=>{stopped=true;socket?.close();client.close().finally(()=>process.exit(0));});
while(!stopped){
 const target=new URL('/v1/connector',url);target.protocol=url.protocol==='https:'?'wss:':'ws:';
 const connection=new WebSocket(target,{headers:{Authorization:`Bearer ${config.token}`},maxPayload:2*1024*1024});
 socket=connection;
 keepConnectionAlive(connection);
 let sequence=Promise.resolve();
 socket.on('open',()=>console.log('DATUMM connected. Close this process or revoke this device to disconnect.'));
 connection.on('message',buffer=>{sequence=sequence.then(async()=>{
  if(connection.readyState!==WebSocket.OPEN)return;
  let request;
  try{request=JSON.parse(buffer.toString());if(typeof request.id!=='string')throw new Error('Invalid request');
   if(request.name==='list_capabilities'&&Object.keys(request.arguments??{}).length)throw new Error('Invalid capability arguments.');
   const result=request.name==='list_capabilities'?{tools:[...allowed,...(variableBinderAvailable?['compile_variable_plan']:[])].sort(),connectorVersion:'0.5.0-alpha.20',nativeOperationSchemaVersion:allowed.has('get_native_capabilities')?2:1}:request.name==='compile_3bhk'?await compile(request.arguments):request.name==='compile_saved_plan'?await compile(request.arguments,true):request.name==='compile_variable_plan'?await compileVariable(request.arguments):await call(request.name,request.arguments);
   if(connection.readyState===WebSocket.OPEN)connection.send(JSON.stringify({id:request.id,result}));
  }catch(error){if(connection.readyState===WebSocket.OPEN)connection.send(JSON.stringify({id:request?.id,error:error.message}));}
 });});
 await observeConnection(connection, {
 onAuthorizationRequired:()=>{
   stopped=true;
   console.error('Device authorization was revoked. Reauthorize this computer in DATUMM.');
  },
  onDuplicate:reason=>{
   stopped=true;
   console.error(reason==='DUPLICATE_ACTIVE_REQUEST'
    ?'Another DATUMM connector is already serving this device. Close it before starting a replacement.'
    :'This DATUMM connector was replaced by another instance for this device.');
  },
  onUnavailable:()=>console.error('Connection unavailable; retrying.')
 });
 if(!stopped)await new Promise(resolve=>setTimeout(resolve,5000));
}
await client.close();

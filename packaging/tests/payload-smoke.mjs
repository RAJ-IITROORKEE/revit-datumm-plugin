import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {verifyRelease} from '../lifecycle.mjs';
const payload=resolve(process.argv[2]??'missing-payload');
const require=createRequire(join(payload,'revit-mcp','dist','index.js'));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
const release=await verifyRelease(payload);
const {generateVariableCandidates}=await import(pathToFileURL(join(payload,'revit-mcp','dist','variable-candidates.js')).href);
const {bindVariableGraph}=await import(pathToFileURL(join(payload,'revit-mcp','dist','variable-bindings.js')).href);
assert.equal(typeof generateVariableCandidates,'function');
assert.equal(typeof bindVariableGraph,'function');
const program=JSON.parse(await readFile(new URL('../../tests/integration/phase5f-frozen-programs.json',import.meta.url),'utf8')).programs[0];
const searched=generateVariableCandidates({schemaVersion:2,briefId:'a72ec63a-53c2-4d0b-83b9-fcc8ac9621e5',version:1,parentVersion:null,
 site:{widthMm:program.siteMm[0],depthMm:program.siteMm[1],entry:program.entry},level:{key:'l1',name:'Level 1',elevationMm:0},wallHeightMm:3000,
 requirements:program.rooms.map(([key,kind,minimumAreaMm2])=>({key,kind,minimumAreaMm2,adjacentTo:[]})),preferences:[],unresolvedConstraints:[]});
assert.ok(searched.candidates.length);assert.equal(searched.candidates[0].graph.engineVersion,'variable-v2');
const parent=resolve('artifacts/installer-tests');await mkdir(parent,{recursive:true});const empty=await mkdtemp(join(parent,'packaged-mcp-'));
const client=new Client({name:'datumm-packaged-smoke',version:'1'});
try{
 await client.connect(new StdioClientTransport({command:join(payload,'runtime','node.exe'),args:[join(payload,'revit-mcp','dist','index.js')],cwd:empty,
  env:{...process.env,PATH:join(process.env.SystemRoot,'System32'),NODE_PATH:'',DATUMM_SESSION_DIR:empty},stderr:'inherit'}));
 const names=(await client.listTools()).tools.map(t=>t.name).sort();assert.deepEqual(names,['apply_change_set','approve_change_set','get_dimension_references','get_document_context','get_model_catalog','get_model_elements','get_model_inventory','get_model_quantities','get_model_views','get_native_capabilities','get_operation_status','get_plan_image','get_plan_snapshot','get_revit_health','get_selection','list_revit_sessions','preview_changes','show_model_elements']);
 const listed=await client.callTool({name:'list_revit_sessions',arguments:{}});assert.deepEqual(JSON.parse(listed.content[0].text),[]);
 console.log(JSON.stringify({package:release.version,verifiedFiles:release.files.length,standaloneMcp:true,variableModulesLoad:true,generalProgramSearch:true,tools:names.length,developerRuntimeOnPath:false}));
}finally{await client.close();}

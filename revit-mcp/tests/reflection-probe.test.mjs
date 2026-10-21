import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BridgeClient} from '../dist/bridge.js';
import {draftingTools,validCommandResponse} from '../dist/drafting.js';

const documentId=randomUUID(),sessionId=randomUUID();
const mirrorProbe={documentId,expectedRevision:4,levelId:'measured-level',viewId:'measured-plan',elementIds:['measured-wall','measured-room','measured-tag']};
const capabilities={documentId,revision:4,schemaVersion:1,operationSchemaVersion:3,inspectionSchemaVersion:2,minimumMcpVersion:'0.2.0-alpha.5',
  pluginVersion:'0.2.0-alpha.6',revitBuild:'SIMULATED-NO-REVIT',operationKinds:['wall'],placementSupport:[],
  limits:{operations:100,pageSize:100,dimensionReferences:8,imageBytes:1500000,imagePixels:2048},limitations:[]};
const result={documentId,revision:4,levelId:mirrorProbe.levelId,viewId:mirrorProbe.viewId,elementIds:mirrorProbe.elementIds,
  eligibilityOnly:true,qualified:false,modelChanged:false,canMirrorElements:true,reasons:[],limitations:['Eligibility only; no plane or rollback qualified.']};

test('optional mirror probe is bounded, exact and read-only; legacy capabilities are unchanged',async()=>{
  const schema=draftingTools.get_native_capabilities.schema;
  assert(schema.safeParse({sessionId}).success);
  assert(schema.safeParse({sessionId,mirrorProbe}).success);
  for(const patch of [{elementIds:[]},{elementIds:['same','same']},{elementIds:Array.from({length:101},(_,i)=>'id-'+i)},
    {expectedRevision:-1},{documentId:'other'},{viewId:undefined},{levelId:undefined},{approved:true},{axisXmm:4500},{mirrorCopies:false},{dryRun:true}])
    assert(!schema.safeParse({sessionId,mirrorProbe:{...mirrorProbe,...patch}}).success,JSON.stringify(patch));
  assert(validCommandResponse('get_native_capabilities',capabilities));
  assert(validCommandResponse('get_native_capabilities',{...capabilities,operationSchemaVersion:2,pluginVersion:'0.2.0-alpha.5'}),'Unprobed legacy capability responses remain valid');
  assert(validCommandResponse('get_native_capabilities',{...capabilities,mirrorProbe:result}));
  for(const patch of [{qualified:true},{eligibilityOnly:false},{modelChanged:true},{elementIds:['same','same']},{approved:true},{canMirrorElements:undefined}])
    assert(!validCommandResponse('get_native_capabilities',{...capabilities,mirrorProbe:{...result,...patch}}));
  const source=await readFile(new URL('../../revit-plugin/src/Datumm.Revit/ReflectionProbe.cs',import.meta.url),'utf8');
  assert(source.includes('ElementTransformUtils.CanMirrorElements('));
  const admission=source.indexOf('ElementTransformUtils.CanMirrorElements(');
  for(const guard of ['request.Validate(', 'Resolve(doc, request.LevelId)', 'Resolve(doc, request.ViewId)', 'CheckConstraints(element, level)', 'if (!OwnedNested(child, roots, level))'])
    assert(source.indexOf(guard)>=0&&source.indexOf(guard)<admission,'Native current-context and complete root screening must precede CanMirrorElements');
  assert(!/ElementTransformUtils\.MirrorElements\(|new Transaction|\.Delete\(|\.MoveElement|\.RotateElement|\.Set\(/.test(source),'The diagnostic must not mutate or open native transactions');
});

test('probe transport binds exact document/revision/view/level/root IDs without approval or execution',{timeout:15000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'datumm-mirror-probe-'));
  let responseProbe,legacy=false,requested=[],calls=[];
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+'b'.repeat(64));
    let data;
    if(req.url==='/health')data={service:'datumm-revit',pluginVersion:'0.2.0-alpha.6',revitVersion:'SIMULATED',processId:43,capabilities:['get_native_capabilities'],readOnly:false};
    else{
      let text='';for await(const chunk of req)text+=chunk;
      const request=JSON.parse(text);calls.push(request.tool);requested.push(request.arguments);
      assert.equal(request.tool,'get_native_capabilities');
      if(legacy&&request.arguments.mirrorProbe){
        res.writeHead(400,{'content-type':'application/json'});
        res.end(JSON.stringify({protocolVersion:'1',sessionId,operationId:req.headers['x-operation-id'],ok:false,data:null,error:{code:'INVALID_REQUEST',message:'Unexpected argument.'}}));return;
      }
      data={...capabilities,...(responseProbe===undefined?{}:{mirrorProbe:responseProbe})};
    }
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({protocolVersion:'1',sessionId,operationId:req.headers['x-operation-id'],ok:true,data,error:null}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await writeFile(join(directory,sessionId+'.json'),JSON.stringify({protocolVersion:'1',sessionId,processId:43,baseUrl:`http://127.0.0.1:${server.address().port}/`,token:'b'.repeat(64),pluginVersion:'0.2.0-alpha.6',revitVersion:'SIMULATED',startedAt:new Date().toISOString()}));
  try{
    const client=new BridgeClient(directory,1000);
    assert.deepEqual((await client.call('command',sessionId,{tool:'get_native_capabilities',arguments:{}})).data,capabilities);
    responseProbe=result;
    const probed=await client.call('command',sessionId,{tool:'get_native_capabilities',arguments:{mirrorProbe}});
    assert.deepEqual(probed.data.mirrorProbe,result);assert.deepEqual(requested.at(-1),{mirrorProbe});
    responseProbe={...result,canMirrorElements:false,reasons:['Native set is not mirrorable.']};
    assert.equal((await client.call('command',sessionId,{tool:'get_native_capabilities',arguments:{mirrorProbe}})).data.mirrorProbe.canMirrorElements,false);
    for(const bad of [undefined,{...result,documentId:randomUUID()},{...result,revision:5},{...result,viewId:'other'},
      {...result,levelId:'other'},{...result,elementIds:mirrorProbe.elementIds.slice(0,2)},{...result,elementIds:[...mirrorProbe.elementIds].reverse()},
      {...result,qualified:true},{...result,modelChanged:true}]){
      responseProbe=bad;
      await assert.rejects(client.call('command',sessionId,{tool:'get_native_capabilities',arguments:{mirrorProbe}}),error=>error.code==='INVALID_RESPONSE');
    }
    responseProbe=result;
    await assert.rejects(client.call('command',sessionId,{tool:'get_native_capabilities',arguments:{}}),error=>error.code==='INVALID_RESPONSE','Unsolicited probe evidence must not change a legacy capability read');
    legacy=true;
    const refused=await client.call('command',sessionId,{tool:'get_native_capabilities',arguments:{mirrorProbe}});
    assert.equal(refused.ok,false);assert.equal(refused.error.code,'INVALID_REQUEST','An older native dispatcher must refuse the new argument without fallback');
    assert(calls.length>0&&calls.every(name=>name==='get_native_capabilities'),'No preview, approval, apply or status command may be dispatched');
  }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

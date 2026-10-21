import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BridgeClient} from '../dist/bridge.js';
import {operation,draftingTools,validCommandResponse} from '../dist/drafting.js';

test('M07 strict extension contracts bind explicit rotation, view and stable references',()=>{
  const furniture={kind:'family_instance',key:'desk',typeId:'type',point:{x:10,y:20},rotationDegrees:90};
  assert(operation.safeParse(furniture).success);
  for(const edit of [{rotationDegrees:360},{rotationDegrees:NaN},{host:'guess'},{viewId:'guess'},{rotationDegrees:undefined}])
    assert(!operation.safeParse({...furniture,...edit}).success);
  const dimension={kind:'dimension',key:'width',typeId:'linear',viewId:'view',start:{x:0,y:0},end:{x:4000,y:0},stableReferences:['wall:face1','wall:face2']};
  assert(operation.safeParse(dimension).success);
  for(const edit of [{stableReferences:['same','same']},{stableReferences:['only']},{viewId:undefined},{code:'eval'}])
    assert(!operation.safeParse({...dimension,...edit}).success);
  assert(draftingTools.get_model_elements.schema.safeParse({sessionId:randomUUID(),categories:['walls'],viewId:'view',phaseId:'phase'}).success);
});

test('P9 targeted query/show transport refuses legacy dispatch and preserves exact scope',{timeout:15000},async()=>{
  const sessionId=randomUUID(),documentId=randomUUID(),directory=await mkdtemp(join(tmpdir(),'datumm-p9-'));
  let modern=false,malformed=false,calls=[];
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+'b'.repeat(64));
    let data;
    if(req.url==='/health')data={service:'datumm-revit',pluginVersion:'0.2.0-alpha.5',revitVersion:'simulated',processId:43,capabilities:['get_native_capabilities','get_model_elements','show_model_elements'],readOnly:false};
    else{
      let text='';for await(const chunk of req)text+=chunk;const request=JSON.parse(text);calls.push(request.tool);
      if(request.tool==='get_native_capabilities')data={documentId,revision:3,schemaVersion:1,operationSchemaVersion:2,...(modern?{inspectionSchemaVersion:2}:{}),minimumMcpVersion:'0.2.0-alpha.5',pluginVersion:'0.2.0-alpha.5',revitBuild:'simulated',operationKinds:['wall'],placementSupport:[],limits:{operations:100,pageSize:100,dimensionReferences:8,imageBytes:1500000,imagePixels:2048},limitations:[]};
      else if(request.tool==='get_model_elements')data={documentId,revision:3,units:'mm',coordinateFrame:'revit-internal-xy',categories:request.arguments.categories,levelId:null,elementIds:request.arguments.elementIds,region:request.arguments.region,total:0,nextOffset:null,elements:[],limitations:['Simulated transport; no native API']};
      else data={documentId,revision:3,action:request.arguments.action,elementIds:request.arguments.elementIds,viewId:'view',modelChanged:malformed};
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({protocolVersion:'1',sessionId,operationId:req.headers['x-operation-id'],ok:true,data,error:null}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    await writeFile(join(directory,sessionId+'.json'),JSON.stringify({protocolVersion:'1',sessionId,processId:43,baseUrl:`http://127.0.0.1:${server.address().port}/`,token:'b'.repeat(64),pluginVersion:'0.2.0-alpha.5',revitVersion:'simulated',startedAt:new Date().toISOString()}));
    const client=new BridgeClient(directory),query={categories:['walls'],elementIds:['wall'],region:{units:'mm',coordinateFrame:'revit-internal-xyz',minMm:{x:0,y:0,z:-100},maxMm:{x:10000,y:10000,z:4000}}};
    await assert.rejects(client.call('command',sessionId,{tool:'get_model_elements',arguments:query}),error=>error.code==='UPGRADE_REQUIRED');
    assert.deepEqual(calls,['get_native_capabilities'],'Unsupported targeted query must not reach an old plugin');
    modern=true;
    const page=await client.call('command',sessionId,{tool:'get_model_elements',arguments:query});
    assert.deepEqual(page.data.region,query.region);assert.deepEqual(page.data.elementIds,['wall']);
    const show={documentId,expectedRevision:3,elementIds:['wall'],action:'show'};
    assert.equal((await client.call('command',sessionId,{tool:'show_model_elements',arguments:show})).data.modelChanged,false);
    malformed=true;
    await assert.rejects(client.call('command',sessionId,{tool:'show_model_elements',arguments:show}),error=>error.code==='INVALID_RESPONSE');
  }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('M07 authenticated transport rejects old plugins before extended dispatch and reads bounded large images',{timeout:15000},async()=>{
  const sessionId=randomUUID(),directory=await mkdtemp(join(tmpdir(),'datumm-m07-'));
  let modern=false,calls=[];
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+'a'.repeat(64));
    let data;
    if(req.url==='/health')data={service:'datumm-revit',pluginVersion:modern?'0.2.0-alpha.2':'0.2.0-alpha.1',revitVersion:'simulated',processId:42,
      capabilities:modern?['get_native_capabilities','get_plan_image']:['get_plan_image'],readOnly:false};
    else{
      let body='';for await(const chunk of req)body+=chunk;
      const request=JSON.parse(body);calls.push(request.tool);
      data={documentId:randomUUID(),revision:1,viewId:'view',viewName:'L1',viewType:'FloorPlan',scale:100,cropActive:false,
        width:512,height:512,contentType:'image/png',base64:'A'.repeat(200000),provenance:'Simulated transport payload; no Revit API.'};
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({protocolVersion:'1',sessionId,operationId:req.headers['x-operation-id'],ok:true,data,error:null}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    await writeFile(join(directory,sessionId+'.json'),JSON.stringify({protocolVersion:'1',sessionId,processId:42,baseUrl:`http://127.0.0.1:${server.address().port}/`,
      token:'a'.repeat(64),pluginVersion:'0.2.0-alpha.1',revitVersion:'simulated',startedAt:new Date().toISOString()}));
    const client=new BridgeClient(directory);
    await assert.rejects(client.call('command',sessionId,{tool:'get_dimension_references',arguments:{viewId:'view',elementIds:['wall']}}),error=>error.code==='UPGRADE_REQUIRED');
    assert.deepEqual(calls,[]);
    modern=true;
    const image=await client.call('command',sessionId,{tool:'get_plan_image',arguments:{viewId:'view'}});
    assert.equal(image.data.base64.length,200000);
    assert(validCommandResponse('get_plan_image',image.data));
  }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('room color scheme reads and assignments require native operation schema 3',{timeout:15000},async()=>{
  const sessionId=randomUUID(),documentId=randomUUID(),directory=await mkdtemp(join(tmpdir(),'datumm-room-colors-'));
  let operationSchemaVersion=2,operationKinds=['wall'],calls=[];
  const server=createServer(async(req,res)=>{
    let data;
    if(req.url==='/health')data={service:'datumm-revit',pluginVersion:'0.2.0-alpha.6',revitVersion:'simulated',processId:52,
      capabilities:['get_native_capabilities'],readOnly:false};
    else{
      let body='';for await(const chunk of req)body+=chunk;
      const request=JSON.parse(body);calls.push(request.tool);
      if(request.tool==='get_native_capabilities')data={documentId,revision:3,schemaVersion:1,operationSchemaVersion,inspectionSchemaVersion:2,
        minimumMcpVersion:'0.2.0-alpha.5',pluginVersion:'0.2.0-alpha.6',revitBuild:'simulated',operationKinds,
        placementSupport:[],limits:{operations:100,pageSize:100,dimensionReferences:8,imageBytes:1500000,imagePixels:2048},limitations:[]};
      else if(request.tool==='get_model_views')data={documentId,revision:3,kind:'room-color-schemes',total:1,nextOffset:null,
        plans:[],links:[],levels:[],phases:[],roomColorSchemes:[{id:'scheme',name:'Measured room fill',categoryId:'OST_Rooms',categoryName:'Rooms',
          parameterDefinitionId:'-1006901',parameterName:'Department',isByRange:false,entryCount:8}],limitations:['Existing schemes only']};
      else data={documentId,revision:3,proposalId:randomUUID(),approvalHash:'a'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString(),
        changes:{operations:request.arguments.operations},deletions:[],approval:'Review exact scheme assignment'};
    }
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({protocolVersion:'1',sessionId,operationId:req.headers['x-operation-id'],ok:true,data,error:null}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    await writeFile(join(directory,sessionId+'.json'),JSON.stringify({protocolVersion:'1',sessionId,processId:52,baseUrl:'http://127.0.0.1:'+server.address().port+'/',
      token:'c'.repeat(64),pluginVersion:'0.2.0-alpha.6',revitVersion:'simulated',startedAt:new Date().toISOString()}));
    const client=new BridgeClient(directory);
    const schemeQuery={tool:'get_model_views',arguments:{kind:'room-color-schemes',limit:50}};
    await assert.rejects(client.call('command',sessionId,schemeQuery),error=>error.code==='UPGRADE_REQUIRED');
    assert.deepEqual(calls,['get_native_capabilities'],'Schema 2 must reject new room-scheme reads before dispatch');
    operationSchemaVersion=3;operationKinds=['wall','set_room_color_scheme'];
    const page=await client.call('command',sessionId,schemeQuery);
    assert.equal(page.data.roomColorSchemes[0].categoryId,'OST_Rooms');
    assert.equal(validCommandResponse('get_model_views',page.data),true);
    const changes={documentId,expectedRevision:3,levelId:'level',units:'mm',coordinateFrame:'revit-internal-xy',title:'Apply measured room fill',
      operations:[{kind:'set_room_color_scheme',key:'rooms-L1',viewId:'plan',schemeId:'scheme'}]};
    const preview=await client.call('command',sessionId,{tool:'preview_changes',arguments:changes});
    assert.deepEqual(preview.data.changes.operations,changes.operations);
    assert.equal(validCommandResponse('preview_changes',preview.data),true);
    operationKinds=['wall'];
    await assert.rejects(client.call('command',sessionId,schemeQuery),error=>error.code==='UPGRADE_REQUIRED');
  }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

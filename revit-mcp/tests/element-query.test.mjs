import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {draftingTools,validCommandResponse} from '../dist/drafting.js';

test('element query validates named categories, bounded paging and parameter requests',()=>{
  const args={sessionId:randomUUID(),categories:['walls','doors'],limit:100,offset:0,parameterNames:['Comments']};
  assert.equal(draftingTools.get_model_elements.schema.safeParse(args).success,true);
  assert.equal(draftingTools.get_model_elements.schema.safeParse({...args,categories:['rooms','room-tags']}).success,true);
  assert.equal(draftingTools.preview_changes.schema.safeParse({sessionId:randomUUID(),documentId:randomUUID(),expectedRevision:0,
    levelId:'level-1',units:'mm',coordinateFrame:'revit-internal-xy',title:'Tag inspected room',
    operations:[{kind:'room_tag',key:'tag',elementId:'room-1',viewId:'plan-1',typeId:'tag-type',point:{x:1500,y:1200}}]}).success,true);
  const deletion={sessionId:randomUUID(),documentId:randomUUID(),expectedRevision:0,
    levelId:'level-1',units:'mm',coordinateFrame:'revit-internal-xy',title:'Remove partition',
    operations:[{kind:'delete',key:'remove',elementId:'wall-1'}]};
  assert.equal(draftingTools.preview_changes.schema.safeParse(deletion).success,true);
  assert.equal(draftingTools.preview_changes.schema.safeParse({...deletion,
    operations:[{...deletion.operations[0],force:true}]}).success,false);
  for(const extra of [{categories:['anything']},{limit:101},{parameterNames:Array(9).fill('Comments')},{code:'eval'}])
    assert.equal(draftingTools.get_model_elements.schema.safeParse({...args,...extra}).success,false);
  const page={documentId:randomUUID(),revision:1,units:'mm',coordinateFrame:'revit-internal-xy',
    categories:['walls'],levelId:null,total:1,nextOffset:null,
    elements:[{element:{id:'native-wall'},parameters:[{name:'Comments',storageType:'String',value:'Partition'}]}],limitations:['Host only']};
  assert.equal(validCommandResponse('get_model_elements',page),true);
  assert.equal(validCommandResponse('get_model_elements',{...page,elements:Array(101).fill(page.elements[0])}),false);
  const closure={key:'remove',targetId:'wall-1',elements:[{nativeId:42,id:'wall-1',kind:'wall',name:'Partition'},
    {nativeId:43,id:'door-1',kind:'door',name:'Access'}]};
  const preview={documentId:deletion.documentId,revision:0,proposalId:randomUUID(),approvalHash:'a'.repeat(64),
    expiresAt:new Date().toISOString(),changes:deletion,deletions:[closure],approval:'Review exact closure'};
  assert.equal(validCommandResponse('preview_changes',preview),true);
  assert.equal(validCommandResponse('preview_changes',{...preview,deletions:[{...closure,elements:[
    ...closure.elements,{nativeId:44,id:'nested-1',kind:'nested_component',name:'Window muntin'}]}]}),true);
  assert.equal(validCommandResponse('preview_changes',{...preview,deletions:[{...closure,elements:[{...closure.elements[1],kind:'system'}]}]}),false);
});

test('P9 queries and view actions require bounded distinct IDs and explicit internal XYZ regions',()=>{
  const request={sessionId:randomUUID(),categories:['walls'],elementIds:['wall-1'],region:{units:'mm',coordinateFrame:'revit-internal-xyz',minMm:{x:0,y:0,z:-100},maxMm:{x:10000,y:10000,z:5000}}};
  assert(draftingTools.get_model_elements.schema.safeParse(request).success);
  for(const extra of [{elementIds:['same','same']},{elementIds:[]},{region:{...request.region,units:'feet'}},{region:{...request.region,maxMm:{x:0,y:10000,z:5000}}},{region:{...request.region,minMm:{x:NaN,y:0,z:-100}}}])
    assert(!draftingTools.get_model_elements.schema.safeParse({...request,...extra}).success);
  const show={sessionId:request.sessionId,documentId:randomUUID(),expectedRevision:4,elementIds:['wall-1'],action:'show'};
  assert(draftingTools.show_model_elements.schema.safeParse(show).success);
  for(const extra of [{expectedRevision:-1},{documentId:undefined},{action:'move'},{elementIds:Array(101).fill('wall')}])
    assert(!draftingTools.show_model_elements.schema.safeParse({...show,...extra}).success);
  const result={documentId:show.documentId,revision:4,action:'show',elementIds:['wall-1'],viewId:'view',modelChanged:false};
  assert(validCommandResponse('show_model_elements',result));
  assert(!validCommandResponse('show_model_elements',{...result,modelChanged:true}));
});

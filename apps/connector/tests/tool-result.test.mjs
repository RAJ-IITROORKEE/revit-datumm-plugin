import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeToolResult} from '../src/tool-result.mjs';

const args={sessionId:'session',operationId:'original',approvalHash:'hash'};
const envelope={ok:true,sessionId:'session',data:{receipt:{operationId:'original',proposalHash:'hash',state:'failed',error:'DIMENSION_REFERENCES_UNAVAILABLE',elementIds:[]},sameDocument:true,state:'failed'}};
const mcp=value=>({isError:true,content:[{type:'text',text:JSON.stringify(value)}]});

for(const name of ['apply_change_set','get_operation_status']){
 test(`${name} preserves an identity-matched native failed receipt`,()=>{
  assert.deepEqual(decodeToolResult(name,args,mcp(envelope)),envelope);
 });
}
test('unknown native read remains unknown evidence, not success or an instruction to replay',()=>{
 const unknown={ok:true,sessionId:'session',data:{receipt:null,state:'unknown',sameDocument:false}};
 assert.deepEqual(decodeToolResult('get_operation_status',args,mcp(unknown)),unknown);
 assert.throws(()=>decodeToolResult('apply_change_set',args,mcp(unknown)));
});
for(const change of ['session','operation','hash','ok','tool','state']){
 test(`native error evidence with changed ${change} remains rejected`,()=>{
  const altered=structuredClone(envelope);
  let name='apply_change_set';
  if(change==='session')altered.sessionId='foreign';
  if(change==='operation')altered.data.receipt.operationId='different';
  if(change==='hash')altered.data.receipt.proposalHash='changed';
  if(change==='ok')altered.ok=false;
  if(change==='tool')name='preview_changes';
  if(change==='state')altered.data.receipt.state='invented';
  assert.throws(()=>decodeToolResult(name,args,mcp(altered)));
 });
}
test('ordinary tool errors and successful reads keep their prior behavior',()=>{
 const error={ok:false,error:{code:'DEVICE_OFFLINE'}};
 assert.throws(()=>decodeToolResult('get_model_catalog',args,mcp(error)),/DEVICE_OFFLINE/);
 const response={...mcp(envelope),isError:false};
 assert.deepEqual(decodeToolResult('get_operation_status',args,response),envelope);
});

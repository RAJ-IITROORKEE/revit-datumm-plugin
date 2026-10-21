import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {generateVariableCandidates} from '../dist/variable-candidates.js';
import {validatePlanGraph,graphFingerprint} from '../dist/plan-graph.js';
import {bindVariableGraph} from '../dist/variable-bindings.js';
import {randomUUID} from 'node:crypto';
const F01=JSON.parse(readFileSync(new URL('../../tests/integration/phase5-mvp/M05/F01-brief.json',import.meta.url)));

test('optional furniture absence preserves V3/V4 geometry while invalid furniture rejects',()=>{
 const graph=generateVariableCandidates(structuredClone(F01)).candidates[0].graph;
 for(const schemaVersion of [3,4]){
  const draft={...structuredClone(graph),schemaVersion};delete draft.furnitureIntents;
  assert.doesNotThrow(()=>validatePlanGraph(draft));
  draft.furnitureIntents=[{key:'invalid',roomKey:draft.rooms[0].key,kind:'table',rect:[0,0,100,100],status:'proposed'}];
  assert.throws(()=>validatePlanGraph(draft),/furniture|schema/);
 }
});

test('V4 preserves measured fractional openings and explicit floor choices without weakening V3',()=>{
 const graph=structuredClone(generateVariableCandidates(structuredClone(F01)).candidates[0].graph);
 for(const opening of graph.openings){const width=opening.kind==='door'?914.4:609.6;opening.offsetMm+=(opening.widthMm-width)/2;opening.widthMm=width;opening.heightMm=opening.kind==='door'?2032:914.4;}
 assert.throws(()=>validatePlanGraph(graph),/schema/,'Integer V3 must remain unchanged');
 graph.schemaVersion=4;validatePlanGraph(graph);
 const invalid=structuredClone(graph);invalid.openings[0].widthMm=Infinity;assert.throws(()=>validatePlanGraph(invalid));
 const documentId=randomUUID(),sessionId=randomUUID();
 const types=[{id:'wall',kind:'wall',name:'wall',sizes:{widthMm:150,heightMm:null,thicknessMm:null}},
  {id:'floor',kind:'floor',name:'floor',sizes:{widthMm:null,heightMm:null,thicknessMm:152.4}},
  {id:'door',kind:'door',name:'door',sizes:{widthMm:914.4,heightMm:2032,thicknessMm:null}},
  {id:'window',kind:'window',name:'window',sizes:{widthMm:609.6,heightMm:914.4,thicknessMm:null}}].map(type=>({...type,family:null,placement:['door','window'].includes(type.kind)?'OneLevelBasedHosted':null}));
 const catalog={documentId,revision:1,units:'mm',coordinateFrame:'revit-internal-xy',supportedForWrites:true,levels:[{id:'level',name:'L1',elevationMm:0}],types,totalTypes:4,nextOffset:null};
 const placement={schemaVersion:2,sessionId,documentId,revision:1,levelId:'level',viewId:'view',originXmm:0,originYmm:0,rotationDegrees:0};
 const request={sessionId,expectedDocumentId:documentId,expectedRevision:1,placement};
 assert.throws(()=>bindVariableGraph(graph,catalog,request),/NATIVE_TYPE_REVIEW_REQUIRED/,'The default 150 mm floor cannot be silently substituted');
 placement.typeIds={wall:'wall',floor:'floor',door:'door',window:'window'};
 const result=bindVariableGraph(graph,catalog,request);
 assert.equal(result.changes.operations.find(op=>op.kind==='floor').typeId,'floor');
 assert.equal(result.expectedTypeSizes.floor.thicknessMm,152.4);
 assert(result.changes.operations.filter(op=>op.kind==='window').every(op=>result.expectedTypeSizes[op.key].widthMm===609.6));
 placement.typeIds.floor='missing';assert.throws(()=>bindVariableGraph(graph,catalog,request),/NATIVE_TYPE_REVIEW_REQUIRED/);
});
test('F01 true exterior footprint, clear areas, openings and deterministic alternatives',()=>{
 const data=structuredClone(F01),a=generateVariableCandidates(data),b=generateVariableCandidates(structuredClone(F01));
 assert.equal(a.candidates.length,3);assert.deepEqual(a.candidates.map(c=>c.fingerprint),b.candidates.map(c=>c.fingerprint));
 for(const {graph,fingerprint} of a.candidates){
  validatePlanGraph(graph);assert.equal(graphFingerprint(graph),fingerprint);
  assert.equal(Math.min(...graph.rooms.map(r=>r.rect[0]))-75,0);
  assert.equal(Math.max(...graph.rooms.map(r=>r.rect[2]))+75,9144);
  assert.equal(Math.max(...graph.rooms.map(r=>r.rect[3]))+75,12192);
  for(const r of F01.requirements){const d=graph.clearDimensions.find(d=>d.roomKey===r.key);assert.ok(d.widthMm*d.depthMm>=r.minimumAreaMm2);}
 }
});
test('malicious clear dimensions, parcel envelope and disconnected/host geometry reject',()=>{
 const graph=generateVariableCandidates(structuredClone(F01)).candidates[0].graph;
 for(const change of [g=>g.clearDimensions[0].widthMm++,g=>g.rooms[0].rect[0]++,
  g=>g.openings[0].offsetMm=0,g=>g.openings=g.openings.filter(o=>o.key!=='entry'),
  g=>g.spatialContext.sourceDimensions[0].widthMm='10000']){
   const bad=structuredClone(graph);change(bad);assert.throws(()=>validatePlanGraph(bad));
 }
 const parcel=structuredClone(F01);parcel.spatialContext.parcel={widthMm:11000,depthMm:14000};
 parcel.spatialContext.setbacksMm=[2000,2000,2000,2000];parcel.spatialContext.footprintOriginMm=[2000,2000];
 assert.throws(()=>generateVariableCandidates(parcel),/envelope/);
});
test('bounded resource envelope and representative single-room properties',()=>{
 for(const [w,d] of [[3000,3000],[9144,12192],[12000,14000],[20000,20000]]){
  const brief=structuredClone(F01);brief.site.widthMm=w;brief.site.depthMm=d;brief.spatialContext.sourceDimensions=[];
  brief.requirements=[{key:'studio',kind:'other',minimumAreaMm2:1000000,minimumClearWidthMm:700,adjacentTo:[]}];
  const result=generateVariableCandidates(brief);assert.equal(result.candidates.length,1);
  validatePlanGraph(result.candidates[0].graph);
 }
 const bad=structuredClone(F01);bad.requirements[0].minimumClearWidthMm=19000;
 const result=generateVariableCandidates(bad);assert.equal(result.candidates.length,0);
 assert.match(result.diagnostics.join(' '),/capacity|constraint/i);assert.ok(result.diagnostics.length<=8);
});

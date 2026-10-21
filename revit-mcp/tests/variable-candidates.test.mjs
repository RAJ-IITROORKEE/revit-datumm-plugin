import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { generateVariableCandidates } from '../dist/variable-candidates.js';
import { compilePlanGraph, validatePlanGraph, graphFingerprint } from '../dist/plan-graph.js';
import { bindVariableGraph } from '../dist/variable-bindings.js';

const frozen=JSON.parse(readFileSync(new URL('../../tests/integration/phase5f-frozen-briefs.json',import.meta.url),'utf8'));
function brief(spec){
  const requirement=(key,kind,minimumAreaMm2)=>({key,kind,minimumAreaMm2,adjacentTo:[]});
  const requirements=[
    ...Array.from({length:spec.bedrooms},(_,i)=>requirement(`bed${i+1}`,'bedroom',9_000_000)),
    ...Array.from({length:spec.bathrooms},(_,i)=>requirement(`bath${i+1}`,'bathroom',3_000_000)),
    requirement('living','living-dining',16_000_000),requirement('kitchen','kitchen',6_000_000),
    requirement('hall','circulation',5_000_000),
  ];
  return {schemaVersion:1,briefId:randomUUID(),version:1,parentVersion:null,
    site:{widthMm:spec.siteMm[0],depthMm:spec.siteMm[1],entry:spec.entry},
    level:{key:'l1',name:'Level 1',elevationMm:0},wallHeightMm:3000,
    bedrooms:spec.bedrooms,bathrooms:spec.bathrooms,requirements,preferences:[],unresolvedConstraints:[]};
}
const bindings={documentId:randomUUID(),revision:2,levelId:'level',wall:'wall',floor:'floor',door:'door',window:'window',smallWindow:'small'};
const programs=JSON.parse(readFileSync(new URL('../../tests/integration/phase5f-frozen-programs.json',import.meta.url),'utf8'));
function programBrief(spec){return {schemaVersion:2,briefId:randomUUID(),version:1,parentVersion:null,
  site:{widthMm:spec.siteMm[0],depthMm:spec.siteMm[1],entry:spec.entry},level:{key:'l1',name:'Level 1',elevationMm:0},wallHeightMm:3000,
  requirements:spec.rooms.map(([key,kind,minimumAreaMm2])=>({key,kind,minimumAreaMm2,adjacentTo:[]})),preferences:[],unresolvedConstraints:[]};}

for(const spec of programs.programs)test(`general ${spec.id} has measured alternatives and two meaningful revisions`,()=>{
  const input=programBrief(spec),initial=generateVariableCandidates(input);
  assert.ok(initial.candidates.length,JSON.stringify(initial.diagnostics));
  assert.ok(initial.candidates.length<=3);
  for(const item of initial.candidates){
    assert.equal(item.graph.schemaVersion,2);assert.equal(item.graph.engineVersion,'variable-v2');
    assert.deepEqual(item.graph.rooms.map(r=>r.key).toSorted(),input.requirements.map(r=>r.key).toSorted());
    validatePlanGraph(item.graph);const compiled=compilePlanGraph(item.graph,bindings);
    assert.equal(compiled.fingerprint,item.fingerprint);assert.equal(compiled.svg,item.svg);
    assert.ok(compiled.changes.operations.length<=100);
    for(const r of input.requirements){const room=item.graph.rooms.find(q=>q.key===r.key);
      assert.ok((room.rect[2]-room.rect[0]-150)*(room.rect[3]-room.rect[1]-150)>=r.minimumAreaMm2);}
  }
  const revision={...structuredClone(input),version:2,parentVersion:1};
  revision.site.entry=spec.entry==='north'?'south':'north';revision.requirements[0].minimumAreaMm2+=2000000;
  const next=generateVariableCandidates(revision);assert.ok(next.candidates.length,JSON.stringify(next.diagnostics));
  assert.notEqual(next.candidates[0].graph.site.entry,initial.candidates[0].graph.site.entry);
  const third={...structuredClone(revision),version:3,parentVersion:2};third.site.widthMm+=1000;
  const final=generateVariableCandidates(third);assert.ok(final.candidates.length,JSON.stringify(final.diagnostics));
  assert.notDeepEqual(final.candidates[0].graph.rooms.map(r=>r.rect),next.candidates[0].graph.rooms.map(r=>r.rect));
  assert.deepEqual(generateVariableCandidates(input).candidates.map(c=>c.fingerprint),initial.candidates.map(c=>c.fingerprint));
});

test('clinic alternatives enter through public rooms rather than consultation or treatment',()=>{
  const input=programBrief({siteMm:[18000,12000],entry:'south',rooms:[
    ['reception','other',12000000],['waiting','other',20000000],
    ['consult-1','other',12000000],['consult-2','other',12000000],
    ['accessible-wc','other',6000000],['treatment','other',16000000],
    ['storage','other',6000000],['circulation','circulation',12000000],
  ]});
  const result=generateVariableCandidates(input);
  assert.ok(result.candidates.length,JSON.stringify(result.diagnostics));
  for(const {graph} of result.candidates){
    const entry=graph.openings.find(opening=>opening.key==='entry');
    const host=graph.walls.find(wall=>wall.key===entry.wallKey);
    assert.ok(['reception','waiting','circulation'].includes(host.roomKeys[0]));
    assert.equal(host.start[1],200);
  }
  const stale=structuredClone(result.candidates[0].graph);
  const entry=stale.openings.find(opening=>opening.key==='entry');
  const host=stale.walls.find(wall=>wall.key===entry.wallKey);
  const originalKey=host.roomKeys[0];
  const entryRoom=stale.rooms.find(room=>room.key===originalKey);
  entryRoom.key='consult-3';entryRoom.name='Consult 3';entryRoom.kind='other';
  for(const wall of stale.walls)wall.roomKeys=wall.roomKeys.map(key=>key===originalKey?'consult-3':key);
  for(const room of stale.rooms)room.adjacentTo=room.adjacentTo.map(key=>key===originalKey?'consult-3':key);
  assert.throws(()=>validatePlanGraph(stale),/Entrance opens into a private\/service room/);
  assert.throws(()=>compilePlanGraph(stale,bindings),/Entrance opens into a private\/service room/);
});

test('general search enforces hard adjacency and reports bounded exhaustion honestly',()=>{
  const input=programBrief(programs.programs[0]);
  input.requirements.find(r=>r.key==='reception').adjacentTo=['meeting'];
  const result=generateVariableCandidates(input);assert.ok(result.candidates.length,JSON.stringify(result.diagnostics));
  for(const item of result.candidates)assert.ok(item.graph.walls.some(w=>w.roomKeys.includes('reception')&&w.roomKeys.includes('meeting')));
  const noHall=structuredClone(input);noHall.requirements=noHall.requirements.filter(r=>r.kind!=='circulation');
  const missing=generateVariableCandidates(noHall);assert.equal(missing.candidates.length,0);assert.match(missing.diagnostics[0],/circulation/);
  const impossible=programBrief(programs.programs[0]);
  impossible.requirements[0].adjacentTo=impossible.requirements.filter(r=>r.key!==impossible.requirements[0].key).map(r=>r.key);
  const exhausted=generateVariableCandidates(impossible);assert.equal(exhausted.candidates.length,0);
  assert.ok(exhausted.diagnostics.some(d=>d.includes('does not prove')));
});

for(const spec of frozen.feasible)test(`frozen feasible ${spec.id} generates bounded valid candidates`,()=>{
  const input=brief(spec),result=generateVariableCandidates(input);
  assert.ok(result.candidates.length>=1,JSON.stringify(result.diagnostics));
  assert.ok(result.candidates.length<=3);
  assert.equal(new Set(result.candidates.map(c=>c.fingerprint)).size,result.candidates.length);
  assert.deepEqual(result.candidates.map(c=>c.score),result.candidates.map(c=>c.score).toSorted((a,b)=>a-b));
  for(const c of result.candidates){
    validatePlanGraph(c.graph);
    assert.equal(c.graph.site.entry,spec.entry);
    assert.equal(c.graph.rooms.filter(r=>r.kind==='bedroom').length,spec.bedrooms);
    assert.equal(c.graph.rooms.filter(r=>r.kind==='bathroom').length,spec.bathrooms);
    const compiled=compilePlanGraph(c.graph,bindings);
    assert.equal(compiled.fingerprint,c.fingerprint);
    assert.equal(compiled.svg,c.svg);
    assert.equal(compiled.counts.rooms,c.graph.rooms.length);
    assert.equal(compiled.counts.windows,spec.bedrooms+1);
  }
  assert.deepEqual(generateVariableCandidates(input).candidates.map(c=>c.fingerprint),result.candidates.map(c=>c.fingerprint));
});

test('v2 four-bedroom program produces measured concepts without a recipe switch',()=>{
  const original=brief({bedrooms:4,bathrooms:2,siteMm:[20000,14000],entry:'north'});
  const {bedrooms:_bedrooms,bathrooms:_bathrooms,...input}=original;
  input.schemaVersion=2;
  const result=generateVariableCandidates(input);
  assert.ok(result.candidates.length>=1,JSON.stringify(result.diagnostics));
  for(const candidate of result.candidates){
    validatePlanGraph(candidate.graph);
    assert.equal(candidate.graph.rooms.filter(room=>room.kind==='bedroom').length,4);
    assert.equal(candidate.graph.rooms.filter(room=>room.kind==='bathroom').length,2);
    assert.equal(compilePlanGraph(candidate.graph,bindings).fingerprint,candidate.fingerprint);
  }
});

test('infeasible and unresolved briefs return diagnostics without a write proposal',()=>{
  const impossible=brief({...frozen.infeasible[0],bedrooms:3,bathrooms:2});
  impossible.requirements[0].minimumAreaMm2=140_000_000;
  assert.throws(()=>generateVariableCandidates(impossible),/minimum room area exceeds site area/);
  const unresolved=brief(frozen.feasible[0]);
  unresolved.unresolvedConstraints=['User must select an entrance side'];
  assert.equal(generateVariableCandidates(unresolved).candidates.length,0);
  assert.match(generateVariableCandidates(unresolved).diagnostics[0],/Resolve hard constraints/);
  const impossibleEdge=brief({...frozen.infeasible[1],bedrooms:2,bathrooms:1});
  impossibleEdge.unresolvedConstraints=frozen.infeasible[1].constraints;
  assert.equal(generateVariableCandidates(impossibleEdge).candidates.length,0);
  const impossibleAdjacency=brief(frozen.feasible[0]);
  impossibleAdjacency.requirements.find(r=>r.key==='bed1').adjacentTo=['kitchen'];
  const rejected=generateVariableCandidates(impossibleAdjacency);
  assert.equal(rejected.candidates.length,0);
  assert.ok(rejected.diagnostics.every(d=>d.includes('adjacency')));
});

test('malformed and unsupported briefs reject before search',()=>{
  const input=brief(frozen.feasible[0]);
  assert.throws(()=>generateVariableCandidates({...input,levels:2}),/schema/);
  assert.throws(()=>generateVariableCandidates({...input,site:{...input.site,widthMm:9000}}),/schema/);
  assert.throws(()=>generateVariableCandidates({...input,requirements:[...input.requirements,{...input.requirements[0]}]}),/Duplicate/);
  assert.throws(()=>generateVariableCandidates({...input,...frozen.unsupported[0]}),/schema/);
  assert.throws(()=>generateVariableCandidates({...input,...frozen.unsupported[1]}),/schema/);
});

test('catalog binding is exact and rejects stale, partial or ambiguous types',()=>{
  const graph=generateVariableCandidates(brief(frozen.feasible[0])).candidates[0].graph;
  const catalog={documentId:bindings.documentId,revision:bindings.revision,units:'mm',coordinateFrame:'revit-internal-xy',
    supportedForWrites:true,levels:[{id:'native-level',name:'Level 1',elevationMm:0}],
    types:[
      {id:'native-wall',kind:'wall',name:'Generic - 150mm',family:'Basic Wall',placement:null,sizes:{widthMm:150,heightMm:null,thicknessMm:null}},
      {id:'native-floor',kind:'floor',name:'Concrete 150mm',family:null,placement:null,sizes:{widthMm:null,heightMm:null,thicknessMm:150}},
      {id:'native-door',kind:'door',name:'900 x 2100mm',family:'M_Door-Passage-Single-Flush',placement:'OneLevelBasedHosted',sizes:{widthMm:900,heightMm:2100,thicknessMm:null}},
      {id:'native-window',kind:'window',name:'900 x 1200mm',family:'M_Window-Fixed',placement:'OneLevelBasedHosted',sizes:{widthMm:900,heightMm:1200,thicknessMm:null}},
      {id:'native-bath-door',kind:'door',name:'800 x 2100mm',family:'M_Door-Passage-Single-Flush',placement:'OneLevelBasedHosted',sizes:{widthMm:800,heightMm:2100,thicknessMm:null}},
    ],totalTypes:5,nextOffset:null};
  const request={sessionId:randomUUID(),expectedDocumentId:bindings.documentId,expectedRevision:bindings.revision};
  request.placement={schemaVersion:2,sessionId:request.sessionId,documentId:bindings.documentId,revision:bindings.revision,
    levelId:'native-level',viewId:'native-view',originXmm:20000,originYmm:0,rotationDegrees:90};
  const result=bindVariableGraph(graph,catalog,request);
  assert.equal(result.changes.documentId,bindings.documentId);
  assert.equal(result.changes.levelId,'native-level');
  assert.equal(result.binding.types.door,'native-door');
  assert.equal(result.binding.levelSelection,'explicit-reviewed-id');
  const wall=graph.walls[0],native=result.changes.operations.find(op=>op.key===wall.key);
  assert.ok(Math.abs(native.start.x-(20000-wall.start[1]))<.001);
  assert.ok(Math.abs(native.start.y-wall.start[0])<.001);
  assert.equal(result.fingerprint,graphFingerprint(graph));
  assert.match(result.binding.catalogFingerprint,/^[a-f0-9]{64}$/);
  const metricAlias={...catalog,levels:[{id:'metric-l1',name:'L1',elevationMm:0}]};
  const aliased=bindVariableGraph(graph,metricAlias,{...request,placement:{...request.placement,levelId:'metric-l1'}});
  assert.equal(aliased.changes.levelId,'metric-l1');
  assert.equal(aliased.binding.resolvedLevelName,'L1');
  assert.equal(aliased.binding.levelSelection,'explicit-reviewed-id');
  for(const elevationMm of [-3048,1143,9144]){
    const elevated=bindVariableGraph(graph,{...catalog,levels:[{id:'native-level',name:'Reviewed level',elevationMm}]},request);
    assert.equal(elevated.changes.levelId,'native-level');
    assert.equal(elevated.binding.resolvedLevelElevationMm,elevationMm);
    assert.equal(elevated.fingerprint,graphFingerprint(graph));
    assert.deepEqual(elevated.changes.operations,result.changes.operations);
    assert.notEqual(elevated.binding.catalogFingerprint,result.binding.catalogFingerprint);
  }
  assert.throws(()=>bindVariableGraph(graph,{...catalog,levels:[...catalog.levels,...catalog.levels]},request),/PLACEMENT_LEVEL_CHANGED/);
  assert.throws(()=>bindVariableGraph(graph,metricAlias,request),/PLACEMENT_LEVEL_CHANGED/);
  assert.throws(()=>bindVariableGraph(graph,{...catalog,revision:3},request),/revision changed/);
  assert.throws(()=>bindVariableGraph(graph,{...catalog,documentId:randomUUID()},request),/document or revision changed/);
  assert.throws(()=>bindVariableGraph(graph,{...catalog,nextOffset:4},request));
  assert.throws(()=>bindVariableGraph(graph,{...catalog,supportedForWrites:false},request));
  assert.throws(()=>bindVariableGraph(graph,{...catalog,types:[...catalog.types,catalog.types[2]],totalTypes:6},request),/NATIVE_TYPE_REVIEW_REQUIRED/);
  const imperial={...catalog,totalTypes:4,levels:[{id:'native-level',name:'L1',elevationMm:0}],types:[
    {...catalog.types[0],name:'Generic - 6"',sizes:{widthMm:152.4,heightMm:null,thicknessMm:null}},
    {...catalog.types[1],name:'Concrete 4"',sizes:{widthMm:null,heightMm:null,thicknessMm:101.6}},
    {...catalog.types[2],name:'36" x 80"',family:'Door-Passage-Single-Flush',sizes:{widthMm:914.4,heightMm:2032,thicknessMm:null}},
    {...catalog.types[3],name:'36" x 48"',family:'Window-Fixed',sizes:{widthMm:914.4,heightMm:1219.2,thicknessMm:null}},
  ]};
  assert.throws(()=>bindVariableGraph({...graph,level:{...graph.level,name:'L1'}},imperial,request),/NATIVE_TYPE_REVIEW_REQUIRED/);
  assert.throws(()=>bindVariableGraph(graph,catalog,{...request,placement:{...request.placement,revision:999}}),/PLACEMENT_CHANGED/);
  assert.throws(()=>bindVariableGraph(graph,{...catalog,types:catalog.types.map(t=>t.kind==='wall'?{...t,sizes:{...t.sizes,widthMm:152.4}}:t)},request),/NATIVE_TYPE_REVIEW_REQUIRED/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { compilePlanGraph, deriveGraphWalls, validatePlanGraph } from '../dist/plan-graph.js';

function fixture() {
  const rooms = [
    ['living','Living and dining','living-dining',[0,0,6000,5000]],
    ['kitchen','Kitchen','kitchen',[6000,0,12000,5000]],
    ['hall','Circulation','circulation',[0,5000,12000,6500]],
    ['bed1','Bedroom 1','bedroom',[0,6500,4000,11000]],
    ['bed2','Bedroom 2','bedroom',[4000,6500,8000,11000]],
    ['bath1','Bathroom 1','bathroom',[8000,6500,12000,11000]],
  ].map(([key,name,kind,original])=>{const rect=original.map(v=>v+100);
    return {key,name,kind,rect,areaMm2:(rect[2]-rect[0])*(rect[3]-rect[1]),adjacentTo:[]};});
  const walls=deriveGraphWalls(rooms).map((edge,i)=>({key:`wall-${i}`,start:edge.axis==='h'?[edge.lo,edge.line]:[edge.line,edge.lo],
    end:edge.axis==='h'?[edge.hi,edge.line]:[edge.line,edge.hi],kind:edge.rooms.length===1?'exterior':'interior',roomKeys:edge.rooms}));
  const door=(key,a,b,width=900)=>{const w=walls.find(w=>(key!=='entry'||(w.start[0]===12100&&w.end[0]===12100))&&w.roomKeys.length===(b?2:1)&&
    w.roomKeys.includes(a)&&(!b||w.roomKeys.includes(b))&&
    Math.abs(w.end[0]-w.start[0])+Math.abs(w.end[1]-w.start[1])>=width+300);
    assert.ok(w,`host for ${key}`); const length=Math.abs(w.end[0]-w.start[0])+Math.abs(w.end[1]-w.start[1]);
    return {key,wallKey:w.key,kind:'door',offsetMm:Math.floor((length-width)/2),widthMm:width,heightMm:2100,sillMm:0};};
  return {schemaVersion:1,engineVersion:'variable-v1',planId:randomUUID(),version:1,parentVersion:null,units:'mm',frame:'internal-xy',
    site:{widthMm:12200,depthMm:11200,entry:'east'},level:{key:'l1',name:'Level 1',elevationMm:0},wallHeightMm:3000,wallThicknessMm:150,
    rooms,walls,openings:[door('entry','hall',null),door('d1','living','hall'),door('d2','kitchen','hall'),
      door('d3','bed1','hall'),door('d4','bed2','hall'),door('d5','bath1','hall')],
    assumptions:[],unresolvedConstraints:[],provenance:{source:'deterministic',briefId:randomUUID(),briefVersion:1},display:{title:'Candidate'}};
}

test('variable graph validates, compiles and previews from the same geometry',()=>{
  const graph=fixture();assert.equal(validatePlanGraph(graph).graph.planId,graph.planId);
  const result=compilePlanGraph(graph,{documentId:randomUUID(),revision:4,levelId:'level',wall:'wall',floor:'floor',door:'door',window:'window',smallWindow:'small'});
  assert.equal(result.counts.rooms,6);assert.equal(result.counts.doors,6);
  assert.equal(result.counts.walls,graph.walls.length);
  assert.ok(result.svg.includes('Bedroom 1'));
  assert.ok(result.svg.indexOf('DATUMM · Plan') > result.svg.lastIndexOf('data-room-key='),
    'drawing title must follow room fills in paint order');
  assert.equal(result.changes.expectedRevision,4);
});

test('Build orders hosted doors before windows regardless of stored opening order',()=>{
  const graph=fixture();
  const wall=graph.walls.find(w=>w.kind==='exterior'&&w.roomKeys.includes('bed1')&&Math.hypot(w.end[0]-w.start[0],w.end[1]-w.start[1])>1800);
  graph.openings.unshift({key:'west-window',wallKey:wall.key,kind:'window',offsetMm:500,widthMm:900,heightMm:1200,sillMm:900});
  const result=compilePlanGraph(graph,{documentId:randomUUID(),revision:0,levelId:'level',wall:'wall',floor:'floor',door:'door',window:'window',smallWindow:'small'});
  const kinds=result.changes.operations.map(o=>o.kind);
  assert.ok(kinds.lastIndexOf('door')<kinds.indexOf('window'));
  assert.ok(kinds.lastIndexOf('wall')<kinds.indexOf('door'));
  assert.ok(kinds.lastIndexOf('window')<kinds.indexOf('room'));
  assert.equal(graph.openings[0].kind,'window');
});

test('invalid room topology, host and entry fail before change compilation',()=>{
  const graph=fixture();
  assert.throws(()=>validatePlanGraph({...graph,rooms:[...graph.rooms,{...graph.rooms[0],key:'extra'}]}),/Overlapping rooms|Duplicate/);
  assert.throws(()=>validatePlanGraph({...graph,walls:graph.walls.slice(1)}),/walls do not match/);
  assert.throws(()=>validatePlanGraph({...graph,openings:graph.openings.filter(o=>o.key!=='entry')}),/entrance door/);
  assert.throws(()=>validatePlanGraph({...graph,openings:[{...graph.openings[0],wallKey:'missing'},...graph.openings.slice(1)]}),/Unknown host wall/);
  assert.throws(()=>validatePlanGraph({...graph,openings:[{...graph.openings[0],offsetMm:0},...graph.openings.slice(1)]}),/endpoint/);
});

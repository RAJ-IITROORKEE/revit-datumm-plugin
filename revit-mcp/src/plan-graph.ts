/** Shared Phase 5F graph validation, preview and exact-change compilation. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { checkV3, type SpatialContext, type RequirementV3 } from './geometry-v3.js';
import { drawPlan, type DrawingStyle } from './plan-drawing.js';
import { changeSet } from './drafting.js';
import type { Bindings } from './layout.js';

type Point = [number, number];
type Room = { key:string; name:string; kind:string; rect:[number,number,number,number]; areaMm2:number; adjacentTo:string[] };
type Wall = { key:string; start:Point; end:Point; kind:'exterior'|'interior'; roomKeys:string[] };
type Opening = { key:string; wallKey:string; kind:'door'|'window'; offsetMm:number; widthMm:number; heightMm:number; sillMm:number };
export type Graph = { schemaVersion:1|2|3|4; engineVersion:'variable-v1'|'variable-v2'|'variable-v3'; planId:string; version:number; parentVersion:number|null;
  units:'mm'; frame:'internal-xy'; site:{widthMm:number;depthMm:number;entry:'north'|'south'|'east'|'west'};
  level:{key:string;name:string;elevationMm:number}; wallHeightMm:number; wallThicknessMm:number; rooms:Room[]; walls:Wall[];
  openings:Opening[]; assumptions?:string[]; unresolvedConstraints?:string[];
  provenance:{source:string;briefId:string;briefVersion:number}; display?:Record<string,string>;
  spatialContext?:SpatialContext;requirements?:RequirementV3[];clearDimensions?:{roomKey:string;widthMm:number;depthMm:number}[];
  dimensionIntents?:('overall'|'room-clear')[];furnitureIntents?:{key:string;roomKey:string;kind:string;rect:[number,number,number,number];status:'proposed'}[] };
type Edge = { axis:'h'|'v'; line:number; lo:number; hi:number; rooms:string[] };
const schema=JSON.parse(readFileSync(new URL('../../contracts/plan-graph.v1.schema.json',import.meta.url),'utf8'));
const ajv=new Ajv2020({allErrors:true,strict:false});
ajv.addFormat('uuid',/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const validSchema=ajv.compile<Graph>(schema);
const schemaV2=JSON.parse(readFileSync(new URL('../../contracts/plan-graph.v2.schema.json',import.meta.url),'utf8'));
const validSchemaV2=ajv.compile<Graph>(schemaV2);
const validSchemaV3=ajv.compile<Graph>(JSON.parse(readFileSync(new URL('../../contracts/plan-graph.v3.schema.json',import.meta.url),'utf8')));
const validSchemaV4=ajv.compile<Graph>(JSON.parse(readFileSync(new URL('../../contracts/plan-graph.v4.schema.json',import.meta.url),'utf8')));
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
export function publicEntryRank(room:Room):number {
  const label=`${room.key} ${room.name}`.replaceAll(/[-_]/g,' ');
  if(room.kind==='circulation')return 0;
  if(['living','living-dining','dining'].includes(room.kind)||
    /\b(reception|waiting|lobby|foyer|entry|entrance|front|sales|showroom)\b/i.test(label))return 1;
  if(room.kind==='other'&&
    !/\b(consult\w*|exam\w*|treatment\w*|bath\w*|wc|toilet\w*|bed\w*|storage|storeroom|utility|staff|private)\b/i.test(label))return 2;
  return 3;
}
export function maximumPublicEntryRank(rooms:Room[]):number {
  return rooms.some(r=>publicEntryRank(r)===1)?1:2;
}
const area=(r:Room)=> (r.rect[2]-r.rect[0])*(r.rect[3]-r.rect[1]);
const sorted=(value:unknown):unknown=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted((value as Record<string,unknown>)[k])])):value;
export function graphFingerprint(graph:Graph):string {
  const {display:_,...semantic}=graph;
  return createHash('sha256').update(JSON.stringify(sorted(semantic))).digest('hex');
}

/** Derive every maximal wall segment from room edges, independent of wall keys. */
export function deriveGraphWalls(rooms:Room[]):Edge[] {
  const edges:Edge[]=[];
  for(const r of rooms){const [x0,y0,x1,y1]=r.rect;
    edges.push({axis:'h',line:y0,lo:x0,hi:x1,rooms:[r.key]},{axis:'h',line:y1,lo:x0,hi:x1,rooms:[r.key]},
      {axis:'v',line:x0,lo:y0,hi:y1,rooms:[r.key]},{axis:'v',line:x1,lo:y0,hi:y1,rooms:[r.key]});}
  const result:Edge[]=[];
  for(const group of [...new Set(edges.map(e=>`${e.axis}:${e.line}`))].sort()){
    const same=edges.filter(e=>`${e.axis}:${e.line}`===group), cuts=[...new Set(same.flatMap(e=>[e.lo,e.hi]))].sort((a,b)=>a-b);
    for(let i=0;i<cuts.length-1;i++){
      const lo=cuts[i]!,hi=cuts[i+1]!,owners=same.filter(e=>e.lo<=lo&&e.hi>=hi).map(e=>e.rooms[0]!).sort();
      if(!owners.length)continue;
      check(owners.length<=2,'Non-manifold room edge.');
      const prior=result.at(-1);
      if(prior?.axis===same[0]!.axis&&prior.line===same[0]!.line&&prior.hi===lo&&prior.rooms.join()===owners.join())prior.hi=hi;
      else result.push({axis:same[0]!.axis,line:same[0]!.line,lo,hi,rooms:owners});
    }
  }
  return result;
}

function edgeOf(w:Wall):Edge {
  const horizontal=w.start[1]===w.end[1],axis=horizontal?'h':'v';
  return {axis,line:horizontal?w.start[1]:w.start[0],lo:Math.min(horizontal?w.start[0]:w.start[1],horizontal?w.end[0]:w.end[1]),
    hi:Math.max(horizontal?w.start[0]:w.start[1],horizontal?w.end[0]:w.end[1]),rooms:[...w.roomKeys].sort()};
}
const edgeId=(e:Edge)=>`${e.axis}:${e.line}:${e.lo}:${e.hi}:${e.rooms.join(',')}`;

export function validatePlanGraph(input:unknown){
  const version=input&&typeof input==='object'?(input as Graph).schemaVersion:1;
  const validator=version===4?validSchemaV4:version===3?validSchemaV3:version===2?validSchemaV2:validSchema;
  check(validator(input),`Invalid plan graph schema: ${ajv.errorsText(validator.errors)}`);
  const graph=input as Graph;
  check(graph.version<=20&&graph.parentVersion===(graph.version===1?null:graph.version-1),'Invalid plan parent version.');
  check(Buffer.byteLength(JSON.stringify(graph),'utf8')<=262144,'Plan graph exceeds 256 KiB.');
  check(graph.rooms.length>0,'Plan has no rooms.');
  const keys=(items:{key:string}[],kind:string)=>check(new Set(items.map(i=>i.key)).size===items.length,`Duplicate ${kind} key.`);
  keys(graph.rooms,'room');keys(graph.walls,'wall');keys(graph.openings,'opening');
  const roomKeys=new Set(graph.rooms.map(r=>r.key)), wallMap=new Map(graph.walls.map(w=>[w.key,w]));
  const bounds:[number,number,number,number]=[Math.min(...graph.rooms.map(r=>r.rect[0])),Math.min(...graph.rooms.map(r=>r.rect[1])),
    Math.max(...graph.rooms.map(r=>r.rect[2])),Math.max(...graph.rooms.map(r=>r.rect[3]))];
  const [x0,y0,x1,y1]=bounds;
  const halfWall=graph.wallThicknessMm/2;
  check(x0>=halfWall&&y0>=halfWall&&x1<=graph.site.widthMm-halfWall&&y1<=graph.site.depthMm-halfWall,'Exterior wall faces exceed site.');
  check(graph.rooms.every(r=>r.rect[0]<r.rect[2]&&r.rect[1]<r.rect[3]&&r.areaMm2===area(r)&&
    r.rect[0]>=x0&&r.rect[1]>=y0&&r.rect[2]<=x1&&r.rect[3]<=y1),'Invalid room bounds or area.');
  for(const r of graph.rooms){
    check(new Set(r.adjacentTo).size===r.adjacentTo.length&&r.adjacentTo.every(k=>k!==r.key&&roomKeys.has(k)),'Invalid room adjacency.');
    for(const s of graph.rooms)if(r.key<s.key)check(Math.min(r.rect[2],s.rect[2])<=Math.max(r.rect[0],s.rect[0])||
      Math.min(r.rect[3],s.rect[3])<=Math.max(r.rect[1],s.rect[1]),'Overlapping rooms.');
  }
  const areaDelta=Math.abs(graph.rooms.reduce((n,r)=>n+area(r),0)-(x1-x0)*(y1-y0));
  check(graph.schemaVersion===4?areaDelta<=.01:areaDelta===0,'Rooms do not tile the footprint.');
  const derived=deriveGraphWalls(graph.rooms), expected=new Set(derived.map(edgeId)), actual=new Set(graph.walls.map(w=>edgeId(edgeOf(w))));
  check(actual.size===expected.size&&[...expected].every(id=>actual.has(id)),'Graph walls do not match room edges.');
  for(const wall of graph.walls){const e=edgeOf(wall);
    check(wall.kind===(e.rooms.length===1?'exterior':'interior'),'Wall kind disagrees with room edge ownership.');
    if(wall.kind==='exterior')check(e.axis==='h'?(e.line===y0||e.line===y1):(e.line===x0||e.line===x1),'Exterior wall is not on footprint boundary.');
  }
  for(const room of graph.rooms)for(const neighbor of room.adjacentTo)
    check(graph.walls.some(w=>w.roomKeys.includes(room.key)&&w.roomKeys.includes(neighbor)),'Declared room adjacency has no shared wall.');
  for(const room of graph.rooms){const clearWidth=room.rect[2]-room.rect[0]-graph.wallThicknessMm;
    const clearDepth=room.rect[3]-room.rect[1]-graph.wallThicknessMm;
    check(clearWidth>0&&clearDepth>0,'Room has no clear area.');
    if(room.kind==='circulation')check(Math.min(clearWidth,clearDepth)>=1200,'Circulation clear width below 1200 mm.');
  }
  const adjacency=new Map(['outside',...roomKeys].map(k=>[k,new Set<string>()]));
  let hasEntry=false;
  let namedEntry=false;
  const hostOpenings=new Map<string,Opening[]>();
  for(const opening of graph.openings){
    const wall=wallMap.get(opening.wallKey);check(wall,`Unknown host wall: ${opening.wallKey}`);
    const e=edgeOf(wall), length=e.hi-e.lo;
    check(opening.offsetMm>=halfWall+100&&opening.offsetMm+opening.widthMm<=length-halfWall-100,'Opening too close to wall endpoint.');
    check(opening.widthMm>=(opening.kind==='door'?700:400),'Opening is narrower than supported minimum.');
    check(opening.sillMm+opening.heightMm<=graph.wallHeightMm-100,'Opening exceeds wall height.');
    const prior=hostOpenings.get(wall.key)??[];
    check(prior.every(p=>opening.offsetMm>=p.offsetMm+p.widthMm+100||p.offsetMm>=opening.offsetMm+opening.widthMm+100),'Overlapping openings.');
    prior.push(opening);hostOpenings.set(wall.key,prior);
    const owners=[...wall.roomKeys];
    check(opening.kind==='door'||owners.length===1,'Windows require an exterior wall.');
    if(opening.kind==='door'){
      const a=owners[0]!,b=owners[1]??'outside';adjacency.get(a)!.add(b);adjacency.get(b)!.add(a);
      if(b==='outside'&&((graph.site.entry==='north'&&e.axis==='h'&&e.line===y1)||
        (graph.site.entry==='south'&&e.axis==='h'&&e.line===y0)||
        (graph.site.entry==='east'&&e.axis==='v'&&e.line===x1)||
        (graph.site.entry==='west'&&e.axis==='v'&&e.line===x0))){
        hasEntry=true;
        if(opening.key==='entry'){
          namedEntry=true;
          if(graph.schemaVersion>=2&&graph.rooms.length>1){
            const room=graph.rooms.find(r=>r.key===a)!;
            check(publicEntryRank(room)<=maximumPublicEntryRank(graph.rooms),
              'Entrance opens into a private/service room instead of public circulation or arrival space.');
          }
        }
      }
    }
  }
  check(hasEntry,'No exterior entrance door on the requested cardinal side.');
  if(graph.schemaVersion>=2)check(namedEntry,'No named entry door on the requested cardinal side.');
  const reached=new Set(['outside']),queue=['outside'];
  for(let i=0;i<queue.length;i++)for(const k of adjacency.get(queue[i]!)!)if(!reached.has(k)){reached.add(k);queue.push(k);}
  check(graph.rooms.every(r=>reached.has(r.key)),'A room is unreachable from the entrance.');
  check((graph.rooms.filter(r=>r.kind==='circulation').length===1||
    graph.schemaVersion>=2&&graph.rooms.length===1&&graph.rooms[0]!.kind!=='circulation')&&
    graph.rooms.filter(r=>r.kind==='bedroom').length<=8&&
    graph.rooms.filter(r=>r.kind==='bathroom').length<=8,
    'Room program exceeds this compiler resource bound.');
  if(graph.schemaVersion>=3)checkV3(graph);
  return {graph,bounds,wallMap,hostOpenings};
}

export function compilePlanGraph(input:unknown,bindings:Bindings){
  const {graph,bounds,wallMap}=validatePlanGraph(input);
  const operations:unknown[]=[];
  for(const wall of graph.walls)operations.push({kind:'wall',key:wall.key,typeId:bindings.wall,heightMm:graph.wallHeightMm,
    start:{x:wall.start[0],y:wall.start[1]},end:{x:wall.end[0],y:wall.end[1]}});
  const [x0,y0,x1,y1]=bounds;
  operations.push({kind:'floor',key:'floor',typeId:bindings.floor,boundary:[{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}]});
  for(const o of graph.openings.slice().sort((a,b)=>(a.kind==='door'?0:1)-(b.kind==='door'?0:1))){const wall=wallMap.get(o.wallKey)!,e=edgeOf(wall),sign=e.axis==='h'?Math.sign(wall.end[0]-wall.start[0]):Math.sign(wall.end[1]-wall.start[1]);
    const along=o.offsetMm+o.widthMm/2,point=e.axis==='h'?{x:wall.start[0]+sign*along,y:e.line}:{x:e.line,y:wall.start[1]+sign*along};
    operations.push({kind:o.kind,key:o.key,typeId:o.kind==='door'?bindings.door:bindings.window,host:wall.key,point,sillMm:o.sillMm});}
  for(const r of graph.rooms)operations.push({kind:'room',key:r.key,name:r.name,point:{x:(r.rect[0]+r.rect[2])/2,y:(r.rect[1]+r.rect[3])/2}});
  const areas=graph.rooms.map(r=>({key:r.key,name:r.name,
    expectedAreaM2:(r.rect[2]-r.rect[0]-graph.wallThicknessMm)*(r.rect[3]-r.rect[1]-graph.wallThicknessMm)/1e6}));
  const changes=changeSet.parse({documentId:bindings.documentId,expectedRevision:bindings.revision,levelId:bindings.levelId,
    units:'mm',coordinateFrame:'revit-internal-xy',title:`DATUMM variable plan ${graph.planId} v${graph.version}`,operations});
  return {changes,areas,counts:{walls:graph.walls.length,floors:1,doors:graph.openings.filter(o=>o.kind==='door').length,
    windows:graph.openings.filter(o=>o.kind==='window').length,rooms:graph.rooms.length},svg:renderPlanGraph(graph),fingerprint:graphFingerprint(graph)};
}

export function renderPlanGraph(input:unknown,style:DrawingStyle='presentation'){
  const {graph}=validatePlanGraph(input);
  return drawPlan(graph,graphFingerprint(graph),style);
}

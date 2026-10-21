/** Bounded program search, independent of bedroom recipes and native credentials. */
import { createHash } from 'node:crypto';
import { deriveGraphWalls, graphFingerprint, maximumPublicEntryRank, publicEntryRank, renderPlanGraph, validatePlanGraph, type Graph } from './plan-graph.js';

import type { SpatialContext, RequirementV3 } from './geometry-v3.js';

type Requirement={key:string;kind:string;minimumAreaMm2:number;minimumClearWidthMm?:number;adjacentTo:string[]};
export type ProgramBrief={briefId:string;version:number;site:Graph['site'];level:Graph['level'];wallHeightMm:number;
  requirements:Requirement[];preferences:string[];unresolvedConstraints:string[];schemaVersion?:number;spatialContext?:SpatialContext;dimensionIntents?:('overall'|'room-clear')[]};
type Room=Graph['rooms'][number];
const thickness=150, margin=200, maxTrials=768;
const minWidth=(kind:string)=>({bedroom:2950,bathroom:1850,kitchen:2550,living:3150,dining:2550,
  'living-dining':3150,circulation:1350} as Record<string,number>)[kind]??2000;
function name(key:string){return key.replaceAll(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase());}
function row(reqs:Requirement[],x0:number,y0:number,x1:number,y1:number):Room[]{
  if(!reqs.length)throw Error('A wing must contain at least one room.');
  const clearDepth=y1-y0-thickness;
  if(clearDepth<=0)throw Error('No clear wing depth.');
  const widths=reqs.map(r=>Math.max(minWidth(r.kind),(r.minimumClearWidthMm??700)+thickness,Math.ceil(r.minimumAreaMm2/clearDepth)+thickness));
  const surplus=x1-x0-widths.reduce((a,b)=>a+b,0);
  if(surplus<0)throw Error('Room area and width constraints exceed wing capacity.');
  const total=reqs.reduce((sum,r)=>sum+r.minimumAreaMm2,0);let x=x0,used=0;
  return reqs.map((r,i)=>{const extra=i===reqs.length-1?surplus-used:Math.floor(surplus*r.minimumAreaMm2/total);used+=extra;
    const next=x+widths[i]!+extra,rect:[number,number,number,number]=[x,y0,next,y1];x=next;
    return {key:r.key,name:name(r.key),kind:r.kind,rect,areaMm2:(next-rect[0])*(y1-y0),adjacentTo:r.adjacentTo};});
}
function order(reqs:Requirement[],reverse:boolean){
  // Greedy adjacency chains are deterministic; validation, not this heuristic,
  // decides whether the resulting shared-wall requirements are satisfied.
  const remaining=[...reqs].sort((a,b)=>a.key.localeCompare(b.key));const result:Requirement[]=[];
  while(remaining.length){const previous=result.at(-1);
    const index=previous?remaining.findIndex(r=>previous.adjacentTo.includes(r.key)||r.adjacentTo.includes(previous.key)):-1;
    result.push(remaining.splice(index<0?0:index,1)[0]!);}
  return reverse?result.reverse():result;
}
function partitions(reqs:Requirement[]){
  if(reqs.length<2)return [];
  const result:{a:Requirement[];b:Requirement[];rank:number;key:string}[]=[];
  // Exhaustive subset proposals up to ten rooms; larger programs use bounded
  // balanced rotations. No search failure is reported as global infeasibility.
  const seeds=reqs.length<=10?Array.from({length:2**(reqs.length-1)-1},(_,i)=>i):Array.from({length:64},(_,i)=>i);
  for(const seed of seeds){let a:Requirement[],b:Requirement[];
    if(reqs.length<=10){a=reqs.filter((_,i)=>i===0||Boolean(seed&(1<<(i-1))));b=reqs.filter(r=>!a.includes(r));}
    else {const shifted=[...reqs.slice(seed%reqs.length),...reqs.slice(0,seed%reqs.length)];a=[];b=[];
      for(const r of shifted)(a.reduce((s,q)=>s+q.minimumAreaMm2,0)<=b.reduce((s,q)=>s+q.minimumAreaMm2,0)?a:b).push(r);}
    if(!a.length||!b.length)continue;
    const aa=a.reduce((s,r)=>s+r.minimumAreaMm2,0),bb=b.reduce((s,r)=>s+r.minimumAreaMm2,0);
    const crossing=a.reduce((s,r)=>s+r.adjacentTo.filter(k=>b.some(q=>q.key===k)).length,0)+
      b.reduce((s,r)=>s+r.adjacentTo.filter(k=>a.some(q=>q.key===k)).length,0);
    result.push({a,b,rank:crossing*1000+Math.abs(aa-bb)/(aa+bb),key:a.map(r=>r.key).join(',')});
  }
  const seen=new Set<string>();return result.sort((a,b)=>a.rank-b.rank||a.key.localeCompare(b.key))
    .filter(p=>!seen.has(p.key)&&Boolean(seen.add(p.key))).slice(0,32);
}
export function make(brief:ProgramBrief,rooms:Room[],trial:number){
  const walls=deriveGraphWalls(rooms).map((e,i)=>({key:`wall-${i.toString().padStart(2,'0')}`,
    start:(e.axis==='h'?[e.lo,e.line]:[e.line,e.lo]) as [number,number],
    end:(e.axis==='h'?[e.hi,e.line]:[e.line,e.hi]) as [number,number],
    kind:(e.rooms.length===1?'exterior':'interior') as 'exterior'|'interior',roomKeys:e.rooms}));
  const length=(w:typeof walls[number])=>Math.abs(w.end[0]-w.start[0])+Math.abs(w.end[1]-w.start[1]);
  const hall=rooms.find(r=>r.kind==='circulation');
  const openings:Graph['openings']=[];
  const add=(w:typeof walls[number],key:string,kind:'door'|'window',widthMm:number)=>{
    if(length(w)<widthMm+thickness+200)throw Error('No supported opening clearance.');
    openings.push({key,wallKey:w.key,kind,offsetMm:Math.floor((length(w)-widthMm)/2),widthMm,
      heightMm:kind==='door'?2100:1200,sillMm:kind==='door'?0:900});};
  for(const room of rooms.filter(r=>r!==hall&&rooms.length>1)){
    if(!hall)throw Error('Multiple rooms require a circulation space.');
    const host=walls.find(w=>w.roomKeys.includes(room.key)&&w.roomKeys.includes(hall.key)&&length(w)>=1250);
    if(!host)throw Error('A room lacks a sufficiently long circulation wall.');
    add(host,`door-${room.key}`,'door',900);
  }
  const x0=Math.min(...rooms.map(r=>r.rect[0])),x1=Math.max(...rooms.map(r=>r.rect[2]));
  const y0=Math.min(...rooms.map(r=>r.rect[1])),y1=Math.max(...rooms.map(r=>r.rect[3]));
  const side=(w:typeof walls[number])=>brief.site.entry==='north'?w.start[1]===y1&&w.end[1]===y1:
    brief.site.entry==='south'?w.start[1]===y0&&w.end[1]===y0:
    brief.site.entry==='east'?w.start[0]===x1&&w.end[0]===x1:w.start[0]===x0&&w.end[0]===x0;
  const entrance=walls.filter(w=>w.kind==='exterior'&&side(w)&&length(w)>=1250)
    .map(w=>({wall:w,rank:publicEntryRank(rooms.find(r=>r.key===w.roomKeys[0])!)}))
    .filter(item=>rooms.length===1||item.rank<=maximumPublicEntryRank(rooms))
    .sort((a,b)=>a.rank-b.rank||length(b.wall)-length(a.wall))[0]?.wall;
  if(!entrance)throw Error('No public room or circulation space has a supported cardinal entrance wall.');
  add(entrance,'entry','door',900);
  for(const room of rooms.filter(r=>r!==hall)){
    const host=walls.filter(w=>w.kind==='exterior'&&w.roomKeys.includes(room.key)&&w.key!==entrance.key&&length(w)>=1250)
      .sort((a,b)=>length(b)-length(a))[0];
    if(host)add(host,`window-${room.key}`,'window',900);
    else if(['bedroom','kitchen'].includes(room.kind))throw Error('No external window host for a required habitable room.');
  }
  const hex=createHash('sha256').update(`${brief.briefId}:${brief.version}:program:${trial}`).digest('hex').slice(0,32).split('');
  hex[12]='5';hex[16]='8';const id=hex.join('');
  const graph:Graph={schemaVersion:2,engineVersion:'variable-v2',planId:`${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`,
    version:1,parentVersion:null,units:'mm',frame:'internal-xy',site:brief.site,level:brief.level,wallHeightMm:brief.wallHeightMm,
    wallThicknessMm:thickness,rooms,walls,openings,assumptions:['Bounded orthogonal single-level search; native family and clearance checks are still required.'],
    unresolvedConstraints:[],provenance:{source:'deterministic',briefId:brief.briefId,briefVersion:brief.version},display:{title:'Room-program alternative'}};
  if(brief.schemaVersion===3){Object.assign(graph,{schemaVersion:3,engineVersion:'variable-v3',spatialContext:brief.spatialContext,
    requirements:brief.requirements.map(r=>({...r,minimumClearWidthMm:r.minimumClearWidthMm??700})),
    clearDimensions:rooms.map(r=>({roomKey:r.key,widthMm:r.rect[2]-r.rect[0]-thickness,depthMm:r.rect[3]-r.rect[1]-thickness})),
    dimensionIntents:brief.dimensionIntents??['overall','room-clear'],furnitureIntents:[]});}
  validatePlanGraph(graph);
  if(walls.length+1+openings.length+rooms.length>100)throw Error('Native proposal exceeds the 100-operation bound.');
  let excess=0,shape=0;
  for(const r of brief.requirements){const room=rooms.find(q=>q.key===r.key)!;
    const w=room.rect[2]-room.rect[0]-thickness,d=room.rect[3]-room.rect[1]-thickness;
    if(w*d<r.minimumAreaMm2)throw Error('Clear room area is below a requirement.');
    excess+=(w*d-r.minimumAreaMm2)/r.minimumAreaMm2;shape+=Math.max(w/d,d/w)-1;}
  const score=Math.round((excess+shape+(hall?.areaMm2??0)/((x1-x0)*(y1-y0))*100)*100)/100;
  const topology=rooms.map(r=>`${r.key}:${r.rect[0]}:${r.rect[1]}`).join('|');
  return {graph,score,fingerprint:graphFingerprint(graph),svg:renderPlanGraph(graph),topology};
}
export function searchProgram(brief:ProgramBrief){
  const margin=brief.schemaVersion===3?thickness/2:200;
  if(brief.unresolvedConstraints.length)return {candidates:[],diagnostics:['Resolve hard constraints before proposing a buildable layout.']};
  const halls=brief.requirements.filter(r=>r.kind==='circulation');
  if(brief.requirements.length===1&&!halls.length){
    try{const rooms=row(brief.requirements,margin,margin,brief.site.widthMm-margin,brief.site.depthMm-margin);
      const {topology:_,...candidate}=make(brief,rooms,0);
      return {candidates:[candidate],diagnostics:['Single-space concept; no circulation room required.',
        'Free-text preferences, door swing, regulations, furniture and structural design remain unverified.']};
    }catch{return {candidates:[],diagnostics:['Single-space constraints failed; no native proposal was produced.']};}
  }
  if(halls.length!==1)return {candidates:[],diagnostics:['Specify exactly one circulation space for this bounded orthogonal search; other drafting tasks can use native operation planning.']};
  const hall=halls[0]!,requirements=brief.requirements.filter(r=>r!==hall),found:ReturnType<typeof make>[]=[];
  const choices=partitions(requirements);let trials=0;const failures=new Map<string,number>();
  // Interleave topology, direction and dimensions so a cap does not examine
  // only the first orientation. Every candidate is independently validated.
  for(const p of choices)for(const rotated of [false,true])for(const reverse of [false,true])
    for(const fraction of [.35,.5,.65])for(const suggested of [1450,1800]){
      if(trials>=maxTrials)break;const trial=trials++;
      try{
        const W=rotated?brief.site.depthMm:brief.site.widthMm,D=rotated?brief.site.widthMm:brief.site.depthMm;
        const strip=Math.max(suggested,Math.ceil(hall.minimumAreaMm2/(W-2*margin-thickness))+thickness);
        const lower=margin+Math.floor((D-2*margin-strip)*fraction),upper=lower+strip;
        let rooms=[...row(order(p.a,reverse),margin,margin,W-margin,lower),
          {key:hall.key,name:name(hall.key),kind:'circulation',rect:[margin,lower,W-margin,upper] as [number,number,number,number],
            areaMm2:(W-2*margin)*strip,adjacentTo:hall.adjacentTo},
          ...row(order(p.b,!reverse),margin,upper,W-margin,D-margin)];
        if(rotated)rooms=rooms.map(r=>({...r,rect:[r.rect[1],r.rect[0],r.rect[3],r.rect[2]],areaMm2:r.areaMm2}));
        found.push(make(brief,rooms,trial));
      }catch(error){const message=error instanceof Error?error.message:'Geometry validation failed.';failures.set(message,(failures.get(message)??0)+1);}
    }
  found.sort((a,b)=>a.score-b.score||a.fingerprint.localeCompare(b.fingerprint));
  const signatures=new Set<string>(),candidates=[];
  for(const item of found){if(signatures.has(item.topology))continue;signatures.add(item.topology);
    const {topology:_,...candidate}=item;candidate.graph.display={title:`Alternative ${candidates.length+1}`};candidates.push(candidate);
    if(candidates.length===3)break;}
  const diagnostics=[`Bounded search evaluated ${trials} orthogonal assignments; ${found.length} passed geometry and program checks.`,
    'Scores balance clear-area surplus, room aspect ratios and circulation fraction; other free-text preferences are unresolved.',
    'Door swing, regulations, furniture and structural design are not verified by this concept search.'];
  if(!candidates.length){diagnostics.push(...[...failures].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([message,count])=>`${message} (${count} rejected assignments)`));}
  if(!candidates.length)diagnostics.push('Search exhausted its supported topology/dimension candidates; this does not prove the program globally infeasible.');
  return {candidates,diagnostics};
}

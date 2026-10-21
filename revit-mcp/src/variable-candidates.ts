/** Bounded deterministic Phase 5F concept search. No Revit credentials or writes. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { deriveGraphWalls, graphFingerprint, renderPlanGraph, validatePlanGraph } from './plan-graph.js';
import { checkSpatial } from './geometry-v3.js';
import { reviseProgram } from './program-revision.js';
import { searchProgram } from './program-search.js';

type Requirement={key:string;kind:string;minimumAreaMm2:number;adjacentTo:string[]};
type Brief={schemaVersion:1|2|3;briefId:string;version:number;parentVersion:number|null;
  site:{widthMm:number;depthMm:number;entry:'north'|'south'|'east'|'west'};
  level:{key:string;name:string;elevationMm:number};wallHeightMm:number;bedrooms?:2|3; bathrooms?:1|2;
  requirements:Requirement[];preferences:string[];unresolvedConstraints:string[]};
type Room={key:string;name:string;kind:string;rect:[number,number,number,number];areaMm2:number;adjacentTo:string[]};
const schema=JSON.parse(readFileSync(new URL('../../contracts/design-brief.v1.schema.json',import.meta.url),'utf8'));
const schemaV2=JSON.parse(readFileSync(new URL('../../contracts/design-brief.v2.schema.json',import.meta.url),'utf8'));
const ajv=new Ajv2020({allErrors:true,strict:false,useDefaults:true});
ajv.addFormat('uuid',/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const valid=ajv.compile<Brief>(schema);
const validV2=ajv.compile<Brief>(schemaV2);
const validV3=ajv.compile<Brief>(JSON.parse(readFileSync(new URL('../../contracts/design-brief.v3.schema.json',import.meta.url),'utf8')));
const wallThicknessMm=150;
function stablePlanId(brief:Brief,index:number){const hex=createHash('sha256').update(`${brief.briefId}:${brief.version}:${index}`).digest('hex').slice(0,32).split('');
  hex[12]='5';hex[16]='8';const id=hex.join('');return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;}
function kindMinimumWidth(kind:string){return ({bedroom:2950,bathroom:1850,kitchen:2550,living:3150,dining:2550,
  'living-dining':3150,circulation:1350} as Record<string,number>)[kind]??2000;}
function allocate(row:Requirement[],length:number,height:number){
  const widths=row.map(r=>Math.max(kindMinimumWidth(r.kind),Math.ceil(r.minimumAreaMm2/(height-wallThicknessMm))+wallThicknessMm));
  const extra=length-widths.reduce((a,b)=>a+b,0);
  if(extra<0)throw new Error(`Required widths exceed ${length} mm available in one row.`);
  const weights=row.map(r=>r.minimumAreaMm2),weightSum=weights.reduce((a,b)=>a+b,0);
  let used=0;return widths.map((w,i)=>{const addition=i===widths.length-1?extra-used:Math.floor(extra*weights[i]!/weightSum);
    used+=addition;return w+addition;});
}
function roomName(r:Requirement){const name=r.key.replaceAll(/[-_]/g,' ');return name.replace(/\b\w/g,c=>c.toUpperCase());}
function buildRow(requirements:Requirement[],x0:number,y0:number,x1:number,y1:number){
  const widths=allocate(requirements,x1-x0,y1-y0);let x=x0;
  return requirements.map((req,i)=>{const next=x+widths[i]!,rect:[number,number,number,number]=[x,y0,next,y1];x=next;
    return {key:req.key,name:roomName(req),kind:req.kind,rect,areaMm2:(next-rect[0])*(y1-y0),adjacentTo:req.adjacentTo} as Room;});
}
function wallFor(walls:{key:string;roomKeys:string[];start:number[];end:number[]}[],a:string,b?:string,side?:Brief['site']['entry']){
  const xs=walls.flatMap(w=>[w.start[0]!,w.end[0]!]);
  const ys=walls.flatMap(w=>[w.start[1]!,w.end[1]!]);
  const atSide=(w:typeof walls[number])=>{
    if(!side)return true;
    if(side==='east')return w.start[0]===w.end[0]&&w.start[0]===Math.max(...xs);
    if(side==='west')return w.start[0]===w.end[0]&&w.start[0]===Math.min(...xs);
    if(side==='north')return w.start[1]===w.end[1]&&w.start[1]===Math.max(...ys);
    return w.start[1]===w.end[1]&&w.start[1]===Math.min(...ys);
  };
  return walls.find(w=>w.roomKeys.includes(a)&&w.roomKeys.length===(b?2:1)&&
    (!b||w.roomKeys.includes(b))&&atSide(w));
}
function opening(wall:{key:string;start:number[];end:number[]},key:string,kind:'door'|'window',widthMm:number){
  const length=Math.abs(wall.end[0]!-wall.start[0]!)+Math.abs(wall.end[1]!-wall.start[1]!);
  if(length<widthMm+wallThicknessMm+200)throw new Error(`No clearance for ${key} on wall ${wall.key}.`);
  return {key,wallKey:wall.key,kind,offsetMm:Math.floor((length-widthMm)/2),widthMm,
    heightMm:kind==='door'?2100:1200,sillMm:kind==='door'?0:900};
}
function candidate(brief:Brief,index:number){
  const {widthMm:W,depthMm:D,entry}=brief.site,margin=200, corridorHeight=[1500,1700,1900][index]!;
  const x0=margin,x1=W-margin,y0=margin,y1=D-margin;
  const usableHeight=y1-y0-corridorHeight, northEntry=entry==='north';
  const lowerHeight=Math.floor(usableHeight*[0.50,0.46,0.54][index]!);
  const corridorY0=y0+lowerHeight,corridorY1=corridorY0+corridorHeight;
  const living=brief.requirements.filter(r=>['living','dining','living-dining'].includes(r.kind));
  const kitchen=brief.requirements.filter(r=>r.kind==='kitchen');
  const beds=brief.requirements.filter(r=>r.kind==='bedroom');
  const baths=brief.requirements.filter(r=>r.kind==='bathroom');
  const other=brief.requirements.filter(r=>r.kind==='other');
  const primaryBath=baths.slice(0,1),secondaryBath=baths.slice(1);
  const livingRow=index===1?[...kitchen,...living,...secondaryBath,...other]:
    index===2?[...secondaryBath,...living,...kitchen,...other]:[...living,...kitchen,...secondaryBath,...other];
  const bedRow=index===1?[...primaryBath,...beds.slice().reverse()]:
    index===2?[...beds.slice().reverse(),...primaryBath]:[...beds,...primaryBath];
  const lower=northEntry?bedRow:livingRow,upper=northEntry?livingRow:bedRow;
  const rooms=[...buildRow(lower,x0,y0,x1,corridorY0),
    {key:brief.requirements.find(r=>r.kind==='circulation')!.key,name:'Circulation',kind:'circulation',
      rect:[x0,corridorY0,x1,corridorY1] as [number,number,number,number],areaMm2:(x1-x0)*corridorHeight,adjacentTo:[]} as Room,
    ...buildRow(upper,x0,corridorY1,x1,y1)];
  const edges=deriveGraphWalls(rooms),walls=edges.map((e,i)=>({key:`wall-${i.toString().padStart(2,'0')}`,
    start:e.axis==='h'?[e.lo,e.line]:[e.line,e.lo],end:e.axis==='h'?[e.hi,e.line]:[e.line,e.hi],
    kind:e.rooms.length===1?'exterior':'interior',roomKeys:e.rooms}));
  const corridor=rooms.find(r=>r.kind==='circulation')!,openings=[];
  for(const r of rooms.filter(r=>r.key!==corridor.key)){
    const host=wallFor(walls,r.key,corridor.key);
    if(!host)throw new Error(`No corridor wall for ${r.key}.`);
    openings.push(opening(host,`door-${r.key}`,'door',r.kind==='bathroom'?800:900));
  }
  const entryRoom=['east','west'].includes(entry)?corridor:rooms.find(r=>['living-dining','living'].includes(r.kind))!;
  const entryHost=wallFor(walls,entryRoom.key,undefined,entry);
  if(!entryHost)throw new Error(`No ${entry} entrance wall.`);
  openings.push(opening(entryHost,'entry','door',900));
  for(const room of rooms.filter(r=>['bedroom','kitchen'].includes(r.kind))){
    const host=walls.find(w=>w.kind==='exterior'&&w.roomKeys.includes(room.key)&&w.key!==entryHost.key&&
      Math.abs(w.end[0]!-w.start[0]!)+Math.abs(w.end[1]!-w.start[1]!)>=wallThicknessMm+1000);
    if(!host)throw new Error(`No exterior window host for ${room.key}.`);
    openings.push(opening(host,`window-${room.key}`,'window',900));
  }
  const graph={schemaVersion:1 as const,engineVersion:'variable-v1' as const,planId:stablePlanId(brief,index),version:1,parentVersion:null,
    units:'mm' as const,frame:'internal-xy' as const,site:brief.site,level:brief.level,wallHeightMm:brief.wallHeightMm,wallThicknessMm,
    rooms,walls,openings,assumptions:['Orthogonal single-level concept; verify family catalog before Build.'],
    unresolvedConstraints:brief.unresolvedConstraints,provenance:{source:'deterministic',briefId:brief.briefId,briefVersion:brief.version},
    display:{title:`Candidate ${index+1}`}};
  const validated=validatePlanGraph(graph);
  for(const requirement of brief.requirements){const room=rooms.find(r=>r.key===requirement.key);
    if(!room)throw new Error(`Missing required room ${requirement.key}.`);
    const clear=(room.rect[2]-room.rect[0]-wallThicknessMm)*(room.rect[3]-room.rect[1]-wallThicknessMm);
    if(clear<requirement.minimumAreaMm2)throw new Error(`${requirement.key} clear area below its minimum.`);
  }
  const corridorFraction=corridor.areaMm2/((x1-x0)*(y1-y0));
  const surplus=brief.requirements.reduce((total,requirement)=>{
    const room=rooms.find(r=>r.key===requirement.key)!;
    const clear=(room.rect[2]-room.rect[0]-wallThicknessMm)*(room.rect[3]-room.rect[1]-wallThicknessMm);
    return total+(clear-requirement.minimumAreaMm2)/requirement.minimumAreaMm2;
  },0);
  const score=Math.round((corridorFraction*100+surplus)*100)/100;
  return {graph:validated.graph,fingerprint:graphFingerprint(validated.graph),score,svg:renderPlanGraph(validated.graph)};
}

export function generateVariableCandidates(input:unknown,previousGraph?:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid design brief schema.');
  const version=(input as Record<string,unknown>).schemaVersion;
  if(version===1){if(!valid(input))throw new Error(`Invalid design brief schema: ${ajv.errorsText(valid.errors)}`);}
  else if(version===2){if(!validV2(input))throw new Error(`Invalid design brief schema: ${ajv.errorsText(validV2.errors)}`);}
  else if(version===3){if(!validV3(input))throw new Error(`Invalid v3 brief: ${ajv.errorsText(validV3.errors)}`);}
  else throw new Error('Unsupported design brief schema version.');
  const brief=input as Brief;
  for(const requirement of brief.requirements)requirement.adjacentTo??=[];
  brief.preferences??=[];
  brief.unresolvedConstraints??=[];
  if(brief.version>20||brief.parentVersion!==(brief.version===1?null:brief.version-1))throw new Error('Invalid brief parent version.');
  const keys=new Set(brief.requirements.map(r=>r.key)),kinds=brief.requirements.map(r=>r.kind);
  if(keys.size!==brief.requirements.length)throw new Error('Duplicate room requirement key.');
  if(brief.schemaVersion===1&&(kinds.filter(k=>k==='bedroom').length!==brief.bedrooms||
    kinds.filter(k=>k==='bathroom').length!==brief.bathrooms))
    throw new Error('Required room program does not match bedroom or bathroom counts.');
  if(brief.schemaVersion>=2){
    for(const r of brief.requirements)if(new Set(r.adjacentTo).size!==r.adjacentTo.length||r.adjacentTo.includes(r.key)||
      r.adjacentTo.some(k=>!keys.has(k)))throw new Error(`Invalid adjacency requirement for ${r.key}.`);
    if(brief.requirements.reduce((n,r)=>n+r.minimumAreaMm2,0)>brief.site.widthMm*brief.site.depthMm)
      throw new Error('Requested minimum room area exceeds site area.');
    if(brief.schemaVersion===3){checkSpatial(brief.site,(brief as unknown as import('./program-search.js').ProgramBrief).spatialContext!);
      if(previousGraph)return reviseProgram(brief,previousGraph);}
    else if(previousGraph)throw Error('Stable local revisions require a v3 brief.');
    return searchProgram(brief);
  }
  if(kinds.filter(k=>k==='kitchen').length!==1||kinds.filter(k=>k==='circulation').length!==1)
    throw new Error('This layout generator needs one kitchen and one circulation space; the brief remains valid for other engines.');
  const combined=kinds.filter(k=>k==='living-dining').length===1&&!kinds.includes('living')&&!kinds.includes('dining');
  const separate=!kinds.includes('living-dining')&&kinds.filter(k=>k==='living').length===1&&kinds.filter(k=>k==='dining').length===1;
  if(!combined&&!separate)throw new Error('Living and dining must be represented exactly once.');
  for(const r of brief.requirements)if(new Set(r.adjacentTo).size!==r.adjacentTo.length||r.adjacentTo.includes(r.key)||
    r.adjacentTo.some(k=>!keys.has(k)))throw new Error(`Invalid adjacency requirement for ${r.key}.`);
  if(brief.requirements.reduce((n,r)=>n+r.minimumAreaMm2,0)>brief.site.widthMm*brief.site.depthMm)
    throw new Error('Requested minimum room area exceeds site area.');
  if(brief.unresolvedConstraints.length)return {candidates:[],diagnostics:['Resolve hard constraints before proposing a buildable layout.']};
  const diagnostics:string[]=[],candidates:ReturnType<typeof candidate>[]=[];
  if(brief.preferences.length)diagnostics.push('Free-text preferences are recorded but not evaluated by this deterministic search.');
  for(let i=0;i<3;i++)try{candidates.push(candidate(brief,i));}catch(error){diagnostics.push(`Candidate ${i+1}: ${error instanceof Error?error.message:String(error)}`);}
  candidates.sort((a,b)=>a.score-b.score||a.fingerprint.localeCompare(b.fingerprint));
  return {candidates,diagnostics};
}

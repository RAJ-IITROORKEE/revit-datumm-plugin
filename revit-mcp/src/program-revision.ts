/** Local shared-boundary revisions preserve every other room rectangle/key. */
import { validatePlanGraph, type Graph } from './plan-graph.js';
import { make, searchProgram, type ProgramBrief } from './program-search.js';
export function reviseProgram(brief:ProgramBrief,input:unknown){
  const old=validatePlanGraph(input).graph;
  if(old.schemaVersion!==3||old.provenance.briefId!==brief.briefId||old.provenance.briefVersion+1!==brief.version)throw Error('Revision requires exact v3 parent lineage.');
  const fail=(why:string)=>({candidates:[],diagnostics:[why,'No hard constraints or unaffected room geometry were relaxed. Explicit replanning is required.']});
  if(JSON.stringify(old.site)!==JSON.stringify(brief.site)){
    const result=searchProgram(brief);
    result.diagnostics.push('Explicit footprint/entry revision affects the whole layout; prior room keys retained.');
    return result;
  }
  if(old.rooms.length!==brief.requirements.length||
    brief.requirements.some(r=>!old.rooms.some(q=>q.key===r.key&&q.kind===r.kind)))return fail('Local revision cannot change footprint, entry or room program.');
  const rooms=structuredClone(old.rooms);
  const passes=(room:Graph['rooms'][number])=>{const req=brief.requirements.find(r=>r.key===room.key)!;
    const w=room.rect[2]-room.rect[0]-150,d=room.rect[3]-room.rect[1]-150;
    return w*d>=req.minimumAreaMm2&&Math.min(w,d)>=(req.minimumClearWidthMm??700);};
  const finish=(trial:number)=>{try{const {topology:_,...candidate}=make(brief,rooms,trial);
    return {candidates:[candidate],diagnostics:['Local revision preserves unaffected room rectangles; all hosts/openings and hard constraints revalidated.']};}catch{return null;}};
  if(rooms.every(passes)){const result=finish(0);if(result)return result;}
  const changes=rooms.filter(r=>!passes(r));
  if(changes.length!==1)return fail('This bounded local revision supports one changed room at a time.');
  const target=changes[0]!,req=brief.requirements.find(r=>r.key===target.key)!;
  for(const neighbor of rooms.filter(r=>r!==target))for(const axis of [0,1] as const){
    const other=axis===0?1:0;
    if(target.rect[other]!==neighbor.rect[other]||target.rect[other+2]!==neighbor.rect[other+2])continue;
    for(const sign of [-1,1]){
      const face=axis+(sign===1?2:0),opp=axis+(sign===1?0:2);
      if(target.rect[face]!==neighbor.rect[opp])continue;
      const depth=target.rect[other+2]!-target.rect[other]!-150;
      const needed=Math.max(Math.ceil(req.minimumAreaMm2/depth)+150,(req.minimumClearWidthMm??700)+150);
      const delta=needed-(target.rect[axis+2]!-target.rect[axis]!);
      if(delta<=0)continue;
      const a=[...target.rect] as typeof target.rect,b=[...neighbor.rect] as typeof neighbor.rect;
      target.rect[face]!+=sign*delta;neighbor.rect[opp]!+=sign*delta;
      for(const room of [target,neighbor])room.areaMm2=(room.rect[2]-room.rect[0])*(room.rect[3]-room.rect[1]);
      if(rooms.every(passes)){const result=finish(face+1);if(result)return result;}
      target.rect=a;neighbor.rect=b;
      for(const room of [target,neighbor])room.areaMm2=(room.rect[2]-room.rect[0])*(room.rect[3]-room.rect[1]);
    }
  }
  return fail('Requested clear room area/width cannot fit the supported shared-boundary edit.');
}

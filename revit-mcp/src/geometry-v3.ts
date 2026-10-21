/** Exact v3 metadata checks; graph-local coordinates are separate from parcel placement. */
import type { Graph } from './plan-graph.js';
export type SpatialContext={parcel:{widthMm:number;depthMm:number}|null;footprintOriginMm:number[]|null;
  setbackSource?:Record<string,string>|null;setbacksMm:number[]|null;footprintBasis:'explicit'|'provisional-envelope';northDegrees:number|null;
  sourceDimensions:{role:'footprint'|'parcel';sourceText:string;widthMm:string;depthMm:string}[];coordinateFrame:'footprint-local-xy-mm'};
export type RequirementV3={key:string;kind:string;minimumAreaMm2:number;minimumClearWidthMm:number;adjacentTo:string[]};
export function checkSpatial(site:Graph['site'],context:SpatialContext){
  for(const source of context.sourceDimensions){const target=source.role==='footprint'?site:context.parcel;
    if(!target||Number(source.widthMm)!==target.widthMm||Number(source.depthMm)!==target.depthMm)throw Error('Exact source dimension mismatch.');}
  if(context.setbacksMm&&!context.parcel)throw Error('Setbacks require a separate parcel.');
  if(context.parcel){
    const [w,s,e,n]=(context.setbacksMm??[0,0,0,0]) as [number,number,number,number];
    if(!context.footprintOriginMm){if(site.widthMm>context.parcel.widthMm-w-e||site.depthMm>context.parcel.depthMm-s-n)throw Error('Footprint exceeds parcel envelope.');return;}
    const [x,y]=context.footprintOriginMm as [number,number];
    if(x<w||y<s||x+site.widthMm>context.parcel.widthMm-e||y+site.depthMm>context.parcel.depthMm-n)throw Error('Footprint exceeds parcel buildable envelope.');}
}
export function checkV3(graph:Graph){
  checkSpatial(graph.site,graph.spatialContext!);
  const h=graph.wallThicknessMm/2;
  if(Math.min(...graph.rooms.map(r=>r.rect[0]))!==h||Math.min(...graph.rooms.map(r=>r.rect[1]))!==h||
    Math.max(...graph.rooms.map(r=>r.rect[2]))!==graph.site.widthMm-h||Math.max(...graph.rooms.map(r=>r.rect[3]))!==graph.site.depthMm-h)throw Error('Exterior wall faces must match the exact footprint.');
  const requirements=graph.requirements!,dimensions=graph.clearDimensions!;
  if(requirements.length!==graph.rooms.length||new Set(requirements.map(r=>r.key)).size!==graph.rooms.length||
    dimensions.length!==graph.rooms.length||new Set(dimensions.map(d=>d.roomKey)).size!==graph.rooms.length)throw Error('Room constraints/dimensions must cover every room once.');
  for(const room of graph.rooms){const req=requirements.find(r=>r.key===room.key),dim=dimensions.find(d=>d.roomKey===room.key);
    const w=room.rect[2]-room.rect[0]-graph.wallThicknessMm,d=room.rect[3]-room.rect[1]-graph.wallThicknessMm;
    if(!req||!dim||req.kind!==room.kind||dim.widthMm!==w||dim.depthMm!==d||w*d<req.minimumAreaMm2||Math.min(w,d)<req.minimumClearWidthMm)throw Error(`Clear constraints failed: ${room.key}.`);
  }
  if(new Set(graph.dimensionIntents).size!==graph.dimensionIntents!.length)throw Error('Duplicate dimension intent.');
  for(const item of graph.furnitureIntents??[]){const room=graph.rooms.find(r=>r.key===item.roomKey),[x,y,X,Y]=item.rect,t=graph.wallThicknessMm/2;
    if(!room||x>=X||y>=Y||x<room.rect[0]+t||y<room.rect[1]+t||X>room.rect[2]-t||Y>room.rect[3]-t)throw Error('Proposed furniture exceeds room clear envelope.');}
}

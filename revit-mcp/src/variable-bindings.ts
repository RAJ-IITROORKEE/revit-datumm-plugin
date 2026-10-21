/** Exact native type binding for a validated variable graph. No Revit calls. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { compilePlanGraph, validatePlanGraph } from './plan-graph.js';
import { changeSet } from './drafting.js';

const catalogSchema=z.object({
  documentId:z.string().uuid(),revision:z.number().int().nonnegative(),
  units:z.literal('mm'),coordinateFrame:z.literal('revit-internal-xy'),supportedForWrites:z.literal(true),
  levels:z.array(z.object({id:z.string().min(1),name:z.string(),elevationMm:z.number().finite()}).strict()),
  types:z.array(z.object({id:z.string().min(1),name:z.string(),kind:z.enum(['wall','floor','door','window','room_tag','dimension','family_instance']),
    family:z.string().nullable(),placement:z.string().nullable(),sizes:z.object({widthMm:z.number().nullable(),heightMm:z.number().nullable(),thicknessMm:z.number().nullable()}).strict().optional()}).strict()),
  totalTypes:z.number().int().nonnegative(),nextOffset:z.null(),
}).passthrough();
const bindingRequest=z.object({sessionId:z.string().uuid(),expectedDocumentId:z.string().uuid(),
  expectedRevision:z.number().int().nonnegative(),placement:z.object({schemaVersion:z.literal(2),
    sessionId:z.string().uuid(),documentId:z.string().uuid(),revision:z.number().int().nonnegative(),
    levelId:z.string().min(1),viewId:z.string().min(1),originXmm:z.number().finite().min(-900000).max(900000),
    originYmm:z.number().finite().min(-900000).max(900000),rotationDegrees:z.number().finite().min(0).lt(360),
    typeIds:z.object({wall:z.string().min(1),floor:z.string().min(1),door:z.string().min(1),window:z.string().min(1)}).strict().optional()}).strict()}).strict();

export function bindVariableGraph(graphInput:unknown,catalogInput:unknown,requestInput:unknown){
  const {graph}=validatePlanGraph(graphInput);
  const catalog=catalogSchema.parse(catalogInput),request=bindingRequest.parse(requestInput);
  if(catalog.documentId!==request.expectedDocumentId||catalog.revision!==request.expectedRevision)
    throw new Error('Catalog document or revision changed; re-inspect before compiling.');
  if(catalog.totalTypes!==catalog.types.length)throw new Error('Incomplete native type catalog.');
  const placement=request.placement;
  if(placement.sessionId!==request.sessionId||placement.documentId!==catalog.documentId||placement.revision!==catalog.revision)
    throw Error('PLACEMENT_CHANGED: Refresh and confirm placement against this exact document/revision.');
  // Explicit native placement anchors the single-level concept to the reviewed
  // Revit level. The concept's elevation is not the host's absolute elevation.
  const levels=catalog.levels.filter(l=>l.id===placement.levelId);
  if(levels.length!==1)throw Error('PLACEMENT_LEVEL_CHANGED: Confirm one loaded native level by its exact ID.');
  const near=(actual:number|null|undefined,expected:number)=>typeof actual==='number'&&Number.isFinite(actual)&&Math.abs(actual-expected)<=.01;
  const type=(kind:'wall'|'floor'|'door'|'window',width:number,height?:number)=>{
    const rows=catalog.types.filter(t=>t.kind===kind);
    const chosen=placement.typeIds?.[kind];
    const matches=rows.filter(t=>(!chosen||t.id===chosen)&&(kind==='floor'?chosen?typeof t.sizes?.thicknessMm==='number'&&Number.isFinite(t.sizes.thicknessMm)&&t.sizes.thicknessMm>0&&t.sizes.thicknessMm<=1000:near(t.sizes?.thicknessMm,width):
      near(t.sizes?.widthMm,width)&&(height===undefined||near(t.sizes?.heightMm,height))&&
      (!['door','window'].includes(kind)||t.placement==='OneLevelBasedHosted')));
    // A unique measured binding is grounded. If several compatible types exist,
    // retain the previously supported named family only when uniquely discovered.
    const preferred=matches.filter(t=>kind==='wall'?t.name==='Generic - 150mm':kind==='floor'?t.name==='Concrete 150mm':
      t.family===(kind==='door'?'M_Door-Passage-Single-Flush':'M_Window-Fixed'));
    const selected=matches.length===1?matches:preferred;
    if(selected.length!==1)throw Error(`NATIVE_TYPE_REVIEW_REQUIRED: ${kind} requires ${width}${height===undefined?'':` x ${height}`} mm. Loaded measured choices: ${JSON.stringify(rows.map(t=>({id:t.id,name:t.name,sizes:t.sizes??null,placement:t.placement}))).slice(0,1800)}. Load an exact compatible type or revise and re-review the plan; no size substitution.`);
    return selected[0]!.id;
  };
  const doors=graph.openings.filter(o=>o.kind==='door'),windows=graph.openings.filter(o=>o.kind==='window');
  const openingTypes=Object.fromEntries(graph.openings.map(o=>[o.key,type(o.kind,o.widthMm,o.heightMm)]));
  const window=windows.length?type('window',windows[0]!.widthMm,windows[0]!.heightMm):'';
  const bindings={documentId:catalog.documentId,revision:catalog.revision,levelId:levels[0]!.id,
    wall:type('wall',graph.wallThicknessMm),floor:type('floor',150),
    door:doors.length?type('door',doors[0]!.widthMm,doors[0]!.heightMm):'',
    window,smallWindow:window};
  const selected={sessionId:request.sessionId,documentId:catalog.documentId,revision:catalog.revision,
    levelId:bindings.levelId,resolvedLevelElevationMm:levels[0]!.elevationMm,placement,types:{wall:bindings.wall,floor:bindings.floor,door:bindings.door,
      window:bindings.window,smallWindow:bindings.smallWindow},openingTypes};
  const catalogFingerprint=createHash('sha256').update(JSON.stringify(selected)).digest('hex');
  const compiled=compilePlanGraph(graph,bindings);
  for(const op of compiled.changes.operations)if(op.kind==='door'||op.kind==='window')op.typeId=openingTypes[op.key]!;
  const radians=placement.rotationDegrees*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  const transform=(point:{x:number;y:number})=>({x:placement.originXmm+point.x*c-point.y*s,y:placement.originYmm+point.x*s+point.y*c});
  for(const op of compiled.changes.operations){
    if('start' in op)op.start=transform(op.start);
    if('end' in op)op.end=transform(op.end);
    if('point' in op)op.point=transform(op.point);
    if('boundary' in op)op.boundary=op.boundary.map(transform);
  }
  compiled.changes=changeSet.parse(compiled.changes);
  // Recheck boundary limits after transform; the graph itself and its fingerprint
  // stay immutable and placement is separately bound in the native proposal.
  const corners=[{x:0,y:0},{x:graph.site.widthMm,y:0},{x:graph.site.widthMm,y:graph.site.depthMm},{x:0,y:graph.site.depthMm}].map(transform);
  const x0=Math.min(...corners.map(p=>p.x)),y0=Math.min(...corners.map(p=>p.y)),W=Math.max(...corners.map(p=>p.x))-x0,H=Math.max(...corners.map(p=>p.y))-y0;
  const paths=compiled.changes.operations.flatMap(op=>op.kind==='wall'?[`<path d="M${op.start.x} ${op.start.y}L${op.end.x} ${op.end.y}" stroke="#293943" stroke-width="${graph.wallThicknessMm}"/>`]:[]).join('');
  compiled.svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0-700} ${y0-700} ${W+1400} ${H+1400}"><rect x="${x0-700}" y="${y0-700}" width="${W+1400}" height="${H+1400}" fill="#fff"/><g fill="none">${paths}</g><text x="${x0}" y="${y0-350}" font-size="180">Native XY mm · origin ${placement.originXmm}, ${placement.originYmm} · rotation ${placement.rotationDegrees}°</text></svg>`;
  const expectedTypeSizes=Object.fromEntries(compiled.changes.operations.filter(op=>'typeId' in op).map(op=>[op.key,catalog.types.find(t=>t.id===('typeId' in op?op.typeId:''))?.sizes]));
  return {...compiled,expectedTypeSizes,binding:{...selected,resolvedLevelName:levels[0]!.name,levelSelection:'explicit-reviewed-id',
    catalogFingerprint},dependencyPlan:{schemaVersion:1,base:'walls-floor-openings-rooms',annotations:'after committed receipt and fresh native references; separate exact review',furniture:'conceptual intents require loaded-type placement review'}};
}

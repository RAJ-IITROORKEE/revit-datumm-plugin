import { z } from 'zod';
import { changeSet } from './drafting.js';

const rect = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
const point = z.tuple([z.number().finite(), z.number().finite()]);
const layoutSchema = z.object({ id: z.string(), units: z.literal('mm'), site: rect, footprint: rect,
  wallThicknessMm: z.number().positive(), wallHeightMm: z.number().positive(), areaToleranceM2: z.number().positive(),
  targetAreaToleranceFraction: z.number().min(0).max(0.3),
  rooms: z.array(z.object({ key: z.string(), name: z.string(), rect, targetAreaM2: z.number().positive().optional() }).strict()).min(1).max(20),
  openings: z.array(z.object({ key: z.string(), kind: z.enum(['door','window']), rooms: z.tuple([z.string(),z.string()]), point,
    type: z.enum(['door','window','smallWindow']), widthMm: z.number().positive(), heightMm: z.number().positive(), sillMm: z.number().nonnegative() }).strict())
}).strict();
export type Layout = z.infer<typeof layoutSchema>;
type Segment = { axis: 'h'|'v'; line: number; lo: number; hi: number; rooms: string[]; key: string };
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const area = (r: number[]) => (r[2]!-r[0]!)*(r[3]!-r[1]!);
const contains = (a: number[], b: number[], margin=0) => b[0]!-margin>=a[0]! && b[1]!-margin>=a[1]! && b[2]!+margin<=a[2]! && b[3]!+margin<=a[3]!;
export function validateLayout(input: unknown) {
  const layout = layoutSchema.parse(input), {rooms, footprint, wallThicknessMm:t} = layout;
  check(footprint[0]<footprint[2] && footprint[1]<footprint[3], 'Invalid footprint');
  check(contains(layout.site,footprint,t/2), 'Exterior wall faces exceed site boundary');
  check(new Set(rooms.map(r=>r.key)).size===rooms.length && !rooms.some(r=>r.key==='outside'), 'Duplicate/reserved room key');
  check(new Set(rooms.map(r=>r.name)).size===rooms.length, 'Duplicate room name');
  for (const r of rooms) {
    check(r.rect[2]-r.rect[0]>t && r.rect[3]-r.rect[1]>t && contains(footprint,r.rect), 'Room outside footprint or too small');
    for (const s of rooms) if (r.key<s.key)
      check(Math.min(r.rect[2],s.rect[2])<=Math.max(r.rect[0],s.rect[0]) || Math.min(r.rect[3],s.rect[3])<=Math.max(r.rect[1],s.rect[1]), 'Overlapping room interiors');
  }
  check(Math.abs(rooms.reduce((sum,r)=>sum+area(r.rect),0)-area(footprint))<0.01,'Rooms do not tile the footprint');
  const bedrooms=rooms.filter(r=>/^Bedroom [123]$/.test(r.name)).length;
  const names = ['Bedroom 1','Bedroom 2','Living and dining','Kitchen','Bathroom 1'];
  check(names.every(name=>rooms.some(r=>r.name===name)) && [2,3].includes(bedrooms) && rooms.filter(r=>r.name.startsWith('Bedroom ')).length===bedrooms, 'Supported 2BHK/3BHK room program mismatch');
  const edges: Omit<Segment,'key'>[]=[];
  for(const r of rooms) {
    const [x0,y0,x1,y1]=r.rect;
    edges.push({axis:'h',line:y0,lo:x0,hi:x1,rooms:[r.key]},{axis:'h',line:y1,lo:x0,hi:x1,rooms:[r.key]},
      {axis:'v',line:x0,lo:y0,hi:y1,rooms:[r.key]},{axis:'v',line:x1,lo:y0,hi:y1,rooms:[r.key]});
  }
  const walls:Segment[]=[];
  for(const group of [...new Set(edges.map(e=>`${e.axis}:${e.line}`))].sort()) {
    const same=edges.filter(e=>`${e.axis}:${e.line}`===group), axis=same[0]!.axis,line=same[0]!.line;
    const cuts=[...new Set(same.flatMap(e=>[e.lo,e.hi]))].sort((a,b)=>a-b);
    for(let i=0;i<cuts.length-1;i++) {
      const lo=cuts[i]!,hi=cuts[i+1]!,owners=same.filter(e=>e.lo<=lo&&e.hi>=hi).flatMap(e=>e.rooms).sort();
      if(!owners.length)continue;
      check(owners.length<=2,'Non-manifold wall');
      if(owners.length===1) {
        check(axis==='h' ? line===footprint[1]||line===footprint[3] : line===footprint[0]||line===footprint[2],'Unpaired internal wall');
        owners.push('outside'); owners.sort();
      }
      const prev=walls.at(-1);
      if(prev?.axis===axis&&prev.line===line&&prev.hi===lo&&prev.rooms.join()===owners.join()) prev.hi=hi;
      else walls.push({axis,line,lo,hi,rooms:owners,key:''});
    }
  }
  walls.forEach((w,i)=>w.key=`wall-${i.toString().padStart(2,'0')}`);
  const openingHosts = new Map<string,Segment>();
  const graph = new Map(['outside',...rooms.map(r=>r.key)].map(key=>[key,new Set<string>()]));
  check(new Set(layout.openings.map(o=>o.key)).size===layout.openings.length,'Duplicate opening key');
  for(const o of layout.openings) {
    check(o.rooms[0]!==o.rooms[1]&&o.rooms.every(r=>graph.has(r)),'Unknown opening adjacency');
    check(o.kind==='door' ? o.type==='door'&&o.sillMm===0 : o.type!=='door'&&o.rooms.includes('outside'),'Opening type/adjacency mismatch');
    check(o.sillMm+o.heightMm<=layout.wallHeightMm-100,'Opening exceeds wall height');
    const host=walls.find(w=>w.rooms.join()===[...o.rooms].sort().join() &&
      (w.axis==='h' ? o.point[1]===w.line&&o.point[0]>=w.lo&&o.point[0]<=w.hi : o.point[0]===w.line&&o.point[1]>=w.lo&&o.point[1]<=w.hi));
    check(host,'No matching wall host');
    const along=host.axis==='h'?o.point[0]:o.point[1];
    check(along-o.widthMm/2>=host.lo+t/2+100&&along+o.widthMm/2<=host.hi-t/2-100,'Opening too close to wall end/junction');
    for(const prior of layout.openings) if(openingHosts.get(prior.key)===host) {
      const p=host.axis==='h'?prior.point[0]:prior.point[1];
      check(Math.abs(p-along)>(prior.widthMm+o.widthMm)/2+100,'Overlapping openings');
    }
    openingHosts.set(o.key,host);
    if(o.kind==='door') {graph.get(o.rooms[0])!.add(o.rooms[1]);graph.get(o.rooms[1])!.add(o.rooms[0]);}
  }
  const reached=new Set(['outside']), queue=['outside'];
  for(let i=0;i<queue.length;i++)for(const neighbor of graph.get(queue[i]!)!) if(!reached.has(neighbor)){reached.add(neighbor);queue.push(neighbor);}
  check(rooms.every(r=>reached.has(r.key)),'A room is unreachable from the entrance');
  const areas=rooms.map(r=> {
    const clearWidthMm=r.rect[2]-r.rect[0]-t,clearDepthMm=r.rect[3]-r.rect[1]-t;
    const expectedAreaM2=clearWidthMm*clearDepthMm/1e6;
    if(r.targetAreaM2)check(Math.abs(expectedAreaM2-r.targetAreaM2)/r.targetAreaM2<=layout.targetAreaToleranceFraction,'Room target area exceeds declared tolerance');
    if(['hall','passage'].includes(r.key)) check(Math.min(clearWidthMm,clearDepthMm)>=1200,'Circulation clear width below demo minimum');
    return {key:r.key,name:r.name,expectedAreaM2,clearWidthMm,clearDepthMm,targetAreaM2:r.targetAreaM2??null};
  });
  return {layout,walls,openingHosts,areas};
}
export type Bindings = {documentId:string;revision:number;levelId:string;wall:string;floor:string;door:string;window:string;smallWindow:string};
export function compileLayout(input: unknown, bindings:Bindings) {
  const v=validateLayout(input), operations:unknown[]=[];
  for(const w of v.walls) operations.push({kind:'wall',key:w.key,typeId:bindings.wall,heightMm:v.layout.wallHeightMm,
    start:{x:w.axis==='h'?w.lo:w.line,y:w.axis==='h'?w.line:w.lo},end:{x:w.axis==='h'?w.hi:w.line,y:w.axis==='h'?w.line:w.hi}});
  const [x0,y0,x1,y1]=v.layout.footprint;
  operations.push({kind:'floor',key:'floor',typeId:bindings.floor,boundary:[{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}]});
  for(const o of v.layout.openings)operations.push({kind:o.kind,key:o.key,typeId:bindings[o.type],host:v.openingHosts.get(o.key)!.key,point:{x:o.point[0],y:o.point[1]},sillMm:o.sillMm});
  for(const r of v.layout.rooms)operations.push({kind:'room',key:r.key,name:r.name,point:{x:(r.rect[0]+r.rect[2])/2,y:(r.rect[1]+r.rect[3])/2}});
  return {changes:changeSet.parse({documentId:bindings.documentId,expectedRevision:bindings.revision,levelId:bindings.levelId,units:'mm',coordinateFrame:'revit-internal-xy',title:v.layout.id==='datumm-3bhk-orthogonal-v1'?'DATUMM 3BHK demonstration — orthogonal v1':`DATUMM ${v.layout.rooms.filter(r=>r.key.startsWith('bed')).length}BHK saved plan`,operations}),
    areas:v.areas,counts:{walls:v.walls.length,floors:1,doors:v.layout.openings.filter(o=>o.kind==='door').length,windows:v.layout.openings.filter(o=>o.kind==='window').length,rooms:v.layout.rooms.length},
    svg:renderLayout(v)};
}
function renderLayout(v:ReturnType<typeof validateLayout>) {
  const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const scale=0.06, x=(mm:number)=>50+mm*scale,y=(mm:number)=>790-mm*scale;
  const lines=['<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1000" viewBox="0 0 960 1000"><rect width="960" height="1000" fill="#f8fafc"/>',
    `<text x="50" y="35" font-family="Arial" font-size="25" font-weight="bold" fill="#0f172a">DATUMM · ${v.layout.rooms.filter(r=>r.key.startsWith('bed')).length}BHK plan</text>`,
    '<text x="50" y="59" font-family="Arial" font-size="14" fill="#475569">14 × 12 m demo boundary · dimensions in metres · north shown upward</text>'];
  lines.push(`<rect x="${x(0)}" y="${y(12000)}" width="840" height="720" fill="none" stroke="#94a3b8" stroke-dasharray="6 6"/>`);
  for(const r of v.layout.rooms) {
    const a=v.areas.find(a=>a.key===r.key)!, [x0,y0,x1,y1]=r.rect;
    const cx=x((x0+x1)/2),cy=y((y0+y1)/2);
    lines.push(`<rect x="${x(x0)}" y="${y(y1)}" width="${(x1-x0)*scale}" height="${(y1-y0)*scale}" fill="${r.key.startsWith('bed')?'#dbeafe':r.key.startsWith('bath')?'#cffafe':['hall','passage'].includes(r.key)?'#f1f5f9':'#fef3c7'}"/>`);
    const words=r.name==='Bathroom passage'?['Bathroom','passage']:r.name==='Main circulation'?['Main circulation']:[r.name];
    words.forEach((word,i)=>lines.push(`<text x="${cx}" y="${cy-15+i*15}" text-anchor="middle" font-family="Arial" font-size="${r.key==='passage'?11:13}" fill="#0f172a">${esc(word)}</text>`));
    lines.push(`<text x="${cx}" y="${cy+22}" text-anchor="middle" font-family="Arial" font-size="11" fill="#475569">${a.expectedAreaM2.toFixed(2)} m²</text>`);
    if(r.key!=='passage')lines.push(`<text x="${cx}" y="${cy+38}" text-anchor="middle" font-family="Arial" font-size="10" fill="#64748b">${((x1-x0)/1000).toFixed(2)} × ${((y1-y0)/1000).toFixed(2)} CL</text>`);
  }
  for(const w of v.walls)lines.push(`<line x1="${x(w.axis==='h'?w.lo:w.line)}" y1="${y(w.axis==='h'?w.line:w.lo)}" x2="${x(w.axis==='h'?w.hi:w.line)}" y2="${y(w.axis==='h'?w.line:w.hi)}" stroke="#334155" stroke-width="${v.layout.wallThicknessMm*scale}"/>`);
  for(const o of v.layout.openings) {
    const w=v.openingHosts.get(o.key)!,[px,py]=o.point,half=o.widthMm/2;
    lines.push(`<line x1="${x(px-(w.axis==='h'?half:0))}" y1="${y(py-(w.axis==='v'?half:0))}" x2="${x(px+(w.axis==='h'?half:0))}" y2="${y(py+(w.axis==='v'?half:0))}" stroke="${o.kind==='door'?'#f8fafc':'#0891b2'}" stroke-width="${o.kind==='door'?11:5}"/>`);
  }
  lines.push('<g font-family="Arial" font-size="14" fill="#475569"><text x="50" y="833">Wall centreline footprint: 13.60 × 10.00 m · wall thickness: 152.4 mm · height: 3 m</text><text x="50" y="860">White gaps: doors · cyan: windows · enclosed spaces include circulation rooms</text><text x="50" y="887">Areas predict clear rectangular interiors; live Revit areas will be checked before commitment.</text><text x="50" y="914">Demo assumptions: target areas allow ±30%; room read-back tolerance ±0.12 m².</text><text x="50" y="941">Concept only: no furniture, door-swing control, structure, services or compliance assessment.</text></g></svg>');
  return lines.join('\n');
}

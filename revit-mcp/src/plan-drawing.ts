/** Canonical printable drawing. All coordinates/dimensions come from validated graph. */
import type { Graph } from './plan-graph.js';
export type DrawingStyle='presentation'|'linework';
export const rendererVersion='dimensioned-v1';
const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function drawPlan(graph:Graph,fingerprint:string,style:DrawingStyle='presentation'){
 const w=graph.site.widthMm,d=graph.site.depthMm,t=graph.wallThicknessMm;
 const padding=1100,footer=2300,width=w+padding*2,height=d+padding+footer;
 const Y=(y:number)=>d-y,ink='#1c2833',thin=22;
 const text=(x:number,y:number,value:string,size=160,anchor='middle')=>`<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="${ink}">${esc(value)}</text>`;
 const line=(x1:number,y1:number,x2:number,y2:number,stroke=ink,sw=thin)=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"/>`;
 const parts=[`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-padding} ${-padding} ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="drawing-title drawing-description" data-plan-id="${graph.planId}" data-plan-version="${graph.version}" data-fingerprint="${fingerprint}" data-renderer="${rendererVersion}" data-view="${style}" font-family="Lato,Arial,sans-serif">`,
 `<title id="drawing-title">DATUMM dimensioned plan v${graph.version}</title><desc id="drawing-description">${w} by ${d} mm footprint. Clear room dimensions and areas. ${graph.site.entry} entry. ${graph.spatialContext?.northDegrees==null?'North not provided.':'North orientation provided.'} Concept only; no native model changes. Door swing directions proposed.</desc>`,
 `<rect x="${-padding}" y="${-padding}" width="${width}" height="${height}" fill="#fff"/>`];
 for(const r of graph.rooms){const [x0,y0,x1,y1]=r.rect;
  const cw=x1-x0-t,cd=y1-y0-t;
  const fill=style==='linework'?'#fff':r.kind==='bedroom'?'#e8eff5':r.kind==='bathroom'?'#e3f0eb':r.kind==='circulation'?'#f5f2ea':'#faf0d8';
  parts.push(`<rect data-room-key="${r.key}" data-clear-width-mm="${cw}" data-clear-depth-mm="${cd}" x="${x0+t/2}" y="${Y(y1)+t/2}" width="${cw}" height="${cd}" fill="${fill}"/>`);
 }
 for(const wall of graph.walls)parts.push(line(wall.start[0],Y(wall.start[1]),wall.end[0],Y(wall.end[1]),ink,t));
 for(const o of graph.openings){const wall=graph.walls.find(q=>q.key===o.wallKey)!;
  const h=wall.start[1]===wall.end[1],sign=Math.sign(h?wall.end[0]-wall.start[0]:wall.end[1]-wall.start[1]);
  const x=wall.start[0]+(h?sign*o.offsetMm:0),y=wall.start[1]+(h?0:sign*o.offsetMm);
  const xx=x+(h?sign*o.widthMm:0),yy=y+(h?0:sign*o.widthMm);
  parts.push(`<g data-opening-key="${o.key}" data-host="${o.wallKey}" data-width-mm="${o.widthMm}">`,line(x,Y(y),xx,Y(yy),'#fff',t+4));
  if(o.kind==='window'){const color=style==='linework'?ink:'#266479';parts.push(line(x+(h?0:t/4),Y(y)+(h?t/4:0),xx+(h?0:t/4),Y(yy)+(h?t/4:0),color,thin),line(x-(h?0:t/4),Y(y)-(h?t/4:0),xx-(h?0:t/4),Y(yy)-(h?t/4:0),color,thin));}
  else {const room=graph.rooms.find(r=>r.key===wall.roomKeys[0])!;
   const inward=h?((room.rect[1]+room.rect[3])/2>y?1:-1):((room.rect[0]+room.rect[2])/2>x?1:-1);
   const lx=x+(h?0:inward*o.widthMm),ly=y+(h?inward*o.widthMm:0);
   parts.push(line(x,Y(y),lx,Y(ly),ink,thin),`<path d="M ${xx} ${Y(yy)} A ${o.widthMm} ${o.widthMm} 0 0 ${(h?sign*inward:-sign*inward)>0?1:0} ${lx} ${Y(ly)}" fill="none" stroke="${ink}" stroke-width="${thin}"/>`);
   if(o.key==='entry')parts.push(text((x+xx)/2+(h?0:-420),(Y(y)+Y(yy))/2+(h?430:0),'ENTRY',145));
  }
  parts.push('</g>');
 }
 for(const f of graph.furnitureIntents??[]){const [x0,y0,x1,y1]=f.rect;parts.push(`<rect x="${x0}" y="${Y(y1)}" width="${x1-x0}" height="${y1-y0}" fill="none" stroke="${ink}" stroke-width="${thin}" stroke-dasharray="70 40"/>`,text((x0+x1)/2,Y((y0+y1)/2),`Proposed ${f.kind}`,120));}
 for(const r of graph.rooms){const [x0,y0,x1,y1]=r.rect,cw=x1-x0-t,cd=y1-y0-t;
  const size=Math.min(190,Math.max(150,cw/14)),x=(x0+x1)/2,y=Y((y0+y1)/2);
  const name=r.name.length>22?r.name.slice(0,21)+'…':r.name;
  const rotate=cw<2000&&cd>cw*3;
  if(rotate)parts.push(`<g transform="rotate(-90 ${x} ${y})">`);
  parts.push(text(x,y-size,name,size),text(x,y+size*.35,`${cw} × ${cd} mm clear`,size*.75),text(x,y+size*1.6,`${(cw*cd/1e6).toFixed(1)} m²`,size*.85));
  if(rotate)parts.push('</g>');
 }
 // Overall dimensions refer to exact declared footprint, not centerline bounds.
 parts.push(line(0,-480,w,-480),line(0,-650,0,-250),line(w,-650,w,-250),line(-70,-410,70,-550),line(w-70,-410,w+70,-550),text(w/2,-620,`${w} mm (${(w/304.8).toFixed(2)} ft)`));
 parts.push(line(w+480,0,w+480,d),line(w+250,0,w+650,0),line(w+250,d,w+650,d),`<text transform="translate(${w+720} ${d/2}) rotate(-90)" font-size="160" text-anchor="middle" fill="${ink}">${d} mm (${(d/304.8).toFixed(2)} ft)</text>`);
 const bottom=d+560;
 // Narrow supported footprints still need the complete legend and identity to fit.
 const footerScale=Math.min(1,(w+800)/7000);
 const footerText=(x:number,y:number,value:string,size:number,anchor='start')=>text(x,y,value,size*footerScale,anchor);
 parts.push(footerText(0,bottom,`DATUMM · Plan v${graph.version} · ${style==='linework'?'Linework':'Presentation'}`,185),footerText(0,bottom+250,`Footprint ${w} × ${d} mm · walls ${t} mm · ${graph.site.entry} entry`,145));
 const north=graph.spatialContext?.northDegrees;
 parts.push(footerText(0,bottom+475,north==null?'North not provided · XY orientation only':`North ${north}° from drawing up`,145));
 if(north!=null)parts.push(`<g transform="translate(${w-300} ${bottom+200}) rotate(${north})">${line(0,200,0,-200)}<path d="M -60 -100 L 0 -200 L 60 -100" fill="none" stroke="${ink}" stroke-width="25"/>${text(0,-250,'N',150)}</g>`);
 const scale=Math.min(2000,Math.floor(w/3/1000)*1000||1000),sy=bottom+730;
 parts.push(line(0,sy,scale,sy,ink,60),line(0,sy-100,0,sy+100),line(scale,sy-100,scale,sy+100),text(scale/2,sy+230,`${scale/1000} m scale bar · fit to page`,130));
 parts.push(footerText(0,sy+490,'Legend: solid = walls; arcs = proposed door swings; double line = windows',125),footerText(0,sy+675,'Clear sizes: finish faces. Concept geometry; proposed furniture is unbound.',125),footerText(0,sy+870,`${graph.planId} v${graph.version} · SHA256 ${fingerprint.slice(0,20)}`,115),'</svg>');
 return parts.join('');
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateVariableCandidates} from '../dist/variable-candidates.js';
import {renderPlanGraph,graphFingerprint} from '../dist/plan-graph.js';
const brief=JSON.parse(readFileSync(new URL('../../tests/integration/phase5-mvp/M05/F01-brief.json',import.meta.url)));
test('dimensioned drawing styles preserve exact canonical rooms, hosts, overall values and identity',()=>{
 for(const {graph,fingerprint} of generateVariableCandidates(brief).candidates){
  for(const style of ['presentation','linework']){const svg=renderPlanGraph(graph,style);
   assert.ok(svg.includes(`data-fingerprint="${fingerprint}"`));assert.ok(svg.includes('9144 mm'));assert.ok(svg.includes('12192 mm'));
   assert.ok(svg.includes('North not provided'));assert.ok(!svg.includes('north upward'));
   for(const r of graph.rooms){assert.ok(svg.includes(`data-room-key="${r.key}"`));assert.ok(svg.includes(`${r.rect[2]-r.rect[0]-150} × ${r.rect[3]-r.rect[1]-150} mm clear`));}
   for(const o of graph.openings)assert.ok(svg.includes(`data-host="${o.wallKey}" data-width-mm="${o.widthMm}"`));
   assert.ok(svg.includes('proposed door swings'));assert.ok(!/<script|foreignObject|href=/.test(svg));
  }
  assert.equal(graphFingerprint(graph),fingerprint);
 }
});
test('labels are escaped and explicit north remains explicit',()=>{
 const graph=generateVariableCandidates(brief).candidates[0].graph;
 graph.rooms[0].name='<script>unsafe</script>';graph.spatialContext.northDegrees=35;
 const svg=renderPlanGraph(graph);assert.ok(!svg.includes('<script>'));assert.ok(svg.includes('&lt;script&gt;'));assert.ok(svg.includes('North 35°'));
});
test('smallest supported footprint keeps complete footer labels inside printable width',()=>{
 const small=structuredClone(brief);small.site.widthMm=3000;small.site.depthMm=3000;small.spatialContext.sourceDimensions=[];
 small.requirements=[{key:'studio',kind:'other',minimumAreaMm2:1000000,minimumClearWidthMm:700,adjacentTo:[]}];
 const svg=renderPlanGraph(generateVariableCandidates(small).candidates[0].graph);
 for(const match of svg.matchAll(/<text x="0" y="(\d+)" font-size="([\d.]+)" text-anchor="start"[^>]*>([^<]+)<\/text>/g)){
  if(Number(match[1])<=3000)continue;
  // A conservative average Lato glyph width guards long legend/fingerprint clipping.
  assert.ok(Number(match[2])*match[3].length*.7<=4100,match[3]);
 }
 assert.ok(svg.includes('3000 mm'));
});

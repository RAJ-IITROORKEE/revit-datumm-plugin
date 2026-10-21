import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileLayout,validateLayout} from '../dist/layout.js';
const fixture=JSON.parse(readFileSync(new URL('../../fixtures/3bhk/layout.json',import.meta.url),'utf8'));
const bindings={documentId:'5fc469ef-5cc6-4bd9-a7dc-c5683f852067',revision:0,levelId:'level',wall:'wall',floor:'floor',door:'door',window:'window',smallWindow:'small'};
test('3BHK tiles footprint, deduplicates walls, routes every room and compiles deterministically',()=>{
 const a=compileLayout(fixture,bindings),b=compileLayout(fixture,bindings);
 assert.deepEqual(a,b);assert.equal(a.counts.rooms,9);assert.equal(a.counts.doors,9);assert.equal(a.counts.windows,7);
 assert.ok(a.changes.operations.length<100);
 const {walls}=validateLayout(fixture);
 for(const w of walls)for(const other of walls)if(w.key!==other.key&&w.axis===other.axis&&w.line===other.line)
  assert.ok(Math.min(w.hi,other.hi)<=Math.max(w.lo,other.lo),'No coincident overlapping wall segments');
 assert.ok(a.areas.every(r=>r.expectedAreaM2>0));
});
for(const [name,mutate,message] of [
 ['room overlap',l=>l.rooms[1].rect[0]-=100,/Overlapping/],
 ['coverage gap',l=>l.rooms[0].rect[2]-=100,/tile/],
 ['disconnected bedroom',l=>l.openings=l.openings.filter(o=>o.key!=='bed1-door'),/unreachable/],
 ['wrong host adjacency',l=>l.openings[0].rooms=['outside','bed1'],/matching wall/],
 ['corner collision',l=>l.openings[0].point[0]=250,/too close/],
 ['opening overlap',l=>l.openings.push({...l.openings[0],key:'extra'}),/Overlapping openings/],
 ['window height',l=>l.openings.at(-1).sillMm=2900,/wall height/],
 ['target drift',l=>l.rooms[0].targetAreaM2=1,/target area/],
 ['site containment',l=>l.site[0]=200,/site boundary/],
])test(`reject ${name}`,()=>{const changed=structuredClone(fixture);mutate(changed);assert.throws(()=>validateLayout(changed),message);});

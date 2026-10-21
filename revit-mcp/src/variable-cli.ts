/** Fixed JSON-in/JSON-out entrypoint for the bounded variable-plan engine. */
import { generateVariableCandidates } from './variable-candidates.js';
import { renderPlanGraph, validatePlanGraph } from './plan-graph.js';
import { bindVariableGraph } from './variable-bindings.js';

const MAX_INPUT_BYTES=262144;
const chunks:Buffer[]=[];
let length=0;
try {
  for await(const chunk of process.stdin){
    length+=chunk.length;
    if(length>MAX_INPUT_BYTES)throw new Error('Input exceeds 256 KiB.');
    chunks.push(chunk);
  }
  const request:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!request||typeof request!=='object'||Array.isArray(request))throw new Error('Expected one JSON object.');
  const {operation,...arguments_}=request as Record<string,unknown>;
  let result:unknown;
  if(operation==='generate'&&Object.keys(arguments_).every(k=>['brief','previousGraph'].includes(k))&&'brief' in arguments_)
    result=generateVariableCandidates(arguments_.brief,arguments_.previousGraph);
  else if(operation==='validate'&&Object.keys(arguments_).length===1&&'graph' in arguments_){
    const {graph}=validatePlanGraph(arguments_.graph);
    result={valid:true,planId:graph.planId,version:graph.version};
  }else if(operation==='render'&&Object.keys(arguments_).every(k=>['graph','style'].includes(k))&&'graph' in arguments_&&(arguments_.style===undefined||['presentation','linework'].includes(arguments_.style as string))){
    result={svg:renderPlanGraph(arguments_.graph,arguments_.style as 'presentation'|'linework'|undefined)};
  }else if(operation==='bind'&&Object.keys(arguments_).length===3&&['graph','catalog','request'].every(k=>k in arguments_)){
    result=bindVariableGraph(arguments_.graph,arguments_.catalog,arguments_.request);
  }else throw new Error('Unknown operation or unexpected request field.');
  process.stdout.write(JSON.stringify({ok:true,result}));
} catch(error) {
  process.stdout.write(JSON.stringify({ok:false,error:error instanceof Error?error.message:'Invalid request.'}));
  process.exitCode=1;
}

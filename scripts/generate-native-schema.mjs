import {readFile,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {changeSet} from '../revit-mcp/dist/drafting.js';

// This is a review/package artifact. Native preflight additionally validates API references.
const schema={...z.toJSONSchema(changeSet,{target:'draft-7'}),$id:'https://datumm.local/contracts/native-drafting/v2'};
const output=new URL('../contracts/native-drafting.v2.schema.json',import.meta.url);
const text=JSON.stringify(schema,null,2)+'\n';
if(process.argv.includes('--check')){
  if(await readFile(output,'utf8')!==text)throw Error('Native drafting schema drift; rebuild MCP then regenerate.');
}else await writeFile(output,text);

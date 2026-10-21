// MCP marks confirmed native failures as errors, but their validated receipts
// are evidence the orchestrator needs to reconcile the original operation.
export function decodeToolResult(name, args, result) {
 const value=JSON.parse(result.content.find(c=>c.type==='text').text);
 if(!result.isError)return value;
 const data=value?.data, receipt=data?.receipt;
 const operationTool=name==='apply_change_set'||name==='get_operation_status';
 const matchingEnvelope=operationTool&&value?.ok===true&&value.sessionId===args.sessionId;
 const matchingReceipt=receipt&&receipt.operationId===args.operationId&&
  ['running','committed','rolled_back','failed'].includes(receipt.state)&&
  (name!=='apply_change_set'||receipt.proposalHash===args.approvalHash);
 const unknownRead=name==='get_operation_status'&&!receipt&&
  ['unknown','not_found'].includes(data?.state);
 if(matchingEnvelope&&(matchingReceipt||unknownRead))return value;
 throw new Error(value.error?.code??receipt?.error??'MCP_TOOL_FAILED');
}

export const MCP_SSE_LIMITS = { maxEvents: 64, maxEventDataBytes: 256 * 1024, maxIncompleteLineBytes: 64 * 1024 } as const;

export type SseParseResult =
  | { ok: true; events: readonly string[] }
  | { ok: false; code: 'SSE_EVENT_LIMIT'|'SSE_EVENT_TOO_LARGE'|'SSE_LINE_TOO_LARGE'|'SSE_INVALID_UTF8'; message: string };

/** Parses bounded SSE framing. Chunks may split UTF-8 code points, lines, fields, and events. */
export function parseSseChunks(chunks: Iterable<Uint8Array>): SseParseResult {
  const decoder=new TextDecoder('utf-8',{fatal:true});let pending='';let data:string[]=[];const events:string[]=[];
  const finishEvent=():SseParseResult|undefined=>{if(data.length===0)return;const value=data.join('\n');data=[];if(Buffer.byteLength(value)>MCP_SSE_LIMITS.maxEventDataBytes)return{ok:false,code:'SSE_EVENT_TOO_LARGE',message:'SSE event data exceeded the per-event limit.'};events.push(value);if(events.length>MCP_SSE_LIMITS.maxEvents)return{ok:false,code:'SSE_EVENT_LIMIT',message:'SSE response exceeded the event limit.'};};
  const line=(value:string):SseParseResult|undefined=>{if(value==='')return finishEvent();if(value.startsWith(':'))return;const colon=value.indexOf(':');const field=colon<0?value:value.slice(0,colon);let fieldValue=colon<0?'':value.slice(colon+1);if(fieldValue.startsWith(' '))fieldValue=fieldValue.slice(1);if(field==='data'){data.push(fieldValue);if(Buffer.byteLength(data.join('\n'))>MCP_SSE_LIMITS.maxEventDataBytes)return{ok:false,code:'SSE_EVENT_TOO_LARGE',message:'SSE event data exceeded the per-event limit.'};}};
  try{for(const chunk of chunks){pending+=decoder.decode(chunk,{stream:true});if(Buffer.byteLength(pending)>MCP_SSE_LIMITS.maxIncompleteLineBytes&&!pending.includes('\n')&&!pending.includes('\r'))return{ok:false,code:'SSE_LINE_TOO_LARGE',message:'SSE incomplete line exceeded the limit.'};for(;;){const match=/\r\n|\r|\n/.exec(pending);if(!match||(match[0]==='\r'&&match.index===pending.length-1))break;const current=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);const failure=line(current);if(failure)return failure;}}pending+=decoder.decode();}catch{return{ok:false,code:'SSE_INVALID_UTF8',message:'SSE response was not valid UTF-8.'};}
  for(;;){const match=/\r\n|\r|\n/.exec(pending);if(!match)break;const current=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);const failure=line(current);if(failure)return failure;}if(pending!==''){const failure=line(pending);if(failure)return failure;}const failure=finishEvent();return failure??{ok:true,events};
}

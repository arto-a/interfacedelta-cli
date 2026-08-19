import { describe,expect,it,vi } from 'vitest';
import type { RetrievalResult, SafeOutboundClient } from '../scanner/outbound-boundary';
import { observeServerCard,validateServerCard } from './server-card';

const validCard={$schema:'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',name:'example/server',version:'1.0.0',description:'Fixture card.',remotes:[{type:'streamable-http',url:'https://example.com/mcp'}]};
function client(result:RetrievalResult):SafeOutboundClient{return{get:vi.fn(async()=>result),post:async()=>{throw new Error('Server Card retrieval must not POST');}};}
function response(body:unknown,status=200):RetrievalResult{const bytes=Buffer.from(typeof body==='string'?body:JSON.stringify(body));return{ok:true,httpStatus:status,body:bytes,contentType:'application/json',headers:{'content-type':'application/json'},finalUrl:'https://example.com/card.json',durationMs:2,redirects:[]};}

describe('experimental MCP Server Card observation',()=>{
  it('validates the pinned Draft 2020-12 artifact and extracts only streamable-http remotes',async()=>{expect(validateServerCard(validCard).validation.valid).toBe(true);const observation=await observeServerCard(new URL('https://example.com'),'https://example.com/card.json',client(response({...validCard,remotes:[...validCard.remotes,{type:'sse',url:'https://example.com/sse'}]})));expect(observation).toMatchObject({status:'valid',validation:{valid:true,schemaRevision:'526201bbc80231daa40ffcdecfc9da4e54e5dc93'},remotes:[{probePolicy:'eligible'},{probePolicy:'unsupported_transport'}]});});
  it.each([['not JSON','malformed_json'],[{},'invalid']] as const)('distinguishes malformed and schema-invalid cards',async(body,status)=>expect((await observeServerCard(new URL('https://example.com'),'https://example.com/card.json',client(response(body)))).status).toBe(status));
  it.each([[404,'not_found'],[500,'unreachable']] as const)('maps HTTP %s precisely',async(httpStatus,status)=>expect((await observeServerCard(new URL('https://example.com'),'https://example.com/card.json',client(response('',httpStatus)))).status).toBe(status));
  it('preserves a hardened-boundary block',async()=>{const blocked:RetrievalResult={ok:false,code:'TARGET_BLOCKED',message:'Resolved address is not public.',durationMs:1,redirects:[]};expect(await observeServerCard(new URL('https://example.com'),'https://example.com/card.json',client(blocked))).toMatchObject({status:'blocked',error:{code:'TARGET_BLOCKED'}});});
  it('never fetches a cross-origin declaration',async()=>{const network=client(response(validCard));const result=await observeServerCard(new URL('https://example.com'),'https://third.example.com/card.json',network);expect(network.get).not.toHaveBeenCalled();expect(result.status).toBe('declared_not_fetched');});
});

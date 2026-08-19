import { describe, expect, it } from 'vitest';
import type { SafeOutboundClient, RetrievalResult } from '../scanner/outbound-boundary';
import { inspectOrigin } from './inspection-service';
import type { McpCandidateResult } from '@interfacedelta/contracts';
import validArd from './fixtures/valid-ard.json'; import invalidA2a from './fixtures/invalid-a2a.json';

function clientFor(responses: Record<string, {status: number; body: string; contentType?: string}>): SafeOutboundClient {
  return {
    async get(url): Promise<RetrievalResult> { const item = responses[url.href]??responses[url.pathname];if(!item)throw new Error(`Unexpected GET ${url.href}`); return {ok:true,httpStatus:item.status,body:Buffer.from(item.body),contentType:item.contentType,headers:{'content-type':item.contentType},finalUrl:url.href,durationMs:7,redirects:[]}; },
    async post(): Promise<RetrievalResult> { throw new Error('Unexpected MCP request'); },
  };
}
const ardPath = '/.well-known/ai-catalog.json'; const a2aPath = '/.well-known/agent-card.json';

describe('discovery inspection service', () => {
  it('distinguishes malformed JSON, schema-invalid JSON, and wrong content type', async () => {
    const report = await inspectOrigin('https://example.com/path?q=1', clientFor({
      [ardPath]:{status:200,body:JSON.stringify(validArd),contentType:'text/plain'}, [a2aPath]:{status:200,body:'{bad',contentType:'application/json'},
    }), () => new Date('2026-01-01T00:00:00Z'));
    expect(report).toMatchObject({origin:'https://example.com',inspectedAt:'2026-01-01T00:00:00.000Z',ard:{status:'valid',warnings:['CONTENT_TYPE_NOT_JSON']},a2a:{status:'invalid',error:{code:'INVALID_JSON'}}});
    const invalid = await inspectOrigin('https://example.com', clientFor({[ardPath]:{status:200,body:JSON.stringify(validArd)},[a2aPath]:{status:200,body:JSON.stringify(invalidA2a)}}));
    expect(invalid.a2a).toMatchObject({status:'invalid',error:{code:'SCHEMA_INVALID'},validation:{valid:false}});
  });
  it('distinguishes 404 from 500', async () => {
    const report = await inspectOrigin('https://example.com', clientFor({[ardPath]:{status:404,body:'not found'},[a2aPath]:{status:500,body:'error'}}));
    expect(report.ard.status).toBe('not_found'); expect(report.a2a).toMatchObject({status:'unreachable',error:{code:'HTTP_ERROR'}});
  });
  it('supports partial discovery and both missing', async () => {
    const partial = await inspectOrigin('https://example.com', clientFor({[ardPath]:{status:200,body:JSON.stringify(validArd)},[a2aPath]:{status:404,body:''}}));
    expect([partial.ard.status,partial.a2a.status]).toEqual(['valid','not_found']);
    const missing = await inspectOrigin('https://example.com', clientFor({[ardPath]:{status:404,body:''},[a2aPath]:{status:404,body:''}}));
    expect([missing.ard.status,missing.a2a.status]).toEqual(['not_found','not_found']);
  });
  it('fetches same-origin Server Cards, derives their live endpoints, and leaves cross-origin cards unfetched',async()=>{
    const ard={specVersion:'1.0',entries:[
      {identifier:'urn:air:example.com:mcp:same',displayName:'Same',type:'application/mcp-server-card+json',url:'https://example.com/card.json'},
      {identifier:'urn:air:example.com:mcp:third',displayName:'Third',type:'application/mcp-server-card+json',url:'https://third.example.com/card.json'},
    ]};
    const calls:string[]=[];const mcpClient={inspect:async(endpoint:URL,sources:McpCandidateResult['sources']):Promise<McpCandidateResult>=>{calls.push(endpoint.href);return{endpoint:endpoint.href,sources,probePolicy:'inspected',status:'valid',targetOrigin:endpoint.origin,syntacticallyEligible:true};}};
    const serverCard={$schema:'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',name:'example/server',version:'1.0.0',description:'Fixture card.',remotes:[{type:'streamable-http',url:'https://example.com/mcp'}]};
    const report=await inspectOrigin('https://example.com',clientFor({[ardPath]:{status:200,body:JSON.stringify(ard)},[a2aPath]:{status:404,body:''},'https://example.com/card.json':{status:200,body:JSON.stringify(serverCard),contentType:'application/json'}}),()=>new Date(),undefined,mcpClient);
    expect(calls).toEqual(['https://example.com/mcp']);expect(report.mcp.serverCards.find(item=>item.serverCardUrl.includes('third'))).toMatchObject({status:'declared_not_fetched'});expect(calls).not.toContain('https://example.com/card.json');
  });
});

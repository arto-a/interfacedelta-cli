import { describe, expect, it, vi } from 'vitest';
import type { LookupAddress } from 'node:dns';
import { ConstrainedHttpsClient, type Transport } from './outbound-boundary';
import type { Resolver } from './target-policy';

const publicResolver: Resolver = async () => [{address:'93.184.216.34',family:4}];
const response = (status: number, headers: Record<string,string> = {}, body = '{}') => ({status,headers,body:Buffer.from(body)});

describe('constrained HTTPS redirects and bounds', () => {
  it('follows a public HTTPS redirect and passes a lookup pinned to validated DNS', async () => {
    let call = 0; const transport: Transport = vi.fn(async (_url, options) => {
      await new Promise<void>((resolve, reject) => options.lookup!('ignored', {family:0, hints:0, all:false}, (error: NodeJS.ErrnoException | null, address: string | LookupAddress[]) => error ? reject(error) : (expect(address).toBe('93.184.216.34'), resolve())));
      return call++ === 0 ? response(302,{location:'https://other.example.com/next'}) : response(200,{'content-type':'application/json'});
    });
    const result = await new ConstrainedHttpsClient(publicResolver, transport).get(new URL('https://example.com/start'));
    expect(result).toMatchObject({ok:true}); expect(result.redirects).toHaveLength(1); expect(transport).toHaveBeenCalledTimes(2);
  });
  it('blocks a redirect to localhost before a second connection', async () => {
    const transport: Transport = vi.fn(async () => response(302,{location:'https://localhost/secret'}));
    const result = await new ConstrainedHttpsClient(publicResolver, transport).get(new URL('https://example.com/start'));
    expect(result).toMatchObject({ok:false,code:'TARGET_BLOCKED'}); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('terminates after three redirects', async () => {
    const transport: Transport = vi.fn(async () => response(302,{location:'https://example.com/again'}));
    const result = await new ConstrainedHttpsClient(publicResolver, transport).get(new URL('https://example.com/start'));
    expect(result).toMatchObject({ok:false,code:'REDIRECT_LIMIT'}); expect(transport).toHaveBeenCalledTimes(4);
  });
  it.each([['TIMEOUT','TIMEOUT'],['RESPONSE_TOO_LARGE','RESPONSE_TOO_LARGE']] as const)('normalizes %s transport failure', async (cause, expected) => {
    const transport: Transport = async () => { throw Object.assign(new Error(cause),{code:cause}); };
    await expect(new ConstrainedHttpsClient(publicResolver, transport).get(new URL('https://example.com'))).resolves.toMatchObject({ok:false,code:expected});
  });
  it('pins DNS and preserves a bounded POST body without credentials', async()=>{
    const body=Buffer.from('{"jsonrpc":"2.0"}');const transport:Transport=vi.fn(async(_url,options,_max,_timeout,sent)=>{expect(sent).toEqual(body);expect(options.headers).not.toHaveProperty('authorization');await new Promise<void>((resolve,reject)=>options.lookup!('ignored',{family:0,hints:0,all:false},(error:NodeJS.ErrnoException|null,address:string|LookupAddress[])=>error?reject(error):(expect(address).toBe('93.184.216.34'),resolve())));return response(200,{'content-type':'application/json'},'{}');});
    await expect(new ConstrainedHttpsClient(publicResolver,transport).post(new URL('https://example.com/mcp'),{body,headers:{'content-type':'application/json'},maxBodyBytes:512*1024})).resolves.toMatchObject({ok:true});
  });
  it('keeps request-scoped SSE early termination inside the pinned transport path',async()=>{const body=Buffer.from('{}');const stop=vi.fn((bytes:Buffer)=>bytes.includes(Buffer.from('\n\n')));const transport:Transport=vi.fn(async(_url,options,_max,_timeout,_sent,stopAfterBody)=>{await new Promise<void>((resolve,reject)=>options.lookup!('ignored',{family:0,hints:0,all:false},(error:NodeJS.ErrnoException|null,address:string|LookupAddress[])=>error?reject(error):(expect(address).toBe('93.184.216.34'),resolve())));const first=Buffer.from('data: {"jsonrpc":"2.0"');expect(stopAfterBody?.(first,'text/event-stream')).toBe(false);const complete=Buffer.concat([first,Buffer.from('}\n\n')]);expect(stopAfterBody?.(complete,'text/event-stream')).toBe(true);return{status:200,headers:{'content-type':'text/event-stream'},body:complete};});await new ConstrainedHttpsClient(publicResolver,transport).post(new URL('https://example.com/mcp'),{body,headers:{},maxBodyBytes:512*1024,stopAfterBody:stop});expect(transport).toHaveBeenCalledOnce();});
  it('blocks an MCP POST redirect to localhost before connection',async()=>{const transport:Transport=vi.fn(async()=>response(307,{location:'https://localhost/mcp'}));const result=await new ConstrainedHttpsClient(publicResolver,transport).post(new URL('https://example.com/mcp'),{body:Buffer.from('{}'),headers:{'content-type':'application/json'},maxBodyBytes:512*1024});expect(result).toMatchObject({ok:false,code:'TARGET_BLOCKED'});expect(transport).toHaveBeenCalledTimes(1);});
  it('does not forward a legacy MCP session identifier across origins',async()=>{let call=0;const transport:Transport=vi.fn(async(_url,options)=>{const headers=options.headers as Record<string,string>;if(call++===0){expect(headers['mcp-session-id']).toBe('private-session');return response(307,{location:'https://other.example.com/mcp'});}expect(headers['mcp-session-id']).toBeUndefined();return response(200,{'content-type':'application/json'},'{}');});await new ConstrainedHttpsClient(publicResolver,transport).post(new URL('https://example.com/mcp'),{body:Buffer.from('{}'),headers:{'content-type':'application/json','mcp-session-id':'private-session'},maxBodyBytes:512*1024});});
  it('blocks an MCP POST when DNS mixes public and private answers before transport',async()=>{const resolver:Resolver=async()=>[{address:'93.184.216.34',family:4},{address:'10.0.0.1',family:4}];const transport:Transport=vi.fn();const result=await new ConstrainedHttpsClient(resolver,transport).post(new URL('https://example.com/mcp'),{body:Buffer.from('{}'),headers:{'content-type':'application/json'},maxBodyBytes:512*1024});expect(result).toMatchObject({ok:false,code:'TARGET_BLOCKED'});expect(transport).not.toHaveBeenCalled();});
});

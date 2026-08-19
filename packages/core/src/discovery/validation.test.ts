import { describe, expect, it } from 'vitest';
import validArd from './fixtures/valid-ard.json'; import invalidArd from './fixtures/invalid-ard.json';
import validA2a from './fixtures/valid-a2a.json'; import invalidA2a from './fixtures/invalid-a2a.json';
import { sha256, validateA2a, validateArd } from './validation';

describe('pinned protocol validation', () => {
  it('validates and summarizes ARD', () => expect(validateArd(validArd)).toMatchObject({validation:{valid:true},summary:{specVersion:'1.0',entries:1,hostPresent:true}}));
  it('returns normalized ARD errors', () => expect(validateArd(invalidArd).validation).toMatchObject({valid:false,errors:expect.arrayContaining([expect.objectContaining({code:'required',instancePath:'/entries/0'})])}));
  it('validates and summarizes an A2A 1.0 Agent Card', () => expect(validateA2a(validA2a)).toMatchObject({validation:{valid:true},summary:{name:'Research Agent',agentVersion:'1.2.0',interfaceCount:1,signaturePresent:false}}));
  it('rejects schema-invalid A2A JSON', () => expect(validateA2a(invalidA2a).validation.valid).toBe(false));
  it('hashes exact parsed bytes', () => expect(sha256(Buffer.from('hello'))).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'));
  it('extracts only exact ARD MCP media-type URL declarations', () => {
    const document={specVersion:'1.0',entries:[
      {identifier:'urn:air:example.com:mcp:one',displayName:'One',type:'application/mcp-server-card+json',url:'https://example.com/mcp'},
      {identifier:'urn:air:example.com:mcp:two',displayName:'Two',type:'application/mcp-server-card+json',url:'https://example.com/mcp-two'},
      {identifier:'urn:air:example.com:other:mcp',displayName:'Contains mcp only',type:'application/json',url:'https://example.com/not-mcp'},
      {identifier:'urn:air:example.com:embedded:mcp',displayName:'Embedded',type:'application/mcp-server-card+json',data:{endpoint:'https://example.com/ignored'}},
    ]};
    expect(validateArd(document).summary?.mcpServerCardUrls).toEqual(['https://example.com/mcp','https://example.com/mcp-two']);
  });
});

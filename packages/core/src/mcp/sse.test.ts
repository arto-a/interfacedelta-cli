import { describe, expect, it } from 'vitest';
import { MCP_SSE_LIMITS, parseSseChunks } from './sse';

const encode = (value: string) => Buffer.from(value);
describe('bounded SSE framing', () => {
  it('handles LF, CRLF, comments, ignored fields, and multiline data', () => {
    const result = parseSseChunks([
      encode(
        ': keepalive\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":1,"result":{}}\r\n\r\n',
      ),
    ]);
    expect(result).toEqual({
      ok: true,
      events: ['{"jsonrpc":"2.0",\n"id":1,"result":{}}'],
    });
  });
  it('handles arbitrary chunks including split fields, CRLF, JSON, and UTF-8', () => {
    const source = 'data: {"text":"café ☕"}\r\n\r\ndata: {"second":true}\n\n';
    const bytes = encode(source);
    const chunks: Array<Uint8Array> = [];
    for (let index = 0; index < bytes.length; index += 3)
      chunks.push(bytes.subarray(index, index + 3));
    expect(parseSseChunks(chunks)).toEqual({
      ok: true,
      events: ['{"text":"café ☕"}', '{"second":true}'],
    });
  });
  it('bounds event count, event data, and incomplete lines', () => {
    const events = Array.from(
      { length: MCP_SSE_LIMITS.maxEvents + 1 },
      () => `data: {}\n\n`,
    ).join('');
    expect(parseSseChunks([encode(events)])).toMatchObject({
      ok: false,
      code: 'SSE_EVENT_LIMIT',
    });
    expect(
      parseSseChunks([
        encode(`data: ${'x'.repeat(MCP_SSE_LIMITS.maxEventDataBytes + 1)}\n\n`),
      ]),
    ).toMatchObject({ ok: false, code: 'SSE_EVENT_TOO_LARGE' });
    expect(
      parseSseChunks([
        encode('x'.repeat(MCP_SSE_LIMITS.maxIncompleteLineBytes + 1)),
      ]),
    ).toMatchObject({ ok: false, code: 'SSE_LINE_TOO_LARGE' });
  });
  it('rejects invalid UTF-8', () =>
    expect(parseSseChunks([Buffer.from([0xc3, 0x28])])).toMatchObject({
      ok: false,
      code: 'SSE_INVALID_UTF8',
    }));
});

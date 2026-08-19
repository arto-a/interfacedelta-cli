import { describe, expect, it } from 'vitest';
import { createTargetScope, targetKey } from './target-scope';
describe('inspection target scope identity', () => {
  it('normalizes irrelevant origin path, query, fragment, casing and trailing dot', () =>
    expect(
      targetKey(createTargetScope('https://EXAMPLE.com./path?q=1#x')),
    ).toBe(targetKey(createTargetScope('https://example.com/'))));
  it('normalizes equivalent explicit endpoints', () =>
    expect(
      targetKey(
        createTargetScope(
          'https://example.com',
          'https://MCP.example.com:443/api#x',
        ),
      ),
    ).toBe(
      targetKey(
        createTargetScope('https://example.com', 'https://mcp.example.com/api'),
      ),
    ));
  it('separates absent, same-origin, and cross-origin explicit MCP scopes', () => {
    const absent = targetKey(createTargetScope('https://example.com'));
    const same = targetKey(
      createTargetScope('https://example.com', 'https://example.com/mcp'),
    );
    const cross = targetKey(
      createTargetScope(
        'https://example.com',
        'https://vendor.example.org/mcp',
      ),
    );
    expect(new Set([absent, same, cross])).toHaveLength(3);
  });
});

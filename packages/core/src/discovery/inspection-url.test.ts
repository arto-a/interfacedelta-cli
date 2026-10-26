import { describe, expect, it } from 'vitest';
import { resolveInspectionUrlType } from './inspection-url';

describe('inspection URL classification', () => {
  it.each([
    ['https://learn.microsoft.com/api/mcp', 'mcp'],
    ['https://mcp-demo.example.workers.dev/mcp', 'mcp'],
    ['https://example.com/openapi.json', 'openapi'],
    ['https://example.com/swagger-v1.yaml', 'openapi'],
    ['https://example.com/.well-known/agent-card.json', 'a2a'],
    ['https://example.com/.well-known/ard.json', 'ard'],
  ] as const)('classifies reviewed Auto convention %s as %s', (value, type) => {
    expect(resolveInspectionUrlType(new URL(value), 'auto')).toBe(type);
  });

  it.each([
    'https://example.com',
    'https://example.com/account/delete',
    'https://example.com/api',
    'https://example.com/something.json',
    'https://example.com/mcp-tools',
  ])('falls back safely to service discovery for %s', (value) => {
    expect(resolveInspectionUrlType(new URL(value), 'auto')).toBe('service');
  });

  it.each(['service', 'mcp', 'openapi', 'a2a', 'ard'] as const)(
    'honors the explicit %s override for the exact submitted URL',
    (type) => {
      expect(
        resolveInspectionUrlType(
          new URL('https://example.com/nonstandard-surface'),
          type,
        ),
      ).toBe(type);
    },
  );
});

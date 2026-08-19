import { normalizeDiscoveryReport } from '@interfacedelta/core';
import type { DiscoveryReport } from '@interfacedelta/contracts';

export const discoveryFixture: DiscoveryReport = {
  inputUrl: 'https://example.com',
  origin: 'https://example.com',
  inspectedAt: '2026-08-19T00:00:00.000Z',
  ard: {
    status: 'not_found',
    discoveryUrl: 'https://example.com/.well-known/ai-catalog.json',
    durationMs: 1,
    redirects: [],
    warnings: [],
  },
  a2a: {
    status: 'not_found',
    discoveryUrl: 'https://example.com/.well-known/agent-card.json',
    durationMs: 1,
    redirects: [],
    warnings: [],
  },
  mcp: {
    totalDeclared: 0,
    totalInspected: 0,
    totalOmitted: 0,
    serverCards: [],
    candidates: [],
  },
};

export const passportFixture = () => normalizeDiscoveryReport(discoveryFixture);

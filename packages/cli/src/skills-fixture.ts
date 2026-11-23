import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { computePassportFingerprint } from '@interfacedelta/core';
import { createBaseline } from './core';
import { passportFixture } from './test-fixture';

export const SKILLS_ENDPOINT = 'https://tools.example/mcp';
export const SKILLS_SINCE = '2026-11-01T00:00:00.000Z';
export const SKILLS_AT = '2026-11-20T00:00:00.000Z';
export async function skillFile(root: string, path: string, content: string) {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
}
export async function skillBaseline(root: string, names = ['read_item']) {
  const passport = passportFixture();
  passport.endpoints.push({
    id: 'endpoint:tools',
    protocol: 'mcp',
    role: 'mcp.streamable-http',
    url: SKILLS_ENDPOINT,
    originRelationship: 'cross_origin',
    relationship: 'explicitly_inspected',
    declarationSources: [],
    observationStatus: 'observed',
    artifactRefs: [],
  });
  for (const name of names)
    passport.capabilities.push({
      id: `capability:${name}`,
      kind: 'mcp.tool',
      protocol: 'mcp',
      protocolKey: name,
      name,
      sourceEndpointId: 'endpoint:tools',
      sourceRef: 'endpoint:tools',
      metadata: {},
      inventory: { complete: true },
      fingerprint: {
        algorithm: 'sha256',
        canonicalization: 'RFC8785',
        projectionVersion: 'capability-semantic-v4',
        value: 'a'.repeat(64),
      },
      provenance: [],
    });
  passport.fingerprints.passport.value = computePassportFingerprint(passport);
  const baseline = await createBaseline(
    'https://example.com',
    undefined,
    async () => passport,
    () => new Date(SKILLS_SINCE),
  );
  await skillFile(
    root,
    '.interfacedelta/baseline.json',
    JSON.stringify(baseline),
  );
  const path = join(root, '.interfacedelta/dependencies.json');
  await skillFile(
    root,
    '.interfacedelta/dependencies.json',
    JSON.stringify({
      formatVersion: 'interfacedelta-dependencies-v1',
      dependencies: [
        {
          name: 'tools',
          url: 'https://example.com',
          baseline: 'baseline.json',
        },
      ],
    }),
  );
  return path;
}
export function skillAnswer(
  name = 'read_item',
  overrides: Record<string, unknown> = {},
) {
  return {
    recordCheck: '1',
    status: 'observed' as const,
    changedSinceTime: false,
    signature: { jws: 'signed-tool', verify: '/api/v1/record/check/verify' },
    service: { key: 'tools', endpoint: SKILLS_ENDPOINT },
    tool: { name, inputs: ['id'], annotations: {} },
    observed: { stale: false, at: SKILLS_AT, ageDays: 0 },
    change: { last: null },
    effects: { classes: [] },
    payment: { requiresPayment: false },
    ...overrides,
  };
}
export function skillGoal(tools: ReturnType<typeof skillAnswer>[]) {
  return {
    summary: {
      checked: tools.length,
      changedSinceStart: 0,
      breakingSinceStart: 0,
      notObserved: 0,
      stale: 0,
      movesMoneyOrDeletes: 0,
      asksForPayment: 0,
    },
    tools,
    summarySignature: {
      jws: 'signed-goal',
      verify: '/api/v1/record/check/verify',
    },
  };
}

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './run';
import { sanitizeTerminal } from './sanitize';
import { passportFixture } from './test-fixture';
import { computePassportFingerprint } from '@interfacedelta/core';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('InterfaceDelta CLI', () => {
  it('supports help, version, human inspection, JSON, and stable usage errors', async () => {
    const output: string[] = [], errors: string[] = [];
    expect(await runCli(['--help'], { stdout: (v) => output.push(v) })).toBe(0);
    expect(output.join('')).toContain('interfacedelta inspect');
    output.length = 0;
    expect(await runCli(['version'], { stdout: (v) => output.push(v) })).toBe(0);
    expect(output.join('')).toBe('0.1.0\n');
    output.length = 0;
    expect(await runCli(['inspect', 'https://example.com'], { inspector: async () => passportFixture(), stdout: (v) => output.push(v) })).toBe(0);
    expect(output.join('')).toContain('InterfaceDelta\n\nSubject\nhttps://example.com');
    output.length = 0;
    expect(await runCli(['inspect', 'https://example.com', '--json'], { inspector: async () => passportFixture(), stdout: (v) => output.push(v) })).toBe(0);
    expect(JSON.parse(output.join('')).formatVersion).toBe('interfacedelta-inspection-v1');
    let explicit: string | undefined;
    expect(await runCli(['inspect', 'https://example.com', '--mcp-endpoint', 'https://example.com/mcp'], { inspector: async (_url, endpoint) => { explicit = endpoint; return passportFixture(); }, stdout: () => undefined })).toBe(0);
    expect(explicit).toBe('https://example.com/mcp');
    expect(await runCli(['inspect', 'http://127.0.0.1'], { stderr: (v) => errors.push(v) })).toBe(2);
    expect(await runCli(['inspect', 'https://example.com'], { inspector: async () => { throw new Error('network failed'); }, stderr: (v) => errors.push(v) })).toBe(3);
    expect(await runCli(['unknown'], { stderr: (v) => errors.push(v) })).toBe(2);
  });

  it('returns exit 1 only for a valid policy violation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'interfacedelta-policy-'));
    dirs.push(dir);
    const baselinePath = join(dir, 'passport.json');
    const previous = passportFixture();
    previous.inventoryGroups.push({ id: 'inventory:tools', kind: 'mcp.tool', sourceRef: 'endpoint:test', attempted: true, complete: true, itemCount: 1 });
    previous.capabilities.push({ id: 'capability:search', kind: 'mcp.tool', protocol: 'mcp', protocolKey: 'search', name: 'search', sourceRef: 'endpoint:test', metadata: {}, inventory: { complete: true }, fingerprint: { algorithm: 'sha256', canonicalization: 'RFC8785', projectionVersion: 'capability-semantic-v1', value: 'a'.repeat(64) }, provenance: ['mcp:list'] });
    previous.fingerprints.passport.value = computePassportFingerprint(previous);
    const current = passportFixture();
    current.inventoryGroups.push({ id: 'inventory:tools', kind: 'mcp.tool', sourceRef: 'endpoint:test', attempted: true, complete: true, itemCount: 0 });
    current.fingerprints.passport.value = computePassportFingerprint(current);
    expect(await runCli(['baseline', 'https://example.com', '--output', baselinePath], { inspector: async () => previous, stdout: () => undefined, stderr: () => undefined })).toBe(0);
    expect(await runCli(['check', 'https://example.com', '--baseline', baselinePath], { inspector: async () => current, stdout: () => undefined, stderr: () => undefined })).toBe(1);
  });

  it('writes atomically, refuses overwrite, supports deliberate force, and checks unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'interfacedelta-cli-'));
    dirs.push(dir);
    const baseline = join(dir, 'passport.json');
    const io = { inspector: async () => passportFixture(), stdout: () => undefined, stderr: () => undefined };
    expect(await runCli(['baseline', 'https://example.com', '--output', baseline], io)).toBe(0);
    expect(JSON.parse(await readFile(baseline, 'utf8')).formatVersion).toBe('interfacedelta-baseline-v1');
    expect(await runCli(['baseline', 'https://example.com', '--output', baseline], io)).toBe(2);
    expect(await runCli(['baseline', 'https://example.com', '--output', baseline, '--force'], io)).toBe(0);
    expect(await runCli(['check', 'https://example.com', '--baseline', baseline], io)).toBe(0);
    await writeFile(baseline, '{bad json', 'utf8');
    expect(await runCli(['check', 'https://example.com', '--baseline', baseline], io)).toBe(2);
  });

  it('sanitizes terminal escape, hyperlink, controls, carriage returns, and length', () => {
    const value = '\u001b[2Jbefore\rforged\n\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007\u0000after';
    const clean = sanitizeTerminal(value, 40);
    expect(clean).not.toContain('\u001b');
    expect(clean).not.toContain('\u0000');
    expect(clean).toContain('\\r');
    expect(clean).toContain('\\n');
    expect(clean.length).toBeLessThanOrEqual(40);
  });
});

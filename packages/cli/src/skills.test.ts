import './test-network-block.cjs';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArguments, HELP } from './arguments';
import { runCli } from './run';
import * as likelyUses from './likely-uses';
import {
  formatSkills,
  matchSkillMentions,
  runSkills,
  skillConfigEndpoints,
  skillsToSarif,
  type SkillsReport,
} from './skills';
import type { StatusGoal } from './status';
import {
  skillAnswer,
  skillBaseline,
  skillFile,
  skillGoal,
  SKILLS_AT,
  SKILLS_ENDPOINT,
  SKILLS_SINCE,
} from './skills-fixture';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function workspace(names?: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'skills-'));
  roots.push(dir);
  return { dir, path: await skillBaseline(dir, names) };
}
const input = {
  endpoint: SKILLS_ENDPOINT,
  tool: 'read_item',
  sinceTime: SKILLS_SINCE,
};
const asAnswers = (answers: unknown[]) => answers as StatusGoal['tools'];
const environment = (answer = skillAnswer()) => ({
  env: { INTERFACEDELTA_AGENT_KEY: 'fixture-skills-agent-key' },
  fetch: vi.fn(
    async () => new Response(JSON.stringify(skillGoal([answer]))),
  ) as unknown as typeof fetch,
});

describe('skills record matching', () => {
  it.each([
    ['unchanged', {}, []],
    ['changed', { changedSinceTime: true }, ['tool_changed_since']],
    [
      'breaking',
      { change: { last: { at: SKILLS_AT, class: 'breaking' } } },
      ['breaking_change'],
    ],
    ['removed', { status: 'removed' }, ['tool_removed']],
    ['paid', { payment: { requiresPayment: true } }, ['asks_for_payment']],
    ['not observed', { status: 'not_observed' }, ['not_observed']],
    ['requires sign in', { status: 'requires_sign_in' }, ['not_observed']],
  ])('reports %s facts without line text', async (_name, fields, why) => {
    const { dir } = await workspace();
    const privateText = 'private instruction never printed';
    await skillFile(dir, 'SKILL.md', `Use read_item ${privateText}\n`);
    const result = await matchSkillMentions(
      dir,
      [input],
      asAnswers([skillAnswer('read_item', fields)]),
    );
    expect(result.mentions).toEqual(
      why.length
        ? [
            {
              path: 'SKILL.md',
              line: 1,
              term: 'read_item',
              tool: input.tool,
              endpoint: input.endpoint,
              why,
            },
          ]
        : [],
    );
    expect(JSON.stringify(result)).not.toContain(privateText);
  });
  it('matches short inputs and names exactly, case sensitively, without identifier substrings', async () => {
    const { dir } = await workspace();
    await skillFile(
      dir,
      'AGENTS.md',
      'read_item_v2 my_read_item Read_item identity id2\nread_item(id) id\n',
    );
    const result = await matchSkillMentions(
      dir,
      [input],
      asAnswers([skillAnswer('read_item', { changedSinceTime: true })]),
    );
    expect(result.mentions.map(({ line, term }) => ({ line, term }))).toEqual([
      { line: 2, term: 'read_item' },
      { line: 2, term: 'id' },
    ]);
  });
  it('reports only explicitly exposed removed/renamed inputs and avoids inventing removals', async () => {
    const { dir } = await workspace();
    await skillFile(
      dir,
      '.cursor/rules/api.mdc',
      'old_id legacy_id unknown id',
    );
    const answer = skillAnswer('read_item', {
      change: {
        last: {
          at: SKILLS_AT,
          class: 'non-breaking',
          removedInputs: ['old_id', 'id'],
          renamedInputs: [{ from: 'legacy_id', to: 'id' }],
        },
      },
    });
    expect(
      (
        await matchSkillMentions(dir, [input], asAnswers([answer]))
      ).mentions.map(({ term, why }) => ({ term, why })),
    ).toEqual([
      { term: 'old_id', why: ['input_not_recorded'] },
      { term: 'legacy_id', why: ['input_not_recorded'] },
    ]);
    expect(
      (await matchSkillMentions(dir, [input], asAnswers([skillAnswer()])))
        .mentions,
    ).toEqual([]);
  });
  it('does not mark old breaking changes since a later start, preserving fractional precision', async () => {
    const { dir } = await workspace();
    await skillFile(dir, 'SKILL.md', 'read_item');
    const answer = skillAnswer('read_item', {
      change: {
        last: { at: '2026-11-20T00:00:00.000001Z', class: 'breaking' },
      },
    });
    expect(
      (
        await matchSkillMentions(
          dir,
          [{ ...input, sinceTime: '2026-11-20T00:00:00.000002Z' }],
          asAnswers([answer]),
        )
      ).mentions,
    ).toEqual([]);
  });
  it('marks per-tool and total location caps and incomplete byte scans', async () => {
    const { dir } = await workspace();
    await skillFile(dir, 'SKILL.md', 'read_item id\nread_item id\n');
    const answers = asAnswers([
      skillAnswer('read_item', { changedSinceTime: true }),
    ]);
    for (const limits of [{ maxTotal: 1 }, { maxPerChange: 1 }])
      expect(
        await matchSkillMentions(dir, [input], answers, { limits }),
      ).toMatchObject({ truncated: true, mentions: [expect.any(Object)] });
    expect(
      await matchSkillMentions(dir, [input], answers, {
        limits: { maxBytes: 6 },
      }),
    ).toMatchObject({ truncated: true, mentions: [] });
  });
  it('matches shuffled answers by endpoint and tool identity, including identical names on different servers', async () => {
    const { dir } = await workspace();
    await skillFile(dir, 'SKILL.md', 'read_item');
    const other = { ...input, endpoint: 'https://other.example/mcp' };
    const result = await matchSkillMentions(
      dir,
      [input, other],
      asAnswers([
        skillAnswer('read_item', {
          status: 'removed',
          service: { key: 'other', endpoint: other.endpoint },
        }),
        skillAnswer('read_item', { status: 'not_observed' }),
      ]),
    );
    expect(
      result.mentions.map(({ endpoint, why }) => ({ endpoint, why })),
    ).toEqual([
      { endpoint: input.endpoint, why: ['not_observed'] },
      { endpoint: other.endpoint, why: ['tool_removed'] },
    ]);
  });
  it.each(['removed', 'not_observed', 'requires_sign_in'])(
    'rejects mismatched tool and endpoint identities on %s answers',
    async (status) => {
      const { dir } = await workspace();
      for (const fields of [
        { tool: { name: 'other' } },
        { service: { key: 'other', endpoint: 'https://other.example/mcp' } },
        { service: { key: 'other', endpoint: 'invalid endpoint' } },
      ])
        await expect(
          matchSkillMentions(
            dir,
            [input],
            asAnswers([skillAnswer('read_item', { status, ...fields })]),
          ),
        ).rejects.toThrow(/different|invalid endpoint/);
    },
  );
  it('rejects duplicate answer identities instead of losing a tool', async () => {
    const { dir } = await workspace();
    await expect(
      matchSkillMentions(
        dir,
        [input, { ...input, tool: 'other' }],
        asAnswers([skillAnswer(), skillAnswer()]),
      ),
    ).rejects.toThrow('duplicate');
  });
  it('scans many identifier inputs across a docs-sized file, preserving short and shared matches', async () => {
    const { dir } = await workspace();
    const checked = Array.from({ length: 40 }, (_, index) => ({
      ...input,
      tool: `tool_${index}`,
    }));
    const answers = checked.map(({ tool }, index) =>
      skillAnswer(tool, {
        changedSinceTime: true,
        tool: {
          name: tool,
          inputs: [
            ...Array.from(
              { length: 15 },
              (_, term) => `input_${index}_${term}`,
            ),
            'id',
            'x',
          ],
        },
      }),
    );
    await skillFile(
      dir,
      'guide.md',
      'unrelated prose and identifiers\n'.repeat(30_000) +
        'input_39_14 input_39_14 tool_39 tool_39_v2\nid x\n',
    );
    // A work budget catches the old lines × tools × inputs algorithm without
    // timing assertions that vary with runner load. Stop before it stalls CI.
    const compare = likelyUses.matchesWholeIdentifier;
    let comparisons = 0;
    vi.spyOn(likelyUses, 'matchesWholeIdentifier').mockImplementation(
      (line, term) => {
        if (++comparisons > 100_000)
          throw new Error('Exceeded the term-comparison work budget.');
        return compare(line, term);
      },
    );
    const result = await matchSkillMentions(dir, checked, asAnswers(answers), {
      include: ['**/*.md'],
    });
    expect(result.truncated).toBe(false);
    expect(
      result.mentions
        .slice(0, 2)
        .map(({ line, tool, term }) => ({ line, tool, term })),
    ).toEqual([
      { line: 30_001, tool: 'tool_39', term: 'tool_39' },
      { line: 30_001, tool: 'tool_39', term: 'input_39_14' },
    ]);
    expect(result.mentions).toHaveLength(82);
    expect(result.mentions.filter(({ term }) => term === 'id')).toHaveLength(
      40,
    );
    expect(result.mentions.filter(({ term }) => term === 'x')).toHaveLength(40);
  });
  it('preserves whole-name punctuation matches and marks the non-identifier fallback cap', async () => {
    const { dir } = await workspace();
    const names = Array.from({ length: 129 }, (_, index) => `input.${index}`);
    await skillFile(
      dir,
      'SKILL.md',
      'prefixinput.0 input.0suffix\ninput.0 input.0 input.128\n',
    );
    const result = await matchSkillMentions(
      dir,
      [input],
      asAnswers([
        skillAnswer('read_item', {
          changedSinceTime: true,
          tool: { name: 'read_item', inputs: names },
        }),
      ]),
    );
    expect(result.truncated).toBe(true);
    expect(result.mentions.map(({ line, term }) => ({ line, term }))).toEqual([
      { line: 2, term: 'input.0' },
    ]);
  });
  it('rejects mismatched and incomplete signed answers', async () => {
    const { dir } = await workspace();
    await expect(matchSkillMentions(dir, [input], [])).rejects.toThrow(
      'Incomplete',
    );
    await expect(
      matchSkillMentions(dir, [input], asAnswers([skillAnswer('other')])),
    ).rejects.toThrow('different');
  });
});

describe('skills command', () => {
  it('reuses REST records, preserves exact signed JSON, and writes SARIF with source locations', async () => {
    const { dir, path } = await workspace();
    await skillFile(dir, 'SKILL.md', 'private read_item(id)\n');
    const answer = skillAnswer('read_item', {
      changedSinceTime: true,
      change: {
        last: { at: SKILLS_AT, class: 'breaking', removedInputs: ['old_id'] },
      },
    });
    const signed = JSON.stringify(skillGoal([answer]), null, 3) + '\n';
    const fetcher = vi.fn(async () => new Response(signed));
    const sarif = join(dir, 'skills.sarif');
    const outcome = await runSkills(
      {
        dependencies: path,
        skillsDir: dir,
        json: true,
        sarif,
        failOn: 'breaking_change',
      },
      {
        env: { INTERFACEDELTA_AGENT_KEY: 'fixture-skills-agent-key' },
        fetch: fetcher,
      },
    );
    expect(outcome.exitCode).toBe(1);
    expect(JSON.parse(outcome.output).signedAnswers).toEqual([signed]);
    expect(outcome.report.mentions).toHaveLength(2);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(
      'https://interfacedelta.com/api/v1/record/check/goal',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      tools: [{ endpoint: input.endpoint, tool: input.tool }],
      sinceTime: input.sinceTime,
    });
    expect(init.redirect).toBe('error');
    const artifact = JSON.parse(await readFile(sarif, 'utf8'));
    expect(artifact.runs[0].results[0].locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: 'SKILL.md' },
      region: { startLine: 1 },
    });
    expect(outcome.output).not.toContain('private');
  });
  it.each(['not_observed', 'observed', 'anonymous'])(
    'associates interleaved baseline groups by identity with %s answers and gates the removed tool',
    async (mode) => {
      const { dir, path } = await workspace();
      const dependencies = [];
      const times = [SKILLS_SINCE, '2026-10-01T00:00:00.000Z', SKILLS_SINCE];
      for (const [index, name] of ['toolA', 'toolB', 'toolC'].entries()) {
        const relative = `group${index}/.interfacedelta/baseline.json`;
        await skillBaseline(join(dir, `.interfacedelta/group${index}`), [name]);
        const baseline = JSON.parse(
          await readFile(join(dir, '.interfacedelta', relative), 'utf8'),
        );
        baseline.generatedAt = times[index];
        await skillFile(
          dir,
          `.interfacedelta/${relative}`,
          JSON.stringify(baseline),
        );
        dependencies.push({
          name,
          url: 'https://example.com',
          baseline: relative,
        });
      }
      await skillFile(
        dir,
        '.interfacedelta/dependencies.json',
        JSON.stringify({
          formatVersion: 'interfacedelta-dependencies-v1',
          dependencies,
        }),
      );
      await skillFile(dir, 'SKILL.md', 'toolA\ntoolB\ntoolC');
      const batches: { tools: { tool: string }[]; sinceTime: string }[] = [];
      const signed: string[] = [];
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const batch = JSON.parse(String(init?.body));
        batches.push(batch);
        const answers = batch.tools.map(({ tool }: { tool: string }) =>
          skillAnswer(tool, {
            status:
              tool === 'toolB'
                ? 'removed'
                : tool === 'toolC' && mode === 'observed'
                  ? 'observed'
                  : 'not_observed',
            ...(mode === 'anonymous'
              ? { tool: undefined, service: undefined }
              : {}),
          }),
        );
        // Supplied identities must work even when a server reorders its answer.
        if (mode !== 'anonymous') answers.reverse();
        const raw = JSON.stringify(skillGoal(answers), null, 2) + '\n';
        signed.push(raw);
        return new Response(raw);
      });
      const outcome = await runSkills(
        { dependencies: path, skillsDir: dir, failOn: 'tool_removed' },
        {
          env: { INTERFACEDELTA_AGENT_KEY: 'fixture-skills-agent-key' },
          fetch: fetcher,
        },
      );
      expect(
        batches.map(({ tools, sinceTime }) => ({
          tools: tools.map(({ tool }) => tool),
          sinceTime,
        })),
      ).toEqual([
        { tools: ['toolA', 'toolC'], sinceTime: times[0] },
        { tools: ['toolB'], sinceTime: times[1] },
      ]);
      expect(outcome.report.checked.map(({ tool }) => tool)).toEqual([
        'toolA',
        'toolC',
        'toolB',
      ]);
      expect(
        outcome.report.mentions.map(({ tool, why }) => ({ tool, why })),
      ).toEqual([
        { tool: 'toolA', why: ['not_observed'] },
        { tool: 'toolB', why: ['tool_removed'] },
        ...(mode === 'observed'
          ? []
          : [{ tool: 'toolC', why: ['not_observed'] }]),
      ]);
      expect(outcome.report.signedAnswers).toEqual(signed);
      expect(outcome.exitCode).toBe(1);
    },
  );
  it('accumulates mentions and exact signed answers across keyed batches of 50 tools', async () => {
    const names = Array.from({ length: 51 }, (_, index) => `tool_${index}`);
    const { dir, path } = await workspace(names);
    await skillFile(dir, 'SKILL.md', names.join('\n'));
    const batches: string[][] = [];
    const signed: string[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body));
      const names = batch.tools.map(({ tool }: { tool: string }) => tool);
      batches.push(names);
      const raw =
        JSON.stringify(
          skillGoal(
            names.map((name: string) =>
              skillAnswer(name, { changedSinceTime: true }),
            ),
          ),
          null,
          3,
        ) + '\n';
      signed.push(raw);
      return new Response(raw);
    });
    const outcome = await runSkills(
      { dependencies: path, skillsDir: dir, failOn: 'tool_changed_since' },
      {
        env: { INTERFACEDELTA_AGENT_KEY: 'fixture-skills-agent-key' },
        fetch: fetcher,
      },
    );
    expect(batches).toEqual([names.slice(0, 50), names.slice(50)]);
    expect(outcome.report.checked.map(({ tool }) => tool)).toEqual(names);
    expect(
      outcome.report.mentions.map(({ tool, line, why }) => ({
        tool,
        line,
        why,
      })),
    ).toEqual(
      names.map((tool, index) => ({
        tool,
        line: index + 1,
        why: ['tool_changed_since'],
      })),
    );
    expect(outcome.report.signedAnswers).toEqual(signed);
    expect(outcome.report.signedAnswers).toHaveLength(2);
    expect(outcome.exitCode).toBe(1);
  });
  it.each(['../*.md', '/tmp/*.md', '[ab].md', ''])(
    'rejects invalid include %j before any network request',
    async (include) => {
      const { dir, path } = await workspace();
      const env = environment();
      await expect(
        runSkills(
          { dependencies: path, skillsDir: dir, skillIncludes: [include] },
          env,
        ),
      ).rejects.toThrow('--include');
      expect(env.fetch).not.toHaveBeenCalled();
    },
  );
  it('gates input_not_recorded only when an explicitly removed input is mentioned', async () => {
    const { dir, path } = await workspace();
    const env = environment(
      skillAnswer('read_item', {
        change: {
          last: {
            at: SKILLS_AT,
            class: 'non-breaking',
            removedInputs: ['old_id'],
          },
        },
      }),
    );
    const args = {
      dependencies: path,
      skillsDir: dir,
      failOn: 'input_not_recorded',
    };
    await skillFile(dir, 'SKILL.md', 'read_item unknown id');
    expect((await runSkills(args, env)).exitCode).toBe(0);
    await skillFile(dir, 'SKILL.md', 'old_id');
    const outcome = await runSkills(args, env);
    expect(outcome.exitCode).toBe(1);
    expect(
      outcome.report.mentions.map(({ term, why }) => ({ term, why })),
    ).toEqual([{ term: 'old_id', why: ['input_not_recorded'] }]);
  });
  it.each([
    [
      {
        mcpServers: { a: { url: SKILLS_ENDPOINT } },
        servers: { b: { url: 'https://other.example/mcp' } },
      },
      'either mcpServers or servers',
    ],
    [
      { mcpServers: { a: { url: SKILLS_ENDPOINT }, b: 'PRIVATE_CONFIG_URL' } },
      'object with a URL or a stdio command',
    ],
    [
      { servers: { a: { url: SKILLS_ENDPOINT }, b: [] } },
      'object with a URL or a stdio command',
    ],
    [
      { servers: { a: { url: SKILLS_ENDPOINT }, b: {} } },
      'object with a URL or a stdio command',
    ],
    [
      { servers: { a: { url: SKILLS_ENDPOINT }, b: { command: ' ' } } },
      'object with a URL or a stdio command',
    ],
  ])(
    'rejects ambiguous or malformed MCP config before fetching',
    async (config, message) => {
      const { dir, path } = await workspace();
      await skillFile(dir, 'config.json', JSON.stringify(config));
      const env = environment();
      await expect(
        runSkills(
          {
            dependencies: path,
            skillsDir: dir,
            mcpConfig: join(dir, 'config.json'),
          },
          env,
        ),
      ).rejects.toThrow(message);
      expect(env.fetch).not.toHaveBeenCalled();
    },
  );
  it('accepts stdio command objects while inspecting only public URL entries', async () => {
    const { dir } = await workspace();
    await skillFile(
      dir,
      'config.json',
      JSON.stringify({
        servers: {
          remote: { url: SKILLS_ENDPOINT },
          local: { command: 'never-executed', args: ['private'] },
        },
      }),
    );
    expect(await skillConfigEndpoints(join(dir, 'config.json'))).toEqual([
      SKILLS_ENDPOINT,
    ]);
  });
  it('distinguishes missing and symlink scan roots before fetching', async () => {
    const { dir, path } = await workspace();
    const env = environment();
    await expect(
      runSkills({ dependencies: path, skillsDir: join(dir, 'missing') }, env),
    ).rejects.toThrow('does not exist');
    await symlink(dir, join(dir, 'linked'));
    await expect(
      runSkills({ dependencies: path, skillsDir: join(dir, 'linked') }, env),
    ).rejects.toThrow('directory without symlinks');
    expect(env.fetch).not.toHaveBeenCalled();
  });
  it.each(['EACCES', 'EPERM', 'ELOOP'])(
    'reports root validation error %s without disclosing the underlying path',
    async (code) => {
      const env = environment();
      vi.spyOn(likelyUses, 'validateScanRoot').mockRejectedValueOnce(
        Object.assign(new Error('PRIVATE_PATH'), { code }),
      );
      await expect(runSkills({}, env)).rejects.toMatchObject({
        message:
          code === 'ELOOP'
            ? 'Skills directory could not be validated (ELOOP).'
            : 'Skills directory cannot be accessed (permission denied).',
      });
      expect(env.fetch).not.toHaveBeenCalled();
    },
  );
  it('uses the public check_tools goal without a key', async () => {
    const { dir, path } = await workspace();
    await skillFile(dir, 'AGENTS.md', 'read_item');
    const signed = JSON.stringify({
      result: skillGoal([skillAnswer('read_item', { status: 'not_observed' })]),
      quota: { keyless: true },
    });
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body));
      if (rpc.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result:
            rpc.method === 'initialize'
              ? { protocolVersion: '2025-03-26' }
              : { content: [{ type: 'text', text: signed }] },
        }),
      );
    });
    const outcome = await runSkills(
      { dependencies: path, skillsDir: dir, failOn: 'not_observed' },
      { env: {}, fetch: fetcher },
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.signedAnswers).toEqual([signed]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      JSON.parse(String(fetcher.mock.calls[2]![1]?.body)).params.name,
    ).toBe('check_tools');
  });
  it('keeps config secrets and ignored fields out of output and requests; never contacts configured servers', async () => {
    const { dir, path } = await workspace();
    await skillFile(dir, 'SKILL.md', 'read_item');
    const config = join(dir, 'config.json');
    const secret = 'SENSITIVE_CONFIG_VALUE';
    await skillFile(
      dir,
      'config.json',
      JSON.stringify({
        mcpServers: {
          tools: {
            url: SKILLS_ENDPOINT,
            env: { KEY: secret },
            headers: { Authorization: secret },
            args: [secret],
            command: secret,
          },
        },
      }),
    );
    const env = environment(
      skillAnswer('read_item', { changedSinceTime: true }),
    );
    const outcome = await runSkills(
      { dependencies: path, skillsDir: dir, mcpConfig: config, json: true },
      env,
    );
    expect(outcome.output).not.toContain(secret);
    expect(JSON.stringify(vi.mocked(env.fetch).mock.calls)).not.toContain(
      secret,
    );
    expect(await skillConfigEndpoints(config)).toEqual([SKILLS_ENDPOINT]);
    await skillFile(
      dir,
      'config.json',
      JSON.stringify({
        servers: { tools: { url: `https://host.example/mcp?key=${secret}` } },
      }),
    );
    await expect(skillConfigEndpoints(config)).rejects.toThrow(
      'without credentials',
    );
    await skillFile(
      dir,
      'config.json',
      JSON.stringify({
        servers: { tools: { url: 'https://other.example/mcp' } },
      }),
    );
    await expect(
      runSkills({ dependencies: path, skillsDir: dir, mcpConfig: config }, env),
    ).rejects.toThrow('no baseline');
    expect(env.fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses echoed agent credentials instead of altering signed JSON', async () => {
    const { dir, path } = await workspace();
    await skillFile(dir, 'SKILL.md', 'read_item');
    const env = environment(
      skillAnswer('read_item', { echoed: 'fixture-skills-agent-key' }),
    );
    const sarif = join(dir, 'skills.sarif');
    await expect(
      runSkills({ dependencies: path, skillsDir: dir, json: true, sarif }, env),
    ).rejects.toThrow('would contain the credential');
    await expect(readFile(sarif)).rejects.toThrow();
  });
  it('deduplicates baseline tools with the earliest baseline time', async () => {
    const { dir, path } = await workspace();
    const file = JSON.parse(await readFile(path, 'utf8'));
    const baseline = JSON.parse(
      await readFile(join(dir, '.interfacedelta/baseline.json'), 'utf8'),
    );
    baseline.generatedAt = '2026-10-01T00:00:00.000Z';
    await skillFile(
      dir,
      '.interfacedelta/other.json',
      JSON.stringify(baseline),
    );
    file.dependencies.push({
      ...file.dependencies[0],
      name: 'duplicate',
      baseline: 'other.json',
    });
    await skillFile(
      dir,
      '.interfacedelta/dependencies.json',
      JSON.stringify(file),
    );
    const env = environment();
    const checked = (
      await runSkills({ dependencies: path, skillsDir: dir }, env)
    ).report.checked;
    expect(checked).toHaveLength(1);
    expect(checked[0]!.sinceTime).toBe(baseline.generatedAt);
  });
  it('gates only matched local mentions and defaults to report only', async () => {
    const { dir, path } = await workspace();
    const env = environment(
      skillAnswer('read_item', { changedSinceTime: true }),
    );
    expect(
      (
        await runSkills(
          { dependencies: path, skillsDir: dir, failOn: 'tool_changed_since' },
          env,
        )
      ).exitCode,
    ).toBe(0);
    await skillFile(dir, 'SKILL.md', 'read_item');
    expect(
      (await runSkills({ dependencies: path, skillsDir: dir }, env)).exitCode,
    ).toBe(0);
    expect(
      (
        await runSkills(
          { dependencies: path, skillsDir: dir, failOn: 'asks_for_payment' },
          env,
        )
      ).exitCode,
    ).toBe(0);
  });
  it('returns CLI exit codes for invalid options and unavailable records', async () => {
    const { dir, path } = await workspace();
    const run = async (
      flags: string[],
      fetcher = vi.fn(async () => new Response('{}', { status: 503 })),
    ) => {
      let out = '',
        err = '';
      const code = await runCli(
        ['skills', dir, '--dependencies', path, ...flags],
        {
          stdout: (value) => {
            out += value;
          },
          stderr: (value) => {
            err += value;
          },
          status: {
            env: { INTERFACEDELTA_AGENT_KEY: 'fixture-skills-agent-key' },
            fetch: fetcher,
          },
        },
      );
      return { code, out, err };
    };
    expect((await run(['--fail-on', 'breaking'])).code).toBe(2);
    expect((await run(['--since', 'yesterday'])).code).toBe(2);
    expect((await run([])).code).toBe(3);
    expect(
      (
        await run(
          [],
          vi.fn(async () => new Response('{}')),
        )
      ).code,
    ).toBe(3);
    const count = await workspace(['a', 'b', 'c', 'd', 'e', 'f']);
    const fetcher = vi.fn();
    expect(
      await runCli(['skills', count.dir, '--dependencies', count.path], {
        stdout: () => {},
        stderr: () => {},
        status: { env: {}, fetch: fetcher },
      }),
    ).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('parses repeated include globs and documents formats and thresholds', () => {
    expect(
      parseArguments([
        'skills',
        'project',
        '--include',
        '*.md',
        '--include',
        'rules/**',
        '--sarif',
        'out.sarif',
      ]),
    ).toMatchObject({
      command: 'skills',
      skillsDir: 'project',
      skillIncludes: ['*.md', 'rules/**'],
      sarif: 'out.sarif',
    });
    for (const args of [
      ['skills', 'one', 'two'],
      ['skills', '--include'],
      ['skills', '--token', 'x'],
      ['skills', '--sarif'],
    ])
      expect(() => parseArguments(args)).toThrow();
    expect(HELP).toContain('interfacedelta skills [dir]');
    expect(HELP).toContain('interfacedelta-skills-v1');
  });
});

describe('skills golden outputs', () => {
  const report: SkillsReport = {
    formatVersion: 'interfacedelta-skills-v1',
    truncated: false,
    filesRead: 1,
    bytesRead: 12,
    checked: [input],
    mentions: [
      {
        path: 'SKILL.md',
        line: 2,
        term: 'read_item',
        tool: input.tool,
        endpoint: input.endpoint,
        why: ['breaking_change'],
      },
    ],
    signedAnswers: ['{ "signature": "verbatim" }\n'],
  };
  it('stable table, JSON and SARIF', () => {
    expect(formatSkills(report)).toMatchSnapshot();
    expect(JSON.stringify(report, null, 2)).toMatchSnapshot();
    expect(skillsToSarif(report)).toMatchSnapshot();
  });
  it('encodes unusual SARIF paths and warns on truncation', () => {
    const sarif = skillsToSarif({
      ...report,
      truncated: true,
      mentions: [{ ...report.mentions[0]!, path: 'rules/a #%.md' }],
    });
    expect(
      sarif.runs[0]!.results[0]!.locations[0]!.physicalLocation.artifactLocation
        .uri,
    ).toBe('rules/a%20%23%25.md');
    expect(
      sarif.runs[0]!.invocations[0]!.toolExecutionNotifications,
    ).toHaveLength(1);
  });
});

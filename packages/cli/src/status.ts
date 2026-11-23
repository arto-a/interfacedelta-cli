import { canonicalJson } from '@interfacedelta/core';
import type { ParsedArguments } from './arguments';
import { resolveTarget, validateBaseline } from './core';
import { baselinePathFor, loadDependencies } from './dependencies';
import { ConfigurationError } from './errors';
import { readJsonFile } from './io';
import { sanitizeTerminal } from './sanitize';
import { registerSecret } from './secrets';

export { statusSince, atOrAfter as statusAtOrAfter } from './record-client';
export type { Goal as StatusGoal } from './record-client';
export type { StatusEnvironment } from './record-client';
import {
  apiBase,
  atOrAfter as statusAtOrAfter,
  goal,
  keyless,
  parse,
  payload,
  request,
  statusSince,
  type CheckToolInput,
  type Goal,
  type StatusEnvironment,
} from './record-client';

export type InputTool = CheckToolInput & { sinceTime: string };
const KEY_HINT =
  'Get a free key with one request: POST https://interfacedelta.com/api/v1/agent-keys. Set INTERFACEDELTA_AGENT_KEY to the returned key.';

export async function statusInputs(
  args: Pick<ParsedArguments, 'dependencies' | 'since'>,
): Promise<InputTool[]> {
  const since = args.since === undefined ? undefined : statusSince(args.since);
  const file = await loadDependencies(args.dependencies);
  const tools: InputTool[] = [];
  for (const entry of file.dependencies) {
    const baseline = validateBaseline(
      await readJsonFile(baselinePathFor(file, entry), 'Baseline'),
    );
    const target = resolveTarget(entry.url, entry.mcpEndpoint ?? undefined);
    if (
      canonicalJson(target.targetScope) !== canonicalJson(baseline.targetScope)
    )
      throw new ConfigurationError(
        `Baseline for ${entry.name} belongs to a different target. Record it again with interfacedelta baseline.`,
      );
    if (target.inspectionUrl !== baseline.inspectionUrl)
      throw new ConfigurationError(
        `Baseline for ${entry.name} inspected a different URL. Record it again with interfacedelta baseline.`,
      );
    const caps = baseline.passport.capabilities.filter(
      (cap) => cap.kind === 'mcp.tool',
    );
    for (const cap of caps) {
      const endpoint = baseline.passport.endpoints.find(
        (item) => item.protocol === 'mcp' && item.id === cap.sourceEndpointId,
      )?.url;
      if (!endpoint)
        throw new ConfigurationError(
          `Baseline for ${entry.name} has no endpoint for ${cap.name}. Record it again with interfacedelta baseline.`,
        );
      const url = new URL(endpoint);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        cap.name.length < 1 ||
        cap.name.length > 128
      )
        throw new ConfigurationError(
          `Baseline for ${entry.name} has an unsupported Record Check endpoint or tool name.`,
        );
      // CLI baselines can contain older capability projections. A hash-shaped
      // string alone does not prove equivalence with today's Record Check hash.
      tools.push({
        endpoint,
        tool: cap.name,
        sinceTime: since ?? baseline.generatedAt,
      });
    }
  }
  if (!tools.length)
    throw new ConfigurationError(
      'No MCP tools found in the baselines. Record MCP dependencies with interfacedelta baseline first.',
    );
  return tools;
}

function formatGoal(
  result: Pick<Goal, 'summary' | 'tools'>,
  batch: InputTool[],
): string {
  const lines: string[] = [];
  const servers = new Map<
    string,
    { tool: Goal['tools'][number]; input: InputTool }[]
  >();
  result.tools.forEach((tool, index) => {
    const input = batch[index]!;
    const server = servers.get(input.endpoint) ?? [];
    server.push({ tool, input });
    servers.set(input.endpoint, server);
  });
  for (const [endpoint, entries] of servers) {
    lines.push(sanitizeTerminal(endpoint));
    for (const { tool, input } of entries) {
      const facts: string[] = [];
      if (tool.status !== 'observed')
        facts.push(
          'not observed by InterfaceDelta',
          ...(tool.status === 'removed'
            ? ['removed from record']
            : tool.status === 'requires_sign_in'
              ? ['requires sign-in']
              : []),
        );
      else {
        const last = tool.change!.last;
        if (
          last?.class === 'breaking' &&
          statusAtOrAfter(last.at, input.sinceTime)
        )
          facts.push('breaking since start (latest recorded change)');
        if (tool.changedSinceTime || tool.change!.changedSince)
          facts.push('changed');
        if (tool.observed!.stale) facts.push('stale');
        if (tool.payment!.requiresPayment)
          facts.push('asks for payment (HTTP 402 observed)');
        if (tool.payment!.declared?.state === 'declared_paid')
          facts.push('declared paid');
        if (
          tool.effects!.classes.some(
            (effect) =>
              effect.p >= 0.5 &&
              ['moves_money', 'deletes'].includes(effect.class),
          )
        )
          facts.push('moves money or deletes (stored AI reading)');
        if (!facts.length) facts.push('no change recorded since start');
      }
      lines.push(
        `  ${sanitizeTerminal(tool.tool?.name ?? input.tool)}: ${facts.join('; ')}`,
      );
    }
  }
  const s = result.summary;
  lines.push(
    `Goal: ${s.checked} checked; ${s.changedSinceStart} changed; ${s.breakingSinceStart} breaking since start; ${s.notObserved} not observed; ${s.stale} stale; ${s.asksForPayment} asks for payment; ${s.declaredPaid ?? 'not supplied'} declared paid; ${s.movesMoneyOrDeletes} moves money or deletes.`,
  );
  return lines.join('\n');
}

/** Shared signed Record Check client; raw responses are preserved verbatim. */
export async function checkStatusTools(
  tools: InputTool[],
  args: Pick<ParsedArguments, 'apiUrl' | 'failOn'>,
  env: StatusEnvironment,
) {
  const base = apiBase(args.apiUrl);
  const key = env.env.INTERFACEDELTA_AGENT_KEY?.trim();
  if (key) registerSecret(key);
  if (!key && tools.length > 5)
    throw new ConfigurationError(
      `Keyless status covers at most 5 tools, all-or-nothing; this project has ${tools.length}. ${KEY_HINT}`,
    );
  if (!key && new Set(tools.map((tool) => tool.sinceTime)).size > 1)
    throw new ConfigurationError(
      `Keyless status needs one shared start time. Use --since <RFC3339>, or set INTERFACEDELTA_AGENT_KEY to use each baseline's creation time. ${KEY_HINT}`,
    );
  const groups = new Map<string, InputTool[]>();
  for (const tool of tools) {
    const group = groups.get(tool.sinceTime) ?? [];
    group.push(tool);
    groups.set(tool.sinceTime, group);
  }
  const outputs: string[] = [];
  const checkedTools: Goal['tools'] = [];
  const checkedInputs: InputTool[] = [];
  const summary: Goal['summary'] = {
    checked: 0,
    changedSinceStart: 0,
    breakingSinceStart: 0,
    notObserved: 0,
    stale: 0,
    asksForPayment: 0,
    declaredPaid: 0,
    movesMoneyOrDeletes: 0,
  };
  let matched = false;
  for (const group of groups.values())
    for (let offset = 0; offset < group.length; offset += 50) {
      const batch = group.slice(offset, offset + 50);
      const response = key
        ? await (async () => {
            const raw = await request(
              env,
              new URL('/api/v1/record/check/goal', base),
              payload(batch),
              { authorization: `Bearer ${key}` },
            );
            return { raw, result: goal(parse(raw), batch.length) };
          })()
        : await keyless(env, base, batch);
      matched ||=
        args.failOn === 'changed'
          ? response.result.summary.changedSinceStart > 0
          : args.failOn === 'breaking'
            ? response.result.summary.breakingSinceStart > 0
            : false;
      outputs.push(response.raw);
      checkedTools.push(...response.result.tools);
      checkedInputs.push(...batch);
      // Only sum the server's counts; never reconstruct counts from tool flags.
      for (const field of [
        'checked',
        'changedSinceStart',
        'breakingSinceStart',
        'notObserved',
        'stale',
        'asksForPayment',
        'movesMoneyOrDeletes',
      ] as const)
        summary[field] += response.result.summary[field];
      if (
        summary.declaredPaid !== undefined &&
        response.result.summary.declaredPaid !== undefined
      )
        summary.declaredPaid += response.result.summary.declaredPaid;
      else delete summary.declaredPaid;
    }
  return { outputs, checkedTools, checkedInputs, summary, matched };
}

export async function runStatus(
  args: ParsedArguments,
  env: StatusEnvironment,
): Promise<{ output: string; exitCode: number }> {
  // Validate the origin before reading baselines, as in the released command.
  apiBase(args.apiUrl);
  const tools = await statusInputs(args);
  const { outputs, checkedTools, checkedInputs, summary, matched } =
    await checkStatusTools(tools, args, env);
  return {
    output: args.json
      ? outputs.join('\n')
      : `${formatGoal({ summary, tools: checkedTools }, checkedInputs)}\nNo recorded change is not proof of no change. Tool lines show the latest breaking change; goal counts include earlier recorded breaking changes.\nDetails: https://interfacedelta.com/atlas\n`,
    exitCode: matched ? 1 : 0,
  };
}

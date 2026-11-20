import {
  mcpChangeSignalsSchema,
  oauthDynamicRegistrationSchema,
} from '@interfacedelta/contracts';
import type {
  McpCandidateResult,
  McpChangeSignals,
  OAuthDynamicRegistration,
} from '@interfacedelta/contracts';
type State = McpChangeSignals['tools'];
const aggregate = (values: (State | undefined)[]): State =>
  values.includes('yes')
    ? 'yes'
    : values.length && values.every((value) => value === 'no')
      ? 'no'
      : 'not_observed';
/** yes = at least one endpoint declares; no = every candidate observed negative. */
export function aggregateChangeSignals(
  candidates: readonly McpCandidateResult[],
) {
  return {
    ...(candidates.some((c) => c.mcpChangeSignals)
      ? {
          mcpChangeSignals: {
            version: 'mcp-change-signals-v1' as const,
            tools: aggregate(candidates.map((c) => c.mcpChangeSignals?.tools)),
            prompts: aggregate(
              candidates.map((c) => c.mcpChangeSignals?.prompts),
            ),
            resources: aggregate(
              candidates.map((c) => c.mcpChangeSignals?.resources),
            ),
          },
        }
      : {}),
    ...(candidates.some((c) => c.oauthDynamicRegistration)
      ? {
          oauthDynamicRegistration: {
            version: 'oauth-dynamic-registration-v1' as const,
            declared: aggregate(
              candidates.map((c) => c.oauthDynamicRegistration?.declared),
            ),
          },
        }
      : {}),
  };
}
export function changeSignalFacts(
  passport?: {
    mcpChangeSignals?: unknown;
    oauthDynamicRegistration?: unknown;
  } | null,
): {
  mcpChangeSignals: McpChangeSignals;
  oauthDynamicRegistration: OAuthDynamicRegistration;
} {
  return {
    mcpChangeSignals: mcpChangeSignalsSchema.safeParse(
      passport?.mcpChangeSignals,
    ).data ?? {
      version: 'mcp-change-signals-v1',
      tools: 'not_observed',
      prompts: 'not_observed',
      resources: 'not_observed',
    },
    oauthDynamicRegistration: oauthDynamicRegistrationSchema.safeParse(
      passport?.oauthDynamicRegistration,
    ).data ?? {
      version: 'oauth-dynamic-registration-v1',
      declared: 'not_observed',
    },
  };
}

/** Retained fields only: keep older snapshot and full MCP records byte-compatible. */
export function retainedChangeSignalFacts(
  passport: Parameters<typeof changeSignalFacts>[0],
) {
  const changes = mcpChangeSignalsSchema.safeParse(passport?.mcpChangeSignals);
  const registration = oauthDynamicRegistrationSchema.safeParse(
    passport?.oauthDynamicRegistration,
  );
  return {
    ...(changes.success ? { mcpChangeSignals: changes.data } : {}),
    ...(registration.success
      ? { oauthDynamicRegistration: registration.data }
      : {}),
  };
}

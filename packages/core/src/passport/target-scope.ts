import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import {
  parsePublicHttpsEndpoint,
  parsePublicHttpsOrigin,
} from '../scanner/target-policy';

export const TARGET_SCOPE_VERSION = 'target-scope-v1' as const;

export const targetScopeSchema = z
  .object({
    scopeVersion: z.literal(TARGET_SCOPE_VERSION),
    origin: z.string().url(),
    explicitMcpEndpoint: z.string().url().nullable(),
  })
  .strict();

export type TargetScope = z.infer<typeof targetScopeSchema>;

export function createTargetScope(
  inputUrl: string,
  explicitMcpEndpoint?: string,
): TargetScope {
  return targetScopeSchema.parse({
    scopeVersion: TARGET_SCOPE_VERSION,
    origin: parsePublicHttpsOrigin(inputUrl).origin,
    explicitMcpEndpoint: explicitMcpEndpoint
      ? parsePublicHttpsEndpoint(explicitMcpEndpoint).href
      : null,
  });
}

export function targetKey(scope: TargetScope): string {
  const value = targetScopeSchema.parse(scope);
  return `sha256:${canonicalSha256({ scopeVersion: value.scopeVersion, origin: value.origin, explicitMcpEndpoint: value.explicitMcpEndpoint })}`;
}

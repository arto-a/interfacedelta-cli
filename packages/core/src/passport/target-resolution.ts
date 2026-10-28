import { resolveInspectionUrlType } from '../discovery/inspection-url';
import {
  createMonitoredTargetScope,
  monitoredPagePath,
  type MonitoredTargetScope,
} from './target-scope';

/** Invalid target input; the message is shared by hosted and CLI callers. */
export class TargetResolutionError extends Error {
  override name = 'TargetResolutionError';
}

export type ResolvedTarget = {
  targetScope: MonitoredTargetScope;
  inspectionUrl: string;
  monitoredPage: string | null;
};

/**
 * Hosted scope rules: a service URL with an inner path watches that page
 * (target-scope-v2); everything else is the origin (target-scope-v1).
 */
export function resolveTarget(
  url: string,
  mcpEndpoint?: string,
): ResolvedTarget {
  try {
    let submitted: URL;
    try {
      submitted = new URL(url);
    } catch {
      throw new TargetResolutionError(
        `Not a URL: ${url}. Give the full address, starting with https://.`,
      );
    }
    if (submitted.search || submitted.hash)
      throw new TargetResolutionError(
        'Target URLs must not carry a query or fragment.',
      );
    const monitoredPage =
      resolveInspectionUrlType(submitted, 'auto') === 'service'
        ? monitoredPagePath(url)
        : null;
    const targetScope = createMonitoredTargetScope(
      url,
      mcpEndpoint,
      monitoredPage,
    );
    const inspected = new URL(targetScope.origin);
    inspected.pathname = submitted.pathname;
    return {
      targetScope,
      inspectionUrl: `${inspected.origin}${inspected.pathname}`,
      monitoredPage,
    };
  } catch (error) {
    throw new TargetResolutionError(
      error instanceof Error ? error.message : 'Target scope is invalid.',
    );
  }
}

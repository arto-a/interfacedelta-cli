import { resolveInspectionUrlType } from '../discovery/inspection-url';
import {
  createMonitoredTargetScope,
  createDocumentTargetScope,
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
 * Shared local distribution rules. Preserve existing CLI baselines and scan
 * inputs; hosted monitor writers opt into document identity below.
 */
function resolveTargetScope(
  url: string,
  mcpEndpoint: string | undefined,
  monitorDocuments: boolean,
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
    const type = resolveInspectionUrlType(submitted, 'auto');
    const monitoredPage = type === 'service' ? monitoredPagePath(url) : null;
    const targetScope =
      monitorDocuments &&
      (type === 'openapi' || type === 'a2a' || type === 'ard')
        ? createDocumentTargetScope(url, type, mcpEndpoint)
        : createMonitoredTargetScope(url, mcpEndpoint, monitoredPage);
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

export function resolveTarget(
  url: string,
  mcpEndpoint?: string,
): ResolvedTarget {
  return resolveTargetScope(url, mcpEndpoint, false);
}

/** Hosted writers share v3 document identity without changing CLI baselines. */
export function resolveMonitoredTarget(
  url: string,
  mcpEndpoint?: string,
): ResolvedTarget {
  return resolveTargetScope(url, mcpEndpoint, true);
}

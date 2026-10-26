export { inspectOrigin } from './discovery/inspection-service';
export { ConstrainedHttpsClient } from './scanner/outbound-boundary';
export { HttpPassiveMcpClient } from './mcp/passive-client';
export {
  BEARER_TOKEN_MAX_LENGTH,
  EndpointCredentialClient,
  isBearerToken,
} from './mcp/endpoint-credential';
export { resolveInspectionUrlType } from './discovery/inspection-url';
export {
  computePassportFingerprint,
  normalizeDiscoveryReport,
  passportSemanticProjection,
} from './passport/normalize';
export {
  CHANGE_SET_PROJECTION_VERSION,
  COMPARISON_RULE_VERSION,
  changeClassificationSchema,
  comparePassports,
  comparisonStateSchema,
  type ChangeClassification,
  type ChangeCounts,
  type ChangeEvent,
  type PassportComparison,
} from './passport/drift';
export { canonicalJson, canonicalSha256 } from './passport/canonical-json';
export {
  createMonitoredTargetScope,
  createTargetScope,
  monitoredPagePath,
  MonitoredPageError,
  monitoredPageUrl,
  monitoredTargetScopeSchema,
  scopeMonitoredPage,
  targetKey,
  targetScopeSchema,
  TARGET_SCOPE_VERSION,
} from './passport/target-scope';
export type {
  MonitoredTargetScope,
  TargetScope,
} from './passport/target-scope';
export { describeChangeDetail } from './passport/change-detail';
export {
  ACTION_COPY,
  actionFor,
  attentionFor,
  COMPATIBILITY_CODES,
  DECISION_CARD_RULES_VERSION,
  domainsFor,
  type Attention,
  type Domain,
} from './analyst/rules';
export {
  defangLinks,
  stripBidiControls,
} from '@interfacedelta/common/display-text';

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
  changeMatches,
  decide,
  DecisionPolicyError,
  FAIL_SELECTORS,
  parseFailOn as parseDecisionFailOn,
  parseOnError as parseDecisionOnError,
  DECISION_RULES_VERSION,
  DOMAINS,
  GUARD_ACTIONS,
  KNOWN_CODES,
  ruleMatches,
  subjectsFor,
  wildcardMatch,
  type Acceptance,
  type Decision,
  type FailSelector,
  type Guard,
  type GuardAction,
  type OnError,
  type Rule,
  type Subject,
} from './analyst/decision-rules';
export {
  dependenciesSchema,
  DependenciesDocumentError,
  DEPENDENCIES_FORMAT_VERSION,
  guardFor,
  MAX_ACCEPTANCE_DAYS,
  MAX_ACCEPTANCES,
  MAX_DEPENDENCIES,
  MAX_RULES,
  parseDependenciesDocument,
  validateDecisions,
  type DependenciesDocument,
  type DependencyEntry,
} from './analyst/dependencies-document';
export {
  defangLinks,
  stripBidiControls,
} from '@interfacedelta/common/display-text';
export {
  resolveTarget,
  TargetResolutionError,
  type ResolvedTarget,
} from './passport/target-resolution';

export { inspectOrigin } from './discovery/inspection-service';
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
  createTargetScope,
  targetKey,
  targetScopeSchema,
  TARGET_SCOPE_VERSION,
} from './passport/target-scope';
export type { TargetScope } from './passport/target-scope';

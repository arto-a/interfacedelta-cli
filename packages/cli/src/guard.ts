// The decision rules live in the shared core, so the CLI and the hosted
// service decide every change with the same code.
export {
  decide,
  DECISION_RULES_VERSION,
  DOMAINS,
  GUARD_ACTIONS,
  KNOWN_CODES,
  ruleMatches,
  subjectsFor,
  wildcardMatch,
  type Acceptance,
  type Decision,
  type Guard,
  type GuardAction,
  type Rule,
  type Subject,
} from '@interfacedelta/core';

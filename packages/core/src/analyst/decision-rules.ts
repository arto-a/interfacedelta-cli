import type { AgentPassport } from '@interfacedelta/contracts';
import type { PassportComparison } from '../passport/drift';
import {
  ACTION_COPY,
  actionFor,
  attentionFor,
  COMPATIBILITY_CODES,
  domainsFor,
  type Attention,
  type Domain,
} from './rules';

/** A change classification, or `metadata`: publisher text such as tool descriptions. */
export type FailSelector =
  'breaking' | 'non_breaking' | 'indeterminate' | 'informational' | 'metadata';

export type OnError = 'fail' | 'warn';
export const FAIL_SELECTORS: readonly FailSelector[] = [
  'breaking',
  'non_breaking',
  'indeterminate',
  'informational',
  'metadata',
];

/** A fail-on or on-error setting that is not valid; the message is user-facing. */
export class DecisionPolicyError extends Error {
  override name = 'DecisionPolicyError';
}

export function parseFailOn(value = 'breaking'): FailSelector[] {
  const values = [...new Set(value.split(',').map((item) => item.trim()))];
  if (
    values.length === 0 ||
    values.some((item) => !FAIL_SELECTORS.includes(item as FailSelector))
  )
    throw new DecisionPolicyError(
      `fail-on must be a comma-separated list of ${FAIL_SELECTORS.join(', ')}.`,
    );
  return values as FailSelector[];
}

export function parseOnError(value = 'fail'): OnError {
  if (value !== 'fail' && value !== 'warn')
    throw new DecisionPolicyError('on-error must be fail or warn.');
  return value;
}

type Change = PassportComparison['changes'][number];

/** Whether a change matches a fail-on selector list. */
export const changeMatches = (change: Change, failOn: FailSelector[]) =>
  failOn.includes(change.classification) ||
  (failOn.includes('metadata') &&
    change.code === 'CAPABILITY_METADATA_CHANGED');

/**
 * decision-rules-v1: what a team decided to do about each change. The
 * classification is never changed; a decision only says whether this
 * repository blocks on it, who owns it, and what to do next.
 */
export const DECISION_RULES_VERSION = 'decision-rules-v1' as const;

export type GuardAction = 'block' | 'warn' | 'allow';
export const GUARD_ACTIONS: readonly GuardAction[] = ['block', 'warn', 'allow'];
export const DOMAINS: readonly Domain[] = [
  'product',
  'security_compliance',
  'finance',
];
export const KNOWN_CODES: ReadonlySet<string> = new Set(COMPATIBILITY_CODES);

export type Rule = {
  id: string;
  /** Every listed field must match; within a field any value may. Empty matches all. */
  when: {
    dependency?: string[];
    classification?: string[];
    code?: string[];
    domain?: Domain[];
    /** Capability or endpoint names; `*` matches any run of characters. */
    name?: string[];
  };
  then: GuardAction;
  owner?: string;
  note?: string;
};

/** One reviewed change tolerated until a date. */
export type Acceptance = {
  dependency: string;
  /** The change's semanticId, as `check` prints it. */
  change: string;
  reason: string;
  /** YYYY-MM-DD, inclusive, in UTC. */
  expires: string;
  by?: string;
};

export type Guard = {
  /** The dependency being checked, when the run uses a dependencies file. */
  dependency?: string;
  /** The dependency's owner, or the file's default owner. */
  owner?: string;
  rules?: readonly Rule[];
  accepted?: readonly Acceptance[];
  now?: () => Date;
};

export type Subject = {
  kind: string;
  name: string;
  /** The endpoint the bearer token was sent to: its access changes describe the signed-in view. */
  signedIn?: true;
};

export type Decision = {
  change: string;
  action: GuardAction;
  source: 'acceptance' | 'rule' | 'policy';
  rule?: string;
  owner?: string;
  note?: string;
  accepted?: { reason: string; expires: string; by?: string };
  card: { attention: Attention; domains: Domain[]; step: string };
};

/**
 * Names for the capabilities and endpoints the changes touch, from both views.
 * Add and remove changes name a capability by its id; schema and parameter
 * changes by its protocol key, alone or followed by a space and a suffix
 * (`GET /orders query:limit`), so the longest matching key wins.
 */
export function subjectsFor(
  passports: readonly AgentPassport[],
  changes: readonly Change[],
): Record<string, Subject> {
  const wanted = new Set(changes.map((change) => change.entityId));
  const byId = new Map<string, Subject>(),
    byKey = new Map<string, Subject>();
  for (const passport of passports) {
    for (const item of passport.capabilities) {
      const subject = { kind: item.kind, name: item.name };
      byId.set(item.id, subject);
      if (item.protocolKey) byKey.set(item.protocolKey, subject);
    }
    for (const item of passport.endpoints)
      byId.set(item.id, { kind: `${item.protocol}.endpoint`, name: item.url });
  }
  const keys = [...byKey.keys()].sort((a, b) => b.length - a.length);
  const subjects: Record<string, Subject> = {};
  for (const id of wanted) {
    const key = byKey.has(id)
      ? id
      : keys.find((candidate) => id.startsWith(`${candidate} `));
    const subject = byId.get(id) ?? (key ? byKey.get(key) : undefined);
    if (subject) subjects[id] = subject;
  }
  return subjects;
}

/**
 * `*` matches any run of characters, newlines included. Linear-time greedy
 * matching: a pattern from the repository never backtracks exponentially
 * over a name the remote server chose.
 */
export function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0,
    t = 0,
    star = -1,
    mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

const today = (now: Date) => now.toISOString().slice(0, 10);

export function ruleMatches(
  rule: Rule,
  change: Change,
  domains: readonly Domain[],
  subject: Subject | undefined,
  dependency: string | undefined,
) {
  const { when } = rule;
  return (
    (!when.dependency ||
      (dependency !== undefined && when.dependency.includes(dependency))) &&
    (!when.classification ||
      when.classification.includes(change.classification)) &&
    (!when.code || when.code.includes(change.code)) &&
    (!when.domain || when.domain.some((domain) => domains.includes(domain))) &&
    (!when.name ||
      (subject !== undefined &&
        when.name.some((pattern) => wildcardMatch(pattern, subject.name))))
  );
}

/**
 * One decision per change: an unexpired acceptance first, then the first
 * matching rule, then the fail-on policy (matching changes block; other
 * breaking and indeterminate changes warn; the rest are allowed).
 */
export function decide(
  changes: readonly Change[],
  subjects: Readonly<Record<string, Subject>>,
  failOn: FailSelector[],
  comparisonState: string,
  guard: Guard = {},
): { decisions: Decision[]; notes: string[] } {
  const date = today((guard.now ?? (() => new Date()))());
  const accepted = (guard.accepted ?? []).filter(
    (item) => item.dependency === guard.dependency,
  );
  const used = new Set<Acceptance>();
  const notes: string[] = [];
  const decisions = changes.map((change): Decision => {
    const event = {
      namespace: 'compatibility' as const,
      code: change.code,
      classification: change.classification,
      // Listing a service in the dependencies file is the declaration that
      // this repository depends on it.
      matched: true,
      notes: [],
    };
    const card = {
      attention: attentionFor(event, true, comparisonState),
      domains: domainsFor(event),
      step: ACTION_COPY[actionFor(event, comparisonState)].text,
    };
    const base = { change: change.semanticId, card };
    const acceptance = accepted.find(
      (item) => item.change === change.semanticId,
    );
    if (acceptance) {
      used.add(acceptance);
      if (acceptance.expires >= date)
        return {
          ...base,
          action: 'allow',
          source: 'acceptance',
          ...(guard.owner ? { owner: guard.owner } : {}),
          accepted: {
            reason: acceptance.reason,
            expires: acceptance.expires,
            ...(acceptance.by ? { by: acceptance.by } : {}),
          },
        };
      notes.push(
        `The acceptance of ${change.semanticId} expired on ${acceptance.expires}; it no longer applies.`,
      );
    }
    const rule = (guard.rules ?? []).find((item) =>
      ruleMatches(
        item,
        change,
        card.domains,
        subjects[change.entityId],
        guard.dependency,
      ),
    );
    if (rule)
      return {
        ...base,
        action: rule.then,
        source: 'rule',
        rule: rule.id,
        ...((rule.owner ?? guard.owner)
          ? { owner: rule.owner ?? guard.owner }
          : {}),
        ...(rule.note ? { note: rule.note } : {}),
      };
    return {
      ...base,
      action: changeMatches(change, failOn)
        ? 'block'
        : change.classification === 'breaking' ||
            change.classification === 'indeterminate'
          ? 'warn'
          : 'allow',
      source: 'policy',
      ...(guard.owner ? { owner: guard.owner } : {}),
    };
  });
  for (const item of accepted)
    if (!used.has(item))
      notes.push(
        item.expires >= date
          ? `The acceptance of ${item.change} matches no current change; remove it.`
          : `The acceptance of ${item.change} expired on ${item.expires} and matches no current change; remove it.`,
      );
  return { decisions, notes };
}

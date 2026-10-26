/**
 * Display-boundary helpers for text that a remote service controls.
 *
 * Both are pure and idempotent. Neither is applied to stored Passport data:
 * they run where untrusted text is rendered for a person.
 */

// Bidirectional embedding, override and isolate controls, and the directional
// marks. They can reorder how a line reads without being visible
// ("Trojan Source"). Zero-width joiners are kept: emoji sequences need them.
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

export function stripBidiControls(value: string): string {
  return value.replace(BIDI_CONTROLS, '');
}

// A scheme and the host after it, and an `@` and the domain after it. Their
// dots are defanged whatever the TLD, because the context already marks a link.
const SCHEME_HOST = /\b([a-z][a-z0-9+.-]{1,31}):\/\/([^\s/?#]*)/gi;
const MAILTO = /\bmailto:/gi;
const AT_DOMAIN = /(?<!\[)@(?!\])([a-z0-9.-]*)/gi;
// Runs of hostname characters. Each run is checked in code rather than by one
// domain regex, because a nested-quantifier domain pattern is quadratic on
// inputs such as `a.a.a.…`.
const HOST_RUN = /[a-z0-9.-]+/gi;

// Final labels of InterfaceDelta's own dotted identifiers (`mcp.tool`,
// `openapi.operation`, `a2a.skill`, …). None is a delegated TLD (checked against
// the IANA list, version 2026092500), so no client links them and they are
// left readable.
const OWN_VOCABULARY_LABELS = new Set(
  [
    'operation tool skill resource prompt parameter document schema status',
    'metadata response catalog interface revision passport findings',
  ]
    .join(' ')
    .split(' '),
);

// A bare dotted-quad IPv4 literal at the start of a run: exactly four 1–3
// digit labels, not followed by another digit or `.digit` (so versions such as
// `1.2.3` and five-label numerics are left alone). Mail clients link these.
const IPV4_LITERAL = /^(?:\d{1,3}\.){3}\d{1,3}(?!\d)(?!\.\d)/;

/**
 * True when a run looks like a hostname: two or more labels, where a label
 * after the first is alphabetic (a possible TLD) or punycode. There is no TLD
 * allowlist, because clients link new gTLDs such as `.zip`; other dotted
 * identifiers such as `Node.js` are defanged too, which is visible and
 * harmless.
 */
function linkableHost(run: string): boolean {
  if (IPV4_LITERAL.test(run)) return true;
  const labels = run.split('.');
  return (
    labels.length > 1 &&
    labels
      .slice(1)
      .some(
        (label) =>
          /^xn--[a-z0-9-]+$/i.test(label) ||
          (/^[a-z]{2,63}$/i.test(label) &&
            !OWN_VOCABULARY_LABELS.has(label.toLowerCase())),
      )
  );
}

/**
 * Defangs URL-, email-, domain- and mention-shaped substrings so that mail
 * clients and Markdown viewers do not turn them into links: `https[:]//`,
 * `mailto[:]`, `[@]`, and `[.]` in anything shaped like a host. The change
 * is visible on purpose. Zero-width characters are not used, because some
 * clients strip them before linkifying. Every pattern is linear in the input
 * length.
 */
export function defangLinks(value: string): string {
  const dots = (host: string) => host.replaceAll('.', '[.]');
  return value
    .replace(
      SCHEME_HOST,
      (_, scheme: string, host: string) => `${scheme}[:]//${dots(host)}`,
    )
    .replace(MAILTO, 'mailto[:]')
    .replace(AT_DOMAIN, (_, domain: string) => `[@]${dots(domain)}`)
    .replace(HOST_RUN, (run) => (linkableHost(run) ? dots(run) : run));
}

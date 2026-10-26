/**
 * A watched page path is stored in the target's shared history: anyone with a
 * Passport or observation link can read it, and it outlives the account. These
 * checks run only when a monitor is created, never on stored scopes, so
 * existing target keys are unaffected.
 */

// A path segment (or a `;`/`&`-separated part of one) naming a credential,
// such as `token=…`, `api_key=…`, `jsessionid=…` or `X-Amz-Signature=…`.
// Paths never carry a query, so these appear only when a credential was
// pasted into the path.
const CREDENTIAL_PARAMETER =
  /(?:^|[;&,])[a-z0-9_-]*(?:token|secret|password|passwd|signature|sig|apikey|api[_-]key|session|sessionid|sessid|sid|jwt)=/i;
// A JSON Web Token: base64url header beginning `{"`, then a payload.
const JWT = /^eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}(?:\.[a-z0-9_-]*)?$/i;

/** Why a path is refused as a monitored page, or null when it is accepted. */
export function monitoredPageCredentialReason(path: string): string | null {
  for (const segment of path.split('/')) {
    if (segment.includes('=') && CREDENTIAL_PARAMETER.test(segment))
      return 'The page path appears to contain a credential (such as token=). Watched paths are kept in shareable history, so choose a path without it.';
    if (JWT.test(segment))
      return 'The page path appears to contain a token. Watched paths are kept in shareable history, so choose a path without it.';
  }
  return null;
}

/**
 * True when a segment looks like a random identifier, such as a share-link
 * key. Only a caution: ordinary IDs such as UUIDs look the same, so paths are
 * never refused for this alone.
 */
export function monitoredPageLooksUnguessable(path: string): boolean {
  return path.split('/').some((segment) => {
    if (segment.length < 20 || !/^[a-z0-9_~.%-]+$/i.test(segment)) return false;
    const letters = /[a-z]/i.test(segment);
    const digits = /[0-9]/.test(segment);
    return (letters && digits) || /^[0-9a-f]{32,}$/i.test(segment);
  });
}

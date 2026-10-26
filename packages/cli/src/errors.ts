export class ConfigurationError extends Error {
  readonly exitCode = 2;
}

export class InspectionError extends Error {
  readonly exitCode = 3;
}

/** A bound credential is missing, refused, unused or redirected; always fails. */
export class CredentialError extends Error {
  readonly exitCode = 2;
}

/**
 * A pull request GitHub runs without secrets: `check` skips the target and
 * does not fail; `inspect` and `baseline` cannot produce anything and exit 2.
 */
export class CredentialUnavailableError extends Error {
  readonly exitCode = 2;
}

export const exitCodeFor = (error: unknown): number =>
  error instanceof ConfigurationError ||
  error instanceof CredentialError ||
  error instanceof CredentialUnavailableError
    ? error.exitCode
    : error instanceof InspectionError
      ? error.exitCode
      : 3;

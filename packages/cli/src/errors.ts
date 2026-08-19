export class ConfigurationError extends Error {
  readonly exitCode = 2;
}

export class InspectionError extends Error {
  readonly exitCode = 3;
}

export const exitCodeFor = (error: unknown): number =>
  error instanceof ConfigurationError
    ? error.exitCode
    : error instanceof InspectionError
      ? error.exitCode
      : 3;

import { CredentialError } from './errors';

/**
 * Credential values read this process. Output is checked against them: files
 * are refused if they would contain one, and terminal text is redacted.
 */
const secrets = new Set<string>();

export function registerSecret(value: string) {
  secrets.add(value);
}

export const redact = (text: string) => {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join('***');
  return result;
};

export function assertNoSecret(text: string, what: string) {
  for (const secret of secrets)
    if (text.includes(secret))
      throw new CredentialError(
        `The ${what} would contain the credential (the service echoed it); nothing was written.`,
      );
}

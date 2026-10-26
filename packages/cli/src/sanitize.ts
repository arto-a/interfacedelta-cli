import { stripBidiControls } from '@interfacedelta/core';
import { redact } from './secrets';

const escape = String.fromCharCode(27);
const bell = String.fromCharCode(7);
const ESCAPE_SEQUENCE = new RegExp(
  `${escape}(?:\\][^${bell}${escape}]*(?:${bell}|${escape}\\\\)|\\[[0-?]*[ -/]*[@-~]|[@-_])`,
  'g',
);

export function sanitizeTerminal(value: unknown, maxLength = 500): string {
  // Credentials are redacted before truncation can split one. Bidi controls
  // are removed so a name cannot display reordered (Trojan Source).
  const text = [
    ...stripBidiControls(redact(String(value ?? '')))
      .replace(ESCAPE_SEQUENCE, '')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n'),
  ]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && !(code >= 127 && code <= 159);
    })
    .join('');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

export function sanitizeGithub(value: unknown, maxLength = 500): string {
  let text = sanitizeTerminal(value, maxLength);
  while (text.includes('::')) text = text.replace(/::/g, ': :');
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigurationError } from './errors';
import { redact, registerSecret } from './secrets';

export type AgentConfigServer =
  | { kind: 'remote'; name: string; url: string; config: string }
  | { kind: 'stdio'; name: string; command: string; config: string };

/** Project config files searched, in this order, inside a directory path. */
export const PROJECT_CONFIG_FILES = [
  '.mcp.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
  '.vscode/settings.json',
] as const;

/** Claude Desktop, Cursor and VS Code user configs; read only when asked. */
export function userConfigPaths(
  platform: NodeJS.Platform,
  home: string,
): string[] {
  const claude =
    platform === 'darwin'
      ? join(
          home,
          'Library',
          'Application Support',
          'Claude',
          'claude_desktop_config.json',
        )
      : platform === 'win32'
        ? join(
            home,
            'AppData',
            'Roaming',
            'Claude',
            'claude_desktop_config.json',
          )
        : join(home, '.config', 'Claude', 'claude_desktop_config.json');
  const vscode =
    platform === 'darwin'
      ? join(
          home,
          'Library',
          'Application Support',
          'Code',
          'User',
          'settings.json',
        )
      : platform === 'win32'
        ? join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json')
        : join(home, '.config', 'Code', 'User', 'settings.json');
  return [claude, join(home, '.cursor', 'mcp.json'), vscode];
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const ENV_REFERENCE = /^\$\{[^}]*\}$/;
const CREDENTIAL_FIELD = /token|secret|password|authorization|api[-_]?key/i;
const GENERIC_SECRET_MIN_LENGTH = 8;

/** Register literal config credentials before projecting any output fields. */
function guardValue(value: unknown, credential = false) {
  if (typeof value === 'string' && value && !ENV_REFERENCE.test(value)) {
    // Guard both the header value and the credential it wraps.
    const bearer = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
    if (bearer?.[1]?.trim()) guardValue(bearer[1].trim(), true);
    const assignment = /^--?([^=]+)=(.+)$/.exec(value);
    if (assignment)
      guardValue(
        assignment[2],
        credential || CREDENTIAL_FIELD.test(assignment[1]!),
      );
    // Short ordinary flags, ports and modes are omitted by projection, but
    // are too common to use as process-wide substring redaction patterns.
    if (credential || bearer || value.length >= GENERIC_SECRET_MIN_LENGTH) {
      registerSecret(value);
      // JSON permits lone surrogates, which encodeURIComponent rejects.
      try {
        registerSecret(encodeURIComponent(value));
      } catch {
        /* literal is guarded */
      }
    }
  } else if (Array.isArray(value))
    value.forEach((child, index) => {
      const previous = value[index - 1];
      guardValue(
        child,
        credential ||
          (typeof previous === 'string' &&
            /^--?[^=]+$/.test(previous) &&
            CREDENTIAL_FIELD.test(previous)),
      );
    });
  else if (value !== null && typeof value === 'object')
    for (const [field, child] of Object.entries(value))
      guardValue(child, credential || CREDENTIAL_FIELD.test(field));
}

function guardSecrets(value: unknown) {
  if (Array.isArray(value)) value.forEach(guardSecrets);
  else
    for (const [field, child] of Object.entries(object(value))) {
      if (/^(env|headers|args)$/i.test(field)) guardValue(child);
      else if (CREDENTIAL_FIELD.test(field)) guardValue(child, true);
      else if (field === 'command' && typeof child === 'string') {
        const first = /^\s*(?:"[^"]+"|'[^']+'|\S+)/.exec(child);
        const suffix = first ? child.slice(first[0].length).trim() : '';
        if (suffix) guardValue(suffix.split(/\s+/));
      } else guardSecrets(child);
    }
}

/** Return just the executable's basename, including quoted Windows paths. */
function commandName(command: string): string {
  const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const first = match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
  return first.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

/** Output can identify a rejected URL, but never its userinfo/query/fragment. */
export function displayAgentUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return redact(url.href);
  } catch {
    return '[invalid URL]';
  }
}

function serverEntries(map: unknown, config: string): AgentConfigServer[] {
  const servers: AgentConfigServer[] = [];
  for (const [name, raw] of Object.entries(object(map))) {
    const entry = object(raw);
    if (!name)
      throw new ConfigurationError(`${config} has an unnamed MCP server.`);
    if (typeof entry.url === 'string' && entry.url.trim()) {
      servers.push({ kind: 'remote', name, url: entry.url.trim(), config });
      continue;
    }
    if (typeof entry.command === 'string' && entry.command.trim()) {
      servers.push({
        kind: 'stdio',
        name,
        command: commandName(entry.command),
        config,
      });
      continue;
    }
    throw new ConfigurationError(
      `${config}: MCP server ${redact(name)} has no usable url or command.`,
    );
  }
  return servers;
}

/**
 * One reader for every supported format, detected by content: `mcpServers`
 * (.mcp.json, Claude Desktop, Cursor), `servers` (.vscode/mcp.json) and
 * `mcp.servers` (.vscode/settings.json). Deterministic; no filesystem access.
 */
export function parseAgentConfig(
  path: string,
  contents: string,
): AgentConfigServer[] {
  return serverEntries(serverMap(path, configValue(path, contents)), path);
}

function configValue(path: string, contents: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new ConfigurationError(`${path} is not valid JSON.`);
  }
}

function serverMap(path: string, value: unknown): Record<string, unknown> {
  const root = object(value);
  const map = root.mcpServers ?? root.servers ?? object(root.mcp).servers;
  if (!map || typeof map !== 'object' || Array.isArray(map))
    throw new ConfigurationError(
      `${path} is not a recognized MCP client config: expected an mcpServers, servers or mcp.servers object.`,
    );
  return object(map);
}

export type AgentConfigOptions = {
  /** File or directory; a directory is searched for PROJECT_CONFIG_FILES. */
  path?: string;
  /** Force exactly one config file, whatever its name. */
  config?: string;
  /** Also read the user's Claude Desktop, Cursor and VS Code configs. */
  includeUserConfigs?: boolean;
};

async function existing(paths: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) {
    try {
      await access(path);
      found.push(path);
    } catch {
      // Missing optional files are skipped; required ones error on read.
    }
  }
  return found;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new ConfigurationError(`Config file could not be read: ${path}.`);
  }
}

const href = (url: string): string => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};

/** Reads and dedupes the requested configs; the first definition of a server wins. */
export async function readAgentConfigs(
  options: AgentConfigOptions,
  defaults: { home: string; platform: NodeJS.Platform } = {
    home: homedir(),
    platform: process.platform,
  },
): Promise<{ configs: string[]; servers: AgentConfigServer[] }> {
  let files: string[];
  if (options.config) {
    files = [options.config];
  } else {
    const target = resolve(options.path ?? '.');
    let stats;
    try {
      stats = await stat(target);
    } catch {
      throw new ConfigurationError(`Path could not be read: ${target}.`);
    }
    if (!stats.isFile() && !stats.isDirectory())
      throw new ConfigurationError(
        `Path is not a file or directory: ${target}.`,
      );
    files = stats.isFile()
      ? [target]
      : await existing(PROJECT_CONFIG_FILES.map((name) => join(target, name)));
    if (!files.length && !options.includeUserConfigs)
      throw new ConfigurationError(
        `No MCP client config found in ${target}. Looked for ${PROJECT_CONFIG_FILES.join(', ')}. Pass a file with --config, or add --include-user-configs.`,
      );
  }
  const configs = [...files];
  if (options.includeUserConfigs)
    configs.push(
      ...(await existing(userConfigPaths(defaults.platform, defaults.home))),
    );
  if (!configs.length)
    throw new ConfigurationError(
      'No MCP client config found. Looked for the project files and the user configs.',
    );
  const servers: AgentConfigServer[] = [];
  const seen = new Set<string>();
  const parsed: AgentConfigServer[][] = [];
  for (const file of configs) {
    const map = serverMap(file, configValue(file, await readText(file)));
    // Server names are labels, not credential field names. Guard each entry's
    // private fields before projecting any server, including later configs.
    for (const entry of Object.values(map)) guardSecrets(entry);
    parsed.push(serverEntries(map, file));
  }
  for (const entries of parsed)
    for (const server of entries) {
      const key =
        server.kind === 'remote'
          ? `remote:${href(server.url)}`
          : `stdio:${server.name}\0${server.command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      servers.push(server);
    }
  return { configs, servers };
}

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { PluginCopyProvenance } from '@canopy/protocol/plugins';

const SSH_LOGIN_SCHEME = /^(?:ssh|git\+ssh|ssh\+git)$/i;
// Git sends only `scheme://` to a remote helper. libcurl then skips extra `/`
// and `\` (https:///user:token@host) and splits userinfo at an `@` before the
// first `/`, `?` or `#`, backslashes included.
const REMOTE_ADDRESS = /^(\s*([a-z][a-z\d+.-]*):\/\/[\\/]*)([^/?#]*)([^?#]*)/i;
const WHATWG_SPECIAL_PROTOCOL = /^(?:https?|ftp|wss?):$/i;

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Redact remote URL secrets, retaining literal file paths and repository-selecting
 * SSH logins. Returns '' (no provenance URL) when a secret-bearing URL cannot be
 * sanitized; callers still install and refresh.
 */
export function stripPluginSourceCredentials(source: string): string {
  const helper = /^(\s*(?:[a-z][a-z\d+.-]*::)+)([\s\S]*)$/i.exec(source);
  const helperPrefix = helper?.[1] ?? '';
  const address = helper?.[2] ?? source;
  // Git treats file:// # and ? as path characters, not URL delimiters.
  if (/^\s*file:\/\//i.test(address)) return source;
  const remote = REMOTE_ADDRESS.exec(address);
  let stripped = address;
  if (remote) {
    const [, prefix, scheme, authority, path] = remote;
    const at = authority.lastIndexOf('@');
    const login =
      at >= 0 && SSH_LOGIN_SCHEME.test(scheme)
        ? `${authority.slice(0, at).split(':')[0]}@`
        : '';
    stripped = `${prefix}${login}${authority.slice(at + 1)}${path}`;
  }
  const parsed = parseUrl(stripped);
  const special =
    parsed !== undefined && WHATWG_SPECIAL_PROTOCOL.test(parsed.protocol);
  // The URL parser drops tabs and newlines, which can still expose a login.
  const hiddenLogin =
    special && (parsed.username !== '' || parsed.password !== '');
  if (stripped === address && !hiddenLogin) return source;
  // Only an unparseable special-scheme URL reaches here unsanitized.
  if (!special)
    return remote && !WHATWG_SPECIAL_PROTOCOL.test(`${remote[2]}:`)
      ? helperPrefix + stripped
      : '';
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return helperPrefix + parsed.href;
}

/** Only these fully qualified GitHub transports prove repository aliases. */
function normalizePluginSource(source: string): string {
  // Git transport names and SSH logins are not host/repository case aliases.
  if (!/^(?:https:\/\/|git@|ssh:\/\/git@)/.test(source)) return source;
  const github =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/)([a-z\d](?:[a-z\d-]*[a-z\d])?\/[\w.-]+)\/*$/i.exec(
      source,
    );
  const repository = github?.[1].replace(/\.git$/i, '');
  if (!repository || ['', '.', '..'].includes(repository.split('/')[1]))
    return source;
  return `https://github.com/${repository.toLowerCase()}`;
}

export function matchPluginSources(
  recorded: string,
  advertised: string,
  sourceIdentityComplete: boolean,
): 'exact' | 'alias' | 'different' {
  // Display redaction can lose repository syntax. Never use it as identity proof.
  if (
    sourceIdentityComplete !== true &&
    !/^file:/i.test(recorded) &&
    !/^[a-z]:[\\/]/i.test(recorded) &&
    recorded.includes(':')
  )
    return 'different';
  if (recorded === advertised) return 'exact';
  return normalizePluginSource(recorded) === normalizePluginSource(advertised)
    ? 'alias'
    : 'different';
}

type ReadText = (filePath: string) => string | null;

function headReference(head: string): string | undefined {
  const ref = /^ref: (refs\/.+)$/.exec(head)?.[1];
  return ref &&
    !/[\\\0]/.test(ref) &&
    !ref.split('/').some((part) => part === '..' || part === '.' || !part)
    ? ref
    : undefined;
}

/** Standard downloaded clones use the files ref backend; no Git process on resolution. */
function copyHead(root: string, readText: ReadText): string | undefined {
  try {
    const git = path.join(root, '.git');
    const head = readText(path.join(git, 'HEAD'))?.trim() ?? '';
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(head)) return head;
    const ref = headReference(head);
    if (!ref) return undefined;
    return (
      readText(path.join(git, ref))?.trim() ??
      readText(path.join(git, 'packed-refs'))
        ?.split(/\r?\n/)
        .find((line) => line.endsWith(` ${ref}`))
        ?.split(' ')[0]
    );
  } catch {
    return undefined;
  }
}

const GIT_CONFIG_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  b: '\b',
  '\\': '\\',
  '"': '"',
};

/** Decodes one config value as Git's parser does; undefined where Git rejects it. */
function gitConfigValue(text: string, start: number): string | undefined {
  let value = '';
  let trimTo: number | undefined;
  let quoted = false;
  let comment = false;
  for (let at = start; ; at++) {
    if (text[at] === '\r' && text[at + 1] === '\n') at++;
    const char = text[at];
    if (char === undefined || char === '\n') {
      if (quoted) return undefined;
      return trimTo === undefined ? value : value.slice(0, trimTo);
    }
    if (comment) continue;
    if (!quoted && /\s/.test(char)) {
      trimTo ??= value.length;
      if (value) value += char;
      continue;
    }
    if (!quoted && (char === '#' || char === ';')) {
      comment = true;
      continue;
    }
    trimTo = undefined;
    if (char === '\\') {
      if (text[at + 1] === '\r' && text[at + 2] === '\n') at++;
      const escaped = text[++at];
      if (escaped === '\n') continue;
      const decoded =
        escaped === undefined ? undefined : GIT_CONFIG_ESCAPES[escaped];
      if (decoded === undefined) return undefined;
      value += decoded;
    } else if (char === '"') quoted = !quoted;
    else value += char;
  }
}

/** Any section's `refStorage`, matching the lenient check this replaced. */
function usesReftable(config: string): boolean {
  for (const key of config.matchAll(
    /^[ \t]*(?:\[[^\]\n]*\][ \t]*)?([a-z][a-z\d-]*)[ \t]*=/gim,
  ))
    if (
      key[1].toLowerCase() === 'refstorage' &&
      gitConfigValue(config, key.index + key[0].length)?.toLowerCase() ===
        'reftable'
    )
      return true;
  return false;
}

function hasOpaqueGitLayout(root: string, readText: ReadText): boolean {
  const git = path.join(root, '.git');
  // Do not turn a valid Git layout this lightweight reader cannot inspect into
  // a reinstall loop. Standard files-backed clones still require their HEAD.
  return (
    /^gitdir: /m.test(readText(git) ?? '') ||
    usesReftable(readText(path.join(git, 'config')) ?? '')
  );
}

export function isUsablePluginCopy(
  cachePath: string,
  provenance: PluginCopyProvenance | undefined,
  readText: ReadText,
): boolean {
  // Legacy imports (including source-only provenance reconstructed on refresh)
  // had no manifest/HEAD requirement. Verify only copies with a recorded commit.
  if (!provenance?.commit) return true;
  try {
    if (provenance.manifestRequired !== false) {
      const manifest: unknown = JSON.parse(
        readText(path.join(cachePath, '.claude-plugin', 'plugin.json')) ?? '',
      );
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
        return false;
    }
    const head = copyHead(cachePath, readText);
    return head
      ? head.toLowerCase() === provenance.commit.toLowerCase()
      : hasOpaqueGitLayout(cachePath, readText);
  } catch {
    return false;
  }
}

async function readTextAsync(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Electron uses async I/O; the synchronous resolver remains worker-only. */
export async function isUsablePluginCopyAsync(
  cachePath: string,
  provenance: PluginCopyProvenance | undefined,
): Promise<boolean> {
  if (!provenance?.commit) return true;
  const files = new Map<string, string | null>();
  const read = async (file: string): Promise<string | null> => {
    const text = await readTextAsync(file);
    files.set(file, text);
    return text;
  };
  const git = path.join(cachePath, '.git');
  const [head] = await Promise.all([
    read(path.join(git, 'HEAD')),
    provenance.manifestRequired !== false
      ? read(path.join(cachePath, '.claude-plugin', 'plugin.json'))
      : Promise.resolve(null),
  ]);
  const ref = headReference(head?.trim() ?? '');
  if (ref && (await read(path.join(git, ref))) === null)
    await read(path.join(git, 'packed-refs'));
  if (!copyHead(cachePath, (file) => files.get(file) ?? null))
    await Promise.all([read(git), read(path.join(git, 'config'))]);
  return isUsablePluginCopy(
    cachePath,
    provenance,
    (file) => files.get(file) ?? null,
  );
}

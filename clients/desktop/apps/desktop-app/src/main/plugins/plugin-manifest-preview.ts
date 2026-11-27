import { isAbsolute, posix, resolve } from 'node:path';
import {
  buildPluginMemberInventory,
  classifyHarnessCompatibility,
  parseGitHubRepo,
  PLUGIN_HARNESSES,
  pluginMcpServerMember,
  readPluginMcpServerMap,
  resolvePluginPath,
  type ClaudePluginManifest,
  type CompatibilityFacetEvidence,
  type CompatibilityInventory,
  type PluginLspServerMember,
  type PluginMcpServerMember,
  type PluginModMember,
  type PublisherPluginManifest,
} from '@canopy/plugin-interop';
import {
  isPluginManifestPreviewName,
  parsePluginManifestPreviewMcpServer,
  PLUGIN_MANIFEST_PREVIEW_DESCRIPTION_MAX_LENGTH,
  PLUGIN_MANIFEST_PREVIEW_MAX_NAMES,
  PLUGIN_MANIFEST_PREVIEW_README_MAX_LENGTH,
  type HarnessCompatibilityHarness,
  type PluginInfo,
  type PluginManifestPreview,
  type PluginManifestPreviewFailure,
  type PluginManifestPreviewMcpServer,
  type PluginManifestPreviewResult,
} from '@canopy/protocol/plugins';
import { isPathInside, withContainedFile } from '../lib/path-safety';
import { readCatalogScannerFrontmatter } from '../lib/frontmatter';
import { allowsAutomaticCall } from '../local-only/policy';
import { loadMarketplacesCacheOnly } from './plugin-service';

/** Facet evidence whose MCP members keep the endpoints the preview lists. */
interface PreviewFacetEvidence extends Omit<
  CompatibilityFacetEvidence,
  'inventory'
> {
  inventory: Omit<
    CompatibilityInventory,
    'mods' | 'mcpServers' | 'lspServers'
  > & {
    mods: readonly PluginModMember[];
    mcpServers: readonly PluginMcpServerMember[];
    lspServers: readonly PluginLspServerMember[];
  };
  /**
   * Every server the facet's merged config defines, in merge order, with the
   * endpoint its Contents row shows. Null when the winning definition has no
   * URL or command to show, or an unread later config may replace it.
   */
  mcpEndpoints: ReadonlyMap<string, PluginManifestPreviewMcpServer | null>;
  /**
   * Whether an MCP config the facet's manifest names may exist but was not
   * read: it may define any server and, from a higher-priority manifest, win
   * a name a lower one defines.
   */
  mcpConfigUnread: boolean;
  /**
   * Whether an app member the facet's manifest declares is unresolved, or
   * one's installed name is unknown: its head went unread.
   */
  appsUnknown: boolean;
  /** The app member files and their installed names, for Contents rows. */
  appNames: readonly { readonly file: string; readonly name: string }[];
  /**
   * Whether a hooks or LSP config the facet names, or the usual hooks file
   * that declares Mods, may exist but was not read: it may hold any.
   */
  configUnread: boolean;
  /**
   * Hooks the installed scan finds in the configs the facet read: zero when
   * none was read, or the ones read hold only Mods.
   */
  hookCount: number;
}

/**
 * Customize's light preview of a plugin not added yet (spec 3b): the
 * repository's file listing and its native manifests, read without cloning,
 * classified by the same compatibility rules as a scanned plugin. Cached in
 * memory like the logo cache; a host that asks us to wait is waited for.
 */

const API_HOST = 'https://api.github.com';
const RAW_HOST = 'https://raw.githubusercontent.com';
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 750;
const MAX_TREE_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
/** Front matter sits at the top; a skill file's body is never needed. */
const MAX_MEMBER_FILE_BYTES = 32 * 1024;
/** Skill, command and agent files read for a name and description, in all. */
const MAX_DESCRIPTION_FILES = 40;
const OPTIONAL_READ_CONCURRENCY = 6;
/** A manifest may list arbitrarily many files; keep this a light preview. */
const MAX_CONFIG_FILES = 40;
/**
 * Native manifests, the README, descriptions and configs share one deadline.
 * What has arrived by then is kept; what has not leaves its harness unknown.
 */
const OPTIONAL_READS_DEADLINE_MS = 15_000;
/** The README the installed and checkout readers show: README.md at the root. */
const README_PATTERN = /^readme\.md$/i;
const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;
/**
 * Members as the installed scan and the Cursor stager find them: a skill
 * folder's SKILL.md, and command and agent files directly in their folder.
 * A command file in a subfolder is never loaded, so it is not counted.
 */
interface MemberLayout {
  readonly pattern: RegExp;
  /** The member's name from the pattern's one capture. */
  readonly name: (captured: string) => string;
}

/**
 * A Markdown member's name as the installed readers derive it: Node's
 * basename less its extension, so `agents/.md` is the agent `.md`.
 */
function markdownMemberName(file: string): string {
  return posix.basename(file, posix.extname(file));
}

/** An app file directly in the usual apps folder. */
const APP_FILE_PATTERN = /^apps\/[^/]*\.md$/;

const SKILL_MEMBER: MemberLayout = {
  pattern: /^skills\/([^/]+)\/SKILL\.md$/,
  name: (folder) => folder,
};
// Folder names match exactly, as the file-map inventory and web ingestion do.
// Any file name ending in `.md` is a member, `.md` itself included.
const COMMAND_MEMBER: MemberLayout = {
  pattern: /^commands\/([^/]*\.md)$/,
  name: markdownMemberName,
};
const AGENT_MEMBER: MemberLayout = {
  pattern: /^agents\/([^/]*\.md)$/,
  name: markdownMemberName,
};
/** The member folders the installed readers look up by name. */
const MEMBER_ROOTS: readonly string[] = ['skills', 'commands', 'agents'];
/**
 * Each member kind's description key prefix, its manifest key / folder and
 * its files, in the order their heads are read.
 */
const MEMBER_KINDS: readonly {
  readonly type: 'skill' | 'command' | 'agent';
  readonly root: string;
  readonly layout: MemberLayout;
}[] = [
  { type: 'skill', root: 'skills', layout: SKILL_MEMBER },
  { type: 'agent', root: 'agents', layout: AGENT_MEMBER },
  { type: 'command', root: 'commands', layout: COMMAND_MEMBER },
];

/**
 * The file or skill folder name of a listed path the installed scanner may
 * list as a member of the kind in `root` on some checkout: a skill folder's
 * SKILL.md, in any case a case-insensitive checkout resolves, or a symlinked
 * skill folder, which it follows; a Markdown file directly in the command or
 * agent folder. The member folder may be spelled with other case too.
 * Undefined for any other path.
 */
function possibleMemberName(
  path: string,
  root: string,
  link: boolean,
): string | undefined {
  const [folder, name, file, ...rest] = path.split('/');
  if (folder?.toLowerCase() !== root || !name || rest.length > 0)
    return undefined;
  if (root === 'skills')
    return (file === undefined && link) || file?.toLowerCase() === 'skill.md'
      ? name
      : undefined;
  return file === undefined && name.endsWith('.md')
    ? markdownMemberName(name)
    : undefined;
}

const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
/** The shortest a throttled host is left alone, whatever it says. */
const MIN_RATE_LIMIT_WAIT_MS = 1000;
const MAX_CACHE_ENTRIES = 256;
/** GitHub's identifiers: `owner/repo`, and a commit sha. */
const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
/** Native manifests, by the harness that reads them. */
const NATIVE_MANIFEST_PATHS: readonly string[] = [
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  '.github/plugin/plugin.json',
];

/** Manifest keys that move a plugin's parts out of their usual folders. */
const CUSTOM_ROOT_KEYS = ['skills', 'commands', 'agents'];
/** Config parts read from their files, so their details settle compatibility. */
const CONFIG_KEYS = ['hooks', 'mcpServers', 'lspServers'] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];
const DEFAULT_CONFIG_PATHS: Record<ConfigKey, string> = {
  hooks: 'hooks/hooks.json',
  mcpServers: '.mcp.json',
  lspServers: '.lsp.json',
};

class PreviewFailure extends Error {
  constructor(readonly reason: PluginManifestPreviewFailure) {
    super(reason);
    this.name = 'PreviewFailure';
  }
}

interface CacheEntry {
  readonly result: Promise<PluginManifestPreviewResult>;
  /** Set once the read settles; no timer holds an entry past its eviction. */
  expiresAt: number;
  /**
   * Set once the read settles without a preview or with a partial one, so a
   * retry reads it again.
   */
  failed?: true;
}

const cache = new Map<string, CacheEntry>();
/** The host's own "try again after"; no request goes out before it. */
let rateLimitedUntil = 0;

/** Clears the cache and the rate-limit wait; tests and sign-out use it. */
export function resetPluginManifestPreviewCache(): void {
  cache.clear();
  rateLimitedUntil = 0;
}

/**
 * Waits `ms` through the global timer, or less when `signal` aborts first;
 * the caller's next step re-checks the signal, so an abort is not an error.
 */
function politeWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * One GET, with one polite retry for a transient failure. Past `deadline`
 * nothing more goes out, and a request still out is cancelled.
 */
async function fetchResponse(
  url: string,
  deadline?: AbortSignal,
  accept = 'application/vnd.github+json',
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (Date.now() < rateLimitedUntil) throw new PreviewFailure('rate_limited');
    if (deadline?.aborted) throw new PreviewFailure('unavailable');
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: accept,
          'User-Agent': 'plugin-manifest-preview',
        },
        redirect: 'follow',
        signal: deadline ? AbortSignal.any([timeout, deadline]) : timeout,
      });
    } catch {
      if (attempt === 0 && !deadline?.aborted) {
        await politeWait(RETRY_DELAY_MS, deadline);
        continue;
      }
      throw new PreviewFailure('unavailable');
    }
    if (response.ok) return response;
    // GitHub's primary limit answers 403 with no requests remaining; its
    // secondary limits answer 403 or 429, with a Retry-After or without one,
    // however many requests the primary limit still allows. A 403 that says
    // neither in its headers is told apart from a plain refusal by its body.
    const primary = response.headers.get('x-ratelimit-remaining') === '0';
    const throttled =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.has('retry-after') ||
          primary ||
          (await saysSecondaryRateLimit(response))));
    // A failed response's body is not read further: cancel it before
    // retrying or freeing the read's slot, so it does not keep downloading.
    discardBody(response);
    if (response.status === 404) throw new PreviewFailure('not_found');
    if (throttled) {
      // Concurrent reads can see different windows: the later one stands.
      rateLimitedUntil = Math.max(
        rateLimitedUntil,
        rateLimitDeadline(response.headers, primary),
      );
      throw new PreviewFailure('rate_limited');
    }
    if (response.status >= 500 && attempt === 0 && !deadline?.aborted) {
      await politeWait(RETRY_DELAY_MS, deadline);
      continue;
    }
    throw new PreviewFailure('unavailable');
  }
  throw new PreviewFailure('unavailable');
}

/** How much of a refused answer's body is read to recognize a rate limit. */
const MAX_REFUSAL_BYTES = 4096;
/** GitHub's wording for a secondary (formerly abuse) or exhausted limit. */
const RATE_LIMIT_MESSAGE =
  /secondary rate limit|abuse detection|rate limit exceeded/i;
/** The longest wording above, so a chunk is tested with what precedes it. */
const RATE_LIMIT_MESSAGE_MAX_LENGTH = 'secondary rate limit'.length;

/**
 * Whether a refused answer's body says the host is throttling: GitHub's
 * secondary limits may answer 403 with neither a Retry-After nor an
 * exhausted primary limit, saying so only in the message. At most
 * `MAX_REFUSAL_BYTES` are read. Each chunk is tested as it arrives, so the
 * answer is decided, and the rest of the body cancelled, as soon as the
 * message is in: a body that then stalls, fails or is cancelled by another
 * read's throttle cannot lose it. A body that fails before saying so is a
 * plain refusal.
 */
async function saysSecondaryRateLimit(response: Response): Promise<boolean> {
  if (!response.body) return false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = MAX_REFUSAL_BYTES;
  let body = '';
  try {
    while (remaining > 0) {
      const part = await reader.read();
      if (part.done) return false;
      // Only the new text, and enough before it to finish a message it
      // completes, is tested: the whole prefix is not scanned again.
      const from = Math.max(0, body.length - RATE_LIMIT_MESSAGE_MAX_LENGTH);
      body += decoder.decode(part.value.subarray(0, remaining), {
        stream: true,
      });
      remaining -= part.value.byteLength;
      if (RATE_LIMIT_MESSAGE.test(body.slice(from))) return true;
    }
    return false;
  } catch {
    // Every chunk that arrived was tested above.
    return false;
  } finally {
    // The answer is settled: nothing more of this body is wanted.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * When a throttled host accepts requests again: its Retry-After, in seconds
 * or as an HTTP date, else, for an exhausted primary limit, its reset (epoch
 * seconds), else the failure lifetime. GitHub asks a secondary limit with
 * requests remaining to wait at least a minute, not until the primary reset.
 * A deadline that is not a finite time still to come is passed over for the
 * next one, so a throttled answer always closes the gate. A deadline under a
 * second away (a reset in the current second, say) still holds requests back
 * for that second, so the next open does not send one the host is likely to
 * refuse.
 */
function rateLimitDeadline(headers: Headers, primary: boolean): number {
  const now = Date.now();
  const ahead = (deadline: number): boolean =>
    Number.isFinite(deadline) && deadline > now;
  const candidates: number[] = [];
  const retryAfter = headers.get('retry-after')?.trim() ?? '';
  if (/^\d+$/.test(retryAfter))
    candidates.push(now + Number(retryAfter) * 1000);
  else if (retryAfter) candidates.push(Date.parse(retryAfter));
  const reset = primary ? (headers.get('x-ratelimit-reset')?.trim() ?? '') : '';
  if (/^\d+$/.test(reset)) candidates.push(Number(reset) * 1000);
  const deadline = candidates.find(ahead) ?? now + FAILURE_TTL_MS;
  return Math.max(deadline, now + MIN_RATE_LIMIT_WAIT_MS);
}

/** Stops a body the preview will not read from downloading further. */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * Decode a bounded UTF-8 prefix without flushing an incomplete character. A
 * leading byte order mark is dropped unless `keepBom` asks to see it.
 */
async function readPrefix(
  response: Response,
  maxBytes: number,
  keepBom = false,
): Promise<{ body: string; truncated?: true }> {
  if (!response.body) return { body: '' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { ignoreBOM: keepBom });
  let remaining = maxBytes;
  let body = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return { body: body + decoder.decode() };
      body += decoder.decode(part.value.subarray(0, remaining), {
        stream: true,
      });
      if (part.value.byteLength > remaining) {
        // Do not leave the rest of a large response downloading.
        void reader.cancel().catch(() => undefined);
        return { body, truncated: true };
      }
      remaining -= part.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

async function fetchText(
  url: string,
  maxBytes: number,
  options: {
    readonly deadline?: AbortSignal;
    readonly accept?: string;
    readonly keepBom?: boolean;
  } = {},
): Promise<string> {
  const response = await fetchResponse(url, options.deadline, options.accept);
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) {
    discardBody(response);
    throw new PreviewFailure('unavailable');
  }
  const { body, truncated } = await readPrefix(
    response,
    maxBytes,
    options.keepBom,
  );
  if (truncated) throw new PreviewFailure('unavailable');
  return body;
}

/** A leading UTF-8 byte order mark, as a decoder that keeps it shows it. */
const BOM = '\uFEFF';

/** Where a listing's files are read: its repository and revision. */
interface PreviewSource {
  readonly repo: string;
  readonly ref: string;
}

function encodeSegments(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

/** A repository-root-relative file of the listing, at its revision. */
function rawFileUrl(source: PreviewSource, path: string): string {
  return `${RAW_HOST}/${source.repo}/${source.ref}/${encodeSegments(path)}`;
}

/** A listing key with a value, typed or not: the scan keeps every key. */
function isNamed(value: unknown): boolean {
  return value != null && value !== '';
}

/**
 * The listing's own source: its repository at the sha it pins, else the
 * default branch. Named refs and plugin subdirectories are not previewed.
 */
function resolvePreviewSource(
  externalSource: NonNullable<PluginInfo['externalSource']>,
): PreviewSource | null {
  const url =
    typeof externalSource.url === 'string' ? externalSource.url : undefined;
  const repo = url ? parseGitHubRepo(url) : null;
  if (!repo || !REPO_PATTERN.test(repo)) return null;
  // Add does not honor a plugin folder or a named branch/tag. Do not preview
  // those listings; preserve existing pinned-commit previews.
  if (
    ('ref' in externalSource && isNamed(externalSource.ref)) ||
    ('path' in externalSource && isNamed(externalSource.path))
  )
    return null;
  const sha = externalSource.sha;
  return {
    repo,
    ref: typeof sha === 'string' && SHA_PATTERN.test(sha) ? sha : 'HEAD',
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRateLimit(error: unknown): error is PreviewFailure {
  return error instanceof PreviewFailure && error.reason === 'rate_limited';
}

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * The listing's source at one commit. An unpinned listing's default branch is
 * resolved once, so the tree and every file read come from the same revision
 * even if the branch moves meanwhile. Like the tree, the lookup is required:
 * a failure fails the preview.
 */
async function pinSource(source: PreviewSource): Promise<PreviewSource> {
  if (source.ref !== 'HEAD') return source;
  const text = (
    await fetchText(`${API_HOST}/repos/${source.repo}/commits/HEAD`, 4096, {
      accept: 'application/vnd.github.sha',
    })
  ).trim();
  // A host that ignores the sha media type answers with the commit's JSON.
  const body = COMMIT_SHA_PATTERN.test(text) ? null : parseJson(text);
  const sha = isRecord(body) ? body.sha : text;
  if (typeof sha !== 'string' || !COMMIT_SHA_PATTERN.test(sha))
    throw new PreviewFailure('unavailable');
  return { repo: source.repo, ref: sha.toLowerCase() };
}

/** The repository's file paths, and whether GitHub cut the listing short. */
async function readTree(source: PreviewSource): Promise<{
  paths: string[];
  symlinks: ReadonlySet<string>;
  emptyFiles: ReadonlySet<string>;
  truncated: boolean;
}> {
  const body = parseJson(
    await fetchText(
      `${API_HOST}/repos/${source.repo}/git/trees/${encodeURIComponent(source.ref)}?recursive=1`,
      MAX_TREE_BYTES,
    ),
  );
  if (!isRecord(body) || !Array.isArray(body.tree))
    throw new PreviewFailure('unavailable');
  const paths: string[] = [];
  const symlinks = new Set<string>();
  const emptyFiles = new Set<string>();
  for (const item of body.tree) {
    if (
      !isRecord(item) ||
      item.type !== 'blob' ||
      typeof item.path !== 'string'
    )
      continue;
    paths.push(item.path);
    if (item.mode === '120000') symlinks.add(item.path);
    if (item.size === 0) emptyFiles.add(item.path);
  }
  return { paths, symlinks, emptyFiles, truncated: body.truncated === true };
}

/**
 * Whether the listing spells a file or folder the installed readers look up
 * by name, or any folder above it, with other case, such as `.MCP.json` for
 * `.mcp.json` or `Commands` for `commands`, or spells it more than one way
 * (a file and a folder count alike). A case-insensitive checkout
 * (the macOS and Windows default) resolves that lookup, or keeps only one of
 * the spellings, so what the path holds is unknown rather than absent or
 * known. One index, built once, answers every lookup.
 *
 * The listing is indexed by path segment, without regard to case, each node
 * keeping the one spelling of its last segment, or true for several. Once
 * every folder above a node has one spelling that matches, the node's full
 * paths differ only in that segment, so comparing segments decides it. Both
 * the index and a lookup walk each path once, a segment at a time, so a
 * publisher's deep path costs time in proportion to its length.
 */
function caseVariantLookup(paths: Iterable<string>): (path: string) => boolean {
  const children = new Map<string, number>();
  // Each node's segment as spelled, or true for several spellings.
  const spellings: (string | true)[] = [];
  // Each path is lowercased once, then split: case mapping never adds or
  // drops a separator, so its segments line up with the path's own.
  const segments = (path: string): [string[], string[]] => [
    path.split('/'),
    path.toLowerCase().split('/'),
  ];
  for (const path of paths) {
    const [spelled, lower] = segments(path);
    let node = -1;
    spelled.forEach((segment, index) => {
      const key = `${node}/${lower[index] ?? ''}`;
      let child = children.get(key);
      if (child === undefined) {
        child = spellings.length;
        children.set(key, child);
        spellings.push(segment);
      } else if (spellings[child] !== segment) spellings[child] = true;
      node = child;
    });
  }
  // A folder on the way is looked up by name as well: a root file `Commands`
  // beside a folder `commands` leaves `commands/run.md` unknown, though the
  // file itself has one spelling. Nothing below a folder the listing does
  // not hold can be spelled another way.
  return (path) => {
    const [spelled, lower] = segments(path);
    let node = -1;
    for (const [index, segment] of spelled.entries()) {
      const child = children.get(`${node}/${lower[index] ?? ''}`);
      if (child === undefined) return false;
      if (spellings[child] !== segment) return true;
      node = child;
    }
    return false;
  };
}

/**
 * Whether a path, or a folder above it, is a symlink in the tree listing. A
 * symlinked folder is listed as one entry with nothing beneath it, so a file
 * behind it is missing from the listing but may exist once checked out. The
 * symlinks are indexed by path segment, so one check walks the path once,
 * however deep a publisher's manifest makes it. Segments match without
 * regard to case: a case-insensitive checkout follows a link spelled `Hooks`
 * where a reader looks up `hooks`.
 */
function symlinkLookup(symlinks: Iterable<string>): (path: string) => boolean {
  const children = new Map<string, number>();
  const links = new Set<number>();
  for (const link of symlinks) {
    let node = 0;
    for (const segment of link.toLowerCase().split('/')) {
      const key = `${node}/${segment}`;
      let child = children.get(key);
      if (child === undefined) {
        child = children.size + 1;
        children.set(key, child);
      }
      node = child;
    }
    links.add(node);
  }
  return (path) => {
    if (links.size === 0) return false;
    let node = 0;
    for (const segment of path.toLowerCase().split('/')) {
      const child = children.get(`${node}/${segment}`);
      if (child === undefined) return false;
      if (links.has(child)) return true;
      node = child;
    }
    return false;
  };
}

/** A manifest part that names something: a path, entries, or members. */
function declaresContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}

/**
 * Whether a manifest's skills, commands or agents key moves that member
 * folder. The installed scanner and Cursor discovery read any nonempty
 * string, a blank one included, as the configured path and then skip the
 * usual folder; an empty string or list leaves it in place.
 */
function overridesMemberRoot(value: unknown): boolean {
  return typeof value === 'string' ? value.length > 0 : declaresContent(value);
}

/**
 * The member folders a manifest key configures, as the installed scanner's
 * `normalizePaths` reads them: a nonempty string, or the strings of a list.
 * None means the usual folder.
 */
function configuredMemberPaths(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Whether the installed scanner reads the usual member folder for a
 * manifest's key. Like its `normalizePaths`, it takes a nonempty string, or
 * the strings of a list; with none (no key, an empty string or list, a list
 * of no strings, a record) it reads the usual folder. Otherwise it reads the
 * usual folder only when one of those paths resolves to it, whatever else
 * the list names. This settles only whether the usual folder is included:
 * the members of any other configured folder are never listed, and a path
 * whose folder is unknown (one that climbs out of the plugin, say) does not
 * count as the usual one.
 */
function readsDefaultMemberRoot(value: unknown, root: string): boolean {
  const configured = configuredMemberPaths(value);
  return (
    configured.length === 0 ||
    configured.some((entry) => {
      const resolved = pluginPathEntry(entry);
      return 'path' in resolved && resolved.path === root;
    })
  );
}

/**
 * The names Contents shows, by the wire parser's own rule, since the page
 * reads the reply as is: one line, not blank, not too long. Compatibility
 * counts every member, shown or not.
 */
function capped(values: Iterable<string>): string[] {
  return [...new Set(values)]
    .filter(isPluginManifestPreviewName)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, PLUGIN_MANIFEST_PREVIEW_MAX_NAMES);
}

function matches(paths: readonly string[], layout: MemberLayout): string[] {
  return paths.flatMap((path) => {
    const match = layout.pattern.exec(path)?.[1];
    return match ? [layout.name(match)] : [];
  });
}

/**
 * One entry of a declared config path list: a file of the listing, or an
 * entry the preview cannot resolve to one. The installed scanner and runtime
 * resolver read each entry on its own, so one unresolved entry does not
 * hide the others. Of the unresolved, `ignored` is one they read nothing
 * from on any host (not a string, the plugin folder itself, or a path their
 * containment check refuses); `unread` may name a file on some host, so it
 * may define anything.
 */
type ConfigEntry =
  | { readonly path: string }
  | { readonly unresolved: 'ignored' | 'unread' };

/** Any absolute folder: the containment check is measured from it. */
const CONTAINMENT_ROOT = resolve('/plugin');
/**
 * The longest manifest path the preview resolves: Linux's PATH_MAX. A
 * longer one is publisher-controlled text the preview leaves unread.
 */
const MAX_PLUGIN_PATH_LENGTH = 4096;

/**
 * A manifest path as the installed readers resolve it against the plugin
 * folder, then keep it only when `isPathInside` (lib/path-safety) accepts
 * it. That check refuses any relative path that starts with `..`, so it also
 * refuses a file named like `..servers.json` at the plugin root: `ignored`.
 * What a path resolves to on some hosts only is `unread`: a backslash is a
 * separator on Windows alone, an absolute or drive-letter path is the host's
 * own, and a path that climbs out of the plugin folder lands back inside it
 * when the install folder's own name matches (`../review/b.json` from a
 * folder named `review`). The path the listing holds is `''` for the plugin
 * folder itself. A path longer than `MAX_PLUGIN_PATH_LENGTH` is `unread`
 * before it is resolved or looked up: the preview does not settle it, and no
 * lookup of it can cost more than a bounded walk.
 */
function pluginPathEntry(entry: string): ConfigEntry {
  if (
    entry.length > MAX_PLUGIN_PATH_LENGTH ||
    entry.includes('\\') ||
    entry.startsWith('/') ||
    /^[A-Za-z]:/.test(entry)
  )
    return { unresolved: 'unread' };
  const path = resolvePluginPath(entry);
  if (path === null) return { unresolved: 'unread' };
  return isPathInside(CONTAINMENT_ROOT, resolve(CONTAINMENT_ROOT, path))
    ? { path }
    : { unresolved: 'ignored' };
}

function configEntry(entry: unknown): ConfigEntry {
  if (typeof entry !== 'string') return { unresolved: 'ignored' };
  const resolved = pluginPathEntry(entry);
  // The plugin folder itself is no config file.
  return 'path' in resolved && !resolved.path
    ? { unresolved: 'ignored' }
    : resolved;
}

/** A manifest part's entries: one path or a list of them; null when malformed. */
function declaredEntries(value: unknown): ConfigEntry[] | null {
  const list = typeof value === 'string' ? [value] : value;
  return Array.isArray(list) ? list.map(configEntry) : null;
}

/**
 * A manifest's app members from the file listing, as the installed scan finds
 * them: Markdown files directly in each declared folder (`apps` by default),
 * or a declared Markdown file. Null when the declaration is neither a path
 * nor a list; incomplete when a root or file it names is unknown, past the
 * ones it lists.
 */
function previewAppMembers(
  value: unknown,
  listed: ReadonlySet<string>,
  markdownByParent: ReadonlyMap<string, readonly string[]>,
  emptyFiles: ReadonlySet<string>,
  /** A file or folder the listing does not positively show. */
  unseen: (path: string) => boolean,
): {
  members: { name: string; file: string }[];
  complete: boolean;
} | null {
  if (value !== undefined && typeof value !== 'string' && !Array.isArray(value))
    return null;
  // Like the scanner, a list's other entries are skipped; with no path left
  // it reads the usual folder.
  const declared = configuredMemberPaths(value);
  const roots = new Set<string>();
  let complete = true;
  for (const entry of declared.length > 0 ? declared : ['apps']) {
    // Classified as the scanner's containment check reads it: a path it
    // refuses is skipped, one some hosts resolve differently is unknown.
    // The plugin folder itself is a folder of app files.
    const root = pluginPathEntry(entry);
    if ('unresolved' in root) {
      if (root.unresolved === 'unread') complete = false;
      continue;
    }
    roots.add(root.path);
  }
  const members = new Set<string>();
  for (const root of roots) {
    if (unseen(root)) {
      complete = false;
      continue;
    }
    const files = listed.has(root)
      ? [root]
      : (markdownByParent.get(root) ?? []);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      if (unseen(file)) complete = false;
      else if (!emptyFiles.has(file)) members.add(file);
    }
  }
  return {
    members: [...members].map((file) => ({
      name: markdownMemberName(file),
      file,
    })),
    complete,
  };
}

/** One facet's effective config, matching the member inventory's precedence. */
type PreviewConfig =
  | {
      /** The declared entries in manifest order, unresolved ones included. */
      readonly entries: readonly ConfigEntry[];
      /** The listing files among them, each once, in merge order. */
      readonly paths: readonly string[];
      readonly required: boolean;
    }
  | { readonly inline: Record<string, unknown> };

function configSource(key: ConfigKey, value: unknown): PreviewConfig | null {
  if (isRecord(value)) return { inline: value };
  // The installed scanner and the runtime resolver read the usual file when
  // the manifest leaves the key out or empty.
  if (value === undefined || value === '') {
    const path = DEFAULT_CONFIG_PATHS[key];
    return { entries: [{ path }], paths: [path], required: false };
  }
  const entries = declaredEntries(value);
  if (!entries) return null;
  const paths = entries.flatMap((entry) =>
    'path' in entry ? [entry.path] : [],
  );
  // An MCP config listed again overrides any intervening ones. Keeping only
  // its last occurrence preserves the winning definitions without processing
  // the same file repeatedly. Preview member names are sorted after merging.
  const uniquePaths =
    key === 'mcpServers'
      ? [...new Set(paths.reverse())].reverse()
      : [...new Set(paths)];
  return { entries, paths: uniquePaths, required: true };
}

/** Whether a config holds anything a reader of one config key loads. */
function configHolds(key: ConfigKey, record: Record<string, unknown>): boolean {
  switch (key) {
    case 'hooks': {
      const hooks = isRecord(record.hooks) ? record.hooks : record;
      return Object.keys(hooks).some((event) => event !== 'modules');
    }
    case 'mcpServers':
      return (
        Object.keys(isRecord(record.mcpServers) ? record.mcpServers : record)
          .length > 0
      );
    case 'lspServers':
      return Object.keys(record).length > 0;
  }
}

/**
 * How many hooks the installed scan (plugin-scanner.ts `flattenHooksConfig`)
 * lists from one hooks config: each object entry of an event's list, or each
 * object in its `hooks` list. Mods are not hooks.
 */
function scannedHookCount(config: Record<string, unknown>): number {
  const hooks = isRecord(config.hooks) ? config.hooks : config;
  let count = 0;
  for (const [event, entries] of Object.entries(hooks)) {
    if (event === 'modules' || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const members: unknown[] = Array.isArray(entry.hooks)
        ? entry.hooks
        : [entry];
      count += members.filter(isRecord).length;
    }
  }
  return count;
}

/** A hooks config's Mods, when it declares any, are a list of names. */
function modulesWellFormed(config: Record<string, unknown>): boolean {
  return (
    config.modules === undefined ||
    (Array.isArray(config.modules) &&
      config.modules.every((module) => typeof module === 'string'))
  );
}

/** Hook entries a harness can read: command hooks, each with its command. */
function hooksWellFormed(config: Record<string, unknown>): boolean {
  if (config.hooks !== undefined && !isRecord(config.hooks)) return false;
  if (!modulesWellFormed(config)) return false;
  const hooks = isRecord(config.hooks) ? config.hooks : config;
  for (const [event, entries] of Object.entries(hooks)) {
    if (event === 'modules') continue;
    if (!Array.isArray(entries)) return false;
    for (const entry of entries) {
      if (!isRecord(entry)) return false;
      if (entry.matcher !== undefined && typeof entry.matcher !== 'string')
        return false;
      if (entry.hooks !== undefined && !Array.isArray(entry.hooks))
        return false;
      const members = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      for (const member of members) {
        if (!isRecord(member)) return false;
        if (member.type !== undefined && typeof member.type !== 'string')
          return false;
        if (member.async !== undefined && typeof member.async !== 'boolean')
          return false;
        if (
          (member.type === undefined || member.type === 'command') &&
          (typeof member.command !== 'string' || !member.command.trim())
        )
          return false;
      }
    }
  }
  return true;
}

const COMPATIBILITY_HARNESSES = PLUGIN_HARNESSES.filter(
  (id): id is HarnessCompatibilityHarness => id !== 'antigravity',
);

/** The transport branches in resolvePluginMcpServers, in runtime order. */
function previewMcpTransport(
  definition: Record<string, unknown>,
): 'disabled-http' | 'command' | 'http' | undefined {
  const http =
    typeof definition.url === 'string' &&
    (!definition.type || definition.type === 'http');
  if (http && definition.enabled === false) return 'disabled-http';
  if (typeof definition.command === 'string') return 'command';
  return http ? 'http' : undefined;
}

/**
 * The harnesses that load one plugin MCP server definition, for a facet's
 * `mcpHarnesses`; undefined when its transport is not settled (HTTP-only SSE, or
 * neither a command nor a plain HTTP URL). Follows the desktop runtime,
 * plugin-resolver.ts `resolvePluginMcpServers`: a definition with a command
 * is a stdio server; an HTTP server with `enabled: false` is passed to Codex
 * disabled and to no other harness; a disabled stdio server is passed to
 * Claude as is and to every other harness disabled. Antigravity is not a
 * qualified compatibility target, so it is never listed.
 */
function pluginMcpServerLoadableHarnesses(
  definition: unknown,
): HarnessCompatibilityHarness[] | undefined {
  if (!isRecord(definition)) return undefined;
  switch (previewMcpTransport(definition)) {
    case 'disabled-http':
      return [];
    case 'command':
      if (typeof definition.command !== 'string' || !definition.command.trim())
        return undefined;
      return definition.enabled === false
        ? ['claude']
        : [...COMPATIBILITY_HARNESSES];
    case 'http':
      return typeof definition.url === 'string' && definition.url.trim()
        ? [...COMPATIBILITY_HARNESSES]
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The inventory member for one definition, as the desktop resolver launches
 * it: a string `command` selects stdio even when an enabled definition also
 * declares `type: 'http'` and a `url`.
 */
function previewMcpServerMember(
  name: string,
  definition: unknown,
): PluginMcpServerMember | null {
  if (!isRecord(definition)) return null;
  switch (previewMcpTransport(definition)) {
    case 'command':
      return pluginMcpServerMember(name, {
        ...definition,
        type: 'stdio',
        url: undefined,
      });
    case 'disabled-http':
    case 'http':
      return pluginMcpServerMember(name, { ...definition, type: 'http' });
    default:
      // An inventory member still, so compatibility counts the server as
      // unsettled; its row shows no endpoint (see previewMcpEndpoint).
      return pluginMcpServerMember(name, definition);
  }
}

/**
 * The URL or command line one raw definition's Contents row shows: the
 * endpoint the desktop runtime starts, by the branches of
 * resolvePluginMcpServers. Null when the runtime starts none (an SSE or stdio
 * type with only a URL, say), or when an argument is not plain text: the
 * runtime then drops every argument and the installed scanner drops only the
 * odd ones, so neither command line is settled.
 */
function previewMcpEndpoint(
  name: string,
  definition: unknown,
): PluginManifestPreviewMcpServer | null {
  if (!isRecord(definition)) return null;
  switch (previewMcpTransport(definition)) {
    case 'disabled-http':
    case 'http':
      return parsePluginManifestPreviewMcpServer({
        name,
        type: 'http',
        url: definition.url,
      });
    case 'command': {
      const { args } = definition;
      if (
        args !== undefined &&
        !(Array.isArray(args) && args.every((arg) => typeof arg === 'string'))
      )
        return null;
      return parsePluginManifestPreviewMcpServer({
        name,
        type: 'command',
        command: definition.command,
        ...(args === undefined ? {} : { args }),
      });
    }
    default:
      return null;
  }
}

/** Whether every MCP definition is a plain command or URL server. */
function mcpDefinitionsOk(definitions: readonly unknown[]): boolean {
  return definitions.every(
    (definition) =>
      isRecord(definition) &&
      definition.providerConnector === undefined &&
      (definition.type === undefined ||
        (typeof definition.type === 'string' &&
          ['stdio', 'http', 'sse'].includes(definition.type))) &&
      ((typeof definition.command === 'string' && definition.command.trim()) ||
        (typeof definition.url === 'string' && definition.url.trim())),
  );
}

/**
 * Optional reads by what they settle, most important first: configs decide
 * compatibility, the README fills its tab, member heads name and annotate
 * Contents rows.
 */
const READ_PRIORITY = { config: 0, readme: 1, description: 2 } as const;
type ReadPriority = (typeof READ_PRIORITY)[keyof typeof READ_PRIORITY];

/**
 * One limiter per preview for every optional read (configs, member
 * descriptions and the README): at most `OPTIONAL_READ_CONCURRENCY` in flight
 * together, and none after the deadline. A freed slot goes to the most
 * important waiting read, first come, first served among equals, so configs
 * the manifest names later still start before queued descriptions. Wait for
 * aborted reads to settle so an HTTP rate limit already received cannot be
 * lost.
 */
function optionalReadLimiter(
  signal: AbortSignal,
  onFailure: (error: unknown) => void,
): (priority: ReadPriority, read: () => Promise<void>) => Promise<void> {
  let active = 0;
  // Ordered by priority, then by arrival.
  const waiting: { readonly priority: ReadPriority; start: () => void }[] = [];
  // A finished read hands its slot to the next waiting one.
  const release = (): void => {
    const next = waiting.shift();
    if (next) next.start();
    else active -= 1;
  };
  return async (priority, read) => {
    if (signal.aborted) return;
    if (active < OPTIONAL_READ_CONCURRENCY) active += 1;
    else
      await new Promise<void>((start) => {
        const after = waiting.findIndex((entry) => entry.priority > priority);
        waiting.splice(after === -1 ? waiting.length : after, 0, {
          priority,
          start,
        });
      });
    try {
      if (!signal.aborted) await read();
    } catch (error) {
      onFailure(error);
    } finally {
      release();
    }
  };
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > PLUGIN_MANIFEST_PREVIEW_DESCRIPTION_MAX_LENGTH
    ? `${collapsed.slice(0, PLUGIN_MANIFEST_PREVIEW_DESCRIPTION_MAX_LENGTH - 1)}…`
    : collapsed;
}

/** A built preview, and whether an optional read failed or was cut short. */
interface BuiltPreview {
  readonly preview: PluginManifestPreview;
  readonly partial: boolean;
}

async function buildPreview(
  listingSource: PreviewSource,
  provider: 'claude' | 'codex',
): Promise<BuiltPreview> {
  const source = await pinSource(listingSource);
  const tree = await readTree(source);
  const optional = new AbortController();
  const timer = setTimeout(() => optional.abort(), OPTIONAL_READS_DEADLINE_MS);
  try {
    return await buildPreviewFromTree(source, provider, tree, optional);
  } finally {
    clearTimeout(timer);
  }
}

async function buildPreviewFromTree(
  source: PreviewSource,
  provider: 'claude' | 'codex',
  {
    paths,
    symlinks,
    emptyFiles,
    truncated,
  }: Awaited<ReturnType<typeof readTree>>,
  optional: AbortController,
): Promise<BuiltPreview> {
  const listed = new Set(paths);
  const behindSymlink = symlinkLookup(symlinks);
  const markdownByParent = new Map<string, string[]>();
  for (const path of paths) {
    if (!path.endsWith('.md')) continue;
    const parent = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    const siblings = markdownByParent.get(parent);
    if (siblings) siblings.push(path);
    else markdownByParent.set(parent, [path]);
  }
  const caseVariant = caseVariantLookup(paths);
  /**
   * The one rule for publisher evidence: a file or folder the listing does
   * not positively show at the pinned commit is unread, never absent and
   * never read. That is a symlink or a path behind one, which the preview
   * does not follow; a path, or a folder above it, spelled with other case,
   * or more than one way, which a case-insensitive checkout resolves; and,
   * in a truncated listing, any path it does not list, which it may have
   * cut. Manifests, configs, member folders and default files all go
   * through it.
   */
  const unseen = (path: string): boolean =>
    behindSymlink(path) ||
    caseVariant(path) ||
    (truncated && !listed.has(path));
  /** A path the preview may fetch: listed as itself, and seen. */
  const readable = (path: string): boolean => listed.has(path) && !unseen(path);
  const deadline = optional.signal;
  let partial = truncated;
  // Set from the reads' callbacks, so held in an object.
  const limited: { error?: PreviewFailure } = {};
  const onReadFailure = (error: unknown): void => {
    partial = true;
    if (isRateLimit(error)) {
      limited.error ??= error;
      optional.abort();
    }
  };

  // Every optional read of this preview shares one limiter. The native
  // manifests are not optional reads and start at once (there are only four).
  const limit = optionalReadLimiter(deadline, onReadFailure);
  const nativePaths = NATIVE_MANIFEST_PATHS.filter(readable);
  const records = new Map<string, Record<string, unknown>>();
  const nativeSources = (): {
    claude: Record<string, unknown> | undefined;
    codex: Record<string, unknown> | undefined;
    fallback: Record<string, unknown>;
    sources: Record<string, unknown>[];
  } => {
    const claude = records.get('.claude-plugin/plugin.json');
    const codex = records.get('.codex-plugin/plugin.json');
    return {
      claude,
      codex,
      // A repository with no Claude or Codex manifest is read from the
      // provider's default files; another harness's manifest is no evidence
      // for the provider, whose resolver does not read it.
      fallback: {},
      // Contents come from every recognized manifest, not only the two the
      // classifier reads natively.
      sources: nativePaths.map((path) => records.get(path)).filter(isRecord),
    };
  };
  // A native manifest unseen, or listed but not read as a record (the
  // installed scanner parses its raw text, byte order mark and all), may
  // still be read by the installed scan: it is unread, not absent.
  const unreadNativeManifests = (): string[] =>
    NATIVE_MANIFEST_PATHS.filter(
      (path) => unseen(path) || (listed.has(path) && !records.has(path)),
    );
  // Contents list a kind's members from its usual folder only when some
  // manifest's readers look there: a read native manifest that keeps the
  // folder, or, with no Claude or Codex manifest, the provider's defaults.
  // Those defaults are no evidence when a Claude or Codex manifest went
  // unread, since it may move the folder or override the usual configs. A
  // folder every reader looks past lists no members, and its descriptions
  // are dropped. MCP server names, and whether hooks or servers are present,
  // come from the same readers.
  const contentReaders = ({
    claude,
    codex,
    sources,
    fallback,
  }: ReturnType<typeof nativeSources>): Record<string, unknown>[] => {
    const providerManifestUnread = unreadNativeManifests().some(
      (path) =>
        path === '.claude-plugin/plugin.json' ||
        path === '.codex-plugin/plugin.json',
    );
    return claude || codex || providerManifestUnread
      ? sources
      : [...sources, fallback];
  };
  // The installed inventory and the runtime resolvers skip a zero-byte skill,
  // command or agent file, so one is no member and no compatibility evidence.
  // The preview does not resolve a symlink's target, so a symlinked member,
  // or a symlinked folder holding them, is no member and leaves the
  // compatibility facets unknown rather than counting a skill that may dangle.
  const memberPaths = paths.filter(
    (path) => !emptyFiles.has(path) && !symlinks.has(path),
  );
  /**
   * The one rule for a member file the installed readers load, a skill's
   * SKILL.md or a command or agent file: unread when the file, or any folder
   * above it (its member folder, its skill folder, whose name is the
   * skill's), is unseen. Compatibility counts such a member as unresolved,
   * and Contents neither reads its head nor lists it. A folder holding a
   * listed file is there, so a truncated listing does not make it unseen;
   * the member folders themselves are checked on their own.
   */
  const memberUnseen = unseen;
  // Whether a member the installed readers may load is unseen: a member
  // folder, or the member file a listed path stands for (its skill's
  // SKILL.md, or a command or agent file). A SKILL.md at the root, seen or
  // not, is read differently by the hosts.
  const unresolvedMembers =
    MEMBER_ROOTS.some(unseen) ||
    listed.has('SKILL.md') ||
    unseen('SKILL.md') ||
    paths.some((path) => {
      const [root, name, ...rest] = path.split('/');
      if (root === 'skills' && name !== undefined)
        return memberUnseen(`skills/${name}/SKILL.md`);
      return (
        (root === 'commands' || root === 'agents') &&
        rest.length === 0 &&
        path.endsWith('.md') &&
        memberUnseen(path)
      );
    });
  // Every member file counts for compatibility, as the installed scan loads
  // each one, even two whose names collide (`agents/.md` and
  // `agents/.md.md` are both `.md`); the name length and count limits, and
  // the de-duplication of names, apply only to the Contents shown.
  const skillMembers = matches(memberPaths, SKILL_MEMBER);
  const commandMembers = matches(memberPaths, COMMAND_MEMBER);
  const agentMembers = matches(memberPaths, AGENT_MEMBER);

  const configFiles = new Map<string, string>();
  const configRecords = new Map<string, Record<string, unknown>>();
  // Configs that start with a byte order mark, read here without it.
  const bomConfigs = new Set<string>();
  const readManifests = Promise.all(
    nativePaths.map(async (path): Promise<void> => {
      if (deadline.aborted) return;
      try {
        // The installed scanner and resolver parse a manifest's raw text, so
        // one with a byte order mark is unread for them, and for the preview.
        const manifest = parseJson(
          await fetchText(rawFileUrl(source, path), MAX_MANIFEST_BYTES, {
            deadline,
            keepBom: true,
          }),
        );
        if (isRecord(manifest)) records.set(path, manifest);
      } catch (error) {
        onReadFailure(error);
      }
    }),
  );
  const readConfigs = async (): Promise<void> => {
    await readManifests;

    const wanted = new Set<string>();
    // Mods use the usual hooks file even when the manifest moves or inlines
    // its command hooks. Give it a slot in the bounded config read.
    if (readable(DEFAULT_CONFIG_PATHS.hooks))
      wanted.add(DEFAULT_CONFIG_PATHS.hooks);
    const { claude, codex, sources, fallback } = nativeSources();
    // Reserve the bounded read budget for provider evidence first. Secondary
    // manifests use the remaining slots for Contents.
    for (const source of claude || codex ? sources : [fallback, ...sources])
      for (const key of CONFIG_KEYS) {
        const config = configSource(key, source[key]);
        if (config && 'paths' in config)
          for (const path of config.paths) if (readable(path)) wanted.add(path);
      }
    if (wanted.size > MAX_CONFIG_FILES) partial = true;
    await Promise.all(
      [...wanted].slice(0, MAX_CONFIG_FILES).map((path) =>
        limit(READ_PRIORITY.config, async (): Promise<void> => {
          const raw = await fetchText(
            rawFileUrl(source, path),
            MAX_MANIFEST_BYTES,
            { deadline, keepBom: true },
          );
          const bom = raw.startsWith(BOM);
          const text = bom ? raw.slice(BOM.length) : raw;
          const record = parseJson(text);
          if (isRecord(record)) {
            configFiles.set(path, text);
            configRecords.set(path, record);
            if (bom) bomConfigs.add(path);
          } else {
            partial = true;
          }
        }),
      ),
    );
  };

  // A member's name and description in Contents are what the installed
  // scanner reads from its file's front matter: its `name`, else the file or
  // skill folder name. Only a file whose head was read and settles that has
  // a known name; any other member (unseen, past the read budget, failed,
  // cut short) is left out of Contents, though compatibility still counts it.
  // Each kind's files include every one the installed scanner may list on
  // some checkout though the preview cannot read it as a member: a symlinked
  // file or skill folder, a file or folder spelled more than one way (an
  // empty one too, since another spelling may win its place), and a spelling
  // only a case-insensitive checkout finds (`skills/x/skill.md`). Such a file
  // is never read and gets no row, but holds its file or folder name, so a
  // row it may share a name with gets no description.
  const memberFiles = MEMBER_KINDS.map(({ type, root, layout }) => ({
    type,
    root,
    files: paths
      .flatMap((path) => {
        const fallback = possibleMemberName(path, root, symlinks.has(path));
        if (fallback === undefined) return [];
        const seen = !memberUnseen(path);
        // An empty file the listing shows plainly is no member anywhere.
        if (seen && emptyFiles.has(path)) return [];
        return [
          { path, fallback, readable: seen && layout.pattern.test(path) },
        ];
      })
      .sort(
        (a, b) =>
          a.fallback.localeCompare(b.fallback) || a.path.localeCompare(b.path),
      ),
  }));
  // App files in the usual folder that a manifest's readers declare, read
  // for their installed names like the members above once the manifests are
  // read. One elsewhere (a folder a manifest configures) is not read, so its
  // name is unknown.
  const appTargets = (): { path: string; fallback: string }[] => {
    const declared = new Set(
      contentReaders(nativeSources()).flatMap(
        (reader) =>
          previewAppMembers(
            reader.apps,
            listed,
            markdownByParent,
            emptyFiles,
            unseen,
          )?.members.map(({ file }) => file) ?? [],
      ),
    );
    return paths
      .filter(
        (path) =>
          declared.has(path) &&
          APP_FILE_PATTERN.test(path) &&
          readable(path) &&
          !symlinks.has(path),
      )
      .map((path) => ({ path, fallback: markdownMemberName(path) }));
  };
  // The installed skill scan stats each child of each skill folder it reads
  // with no catch of its own, so one child whose target the listing cannot
  // prove (a link that may dangle) fails it, and the scan lists no skill at
  // all, whatever the other folders hold. Command, agent and app files are
  // each read under their own catch, so no one file empties those kinds. A
  // manifest whose skill folders may hold such a child, or whose folder is
  // unknown, is no evidence of any skill row.
  const linkParents = new Set(
    [...symlinks].map((link) =>
      link.slice(0, Math.max(0, link.lastIndexOf('/'))).toLowerCase(),
    ),
  );
  const skillScanMayFail = (value: unknown): boolean => {
    const configured = configuredMemberPaths(value);
    return (configured.length > 0 ? configured : ['skills']).some((entry) => {
      const root = pluginPathEntry(entry);
      // The scanner skips a folder its containment check refuses.
      if ('unresolved' in root) return root.unresolved === 'unread';
      return (
        truncated ||
        (root.path !== '' && unseen(root.path)) ||
        linkParents.has(root.path.toLowerCase())
      );
    });
  };
  // The kinds whose usual folder some member reader reads, so Contents lists
  // their members there.
  const shownKindsOf = (
    readers: readonly Record<string, unknown>[],
  ): Set<string> =>
    new Set(
      MEMBER_KINDS.filter(({ type, root }) =>
        readers.some(
          (reader) =>
            readsDefaultMemberRoot(reader[root], root) &&
            !(type === 'skill' && skillScanMayFail(reader[root])),
        ),
      ).map(({ type }) => type),
    );
  /** By member file: its installed name and description; null for no member. */
  const memberHeads = new Map<
    string,
    { readonly name: string; readonly description: string } | null
  >();
  const readHeads = (
    targets: readonly { path: string; fallback: string }[],
  ): Promise<void[]> =>
    Promise.all(
      targets.map((target) =>
        limit(READ_PRIORITY.description, async (): Promise<void> => {
          const response = await fetchResponse(
            rawFileUrl(source, target.path),
            deadline,
          );
          // The scanner reads the raw text: a byte order mark hides its
          // front matter.
          const { body, truncated } = await readPrefix(
            response,
            MAX_MEMBER_FILE_BYTES,
            true,
          );
          // The scanner skips an empty file.
          if (!body && !truncated) {
            memberHeads.set(target.path, null);
            return;
          }
          const frontMatter = readCatalogScannerFrontmatter(body, !truncated);
          if (!frontMatter) return;
          memberHeads.set(target.path, {
            name:
              typeof frontMatter.name === 'string' && frontMatter.name
                ? frontMatter.name
                : target.fallback,
            description:
              typeof frontMatter.description === 'string'
                ? frontMatter.description
                : '',
          });
        }),
      ),
    );
  const readMemberHeads = async (): Promise<void> => {
    // Heads are read once the manifests show which usual folders a reader
    // keeps, so a folder every reader looks past spends none of the budget.
    // An unseen member is never read, so it takes no read and has no known
    // name; its file or folder name still counts against a name it shares.
    await readManifests;
    const shown = shownKindsOf(contentReaders(nativeSources()));
    const targets = [
      ...memberFiles
        .filter(({ type }) => shown.has(type))
        .flatMap(({ files }) => files)
        .filter(({ readable }) => readable),
      ...appTargets(),
    ];
    // Files past the cap go unread and name no member.
    if (targets.length > MAX_DESCRIPTION_FILES) partial = true;
    await readHeads(targets.slice(0, MAX_DESCRIPTION_FILES));
  };

  let readme: PluginManifestPreview['readme'];
  const readReadme = async (): Promise<void> => {
    // A symlinked README is never read (its blob is the link target text); the
    // preferred spelling is chosen among the regular files. Not the shared
    // `unseen` rule: that also hides every case variant, and the README keeps
    // choosing among them.
    const regular = paths.filter((candidate) => !symlinks.has(candidate));
    const path =
      regular.find((candidate) => candidate === 'README.md') ??
      regular.find((candidate) => README_PATTERN.test(candidate));
    if (!path) return;
    await limit(READ_PRIORITY.readme, async (): Promise<void> => {
      const response = await fetchResponse(rawFileUrl(source, path), deadline);
      readme = await readPrefix(
        response,
        PLUGIN_MANIFEST_PREVIEW_README_MAX_LENGTH,
      );
    });
  };

  // The README can arrive even if a native manifest stalls. A waiting
  // config, then the README, takes the next free slot before any queued
  // description, so descriptions cannot spend the deadline alone.
  await Promise.all([readReadme(), readMemberHeads(), readConfigs()]);
  if (limited.error) throw limited.error;
  const unreadPublisherManifests = unreadNativeManifests();
  /**
   * A config file as one installed reader gets it, under the same rule:
   * unseen or listed but unread is unread, unlisted is absent. The desktop
   * readers of hooks, MCP servers and language servers parse the raw text,
   * so they load nothing from a file that starts with a byte order mark,
   * while Claude and the Mods scan skip the mark. Such a file is read for a
   * reader only when it holds nothing that reader loads, where every reader
   * agrees; Mods always read it.
   */
  const readConfig = (
    reader: ConfigKey | 'modules',
    path: string,
  ):
    | { readonly state: 'read'; readonly record: Record<string, unknown> }
    | { readonly state: 'absent' | 'unread' } => {
    if (unseen(path)) return { state: 'unread' };
    if (!listed.has(path)) return { state: 'absent' };
    const record = configRecords.get(path);
    if (
      !record ||
      (reader !== 'modules' &&
        bomConfigs.has(path) &&
        configHolds(reader, record))
    )
      return { state: 'unread' };
    return { state: 'read', record };
  };
  // The MCP configs the runtime merge reads.
  const mcpFiles = new Map(
    [...configFiles].filter(
      ([path]) => readConfig('mcpServers', path).state === 'read',
    ),
  );
  partial ||= deadline.aborted || unreadPublisherManifests.length > 0;
  const { claude, codex, fallback, sources } = nativeSources();
  const publisherManifests: PublisherPluginManifest[] = [];
  for (const path of nativePaths) {
    const manifest = records.get(path);
    if (manifest) publisherManifests.push({ path, manifest });
  }

  // Assess each native facet in isolation. Shared paths are downloaded once,
  // but only the manifest that references a file gets its evidence.
  const buildEvidence = (
    source: Record<string, unknown>,
  ): PreviewFacetEvidence => {
    const manifest: ClaudePluginManifest = {};
    let complete =
      !unresolvedMembers &&
      unreadPublisherManifests.length === 0 &&
      !CUSTOM_ROOT_KEYS.some((key) => overridesMemberRoot(source[key]));
    // Config kinds with a declaration or file that may hold members unread.
    const unreadKeys = new Set<ConfigKey>();
    const configs = (key: ConfigKey): Record<string, unknown>[] => {
      const config = configSource(key, source[key]);
      if (!config) {
        complete = false;
        unreadKeys.add(key);
        // A malformed explicit MCP declaration is not a root default.
        if (key === 'mcpServers') manifest.mcpServers = {};
        return [];
      }
      if ('inline' in config) {
        manifest[key] = config.inline;
        return [config.inline];
      }
      manifest[key] = [...config.paths];
      // An entry the preview cannot resolve settles nothing: the facet stays
      // unknown, while the readable entries still supply their contents.
      if (config.entries.some((entry) => 'unresolved' in entry))
        complete = false;
      if (
        config.entries.some(
          (entry) => 'unresolved' in entry && entry.unresolved === 'unread',
        )
      )
        unreadKeys.add(key);
      return config.paths.flatMap((path) => {
        const read = readConfig(key, path);
        if (read.state === 'read') return [read.record];
        if (read.state === 'unread') unreadKeys.add(key);
        // A declared file must be there; an unread one may hold anything.
        if (config.required || read.state === 'unread') complete = false;
        return [];
      });
    };
    const hookConfigs = configs('hooks');
    // The usual hooks file declares Mods even when the manifest moves its
    // hooks; one unread or with unreadable Mods leaves them unknown.
    const mods = readConfig('modules', DEFAULT_CONFIG_PATHS.hooks);
    if (
      mods.state === 'unread' ||
      (mods.state === 'read' && !modulesWellFormed(mods.record))
    )
      complete = false;
    // The installed scan finds a root app file the listing does not show.
    if (unseen('.app.json')) complete = false;
    const mcpListed = configs('mcpServers').flatMap((config) =>
      Object.values(isRecord(config.mcpServers) ? config.mcpServers : config),
    );
    // Configs merge in order, the last definition of a name winning. A config
    // that may exist but was not read may replace any server defined before
    // it, so those servers keep their name but show no URL or command. One
    // pass: a name is unsettled when an unread config follows its last
    // definition. A malformed declaration, or an entry that may name a file
    // another host reads (a backslash path, say), counts as unread; an entry
    // the runtime reads nothing from on any host is skipped, as it skips it.
    // A config named again overrides any between, so only its last position
    // counts: each config is scanned once, however often it is named.
    const unsettledMcpEndpoints = new Set<string>();
    const mcpConfig = configSource('mcpServers', source.mcpServers);
    let mcpConfigUnread = mcpConfig === null;
    if (mcpConfig && 'entries' in mcpConfig) {
      const lastDefinition = new Map<string, number>();
      let lastUnread = -1;
      const lastPosition = new Map<string, number>();
      mcpConfig.entries.forEach((entry, index) => {
        if ('path' in entry) lastPosition.set(entry.path, index);
        else if (entry.unresolved === 'unread') lastUnread = index;
      });
      for (const [path, index] of lastPosition) {
        const read = readConfig('mcpServers', path);
        if (read.state === 'read') {
          const { record } = read;
          const servers = isRecord(record.mcpServers)
            ? record.mcpServers
            : record;
          for (const [name, definition] of Object.entries(servers))
            // The runtime merge skips a definition that is not an object.
            if (isRecord(definition))
              lastDefinition.set(
                name,
                Math.max(index, lastDefinition.get(name) ?? -1),
              );
        } else if (read.state === 'unread') {
          lastUnread = Math.max(lastUnread, index);
        }
      }
      for (const [name, index] of lastDefinition)
        if (index < lastUnread) unsettledMcpEndpoints.add(name);
      mcpConfigUnread = lastUnread >= 0;
    }
    const lspEntries = configs('lspServers').flatMap((config) =>
      Object.entries(config),
    );
    // The inventory counts any string command; a blank one cannot start.
    const lspStartable = (definition: unknown): boolean =>
      isRecord(definition) &&
      typeof definition.command === 'string' &&
      definition.command.trim().length > 0;
    // The installed scan keeps a server's string arguments and drops the
    // rest; the inventory drops the whole list, so the definition the
    // installed list keys by its command line is not known.
    const lspArgsKnown = (definition: unknown): boolean =>
      !isRecord(definition) ||
      !Array.isArray(definition.args) ||
      definition.args.every((arg) => typeof arg === 'string');
    // The inventory reads every listed config; only servers the installer
    // accepts and can start are named.
    const lspNames = new Set(
      lspEntries.flatMap(([name, definition]) =>
        lspStartable(definition) ? [name] : [],
      ),
    );
    // App members are listed, not read; an unresolved app leaves the facet unknown.
    const apps = previewAppMembers(
      source.apps,
      listed,
      markdownByParent,
      emptyFiles,
      unseen,
    );
    if (!apps?.complete) complete = false;
    // An app's installed name is its front matter's `name`, known only from
    // a head that was read; an empty file is no app.
    let appsUnknown = !apps?.complete;
    const appNames = (apps?.members ?? []).flatMap(({ file }) => {
      const head = memberHeads.get(file);
      if (head === undefined) {
        appsUnknown = true;
        return [];
      }
      return head ? [{ file, name: head.name }] : [];
    });
    const inventory = buildPluginMemberInventory({
      files: configFiles,
      // MCP members below come from the merged map, not the per-file inventory.
      manifest: { ...manifest, mcpServers: {} },
      skillRootMode: 'children-only',
    });
    // MCP servers as the runtime merges them: config files in manifest order,
    // the last definition of a name winning. A disabled server stays listed;
    // only the harnesses that load it count it.
    const mcpDefinitions = Object.entries(
      readPluginMcpServerMap(mcpFiles, manifest),
    );
    // Each defined name keeps its row's endpoint, null when the winning
    // definition shows none, so a later manifest cannot supply one.
    const mcpEndpoints = new Map<
      string,
      PluginManifestPreviewMcpServer | null
    >();
    const mcp = mcpDefinitions.flatMap(([name, definition]) => {
      const member = previewMcpServerMember(name, definition);
      // The endpoint comes from the raw definition, not the normalized
      // member, which may have turned a URL the runtime ignores into an HTTP
      // endpoint or dropped arguments the runtime would refuse.
      mcpEndpoints.set(
        name,
        unsettledMcpEndpoints.has(name)
          ? null
          : previewMcpEndpoint(name, definition),
      );
      return member
        ? [{ member, harnesses: pluginMcpServerLoadableHarnesses(definition) }]
        : [];
    });
    return {
      complete:
        complete &&
        hookConfigs.every(hooksWellFormed) &&
        mcpListed.every(isRecord) &&
        mcp.length === mcpDefinitions.length &&
        mcpDefinitionsOk(mcpDefinitions.map(([, definition]) => definition)) &&
        lspEntries.length === inventory.lspServers.length &&
        lspEntries.every(([, definition]) => lspStartable(definition)),
      rootApp: listed.has('.app.json'),
      inventory: {
        skills: skillMembers.map((name) => ({ name })),
        commands: commandMembers.map((name) => ({ name })),
        agents: agentMembers.map((name) => ({ name })),
        apps: apps?.members ?? [],
        hooks: inventory.hooks,
        mods: inventory.mods ?? [],
        mcpServers: mcp.map(({ member }) => member),
        lspServers: inventory.lspServers.filter(({ name }) =>
          lspNames.has(name),
        ),
      },
      cursorSkillCount: skillMembers.length,
      cursorMissingSkills: false,
      // A legacy SSE endpoint without a command has no settled compatibility.
      mcpHarnesses: mcp.map(({ harnesses }) => harnesses),
      mcpEndpoints,
      mcpConfigUnread,
      appsUnknown,
      appNames,
      configUnread:
        unreadKeys.has('hooks') ||
        unreadKeys.has('lspServers') ||
        mods.state === 'unread' ||
        !lspEntries.every(([, definition]) => lspArgsKnown(definition)),
      hookCount: hookConfigs.reduce(
        (count, config) => count + scannedHookCount(config),
        0,
      ),
    };
  };
  const evidenceOf = new Map<Record<string, unknown>, PreviewFacetEvidence>();
  const evidence = (source: Record<string, unknown>): PreviewFacetEvidence => {
    const known = evidenceOf.get(source);
    if (known) return known;
    const built = buildEvidence(source);
    evidenceOf.set(source, built);
    return built;
  };
  const facets =
    claude || codex
      ? {
          ...(claude ? { claude: evidence(claude) } : {}),
          ...(codex ? { codex: evidence(codex) } : {}),
        }
      : { [provider]: evidence(fallback) };
  const memberReaders = contentReaders({ claude, codex, sources, fallback });
  // Every native manifest that was read (Cursor's too, though the classifier
  // reads only `facets`), then the provider's default files when they are
  // evidence; for MCP servers, the first to define a name wins.
  const readerEvidence = [...new Set(memberReaders.map(evidence))];
  // A config or app declaration a reader names but the preview could not
  // read may hold hooks, servers, Mods or apps it does not list.
  if (
    readerEvidence.some(
      ({ mcpConfigUnread, appsUnknown, configUnread }) =>
        mcpConfigUnread || appsUnknown || configUnread,
    )
  )
    partial = true;
  const shownKinds = shownKindsOf(memberReaders);
  // Listed paths by their folder, without regard to case, so each member
  // folder a manifest configures is looked up once, however many it lists:
  // every file directly in it, and every skill folder's SKILL.md below it.
  // Built only when some manifest configures a folder of its own.
  interface FolderIndex {
    readonly childrenOf: ReadonlyMap<string, readonly string[]>;
    readonly skillFilesIn: ReadonlyMap<string, readonly string[]>;
  }
  let folderIndex: FolderIndex | undefined;
  const indexFolders = (): FolderIndex => {
    if (folderIndex) return folderIndex;
    const childrenOf = new Map<string, string[]>();
    const skillFilesIn = new Map<string, string[]>();
    const push = (
      index: Map<string, string[]>,
      key: string,
      path: string,
    ): void => {
      const known = index.get(key);
      if (known) known.push(path);
      else index.set(key, [path]);
    };
    for (const path of paths) {
      // Lowercased once; case mapping never adds or drops a separator.
      const lower = path.toLowerCase();
      const slash = lower.lastIndexOf('/');
      push(childrenOf, slash < 0 ? '' : lower.slice(0, slash), path);
      if (slash > 0 && lower.slice(slash + 1) === 'skill.md') {
        const above = lower.lastIndexOf('/', slash - 1);
        push(skillFilesIn, above < 0 ? '' : lower.slice(0, above), path);
      }
    }
    folderIndex = { childrenOf, skillFilesIn };
    return folderIndex;
  };
  /**
   * The member files the installed scanner may list from one configured
   * folder other than the usual one, each with its file or skill folder
   * name, by the same rules as the usual folder's: a skill folder's
   * SKILL.md, or a symlinked skill folder; a Markdown file directly in a
   * command or agent folder, or a configured Markdown file itself. None is
   * read, so each holds only that name; an empty one the listing shows
   * plainly is no member.
   */
  const configuredRootMembers = (
    folder: string,
    type: 'skill' | 'command' | 'agent',
  ): { readonly path: string; readonly fallback: string }[] => {
    const { childrenOf, skillFilesIn } = indexFolders();
    const key = folder.toLowerCase();
    const children = childrenOf.get(key) ?? [];
    const found =
      type === 'skill'
        ? [
            ...(skillFilesIn.get(key) ?? []).map((path) => ({
              path,
              fallback: posix.basename(posix.dirname(path)),
            })),
            ...children
              .filter((path) => symlinks.has(path))
              .map((path) => ({ path, fallback: posix.basename(path) })),
          ]
        : [
            ...children.filter((path) => path.endsWith('.md')),
            ...(listed.has(folder) && folder.endsWith('.md') ? [folder] : []),
          ].map((path) => ({ path, fallback: markdownMemberName(path) }));
    return found.filter(
      ({ path }) => memberUnseen(path) || !emptyFiles.has(path),
    );
  };
  // Contents shows only names the page can show, at most so many; a name it
  // leaves out is a member left unshown, so the read is partial.
  const listedNames = (values: readonly string[]): string[] => {
    const shown = capped(values);
    if (new Set(values).size > shown.length) partial = true;
    return shown;
  };
  // The installed list has a row per definition (an app file, an LSP
  // server's command line) and Contents one per name, so a name two
  // definitions share leaves a row unshown. One definition two readers
  // reach is one row.
  const listedDefinitions = (
    definitions: readonly { readonly key: string; readonly name: string }[],
  ): string[] => {
    const nameByKey = new Map(
      definitions.map(({ key, name }) => [key, name] as const),
    );
    if (new Set(nameByKey.values()).size < nameByKey.size) partial = true;
    return listedNames([...nameByKey.values()]);
  };
  // Each shown kind's members whose installed name is known. A name two
  // member files of a kind share gets no description, as the page cannot
  // tell which file it means: two read files the scanner names alike, or a
  // read one and an unread or unreadable one whose file or folder name it is.
  // Every folder a member reader configures for the kind counts, a custom
  // one too (`commands: ["./commands", "./extra"]`): its files are never
  // read, so each holds its file or folder name. A configured folder the
  // preview cannot see into (one it cannot resolve, a symlink, one spelled
  // another way, or any folder of a cut-short listing) may hold members of
  // any name, so no row of that kind gets a description. An unread file's
  // front-matter name is not known either; the first 40 files' descriptions
  // are shown regardless (AC3), so one that names itself like a shown row
  // is the accepted residue.
  // The files in the folders the member readers configure for a kind, other
  // than its usual one, and whether one of those folders cannot be seen into.
  const configuredFolders = (
    type: 'skill' | 'command' | 'agent',
    root: string,
  ): {
    readonly unknown: boolean;
    readonly members: { readonly path: string; readonly fallback: string }[];
  } => {
    let unknown = false;
    const members: { readonly path: string; readonly fallback: string }[] = [];
    const counted = new Set<string>();
    for (const reader of memberReaders)
      for (const entry of configuredMemberPaths(reader[root])) {
        const folder = pluginPathEntry(entry);
        if ('unresolved' in folder) {
          // The scanner skips a folder its containment check refuses.
          if (folder.unresolved === 'unread') unknown = true;
          continue;
        }
        if (folder.path === root || counted.has(folder.path)) continue;
        counted.add(folder.path);
        if (folder.path !== '' && unseen(folder.path)) {
          unknown = true;
          continue;
        }
        members.push(...configuredRootMembers(folder.path, type));
      }
    return { unknown, members };
  };
  const memberNames: Record<string, string[]> = {};
  const descriptions: Record<string, string> = {};
  for (const { type, root, files } of memberFiles) {
    const configured = configuredFolders(type, root);
    if (!shownKinds.has(type)) {
      memberNames[type] = [];
      // Members the kind may have, in its usual folder or one a manifest
      // configures, go unnamed, so the read is partial; a configured folder
      // the listing shows holds none of them leaves it complete. The usual
      // folder counts only while some reader reads it; skills a scan may not
      // list (behind a symlink, say) may be there too.
      if (
        (files.length > 0 &&
          memberReaders.some((reader) =>
            readsDefaultMemberRoot(reader[root], root),
          )) ||
        configured.unknown ||
        configured.members.length > 0 ||
        (type === 'skill' &&
          memberReaders.some((reader) => skillScanMayFail(reader[root])))
      )
        partial = true;
      continue;
    }
    const holders = new Map<string, number>();
    const hold = (name: string): void => {
      holders.set(name, (holders.get(name) ?? 0) + 1);
    };
    const heads: { readonly name: string; readonly description: string }[] = [];
    for (const { path, fallback } of files) {
      const head = memberHeads.get(path);
      // An empty file is no member.
      if (head === null) continue;
      hold(head ? head.name : fallback);
      if (head) heads.push(head);
    }
    // Some member reader reads the usual folder, or the kind is not shown.
    const unknownFolder = unseen(root) || configured.unknown;
    const usual = new Set(files.map(({ path }) => path));
    for (const { path, fallback } of configured.members)
      if (!usual.has(path)) {
        // A file two configured folders reach is one holder.
        usual.add(path);
        hold(fallback);
      }
    const shown = listedNames(heads.map(({ name }) => name));
    memberNames[type] = shown;
    // A member whose installed name is not known (unread, a custom folder's,
    // or front matter the prefix cannot settle) is left out of the list, and
    // a folder the preview cannot see into may hold more: the read is partial.
    let held = 0;
    for (const count of holders.values()) held += count;
    if (unknownFolder || held > heads.length) partial = true;
    // Two read files sharing a name are two installed members but one row.
    if (new Set(heads.map(({ name }) => name)).size < heads.length)
      partial = true;
    if (unknownFolder) continue;
    const shownNames = new Set(shown);
    for (const { name, description } of heads)
      if (shownNames.has(name) && holders.get(name) === 1 && description.trim())
        descriptions[`${type}:${name}`] = oneLine(description);
  }
  // Hooks and MCP servers are present only on positive evidence: a config
  // that was read and holds at least one, as the installed scan counts them.
  const hooks = readerEvidence.some(({ hookCount }) => hookCount > 0);
  // App, Mod and LSP server names from the same readers.
  const apps = listedDefinitions(
    readerEvidence.flatMap(({ appNames }) =>
      appNames.map(({ file, name }) => ({ key: file, name })),
    ),
  );
  // A root app config is content the installed scan lists no name for; one
  // the preview cannot see may be there too.
  const rootApp = listed.has('.app.json');
  if (unseen('.app.json')) partial = true;
  // A Mod is a module in a hooks file, so a module two hooks files load is
  // two installed rows under one name. Grouped by module as it is read, with
  // no key built per declaration of a publisher's hooks file.
  const modFiles = new Map<string, Set<string>>();
  for (const { inventory } of readerEvidence)
    for (const { hooksFile, module } of inventory.mods) {
      const files = modFiles.get(module) ?? new Set<string>();
      files.add(hooksFile);
      modFiles.set(module, files);
    }
  if ([...modFiles.values()].some((files) => files.size > 1)) partial = true;
  const mods = listedNames([...modFiles.keys()]);
  const lspServers = listedDefinitions(
    readerEvidence.flatMap(({ inventory }) =>
      inventory.lspServers.map(({ name, command, args }) => ({
        key: JSON.stringify([name, command, args ?? []]),
        name,
      })),
    ),
  );
  // Names come from the merged definitions, as the runtime lists its servers,
  // so one with no URL or command still gets its row.
  const mcpServerNames = listedNames(
    readerEvidence.flatMap(({ mcpEndpoints }) => [...mcpEndpoints.keys()]),
  );
  const mcpServers = readerEvidence.some(
    ({ mcpEndpoints }) => mcpEndpoints.size > 0,
  );
  // Each named server's URL or command line, for its Contents row: a facet's
  // merged definition, the first facet to define a name winning, even with a
  // definition that shows no endpoint.
  const named = new Set(mcpServerNames);
  const endpoints = new Map<string, PluginManifestPreviewMcpServer | null>();
  // Manifests in priority order. An unread one, or one whose MCP config went
  // unread, may define any name and win it, so a name first defined below
  // one keeps its row but shows no endpoint.
  let unreadAbove = false;
  const settleEndpoints = ({ mcpEndpoints }: PreviewFacetEvidence): void => {
    for (const [name, server] of mcpEndpoints)
      if (named.has(name) && !endpoints.has(name))
        endpoints.set(name, unreadAbove ? null : server);
  };
  for (const path of NATIVE_MANIFEST_PATHS) {
    const record = records.get(path);
    if (record) {
      const facet = evidence(record);
      settleEndpoints(facet);
      if (facet.mcpConfigUnread) unreadAbove = true;
    } else if (unreadPublisherManifests.includes(path)) unreadAbove = true;
  }
  // The provider's default files, below every manifest.
  readerEvidence.forEach(settleEndpoints);
  const mcpServerEndpoints = mcpServerNames.flatMap((name) => {
    const server = endpoints.get(name);
    return server ? [server] : [];
  });
  const compatibility = classifyHarnessCompatibility({
    kind: 'plugin',
    publisherManifests,
    unreadPublisherManifests,
    facets,
  });
  return {
    partial,
    preview: {
      ...(compatibility ? { compatibility } : {}),
      ...(partial ? { partial: true } : {}),
      skills: memberNames.skill ?? [],
      commands: memberNames.command ?? [],
      agents: memberNames.agent ?? [],
      ...(apps.length > 0 ? { apps } : {}),
      ...(rootApp ? { rootApp } : {}),
      ...(mods.length > 0 ? { mods } : {}),
      ...(lspServers.length > 0 ? { lspServers } : {}),
      hooks,
      mcpServers,
      mcpServerNames,
      ...(mcpServerEndpoints.length > 0 ? { mcpServerEndpoints } : {}),
      ...(readme ? { readme } : {}),
      ...(Object.keys(descriptions).length > 0 ? { descriptions } : {}),
    },
  };
}

function cached(key: string): Promise<PluginManifestPreviewResult> | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

/** A settled preview and how long it is kept. */
interface Settled {
  readonly result: PluginManifestPreviewResult;
  readonly ttl: number;
}

function remember(
  key: string,
  settled: Promise<Settled>,
): Promise<PluginManifestPreviewResult> {
  // Expired entries go as another arrives, so none waits for its own key
  // to be asked for again; no timer holds or drops them.
  const now = Date.now();
  for (const [known, { expiresAt }] of cache)
    if (expiresAt <= now) cache.delete(known);
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const result = settled.then((value) => value.result);
  // Unsettled reads never expire; a settled one lasts its lifetime.
  const entry: CacheEntry = { result, expiresAt: Infinity };
  cache.set(key, entry);
  void settled.then(({ result: value, ttl }) => {
    entry.expiresAt = Date.now() + ttl;
    if (!value.ok || value.preview.partial === true) entry.failed = true;
  });
  return result;
}

/** Local listings have no remote repo to preview. Read only their README. */
async function previewCheckoutReadme(
  checkout: string,
  sourcePath: string,
): Promise<PluginManifestPreviewResult> {
  if (!isAbsolute(checkout) || !sourcePath)
    return { ok: false, reason: 'unsupported_source' };
  try {
    const limit = PLUGIN_MANIFEST_PREVIEW_README_MAX_LENGTH;
    const readme = await withContainedFile(
      checkout,
      resolve(checkout, sourcePath, 'README.md'),
      async (file) => {
        const bytes = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await file.read(
            bytes,
            length,
            bytes.length - length,
            length,
          );
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        const truncated = length > limit;
        const raw = new TextDecoder().decode(
          bytes.subarray(0, Math.min(length, limit)),
          { stream: truncated },
        );
        // Only the body shows, so the front matter is dropped unparsed.
        const frontMatter = FRONT_MATTER_PATTERN.exec(raw);
        const body = frontMatter
          ? raw.slice(frontMatter[0].length).replace(/^\r?\n/, '')
          : raw;
        return { body, ...(truncated ? { truncated: true } : {}) };
      },
    );
    return {
      ok: true,
      preview: {
        skills: [],
        commands: [],
        agents: [],
        hooks: false,
        mcpServers: false,
        mcpServerNames: [],
        readme,
      },
    };
  } catch {
    // A missing, unreadable or outside-checkout README leaves the page as is.
    return { ok: false, reason: 'unsupported_source' };
  }
}

/**
 * The preview of one catalog plugin, read from its cached listing. `retry` is
 * the user asking again after a failed read: a settled failure is dropped and
 * read afresh, while a read still out is shared and a host's rate limit is
 * still waited out.
 */
export async function previewPluginManifest(
  marketplaceId: string,
  pluginName: string,
  { retry = false }: { readonly retry?: boolean } = {},
): Promise<PluginManifestPreviewResult> {
  const catalog = await loadMarketplacesCacheOnly();
  if (!catalog.success || !catalog.data)
    return { ok: false, reason: 'unavailable' };
  const marketplace = catalog.data.marketplaces.find(
    (candidate) => candidate.id === marketplaceId,
  );
  const plugin = marketplace?.plugins.find(
    (candidate) => candidate.name === pluginName,
  );
  if (!marketplace || !plugin) return { ok: false, reason: 'not_found' };
  if (!plugin.externalSource) {
    // The catalog projects the Claude facet first. A Codex-only plugin can
    // belong to a different checkout of this marketplace.
    const provider = plugin.facets.claude ? 'claude' : 'codex';
    const status = marketplace.providerStatus?.[provider];
    const checkout =
      status?.state === 'valid' && status.installLocation
        ? status.installLocation
        : marketplace.installLocation;
    return previewCheckoutReadme(checkout, plugin.sourcePath);
  }
  if (!allowsAutomaticCall('marketplace.manifest-preview'))
    return { ok: false, reason: 'unavailable' };
  // Only the catalog's own source is read, never a URL from the caller.
  const source = resolvePreviewSource(plugin.externalSource);
  if (!source) return { ok: false, reason: 'unsupported_source' };
  const provider =
    plugin.providerSupport.claude === 'none' &&
    plugin.providerSupport.codex !== 'none'
      ? 'codex'
      : 'claude';
  const key = `${source.repo}@${source.ref}:${provider}`;
  if (retry && cache.get(key)?.failed) cache.delete(key);
  return (
    cached(key) ??
    remember(
      key,
      // Complete reads are kept for hours; partial previews and failures
      // are kept briefly, and a rate limit, received or not yet over, only
      // until the host accepts requests again.
      buildPreview(source, provider).then(
        ({ preview, partial }): Settled => ({
          result: { ok: true, preview },
          ttl: partial ? FAILURE_TTL_MS : SUCCESS_TTL_MS,
        }),
        (error: unknown): Settled => ({
          result: {
            ok: false,
            reason:
              error instanceof PreviewFailure ? error.reason : 'unavailable',
          },
          ttl: isRateLimit(error)
            ? Math.min(
                FAILURE_TTL_MS,
                Math.max(0, rateLimitedUntil - Date.now()),
              )
            : FAILURE_TTL_MS,
        }),
      ),
    )
  );
}

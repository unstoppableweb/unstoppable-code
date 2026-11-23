import { gitRemoteEndpoint } from '@canopy/protocol/canopy-core';
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

/**
 * Remote URLs leaving this computer for a remote-control controller
 * (CAN-7030). Every tunnelled result and push passes through the host
 * session, and the channels below carry a Git remote URL that can hold an
 * access token in its userinfo or name a path on this host. The controller
 * gets the network URL without userinfo, and nothing for a local remote.
 * Local windows never pass through here, so they keep the URL as Git printed
 * it. CAN-7082 adds the URL fields a controller only reads: each reaches it
 * without userinfo, fragment or any query value outside an allowlist, and a
 * Git remote URL's query is stripped the same way. A start page's or a saved
 * MCP server's URLs are stripped too: a controller sends them back, and
 * controller-url-writebacks.ts keeps the stored credential when it does.
 * `check:remote-control-remote-urls` fails when a tunnelled channel adds a
 * URL-named field that is neither projected here nor exempted.
 */

type Projection = (value: unknown) => unknown;

interface ChannelProjection {
  /** The fields this channel projects, as the completeness check reads them. */
  readonly fields: readonly string[];
  readonly result?: Projection;
  /** Applied to the push's first argument; the rest pass unchanged. */
  readonly push?: Projection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A remote URL a controller may see: the network URL `worker.git.remote.get`
 * would answer, without userinfo, or `undefined` for a local remote (a path,
 * a `file:` URL, a remote helper), for one `controllerCredentialFreeUrl`
 * fails closed on (checked before `gitRemoteEndpoint` drops the userinfo it
 * reads), and for anything that isn't a string.
 */
export function controllerRemoteUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.trim() !== '' && controllerCredentialFreeUrl(value) === '')
    return undefined;
  const endpoint = gitRemoteEndpoint(value.trim());
  return endpoint.kind === 'network'
    ? controllerCredentialFreeUrl(endpoint.url)
    : undefined;
}

/**
 * Query parameters a controller may see (CAN-7082). A URL can carry a token in
 * any query parameter, so every other parameter is dropped.
 */
export const CONTROLLER_SAFE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'ref',
  'branch',
  'tag',
  'tab',
  'view',
  'page',
  'lang',
  'locale',
]);

const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):([/\\]*)/;
// Schemes whose authority the URL standard reads after any run of `/` or `\`,
// even none: `https:///user:pw@host` and `https:user:pw@host` both carry
// userinfo for `new URL`. Other schemes need `//` before an authority.
const SPECIAL_SCHEMES: ReadonlySet<string> = new Set([
  'http',
  'https',
  'ws',
  'wss',
  'ftp',
  'file',
]);
// What ends an authority: a special scheme's also ends at a `\`, but for any
// other scheme a `\` is part of the userinfo (`ssh://DOMAIN\user:pw@host`).
const SPECIAL_AUTHORITY_END = /[/\\?#]/;
const AUTHORITY_END = /[/?#]/;
// A scheme-less authority: `//host` or `\\host`, which a consumer resolving
// against a base reads as a host, userinfo included.
const SCHEMELESS_AUTHORITY_PREFIX = /^[/\\]{2,}/;
// A whole bracketed IPv6 host, with an optional zone (`[fe80::1%25eth0]`).
const BRACKETED_IPV6_HOST = /^\[[\da-f:.]+(?:%25[\w.~-]+)?\]$/i;
// A name or IPv4 address a `:port` can follow: no `:` and nothing only
// userinfo holds.
const PLAIN_HOST = /^[A-Za-z0-9._~%-]*$/;
// A name and a port, which a reader can also take as `user:password`.
const NAME_AND_PORT = /^[A-Za-z0-9._~%-]*:\d+$/;

/**
 * `value` as the URL standard reads it before parsing: without leading or
 * trailing C0 controls and spaces (U+0000 to U+0020), and without any ASCII
 * tab, LF or CR. A string that needs none of that comes back as it is.
 */
function urlStandardInput(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  let input = '';
  for (const character of value.slice(start, end))
    if (character !== '\t' && character !== '\n' && character !== '\r')
      input += character;
  return input;
}

/**
 * The `scheme:` and separators before a URL's authority, or the leading `//`
 * or `\\` of a scheme-less one, if it has one, with what ends that authority.
 * A scheme-less authority ends as a non-special scheme's does.
 */
function authorityPrefix(
  value: string,
): { prefix: string; endsAuthority: RegExp } | undefined {
  const match = SCHEME_PREFIX.exec(value);
  if (!match) {
    const schemeless = SCHEMELESS_AUTHORITY_PREFIX.exec(value);
    return schemeless
      ? { prefix: schemeless[0], endsAuthority: AUTHORITY_END }
      : undefined;
  }
  const [prefix, name = '', separators = ''] = match;
  const special = SPECIAL_SCHEMES.has(name.toLowerCase());
  if (separators.length < 2 && !special) return undefined;
  return {
    prefix,
    endsAuthority: special ? SPECIAL_AUTHORITY_END : AUTHORITY_END,
  };
}

/**
 * The OAuth request parameters of an authorization URL this computer mints for
 * a sign-in the controller opens (RFC 6749 4.1.1, RFC 7636 4.3, RFC 8707, and
 * OpenID Connect's `prompt`, with Google's `access_type`, which a provider
 * needs to issue a refresh token). The sign-in fails or degrades without
 * them, and none is a stored credential.
 */
const CONTROLLER_OAUTH_REQUEST_PARAMS: ReadonlySet<string> = new Set([
  'access_type',
  'client_id',
  'code_challenge',
  'code_challenge_method',
  'prompt',
  'redirect_uri',
  'resource',
  'response_type',
  'scope',
  'state',
]);

function isSafeQueryPair(
  pair: string,
  safe: ReadonlySet<string> = CONTROLLER_SAFE_QUERY_PARAMS,
): boolean {
  const separator = pair.indexOf('=');
  const name = separator === -1 ? pair : pair.slice(0, separator);
  try {
    return safe.has(decodeURIComponent(name.replace(/\+/g, ' ')));
  } catch {
    return false;
  }
}

/**
 * Whether a URL's authority, up to its first `/`, `?` or `#` (or `\` for a
 * special scheme), ends in `user:password` cut short, rather than
 * `host:port`: after its last `@`, the text after the last `:` is not a port
 * number, or the text before it is not a plain host (a name or IPv4 address,
 * or a bracketed IPv6 host). Such a raw character inside a password ends the
 * authority early, so the real userinfo runs on to the next `@`, even when the
 * username itself holds a raw `@` (`me@corp.com:pa/ss@host`). A password that
 * ends in `]` (`user:pw]/x@host`) or in `:<digits>` (`user:pw:123/x@host`) is
 * cut short too.
 */
function isCutShortUserinfo(authority: string): boolean {
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  if (BRACKETED_IPV6_HOST.test(host)) return false;
  const colon = host.lastIndexOf(':');
  if (colon === -1) return false;
  const name = host.slice(0, colon);
  return !(
    /^\d*$/.test(host.slice(colon + 1)) &&
    (PLAIN_HOST.test(name) || BRACKETED_IPV6_HOST.test(name))
  );
}

/**
 * A `scheme://` URL, or a scheme-less `//host` or `\\host` one, as a
 * controller may see it: without its `user:password@`, its fragment, or any
 * query parameter outside `CONTROLLER_SAFE_QUERY_PARAMS`. The userinfo runs
 * to the last `@` before the path, query or fragment, as Git and the URL
 * standard read it, or to the next `@` when a raw `/`, `?` or `#` (or `\` for
 * a special scheme) cut a password short, then once more to the last `@`
 * before that host's path; if an `@` still remains anywhere after that
 * userinfo, in the path, query or fragment, the whole URL becomes `''`. So
 * does a `name:1234` authority with any `@` after it, which reads as a host
 * and port or as a password cut short.
 * Anything else, and a URL with nothing to strip, comes back unchanged. The
 * input is first read as the URL standard reads it (`urlStandardInput`).
 */
export function controllerCredentialFreeUrl(value: string): string {
  return credentialFreeUrl(value, CONTROLLER_SAFE_QUERY_PARAMS);
}

/**
 * An OAuth authorization URL minted for a sign-in the controller opens, as it
 * may see it: stripped as `controllerCredentialFreeUrl` strips, keeping only
 * the OAuth request parameters in its query.
 */
export function controllerOAuthRequestUrl(value: string): string {
  return credentialFreeUrl(value, CONTROLLER_OAUTH_REQUEST_PARAMS);
}

function credentialFreeUrl(value: string, safe: ReadonlySet<string>): string {
  const parts = urlParts(value);
  if (parts === undefined) return value;
  // Fail closed rather than guess: an `@` still left after a cut-short
  // password, wherever it is, means a reader can end the userinfo there. An
  // empty URL is what a controller already gets for a clone job's source.
  if (
    parts.cutShort &&
    [parts.hostAndPath, parts.query, parts.fragment].some((part) =>
      part.includes('@'),
    )
  )
    return '';
  const kept = parts.query
    .split('&')
    .filter((pair) => pair !== '' && isSafeQueryPair(pair, safe));
  return `${parts.prefix}${parts.hostAndPath}${kept.length > 0 ? `?${kept.join('&')}` : ''}`;
}

/** A URL split the way `controllerCredentialFreeUrl` reads it. */
interface UrlParts {
  readonly prefix: string;
  /** The `user:password` the strip removes, without its `@`. */
  readonly userinfo: string;
  readonly hostAndPath: string;
  readonly query: string;
  readonly fragment: string;
  /**
   * The password was cut short at a `/`, `?`, `#` or `\` (a special scheme's)
   * by the URL standard's reading or by curl's, or the authority is a
   * `name:1234` that could be one, with an `@` after it.
   */
  readonly cutShort: boolean;
}

function urlParts(value: string): UrlParts | undefined {
  const input = urlStandardInput(value);
  const url = authorityPrefix(input);
  if (url === undefined) return undefined;
  const afterScheme = input.slice(url.prefix.length);
  // curl, and so Git, doesn't end a web URL's host at a `\` as the URL
  // standard does: when its reading finds userinfo, or a password cut short,
  // strip by it too. Its authority holds the standard one, so it never strips
  // less.
  const curlEnd = afterScheme.search(AUTHORITY_END);
  const curlAuthority =
    curlEnd === -1 ? afterScheme : afterScheme.slice(0, curlEnd);
  const endsAuthority =
    curlAuthority.includes('@') ||
    (curlEnd !== -1 && isCutShortUserinfo(curlAuthority))
      ? AUTHORITY_END
      : url.endsAuthority;
  const authorityEnd = afterScheme.search(endsAuthority);
  const authority =
    authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const cutShort = authorityEnd !== -1 && isCutShortUserinfo(authority);
  const standardEnd = afterScheme.search(url.endsAuthority);
  const standardCutShort =
    standardEnd !== -1 &&
    (isCutShortUserinfo(afterScheme.slice(0, standardEnd)) ||
      // The URL standard ends a special scheme's authority at a `\` that curl
      // reads as part of the userinfo (`DOMAIN\user:pw@host`).
      (afterScheme[standardEnd] === '\\' &&
        curlAuthority.slice(standardEnd).includes('@')));
  const nameOrPassword =
    authorityEnd !== -1 &&
    NAME_AND_PORT.test(authority.slice(authority.lastIndexOf('@') + 1)) &&
    afterScheme.slice(authorityEnd).includes('@');
  const userinfoEnd = cutShort
    ? afterScheme.indexOf('@', authorityEnd)
    : authority.lastIndexOf('@');
  const afterUserinfo = afterScheme.slice(userinfoEnd + 1);
  // One bounded re-pass: a cut-short password that also held a raw `@`
  // leaves its tail before the real host's `@`.
  const hostEnd = afterUserinfo.search(endsAuthority);
  const remainder = cutShort
    ? afterUserinfo.slice(
        afterUserinfo
          .slice(0, hostEnd === -1 ? undefined : hostEnd)
          .lastIndexOf('@') + 1,
      )
    : afterUserinfo;
  const fragmentAt = remainder.indexOf('#');
  const beforeFragment =
    fragmentAt === -1 ? remainder : remainder.slice(0, fragmentAt);
  const queryAt = beforeFragment.indexOf('?');
  return {
    prefix: url.prefix,
    userinfo: afterScheme
      .slice(0, afterScheme.length - remainder.length)
      .replace(/@$/, ''),
    hostAndPath:
      queryAt === -1 ? beforeFragment : beforeFragment.slice(0, queryAt),
    query: queryAt === -1 ? '' : beforeFragment.slice(queryAt + 1),
    fragment: fragmentAt === -1 ? '' : remainder.slice(fragmentAt + 1),
    cutShort: cutShort || standardCutShort || nameOrPassword,
  };
}

/**
 * Each part of `value` a controller must never see, on its own: the username
 * and password `controllerCredentialFreeUrl` strips, the value of every query
 * parameter outside `CONTROLLER_SAFE_QUERY_PARAMS`, and the fragment, as
 * written, percent-decoded, form-decoded (`+` read as a space) and each of
 * those percent-encoded. An error can quote one of them without the rest of
 * the URL.
 */
export function controllerCredentialParts(value: string): string[] {
  const parts = urlParts(value);
  if (parts === undefined) return [];
  const colon = parts.userinfo.indexOf(':');
  const secrets = [
    parts.userinfo,
    colon === -1 ? parts.userinfo : parts.userinfo.slice(0, colon),
    colon === -1 ? '' : parts.userinfo.slice(colon + 1),
    ...parts.query
      .split('&')
      .filter((pair) => pair !== '' && !isSafeQueryPair(pair))
      .map((pair) => {
        const separator = pair.indexOf('=');
        return separator === -1 ? pair : pair.slice(separator + 1);
      }),
    parts.fragment,
  ];
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret === '') continue;
    forms.add(secret);
    for (const decoded of [
      percentDecoded(secret),
      percentDecoded(secret.replace(/\+/g, ' ')),
    ]) {
      forms.add(decoded);
      forms.add(encodeURIComponent(decoded));
    }
  }
  return [...forms];
}

/** `text` percent-decoded, or as it is when it holds a malformed escape. */
function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** What a URL a controller sends back stores (CAN-7082). */
export type ControllerUrlMerge =
  | { readonly kind: 'carry'; readonly value: string }
  | { readonly kind: 'as-sent' }
  | { readonly kind: 'changed' };

/**
 * A URL a controller sends back, against the values `stored` for the same
 * field, most recent first. The controller only ever got each one through
 * `controllerCredentialFreeUrl`. The first whose controller form is exactly
 * `sent`, byte for byte, decides, and the search stops there: one holding
 * credential parts is kept whole (same scheme, host, port, path, kept query
 * and all), and one without is the URL as sent. A URL carrying credential
 * parts of its own is one the controller typed, and is stored as sent. Any
 * other URL, where a stored value held credential parts, is `changed`: its
 * old credential is never carried to it, and the write stores it as sent or
 * refuses it.
 */
export function mergeControllerUrl(
  sent: string,
  stored: readonly string[],
): ControllerUrlMerge {
  let storedCredential = false;
  for (const value of stored) {
    const free = controllerCredentialFreeUrl(value);
    if (sent === free)
      return free === value ? { kind: 'as-sent' } : { kind: 'carry', value };
    if (free !== value) storedCredential = true;
  }
  return storedCredential && controllerCredentialParts(sent).length === 0
    ? { kind: 'changed' }
    : { kind: 'as-sent' };
}

/** `part` as a pattern, with every `%XX` escape matched in either hex case. */
function partPattern(part: string): RegExp {
  return new RegExp(
    part
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(
        /%([0-9A-Fa-f])([0-9A-Fa-f])/g,
        (_escape, high: string, low: string) =>
          `%[${high.toLowerCase()}${high.toUpperCase()}][${low.toLowerCase()}${low.toUpperCase()}]`,
      ),
    'g',
  );
}

/**
 * `text` as a controller may see it (CAN-7082): `url` replaced whole by its
 * controller form, then each secret part of it on its own (an error can quote
 * one without the rest, as written, percent-decoded or percent-encoded, in
 * either hex case), then every other URL in it. The whole-URL pass comes
 * first since a URL can hold characters that end no URL pattern
 * (`?ref=team's`).
 */
export function controllerCredentialFreeText(
  text: string,
  url: string,
): string {
  let redacted =
    url === ''
      ? text
      : text.split(url).join(controllerCredentialFreeGitUrl(url));
  for (const part of controllerCredentialParts(url).sort(
    (a, b) => b.length - a.length,
  ))
    redacted = redacted.replace(partPattern(part), '[redacted]');
  return redacted.replace(
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"<>]+/g,
    (found: string) => controllerCredentialFreeUrl(found),
  );
}

/**
 * A Git remote URL as a controller may see it. A value with a URL authority
 * (`scheme://`, a web scheme's `https:host`, or a scheme-less `//host`) goes
 * straight to `controllerCredentialFreeUrl`, since `gitRemoteEndpoint` reads
 * `https:user:pw@host` as scp-like and drops the scheme the strip needs. Any
 * other network remote first loses its scp-like userinfo. A local remote's
 * path is left as it is; host paths are CAN-7047's.
 */
export function controllerCredentialFreeGitUrl(value: string): string {
  if (authorityPrefix(urlStandardInput(value)) !== undefined)
    return controllerCredentialFreeUrl(value);
  const endpoint = gitRemoteEndpoint(value.trim());
  return controllerCredentialFreeUrl(
    endpoint.kind === 'network' ? endpoint.url : value,
  );
}

/**
 * Every string, or string list, under one of `fields` at any depth of a
 * tunnelled value, through `strip`, and the `url` of an object under one of
 * `valueFields`. The value is first read as the session
 * wire carries it (JSON), so nothing reaches the controller unwalked: a URL
 * object becomes its string, a class instance its own fields, a Map `{}`.
 * A value the wire can't carry throws, which refuses the frame. The copy
 * leaves main's value unchanged.
 */
function stripUrlFields(
  fields: ReadonlyMap<string, (url: string) => string>,
  valueFields: ReadonlySet<string>,
): Projection {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isRecord(value)) return value;
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const strip = fields.get(key);
      if (strip === undefined) copy[key] = walk(entry);
      else if (typeof entry === 'string') copy[key] = strip(entry);
      else if (Array.isArray(entry))
        copy[key] = entry.map((item: unknown) =>
          typeof item === 'string' ? strip(item) : walk(item),
        );
      else {
        const walked = walk(entry);
        copy[key] =
          valueFields.has(key) &&
          isRecord(entry) &&
          typeof entry.url === 'string' &&
          isRecord(walked)
            ? { ...walked, url: strip(entry.url) }
            : walked;
      }
    }
    return copy;
  };
  return (value) => {
    if (value === undefined) return value;
    const wire: unknown = JSON.parse(JSON.stringify(value));
    return walk(wire);
  };
}

/** `record` with its optional `field` redacted, or dropped when not network. */
function withOptionalRemoteUrl(record: unknown, field: string): unknown {
  if (!isRecord(record) || !(field in record)) return record;
  const { [field]: raw, ...rest } = record;
  const url = controllerRemoteUrl(raw);
  return url === undefined ? rest : { ...rest, [field]: url };
}

function mapArray(value: unknown, project: Projection): unknown {
  return Array.isArray(value) ? value.map(project) : value;
}

function withField(
  record: unknown,
  field: string,
  project: Projection,
): unknown {
  if (!isRecord(record) || !(field in record)) return record;
  return { ...record, [field]: project(record[field]) };
}

const optionalRemoteUrl =
  (field: string): Projection =>
  (record) =>
    withOptionalRemoteUrl(record, field);

const repoRemoteUrls: Projection = (repos) =>
  mapArray(repos, optionalRemoteUrl('remoteUrl'));

/**
 * A clone job's source. A controller gets no source at all, not a redacted
 * one: an empty URL fails closed, since a clone or a retry refuses it before
 * any effect, and it can carry neither a token nor a host path.
 */
const cloneJobForController: Projection = (job) =>
  isRecord(job) && 'remoteUrl' in job ? { ...job, remoteUrl: '' } : job;

const cloneJobsForController: Projection = (jobs) =>
  mapArray(jobs, cloneJobForController);

const referenceRepoStatus: Projection = (status) =>
  withOptionalRemoteUrl(status, 'remoteUrl');

/**
 * URL fields a controller only reads (CAN-7082): no tunnelled channel takes
 * them back from a caller, so stripping their credential parts can't
 * overwrite a stored value. Fields a controller sends back (start pages, a
 * saved MCP server's URLs) are stripped by path in `SENT_BACK_PROJECTIONS`.
 */
const OUT_ONLY_GIT_URL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // canopy.json clone URLs, which a team writes and which can hold a token.
  manifestUrl: [
    IPC_CHANNELS.projectsLoad,
    IPC_CHANNELS.projectsSave,
    IPC_CHANNELS.workspaceAddFromFolder,
    IPC_CHANNELS.workspaceAddFromRemote,
    IPC_CHANNELS.workspaceAddRepo,
    IPC_CHANNELS.workspaceCombineWorktreeWithExistingWorktree,
    IPC_CHANNELS.workspaceCombineWorktreeWithWorkspace,
    IPC_CHANNELS.workspaceCreate,
    IPC_CHANNELS.workspaceCreateNew,
    IPC_CHANNELS.workspaceCreateTemporaryFromRepos,
    IPC_CHANNELS.workspaceCreateTemporaryWorktreeFromRepos,
    IPC_CHANNELS.workspaceCreateTemporaryWorktreeFromWorkspaces,
    IPC_CHANNELS.workspaceImportFromRepo,
    IPC_CHANNELS.workspacePromoteTemporary,
    IPC_CHANNELS.workspaceReadSettingsData,
    IPC_CHANNELS.workspaceSetPrivateMemory,
  ],
  // `url` here is a canopy.json repository entry's clone URL.
  url: [IPC_CHANNELS.canopyJsonRead, IPC_CHANNELS.workspaceInitGit],
  // A plugin marketplace's source, which can be a Git URL with a token.
  sourceUrl: [
    IPC_CHANNELS.appAdvisorSettingsView,
    IPC_CHANNELS.pluginCatalogList,
    PLUGINS_CHANNELS.ADD,
    PLUGINS_CHANNELS.LOAD,
    PLUGINS_CHANNELS.LOAD_CACHE_ONLY,
    PLUGINS_CHANNELS.REFRESH,
    PLUGINS_CHANNELS.REMOVE,
    PLUGINS_CHANNELS.UPDATE,
  ],
};

const OUT_ONLY_URL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // A detected or plugin-bundled MCP server's URL, and the open in-app page.
  url: [
    IPC_CHANNELS.appAdvisorSettingsView,
    MCP_SERVER_CHANNELS.LIST_DETECTED,
    IPC_CHANNELS.pluginCatalogList,
    PLUGINS_CHANNELS.ADD,
    PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
    PLUGINS_CHANNELS.INSTALL_PLUGIN,
    PLUGINS_CHANNELS.LOAD,
    PLUGINS_CHANNELS.LOAD_CACHE_ONLY,
    PLUGINS_CHANNELS.PREPARE_CODEX_COMPATIBILITY,
    PLUGINS_CHANNELS.REFRESH,
    PLUGINS_CHANNELS.REMOVE,
    PLUGINS_CHANNELS.SET_CODEX_COMPAT_DISABLED,
    PLUGINS_CHANNELS.UPDATE,
    IPC_CHANNELS.appAdvisorGetState,
  ],
  // An in-app browser page in the resource monitor.
  displayUrl: [
    IPC_CHANNELS.resourceMonitorGetSnapshot,
    IPC_CHANNELS.resourceMonitorSnapshot,
  ],
  // The model gateway's base URL.
  baseUrl: [IPC_CHANNELS.modelRegistryGet, IPC_CHANNELS.modelRegistryUpdated],
};

// Fields whose name isn't URL-like but whose value is a URL, as a string or as
// the `url` of an object: a plugin's external source is `{ url }` or, in older
// records, the URL string. It can be an scp-style Git remote, so it is
// stripped as a Git URL. `remote-url-fields.json` lists only URL-named
// fields, so these stay out of each projection's `fields`.
const OUT_ONLY_URL_VALUE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  externalSource: [
    IPC_CHANNELS.appAdvisorSettingsView,
    IPC_CHANNELS.pluginCatalogList,
    PLUGINS_CHANNELS.ADD,
    PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
    PLUGINS_CHANNELS.INSTALL_PLUGIN,
    PLUGINS_CHANNELS.LOAD,
    PLUGINS_CHANNELS.LOAD_CACHE_ONLY,
    PLUGINS_CHANNELS.PREPARE_CODEX_COMPATIBILITY,
    PLUGINS_CHANNELS.REFRESH,
    PLUGINS_CHANNELS.REMOVE,
    PLUGINS_CHANNELS.SET_CODEX_COMPAT_DISABLED,
    PLUGINS_CHANNELS.UPDATE,
  ],
};

/** `channel -> field -> strip` for the out-only fields. */
function outOnlyStrips(): Map<string, Map<string, (url: string) => string>> {
  const byChannel = new Map<string, Map<string, (url: string) => string>>();
  const add = (
    fields: Readonly<Record<string, readonly string[]>>,
    strip: (url: string) => string,
  ): void => {
    for (const [field, channels] of Object.entries(fields))
      for (const channel of channels) {
        const strips =
          byChannel.get(channel) ?? new Map<string, (url: string) => string>();
        strips.set(field, strip);
        byChannel.set(channel, strips);
      }
  };
  add(OUT_ONLY_GIT_URL_FIELDS, controllerCredentialFreeGitUrl);
  add(OUT_ONLY_URL_FIELDS, controllerCredentialFreeUrl);
  add(OUT_ONLY_URL_VALUE_FIELDS, controllerCredentialFreeGitUrl);
  return byChannel;
}

/** The CAN-7030 projections, then the out-only fields' strips on top. */
function withOutOnlyFields(
  projections: Readonly<Record<string, ChannelProjection>>,
): Readonly<Record<string, ChannelProjection>> {
  const combined: Record<string, ChannelProjection> = { ...projections };
  for (const [channel, strips] of outOnlyStrips()) {
    const strip = stripUrlFields(
      strips,
      new Set(Object.keys(OUT_ONLY_URL_VALUE_FIELDS)),
    );
    const existing = combined[channel];
    const then =
      (first: Projection | undefined): Projection =>
      (value) =>
        strip(first ? first(value) : value);
    const urlFields = [...strips.keys()].filter(
      (field) => !(field in OUT_ONLY_URL_VALUE_FIELDS),
    );
    combined[channel] = {
      fields: [...new Set([...(existing?.fields ?? []), ...urlFields])],
      result: then(existing?.result),
      push: then(existing?.push),
    };
  }
  return Object.freeze(combined);
}

/** `value` as the session wire carries it (JSON), as `stripUrlFields` reads it. */
function wireCopy(value: unknown): unknown {
  if (value === undefined) return value;
  const wire: unknown = JSON.parse(JSON.stringify(value));
  return wire;
}

function withStringField(
  record: unknown,
  field: string,
  strip: (url: string) => string,
): unknown {
  if (!isRecord(record) || typeof record[field] !== 'string') return record;
  return { ...record, [field]: strip(record[field]) };
}

/** Every `startPage: { kind: 'url', url }` at any depth, its URL stripped. */
const startPagesForController: Projection = (value) => {
  const walk = (entry: unknown, key: string | undefined): unknown => {
    if (Array.isArray(entry)) return entry.map((item) => walk(item, undefined));
    if (!isRecord(entry)) return entry;
    if (key === 'startPage' && entry.kind === 'url')
      return withStringField(entry, 'url', controllerCredentialFreeUrl);
    const copy: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(entry))
      copy[name] = walk(child, name);
    return copy;
  };
  return walk(wireCopy(value), undefined);
};

/** A saved MCP server's URL and OAuth endpoints, stripped. */
const mcpServerFileForController: Projection = (file) =>
  withField(wireCopy(file), 'server', (server) =>
    withField(server, 'definition', (definition) =>
      withField(
        withStringField(definition, 'url', controllerCredentialFreeUrl),
        'oauth',
        (oauth) =>
          withStringField(
            withStringField(
              oauth,
              'authorizationUrl',
              controllerCredentialFreeUrl,
            ),
            'tokenUrl',
            controllerCredentialFreeUrl,
          ),
      ),
    ),
  );

/** The channels whose replies carry a start page a controller can send back. */
const START_PAGE_CHANNELS: readonly string[] = [
  IPC_CHANNELS.chatProjectBlueprintsList,
  IPC_CHANNELS.chatProjectBlueprintsRefresh,
  IPC_CHANNELS.chatProjectCreate,
  IPC_CHANNELS.chatProjectCreateFromTemplate,
  IPC_CHANNELS.chatProjectList,
  IPC_CHANNELS.chatProjectTemplateBuild,
  IPC_CHANNELS.projectsLoad,
  IPC_CHANNELS.projectsSave,
  IPC_CHANNELS.standaloneChatImportProject,
  IPC_CHANNELS.startPageResolve,
  IPC_CHANNELS.workspaceAddFromFolder,
  IPC_CHANNELS.workspaceAddFromRemote,
  IPC_CHANNELS.workspaceCombineWorktreeWithExistingWorktree,
  IPC_CHANNELS.workspaceCombineWorktreeWithWorkspace,
  IPC_CHANNELS.workspaceCreate,
  IPC_CHANNELS.workspaceCreateNew,
  IPC_CHANNELS.workspaceCreateTemporaryFromRepos,
  IPC_CHANNELS.workspaceCreateTemporaryWorktreeFromRepos,
  IPC_CHANNELS.workspaceCreateTemporaryWorktreeFromWorkspaces,
  IPC_CHANNELS.workspaceImportFromRepo,
  IPC_CHANNELS.workspacePromoteTemporary,
  IPC_CHANNELS.workspaceReadSettingsData,
  IPC_CHANNELS.workspaceSetPrivateMemory,
];

/**
 * URL fields a controller can send back (CAN-7082), stripped by path so other
 * fields of the same name pass as the registry records them. A start page and
 * a saved MCP server's URLs come back through the writes in
 * controller-url-writebacks.ts, which keep the stored credential. The sign-in
 * URL `mcp-servers:start-account` mints keeps its OAuth request parameters,
 * which the sign-in the controller opens needs.
 */
const SENT_BACK_PROJECTIONS: Readonly<Record<string, ChannelProjection>> = {
  ...Object.fromEntries(
    START_PAGE_CHANNELS.map((channel): [string, ChannelProjection] => [
      channel,
      { fields: ['url'], result: startPagesForController },
    ]),
  ),
  [MCP_SERVER_CHANNELS.LOAD_SERVER]: {
    fields: ['authorizationUrl', 'tokenUrl', 'url'],
    result: mcpServerFileForController,
  },
  [MCP_SERVER_CHANNELS.SAVE_SERVER]: {
    fields: ['authorizationUrl', 'tokenUrl', 'url'],
    result: mcpServerFileForController,
  },
  [MCP_SERVER_CHANNELS.START_ACCOUNT]: {
    fields: ['authorizationUrl'],
    result: (response: unknown): unknown =>
      withStringField(
        wireCopy(response),
        'authorizationUrl',
        controllerOAuthRequestUrl,
      ),
  },
};

/** The channels whose replies carry a URL a controller can send back. */
export const CONTROLLER_SENT_BACK_URL_CHANNELS: readonly string[] = Object.keys(
  SENT_BACK_PROJECTIONS,
);

/** The projections so far, then the sent-back fields' strips on top. */
function withSentBackFields(
  projections: Readonly<Record<string, ChannelProjection>>,
): Readonly<Record<string, ChannelProjection>> {
  const combined: Record<string, ChannelProjection> = { ...projections };
  for (const [channel, sentBack] of Object.entries(SENT_BACK_PROJECTIONS)) {
    const existing = combined[channel];
    const strip = sentBack.result;
    const first = existing?.result;
    combined[channel] = {
      fields: [...new Set([...(existing?.fields ?? []), ...sentBack.fields])],
      result:
        strip && first
          ? (value: unknown): unknown => strip(first(value))
          : (strip ?? first),
      ...(existing?.push ? { push: existing.push } : {}),
    };
  }
  return Object.freeze(combined);
}

export const CONTROLLER_REMOTE_URL_PROJECTIONS: Readonly<
  Record<string, ChannelProjection>
> = withSentBackFields(
  withOutOnlyFields({
    // Its handler already redacts for every caller but the local window; this
    // keeps the tunnel's answer redacted whichever caller main derived.
    [IPC_CHANNELS.repoGetRemoteUrl]: {
      fields: ['remoteUrl'],
      result: (value: unknown): unknown =>
        isRecord(value) && 'remoteUrl' in value
          ? {
              ...value,
              remoteUrl: controllerRemoteUrl(value.remoteUrl) ?? null,
            }
          : value,
    },
    [IPC_CHANNELS.workspaceReferenceRepoStatusEvent]: {
      fields: ['remoteUrl'],
      push: (event: unknown): unknown =>
        withField(event, 'status', referenceRepoStatus),
    },
    [IPC_CHANNELS.workspaceReadSettingsData]: {
      fields: ['remoteUrl'],
      result: (data: unknown): unknown =>
        withField(data, 'referenceRepoStatus', referenceRepoStatus),
    },
    [IPC_CHANNELS.cloneJobsList]: {
      fields: ['remoteUrl'],
      result: cloneJobsForController,
    },
    [IPC_CHANNELS.cloneJobsChanged]: {
      fields: ['remoteUrl'],
      push: cloneJobsForController,
    },
    [IPC_CHANNELS.chatSessionCloudExportList]: {
      fields: ['remoteUrl'],
      result: (list: unknown): unknown =>
        withField(list, 'data', (data) =>
          mapArray(data, (summary) =>
            withField(summary, 'repos', repoRemoteUrls),
          ),
        ),
    },
    [IPC_CHANNELS.chatSessionImportInspect]: {
      fields: ['remoteUrl'],
      result: (inspection: unknown): unknown => {
        const manifest = withField(inspection, 'manifestSummary', (summary) =>
          withField(summary, 'repos', repoRemoteUrls),
        );
        const workspace = withField(manifest, 'workspaceSummary', (summary) =>
          withField(summary, 'repos', repoRemoteUrls),
        );
        return withField(workspace, 'missingRepos', repoRemoteUrls);
      },
    },
  }),
);

/** A tunnelled invoke's result as the controller may see it. */
export function projectControllerResult(
  channel: string,
  value: unknown,
): unknown {
  const project = CONTROLLER_REMOTE_URL_PROJECTIONS[channel]?.result;
  return project ? project(value) : value;
}

/** A push's arguments as the controller may see them; never the originals. */
export function projectControllerPush(
  channel: string,
  args: readonly unknown[],
): unknown[] {
  const project = CONTROLLER_REMOTE_URL_PROJECTIONS[channel]?.push;
  if (!project || args.length === 0) return [...args];
  const [first, ...rest] = args;
  return [project(first), ...rest];
}

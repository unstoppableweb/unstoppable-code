import {
  parseHarnessCompatibility,
  type HarnessCompatibility,
} from './harness-compatibility';

/**
 * A plugin's light preview before it is added (Customize, spec 3b): what its
 * repository's file listing and native manifests say, read without cloning.
 * It fills Works with and Contents until Add brings the real files.
 */
export interface PluginManifestPreview {
  /** Per harness, from the same rules as a scanned plugin; partial is fine. */
  readonly compatibility?: HarnessCompatibility;
  /**
   * Part of the repository went unread (a truncated listing, a file cap or
   * the deadline), so members may be missing: the names are not the whole
   * plugin, and none named does not mean it has none.
   */
  readonly partial?: true;
  /** Skill, command and agent names, from their conventional folders. */
  readonly skills: readonly string[];
  readonly commands: readonly string[];
  readonly agents: readonly string[];
  /** App names, listed from their folders; absent from an older desktop. */
  readonly apps?: readonly string[];
  /** A root `.app.json` app config is listed; its apps arrive with Add. */
  readonly rootApp?: boolean;
  /** Mod and LSP server names from the configs read; absent from an older desktop. */
  readonly mods?: readonly string[];
  readonly lspServers?: readonly string[];
  /** Hooks or MCP servers are listed; their details arrive with Add. */
  readonly hooks: boolean;
  readonly mcpServers: boolean;
  /** The MCP server names read from the native manifests and config files. */
  readonly mcpServerNames: readonly string[];
  /**
   * Each named MCP server's URL or command line, as its config states it,
   * for display only. A server whose values are too long is left out.
   */
  readonly mcpServerEndpoints?: readonly PluginManifestPreviewMcpServer[];
  /** The repository's README, read on page load; capped in size. */
  readonly readme?: { readonly body: string; readonly truncated?: boolean };
  /**
   * One-line descriptions from each skill, command and agent file's front
   * matter, keyed `skill:<name>`, `command:<name>`, or `agent:<name>` using
   * the exact member name.
   * Only the first few files are read, so a large plugin lists some.
   */
  readonly descriptions?: Readonly<Record<string, string>>;
}

/** An MCP server's endpoint before Add: a URL, or a command and its args. */
export type PluginManifestPreviewMcpServer =
  | { readonly name: string; readonly type: 'http'; readonly url: string }
  | {
      readonly name: string;
      readonly type: 'command';
      readonly command: string;
      readonly args?: readonly string[];
    };

/** Why a preview couldn't be read; the page keeps what it already knows. */
export type PluginManifestPreviewFailure =
  /** Not a repository the preview can read (only GitHub today). */
  | 'unsupported_source'
  | 'not_found'
  /** The host asked us to wait; tried again later. */
  | 'rate_limited'
  | 'unavailable';

export type PluginManifestPreviewResult =
  | { readonly ok: true; readonly preview: PluginManifestPreview }
  | { readonly ok: false; readonly reason: PluginManifestPreviewFailure };

const FAILURES: ReadonlySet<string> = new Set<PluginManifestPreviewFailure>([
  'unsupported_source',
  'not_found',
  'rate_limited',
  'unavailable',
]);

/** Names are capped so a large repository can't flood a page. */
export const PLUGIN_MANIFEST_PREVIEW_MAX_NAMES = 200;
export const PLUGIN_MANIFEST_PREVIEW_NAME_MAX_LENGTH = 128;
export const PLUGIN_MANIFEST_PREVIEW_README_MAX_LENGTH = 64 * 1024;
export const PLUGIN_MANIFEST_PREVIEW_DESCRIPTION_MAX_LENGTH = 400;
/** A server's URL or command, and each of at most 32 args. */
export const PLUGIN_MANIFEST_PREVIEW_ENDPOINT_MAX_LENGTH = 2048;
export const PLUGIN_MANIFEST_PREVIEW_MAX_ARGS = 32;
export const PLUGIN_MANIFEST_PREVIEW_ARG_MAX_LENGTH = 512;

// Shown as one line of text: no control characters or Unicode line breaks.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function isFailure(value: unknown): value is PluginManifestPreviewFailure {
  return typeof value === 'string' && FAILURES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displayText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    value.trim().length > 0 &&
    !CONTROL_CHARACTER.test(value)
  );
}

/**
 * One MCP server's endpoint, bounded for display; `null` when it has no
 * plain URL or command, or a value is too long or holds control characters.
 */
export function parsePluginManifestPreviewMcpServer(
  value: unknown,
): PluginManifestPreviewMcpServer | null {
  if (
    !isRecord(value) ||
    !displayText(value.name, PLUGIN_MANIFEST_PREVIEW_NAME_MAX_LENGTH)
  )
    return null;
  const name = value.name;
  if (value.type === 'http')
    return displayText(value.url, PLUGIN_MANIFEST_PREVIEW_ENDPOINT_MAX_LENGTH)
      ? { name, type: 'http', url: value.url }
      : null;
  if (
    value.type !== 'command' ||
    !displayText(value.command, PLUGIN_MANIFEST_PREVIEW_ENDPOINT_MAX_LENGTH)
  )
    return null;
  const command = value.command;
  if (value.args === undefined) return { name, type: 'command', command };
  if (
    !Array.isArray(value.args) ||
    value.args.length > PLUGIN_MANIFEST_PREVIEW_MAX_ARGS
  )
    return null;
  const args: string[] = [];
  for (const arg of value.args) {
    // An empty arg is kept: it is part of the command line.
    if (
      typeof arg !== 'string' ||
      arg.length > PLUGIN_MANIFEST_PREVIEW_ARG_MAX_LENGTH ||
      CONTROL_CHARACTER.test(arg)
    )
      return null;
    args.push(arg);
  }
  return { name, type: 'command', command, ...(args.length ? { args } : {}) };
}

/**
 * Whether a member or server name shows in Contents: one line, not blank,
 * within the name length. The producer applies the same rule, so the page
 * and the wire parser see the same names.
 */
export function isPluginManifestPreviewName(value: unknown): value is string {
  return displayText(value, PLUGIN_MANIFEST_PREVIEW_NAME_MAX_LENGTH);
}

function names(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value.slice(0, PLUGIN_MANIFEST_PREVIEW_MAX_NAMES)) {
    if (typeof item !== 'string') return null;
    if (isPluginManifestPreviewName(item)) out.push(item);
  }
  return out;
}

/** Reads a preview result from the wire; `null` when malformed. */
export function parsePluginManifestPreviewResult(
  value: unknown,
): PluginManifestPreviewResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === false)
    return isFailure(value.reason) ? { ok: false, reason: value.reason } : null;
  if (value.ok !== true || !isRecord(value.preview)) return null;
  const preview = value.preview;
  const skills = names(preview.skills);
  const commands = names(preview.commands);
  const agents = names(preview.agents);
  // Absent from an older desktop's answer: none named.
  const apps = preview.apps === undefined ? [] : names(preview.apps);
  const mods = preview.mods === undefined ? [] : names(preview.mods);
  const lspServers =
    preview.lspServers === undefined ? [] : names(preview.lspServers);
  const mcpServerNames =
    preview.mcpServerNames === undefined ? [] : names(preview.mcpServerNames);
  if (
    skills === null ||
    commands === null ||
    agents === null ||
    apps === null ||
    mods === null ||
    lspServers === null ||
    mcpServerNames === null ||
    typeof preview.hooks !== 'boolean' ||
    typeof preview.mcpServers !== 'boolean'
  )
    return null;
  const compatibility = parseHarnessCompatibility(preview.compatibility);
  const readme =
    isRecord(preview.readme) &&
    typeof preview.readme.body === 'string' &&
    preview.readme.body.length <= PLUGIN_MANIFEST_PREVIEW_README_MAX_LENGTH
      ? {
          body: preview.readme.body,
          ...(preview.readme.truncated === true ? { truncated: true } : {}),
        }
      : undefined;
  const descriptions: Record<string, string> = {};
  if (isRecord(preview.descriptions))
    for (const [key, text] of Object.entries(preview.descriptions).slice(
      0,
      PLUGIN_MANIFEST_PREVIEW_MAX_NAMES * 3,
    ))
      if (
        typeof text === 'string' &&
        text.length <= PLUGIN_MANIFEST_PREVIEW_DESCRIPTION_MAX_LENGTH
      )
        descriptions[key] = text;
  // A malformed or oversized server is left out; the rest still show.
  const mcpServerEndpoints = Array.isArray(preview.mcpServerEndpoints)
    ? preview.mcpServerEndpoints
        .slice(0, PLUGIN_MANIFEST_PREVIEW_MAX_NAMES)
        .flatMap((server: unknown) => {
          const parsed = parsePluginManifestPreviewMcpServer(server);
          return parsed ? [parsed] : [];
        })
    : [];
  return {
    ok: true,
    preview: {
      ...(compatibility ? { compatibility } : {}),
      ...(preview.partial === true ? { partial: true } : {}),
      skills,
      commands,
      agents,
      ...(apps.length > 0 ? { apps } : {}),
      ...(preview.rootApp === true ? { rootApp: true } : {}),
      ...(mods.length > 0 ? { mods } : {}),
      ...(lspServers.length > 0 ? { lspServers } : {}),
      hooks: preview.hooks,
      mcpServers: preview.mcpServers,
      mcpServerNames,
      ...(mcpServerEndpoints.length > 0 ? { mcpServerEndpoints } : {}),
      ...(readme ? { readme } : {}),
      ...(Object.keys(descriptions).length > 0 ? { descriptions } : {}),
    },
  };
}

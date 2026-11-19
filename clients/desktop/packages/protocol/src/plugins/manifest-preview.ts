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
  /** Skill, command and agent names, from their conventional folders. */
  readonly skills: readonly string[];
  readonly commands: readonly string[];
  readonly agents: readonly string[];
  /** Hooks or MCP servers are listed; their details arrive with Add. */
  readonly hooks: boolean;
  readonly mcpServers: boolean;
  /** The MCP server names `.mcp.json` declares, when it could be read. */
  readonly mcpServerNames: readonly string[];
}

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

function isFailure(value: unknown): value is PluginManifestPreviewFailure {
  return typeof value === 'string' && FAILURES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function names(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value.slice(0, PLUGIN_MANIFEST_PREVIEW_MAX_NAMES)) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (trimmed && trimmed.length <= PLUGIN_MANIFEST_PREVIEW_NAME_MAX_LENGTH)
      out.push(trimmed);
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
  const mcpServerNames =
    preview.mcpServerNames === undefined ? [] : names(preview.mcpServerNames);
  if (
    skills === null ||
    commands === null ||
    agents === null ||
    mcpServerNames === null ||
    typeof preview.hooks !== 'boolean' ||
    typeof preview.mcpServers !== 'boolean'
  )
    return null;
  const compatibility = parseHarnessCompatibility(preview.compatibility);
  return {
    ok: true,
    preview: {
      ...(compatibility ? { compatibility } : {}),
      skills,
      commands,
      agents,
      hooks: preview.hooks,
      mcpServers: preview.mcpServers,
      mcpServerNames,
    },
  };
}

import { MARKETPLACE_PUBLIC_SHARE_PREFIXES } from '../marketplace';
import type { ResourceOwner } from '../resource-owner';
import type { MarketplaceInfo, PluginInfo } from './catalog';
// ---------------------------------------------------------------------------
// Portable plugin reference wire contracts.
//
// These shapes are the single source of truth for any surface that needs to
// serialize a shareable plugin or skill ref across the desktop/web boundary:
//
//   - pipeline `plugin_collections` defaults
//   - shared (Canopy Server) pipeline payloads
//   - shared Collection items
//   - hook chat `plugins` arrays
//   - top-level `canopy.json.plugins` recommendations
//
// Collection references themselves are intentionally NOT represented here.
// Shared Collections carry their own document contract; any portable plugin
// or skill inside one must still be a `ShareablePluginRef` shape.
//
// This module must remain pure: no Node, Electron, React, Prisma, Next.js, or
// app imports. It runs in the renderer, the main process, and the web app.
//
// `./catalog` carries the neutral plugin-catalog shapes (marketplace/plugin
// rows, per-provider facets, component details) hoisted from desktop-shared;
// this index re-exports it so both charters share the `@canopy/protocol/plugins`
// entry point.
// ---------------------------------------------------------------------------

export * from './catalog';

/**
 * Source of a shareable plugin/skill reference.
 *
 * - `builtin` identifies bundled skills/plugins shipped with Canopy. The `id`
 *   is the stable namespace id (currently always `app`); importers resolve it
 *   to a locally registered built-in source.
 * - `github` identifies any reference hosted on GitHub. The `repo` field is an
 *   `owner/name` pair, validated by the accompanying helper. No protocol or
 *   trailing path is allowed.
 */
export interface ShareableBuiltinSource {
  type: 'builtin';
  /**
   * Stable namespace id for the built-in skill source. Importers resolve this
   * to a locally registered built-in source.
   */
  id: string;
}

export interface ShareableGitHubSource {
  type: 'github';
  /**
   * GitHub repo reference in `owner/name` form, validated by
   * {@link normalizeGitHubRepoRef}. No protocol/scheme or trailing path.
   */
  repo: string;
}

export interface ShareableCodexBuiltinMarketplaceSource {
  type: 'codex-builtin';
  /**
   * Codex-reported built-in marketplace id, for example `openai-curated`.
   */
  id: string;
}

export type ShareablePluginSource =
  | ShareableBuiltinSource
  | ShareableGitHubSource;

export type ShareableCodexPluginSource = ShareableCodexBuiltinMarketplaceSource;

/**
 * Reference to a shareable skill (built-in or GitHub-hosted).
 */
export interface ShareableSkillRef {
  type: 'skill';
  source: ShareablePluginSource;
  skill_name: string;
}

/**
 * Reference to a shareable Claude plugin. Claude plugins are always sourced
 * from a marketplace; that marketplace may be GitHub-backed or the built-in
 * Canopy marketplace (`{ type: 'builtin', id: 'app' }`).
 */
export interface ShareableClaudePluginRef {
  type: 'claude_plugin';
  marketplace: ShareablePluginSource;
  plugin_name: string;
}

/**
 * Provider-neutral marketplace plugin ref. Resolution is model/provider-aware:
 * Codex sessions first try a Codex-native plugin match, then fall back to the
 * Claude plugin path; Claude and Ollama sessions use the Claude plugin path.
 */
export interface ShareableDynamicPluginRef {
  type: 'plugin';
  marketplace: ShareablePluginSource;
  plugin_name: string;
}

/**
 * Reference to a Codex-native plugin. These plugins come from Codex-only
 * marketplaces and are not valid Claude compatibility plugin refs.
 */
export interface ShareableCodexPluginRef {
  type: 'codex_plugin';
  marketplace: ShareableCodexPluginSource;
  plugin_name: string;
}

/**
 * Union of all portable plugin refs. Anything that is _not_ a member of this
 * union (e.g. a Collection ref or a local-only marketplace) is intentionally
 * not portable and must not be serialized into shareable surfaces.
 */
export type ShareablePluginRef =
  | ShareableSkillRef
  | ShareableDynamicPluginRef
  | ShareableClaudePluginRef
  | ShareableCodexPluginRef;

// ---------------------------------------------------------------------------
// Pure normalization / validation helpers.
//
// These run on both the renderer and the server. They must not import Node
// builtins, Electron, or React. They must throw on structurally invalid input
// so callers can distinguish "garbage" from "missing".
// ---------------------------------------------------------------------------

const BUILTIN_SOURCE_ID = 'app';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readShareablePluginSource(
  source: unknown,
): ShareablePluginSource {
  if (!isRecord(source)) {
    throw new Error('Shareable plugin source must be an object');
  }
  if (source.type === 'builtin') {
    if (typeof source.id !== 'string') {
      throw new Error('Built-in plugin source id must be a string');
    }
    return { type: 'builtin', id: source.id };
  }
  if (source.type === 'github') {
    if (typeof source.repo !== 'string') {
      throw new Error('GitHub plugin source repo must be a string');
    }
    return { type: 'github', repo: source.repo };
  }
  throw new Error(
    `Unknown ShareablePluginSource discriminator: ${typeof source.type === 'string' ? source.type : '(missing)'}`,
  );
}

function readShareableCodexPluginSource(
  source: unknown,
): ShareableCodexPluginSource {
  if (!isRecord(source)) {
    throw new Error('Shareable Codex plugin source must be an object');
  }
  if (source.type === 'codex-builtin') {
    if (typeof source.id !== 'string') {
      throw new Error('Codex built-in plugin source id must be a string');
    }
    const id = source.id.trim();
    if (!id) {
      throw new Error('Codex built-in plugin source id must not be empty');
    }
    return { type: 'codex-builtin', id };
  }
  throw new Error(
    `Unknown ShareableCodexPluginSource discriminator: ${typeof source.type === 'string' ? source.type : '(missing)'}`,
  );
}

/**
 * Normalize a GitHub `owner/repo` string.
 *
 * - trims leading/trailing whitespace
 * - lowercases both segments
 * - rejects scheme prefixes, embedded paths, and missing segments
 *
 * Throws on structurally invalid input.
 */
export function normalizeGitHubRepoRef(repo: string): string {
  if (typeof repo !== 'string') {
    throw new Error(`GitHub repo ref must be a string, got ${typeof repo}`);
  }
  const trimmed = repo.trim();
  if (trimmed.length === 0) {
    throw new Error('GitHub repo ref must not be empty');
  }
  if (trimmed.includes('://') || trimmed.startsWith('git@')) {
    throw new Error(
      `GitHub repo ref "${repo}" must not include a scheme/URL prefix`,
    );
  }
  const parts = trimmed.split('/');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new Error(
      `GitHub repo ref "${repo}" must be formatted as "owner/repo"`,
    );
  }
  return `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}

export function isValidGitHubRepoRef(repo: unknown): repo is string {
  if (typeof repo !== 'string') return false;
  try {
    normalizeGitHubRepoRef(repo);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a canonicalized copy of a `ShareablePluginSource`.
 * - `builtin` sources always collapse to `{ type: 'builtin', id: 'app' }`.
 * - `github` sources are returned with a normalized lowercased `owner/repo`.
 */
export function normalizeShareableSource(
  source: ShareablePluginSource,
): ShareablePluginSource {
  if (source.type === 'builtin') {
    return { type: 'builtin', id: BUILTIN_SOURCE_ID };
  }
  return { type: 'github', repo: normalizeGitHubRepoRef(source.repo) };
}

/**
 * Validate a free-form skill name. Skill names must be non-empty, may not
 * contain path separators, and may not include whitespace. This matches the
 * naming rules enforced by the local custom-skill writer.
 */
export function normalizeSkillName(name: string): string {
  if (typeof name !== 'string') {
    throw new Error(`Skill name must be a string, got ${typeof name}`);
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Skill name must not be empty');
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(`Skill name "${name}" must not contain path separators`);
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`Skill name "${name}" must not contain whitespace`);
  }
  return trimmed;
}

/**
 * Validate a free-form Claude plugin name. Plugin names follow the same rules
 * as skill names (non-empty, no path separators, no whitespace).
 */
export function normalizePluginName(name: string): string {
  if (typeof name !== 'string') {
    throw new Error(`Plugin name must be a string, got ${typeof name}`);
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Plugin name must not be empty');
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(`Plugin name "${name}" must not contain path separators`);
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`Plugin name "${name}" must not contain whitespace`);
  }
  return trimmed;
}

/**
 * Serialize a `ShareablePluginSource` to a stable string key.
 * - `builtin:app`
 * - `github:<lowercased owner/repo>`
 */
export function serializeShareableSource(
  source: ShareablePluginSource,
): string {
  if (source.type === 'builtin') {
    return 'builtin:app';
  }
  return `github:${normalizeGitHubRepoRef(source.repo)}`;
}

export function serializeCodexPluginSource(
  source: ShareableCodexPluginSource,
): string {
  return `codex-builtin:${source.id.trim().toLowerCase()}`;
}

/**
 * Return a deterministic string key for a `ShareablePluginRef`.
 * Keys are stable across machines and case-insensitive.
 *
 * Examples:
 *   skill:builtin:app:ud-git:commit-messages
 *   skill:github:acme/skills:ud-git:commit-messages
 *   plugin:github:ud/marketplace:browser
 *   claude_plugin:github:ud/marketplace:browser
 *   codex_plugin:codex-builtin:openai-curated:codex-security
 */
export function getShareablePluginRefKey(ref: ShareablePluginRef): string {
  if (ref.type === 'skill') {
    const sourceKey = serializeShareableSource(ref.source);
    const skillName = (ref.skill_name ?? '').trim().toLowerCase();
    return `skill:${sourceKey}:${skillName}`;
  }
  if (ref.type === 'codex_plugin') {
    const marketplaceKey = serializeCodexPluginSource(ref.marketplace);
    const pluginName = (ref.plugin_name ?? '').trim().toLowerCase();
    return `codex_plugin:${marketplaceKey}:${pluginName}`;
  }
  if (ref.type === 'plugin') {
    const marketplaceKey = serializeShareableSource(ref.marketplace);
    const pluginName = (ref.plugin_name ?? '').trim().toLowerCase();
    return `plugin:${marketplaceKey}:${pluginName}`;
  }
  const marketplaceKey =
    ref.marketplace.type === 'builtin'
      ? serializeShareableSource(ref.marketplace)
      : `github:${normalizeGitHubRepoRef(ref.marketplace.repo)}`;
  const pluginName = (ref.plugin_name ?? '').trim().toLowerCase();
  return `claude_plugin:${marketplaceKey}:${pluginName}`;
}

// ---------------------------------------------------------------------------
// Shared plugin registry (CAN-2323).
//
// Registry entries contain portable references and display metadata only.
// Plugin content remains at its built-in or GitHub-backed source.
// ---------------------------------------------------------------------------

export const PLUGIN_SHARE_PATH_PREFIX =
  MARKETPLACE_PUBLIC_SHARE_PREFIXES.plugin;

export function pluginSharePath(externalId: string): string {
  return `${PLUGIN_SHARE_PATH_PREFIX}/${externalId}`;
}

export const MAX_SHARED_PLUGIN_NAME_LENGTH = 256;
export const MAX_SHARED_PLUGIN_DESCRIPTION_LENGTH = 2000;

export type SharedPluginShareScope = 'private' | 'team' | 'organization';

export interface SharedPluginPublicShareInfo {
  externalId: string;
  pinnedRefKey: string;
  upToDate: boolean;
  sharePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface SharedPluginSummary {
  /** Viewer-specific canonical mutation verdict; absent on older servers. */
  canUpdate?: boolean;
  /** Viewer-specific canonical delete verdict; absent on older servers. */
  canDelete?: boolean;
  owner: ResourceOwner;
  shareScope: SharedPluginShareScope;
  createdBy: { id: string; name: string | null };
  externalId: string;
  refKey: string;
  ref: ShareablePluginRef;
  name: string;
  description: string | null;
  marketplaceOrigin: string;
  createdAt: string;
  updatedAt: string;
  publicShare?: SharedPluginPublicShareInfo | null;
}

// Deliberately distinct for API symmetry; v1 has no detail-only fields.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SharedPluginDetail extends SharedPluginSummary {}

export interface ListSharedPluginsRequest {
  serverId: string;
  createdBy?: 'me' | 'anyone';
  query?: string;
}

export interface ListSharedPluginsResponse {
  serverId: string;
  data: SharedPluginSummary[];
}

export interface SharedPluginGetRequest {
  serverId: string;
  remoteId: string;
}

export interface SharedPluginCreateRequest {
  serverId: string;
  ref: ShareablePluginRef;
  name: string;
  description?: string | null;
  shareScope?: SharedPluginShareScope;
  teamId?: string;
  organizationId?: string;
}

export interface SharedPluginUpdateRequest extends SharedPluginCreateRequest {
  remoteId: string;
}

export interface SharedPluginDeleteRequest {
  serverId: string;
  remoteId: string;
}

export interface PublishSharedPluginPublicShareResponse {
  publicShare: SharedPluginPublicShareInfo;
}

/**
 * Return a normalized copy of a `ShareablePluginRef`. Throws on structurally
 * invalid input (unknown discriminator, malformed source, empty name).
 */
export function normalizeShareablePluginRef(ref: unknown): ShareablePluginRef {
  if (!isRecord(ref)) {
    throw new Error('ShareablePluginRef must be an object');
  }
  if (ref.type === 'skill') {
    if (typeof ref.skill_name !== 'string') {
      throw new Error('Skill name must be a string');
    }
    return {
      type: 'skill',
      source: normalizeShareableSource(readShareablePluginSource(ref.source)),
      skill_name: normalizeSkillName(ref.skill_name),
    };
  }
  if (ref.type === 'claude_plugin') {
    if (typeof ref.plugin_name !== 'string') {
      throw new Error('Plugin name must be a string');
    }
    // Marketplace plugins may be GitHub-backed or built-in. Any other source
    // discriminator is rejected by readShareablePluginSource; normalization
    // collapses builtin sources to `{ type: 'builtin', id: 'app' }` and keeps
    // GitHub repos lowercased via normalizeGitHubRepoRef.
    const marketplace = normalizeShareableSource(
      readShareablePluginSource(ref.marketplace),
    );
    return {
      type: 'claude_plugin',
      marketplace,
      plugin_name: normalizePluginName(ref.plugin_name),
    };
  }
  if (ref.type === 'plugin') {
    if (typeof ref.plugin_name !== 'string') {
      throw new Error('Plugin name must be a string');
    }
    return {
      type: 'plugin',
      marketplace: normalizeShareableSource(
        readShareablePluginSource(ref.marketplace),
      ),
      plugin_name: normalizePluginName(ref.plugin_name),
    };
  }
  if (ref.type === 'codex_plugin') {
    if (typeof ref.plugin_name !== 'string') {
      throw new Error('Plugin name must be a string');
    }
    return {
      type: 'codex_plugin',
      marketplace: readShareableCodexPluginSource(ref.marketplace),
      plugin_name: normalizePluginName(ref.plugin_name),
    };
  }
  throw new Error(
    `Unknown ShareablePluginRef discriminator: ${typeof ref.type === 'string' ? ref.type : '(missing)'}`,
  );
}

/**
 * Type-narrowing helper that returns `true` only if `value` is a structurally
 * valid `ShareablePluginRef`. Does not throw.
 */
export function isShareablePluginRef(
  value: unknown,
): value is ShareablePluginRef {
  if (typeof value !== 'object' || value === null) return false;
  try {
    normalizeShareablePluginRef(value);
    return true;
  } catch {
    return false;
  }
}

// Install status rules, shared by the renderer, ui-shared and the main
// process's shared imports (CAN-6003).

/**
 * True when a plugin is hosted externally and has not yet been installed
 * (cloned/cached) — it has an external source but no resolved details on any
 * facet or at the top level. Mirrors PluginDetailView's `needsInstall`.
 */
export function pluginNeedsInstall(plugin: PluginInfo): boolean {
  if (plugin.parked) return false;
  if (!plugin.externalSource) {
    return false;
  }
  return !pluginHasContent(plugin);
}

/** Count of plugins in a marketplace that still need installing. */
export function countPluginsNeedingInstall(
  marketplace: MarketplaceInfo,
): number {
  return marketplace.plugins.filter(pluginNeedsInstall).length;
}

/** Resolved content on any provider is authoritative, including empty manifests. */
export function pluginHasContent(plugin: PluginInfo): boolean {
  return (
    !!plugin.facets.claude?.details ||
    !!plugin.facets.codex?.details ||
    !!plugin.facets.codexCompatibility?.details ||
    !!plugin.details
  );
}

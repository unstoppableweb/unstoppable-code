import type { ResourceOwner } from '../resource-owner';
import type { HarnessCompatibility } from './harness-compatibility';
import type { ItemHarnessInstalls } from './harness-installs';
// ---------------------------------------------------------------------------
// Neutral plugin-catalog shapes.
//
// Browser-safe, provider-neutral descriptions of the locally resolved plugin
// marketplace catalog: marketplace rows, plugin rows, per-provider facets, and
// component detail shapes. These are read/display contracts shared by the
// desktop renderer and the web app (portal surfaces).
//
// Deliberately NOT here (they stay in
// `packages/execution-engine/src/types/plugins.ts`):
//   - on-disk Claude file shapes (`KnownMarketplace*`, `MarketplaceManifest`,
//     `PluginManifest`)
//   - the persisted plugins cache and its v1 migration types
//   - marketplace operation/registration request/result types
//   - the preload `PluginsAPI` surface
//
// This module must remain pure: no Node, Electron, React, Prisma, Next.js, or
// app imports. It runs in the renderer, the main process, and the web app.
// ---------------------------------------------------------------------------

// ---- Built-In Marketplace Identity ----

/**
 * Canopy-internal marketplace id for the built-in (bundled) plugin
 * marketplace. The `/` is intentional and compatible with selection keys that
 * split on the final slash. Provider-facing manifest names and UI display
 * strings are brand-specific and live in brand-aware modules
 * (`@canopy/execution-engine/plugin-refs` and the renderer), never here.
 */
export const BUILTIN_PLUGIN_MARKETPLACE_ID = 'builtin/app';

/**
 * Stable, machine-independent source URL marker for the built-in marketplace.
 *
 * Kept as a literal rather than derived from
 * `serializeShareableSource({ type: 'builtin', id: 'app' })` (which yields the
 * same `builtin:app` key) to avoid a module-evaluation-order cycle between
 * this file and `./index`. The contract test pins the two in sync.
 */
export const BUILTIN_PLUGIN_MARKETPLACE_SOURCE_URL = 'builtin:app';

/** True only for the canonical built-in marketplace id. */
export function isBuiltInPluginMarketplaceId(id: string): boolean {
  return id === BUILTIN_PLUGIN_MARKETPLACE_ID;
}

// ---- Curated Marketplace Identity ----

/**
 * Canopy-internal marketplace id for the curated (cloud-sourced) plugin
 * marketplace. Locally materialized on disk from the curated plugin catalog
 * served by Canopy Web (see `apps/desktop-app/src/main/plugins/curated-plugin-catalog.ts`
 * and the desktop sync engine). Like the built-in marketplace, it is not
 * removable by the user, but it is distinct from `builtIn`: its plugins are
 * synced from the cloud catalog rather than bundled with the app.
 */
export const CURATED_PLUGIN_MARKETPLACE_ID = 'curated/cloud';

const SYSTEM_CATALOG_GITHUB_REPOS: ReadonlyMap<string, string> = new Map([
  ['claude-plugins-official', 'anthropics/claude-plugins-official'],
  ['anthropic-skills', 'anthropics/skills'],
  ['openai-curated', 'openai/plugins'],
]);

/**
 * The GitHub repo behind a system catalog, for hosts holding a catalog row that
 * carries no source URL (the cloud catalog's rows).
 */
export function systemCatalogGithubRepo(catalogId: string): string | undefined {
  return SYSTEM_CATALOG_GITHUB_REPOS.get(catalogId);
}

/**
 * Stable, machine-independent source URL marker for the curated marketplace.
 * Mirrors {@link BUILTIN_PLUGIN_MARKETPLACE_SOURCE_URL}'s role for the
 * built-in marketplace.
 */
export const CURATED_PLUGIN_MARKETPLACE_SOURCE_URL = 'curated:cloud';

/** True only for the canonical curated marketplace id. */
export function isCuratedPluginMarketplaceId(id: string): boolean {
  return id === CURATED_PLUGIN_MARKETPLACE_ID;
}

// ---- Plugin Component Detail Types ----

export interface PluginSkillInfo {
  name: string;
  description: string;
  path: string;
  /**
   * Whether this skill may be invoked directly by the user (e.g. surfaced in
   * the Fast Slash Menu). Derived from the skill's `user-invocable` frontmatter
   * by the plugin scanner (backend). A missing value means **invocable**, to
   * stay backward compatible with caches/scanners that predate this field.
   */
  userInvocable?: boolean;
}

export interface PluginAgentInfo {
  name: string;
  description: string;
  filePath: string;
}

export interface PluginCommandInfo {
  name: string;
  description: string;
  filePath: string;
}

export interface PluginAppInfo {
  name: string;
  description: string;
  filePath: string;
}

export interface PluginComponentContent {
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface PluginHookInfo {
  event: string;
  matcher?: string;
  hookType: string;
  async?: boolean;
  command?: string;
}

export interface PluginModInfo {
  module: string;
  hooksFile: string;
}

export interface PluginMcpServerInfo {
  name: string;
  type: 'command' | 'http';
  /** Present when type is 'command' */
  command?: string;
  args?: string[];
  /** Present when type is 'http' */
  url?: string;
}

export interface PluginLspServerInfo {
  name: string;
  command: string;
  args?: string[];
  languages?: string[];
}

export interface PluginDetails {
  skills: PluginSkillInfo[];
  agents: PluginAgentInfo[];
  commands: PluginCommandInfo[];
  apps?: PluginAppInfo[];
  hooks: PluginHookInfo[];
  mods?: PluginModInfo[];
  mcpServers: PluginMcpServerInfo[];
  lspServers: PluginLspServerInfo[];
  hasReadme: boolean;
}

// ---- Provider Support Types ----

/** Provider for plugin / marketplace resolution. */
export type PluginProvider = 'claude' | 'codex';

/** Per-provider validity for a marketplace row. */
export type PluginProviderState = 'valid' | 'invalid';

/**
 * Codex-side support mode for a plugin.
 * - `native`: Codex-native plugin facet exists in the marketplace.
 * - `compat`: Codex-compat facet generated from a Claude facet.
 * - `none`: Plugin is not usable from Codex.
 */
export type CodexPluginSupportMode = 'native' | 'compat' | 'none';

/**
 * Per-provider status for a marketplace.
 *
 * A provider is considered valid only when the provider accepted (or already
 * knew) the marketplace AND Canopy detected at least one plugin for that
 * provider. Otherwise the state is `'invalid'` and `error` may carry a
 * provider-supplied reason.
 */
export interface MarketplaceProviderStatus {
  provider: PluginProvider;
  state: PluginProviderState;
  /** Whether the provider accepted (or already knew) the marketplace. */
  accepted: boolean;
  /** Count of plugins detected for this provider in this marketplace. */
  pluginCount: number;
  /** ISO timestamp of when this provider was last checked. */
  lastCheckedAt: string;
  /** Provider-supplied error string when accepted === false or scan failed. */
  error?: string;
  /** Marketplace display name as reported by the provider, if known. */
  marketplaceName?: string;
  /** Provider-side marketplace manifest path, if known. */
  marketplacePath?: string;
  /** Provider-side install root for this marketplace, if it diverges. */
  installLocation?: string;
  /**
   * Git revision where Codex was proven structurally unable to load this
   * marketplace. Provider registration is retried only after this revision
   * changes or an explicit user refresh is requested.
   */
  structurallyInvalidAtRevision?: string;
}

/**
 * Per-provider support shape for a single plugin.
 *
 * - `claude`: `'native'` when a Claude facet exists, otherwise `'none'`.
 * - `codex`: `'native'` when a Codex-native facet exists, `'compat'` when only
 *   a Codex-compat facet exists, `'none'` when Codex cannot run the plugin.
 */
export interface PluginProviderSupport {
  claude: 'native' | 'none';
  codex: CodexPluginSupportMode;
}

/**
 * External (git-backed) plugin source reference.
 *
 * Structural stand-in for the object branch of the on-disk
 * `MarketplacePluginEntry['source']` shape (which stays in
 * `packages/execution-engine/src/types/plugins.ts` with the other Claude file
 * formats). The two must stay structurally identical.
 * Historical marketplace objects can identify a repo without a URL or source tag.
 */
export interface MarketplacePluginExternalSource {
  source?: string;
  url?: string;
  sha?: string;
}

/**
 * A single per-provider facet of a plugin.
 *
 * Invariants (also documented on `PluginInfo.facets`):
 * - When `provider === 'claude'`, `mode === 'native'`.
 * - When `provider === 'codex'`, `mode` is `'native'` or `'compat'`.
 * - A Codex-compat facet is only materialized when no Codex-native facet
 *   exists with the same (case-insensitive) `name`.
 */
export interface PluginProviderFacet {
  provider: PluginProvider;
  mode: 'native' | 'compat';
  name: string;
  /** Human-readable label when it differs from provider/install identity. */
  displayName?: string;
  description?: string;
  version?: string;
  author?: string;
  category?: string;
  homepage?: string;
  /** Product logo shown in marketplace discovery and installed summaries. */
  logoUrl?: string;
  installLocation: string;
  sourcePath: string;
  marketplacePath?: string;
  externalSource?: MarketplacePluginExternalSource;
  cachePath?: string;
  cachedAt?: string;
  details?: PluginDetails | null;
}

// ---- Built-In Plugin Install Status (serialized across IPC) ----

/**
 * Per-provider install status for a bundled (built-in) plugin facet.
 *
 * The main process computes/serializes `available`, `installed`, `enabled`,
 * `version`, `installPath`, `error`, and `installError`. The renderer derives display text and
 * its own transient `installing` state (never serialized). See the transport
 * plan's "Provider Install Status Vocabulary" for the shared state vocabulary.
 */
export interface BuiltInProviderInstallStatus {
  /** Provider facet exists for this bundled plugin. */
  available: boolean;
  /** Install metadata confirms the plugin is installed for this provider. */
  installed: boolean;
  /** Whether the installed plugin is enabled, when known. */
  enabled?: boolean;
  version?: string;
  installPath?: string;
  /** Populated when reading this provider's install state failed. */
  error?: string;
  /**
   * Why the most recent install into this provider failed. Kept until a later
   * install into it succeeds, so the detail page can show the failure beside
   * the Install button that retries it. Distinct from `error`, which is a
   * status read that failed, not an install.
   */
  installError?: string;
}

/**
 * Serialized built-in install status carried inside
 * `PluginInfo.globalInstallStatus`. Optional per provider; `checkedAt` records
 * when the status was last computed.
 */
export interface BuiltInPluginInstallStatus {
  claude?: BuiltInProviderInstallStatus;
  codex?: BuiltInProviderInstallStatus;
  /** ISO timestamp of when this status snapshot was computed. */
  checkedAt: string;
}

// ---- Resolved/Cached Types (used by renderer) ----

/**
 * Resolved plugin row presented to the renderer.
 *
 * Top-level fields are the canonical / merged view used by lists and search.
 * The per-provider truth lives on `facets`; consumers that need provider-
 * specific metadata (paths, install location, version) should read from the
 * appropriate facet rather than the top-level field.
 *
 * Facet population invariants:
 * - `facets.claude` is populated only when a Claude-native facet exists. Its
 *   `provider` is `'claude'` and `mode` is `'native'`.
 * - `facets.codex` is populated only when a Codex-native facet exists. Its
 *   `provider` is `'codex'` and `mode` is `'native'`.
 * - `facets.codexCompatibility` is populated only when a Codex-compat facet
 *   has been materialized from a Claude facet. Its `provider` is `'codex'`
 *   and `mode` is `'compat'`.
 * - `facets.codex` and `facets.codexCompatibility` are never both populated
 *   when their `name` matches (case-insensitive).
 */
export interface PluginInfo {
  /** Revision-bound derived metadata; absence preserves provider fallback. */
  harnessCompatibility?: HarnessCompatibility;
  /**
   * Derived (not persisted): what one Add did for each harness (CAN-6816).
   * Desktop main adds it from its own record file when serving rows; it is
   * never written into the plugin cache.
   */
  harnessInstalls?: ItemHarnessInstalls;
  /** Canopy retains this installation while its Codex facet is parked. Not provider convergence. */
  parked?: boolean;
  /** Optional catalog example prompt; absent in older caches. */
  tryNowPrompt?: string;
  /** Server provenance when available; absence is not proof of Personal ownership. */
  owner?: ResourceOwner;
  name: string;
  /** Human-readable label; `name` remains the stable provider/install key. */
  displayName?: string;
  description?: string;
  version?: string;
  author?: string;
  category?: string;
  homepage?: string;
  /** Product logo shown in marketplace discovery and installed summaries. */
  logoUrl?: string;
  sourcePath: string;
  marketplaceId: string;
  details?: PluginDetails | null;
  /**
   * True when this plugin is shipped by the built-in (bundled) marketplace.
   * Optional for backward compatibility with `version: 2` caches that predate
   * built-in plugins.
   */
  builtIn?: boolean;
  /**
   * True when this plugin is shipped by the curated (cloud-sourced)
   * marketplace. Optional for backward compatibility with `version: 2` caches
   * that predate curated plugins. Mutually exclusive with `builtIn`.
   */
  curated?: boolean;
  /**
   * True when the curated catalog recommends this plugin for the connected
   * user's onboarding role. Absent on non-curated and legacy cached rows.
   */
  recommended?: boolean;
  /**
   * Per-provider install status for a built-in plugin. Only populated for
   * built-in plugins; consumers must treat it as optional.
   */
  globalInstallStatus?: BuiltInPluginInstallStatus;
  /** Present when the plugin source is an external git URL or struct ref. */
  externalSource?: MarketplacePluginExternalSource;
  /** Path to local cache directory if the plugin has been installed. */
  cachePath?: string;
  /** ISO timestamp of when the cache was last populated. */
  cachedAt?: string;

  /** Per-provider support summary for this plugin. */
  providerSupport: PluginProviderSupport;

  /** Per-provider facets. See PluginInfo doc for population invariants. */
  facets: {
    claude?: PluginProviderFacet;
    codex?: PluginProviderFacet;
    codexCompatibility?: PluginProviderFacet;
  };
  /**
   * Derived (not persisted) flag: true when the user has disabled Claude→Codex
   * compatibility mode for this plugin. Populated by the main process when
   * serving rows to the renderer; never written into the plugin cache. Only
   * meaningful when `providerSupport.codex === 'compat'`.
   */
  codexCompatDisabled?: boolean;
}

/**
 * Marketplace source discriminator. `'github'`, `'builtin'`, and `'curated'`
 * are the known values; the open `string` keeps the type forward-compatible
 * with any source a provider may report. (`string & {}` preserves literal
 * autocomplete without collapsing the union to a bare `string`.)
 */
export type MarketplaceSourceType =
  | 'github'
  | 'builtin'
  | 'curated'
  | (string & {});

/**
 * Resolved marketplace row presented to the renderer.
 *
 * Field semantics:
 * - `installLocation` is the canonical scan root used by trust checks. It is
 *   set to the first non-empty of:
 *     1. Claude provider install location
 *     2. Codex provider install location
 *     3. Repository working copy
 *   Provider-specific install roots live on
 *   `providerStatus.claude.installLocation` and
 *   `providerStatus.codex.installLocation` when they diverge.
 * - `pluginCount` is the count of deduplicated rows in `plugins` (post-merge),
 *   not the sum of per-provider counts.
 * - `validProviders` is derived from `providerStatus`:
 *   `(claude.state === 'valid' ? ['claude'] : []).concat(codex.state === 'valid' ? ['codex'] : [])`.
 *   An empty array means the marketplace is broken on every provider.
 */
export interface MarketplaceInfo {
  /** Server provenance when available; absence is not proof of Personal ownership. */
  owner?: ResourceOwner;
  id: string;
  name: string;
  description?: string;
  /** The marketplace manifest's `owner.name`, when it declares one. */
  ownerName?: string;
  sourceType: MarketplaceSourceType;
  sourceUrl: string;
  /**
   * True when this row represents the built-in (bundled) marketplace. Optional
   * for backward compatibility with caches that predate built-in plugins.
   */
  builtIn?: boolean;
  /**
   * True when this row represents the curated (cloud-sourced) marketplace,
   * locally materialized from the curated plugin catalog. Optional for
   * backward compatibility with caches that predate curated plugins.
   * Mutually exclusive with `builtIn`.
   */
  curated?: boolean;
  /**
   * Whether the marketplace row can be removed from Canopy. `false` for the
   * built-in and curated marketplaces. Optional; absent is treated as
   * removable.
   */
  removable?: boolean;
  installLocation: string;
  lastUpdated?: string;
  pluginCount: number;
  plugins: PluginInfo[];

  providerStatus: {
    claude: MarketplaceProviderStatus;
    codex: MarketplaceProviderStatus;
  };
  /** Derived from providerStatus; never persisted independently. */
  validProviders: PluginProvider[];
}

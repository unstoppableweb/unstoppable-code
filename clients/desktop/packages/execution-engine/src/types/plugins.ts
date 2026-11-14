// ---------------------------------------------------------------------------
// Plugin marketplace types.
//
// The neutral plugin-catalog shapes (marketplace/plugin rows, per-provider
// facets, component details, marketplace identity constants) live in
// `@canopy/protocol/plugins` so the web app and the desktop app agree on the
// same data model. They are re-exported below so existing imports of
// `@canopy/execution-engine/types/plugins` keep working unchanged.
//
// Do NOT redefine those shapes locally — the protocol package is the single
// source of truth. What remains declared here is desktop-local by design:
// on-disk Claude file shapes, the persisted plugins cache and its v1
// migration types, marketplace operation/registration IPC shapes, and the
// preload `PluginsAPI` surface.
// ---------------------------------------------------------------------------

import type {
  ListSharedPluginsRequest,
  ListSharedPluginsResponse,
  MarketplaceInfo,
  MarketplaceProviderStatus,
  PluginComponentContent,
  PluginDetails,
  PluginInfo,
  PluginProvider,
  SharedPluginCreateRequest,
  SharedPluginDeleteRequest,
  SharedPluginDetail,
  SharedPluginGetRequest,
  SharedPluginPublicShareInfo,
  SharedPluginUpdateRequest,
} from '@canopy/protocol/plugins';
import type { IPCResult } from './pipeline';
import type { ShareablePluginRef } from '@canopy/protocol/plugins';
import type { ChatTabPluginSelections } from '../execution-types';
import type { InvocableInventoryEnableRef } from './invocable-inventory';
import type { PipelinePackageAnalysisSummary } from './pipeline';

export interface AnalyzeSharedPluginReferenceRequest {
  ref: ShareablePluginRef;
}

export interface ResolvePortablePluginRefsRequest {
  refs: ShareablePluginRef[];
  providerType?:
    | 'claude'
    | 'codex'
    | 'ollama'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode';
}

export interface ResolvePortablePluginRefsResponse {
  selections: ChatTabPluginSelections;
  unresolved: Array<{
    ref: ShareablePluginRef;
    displayName: string;
    displaySource: string;
  }>;
}

export interface ResolvePortableEnableRefRequest {
  enableRef: InvocableInventoryEnableRef;
  /** Informational: the portable ref is provider-neutral, like `resolvePortableRefs`. */
  providerType?:
    | 'claude'
    | 'codex'
    | 'ollama'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode';
}

export type {
  BuiltInPluginInstallStatus,
  BuiltInProviderInstallStatus,
  CodexPluginSupportMode,
  MarketplaceInfo,
  MarketplacePluginExternalSource,
  MarketplaceProviderStatus,
  MarketplaceSourceType,
  PluginAgentInfo,
  PluginAppInfo,
  PluginCommandInfo,
  PluginComponentContent,
  PluginDetails,
  PluginHookInfo,
  PluginInfo,
  PluginLspServerInfo,
  PluginMcpServerInfo,
  PluginProvider,
  PluginProviderFacet,
  PluginProviderState,
  PluginProviderSupport,
  PluginSkillInfo,
  ListSharedPluginsRequest,
  ListSharedPluginsResponse,
  SharedPluginCreateRequest,
  SharedPluginDeleteRequest,
  SharedPluginDetail,
  SharedPluginGetRequest,
  SharedPluginPublicShareInfo,
  SharedPluginUpdateRequest,
  SharedPluginSummary,
} from '@canopy/protocol/plugins';

export {
  BUILTIN_PLUGIN_MARKETPLACE_ID,
  BUILTIN_PLUGIN_MARKETPLACE_SOURCE_URL,
  CURATED_PLUGIN_MARKETPLACE_ID,
  CURATED_PLUGIN_MARKETPLACE_SOURCE_URL,
  isBuiltInPluginMarketplaceId,
  isCuratedPluginMarketplaceId,
} from '@canopy/protocol/plugins';

export type ManagedMcpServerKind = 'dynamic' | 'proxy' | 'plugin';

// ---- Source Data Types (from Claude filesystem) ----

/** Shape of values in ~/.claude/plugins/known_marketplaces.json */
export interface KnownMarketplaceEntry {
  source: {
    source: string; // e.g. "github"
    repo?: string; // e.g. "owner/repo"
    url?: string; // Claude may use this for git-backed marketplace URLs.
  };
  installLocation: string;
  lastUpdated: string;
  autoUpdate?: boolean;
}

/** Shape of known_marketplaces.json (flat object keyed by marketplace ID) */
export type KnownMarketplacesFile = Record<string, KnownMarketplaceEntry>;

/** Shape of {installLocation}/.claude-plugin/marketplace.json */
export interface MarketplaceManifest {
  name?: string;
  description?: string;
  plugins: MarketplacePluginEntry[];
}

/**
 * Individual plugin entry within marketplace.json.
 *
 * The object branch of `source` is structurally mirrored by the protocol's
 * `MarketplacePluginExternalSource` (used on the hoisted `PluginInfo` /
 * `PluginProviderFacet` rows); the two must stay structurally identical.
 */
export interface MarketplacePluginEntry {
  tryNowPrompt?: string;
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  source: string | { source?: string; url?: string; sha?: string };
  category?: string;
  author?: { name: string; email?: string };
  homepage?: string;
  /** Per-user recommendation signal on the managed curated marketplace. */
  recommended?: boolean;
}

/** Shape of {pluginDir}/.claude-plugin/plugin.json */
export interface PluginManifest {
  name?: string;
  version?: string;
  author?: { name: string; email?: string };
  description?: string;
  homepage?: string;
  // Component path overrides (string path, array of paths, or inline config)
  skills?: string | string[];
  agents?: string | string[];
  commands?: string | string[];
  apps?: string | string[];
  hooks?: string | string[] | Record<string, unknown>;
  mcpServers?: string | string[] | Record<string, unknown>;
  lspServers?: string | string[] | Record<string, unknown>;
}

/**
 * Persisted plugins cache.
 *
 * Lifecycle / migration rules:
 * - Version 1 cache (the previous shape) can be read only as stale input.
 * - Version 2 is the only written format.
 * - V1 rows may be projected for presentation only, without persisting V2
 *   or authorizing execution. A dedicated refresh revalidates provider data
 *   before writing authoritative V2. Facet-less V2 is damaged, not legacy.
 */
export interface PluginsCache {
  version: 2;
  lastRefreshed: string;
  /**
   * ISO timestamp of the last refresh that ran the per-marketplace provider
   * update commands (`claude plugin marketplace update` / Codex upgrade).
   * Startup discovery skips those expensive network commands while this is
   * fresh; absent on caches written before the field existed, which forces a
   * full provider refresh on the next startup.
   */
  lastProviderRefreshAt?: string;
  marketplaces: MarketplaceInfo[];
}

// ---- Migration Read Types (v1 → v2) ----

/**
 * Legacy v1 plugin row, retained only as the shape produced by the v1 cache
 * file reader. Consumers must never construct or accept this type outside
 * the migration path — v2 facets cannot be recovered from v1 data without a
 * rescan.
 */
export interface PluginInfoV1 {
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  homepage: string;
  sourcePath: string;
  marketplaceId: string;
  details: PluginDetails | null;
  externalSource: { url?: string; sha?: string } | null;
  cachePath: string | null;
  cachedAt: string | null;
}

/** Legacy v1 marketplace row — produced only by the v1 cache reader. */
export interface MarketplaceInfoV1 {
  id: string;
  name: string;
  description: string;
  sourceType: string;
  sourceUrl: string;
  installLocation: string;
  lastUpdated: string;
  pluginCount: number;
  plugins: PluginInfoV1[];
}

/**
 * Legacy v1 cache file shape. The migration reader uses this to extract
 * carry-forward identifiers (`sourceType`, `sourceUrl`, `installLocation`)
 * and then triggers a full refresh before any v2 cache is written.
 */
export interface PluginsCacheV1 {
  version: 1;
  lastRefreshed: string;
  marketplaces: MarketplaceInfoV1[];
}

/** Union returned by the cache reader before migration resolves the shape. */
export type AnyPluginsCache = PluginsCache | PluginsCacheV1;

// ---- IPC Result Shapes ----

/**
 * Result of `plugins:addMarketplace`.
 *
 * The contract guarantees the IPC layer only returns this on the success
 * branch when `marketplace.validProviders.length > 0`. When both providers
 * fail, the handler must return an `IPCResult` error with the Phase T4
 * structured message — never a success carrying an empty `validProviders`.
 */
export interface MarketplaceRegistrationResult {
  marketplace: MarketplaceInfo;
  providerOutcomes: {
    claude: MarketplaceProviderStatus;
    codex: MarketplaceProviderStatus;
  };
  warnings?: string[];
}

/**
 * Result of `plugins:removeMarketplace`.
 *
 * Semantics (guaranteed to the renderer):
 * - `options.providers` defaults to `['claude', 'codex']` (full removal).
 * - When `options.providers` selects a single provider, the marketplace row
 *   is preserved if the other provider remains valid; `marketplace` in the
 *   result is the updated row.
 * - When all providers are removed (either explicitly or because the only
 *   remaining valid provider was selected and removed), the marketplace row
 *   is deleted from the cache and `marketplace` is `null`.
 * - `alreadyAbsent: true` is success (idempotent removal). `error` is
 *   populated when the provider rejected the removal call; in that case the
 *   marketplace row is left intact for retry.
 * - Persisted plugin selection refs targeting a fully removed marketplace are
 *   pruned later by a best-effort background cleanup; removal IPC must not
 *   wait for that cleanup.
 */
export interface MarketplaceRemovalResult {
  /** Marketplace state after removal, or null if the row is gone. */
  marketplace: MarketplaceInfo | null;
  removedProviders: PluginProvider[];
  providerOutcomes: {
    claude: { removed: boolean; alreadyAbsent: boolean; error?: string };
    codex: { removed: boolean; alreadyAbsent: boolean; error?: string };
  };
}

/** Options accepted by `removeMarketplace`. */
export interface RemoveMarketplaceOptions {
  /**
   * Providers to remove. Defaults to `['claude', 'codex']` (full removal) when
   * omitted by the renderer or by the handler.
   */
  providers?: PluginProvider[];
}

export type MarketplaceOperationKind =
  | 'load'
  | 'refresh'
  | 'add'
  | 'update'
  | 'remove'
  | 'install-built-in-plugin';

/**
 * Request to install a locally managed (built-in or curated) plugin for one
 * or both providers.
 *
 * `marketplaceId` must be a locally managed marketplace id — the built-in
 * marketplace id (`BUILTIN_PLUGIN_MARKETPLACE_ID`) or the curated
 * marketplace id (`CURATED_PLUGIN_MARKETPLACE_ID`); other ids are
 * rejected by the main-process handler.
 */
export interface InstallBuiltInPluginRequest {
  /** Must be `builtin/app` or `curated/cloud`. */
  marketplaceId: string;
  pluginName: string;
  /** One or both providers to install for. */
  providers: PluginProvider[];
}

/**
 * Result of `plugins:install-built-in-plugin`. Carries the refreshed plugin
 * row plus a per-provider outcome summary for the requested providers.
 */
export interface InstallBuiltInPluginResult {
  plugin: PluginInfo;
  providerOutcomes: {
    claude?: { installed: boolean; error?: string };
    codex?: { installed: boolean; error?: string };
  };
}

export type MarketplaceOperationStatus = 'running' | 'complete' | 'error';

export interface MarketplaceOperationProgress {
  operation: MarketplaceOperationKind;
  status: MarketplaceOperationStatus;
  message: string;
  currentStep?: number;
  totalSteps?: number;
  marketplaceId?: string;
  repo?: string;
}

// ---- API Interface (used by preload) ----

export interface PluginsAPI {
  analyzeSharedReference(
    request: AnalyzeSharedPluginReferenceRequest,
  ): Promise<IPCResult<PipelinePackageAnalysisSummary>>;
  resolvePortableRefs(
    request: ResolvePortablePluginRefsRequest,
  ): Promise<IPCResult<ResolvePortablePluginRefsResponse>>;
  resolvePortableEnableRef(
    request: ResolvePortableEnableRefRequest,
  ): Promise<IPCResult<ShareablePluginRef | null>>;
  loadMarketplaces(): Promise<IPCResult<PluginsCache>>;
  /**
   * Reads only what is already cached. Never triggers a marketplace refresh,
   * so it cannot spawn provider `marketplace update` commands; an absent cache
   * simply yields no marketplaces.
   */
  loadMarketplacesCacheOnly(): Promise<IPCResult<PluginsCache>>;
  /**
   * `providerUpdates` defaults to `'if-stale'`, which honours the 24h
   * provider-refresh TTL. Pass `'always'` ONLY from a deliberate user gesture
   * (the Refresh button, the invalid-marketplace Retry). Incidental callers -
   * window focus, mount effects - must leave it unset, or they turn the TTL
   * into a no-op and reintroduce unprompted marketplace clones.
   */
  refreshMarketplaces(
    providerUpdates?: 'always' | 'if-stale',
  ): Promise<IPCResult<PluginsCache>>;
  addMarketplace(
    repo: string,
  ): Promise<IPCResult<MarketplaceRegistrationResult>>;
  updateMarketplace(id: string): Promise<IPCResult<MarketplaceInfo>>;
  removeMarketplace(
    id: string,
    options?: RemoveMarketplaceOptions,
  ): Promise<IPCResult<MarketplaceRemovalResult>>;
  readComponentContent(
    installLocation: string,
    pluginSourcePath: string,
    componentFile: string,
  ): Promise<IPCResult<PluginComponentContent>>;
  installPlugin(
    marketplaceId: string,
    pluginName: string,
    sourceUrl: string,
  ): Promise<IPCResult<PluginInfo>>;
  prepareCodexCompatibilityPlugin(
    marketplaceId: string,
    pluginName: string,
  ): Promise<IPCResult<PluginInfo>>;
  setCodexCompatDisabled(
    marketplaceId: string,
    pluginName: string,
    disabled: boolean,
  ): Promise<IPCResult<PluginInfo>>;
  installBuiltInPlugin(
    request: InstallBuiltInPluginRequest,
  ): Promise<IPCResult<InstallBuiltInPluginResult>>;
  listShared(
    request: ListSharedPluginsRequest,
  ): Promise<IPCResult<ListSharedPluginsResponse>>;
  getShared(
    request: SharedPluginGetRequest,
  ): Promise<IPCResult<SharedPluginDetail>>;
  createShared(
    request: SharedPluginCreateRequest,
  ): Promise<IPCResult<SharedPluginDetail>>;
  updateShared(
    request: SharedPluginUpdateRequest,
  ): Promise<IPCResult<SharedPluginDetail>>;
  deleteShared(request: SharedPluginDeleteRequest): Promise<IPCResult>;
  publishPublicShare(
    remoteId: string,
  ): Promise<IPCResult<SharedPluginPublicShareInfo>>;
  revokePublicShare(remoteId: string): Promise<IPCResult>;
  onMarketplaceOperationProgress(
    callback: (progress: MarketplaceOperationProgress) => void,
  ): () => void;
}

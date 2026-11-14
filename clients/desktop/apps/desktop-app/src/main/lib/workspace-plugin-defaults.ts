import { z } from 'zod';
import {
  InstalledItemRefSchema,
  type InstalledItemRef,
} from '@canopy/protocol/installed-items';
import { pruneInstalledItemRefs } from '../installed-items/installed-item-ref-prune';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { detachedWorkCallback } from '@canopy/desktop-shared/node/lib/detached-work';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';
import type {
  ChatTabPluginSelections,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type { McpServerRef } from '@canopy/execution-engine/types/mcp-servers';
import {
  rewriteMcpSelections,
  rewriteMcpTombstones,
  type McpServerRefMatcher,
} from '../mcp/server-ref-matching';
import {
  inheritedPluginLayersOf,
  pruneMarketplacePluginRefsFromValue,
} from '../plugins/marketplace-plugin-ref-prune';
import { getProjectPluginDefaultsRevision } from '../plugins/plugin-defaults-revision';
import {
  INLINE_PROJECT_PLUGIN_DEFAULTS_RECONCILE_BOUND,
  projectPluginDefaultsWritten,
  projectPluginLayerChanged,
  projectPluginLayerSettled,
  projectPluginLayerUnsettled,
  reconcileProjectPluginDefaults,
  type ProjectPluginDefaultsReconcileBound,
} from '../plugins/project-plugin-defaults-cache';
import { logMainProcessWarn } from './main-process-logging';
import { w5RecordReadPaths } from './paths';
import { validateId } from './validation';
import {
  checkW5ExpectedRevision,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
  withW5Commit,
} from './w5-commit-log-file-store';
import {
  afterW5Commit,
  currentW5CommitScope,
  outsideW5CommitScope,
  w5CommitsSettling,
} from './w5-commit-scope';
import { runW5DecisionOnlyUnit } from './w5-pre-effect-retry';
import {
  createW5SingleDecisionOperation,
  wireW5Decode,
  type W5WireDecisionCall,
} from './w5-single-decision-operation';
import { WORKSPACE_MANIFEST_STORAGE } from './w5-storage';
import { WorkspaceConfigUnreadableError } from './workspace-manifest-repository';
import {
  getWorkspaceManifestRepository,
  readWorkspaceConfigDetailed,
  updateWorkspaceConfig,
  type WorkspaceConfigUpdateRead,
} from './workspace-persistence';

/**
 * The caller of a plugins update. The two settings dialogs record workspace
 * CRUD telemetry; the sweeps that follow a server move or a marketplace
 * removal do not.
 */
export type WorkspacePluginsSource =
  /** `workspace:save-default-plugins`. */
  | 'workspace_settings'
  /** `project:save-default-plugins`. */
  | 'project_settings'
  /** `recommended-plugins:apply`. */
  | 'recommended_plugins'
  /** `mcp-servers:rewrite-refs`. */
  | 'mcp_server_move'
  /** `plugins:removeMarketplace` and `portal.marketplace.remove`. */
  | 'marketplace_removal'
  /**
   * A fork's capability package install merging its skills into the fork
   * destination's defaults, and that install's compensation (CAN-4655).
   */
  | 'shared_container_fork';

/** One recommendation the caller installed and matched in the catalog. */
export type RecommendedPluginSelection =
  | { kind: 'skill'; sourceId: string; skillName: string }
  | { kind: 'plugin'; marketplaceId: string; pluginName: string };

/**
 * The typed changes of `core.workspace.plugins.update` (CAN-3799 D7): each
 * owns `defaultPluginSelections`, `disabledGlobalPluginSelections` or
 * `recommendedPluginOptOutKeys` and is applied to the manifest read inside
 * the workspace's write queue, never to an earlier read.
 */
export type WorkspacePluginsChange =
  | { kind: 'pruneInstalledItem'; ref: InstalledItemRef }
  /** Replace this workspace's default plugin selections. */
  | { kind: 'setDefaults'; defaultPluginSelections: ChatTabPluginSelections }
  /**
   * Add recommended selections to the current defaults and edit the
   * recommendation opt-outs: `optOutKeys` are added, then `clearOptOutKeys`
   * removed.
   */
  | {
      kind: 'selectRecommended';
      selections: readonly RecommendedPluginSelection[];
      optOutKeys: readonly string[];
      clearOptOutKeys: readonly string[];
    }
  /** Point default and turned-off MCP server refs at a moved server. */
  | {
      kind: 'replaceMcpServerRefs';
      from: readonly McpServerRefMatcher[];
      to: McpServerRef;
    }
  /** Drop every plugin ref of a removed marketplace. */
  | { kind: 'pruneMarketplace'; marketplaceId: string }
  /**
   * Remove exactly these selections from the current defaults, keeping every
   * other one: undoes what a `selectRecommended` added (CAN-4655).
   */
  | {
      kind: 'removeSelections';
      selections: readonly RecommendedPluginSelection[];
    };

/** The user changes, which take an optional revision and key. */
export type WorkspacePluginsUserChange = Extract<
  WorkspacePluginsChange,
  { kind: 'setDefaults' | 'selectRecommended' }
>;

export interface WorkspacePluginsUpdateRequest {
  workspaceId: string;
  change: WorkspacePluginsChange;
  source: WorkspacePluginsSource;
}

/**
 * A user change with an optional expected workspace revision
 * (`workspace:{id}`) and key. The server move and marketplace prune take
 * neither, as before.
 */
export interface WorkspacePluginsUserChangeRequest
  extends Omit<WorkspacePluginsUpdateRequest, 'change'>, W5BoundaryOptions {
  change: WorkspacePluginsUserChange;
}

/**
 * One workspace's prune in a marketplace removal fan-out. With the fan-out's
 * request ID, its key is derived from that ID and the workspace (A25(b)), so
 * a retried fan-out replays each workspace's saved result. Inactive: no
 * production caller supplies the ID. Its reconciles are bounded (D1), but
 * enabling it is a separate change.
 */
export interface WorkspacePluginsPruneRequest extends Omit<
  WorkspacePluginsUpdateRequest,
  'change' | 'source'
> {
  change: Extract<WorkspacePluginsChange, { kind: 'pruneMarketplace' }>;
  source: 'marketplace_removal';
  fanOutRequestId?: string;
}

export interface WorkspacePluginsUpdateOutcome {
  workspaceId: string;
  /** False when the change left the manifest as it was. */
  written: boolean;
  /**
   * The default selections after the change. Absent after a marketplace
   * prune, which edits the raw manifest.
   */
  defaultPluginSelections?: ChatTabPluginSelections;
  /** The recommendation opt-outs after the change, sorted; absent likewise. */
  recommendedPluginOptOutKeys?: string[];
}

const outcomeSchema = z.object({
  workspaceId: z.string(),
  written: z.boolean(),
  defaultPluginSelections: z.unknown().optional(),
  recommendedPluginOptOutKeys: z.array(z.string()).optional(),
});

/**
 * A keyed change saves, and its replay returns, the default selections in
 * their persisted shape, so a replay never depends on the caller's payload.
 */
function decodeOutcome(outcome: unknown): WorkspacePluginsUpdateOutcome {
  const { defaultPluginSelections, ...decoded } = outcomeSchema.parse(outcome);
  return {
    ...decoded,
    ...(defaultPluginSelections === undefined
      ? {}
      : {
          defaultPluginSelections: normalizePluginSelections(
            defaultPluginSelections,
          ),
        }),
  };
}

export type WorkspacePluginsRefusal =
  | 'invalid-change'
  | 'not-found'
  | 'configuration-unavailable';

/** The plugins update was refused before anything was written. */
export class WorkspacePluginsRefusedError extends Error {
  constructor(
    readonly reason: WorkspacePluginsRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspacePluginsRefusedError';
  }
}

const SETTINGS_SOURCES: ReadonlySet<WorkspacePluginsSource> =
  new Set<WorkspacePluginsSource>(['workspace_settings', 'project_settings']);

function notFound(workspaceId: string): WorkspacePluginsRefusedError {
  return new WorkspacePluginsRefusedError(
    'not-found',
    `Project ${workspaceId} not found.`,
  );
}

function configurationUnavailable(
  refusal = new WorkspaceConfigUnreadableError(),
): WorkspacePluginsRefusedError {
  return new WorkspacePluginsRefusedError(
    'configuration-unavailable',
    refusal.message,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Default selections in their full shape, with legacy `bundleIds` folded into
 * `collectionIds`. Recommended plugin inspection reads them the same way.
 */
export function normalizeDefaultPluginSelections(
  selections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections {
  if (!selections) {
    return {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
      mcpHttpAuthPreferences: [],
    };
  }

  const seen = new Set<string>();
  const collectionIds: string[] = [];
  for (const id of [
    ...(Array.isArray(selections.collectionIds)
      ? selections.collectionIds
      : []),
    ...(Array.isArray(selections.bundleIds) ? selections.bundleIds : []),
  ]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    collectionIds.push(id);
  }

  return {
    collectionIds,
    skillRefs: Array.isArray(selections.skillRefs)
      ? selections.skillRefs.map((ref) => ({
          sourceId: ref.sourceId,
          skillName: ref.skillName,
        }))
      : [],
    pluginRefs: Array.isArray(selections.pluginRefs)
      ? selections.pluginRefs.map((ref) => ({
          marketplaceId: ref.marketplaceId,
          pluginName: ref.pluginName,
        }))
      : [],
    mcpServerRefs: Array.isArray(selections.mcpServerRefs)
      ? selections.mcpServerRefs.map((ref) => ({
          serverId: ref.serverId,
          configId: ref.configId,
        }))
      : [],
    mcpHttpAuthPreferences: Array.isArray(selections.mcpHttpAuthPreferences)
      ? selections.mcpHttpAuthPreferences.map((preference) => ({
          target: preference.target,
          handler: preference.handler,
        }))
      : [],
  };
}

function addRecommendedSelection(
  selections: ChatTabPluginSelections,
  selection: RecommendedPluginSelection,
): void {
  if (selection.kind === 'skill') {
    const exists = selections.skillRefs.some(
      (ref) =>
        ref.sourceId === selection.sourceId &&
        ref.skillName === selection.skillName,
    );
    if (!exists) {
      selections.skillRefs.push({
        sourceId: selection.sourceId,
        skillName: selection.skillName,
      });
    }
    return;
  }
  const exists = selections.pluginRefs.some(
    (ref) =>
      ref.marketplaceId === selection.marketplaceId &&
      ref.pluginName === selection.pluginName,
  );
  if (!exists) {
    selections.pluginRefs.push({
      marketplaceId: selection.marketplaceId,
      pluginName: selection.pluginName,
    });
  }
}

function sortSelections(selections: ChatTabPluginSelections): void {
  selections.collectionIds.sort();
  selections.skillRefs.sort((left, right) =>
    `${left.sourceId}/${left.skillName}`.localeCompare(
      `${right.sourceId}/${right.skillName}`,
    ),
  );
  selections.pluginRefs.sort((left, right) =>
    `${left.marketplaceId}/${left.pluginName}`.localeCompare(
      `${right.marketplaceId}/${right.pluginName}`,
    ),
  );
}

function sortedOptOutKeys(config: WorkspaceConfigFile): string[] {
  return [...(config.recommendedPluginOptOutKeys ?? [])].sort();
}

function selectRecommended(
  config: WorkspaceConfigFile,
  change: Extract<WorkspacePluginsChange, { kind: 'selectRecommended' }>,
): void {
  const selections = normalizeDefaultPluginSelections(
    config.defaultPluginSelections,
  );
  for (const selection of change.selections) {
    addRecommendedSelection(selections, selection);
  }
  sortSelections(selections);
  const optOuts = new Set(config.recommendedPluginOptOutKeys ?? []);
  for (const key of change.optOutKeys) optOuts.add(key);
  for (const key of change.clearOptOutKeys) optOuts.delete(key);
  const keys = Array.from(optOuts).sort();
  config.defaultPluginSelections = selections;
  config.recommendedPluginOptOutKeys = keys.length > 0 ? keys : undefined;
}

/** Reports whether any of the named selections was a default. */
function removeSelections(
  config: WorkspaceConfigFile,
  change: Extract<WorkspacePluginsChange, { kind: 'removeSelections' }>,
): boolean {
  if (!config.defaultPluginSelections) return false;
  const selections = normalizeDefaultPluginSelections(
    config.defaultPluginSelections,
  );
  const skills = new Set<string>();
  const plugins = new Set<string>();
  for (const selection of change.selections) {
    if (selection.kind === 'skill')
      skills.add(`${selection.sourceId}\0${selection.skillName}`);
    else plugins.add(`${selection.marketplaceId}\0${selection.pluginName}`);
  }
  const skillRefs = selections.skillRefs.filter(
    (ref) => !skills.has(`${ref.sourceId}\0${ref.skillName}`),
  );
  const pluginRefs = selections.pluginRefs.filter(
    (ref) => !plugins.has(`${ref.marketplaceId}\0${ref.pluginName}`),
  );
  if (
    skillRefs.length === selections.skillRefs.length &&
    pluginRefs.length === selections.pluginRefs.length
  )
    return false;
  config.defaultPluginSelections = { ...selections, skillRefs, pluginRefs };
  return true;
}

/** Reports whether any default or turned-off ref named the moved server. */
function replaceMcpServerRefs(
  config: WorkspaceConfigFile,
  change: Extract<WorkspacePluginsChange, { kind: 'replaceMcpServerRefs' }>,
): boolean {
  const { from, to } = change;
  const defaults = config.defaultPluginSelections
    ? rewriteMcpSelections(config.defaultPluginSelections, from, to)
    : null;
  const tombstones = config.disabledGlobalPluginSelections
    ? rewriteMcpTombstones(config.disabledGlobalPluginSelections, from, to)
    : null;
  if (defaults) config.defaultPluginSelections = defaults;
  if (tombstones) config.disabledGlobalPluginSelections = tombstones;
  return defaults !== null || tombstones !== null;
}

/**
 * Applies a config-level change to `config` in place and reports whether it
 * changed anything that must be written.
 */
function applyChange(
  config: WorkspaceConfigFile,
  change: Exclude<WorkspacePluginsChange, { kind: 'pruneMarketplace' }>,
): boolean {
  switch (change.kind) {
    case 'pruneInstalledItem':
      return pruneInstalledItemRefs(config, change.ref);
    case 'setDefaults':
      config.defaultPluginSelections = change.defaultPluginSelections;
      return true;
    case 'selectRecommended':
      selectRecommended(config, change);
      return true;
    case 'replaceMcpServerRefs':
      return replaceMcpServerRefs(config, change);
    case 'removeSelections':
      return removeSelections(config, change);
  }
}

function validateChange(change: WorkspacePluginsChange): void {
  const invalid = new WorkspacePluginsRefusedError(
    'invalid-change',
    'Invalid plugins change.',
  );
  switch (change.kind) {
    case 'pruneInstalledItem':
      InstalledItemRefSchema.parse(change.ref);
      return;
    case 'setDefaults': {
      const defaults: unknown = change.defaultPluginSelections;
      if (!isRecord(defaults)) {
        throw new WorkspacePluginsRefusedError(
          'invalid-change',
          'Default plugins must be a set of plugin selections.',
        );
      }
      return;
    }
    case 'selectRecommended':
    case 'replaceMcpServerRefs':
    case 'removeSelections':
      return;
    case 'pruneMarketplace':
      if (change.marketplaceId.length === 0) throw invalid;
      return;
    default:
      throw invalid;
  }
}

/**
 * The marketplace prune edits the raw manifest: a removed marketplace's refs
 * are dropped wherever they are saved in it, including fields this version
 * does not know, so it keeps the CAN-3800 raw-document write. Like every
 * other change it runs inside the workspace's write queue and refuses a
 * missing or unreadable manifest. Inside a keyed decision the cache refresh
 * follows the commit.
 */
async function pruneMarketplace(
  workspaceId: string,
  marketplaceId: string,
): Promise<WorkspacePluginsUpdateOutcome> {
  const manifests = getWorkspaceManifestRepository();
  return manifests.serialize(
    workspaceId,
    async (): Promise<WorkspacePluginsUpdateOutcome> => {
      const read = await manifests.read(workspaceId);
      if (read.authority === 'absent') throw notFound(workspaceId);
      if (read.authority === 'unreadable')
        throw configurationUnavailable(
          new WorkspaceConfigUnreadableError(read.error),
        );
      const document = structuredClone(read.document);
      const before = inheritedPluginLayersOf(document);
      const written = pruneMarketplacePluginRefsFromValue(
        document,
        marketplaceId,
      );
      if (written) {
        const after = inheritedPluginLayersOf(document);
        try {
          await manifests.replaceDocument(workspaceId, document, read);
        } finally {
          await afterW5Commit(() =>
            projectPluginDefaultsWritten({
              configPath: w5RecordReadPaths.manifest(workspaceId),
              workspaceId,
              layerChanged: projectPluginLayerChanged(before, after),
            }),
          );
        }
      }
      return { workspaceId, written };
    },
  );
}

/**
 * The guarded manifest read-modify-write of a config-level change. A user
 * change runs it inside its commit scope; the server move runs it alone.
 */
async function updatePluginsConfig(
  workspaceId: string,
  change: Exclude<WorkspacePluginsChange, { kind: 'pruneMarketplace' }>,
): Promise<WorkspacePluginsUpdateOutcome> {
  try {
    return await updateWorkspaceConfig(
      workspaceId,
      (
        config: WorkspaceConfigFile,
        read: WorkspaceConfigUpdateRead,
      ): WorkspacePluginsUpdateOutcome => {
        if (read.authority === 'absent') throw notFound(workspaceId);
        const written = applyChange(config, change);
        return {
          workspaceId,
          written,
          ...(config.defaultPluginSelections
            ? { defaultPluginSelections: config.defaultPluginSelections }
            : {}),
          recommendedPluginOptOutKeys: sortedOptOutKeys(config),
        };
      },
      { shouldWrite: (result): boolean => result.written },
    );
  } catch (error) {
    if (error instanceof WorkspaceConfigUnreadableError) {
      throw configurationUnavailable(error);
    }
    throw error;
  }
}

const isPluginsRefusal = (error: unknown): boolean =>
  error instanceof WorkspacePluginsRefusedError;

const runPluginsDecision =
  createW5SingleDecisionOperation<WorkspacePluginsSource>(isPluginsRefusal);

/** The runner for one call: a wire call's receipts name its principal. */
function pluginsRunner(
  wire: W5WireDecisionCall<never> | undefined,
): typeof runPluginsDecision {
  return wire
    ? createW5SingleDecisionOperation<WorkspacePluginsSource>(
        isPluginsRefusal,
        wire,
      )
    : runPluginsDecision;
}

/**
 * The fingerprinted parameters of a keyed user change: the fields it applies,
 * with the default selections in their persisted shape.
 */
function userChangeParameters(change: WorkspacePluginsUserChange): unknown {
  if (change.kind === 'setDefaults') {
    return {
      kind: change.kind,
      defaultPluginSelections: normalizePluginSelections(
        change.defaultPluginSelections,
      ),
    };
  }
  return {
    kind: change.kind,
    selections: change.selections.map((selection) =>
      selection.kind === 'skill'
        ? {
            kind: selection.kind,
            sourceId: selection.sourceId,
            skillName: selection.skillName,
          }
        : {
            kind: selection.kind,
            marketplaceId: selection.marketplaceId,
            pluginName: selection.pluginName,
          },
    ),
    optOutKeys: [...change.optOutKeys],
    clearOptOutKeys: [...change.clearOptOutKeys],
  };
}

/**
 * A replay's rule for a removed manifest: the default selections its
 * decision left, and the session revision when its refresh became owed.
 */
interface ReplayRule {
  defaultPluginSelections: ChatTabPluginSelections | undefined;
  revision: number;
}

/** A replay's reconcile; see {@link reconcilePluginDefaults}. */
interface ReplayedReconcile {
  /** Null when its own attempt owes no refresh. */
  owed: ReplayRule | null;
}

/**
 * What an inline reconcile owes: a plain read, or a replay's. Past its bound
 * the background owes it instead, until a read of the manifest decides it.
 */
interface ReconcileHandOff {
  /** A replay keeps its removed-manifest rule; absent, a plain reconcile. */
  replayed?: ReplayedReconcile;
  /** A keyed attempt's owed refresh, settled once a read decides it. */
  owedRefresh?: { receipt: string; entry: OwedRefreshEntry };
}

/**
 * Who reads: an inline caller with what it owes, or a background run with
 * the unkeyed failure it settles.
 */
type ReconcileReader =
  | { kind: 'inline'; handOff: ReconcileHandOff }
  | { kind: 'background'; settling: Settles };

/**
 * `decided`: a read of the manifest, present or removed, decided it.
 * `undecided`: an unreadable or failed read decided nothing. `exhausted`: a
 * bounded reconcile ran out before any read decided.
 */
type PluginDefaultsReconcileOutcome = 'decided' | 'undecided' | 'exhausted';

/**
 * Reconciles the cached project plugin layer with the manifest when the
 * manifest writer's post-commit refresh may have been dropped: the session
 * revision advances only if the layer differs from what was served, so a
 * replay repeats nothing. It never fails the caller: the cached entry is
 * dropped either way, except by a replay read that finds the manifest
 * removed. Its decision found the manifest, so a deletion removed it since
 * and refreshes for the removal; the replay drops and advances only for a
 * refresh its attempt may have dropped (`owed`) with no advance since.
 *
 * The read also decides every hand-off that joined before it loaded (see
 * {@link composeRead}), whether the reader is inline or a background run.
 */
async function reconcilePluginDefaults(
  workspaceId: string,
  reader: ReconcileReader,
  bound?: ProjectPluginDefaultsReconcileBound,
): Promise<PluginDefaultsReconcileOutcome> {
  let decided = false;
  let loadedAt = 0;
  try {
    const result = await reconcileProjectPluginDefaults({
      configPath: w5RecordReadPaths.manifest(workspaceId),
      workspaceId,
      bound,
      serialize: (work) =>
        getWorkspaceManifestRepository().serialize(workspaceId, work),
      committing: () =>
        w5CommitsSettling(w5RecordReadPaths.manifest(workspaceId)),
      // The read `readProjectPluginDefaults` serves.
      load: async () => {
        const read = composeRead(workspaceId, reader);
        loadedAt = read.loadedAt;
        const { config, authority } =
          await readWorkspaceConfigDetailed(workspaceId);
        decided = authority !== 'unreadable';
        if (read.replayRules && authority === 'absent')
          return { removed: true, owed: read.replayRules };
        return {
          defaults: {
            defaultPluginSelections: config.defaultPluginSelections,
            disabledGlobalPluginSelections:
              config.disabledGlobalPluginSelections,
          },
          cacheable: authority !== 'unreadable',
        };
      },
    });
    if (result === 'exhausted') return 'exhausted';
  } catch (error) {
    projectPluginDefaultsWritten({
      configPath: w5RecordReadPaths.manifest(workspaceId),
      workspaceId,
      layerChanged: false,
    });
    logMainProcessWarn('[workspace-plugins] plugin defaults reconcile failed', {
      workspaceId,
      error,
    });
    return 'undecided';
  }
  if (!decided) return 'undecided';
  settleDecided(workspaceId, reader, loadedAt);
  return 'decided';
}

let inlineReconcileBound = INLINE_PROJECT_PLUGIN_DEFAULTS_RECONCILE_BOUND;

export function __setInlinePluginDefaultsReconcileBoundForTests(
  bound: ProjectPluginDefaultsReconcileBound | undefined,
): void {
  inlineReconcileBound =
    bound ?? INLINE_PROJECT_PLUGIN_DEFAULTS_RECONCILE_BOUND;
}

/**
 * The reconcile of a caller that waits for it (CAN-4409 D1): a keyed failure
 * with its key still reserved, a replay, a Cowork settings decision or a W5e
 * commit event, each holding a response or later events. It waits within
 * {@link INLINE_PROJECT_PLUGIN_DEFAULTS_RECONCILE_BOUND}, then hands what it
 * owes to the background and marks the layer unsettled, so chat reads serve
 * the manifest and request a reconcile until a read decides. Resolves to
 * whether a read decided it inline.
 */
async function reconcilePluginDefaultsInline(
  workspaceId: string,
  handOff: ReconcileHandOff,
): Promise<boolean> {
  const outcome = await reconcilePluginDefaults(
    workspaceId,
    { kind: 'inline', handOff },
    inlineReconcileBound,
  );
  if (outcome === 'exhausted')
    reconcileHandOffInBackground(workspaceId, handOff);
  return outcome === 'decided';
}

/**
 * The same reconcile for another keyed manifest decision that may change the
 * plugin layer (`core.workspace.cowork.update`'s preset-derived defaults): a
 * failed attempt (`replayed: false`) or a replay. Its outcome carries no
 * selections, so a replay that finds the manifest removed leaves the
 * removal to its remover. Resolves to whether a read decided it within the
 * inline bound; past it, the background decides.
 */
export function reconcileManifestPluginDefaults(
  workspaceId: string,
  replayed: boolean,
): Promise<boolean> {
  return reconcilePluginDefaultsInline(
    workspaceId,
    replayed ? { replayed: { owed: null } } : {},
  );
}

/**
 * A failed removal may already have applied. Bypass the cached layer until an
 * authoritative manifest read reconciles it, including an absent manifest.
 * Unreadable storage leaves the hand-off owed for later reads to retry.
 */
export function reconcileWorkspaceRemovalPluginDefaults(
  workspaceId: string,
): void {
  reconcileHandOffInBackground(workspaceId, {});
}

/**
 * Receipts of keyed attempts of this process that failed after staging and
 * whose reconcile decided nothing, so the refresh of a decision that landed
 * may still be owed, with the project revision at the failure. The cached
 * layer and revision it protects are process-local too. Each entry is its
 * own object, so a late settle never clears a newer failure's entry.
 */
interface OwedRefreshEntry {
  since: number;
}
const refreshPossiblyOwed = new Map<string, OwedRefreshEntry>();

/** Clears `entry` unless a newer failure of the key replaced it. */
function settleOwedRefresh(
  receipt: string,
  entry: OwedRefreshEntry | undefined,
): void {
  if (refreshPossiblyOwed.get(receipt) === entry)
    refreshPossiblyOwed.delete(receipt);
}

/**
 * One keyed or revision-checked change: one decision over the manifest, its
 * optional workspace revision and its optional receipt, staged by `stage`.
 */
async function runKeyedPluginsChange(input: {
  workspaceId: string;
  source: WorkspacePluginsSource;
  idempotencyKey: string | undefined;
  expectedRevision: number | undefined;
  /** The fingerprinted parameters, without the key or revision. */
  parameters: () => unknown;
  stage: () => Promise<WorkspacePluginsUpdateOutcome>;
  /** The registered operation's wire call (W7b-1c). */
  wire?: W5WireDecisionCall<WorkspacePluginsUpdateOutcome>;
}): Promise<WorkspacePluginsUpdateOutcome> {
  const { workspaceId, expectedRevision, idempotencyKey, wire } = input;
  const resource: W5Resource = { kind: 'workspace', workspaceId };
  // A wire call's receipt is its principal's, apart from the host's.
  const receipt =
    idempotencyKey === undefined
      ? undefined
      : JSON.stringify([
          workspaceId,
          input.source,
          idempotencyKey,
          ...(wire ? [wire.principalId] : []),
        ]);
  let executed = false;
  const outcome = await pluginsRunner(wire)(
    {
      operation: 'core.workspace.plugins.update',
      source: input.source,
      idempotencyKey,
      parameters: input.parameters,
      storage: [WORKSPACE_MANIFEST_STORAGE],
    },
    // A missing or unreadable manifest is refused in the write queue.
    () => Promise.resolve(),
    wireW5Decode(decodeOutcome, wire),
    async (_admitted, options, save) => {
      executed = true;
      // A key that runs again never landed a decision before.
      if (receipt !== undefined) refreshPossiblyOwed.delete(receipt);
      let staged = false;
      async function stageWorkspacePlugins(): Promise<WorkspacePluginsUpdateOutcome> {
        await checkW5ExpectedRevision(resource, expectedRevision);
        const result = save(await input.stage());
        staged = true;
        return result;
      }
      try {
        return await withW5Commit(
          {
            ...options,
            locks: [
              {
                kind: 'manifest',
                path: w5RecordReadPaths.manifest(workspaceId),
              },
            ],
            expectedRevisions: w5ExpectedRevision(resource, expectedRevision),
          },
          stageWorkspacePlugins,
        );
      } catch (error) {
        // A failure after staging other than a refused decision may follow a
        // landed write whose post-commit refresh was dropped with the scope.
        if (
          staged &&
          !(error instanceof W5RevisionConflictError) &&
          !(error instanceof W5FileWriteRefusedError)
        ) {
          // Reads recover the commit log first, so a read that decided
          // followed any landing of this decision. Owed until one decides;
          // the key stays reserved meanwhile, so no replay reads the entry.
          const owed: OwedRefreshEntry = {
            since: getProjectPluginDefaultsRevision(workspaceId),
          };
          if (receipt !== undefined) refreshPossiblyOwed.set(receipt, owed);
          if (
            (await reconcilePluginDefaultsInline(workspaceId, {
              owedRefresh:
                receipt === undefined ? undefined : { receipt, entry: owed },
            })) &&
            receipt !== undefined
          )
            settleOwedRefresh(receipt, owed);
        }
        throw error;
      }
    },
  );
  if (executed || receipt === undefined) return outcome;
  // A replay runs no writer, and its decision may have landed without the
  // refresh (a lost response), possibly after a read cached the old layer.
  const owed = refreshPossiblyOwed.get(receipt);
  if (
    await reconcilePluginDefaultsInline(workspaceId, {
      replayed: {
        owed:
          owed === undefined
            ? null
            : {
                defaultPluginSelections: outcome.defaultPluginSelections,
                revision: owed.since,
              },
      },
      owedRefresh: owed && { receipt, entry: owed },
    })
  )
    settleOwedRefresh(receipt, owed);
  return outcome;
}

/**
 * A default selections or recommendation change. Chat normalization runs in
 * the manifest writer before the decision.
 */
async function updateUserChange(
  request: WorkspacePluginsUserChangeRequest,
  wire: W5WireDecisionCall<WorkspacePluginsUpdateOutcome> | undefined,
): Promise<WorkspacePluginsUpdateOutcome> {
  const { workspaceId, change, expectedRevision, idempotencyKey } = request;
  // Nothing to decide with the write: the plain manifest write, as before.
  if (idempotencyKey === undefined && expectedRevision === undefined)
    return updatePluginsConfig(workspaceId, change);
  return runKeyedPluginsChange({
    workspaceId,
    source: request.source,
    idempotencyKey,
    expectedRevision,
    parameters: () => ({ workspaceId, change: userChangeParameters(change) }),
    stage: () => updatePluginsConfig(workspaceId, change),
    ...(wire && { wire }),
  });
}

/**
 * Workspaces with an unkeyed change of this process that failed after it may
 * have written (a lost response), each with the sequence of its latest such
 * failure. No receipt replays an unkeyed change, and its decision may apply
 * after the failure's own reconcile or while that reconcile cannot read the
 * manifest. Until the next change of the workspace that succeeds reconciles
 * again, chat reads skip the cached layer and request a reconcile when they
 * find a layer other than the one served. Process-local, like the cached
 * layer and revision.
 */
const unkeyedOutcomeUnknown = new Map<string, number>();
let unkeyedFailures = 0;

/**
 * A failure sequence the reconcile settles once it decides, if it is still
 * the workspace's latest; null settles none.
 */
type Settles = number | null;

function laterSettles(a: Settles, b: Settles): Settles {
  return a === null ? b : b === null ? a : Math.max(a, b);
}

/**
 * Each workspace's background reconcile, with what a rerun requested while
 * it runs settles. Requests while it runs coalesce into one rerun after it.
 */
const backgroundReconciles = new Map<string, { rerun?: Settles }>();

/** A keyed hand-off's owed refresh and its replay's rule, until a read decides it. */
interface OwedReconcileRow {
  entry: OwedRefreshEntry;
  joined: number;
  rule?: ReplayRule;
}

/**
 * What hand-offs of one workspace still owe, until a read decides them: the
 * latest plain and replay joins, and each receipt's latest keyed join. One
 * record per workspace, with no key: whatever joined before a deciding read
 * loaded is decided by it (see {@link composeRead}).
 */
interface OwedReconciles {
  plain?: number;
  replay?: number;
  rows: Map<string, OwedReconcileRow>;
}

const owedReconciles = new Map<string, OwedReconciles>();

/** Hand-offs of this process so far: each join's sequence. */
let reconcileJoins = 0;

export function __pluginDefaultsHandOffsForTests(workspaceId: string): number {
  return owedReconciles.has(workspaceId) ? 1 : 0;
}

/**
 * The read a reconcile makes, chosen as it loads: a plain read if its reader
 * owes one, or a plain hand-off or (in a background run) an unkeyed failure
 * is owed; otherwise a replay's, with its own rule and each owed receipt's.
 *
 * One read covers every hand-off that joined before it loaded. At one
 * revision a plain read advances whenever any replay rule would: a removed
 * manifest reads as the empty layer, which advances for any non-empty or
 * mixed layer served, a superset of each rule's condition. Its first advance
 * disarms every rule owed at the earlier revision. So nothing keys the
 * record: reordered selections, an omitted or empty field, or a revision
 * passed since cannot split it.
 */
function composeRead(
  workspaceId: string,
  reader: ReconcileReader,
): { loadedAt: number; replayRules: ReplayRule[] | null } {
  const owed = owedReconciles.get(workspaceId);
  const loadedAt = reconcileJoins;
  const plain =
    owed?.plain !== undefined ||
    (reader.kind === 'inline'
      ? !reader.handOff.replayed
      : reader.settling !== null || unkeyedOutcomeUnknown.has(workspaceId));
  if (plain) return { loadedAt, replayRules: null };
  const replayRules: ReplayRule[] = [];
  const own = reader.kind === 'inline' && reader.handOff.replayed?.owed;
  if (own) replayRules.push(own);
  // A settled or replaced entry owes nothing, nor does its rule.
  for (const [receipt, row] of owed?.rows ?? [])
    if (row.rule && refreshPossiblyOwed.get(receipt) === row.entry)
      replayRules.push(row.rule);
  return { loadedAt, replayRules };
}

/**
 * After a read that decided: settles the hand-offs that joined before it
 * loaded and, in a background run, the unkeyed failure it settles if still
 * the latest. With neither left, the layer settles.
 */
function settleDecided(
  workspaceId: string,
  reader: ReconcileReader,
  loadedAt: number,
): void {
  const owed = owedReconciles.get(workspaceId);
  if (owed) {
    if (owed.plain !== undefined && owed.plain <= loadedAt) delete owed.plain;
    if (owed.replay !== undefined && owed.replay <= loadedAt)
      delete owed.replay;
    for (const [receipt, row] of owed.rows) {
      if (row.joined > loadedAt) continue;
      settleOwedRefresh(receipt, row.entry);
      owed.rows.delete(receipt);
    }
    if (
      owed.plain === undefined &&
      owed.replay === undefined &&
      owed.rows.size === 0
    )
      owedReconciles.delete(workspaceId);
  }
  if (
    reader.kind === 'background' &&
    reader.settling !== null &&
    unkeyedOutcomeUnknown.get(workspaceId) === reader.settling
  )
    unkeyedOutcomeUnknown.delete(workspaceId);
  if (
    !owedReconciles.has(workspaceId) &&
    !unkeyedOutcomeUnknown.has(workspaceId)
  )
    projectPluginLayerSettled(w5RecordReadPaths.manifest(workspaceId));
}

/**
 * Chat reads skip the cached layer and request a background reconcile; one
 * that reads the manifest also retries the hand-offs still owed.
 */
function markLayerUnsettled(workspaceId: string): void {
  projectPluginLayerUnsettled(
    w5RecordReadPaths.manifest(workspaceId),
    () => reconcileInBackground(workspaceId, null),
    () => retryHandOffs(workspaceId),
  );
}

/**
 * Hand-offs a read left owed (an unreadable manifest, a failed read or run)
 * get no run of their own. A read that finds the manifest readable starts
 * one, so neither they nor the unsettled mark outlive the fault.
 */
function retryHandOffs(workspaceId: string): void {
  if (owedReconciles.has(workspaceId)) reconcileInBackground(workspaceId, null);
}

function reconcileHandOffInBackground(
  workspaceId: string,
  handOff: ReconcileHandOff,
): void {
  reconcileJoins += 1;
  const joined = reconcileJoins;
  const owed: OwedReconciles = owedReconciles.get(workspaceId) ?? {
    rows: new Map<string, OwedReconcileRow>(),
  };
  owedReconciles.set(workspaceId, owed);
  if (handOff.replayed) owed.replay = joined;
  else owed.plain = joined;
  // Settling any entry but the receipt's current one changes nothing.
  for (const [receipt, row] of owed.rows)
    if (refreshPossiblyOwed.get(receipt) !== row.entry)
      owed.rows.delete(receipt);
  const { owedRefresh } = handOff;
  if (
    owedRefresh &&
    refreshPossiblyOwed.get(owedRefresh.receipt) === owedRefresh.entry
  )
    owed.rows.set(owedRefresh.receipt, {
      entry: owedRefresh.entry,
      joined,
      rule: handOff.replayed?.owed ?? undefined,
    });
  markLayerUnsettled(workspaceId);
  reconcileInBackground(workspaceId, null);
}

/**
 * One background run: one read when anything is owed (a request made after
 * everything settled owes none), chosen as it loads, so a run owed only
 * replays makes no plain read, which would advance for a removal.
 */
async function reconcileOwed(
  workspaceId: string,
  settling: Settles,
): Promise<void> {
  if (
    settling === null &&
    !unkeyedOutcomeUnknown.has(workspaceId) &&
    !owedReconciles.has(workspaceId)
  )
    return;
  await reconcilePluginDefaults(workspaceId, { kind: 'background', settling });
}

/**
 * Starts the reconcile off the caller's path: it waits for other commits of
 * the manifest to finish their post-commit work, which has no time limit and
 * may be the caller's own. Each run also reconciles the pending hand-offs.
 */
function reconcileInBackground(workspaceId: string, settles: Settles): void {
  const running = backgroundReconciles.get(workspaceId);
  if (running) {
    running.rerun =
      running.rerun === undefined
        ? settles
        : laterSettles(running.rerun, settles);
    return;
  }
  const state: { rerun?: Settles } = {};
  backgroundReconciles.set(workspaceId, state);
  detachedWorkCallback(() =>
    outsideW5CommitScope(async (): Promise<void> => {
      let next: Settles | undefined = settles;
      try {
        while (next !== undefined) {
          const settling = next;
          delete state.rerun;
          await reconcileOwed(workspaceId, settling);
          next = state.rerun;
        }
      } catch (error) {
        // The mark stays set, so a later request reconciles again.
        logMainProcessWarn(
          '[workspace-plugins] background plugin defaults reconcile failed',
          { workspaceId, error },
        );
      } finally {
        backgroundReconciles.delete(workspaceId);
      }
    }),
  )();
}

/** Refusals that prove the change wrote nothing. */
function refusedBeforeWriting(error: unknown): boolean {
  return (
    error instanceof WorkspacePluginsRefusedError ||
    error instanceof W5FileWriteRefusedError ||
    error instanceof W5RevisionConflictError
  );
}

/**
 * Runs one change, reconciling the cached plugin layer in the background
 * after an unkeyed failure that may have written (CAN-4417) and after the
 * next change that follows it. Inside another commit scope its owner settles
 * the outcome.
 */
async function withUnkeyedOutcomeReconcile(
  workspaceId: string,
  unkeyed: boolean,
  run: () => Promise<WorkspacePluginsUpdateOutcome>,
): Promise<WorkspacePluginsUpdateOutcome> {
  if (currentW5CommitScope()) return run();
  const owed = unkeyedOutcomeUnknown.get(workspaceId);
  // A hand-off whose background read could not decide (an unreadable
  // manifest) is retried by the next change, like an unkeyed failure.
  const handedOff = owedReconciles.has(workspaceId);
  let outcome: WorkspacePluginsUpdateOutcome;
  try {
    outcome = await run();
  } catch (error) {
    // Its post-commit refresh may have run before the decision applied.
    if (unkeyed && !refusedBeforeWriting(error)) {
      unkeyedFailures += 1;
      unkeyedOutcomeUnknown.set(workspaceId, unkeyedFailures);
      markLayerUnsettled(workspaceId);
      reconcileInBackground(workspaceId, null);
    }
    throw error;
  }
  // Its manifest read recovered the commit log first, after the earlier
  // decision applied or was lost.
  if (owed !== undefined || handedOff)
    reconcileInBackground(workspaceId, owed ?? null);
  return outcome;
}

/**
 * The keyed marketplace prune of one workspace: its key is derived from the
 * fan-out request ID and the workspace (A25(b)); there is no expected
 * revision.
 */
async function updatePruneMarketplace(
  workspaceId: string,
  marketplaceId: string,
  fanOutRequestId: string,
): Promise<WorkspacePluginsUpdateOutcome> {
  return runKeyedPluginsChange({
    workspaceId,
    source: 'marketplace_removal',
    idempotencyKey: JSON.stringify([fanOutRequestId, workspaceId]),
    expectedRevision: undefined,
    parameters: () => ({
      workspaceId,
      change: { kind: 'pruneMarketplace', marketplaceId },
    }),
    stage: () => pruneMarketplace(workspaceId, marketplaceId),
  });
}

/**
 * The typed in-process `core.workspace.plugins.update` boundary (CAN-3817):
 * every change of one workspace's default plugin selections, turned-off
 * global selections and recommendation opt-outs, from the settings dialogs
 * (`workspace:save-default-plugins`, `project:save-default-plugins`),
 * recommended plugin selection (`recommended-plugins:apply`), the MCP server
 * move (`mcp-servers:rewrite-refs`), marketplace removal, and a fork's
 * capability install adding its skills (`selectRecommended`) and its
 * compensation removing them again (`removeSelections`).
 *
 * The change is applied to the manifest read inside the workspace's write
 * queue, so a repository, ownership or other settings change committed in the
 * meantime is never erased, and every other field, known or not, is kept. A
 * missing manifest is refused rather than created, and an unreadable one is
 * left as it is. A change of the default selections still runs the one-time
 * chat normalization first and refreshes the cached project plugin layer
 * after the commit (the manifest writer does both).
 *
 * `setDefaults` and `selectRecommended` check an optional workspace revision
 * and key in the same commit (CAN-4409); without either they keep the plain
 * manifest write. Normalization precedes that decision, so a refusal after
 * it releases the key and the retry normalizes again, which leaves already
 * normalized chats alone; a normalization failure leaves a keyed attempt
 * recovery-required. A marketplace prune given its fan-out's request ID is
 * keyed per workspace (CAN-4717); the server move, unkeyed prune and selection
 * removal stay on their own paths. An unkeyed change that fails after it may
 * have written reconciles the cached plugin layer in the background, as does
 * the next change of that workspace that succeeds (CAN-4417); the writes are
 * unchanged. A keyed failure or replay reconciles inline within a bound,
 * then hands the rest to the background (CAN-4409 D1). The renderer's
 * settings and recommendation channels project the registered operation for
 * their user changes, and `wire` is its wire call (W7b-1c); every other
 * caller omits it.
 */
export async function updateWorkspacePlugins(
  request: WorkspacePluginsUserChangeRequest,
  wire?: W5WireDecisionCall<WorkspacePluginsUpdateOutcome>,
): Promise<WorkspacePluginsUpdateOutcome>;
export async function updateWorkspacePlugins(
  request: WorkspacePluginsPruneRequest,
): Promise<WorkspacePluginsUpdateOutcome>;
export async function updateWorkspacePlugins(
  request: WorkspacePluginsUpdateRequest,
): Promise<WorkspacePluginsUpdateOutcome>;
export async function updateWorkspacePlugins(
  request: WorkspacePluginsUpdateRequest &
    W5BoundaryOptions & { fanOutRequestId?: unknown },
  wire?: W5WireDecisionCall<WorkspacePluginsUpdateOutcome>,
): Promise<WorkspacePluginsUpdateOutcome> {
  const { workspaceId, change, source } = request;
  validateId(workspaceId, 'workspaceId');
  validateChange(change);

  let run: () => Promise<WorkspacePluginsUpdateOutcome>;
  let unkeyed = true;
  // Only the prune reads a fan-out request ID; it and the server move never
  // read a key or revision.
  if (change.kind === 'pruneMarketplace') {
    const { fanOutRequestId } = request;
    if (fanOutRequestId === undefined) {
      run = (): Promise<WorkspacePluginsUpdateOutcome> =>
        pruneMarketplace(workspaceId, change.marketplaceId);
    } else {
      // Only marketplace removal keys a prune, which fixes its receipt caller.
      if (
        typeof fanOutRequestId !== 'string' ||
        fanOutRequestId.length === 0 ||
        source !== 'marketplace_removal'
      )
        throw new WorkspacePluginsRefusedError(
          'invalid-change',
          'Invalid plugins change.',
        );
      unkeyed = false;
      run = (): Promise<WorkspacePluginsUpdateOutcome> =>
        updatePruneMarketplace(
          workspaceId,
          change.marketplaceId,
          fanOutRequestId,
        );
    }
  } else if (
    change.kind === 'replaceMcpServerRefs' ||
    change.kind === 'pruneInstalledItem' ||
    change.kind === 'removeSelections'
  ) {
    run = (): Promise<WorkspacePluginsUpdateOutcome> =>
      updatePluginsConfig(workspaceId, change);
  } else {
    unkeyed =
      request.idempotencyKey === undefined &&
      request.expectedRevision === undefined;
    // Keyed or not, a refused decision wrote nothing, so it marks no
    // unsettled state and normalizes again on the next attempt.
    run = (): Promise<WorkspacePluginsUpdateOutcome> =>
      runW5DecisionOnlyUnit('core.workspace.plugins.update', () =>
        updateUserChange({ ...request, change }, wire),
      );
  }
  const outcome = await withUnkeyedOutcomeReconcile(workspaceId, unkeyed, run);

  if (SETTINGS_SOURCES.has(source)) {
    // Loaded on use: the marketplace prune runs this module inside the
    // plugin service, which need not load the telemetry graph.
    const { recordWorkspaceCrudTelemetry } =
      await import('./desktop-telemetry');
    recordWorkspaceCrudTelemetry({
      action: 'update',
      workspaceId,
      source: 'default_plugins',
    });
  }
  return outcome;
}

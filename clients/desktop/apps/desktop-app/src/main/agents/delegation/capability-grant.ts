import {
  selectHomeCapabilityOverlay,
  mergeHomeCapabilityOverlay,
} from './home-overlay';
import type {
  AgentDelegationSpawnRequest,
  DelegationCapabilityChoice,
  DelegationCapabilityKind,
} from '@canopy/protocol/delegation';
import type {
  ChatTabPluginSelections,
  ModelHarness,
} from '@canopy/desktop-shared/types';
import type {
  CapabilityItemRef,
  CapabilityOverlayInput,
  MaterializedCapabilityOverlay,
  RetainedHomeCapability,
} from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import {
  DELEGATION_CAPABILITY_GRANT_LIMITS,
  EMPTY_CAPABILITY_OVERLAY_HASH,
  delegationCapabilityDisplayName,
  resolveDelegationCapabilityDiscovery,
  summarizeDelegationCapabilities,
  type DelegationCapabilityGrant,
} from '@canopy/desktop-shared/node/delegation/capability-grant';
import type { DelegationCapabilityDiscovery } from '@canopy/desktop-shared/node/delegation/projections';
import { resolveEffectivePluginSelectionRefs } from '../../plugins/plugin-resolver';
import { resolveEffectiveChatPluginSelections } from '../../plugins/global-plugin-overlay';
import type { AgentSessionOptions } from '../types';
import type {
  DelegationCapabilityLayer,
  DelegationCapabilityItemResult,
  MaterializedDelegationCapabilities,
  SkippedDelegationCapabilityItem,
} from './agent-projection';
import {
  DelegationAgentCapabilityError,
  delegationCapabilitySkipReason,
} from './agent-capability-error';
import {
  delegationCapabilityRefKey,
  type DelegationCapabilityCatalog,
  type DelegationCapabilityCatalogItem,
} from './capability-catalog';

/** Spawn failures that name an assigned item. Public copy only: never a path or ID. */
export class DelegationCapabilityAssignmentError extends Error {
  readonly publicMessage: string;

  constructor(message: string) {
    super(message);
    this.name = 'DelegationCapabilityAssignmentError';
    this.publicMessage = message;
  }
}

export function delegationCapabilityAssignmentError(
  value: unknown,
): DelegationCapabilityAssignmentError | undefined {
  return value instanceof DelegationCapabilityAssignmentError
    ? value
    : undefined;
}

/** The calling parent's effective capability set. */
export interface DelegationCallerCapabilities {
  /** 0 for a root chat; otherwise the caller is a delegate. */
  readonly depth: number;
  /** Selections a child inherits. Collections expand at materialization. */
  readonly selections: ChatTabPluginSelections;
  /** `delegationCapabilityRefKey` of every item in the caller's effective set. */
  readonly effectiveKeys: ReadonlySet<string>;
  /** Whether installed catalog items outside the effective set are grantable. */
  readonly mayDiscover: boolean;
  /** Root chat's live deferred-tools setting. */
  readonly rootDeferredToolsAllowed: boolean;
  /** The direct parent delegate's grant (nested callers only). */
  readonly parentGrant?: DelegationCapabilityGrant;
  /** The direct parent's frozen home content, never an ambient lookup. */
  readonly inheritedOverlay?: MaterializedCapabilityOverlay;
}

const EMPTY_SELECTIONS: ChatTabPluginSelections = Object.freeze({
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
});

function hasSelections(selections: ChatTabPluginSelections): boolean {
  return (
    selections.collectionIds.length > 0 ||
    selections.skillRefs.length > 0 ||
    selections.pluginRefs.length > 0 ||
    (selections.mcpServerRefs?.length ?? 0) > 0
  );
}

/** Selections naming exactly these refs (no Collections). */
export function selectionsFromRefs(
  refs: readonly CapabilityItemRef[],
  base?: Pick<ChatTabPluginSelections, 'mcpHttpAuthPreferences'>,
): ChatTabPluginSelections {
  const selections: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    ...(base?.mcpHttpAuthPreferences?.length
      ? { mcpHttpAuthPreferences: [...base.mcpHttpAuthPreferences] }
      : {}),
  };
  for (const ref of refs) {
    if (ref.kind === 'skill')
      selections.skillRefs.push({
        sourceId: ref.sourceId,
        skillName: ref.skillName,
      });
    else if (ref.kind === 'plugin')
      selections.pluginRefs.push({
        marketplaceId: ref.marketplaceId,
        pluginName: ref.pluginName,
      });
    else
      selections.mcpServerRefs?.push({
        serverId: ref.serverId,
        configId: ref.configId,
      });
  }
  return selections;
}

async function effectiveKeysForSelections(
  selections: ChatTabPluginSelections,
): Promise<Set<string>> {
  if (!hasSelections(selections)) return new Set();
  const refs = await resolveEffectivePluginSelectionRefs(selections);
  return new Set([
    ...refs.skillRefs.map((ref) =>
      delegationCapabilityRefKey({ kind: 'skill', ...ref }),
    ),
    ...refs.pluginRefs.map((ref) =>
      delegationCapabilityRefKey({ kind: 'plugin', ...ref }),
    ),
    ...refs.mcpServerRefs.map((ref) =>
      delegationCapabilityRefKey({ kind: 'mcp', ...ref }),
    ),
  ]);
}

/**
 * A root chat's effective set: its tab selections (which already include a
 * chat Agent's) plus the global overlay when the session applies it. The
 * automation `packageOverlay` is not inherited (decision A-3).
 */
export async function resolveRootCallerCapabilities(
  owner: AgentSessionOptions,
): Promise<DelegationCallerCapabilities> {
  const selections = await resolveEffectiveChatPluginSelections(
    owner.pluginSelections,
    {
      projectId: owner.projectId,
      worktreeId: owner.worktreeId,
      chatId: owner.chatId,
    },
    owner.applyGlobalPluginDefaults === true,
  );
  return Object.freeze({
    depth: 0,
    selections,
    effectiveKeys: await effectiveKeysForSelections(selections),
    mayDiscover: owner.deferredToolsAllowed === true,
    rootDeferredToolsAllowed: owner.deferredToolsAllowed === true,
    inheritedOverlay: selectHomeCapabilityOverlay(
      owner.inheritedCapabilityOverlay,
    ),
  });
}

/**
 * A delegate's effective set is its retained overlay, never the root chat's.
 * A legacy delegate without a grant or overlay items passes nothing on.
 */
export function resolveDelegateCallerCapabilities(input: {
  readonly depth: number;
  readonly owner: AgentSessionOptions;
  readonly grant: DelegationCapabilityGrant | undefined;
  readonly overlay: MaterializedCapabilityOverlay | undefined;
}): DelegationCallerCapabilities {
  const items = input.overlay?.items ?? [];
  const rootDeferredToolsAllowed = input.owner.deferredToolsAllowed === true;
  return Object.freeze({
    depth: input.depth,
    selections: items.length
      ? selectionsFromRefs(
          items.map((item) => item.ref),
          {
            mcpHttpAuthPreferences: [
              ...(input.overlay?.capabilities.mcpHttpAuthPreferences ?? []),
            ],
          },
        )
      : EMPTY_SELECTIONS,
    effectiveKeys: new Set(
      items.map((item) => delegationCapabilityRefKey(item.ref)),
    ),
    mayDiscover: rootDeferredToolsAllowed && input.grant?.discovery === true,
    rootDeferredToolsAllowed,
    ...(input.grant ? { parentGrant: input.grant } : {}),
    inheritedOverlay: selectHomeCapabilityOverlay(input.overlay),
  });
}

/** Spawn-time discovery grant for the child (decision A-1). */
export function childCapabilityDiscovery(
  caller: DelegationCallerCapabilities,
  task: Pick<AgentDelegationSpawnRequest, 'allowCapabilityDiscovery'>,
): boolean {
  return resolveDelegationCapabilityDiscovery({
    callerDepth: caller.depth,
    rootDeferredToolsAllowed: caller.rootDeferredToolsAllowed,
    parentGrant: caller.parentGrant,
    requested: task.allowCapabilityDiscovery,
  });
}

function kindLabel(kind: DelegationCapabilityKind): string {
  return kind === 'mcp' ? 'MCP server' : kind;
}

/** Validates explicit IDs against the catalog and the grantability rule. */
export function resolveExplicitCapabilities(
  ids: readonly string[],
  caller: DelegationCallerCapabilities,
  catalog: DelegationCapabilityCatalog,
): readonly DelegationCapabilityCatalogItem[] {
  const items: DelegationCapabilityCatalogItem[] = [];
  ids.forEach((id, index) => {
    const item = catalog.byId.get(id);
    if (!item)
      throw new DelegationCapabilityAssignmentError(
        `Capability ${index + 1} in capabilities is not available. List Delegates with includeCapabilities: true returns the current IDs.`,
      );
    const name = delegationCapabilityDisplayName(item.name);
    const inherited = caller.effectiveKeys.has(
      delegationCapabilityRefKey(item.ref),
    );
    if (!inherited && !caller.mayDiscover)
      throw new DelegationCapabilityAssignmentError(
        `The ${kindLabel(item.kind)} "${name}" can't be given to this delegate: you can only assign plugins, skills and MCP servers you have yourself.`,
      );
    if (
      !inherited &&
      (item.status === 'unsupported' || item.status === 'disabled')
    )
      throw new DelegationCapabilityAssignmentError(
        `The ${kindLabel(item.kind)} "${name}" can't be given to this delegate: ${item.reason ?? 'it is not available for this model.'}`,
      );
    items.push(item);
  });
  return items;
}

export interface PreparedDelegationCapabilities {
  /** Undefined when the child has nothing to stage. */
  readonly overlay: CapabilityOverlayInput | undefined;
  /** The grant to persist, given the retained overlay hash; undefined when none. */
  grant(overlayHash: string | undefined): DelegationCapabilityGrant | undefined;
}

/**
 * Composes and materializes the child's layers. Agent-layer problems keep
 * today's fail-fast errors; an unusable explicit item fails the spawn and
 * names the item; unusable inherited items are skipped and recorded.
 */
export async function prepareDelegationCapabilities(input: {
  readonly task: AgentDelegationSpawnRequest;
  readonly caller: DelegationCallerCapabilities;
  readonly agentSelections: ChatTabPluginSelections | undefined;
  readonly harness: ModelHarness;
  readonly materialize: (
    layers: readonly DelegationCapabilityLayer[],
  ) => Promise<MaterializedDelegationCapabilities>;
  readonly loadCatalog: (
    harness:
      | 'claude'
      | 'codex'
      | 'cursor'
      | 'copilot'
      | 'antigravity'
      | 'opencode',
  ) => Promise<DelegationCapabilityCatalog>;
}): Promise<PreparedDelegationCapabilities> {
  const { task, caller } = input;
  const inherit = task.inheritCapabilities !== false;
  const home = inherit ? caller.inheritedOverlay : undefined;
  const explicitIds = task.capabilities ?? [];
  const discovery = childCapabilityDiscovery(caller, task);
  let explicitItems: readonly DelegationCapabilityCatalogItem[] = [];
  if (explicitIds.length > 0) {
    if (
      input.harness !== 'claude' &&
      input.harness !== 'codex' &&
      input.harness !== 'cursor' &&
      input.harness !== 'copilot' &&
      input.harness !== 'opencode'
    )
      throw new DelegationAgentCapabilityError('unsupported_capability');
    explicitItems = resolveExplicitCapabilities(
      explicitIds,
      caller,
      await input.loadCatalog(input.harness),
    );
  }
  const layers: DelegationCapabilityLayer[] = [];
  if (input.agentSelections)
    layers.push({ source: 'agent', selections: input.agentSelections });
  if (explicitItems.length)
    layers.push({
      source: 'explicit',
      selections: selectionsFromRefs(
        explicitItems.map((item) => item.ref),
        caller.selections,
      ),
    });
  if (inherit && hasSelections(caller.selections))
    layers.push({ source: 'inherited', selections: caller.selections });
  const materialized: MaterializedDelegationCapabilities | undefined =
    layers.length ? await input.materialize(layers) : undefined;
  const agentWarning = materialized?.layerWarnings.find(
    (warning) => warning.source === 'agent',
  );
  if (agentWarning)
    throw new DelegationAgentCapabilityError(agentWarning.reason);
  const agentSkip = materialized?.skipped.find(
    (item) => item.source === 'agent',
  );
  if (agentSkip) throw new DelegationAgentCapabilityError(agentSkip.reason);
  const explicitSkip = materialized?.skipped.find(
    (item) => item.source === 'explicit',
  );
  if (explicitSkip)
    throw new DelegationAgentCapabilityError(explicitSkip.reason, {
      kind: explicitSkip.kind,
      name: explicitSkip.name,
    });
  const included: readonly DelegationCapabilityItemResult[] =
    materialized?.included ?? [];
  const skipped: readonly SkippedDelegationCapabilityItem[] =
    materialized?.skipped.filter((item) => item.source === 'inherited') ?? [];
  const inheritedHadItems =
    included.some((item) => item.source === 'inherited') ||
    skipped.length > 0 ||
    (home?.homeEntries?.length ?? 0) > 0;
  const selectedOverlay: CapabilityOverlayInput | undefined = materialized
    ? {
        pluginFiles: materialized.files,
        capabilities: materialized.capabilities,
        provenance: materialized.provenance,
        items: included.map((item) =>
          Object.freeze({
            id: item.id,
            name: delegationCapabilityDisplayName(item.name),
            source: item.source,
            ref: item.ref,
          }),
        ),
      }
    : undefined;
  const skippedHome: RetainedHomeCapability[] = [];
  const overlay = mergeHomeCapabilityOverlay(selectedOverlay, home, (entry) => {
    skippedHome.push(entry);
  });
  // An Agent's own selections count too, so the card can show them.
  const recordGrant =
    task.inheritCapabilities !== undefined ||
    explicitIds.length > 0 ||
    task.allowCapabilityDiscovery !== undefined ||
    inheritedHadItems ||
    included.some((item) => item.source === 'agent') ||
    discovery;
  return Object.freeze({
    overlay,
    grant: (
      overlayHash: string | undefined,
    ): DelegationCapabilityGrant | undefined =>
      recordGrant
        ? Object.freeze({
            inherit,
            explicit: Object.freeze(explicitItems.map((item) => item.id)),
            discovery,
            loaded: Object.freeze([]),
            skipped: Object.freeze(
              skipped
                .slice(0, DELEGATION_CAPABILITY_GRANT_LIMITS.skipped)
                .map((item) =>
                  Object.freeze({
                    id: item.id,
                    reason: delegationCapabilitySkipReason(item.reason),
                  }),
                ),
            ),
            overlayHash: overlayHash ?? EMPTY_CAPABILITY_OVERLAY_HASH,
            summary: summarizeDelegationCapabilities({
              inherit,
              discovery,
              items: [
                ...included.map((item) => ({
                  kind: item.kind,
                  name: item.name,
                  source: item.source,
                })),
                ...(overlay?.homeEntries ?? []).map((entry) => ({
                  kind:
                    entry.kind === 'plugin'
                      ? ('plugin' as const)
                      : ('skill' as const),
                  name: entry.name,
                  source: 'inherited' as const,
                })),
              ],
              skipped: [
                ...skipped.map((item) => ({
                  kind: item.kind,
                  name: item.name,
                  reason: delegationCapabilitySkipReason(item.reason),
                })),
                ...skippedHome.map((entry) => ({
                  kind:
                    entry.kind === 'plugin'
                      ? ('plugin' as const)
                      : ('skill' as const),
                  name: entry.name,
                  reason: 'unavailable_asset' as const,
                })),
              ],
            }),
          })
        : undefined,
  });
}

const MAX_CAPABILITY_CHOICES = 256;
const MAX_DRY_RUNS = 32;

/**
 * List Delegates { includeCapabilities }: the installed catalog marked with
 * what the caller already has and what it may assign. Assignable items get
 * a bounded dry-run materialization, like Agent discovery.
 */
export async function discoverDelegationCapabilityChoices(input: {
  readonly caller: DelegationCallerCapabilities;
  readonly catalog: DelegationCapabilityCatalog;
  readonly dryRun: (
    item: DelegationCapabilityCatalogItem,
  ) => Promise<string | undefined>;
  readonly signal?: AbortSignal;
}): Promise<DelegationCapabilityDiscovery> {
  const choices: DelegationCapabilityChoice[] = [];
  let dryRuns = 0;
  for (const item of input.catalog.items.slice(0, MAX_CAPABILITY_CHOICES)) {
    if (input.signal?.aborted)
      throw new Error('Capability discovery cancelled');
    const inherited = input.caller.effectiveKeys.has(
      delegationCapabilityRefKey(item.ref),
    );
    let disabledReason: string | undefined;
    if (!inherited) {
      if (item.status === 'unsupported' || item.status === 'disabled')
        disabledReason = item.reason ?? 'This is not available for this model.';
      else if (!input.caller.mayDiscover)
        disabledReason =
          'You can only assign plugins, skills and MCP servers you have yourself.';
    }
    if (!disabledReason && !inherited && dryRuns < MAX_DRY_RUNS) {
      dryRuns += 1;
      disabledReason = await input.dryRun(item);
    }
    const description = item.description.trim();
    choices.push(
      Object.freeze({
        id: item.id,
        kind: item.kind,
        name: delegationCapabilityDisplayName(item.name),
        ...(description ? { description: description.slice(0, 1_000) } : {}),
        inherited,
        assignable: inherited || disabledReason === undefined,
        ...(disabledReason ? { disabledReason } : {}),
      }),
    );
  }
  return Object.freeze({
    capabilities: Object.freeze(choices),
    ...(input.catalog.items.length > MAX_CAPABILITY_CHOICES
      ? { capabilitiesTruncated: true }
      : {}),
  });
}

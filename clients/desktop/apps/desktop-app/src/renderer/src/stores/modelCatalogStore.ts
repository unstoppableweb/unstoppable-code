import { create } from 'zustand';
import { hydrateCursorModelCache } from '@/hooks/cursor-model-cache';
import type {
  AiGatewayCatalogStatus,
  GatewayRouteEntry,
  ModelHarness,
  ModelHarnessAssignmentSnapshot,
  ModelRegistrySnapshot,
} from '@canopy/desktop-shared/types';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  initAgentModels,
  initAiGatewayModels,
  initClaudeModels,
  initCursorModels,
  initCopilotModels,
  initOpenCodeModels,
  initCodexModels,
  initModelAliases,
  initModelHarnessAssignments,
  initOllamaModels,
  omitModelFeatureFlags,
} from '@canopy/desktop-shared/types';
import {
  isModelBlocked,
  resolveModelPolicyIndex,
  type ModelPolicyIndex,
} from '@canopy/desktop-shared/lib/model-policy';
import {
  resolveModelGatewayIndex,
  type ModelGatewayIndex,
} from '@canopy/desktop-shared/lib/org-model-gateway';
import {
  initOrgGatewayModelAliases,
  type OrgGatewayModelAliases,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import { getSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { findOrganizationName } from '@/lib/organizationName';
import { replaceModelFamilyMetadata } from '@canopy/desktop-shared/model-config';
import { useChatStore } from './chatStore';
import { useAppAdvisorStore } from './appAdvisorStore';
import { useFeatureFlagsStore } from './featureFlagsStore';
import { useWorkspaceContextStore } from './workspaceContextStore';
import {
  bumpRendererModelFactsVersion,
  getRendererActiveWorkOwner,
  getRendererModelGatewayEnforced,
  getRendererModelGatewayRequirement,
  getRendererModelGatewayIndex,
  getRendererModelPolicy,
  setRendererActiveWorkOwner,
  setRendererModelGatewayIndex,
  setRendererModelPolicyIndex,
} from './modelPolicyRuntime';

export type HarnessAssignmentsLoadState =
  | 'idle'
  | 'loading'
  | 'loaded'
  | 'error';

interface ModelCatalogState {
  /** Last received registry snapshot, as delivered by main (UNfiltered). */
  snapshot: ModelRegistrySnapshot | null;
  /**
   * Model ids the active owner's organization blocks, in the opaque encoding
   * {@link isModelBlocked} consumes. Empty for Personal work and for the
   * overwhelming majority of users — nobody in an enforcing org — which is the
   * path that must stay byte-for-byte unchanged. An unknown owner (org
   * projects off, or the context not hydrated) gets the union across orgs.
   */
  policy: ReadonlySet<string>;
  /** Every organization's policy, from the last account read. */
  policyIndex: ModelPolicyIndex;
  /** Every organization's model gateway, from the last account read. */
  gatewayIndex: ModelGatewayIndex;
  /**
   * Owner of the work models are being chosen for: the navigation context, or
   * `undefined` while org projects are off or the context is not hydrated.
   */
  activeOwner: WorkOwner | undefined;
  /** Display name of the active owner's organization, when there is one. */
  activeOrganizationName: string | undefined;
  /**
   * Whether the active owner's organization makes its gateway the only route.
   * Renderer affordance mirror; main remains the fail-closed control.
   */
  modelGatewayEnforced: boolean;
  /**
   * Authoritative model-to-harness assignment snapshot mirrored from main
   * (optimistically patched while a mutation is in flight). Main is the only
   * writer of record; every successful IPC mutation and registry broadcast
   * replaces this wholesale.
   */
  harnessAssignments: ModelHarnessAssignmentSnapshot | null;
  harnessAssignmentsLoadState: HarnessAssignmentsLoadState;
  /** True after a failed save until dismissed; drives the settings alert. */
  harnessSaveFailed: boolean;
  /**
   * AI Gateway catalog download state from the last registry snapshot. `null`
   * means unknown: no snapshot yet, an older snapshot, or no catalog service
   * (no cloud configured). Only `'failed'` should surface a failure.
   */
  aiGatewayCatalogStatus: AiGatewayCatalogStatus | null;
  /** Hydrate all model registries from a snapshot. */
  hydrate: (snapshot: ModelRegistrySnapshot) => void;
  /**
   * Re-read the org model policy from the persisted cloud account and re-apply
   * the last snapshot through it. Safe to call at any time: clearing a policy
   * restores the full catalog with no restart.
   */
  refreshPolicy: () => Promise<void>;
  /**
   * Point the catalog at the current navigation owner and re-project the last
   * snapshot when it changed. Called on every context or feature-flag update.
   */
  syncActiveOwner: () => void;
  /**
   * Subscribe to model-registry:updated IPC events and navigation-owner
   * changes. `isTabInOwnerScope` tells registry reconciliation which chat tabs
   * the active owner's policy may rewrite. Returns unsubscribe fn.
   */
  subscribe: (options?: {
    isTabInOwnerScope?: (
      projectId: string,
      executionContext: string | undefined,
      hasConversationContent: boolean,
    ) => boolean;
  }) => () => void;
  /** Load the authoritative harness-assignment snapshot from main. */
  loadHarnessAssignments: () => Promise<void>;
  /** Optimistically move a configurable model to another harness. */
  setModelHarness: (modelId: string, harness: ModelHarness) => Promise<void>;
  /** Remove a gateway override, returning to the current recommendation. */
  resetModelHarness: (modelId: string) => Promise<void>;
  dismissHarnessSaveError: () => void;
  /**
   * Ask main to fetch the AI Gateway catalog now. Resolves when the attempt
   * finishes; `aiGatewayCatalogStatus` updates through the registry broadcast.
   */
  retryAiGatewayCatalog: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Harness-assignment mutation bookkeeping (module-local, not reactive state).
//
// Mutations are serialized through a promise chain and tagged with monotonic
// client operation ids so responses/broadcasts can be ordered:
//  - the optimistic patch is applied immediately for responsive drag/menu UX;
//  - only the NEWEST operation's authoritative response replaces local state
//    (stale successes are skipped — the newer op's response follows in-chain);
//  - a failed newest operation rolls back just its own row; a failed
//    superseded operation reloads the authoritative snapshot instead;
//  - registry broadcasts arriving mid-mutation are buffered and applied once
//    the chain drains, so cross-window updates still converge.
// ---------------------------------------------------------------------------
let harnessOpSeq = 0;
let latestHarnessOp = 0;
let pendingHarnessOps = 0;
let bufferedBroadcast: ModelHarnessAssignmentSnapshot | null = null;
let harnessMutationChain: Promise<void> = Promise.resolve();

function filterHarnessAssignments(
  snapshot: ModelHarnessAssignmentSnapshot,
  policy: ReadonlySet<string>,
): ModelHarnessAssignmentSnapshot {
  if (policy.size === 0) return snapshot;
  return {
    ...snapshot,
    assignments: snapshot.assignments.filter(
      ({ modelId }) => !isModelBlocked(modelId, policy),
    ),
  };
}

/**
 * Set while {@link applySnapshot} is running, so the assignment apply it
 * performs does not announce a half-applied set of facts. That function
 * announces once at the end, after every registry AND the policy are applied.
 */
let applyingRegistrySnapshot = false;

function applyAuthoritativeAssignments(
  snapshot: ModelHarnessAssignmentSnapshot,
): void {
  const filtered = filterHarnessAssignments(
    snapshot,
    useModelCatalogStore.getState().policy,
  );
  // Keep the shared registry helpers (getExecutionHarnessForModel, provider
  // resolution for gateway rows, …) in sync with the reactive mirror so every
  // picker computes locks against the same authoritative assignments.
  initModelHarnessAssignments(filtered);
  useModelCatalogStore.setState({
    harnessAssignments: filtered,
    harnessAssignmentsLoadState: 'loaded',
  });
  if (applyingRegistrySnapshot) return;
  // A harness assignment changes `getExecutionHarnessForModel`, which is
  // exactly what `resolveLaneForTarget` consults to decide whether a native
  // lane can run a model. Nothing else advanced the model-facts version on the
  // broadcast / load / mutate paths, so the `useSyncExternalStore` snapshot
  // never moved: an open pristine tab could sit on its former model and lane
  // indefinitely, with the dead-end banner stale alongside it.
  bumpRendererModelFactsVersion();
  void useChatStore.getState().syncActiveEmptyTabToDefaults();
}

function currentAssignmentsRevision(): number {
  return useModelCatalogStore.getState().harnessAssignments?.revision ?? -1;
}

/** Apply a broadcast/registry-carried snapshot with ordering guards. */
function receiveAssignmentsSnapshot(
  snapshot: ModelHarnessAssignmentSnapshot,
): void {
  if (pendingHarnessOps > 0) {
    // A local optimistic mutation is in flight; buffer the newest broadcast
    // and let the mutation chain apply it (or its own response) on drain.
    if (!bufferedBroadcast || snapshot.revision >= bufferedBroadcast.revision) {
      bufferedBroadcast = snapshot;
    }
    return;
  }
  if (snapshot.revision >= currentAssignmentsRevision()) {
    applyAuthoritativeAssignments(snapshot);
  }
}

function drainBufferedBroadcast(): void {
  if (pendingHarnessOps > 0 || !bufferedBroadcast) return;
  const buffered = bufferedBroadcast;
  bufferedBroadcast = null;
  if (buffered.revision >= currentAssignmentsRevision()) {
    applyAuthoritativeAssignments(buffered);
  }
}

function runHarnessMutation(
  modelId: string,
  execute: () => Promise<ModelHarnessAssignmentSnapshot>,
  optimisticHarness: ModelHarness | 'default',
): Promise<void> {
  const state = useModelCatalogStore.getState();
  const current = state.harnessAssignments;
  if (!current) return Promise.resolve();
  const row = current.assignments.find(
    (assignment) => assignment.modelId === modelId,
  );
  if (!row || !row.configurable) return Promise.resolve();

  const previousRow = { ...row };
  const opId = ++harnessOpSeq;
  latestHarnessOp = opId;
  pendingHarnessOps += 1;

  // Optimistic patch: move the row locally right away. `overridden` is a
  // best-effort guess — the authoritative response corrects it.
  const nextHarness =
    optimisticHarness === 'default' ? row.defaultHarness : optimisticHarness;
  useModelCatalogStore.setState((prev) => {
    if (!prev.harnessAssignments) return prev;
    return {
      harnessSaveFailed: false,
      harnessAssignments: {
        revision: prev.harnessAssignments.revision,
        assignments: prev.harnessAssignments.assignments.map((assignment) =>
          assignment.modelId === modelId
            ? {
                ...assignment,
                harness: nextHarness,
                overridden:
                  optimisticHarness !== 'default' &&
                  nextHarness !== assignment.defaultHarness,
              }
            : assignment,
        ),
      },
    };
  });

  harnessMutationChain = harnessMutationChain.then(async () => {
    try {
      const snapshot = await execute();
      if (opId === latestHarnessOp) {
        applyAuthoritativeAssignments(snapshot);
      }
      // Superseded success: skip — the newer operation's authoritative
      // response lands later in this same chain.
    } catch {
      if (opId === latestHarnessOp) {
        // Roll back only this operation's row; nothing newer exists.
        useModelCatalogStore.setState((prev) => {
          if (!prev.harnessAssignments) {
            return { harnessSaveFailed: true };
          }
          return {
            harnessSaveFailed: true,
            harnessAssignments: {
              revision: prev.harnessAssignments.revision,
              assignments: prev.harnessAssignments.assignments.map(
                (assignment) =>
                  assignment.modelId === modelId
                    ? { ...previousRow }
                    : assignment,
              ),
            },
          };
        });
      } else {
        // A newer optimistic mutation superseded this failure; a plain
        // rollback could clobber it, so reload authoritative state instead.
        useModelCatalogStore.setState({ harnessSaveFailed: true });
        try {
          const snapshot = await window.api.harnessAssignments.load();
          if (opId === latestHarnessOp) {
            applyAuthoritativeAssignments(snapshot);
          } else if (
            !bufferedBroadcast ||
            snapshot.revision >= bufferedBroadcast.revision
          ) {
            bufferedBroadcast = snapshot;
          }
        } catch {
          // Keep local state; the next broadcast/load reconverges.
        }
      }
    } finally {
      pendingHarnessOps -= 1;
      drainBufferedBroadcast();
    }
  });
  return harnessMutationChain;
}

const NO_POLICY: ReadonlySet<string> = new Set<string>();

/**
 * Whether chat tabs in a project belong to the active owner. Injected by
 * `subscribe` rather than imported: the sidebar's scoping rule reads the
 * projects store, which this store must not pull into its import graph.
 * Until then every tab is in scope, the pre-owner behavior.
 */
let isTabInOwnerScope: (
  projectId: string,
  executionContext: string | undefined,
  hasConversationContent: boolean,
) => boolean = () => true;
/**
 * Latest `refreshPolicy` call. A registry update and `preferencesChanged`
 * both start one, so an older, slower account read must not overwrite a
 * newer one.
 */
let policyRefreshSeq = 0;

/** The gateway part of a registry snapshot, to tell whether it changed. */
function gatewaySignature(snapshot: ModelRegistrySnapshot | null): string {
  return JSON.stringify([
    snapshot?.aiGatewayModels ?? [],
    snapshot?.gatewayRoutes ?? [],
    snapshot?.aiGatewayCatalogStatus ?? null,
  ]);
}
const EMPTY_POLICY_INDEX: ModelPolicyIndex = {
  byOrganization: new Map(),
  union: NO_POLICY,
};
const EMPTY_GATEWAY_INDEX: ModelGatewayIndex = {
  byOrganization: new Map(),
  accountUnavailable: false,
};

/** Owner of the navigation context, matching main's `resolveNavigationWorkOwner`. */
function ownerForContext(
  context: WorkspaceContext | undefined,
): WorkOwner | undefined {
  if (!context) return undefined;
  return context.kind === 'organization'
    ? { kind: 'organization', organizationId: context.organizationId }
    : { kind: 'personal' };
}

function navigationOwner(
  gatewayIndex: ModelGatewayIndex,
): WorkOwner | undefined {
  const context = getSidebarScopingContext();
  if (context) return ownerForContext(context);
  const workspace = useWorkspaceContextStore.getState();
  // A known Personal context does not depend on the organization-projects rollout.
  if (
    gatewayIndex.personalOrganizationId &&
    workspace.hydrated &&
    workspace.state.context.kind === 'personal'
  )
    return { kind: 'personal' };
  return undefined;
}

function organizationNameForOwner(
  owner: WorkOwner | undefined,
  gatewayIndex: ModelGatewayIndex,
): string | undefined {
  if (!owner) return undefined;
  const organizationId = normalizeUuid(
    owner.kind === 'personal'
      ? gatewayIndex.personalOrganizationId
      : owner.organizationId,
  );
  const fromAccount = organizationId
    ? gatewayIndex.byOrganization.get(organizationId)?.organizationName.trim()
    : undefined;
  if (fromAccount) return fromAccount;
  if (owner.kind === 'personal') return undefined;
  return (
    findOrganizationName(
      useWorkspaceContextStore.getState().state.organizations,
      owner.organizationId,
    ) ?? undefined
  );
}

/**
 * Rebuild the bare-id → per-org alias map from the namespaced gateway rows.
 * The catalog merge renames a colliding org model to `<id>@<orgId>`; the
 * route carries the org, so the bare id is recoverable without a new field.
 */
function orgGatewayAliasesFromRoutes(
  routes: readonly GatewayRouteEntry[],
): OrgGatewayModelAliases {
  const aliases: Record<string, Record<string, string>> = {};
  for (const route of routes) {
    if (route.origin !== 'org-gateway' || !route.organizationId) continue;
    const suffix = `@${route.organizationId}`;
    const bare = route.modelId.endsWith(suffix)
      ? route.modelId.slice(0, -suffix.length)
      : route.modelId;
    const byOrganization = aliases[bare] ?? {};
    byOrganization[
      normalizeUuid(route.organizationId) ?? route.organizationId
    ] = route.modelId;
    aliases[bare] = byOrganization;
  }
  return aliases;
}

/**
 * Gateway rows the active owner may not use: every org's rows for Personal
 * work, and other orgs' rows for org work. An unknown owner keeps them all.
 */
function foreignOrgGatewayModelIds(
  routes: readonly GatewayRouteEntry[],
  owner: WorkOwner | undefined,
  personalOrganizationId?: string,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (!owner) return hidden;
  const ownerOrganizationId = normalizeUuid(
    owner.kind === 'personal' ? personalOrganizationId : owner.organizationId,
  );
  for (const route of routes) {
    if (route.origin !== 'org-gateway') continue;
    if (
      ownerOrganizationId === null ||
      normalizeUuid(route.organizationId) !== ownerOrganizationId
    ) {
      hidden.add(route.modelId);
    }
  }
  return hidden;
}

/**
 * The single renderer hydration point for the model catalog, so every surface
 * that reads a registry — pickers, defaults, Agent availability — inherits the
 * org policy filter without knowing it exists.
 *
 * Order matters twice over:
 *
 * 1. The registries are initialized from the FULL snapshot first, because
 *    `isModelBlocked` unwraps aliases and Agent base models before comparing,
 *    and that unwrapping reads the very registries being populated. Filtering
 *    first would compare wrapper ids against a policy written in base-model
 *    ids and let an org-blocked model through an Agent or a pipeline alias.
 * 2. Only then are the blocked rows removed and the registries re-initialized.
 *
 * Ollama is deliberately untouched: local ids are discovered on the user's own
 * machine and can never appear in an org's reviewed snapshot, so putting them
 * through an "unreviewed ⇒ blocked" rule would silently kill every local model
 * the moment an org enables the policy. Local inference never leaves the
 * machine, so it is outside the boundary this policy governs by construction.
 */
function applySnapshot(
  snapshot: ModelRegistrySnapshot,
  policyIndex: ModelPolicyIndex,
  // True only when `policyIndex` came from an account read. The registry paths
  // pass `false`: they forward whatever the store already holds, which is an
  // empty index until the first real read lands.
  policyFromAccountRead: boolean,
): void {
  setRendererModelPolicyIndex(policyIndex, policyFromAccountRead);
  const owner = getRendererActiveWorkOwner();
  const policy = getRendererModelPolicy();
  const routes = snapshot.gatewayRoutes ?? [];
  const personalOrganizationId =
    getRendererModelGatewayIndex().personalOrganizationId;
  const foreignGatewayIds = foreignOrgGatewayModelIds(
    routes,
    owner,
    personalOrganizationId,
  );
  initOrgGatewayModelAliases(
    orgGatewayAliasesFromRoutes(routes),
    personalOrganizationId,
  );
  replaceModelFamilyMetadata([...snapshot.claude, ...snapshot.codex]);
  // Initialization order (settings + pickers depend on it):
  //   1. managed/gateway/Ollama catalogs and gateway routes,
  //   2. the authoritative harness-assignment snapshot,
  //   3. chat-tab reconciliation against the fully hydrated registries.
  if (snapshot.cursor) {
    initCursorModels(snapshot.cursor);
    hydrateCursorModelCache(window.api, snapshot.cursor);
  }
  initCopilotModels(snapshot.copilot ?? []);
  initOpenCodeModels(snapshot.opencode ?? []);
  initModelAliases(snapshot.aliases);
  initClaudeModels(omitModelFeatureFlags(snapshot.claude));
  initCodexModels(omitModelFeatureFlags(snapshot.codex));
  initAiGatewayModels(
    snapshot.aiGatewayModels ?? [],
    snapshot.gatewayRoutes ?? [],
  );
  // Ollama is build-gated: on Windows builds where Ollama is disabled the
  // renderer catalog stays empty regardless of what the snapshot carries, so
  // no renderer surface can list Ollama models. macOS hydrates as before.
  initOllamaModels(__CANOPY_OLLAMA_ENABLED__ ? snapshot.ollama : []);
  // Load the custom Agent model overlay AFTER the base provider registries and
  // aliases so each Agent's base-model availability is evaluated against the
  // just-initialized Claude/Codex/Ollama/alias registries. A missing `agents`
  // field is treated as an empty overlay for backward compatibility.
  initAgentModels(snapshot.agents ?? []);
  if (policy.size > 0 || foreignGatewayIds.size > 0) {
    const excluded = (modelId: string): boolean =>
      foreignGatewayIds.has(modelId) || isModelBlocked(modelId, policy);
    const claude = snapshot.claude.filter((entry) => !excluded(entry.id));
    const codex = snapshot.codex.filter((entry) => !excluded(entry.id));
    const agents = (snapshot.agents ?? []).filter(
      (entry) => !excluded(entry.id),
    );
    const gateway = (snapshot.aiGatewayModels ?? []).filter(
      (entry) => !excluded(entry.id),
    );
    const allowedRoutes = routes.filter((route) => !excluded(route.modelId));
    initClaudeModels(omitModelFeatureFlags(claude), undefined, true);
    initCodexModels(omitModelFeatureFlags(codex), undefined, true);
    initAiGatewayModels(gateway, allowedRoutes, true);
    initAgentModels(agents);
  }

  // Older preload snapshots omit `harnessAssignments`; keep whatever
  // authoritative state was already hydrated in that case.
  if (snapshot.harnessAssignments) {
    applyingRegistrySnapshot = true;
    try {
      receiveAssignmentsSnapshot(snapshot.harnessAssignments);
    } finally {
      applyingRegistrySnapshot = false;
    }
  }
  // Announce the new facts only now that every registry AND the policy are
  // applied. `setRendererModelPolicy` above bumps too, but it runs before the
  // catalogs hydrate, so a listener woken by that alone could re-derive against
  // a half-applied snapshot.
  bumpRendererModelFactsVersion();
  const gatewayRequirement = getRendererModelGatewayRequirement();
  useChatStore.getState().reconcileModelRegistry(snapshot, policy, {
    owner,
    organizationName: organizationNameForOwner(
      owner,
      useModelCatalogStore.getState().gatewayIndex,
    ),
    gatewayEnforced: getRendererModelGatewayEnforced(),
    gatewayEnforcingOrganizationIds:
      gatewayRequirement.kind === 'enforced'
        ? gatewayRequirement.organizationIds
        : undefined,
    // The injected resolver combines project ownership with the tab's captured
    // execution context. Tabs outside that immutable owner keep their model
    // here, and main's session gate remains the final authority.
    isTabInOwnerScope,
  });
  // Policy and catalog hydration can change the dispatchable lane/model set
  // without changing auth availability. Re-run the same guarded pristine-tab
  // reconciliation used by the billing-lane subscription so a provisional
  // seed settles after policy hydration too.
  void useChatStore.getState().syncActiveEmptyTabToDefaults();
}

export const useModelCatalogStore = create<ModelCatalogState>((set, get) => ({
  snapshot: null,
  policy: NO_POLICY,
  policyIndex: EMPTY_POLICY_INDEX,
  gatewayIndex: EMPTY_GATEWAY_INDEX,
  activeOwner: undefined,
  activeOrganizationName: undefined,
  modelGatewayEnforced: false,
  harnessAssignments: null,
  harnessAssignmentsLoadState: 'idle',
  harnessSaveFailed: false,
  aiGatewayCatalogStatus: null,

  hydrate: (snapshot): void => {
    applySnapshot(snapshot, get().policyIndex, false);
    set({
      snapshot,
      aiGatewayCatalogStatus: snapshot.aiGatewayCatalogStatus ?? null,
    });
  },

  refreshPolicy: async (): Promise<void> => {
    const seq = ++policyRefreshSeq;
    let policyIndex: ModelPolicyIndex = EMPTY_POLICY_INDEX;
    let gatewayIndex: ModelGatewayIndex = EMPTY_GATEWAY_INDEX;
    try {
      const account = await window.api.loadCanopyCloudAccount();
      if (seq !== policyRefreshSeq) return;
      policyIndex = resolveModelPolicyIndex(account);
      gatewayIndex = resolveModelGatewayIndex(account);
    } catch {
      // A failed renderer-side read leaves the picker unfiltered; enforcement
      // itself lives at the main-process session guard, which fails closed for
      // a known org member. This filter is the affordance, not the control.
      return;
    }
    const snapshot = get().snapshot;
    setRendererModelGatewayIndex(gatewayIndex);
    // Record hydration from the ACCOUNT READ ITSELF, before the snapshot guard.
    //
    // `main.tsx` starts `getModelRegistry()` and `refreshPolicy()` in the same
    // tick, and the account read is a small decrypt against assembling the whole
    // registry snapshot — so it can easily land first, with `snapshot` still
    // `null`. Setting hydration only inside `applySnapshot` meant that race left
    // the flag `false` for the entire session (the later `hydrate()` passes
    // `false`, and `updatePreferencesFile` does not broadcast
    // `preferencesChanged`, so the recovery path rarely fires). Every renderer
    // resolution then stayed `provisional`, and `resolveBillingSeed` never
    // returned `'ai-credits'` — so a credits-lane user's new chats shipped
    // without the billing seed the tool-schema profile and the banner read.
    setRendererModelPolicyIndex(policyIndex, true);
    const owner = navigationOwner(gatewayIndex);
    setRendererActiveWorkOwner(owner);
    set({
      activeOwner: owner,
      policyIndex,
      gatewayIndex,
      policy: getRendererModelPolicy(),
      modelGatewayEnforced: getRendererModelGatewayEnforced(),
      activeOrganizationName: organizationNameForOwner(owner, gatewayIndex),
    });
    if (snapshot) {
      applySnapshot(snapshot, policyIndex, true);
      // New object identity so subscribers re-read the filtered registries.
      set({ snapshot: { ...snapshot } });
    }
  },

  syncActiveOwner: (): void => {
    const owner = navigationOwner(get().gatewayIndex);
    const changed = setRendererActiveWorkOwner(owner);
    const activeOrganizationName = organizationNameForOwner(
      owner,
      get().gatewayIndex,
    );
    if (!changed) {
      // Same owner; only the organization's display name can have moved.
      if (get().activeOrganizationName !== activeOrganizationName) {
        set({ activeOrganizationName });
      }
      return;
    }
    set({
      activeOwner: owner,
      activeOrganizationName,
      policy: getRendererModelPolicy(),
      modelGatewayEnforced: getRendererModelGatewayEnforced(),
    });
    const snapshot = get().snapshot;
    if (snapshot) {
      applySnapshot(snapshot, get().policyIndex, false);
      set({ snapshot: { ...snapshot } });
    }
  },

  subscribe: (options): (() => void) => {
    if (options?.isTabInOwnerScope) {
      isTabInOwnerScope = options.isTabInOwnerScope;
    }
    get().syncActiveOwner();
    void get().refreshPolicy();
    // Re-project the catalog when the navigation owner changes. Both stores
    // fire on unrelated updates too; `syncActiveOwner` only re-applies the
    // snapshot on a real owner change.
    const unsubContext = useWorkspaceContextStore.subscribe(() => {
      get().syncActiveOwner();
    });
    const unsubFlags = useFeatureFlagsStore.subscribe(() => {
      get().syncActiveOwner();
    });
    const unsubRegistry = window.api.onModelRegistryUpdated(
      (snapshot: ModelRegistrySnapshot) => {
        const gatewayChanged =
          gatewaySignature(get().snapshot) !== gatewaySignature(snapshot);
        applySnapshot(snapshot, get().policyIndex, false);
        set({
          snapshot,
          aiGatewayCatalogStatus: snapshot.aiGatewayCatalogStatus ?? null,
        });
        // When the gateway models changed, re-read the account too, so the
        // gateway section never lags the models it labels. Other updates skip
        // the read. A rename changes the models' `familyLabel`, so it counts;
        // a change to the gateway's URL, models or enforcement also sends
        // `preferencesChanged`, which re-reads. The sequence guard keeps the
        // newest read.
        if (gatewayChanged) void get().refreshPolicy();
        void window.api
          .loadPreferences()
          .then((prefs) => {
            const chat = useChatStore.getState();
            chat.applyModelDefaults(prefs);
            chat.applyDeferredToolsDefaults(prefs);
            useAppAdvisorStore.getState().applyPreferences(prefs);
            return chat.syncActiveEmptyTabToDefaults();
          })
          .catch(() => undefined);
      },
    );
    const unsubPolicy = window.api.onPreferencesChanged(() => {
      void get().refreshPolicy();
    });
    return (): void => {
      unsubContext();
      unsubFlags();
      unsubRegistry();
      unsubPolicy();
    };
  },

  loadHarnessAssignments: async (): Promise<void> => {
    const hasSnapshot = get().harnessAssignments !== null;
    set({
      harnessAssignmentsLoadState: hasSnapshot ? 'loaded' : 'loading',
    });
    try {
      const snapshot = await window.api.harnessAssignments.load();
      receiveAssignmentsSnapshot(snapshot);
      set({ harnessAssignmentsLoadState: 'loaded' });
    } catch {
      // Keep any previously hydrated snapshot usable; only surface the fatal
      // state when nothing was ever loaded.
      set({
        harnessAssignmentsLoadState: get().harnessAssignments
          ? 'loaded'
          : 'error',
      });
    }
  },

  setModelHarness: (modelId, harness): Promise<void> =>
    runHarnessMutation(
      modelId,
      () => window.api.harnessAssignments.set({ modelId, harness }),
      harness,
    ),

  resetModelHarness: (modelId): Promise<void> =>
    runHarnessMutation(
      modelId,
      () => window.api.harnessAssignments.reset({ modelId }),
      'default',
    ),

  dismissHarnessSaveError: (): void => {
    set({ harnessSaveFailed: false });
  },

  retryAiGatewayCatalog: async (): Promise<void> => {
    try {
      await window.api.retryAiGatewayModelCatalog();
    } catch {
      // The status broadcast from main stays authoritative; a failed request
      // leaves the last reported status in place.
    }
  },
}));

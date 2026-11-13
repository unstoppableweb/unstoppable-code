import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SourceLoadError } from '@/lib/summarizeLoadErrors';
import type {
  CanopyCloudAccountPublicState,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { AutomationActionNameResolver } from '@canopy/desktop-shared/lib/automations';
import type { SharedAutomationSummary } from '@canopy/protocol/automations';
import type {
  CustomizeInventoryState,
  UnifiedLocalAutomationInput,
} from '@canopy/ui-app/capability';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import type {
  CollectionIndexEntry,
  SharedCollectionSummary,
} from '@canopy/desktop-shared/types/collections';
import type { SharedSkillSummary } from '@canopy/desktop-shared/types/skills';
import type {
  AgentModelDefinition,
  SharedAgentSummary,
} from '@canopy/execution-engine/types/agent-models';
import type { UnifiedLocalAgentInput } from '@canopy/protocol/unified-entry';
import { marketplaceLocalAgentInputs } from '@/lib/marketplaceAgents';
import { useAgentsStore } from '@/stores/agentsStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { SharedPluginSummary } from '@canopy/protocol/plugins';
import type { WorkspaceTemplateShareSummary } from '@canopy/protocol/workspace-templates';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { toMarketplaceLocalAutomations } from '@/lib/marketplaceAutomations';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useAutomationScope } from './useAutomationScope';
import { useCollectionList } from './useCollectionList';
import { usePipelineList } from './usePipelineList';
import { useSharedCollectionList } from './useSharedCollectionList';
import { useSharedSkillList } from './useSharedSkillList';

import {
  useCuratedAutomations,
  type CuratedAutomationsController,
} from './useCuratedAutomations';
import { useCuratedPipelines } from './useCuratedPipelines';
import { useSharedAutomationList } from './useSharedAutomationList';
import { useSharedMarketplaceShares } from './useSharedMarketplaceShares';
import type { CuratedPipelineListQuery } from '@canopy/protocol/pipeline-catalog';
import type { MarketplaceUnshareKind } from '@canopy/ui-shared/lib';
import { AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT } from '@/lib/share-links';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

export interface CapabilityMarketplaceInventory {
  removeSharedResource: (kind: MarketplaceUnshareKind, id: string) => void;
  ownershipAccountReady: boolean;
  viewerId: string | null;
  /** The account shared skills read through; null while signed out. */
  skillCloudAccount: CanopyCloudAccountPublicState | null;
  ownedSharesLoading: boolean;
  /** Re-reads the viewer's own automation shares, e.g. from Retry. */
  refreshOwnedShares: () => void;
  installedInventory: CustomizeInventoryState;
  pipelines: PipelineInfo[];
  curated: ReturnType<typeof useCuratedPipelines>;
  /** The curated catalog can load: the cloud account is connected. */
  curatedReady: boolean;
  loadMoreSharedPipelines: () => Promise<void>;
  sharedPipelineNextCursor: string | null;
  sharedPipelinesLoadingMore: boolean;
  localCollections: CollectionIndexEntry[];
  sharedSkills: SharedSkillSummary[];
  sharedCollections: SharedCollectionSummary[];
  /**
   * Local automations in the sidebar's selected context, as Marketplace rows.
   * The "Shared by me" facet keeps only the sources of the listed shares.
   */
  localAutomations: UnifiedLocalAutomationInput[];
  /**
   * Every local automation, in or out of the selected context. Installed-copy
   * detection reads the full list so an update still finds its copy.
   */
  automationActivities: ScheduledActivity[];
  /**
   * Team and organization shares in the selected context. The "Shared by me"
   * facet lists the viewer's own shares instead, public-link-only ones too.
   */
  sharedAutomations: SharedAutomationSummary[];
  curatedAutomations: CuratedAutomationsController;
  loadMoreSharedAutomations: () => Promise<void>;
  sharedAutomationNextCursor: string | null;
  sharedAutomationsLoadingMore: boolean;
  /**
   * The complete local agent inventory, as Marketplace inputs. Empty while
   * local agents are disabled; never a stand-in for a failed load.
   */
  localAgents: UnifiedLocalAgentInput[];
  /** The canonical definitions behind `localAgents`, for detail and editing. */
  localAgentDefinitions: AgentModelDefinition[];
  /** True until the first local agent load settles. */
  localAgentsLoading: boolean;
  /** True once a local load has settled, success or failure. */
  localAgentsLoaded: boolean;
  /** The last local load failure, shown apart from shared failures. */
  localAgentsError: string | null;
  refreshLocalAgents: () => Promise<void>;
  /** Agents shared with a team or organization, in the selected context. */
  sharedAgents: SharedAgentSummary[];
  /** Reload shared agents after a share or public-link change. */
  refreshSharedAgents: () => void;
  /** Plugin references shared with a team or organization, in the selected context. */
  sharedPlugins: SharedPluginSummary[];
  /**
   * The viewer's own plugin shares for Shared by you (CAN-4842): the deletable
   * team/organization shares above plus link-only (private) shares.
   */
  ownSharedPlugins: SharedPluginSummary[];
  /** Project templates shared with a team or organization. */
  sharedBlueprints: WorkspaceTemplateShareSummary[];
  loading: boolean;
  /** Every source's failure, one line each: `Shared skills: <message>`. */
  error: string | null;
  /** The same failures, per source, for a summarized notice. */
  loadErrors: SourceLoadError[];
  refreshLocalCollections: () => Promise<void>;
  refreshPipelines: () => Promise<void>;
  /** Pipelines switched off for launch, curated templates included. */
  disabledPipelineIds: ReadonlySet<string>;
  setPipelineEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Deletes a local pipeline; resolves false when it was not deleted. */
  deletePipeline: (id: string) => Promise<boolean>;
  /** Deletes a team-shared pipeline; resolves false when it was not deleted. */
  deleteSharedPipeline: (remoteId: string) => Promise<boolean>;
  refreshSharedSkills: () => Promise<void>;
  refreshSharedCollections: () => Promise<void>;
}

type AutomationMarketplaceSourceKind = 'shared' | 'curated';

function automationSourceKey(
  sourceKind: AutomationMarketplaceSourceKind,
  remoteId: string,
): string {
  return `${sourceKind}:${remoteId}`;
}

interface InstalledAutomationSource {
  sourceKind: AutomationMarketplaceSourceKind;
  remoteId: string;
}

function installedAutomationSources(
  automations: readonly UnifiedLocalAutomationInput[],
): InstalledAutomationSource[] {
  const sources = new Map<string, InstalledAutomationSource>();
  for (const automation of automations) {
    const installedFrom = automation.installedFrom;
    if (!installedFrom) continue;
    const sourceKind = installedFrom.sourceKind ?? 'shared';
    if (sourceKind === 'public') continue;
    const source = { sourceKind, remoteId: installedFrom.remoteId };
    sources.set(
      automationSourceKey(sourceKind, installedFrom.remoteId),
      source,
    );
  }
  return Array.from(sources.values());
}

function canLoadCapability(
  account: CanopyCloudAccountPublicState | null,
  capability: string,
): boolean {
  return (
    account !== null &&
    isCanopyCloudConnected(account) &&
    account.capabilities.includes(capability)
  );
}

/**
 * Loads the non-plugin inventories that participate in marketplace discovery.
 * Each source keeps its existing hook and transport contract; this hook only
 * composes their first pages into one read-only search inventory.
 */
export function useCapabilityMarketplaceInventory(
  query: string,
  options: Omit<CuratedPipelineListQuery, 'q' | 'cursor' | 'limit'> & {
    curatedEnabled?: boolean;
    /** False on tabs that never list automations, so their catalog stays unloaded. */
    curatedAutomationsEnabled?: boolean;
    /** True on tabs that list shared agents, while the Agents flag is on. */
    sharedAgentsEnabled?: boolean;
    /**
     * True while local agents list or an agent detail/editor is pending,
     * with the Agents flag on. Owns hydration and change subscriptions.
     */
    localAgentsEnabled?: boolean;
    /** True on tabs that list shared plugins. */
    sharedPluginsEnabled?: boolean;
    /** True on tabs that list shared project templates. */
    sharedBlueprintsEnabled?: boolean;
    /** Extra viewer-owned shares, in addition to the default catalog lane. */
    ownedAutomationSharesEnabled?: boolean;
    /**
     * Every viewer-owned agent share, beyond the catalog's first page, so
     * "Shared by me" lists older shares too.
     */
    ownedAgentSharesEnabled?: boolean;
    /** Complete the skill/collection catalogs, which have no load-more control. */
    completeSharedCatalogs?: boolean;
  } = {},
): CapabilityMarketplaceInventory {
  const {
    pipelines,
    refresh: refreshLocalPipelines,
    loading: pipelinesLoading,
    error: pipelinesError,
    setSharedFilters,
    loadMoreShared,
    refreshSharedList,
    disabledPipelineIds,
    setPipelineEnabled,
    deletePipeline,
    deleteSharedPipeline,
    shared: {
      rows: sharedPipelineRows,
      nextCursor: sharedPipelineNextCursor,
      loadingMore: sharedPipelinesLoadingMore,
      cloudAccount: pipelineCloudAccount,
      cloudLoading: pipelineCloudLoading,
      loading: sharedPipelinesLoading,
      loaded: sharedPipelinesLoaded,
      error: sharedPipelinesError,
    },
  } = usePipelineList();
  const {
    collections: localCollections,
    loading: collectionsLoading,
    error: collectionsError,
    refresh: refreshLocalCollections,
  } = useCollectionList();
  const {
    skills: sharedSkillRows,
    cloudAccount: skillCloudAccount,
    cloudLoading: skillCloudLoading,
    loading: sharedSkillsLoading,
    loadingMore: sharedSkillsLoadingMore,
    nextCursor: sharedSkillNextCursor,
    loadMoreShared: loadMoreSharedSkills,
    loaded: sharedSkillsLoaded,
    error: sharedSkillsError,
    setFilters: setSharedSkillFilters,
    refreshShared: refreshSharedSkills,
  } = useSharedSkillList();
  const {
    collections: sharedCollectionRows,
    cloudAccount: collectionCloudAccount,
    cloudLoading: collectionCloudLoading,
    loading: sharedCollectionsLoading,
    loadingMore: sharedCollectionsLoadingMore,
    nextCursor: sharedCollectionNextCursor,
    loadMoreShared: loadMoreSharedCollections,
    loaded: sharedCollectionsLoaded,
    error: sharedCollectionsError,
    setFilters: setSharedCollectionFilters,
    refreshShared: refreshSharedCollections,
  } = useSharedCollectionList();

  const {
    automations: sharedAutomationRows,
    cloudAccount: automationCloudAccount,
    cloudLoading: automationCloudLoading,
    loading: sharedAutomationsLoading,
    loadingMore: sharedAutomationsLoadingMore,
    loaded: sharedAutomationsLoaded,
    nextCursor: sharedAutomationNextCursor,
    error: sharedAutomationsError,
    setFilters: setSharedAutomationFilters,
    refreshShared: refreshSharedAutomations,
    loadMoreShared: loadMoreSharedAutomations,
  } = useSharedAutomationList();

  // Local automations follow the sidebar's Personal/organization context, the
  // same rule the Automations page lists by.
  const automationActivities = useAutomationsStore((state) => state.activities);
  const automationRecentRuns = useAutomationsStore((state) => state.recentRuns);
  // Unread counts as loading; a failed first read is an error, not loading.
  const automationsLoading = useAutomationsStore(
    (state) => !state.hydrated && state.error === null,
  );
  const automationsError = useAutomationsStore((state) => state.error);
  useEffect(() => {
    const store = useAutomationsStore.getState();
    const unsubscribe = store.subscribeBridge();
    if (!store.hydrated && !store.loading) {
      void store.hydrate();
    }
    return unsubscribe;
  }, []);
  const automationScope = useAutomationScope();
  const projects = useProjectsStore((state) => state.projects);
  const chatProjects = useStandaloneChatStore((state) => state.chatProjects);
  const baseLocalAutomations = useMemo(() => {
    const nameResolver: AutomationActionNameResolver = {
      standaloneChatProjectName: (chatProjectId): string | undefined =>
        chatProjects.find((project) => project.id === chatProjectId)?.name,
      workspaceName: (workspaceId): string | undefined => {
        const project = projects.find((entry) => entry.id === workspaceId);
        return project ? getWorkspaceDisplayName(project) : undefined;
      },
    };
    return toMarketplaceLocalAutomations(
      automationActivities.filter(automationScope.inContext),
      nameResolver,
      { recentRuns: automationRecentRuns },
    );
  }, [
    automationActivities,
    automationRecentRuns,
    automationScope,
    chatProjects,
    projects,
  ]);
  const viewerId = isCanopyCloudConnected(automationCloudAccount)
    ? (automationCloudAccount?.account?.id ?? null)
    : null;
  const [removedShares, setRemovedShares] = useState<{
    accountId: string | null;
    keys: ReadonlySet<string>;
  }>({ accountId: null, keys: new Set() });
  const removeSharedResource = useCallback(
    (kind: MarketplaceUnshareKind, id: string): void => {
      setRemovedShares((previous) => ({
        accountId: viewerId,
        keys: new Set([
          ...(previous.accountId === viewerId ? Array.from(previous.keys) : []),
          `${kind}:${id}`,
        ]),
      }));
    },
    [viewerId],
  );
  const shareWasRemoved = useCallback(
    (kind: MarketplaceUnshareKind, id: string): boolean =>
      removedShares.accountId === viewerId &&
      removedShares.keys.has(`${kind}:${id}`),
    [viewerId, removedShares],
  );
  const contextGeneration = useWorkspaceContextStore(
    (state) => state.appliedGeneration,
  );
  const ownedEnabled =
    options.ownedAutomationSharesEnabled === true &&
    viewerId !== null &&
    canLoadCapability(automationCloudAccount, 'automations-crud-v1');
  const ownedScope = JSON.stringify([
    ownedEnabled,
    viewerId,
    query.trim(),
    contextGeneration,
    automationCloudAccount?.updatedAt,
    automationScope.context,
  ]);
  const [ownedRead, setOwnedRead] = useState<{
    scope: string;
    rows: SharedAutomationSummary[];
    loading: boolean;
    error: string | null;
  }>({ scope: '', rows: [], loading: false, error: null });
  // Public-link changes and the page's Retry re-read the viewer's own shares;
  // the scope alone never changes when a link is revoked.
  const [ownedRefresh, setOwnedRefresh] = useState(0);
  const refreshOwnedShares = useCallback((): void => {
    setOwnedRefresh((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!ownedEnabled) return undefined;
    window.addEventListener(
      AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT,
      refreshOwnedShares,
    );
    return (): void =>
      window.removeEventListener(
        AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT,
        refreshOwnedShares,
      );
  }, [ownedEnabled, refreshOwnedShares]);
  useEffect(() => {
    let cancelled = false;
    if (!ownedEnabled) return undefined;
    // A refresh in the same scope keeps the listed rows until it answers.
    setOwnedRead((previous) => ({
      scope: ownedScope,
      rows: previous.scope === ownedScope ? previous.rows : [],
      loading: true,
      error: null,
    }));
    void (async (): Promise<void> => {
      const rows = new Map<string, SharedAutomationSummary>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      try {
        do {
          const response = await window.api.automations.listShared({
            createdBy: 'me',
            query: query.trim() || undefined,
            limit: 25,
            ...(cursor ? { cursor } : {}),
          });
          if (cancelled) return;
          for (const row of response.automations) rows.set(row.id, row);
          cursor = response.nextCursor ?? undefined;
          if (cursor && seenCursors.has(cursor))
            throw new Error(
              'Couldn’t load more shared automations. Try again.',
            );
          if (cursor) seenCursors.add(cursor);
        } while (cursor);
        setOwnedRead({
          scope: ownedScope,
          rows: Array.from(rows.values()),
          loading: false,
          error: null,
        });
      } catch (error: unknown) {
        if (!cancelled)
          setOwnedRead({
            scope: ownedScope,
            rows: Array.from(rows.values()),
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [ownedEnabled, ownedScope, ownedRefresh, query]);
  // A scope mismatch is hidden synchronously, before the next effect runs.
  const ownedRows = useMemo(
    () =>
      ownedEnabled && ownedRead.scope === ownedScope ? ownedRead.rows : [],
    [ownedEnabled, ownedRead, ownedScope],
  );
  const ownedSharesLoading =
    automationCloudLoading ||
    (ownedEnabled && (ownedRead.scope !== ownedScope || ownedRead.loading));
  const sharedAutomations = useMemo(
    () =>
      Array.from(
        new Map(
          [
            ...sharedAutomationRows.filter(
              (row) => row.shareScope !== 'private',
            ),
            ...ownedRows.filter(
              (row) =>
                row.createdBy?.id === viewerId &&
                (row.shareScope !== 'private' || !!row.publicShare),
            ),
          ].map((row) => [row.id, row]),
        ).values(),
      ).filter(automationScope.shareInContext),
    [sharedAutomationRows, ownedRows, viewerId, automationScope],
  );

  // Local agents live in the shared renderer store; this hook owns their
  // hydration and `agents:changed` / context subscriptions while enabled, so
  // the page adds none of its own. The store discards a response from a
  // context the user has since left.
  const localAgentsEnabled = options.localAgentsEnabled === true;
  const agentDefinitions = useAgentsStore((state) => state.agents);
  const agentsLoading = useAgentsStore((state) => state.loading);
  const agentsLoaded = useAgentsStore((state) => state.loaded);
  const agentsError = useAgentsStore((state) => state.error);
  const agentInventoryGeneration = useAgentsStore(
    (state) => state.inventoryGeneration,
  );
  const orgProjectsEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const loadAgents = useAgentsStore((state) => state.load);
  const subscribeAgents = useAgentsStore((state) => state.subscribe);
  useEffect(() => {
    if (!localAgentsEnabled) return undefined;
    void loadAgents();
    return subscribeAgents();
  }, [loadAgents, localAgentsEnabled, subscribeAgents]);
  const localAgentContextCurrent =
    !orgProjectsEnabled || agentInventoryGeneration === contextGeneration;
  const localAgentDefinitions = useMemo(
    () =>
      localAgentsEnabled && localAgentContextCurrent ? agentDefinitions : [],
    [agentDefinitions, localAgentsEnabled, localAgentContextCurrent],
  );
  const localAgents = useMemo(
    () => marketplaceLocalAgentInputs(localAgentDefinitions),
    [localAgentDefinitions],
  );

  // Agents and plugin references ride on the account the automation list
  // already loaded, so they add no account read of their own. Like shared
  // automations, a personal (`private`) cloud copy is not a share with anyone.
  const sharedMarketplaceShares = useSharedMarketplaceShares({
    account: automationCloudAccount,
    agents: options.sharedAgentsEnabled === true,
    plugins: options.sharedPluginsEnabled === true,
    templates: options.sharedBlueprintsEnabled === true,
    query,
  });
  // The catalog and owned lanes page independently; the owned lane keeps
  // the viewer's shares available when the catalog reaches its page cap.
  const ownedAgentShares = useSharedMarketplaceShares({
    account: automationCloudAccount,
    agents:
      options.sharedAgentsEnabled === true &&
      options.ownedAgentSharesEnabled === true &&
      viewerId !== null,
    plugins: false,
    query,
    createdBy: 'me',
  });
  const sharedAgents = useMemo(
    () =>
      Array.from(
        new Map(
          [
            ...sharedMarketplaceShares.sharedAgents,
            ...ownedAgentShares.sharedAgents,
          ].map((agent) => [agent.id, agent]),
        ).values(),
      ).filter(
        (agent) =>
          agent.shareScope !== 'private' &&
          automationScope.shareInContext(agent),
      ),
    [
      automationScope,
      sharedMarketplaceShares.sharedAgents,
      ownedAgentShares.sharedAgents,
    ],
  );
  // Named scopes rather than "not private": plugin ownership is new on the
  // wire, so a cloud that predates it answers with the caller's own rows and
  // no `shareScope` or `createdBy`. Those are not shares with anyone, and a
  // shared entry reads both fields.
  const sharedPlugins = useMemo(
    () =>
      sharedMarketplaceShares.sharedPlugins.filter(
        (plugin) =>
          (plugin.shareScope === 'team' ||
            plugin.shareScope === 'organization') &&
          automationScope.shareInContext(plugin),
      ),
    [automationScope, sharedMarketplaceShares.sharedPlugins],
  );
  const sharedBlueprints = useMemo(
    () =>
      sharedMarketplaceShares.sharedBlueprints.filter(
        (template) =>
          template.audience !== 'PUBLIC' &&
          automationScope.shareInContext({
            owner: template.owner,
          }),
      ),
    [automationScope, sharedMarketplaceShares.sharedBlueprints],
  );

  const curatedAutomations = useCuratedAutomations({
    q: query,
    enabled:
      options.curatedAutomationsEnabled !== false &&
      canLoadCapability(automationCloudAccount, 'automation-catalog-v1'),
  });

  const [resolvedAutomationSourceHashes, setResolvedAutomationSourceHashes] =
    useState<ReadonlyMap<string, string>>(() => new Map());
  const automationSources = installedAutomationSources(baseLocalAutomations);
  const automationSourcesRef = useRef(automationSources);
  automationSourcesRef.current = automationSources;
  const automationSourcesKey = JSON.stringify(automationSources);
  const canLoadSharedAutomations = canLoadCapability(
    automationCloudAccount,
    'automations-crud-v1',
  );
  const canLoadCuratedAutomations = canLoadCapability(
    automationCloudAccount,
    'automation-catalog-v1',
  );
  const automationCloudAccountId = automationCloudAccount?.account?.id;

  // Installed-source freshness is independent of browse pagination. Resolve
  // each source directly so the local row can show an update on the All tab
  // and while a Marketplace query is active.
  useEffect(() => {
    let cancelled = false;
    const resolved = new Map<string, string>();
    const requests: Promise<void>[] = [];
    setResolvedAutomationSourceHashes(new Map());

    for (const source of automationSourcesRef.current) {
      const key = automationSourceKey(source.sourceKind, source.remoteId);
      if (source.sourceKind === 'shared' && !canLoadSharedAutomations) {
        continue;
      }
      if (source.sourceKind === 'curated' && !canLoadCuratedAutomations) {
        continue;
      }
      requests.push(
        (source.sourceKind === 'curated'
          ? window.api.automations.getCurated(source.remoteId)
          : window.api.automations.getShared(source.remoteId)
        )
          .then((detail) => {
            resolved.set(key, detail.contentHash);
          })
          .catch(() => undefined),
      );
    }

    void Promise.all(requests).then(() => {
      if (!cancelled) setResolvedAutomationSourceHashes(resolved);
    });
    return (): void => {
      cancelled = true;
    };
  }, [
    automationCloudAccountId,
    automationSourcesKey,
    canLoadCuratedAutomations,
    canLoadSharedAutomations,
  ]);

  const contextLocalAutomations = useMemo(
    () =>
      baseLocalAutomations.map((automation) => {
        const installedFrom = automation.installedFrom;
        if (!installedFrom) return automation;
        const sourceKind = installedFrom.sourceKind ?? 'shared';
        if (sourceKind === 'public') return automation;
        const key = automationSourceKey(sourceKind, installedFrom.remoteId);
        const sourceContentHash = resolvedAutomationSourceHashes.get(key);
        return sourceContentHash
          ? { ...automation, sourceContentHash }
          : automation;
      }),
    [baseLocalAutomations, resolvedAutomationSourceHashes],
  );
  const localAutomations = contextLocalAutomations;

  const curatedReady =
    options.curatedEnabled !== false &&
    isCanopyCloudConnected(pipelineCloudAccount);
  const curated = useCuratedPipelines({
    q: query,
    category: options.category,
    triggerType: options.triggerType,
    scope: options.scope,
    enabled: curatedReady,
    onImported: () => {
      void refreshLocalPipelines();
    },
  });

  const refreshPipelines = useCallback(async (): Promise<void> => {
    await Promise.all([
      refreshLocalPipelines(),
      ...(canLoadCapability(pipelineCloudAccount, 'pipelines-crud-v1')
        ? [refreshSharedList()]
        : []),
    ]);
  }, [pipelineCloudAccount, refreshLocalPipelines, refreshSharedList]);

  const normalizedQuery = query.trim() || undefined;
  useEffect(() => {
    setSharedFilters({ q: normalizedQuery, triggerType: options.triggerType });
    setSharedSkillFilters({ q: normalizedQuery });
    setSharedCollectionFilters({ q: normalizedQuery });
    setSharedAutomationFilters({ q: normalizedQuery });
  }, [
    normalizedQuery,
    options.triggerType,
    setSharedAutomationFilters,
    setSharedCollectionFilters,
    setSharedFilters,
    setSharedSkillFilters,
  ]);

  useEffect(() => {
    if (
      !automationCloudLoading &&
      !sharedAutomationsLoaded &&
      !sharedAutomationsLoading &&
      canLoadCapability(automationCloudAccount, 'automations-crud-v1')
    ) {
      void refreshSharedAutomations();
    }
  }, [
    automationCloudAccount,
    automationCloudLoading,
    refreshSharedAutomations,
    sharedAutomationsLoaded,
    sharedAutomationsLoading,
  ]);

  useEffect(() => {
    if (
      !pipelineCloudLoading &&
      !sharedPipelinesLoaded &&
      !sharedPipelinesLoading &&
      canLoadCapability(pipelineCloudAccount, 'pipelines-crud-v1')
    ) {
      void refreshSharedList();
    }
  }, [
    pipelineCloudAccount,
    pipelineCloudLoading,
    refreshSharedList,
    sharedPipelinesLoaded,
    sharedPipelinesLoading,
  ]);

  useEffect(() => {
    if (
      !skillCloudLoading &&
      !sharedSkillsLoaded &&
      !sharedSkillsLoading &&
      canLoadCapability(skillCloudAccount, 'skills-crud-v1')
    ) {
      void refreshSharedSkills();
    }
  }, [
    refreshSharedSkills,
    sharedSkillsLoaded,
    sharedSkillsLoading,
    skillCloudAccount,
    skillCloudLoading,
  ]);

  useEffect(() => {
    if (
      !collectionCloudLoading &&
      !sharedCollectionsLoaded &&
      !sharedCollectionsLoading &&
      canLoadCapability(collectionCloudAccount, 'collections-crud-v1')
    ) {
      void refreshSharedCollections();
    }
  }, [
    collectionCloudAccount,
    collectionCloudLoading,
    refreshSharedCollections,
    sharedCollectionsLoaded,
    sharedCollectionsLoading,
  ]);

  // Both sections consume one catalog; complete these otherwise unpaged lists
  // without replacing Browse with an author-filtered read.
  useEffect(() => {
    if (
      options.completeSharedCatalogs &&
      viewerId &&
      sharedSkillsLoaded &&
      !sharedSkillsLoading &&
      !sharedSkillsLoadingMore &&
      !sharedSkillsError &&
      sharedSkillNextCursor
    )
      void loadMoreSharedSkills();
  }, [
    options.completeSharedCatalogs,
    viewerId,
    sharedSkillsLoaded,
    sharedSkillsLoading,
    sharedSkillsLoadingMore,
    sharedSkillsError,
    sharedSkillNextCursor,
    loadMoreSharedSkills,
  ]);
  useEffect(() => {
    if (
      options.completeSharedCatalogs &&
      viewerId &&
      sharedCollectionsLoaded &&
      !sharedCollectionsLoading &&
      !sharedCollectionsLoadingMore &&
      !sharedCollectionsError &&
      sharedCollectionNextCursor
    )
      void loadMoreSharedCollections();
  }, [
    options.completeSharedCatalogs,
    viewerId,
    sharedCollectionsLoaded,
    sharedCollectionsLoading,
    sharedCollectionsLoadingMore,
    sharedCollectionsError,
    sharedCollectionNextCursor,
    loadMoreSharedCollections,
  ]);

  const loadErrors = (
    [
      [
        'Your shared automations',
        ownedEnabled && ownedRead.scope === ownedScope ? ownedRead.error : null,
      ],
      ['Workflows', pipelinesError],
      ['Shared workflows', sharedPipelinesError],
      ['Collections', collectionsError],
      ['Shared skills', sharedSkillsError],
      ['Shared collections', sharedCollectionsError],
      ['Automations', automationsError],
      ['Shared automations', sharedAutomationsError],
      ['Shared agents', sharedMarketplaceShares.agentsError],
      ['Your shared agents', ownedAgentShares.agentsError],
      ['Shared plugins', sharedMarketplaceShares.pluginsError],
      ['Shared project templates', sharedMarketplaceShares.templatesError],
    ] as const
  ).flatMap(([source, message]): SourceLoadError[] =>
    message ? [{ source, message }] : [],
  );

  // Keep projections stable between inventory updates. PluginsPage retains
  // its selected entry in state; new arrays here would rebuild that entry on
  // every render and make the retention effect schedule another render.
  const marketplacePipelines = useMemo(
    () => [
      ...pipelines.filter((pipeline) => pipeline.source !== 'curated'),
      ...sharedPipelineRows,
    ],
    [pipelines, sharedPipelineRows],
  );
  const visibleSharedSkills = useMemo(
    () => sharedSkillRows.filter((row) => !shareWasRemoved('skill', row.id)),
    [sharedSkillRows, shareWasRemoved],
  );
  const visibleSharedCollections = useMemo(
    () =>
      sharedCollectionRows.filter(
        (row) => !shareWasRemoved('collection', row.id),
      ),
    [sharedCollectionRows, shareWasRemoved],
  );
  const visibleSharedAgents = useMemo(
    () => sharedAgents.filter((row) => !shareWasRemoved('agent', row.id)),
    [sharedAgents, shareWasRemoved],
  );
  const visibleSharedPlugins = useMemo(
    () =>
      sharedPlugins.filter((row) => !shareWasRemoved('plugin', row.externalId)),
    [sharedPlugins, shareWasRemoved],
  );
  const ownSharedPlugins = useMemo(
    () =>
      sharedMarketplaceShares.sharedPlugins.filter(
        (plugin) =>
          plugin.canDelete === true &&
          !shareWasRemoved('plugin', plugin.externalId) &&
          // A link-only share is the owner's own, not an organization's, so
          // no selected-context rule applies to it.
          ((plugin.shareScope === 'private' && !!plugin.publicShare) ||
            ((plugin.shareScope === 'team' ||
              plugin.shareScope === 'organization') &&
              automationScope.shareInContext(plugin))),
      ),
    [automationScope, sharedMarketplaceShares.sharedPlugins, shareWasRemoved],
  );

  return {
    removeSharedResource,
    ownershipAccountReady: viewerId !== null,
    viewerId,
    skillCloudAccount,
    ownedSharesLoading,
    refreshOwnedShares,
    installedInventory:
      pipelinesError || collectionsError || automationsError
        ? 'error'
        : pipelinesLoading || collectionsLoading || automationsLoading
          ? 'loading'
          : 'ready',
    pipelines: marketplacePipelines,
    curated,
    curatedReady,
    loadMoreSharedPipelines: loadMoreShared,
    sharedPipelineNextCursor,
    sharedPipelinesLoadingMore,
    localCollections,
    sharedSkills: visibleSharedSkills,
    sharedCollections: visibleSharedCollections,
    localAutomations,
    automationActivities,
    sharedAutomations,
    curatedAutomations,
    loadMoreSharedAutomations,
    sharedAutomationNextCursor,
    sharedAutomationsLoadingMore,
    localAgents,
    localAgentDefinitions,
    localAgentsLoading:
      localAgentsEnabled &&
      (!localAgentContextCurrent || agentsLoading || !agentsLoaded),
    localAgentsLoaded:
      localAgentsEnabled && localAgentContextCurrent && agentsLoaded,
    localAgentsError:
      localAgentsEnabled && localAgentContextCurrent ? agentsError : null,
    refreshLocalAgents: loadAgents,
    refreshSharedAgents: sharedMarketplaceShares.refreshAgents,
    sharedAgents: visibleSharedAgents,
    sharedPlugins: visibleSharedPlugins,
    ownSharedPlugins,
    sharedBlueprints,
    loading:
      (options.completeSharedCatalogs === true &&
        (sharedSkillsLoadingMore || sharedCollectionsLoadingMore)) ||
      ownedSharesLoading ||
      sharedMarketplaceShares.loading ||
      ownedAgentShares.loading ||
      curated.loading ||
      curatedAutomations.loading ||
      automationsLoading ||
      sharedAutomationsLoading ||
      pipelinesLoading ||
      collectionsLoading ||
      sharedPipelinesLoading ||
      sharedSkillsLoading ||
      sharedCollectionsLoading,
    error:
      loadErrors
        .map(({ source, message }) => `${source}: ${message}`)
        .join('\n') || null,
    loadErrors,
    refreshLocalCollections,
    refreshPipelines,
    disabledPipelineIds,
    setPipelineEnabled,
    deletePipeline,
    deleteSharedPipeline,
    refreshSharedSkills,
    refreshSharedCollections,
  };
}

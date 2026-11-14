import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
  type JSX,
  type ReactNode,
} from 'react';
import { useAccountProxyStatus } from '@/stores/accountProxyStore';
import { useAutomationScope } from '@/hooks/useAutomationScope';
import type {
  ChatSearchCatalogEntry,
  ChatSearchResult,
} from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  SearchPalette,
  parseSearchPaletteQuery,
  type SearchPaletteActivation,
  type SearchPaletteScopeId,
} from '@canopy/ui-app/search-palette';
import { ProjectIcon } from '@/components/shared/ProjectIcon';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useShallow } from 'zustand/shallow';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useActivityStore } from '@/stores/activityStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';
import {
  makeWorktreePanelKey,
  usePanelLayoutViewModel,
} from '@/stores/panelLayoutStore';
import { usePipelineList } from '@/hooks/usePipelineList';
import { useMarketplaceList } from '@/hooks/useMarketplaceList';
import { useSkillList } from '@/hooks/useSkillList';
import { useCodeGraphExperimentEnabled } from '@/hooks/useCodeGraphExperimentEnabled';
import { getVisibleNavItems } from '@/components/settings/SettingsNav';
import { useHostedSettingsAvailable } from '@/components/settings/hosted/hosted-settings-availability';
import { useIsPageAvailable } from '@/lib/navigation/page-availability';
import { visibleAccountNavItems } from '@canopy/ui-app/settings/navigation';
import {
  buildBaseCommands,
  buildContextSwitchCommands,
  buildOrganizationPageCommands,
  buildPanelCommands,
  buildProjectCommands,
  comparePaletteCommands,
} from './paletteCommands';
import {
  buildAccountOrganizationPageItems,
  buildAgentItems,
  buildArchivedContainerItems,
  buildAutomationItems,
  buildChatContentItems,
  buildChatItems,
  buildCommandItems,
  buildPipelineItems,
  buildPlanItems,
  buildPluginItems,
  buildSettingItems,
  buildSkillItems,
  buildWatcherItems,
  buildWorktreeItems,
  buildWorktreeLabelIndex,
  type AccountOrganizationPageEntry,
  type SettingsSectionEntry,
  type WorktreeLabelResolver,
} from './paletteProviders';
import type { PaletteItem } from './paletteItems';
import { usePaletteAccountFacts } from './usePaletteAccountFacts';
import { useContextScopedWorkspaces } from '@/hooks/useContextScopedWorkspaces';

interface CommandPaletteProps {
  initialQuery: string;
  onClose: () => void;
}

/** Debounce before firing the deferred tier-2 transcript query (ms). */
const TIER2_DEBOUNCE_MS = 200;
/** Minimum query length before hitting the transcript FTS index. */
const TIER2_MIN_QUERY_LENGTH = 2;

export function CommandPalette({
  initialQuery,
  onClose,
}: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState(initialQuery);
  const [scope, setScope] = useState<SearchPaletteScopeId>('all');
  const [catalogEntries, setCatalogEntries] = useState<
    ChatSearchCatalogEntry[]
  >([]);
  const [contentResults, setContentResults] = useState<ChatSearchResult[]>([]);
  // Bumped for every debounced `chatSearch.onUpdated` broadcast so the
  // query-independent tier-1 catalog cannot miss an update while the user is
  // typing.
  const [catalogRefreshNonce, setCatalogRefreshNonce] = useState(0);
  // Bumped only when the query remains stable across the update debounce,
  // preserving settled tier-2 rows without reissuing stale query work.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const queryTokenRef = useRef(0);
  const queryRef = useRef(query);
  const queryRevisionRef = useRef(0);
  if (queryRef.current !== query) {
    queryRef.current = query;
    queryRevisionRef.current += 1;
  }

  // --- Tier-0 sources (renderer stores/hooks) ----------------------------
  const {
    workspaces: projects,
    linkedPersonalWorkspaceIds,
    isInContext,
  } = useContextScopedWorkspaces();
  const linkedPersonalWorkspaceKey = linkedPersonalWorkspaceIds.join('\n');
  const repoBranches = useProjectsStore((state) => state.repoBranches);
  const allWorktreeChats = useChatStore((state) => state.worktreeChats);
  const worktreeChats = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(allWorktreeChats).filter(([key]) =>
          isInContext(key.slice(0, key.indexOf('/'))),
        ),
      ),
    [allWorktreeChats, isInContext],
  );
  const scopedCatalogEntries = useMemo(
    () => catalogEntries.filter((entry) => isInContext(entry.projectId)),
    [catalogEntries, isInContext],
  );
  const scopedContentResults = useMemo(
    () => contentResults.filter((entry) => isInContext(entry.projectId)),
    [contentResults, isInContext],
  );
  const selectedWorktree = useChatStore((state) => state.selectedWorktree);
  const allActivities = useAutomationsStore((state) => state.activities);
  const allWatchers = useAppAdvisorWatchersStore((state) => state.watchers);
  // Automations and watchers follow the selected context, like the
  // Automations page (CAN-3448).
  const automationScope = useAutomationScope();
  const activities = useMemo(
    () => allActivities.filter(automationScope.inContext),
    [allActivities, automationScope],
  );
  const watchers = useMemo(
    () => allWatchers.filter(automationScope.watcherInContext),
    [allWatchers, automationScope],
  );
  const agents = useAgentsStore((state) => state.agents);
  const worktreeSummaries = useActivityStore(
    (state) => state.worktreeSummaries,
  );
  const getBranchDisplayName = useBranchDisplayStore(
    (state) => state.getDisplayName,
  );
  const branchMappingsVersion = useBranchDisplayStore(
    (state) => state.mappingsVersion,
  );
  // Agent items open in the Marketplace Agents tab (CAN-4266), so they
  // follow the Agents flag and the Marketplace's availability.
  const sharedCustomAgentsEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key),
  );
  const agentsAvailable =
    useIsPageAvailable('plugins') && sharedCustomAgentsEnabled;
  const overviewPageAvailable = useIsPageAvailable('overview');
  const auditPageAvailable = useIsPageAvailable('audit');
  const statisticsPageAvailable = useIsPageAvailable('statistics');
  const orgProjectsEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const workspaceContext = useWorkspaceContextStore(
    useShallow((store) => ({
      context: store.state.context,
      organizations: store.state.organizations,
      setContext: store.setContext,
      hydrated: store.hydrated,
    })),
  );
  const workspaceContextKey =
    workspaceContext.context.kind === 'personal'
      ? 'personal'
      : `org:${workspaceContext.context.organizationId}`;
  const codeGraphEnabled = useCodeGraphExperimentEnabled();
  const { pipelines } = usePipelineList();
  const { cache: marketplaceCache } = useMarketplaceList();
  const { skills } = useSkillList();

  const panelWorktreeKey =
    selectedWorktree && !isCoworkChatTarget(selectedWorktree.projectId)
      ? makeWorktreePanelKey(
          selectedWorktree.projectId,
          selectedWorktree.worktreeId,
        )
      : null;
  const panelViewModel = usePanelLayoutViewModel(panelWorktreeKey);

  // Lazily hydrate the stores that don't self-fetch on mount so the palette is
  // populated even if the user never visited those pages this session.
  useEffect(() => {
    void useAutomationsStore.getState().hydrate();
    void useAppAdvisorWatchersStore.getState().hydrate();
    if (agentsAvailable) {
      void useAgentsStore.getState().load();
    }
  }, [agentsAvailable]);

  // Tier 1: fetch the chat catalog on open and again whenever the backend
  // signals an index change (`refreshNonce`).
  useEffect(() => {
    let cancelled = false;
    const request =
      linkedPersonalWorkspaceIds.length > 0
        ? window.api.chatSearch.catalog({
            linkedPersonalWorkspaceIds: [...linkedPersonalWorkspaceIds],
          })
        : window.api.chatSearch.catalog();
    void request
      .then((response) => {
        if (!cancelled) {
          setCatalogEntries(response.entries);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogEntries([]);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    catalogRefreshNonce,
    workspaceContextKey,
    linkedPersonalWorkspaceKey,
    linkedPersonalWorkspaceIds,
  ]);

  // Live refresh: subscribe to the payload-less `chatSearch.onUpdated`
  // broadcast on mount. Every debounced receipt refreshes the tier-1 catalog;
  // only an unchanged query also refreshes the settled tier-2 results. This
  // fills a palette opened mid initial-scan and reflects chats created/edited
  // while it stays open. Unsubscribes on close.
  useEffect(() => {
    if (typeof window.api.chatSearch.onUpdated !== 'function') {
      return undefined;
    }
    let handle: number | undefined;
    const unsubscribe = window.api.chatSearch.onUpdated(() => {
      const stableQuery = queryRef.current;
      const stableQueryRevision = queryRevisionRef.current;
      if (handle !== undefined) {
        window.clearTimeout(handle);
      }
      handle = window.setTimeout(() => {
        setCatalogRefreshNonce((nonce) => nonce + 1);
        if (
          queryRef.current === stableQuery &&
          queryRevisionRef.current === stableQueryRevision
        ) {
          setRefreshNonce((nonce) => nonce + 1);
        }
      }, TIER2_DEBOUNCE_MS);
    });
    return (): void => {
      if (handle !== undefined) {
        window.clearTimeout(handle);
      }
      unsubscribe();
    };
  }, []);

  const hostedLayout = useHostedSettingsAvailable();
  const accountFacts = usePaletteAccountFacts(hostedLayout);
  const billingEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyBillingEnabled.key),
  );
  const digestsEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDigestsEnabled.key),
  );

  // Page availability is subscribed above, so the command list rebuilds when
  // a page is switched on or off while the palette is open.
  const commands = useMemo(() => {
    const baseCommands = buildBaseCommands(selectedWorktree);
    const projectCommands = buildProjectCommands(projects);
    const panelCommands = buildPanelCommands(selectedWorktree, panelViewModel);
    const contextCommands = buildContextSwitchCommands(
      orgProjectsEnabled,
      workspaceContext,
      workspaceContext.setContext,
    );
    // The selected context's organization pages, once the context is known.
    const organizationPageCommands = buildOrganizationPageCommands(
      hostedLayout && workspaceContext.hydrated,
      workspaceContext,
      accountFacts.personalOrganizationId,
    );
    return [
      ...baseCommands,
      ...projectCommands,
      ...panelCommands,
      ...contextCommands,
      ...organizationPageCommands,
    ].sort(comparePaletteCommands);
    // The Labs page commands read the policy inside `buildBaseCommands`;
    // these are their invalidation keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    overviewPageAvailable,
    auditPageAvailable,
    statisticsPageAvailable,
    projects,
    selectedWorktree,
    panelViewModel,
    orgProjectsEnabled,
    workspaceContext,
    hostedLayout,
    accountFacts.personalOrganizationId,
  ]);

  const accountProxyAvailable = useAccountProxyStatus()?.available === true;
  const settingSections = useMemo(() => {
    const sections: SettingsSectionEntry[] = getVisibleNavItems(
      window.platform,
      true,
      codeGraphEnabled,
      accountProxyAvailable,
      false,
      { hostedLayout },
    ).map((item) => ({
      key: item.key,
      label: item.label,
    }));
    // The hosted rail has no Notifications row, but the entry stays: the
    // overlay redirects `openSettings('notifications')` to the hosted page.
    if (hostedLayout) {
      sections.push({ key: 'notifications', label: 'Notifications' });
    }
    return sections;
  }, [codeGraphEnabled, accountProxyAvailable, hostedLayout]);

  // The hosted account pages, with the rail's flag gating (Integrations is
  // always listed on desktop), and the Organizations list. A page whose name
  // a local section above already carries (Notifications) stays one entry.
  const accountPageEntries = useMemo((): AccountOrganizationPageEntry[] => {
    if (!hostedLayout) return [];
    const sectionLabels = new Set(
      settingSections.map((section) => section.label.toLowerCase()),
    );
    const accountPages: AccountOrganizationPageEntry[] = visibleAccountNavItems(
      {
        billingEnabled,
        digestsEnabled,
        integrationsEnabled: true,
        freeAccess: accountFacts.freeAccess,
      },
    ).flatMap((item) =>
      // External agents is a hosted web page, not a settings route.
      item.key === 'externalAgents'
        ? []
        : [{ route: { scope: 'account', page: item.key }, label: item.label }],
    );
    const organizationsPage: AccountOrganizationPageEntry = {
      route: { scope: 'organizations' },
      label: 'Organizations',
    };
    return [...accountPages, organizationsPage].filter(
      (entry) => !sectionLabels.has(entry.label.toLowerCase()),
    );
  }, [
    hostedLayout,
    settingSections,
    billingEnabled,
    digestsEnabled,
    accountFacts.freeAccess,
  ]);

  const resolveWorktreeLabel = useCallback<WorktreeLabelResolver>(
    (worktree, project): string => {
      if (worktree.label?.trim()) {
        return worktree.label.trim();
      }
      const worktreeRepoBranches = repoBranches[`${project.id}/${worktree.id}`];
      const uniqueBranches =
        worktreeRepoBranches && worktreeRepoBranches.length > 0
          ? new Set(worktreeRepoBranches.map((repoBranch) => repoBranch.branch))
          : null;
      const hasMultipleBranches =
        uniqueBranches !== null && uniqueBranches.size > 1;
      const rawBranch =
        project.type === 'multi-repo' &&
        uniqueBranches !== null &&
        worktreeRepoBranches
          ? hasMultipleBranches
            ? 'Multiple branches'
            : worktreeRepoBranches[0].branch
          : worktree.branchName;
      return getWorktreeBranchDisplayName({
        rawBranch,
        worktreeId: worktree.id,
        hasMultipleBranches,
        getBranchDisplayName,
      });
    },
    // getBranchDisplayName is stable, while the version invalidates its cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getBranchDisplayName, branchMappingsVersion, repoBranches],
  );

  const labelIndex = useMemo(
    () =>
      buildWorktreeLabelIndex(
        projects,
        scopedCatalogEntries,
        resolveWorktreeLabel,
      ),
    [projects, scopedCatalogEntries, resolveWorktreeLabel],
  );

  const plugins = useMemo(
    () => marketplaceCache?.marketplaces.flatMap((m) => m.plugins) ?? [],
    [marketplaceCache],
  );

  const items = useMemo<PaletteItem[]>(
    () => [
      ...buildChatItems(worktreeChats, scopedCatalogEntries, labelIndex),
      ...buildWorktreeItems(projects, worktreeSummaries, resolveWorktreeLabel),
      ...buildArchivedContainerItems(scopedCatalogEntries, labelIndex),
      ...buildPlanItems(scopedCatalogEntries, labelIndex),
      ...buildPipelineItems(pipelines),
      ...buildAutomationItems(activities),
      ...buildWatcherItems(watchers),
      ...(agentsAvailable ? buildAgentItems(agents) : []),
      ...buildPluginItems(plugins),
      ...buildSkillItems(skills),
      ...buildSettingItems(settingSections),
      ...buildAccountOrganizationPageItems(accountPageEntries),
      ...buildCommandItems(commands),
    ],
    [
      worktreeChats,
      scopedCatalogEntries,
      labelIndex,
      projects,
      worktreeSummaries,
      resolveWorktreeLabel,
      pipelines,
      activities,
      watchers,
      agentsAvailable,
      agents,
      plugins,
      skills,
      settingSections,
      accountPageEntries,
      commands,
    ],
  );

  // Tier 2 query changes clear stale rows immediately, then debounce the new
  // request. Index refreshes use a separate effect below so settled rows stay
  // mounted while the unchanged query is refreshed.
  useEffect(() => {
    const { commandsOnly, query: parsed } = parseSearchPaletteQuery(query);
    if (commandsOnly || parsed.length < TIER2_MIN_QUERY_LENGTH) {
      queryTokenRef.current += 1; // invalidate any in-flight response
      setContentResults([]);
      return;
    }
    const token = (queryTokenRef.current += 1);
    setContentResults([]);
    const handle = window.setTimeout(() => {
      void window.api.chatSearch
        .query({
          query: parsed,
          ...(linkedPersonalWorkspaceIds.length > 0
            ? {
                linkedPersonalWorkspaceIds: [...linkedPersonalWorkspaceIds],
              }
            : {}),
        })
        .then((response) => {
          if (token === queryTokenRef.current) {
            setContentResults(response.results);
          }
        })
        .catch(() => {
          if (token === queryTokenRef.current) {
            setContentResults([]);
          }
        });
    }, TIER2_DEBOUNCE_MS);
    return (): void => {
      window.clearTimeout(handle);
    };
  }, [
    query,
    workspaceContextKey,
    linkedPersonalWorkspaceKey,
    linkedPersonalWorkspaceIds,
  ]);

  useEffect(() => {
    if (refreshNonce === 0) return;
    const { commandsOnly, query: parsed } = parseSearchPaletteQuery(
      queryRef.current,
    );
    if (commandsOnly || parsed.length < TIER2_MIN_QUERY_LENGTH) return;
    const stableQuery = queryRef.current;
    const token = (queryTokenRef.current += 1);
    void window.api.chatSearch
      .query({
        query: parsed,
        ...(linkedPersonalWorkspaceIds.length > 0
          ? { linkedPersonalWorkspaceIds: [...linkedPersonalWorkspaceIds] }
          : {}),
      })
      .then((response) => {
        if (
          token === queryTokenRef.current &&
          queryRef.current === stableQuery
        ) {
          startTransition(() => setContentResults(response.results));
        }
      })
      .catch(() => {
        // A refresh failure keeps the last settled results visible. A later
        // update broadcast or user query retries from that stable state.
      });
  }, [
    refreshNonce,
    workspaceContextKey,
    linkedPersonalWorkspaceKey,
    linkedPersonalWorkspaceIds,
  ]);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  // Chat and plan content hits, minus the ones whose chat, plan or archive
  // already has a title row.
  const buildContentItems = useCallback(
    (titleRowIds: ReadonlySet<string>): readonly PaletteItem[] =>
      buildChatContentItems(scopedContentResults, labelIndex, titleRowIds),
    [scopedContentResults, labelIndex],
  );

  const activateItem = useCallback(
    (
      item: PaletteItem,
    ): Promise<SearchPaletteActivation> | SearchPaletteActivation =>
      item.execute(),
    [],
  );

  return (
    <SearchPalette
      query={query}
      onQueryChange={setQuery}
      scope={scope}
      onScopeChange={setScope}
      items={items}
      buildContentItems={buildContentItems}
      onActivate={activateItem}
      onClose={onClose}
      renderProjectBadge={renderProjectBadge}
      rowTestId={rowTestId}
    />
  );
}

// The desktop resolves a repository's owner avatar over IPC.
function renderProjectBadge(item: PaletteItem): ReactNode {
  return item.project ? (
    <ProjectIcon
      kind={item.project.kind}
      color={item.project.color}
      temporary={item.project.temporary}
      repoPath={item.project.repoPath}
    />
  ) : null;
}

// Automation pins the cost commands by their own test ids.
function rowTestId(item: PaletteItem): string | undefined {
  return item.kind === 'command' &&
    (item.navigation.commandKey === 'open-cost-panel' ||
      item.navigation.commandKey === 'open-session-breakdown')
    ? `command-palette-command-${item.navigation.commandKey}`
    : undefined;
}

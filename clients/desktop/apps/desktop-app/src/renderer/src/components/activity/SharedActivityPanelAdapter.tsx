import {
  ActivitySectionChromeContext,
  PanelSection,
} from '@/components/shared/panel-section';
import { useActivityEventSubscriptions } from '@/hooks/useActivityEventSubscriptions';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';
import {
  OPT_IN_ACTIVITY_SECTION_IDS,
  projectServesActivitySection,
  scopeServesActivitySection,
} from '@/lib/panels/scope-panel-kinds';
import { requestComposerAction } from '@/lib/composerShortcutRequests';
import { isCoworkChatTarget } from '@/lib/cowork';
import { earlyAccessTitle } from '@/lib/earlyAccessTitles';
import { usePanelHostState } from '@/lib/panels/panel-host-context';
import { isActivitySectionAllowedForAccess } from '@/lib/shared-containers/panel-allowlist';
import { useWorkspaceAccess } from '@/lib/workspace-access';
import { useActivitySectionRevealStore } from '@/stores/activitySectionRevealStore';
import { useActivityStore } from '@/stores/activityStore';
import { requestChangedFilesRefresh } from '@/stores/changedFilesRefreshRuntime';
import {
  useActiveChatTabRenderState,
  useChatStore,
  useWorktreeChatRenderState,
} from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useHooksStore } from '@/stores/hooksStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useScriptsStore } from '@/stores/scriptsStore';
import {
  DEFAULT_ACTIVITY_SECTION_ORDER,
  isActivitySectionId,
  resolveActivitySectionOrder,
} from '@canopy/desktop-shared/constants/activity';
import type {
  ActivitySectionId,
  ActivitySurface,
  WorktreeSelection,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { isActivitySectionVisibleForTarget } from '@canopy/app-state';
import type {
  PortalChatTodoProjection,
  PortalWorktreeSummaryEntity,
} from '@canopy/protocol/portal';
import {
  changedFilesHeaderHasContent,
  ActivityPanel as SharedActivityPanel,
  type ActivityPanelExtraSection,
  type ActivityPanelHostActions,
  type ActivityPanelSectionOverride,
} from '@canopy/ui-app';
import {
  HeaderActionButton,
  RefreshButton,
} from '@canopy/ui-shared/components';
import { RefreshSpinnerIcon } from '@canopy/ui-shared/icons/AppIcons';
import { formatRelativeTime } from '@canopy/ui-shared/lib';
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/shallow';
import { CloudMcpServersSectionBody } from './CloudMcpServersSection';
import {
  useCloudMcpServersHeaderChrome,
  useCloudMcpServersModel,
} from './cloud-mcp-servers-model';
import {
  getActivitySectionsForSurface,
  McpServersActivitySectionBody,
  useAttachmentsHeaderChrome,
  useCloudWorkspaceFilesHeaderChrome,
  useBackgroundProcessesHeaderChrome,
  useHooksHeaderChrome,
  useMcpServersActivityModel,
  useMcpServersHeaderChrome,
  useNotesHeaderChrome,
  usePipelineRunsHeaderChrome,
  usePlansHeaderChrome,
  usePromptsHeaderChrome,
  usePullRequestHeaderChrome,
  useScriptsHeaderChrome,
  useSummaryHeaderChrome,
  useTodoHeaderChrome,
} from './activity-sections';
import { useBackgroundProcessesSectionHostModel } from './BackgroundProcessesSection';
import { useChangedFilesSectionHostModel } from './ChangedFilesSection';
import { useChatPluginsHasContent } from './ChatPluginsSection';
import { CostActivityScopeContext } from './cost/CostActivityScopeContext';
import { CostActivityScopeHost } from './cost/CostActivityScopeHost';
import { useHooksSectionHostModel } from './HooksSection';
import {
  recallMcpSectionContent,
  rememberMcpSectionContent,
} from './mcpSectionContentMemory';
import { MemorySection } from './MemorySection';
import { SettingsGearButton } from './RunOutputControls';
import { useScriptsSectionHostModel } from './ScriptsSection';
import { useAutoExpandActivityRail } from './useAutoExpandActivityRail';

const LazyCostActivityPreviewSection = lazy(() =>
  import('./cost/CostActivityPreviewSection').then((module) => ({
    default: module.CostActivityPreviewSection,
  })),
);
const LazyCostActivityTotalLabel = lazy(() =>
  import('./cost/CostActivityHeaderParts').then((module) => ({
    default: module.CostActivityTotalLabel,
  })),
);
const LazyCostActivityRefreshAction = lazy(() =>
  import('./cost/CostActivityHeaderParts').then((module) => ({
    default: module.CostActivityRefreshAction,
  })),
);

const OUTPUT_UNLOAD_DEBOUNCE_MS = 5000;
const outputUnloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
const EMPTY_PROCESSES = [] as const;

function parseWorktreeKey(
  key: string,
): { projectId: string; worktreeId: string } | null {
  const separator = key.indexOf('/');
  if (separator <= 0 || separator === key.length - 1) return null;
  return {
    projectId: key.slice(0, separator),
    worktreeId: key.slice(separator + 1),
  };
}

function cancelOutputUnload(key: string): void {
  const timer = outputUnloadTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  outputUnloadTimers.delete(key);
}

function scheduleOutputUnload(key: string): void {
  cancelOutputUnload(key);
  outputUnloadTimers.set(
    key,
    setTimeout(() => {
      outputUnloadTimers.delete(key);
      const parsed = parseWorktreeKey(key);
      if (!parsed) return;
      useScriptsStore
        .getState()
        .unloadWorktreeRuns(parsed.projectId, parsed.worktreeId);
      useHooksStore
        .getState()
        .unloadWorktreeRuns(parsed.projectId, parsed.worktreeId);
    }, OUTPUT_UNLOAD_DEBOUNCE_MS),
  );
}

function NativeBody({ body }: { readonly body: ReactNode }): JSX.Element {
  return (
    <ActivitySectionChromeContext.Provider value="body-only">
      {body}
    </ActivitySectionChromeContext.Provider>
  );
}

const EXTRA_SECTION_IDS = new Set<ActivitySectionId>([
  'plugins',
  'memory',
  'notes',
  'prompts',
  'attachments',
  'workspace-files',
]);

/**
 * Section-container testids the Electron specs assert on. Natively these
 * lived on each section's own root and wrapped the header; with body-only
 * chrome the shared wrapper renders the header, so the wrapper carries the
 * testid and the native root suppresses its copy (see each section's
 * `chrome === 'body-only'` guard).
 */
const SECTION_CONTAINER_TEST_IDS: Partial<Record<ActivitySectionId, string>> = {
  summary: 'activity-summary-section',
  'changed-files': 'changed-files-section',
  plans: 'activity-plans-section',
  cost: 'activity-section-cost',
};

export interface SharedActivityPanelAdapterProps {
  readonly worktreeSelection?: WorktreeSelection | null;
  /** `card` renders the Activity card's overview instead of the rail. */
  readonly layout?: 'stack' | 'card';
  /** Opens a card row's section in its own panel (`card` layout only). */
  readonly onOpenCardSection?: (sectionId: string) => boolean;
}

export function SharedActivityPanelAdapter({
  worktreeSelection,
  layout = 'stack',
  onOpenCardSection,
}: SharedActivityPanelAdapterProps = {}): JSX.Element {
  useActivityEventSubscriptions();
  const storedSelection = useChatStore((state) => state.selectedWorktree);
  const selectedWorktree =
    worktreeSelection !== undefined ? worktreeSelection : storedSelection;

  // App Advisor keeps no cost. An account that bills every turn to AI
  // Credits (CAN-5028) sees the rail's cost in credits, never USD
  // (DesktopCostCurrencyProvider, CAN-6180).
  const { costInsights } = useScopeCapabilities({
    projectId: selectedWorktree?.projectId ?? '',
  });
  const costEntry =
    selectedWorktree &&
    selectedWorktree.projectId !== APP_ADVISOR_PROJECT_ID &&
    costInsights === true
      ? selectedWorktree
      : null;

  return (
    <CostActivityScopeHost
      projectId={costEntry?.projectId ?? null}
      worktreeId={costEntry?.worktreeId ?? null}
    >
      <SharedActivityPanelAdapterContents
        worktreeSelection={worktreeSelection}
        layout={layout}
        onOpenCardSection={onOpenCardSection}
      />
    </CostActivityScopeHost>
  );
}

function SharedActivityPanelAdapterContents({
  worktreeSelection,
  layout = 'stack',
  onOpenCardSection,
}: SharedActivityPanelAdapterProps = {}): JSX.Element {
  const access = useWorkspaceAccess();
  // Early access shows section names in sentence case.

  const costActivity = useContext(CostActivityScopeContext);
  const isSharedContainer =
    access.mode === 'read-only' && access.reason === 'shared-container';

  const storedSelection = useChatStore((state) => state.selectedWorktree);
  const selectedWorktree =
    worktreeSelection !== undefined ? worktreeSelection : storedSelection;
  const selectedWorktreeKey = selectedWorktree
    ? `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
    : null;

  // Ordinary worktrees are hydrated by WorktreeManager. A recipient grid is
  // page-like and does not become the app's global worktree selection, so it
  // must explicitly hydrate the standard Changed Files store for its own
  // viewer scope when mounted.
  useEffect(() => {
    if (!isSharedContainer || !selectedWorktree) {
      return;
    }
    void requestChangedFilesRefresh(
      selectedWorktree.projectId,
      selectedWorktree.worktreeId,
    ).catch(() => undefined);
  }, [isSharedContainer, selectedWorktree]);
  const lastOutputWorktreeKeyRef = useRef<string | null>(null);
  // A scope whose client implements only some sections (a cloud chat) never
  // loads the others, so none of its ids reach the local bridge.
  const scopeCapabilities = useScopeCapabilities({
    projectId: selectedWorktree?.projectId ?? '',
  });
  const loadsScripts = isActivitySectionVisibleForTarget(
    'scripts',
    undefined,
    scopeCapabilities,
  );
  const loadsHooks = isActivitySectionVisibleForTarget(
    'hooks',
    undefined,
    scopeCapabilities,
  );

  useEffect(() => {
    const previousKey = lastOutputWorktreeKeyRef.current;
    if (previousKey && previousKey !== selectedWorktreeKey) {
      scheduleOutputUnload(previousKey);
    }
    lastOutputWorktreeKeyRef.current = selectedWorktreeKey;
    if (!selectedWorktree || !selectedWorktreeKey) return;

    cancelOutputUnload(selectedWorktreeKey);
    if (loadsScripts) {
      void useScriptsStore
        .getState()
        .loadWorktreeRuns(
          selectedWorktree.projectId,
          selectedWorktree.worktreeId,
        )
        .catch(() => undefined);
    }
    if (loadsHooks) {
      void useHooksStore
        .getState()
        .loadWorktreeRuns(
          selectedWorktree.projectId,
          selectedWorktree.worktreeId,
        )
        .catch(() => undefined);
    }
    return (): void => scheduleOutputUnload(selectedWorktreeKey);
  }, [selectedWorktree, selectedWorktreeKey, loadsScripts, loadsHooks]);

  const projectId = selectedWorktree?.projectId ?? null;
  const [memoryState, setMemoryState] = useState<{
    projectId: string | null;
    empty: boolean;
  } | null>(null);
  const onMemoryEmptyChange = useCallback(
    (empty: boolean) => {
      setMemoryState((current) =>
        current?.projectId === projectId && current.empty === empty
          ? current
          : { projectId, empty },
      );
    },
    [projectId],
  );
  const memoryEmpty =
    memoryState && memoryState.projectId === projectId
      ? memoryState.empty
      : true;

  const chromeScope = {
    projectId: selectedWorktree?.projectId ?? '',
    worktreeId: selectedWorktree?.worktreeId ?? '',
  };
  const selectedChromeScope = selectedWorktree ? chromeScope : undefined;
  const worktreeKey = `${chromeScope.projectId}/${chromeScope.worktreeId}`;
  const summary = useActivityStore(
    (state) => state.worktreeSummaries[worktreeKey],
  );
  const summaryGenerating = useActivityStore(
    (state) => state.summaryGenerating[worktreeKey] === true,
  );
  const sectionExpandRequests = useActivitySectionRevealStore(
    (state) => state.expandRequests[worktreeKey],
  );
  const worktreeSummaryEnabled = useActivityStore(
    (state) => state.worktreeSummaryEnabled,
  );
  const refreshWorktreeSummary = useActivityStore(
    (state) => state.refreshWorktreeSummary,
  );
  const activeChatTabId = useWorktreeChatRenderState(
    worktreeKey,
    (chat) => chat?.activeTabId,
  );
  const activeChatTab = useActiveChatTabRenderState(
    worktreeKey,
    useShallow(({ tab }) => ({
      readOnly: tab?.readOnly,
      status: tab?.status,
      currentTodos: tab?.currentTodos,
      currentTaskTodos: tab?.currentTaskTodos,
    })),
  );
  const activeChat = useMemo(
    () => ({ activeTabId: activeChatTabId, ...activeChatTab }),
    [activeChatTabId, activeChatTab],
  );
  const worktreeSummaries = useMemo<
    readonly PortalWorktreeSummaryEntity[]
  >(() => {
    if (!selectedWorktree || !summary) return [];
    return [
      {
        localId: selectedWorktree.worktreeId,
        workspaceLocalId: selectedWorktree.projectId,
        worktreeLocalId: selectedWorktree.worktreeId,
        title: summary.title,
        description: summary.description,
        highlights: summary.highlights,
        repos: summary.repos,
        generatedAt: summary.generatedAt,
        lastFullRefreshAt: summary.lastFullRefreshAt,
        generating: summaryGenerating,
      },
    ];
  }, [selectedWorktree, summary, summaryGenerating]);
  const todoLists = useMemo<readonly PortalChatTodoProjection[]>(() => {
    if (!selectedWorktree || !activeChat.activeTabId) return [];
    // Only ordinary todos get the `todo:` prefix: task todos already carry
    // globally unique ids, and the prefix keeps the two lists collision-free
    // when merged (matching the native TodoSection projection).
    const ordinaryTodos = (activeChat.currentTodos ?? []).map((item) => ({
      ...item,
      id: `todo:${item.id}`,
    }));
    return [
      {
        localId: activeChat.activeTabId,
        workspaceLocalId: selectedWorktree.projectId,
        worktreeLocalId: selectedWorktree.worktreeId,
        chatId: activeChat.activeTabId,
        items: [...ordinaryTodos, ...(activeChat.currentTaskTodos ?? [])],
      },
    ];
  }, [activeChat, selectedWorktree]);
  const hostActions = useMemo<ActivityPanelHostActions>(
    () => ({
      onRefreshSummary: (): void => {
        if (!selectedWorktree) return;
        void refreshWorktreeSummary(
          selectedWorktree.projectId,
          selectedWorktree.worktreeId,
        );
      },
    }),
    [refreshWorktreeSummary, selectedWorktree],
  );
  const processes = useActivityStore(
    (state) => state.bgProcesses[worktreeKey] ?? EMPTY_PROCESSES,
  );
  const backgroundTasksSection = useBackgroundProcessesSectionHostModel({
    ...chromeScope,
    processes,
  });
  const detectedMcp = useMcpServersActivityModel(chromeScope);
  const mcpDetectedContent =
    detectedMcp.notice !== undefined ||
    detectedMcp.error != null ||
    detectedMcp.servers.length > 0 ||
    (detectedMcp.warnings?.length ?? 0) > 0;
  useEffect(() => {
    if (detectedMcp.initializing) return;
    rememberMcpSectionContent(worktreeKey, mcpDetectedContent);
  }, [detectedMcp.initializing, mcpDetectedContent, worktreeKey]);
  // Detection restarts on every switch. Hold the last known answer until it
  // lands so the section neither flashes in empty nor offers "Add MCP server"
  // early; with nothing known yet, assume content.
  // A cloud task's servers come from its web core catalog (CAN-6608).
  const cloudMcp = useCloudMcpServersModel(chromeScope);
  const mcpHasContent = cloudMcp.active
    ? cloudMcp.loading || cloudMcp.servers.length > 0 || cloudMcp.error !== null
    : detectedMcp.initializing
      ? (recallMcpSectionContent(worktreeKey) ?? true)
      : mcpDetectedContent;
  const mcpRefreshAction = (
    <RefreshButton
      onClick={(): void => {
        void (cloudMcp.active ? cloudMcp.refresh() : detectedMcp.refresh());
      }}
      busy={cloudMcp.active ? cloudMcp.loading : detectedMcp.loading}
      ariaLabel="Refresh MCP servers"
      dataTestId="mcp-servers-card-refresh"
    />
  );
  const scriptsSection = useScriptsSectionHostModel(chromeScope);
  // headerSubtitle/totalFileCount are already derived from the host model's
  // single label-filter pass and become the shared rail's header chrome.
  const {
    headerAction: changedFilesHeaderAction,
    headerSubtitle: changedFilesHeaderSubtitle,
    totalFileCount: changedFilesTotalFileCount,
    ...changedFilesSection
  } = useChangedFilesSectionHostModel(chromeScope);
  // hasProject/headerAction are desktop-only model fields: the shared rail
  // renders section chrome itself, so strip them before the ActivityPanel
  // prop and merge the pause-all control into this adapter's header chrome.
  const {
    hasProject: _hooksHasProject,
    headerAction: hooksPauseAllAction,
    ...hooksSection
  } = useHooksSectionHostModel(chromeScope);
  void _hooksHasProject;
  const { onOpenSettingsTab } = usePanelHostState();
  const scriptsHeaderAction = onOpenSettingsTab ? (
    <SettingsGearButton
      onClick={(): void => onOpenSettingsTab('scripts')}
      label="Open scripts settings"
    />
  ) : null;
  const hooksGearAction = onOpenSettingsTab ? (
    <SettingsGearButton
      onClick={(): void => onOpenSettingsTab('hooks')}
      label="Open hooks settings"
    />
  ) : null;
  const hooksHeaderAction =
    hooksPauseAllAction || hooksGearAction ? (
      <div className="flex items-center gap-0.5">
        {hooksPauseAllAction}
        {hooksGearAction}
      </div>
    ) : null;
  const costHeaderSubtitle =
    costActivity !== null && costActivity.value !== null ? (
      <Suspense fallback={null}>
        <LazyCostActivityTotalLabel store={costActivity.store} />
      </Suspense>
    ) : null;
  const localMcpChrome = useMcpServersHeaderChrome(detectedMcp);
  const cloudMcpChrome = useCloudMcpServersHeaderChrome(cloudMcp);
  const headerChrome = {
    summary: useSummaryHeaderChrome(selectedChromeScope),
    'changed-files': {
      subtitle: changedFilesHeaderSubtitle,
      collapsedIconColor:
        (changedFilesTotalFileCount ?? 0) > 0 ? 'amber' : 'muted',
    },
    'pull-request': usePullRequestHeaderChrome(chromeScope),
    'background-processes': useBackgroundProcessesHeaderChrome(processes),
    'mcp-servers': cloudMcp.active ? cloudMcpChrome : localMcpChrome,
    plans: usePlansHeaderChrome(selectedChromeScope),
    'pipeline-runs': usePipelineRunsHeaderChrome(selectedChromeScope),
    cost: {
      subtitle: costHeaderSubtitle,
      collapsedIconColor: costActivity?.hasContent ? 'blue' : 'muted',
    },
    scripts: useScriptsHeaderChrome(chromeScope),
    hooks: useHooksHeaderChrome(chromeScope),
    todo: useTodoHeaderChrome(selectedChromeScope),
    plugins: { subtitle: undefined, collapsedIconColor: 'muted' as const },
    memory: { subtitle: undefined, collapsedIconColor: 'muted' as const },
    notes: useNotesHeaderChrome(chromeScope.projectId, chromeScope.worktreeId),
    prompts: usePromptsHeaderChrome(
      chromeScope.projectId,
      chromeScope.worktreeId,
    ),
    attachments: useAttachmentsHeaderChrome(chromeScope),
    'workspace-files': useCloudWorkspaceFilesHeaderChrome(
      chromeScope.projectId,
    ),
    terminals: { subtitle: undefined, collapsedIconColor: 'muted' as const },
  } as const;
  const sectionHasContent: Partial<Record<ActivitySectionId, boolean>> = {
    summary: summary !== undefined,
    'changed-files': changedFilesHeaderHasContent({
      totalCount: changedFilesTotalFileCount ?? 0,
    }),
    'pull-request': headerChrome['pull-request'].hasContent,
    'background-processes': processes.length > 0,
    'mcp-servers': mcpHasContent,
    plans: headerChrome.plans.collapsedIconColor !== 'muted',
    'pipeline-runs': headerChrome['pipeline-runs'].hasContent,
    cost: costActivity?.hasContent === true,
    scripts: headerChrome.scripts.collapsedIconColor !== 'muted',
    hooks: headerChrome.hooks.collapsedIconColor !== 'muted',
    todo: headerChrome.todo.collapsedIconColor !== 'muted',
    plugins: useChatPluginsHasContent(
      chromeScope.projectId,
      chromeScope.worktreeId,
    ),
    memory: !memoryEmpty,
    notes: headerChrome.notes.collapsedIconColor !== 'muted',
    prompts: headerChrome.prompts.collapsedIconColor !== 'muted',
    attachments: headerChrome.attachments.hasContent,
    'workspace-files': headerChrome['workspace-files'].hasContent,
    terminals: false,
  };
  const sectionHasAction: Partial<Record<ActivitySectionId, boolean>> = {
    summary: worktreeSummaryEnabled || summaryGenerating,
    'mcp-servers': true,
    plans: true,
    'pipeline-runs': true,
    cost: true,
    scripts: scriptsHeaderAction != null,
    hooks: hooksHeaderAction != null,
    notes: true,
    prompts: true,
    attachments: true,
    memory: true,
    plugins: true,
  };
  // The shared-container recipient scope reuses this rail: a Cowork share
  // takes the Cowork surface, and the access filter drops every section that
  // only exists to write or to read live local state the replica lacks.
  const surface: ActivitySurface =
    (projectId !== null && isCoworkChatTarget(projectId)) ||
    (access.mode === 'read-only' &&
      access.containerType === 'COWORK_WORK_ENTRY')
      ? 'cowork'
      : 'worktree';
  // CAN-2836: a code worktree's rail that Canopy seeded collapsed reopens
  // itself the first time the worktree produces work; a Cowork rail stays
  // collapsed until the user opens it (CAN-4793). Consumes `sectionHasContent`
  // verbatim so the signal and the rendered rail cannot drift.
  useAutoExpandActivityRail({ surface, sectionHasContent });
  const sectionOrder = useProjectsStore(
    useShallow((state): ActivitySectionId[] => {
      if (!projectId) return DEFAULT_ACTIVITY_SECTION_ORDER;
      const project = state.projects.find((item) => item.id === projectId);
      return resolveActivitySectionOrder(
        project && project.type !== 'cowork'
          ? project.activitySectionOrder
          : undefined,
      );
    }),
  );
  const reorderActivitySections = useProjectsStore(
    (state) => state.reorderActivitySections,
  );

  const sections = useMemo(
    () =>
      getActivitySectionsForSurface(surface).filter(
        (section) =>
          isActivitySectionAllowedForAccess(section.id, access) &&
          (!OPT_IN_ACTIVITY_SECTION_IDS.has(section.id) ||
            (scopeServesActivitySection(scopeCapabilities, section.id) &&
              projectServesActivitySection(projectId ?? '', section.id))) &&
          // A credits-only account sees cost in credits (CAN-6180).
          !(section.id === 'cost' && projectId === APP_ADVISOR_PROJECT_ID),
      ),
    [access, projectId, scopeCapabilities, surface],
  );
  const renderedSections = useMemo(
    () =>
      selectedWorktree
        ? sections.map((section) => ({
            definition: section,
            body: (
              <NativeBody
                body={
                  section.id === 'cost' ? (
                    costActivity ? (
                      <Suspense fallback={null}>
                        <LazyCostActivityPreviewSection
                          scope={costActivity.scope}
                          store={costActivity.store}
                          maxRows={layout === 'card' ? 5 : undefined}
                          expandedCard={layout === 'card'}
                        />
                      </Suspense>
                    ) : null
                  ) : section.id === 'memory' ? (
                    <MemorySection
                      projectId={selectedWorktree.projectId}
                      worktreeId={selectedWorktree.worktreeId}
                      onEmptyChange={onMemoryEmptyChange}
                    />
                  ) : section.id === 'mcp-servers' ? (
                    cloudMcp.active ? (
                      <CloudMcpServersSectionBody model={cloudMcp} />
                    ) : (
                      <McpServersActivitySectionBody model={detectedMcp} />
                    )
                  ) : (
                    section.render({
                      projectId: selectedWorktree.projectId,
                      worktreeId: selectedWorktree.worktreeId,
                    })
                  )
                }
              />
            ),
          }))
        : [],
    [
      cloudMcp,
      costActivity,
      detectedMcp,
      layout,
      onMemoryEmptyChange,
      sections,
      selectedWorktree,
    ],
  );
  const mcpAddEnabled =
    Boolean(activeChat.activeTabId) &&
    activeChat.readOnly !== true &&
    activeChat.status !== 'streaming';
  const openMcpAdd = (): void => {
    if (!selectedWorktree || !activeChat.activeTabId) return;
    const opened = requestComposerAction(
      {
        scope: 'chat',
        projectId: selectedWorktree.projectId,
        worktreeId: selectedWorktree.worktreeId,
        chatId: activeChat.activeTabId,
      },
      'plugins',
    );
    if (!opened) {
      useGitHubStore
        .getState()
        .addToast('Open this chat to add an MCP server.', 'error', undefined, {
          forceInApp: true,
          projectId: selectedWorktree.projectId,
          worktreeId: selectedWorktree.worktreeId,
        });
    }
  };
  // The empty sections whose whole card is one button: the Activity card
  // runs these from the row instead of opening a page holding that button.
  const sectionActions: Partial<Record<ActivitySectionId, () => void>> = {
    ...(worktreeSummaryEnabled && !summaryGenerating
      ? { summary: hostActions.onRefreshSummary }
      : {}),
    ...(mcpAddEnabled ? { 'mcp-servers': openMcpAdd } : {}),
    ...(onOpenSettingsTab
      ? { hooks: (): void => onOpenSettingsTab('hooks') }
      : {}),
  };
  const prCount = useGitHubStore(
    (state) =>
      state.prStatuses[worktreeKey]?.repos.filter(
        (repo) => repo.status !== null,
      ).length ?? 0,
  );
  // The worktree's line counts, from the same Git stats the sidebar shows.
  const diffStats = useProjectsStore((state) =>
    layout === 'card' ? state.diffStats[worktreeKey] : undefined,
  );
  const hasLineCounts =
    diffStats !== undefined &&
    (diffStats.insertions > 0 || diffStats.deletions > 0);
  // The Activity card's short row states: the row already names the section,
  // so its value is just the number or age. Changes reads `+133 -8`, like the
  // sidebar, once Git has counted the lines.
  const sectionCardValues: Partial<Record<ActivitySectionId, ReactNode>> =
    layout === 'card'
      ? {
          ...(summary
            ? { summary: formatRelativeTime(summary.generatedAt) }
            : {}),
          'changed-files':
            diffStats && hasLineCounts ? (
              <>
                {diffStats.insertions > 0 ? (
                  <span className="fg-success">+{diffStats.insertions}</span>
                ) : null}
                {diffStats.insertions > 0 && diffStats.deletions > 0
                  ? ' '
                  : null}
                {diffStats.deletions > 0 ? (
                  <span className="fg-destructive">-{diffStats.deletions}</span>
                ) : null}
              </>
            ) : (
              String(changedFilesTotalFileCount ?? 0)
            ),
          'pull-request': String(prCount),
          'mcp-servers': String(
            cloudMcp.active
              ? cloudMcp.servers.length
              : detectedMcp.servers.length,
          ),
          scripts: String(scriptsSection.entries.length),
          hooks: String(hooksSection.entries.length),
          ...(costActivity?.hasContent === true
            ? {
                cost: (
                  <Suspense fallback={null}>
                    <LazyCostActivityTotalLabel store={costActivity.store} />
                  </Suspense>
                ),
              }
            : {}),
        }
      : {};
  // The action each empty section's rail card offers. The Activity card names
  // its row with it, so an empty row says what clicking it does.
  const sectionActionLabels: Partial<Record<ActivitySectionId, string>> =
    access.mode === 'read-only'
      ? {}
      : {
          summary: summaryGenerating
            ? 'Generating summary…'
            : 'Generate summary',
          'mcp-servers': 'Add MCP server',
          plans: 'Import plan',
          'pipeline-runs': 'Dispatch workflow',
          ...(onOpenSettingsTab ? { hooks: 'Add hook' } : {}),
          plugins: 'Add plugins',
          notes: 'Add note',
          prompts: 'Add prompt',
          attachments: 'Import attachment',
        };
  const sectionOverrides: Readonly<
    Record<string, ActivityPanelSectionOverride>
  > = ((): Readonly<Record<string, ActivityPanelSectionOverride>> => {
    const result: Record<string, ActivityPanelSectionOverride> = {
      terminals: { hidden: true },
    };
    const visibleIds = new Set(sections.map((section) => section.id));
    for (const id of DEFAULT_ACTIVITY_SECTION_ORDER) {
      if (!visibleIds.has(id)) result[id] = { hidden: true };
    }
    const emptyTitles: Partial<Record<ActivitySectionId, string>> = {
      summary: summaryGenerating ? 'Generating summary…' : 'Generate summary',
      'mcp-servers': 'Add MCP server',
    };
    for (const rendered of renderedSections) {
      if (EXTRA_SECTION_IDS.has(rendered.definition.id)) continue;
      const emptyTitle =
        sectionHasContent[rendered.definition.id] === false
          ? emptyTitles[rendered.definition.id]
          : undefined;
      result[rendered.definition.id] = {
        keepBodyMountedWhenCollapsed:
          rendered.definition.id === 'pipeline-runs',
        expandRequest: sectionExpandRequests?.[rendered.definition.id],
        hasContent: sectionHasContent[rendered.definition.id],
        hasAction: sectionHasAction[rendered.definition.id],
        onAction: sectionActions[rendered.definition.id],
        actionLabel: sectionActionLabels[rendered.definition.id],
        cardValue: sectionCardValues[rendered.definition.id],
        actionCard:
          (rendered.definition.id === 'summary' ||
            rendered.definition.id === 'mcp-servers' ||
            rendered.definition.id === 'plans' ||
            rendered.definition.id === 'pipeline-runs' ||
            (rendered.definition.id === 'hooks' &&
              onOpenSettingsTab != null)) &&
          sectionHasContent[rendered.definition.id] === false,
        // The definition title feeds tab labels; the in-panel header for the
        // PR section is plural.
        title:
          emptyTitle ??
          (rendered.definition.id === 'pull-request'
            ? 'Pull requests'
            : earlyAccessTitle(rendered.definition.title)),
        icon: rendered.definition.icon,
        subtitleInline:
          rendered.definition.id === 'summary' ||
          rendered.definition.id === 'cost',
        subtitle: emptyTitle
          ? null
          : headerChrome[rendered.definition.id]?.subtitle,
        subtitleGap:
          rendered.definition.id === 'todo'
            ? headerChrome.todo.subtitleGap
            : undefined,
        collapsedIconColor:
          headerChrome[rendered.definition.id]?.collapsedIconColor,
        headerAction:
          rendered.definition.id === 'changed-files' ? (
            changedFilesHeaderAction
          ) : rendered.definition.id === 'mcp-servers' ? (
            mcpHasContent ? (
              mcpRefreshAction
            ) : null
          ) : rendered.definition.id === 'scripts' ? (
            scriptsHeaderAction
          ) : rendered.definition.id === 'hooks' ? (
            hooksHeaderAction
          ) : rendered.definition.id === 'cost' &&
            costActivity &&
            layout === 'stack' ? (
            <Suspense fallback={null}>
              <LazyCostActivityRefreshAction store={costActivity.store} />
            </Suspense>
          ) : undefined,
        // Container testids the Electron specs assert on: natively they lived
        // on the section's own root and wrapped the header (subtitle). In
        // body-only chrome the header renders in the shared wrapper, so the
        // wrapper must carry the testid; the native root suppresses its copy.
        dataTestId: SECTION_CONTAINER_TEST_IDS[rendered.definition.id],
        body:
          rendered.definition.id === 'mcp-servers' && !mcpHasContent ? (
            <NativeBody
              body={
                <PanelSection
                  title={earlyAccessTitle('MCP Servers')}
                  icon={rendered.definition.icon}
                  hasExpandableContent={false}
                  actionOnlyCard
                  actionOnlyLabel="Add MCP server"
                  headerAction={
                    <HeaderActionButton
                      data-testid="activity-mcp-add"
                      disabled={!mcpAddEnabled}
                      onClick={openMcpAdd}
                    >
                      Add MCP server
                    </HeaderActionButton>
                  }
                />
              }
            />
          ) : rendered.definition.id === 'summary' &&
            !sectionHasContent.summary ? (
            <NativeBody
              body={
                <PanelSection
                  title="Summary"
                  icon={
                    summaryGenerating ? (
                      <RefreshSpinnerIcon spinning size={16} />
                    ) : (
                      rendered.definition.icon
                    )
                  }
                  hasExpandableContent={false}
                  actionOnlyCard
                  actionOnlyLabel={
                    summaryGenerating
                      ? 'Generating summary…'
                      : 'Generate summary'
                  }
                  headerAction={
                    <HeaderActionButton
                      data-testid="activity-summary-generate"
                      disabled={summaryGenerating || !worktreeSummaryEnabled}
                      aria-busy={summaryGenerating}
                      onClick={hostActions.onRefreshSummary}
                    >
                      Generate summary
                    </HeaderActionButton>
                  }
                />
              }
            />
          ) : rendered.definition.id === 'hooks' &&
            !sectionHasContent.hooks &&
            onOpenSettingsTab ? (
            <NativeBody
              body={
                <PanelSection
                  title="Hooks"
                  icon={rendered.definition.icon}
                  hasExpandableContent={false}
                  actionOnlyCard
                  actionOnlyLabel="Add hook"
                  headerAction={
                    <HeaderActionButton
                      data-testid="activity-hooks-add"
                      onClick={(): void => onOpenSettingsTab('hooks')}
                    >
                      Add hook
                    </HeaderActionButton>
                  }
                />
              }
            />
          ) : rendered.definition.id === 'summary' ||
            rendered.definition.id === 'todo' ||
            rendered.definition.id === 'scripts' ||
            rendered.definition.id === 'hooks' ||
            rendered.definition.id === 'background-processes' ||
            rendered.definition.id === 'changed-files' ? undefined : (
            rendered.body
          ),
      };
    }
    return result;
  })();
  const extraSections: readonly ActivityPanelExtraSection[] = renderedSections
    .filter((rendered) => EXTRA_SECTION_IDS.has(rendered.definition.id))
    .map((rendered) => ({
      key: rendered.definition.id,
      actionLabel: sectionActionLabels[rendered.definition.id],
      hasContent: sectionHasContent[rendered.definition.id],
      hasAction: sectionHasAction[rendered.definition.id],
      actionCard:
        rendered.definition.id !== 'memory' &&
        sectionHasContent[rendered.definition.id] === false,
      keepBodyMountedWhenCollapsed:
        rendered.definition.id === 'memory' ||
        rendered.definition.id === 'plugins',
      hiddenWhileMounted: rendered.definition.id === 'memory' && memoryEmpty,
      title: earlyAccessTitle(rendered.definition.title),
      icon: rendered.definition.icon,
      subtitle: headerChrome[rendered.definition.id]?.subtitle,
      collapsedIconColor:
        headerChrome[rendered.definition.id]?.collapsedIconColor,
      body: rendered.body,
    }));

  const handleSectionOrderChange = (nextOrder: readonly string[]): void => {
    if (!projectId) return;
    const nextIds = nextOrder.filter(isActivitySectionId);
    void reorderActivitySections(projectId, nextIds);
  };

  if (!selectedWorktree) {
    return <div data-testid="activity-panel" />;
  }

  return (
    <SharedActivityPanel
      backgroundTasksSection={backgroundTasksSection}
      workspaceLocalId={selectedWorktree.projectId}
      worktreeLocalId={selectedWorktree.worktreeId}
      selectedChatId={activeChat.activeTabId}
      worktreeSummaries={worktreeSummaries}
      todoLists={todoLists}
      summaryRefreshEnabled={worktreeSummaryEnabled}
      summaryGenerating={summaryGenerating}
      scriptsSection={scriptsSection}
      hooksSection={hooksSection}
      changedFilesSection={changedFilesSection}
      hostActions={hostActions}
      hideTabs
      layout={layout}
      onOpenCardSection={onOpenCardSection}
      sectionOverrides={sectionOverrides}
      extraSections={extraSections}
      sectionOrder={sectionOrder}
      onSectionOrderChange={handleSectionOrderChange}
    />
  );
}

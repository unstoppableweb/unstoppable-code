'use client';

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  isActivitySectionId,
  isActivitySectionVisibleForTarget,
  resolveActivitySectionOrder,
  selectWorktreeItems,
  useActivityStore,
  useCapabilities,
  useWorkspaceCapabilities,
  type ActivitySectionId,
  type ActivityWorkspaceType,
} from '@canopy/app-state';
import {
  Stack,
  HeaderActionButton,
  ProgressBar,
  OverlayScrollArea,
  RailTabBar,
  RefreshButton,
  type CollapsedIconColor,
  type RailTabBarTab,
  type SpaceRole,
} from '@canopy/ui-shared/components';
import {
  formatRelativeTime,
  mcpPanelCardSubtitle,
} from '@canopy/ui-shared/lib';
import type { SessionViewModel } from '@canopy/app-core';
import {
  ChangesIcon,
  CostIcon,
  EyeIcon,
  GitPullRequestIcon,
  HookIcon,
  McpServerIcon,
  PipelineIcon,
  PlanModeIcon,
  ProcessIcon,
  RocketLaunchIcon,
  SummaryIcon,
  TasksIcon,
  TerminalIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type {
  PortalCodeViewerSelection,
  PortalChangedFilesGroup,
  PortalHookDescriptor,
  PortalHookRunProjection,
  PortalMcpServerEntity,
  PortalPlan,
  PortalScriptDescriptor,
  PortalScriptRunProjection,
  PortalTerminalSessionEntity,
  PortalChatTodoProjection,
  PortalWorktreeSummaryEntity,
} from '@canopy/protocol/portal';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import { BackgroundTasksList } from './BackgroundTasksList';
import {
  backgroundTasksHeaderChrome,
  type BackgroundTasksSectionHostModel,
} from './background-tasks-section';
import { SortableSection } from './SortableSection';
import {
  changedFilesHeaderHasContent,
  changedFilesHeaderSubtitle,
  type ChangedFilesHeaderInput,
} from './changed-files-header';
import {
  ActivityCardStyle,
  ActivityCardView,
  type ActivityCardRow,
  type ActivityCardRowGroup,
} from './ActivityCardView';
import { FilesTab, type FilesTabRoot } from './FilesTab';
import { SummarySectionBody } from './SummarySectionBody';
import { ActivitySectionSkeleton } from './ActivitySectionSkeleton';
import { portalSummaryToSectionBodyProps } from './portal-summary-section-mapper';
import {
  ChangedFilesSection,
  type ChangedFilesSectionProps,
} from './sections/ChangedFilesSection';
import { PullRequestSection } from './sections/PullRequestSection';
import { ItemListSection } from './sections/ItemListSection';
import { PlansSection } from './sections/PlansSection';
import {
  PipelineRunsSection,
  isActivePipelineStatus,
} from './sections/PipelineRunsSection';
import {
  ScriptsSectionBody,
  type ScriptsSectionBodyProps,
} from './scripts/ScriptsSectionBody';
import { portalScriptsToSectionModel } from './portal-scripts-section-mapper';
import {
  HooksSectionBody,
  PauseToggleButton,
  type HooksSectionBodyProps,
} from './hooks/HooksSectionBody';
import { portalHooksToSectionModel } from './portal-hooks-section-mapper';
import { TodoSectionBody, type TodoSectionBodyItem } from './TodoSectionBody';
import {
  McpServersSectionBody,
  type McpServersSectionItem,
} from './McpServersSectionBody';

export type ActivityTab = 'activity' | 'files';

const TABS: readonly RailTabBarTab<ActivityTab>[] = [
  { id: 'activity', label: 'Activity', dataTestId: 'activity-tab-activity' },
  { id: 'files', label: 'Files', dataTestId: 'activity-tab-files' },
];

/**
 * Sections the card lists under "what the agent works with" rather than
 * "what happened here". Everything else, host extras included, is work.
 */
const ACTIVITY_CARD_SETUP_SECTIONS: ReadonlySet<string> = new Set([
  'mcp-servers',
  'scripts',
  'hooks',
  'plugins',
  'memory',
  'notes',
  'prompts',
  'attachments',
  'terminals',
]);

/**
 * Sentence-case labels for the card. The rail's headers keep their existing
 * Title Case copy, which Electron specs assert on.
 */
const ACTIVITY_CARD_TITLES: Readonly<Record<string, string>> = {
  'changed-files': 'Changes',
  'pull-request': 'Pull requests',
  'background-processes': 'Background processes',
  'mcp-servers': 'MCP servers',
  todo: 'Agent tasks',
};

/**
 * Pointer activation for card reordering. This must stay distance-based: a
 * `delay` constraint makes dnd-kit cancel the drag as soon as the pointer
 * travels past `tolerance` before the delay elapses, so a normal
 * press-and-drag-immediately never activates (the long-press variant shipped
 * in 82ed49a590 broke reordering). The small distance threshold is what keeps
 * plain header clicks and header-action clicks from starting a drag.
 */
export const ACTIVITY_POINTER_DRAG_ACTIVATION_CONSTRAINT = {
  distance: 4,
} as const;

interface KeyedRun {
  readonly status: string;
  readonly startedAt?: string;
}

function portalMcpServerToSectionItem(
  server: PortalMcpServerEntity,
): McpServersSectionItem {
  return {
    key: server.localId,
    source: server.source,
    displayName: server.displayName,
    enabled: server.enabled,
    authStatus: server.authStatus,
    authStatusLabel: server.authStatusLabel,
    canRefresh: server.canRefresh,
    canConnect: false,
    configName: server.configName,
    collectionId: server.collectionId,
    bundleId: server.bundleId,
    pluginName: server.pluginName,
  };
}

function latestRunsByKey<Run extends KeyedRun>(
  runs: readonly Run[],
  keyForRun: (run: Run) => string,
): Map<string, Run> {
  const latest = new Map<string, Run>();
  for (const run of runs) {
    const key = keyForRun(run);
    const existing = latest.get(key);
    const runStartedAt = run.startedAt ?? '';
    const existingStartedAt = existing?.startedAt ?? '';
    if (
      !existing ||
      runStartedAt > existingStartedAt ||
      (runStartedAt === existingStartedAt &&
        isActivePipelineStatus(run.status) &&
        !isActivePipelineStatus(existing.status))
    ) {
      latest.set(key, run);
    }
  }
  return latest;
}

function mergeVisibleOrder(
  completeOrder: readonly string[],
  reorderedVisible: readonly string[],
): string[] {
  const visible = new Set(reorderedVisible);
  let visibleIndex = 0;
  return completeOrder.map((key) => {
    if (!visible.has(key)) return key;
    const replacement = reorderedVisible[visibleIndex];
    visibleIndex += 1;
    return replacement ?? key;
  });
}

const EMPTY_BACKGROUND_TASKS: readonly BackgroundTask[] = [];

/** Snapshot-scoped inputs every section descriptor reads. */
interface ActivitySectionContext {
  readonly backgroundTasks: readonly BackgroundTask[];
  readonly snapshot: SessionViewModel | null;
  readonly worktreeSummaries?: readonly PortalWorktreeSummaryEntity[];
  readonly workspaceLocalId: string;
  readonly worktreeLocalId: string;
  readonly selectedChatId?: string;
  readonly todoItems: readonly TodoSectionBodyItem[];
  readonly hydrating: boolean;
}

interface ActivitySectionDescriptor {
  readonly title: string;
  readonly icon: ReactNode;
  readonly subtitle: (context: ActivitySectionContext) => ReactNode;
  readonly collapsedIconColor: (
    context: ActivitySectionContext,
  ) => CollapsedIconColor;
  // Data-presence predicate used ONLY to gate the `Loading…` fallback.
  // Deliberately independent of the displayed subtitle count: for
  // Scripts/Hooks it returns true when any orphan/active run exists, even
  // though such runs are excluded from the `N configured` count.
  readonly hasUsableData: (context: ActivitySectionContext) => boolean;
}

function changedFileCount(context: ActivitySectionContext): number {
  const changed = context.snapshot?.changedFiles[context.worktreeLocalId];
  if (changed?.page) {
    return changed.page.uncommitted.total + changed.page.committed.total;
  }
  return (changed?.uncommitted.length ?? 0) + (changed?.committed.length ?? 0);
}

/** The section header's input from the snapshot (REG-3024). */
function changedFilesHeaderInput(
  context: ActivitySectionContext,
): ChangedFilesHeaderInput {
  const changed = context.snapshot?.changedFiles[context.worktreeLocalId];
  return {
    totalCount: changedFileCount(context),
    notices: (changed?.notices ?? []).filter(
      (notice) => notice.kind !== 'truncated' || changed?.page === undefined,
    ),
  };
}

/** Whether a changed-files answer has rows or explains why it has none. */
function changedFilesHaveContent(
  changedFiles:
    | {
        readonly uncommitted: readonly unknown[];
        readonly committed: readonly unknown[];
        readonly notices?: readonly unknown[];
        readonly page?: {
          readonly uncommitted: { readonly total: number };
          readonly committed: { readonly total: number };
        };
      }
    | undefined,
): boolean {
  return (
    (changedFiles?.page?.uncommitted.total ??
      changedFiles?.uncommitted.length ??
      0) +
      (changedFiles?.page?.committed.total ??
        changedFiles?.committed.length ??
        0) +
      (changedFiles?.notices?.length ?? 0) >
    0
  );
}

function prPresent(context: ActivitySectionContext): boolean {
  const pr = context.snapshot?.prStatuses[context.worktreeLocalId];
  if (!pr) return false;
  return (
    (pr.number !== undefined && pr.number !== null) ||
    (pr.title !== undefined && pr.title !== '')
  );
}

/**
 * PR count for the section subtitle, mirroring the desktop
 * `usePullRequestHeaderChrome`: with the CAN-1528 L2 `repos` array present,
 * count the repos that actually carry a PR; otherwise fall back to the flat
 * primary-repo presence check.
 */
function prCount(context: ActivitySectionContext): number {
  const pr = context.snapshot?.prStatuses[context.worktreeLocalId];
  if (!pr) return 0;
  if (pr.repos !== undefined && pr.repos.length > 0) {
    return pr.repos.filter((repo) => repo.status != null).length;
  }
  return prPresent(context) ? 1 : 0;
}

/**
 * The latest PR refresh failed (REG-3025): the card explains why, so it shows
 * even when no PR was ever read.
 */
function prRefreshFailed(context: ActivitySectionContext): boolean {
  return (
    context.snapshot?.prStatuses[context.worktreeLocalId]?.refreshError !==
    undefined
  );
}

/**
 * True while a PR-creation feed is active (non-terminal) — the portal twin of
 * the desktop `creatingPr` store gate behind "Creating pull request…".
 */
function prCreating(context: ActivitySectionContext): boolean {
  const pr = context.snapshot?.prStatuses[context.worktreeLocalId];
  if (!pr) return false;
  if (pr.creationProgress === null) return false;
  if (pr.creationProgress !== undefined) {
    return (
      pr.creationProgress.currentPhase !== 'done' &&
      pr.creationProgress.currentPhase !== 'error'
    );
  }
  return pr.creationPhase != null;
}

/**
 * The exhaustive, typed source of truth for every built-in section's header
 * chrome: title, icon, semantic subtitle, collapsed tone, and the loading
 * data-presence predicate. Replaces the former string map + count/subtitle/tone
 * helpers so the shared portal rail mirrors the desktop-native headers
 * section-by-section. Titles are sentence case on every host; `pull-request`
 * reads `Pull requests` (the desktop `SharedActivityPanelAdapter` overrides
 * the registry's singular label with this plural header).
 */
const ACTIVITY_SECTION_DESCRIPTORS: Record<
  ActivitySectionId,
  ActivitySectionDescriptor
> = {
  summary: {
    title: 'Summary',
    icon: <SummaryIcon />,
    subtitle: (context): ReactNode => {
      const summary = selectWorktreeItems(
        context.worktreeSummaries ?? context.snapshot?.worktreeSummaries,
        context.worktreeLocalId,
      )[0];
      if (summary?.generating === true) return 'Generating…';
      if (summary?.generatedAt)
        return `Updated ${formatRelativeTime(summary.generatedAt)}`;
      // Portal-only lenient state: an entity can carry a summary without
      // generatedAt (legacy payloads); desktop cannot reach this branch.
      if (summary) return 'Summary available';
      return 'No summary yet';
    },
    collapsedIconColor: (context): CollapsedIconColor => {
      const summary = selectWorktreeItems(
        context.worktreeSummaries ?? context.snapshot?.worktreeSummaries,
        context.worktreeLocalId,
      )[0];
      return summary ? 'blue' : 'muted';
    },
    hasUsableData: (context): boolean =>
      selectWorktreeItems(
        context.worktreeSummaries ?? context.snapshot?.worktreeSummaries,
        context.worktreeLocalId,
      ).length > 0,
  },
  'changed-files': {
    title: 'Changed files',
    icon: <ChangesIcon />,
    subtitle: (context): ReactNode =>
      changedFilesHeaderSubtitle(changedFilesHeaderInput(context)),
    collapsedIconColor: (context): CollapsedIconColor =>
      changedFileCount(context) > 0 ? 'amber' : 'muted',
    hasUsableData: (context): boolean =>
      changedFilesHeaderHasContent(changedFilesHeaderInput(context)),
  },
  'pull-request': {
    title: 'Pull requests',
    icon: <GitPullRequestIcon />,
    subtitle: (context): ReactNode => {
      if (prCreating(context)) return 'Creating pull request…';
      const count = prCount(context);
      if (count > 0) return `${count} pull request${count === 1 ? '' : 's'}`;
      return prRefreshFailed(context) ? "Couldn't refresh" : 'No pull request';
    },
    collapsedIconColor: (context): CollapsedIconColor =>
      prCreating(context) || prCount(context) > 0 ? 'amber' : 'muted',
    hasUsableData: (context): boolean =>
      prCreating(context) || prCount(context) > 0 || prRefreshFailed(context),
  },
  'background-processes': {
    title: 'Agent background processes',
    icon: <ProcessIcon />,
    subtitle: (context): ReactNode =>
      backgroundTasksHeaderChrome(context.backgroundTasks).subtitle,
    collapsedIconColor: (context): CollapsedIconColor =>
      backgroundTasksHeaderChrome(context.backgroundTasks).collapsedIconColor,
    // Hosts project their tasks through `backgroundTasksSection`; without one
    // the section keeps its truthful empty state.
    hasUsableData: (context): boolean => context.backgroundTasks.length > 0,
  },
  'mcp-servers': {
    title: 'MCP servers',
    icon: <McpServerIcon size="sm" />,
    subtitle: (context): ReactNode =>
      mcpPanelCardSubtitle({
        loading: false,
        serverCount: selectWorktreeItems(
          context.snapshot?.mcpServers,
          context.worktreeLocalId,
        ).length,
      }),
    collapsedIconColor: (context): CollapsedIconColor =>
      selectWorktreeItems(context.snapshot?.mcpServers, context.worktreeLocalId)
        .length > 0
        ? 'blue'
        : 'muted',
    hasUsableData: (context): boolean =>
      selectWorktreeItems(context.snapshot?.mcpServers, context.worktreeLocalId)
        .length > 0,
  },
  plans: {
    title: 'Plans',
    icon: <PlanModeIcon />,
    subtitle: (context): ReactNode => {
      const plans = selectWorktreeItems(
        context.snapshot?.plans,
        context.worktreeLocalId,
      );
      if (plans.length === 0) return 'No tracked plans yet';
      const visible = plans.filter((plan) => plan.hidden !== true).length;
      const hidden = plans.length - visible;
      return hidden > 0
        ? `${visible} tracked · ${hidden} hidden`
        : `${visible} tracked`;
    },
    collapsedIconColor: (context): CollapsedIconColor =>
      selectWorktreeItems(context.snapshot?.plans, context.worktreeLocalId)
        .length > 0
        ? 'blue'
        : 'muted',
    hasUsableData: (context): boolean =>
      selectWorktreeItems(context.snapshot?.plans, context.worktreeLocalId)
        .length > 0,
  },
  'pipeline-runs': {
    title: 'Workflow runs',
    icon: <PipelineIcon />,
    subtitle: (context): ReactNode => {
      const runs = selectWorktreeItems(
        context.snapshot?.pipelineRuns,
        context.worktreeLocalId,
      );
      if (runs.length === 0) return 'No workflow runs';
      const active = runs.filter((run) =>
        isActivePipelineStatus(run.status),
      ).length;
      return `${active} active, ${runs.length - active} completed`;
    },
    collapsedIconColor: (context): CollapsedIconColor => {
      const runs = selectWorktreeItems(
        context.snapshot?.pipelineRuns,
        context.worktreeLocalId,
      );
      const active = runs.filter((run) =>
        isActivePipelineStatus(run.status),
      ).length;
      return active > 0 ? 'amber' : runs.length > 0 ? 'blue' : 'muted';
    },
    hasUsableData: (context): boolean =>
      selectWorktreeItems(
        context.snapshot?.pipelineRuns,
        context.worktreeLocalId,
      ).length > 0,
  },
  cost: {
    title: 'Cost',
    icon: <CostIcon />,
    subtitle: (): ReactNode => null,
    collapsedIconColor: (): CollapsedIconColor => 'muted',
    // A host supplies the cost read/body and its real presence signal.
    hasUsableData: (): boolean => false,
  },
  scripts: {
    title: 'Scripts',
    icon: <RocketLaunchIcon size="sm" />,
    subtitle: (context): ReactNode => {
      const configured = new Set(
        selectWorktreeItems(
          context.snapshot?.scriptDescriptors,
          context.worktreeLocalId,
        ).map((descriptor) => descriptor.scriptKey),
      ).size;
      return configured > 0 ? `${configured} configured` : 'None configured';
    },
    collapsedIconColor: (context): CollapsedIconColor => {
      const configured = new Set(
        selectWorktreeItems(
          context.snapshot?.scriptDescriptors,
          context.worktreeLocalId,
        ).map((descriptor) => descriptor.scriptKey),
      ).size;
      const running = selectWorktreeItems(
        context.snapshot?.scriptRuns,
        context.worktreeLocalId,
      ).some((run) => isActivePipelineStatus(run.status));
      return running ? 'amber' : configured > 0 ? 'blue' : 'muted';
    },
    hasUsableData: (context): boolean =>
      selectWorktreeItems(
        context.snapshot?.scriptDescriptors,
        context.worktreeLocalId,
      ).length > 0 ||
      selectWorktreeItems(context.snapshot?.scriptRuns, context.worktreeLocalId)
        .length > 0,
  },
  hooks: {
    title: 'Hooks',
    icon: <HookIcon />,
    subtitle: (context): ReactNode => {
      const configured = new Set(
        selectWorktreeItems(
          context.snapshot?.hookDescriptors,
          context.worktreeLocalId,
        ).map((descriptor) => descriptor.hookKey),
      ).size;
      return configured > 0 ? `${configured} configured` : 'None configured';
    },
    collapsedIconColor: (context): CollapsedIconColor => {
      const configured = new Set(
        selectWorktreeItems(
          context.snapshot?.hookDescriptors,
          context.worktreeLocalId,
        ).map((descriptor) => descriptor.hookKey),
      ).size;
      const running = selectWorktreeItems(
        context.snapshot?.hookRuns,
        context.worktreeLocalId,
      ).some((run) => isActivePipelineStatus(run.status));
      return running ? 'amber' : configured > 0 ? 'blue' : 'muted';
    },
    hasUsableData: (context): boolean =>
      selectWorktreeItems(
        context.snapshot?.hookDescriptors,
        context.worktreeLocalId,
      ).length > 0 ||
      selectWorktreeItems(context.snapshot?.hookRuns, context.worktreeLocalId)
        .length > 0,
  },
  terminals: {
    title: 'Terminals',
    icon: <TerminalIcon />,
    subtitle: (context): ReactNode => {
      const count = selectWorktreeItems(
        context.snapshot?.terminalSessions,
        context.worktreeLocalId,
      ).length;
      return count === 0
        ? 'No terminals'
        : `${count} terminal${count === 1 ? '' : 's'}`;
    },
    collapsedIconColor: (context): CollapsedIconColor =>
      selectWorktreeItems(
        context.snapshot?.terminalSessions,
        context.worktreeLocalId,
      ).length > 0
        ? 'blue'
        : 'muted',
    hasUsableData: (context): boolean =>
      selectWorktreeItems(
        context.snapshot?.terminalSessions,
        context.worktreeLocalId,
      ).length > 0,
  },
  todo: {
    title: 'Agent tasks',
    icon: <TasksIcon />,
    subtitle: (context): ReactNode => {
      const items = context.todoItems;
      if (items.length === 0) return 'No agent tasks';
      const completed = items.filter(
        (item) => item.status === 'completed',
      ).length;
      const percentage = (completed / items.length) * 100;
      return (
        <div className="mt-1 flex items-center gap-2">
          <ProgressBar
            value={percentage}
            size="compact"
            className="flex-1"
            label={`${completed} of ${items.length} tasks completed`}
            hideLabel
          />
          <span className="text-2xs fg-secondary">
            {completed}/{items.length}
          </span>
        </div>
      );
    },
    collapsedIconColor: (context): CollapsedIconColor =>
      context.todoItems.length > 0 ? 'amber' : 'muted',
    hasUsableData: (context): boolean => context.todoItems.length > 0,
  },
};

export interface ActivitySectionMenuDescriptor {
  readonly title: string;
  readonly icon: ReactNode;
}

/**
 * Returns the stable display metadata for a built-in activity section.
 * Unknown persisted ids deliberately return `undefined`.
 */
export function getActivitySectionDescriptor(
  id: string,
): ActivitySectionMenuDescriptor | undefined {
  if (!isActivitySectionId(id)) return undefined;
  const descriptor = ACTIVITY_SECTION_DESCRIPTORS[id];
  return { title: descriptor.title, icon: descriptor.icon };
}

/**
 * The write-once activity/files right rail for the Code tab. Reads the neutral
 * shell snapshot from the shared {@link useActivityStore}, renders the ordered
 * activity sections (drag-reorderable via `@dnd-kit`, persisted through
 * `activity.setSectionOrder`), and a Files tab over the shared `FileTreeRow`.
 *
 * All sections are read-only here: interactive dispatch (run a script/hook,
 * cancel a run, revert a file, load a directory) arrives as injected host
 * callbacks in the adopt tickets. `changed-files` revert is additionally gated
 * on `fileSystemAccess === 'read-write'`.
 */
/** Optional host behavior. Missing handlers remove their corresponding controls. */
export interface ActivityPanelHostActions {
  readonly onOpenCode?: (selection: PortalCodeViewerSelection) => void;
  readonly onRevertFile?: (filePath: string) => void;
  readonly onRunScript?: (
    script: PortalScriptDescriptor,
  ) => void | Promise<void>;
  readonly onCancelScript?: (
    run: PortalScriptRunProjection,
  ) => void | Promise<void>;
  readonly onRunHook?: (hook: PortalHookDescriptor) => void;
  readonly onCancelHook?: (run: PortalHookRunProjection) => void;
  readonly onToggleHookPause?: (hook: PortalHookDescriptor) => void;
  /** Receives the desired paused state for every configured hook. */
  readonly onToggleAllHooksPause?: (paused: boolean) => void;
  readonly onReviewChanges?: () => void;
  readonly onRefreshSummary?: () => void;
  readonly onGetPlan?: (plan: PortalPlan) => void;
  readonly onImplementPlan?: (plan: PortalPlan) => void;
  /**
   * Dispatch a `plan_ready` pipeline from a finished plan (CAN-3019). Supplied
   * by the web portal only; desktop replaces the `'plans'` body wholesale
   * through `sectionOverrides` and never renders the shared `PlansSection`.
   */
  readonly onRunPlanPipeline?: (plan: PortalPlan) => void;
  readonly onOpenTerminal?: (terminal: PortalTerminalSessionEntity) => void;
  /** Load the next Portal-paged changed-files group. */
  readonly onLoadMoreChangedFiles?: (
    worktreeLocalId: string,
    group: PortalChangedFilesGroup,
  ) => void;
  readonly onListDirectory?: (name: string) => void;
  /** Host switches the Files tab to another file root (multi-repo). */
  readonly onSelectFileRoot?: (rootLocalId: string) => void;
}

export interface ScriptsSectionHostModel extends ScriptsSectionBodyProps {
  /** Host-owned dialogs rendered beside the shared body. */
  readonly supplementaryContent?: ReactNode;
}

export interface HooksSectionHostModel extends HooksSectionBodyProps {
  /** Host-owned dialogs rendered beside the shared body. */
  readonly supplementaryContent?: ReactNode;
}

export interface ChangedFilesSectionHostModel extends ChangedFilesSectionProps {
  /** Host-owned dialogs rendered beside the shared body. */
  readonly supplementaryContent?: ReactNode;
}

export interface ActivityPanelProps {
  readonly workspaceLocalId: string;
  readonly worktreeLocalId: string;
  /** Active chat whose projected agent tasks populate the Todo section. */
  readonly selectedChatId?: string;
  /** Host-projected summaries; falls back to the hydrated session snapshot. */
  readonly worktreeSummaries?: readonly PortalWorktreeSummaryEntity[];
  /** Host-projected todos; falls back to the hydrated session snapshot. */
  readonly todoLists?: readonly PortalChatTodoProjection[];
  /** Whether the host currently permits manual summary refresh. */
  readonly summaryRefreshEnabled?: boolean;
  /** Host-projected generation state, including before a summary exists. */
  readonly summaryGenerating?: boolean;
  /** Rich host projection; falls back to the hydrated portal snapshot. */
  readonly scriptsSection?: ScriptsSectionHostModel;
  /** Rich host projection; falls back to the hydrated portal snapshot. */
  readonly hooksSection?: HooksSectionHostModel;
  /** Rich host projection; falls back to the hydrated portal snapshot. */
  readonly changedFilesSection?: ChangedFilesSectionHostModel;
  /** Per-group Portal page reads currently in flight. */
  readonly loadingMoreChangedFiles?: Partial<
    Record<PortalChangedFilesGroup, boolean>
  >;
  /** Host-projected tasks and actions. Absent means the empty state. */
  readonly backgroundTasksSection?: BackgroundTasksSectionHostModel;
  /**
   * Host opens a changed file's diff.
   * @deprecated Use `hostActions.onOpenCode`.
   */
  readonly onSelectFile?: (filePath: string) => void;
  /** Host reverts a changed file (desktop only; also capability-gated). */
  readonly onRevertFile?: (filePath: string) => void;
  /** Directory-cache key whose entries feed the Files tab (host-provided). */
  readonly fileTreeRootKey?: string;
  readonly fileRootLocalId?: string;
  /** All selectable file roots; the Files tab shows a switcher when > 1. */
  readonly fileRoots?: readonly FilesTabRoot[];
  readonly activeFileRootLocalId?: string;
  /** Brand display name grouping app-owned file roots in the switcher. */
  readonly appManagedFileRootsLabel?: string;
  /** Root-relative directory currently listed in the Files tab. */
  readonly fileTreeDir?: string;
  /** Host-rendered recovery content for an empty Files directory. */
  readonly filesEmptyState?: ReactNode;
  readonly filesStatusBar?: ReactNode;
  readonly filesDownloadNotice?: string;
  /**
   * Host is still hydrating the snapshot. It does not change which sections
   * render; a rendered section without usable data shows a loading
   * placeholder instead of a false "empty" state.
   */
  readonly hydrating?: boolean;
  readonly onOpenFile?: (name: string) => void;
  readonly onOpenDirectory?: (name: string) => void;
  /**
   * Host saves a listed file to disk; receives the root-relative path. Only
   * provided where the active root has a download transport. Artifact hosts
   * use `canDownloadFile` to restrict the action to deliverable rows.
   */
  readonly onDownloadFile?: (relativePath: string) => void;
  /** Optional host policy that limits downloads to eligible listed paths. */
  readonly canDownloadFile?: (relativePath: string) => boolean;
  /** Host copy for the most recent failed Files-tab download. */
  readonly downloadError?: string;
  readonly hostActions?: ActivityPanelHostActions;
  /** Render the terminals section even before the host has terminal rows. */
  readonly showTerminals?: boolean;
  readonly testIds?: {
    readonly activityTab?: string;
    readonly filesTab?: string;
    readonly filesTree?: string;
    readonly filesRow?: string;
    readonly filesFolderRow?: string;
    readonly changedFileOpen?: string;
  };
  readonly touchTarget?: boolean;
  /** Notify the host when the user opens Activity or Files. */
  readonly onTabChange?: (tab: ActivityTab) => void;
  /** Host-rendered content and chrome adjustments for shared section keys. */
  readonly sectionOverrides?: Readonly<
    Record<string, ActivityPanelSectionOverride | undefined>
  >;
  /** Host-only sections that participate in the same chrome and ordering. */
  readonly extraSections?: readonly ActivityPanelExtraSection[];
  /** Suppress the Activity/Files rail tabs and render only the activity stack. */
  readonly hideTabs?: boolean;
  /**
   * `stack` is the rail of collapsible, reorderable section cards. `card` is
   * the Activity card's content: one row per section that opens the section
   * in place. `card` implies `hideTabs`.
   */
  readonly layout?: 'stack' | 'card';
  /**
   * Opens a card row's section in its own panel instead of expanding it in
   * the card; `false` keeps the in-place expansion for that section.
   */
  readonly onOpenCardSection?: (sectionId: string) => boolean;
  /** Controlled ordering seam for hosts with their own persistence model. */
  readonly sectionOrder?: readonly string[];
  readonly onSectionOrderChange?: (order: readonly string[]) => void;
  /**
   * Render only one built-in section body, without rail/card chrome.
   * Activity cards use this seam so their body follows the exact same switch,
   * hydration rules, snapshot inputs, capabilities, and host actions as the
   * full ActivityPanel.
   */
  readonly sectionBodyOnly?: ActivitySectionId;
}

export type ActivitySectionBodyProps = Omit<
  ActivityPanelProps,
  | 'sectionBodyOnly'
  | 'hideTabs'
  | 'layout'
  | 'onOpenCardSection'
  | 'sectionOrder'
  | 'onSectionOrderChange'
> & {
  readonly sectionId: ActivitySectionId;
};

/** Renders one built-in activity body through ActivityPanel's canonical path. */
export function ActivitySectionBody({
  sectionId,
  ...props
}: ActivitySectionBodyProps): JSX.Element {
  return <ActivityPanel {...props} sectionBodyOnly={sectionId} />;
}

export interface ActivityPanelSectionOverride {
  readonly body?: ReactNode | (() => ReactNode);
  readonly title?: ReactNode;
  readonly icon?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly subtitleInline?: boolean;
  readonly subtitleGap?: SpaceRole;
  /**
   * Render-only trailing node placed in the section header row (e.g. a
   * Scripts/Hooks settings gear). Ephemeral React only — never serialized or
   * persisted. `undefined` falls through to the extra/default value; `null`
   * renders no action.
   */
  readonly headerAction?: ReactNode;
  readonly collapsedIconColor?: CollapsedIconColor;
  /** Whether this host-projected section has meaningful content to display. */
  readonly hasContent?: boolean;
  /** Keep an empty section visible because it still offers an action. */
  readonly hasAction?: boolean;
  /** Render the supplied body as the complete clickable card. */
  readonly actionCard?: boolean;
  /**
   * The empty section's one action (Generate summary, Add MCP server). The
   * card layout runs it from the row instead of opening a page that would
   * hold only that button.
   */
  readonly onAction?: () => void;
  /** What the empty section offers (Import plan); names its card row. */
  readonly actionLabel?: string;
  /**
   * The card row's short state (`2`, `9h ago`, `+133 -8`); defaults to the
   * subtitle.
   */
  readonly cardValue?: ReactNode;
  readonly hidden?: boolean;
  readonly defaultCollapsed?: boolean;
  /** Preserve the body subtree when collapsed so its header action stays live. */
  readonly keepBodyMountedWhenCollapsed?: boolean;
  /**
   * Host reveal request: each new value expands the section if the user
   * collapsed it (for example, when the host just started a pipeline run).
   */
  readonly expandRequest?: number;
  readonly dataTestId?: string;
}

export interface ActivityPanelExtraSection {
  /** Hide the card while retaining its body subscriptions. */
  readonly hiddenWhileMounted?: boolean;
  /** What the empty section offers (Add note); names its card row. */
  readonly actionLabel?: string;
  /** The card row's short state; defaults to the subtitle. */
  readonly cardValue?: ReactNode;
  readonly key: string;
  readonly title: ReactNode;
  readonly icon?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly subtitleInline?: boolean;
  readonly subtitleGap?: SpaceRole;
  /** Render-only trailing header node; see {@link ActivityPanelSectionOverride.headerAction}. */
  readonly headerAction?: ReactNode;
  readonly collapsedIconColor?: CollapsedIconColor;
  /** Whether this host-only section has meaningful content to display. */
  readonly hasContent?: boolean;
  /** Keep an empty section visible because it still offers an action. */
  readonly hasAction?: boolean;
  /** Render the supplied body as the complete clickable card. */
  readonly actionCard?: boolean;
  readonly body: ReactNode | (() => ReactNode);
  readonly defaultCollapsed?: boolean;
  /** Preserve the body subtree when collapsed so its header action stays live. */
  readonly keepBodyMountedWhenCollapsed?: boolean;
  readonly dataTestId?: string;
}

/**
 * Every input the section-presence predicates read, mirroring the matching
 * {@link ActivityPanelProps} fields.
 *
 * Exported as a plain object rather than only reachable through the mounted
 * panel because a host sometimes needs the answer while the panel is
 * UNMOUNTED — web's mobile layout hides the Activity toolbar button when the
 * rail holds nothing, and the drawer only mounts the panel once opened.
 */
export interface ActivitySectionPresenceInput {
  readonly snapshot: SessionViewModel | null;
  readonly workspaceLocalId: string;
  readonly worktreeLocalId: string;
  readonly selectedChatId?: string;
  readonly worktreeSummaries?: readonly PortalWorktreeSummaryEntity[];
  readonly todoLists?: readonly PortalChatTodoProjection[];
  /**
   * The sections this target's client implements
   * ({@link CanopyCapabilities.activitySectionIds}), resolved per target by
   * the host. Absent keeps every section the workspace type shows; a list
   * narrows that set, host-owned extras included.
   */
  readonly activitySectionIds?: readonly string[];
  readonly hydrating?: boolean;
  /** Host capability gating the observed-cost section (default-deny). */
  readonly costInsightsEnabled?: boolean;
  readonly showTerminals?: boolean;
  readonly summaryGenerating?: boolean;
  readonly summaryRefreshEnabled?: boolean;
  /**
   * Host supplied `hostActions.onRefreshSummary`. That makes Summary RENDER
   * regardless of data, so it is deliberately a visibility input only and
   * never counts as content.
   */
  readonly summaryRefreshAvailable?: boolean;
  readonly changedFilesSection?: ChangedFilesSectionHostModel;
  /** Host-projected tasks and actions. Absent means the empty state. */
  readonly backgroundTasksSection?: BackgroundTasksSectionHostModel;
  readonly scriptsSection?: ScriptsSectionHostModel;
  readonly hooksSection?: HooksSectionHostModel;
  readonly sectionOverrides?: Readonly<
    Record<string, ActivityPanelSectionOverride | undefined>
  >;
  readonly extraSections?: readonly ActivityPanelExtraSection[];
}

function presenceWorkspaceType(
  input: ActivitySectionPresenceInput,
): ActivityWorkspaceType | undefined {
  return input.snapshot?.workspaces.find(
    (candidate) => candidate.localId === input.workspaceLocalId,
  )?.type;
}

/** Build the descriptor-facing context from the presence inputs. */
function presenceSectionContext(
  input: ActivitySectionPresenceInput,
): ActivitySectionContext {
  const effectiveTodoLists = input.todoLists ?? input.snapshot?.todoLists;
  const todoItems =
    input.selectedChatId === undefined
      ? []
      : (effectiveTodoLists?.find(
          (todo) =>
            todo.workspaceLocalId === input.workspaceLocalId &&
            todo.worktreeLocalId === input.worktreeLocalId &&
            todo.chatId === input.selectedChatId &&
            // Protocol identity contract: todo-list localId equals its chatId.
            todo.localId === input.selectedChatId,
        )?.items ?? []);
  return {
    snapshot: input.snapshot,
    backgroundTasks:
      input.backgroundTasksSection?.tasks ?? EMPTY_BACKGROUND_TASKS,
    worktreeSummaries:
      input.worktreeSummaries ?? input.snapshot?.worktreeSummaries,
    workspaceLocalId: input.workspaceLocalId,
    worktreeLocalId: input.worktreeLocalId,
    selectedChatId: input.selectedChatId,
    todoItems,
    hydrating: input.hydrating === true,
  };
}

/**
 * Every section id this workspace could hold, ignoring order: the resolved
 * built-in order plus any host-only extras.
 *
 * Content presence is an `Array.some`, so it is order-independent — a host
 * asking only "does this rail hold anything?" never has to reproduce the
 * panel's reordering rules.
 */
export function activitySectionPresenceIds(
  input: ActivitySectionPresenceInput,
): string[] {
  const workspace = input.snapshot?.workspaces.find(
    (candidate) => candidate.localId === input.workspaceLocalId,
  );
  return Array.from(
    new Set([
      ...resolveActivitySectionOrder(workspace?.activitySectionOrder),
      ...(input.extraSections ?? []).map((section) => section.key),
      // `sectionPassesGate` admits an id that exists only as an override, so
      // omitting them here would let a host declare a section this predicate
      // cannot see — and have its rail collapsed out from under that section.
      // The two must agree on the id universe.
      ...Object.keys(input.sectionOverrides ?? {}),
    ]),
  );
}

/** Shared prelude: id is known, not hidden, and allowed for this workspace. */
function sectionPassesGate(
  id: string,
  input: ActivitySectionPresenceInput,
): boolean {
  // The `extraSections` scan is reached only for an id that is NOT a built-in
  // section, which is the rare case. Hoisting it above this guard — as it was
  // — made every built-in id pay a linear walk of the extras on all three of
  // this predicate's callers, for a result the guard then ignored.
  if (!isActivitySectionId(id)) {
    const isExtra =
      input.extraSections?.some((section) => section.key === id) === true;
    if (!isExtra && input.sectionOverrides?.[id] === undefined) {
      return false;
    }
  }
  if (id === 'cost' && input.costInsightsEnabled !== true) return false;
  if (input.sectionOverrides?.[id]?.hidden === true) return false;
  // A repoless (`cowork`) workspace — cloud-backed ones included, which lay
  // out as a tree and so reach this rail — has no diff, PR, plan, script, or
  // hook behind the code-only sections (CAN-2337). Classification only; row
  // placement still reads `layout`. The target's client then narrows what the
  // type shows to the sections it implements, so a repository project is not
  // offered controls its client has no reader for (REG-3022).
  return isActivitySectionVisibleForTarget(id, presenceWorkspaceType(input), {
    activitySectionIds: input.activitySectionIds,
  });
}

function sectionRendersWith(
  id: string,
  input: ActivitySectionPresenceInput,
  context: ActivitySectionContext,
): boolean {
  if (!sectionPassesGate(id, input)) return false;
  if (id === 'terminals' && input.showTerminals === true) return true;
  const sectionOverride = input.sectionOverrides?.[id];
  if (sectionOverride?.hasContent !== undefined) {
    return (
      sectionOverride.hasContent ||
      sectionOverride.hasAction === true ||
      sectionOverride.headerAction != null
    );
  }
  const extra = input.extraSections?.find((section) => section.key === id);
  if (extra?.hasContent !== undefined) {
    return (
      extra.hasContent || extra.hasAction === true || extra.headerAction != null
    );
  }
  if (sectionOverride?.headerAction != null || extra?.headerAction != null) {
    return true;
  }
  // A custom body is opaque to the shared rail and remains visible unless
  // its host supplies the explicit content signal above.
  if (sectionOverride?.body !== undefined || extra !== undefined) return true;
  if (id === 'summary') {
    return (
      input.summaryGenerating === true ||
      (input.summaryRefreshAvailable === true &&
        (input.summaryRefreshEnabled ?? true)) ||
      selectWorktreeItems(context.worktreeSummaries, input.worktreeLocalId)
        .length > 0
    );
  }
  if (id === 'changed-files' && input.changedFilesSection) {
    return changedFilesHaveContent(input.changedFilesSection.changedFiles);
  }
  if (id === 'scripts' && input.scriptsSection) {
    return input.scriptsSection.entries.length > 0;
  }
  if (id === 'hooks' && input.hooksSection) {
    return (
      input.hooksSection.entries.length > 0 ||
      input.hooksSection.unconfiguredWatchers.length > 0
    );
  }
  return isActivitySectionId(id)
    ? ACTIVITY_SECTION_DESCRIPTORS[id].hasUsableData(context)
    : false;
}

function sectionHasContentWith(
  id: string,
  input: ActivitySectionPresenceInput,
  context: ActivitySectionContext,
): boolean {
  if (!sectionPassesGate(id, input)) return false;
  const sectionOverride = input.sectionOverrides?.[id];
  if (sectionOverride?.hasContent !== undefined) {
    return sectionOverride.hasContent;
  }
  const extra = input.extraSections?.find((section) => section.key === id);
  if (extra?.hasContent !== undefined) return extra.hasContent;
  // Still opaque without an explicit signal, so still answered conservatively:
  // a host-rendered body we cannot inspect counts as content rather than
  // silently collapsing a rail that is showing something.
  if (sectionOverride?.body !== undefined || extra !== undefined) return true;
  if (id === 'summary') {
    return (
      input.summaryGenerating === true ||
      selectWorktreeItems(context.worktreeSummaries, input.worktreeLocalId)
        .length > 0
    );
  }
  if (id === 'changed-files' && input.changedFilesSection) {
    return changedFilesHaveContent(input.changedFilesSection.changedFiles);
  }
  if (id === 'scripts' && input.scriptsSection) {
    // Configured-but-never-run counts: a configured script is worth seeing.
    return input.scriptsSection.entries.length > 0;
  }
  if (id === 'hooks' && input.hooksSection) {
    return (
      input.hooksSection.entries.length > 0 ||
      input.hooksSection.unconfiguredWatchers.length > 0
    );
  }
  return isActivitySectionId(id)
    ? ACTIVITY_SECTION_DESCRIPTORS[id].hasUsableData(context)
    : false;
}

/**
 * Whether the rail renders a card for this id at all — the panel's own
 * visibility filter, behaviour unchanged.
 *
 * Four of its branches mean "renders anyway, regardless of data": forced
 * terminals, hydration, a host action with no explicit content signal, and
 * Summary's refresh affordance. That is exactly why
 * {@link activitySectionHasContent} is a separate question.
 */
export function activitySectionRenders(
  id: string,
  input: ActivitySectionPresenceInput,
): boolean {
  return sectionRendersWith(id, input, presenceSectionContext(input));
}

/**
 * Whether this section actually holds something, as opposed to merely being
 * visible. `showTerminals`, `hydrating`, a bare `headerAction`/`hasAction`,
 * and `onRefreshSummary` all keep a card on screen while it is empty, and none
 * of them answer `true` here.
 *
 * `hydrating` is UNRESOLVED, not empty: callers that act on emptiness (web's
 * auto-collapse) must hold their decision while the host is still hydrating
 * rather than read the `false` this returns as a settled answer.
 */
export function activitySectionHasContent(
  id: string,
  input: ActivitySectionPresenceInput,
): boolean {
  return sectionHasContentWith(id, input, presenceSectionContext(input));
}

/**
 * Whether ANY section holds content — the "is this rail worth showing?"
 * predicate.
 *
 * Deliberately keyed on content rather than on visibility: keying on
 * visibility would require unforcing Terminals and Summary, overturning
 * CAN-2337 and changing the Remote Control surface. Cards that render anyway
 * keep rendering exactly as today; they just do not count.
 *
 * @param order optional explicit id set; defaults to
 * {@link activitySectionPresenceIds}.
 */
export function activityPanelHasContent(
  input: ActivitySectionPresenceInput,
  order?: readonly string[],
): boolean {
  const context = presenceSectionContext(input);
  const ids = order ?? activitySectionPresenceIds(input);
  return ids.some((id) => sectionHasContentWith(id, input, context));
}

/**
 * Where a retained section body shows: its expanded card row, or a hidden
 * slot while collapsed. The body renders once, through a portal into `node`,
 * and only `node` moves between slots, so its local state (Memory's edit
 * draft) survives collapse and expand.
 */
function RetainedBodySlot({
  node,
}: {
  readonly node: HTMLElement;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    host.appendChild(node);
    return (): void => {
      if (node.parentNode === host) host.removeChild(node);
    };
  }, [node]);
  return <div ref={hostRef} className="contents" />;
}

export function ActivityPanel({
  workspaceLocalId,
  worktreeLocalId,
  selectedChatId,
  worktreeSummaries,
  todoLists,
  summaryRefreshEnabled,
  summaryGenerating,
  scriptsSection,
  hooksSection,
  changedFilesSection,
  loadingMoreChangedFiles,
  backgroundTasksSection,
  onSelectFile,
  onRevertFile,
  fileTreeRootKey,
  fileRootLocalId,
  fileRoots,
  activeFileRootLocalId,
  appManagedFileRootsLabel,
  fileTreeDir,
  filesEmptyState,
  filesStatusBar,
  filesDownloadNotice,
  hydrating,
  onOpenFile,
  onOpenDirectory,
  onDownloadFile,
  canDownloadFile,
  downloadError,
  hostActions,
  showTerminals,
  testIds,
  touchTarget,
  onTabChange,
  sectionOverrides,
  extraSections = [],
  hideTabs = false,
  layout = 'stack',
  onOpenCardSection,
  sectionOrder,
  onSectionOrderChange,
  sectionBodyOnly,
}: ActivityPanelProps): JSX.Element {
  const [tab, setTab] = useState<ActivityTab>('activity');
  const [expandedCardKeys, setExpandedCardKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // The card's retained section bodies, one detached node per section (see
  // `RetainedBodySlot`).
  const retainedBodyNodesRef = useRef(new Map<string, HTMLElement>());
  const retainedBodyNode = (id: string): HTMLElement | null => {
    if (typeof document === 'undefined') return null;
    const existing = retainedBodyNodesRef.current.get(id);
    if (existing) return existing;
    const node = document.createElement('div');
    node.style.display = 'contents';
    retainedBodyNodesRef.current.set(id, node);
    return node;
  };
  const toggleCardSection = (key: string): void => {
    setExpandedCardKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const handleTabChange = (nextTab: ActivityTab): void => {
    setTab(nextTab);
    onTabChange?.(nextTab);
  };
  const capabilities = useCapabilities();
  // Per target: a composite client reports a different section set per
  // workspace, which its union `capabilities` cannot say.
  const { activitySectionIds } = useWorkspaceCapabilities(workspaceLocalId);
  const snapshot = useActivityStore((state) => state.snapshot);
  const workspace = snapshot?.workspaces.find(
    (candidate) => candidate.localId === workspaceLocalId,
  );
  // Repository names show for a multi-repo workspace, and whenever this
  // worktree's lists span more than one repository (a cloud worktree's rows
  // carry their repository, REG-3024), so the same path in two repositories
  // never renders as two identical rows.
  const worktreeChangedFiles = snapshot?.changedFiles[worktreeLocalId];
  const showChangedFileRepoNames =
    workspace?.type === 'multi-repo' ||
    new Set(
      [
        ...(worktreeChangedFiles?.uncommitted ?? []),
        ...(worktreeChangedFiles?.committed ?? []),
      ].flatMap((file) => (file.repoId === undefined ? [] : [file.repoId])),
    ).size > 1;
  const override = useActivityStore(
    (state) => state.sectionOrderOverrides[workspaceLocalId],
  );
  // eslint-disable-next-line @typescript-eslint/unbound-method -- closure-based zustand action, safe detached.
  const setSectionOrder = useActivityStore((state) => state.setSectionOrder);

  // Mirrors the store's `selectSectionOrder` (override → snapshot → default),
  // but memoized over the two reactively-selected inputs rather than called as
  // a zustand selector: `selectSectionOrder` returns a fresh array each call,
  // which would break referential equality and re-render on every store tick.
  const storedOrder = useMemo<string[]>(() => {
    if (override) {
      return [...override];
    }
    return resolveActivitySectionOrder(workspace?.activitySectionOrder);
  }, [override, workspace]);
  const availableKeys = useMemo(
    () =>
      Array.from(
        new Set([
          ...storedOrder,
          ...extraSections.map((section) => section.key),
        ]),
      ),
    [extraSections, storedOrder],
  );
  const order = useMemo<string[]>(() => {
    if (!sectionOrder) return availableKeys;
    const available = new Set(availableKeys);
    const controlled = sectionOrder.filter((key) => available.has(key));
    const controlledSet = new Set(controlled);
    return [
      ...controlled,
      ...availableKeys.filter((key) => !controlledSet.has(key)),
    ];
  }, [availableKeys, sectionOrder]);
  const terminals = selectWorktreeItems(
    snapshot?.terminalSessions,
    worktreeLocalId,
  );
  const effectiveWorktreeSummaries =
    worktreeSummaries ?? snapshot?.worktreeSummaries;
  const effectiveTodoLists = todoLists ?? snapshot?.todoLists;
  // Built once and shared with the exported predicates so the panel and any
  // host asking "does this rail hold anything?" run the SAME implementation.
  const presenceInput: ActivitySectionPresenceInput = {
    snapshot,
    workspaceLocalId,
    worktreeLocalId,
    selectedChatId,
    worktreeSummaries: effectiveWorktreeSummaries,
    todoLists: effectiveTodoLists,
    activitySectionIds,
    hydrating,
    costInsightsEnabled: capabilities.costInsights === true,
    showTerminals,
    summaryGenerating,
    summaryRefreshEnabled,
    summaryRefreshAvailable: hostActions?.onRefreshSummary !== undefined,
    changedFilesSection,
    backgroundTasksSection,
    scriptsSection,
    hooksSection,
    sectionOverrides,
    extraSections,
  };
  const sectionContext: ActivitySectionContext =
    presenceSectionContext(presenceInput);
  const todoItems = sectionContext.todoItems;
  const selectChangedFile =
    hostActions?.onOpenCode ??
    (onSelectFile
      ? (selection: PortalCodeViewerSelection): void =>
          onSelectFile(selection.title)
      : undefined);
  const visibleOrder = order.filter((id) =>
    sectionRendersWith(id, presenceInput, sectionContext),
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: ACTIVITY_POINTER_DRAG_ACTIVATION_CONSTRAINT,
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over) {
      return;
    }
    const activeId = String(active.id);
    const overId = String(over.id);
    if (
      activeId === overId ||
      !visibleOrder.includes(activeId) ||
      !visibleOrder.includes(overId)
    ) {
      return;
    }
    const oldIndex = visibleOrder.indexOf(activeId);
    const newIndex = visibleOrder.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) {
      return;
    }
    const nextOrder = mergeVisibleOrder(
      order,
      arrayMove(visibleOrder, oldIndex, newIndex),
    );
    if (onSectionOrderChange) {
      onSectionOrderChange(nextOrder);
      return;
    }
    setSectionOrder(workspaceLocalId, nextOrder);
  };

  const renderSectionBody = (id: ActivitySectionId): ReactNode => {
    // While the host is still hydrating, an empty section is indistinguishable
    // from a not-yet-delivered one — show a loading placeholder instead of a
    // false empty state (CAN-750 review; replaces the deleted web-local
    // hydration handling). Gate on the descriptor's data-presence predicate,
    // not the subtitle count: Scripts/Hooks orphan/active runs count as usable
    // data (so their run rows render during hydration) even though such runs
    // are excluded from the `N configured` subtitle count.
    if (
      hydrating &&
      !ACTIVITY_SECTION_DESCRIPTORS[id].hasUsableData({
        ...sectionContext,
        hydrating: true,
      })
    ) {
      return <ActivitySectionSkeleton id={id} />;
    }
    switch (id) {
      case 'summary': {
        const projectedSummary = selectWorktreeItems(
          effectiveWorktreeSummaries,
          worktreeLocalId,
        )[0];
        if (!projectedSummary) return null;
        const projectedGenerating = projectedSummary.generating === true;
        return (
          <SummarySectionBody
            {...portalSummaryToSectionBodyProps(projectedSummary)}
            generating={summaryGenerating ?? projectedGenerating}
            refreshEnabled={
              summaryRefreshEnabled ??
              hostActions?.onRefreshSummary !== undefined
            }
            onRefresh={hostActions?.onRefreshSummary}
          />
        );
      }
      case 'changed-files':
        if (changedFilesSection) {
          const { supplementaryContent, ...bodyProps } = changedFilesSection;
          return (
            <>
              <ChangedFilesSection {...bodyProps} />
              {supplementaryContent}
            </>
          );
        }
        {
          const changedFiles = snapshot?.changedFiles[worktreeLocalId];
          const page = changedFiles?.page;
          const hasMore = page
            ? {
                uncommitted: page.uncommitted.nextCursor !== undefined,
                committed: page.committed.nextCursor !== undefined,
              }
            : undefined;
          return (
            <ChangedFilesSection
              changedFiles={changedFiles}
              canRevert={capabilities.fileSystemAccess === 'read-write'}
              workspaceLocalId={workspaceLocalId}
              worktreeLocalId={worktreeLocalId}
              showRepoName={showChangedFileRepoNames}
              hasMore={hasMore}
              loadingMore={loadingMoreChangedFiles}
              onLoadMore={
                hostActions?.onLoadMoreChangedFiles
                  ? (group): void =>
                      hostActions.onLoadMoreChangedFiles?.(
                        worktreeLocalId,
                        group,
                      )
                  : undefined
              }
              onSelectFile={selectChangedFile}
              onRevertFile={
                (hostActions?.onRevertFile ?? onRevertFile)
                  ? (row): void => {
                      const revert = hostActions?.onRevertFile ?? onRevertFile;
                      revert?.(row.filePath);
                    }
                  : undefined
              }
              openDataTestId={testIds?.changedFileOpen}
            />
          );
        }
      case 'pull-request':
        return (
          <PullRequestSection
            prStatus={snapshot?.prStatuses[worktreeLocalId]}
          />
        );
      case 'plans':
        return (
          <PlansSection
            plans={selectWorktreeItems(snapshot?.plans, worktreeLocalId)}
            onGetPlan={hostActions?.onGetPlan}
            onImplementPlan={hostActions?.onImplementPlan}
            onRunPlanPipeline={hostActions?.onRunPlanPipeline}
          />
        );
      case 'pipeline-runs':
        return (
          <PipelineRunsSection
            runs={selectWorktreeItems(snapshot?.pipelineRuns, worktreeLocalId)}
          />
        );
      case 'cost':
        // The desktop host supplies this body with one shared scope store;
        // hosts without that capability never pass the presence gate.
        return null;
      case 'scripts': {
        if (scriptsSection) {
          const { supplementaryContent, ...bodyProps } = scriptsSection;
          return (
            <>
              {scriptsSection.entries.length > 0 && (
                <ScriptsSectionBody {...bodyProps} />
              )}
              {supplementaryContent}
            </>
          );
        }
        const runs = selectWorktreeItems(snapshot?.scriptRuns, worktreeLocalId);
        const descriptors = selectWorktreeItems(
          snapshot?.scriptDescriptors,
          worktreeLocalId,
        );
        const model = portalScriptsToSectionModel(descriptors, runs);
        const descriptorsByKey = new Map(
          descriptors.map((descriptor) => [descriptor.scriptKey, descriptor]),
        );
        const latestRuns = latestRunsByKey<PortalScriptRunProjection>(
          runs,
          (run) => run.scriptKey,
        );
        return (
          <ScriptsSectionBody
            identityKey={`${workspaceLocalId}/${worktreeLocalId}`}
            entries={model.entries}
            runs={model.runs}
            onRun={
              hostActions?.onRunScript
                ? (entry): Promise<void> => {
                    const descriptor = descriptorsByKey.get(
                      entry.script.scriptKey,
                    );
                    return Promise.resolve().then((): void | Promise<void> => {
                      if (descriptor !== undefined) {
                        return hostActions.onRunScript?.(descriptor);
                      }
                    });
                  }
                : undefined
            }
            onStop={
              hostActions?.onCancelScript
                ? (scriptKey): void | Promise<void> => {
                    const run = latestRuns.get(scriptKey);
                    if (run !== undefined) {
                      return hostActions.onCancelScript?.(run);
                    }
                  }
                : undefined
            }
            groupWorkspaceLifecycles={false}
          />
        );
      }
      case 'hooks': {
        if (hooksSection) {
          const { supplementaryContent, ...bodyProps } = hooksSection;
          return (
            <>
              {(bodyProps.entries.length > 0 ||
                bodyProps.unconfiguredWatchers.length > 0) && (
                <HooksSectionBody {...bodyProps} />
              )}
              {supplementaryContent}
            </>
          );
        }
        const runs = selectWorktreeItems(snapshot?.hookRuns, worktreeLocalId);
        const descriptors = selectWorktreeItems(
          snapshot?.hookDescriptors,
          worktreeLocalId,
        );
        const model = portalHooksToSectionModel(descriptors, runs);
        const descriptorsByKey = new Map(
          descriptors.map((descriptor) => [descriptor.hookKey, descriptor]),
        );
        const latestRuns = latestRunsByKey<PortalHookRunProjection>(
          runs,
          (run) => run.hookKey,
        );
        return (
          <HooksSectionBody
            identityKey={`${workspaceLocalId}/${worktreeLocalId}`}
            entries={model.entries}
            runs={model.runs}
            unconfiguredWatchers={model.unconfiguredWatchers}
            onRun={
              hostActions?.onRunHook
                ? (entry): Promise<void> => {
                    const descriptor = descriptorsByKey.get(entry.hook.hookKey);
                    return Promise.resolve().then((): void => {
                      if (descriptor !== undefined) {
                        return hostActions.onRunHook?.(descriptor);
                      }
                    });
                  }
                : undefined
            }
            onStop={
              hostActions?.onCancelHook
                ? (hookKey): void => {
                    const run = latestRuns.get(hookKey);
                    if (run !== undefined) {
                      hostActions.onCancelHook?.(run);
                    }
                  }
                : undefined
            }
            onTogglePause={
              hostActions?.onToggleHookPause
                ? (hookKey): void => {
                    const descriptor = descriptorsByKey.get(hookKey);
                    if (descriptor !== undefined) {
                      hostActions.onToggleHookPause?.(descriptor);
                    }
                  }
                : undefined
            }
            // Match scripts adoption: portal omits the desktop output modal.
            renderOutputModal={undefined}
          />
        );
      }
      case 'background-processes': {
        const tasks = backgroundTasksSection?.tasks ?? EMPTY_BACKGROUND_TASKS;
        return (
          <>
            {tasks.length > 0 ? (
              <BackgroundTasksList
                tasks={tasks}
                actions={backgroundTasksSection?.actions}
              />
            ) : (
              <ItemListSection
                dataTestId="activity-background"
                emptyLabel="No background processes."
                items={[]}
              />
            )}
            {backgroundTasksSection?.supplementaryContent}
          </>
        );
      }
      case 'mcp-servers':
        return (
          <McpServersSectionBody
            servers={selectWorktreeItems(
              snapshot?.mcpServers,
              worktreeLocalId,
            ).map(portalMcpServerToSectionItem)}
            warnings={[]}
            loading={false}
            error={null}
            connectingKey={null}
            showProxyToggle={false}
            brandAppName=""
            proxyLogo={null}
            emptyLabel="No MCP servers."
          />
        );
      case 'todo':
        return <TodoSectionBody items={todoItems} resetKey={selectedChatId} />;
      case 'terminals':
        return (
          <ItemListSection
            dataTestId="activity-terminals"
            emptyLabel="No terminals."
            items={terminals.map((terminal) => ({
              key: terminal.localId,
              label: terminal.title ?? terminal.cwd ?? 'Terminal',
              status: terminal.running ? 'running' : 'exited',
              detail: terminal.buffer,
              actionLabel: 'Open',
              onAction: hostActions?.onOpenTerminal
                ? (): void => hostActions.onOpenTerminal?.(terminal)
                : undefined,
            }))}
          />
        );
      default:
        id satisfies never;
        return null;
    }
  };

  const renderBody = (id: string): ReactNode => {
    const overrideBody = sectionOverrides?.[id]?.body;
    if (overrideBody !== undefined) {
      return typeof overrideBody === 'function' ? overrideBody() : overrideBody;
    }
    const extra = extraSections.find((section) => section.key === id);
    if (extra) {
      return typeof extra.body === 'function' ? extra.body() : extra.body;
    }
    return isActivitySectionId(id) ? renderSectionBody(id) : null;
  };

  // All hooks above run unconditionally (React hook-order rules); body-only
  // mode simply skips the rail/card chrome at render time.
  if (sectionBodyOnly !== undefined) {
    return <>{renderSectionBody(sectionBodyOnly)}</>;
  }

  // Field-by-field resolution shared by both layouts: a body-only or
  // action-only override must not suppress the built-in title, icon,
  // subtitle, or tone. `undefined` falls through to the next value; for
  // headerAction a `null` override renders no action instead of falling
  // through.
  const defaultHeaderActionFor = (id: string): ReactNode => {
    if (id === 'hooks' && hostActions?.onToggleAllHooksPause) {
      const hooks = selectWorktreeItems(
        snapshot?.hookDescriptors,
        worktreeLocalId,
      );
      if (hooks.length === 0) return undefined;
      const allPaused = hooks.every((hook) => hook.paused === true);
      return (
        <PauseToggleButton
          paused={allPaused}
          onClick={(): void => hostActions.onToggleAllHooksPause?.(!allPaused)}
          label={allPaused ? 'Resume all hooks' : 'Pause all hooks'}
        />
      );
    }
    if (id === 'changed-files' && hostActions?.onReviewChanges) {
      const changedFiles = snapshot?.changedFiles[worktreeLocalId];
      const hasChanges =
        (changedFiles?.uncommitted.length ?? 0) +
          (changedFiles?.committed.length ?? 0) >
        0;
      if (!hasChanges) return undefined;
      return (
        <HeaderActionButton
          iconOnly
          data-testid="review-changes-button"
          aria-label="Review changes"
          onClick={(event): void => {
            event.stopPropagation();
            hostActions.onReviewChanges?.();
          }}
        >
          <EyeIcon size={16} />
        </HeaderActionButton>
      );
    }
    if (id === 'summary' && hostActions?.onRefreshSummary) {
      const summary = selectWorktreeItems(
        effectiveWorktreeSummaries,
        worktreeLocalId,
      )[0];
      const snapshotGenerating = summary?.generating === true;
      const generating = summaryGenerating ?? snapshotGenerating;
      const refreshEnabled = summaryRefreshEnabled ?? true;
      if (!refreshEnabled && !generating) return undefined;
      return (
        <RefreshButton
          onClick={hostActions.onRefreshSummary}
          disabled={!refreshEnabled || generating}
          busy={generating}
          ariaLabel={generating ? 'Refreshing summary' : 'Refresh summary'}
        />
      );
    }
    return undefined;
  };
  const resolveSectionChrome = (
    id: string,
  ): {
    readonly title: ReactNode;
    readonly icon: ReactNode;
    readonly subtitle: ReactNode;
    readonly headerAction: ReactNode;
  } => {
    const extra = extraSections.find((section) => section.key === id);
    const sectionOverride = sectionOverrides?.[id];
    // Built-in sections always resolve their chrome through the descriptor
    // record; host-only extras have no descriptor.
    const descriptor = isActivitySectionId(id)
      ? ACTIVITY_SECTION_DESCRIPTORS[id]
      : undefined;
    return {
      title:
        sectionOverride?.title ??
        extra?.title ??
        (isActivitySectionId(id) ? ACTIVITY_SECTION_DESCRIPTORS[id].title : id),
      icon: sectionOverride?.icon ?? extra?.icon ?? descriptor?.icon ?? null,
      subtitle:
        sectionOverride?.subtitle !== undefined
          ? sectionOverride.subtitle
          : extra?.subtitle !== undefined
            ? extra.subtitle
            : descriptor?.subtitle(sectionContext),
      headerAction:
        sectionOverride?.headerAction !== undefined
          ? sectionOverride.headerAction
          : extra?.headerAction !== undefined
            ? extra.headerAction
            : defaultHeaderActionFor(id),
    };
  };

  /**
   * The card row's trailing state when the host gives no short value.
   * Plain-text subtitles carry over; Agent tasks draws a progress bar in the
   * rail, so the row states its count.
   */
  const cardRowValue = (
    id: string,
    subtitle: ReactNode,
  ): string | undefined => {
    if (id === 'todo') {
      if (todoItems.length === 0) return undefined;
      const completed = todoItems.filter(
        (item) => item.status === 'completed',
      ).length;
      return `${completed}/${todoItems.length}`;
    }
    return typeof subtitle === 'string' && subtitle !== ''
      ? subtitle
      : undefined;
  };

  const renderActivityCard = (): JSX.Element => {
    // A section hidden while it reports nothing (Memory) gets no row, but its
    // body stays mounted, hidden, so it can report content and earn one.
    const hiddenWhileMounted = visibleOrder.filter(
      (id) =>
        extraSections.find((section) => section.key === id)
          ?.hiddenWhileMounted === true,
    );
    // A section that keeps its body mounted (Memory, to keep following
    // changes) renders it once and keeps it while its row is collapsed, as
    // the stack does.
    const retainedBodies = new Map<string, HTMLElement>();
    for (const id of visibleOrder) {
      const retained =
        hiddenWhileMounted.includes(id) ||
        (sectionOverrides?.[id]?.keepBodyMountedWhenCollapsed ??
          extraSections.find((section) => section.key === id)
            ?.keepBodyMountedWhenCollapsed) === true;
      const node = retained ? retainedBodyNode(id) : null;
      if (node) retainedBodies.set(id, node);
    }
    const rows: ActivityCardRow[] = visibleOrder
      .filter((id) => !hiddenWhileMounted.includes(id))
      .map((id): ActivityCardRow => {
        const chrome = resolveSectionChrome(id);
        const hasContent = sectionHasContentWith(
          id,
          presenceInput,
          sectionContext,
        );
        const block = ACTIVITY_CARD_SETUP_SECTIONS.has(id) ? 'setup' : 'work';
        const group: ActivityCardRowGroup = hasContent ? block : 'add';
        // An empty section's host title names its action (Add MCP server);
        // every other row names its section.
        const actionTitle = hasContent
          ? undefined
          : (sectionOverrides?.[id]?.actionLabel ??
            extraSections.find((section) => section.key === id)?.actionLabel);
        return {
          key: id,
          group,
          block,
          title: actionTitle ?? ACTIVITY_CARD_TITLES[id] ?? chrome.title,
          icon: chrome.icon,
          value: hasContent
            ? (sectionOverrides?.[id]?.cardValue ??
              extraSections.find((section) => section.key === id)?.cardValue ??
              cardRowValue(id, chrome.subtitle))
            : undefined,
          headerAction: chrome.headerAction,
          renderBody: (): ReactNode => {
            const node = retainedBodies.get(id);
            return node ? <RetainedBodySlot node={node} /> : renderBody(id);
          },
          onActivate: hasContent ? undefined : sectionOverrides?.[id]?.onAction,
        };
      });
    // Retained bodies not shown in an expanded row wait in a hidden slot.
    const parked = [...retainedBodies].filter(
      ([id]) => hiddenWhileMounted.includes(id) || !expandedCardKeys.has(id),
    );
    return (
      <div className="min-w-0" data-testid="activity-panel">
        <ActivityCardView
          rows={rows}
          expandedKeys={expandedCardKeys}
          onToggleExpanded={toggleCardSection}
          onOpenSection={onOpenCardSection}
        />
        {parked.map(([id, node]) => (
          <div key={id} hidden>
            <RetainedBodySlot node={node} />
          </div>
        ))}
        {[...retainedBodies].map(([id, node]) =>
          createPortal(
            <ActivityCardStyle>{renderBody(id)}</ActivityCardStyle>,
            node,
            id,
          ),
        )}
        {/* Without a DOM (server render), hidden bodies render in place. */}
        {typeof document === 'undefined'
          ? hiddenWhileMounted.map((id) => (
              <div key={id} hidden>
                {renderBody(id)}
              </div>
            ))
          : null}
      </div>
    );
  };

  const renderActivityStack = (): JSX.Element => (
    <OverlayScrollArea
      className="min-h-0 flex-1"
      contentClassName="p-3"
      viewportProps={{ 'data-testid': 'activity-list' }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={visibleOrder.filter(
            (id) =>
              !extraSections.find((section) => section.key === id)
                ?.hiddenWhileMounted,
          )}
          strategy={verticalListSortingStrategy}
        >
          <Stack gap="inline">
            {visibleOrder.map((id) => {
              const extra = extraSections.find((section) => section.key === id);
              const sectionOverride = sectionOverrides?.[id];
              const descriptor = isActivitySectionId(id)
                ? ACTIVITY_SECTION_DESCRIPTORS[id]
                : undefined;
              const chrome = resolveSectionChrome(id);
              const hasExpandableContent =
                sectionOverride?.hasContent ?? extra?.hasContent ?? true;
              return (
                <SortableSection
                  key={id}
                  id={id}
                  hiddenWhileMounted={extra?.hiddenWhileMounted}
                  title={chrome.title}
                  icon={chrome.icon}
                  subtitle={chrome.subtitle}
                  subtitleInline={
                    sectionOverride?.subtitleInline ?? extra?.subtitleInline
                  }
                  subtitleGap={
                    sectionOverride?.subtitleGap ?? extra?.subtitleGap
                  }
                  headerAction={chrome.headerAction}
                  collapsedIconColor={
                    sectionOverride?.collapsedIconColor ??
                    extra?.collapsedIconColor ??
                    descriptor?.collapsedIconColor(sectionContext) ??
                    'muted'
                  }
                  defaultCollapsed={
                    sectionOverride?.defaultCollapsed ??
                    extra?.defaultCollapsed ??
                    id === 'terminals'
                  }
                  collapsible={hasExpandableContent}
                  keepBodyMountedWhenCollapsed={
                    sectionOverride?.keepBodyMountedWhenCollapsed ??
                    extra?.keepBodyMountedWhenCollapsed
                  }
                  expandRequest={sectionOverride?.expandRequest}
                  actionCard={sectionOverride?.actionCard ?? extra?.actionCard}
                  dataTestId={sectionOverride?.dataTestId ?? extra?.dataTestId}
                >
                  {renderBody(id)}
                </SortableSection>
              );
            })}
          </Stack>
        </SortableContext>
      </DndContext>
    </OverlayScrollArea>
  );

  const tabs = testIds
    ? TABS.map((item) => ({
        ...item,
        dataTestId:
          item.id === 'activity'
            ? (testIds.activityTab ?? item.dataTestId)
            : (testIds.filesTab ?? item.dataTestId),
      }))
    : TABS;
  if (layout === 'card') return renderActivityCard();

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="activity-panel">
      {!hideTabs && (
        <RailTabBar
          tabs={tabs}
          activeTab={tab}
          onTabChange={handleTabChange}
          touchTarget={touchTarget}
        />
      )}
      {hideTabs || tab === 'activity' ? (
        renderActivityStack()
      ) : (
        <div className="min-h-0 flex-1">
          <FilesTab
            entries={
              fileTreeRootKey ? (snapshot?.fileTree[fileTreeRootKey] ?? []) : []
            }
            loading={
              filesEmptyState === undefined &&
              filesStatusBar === undefined &&
              (hydrating === true ||
                (fileTreeRootKey !== undefined &&
                  snapshot?.fileTree[fileTreeRootKey] === undefined))
            }
            onOpenFile={onOpenFile}
            onOpenDirectory={hostActions?.onListDirectory ?? onOpenDirectory}
            onDownloadFile={onDownloadFile}
            canDownloadFile={canDownloadFile}
            downloadError={downloadError}
            workspaceLocalId={workspaceLocalId}
            worktreeLocalId={worktreeLocalId}
            fileRootLocalId={fileRootLocalId}
            roots={fileRoots}
            activeRootLocalId={activeFileRootLocalId}
            appManagedRootsLabel={appManagedFileRootsLabel}
            onSelectRoot={hostActions?.onSelectFileRoot}
            currentDir={fileTreeDir}
            emptyState={filesEmptyState}
            statusBar={filesStatusBar}
            downloadNotice={filesDownloadNotice}
            truncated={
              fileTreeRootKey === undefined
                ? false
                : snapshot?.fileTreeTruncated?.[fileTreeRootKey] === true
            }
            onSelectFile={hostActions?.onOpenCode}
            dataTestId={testIds?.filesTree}
            rowDataTestId={testIds?.filesRow}
            folderRowDataTestId={testIds?.filesFolderRow}
            touchTarget={touchTarget}
          />
        </div>
      )}
    </div>
  );
}

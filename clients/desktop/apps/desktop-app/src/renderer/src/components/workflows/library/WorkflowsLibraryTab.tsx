import {
  pipelineShareLinkItemId,
  workflowCallerCount,
  workflowDeleteMessage,
  workflowDeletePlan,
} from '@/lib/workflows/library-projection';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type JSX,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useCapabilities } from '@canopy/app-state';
import { useResourceContext } from '@canopy/ui-app/capability';
import {
  availableWorkflowTriggerKinds,
  countLibraryFacets,
  filterLibraryRows,
  pageLibraryRows,
  sortLibraryRows,
  WORKFLOW_LIBRARY_PAGE_SIZE,
  WorkflowsLibraryEmptyState,
  WorkflowsLibraryPagination,
  WorkflowsLibraryTable,
  WorkflowsLibraryTableSkeleton,
  WorkflowsLibraryToolbar,
  type WorkflowLibraryAction,
  type WorkflowLibraryRow,
} from '@canopy/ui-app/workflows';
import {
  ConfirmDialog,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  ErrorState,
  Notice,
  TRY_AGAIN_LABEL,
  TRYING_AGAIN_LABEL,
  useRetry,
} from '@canopy/ui-shared/components';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { copyTextToClipboard } from '@/lib/clipboard';
import { resolveCloudOrigin, useCloudOrigin } from '@/lib/cloud-origin';
import {
  marketplaceShareLink,
  marketplaceLinkAccess,
  copyMarketplaceLink,
} from '@canopy/ui-app/sharing';
import { postShareToast } from '@/lib/share-toast';
import { openPipelineRuns } from '@/lib/workflows/open-pipeline-runs';
import { automationLibraryKey } from '@/lib/workflows/run-feed';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkflowsViewStore } from '@/stores/workflowsViewStore';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { AutomationMutationResponse } from '@canopy/desktop-shared/types';
import type { AutomationsPageBodyApi } from '../../pages/AutomationsPage';
import type { PipelinesPageListApi } from '../../pages/PipelinesPage';
import type {
  WorkflowLibraryData,
  WorkflowLibraryTarget,
} from './useWorkflowLibraryRows';
import { revealedPipelineRowKey } from './revealedPipelineRowKey';

/** Below this width Next run folds under the trigger. */
const COMPACT_WIDTH_PX = 880;

export interface WorkflowsLibraryTabProps {
  readonly data: WorkflowLibraryData;
  readonly pipelines: PipelinesPageListApi;
  readonly automations: AutomationsPageBodyApi;
  /** Epoch milliseconds the rows were projected at. */
  readonly now: number;
  /** Opens the dispatch dialog on one pipeline; omitted when it cannot run. */
  readonly onRunPipeline?: (pipelineId: string) => void;
  /** The New workflow control, for the filtered empty state. */
  readonly newWorkflow?: ReactNode;
}

interface PendingDelete {
  readonly row: WorkflowLibraryRow;
  readonly target: WorkflowLibraryTarget;
}

/** What failed to load: the whole Library, or part of it. */
interface LibraryLoadFailure {
  readonly scope: 'place' | 'part';
  readonly message: string;
}

const LIBRARY_LOAD_FAILED = "Couldn't load workflows.";
const LIBRARY_SHARED_LOAD_FAILED =
  "Couldn't load shared workflows. Yours are listed.";
const LIBRARY_PART_LOAD_FAILED =
  "Couldn't load some workflows. The rest are listed.";

/**
 * A row action that failed is raised as a toast with Try again, which runs
 * the same action again. The headline names what failed; the reason follows.
 */
function raiseActionFailure(
  title: string,
  error: unknown,
  retry: () => Promise<void>,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  useGitHubStore
    .getState()
    .addToast(
      reason.trim() === '' ? 'Something went wrong.' : reason,
      'error',
      undefined,
      {
        title,
        action: {
          label: TRY_AGAIN_LABEL,
          busyLabel: TRYING_AGAIN_LABEL,
          onClick: retry,
        },
        // Feedback to the click, with the app in front: always in the app, and
        // never a native banner.
        forceInApp: true,
        suppressOsNotification: true,
      },
    );
}

/**
 * Runs a row action with its row marked busy. A failure becomes a toast whose
 * Try again runs the same action again, the same way.
 */
async function runRowAction(
  setBusyKeys: Dispatch<SetStateAction<ReadonlySet<string>>>,
  key: string,
  failureTitle: string,
  action: () => Promise<void>,
): Promise<void> {
  setBusyKeys((current) => new Set(current).add(key));
  try {
    await action();
  } catch (error) {
    raiseActionFailure(failureTitle, error, () =>
      runRowAction(setBusyKeys, key, failureTitle, action),
    );
  } finally {
    setBusyKeys((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }
}

/**
 * Turns an automation call's own result into a throw, so a failure becomes
 * the action's toast. The store also keeps the error for its inline notices;
 * the toast reports it here, so it is cleared.
 */
function throwIfAutomationFailed(result: AutomationMutationResponse): void {
  if (result.ok) return;
  useAutomationsStore.getState().clearMutationError();
  throw new Error(result.error);
}

/**
 * Workflows → Library (CAN-3981): every automation and every pipeline in one
 * table, joined by the Trigger column. Row actions call the stores and
 * handlers the old Automations and Pipelines lists used.
 */
export function WorkflowsLibraryTab({
  data,
  pipelines,
  automations,
  now,
  onRunPipeline,
  newWorkflow,
}: WorkflowsLibraryTabProps): JSX.Element {
  const capabilities = useCapabilities();
  const { personalOrganizationId } = useResourceContext();
  const filters = useWorkflowsViewStore((state) => state.libraryFilters);
  const sort = useWorkflowsViewStore((state) => state.librarySort);
  const pageNumber = useWorkflowsViewStore((state) => state.libraryPage);
  const setFilters = useWorkflowsViewStore((state) => state.setLibraryFilters);
  const setSort = useWorkflowsViewStore((state) => state.setLibrarySort);
  const setPage = useWorkflowsViewStore((state) => state.setLibraryPage);
  const clearFilters = useWorkflowsViewStore(
    (state) => state.clearLibraryFilters,
  );

  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setCompact(width < COMPACT_WIDTH_PX);
    });
    observer.observe(element);
    return (): void => observer.disconnect();
  }, []);

  const { rows, targets } = data;

  // One container per scope: every local list failing with nothing to show
  // is the whole place failing; any other failure is part of it, in one
  // notice above what did load. Try again keeps the failure on screen, its
  // capsule spinning, until the reload settles.
  const reloadFailed = useCallback(async (): Promise<void> => {
    await Promise.all([
      automations.error !== null ? automations.reload() : undefined,
      pipelines.error !== null ? pipelines.refresh() : undefined,
      data.sharedLoadFailed ? data.refreshSharedAutomations() : undefined,
      data.sharedLoadFailed ? pipelines.refreshSharedList() : undefined,
    ]);
  }, [automations, data, pipelines]);
  const loadRetry = useRetry(reloadFailed);
  const loadFailure = useMemo((): LibraryLoadFailure | null => {
    const automationsFailed = automations.error !== null;
    const pipelinesFailed = pipelines.error !== null;
    if (automationsFailed && pipelinesFailed && rows.length === 0) {
      return { scope: 'place', message: LIBRARY_LOAD_FAILED };
    }
    if (automationsFailed || pipelinesFailed) {
      return { scope: 'part', message: LIBRARY_PART_LOAD_FAILED };
    }
    if (data.sharedLoadFailed) {
      return { scope: 'part', message: LIBRARY_SHARED_LOAD_FAILED };
    }
    return null;
  }, [automations.error, data.sharedLoadFailed, pipelines.error, rows.length]);
  const [retriedFailure, setRetriedFailure] =
    useState<LibraryLoadFailure | null>(null);
  const shownFailure =
    loadFailure ?? (loadRetry.retrying ? retriedFailure : null);
  // Before the first rows arrive the list is a skeleton, and nothing that
  // counts rows (the pagination's "0 of 0") shows under it.
  const firstLoad =
    shownFailure?.scope !== 'place' && data.loading && rows.length === 0;
  const retryLoad = (): void => {
    setRetriedFailure(shownFailure);
    loadRetry.retry();
  };
  const counts = useMemo(() => countLibraryFacets(rows), [rows]);
  const sorted = useMemo(
    () => sortLibraryRows(filterLibraryRows(rows, filters), sort),
    [filters, rows, sort],
  );
  const page = useMemo(
    () => pageLibraryRows(sorted, pageNumber),
    [pageNumber, sorted],
  );
  const cloudOrigin = useCloudOrigin();
  const visibleRows = useMemo(
    () =>
      page.rows.map((row) => {
        if (!row.actions.includes('copy-link')) return row;
        const target = targets.get(row.key);
        const itemId =
          target?.kind === 'pipeline'
            ? pipelineShareLinkItemId(target.pipeline)
            : undefined;
        return marketplaceShareLink(cloudOrigin, 'pipeline', itemId)
          ? row
          : {
              ...row,
              actions: row.actions.filter((action) => action !== 'copy-link'),
            };
      }),
    [cloudOrigin, page.rows, targets],
  );
  const projectOptions = useMemo(
    () =>
      automations.scope.projectsInContext.map((project) => ({
        id: project.id,
        name: getWorkspaceDisplayName(project),
      })),
    [automations.scope.projectsInContext],
  );
  const triggers = useMemo(
    () => availableWorkflowTriggerKinds(capabilities),
    [capabilities],
  );

  // A pipeline install from a share (CAN-3710) lands here too. The request
  // is consumed into local state at once, so it can never fire on a later
  // visit, and the list is refreshed so the new pipeline is in it.
  const pendingPipelineReveal = useNavigationStore(
    (state) => state.pendingPipelineReveal,
  );
  const [revealedPipelineId, setRevealedPipelineId] = useState<string | null>(
    null,
  );
  const refreshPipelines = pipelines.refresh;
  useEffect(() => {
    if (!pendingPipelineReveal) return;
    useNavigationStore.getState().consumePipelineReveal();
    setRevealedPipelineId(pendingPipelineReveal.pipelineId);
    void refreshPipelines();
  }, [pendingPipelineReveal, refreshPipelines]);
  const revealedPipelineKey = useMemo(
    () =>
      revealedPipelineId === null
        ? null
        : revealedPipelineRowKey(targets, revealedPipelineId),
    [revealedPipelineId, targets],
  );

  // A finished install points at its row: filters that would hide it are
  // cleared, and the page that lists it is shown.
  const revealedKey =
    automations.revealedActivityId !== null
      ? automationLibraryKey(automations.revealedActivityId)
      : revealedPipelineKey;
  const revealAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (revealedKey === null) {
      revealAppliedRef.current = null;
      return;
    }
    if (revealAppliedRef.current === revealedKey) return;
    if (!rows.some((row) => row.key === revealedKey)) return;
    revealAppliedRef.current = revealedKey;
    clearFilters();
    const index = sortLibraryRows(rows, sort).findIndex(
      (row) => row.key === revealedKey,
    );
    if (index >= 0) setPage(Math.floor(index / WORKFLOW_LIBRARY_PAGE_SIZE) + 1);
  }, [clearFilters, revealedKey, rows, setPage, sort]);

  // Once its page is listed, the revealed row is scrolled to and focused, as
  // the Automations list did.
  const focusedRevealRef = useRef<string | null>(null);
  const revealedOnPage =
    revealedKey !== null && page.rows.some((row) => row.key === revealedKey);
  useEffect(() => {
    if (revealedKey === null) {
      focusedRevealRef.current = null;
      return undefined;
    }
    if (!revealedOnPage || focusedRevealRef.current === revealedKey) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      const row = containerRef.current?.querySelector<HTMLElement>(
        '[data-highlighted="true"]',
      );
      if (!row) return;
      focusedRevealRef.current = revealedKey;
      row.scrollIntoView?.({ block: 'center' });
      row.focus({ preventScroll: true });
    });
    return (): void => window.cancelAnimationFrame(frame);
  }, [revealedKey, revealedOnPage]);

  const withBusy = useCallback(
    (
      key: string,
      failureTitle: string,
      action: () => Promise<void>,
    ): Promise<void> => runRowAction(setBusyKeys, key, failureTitle, action),
    [],
  );

  /** A share not added yet: its Marketplace entry holds Add and the detail. */
  const openShareInMarketplace = useCallback((name: string): void => {
    useNavigationStore.getState().openPluginsNavigation({
      kind: 'marketplace-browse',
      query: name,
      tab: 'workflow',
    });
  }, []);

  const openRow = useCallback(
    (row: WorkflowLibraryRow): void => {
      const target = targets.get(row.key);
      if (!target) return;
      automations.endReveal();
      switch (target.kind) {
        case 'automation':
          automations.beginEdit(target.activity);
          return;
        case 'pipeline':
          pipelines.edit(target.pipeline);
          return;
        case 'shared-automation':
          // Read-only in the edit shell, with Duplicate (CAN-4072). Add
          // still opens Marketplace.
          useNavigationStore.getState().openWorkflowEdit({
            kind: 'shared-automation',
            remoteId: target.share.id,
            name: target.share.name,
          });
          return;
      }
    },
    [automations, pipelines, targets],
  );

  const viewRuns = useCallback(
    (row: WorkflowLibraryRow, target: WorkflowLibraryTarget): void => {
      if (target.kind === 'automation') {
        automations.beginView(target.activity);
        return;
      }
      openPipelineRuns(row.name);
    },
    [automations],
  );

  const handleAction = useCallback(
    (row: WorkflowLibraryRow, action: WorkflowLibraryAction): void => {
      const target = targets.get(row.key);
      if (!target) return;
      switch (action) {
        case 'edit':
          openRow(row);
          return;
        case 'add':
          if (target.kind === 'shared-automation') {
            openShareInMarketplace(target.share.name);
          }
          return;
        case 'view-runs':
          viewRuns(row, target);
          return;
        case 'toggle':
          if (target.kind === 'automation') {
            void withBusy(
              row.key,
              row.enabled === false
                ? `Couldn't turn on ${row.name}`
                : `Couldn't turn off ${row.name}`,
              async () => {
                throwIfAutomationFailed(
                  await automations.toggleEnabled(target.activity),
                );
              },
            );
          } else if (target.kind === 'pipeline') {
            void withBusy(
              row.key,
              row.enabled === false
                ? `Couldn't turn on ${row.name}`
                : `Couldn't turn off ${row.name}`,
              () =>
                pipelines.setPipelineEnabled(
                  target.pipeline.id,
                  row.enabled === false,
                ),
            );
          }
          return;
        case 'run':
          if (target.kind === 'automation') {
            void withBusy(row.key, `Couldn't start ${row.name}`, async () => {
              throwIfAutomationFailed(
                await automations.runNow(target.activity),
              );
            });
          } else if (target.kind === 'pipeline') {
            onRunPipeline?.(target.pipeline.id);
          }
          return;
        case 'duplicate':
          if (target.kind === 'automation') {
            void withBusy(
              row.key,
              `Couldn't duplicate ${row.name}`,
              async () => {
                throwIfAutomationFailed(
                  await automations.duplicate(target.activity),
                );
              },
            );
          } else if (target.kind === 'pipeline') {
            void withBusy(row.key, `Couldn't duplicate ${row.name}`, () =>
              pipelines.duplicate(target.pipeline),
            );
          }
          return;
        case 'share':
          if (target.kind === 'automation') automations.share(target.activity);
          else if (target.kind === 'pipeline') pipelines.share(target.pipeline);
          return;
        case 'copy-link': {
          if (target.kind !== 'pipeline') return;
          const itemId = pipelineShareLinkItemId(target.pipeline);
          const access = marketplaceLinkAccess(
            target.pipeline,
            personalOrganizationId,
          );
          if (!itemId || !access) return;
          void withBusy(row.key, "Couldn't copy the share link", async () => {
            const url = marketplaceShareLink(
              await resolveCloudOrigin(),
              'pipeline',
              itemId,
            );
            if (
              !url ||
              !(await copyMarketplaceLink(url, access, {
                write: copyTextToClipboard,
                notify: postShareToast,
              }))
            ) {
              throw new Error("The clipboard isn't available.");
            }
          });
          return;
        }
        case 'delete':
          setDeleteError(null);
          setPendingDelete({ row, target });
          return;
      }
    },
    [
      automations,
      onRunPipeline,
      openRow,
      openShareInMarketplace,
      personalOrganizationId,
      pipelines,
      targets,
      viewRuns,
      withBusy,
    ],
  );

  // Every schedule with a run in progress: main refuses to delete one, so a
  // workflow's Delete is refused before any of its schedules goes.
  const runningActivityIds = useMemo(
    () =>
      new Set([
        ...automations.recentRuns
          .filter((run) => run.status === 'running')
          .map((run) => run.activityId),
        ...(automations.runningActivityId !== null
          ? [automations.runningActivityId]
          : []),
      ]),
    [automations.recentRuns, automations.runningActivityId],
  );
  // Main deletes a workflow page's row, the whole workflow, in one write.
  const removeAutomationRow = useCallback(
    (activity: ScheduledActivity): Promise<void> =>
      automations.remove(
        activity,
        activity.workflowSchedule ? { workflow: true } : undefined,
      ),
    [automations],
  );
  const deletePlan =
    pendingDelete?.target.kind === 'automation'
      ? workflowDeletePlan(
          pendingDelete.target.activity,
          automations.activities,
          runningActivityIds,
        )
      : undefined;
  const deleteScheduleCount = deletePlan?.ok ? deletePlan.schedules.length : 1;
  // CAN-6035: workflow pages whose run-pipeline step calls this row's
  // pipeline fail once it's gone, so the confirmation says how many.
  const deleteCallers =
    pendingDelete?.target.kind === 'automation'
      ? workflowCallerCount(
          pendingDelete.target.activity.workflowSchedule?.pipelineId,
          pipelines.pipelines,
        )
      : pendingDelete?.target.kind === 'pipeline'
        ? (pendingDelete.target.pipeline.workflowCallers ?? 0)
        : 0;

  const confirmDelete = useCallback((): void => {
    if (!pendingDelete) return;
    const { target } = pendingDelete;
    setDeleteBusy(true);
    void (async (): Promise<void> => {
      try {
        if (target.kind === 'automation') {
          await removeAutomationRow(target.activity);
        } else if (target.kind === 'pipeline') {
          await pipelines.remove(target.pipeline);
        }
        setPendingDelete(null);
      } catch (error) {
        setDeleteError(error instanceof Error ? error.message : String(error));
      } finally {
        setDeleteBusy(false);
      }
    })();
  }, [pipelines, pendingDelete, removeAutomationRow]);

  const deletingRunning =
    pendingDelete?.row.lastRun?.state === 'running' &&
    pendingDelete.target.kind === 'automation';
  const rowBusyKeys = useMemo(() => {
    const keys = new Set(busyKeys);
    if (automations.runningActivityId !== null) {
      keys.add(automationLibraryKey(automations.runningActivityId));
    }
    return keys;
  }, [automations.runningActivityId, busyKeys]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col gap-4 pt-4"
      data-testid="workflows-library"
    >
      {shownFailure?.scope === 'part' && (
        <div data-testid="workflows-library-load-error">
          <ErrorBanner
            errorSource="workflows-library-tab-shown"
            className=""
            error={shownFailure.message}
            onRetry={retryLoad}
            retrying={loadRetry.retrying}
          />
        </div>
      )}
      {pipelines.shareError !== null && (
        <Notice
          errorSource="workflows-library-action-error"
          intent="destructive"
          data-testid="workflows-library-action-error"
        >
          {pipelines.shareError}
        </Notice>
      )}
      {automations.revealNotice}
      <WorkflowsLibraryToolbar
        filters={filters}
        onFiltersChange={setFilters}
        sort={sort}
        onSortChange={setSort}
        counts={counts}
        triggers={triggers}
        projects={projectOptions}
        sharedCountUnknown={data.sharedLoadFailed}
        total={rows.length}
        matched={sorted.length}
      />
      {shownFailure?.scope === 'place' ? (
        <ErrorState
          testId="workflows-library-load-failed"
          retryTestId="workflows-library-retry"
          message={shownFailure.message}
          onRetry={retryLoad}
          retrying={loadRetry.retrying}
        />
      ) : firstLoad ? (
        <DelayedLoadingPlaceholder slowNote="Still loading workflows…">
          <WorkflowsLibraryTableSkeleton compact={compact} />
        </DelayedLoadingPlaceholder>
      ) : page.rows.length === 0 ? (
        <WorkflowsLibraryEmptyState
          filters={filters}
          onClearFilters={clearFilters}
          newWorkflow={newWorkflow}
        />
      ) : (
        <WorkflowsLibraryTable
          rows={visibleRows}
          now={now}
          onOpen={openRow}
          onAction={handleAction}
          busyKeys={rowBusyKeys}
          highlightKey={revealedKey}
          compact={compact}
        />
      )}
      {firstLoad ? null : (
        <WorkflowsLibraryPagination page={page} onPageChange={setPage} />
      )}
      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${pendingDelete.row.name}"?`}
          message={
            deletePlan?.ok === false
              ? deletePlan.error
              : workflowDeleteMessage({
                  scheduleCount: deleteScheduleCount,
                  running: deletingRunning,
                  callers: deleteCallers,
                })
          }
          confirmLabel="Delete"
          busyLabel="Deleting…"
          busy={deleteBusy}
          confirmDisabled={deletePlan?.ok === false}
          errorMessage={deleteError}
          destructive
          dataTestId="workflows-library-delete"
          onCancel={(): void => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, type JSX } from 'react';
import { useStore } from 'zustand';
import {
  HeaderActionButton,
  MoreRow,
  MoreWorktreesPage,
  Notice,
  NoticeButton,
  useOverlayEscape,
  type MoreWorktreeItem,
} from '@canopy/ui-shared/components';
import { BackIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  formatMoreWorktreeDate,
  formatRestoreNote,
  untitledTaskLabel,
} from '@canopy/ui-app';
import { webCoreLocalId } from '@/lib/chat-authority';
import { openArchivedOverviewSurface } from '@/lib/archivedContainerNavigation';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { cloudCoworkStore } from './cloud-cowork-store';
import {
  cloudArchivedTaskCount,
  useCloudArchivedTasksStore,
} from './cloud-archived-tasks';

const TEST_ID = 'cloud-more-tasks';

/** Said when a restore the user asked for didn't happen. */
export const CLOUD_TASK_RESTORE_FAILED =
  "Couldn't restore the task. Try again.";

/**
 * A cloud project's More page on desktop (CAN-6511): its archived and deleted
 * tasks on the shared More page, each restored in place through the web
 * core. The web core keeps them; desktop offers Restore only, as the relay
 * carries no other archive change.
 */
export function CloudArchivedTasksPage({
  projectId,
  onClose,
}: {
  readonly projectId: string;
  /** Leaves the page: its Back and Escape (CAN-6791). */
  readonly onClose?: () => void;
}): JSX.Element {
  const entry = useCloudArchivedTasksStore((s) => s.byProject[projectId]);
  const load = useCloudArchivedTasksStore((s) => s.load);
  const restore = useCloudArchivedTasksStore((s) => s.restore);
  const workspaceId = webCoreLocalId(projectId);
  const projectName = useStore(
    cloudCoworkStore,
    (s) =>
      s.projects.find((project) => project.workspaceId === workspaceId)?.name,
  );

  // A new connection forgets the list (CAN-6511): read it again once the
  // connection is back, and never while offline.
  const online = useStore(cloudCoworkStore, (s) => s.status === 'online');
  const generation = useStore(cloudCoworkStore, (s) => s.generation);
  useEffect(() => {
    if (online) void load(projectId);
  }, [generation, load, online, projectId]);

  // The project this page shows now, or null once it has gone. A restore
  // closes the page only while the page that started it is still showing the
  // same project (CAN-6791): one that lands after Back, or after the user
  // moved to another project's More page, closes nothing.
  const showing = useRef<string | null>(projectId);
  useEffect(() => {
    showing.current = projectId;
    return (): void => {
      showing.current = null;
    };
  }, [projectId]);

  // A page's Escape sits beneath any dialog open over it.
  useOverlayEscape(onClose !== undefined, () => onClose?.(), undefined, {
    layer: 'page',
  });

  const items = useMemo((): readonly MoreWorktreeItem[] | null => {
    // Loading for the first time; a reload keeps showing the last list, and a
    // failed load shows none beside its notice.
    if (entry === undefined) return null;
    if (entry.status === 'loading' && entry.tasks.length === 0) return null;
    return entry.tasks.map((task): MoreWorktreeItem => {
      const busy = entry.restoring.includes(task.archiveId);
      const restoreNote =
        task.state === 'deleted'
          ? formatRestoreNote(task.expiresAt)
          : undefined;
      return {
        id: task.archiveId,
        state: task.state,
        title: untitledTaskLabel(task.title),
        date: formatMoreWorktreeDate(task.archivedAt),
        ...(restoreNote === undefined ? {} : { restoreNote }),
        ...(busy ? { progressLabel: 'Restoring…' } : {}),
        primaryAction: {
          label: 'Restore',
          // A restored task is back in the sidebar: the page closes over it
          // (CAN-6791); a refused one keeps the page with its notice.
          onClick: () =>
            void restore(projectId, task.archiveId).then((restored) => {
              if (restored && showing.current === projectId) onClose?.();
            }),
          disabled: busy,
          testId: `${TEST_ID}-restore-${task.archiveId}`,
        },
        testId: `${TEST_ID}-item-${task.archiveId}`,
      };
    });
  }, [entry, onClose, projectId, restore]);

  const notices =
    entry?.status === 'failed' ? (
      <Notice
        intent="destructive"
        errorSource="cloud-archived-tasks-load"
        data-testid={`${TEST_ID}-load-failed`}
        actions={
          <NoticeButton onClick={() => void load(projectId)}>
            Try again
          </NoticeButton>
        }
      >
        Archived and deleted tasks couldn't load.
      </Notice>
    ) : entry?.restoreFailed != null ? (
      <Notice
        intent="destructive"
        errorSource="cloud-archived-tasks-restore"
        data-testid={`${TEST_ID}-restore-failed`}
      >
        {CLOUD_TASK_RESTORE_FAILED}
      </Notice>
    ) : undefined;

  return (
    <MoreWorktreesPage
      projectName={projectName ?? 'project'}
      unitLabelPlural="tasks"
      items={items}
      initialTab="all"
      emptyMessage="No archived or deleted tasks."
      {...(notices === undefined ? {} : { notices })}
      {...(onClose === undefined
        ? {}
        : {
            actions: (
              <HeaderActionButton
                tone="neutral"
                data-testid={`${TEST_ID}-back`}
                onClick={onClose}
                title="Back to the project"
              >
                <BackIcon size="sm" aria-hidden="true" />
                Back
              </HeaderActionButton>
            ),
          })}
      testIdPrefix={TEST_ID}
    />
  );
}

/**
 * A cloud project's More row in the sidebar: its archived and deleted tasks,
 * read once the row mounts, opening the project's More page.
 */
export function CloudArchivedNavLink({
  projectId,
}: {
  readonly projectId: string;
}): JSX.Element | null {
  const count = useCloudArchivedTasksStore((s) =>
    cloudArchivedTaskCount(s, projectId),
  );
  const load = useCloudArchivedTasksStore((s) => s.load);
  const selected = useArchivedContainersStore(
    (s) => s.overview?.workspaceId === projectId,
  );
  // Read each time the row mounts (the sidebar shows the project again) and
  // each time the cloud comes back online, as a row kept offline stays
  // mounted (CAN-6374): a list read earlier, empty or failed, may miss a task
  // another client archived since, and an empty one hides the row. A read
  // failing while mounted is not retried in a loop.
  const online = useStore(cloudCoworkStore, (s) => s.status === 'online');
  const generation = useStore(cloudCoworkStore, (s) => s.generation);
  useEffect(() => {
    if (online) void load(projectId);
  }, [generation, load, online, projectId]);
  return (
    <MoreRow
      count={count}
      selected={selected}
      onOpen={() => openArchivedOverviewSurface(projectId)}
      testId={`sidebar-project-${projectId}-archived-link`}
    />
  );
}

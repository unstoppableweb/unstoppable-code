import { useEffect, useMemo, useState, type JSX } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useShallow } from 'zustand/shallow';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { SessionViewModel } from '@canopy/app-core';
import { resolveWorkspaceLayout } from '@canopy/protocol/remote-control/shell';
import { createProjectGrouper } from '@canopy/desktop-shared/lib/project-groups';
import type { PairedComputerLocalProjectFacts } from '@canopy/desktop-shared/types';
import {
  deriveWorktreeUiStatus,
  type WorktreeRowOverrides,
  type WorktreeRowSlotContext,
} from '@canopy/ui-app';
import { worktreeRowKey } from '@canopy/ui-app/code/shell/workspace-sections-model';
import { SidebarComputerStatusRow } from '@canopy/ui-app/sidebar';
import { RowComputerMarker } from '@canopy/ui-shared/components';
import { isDesktopSharedSidebarEnabled } from '@/components/sidebar/desktop-shared-sidebar-flag';
import { usePairedComputersApi } from '@/stores/oneWindowStore';
import {
  pairedComputerAddress,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useCanopyCloudAccountId } from '@/hooks/useCanopyCloudConnected';
import {
  pairedTaskKey,
  PairedComputersSidebarFollower,
  pairedSidebarStore,
  type PairedComputerToFollow,
  type PairedSidebarComputer,
  type PairedSidebarComputerStatus,
  type PairedSidebarStructure,
} from './paired-computers-sidebar-store';
import {
  createPairedSidebarRowsBuilder,
  NO_PAIRED_SIDEBAR_ROWS,
  pairedRowWorkspaceKey,
  type PairedSidebarRows,
} from './paired-sidebar-rows';

/**
 * Holds every online paired computer while this window shows this computer
 * and the one-window switch is on (CAN-7766), and lets them all go when the
 * switch turns off, the window closes, or a computer goes offline or is
 * unpaired. Each held computer keeps a windowless session, and so a hidden
 * bridge window, open on that computer until it is released; connecting on
 * demand and idle closing are CAN-7771. Mount once, in the app root.
 */
export function usePairedComputersSidebarFollower(): void {
  // Paired rows mount only in DesktopSharedSidebarHost; skip holding peer
  // sessions while the legacy sidebar escape hatch is active.
  const [sharedSidebarEnabled] = useState(isDesktopSharedSidebarEnabled);
  const api = usePairedComputersApi();
  const [follower, setFollower] =
    useState<PairedComputersSidebarFollower | null>(null);
  useEffect(() => {
    if (!sharedSidebarEnabled || api === null) return undefined;
    const next = new PairedComputersSidebarFollower(api, reportClientAppError);
    setFollower(next);
    return (): void => {
      next.dispose();
      setFollower(null);
    };
  }, [sharedSidebarEnabled, api]);
  // One line per online computer, `<device id>\t<name>`, so the list is
  // equal while nothing in it changes (device ids hold no tab).
  const online = useRemoteControlStore(
    useShallow((store): string[] =>
      store.state.signedIn
        ? store.state.hosts
            .filter((host) => host.online)
            .map((host) => `${host.deviceId}\t${host.name}`)
        : [],
    ),
  );
  useEffect(() => {
    follower?.follow(
      online.map((line): PairedComputerToFollow => {
        const tab = line.indexOf('\t');
        return { deviceId: line.slice(0, tab), name: line.slice(tab + 1) };
      }),
    );
  }, [follower, online]);
}

/** Why a paired computer's rows can't be used, in a few words; none while they can. */
function unavailableReason(
  status: PairedSidebarComputerStatus,
): string | undefined {
  if (status === 'connecting') return 'connecting';
  if (status === 'needs-update') return 'needs an update';
  return undefined;
}

/**
 * The row overrides of a paired computer's task (CAN-7766): its live status
 * from that computer's last snapshot, the computer icon, and the
 * unavailable state while the computer connects or needs an update, when
 * the status last read is not shown. Each row reads only its own task and
 * computer, so a status change re-renders that row alone. Undefined for
 * every other row.
 */
const EMPTY_REMOTE_WORKSPACES: ReadonlyMap<string, string> = new Map();

/**
 * Maps each rendered paired row (`pairedRowWorkspaceKey(workspaceLocalId, localId)`)
 * to its owning remote workspace id so live status and approval lookups stay
 * scoped even when two projects on the same paired computer share a task id.
 */
const pairedRowRemoteWorkspacesStore = createStore<{
  readonly byRowKey: ReadonlyMap<string, string>;
}>(() => ({ byRowKey: EMPTY_REMOTE_WORKSPACES }));

function resolveRemoteWorkspaceId(
  computer: PairedSidebarComputer | undefined,
  sidebarWorkspaceId: string,
  localId: string,
  mappedRemoteWorkspaceId: string | undefined,
): string | undefined {
  if (mappedRemoteWorkspaceId !== undefined) return mappedRemoteWorkspaceId;
  const workspaceAddress = pairedComputerAddress(sidebarWorkspaceId);
  if (workspaceAddress !== null) return workspaceAddress.localId;
  if (computer?.structure === null || computer === undefined) return undefined;
  let match: string | undefined;
  for (const task of computer.structure.tasks) {
    if (task.localId !== localId) continue;
    if (match !== undefined) return undefined;
    match = task.workspaceLocalId;
  }
  return match;
}

export function usePairedWorktreeRowOverrides(
  context: WorktreeRowSlotContext,
): WorktreeRowOverrides | undefined {
  const id = context.worktree.localId;
  const sidebarWorkspaceId = context.workspace.localId;
  const address = useMemo(() => pairedComputerAddress(id), [id]);
  const deviceId = address?.deviceId;
  const localId = address?.localId;
  const mappedRemoteWorkspaceId = useStore(
    pairedRowRemoteWorkspacesStore,
    (state) =>
      deviceId === undefined
        ? undefined
        : state.byRowKey.get(pairedRowWorkspaceKey(sidebarWorkspaceId, id)),
  );
  const live = useStore(pairedSidebarStore, (state) => {
    if (deviceId === undefined || localId === undefined) return undefined;
    const computer = state.computers.get(deviceId);
    const remoteWorkspaceId = resolveRemoteWorkspaceId(
      computer,
      sidebarWorkspaceId,
      localId,
      mappedRemoteWorkspaceId,
    );
    return remoteWorkspaceId === undefined
      ? undefined
      : computer?.live.get(pairedTaskKey(remoteWorkspaceId, localId));
  });
  const status = useStore(pairedSidebarStore, (state) =>
    deviceId === undefined ? undefined : state.computers.get(deviceId)?.status,
  );
  const name = useStore(pairedSidebarStore, (state) =>
    deviceId === undefined ? undefined : state.computers.get(deviceId)?.name,
  );
  const waitingForApproval = useStore(pairedSidebarStore, (state) => {
    if (deviceId === undefined || localId === undefined) return false;
    const computer = state.computers.get(deviceId);
    if (computer === undefined || computer.toolApprovals.size === 0)
      return false;
    const remoteWorkspaceId = resolveRemoteWorkspaceId(
      computer,
      sidebarWorkspaceId,
      localId,
      mappedRemoteWorkspaceId,
    );
    return (
      remoteWorkspaceId !== undefined &&
      computer.toolApprovals.has(pairedTaskKey(remoteWorkspaceId, localId))
    );
  });
  return useMemo((): WorktreeRowOverrides | undefined => {
    if (status === undefined || name === undefined) return undefined;
    const reason = unavailableReason(status);
    const marker = (
      <RowComputerMarker
        computerName={name}
        unavailableReason={reason}
        testId="worktree-row-computer"
      />
    );
    if (reason !== undefined || live === undefined)
      return {
        trailingIconSlot: marker,
        unavailable: reason !== undefined,
      };
    const done = live.status === 'done';
    // desktop:session-snapshot reports task-level streaming without per-chat
    // breakdown, so while a tool approval is waiting we suppress streaming to
    // match local rows (orange approval dot only, not the Working spinner).
    const effectiveLive = waitingForApproval
      ? { ...live, isStreaming: false, busy: false }
      : live;
    return {
      trailingIconSlot: marker,
      unavailable: false,
      uiStatus: done ? 'done' : deriveWorktreeUiStatus(effectiveLive),
      runtimeState: done ? 'done' : undefined,
      isStreaming: waitingForApproval ? false : live.isStreaming,
      pipelineStatus: live.pipelineStatus,
      backgroundTasks: live.backgroundTasks,
      awaitingApproval: live.awaitingApproval,
      hasPendingToolApproval: waitingForApproval,
      hasUnread: live.hasUnread,
      ...(live.lastActivityAt === undefined
        ? {}
        : { lastActivityAt: live.lastActivityAt }),
    };
  }, [live, status, name, waitingForApproval]);
}

const NO_FACTS: Readonly<Record<string, PairedComputerLocalProjectFacts>> = {};

/**
 * This computer's facts for its projects, read from main when the project
 * list changes and a paired computer is listed. Latest read wins; a failed
 * read leaves them unread, so projects match by identity only until the
 * list changes again.
 */
function useLocalProjectFacts(
  /** The project ids, one per line (ids hold no line breaks). */
  projectIdLines: string,
  wanted: boolean,
): Readonly<Record<string, PairedComputerLocalProjectFacts>> | null {
  const api = usePairedComputersApi();
  const [facts, setFacts] = useState<Readonly<
    Record<string, PairedComputerLocalProjectFacts>
  > | null>(null);
  useEffect(() => {
    if (api === null || !wanted) return undefined;
    if (projectIdLines === '') {
      setFacts(NO_FACTS);
      return undefined;
    }
    let current = true;
    api.localProjectFacts(projectIdLines.split('\n')).then(
      (read) => {
        if (current) setFacts(read);
      },
      (error: unknown) => {
        if (!current) return;
        setFacts(null);
        reportClientAppError(error);
      },
    );
    return (): void => {
      current = false;
    };
  }, [api, wanted, projectIdLines]);
  return facts;
}

/**
 * Which projects only on paired computers are collapsed, in this window
 * only: nothing about them is saved here, so a restart opens them again.
 */
const pairedProjectCollapseStore = createStore<{
  readonly collapsed: ReadonlySet<string>;
}>(() => ({ collapsed: new Set() }));

export function setPairedProjectCollapsed(
  projectId: string,
  collapsed: boolean,
): void {
  const current = pairedProjectCollapseStore.getState().collapsed;
  if (current.has(projectId) === collapsed) return;
  const next = new Set(current);
  if (collapsed) next.add(projectId);
  else next.delete(projectId);
  pairedProjectCollapseStore.setState({ collapsed: next });
}

/**
 * The rows the sidebar adds for paired computers (CAN-7766). Reused while
 * nothing they are built from changes, so a task status change or a local
 * sidebar update leaves them, and the list built from them, as they were.
 */
export function usePairedSidebarRows(): PairedSidebarRows {
  const computers = useStore(pairedSidebarStore, (state) => state.structures);
  const localProjects = useProjectsStore((state) => state.projects);
  const projectIdLines = useMemo(
    () => localProjects.map((project) => project.id).join('\n'),
    [localProjects],
  );
  const facts = useLocalProjectFacts(projectIdLines, computers.size > 0);
  const accountId = useCanopyCloudAccountId();
  const build = useMemo(
    () => createPairedSidebarRowsBuilder(createProjectGrouper()),
    [],
  );
  const rows = useMemo(
    () =>
      computers.size === 0
        ? NO_PAIRED_SIDEBAR_ROWS
        : build({
            localProjects,
            localFacts: facts,
            accountId: accountId === '' ? null : accountId,
            computers,
          }),
    [build, computers, localProjects, facts, accountId],
  );
  useEffect(() => {
    pairedRowRemoteWorkspacesStore.setState({
      byRowKey: rows.rowRemoteWorkspaceIds,
    });
    return (): void => {
      pairedRowRemoteWorkspacesStore.setState({
        byRowKey: EMPTY_REMOTE_WORKSPACES,
      });
    };
  }, [rows.rowRemoteWorkspaceIds]);
  const collapsed = useStore(
    pairedProjectCollapseStore,
    (state) => state.collapsed,
  );
  return useMemo(
    () =>
      collapsed.size === 0 ||
      !rows.workspaces.some((workspace) => collapsed.has(workspace.localId))
        ? rows
        : {
            ...rows,
            workspaces: rows.workspaces.map((workspace) =>
              collapsed.has(workspace.localId)
                ? { ...workspace, collapsed: true }
                : workspace,
            ),
          },
    [rows, collapsed],
  );
}

/**
 * Collects paired computer device ids that have at least one task row
 * currently rendered in the sidebar. When `renderedWorktreeKeys` is supplied
 * by the mounted sidebar surface, it reflects the exact rows on screen
 * (accounting for Projects collapse, pagination, project collapse, and
 * expanded/closed Hidden tasks disclosures); otherwise it falls back to
 * snapshot-level filtering.
 */
export function collectVisiblePairedDeviceIds(options: {
  readonly workspaces: readonly SessionViewModel['workspaces'][number][];
  readonly pairedWorktrees: readonly SessionViewModel['worktrees'][number][];
  readonly hiddenWorkspaceIds: readonly string[];
  readonly matchesWorkspaceContext: (
    workspace: SessionViewModel['workspaces'][number],
  ) => boolean;
  readonly renderedWorktreeKeys?: ReadonlySet<string>;
}): ReadonlySet<string> {
  const deviceIds = new Set<string>();
  if (options.pairedWorktrees.length === 0) return deviceIds;
  if (options.renderedWorktreeKeys !== undefined) {
    for (const worktree of options.pairedWorktrees) {
      if (
        !options.renderedWorktreeKeys.has(
          worktreeRowKey(worktree.workspaceLocalId, worktree.localId),
        )
      )
        continue;
      const deviceId = pairedComputerAddress(worktree.localId)?.deviceId;
      if (deviceId !== undefined) deviceIds.add(deviceId);
    }
    return deviceIds;
  }
  const hiddenWorkspaces = new Set(options.hiddenWorkspaceIds);
  const visibleWorkspaceIds = new Set<string>();
  for (const workspace of options.workspaces) {
    if (hiddenWorkspaces.has(workspace.localId)) continue;
    if (workspace.collapsed === true) continue;
    if (resolveWorkspaceLayout(workspace) !== 'tree') continue;
    if (!options.matchesWorkspaceContext(workspace)) continue;
    visibleWorkspaceIds.add(workspace.localId);
  }
  for (const worktree of options.pairedWorktrees) {
    if (worktree.hidden === true) continue;
    if (!visibleWorkspaceIds.has(worktree.workspaceLocalId)) continue;
    const deviceId = pairedComputerAddress(worktree.localId)?.deviceId;
    if (deviceId !== undefined) deviceIds.add(deviceId);
  }
  return deviceIds;
}

function hasProjectedTreeTask(
  structure: PairedSidebarStructure | null,
): boolean {
  if (structure === null || structure.tasks.length === 0) return false;
  const treeWorkspaceIds = new Set<string>();
  for (const workspace of structure.workspaces) {
    if (resolveWorkspaceLayout(workspace) === 'tree') {
      treeWorkspaceIds.add(workspace.localId);
    }
  }
  return structure.tasks.some((task) =>
    treeWorkspaceIds.has(task.workspaceLocalId),
  );
}

/**
 * One row for each paired computer the sidebar lists that has no projected
 * tree tasks and cannot be reached: connecting or needing an update. Once a
 * computer's tree tasks arrive, they list under their projects instead.
 */
export interface PairedComputerStatusRowsProps {
  /**
   * Paired computer device ids that already have at least one visible task row
   * in the current sidebar context. When omitted, falls back to checking the
   * raw snapshot for any tree-layout task.
   */
  readonly visibleDeviceIds?: ReadonlySet<string>;
}

export function PairedComputerStatusRows({
  visibleDeviceIds,
}: PairedComputerStatusRowsProps = {}): JSX.Element | null {
  // One line per computer, `<device id>\t<status>\t<name>`, so the rows
  // re-render only when one of these changes, never for a task's status.
  const waiting = useStore(
    pairedSidebarStore,
    useShallow((state) =>
      Array.from(state.computers.values())
        .filter(
          (computer) =>
            !(visibleDeviceIds !== undefined
              ? visibleDeviceIds.has(computer.deviceId)
              : hasProjectedTreeTask(computer.structure)) &&
            computer.status !== 'connected',
        )
        .map(
          (computer) =>
            `${computer.deviceId}\t${computer.status}\t${computer.name}`,
        ),
    ),
  );
  if (waiting.length === 0) return null;
  return (
    <>
      {waiting.map((line) => {
        const [deviceId = '', status = '', ...name] = line.split('\t');
        return (
          <SidebarComputerStatusRow
            key={deviceId}
            computerName={name.join('\t')}
            status={
              status === 'needs-update' ? 'Needs an update' : 'Connecting…'
            }
            data-testid="sidebar-paired-computer-status"
          />
        );
      })}
    </>
  );
}

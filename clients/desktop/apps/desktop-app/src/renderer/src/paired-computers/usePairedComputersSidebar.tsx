import { useEffect, useMemo, useState, type JSX } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useShallow } from 'zustand/shallow';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { createProjectGrouper } from '@canopy/desktop-shared/lib/project-groups';
import type { PairedComputerLocalProjectFacts } from '@canopy/desktop-shared/types';
import {
  deriveWorktreeUiStatus,
  type WorktreeRowOverrides,
  type WorktreeRowSlotContext,
} from '@canopy/ui-app';
import { SidebarComputerStatusRow } from '@canopy/ui-app/sidebar';
import { RowComputerMarker } from '@canopy/ui-shared/components';
import { usePairedComputersApi } from '@/stores/oneWindowStore';
import {
  pairedComputerAddress,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useCanopyCloudAccountId } from '@/hooks/useCanopyCloudConnected';
import {
  PairedComputersSidebarFollower,
  pairedSidebarStore,
  type PairedComputerToFollow,
  type PairedSidebarComputerStatus,
} from './paired-computers-sidebar-store';
import {
  createPairedSidebarRowsBuilder,
  NO_PAIRED_SIDEBAR_ROWS,
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
  const api = usePairedComputersApi();
  const [follower, setFollower] =
    useState<PairedComputersSidebarFollower | null>(null);
  useEffect(() => {
    if (api === null) return undefined;
    const next = new PairedComputersSidebarFollower(api, reportClientAppError);
    setFollower(next);
    return (): void => {
      next.dispose();
      setFollower(null);
    };
  }, [api]);
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
export function usePairedWorktreeRowOverrides(
  context: WorktreeRowSlotContext,
): WorktreeRowOverrides | undefined {
  const id = context.worktree.localId;
  const address = useMemo(() => pairedComputerAddress(id), [id]);
  const deviceId = address?.deviceId;
  const localId = address?.localId;
  const live = useStore(pairedSidebarStore, (state) =>
    deviceId === undefined || localId === undefined
      ? undefined
      : state.computers.get(deviceId)?.live.get(localId),
  );
  const status = useStore(pairedSidebarStore, (state) =>
    deviceId === undefined ? undefined : state.computers.get(deviceId)?.status,
  );
  const name = useStore(pairedSidebarStore, (state) =>
    deviceId === undefined ? undefined : state.computers.get(deviceId)?.name,
  );
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
    return {
      trailingIconSlot: marker,
      unavailable: false,
      uiStatus: done ? 'done' : deriveWorktreeUiStatus(live),
      runtimeState: done ? 'done' : undefined,
      isStreaming: live.isStreaming,
      backgroundTasks: live.backgroundTasks,
      awaitingApproval: live.awaitingApproval,
      hasUnread: live.hasUnread,
      ...(live.lastActivityAt === undefined
        ? {}
        : { lastActivityAt: live.lastActivityAt }),
    };
  }, [live, status, name]);
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
 * One row for each paired computer the sidebar lists that has sent no tasks
 * yet and can't be reached: connecting or needing an update. Once a
 * computer's tasks arrive, they list under their projects instead.
 */
export function PairedComputerStatusRows(): JSX.Element | null {
  // One line per computer, `<device id>\t<status>\t<name>`, so the rows
  // re-render only when one of these changes, never for a task's status.
  const waiting = useStore(
    pairedSidebarStore,
    useShallow((state) =>
      Array.from(state.computers.values())
        .filter(
          (computer) =>
            computer.structure === null && computer.status !== 'connected',
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

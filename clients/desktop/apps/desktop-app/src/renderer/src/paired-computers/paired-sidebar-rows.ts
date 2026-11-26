import type { SessionViewModel } from '@canopy/app-core';
import {
  authorityIdOf,
  parseAuthorityQualifiedId,
} from '@canopy/protocol/authority-qualified-id';
import { resolveWorkspaceLayout } from '@canopy/protocol/remote-control/shell';
import { hasVisibleWorkspaceContent } from '@canopy/desktop-shared/lib/workspace-visibility';
import {
  localProjectCopy,
  pairedComputerProjects,
  type NotSentProjectField,
  type PairedComputerProjects,
  type PairedSnapshotWorkspace,
  type ProjectCopy,
  type ProjectGrouper,
  type ProjectGrouping,
} from '@canopy/desktop-shared/lib/project-groups';
import type {
  PairedComputerLocalProjectFacts,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import type {
  PairedSidebarStructure,
  PairedSidebarStructureEntry,
  PairedSidebarTask,
} from './paired-computers-sidebar-store';

type SidebarWorkspace = SessionViewModel['workspaces'][number];
type SidebarWorktree = SessionViewModel['worktrees'][number];

/**
 * A paired computer's rows go after every local row of their project. The
 * shared list orders a project's rows by `order` (pins first), so paired
 * rows take orders past any local one, in the computer's own order.
 */
const PAIRED_ORDER_BASE = 1_000_000_000;
const PAIRED_ORDER_PER_COMPUTER = 1_000_000;

/** What the sidebar knows about a project it lists from paired computers. */
export interface PairedSidebarProject {
  /** The computers whose copies the project lists, by device id. */
  readonly deviceIds: readonly string[];
  /** No copy here: its project actions, which need a checkout, are absent. */
  readonly onlyOnPairedComputers: boolean;
  /**
   * What a computer did not send that matching uses, per device id, for
   * CAN-7878 and CAN-7770; shown nowhere yet.
   */
  readonly notSent: ReadonlyMap<string, readonly NotSentProjectField[]>;
}

export function pairedRowWorkspaceKey(
  sidebarWorkspaceId: string,
  qualifiedTaskId: string,
): string {
  return `${sidebarWorkspaceId}\0${qualifiedTaskId}`;
}

export interface PairedSidebarRows {
  /** Projects only on paired computers, by qualified id, after the local ones. */
  readonly workspaces: readonly SidebarWorkspace[];
  /** Paired computers' tasks, by qualified id, in the project they group into. */
  readonly worktrees: readonly SidebarWorktree[];
  /** Every project that lists a paired computer's task, by its sidebar id. */
  readonly projects: ReadonlyMap<string, PairedSidebarProject>;
  /**
   * Maps each emitted paired row (`pairedRowWorkspaceKey(workspaceLocalId, localId)`)
   * to the task's owning `workspaceLocalId` on its paired computer.
   */
  readonly rowRemoteWorkspaceIds: ReadonlyMap<string, string>;
}

export const NO_PAIRED_SIDEBAR_ROWS: PairedSidebarRows = {
  workspaces: [],
  worktrees: [],
  projects: new Map(),
  rowRemoteWorkspaceIds: new Map(),
};

export interface PairedSidebarRowsInput {
  /** This computer's projects, as the projects store lists them. */
  readonly localProjects: readonly SidebarItem[];
  /** Main's facts for them, or null until read. */
  readonly localFacts: Readonly<
    Record<string, PairedComputerLocalProjectFacts>
  > | null;
  /** The signed-in account's id, or null when there is none. */
  readonly accountId: string | null;
  readonly computers: ReadonlyMap<string, PairedSidebarStructureEntry>;
}

/**
 * Only projects whose tasks lay out as a tree list a paired computer's
 * tasks in this unit; a flat (Chats, cowork) project's work entries are
 * not in its snapshot's worktrees.
 */
function treeWorkspaces(
  structure: PairedSidebarStructure,
): PairedSidebarStructure['workspaces'] {
  return structure.workspaces.filter(
    (workspace) => resolveWorkspaceLayout(workspace) === 'tree',
  );
}

function localCopies(
  input: PairedSidebarRowsInput,
  cache: WeakMap<SidebarItem, { facts: unknown; copy: ProjectCopy }>,
): ProjectCopy[] {
  return input.localProjects.map((item) => {
    const facts = input.localFacts?.[item.id] ?? null;
    const cached = cache.get(item);
    if (cached !== undefined && cached.facts === facts) return cached.copy;
    const copy = localProjectCopy(
      item,
      facts === null
        ? null
        : {
            cloudBinding: facts.cloudBinding ?? undefined,
            repositoryRemotes: facts.repositoryRemotes,
          },
      input.accountId,
    );
    cache.set(item, { facts, copy });
    return copy;
  });
}

/** The task's or project's id here, or null for an id that can't be addressed. */
function qualified(deviceId: string, localId: string): string | null {
  const id = `${authorityIdOf({ kind: 'paired-computer', deviceId })}:${localId}`;
  return parseAuthorityQualifiedId(id)?.localId === localId ? id : null;
}

function projectName(
  name: string,
  deviceIds: readonly string[],
  computers: PairedSidebarRowsInput['computers'],
): string {
  // A project only on one paired computer says which, so a copy that could
  // not be matched never reads as this computer's project of that name.
  const only = deviceIds.length === 1 ? deviceIds[0] : undefined;
  const computer = only === undefined ? undefined : computers.get(only);
  return computer === undefined ? name : `${name} on ${computer.name}`;
}

function buildRows(
  grouping: ProjectGrouping,
  input: PairedSidebarRowsInput,
  localIds: ReadonlySet<string>,
): PairedSidebarRows {
  const workspaces: SidebarWorkspace[] = [];
  const worktrees: SidebarWorktree[] = [];
  const projects = new Map<string, PairedSidebarProject>();
  const rowRemoteWorkspaceIds = new Map<string, string>();
  const computerRank = new Map(
    Array.from(input.computers.keys())
      .sort()
      .map((deviceId, index) => [deviceId, index] as const),
  );
  // Pre-index peer workspaces and tasks once so building rows is linear in
  // snapshot size instead of rescanning every peer's arrays per project group.
  const workspacesByComputer = new Map<
    string,
    Map<string, PairedSnapshotWorkspace>
  >();
  const tasksByComputerWorkspace = new Map<
    string,
    Map<string, PairedSidebarTask[]>
  >();
  for (const [deviceId, entry] of input.computers) {
    const structure = entry.structure;
    if (structure === null) continue;
    const workspaceIndex = new Map<string, PairedSnapshotWorkspace>();
    for (const workspace of structure.workspaces) {
      workspaceIndex.set(workspace.localId, workspace);
    }
    workspacesByComputer.set(deviceId, workspaceIndex);
    const tasksByWorkspace = new Map<string, PairedSidebarTask[]>();
    for (const task of structure.tasks) {
      const list = tasksByWorkspace.get(task.workspaceLocalId);
      if (list === undefined)
        tasksByWorkspace.set(task.workspaceLocalId, [task]);
      else list.push(task);
    }
    tasksByComputerWorkspace.set(deviceId, tasksByWorkspace);
  }
  for (const group of grouping.groups) {
    const local = group.members.find(
      (member) => member.computer.kind === 'local',
    );
    const paired = group.members.flatMap((member) =>
      member.computer.kind === 'paired-computer'
        ? [{ member, deviceId: member.computer.deviceId }]
        : [],
    );
    if (paired.length === 0) continue;
    const firstPaired = paired[0];
    if (firstPaired === undefined) continue;
    const targetId =
      local !== undefined && localIds.has(local.projectId)
        ? local.projectId
        : firstPaired.member.projectId;
    const onlyOnPairedComputers = targetId !== local?.projectId;
    const deviceIds = paired.map((each) => each.deviceId);
    const notSent = new Map<string, readonly NotSentProjectField[]>();
    for (const { member, deviceId } of paired)
      if (member.notSent !== undefined) notSent.set(deviceId, member.notSent);
    projects.set(targetId, { deviceIds, onlyOnPairedComputers, notSent });
    if (onlyOnPairedComputers) {
      const firstLocalProjectId = firstPaired.member.projectId.slice(
        firstPaired.member.projectId.indexOf(':') + 1,
      );
      const source = workspacesByComputer
        .get(firstPaired.deviceId)
        ?.get(firstLocalProjectId);
      workspaces.push({
        localId: targetId,
        name: projectName(group.name, deviceIds, input.computers),
        type: group.kind,
        layout: 'tree',
        itemSortMode: 'manual',
        ...(group.color === null ? {} : { color: group.color }),
        ...(source?.owner === undefined ? {} : { owner: source.owner }),
      });
    }
    const seenInTarget = new Set<string>();
    for (const { member, deviceId } of paired) {
      const localProjectId = member.projectId.slice(
        member.projectId.indexOf(':') + 1,
      );
      const projectTasks = tasksByComputerWorkspace
        .get(deviceId)
        ?.get(localProjectId);
      if (projectTasks === undefined) continue;
      const base =
        PAIRED_ORDER_BASE +
        (computerRank.get(deviceId) ?? 0) * PAIRED_ORDER_PER_COMPUTER;
      let index = 0;
      for (const task of projectTasks) {
        const localId = qualified(deviceId, task.localId);
        if (localId === null || seenInTarget.has(localId)) continue;
        seenInTarget.add(localId);
        rowRemoteWorkspaceIds.set(
          pairedRowWorkspaceKey(targetId, localId),
          task.workspaceLocalId,
        );
        worktrees.push({
          localId,
          workspaceLocalId: targetId,
          branch: task.branch,
          ...(task.label === undefined ? {} : { label: task.label }),
          ...(task.createdAt === undefined
            ? {}
            : { createdAt: task.createdAt }),
          ...(task.hidden === true ? { hidden: true } : {}),
          order: base + index,
        });
        index += 1;
      }
    }
  }
  return { workspaces, worktrees, projects, rowRemoteWorkspaceIds };
}

/**
 * Builds the sidebar's rows for paired computers from this computer's
 * projects and each paired computer's last snapshot (CAN-7766), grouped by
 * CAN-7762's rules: a task joins this computer's copy of its project when
 * one matches, after its local tasks, and a project with no copy here is
 * listed as its own project after the local ones, never merged by name.
 *
 * The result object is reused while the grouping and every computer's
 * structure are unchanged, so a task status change, or a local sidebar
 * update, does not rebuild these rows. Only tree-layout projects are listed
 * from paired computers in this unit.
 */
export function createPairedSidebarRowsBuilder(
  grouper: ProjectGrouper,
): (input: PairedSidebarRowsInput) => PairedSidebarRows {
  const copies = new WeakMap<
    SidebarItem,
    { facts: unknown; copy: ProjectCopy }
  >();
  let previous: {
    grouping: ProjectGrouping;
    computers: PairedSidebarRowsInput['computers'];
    localIds: string;
    rows: PairedSidebarRows;
  } | null = null;
  return (input) => {
    if (input.computers.size === 0) {
      previous = null;
      return NO_PAIRED_SIDEBAR_ROWS;
    }
    const paired: PairedComputerProjects[] = [];
    for (const [deviceId, entry] of input.computers) {
      if (entry.structure === null) continue;
      paired.push(
        pairedComputerProjects(deviceId, treeWorkspaces(entry.structure)),
      );
    }
    if (paired.length === 0) {
      previous = null;
      return NO_PAIRED_SIDEBAR_ROWS;
    }
    const grouping = grouper({ local: localCopies(input, copies), paired });
    const localIds = input.localProjects.map((item) => item.id).join('\n');
    if (
      previous !== null &&
      previous.grouping === grouping &&
      previous.computers === input.computers &&
      previous.localIds === localIds
    )
      return previous.rows;
    const rows = buildRows(
      grouping,
      input,
      new Set(input.localProjects.map((item) => item.id)),
    );
    previous = { grouping, computers: input.computers, localIds, rows };
    return rows;
  };
}

/**
 * The sidebar snapshot with paired computers' rows added: their tasks after
 * the local tasks of the project they group into, and projects only on
 * paired computers after every local project, as cloud projects are
 * appended (`appendCloudSidebarRows`).
 */
export function appendPairedSidebarRows<
  Rows extends Pick<SessionViewModel, 'workspaces' | 'worktrees'>,
>(snapshot: Rows, paired: PairedSidebarRows): Rows {
  if (paired.worktrees.length === 0 && paired.workspaces.length === 0)
    return snapshot;
  const orderFrom =
    snapshot.workspaces.reduce(
      (highest, workspace) => Math.max(highest, workspace.order ?? 0),
      -1,
    ) + 1;
  return {
    ...snapshot,
    workspaces:
      paired.workspaces.length === 0
        ? snapshot.workspaces
        : [
            ...snapshot.workspaces,
            ...paired.workspaces.map((workspace, index) => ({
              ...workspace,
              order: orderFrom + index,
            })),
          ],
    worktrees: [...snapshot.worktrees, ...paired.worktrees],
  };
}

/**
 * Empty deferred (`alwaysShow: false`) workspaces that should move to the
 * Hidden disclosure. A local project with a visible paired-computer task stays
 * in the main Projects list; explicitly hidden projects are handled separately.
 */
export function selectDeferredEmptyWorkspaceIds(
  projects: readonly SidebarItem[],
  pairedWorktrees: ReadonlyArray<{
    readonly workspaceLocalId: string;
    readonly hidden?: boolean;
  }>,
): ReadonlySet<string> {
  const pairedWorkspaceIdsWithVisibleTasks = new Set(
    pairedWorktrees
      .filter((worktree) => worktree.hidden !== true)
      .map((worktree) => worktree.workspaceLocalId),
  );
  return new Set(
    projects
      .filter(
        (project) =>
          project.alwaysShow === false &&
          !hasVisibleWorkspaceContent(project) &&
          !pairedWorkspaceIdsWithVisibleTasks.has(project.id),
      )
      .map((project) => project.id),
  );
}

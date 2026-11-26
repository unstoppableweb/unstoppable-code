import { createStore } from 'zustand/vanilla';
import type {
  PairedComputerState,
  PairedComputerUpdate,
  PairedComputersApi,
} from '@canopy/desktop-shared/types';
import {
  parseRemoteControlRepositoryIdentity,
  type RemoteControlWorkspaceLayout,
} from '@canopy/protocol/remote-control/shell';
import type { OrgProjectPlaceholderState } from '@canopy/protocol/org-projects';
import type { PairedSnapshotWorkspace } from '@canopy/desktop-shared/lib/project-groups';
import type { SnapshotWorktree } from '@canopy/ui-app';

/**
 * The main window's view of its paired computers' sidebars (CAN-7766): which
 * computers it holds, whether each can be reached, and the projects and
 * tasks the last `desktop:session-snapshot` from each listed.
 *
 * A snapshot is split in two, so the sidebar re-renders only for what
 * changed. `structure` (projects, and each task's id, name and place) keeps
 * its object while a new snapshot lists the same things, so a status change
 * on another computer never rebuilds the sidebar list, nor a snapshot from
 * one computer another computer's rows. `live` holds each task's status,
 * which its row reads through its own selector.
 *
 * Rows are read-only in this unit. Nothing here calls this computer's own
 * IPC with a paired computer's id: the follower talks only to
 * `PairedComputersApi`, naming the computer and its own local ids.
 */

/** Why a paired computer's rows can or can't be used, as the sidebar shows it. */
export type PairedSidebarComputerStatus =
  | 'connected'
  | 'connecting'
  | 'needs-update';

/** What the sidebar lists of a task on a paired computer, besides its status. */
export interface PairedSidebarTask {
  readonly localId: string;
  readonly workspaceLocalId: string;
  readonly branch: string;
  readonly label?: string;
  readonly order?: number;
  readonly createdAt?: string;
  readonly hidden?: boolean;
}

/** A task's live status, from the fields the shared row derives it from. */
export type PairedSidebarTaskLive = Pick<
  SnapshotWorktree,
  | 'isStreaming'
  | 'busy'
  | 'isRunningRun'
  | 'pipelineStatus'
  | 'backgroundTasks'
  | 'awaitingApproval'
  | 'hasUnread'
  | 'status'
  | 'lastActivityAt'
>;

export interface PairedSidebarStructure {
  readonly workspaces: readonly PairedSnapshotWorkspace[];
  readonly tasks: readonly PairedSidebarTask[];
}

export interface PairedSidebarComputer {
  readonly deviceId: string;
  readonly name: string;
  readonly status: PairedSidebarComputerStatus;
  /** Null until the computer's first snapshot arrives. */
  readonly structure: PairedSidebarStructure | null;
  /** By `pairedTaskKey(workspaceLocalId, localId)` on that computer. */
  readonly live: ReadonlyMap<string, PairedSidebarTaskLive>;
  /**
   * The tasks, keyed by `pairedTaskKey(workspaceLocalId, taskLocalId)`,
   * with a tool approval waiting on that computer: read from
   * `approval:pending-requests` and followed through its approval pushes.
   * Read only; answering is CAN-7865.
   */
  readonly toolApprovals: ReadonlySet<string>;
}

export interface PairedSidebarStructureEntry {
  readonly name: string;
  readonly structure: PairedSidebarStructure | null;
}

export interface PairedSidebarState {
  /** Every listed computer, by device id. */
  readonly computers: ReadonlyMap<string, PairedSidebarComputer>;
  /**
   * Each listed computer's name and structure; a new object only when one
   * of them, or the set of computers, changes.
   */
  readonly structures: ReadonlyMap<string, PairedSidebarStructureEntry>;
}

const EMPTY_LIVE: ReadonlyMap<string, PairedSidebarTaskLive> = new Map();
const EMPTY_TASK_IDS: ReadonlySet<string> = new Set();

export const MAX_PAIRED_SNAPSHOT_WORKSPACES = 256;
export const MAX_PAIRED_SNAPSHOT_TASKS = 4096;

export function pairedTaskKey(
  workspaceLocalId: string,
  taskLocalId: string,
): string {
  return `${workspaceLocalId}\0${taskLocalId}`;
}

export const pairedSidebarStore = createStore<PairedSidebarState>(() => ({
  computers: new Map(),
  structures: new Map(),
}));

function sameStructures(
  a: PairedSidebarState['structures'],
  b: PairedSidebarState['structures'],
): boolean {
  if (a.size !== b.size) return false;
  for (const [deviceId, entry] of a) {
    const other = b.get(deviceId);
    if (
      other === undefined ||
      other.name !== entry.name ||
      other.structure !== entry.structure
    )
      return false;
  }
  return true;
}

function writeComputers(
  next: ReadonlyMap<string, PairedSidebarComputer>,
): void {
  const previous = pairedSidebarStore.getState();
  const structures = new Map(
    Array.from(next, ([deviceId, computer]) => [
      deviceId,
      { name: computer.name, structure: computer.structure },
    ]),
  );
  pairedSidebarStore.setState({
    computers: next,
    structures: sameStructures(previous.structures, structures)
      ? previous.structures
      : structures,
  });
}

function updateComputer(
  deviceId: string,
  update: (
    current: PairedSidebarComputer | undefined,
  ) => PairedSidebarComputer | null,
): void {
  const computers = pairedSidebarStore.getState().computers;
  const current = computers.get(deviceId);
  const next = update(current);
  if (next === current || (next === null && current === undefined)) return;
  const copy = new Map(computers);
  if (next === null) copy.delete(deviceId);
  else copy.set(deviceId, next);
  writeComputers(copy);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LIVE_KEYS = [
  'isStreaming',
  'busy',
  'isRunningRun',
  'pipelineStatus',
  'backgroundTasks',
  'awaitingApproval',
  'hasUnread',
  'status',
  'lastActivityAt',
] as const satisfies readonly (keyof PairedSidebarTaskLive)[];

function sameLive(a: PairedSidebarTaskLive, b: PairedSidebarTaskLive): boolean {
  return LIVE_KEYS.every((key) => a[key] === b[key]);
}

function sameTask(a: PairedSidebarTask, b: PairedSidebarTask): boolean {
  return (
    a.localId === b.localId &&
    a.workspaceLocalId === b.workspaceLocalId &&
    a.branch === b.branch &&
    a.label === b.label &&
    a.order === b.order &&
    a.createdAt === b.createdAt &&
    a.hidden === b.hidden
  );
}

/** The fields the grouper and the project header read from a workspace. */
function workspaceSignature(workspace: PairedSnapshotWorkspace): string {
  return JSON.stringify([
    workspace.localId,
    workspace.name,
    workspace.type,
    workspace.layout ?? null,
    workspace.color ?? null,
    workspace.owner ?? null,
    workspace.repositoryIdentity ?? null,
    workspace.placeholder ?? null,
    workspace.sharedFrom ?? null,
  ]);
}

function sameWorkspaces(
  a: readonly PairedSnapshotWorkspace[],
  b: readonly PairedSnapshotWorkspace[],
): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left === undefined ||
      right === undefined ||
      workspaceSignature(left) !== workspaceSignature(right)
    )
      return false;
  }
  return true;
}

function sameTasks(
  a: readonly PairedSidebarTask[],
  b: readonly PairedSidebarTask[],
): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined || !sameTask(left, right))
      return false;
  }
  return true;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalPipelineStatus(
  value: unknown,
): SnapshotWorktree['pipelineStatus'] {
  return value === 'running' ||
    value === 'unseen' ||
    value === 'unseen-failure' ||
    value === 'paused'
    ? value
    : undefined;
}

/** A task as sent, or null when it lacks the fields a row needs. */
function readTask(
  value: unknown,
): { task: PairedSidebarTask; live: PairedSidebarTaskLive } | null {
  if (!isRecord(value)) return null;
  const { localId, workspaceLocalId, branch } = value;
  if (
    typeof localId !== 'string' ||
    typeof workspaceLocalId !== 'string' ||
    typeof branch !== 'string'
  )
    return null;
  return {
    task: {
      localId,
      workspaceLocalId,
      branch,
      label: optionalString(value.label),
      order: optionalNumber(value.order),
      createdAt: optionalString(value.createdAt),
      hidden: optionalBoolean(value.hidden),
    },
    live: {
      isStreaming: optionalBoolean(value.isStreaming),
      busy: optionalBoolean(value.busy),
      isRunningRun: optionalBoolean(value.isRunningRun),
      pipelineStatus: optionalPipelineStatus(value.pipelineStatus),
      backgroundTasks: optionalNumber(value.backgroundTasks),
      awaitingApproval: optionalBoolean(value.awaitingApproval),
      hasUnread: optionalBoolean(value.hasUnread),
      status: optionalString(value.status),
      lastActivityAt: optionalString(value.lastActivityAt),
    },
  };
}

const PLACEHOLDER_STATES: Record<OrgProjectPlaceholderState, true> = {
  'ready-to-set-up': true,
  'choose-folder': true,
  'needs-github-access': true,
  offline: true,
  'access-changed': true,
  'not-local': true,
};

function isPlaceholderState(
  value: unknown,
): value is OrgProjectPlaceholderState {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PLACEHOLDER_STATES, value)
  );
}

function readWorkspaceOwner(
  value: unknown,
): { valid: true; owner: PairedSnapshotWorkspace['owner'] } | { valid: false } {
  if (value === undefined) return { valid: true, owner: undefined };
  if (!isRecord(value)) return { valid: false };
  if (value.type === 'personal')
    return { valid: true, owner: { type: 'personal' } };
  if (
    value.type === 'organization' &&
    typeof value.organizationId === 'string' &&
    typeof value.projectId === 'string'
  ) {
    return {
      valid: true,
      owner: {
        type: 'organization',
        organizationId: value.organizationId,
        projectId: value.projectId,
      },
    };
  }
  if (
    value.type === 'cloud-organization' &&
    typeof value.organizationId === 'string'
  ) {
    return {
      valid: true,
      owner: {
        type: 'cloud-organization',
        organizationId: value.organizationId,
      },
    };
  }
  return { valid: false };
}

function readWorkspacePlaceholder(
  value: unknown,
):
  | { valid: true; placeholder: PairedSnapshotWorkspace['placeholder'] }
  | { valid: false } {
  if (value === undefined) return { valid: true, placeholder: undefined };
  if (
    !isRecord(value) ||
    typeof value.projectId !== 'string' ||
    !isPlaceholderState(value.state)
  )
    return { valid: false };
  return {
    valid: true,
    placeholder: { projectId: value.projectId, state: value.state },
  };
}

function readWorkspaceLayout(
  value: unknown,
):
  | { valid: true; layout: RemoteControlWorkspaceLayout | undefined }
  | { valid: false } {
  if (value === undefined) return { valid: true, layout: undefined };
  if (value === 'tree' || value === 'flat')
    return { valid: true, layout: value };
  return { valid: false };
}

/**
 * Validates one workspace from a paired computer's snapshot, including nested
 * repository and ownership metadata so a malformed peer reply can never throw
 * when grouped or rendered.
 */
function readSnapshotWorkspace(value: unknown): PairedSnapshotWorkspace | null {
  if (
    !isRecord(value) ||
    typeof value.localId !== 'string' ||
    value.localId.length === 0 ||
    typeof value.name !== 'string' ||
    (value.type !== 'single-repo' &&
      value.type !== 'multi-repo' &&
      value.type !== 'cowork')
  )
    return null;
  const layout = readWorkspaceLayout(value.layout);
  if (!layout.valid) return null;
  if (value.color !== undefined && typeof value.color !== 'string') return null;
  if (value.sharedFrom !== undefined && typeof value.sharedFrom !== 'boolean')
    return null;
  const owner = readWorkspaceOwner(value.owner);
  if (!owner.valid) return null;
  const placeholder = readWorkspacePlaceholder(value.placeholder);
  if (!placeholder.valid) return null;
  const repositoryIdentity =
    value.repositoryIdentity === undefined
      ? undefined
      : parseRemoteControlRepositoryIdentity(value.repositoryIdentity);
  if (
    value.repositoryIdentity !== undefined &&
    repositoryIdentity === undefined
  )
    return null;
  return {
    localId: value.localId,
    name: value.name,
    type: value.type,
    ...(layout.layout === undefined ? {} : { layout: layout.layout }),
    ...(value.color === undefined ? {} : { color: value.color }),
    ...(owner.owner === undefined ? {} : { owner: owner.owner }),
    ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
    ...(placeholder.placeholder === undefined
      ? {}
      : { placeholder: placeholder.placeholder }),
    ...(value.sharedFrom === true ? { sharedFrom: true } : {}),
  };
}

/**
 * Applies a computer's snapshot, keeping every object that did not change:
 * the structure while it lists the same things, and each task's status
 * while it reads the same. A reply that isn't a valid snapshot keeps the
 * last valid snapshot, and one for a computer no longer listed changes nothing.
 */
export function applyPairedSnapshot(
  deviceId: string,
  reply: unknown,
  onError?: (error: unknown) => void,
): void {
  if (
    !isRecord(reply) ||
    !Array.isArray(reply.workspaces) ||
    !Array.isArray(reply.worktrees)
  )
    return;
  const workspacesTruncated =
    reply.workspaces.length > MAX_PAIRED_SNAPSHOT_WORKSPACES;
  const tasksTruncated = reply.worktrees.length > MAX_PAIRED_SNAPSHOT_TASKS;
  if (workspacesTruncated || tasksTruncated) {
    onError?.(
      new Error(
        `Truncated oversized paired snapshot from ${deviceId}: ${reply.workspaces.length} workspaces (cap ${MAX_PAIRED_SNAPSHOT_WORKSPACES}), ${reply.worktrees.length} tasks (cap ${MAX_PAIRED_SNAPSHOT_TASKS})`,
      ),
    );
  }
  const workspaceLimit = Math.min(
    reply.workspaces.length,
    MAX_PAIRED_SNAPSHOT_WORKSPACES,
  );
  const workspaces: PairedSnapshotWorkspace[] = [];
  const keptWorkspaceIds = new Set<string>();
  for (let index = 0; index < workspaceLimit; index += 1) {
    const workspace = readSnapshotWorkspace(reply.workspaces[index]);
    if (workspace === null) return;
    workspaces.push(workspace);
    keptWorkspaceIds.add(workspace.localId);
  }
  const taskLimit = Math.min(reply.worktrees.length, MAX_PAIRED_SNAPSHOT_TASKS);
  const tasks: PairedSidebarTask[] = [];
  const liveByKey = new Map<string, PairedSidebarTaskLive>();
  for (let index = 0; index < taskLimit; index += 1) {
    const read = readTask(reply.worktrees[index]);
    if (read === null) continue;
    if (
      workspacesTruncated &&
      !keptWorkspaceIds.has(read.task.workspaceLocalId)
    )
      continue;
    const key = pairedTaskKey(read.task.workspaceLocalId, read.task.localId);
    if (liveByKey.has(key)) continue;
    tasks.push(read.task);
    liveByKey.set(key, read.live);
  }
  updateComputer(deviceId, (current) => {
    if (current === undefined) return null;
    const previous = current.structure;
    const structure =
      previous !== null &&
      sameWorkspaces(previous.workspaces, workspaces) &&
      sameTasks(previous.tasks, tasks)
        ? previous
        : { workspaces, tasks };
    const live = new Map<string, PairedSidebarTaskLive>();
    let liveChanged = current.live.size !== liveByKey.size;
    for (const [key, entry] of liveByKey) {
      const kept = current.live.get(key);
      if (kept !== undefined && sameLive(kept, entry)) live.set(key, kept);
      else {
        live.set(key, entry);
        liveChanged = true;
      }
    }
    if (structure === previous && !liveChanged) return current;
    return {
      ...current,
      structure,
      live: liveChanged ? live : current.live,
    };
  });
}

/**
 * What the sidebar shows for a computer in each connection state, or null
 * for one it doesn't list: offline, unpaired, ended, or with Remote Control
 * or the switch off (CAN-7774 keeps offline computers listed later).
 */
export function pairedSidebarStatus(
  state: PairedComputerState,
): PairedSidebarComputerStatus | null {
  switch (state.status) {
    case 'connected':
      // A computer that doesn't serve the sidebar can't list its tasks
      // here until it updates.
      return state.capabilities.includes('sidebar')
        ? 'connected'
        : 'needs-update';
    case 'needs-update':
      return 'needs-update';
    case 'idle':
    case 'connecting':
      return 'connecting';
    case 'unavailable':
      // `error` is retried on its own, so it reads as connecting.
      return state.reason === 'error' ? 'connecting' : null;
  }
}

export interface PairedComputerToFollow {
  readonly deviceId: string;
  readonly name: string;
}

const SNAPSHOT_CHANNEL = 'desktop:session-snapshot';
const SNAPSHOT_STALE_CHANNEL = 'desktop:session-snapshot-stale';
// The one-window list's `approvals` capability (CAN-7758), read only.
const APPROVALS_CAPABILITY = 'approvals';
const PENDING_APPROVALS_CHANNEL = 'approval:pending-requests';
const APPROVAL_REQUEST_CHANNEL = 'approval:request';
const APPROVAL_GONE_CHANNELS: ReadonlySet<string> = new Set([
  'approval:cancelled',
  'approval:auto-resolved',
]);
const DEFAULT_APPROVAL_JOURNAL_LIMIT = 512;
const DEFAULT_PENDING_APPROVALS_LIMIT = 512;
const DEFAULT_APPROVAL_READ_TIMEOUT_MS = 30_000;
const MAX_CONSECUTIVE_APPROVAL_RESYNCS = 1;

export interface PairedComputersSidebarFollowerOptions {
  readonly approvalJournalLimit?: number;
  readonly approvalReadTimeoutMs?: number;
}

const MAX_APPROVAL_ID_LENGTH = 256;

function isBoundedApprovalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_APPROVAL_ID_LENGTH
  );
}

/** A pending approval as main sends it: its request and the scoped task it waits in. */
function readApprovalRequest(
  value: unknown,
): { requestId: string; taskKey: string } | null {
  if (!isRecord(value)) return null;
  const { requestId, projectId, worktreeId } = value;
  return isBoundedApprovalId(requestId) &&
    isBoundedApprovalId(projectId) &&
    isBoundedApprovalId(worktreeId)
    ? { requestId, taskKey: pairedTaskKey(projectId, worktreeId) }
    : null;
}

function requestIdOf(value: unknown): string | null {
  return isRecord(value) && isBoundedApprovalId(value.requestId)
    ? value.requestId
    : null;
}

type ApprovalChange =
  | {
      readonly kind: 'add';
      readonly requestId: string;
      readonly taskKey: string;
    }
  | { readonly kind: 'remove'; readonly requestId: string };

function applyApprovalChange(
  approvals: Map<string, string>,
  change: ApprovalChange,
): void {
  if (change.kind === 'add') approvals.set(change.requestId, change.taskKey);
  else approvals.delete(change.requestId);
}

function sameTaskIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

interface Followed {
  name: string;
  holdId: string | null;
  /** Released: late replies change nothing. */
  stopped: boolean;
  /**
   * Ended or no longer reachable: not listed, and not held again until it
   * leaves the list it was given, so an ending the other computer sent is
   * not undone by holding it again at once.
   */
  dropped: boolean;
  reading: boolean;
  readAgain: boolean;
  readingApprovals: boolean;
  readApprovalsAgain: boolean;
  /** The computer announced the approvals capability in its last connected state. */
  approvalsServed: boolean;
  /** Pending tool approvals by request id, to the task each waits in. */
  approvals: Map<string, string>;
  /**
   * Approval pushes that arrived while `approval:pending-requests` was being
   * read, replayed over its reply so none is lost to the read.
   */
  approvalJournal: ApprovalChange[] | null;
  approvalJournalOverflowed: boolean;
  approvalReadTimer: ReturnType<typeof setTimeout> | null;
  approvalResyncs: number;
  unsubscribe: () => void;
}

/**
 * Holds every listed paired computer for the main window and keeps its rows
 * current. One snapshot read at a time per computer: a stale signal or a
 * reconnect during a read asks for one more after it, so replies never land
 * out of order. A failed read keeps the rows last read until the next
 * signal. `follow` takes the online paired computers; one that leaves the
 * list is released and its rows removed. `dispose` releases all of them, for
 * the switch turning off, signing out and the window closing.
 */
export class PairedComputersSidebarFollower {
  private readonly followed = new Map<string, Followed>();
  private disposed = false;

  private readonly approvalJournalLimit: number;
  private readonly approvalReadTimeoutMs: number;

  constructor(
    private readonly api: PairedComputersApi,
    /** Records a failed hold, read or release; the rows stay as last read. */
    private readonly onError: (error: unknown) => void,
    options?: PairedComputersSidebarFollowerOptions,
  ) {
    this.approvalJournalLimit = Math.max(
      1,
      options?.approvalJournalLimit ?? DEFAULT_APPROVAL_JOURNAL_LIMIT,
    );
    this.approvalReadTimeoutMs = Math.max(
      1,
      options?.approvalReadTimeoutMs ?? DEFAULT_APPROVAL_READ_TIMEOUT_MS,
    );
  }

  follow(computers: readonly PairedComputerToFollow[]): void {
    if (this.disposed) return;
    const wanted = new Map(computers.map((each) => [each.deviceId, each]));
    for (const deviceId of Array.from(this.followed.keys()))
      if (!wanted.has(deviceId)) this.stop(deviceId);
    for (const computer of wanted.values()) {
      const current = this.followed.get(computer.deviceId);
      if (current === undefined) this.start(computer);
      else if (current.name !== computer.name) {
        current.name = computer.name;
        updateComputer(computer.deviceId, (entry) =>
          entry === undefined || entry.name === computer.name
            ? (entry ?? null)
            : { ...entry, name: computer.name },
        );
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    for (const deviceId of Array.from(this.followed.keys()))
      this.stop(deviceId);
    this.disposed = true;
    writeComputers(new Map());
  }

  private start(computer: PairedComputerToFollow): void {
    const { deviceId } = computer;
    const entry: Followed = {
      name: computer.name,
      holdId: null,
      stopped: false,
      dropped: false,
      reading: false,
      readAgain: false,
      readingApprovals: false,
      readApprovalsAgain: false,
      approvalsServed: false,
      approvals: new Map(),
      approvalJournal: null,
      approvalJournalOverflowed: false,
      approvalReadTimer: null,
      approvalResyncs: 0,
      unsubscribe: () => undefined,
    };
    this.followed.set(deviceId, entry);
    updateComputer(deviceId, () => ({
      deviceId,
      name: computer.name,
      status: 'connecting',
      structure: null,
      live: EMPTY_LIVE,
      toolApprovals: EMPTY_TASK_IDS,
    }));
    // Subscribed before the hold, so no change between them is missed.
    const offState = this.api.onStateChanged(deviceId, (state) => {
      this.applyState(deviceId, entry, state);
    });
    const offUpdate = this.api.onUpdate(deviceId, (update) => {
      this.applyUpdate(deviceId, entry, update);
    });
    entry.unsubscribe = (): void => {
      offState();
      offUpdate();
    };
    this.api.hold(deviceId).then(
      (result) => {
        if (entry.stopped || entry.dropped) {
          this.releaseHold(result.holdId);
          return;
        }
        entry.holdId = result.holdId;
        this.applyState(deviceId, entry, result.state);
      },
      (error: unknown) => {
        if (entry.stopped) return;
        this.onError(error);
        this.drop(deviceId, entry);
      },
    );
  }

  private releaseHold(holdId: string): void {
    // Main drops holds itself on unpair, sign-out and the switch going off,
    // and a release of a hold it no longer knows does nothing.
    this.api.release(holdId).then(undefined, this.onError);
  }

  private letGo(entry: Followed): void {
    entry.unsubscribe();
    entry.readAgain = false;
    entry.readApprovalsAgain = false;
    if (entry.approvalReadTimer !== null) {
      clearTimeout(entry.approvalReadTimer);
      entry.approvalReadTimer = null;
    }
    entry.approvalJournal = null;
    if (entry.holdId !== null) this.releaseHold(entry.holdId);
    entry.holdId = null;
  }

  private stop(deviceId: string): void {
    const entry = this.followed.get(deviceId);
    if (entry === undefined) return;
    this.followed.delete(deviceId);
    entry.stopped = true;
    if (!entry.dropped) this.letGo(entry);
    updateComputer(deviceId, () => null);
  }

  private drop(deviceId: string, entry: Followed): void {
    if (entry.dropped || entry.stopped) return;
    entry.dropped = true;
    this.letGo(entry);
    updateComputer(deviceId, () => null);
  }

  private applyState(
    deviceId: string,
    entry: Followed,
    state: PairedComputerState,
  ): void {
    if (entry.stopped || entry.dropped) return;
    const status = pairedSidebarStatus(state);
    if (status === null) {
      this.drop(deviceId, entry);
      return;
    }
    updateComputer(deviceId, (current) =>
      current === undefined || current.status === status
        ? (current ?? null)
        : { ...current, status },
    );
    if (state.status === 'connected')
      entry.approvalsServed = state.capabilities.includes(APPROVALS_CAPABILITY);
    if (status === 'connected') this.read(deviceId, entry);
  }

  private applyUpdate(
    deviceId: string,
    entry: Followed,
    update: PairedComputerUpdate,
  ): void {
    if (entry.stopped || entry.dropped) return;
    if (update.type === 'push' && entry.approvalsServed) {
      if (update.channel === APPROVAL_REQUEST_CHANNEL) {
        const request = readApprovalRequest(update.args[0]);
        if (request !== null)
          this.changeApprovals(deviceId, entry, { kind: 'add', ...request });
        return;
      }
      if (APPROVAL_GONE_CHANNELS.has(update.channel)) {
        const requestId = requestIdOf(update.args[0]);
        if (requestId !== null)
          this.changeApprovals(deviceId, entry, { kind: 'remove', requestId });
        return;
      }
    }
    if (
      update.type === 'reconnected' ||
      (update.type === 'push' && update.channel === SNAPSHOT_STALE_CHANNEL)
    ) {
      entry.approvalResyncs = 0;
      this.read(deviceId, entry);
    }
  }

  private changeApprovals(
    deviceId: string,
    entry: Followed,
    change: ApprovalChange,
  ): void {
    if (
      change.kind === 'remove' ||
      entry.approvals.has(change.requestId) ||
      entry.approvals.size < DEFAULT_PENDING_APPROVALS_LIMIT
    ) {
      applyApprovalChange(entry.approvals, change);
    }
    if (entry.approvalJournal !== null) {
      if (entry.approvalJournal.length < this.approvalJournalLimit) {
        entry.approvalJournal.push(change);
      } else {
        entry.approvalJournalOverflowed = true;
        entry.approvalJournal = null;
      }
    }
    this.publishApprovals(deviceId, entry);
  }

  private publishApprovals(deviceId: string, entry: Followed): void {
    const taskIds = new Set(entry.approvals.values());
    updateComputer(deviceId, (current) =>
      current === undefined || sameTaskIds(current.toolApprovals, taskIds)
        ? (current ?? null)
        : { ...current, toolApprovals: taskIds },
    );
  }

  private discardPartialApprovalsAndResync(
    deviceId: string,
    entry: Followed,
    error: unknown,
    clearApprovals = true,
  ): void {
    this.onError(error);
    entry.approvalJournal = null;
    if (clearApprovals) {
      entry.approvals.clear();
      this.publishApprovals(deviceId, entry);
    }
    if (entry.approvalResyncs < MAX_CONSECUTIVE_APPROVAL_RESYNCS) {
      entry.approvalResyncs += 1;
      entry.readApprovalsAgain = true;
    }
  }

  /**
   * Reads the computer's pending tool approvals, as its own window would
   * (its bridge stands for its main window), alongside each snapshot read:
   * an approval answered on that computer sends no push here, and the turn
   * it resumes stales the snapshot, so the next read drops it. Runs under its
   * own single-flight guard so a slow approval RPC never stalls snapshots.
   */
  private readApprovals(deviceId: string, entry: Followed): void {
    if (!entry.approvalsServed) {
      entry.approvalResyncs = 0;
      entry.readApprovalsAgain = false;
      if (entry.approvalReadTimer !== null) {
        clearTimeout(entry.approvalReadTimer);
        entry.approvalReadTimer = null;
      }
      entry.approvalJournal = null;
      entry.approvalJournalOverflowed = false;
      if (entry.approvals.size > 0) {
        entry.approvals.clear();
        this.publishApprovals(deviceId, entry);
      }
      return;
    }
    if (entry.readingApprovals) {
      entry.readApprovalsAgain = true;
      return;
    }
    entry.readingApprovals = true;
    entry.readApprovalsAgain = false;
    const journal: ApprovalChange[] = [];
    entry.approvalJournal = journal;
    entry.approvalJournalOverflowed = false;
    let timedOut = false;
    let settled = false;
    const clearTimerAndJournal = (): void => {
      if (entry.approvalReadTimer === timer) entry.approvalReadTimer = null;
      clearTimeout(timer);
      if (entry.approvalJournal === journal) entry.approvalJournal = null;
    };
    const timer = setTimeout(() => {
      if (settled || entry.stopped || entry.dropped || !entry.approvalsServed) {
        clearTimerAndJournal();
        return;
      }
      timedOut = true;
      clearTimerAndJournal();
      // Keep the last confirmed approval set unless a journal overflow made
      // it unsafe, while keeping `readingApprovals` set until the underlying
      // paired invoke settles so retries never stack outstanding RPCs in RpcPeer.
      this.discardPartialApprovalsAndResync(
        deviceId,
        entry,
        new Error('Timed out reading pending approvals from paired computer'),
        entry.approvalJournalOverflowed,
      );
    }, this.approvalReadTimeoutMs);
    entry.approvalReadTimer = timer;
    this.api
      .invoke(deviceId, PENDING_APPROVALS_CHANNEL, [])
      .then(
        (reply) => {
          if (
            timedOut ||
            entry.stopped ||
            entry.dropped ||
            !entry.approvalsServed
          )
            return;
          if (entry.approvalJournalOverflowed) {
            this.discardPartialApprovalsAndResync(
              deviceId,
              entry,
              new Error(
                'Approval update journal exceeded limit during pending-requests read',
              ),
            );
            return;
          }
          if (entry.approvalJournal !== journal) return;
          if (!Array.isArray(reply)) return;
          const approvals = new Map<string, string>();
          const limit = Math.min(reply.length, DEFAULT_PENDING_APPROVALS_LIMIT);
          for (let index = 0; index < limit; index += 1) {
            const request = readApprovalRequest(reply[index]);
            if (request !== null)
              approvals.set(request.requestId, request.taskKey);
          }
          for (const change of journal) {
            if (
              change.kind === 'remove' ||
              approvals.has(change.requestId) ||
              approvals.size < DEFAULT_PENDING_APPROVALS_LIMIT
            ) {
              applyApprovalChange(approvals, change);
            }
          }
          entry.approvals = approvals;
          entry.approvalResyncs = 0;
          this.publishApprovals(deviceId, entry);
        },
        (error: unknown) => {
          if (
            timedOut ||
            entry.stopped ||
            entry.dropped ||
            !entry.approvalsServed
          )
            return;
          if (entry.approvalJournalOverflowed) {
            this.discardPartialApprovalsAndResync(deviceId, entry, error);
            return;
          }
          // The approvals last read stay, kept current by the pushes since.
          this.onError(error);
        },
      )
      .finally(() => {
        settled = true;
        clearTimerAndJournal();
        entry.readingApprovals = false;
        if (
          entry.readApprovalsAgain &&
          !entry.stopped &&
          !entry.dropped &&
          entry.approvalsServed
        ) {
          this.readApprovals(deviceId, entry);
        }
      });
  }

  private read(deviceId: string, entry: Followed): void {
    if (entry.reading) {
      entry.readAgain = true;
      return;
    }
    entry.reading = true;
    entry.readAgain = false;
    this.api
      .invoke(deviceId, SNAPSHOT_CHANNEL, [{}])
      .then(
        (reply) => {
          if (entry.stopped || entry.dropped) return;
          applyPairedSnapshot(deviceId, reply, this.onError);
          this.readApprovals(deviceId, entry);
        },
        (error: unknown) => {
          // The rows last read stay; the next signal reads again. A call
          // refused while the session resumes is read again on connect.
          if (!entry.stopped && !entry.dropped) this.onError(error);
        },
      )
      .finally(() => {
        entry.reading = false;
        if (entry.readAgain && !entry.stopped && !entry.dropped)
          this.read(deviceId, entry);
      });
  }
}

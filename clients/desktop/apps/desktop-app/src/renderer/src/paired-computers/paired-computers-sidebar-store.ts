import { createStore } from 'zustand/vanilla';
import type {
  PairedComputerState,
  PairedComputerUpdate,
  PairedComputersApi,
} from '@canopy/desktop-shared/types';
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
  /** By the task's own local id on that computer. */
  readonly live: ReadonlyMap<string, PairedSidebarTaskLive>;
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
      backgroundTasks: optionalNumber(value.backgroundTasks),
      awaitingApproval: optionalBoolean(value.awaitingApproval),
      hasUnread: optionalBoolean(value.hasUnread),
      status: optionalString(value.status),
      lastActivityAt: optionalString(value.lastActivityAt),
    },
  };
}

function isSnapshotWorkspace(value: unknown): value is PairedSnapshotWorkspace {
  return (
    isRecord(value) &&
    typeof value.localId === 'string' &&
    typeof value.name === 'string' &&
    (value.type === 'single-repo' ||
      value.type === 'multi-repo' ||
      value.type === 'cowork')
  );
}

/**
 * Applies a computer's snapshot, keeping every object that did not change:
 * the structure while it lists the same things, and each task's status
 * while it reads the same. A reply that isn't a snapshot changes nothing,
 * and neither does one for a computer no longer listed.
 */
export function applyPairedSnapshot(deviceId: string, reply: unknown): void {
  if (
    !isRecord(reply) ||
    !Array.isArray(reply.workspaces) ||
    !Array.isArray(reply.worktrees)
  )
    return;
  const workspaces = reply.workspaces.filter(isSnapshotWorkspace);
  const tasks: PairedSidebarTask[] = [];
  const liveById = new Map<string, PairedSidebarTaskLive>();
  for (const value of reply.worktrees) {
    const read = readTask(value);
    if (read === null || liveById.has(read.task.localId)) continue;
    tasks.push(read.task);
    liveById.set(read.task.localId, read.live);
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
    let liveChanged = current.live.size !== liveById.size;
    for (const [id, entry] of liveById) {
      const kept = current.live.get(id);
      if (kept !== undefined && sameLive(kept, entry)) live.set(id, kept);
      else {
        live.set(id, entry);
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

  constructor(
    private readonly api: PairedComputersApi,
    /** Records a failed hold, read or release; the rows stay as last read. */
    private readonly onError: (error: unknown) => void,
  ) {}

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
      unsubscribe: () => undefined,
    };
    this.followed.set(deviceId, entry);
    updateComputer(deviceId, () => ({
      deviceId,
      name: computer.name,
      status: 'connecting',
      structure: null,
      live: EMPTY_LIVE,
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
    if (status === 'connected') this.read(deviceId, entry);
  }

  private applyUpdate(
    deviceId: string,
    entry: Followed,
    update: PairedComputerUpdate,
  ): void {
    if (entry.stopped || entry.dropped) return;
    if (
      update.type === 'reconnected' ||
      (update.type === 'push' && update.channel === SNAPSHOT_STALE_CHANNEL)
    )
      this.read(deviceId, entry);
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
          if (!entry.stopped && !entry.dropped)
            applyPairedSnapshot(deviceId, reply);
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

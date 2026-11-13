import { setMaxListeners } from 'node:events';
import type {
  PipelineOwnerLease,
  PipelineOwnerLeaseObservation,
} from '@canopy/core-runtime/node/pipeline/host';
import type { ExecutionState } from '../../../types/pipeline';

/*
 * The owner fence (CAN-4140, CAN-6198): what an execution records about the
 * process that owns it, and which writes that process may still make. It is
 * a port with two implementations:
 *
 * - The local fence, on desktop and in the daemon. A running execution
 *   records its owner's PID and, when the host can prove it, the owner's
 *   start identity. A live PID whose start identity differs is a reused
 *   PID, so its execution is orphaned. Without a recorded identity or a host
 *   inspector, detection falls back to PID liveness alone.
 * - The lease fence, on a cloud runner. Every runner incarnation runs as
 *   the same PIDs in its own container, so a PID proves nothing there. The
 *   execution records the incarnation's delegation lease epoch instead. A
 *   write over a run a newer epoch recorded is refused, and once the lease
 *   lapses or a newer epoch is reported, every write is refused and the run
 *   loops stop.
 *
 * One fence is installed per process: the execution store's writer admission
 * is process-wide (its lock and install cache are), and the fence describes
 * the process as a writer. The host that serves the store installs it before
 * its first write; until then the local fence without an inspector applies.
 */

export type PipelineOwnerInspection =
  | { state: 'running'; startIdentity: string }
  | { state: 'absent' }
  | { state: 'unverifiable' };

export type PipelineOwnerInspector = (
  pid: number,
) => Promise<PipelineOwnerInspection>;

export type PipelineOwnerFields = Pick<
  ExecutionState,
  'owner_pid' | 'owner_start_identity' | 'owner_lease_epoch'
>;

/** What a stored execution says about its owner, for write admission. */
export type PipelineInstalledOwner = PipelineOwnerFields &
  Pick<ExecutionState, 'status'>;

/**
 * Why a fence refuses a write: another live owner holds the run, or this
 * process's own lease is gone (lapsed or superseded).
 */
export type PipelineOwnerWriteRefusal =
  | 'owned_by_other_process'
  | 'owner_fenced';

export interface PipelineOwnerFence {
  /** The owner fields this process writes when it takes an execution. */
  ownerFields(): PipelineOwnerFields;
  /**
   * Whether the execution's owner is provably gone: its PID is not running,
   * a different process now holds it, or an older lease epoch recorded it.
   * An unprovable owner is not orphaned.
   */
  isKnownOrphaned(state: PipelineOwnerFields): Promise<boolean>;
  /**
   * Why this process may not write over `installed` (null: no state is
   * stored yet), or null when it may.
   */
  refuseWrite(
    installed: PipelineInstalledOwner | null,
  ): Promise<PipelineOwnerWriteRefusal | null>;
  /**
   * Aborted once this process may write nothing more: its run loops stop
   * without writing. Never aborted for a local fence.
   */
  readonly fenced: AbortSignal;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error))
    return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

function isLive(status: ExecutionState['status']): boolean {
  return status === 'pending' || status === 'running';
}

/** Process liveness and start identity: the local fence's orphan rule. */
async function isOrphanedProcessOwner(
  state: PipelineOwnerFields,
  inspect: PipelineOwnerInspector | null,
): Promise<boolean> {
  const pid = state.owner_pid;
  if (
    pid === undefined ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    pid === process.pid
  )
    return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
  const recorded = state.owner_start_identity;
  if (recorded === undefined || !inspect) return false;
  const current = await inspect(pid).catch(
    (): PipelineOwnerInspection => ({ state: 'unverifiable' }),
  );
  if (current.state === 'absent') return true;
  return current.state === 'running' && current.startIdentity !== recorded;
}

/** The local fence's write rule: a live run another live process owns is refused. */
async function refuseForeignProcessOwner(
  installed: PipelineInstalledOwner | null,
  inspect: PipelineOwnerInspector | null,
): Promise<PipelineOwnerWriteRefusal | null> {
  if (
    installed !== null &&
    isLive(installed.status) &&
    installed.owner_pid !== undefined &&
    installed.owner_pid !== process.pid &&
    !(await isOrphanedProcessOwner(installed, inspect))
  )
    return 'owned_by_other_process';
  return null;
}

/** Every run listens on its process's fence; none of them is a leak. */
function unboundedSignal(controller: AbortController): AbortSignal {
  setMaxListeners(0, controller.signal);
  return controller.signal;
}

const NEVER_FENCED = unboundedSignal(new AbortController());

/**
 * The local fence over the host's process inspector. It records this
 * process's start identity once the inspector proves it; executions that
 * start before then record only their PID.
 */
function createLocalPipelineOwnerFence(
  inspect: PipelineOwnerInspector | null,
): PipelineOwnerFence & { readonly ready: Promise<void> } {
  let selfIdentity: string | null = null;
  const ready = inspect
    ? inspect(process.pid)
        .catch((): PipelineOwnerInspection => ({ state: 'unverifiable' }))
        .then((self) => {
          if (self.state === 'running') selfIdentity = self.startIdentity;
        })
    : Promise.resolve();
  return {
    ready,
    ownerFields: () => ({
      owner_pid: process.pid,
      ...(selfIdentity !== null && { owner_start_identity: selfIdentity }),
    }),
    isKnownOrphaned: (state) => isOrphanedProcessOwner(state, inspect),
    refuseWrite: (installed) => refuseForeignProcessOwner(installed, inspect),
    fenced: NEVER_FENCED,
  };
}

export type PipelineLeaseFenceState = 'held' | 'lapsed' | 'superseded';

export interface PipelineLeaseOwnerFence extends PipelineOwnerFence {
  readonly leaseEpoch: number;
  state(): PipelineLeaseFenceState;
  /** Applies what the runner learned about its lease over the relay. */
  observe(observation: PipelineOwnerLeaseObservation): void;
  /** Stops the lapse timer; the fence's state stays as it is. */
  dispose(): void;
}

/** The longest delay a timer takes. */
const TIMER_MAX_MS = 2_147_483_647;

/**
 * The cloud runner's fence (CAN-6198), keyed to the delegation lease epoch
 * the web core granted this incarnation (`DelegationLeaseRecord.leaseEpoch`,
 * CAN-6162; not `runEpoch`). It stamps each execution this process takes
 * with the epoch. A write over a run a newer epoch recorded is refused; a
 * run an older epoch recorded is this incarnation's to take; one its own
 * epoch recorded falls back to the PID rule, for a host the runner
 * relaunched. Once the lease lapses unrenewed or a newer epoch is reported,
 * the fence closes for good: every write is refused and `fenced` aborts,
 * so each run loop stops. Only a new incarnation, with a new epoch, runs
 * the work again. The store checks the fence when a write starts and
 * again just before it installs the file, so only a fence that closes
 * during the rename itself can miss a write; the executor reports nothing
 * after it closes, and the web core, the only durable writer, refuses the
 * older epoch's frames.
 */
export function createLeasePipelineOwnerFence(options: {
  readonly lease: PipelineOwnerLease;
  readonly now?: () => number;
}): PipelineLeaseOwnerFence {
  const now = options.now ?? Date.now;
  const leaseEpoch = options.lease.leaseEpoch;
  let expiresAt = options.lease.expiresAt;
  let state: PipelineLeaseFenceState = 'held';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();

  const close = (next: Exclude<PipelineLeaseFenceState, 'held'>): void => {
    if (state !== 'held') return;
    state = next;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    controller.abort(next);
  };
  /** The state now: a lease past its expiry lapses even before its timer fires. */
  const current = (): PipelineLeaseFenceState => {
    if (state === 'held' && now() >= expiresAt) close('lapsed');
    return state;
  };
  const armLapse = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (current() !== 'held') return;
    timer = setTimeout(
      armLapse,
      Math.min(Math.max(expiresAt - now(), 0), TIMER_MAX_MS),
    );
    timer.unref?.();
  };
  armLapse();

  return {
    leaseEpoch,
    state: current,
    observe: (observation) => {
      if (current() !== 'held') return;
      if (observation.kind === 'superseded') {
        if (
          observation.leaseEpoch === undefined ||
          observation.leaseEpoch > leaseEpoch
        )
          close('superseded');
        return;
      }
      const renewed = observation.lease;
      if (renewed.leaseEpoch > leaseEpoch) return close('superseded');
      if (renewed.leaseEpoch < leaseEpoch || renewed.expiresAt <= expiresAt)
        return;
      expiresAt = renewed.expiresAt;
      armLapse();
    },
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    ownerFields: () => ({
      owner_pid: process.pid,
      owner_lease_epoch: leaseEpoch,
    }),
    isKnownOrphaned: async (recorded) => {
      const epoch = recorded.owner_lease_epoch;
      if (epoch !== undefined && epoch !== leaseEpoch)
        return epoch < leaseEpoch;
      return isOrphanedProcessOwner(recorded, null);
    },
    refuseWrite: async (installed) => {
      if (current() !== 'held') return 'owner_fenced';
      const epoch = installed?.owner_lease_epoch;
      if (epoch !== undefined && epoch > leaseEpoch) {
        // A newer incarnation saved this run: this one is superseded.
        close('superseded');
        return 'owned_by_other_process';
      }
      if (epoch !== undefined && epoch < leaseEpoch) return null;
      return refuseForeignProcessOwner(installed, null);
    },
    fenced: unboundedSignal(controller),
  };
}

let installed: PipelineOwnerFence = createLocalPipelineOwnerFence(null);

/** Installs the fence this process's writes go through (CAN-6198). */
export function installPipelineOwnerFence(fence: PipelineOwnerFence): void {
  installed = fence;
}

/** The fence this process's writes go through. */
export function pipelineOwnerFence(): PipelineOwnerFence {
  return installed;
}

/**
 * Installs the local fence over the host's process inspector and waits
 * until it has recorded this process's start identity.
 */
export async function configurePipelineOwnerFence(
  inspect: PipelineOwnerInspector | null,
): Promise<void> {
  const fence = createLocalPipelineOwnerFence(inspect);
  installPipelineOwnerFence(fence);
  await fence.ready;
}

/** The owner fields a process writes when it takes an execution. */
export function pipelineOwnerFields(): PipelineOwnerFields {
  return installed.ownerFields();
}

/** Take ownership of a loaded execution, replacing its previous owner. */
export function claimPipelineOwner(state: PipelineOwnerFields): void {
  const fields = pipelineOwnerFields();
  state.owner_pid = fields.owner_pid;
  if (fields.owner_start_identity === undefined)
    delete state.owner_start_identity;
  else state.owner_start_identity = fields.owner_start_identity;
  if (fields.owner_lease_epoch === undefined) delete state.owner_lease_epoch;
  else state.owner_lease_epoch = fields.owner_lease_epoch;
}

/**
 * Whether the execution's owner is provably gone, by the installed fence.
 * An unprovable owner is not orphaned.
 */
export function isKnownOrphanedExecution(
  state: PipelineOwnerFields,
): Promise<boolean> {
  return installed.isKnownOrphaned(state);
}

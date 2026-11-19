import path from 'node:path';
import type { ExecutionState } from '../../../types/pipeline';
import {
  isExecutionOwnerWriteRefusal,
  loadExecutionStateRevision,
  readExecutionStateRevision,
  saveExecutionStateIfUnchanged,
} from './execution-state';

/*
 * A run that ended while its state could not be saved (CAN-7095). The store
 * still says `running` under an owner that is alive, so orphan recovery
 * leaves it alone and nothing else would settle it before that process
 * exits: the daemon's pipeline host can outlive the app by days. The process
 * that ran it therefore keeps trying to save the settled state, here, until
 * a save lands, another writer installs a state of its own, or the attempts
 * run out. A run whose state was never stored has nothing to correct.
 */

const FIRST_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
/** Doubling from one second to one a minute: about an hour in all. */
const MAX_RETRY_ATTEMPTS = 64;

/** Stops each pending retry, by its run's stored file. */
const pending = new Map<string, () => void>();

function keyOf(executionId: string, executionsDir: string): string {
  return path.join(path.resolve(executionsDir), executionId);
}

/**
 * Stops saving the settled state an earlier incarnation of the run left
 * unsaved: a newer one in this process now writes the run's state.
 */
export function forgetUnsavedSettledState(
  executionId: string,
  executionsDir: string,
): void {
  pending.get(keyOf(executionId, executionsDir))?.();
}

/**
 * Saves `state`, the settled state its run could not save, in the
 * background. Every attempt installs only over a state that still shows the
 * run pending or running under the run's own owner, unchanged since it was
 * read, so a cancel, a pause, a recovery, a newer incarnation or another
 * owner that wrote the run since keeps what it wrote. The timers never hold
 * the process open.
 */
export function saveSettledStateLater(options: {
  /** The caller's own copy: it is not read again by its run. */
  readonly state: ExecutionState;
  readonly executionsDir: string;
  /** Whether the run's owner fence closed: then nothing more is written. */
  readonly abandoned: () => boolean;
}): void {
  const { state, executionsDir, abandoned } = options;
  const key = keyOf(state.id, executionsDir);
  pending.get(key)?.();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (pending.get(key) === stop) pending.delete(key);
  };
  pending.set(key, stop);
  const over = (): boolean => stopped || abandoned();

  /**
   * The revision of the file the failed save left, once a read of it
   * succeeded. A read that fails for a moment (EACCES, EIO) is tried again by
   * the next attempt; a missing file ends the retry.
   */
  let revision: string | undefined;
  const readRevision = async (): Promise<string | null> => {
    if (revision !== undefined) return revision;
    const loaded = await loadExecutionStateRevision(state.id, executionsDir);
    // Every read, the first included, can come after another writer: a run
    // it ended or paused (a cancel, say), or one another owner took, stays
    // as it saved it. The run only ever left its state pending or running,
    // so only such a state under its own owner is the one to correct, and an
    // unchanged revision keeps it that state.
    if (
      loaded === null ||
      !isLive(loaded.state.status) ||
      !hasSameOwner(loaded.state, state)
    )
      return null;
    revision = loaded.revision;
    return revision;
  };

  /** Whether there is nothing more to try. */
  const attempt = async (): Promise<boolean> => {
    if (over()) return true;
    try {
      const expected = await readRevision();
      // Checked first: a save would create the folder of a store that is gone.
      if (
        expected === null ||
        (await readExecutionStateRevision(state.id, executionsDir)) !== expected
      )
        return true;
      await saveExecutionStateIfUnchanged(state, executionsDir, expected);
      return true;
    } catch (error) {
      return isExecutionOwnerWriteRefusal(error);
    }
  };
  const schedule = (attempts: number): void => {
    if (over() || attempts >= MAX_RETRY_ATTEMPTS) {
      stop();
      return;
    }
    timer = setTimeout(
      () => {
        timer = undefined;
        void attempt().then((done) => {
          if (done) stop();
          else schedule(attempts + 1);
        });
      },
      Math.min(FIRST_RETRY_DELAY_MS * 2 ** attempts, MAX_RETRY_DELAY_MS),
    );
    timer.unref?.();
  };

  // Read now, as soon after the failed save as can be. A state that is not
  // the one to correct ends the retry; a failed read leaves the revision to
  // the first attempt.
  void readRevision()
    .catch(() => undefined)
    .then((read) => {
      if (read === null) stop();
      else schedule(0);
    });
}

/** Whether the stored run still shows as running: what a failed save leaves. */
function isLive(status: ExecutionState['status']): boolean {
  return status === 'pending' || status === 'running';
}

/** Whether the same owner incarnation recorded both states (CAN-6198). */
function hasSameOwner(stored: ExecutionState, state: ExecutionState): boolean {
  return (
    stored.owner_pid === state.owner_pid &&
    stored.owner_start_identity === state.owner_start_identity &&
    stored.owner_lease_epoch === state.owner_lease_epoch
  );
}

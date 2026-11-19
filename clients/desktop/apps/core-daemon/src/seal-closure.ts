import type { ClosureGate } from './closure-gate';
import type { DaemonDirectoryInputs } from './directory-inputs';
import type { DaemonW5Host } from './w5-host';

// Bounds the Git host stop when no phase 5 ran (the phase's own deadline).
const SEAL_TIMEOUT_MS = 5_000;

/**
 * Drains before sealing the gate, then stops Git and W5 within one deadline.
 * Never rejects; `false` means closure is unconfirmed.
 */
export async function sealClosure(
  gate: ClosureGate,
  directory: DaemonDirectoryInputs | undefined,
  w5?: DaemonW5Host,
  beforeSeal?: (signal: AbortSignal) => Promise<boolean | void>,
): Promise<boolean> {
  // A referenced timer: AbortSignal.timeout's is unref'd, so a hung stop with
  // no handle of its own would drain the loop past main's explicit exit.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), SEAL_TIMEOUT_MS);
  const expired = new Promise<'expired'>((resolve) =>
    deadline.signal.addEventListener('abort', () => resolve('expired'), {
      once: true,
    }),
  );
  try {
    const disposed = await Promise.race([
      beforeSeal
        ? beforeSeal(deadline.signal)
            .then(
              (confirmed) => confirmed !== false && !deadline.signal.aborted,
            )
            .catch(() => false)
        : true,
      expired,
    ]);
    // An unconfirmed drain must never be followed by a confirmed seal.
    // The host exits on false; it cannot safely start another run in this process.
    if (disposed === true) gate.seal();
    // Every owner is asked to stop, even if another cannot confirm closure.
    const closed = Promise.all([
      directory
        ? directory.close(deadline.signal).then((state) => state === 'stopped')
        : true,
      w5 ? w5.stop().then((state) => state === 'stopped') : true,
    ])
      .then((states) => states.every(Boolean))
      .catch(() => false);
    const stopped = await Promise.race([closed, expired]);
    return disposed === true && stopped === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

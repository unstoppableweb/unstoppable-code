import { W5RecoveryReasonSchema } from '@canopy/protocol/remote-control/shell';
import type {
  W5RecoveryEntry,
  W5RecoveryReason,
  W5RecoveryStatus,
} from '@canopy/protocol/remote-control/shell';

/** Eligibility is assessed from typed record evidence, never display entries. */
export interface W5RecoverySnapshot {
  readonly entries: readonly W5RecoveryEntry[];
  readonly applicability:
    | 'current-target'
    | 'retained-target'
    | 'none'
    | 'unavailable';
  /** Only for evidence still shown, never a replayed cause of a current failure. */
  readonly reason?: W5RecoveryReason;
}

export interface W5RecoveryControllerPorts {
  enabled(): boolean;
  supported(): boolean;
  live(): Promise<W5RecoverySnapshot>;
  peers(): Promise<readonly string[]>;
  quiesce(): Promise<void>;
  request(): Promise<void>;
  onChanged?(status: W5RecoveryStatus): void;
}
export interface W5RecoveryController {
  status(): Promise<W5RecoveryStatus>;
  prepare(): Promise<W5RecoveryStatus>;
  peek(): W5RecoveryStatus;
}
const hidden = (): W5RecoveryStatus => ({
  state: 'hidden',
  canRecover: false,
  entries: [],
});

/** The latch is one-way, including when durable intent fails: restart to resume. */
export function createW5RecoveryController(
  ports: W5RecoveryControllerPorts,
): W5RecoveryController {
  let current = hidden();
  const update = (next: W5RecoveryStatus): void => {
    const changed = JSON.stringify(current) !== JSON.stringify(next);
    current = next;
    if (changed) ports.onChanged?.(current);
  };
  let fenced = false;
  let reading: Promise<W5RecoveryStatus> | undefined;
  let preparing: Promise<W5RecoveryStatus> | undefined;
  const status = (): Promise<W5RecoveryStatus> => {
    if (!ports.enabled()) return Promise.resolve(hidden());
    if (fenced) return Promise.resolve(current);
    if (reading) return reading;
    const flight = (async (): Promise<W5RecoveryStatus> => {
      try {
        const snapshot = await ports.live();
        const entries = [...snapshot.entries].slice(0, 200);
        if (fenced) return current;
        update(
          entries.length === 0
            ? hidden()
            : ports.supported()
              ? {
                  state: 'blocked',
                  canRecover:
                    snapshot.applicability === 'current-target' ||
                    snapshot.applicability === 'retained-target',
                  ...(snapshot.reason ? { reason: snapshot.reason } : {}),
                  entries,
                }
              : {
                  state: 'refused',
                  canRecover: false,
                  reason: 'platform-unsupported',
                  entries,
                },
        );
      } catch {
        // Only an explicitly retained target can survive an unavailable read.
        if (!fenced) update({ ...current, canRecover: false });
      }
      return current;
    })();
    reading = flight;
    void flight.finally(() => {
      if (reading === flight) reading = undefined;
    });
    return flight;
  };
  const prepare = (): Promise<W5RecoveryStatus> => {
    if (!ports.enabled()) return Promise.resolve(hidden());
    if (preparing) return preparing;
    if (fenced) return Promise.resolve(current);
    if (!ports.supported()) return status();
    const flight = (async (): Promise<W5RecoveryStatus> => {
      try {
        if (!(await status()).canRecover) return current;
        const peers = await ports.peers();
        if (peers.length) {
          update({
            ...current,
            state: 'refused',
            canRecover: false,
            reason: peers.includes('cli') ? 'cli-active' : 'host-active',
          });
          return current;
        }
        // A status read that settled during peer inspection may have cleared the target.
        if (!current.canRecover) return current;
        // Set before awaiting: an in-flight status read cannot undo the latch.
        fenced = true;
        update({ ...current, state: 'restart-required', canRecover: false });
        await ports.quiesce();
        await ports.request();
      } catch (error) {
        const reason = W5RecoveryReasonSchema.safeParse(
          typeof error === 'object' && error !== null && 'reason' in error
            ? error.reason
            : undefined,
        );
        update({
          ...current,
          state: 'refused',
          canRecover: false,
          reason: reason.success
            ? reason.data
            : fenced
              ? 'request-unavailable'
              : 'cohort-ambiguous',
        });
      }
      return current;
    })();
    preparing = flight;
    void flight.finally(() => {
      if (preparing === flight) preparing = undefined;
    });
    return flight;
  };
  return { status, prepare, peek: () => current };
}

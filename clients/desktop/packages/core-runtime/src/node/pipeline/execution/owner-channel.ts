import {
  PipelineHostRequestBroker,
  createWorkerPipelineHostRequestHandlers,
  type WorkerPipelineHostRequestHandlers,
} from './host-requests';

/**
 * The daemon's host request channel (CAN-5771): one broker that announces
 * withdrawals, served to at most one owner subscription at a time.
 */
export interface PipelineOwnerChannel {
  readonly broker: PipelineHostRequestBroker;
  readonly handlers: WorkerPipelineHostRequestHandlers;
  /** Whether an owner subscription is open now. */
  ownerSubscribed(): boolean;
  /** Called on every change of `ownerSubscribed()`; returns its removal. */
  onOwnerChange(listener: (subscribed: boolean) => void): () => void;
  /**
   * Called synchronously whenever an owner subscription ends, including when
   * another replaces it, before a later subscription receives the pending
   * requests (CAN-6996); returns its removal. `replaced` is true when a new
   * subscription takes over in the same turn, which `onOwnerChange` never
   * reports since `ownerSubscribed()` stays true.
   */
  onOwnerEpochEnd(listener: (replaced: boolean) => void): () => void;
}

interface OwnerSubscription {
  end(): void;
  unsubscribe(): void;
}

export function createPipelineOwnerChannel(): PipelineOwnerChannel {
  const broker = new PipelineHostRequestBroker({ announceWithdrawals: true });
  const listeners = new Set<(subscribed: boolean) => void>();
  const epochListeners = new Set<(replaced: boolean) => void>();
  let current: OwnerSubscription | null = null;
  let announced = false;

  /** Tells listeners when `ownerSubscribed()` changed since they last heard. */
  const sync = (): void => {
    const subscribed = current !== null;
    if (subscribed === announced) return;
    announced = subscribed;
    for (const listener of Array.from(listeners)) {
      try {
        listener(subscribed);
      } catch {
        // A listener's failure never reaches the channel or the owner.
      }
    }
  };

  const epochEnded = (replaced: boolean): void => {
    for (const listener of Array.from(epochListeners)) {
      try {
        listener(replaced);
      } catch {
        // A listener's failure never reaches the channel or the owner.
      }
    }
  };

  /** Ends `subscription`; when it is the current one, the owner is gone. */
  const release = (subscription: OwnerSubscription): void => {
    subscription.unsubscribe();
    if (current !== subscription) return;
    current = null;
    epochEnded(false);
    sync();
  };

  return {
    broker,
    handlers: {
      instructions:
        createWorkerPipelineHostRequestHandlers(broker).instructions,
      streams: {
        'worker.pipeline.hostRequests': (
          _params,
          _context,
          sink,
        ): Promise<() => void> => {
          const replaced = current;
          if (replaced) {
            current = null;
            replaced.end();
            replaced.unsubscribe();
            epochEnded(true);
          }
          let stop: (() => void) | null = null;
          let stopped = false;
          const subscription: OwnerSubscription = {
            end: () => sink.end('completed'),
            unsubscribe: () => {
              stopped = true;
              stop?.();
            },
          };
          current = subscription;
          stop = broker.subscribe((item) => {
            if (sink.emit(item) === null) release(subscription);
          });
          if (stopped) stop();
          sync();
          return Promise.resolve(() => release(subscription));
        },
      },
    },
    ownerSubscribed: () => current !== null,
    onOwnerChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onOwnerEpochEnd(listener) {
      epochListeners.add(listener);
      return () => {
        epochListeners.delete(listener);
      };
    },
  };
}

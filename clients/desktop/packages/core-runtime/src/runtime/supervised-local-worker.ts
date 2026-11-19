import type { LocalWorkerTransport } from './local-worker-transport';
import type {
  InProcessWorkerBindingForwarders,
  LocalWorkerBindingClient,
} from './local-worker-binding-client';
import {
  directed,
  type BoundOperation,
  type WorkerBindingDefinitions,
} from './local-worker-binding-wire';
import { canopyUnavailableError } from './errors';
import {
  WORKER_EXECUTOR_RECEIPTS_MAX,
  type WorkerExecutorReceipt,
} from './worker-executor-receipts';

/**
 * The core's stable route to a local worker in a separate supervised
 * process. Each worker start attaches a new binding; while none is attached,
 * every call fails as `unavailable` (directed for instructions) and nothing
 * queues. Keyed instructions are remembered per worker, so a receipt for one
 * sent to a worker that has since gone answers `unavailable` rather than
 * "never arrived": its effect may have happened.
 */
export interface SupervisedLocalWorker {
  readonly forwarders: InProcessWorkerBindingForwarders;
  /** Dispatch records' transport (CAN-4132); unchanged across restarts. */
  readonly transport: LocalWorkerTransport;
  /** Routes calls to `client` until its binding stops or another attaches. */
  attach(client: LocalWorkerBindingClient): void;
  /** Whether a worker is attached and its binding has not stopped. */
  attached(): boolean;
  /** How many worker processes this route has attached: 1 for the first. */
  incarnation(): number;
}

/**
 * Keyed instructions in send order, bounded like the worker's receipts.
 * `evicted` records that a key was dropped unreleased, so a key it no longer
 * holds may still have crossed.
 */
interface SentKeys {
  readonly keys: Set<string>;
  evicted: boolean;
}

interface Attached {
  readonly client: LocalWorkerBindingClient;
  /** Keyed instructions sent to this worker and not yet released. */
  readonly sent: SentKeys;
}

const keyOf = (operation: string, idempotencyKey: string): string =>
  `${operation}\u0000${idempotencyKey}`;

function remember(sent: SentKeys, key: string): void {
  const { keys } = sent;
  keys.delete(key);
  keys.add(key);
  // Insertion order: the oldest go first, like the worker's own receipts.
  for (const oldest of keys) {
    if (keys.size <= WORKER_EXECUTOR_RECEIPTS_MAX) break;
    keys.delete(oldest);
    sent.evicted = true;
  }
}

export function createSupervisedLocalWorker(options: {
  /** Exactly the worker process's maps. */
  readonly definitions: WorkerBindingDefinitions;
}): SupervisedLocalWorker {
  const { definitions } = options;
  let current: Attached | null = null;
  let attaches = 0;
  /** Keyed instructions sent to a worker that has stopped. */
  const lost: SentKeys = { keys: new Set(), evicted: false };
  const retire = (attached: Attached): void => {
    if (current !== attached) return;
    current = null;
    for (const key of attached.sent.keys) remember(lost, key);
    if (attached.sent.evicted) lost.evicted = true;
    attached.sent.keys.clear();
  };
  const live = (): Attached | null =>
    current !== null && !current.client.signal.aborted ? current : null;
  const unavailable = (definition: BoundOperation['definition']): Error =>
    directed(definition, canopyUnavailableError());
  const sendInstruction = (
    name: string,
    run: (client: LocalWorkerBindingClient) => Promise<unknown>,
    idempotencyKey: string | undefined,
  ): Promise<unknown> => {
    const attached = live();
    const definition = definitions.instructions[name];
    if (attached === null)
      return Promise.reject(
        definition === undefined
          ? canopyUnavailableError()
          : unavailable(definition),
      );
    if (idempotencyKey !== undefined)
      remember(attached.sent, keyOf(name, idempotencyKey));
    return run(attached.client);
  };

  const queries: InProcessWorkerBindingForwarders['queries'] =
    Object.fromEntries(
      Object.entries(definitions.queries).map(([name, definition]) => [
        name,
        (params, context) => {
          const attached = live();
          return attached === null
            ? Promise.reject(unavailable(definition))
            : attached.client.forwarders.queries[name](params, context);
        },
      ]),
    );
  const instructions: InProcessWorkerBindingForwarders['instructions'] =
    Object.fromEntries(
      Object.keys(definitions.instructions).map((name) => [
        name,
        (params, context) =>
          sendInstruction(
            name,
            (client) => client.forwarders.instructions[name](params, context),
            context.metadata?.idempotencyKey,
          ),
      ]),
    );
  const streams: InProcessWorkerBindingForwarders['streams'] =
    Object.fromEntries(
      Object.entries(definitions.streams).map(([name, definition]) => [
        name,
        (params, context, sink) => {
          const attached = live();
          return attached === null
            ? Promise.reject(unavailable(definition))
            : attached.client.forwarders.streams[name](params, context, sink);
        },
      ]),
    );

  const receipt = (
    operation: string,
    idempotencyKey: string,
  ): Promise<WorkerExecutorReceipt | null> => {
    const key = keyOf(operation, idempotencyKey);
    const attached = live();
    if (attached?.sent.keys.has(key))
      return attached.client.receipt(operation, idempotencyKey);
    // The worker that received it is gone, or may be once keys were dropped;
    // how it ended is unknowable.
    if (lost.keys.has(key) || lost.evicted)
      return Promise.reject(canopyUnavailableError());
    // Only the attached worker can have received a dropped key; it knows.
    if (attached?.sent.evicted)
      return attached.client.receipt(operation, idempotencyKey);
    return Promise.resolve(null);
  };
  const releaseReceipt = (operation: string, idempotencyKey: string): void => {
    const key = keyOf(operation, idempotencyKey);
    lost.keys.delete(key);
    const attached = live();
    // A dropped key may still be held by the attached worker, so it hears too.
    if (
      attached !== null &&
      (attached.sent.keys.delete(key) || attached.sent.evicted)
    )
      attached.client.releaseReceipt(operation, idempotencyKey);
  };

  return {
    forwarders: { queries, instructions, streams },
    transport: {
      instructions: definitions.instructions,
      instruction: (name, params, { metadata, signal }) =>
        sendInstruction(
          name,
          (client) => client.instruction(name, params, { metadata, signal }),
          metadata?.idempotencyKey,
        ),
      receipt,
      releaseReceipt,
    },
    attach: (client): void => {
      if (current !== null) {
        const previous = current;
        retire(previous);
        previous.client.close();
      }
      const attached: Attached = {
        client,
        sent: { keys: new Set(), evicted: false },
      };
      attaches += 1;
      current = attached;
      const onStop = (): void => retire(attached);
      if (client.signal.aborted) onStop();
      else client.signal.addEventListener('abort', onStop, { once: true });
    },
    attached: (): boolean => live() !== null,
    incarnation: (): number => attaches,
  };
}

import { randomUUID } from 'node:crypto';
import { CanopyClientError } from '@canopy/core-client';
import {
  CanopyOperationError,
  type CanopyStreamFrame,
  type CanopyStreamHandle,
  type CanopyStreamOptions,
} from '@canopy/core-runtime';
import {
  WorkerFilesystemWatchErrorSchema,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CanopyStreamEnd,
  type CanopyStreamItem,
  type WorkerFilesystemWatchParams,
} from '@canopy/protocol/canopy-core';
import { DAEMON_FILES_EXCLUDED_WORKSPACE_IDS } from './daemon-files-route';
import type {
  DaemonFilesRouteOptions,
  DaemonFilesRouteSender,
} from './daemon-files-route';
import { evaluateLocalRouteTarget } from './daemon-read-route-guard';
import type { ElectronDaemonClient } from './electron-daemon-host';

type Item = CanopyStreamItem<'worker.filesystem.watch'>;
type End = CanopyStreamEnd<'worker.filesystem.watch'>;
type Frame = CanopyStreamFrame<Item, End>;
type WatchError = NonNullable<End['error']>;
type Handle = CanopyStreamHandle<Item, End>;

export interface DaemonWatchRouteOptions extends Pick<
  DaemonFilesRouteOptions,
  'lifetime' | 'workspaceType' | 'resolveWorktreeTargetIds'
> {
  readonly hostContext: () => Promise<{ readonly authorityId: string }>;
  readonly connections: () => {
    get(
      caller: CanopyCallerDescriptor,
      owner: AbortSignal,
    ): Promise<{
      readonly client: Pick<ElectronDaemonClient, 'openStream'>;
    }>;
  };
  /** Host-owned, abortable backoff; must yield even on repeated immediate refusals. */
  readonly waitToReopen: (signal: AbortSignal) => Promise<void>;
}

export interface DaemonWatchRoute {
  open(
    params: WorkerFilesystemWatchParams,
    options: CanopyStreamOptions<Frame>,
    request: { readonly sender: DaemonFilesRouteSender },
  ): Promise<{ handle: Handle; attached: Promise<void> }>;
}

function payloadOf(error: unknown): WatchError {
  if (
    error instanceof CanopyClientError ||
    error instanceof CanopyOperationError
  ) {
    const parsed = WorkerFilesystemWatchErrorSchema.safeParse(error.payload);
    if (parsed.success) return parsed.data;
  }
  return {
    kind: 'internal',
    message: 'The daemon filesystem watch failed.',
    retry: { kind: 'never' },
  };
}

function canReopen(error: CanopyErrorPayload | null): boolean {
  return (
    error === null ||
    error.kind === 'unavailable' ||
    error.kind === 'resource_exhausted' ||
    error.kind === 'cancelled' ||
    error.code === 'worker.filesystem.watch.snapshotRequired'
  );
}

/** Unselected. Desktop leases use CAN-5892's APP_LEASE_STREAM_LIMIT, not a multi-root stream. */
export function createDaemonWatchRoute(
  route: DaemonWatchRouteOptions,
): DaemonWatchRoute {
  return {
    async open(
      params,
      options,
      request,
    ): Promise<{ handle: Handle; attached: Promise<void> }> {
      const target = evaluateLocalRouteTarget({
        shape: 'worktree',
        scope: params.scope,
        caller: options.caller,
        senderId: request.sender.id,
        lookups: {
          workspaceType: route.workspaceType,
          resolveWorktreeTargetIds: route.resolveWorktreeTargetIds,
          excludedWorkspaceIds: DAEMON_FILES_EXCLUDED_WORKSPACE_IDS,
          routedWorkspaceTypes: new Set([
            'single-repo',
            'multi-repo',
            'cowork',
          ]),
        },
      });
      if (!target || target.shape !== 'worktree')
        throw new CanopyOperationError({
          kind: 'failed_precondition',
          message: 'This filesystem watch has no daemon route.',
          retry: { kind: 'never' },
        });
      const controller = new AbortController();
      const owner = route.lifetime.ownerFor(request.sender);
      const signal = AbortSignal.any([
        owner,
        controller.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
      let current: Handle | undefined;
      let attempt = 0;
      let finishInitial: () => void = () => undefined;
      const initialFinished = new Promise<void>((resolve) => {
        finishInitial = resolve;
      });
      let stopped = false;
      let attachedSettled = false;
      let resolveAttached: () => void = () => undefined;
      let rejectAttached: (error: Error) => void = () => undefined;
      const attached = new Promise<void>((resolve, reject) => {
        resolveAttached = resolve;
        rejectAttached = reject;
      });
      void attached.catch(() => undefined);
      const listeners = new Set<(frame: Frame) => void>();
      if (options.onFrame) listeners.add(options.onFrame);
      let consumption: 'push' | 'pull' | undefined = options.onFrame
        ? 'push'
        : undefined;
      let draining = false;
      const pending: Frame[] = [];
      let wake: (() => void) | undefined;
      const localEpoch = `electron-watch-${randomUUID()}`;
      let sequence = 0;
      const localCursor = (): { daemonEpoch: string; sequence: number } => ({
        daemonEpoch: localEpoch,
        sequence: ++sequence,
      });
      const drain = (): void => {
        if (draining) return;
        draining = true;
        try {
          while (listeners.size && pending.length) {
            const frame = pending.shift();
            if (!frame) continue;
            for (const listener of Array.from(listeners)) {
              try {
                listener(frame);
              } catch {
                // Match dispatcher handles: one consumer cannot break its siblings.
              }
            }
          }
        } finally {
          draining = false;
        }
      };
      const emit = (frame: Frame): void => {
        if (pending.length >= 1024 && frame.kind === 'item') {
          finish({
            kind: 'resource_exhausted',
            message: 'The filesystem watch consumer fell behind.',
            retry: { kind: 'after_refresh', resource: 'filesystem-watch' },
          });
          return;
        }
        pending.push(frame);
        wake?.();
        wake = undefined;
        drain();
      };
      const rejectBeforeAttach = (error: CanopyErrorPayload | null): void => {
        if (attachedSettled) return;
        attachedSettled = true;
        rejectAttached(
          new CanopyOperationError(
            error ?? {
              kind: 'cancelled',
              message: 'The filesystem watch ended before attaching.',
              retry: { kind: 'never' },
            },
          ),
        );
      };
      const finish = (error: WatchError): void => {
        if (stopped) return;
        stopped = true;
        ++attempt;
        rejectBeforeAttach(error);
        signal.removeEventListener('abort', onAbort);
        controller.abort();
        // The client's close sends `core.events.unsubscribe`, which frees the
        // daemon's stream and lease slot (CAN-8067); never close the shared
        // window session here, which would cancel sibling streams.
        current?.close();
        pending.length = 0;
        emit({
          kind: 'end',
          cursor: localCursor(),
          outcome: error.kind === 'cancelled' ? 'cancelled' : 'error',
          error,
        });
      };
      const onAbort = (): void =>
        finish({
          kind: 'cancelled',
          message: 'The filesystem watch was closed.',
          retry: { kind: 'never' },
        });
      signal.addEventListener('abort', onAbort, { once: true });
      let recovering: Promise<void> | undefined;
      const rescan = (): void => {
        const cursor = localCursor();
        emit({
          kind: 'item',
          cursor,
          item: {
            changeId: `${cursor.daemonEpoch}:${cursor.sequence}`,
            kind: 'overflow',
            relativePath: '',
            previousRelativePath: null,
            version: null,
            occurredAt: new Date().toISOString(),
          },
        });
      };
      const accept = async (reopening: boolean): Promise<Handle> => {
        signal.throwIfAborted();
        const host = await route.hostContext();
        signal.throwIfAborted();
        const session = await route
          .connections()
          .get({ ...options.caller, authorityId: host.authorityId }, owner);
        signal.throwIfAborted();
        const token = ++attempt;
        current = undefined;
        let ended = false;
        const mapped = {
          ...params,
          scope: {
            workspaceId: target.workspaceId,
            worktreeId: target.worktreeId,
            authorityId: host.authorityId,
          },
        };
        const withoutCursor = { ...mapped };
        delete withoutCursor.cursor;
        const handle = await session.client.openStream(
          'worker.filesystem.watch',
          reopening ? withoutCursor : mapped,
          {
            signal,
            metadata: options.metadata,
            onFrame: (frame): void => {
              if (stopped || ended || token !== attempt) return;
              if (frame.kind === 'item') emit(frame);
              else {
                ended = true;
                current = undefined;
                rejectBeforeAttach(frame.error);
                if (!canReopen(frame.error))
                  finish(frame.error ?? payloadOf(null));
                else recover();
              }
            },
          },
        );
        if (stopped || ended || token !== attempt) handle.close();
        else {
          current = handle;
          // The wire exposes open acceptance, NOT native attachment. A change
          // between acceptance and native attach can be missed. CAN-4730 must
          // add a wire-visible attach marker or a post-attach rescan before E2.
          if (!attachedSettled) {
            attachedSettled = true;
            resolveAttached();
          }
          if (reopening) rescan();
        }
        return handle;
      };
      const recover = (): void => {
        if (stopped || recovering) return;
        rescan();
        recovering = (async (): Promise<void> => {
          await initialFinished;
          while (!stopped) {
            try {
              await route.waitToReopen(signal);
              if (stopped) return;
              await accept(true);
              if (current && !stopped) return;
            } catch (error) {
              if (stopped) return;
              const payload = payloadOf(error);
              if (!canReopen(payload)) {
                finish(payload);
                return;
              }
            }
          }
        })().finally(() => {
          recovering = undefined;
          if (!stopped && !current) recover();
        });
        void recovering.catch((error: unknown) => finish(payloadOf(error)));
      };
      const handle: Handle = {
        requestId: randomUUID(),
        openResult: {
          subscriptionId: randomUUID(),
          acceptedCursor: params.cursor ?? null,
        },
        frames: {
          async *[Symbol.asyncIterator](): AsyncGenerator<Frame> {
            if (consumption === 'push')
              throw new Error('Stream frames are consumed by onFrame.');
            consumption = 'pull';
            while (true) {
              const frame = pending.shift();
              if (frame) {
                yield frame;
                if (frame.kind === 'end') return;
              } else if (stopped) return;
              else
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
            }
          },
        },
        onFrame(next): () => void {
          if (consumption === 'pull')
            throw new Error(
              'Stream frames are consumed by the frames iterator.',
            );
          consumption = 'push';
          listeners.add(next);
          drain();
          return (): void => {
            listeners.delete(next);
          };
        },
        close: onAbort,
      };
      try {
        if (signal.aborted) {
          onAbort();
          signal.throwIfAborted();
        }
        const first = await accept(false);
        finishInitial();
        handle.requestId = first.requestId;
        handle.openResult = first.openResult;
        return { handle, attached };
      } catch (error) {
        finishInitial();
        const payload: WatchError = signal.aborted
          ? {
              kind: 'cancelled',
              message: 'The filesystem watch was closed.',
              retry: { kind: 'never' },
            }
          : payloadOf(error);
        finish(payload);
        throw new CanopyOperationError(payload);
      }
    },
  };
}

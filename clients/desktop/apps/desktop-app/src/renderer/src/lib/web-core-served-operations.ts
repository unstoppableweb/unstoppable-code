import { useSyncExternalStore } from 'react';
import { CoreRuntimeManifestGetResultSchema } from '@canopy/protocol/canopy-core';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { CanopyCoreRelayApi } from '../../../shared/canopy-core-relay';

/*
 * The operations the web core says it serves this desktop (CAN-6180), read
 * once from its `core.runtime.manifest.get` over the renderer relay. A cloud
 * scope turns on a capability only for an operation listed as available, so
 * an older web core, a failed read or a read still in flight leaves it off.
 */

let served: ReadonlySet<string> = new Set();
/** Each served operation's declared `detail` values, when it lists any. */
let details: ReadonlyMap<string, readonly string[]> = new Map();
let state: 'idle' | 'loading' | 'loaded' = 'idle';
const listeners = new Set<() => void>();

function defaultRelay(): CanopyCoreRelayApi | undefined {
  return typeof window === 'undefined' ? undefined : window.canopyCore;
}

/** Reads the manifest once; a failed read can be tried again later. */
export function loadWebCoreServedOperations(
  relay: () => CanopyCoreRelayApi | undefined = defaultRelay,
): void {
  if (state !== 'idle') return;
  const api = relay();
  if (api === undefined) return;
  state = 'loading';
  void api
    .invoke({
      kind: 'request',
      method: 'core.runtime.manifest.get',
      params: {},
      authority: 'web-core',
    })
    .then((reply) => {
      const parsed = reply.ok
        ? CoreRuntimeManifestGetResultSchema.safeParse(reply.value)
        : null;
      if (!parsed?.success) {
        state = 'idle';
        return;
      }
      const available = parsed.data.operations.filter(
        (operation) => operation.available,
      );
      served = new Set(available.map((operation) => operation.name));
      details = new Map(
        available.flatMap((operation) =>
          operation.details === undefined
            ? []
            : [[operation.name, operation.details] as const],
        ),
      );
      state = 'loaded';
      for (const listener of listeners) listener();
    })
    .catch((error: unknown) => {
      // The relay answers a refusal as a reply, so a rejection is a defect.
      state = 'idle';
      reportClientAppError(error);
    });
}

/** Whether the web core serves `name` to this desktop, as last read. */
export function webCoreServes(name: string): boolean {
  return served.has(name);
}

/** Whether a manifest read has landed, so `webCoreServes` is an answer. */
export function webCoreServedOperationsKnown(): boolean {
  return state === 'loaded';
}

/** Whether the web core serves a cloud task's cost reads. */
export function webCoreServesCost(): boolean {
  return (
    webCoreServes('core.cost.scope.get') && webCoreServes('core.cost.chat.get')
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether the web core serves a cloud chat's full cost breakdown (CAN-6941):
 * `core.cost.chat.get` must list detail `full`. A web core that lists none,
 * an older one included, serves only what it declares, so this stays off.
 */
export function webCoreServesSessionBreakdown(): boolean {
  return (
    webCoreServesCost() &&
    (details.get('core.cost.chat.get') ?? []).includes('full')
  );
}

/**
 * Whether the web core serves deleting a cloud task to the Trash
 * (CAN-7052): `core.chat.delete`, which it lists as available only to a
 * connection that may write chats.
 */
export function webCoreServesTaskDelete(): boolean {
  return webCoreServes('core.chat.delete');
}

/** Re-renders when the manifest read lands. */
export function useWebCoreServesCost(): boolean {
  return useSyncExternalStore(subscribe, webCoreServesCost, () => false);
}

/** Re-renders when the manifest read lands. */
export function useWebCoreServesTaskDelete(): boolean {
  return useSyncExternalStore(subscribe, webCoreServesTaskDelete, () => false);
}

/**
 * Whether the web core serves a cloud chat's delegate pages (CAN-7027):
 * `core.chat.transcript.page` must list detail `delegation`. A web core that
 * lists none, an older one included, leaves the reads off.
 */
export function webCoreServesDelegationPages(): boolean {
  return (
    webCoreServes('core.chat.transcript.page') &&
    (details.get('core.chat.transcript.page') ?? []).includes('delegation')
  );
}

/** Whether the web core forks a cloud chat into a new task (CAN-7007). */
export function webCoreServesChatFork(): boolean {
  return webCoreServes('core.chat.fork');
}

/** Re-renders when the manifest read lands. */
export function useWebCoreServesChatFork(): boolean {
  return useSyncExternalStore(subscribe, webCoreServesChatFork, () => false);
}

/** Test seam: forget what was read. */
export function resetWebCoreServedOperations(): void {
  served = new Set();
  details = new Map();
  state = 'idle';
  for (const listener of listeners) listener();
}

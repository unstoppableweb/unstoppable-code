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
      served = new Set(
        parsed.data.operations
          .filter((operation) => operation.available)
          .map((operation) => operation.name),
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

/** Re-renders when the manifest read lands. */
export function useWebCoreServesCost(): boolean {
  return useSyncExternalStore(subscribe, webCoreServesCost, () => false);
}

/** Test seam: forget what was read. */
export function resetWebCoreServedOperations(): void {
  served = new Set();
  state = 'idle';
  for (const listener of listeners) listener();
}

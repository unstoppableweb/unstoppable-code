import { useSyncExternalStore } from 'react';
import { CoreRuntimeManifestGetResultSchema } from '@canopy/protocol/canopy-core';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { CanopyCoreRelayApi } from '../../../shared/canopy-core-relay';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/*
 * The operations the web core says it serves this desktop (CAN-6180), read
 * once from its `core.runtime.manifest.get` over the renderer relay. A cloud
 * scope turns on a capability only for an operation listed as available, so
 * an older web core, a failed read or a read still in flight leaves it off.
 */

let served: ReadonlySet<string> = new Set();
/** Each served operation's declared `detail` values, when it lists any. */
let details: ReadonlyMap<string, readonly string[]> = new Map();
/**
 * `failed` holds after a refused, invalid or rejected read (CAN-7464): it
 * isn't read again on its own, so a render that asks for the manifest can't
 * loop; Try again or a reconnect reads it again.
 */
let state: 'idle' | 'loading' | 'loaded' | 'failed' = 'idle';
/** Bumped by a reset, a retry and an account switch; older replies are dropped. */
let generation = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Forgets what was read, with nothing in its place: every gate reads off. */
function forget(next: 'idle' | 'failed'): void {
  served = new Set();
  details = new Map();
  state = next;
  notify();
}

function defaultRelay(): CanopyCoreRelayApi | undefined {
  return typeof window === 'undefined' ? undefined : window.canopyCore;
}

/**
 * Reads the manifest once. A failed read stays failed until
 * `retryWebCoreServedOperations` reads it again.
 */
export function loadWebCoreServedOperations(
  relay: () => CanopyCoreRelayApi | undefined = defaultRelay,
): void {
  if (state !== 'idle') return;
  const api = relay();
  if (api === undefined) return;
  state = 'loading';
  const started = generation;
  void api
    .invoke({
      kind: 'request',
      method: 'core.runtime.manifest.get',
      params: {},
      authority: 'web-core',
    })
    .then((reply) => {
      if (started !== generation) return;
      const parsed = reply.ok
        ? CoreRuntimeManifestGetResultSchema.safeParse(reply.value)
        : null;
      if (!parsed?.success) {
        forget('failed');
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
      notify();
    })
    .catch((error: unknown) => {
      // The relay answers a refusal as a reply, so a rejection is a defect.
      reportClientAppError(error);
      if (started === generation) forget('failed');
    });
}

/**
 * Reads the manifest again after a failed read, from Try again or a
 * reconnect. It acts only on a failed read: one in flight or landed is left
 * as it is, so two calls in one tick read it once.
 */
export function retryWebCoreServedOperations(
  relay: () => CanopyCoreRelayApi | undefined = defaultRelay,
): void {
  if (state !== 'failed') return;
  generation += 1;
  state = 'idle';
  loadWebCoreServedOperations(relay);
  notify();
}

/**
 * Reads the manifest when cloud chats come online: for the first time, or
 * again after a failed read (CAN-7464).
 */
export function readWebCoreServedOperationsOnline(
  relay: () => CanopyCoreRelayApi | undefined = defaultRelay,
): void {
  retryWebCoreServedOperations(relay);
  loadWebCoreServedOperations(relay);
}

/** Whether the last manifest read failed, and nothing has read it since. */
export function webCoreServedOperationsFailed(): boolean {
  return state === 'failed';
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

/** What a cloud chat's own delegates' live state and Stop read and call. */
const DELEGATION_STOP_OPERATIONS = [
  'core.managedDelegation.list',
  'core.managedDelegation.get',
  'core.managedDelegation.stop',
  'core.managedDelegation.stopAll',
] as const;

/**
 * Whether the web core serves a cloud chat's delegates' Stop (CAN-7245): it
 * lists all four operations as available only while its cloud managed
 * delegation rollout is on for this user, so that flag rolls Stop back. A
 * web core that lists any of them unavailable, an older one included,
 * leaves Stop off.
 */
export function webCoreServesDelegationStop(): boolean {
  return DELEGATION_STOP_OPERATIONS.every((name) => webCoreServes(name));
}

/**
 * Whether the web core serves a cloud task's Subagents and subagent chat
 * panels (CAN-7133): its delegates' pages and all four of their reads and
 * Stops. A tree without the live reads would keep each card's first state,
 * so anything less leaves both panels off.
 */
export function webCoreServesSubagentPanels(): boolean {
  return webCoreServesDelegationPages() && webCoreServesDelegationStop();
}

/** Re-renders when the manifest read lands or fails. */
export function useWebCoreServedOperationsFailed(): boolean {
  return useSyncExternalStore(
    subscribe,
    webCoreServedOperationsFailed,
    () => false,
  );
}

/** Re-renders when the manifest read lands. */
export function useWebCoreServedOperationsKnown(): boolean {
  return useSyncExternalStore(
    subscribe,
    webCoreServedOperationsKnown,
    () => false,
  );
}

/** Re-renders when the manifest read lands. */
export function useWebCoreServesDelegationStop(): boolean {
  return useSyncExternalStore(
    subscribe,
    webCoreServesDelegationStop,
    () => false,
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

/**
 * Forgets what was read, drops any read in flight, and reads again on the
 * next capability read: on an account switch or sign-out, and in tests.
 * Until the new read lands every gated feature is off, so another account's
 * answer never shows.
 */
export function resetWebCoreServedOperations(): void {
  generation += 1;
  forget('idle');
}

let accountEpoch = useWorkspaceContextStore.getState().accountEpoch;
useWorkspaceContextStore.subscribe((current) => {
  if (current.accountEpoch === accountEpoch) return;
  accountEpoch = current.accountEpoch;
  resetWebCoreServedOperations();
});

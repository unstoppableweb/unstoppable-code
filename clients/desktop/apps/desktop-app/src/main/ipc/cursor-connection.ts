import { CursorModelAuthenticationError } from '../cursor/model-discovery-error';
import { assertCursorHarnessEnabled } from '../cursor/feature-flag';
import { getObservabilityService } from '../observability';
import { BrowserWindow, type WebContents } from 'electron';
import {
  IPC_CHANNELS,
  initCursorModels,
  type CursorAccount,
  type CursorAccountIntent,
  type CursorConnectionStatus,
  type CursorModelEntry,
  type CursorSignInClient,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from './register';
import { broadcastModelRegistryUpdated } from '../models/model-registry';
// Unlike `cursor/connection.ts` and `cursor/models.ts` (deliberately deferred
// below — they pull in the CLI-invoking installer/discovery graph), this
// module has no top-level imports of its own: it defers `runtime-status`
// (and the `__CANOPY_CURSOR_CLI__` build constant it reads) internally
// inside `isCursorRuntimeAvailable()`. A static import here is safe and
// removes four redundant dynamic `import()` calls that bought nothing.
import {
  probeCursorRuntimeStatus,
  refreshCursorRuntimeAvailability,
} from '../cursor/runtime-availability';
import { sendToWebContents } from '../lib/web-contents-send';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';
import {
  assertCursorSignInReachable,
  readCursorSignInOptions,
  type CursorSignInOptions,
} from '../cursor/sign-in-link';
let shuttingDown = false;
async function stopModelDiscovery(): Promise<void> {
  getObservabilityService().invalidateCursorUsage();
  // Startup can populate the cache before any picker IPC runs. Invalidate the
  // cache itself on every connection transition, regardless of its caller.
  const { invalidateCursorModels } = await import('../cursor/models');
  await invalidateCursorModels();
}
const active = new Map<
  number,
  { controller: AbortController; done: Promise<CursorConnectionStatus> }
>();
// Account probes run the CLI too, so they are tracked: an owned operation
// stands them down before claiming the CLI, and quitting cancels them so no
// detached child outlives the app.
const probes = new Set<{
  controller: AbortController;
  done: Promise<unknown>;
}>();
// The account read running now, which overlapping probes share, and how
// many windows wait on it.
interface SharedAccountRead {
  controller: AbortController;
  done: Promise<CursorAccount | null>;
  waiters: number;
}
let accountRead: SharedAccountRead | undefined;

/**
 * Starts the account read overlapping probes share. It follows no single
 * window: setup stands it down and quitting drains it (`probes`), it times
 * out after 60 seconds, and it is cancelled once every window waiting on it
 * has gone.
 */
function startAccountRead(
  read: (signal: AbortSignal) => Promise<CursorAccount | null>,
): SharedAccountRead {
  const controller = new AbortController();
  const shared: SharedAccountRead = {
    controller,
    done: read(
      AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
    ),
    waiters: 0,
  };
  probes.add(shared);
  accountRead = shared;
  void shared.done
    .finally(() => {
      probes.delete(shared);
      if (accountRead === shared) accountRead = undefined;
    })
    .catch(() => undefined);
  return shared;
}

/**
 * `owner`'s wait on a shared read. A window that goes away stops only its
 * own wait; the read is cancelled when the last waiting window has gone.
 */
function waitForAccountRead(
  shared: SharedAccountRead,
  owner: WebContents,
): Promise<CursorAccount | null> {
  shared.waiters += 1;
  return new Promise((resolve, reject) => {
    let waiting = true;
    const leave = (): void => {
      if (!waiting) return;
      waiting = false;
      shared.waiters -= 1;
      owner.off('destroyed', gone);
      owner.off('render-process-gone', gone);
      owner.off('did-start-navigation', gone);
    };
    const gone = (): void => {
      if (!waiting) return;
      leave();
      if (shared.waiters === 0) shared.controller.abort();
      reject(new Error('Cursor setup window unavailable.'));
    };
    owner.once('destroyed', gone);
    owner.once('render-process-gone', gone);
    owner.once('did-start-navigation', gone);
    shared.done.then(
      (account) => {
        if (!waiting) return;
        leave();
        resolve(account);
      },
      (error: unknown) => {
        if (!waiting) return;
        leave();
        reject(
          error instanceof Error
            ? error
            : new Error('Could not check the Cursor sign-in.'),
        );
      },
    );
  });
}
function assertOwner(
  sender: WebContents,
  frame: Electron.WebFrameMain | null,
): void {
  if (
    shuttingDown ||
    sender.isDestroyed() ||
    frame !== sender.mainFrame ||
    !BrowserWindow.fromWebContents(sender)
  )
    throw new Error('Cursor setup window unavailable.');
}
async function cancel(senderId: number): Promise<void> {
  const operation = active.get(senderId);
  operation?.controller.abort();
  await operation?.done.catch(() => undefined);
}
export async function shutdownCursorConnections(): Promise<void> {
  shuttingDown = true;
  for (const probe of Array.from(probes)) probe.controller.abort();
  await Promise.allSettled([
    ...Array.from(active.keys()).map(cancel),
    ...Array.from(probes).map((probe) => probe.done.catch(() => undefined)),
    stopModelDiscovery(),
  ]);
  probes.clear();
}
export function registerCursorConnectionHandlers(): void {
  registerIpcHandler<[], CursorModelEntry[]>(
    IPC_CHANNELS.cursorConnectionModels,
    async (event) => {
      assertCursorHarnessEnabled();
      const owner = event.sender;
      assertOwner(owner, event.senderFrame);
      // Defer the local ACP/installer module until discovery is requested so
      // its dependency graph stays off the desktop startup path.
      const { listCursorModels, invalidateCursorModels } =
        await import('../cursor/models');
      assertOwner(owner, event.senderFrame);
      assertCursorHarnessEnabled();
      const stop = (): void => {
        void invalidateCursorModels();
      };
      owner.once('destroyed', stop);
      owner.once('render-process-gone', stop);
      owner.once('did-start-navigation', stop);
      try {
        const models = await listCursorModels();
        initCursorModels(models);
        broadcastModelRegistryUpdated();
        return models;
      } catch (error) {
        // Temporary discovery failures retain the last successful catalog.
        // A confirmed auth failure revokes it just like disconnect does.
        if (error instanceof CursorModelAuthenticationError) {
          initCursorModels([]);
          broadcastModelRegistryUpdated();
        }
        throw error;
      } finally {
        owner.off('destroyed', stop);
        owner.off('render-process-gone', stop);
        owner.off('did-start-navigation', stop);
      }
    },
  );
  registerIpcHandler<[], CursorConnectionStatus>(
    IPC_CHANNELS.cursorConnectionStatus,
    // A single canonical probe: warms the cached availability (so the first
    // Portal projection after launch already carries the Cursor key instead
    // of "unknown") from the SAME probe this handler returns, rather than
    // running a redundant second one to seed the cache. Sharing the probe
    // also means the cache write shares its generation guard with
    // Connect/Disconnect and `isCursorRuntimeAvailable()`, so a slow status
    // check and a fast concurrent Disconnect refresh cannot race each other
    // into a stale cached answer.
    () => probeCursorRuntimeStatus(),
  );
  // A remote bridge window carries another computer's calls: its sign-in
  // link goes to that computer with the progress status, when that
  // computer's app says it shows it (`client`).
  const remoteSignInOptions = (
    event: Electron.IpcMainInvokeEvent,
    client: unknown,
  ): CursorSignInOptions =>
    readCursorSignInOptions(
      resolveRemoteBridgeSender(event.sender) !== null,
      client,
    );
  // Connect and Change account share one owned, cancellable operation per
  // window: the same abort wiring, progress channel, and lifetime guards.
  const runOwned = async (
    event: Electron.IpcMainInvokeEvent,
    operation: (
      signal: AbortSignal,
      progress: (status: CursorConnectionStatus) => void,
    ) => Promise<CursorConnectionStatus>,
  ): Promise<CursorConnectionStatus> => {
    const owner = event.sender;
    assertOwner(owner, event.senderFrame);
    if (active.size) throw new Error('Cursor setup is already running.');
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    owner.once('destroyed', stop);
    owner.once('render-process-gone', stop);
    owner.once('did-start-navigation', stop);
    // Everything up to `active.set` below runs without yielding, so the check
    // above still claims the slot: handlers are dispatched synchronously, and
    // an await before the claim would let two invokes in one tick both pass it
    // and the second overwrite the first's abort handle.
    const done = (async (): Promise<CursorConnectionStatus> => {
      // The probe runs the CLI too. Stand the in-flight ones down and wait for
      // them, so a read that started first cannot finish mid-sign-out and
      // commit a pre-change answer. This serializes setup against the account
      // probes only — model discovery and the usage refresh run their own CLI
      // reads and are not gated here.
      // A probe parked in its own dynamic import can register while this
      // drains, so it repeats until the set is genuinely empty.
      while (probes.size) {
        const draining = Array.from(probes);
        for (const probe of draining) probe.controller.abort();
        await Promise.allSettled(
          draining.map((probe) => probe.done.catch(() => undefined)),
        );
      }
      // The window can go away while the probes drain, and the listeners above
      // only abort — they cannot refuse an operation that has not started.
      assertOwner(owner, event.senderFrame);
      return operation(
        AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]),
        (status) => {
          if (!owner.isDestroyed() && !controller.signal.aborted)
            sendToWebContents(
              owner,
              IPC_CHANNELS.cursorConnectionProgress,
              status,
            );
        },
      );
    })();
    active.set(owner.id, { controller, done });
    try {
      return await done;
    } finally {
      active.delete(owner.id);
      owner.off('destroyed', stop);
      owner.off('render-process-gone', stop);
      owner.off('did-start-navigation', stop);
    }
  };
  // Setup and an account change both replace the signed-in identity, so the
  // catalog is cleared on the way in and re-discovered from the new account.
  const republishCursorModels = async (
    signal: AbortSignal,
    status: CursorConnectionStatus,
  ): Promise<void> => {
    if (!signal.aborted && status.enabled)
      void getObservabilityService().refreshProviderUsage('cursor');
    if (
      signal.aborted ||
      !status.enabled ||
      !status.supported ||
      !status.installed
    )
      return;
    // Setup already loaded the ACP/installer graph. Publish the supported
    // destinations before returning, so fresh defaults work immediately.
    const { listCursorModels, invalidateCursorModels } =
      await import('../cursor/models');
    const abortDiscovery = (): void => {
      void invalidateCursorModels();
    };
    signal.addEventListener('abort', abortDiscovery, { once: true });
    try {
      initCursorModels(await listCursorModels());
    } catch {
      initCursorModels([]);
    } finally {
      signal.removeEventListener('abort', abortDiscovery);
    }
    // Remote Control projects Cursor rows and the `cursor` availability key
    // from this cache; refresh it before the registry broadcast so the
    // re-projection that follows sees the connected runtime.
    await refreshCursorRuntimeAvailability();
    broadcastModelRegistryUpdated();
  };
  registerIpcHandler<[CursorSignInClient?], CursorConnectionStatus>(
    IPC_CHANNELS.cursorConnectionConnect,
    // Async so the disabled-harness guard rejects the invoke rather than
    // throwing synchronously at the caller.
    async (event, client) => {
      assertCursorHarnessEnabled();
      // Refused before it claims setup, clears the catalog or installs: a
      // controller that can't show the link could never finish the sign-in.
      const signInOptions = remoteSignInOptions(event, client);
      assertCursorSignInReachable(signInOptions);
      return runOwned(event, async (signal, progress) => {
        // Model discovery runs the CLI too; setup and sign-in own it exclusively.
        await stopModelDiscovery();
        initCursorModels([]);
        broadcastModelRegistryUpdated();
        const { connectCursor } = await import('../cursor/connection');
        // Re-check after the awaits: the flag can flip while the runtime graph
        // loads, and this is the last point before a download or a sign-in.
        assertCursorHarnessEnabled();
        const status = await connectCursor(signal, progress, signInOptions);
        await republishCursorModels(signal, status);
        return status;
      });
    },
  );
  registerIpcHandler<
    [CursorAccountIntent, CursorSignInClient?],
    CursorConnectionStatus
  >(
    IPC_CHANNELS.cursorConnectionChangeAccount,
    // Async so the disabled-harness guard rejects the invoke rather than
    // throwing synchronously at the caller.
    async (event, intent, client) => {
      assertCursorHarnessEnabled();
      // The intent decides whether a sign-out runs, so it is validated here
      // rather than defaulted: an unrecognized value must not fall through to
      // the destructive branch.
      if (intent !== 'change' && intent !== 'sign-in')
        throw new Error('Unknown Cursor account operation.');
      const signInOptions = remoteSignInOptions(event, client);
      assertCursorSignInReachable(signInOptions);
      return runOwned(event, async (signal, progress) => {
        const { changeCursorAccount } = await import('../cursor/connection');
        assertCursorHarnessEnabled();
        const status = await changeCursorAccount(
          signal,
          progress,
          intent,
          // The new account may advertise different models, so the catalog is
          // dropped and rebuilt from whoever signs in — but only once the
          // change is really happening. Clearing it up front emptied every
          // open picker for refusals that changed nothing.
          async () => {
            await stopModelDiscovery();
            initCursorModels([]);
            broadcastModelRegistryUpdated();
          },
          signInOptions,
        );
        await republishCursorModels(signal, status);
        return status;
      });
    },
  );
  registerIpcHandler<[], CursorAccount | null>(
    IPC_CHANNELS.cursorConnectionAccount,
    async (event) => {
      assertCursorHarnessEnabled();
      const owner = event.sender;
      assertOwner(owner, event.senderFrame);
      // A probe never interrupts setup; report unknown while one is running.
      if (active.size) throw new Error('Cursor setup is already running.');
      const { readCursorAccount } = await import('../cursor/connection');
      assertCursorHarnessEnabled();
      // Re-check after the await: an operation can claim the CLI while the
      // runtime graph loads, and it aborts probes it does not know about.
      // `assertOwner` is also the only check on `shuttingDown`, and a probe
      // that registered after shutdown took its snapshot would never be
      // drained — leaving a detached CLI child behind.
      assertOwner(owner, event.senderFrame);
      if (active.size) throw new Error('Cursor setup is already running.');
      // The probe runs the CLI, so it follows the window that asked for it and
      // is drained on quit rather than outliving either as a detached child.
      // Attached only once the guards have passed: a throw above would
      // otherwise leave three listeners on a long-lived WebContents.
      // A read already running answers this probe too: a cache miss
      // verifies the whole runtime on the queue local launches use, so
      // overlapping probes (a paired browser can send many) share one
      // (CAN-6718 review). The read runs the CLI, so it is tracked in
      // `probes` and cancelled once no window waits on it.
      return await waitForAccountRead(
        accountRead ?? startAccountRead(readCursorAccount),
        owner,
      );
    },
  );
  registerIpcHandler<[], void>(IPC_CHANNELS.cursorConnectionCancel, (event) => {
    assertOwner(event.sender, event.senderFrame);
    return cancel(event.sender.id);
  });
  registerIpcHandler<[], void>(
    IPC_CHANNELS.cursorConnectionDisconnect,
    async (event) => {
      assertOwner(event.sender, event.senderFrame);
      await cancel(event.sender.id);
      if (active.size)
        throw new Error('Cursor setup is running in another window.');
      const { disconnectCursor } = await import('../cursor/connection');
      await disconnectCursor();
      await stopModelDiscovery();
      initCursorModels([]);
      await refreshCursorRuntimeAvailability();
      broadcastModelRegistryUpdated();
    },
  );
}

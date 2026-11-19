import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import { createCanopyDispatcher } from '@canopy/core-runtime';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  createCoreUpdateHandlers,
  type CoreUpdateHost,
  type DesktopUpdateSnapshot,
} from '@canopy/core-runtime/update';
import {
  CanopyErrorPayloadSchema,
  UPDATE_INSTRUCTION_DEFINITIONS,
  UPDATE_QUERY_DEFINITIONS,
  UPDATE_STREAM_DEFINITIONS,
} from '@canopy/protocol/canopy-core';

jest.mock('../../observability', () => ({
  getObservabilityService: (): { recordAppDiagnostic: () => void } => ({
    recordAppDiagnostic: (): void => undefined,
  }),
}));

import { createRemoteControlApi } from '../../../preload/api/remote-control-api';
import type { PreloadIpcRenderer } from '../../../preload/ipc-router';
import { getSecretStoragePolicy } from '../../lib/secure-storage-policy';
import type { RemoteControlWindows } from '../client/remote-windows';
import { RemoteHostConnection } from '../client/host-connection';
import type { HostBridge } from '../host/bridge-window';
import { RemoteHostSession } from '../host/host-session';
import { RemoteUploadStore } from '../host/uploads';
import { RemoteAccessStore } from '../remote-access-store';
import type { LegacyPortalOptInRead } from '../legacy-portal-opt-in';
import { RemoteControlService } from '../remote-control-service';
import {
  createRemoteCoreAccess,
  type RemoteCoreAccess,
} from '../host/remote-core-access';
import {
  CoreCallResultSchema,
  HelloResultSchema,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
} from '../remote-protocol';
import { RpcPeer, RpcRemoteError } from '../transport/rpc-peer';
import type { SecureSession } from '../transport/session-manager';
import { flushRelay, InMemoryRelayHub } from './in-memory-relay';
import { createTestDevice, openControlSession } from './session-pair';

const SavedSettingsSchema = z.object({ allowRemoteUpdates: z.boolean() });

const HOST_VERSION = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  appVersion: '1.4.0',
};
/** A controller on another protocol: the tunnel refuses it. */
const OLD_CONTROLLER = { protocolVersion: 3, appVersion: '1.1.0' };

interface Harness {
  controller: RpcPeer;
  events: unknown[];
  setSnapshot: (next: Partial<DesktopUpdateSnapshot>) => void;
  allow: { value: boolean };
  /** Changes whether remote updates are allowed and tells core.update. */
  setAllowed: (allowed: boolean) => void;
  installs: string[];
  /** Every attempt record the host was given; null withdraws it. */
  attempts: Array<string | null>;
  close: () => Promise<void>;
}

async function harness(
  allowed?: () => boolean,
  kind: DeviceKind = 'desktop',
  wrapCore: (core: RemoteCoreAccess) => RemoteCoreAccess = (core) => core,
  minIntervalMs = 0,
): Promise<Harness> {
  let snapshot: DesktopUpdateSnapshot = {
    phase: 'downloaded',
    currentVersion: '1.3.0',
    displayVersion: '1.3.0',
    availableVersion: '1.4.0',
    availableDisplayVersion: '1.4.0',
    progressPercent: null,
    message: null,
    restartPending: false,
    targeted: false,
  };
  const listeners = new Set<() => void>();
  const policyListeners = new Set<() => void>();
  const installs: string[] = [];
  const attempts: Array<string | null> = [];
  const setSnapshot = (next: Partial<DesktopUpdateSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) listener();
  };
  const host: CoreUpdateHost = {
    releaseFlavor: 'stable',
    support: () => ({ supported: true }),
    snapshot: () => snapshot,
    blockers: () => ({ activeChatWork: true, windowBusy: false }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check: () => Promise.resolve(),
    startDownload: () => Promise.resolve(),
    installNow: () => {
      installs.push('now');
      return Promise.resolve();
    },
    scheduleRestart: () => {
      installs.push('when_idle');
      setSnapshot({ restartPending: true });
    },
    cancelScheduledRestart: () => setSnapshot({ restartPending: false }),
    recordAttempt: (attempt) => {
      attempts.push(attempt?.targetVersion ?? null);
    },
  };
  const allow = { value: true };
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: UPDATE_QUERY_DEFINITIONS,
      instructions: UPDATE_INSTRUCTION_DEFINITIONS,
      streams: UPDATE_STREAM_DEFINITIONS,
    },
    handlers: createCoreUpdateHandlers(host, {
      epoch: 'host-epoch',
      remote: {
        allowed: allowed ?? ((): boolean => allow.value),
        nameOf: () => 'Laptop',
        minIntervalMs,
        subscribe: (listener) => {
          policyListeners.add(listener);
          return (): void => {
            policyListeners.delete(listener);
          };
        },
      },
    }),
  });

  const hub = new InMemoryRelayHub();
  const laptop = createTestDevice(hub, 'Laptop');
  const studio = createTestDevice(hub, 'Studio');
  await flushRelay();
  const { initiator, responder } = await openControlSession(laptop, studio);
  const session = new RemoteHostSession({
    session: responder,
    kind,
    attributedDeviceId: responder.peerDeviceId,
    createBridge: (): Promise<never> =>
      Promise.reject(new Error('no bridge in this test')),
    mainWindowPushes: { subscribe: (): (() => void) => (): void => undefined },
    uploads: new RemoteUploadStore(join(tmpdir(), 'remote-updates-uploads')),
    readFile: (): Promise<never> =>
      Promise.reject(new Error('no reads in this test')),
    disposition: (): 'tunnel' => 'tunnel',
    isAuthorized: (): boolean => true,
    version: HOST_VERSION,
    hello: (): { name: string; platform: 'darwin' } => ({
      name: 'Studio',
      platform: 'darwin',
    }),
    onClose: (): void => undefined,
    core: wrapCore(createRemoteCoreAccess(() => dispatcher)),
  });
  const events: unknown[] = [];
  const controller = new RpcPeer(initiator, {
    onRequest: (): Promise<never> =>
      Promise.reject(new Error('unexpected request')),
    onEvent: (name, payload): void => {
      if (name === REMOTE_EVENTS.coreEvent) events.push(payload);
    },
  });
  return {
    controller,
    events,
    setSnapshot,
    allow,
    setAllowed: (allowed) => {
      allow.value = allowed;
      for (const listener of [...policyListeners]) listener();
    },
    installs,
    attempts,
    close: async () => {
      controller.close('closed');
      session.rpc.close('closed');
      await dispatcher.shutdown();
    },
  };
}

async function call(
  controller: RpcPeer,
  operation: string,
  params: unknown,
): Promise<ReturnType<typeof CoreCallResultSchema.parse>> {
  return CoreCallResultSchema.parse(
    await controller.request(REMOTE_METHODS.coreCall, {
      operation,
      version: 1,
      params,
    }),
  );
}

const keyed = (key: string): { _meta: { idempotencyKey: string } } => ({
  _meta: { idempotencyKey: key },
});

describe('updates over a remote session, across protocol versions', () => {
  let current: Harness | null = null;
  afterEach(async () => {
    await current?.close();
    current = null;
  });

  it('serves core.update to a controller the tunnel refuses', async () => {
    current = await harness();
    const { controller, events, installs } = current;

    const hello = HelloResultSchema.parse(
      await controller.request(REMOTE_METHODS.hello, {
        version: OLD_CONTROLLER,
      }),
    );
    expect(hello.version).toEqual(HOST_VERSION);
    expect(hello.coreOperations).toMatchObject({
      'core.update.status.get': 1,
      'core.update.apply': 1,
      'core.update.events': 1,
    });
    await expect(
      controller.request(REMOTE_METHODS.invoke, {
        channel: 'update:get-state',
        args: [],
      }),
    ).rejects.toMatchObject({ code: 'remote_protocol_mismatch' });

    const status = await call(controller, 'core.update.status.get', {});
    expect(status).toMatchObject({
      ok: true,
      result: {
        components: [
          { component: 'desktop', state: 'ready', availableVersion: '1.4.0' },
        ],
      },
    });

    await controller.request(REMOTE_METHODS.coreSubscribe, {
      subscriptionKey: 'updates',
      operation: 'core.update.events',
      version: 1,
      params: {},
    });
    const applied = await call(controller, 'core.update.apply', {
      component: 'desktop',
      version: '1.4.0',
      restartPolicy: 'when_idle',
      ...keyed('apply-1'),
    });
    expect(applied).toMatchObject({ ok: true, result: { status: 'queued' } });
    expect(installs).toEqual(['when_idle']);
    await flushRelay();
    expect(events.at(-1)).toMatchObject({
      subscriptionKey: 'updates',
      frame: {
        kind: 'item',
        item: {
          restartPending: {
            policy: 'when_idle',
            requestedBy: { name: 'Laptop' },
          },
        },
      },
    });
  });

  it('refuses a paired computer when this one turned remote updates off', async () => {
    current = await harness();
    const { controller, allow, installs } = current;
    await controller.request(REMOTE_METHODS.hello, { version: OLD_CONTROLLER });
    allow.value = false;
    const refused = await call(controller, 'core.update.apply', {
      component: 'desktop',
      version: '1.4.0',
      restartPolicy: 'immediate',
      ...keyed('apply-2'),
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { kind: 'failed_precondition', code: 'core.update.disabled' },
    });
    expect(installs).toEqual([]);
  });

  it('applies the Remote access switch to paired computers at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-updates-'));
    const settingsPath = join(dir, 'remote-control.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        version: 1,
        allowIncoming: true,
        pairedHosts: [],
        pairedControllers: [],
      }),
    );
    const refuse = (): Promise<never> =>
      Promise.reject(new Error('unused in this test'));
    let policyChanges = 0;
    const windows: RemoteControlWindows = {
      open: () => undefined,
      close: () => undefined,
      focusLocal: () => undefined,
      deliverPush: () => undefined,
      reload: () => undefined,
      appAdvisorWindow: refuse,
      showDialog: refuse,
    };
    const store = new RemoteAccessStore({
      settingsPath,
      identityPath: join(dir, 'identity.key'),
      secretStorage: getSecretStoragePolicy(),
    });
    const service = new RemoteControlService({
      store,
      createRelay: (): never => {
        throw new Error('no relay in this test');
      },
      fetchToken: refuse,
      signedInAccount: (): null => null,
      deviceName: (): string => 'Studio',
      platform: 'darwin',
      onRemoteUpdatesAllowedChange: (): void => {
        policyChanges += 1;
      },
      version: HOST_VERSION,
      createBridge: refuse,
      mainWindowPushes: {
        subscribe: (): (() => void) => (): void => undefined,
      },
      uploads: new RemoteUploadStore(join(dir, 'uploads')),
      readHostFile: refuse,
      openedFiles: new RemoteUploadStore(join(dir, 'opened')),
      markDownloaded: (): Promise<void> => Promise.resolve(),
      openLocalFile: (): Promise<void> => Promise.resolve(),
      windows,
      broadcastState: (): void => undefined,
      readLegacyPortalOptIn: (): Promise<LegacyPortalOptInRead> =>
        Promise.resolve({ reliable: false }),
      webOrigin: (): string => 'https://app.example.test',
    });
    // The renderer's preload API, invoking main's handler for the channel.
    const ipc: PreloadIpcRenderer = {
      invoke: (channel: string, ...args: unknown[]) => {
        const [allow] = args;
        if (
          channel === IPC_CHANNELS.remoteControlSetAllowRemoteUpdates &&
          typeof allow === 'boolean'
        )
          return service.setAllowRemoteUpdates(allow);
        if (channel === IPC_CHANNELS.remoteControlGetState)
          return service.getState();
        return Promise.reject(new Error(`unexpected ${channel}`));
      },
      send: () => undefined,
      sendSync: () => undefined,
      on: () => undefined,
      once: () => undefined,
      removeListener: () => undefined,
      removeAllListeners: () => undefined,
    };
    const api = createRemoteControlApi(ipc, null);
    try {
      current = await harness(() => service.remoteUpdatesAllowed());
      const { controller, installs } = current;
      await controller.request(REMOTE_METHODS.hello, {
        version: OLD_CONTROLLER,
      });
      // On by default on macOS while incoming control is on.
      expect((await api.getState()).allowRemoteUpdates).toBe(true);

      expect((await api.setAllowRemoteUpdates(false)).allowRemoteUpdates).toBe(
        false,
      );
      expect(
        SavedSettingsSchema.parse(
          JSON.parse(readFileSync(settingsPath, 'utf8')),
        ).allowRemoteUpdates,
      ).toBe(false);
      expect(
        await call(controller, 'core.update.check', {
          components: ['desktop'],
          channel: 'stable',
          requestedVersion: null,
          force: false,
          ...keyed('check-off'),
        }),
      ).toMatchObject({ ok: false, error: { code: 'core.update.disabled' } });

      await api.setAllowRemoteUpdates(true);
      expect(
        await call(controller, 'core.update.download', {
          component: 'desktop',
          version: '1.4.0',
          ...keyed('download-on'),
        }),
      ).toMatchObject({ ok: true, result: { status: 'completed' } });
      expect(
        await call(controller, 'core.update.apply.cancel', {
          component: 'desktop',
        }),
      ).toMatchObject({ ok: true, result: { cancelled: false } });
      expect(installs).toEqual([]);
      // core.update heard each change of the switch.
      expect(policyChanges).toBeGreaterThanOrEqual(2);

      // A cache refresh while the opt-out is still saving cannot undo it.
      const on = api.setAllowRemoteUpdates(true);
      const off = api.setAllowRemoteUpdates(false);
      await api.getState();
      expect(service.remoteUpdatesAllowed()).toBe(false);
      await Promise.all([on, off]);
      expect(service.remoteUpdatesAllowed()).toBe(false);

      // An opt-in that fails to save leaves remote updates off.
      jest
        .spyOn(store, 'update')
        .mockRejectedValueOnce(new Error('The disk is full.'));
      await expect(api.setAllowRemoteUpdates(true)).rejects.toThrow(
        'The disk is full.',
      );
      expect(service.remoteUpdatesAllowed()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams a change of the switch to the controller', async () => {
    current = await harness();
    const { controller, events, setAllowed } = current;
    await controller.request(REMOTE_METHODS.hello, { version: OLD_CONTROLLER });
    await controller.request(REMOTE_METHODS.coreSubscribe, {
      subscriptionKey: 'updates',
      operation: 'core.update.events',
      version: 1,
      params: {},
    });
    setAllowed(false);
    await flushRelay();
    expect(events.at(-1)).toMatchObject({
      frame: { kind: 'item', item: { remoteUpdatesAllowed: false } },
    });
  });

  it('frees a stream key that ended while it opened, and holds one opening', async () => {
    current = await harness();
    const { controller } = current;
    await controller.request(REMOTE_METHODS.hello, { version: OLD_CONTROLLER });
    const subscribe = (cursor?: unknown): Promise<unknown> =>
      controller.request(REMOTE_METHODS.coreSubscribe, {
        subscriptionKey: 'updates',
        operation: 'core.update.events',
        version: 1,
        params: cursor === undefined ? {} : { cursor },
      });
    // A cursor from another stream ends at once with snapshotRequired.
    await subscribe({ daemonEpoch: 'another-host', sequence: 1 });
    await expect(subscribe()).resolves.toMatchObject({ ok: true });
    await controller.request(REMOTE_METHODS.coreUnsubscribe, {
      subscriptionKey: 'updates',
    });

    const both = await Promise.all([subscribe(), subscribe()]);
    const SubscribeResultSchema = z.object({
      ok: z.boolean(),
      error: z.object({ kind: z.string() }).optional(),
    });
    expect(
      both.map((result) => SubscribeResultSchema.parse(result).error?.kind),
    ).toContain('already_exists');
  });

  it('frees a stream key when the stream ends after it opened', async () => {
    const ends: Array<() => void> = [];
    current = await harness(undefined, 'desktop', (core) => ({
      operations: core.operations,
      call: (...args): ReturnType<RemoteCoreAccess['call']> =>
        core.call(...args),
      subscribe: async (
        deviceId,
        operation,
        version,
        params,
        onFrame,
      ): ReturnType<RemoteCoreAccess['subscribe']> => {
        const opened = await core.subscribe(
          deviceId,
          operation,
          version,
          params,
          onFrame,
        );
        // The dispatcher ends the stream, as a real end frame means.
        ends.push(() => {
          if (opened.ok) opened.close();
          onFrame({ kind: 'end', reason: 'closed' });
        });
        return opened;
      },
    }));
    const { controller } = current;
    await controller.request(REMOTE_METHODS.hello, { version: OLD_CONTROLLER });
    const subscribe = (): Promise<unknown> =>
      controller.request(REMOTE_METHODS.coreSubscribe, {
        subscriptionKey: 'updates',
        operation: 'core.update.events',
        version: 1,
        params: {},
      });
    await expect(subscribe()).resolves.toMatchObject({ ok: true });
    for (const end of ends) end();
    await expect(subscribe()).resolves.toMatchObject({ ok: true });
  });

  it('drops a cancelled stream’s frames once its key is reused', async () => {
    const gates: Array<() => void> = [];
    let calls = 0;
    current = await harness(undefined, 'desktop', (core) => ({
      operations: core.operations,
      call: (...args): ReturnType<RemoteCoreAccess['call']> =>
        core.call(...args),
      subscribe: async (
        deviceId,
        operation,
        version,
        params,
        onFrame,
      ): ReturnType<RemoteCoreAccess['subscribe']> => {
        calls += 1;
        // The first stream is slow to open.
        if (calls === 1)
          await new Promise<void>((resolve) => gates.push(resolve));
        return core.subscribe(deviceId, operation, version, params, onFrame);
      },
    }));
    const { controller, events } = current;
    await controller.request(REMOTE_METHODS.hello, { version: OLD_CONTROLLER });
    const subscribe = (): Promise<unknown> =>
      controller.request(REMOTE_METHODS.coreSubscribe, {
        subscriptionKey: 'updates',
        operation: 'core.update.events',
        version: 1,
        params: {},
      });
    const first = subscribe();
    await flushRelay();
    await controller.request(REMOTE_METHODS.coreUnsubscribe, {
      subscriptionKey: 'updates',
    });
    await expect(subscribe()).resolves.toMatchObject({ ok: true });
    for (const open of gates) open();
    await first;
    await flushRelay();
    const FrameKindSchema = z.object({
      frame: z.object({ kind: z.string() }),
    });
    expect(
      events.map((event) => FrameKindSchema.parse(event).frame.kind),
    ).not.toContain('end');
  });

  it('keeps the retry directive on a refused remote call', async () => {
    current = await harness(undefined, 'desktop', undefined, 60_000);
    const { controller } = current;
    await controller.request(REMOTE_METHODS.hello, { version: OLD_CONTROLLER });
    const check = (key: string): ReturnType<typeof call> =>
      call(controller, 'core.update.check', {
        components: ['desktop'],
        channel: 'stable',
        requestedVersion: null,
        force: false,
        ...keyed(key),
      });
    await check('check-first');
    const limited = await check('check-again');
    expect(limited).toMatchObject({
      ok: false,
      error: {
        code: 'core.update.rateLimited',
        retry: { kind: 'same_idempotency_key' },
      },
    });
    expect(
      !limited.ok && CanopyErrorPayloadSchema.safeParse(limited.error).success,
    ).toBe(true);
  });

  it('applies a Linux opt-in only once it is saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-updates-linux-'));
    const settingsPath = join(dir, 'remote-control.json');
    // Never set on this Linux computer, so remote updates are off.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        version: 1,
        allowIncoming: true,
        pairedHosts: [],
        pairedControllers: [],
      }),
    );
    const store = new RemoteAccessStore({
      settingsPath,
      identityPath: join(dir, 'identity.key'),
      secretStorage: getSecretStoragePolicy(),
    });
    await store.read();
    chmodSync(dir, 0o500);
    try {
      await expect(
        store.update((settings) => ({ ...settings, allowRemoteUpdates: true })),
      ).rejects.toThrow();
      expect((await store.read()).allowRemoteUpdates).not.toBe(true);
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a restart this computer scheduled out of a paired computer’s hands', async () => {
    current = await harness();
    const { controller, installs, setSnapshot } = current;
    await controller.request(REMOTE_METHODS.hello, { version: OLD_CONTROLLER });
    // Someone at this computer already chose to restart when idle.
    setSnapshot({ restartPending: true });
    expect(
      await call(controller, 'core.update.apply', {
        component: 'desktop',
        version: '1.4.0',
        restartPolicy: 'when_idle',
        ...keyed('apply-join'),
      }),
    ).toMatchObject({ ok: true, result: { status: 'queued' } });
    expect(installs).toEqual([]);
    expect(
      await call(controller, 'core.update.apply.cancel', {
        component: 'desktop',
      }),
    ).toMatchObject({ ok: true, result: { cancelled: false } });
  });

  it('forgets the attempt when a waiting restart is withdrawn', async () => {
    current = await harness();
    const { controller, attempts, setSnapshot } = current;
    await controller.request(REMOTE_METHODS.hello, { version: OLD_CONTROLLER });
    await call(controller, 'core.update.apply', {
      component: 'desktop',
      version: '1.4.0',
      restartPolicy: 'when_idle',
      ...keyed('apply-withdrawn'),
    });
    expect(attempts).toEqual(['1.4.0']);
    // An update check here withdraws the waiting restart.
    setSnapshot({ restartPending: false });
    expect(attempts).toEqual(['1.4.0', null]);
  });

  it('keeps a paired computer’s deadline', async () => {
    current = await harness();
    const { controller, installs } = current;
    await controller.request(REMOTE_METHODS.hello, { version: OLD_CONTROLLER });
    expect(
      await call(controller, 'core.update.apply', {
        component: 'desktop',
        version: '1.4.0',
        restartPolicy: 'immediate',
        _meta: {
          idempotencyKey: 'apply-late',
          deadlineAt: new Date(Date.now() - 1_000).toISOString(),
        },
      }),
    ).toMatchObject({ ok: false, error: { kind: 'deadline_exceeded' } });
    expect(installs).toEqual([]);
  });

  it.each(['mobile', 'browser', 'hosted'] as const)(
    'does not grant core update access to a %s controller',
    async (kind) => {
      current = await harness(undefined, kind);
      const { controller } = current;
      const hello = HelloResultSchema.parse(
        await controller.request(REMOTE_METHODS.hello, {
          version: OLD_CONTROLLER,
        }),
      );
      expect(hello.coreOperations).toBeUndefined();
      for (const method of [
        REMOTE_METHODS.coreCall,
        REMOTE_METHODS.coreSubscribe,
        REMOTE_METHODS.coreUnsubscribe,
      ]) {
        await expect(controller.request(method, {})).rejects.toMatchObject({
          code: 'remote_controller_refused',
        });
      }
      expect(current.installs).toEqual([]);
    },
  );

  it('does not enable core calls after a refused controller profile', async () => {
    current = await harness();
    const { controller } = current;
    await expect(
      controller.request(REMOTE_METHODS.hello, {
        version: OLD_CONTROLLER,
        controller: { kind: 'hosted', minVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'remote_controller_refused' });
    await expect(
      call(controller, 'core.update.status.get', {}),
    ).rejects.toMatchObject({ code: 'remote_protocol_mismatch' });
  });

  it('serves nothing before hello, and nothing it does not list', async () => {
    current = await harness();
    const { controller } = current;
    await expect(
      controller.request(REMOTE_METHODS.coreCall, {
        operation: 'core.update.status.get',
        version: 1,
        params: {},
      }),
    ).rejects.toBeInstanceOf(RpcRemoteError);
    await controller.request(REMOTE_METHODS.hello, { version: OLD_CONTROLLER });
    expect(await call(controller, 'core.chat.list', {})).toMatchObject({
      ok: false,
      error: { kind: 'capability_unavailable' },
    });
  });
});

/** A controller one protocol ahead of the host: the host is the older one. */
const NEW_CONTROLLER = {
  protocolVersion: REMOTE_PROTOCOL_VERSION + 1,
  appVersion: '1.4.0',
};

interface ControllerFixture {
  connection: RemoteHostConnection;
  setSnapshot: (next: Partial<DesktopUpdateSnapshot>) => void;
  setAllowed: (allowed: boolean) => void;
  /** Turns the switch off without the host's stream reporting it yet. */
  refuseWritesQuietly: () => void;
  installs: string[];
  /** Sessions the host answered, in order. */
  sessions: RemoteHostSession[];
  /** Times the window would reload after a new session. */
  reconnects: { count: number };
  /**
   * The connection drops; the host keeps running. With `offline`, it can't
   * be reached again until `comeBack` is called.
   */
  dropSession: (options?: { offline: boolean }) => { comeBack: () => void };
  /**
   * The host goes away to install; it answers again, on `version`, once
   * `comeBack` is called.
   */
  restartHost: (version: typeof HOST_VERSION) => { comeBack: () => void };
  close: () => Promise<void>;
}

/**
 * A real controller connection to a host that serves `core.update` over
 * real handshaken sessions, one per connect, so the host can restart.
 */
async function controllerFixture(
  options: {
    controller?: typeof HOST_VERSION;
    hostPlatform?: 'darwin' | 'win32';
    serveCore?: boolean;
    minIntervalMs?: number;
  } = {},
): Promise<ControllerFixture> {
  let snapshot: DesktopUpdateSnapshot = {
    phase: 'idle',
    currentVersion: '1.3.0',
    displayVersion: '1.3.0',
    availableVersion: null,
    availableDisplayVersion: null,
    progressPercent: null,
    message: null,
    restartPending: false,
    targeted: false,
  };
  const listeners = new Set<() => void>();
  const policyListeners = new Set<() => void>();
  const installs: string[] = [];
  const allow = { value: true };
  const setSnapshot = (next: Partial<DesktopUpdateSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) listener();
  };
  const host: CoreUpdateHost = {
    releaseFlavor: 'stable',
    support: () => ({ supported: true }),
    snapshot: () => snapshot,
    blockers: () => ({ activeChatWork: true, windowBusy: false }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check: () => {
      installs.push('check');
      setSnapshot({
        phase: 'available',
        availableVersion: '1.4.0',
        availableDisplayVersion: '1.4.0',
      });
      return Promise.resolve();
    },
    startDownload: () => {
      installs.push('download');
      setSnapshot({ phase: 'downloading', progressPercent: 40 });
      setTimeout(() => setSnapshot({ phase: 'downloaded' }), 5);
      return Promise.resolve();
    },
    installNow: () => {
      installs.push('now');
      return Promise.resolve();
    },
    scheduleRestart: () => {
      installs.push('when_idle');
      setSnapshot({ restartPending: true });
    },
    cancelScheduledRestart: () => setSnapshot({ restartPending: false }),
  };
  // Each run of the host has its own core.update handlers and stream epoch.
  const runs: Array<ReturnType<typeof createCanopyDispatcher>> = [];
  const startRun = (): ReturnType<typeof createCanopyDispatcher> => {
    const run = createCanopyDispatcher({
      profile: 'core',
      definitions: {
        queries: UPDATE_QUERY_DEFINITIONS,
        instructions: UPDATE_INSTRUCTION_DEFINITIONS,
        streams: UPDATE_STREAM_DEFINITIONS,
      },
      handlers: createCoreUpdateHandlers(host, {
        epoch: `host-epoch-${runs.length + 1}`,
        remote: {
          allowed: (): boolean => allow.value,
          nameOf: () => 'Laptop',
          minIntervalMs: options.minIntervalMs ?? 0,
          subscribe: (listener) => {
            policyListeners.add(listener);
            return (): void => {
              policyListeners.delete(listener);
            };
          },
        },
      }),
    });
    runs.push(run);
    return run;
  };
  let dispatcher = startRun();

  const hub = new InMemoryRelayHub();
  const laptop = createTestDevice(hub, 'Laptop');
  const studio = createTestDevice(hub, 'Studio');
  await flushRelay();
  let hostVersion = HOST_VERSION;
  let offline = false;
  const sessions: RemoteHostSession[] = [];
  const core =
    options.serveCore === false
      ? undefined
      : createRemoteCoreAccess(() => dispatcher);
  const reconnects = { count: 0 };
  const bridge: HostBridge = {
    getChatInterest: () => undefined,
    window: null,
    invoke: () => Promise.resolve(null),
    post: () => undefined,
    onPush: () => () => undefined,
    onClosed: () => () => undefined,
    destroy: () => undefined,
  };
  const connection = new RemoteHostConnection({
    version: options.controller ?? NEW_CONTROLLER,
    release: { flavor: 'stable', displayVersion: '1.4.0' },
    connect: async (): Promise<SecureSession> => {
      if (offline) throw new Error('Studio is offline.');
      const { initiator, responder } = await openControlSession(laptop, studio);
      sessions.push(
        new RemoteHostSession({
          session: responder,
          kind: 'desktop',
          attributedDeviceId: responder.peerDeviceId,
          // A compatible session starts its bridge at once.
          createBridge: (): Promise<HostBridge> => Promise.resolve(bridge),
          mainWindowPushes: {
            subscribe: (): (() => void) => (): void => undefined,
          },
          uploads: new RemoteUploadStore(
            join(tmpdir(), 'remote-updates-uploads'),
          ),
          readFile: (): Promise<never> =>
            Promise.reject(new Error('no reads in this test')),
          disposition: (): 'tunnel' => 'tunnel',
          isAuthorized: (): boolean => true,
          version: hostVersion,
          hello: (): { name: string; platform: 'darwin' | 'win32' } => ({
            name: 'Studio',
            platform: options.hostPlatform ?? 'darwin',
          }),
          onClose: (): void => undefined,
          ...(core ? { core } : {}),
        }),
      );
      return initiator;
    },
    onPush: (): void => undefined,
    onDialogOpen: (): Promise<never> => Promise.reject(new Error('unused')),
    onAppAdvisorWindow: (): Promise<never> =>
      Promise.reject(new Error('unused')),
    onStatusChange: (): void => undefined,
    onReconnected: (): void => {
      reconnects.count += 1;
    },
    minRetryDelayMs: 1,
    maxRetryDelayMs: 5,
  });
  return {
    connection,
    setSnapshot,
    setAllowed: (allowed) => {
      allow.value = allowed;
      for (const listener of [...policyListeners]) listener();
    },
    refuseWritesQuietly: () => {
      allow.value = false;
    },
    installs,
    sessions,
    reconnects,
    dropSession: (dropOptions) => {
      if (dropOptions?.offline) offline = true;
      sessions.at(-1)?.rpc.close('closed');
      return {
        comeBack: (): void => {
          offline = false;
        },
      };
    },
    restartHost: (version) => {
      offline = true;
      sessions.at(-1)?.rpc.close('closed');
      dispatcher = startRun();
      // A fresh process: nothing checked, nothing pending.
      setSnapshot({
        phase: 'idle',
        availableVersion: null,
        availableDisplayVersion: null,
        progressPercent: null,
        restartPending: false,
      });
      return {
        comeBack: (): void => {
          hostVersion = version;
          offline = false;
        },
      };
    },
    close: async () => {
      connection.release();
      for (const session of sessions) session.rpc.close('closed');
      for (const run of runs) await run.shutdown();
    },
  };
}

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return;
    await flushRelay(5);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting until ${what}.`);
}

describe('updating an older host from the controller (slice 3)', () => {
  let fixture: ControllerFixture | null = null;
  afterEach(async () => {
    await fixture?.close();
    fixture = null;
  });

  it('keeps the session for updates, updates the host and reconnects once it restarts', async () => {
    // Rate-limited between steps: the controller waits as the host says.
    fixture = await controllerFixture({ minIntervalMs: 20 });
    const { connection, installs } = fixture;

    connection.keepConnected();
    await waitUntil(() => connection.update?.phase === 'ready', 'ready');
    expect(connection.update).toMatchObject({
      target: 'host',
      hostVersion: '1.3.0',
      localVersion: '1.4.0',
      hostFlavor: 'stable',
    });
    expect(connection.ended).toBe(false);
    // Nothing but the host's updates goes over the kept session.
    await expect(connection.invoke('update:get-state', [])).rejects.toThrow(
      'Update Studio to connect.',
    );
    expect(fixture.sessions).toHaveLength(1);

    await connection.updateHost('update');
    await waitUntil(() => connection.update?.phase === 'waiting', 'waiting');
    expect(installs).toEqual(['check', 'download', 'when_idle']);
    expect(connection.update).toMatchObject({
      waitingForChats: true,
      canCancel: true,
      requestedBy: null,
    });

    const restart = fixture.restartHost(HOST_VERSION);
    await waitUntil(
      () => connection.update?.phase === 'restarting',
      'restarting',
    );
    restart.comeBack();
    await waitUntil(() => connection.update?.phase === 'ready', 'came back');
    // Back on the same version: the install did not take.
    expect(connection.update?.reason).toBe('restarted-without-updating');

    await connection.updateHost('update');
    await waitUntil(() => connection.update?.phase === 'waiting', 'waiting');
    const updated = fixture.restartHost(NEW_CONTROLLER);
    await waitUntil(
      () => connection.update?.phase === 'restarting',
      'restarting',
    );
    updated.comeBack();
    await waitUntil(() => connection.status === 'connected', 'connected');
    expect(connection.update).toBeNull();
    expect(connection.ended).toBe(false);
    // The window that could not load reloads now.
    expect(fixture.reconnects.count).toBe(1);
  });

  it('keeps a waiting restart through a dropped connection', async () => {
    fixture = await controllerFixture();
    const { connection, installs } = fixture;
    connection.keepConnected();
    await waitUntil(() => connection.update?.phase === 'ready', 'ready');
    await connection.updateHost('update');
    await waitUntil(() => connection.update?.phase === 'waiting', 'waiting');

    fixture.dropSession();
    await waitUntil(() => fixture?.sessions.length === 2, 'reconnected');
    await waitUntil(() => connection.update?.phase === 'waiting', 'waiting');
    // The same run answered: nothing restarted, and the restart is still ours.
    expect(connection.update).toMatchObject({ reason: null, canCancel: true });
    expect(installs).toEqual(['check', 'download', 'when_idle']);
  });

  it('withdraws its own restart, and says when someone at the host did', async () => {
    fixture = await controllerFixture();
    const { connection, setSnapshot } = fixture;
    connection.keepConnected();
    await waitUntil(() => connection.update?.phase === 'ready', 'ready');

    await connection.updateHost('update');
    await waitUntil(() => connection.update?.phase === 'waiting', 'waiting');
    await connection.updateHost('cancel');
    await waitUntil(() => connection.update?.phase === 'ready', 'cancelled');
    expect(connection.update?.reason).toBeNull();

    await connection.updateHost('update');
    await waitUntil(() => connection.update?.phase === 'waiting', 'waiting');
    // The person at the host withdraws it there.
    setSnapshot({ restartPending: false });
    await waitUntil(() => connection.update?.phase === 'ready', 'withdrawn');
    expect(connection.update?.reason).toBe('cancelled-at-host');
  });

  it('never claims a restart someone else asked for', async () => {
    fixture = await controllerFixture();
    const { connection, setSnapshot, installs } = fixture;
    connection.keepConnected();
    await waitUntil(() => connection.update?.phase === 'ready', 'ready');
    // The person at the host already downloaded and scheduled the restart.
    setSnapshot({
      phase: 'downloaded',
      availableVersion: '1.4.0',
      availableDisplayVersion: '1.4.0',
      restartPending: true,
    });
    await waitUntil(() => connection.update?.phase === 'waiting', 'waiting');
    await connection.updateHost('update');
    await waitUntil(() => installs.length === 0, 'joined');
    expect(connection.update).toMatchObject({
      phase: 'waiting',
      canCancel: false,
    });
    await expect(connection.updateHost('cancel')).rejects.toThrow(
      "This computer didn't ask for the other computer's restart",
    );
  });

  it('drops a rate-limited restart request when the host withdraws one meanwhile', async () => {
    fixture = await controllerFixture({ minIntervalMs: 300 });
    const { connection, setSnapshot, installs } = fixture;
    setSnapshot({
      phase: 'downloaded',
      availableVersion: '1.4.0',
      availableDisplayVersion: '1.4.0',
    });
    connection.keepConnected();
    await waitUntil(() => connection.update?.phase === 'ready', 'ready');
    await connection.updateHost('update');
    await waitUntil(() => connection.update?.phase === 'waiting', 'waiting');
    await connection.updateHost('cancel');
    await waitUntil(() => connection.update?.phase === 'ready', 'cancelled');
    expect(installs).toEqual(['when_idle']);

    // Inside the host's rate limit: the next apply waits out its delay.
    await connection.updateHost('update');
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Meanwhile someone at the host schedules a restart and withdraws it.
    setSnapshot({ restartPending: true });
    await waitUntil(() => connection.update?.phase === 'waiting', 'theirs');
    setSnapshot({ restartPending: false });
    await waitUntil(
      () => connection.update?.reason === 'cancelled-at-host',
      'withdrawn',
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    // The waiting request was never sent: their cancel stands.
    expect(installs).toEqual(['when_idle']);
    expect(connection.update?.phase).toBe('ready');
  });

  it('names a version someone at the host picked, from this side', async () => {
    fixture = await controllerFixture();
    const { connection, setSnapshot, installs } = fixture;
    setSnapshot({ targeted: true });
    connection.keepConnected();
    await waitUntil(() => connection.update?.phase === 'ready', 'ready');
    await connection.updateHost('update');
    await waitUntil(() => connection.update?.phase === 'failed', 'refused');
    expect(connection.update?.reason).toBe('targeted-update-pending');
    expect(installs).toEqual([]);
  });

  it('shows the connection coming back when it drops with nothing pending', async () => {
    fixture = await controllerFixture();
    const { connection } = fixture;
    connection.keepConnected();
    await waitUntil(() => connection.update?.phase === 'ready', 'ready');
    const drop = fixture.dropSession({ offline: true });
    await waitUntil(
      () => connection.update?.phase === 'reconnecting',
      'reconnecting',
    );
    drop.comeBack();
    await waitUntil(() => connection.update?.phase === 'ready', 'back');
    expect(connection.update?.reason).toBeNull();
  });

  it('restarts the host now when asked, instead of waiting for its chats', async () => {
    fixture = await controllerFixture();
    const { connection, installs } = fixture;
    connection.keepConnected();
    await waitUntil(() => connection.update?.phase === 'ready', 'ready');
    await connection.updateHost('update');
    await waitUntil(() => connection.update?.phase === 'waiting', 'waiting');
    await connection.updateHost('restart-now');
    expect(installs.at(-1)).toBe('now');
    await waitUntil(
      () => connection.update?.phase === 'restarting',
      'restarting',
    );
  });

  it('says when the host does not allow updates from other computers', async () => {
    fixture = await controllerFixture();
    const { connection, setAllowed, installs } = fixture;
    setAllowed(false);
    connection.keepConnected();
    await waitUntil(
      () => connection.update?.phase === 'unavailable',
      'unavailable',
    );
    expect(connection.update?.reason).toBe('remote-updates-off');
    setAllowed(true);
    await waitUntil(() => connection.update?.phase === 'ready', 'allowed');
    expect(installs).toEqual([]);

    // A step refused while the switch is off clears once it is back on.
    fixture.refuseWritesQuietly();
    await connection.updateHost('update');
    await waitUntil(
      () => connection.update?.reason === 'remote-updates-off',
      'refused',
    );
    setAllowed(true);
    await waitUntil(() => connection.update?.phase === 'ready', 'on again');
    expect(installs).toEqual([]);
  });

  it('offers this computer’s own update when the controller is the older one', async () => {
    fixture = await controllerFixture({ controller: OLD_CONTROLLER });
    const { connection } = fixture;
    connection.keepConnected();
    await waitUntil(() => connection.ended, 'ended');
    expect(connection.update).toMatchObject({
      target: 'this-computer',
      phase: 'ready',
      hostVersion: '1.4.0',
    });
    // Nothing keeps the session: the host sees it close.
    await waitUntil(
      () => fixture?.sessions[0]?.rpc.isClosed === true,
      'the session closed',
    );
  });

  it('holds Windows hosts and hosts without update operations to the manual message', async () => {
    fixture = await controllerFixture({ hostPlatform: 'win32' });
    fixture.connection.keepConnected();
    await waitUntil(() => fixture?.connection.ended === true, 'ended');
    expect(fixture.connection.update).toMatchObject({
      target: 'host',
      phase: 'unavailable',
      reason: 'windows-host',
    });
    await fixture.close();

    fixture = await controllerFixture({ serveCore: false });
    fixture.connection.keepConnected();
    await waitUntil(() => fixture?.connection.ended === true, 'ended');
    expect(fixture.connection.update).toBeNull();
    expect(fixture.connection.error).toContain('Update Studio to connect.');
  });
});

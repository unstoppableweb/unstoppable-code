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
import { RemoteHostSession } from '../host/host-session';
import { RemoteUploadStore } from '../host/uploads';
import { RemoteAccessStore } from '../remote-access-store';
import {
  RemoteControlService,
  type PortalOptInRead,
} from '../remote-control-service';
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
      isFeatureEnabled: (): boolean => false,
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
      readPortalOptIn: (): Promise<PortalOptInRead> =>
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

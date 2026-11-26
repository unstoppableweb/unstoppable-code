import type { SpawnOptions } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import type * as Electron from 'electron';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import type * as Fs from 'node:fs/promises';
import type * as CurrentBrand from '@canopy/brand/current';
import type * as CorePlatform from '@canopy/core-platform';
import {
  CanopyOperationError,
  createCanopyDispatcher,
  type CanopyDispatcher,
} from '@canopy/core-runtime';
import { createCoreUpdateHandlers } from '@canopy/core-runtime/update';
import {
  UPDATE_INSTRUCTION_DEFINITIONS,
  UPDATE_QUERY_DEFINITIONS,
  UPDATE_STREAM_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS, type UpdateState } from '@canopy/desktop-shared/types';
import {
  formatIpcLegacyError,
  restoreIpcRejection,
} from '@canopy/desktop-shared/ipc/app-error-rejection';

type Handler = (event: { sender: { id: number } }) => Promise<unknown>;
const mockHandlers = new Map<string, Handler>();
const mockState: { current: UpdateState } = { current: { phase: 'idle' } };
const mockStateListeners = new Set<() => void>();

const mockSpawn = jest.fn<MockChild, [string, string[], SpawnOptions]>();
const mockLinuxHost = { active: false, executable: true };
const updateManagerPath = '/usr/bin/update-manager';

class MockChild extends EventEmitter {
  readonly unref = jest.fn();
}

jest.mock('electron', () => {
  const electron = jest.requireActual<typeof Electron>('electron');
  return {
    ...electron,
    app: {
      ...electron.app,
      getVersion: (): string => '9999.0.0-internal.123',
      isPackaged: true,
    },
    ipcMain: {
      ...electron.ipcMain,
      handle: (channel: string, handler: Handler): void => {
        mockHandlers.set(channel, handler);
      },
      removeHandler: (channel: string): void => {
        mockHandlers.delete(channel);
      },
    },
  };
});
jest.mock('@canopy/brand/current', () => {
  const brand = jest.requireActual<typeof CurrentBrand>(
    '@canopy/brand/current',
  );
  return {
    ...brand,
    BRAND: {
      ...brand.BRAND,
      id: 'unstoppable-code',
      cliName: 'unstoppable-code',
    },
  };
});
// Stub the modules' exported boundaries, not an interop namespace copy.
jest.mock('@canopy/core-platform', () => {
  const platform = jest.requireActual<typeof CorePlatform>(
    '@canopy/core-platform',
  );
  return {
    ...platform,
    hostPlatformOperatingSystem: (): ReturnType<
      typeof CorePlatform.hostPlatformOperatingSystem
    > =>
      mockLinuxHost.active ? 'linux' : platform.hostPlatformOperatingSystem(),
  };
});
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof Fs>('node:fs/promises');
  return {
    ...actual,
    readFile: async (
      ...args: Parameters<typeof Fs.readFile>
    ): ReturnType<typeof Fs.readFile> => {
      if (!mockLinuxHost.active) return actual.readFile(...args);
      if (args[0] === '/var/lib/dpkg/info/unstoppable-code-desktop.list')
        return `${process.execPath}\n`;
      throw new Error('Unexpected fixture read');
    },
    readdir: async (
      ...args: Parameters<typeof Fs.readdir>
    ): ReturnType<typeof Fs.readdir> =>
      mockLinuxHost.active ? [] : actual.readdir(...args),
    stat: async (
      ...args: Parameters<typeof Fs.stat>
    ): Promise<{ isFile(): boolean }> => {
      if (!mockLinuxHost.active) return actual.stat(...args);
      return { isFile: (): boolean => args[0] === updateManagerPath };
    },
    access: async (...args: Parameters<typeof Fs.access>): Promise<void> => {
      if (!mockLinuxHost.active) return actual.access(...args);
      if (
        !mockLinuxHost.executable ||
        args[0] !== updateManagerPath ||
        args[1] !== constants.X_OK
      )
        throw new Error('EACCES');
    },
  };
});
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcess>('node:child_process'),
  spawn: (path: string, args: string[], options: SpawnOptions): MockChild =>
    mockSpawn(path, args, options),
}));
jest.mock('../../lib/e2e-gate', () => ({ isE2eBuild: (): boolean => false }));
jest.mock('../../agents/session-manager', () => ({
  hasActiveChatWork: (): boolean => false,
  subscribeChatSessionActivity: (): (() => void) => () => undefined,
}));
jest.mock('../../updater', () => ({
  getUpdateState: (): UpdateState => mockState.current,
  onUpdateStateChange: (listener: () => void): (() => void) => {
    mockStateListeners.add(listener);
    return () => mockStateListeners.delete(listener);
  },
  getUpdateInstallSupport: jest.fn(),
  isRendererBusy: (): boolean => false,
  checkForUpdates: jest.fn(),
  assertDownloadAllowed: jest.fn(),
  assertInstallAllowed: jest.fn(),
  downloadUpdate: jest.fn(),
  installUpdate: jest.fn(),
  scheduleUpdate: jest.fn(),
  cancelScheduledUpdate: jest.fn(),
  checkForVersion: jest.fn(),
  listTargetUpdateVersions: jest.fn(),
  reportRendererBusyState: jest.fn(),
}));

import { registerUpdateHandlers } from '../../ipc/update';
import {
  assertDownloadAllowed,
  assertInstallAllowed,
  cancelScheduledUpdate,
  checkForUpdates,
  downloadUpdate,
  getUpdateInstallSupport,
  installUpdate,
  scheduleUpdate,
} from '../../updater';
import { createDesktopCoreUpdateHost } from '../core-update-host';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};
const mockResolveCaller = jest.fn(() => caller);

function setState(next: UpdateState): void {
  mockState.current = next;
  for (const listener of [...mockStateListeners]) listener();
}

function ipc(channel: string): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`no ipcMain handler for ${channel}`);
  return handler({ sender: { id: 1 } }).catch((error: unknown) => {
    // Electron prefixes the main rejection before the client restores it.
    restoreIpcRejection(
      new Error(formatIpcLegacyError(channel, String(error))),
    );
  });
}

type UpdateDispatcher = CanopyDispatcher<
  typeof UPDATE_QUERY_DEFINITIONS,
  typeof UPDATE_INSTRUCTION_DEFINITIONS,
  typeof UPDATE_STREAM_DEFINITIONS
>;

function composeDispatcher(): UpdateDispatcher {
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: UPDATE_QUERY_DEFINITIONS,
      instructions: UPDATE_INSTRUCTION_DEFINITIONS,
      streams: UPDATE_STREAM_DEFINITIONS,
    },
    handlers: createCoreUpdateHandlers(createDesktopCoreUpdateHost(), {
      epoch: 'epoch-1',
    }),
  });
}

let dispatcher: UpdateDispatcher;

beforeEach(() => {
  jest.clearAllMocks();
  mockSpawn.mockReset().mockImplementation(() => {
    throw new Error('No native process is available in this fixture');
  });
  // The updater's async calls return promises.
  jest.mocked(checkForUpdates).mockResolvedValue(undefined);
  jest.mocked(downloadUpdate).mockResolvedValue(undefined);
  jest.mocked(installUpdate).mockResolvedValue(undefined);
  jest.mocked(getUpdateInstallSupport).mockReturnValue({ supported: true });
  mockHandlers.clear();
  mockStateListeners.clear();
  mockState.current = { phase: 'idle' };
  Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', 'internal');
  Reflect.set(globalThis, '__CANOPY_INTERNAL_RELEASE_INDICATOR__', '');
  dispatcher = composeDispatcher();
  registerUpdateHandlers(dispatcher, mockResolveCaller);
});

afterEach(async () => {
  await dispatcher.shutdown();
});

describe('Desktop updates handed off to Linux Software Updater', () => {
  const channel = 'update:open-system-updater';
  const desktopSession = {
    DISPLAY: ':0',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  };

  let coreCalls: { query: jest.SpyInstance; instruction: jest.SpyInstance };

  beforeEach(() => {
    coreCalls = {
      query: jest.spyOn(dispatcher, 'query'),
      instruction: jest.spyOn(dispatcher, 'instruction'),
    };
    mockLinuxHost.active = true;
    mockLinuxHost.executable = true;
    Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', 'stable');
    jest.replaceProperty(process, 'env', {
      ...desktopSession,
      PATH: '/fixture/bin',
      ELECTRON_RUN_AS_NODE: '1',
      LD_PRELOAD: 'fixture-only',
    });
  });

  afterEach(() => {
    try {
      expect(mockResolveCaller).not.toHaveBeenCalled();
      expect(coreCalls.query).not.toHaveBeenCalled();
      expect(coreCalls.instruction).not.toHaveBeenCalled();
    } finally {
      mockLinuxHost.active = false;
      jest.restoreAllMocks();
      Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', 'internal');
    }
  });

  it('reports a detached local handoff only after the fixed executable starts', async () => {
    const child = new MockChild();
    mockSpawn.mockReturnValueOnce(child);

    let settled = false;
    const result = ipc(channel).then((value) => {
      settled = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(updateManagerPath, [], {
      detached: true,
      stdio: 'ignore',
      env: { ...desktopSession, PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    expect(settled).toBe(false);
    expect(child.unref).not.toHaveBeenCalled();

    child.emit('spawn');
    await expect(result).resolves.toEqual({ opened: true });
    expect(child.unref).toHaveBeenCalledTimes(1);

    // A stale offer in the UI does not authorize launching an unusable file.
    mockLinuxHost.executable = false;
    await expect(ipc(channel)).resolves.toEqual({ opened: false });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('reports a failed spawn as a refusal so the desktop can fall back', async () => {
    const child = new MockChild();
    mockSpawn.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('error', new Error('ENOENT')));
      return child;
    });

    await expect(ipc(channel)).resolves.toEqual({ opened: false });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(child.unref).not.toHaveBeenCalled();
  });
});

describe('update IPC through core.update', () => {
  // update:check, update:download, update:schedule, update:cancel-scheduled
  // and update:install reach core.update.check, core.update.download,
  // core.update.apply (when_idle), core.update.apply.cancel and
  // core.update.apply (immediate).
  it('runs each action on the same updater call it used before', async () => {
    await ipc(IPC_CHANNELS.updateCheck);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);

    setState({
      phase: 'available',
      info: { version: '9999.0.0-internal.124' },
    });
    await ipc(IPC_CHANNELS.updateDownload);
    expect(assertDownloadAllowed).toHaveBeenCalledTimes(1);
    expect(downloadUpdate).toHaveBeenCalledTimes(1);

    setState({
      phase: 'downloaded',
      info: { version: '9999.0.0-internal.124' },
    });
    await ipc(IPC_CHANNELS.updateSchedule);
    expect(scheduleUpdate).toHaveBeenCalledTimes(1);

    setState({ ...mockState.current, installPending: true });
    await ipc(IPC_CHANNELS.updateCancelScheduled);
    expect(cancelScheduledUpdate).toHaveBeenCalledTimes(1);

    await ipc(IPC_CHANNELS.updateInstall);
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  it('returns from a download before it finishes', async () => {
    let finish: () => void = () => undefined;
    jest.mocked(downloadUpdate).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    setState({
      phase: 'available',
      info: { version: '9999.0.0-internal.124' },
    });
    await expect(ipc(IPC_CHANNELS.updateDownload)).resolves.toBeUndefined();
    finish();
  });

  it('rejects with the updater’s own message on every refusal', async () => {
    const refusal = new Error('Linux updates must be installed manually.');
    jest.mocked(checkForUpdates).mockRejectedValueOnce(refusal);
    jest.mocked(assertDownloadAllowed).mockImplementationOnce(() => {
      throw refusal;
    });
    jest.mocked(scheduleUpdate).mockImplementationOnce(() => {
      throw refusal;
    });
    jest.mocked(assertInstallAllowed).mockImplementationOnce(() => {
      throw refusal;
    });

    const expectRefusal = async (channel: string): Promise<void> => {
      await expect(ipc(channel)).rejects.toThrow(
        new Error(formatIpcLegacyError(channel, String(refusal))),
      );
    };
    await expectRefusal(IPC_CHANNELS.updateCheck);
    await expectRefusal(IPC_CHANNELS.updateDownload);
    expect(downloadUpdate).not.toHaveBeenCalled();
    await expectRefusal(IPC_CHANNELS.updateSchedule);
    await expectRefusal(IPC_CHANNELS.updateInstall);
    expect(installUpdate).not.toHaveBeenCalled();
  });

  // The install shuts the dispatcher down before the app quits, so the
  // apply call must not wait for it.
  it('returns from an install before the app quits', async () => {
    jest
      .mocked(installUpdate)
      .mockReturnValue(new Promise<void>(() => undefined));
    setState({
      phase: 'downloaded',
      info: { version: '9999.0.0-internal.124' },
    });
    await expect(ipc(IPC_CHANNELS.updateInstall)).resolves.toBeUndefined();
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  it('gives the manual steps where the host cannot install', async () => {
    jest.mocked(getUpdateInstallSupport).mockReturnValue({
      supported: false,
      reason: 'linux_package_manager',
      message: 'Update with your package manager.',
    });
    const read = { ...caller, grants: ['core.update.read' as const] };
    const status = await dispatcher.query(
      'core.update.status.get',
      {},
      { caller: read },
    );
    expect(status.components[0]).toMatchObject({
      supported: false,
      unsupportedReason: 'linux_package_manager',
      manualInstructions: 'Update with your package manager.',
    });

    // A check that found a pacman install gives pacman's own command.
    setState({
      phase: 'available',
      info: {
        version: '9999.0.0-internal.124',
        packageManagerUpdate: {
          guidance: 'Update with your package manager:',
          command: 'sudo pacman -Syu',
        },
      },
    });
    const pacman = await dispatcher.query(
      'core.update.status.get',
      {},
      { caller: read },
    );
    expect(pacman.components[0]).toMatchObject({
      manualInstructions: 'Update with your package manager: sudo pacman -Syu',
    });
  });

  it('keeps a build on its own channel and its own candidate', async () => {
    const write = { ...caller, grants: ['core.update.write' as const] };
    await expect(
      dispatcher.instruction(
        'core.update.check',
        {
          components: ['desktop'],
          channel: 'stable',
          requestedVersion: null,
          force: false,
          _meta: { idempotencyKey: 'check-1' },
        },
        { caller: write, metadata: { idempotencyKey: 'check-1' } },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.update.channelMismatch' },
    });

    setState({
      phase: 'downloaded',
      info: { version: '9999.0.0-internal.124' },
    });
    const apply = dispatcher.instruction(
      'core.update.apply',
      {
        component: 'desktop',
        version: '9999.0.0-internal.999',
        restartPolicy: 'immediate',
        _meta: { idempotencyKey: 'apply-1' },
      },
      { caller: write, metadata: { idempotencyKey: 'apply-1' } },
    );
    await expect(apply).rejects.toBeInstanceOf(CanopyOperationError);
    await expect(apply).rejects.toMatchObject({
      payload: { code: 'core.update.invalidState' },
    });
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it('streams core.update.events and resumes without repeating a state', async () => {
    const read = { ...caller, grants: ['core.update.read' as const] };
    type Frame = {
      kind: string;
      cursor?: { daemonEpoch: string; sequence: number };
      item?: { state?: string };
    };
    const settle = (): Promise<void> =>
      new Promise((done) => setImmediate(done));
    const states = (frames: Frame[]): Array<string | undefined> =>
      frames.flatMap((frame) =>
        frame.kind === 'item' ? [frame.item?.state] : [],
      );

    const first: Frame[] = [];
    const stream = await dispatcher.openStream(
      'core.update.events',
      {},
      { caller: read, onFrame: (frame: Frame) => first.push(frame) },
    );
    setState({
      phase: 'available',
      info: { version: '9999.0.0-internal.124' },
    });
    setState({
      phase: 'downloaded',
      info: { version: '9999.0.0-internal.124' },
    });
    await settle();
    expect(states(first)).toEqual(['idle', 'available', 'ready']);
    const last = first.filter((frame) => frame.kind === 'item').at(-1);
    stream.close();

    const resumed: Frame[] = [];
    const again = await dispatcher.openStream(
      'core.update.events',
      { cursor: last?.cursor },
      { caller: read, onFrame: (frame: Frame) => resumed.push(frame) },
    );
    await settle();
    expect(states(resumed)).toEqual([]);
    setState({ ...mockState.current, installPending: true });
    await settle();
    expect(states(resumed)).toEqual(['ready']);
    again.close();
  });

  it('reports an install that fails after it started', async () => {
    const write = {
      ...caller,
      grants: ['core.update.read' as const, 'core.update.write' as const],
    };
    setState({
      phase: 'downloaded',
      info: { version: '9999.0.0-internal.124' },
    });
    await dispatcher.instruction(
      'core.update.apply',
      {
        component: 'desktop',
        version: '9999.0.0-internal.124',
        restartPolicy: 'immediate',
        _meta: { idempotencyKey: 'apply-now' },
      },
      { caller: write, metadata: { idempotencyKey: 'apply-now' } },
    );
    const stateNow = async (): Promise<unknown> =>
      (await dispatcher.query('core.update.status.get', {}, { caller: write }))
        .components[0];
    await expect(stateNow()).resolves.toMatchObject({ state: 'applying' });

    // electron-updater reports a failed quitAndInstall through its error event.
    setState({ phase: 'error', message: 'The installer could not start.' });
    await expect(stateNow()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'core.update.failed',
      message: 'The installer could not start.',
    });
  });

  it('answers a repeated request key without repeating the request', async () => {
    const write = { ...caller, grants: ['core.update.write' as const] };
    setState({
      phase: 'downloaded',
      info: { version: '9999.0.0-internal.124' },
    });
    const apply = (
      key: string,
      restartPolicy: 'when_idle' | 'immediate',
    ): Promise<unknown> =>
      dispatcher.instruction(
        'core.update.apply',
        {
          component: 'desktop',
          version: '9999.0.0-internal.124',
          restartPolicy,
          _meta: { idempotencyKey: key },
        },
        { caller: write, metadata: { idempotencyKey: key } },
      );

    const first = await apply('apply-idle', 'when_idle');
    setState({ ...mockState.current, installPending: true });
    await dispatcher.instruction(
      'core.update.apply.cancel',
      { component: 'desktop' },
      { caller: write },
    );
    setState({ ...mockState.current, installPending: false });
    await expect(apply('apply-idle', 'when_idle')).resolves.toEqual(first);
    expect(scheduleUpdate).toHaveBeenCalledTimes(1);

    await expect(apply('apply-idle', 'immediate')).rejects.toMatchObject({
      payload: { code: 'core.update.invalidState' },
    });
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it('keeps reporting status after a very long updater error', async () => {
    setState({
      phase: 'error',
      info: { version: '9999.0.0-internal.124' },
      message: `The feed answered 502: ${'<html>'.repeat(2_000)}`,
    });
    const read = { ...caller, grants: ['core.update.read' as const] };
    const status = await dispatcher.query(
      'core.update.status.get',
      {},
      { caller: read },
    );
    const [desktop] = status.components;
    expect(desktop?.state).toBe('failed');
    expect(desktop?.message?.startsWith('The feed answered 502: ')).toBe(true);
    expect(desktop?.message?.length).toBeLessThanOrEqual(4_096);
  });

  it('reports the host’s state with the version people see', async () => {
    setState({
      phase: 'downloaded',
      info: { version: '9999.0.0-internal.124' },
      installPending: true,
    });
    const read = { ...caller, grants: ['core.update.read' as const] };
    const status = await dispatcher.query(
      'core.update.status.get',
      {},
      { caller: read },
    );
    expect(status.components).toEqual([
      expect.objectContaining({
        component: 'desktop',
        state: 'ready',
        releaseFlavor: 'internal',
        displayVersion: 'internal-123',
        availableVersion: '9999.0.0-internal.124',
        availableDisplayVersion: 'internal-124',
        restartPending: { policy: 'when_idle', requestedBy: null },
      }),
    ]);
  });
});

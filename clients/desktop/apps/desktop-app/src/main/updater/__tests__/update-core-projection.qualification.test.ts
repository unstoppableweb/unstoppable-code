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

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const mockHandlers = new Map<string, Handler>();
const mockState: { current: UpdateState } = { current: { phase: 'idle' } };
const mockStateListeners = new Set<() => void>();

jest.mock('electron', () => ({
  app: { getVersion: (): string => '9999.0.0-internal.123', isPackaged: true },
}));
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    mockHandlers.set(channel, handler);
  },
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

function setState(next: UpdateState): void {
  mockState.current = next;
  for (const listener of [...mockStateListeners]) listener();
}

function ipc(channel: string): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({});
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
  registerUpdateHandlers(dispatcher, () => caller);
});

afterEach(async () => {
  await dispatcher.shutdown();
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

    await expect(ipc(IPC_CHANNELS.updateCheck)).rejects.toThrow(refusal);
    await expect(ipc(IPC_CHANNELS.updateDownload)).rejects.toThrow(refusal);
    expect(downloadUpdate).not.toHaveBeenCalled();
    await expect(ipc(IPC_CHANNELS.updateSchedule)).rejects.toThrow(refusal);
    await expect(ipc(IPC_CHANNELS.updateInstall)).rejects.toThrow(refusal);
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

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { registerSharedContainerHandlers } from '../ipc/shared-containers';
import { isListSharedContainerOwnerDeparturesResult } from '../../preload/shared-container-validation';
import { useSharedContainerOwnerDeparturesStore } from '../../renderer/src/stores/sharedContainerOwnerDeparturesStore';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const listMock = jest.fn<Promise<unknown>, []>();
const dismissMock = jest.fn<Promise<void>, [string]>();
const signalMock = jest.fn<void, []>();
jest.mock('@canopy/desktop-instrumentation/client', () => ({
  reportClientAppError: jest.fn(),
}));
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): never[] => [] },
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => true,
  }),
}));
jest.mock('../canopy-cloud/client', () => ({
  CanopyCloudClientError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status?: number,
      readonly serverCode?: string,
    ) {
      super(message);
    }
  },
}));
jest.mock('../shared-containers/canopy-server-client', () => ({
  listSharedContainerOwnerDepartures: (): Promise<unknown> => listMock(),
  dismissSharedContainerOwnerDeparture: (id: string): Promise<void> =>
    dismissMock(id),
}));
jest.mock('../services/shared-container-inbox-watcher', () => ({
  getSharedContainerInboxWatcher: (): { signalLocalChange: () => void } => ({
    signalLocalChange: (): void => signalMock(),
  }),
}));
jest.mock('../lib/main-process-logging', () => ({}));
jest.mock('../lib/plan-persistence', () => ({
  addTrackedPlansWriteListener: jest.fn(),
}));
jest.mock('../lib/workspace-registry', () => ({}));
jest.mock('../shared-containers/owner-scope', () => ({}));
jest.mock('../shared-containers/eligibility', () => ({}));
jest.mock('../shared-containers/listing-diagnostics', () => ({}));
jest.mock('../shared-containers/file-scope-store', () => ({}));
jest.mock('../shared-containers/publication-state', () => ({
  getSharedContainerPublicationStateStore: (): {
    rehydrateAll: () => Promise<never[]>;
  } => ({
    rehydrateAll: (): Promise<never[]> => Promise.resolve([]),
  }),
}));
jest.mock('../shared-containers/acceptance-store', () => ({}));
jest.mock('../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): { recover: () => void } => ({
    recover: jest.fn(),
  }),
}));
jest.mock('../shared-containers/reconciliation-service', () => ({
  getSharedContainerReconciliationService: (): {
    onChanged: () => void;
    onSyncPhase: () => void;
  } => ({
    onChanged: jest.fn(),
    onSyncPhase: jest.fn(),
  }),
}));
jest.mock('../shared-containers/read/reader', () => ({
  getSharedContainerReader: (): Record<string, never> => ({}),
}));
jest.mock('../shared-containers/share-preview', () => ({}));
jest.mock('../services/telemetry-sync-service', () => ({}));
jest.mock('../observability', () => ({}));
jest.mock('../shared-containers/run-env-store', () => ({}));
jest.mock('../shared-containers/run/run-copy', () => ({}));
jest.mock('../services/scripts-service', () => ({}));
jest.mock('../terminal/worker-terminal', () => ({}));
jest.mock('../lib/script-runner', () => ({}));
jest.mock('../shared-containers/fork', () => ({}));
jest.mock('../canopy-runtime/source-composition-dispatch', () => ({}));
jest.mock('../shared-containers/capability-package/install', () => ({
  recoverForkCapabilityInstalls: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../shared-containers/fork/destination', () => ({}));
jest.mock('../shared-containers/fork/provenance', () => ({}));
jest.mock('../lib/web-contents-send', () => ({}));
jest.mock('../lib/desktop-telemetry', () => ({}));

const noticeId = '00000000-0000-4000-8000-000000000001';
const list = (): Promise<unknown> =>
  invoke(IPC_CHANNELS.sharedContainersListOwnerDepartures);
const dismiss = (id: unknown = noticeId): Promise<unknown> =>
  invoke(IPC_CHANNELS.sharedContainersDismissOwnerDeparture, { noticeId: id });
function invoke(channel: string, request?: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing handler: ${channel}`);
  return handler({}, request);
}
beforeAll(() => {
  registerSharedContainerHandlers({
    dispatcher: { instruction: jest.fn() },
    resolveCaller: () => {
      throw new Error('Hosted notices must not dispatch to core');
    },
  });
});
beforeEach(() => jest.resetAllMocks());

it('lists hosted notices and signals every view after dismissal', async () => {
  const response = { notices: [{ id: noticeId }] };
  listMock.mockResolvedValue(response);
  await expect(list()).resolves.toBe(response);
  await expect(dismiss()).resolves.toEqual({ dismissed: true });
  expect(dismissMock).toHaveBeenCalledWith(noticeId);
  expect(signalMock).toHaveBeenCalledTimes(1);
});
it('preserves unsupported capability answers without signalling a change', async () => {
  const unsupported = new CanopyCloudClientError(
    'unsupported-capability',
    'Unsupported',
  );
  listMock.mockRejectedValue(unsupported);
  dismissMock.mockRejectedValue(unsupported);
  await expect(list()).resolves.toEqual({ unsupported: true });
  await expect(dismiss()).resolves.toEqual({ unsupported: true });
  expect(signalMock).not.toHaveBeenCalled();
});
it('accepts a typed missing notice but propagates a bare 404', async () => {
  dismissMock.mockRejectedValueOnce(
    new CanopyCloudClientError(
      'http-error',
      'Not found',
      404,
      'shared_container_owner_departure_not_found',
    ),
  );
  await expect(dismiss()).resolves.toEqual({ dismissed: true });
  dismissMock.mockRejectedValueOnce(
    new CanopyCloudClientError('http-error', 'Not found', 404),
  );
  await expect(dismiss()).rejects.toThrow('Not found');
  expect(signalMock).toHaveBeenCalledTimes(1);
});
it('propagates transport failures without signalling a dismissal', async () => {
  listMock.mockRejectedValue(new Error('offline'));
  dismissMock.mockRejectedValue(new Error('offline'));
  await expect(list()).rejects.toThrow('offline');
  await expect(dismiss()).rejects.toThrow('offline');
  expect(signalMock).not.toHaveBeenCalled();
});
it('clears desktop notices and backs off when a previously available listing returns 404', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        sharedContainers: {
          listOwnerDepartures: async () => {
            const result = await list();
            if (!isListSharedContainerOwnerDeparturesResult(result)) {
              throw new Error('Invalid owner departure listing');
            }
            return result;
          },
        },
      },
    },
  });
  const store = useSharedContainerOwnerDeparturesStore.getState();
  const response = {
    notices: [
      {
        id: noticeId,
        organizationId: '00000000-0000-4000-8000-000000000002',
        containerId: '00000000-0000-4000-8000-000000000003',
        containerType: 'CODE_WORKTREE',
        title: 'Departed share',
        ownerName: 'Former teammate',
        reason: 'LEFT',
        createdAt: '2026-11-11T20:00:00.000Z',
      },
    ],
  };
  try {
    listMock.mockResolvedValueOnce(response);
    await store.load();
    expect(useSharedContainerOwnerDeparturesStore.getState().notices).toEqual(
      response.notices,
    );

    listMock.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'Unavailable', 503),
    );
    await store.load();
    expect(useSharedContainerOwnerDeparturesStore.getState().notices).toEqual(
      response.notices,
    );
    jest.mocked(reportClientAppError).mockClear();

    listMock.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    await store.load();
    expect(useSharedContainerOwnerDeparturesStore.getState().notices).toEqual(
      [],
    );
    expect(reportClientAppError).not.toHaveBeenCalled();
    await store.load();
    expect(listMock).toHaveBeenCalledTimes(3);

    clock.mockReturnValue(301_000);
    listMock.mockResolvedValueOnce(response);
    await store.load();
    expect(useSharedContainerOwnerDeparturesStore.getState().notices).toEqual(
      response.notices,
    );

    listMock.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    await store.load();
    store.reset();
    listMock.mockResolvedValueOnce(response);
    await store.load();
    expect(listMock).toHaveBeenCalledTimes(6);
    expect(useSharedContainerOwnerDeparturesStore.getState().notices).toEqual(
      response.notices,
    );
  } finally {
    store.reset();
    Reflect.deleteProperty(globalThis, 'window');
    clock.mockRestore();
  }
});
it.each(['', 'not-a-uuid', null, `${noticeId}/../x`])(
  'rejects invalid notice id %p before a request',
  async (id) => {
    await expect(dismiss(id)).rejects.toThrow();
    expect(dismissMock).not.toHaveBeenCalled();
    expect(signalMock).not.toHaveBeenCalled();
  },
);

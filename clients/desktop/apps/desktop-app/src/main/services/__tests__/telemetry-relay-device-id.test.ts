/**
 * Desktop to hosted telemetry upload names the uploading computer (CAN-7218).
 *
 * Each worktree envelope the telemetry sync singleton uploads carries this
 * computer's relay device id as `sourceRelayDeviceId`, so a push tap on mobile
 * can open the chat on the computer that ran it. Until the relay identity is
 * loaded the key is omitted, letting the server keep any id it already stored.
 * The id source installed with `setTelemetryRelayDeviceIdSource` is read when
 * each request is built, so wiring it after the singleton exists still counts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as TelemetrySyncModule from '../telemetry-sync-service';

const PROJECT_ID = 'project-relay-1';
const WORKTREE_ID = 'worktree-relay-1';

const mockRequestCanopyCloudJson = jest.fn<
  Promise<unknown>,
  [string, unknown]
>();
let mockDataDir = '';

jest.mock('../../canopy-cloud/client', () => ({
  CanopyCloudClientError: class CanopyCloudClientError extends Error {
    readonly status: number | undefined = undefined;
    readonly serverCode: string | undefined = undefined;
  },
  requestCanopyCloudJson: (path: string, init: unknown): Promise<unknown> =>
    mockRequestCanopyCloudJson(path, init),
}));
jest.mock('../../canopy-cloud/oauth-login', () => ({
  getDesktopOAuthClientDeviceId: (): Promise<string> =>
    Promise.reject(new Error('no OAuth device id in this test')),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: (): Promise<unknown> =>
    Promise.resolve({ organizations: [], teams: [] }),
}));
jest.mock('../../lib/org-billing-state', () => ({
  loadStoredOrgBillingStates: (): Promise<Record<string, never>> =>
    Promise.resolve({}),
}));
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<object>('../../lib/paths'),
  getTelemetrySyncMapFilePath: (): string =>
    join(mockDataDir, 'telemetry-sync-map.json'),
  getTelemetrySyncQueueFilePath: (): string =>
    join(mockDataDir, 'telemetry-sync-queue.jsonl'),
}));
jest.mock('../../lib/preferences-store', () => ({
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: (): Promise<unknown> =>
    Promise.resolve({
      telemetrySharing: {
        metadata: 'private',
        transcripts: 'off',
        plans: 'off',
        summaries: 'off',
      },
      dataSharingOptInHistory: [],
    }),
}));
jest.mock('../../lib/telemetry-enforcement-state', () => ({
  emptyTelemetryEnforcementByOrganization: (): Map<string, never> =>
    new Map<string, never>(),
  loadStoredTelemetryEnforcementByOrganization: (): Promise<
    Map<string, never>
  > => Promise.resolve(new Map<string, never>()),
  recordTelemetryEnforcementReadFailure: (): void => undefined,
}));
jest.mock('../../lib/work-owner', () => ({
  resolveWorkOwnerOrganization: (): Promise<{ kind: 'none' }> =>
    Promise.resolve({ kind: 'none' }),
  workOwnerContextForSelection: (): object => ({}),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readWorkspaceIndexEntry: (): Promise<unknown> =>
    Promise.resolve({ name: 'Relay project', type: 'single-repo' }),
}));
jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: (): Promise<unknown> =>
    Promise.resolve({ config: {}, authority: 'ok', ownerMalformed: false }),
  readWorkspaceWorktrees: (): Promise<unknown[]> =>
    Promise.resolve([{ id: WORKTREE_ID, branchName: 'feature/relay' }]),
}));
jest.mock('../../lib/space-notification-scope', () => ({
  resolveSpaceNotificationScope: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../../memory/local/policy', () => ({
  resolveLocalMemoryPolicy: (): Promise<{ kind: 'unscoped' }> =>
    Promise.resolve({ kind: 'unscoped' }),
}));
jest.mock('../../local-only/policy', () => ({
  allowsAutomaticCall: (): boolean => true,
}));
jest.mock('../../observability', () => ({
  getObservabilityService: (): object => ({
    subscribe: (): (() => void) => () => undefined,
    recordAppDiagnostic: (): void => undefined,
    recordSessionDiagnostic: (): void => undefined,
  }),
}));
jest.mock('../../lib/plan-persistence', () => ({
  addPlanContentChangeListener: (): void => undefined,
  addPlanShareChangeListener: (): void => undefined,
  listTrackedPlans: (): Promise<unknown[]> => Promise.resolve([]),
  removePlanContentChangeListener: (): void => undefined,
  removePlanShareChangeListener: (): void => undefined,
}));
jest.mock('../../lib/worktree-summary-persistence', () => ({
  addWorktreeSummaryChangeListener: (): void => undefined,
  removeWorktreeSummaryChangeListener: (): void => undefined,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: (): void => undefined,
}));

type TelemetryModule = typeof TelemetrySyncModule;

/** The first worktree of every telemetry ingest request sent so far. */
function uploadedWorktrees(): Record<string, unknown>[] {
  return mockRequestCanopyCloudJson.mock.calls
    .filter(([path]) => path.endsWith('/telemetry/ingest'))
    .map(([, init]) => {
      const body: unknown =
        typeof init === 'object' && init !== null
          ? Reflect.get(init, 'body')
          : undefined;
      if (typeof body !== 'string') throw new Error('Expected a JSON body');
      const request: unknown = JSON.parse(body);
      const workspace: unknown =
        typeof request === 'object' && request !== null
          ? Reflect.get(request, 'workspace')
          : undefined;
      const worktrees: unknown =
        typeof workspace === 'object' && workspace !== null
          ? Reflect.get(workspace, 'worktrees')
          : undefined;
      const first: unknown = Array.isArray(worktrees) ? worktrees[0] : null;
      if (typeof first !== 'object' || first === null) {
        throw new Error('Expected a worktree envelope');
      }
      return Object.fromEntries(Object.entries(first));
    });
}

describe('telemetry upload relay device id', () => {
  let telemetry: TelemetryModule;

  beforeEach(async () => {
    mockDataDir = await mkdtemp(join(tmpdir(), 'telemetry-relay-device-id-'));
    mockRequestCanopyCloudJson.mockReset();
    mockRequestCanopyCloudJson.mockResolvedValue({
      workspace: { externalId: 'server-workspace', worktrees: [] },
    });
    jest.resetModules();
    telemetry = await import('../telemetry-sync-service');
  });

  afterEach(async () => {
    await telemetry.getTelemetrySyncService().dispose();
    await rm(mockDataDir, { recursive: true, force: true });
  });

  async function uploadWorktreeEnvelope(): Promise<Record<string, unknown>> {
    const service = telemetry.getTelemetrySyncService();
    const before = uploadedWorktrees().length;
    await service.refreshWorktreeMetadata(PROJECT_ID, WORKTREE_ID);
    await service.flushWorktreeNow(PROJECT_ID, WORKTREE_ID);
    const uploaded = uploadedWorktrees();
    expect(uploaded).toHaveLength(before + 1);
    const envelope = uploaded[uploaded.length - 1];
    expect(envelope.sourceClientLocalId).toBe(WORKTREE_ID);
    return envelope;
  }

  it('names this computer once its relay device id is loaded', async () => {
    telemetry.setTelemetryRelayDeviceIdSource(() => 'relay-device-1');
    await telemetry.getTelemetrySyncService().start();

    const envelope = await uploadWorktreeEnvelope();

    expect(envelope.sourceRelayDeviceId).toBe('relay-device-1');
  });

  it('omits the device id until the relay identity is loaded', async () => {
    telemetry.setTelemetryRelayDeviceIdSource(() => null);
    await telemetry.getTelemetrySyncService().start();

    const envelope = await uploadWorktreeEnvelope();

    expect(envelope).not.toHaveProperty('sourceRelayDeviceId');
  });

  it('reads the source at upload time, after the singleton exists', async () => {
    await telemetry.getTelemetrySyncService().start();

    const beforeWiring = await uploadWorktreeEnvelope();
    expect(beforeWiring).not.toHaveProperty('sourceRelayDeviceId');

    let relayDeviceId: string | null = 'relay-device-2';
    telemetry.setTelemetryRelayDeviceIdSource(() => relayDeviceId);
    const afterWiring = await uploadWorktreeEnvelope();
    expect(afterWiring.sourceRelayDeviceId).toBe('relay-device-2');

    relayDeviceId = 'relay-device-3';
    const afterChange = await uploadWorktreeEnvelope();
    expect(afterChange.sourceRelayDeviceId).toBe('relay-device-3');
  });
});

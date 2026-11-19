import {
  PersonalProjectOperationSchema,
  type PersonalProjectConversionRequest,
} from '@canopy/protocol/organizations';
import {
  createPersonalOrganizationUpgradeStore,
  type PersonalOrganizationUpgradeRecord,
  type PersonalOrganizationUpgradeStoreOptions,
} from '@canopy/app-state/personal-organization-upgrade';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getPrimaryProjectConfigFilePath,
  InvalidCanopyJsonError,
  readCanopyJson,
} from '../lib/canopy-json';
import { createPersonalOrganizationUpgradeJournal } from '../lib/personal-organization-upgrade-journal';
const handlers = new Map<
  string,
  (event: unknown, value?: unknown) => unknown
>();
const mockConvert = jest.fn<Promise<unknown>, [unknown, string?]>();
const mockStatus = jest.fn<Promise<unknown>, [string, string?, true?]>();
const mockList = jest.fn<Promise<unknown>, [AbortSignal?, boolean?]>();
const mockPromote = jest.fn<Promise<unknown>, [unknown]>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, value?: unknown) => unknown,
  ): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../services/personal-organization-upgrade-host', () => ({
  getPersonalOrganizationUpgradeService: (): {
    convert: typeof mockConvert;
    status: typeof mockStatus;
    list: typeof mockList;
    promote: typeof mockPromote;
  } => ({
    convert: mockConvert,
    status: mockStatus,
    list: mockList,
    promote: mockPromote,
  }),
}));
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { registerPersonalOrganizationUpgradeHandlers } from '../ipc/personal-organization-upgrade';
import {
  createPersonalOrganizationUpgradeService,
  type UpgradeIdentity,
} from '../services/personal-organization-upgrade';

const organizationId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const request = {
  organizationId,
  operationId,
  workspaceIds: ['checked', 'another'],
  workspaceId: 'checked',
};
beforeEach((): void => {
  jest.resetAllMocks();
  handlers.clear();
  registerPersonalOrganizationUpgradeHandlers();
});
it('registers the backend IPC operations and rejects invalid nested results', async (): Promise<void> => {
  expect(handlers.size).toBe(6);
  const convert = handlers.get(IPC_CHANNELS.personalOrganizationUpgradeConvert);
  if (!convert) throw new Error('Missing handler');
  const operation = {
    organizationId,
    operationId,
    accountId: 'account',
    selection: request.workspaceIds,
    updatedAt: '2026-10-08T00:00:00.000Z',
    projects: request.workspaceIds.map((workspaceId) => ({
      workspaceId,
      stage: 'queued',
      outcome: 'pending',
    })),
  };
  mockConvert.mockResolvedValueOnce(operation).mockResolvedValueOnce({
    ...operation,
    projects: operation.projects.map((project) =>
      project.workspaceId === request.workspaceId
        ? { ...project, stage: 'invalid' }
        : project,
    ),
  });
  await expect(convert(undefined, request)).resolves.toEqual(operation);
  await expect(convert(undefined, request)).rejects.toMatchObject({
    issues: [{ code: 'invalid_value', path: ['projects', 0, 'stage'] }],
  });
  expect(mockConvert).toHaveBeenCalledWith(request);
});
it('rejects invalid IPC requests before invoking the service', async (): Promise<void> => {
  const status = handlers.get(IPC_CHANNELS.personalOrganizationUpgradeStatus);
  if (!status) throw new Error('Missing handler');
  await expect(status(undefined, { operationId: 'bad' })).rejects.toThrow();
  expect(mockStatus).not.toHaveBeenCalled();
});
it('serializes a server refusal so Electron does not discard its typed code', async () => {
  const promote = handlers.get(IPC_CHANNELS.personalOrganizationUpgradePromote);
  if (!promote) throw new Error('Missing handler');
  mockPromote.mockRejectedValue(
    new CanopyCloudClientError(
      'http-error',
      'Disabled',
      409,
      'creation_disabled',
    ),
  );
  await expect(
    promote(undefined, { organizationId, operationId, name: 'Acme' }),
  ).resolves.toEqual({
    error: 'HTTP 409: Disabled',
    code: 'creation_disabled',
    status: 409,
  });
});

it('preflights the whole batch and retains a terminal failure through restart until consumed', async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'canopy-conversion-config-'));
  const journalPath = join(dir, 'journal.json');
  const configPath = getPrimaryProjectConfigFilePath(dir);
  const marker = 'PRIVATECFG';
  const unused = (): never => {
    throw new Error('Unexpected mutation');
  };
  const identity = (): Promise<UpgradeIdentity> =>
    Promise.resolve({
      accountId: 'account',
      epoch: 0,
      credentials: { baseUrl: 'https://example.test', apiKey: 'fixture' },
    });
  const project = {
    workspaceId: 'checked',
    name: 'Project',
    kind: 'single-repo' as const,
  };
  const healthy = {
    ...project,
    workspaceId: 'healthy',
    name: 'Healthy project',
  };
  const projects = [healthy, project];
  const healthyPath = join(dir, 'healthy');
  const projectId = '33333333-3333-4333-8333-333333333333';
  const createSingle = jest.fn(
    async (workspace: { path: string; workspaceId: string }) => {
      await readCanopyJson(workspace.path);
      return {
        ok: true as const,
        organizationProjectId: projectId,
        localWorkspaceId: workspace.workspaceId,
      };
    },
  );
  const journal = createPersonalOrganizationUpgradeJournal(() => journalPath);
  const share = jest.fn(() => Promise.resolve());
  const makeService = (): ReturnType<
    typeof createPersonalOrganizationUpgradeService
  > =>
    createPersonalOrganizationUpgradeService({
      identity,
      async workspaces(selected) {
        const items = [];
        for (const item of projects) {
          const path =
            item.workspaceId === healthy.workspaceId ? healthyPath : dir;
          if (selected?.workspaceIds.includes(item.workspaceId)) {
            try {
              await readCanopyJson(path);
            } catch (error) {
              if (!(error instanceof InvalidCanopyJsonError)) throw error;
              selected.reportInvalidConfig(item.workspaceId);
              continue;
            }
          }
          items.push({ ...item, path });
        }
        return items;
      },
      previewProjects: () => Promise.resolve(projects),
      destination: () => Promise.resolve(true),
      promote: unused,
      suppress: unused,
      refreshAccount: identity,
      switchContext: () => Promise.resolve(),
      invite: unused,
      inviteStatus: unused,
      createSingle,
      createMulti: unused,
      share,
      refreshCatalog: () => Promise.resolve(),
      journal,
      now: () => new Date().toISOString(),
    });
  let service = makeService();
  const requests: PersonalProjectConversionRequest[] = [];
  let saved: PersonalOrganizationUpgradeRecord | null = null;
  let pendingRecord: PersonalOrganizationUpgradeRecord | null = null;
  const promote = jest.fn((value: { operationId: string; name: string }) =>
    Promise.resolve({
      promotion: {
        ...value,
        organizationId,
        personalOrganizationId: '44444444-4444-4444-8444-444444444444',
        alreadyUpgraded: false,
        warnings: [],
      },
      contextSwitched: true,
      warnings: [],
    }),
  );
  const options: PersonalOrganizationUpgradeStoreOptions = {
    accountKey: 'account',
    personalOrganizationId: '55555555-5555-4555-8555-555555555555',
    defaultName: 'Team',
    recovery: {
      read: () => saved,
      write: (value) => {
        saved = value;
        if (value?.promotion && !value.conversionFailure) pendingRecord = value;
      },
    },
    port: {
      canPromote: true,
      canInvite: false,
      canBringProjects: true,
      promote,
      invite: unused,
      listProjects: () => Promise.resolve(projects),
      async convert(value) {
        requests.push(value);
        if (requests.length === 1) {
          await journal.update({
            operationId: value.operationId,
            organizationId: value.organizationId,
            accountId: 'account',
            selection: value.workspaceIds,
            projects: value.workspaceIds.map((workspaceId) => ({
              workspaceId,
              stage: 'queued',
              outcome: 'pending',
              creationStarted: false,
            })),
            updatedAt: new Date().toISOString(),
          });
        }
        return PersonalProjectOperationSchema.parse(
          await service.convert(value),
        );
      },
      status: (id, ack) => service.status(id, undefined, ack),
    },
  };
  let store = createPersonalOrganizationUpgradeStore(options);
  try {
    await mkdir(healthyPath);
    await writeFile(
      getPrimaryProjectConfigFilePath(healthyPath),
      '{"version":1}',
    );
    await writeFile(configPath, marker);
    await store.getState().loadProjects();
    await store.getState().submit();
    const [first] = requests;
    if (!first) throw new Error('Expected first project request');
    expect(store.getState().operation).toBeNull();
    expect(store.getState().conversionFailure?.code).toBe(
      'invalid-canopy-json',
    );
    await expect(service.status(first.operationId)).resolves.toMatchObject({
      terminalReason: 'invalid-canopy-json',
    });
    expect(await journal.read()).toHaveLength(1);
    expect(await readFile(journalPath, 'utf8')).not.toContain(marker);
    expect(createSingle).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();

    // Lose the terminal reply before checklist persistence. A fresh service
    // and checklist recover it from the journal, without binding any row.
    store.getState().dispose();
    service = makeService();
    await service.resume();
    saved = pendingRecord;
    store = createPersonalOrganizationUpgradeStore(options);
    await store.getState().restore();
    expect(store.getState().phase).toBe('partial');
    expect(store.getState().conversionFailure?.code).toBe(
      'invalid-canopy-json',
    );
    expect(createSingle).not.toHaveBeenCalled();
    expect(await journal.read()).toHaveLength(1);
    await store.getState().acknowledgeProjectFailure();
    expect(await journal.read()).toHaveLength(0);

    await writeFile(configPath, '{"version":1}');
    await store.getState().retryProjects(store.getState().selection);
    expect(requests).toHaveLength(2);
    const fresh = requests[1];
    expect(fresh?.operationId).not.toBe(first.operationId);
    expect(fresh?.retryWorkspaceIds).toBeUndefined();
    expect(store.getState().operation?.projects[0]?.outcome).toBe('moved');
    expect(store.getState().conversionFailure).toBeNull();
    expect(promote).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(2);
    expect(await journal.read()).toHaveLength(1);
  } finally {
    store.getState().dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it('returns lightweight rows before repository eligibility is checked', async () => {
  jest.useFakeTimers();
  try {
    const unused = (): never => {
      throw new Error('Unexpected mutation');
    };
    const project = {
      workspaceId: 'healthy',
      name: 'Healthy',
      kind: 'single-repo' as const,
      path: '/workspace',
    };
    const multi = {
      workspaceId: 'bundle',
      name: 'Bundle',
      kind: 'multi-repo' as const,
      path: '/bundle',
    };
    let slowDiscovery = false;
    const owned = {
      ...project,
      workspaceId: 'team-owned',
      owner: { organizationId, projectId: 'owned-project' },
    };
    const rowsForDiscovery = [project, multi, owned];
    const workspaces = jest.fn(() => Promise.resolve(rowsForDiscovery));
    const previewProjects = jest.fn(() => {
      const projects = [project, multi].map(({ workspaceId, name, kind }) => ({
        workspaceId,
        name,
        kind,
      }));
      return slowDiscovery
        ? new Promise<typeof projects>((resolve) =>
            setTimeout(() => resolve(projects), 10_000),
          )
        : Promise.resolve(projects);
    });
    const identity = jest.fn(() =>
      Promise.resolve({
        accountId: 'account',
        epoch: 0,
        credentials: { baseUrl: 'https://example.test', apiKey: 'fixture' },
      }),
    );
    const service = createPersonalOrganizationUpgradeService({
      identity,
      workspaces,
      previewProjects,
      destination: unused,
      promote: unused,
      suppress: unused,
      refreshAccount: unused,
      switchContext: unused,
      invite: unused,
      inviteStatus: unused,
      createSingle: unused,
      createMulti: unused,
      share: unused,
      refreshCatalog: unused,
      journal: { read: unused, update: unused, remove: unused },
      now: unused,
    });
    mockList.mockImplementation((...args) => service.list(...args));
    const list = handlers.get(IPC_CHANNELS.personalOrganizationUpgradeList);
    if (!list) throw new Error('Missing project list handler');
    const rows = [
      {
        workspaceId: project.workspaceId,
        name: project.name,
        kind: project.kind,
      },
      { workspaceId: multi.workspaceId, name: multi.name, kind: multi.kind },
    ];
    await expect(list(undefined)).resolves.toEqual({ projects: rows });
    expect(workspaces).not.toHaveBeenCalled();
    slowDiscovery = true;
    const native = expect(Promise.resolve(list(undefined))).rejects.toThrow(
      'Loading projects took too long.',
    );
    await jest.advanceTimersByTimeAsync(9_000);
    await native;
    const callsAtTimeout = identity.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(previewProjects).toHaveBeenCalledTimes(2);
    expect(identity).toHaveBeenCalledTimes(callsAtTimeout);
    slowDiscovery = false;
    await expect(list(undefined)).resolves.toEqual({ projects: rows });
    expect(previewProjects).toHaveBeenCalledTimes(3);
    slowDiscovery = true;
    const portal = expect(service.list(undefined, false)).resolves.toEqual({
      projects: rows,
    });
    await jest.advanceTimersByTimeAsync(10_000);
    await portal;
    expect(previewProjects).toHaveBeenCalledTimes(4);
    expect(workspaces).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

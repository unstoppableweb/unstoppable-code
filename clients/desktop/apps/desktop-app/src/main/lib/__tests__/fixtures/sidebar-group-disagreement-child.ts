// Source-composed owner replacement; the parent owns authority and fault barriers.
import { connectCanopyClient } from '@canopy/core-client/node';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import { W5_RECORD_TEST_AUTH } from '@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-daemon-record-harness';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransport,
} from '../../w5-daemon-record-store';
import {
  initializeSidebarItemGroups,
  sidebarItemGroupsService,
  projectSidebarItemGroups,
} from '../../../services/sidebar-item-groups-service';
import { onSidebarItemGroupsChanged } from '../../sidebar-item-groups';
import { subscribeWorktreeLifecycleChanges } from '../../worktree-lifecycle-signals';
import {
  onWorkEntryListChanged,
  updateWorkEntryRegistry,
} from '../../cowork-work-entries';
import {
  readWorkspaceWorktrees,
  updateWorkspaceWorktrees,
} from '../../workspace-persistence';
import { reconcileGitPendingWorktrees } from '../../worktree-boot-recovery';
import { registerWorkspaceTypes } from '../../workspace-registry';
import { W5RevisionConflictError } from '../../w5-commit-log-file-store';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { scheduleDesktopStructureChanged } from '../../../services/desktop-structure-signal';
import * as AtomicFile from '../../atomic-file';
import {
  disagreementModeSchema,
  snapshot,
} from './sidebar-group-recovery-harness';

jest.mock('../../../observability', () => ({
  getObservabilityService: (): {
    recordAppDiagnostic: () => void;
    recordUsageMetricEvent: () => void;
  } => ({
    recordAppDiagnostic: (): void => undefined,
    recordUsageMetricEvent: (): void => undefined,
  }),
}));
jest.mock('../../../services/desktop-structure-signal', () => ({
  scheduleDesktopStructureChanged: jest.fn(),
}));

const ownedTest = process.env.CAN4477_CHILD ? test : test.skip;
ownedTest(
  'owned disagreement main role',
  async () => {
    const root = process.env.CANOPY_DATA_DIR;
    const socket = process.env.CAN4477_SOCKET;
    const ipcProcess = process.getBuiltinModule('process');
    if (!root || !socket || !ipcProcess.send)
      throw new Error('Parent required');
    const send = ipcProcess.send.bind(ipcProcess);
    const scenario = disagreementModeSchema.parse(process.env.CAN4477_SCENARIO);
    const restart = process.env.CAN4477_CHILD === 'restart';
    const entries = scenario.startsWith('entry-');
    const second = scenario.endsWith('second-write');
    const cleanup = scenario.endsWith('cleanup-write');
    const future = scenario.endsWith('rollback-future');
    const rollback = !second && !cleanup;
    const raw = (): ReturnType<typeof snapshot> =>
      snapshot(root, entries, future);
    const signals = { group: 0, lifecycle: 0, entry: 0 };
    const attempts: string[] = [];
    const installed: string[] = [];
    const queueProbes: Promise<void>[] = [];
    let queueObserved = false;
    let armed = !restart;
    const checkpoint = async (
      name: string,
      extra: object = {},
    ): Promise<void> => {
      const continued = new Promise<void>((resolve, reject) => {
        ipcProcess.once('message', (message) => {
          if (message === 'continue') resolve();
          else reject(new Error('Unexpected barrier release'));
        });
      });
      send({
        checkpoint: name,
        pid: process.pid,
        snapshot: await raw(),
        signals: { ...signals },
        attempts: [...attempts],
        installed: [...installed],
        portalSync: jest.mocked(scheduleDesktopStructureChanged).mock.calls
          .length,
        ...extra,
      });
      await continued;
    };
    const removeGroup = onSidebarItemGroupsChanged(() => signals.group++);
    const removeLifecycle = subscribeWorktreeLifecycleChanges(
      () => signals.lifecycle++,
    );
    const removeEntry = onWorkEntryListChanged(() => {
      signals.entry++;
      // Re-enter the owner queue: failure invalidation cannot hold that queue.
      queueProbes.push(
        updateWorkEntryRegistry('project', (rows) => {
          queueObserved = true;
          return Promise.resolve(rows);
        }),
      );
    });
    const client = await connectCanopyClient({
      endpoint: { kind: 'socket', path: socket, auth: W5_RECORD_TEST_AUTH },
      clientName: 'can4477-main-role',
      clientVersion: '1',
      definitions: {
        queries: CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
        instructions: {
          ...CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
          ...CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
        },
        streams: {},
      },
    });
    await client.instruction('core.client.lease.acquire', {
      clientInstanceId: 'cli-subprocess',
      interfaceKind: 'cli',
      label: 'CAN-4477 disagreement main role',
      interactive: false,
      foreground: false,
      renewalIntervalMs: 300_000,
      _meta: { idempotencyKey: `lease-${process.pid}` },
    });
    const transport = w5RecordPortTransport(client);
    const restore = installW5DaemonRecordStoreForTests(
      createW5DaemonRecordStore({
        root: `${root}/workspaces`,
        transport: {
          ...transport,
          commit: async (request) => {
            if (
              armed &&
              !entries &&
              !cleanup &&
              request.files.some(
                ({ target }) =>
                  target.kind === 'worktrees' &&
                  target.workspaceId === 'project',
              )
            ) {
              armed = false;
              try {
                // Exercise the current daemon's real revision refusal, not an owner mock.
                return await transport.commit({
                  ...request,
                  expectedRevisions: [
                    {
                      resource: { kind: 'worktrees', workspaceId: 'project' },
                      revision: 99,
                    },
                  ],
                });
              } finally {
                await checkpoint('F');
              }
            }
            return transport.commit(request);
          },
        },
      }),
    );
    const atomic = AtomicFile.writeFileAtomically;
    const rename = AtomicFile.renameWithRetry;
    const atomicSpy = jest
      .spyOn(AtomicFile, 'writeFileAtomically')
      .mockImplementation(async (...args) => {
        if (!args[0].endsWith('/sidebar-item-groups.json'))
          return atomic(...args);
        attempts.push('sidecar');
        if (
          !restart &&
          !future &&
          ((entries && second) ||
            cleanup ||
            (rollback && attempts.length === 2))
        ) {
          if (!rollback) {
            armed = false;
            await checkpoint('F');
          }
          throw Object.assign(
            new Error('CAN4477 sidecar ENOSPC before installation'),
            { code: 'ENOSPC' },
          );
        }
        await atomic(...args);
        installed.push('sidecar');
      });
    const renameSpy = jest
      .spyOn(AtomicFile, 'renameWithRetry')
      .mockImplementation(async (...args) => {
        if (
          armed &&
          entries &&
          rollback &&
          args[1].endsWith('/work-entries.json')
        ) {
          armed = false;
          await checkpoint('F');
          throw Object.assign(
            new Error('CAN4477 registry EACCES before installation'),
            { code: 'EACCES' },
          );
        }
        return rename(...args);
      });
    registerWorkspaceTypes(
      new Map([['project', entries ? 'cowork' : 'single-repo']]),
    );
    initializeSidebarItemGroups();
    const noop = async (): Promise<void> => {
      if (entries)
        await updateWorkEntryRegistry('project', (rows) =>
          Promise.resolve(rows),
        );
      else await updateWorkspaceWorktrees('project', (rows) => rows);
    };
    try {
      if (!restart) {
        let failure: unknown;
        let receipt = false;
        try {
          if (second) {
            await sidebarItemGroupsService.moveItem({
              scope: { workspaceLocalId: 'project' },
              itemId: 'incoming',
              groupId: 'grp-review',
            });
          } else if (entries) {
            await updateWorkEntryRegistry(
              'project',
              (rows) =>
                Promise.resolve(
                  cleanup
                    ? rows.filter((row) => row.id !== 'existing')
                    : [
                        ...rows,
                        {
                          id: 'phantom',
                          createdAt: '2026-11-14T00:00:00.000Z',
                        },
                      ],
                ),
              rollback
                ? { newItemId: 'phantom', sidebarItemGroupId: 'grp-review' }
                : undefined,
            );
          } else {
            await updateWorkspaceWorktrees(
              'project',
              (rows) =>
                cleanup
                  ? rows.filter((row) => row.id !== 'existing')
                  : [
                      ...rows,
                      {
                        id: 'phantom',
                        branchName: 'phantom',
                        createdAt: '2026-11-14T00:00:00.000Z',
                        setupPhase: 'git-ready',
                      },
                    ],
              rollback
                ? {
                    newItemId: 'phantom',
                    sidebarItemGroupId: 'grp-review',
                    requireAuthoritativeRead: true,
                  }
                : undefined,
            );
          }
          receipt = true;
        } catch (error) {
          failure = error;
        }
        expect(armed).toBe(false);
        expect(receipt).toBe(false);
        expect(failure).toBeInstanceOf(Error);
        const errors =
          failure instanceof Error &&
          'errors' in failure &&
          Array.isArray(failure.errors)
            ? failure.errors.map((error: unknown) =>
                error instanceof Error
                  ? { name: error.name, message: error.message }
                  : { message: String(error) },
              )
            : undefined;
        if (rollback) {
          expect(errors).toHaveLength(2);
          if (entries)
            expect(errors?.[0]?.message).toContain('registry EACCES');
          else expect(errors?.[0]?.name).toBe('W5RevisionConflictError');
          expect(errors?.[1]?.message).toContain(
            future
              ? 'Unsupported sidebar item groups version: 99'
              : 'sidecar ENOSPC',
          );
        } else if (!entries && second)
          expect(failure).toBeInstanceOf(W5RevisionConflictError);
        else expect(String(failure)).toContain('sidecar ENOSPC');
        await Promise.all(queueProbes);
        await checkpoint('C', {
          error: String(failure),
          errors,
          receipt,
          queueObserved,
        });
        if (process.env.CAN4477_NOOP === '1') {
          const beforeNoop = await raw();
          await noop();
          expect(await raw()).toEqual(beforeNoop);
          await checkpoint('N');
        }
      } else {
        const beforeStartup = await raw();
        await reconcileGitPendingWorktrees();
        const beforeNoop = await raw();
        // The same no-op publishes a live marker at N, but must not inherit one.
        await noop();
        expect(await raw()).toEqual(beforeNoop);
        expect(signals).toEqual({ group: 0, lifecycle: 0, entry: 0 });
        expect(attempts).toEqual([]);
        await checkpoint('R', { beforeStartup, startupNoop: true });
        const beforeProjection = await raw();
        const projected = await projectSidebarItemGroups(
          { workspaceLocalId: 'project' },
          entries
            ? undefined
            : {
                worktrees: await readWorkspaceWorktrees('project', {
                  persistRemovalCleanup: false,
                }),
                groupChildBranchesWithBase: false,
              },
        );
        expect(await raw()).toEqual(beforeProjection);
        const writesBeforeRepair = attempts.length;
        let groups: unknown;
        let repairError: string | undefined;
        try {
          groups = await sidebarItemGroupsService.list({
            workspaceLocalId: 'project',
          });
        } catch (error) {
          expect(future).toBe(true);
          expect(String(error)).toContain(
            'Unsupported sidebar item groups version: 99',
          );
          repairError = String(error);
        }
        await Promise.all(queueProbes);
        await checkpoint('P', {
          projected,
          groups,
          repairError,
          repairWrites: attempts.length - writesBeforeRepair,
        });
      }
      await settleDetachedWork();
    } finally {
      atomicSpy.mockRestore();
      renameSpy.mockRestore();
      removeGroup();
      removeLifecycle();
      removeEntry();
      restore();
      await client.close();
    }
  },
  45_000,
);

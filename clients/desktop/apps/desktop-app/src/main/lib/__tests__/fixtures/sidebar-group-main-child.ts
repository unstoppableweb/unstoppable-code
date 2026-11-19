// Source-composed main role, not packaged Electron. A separate Jest process
// supplies only unrelated host shims; the group/list owners and boot recovery
// are production modules. Never run this entry without its parent gate.
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
import { applyWorktreeCreationReservation } from '../../worktree-creation-decision-port';
import { reconcileGitPendingWorktrees } from '../../worktree-boot-recovery';
import {
  initializeSidebarItemGroups,
  projectSidebarItemGroups,
  sidebarItemGroupsService,
} from '../../../services/sidebar-item-groups-service';
import { onSidebarItemGroupsChanged } from '../../sidebar-item-groups';
import { subscribeWorktreeLifecycleChanges } from '../../worktree-lifecycle-signals';
import { registerWorkspaceTypes } from '../../workspace-registry';
import { getWorktreeDir } from '../../paths';
import {
  readWorkspaceWorktrees,
  updateWorkspaceWorktrees,
} from '../../workspace-persistence';
import { applyWorktreeCreationReservationTo } from '../../worktree-record-decision-apply';
import type { WorktreeCreationReservationDecision } from '../../worktree-record-decisions';
import {
  commitW5BoundaryStep,
  w5CompositionLocks,
} from '../../w5-composition-operation';
import { currentW5CommitScope } from '../../w5-commit-scope';
import {
  createW5DegradedStore,
  W5DaemonHandoffError,
} from '../../w5-handoff-store';
import { scheduleDesktopStructureChanged } from '../../../services/desktop-structure-signal';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  snapshot,
  appliedMode,
  refusedMode,
  composedMode,
  mainModeSchema,
} from './sidebar-group-recovery-harness';
import { W5CommitRefusedError } from '@canopy/core-runtime/node/w5/commit-log/errors';
import { W5RevisionConflictError } from '../../w5-commit-log-file-store';
import { createWorktreeFromSelection } from '../../worktree-creation';
import * as AtomicFile from '../../atomic-file';
import * as Git from '../../git';
import { parseWorktreeList } from '../../worktree-list-repository';

function isInitialReservation(contents: string | null): boolean {
  if (contents === null) return false;
  const parsed = parseWorktreeList(contents, 'project');
  return (
    parsed.authority === 'ok' &&
    parsed.worktrees.some(
      (row) =>
        row.id === 'reserved-topic' &&
        row.setupPhase === 'git-pending' &&
        row.creation?.phase === 'reserved' &&
        row.creation.state === 'pending',
    )
  );
}

// Creation stops at the reservation fault: isolate unrelated Git validation,
// but never stub group/list owners, operation reservations, or cleanup reads.
jest.mock('../../animals', () => ({
  generateUniqueAnimalName: (): string => 'reserved-topic',
}));
jest.mock('../../git', () => ({
  ...jest.requireActual<typeof Git>('../../git'),
  getRepoRootFromWorktree: (path: string): Promise<string> =>
    Promise.resolve(path),
  validateBranchName: (): Promise<boolean> => Promise.resolve(true),
  isBranchNameAvailable: (): Promise<boolean> => Promise.resolve(true),
  isRegisteredWorktreePath: (): Promise<boolean> => Promise.resolve(false),
  createWorktree: jest.fn(
    (): Promise<never> => Promise.reject(new Error('Unexpected Git effects')),
  ),
}));

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
jest.mock('../../code-graph-eager-seed', () => ({
  eagerSeedNewWorktreeCodeGraph: (): Promise<void> => Promise.resolve(),
}));

const ownedTest = process.env.CAN4477_CHILD ? test : test.skip;
ownedTest(
  'owned main role',
  async () => {
    const root = process.env.CANOPY_DATA_DIR;
    const socket = process.env.CAN4477_SOCKET;
    // Jest's VM process.send is inert; control IPC belongs to the real child.
    const ipcProcess = process.getBuiltinModule('process');
    if (!root || !socket || !ipcProcess.send)
      throw new Error('Parent required');
    const send = ipcProcess.send.bind(ipcProcess);
    const checkpoint = async (value: object): Promise<void> => {
      const continued = new Promise<void>((resolve, reject) => {
        ipcProcess.once('message', (message) => {
          if (message !== 'continue')
            reject(new Error('Unexpected barrier release'));
          else resolve();
        });
      });
      send(value);
      await continued;
    };
    const atomicWrites = jest.spyOn(AtomicFile, 'writeFileAtomically');
    const calls = {
      lookup: 0,
      reserve: 0,
      commit: 0,
      capture: 0,
      markRecovery: 0,
      release: 0,
    };
    const signals = { group: 0, lifecycle: 0 };
    const degradedCalls = { capture: 0, replace: 0 };
    const removeGroup = onSidebarItemGroupsChanged(() => signals.group++);
    const removeLifecycle = subscribeWorktreeLifecycleChanges(
      () => signals.lifecycle++,
    );
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
      label: 'CAN-4477 source main role',
      interactive: false,
      foreground: false,
      renewalIntervalMs: 300_000,
      _meta: { idempotencyKey: `lease-${process.pid}` },
    });
    const transport = w5RecordPortTransport(client);
    const mode = mainModeSchema.parse(process.env.CAN4477_CHILD);
    const scenario = mainModeSchema.parse(process.env.CAN4477_SCENARIO ?? mode);
    const callerCreation = async (): Promise<unknown> =>
      createWorktreeFromSelection({
        workspaceId: 'project',
        workspaceKind: 'single-repo',
        branch: { kind: 'new', branchName: 'topic' },
        base: { kind: 'repository-default' },
        sidebarItemGroupId: 'grp-review',
        deferGitSetup: true,
        ...(scenario.startsWith('keyed-')
          ? { idempotencyKey: 'can4477-key' }
          : {}),
      });
    let capturesAtFault: number | undefined;
    const postFaultCaptureRequests: Parameters<typeof transport.capture>[0][] =
      [];
    const captureTrace: Array<{
      request: Parameters<typeof transport.capture>[0];
      caller?: string;
    }> = [];
    let stagedAtReturn: Awaited<ReturnType<typeof snapshot>> | undefined;
    let stagedPaths: string[] = [];
    let outerBeforeDecision = 0;
    let armed = mode !== 'restart';
    const degradedStore = createW5DegradedStore(
      new W5DaemonHandoffError('daemon_unavailable', 'handoff-not-started'),
    );
    const restore = installW5DaemonRecordStoreForTests(
      mode === 'degraded-refusal'
        ? {
            ...degradedStore,
            capture: async (
              ...args: Parameters<NonNullable<typeof degradedStore.capture>>
            ): ReturnType<NonNullable<typeof degradedStore.capture>> => {
              degradedCalls.capture++;
              armed = false;
              await checkpoint({
                checkpoint: 'F',
                pid: process.pid,
                refusedMethod: 'capture',
                degradedCalls,
                groupWrites: atomicWrites.mock.calls.filter(([path]) =>
                  path.endsWith('/sidebar-item-groups.json'),
                ).length,
                snapshot: await snapshot(root),
                signals,
              });
              if (!degradedStore.capture)
                throw new Error('Missing degraded capture');
              return degradedStore.capture(...args);
            },
            replace: (...args): Promise<void> => {
              degradedCalls.replace++;
              return degradedStore.replace(...args);
            },
          }
        : createW5DaemonRecordStore({
            root: `${root}/workspaces`,
            transport: {
              ...transport,
              capture: async (request) => {
                calls.capture++;
                captureTrace.push({
                  request,
                  caller: new Error('CAN4477 capture caller').stack,
                });
                if (capturesAtFault !== undefined)
                  postFaultCaptureRequests.push(request);
                return transport.capture(request);
              },
              lookupReceipt: async (receipt) => {
                calls.lookup++;
                return transport.lookupReceipt(receipt);
              },
              markReservationRecoveryRequired: async (request) => {
                calls.markRecovery++;
                return transport.markReservationRecoveryRequired(request);
              },
              releaseReservation: async (id) => {
                calls.release++;
                return transport.releaseReservation(id);
              },
              reserve: async (request): Promise<void> => {
                calls.reserve++;
                if (
                  mode === 'keyed-reserve-refusal' ||
                  mode === 'keyed-reserve-lost'
                ) {
                  armed = false;
                  const reservationRequest =
                    mode === 'keyed-reserve-refusal'
                      ? { ...request, workspaceIdentity: 'project' }
                      : request;
                  try {
                    // A real occupied-identity refusal at the reservation authority.
                    await transport.reserve(reservationRequest);
                  } finally {
                    await checkpoint({
                      checkpoint: 'F',
                      pid: process.pid,
                      reservationRequest,
                      calls,
                      snapshot: await snapshot(root),
                      signals,
                    });
                  }
                  throw new Error('CAN4477 reserve reply lost');
                }
                return transport.reserve(request);
              },
              commit: async (request) => {
                calls.commit++;

                if (
                  armed &&
                  request.operation ===
                    (mode.startsWith('implicit-')
                      ? 'w5.worktree_list.write'
                      : 'core.worktree.create') &&
                  request.files.some(
                    ({ target, contents }) =>
                      target.kind === 'worktrees' &&
                      target.workspaceId === 'project' &&
                      isInitialReservation(contents),
                  )
                ) {
                  armed = false;
                  if (refusedMode(mode)) {
                    // The real authority refuses the future revision after the
                    // successful membership prewrite; no decision is saved.
                    try {
                      return await transport.commit(
                        mode === 'implicit-refusal'
                          ? {
                              ...request,
                              expectedRevisions: [
                                {
                                  resource: {
                                    kind: 'worktrees',
                                    workspaceId: 'project',
                                  },
                                  revision: 99,
                                },
                              ],
                            }
                          : request,
                      );
                    } finally {
                      await checkpoint({
                        checkpoint: 'F',
                        pid: process.pid,
                        request,
                        stagedAtReturn,
                        stagedPaths,
                        outerBeforeDecision,
                        snapshot: await snapshot(root),
                        signals,
                      });
                    }
                  }
                  if (
                    mode === 'saved-unapplied' ||
                    mode === 'application-failure'
                  ) {
                    let failure: unknown;
                    try {
                      const outcome = await transport.commit(request);
                      expect(mode).toBe('application-failure');
                      expect(outcome.status).toBe('recovery-required');
                      await checkpoint({
                        checkpoint: 'F',
                        pid: process.pid,
                        request,
                        outcome,
                        calls,
                        snapshot: await snapshot(root),
                        signals,
                      });
                      return outcome;
                    } catch (error) {
                      failure = error;
                    }
                    expect(failure).toBeDefined();
                    await checkpoint({
                      checkpoint: 'F',
                      pid: process.pid,
                      request,
                      workerError: String(failure),
                      calls,
                      snapshot: await snapshot(root),
                      signals,
                    });
                    throw failure instanceof Error
                      ? failure
                      : new Error(String(failure));
                  }
                  const outcome = appliedMode(mode)
                    ? await transport.commit(request)
                    : undefined;
                  capturesAtFault = calls.capture;
                  // Applied reply loss sits outside authority/event continuation.
                  // Absent-unknown instead drops delivery before authority arrival,
                  // indistinguishable to the caller from losing an applied reply.
                  if (outcome) expect(outcome.status).toBe('applied');
                  await checkpoint({
                    checkpoint: 'F',
                    pid: process.pid,
                    outcome,
                    request,
                    stagedAtReturn,
                    stagedPaths,
                    outerBeforeDecision,
                    snapshot: await snapshot(root),
                    signals,
                  });
                  throw new Error('CAN4477 outcome unknown');
                }
                return transport.commit(request);
              },
            },
          }),
    );
    registerWorkspaceTypes(new Map([['project', 'single-repo']]));
    initializeSidebarItemGroups();
    const readOnlyProjection = async (): Promise<unknown> => {
      const before = await snapshot(root);
      const worktrees = await readWorkspaceWorktrees('project', {
        persistRemovalCleanup: false,
      });
      const captures = {
        routed: calls.capture,
        degraded: degradedCalls.capture,
      };
      const writes = atomicWrites.mock.calls.length;
      const projection = await projectSidebarItemGroups(
        { workspaceLocalId: 'project' },
        {
          worktrees,
          groupChildBranchesWithBase: false,
        },
      );
      expect(projection?.[0]?.memberIds).toEqual(['existing']);
      expect({
        routed: calls.capture,
        degraded: degradedCalls.capture,
        extraCaptureCallers: captureTrace.slice(captures.routed),
      }).toEqual({ ...captures, extraCaptureCallers: [] });
      expect(atomicWrites.mock.calls).toHaveLength(writes);
      expect(await snapshot(root)).toEqual(before);
      return projection;
    };
    try {
      if (mode !== 'restart') {
        let error: string | undefined;
        let definitiveRefused = false;
        let recoveryRequired = false;
        let handoffRefusal: { reason: string; detail?: string } | undefined;
        try {
          const decision: WorktreeCreationReservationDecision = {
            kind: 'worktree.create.reserve',
            sidebarItemGroupId: 'grp-review',
            worktree: {
              id: 'reserved-topic',
              branchName: 'topic',
              createdAt: '2026-11-14T00:00:00.000Z',
              setupPhase: 'git-pending',
              creation: {
                operationId: 'can4477-create',
                state: 'pending',
                phase: 'reserved',
                checkouts: [
                  {
                    repositoryPath: `${root}/reference`,
                    checkoutPath: getWorktreeDir('project', 'reserved-topic'),
                  },
                ],
              },
            },
          };
          if (mode.startsWith('keyed-') || mode === 'unkeyed-lost-reply') {
            await callerCreation();
          } else if (
            mode.startsWith('implicit-') ||
            mode === 'degraded-refusal'
          ) {
            // No w5Commit option: replace still decides through the real store.
            await updateWorkspaceWorktrees(
              'project',
              (rows) => {
                const next = applyWorktreeCreationReservationTo(rows, decision);
                if ('refusal' in next)
                  throw new Error('Unexpected row refusal');
                return next.worktrees;
              },
              {
                requireAuthoritativeRead: true,
                sidebarItemGroupId: decision.sidebarItemGroupId,
                newItemId: decision.worktree.id,
              },
            );
          } else if (composedMode(mode)) {
            await commitW5BoundaryStep(
              {
                operation: 'core.worktree.create',
                beforeDecision: () => {
                  outerBeforeDecision++;
                },
                expectedRevisions:
                  mode === 'composed-refusal'
                    ? [
                        {
                          resource: {
                            kind: 'worktrees',
                            workspaceId: 'project',
                          },
                          revision: 99,
                        },
                      ]
                    : undefined,
              },
              w5CompositionLocks({ lists: ['project'] }),
              async () => {
                await applyWorktreeCreationReservation('project', decision, {});
                stagedAtReturn = await snapshot(root);
                stagedPaths = Array.from(
                  currentW5CommitScope()?.files.keys() ?? [],
                );
              },
            );
          } else {
            await applyWorktreeCreationReservation(
              'project',
              decision,
              mode === 'revision-refusal' ? { expectedRevision: 99 } : {},
            );
          }
        } catch (failure) {
          if (failure instanceof W5DaemonHandoffError)
            handoffRefusal = { reason: failure.reason, detail: failure.detail };
          recoveryRequired =
            failure instanceof W5CommitRefusedError &&
            failure.reason === 'recovery-required';
          definitiveRefused =
            mode === 'degraded-refusal'
              ? failure instanceof W5DaemonHandoffError
              : mode === 'keyed-reserve-refusal'
                ? failure instanceof W5CommitRefusedError &&
                  failure.reason === 'identity-conflict'
                : failure instanceof W5RevisionConflictError;
          error = failure instanceof Error ? failure.message : String(failure);
        }
        const projection =
          mode === 'application-failure' || mode === 'degraded-refusal'
            ? await readOnlyProjection()
            : undefined;
        expect(armed).toBe(false);
        if (refusedMode(mode)) expect(definitiveRefused).toBe(true);
        else if (mode === 'application-failure') {
          expect(recoveryRequired).toBe(true);
          expect(error).toContain('saved');
        } else if (mode === 'saved-unapplied') expect(error).toBeDefined();
        else if (mode === 'keyed-reserve-lost')
          expect(error).toContain('CAN4477 reserve reply lost');
        else expect(error).toContain('CAN4477 outcome unknown');
        await checkpoint({
          checkpoint: 'C',
          pid: process.pid,
          projection,
          captureTrace,
          error,
          recoveryRequired,
          handoffRefusal,
          degradedCalls,
          calls,
          postFaultCaptures:
            capturesAtFault === undefined ? 0 : calls.capture - capturesAtFault,
          postFaultCaptureRequests,
          groupWrites: atomicWrites.mock.calls.filter(([path]) =>
            path.endsWith('/sidebar-item-groups.json'),
          ).length,
          gitEffects: jest.mocked(Git.createWorktree).mock.calls.length,
          snapshot: await snapshot(root),
          signals,
          portalSync: jest.mocked(scheduleDesktopStructureChanged).mock.calls
            .length,
        });
      } else {
        const beforeStartup = await snapshot(root);
        await reconcileGitPendingWorktrees();
        await checkpoint({
          checkpoint: 'R',
          pid: process.pid,
          beforeStartup,
          snapshot: await snapshot(root),
          signals,
        });
        const projectedRows = await readWorkspaceWorktrees('project');
        let groups: unknown;
        let repairRefusal: W5CommitRefusedError['details'] | undefined;
        try {
          groups = await sidebarItemGroupsService.list({
            workspaceLocalId: 'project',
          });
        } catch (error) {
          expect(scenario).toBe('application-failure');
          expect(error).toBeInstanceOf(W5CommitRefusedError);
          if (!(error instanceof W5CommitRefusedError)) throw error;
          expect(error.reason).toBe('unapplied-change');
          repairRefusal = error.details;
        }

        if (repairRefusal) {
          await readOnlyProjection();
          // Neither an explicit edit nor ordinary lifecycle cleanup may install
          // a sidecar based on the same incomplete list.
          const attempts = [
            (): Promise<unknown> =>
              sidebarItemGroupsService.update({
                scope: { workspaceLocalId: 'project' },
                groupId: 'grp-review',
                name: 'Renamed',
              }),
            (): Promise<unknown> =>
              updateWorkspaceWorktrees(
                'project',
                (rows) => rows.map((row) => ({ ...row, pinned: true })),
                { requireAuthoritativeRead: true },
              ),
          ];
          for (const attempt of attempts) {
            let refused = false;
            try {
              await attempt();
            } catch (error) {
              expect(error).toBeInstanceOf(W5CommitRefusedError);
              if (!(error instanceof W5CommitRefusedError)) throw error;
              expect(error.reason).toBe('unapplied-change');
              expect(error.details).toEqual({ commitId: 1 });
              refused = true;
            }
            expect(refused).toBe(true);
          }
        }

        let repeatedError: string | undefined;
        let repeatedRefusal: W5CommitRefusedError['details'] | undefined;
        if (
          scenario === 'keyed-reserve-lost' ||
          scenario === 'keyed-lost-reply'
        ) {
          const callsBeforeRepeat = { ...calls };
          const writesBeforeRepeat = atomicWrites.mock.calls.length;
          const beforeRepeat = await snapshot(root);
          try {
            await callerCreation();
          } catch (error) {
            expect(error).toBeInstanceOf(W5CommitRefusedError);
            if (!(error instanceof W5CommitRefusedError)) throw error;
            expect(error.reason).toBe('recovery-required');
            repeatedRefusal = error.details;
            repeatedError = String(error);
          }
          expect(repeatedError).toContain('recovery');
          // A refusal at lookup must not enter reservation or creation work.
          expect(calls).toEqual({
            ...callsBeforeRepeat,
            lookup: callsBeforeRepeat.lookup + 1,
          });
          expect(atomicWrites.mock.calls).toHaveLength(writesBeforeRepeat);
          expect(jest.mocked(Git.createWorktree)).not.toHaveBeenCalled();
          expect(await snapshot(root)).toEqual(beforeRepeat);
        }
        await checkpoint({
          checkpoint: 'P',
          pid: process.pid,
          projectedRows,
          groups,
          repairRefusal,
          groupWrites: atomicWrites.mock.calls.filter(([path]) =>
            path.endsWith('/sidebar-item-groups.json'),
          ).length,
          repeatedError,
          repeatedRefusal,
          calls,
          snapshot: await snapshot(root),
          signals,
          portalSync: jest.mocked(scheduleDesktopStructureChanged).mock.calls
            .length,
        });
      }
      await settleDetachedWork();
    } finally {
      removeGroup();
      removeLifecycle();
      restore();
      await client.close();
    }
  },
  45_000,
);

import type * as Workers from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof Workers
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
import { startedWorkers } from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import { W5CommitLogHost } from '@canopy/core-runtime/node/w5/commit-log-host';
import { createW5CommitEventSource } from '@canopy/core-runtime/node/w5/commit-events';
import { startW5DaemonRecordHarness } from '@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-daemon-record-harness';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';
import { mkdir, mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshot,
  mainRole,
  logState,
  liveAuthority,
  appliedMode,
  refusedMode,
  composedMode,
  recoveryModes,
  disagreementModes,
  type Checkpoint,
  type LogState,
} from './fixtures/sidebar-group-recovery-harness';

jest.setTimeout(120_000);

test.each(recoveryModes)(
  '%s: grouped reservation, fresh main and repeated repair',
  async (mode) => {
    const applied = appliedMode(mode);
    const creationOperation = mode.startsWith('implicit-')
      ? 'w5.worktree_list.write'
      : 'core.worktree.create';
    const report: unknown[] = [];
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sg-')));
    const workspace = join(root, 'workspaces/project');
    const dbPath = join(root, 'w5/commit-log.sqlite');
    const socket = join(root, 's');
    let close: (() => Promise<void>) | undefined;
    let faultWorker =
      mode === 'saved-unapplied' || mode === 'application-failure';
    const start = async (): Promise<{
      host: W5CommitLogHost;
      events: ReturnType<typeof createW5CommitEventSource>;
      shutdown: () => Promise<void>;
    }> => {
      const host = new W5CommitLogHost({
        root: join(root, 'workspaces'),
        dataRoot: root,
        dbPath,
        workerEntry: join(
          __dirname,
          faultWorker
            ? mode === 'saved-unapplied'
              ? './fixtures/sidebar-group-saved-worker.ts'
              : './fixtures/sidebar-group-fault-worker.ts'
            : './fixtures/w5-commit-log-source-worker.ts',
        ),
      });
      const events = createW5CommitEventSource({
        host,
        epoch: `gate-${report.length}`,
      });
      const harness = await startW5DaemonRecordHarness({
        host: events.port(),
        portFor: (caller) =>
          events.port({ publishedBy: caller.clientInstanceId }),
      });
      close = async (): Promise<void> => {
        await harness.close();
        await shutdownW5BoundaryHost(host, dbPath);
        await rm(socket, { force: true });
      };
      await harness.listen(socket);
      await host.recoveryReport();
      return { host, events, shutdown: close };
    };
    try {
      const fullCreation =
        mode.startsWith('keyed-') || mode === 'unkeyed-lost-reply';
      await mkdir(
        join(
          workspace,
          fullCreation ? 'worktree-data' : 'worktree-data/reserved-topic',
        ),
        {
          recursive: true,
        },
      );
      // Keep the control row eligible: startup otherwise archives a git-ready
      // row whose checkout directory is missing, contaminating group repair.
      await mkdir(join(workspace, 'worktrees/existing'), { recursive: true });
      const seed = async (path: string, value: unknown): Promise<void> =>
        writeFile(path, JSON.stringify(value));
      await seed(join(root, 'workspaces/index.json'), {
        version: 1,
        workspaces: [
          {
            id: 'project',
            type: 'single-repo',
            name: 'Project',
            color: 'blue',
            collapsed: false,
            order: 0,
          },
        ],
      });
      await seed(join(workspace, 'workspace.json'), {
        version: 1,
        type: 'single-repo',
        repoPath: join(root, 'reference'),
      });
      await seed(join(workspace, 'worktrees.json'), {
        version: 1,
        worktrees: [
          {
            id: 'existing',
            branchName: 'main',
            createdAt: '2026-11-13T00:00:00.000Z',
            setupPhase: 'git-ready',
          },
        ],
      });
      const initialGroups = {
        version: 1,
        groups: [
          {
            id: 'grp-review',
            name: 'Review',
            color: 'neutral',
            collapsed: false,
            memberIds: ['existing'],
          },
        ],
      };
      const restoredSidecar = JSON.stringify(initialGroups, null, 2);
      await seed(join(workspace, 'sidebar-item-groups.json'), initialGroups);
      const initial = await snapshot(root);
      report.push({ initial });
      const { host, events } = await start();
      const fault = await mainRole(
        root,
        socket,
        mode,
        report,
        async ({ checkpoint }) => {
          if (mode === 'saved-unapplied') {
            if (checkpoint === 'F') {
              await shutdownW5BoundaryHost(host, dbPath);
              const exitCodes = startedWorkers
                .filter(
                  ({ workerData }) =>
                    typeof workerData === 'object' &&
                    workerData !== null &&
                    'dbPath' in workerData &&
                    workerData.dbPath === dbPath,
                )
                .map(({ exitCode }) => exitCode);
              report.push({ workerExitCodes: exitCodes });
              expect(exitCodes).toEqual([73]);
            }
            const offline = logState(dbPath);
            report.push({ checkpointAuthority: checkpoint, offline });
            expect(offline.decisions).toEqual([
              {
                commit_id: 1,
                operation: 'core.worktree.create',
                state: 'committed',
              },
            ]);
            const replay = events.journal.resume({
              daemonEpoch: events.journal.epoch,
              sequence: 0,
            });
            report.push({ checkpointEvents: checkpoint, replay });
            expect(replay.kind).toBe('replay');
            if (replay.kind === 'replay') {
              // Worker exit and its uncertain call each invalidate; neither is a commit.
              expect(replay.entries).toHaveLength(2);
              for (const { event } of replay.entries)
                expect(event).toMatchObject({
                  name: 'core.workspace.invalidated',
                  payload: { reason: 'uncertain' },
                  scope: {},
                });
            }
            return;
          }
          report.push({
            checkpointAuthority: checkpoint,
            ...(await liveAuthority(host)),
          });
          if (checkpoint !== 'F') return;
          const replay = events.journal.resume({
            daemonEpoch: events.journal.epoch,
            sequence: 0,
          });
          report.push({
            eventsAtF: replay,
            rawAtF: await snapshot(root),
          });
          if (mode === 'application-failure') {
            const unrelated = await host.capture({
              files: [{ kind: 'worktrees', workspaceId: 'unrelated' }],
              discoverWorkspaces: false,
            });
            report.push({ unrelatedCaptureAtF: unrelated });
            expect(unrelated.log.unresolvedCommits).toBe(1);
            expect(unrelated.log.files).toEqual([]);
          }
          expect(replay.kind).toBe('replay');
          if (replay.kind === 'replay')
            expect(
              replay.entries.filter(
                ({ event }) => event.name === 'core.workspace.committed',
              ),
            ).toHaveLength(applied ? 1 : 0);
        },
      );
      await close?.();
      close = undefined;
      const afterCommand = logState(dbPath);
      report.push({ offlineAfterC: afterCommand });
      expect(afterCommand.decisions).toEqual(
        applied
          ? [
              {
                commit_id: 1,
                operation: creationOperation,
                state: 'applied',
              },
            ]
          : mode === 'saved-unapplied' || mode === 'application-failure'
            ? [
                {
                  commit_id: 1,
                  operation: creationOperation,
                  state:
                    mode === 'saved-unapplied'
                      ? 'committed'
                      : 'recovery-required',
                },
              ]
            : [],
      );
      faultWorker = false;
      const runRestart = async (): Promise<{
        checkpoints: Checkpoint[];
        authority: LogState;
      }> => {
        const { host } = await start();
        const launch = await host.recoveryReport();
        report.push({ launch });
        if (mode === 'saved-unapplied')
          expect(launch.applied).toEqual(
            report.some(
              (entry) =>
                typeof entry === 'object' &&
                entry !== null &&
                'offlineAfterRepair' in entry,
            )
              ? []
              : [1],
          );
        const checkpoints = await mainRole(
          root,
          socket,
          'restart',
          report,
          async ({ checkpoint }) => {
            if (checkpoint !== 'R' && checkpoint !== 'P')
              throw new Error('Unexpected restart checkpoint');
            report.push({
              checkpointAuthority: checkpoint,
              ...(await liveAuthority(host)),
            });
          },
          mode,
        );
        await close?.();
        close = undefined;
        const authority = logState(dbPath);
        report.push({ offlineAfterRepair: authority });
        return { checkpoints, authority };
      };
      const { checkpoints: restart, authority: afterRepair } =
        await runRestart();
      const { checkpoints: repeat, authority: afterRepeat } =
        await runRestart();
      if (mode === 'application-failure') {
        expect(fault.map(({ checkpoint }) => checkpoint)).toEqual(['F', 'C']);
        expect(restart.map(({ checkpoint }) => checkpoint)).toEqual(['R', 'P']);
        expect(repeat.map(({ checkpoint }) => checkpoint)).toEqual(['R', 'P']);
        expect(
          new Set([fault[0]?.pid, restart[0]?.pid, repeat[0]?.pid]).size,
        ).toBe(3);
        const prewrite = fault[0]?.snapshot.sidecar;
        expect(fault[0]?.snapshot.groups.groups[0]?.memberIds).toEqual([
          'existing',
          'reserved-topic',
        ]);
        for (const point of [...fault, ...restart, ...repeat]) {
          expect(point.snapshot.registry).toBe(initial.registry);
          expect(point.snapshot.sidecar).toBe(prewrite);
          expect(point.snapshot.metadata).toEqual(initial.metadata);
          expect(point.snapshot.checkouts).toEqual(initial.checkouts);
          expect(point.signals).toEqual({ group: 0, lifecycle: 0 });
        }
        for (const point of [restart[1], repeat[1]]) {
          expect(point?.repairRefusal).toEqual({ commitId: 1 });
          expect(point?.groupWrites).toBe(0);
          expect(point?.portalSync).toBe(0);
        }
        expect(afterRepair).toEqual(afterCommand);
        expect(afterRepeat).toEqual(afterCommand);
        // Only supported explicit maintenance applies this recorded failure.
        const { host: recoveryHost, shutdown } = await start();
        const recovery = await recoveryHost.retryRecoveryRequiredCommit(1);
        const recovered = await snapshot(root);
        report.push({
          manualRecovery: recovery,
          afterManualRecovery: recovered,
        });
        expect(recovery.status).toBe('applied');
        expect(recovered.rows.worktrees.map(({ id }) => id)).toContain(
          'reserved-topic',
        );
        expect(recovered.groups.groups[0]?.memberIds).toEqual([
          'existing',
          'reserved-topic',
        ]);
        expect(recovered.sidecar).toBe(prewrite);
        await shutdown();
        close = undefined;
        const converged = await runRestart();
        const convergedRepeat = await runRestart();
        expect(converged.checkpoints[1]?.repairRefusal).toBeUndefined();
        expect(convergedRepeat.checkpoints[1]?.repairRefusal).toBeUndefined();
        for (const point of [
          converged.checkpoints[1],
          convergedRepeat.checkpoints[1],
        ]) {
          expect(point?.groupWrites).toBe(0);
          expect(point?.signals).toEqual({ group: 0, lifecycle: 0 });
        }
        expect(converged.checkpoints[1]?.portalSync).toBe(2);
        expect(convergedRepeat.checkpoints[1]?.portalSync).toBe(1);
        expect(converged.checkpoints[1]?.snapshot).toEqual(
          convergedRepeat.checkpoints[0]?.snapshot,
        );
        expect(converged.checkpoints[1]?.snapshot).toEqual(
          convergedRepeat.checkpoints[1]?.snapshot,
        );
        expect(converged.authority).toEqual(convergedRepeat.authority);
        const recoveredRow = recovered.rows.worktrees.find(
          ({ id }) => id === 'reserved-topic',
        );
        expect(recoveredRow?.creation).toMatchObject({
          state: 'pending',
          phase: 'reserved',
          operationId: 'can4477-create',
        });
        for (const point of [
          ...converged.checkpoints,
          ...convergedRepeat.checkpoints,
        ]) {
          expect(point.snapshot.sidecar).toBe(prewrite);
          const row = point.snapshot.rows.worktrees.find(
            ({ id }) => id === 'reserved-topic',
          );
          expect(row?.createdAt).toBe(recoveredRow?.createdAt);
          expect(row?.creation).toEqual({
            ...recoveredRow?.creation,
            state: 'recovery-required',
          });
        }
        expect(converged.authority.decisions).toEqual([
          { commit_id: 1, operation: 'core.worktree.create', state: 'applied' },
          {
            commit_id: 2,
            operation: 'w5.worktree_list.write',
            state: 'applied',
          },
        ]);
        expect(converged.authority.reservations).toEqual([]);
        return;
      }
      expect(fault.map(({ checkpoint }) => checkpoint)).toEqual(['F', 'C']);
      expect(restart.map(({ checkpoint }) => checkpoint)).toEqual(['R', 'P']);
      expect(repeat.map(({ checkpoint }) => checkpoint)).toEqual(['R', 'P']);
      expect(
        new Set([fault[0]?.pid, restart[0]?.pid, repeat[0]?.pid]).size,
      ).toBe(3);
      expect(restart[1]?.snapshot).toEqual(repeat[0]?.snapshot);
      expect(restart[1]?.snapshot).toEqual(repeat[1]?.snapshot);
      expect(afterRepeat).toEqual(afterRepair);
      expect(fault[1]?.portalSync).toBe(0);
      expect(fault[1]?.signals).toEqual({ group: 0, lifecycle: 0 });
      expect(repeat[1]?.signals).toEqual({ group: 0, lifecycle: 0 });
      expect(repeat[1]?.portalSync).toBe(1);
      if (mode === 'degraded-refusal') {
        // Unavailable inventory now refuses before prewrite, not at replace.
        expect(fault[0]?.refusedMethod).toBe('capture');
        expect(fault[0]?.degradedCalls).toEqual({ capture: 1, replace: 0 });
        expect(fault[1]?.degradedCalls).toEqual({ capture: 1, replace: 0 });
        expect(fault[1]?.handoffRefusal).toEqual({
          reason: 'daemon_unavailable',
          detail: 'handoff-not-started',
        });
        expect(fault[0]?.snapshot).toEqual(initial);
        expect(fault[1]?.snapshot).toEqual(initial);
        expect(fault[0]?.groupWrites).toBe(0);
        expect(fault[1]?.groupWrites).toBe(0);
        for (const point of [...restart, ...repeat]) {
          expect(point.snapshot.sidecar).toBe(initial.sidecar);
          expect(point.snapshot.groups).toEqual(initial.groups);
          expect(point.snapshot.metadata).toEqual(initial.metadata);
          expect(point.snapshot.checkouts).toEqual(initial.checkouts);
          expect(point.signals).toEqual({ group: 0, lifecycle: 0 });
        }
        expect(restart[1]?.groupWrites).toBe(0);
        expect(repeat[1]?.groupWrites).toBe(0);
        expect(restart[1]?.portalSync).toBe(1);
        expect(afterCommand).toEqual({
          decisions: [],
          revisions: [],
          reservations: [],
        });
        expect(afterRepair.decisions).toEqual([
          {
            commit_id: 1,
            operation: 'w5.worktree_list.write',
            state: 'applied',
          },
        ]);
        expect(afterRepair.reservations).toEqual([]);
        return;
      }
      if (mode.startsWith('keyed-reserve-')) {
        expect(fault[0]?.reservationRequest).toEqual(
          expect.objectContaining({
            operation: 'core.worktree.create',
            ...(mode === 'keyed-reserve-refusal'
              ? { workspaceIdentity: 'project' }
              : {}),
          }),
        );
        expect(fault[0]?.snapshot).toEqual(initial);
        expect(fault[1]?.snapshot).toEqual(initial);
        expect(fault[1]?.calls).toEqual(
          expect.objectContaining({
            reserve: 1,
            commit: 0,
            markRecovery: 0,
            release: 0,
          }),
        );
        expect(fault[1]?.groupWrites).toBe(0);
        expect(fault[1]?.gitEffects).toBe(0);
        expect(afterCommand.decisions).toEqual([]);
        expect(afterCommand.reservations).toHaveLength(
          mode === 'keyed-reserve-lost' ? 1 : 0,
        );
        if (mode === 'keyed-reserve-lost') {
          expect(afterCommand.reservations[0]?.state).toBe('reserved');
          expect(afterRepair.reservations[0]?.state).toBe('recovery-required');
          expect(afterRepair.reservations[0]?.reservation_id).toBe(
            afterCommand.reservations[0]?.reservation_id,
          );
          for (const point of [restart[1], repeat[1]])
            expect(point?.repeatedRefusal).toEqual({
              reservationId: afterCommand.reservations[0]?.reservation_id,
            });
        }
        expect(restart[1]?.snapshot.groups).toEqual(initial.groups);
        expect(restart[1]?.snapshot.sidecar).toBe(initial.sidecar);
        expect(restart[1]?.signals).toEqual({ group: 0, lifecycle: 0 });
        expect(restart[1]?.portalSync).toBe(1);
        expect(afterRepair.decisions).toEqual([
          {
            commit_id: 1,
            operation: 'w5.worktree_list.write',
            state: 'applied',
          },
        ]);
        if (mode === 'keyed-reserve-refusal')
          expect(afterRepair.reservations).toEqual([]);
        expect(repeat[1]?.snapshot).toEqual(restart[1]?.snapshot);
        expect(afterRepeat).toEqual(afterRepair);
        return;
      }
      if (mode === 'saved-unapplied') {
        expect(fault.map(({ checkpoint }) => checkpoint)).toEqual(['F', 'C']);
        expect(fault[0]?.snapshot.groups.groups[0]?.memberIds).toEqual([
          'existing',
          'reserved-topic',
        ]);
        expect(fault[1]?.snapshot.sidecar).toBe(fault[0]?.snapshot.sidecar);
        expect(fault[1]?.calls).toEqual(fault[0]?.calls);
        expect(fault[0]?.snapshot.registry).toBe(initial.registry);
        expect(restart[1]?.snapshot).toEqual(repeat[1]?.snapshot);
        expect(afterRepeat).toEqual(afterRepair);
        expect(
          restart[0]?.snapshot.rows.worktrees.find(
            ({ id }) => id === 'reserved-topic',
          )?.creation?.state,
        ).toBe('recovery-required');
        expect(fault[1]?.snapshot.registry).toBe(initial.registry);
        expect(restart[0]?.beforeStartup?.groups).toEqual(
          fault[0]?.snapshot.groups,
        );
        expect(
          restart[0]?.beforeStartup?.rows.worktrees.find(
            ({ id }) => id === 'reserved-topic',
          )?.creation,
        ).toMatchObject({
          state: 'pending',
          phase: 'reserved',
          operationId: 'can4477-create',
        });
        expect(restart[1]?.portalSync).toBe(2);
        expect(restart[1]?.signals).toEqual({ group: 0, lifecycle: 0 });
        expect(fault[1]?.snapshot.metadata).toEqual(initial.metadata);
        expect(fault[1]?.snapshot.checkouts).toEqual(initial.checkouts);
        expect(restart[1]?.snapshot.sidecar).toBe(fault[0]?.snapshot.sidecar);
        expect(afterRepair.decisions).toEqual([
          { commit_id: 1, operation: 'core.worktree.create', state: 'applied' },
          {
            commit_id: 2,
            operation: 'w5.worktree_list.write',
            state: 'applied',
          },
        ]);
        expect(afterRepair.reservations).toEqual([]);
        expect(
          new Set([fault[0]?.pid, restart[0]?.pid, repeat[0]?.pid]).size,
        ).toBe(3);
        return;
      }
      expect(fault[0]?.snapshot.groups.groups[0]?.memberIds).toEqual([
        'existing',
        'reserved-topic',
      ]);
      const atFault = fault[0]?.snapshot;
      const settled = fault[1]?.snapshot;
      expect(atFault).toBeDefined();
      expect(settled).toBeDefined();
      if (!atFault || !settled) throw new Error('Missing fault checkpoints');
      expect(settled.registry).toBe(atFault.registry);
      if (composedMode(mode)) {
        // Inner staging returns before the outer decision; its catch cannot
        // observe a later refusal or lost reply.
        expect(fault[0]?.stagedAtReturn).toEqual({
          ...atFault,
          registry: initial.registry,
          rows: initial.rows,
        });
        expect(fault[0]?.stagedPaths).toEqual([
          join(workspace, 'worktrees.json'),
        ]);
        expect(fault[0]?.outerBeforeDecision).toBe(1);
      }
      expect(settled.rows.worktrees.map(({ id }) => id)).toEqual(
        applied ? ['reserved-topic', 'existing'] : ['existing'],
      );
      const rolledBack = refusedMode(mode) && !composedMode(mode);
      const expectedGroups = rolledBack ? initial.groups : atFault.groups;
      expect(settled.groups).toEqual(expectedGroups);
      expect(settled.sidecar).toBe(
        rolledBack ? restoredSidecar : atFault.sidecar,
      );
      expect(restart[0]?.snapshot.sidecar).toBe(settled.sidecar);
      if (applied) {
        const initialRow = atFault.rows.worktrees.find(
          ({ id }) => id === 'reserved-topic',
        );
        expect(initialRow?.creation).toMatchObject({
          state: 'pending',
          phase: 'reserved',
        });
        for (const point of [...restart, ...repeat]) {
          const recovered = point.snapshot.rows.worktrees.find(
            ({ id }) => id === 'reserved-topic',
          );
          expect(recovered?.createdAt).toBe(initialRow?.createdAt);
          expect(recovered?.creation).toEqual({
            ...initialRow?.creation,
            state: 'recovery-required',
          });
        }
        expect(restart[1]?.snapshot.groups).toEqual(atFault.groups);
        expect(restart[1]?.snapshot.sidecar).toBe(settled.sidecar);
        expect(
          restart[0]?.snapshot.rows.worktrees.find(
            ({ id }) => id === 'reserved-topic',
          )?.creation?.state,
        ).toBe('recovery-required');
      } else {
        expect(settled.registry).toBe(initial.registry);
        expect(restart[1]?.snapshot.groups).toEqual(initial.groups);
        expect(restart[1]?.snapshot.sidecar).toBe(restoredSidecar);
      }
      // Explicit list repair also backfills the initial control row's replica.
      expect(afterRepair.decisions).toEqual(
        applied
          ? [
              {
                commit_id: 1,
                operation: creationOperation,
                state: 'applied',
              },
              {
                commit_id: 2,
                operation: 'w5.worktree_list.write',
                state: 'applied',
              },
            ]
          : [
              {
                commit_id: 1,
                operation: 'w5.worktree_list.write',
                state: 'applied',
              },
            ],
      );
      if (mode === 'keyed-lost-reply') {
        expect(afterCommand.reservations).toHaveLength(1);
        expect(afterCommand.reservations[0]?.state).toBe('recovery-required');
        expect(afterRepair.reservations).toHaveLength(1);
        expect(afterRepair.reservations[0]?.reservation_id).toBe(
          afterCommand.reservations[0]?.reservation_id,
        );
        expect(afterRepair.reservations[0]?.state).toBe('recovery-required');
        expect(
          atFault.rows.worktrees.find(({ id }) => id === 'reserved-topic')
            ?.creation?.operationId,
        ).toBe(afterCommand.reservations[0]?.reservation_id);
        for (const point of [restart[1], repeat[1]])
          expect(point?.repeatedRefusal).toEqual({
            reservationId: afterCommand.reservations[0]?.reservation_id,
          });
        expect(fault[1]?.calls).toEqual(
          expect.objectContaining({
            reserve: 1,
            commit: 1,
            markRecovery: 1,
            release: 0,
          }),
        );
      } else expect(afterRepair.reservations).toEqual([]);
      expect(settled.metadata).toEqual(
        fullCreation ? ['reserved-topic'] : initial.metadata,
      );
      if (fullCreation) {
        expect(fault[1]?.groupWrites).toBe(1);
        expect(fault[1]?.gitEffects).toBe(0);
        if (mode === 'unkeyed-lost-reply') {
          expect(fault[1]?.postFaultCaptures).toBeGreaterThan(0);
          expect(fault[1]?.postFaultCaptureRequests).toContainEqual({
            files: [{ kind: 'worktrees', workspaceId: 'project' }],
            discoverWorkspaces: false,
          });
          expect(fault[1]?.calls).toEqual(
            expect.objectContaining({
              reserve: 0,
              commit: 1,
              markRecovery: 0,
              release: 0,
            }),
          );
        } else {
          expect(fault[1]?.postFaultCaptures).toBe(0);
          expect(fault[1]?.postFaultCaptureRequests).toEqual([]);
        }
      }
      expect(settled.checkouts).toEqual(initial.checkouts);
      expect(fault[1]?.signals).toEqual({ group: 0, lifecycle: 0 });
      expect(restart[1]?.signals).toEqual({
        group: !applied && (!refusedMode(mode) || composedMode(mode)) ? 1 : 0,
        lifecycle: 0,
      });
      expect(repeat[1]?.signals).toEqual({ group: 0, lifecycle: 0 });
      expect(fault[1]?.portalSync).toBe(0);
      expect(restart[1]?.portalSync).toBe(applied ? 2 : 1);
      expect(repeat[1]?.portalSync).toBe(1);
    } catch (error) {
      report.push({
        failure: error instanceof Error ? error.stack : String(error),
      });
      throw error;
    } finally {
      try {
        const evidenceDir = process.env.CAN4477_EVIDENCE_DIR;
        if (evidenceDir) {
          await mkdir(evidenceDir, { recursive: true });
          await writeFile(
            join(evidenceDir, `${mode}.json`),
            JSON.stringify(report, null, 2),
          );
        }
      } finally {
        try {
          await close?.();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
);

test.each(disagreementModes)(
  '%s: owner disagreement survives main replacement and repair converges',
  async (mode) => {
    const entries = mode.startsWith('entry-');
    const second = mode.endsWith('second-write');
    const cleanup = mode.endsWith('cleanup-write');
    const future = mode.endsWith('rollback-future');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sgd-')));
    const workspace = join(root, 'workspaces/project');
    const dbPath = join(root, 'w5/commit-log.sqlite');
    const socket = join(root, 's');
    const report: unknown[] = [];
    let close: (() => Promise<void>) | undefined;
    const stop = async (): Promise<void> => {
      await close?.();
      close = undefined;
    };
    const start = async (): Promise<W5CommitLogHost> => {
      const host = new W5CommitLogHost({
        root: join(root, 'workspaces'),
        dataRoot: root,
        dbPath,
        workerEntry: join(
          __dirname,
          './fixtures/w5-commit-log-source-worker.ts',
        ),
      });
      const events = createW5CommitEventSource({
        host,
        epoch: `disagreement-${report.length}`,
      });
      const harness = await startW5DaemonRecordHarness({
        host: events.port(),
        portFor: (caller) =>
          events.port({ publishedBy: caller.clientInstanceId }),
      });
      close = async (): Promise<void> => {
        await harness.close();
        await shutdownW5BoundaryHost(host, dbPath);
        await rm(socket, { force: true });
      };
      await harness.listen(socket);
      await host.recoveryReport();
      return host;
    };
    try {
      await mkdir(join(workspace, 'worktree-data'), { recursive: true });
      for (const id of ['incoming', 'gap', 'existing'])
        await mkdir(join(workspace, 'worktrees', id), { recursive: true });
      const seed = async (path: string, value: unknown): Promise<void> =>
        writeFile(path, JSON.stringify(value));
      const type = entries ? 'cowork' : 'single-repo';
      await seed(join(root, 'workspaces/index.json'), {
        version: 1,
        workspaces: [
          {
            id: 'project',
            type,
            name: 'Project',
            color: 'blue',
            collapsed: false,
            order: 0,
          },
        ],
      });
      await seed(join(workspace, 'workspace.json'), {
        version: 1,
        type,
        repoPath: join(root, 'reference'),
        externalPath: workspace,
      });
      const rows = ['incoming', 'gap', 'existing'].map((id) => ({
        id,
        createdAt: '2026-11-13T00:00:00.000Z',
        ...(entries ? {} : { branchName: id, setupPhase: 'git-ready' }),
      }));
      await seed(
        join(workspace, entries ? 'work-entries.json' : 'worktrees.json'),
        { version: 1, ...(entries ? { entries: rows } : { worktrees: rows }) },
      );
      await seed(join(workspace, 'sidebar-item-groups.json'), {
        version: 1,
        groups: [
          {
            id: 'grp-review',
            name: 'Review',
            color: 'neutral',
            collapsed: false,
            memberIds: ['existing'],
          },
        ],
      });
      const initial = await snapshot(root, entries);
      const futureBytes = ` \r\n${JSON.stringify(
        { ...initial.groups, version: 99, futureField: 'preserve exactly' },
        null,
        '\t',
      )}\r\n`;
      report.push({ initial });
      const host = await start();
      const observeFault = async (point: Checkpoint): Promise<void> => {
        report.push({
          checkpointAuthority: point.checkpoint,
          ...(await liveAuthority(host)),
        });
        if (point.checkpoint === 'F' && future)
          await writeFile(
            join(workspace, 'sidebar-item-groups.json'),
            futureBytes,
          );
      };
      const fault = await mainRole(
        root,
        socket,
        mode,
        report,
        observeFault,
        mode,
        true,
      );
      await stop();
      const afterCommand = logState(dbPath);
      report.push({ afterCommand });
      expect(fault.map(({ checkpoint }) => checkpoint)).toEqual([
        'F',
        'C',
        'N',
      ]);
      const atFault = fault[0];
      const settled = fault[1];
      const noop = fault[2];
      if (!atFault || !settled || !noop)
        throw new Error('Missing owner checkpoints');
      const oldOrder = ['incoming', 'gap', 'existing'];
      const newOrder = ['gap', 'existing', 'incoming'];
      const order = cleanup
        ? ['incoming', 'gap']
        : entries && second
          ? newOrder
          : oldOrder;
      expect(atFault.snapshot.rows.worktrees.map(({ id }) => id)).toEqual(
        order,
      );
      expect(settled.snapshot.registry).toBe(atFault.snapshot.registry);
      expect(noop.snapshot).toEqual(settled.snapshot);
      expect(settled.receipt).toBe(false);
      expect(atFault.signals).toEqual({ group: 0, lifecycle: 0, entry: 0 });
      expect(atFault.portalSync).toBe(0);
      expect(settled.portalSync).toBe(!entries && cleanup ? 1 : 0);
      expect(noop.portalSync).toBe(settled.portalSync);
      expect(settled.signals).toEqual({
        group: 0,
        lifecycle: 0,
        entry: entries && (second || cleanup) ? 1 : 0,
      });
      expect(settled.queueObserved).toBe(entries && (second || cleanup));
      const members =
        second && !entries
          ? ['existing', 'incoming']
          : !second && !cleanup
            ? ['existing', 'phantom']
            : ['existing'];
      expect(atFault.snapshot.groups.groups[0]?.memberIds).toEqual(members);
      expect(settled.snapshot.sidecar).toBe(
        future ? futureBytes : atFault.snapshot.sidecar,
      );
      expect(settled.installed).toEqual(
        (!second && !cleanup) || (second && !entries) ? ['sidecar'] : [],
      );
      expect(settled.attempts).toEqual(
        mode.endsWith('rollback-write') ? ['sidecar', 'sidecar'] : ['sidecar'],
      );
      const pending = !cleanup && (!second || !entries);
      expect(noop.signals).toEqual({
        group: pending ? 1 : 0,
        lifecycle: 0,
        entry: entries && (second || cleanup) ? 1 : 0,
      });
      expect(afterCommand.decisions).toEqual(
        !entries && cleanup
          ? [
              {
                commit_id: 1,
                operation: 'w5.worktree_list.write',
                state: 'applied',
              },
            ]
          : [],
      );
      expect(afterCommand.reservations).toEqual([]);
      const replacedPids = [atFault.pid];
      if (pending) {
        // Separate trial: the no-op above consumes the pending marker. Recreate
        // the same fault, then replace main without any owner publication.
        await writeFile(
          join(workspace, 'sidebar-item-groups.json'),
          initial.sidecar,
        );
        const pendingHost = await start();
        report.push({ trial: 'replacement-without-publication' });
        const pendingFault = await mainRole(
          root,
          socket,
          mode,
          report,
          async (point) => {
            report.push({
              pendingTrialAuthority: point.checkpoint,
              ...(await liveAuthority(pendingHost)),
            });
            if (point.checkpoint === 'F' && future)
              await writeFile(
                join(workspace, 'sidebar-item-groups.json'),
                futureBytes,
              );
          },
        );
        expect(pendingFault.map(({ checkpoint }) => checkpoint)).toEqual([
          'F',
          'C',
        ]);
        const pendingCommand = pendingFault[1];
        if (!pendingCommand)
          throw new Error('Missing pending command checkpoint');
        replacedPids.push(pendingCommand.pid);
        expect(pendingCommand.installed).toEqual(settled.installed);
        expect(pendingCommand.attempts).toEqual(settled.attempts);
        expect(pendingCommand.snapshot).toEqual(settled.snapshot);
        expect(pendingFault[1]?.signals).toEqual({
          group: 0,
          lifecycle: 0,
          entry: 0,
        });
        await stop();
        expect(logState(dbPath)).toEqual(afterCommand);
      }
      const runRestart = async (): Promise<{
        points: Checkpoint[];
        authority: LogState;
      }> => {
        const restartedHost = await start();
        const points = await mainRole(
          root,
          socket,
          'restart',
          report,
          async (point) => {
            report.push({
              checkpointAuthority: point.checkpoint,
              ...(await liveAuthority(restartedHost)),
            });
            if (point.checkpoint !== 'R' || entries) return;
            const inventory = await restartedHost.capture({
              files: [{ kind: 'worktrees', workspaceId: 'project' }],
              discoverWorkspaces: false,
            });
            report.push({ repairInventory: inventory });
            expect(inventory.files).toEqual([
              {
                kind: 'worktrees',
                workspaceId: 'project',
                state: 'present',
                base64: Buffer.from(point.snapshot.registry).toString('base64'),
              },
            ]);
            expect(inventory.log.unresolvedCommits).toBe(0);
            for (const file of inventory.log.files)
              expect(file.state).toBe('applied');
          },
          mode,
        );
        await stop();
        const authority = logState(dbPath);
        report.push({ afterRepair: authority });
        return { points, authority };
      };
      const restart = await runRestart();
      const repeat = await runRestart();
      expect(restart.points.map(({ checkpoint }) => checkpoint)).toEqual([
        'R',
        'P',
      ]);
      expect(repeat.points.map(({ checkpoint }) => checkpoint)).toEqual([
        'R',
        'P',
      ]);
      expect(
        new Set([
          ...replacedPids,
          restart.points[0]?.pid,
          repeat.points[0]?.pid,
        ]).size,
      ).toBe(replacedPids.length + 2);
      for (const point of [restart.points[0], repeat.points[0]]) {
        expect(point?.startupNoop).toBe(true);
        expect(point?.signals).toEqual({ group: 0, lifecycle: 0, entry: 0 });
        expect(point?.attempts).toEqual([]);
        expect(point?.installed).toEqual([]);
      }
      expect(restart.points[0]?.snapshot.sidecar).toBe(
        settled.snapshot.sidecar,
      );
      const repaired = restart.points[1];
      if (!repaired) throw new Error('Missing repair checkpoint');
      expect(repaired.snapshot.rows.worktrees.map(({ id }) => id)).toEqual(
        order,
      );
      expect(repaired.repairWrites).toBe(!second && !future ? 1 : 0);
      expect(repaired.portalSync).toBe(!entries && !future ? 1 : 0);
      expect(repeat.points[1]?.portalSync).toBe(repaired.portalSync);
      if (second || future)
        expect(repaired.snapshot.sidecar).toBe(settled.snapshot.sidecar);
      expect(repaired.signals).toEqual({
        group: !second && !future ? 1 : 0,
        lifecycle: 0,
        entry: 0,
      });
      if (future) {
        expect(repaired.repairError).toContain(
          'Unsupported sidebar item groups version: 99',
        );
        expect(repaired.snapshot.sidecar).toBe(futureBytes);
        expect(repaired.projected).toBeUndefined();
      } else {
        expect(repaired.repairError).toBeUndefined();
        expect(repaired.snapshot.groups.groups).toEqual(
          cleanup
            ? []
            : [
                {
                  ...initial.groups.groups[0],
                  memberIds: second ? members : ['existing'],
                },
              ],
        );
        expect(repaired.projected).toEqual(repaired.snapshot.groups.groups);
      }
      expect(repeat.points[0]?.snapshot).toEqual(repaired.snapshot);
      expect(repeat.points[1]?.snapshot).toEqual(repaired.snapshot);
      expect(repeat.points[1]?.repairWrites).toBe(0);
      expect(repeat.points[1]?.signals).toEqual({
        group: 0,
        lifecycle: 0,
        entry: 0,
      });
      expect(repeat.authority).toEqual(restart.authority);
      expect(restart.authority.decisions).toEqual(
        entries || future
          ? []
          : [
              {
                commit_id: 1,
                operation: 'w5.worktree_list.write',
                state: 'applied',
              },
            ],
      );
      expect(restart.authority.reservations).toEqual([]);
      for (const point of [...fault, ...restart.points, ...repeat.points]) {
        expect(point.snapshot.metadata).toEqual(initial.metadata);
        expect(point.snapshot.checkouts).toEqual(initial.checkouts);
      }
    } catch (error) {
      report.push({
        failure: error instanceof Error ? error.stack : String(error),
      });
      throw error;
    } finally {
      try {
        const evidenceDir = process.env.CAN4477_EVIDENCE_DIR;
        if (evidenceDir) {
          await mkdir(evidenceDir, { recursive: true });
          await writeFile(
            join(evidenceDir, `${mode}.json`),
            JSON.stringify(report, null, 2),
          );
        }
      } finally {
        try {
          await stop();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
);

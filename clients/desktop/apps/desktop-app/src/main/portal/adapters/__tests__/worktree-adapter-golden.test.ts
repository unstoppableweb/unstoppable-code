import type * as LegacyStorage from '../../../lib/__tests__/fixtures/w5-legacy-storage';
// CAN-5527 (W5d2 O-7): `portal.worktree.update` and `portal.worktree.reorder`
// write through the unkeyed `updateWorktree` and `moveWorktree` boundaries,
// keeping the Portal's codes, messages, broadcasts, golden bytes, labels and
// revisions. A label set or cleared through the Portal is the user's: a
// generated label never replaces it. Create refusal mapping stays path-free.
// Real commit-log worker, filesystem and adapters, over both the in-process
// and the daemon-backed W5 store.
import { createW5BoundaryFixture } from '../../../lib/__tests__/fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from '../../../lib/__tests__/fixtures/w5-boundary-host';
import {
  installW5StoreSide,
  W5_STORE_SIDES,
} from '../../../lib/__tests__/fixtures/w5-store-sides';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';
import type { PortalWorktreeCreateRefusal } from '@canopy/protocol/portal';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type PortalCommandEnvelope,
  type PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type * as TsxWorkerThreads from '../../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
// W6g: the daemon side marks the W5 namespaces daemon-owned.
jest.mock('@canopy/core-runtime/storage', () =>
  jest
    .requireActual<
      typeof LegacyStorage
    >('../../../lib/__tests__/fixtures/w5-legacy-storage')
    .createLegacyW5StorageMock(),
);
const { setDaemonOwnedForTest } = jest.requireMock<{
  setDaemonOwnedForTest: (namespaceIds: readonly string[]) => void;
}>('@canopy/core-runtime/storage');
jest.mock('../../../agents/session-manager', () => ({
  getLiveBackgroundTasksForChat: jest.fn(),
  listLiveBackgroundTaskOwners: jest.fn(() => []),
  subscribeLiveBackgroundTasks: jest.fn(
    (): (() => void) => (): void => undefined,
  ),
}));
jest.mock('../../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
// Real exports are read on use: requiring them inside this factory re-enters it
// through the main-process import graph and hands some importers a second mock.
jest.mock('../../portal-event-bus', () => {
  const mocked = { notifyPortalStructureChanged: jest.fn() };
  return new Proxy(mocked, {
    get: (target, key): unknown =>
      key in target
        ? Reflect.get(target, key)
        : Reflect.get(
            jest.requireActual<object>('../../portal-event-bus'),
            key,
          ),
  });
});
jest.mock('../../../lib/desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
jest.mock('../../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

import { W5CommitLogHost } from '../../../w5-commit-log/commit-log-host';
import { __setDesktopW5FileStoreForTests } from '../../../lib/w5-commit-log-file-store';
import { nodeW5FileStore } from '../../../lib/w5-file-store';
import * as worktreeService from '../../../lib/worktree-service';
import { getWorktreeDir } from '../../../lib/paths';
import { beginChatTurnPreparation } from '../../../lib/chat-turn-preparation';
import {
  ChatStateService,
  getChatStateService,
  resetChatStateServiceForTests,
} from '../../../services/chat-state-service';
import { ChatStateV2Repository } from '../../../services/chat-state-v2-repository';
import { ChatQueueService } from '../../../services/chat-queue-service';
import {
  beginWorktreeGitSetup,
  type WorktreeGitSetupOutcome,
} from '../../../lib/worktree-git-setup';
import { WorktreeCreationRefusedError } from '../../../lib/worktree-creation-selection';
import { updateWorkspaceWorktrees } from '../../../lib/workspace-persistence';
import { writePreferencesFile } from '../../../lib/preferences-store';
import { READ_ONLY_SCOPE_ERROR } from '../../../lib/read-only-scope';
import { recordGeneratedWorktreeLabel } from '../../../lib/worktree-repair';
import { sendToWindow } from '../../../lib/window-send';
import { notifyPortalStructureChanged } from '../../portal-event-bus';
import type { PortalAdapterContext } from '../types';
import {
  handlePortalWorktreeCreate,
  handlePortalWorktreeReorder,
  handlePortalWorktreeUpdate,
} from '../worktree-adapter';

jest.setTimeout(90_000);
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;
let createdAt: string;
let originalDataDir: string | undefined;

const BRANCHES: Record<string, string> = {
  one: 'first',
  two: 'second',
  three: 'third',
  four: 'fourth',
};
const listPath = (): string => join(root, 'a', 'worktrees.json');
function images(): Record<string, string> {
  return Object.fromEntries(
    [
      join(root, 'index.json'),
      join(root, 'a', 'workspace.json'),
      listPath(),
    ].map((path) => [
      path,
      existsSync(path) ? readFileSync(path, 'utf8') : '<absent>',
    ]),
  );
}
const replicaListSchema = z.object({
  worktrees: z.array(z.object({ id: z.string(), replica: z.unknown() })),
});
let replicas: Map<string, unknown>;
/** The exact list bytes: each row's own fields in order, then its replica. */
function goldenList(
  rows: ReadonlyArray<{ id: string; fields?: Record<string, unknown> }>,
): string {
  return JSON.stringify(
    {
      version: 1,
      worktrees: rows.map(({ id, fields }) => ({
        id,
        branchName: BRANCHES[id],
        createdAt,
        ...fields,
        replica: replicas.get(id),
      })),
    },
    null,
    2,
  );
}
const RESOURCES: Record<string, W5Resource> = {
  list: { kind: 'worktrees', workspaceId: 'a' },
  one: { kind: 'worktree', workspaceId: 'a', worktreeId: 'one' },
  two: { kind: 'worktree', workspaceId: 'a', worktreeId: 'two' },
  three: { kind: 'worktree', workspaceId: 'a', worktreeId: 'three' },
  four: { kind: 'worktree', workspaceId: 'a', worktreeId: 'four' },
};
async function revisions(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    Object.entries(RESOURCES).map(
      async ([name, resource]) =>
        [name, await host.revision(resource)] as const,
    ),
  );
  return Object.fromEntries(entries);
}
/** Revisions after `beforeEach`'s replica-recording write. */
const SEEDED = { list: 0, one: 1, two: 1, three: 1, four: 1 };

type Outcome =
  | { kind: 'completed'; result: unknown }
  | {
      kind: 'failed';
      code: string;
      message: string;
      retryable?: boolean;
      refusal?: PortalWorktreeCreateRefusal;
    };
let outcomes: Outcome[];
const context: PortalAdapterContext = {
  getWindow: () => null,
  enqueueEvent: () => undefined,
  complete: (_command, result) => {
    outcomes.push({ kind: 'completed', result });
  },
  fail: (_command, code, message, retryable, details) => {
    outcomes.push({
      kind: 'failed',
      code,
      message,
      ...(retryable === undefined ? {} : { retryable }),
      ...(details?.refusal === undefined ? {} : { refusal: details.refusal }),
    });
  },
};
function command(
  type: 'portal.worktree.update' | 'portal.worktree.reorder',
  payload: Record<string, unknown>,
): PortalCommandEnvelope<unknown> {
  return {
    id: 'cmd-1',
    sequence: 1,
    type,
    payload,
    createdAt: '2026-07-10T00:00:00.000Z',
    expiresAt: null,
  };
}
const update = (payload: Record<string, unknown>): Promise<void> =>
  handlePortalWorktreeUpdate(
    command('portal.worktree.update', { workspaceId: 'a', ...payload }),
    context,
  );
const reorder = (payload: Record<string, unknown>): Promise<void> =>
  handlePortalWorktreeReorder(
    command('portal.worktree.reorder', { workspaceId: 'a', ...payload }),
    context,
  );
const listCommits = (commits: jest.SpyInstance): unknown[] =>
  commits.mock.calls
    .filter(([request]: Parameters<W5CommitLogHost['commit']>) =>
      request.files.some((file) => file.path === listPath()),
    )
    .map(([request]: Parameters<W5CommitLogHost['commit']>) => [
      request.operation,
      request.receipt,
      request.expectedRevisions,
    ]);
/** The persisted rows, replicas included, as the Portal broadcasts them. */
function persistedRows(): Array<Record<string, unknown>> {
  return z
    .object({ worktrees: z.array(z.record(z.string(), z.unknown())) })
    .parse(JSON.parse(readFileSync(listPath(), 'utf8'))).worktrees;
}

let teardownStoreSide = (): Promise<void> => Promise.resolve();

async function seed(side: (typeof W5_STORE_SIDES)[number]): Promise<void> {
  ({ dir, root } = createW5BoundaryFixture((incarnation) => {
    createdAt = incarnation;
    return [
      { id: 'one', branchName: 'first', createdAt, label: 'Old label' },
      { id: 'two', branchName: 'second', createdAt, hidden: true },
      { id: 'three', branchName: 'third', createdAt },
      { id: 'four', branchName: 'fourth', createdAt },
    ];
  }));
  dbPath = join(dir, 'data', 'w5', 'commit-log.sqlite');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(
      __dirname,
      '../../../lib/__tests__/fixtures/w5-commit-log-source-worker.ts',
    ),
  });
  teardownStoreSide = await installW5StoreSide(side, {
    host,
    root,
    setDaemonOwned: setDaemonOwnedForTest,
  });
  // The first list write records the rows' replica ids; later writes keep them.
  await updateWorkspaceWorktrees('a', (worktrees) => [...worktrees]);
  replicas = new Map(
    replicaListSchema
      .parse(JSON.parse(readFileSync(listPath(), 'utf8')))
      .worktrees.map((row) => [row.id, row.replica]),
  );
  outcomes = [];
  jest.clearAllMocks();
}
afterEach(async () => {
  jest.restoreAllMocks();
  await settleDetachedWork();
  await teardownStoreSide();
  teardownStoreSide = (): Promise<void> => Promise.resolve();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, dbPath);
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe.each(W5_STORE_SIDES)('over the %s store', (side) => {
  beforeEach(() => seed(side));

  describe('portal.worktree.update through updateWorktree', () => {
    it.each<
      [
        string,
        Record<string, unknown>,
        string,
        Record<string, unknown>,
        Record<string, number>,
      ]
    >([
      [
        'trims a label and hides',
        { worktreeId: 'three', label: '  My  label  ', hidden: true },
        'three',
        { label: 'My  label', hidden: true },
        { ...SEEDED, three: 2 },
      ],
      [
        'replaces a label',
        { worktreeId: 'one', label: 'New' },
        'one',
        { label: 'New' },
        { ...SEEDED, one: 2 },
      ],
      [
        'clears a null label',
        { worktreeId: 'one', label: null },
        'one',
        { labelSource: 'manual' },
        { ...SEEDED, one: 2 },
      ],
      [
        'clears an empty label',
        { worktreeId: 'one', label: '' },
        'one',
        { labelSource: 'manual' },
        { ...SEEDED, one: 2 },
      ],
      [
        'clears a blank label',
        { worktreeId: 'one', label: ' \t\n ' },
        'one',
        { labelSource: 'manual' },
        { ...SEEDED, one: 2 },
      ],
      [
        'sets a tracked base branch alone',
        { worktreeId: 'three', trackedBaseBranch: 'main' },
        'three',
        { trackedBaseBranch: 'main' },
        { ...SEEDED, three: 2 },
      ],
      [
        'labels a hidden row, keeping the omitted flag',
        { worktreeId: 'two', label: 'Named' },
        'two',
        { hidden: true, label: 'Named' },
        { ...SEEDED, two: 2 },
      ],
      [
        'hides a labelled row, keeping the omitted label',
        { worktreeId: 'one', hidden: true },
        'one',
        { label: 'Old label', hidden: true },
        { ...SEEDED, one: 2 },
      ],
      [
        'unhides, deleting the flag',
        { worktreeId: 'two', hidden: false },
        'two',
        {},
        { ...SEEDED, two: 2 },
      ],
    ])(
      '%s with golden bytes, revisions and broadcast',
      async (_name, payload, id, fields, expectedRevisions) => {
        const commits = jest.spyOn(host, 'commit');
        await update(payload);

        expect(outcomes).toEqual([
          { kind: 'completed', result: { success: true } },
        ]);
        const rows = [
          { id: 'one', fields: { label: 'Old label' } },
          { id: 'two', fields: { hidden: true } },
          { id: 'three' },
          { id: 'four' },
        ].map((row) => (row.id === id ? { id, fields } : row));
        expect(readFileSync(listPath(), 'utf8')).toBe(goldenList(rows));
        expect(await revisions()).toEqual(expectedRevisions);
        expect(listCommits(commits)).toEqual([
          ['core.worktree.update', undefined, undefined],
        ]);
        const row = persistedRows().find((worktree) => worktree.id === id);
        expect(jest.mocked(sendToWindow).mock.calls).toEqual([
          [
            null,
            IPC_CHANNELS.workspaceWorktreesUpdated,
            { workspaceId: 'a', worktree: row },
          ],
        ]);
        expect(notifyPortalStructureChanged).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      [
        'a label that matches after trimming',
        { worktreeId: 'one', label: ' Old label ' },
        'one',
      ],
      [
        'clearing an absent label',
        { worktreeId: 'three', label: '  ' },
        'three',
      ],
      ['hiding a hidden row', { worktreeId: 'two', hidden: true }, 'two'],
      ['unhiding a visible row', { worktreeId: 'four', hidden: false }, 'four'],
    ])(
      'completes %s without a write and broadcasts the stored row',
      async (_name, payload, id) => {
        const before = images();
        const commits = jest.spyOn(host, 'commit');
        await update(payload);

        expect(outcomes).toEqual([
          { kind: 'completed', result: { success: true } },
        ]);
        expect(images()).toEqual(before);
        expect(await revisions()).toEqual(SEEDED);
        expect(listCommits(commits)).toEqual([]);
        expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
        expect(jest.mocked(sendToWindow).mock.calls).toEqual([
          [
            null,
            IPC_CHANNELS.workspaceWorktreesUpdated,
            {
              workspaceId: 'a',
              worktree: persistedRows().find((worktree) => worktree.id === id),
            },
          ],
        ]);
      },
    );

    it('keeps a Portal label over a generated one, before and after it', async () => {
      await expect(
        recordGeneratedWorktreeLabel({
          workspaceId: 'a',
          worktreeId: 'three',
          label: 'Cloud setup',
          provisional: true,
        }),
      ).resolves.toMatchObject({ status: 'recorded' });
      await expect(
        recordGeneratedWorktreeLabel({
          workspaceId: 'a',
          worktreeId: 'one',
          label: 'Cloud setup',
          provisional: false,
        }),
      ).resolves.toMatchObject({ status: 'unchanged' });
      expect(readFileSync(listPath(), 'utf8')).toBe(
        goldenList([
          { id: 'one', fields: { label: 'Old label' } },
          { id: 'two', fields: { hidden: true } },
          {
            id: 'three',
            fields: {
              label: 'Cloud setup',
              labelSource: 'generated',
              labelProvisional: true,
            },
          },
          { id: 'four' },
        ]),
      );

      await update({ worktreeId: 'three', label: 'Mine' });
      await expect(
        recordGeneratedWorktreeLabel({
          workspaceId: 'a',
          worktreeId: 'three',
          label: 'Cloud worktree setup failure',
          provisional: false,
        }),
      ).resolves.toMatchObject({ status: 'unchanged' });
      expect(outcomes).toEqual([
        { kind: 'completed', result: { success: true } },
      ]);
      expect(readFileSync(listPath(), 'utf8')).toBe(
        goldenList([
          { id: 'one', fields: { label: 'Old label' } },
          { id: 'two', fields: { hidden: true } },
          { id: 'three', fields: { label: 'Mine' } },
          { id: 'four' },
        ]),
      );
    });

    it('keeps not_found and its message for a missing row, writing nothing', async () => {
      const before = images();
      await update({ worktreeId: 'missing', hidden: true });

      expect(outcomes).toEqual([
        {
          kind: 'failed',
          code: 'not_found',
          message: 'Worktree to update was not found.',
        },
      ]);
      expect(images()).toEqual(before);
      expect(await revisions()).toEqual(SEEDED);
      expect(sendToWindow).not.toHaveBeenCalled();
    });

    it('refuses the read-only shared-container scope as forbidden', async () => {
      await handlePortalWorktreeUpdate(
        command('portal.worktree.update', {
          workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'one',
          hidden: true,
        }),
        context,
      );

      expect(outcomes).toEqual([
        {
          kind: 'failed',
          code: 'forbidden',
          message: READ_ONLY_SCOPE_ERROR,
          retryable: false,
        },
      ]);
      expect(sendToWindow).not.toHaveBeenCalled();
    });

    it('keeps the Portal payload checks ahead of the boundary', async () => {
      const before = images();
      await update({ worktreeId: 'one', label: 'Keep', pinned: true });
      await update({ worktreeId: 'one' });

      // Fields outside the Portal command are ignored, not refused.
      expect(outcomes).toEqual([
        { kind: 'completed', result: { success: true } },
        {
          kind: 'failed',
          code: 'invalid_payload',
          message:
            'Worktree update requires a string/null label and/or a boolean hidden value.',
        },
      ]);
      expect(readFileSync(listPath(), 'utf8')).toBe(
        goldenList([
          { id: 'one', fields: { label: 'Keep' } },
          { id: 'two', fields: { hidden: true } },
          { id: 'three' },
          { id: 'four' },
        ]),
      );
      expect(images()[join(root, 'index.json')]).toBe(
        before[join(root, 'index.json')],
      );
    });
  });

  describe('portal.worktree.create refusal mapping', () => {
    it('returns a checked-out managed worktree id without exposing its path', async () => {
      const checkoutPath = join(
        getWorktreeDir('a', 'one'),
        'repos',
        'repo-one',
      );
      const before = images();
      const create = jest
        .spyOn(worktreeService, 'createSingleRepoWorktree')
        .mockRejectedValue(
          new WorktreeCreationRefusedError(
            'branch-checked-out',
            `Branch "private-branch" is already checked out at ${checkoutPath}`,
            { checkoutPath },
          ),
        );
      const createCommand: PortalCommandEnvelope<
        PortalCommandPayloadMap['portal.worktree.create']
      > = {
        id: 'cmd-create',
        sequence: 1,
        type: 'portal.worktree.create',
        payload: { workspaceId: 'a' },
        createdAt: '2026-07-10T00:00:00.000Z',
        expiresAt: null,
      };

      await handlePortalWorktreeCreate(createCommand, context);

      expect(create).toHaveBeenCalledTimes(1);
      expect(outcomes).toEqual([
        {
          kind: 'failed',
          code: 'branch_checked_out',
          message: 'The branch is already checked out.',
          retryable: false,
          refusal: {
            reason: 'branch_checked_out',
            existingWorktreeId: 'one',
          },
        },
      ]);
      expect(JSON.stringify(outcomes)).not.toContain(checkoutPath);
      expect(JSON.stringify(outcomes)).not.toContain('private-branch');
      expect(images()).toEqual(before);
    });

    it('commits the first prompt while existing-branch Git is pending, then dispatches on readiness', async () => {
      const pendingWorktreeId = `pending-task-${side}`;
      const chatDir = join(dir, 'first-chat-state');
      const repository = new ChatStateV2Repository({
        resolvePaths: (): {
          tabs: string;
          archives: string;
          journal: string;
        } => ({
          tabs: join(chatDir, 'chats.json'),
          archives: join(chatDir, 'archives.json'),
          journal: join(chatDir, 'journal.jsonl'),
        }),
      });
      let settleSetup: (outcome: WorktreeGitSetupOutcome) => void = () =>
        undefined;
      const dispatched: string[] = [];
      let finishDispatch: () => void = () => undefined;
      const dispatchFinished = new Promise<void>((resolve) => {
        finishDispatch = resolve;
      });
      const serviceRef: { target?: ChatStateService } = {};
      const queue = new ChatQueueService({
        dispatch: (request): Promise<void> => {
          dispatched.push(request.userMessageId);
          finishDispatch();
          return Promise.resolve();
        },
        beginTurnPreparation: beginChatTurnPreparation,
        cancel: (): Promise<void> => Promise.resolve(),
        settleCancelledTurn: (): void => undefined,
        hasActiveProviderTurn: (): boolean => false,
        hasPendingProviderContinuation: (): boolean => false,
        persistRuntime: (
          queueTarget,
          ids,
          turnActive,
          mutation,
          rows,
          active,
        ): void | Promise<void> =>
          serviceRef.target?.reconcileHostQueue(
            queueTarget,
            ids,
            turnActive,
            mutation,
            rows,
            active,
          ),
        endDiscardedTurns: (queueTarget, requests): Promise<void> => {
          serviceRef.target?.endDiscardedQueuedTurns(queueTarget, requests);
          return Promise.resolve();
        },
        broadcast: (): void => undefined,
        createId: (): string => 'first-chat-queue-row',
        now: (): number => 1_786_104_000_000,
        schedule: (callback, delayMs): ReturnType<typeof setTimeout> =>
          setTimeout(callback, delayMs),
      });
      const chatState = new ChatStateService({
        repository,
        now: (): number => 1_786_104_000_000,
        createId: (): string => 'first-chat-event',
        submit: (request, origin, beforeImmediateDispatch): Promise<void> =>
          queue.submit(request, origin, beforeImmediateDispatch),
        worktreeSetupQueue: {
          hold: (target, turnUserMessageId): Promise<void> =>
            Promise.resolve(
              queue.holdForWorktreeSetup(target, turnUserMessageId),
            ),
          release: (target, options): Promise<void> =>
            Promise.resolve(queue.releaseWorktreeSetupHold(target, options)),
          takeHeld: (
            target,
            outcome,
          ): ReturnType<ChatQueueService['takeWorktreeSetupHeldSends']> =>
            queue.takeWorktreeSetupHeldSends(target, outcome),
        },
        onInputPickup: (): Promise<void> => Promise.resolve(),
        authorizeSend: (): Promise<void> => Promise.resolve(),
        recordDiagnostic: jest.fn(),
      });
      serviceRef.target = chatState;
      resetChatStateServiceForTests(chatState);
      const create = jest
        .spyOn(worktreeService, 'createSingleRepoWorktree')
        .mockImplementation((options) => {
          expect(options.existingBranch).toBe('existing');
          settleSetup = beginWorktreeGitSetup(
            options.workspaceId,
            pendingWorktreeId,
          );
          return Promise.resolve({
            id: pendingWorktreeId,
            branchName: 'existing',
            createdAt: '2026-07-10T00:00:00.000Z',
            setupPhase: 'git-pending',
          });
        });
      const createCommand: PortalCommandEnvelope<
        PortalCommandPayloadMap['portal.worktree.create']
      > = {
        id: 'cmd-first-chat',
        sequence: 1,
        type: 'portal.worktree.create',
        payload: {
          workspaceId: 'a',
          existingBranch: 'existing',
          firstChat: {
            chatId: 'first-chat',
            userMessageId: 'first-prompt',
            text: 'Start the task',
            providerType: 'claude',
            model: 'claude-opus-4-6',
          },
        },
        createdAt: '2026-07-10T00:00:00.000Z',
        expiresAt: null,
      };
      const origin: NonNullable<PortalAdapterContext['origin']> = {
        kind: 'external_agent',
        connectionId: '12345678-1234-4234-8234-123456789abc',
        clientName: 'Portal test client',
        verified: false,
        userId: 'abcdef12-3456-4234-8234-123456789abc',
      };
      const firstChatContext: PortalAdapterContext = {
        ...context,
        origin,
        chatStatePort: chatState,
        dispatchChatCommand: (request) => chatState.command(request),
      };

      try {
        await writePreferencesFile({
          deferredToolsWorktreeChatsEnabled: false,
        });
        await handlePortalWorktreeCreate(createCommand, firstChatContext);

        expect(create).toHaveBeenCalledTimes(1);
        expect(outcomes).toEqual([
          {
            kind: 'completed',
            result: expect.objectContaining({
              id: pendingWorktreeId,
              chat: {
                chatId: 'first-chat',
                userMessageId: 'first-prompt',
                delivery: 'queued',
              },
            }) as unknown,
          },
        ]);
        const state = await repository.getState(
          { projectId: 'a', worktreeId: pendingWorktreeId },
          { chatIds: ['first-chat'] },
        );
        const firstChatTab = state.tabsFile.tabs.find(
          (tab) => tab.id === 'first-chat',
        );
        expect(firstChatTab?.deferredToolsAllowed).toBe(false);
        expect(firstChatTab?.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'first-prompt',
              role: 'user',
              agentSent: origin,
            }),
          ]),
        );
        // The queued delivery above reads this same accessor.
        expect(
          getChatStateService().isAwaitingWorktreeSetup({
            projectId: 'a',
            worktreeId: pendingWorktreeId,
            chatId: 'first-chat',
            userMessageId: 'first-prompt',
          }),
        ).toBe(true);
        expect(dispatched).toEqual([]);

        const createOptions = create.mock.calls[0]?.[0];
        const onGitReady = createOptions?.onGitReady;
        if (!onGitReady)
          throw new Error('Git-ready callback was not installed');
        onGitReady({
          projectId: 'a',
          worktreeId: pendingWorktreeId,
          branchName: 'existing',
        });
        settleSetup('ready');
        await dispatchFinished;
        expect(dispatched).toEqual(['first-prompt']);
      } finally {
        settleSetup('ready');
        if (
          chatState.isAwaitingWorktreeSetup({
            projectId: 'a',
            worktreeId: pendingWorktreeId,
            chatId: 'first-chat',
            userMessageId: 'first-prompt',
          })
        ) {
          await dispatchFinished;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        queue.resetForTests();
        resetChatStateServiceForTests();
        await repository.drainAll();
      }
    });

    it('rejects a provider-only first chat before creating its worktree', async () => {
      const before = images();
      const create = jest
        .spyOn(worktreeService, 'createSingleRepoWorktree')
        .mockResolvedValue({
          id: 'provider-only-created',
          branchName: 'existing',
          createdAt,
          setupPhase: 'git-pending',
        });
      const createCommand: PortalCommandEnvelope<
        PortalCommandPayloadMap['portal.worktree.create']
      > = {
        id: 'cmd-provider-only-first-chat',
        sequence: 1,
        type: 'portal.worktree.create',
        payload: {
          workspaceId: 'a',
          existingBranch: 'existing',
          firstChat: {
            chatId: 'provider-only-chat',
            userMessageId: 'provider-only-prompt',
            text: 'Start the task',
            providerType: 'codex',
          },
        },
        createdAt: '2026-07-10T00:00:00.000Z',
        expiresAt: null,
      };

      await handlePortalWorktreeCreate(createCommand, context);

      expect(outcomes).toEqual([
        {
          kind: 'failed',
          code: 'invalid_payload',
          message: 'Invalid worktree create options.',
          retryable: false,
        },
      ]);
      expect(create).not.toHaveBeenCalled();
      expect(images()).toEqual(before);
    });

    it('completes task creation when its first chat cannot be created', async () => {
      const worktreeId = `first-chat-failed-${side}`;
      const create = jest
        .spyOn(worktreeService, 'createSingleRepoWorktree')
        .mockResolvedValue({
          id: worktreeId,
          branchName: 'existing',
          createdAt,
          setupPhase: 'git-pending',
        });
      const createCommand: PortalCommandEnvelope<
        PortalCommandPayloadMap['portal.worktree.create']
      > = {
        id: 'cmd-first-chat-failed',
        sequence: 1,
        type: 'portal.worktree.create',
        payload: {
          workspaceId: 'a',
          existingBranch: 'existing',
          firstChat: {
            chatId: 'failed-chat',
            userMessageId: 'failed-prompt',
            text: 'Start the task',
            providerType: 'claude',
            model: 'claude-opus-4-6',
          },
        },
        createdAt: '2026-07-10T00:00:00.000Z',
        expiresAt: null,
      };
      const firstChatContext: PortalAdapterContext = {
        ...context,
        dispatchChatCommand: (): Promise<never> =>
          Promise.reject(new Error('private chat dispatch detail')),
      };

      await handlePortalWorktreeCreate(createCommand, firstChatContext);

      expect(create).toHaveBeenCalledTimes(1);
      expect(outcomes).toEqual([
        {
          kind: 'completed',
          result: {
            id: worktreeId,
            branchName: 'existing',
            createdAt,
            setupPhase: 'git-pending',
            chatError:
              'The task was created, but its first chat message could not be sent.',
          },
        },
      ]);
    });
  });

  describe('portal.worktree.reorder through moveWorktree', () => {
    it('moves a visible row, keeps the hidden slot, and broadcasts the list', async () => {
      const commits = jest.spyOn(host, 'commit');
      await reorder({ activeWorktreeId: 'four', overWorktreeId: 'one' });

      expect(outcomes).toEqual([
        {
          kind: 'completed',
          result: {
            workspaceId: 'a',
            activeWorktreeId: 'four',
            overWorktreeId: 'one',
          },
        },
      ]);
      expect(readFileSync(listPath(), 'utf8')).toBe(
        goldenList([
          { id: 'four' },
          { id: 'two', fields: { hidden: true } },
          { id: 'one', fields: { label: 'Old label' } },
          { id: 'three' },
        ]),
      );
      // Order is the list's; no row's fields changed.
      expect(await revisions()).toEqual({ ...SEEDED, list: 1 });
      expect(listCommits(commits)).toEqual([
        ['core.worktree.reorder', undefined, undefined],
      ]);
      expect(jest.mocked(sendToWindow).mock.calls).toEqual([
        [
          null,
          IPC_CHANNELS.workspaceWorktreesUpdated,
          { workspaceId: 'a', worktrees: persistedRows() },
        ],
      ]);
      expect(notifyPortalStructureChanged).toHaveBeenCalledTimes(1);
    });

    it('moves a row down past the hidden slot', async () => {
      await reorder({ activeWorktreeId: 'one', overWorktreeId: 'three' });

      expect(outcomes).toEqual([
        {
          kind: 'completed',
          result: {
            workspaceId: 'a',
            activeWorktreeId: 'one',
            overWorktreeId: 'three',
          },
        },
      ]);
      expect(readFileSync(listPath(), 'utf8')).toBe(
        goldenList([
          { id: 'three' },
          { id: 'two', fields: { hidden: true } },
          { id: 'one', fields: { label: 'Old label' } },
          { id: 'four' },
        ]),
      );
      expect(await revisions()).toEqual({ ...SEEDED, list: 1 });
    });

    it('completes a move onto itself without a write', async () => {
      const before = images();
      const commits = jest.spyOn(host, 'commit');
      await reorder({ activeWorktreeId: 'three', overWorktreeId: 'three' });

      expect(outcomes).toEqual([
        {
          kind: 'completed',
          result: {
            workspaceId: 'a',
            activeWorktreeId: 'three',
            overWorktreeId: 'three',
          },
        },
      ]);
      expect(images()).toEqual(before);
      expect(await revisions()).toEqual(SEEDED);
      expect(listCommits(commits)).toEqual([]);
      expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
      expect(jest.mocked(sendToWindow).mock.calls).toEqual([
        [
          null,
          IPC_CHANNELS.workspaceWorktreesUpdated,
          { workspaceId: 'a', worktrees: persistedRows() },
        ],
      ]);
    });

    it.each([
      [
        'a hidden active row',
        { activeWorktreeId: 'two', overWorktreeId: 'one' },
      ],
      [
        'a hidden target row',
        { activeWorktreeId: 'one', overWorktreeId: 'two' },
      ],
      ['a missing row', { activeWorktreeId: 'missing', overWorktreeId: 'one' }],
    ])(
      'keeps not_found and its message for %s, writing nothing',
      async (_name, payload) => {
        const before = images();
        await reorder(payload);

        expect(outcomes).toEqual([
          {
            kind: 'failed',
            code: 'not_found',
            message: 'Worktree to reorder was not found.',
          },
        ]);
        expect(images()).toEqual(before);
        expect(await revisions()).toEqual(SEEDED);
        expect(sendToWindow).not.toHaveBeenCalled();
      },
    );

    it('keeps refusing a cowork project before the boundary', async () => {
      writeFileSync(
        join(root, 'a', 'workspace.json'),
        JSON.stringify({ version: 1, type: 'cowork', repos: [] }),
      );
      const before = images();
      await reorder({ activeWorktreeId: 'four', overWorktreeId: 'one' });

      expect(outcomes).toEqual([
        {
          kind: 'failed',
          code: 'not_found',
          message: 'Project to reorder was not found.',
        },
      ]);
      expect(images()).toEqual(before);
    });

    it('refuses the read-only shared-container scope as forbidden', async () => {
      await handlePortalWorktreeReorder(
        command('portal.worktree.reorder', {
          workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          activeWorktreeId: 'four',
          overWorktreeId: 'one',
        }),
        context,
      );

      expect(outcomes).toEqual([
        {
          kind: 'failed',
          code: 'forbidden',
          message: READ_ONLY_SCOPE_ERROR,
          retryable: false,
        },
      ]);
      expect(sendToWindow).not.toHaveBeenCalled();
    });
  });
});

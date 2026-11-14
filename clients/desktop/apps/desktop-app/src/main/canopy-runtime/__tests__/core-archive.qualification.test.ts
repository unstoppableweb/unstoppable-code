import { installRoutedW5GoldenStore } from '../../lib/__tests__/fixtures/w5-routed-golden-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  mkdir as mkdirFixtureParent,
  writeFile as writeFixtureBytes,
} from 'node:fs/promises';
import {
  ARCHIVE_GRANTS,
  type CanopyCallerDescriptor,
  type WorktreeRecoveryFinishResult,
} from '@canopy/protocol/canopy-core';
import type {
  ArchivedContainerSummary,
  ArchivedContainerSummaryV1,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { CoreWorkspaceGuardedHost } from '@canopy/core-runtime/node/workspace/guarded-commands';
import type { CoreWorkspaceLifecycleHost } from '@canopy/core-runtime/node/workspace/lifecycle-commands';
import type { CoreWorkspaceMetadataHost } from '@canopy/core-runtime/node/workspace/metadata-commands';
import type { CoreArchiveHost } from '../core-archive-adapter';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';
import { closeChatSearchService } from '../../chat-search/service';
import { disposeElectronDaemonConnections } from '../electron-daemon-access';
import { cancelPortalStructuralSync } from '../../portal/portal-structural-sync';
import { cancelDesktopSessionSnapshotInvalidation } from '../../services/desktop-session-snapshot-invalidation';
import { peekObservabilityService } from '../../observability';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';

const caller = (
  grants: CanopyCallerDescriptor['grants'],
  authorityId = LOCAL_DESKTOP_AUTHORITY_ID,
): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId: 'agent-action:advisor-chat',
  authorityId,
  interfaceKind: 'mcp',
  grants,
});
const READ = caller([ARCHIVE_GRANTS.read]);
const WRITE = caller([ARCHIVE_GRANTS.write]);
const meta = (key: string): { idempotencyKey: string } => ({
  idempotencyKey: key,
});

function container(
  id: string,
  overrides: Partial<ArchivedContainerSummaryV1> = {},
): ArchivedContainerSummaryV1 {
  return {
    version: 1,
    kind: 'worktree',
    id,
    projectId: 'ws',
    name: `Archive ${id}`,
    createdAt: '2026-11-01T00:00:00.000Z',
    archivedAt: '2026-11-02T00:00:00.000Z',
    retentionDays: 30,
    expiresAt: '2026-12-02T00:00:00.000Z',
    chatCount: 1,
    archivedChatCount: 0,
    executionCount: 0,
    branchName: 'feature/x',
    ...overrides,
  };
}

function message(id: string, text: string): PersistedChatMessage {
  return { id, role: 'user', timestamp: 1, blocks: [{ type: 'text', text }] };
}

function tab(id: string, count: number): PersistedChatTab {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: '2026-11-01T00:00:00.000Z',
    messages: Array.from({ length: count }, (_, index) =>
      message(`${id}-m${index}`, `message ${index}`),
    ),
  };
}

interface Calls {
  lists: string[];
  reads: string[];
  locks: { archiveId: string; locked: boolean }[];
}

/** One project `ws` with two containers; each container holds its own chat. */
function fakeHost(): { host: CoreArchiveHost; calls: Calls } {
  const calls: Calls = { lists: [], reads: [], locks: [] };
  const containers = new Map([
    ['a1', container('a1')],
    ['a2', container('a2', { lockedAt: '2026-11-03T00:00:00.000Z' })],
  ]);
  const chats: Record<string, PersistedChatTab> = {
    'a1/chat-1': tab('chat-1', 5),
    'a2/chat-2': tab('chat-2', 1),
  };
  const host: CoreArchiveHost = {
    list: (workspaceId) => {
      calls.lists.push(workspaceId);
      return Promise.resolve(
        workspaceId === 'ws' ? [...containers.values()] : [],
      );
    },
    workspaceName: (workspaceId) =>
      Promise.resolve(workspaceId === 'ws' ? 'Website' : null),
    readChat: (_workspaceId, archiveId, chatId) => {
      calls.reads.push(`${archiveId}/${chatId}`);
      return Promise.resolve(chats[`${archiveId}/${chatId}`] ?? null);
    },
    setLocked: (_workspaceId, archiveId, locked) => {
      calls.locks.push({ archiveId, locked });
      const current = containers.get(archiveId);
      if (!current) return Promise.reject(new Error('missing'));
      const { lockedAt: _lockedAt, ...unlocked } = current;
      void _lockedAt;
      const next: ArchivedContainerSummary = locked
        ? { ...current, lockedAt: '2026-11-09T00:00:00.000Z' }
        : { ...unlocked, expiresAt: '2026-12-09T00:00:00.000Z' };
      containers.set(archiveId, next);
      return Promise.resolve(next);
    },
  };
  return { host, calls };
}

const PERSISTENCE_TEST_TIMEOUT_MS = 120_000;
let root: string;
const fixtureRoots = new Set<string>();
let persistenceWork: Promise<void> | undefined;

function persistenceIt(name: string, test: () => Promise<void>): void {
  it(name, () => runPersistenceFixture(test), PERSISTENCE_TEST_TIMEOUT_MS);
}

function runPersistenceFixture(test: () => Promise<void>): Promise<void> {
  persistenceWork = test();
  return persistenceWork;
}

async function drainFixtureServices(): Promise<void> {
  await settleDetachedWork();
  await closeChatSearchService();
  await settleDetachedWork();
  await peekObservabilityService()?.flush();
}

async function expectBrowserRetirementDeadline(
  finish: () => Promise<WorktreeRecoveryFinishResult>,
  options: {
    afterTimeout?: () => Promise<void>;
    lateFailure?: boolean;
  } = {},
): Promise<void> {
  const lifecycle = await import('../../browser/browser-profile-lifecycle');
  const stalled = Promise.withResolvers<void>();
  const retire = jest
    .spyOn(lifecycle, 'retireRemovedBrowserTask')
    .mockReturnValue(stalled.promise);
  const pending = finish();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<null>((resolve) => {
      watchdog = setTimeout(() => resolve(null), 30_000);
    });
    const result = await Promise.race([pending, deadline]);
    expect(result).toEqual({
      status: 'interrupted',
      check: 'browser-retirement-timeout',
    });
    expect(retire).toHaveBeenCalled();
    if (options.afterTimeout)
      expect(
        await Promise.race([options.afterTimeout().then(() => true), deadline]),
      ).toBe(true);
  } finally {
    clearTimeout(watchdog);
    // Release only during teardown so the red reproduction can drain normally.
    if (options.lateFailure)
      stalled.reject(new Error('injected late browser retirement failure'));
    else stalled.resolve();
    retire.mockRestore();
    await pending;
  }
}

async function writeFixtureFile(
  file: string,
  data: string,
  options?: { mode: number },
): Promise<void> {
  await mkdirFixtureParent(dirname(file), { recursive: true });
  await writeFixtureBytes(file, data, options);
}
const runtimes: DesktopCanopyDispatcher[] = [];
function runtimeWith(
  host: CoreArchiveHost,
  workspaceLifecycleHost?: CoreWorkspaceLifecycleHost,
  hosts: {
    workspaceMetadataHost?: CoreWorkspaceMetadataHost;
    workspaceGuardedHost?: CoreWorkspaceGuardedHost;
  } = {},
): DesktopCanopyDispatcher {
  const runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(root, `ledger-${runtimes.length}.sqlite`),
    }),
    archiveHost: host,
    ...(workspaceLifecycleHost && { workspaceLifecycleHost }),
    ...hosts,
    shutdownTimeoutMs: 25,
  });
  runtimes.push(runtime);
  return runtime;
}

beforeEach(() => {
  if (persistenceWork)
    throw new Error('The previous persistence fixture has not drained.');
  root = mkdtempSync(join(tmpdir(), 'core-archive-'));
  fixtureRoots.add(root);
});
afterEach(async () => {
  // Jest timeouts do not cancel async tests. Drain before restoring roots or mocks.
  await persistenceWork?.catch(() => undefined);
  persistenceWork = undefined;
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
}, PERSISTENCE_TEST_TIMEOUT_MS);
afterAll(async () => {
  // The real sidecar tail drains daemon Code Graph jobs through the app singleton.
  await disposeElectronDaemonConnections();
  cancelPortalStructuralSync();
  cancelDesktopSessionSnapshotInvalidation();
  for (const directory of fixtureRoots)
    rmSync(directory, { recursive: true, force: true });
}, PERSISTENCE_TEST_TIMEOUT_MS);

describe('core.archive on the desktop dispatcher (CAN-6007)', () => {
  it("lists a project's containers without their chats or files", async () => {
    const { host } = fakeHost();
    const runtime = runtimeWith(host);
    const listed = await runtime.query(
      'core.archive.container.list',
      { workspaceId: 'ws' },
      { caller: READ },
    );
    expect(listed).toEqual({
      workspaceId: 'ws',
      containers: [
        {
          archiveId: 'a1',
          kind: 'worktree',
          workspaceId: 'ws',
          workspaceName: 'Website',
          revision: null,
          name: 'Archive a1',
          branchName: 'feature/x',
          archivedAt: '2026-11-02T00:00:00.000Z',
          expiresAt: '2026-12-02T00:00:00.000Z',
          locked: false,
          lockedAt: null,
          chatCount: 1,
          archivedChatCount: 0,
          executionCount: 0,
          partiallyRestored: false,
        },
        expect.objectContaining({
          archiveId: 'a2',
          locked: true,
          lockedAt: '2026-11-03T00:00:00.000Z',
        }),
      ],
    });
    await expect(
      runtime.query(
        'core.archive.container.list',
        { workspaceId: '../ws' },
        { caller: READ },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'core.archive.workspace.invalid',
      },
    });
  });

  it('refuses what only the web core serves, before any read or lock (CAN-6109)', async () => {
    const { host, calls } = fakeHost();
    const runtime = runtimeWith(host);
    const unavailable = (field: string): object => ({
      payload: {
        kind: 'capability_unavailable',
        details: { unsupported: [field] },
      },
    });
    // An account-wide list is the web core's; this desktop lists one project.
    await expect(
      runtime.query('core.archive.container.list', {}, { caller: READ }),
    ).rejects.toMatchObject(unavailable('workspaceId'));
    // A per-container revision is the web core's; this desktop keeps none.
    await expect(
      runtime.instruction(
        'core.archive.container.update',
        {
          workspaceId: 'ws',
          archiveId: 'a1',
          locked: true,
          expectedRevision: 0,
          _meta: meta('cas'),
        },
        { caller: WRITE, metadata: meta('cas') },
      ),
    ).rejects.toMatchObject(unavailable('expectedRevision'));
    expect(calls).toEqual({ lists: [], reads: [], locks: [] });
  });

  it('refuses to keep a whole project archived, before the lifecycle host runs (CAN-6109)', async () => {
    const touched: string[] = [];
    const refuse = (name: string) => (): Promise<never> => {
      touched.push(name);
      return Promise.reject(new Error(`${name} must not run`));
    };
    const lifecycle: CoreWorkspaceLifecycleHost = {
      createWorkspace: refuse('createWorkspace'),
      importWorkspace: refuse('importWorkspace'),
      createWorktree: refuse('createWorktree'),
      archiveWorktree: refuse('archiveWorktree'),
      deleteWorkspace: refuse('deleteWorkspace'),
      deleteWorktree: refuse('deleteWorktree'),
      restoreArchive: refuse('restoreArchive'),
    };
    const runtime = runtimeWith(fakeHost().host, lifecycle);
    const desktopUser: CanopyCallerDescriptor = {
      principalId: 'local-desktop-user',
      clientInstanceId: 'desktop-ipc',
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      interfaceKind: 'desktop',
      grants: ['core.workspace.write'],
    };
    await expect(
      runtime.instruction(
        'core.workspace.delete',
        {
          workspaceId: 'ws',
          expectedRevision: 0,
          mode: 'archive',
          _meta: meta('keep'),
        },
        { caller: desktopUser, metadata: meta('keep') },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { reason: 'archive-mode-unavailable' },
      },
    });
    expect(touched).toEqual([]);
  });

  it("refuses the web core's cloud archive lifecycle params, before the lifecycle host runs (CAN-6110)", async () => {
    const touched: string[] = [];
    const refuse = (name: string) => (): Promise<never> => {
      touched.push(name);
      return Promise.reject(new Error(`${name} must not run`));
    };
    const lifecycle: CoreWorkspaceLifecycleHost = {
      createWorkspace: refuse('createWorkspace'),
      importWorkspace: refuse('importWorkspace'),
      createWorktree: refuse('createWorktree'),
      archiveWorktree: refuse('archiveWorktree'),
      deleteWorkspace: refuse('deleteWorkspace'),
      deleteWorktree: refuse('deleteWorktree'),
      restoreArchive: refuse('restoreArchive'),
    };
    const runtime = runtimeWith(fakeHost().host, lifecycle);
    const desktopUser: CanopyCallerDescriptor = {
      principalId: 'local-desktop-user',
      clientInstanceId: 'desktop-ipc',
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      interfaceKind: 'desktop',
      grants: ['core.worktree.write'],
    };
    for (const params of [
      { wake: true },
      { wake: false },
      { cancelProvisioning: true },
      { choice: 'retry' as const, expectedArchiveAttempt: 1 },
      { continueArchive: true as const, expectedArchiveAttempt: 1 },
    ])
      await expect(
        runtime.instruction(
          'core.worktree.archive',
          { worktreeId: 'wt', expectedRevision: 0, archived: true, ...params },
          { caller: desktopUser },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          details: { reason: 'cloud-lifecycle-unavailable' },
        },
      });
    expect(touched).toEqual([]);
  });

  it("refuses the web core's owner, first-project, project template and project id claim create fields, before the lifecycle host runs (CAN-6114, CAN-6111, CAN-6093)", async () => {
    const touched: string[] = [];
    const refuse = (name: string) => (): Promise<never> => {
      touched.push(name);
      return Promise.reject(new Error(`${name} must not run`));
    };
    const lifecycle: CoreWorkspaceLifecycleHost = {
      // As the desktop host does: a request it does not serve answers its
      // refusal before any effect.
      createWorkspace: (request) =>
        request.kind === 'unserved'
          ? Promise.reject(request.refusal)
          : refuse('createWorkspace')(),
      importWorkspace: refuse('importWorkspace'),
      createWorktree: refuse('createWorktree'),
      archiveWorktree: refuse('archiveWorktree'),
      deleteWorkspace: refuse('deleteWorkspace'),
      deleteWorktree: refuse('deleteWorktree'),
      restoreArchive: refuse('restoreArchive'),
    };
    const runtime = runtimeWith(fakeHost().host, lifecycle);
    const desktopUser: CanopyCallerDescriptor = {
      principalId: 'local-desktop-user',
      clientInstanceId: 'desktop-ipc',
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      interfaceKind: 'desktop',
      grants: ['core.workspace.write'],
    };
    const create = (extra: object, key: string): Promise<unknown> =>
      runtime.instruction(
        'core.workspace.create',
        {
          name: 'Website',
          source: { kind: 'empty', workspaceKind: 'single_repo' },
          temporary: false,
          ...extra,
          _meta: meta(key),
        },
        { caller: desktopUser, metadata: meta(key) },
      );
    for (const [field, extra] of [
      [
        'ownerOrganizationId',
        { ownerOrganizationId: '0a000000-0000-4000-8000-0000000000aa' },
      ],
      ['firstWorkspaceOnly', { firstWorkspaceOnly: true }],
      ['blueprintSeed', { blueprintSeed: 'shared' }],
    ] as const)
      await expect(create(extra, field)).rejects.toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          details: { reason: 'unserved', fields: [field] },
        },
      });
    await expect(
      create(
        { blueprintExternalId: 'blueprint-1', blueprintContentHash: 'hash' },
        'blueprint',
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: {
          reason: 'unserved',
          fields: ['blueprintExternalId', 'blueprintContentHash'],
        },
      },
    });
    // Revision 2's project id claim (CAN-6093): a desktop create derives its
    // id, so the revision and the claim are both unserved.
    const CLAIM = '0c000000-0000-4000-8000-0000000000cc';
    for (const [extra, fields] of [
      [{ revision: 2 }, ['revision']],
      [{ workspaceId: CLAIM }, ['workspaceId']],
      [{ revision: 2, workspaceId: CLAIM }, ['workspaceId', 'revision']],
    ] as const)
      await expect(create(extra, fields.join('+'))).rejects.toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          details: { reason: 'unserved', fields },
        },
      });
    expect(touched).toEqual([]);
  });

  it("refuses the web core's worktree id, first chat and first message, before the lifecycle host runs (CAN-6114)", async () => {
    const touched: string[] = [];
    const refuse = (name: string) => (): Promise<never> => {
      touched.push(name);
      return Promise.reject(new Error(`${name} must not run`));
    };
    const lifecycle: CoreWorkspaceLifecycleHost = {
      createWorkspace: refuse('createWorkspace'),
      importWorkspace: refuse('importWorkspace'),
      // As the desktop host does: a request it does not serve answers its
      // refusal before any effect.
      createWorktree: (request) =>
        request.kind === 'unserved'
          ? Promise.reject(request.refusal)
          : refuse('createWorktree')(),
      archiveWorktree: refuse('archiveWorktree'),
      deleteWorkspace: refuse('deleteWorkspace'),
      deleteWorktree: refuse('deleteWorktree'),
      restoreArchive: refuse('restoreArchive'),
    };
    const runtime = runtimeWith(fakeHost().host, lifecycle);
    const desktopUser: CanopyCallerDescriptor = {
      principalId: 'local-desktop-user',
      clientInstanceId: 'desktop-ipc',
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      interfaceKind: 'desktop',
      grants: ['core.worktree.write'],
    };
    for (const [field, extra] of [
      ['worktreeId', { worktreeId: '0c000000-0000-4000-8000-0000000000cc' }],
      ['firstChat', { firstChat: { model: 'model-1' } }],
      [
        'firstMessage',
        {
          firstMessage: {
            text: 'Fix the bug',
            clientRequestId: '0e000000-0000-4000-8000-0000000000ee',
          },
        },
      ],
    ] as const)
      await expect(
        runtime.instruction(
          'core.worktree.create',
          { workspaceId: 'ws', ...extra, _meta: meta(field) },
          { caller: desktopUser, metadata: meta(field) },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          details: { reason: 'unserved', fields: [field] },
        },
      });
    expect(touched).toEqual([]);
  });

  it('reads the end of a chat only inside its own container and project', async () => {
    const { host, calls } = fakeHost();
    const runtime = runtimeWith(host);
    const read = await runtime.query(
      'core.archive.chat.get',
      { workspaceId: 'ws', archiveId: 'a1', chatId: 'chat-1', limit: 2 },
      { caller: READ },
    );
    expect(read).toEqual({
      workspaceId: 'ws',
      archiveId: 'a1',
      chatId: 'chat-1',
      title: 'Chat chat-1',
      totalMessages: 5,
      messages: [
        {
          id: 'chat-1-m3',
          role: 'user',
          timestamp: 1,
          text: 'message 3',
          truncated: false,
        },
        {
          id: 'chat-1-m4',
          role: 'user',
          timestamp: 1,
          text: 'message 4',
          truncated: false,
        },
      ],
    });
    // Another container's chat, another worktree's container, another project.
    await expect(
      runtime.query(
        'core.archive.chat.get',
        { workspaceId: 'ws', archiveId: 'a1', chatId: 'chat-2', limit: 5 },
        { caller: READ },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.archive.chat.notFound' },
    });
    await expect(
      runtime.query(
        'core.archive.chat.get',
        { workspaceId: 'ws', archiveId: 'gone', chatId: 'chat-1', limit: 5 },
        { caller: READ },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.archive.container.notFound' },
    });
    await expect(
      runtime.query(
        'core.archive.chat.get',
        { workspaceId: 'other', archiveId: 'a1', chatId: 'chat-1', limit: 5 },
        { caller: READ },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.archive.container.notFound' },
    });
    expect(calls.reads).toEqual(['a1/chat-1', 'a1/chat-2']);
  });

  it("answers only this desktop's own callers, and only with the operation's grant", async () => {
    const { host, calls } = fakeHost();
    const runtime = runtimeWith(host);
    const foreign = caller(
      [ARCHIVE_GRANTS.read, ARCHIVE_GRANTS.write],
      'another-desktop',
    );
    await expect(
      runtime.query(
        'core.archive.container.list',
        { workspaceId: 'ws' },
        { caller: foreign },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'permission_denied',
        code: 'core.archive.foreignAuthority',
      },
    });
    await expect(
      runtime.query(
        'core.archive.chat.get',
        { workspaceId: 'ws', archiveId: 'a1', chatId: 'chat-1', limit: 5 },
        { caller: foreign },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'permission_denied',
        code: 'core.archive.foreignAuthority',
      },
    });
    await expect(
      runtime.instruction(
        'core.archive.container.update',
        { workspaceId: 'ws', archiveId: 'a1', locked: true, _meta: meta('f') },
        { caller: foreign, metadata: meta('f') },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'permission_denied',
        code: 'core.archive.foreignAuthority',
      },
    });
    await expect(
      runtime.query(
        'core.archive.container.list',
        { workspaceId: 'ws' },
        { caller: WRITE },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      runtime.instruction(
        'core.archive.container.update',
        { workspaceId: 'ws', archiveId: 'a1', locked: true, _meta: meta('r') },
        { caller: READ, metadata: meta('r') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(calls).toEqual({ lists: [], reads: [], locks: [] });
  });

  it('refuses a malformed project id as invalid on every operation, before any read', async () => {
    const { host, calls } = fakeHost();
    const runtime = runtimeWith(host);
    const invalid = {
      payload: {
        kind: 'invalid_argument',
        code: 'core.archive.workspace.invalid',
      },
    };
    await expect(
      runtime.query(
        'core.archive.chat.get',
        { workspaceId: '../ws', archiveId: 'a1', chatId: 'chat-1', limit: 5 },
        { caller: READ },
      ),
    ).rejects.toMatchObject(invalid);
    await expect(
      runtime.instruction(
        'core.archive.container.update',
        {
          workspaceId: '../ws',
          archiveId: 'a1',
          locked: true,
          _meta: meta('bad-id'),
        },
        { caller: WRITE, metadata: meta('bad-id') },
      ),
    ).rejects.toMatchObject(invalid);
    expect(calls).toEqual({ lists: [], reads: [], locks: [] });
  });

  it('locks and unlocks once per key, and only a container of the project', async () => {
    const { host, calls } = fakeHost();
    const runtime = runtimeWith(host);
    const params = {
      workspaceId: 'ws',
      archiveId: 'a2',
      locked: false,
      _meta: meta('unlock-1'),
    };
    const first = await runtime.instruction(
      'core.archive.container.update',
      params,
      { caller: WRITE, metadata: meta('unlock-1') },
    );
    const replay = await runtime.instruction(
      'core.archive.container.update',
      params,
      { caller: WRITE, metadata: meta('unlock-1') },
    );
    expect(first.container).toMatchObject({
      archiveId: 'a2',
      locked: false,
      lockedAt: null,
      expiresAt: '2026-12-09T00:00:00.000Z',
    });
    expect(replay).toEqual(first);
    expect(calls.locks).toEqual([{ archiveId: 'a2', locked: false }]);
    await expect(
      runtime.instruction(
        'core.archive.container.update',
        { ...params, locked: true },
        { caller: WRITE, metadata: meta('unlock-1') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
    await expect(
      runtime.instruction(
        'core.archive.container.update',
        {
          workspaceId: 'other',
          archiveId: 'a1',
          locked: true,
          _meta: meta('elsewhere'),
        },
        { caller: WRITE, metadata: meta('elsewhere') },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.archive.container.notFound' },
    });
    expect(calls.locks).toHaveLength(1);
  });
  it("refuses the web core's cloud project settings, before the workspace hosts run (CAN-6114)", async () => {
    const touched: string[] = [];
    // Every host method records itself and fails: none may run.
    const untouchable = <Host extends object>(): Host =>
      new Proxy({} as Host, {
        get: (_target, name) => () => {
          touched.push(String(name));
          return Promise.reject(new Error(`${String(name)} must not run`));
        },
      });
    const runtime = runtimeWith(fakeHost().host, undefined, {
      workspaceMetadataHost: untouchable(),
      workspaceGuardedHost: untouchable(),
    });
    const desktopUser: CanopyCallerDescriptor = {
      principalId: 'local-desktop-user',
      clientInstanceId: 'desktop-ipc',
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      interfaceKind: 'desktop',
      grants: ['core.workspace.write'],
    };
    const unserved = (fields: readonly string[]): object => ({
      payload: {
        kind: 'capability_unavailable',
        details: { reason: 'unserved', fields },
      },
    });
    for (const [field, value] of [
      ['hostModeEnabled', true],
      ['hostPorts', [3000]],
      ['egressAllowedHosts', ['api.example.com']],
    ] as const)
      await expect(
        runtime.instruction(
          'core.workspace.update',
          { workspaceId: 'ws', patch: { [field]: value }, _meta: meta(field) },
          { caller: desktopUser, metadata: meta(field) },
        ),
      ).rejects.toMatchObject(unserved([field]));
    // A desktop Cowork project has no cleared default model to store.
    await expect(
      runtime.instruction(
        'core.workspace.cowork.update',
        {
          workspaceId: 'ws',
          settings: { defaultModel: null },
          _meta: meta('model'),
        },
        { caller: desktopUser, metadata: meta('model') },
      ),
    ).rejects.toMatchObject(unserved(['defaultModel']));
    // Desktop defaults have no cleared state and no revision of their own.
    const selections = { collectionIds: [], skillRefs: [], pluginRefs: [] };
    for (const [fields, change] of [
      [
        ['defaultPluginSelections'],
        { kind: 'setDefaults', defaultPluginSelections: null },
      ],
      [
        ['expectedDefaultPluginSelectionsRevision'],
        {
          kind: 'setDefaults',
          defaultPluginSelections: selections,
          expectedDefaultPluginSelectionsRevision: 2,
        },
      ],
    ] as const)
      await expect(
        runtime.instruction(
          'core.workspace.plugins.update',
          { workspaceId: 'ws', change, _meta: meta(fields[0]) },
          { caller: desktopUser, metadata: meta(fields[0]) },
        ),
      ).rejects.toMatchObject(unserved(fields));
    // Its field without the revision is refused as a field.
    await expect(
      runtime.instruction(
        'core.workspace.cowork.update',
        {
          workspaceId: 'ws',
          settings: { deletionRetentionDays: 30 },
          _meta: meta('retention-field'),
        },
        { caller: desktopUser, metadata: meta('retention-field') },
      ),
    ).rejects.toMatchObject(unserved(['deletionRetentionDays']));
    // The cloud Trash retention's revision (CAN-6093), refused as a revision.
    await expect(
      runtime.instruction(
        'core.workspace.cowork.update',
        {
          workspaceId: 'ws',
          revision: 2,
          settings: { deletionRetentionDays: 30 },
          _meta: meta('retention'),
        },
        { caller: desktopUser, metadata: meta('retention') },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { unsupported: ['revision'], reason: 'unserved' },
        retry: { kind: 'after_refresh', resource: 'core.runtime.manifest.get' },
      },
    });
    expect(touched).toEqual([]);
  });
});

persistenceIt(
  'enumerates exact raw archive recovery operations through core without canonical rows',
  async () => {
    const previousData = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = join(root, 'recovery-data');
    try {
      const { mkdir, readFile } = await import('node:fs/promises');
      const { createHash, randomUUID } = await import('node:crypto');
      const directory = join(
        process.env.CANOPY_DATA_DIR,
        'w5',
        'destructive-lifecycles',
      );
      await mkdir(directory, { recursive: true });
      const operationId = randomUUID();
      const journal = {
        version: 1,
        operationId,
        operation: 'worktree-archive',
        workspaceId: 'ws',
        worktreeId: 'missing-row',
        createdAt: '2026-11-01T00:00:00.000Z',
        directoryIdentity: null,
        state: 'active',
        steps: [],
        ownedPaths: [],
      };
      const history = join(directory, `${operationId}.json`);
      await writeFixtureFile(history, JSON.stringify(journal));
      const runtime = runtimeWith(fakeHost().host);
      const reader = caller(['core.worktree.read']);
      const result = await runtime.query(
        'core.worktree.recovery.list',
        {
          workspaceId: 'ws',
          operationId,
        },
        { caller: reader },
      );
      expect(result.check).toBe('ok');
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.diagnosis).toMatchObject({
        operationId,
        rawState: 'active',
        copies: 1,
        slot: 'absent',
        verdict: 'refused',
        check: 'raw-active',
      });
      expect(JSON.parse(await readFile(history, 'utf8'))).toEqual(journal);
      const slot = join(
        directory,
        `${createHash('sha256')
          .update(JSON.stringify(['ws', 'missing-row']))
          .digest('hex')}.json`,
      );
      await writeFixtureFile(
        slot,
        JSON.stringify({ ...journal, state: 'recovery-required' }),
      );
      const conflict = await runtime.query(
        'core.worktree.recovery.list',
        { workspaceId: 'ws' },
        { caller: reader },
      );
      expect(conflict.entries[0]?.diagnosis).toMatchObject({
        copies: 2,
        verdict: 'refused',
        check: 'conflicting-journal-copies',
      });
      // Copy relevance is not decided by whichever filename sorts first.
      const firstCopy = history < slot ? history : slot;
      const secondCopy = history < slot ? slot : history;
      for (const hidden of [
        { ...journal, state: 'completed' },
        { ...journal, operation: 'worktree-delete' },
      ]) {
        await writeFixtureFile(firstCopy, JSON.stringify(hidden));
        await writeFixtureFile(secondCopy, JSON.stringify(journal));
        const listed = await runtime.query(
          'core.worktree.recovery.list',
          { workspaceId: 'ws', operationId },
          { caller: reader },
        );
        expect(listed.entries).toHaveLength(1);
        expect(listed.entries[0]?.diagnosis).toMatchObject({
          copies: 2,
          verdict: 'refused',
          check: 'conflicting-journal-copies',
        });
        expect(JSON.parse(await readFile(firstCopy, 'utf8'))).toEqual(hidden);
        expect(JSON.parse(await readFile(secondCopy, 'utf8'))).toEqual(journal);
      }
      expect(
        (
          await runtime.query(
            'core.worktree.recovery.list',
            { workspaceId: 'ws', operationId: randomUUID() },
            { caller: reader },
          )
        ).entries,
      ).toEqual([]);
      await expect(
        runtime.query(
          'core.worktree.recovery.list',
          { workspaceId: 'ws' },
          { caller: caller([]) },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      await expect(
        runtime.query(
          'core.worktree.recovery.list',
          { workspaceId: 'ws' },
          { caller: caller(['core.worktree.read'], 'foreign') },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    } finally {
      await drainFixtureServices();
      if (previousData === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = previousData;
    }
  },
);

persistenceIt(
  'finishes exact row-less browser debt without overwriting another slot or erasing v3 domain debt',
  async () => {
    const previousData = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = join(root, 'finish-data');
    const browser = await import('../../browser/browser-profile-service');
    const profiles = new browser.BrowserProfileService(
      process.env.CANOPY_DATA_DIR,
      join(root, 'sessions'),
    );
    const profileFactory = jest
      .spyOn(browser, 'getBrowserProfileService')
      .mockReturnValue(profiles);
    const lifecycle = await import('../../browser/browser-profile-lifecycle');
    const prepareRetirement = jest.spyOn(
      lifecycle,
      'prepareTaskBrowserRetirement',
    );
    const { BrowserDownloads } =
      await import('../../browser/browser-downloads');
    const cancelDownloads = jest.spyOn(
      BrowserDownloads.prototype,
      'cancelTask',
    );
    const {
      withWorkspaceTargetRuntimePreparation,
      assertWorkspaceTargetRuntimeStartAllowed,
    } = await import('../../lib/workspace-target-exclusion');
    try {
      const { mkdir, readFile, lstat } = await import('node:fs/promises');
      const { randomUUID } = await import('node:crypto');
      const paths = await import('../../lib/paths');
      const { lifecycleJournalSlotName } =
        await import('../../lib/w5-destructive-recovery');
      const workspaceId = 'ws';
      const worktreeId = 'finished';
      const project = paths.getWorkspaceDir(workspaceId);
      await mkdir(project, { recursive: true });
      await writeFixtureFile(
        join(paths.getDataDir(), 'workspaces', 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: [
            { id: workspaceId, type: 'single-repo', name: 'Recovery' },
          ],
        }),
      );
      await writeFixtureFile(
        paths.getWorkspaceConfigPath(workspaceId),
        JSON.stringify({
          version: 1,
          repos: [],
          type: 'single-repo',
          repoPath: root,
          createdAt: '2026-11-01T00:00:00.000Z',
        }),
      );
      await writeFixtureFile(
        paths.getWorkspaceWorktreesFilePath(workspaceId),
        JSON.stringify({ version: 1, worktrees: [] }),
      );
      const manifest = {
        ...container(worktreeId),
        version: 3,
        projectId: workspaceId,
        kind: 'worktree',
        workspaceType: 'single-repo',
        originalWorktree: {
          id: worktreeId,
          branchName: 'feature/x',
          createdAt: '2026-11-01T00:00:00.000Z',
        },
        recovery: {
          kind: 'files-only',
          source: 'absent',
          digest: '0'.repeat(64),
          payloadId: randomUUID(),
          gitCleanupPending: true,
        },
      };
      await mkdir(paths.getArchivedContainerDir(workspaceId, worktreeId), {
        recursive: true,
      });
      const manifestPath = paths.getArchivedContainerManifestPath(
        workspaceId,
        worktreeId,
      );
      await writeFixtureFile(manifestPath, JSON.stringify(manifest));
      const stat = await lstat(project);
      const operationId = randomUUID();
      const record = {
        version: 1,
        operationId,
        operation: 'worktree-archive',
        workspaceId,
        worktreeId,
        createdAt: manifest.createdAt,
        directoryIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
        state: 'completed',
        cleanupRequired: true,
        ownedPaths: [],
        parentOperation: 'workspace-delete',
        steps: [
          'retained-git-cleanup',
          'pipeline-cleanup',
          'retained-manifest-commit',
          'canonical-row-removal',
          'deferred-browser-retirement',
        ].map((phase) => ({ phase, state: 'done' })),
      };
      const directory = paths.getW5DestructiveLifecycleDir();
      await mkdir(directory, { recursive: true });
      const history = join(directory, `${operationId}.json`);
      await writeFixtureFile(history, JSON.stringify(record));
      const slot = join(
        directory,
        lifecycleJournalSlotName(workspaceId, worktreeId),
      );
      const other = JSON.stringify({
        ...record,
        operationId: randomUUID(),
        cleanupRequired: false,
      });
      await writeFixtureFile(slot, other);
      const scope = {
        kind: 'worktree' as const,
        projectId: workspaceId,
        worktreeId,
      };
      await profiles.repository.ensureTask(
        scope,
        manifest.createdAt,
        randomUUID(),
      );
      const runtime = runtimeWith(fakeHost().host);
      const user: CanopyCallerDescriptor = {
        ...caller(['core.worktree.read', 'core.worktree.write']),
        interfaceKind: 'desktop',
      };
      const before = await runtime.query(
        'core.worktree.recovery.list',
        { workspaceId, operationId },
        { caller: user },
      );
      expect(before.entries[0]?.diagnosis).toMatchObject({
        verdict: 'cleanup-debt',
        slot: 'other-operation',
      });
      const revision = before.entries[0]?.diagnosis?.revision;
      expect(revision).toBeDefined();
      const finish = (review: string): Promise<WorktreeRecoveryFinishResult> =>
        runtime.instruction(
          'core.worktree.recovery.finish',
          { workspaceId, operationId, revision: review },
          { caller: user },
        );
      const refusedFinish = (
        review: string,
      ): Promise<WorktreeRecoveryFinishResult> =>
        withWorkspaceTargetRuntimePreparation(
          workspaceId,
          worktreeId,
          async () => {
            const result = await finish(review);
            expect(prepareRetirement).not.toHaveBeenCalled();
            expect(cancelDownloads).not.toHaveBeenCalled();
            expect(() =>
              assertWorkspaceTargetRuntimeStartAllowed(workspaceId, worktreeId),
            ).not.toThrow();
            return result;
          },
        );
      expect(await refusedFinish('0'.repeat(64))).toMatchObject({
        status: 'refused',
        check: 'review-changed',
      });
      expect(JSON.parse(await readFile(history, 'utf8'))).toEqual(record);
      // A supersedable deletion created after review is still CURRENT pending evidence.
      const deletion = join(directory, lifecycleJournalSlotName(workspaceId));
      await writeFixtureFile(
        deletion,
        JSON.stringify({
          ...record,
          operationId: randomUUID(),
          worktreeId: undefined,
          operation: 'workspace-delete',
          state: 'recovery-required',
          steps: [],
        }),
      );
      expect(await refusedFinish(revision ?? '')).toMatchObject({
        status: 'refused',
        check: 'project-deletion-pending',
      });
      expect(JSON.parse(await readFile(history, 'utf8'))).toEqual(record);
      const { rm } = await import('node:fs/promises');
      await rm(deletion);
      await writeFixtureFile(
        slot,
        JSON.stringify({ ...record, cleanupRequired: false }),
      );
      expect(await refusedFinish(revision ?? '')).toMatchObject({
        status: 'refused',
      });
      expect(JSON.parse(await readFile(history, 'utf8'))).toEqual(record);
      await writeFixtureFile(slot, other);
      const unknown = {
        ...record,
        steps: record.steps.filter(
          (step) => step.phase !== 'deferred-browser-retirement',
        ),
      };
      await writeFixtureFile(history, JSON.stringify(unknown));
      const unknownReview = await runtime.query(
        'core.worktree.recovery.list',
        { workspaceId, operationId },
        { caller: user },
      );
      expect(
        await refusedFinish(
          unknownReview.entries[0]?.diagnosis?.revision ?? '',
        ),
      ).toMatchObject({ status: 'refused', check: 'unknown-cleanup-debt' });
      expect(JSON.parse(await readFile(history, 'utf8'))).toEqual(unknown);
      await writeFixtureFile(history, JSON.stringify(record));
      let timeoutSnapshot: string | undefined;
      await expectBrowserRetirementDeadline(() => finish(revision ?? ''), {
        lateFailure: true,
        afterTimeout: async (): Promise<void> => {
          const { serializeWorkspaceMutation } =
            await import('../../lib/chat-project-operation-queue');
          const { withArchivedWorkspaceOperationLock } =
            await import('../../lib/archived-containers');
          await serializeWorkspaceMutation(() =>
            withArchivedWorkspaceOperationLock(workspaceId, async () => {
              timeoutSnapshot = await readFile(history, 'utf8');
              expect(await readFile(slot, 'utf8')).toBe(other);
            }),
          );
        },
      });
      // Late failure must not rewrite debt after subsequent mutations regain the locks.
      expect(await readFile(history, 'utf8')).toBe(timeoutSnapshot);
      const { readDestructiveJournal } =
        await import('@canopy/desktop-shared/node/w5-destructive-journal');
      const timedOut = await readDestructiveJournal(history);
      expect(timedOut).toMatchObject({
        state: 'recovery-required',
        cleanupRequired: true,
      });
      expect(timedOut.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: 'deferred-browser-retirement',
            state: 'pending',
          }),
        ]),
      );
      expect(await readFile(slot, 'utf8')).toBe(other);
      const timeoutReview = await runtime.query(
        'core.worktree.recovery.list',
        { workspaceId, operationId },
        { caller: user },
      );
      const retire = jest.spyOn(lifecycle, 'retireRemovedBrowserTask');
      // Unexpected owner I/O is an interruption, not an evidence refusal.
      retire.mockRejectedValueOnce(
        new Error('injected browser metadata failure'),
      );
      expect(
        await finish(timeoutReview.entries[0]?.diagnosis?.revision ?? ''),
      ).toEqual({
        status: 'interrupted',
        check: 'finish-interrupted',
      });
      expect(JSON.parse(await readFile(history, 'utf8'))).toMatchObject({
        state: 'recovery-required',
        cleanupRequired: true,
        cleanupRepair: { kind: 'completed-cleanup' },
      });
      expect(await readFile(slot, 'utf8')).toBe(other);
      const retry = await runtime.query(
        'core.worktree.recovery.list',
        { workspaceId, operationId },
        { caller: user },
      );
      const result = await finish(retry.entries[0]?.diagnosis?.revision ?? '');
      expect(retire).toHaveBeenCalledWith(workspaceId, worktreeId);
      retire.mockRestore();
      expect(result).toMatchObject({
        status: 'finished',
        operationId,
        cleanupRequired: false,
        gitCleanupPending: true,
      });
      expect(JSON.parse(await readFile(history, 'utf8'))).toMatchObject({
        operationId,
        state: 'completed',
        cleanupRequired: false,
      });
      expect(await readFile(slot, 'utf8')).toBe(other);
      expect(await profiles.repository.getTask(scope)).toMatchObject({
        lifecycle: 'retired',
      });
      expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(
        manifest,
      );
      expect(
        (
          await runtime.query(
            'core.worktree.recovery.list',
            { workspaceId, operationId },
            { caller: user },
          )
        ).entries,
      ).toEqual([]);
      await expect(
        runtime.instruction(
          'core.worktree.recovery.finish',
          { workspaceId, operationId, revision: revision ?? '' },
          { caller: caller(['core.worktree.write']) },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    } finally {
      await drainFixtureServices();
      prepareRetirement.mockRestore();
      cancelDownloads.mockRestore();
      profileFactory.mockRestore();
      if (previousData === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = previousData;
    }
  },
);

it.each([
  { version: 2, listed: true, captureRefused: false },
  { version: 2, listed: false, captureRefused: false },
  { version: 3, listed: true, captureRefused: true },
  { version: 3, listed: false, captureRefused: true },
  { version: 3, listed: false, captureRefused: false },
])(
  'finishes a committed v$version cleanup tail with listed row=$listed and capture refusal=$captureRefused',
  ({ version, listed, captureRefused }) =>
    runPersistenceFixture(async () => {
      const { mkdtemp, mkdir } = await import('node:fs/promises');
      const fixtureRoot = await mkdtemp(join(tmpdir(), 'finish-tail-'));
      fixtureRoots.add(fixtureRoot);
      const previous = process.env.CANOPY_DATA_DIR;
      process.env.CANOPY_DATA_DIR = join(fixtureRoot, 'data');
      await mkdir(join(process.env.CANOPY_DATA_DIR, 'workspaces'), {
        recursive: true,
      });
      const browser = await import('../../browser/browser-profile-service');
      const profileFactory = jest
        .spyOn(browser, 'getBrowserProfileService')
        .mockReturnValue(
          new browser.BrowserProfileService(
            process.env.CANOPY_DATA_DIR,
            join(fixtureRoot, 'sessions'),
          ),
        );
      const search = await import('../../chat-search/service');
      const { ChatSearchIndexer } = await import('../../chat-search/indexer');
      // Jest has no built search worker; use the service's real SQLite test adapter.
      const searchService = new search.ChatSearchService({
        dbPath: join(fixtureRoot, 'search.sqlite'),
        indexerFactory: (database): InstanceType<typeof ChatSearchIndexer> =>
          new ChatSearchIndexer(database),
      });
      const searchFactory = jest
        .spyOn(search, 'getChatSearchService')
        .mockReturnValue(searchService);
      let closeStore: (() => Promise<void>) | undefined;
      try {
        const { readFile, lstat } = await import('node:fs/promises');
        const { randomUUID } = await import('node:crypto');
        const paths = await import('../../lib/paths');
        const { lifecycleJournalSlotName } =
          await import('../../lib/w5-destructive-recovery');
        const workspaceId = 'ws';
        const worktreeId = `tail-v${version}-${listed}-${captureRefused}`;
        const project = paths.getWorkspaceDir(workspaceId);
        await mkdir(project, { recursive: true });
        await writeFixtureFile(
          join(paths.getDataDir(), 'workspaces', 'index.json'),
          JSON.stringify({
            version: 1,
            workspaces: [
              { id: workspaceId, type: 'single-repo', name: 'Recovery' },
            ],
          }),
        );
        await writeFixtureFile(
          paths.getWorkspaceConfigPath(workspaceId),
          JSON.stringify({
            version: 1,
            type: 'single-repo',
            repoPath: fixtureRoot,
            repos: [],
          }),
        );
        const row = {
          id: worktreeId,
          branchName: 'feature/x',
          createdAt: '2026-11-01T00:00:00.000Z',
        };
        await writeFixtureFile(
          paths.getWorkspaceWorktreesFilePath(workspaceId),
          JSON.stringify({ version: 1, worktrees: listed ? [row] : [] }),
        );
        const manifestBase = {
          ...container(worktreeId),
          version: 3,
          projectId: workspaceId,
          kind: 'worktree',
          workspaceType: 'single-repo',
          originalWorktree: row,
          recovery: {
            kind: 'files-only',
            source: 'absent',
            digest: '0'.repeat(64),
            payloadId: randomUUID(),
            gitCleanupPending: true,
          },
        };
        const manifest =
          version === 3
            ? manifestBase
            : {
                ...container(worktreeId),
                version: 2,
                workspaceType: 'single-repo',
                originalWorktree: row,
                gitState: {
                  version: 1,
                  diffFormatVersion: 1,
                  repositories: [
                    {
                      repoId: '__single_repo__',
                      repoName: 'Source',
                      relativePath: '.',
                      referenceRepoPath: join(
                        fixtureRoot,
                        'unavailable-source',
                      ),
                      comparisonBaseCommit: 'a'.repeat(40),
                      headCommit: 'a'.repeat(40),
                      indexSnapshotCommit: 'a'.repeat(40),
                      worktreeSnapshotCommit: 'a'.repeat(40),
                      snapshotRef: `refs/app/archived-containers/${workspaceId}/${worktreeId}/__single_repo__`,
                    },
                  ],
                },
                gitChanges: {
                  status: 'unavailable',
                  capturedAt: row.createdAt,
                },
                pullRequestMetadata: {
                  capturedAt: row.createdAt,
                  repositories: [
                    {
                      repoId: '__single_repo__',
                      repoName: 'Source',
                      status: 'unavailable',
                    },
                  ],
                },
              };
        await mkdir(paths.getArchivedContainerDir(workspaceId, worktreeId), {
          recursive: true,
        });
        await writeFixtureFile(
          paths.getArchivedContainerManifestPath(workspaceId, worktreeId),
          JSON.stringify(manifest),
        );
        const stat = await lstat(project);
        const operationId = randomUUID();
        const record = {
          version: 1,
          operationId,
          operation: 'worktree-archive',
          workspaceId,
          worktreeId,
          createdAt: row.createdAt,
          directoryIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
          state: 'recovery-required',
          ownedPaths: [],
          steps: [
            ...(version === 3 && captureRefused
              ? [{ phase: 'git-capture', state: 'failed' }]
              : []),
            ...(version === 3
              ? [
                  'retained-git-cleanup',
                  'pipeline-cleanup',
                  'retained-manifest-commit',
                ]
              : [
                  'git-worktree-removal',
                  'quarantine-directory-removal',
                  'pipeline-cleanup',
                  'retained-manifest-commit',
                  'git-capture-completion',
                ]
            ).map((phase) => ({ phase, state: 'done' })),
            { phase: 'canonical-row-removal', state: 'failed' },
          ],
        };
        const directory = paths.getW5DestructiveLifecycleDir();
        await mkdir(directory, { recursive: true });
        const journal = join(
          directory,
          lifecycleJournalSlotName(workspaceId, worktreeId),
        );
        await writeFixtureFile(journal, JSON.stringify(record));
        const history = join(directory, `${operationId}.json`);
        if (!listed) await writeFixtureFile(history, JSON.stringify(record));
        closeStore = await installRoutedW5GoldenStore();
        const runtime = runtimeWith(fakeHost().host);
        const user: CanopyCallerDescriptor = {
          ...caller(['core.worktree.read', 'core.worktree.write']),
          interfaceKind: 'desktop',
        };
        const { readWorkspaceWorktreesDetailed } =
          await import('../../lib/workspace-persistence');
        expect(
          await readWorkspaceWorktreesDetailed(workspaceId, {
            persistRemovalCleanup: false,
          }),
        ).toMatchObject({ authority: 'ok', worktrees: listed ? [row] : [] });
        const before = await runtime.query(
          'core.worktree.recovery.list',
          { workspaceId, operationId },
          { caller: user },
        );
        expect(before.entries[0]?.diagnosis).toMatchObject({
          verdict: listed ? 'finish-tail' : 'finish-journal',
        });
        await expectBrowserRetirementDeadline(() =>
          runtime.instruction(
            'core.worktree.recovery.finish',
            {
              workspaceId,
              operationId,
              revision: before.entries[0]?.diagnosis?.revision ?? '',
            },
            { caller: user },
          ),
        );
        const { readDestructiveJournal } =
          await import('@canopy/desktop-shared/node/w5-destructive-journal');
        const timedOut = await readDestructiveJournal(journal);
        expect(timedOut.cleanupRequired).toBe(true);
        expect(timedOut.steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              phase: 'deferred-browser-retirement',
              state: 'pending',
            }),
          ]),
        );
        const retry = await runtime.query(
          'core.worktree.recovery.list',
          { workspaceId, operationId },
          { caller: user },
        );
        const result = await runtime.instruction(
          'core.worktree.recovery.finish',
          {
            workspaceId,
            operationId,
            revision: retry.entries[0]?.diagnosis?.revision ?? '',
          },
          { caller: user },
        );
        const persisted = await readDestructiveJournal(journal);
        expect(result).toMatchObject({
          status: 'finished',
          cleanupRequired: false,
          gitCleanupPending: version === 3,
        });
        expect(persisted).toMatchObject({ operationId, state: 'completed' });
        if (version === 3 && captureRefused)
          expect(persisted.steps).toContainEqual({
            phase: 'git-capture',
            state: 'failed',
          });
        if (!listed)
          expect(await readFile(history, 'utf8')).toBe(
            await readFile(journal, 'utf8'),
          );
        expect(
          JSON.parse(
            await readFile(
              paths.getWorkspaceWorktreesFilePath(workspaceId),
              'utf8',
            ),
          ),
        ).toMatchObject({ worktrees: [] });
        expect(
          JSON.parse(
            await readFile(
              paths.getArchivedContainerManifestPath(workspaceId, worktreeId),
              'utf8',
            ),
          ),
        ).toEqual(manifest);
      } finally {
        try {
          try {
            await drainFixtureServices();
          } finally {
            await closeStore?.();
          }
        } finally {
          try {
            await searchService.close();
          } finally {
            searchFactory.mockRestore();
            profileFactory.mockRestore();
            if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
            else process.env.CANOPY_DATA_DIR = previous;
          }
        }
      }
    }),
  PERSISTENCE_TEST_TIMEOUT_MS,
);

it.each(['failed', 'pending'] as const)(
  'repairs every multi-repo turn-diff obligation (%s) only with matching files-only evidence',
  (secondStepState) =>
    runPersistenceFixture(async () => {
      const { mkdtemp, mkdir, lstat, readFile, realpath } =
        await import('node:fs/promises');
      const { execFileSync } = await import('node:child_process');
      const { randomUUID } = await import('node:crypto');
      const paths = await import('../../lib/paths');
      const { lifecycleJournalSlotName } =
        await import('../../lib/w5-destructive-recovery');
      const runtime = runtimeWith(fakeHost().host);
      const user: CanopyCallerDescriptor = {
        ...caller(['core.worktree.read', 'core.worktree.write']),
        interfaceKind: 'desktop',
      };
      const browser = await import('../../browser/browser-profile-service');
      const previous = process.env.CANOPY_DATA_DIR;
      const root = await mkdtemp(join(tmpdir(), 'finish-diff-generation-'));
      fixtureRoots.add(root);
      process.env.CANOPY_DATA_DIR = join(root, 'data');
      const factory = jest
        .spyOn(browser, 'getBrowserProfileService')
        .mockReturnValue(
          new browser.BrowserProfileService(
            process.env.CANOPY_DATA_DIR,
            join(root, 'sessions'),
          ),
        );
      try {
        const workspaceId = 'ws';
        const worktreeId = 'wt';
        const createdAt = '2026-11-01T00:00:00.000Z';
        const project = paths.getWorkspaceDir(workspaceId);
        await mkdir(project, { recursive: true });
        await writeFixtureFile(
          join(paths.getDataDir(), 'workspaces', 'index.json'),
          JSON.stringify({
            version: 1,
            workspaces: [
              { id: workspaceId, type: 'multi-repo', name: 'Recovery' },
            ],
          }),
        );
        const repositories = [];
        const git = (repo: string, ...args: string[]): string =>
          execFileSync('git', ['-C', repo, ...args], {
            encoding: 'utf8',
          }).trim();
        for (const name of ['repo-a', 'repo-b']) {
          const repo = join(root, name);
          await mkdir(repo);
          git(repo, 'init');
          git(
            repo,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            'commit',
            '--allow-empty',
            '-m',
            'fixture',
          );
          const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
          const turnRef = `refs/app/turn-diff-trees/${workspaceId}/${worktreeId}/${tree}`;
          git(repo, 'update-ref', turnRef, tree);
          const common = await realpath(join(repo, '.git'));
          const repoStat = await lstat(common);
          repositories.push({ repo, tree, turnRef, common, repoStat, name });
        }
        await writeFixtureFile(
          paths.getWorkspaceConfigPath(workspaceId),
          JSON.stringify({
            version: 1,
            type: 'multi-repo',
            repos: repositories.map(({ repo, name }) => ({
              id: name,
              name,
              repoPath: repo,
              relativePath: name,
            })),
          }),
        );
        await writeFixtureFile(
          paths.getWorkspaceWorktreesFilePath(workspaceId),
          JSON.stringify({ version: 1, worktrees: [] }),
        );
        const recovery = {
          kind: 'files-only',
          source: 'absent',
          digest: '0'.repeat(64),
          payloadId: randomUUID(),
        };
        const manifest = {
          version: 3,
          kind: 'worktree',
          id: worktreeId,
          projectId: workspaceId,
          name: 'Archive',
          createdAt,
          archivedAt: createdAt,
          retentionDays: 30,
          expiresAt: '2026-12-01T00:00:00.000Z',
          chatCount: 0,
          archivedChatCount: 0,
          executionCount: 0,
          workspaceType: 'multi-repo',
          originalWorktree: {
            id: worktreeId,
            branchName: 'feature/x',
            createdAt,
          },
          recovery,
        };
        const archive = paths.getArchivedContainerDir(workspaceId, worktreeId);
        await mkdir(archive, { recursive: true });
        await writeFixtureFile(
          paths.getArchivedContainerManifestPath(workspaceId, worktreeId),
          JSON.stringify(manifest),
        );
        const staged = {
          version: 1,
          createdAt,
          phase: 'removed',
          recovery: { ...recovery, payloadId: randomUUID() },
          repositories: repositories.map(
            ({ repo, common, repoStat, name }) => ({
              referenceRepoPath: repo,
              repositoryIdentity: {
                path: common,
                dev: repoStat.dev,
                ino: repoStat.ino,
                birthtimeMs: repoStat.birthtimeMs,
              },
              relativePath: name,
              worktreePaths: [],
            }),
          ),
        };
        const stagedPath = join(archive, 'recovery.staged.json');
        await writeFixtureFile(stagedPath, JSON.stringify(staged));
        const projectStat = await lstat(project);
        const operationId = randomUUID();
        const record = {
          version: 1,
          operationId,
          operation: 'worktree-archive',
          workspaceId,
          worktreeId,
          createdAt,
          directoryIdentity: `${projectStat.dev}:${projectStat.ino}:${projectStat.birthtimeMs}`,
          state: 'completed',
          cleanupRequired: true,
          ownedPaths: [],
          steps: [
            ...[
              'retained-git-cleanup',
              'pipeline-cleanup',
              'retained-manifest-commit',
              'canonical-row-removal',
              'deferred-browser-retirement',
            ].map((phase) => ({ phase, state: 'done' })),
            { phase: 'turn-diff-cleanup', state: 'failed' },
            { phase: 'turn-diff-cleanup', state: secondStepState },
          ],
        };
        const directory = paths.getW5DestructiveLifecycleDir();
        await mkdir(directory, { recursive: true });
        const journal = join(
          directory,
          lifecycleJournalSlotName(workspaceId, worktreeId),
        );
        await writeFixtureFile(journal, JSON.stringify(record));
        const before = await runtime.query(
          'core.worktree.recovery.list',
          { workspaceId, operationId },
          { caller: user },
        );
        expect(before.entries[0]?.diagnosis?.verdict).toBe('cleanup-debt');
        expect(before.entries[0]?.actions.finishArchive.eligible).toBe(false);
        expect(before.entries[0]?.actions.retry.eligible).toBe(false);
        const result = await runtime.instruction(
          'core.worktree.recovery.finish',
          {
            workspaceId,
            operationId,
            revision: before.entries[0]?.diagnosis?.revision ?? '',
          },
          { caller: user },
        );
        expect(result).toMatchObject({
          status: 'interrupted',
          check: 'turn-diff-evidence-unavailable',
        });
        const interruptedRepair = await runtime.query(
          'core.worktree.recovery.list',
          { workspaceId, operationId },
          { caller: user },
        );
        expect(
          interruptedRepair.entries[0]?.actions.finishArchive.eligible,
        ).toBe(false);
        expect(interruptedRepair.entries[0]?.actions.retry.eligible).toBe(
          false,
        );
        const { readDestructiveJournal } =
          await import('@canopy/desktop-shared/node/w5-destructive-journal');
        expect((await readDestructiveJournal(journal)).steps).toContainEqual({
          phase: 'turn-diff-cleanup',
          state: 'pending',
          code: 'recovery-required',
        });
        for (const { repo, turnRef, tree } of repositories)
          expect(git(repo, 'show-ref', '--hash', turnRef)).toBe(tree);
        expect(
          (await readDestructiveJournal(journal)).steps.filter(
            (step) => step.phase === 'turn-diff-cleanup',
          ),
        ).toEqual([
          {
            phase: 'turn-diff-cleanup',
            state: 'pending',
            code: 'recovery-required',
          },
          { phase: 'turn-diff-cleanup', state: secondStepState },
        ]);
        expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({
          cleanupRequired: true,
        });
        expect(JSON.parse(await readFile(stagedPath, 'utf8'))).toEqual(staged);
        const matched = { ...staged, recovery };
        await writeFixtureFile(stagedPath, JSON.stringify(matched));
        // Current project settings are not authority for this historical repair.
        await writeFixtureFile(
          paths.getWorkspaceConfigPath(workspaceId),
          JSON.stringify({
            version: 1,
            type: 'single-repo',
            repoPath: join(root, 'replacement-source'),
            repos: [],
          }),
        );
        const retry = await runtime.query(
          'core.worktree.recovery.list',
          { workspaceId, operationId },
          { caller: user },
        );
        expect(
          await runtime.instruction(
            'core.worktree.recovery.finish',
            {
              workspaceId,
              operationId,
              revision: retry.entries[0]?.diagnosis?.revision ?? '',
            },
            { caller: user },
          ),
        ).toMatchObject({ status: 'finished', cleanupRequired: false });
        for (const { repo, turnRef } of repositories)
          expect(
            git(repo, 'for-each-ref', '--format=%(refname)', turnRef),
          ).toBe('');
        const completed = await readDestructiveJournal(journal);
        expect(completed).toMatchObject({
          state: 'completed',
          cleanupRequired: false,
        });
        expect(
          completed.steps.filter((step) => step.phase === 'turn-diff-cleanup'),
        ).toEqual([
          { phase: 'turn-diff-cleanup', state: 'done' },
          { phase: 'turn-diff-cleanup', state: 'done' },
        ]);
        expect(JSON.parse(await readFile(stagedPath, 'utf8'))).toEqual(matched);
        expect(
          JSON.parse(
            await readFile(
              paths.getArchivedContainerManifestPath(workspaceId, worktreeId),
              'utf8',
            ),
          ),
        ).toEqual(manifest);
        const warning =
          'Failed to clean up worktree metadata: permission denied';
        await writeFixtureFile(
          journal,
          JSON.stringify({
            ...record,
            steps: [
              ...record.steps,
              { phase: 'sidecar:worktree metadata', state: 'failed' },
            ],
            outcome: { success: true, warnings: [warning] },
          }),
        );
        const sidecar = await runtime.query(
          'core.worktree.recovery.list',
          { workspaceId, operationId },
          { caller: user },
        );
        expect(
          await runtime.instruction(
            'core.worktree.recovery.finish',
            {
              workspaceId,
              operationId,
              revision: sidecar.entries[0]?.diagnosis?.revision ?? '',
            },
            { caller: user },
          ),
        ).toMatchObject({ status: 'cleanup-pending', cleanupRequired: true });
        const persisted = await readDestructiveJournal(journal);
        expect(persisted).toMatchObject({ outcome: { warnings: [warning] } });
        expect(persisted.steps).toContainEqual({
          phase: 'sidecar:worktree metadata',
          state: 'failed',
        });
      } finally {
        await drainFixtureServices();
        factory.mockRestore();
        if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
        else process.env.CANOPY_DATA_DIR = previous;
      }
    }),
  PERSISTENCE_TEST_TIMEOUT_MS,
);

persistenceIt(
  'reconciles cold journal incidents explicitly without scanning on status polling or losing unrelated evidence',
  async () => {
    await jest.isolateModulesAsync(async () => {
      const { mkdtemp, mkdir, rm, realpath } = await import('node:fs/promises');
      const inspection =
        await import('@canopy/desktop-shared/node/w5-destructive-journal');
      const scan = jest.spyOn(inspection, 'inspectDestructiveJournals');
      const gates = await import('../../lib/w5-recovery-gates');
      const handoff = await import('../w5-flip-handoff');
      const requests = await import('../../lib/w5-recovery-request');
      const { getDesktopW5RecoveryController } =
        await import('../desktop-w5-recovery');
      const previous = process.env.CANOPY_DATA_DIR;
      const root = await mkdtemp(join(tmpdir(), 'finish-cold-'));
      fixtureRoots.add(root);
      const dataRoot = await realpath(root);
      process.env.CANOPY_DATA_DIR = dataRoot;
      const enabled = jest
        .spyOn(gates, 'isW5RecoveryAvailable')
        .mockReturnValue(true);
      const status = jest
        .spyOn(handoff, 'getW5FlipHandoffStatus')
        .mockReturnValue({ state: 'degraded', reason: 'daemon_unavailable' });
      try {
        await mkdir(join(dataRoot, 'runtime'), { mode: 0o700 });
        const entries = [
          {
            id: 'log',
            operation: 'Workspace records',
            detail: 'Unrelated damaged log',
          },
          {
            id: 'file:other',
            operation: 'Workspace records',
            detail: 'Unrelated damaged file',
          },
          {
            id: 'journals',
            operation: 'Workspace records',
            detail: 'Journal files need support',
          },
        ];
        await writeFixtureFile(
          requests.w5RecoveryResultPath(dataRoot),
          JSON.stringify({
            version: 1,
            finishedAt: Date.now(),
            status: { state: 'blocked', canRecover: true, entries },
          }),
          { mode: 0o600 },
        );
        const paths = await import('../../lib/paths');
        await mkdir(paths.getW5DestructiveLifecycleDir(), {
          recursive: true,
        });
        await writeFixtureFile(
          join(paths.getW5DestructiveLifecycleDir(), 'unknown-artifact'),
          'preserve',
        );
        expect(await requests.readW5RecoveryResult(dataRoot)).toMatchObject({
          entries,
        });
        const controller = getDesktopW5RecoveryController();
        expect(await controller.status()).toMatchObject({ entries });
        expect(scan).not.toHaveBeenCalled();
        expect(await controller.refreshJournals()).toMatchObject({ entries });
        expect(scan).toHaveBeenCalledTimes(1);
        await rm(
          join(paths.getW5DestructiveLifecycleDir(), 'unknown-artifact'),
        );
        const remaining = entries.filter((entry) => entry.id !== 'journals');
        expect(await controller.refreshJournals()).toMatchObject({
          entries: remaining,
        });
        expect(await controller.status()).toMatchObject({
          entries: remaining,
        });
        expect(scan).toHaveBeenCalledTimes(2);
      } finally {
        await drainFixtureServices();
        const portal = await import('../../portal/portal-structural-sync');
        const snapshots =
          await import('../../services/desktop-session-snapshot-invalidation');
        portal.cancelPortalStructuralSync();
        snapshots.cancelDesktopSessionSnapshotInvalidation();
        scan.mockRestore();
        status.mockRestore();
        enabled.mockRestore();
        if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
        else process.env.CANOPY_DATA_DIR = previous;
      }
    });
  },
);

test('core.worktree.recovery.resolve grants no agent or remote resolution authority', async () => {
  const runtime = runtimeWith(fakeHost().host);
  const { randomUUID } = await import('node:crypto');
  const request = {
    workspaceId: 'ws',
    operationId: randomUUID(),
    revision: 'a'.repeat(64),
    action: 'release' as const,
  };
  await expect(
    runtime.instruction('core.worktree.recovery.resolve', request, {
      caller: caller(['core.worktree.write']),
    }),
  ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  const foreign: CanopyCallerDescriptor = {
    ...caller(['core.worktree.write'], 'foreign'),
    interfaceKind: 'desktop',
  };
  await expect(
    runtime.instruction('core.worktree.recovery.resolve', request, {
      caller: foreign,
    }),
  ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  const noGrant: CanopyCallerDescriptor = {
    ...caller([]),
    interfaceKind: 'desktop',
  };
  await expect(
    runtime.instruction('core.worktree.recovery.resolve', request, {
      caller: noGrant,
    }),
  ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
});

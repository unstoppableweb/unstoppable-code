import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCHIVE_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  ArchivedContainerSummary,
  ArchivedContainerSummaryV1,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { CoreWorkspaceLifecycleHost } from '@canopy/core-runtime/node/workspace/lifecycle-commands';
import type { CoreArchiveHost } from '../core-archive-adapter';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';

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

let root: string;
const runtimes: DesktopCanopyDispatcher[] = [];
function runtimeWith(
  host: CoreArchiveHost,
  workspaceLifecycleHost?: CoreWorkspaceLifecycleHost,
): DesktopCanopyDispatcher {
  const runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(root, `ledger-${runtimes.length}.sqlite`),
    }),
    archiveHost: host,
    ...(workspaceLifecycleHost && { workspaceLifecycleHost }),
    shutdownTimeoutMs: 25,
  });
  runtimes.push(runtime);
  return runtime;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'core-archive-'));
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  rmSync(root, { recursive: true, force: true });
});

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
});

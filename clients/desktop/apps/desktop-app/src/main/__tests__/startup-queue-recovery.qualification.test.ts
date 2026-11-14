import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { scanInterruptedWork } from '../lib/interrupted-work-scan-worker';
import { createWorkspaceStartupBarrier } from '../lib/workspace-startup';
import {
  createQueueHarness,
  queuedRequest,
} from '../services/__tests__/helpers/queue-harness';

const target = { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' };

describe('local workspace startup admission', () => {
  it('holds every window and replays completion to a reloaded window', async () => {
    const barrier = createWorkspaceStartupBarrier();
    const mounted = jest.fn();
    const main = barrier.wait().then(mounted);
    const advisor = barrier.wait().then(mounted);
    await Promise.resolve();
    expect(mounted).not.toHaveBeenCalled();
    barrier.complete();
    await Promise.all([main, advisor]);
    expect(mounted).toHaveBeenCalledTimes(2);
    await expect(barrier.wait()).resolves.toBeUndefined();
  });

  it('never admits pending windows after shutdown cancellation', async () => {
    const barrier = createWorkspaceStartupBarrier();
    const settled = jest.fn();
    void barrier.wait().then(settled, settled);
    barrier.cancel();
    barrier.complete();
    barrier.refuse(new Error('late startup failure'));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
  });

  it('retains early startup failure for a later window', async () => {
    const barrier = createWorkspaceStartupBarrier();
    const error = new Error('startup failed');
    barrier.refuse(error);
    await Promise.resolve();
    await expect(barrier.wait()).rejects.toBe(error);
  });

  it('keeps window creation ahead of the W5 sequence without reopening during quit', async () => {
    const source = await readFile(join(__dirname, '..', 'index.ts'), 'utf8');
    const startup = source.slice(source.indexOf('void app.whenReady().then'));
    const window = startup.indexOf('createWindowWithState(preferences);');
    const handoff = startup.indexOf('await w5Handoff;');
    const handoffStart = startup.indexOf(
      'const w5Handoff = startW5FlipHandoff({ admission: w5Host });',
    );
    const queueHold = startup.indexOf(
      'getStartupChatQueue().holdDrainsForStartup();',
    );
    expect(window).toBeGreaterThan(-1);
    expect(handoffStart).toBeGreaterThan(-1);
    expect(handoffStart).toBeLessThan(window);
    expect(handoff).toBeGreaterThan(window);
    expect(queueHold).toBeGreaterThan(-1);
    expect(queueHold).toBeLessThan(window);
    const resume = startup.slice(
      startup.indexOf('await rendererOriginDecided;'),
      window,
    );
    expect(resume).toContain('if (appIsQuitting) return;');
    const stages = [
      'await w5Handoff;',
      'await getForeignActivityCarryoverService().initialize();',
      'await migrateAppManagedChatWorkspaces();',
      'await migrateAppAdvisorChatsToWorkEntries();',
      'await migrateStandaloneChatToCowork();',
      'await loadCoworkMigrationMapCache();',
      'await migrateCoworkChatsToWorkEntries();',
      'await migrateDefaultCoworkWorkspaceName();',
      'await recoverInterruptedWorkAtStartup();',
      'sweepInterruptedPipelinesAtStartup()',
      'releaseStartupDrainHold();',
      'startWorktreeBranchObserver({',
      'workspaceStartup.complete();',
      'startupRecoveryPromise = finishWorkspaceStartup();',
    ].map((stage) => startup.indexOf(stage));
    expect(stages.every((position) => position > window)).toBe(true);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    const normalized = startup.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      'getOrgProjectMaterialization() .sweepInterruptedSetups()',
    );
    expect(normalized).toContain(
      '(async (): Promise<void> => { await staleCodexCleanup; if (appIsQuitting) return; await recoverInterruptedWorkAtStartup(); })',
    );
  });
});

async function writeScope(
  root: string,
  queuedMessages: readonly Record<string, unknown>[],
): Promise<void> {
  await mkdir(join(root, 'ws-1', 'chat-storage-manifests'), {
    recursive: true,
  });
  await mkdir(join(root, 'ws-1', 'chat-storage-v2', 'wt-1'), {
    recursive: true,
  });
  await writeFile(
    join(root, 'ws-1', 'chat-storage-manifests', 'wt-1.json'),
    JSON.stringify({ version: 2, scopeId: 'wt-1' }),
  );
  await writeFile(
    join(root, 'ws-1', 'chat-storage-v2', 'wt-1', 'live-index.json'),
    JSON.stringify({
      version: 2,
      tabs: [],
      runtimeByChatId: {
        'chat-1': { status: 'idle', queuedMessageIds: [], queuedMessages },
      },
    }),
  );
}

function queuedRowIds(
  harness: ReturnType<typeof createQueueHarness>,
): string[] {
  return harness.service
    .getWorktreeSnapshots('ws-1', 'wt-1')
    .filter((event) => event.chatId === 'chat-1')
    .flatMap((event) => event.queue.map((message) => message.id));
}

describe('queued chats recover at startup (CAN-4112)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(os.tmpdir(), 'startup-queue-recovery-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('recovers an acknowledged send left admitting with no window', async () => {
    await writeScope(root, [
      {
        id: 'admission:m1',
        request: {},
        origin: 'desktop',
        enqueuedAtMs: 1,
        admitting: true,
      },
    ]);

    const scan = await scanInterruptedWork([root], join(root, 'none'));

    expect(scan.chatScopes).toEqual([
      { projectId: 'ws-1', worktreeId: 'wt-1' },
    ]);
  });

  it('keeps an idle chat with no queued work out of recovery', async () => {
    await writeScope(root, []);

    const scan = await scanInterruptedWork([root], join(root, 'none'));

    expect(scan.chatScopes).toEqual([]);
  });

  it('recovered queues wait for the core to accept', async () => {
    const harness = createQueueHarness();
    harness.service.holdDrainsForStartup();
    harness.service.hydratePersistedInput(
      queuedRequest(target, 'm1'),
      'row-1',
      'desktop',
      1,
    );
    harness.service.releaseInputOwnership(target);
    await harness.flush();

    expect(harness.dispatches).toEqual([]);
    expect(queuedRowIds(harness)).toContain('row-1');

    harness.service.releaseStartupDrainHold();
    await harness.flush();

    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]).toMatchObject({
      request: { userMessageId: 'm1' },
      fromQueue: true,
    });
  });

  it('edits and cancels apply while drains wait', async () => {
    const harness = createQueueHarness();
    harness.service.holdDrainsForStartup();
    harness.service.hydratePersistedInput(
      queuedRequest(target, 'm1'),
      'row-1',
      'desktop',
      1,
    );
    harness.service.hydratePersistedInput(
      queuedRequest(target, 'm2'),
      'row-2',
      'desktop',
      2,
    );
    harness.service.releaseInputOwnership(target);

    await expect(harness.service.cancel(target, 'row-1')).resolves.toBe(
      'applied',
    );

    harness.service.releaseStartupDrainHold();
    await harness.flush();

    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]?.request.userMessageId).toBe('m2');
  });

  it('releases recovered queues only after the chat dispatch hooks are installed', async () => {
    // Electron main's startup cannot run under Jest; pin the order instead.
    // A recovered queued Auto send that drained before `registerAllIpcHandlers`
    // installed `setAutoModelRoutingDispatcher` ran on its stored model.
    const source = await readFile(join(__dirname, '..', 'index.ts'), 'utf8');
    const runtimeInstalled = source.indexOf(
      'setDesktopCanopyRuntime(desktopCanopyRuntime);',
    );
    const handlersRegistered = source.indexOf(
      'closeChatStatePush = registerAllIpcHandlers(',
    );
    const released = source.indexOf('.releaseStartupDrainHold();');

    expect(runtimeInstalled).toBeGreaterThan(-1);
    expect(handlersRegistered).toBeGreaterThan(runtimeInstalled);
    expect(released).toBeGreaterThan(handlersRegistered);
    expect(source.indexOf('.releaseStartupDrainHold();', released + 1)).toBe(
      -1,
    );
  });
});

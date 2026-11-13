import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANAGED_DELEGATION_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  AgentDelegationError,
  AgentDelegationSnapshot,
  ManagedDelegationTreeEntry,
} from '@canopy/protocol/delegation';
import type { ManagedDelegationMessageRequest } from '@canopy/desktop-shared/types';
import type { CoreManagedDelegationHost } from '../core-managed-delegation-adapter';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';

const caller = (
  grants: CanopyCallerDescriptor['grants'],
  interfaceKind: CanopyCallerDescriptor['interfaceKind'] = 'desktop',
): CanopyCallerDescriptor => ({
  principalId: 'desktop-delegation-viewer',
  clientInstanceId: 'desktop-main',
  authorityId: 'local',
  interfaceKind,
  grants,
});
const READ = caller([MANAGED_DELEGATION_GRANTS.read]);
const CONTROL = caller([MANAGED_DELEGATION_GRANTS.control]);
const AGENT = caller(
  [MANAGED_DELEGATION_GRANTS.read, MANAGED_DELEGATION_GRANTS.control],
  'mcp',
);
const CHAT = { scope: { workspaceId: 'p', worktreeId: 'w' }, chatId: 'c' };
const TARGET = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
const meta = (key: string): { idempotencyKey: string } => ({
  idempotencyKey: key,
});

const snapshot = (
  delegationId: string,
  extra: Partial<AgentDelegationSnapshot> = {},
): AgentDelegationSnapshot => ({
  delegationId,
  status: 'running',
  outputTruncated: false,
  runGeneration: 1,
  phase: 'running',
  ...extra,
});

const entry = (
  value: AgentDelegationSnapshot,
  createdAt: number,
): ManagedDelegationTreeEntry => ({
  snapshot: value,
  description: value.delegationId,
  prompt: 'Work',
  executionMode: 'background',
  runGeneration: value.runGeneration ?? 1,
  sequence: createdAt,
  createdAt,
  parentHarnessId: 'claude',
});

interface Calls {
  inspects: unknown[];
  stops: unknown[];
  stopAlls: unknown[];
  messages: ManagedDelegationMessageRequest[];
  lifetimes: unknown[];
  trees: unknown[];
}

let tree: ManagedDelegationTreeEntry[] = [];
let messageResult: Awaited<ReturnType<CoreManagedDelegationHost['message']>>;
let stopFailure: AgentDelegationError | undefined;

function fakeHost(): { host: CoreManagedDelegationHost; calls: Calls } {
  const calls: Calls = {
    inspects: [],
    stops: [],
    stopAlls: [],
    messages: [],
    lifetimes: [],
    trees: [],
  };
  const host: CoreManagedDelegationHost = {
    inspect: (target, delegationId) => {
      calls.inspects.push({ target, delegationId });
      if (delegationId === 'foreign')
        return Promise.resolve({
          ok: false,
          error: {
            code: 'parent_unavailable',
            message: 'That delegation is not one of your descendants.',
            retryable: false,
          },
        });
      return Promise.resolve({
        ok: true,
        value: delegationId === 'gone' ? null : snapshot(delegationId),
      });
    },
    tree: (target) => {
      calls.trees.push(target);
      return Promise.resolve(tree);
    },
    stop: (target, delegationId) => {
      calls.stops.push({ target, delegationId });
      return Promise.resolve(
        stopFailure
          ? { ok: false, error: stopFailure }
          : {
              ok: true,
              value: snapshot(delegationId, { status: 'cancelled' }),
            },
      );
    },
    stopAll: (target) => {
      calls.stopAlls.push(target);
      return Promise.resolve({ ok: true, value: { stopped: 3 } });
    },
    message: (request) => {
      calls.messages.push(request);
      return Promise.resolve(messageResult);
    },
    lifetime: (scope) => {
      calls.lifetimes.push(scope);
      return Promise.resolve({
        kind: 'available',
        occupied: 7,
        retained: 6,
        limit: 512,
        cap: 512,
        atLimit: false,
        canExtend: false,
        atCap: true,
        refusedChatIds: [],
      });
    },
  };
  return { host, calls };
}

let root: string;
let runtime: DesktopCanopyDispatcher;
let calls: Calls;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'core-managed-delegation-'));
  tree = [];
  stopFailure = undefined;
  messageResult = {
    ok: true,
    snapshot: snapshot('d1', { runGeneration: 2, phase: 'queued' }),
  };
  const fake = fakeHost();
  calls = fake.calls;
  runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(root, 'ledger.sqlite'),
    }),
    managedDelegationHost: fake.host,
    shutdownTimeoutMs: 25,
  });
});
afterEach(async () => {
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('core.managedDelegation on the desktop dispatcher (CAN-6291)', () => {
  it('reads one delegation of the chat, and refuses a missing or foreign one alike', async () => {
    await expect(
      runtime.query(
        'core.managedDelegation.get',
        { ...CHAT, delegationId: 'd1' },
        { caller: READ },
      ),
    ).resolves.toMatchObject({ delegationId: 'd1', status: 'running' });
    await expect(
      runtime.query(
        'core.managedDelegation.get',
        { ...CHAT, delegationId: 'gone' },
        { caller: READ },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.managedDelegation.notFound' },
    });
    await expect(
      runtime.query(
        'core.managedDelegation.get',
        { ...CHAT, delegationId: 'foreign' },
        { caller: READ },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'core.managedDelegation.parentUnavailable',
      },
    });
    expect(calls.inspects).toEqual([
      { target: TARGET, delegationId: 'd1' },
      { target: TARGET, delegationId: 'gone' },
      { target: TARGET, delegationId: 'foreign' },
    ]);
  });

  it('lists in creation order, narrows to a subtree and pages by cursor', async () => {
    tree = [
      entry(snapshot('b', { parentDelegationId: 'a' }), 2),
      entry(snapshot('a', { status: 'completed', runGeneration: 1 }), 1),
      entry(snapshot('a', { status: 'running', runGeneration: 2 }), 1),
      entry(snapshot('c', { parentDelegationId: 'b' }), 3),
      entry(snapshot('z'), 4),
      ...Array.from({ length: 100 }, (_, index) =>
        entry(snapshot(`n${index}`), 10 + index),
      ),
    ];
    const first = await runtime.query('core.managedDelegation.list', CHAT, {
      caller: READ,
    });
    expect(first.items).toHaveLength(100);
    expect(first.items.slice(0, 4).map((item) => item.delegationId)).toEqual([
      'a',
      'b',
      'c',
      'z',
    ]);
    expect(first.items[0]).toMatchObject({
      status: 'running',
      runGeneration: 2,
    });
    expect(first.nextCursor).toBe('100');
    const second = await runtime.query(
      'core.managedDelegation.list',
      { ...CHAT, cursor: '100' },
      { caller: READ },
    );
    expect(second.items.map((item) => item.delegationId)).toEqual([
      'n96',
      'n97',
      'n98',
      'n99',
    ]);
    expect(second.nextCursor).toBeNull();
    const subtree = await runtime.query(
      'core.managedDelegation.list',
      { ...CHAT, underDelegationId: 'a' },
      { caller: READ },
    );
    expect(subtree.items.map((item) => item.delegationId)).toEqual(['b', 'c']);
    await expect(
      runtime.query(
        'core.managedDelegation.list',
        { ...CHAT, cursor: 'x' },
        { caller: READ },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
  });

  it('reads the worktree’s lifetime use against its limit', async () => {
    await expect(
      runtime.query('core.managedDelegation.lifetime.get', CHAT, {
        caller: READ,
      }),
    ).resolves.toEqual({ used: 7, limit: 512 });
    expect(calls.lifetimes).toEqual([{ projectId: 'p', worktreeId: 'w' }]);
  });

  it('messages a delegate once per key, retries a busy one and refuses ifBusy reject', async () => {
    const params = {
      ...CHAT,
      delegationId: 'd1',
      operation: 'follow_up' as const,
      message: 'Also check the tests.',
      ifBusy: 'queue' as const,
      operationId: '6f1c1f53-6c0b-4d8e-9c3a-1f0b2d3e4a5b',
      _meta: meta('m1'),
    };
    const first = await runtime.instruction(
      'core.managedDelegation.message',
      params,
      { caller: CONTROL, metadata: meta('m1') },
    );
    expect(first).toEqual({ runGeneration: 2, phase: 'queued' });
    await expect(
      runtime.instruction('core.managedDelegation.message', params, {
        caller: CONTROL,
        metadata: meta('m1'),
      }),
    ).resolves.toEqual(first);
    expect(calls.messages).toEqual([
      {
        ...TARGET,
        delegationId: 'd1',
        operation: 'follow_up',
        message: 'Also check the tests.',
        operationId: params.operationId,
      },
    ]);
    await expect(
      runtime.instruction(
        'core.managedDelegation.message',
        { ...params, message: 'Other', _meta: meta('m1') },
        { caller: CONTROL, metadata: meta('m1') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    await expect(
      runtime.instruction(
        'core.managedDelegation.message',
        { ...params, ifBusy: 'reject', _meta: meta('m2') },
        { caller: CONTROL, metadata: meta('m2') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    messageResult = {
      ok: false,
      code: 'busy',
      error: 'The delegate already has a command pending.',
    };
    const busy = { ...params, _meta: meta('m3') };
    await expect(
      runtime.instruction('core.managedDelegation.message', busy, {
        caller: CONTROL,
        metadata: meta('m3'),
      }),
    ).rejects.toMatchObject({
      payload: { kind: 'failed_precondition', retry: { kind: 'never' } },
    });
    // The broker answers this operation's recorded refusal to any retry, so
    // the dispatcher replays it too; a new message takes a new operationId.
    messageResult = {
      ok: true,
      snapshot: snapshot('d1', { runGeneration: 3 }),
    };
    await expect(
      runtime.instruction('core.managedDelegation.message', busy, {
        caller: CONTROL,
        metadata: meta('m3'),
      }),
    ).rejects.toMatchObject({ payload: { kind: 'failed_precondition' } });
    await expect(
      runtime.instruction(
        'core.managedDelegation.message',
        {
          ...params,
          operationId: '0b7d5a3e-2f4c-4e1a-8b6d-9c8f7e6d5a4b',
          _meta: meta('m4'),
        },
        { caller: CONTROL, metadata: meta('m4') },
      ),
    ).resolves.toEqual({ runGeneration: 3, phase: 'running' });
    expect(calls.messages).toHaveLength(3);
  });

  it('stops one delegation and stops all of the chat’s', async () => {
    await expect(
      runtime.instruction(
        'core.managedDelegation.stop',
        { ...CHAT, delegationId: 'd1', _meta: meta('s1') },
        { caller: CONTROL, metadata: meta('s1') },
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(
      runtime.instruction(
        'core.managedDelegation.stopAll',
        { ...CHAT, _meta: meta('s2') },
        { caller: CONTROL, metadata: meta('s2') },
      ),
    ).resolves.toEqual({ stopped: 3 });
    // A retry with fresh request metadata replays the first outcome.
    await expect(
      runtime.instruction(
        'core.managedDelegation.stop',
        {
          ...CHAT,
          delegationId: 'd1',
          _meta: { ...meta('s1'), deadlineAt: '2026-11-11T12:00:00Z' },
        },
        { caller: CONTROL, metadata: meta('s1') },
      ),
    ).resolves.toEqual({ accepted: true });
    expect(calls.stops).toEqual([{ target: TARGET, delegationId: 'd1' }]);
    expect(calls.stopAlls).toEqual([TARGET]);
  });

  it('runs a stop again for the same key after a failure that offers a retry', async () => {
    stopFailure = {
      code: 'launch_uncertain',
      message: 'The stop could not be confirmed.',
      retryable: true,
    };
    const params = { ...CHAT, delegationId: 'd1', _meta: meta('s3') };
    await expect(
      runtime.instruction('core.managedDelegation.stop', params, {
        caller: CONTROL,
        metadata: meta('s3'),
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        code: 'core.managedDelegation.launchUncertain',
        retry: { kind: 'same_idempotency_key' },
      },
    });
    stopFailure = undefined;
    await expect(
      runtime.instruction('core.managedDelegation.stop', params, {
        caller: CONTROL,
        metadata: meta('s3'),
      }),
    ).resolves.toEqual({ accepted: true });
    expect(calls.stops).toHaveLength(2);
  });

  it('answers capability_unavailable for the calls only an agent’s turn makes', async () => {
    await expect(
      runtime.query(
        'core.managedDelegation.output.read',
        { ...CHAT, delegationId: 'd1' },
        { caller: READ },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    await expect(
      runtime.query('core.managedDelegation.models.list', CHAT, {
        caller: READ,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    await expect(
      runtime.instruction(
        'core.managedDelegation.spawn',
        {
          ...CHAT,
          modelId: 'claude-opus',
          description: 'Review',
          prompt: 'Review the diff.',
          _meta: meta('a1'),
        },
        { caller: CONTROL, metadata: meta('a1') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    await expect(
      runtime.instruction(
        'core.managedDelegation.steering.request',
        { message: 'Which file?', _meta: meta('a2') },
        { caller: CONTROL, metadata: meta('a2') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    await expect(
      runtime.instruction(
        'core.managedDelegation.workspace.manage',
        { ...CHAT, delegationId: 'd1', operation: 'apply', _meta: meta('a3') },
        { caller: CONTROL, metadata: meta('a3') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
  });

  it('refuses an agent caller and a missing grant before the broker is reached', async () => {
    await expect(
      runtime.instruction(
        'core.managedDelegation.stopAll',
        { ...CHAT, _meta: meta('x1') },
        { caller: AGENT, metadata: meta('x1') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    await expect(
      runtime.query(
        'core.managedDelegation.get',
        { ...CHAT, delegationId: 'd1' },
        { caller: CONTROL },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      runtime.instruction(
        'core.managedDelegation.stop',
        { ...CHAT, delegationId: 'd1', _meta: meta('x2') },
        { caller: READ, metadata: meta('x2') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(calls.stopAlls).toEqual([]);
    expect(calls.inspects).toEqual([]);
    expect(calls.stops).toEqual([]);
  });
});

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkerAgentTurnRunParamsSchema,
  type CanopyCallerDescriptor,
  type OperationRecord,
  type WorkerAgentTurnRunParams,
} from '@canopy/protocol/canopy-core';
import type { TurnEventSink } from '@canopy/core-runtime/node/agent/turns';
import {
  readFilesystemScope,
  type FilesystemRoot,
  type FilesystemScopeCatalog,
} from '@canopy/core-runtime/node';
import {
  getApprovalDefaultsRevision,
  getChatApprovalStateRevision,
  getGlobalApprovalRulesRevision,
  getGlobalApprovalRulesSaveGeneration,
  getWorkspaceApprovalRulesRevision,
  getWorkspaceApprovalRulesSaveGeneration,
  markApprovalDefaultsChanged,
  markChatApprovalStateChanged,
  markWorkspaceApprovalRulesChanged,
  trackWorkspaceApprovalRulesSave,
} from '../../approvals/rule-revisions';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../../canopy-runtime/core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { stopChatTurnExactly } from '../../canopy-runtime/chat-turn-stop';
import { stopChatTurn } from '../../lib/chat-turn-stop';
import { cancelStandaloneChat } from '../../services/standalone-chat-service';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { AgentProvider, AgentSessionOptions } from '../../agents/types';
import {
  setWorkerProviderRuntimeForTests,
  workerProviderRuntimeFor,
  type WorkerProviderRuntime,
} from '../worker-provider-runtimes';
import {
  TurnWorkerUnavailableError,
  beginChatTurnRun,
  deferredReloadEventNamespace,
  emitChatTurnWait,
  type BeginChatTurnRunRequest,
} from '../turn-runs';
import { windowAgentInterfacePort } from '../../agents/agent-interface-port';

jest.mock('@canopy/core-runtime/node', () => ({
  ...jest.requireActual<object>('@canopy/core-runtime/node'),
  readFilesystemScope: jest.fn(),
}));
jest.mock('../../canopy-runtime/daemon-scope-resolver', () => ({
  getDaemonScopeResolver: (): Promise<() => Promise<object>> =>
    Promise.resolve((): Promise<object> => Promise.resolve({})),
}));
jest.mock('../../lib/main-process-logging', () => ({
  ...jest.requireActual<object>('../../lib/main-process-logging'),
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../../canopy-runtime/chat-turn-stop', () => ({
  stopChatTurnExactly: jest.fn(() => Promise.resolve(null)),
}));
// The provider stops silently: Stop settles the turn in chat state only.
jest.mock('../../lib/chat-turn-cancel', () => ({
  cancelChatTurn: jest.fn(() => Promise.resolve({ outcome: 'interrupted' })),
  captureChatTurnStop: jest.fn(),
  captureChatTurnStopsForChat: jest.fn(() => []),
  adoptPreparingSendSession: jest.fn((context: unknown) => context),
  isChatTurnStopCurrent: jest.fn(() => true),
}));
jest.mock('../../services/chat-queue-service', () => ({
  getChatQueueService: (): object => ({ onTurnTerminal: jest.fn() }),
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    journalIdleStop: jest.fn(() => Promise.resolve()),
    ingestProviderEventWithResult: jest.fn(() =>
      Promise.resolve({ outcome: 'applied' }),
    ),
    getCompatibilityArchives: jest.fn(() => Promise.resolve({ archived: [] })),
  }),
}));

const stop = jest.mocked(stopChatTurnExactly);
const scope = { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' };
const request: BeginChatTurnRunRequest = {
  scope,
  turnId: 'message',
  eventNamespace: 'initial',
  providerId: 'claude',
  model: 'model',
  initiationSource: 'user',
};
const caller: CanopyCallerDescriptor = {
  principalId: 'another-client',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.operation.cancel'],
};

let root: string;
let operations: CoreOperationAdapter;
let runtime: DesktopCanopyDispatcher;
beforeEach(() => {
  stop.mockClear();
  root = mkdtempSync(join(tmpdir(), 'desktop-turn-runs-'));
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
  });
});
afterEach(async () => {
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

async function records(): Promise<{
  parent: OperationRecord | undefined;
  child: OperationRecord | undefined;
}> {
  const { items } = await operations.service.list({ limit: 20 });
  return {
    parent: items.find((item) => item.kind === 'core.chat.turn.run'),
    child: items.find((item) => item.kind === 'worker.agent.turn.run'),
  };
}
async function settledRecords(): Promise<{
  parent: OperationRecord | undefined;
  child: OperationRecord | undefined;
}> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = await records();
    if (
      current.parent?.status !== 'running' &&
      current.child?.status !== 'running' &&
      current.child?.status !== 'queued'
    )
      return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return records();
}
/** Sorted turn-run statuses, once none is running beyond `running`. */
async function turnRunStatuses(running: number): Promise<string[]> {
  const read = async (): Promise<string[]> =>
    (
      await operations.service.list({
        kinds: ['core.chat.turn.run'],
        limit: 10,
      })
    ).items
      .map((item) => item.status)
      .sort();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const statuses = await read();
    if (statuses.filter((status) => status === 'running').length <= running)
      return statuses;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return read();
}

it('records the parent and the worker dispatch before the launch runs', async () => {
  const run = await beginChatTurnRun(request);
  const seen = await run.execute(() => records());
  expect(seen.parent).toMatchObject({ status: 'running', scope });
  expect(seen.child).toMatchObject({
    status: 'running',
    parentOperationId: seen.parent?.operationId,
  });
  run.settle('completed');
  await settledRecords();
});

it('observed provider events reach the handler through the core sink, in order', async () => {
  const sequences: number[] = [];
  const sinkFor = runtime.chatTurnRuns.sinkFor.bind(runtime.chatTurnRuns);
  jest.spyOn(runtime.chatTurnRuns, 'sinkFor').mockImplementation((id) => {
    const sink = sinkFor(id);
    if (!sink) return null;
    const observed: TurnEventSink = (event, local) => {
      sequences.push(event.sequence);
      return sink(event, local);
    };
    return observed;
  });
  const run = await beginChatTurnRun(request);
  const handled: unknown[] = [];
  const onEvent = run.observe((data) => {
    handled.push(data);
  });
  await run.execute(async () => {
    for (const index of [0, 1, 2]) await onEvent({ type: 'event', index });
  });
  expect(handled).toEqual([
    { type: 'event', index: 0 },
    { type: 'event', index: 1 },
    { type: 'event', index: 2 },
  ]);
  expect(sequences).toEqual([0, 1, 2]);
  run.settle('completed');
  await settledRecords();
});

it('settle completed finishes parent and child completed with the event count', async () => {
  const run = await beginChatTurnRun(request);
  const onEvent = run.observe(() => undefined);
  await run.execute(() => onEvent({ type: 'assistant' }));
  run.accepted();
  run.settle('completed');
  const { parent, child } = await settledRecords();
  expect(parent).toMatchObject({ status: 'completed' });
  expect(child).toMatchObject({
    status: 'completed',
    outcome: { status: 'completed', eventCount: 3 },
  });
});

it('core.operation.cancel calls the exact-turn Stop once and settles cancelled', async () => {
  const run = await beginChatTurnRun(request);
  const { parent } = await run.execute(() => records());
  if (!parent) throw new Error('Missing parent');
  for (const reason of ['first stop', 'second stop'])
    await runtime.instruction(
      'core.operation.cancel',
      { operationId: parent.operationId, reason },
      { caller },
    );
  const settled = await settledRecords();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledWith(
    { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' },
    'message',
  );
  expect(run.signal.aborted).toBe(true);
  expect(settled.parent).toMatchObject({ status: 'cancelled' });
  expect(settled.child).toMatchObject({ status: 'cancelled' });
});

it('a failed exact-turn Stop still settles the cancelled run', async () => {
  stop.mockRejectedValueOnce(new Error('stop failed'));
  const run = await beginChatTurnRun(request);
  const { parent } = await run.execute(() => records());
  if (!parent) throw new Error('Missing parent');
  await runtime.instruction(
    'core.operation.cancel',
    { operationId: parent.operationId, reason: 'stop' },
    { caller },
  );
  const settled = await settledRecords();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(settled.parent).toMatchObject({ status: 'cancelled' });
  expect(settled.child).toMatchObject({ status: 'cancelled' });
});

it('a refused dispatch rejects the waiting execute', async () => {
  jest
    .spyOn(runtime.localWorker, 'dispatch')
    .mockRejectedValueOnce(new Error('refused'));
  const run = await beginChatTurnRun(request);
  const fn = jest.fn();
  const execution = run.execute(fn);
  await expect(execution).rejects.toBeInstanceOf(TurnWorkerUnavailableError);
  const parent = (await settledRecords()).parent;
  await expect(execution).rejects.toMatchObject({ cause: parent?.error });
  expect(fn).not.toHaveBeenCalled();
  expect(parent).toMatchObject({ status: 'failed' });
});

it('abandon after accepted is a no-op', async () => {
  const run = await beginChatTurnRun(request);
  await run.execute(() => undefined);
  run.accepted();
  run.abandon(new Error('late'));
  expect((await records()).parent).toMatchObject({ status: 'running' });
  run.settle('completed');
  expect((await settledRecords()).parent).toMatchObject({
    status: 'completed',
  });
});

it('a silent provider stop leaves no live run and the message can be dispatched again', async () => {
  const run = await beginChatTurnRun(request);
  await run.execute(() => undefined);
  run.accepted();
  await stopChatTurn(
    { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' },
    {
      target: { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' },
      session: undefined,
      fence: {
        processOwner: Symbol('owner'),
        turnId: 'provider-turn',
        userMessageId: 'message',
        turnEpoch: 1,
      },
    },
  );
  expect((await settledRecords()).parent).toMatchObject({
    status: 'cancelled',
  });
  expect(runtime.chatTurnRuns.findLive(scope, 'message')).toBeNull();
  const again = await beginChatTurnRun(request);
  await again.execute(() => undefined);
  again.settle('completed');
  await settledRecords();
});

it("a silent stop without a provider fence settles the chat's live run", async () => {
  const run = await beginChatTurnRun(request);
  await run.execute(() => undefined);
  run.accepted();
  await stopChatTurn(
    { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' },
    {
      target: { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' },
      session: undefined,
      fence: undefined,
    },
  );
  expect((await settledRecords()).parent).toMatchObject({
    status: 'cancelled',
  });
  expect(runtime.chatTurnRuns.findLive(scope, 'message')).toBeNull();
});

it('a silent Cowork Stop leaves no live run', async () => {
  const cowork = {
    workspaceId: 'standalone-chat',
    worktreeId: 'cowork-workspace',
    chatId: 'cowork-chat',
  };
  const run = await beginChatTurnRun({ ...request, scope: cowork });
  await run.execute(() => undefined);
  run.accepted();
  await cancelStandaloneChat({
    chatId: 'cowork-chat',
    projectId: 'cowork-workspace',
  });
  expect((await settledRecords()).parent).toMatchObject({
    status: 'cancelled',
  });
  expect(runtime.chatTurnRuns.findLive(cowork, 'message')).toBeNull();
});

it('a root-terminal run settles after the terminal frame commits', async () => {
  const run = await beginChatTurnRun({ ...request, settleOn: 'root-terminal' });
  const committed: unknown[] = [];
  const onEvent = run.observe(async (data) => {
    await Promise.resolve();
    committed.push(data);
  });
  const terminal = { type: 'result', subtype: 'success', is_error: false };
  await run.execute(async () => {
    await onEvent({ type: 'assistant' });
    run.accepted();
    expect((await records()).parent).toMatchObject({ status: 'running' });
    await onEvent(terminal);
  });
  expect(committed).toEqual([{ type: 'assistant' }, terminal]);
  expect((await settledRecords()).parent).toMatchObject({
    status: 'completed',
  });
});

it('a newer root-terminal run of the same chat supersedes the older one', async () => {
  const older = await beginChatTurnRun({
    ...request,
    turnId: 'older',
    settleOn: 'root-terminal',
  });
  await older.execute(() => undefined);
  older.accepted();
  const newer = await beginChatTurnRun({
    ...request,
    turnId: 'newer',
    settleOn: 'root-terminal',
  });
  expect(await turnRunStatuses(1)).toEqual(['cancelled', 'running']);
  await newer.execute(() => undefined);
  newer.settle('completed');
  await settledRecords();
});

it('each deferred-tools continuation of a turn begins in its own namespace and completes its predecessor', async () => {
  const rootTerminal = { ...request, settleOn: 'root-terminal' as const };
  const runs = [await beginChatTurnRun(rootTerminal)];
  for (const reload of ['reload-1', 'reload-2']) {
    await runs[runs.length - 1].execute(() => undefined);
    runs[runs.length - 1].accepted();
    runs.push(
      await beginChatTurnRun({
        ...rootTerminal,
        eventNamespace: deferredReloadEventNamespace(reload),
      }),
    );
  }
  expect(await turnRunStatuses(1)).toEqual([
    'completed',
    'completed',
    'running',
  ]);
  await runs[2].execute(() => undefined);
  runs[2].settle('completed');
  await settledRecords();
});

it("a reused Codex thread's child terminal does not settle the root-terminal run", async () => {
  const kinds: string[] = [];
  const sinkFor = runtime.chatTurnRuns.sinkFor.bind(runtime.chatTurnRuns);
  jest.spyOn(runtime.chatTurnRuns, 'sinkFor').mockImplementation((id) => {
    const sink = sinkFor(id);
    if (!sink) return null;
    const observed: TurnEventSink = (event, local) => {
      kinds.push(event.kind);
      return sink(event, local);
    };
    return observed;
  });
  const run = await beginChatTurnRun({
    ...request,
    providerId: 'codex',
    settleOn: 'root-terminal',
    codexRootThreadId: 'root-thread',
  });
  const onEvent = run.observe(() => undefined);
  const codex = (type: string, thread: string): object => ({
    type: 'codex',
    event: { type, thread_id: thread, turn_id: `${thread}-turn` },
  });
  await run.execute(() => onEvent(codex('turn.started', 'root-thread')));
  run.accepted();
  await onEvent(codex('turn.completed', 'child-thread'));
  expect(kinds).not.toContain('terminal');
  await onEvent(codex('turn.completed', 'root-thread'));
  expect(kinds).toContain('terminal');
  expect((await settledRecords()).parent).toMatchObject({
    status: 'completed',
  });
});

it('a cancelled run refuses the provider send and settles cancelled', async () => {
  let finishStop: (value: null) => void = () => undefined;
  stop.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishStop = resolve;
      }),
  );
  const run = await beginChatTurnRun(request);
  const { parent } = await run.execute(() => records());
  if (!parent) throw new Error('Missing parent');
  void runtime.instruction(
    'core.operation.cancel',
    { operationId: parent.operationId, reason: 'stop' },
    { caller },
  );
  for (let attempt = 0; attempt < 200 && !run.signal.aborted; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const send = jest.fn<void, []>();
  expect(() => run.executeSync(send)).toThrow();
  expect(send).not.toHaveBeenCalled();
  run.abandon(new Error('The provider send was refused.'));
  finishStop(null);
  expect((await settledRecords()).parent).toMatchObject({
    status: 'cancelled',
  });
});

it('a settled run takes no more wait envelopes', async () => {
  const run = await beginChatTurnRun(request);
  await run.execute(() => undefined);
  const wait = {
    kind: 'wait_opened',
    waitId: 'question',
    waitKind: 'question',
  } as const;
  expect(emitChatTurnWait(scope, wait)).toBe(true);
  run.settle('completed');
  expect(emitChatTurnWait(scope, wait)).toBe(false);
  await settledRecords();
});

describe('replayed dispatch of an acknowledged Claude turn', () => {
  afterEach(() => {
    setWorkerProviderRuntimeForTests('claude', undefined);
  });

  it('a replayed dispatch of an acknowledged turn constructs no second Claude session', async () => {
    const createSession = jest.fn();
    const counting: WorkerProviderRuntime = {
      harness: 'claude',
      providerFor: () => Promise.resolve({ createSession }),
    };
    setWorkerProviderRuntimeForTests('claude', counting);
    const options: AgentSessionOptions = {
      cwd: '/repo',
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
    };
    const construct = async (): Promise<void> => {
      const runtime = await workerProviderRuntimeFor('claude');
      if (!runtime) throw new Error('Missing the Claude runtime');
      const provider = await runtime.providerFor(
        'claude',
        windowAgentInterfacePort(() => null),
      );
      provider.createSession(
        options,
        () => undefined,
        windowAgentInterfacePort(() => null),
      );
    };
    const run = await beginChatTurnRun(request);
    await run.execute(construct);
    run.accepted();

    const replay = beginChatTurnRun(request).then((second) =>
      second.execute(construct),
    );
    await expect(replay).rejects.toBeInstanceOf(CanopyOperationError);
    await expect(replay).rejects.toMatchObject({
      payload: { code: 'core.chat.turnRunActive' },
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    run.settle('completed');
    await settledRecords();
  });
});

describe('Copilot sessions on a replayed dispatch (CAN-4119)', () => {
  afterEach(() => {
    setWorkerProviderRuntimeForTests('copilot', undefined);
  });

  it('a replayed dispatch of an acknowledged turn constructs no second Copilot session', async () => {
    const createSession = jest.fn();
    const provider: AgentProvider = { createSession };
    setWorkerProviderRuntimeForTests('copilot', {
      harness: 'copilot',
      providerFor: () => Promise.resolve(provider),
    });
    const copilotRequest = { ...request, providerId: 'copilot' };
    const opts: AgentSessionOptions = {
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      cwd: root,
    };
    const run = await beginChatTurnRun(copilotRequest);
    await run.execute(async () => {
      const runtime = await workerProviderRuntimeFor('copilot');
      if (!runtime) throw new Error('No Copilot worker runtime is registered.');
      const copilot = await runtime.providerFor(
        'copilot',
        windowAgentInterfacePort(() => null),
      );
      return copilot.createSession(
        opts,
        () => undefined,
        windowAgentInterfacePort(() => null),
      );
    });
    run.accepted();
    let replay: unknown;
    try {
      await beginChatTurnRun(copilotRequest);
    } catch (error) {
      replay = error;
    }
    expect(replay).toBeInstanceOf(CanopyOperationError);
    expect(replay).toMatchObject({
      payload: { code: 'core.chat.turnRunActive' },
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    run.settle('completed');
    await settledRecords();
  });
});

describe('a cowork turn carries its portable launch, served as today (CAN-6995)', () => {
  const cowork = {
    workspaceId: 'cowork-ws',
    worktreeId: 'home',
    chatId: 'cowork-chat',
  };
  const coworkChat = {
    projectId: cowork.workspaceId,
    worktreeId: cowork.worktreeId,
    chatId: cowork.chatId,
  };
  const rules: NonNullable<AgentSessionOptions['sessionApprovalRules']> = [
    {
      id: 'rule',
      behavior: 'allow',
      target: { kind: 'command', pattern: 'git status' },
      createdAt: '2026-11-24T00:00:00.000Z',
      origin: 'settings',
    },
  ];
  const routing = { active: true, scope: 'session', activatedAt: 1 } as const;
  const roots = jest.mocked(readFilesystemScope);
  const warn = jest.mocked(logMainProcessWarn);
  const HARNESSES = [
    'claude',
    'codex',
    'cursor',
    'copilot',
    'opencode',
    'antigravity',
  ] as const;

  function catalog(absolutePath: string | null): FilesystemScopeCatalog {
    const found: FilesystemRoot[] =
      absolutePath === null
        ? []
        : [
            {
              id: 'cowork-root',
              name: 'Cowork',
              kind: 'standalone',
              absolutePath,
              gitAware: false,
              excludedDescendantRoots: [],
            },
          ];
    return {
      roots: found,
      byId: new Map(found.map((entry) => [entry.id, entry])),
      containerCreatedAt: null,
      attachmentSource: {
        absolutePath: join(root, 'attachments'),
        visible: false,
      },
    };
  }

  /** The per-chat revision, pinned: six counters, none of another chat's or workspace's. */
  function pinnedRevision(): number {
    return (
      getApprovalDefaultsRevision() +
      getChatApprovalStateRevision(coworkChat) +
      getWorkspaceApprovalRulesRevision(cowork.workspaceId) +
      getWorkspaceApprovalRulesSaveGeneration(cowork.workspaceId) +
      getGlobalApprovalRulesRevision() +
      getGlobalApprovalRulesSaveGeneration()
    );
  }

  /** Session options as the cowork send builds them, unset members included. */
  function coworkOptions(
    harness: (typeof HARNESSES)[number],
  ): AgentSessionOptions {
    return {
      cwd: root,
      projectId: cowork.workspaceId,
      worktreeId: cowork.worktreeId,
      chatId: cowork.chatId,
      planMode: false,
      approvalMode: 'ask',
      sessionApprovalRules: rules,
      codexProposalMode: undefined,
      thinkingLevel: 'medium',
      modelConfig: { thinkingLevel: 'medium' },
      model: 'model',
      selectedModel: 'model',
      sdkSessionId: undefined,
      applyGlobalPluginDefaults: true,
      deferredToolsAllowed: true,
      systemPromptAppend: 'cowork',
      globalInstructionsBlock: 'block',
      globalInstructionsSnapshot: undefined,
      providerType: harness,
      executionHarness: harness,
      codexAppServerIdleTimeoutMinutes: harness === 'codex' ? 10 : undefined,
      codexMaxConcurrentSubagents: harness === 'codex' ? 4 : undefined,
      codexMultiAgentEnabled: harness === 'codex' ? true : undefined,
      rtkEnabled: harness !== 'codex' && harness !== 'antigravity',
    };
  }

  /** Begins a cowork turn, serves it and returns what core dispatched. */
  async function serve(
    options: AgentSessionOptions,
    patch: { approvalRevision?: number; prompt?: string | null } = {},
  ): Promise<{
    params: WorkerAgentTurnRunParams;
    status: string | undefined;
    turnRunId: string;
  }> {
    const dispatch = jest.spyOn(runtime.localWorker, 'dispatch');
    const run = await beginChatTurnRun({
      ...request,
      scope: cowork,
      providerId: options.providerType ?? 'claude',
      launch: {
        surface: 'cowork',
        options,
        approvalRevision: patch.approvalRevision ?? pinnedRevision(),
        prompt: patch.prompt === undefined ? 'Fix it' : patch.prompt,
      },
    });
    await run.execute(() => undefined);
    run.settle('completed');
    const { parent } = await settledRecords();
    const params = WorkerAgentTurnRunParamsSchema.parse(
      dispatch.mock.calls[0]?.[0].params,
    );
    dispatch.mockRestore();
    return { params, status: parent?.status, turnRunId: run.turnRunId };
  }

  const mismatches = (): unknown[] =>
    warn.mock.calls.filter(
      ([message]) => message === '[turn-worker] launch shadow mismatch',
    );

  beforeEach(() => {
    warn.mockClear();
    roots.mockReset();
    roots.mockResolvedValue(catalog(root));
  });

  it('every harness dispatches a launch that resolves to the options it serves', async () => {
    const served: unknown[] = [];
    for (const harness of HARNESSES) {
      const { params, status } = await serve(coworkOptions(harness));
      served.push([harness, params.launch?.surface, status]);
    }
    expect(served).toEqual(
      HARNESSES.map((harness) => [harness, 'cowork', 'completed']),
    );
    expect(mismatches()).toEqual([]);
  });

  it("another chat's approval change during begin leaves the launch in place", async () => {
    const approvalRevision = pinnedRevision();
    roots.mockImplementation(() => {
      markChatApprovalStateChanged({
        projectId: cowork.workspaceId,
        worktreeId: cowork.worktreeId,
        chatId: 'another-chat',
      });
      return Promise.resolve(catalog(root));
    });
    const { params } = await serve(coworkOptions('claude'), {
      approvalRevision,
    });
    expect(params.launch?.approval.policyRevision).toBe(approvalRevision);
    expect(pinnedRevision()).toBe(approvalRevision);
  });

  it("another workspace's rule change during begin leaves this chat's launch in place", async () => {
    const approvalRevision = pinnedRevision();
    roots.mockImplementation(() => {
      markWorkspaceApprovalRulesChanged('another-ws');
      return Promise.resolve(catalog(root));
    });
    const { params } = await serve(coworkOptions('claude'), {
      approvalRevision,
    });
    expect(params.launch?.approval.policyRevision).toBe(approvalRevision);
    expect(pinnedRevision()).toBe(approvalRevision);
  });

  it("this chat's approval change, a rule save or a defaults change before begin sends no launch and serves the run", async () => {
    const outcomes: unknown[] = [];
    for (const change of [
      (): void => markChatApprovalStateChanged(coworkChat),
      (): void => markApprovalDefaultsChanged(),
      (): void => {
        void trackWorkspaceApprovalRulesSave(
          cowork.workspaceId,
          Promise.resolve(),
        );
      },
    ]) {
      const approvalRevision = pinnedRevision();
      roots.mockImplementation(() => {
        change();
        return Promise.resolve(catalog(root));
      });
      const { params, status } = await serve(coworkOptions('claude'), {
        approvalRevision,
      });
      outcomes.push(['launch' in params, status]);
    }
    expect(outcomes).toEqual([
      [false, 'completed'],
      [false, 'completed'],
      [false, 'completed'],
    ]);
  });

  it('a launch that resolves differently from the staged run is logged by member name and the run is served', async () => {
    // The same directory through a symlink: one canonical path, another text.
    const link = join(root, 'cowork-link');
    symlinkSync(root, link);
    roots.mockResolvedValue(catalog(link));
    const { params, status, turnRunId } = await serve(coworkOptions('claude'));
    expect(['launch' in params, status]).toEqual([true, 'completed']);
    expect(mismatches()).toEqual([
      ['[turn-worker] launch shadow mismatch', { turnRunId, members: ['cwd'] }],
    ]);
  });

  it('automation, uncrossable, routed, attachment and rootless turns send no launch and run as today', async () => {
    const outcomes: unknown[] = [];
    const cases: [AgentSessionOptions, string | null, string | null][] = [
      [
        { ...coworkOptions('claude'), accountResolution: 'unattended' },
        'Fix it',
        root,
      ],
      [{ ...coworkOptions('claude'), approvalMode: undefined }, 'Fix it', root],
      [
        { ...coworkOptions('claude'), aiCreditsRouting: routing },
        'Fix it',
        root,
      ],
      [coworkOptions('claude'), null, root],
      [coworkOptions('claude'), 'Fix it', null],
    ];
    for (const [options, prompt, rootPath] of cases) {
      roots.mockResolvedValue(catalog(rootPath));
      const { params, status } = await serve(options, { prompt });
      outcomes.push(['launch' in params, status]);
    }
    expect(outcomes).toEqual(cases.map(() => [false, 'completed']));
    expect(mismatches()).toEqual([]);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ApprovalPromptDecision,
  ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';
import type { ApprovalRevalidation } from '@canopy/core-runtime/node/agent/approvals';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../../canopy-runtime/core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import {
  beginChatTurnRun,
  type BeginChatTurnRunRequest,
} from '../../agent-runs/turn-runs';
import {
  getDesktopChatWaits,
  resetDesktopChatWaitsForTest,
  setDesktopChatWaitPresence,
} from '../../chat-waits/desktop-chat-waits';
import {
  createPendingRequest,
  resolveRequest,
} from '../../mcp/pending-requests';
import { resetDesktopApprovalBrokerForTests } from '../approval-broker';
import { installQuestionTurnWaits } from '../../chat-questions/question-turn-waits';
import { installApprovalTurnWaits } from '../approval-turn-waits';
import {
  hasPendingApprovalForSession,
  rejectAllApprovalsForSession,
  resolveApproval,
} from '../pending-approvals';
import {
  ApprovalRequestEndedError,
  requestApprovalDecision,
} from '../prompt-bridge';

jest.mock('../../canopy-runtime/chat-turn-stop', () => ({
  stopChatTurnExactly: jest.fn(() => Promise.resolve(null)),
}));
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
    ingestProviderEvent: jest.fn(() => Promise.resolve()),
    getCompatibilityArchives: jest.fn(() => Promise.resolve({ archived: [] })),
  }),
}));
jest.mock('../../observability/ingest', (): unknown => ({
  ...jest.requireActual<object>('../../observability/ingest'),
  getExecutionObservabilityIngest: (): object => ({
    pauseChatTurn: jest.fn(),
    resumeChatTurn: jest.fn(),
    recordSessionDiagnostic: jest.fn(),
  }),
}));
jest.mock('../../services/attention-tracker', (): unknown => ({
  getAttentionTracker: (): object => ({ mark: jest.fn(), clear: jest.fn() }),
}));

const scope = { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' };
const IDENTITY = { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' };
const SESSION = 'session';
const request: BeginChatTurnRunRequest = {
  scope,
  turnId: 'message',
  eventNamespace: 'initial',
  providerId: 'claude',
  model: 'model',
  initiationSource: 'user',
};
const ALLOW: ApprovalPromptDecision = { behavior: 'allow', scope: 'once' };
const DENY: ApprovalPromptDecision = { behavior: 'deny', scope: 'once' };

const send = jest.fn<void, [string, ...unknown[]]>();
const window = {
  isDestroyed: (): boolean => false,
  webContents: {
    id: 7,
    isDestroyed: (): boolean => false,
    isCrashed: (): boolean => false,
    send,
    mainFrame: { detached: false, isDestroyed: (): boolean => false },
  },
};
const responder = { id: 'webcontents:7', owners: [window.webContents] };

let root: string;
let operations: CoreOperationAdapter;
let runtime: DesktopCanopyDispatcher;
let seen: string[];
beforeEach(() => {
  send.mockClear();
  resetDesktopChatWaitsForTest();
  setDesktopChatWaitPresence({
    getMainWindow: () => window,
    remoteControllerAttached: () => false,
  });
  root = mkdtempSync(join(tmpdir(), 'approval-turn-waits-'));
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
  });
  installApprovalTurnWaits(getDesktopChatWaits());
  seen = [];
  runtime.chatTurnRuns.observeWaits({
    opened: (_run, wait) => seen.push(`opened:${wait.waitId}:${wait.waitKind}`),
    resolved: (_run, wait) =>
      seen.push(`resolved:${wait.waitId}:${wait.resolution}`),
  });
});
afterEach(async () => {
  resetDesktopApprovalBrokerForTests();
  setDesktopChatWaitPresence(null);
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
}

async function liveRun(): Promise<
  Awaited<ReturnType<typeof beginChatTurnRun>>
> {
  const run = await beginChatTurnRun(request);
  // The worker has taken the run once its first launch executes.
  await run.execute(() => undefined);
  return run;
}

async function parentStatus(): Promise<string | undefined> {
  const { items } = await operations.service.list({ limit: 20 });
  return items.find((item) => item.kind === 'core.chat.turn.run')?.status;
}

function cards(): ApprovalRequestEvent[] {
  return send.mock.calls
    .filter(([channel]) => channel === 'approval:request')
    .map(([, payload]) => payload as ApprovalRequestEvent);
}

function approve(
  options: { sessionKey?: string; timeoutMs?: number } = {},
): ReturnType<typeof requestApprovalDecision> {
  return requestApprovalDecision({
    sessionKey: options.sessionKey ?? SESSION,
    event: {
      ...IDENTITY,
      provider: 'claude',
      title: 'Run ls',
      details: { kind: 'tool', toolName: 'Bash' },
    },
    getWindow: () => window,
    revalidate: (): Promise<ApprovalRevalidation> => Promise.resolve('prompt'),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });
}

function answer(
  card: ApprovalRequestEvent,
  decision: ApprovalPromptDecision,
): boolean {
  return resolveApproval(
    card.requestId,
    decision,
    responder,
    IDENTITY,
    card.policyRevision,
  );
}

it("an approval wait opens and resolves one wait on the chat's turn run", async () => {
  const run = await liveRun();
  const decision = approve();
  const [card] = cards();
  if (!card) throw new Error('no card');
  await until(() => seen.length === 1);
  expect(seen).toEqual([`opened:${card.requestId}:approval`]);
  expect(await parentStatus()).toBe('running');

  expect(answer(card, ALLOW)).toBe(true);
  await expect(decision).resolves.toMatchObject({
    kind: 'decision',
    decision: ALLOW,
  });
  await until(() => seen.length === 2);
  expect(seen).toEqual([
    `opened:${card.requestId}:approval`,
    `resolved:${card.requestId}:answered`,
  ]);
  expect(await parentStatus()).toBe('running');
  run.settle('completed');
});

it('a denied, cancelled or expired approval resolves as answered, cancelled and expired', async () => {
  const run = await liveRun();
  const denied = approve();
  const cancelled = approve({ sessionKey: 'cancelled-session' });
  const expired = approve({ sessionKey: 'expired-session', timeoutMs: 5 });
  const [deniedCard, cancelledCard, expiredCard] = cards();
  if (!deniedCard || !cancelledCard || !expiredCard) {
    throw new Error('missing cards');
  }
  expect(answer(deniedCard, DENY)).toBe(true);
  rejectAllApprovalsForSession('cancelled-session');
  await expect(denied).resolves.toMatchObject({ decision: DENY });
  await expect(cancelled).rejects.toBeInstanceOf(ApprovalRequestEndedError);
  await expect(expired).rejects.toThrow('approval_timeout');
  await until(() => seen.length === 6);
  expect(seen.filter((entry) => entry.startsWith('resolved:'))).toEqual(
    expect.arrayContaining([
      `resolved:${deniedCard.requestId}:answered`,
      `resolved:${cancelledCard.requestId}:cancelled`,
      `resolved:${expiredCard.requestId}:expired`,
    ]),
  );
  run.settle('completed');
});

it('only approval waits reach this bridge', async () => {
  // The runtime also reports question waits (CAN-4128); this covers the
  // approval bridge alone.
  installQuestionTurnWaits(getDesktopChatWaits())();
  const run = await liveRun();
  const answers = createPendingRequest('q-1', 'session', {
    scope: IDENTITY,
  });
  resolveRequest('q-1', [{ question: 'Pick one', selectedOptions: ['A'] }]);
  await answers;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(seen).toEqual([]);
  run.settle('completed');
});

it('with no live turn run the approval is unaffected', async () => {
  const decision = approve();
  const [card] = cards();
  if (!card) throw new Error('no card');
  expect(hasPendingApprovalForSession(SESSION)).toBe(true);
  expect(answer(card, ALLOW)).toBe(true);
  await expect(decision).resolves.toMatchObject({ decision: ALLOW });
  expect(seen).toEqual([]);
});

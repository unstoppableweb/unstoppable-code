import { EventEmitter } from 'node:events';
import type {
  ApprovalPromptDecision,
  ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';
import type { ApprovalRevalidation } from '@canopy/core-runtime/node/agent/approvals';
import {
  getDesktopChatWaits,
  resetDesktopChatWaitsForTest,
  setDesktopChatWaitPresence,
} from '../../chat-waits/desktop-chat-waits';
import { createPendingRequest } from '../../mcp/pending-requests';
import { resetDesktopApprovalBrokerForTests } from '../approval-broker';
import {
  hasPendingApprovalForSession,
  hasPendingApprovalForChat,
  subscribePendingApprovalChanges,
  pendingApprovalRequests,
  rejectAllApprovalsForSession,
  resolveApproval,
} from '../pending-approvals';
import {
  ApprovalRequestEndedError,
  requestApprovalDecision,
} from '../prompt-bridge';
import { advanceApprovalAuthorityRevision } from '../rule-revisions';

const mockAppEvents = new EventEmitter();

jest.mock('electron', (): unknown => ({
  app: {
    on: (event: string, listener: () => void): void => {
      mockAppEvents.on(event, listener);
    },
    removeListener: (event: string, listener: () => void): void => {
      mockAppEvents.removeListener(event, listener);
    },
  },
  BrowserWindow: {},
}));

const mockAttention = { mark: jest.fn(), clear: jest.fn() };

jest.mock('../../observability/ingest', (): unknown => ({
  getExecutionObservabilityIngest: () => ({
    pauseChatTurn: jest.fn(),
    resumeChatTurn: jest.fn(),
    recordSessionDiagnostic: jest.fn(),
  }),
}));

jest.mock('../../services/attention-tracker', (): unknown => ({
  getAttentionTracker: () => mockAttention,
}));

jest.mock('../../lib/main-process-logging', (): unknown => ({
  logMainProcessWarn: jest.fn(),
}));

const SESSION = 'session-1';
const IDENTITY = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};
const EVENT: Omit<ApprovalRequestEvent, 'requestId' | 'policyRevision'> = {
  ...IDENTITY,
  provider: 'claude',
  title: 'Run ls',
  details: { kind: 'tool', toolName: 'Bash' },
};
const ALLOW: ApprovalPromptDecision = { behavior: 'allow', scope: 'once' };
const DENY: ApprovalPromptDecision = { behavior: 'deny', scope: 'once' };

interface FakeWindow {
  isDestroyed(): boolean;
  destroy(): void;
  webContents: {
    id: number;
    isDestroyed(): boolean;
    isCrashed(): boolean;
    send: jest.Mock<void, [string, ...unknown[]]>;
    mainFrame: { detached: boolean; isDestroyed(): boolean };
    once(event: 'destroyed', listener: () => void): void;
    removeListener(event: 'destroyed', listener: () => void): void;
  };
}

let nextWindowId = 1;

function fakeWindow(): FakeWindow {
  const events = new EventEmitter();
  let destroyed = false;
  const window: FakeWindow = {
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      events.emit('destroyed');
    },
    webContents: {
      id: nextWindowId++,
      isDestroyed: () => destroyed,
      isCrashed: () => false,
      send: jest.fn<void, [string, ...unknown[]]>(),
      mainFrame: { detached: false, isDestroyed: () => destroyed },
      once: (event, listener) => {
        events.once(event, listener);
      },
      removeListener: (event, listener) => {
        events.removeListener(event, listener);
      },
    },
  };
  return window;
}

function sent(window: FakeWindow, channel: string): unknown[] {
  return window.webContents.send.mock.calls
    .filter(([name]) => name === channel)
    .map(([, payload]): unknown => payload);
}

function requestsTo(window: FakeWindow): ApprovalRequestEvent[] {
  return sent(window, 'approval:request').filter(
    (payload): payload is ApprovalRequestEvent =>
      typeof payload === 'object' && payload !== null && 'requestId' in payload,
  );
}

function responder(
  window: FakeWindow,
  extra: object[] = [],
): {
  id: string;
  owners: object[];
} {
  return {
    id: `webcontents:${window.webContents.id}`,
    owners: [...extra, window.webContents],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

let mainWindow: FakeWindow | null;

function open(
  getWindow: () => FakeWindow | null,
  options: {
    revalidate?: () => Promise<ApprovalRevalidation>;
    timeoutMs?: number;
  } = {},
): Promise<Awaited<ReturnType<typeof requestApprovalDecision>>> {
  return requestApprovalDecision({
    sessionKey: SESSION,
    event: EVENT,
    getWindow,
    revalidate:
      options.revalidate ??
      ((): Promise<ApprovalRevalidation> => Promise.resolve('prompt')),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });
}

describe('desktop approvals through the core broker', () => {
  beforeEach(() => {
    mainWindow = fakeWindow();
    mockAttention.mark.mockClear();
    mockAttention.clear.mockClear();
    resetDesktopChatWaitsForTest();
    setDesktopChatWaitPresence({
      getMainWindow: () => mainWindow,
      remoteControllerAttached: () => false,
    });
  });

  afterEach(() => {
    resetDesktopApprovalBrokerForTests();
    setDesktopChatWaitPresence(null);
    mockAppEvents.removeAllListeners();
    jest.useRealTimers();
  });

  // queueMicrotask projects the scoped wait only after broker registration.
  it('projects broker approval changes into Tasks chat summaries', async () => {
    const statuses: boolean[] = [];
    const unsubscribe = subscribePendingApprovalChanges((identity) => {
      expect(identity).toEqual(IDENTITY);
      statuses.push(hasPendingApprovalForChat(identity));
    });
    const decision = open(() => mainWindow);
    await flush();
    expect(hasPendingApprovalForChat(IDENTITY)).toBe(true);
    expect(hasPendingApprovalForChat({ ...IDENTITY, chatId: 'other' })).toBe(
      false,
    );
    expect(statuses).toEqual([true]);
    rejectAllApprovalsForSession(SESSION);
    await expect(decision).rejects.toThrow();
    await flush();
    expect(statuses).toEqual([true, false]);
    unsubscribe();
    const next = open(() => mainWindow);
    await flush();
    rejectAllApprovalsForSession(SESSION);
    await expect(next).rejects.toThrow();
    expect(statuses).toEqual([true, false]);
  });

  it('a request delivered to one window is answered from the window that replaced it', async () => {
    const windowA = mainWindow;
    if (!windowA) throw new Error('no window');
    let current: FakeWindow | null = windowA;
    const decision = open(() => current);
    const [delivered] = requestsTo(windowA);
    expect(typeof delivered?.policyRevision).toBe('number');

    windowA.destroy();
    current = null;
    await flush();
    expect(hasPendingApprovalForSession(SESSION)).toBe(true);

    const windowB = fakeWindow();
    current = windowB;
    mainWindow = windowB;
    mockAppEvents.emit('browser-window-created');
    await flush();

    const [redelivered] = requestsTo(windowB);
    expect(redelivered?.requestId).toBe(delivered?.requestId);
    expect(
      resolveApproval(
        delivered?.requestId ?? '',
        ALLOW,
        responder(windowB),
        IDENTITY,
        redelivered?.policyRevision,
      ),
    ).toBe(true);
    await expect(decision).resolves.toMatchObject({
      kind: 'decision',
      by: 'client',
    });
    expect(sent(windowB, 'approval:cancelled')).toEqual([
      { requestId: delivered?.requestId },
    ]);
  });

  it('with no eligible client a new approval and a new question both fail at once', async () => {
    const window = mainWindow;
    mainWindow = null;

    await expect(open(() => window)).rejects.toThrow(
      new ApprovalRequestEndedError('approval_no_client'),
    );
    expect(window?.webContents.send).not.toHaveBeenCalled();
    expect(mockAttention.mark).not.toHaveBeenCalled();

    await expect(
      createPendingRequest('q1', SESSION, { scope: IDENTITY }),
    ).rejects.toThrow('ask_user_no_client');
  });

  it('an approval whose own window is absent is denied at once while another client is present', async () => {
    const opened: string[] = [];
    getDesktopChatWaits().observe({
      opened: (wait) => {
        opened.push(wait.waitId);
      },
      settled: () => undefined,
    });
    let settled = false;
    const decision = open(() => null);
    decision.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();

    expect(settled).toBe(true);
    await expect(decision).rejects.toThrow(
      new ApprovalRequestEndedError('approval_no_client'),
    );
    expect(hasPendingApprovalForSession(SESSION)).toBe(false);
    expect(mockAttention.mark).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it('an allow for a card the window never received is refused', async () => {
    const window = mainWindow;
    if (!window) throw new Error('no window');
    window.webContents.mainFrame.detached = true;
    const decision = open(() => window);
    expect(requestsTo(window)).toEqual([]);
    const [view] = pendingApprovalRequests(responder(window).owners);
    if (!view) throw new Error('no pending request');

    expect(
      resolveApproval(
        view.requestId,
        ALLOW,
        responder(window),
        IDENTITY,
        view.policyRevision,
      ),
    ).toBe(false);

    window.webContents.mainFrame.detached = false;
    expect(
      resolveApproval(
        view.requestId,
        ALLOW,
        responder(window),
        IDENTITY,
        view.policyRevision,
      ),
    ).toBe(false);
    expect(requestsTo(window)).toHaveLength(1);
    expect(
      resolveApproval(
        view.requestId,
        ALLOW,
        responder(window),
        IDENTITY,
        view.policyRevision,
      ),
    ).toBe(true);
    await expect(decision).resolves.toMatchObject({ kind: 'decision' });
  });

  it('an allow from an older revision is refused and the card is shown again', async () => {
    const window = mainWindow;
    if (!window) throw new Error('no window');
    const decision = open(() => window);
    const [first] = requestsTo(window);
    const firstRevision = first?.policyRevision ?? -1;

    advanceApprovalAuthorityRevision();
    await flush();

    expect(
      resolveApproval(
        first?.requestId ?? '',
        ALLOW,
        responder(window),
        IDENTITY,
        firstRevision,
      ),
    ).toBe(false);
    const latest = requestsTo(window).at(-1);
    expect(latest?.requestId).toBe(first?.requestId);
    expect(latest?.policyRevision ?? -1).toBeGreaterThan(firstRevision);
    expect(
      resolveApproval(
        first?.requestId ?? '',
        ALLOW,
        responder(window),
        IDENTITY,
        latest?.policyRevision,
      ),
    ).toBe(true);
    await expect(decision).resolves.toMatchObject({ kind: 'decision' });
  });

  it('a deny rule saved while a card is up settles the request denied', async () => {
    const window = mainWindow;
    if (!window) throw new Error('no window');
    const decision = open(() => window, {
      revalidate: () => Promise.resolve('deny'),
    });
    const [delivered] = requestsTo(window);

    advanceApprovalAuthorityRevision();

    await expect(decision).resolves.toEqual({ kind: 'policy_denied' });
    expect(sent(window, 'approval:cancelled')).toEqual([
      { requestId: delivered?.requestId },
    ]);
  });

  it('an answer to a request this process never opened changes nothing', async () => {
    const window = mainWindow;
    if (!window) throw new Error('no window');
    expect(
      resolveApproval('unknown', ALLOW, responder(window), IDENTITY, 0),
    ).toBe(false);

    const decision = open(() => window);
    const [delivered] = requestsTo(window);
    resetDesktopApprovalBrokerForTests();
    resetDesktopChatWaitsForTest();
    await expect(decision).rejects.toThrow(ApprovalRequestEndedError);

    expect(
      resolveApproval(
        delivered?.requestId ?? '',
        ALLOW,
        responder(window),
        IDENTITY,
        delivered?.policyRevision,
      ),
    ).toBe(false);
    expect(pendingApprovalRequests(responder(window).owners)).toEqual([]);
  });

  it('cancellation fans out to the window and settles the check denied', async () => {
    const window = mainWindow;
    if (!window) throw new Error('no window');
    const decision = open(() => window);
    const question = createPendingRequest('q-open', SESSION, {
      scope: IDENTITY,
    });
    const [delivered] = requestsTo(window);

    rejectAllApprovalsForSession(SESSION, 'turn_cancelled');

    await expect(decision).rejects.toThrow(
      new ApprovalRequestEndedError('turn_cancelled'),
    );
    expect(sent(window, 'approval:cancelled')).toEqual([
      { requestId: delivered?.requestId },
    ]);
    expect(hasPendingApprovalForSession(SESSION)).toBe(false);
    let questionSettled = false;
    void question.then(
      () => {
        questionSettled = true;
      },
      () => {
        questionSettled = true;
      },
    );
    await flush();
    expect(questionSettled).toBe(false);
  });

  it('a mirrored Remote Control sender answers, App Advisor windows stay local', async () => {
    const main = mainWindow;
    if (!main) throw new Error('no window');
    const advisor = fakeWindow();
    const bridgeSender = {};
    const owners = {
      id: 'webcontents:bridge',
      owners: [bridgeSender, main.webContents],
    };

    const mainDecision = open(() => main);
    const [mainCard] = requestsTo(main);
    const advisorDecision = open(() => advisor);
    const [advisorCard] = requestsTo(advisor);

    expect(
      resolveApproval(
        mainCard?.requestId ?? '',
        ALLOW,
        owners,
        IDENTITY,
        mainCard?.policyRevision,
      ),
    ).toBe(true);
    expect(
      resolveApproval(
        advisorCard?.requestId ?? '',
        ALLOW,
        owners,
        IDENTITY,
        advisorCard?.policyRevision,
      ),
    ).toBe(false);
    await expect(mainDecision).resolves.toMatchObject({ kind: 'decision' });
    rejectAllApprovalsForSession(SESSION);
    await expect(advisorDecision).rejects.toThrow(ApprovalRequestEndedError);
  });

  it('a dismiss denies at any revision', async () => {
    const window = mainWindow;
    if (!window) throw new Error('no window');
    const decision = open(() => window);
    const [delivered] = requestsTo(window);

    expect(
      resolveApproval(
        delivered?.requestId ?? '',
        DENY,
        responder(window),
        IDENTITY,
        undefined,
      ),
    ).toBe(true);
    await expect(decision).resolves.toEqual({
      kind: 'decision',
      decision: DENY,
      by: 'client',
    });
  });

  it('the caller deadline settles expired and denies', async () => {
    jest.useFakeTimers();
    const window = mainWindow;
    if (!window) throw new Error('no window');
    const decision = open(() => window, { timeoutMs: 1000 });
    const [delivered] = requestsTo(window);

    jest.advanceTimersByTime(1000);

    await expect(decision).rejects.toThrow(
      new ApprovalRequestEndedError('approval_timeout'),
    );
    expect(sent(window, 'approval:cancelled')).toEqual([
      { requestId: delivered?.requestId },
    ]);
  });
});

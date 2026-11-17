import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  createWorkEntry,
  resolveWorkEntryForChat,
} from '../../lib/cowork-work-entries';
import type { readChatTabsFile } from '../../lib/chat-tabs-reader';
import type { writeChatTabsFile } from '../../lib/chat-tabs';
import type { sendToWindow } from '../../lib/window-send';
import type {
  cancelTransientRetriesForChatId,
  cancelTransientRetriesForWorkspaceChat,
  cancelTransientRetryForChat,
} from '../../lib/transient-error-retry-service';
import type { getChatQueueService } from '../../services/chat-queue-service';
import type { getChatStateService } from '../../services/chat-state-service';

type CreateWorkEntry = typeof createWorkEntry;
type ResolveWorkEntryForChat = typeof resolveWorkEntryForChat;
type ReadChatTabsFile = typeof readChatTabsFile;
type WriteChatTabsFile = typeof writeChatTabsFile;
type SendToWindow = typeof sendToWindow;
type CancelTransientRetriesForChatId = typeof cancelTransientRetriesForChatId;
type CancelTransientRetriesForWorkspaceChat =
  typeof cancelTransientRetriesForWorkspaceChat;
type CancelTransientRetryForChat = typeof cancelTransientRetryForChat;
type ChatQueue = ReturnType<typeof getChatQueueService>;
type HasTranscriptMessage = ReturnType<
  typeof getChatStateService
>['hasTranscriptMessage'];

const mockHasTranscriptMessage = jest.fn<
  ReturnType<HasTranscriptMessage>,
  Parameters<HasTranscriptMessage>
>();
const mockSendToWindow = jest.fn<
  ReturnType<SendToWindow>,
  Parameters<SendToWindow>
>();
const mockReadChatTabsFile = jest.fn<
  ReturnType<ReadChatTabsFile>,
  Parameters<ReadChatTabsFile>
>();
const mockResolveWorkEntryForChat = jest.fn<
  ReturnType<ResolveWorkEntryForChat>,
  Parameters<ResolveWorkEntryForChat>
>();
const mockCreateWorkEntry = jest.fn<
  ReturnType<CreateWorkEntry>,
  Parameters<CreateWorkEntry>
>();
const mockWriteChatTabsFile = jest.fn<
  ReturnType<WriteChatTabsFile>,
  Parameters<WriteChatTabsFile>
>();
const mockCancelTransientRetriesForChatId = jest.fn<
  ReturnType<CancelTransientRetriesForChatId>,
  Parameters<CancelTransientRetriesForChatId>
>();
const mockCancelTransientRetriesForWorkspaceChat = jest.fn<
  ReturnType<CancelTransientRetriesForWorkspaceChat>,
  Parameters<CancelTransientRetriesForWorkspaceChat>
>();
const mockCancelTransientRetryForChat = jest.fn<
  ReturnType<CancelTransientRetryForChat>,
  Parameters<CancelTransientRetryForChat>
>();
const mockQueue = {
  holdsUserMessage: jest.fn<
    ReturnType<ChatQueue['holdsUserMessage']>,
    Parameters<ChatQueue['holdsUserMessage']>
  >(),
  runningTurnUserMessageId: jest.fn<
    ReturnType<ChatQueue['runningTurnUserMessageId']>,
    Parameters<ChatQueue['runningTurnUserMessageId']>
  >(),
  dispatchingUserMessageId: jest.fn<
    ReturnType<ChatQueue['dispatchingUserMessageId']>,
    Parameters<ChatQueue['dispatchingUserMessageId']>
  >(),
  isTurnActive: jest.fn<
    ReturnType<ChatQueue['isTurnActive']>,
    Parameters<ChatQueue['isTurnActive']>
  >(),
  admitDirectDispatch: jest.fn<Promise<unknown>, unknown[]>(),
  submit: jest.fn<Promise<void>, unknown[]>(),
};

jest.mock('../../lib/cowork-work-entries', () => ({
  createWorkEntry: (
    ...args: Parameters<CreateWorkEntry>
  ): ReturnType<CreateWorkEntry> => mockCreateWorkEntry(...args),
  listWorkEntryChatSummaries: jest.fn(),
  listWorkEntryIds: (): Promise<string[]> => Promise.resolve(['entry-1']),
  resolveWorkEntryForChat: (
    ...args: Parameters<ResolveWorkEntryForChat>
  ): ReturnType<ResolveWorkEntryForChat> =>
    mockResolveWorkEntryForChat(...args),
}));
jest.mock('../../lib/cowork-folder-guard', () => ({
  assertCoworkWorkspaceRootPresent: (): Promise<void> => Promise.resolve(),
  assertCoworkChatRootPresent: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): Promise<boolean> => Promise.resolve(false),
  isOrgModelPolicyActiveForStoredAccount: (): Promise<boolean> =>
    Promise.resolve(false),
}));
// CAN-6701: sends judge an enforced gateway before saving; none is enforced
// here.
jest.mock('../../lib/model-gateway-turn', () => ({
  assertTurnModelGatewayRoute: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (
    ...args: Parameters<ReadChatTabsFile>
  ): ReturnType<ReadChatTabsFile> => mockReadChatTabsFile(...args),
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): {
    hasTranscriptMessage: HasTranscriptMessage;
    runWithScopeActivity: (
      _scope: unknown,
      run: () => Promise<unknown>,
    ) => Promise<unknown>;
  } => ({
    hasTranscriptMessage: (
      ...args: Parameters<HasTranscriptMessage>
    ): ReturnType<HasTranscriptMessage> => mockHasTranscriptMessage(...args),
    runWithScopeActivity: (
      _scope: unknown,
      run: () => Promise<unknown>,
    ): Promise<unknown> => Promise.resolve(run()),
  }),
}));
jest.mock('../../services/chat-queue-service', () => ({
  getChatQueueService: (): typeof mockQueue => mockQueue,
}));
jest.mock('../../lib/window-send', () => ({
  sendToWindow: (...args: Parameters<SendToWindow>): ReturnType<SendToWindow> =>
    mockSendToWindow(...args),
}));
jest.mock('../../lib/chat-tabs', () => ({
  writeChatTabsFile: (
    ...args: Parameters<WriteChatTabsFile>
  ): ReturnType<WriteChatTabsFile> => mockWriteChatTabsFile(...args),
}));
jest.mock('../../lib/transient-error-retry-service', () => ({
  cancelTransientRetriesForChatId: (
    ...args: Parameters<CancelTransientRetriesForChatId>
  ): ReturnType<CancelTransientRetriesForChatId> =>
    mockCancelTransientRetriesForChatId(...args),
  cancelTransientRetriesForWorkspaceChat: (
    ...args: Parameters<CancelTransientRetriesForWorkspaceChat>
  ): ReturnType<CancelTransientRetriesForWorkspaceChat> =>
    mockCancelTransientRetriesForWorkspaceChat(...args),
  cancelTransientRetryForChat: (
    ...args: Parameters<CancelTransientRetryForChat>
  ): ReturnType<CancelTransientRetryForChat> =>
    mockCancelTransientRetryForChat(...args),
}));

import { sendStandaloneChatMessage } from '../../services/standalone-chat-service';

const request = {
  projectLocalId: 'project-1',
  workEntryId: 'entry-1',
  chatId: 'chat-1',
  userMessageId: 'message-1',
  message: 'hello',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveWorkEntryForChat.mockResolvedValue({
    entryId: 'entry-1',
    archivedInEntryId: null,
  });
  mockReadChatTabsFile.mockResolvedValue({
    version: 1,
    activeTabId: 'chat-1',
    tabs: [
      {
        id: 'chat-1',
        title: 'Chat',
        createdAt: '2026-11-04T00:00:00.000Z',
        messages: [],
      },
    ],
  });
  mockHasTranscriptMessage.mockResolvedValue(false);
  mockQueue.holdsUserMessage.mockReturnValue(false);
  mockQueue.runningTurnUserMessageId.mockReturnValue(undefined);
  mockQueue.dispatchingUserMessageId.mockReturnValue(undefined);
  mockQueue.isTurnActive.mockReturnValue(false);
  mockQueue.admitDirectDispatch.mockResolvedValue({});
  mockQueue.submit.mockResolvedValue(undefined);
});

function expectNoSendSideEffects(): void {
  expect(mockCreateWorkEntry).not.toHaveBeenCalled();
  expect(mockWriteChatTabsFile).not.toHaveBeenCalled();
  expect(mockCancelTransientRetriesForChatId).not.toHaveBeenCalled();
  expect(mockCancelTransientRetriesForWorkspaceChat).not.toHaveBeenCalled();
  expect(mockCancelTransientRetryForChat).not.toHaveBeenCalled();
  expect(mockQueue.admitDirectDispatch).not.toHaveBeenCalled();
  expect(mockQueue.submit).not.toHaveBeenCalled();
  // A replay must not broadcast the message or chat metadata a second time;
  // match on the channel alone, since replays have no window.
  const pushedChannels = mockSendToWindow.mock.calls.map(
    ([, channel]) => channel,
  );
  expect(pushedChannels).not.toContain(IPC_CHANNELS.chatEvent);
  expect(pushedChannels).not.toContain(IPC_CHANNELS.standaloneChatMetaUpdated);
}

test('replays an accepted durable message without running send side effects', async () => {
  mockHasTranscriptMessage.mockResolvedValue(true);

  const result = await sendStandaloneChatMessage(request);

  expect(mockHasTranscriptMessage).toHaveBeenCalledWith(
    { projectId: 'project-1', worktreeId: 'entry-1' },
    'chat-1',
    'message-1',
  );
  expect(result).toEqual({
    ok: true,
    chatId: 'chat-1',
    userMessageId: 'message-1',
    workEntryId: 'entry-1',
    delivery: 'accepted',
  });
  expectNoSendSideEffects();
});

test('replays a durable queued message as queued', async () => {
  mockQueue.holdsUserMessage.mockReturnValue(true);

  const result = await sendStandaloneChatMessage(request);

  expect(mockQueue.holdsUserMessage).toHaveBeenCalledWith(
    { projectId: 'project-1', worktreeId: 'entry-1', chatId: 'chat-1' },
    'message-1',
  );
  expect(result).toEqual({
    ok: true,
    chatId: 'chat-1',
    userMessageId: 'message-1',
    workEntryId: 'entry-1',
    delivery: 'queued',
  });
  expectNoSendSideEffects();
});

test('replays a queued message from the durable input ledger after queue hydration', async () => {
  mockReadChatTabsFile.mockResolvedValue({
    version: 1,
    activeTabId: 'chat-1',
    tabs: [
      {
        id: 'chat-1',
        title: 'Chat',
        createdAt: '2026-11-04T00:00:00.000Z',
        messages: [],
        inputDelivery: {
          version: 1,
          epoch: 0,
          rows: [
            {
              id: 'message-1',
              revision: 1,
              createdAt: 1,
              state: 'queued',
              text: 'hello',
              payload: {
                projectId: 'project-1',
                worktreeId: 'entry-1',
                chatId: 'chat-1',
                userMessageId: 'message-1',
                text: 'hello',
              },
              settingsKey: 'settings',
              attempts: [],
            },
          ],
        },
      },
    ],
  });

  const result = await sendStandaloneChatMessage(request);

  expect(result).toEqual({
    ok: true,
    chatId: 'chat-1',
    userMessageId: 'message-1',
    workEntryId: 'entry-1',
    delivery: 'queued',
  });
  expectNoSendSideEffects();
});

test('serializes concurrent retries of the same chat/message identity', async () => {
  let resolveTranscriptCheck: ((value: boolean) => void) | undefined;
  let markTranscriptCheckStarted: () => void = () => undefined;
  const transcriptCheckStarted = new Promise<void>((resolve) => {
    markTranscriptCheckStarted = resolve;
  });
  mockHasTranscriptMessage.mockImplementation(() => {
    markTranscriptCheckStarted();
    return new Promise<boolean>((resolve) => {
      resolveTranscriptCheck = resolve;
    });
  });

  const first = sendStandaloneChatMessage(request);
  const second = sendStandaloneChatMessage(request);
  await transcriptCheckStarted;
  resolveTranscriptCheck?.(true);
  const results = await Promise.all([first, second]);

  expect(mockHasTranscriptMessage).toHaveBeenCalledTimes(1);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({
    userMessageId: 'message-1',
    delivery: 'accepted',
  });
  expectNoSendSideEffects();
});

test('a Portal pairing revoked while the prompt write waits saves and starts nothing', async () => {
  const release = jest.fn();
  mockQueue.admitDirectDispatch.mockResolvedValue({ release });
  // Authorized when the send checks after its guard, revoked by the time the
  // queued tab write commits the prompt.
  const canCommitSend = jest
    .fn<boolean, []>()
    .mockReturnValueOnce(true)
    .mockReturnValue(false);
  await expect(
    sendStandaloneChatMessage(
      { ...request, model: 'claude-sonnet-4-5' },
      { canCommitSend },
    ),
  ).rejects.toThrow('The paired session is no longer authorized.');
  expect(mockWriteChatTabsFile).not.toHaveBeenCalled();
  expect(mockQueue.submit).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalled();
});

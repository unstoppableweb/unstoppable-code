/** @jest-environment jsdom */
/**
 * CAN-7196: a cloud queued message's Cancel, Run now or edit whose answer
 * never came, or that Core forgot before a retry, says what the queue now
 * shows, never that it failed. The web core backend reads the queue again
 * after either; the store raises a notice, logs no failure and shows no
 * "Couldn't save your edit." A tab command whose answer never came reads
 * the view again and says it couldn't confirm it, never "Try again."
 */
import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { createEmptyTab } from '../tab-utils';
import { RevisionedChatSync } from '../revisioned-sync';
import {
  CHAT_STATE_COMMAND_FAILED_NOTICE,
  CHAT_STATE_UNCONFIRMED_NOTICE,
} from '../revisioned-copy';
import {
  QUEUE_COMMAND_UNCONFIRMED_NOTICE,
  QUEUE_COMMAND_UNREAD_NOTICE,
  QUEUE_EDIT_UNCONFIRMED_NOTICE,
  QUEUE_EDIT_UNREAD_NOTICE,
  QUEUE_RETRY_EXPIRED_NOTICE,
  queueRereadDelayMs,
  WebCoreQueueCommandUnsettledError,
} from '../web-core/queue-unconfirmed';

const cancelQueuedMessage = jest.fn<Promise<void>, [unknown]>();
const forceQueuedMessage = jest.fn<Promise<void>, [unknown]>();
const editQueuedMessage = jest.fn<Promise<void>, [unknown]>();
const setQueuedMessageEditLock = jest.fn(
  (): Promise<void> => Promise.resolve(),
);
const command = jest.fn<Promise<unknown>, [unknown]>();

jest.mock('../web-core', (): unknown => ({
  ...jest.requireActual<Record<string, unknown>>('../web-core'),
  webCoreChatBackend: (): unknown => ({
    chat: {
      cancelQueuedMessage,
      forceQueuedMessage,
      editQueuedMessage,
      setQueuedMessageEditLock,
      command,
    },
  }),
}));

const PROJECT = 'web-core:ws-1';
const WORKTREE = 'web-core:task-1';
const CHAT = 'web-core:chat-1';
const TARGET = { projectId: PROJECT, worktreeId: WORKTREE, chatId: CHAT };

const LOST_NEVER: CanopyErrorPayload = {
  kind: 'unavailable',
  message: 'The reply was lost.',
  retry: { kind: 'never' },
};
const LOST_SAME_KEY: CanopyErrorPayload = {
  kind: 'unavailable',
  message: 'The reply was lost.',
  retry: { kind: 'same_idempotency_key' },
};
/** The client's own deadline after dispatch, as the relay answers it. */
const DEADLINE: CanopyErrorPayload = {
  kind: 'deadline_exceeded',
  message: 'The relay deadline passed.',
  retry: { kind: 'same_idempotency_key' },
};
const RETRY_EXPIRED: CanopyErrorPayload = {
  kind: 'conflict',
  code: 'core.chat.revisionConflict',
  message: 'The queue changed since that attempt.',
  retry: { kind: 'after_refresh', resource: 'core.chat.snapshot' },
  details: { reason: 'retry_expired' },
};

function seed(): void {
  const tab = {
    ...createEmptyTab(),
    id: CHAT,
    queuedMessages: [
      { id: 'queued-1', text: 'Queued', hostQueueEntryId: 'entry-1' },
    ],
  };
  useChatStore.setState({
    selectedWorktree: { projectId: PROJECT, worktreeId: WORKTREE },
    queuedMessageEditFailures: {},
    unsavedQueuedEdits: [],
    worktreeChats: {
      [`${PROJECT}/${WORKTREE}`]: { tabs: [tab], activeTabId: CHAT },
    },
  } as never);
}

/** Local preload stubs: every call resolves, every subscription is inert. */
function inertApi(): unknown {
  const call = (): Promise<undefined> => Promise.resolve(undefined);
  const handler: ProxyHandler<typeof call> = {
    get: (_target, property) => {
      if (property === 'then') return undefined;
      if (typeof property === 'string' && property.startsWith('on'))
        return () => (): void => undefined;
      return new Proxy(call, handler);
    },
    apply: call,
  };
  return new Proxy(call, handler);
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('a cloud queued message command that can’t be confirmed (CAN-7196)', () => {
  const addToast = jest.fn();
  let shownToast: unknown;
  let consoleError: jest.SpyInstance;
  beforeAll(() => {
    Object.assign(window, { api: inertApi() });
  });
  beforeEach(() => {
    jest.clearAllMocks();
    shownToast = useGitHubStore.getState().addToast;
    useGitHubStore.setState({ addToast });
    consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    seed();
  });
  afterEach(() => {
    useGitHubStore.setState({ addToast: shownToast } as never);
    consoleError.mockRestore();
  });
  const notices = (): unknown[][] =>
    addToast.mock.calls.map(([message, type]: unknown[]) => [message, type]);

  it.each([
    ['lost, never retried', LOST_NEVER, QUEUE_COMMAND_UNCONFIRMED_NOTICE],
    ['lost, same key', LOST_SAME_KEY, QUEUE_COMMAND_UNCONFIRMED_NOTICE],
    ["the client's own deadline", DEADLINE, QUEUE_COMMAND_UNCONFIRMED_NOTICE],
    ['retry expired', RETRY_EXPIRED, QUEUE_RETRY_EXPIRED_NOTICE],
  ] as const)(
    'Cancel and Run now %s say what the queue shows, once each, and log no failure',
    async (_case, payload, notice) => {
      cancelQueuedMessage.mockRejectedValue(
        new CoreCoworkRequestError(payload),
      );
      forceQueuedMessage.mockRejectedValue(new CoreCoworkRequestError(payload));
      useChatStore.getState().clearQueuedMessage(0, TARGET);
      await settle();
      useChatStore.getState().forceQueuedMessage(0, TARGET);
      await settle();
      expect(cancelQueuedMessage).toHaveBeenCalledTimes(1);
      expect(forceQueuedMessage).toHaveBeenCalledTimes(1);
      expect(notices()).toEqual([
        [notice, 'info'],
        [notice, 'info'],
      ]);
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['lost, never retried', LOST_NEVER, QUEUE_EDIT_UNCONFIRMED_NOTICE, true],
    ['lost, same key', LOST_SAME_KEY, QUEUE_EDIT_UNCONFIRMED_NOTICE, true],
    [
      "the client's own deadline",
      DEADLINE,
      QUEUE_EDIT_UNCONFIRMED_NOTICE,
      true,
    ],
    // Core forgot the first attempt: nothing was written, so it is unsaved.
    ['retry expired', RETRY_EXPIRED, QUEUE_RETRY_EXPIRED_NOTICE, false],
  ] as const)(
    "an edit %s says what the queue shows, never “Couldn't save your edit.”, and is sent once",
    async (_case, payload, notice, unconfirmed) => {
      editQueuedMessage.mockRejectedValue(new CoreCoworkRequestError(payload));
      useChatStore
        .getState()
        .saveEditedQueuedMessage(
          0,
          'Queued, edited',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          TARGET,
        );
      await settle();
      expect(editQueuedMessage).toHaveBeenCalledTimes(1);
      expect(notices()).toEqual([[notice, 'info']]);
      expect(useChatStore.getState().queuedMessageEditFailures).toEqual({});
      // Its hold is let go, as after any edit that didn't settle.
      expect(setQueuedMessageEditLock).toHaveBeenCalledTimes(1);
      // Its text stays, labelled "Couldn't confirm this edit" only when the
      // save may have landed (SWAN Q3).
      expect(useChatStore.getState().unsavedQueuedEdits).toEqual([
        expect.objectContaining({
          text: 'Queued, edited',
          ...(unconfirmed ? { unconfirmed: true } : {}),
        }),
      ]);
      if (!unconfirmed)
        expect(
          useChatStore.getState().unsavedQueuedEdits[0],
        ).not.toHaveProperty('unconfirmed');
    },
  );

  // CAN-7196 (review round 4): a Cancel, Run now or edit still out when a
  // sign-out, account change or disconnect clears its chat says nothing of
  // it in the next session, and logs no failure.
  it.each(['cancel', 'force', 'edit'] as const)(
    'shows nothing for a %s that may have landed after its cloud chat was cleared',
    async (command) => {
      let fail: (error: unknown) => void = () => undefined;
      const pending = new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
      if (command === 'cancel') cancelQueuedMessage.mockReturnValue(pending);
      if (command === 'force') forceQueuedMessage.mockReturnValue(pending);
      if (command === 'edit') editQueuedMessage.mockReturnValue(pending);
      if (command === 'cancel')
        useChatStore.getState().clearQueuedMessage(0, TARGET);
      if (command === 'force')
        useChatStore.getState().forceQueuedMessage(0, TARGET);
      if (command === 'edit')
        useChatStore
          .getState()
          .saveEditedQueuedMessage(
            0,
            'Queued, edited',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            TARGET,
          );
      await settle();
      // The chat is cleared while the command's answer is still out.
      useChatStore.setState({ worktreeChats: {} } as never);
      fail(new CoreCoworkRequestError(LOST_NEVER));
      await settle();
      expect(addToast).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  /** Fails `command` with `error`, as the backend answers it. */
  async function failWith(
    command: 'cancel' | 'force' | 'edit',
    error: unknown,
  ): Promise<void> {
    if (command === 'cancel') {
      cancelQueuedMessage.mockRejectedValue(error);
      useChatStore.getState().clearQueuedMessage(0, TARGET);
    }
    if (command === 'force') {
      forceQueuedMessage.mockRejectedValue(error);
      useChatStore.getState().forceQueuedMessage(0, TARGET);
    }
    if (command === 'edit') {
      editQueuedMessage.mockRejectedValue(error);
      useChatStore
        .getState()
        .saveEditedQueuedMessage(
          0,
          'Queued, edited',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          TARGET,
        );
    }
    await settle();
  }

  // CAN-7196 (review round 5): the backend answers before its queue read is
  // in only when that read failed. The notice never says the queue is
  // current until a read is: it says it is still checking, then what the
  // queue shows once the backend's next read lands.
  it.each([
    [
      'cancel',
      LOST_NEVER,
      QUEUE_COMMAND_UNREAD_NOTICE,
      QUEUE_COMMAND_UNCONFIRMED_NOTICE,
    ],
    [
      'force',
      LOST_SAME_KEY,
      QUEUE_COMMAND_UNREAD_NOTICE,
      QUEUE_COMMAND_UNCONFIRMED_NOTICE,
    ],
    ['edit', DEADLINE, QUEUE_EDIT_UNREAD_NOTICE, QUEUE_EDIT_UNCONFIRMED_NOTICE],
    [
      'cancel',
      RETRY_EXPIRED,
      QUEUE_COMMAND_UNREAD_NOTICE,
      QUEUE_RETRY_EXPIRED_NOTICE,
    ],
  ] as const)(
    'a %s whose queue read is still out says it is still checking, then what the queue shows once a read is in',
    async (command, payload, unread, shownNotice) => {
      let land = (): void => undefined;
      const read = new Promise<void>((resolve) => {
        land = resolve;
      });
      const error = new WebCoreQueueCommandUnsettledError(payload, {
        installed: false,
        shown: read,
      });
      await failWith(command, error);
      expect(notices()).toEqual([[unread, 'info']]);
      expect(useChatStore.getState().queuedMessageEditFailures).toEqual({});
      land();
      await settle();
      expect(notices()).toEqual([
        [unread, 'info'],
        [shownNotice, 'info'],
      ]);
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it('reads the queue again at 250 ms doubling to 8 s, then every 8 s with no last try, still checking until a read is in', async () => {
    expect(
      Array.from({ length: 9 }, (_, index) => queueRereadDelayMs(index + 1)),
    ).toEqual([250, 500, 1000, 2000, 4000, 8000, 8000, 8000, 8000]);
    expect(queueRereadDelayMs(1_000)).toBe(8000);
    // A read in after any number of failures at 8 s ends it.
    let land = (): void => undefined;
    const read = new Promise<void>((resolve) => {
      land = resolve;
    });
    await failWith(
      'cancel',
      new WebCoreQueueCommandUnsettledError(LOST_NEVER, {
        installed: false,
        shown: read,
      }),
    );
    land();
    await settle();
    expect(notices()).toEqual([
      [QUEUE_COMMAND_UNREAD_NOTICE, 'info'],
      [QUEUE_COMMAND_UNCONFIRMED_NOTICE, 'info'],
    ]);
  });

  // A command answered with its read in says what the queue shows at once.
  it.each([
    ['cancel', QUEUE_COMMAND_UNCONFIRMED_NOTICE],
    ['force', QUEUE_COMMAND_UNCONFIRMED_NOTICE],
    ['edit', QUEUE_EDIT_UNCONFIRMED_NOTICE],
  ] as const)(
    'a %s answered once its queue read is in says what the queue shows, once',
    async (command, notice) => {
      await failWith(
        command,
        new WebCoreQueueCommandUnsettledError(LOST_NEVER, {
          installed: true,
          shown: Promise.resolve(),
        }),
      );
      await settle();
      expect(notices()).toEqual([[notice, 'info']]);
    },
  );

  it.each(['cancel', 'force', 'edit'] as const)(
    'a %s whose queue read never lands never says the queue is current, and says nothing more once its chat is cleared',
    async (command) => {
      let land = (): void => undefined;
      const read = new Promise<void>((resolve) => {
        land = resolve;
      });
      const error = new WebCoreQueueCommandUnsettledError(LOST_NEVER, {
        installed: false,
        shown: read,
      });
      await failWith(command, error);
      const unread =
        command === 'edit'
          ? QUEUE_EDIT_UNREAD_NOTICE
          : QUEUE_COMMAND_UNREAD_NOTICE;
      await settle();
      expect(notices()).toEqual([[unread, 'info']]);
      // A sign-out clears the chat; a read landing after it shows nothing.
      useChatStore.setState({ worktreeChats: {} } as never);
      land();
      await settle();
      expect(notices()).toEqual([[unread, 'info']]);
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a refusal', 'failed_precondition', { kind: 'never' }],
    ['busy, same request', 'unavailable', { kind: 'same_request' }],
    ['out of capacity', 'resource_exhausted', { kind: 'never' }],
    ["the core's own deadline", 'deadline_exceeded', { kind: 'never' }],
    [
      'busy, after a refresh',
      'unavailable',
      { kind: 'after_refresh', resource: 'core.chat.snapshot' },
    ],
  ] as const)(
    'any other failure (%s) keeps its own handling: logged, and an edit says it wasn’t saved',
    async (_case, kind, retry) => {
      const refused = new CoreCoworkRequestError({
        kind,
        message: 'The queued message is running.',
        retry,
      });
      cancelQueuedMessage.mockRejectedValue(refused);
      editQueuedMessage.mockRejectedValue(refused);
      useChatStore.getState().clearQueuedMessage(0, TARGET);
      await settle();
      expect(consoleError).toHaveBeenCalledTimes(1);
      useChatStore
        .getState()
        .saveEditedQueuedMessage(
          0,
          'Queued, edited',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          TARGET,
        );
      await settle();
      expect(addToast).not.toHaveBeenCalled();
      expect(
        Object.keys(useChatStore.getState().queuedMessageEditFailures),
      ).toHaveLength(1);
    },
  );

  it.each([
    ['lost, never retried', LOST_NEVER],
    ['lost, same key', LOST_SAME_KEY],
    ["the client's own deadline", DEADLINE],
  ] as const)(
    "a tab command %s reads the view again and says it couldn't confirm it, never “Try again.”",
    async (_case, payload) => {
      command.mockRejectedValue(new CoreCoworkRequestError(payload));
      const refresh = jest
        .spyOn(RevisionedChatSync.prototype, 'forceRefresh')
        .mockImplementation(() => undefined);
      const disposition = await useChatStore.getState().dispatchChatCommand(
        { projectId: PROJECT, worktreeId: WORKTREE },
        {
          type: 'chat.set_model',
          tabId: CHAT,
          model: 'claude-sonnet',
          providerType: 'claude',
        },
      );
      expect(disposition).toBe('transport_failed');
      expect(command).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().chatStateNotices[`${PROJECT}/${WORKTREE}`],
      ).toEqual({
        kind: 'unconfirmed',
        message: CHAT_STATE_UNCONFIRMED_NOTICE,
      });
      // The view is read again, as after a stale change.
      expect(refresh).toHaveBeenCalledWith(PROJECT, WORKTREE);
      refresh.mockRestore();
    },
  );

  it.each([
    ['a dropped relay', new Error('The relay is gone.')],
    [
      "the core's own deadline",
      new CoreCoworkRequestError({
        kind: 'deadline_exceeded',
        message: 'The core ran out of time.',
        retry: { kind: 'never' },
      }),
    ],
    [
      'busy, same request',
      new CoreCoworkRequestError({
        kind: 'unavailable',
        message: 'The core is busy.',
        retry: { kind: 'same_request' },
      }),
    ],
  ] as const)(
    'a tab command that failed some other way (%s) still says Try again',
    async (_case, failure) => {
      command.mockRejectedValue(failure);
      await useChatStore.getState().dispatchChatCommand(
        { projectId: PROJECT, worktreeId: WORKTREE },
        {
          type: 'chat.set_model',
          tabId: CHAT,
          model: 'claude-sonnet',
          providerType: 'claude',
        },
      );
      expect(command).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().chatStateNotices[`${PROJECT}/${WORKTREE}`],
      ).toEqual({
        kind: 'command_failed',
        message: CHAT_STATE_COMMAND_FAILED_NOTICE,
      });
    },
  );
});

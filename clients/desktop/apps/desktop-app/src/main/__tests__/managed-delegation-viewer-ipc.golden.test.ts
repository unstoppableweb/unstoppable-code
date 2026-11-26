// The delegate viewer's two tunneled channels, through their registered IPC
// handlers: `managed-delegation:message` sends a follow-up, steer or interrupt,
// and `managed-delegation:transcript-page` reads a page of a delegate's
// transcript. A valid request reaches the delegation service unchanged and its
// outcome comes back as it is; a malformed one is refused as
// `invalid_request` before the service runs; and a service failure is reported
// as `failed` with no internal detail. A paired or older controller depends on
// both shapes. The service behind them is pinned by delegation-readers-golden.
import {
  IPC_CHANNELS,
  type ManagedDelegationMessageResult,
  type ManagedDelegationTranscriptPageResult,
} from '@canopy/desktop-shared/types';

const mockHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockMessage = jest.fn();
const mockTranscriptPage = jest.fn();

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../lib/window-send', () => ({ sendToAllWindows: jest.fn() }));
jest.mock('../services/desktop-session-snapshot-invalidation', () => ({
  requestDesktopSessionSnapshotInvalidation: jest.fn(),
}));
jest.mock('../agents/delegation/service', () => ({
  messageManagedDelegationForUser: (...args: unknown[]): unknown =>
    mockMessage(...args),
  readManagedDelegationTranscriptForUser: (...args: unknown[]): unknown =>
    mockTranscriptPage(...args),
}));

import { registerManagedDelegationHandlers } from '../ipc/managed-delegation';

const TARGET = {
  projectId: 'project-a',
  worktreeId: 'worktree-a',
  chatId: 'chat-a',
};

async function invoke(channel: string, request: unknown): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  return await handler({}, request);
}

beforeEach(() => {
  mockHandlers.clear();
  mockMessage.mockReset();
  mockTranscriptPage.mockReset();
  registerManagedDelegationHandlers();
});

describe('managed-delegation:message', () => {
  const message = {
    ...TARGET,
    delegationId: 'delegate-1',
    operation: 'follow_up',
    operationId: '11111111-1111-4111-8111-111111111111',
    message: 'Continue with the next file',
  };

  it('is the tunneled channel the viewer sends on', () => {
    expect(IPC_CHANNELS.managedDelegationMessage).toBe(
      'managed-delegation:message',
    );
  });

  it('forwards a valid message to the service and returns its outcome unchanged', async () => {
    const accepted = {
      ok: true,
      snapshot: {
        delegationId: 'delegate-1',
        status: 'running',
        outputTruncated: false,
      },
    };
    mockMessage.mockResolvedValueOnce(accepted);
    expect(
      await invoke(IPC_CHANNELS.managedDelegationMessage, message),
    ).toEqual(accepted);
    expect(mockMessage).toHaveBeenCalledWith(message);

    for (const code of [
      'parent_unavailable',
      'busy',
      'not_found',
      'discarded',
      'failed',
    ] as const) {
      const refused: ManagedDelegationMessageResult = {
        ok: false,
        code,
        error: `the service said ${code}`,
      };
      mockMessage.mockResolvedValueOnce(refused);
      expect(
        await invoke(IPC_CHANNELS.managedDelegationMessage, message),
      ).toEqual(refused);
    }
  });

  it('accepts an interrupt without a message and drops any message sent with it', async () => {
    mockMessage.mockResolvedValueOnce({ ok: true, snapshot: {} });
    await invoke(IPC_CHANNELS.managedDelegationMessage, {
      ...message,
      operation: 'interrupt',
      message: { unexpected: 'payload' },
    });
    expect(mockMessage).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'interrupt', message: undefined }),
    );
  });

  it.each([
    ['an operation id that is not a UUID', { operationId: 'not-a-uuid' }],
    ['a blank follow-up', { message: '   ' }],
    ['a message over 32,768 characters', { message: 'x'.repeat(32_769) }],
    ['an unknown operation', { operation: 'discard' }],
    ['a chat id with a path', { chatId: '../chat' }],
    ['a delegation id with a path', { delegationId: '../delegate' }],
    ['a project id with a path', { projectId: '../project' }],
  ])('refuses %s before the service runs', async (_label, fields) => {
    expect(
      await invoke(IPC_CHANNELS.managedDelegationMessage, {
        ...message,
        ...fields,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(mockMessage).not.toHaveBeenCalled();
  });

  it('reports a service failure as failed without its internal detail', async () => {
    mockMessage.mockRejectedValueOnce(new Error('/private/var/broker failed'));
    const result = await invoke(IPC_CHANNELS.managedDelegationMessage, message);
    expect(result).toMatchObject({ ok: false, code: 'failed' });
    expect(JSON.stringify(result)).not.toContain('/private');
  });
});

describe('managed-delegation:transcript-page', () => {
  const page = {
    ...TARGET,
    delegationId: 'delegate-1',
    beforeSequence: 10,
    limit: 2,
  };

  it('is the tunneled channel the viewer reads from', () => {
    expect(IPC_CHANNELS.managedDelegationTranscriptPage).toBe(
      'managed-delegation:transcript-page',
    );
  });

  it('forwards a page request to the service and returns its page unchanged', async () => {
    const result = {
      ok: true,
      task: { description: 'Review' },
      snapshot: {},
      runGeneration: 1,
      items: [],
      hasMore: false,
    };
    mockTranscriptPage.mockResolvedValueOnce(result);
    expect(
      await invoke(IPC_CHANNELS.managedDelegationTranscriptPage, page),
    ).toEqual(result);
    expect(mockTranscriptPage).toHaveBeenCalledWith(page);
  });

  it('keeps the service not_found for another chat', async () => {
    const missing: ManagedDelegationTranscriptPageResult = {
      ok: false,
      code: 'not_found',
      error: 'No such delegate in this chat.',
    };
    mockTranscriptPage.mockResolvedValueOnce(missing);
    expect(
      await invoke(IPC_CHANNELS.managedDelegationTranscriptPage, {
        ...page,
        chatId: 'chat-b',
      }),
    ).toEqual(missing);
  });

  it.each([
    ['a limit over 200', { limit: 201 }],
    ['a zero limit', { limit: 0 }],
    ['a fractional limit', { limit: 1.5 }],
    ['a negative cursor', { beforeSequence: -1 }],
    ['a run generation of zero', { runGeneration: 0 }],
    ['a delegation id with a path', { delegationId: '../delegate' }],
    ['a chat id with a path', { chatId: '../chat' }],
  ])('refuses %s before the service runs', async (_label, fields) => {
    expect(
      await invoke(IPC_CHANNELS.managedDelegationTranscriptPage, {
        ...page,
        ...fields,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(mockTranscriptPage).not.toHaveBeenCalled();
  });

  it('reports a service failure as failed without its internal detail', async () => {
    mockTranscriptPage.mockRejectedValueOnce(
      new Error('/private/var/transcript unreadable'),
    );
    const result = await invoke(
      IPC_CHANNELS.managedDelegationTranscriptPage,
      page,
    );
    expect(result).toMatchObject({ ok: false, code: 'failed' });
    expect(JSON.stringify(result)).not.toContain('/private');
  });
});

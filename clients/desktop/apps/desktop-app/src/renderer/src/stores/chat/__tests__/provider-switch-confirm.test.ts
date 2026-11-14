/** @jest-environment jsdom */
/**
 * CAN-6445: a provider switch the dialog offered is checked again when it is
 * confirmed. A turn that started in another window or the Portal while the
 * dialog was open blocks it, so main never parks the session of a provider
 * that is still running.
 */
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import type { ChatTab } from '../types';
import { useChatStore } from '@/stores/chatStore';
import { createEmptyTab } from '../tab-utils';

const PROJECT = 'project-1';
const WORKTREE = 'worktree-1';
const CHAT = 'chat-1';
const TARGET = { projectId: PROJECT, worktreeId: WORKTREE, chatId: CHAT };

const changeModel = jest.fn<Promise<boolean>, [unknown]>(() =>
  Promise.resolve(true),
);

/** Preload stubs: `chat.changeModel` records, everything else is inert. */
function stubApi(): unknown {
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
  const inert = new Proxy(call, handler);
  const inertMember = (property: string | symbol): unknown =>
    Reflect.get(inert, property) as unknown;
  const chat = new Proxy(
    {},
    {
      get: (_chat, method): unknown =>
        method === 'changeModel' ? changeModel : inertMember(method),
    },
  );
  return new Proxy(
    {},
    {
      get: (_target, property): unknown =>
        property === 'chat' ? chat : inertMember(property),
    },
  );
}

function seed(extra: Partial<ChatTab>): void {
  useChatStore.setState({
    worktreeChats: {
      [`${PROJECT}/${WORKTREE}`]: {
        tabs: [
          {
            ...createEmptyTab(),
            id: CHAT,
            model: 'claude-opus-4-6',
            providerType: 'claude',
            messages: [
              {
                id: 'user-1',
                role: 'user',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'Fix the badge' }],
              },
              {
                id: 'assistant-1',
                role: 'assistant',
                timestamp: 2,
                blocks: [{ type: 'text', text: 'Done.' }],
              },
            ],
            ...extra,
          },
        ],
        activeTabId: CHAT,
      },
    },
  } as never);
}

const switchToCodex = (): Promise<boolean> =>
  useChatStore
    .getState()
    .setModelAndWait('gpt-6-sol', TARGET, undefined, undefined, {
      switchesProvider: true,
      notice: { id: 'notice-1', timestamp: 3, text: 'Switched.' },
    });

beforeAll(() => {
  Object.assign(window, { api: stubApi() });
  initClaudeModels([{ id: 'claude-opus-4-6', label: 'Opus 4.6' }]);
  initCodexModels([{ id: 'gpt-6-sol', label: 'GPT 6 Sol' }]);
});

afterAll(() => {
  initClaudeModels([]);
  initCodexModels([]);
});

beforeEach(() => {
  changeModel.mockClear();
});

it.each<[string, Partial<ChatTab>]>([
  ['a turn that started meanwhile', { status: 'streaming' }],
  [
    'a message queued meanwhile',
    { queuedMessages: [{ text: 'Also check the footer' }] },
  ],
])('refuses a confirmed switch after %s', async (_label, extra) => {
  seed(extra);

  await expect(switchToCodex()).resolves.toBe(false);
  expect(changeModel).not.toHaveBeenCalled();
});

it('sends a confirmed switch for a chat that can still switch', async () => {
  seed({ status: 'idle' });

  await switchToCodex();

  expect(changeModel).toHaveBeenCalledTimes(1);
  expect(changeModel.mock.calls[0]?.[0]).not.toHaveProperty('lockedHarness');
});

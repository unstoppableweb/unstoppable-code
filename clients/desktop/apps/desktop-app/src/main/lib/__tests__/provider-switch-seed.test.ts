import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { readChatTranscript } from '../chat-tabs-reader';
import { loadProviderSwitchSeed } from '../provider-switch-seed';

jest.mock('../chat-tabs-reader', () => ({
  readChatTranscript: jest.fn(),
}));

const consumeProviderSwitchSeed = jest.fn(() => Promise.resolve());
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): {
    consumeProviderSwitchSeed: typeof consumeProviderSwitchSeed;
  } => ({ consumeProviderSwitchSeed }),
}));

const readTranscript = jest.mocked(readChatTranscript);

const transcript: PersistedChatMessage[] = [
  {
    id: 'user-1',
    role: 'user',
    timestamp: 1,
    blocks: [{ type: 'text', text: 'Earlier question on Claude' }],
  },
  {
    id: 'assistant-1',
    role: 'assistant',
    timestamp: 2,
    blocks: [{ type: 'text', text: 'Earlier answer from Claude' }],
  },
  {
    id: 'user-2',
    role: 'user',
    timestamp: 3,
    blocks: [{ type: 'text', text: 'The message this turn sends' }],
  },
];

const turn = {
  projectId: 'cowork-default',
  worktreeId: 'entry-1',
  chatId: 'chat-1',
  userMessageId: 'user-2',
  model: 'gpt-6-sol',
};

describe('provider switch seed delivery (CAN-6445)', () => {
  beforeEach(() => {
    consumeProviderSwitchSeed.mockClear();
    readTranscript.mockReset();
    readTranscript.mockResolvedValue(transcript);
  });

  it('carries the conversation, without this turn, when the seed is owed', async () => {
    const seed = await loadProviderSwitchSeed({ ...turn, pending: true });

    expect(readTranscript).toHaveBeenCalledWith(
      'cowork-default',
      'entry-1',
      'chat-1',
      true,
    );
    expect(seed?.text).toContain('Earlier question on Claude');
    expect(seed?.text).toContain('Earlier answer from Claude');
    expect(seed?.text).not.toContain('The message this turn sends');
    // Owed until the provider accepts the turn that carries it.
    expect(consumeProviderSwitchSeed).not.toHaveBeenCalled();
    await seed?.delivered();
    expect(consumeProviderSwitchSeed).toHaveBeenCalledWith(
      { projectId: 'cowork-default', worktreeId: 'entry-1' },
      'chat-1',
    );
  });

  it('keeps the continued message in a continuation’s seed (a stopped turn’s Resume)', async () => {
    const seed = await loadProviderSwitchSeed({
      ...turn,
      pending: true,
      continuation: true,
    });

    expect(seed?.text).toContain('Earlier answer from Claude');
    expect(seed?.text).toContain('The message this turn sends');
  });

  it('adds nothing when no seed is owed', async () => {
    await expect(
      loadProviderSwitchSeed({ ...turn, pending: false }),
    ).resolves.toBeUndefined();
    expect(readTranscript).not.toHaveBeenCalled();
  });
});

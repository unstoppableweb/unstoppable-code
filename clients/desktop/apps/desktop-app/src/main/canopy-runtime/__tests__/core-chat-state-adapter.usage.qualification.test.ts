import type {
  ChatStateCommandPort,
  ChatStateSnapshot,
  ChatTabUsage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { CanopyQueryResult } from '@canopy/protocol/canopy-core';
import { CoreChatSnapshotGetResultSchema } from '@canopy/protocol/canopy-core';
import { createDesktopRuntime } from '../desktop-runtime';

const caller = {
  principalId: 'test-user',
  clientInstanceId: 'test-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test' as const,
  grants: ['core.chat.read' as const],
};

const scope = { workspaceId: 'project-1', worktreeId: 'worktree-1' };

function chatTab(
  id: string,
  fields: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id,
    title: id,
    createdAt: '2026-11-05T00:00:00.000Z',
    messages: [],
    ...fields,
  };
}

function usage(fields: Partial<ChatTabUsage> = {}): ChatTabUsage {
  return {
    contextTokens: 42_000,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    totalCostUsd: 1.25,
    inputTokens: 1_200,
    outputTokens: 3_400,
    cacheReadInputTokens: 50_000,
    cacheCreationInputTokens: 6_000,
    durationMs: 90_000,
    durationApiMs: 80_000,
    numTurns: 3,
    model: 'claude-opus-4-5',
    ...fields,
  };
}

function snapshotOf(tabs: PersistedChatTab[]): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    revision: 3,
    tabsFile: { version: 1, activeTabId: tabs[0]?.id ?? '', tabs },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}

/** The port serves exactly the stored state it is given. */
function createPort(snapshot: unknown): ChatStateCommandPort {
  return {
    getState: jest.fn().mockResolvedValue(snapshot),
    getTranscriptPage: jest.fn(),
    searchTranscript: jest.fn(),
    readVisual: jest.fn(),
    readToolOutput: jest.fn(),
    command: jest.fn(),
    subscribe: jest.fn(() => () => {}),
  };
}

async function readState(
  snapshot: unknown,
): Promise<CanopyQueryResult<'core.chat.snapshot.get'>> {
  const runtime = createDesktopRuntime({
    getChatStatePort: () => createPort(snapshot),
  });
  try {
    return await runtime.query('core.chat.snapshot.get', { scope }, { caller });
  } finally {
    await runtime.shutdown();
  }
}

function readSnapshot(
  tabs: PersistedChatTab[],
): Promise<CanopyQueryResult<'core.chat.snapshot.get'>> {
  return readState(snapshotOf(tabs));
}

describe('chat snapshot usage and limit projection (CAN-4114)', () => {
  it("projects a chat's committed usage", async () => {
    const result = await readSnapshot([
      chatTab('chat-1', {
        usage: usage({
          cursorReportedUsage: { inputTokens: 1, outputTokens: 2 },
        }),
      }),
    ]);
    expect(result.tabs.items[0]?.usage).toEqual({
      contextTokens: 42_000,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      inputTokens: 1_200,
      outputTokens: 3_400,
      cacheReadInputTokens: 50_000,
      cacheCreationInputTokens: 6_000,
      totalCostUsd: 1.25,
      numTurns: 3,
      model: 'claude-opus-4-5',
    });
    expect(() => CoreChatSnapshotGetResultSchema.parse(result)).not.toThrow();
  });

  it('projects the usage limit without provider text', async () => {
    const banner = {
      provider: 'codex' as const,
      message: 'You hit your limit (req_abc123)',
      requestId: 'req_abc123',
      detectedAt: 1000,
      resetsAt: 5000,
      dismissKey: 'k',
    };
    const result = await readSnapshot([
      chatTab('chat-1', { llmProviderUsageLimitBanner: banner }),
    ]);
    expect(result.tabs.items[0]?.usageLimit).toEqual({
      provider: 'codex',
      detectedAt: 1000,
      resetsAt: 5000,
      dismissed: false,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('req_abc123');
    expect(serialized).not.toContain('You hit');
    const dismissed = await readSnapshot([
      chatTab('chat-1', {
        llmProviderUsageLimitBanner: banner,
        dismissedLlmProviderUsageLimitBannerKey: 'k',
      }),
    ]);
    expect(dismissed.tabs.items[0]?.usageLimit?.dismissed).toBe(true);
    const switched = await readSnapshot([
      chatTab('chat-1', {
        providerType: 'antigravity',
        model: 'antigravity:gemini-4-neon',
        llmProviderUsageLimitBanner: banner,
      }),
    ]);
    expect(switched.tabs.items[0]?.usageLimit).toBeUndefined();
  });

  it('serves usage and limit state from the committed tab alone', async () => {
    const snapshot = snapshotOf([
      chatTab('chat-1', {
        usage: usage(),
        llmProviderUsageLimitBanner: {
          provider: 'claude',
          message: 'Usage limit reached',
          detectedAt: 2000,
          dismissKey: 'd',
        },
        aiCreditsNoBillingSource: { provider: 'claude', detectedAt: 3000 },
      }),
    ]);
    const first = await readState(snapshot);
    const storedSnapshot: unknown = JSON.parse(JSON.stringify(snapshot));
    const restarted = await readState(storedSnapshot);
    const anyEpoch: unknown = expect.any(String);
    expect(restarted).toEqual({
      ...first,
      eventsCursor: { daemonEpoch: anyEpoch, sequence: first.revision },
    });
    expect(first.tabs.items[0]?.noBillingSource).toEqual({
      provider: 'claude',
      detectedAt: 3000,
    });
  });

  it('reads malformed persisted numbers as zero', async () => {
    const result = await readSnapshot([
      chatTab('chat-1', {
        usage: usage({
          contextTokens: Number.NaN,
          inputTokens: -5,
          outputTokens: Number.POSITIVE_INFINITY,
          numTurns: 12.9,
          totalCostUsd: -1,
        }),
      }),
    ]);
    expect(result.tabs.items[0]?.usage).toMatchObject({
      contextTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      numTurns: 12,
      totalCostUsd: 0,
    });
    expect(() => CoreChatSnapshotGetResultSchema.parse(result)).not.toThrow();
  });

  it('gives file tabs no usage', async () => {
    const result = await readSnapshot([
      chatTab('file-1', {
        kind: 'file',
        usage: usage(),
        llmProviderUsageLimitBanner: {
          provider: 'claude',
          message: 'Usage limit reached',
          detectedAt: 2000,
          dismissKey: 'd',
        },
        aiCreditsNoBillingSource: { provider: 'claude', detectedAt: 3000 },
      }),
      chatTab('chat-1'),
    ]);
    for (const item of result.tabs.items) {
      expect(item).not.toHaveProperty('usage');
      expect(item).not.toHaveProperty('usageLimit');
      expect(item).not.toHaveProperty('noBillingSource');
    }
  });
});

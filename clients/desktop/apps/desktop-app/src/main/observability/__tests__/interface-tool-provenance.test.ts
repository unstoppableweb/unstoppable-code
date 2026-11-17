// CAN-5828: each interface tool call records, on its turn's audit entry,
// which lease, interface and window answered it, and nothing of its content.
// Drives the real service on the CAN-5065 golden host; observability:load-history
// serves the stored entries.
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import type { OpenAiPricingCacheState } from '../../openai-pricing/pricing-client';
import type { ObservabilityService } from '../service';
import {
  GOLDEN_PRICING_STATE,
  createDesktopHost,
  disposeAll,
  finalAuditEntries,
  goldenAccount,
  restoreGoldenEnvironment,
  useGoldenTimers,
} from './golden/desktop-host';
import { PROJECT, WORKTREE, chatStart } from './golden/fixtures';
import {
  GOLDEN_START_TIME,
  readFinalAuditLines,
  runGoldenScenario,
  type GoldenScenario,
  type GoldenScenarioContext,
} from './golden/harness';

const mockPricing = GOLDEN_PRICING_STATE;
const mockAccount = goldenAccount;

/** The incarnation `getObservabilityService()` returns to producers. */
let mockCurrentService: unknown = null;
function setCurrentService(service: unknown): void {
  mockCurrentService = service;
}

jest.mock('../index', () => ({
  getObservabilityService: (): unknown => mockCurrentService,
  peekObservabilityService: (): unknown => mockCurrentService,
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<{
    auditRetentionDays: number;
    cursorEnabled: boolean;
    copilotEnabled: boolean;
  }> =>
    Promise.resolve({
      auditRetentionDays: 7,
      cursorEnabled: false,
      copilotEnabled: false,
    }),
}));
jest.mock('../../auth/provider-auth-state', () => ({
  checkClaudeAuthStatusObserved: (): Promise<{ authenticated: false }> =>
    Promise.resolve({ authenticated: false }),
  peekProviderAccountIdentity: (provider: AgentProviderType): unknown => {
    const account = mockAccount(provider);
    return account ? { ...account.identity } : null;
  },
  peekProviderBillingAccountKind: (provider: AgentProviderType): string =>
    mockAccount(provider)?.billingAccountKind ?? 'unknown',
  warmProviderAccountIdentity: (): void => undefined,
}));
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { onSnapshotChanged: () => () => void } => ({
    onSnapshotChanged: (): (() => void) => (): void => undefined,
  }),
}));
jest.mock('../../antigravity/feature-flag', () => ({
  isAntigravityHarnessEnabled: (): boolean => false,
}));
jest.mock('../../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: (): boolean => false,
}));
jest.mock('../../cursor/account-usage', () => ({
  readCursorAccountUsage: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../../copilot/feature-flag', () => ({
  isCopilotHarnessEnabled: (): boolean => false,
}));
jest.mock('../../copilot/account-usage', () => ({
  readCopilotUsageSummary: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../../copilot/usage-events', () => ({
  onCopilotUsageChanged: (): (() => void) => (): void => undefined,
}));
jest.mock('../../codex/runtime-service', () => ({
  getCodexRuntimeService: (): unknown => ({
    admin: (): unknown => ({
      request: (): Promise<{ account: null }> =>
        Promise.resolve({ account: null }),
      onAccountUpdated: (): (() => void) => (): void => undefined,
      onRateLimitsUpdated: (): (() => void) => (): void => undefined,
    }),
  }),
}));
jest.mock('../../account-proxy/service', () => ({
  getAccountProxyUsageInventory: (): [] => [],
  fetchAccountProxyUsage: (): Promise<never> =>
    Promise.reject(new Error('No account proxy in the golden host')),
  publishAccountProxyStatus: (): Promise<void> => Promise.resolve(),
  onAccountProxyInventoryChanged: (): (() => void) => (): void => undefined,
}));
jest.mock('../../openai-pricing/pricing-client', () => ({
  getOpenAiPricingForCostingSync: (): OpenAiPricingCacheState => mockPricing,
  getOpenAiPricingForCosting: (): Promise<OpenAiPricingCacheState> =>
    Promise.resolve(mockPricing),
  prewarmOpenAiPricingCache: (): void => undefined,
}));
jest.mock('../../lib/pipeline-run-completion-emitter', () => ({
  emitPipelineRunCompletion: (): void => undefined,
}));
jest.mock('../../pipelines/action-resolver', () => ({
  resolveAction: (): undefined => undefined,
}));

jest.setTimeout(120_000);
import { ObservabilityAuditEntrySchema } from '@canopy/protocol/canopy-core';
import type {
  AgentAuditEntry,
  AgentAuditInterfaceToolCall,
} from '@canopy/protocol/observability';

const call = (index: number): AgentAuditInterfaceToolCall => ({
  callId: `call-${index}`,
  toolName: 'ui.show_files',
  leaseId: 'remote-control:controller-a:main:7:lease',
  surface: 'main',
  interfaceKind: 'desktop',
  audience: 'controller-a',
  outcome: index === 0 ? 'answered' : 'deadline_exceeded',
  deliveredAt: GOLDEN_START_TIME,
  settledAt: GOLDEN_START_TIME,
});

/** Delivery binds a call to the chat's open entry; settlement records it. */
function deliver(
  service: ObservabilityService,
  chatId: string,
  index: number,
): void {
  service.noteInterfaceToolCallDelivered(
    PROJECT,
    WORKTREE,
    chatId,
    call(index).callId,
  );
}
function settle(
  service: ObservabilityService,
  chatId: string,
  index: number,
): void {
  service.recordInterfaceToolCall(PROJECT, WORKTREE, chatId, call(index));
}

function turn(chatId: string, calls: number, late: boolean): GoldenScenario {
  return {
    name: chatId,
    run: (context: GoldenScenarioContext): Promise<void> => {
      const service = context.ingest as unknown as ObservabilityService;
      context.ingest.startChatTurn(
        chatStart(chatId, 'claude', { userMessageId: 'msg-1' }),
      );
      if (!late)
        for (let index = 0; index < calls; index += 1) {
          deliver(service, chatId, index);
          settle(service, chatId, index);
        }
      else deliver(service, chatId, 0);
      context.ingest.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');
      if (late) settle(service, chatId, 0);
      return Promise.resolve();
    },
  };
}

/** The chat's entries as read back from the audit store. */
async function storedEntries(
  scenario: GoldenScenario,
): Promise<AgentAuditEntry[]> {
  const host = createDesktopHost(setCurrentService);
  try {
    await runGoldenScenario(host, scenario);
    return finalAuditEntries(await readFinalAuditLines(host.dataRoot)).filter(
      (candidate) => candidate.chatId === scenario.name,
    );
  } finally {
    await disposeAll(host);
  }
}

/** The turn's entry as read back from the audit store. */
async function storedEntry(
  scenario: GoldenScenario,
): Promise<AgentAuditEntry | undefined> {
  return (await storedEntries(scenario))[0];
}

describe('interface tool call provenance (CAN-5828)', () => {
  beforeEach(() => {
    useGoldenTimers();
  });
  afterEach(() => {
    restoreGoldenEnvironment(setCurrentService);
  });

  it("an interface tool call is recorded on its turn's audit entry and served unchanged", async () => {
    const entry = await storedEntry(turn('chat-provenance', 2, false));
    expect(entry?.interfaceToolCalls).toEqual([call(0), call(1)]);
    // core.observability.audit.* serves the same records.
    expect(
      ObservabilityAuditEntrySchema.parse(entry).interfaceToolCalls,
    ).toEqual([call(0), call(1)]);
  });

  it('it keeps the first 64 calls and nothing after the entry finalized', async () => {
    const capped = await storedEntry(turn('chat-capped', 70, false));
    expect(capped?.interfaceToolCalls).toHaveLength(64);
    const late = await storedEntry(turn('chat-late', 0, true));
    expect(late?.interfaceToolCalls).toBeUndefined();
  });

  it('a call that settles after its turn ended never lands on the next turn', async () => {
    const chatId = 'chat-next-turn';
    const entries = await storedEntries({
      name: chatId,
      run: (context: GoldenScenarioContext): Promise<void> => {
        const service = context.ingest as unknown as ObservabilityService;
        context.ingest.startChatTurn(
          chatStart(chatId, 'claude', { userMessageId: 'msg-1' }),
        );
        deliver(service, chatId, 0);
        context.ingest.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');
        // The next turn starts in the same millisecond; the call delivered
        // during the first turn settles during it.
        context.ingest.startChatTurn(
          chatStart(chatId, 'claude', { userMessageId: 'msg-2' }),
        );
        settle(service, chatId, 0);
        // A call the second turn delivered is still its own.
        deliver(service, chatId, 1);
        settle(service, chatId, 1);
        context.ingest.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');
        return Promise.resolve();
      },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.startedAt).toBe(entries[1]?.startedAt);
    expect(entries.map((entry) => entry.interfaceToolCalls)).toEqual([
      undefined,
      [call(1)],
    ]);
  });

  it('a settled call that was never bound to a turn is dropped', async () => {
    const chatId = 'chat-unbound';
    const entry = await storedEntry({
      name: chatId,
      run: (context: GoldenScenarioContext): Promise<void> => {
        const service = context.ingest as unknown as ObservabilityService;
        context.ingest.startChatTurn(
          chatStart(chatId, 'claude', { userMessageId: 'msg-1' }),
        );
        settle(service, chatId, 0);
        context.ingest.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');
        return Promise.resolve();
      },
    });
    expect(entry?.interfaceToolCalls).toBeUndefined();
  });
});

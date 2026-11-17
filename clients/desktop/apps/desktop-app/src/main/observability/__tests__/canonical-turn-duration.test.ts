// CAN-5096: a chat turn's audit duration comes from the canonical turn
// reducer, net of its approval and question pauses; the audit's own pause
// tally is only the fallback. Drives the real service on the CAN-5065
// golden host; observability:load-history, observability:load-transcript and
// observability:load-usage-metrics serve the stored durations.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@canopy/core-runtime/observability';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import type { ChatTurnStateChange } from '../../services/chat-turn-state-handoff';
import type { OpenAiPricingCacheState } from '../../openai-pricing/pricing-client';
import type { ObservabilityService } from '../service';
import { installTurnStateAudit } from '../turn-state-audit';
import {
  GOLDEN_PRICING_STATE,
  createDesktopHost,
  disposeAll,
  finalAuditEntries,
  goldenAccount,
  restoreGoldenEnvironment,
  useGoldenTimers,
} from './golden/desktop-host';
import { PROJECT, WORKTREE, chatStart, claudeResult } from './golden/fixtures';
import {
  GOLDEN_START_TIME,
  captureStores,
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

const SECOND = 1_000;

/** Sets the clock to `offsetMs` after the golden start and returns it. */
function at(context: GoldenScenarioContext, offsetMs: number): string {
  const iso = new Date(Date.parse(GOLDEN_START_TIME) + offsetMs).toISOString();
  context.host.setClock(iso);
  return iso;
}

function service(context: GoldenScenarioContext): ObservabilityService {
  return context.ingest as unknown as ObservabilityService;
}

interface TurnOptions {
  chatId: string;
  assistantMode?: 'app-advisor' | 'pipeline-editor';
  canonical?: {
    userMessageId: string;
    durationMs?: number;
    pausedMs?: number;
  };
  providerDurationMs?: number;
  recordAfterCompletion?: boolean;
}

/** A turn paused from 10 s to 40 s (audit tally 30 s), completed at 60 s. */
function pausedTurn(options: TurnOptions): GoldenScenario {
  return {
    name: options.chatId,
    run: (context): Promise<void> => {
      const { chatId } = options;
      const record = (): void => {
        if (!options.canonical) return;
        service(context).recordCanonicalTurnDuration(
          PROJECT,
          WORKTREE,
          chatId,
          {
            turnId: 'turn-1',
            userMessageId: options.canonical.userMessageId,
            durationMs: options.canonical.durationMs ?? 42_000,
            pausedMs: options.canonical.pausedMs ?? 18_000,
          },
        );
      };
      at(context, 0);
      context.ingest.startChatTurn(
        chatStart(chatId, 'claude', {
          userMessageId: 'msg-1',
          ...(options.assistantMode
            ? { assistantMode: options.assistantMode }
            : {}),
        }),
      );
      at(context, 10 * SECOND);
      context.ingest.pauseChatTurn(PROJECT, WORKTREE, chatId);
      at(context, 40 * SECOND);
      context.ingest.resumeChatTurn(PROJECT, WORKTREE, chatId);
      at(context, 60 * SECOND);
      if (options.providerDurationMs !== undefined)
        context.ingest.observeChatEvent(
          PROJECT,
          WORKTREE,
          chatId,
          claudeResult({
            sessionId: `session-${chatId}`,
            input: 10,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            runningCostUsd: 0.001,
            durationMs: options.providerDurationMs,
          }),
        );
      if (!options.recordAfterCompletion) record();
      context.ingest.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');
      if (options.recordAfterCompletion) record();
      return Promise.resolve();
    },
  };
}

/** Every stored audit line, in file order. */
function auditLines(dataRoot: string): Array<Record<string, unknown>> {
  const dir = join(dataRoot, 'agent-observability', 'audit');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .flatMap((name) =>
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .flatMap((line): Array<Record<string, unknown>> => {
          const parsed: unknown = JSON.parse(line);
          return isRecord(parsed) ? [parsed] : [];
        }),
    );
}

async function storedDuration(scenario: GoldenScenario): Promise<{
  durationMs: number | undefined;
  stores: string;
  terminalDurations: unknown[];
}> {
  const host = createDesktopHost(setCurrentService);
  try {
    await runGoldenScenario(host, scenario);
    const entries = finalAuditEntries(await readFinalAuditLines(host.dataRoot));
    const entry = entries.find(
      (candidate) => candidate.chatId === scenario.name,
    );
    return {
      durationMs: entry?.durationMs,
      stores: await captureStores(host.dataRoot),
      terminalDurations: auditLines(host.dataRoot)
        .filter(
          (line) => line.chatId === scenario.name && line.status !== 'running',
        )
        .map((line) => line.durationMs),
    };
  } finally {
    await disposeAll(host);
  }
}

describe('canonical chat turn duration', () => {
  beforeEach(() => {
    useGoldenTimers();
  });
  afterEach(() => {
    restoreGoldenEnvironment(setCurrentService);
  });

  it("a chat entry with a canonical ended turn stores the reducer's duration", async () => {
    const { durationMs } = await storedDuration(
      pausedTurn({
        chatId: 'chat-canonical',
        canonical: { userMessageId: 'msg-1' },
      }),
    );
    expect(durationMs).toBe(42_000);
  });

  it('the canonical duration wins over a disagreeing audit pause tally', async () => {
    const { durationMs } = await storedDuration(
      pausedTurn({
        chatId: 'chat-provider',
        canonical: { userMessageId: 'msg-1' },
        providerDurationMs: 55_000,
      }),
    );
    expect(durationMs).toBe(42_000);
  });

  it("an entry with no canonical record keeps today's computation", async () => {
    const { durationMs } = await storedDuration(
      pausedTurn({ chatId: 'chat-fallback' }),
    );
    expect(durationMs).toBe(30_000);
  });

  it('a canonical record for another turn is ignored', async () => {
    const { durationMs } = await storedDuration(
      pausedTurn({
        chatId: 'chat-other',
        canonical: { userMessageId: 'msg-other' },
      }),
    );
    expect(durationMs).toBe(30_000);
  });

  it('a canonical record after finalization does not rewrite the entry', async () => {
    // A finalized entry is stored again only when its transcript publishes,
    // so the late record must add no line and change no stored duration.
    const late = await storedDuration(
      pausedTurn({
        chatId: 'chat-late',
        canonical: { userMessageId: 'msg-1' },
        recordAfterCompletion: true,
      }),
    );
    const fallback = await storedDuration(
      pausedTurn({ chatId: 'chat-late-fallback' }),
    );
    expect(late.durationMs).toBe(30_000);
    expect(late.terminalDurations).toEqual(fallback.terminalDurations);
    expect(late.terminalDurations.every((ms) => ms === 30_000)).toBe(true);
  });

  it('a deferred-tool continuation adds its canonical turn to the open entry', async () => {
    // A tools reload keeps the audit entry open while the canonical reducer
    // ends the original execution and starts the continuation as a second
    // turn bound to the same user message. A repeated record of a turn is
    // counted once.
    const { durationMs, stores } = await storedDuration({
      name: 'chat-reload',
      run: (context): Promise<void> => {
        const record = (turnId: string, durationMs: number): void => {
          service(context).recordCanonicalTurnDuration(
            PROJECT,
            WORKTREE,
            'chat-reload',
            { turnId, userMessageId: 'msg-1', durationMs, pausedMs: 0 },
          );
        };
        at(context, 0);
        context.ingest.startChatTurn(
          chatStart('chat-reload', 'claude', { userMessageId: 'msg-1' }),
        );
        at(context, 30 * SECOND);
        record('turn-1', 30_000);
        at(context, 45 * SECOND);
        record('turn-2', 10_000);
        record('turn-2', 10_000);
        context.ingest.completeChatTurn(
          PROJECT,
          WORKTREE,
          'chat-reload',
          'success',
        );
        return Promise.resolve();
      },
    });
    expect(durationMs).toBe(40_000);
    expect(stores).toContain('"turnDurationMs": 40000');
  });

  it("App Advisor and pipeline editor entries take the reducer's duration (CAN-5827)", async () => {
    for (const assistantMode of ['app-advisor', 'pipeline-editor'] as const) {
      const { durationMs } = await storedDuration(
        pausedTurn({
          chatId: `chat-${assistantMode}`,
          assistantMode,
          canonical: { userMessageId: 'msg-1' },
        }),
      );
      // The reducer's 42 s, not the audit's own 60 s minus its 30 s tally.
      expect(durationMs).toBe(42_000);
    }
  });

  it('an implausible canonical duration reports the canonical paused time', async () => {
    const { stores } = await storedDuration(
      pausedTurn({
        chatId: 'chat-implausible',
        canonical: {
          userMessageId: 'msg-1',
          durationMs: 8 * 24 * 60 * 60_000,
          pausedMs: 5_000,
        },
      }),
    );
    expect(stores).toContain('"kind": "implausible_turn_duration"');
    expect(stores).toContain('"implausibleDurationPausedMs": 5000');
  });
});

it('the turn-state hook reports each ended turn once with its union of pauses', () => {
  const observability = {
    enableTurnStateAudit: jest.fn(),
    observeTurnState: jest.fn(),
    recordCanonicalTurnDuration: jest.fn(),
  };
  let listener: ((change: ChatTurnStateChange) => void) | undefined;
  installTurnStateAudit(observability as unknown as ObservabilityService, {
    onTurnStateChange: (next): (() => void) => {
      listener = next;
      return (): void => undefined;
    },
  });
  const lastEnded = {
    id: 't1',
    origin: 'user',
    userMessageId: 'm1',
    startedAtMs: 0,
    endedAtMs: 100_000,
    outcome: 'completed',
    durationMs: 70_000,
    pauses: [
      {
        ownerKind: 'approval',
        ownerId: 'a',
        startedAtMs: 10_000,
        endedAtMs: 30_000,
      },
      {
        ownerKind: 'question',
        ownerId: 'q',
        startedAtMs: 20_000,
        endedAtMs: 40_000,
      },
    ],
  };
  const change = (turnId: string): ChatTurnStateChange =>
    ({
      scope: { projectId: 'p', worktreeId: 'w', chatId: 'c' },
      state: { lastEnded },
      effects: [
        {
          type: 'timer.close',
          timerId: `${turnId}:timer`,
          turnId,
          atMs: 100_000,
          durationMs: 70_000,
        },
        { type: 'turn.ended', turnId, outcome: 'completed' },
      ],
      generation: 1,
      cause: 'lifecycle',
    }) as unknown as ChatTurnStateChange;

  listener?.(change('t1'));
  expect(observability.recordCanonicalTurnDuration.mock.calls).toEqual([
    [
      'p',
      'w',
      'c',
      {
        turnId: 't1',
        userMessageId: 'm1',
        durationMs: 70_000,
        pausedMs: 30_000,
      },
    ],
  ]);

  listener?.(change('t2'));
  expect(observability.recordCanonicalTurnDuration).toHaveBeenCalledTimes(1);
});

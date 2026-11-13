// CAN-4070 rule, for CAN-5065: observability outputs captured on unchanged
// code before the ingest is extracted (CAN-4136). The real
// `ObservabilityService` writes into a temporary data root; only provider
// accounts, prices, feature flags and the service locator are host inputs
// here, and the harness in `golden/` fixes them for every host. Any change
// to a stored line or an aggregated read fails the snapshot. These audit
// outputs also feed the legacy observability:event push to both windows;
// this golden covers their data, not Electron window delivery.
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { OpenCodeAccountSnapshot } from '@canopy/protocol/portal';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type {
  CostScopeRef,
  CostScopeView,
  CostViewResult,
} from '@canopy/protocol/cost-view';
import type {
  AgentAuditEntry,
  AgentProviderType,
} from '@canopy/desktop-shared/types';
import type { OpenAiPricingCacheState } from '../../openai-pricing/pricing-client';
import {
  captureAggregates,
  captureStores,
  diffGolden,
  readFinalAuditLines,
  renderGolden,
  runGoldenScenario,
  type GoldenAggregates,
  type GoldenRun,
  type GoldenScenario,
} from './golden/harness';
import {
  GOLDEN_PRICING_STATE,
  createDesktopHost,
  disposeAll,
  finalAuditEntries,
  goldenAccount,
  restoreGoldenEnvironment,
  useGoldenTimers,
  type DesktopHost,
} from './golden/desktop-host';
import { CHUNKING_SCENARIO, GOLDEN_SCENARIOS } from './golden/scenarios';

const mockPricing = GOLDEN_PRICING_STATE;
const mockAccount = goldenAccount;
let mockOpenCodeAccounts: OpenCodeAccountSnapshot | undefined;
const mockRefreshOpenCodeAccounts = jest.fn<Promise<void>, []>();

jest.mock('../../opencode/connection', () => ({
  refreshOpenCodeAccounts: (): Promise<void> => mockRefreshOpenCodeAccounts(),
}));
jest.mock('../../opencode/account-information', () => ({
  peekOpenCodeAccounts: (): OpenCodeAccountSnapshot | undefined =>
    mockOpenCodeAccounts,
  onOpenCodeAccountsChanged: (): (() => void) => (): void => undefined,
}));

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

import { CostIndexStore } from '../../cost-index/store';
import { classifyAuditEntry } from '../../cost-index/classifier';
import type {
  CostIndexHost,
  CostScopeLocation,
  CostTurnRecord,
} from '../../cost-index/types';

jest.setTimeout(300_000);

function auditScopes(
  entries: readonly AgentAuditEntry[],
): Map<string, { scope: CostScopeRef; chats: Set<string>; runs: Set<string> }> {
  const scopes = new Map<
    string,
    { scope: CostScopeRef; chats: Set<string>; runs: Set<string> }
  >();
  for (const entry of entries) {
    if (!entry.projectId || !entry.worktreeId) continue;
    const key = `${entry.projectId}/${entry.worktreeId}`;
    const scope = scopes.get(key) ?? {
      scope: {
        kind: 'entry',
        projectId: entry.projectId,
        worktreeId: entry.worktreeId,
      },
      chats: new Set<string>(),
      runs: new Set<string>(),
    };
    if (entry.chatId) scope.chats.add(entry.chatId);
    const run = entry.rootPipelineExecutionId ?? entry.pipelineExecutionId;
    if (run) scope.runs.add(run);
    if (entry.pipelineExecutionId) scope.runs.add(entry.pipelineExecutionId);
    scopes.set(key, scope);
  }
  return scopes;
}

/**
 * Runs zero-delay timers until `work` settles, without moving the clock: the
 * cost store defers its repair passes to `setTimeout(0)`.
 */
async function withZeroDelayTimers<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const markSettled = (): void => {
    settled = true;
  };
  void work.then(markSettled, markSettled);
  while (!settled) {
    // Async ticks defer promise-scheduled timeout(0) to now + 1 ms.
    jest.advanceTimersByTime(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return work;
}

/** Every cost-index view over the stored audit, built by the real store. */
function captureCostIndex(
  run: GoldenRun,
  dataRoot: string,
): Promise<{
  views: Record<string, unknown>;
  scopeViews: Map<string, CostViewResult<CostScopeView>>;
}> {
  return withZeroDelayTimers(buildCostIndexViews(run, dataRoot));
}

async function buildCostIndexViews(
  run: GoldenRun,
  dataRoot: string,
): Promise<{
  views: Record<string, unknown>;
  scopeViews: Map<string, CostViewResult<CostScopeView>>;
}> {
  const entries = finalAuditEntries(await readFinalAuditLines(dataRoot));
  const scopes = auditScopes(entries);
  const locations = new Map<string, CostScopeLocation>();
  for (const [key, { scope }] of Array.from(scopes.entries())) {
    locations.set(key, {
      scope,
      directory: join(dataRoot, 'golden-cost-index', key),
      incarnation: '2026-10-01T00:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  }
  const keyOf = (scope: CostScopeRef): string =>
    scope.kind === 'entry' ? `${scope.projectId}/${scope.worktreeId}` : '';
  const host: CostIndexHost = {
    auditDirectory: () => join(dataRoot, 'agent-observability', 'audit'),
    checkpointPath: () =>
      join(dataRoot, 'golden-cost-index', 'checkpoint.json'),
    resolveScope: (scope) =>
      Promise.resolve(locations.get(keyOf(scope)) ?? null),
    listRetainedScopes: () => Promise.resolve([]),
    withRetainedLock: (_scope, action) => action(),
    readChats: (scope) =>
      Promise.resolve(
        Array.from(scopes.get(keyOf(scope))?.chats ?? []).map((chatId) => ({
          chatId,
          label: `Chat ${chatId}`,
          state: 'open' as const,
        })),
      ),
    readPipelineRun: () => Promise.resolve(null),
    readProxyAccountLabels: () => Promise.resolve(new Map()),
    retentionDays: () => 7,
    flush: () => run.context.ingest.flush(),
    now: () => new Date(),
    yield: () => Promise.resolve(),
  };
  const store = new CostIndexStore(host);
  await store.refreshInternal('idle');
  await store.waitForIdle();
  const views: Record<string, unknown> = {};
  const scopeViews = new Map<string, CostViewResult<CostScopeView>>();
  for (const [key, { scope, chats, runs }] of Array.from(scopes.entries())) {
    const scopeView = await store.getScope({ scope });
    scopeViews.set(key, scopeView);
    views[`${key}/scope`] = scopeView;
    for (const chatId of Array.from(chats).sort()) {
      views[`${key}/chat/${chatId}`] = await store.getChat({ scope, chatId });
    }
    for (const executionId of Array.from(runs).sort()) {
      views[`${key}/run/${executionId}`] = await store.getPipelineRun({
        scope,
        executionId,
      });
    }
  }
  await store.waitForIdle();
  return { views, scopeViews };
}

interface CapturedScenario {
  host: DesktopHost;
  stores: string;
  aggregates: GoldenAggregates;
  restartedAggregates: GoldenAggregates;
  costIndex: Awaited<ReturnType<typeof captureCostIndex>>;
  auditEntries: AgentAuditEntry[];
}

async function captureScenario(
  scenario: GoldenScenario,
): Promise<CapturedScenario> {
  const host = createDesktopHost(setCurrentService);
  try {
    const run = await runGoldenScenario(host, scenario);
    const aggregates = await captureAggregates(run.context.ingest);
    const stores = await captureStores(host.dataRoot);
    const auditEntries = finalAuditEntries(
      await readFinalAuditLines(host.dataRoot),
    );
    // A fresh process reads only what the earlier ones stored.
    const restarted = await host.boot();
    await restarted.start();
    const restartedAggregates = await captureAggregates(restarted);
    const costIndex = await captureCostIndex(run, host.dataRoot);
    return {
      host,
      stores,
      aggregates,
      restartedAggregates,
      costIndex,
      auditEntries,
    };
  } catch (error) {
    await disposeAll(host);
    throw error;
  }
}

it('observability:refresh-usage projects OpenCode quota outcomes without persisting account facts', async () => {
  useGoldenTimers();
  const host = createDesktopHost(setCurrentService);
  try {
    await host.boot();
    const service = host.incarnations[0]?.service;
    if (!service) throw new Error('Observability service did not boot');
    const ready: OpenCodeAccountSnapshot = {
      status: 'ready',
      updatedAt: '2026-11-07T12:00:00.000Z',
      providers: [
        {
          id: 'opencode-go',
          name: 'OpenCode Go',
          accounts: [
            {
              label: 'Volatile fixture account',
              method: 'key',
              selected: true,
              needsSignIn: false,
              usage: {
                status: 'ready',
                plan: 'OpenCode Go',
                checkedAt: '2026-11-07T12:00:00.000Z',
                windows: [
                  {
                    id: 'rolling',
                    percent: 25,
                    resetsAt: '2026-11-08T00:00:00.000Z',
                  },
                  {
                    id: 'weekly',
                    percent: 5,
                    resetsAt: '2026-11-12T00:00:00.000Z',
                  },
                  {
                    id: 'monthly',
                    percent: 70,
                    resetsAt: '2026-12-01T00:00:00.000Z',
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    mockRefreshOpenCodeAccounts.mockImplementationOnce(() => {
      mockOpenCodeAccounts = ready;
      return Promise.resolve();
    });
    expect(service.loadSnapshot().usage.openCodeAccounts).toBeUndefined();
    expect(mockRefreshOpenCodeAccounts).not.toHaveBeenCalled();
    await service.refreshProviderUsage('opencode');
    expect(mockRefreshOpenCodeAccounts).toHaveBeenCalledTimes(1);
    expect(service.loadSnapshot().usage.openCodeAccounts).toEqual(ready);
    await service.flush();
    const stored = await readFile(
      join(host.dataRoot, 'agent-observability', 'snapshot.json'),
      'utf8',
    );
    expect(stored).not.toContain('openCodeAccounts');
    expect(stored).not.toContain('Volatile fixture account');
    const failed: OpenCodeAccountSnapshot = {
      status: 'unavailable',
      updatedAt: '2026-11-07T12:01:00.000Z',
      providers: [],
    };
    mockRefreshOpenCodeAccounts.mockImplementationOnce(() => {
      mockOpenCodeAccounts = failed;
      return Promise.resolve();
    });
    await service.refreshProviderUsage('opencode');
    expect(service.loadSnapshot().usage.openCodeAccounts).toEqual(failed);
    expect(JSON.stringify(service.loadSnapshot())).not.toContain(
      'Volatile fixture account',
    );
  } finally {
    await disposeAll(host);
    mockOpenCodeAccounts = undefined;
    mockRefreshOpenCodeAccounts.mockReset();
    restoreGoldenEnvironment(setCurrentService);
  }
});

describe.each(GOLDEN_SCENARIOS.map((scenario) => [scenario.name, scenario]))(
  'observability golden: %s',
  (_name, scenario) => {
    let captured: CapturedScenario;

    beforeAll(async () => {
      useGoldenTimers();
      captured = await captureScenario(scenario);
    });

    afterAll(async () => {
      try {
        await disposeAll(captured?.host);
      } finally {
        restoreGoldenEnvironment(setCurrentService);
      }
    });

    it('stores the golden records', () => {
      expect(captured.stores).toMatchSnapshot();
    });

    it('serves the golden aggregates', () => {
      expect(
        renderGolden(captured.aggregates, captured.host.dataRoot),
      ).toMatchSnapshot();
    });

    it('builds the golden cost index', () => {
      expect(
        renderGolden(captured.costIndex.views, captured.host.dataRoot),
      ).toMatchSnapshot();
    });

    // Differential: what a fresh process serves from the stores alone,
    // against what the live process served. Today's divergences are part of
    // the golden; an empty list means the reads agree.
    it('serves the golden differences after a restart', () => {
      expect(
        diffGolden(captured.aggregates, captured.restartedAggregates),
      ).toMatchSnapshot();
    });

    it('totals each cost scope as the sum of its classified records', () => {
      const classified = captured.auditEntries.map((entry) => ({
        entry,
        record: classifyAuditEntry(entry),
      }));
      expect(captured.costIndex.scopeViews.size).toBeGreaterThan(0);
      for (const [key, view] of Array.from(
        captured.costIndex.scopeViews.entries(),
      )) {
        if (view.status !== 'ok') throw new Error(`No view for ${key}`);
        const records = classified
          .filter(
            ({ entry }) => `${entry.projectId}/${entry.worktreeId}` === key,
          )
          .map(({ record }) => record)
          .filter((record) => record !== null);
        const sum = (pick: (record: CostTurnRecord) => number): number =>
          records.reduce((total, record) => total + pick(record), 0);
        expect(view.value.totals.usd).toBeCloseTo(
          sum((record) => record.costUsd ?? 0),
          6,
        );
        expect(view.value.totals.tokens).toEqual({
          input: sum((record) => record.tokens.input),
          output: sum((record) => record.tokens.output),
          cacheReadInputTokens: sum(
            (record) => record.tokens.cacheReadInputTokens,
          ),
          cacheCreationInputTokens: sum(
            (record) => record.tokens.cacheCreationInputTokens,
          ),
          reasoningOutputTokens: sum(
            (record) => record.tokens.reasoningOutputTokens,
          ),
        });
      }
    });
  },
);

describe('observability golden: pipeline output chunking', () => {
  const captures: string[] = [];
  const hosts: DesktopHost[] = [];

  beforeAll(async () => {
    useGoldenTimers();
    for (const chunking of ['whole', 'per-character', 'crlf-split'] as const) {
      const host = createDesktopHost(setCurrentService);
      hosts.push(host);
      await runGoldenScenario(host, CHUNKING_SCENARIO, chunking);
      captures.push(await captureStores(host.dataRoot));
    }
  });

  afterAll(async () => {
    for (const host of hosts) await disposeAll(host);
    restoreGoldenEnvironment(setCurrentService);
  });

  it('stores the same records however pipeline output is chunked', () => {
    expect(captures).toHaveLength(3);
    expect(captures[1]).toBe(captures[0]);
    expect(captures[2]).toBe(captures[0]);
  });
});

// Every boot loads its own module graph, and each scenario's host stays
// referenced until the file ends. A disposed host that kept its incarnations
// held every graph the file loaded, which ran a CI Jest worker out of heap.
describe('observability golden: disposed hosts', () => {
  const RELEASE_ROUNDS = 20;
  const isGc = (value: unknown): value is () => void =>
    typeof value === 'function';

  /**
   * Boots and disposes a host in its own frame, so only the host and the weak
   * references outlive it: one to each incarnation's service and one to a
   * module from its isolated graph.
   */
  async function bootAndDispose(
    boots: number,
  ): Promise<{ host: DesktopHost; booted: WeakRef<object>[] }> {
    useGoldenTimers();
    try {
      const host = createDesktopHost(setCurrentService);
      const booted: WeakRef<object>[] = [];
      try {
        for (let boot = 0; boot < boots; boot += 1) {
          const ingest = await host.boot();
          await ingest.start();
          const incarnation = host.incarnations.at(-1);
          if (!incarnation) throw new Error('Expected a booted incarnation');
          booted.push(
            new WeakRef(incarnation.service),
            new WeakRef(incarnation.attribution),
          );
        }
      } finally {
        await disposeAll(host);
      }
      return { host, booted };
    } finally {
      restoreGoldenEnvironment(setCurrentService);
    }
  }

  it('releases every incarnation the host booted', async () => {
    const { host, booted } = await bootAndDispose(2);
    // Let the job that created the references end so it holds nothing.
    await new Promise<void>((resolve) => setImmediate(resolve));
    setFlagsFromString('--expose-gc');
    const gc: unknown = runInNewContext('gc');
    if (!isGc(gc)) throw new Error('Expected V8 to expose gc');
    const live = (): boolean[] =>
      booted.map((ref) => ref.deref() !== undefined);
    gc();
    for (
      let round = 0;
      round < RELEASE_ROUNDS && live().includes(true);
      round += 1
    ) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      gc();
    }
    expect(live()).toEqual([false, false, false, false]);
    // The host stays referenced to here, as a scenario's capture is.
    expect(host.incarnations).toHaveLength(0);
  });
});

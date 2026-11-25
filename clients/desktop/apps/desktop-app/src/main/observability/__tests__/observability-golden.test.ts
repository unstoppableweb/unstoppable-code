// CAN-4070 rule, for CAN-5065: observability outputs captured on unchanged
// code before the ingest is extracted (CAN-4136). The real
// `ObservabilityService` writes into a temporary data root; only provider
// accounts, prices, feature flags and the service locator are host inputs
// here, and the harness in `golden/` fixes them for every host. Any change
// to a stored line or an aggregated read fails the snapshot. These audit
// outputs also feed the legacy observability:event push to both windows;
// this golden covers their data, not Electron window delivery.
import { join } from 'node:path';
import { isRecord } from '@canopy/core-runtime/observability';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  nodeCrashDumpSweepFs,
  sweepCrashDumps,
  sweepStartupCrashDumps,
} from '../crash-dump-sweep';
import type {
  AntigravityAccountSnapshot,
  OpenCodeAccountSnapshot,
} from '@canopy/protocol/remote-control/shell';
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
  GOLDEN_CODEX_MODEL,
  GOLDEN_START_TIME,
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
import {
  CLAUDE_MODEL,
  PROJECT,
  WORKTREE,
  chatStart,
  claudeResult,
  jsonl,
  codexChatEvent,
  codexTurnEvents,
  delegationEvent,
  agentStep,
  job,
  pipelineState,
  helperEntry,
} from './golden/fixtures';
import {
  ObservabilityAuditEntrySchema,
  PipelineRunCostViewSchema,
} from '@canopy/protocol/canopy-core';
import { stepBillingRoute } from '@canopy/execution-engine/pipelines/step-billing-route';
import type { StepResult } from '@canopy/execution-engine/node/pipelines/executor/types';

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
let mockAntigravityEnabled = false;
let mockAntigravityAccount: AntigravityAccountSnapshot | undefined;
const mockRefreshAntigravityAccount = jest.fn<Promise<void>, []>();
jest.mock('../../antigravity/feature-flag', () => ({
  isAntigravityHarnessEnabled: (): boolean => mockAntigravityEnabled,
}));
jest.mock('../../antigravity/account', () => ({
  peekAntigravityAccount: (): AntigravityAccountSnapshot | undefined =>
    mockAntigravityAccount,
  onAntigravityAccountChanged: (): (() => void) => (): void => undefined,
}));
jest.mock('../../antigravity/models', () => ({
  refreshAntigravityAccount: (): Promise<void> =>
    mockRefreshAntigravityAccount(),
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

// The Antigravity plan label lives only in memory and is written by a native
// model discovery, so after a restart nothing re-reads it until a Usage
// surface asks: the explicit refresh must run that read.
it('observability:refresh-usage reads the Antigravity account a restart left empty', async () => {
  useGoldenTimers();
  mockAntigravityEnabled = true;
  const host = createDesktopHost(setCurrentService);
  try {
    await host.boot();
    const service = host.incarnations[0]?.service;
    if (!service) throw new Error('Observability service did not boot');
    const ready: AntigravityAccountSnapshot = {
      status: 'ready',
      updatedAt: '2026-11-07T12:00:00.000Z',
      planLabel: 'Google AI Pro',
    };
    mockRefreshAntigravityAccount.mockImplementationOnce(() => {
      mockAntigravityAccount = ready;
      return Promise.resolve();
    });
    expect(service.loadSnapshot().usage.antigravityAccount).toBeUndefined();
    await service.refreshProviderUsage('antigravity');
    expect(mockRefreshAntigravityAccount).toHaveBeenCalledTimes(1);
    expect(service.loadSnapshot().usage.antigravityAccount).toEqual(ready);
    await service.flush();
    const stored = await readFile(
      join(host.dataRoot, 'agent-observability', 'snapshot.json'),
      'utf8',
    );
    expect(stored).not.toContain('antigravityAccount');

    // Off the rollout the read never reaches Google.
    mockAntigravityEnabled = false;
    mockRefreshAntigravityAccount.mockClear();
    await service.refreshProviderUsage('antigravity');
    expect(mockRefreshAntigravityAccount).not.toHaveBeenCalled();
    expect(service.loadSnapshot().usage.antigravityAccount).toBeUndefined();
  } finally {
    await disposeAll(host);
    mockAntigravityEnabled = false;
    mockAntigravityAccount = undefined;
    mockRefreshAntigravityAccount.mockReset();
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

it('keeps a moved Crashpad dump eligible for the next sweep', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canopy-crash-move-'));
  try {
    const pending = join(root, 'pending');
    const completed = join(root, 'completed');
    await mkdir(pending);
    await mkdir(completed);
    const listed = join(pending, 'report.dmp');
    const moved = join(completed, 'report.dmp');
    await writeFile(listed, 'fixture');
    const { mtimeMs } = await stat(listed);
    const first = await sweepCrashDumps({
      crashDumpsDir: root,
      fs: {
        ...nodeCrashDumpSweepFs,
        lstat: async (path) => {
          if (path === listed) await rename(path, moved);
          return nodeCrashDumpSweepFs.lstat(path);
        },
      },
    });
    expect(first).toMatchObject({ listed: 1, errors: 0, complete: false });
    const kept = jest.fn();
    const next = await sweepCrashDumps({ crashDumpsDir: root, onKept: kept });
    expect(next).toMatchObject({ listed: 1, errors: 0, complete: true });
    expect(kept).toHaveBeenCalledWith(moved, mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps a Crashpad dump eligible when it completes after enumeration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canopy-crash-finalizing-'));
  try {
    const staging = join(root, 'new');
    const completed = join(root, 'completed');
    await mkdir(staging);
    await mkdir(completed);
    const pending = join(staging, 'finishing.dmp');
    const moved = join(completed, 'finishing.dmp');
    await writeFile(pending, 'pending fixture');
    await writeFile(join(completed, 'visible.dmp'), 'retained fixture');
    const { mtimeMs } = await stat(pending);
    const first = await sweepCrashDumps({
      crashDumpsDir: root,
      fs: {
        ...nodeCrashDumpSweepFs,
        readdir: async (path, options) => {
          const entries = await nodeCrashDumpSweepFs.readdir(path, options);
          if (path === completed) await rename(pending, moved);
          return entries;
        },
      },
    });
    expect(first).toMatchObject({ listed: 1, kept: 1, complete: false });
    const kept = jest.fn();
    const next = await sweepCrashDumps({ crashDumpsDir: root, onKept: kept });
    expect(next).toMatchObject({ listed: 2, complete: true });
    expect(kept).toHaveBeenCalledWith(moved, mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('enforces local Crashpad retention across launches with reporting blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canopy-crash-retention-'));
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  let acknowledged: ReadonlySet<string> = new Set();
  const receipts = {
    read: jest.fn(
      (): Promise<ReadonlySet<string>> => Promise.resolve(acknowledged),
    ),
    save: jest.fn((ids: ReadonlySet<string>): void => {
      acknowledged = ids;
    }),
  };
  const report = jest
    .fn<Promise<boolean>, [readonly string[], (name: string) => void]>()
    .mockResolvedValue(true);
  let policy: 'allow' | 'deny' | 'unavailable' = 'deny';
  const launch = (): Promise<unknown> =>
    sweepStartupCrashDumps({
      crashDumpsDir: root,
      policy: () => policy,
      receipts,
      report,
    });
  const addDump = async (name: string, age: number): Promise<void> => {
    const path = join(root, name);
    await writeFile(path, 'local crash fixture');
    const time = new Date(now - age);
    await utimes(path, time, time);
  };

  try {
    await addDump('expired.dmp', 31 * day);
    await addDump('kept.dmp', 29 * day);
    await launch();
    expect(await readdir(root)).toEqual(['kept.dmp']);

    const newest = Array.from(
      { length: 20 },
      (_, index) => `recent-${String(index).padStart(2, '0')}.dmp`,
    );
    await Promise.all(
      newest.map((name, index) => addDump(name, day + index * 1_000)),
    );
    policy = 'unavailable';
    await launch();
    expect((await readdir(root)).sort()).toEqual(newest);

    await addDump('oldest-recent.dmp', 3 * day);
    policy = 'allow';
    receipts.read.mockRejectedValueOnce(new Error('Unreadable receipts'));
    await launch();
    expect((await readdir(root)).sort()).toEqual(newest);
    expect(report).not.toHaveBeenCalled();
    expect(receipts.save).not.toHaveBeenCalled();

    report.mockImplementationOnce((_paths, delivered): Promise<boolean> => {
      delivered('recent-00.dmp');
      return Promise.resolve(true);
    });
    await launch();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      newest.map((name) => join(root, name)),
      expect.any(Function),
    );
    expect(receipts.save).toHaveBeenCalledWith(new Set(['recent-00.dmp']));
    await launch();
    expect(report).toHaveBeenLastCalledWith(
      newest.slice(1).map((name) => join(root, name)),
      expect.any(Function),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe('observability Agent and model identity', () => {
  const agentId = 'agent_model_reviewer';
  const model = GOLDEN_CODEX_MODEL;
  const route = `${agentId}@${model}`;

  beforeEach(() => useGoldenTimers());
  afterEach(() => restoreGoldenEnvironment(setCurrentService));

  it.each([
    { selected: route, runtime: route },
    { selected: route, runtime: model },
    { selected: agentId, runtime: model },
  ])(
    'stores and serves $selected on $runtime separately, with real-model usage and cost rollups after restart',
    async ({ selected, runtime }) => {
      const captured = await captureScenario({
        name: 'Agent on an overridden model',
        run: async (context) => {
          context.ingest.startChatTurn(
            chatStart('agent-chat', 'codex', {
              model: runtime,
              requestedModel: selected,
            }),
          );
          for (const event of codexTurnEvents({
            threadId: 'agent-thread',
            turnId: 'agent-turn',
            input: 100,
            cachedInput: 20,
            output: 10,
            reasoning: 2,
          })) {
            context.ingest.observeChatEvent(
              PROJECT,
              WORKTREE,
              'agent-chat',
              codexChatEvent(event),
            );
          }
          context.host.advanceClock(1_000);
          context.ingest.completeChatTurn(
            PROJECT,
            WORKTREE,
            'agent-chat',
            'success',
          );
          await context.settle();
          context.host.advanceClock(1);
        },
      });
      try {
        expect(captured.auditEntries).toHaveLength(1);
        const entry = captured.auditEntries[0];
        expect(entry).toMatchObject({
          agentId,
          model,
          requestedModel: selected,
        });
        expect(ObservabilityAuditEntrySchema.parse(entry)).toMatchObject({
          agentId,
          model,
        });
        expect(entry && classifyAuditEntry(entry)).toMatchObject({
          agentId,
          model,
        });
        expect(captured.stores).toContain(`"agentId": "${agentId}"`);
        const usageLines = await readFile(
          join(
            captured.host.dataRoot,
            'agent-observability',
            'usage-events',
            '2026-10-20.jsonl',
          ),
          'utf8',
        );
        expect(
          usageLines
            .trim()
            .split('\n')
            .map((line): unknown => JSON.parse(line)),
        ).toEqual([
          expect.objectContaining({
            type: 'chat_turn_started',
            agentId,
            model,
          }),
          expect.objectContaining({
            type: 'chat_turn_completed',
            agentId,
            model,
          }),
        ]);
        const restarted = captured.host.incarnations.at(-1)?.service;
        if (!restarted) throw new Error('Expected a restarted service');
        expect((await restarted.loadHistory({})).entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ agentId, model })]),
        );
        for (const search of [agentId, selected.toUpperCase(), model]) {
          expect((await restarted.loadHistory({ search })).entries).toEqual([
            expect.objectContaining({ agentId, model }),
          ]);
        }
        expect(
          (await restarted.loadHistory({ search: 'agent_model_unrelated' }))
            .entries,
        ).toEqual([]);
        const view = await restarted.loadUsageMetricsView({
          tab: 'cost',
          metric: 'cost_total_usd',
          groupBy: 'model',
          window: { kind: 'allTime' },
        });
        expect(view.rows).toHaveLength(1);
        expect(view.rows[0]?.key).toBe(model);
        expect(captured.costIndex.scopeViews.size).toBeGreaterThan(0);
        for (const result of captured.costIndex.scopeViews.values()) {
          if (result.status !== 'ok') throw new Error('Expected a cost view');
          expect(result.value.chats.flatMap((chat) => chat.models)).toEqual([
            model,
          ]);
        }
      } finally {
        await disposeAll(captured.host);
      }
    },
  );

  it.each([route, agentId])(
    'finds historical Agent selection %s loaded from disk',
    async (legacyModel) => {
      const host = createDesktopHost(setCurrentService);
      try {
        host.setClock(GOLDEN_START_TIME);
        const auditDir = join(host.dataRoot, 'agent-observability', 'audit');
        await mkdir(auditDir, { recursive: true });
        const legacyEntry: AgentAuditEntry = {
          ...helperEntry({
            taskKey: 'legacy-agent-turn',
            eventType: 'worktree_chat',
            provider: 'codex',
            model: legacyModel,
            label: 'Historical turn',
            startedAt: GOLDEN_START_TIME,
          }),
          status: 'success',
          completedAt: GOLDEN_START_TIME,
        };
        await writeFile(
          join(auditDir, '2026-10-20.jsonl'),
          `${JSON.stringify(legacyEntry)}\n`,
        );
        const restarted = await host.boot();
        await restarted.start();
        for (const search of [
          agentId.toUpperCase(),
          legacyModel.toUpperCase(),
        ]) {
          expect((await restarted.loadHistory({ search })).entries).toEqual([
            expect.objectContaining({
              id: legacyEntry.id,
              agentId,
              model: legacyModel === route ? model : undefined,
            }),
          ]);
        }
        if (legacyModel === route) {
          expect(
            (await restarted.loadHistory({ search: model })).entries,
          ).toEqual([
            expect.objectContaining({ requestedModel: route, model }),
          ]);
        }
      } finally {
        await disposeAll(host);
      }
    },
  );

  it('keeps a delegation Agent when its route already names a real runtime model', async () => {
    const captured = await captureScenario({
      name: 'Agent delegation',
      run: async (context) => {
        context.ingest.startChatTurn(chatStart('parent', 'claude'));
        const event = delegationEvent({
          delegationId: 'agent-delegation',
          parentTurnId: 'parent-turn',
          status: 'completed',
          sequence: 1,
          createdAt: Date.parse(GOLDEN_START_TIME),
          itemTimes: [],
          usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 },
        });
        if (
          !isRecord(event.delegation) ||
          !isRecord(event.delegation.snapshot)
        ) {
          throw new Error('Expected a delegation fixture');
        }
        const snapshot = event.delegation.snapshot;
        if (!isRecord(snapshot.routeSnapshot)) {
          throw new Error('Expected a route snapshot');
        }
        snapshot.routeSnapshot = {
          ...snapshot.routeSnapshot,
          selectedModelId: route,
          runtimeModelId: model,
        };
        context.ingest.observeChatEvent(PROJECT, WORKTREE, 'parent', event);
        context.ingest.completeChatTurn(PROJECT, WORKTREE, 'parent', 'success');
        await context.settle();
      },
    });
    try {
      const entry = captured.auditEntries.find(
        (candidate) => candidate.eventType === 'managed_delegation',
      );
      expect(entry).toMatchObject({ agentId, model });
      expect(entry && classifyAuditEntry(entry)).toMatchObject({
        agentId,
        model,
      });
    } finally {
      await disposeAll(captured.host);
    }
  });

  it('projects alias metadata for current, retried and iterated steps without losing fast mode', async () => {
    const host = createDesktopHost(setCurrentService);
    try {
      const ingest = await host.boot();
      await ingest.start();
      const step = {
        ...agentStep({
          provider: 'codex',
          harness: 'codex',
          model: 'review-alias',
          startedAt: GOLDEN_START_TIME,
          status: 'success',
        }),
        agent_runtime_model: model,
        agent_model_config: { agentId, baseModel: model, fastMode: true },
      };
      const state = pipelineState({
        id: 'agent-run',
        status: 'success',
        startedAt: GOLDEN_START_TIME,
        jobs: {
          review: {
            ...job('success', { current: step }),
            retry_count: 1,
            iteration_count: 1,
            iteration_history: [
              { iteration: 0, status: 'success', steps: { iteration: step } },
            ],
            retry_history: [
              {
                attempt: 0,
                status: 'success',
                steps: { retry: step },
                iteration_history: [
                  {
                    iteration: 0,
                    status: 'success',
                    steps: { retryIteration: step },
                  },
                ],
              },
            ],
          },
        },
      });
      state.model_config = { thinkingLevel: 'high', fastMode: false };
      ingest.syncPipelineExecutionState(state);
      await ingest.flush();
      await ingest.flush();
      const entries = (await ingest.loadHistory({})).entries;
      expect(entries).toHaveLength(4);
      for (const entry of entries) {
        expect(entry).toMatchObject({
          agentId,
          model,
          serviceTier: 'priority',
        });
      }
    } finally {
      await disposeAll(host);
    }
  });
});

test('Google pipeline patches and native result persist under Google attribution', async () => {
  useGoldenTimers();
  const host = createDesktopHost(setCurrentService);
  host.setClock(GOLDEN_START_TIME);
  try {
    const ingest = await host.boot();
    await ingest.start();
    const state = pipelineState({
      id: 'google-run',
      status: 'running',
      startedAt: GOLDEN_START_TIME,
      jobs: {
        main: job('running', {
          prompt: agentStep({
            provider: 'antigravity',
            harness: 'antigravity',
            model: 'antigravity:gemini-3.8-flash',
            startedAt: GOLDEN_START_TIME,
          }),
        }),
      },
    });
    ingest.syncPipelineExecutionState(state);
    const events = [
      {
        type: 'system',
        subtype: 'init',
        provider: 'antigravity',
        session_id: 'google-session',
      },
      {
        type: 'canopy_assistant_patch',
        provider: 'antigravity',
        messageId: 'google-message',
        timestamp: Date.parse(GOLDEN_START_TIME),
        role: 'assistant',
        revision: 1,
        patches: [
          {
            op: 'set',
            index: 0,
            block: { type: 'text', text: 'Google answer' },
          },
          {
            op: 'set',
            index: 1,
            block: {
              type: 'tool_use',
              toolUseId: 'tool-1',
              toolName: 'read_file',
              input: 'file.txt',
              display: { toolName: 'Read', input: 'file.txt' },
            },
          },
        ],
      },
      {
        type: 'result',
        provider: 'antigravity',
        is_error: false,
        session_id: 'google-session',
        result: 'Google answer',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          reasoning_tokens: 10,
          cache_read_input_tokens: 3,
        },
      },
    ];
    for (const event of events)
      ingest.observePipelineOutput({
        executionId: state.id,
        jobId: 'main',
        stepId: 'prompt',
        attempt: 0,
        data: JSON.stringify(event) + '\n',
      });
    state.jobs.main.steps.prompt.status = 'success';
    state.jobs.main.status = 'success';
    state.status = 'success';
    ingest.syncPipelineExecutionState(state);
    await ingest.flush();
    const entries = (await ingest.loadHistory({})).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: 'antigravity',
      executionHarness: 'antigravity',
      sdkSessionId: 'google-session',
      messageCount: 1,
      assistantMessageCount: 1,
      toolUseCount: 1,
      tokens: {
        input: 100,
        output: 20,
        reasoningOutputTokens: 10,
        cacheReadInputTokens: 3,
      },
    });
    expect(entries[0].totalCostUsd).toBeUndefined();
    const stores = await captureStores(host.dataRoot);
    expect(JSON.stringify(stores)).toContain('Google answer');
    const reboot = await host.boot();
    await reboot.start();
    expect((await reboot.loadHistory({})).entries[0]).toMatchObject({
      provider: 'antigravity',
      toolUseCount: 1,
      tokens: { input: 100, output: 20 },
    });
  } finally {
    await disposeAll(host);
    restoreGoldenEnvironment(setCurrentService);
  }
});

it('reloads local-memory injection and holdout anchors for newly supported providers', async () => {
  useGoldenTimers();
  const host = createDesktopHost(setCurrentService);
  host.setClock(GOLDEN_START_TIME);
  try {
    await host.boot();
    const writer = host.incarnations[0]?.service;
    if (!writer) throw new Error('Writer did not boot');
    await writer.start();
    for (const provider of ['antigravity', 'copilot'] as const) {
      for (const holdout of [false, true]) {
        const chatId = `${provider}-memory-${holdout}`;
        writer.startChatTurn({
          ...chatStart(chatId, provider),
          injectedPrompts: [
            {
              kind: 'local_memory',
              provider,
              applicationCondition: holdout
                ? 'local_memory_withheld_for_turn'
                : 'local_memory_enabled_for_turn',
              text: holdout ? '' : 'Delivered local recall',
            },
          ],
        });
        writer.observeChatEvent(PROJECT, WORKTREE, chatId, {
          type: 'system',
          subtype: 'init',
          provider,
          session_id: chatId,
        });
        writer.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');
      }
    }
    await writer.flush();
    const entries = (await writer.loadHistory({})).entries;
    expect(entries).toHaveLength(4);
    await host.boot();
    const reader = host.incarnations[1]?.service;
    if (!reader) throw new Error('Reader did not boot');
    await reader.start();
    for (const entry of entries) {
      const response = await reader.loadTranscript(entry);
      expect(response.type).toBe('success');
      if (response.type !== 'success')
        throw new Error('Transcript unavailable');
      const holdout = entry.chatId?.endsWith('-true') === true;
      expect(response.injectedPrompts).toEqual([
        {
          kind: 'local_memory',
          provider: entry.provider,
          applicationCondition: holdout
            ? 'local_memory_withheld_for_turn'
            : 'local_memory_enabled_for_turn',
          text: holdout ? '' : 'Delivered local recall',
        },
      ]);
    }
  } finally {
    await disposeAll(host);
    restoreGoldenEnvironment(setCurrentService);
  }
});

// CAN-7305: a workflow step that pauses on the Claude limit and resumes on AI
// Credits bills each attempt on its own route, and every step's latest record
// bills the way its outputs say it ran.
describe('observability golden: mixed-source run with a resumed step (CAN-7305)', () => {
  const executionId = 'exec-mixed-source';
  const startMs = Date.parse(GOLDEN_START_TIME);
  const isoAt = (offsetMs: number): string =>
    new Date(startMs + offsetMs).toISOString();
  const minute = 60_000;
  const credits = { canopy_ai_credits_routed: 'true' };
  const gateway = {
    canopy_model_gateway_routed: 'true',
    canopy_ai_credits_routed: 'true',
  };
  const routeBasis = {
    ai_credits: 'ai_credits',
    model_gateway: 'org_gateway',
    account_proxy: 'account_proxy',
  } as const;

  beforeEach(() => useGoldenTimers());
  afterEach(() => restoreGoldenEnvironment(setCurrentService));

  function claude(
    options: Omit<Parameters<typeof agentStep>[0], 'provider' | 'model'>,
  ): StepResult {
    return agentStep({ provider: 'claude', model: CLAUDE_MODEL, ...options });
  }

  function runState(
    steps: Record<string, StepResult>,
    done = false,
  ): ReturnType<typeof pipelineState> {
    return pipelineState({
      id: executionId,
      status: done ? 'success' : 'running',
      startedAt: isoAt(0),
      ...(done ? { completedAt: isoAt(20 * minute) } : {}),
      jobs: { build: job(done ? 'success' : 'running', steps) },
    });
  }

  function claudeOutput(
    context: Parameters<GoldenScenario['run']>[0],
    stepId: string,
    sessionId: string,
    costUsd: number,
    recovery?: number,
  ): void {
    context.pipelineOutput({
      executionId,
      jobId: 'build',
      stepId,
      attempt: 0,
      ...(recovery === undefined ? {} : { recovery }),
      data: jsonl([
        claudeResult({
          sessionId,
          input: 1_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          runningCostUsd: costUsd,
        }),
      ]),
    });
  }

  it('records the paused attempt and the resumed attempt on their own routes, and totals the run by basis', async () => {
    const codex = (status?: StepResult['status']): StepResult =>
      agentStep({
        provider: 'codex',
        harness: 'codex',
        model: GOLDEN_CODEX_MODEL,
        startedAt: isoAt(0),
        ...(status ? { status, completedAt: isoAt(2 * minute) } : {}),
      });
    const local = (status?: StepResult['status']): StepResult =>
      agentStep({
        provider: 'ollama',
        model: 'llama3',
        startedAt: isoAt(0),
        ...(status ? { status, completedAt: isoAt(2 * minute) } : {}),
      });
    const finished = (outputs: Record<string, string> = {}): StepResult =>
      claude({
        startedAt: isoAt(0),
        status: 'success',
        completedAt: isoAt(2 * minute),
        outputs,
      });
    const settledSteps = {
      native: finished(),
      gateway: finished(gateway),
      local: local('success'),
      'api-key': codex('success'),
    };
    const captured = await captureScenario({
      name: 'Mixed-source run with a resumed step',
      run: async (context) => {
        context.host.setClock(isoAt(0));
        context.ingest.syncPipelineExecutionState(
          runState({
            native: claude({ startedAt: isoAt(0) }),
            resumed: claude({ startedAt: isoAt(0) }),
            gateway: claude({ startedAt: isoAt(0) }),
            local: local(),
            'api-key': codex(),
          }),
        );
        claudeOutput(context, 'native', 'session-native', 0.05);
        claudeOutput(context, 'resumed', 'session-paused', 0.1);
        claudeOutput(context, 'gateway', 'session-gateway', 0.2);
        claudeOutput(context, 'local', 'session-local', 0.3);
        context.pipelineOutput({
          executionId,
          jobId: 'build',
          stepId: 'api-key',
          attempt: 0,
          data: jsonl(
            codexTurnEvents({
              threadId: 'thread-api-key',
              turnId: 'turn-api-key',
              input: 900,
              cachedInput: 0,
              output: 90,
              reasoning: 0,
            }),
          ),
        });
        context.host.setClock(isoAt(2 * minute));
        // The resumed step pauses on the limit; the rest finish.
        const paused = (recoveryCount?: number): StepResult =>
          claude({
            startedAt: isoAt(0),
            status: 'paused',
            ...(recoveryCount === undefined ? {} : { recoveryCount }),
          });
        context.ingest.syncPipelineExecutionState(
          runState({ ...settledSteps, resumed: paused() }),
        );
        await context.shutdownAndRestart();
        // The resume raises the recovery number while the step is paused.
        context.host.setClock(isoAt(10 * minute));
        context.ingest.syncPipelineExecutionState(
          runState({ ...settledSteps, resumed: paused(1) }),
        );
        context.ingest.syncPipelineExecutionState(
          runState({
            ...settledSteps,
            resumed: claude({
              startedAt: isoAt(10 * minute),
              recoveryCount: 1,
            }),
          }),
        );
        // A resume continues the paused session, whose running total
        // includes the paused attempt's 0.10.
        claudeOutput(context, 'resumed', 'session-paused', 0.35, 1);
        context.host.setClock(isoAt(12 * minute));
        context.ingest.syncPipelineExecutionState(
          runState(
            {
              ...settledSteps,
              resumed: claude({
                startedAt: isoAt(10 * minute),
                recoveryCount: 1,
                status: 'success',
                completedAt: isoAt(12 * minute),
                outputs: credits,
              }),
            },
            true,
          ),
        );
        await context.settle();
      },
    });
    try {
      const view =
        captured.costIndex.views[`${PROJECT}/${WORKTREE}/run/${executionId}`];
      if (!isRecord(view) || view.status !== 'ok' || !isRecord(view.value)) {
        throw new Error('Expected a run cost view');
      }
      const run = PipelineRunCostViewSchema.parse(view.value);
      const steps: readonly {
        stepId: string;
        outputs: Record<string, string>;
        basis: string;
      }[] = [
        { stepId: 'native', outputs: {}, basis: 'subscription' },
        { stepId: 'resumed', outputs: credits, basis: 'ai_credits' },
        { stepId: 'gateway', outputs: gateway, basis: 'org_gateway' },
        { stepId: 'local', outputs: {}, basis: 'local' },
        { stepId: 'api-key', outputs: {}, basis: 'api_key' },
      ];

      // The resumed step: two records, each attempt on its own route.
      const resumed = captured.auditEntries
        .filter((entry) => entry.stepId === 'resumed')
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
      expect(resumed).toEqual([
        expect.objectContaining({
          billingBasis: 'subscription',
          status: 'interrupted',
          totalCostUsd: 0.1,
        }),
        expect.objectContaining({
          recovery: 1,
          billingBasis: 'ai_credits',
          status: 'success',
          totalCostUsd: 0.25,
        }),
      ]);
      expect(resumed[1]?.id).toContain('/resumed/0/r1:');
      expect(resumed[0]?.id).not.toContain('/r1');
      for (const entry of resumed) {
        expect(ObservabilityAuditEntrySchema.parse(entry)).toMatchObject({
          stepId: 'resumed',
        });
      }
      const resumedRow = run.steps.find((step) => step.stepId === 'resumed');
      expect(resumedRow?.attemptCount).toBe(2);
      // Never 100% Subscription once the resumed attempt ran on AI Credits.
      expect(resumedRow?.totals.byBilling.ai_credits).toBeCloseTo(0.25, 6);
      expect(resumedRow?.totals.byBilling.subscription).toBeCloseTo(0.1, 6);
      expect(run.run.agentStepCount).toBe(5);

      // Every step's latest record bills the way its outputs say it ran.
      for (const { stepId, outputs, basis } of steps) {
        const latest = captured.auditEntries
          .filter((entry) => entry.stepId === stepId)
          .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
          .at(0);
        const route = stepBillingRoute(outputs);
        if (route !== undefined) expect(routeBasis[route]).toBe(basis);
        expect([stepId, latest?.billingBasis]).toEqual([stepId, basis]);
      }

      // The gateway step is unpriced and still named; the split sums to the
      // overall unpriced count, and the run total to its per-basis amounts.
      const totals = run.run.totals;
      expect(totals.byBilling.org_gateway).toBe(0);
      expect(totals.notPricedByBilling).toEqual({ org_gateway: 1, local: 1 });
      expect(
        Object.values(totals.notPricedByBilling ?? {}).reduce(
          (sum, count) => sum + count,
          0,
        ),
      ).toBe(totals.notPricedCount);
      expect(totals.usd).toBeCloseTo(
        Object.values(totals.byBilling).reduce((sum, usd) => sum + usd, 0),
        6,
      );
      expect(totals.byBilling.subscription).toBeCloseTo(0.15, 6);
      expect(totals.byBilling.ai_credits).toBeCloseTo(0.25, 6);
      expect(totals.byBilling.api_key).toBeGreaterThan(0);
    } finally {
      await disposeAll(captured.host);
    }
  });
});

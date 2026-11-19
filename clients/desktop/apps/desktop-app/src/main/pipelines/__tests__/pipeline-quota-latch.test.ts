// CAN-7256 golden: a workflow step's native usage-limit pause sets the
// account-wide quota latch, so "Use credits automatically" (on-quota) routes
// the resumed step to AI Credits instead of the still-limited subscription.
// Inventory: docs/planning/2026-07-31-desktop-core-daemon/artifacts/
// behavior-inventory/CAN-7256-workflow-on-quota-routing.yaml.
//
// Covers the latch both resume seams feed: the pipelines:resume and
// pipelines:resume-automation IPC handlers (PIPELINE_CHANNELS.RESUME,
// PIPELINE_CHANNELS.RESUME_AUTOMATION) and the portal.pipeline.resume command
// all resume through resumePipelineExecutionFromMain.
//
// Real quota-state, native-account-change and routing modules, and the real
// resume service; only the preferences store, window sends, and the resume
// service's stored-state read, secret bindings and worker dispatch are faked.
import {
  createInitialState,
  normalizePipeline,
} from '@canopy/execution-engine/node/pipelines/executor';
import type { ExecutionRuntime } from '@canopy/execution-engine/node/pipelines/executor/types';
import type {
  ExecutionEvent,
  ExecutionState,
  PipelineStatusReason,
} from '@canopy/execution-engine/types/pipeline';
import type { ConfirmedProviderAuthEvent } from '../../auth/provider-auth-state';

type Prefs = Record<string, unknown>;
type Updater = (latest: Prefs) => Prefs | null;

let mockPrefs: Prefs = {};
const mockUpdatePreferences = jest.fn((updater: Updater): Promise<Prefs> => {
  const next = updater(mockPrefs);
  if (next) mockPrefs = { ...mockPrefs, ...next };
  return Promise.resolve(mockPrefs);
});
const mockSendToAllWindows = jest.fn();
const mockBroadcastPreferencesChanged = jest.fn();

jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<Prefs> => Promise.resolve(mockPrefs),
  updatePreferencesFile: (updater: Updater): Promise<Prefs> =>
    mockUpdatePreferences(updater),
}));
jest.mock('../../lib/preferences-broadcast', () => ({
  broadcastPreferencesChanged: (): void => {
    mockBroadcastPreferencesChanged();
  },
}));
jest.mock('../../lib/window-send', () => ({
  sendToAllWindows: (...args: unknown[]): void => {
    mockSendToAllWindows(...args);
  },
}));
jest.mock('../../services/foreign-activity-sources', () => ({
  publishForeignPipelineActivity: (): void => undefined,
}));
jest.mock('../pipeline-attention', () => ({
  syncPipelineAttention: (): void => undefined,
}));
jest.mock('../transient-error-retry-scheduler', () => ({
  withPipelineTransientRetryState: (state: unknown): unknown => state,
}));

// Resume-service seams: the stored run it reads, and the worker dispatch it
// hands the control to once routing can resolve for the resumed step.
let mockStoredState: ExecutionState | null = null;
const mockControlThroughWorker = jest.fn(
  (): Promise<{ outcome: 'started'; state: ExecutionState | null }> =>
    Promise.resolve({ outcome: 'started', state: mockStoredState }),
);
jest.mock('../pipeline-worker-host', () => ({
  readStoredPipelineExecution: (): Promise<ExecutionState | null> =>
    Promise.resolve(mockStoredState),
  pipelineExecutorControls: {},
}));
jest.mock('../pipeline-worker-dispatch', () => ({
  controlPipelineThroughLocalWorker: (): Promise<unknown> =>
    mockControlThroughWorker(),
  followExecutionHandle: (): void => undefined,
}));
jest.mock('../../execution-secrets/bindings', () => ({
  buildPipelineSecretBindings: (): Promise<unknown[]> => Promise.resolve([]),
}));

import {
  clearAllProviderQuotaReached,
  canReconcileProviderQuotaReached,
  isProviderQuotaReached,
  markProviderQuotaReached,
} from '../../agents/ai-credits-quota-state';
import {
  nativeAccountChangeTestSeams,
  recordNativeSubscriptionRestored,
  startNativeAccountChangeTracking,
} from '../../agents/native-account-change';
import {
  clearAiCreditsRoutingModeCache,
  resolveAiCreditsRoutingActivation,
  setAiCreditsRoutingModeCache,
} from '../../agents/ai-credits-routing';
import {
  broadcastPipelineExecutionEvent,
  resetPipelineExecutionEventBroadcasterForTests,
} from '../pipeline-execution-event-broadcaster';
import {
  latchNativeQuotaFromPipelineReasons,
  latchNativeQuotaFromResumedReasons,
} from '../pipeline-quota-latch';
import { resumePipelineExecutionFromMain } from '../pipeline-resume-service';

const T0 = Date.parse('2026-11-18T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;

function reason(
  overrides: Partial<PipelineStatusReason> = {},
): PipelineStatusReason {
  return {
    id: 'reason-1',
    kind: 'provider_usage_limit',
    code: 'usage_limit_exceeded',
    provider: 'claude',
    account_scope: 'native',
    detected_at: iso(T0 - 1000),
    resets_at: iso(T0 + HOUR),
    source: { job_id: 'job', step_id: 'step', attempt: 1, iteration: 0 },
    ...overrides,
  };
}

const RUNTIME: ExecutionRuntime = {
  executionsDir: '/nonexistent/pipeline-executions',
  tempRootDir: '/nonexistent/tmp',
  bundledActionsDir: '/nonexistent/actions',
  getProjectActionsDir: (repoPath: string): string => repoPath,
  getProjectPipelinesDir: (repoPath: string): string => repoPath,
  isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
  isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
};

function event(reasons: PipelineStatusReason[]): ExecutionEvent {
  const state = createInitialState(
    normalizePipeline({
      name: 'Paused run',
      on: 'dispatch',
      jobs: { j: { steps: [{ id: 'step', uses: 'builtin/create-worktree' }] } },
    }),
    { cwd: '/nonexistent', pipelineId: 'pipeline', runtime: RUNTIME },
    'exec-1',
  );
  state.status = 'paused';
  state.status_reasons = reasons;
  return {
    executionId: 'exec-1',
    type: 'execution.paused',
    state,
    timestamp: new Date().toISOString(),
  };
}

function routesOnQuota(provider: 'claude' | 'codex'): boolean {
  return resolveAiCreditsRoutingActivation(undefined, provider) !== null;
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
  mockPrefs = { aiCreditsRoutingMode: 'on-quota' };
  mockUpdatePreferences.mockClear();
  mockSendToAllWindows.mockClear();
  mockBroadcastPreferencesChanged.mockClear();
  clearAllProviderQuotaReached();
  nativeAccountChangeTestSeams.reset();
  setAiCreditsRoutingModeCache('on-quota');
});

afterEach(() => {
  resetPipelineExecutionEventBroadcasterForTests();
  clearAiCreditsRoutingModeCache();
  jest.useRealTimers();
});

describe('workflow status reasons set the on-quota latch', () => {
  it.each(['claude', 'codex'] as const)(
    'a native %s usage-limit pause routes the resumed step to AI Credits',
    (provider) => {
      expect(routesOnQuota(provider)).toBe(false);
      broadcastPipelineExecutionEvent(event([reason({ provider })]));
      expect(isProviderQuotaReached(provider)).toBe(true);
      expect(resolveAiCreditsRoutingActivation(undefined, provider)).toEqual(
        {},
      );
    },
  );

  it('Wait mode stays native with the latch set', () => {
    setAiCreditsRoutingModeCache('off');
    broadcastPipelineExecutionEvent(event([reason()]));
    expect(isProviderQuotaReached('claude')).toBe(true);
    expect(routesOnQuota('claude')).toBe(false);
  });

  it.each<[string, Partial<PipelineStatusReason>]>([
    ['an account-proxy limit', { account_proxy_connection_id: 'conn-1' }],
    ['an AI Credits limit', { account_scope: 'ai_credits' }],
    ['a reason stored without account_scope', { account_scope: undefined }],
    ['another reason kind', { kind: 'provider_sign_in' }],
    ['an unknown provider', { provider: 'cursor' }],
    [
      'a bare http_429 with no reset time',
      { code: 'http_429', resets_at: undefined },
    ],
    ['a past reset time', { resets_at: iso(T0 - 1) }],
    ['an unparseable reset time', { resets_at: 'soon' }],
    ['an unparseable detection time', { detected_at: 'yesterday' }],
  ])('ignores %s', (_label, overrides) => {
    const ignored = reason(overrides);
    if ('account_scope' in overrides && overrides.account_scope === undefined) {
      delete ignored.account_scope;
    }
    if ('resets_at' in overrides && overrides.resets_at === undefined) {
      delete ignored.resets_at;
    }
    latchNativeQuotaFromPipelineReasons([ignored], T0);
    expect(isProviderQuotaReached('claude')).toBe(false);
    expect(routesOnQuota('claude')).toBe(false);
  });

  it('an http_429 with a future reset time latches', () => {
    latchNativeQuotaFromPipelineReasons([reason({ code: 'http_429' })], T0);
    expect(routesOnQuota('claude')).toBe(true);
  });

  it('a reason with no reset time latches until cleared', () => {
    const noReset = reason();
    delete noReset.resets_at;
    latchNativeQuotaFromPipelineReasons([noReset], T0);
    jest.setSystemTime(T0 + 24 * HOUR);
    setAiCreditsRoutingModeCache('on-quota');
    expect(routesOnQuota('claude')).toBe(true);
  });

  it('the latch expires at the reason reset time, so a scheduled resume stays native', () => {
    const paused = reason({ resets_at: iso(T0 + HOUR) });
    latchNativeQuotaFromPipelineReasons([paused], T0);
    expect(routesOnQuota('claude')).toBe(true);
    jest.setSystemTime(T0 + HOUR);
    setAiCreditsRoutingModeCache('on-quota');
    expect(routesOnQuota('claude')).toBe(false);
    // The scheduled resume replays the now-past reset time: no re-latch.
    latchNativeQuotaFromResumedReasons([paused], undefined, T0 + HOUR);
    expect(routesOnQuota('claude')).toBe(false);
  });

  it('clamps a future detection time to now, and a later usage read still clears it', () => {
    latchNativeQuotaFromPipelineReasons(
      [reason({ detected_at: iso(T0 + 10 * 60 * 1000) })],
      T0,
    );
    expect(routesOnQuota('claude')).toBe(true);
    expect(canReconcileProviderQuotaReached('claude', T0)).toBe(false);
    expect(canReconcileProviderQuotaReached('claude', T0 + 1)).toBe(true);
  });

  it('ignores a reason detected before a native account change', async () => {
    mockPrefs = {
      ...mockPrefs,
      nativeProviderAccounts: { claude: { accountKey: 'old@example.com' } },
    };
    let emit: ((event: ConfirmedProviderAuthEvent) => void) | undefined;
    const stop = startNativeAccountChangeTracking({
      subscribe: (listener) => {
        emit = listener;
        return (): void => undefined;
      },
      clearRoutingCaches: () => undefined,
    });
    await nativeAccountChangeTestSeams.whenIdle();
    const change: ConfirmedProviderAuthEvent = {
      provider: 'claude',
      status: {
        authenticated: true,
        accountLabel: null,
        detail: null,
        error: null,
        accountEmail: 'new@example.com',
      },
      fingerprint: 'new',
      connectSource: 'external_change',
    };
    emit?.(change);
    await nativeAccountChangeTestSeams.whenIdle();
    stop();
    latchNativeQuotaFromPipelineReasons(
      [reason({ detected_at: iso(T0 - 1) })],
      T0,
    );
    expect(routesOnQuota('claude')).toBe(false);
    latchNativeQuotaFromPipelineReasons(
      [reason({ detected_at: iso(T0 + 1) })],
      T0 + 1,
    );
    expect(routesOnQuota('claude')).toBe(true);
  });

  it('clear, then rebroadcast: a successful allowance read keeps the latch clear', async () => {
    const paused = reason();
    broadcastPipelineExecutionEvent(event([paused]));
    expect(routesOnQuota('claude')).toBe(true);
    await expect(
      recordNativeSubscriptionRestored(
        'claude',
        'me@example.com',
        T0,
        () => true,
      ),
    ).resolves.toBe(true);
    expect(routesOnQuota('claude')).toBe(false);
    broadcastPipelineExecutionEvent(event([paused]));
    expect(routesOnQuota('claude')).toBe(false);
    // A reason detected after the read is a fresh limit and latches again.
    jest.setSystemTime(T0 + 5000);
    setAiCreditsRoutingModeCache('on-quota');
    broadcastPipelineExecutionEvent(
      event([reason({ id: 'reason-2', detected_at: iso(T0 + 1000) })]),
    );
    expect(routesOnQuota('claude')).toBe(true);
  });

  it('rebroadcasting the same reason writes nothing and sends nothing extra', () => {
    broadcastPipelineExecutionEvent(event([reason()]));
    jest.runOnlyPendingTimers();
    const sendsAfterFirst = mockSendToAllWindows.mock.calls.length;
    broadcastPipelineExecutionEvent(event([reason()]));
    jest.runOnlyPendingTimers();
    // Only the broadcaster's own renderer publish; the latch adds no IPC.
    expect(mockSendToAllWindows.mock.calls.length).toBe(sendsAfterFirst + 1);
    expect(mockUpdatePreferences).not.toHaveBeenCalled();
    expect(mockBroadcastPreferencesChanged).not.toHaveBeenCalled();
    expect(canReconcileProviderQuotaReached('claude', T0 - 999)).toBe(true);
    expect(canReconcileProviderQuotaReached('claude', T0 - 1000)).toBe(false);
  });

  it('an older reason never overwrites a newer observation, and a live chat observation overwrites a workflow one', () => {
    latchNativeQuotaFromPipelineReasons(
      [reason({ detected_at: iso(T0 - 1000) })],
      T0,
    );
    latchNativeQuotaFromPipelineReasons(
      [reason({ detected_at: iso(T0 - 5000), resets_at: iso(T0 + 1) })],
      T0,
    );
    // Still the newer observation, with its later reset time.
    expect(canReconcileProviderQuotaReached('claude', T0 - 999)).toBe(true);
    jest.setSystemTime(T0 + 2);
    setAiCreditsRoutingModeCache('on-quota');
    expect(routesOnQuota('claude')).toBe(true);
    markProviderQuotaReached('claude');
    expect(canReconcileProviderQuotaReached('claude', T0 + 2)).toBe(false);
    expect(canReconcileProviderQuotaReached('claude', T0 + 3)).toBe(true);
  });

  it('latches each provider in a multi-reason event', () => {
    broadcastPipelineExecutionEvent(
      event([
        reason({ id: 'a', provider: 'claude' }),
        reason({ id: 'b', provider: 'codex' }),
      ]),
    );
    expect(routesOnQuota('claude')).toBe(true);
    expect(routesOnQuota('codex')).toBe(true);
  });

  it('an event with no status reasons leaves the latch untouched', () => {
    broadcastPipelineExecutionEvent(event([]));
    expect(routesOnQuota('claude')).toBe(false);
    latchNativeQuotaFromPipelineReasons([reason()], T0);
    broadcastPipelineExecutionEvent(event([]));
    expect(routesOnQuota('claude')).toBe(true);
  });
});

describe('Resume after an app restart', () => {
  const ANSWERED = '6f1c2a4e-8b3d-4c5a-9e7f-1a2b3c4d5e6f';
  const OTHER = '0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a';

  // Resumes through the real service and reports whether each provider
  // already routes to AI Credits when the control reaches the worker, which
  // is where the resumed step's routing resolves.
  async function resume(
    statusReasonIds?: string[],
  ): Promise<{ claude: boolean; codex: boolean }> {
    let routed = { claude: false, codex: false };
    mockControlThroughWorker.mockImplementationOnce(() => {
      routed = {
        claude: routesOnQuota('claude'),
        codex: routesOnQuota('codex'),
      };
      return Promise.resolve({ outcome: 'started', state: mockStoredState });
    });
    await resumePipelineExecutionFromMain({
      executionId: 'exec-1',
      initiationSource: 'user',
      getWindow: () => null,
      ...(statusReasonIds ? { statusReasonIds } : {}),
    });
    expect(mockControlThroughWorker).toHaveBeenCalledTimes(1);
    return routed;
  }

  beforeEach(() => {
    mockStoredState = null;
    mockControlThroughWorker.mockClear();
  });

  it('replays the stored reason so the resumed step routes to AI Credits', async () => {
    // A restart cleared the in-memory latch; the stored state keeps the reason.
    mockStoredState = event([reason({ id: ANSWERED })]).state;
    expect(await resume()).toEqual({ claude: true, codex: false });
  });

  it('honors statusReasonIds', async () => {
    mockStoredState = event([
      reason({ id: ANSWERED, provider: 'codex' }),
      reason({ id: OTHER, provider: 'claude' }),
    ]).state;
    expect(await resume([ANSWERED])).toEqual({ claude: false, codex: true });
    // The helper treats an empty id list like an absent one: every reason.
    latchNativeQuotaFromResumedReasons(mockStoredState.status_reasons, [], T0);
    expect(routesOnQuota('claude')).toBe(true);
  });

  it('does nothing when no stored state exists', async () => {
    expect(await resume([ANSWERED])).toEqual({ claude: false, codex: false });
  });
});

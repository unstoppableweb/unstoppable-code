import { observedModelIdentity } from '@canopy/core-runtime/observability';
import type {
  AgentDelegationTranscript,
  PersistedAgentRouteSnapshot,
} from '@canopy/protocol/delegation';
import type {
  AgentProviderAuthStatus,
  AgentProviderType,
} from '@canopy/desktop-shared/types';
import type {
  AgentAuditBillingBasis,
  AgentAuditDelegationLineage,
  AgentAuditEntry,
  AgentAuditStatus,
  AgentAuditTokenTotals,
  AgentAuditToolCounts,
} from '@canopy/execution-engine/types/observability';
import type {
  ModelHarness,
  ModelHarnessSource,
} from '@canopy/execution-engine/types/model-harnesses';
import { codexServiceTierForModelConfig } from '@canopy/execution-engine/lib/codex-model-config';
import { computeCodexObservedCost } from '../openai-pricing/cost-calculator';
import {
  getOpenAiPricingForCostingSync,
  type OpenAiPricingCacheState,
} from '../openai-pricing/pricing-client';

const MANAGED_DELEGATION_PROGRESS_INTERVAL_MS = 30_000;
const MAX_RETAINED_RUNS = 256;

const PROVIDERS: readonly AgentProviderType[] = [
  'claude',
  'codex',
  'ollama',
  'cursor',
  'opencode',
  'copilot',
];

const MODEL_HARNESSES: readonly ModelHarness[] = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
];

const MODEL_SOURCES: readonly ModelHarnessSource[] = [
  'claude-managed',
  'codex-managed',
  'cursor-managed',
  'copilot-managed',
  'opencode-managed',
  'ai-gateway',
  'ollama',
];

export interface ManagedDelegationAuditScope {
  projectId: string;
  worktreeId: string;
  chatId: string;
  /** The parent message id from `AgentDelegationTranscript.parentTurnId`. */
  userMessageId: string;
  parentPipelineExecutionId?: string;
  rootPipelineExecutionId?: string;
}

export interface ManagedDelegationCaptureOptions {
  onUpsert: (entry: AgentAuditEntry) => void;
  now?: () => number;
  /**
   * Billing for a route that runs on the provider's own account. It is read
   * here, when cost is recorded, so the route snapshot that decides whether a
   * delegation may resume never changes with how the account is billed.
   */
  nativeAccountKind?: (
    provider: AgentProviderType,
  ) => NonNullable<AgentProviderAuthStatus['accountKind']> | undefined;
  /** The local pricing snapshot used for Codex audit cost estimates. */
  codexPricing?: () => OpenAiPricingCacheState;
  /**
   * The audit's recent entry with this id, if it still holds one. It tells a
   * run an earlier process finished from one that process left running.
   */
  recordedEntry?: (id: string) => AgentAuditEntry | undefined;
}

interface ManagedDelegationRunCapture {
  readonly key: string;
  readonly scope: ManagedDelegationAuditScope;
  readonly startedAt: string;
  readonly startedAtMs: number;
  lastSequence: number;
  lastEmittedSequence: number;
  lastUpsertAttemptAt?: number;
  latestEntry?: AgentAuditEntry;
  flushTimer?: ReturnType<typeof setTimeout>;
  terminal: boolean;
}

function parseProvider(value: string): AgentProviderType | undefined {
  return PROVIDERS.find((provider) => provider === value);
}

function parseModelHarness(value: string): ModelHarness | undefined {
  return MODEL_HARNESSES.find((harness) => harness === value);
}

function parseModelSource(value: string): ModelHarnessSource | undefined {
  return MODEL_SOURCES.find((source) => source === value);
}

function timestampToIso(timestamp: number): string | undefined {
  if (!Number.isSafeInteger(timestamp)) return undefined;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value : undefined;
}

function nonNegativeNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function billingBasisFor(
  route: PersistedAgentRouteSnapshot,
  provider: AgentProviderType,
  nativeAccountKind: ManagedDelegationCaptureOptions['nativeAccountKind'],
): AgentAuditBillingBasis {
  if (
    route.billingAuthority === 'org_gateway' ||
    route.billingAuthority === 'organization-gateway' ||
    route.billingAuthority === 'model-gateway'
  )
    return 'org_gateway';
  if (route.aiCreditsRouted || route.billingAuthority === 'ai-credits')
    return 'ai_credits';
  if (route.billingAuthority === 'account-proxy') return 'account_proxy';
  if (
    route.billingAuthority === 'user-credential' ||
    route.billingAuthority === 'api-key' ||
    route.billingAuthority === 'api_key'
  )
    return 'api_key';
  if (provider === 'ollama') return 'local';
  if (
    route.billingAuthority === 'native' ||
    route.billingAuthority === 'subscription'
  ) {
    const accountKind = nativeAccountKind?.(provider);
    if (accountKind === 'api_key' || accountKind === 'bedrock')
      return 'api_key';
    // An account kind the host has not learned yet is not assumed to be a plan.
    return accountKind === 'subscription' ? 'subscription' : 'unknown';
  }
  return 'unknown';
}

function auditStatusFor(
  status: AgentDelegationTranscript['snapshot']['status'],
): AgentAuditStatus {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
    case 'deadline_exceeded':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    case 'interrupted':
      return 'interrupted';
    case 'pending':
    case 'running':
      return 'running';
  }
}

function isTerminalStatus(
  status: AgentDelegationTranscript['snapshot']['status'],
): boolean {
  return status !== 'pending' && status !== 'running';
}

function emptyToolCounts(): AgentAuditToolCounts {
  return {
    thinking: 0,
    bash: 0,
    read: 0,
    readLines: 0,
    writeEdit: 0,
    plan: 0,
    fileEdit: 0,
    fileAdd: 0,
    fileDelete: 0,
    search: 0,
    grep: 0,
    web: 0,
    agent: 0,
    workflow: 0,
    tasks: 0,
    taskStop: 0,
    skills: 0,
    monitor: 0,
    claude: 0,
    scheduleWakeup: 0,
    askUser: 0,
    scriptOutput: 0,
    watcher: 0,
    canopy: 0,
    graph: 0,
    appAdvisor: 0,
    pipelineEditor: 0,
    mcp: 0,
    other: 0,
  };
}

function tokenTotalsFor(
  usage: AgentDelegationTranscript['snapshot']['usage'],
  previous: AgentAuditTokenTotals | undefined,
  executionHarness: ModelHarness | undefined,
): AgentAuditTokenTotals {
  const reportedInput = nonNegativeInteger(usage?.inputTokens);
  const output = nonNegativeInteger(usage?.outputTokens);
  const cacheRead = nonNegativeInteger(usage?.cachedInputTokens);
  const cacheWrite = nonNegativeInteger(usage?.cacheCreationInputTokens);
  // Cursor's input count includes its cache reads and writes; the audit's
  // counters are additive, so store the uncached remainder, as the main
  // Cursor chat path does (`ObservabilityService`). Claude reports them apart.
  const input =
    reportedInput !== undefined && executionHarness === 'cursor'
      ? Math.max(0, reportedInput - (cacheRead ?? 0) - (cacheWrite ?? 0))
      : reportedInput;
  return {
    input: input ?? previous?.input ?? 0,
    output: output ?? previous?.output ?? 0,
    cacheReadInputTokens: cacheRead ?? previous?.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens:
      cacheWrite ?? previous?.cacheCreationInputTokens ?? 0,
  };
}

function lineageFor(
  scope: ManagedDelegationAuditScope,
  transcript: AgentDelegationTranscript,
  route: PersistedAgentRouteSnapshot | undefined,
  previous: AgentAuditDelegationLineage | undefined,
): AgentAuditDelegationLineage {
  // The spawn contract keeps this bounded description separate from the prompt.
  // Never derive the audit label from task.prompt or transcript content.
  const description = Array.from(
    transcript.task.description,
    (character): string => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159)
        ? ' '
        : character;
    },
  ).join('');
  const label = description.replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    delegationId: transcript.delegationId,
    runGeneration: transcript.runGeneration,
    parentChatId: scope.chatId,
    parentUserMessageId: scope.userMessageId,
    ...(transcript.snapshot.parentDelegationId === undefined
      ? previous?.parentDelegationId === undefined
        ? {}
        : { parentDelegationId: previous.parentDelegationId }
      : { parentDelegationId: transcript.snapshot.parentDelegationId }),
    ...(scope.parentPipelineExecutionId === undefined
      ? previous?.parentPipelineExecutionId === undefined
        ? {}
        : { parentPipelineExecutionId: previous.parentPipelineExecutionId }
      : { parentPipelineExecutionId: scope.parentPipelineExecutionId }),
    ...(route === undefined
      ? previous?.harness === undefined
        ? {}
        : { harness: previous.harness }
      : { harness: route.harnessId }),
    ...(label.length === 0 ? {} : { label }),
  };
}

function auditEntryFor(
  scope: ManagedDelegationAuditScope,
  transcript: AgentDelegationTranscript,
  startedAt: string,
  previous: AgentAuditEntry | undefined,
  nativeAccountKind: ManagedDelegationCaptureOptions['nativeAccountKind'],
  codexPricing: () => OpenAiPricingCacheState,
): AgentAuditEntry | undefined {
  const route = transcript.snapshot.routeSnapshot;
  const provider =
    (route === undefined
      ? undefined
      : (parseProvider(route.providerType) ??
        parseProvider(route.harnessId))) ?? previous?.provider;
  if (provider === undefined) return undefined;

  const modelSource =
    route === undefined
      ? previous?.modelSource
      : (parseModelSource(route.modelSource) ?? previous?.modelSource);
  const executionHarness =
    route === undefined
      ? previous?.executionHarness
      : (parseModelHarness(route.harnessId) ?? previous?.executionHarness);
  const billingBasis =
    route === undefined
      ? (previous?.billingBasis ?? 'unknown')
      : billingBasisFor(route, provider, nativeAccountKind);
  const usageCost = nonNegativeNumber(transcript.snapshot.usage?.costUsd);
  // Retain a provider-reported cost when a later recovery snapshot omits it.
  const reportedCostExists =
    usageCost !== undefined ||
    (previous?.observedCost === undefined &&
      previous?.totalCostUsd !== undefined);
  const canEstimateCodexCost =
    provider === 'codex' &&
    billingBasis !== 'org_gateway' &&
    billingBasis !== 'local';
  let totalCostUsd = usageCost ?? previous?.totalCostUsd;
  const identity = observedModelIdentity({
    model:
      route === undefined
        ? previous?.model
        : route.runtimeModelId || route.selectedModelId,
    requestedModel: route?.selectedModelId,
    agentId: previous?.agentId,
  });
  const model = identity.model;
  const tokens = tokenTotalsFor(
    transcript.snapshot.usage,
    previous?.tokens,
    executionHarness,
  );
  let observedCost = reportedCostExists ? undefined : previous?.observedCost;
  let serviceTier = previous?.serviceTier;
  if (!canEstimateCodexCost && !reportedCostExists && previous?.observedCost) {
    observedCost = undefined;
    totalCostUsd = undefined;
  }
  if (canEstimateCodexCost && !reportedCostExists) {
    serviceTier = codexServiceTierForModelConfig({
      fastMode: transcript.task.fastMode,
    });
    const usage = transcript.snapshot.usage;
    observedCost = computeCodexObservedCost(
      {
        model,
        serviceTier,
        usageObserved:
          usage?.inputTokens !== undefined ||
          usage?.outputTokens !== undefined ||
          usage?.cachedInputTokens !== undefined ||
          usage?.cacheCreationInputTokens !== undefined,
        tokens,
      },
      codexPricing(),
    );
    totalCostUsd =
      typeof observedCost.totalUsd === 'number'
        ? observedCost.totalUsd
        : undefined;
  }
  const delegation = lineageFor(scope, transcript, route, previous?.delegation);

  return {
    id: auditEntryIdFor(transcript),
    eventType: 'managed_delegation',
    status: auditStatusFor(transcript.snapshot.status),
    provider,
    ...(modelSource === undefined ? {} : { modelSource }),
    ...(executionHarness === undefined ? {} : { executionHarness }),
    label: 'Managed delegation',
    startedAt,
    ...identity,
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
    ...(observedCost === undefined ? {} : { observedCost }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    tokens,
    messageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    subAgentCount: 0,
    toolCounts: emptyToolCounts(),
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId: scope.chatId,
    hasTranscript: false,
    ...(route === undefined
      ? previous?.aiCreditsRouted === undefined
        ? {}
        : { aiCreditsRouted: previous.aiCreditsRouted }
      : { aiCreditsRouted: route.aiCreditsRouted }),
    ...(billingBasis === 'org_gateway' ? { modelGatewayRouted: true } : {}),
    billingBasis,
    delegation,
    ...(scope.rootPipelineExecutionId === undefined
      ? previous?.rootPipelineExecutionId === undefined
        ? {}
        : { rootPipelineExecutionId: previous.rootPipelineExecutionId }
      : { rootPipelineExecutionId: scope.rootPipelineExecutionId }),
  };
}

function auditEntryIdFor(transcript: AgentDelegationTranscript): string {
  return `managed_delegation:${transcript.delegationId}:${String(transcript.runGeneration)}`;
}

/**
 * When a run last showed activity: its newest transcript item, or else its
 * start. Never later than `now`.
 */
function lastActivityAt(
  transcript: AgentDelegationTranscript,
  startedAtMs: number,
  now: number,
): number {
  let latest = startedAtMs;
  for (const item of transcript.transcript) {
    if (Number.isSafeInteger(item.occurredAt) && item.occurredAt > latest)
      latest = item.occurredAt;
  }
  return Math.max(startedAtMs, Math.min(latest, now));
}

function completionEntry(
  entry: AgentAuditEntry,
  startedAtMs: number,
  completedAtMs: number,
): AgentAuditEntry {
  const completedAt = timestampToIso(completedAtMs);
  return {
    ...entry,
    ...(completedAt === undefined ? {} : { completedAt }),
    durationMs: Math.max(0, completedAtMs - startedAtMs),
  };
}

export class ManagedDelegationCapture {
  private readonly onUpsert: (entry: AgentAuditEntry) => void;
  private readonly now: () => number;
  private readonly nativeAccountKind: ManagedDelegationCaptureOptions['nativeAccountKind'];
  private readonly codexPricing: () => OpenAiPricingCacheState;
  private readonly recordedEntry: ManagedDelegationCaptureOptions['recordedEntry'];
  /** A delegate never outlives its host: an older run ended before this. */
  private readonly createdAtMs: number;
  private readonly runs = new Map<string, ManagedDelegationRunCapture>();
  private disposed = false;

  constructor(options: ManagedDelegationCaptureOptions) {
    this.onUpsert = options.onUpsert;
    this.now = options.now ?? Date.now;
    this.nativeAccountKind = options.nativeAccountKind;
    this.codexPricing = options.codexPricing ?? getOpenAiPricingForCostingSync;
    this.recordedEntry = options.recordedEntry;
    this.createdAtMs = this.now();
  }

  observe(
    scope: ManagedDelegationAuditScope,
    transcript: AgentDelegationTranscript,
  ): void {
    if (this.disposed || !Number.isSafeInteger(transcript.runGeneration))
      return;
    if (
      transcript.runGeneration < 1 ||
      !Number.isSafeInteger(transcript.sequence)
    )
      return;

    const key = `${transcript.delegationId}:${String(transcript.runGeneration)}`;
    let run = this.runs.get(key);
    if (run?.terminal || (run && transcript.sequence <= run.lastSequence))
      return;

    const settled = isTerminalStatus(transcript.snapshot.status);
    // A run first seen settled was never seen running here: a retained
    // transcript replayed, or a run whose earlier snapshots were coalesced.
    const unwitnessed = run === undefined && settled;
    if (run === undefined) {
      const startedAt = timestampToIso(transcript.createdAt);
      if (startedAt === undefined) return;
      run = {
        key,
        scope: { ...scope },
        startedAt,
        startedAtMs: transcript.createdAt,
        lastSequence: -1,
        lastEmittedSequence: -1,
        terminal: false,
      };
      this.runs.set(key, run);
    }

    run.lastSequence = transcript.sequence;
    const recorded = unwitnessed
      ? this.recordedEntry?.(auditEntryIdFor(transcript))
      : undefined;
    if (unwitnessed && this.recordedElsewhere(transcript, recorded)) {
      run.terminal = true;
      run.lastEmittedSequence = run.lastSequence;
      this.trimCompletedRuns();
      return;
    }

    const nextEntry = auditEntryFor(
      run.scope,
      transcript,
      run.startedAt,
      run.latestEntry ?? recorded,
      this.nativeAccountKind,
      this.codexPricing,
    );
    if (nextEntry === undefined) return;
    run.latestEntry = nextEntry;

    if (settled) {
      run.terminal = true;
      this.clearTimer(run);
      const now = this.now();
      // Only a run seen running is known to end now. Any other ended at an
      // unknown earlier time, no later than its last activity.
      run.latestEntry = completionEntry(
        nextEntry,
        run.startedAtMs,
        unwitnessed ? lastActivityAt(transcript, run.startedAtMs, now) : now,
      );
      if (!this.emit(run, now))
        this.scheduleFlush(run, MANAGED_DELEGATION_PROGRESS_INTERVAL_MS);
      this.trimCompletedRuns();
      return;
    }

    this.emitOrSchedule(run);
  }

  /**
   * Whether a run first seen settled needs no record. The audit already
   * holding its completion is one case. A run created before this collector
   * is the other: it ended under an earlier process, which recorded it. Such
   * a run is recorded again only to settle an entry the audit still lists as
   * running.
   */
  private recordedElsewhere(
    transcript: AgentDelegationTranscript,
    recorded: AgentAuditEntry | undefined,
  ): boolean {
    if (recorded !== undefined) return recorded.status !== 'running';
    return transcript.createdAt < this.createdAtMs;
  }

  flush(): void {
    if (this.disposed) return;
    const now = this.now();
    for (const key of Array.from(this.runs.keys())) {
      const run = this.runs.get(key);
      if (run === undefined) continue;
      this.clearTimer(run);
      if (!this.emit(run, now))
        this.scheduleFlush(run, MANAGED_DELEGATION_PROGRESS_INTERVAL_MS);
    }
    this.trimCompletedRuns();
  }

  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
    for (const key of Array.from(this.runs.keys())) {
      const run = this.runs.get(key);
      if (run !== undefined) this.clearTimer(run);
    }
  }

  private emitOrSchedule(run: ManagedDelegationRunCapture): void {
    const now = this.now();
    const elapsed =
      run.lastUpsertAttemptAt === undefined
        ? Infinity
        : now - run.lastUpsertAttemptAt;
    if (elapsed >= MANAGED_DELEGATION_PROGRESS_INTERVAL_MS) {
      this.clearTimer(run);
      if (!this.emit(run, now))
        this.scheduleFlush(run, MANAGED_DELEGATION_PROGRESS_INTERVAL_MS);
      return;
    }
    if (run.flushTimer !== undefined) return;

    const delay = Math.max(
      0,
      MANAGED_DELEGATION_PROGRESS_INTERVAL_MS - elapsed,
    );
    this.scheduleFlush(run, delay);
  }

  private scheduleFlush(run: ManagedDelegationRunCapture, delay: number): void {
    if (this.disposed || run.flushTimer !== undefined) return;
    run.flushTimer = setTimeout(() => {
      run.flushTimer = undefined;
      if (!this.emit(run, this.now())) {
        this.scheduleFlush(run, MANAGED_DELEGATION_PROGRESS_INTERVAL_MS);
      } else if (run.terminal) {
        this.trimCompletedRuns();
      }
    }, delay);
    run.flushTimer.unref?.();
  }

  private emit(run: ManagedDelegationRunCapture, now: number): boolean {
    const entry = run.latestEntry;
    if (entry === undefined || run.lastSequence <= run.lastEmittedSequence)
      return true;
    run.lastUpsertAttemptAt = now;
    try {
      this.onUpsert(entry);
    } catch {
      return false;
    }
    run.lastEmittedSequence = run.lastSequence;
    return true;
  }

  private clearTimer(run: ManagedDelegationRunCapture): void {
    if (run.flushTimer === undefined) return;
    clearTimeout(run.flushTimer);
    run.flushTimer = undefined;
  }

  private trimCompletedRuns(): void {
    const completed: string[] = [];
    for (const key of Array.from(this.runs.keys())) {
      const run = this.runs.get(key);
      if (run === undefined) continue;
      if (run.terminal && run.lastSequence <= run.lastEmittedSequence)
        completed.push(key);
    }
    while (completed.length > MAX_RETAINED_RUNS) {
      const oldest = completed.shift();
      if (oldest !== undefined) {
        const run = this.runs.get(oldest);
        if (run !== undefined) this.clearTimer(run);
        this.runs.delete(oldest);
      }
    }
  }
}

import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import { codexServiceTierForModelConfig } from '@canopy/execution-engine/lib/codex-model-config';
import {
  readHelperUsage,
  type HelperUsage,
} from '@canopy/execution-engine/lib/helper-usage';
import {
  DEFAULT_PIPELINE_ADVISOR_MODEL,
  getExecutionHarnessForModel,
  getModelSource,
  getProviderForModel,
  normalizeThinkingForProvider,
  type AgentAuditEntry,
  type AgentAuditToolCounts,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionState,
  NormalizedJob,
  NormalizedStep,
  PipelineAdvisorEta,
  PipelineAdvisorEvent,
  PipelineAdvisorHealthStatus,
  PipelineAdvisorInefficiency,
  PipelineAdvisorReport,
  PipelineAdvisorSeverity,
  PipelineAdvisorSnapshot,
  PipelineAdvisorTurnKind,
} from '@canopy/execution-engine/types/pipeline';
import { randomUUID } from 'node:crypto';
import {
  runHelperThroughWorker,
  linkHelperAbort,
} from '../helper-runs/helper-runs';
import { sendToWindow } from '../lib/window-send';
import { readPreferencesFile } from '../lib/preferences-store';
import { isModelBlockedByStoredPolicy } from '../lib/model-policy-state';
import {
  resolveHelperInvocation,
  resolveHelperWorkOwner,
} from '../ollama/helper-invocation';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import type {
  ExecutionHandle,
  ExecutionRuntime,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import { loadExecutionState } from '@canopy/execution-engine/node/pipelines/executor';
import {
  PIPELINE_ADVISOR_SYSTEM_PROMPT,
  runPipelineAdvisorSdkTurn,
} from './pipeline-advisor-sdk';
import {
  getPipelineExecutionDataDir,
  normalizePipelineAdvisorReports,
  readPipelineAdvisorSnapshot,
  writePipelineAdvisorSnapshot,
} from './pipeline-advisor-store';
import { loadNestedRootPipelineExecutionId } from './root-pipeline-execution';

const INITIAL_DELAY_MS = 5_000;
const BACKOFF_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000];
const DEFAULT_AGENT_STEP_MS = 3 * 60_000;
const DEFAULT_UTILITY_STEP_MS = 5_000;
const MIN_AGENT_STEP_REMAINING_MS = 30_000;
const MIN_UTILITY_STEP_REMAINING_MS = 2_000;
const MAX_HEURISTIC_ETA_MS = 24 * 60 * 60_000;
const MODEL_BLOCKED_MESSAGE =
  'Workflow Advisor was skipped: this model is blocked by your organization policy.';

export interface WatchPipelineExecutionForAdvisorOptions {
  handle: ExecutionHandle;
  runtime: ExecutionRuntime;
  getWindow: () => BrowserWindow | null;
}

export interface RunPipelineAdvisorForExistingExecutionOptions {
  executionId: string;
  runtime: ExecutionRuntime;
  getWindow: () => BrowserWindow | null;
}

interface AdvisorPromptArgs {
  executionDataDir: string;
  stateFilePath: string;
  executionId: string;
  pipelineStatus: ExecutionState['status'];
  pauseReasons?: string[];
}

interface ActiveAdvisor {
  executionId: string;
  handle?: ExecutionHandle;
  runtime: ExecutionRuntime;
  getWindow: () => BrowserWindow | null;
  getState: () => ExecutionState;
  snapshot: PipelineAdvisorSnapshot;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  periodicPending: boolean;
  finalPending: boolean;
  shuttingDown: boolean;
  initialized: boolean;
  oneShot: boolean;
  activeTaskKey?: string;
  abortController?: AbortController;
}

export function getPipelineAdvisorService(): PipelineAdvisorService {
  return pipelineAdvisorService;
}

function createInitialAdvisorSnapshot(
  runtime: ExecutionRuntime,
  executionId: string,
  pipelineStartedAt?: string,
): PipelineAdvisorSnapshot {
  return {
    version: 1,
    executionId,
    executionDataDir: getPipelineExecutionDataDir(
      runtime.executionsDir,
      executionId,
    ),
    stateFilePath: path.join(runtime.executionsDir, `${executionId}.json`),
    provider: 'codex',
    model: DEFAULT_PIPELINE_ADVISOR_MODEL,
    thinkingLevel: 'high',
    status: 'starting',
    turnCount: 0,
    backoffIndex: 0,
    lastUpdatedAt: new Date().toISOString(),
    ...(pipelineStartedAt ? { pipelineStartedAt } : {}),
    reports: [],
  };
}

export class PipelineAdvisorService {
  private readonly active = new Map<string, ActiveAdvisor>();

  watchExecution(options: WatchPipelineExecutionForAdvisorOptions): void {
    const existing = this.active.get(options.handle.id);
    if (existing) {
      if (existing.handle === options.handle) {
        return;
      }

      const existingStatus = existing.getState().status;
      const nextStatus = options.handle.getState().status;
      if (
        isTerminalPipelineStatus(existingStatus) &&
        !isTerminalPipelineStatus(nextStatus)
      ) {
        this.interruptActive(existing, 'Workflow Advisor interrupted by retry');
      } else {
        return;
      }
    }

    const active: ActiveAdvisor = {
      ...options,
      executionId: options.handle.id,
      getState: () => options.handle.getState(),
      snapshot: createInitialAdvisorSnapshot(
        options.runtime,
        options.handle.id,
        options.handle.getState().started_at,
      ),
      timer: null,
      running: false,
      periodicPending: false,
      finalPending: false,
      shuttingDown: false,
      initialized: false,
      oneShot: false,
    };
    this.active.set(options.handle.id, active);

    void this.initialize(active).catch((error: unknown): void => {
      if (active.shuttingDown) {
        return;
      }
      active.snapshot = applyAdvisorFailure(active.snapshot, error, false);
      void this.persistAndEmit(active);
    });

    void options.handle.waitForCompletion().then(
      () => {
        this.requestFinalTurn(active);
      },
      () => {
        this.requestFinalTurn(active);
      },
    );
  }

  async runForExistingExecution(
    options: RunPipelineAdvisorForExistingExecutionOptions,
  ): Promise<PipelineAdvisorSnapshot> {
    const existing = this.active.get(options.executionId);
    if (existing) {
      return this.runForExistingActiveAdvisor(existing);
    }

    const preferences = await readPreferencesFile();
    const state = await loadExecutionState(
      options.executionId,
      options.runtime.executionsDir,
    );
    if (!state) {
      throw new Error(`Execution "${options.executionId}" not found`);
    }

    const active: ActiveAdvisor = {
      executionId: state.id,
      runtime: options.runtime,
      getWindow: options.getWindow,
      getState: () => state,
      snapshot: createInitialAdvisorSnapshot(
        options.runtime,
        state.id,
        state.started_at,
      ),
      timer: null,
      running: false,
      periodicPending: false,
      finalPending: false,
      shuttingDown: false,
      initialized: true,
      oneShot: true,
    };
    this.active.set(state.id, active);

    try {
      active.snapshot = await this.loadOrCreateSnapshot(active, preferences);
      const turnKind = isTerminalPipelineStatus(state.status)
        ? 'final'
        : 'initial';
      if (turnKind === 'final' && shouldSkipFinalTurn(active.snapshot, state)) {
        this.active.delete(state.id);
        return active.snapshot;
      }
      active.snapshot = {
        ...active.snapshot,
        status: 'starting',
        nextUpdateAt: undefined,
        lastUpdatedAt: new Date().toISOString(),
      };
      await this.persistAndEmit(active);
      void this.runTurn(active, turnKind);
      return active.snapshot;
    } catch (error) {
      this.active.delete(state.id);
      throw error;
    }
  }

  private async runForExistingActiveAdvisor(
    active: ActiveAdvisor,
  ): Promise<PipelineAdvisorSnapshot> {
    if (active.running || active.shuttingDown) {
      return active.snapshot;
    }

    if (active.timer) {
      clearTimeout(active.timer);
      active.timer = null;
    }

    const state = await this.getFreshState(active);
    const turnKind: PipelineAdvisorTurnKind = isTerminalPipelineStatus(
      state.status,
    )
      ? 'final'
      : active.snapshot.reports.length === 0
        ? 'initial'
        : 'periodic';

    if (turnKind === 'final' && shouldSkipFinalTurn(active.snapshot, state)) {
      this.active.delete(active.executionId);
      return active.snapshot;
    }

    active.initialized = true;
    active.snapshot = {
      ...active.snapshot,
      status: 'starting',
      nextUpdateAt: undefined,
      lastUpdatedAt: new Date().toISOString(),
    };
    await this.persistAndEmit(active);
    void this.runTurn(active, turnKind);
    return active.snapshot;
  }

  shutdown(reason: 'app-quit' | 'fatal-exit' = 'app-quit'): void {
    const message =
      reason === 'app-quit'
        ? 'Workflow Advisor interrupted by app shutdown'
        : 'Workflow Advisor interrupted by fatal exit';
    for (const active of Array.from(this.active.values())) {
      this.interruptActive(active, message);
    }
    this.active.clear();
  }

  private interruptActive(active: ActiveAdvisor, message: string): void {
    active.shuttingDown = true;
    active.abortController?.abort();
    if (active.timer) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    if (active.activeTaskKey) {
      getExecutionObservabilityIngest().finalizeObservedTask(
        active.activeTaskKey,
        'interrupted',
        message,
      );
    }
    this.active.delete(active.executionId);
  }

  private async initialize(active: ActiveAdvisor): Promise<void> {
    const preferences = await readPreferencesFile();
    if (!preferences.pipelineAdvisorEnabled) {
      active.shuttingDown = true;
      this.active.delete(active.executionId);
      return;
    }

    const snapshot = await this.loadOrCreateSnapshot(active, preferences);
    if (active.shuttingDown) {
      return;
    }
    active.snapshot = snapshot;
    await this.persistAndEmit(active);
    if (active.shuttingDown) {
      return;
    }
    active.initialized = true;
    if (active.finalPending) {
      active.finalPending = false;
      this.requestFinalTurn(active);
      return;
    }
    active.timer = setTimeout(() => {
      active.timer = null;
      const state = active.getState();
      if (isTerminalPipelineStatus(state.status)) {
        this.requestFinalTurn(active);
      } else {
        void this.runTurn(active, 'initial');
      }
    }, INITIAL_DELAY_MS);
  }

  private async loadOrCreateSnapshot(
    active: ActiveAdvisor,
    preferences: PreferencesData,
  ): Promise<PipelineAdvisorSnapshot> {
    const existing = await readPipelineAdvisorSnapshot(
      active.runtime.executionsDir,
      active.executionId,
    );
    const model = existing?.model ?? preferences.pipelineAdvisorModel;
    let snapshot: PipelineAdvisorSnapshot;
    if (existing) {
      const pipelineStartedAt = active.getState().started_at;
      if (
        isTerminalAdvisorStatus(existing.status) &&
        !isTerminalPipelineStatus(active.getState().status)
      ) {
        snapshot = resetTerminalAdvisorSnapshotForActivePipeline(
          existing,
          pipelineStartedAt,
        );
      } else {
        snapshot = {
          ...existing,
          pipelineStartedAt: existing.pipelineStartedAt ?? pipelineStartedAt,
        };
      }
    } else {
      const resolvedHarness = getExecutionHarnessForModel(model);
      if (resolvedHarness !== 'claude' && resolvedHarness !== 'codex') {
        throw new Error(
          `Configured Workflow Advisor model has no execution harness: ${model}`,
        );
      }
      snapshot = {
        ...active.snapshot,
        pipelineStartedAt: active.getState().started_at,
        provider: resolvedHarness,
        model,
        thinkingLevel: normalizeThinkingForProvider(
          preferences.pipelineAdvisorThinkingLevel,
          resolvedHarness,
        ),
        lastUpdatedAt: new Date().toISOString(),
      };
    }
    const state = active.getState();
    const workOwner = await resolveHelperWorkOwner({
      workspaceId: state.project_id,
      executionContext: state.execution_context,
    });
    if (
      (await isModelBlockedByStoredPolicy(model, workOwner)) &&
      !shouldSkipFinalTurn(snapshot, active.getState())
    ) {
      return applyAdvisorFailure(
        snapshot,
        new Error(MODEL_BLOCKED_MESSAGE),
        false,
      );
    }
    return snapshot;
  }

  private requestFinalTurn(active: ActiveAdvisor): void {
    if (active.shuttingDown) {
      return;
    }
    if (!active.initialized) {
      active.finalPending = true;
      return;
    }
    if (active.timer) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    if (active.running) {
      active.finalPending = true;
      return;
    }
    void this.runTurn(active, 'final');
  }

  private requestPeriodicTurn(active: ActiveAdvisor): void {
    if (active.shuttingDown) {
      return;
    }
    if (active.running) {
      active.periodicPending = true;
      return;
    }
    void this.runTurn(active, 'periodic');
  }

  private async runTurn(
    active: ActiveAdvisor,
    kind: PipelineAdvisorTurnKind,
  ): Promise<void> {
    if (active.running || active.shuttingDown) {
      if (kind === 'final') {
        active.finalPending = true;
      } else {
        active.periodicPending = true;
      }
      return;
    }

    const state = await this.getFreshState(active);
    if (kind !== 'final' && isTerminalPipelineStatus(state.status)) {
      kind = 'final';
    }
    if (kind === 'final' && shouldSkipFinalTurn(active.snapshot, state)) {
      this.active.delete(active.executionId);
      return;
    }

    active.running = true;
    const abortController = new AbortController();
    active.abortController = abortController;
    active.snapshot = {
      ...active.snapshot,
      status: 'running',
      nextUpdateAt: undefined,
      lastUpdatedAt: new Date().toISOString(),
    };
    await this.persistAndEmit(active);

    const promptArgs: AdvisorPromptArgs = {
      executionDataDir: active.snapshot.executionDataDir,
      stateFilePath: active.snapshot.stateFilePath,
      executionId: active.snapshot.executionId,
      pipelineStatus: state.status,
      pauseReasons: (state.status_reasons ?? []).map((reason) =>
        [
          reason.kind,
          reason.provider === 'claude'
            ? 'Claude'
            : reason.provider === 'codex'
              ? 'Codex'
              : (reason.provider ?? 'pipeline'),
          reason.code,
          `${reason.source.job_id}.${reason.source.step_id}`,
        ].join(' / '),
      ),
    };
    const userPrompt =
      kind === 'initial'
        ? buildInitialAdvisorPrompt(promptArgs)
        : kind === 'periodic'
          ? buildPeriodicAdvisorPrompt(promptArgs)
          : buildFinalAdvisorPrompt(promptArgs);
    const submittedText = `${PIPELINE_ADVISOR_SYSTEM_PROMPT}\n\n${userPrompt}`;
    const startedAt = new Date().toISOString();
    const taskKey = `pipeline-advisor:${state.id}:${kind}:${startedAt}`;
    active.activeTaskKey = taskKey;
    const observability = getExecutionObservabilityIngest();
    void loadNestedRootPipelineExecutionId(
      state,
      async (executionId) =>
        (await loadExecutionState(executionId, active.runtime.executionsDir)) ??
        undefined,
    )
      .then((rootPipelineExecutionId) => {
        if (rootPipelineExecutionId !== undefined) {
          observability.updateObservedTask(taskKey, {
            rootPipelineExecutionId,
          });
        }
      })
      .catch(() => undefined);
    observability.startObservedTask(
      taskKey,
      createAuditEntry({
        taskKey,
        startedAt,
        state,
        snapshot: active.snapshot,
      }),
    );
    let transcriptSeeded = false;
    const seedTranscript = (
      provider: PipelineAdvisorSnapshot['provider'],
    ): void => {
      observability.seedTranscript(taskKey, {
        provider,
        originalText: userPrompt,
        submittedText,
        planMode: false,
        injectedPrompts: [
          {
            kind: 'system_prompt_append',
            provider,
            applicationCondition: 'helper_task_system_prompt',
            text: PIPELINE_ADVISOR_SYSTEM_PROMPT,
          },
        ],
      });
      transcriptSeeded = true;
    };

    let turnUsage: HelperUsage = {};
    let disposeInvocation: (() => void) | undefined;
    try {
      const workOwner = await resolveHelperWorkOwner({
        workspaceId: state.project_id,
        executionContext: state.execution_context,
      });
      if (
        await isModelBlockedByStoredPolicy(active.snapshot.model, workOwner)
      ) {
        throw new Error(MODEL_BLOCKED_MESSAGE);
      }
      const invocation = await resolveHelperInvocation(
        active.snapshot.model,
        undefined,
        {
          allowNoNativeAuthFallback: false,
          workspaceId: state.project_id,
          executionContext: state.execution_context,
          signal: abortController.signal,
        },
      );
      disposeInvocation = invocation.dispose;
      if (active.shuttingDown) {
        return;
      }
      if (active.snapshot.provider !== invocation.harness) {
        active.snapshot = {
          ...active.snapshot,
          provider: invocation.harness,
          sdkSessionId: undefined,
          thinkingLevel: normalizeThinkingForProvider(
            active.snapshot.thinkingLevel,
            invocation.harness,
          ),
          lastUpdatedAt: new Date().toISOString(),
        };
        await this.persistAndEmit(active);
        if (active.shuttingDown) {
          return;
        }
      }
      seedTranscript(invocation.harness);
      observability.updateObservedTask(taskKey, {
        provider: invocation.providerType,
        modelSource: invocation.source,
        executionHarness: invocation.harness,
        serviceTier:
          invocation.harness === 'codex'
            ? codexServiceTierForModelConfig(state.model_config)
            : undefined,
        ...(invocation.aiCreditsRouted ? { aiCreditsRouted: true } : {}),
      });
      // A proxy account served the turn, not the user's own login (CAN-4030).
      if (invocation.accountProxyRouted) {
        observability.markObservedTaskAccountProxyRouted(taskKey);
      }
      const result = await runHelperThroughWorker({
        kind: 'pipeline_advisor',
        model: active.snapshot.model,
        scope: {
          ...(state.project_id !== undefined
            ? { workspaceId: state.project_id }
            : {}),
          ...(state.worktree_id !== undefined
            ? { worktreeId: state.worktree_id }
            : {}),
          executionId: state.id,
        },
        origin: 'system',
        workOwner,
        signal: abortController.signal,
        launch: async (workerSignal) => {
          const unlink = linkHelperAbort(workerSignal, abortController);
          try {
            return await runPipelineAdvisorSdkTurn({
              abortController,
              waitForQuotaRecovery: invocation.waitForQuotaRecovery,
              provider: invocation.harness,
              providerType: invocation.providerType,
              model: invocation.sdkModel ?? active.snapshot.model,
              modelConfig: state.model_config,
              envOverride: invocation.envOverride,
              codexConfig: invocation.codexConfig,
              codexSpeedRoute: {
                selectedModel: active.snapshot.model,
                modelSource: invocation.source,
                providerType: invocation.providerType,
                gateway: invocation.aiCreditsRouted ? 'ai-credits' : null,
              },
              thinkingLevel: active.snapshot.thinkingLevel,
              executionDataDir: active.snapshot.executionDataDir,
              systemPrompt: PIPELINE_ADVISOR_SYSTEM_PROMPT,
              userPrompt,
              schema: PIPELINE_ADVISOR_REPORT_SCHEMA,
              sdkSessionId: active.snapshot.sdkSessionId,
              observabilityTaskKey: taskKey,
              workspaceId: state.project_id,
            });
          } finally {
            unlink();
          }
        },
        usageOf: (result) => result.usage,
      });
      turnUsage = result.usage;
      if (active.shuttingDown) {
        return;
      }
      observability.updateObservedTask(taskKey, {
        sdkSessionId: result.sdkSessionId,
        model: active.snapshot.model,
      });
      const latestState = await this.getFreshState(active);
      const report = normalizeAdvisorReport({
        value: result.report,
        executionId: active.snapshot.executionId,
        kind,
        pipelineStatus: latestState.status,
        state: latestState,
      });
      active.snapshot = applyAdvisorSuccess(
        active.snapshot,
        report,
        result.sdkSessionId,
        latestState,
      );
      await this.persistAndEmit(active);
      observability.finalizeObservedTask(
        taskKey,
        'success',
        undefined,
        result.usage,
      );
    } catch (error) {
      if (active.shuttingDown) {
        return;
      }
      if (!transcriptSeeded) {
        seedTranscript(active.snapshot.provider);
      }
      turnUsage = readHelperUsage(error) ?? turnUsage;
      active.snapshot = applyAdvisorFailure(
        active.snapshot,
        error,
        kind === 'final',
      );
      await this.persistAndEmit(active);
      observability.finalizeObservedTask(
        taskKey,
        'failure',
        error instanceof Error ? error.message : String(error),
        turnUsage,
      );
    } finally {
      disposeInvocation?.();
      active.running = false;
      active.activeTaskKey = undefined;
      active.abortController = undefined;
      if (!active.shuttingDown) {
        await this.afterTurn(active, kind);
      }
    }
  }

  private async afterTurn(
    active: ActiveAdvisor,
    kind: PipelineAdvisorTurnKind,
  ): Promise<void> {
    if (active.finalPending) {
      active.finalPending = false;
      await this.runTurn(active, 'final');
      return;
    }
    if (kind === 'final') {
      this.active.delete(active.executionId);
      return;
    }
    const state = await this.getFreshState(active);
    if (isTerminalPipelineStatus(state.status)) {
      await this.runTurn(active, 'final');
      return;
    }
    if (active.oneShot) {
      const preferences = await readPreferencesFile();
      if (
        !preferences.pipelineAdvisorEnabled ||
        active.snapshot.reports.length === 0
      ) {
        this.active.delete(active.executionId);
        return;
      }
      active.oneShot = false;
    }
    if (active.periodicPending) {
      active.periodicPending = false;
      await this.runTurn(active, 'periodic');
      return;
    }
    this.schedulePeriodic(active);
  }

  private schedulePeriodic(active: ActiveAdvisor): void {
    const delay =
      BACKOFF_MS[Math.min(active.snapshot.backoffIndex, BACKOFF_MS.length - 1)];
    const nextUpdateAt = new Date(Date.now() + delay).toISOString();
    active.snapshot = {
      ...active.snapshot,
      status: active.snapshot.status === 'failed' ? 'failed' : 'waiting',
      nextUpdateAt,
      backoffIndex: active.snapshot.backoffIndex + 1,
      lastUpdatedAt: new Date().toISOString(),
    };
    void this.persistAndEmit(active);
    active.timer = setTimeout(() => {
      active.timer = null;
      this.requestPeriodicTurn(active);
    }, delay);
  }

  private async getFreshState(active: ActiveAdvisor): Promise<ExecutionState> {
    return (
      (await loadExecutionState(
        active.executionId,
        active.runtime.executionsDir,
      ).catch(() => null)) ?? active.getState()
    );
  }

  private async persistAndEmit(active: ActiveAdvisor): Promise<void> {
    await writePipelineAdvisorSnapshot(
      active.runtime.executionsDir,
      active.snapshot,
    );
    emitAdvisorEvent(active.getWindow, active.snapshot);
  }
}

export function emitAdvisorEvent(
  getWindow: () => BrowserWindow | null,
  snapshot: PipelineAdvisorSnapshot,
): void {
  const event: PipelineAdvisorEvent = {
    executionId: snapshot.executionId,
    snapshot,
    timestamp: new Date().toISOString(),
  };
  sendToWindow(getWindow(), PIPELINE_CHANNELS.ADVISOR_EVENT, event);
}

export function buildInitialAdvisorPrompt(args: AdvisorPromptArgs): string {
  return [
    `Pipeline execution data directory: ${args.executionDataDir}`,
    `Execution state file: ${args.stateFilePath}`,
    `Execution id: ${args.executionId}`,
    `Current pipeline status: ${args.pipelineStatus}`,
    ...(args.pauseReasons?.length
      ? [
          '',
          'Active pause reasons:',
          ...args.pauseReasons.map((reason) => `- ${reason}`),
        ]
      : []),
    '',
    'Read the execution data directory and provide a current health and ETA update as structured JSON.',
  ].join('\n');
}

export function buildPeriodicAdvisorPrompt(args: AdvisorPromptArgs): string {
  return [
    `Pipeline execution data directory: ${args.executionDataDir}`,
    `Execution state file: ${args.stateFilePath}`,
    `Execution id: ${args.executionId}`,
    `Current pipeline status: ${args.pipelineStatus}`,
    ...(args.pauseReasons?.length
      ? [
          '',
          'Active pause reasons:',
          ...args.pauseReasons.map((reason) => `- ${reason}`),
        ]
      : []),
    '',
    'Provide an updated pipeline health assessment, check for inefficiencies in the execution, and provide an ETA as structured JSON.',
  ].join('\n');
}

export function buildFinalAdvisorPrompt(args: AdvisorPromptArgs): string {
  return [
    `Pipeline execution data directory: ${args.executionDataDir}`,
    `Execution state file: ${args.stateFilePath}`,
    `Execution id: ${args.executionId}`,
    `Final pipeline status: ${args.pipelineStatus}`,
    ...(args.pauseReasons?.length
      ? [
          '',
          'Active pause reasons:',
          ...args.pauseReasons.map((reason) => `- ${reason}`),
        ]
      : []),
    '',
    'The pipeline has finished. Provide final health, inefficiencies, summary, and recommendations to improve the pipeline execution as structured JSON.',
  ].join('\n');
}

function applyAdvisorSuccess(
  snapshot: PipelineAdvisorSnapshot,
  report: PipelineAdvisorReport,
  sdkSessionId: string,
  state: ExecutionState,
): PipelineAdvisorSnapshot {
  const reports = normalizePipelineAdvisorReports([
    ...snapshot.reports,
    report,
  ]);
  const isFinal = report.kind === 'final';
  return {
    ...snapshot,
    sdkSessionId,
    status: isFinal
      ? state.status === 'cancelled'
        ? 'cancelled'
        : 'completed'
      : 'waiting',
    turnCount: snapshot.turnCount + 1,
    lastUpdatedAt: report.generatedAt,
    nextUpdateAt: undefined,
    finalizedCompletedAt:
      isFinal && state.completed_at
        ? state.completed_at
        : snapshot.finalizedCompletedAt,
    reports,
    latestReport: report,
    lastError: undefined,
  };
}

function applyAdvisorFailure(
  snapshot: PipelineAdvisorSnapshot,
  error: unknown,
  isFinal: boolean,
): PipelineAdvisorSnapshot {
  const previousFailures = snapshot.lastError?.consecutiveFailures ?? 0;
  const finalReport = [...snapshot.reports]
    .reverse()
    .find((report) => report.kind === 'final');
  const status = isFinal
    ? finalReport
      ? finalReport.pipelineStatus === 'cancelled'
        ? 'cancelled'
        : 'completed'
      : 'failed'
    : 'waiting';
  return {
    ...snapshot,
    status,
    turnCount: snapshot.turnCount + 1,
    lastUpdatedAt: new Date().toISOString(),
    lastError: {
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
      retryable: true,
      consecutiveFailures: previousFailures + 1,
    },
  };
}

function shouldSkipFinalTurn(
  snapshot: PipelineAdvisorSnapshot,
  state: ExecutionState,
): boolean {
  return Boolean(
    state.completed_at &&
    snapshot.finalizedCompletedAt === state.completed_at &&
    snapshot.reports.some((report) => report.kind === 'final'),
  );
}

function isTerminalPipelineStatus(status: ExecutionState['status']): boolean {
  return status === 'success' || status === 'failure' || status === 'cancelled';
}

function isTerminalAdvisorStatus(
  status: PipelineAdvisorSnapshot['status'],
): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

function resetTerminalAdvisorSnapshotForActivePipeline(
  snapshot: PipelineAdvisorSnapshot,
  pipelineStartedAt?: string,
): PipelineAdvisorSnapshot {
  return {
    ...snapshot,
    status: 'starting',
    backoffIndex: 0,
    nextUpdateAt: undefined,
    finalizedCompletedAt: undefined,
    lastError: undefined,
    lastUpdatedAt: new Date().toISOString(),
    ...(pipelineStartedAt ? { pipelineStartedAt } : {}),
  };
}

function createAuditEntry(args: {
  taskKey: string;
  startedAt: string;
  state: ExecutionState;
  snapshot: PipelineAdvisorSnapshot;
}): AgentAuditEntry {
  const configuredProvider =
    getProviderForModel(args.snapshot.model) ?? args.snapshot.provider;
  return {
    id: `${args.taskKey}:${args.startedAt}`,
    eventType: 'pipeline_advisor',
    status: 'running',
    provider: configuredProvider,
    modelSource: getModelSource(args.snapshot.model),
    executionHarness: args.snapshot.provider,
    label: 'Workflow Advisor',
    startedAt: args.startedAt,
    model: args.snapshot.model,
    serviceTier:
      args.snapshot.provider === 'codex'
        ? codexServiceTierForModelConfig(args.state.model_config)
        : undefined,
    tokens: defaultTokens(),
    messageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    subAgentCount: 0,
    hasTranscript: false,
    toolCounts: defaultToolCounts(),
    projectId: args.state.project_id,
    worktreeId: args.state.worktree_id,
    pipelineId: args.state.pipeline_id,
    pipelineExecutionId: args.state.id,
    sdkSessionId: args.snapshot.sdkSessionId,
    linkTarget: {
      page: 'pipelines',
      kind: 'pipeline-execution',
      pipelineExecutionId: args.state.id,
    },
  };
}

function defaultTokens(): AgentAuditEntry['tokens'] {
  return {
    input: 0,
    output: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function defaultToolCounts(): AgentAuditToolCounts {
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

function normalizeAdvisorReport(args: {
  value: unknown;
  executionId: string;
  kind: PipelineAdvisorTurnKind;
  pipelineStatus: ExecutionState['status'];
  state: ExecutionState;
}): PipelineAdvisorReport {
  const value = isRecord(args.value) ? args.value : {};
  const healthValue = isRecord(value.health) ? value.health : {};
  const normalizedEta = normalizeEta(value.eta);
  const eta =
    normalizedEta.status === 'unknown'
      ? (buildHeuristicEta(args.state) ?? normalizedEta)
      : normalizedEta;
  return {
    version: 1,
    reportId: randomUUID(),
    executionId: args.executionId,
    kind: args.kind,
    generatedAt: new Date().toISOString(),
    pipelineStatus: args.pipelineStatus,
    health: {
      status: normalizeHealthStatus(healthValue.status),
      score: clampScore(healthValue.score),
      summary: readString(healthValue.summary),
      evidence: readStringArray(healthValue.evidence),
      blockers: readStringArray(healthValue.blockers),
    },
    eta,
    inefficiencies: Array.isArray(value.inefficiencies)
      ? value.inefficiencies
          .map(normalizeInefficiency)
          .filter((item): item is PipelineAdvisorInefficiency => item !== null)
      : [],
    summary: readString(value.summary),
    recommendations: readStringArray(value.recommendations),
  };
}

function normalizeEta(value: unknown): PipelineAdvisorReport['eta'] {
  const eta = isRecord(value) ? value : {};
  const status =
    eta.status === 'available' || eta.status === 'complete'
      ? eta.status
      : 'unknown';
  return {
    status,
    ...(typeof eta.expectedCompletionAt === 'string' &&
    eta.expectedCompletionAt.trim()
      ? { expectedCompletionAt: eta.expectedCompletionAt }
      : {}),
    ...(typeof eta.remainingSeconds === 'number' &&
    Number.isFinite(eta.remainingSeconds)
      ? { remainingSeconds: Math.max(0, Math.round(eta.remainingSeconds)) }
      : {}),
    confidence:
      eta.confidence === 'medium' || eta.confidence === 'high'
        ? eta.confidence
        : 'low',
    rationale: readString(eta.rationale),
  };
}

function buildHeuristicEta(state: ExecutionState): PipelineAdvisorEta | null {
  if (isTerminalPipelineStatus(state.status)) {
    return {
      status: 'complete',
      confidence: 'high',
      rationale: 'The pipeline has reached a terminal state.',
    };
  }

  const nowMs = Date.now();
  const jobEntries = Object.entries(state.jobs);
  if (jobEntries.length === 0 || !Number.isFinite(nowMs)) {
    return null;
  }

  const profile = buildEtaDurationProfile(state, nowMs);
  const jobIds = new Set([
    ...Object.keys(state.pipeline_snapshot.jobs),
    ...jobEntries.map(([jobId]) => jobId),
  ]);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const estimateJobFinishMs = (jobId: string): number => {
    const memoized = memo.get(jobId);
    if (memoized !== undefined) {
      return memoized;
    }
    if (visiting.has(jobId)) {
      return 0;
    }
    visiting.add(jobId);

    const job = state.pipeline_snapshot.jobs[jobId];
    const result = state.jobs[jobId];
    const ownRemainingMs = estimateJobRemainingMs(job, result, profile, nowMs);
    const dependencyFinishMs =
      job?.needs.reduce(
        (max, dependencyId) => Math.max(max, estimateJobFinishMs(dependencyId)),
        0,
      ) ?? 0;
    const jobFinishMs =
      result && isFinishedJobStatus(result.status)
        ? 0
        : isStartedJobStatus(result?.status)
          ? ownRemainingMs
          : dependencyFinishMs + ownRemainingMs;

    visiting.delete(jobId);
    memo.set(jobId, jobFinishMs);
    return jobFinishMs;
  };

  let remainingMs = 0;
  for (const jobId of Array.from(jobIds)) {
    remainingMs = Math.max(remainingMs, estimateJobFinishMs(jobId));
  }

  if (
    !Number.isFinite(remainingMs) ||
    remainingMs <= 0 ||
    remainingMs > MAX_HEURISTIC_ETA_MS
  ) {
    return null;
  }

  const remainingSeconds = Math.max(1, Math.round(remainingMs / 1000));
  return {
    status: 'available',
    remainingSeconds,
    confidence: profile.agentSampleCount > 0 ? 'medium' : 'low',
    rationale: [
      'Heuristic estimate because the advisor model returned ETA unknown.',
      `Computed from the pipeline dependency graph, ${profile.completedJobCount} completed job(s), ${profile.runningJobCount} running job(s), and ${profile.pendingJobCount} pending job(s).`,
      profile.agentSampleCount > 0
        ? `Agent-step baseline is approximately ${formatDurationForRationale(
            profile.agentStepMs,
          )} from completed agent work.`
        : `No completed agent-step sample was available, so the default agent-step baseline is ${formatDurationForRationale(
            profile.agentStepMs,
          )}.`,
    ].join(' '),
  };
}

interface EtaDurationProfile {
  agentStepMs: number;
  utilityStepMs: number;
  agentSampleCount: number;
  completedJobCount: number;
  runningJobCount: number;
  pendingJobCount: number;
}

function buildEtaDurationProfile(
  state: ExecutionState,
  nowMs: number,
): EtaDurationProfile {
  const agentDurations: number[] = [];
  const utilityDurations: number[] = [];
  let completedJobCount = 0;
  let runningJobCount = 0;
  let pendingJobCount = 0;

  for (const [jobId, result] of Object.entries(state.jobs)) {
    if (isFinishedJobStatus(result.status)) {
      completedJobCount += 1;
    } else if (isStartedJobStatus(result.status)) {
      runningJobCount += 1;
    } else {
      pendingJobCount += 1;
    }

    const job = state.pipeline_snapshot.jobs[jobId];
    for (const [stepId, stepResult] of Object.entries(result.steps)) {
      const durationMs = getCompletedDurationMs(
        stepResult.started_at,
        stepResult.completed_at,
      );
      if (durationMs === null) {
        continue;
      }
      const step = job?.steps.find((candidate) => candidate.id === stepId);
      if (isAgentStep(step)) {
        agentDurations.push(durationMs);
      } else {
        utilityDurations.push(durationMs);
      }
    }
  }

  for (const [jobId, result] of Object.entries(state.jobs)) {
    const job = state.pipeline_snapshot.jobs[jobId];
    for (const [stepId, stepResult] of Object.entries(result.steps)) {
      if (!isStartedStepStatus(stepResult.status) || !stepResult.started_at) {
        continue;
      }
      const startedAtMs = readTimestampMs(stepResult.started_at);
      if (startedAtMs === null) {
        continue;
      }
      const elapsedMs = Math.max(0, nowMs - startedAtMs);
      const step = job?.steps.find((candidate) => candidate.id === stepId);
      if (isAgentStep(step)) {
        agentDurations.push(elapsedMs);
      }
    }
  }

  return {
    agentStepMs: clampEstimateMs(
      percentile(agentDurations, 0.75) ?? DEFAULT_AGENT_STEP_MS,
      DEFAULT_AGENT_STEP_MS,
      12 * 60_000,
    ),
    utilityStepMs: clampEstimateMs(
      percentile(utilityDurations, 0.75) ?? DEFAULT_UTILITY_STEP_MS,
      DEFAULT_UTILITY_STEP_MS,
      60_000,
    ),
    agentSampleCount: agentDurations.length,
    completedJobCount,
    runningJobCount,
    pendingJobCount,
  };
}

function estimateJobRemainingMs(
  job: NormalizedJob | undefined,
  result: ExecutionState['jobs'][string] | undefined,
  profile: EtaDurationProfile,
  nowMs: number,
): number {
  if (result && isFinishedJobStatus(result.status)) {
    return 0;
  }

  const steps = job?.steps ?? [];
  if (steps.length === 0) {
    if (!result) {
      return profile.utilityStepMs;
    }
    const startedAtMs = readTimestampMs(result.started_at);
    const baseline = hasAgentStep(job)
      ? profile.agentStepMs
      : profile.utilityStepMs;
    return estimateRemainingFromElapsedMs(
      baseline,
      startedAtMs === null ? 0 : Math.max(0, nowMs - startedAtMs),
      hasAgentStep(job),
    );
  }

  let remainingMs = 0;
  for (const step of steps) {
    const stepResult = result?.steps[step.id];
    if (stepResult && isFinishedStepStatus(stepResult.status)) {
      continue;
    }

    const agentStep = isAgentStep(step);
    const baseline = agentStep ? profile.agentStepMs : profile.utilityStepMs;
    if (stepResult && isStartedStepStatus(stepResult.status)) {
      const startedAtMs = readTimestampMs(stepResult.started_at);
      remainingMs += estimateRemainingFromElapsedMs(
        baseline,
        startedAtMs === null ? 0 : Math.max(0, nowMs - startedAtMs),
        agentStep,
      );
      continue;
    }

    remainingMs += baseline;
  }
  return remainingMs;
}

function estimateRemainingFromElapsedMs(
  expectedMs: number,
  elapsedMs: number,
  agentStep: boolean,
): number {
  const minimum = agentStep
    ? MIN_AGENT_STEP_REMAINING_MS
    : MIN_UTILITY_STEP_REMAINING_MS;
  if (elapsedMs <= 0) {
    return expectedMs;
  }
  return Math.max(minimum, expectedMs - elapsedMs);
}

function isAgentStep(step: NormalizedStep | undefined): boolean {
  return (
    step?.uses === 'builtin/agent-prompt' ||
    step?.uses === 'builtin/agent-resume'
  );
}

function hasAgentStep(job: NormalizedJob | undefined): boolean {
  return job?.steps.some(isAgentStep) ?? false;
}

function isFinishedJobStatus(
  status: ExecutionState['jobs'][string]['status'] | undefined,
): boolean {
  return (
    status === 'success' ||
    status === 'failure' ||
    status === 'cancelled' ||
    status === 'skipped'
  );
}

function isStartedJobStatus(
  status: ExecutionState['jobs'][string]['status'] | undefined,
): boolean {
  return (
    status === 'running' ||
    status === 'restarting' ||
    status === 'paused' ||
    status === 'queued' ||
    status === 'waiting_for_capacity'
  );
}

function isFinishedStepStatus(
  status: ExecutionState['jobs'][string]['steps'][string]['status'] | undefined,
): boolean {
  return (
    status === 'success' ||
    status === 'failure' ||
    status === 'cancelled' ||
    status === 'skipped'
  );
}

function isStartedStepStatus(
  status: ExecutionState['jobs'][string]['steps'][string]['status'] | undefined,
): boolean {
  return status === 'running';
}

function getCompletedDurationMs(
  startedAt: string | undefined,
  completedAt: string | undefined,
): number | null {
  const startedAtMs = readTimestampMs(startedAt);
  const completedAtMs = readTimestampMs(completedAt);
  if (startedAtMs === null || completedAtMs === null) {
    return null;
  }
  const durationMs = completedAtMs - startedAtMs;
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
}

function readTimestampMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return sorted[index];
}

function clampEstimateMs(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function formatDurationForRationale(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `${hours}h`
    : `${hours}h ${remainingMinutes}m`;
}

function normalizeInefficiency(
  value: unknown,
): PipelineAdvisorInefficiency | null {
  if (!isRecord(value)) {
    return null;
  }
  const title = readString(value.title).trim();
  const evidence = readString(value.evidence).trim();
  if (!title || !evidence) {
    return null;
  }
  return {
    severity: normalizeSeverity(value.severity),
    title,
    evidence,
    ...(readString(value.recommendation).trim()
      ? { recommendation: readString(value.recommendation).trim() }
      : {}),
    ...(readString(value.relatedJobId).trim()
      ? { relatedJobId: readString(value.relatedJobId).trim() }
      : {}),
    ...(readString(value.relatedStepId).trim()
      ? { relatedStepId: readString(value.relatedStepId).trim() }
      : {}),
  };
}

function normalizeHealthStatus(value: unknown): PipelineAdvisorHealthStatus {
  return value === 'healthy' ||
    value === 'watch' ||
    value === 'degraded' ||
    value === 'blocked' ||
    value === 'complete'
    ? value
    : 'unknown';
}

function normalizeSeverity(value: unknown): PipelineAdvisorSeverity {
  return value === 'warning' || value === 'critical' ? value : 'info';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim() !== '',
      )
    : [];
}

function clampScore(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const PIPELINE_ADVISOR_REPORT_SCHEMA: Record<string, JsonValue> = {
  type: 'object',
  additionalProperties: false,
  required: ['health', 'eta', 'inefficiencies', 'summary', 'recommendations'],
  properties: {
    health: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'score', 'summary', 'evidence', 'blockers'],
      properties: {
        status: {
          type: 'string',
          enum: [
            'healthy',
            'watch',
            'degraded',
            'blocked',
            'complete',
            'unknown',
          ],
        },
        score: { type: 'integer', minimum: 0, maximum: 100 },
        summary: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' } },
        blockers: { type: 'array', items: { type: 'string' } },
      },
    },
    eta: {
      type: 'object',
      additionalProperties: false,
      required: [
        'status',
        'expectedCompletionAt',
        'remainingSeconds',
        'confidence',
        'rationale',
      ],
      properties: {
        status: { type: 'string', enum: ['available', 'unknown', 'complete'] },
        expectedCompletionAt: { type: ['string', 'null'] },
        remainingSeconds: { type: ['integer', 'null'], minimum: 0 },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        rationale: { type: 'string' },
      },
    },
    inefficiencies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'severity',
          'title',
          'evidence',
          'recommendation',
          'relatedJobId',
          'relatedStepId',
        ],
        properties: {
          severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
          title: { type: 'string' },
          evidence: { type: 'string' },
          recommendation: { type: ['string', 'null'] },
          relatedJobId: { type: ['string', 'null'] },
          relatedStepId: { type: ['string', 'null'] },
        },
      },
    },
    summary: { type: 'string' },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
};

const pipelineAdvisorService = new PipelineAdvisorService();

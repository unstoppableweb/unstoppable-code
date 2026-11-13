import { z } from 'zod';
import { OperationCancelRefusedError } from '@canopy/core-runtime/node/operations';
import type { HookQueueHost } from '@canopy/core-runtime/node/initiated-work';
import { getHookQueue } from './hook-initiated-work';
import { revalidateQueuedHookWork } from './hook-recovery';
import { validateId } from './validation';
import { logMainProcessWarn } from './main-process-logging';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import type { ChildPipelineAuthorization } from '@canopy/execution-engine/node/pipelines/executor/child-pipeline-resolver';
import {
  backgroundExecutionDeniedMessage,
  backgroundExecutionRetryMessage,
} from '@canopy/desktop-shared/node/background-execution-context';
import {
  pipelineContextResources,
  localPipelineContextResources,
} from '@canopy/desktop-shared/node/background-execution-context';
import {
  authorizeBackgroundExecution,
  backgroundExecutionContextEnabled,
} from '../services/background-execution-context';
import { publishForeignPipelineQueueActivity } from '../services/foreign-activity-sources';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  interpolateHookTemplate,
  pipelineHookUnsupportedSpeedError,
  type PipelineHookAction,
} from '@canopy/desktop-shared/hooks';
import {
  DEFAULT_CODEX_SPEED,
  isCodexSpeed,
  type CodexSpeed,
  readCodexSpeedRecord,
  withCodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import type { AgentModelConfig } from '@canopy/desktop-shared/types';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import {
  getTriggerTypes,
  type Pipeline,
  type PipelineData,
  type PipelineInputDef,
  type PipelinePreferenceLocator,
} from '@canopy/execution-engine/types/pipeline';
import { sendToWindow } from './window-send';
import {
  createPipelineExecutionId,
  loadExecutionState,
  getNormalizedTriggerInputDefs,
  resolvePipelineInputs,
  type ExecutePipelineRequestOptions,
  type PipelineTriggerSource,
} from '@canopy/execution-engine/node/pipelines/executor';
import { getProjectPipelinesDirCandidates } from '../pipelines/config-paths';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
import {
  getCreatedAt,
  getProjectPipelineId,
  loadProjectPipelineFromDisk,
} from '../pipelines/project-pipeline-discovery';
import {
  startPipelineExecutionFromMain,
  validateProjectPipelineAccess,
} from '../pipelines/pipeline-handlers';
import { readPreferencesFile } from './preferences-store';
import {
  hasActivePipelineExecutions,
  getActiveExecutionHandle,
  isExecutionReservedBy,
  releaseExecutionReservation,
  reserveExecution,
  subscribeToActiveCountChange,
} from '../pipelines/pipeline-execution-registry';

export type HookPipelineLaunchResult =
  | { status: 'started'; pipelineName: string; executionId: string }
  | { status: 'queued'; pipelineName: string; queueId: string }
  | { status: 'ended'; pipelineName: string; queueId: string };

interface ResolvedHookPipeline {
  pipeline: PipelineData;
  pipelineId: string;
  pipelineFilePath?: string;
  repoPath: string;
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
  pipelineName: string;
}

export interface QueuedHookPipelinePayload {
  identity: { operationId: string; actionIndex: number };
  projectId: string;
  worktreeId: string;
  cwd: string;
  action: PipelineHookAction;
  pipelineId: string;
  pipelineName: string;
  executionId: string;
  inputs?: Record<string, string>;
  codexSpeed: CodexSpeed;
  triggerSource: PipelineTriggerSource;
  enqueuedAt: string;
}

const queuedHookPipelinePayloadSchema = z.object({
  identity: z.object({
    operationId: z.string(),
    actionIndex: z.number().int().nonnegative(),
  }),
  projectId: z.string(),
  worktreeId: z.string(),
  cwd: z.string(),
  action: z.object({
    type: z.literal('pipeline'),
    source: z.enum(['bundled', 'curated', 'local', 'project']),
    id: z.string(),
    inputs: z.record(z.string(), z.string()).optional(),
    executionContext: z.string().optional(),
  }),
  pipelineId: z.string(),
  pipelineName: z.string(),
  executionId: z.string(),
  inputs: z.record(z.string(), z.string()).optional(),
  codexSpeed: z.custom<CodexSpeed>(
    (value) => isCodexSpeed(value) && value !== 'ultrafast',
  ),
  triggerSource: z.object({
    kind: z.literal('hook'),
    hook_key: z.string(),
    hook_label: z.string(),
    trigger_name: z.string(),
    target: z.enum(['project', 'workspace-root', 'workspace-repo']),
    action_index: z.number().int(),
    triggered_at: z.string(),
    repo_id: z.string().optional(),
    repo_name: z.string().optional(),
  }),
  enqueuedAt: z.string(),
});

export function parseQueuedHookPipelinePayload(
  value: unknown,
): QueuedHookPipelinePayload | null {
  const parsed = queuedHookPipelinePayloadSchema.safeParse(value);
  if (!parsed.success) return null;
  try {
    validateId(parsed.data.identity.operationId, 'operationId');
    validateId(parsed.data.projectId, 'projectId');
    validateId(parsed.data.worktreeId, 'worktreeId');
    return parsed.data;
  } catch {
    return null;
  }
}

interface QueuedHookPipelineInvocation {
  queueId: string;
  identity: QueuedHookPipelinePayload['identity'];
  action: PipelineHookAction;
  inputs?: Record<string, string>;
  codexSpeed: CodexSpeed;
  operationId?: string;
  admission: Promise<void>;
  recoveryOrder?: number;
  recovering: boolean;
  cancelPending: boolean;
  starting: boolean;
  projectId: string;
  worktreeId: string;
  pipelineId: string;
  pipelineName: string;
  pipeline: Pipeline;
  options: ExecutePipelineRequestOptions & { cwd: string; executionId: string };
  triggerSource: PipelineTriggerSource;
  getWindow: () => BrowserWindow | null;
  enqueuedAt: string;
  cancelled: boolean;
  contextResources: ReturnType<typeof pipelineContextResources>;
  executionContext?: string;
}

const queuedHookPipelines: QueuedHookPipelineInvocation[] = [];
let drainChain = Promise.resolve();
let admissionChain = Promise.resolve();
let suppressActiveCountDrain = false;
const recoveringHookPipelines = new Map<
  string,
  {
    operationId: string;
    recoveryOrder: number;
    abort: AbortController;
    cancelled: boolean;
  }
>();
let nextRecoveryOrder = 0;
let hookPipelineQueueHostRegistered = false;
const CANOPY_TEMPLATE_TOKEN_PATTERN = /\{\{CANOPY_[A-Z0-9_]+\}\}/g;

function isSafeProjectPipelineRelativePath(relativePath: string): boolean {
  if (
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    return false;
  }

  const segments = relativePath.split(/[\\/]/);
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    return false;
  }

  const extension = path.posix
    .extname(relativePath.replace(/\\/g, '/'))
    .toLowerCase();
  return extension === '.yml' || extension === '.yaml';
}

function getStoredPipelineSource(
  source: PipelineHookAction['source'],
): 'bundled' | 'user' {
  return source === 'bundled' ? 'bundled' : 'user';
}

async function resolveHookPipeline(args: {
  action: PipelineHookAction;
  cwd: string;
}): Promise<ResolvedHookPipeline> {
  const id = args.action.id.trim();
  if (!id) {
    throw new Error('Workflow hook action id must not be empty');
  }

  if (args.action.source === 'curated') {
    const { getManagedCuratedPipeline } =
      await import('../pipelines/curated-pipeline-catalog');
    const pipeline = await getManagedCuratedPipeline(id);
    return {
      pipeline,
      pipelineId: id,
      repoPath: args.cwd,
      pipelinePreferenceLocator: {
        type: 'stored',
        source: 'curated',
        value: id,
        ...(pipeline.info.curatedContentHash
          ? { contentHash: pipeline.info.curatedContentHash }
          : {}),
      },
      pipelineName: pipeline.content.name ?? id,
    };
  }

  if (args.action.source !== 'project') {
    const result = getStoredPipelineBySource(
      getStoredPipelineSource(args.action.source),
      id,
    );
    if (!result.success || !result.data) {
      throw new Error(result.error || `Workflow not found: ${id}`);
    }
    return {
      pipeline: result.data,
      pipelineId: id,
      repoPath: args.cwd,
      pipelinePreferenceLocator: {
        type: 'stored',
        source: getStoredPipelineSource(args.action.source),
        value: id,
      },
      pipelineName: result.data.content.name ?? id,
    };
  }

  if (!isSafeProjectPipelineRelativePath(id)) {
    throw new Error(
      'Project workflow hook id must be a safe relative .yml or .yaml path',
    );
  }

  const normalizedRelativePath = id.replace(/\\/g, '/');
  const pipelineId = getProjectPipelineId(normalizedRelativePath);
  let validated:
    | Awaited<ReturnType<typeof validateProjectPipelineAccess>>
    | undefined;

  for (const rootDir of getProjectPipelinesDirCandidates(args.cwd)) {
    const normalizedFilePath = path.resolve(rootDir, normalizedRelativePath);
    const candidate = await validateProjectPipelineAccess({
      id: pipelineId,
      cwd: args.cwd,
      filePath: normalizedFilePath,
    });
    if (!candidate.success) {
      validated ??= candidate;
      continue;
    }
    try {
      await stat(candidate.data.filePath);
      validated = candidate;
      break;
    } catch {
      validated ??= candidate;
    }
  }

  if (!validated?.success) {
    throw new Error(
      validated?.error ?? 'Project workflow could not be resolved',
    );
  }

  const [content, fileStats] = await Promise.all([
    loadProjectPipelineFromDisk(validated.data.filePath),
    stat(validated.data.filePath),
  ]);
  const relativeFilePath = path
    .relative(validated.data.rootDir, validated.data.filePath)
    .split(path.sep)
    .join('/');

  return {
    pipeline: {
      info: {
        id: pipelineId,
        name: content.name,
        description: content.description ?? '',
        icon: content.icon ?? '',
        filename: relativeFilePath,
        createdAt: getCreatedAt(fileStats),
        updatedAt: fileStats.mtime.toISOString(),
        source: 'project',
        readonly: true,
        filePath: validated.data.filePath,
      },
      content,
    },
    pipelineId,
    pipelineFilePath: validated.data.filePath,
    repoPath: args.cwd,
    pipelinePreferenceLocator: {
      type: 'file',
      value: validated.data.filePath,
    },
    pipelineName: content.name ?? id,
  };
}

function isCanopyPlaceholderOnlyTemplate(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const remainder = trimmed.replace(CANOPY_TEMPLATE_TOKEN_PATTERN, '');
  return remainder.trim().length === 0;
}

function interpolateAndNormalizeInputs(args: {
  inputs: Record<string, string> | undefined;
  env: Record<string, string | undefined>;
  definitions: Record<string, PipelineInputDef> | undefined;
}): Record<string, string> | undefined {
  if (!args.inputs) {
    return undefined;
  }

  const nextInputs: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(args.inputs)) {
    const interpolatedValue = interpolateHookTemplate(rawValue, args.env);
    const definition = args.definitions?.[key];
    const shouldDropBlankOptionalInput =
      interpolatedValue.length === 0 &&
      definition !== undefined &&
      definition.required !== true;
    const shouldDropMissingRequiredPlaceholderInput =
      interpolatedValue.length === 0 &&
      definition?.required === true &&
      isCanopyPlaceholderOnlyTemplate(rawValue);
    if (
      shouldDropBlankOptionalInput ||
      shouldDropMissingRequiredPlaceholderInput
    ) {
      continue;
    }
    nextInputs[key] = interpolatedValue;
  }

  return Object.keys(nextInputs).length > 0 ? nextInputs : undefined;
}

function getDispatchInputDefinitions(args: {
  pipeline: Pipeline;
  label: string;
}): Record<string, PipelineInputDef> | undefined {
  if (!getTriggerTypes(args.pipeline.on).includes('dispatch')) {
    throw new Error(
      `Workflow "${args.label}" does not define a dispatch trigger`,
    );
  }

  const normalized = normalizePipeline(args.pipeline);
  return getNormalizedTriggerInputDefs(normalized, 'dispatch');
}

function assertDispatchPipeline(args: {
  inputDefinitions: Record<string, PipelineInputDef> | undefined;
  inputs: Record<string, string> | undefined;
}): void {
  resolvePipelineInputs(args.inputDefinitions, args.inputs);
}

function hasWaitingQueuedPipeline(): boolean {
  return queuedHookPipelines.some((entry) => !entry.cancelled);
}

function toQueuedEntry(invocation: QueuedHookPipelineInvocation): {
  queueId: string;
  executionId: string;
  projectId: string;
  worktreeId: string;
  pipelineId: string;
  pipelineName: string;
  reason: 'pipeline-concurrency';
  reasonLabel: string;
  enqueuedAt: string;
  trigger_source: PipelineTriggerSource;
} {
  return {
    queueId: invocation.queueId,
    executionId: invocation.options.executionId,
    projectId: invocation.projectId,
    worktreeId: invocation.worktreeId,
    pipelineId: invocation.pipelineId,
    pipelineName: invocation.pipelineName,
    reason: 'pipeline-concurrency',
    reasonLabel: 'Waiting for active pipeline runs to finish',
    enqueuedAt: invocation.enqueuedAt,
    trigger_source: invocation.triggerSource,
  };
}

function emitQueueEvent(
  invocation: QueuedHookPipelineInvocation,
  event:
    | { type: 'queued'; entry: ReturnType<typeof toQueuedEntry> }
    | { type: 'started'; queueId: string }
    | { type: 'cancelled'; queueId: string }
    | {
        type: 'failed';
        queueId: string;
        entry: ReturnType<typeof toQueuedEntry>;
        error: string;
      },
): void {
  publishForeignPipelineQueueActivity({
    type: event.type,
    executionId: invocation.options.executionId,
    projectId: invocation.projectId,
    worktreeId: invocation.worktreeId,
  });
  sendToWindow(
    invocation.getWindow(),
    PIPELINE_CHANNELS.PIPELINE_QUEUE_EVENT,
    event,
  );
}

async function startReservedInvocation(
  invocation: QueuedHookPipelineInvocation,
): Promise<{ success: true } | { success: false; error: string }> {
  const authorizations: ChildPipelineAuthorization[] | undefined =
    backgroundExecutionContextEnabled() ? [] : undefined;
  const decision = await authorizeBackgroundExecution(
    invocation.executionContext,
    invocation.contextResources,
    { projectId: invocation.projectId, worktreeId: invocation.worktreeId },
    authorizations,
  );
  if (!decision.allow) {
    releaseExecutionReservation(invocation.options.executionId);
    return {
      success: false,
      error: decision.transient
        ? backgroundExecutionRetryMessage('run')
        : backgroundExecutionDeniedMessage(decision.reason, {
            ...(decision.subject ? { subject: decision.subject } : {}),
          }),
    };
  }
  const result = await startPipelineExecutionFromMain({
    pipeline: invocation.pipeline,
    options: {
      ...invocation.options,
      ...(authorizations === undefined
        ? {}
        : { childPipelineAuthorizations: authorizations }),
      executionId: invocation.options.executionId,
      triggerSource: invocation.triggerSource,
    },
    getWindow: invocation.getWindow,
    executionReservationClaimed: true,
  });

  if (!result.success) {
    releaseExecutionReservation(invocation.options.executionId);
    return { success: false, error: result.error };
  }

  return { success: true };
}

async function drainOnce(): Promise<void> {
  if (hasActivePipelineExecutions() || recoveringHookPipelines.size > 0) return;

  while (!hasActivePipelineExecutions()) {
    const invocation = queuedHookPipelines[0];
    if (!invocation) return;
    if (invocation.cancelled) {
      queuedHookPipelines.shift();
      continue;
    }
    if (
      !invocation.operationId ||
      invocation.recovering ||
      invocation.cancelPending
    )
      return;

    reserveExecution(invocation.options.executionId);
    invocation.starting = true;
    let marked: 'started' | 'ended';
    try {
      marked = await getHookQueue().markStarting(invocation.operationId);
    } catch (error) {
      invocation.starting = false;
      suppressActiveCountDrain = true;
      try {
        releaseExecutionReservation(invocation.options.executionId);
      } finally {
        suppressActiveCountDrain = false;
      }
      logMainProcessWarn(
        '[hook-pipeline] Could not record how a queued workflow ended.',
        error,
      );
      return;
    }
    if (marked === 'ended') {
      queuedHookPipelines.shift();
      releaseExecutionReservation(invocation.options.executionId);
      continue;
    }
    let started: Awaited<ReturnType<typeof startReservedInvocation>>;
    try {
      started = await startReservedInvocation(invocation);
    } catch (error) {
      releaseExecutionReservation(invocation.options.executionId);
      logMainProcessWarn(
        '[hook-pipeline] Could not start a queued workflow.',
        error,
      );
      started = {
        success: false,
        error: 'The queued workflow could not start.',
      };
    }
    queuedHookPipelines.shift();
    try {
      if (started.success) {
        await getHookQueue().finishStarted(
          invocation.operationId,
          invocation.queueId,
          {
            kind: 'pipeline',
            executionId: invocation.options.executionId,
            result: 'started',
          },
        );
      } else {
        await getHookQueue().finishFailed(
          invocation.operationId,
          invocation.queueId,
          'core.initiatedWork.hookQueue.startFailed',
          'The queued workflow could not start.',
        );
      }
    } catch (error) {
      logMainProcessWarn(
        '[hook-pipeline] Could not record how a queued workflow ended.',
        error,
      );
    }
    if (started.success) {
      emitQueueEvent(invocation, {
        type: 'started',
        queueId: invocation.queueId,
      });
      return;
    }
    emitQueueEvent(invocation, {
      type: 'failed',
      queueId: invocation.queueId,
      entry: toQueuedEntry(invocation),
      error: started.error,
    });
  }
}

function scheduleDrain(): void {
  drainChain = drainChain.then(drainOnce, drainOnce).catch((): void => {});
}

subscribeToActiveCountChange((count): void => {
  if (count === 0 && !suppressActiveCountDrain) {
    scheduleDrain();
  }
});

/**
 * Resolve the exact Codex speed for a hook-launched run. The hook's own
 * boolean (or its deprecated alias) wins; only without one does the run
 * inherit the Codex default. Pipelines cannot run Ultra fast, so an Ultra fast
 * hook or inherited default is rejected here — before the pipeline is
 * resolved, an execution id is minted, or anything is queued or started —
 * instead of silently running another speed.
 */
async function resolveHookPipelineModelConfig(
  action: PipelineHookAction,
): Promise<AgentModelConfig> {
  const actionError = pipelineHookUnsupportedSpeedError(action);
  if (actionError) {
    throw new Error(actionError);
  }
  const actionSpeed = readCodexSpeedRecord(
    action.modelConfig,
    action.codexFastMode,
  );
  if (actionSpeed !== undefined) {
    return withCodexSpeed(undefined, actionSpeed);
  }
  const prefs = await readPreferencesFile();
  const defaultSpeed =
    readCodexSpeedRecord(
      prefs.providerModelConfigDefaults?.codex,
      prefs.codexFastModeDefaultEnabled,
    ) ?? DEFAULT_CODEX_SPEED;
  if (defaultSpeed === 'ultrafast') {
    throw new Error(
      'Workflow hooks do not support Ultra fast. Choose Regular or Fast for this hook, or change the Codex default speed.',
    );
  }
  return withCodexSpeed(undefined, defaultSpeed);
}

type HookPipelineOptions = ExecutePipelineRequestOptions & {
  cwd: string;
  executionId: string;
};

function buildHookPipelineOptions(args: {
  cwd: string;
  projectId: string;
  worktreeId: string;
  resolved: ResolvedHookPipeline;
  triggerSource: PipelineTriggerSource;
  action: PipelineHookAction;
  modelConfig: AgentModelConfig;
  executionId: string;
  inputs?: Record<string, string>;
}): HookPipelineOptions {
  const { resolved } = args;
  const options: HookPipelineOptions = {
    cwd: args.cwd,
    pipelineId: resolved.pipelineId,
    repoPath: resolved.repoPath,
    eventName: 'dispatch',
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    triggerSource: args.triggerSource,
    // A hook launch has no user present at execution time. `triggerSource` and
    // `initiationSource` are independent fields, and until now only the former
    // was set here — so `pipeline-usage-events.ts` had to derive hook
    // attribution from `trigger_source.kind`, and any consumer reading
    // `initiation_source` (such as the step-runner's AI Credits attendedness
    // check) saw `undefined` and treated a hook run as interactive. Set it at
    // the source so both agree (ECW-9091 review round 8).
    initiationSource: 'hook',
    initiator: { kind: 'hook' },
    ...(args.action.executionContext === undefined
      ? {}
      : { executionContext: args.action.executionContext }),
    modelConfig: args.modelConfig,
    executionId: args.executionId,
  };
  if (args.inputs !== undefined) {
    options.inputs = args.inputs;
  }
  if (resolved.pipelinePreferenceLocator !== undefined) {
    options.pipelinePreferenceLocator = resolved.pipelinePreferenceLocator;
  }
  if (resolved.pipelineFilePath !== undefined) {
    options.pipelineFilePath = resolved.pipelineFilePath;
  }

  return options;
}

function buildInvocation(args: {
  queueId: string;
  identity: QueuedHookPipelinePayload['identity'];
  projectId: string;
  worktreeId: string;
  resolved: ResolvedHookPipeline;
  options: HookPipelineOptions;
  triggerSource: PipelineTriggerSource;
  getWindow: () => BrowserWindow | null;
  action: PipelineHookAction;
}): QueuedHookPipelineInvocation {
  const { resolved } = args;
  return {
    queueId: args.queueId,
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    pipelineId: resolved.pipelineId,
    pipelineName: resolved.pipelineName,
    pipeline: resolved.pipeline.content,
    options: args.options,
    triggerSource: args.triggerSource,
    getWindow: args.getWindow,
    enqueuedAt: new Date().toISOString(),
    cancelled: false,
    identity: args.identity,
    action: args.action,
    inputs: args.options.inputs,
    codexSpeed:
      readCodexSpeedRecord(args.options.modelConfig) ?? DEFAULT_CODEX_SPEED,
    admission: Promise.resolve(),
    recovering: false,
    cancelPending: false,
    starting: false,
    contextResources: resolved.pipelineFilePath
      ? localPipelineContextResources(resolved.pipeline.content, {
          cwd: args.options.cwd,
          pipelineFileDir: path.dirname(resolved.pipelineFilePath),
          pipelinePreferenceLocator: resolved.pipelinePreferenceLocator,
        })
      : pipelineContextResources(
          resolved.pipeline.content,
          resolved.pipeline.info.owner ??
            (resolved.pipeline.info.source === 'bundled'
              ? { type: 'system' }
              : resolved.pipeline.info.source === 'user'
                ? { shareScope: 'private' }
                : undefined),
          {
            cwd: args.options.cwd,
            repoPath: args.options.repoPath,
            getProjectPipelinesDirCandidates,
            pipelineId: resolved.pipeline.info.id,
            pipelinePreferenceLocator: resolved.pipelinePreferenceLocator,
          },
          resolved.pipeline.info.remoteId ?? resolved.pipeline.info.id,
        ),
    executionContext: args.action.executionContext,
  };
}

export async function launchHookPipeline(args: {
  identity: { operationId: string; actionIndex: number };
  action: PipelineHookAction;
  cwd: string;
  projectId: string;
  worktreeId: string;
  env: Record<string, string | undefined>;
  triggerSource: PipelineTriggerSource;
  getWindow: () => BrowserWindow | null;
}): Promise<HookPipelineLaunchResult> {
  const queueId = `queued-pipeline-${args.identity.operationId}-${args.identity.actionIndex}`;
  validateId(queueId, 'queueId');
  const existing = await getHookQueue().lookup(
    'pipeline',
    queueId,
    args.identity.operationId,
    args.identity.actionIndex,
  );
  if (existing.status !== 'none')
    return {
      status: existing.status === 'waiting' ? 'queued' : 'ended',
      pipelineName: args.action.id,
      queueId,
    };
  const modelConfig = await resolveHookPipelineModelConfig(args.action);
  const resolved = await resolveHookPipeline({
    action: args.action,
    cwd: args.cwd,
  });
  const inputDefinitions = getDispatchInputDefinitions({
    pipeline: resolved.pipeline.content,
    label: resolved.pipelineName,
  });
  const inputs = interpolateAndNormalizeInputs({
    inputs: args.action.inputs,
    env: args.env,
    definitions: inputDefinitions,
  });
  assertDispatchPipeline({ inputDefinitions, inputs });
  const executionId = createPipelineExecutionId();
  const options = buildHookPipelineOptions({
    ...args,
    resolved,
    modelConfig,
    executionId,
    inputs,
  });
  const invocation = buildInvocation({ ...args, queueId, resolved, options });
  if (
    args.action.allowPipelineConcurrency !== true &&
    (hasActivePipelineExecutions() ||
      hasWaitingQueuedPipeline() ||
      recoveringHookPipelines.size > 0)
  ) {
    queuedHookPipelines.push(invocation);
    const payload: QueuedHookPipelinePayload = {
      identity: args.identity,
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      cwd: args.cwd,
      action: args.action,
      pipelineId: resolved.pipelineId,
      pipelineName: resolved.pipelineName,
      executionId,
      inputs,
      codexSpeed: invocation.codexSpeed,
      triggerSource: args.triggerSource,
      enqueuedAt: invocation.enqueuedAt,
    };
    const serialized: unknown = JSON.parse(JSON.stringify(payload));
    invocation.admission = admissionChain
      .then(() =>
        getHookQueue().enqueue({
          kind: 'pipeline',
          queueId,
          runOperationId: args.identity.operationId,
          actionIndex: args.identity.actionIndex,
          scope: {
            workspaceId: args.projectId,
            worktreeId: args.worktreeId,
            executionId,
          },
          payload: z.json().parse(serialized),
        }),
      )
      .then((admitted): void => {
        invocation.operationId =
          admitted.status === 'queued'
            ? admitted.operationId
            : admitted.operation.operationId;
      });
    admissionChain = invocation.admission.catch((): void => {});
    try {
      await invocation.admission;
    } catch (error) {
      const index = queuedHookPipelines.indexOf(invocation);
      if (index >= 0) queuedHookPipelines.splice(index, 1);
      scheduleDrain();
      throw error;
    }
    emitQueueEvent(invocation, {
      type: 'queued',
      entry: toQueuedEntry(invocation),
    });
    scheduleDrain();
    return { status: 'queued', pipelineName: resolved.pipelineName, queueId };
  }
  reserveExecution(executionId);
  const started = await startReservedInvocation(invocation);
  if (!started.success) throw new Error(started.error);
  return {
    status: 'started',
    pipelineName: resolved.pipelineName,
    executionId,
  };
}

export async function cancelQueuedHookPipeline(
  queueId: string,
): Promise<boolean> {
  const invocation = queuedHookPipelines.find(
    (entry) => entry.queueId === queueId && !entry.cancelled,
  );
  if (
    !invocation ||
    invocation.starting ||
    isExecutionReservedBy(invocation.options.executionId, 'pipeline-start')
  )
    return false;
  invocation.cancelPending = true;
  try {
    await invocation.admission;
    if (!invocation.operationId)
      throw new Error('The queued workflow was not recorded.');
    await getHookQueue().finishCancelled(invocation.operationId, queueId);
  } catch (error) {
    invocation.cancelPending = false;
    scheduleDrain();
    throw error;
  }
  const index = queuedHookPipelines.indexOf(invocation);
  if (index >= 0) queuedHookPipelines.splice(index, 1);
  invocation.cancelled = true;
  emitQueueEvent(invocation, { type: 'cancelled', queueId });
  scheduleDrain();
  return true;
}

async function hasPipelineExecutionState(
  executionId: string,
): Promise<boolean> {
  return (
    (await loadExecutionState(
      executionId,
      createElectronExecutionRuntime().executionsDir,
    )) !== null
  );
}

export function registerHookPipelineQueueHost(
  getWindow: () => BrowserWindow | null,
): void {
  if (hookPipelineQueueHostRegistered) return;
  hookPipelineQueueHostRegistered = true;
  const host: HookQueueHost = {
    reserve(ref): void {
      recoveringHookPipelines.set(ref.queueId, {
        operationId: ref.operationId,
        recoveryOrder: nextRecoveryOrder++,
        abort: new AbortController(),
        cancelled: false,
      });
    },
    release(ref): void {
      recoveringHookPipelines.delete(ref.queueId);
      scheduleDrain();
    },
    async resume(ref, saved, released) {
      const reservation = recoveringHookPipelines.get(ref.queueId);
      if (!reservation || reservation.cancelled)
        return {
          status: 'invalidated',
          message: 'This queued workflow was cancelled.',
        };
      const payload = parseQueuedHookPipelinePayload(saved.payload);
      if (!payload)
        return {
          status: 'invalidated',
          message:
            "This queued hook work's saved details could not be read, so it was not run.",
        };
      const valid = await revalidateQueuedHookWork(
        ref.operation,
        saved.actionIndex,
        'pipeline',
        reservation.abort.signal,
      );
      if (valid.status === 'invalidated') return valid;
      if (
        valid.action.type !== 'pipeline' ||
        valid.action.source !== payload.action.source ||
        valid.action.id !== payload.action.id
      )
        return {
          status: 'invalidated',
          message:
            "This hook's action changed, so the queued work was not run.",
        };
      let resolved: ResolvedHookPipeline;
      try {
        resolved = await resolveHookPipeline({
          action: payload.action,
          cwd: payload.cwd,
        });
        if (resolved.pipelineId !== payload.pipelineId)
          throw new Error('The workflow identity changed.');
      } catch (error) {
        logMainProcessWarn(
          '[hook-pipeline] Could not load a queued workflow.',
          error,
        );
        return {
          status: 'invalidated',
          message:
            "This hook's workflow can no longer be loaded, so it was not run.",
        };
      }
      try {
        assertDispatchPipeline({
          inputDefinitions: getDispatchInputDefinitions({
            pipeline: resolved.pipeline.content,
            label: resolved.pipelineName,
          }),
          inputs: payload.inputs,
        });
      } catch (error) {
        logMainProcessWarn(
          '[hook-pipeline] Could not validate queued workflow inputs.',
          error,
        );
        return {
          status: 'invalidated',
          message: "This hook's workflow inputs changed, so it was not run.",
        };
      }
      if (reservation.cancelled || reservation.abort.signal.aborted)
        return {
          status: 'invalidated',
          message: 'This queued workflow was cancelled.',
        };
      const options = buildHookPipelineOptions({
        ...payload,
        resolved,
        modelConfig: withCodexSpeed(undefined, payload.codexSpeed),
      });
      const invocation = buildInvocation({
        ...payload,
        queueId: ref.queueId,
        resolved,
        options,
        getWindow,
      });
      invocation.operationId = ref.operationId;
      invocation.recoveryOrder = reservation.recoveryOrder;
      invocation.recovering = true;
      invocation.enqueuedAt = payload.enqueuedAt;
      const index = queuedHookPipelines.findIndex(
        (entry) =>
          entry.recoveryOrder === undefined ||
          entry.recoveryOrder > reservation.recoveryOrder,
      );
      queuedHookPipelines.splice(
        index < 0 ? queuedHookPipelines.length : index,
        0,
        invocation,
      );
      recoveringHookPipelines.delete(ref.queueId);
      void released.then((): void => {
        invocation.recovering = false;
        scheduleDrain();
      });
      emitQueueEvent(invocation, {
        type: 'queued',
        entry: toQueuedEntry(invocation),
      });
      return { status: 'queued' };
    },
    async reconcile(_ref, saved) {
      const payload = parseQueuedHookPipelinePayload(saved.payload);
      if (!payload) return { status: 'lost' };
      try {
        if (await hasPipelineExecutionState(payload.executionId))
          return {
            status: 'started',
            outcome: {
              kind: 'pipeline',
              executionId: payload.executionId,
              result: 'started',
            },
          };
      } catch (error) {
        logMainProcessWarn(
          '[hook-pipeline] Could not reconcile a queued workflow.',
          error,
        );
      }
      return { status: 'lost' };
    },
    cancel(ref): Promise<void> {
      const reservation = recoveringHookPipelines.get(ref.queueId);
      if (reservation) {
        reservation.cancelled = true;
        reservation.abort.abort();
        recoveringHookPipelines.delete(ref.queueId);
        scheduleDrain();
        return Promise.resolve();
      }
      const index = queuedHookPipelines.findIndex(
        (entry) => entry.queueId === ref.queueId,
      );
      const invocation = queuedHookPipelines[index];
      const executionId =
        invocation?.options.executionId ?? ref.operation.scope.executionId;
      if (
        ref.operation.status === 'running' ||
        invocation?.starting ||
        (executionId &&
          (isExecutionReservedBy(executionId, 'pipeline-start') ||
            getActiveExecutionHandle(executionId) !== undefined))
      )
        throw new OperationCancelRefusedError(
          'This workflow already started; stop the run itself.',
        );
      if (invocation) {
        queuedHookPipelines.splice(index, 1);
        invocation.cancelled = true;
        emitQueueEvent(invocation, { type: 'cancelled', queueId: ref.queueId });
        scheduleDrain();
      }
      return Promise.resolve();
    },
  };
  getHookQueue().registerHost('pipeline', host);
}

export function listQueuedHookPipelines(): ReturnType<typeof toQueuedEntry>[] {
  return queuedHookPipelines
    .filter((entry) => !entry.cancelled)
    .map((entry) => toQueuedEntry(entry));
}

export const hookPipelineTestExports: {
  resetQueueForTests: () => void;
  scheduleDrain: () => void;
} = {
  resetQueueForTests: (): void => {
    queuedHookPipelines.splice(0, queuedHookPipelines.length);
    drainChain = Promise.resolve();
    admissionChain = Promise.resolve();
    suppressActiveCountDrain = false;
    recoveringHookPipelines.clear();
  },
  scheduleDrain,
};

import {
  runHelperThroughWorker,
  linkHelperAbort,
} from '../helper-runs/helper-runs';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  DEFAULT_BRANCH_NAMING_SYSTEM_PROMPT,
  sanitizeBranchName,
} from '@canopy/protocol/worktree-branch-names';
import {
  WORKSPACE_ROOT_REPO_ID,
  getExecutionHarnessForModel,
  requireProviderForModel,
  type AgentModelConfig,
  type ChatModel,
  type AgentProviderType,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { type HelperAgentPluginRuntime } from '@canopy/desktop-shared/lib/helper-agent-plugins';
import { isDefaultWorktreeBranchName } from '@canopy/desktop-shared/lib/default-worktree-branch';
import {
  codexStructuredHelperRunner,
  runStructuredHelper,
  structuredHelperReportOnlyPermission,
} from '../integration/structured-helper-dispatch';
import {
  readLocalMemoryEnabledPreference,
  readPreferencesFile,
} from '../lib/preferences-store';
import { checkGitHubCliStatus } from './github-auth';
import type { HelperUsage } from '../agents/utils';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import type { BranchMatchResult } from './resolve-worktree';
import { doesBranchMatchWorktreeId } from './resolve-worktree';
import { isModelBlockedByStoredPolicy } from './model-policy-state';
import {
  appendBranchSuffix,
  doesOriginBranchExist,
  getCurrentBranch,
  isBranchNameAvailable,
  renameBranch,
  resolveSharedAvailableBranchName,
  validateBranchName,
} from './git';
import { hasGitHubPullRequestHistoryForBranch } from './github-pr';
import {
  resolveHelperInvocation,
  resolveHelperWorkOwner,
} from '../ollama/helper-invocation';
import { isHelperNoBillingSourceError } from '../agents/helper-no-billing-source';
import { markObservedHelperTaskAiCreditsRouted } from './helper-observed-task';
import { withResolvedHelperPlugins } from './helper-plugin-resolution';
import { recordWorktreeBranchChange } from './worktree-branch-watcher';
import {
  isTransientAgentRetryExhaustedError,
  type TransientAgentRetryNotice,
} from '@canopy/execution-engine/agent-failures';

const NO_TOOL_BRANCH_NAMING_INSTRUCTION =
  'Do not explore the repo, use tools, or connect to MCP servers.';

const HELPER_TOOL_BRANCH_NAMING_INSTRUCTION =
  'If helper tools or MCP servers are configured, you may use them only when needed to disambiguate the task; otherwise answer directly without exploring the repo.';
const BRANCH_NAME_COUNTER_RETRY_LIMIT = 5;
const BRANCH_NAME_UUID_RETRY_LIMIT = 5;
const BRANCH_NAME_UUID_SUFFIX_LENGTH = 8;
const BRANCH_NAMING_TIMEOUT_MS = 30_000;

const inFlightBranchNaming = new Set<string>();

interface BranchNameResponse {
  branchName: string;
}

const BRANCH_NAME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    branchName: { type: 'string' },
  },
  required: ['branchName'],
};

interface BranchNamingResult {
  branchName: string;
  usage: HelperUsage;
}

interface GenerateAndRenameBranchOptions {
  projectId: string;
  worktreeId: string;
  cwd: string;
  userMessage: string;
  branchResult: BranchMatchResult & { matches: true };
  observabilityTaskKey?: string;
  modelConfig?: AgentModelConfig;
  /** Owner inherited from the chat that queued this helper. */
  workOwner?: WorkOwner | null;
  /**
   * Persisted model already stamped by the caller on the audit entry. Optional
   * because direct entry points read the same normalized preference locally.
   */
  resolvedModel?: ChatModel;
  /** Window told about the recorded rename; absent when none is available. */
  getWindow?: () => BrowserWindow | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBranchNameResponse(value: unknown): value is BranchNameResponse {
  return isRecord(value) && typeof value.branchName === 'string';
}

function helperRuntimeAllowsBranchNamingTools(
  runtime: HelperAgentPluginRuntime,
): boolean {
  return (
    runtime.claudePlugins.length > 0 ||
    Object.keys(runtime.claudeMcpServers).length > 0
  );
}

function buildBranchNamingSystemPrompt(
  instructions: string,
  runtime: HelperAgentPluginRuntime,
): string {
  const toolInstruction = helperRuntimeAllowsBranchNamingTools(runtime)
    ? HELPER_TOOL_BRANCH_NAMING_INSTRUCTION
    : NO_TOOL_BRANCH_NAMING_INSTRUCTION;
  const basePrompt = `${DEFAULT_BRANCH_NAMING_SYSTEM_PROMPT} ${toolInstruction}`;
  const trimmedInstructions = instructions.trim();
  if (trimmedInstructions.length === 0) {
    return basePrompt;
  }

  return `${basePrompt}\n\nAdditional instructions:\n${trimmedInstructions}`;
}

function seedBranchNamingTranscript(
  taskKey: string | undefined,
  provider: AgentProviderType,
  originalText: string,
  submittedText: string,
  systemPrompt: string,
): void {
  if (!taskKey) {
    return;
  }

  const observabilityService = getExecutionObservabilityIngest();
  observabilityService.seedTranscript(taskKey, {
    provider,
    originalText,
    submittedText,
    planMode: false,
    injectedPrompts: [
      {
        kind: 'system_prompt_append',
        provider,
        applicationCondition: 'helper_task_system_prompt',
        text: systemPrompt,
      },
    ],
  });
}

function appendBranchNamingTranscriptEvent(
  taskKey: string | undefined,
  event: unknown,
): void {
  if (!taskKey) {
    return;
  }

  const observabilityService = getExecutionObservabilityIngest();
  observabilityService.appendTranscriptRecord(taskKey, event);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfBranchNamingAborted(abortController: AbortController): void {
  if (!abortController.signal.aborted) {
    return;
  }

  const reason: unknown = abortController.signal.reason;
  throw reason instanceof Error
    ? reason
    : new Error('Branch naming was aborted.');
}

interface BranchNamingDeadline {
  promise: Promise<never>;
  cancel: () => void;
  extendForRetry: (delayMs: number) => void;
}

function createBranchNamingDeadline(
  abortController: AbortController,
): BranchNamingDeadline {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: (error: Error) => void = () => undefined;
  let cancelled = false;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const schedule = (delayMs: number): void => {
    if (cancelled) return;
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      const error = new Error(
        `Branch naming timed out after ${BRANCH_NAMING_TIMEOUT_MS / 1_000} seconds.`,
      );
      abortController.abort(error);
      rejectDeadline(error);
    }, delayMs);
    timeout.unref();
  };
  schedule(BRANCH_NAMING_TIMEOUT_MS);
  function cancel(): void {
    cancelled = true;
    if (timeout) {
      clearTimeout(timeout);
    }
  }
  function extendForRetry(delayMs: number): void {
    schedule(delayMs + BRANCH_NAMING_TIMEOUT_MS);
  }
  return { promise, cancel, extendForRetry };
}

function truncateDiagnosticText(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function appendBranchNamingDiagnostic(
  taskKey: string | undefined,
  diagnostic: Record<string, unknown>,
): void {
  appendBranchNamingTranscriptEvent(taskKey, {
    ...diagnostic,
    type: 'canopy_helper_diagnostic',
    helper: 'branch_naming',
    timestamp: new Date().toISOString(),
  });
}

/**
 * Branch naming ships the user's task description to an explicitly configured
 * helper model (`preferences.branchNamingModel`), so it is subject to the same
 * organization model policy as an interactive chat turn. Being a non-interactive
 * background helper it refuses rather than silently substituting another model.
 *
 * The refusal degrades gracefully instead of throwing: the worktree simply keeps
 * the default `worktreeId` branch name it was created with, which is the same
 * end state as branch naming never having been attempted. Throwing here would
 * clear the one-time branch-prompt flag in the caller and re-run this refusal on
 * every subsequent chat message.
 */
const BRANCH_NAMING_MODEL_POLICY_REFUSAL =
  'Branch naming was skipped: this model is blocked by your organization policy.';

function recordBranchNamingPolicyRefusal(
  taskKey: string | undefined,
  model: string,
): void {
  appendBranchNamingDiagnostic(taskKey, {
    level: 'error',
    message: BRANCH_NAMING_MODEL_POLICY_REFUSAL,
    model,
  });
  if (!taskKey) {
    return;
  }

  // Finalized here rather than by the caller so the Audit Trail records the
  // refusal instead of a zero-token success. `finalizeObservedTask` is
  // idempotent, so the caller's later success finalize is a no-op.
  getExecutionObservabilityIngest().finalizeObservedTask(
    taskKey,
    'failure',
    BRANCH_NAMING_MODEL_POLICY_REFUSAL,
  );
}

export { sanitizeBranchName };

function sanitizeBranchPrefix(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '');
}

async function buildBranchPrefix(): Promise<string> {
  const preferences = await readPreferencesFile();

  if (preferences.branchNamePrefixMode === 'github') {
    const ghStatus = await checkGitHubCliStatus();
    if (!ghStatus.username) {
      return '';
    }

    const safeUsername = sanitizeBranchPrefix(ghStatus.username);
    return safeUsername.length > 0 ? `${safeUsername}/` : '';
  }

  if (preferences.branchNamePrefixMode === 'custom') {
    const safePrefix = sanitizeBranchPrefix(preferences.branchNameCustomPrefix);
    return safePrefix.length > 0 ? `${safePrefix}/` : '';
  }

  return '';
}

async function runClaudeBranchNamingQuery(
  cwd: string,
  projectId: string,
  userMessage: string,
  model: string,
  thinkingLevel: ThinkingLevel,
  systemPrompt: string,
  runtime: HelperAgentPluginRuntime,
  abortController: AbortController,
  workOwner?: WorkOwner | null,
  observabilityTaskKey?: string,
  onTransientRetry?: (notice: TransientAgentRetryNotice) => void,
): Promise<BranchNamingResult> {
  const submittedPrompt = `<task_description>${userMessage}</task_description>`;
  seedBranchNamingTranscript(
    observabilityTaskKey,
    requireProviderForModel(model),
    userMessage,
    submittedPrompt,
    systemPrompt,
  );
  // Guard resolves the same environment the spawn uses (`workspaceId: projectId`
  // below) — a workspace Environments assignment replaces the global one.
  const invocation = await resolveHelperInvocation(model, undefined, {
    signal: abortController.signal,
    ...(projectId !== undefined ? { workspaceId: projectId } : {}),
    ...(workOwner !== undefined ? { workOwner } : {}),
  });
  try {
    if (observabilityTaskKey) {
      markObservedHelperTaskAiCreditsRouted(
        observabilityTaskKey,
        invocation.aiCreditsRouted,
        invocation.accountProxyRouted === true,
      );
    }
    const helperResult = await runStructuredHelper({
      kind: 'branch_naming',
      label: 'Branch Naming',
      repoPath: cwd,
      model: invocation.sdkModel ?? model,
      provider: invocation.providerType === 'ollama' ? 'ollama' : 'claude',
      executionHarness: invocation.harness,
      maxTurns: 2,
      systemPrompt,
      userMessage: submittedPrompt,
      schema: BRANCH_NAME_SCHEMA,
      thinkingLevel,
      localMemoryEnabled: await readLocalMemoryEnabledPreference(),
      abortController,
      timeoutMs: BRANCH_NAMING_TIMEOUT_MS,
      workspaceId: projectId,
      claudeEnvOverride: invocation.envOverride,
      waitForQuotaRecovery: invocation.waitForQuotaRecovery,
      pluginRuntime: runtime,
      isResult: isBranchNameResponse,
      permission: structuredHelperReportOnlyPermission(),
      settingSources: [],
      // Account connectors (claude.ai Linear, Slack, ...) load regardless of
      // `settingSources`. A task such as "Read the full scope of the ticket"
      // then sends the model after tools it can never be granted, spending
      // every turn before it names anything. Selected plugins bring their own
      // MCP discovery, so the strict config applies only without them.
      ...(runtime.claudePlugins.length === 0 ? { strictMcpConfig: true } : {}),
      transcriptObserver: {
        seed: () => undefined,
        appendEvent: (event) =>
          appendBranchNamingTranscriptEvent(observabilityTaskKey, event),
        markAttempt: (attempt): void => {
          if (observabilityTaskKey) {
            getExecutionObservabilityIngest().updateObservedTask(
              observabilityTaskKey,
              {
                attempt,
              },
            );
          }
        },
        markSessionId: (sdkSessionId): void => {
          if (observabilityTaskKey) {
            getExecutionObservabilityIngest().updateObservedTask(
              observabilityTaskKey,
              {
                sdkSessionId,
              },
            );
          }
        },
      },
      onTransientRetry,
    });

    if (helperResult.value) {
      return {
        branchName: helperResult.value.branchName,
        usage: helperResult.usage,
      };
    }
    throw new Error(
      `${invocation.providerType === 'ollama' ? 'Ollama' : 'Claude'} branch naming returned no structured branchName`,
    );
  } finally {
    invocation.dispose?.();
  }
}

async function runCodexBranchNamingQuery(
  cwd: string,
  projectId: string,
  userMessage: string,
  model: string,
  thinkingLevel: ThinkingLevel,
  systemPrompt: string,
  runtime: HelperAgentPluginRuntime,
  abortController: AbortController,
  workOwner?: WorkOwner | null,
  observabilityTaskKey?: string,
  modelConfig?: AgentModelConfig,
  onTransientRetry?: (notice: TransientAgentRetryNotice) => void,
): Promise<BranchNamingResult> {
  const prompt = `${systemPrompt}\n\nUser task:\n${userMessage}\n\nRespond with ONLY a JSON object: {"branchName":"..."}`;
  const invocation = await resolveHelperInvocation(model, undefined, {
    signal: abortController.signal,
    workspaceId: projectId,
    ...(workOwner !== undefined ? { workOwner } : {}),
  });
  try {
    seedBranchNamingTranscript(
      observabilityTaskKey,
      invocation.providerType,
      userMessage,
      prompt,
      systemPrompt,
    );
    if (observabilityTaskKey) {
      markObservedHelperTaskAiCreditsRouted(
        observabilityTaskKey,
        invocation.aiCreditsRouted,
        invocation.accountProxyRouted === true,
      );
    }
    const result = await codexStructuredHelperRunner.run<BranchNameResponse>({
      repoPath: cwd,
      model: invocation.sdkModel ?? model,
      systemPrompt,
      userMessage,
      combinedPrompt: prompt,
      schema: BRANCH_NAME_SCHEMA,
      thinkingLevel,
      modelConfig,
      workspaceId: projectId,
      localMemoryEnabled: await readLocalMemoryEnabledPreference(),
      pluginRuntime: runtime,
      codexConfigOverride: invocation.codexConfig,
      waitForQuotaRecovery: invocation.waitForQuotaRecovery,
      abortController,
      transcriptObserver: observabilityTaskKey
        ? {
            seed: (): void => undefined,
            appendEvent: (event): void =>
              appendBranchNamingTranscriptEvent(observabilityTaskKey, event),
            markAttempt: (attempt): void =>
              getExecutionObservabilityIngest().updateObservedTask(
                observabilityTaskKey,
                {
                  attempt,
                },
              ),
            markSessionId: (sdkSessionId): void =>
              getExecutionObservabilityIngest().updateObservedTask(
                observabilityTaskKey,
                {
                  sdkSessionId,
                },
              ),
          }
        : undefined,
      isResult: isBranchNameResponse,
      onTransientRetry,
    });
    if (!result.value) {
      throw new Error('Codex branch naming returned invalid structured output');
    }
    return { branchName: result.value.branchName, usage: result.usage };
  } finally {
    invocation.dispose?.();
  }
}

interface GenerateBranchNameResult {
  branchName: string;
  usage: HelperUsage;
}

async function generateBranchName(
  cwd: string,
  projectId: string,
  userMessage: string,
  model: string,
  thinkingLevel: ThinkingLevel,
  instructions: string,
  runtime: HelperAgentPluginRuntime,
  abortController: AbortController,
  workOwner?: WorkOwner | null,
  observabilityTaskKey?: string,
  modelConfig?: AgentModelConfig,
  onTransientRetry?: (notice: TransientAgentRetryNotice) => void,
): Promise<GenerateBranchNameResult> {
  const systemPrompt = buildBranchNamingSystemPrompt(instructions, runtime);
  const useCodex = getExecutionHarnessForModel(model) === 'codex';
  let lastFailure: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfBranchNamingAborted(abortController);
    try {
      const result = useCodex
        ? await runCodexBranchNamingQuery(
            cwd,
            projectId,
            userMessage,
            model,
            thinkingLevel,
            systemPrompt,
            runtime,
            abortController,
            workOwner,
            observabilityTaskKey,
            modelConfig,
            onTransientRetry,
          )
        : await runClaudeBranchNamingQuery(
            cwd,
            projectId,
            userMessage,
            model,
            thinkingLevel,
            systemPrompt,
            runtime,
            abortController,
            workOwner,
            observabilityTaskKey,
            onTransientRetry,
          );

      throwIfBranchNamingAborted(abortController);
      const sanitizedBranchName = sanitizeBranchName(result.branchName);
      if (sanitizedBranchName) {
        return { branchName: sanitizedBranchName, usage: result.usage };
      }
      lastFailure = `Provider returned an invalid branchName after sanitization: ${truncateDiagnosticText(result.branchName)}`;
      appendBranchNamingDiagnostic(observabilityTaskKey, {
        level: 'warning',
        attempt: attempt + 1,
        message: lastFailure,
      });
    } catch (error) {
      throwIfBranchNamingAborted(abortController);
      // A signed-out provider with no billing source never started, and a
      // second attempt would be refused the same way (CAN-7062).
      if (
        isTransientAgentRetryExhaustedError(error) ||
        isHelperNoBillingSourceError(error)
      ) {
        throw error;
      }
      lastFailure = errorMessage(error);
      appendBranchNamingDiagnostic(observabilityTaskKey, {
        level: 'error',
        attempt: attempt + 1,
        message: lastFailure,
      });
    }
  }

  throw new Error(
    lastFailure
      ? `Failed to generate a valid branch name. Last failure: ${lastFailure}`
      : 'Failed to generate a valid branch name',
  );
}

function getInFlightKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function getMatchingRepoPath(cwd: string, repoId: string): string {
  return repoId === WORKSPACE_ROOT_REPO_ID ? cwd : join(cwd, 'repos', repoId);
}

function getTargetRepoPaths(
  cwd: string,
  branchResult: BranchMatchResult & { matches: true },
): string[] {
  if (!branchResult.matchingRepos || branchResult.matchingRepos.length === 0) {
    return [cwd];
  }

  return branchResult.matchingRepos.map((repoId) =>
    getMatchingRepoPath(cwd, repoId),
  );
}

async function getReusableSharedBranchName(
  cwd: string,
  worktreeId: string,
  branchResult: BranchMatchResult & { matches: true },
): Promise<string | null> {
  if (!branchResult.matchingRepos || branchResult.matchingRepos.length === 0) {
    return null;
  }

  const reposDir = join(cwd, 'repos');
  const entries = await readdir(reposDir, { withFileTypes: true });
  const targetRepos = new Set(branchResult.matchingRepos);
  const candidateBranches = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory() || targetRepos.has(entry.name)) {
      continue;
    }

    const branchName = await getCurrentBranch(join(reposDir, entry.name)).catch(
      () => '',
    );
    if (
      branchName.length === 0 ||
      isDefaultWorktreeBranchName(branchName, worktreeId)
    ) {
      continue;
    }

    candidateBranches.add(branchName);
  }

  if (candidateBranches.size !== 1) {
    return null;
  }

  const sharedBranchName = Array.from(candidateBranches)[0];
  return sharedBranchName ?? null;
}

function applyBranchPrefix(prefix: string, branchName: string): string {
  return prefix.length > 0 ? `${prefix}${branchName}` : branchName;
}

function appendPartialUuidSuffix(branchName: string): string {
  const suffix = `-${randomUUID().replace(/-/g, '').slice(0, BRANCH_NAME_UUID_SUFFIX_LENGTH)}`;
  const maxBaseLength = Math.max(1, 100 - suffix.length);
  return `${branchName.slice(0, maxBaseLength)}${suffix}`;
}

function buildBranchNameRetryCandidates(
  branchName: string,
  counterStart = 2,
): string[] {
  const candidates = [branchName];

  for (
    let i = counterStart;
    i < counterStart + BRANCH_NAME_COUNTER_RETRY_LIMIT;
    i += 1
  ) {
    candidates.push(appendBranchSuffix(branchName, i));
  }

  for (let i = 0; i < BRANCH_NAME_UUID_RETRY_LIMIT; i += 1) {
    candidates.push(appendPartialUuidSuffix(branchName));
  }

  return candidates;
}

function getBranchSuffixNumber(
  baseBranchName: string,
  branchName: string,
): number | null {
  const suffixMatch = branchName.match(/-(\d+)$/);
  if (!suffixMatch) {
    return null;
  }

  const suffixNumber = Number.parseInt(suffixMatch[1], 10);
  if (!Number.isSafeInteger(suffixNumber)) {
    return null;
  }

  return appendBranchSuffix(baseBranchName, suffixNumber) === branchName
    ? suffixNumber
    : null;
}

function buildRemoteSafeBranchNameRetryCandidates(
  preferredBranchName: string,
  locallyAvailableBranchName: string,
): string[] {
  const localSuffixNumber = getBranchSuffixNumber(
    preferredBranchName,
    locallyAvailableBranchName,
  );
  const counterStart = localSuffixNumber ? localSuffixNumber + 1 : 2;
  const candidates = [locallyAvailableBranchName];

  for (const candidate of buildBranchNameRetryCandidates(
    preferredBranchName,
    counterStart,
  )) {
    if (
      candidate === locallyAvailableBranchName ||
      (candidate === preferredBranchName &&
        locallyAvailableBranchName !== preferredBranchName)
    ) {
      continue;
    }

    candidates.push(candidate);
  }

  return candidates;
}

async function hasRemoteBranchNameConflict(
  repoPath: string,
  branchName: string,
): Promise<boolean> {
  if (await doesOriginBranchExist(repoPath, branchName)) {
    return true;
  }

  return hasGitHubPullRequestHistoryForBranch(repoPath, branchName);
}

async function isBranchNameAvailableAcrossRepos(
  targetRepoPaths: string[],
  branchName: string,
): Promise<boolean> {
  const localAvailability = await Promise.all(
    targetRepoPaths.map((repoPath) =>
      isBranchNameAvailable(repoPath, branchName),
    ),
  );
  if (!localAvailability.every(Boolean)) {
    return false;
  }

  const remoteConflicts = await Promise.all(
    targetRepoPaths.map((repoPath) =>
      hasRemoteBranchNameConflict(repoPath, branchName),
    ),
  );
  return !remoteConflicts.some(Boolean);
}

async function resolveRemoteSafeBranchName(
  targetRepoPaths: string[],
  preferredBranchName: string,
  locallyAvailableBranchName: string,
): Promise<string | null> {
  for (const candidate of buildRemoteSafeBranchNameRetryCandidates(
    preferredBranchName,
    locallyAvailableBranchName,
  )) {
    if (await isBranchNameAvailableAcrossRepos(targetRepoPaths, candidate)) {
      return candidate;
    }
  }

  return null;
}

async function resolveFinalBranchName(
  targetRepoPaths: string[],
  preferredBranchName: string,
  reuseExistingSharedBranch: boolean,
): Promise<string> {
  if (reuseExistingSharedBranch) {
    const validationResults = await Promise.all(
      targetRepoPaths.map(async (repoPath) => {
        const isValid = await validateBranchName(repoPath, preferredBranchName);
        if (!isValid) {
          return false;
        }

        return isBranchNameAvailable(repoPath, preferredBranchName);
      }),
    );

    if (!validationResults.every(Boolean)) {
      throw new Error('Unable to reuse existing shared branch name');
    }

    return preferredBranchName;
  }

  const locallyAvailableBranchName = await resolveSharedAvailableBranchName(
    targetRepoPaths,
    preferredBranchName,
  );
  if (!locallyAvailableBranchName) {
    throw new Error('Unable to resolve an available branch name');
  }

  const remoteSafeBranchName = await resolveRemoteSafeBranchName(
    targetRepoPaths,
    preferredBranchName,
    locallyAvailableBranchName,
  );
  if (!remoteSafeBranchName) {
    throw new Error('Unable to resolve an available branch name');
  }

  return remoteSafeBranchName;
}

function stillMatchesTargetRepos(
  branchResult: BranchMatchResult,
  targetRepos: string[] | undefined,
): boolean {
  if (!branchResult.matches) {
    return false;
  }

  if (!targetRepos || targetRepos.length === 0) {
    return true;
  }

  if (!branchResult.matchingRepos) {
    return false;
  }

  return branchResult.matchingRepos.some((repo) => targetRepos.includes(repo));
}

/**
 * Records the app's own rename instead of relying on a HEAD watcher being
 * attached to the new checkout. A failed record never fails the rename. A
 * failed write is caught up by the checkout's next watcher start, which is the
 * next launch when a watcher is already running.
 */
async function recordBranchRename(
  options: GenerateAndRenameBranchOptions,
  branchName: string,
  renamedRepoIds: readonly string[] | undefined,
): Promise<void> {
  const getWindow = options.getWindow ?? ((): BrowserWindow | null => null);
  const repoIds: ReadonlyArray<string | undefined> = renamedRepoIds ?? [
    undefined,
  ];
  for (const repoId of repoIds) {
    await recordWorktreeBranchChange(
      {
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        branchName,
        ...(repoId ? { repoId } : {}),
      },
      getWindow,
    ).catch(() => undefined);
  }
}

/**
 * Attempt `git branch -m` with the resolved name, retrying with five numeric
 * suffixes and five partial UUID suffixes when a conflict prevents the rename.
 * After all attempts are
 * exhausted the function throws so the caller can reset the one-time flag and
 * allow a future chat to retry.
 */
async function renameWithRetry(
  options: GenerateAndRenameBranchOptions,
  baseBranchName: string,
): Promise<void> {
  let lastError: unknown;
  let renamedRepoIds: string[] | undefined;

  for (const candidateName of buildBranchNameRetryCandidates(baseBranchName)) {
    try {
      if (options.branchResult.matchingRepos) {
        const renameResults = await Promise.allSettled(
          options.branchResult.matchingRepos.map((repoId) =>
            renameBranch(
              getMatchingRepoPath(options.cwd, repoId),
              candidateName,
            ),
          ),
        );
        if (renameResults.every((result) => result.status === 'rejected')) {
          const firstRejected = renameResults.find(
            (r): r is PromiseRejectedResult => r.status === 'rejected',
          );
          throw firstRejected?.reason ?? new Error('All repos failed');
        }
        renamedRepoIds = options.branchResult.matchingRepos.filter(
          (_repoId, index) => renameResults[index]?.status === 'fulfilled',
        );
      } else {
        await renameBranch(options.cwd, candidateName);
        renamedRepoIds = undefined;
      }

      // Verify the target repos no longer carry the worktree-id branch name.
      const postCheck = await doesBranchMatchWorktreeId(
        options.projectId,
        options.worktreeId,
        options.cwd,
      );
      if (
        stillMatchesTargetRepos(postCheck, options.branchResult.matchingRepos)
      ) {
        throw new Error('One or more target repos still match the worktree id');
      }

      await recordBranchRename(options, candidateName, renamedRepoIds);
      return; // rename succeeded
    } catch (err: unknown) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to rename branch after suffixed retry attempts');
}

interface PreparedBranchNaming {
  branchPrefix: string;
  branchUsage: HelperUsage;
  generatedBranchName: string;
  reusableSharedBranchName: string | null;
}

/** `null` when an organization model policy blocked the configured model. */
async function prepareBranchNaming(
  options: GenerateAndRenameBranchOptions,
  abortController: AbortController,
  onTransientRetry: (notice: TransientAgentRetryNotice) => void,
): Promise<PreparedBranchNaming | null> {
  const preferences = await readPreferencesFile();
  const branchPrefix = await buildBranchPrefix();
  const reusableSharedBranchName = await getReusableSharedBranchName(
    options.cwd,
    options.worktreeId,
    options.branchResult,
  );

  let branchUsage: HelperUsage = {};
  let generatedBranchName: string;
  if (reusableSharedBranchName) {
    // Reusing a sibling repo's existing branch name never contacts a model, so
    // the org policy gate deliberately does not apply to this path.
    generatedBranchName = reusableSharedBranchName;
  } else {
    // The caller passes the same persisted model it stamps on the audit entry.
    // Direct callers use the normalized persisted preference here as well.
    const branchNamingModel =
      options.resolvedModel ?? preferences.branchNamingModel;
    const workOwner = await resolveHelperWorkOwner({
      workspaceId: options.projectId,
    });
    if (await isModelBlockedByStoredPolicy(branchNamingModel, workOwner)) {
      recordBranchNamingPolicyRefusal(
        options.observabilityTaskKey,
        branchNamingModel,
      );
      return null;
    }

    const result = await runHelperThroughWorker({
      kind: 'branch_naming',
      model: branchNamingModel,
      scope: { workspaceId: options.projectId, worktreeId: options.worktreeId },
      origin: 'system',
      workOwner,
      signal: abortController.signal,
      launch: async (workerSignal) => {
        const unlink = linkHelperAbort(workerSignal, abortController);
        try {
          return await withResolvedHelperPlugins(
            {
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              helperName: 'branch-namer',
              model: branchNamingModel,
              selections: preferences.branchNamingPluginSelections,
            },
            (runtime) =>
              generateBranchName(
                options.cwd,
                options.projectId,
                options.userMessage,
                branchNamingModel,
                preferences.branchNamingThinkingLevel,
                preferences.branchNamingInstructions,
                runtime,
                abortController,
                Object.prototype.hasOwnProperty.call(options, 'workOwner')
                  ? (options.workOwner ?? null)
                  : undefined,
                options.observabilityTaskKey,
                options.modelConfig,
                onTransientRetry,
              ),
          );
        } finally {
          unlink();
        }
      },
      usageOf: (result) => result.usage,
    });
    generatedBranchName = result.branchName;
    branchUsage = result.usage;
  }

  return {
    branchPrefix,
    branchUsage,
    generatedBranchName,
    reusableSharedBranchName,
  };
}

async function performBranchNaming(
  options: GenerateAndRenameBranchOptions,
): Promise<HelperUsage> {
  const abortController = new AbortController();
  const deadline = createBranchNamingDeadline(abortController);

  let prepared: PreparedBranchNaming | null;
  try {
    prepared = await Promise.race([
      prepareBranchNaming(options, abortController, (notice) =>
        deadline.extendForRetry(notice.delayMs),
      ),
      deadline.promise,
    ]);
  } finally {
    deadline.cancel();
  }

  if (prepared === null) {
    // Org policy refusal: leave the worktree on its default branch name.
    return {};
  }

  throwIfBranchNamingAborted(abortController);

  const preferredBranchName =
    prepared.reusableSharedBranchName ??
    applyBranchPrefix(prepared.branchPrefix, prepared.generatedBranchName);
  const targetRepoPaths = getTargetRepoPaths(options.cwd, options.branchResult);
  const finalBranchName = await resolveFinalBranchName(
    targetRepoPaths,
    preferredBranchName,
    prepared.reusableSharedBranchName !== null,
  );

  await renameWithRetry(options, finalBranchName);
  return prepared.branchUsage;
}

export async function generateAndRenameBranch(
  options: GenerateAndRenameBranchOptions,
): Promise<HelperUsage> {
  const inFlightKey = getInFlightKey(options.projectId, options.worktreeId);
  if (inFlightBranchNaming.has(inFlightKey)) {
    return {};
  }

  inFlightBranchNaming.add(inFlightKey);

  try {
    return await performBranchNaming(options);
  } finally {
    inFlightBranchNaming.delete(inFlightKey);
  }
}

import {
  runHelperThroughWorker,
  linkHelperAbort,
} from '../helper-runs/helper-runs';
import {
  clampThinkingLevelForModel,
  getExecutionHarnessForModel,
  getModelSource,
  type AgentModelConfig,
  type AiCreditsRoutingMode,
  type ChatModel,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import { classifyAgentFailure } from '@canopy/execution-engine/agent-failures';
import { detectClaudeQuotaReached } from '@canopy/desktop-shared/remote-control/provider-usage-limit';
import type { HelperTranscriptObserver } from '@canopy/desktop-shared/lib/helper-transcript';
import {
  generateCommitMessageWithUsage,
  type GenerateCommitMessageOptions,
} from '@canopy/desktop-shared/lib/commit-message-generator';
import {
  formatBranchAsTitle,
  getStructuredHelperQueryErrorUsage,
} from '@canopy/desktop-shared/lib/structured-helper-query';
import {
  resolveHelperInvocation,
  resolveHelperWorkOwner,
  type HelperInvocation,
} from '../ollama/helper-invocation';
import { markProviderQuotaReached } from '../agents/ai-credits-quota-state';
import {
  isHelperNoBillingSourceError,
  type HelperNoBillingSourceProvider,
} from '../agents/helper-no-billing-source';
import {
  isGatewayOnlyModel,
  resolveGatewayModelEntry,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { isDemotedForQuota } from './commit-generation-model-candidates';
import { logMainProcessWarn } from './main-process-logging';
import { isModelBlockedByStoredPolicy } from './model-policy-state';
import {
  buildHelperPluginRunOptions,
  finalizeObservedHelperTask,
  markObservedHelperTaskAiCreditsRouted,
  startObservedHelperTask,
  type HelperAuditContext,
} from './helper-observed-task';
import { createHelperTranscriptObserver } from './helper-transcript-observer';
import { runWithOptionalHelperPlugins } from './helper-plugin-resolution';
import { readLocalMemoryEnabledPreference } from './preferences-store';
import {
  codexStructuredHelperRunner,
  createStructuredHelperRunner,
  structuredHelperReadOnlyPermission,
} from '../integration/structured-helper-dispatch';

export type { GenerateCommitMessageOptions } from '@canopy/desktop-shared/lib/commit-message-generator';

export interface GenerateCommitMessageAuditContext extends HelperAuditContext {
  chatId?: string;
}

/**
 * Commit message generation ships the working-tree diff to an explicitly
 * configured helper model, so an organization model policy applies here exactly
 * as it does to an interactive chat turn. A blocked candidate is refused (and
 * recorded) before any diff leaves the machine; the chain then advances to the
 * next explicitly ordered candidate, which is gated the same way.
 */
const COMMIT_MESSAGE_MODEL_POLICY_REFUSAL =
  'Commit message generation was skipped: this model is blocked by your organization policy.';

const COMMIT_MESSAGE_NO_USABLE_RESULT =
  'Commit message generation failed: the model returned no usable message.';

/**
 * Fixed wall clock for one candidate attempt, including the shared
 * generator's retry. A provider that hangs past it is abandoned and the chain
 * moves to the next model, so a stuck lane cannot hold up the git action. A
 * lone candidate has no next model and keeps its existing (unbounded) wait.
 */
export const COMMIT_MESSAGE_ATTEMPT_TIMEOUT_MS = 30_000;

const COMMIT_MESSAGE_ATTEMPT_TIMEOUT =
  'Commit message generation timed out after 30 seconds.';

export interface GenerateObservedCommitMessageOptions extends Omit<
  GenerateCommitMessageOptions,
  'localMemoryEnabled'
> {
  auditContext?: GenerateCommitMessageAuditContext;
  pluginSelections?: ChatTabPluginSelections;
  modelConfig?: AgentModelConfig;
  /**
   * Models tried in order after `model` fails (CAN-3866). Built by
   * `resolveCommitGenerationModelCandidates`; already deduped and filtered.
   */
  fallbackModels?: ChatModel[];
  /** From the resolved plan; decides whether a quota-limited lane is deferred. */
  aiCreditsRoutingMode?: AiCreditsRoutingMode;
}

type CommitMessageAttemptOutcome =
  | { outcome: 'success'; message: string }
  | { outcome: 'failed' }
  /**
   * Not started: the provider is signed out with no billing source
   * (CAN-7062). The chain passes over that provider's later candidates.
   */
  | { outcome: 'refused'; provider: HelperNoBillingSourceProvider };

/**
 * Whether a candidate would be refused the same way as an earlier candidate
 * whose provider had no billing source (CAN-7062). Ollama models never route,
 * and gateway-only or organization gateway models route instead of refusing,
 * so those still run.
 */
function sharesNoBillingSourceRefusal(
  model: ChatModel,
  refusedProviders: ReadonlySet<HelperNoBillingSourceProvider>,
): boolean {
  if (refusedProviders.size === 0 || getModelSource(model) === 'ollama') {
    return false;
  }
  if (
    isGatewayOnlyModel(model) ||
    resolveGatewayModelEntry(model)?.origin === 'org-gateway'
  ) {
    return false;
  }
  const harness = getExecutionHarnessForModel(model);
  return (
    (harness === 'claude' || harness === 'codex') &&
    refusedProviders.has(harness)
  );
}

/**
 * Generate a commit message, walking `model` then `fallbackModels` until one
 * candidate produces a usable message (CAN-3866).
 *
 * Commit-message generation is a background helper serving a git action, so
 * a helper failure never aborts that action: every candidate failure (policy
 * refusal, invocation or provider error, usage limit, or an unusable model
 * result) is recorded as its own audit entry and the chain advances. An
 * unknown/stale id has no provider to attribute an entry to, so it is logged
 * and skipped. A candidate whose provider is signed out with no billing
 * source (CAN-7062) is not started and its entry is `cancelled`; later
 * candidates on that provider are passed over before they open an entry,
 * while candidates on another provider still run. Once every candidate has
 * failed the branch name is returned as a plain-text title.
 *
 * Contract: resolves in every case except cancellation. When the caller's
 * abort controller fires, the abort error is rethrown and no further candidate
 * starts. When the chain has fallbacks, every attempt (the last one included)
 * is also bounded by `COMMIT_MESSAGE_ATTEMPT_TIMEOUT_MS`: a hung provider is
 * aborted, recorded as a failed attempt, and the chain advances.
 */
export async function generateCommitMessage(
  options: GenerateObservedCommitMessageOptions,
): Promise<string> {
  const {
    fallbackModels = [],
    aiCreditsRoutingMode,
    ...attemptOptions
  } = options;
  let attemptIndex = 0;
  const refusedProviders = new Set<HelperNoBillingSourceProvider>();
  const tryCandidate = async (model: ChatModel): Promise<string | null> => {
    options.abortController?.signal.throwIfAborted();
    if (sharesNoBillingSourceRefusal(model, refusedProviders)) {
      return null;
    }
    const attempt = await attemptCommitMessageWithModel(
      model,
      attemptOptions,
      attemptIndex++,
      fallbackModels.length === 0,
    );
    if (attempt.outcome === 'refused') {
      refusedProviders.add(attempt.provider);
    }
    return attempt.outcome === 'success' ? attempt.message : null;
  };
  // A native usage limit found earlier in this chain marks that lane; defer
  // its remaining candidates behind the rest instead of retrying the
  // exhausted lane next. Deferred candidates still run, so the chain keeps
  // every slot it was given.
  const deferred: ChatModel[] = [];
  for (const model of [options.model, ...fallbackModels]) {
    if (isDemotedForQuota(model, aiCreditsRoutingMode)) {
      deferred.push(model);
      continue;
    }
    const message = await tryCandidate(model);
    if (message !== null) {
      return message;
    }
  }
  for (const model of deferred) {
    const message = await tryCandidate(model);
    if (message !== null) {
      return message;
    }
  }
  // A cancel that landed during the final attempt still rejects.
  options.abortController?.signal.throwIfAborted();
  return formatBranchAsTitle(options.branchName);
}

interface AttemptDeadline {
  /** Rejects once the attempt's wall clock runs out. */
  readonly promise: Promise<never>;
  readonly timedOut: () => boolean;
  readonly clear: () => void;
}

const NO_ATTEMPT_DEADLINE: AttemptDeadline = {
  promise: new Promise<never>(() => undefined),
  timedOut: () => false,
  clear: () => undefined,
};

/** Abort `controller` and reject once the per-attempt wall clock runs out. */
function startAttemptDeadline(controller: AbortController): AttemptDeadline {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new Error(COMMIT_MESSAGE_ATTEMPT_TIMEOUT);
      controller.abort(error);
      reject(error);
    }, COMMIT_MESSAGE_ATTEMPT_TIMEOUT_MS);
  });
  // Raced, never awaited alone: keep an unraced rejection from going unhandled.
  promise.catch(() => undefined);
  return {
    promise,
    timedOut: () => timedOut,
    clear: () => clearTimeout(timer),
  };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a failed attempt as a provider usage limit, for either provider.
 * The generic HTTP 429 branch also matches short per-minute throttling, so it
 * counts only with the quota signal chat sessions use. Codex limits arrive as
 * their own codes (`rate_limit`, `usage_limit_exceeded`, `credits_depleted`)
 * and still count; a bare 429 does not.
 */
function classifyUsageLimit(
  invocation: HelperInvocation,
  model: ChatModel,
  events: readonly unknown[],
  error: unknown,
): ReturnType<typeof classifyAgentFailure> {
  const provider = invocation.providerType;
  const classification = classifyAgentFailure({
    provider,
    model: invocation.sdkModel ?? model,
    accountScope: invocation.aiCreditsRouted ? 'ai_credits' : 'native',
    events,
    error,
  });
  if (classification?.kind !== 'provider_usage_limit') {
    return null;
  }
  if (
    classification.code === 'http_429' &&
    !(provider === 'claude' && events.some(detectClaudeQuotaReached))
  ) {
    return null;
  }
  return classification;
}

/**
 * Mark the native provider lane quota-limited when a failed attempt was a
 * usage limit, so later helpers and `on-quota` routing skip it. A limit hit
 * through AI Credits routing says nothing about the native login and must not
 * mark it.
 */
function recordNativeUsageLimit(
  invocation: HelperInvocation,
  model: ChatModel,
  events: readonly unknown[],
  error: unknown,
): void {
  // A pooled account-proxy account's limit is not the user's own native
  // quota (CAN-4020); chat sessions never mark it either.
  if (invocation.accountProxyRouted === true) {
    return;
  }
  const provider = invocation.providerType;
  const classification = classifyUsageLimit(invocation, model, events, error);
  if (classification?.account_scope !== 'native') {
    return;
  }
  const resetsAt = classification.resets_at
    ? Date.parse(classification.resets_at)
    : undefined;
  markProviderQuotaReached(provider, resetsAt);
}

async function attemptCommitMessageWithModel(
  model: ChatModel,
  options: Omit<
    GenerateObservedCommitMessageOptions,
    'fallbackModels' | 'aiCreditsRoutingMode'
  >,
  attemptIndex: number,
  /**
   * An account-proxy route waits for a pooled account to recover instead of
   * failing on a usage limit. Only a lone candidate may wait; with fallbacks
   * the limit must surface so the chain can advance.
   */
  allowQuotaWait: boolean,
): Promise<CommitMessageAttemptOutcome> {
  const taskKey = `helper:commit-message:${options.repoPath}:${Date.now()}:${attemptIndex}`;
  const auditContext = options.auditContext;
  try {
    startObservedHelperTask({
      taskKey,
      eventType: 'commit_message_generation',
      label: 'Commit Message',
      model,
      modelConfig: options.modelConfig,
      auditContext,
      chatId: auditContext?.chatId,
    });
  } catch (error) {
    // An unknown/stale model id has no provider to attribute an audit entry
    // to; skip the candidate rather than failing the git action.
    logMainProcessWarn(
      `[commit-message] Skipping commit message model ${model}: ${errorDetail(error)}`,
    );
    return { outcome: 'failed' };
  }

  // Resolved once and used for BOTH the routing guard and the spawn below, so
  // the user-supplied-credential check reads the same Canopy Environments
  // assignment the helper actually runs with. A workspace assignment replaces
  // the global one, so a mismatch here can miss a per-workspace provider key
  // and bill AI Credits around it (ECW-9091).
  const effectiveWorkspaceId = options.workspaceId ?? auditContext?.projectId;

  // Raw provider events for this attempt. The shared generator swallows
  // per-attempt errors and non-transient errors surface without their
  // classification, so a usage limit is only recognizable from the events.
  const events: unknown[] = [];
  let invocation: HelperInvocation | undefined;
  // The attempt runs on its own controller: the caller's cancel and the
  // per-attempt deadline both abort it, but only a caller cancel rejects.
  const callerSignal = options.abortController?.signal;
  const attemptController = new AbortController();
  const forwardCallerAbort = (): void =>
    attemptController.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    forwardCallerAbort();
  } else {
    callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });
  }
  // Bounded whenever the chain has fallbacks (its last attempt included, so
  // nothing in a multi-model chain can hang); a lone model keeps its wait.
  const deadline = allowQuotaWait
    ? NO_ATTEMPT_DEADLINE
    : startAttemptDeadline(attemptController);
  // A timed-out attempt may still settle later; only the first outcome is
  // recorded.
  let finalized = false;
  const finalizeAttempt = (
    ...args: Parameters<typeof finalizeObservedHelperTask> extends [
      string,
      ...infer Rest,
    ]
      ? Rest
      : never
  ): void => {
    if (finalized) {
      return;
    }
    finalized = true;
    finalizeObservedHelperTask(taskKey, ...args);
  };
  try {
    const work = (async (): Promise<CommitMessageAttemptOutcome> => {
      // Gated before any provider resolution so no diff content leaves the
      // machine. Inside the try so a failed owner/policy read finalizes this
      // attempt and advances the chain instead of rejecting the git action.
      const workOwner = await resolveHelperWorkOwner({
        ...(effectiveWorkspaceId ? { workspaceId: effectiveWorkspaceId } : {}),
      });
      if (await isModelBlockedByStoredPolicy(model, workOwner)) {
        finalizeAttempt('failure', COMMIT_MESSAGE_MODEL_POLICY_REFUSAL);
        return { outcome: 'failed' };
      }

      const resolvedInvocation = await resolveHelperInvocation(
        model,
        undefined,
        {
          signal: attemptController.signal,
          ...(effectiveWorkspaceId !== undefined
            ? { workspaceId: effectiveWorkspaceId }
            : {}),
        },
      );
      if (deadline.timedOut()) {
        // The attempt was already abandoned; release what resolved late.
        resolvedInvocation.dispose?.();
        return { outcome: 'failed' };
      }
      invocation = resolvedInvocation;
      markObservedHelperTaskAiCreditsRouted(
        taskKey,
        resolvedInvocation.aiCreditsRouted,
        resolvedInvocation.accountProxyRouted === true,
      );
      // Local memory is opt-in; only an enabled preference suppresses
      // harness-native memory on the helper launch (CAN-1969).
      const localMemoryEnabled = await readLocalMemoryEnabledPreference();
      const auditObserver = createHelperTranscriptObserver(taskKey);
      const transcriptObserver: HelperTranscriptObserver = {
        ...auditObserver,
        appendEvent: (event) => {
          events.push(event);
          return auditObserver.appendEvent(event);
        },
      };
      const result = await runHelperThroughWorker({
        kind: 'commit_message_generation',
        model,
        scope: {
          ...(effectiveWorkspaceId !== undefined
            ? { workspaceId: effectiveWorkspaceId }
            : {}),
          ...(auditContext?.worktreeId !== undefined
            ? { worktreeId: auditContext.worktreeId }
            : {}),
          ...(auditContext?.chatId !== undefined
            ? { chatId: auditContext.chatId }
            : {}),
        },
        origin: 'client',
        workOwner,
        signal: attemptController.signal,
        launch: async (workerSignal) => {
          const unlink = linkHelperAbort(workerSignal, attemptController);
          try {
            return await runWithOptionalHelperPlugins(
              buildHelperPluginRunOptions({
                helperName: 'commit-message',
                model,
                pluginSelections: options.pluginSelections,
                auditContext,
              }),
              (pluginRuntime) =>
                generateCommitMessageWithUsage(
                  {
                    ...options,
                    abortController: attemptController,
                    localMemoryEnabled,
                    model: resolvedInvocation.sdkModel ?? model,
                    thinkingLevel: options.thinkingLevel
                      ? clampThinkingLevelForModel(
                          options.thinkingLevel,
                          resolvedInvocation.resolvedModel ?? model,
                          undefined,
                          resolvedInvocation.aiCreditsRouted,
                        )
                      : undefined,
                    workspaceId: effectiveWorkspaceId,
                    claudeEnvOverride: {
                      ...options.claudeEnvOverride,
                      ...resolvedInvocation.envOverride,
                    },
                    ...(resolvedInvocation.codexConfig
                      ? { codexConfigOverride: resolvedInvocation.codexConfig }
                      : {}),
                    executionHarness: resolvedInvocation.harness,
                    waitForQuotaRecovery: allowQuotaWait
                      ? resolvedInvocation.waitForQuotaRecovery
                      : undefined,
                    // With other candidates left, a usage limit advances the chain
                    // rather than spending a second try on the exhausted lane.
                    ...(allowQuotaWait
                      ? {}
                      : {
                          shouldRetryAfterError: (error: unknown): boolean =>
                            classifyUsageLimit(
                              resolvedInvocation,
                              model,
                              events,
                              error,
                            ) === null,
                        }),
                    transcriptObserver,
                    pluginRuntime,
                    codexRunner: codexStructuredHelperRunner,
                  },
                  createStructuredHelperRunner({
                    kind: 'commit_message_generation',
                    label: 'Commit Message',
                    provider:
                      resolvedInvocation.providerType === 'ollama'
                        ? 'ollama'
                        : 'claude',
                    projectId: effectiveWorkspaceId,
                    worktreeId: auditContext?.worktreeId,
                    linkTarget: auditContext
                      ? {
                          page: 'main',
                          kind: 'worktree-chat',
                          projectId: auditContext.projectId,
                          worktreeId: auditContext.worktreeId,
                          planId: auditContext.planId,
                        }
                      : undefined,
                    permission: structuredHelperReadOnlyPermission(),
                    settingSources: ['user', 'project', 'local'],
                    executionHarness: resolvedInvocation.harness,
                  }),
                ),
            );
          } finally {
            unlink();
          }
        },
        usageOf: (result) => result.usage,
      });
      if (result.source === 'model') {
        finalizeAttempt('success', undefined, result.usage);
        return { outcome: 'success', message: result.message };
      }
      // The shared generator exhausted its own retries. Its branch-title
      // fallback is discarded while candidates remain; the caller returns it
      // only once the whole chain is exhausted.
      const fallbackUsage = Object.values(result.usage).some(
        (value) => value !== undefined,
      )
        ? result.usage
        : undefined;
      finalizeAttempt(
        'failure',
        result.lastError === undefined
          ? COMMIT_MESSAGE_NO_USABLE_RESULT
          : errorDetail(result.lastError),
        fallbackUsage,
      );
      if (!deadline.timedOut()) {
        recordNativeUsageLimit(
          resolvedInvocation,
          model,
          events,
          result.lastError,
        );
      }
      return { outcome: 'failed' };
    })();
    // A late rejection after the deadline won the race is already handled.
    work.catch(() => undefined);
    return await Promise.race([work, deadline.promise]);
  } catch (error) {
    if (isHelperNoBillingSourceError(error)) {
      // Refused before any spawn (CAN-7062): `cancelled` with the reason,
      // and the chain remembers the provider.
      finalizeAttempt('cancelled', error.message);
      return { outcome: 'refused', provider: error.provider };
    }
    const callerAborted = callerSignal?.aborted === true;
    const timedOut = deadline.timedOut() && !callerAborted;
    finalizeAttempt(
      'failure',
      timedOut ? COMMIT_MESSAGE_ATTEMPT_TIMEOUT : errorDetail(error),
      timedOut ? undefined : getStructuredHelperQueryErrorUsage(error),
    );
    if (callerAborted) {
      throw error;
    }
    // No provider to attribute a limit to when invocation never resolved, and
    // a timeout says nothing about quota.
    if (invocation && !timedOut) {
      recordNativeUsageLimit(invocation, model, events, error);
    }
    return { outcome: 'failed' };
  } finally {
    deadline.clear();
    callerSignal?.removeEventListener('abort', forwardCallerAbort);
    invocation?.dispose?.();
  }
}

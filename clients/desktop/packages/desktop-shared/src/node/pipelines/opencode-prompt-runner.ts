import { prepareOpenCodeInferenceRoute } from '../opencode/inference-route';
import {
  clampThinkingLevelToDeclared,
  type ThinkingLevel,
} from '@canopy/protocol/thinking';
import { runRtkRewrite } from '@canopy/execution-engine/node/rtk/rewrite';
import {
  getBundledRtkBinaryPath,
  getEnhancedEnv,
  getRtkManagedEnv,
} from '@canopy/execution-engine/pipelines/config-paths';
import { classifyAgentFailure } from '@canopy/execution-engine/agent-failures';
import { hasAnySelections } from '../../types';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getRawOpenCodeModelId } from '@canopy/execution-engine/lib/opencode-models';
import {
  redactNormalizedPreservingFormat,
  redactSerializedJsonLine,
  redactStructuredValue,
} from '@canopy/execution-engine/lib/redaction';
import { validateAgainstSchema } from '../../lib/ajv-schema-validator';
import {
  appendCodexSchemaInstruction,
  buildCodexStructuredOutputRetryPrompt,
  CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import { buildPipelineGlobalInstructionsBlock } from '@canopy/execution-engine/lib/global-instructions';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import {
  mergeHelperUsage,
  type HelperUsage,
} from '@canopy/execution-engine/lib/helper-usage';
import {
  runOpenCodeTurn,
  type OpenCodeTurnRequest,
} from '../opencode/turn-driver';
import { resolveOpenCodeMcpSnapshotTool } from '../opencode/mcp-tool-identity';
import type {
  OpenCodeRuntimeOptions,
  OpenCodeToolInput,
} from '../opencode/runtime';
import { headlessOpenCodeDecision } from '../opencode/headless-policy';
import { extractProposedPlan } from '@canopy/execution-engine/codex-plan-mode';
import { getPipelineExecutionOpenCodeSessionsDir } from '@canopy/execution-engine/node/lib/paths';
import {
  createSetupWithdrawal,
  SETUP_WITHDRAWN,
  stepTimedOutMessage,
} from '@canopy/execution-engine/node/pipelines/step-timeout';
import type {
  OpenCodePromptRunnerRequest,
  OpenCodePromptRunnerResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';

export interface OpenCodePipelineCapabilities extends Pick<
  OpenCodeTurnRequest,
  | 'capabilityRoots'
  | 'capabilityContext'
  | 'instructions'
  | 'mcpServers'
  | 'mcpSnapshot'
> {
  expandPrompt?(prompt: string): string;
  warnings?: readonly string[];
  authorizeMcpTool?: OpenCodeRuntimeOptions['authorize'];
  /**
   * The app server among `mcpServers` that serves the step's Ledger tools.
   * Its calls go to `authorizeMcpTool` under every permission preset; the
   * host's route gates each with the attempt's approval session.
   */
  ledger?: { readonly server: string };
  dispose(): void | Promise<void>;
}

export interface OpenCodePromptHost {
  open(signal: AbortSignal): Promise<
    Pick<
      OpenCodeRuntimeOptions,
      | 'executable'
      | 'spawnProcess'
      | 'processOwner'
      | 'prefix'
      | 'env'
      | 'providerConfig'
      | 'signal'
      | 'runtimeIdentity'
      | 'inferenceRoute'
    > & {
      supportedThinkingLevels?: readonly ThinkingLevel[];
      failureError?: (
        fallback?: unknown,
        requestRejected?: boolean,
      ) => Error & { api_error_status?: number };
      close(): Promise<void>;
    }
  >;
  /** Apply shared approval policy and recheck live rollout/account authority. */
  authorize(
    input: OpenCodeToolInput,
    signal: AbortSignal,
  ): ReturnType<OpenCodeRuntimeOptions['authorize']>;
  prepareCapabilities?(
    profile: string,
    signal: AbortSignal,
  ): Promise<OpenCodePipelineCapabilities>;
}
const activeProfiles = new Set<string>();
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
interface Binding {
  version: 1;
  sessionId: string;
  profileId: string;
  cwd: string;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function readBinding(value: unknown, sessionId: string, cwd: string): Binding {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.sessionId !== sessionId ||
    value.cwd !== cwd ||
    typeof value.profileId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(value.profileId)
  )
    throw new Error(
      'This OpenCode session cannot be resumed in this workspace.',
    );
  return {
    version: 1,
    sessionId,
    cwd,
    profileId: value.profileId,
  };
}

/** Shared desktop/CLI runner. The supplied host owns rollout and account authority. */
export async function runOpenCodePipelinePrompt(
  request: OpenCodePromptRunnerRequest,
  host: OpenCodePromptHost,
): Promise<OpenCodePromptRunnerResult> {
  const started = request.budgetStartedAt ?? Date.now();
  const remaining = (): number => started + request.totalTimeoutMs - Date.now();
  const withdrawal = createSetupWithdrawal(
    request.signal ?? new AbortController().signal,
    remaining(),
  );
  const signal = withdrawal.signal;
  const secrets = request.secretValues ?? [];
  const mask = (value: string): string =>
    redactNormalizedPreservingFormat(value, secrets);
  const transcript: string[] = [];
  let sessionId = request.resumeSessionId;
  let hadActivity = false;
  let ownedProfile: string | undefined;
  let runtime: Awaited<ReturnType<OpenCodePromptHost['open']>> | undefined;
  let capabilities: OpenCodePipelineCapabilities | undefined;
  let failureError:
    | ((
        fallback?: unknown,
        requestRejected?: boolean,
      ) => Error & { api_error_status?: number })
    | undefined;
  let requestRejected = false;
  let accountScope: 'native' | 'ai_credits' = 'native';
  const emit = (event: Record<string, unknown>): void => {
    const line = redactSerializedJsonLine(
      JSON.stringify({ ...event, provider: 'opencode' }),
      secrets,
    );
    transcript.push(line);
    request.onTranscriptLine?.(line);
    if (event.type === 'canopy_assistant_patch') hadActivity = true;
  };
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    const value = await withdrawal.race(operation);
    if (value === SETUP_WITHDRAWN) throw new Error('OpenCode step stopped.');
    return value;
  };
  try {
    signal.throwIfAborted();
    const model = getRawOpenCodeModelId(request.model);

    const cwd = resolve(request.cwd);
    const root = getPipelineExecutionOpenCodeSessionsDir(
      request.executionsDir,
      request.executionId,
    );
    await bounded(mkdir(root, { recursive: true, mode: 0o700 }));
    let binding: Binding | undefined;
    if (sessionId)
      binding = readBinding(
        JSON.parse(
          await bounded(
            readFile(join(root, `${digest(sessionId)}.json`), 'utf8'),
          ),
        ),
        sessionId,
        cwd,
      );
    const profileId = binding?.profileId ?? randomUUID();
    const profile = join(root, profileId);
    if (activeProfiles.has(profile))
      throw new Error(
        'This OpenCode conversation is already running. Retry after it finishes.',
      );
    activeProfiles.add(profile);
    ownedProfile = profile;
    await bounded(mkdir(profile, { recursive: true, mode: 0o700 }));
    const hasSelections = Boolean(
      (request.pluginSelections &&
        hasAnySelections(request.pluginSelections)) ||
      request.packageOverlay,
    );
    if (hasSelections && !host.prepareCapabilities)
      throw new Error(
        'This OpenCode host cannot deliver the selected workflow capabilities.',
      );
    // A host that can prepare capabilities also serves the step's Ledger
    // tools through them; a host without one runs the step without them.
    const capabilitiesNeeded =
      hasSelections || request.ledgerAttemptKey !== undefined;
    const systemPrompt = [
      buildPipelineGlobalInstructionsBlock(
        getBrandEnv(request.environment, 'PREF_GLOBAL_INSTRUCTIONS_PIPELINES'),
        { harness: 'opencode', model: request.model },
      ),
      request.systemPrompt,
      request.permissionPreset === 'plan'
        ? 'Plan mode is read-only. Return the proposed plan without making changes.'
        : '',
      'This is an unattended pipeline step. Native subagents, scheduling and user questions are unavailable. Honor tool denials.',
    ]
      .filter(Boolean)
      .join('\n\n');
    let prompt = appendCodexSchemaInstruction(request.prompt, request.schema);
    let usage: HelperUsage = {};
    const attempts = request.schema
      ? CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS + 1
      : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal.throwIfAborted();
      const opening = host.open(signal);
      // Withdrawal can win during verification. A late runtime is still closed.
      void opening
        .then(async (value) => {
          if (signal.aborted) await value.close();
        })
        .catch(() => undefined);
      runtime = await bounded(opening);
      failureError = runtime.failureError;
      accountScope = runtime.inferenceRoute ? 'ai_credits' : 'native';
      const rawModel = runtime.inferenceRoute
        ? prepareOpenCodeInferenceRoute(runtime.inferenceRoute).rawModelId
        : model;
      if (!rawModel) throw new Error('Choose an OpenCode model for this step.');
      if (capabilitiesNeeded && host.prepareCapabilities) {
        const preparing = host.prepareCapabilities(profile, signal);
        // The resolver can settle after cancellation. Its routes still belong
        // to this step and must be withdrawn even if no prompt was started.
        void preparing
          .then(async (value) => {
            if (signal.aborted) await value.dispose();
          })
          .catch(() => undefined);
        try {
          capabilities = await bounded(preparing);
        } catch (error) {
          // A step that selected capabilities cannot run without them. A
          // step that only needed its Feed tools still runs, without them,
          // rather than failing on a route it did not ask for.
          if (hasSelections || signal.aborted) throw error;
          // Every structured-output retry prepares again; the step hears
          // about its missing Feed tools once.
          if (attempt === 0)
            emit({
              type: 'warning',
              message: `Feed tools are unavailable for this step: ${error instanceof Error ? error.message : String(error)}`,
            });
          capabilities = undefined;
        }
        // Every retry prepares the same capabilities; their warnings (an
        // unavailable Feed route among them) are reported once.
        if (attempt === 0)
          for (const message of capabilities?.warnings ?? [])
            emit({ type: 'warning', message });
        if (attempt === 0 && capabilities) {
          prompt = appendCodexSchemaInstruction(
            capabilities.expandPrompt?.(request.prompt) ?? request.prompt,
            request.schema,
          );
        }
      }
      signal.throwIfAborted();
      const result = await runOpenCodeTurn(
        {
          ...runtime,
          cwd,
          profileDir: profile,
          thinkingLevel:
            runtime.supportedThinkingLevels === undefined
              ? request.thinkingLevel
              : request.thinkingLevel !== undefined &&
                  runtime.supportedThinkingLevels.length
                ? clampThinkingLevelToDeclared(
                    request.thinkingLevel,
                    runtime.supportedThinkingLevels,
                  )
                : undefined,
          capabilityContext: {
            systemPrompt,
            selected: capabilities?.capabilityContext,
            permissionPreset: request.permissionPreset,
            providerSettingsSources: runtime.inferenceRoute
              ? ['host-inference']
              : ['managed-provider-config', 'native-opencode-auth'],
          },
          rawModelId: rawModel,
          model: request.model,
          sessionId,
          prompt,
          capabilityRoots: capabilities?.capabilityRoots,
          mcpServers: capabilities?.mcpServers,
          mcpSnapshot: capabilities?.mcpSnapshot,
          instructions: [systemPrompt, capabilities?.instructions]
            .filter(Boolean)
            .join('\n\n'),
          signal: AbortSignal.any([signal, runtime.signal]),
          promptTimeoutMs: Math.max(1, remaining()),
          secretValues: secrets,
        },
        {
          authorize: async (input) => {
            if (signal.aborted) return { decision: 'deny' };
            const selectedMcpTool = resolveOpenCodeMcpSnapshotTool(
              capabilities?.mcpSnapshot ?? [],
              input.toolName,
            );
            if (selectedMcpTool) {
              const isLedgerCall =
                capabilities?.ledger !== undefined &&
                selectedMcpTool.server === capabilities.ledger.server;
              if (
                (!isLedgerCall &&
                  request.permissionPreset !== 'dangerous_all') ||
                !capabilities?.authorizeMcpTool
              )
                return { decision: 'deny' };
              const decision = await capabilities.authorizeMcpTool(input);
              return signal.aborted ? { decision: 'deny' } : decision;
            }
            const presetDecision = headlessOpenCodeDecision(
              request.permissionPreset,
              input,
              cwd,
            );
            if (presetDecision.decision !== 'allow') return presetDecision;
            const decision = await host.authorize(input, signal);
            if (signal.aborted) return { decision: 'deny' };
            if (
              decision.decision === 'allow' &&
              !decision.stopTurn &&
              (input.toolName === 'shell' || input.toolName === 'bash') &&
              getBrandEnv(request.environment, 'PREF_RTK_ENABLED') === 'true' &&
              input.toolArgs &&
              typeof input.toolArgs === 'object' &&
              'command' in input.toolArgs &&
              typeof input.toolArgs.command === 'string'
            ) {
              const command = await runRtkRewrite(
                input.toolArgs.command,
                {
                  rtkBinaryPath: getBundledRtkBinaryPath(),
                  env: {
                    ...getEnhancedEnv({
                      includeCanopySecrets: false,
                      environment: false,
                    }),
                    ...getRtkManagedEnv(),
                  },
                },
                signal,
              );
              if (command)
                return {
                  ...decision,
                  updatedInput: { ...input.toolArgs, command },
                };
            }
            return decision;
          },
          emit,
          onSession: async (id) => {
            const entry: Binding = {
              version: 1,
              sessionId: id,
              cwd,
              profileId,
            };
            const destination = join(root, `${digest(id)}.json`);
            const temporary = `${destination}.${randomUUID()}.tmp`;
            try {
              await writeFile(temporary, JSON.stringify(entry), {
                mode: 0o600,
                flag: 'wx',
              });
              signal.throwIfAborted();
              await rename(temporary, destination);
            } finally {
              await rm(temporary, { force: true });
            }
            binding = entry;
            sessionId = id;
            emit({
              type: 'system',
              subtype: 'init',
              session_id: id,
              model: request.model,
            });
          },
        },
      );
      usage = mergeHelperUsage(usage, {
        inputTokens: result.usage?.input_tokens,
        outputTokens: result.usage?.output_tokens,
        cacheReadInputTokens: result.usage?.cache_read_input_tokens,
        cacheCreationInputTokens: result.usage?.cache_creation_input_tokens,
        messageCount: 1,
        assistantMessageCount: 1,
      });
      // Transcript consumers replace their counters with the latest snapshot.
      // Include every schema attempt without inventing unavailable token counts.
      const cumulativeUsage = {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_input_tokens: usage.cacheReadInputTokens,
        cache_creation_input_tokens: usage.cacheCreationInputTokens,
      };
      requestRejected = result.requestRejected === true;
      const completedRuntime = runtime;
      const completedCapabilities = capabilities;
      runtime = undefined;
      capabilities = undefined;
      let closeFailed = true;
      try {
        // Selected routes belong to this attempt's runtime and approval lease.
        // A schema retry must prepare a fresh set before opening its next turn.
        try {
          await completedCapabilities?.dispose();
        } finally {
          await completedRuntime.close();
        }
        closeFailed = false;
      } finally {
        // Even a failed or withdrawn attempt can consume tokens. Cleanup may
        // also withdraw the step after the driver has already returned success.
        emit({
          type: 'result',
          is_error:
            closeFailed ||
            signal.aborted ||
            result.isError ||
            result.cancelled ||
            !result.sessionId,
          usage: Object.values(cumulativeUsage).some(
            (value) => value !== undefined,
          )
            ? cumulativeUsage
            : undefined,
        });
      }
      signal.throwIfAborted();
      if (result.isError || result.cancelled) throw new Error(result.message);
      if (!result.sessionId)
        throw new Error('OpenCode did not create a session.');
      let structured: unknown;
      let schemaError: string | undefined;
      if (request.schema) {
        try {
          structured = JSON.parse(
            result.responseText
              .trim()
              .replace(/^```(?:json)?\s*\n?/, '')
              .replace(/\n?```$/, ''),
          );
        } catch {
          schemaError = 'Response was not valid JSON.';
        }
        if (
          !schemaError &&
          !validateAgainstSchema(request.schema, structured).ok
        )
          schemaError = 'Response did not match the requested schema.';
      }
      if (schemaError && request.schema) {
        if (attempt + 1 === attempts) throw new Error(schemaError);
        prompt = buildCodexStructuredOutputRetryPrompt(
          request.schema,
          schemaError,
        );
        continue;
      }
      return {
        status: 'success',
        sessionId: result.sessionId,
        rawText: mask(result.responseText),
        transcript: `${transcript.join('\n')}\n`,
        usage,
        ...(structured !== undefined
          ? { structured: redactStructuredValue(structured, secrets) }
          : {}),
        ...(request.permissionPreset === 'plan'
          ? {
              proposedPlan: mask(
                extractProposedPlan(result.responseText) ?? '',
              ),
            }
          : {}),
      };
    }
    throw new Error('OpenCode did not complete this step.');
  } catch (caught) {
    const error =
      !signal.aborted && failureError
        ? failureError(caught, requestRejected)
        : caught;
    const cancelled = withdrawal.reason === 'cancelled';
    const classification = classifyAgentFailure({
      provider: 'opencode',
      accountScope,
      model: request.model,
      error,
    });
    return {
      status: cancelled ? 'cancelled' : 'failure',
      transcript: transcript.length ? `${transcript.join('\n')}\n` : '',
      failure: {
        version: 1,
        provider: 'opencode',
        agent_harness: 'opencode',
        ...(classification ? { classification } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
        had_agent_activity: hadActivity,
        message: mask(
          cancelled
            ? 'OpenCode workflow turn was cancelled.'
            : withdrawal.reason === 'timeout'
              ? stepTimedOutMessage(request.totalTimeoutMs)
              : error instanceof Error
                ? error.message
                : 'OpenCode workflow turn failed.',
        ),
      },
    };
  } finally {
    withdrawal.release();
    try {
      await capabilities?.dispose();
    } finally {
      try {
        await runtime?.close();
      } finally {
        if (ownedProfile) activeProfiles.delete(ownedProfile);
      }
    }
  }
}

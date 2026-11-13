import { resolveHostRepositoryPolicy } from '@canopy/execution-engine/node/lib/repository-policy';
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
import { getRawCopilotModelId } from '@canopy/execution-engine/lib/copilot-models';
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
import type { CopilotAccount } from '../../types/copilot-connection';
import type { HelperUsage } from '@canopy/execution-engine/lib/helper-usage';
import {
  createCopilotCapabilitySnapshot,
  isCopilotCapabilitySnapshot,
  type CopilotCapabilitySnapshot,
} from '../copilot/capability-snapshot';
import { COPILOT_RUNTIME_VERSION } from '../copilot/runtime-metadata';
import { COPILOT_NATIVE_TOOLS } from '../copilot/session-policy';
import { sameCopilotAccount } from '../copilot/auth';
import { handleCopilotTurnCleanupError } from '../copilot/turn-cleanup';
import {
  assertCopilotMcpServersConnected,
  collectCopilotMcpSecretValues,
} from '../copilot/tool-snapshot';
import type { CopilotRecipientHandle } from '../copilot/recipient-handle';
import type {
  CopilotSessionPolicy,
  CopilotToolDecision,
} from '../copilot/session-policy';
import { CopilotToolCorrelation } from '../copilot/tool-correlation';
import { headlessCopilotDecision } from '../copilot/headless-policy';
import { extractProposedPlan } from '@canopy/execution-engine/codex-plan-mode';
import { getPipelineExecutionCopilotSessionsDir } from '@canopy/execution-engine/node/lib/paths';
import {
  createSetupWithdrawal,
  SETUP_WITHDRAWN,
  stepTimedOutMessage,
} from '@canopy/execution-engine/node/pipelines/step-timeout';
import type {
  CopilotPromptRunnerRequest,
  CopilotPromptRunnerResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';

export interface CopilotPromptHost {
  /** The host's admitted recipient; it holds the identity for every read. */
  open(signal: AbortSignal): Promise<CopilotRecipientHandle>;
  /** Recheck the host's live rollout, account and owner authority at each tool. */
  authorize(): void | Promise<void>;
  /** Desktop-owned projection and proxy lifetime; never ambient SDK discovery. */
  prepareCapabilities?(
    profile: string,
    signal: AbortSignal,
  ): Promise<CopilotPipelineCapabilities>;
}
export interface CopilotPipelineCapabilities {
  /** Stable host projection, excluding credentials and temporary transport addresses. */
  capabilitySnapshot: CopilotCapabilitySnapshot;
  skillDirectories?: CopilotSessionPolicy['skillDirectories'];
  mcpServers?: CopilotSessionPolicy['mcpServers'];
  /** Selected MCP calls must also pass the host's shared approval policy. */
  authorizeMcpTool?(call: {
    server: string;
    tool: string;
    args: unknown;
  }): Promise<CopilotToolDecision>;
  expandPrompt?(prompt: string): string;
  warnings?: string[];
  dispose(): void | Promise<void>;
}
const activeProfiles = new Set<string>();
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
interface Binding {
  version: 3;
  sessionId: string;
  profileId: string;
  cwd: string;
  account: CopilotAccount;
  runtimeVersion: string;
  capabilitySnapshot: CopilotCapabilitySnapshot;
  nativeToolSnapshot: CopilotCapabilitySnapshot;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function readBinding(value: unknown, sessionId: string, cwd: string): Binding {
  if (
    !isRecord(value) ||
    value.sessionId !== sessionId ||
    value.cwd !== cwd ||
    typeof value.profileId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(value.profileId) ||
    !isRecord(value.account) ||
    typeof value.account.host !== 'string' ||
    typeof value.account.login !== 'string'
  )
    throw new Error(
      'This Copilot session cannot be resumed in this workspace.',
    );
  if (
    value.version !== 3 ||
    value.runtimeVersion !== COPILOT_RUNTIME_VERSION ||
    !isCopilotCapabilitySnapshot(value.capabilitySnapshot) ||
    !isCopilotCapabilitySnapshot(value.nativeToolSnapshot)
  )
    throw new Error(
      'This Copilot conversation has incompatible saved configuration. Start a new step.',
    );
  return {
    version: 3,
    runtimeVersion: value.runtimeVersion,
    capabilitySnapshot: value.capabilitySnapshot,
    nativeToolSnapshot: value.nativeToolSnapshot,
    sessionId,
    cwd,
    profileId: value.profileId,
    account: { host: value.account.host, login: value.account.login },
  };
}

/** Shared desktop/CLI runner. The supplied host owns rollout and account authority. */
export async function runCopilotPipelinePrompt(
  request: CopilotPromptRunnerRequest,
  host: CopilotPromptHost,
): Promise<CopilotPromptRunnerResult> {
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
  let policyPreparationFailed = false;
  let ownedProfile: string | undefined;
  let runtime: Awaited<ReturnType<CopilotPromptHost['open']>> | undefined;
  let capabilities: CopilotPipelineCapabilities | undefined;
  let stepFailed = false;
  const emit = (event: Record<string, unknown>): void => {
    const line = redactSerializedJsonLine(
      JSON.stringify({ ...event, provider: 'copilot' }),
      secrets,
    );
    transcript.push(line);
    request.onTranscriptLine?.(line);
    if (event.type === 'canopy_assistant_patch') hadActivity = true;
  };
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    const value = await withdrawal.race(operation);
    if (value === SETUP_WITHDRAWN) throw new Error('Copilot step stopped.');
    return value;
  };
  try {
    signal.throwIfAborted();
    const model = getRawCopilotModelId(request.model);
    if (!model) throw new Error('Choose a GitHub Copilot model for this step.');
    const cwd = resolve(request.cwd);
    // This invocation owns the snapshot, including every structured-output retry.
    // It is discarded on settlement; a cold resume is a new owner.
    const repositoryPolicy = await bounded(
      resolveHostRepositoryPolicy(request.repositoryPolicyScope, cwd, {
        signal,
      }),
    );
    const repositoryPolicyBlock =
      repositoryPolicy.status === 'delivered'
        ? mask(repositoryPolicy.block)
        : '';
    emit({
      type: 'repository_policy',
      entrypoint: 'copilot-pipeline',
      checkpoint: 'before-runtime-open',
      mode: 'host-text',
      root:
        request.repositoryPolicyScope?.kind === 'checkout'
          ? request.repositoryPolicyScope.root
          : undefined,
      cwd,
      runtimeVersion: COPILOT_RUNTIME_VERSION,
      status: repositoryPolicy.status,
      entries: repositoryPolicy.entries,
      ...(repositoryPolicy.status === 'delivered'
        ? { blockHash: digest(repositoryPolicyBlock) }
        : {}),
    });
    if (
      repositoryPolicy.status !== 'delivered' &&
      repositoryPolicy.status !== 'absent'
    ) {
      policyPreparationFailed = true;
      throw new Error(repositoryPolicy.message);
    }
    const root = getPipelineExecutionCopilotSessionsDir(
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
        'This Copilot conversation is already running. Retry after it finishes.',
      );
    activeProfiles.add(profile);
    ownedProfile = profile;
    await bounded(mkdir(profile, { recursive: true, mode: 0o700 }));
    const hasCapabilities =
      (request.pluginSelections &&
        hasAnySelections(request.pluginSelections)) ||
      request.packageOverlay;
    if (hasCapabilities && !host.prepareCapabilities)
      throw new Error(
        'This execution host cannot supply the selected Copilot capabilities.',
      );
    const systemPrompt = [
      buildPipelineGlobalInstructionsBlock(
        getBrandEnv(request.environment, 'PREF_GLOBAL_INSTRUCTIONS_PIPELINES'),
        { harness: 'copilot', model: request.model },
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
    const usage: HelperUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      messageCount: 0,
      assistantMessageCount: 0,
    };
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
      if (
        !runtime.account ||
        (binding && !sameCopilotAccount(runtime.account, binding.account))
      )
        throw new Error(
          'This Copilot conversation belongs to another account. Start a new step.',
        );
      const account = runtime.account;
      await bounded(Promise.resolve(host.authorize()));
      if (!capabilities && host.prepareCapabilities) {
        const preparing = host.prepareCapabilities(profile, signal);
        void preparing
          .then(async (prepared) => {
            if (signal.aborted) await prepared.dispose();
          })
          .catch(() => undefined);
        capabilities = await bounded(preparing);
        if (!isCopilotCapabilitySnapshot(capabilities.capabilitySnapshot))
          throw new Error(
            'Copilot could not verify the selected capabilities. Start a new step.',
          );
        for (const message of capabilities.warnings ?? [])
          emit({ type: 'warning', message });
        prompt = appendCodexSchemaInstruction(
          capabilities.expandPrompt?.(request.prompt) ?? request.prompt,
          request.schema,
        );
      }
      let declared: ThinkingLevel[] = [];
      if (request.thinkingLevel !== undefined) {
        const listed = await bounded(runtime.listModels(signal));
        declared =
          listed.find((entry) => entry.id === request.model)
            ?.supportedThinkingLevels ?? [];
      }
      const level =
        request.thinkingLevel !== undefined && declared.length
          ? clampThinkingLevelToDeclared(request.thinkingLevel, declared)
          : undefined;
      const capabilitySnapshot = createCopilotCapabilitySnapshot({
        surface: 'pipeline',
        policyVersion: 1,
        model,
        reasoningEffort: level,
        permissionPreset: request.permissionPreset,
        systemPrompt: mask(systemPrompt),
        capabilities: capabilities?.capabilitySnapshot,
        selections:
          request.pluginSelections && hasAnySelections(request.pluginSelections)
            ? request.pluginSelections
            : undefined,
        packageDigest: request.packageOverlay?.packageDigest,
        nativeTools: COPILOT_NATIVE_TOOLS,
        discovery: 'explicit-only',
        mcpTable: 'complete-replacement-per-turn',
      });
      if (
        binding &&
        binding.capabilitySnapshot.digest !== capabilitySnapshot.digest
      )
        throw new Error(
          "This Copilot conversation's configuration changed. Start a new step.",
        );
      let nativeToolSnapshot: CopilotCapabilitySnapshot | undefined;
      const correlation = new CopilotToolCorrelation();
      const result = await runtime.runTurn({
        workingDirectory: cwd,
        configDirectory: profile,
        reasoningEffort:
          level === 'off' || level === 'ultra' ? undefined : level,
        model,
        sessionId,
        turnId: `${request.executionId}:${request.jobId}:${request.stepId}:${request.attempt}:${attempt}`,
        prompt,
        systemPrompt: [
          systemPrompt,
          request.repositoryPolicyScope?.kind === 'checkout'
            ? 'Repository instructions apply within their directories; more specific instructions take precedence. Before editing other files, read their applicable AGENTS.md/CLAUDE.md files within the selected checkout.'
            : '',
          repositoryPolicyBlock,
        ]
          .filter(Boolean)
          .join('\n\n'),
        skillDirectories: capabilities?.skillDirectories,
        mcpServers: capabilities?.mcpServers,
        onEvent: (event) => correlation.observe(event),
        signal,
        timeoutMs: Math.max(1, remaining()),
        secretValues: secrets,
        authorize: async (input) => {
          await host.authorize();
          const identity = correlation.take(input.toolName, input.toolArgs);
          if (identity?.server && identity.tool) {
            const selected = capabilities?.mcpServers?.[identity.server];
            if (
              signal.aborted ||
              request.permissionPreset !== 'dangerous_all' ||
              !selected ||
              !(
                (selected.tools ?? []).includes('*') ||
                (selected.tools ?? []).includes(identity.tool)
              ) ||
              !capabilities?.authorizeMcpTool
            )
              return { decision: 'deny' };
            const outcome = await capabilities.authorizeMcpTool({
              server: identity.server,
              tool: identity.tool,
              args: input.toolArgs,
            });
            await host.authorize();
            return signal.aborted ? { decision: 'deny' } : outcome;
          }
          const decision = headlessCopilotDecision(
            request.permissionPreset,
            input,
            cwd,
          );
          if (
            decision.decision === 'allow' &&
            input.toolName === 'bash' &&
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
                modifiedArgs: { ...input.toolArgs, command },
              };
          }
          return decision;
        },
        emit,
        onToolsReady: async (snapshot, mcpServers) => {
          await host.authorize();
          signal.throwIfAborted();
          assertCopilotMcpServersConnected(mcpServers, [
            ...secrets,
            ...collectCopilotMcpSecretValues(capabilities?.mcpServers),
          ]);
          if (binding && binding.nativeToolSnapshot.digest !== snapshot.digest)
            throw new Error(
              "This Copilot conversation's tools changed. Start a new step.",
            );
          nativeToolSnapshot = snapshot;
        },
        onSession: async (id) => {
          if (!nativeToolSnapshot)
            throw new Error(
              'Copilot could not verify the initialized tool list.',
            );
          const entry: Binding = {
            version: 3,
            sessionId: id,
            cwd,
            account,
            profileId,
            runtimeVersion: COPILOT_RUNTIME_VERSION,
            capabilitySnapshot,
            nativeToolSnapshot,
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
      });
      runtime = undefined;
      usage.inputTokens = (usage.inputTokens ?? 0) + result.usage.input_tokens;
      usage.outputTokens =
        (usage.outputTokens ?? 0) + result.usage.output_tokens;
      usage.cacheReadInputTokens =
        (usage.cacheReadInputTokens ?? 0) +
        result.usage.cache_read_input_tokens;
      usage.cacheCreationInputTokens =
        (usage.cacheCreationInputTokens ?? 0) +
        result.usage.cache_creation_input_tokens;
      usage.messageCount = (usage.messageCount ?? 0) + 1;
      usage.assistantMessageCount = (usage.assistantMessageCount ?? 0) + 1;
      emit({ type: 'result', is_error: false, usage: result.usage });
      let structured: unknown;
      let schemaError: string | undefined;
      if (request.schema) {
        try {
          structured = JSON.parse(
            result.text
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
        rawText: mask(result.text),
        transcript: `${transcript.join('\n')}\n`,
        usage,
        ...(structured !== undefined
          ? { structured: redactStructuredValue(structured, secrets) }
          : {}),
        ...(request.permissionPreset === 'plan'
          ? { proposedPlan: mask(extractProposedPlan(result.text) ?? '') }
          : {}),
      };
    }
    throw new Error('Copilot did not complete this step.');
  } catch (error) {
    stepFailed = true;
    const cancelled = withdrawal.reason === 'cancelled';
    const classification = policyPreparationFailed
      ? undefined
      : classifyAgentFailure({
          provider: 'copilot',
          accountScope: 'native',
          model: request.model,
          error,
        });
    return {
      status: cancelled ? 'cancelled' : 'failure',
      transcript: transcript.length ? `${transcript.join('\n')}\n` : '',
      failure: {
        version: 1,
        provider: 'copilot',
        agent_harness: 'copilot',
        ...(classification ? { classification } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
        had_agent_activity: hadActivity,
        message: mask(
          cancelled
            ? 'Copilot workflow turn was cancelled.'
            : withdrawal.reason === 'timeout'
              ? stepTimedOutMessage(request.totalTimeoutMs)
              : error instanceof Error
                ? error.message
                : 'Copilot workflow turn failed.',
        ),
      },
    };
  } finally {
    withdrawal.release();
    try {
      await runtime?.close();
    } catch (error) {
      handleCopilotTurnCleanupError(error, stepFailed);
    } finally {
      try {
        await capabilities?.dispose();
      } finally {
        if (ownedProfile) activeProfiles.delete(ownedProfile);
      }
    }
  }
}

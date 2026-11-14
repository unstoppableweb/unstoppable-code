import { getPipelineExecutionAntigravitySessionsDir } from '@canopy/execution-engine/node/lib/paths';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hasAnySelections } from '../../types';
import { CursorEventProjection } from '../cursor/events';
import type { AcpPermissionRequest } from '../acp';
import { antigravityNativeOperation } from '../antigravity/tool-approval';
import { antigravityTokenUsage } from '../antigravity/usage';
import type { AntigravityRuntime } from '../antigravity/runtime';
import { ANTIGRAVITY_RUNTIME_VERSION } from '../antigravity/runtime-metadata';
import {
  antigravityModelsFromConfig,
  getRawAntigravityModelId,
} from '@canopy/execution-engine/lib/antigravity-models';
import { clampThinkingLevelToDeclared } from '@canopy/protocol/thinking';
import { classifyAgentFailure } from '@canopy/execution-engine/agent-failures';
import {
  redactNormalizedPreservingFormat,
  redactSerializedJsonLine,
  redactStructuredValue,
} from '@canopy/execution-engine/lib/redaction';
import {
  appendCodexSchemaInstruction,
  parseStructuredResponseText,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import { buildPipelineGlobalInstructionsBlock } from '@canopy/execution-engine/lib/global-instructions';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import { extractProposedPlan } from '@canopy/execution-engine/codex-plan-mode';
import { validateAgainstSchema } from '../../lib/ajv-schema-validator';
import {
  createSetupWithdrawal,
  SETUP_WITHDRAWN,
  stepTimedOutMessage,
} from '@canopy/execution-engine/node/pipelines/step-timeout';
import type {
  AntigravityPromptRunnerRequest,
  AntigravityPromptRunnerResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import type { AcpClientOptions } from '../acp';

export interface AntigravityPromptHost {
  open(input: {
    profile: string;
    signal: AbortSignal;
    onUpdate: AcpClientOptions['onUpdate'];
    onPermission: NonNullable<AcpClientOptions['onPermission']>;
  }): Promise<AntigravityRuntime>;
  authorize(request: AcpPermissionRequest): Promise<'allow' | 'deny'>;
  assertEnabled(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

const activeProfiles = new Set<string>();
const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex');
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One host-independent execution path. Capabilities are explicitly empty. */
export async function runAntigravityPipelinePrompt(
  request: AntigravityPromptRunnerRequest,
  host: AntigravityPromptHost,
): Promise<AntigravityPromptRunnerResult> {
  const started = request.budgetStartedAt ?? Date.now();
  const withdrawal = createSetupWithdrawal(
    request.signal ?? new AbortController().signal,
    started + request.totalTimeoutMs - Date.now(),
  );
  const signal = withdrawal.signal;
  const transcript: string[] = [];
  const secrets = request.secretValues ?? [];
  const mask = (text: string): string =>
    redactNormalizedPreservingFormat(text, secrets);
  let runtime: AntigravityRuntime | undefined;
  let profile: string | undefined;
  let sessionId = request.resumeSessionId;
  let hadActivity = false;
  const emit = (event: Record<string, unknown>): void => {
    const line = redactSerializedJsonLine(
      JSON.stringify({ ...event, provider: 'antigravity' }),
      secrets,
    );
    transcript.push(line);
    request.onTranscriptLine?.(line);
    if (event.type === 'canopy_assistant_patch') hadActivity = true;
  };
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    const result = await withdrawal.race(operation);
    if (result === SETUP_WITHDRAWN) throw new Error('Google workflow stopped.');
    return result;
  };
  try {
    signal.throwIfAborted();
    if (
      !['none', 'read_only', 'plan', 'dangerous_all'].includes(
        request.permissionPreset,
      )
    )
      throw new Error('Invalid workflow permission preset.');
    if (
      (request.pluginSelections &&
        hasAnySelections(request.pluginSelections)) ||
      request.packageOverlay
    )
      throw new Error(
        'Google workflow extensions are not available yet. Remove the selected capabilities or choose another provider.',
      );
    const model = getRawAntigravityModelId(request.model);
    if (!model?.startsWith('gemini-'))
      throw new Error('Choose a Google subscription model for this workflow.');
    await bounded(Promise.resolve(host.assertEnabled()));
    const cwd = resolve(request.cwd);
    const root = getPipelineExecutionAntigravitySessionsDir(
      request.executionsDir,
      request.executionId,
    );
    await bounded(mkdir(root, { recursive: true, mode: 0o700 }));
    let profileId: string = randomUUID();
    if (sessionId) {
      const binding: unknown = JSON.parse(
        await bounded(
          readFile(join(root, `${digest(sessionId)}.json`), 'utf8'),
        ),
      );
      if (
        !isRecord(binding) ||
        binding.version !== 1 ||
        binding.sessionId !== sessionId ||
        binding.cwd !== cwd ||
        binding.runtimeVersion !== ANTIGRAVITY_RUNTIME_VERSION ||
        binding.model !== model ||
        binding.permissionPreset !== request.permissionPreset ||
        typeof binding.profileId !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(binding.profileId)
      )
        throw new Error(
          'This Google workflow session cannot be resumed in this workspace.',
        );
      profileId = binding.profileId;
    }
    const selectedProfile = join(root, profileId);
    if (activeProfiles.has(selectedProfile))
      throw new Error('This Google workflow session is already running.');
    activeProfiles.add(selectedProfile);
    profile = selectedProfile;
    const projection = new CursorEventProjection(
      'Google workflow output exceeded the local limit.',
      { recognizeCursorErrors: false, secretValues: secrets },
    );
    let updateFailure: unknown;
    let deniedPermission = false;
    const deny = (): 'deny' => {
      deniedPermission = true;
      return 'deny';
    };
    const openedRuntime = await bounded(
      host
        .open({
          profile,
          signal,
          onUpdate: (update) => {
            if (signal.aborted) return;
            try {
              const event = projection.update(update);
              for (const flushed of projection.takeFlushed()) emit(flushed);
              if (event) emit(event);
            } catch (error) {
              updateFailure = error;
              runtime?.client.close();
            }
          },
          onPermission: async (permission) => {
            const operation = antigravityNativeOperation(permission);
            if (
              signal.aborted ||
              permission.signal.aborted ||
              !operation ||
              request.permissionPreset === 'none' ||
              (operation.mutates &&
                request.permissionPreset !== 'dangerous_all')
            )
              return deny();
            try {
              await host.assertEnabled();
              const decision = await host.authorize(permission);
              await host.assertEnabled();
              return signal.aborted || permission.signal.aborted
                ? deny()
                : decision === 'deny'
                  ? deny()
                  : decision;
            } catch {
              return deny();
            }
          },
        })
        .then(async (opened) => {
          if (signal.aborted) {
            await opened.close();
            signal.throwIfAborted();
          }
          return opened;
        }),
    );
    runtime = openedRuntime;
    const systemPrompt = [
      buildPipelineGlobalInstructionsBlock(
        getBrandEnv(request.environment, 'PREF_GLOBAL_INSTRUCTIONS_PIPELINES'),
        { harness: 'antigravity', model: request.model },
      ),
      request.systemPrompt,
    ]
      .filter(Boolean)
      .join('\n\n');
    const params = {
      cwd,
      mcpServers: [],
      _meta: { antigravity: { systemPrompt: { append: systemPrompt } } },
    };
    const native = await bounded(
      sessionId
        ? openedRuntime.client.resumeSession({ ...params, sessionId })
        : openedRuntime.client.newSession(params),
    );
    if ('sessionId' in native && typeof native.sessionId === 'string') {
      if (sessionId && native.sessionId !== sessionId)
        throw new Error(
          'Google did not resume the requested workflow session.',
        );
      sessionId = native.sessionId;
    }
    if (!sessionId)
      throw new Error('Google did not create a workflow session.');
    const selected = antigravityModelsFromConfig(native.configOptions).find(
      (entry) => entry.rawModelId === model,
    );
    if (!selected)
      throw new Error(
        'The selected Google model is unavailable on this account.',
      );
    await bounded(
      openedRuntime.client.setSessionConfigOption(
        { sessionId, configId: 'model', value: model },
        signal,
      ),
    );
    if (request.thinkingLevel && selected.supportedThinkingLevels.length)
      await bounded(
        openedRuntime.client.setSessionConfigOption(
          {
            sessionId,
            configId: 'thought_level',
            value: clampThinkingLevelToDeclared(
              request.thinkingLevel,
              selected.supportedThinkingLevels,
            ),
          },
          signal,
        ),
      );
    await bounded(
      openedRuntime.client.setSessionConfigOption(
        {
          sessionId,
          configId: 'mode',
          value: request.permissionPreset === 'plan' ? 'plan' : 'default',
        },
        signal,
      ),
    );
    const temporary = join(root, `${digest(sessionId)}.${randomUUID()}.tmp`);
    try {
      await bounded(
        writeFile(
          temporary,
          JSON.stringify({
            version: 1,
            sessionId,
            profileId,
            cwd,
            runtimeVersion: ANTIGRAVITY_RUNTIME_VERSION,
            model,
            permissionPreset: request.permissionPreset,
          }),
          { mode: 0o600, flag: 'wx' },
        ),
      );
      signal.throwIfAborted();
      await bounded(rename(temporary, join(root, `${digest(sessionId)}.json`)));
    } finally {
      await rm(temporary, { force: true });
    }
    emit({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model: request.model,
    });
    await bounded(Promise.resolve(host.assertEnabled()));
    const result = await bounded(
      openedRuntime.client.prompt(
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: appendCodexSchemaInstruction(
                request.prompt,
                request.schema,
              ),
            },
          ],
        },
        1,
        signal,
      ),
    );
    if (updateFailure)
      throw updateFailure instanceof Error
        ? updateFailure
        : new Error('Google workflow output could not be processed.');
    if (result.stopReason !== 'end_turn')
      throw new Error(`Google workflow ended with ${result.stopReason}.`);
    for (const event of projection.finish()) emit(event);
    const text = projection.getResponseText();
    if (!text.trim() && deniedPermission)
      throw new Error(
        'Google could not complete this workflow because its requested tool was denied by the approval policy.',
      );
    const nativeUsage = antigravityTokenUsage(result.usage);
    let structured: unknown;
    if (request.schema) {
      structured = parseStructuredResponseText(text);
      if (!validateAgainstSchema(request.schema, structured).ok)
        throw new Error(
          'Google returned a response that does not match the required schema.',
        );
    }
    emit({
      type: 'result',
      is_error: false,
      session_id: sessionId,
      usage: nativeUsage,
      result: text,
    });
    return {
      status: 'success',
      sessionId,
      rawText: mask(text),
      transcript: `${transcript.join('\n')}\n`,
      usage: {
        inputTokens: nativeUsage?.input_tokens,
        outputTokens: nativeUsage?.output_tokens,
        cacheReadInputTokens: nativeUsage?.cache_read_input_tokens,
        cacheCreationInputTokens: nativeUsage?.cache_creation_input_tokens,
        reasoningOutputTokens: nativeUsage?.reasoning_tokens,
        messageCount: 1,
        assistantMessageCount: 1,
      },
      ...(structured !== undefined
        ? { structured: redactStructuredValue(structured, secrets) }
        : {}),
      ...(request.permissionPreset === 'plan'
        ? { proposedPlan: mask(extractProposedPlan(text) ?? '') }
        : {}),
    };
  } catch (error) {
    return {
      status: withdrawal.reason === 'cancelled' ? 'cancelled' : 'failure',
      transcript: transcript.length ? `${transcript.join('\n')}\n` : '',
      failure: {
        version: 1,
        provider: 'antigravity',
        agent_harness: 'antigravity',
        had_agent_activity: hadActivity,
        ...(sessionId ? { session_id: sessionId } : {}),
        classification:
          classifyAgentFailure({
            provider: 'antigravity',
            accountScope: 'native',
            model: request.model,
            error,
          }) ?? undefined,
        message: mask(
          withdrawal.reason === 'timeout'
            ? stepTimedOutMessage(request.totalTimeoutMs)
            : withdrawal.reason === 'cancelled'
              ? 'Google workflow was cancelled.'
              : error instanceof Error
                ? error.message
                : 'Google workflow failed.',
        ),
      },
    };
  } finally {
    withdrawal.release();
    try {
      await runtime?.close();
    } finally {
      if (profile) activeProfiles.delete(profile);
      await host.dispose?.();
    }
  }
}

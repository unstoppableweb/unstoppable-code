import { getPipelineExecutionAntigravitySessionsDir } from '@canopy/execution-engine/node/lib/paths';
import {
  withW5ProcessFileLocks,
  W5ProcessFileLockTimeoutError,
} from '@canopy/execution-engine/node/w5-host-cohort/process-file-lock';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hasAnySelections } from '../../types';
import { CursorEventProjection } from '../cursor/events';
import type { AcpPermissionRequest } from '../acp';
import { antigravityNativeOperation } from '../antigravity/tool-approval';
import {
  antigravityTokenUsage,
  type AntigravityTokenUsage,
} from '../antigravity/usage';
import type { AntigravityRuntime } from '../antigravity/runtime';
import { ANTIGRAVITY_RUNTIME_VERSION } from '../antigravity/runtime-metadata';
import { applyAntigravitySessionConfig } from '../antigravity/session-config';
import {
  antigravityModelsFromConfig,
  getRawAntigravityModelId,
} from '@canopy/execution-engine/lib/antigravity-models';
import { classifyAgentFailure } from '@canopy/execution-engine/agent-failures';
import {
  redactNormalizedPreservingFormat,
  redactSerializedJsonLine,
  redactStructuredValue,
} from '@canopy/execution-engine/lib/redaction';
import {
  appendCodexSchemaInstruction,
  buildCodexStructuredOutputRetryPrompt,
  CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS,
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
import type { McpServer } from '@agentclientprotocol/sdk';
import {
  effectiveCapabilityDigest,
  readEffectiveCapabilitySnapshot,
  saveEffectiveCapabilitySnapshot,
  type EffectiveCapabilitySnapshot,
} from '../capabilities/effective-snapshot';

/** The selected capabilities one step owns until it ends (CAN-6704). */
export interface AntigravityPipelineCapabilities {
  servers: McpServer[];
  instructions: string;
  expandPrompt(text: string): string;
  /** Evidence of what the step was given. It never grants anything. */
  captureSnapshot(signal: AbortSignal): Promise<EffectiveCapabilitySnapshot>;
  /** Unregisters routes, stops workers and removes delivered copies. */
  close(): Promise<void>;
}

export interface AntigravityPromptHost {
  open(input: {
    profile: string;
    signal: AbortSignal;
    onUpdate: AcpClientOptions['onUpdate'];
    onPermission: NonNullable<AcpClientOptions['onPermission']>;
  }): Promise<AntigravityRuntime>;
  authorize(request: AcpPermissionRequest): Promise<'allow' | 'deny'>;
  assertEnabled(): void | Promise<void>;
  /**
   * Opens the step's selected capabilities. A host without a portable
   * implementation (the CLI) omits it and selected capabilities are refused.
   */
  prepareCapabilities?(input: {
    signal: AbortSignal;
    /**
     * Read on every selected tool call, before and after approval. False
     * denies the call before any remembered rule or Full Access applies.
     */
    toolCallAllowed: () => boolean;
    /** False once the step no longer owns its routes and workers. */
    ownsResources: () => boolean;
    stopTurn: () => void;
  }): Promise<AntigravityPipelineCapabilities>;
  dispose?(): void | Promise<void>;
}

const CAPABILITIES_NOT_RECORDED =
  'This Google workflow session cannot be resumed because its selected capabilities were not recorded. Run the step again from the start.';
const CAPABILITIES_CHANGED =
  'This Google workflow session cannot be resumed because its selected capabilities changed. Run the step again from the start.';

/** The capture's recorded reasons, as step failure text. */
const UNCONFIRMED_REASONS: Readonly<Partial<Record<string, string>>> = {
  'Not read within the evidence budget.': 'did not answer in time',
  'The tool list could not be read.': 'could not list its tools',
};

/**
 * Names what could not be confirmed and why, as the capture recorded it. An
 * OAuth-required HTTP route without a usable credential and an upstream that
 * rejects listing list no tools; so does a server that did not answer within
 * the budget. Other servers can list with a bad credential and then fail at
 * their first call.
 */
function capabilitiesUnconfirmed(
  snapshot: EffectiveCapabilitySnapshot | undefined,
): string {
  const servers = (snapshot?.mcp ?? [])
    .filter((server) => server.tools === null)
    .map((server) => {
      const reason = server.unavailable
        ? (UNCONFIRMED_REASONS[server.unavailable] ??
          server.unavailable.replace(/\.$/, ''))
        : undefined;
      return reason ? `${server.name} (${reason})` : server.name;
    });
  return servers.length > 0
    ? `Selected MCP servers could not be confirmed before the step started: ${servers.join('; ')}. Check that they are signed in and reachable, or remove them from the step, then run it again.`
    : "The step's selected capabilities could not be confirmed before it started. Run it again, or remove the selections.";
}

const activeProfiles = new Set<string>();
const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

/**
 * Sums native per-turn usage. Unknown usage on any turn keeps the total
 * unknown, and an optional counter survives only when every turn reported it.
 * `null` marks the first turn.
 */
function addAntigravityUsage(
  total: AntigravityTokenUsage | undefined | null,
  next: AntigravityTokenUsage | undefined,
): AntigravityTokenUsage | undefined {
  if (total === null) return next;
  if (!total || !next) return undefined;
  const optional = (
    a: number | undefined,
    b: number | undefined,
  ): number | undefined =>
    a === undefined || b === undefined ? undefined : a + b;
  const reasoning = optional(total.reasoning_tokens, next.reasoning_tokens);
  const cacheRead = optional(
    total.cache_read_input_tokens,
    next.cache_read_input_tokens,
  );
  const cacheCreation = optional(
    total.cache_creation_input_tokens,
    next.cache_creation_input_tokens,
  );
  return {
    input_tokens: total.input_tokens + next.input_tokens,
    output_tokens: total.output_tokens + next.output_tokens,
    ...(reasoning !== undefined ? { reasoning_tokens: reasoning } : {}),
    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreation !== undefined
      ? { cache_creation_input_tokens: cacheCreation }
      : {}),
  };
}

const PROFILE_BUSY = 'This Google workflow session is already running.';

/**
 * Holds the shared OS-released process lock for one native profile until the
 * returned release runs. Desktop and the standalone CLI can otherwise drive
 * the same session at once. Paths are canonicalized by the lock, so aliases of
 * one execution directory contend. A crashed holder's lock is released by the
 * OS; the lock file is never removed, so a late release cannot free a newer
 * owner's lock. Acquisition does not wait.
 */
// The lock folder sits beside the profiles as `runtime/`. Profile folder names
// are always UUIDs (generated or validated against the binding), so they
// cannot collide with it.
async function holdProfileLock(
  sessionsRoot: string,
  profile: string,
): Promise<() => Promise<void>> {
  let acquired = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = withW5ProcessFileLocks(
    [profile],
    { dataRoot: sessionsRoot, timeoutMs: 0 },
    async () => {
      acquired();
      await released;
    },
  );
  try {
    await Promise.race([ready, held]);
  } catch (error) {
    if (error instanceof W5ProcessFileLockTimeoutError)
      throw new Error(PROFILE_BUSY);
    // Lock internals and paths are not step failure text.
    throw Object.assign(
      new Error('This Google workflow session could not be locked.'),
      { cause: error },
    );
  }
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    release();
    try {
      await held;
    } catch {
      // A failed close cannot change the step's result. If the connection
      // still holds the lock, later runs fail closed as already running.
    }
  };
}
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
  let releaseProfile: (() => Promise<void>) | undefined;
  let opening: Promise<AntigravityRuntime> | undefined;
  let openSettled = false;
  // Every completed native turn consumed tokens, including schema repairs.
  let completedTurns = 0;
  let cumulativeUsage: AntigravityTokenUsage | undefined;
  let resultEmitted = false;
  // Set by the update stream, which closes the client; it is the real cause
  // when the pending prompt then rejects. Never reset: any update failure
  // ends the step.
  let updateFailure: unknown;
  const updateError = (): Error | undefined =>
    updateFailure === undefined
      ? undefined
      : updateFailure instanceof Error
        ? updateFailure
        : new Error('Google workflow output could not be processed.');
  // A failure can be reported before the runtime is adopted (while it is
  // still opening) or between requests. No further native request is sent
  // once one is known.
  const stopOnUpdateFailure = (): void => {
    const known = updateError();
    if (known) throw known;
  };
  let sessionId = request.resumeSessionId;
  let hadActivity = false;
  // Set when the step ends. Nothing the step opened may act after it.
  let finished = false;
  // A schema repair only corrects the response. Its turn keeps reads under
  // the shared policy but cannot repeat file, command or MCP effects.
  let repairing = false;
  let capabilities: AntigravityPipelineCapabilities | undefined;
  let preparing: Promise<AntigravityPipelineCapabilities> | undefined;
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
    const selectsCapabilities =
      (request.pluginSelections !== undefined &&
        hasAnySelections(request.pluginSelections)) ||
      request.packageOverlay !== undefined;
    if (selectsCapabilities && !host.prepareCapabilities)
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
    if (activeProfiles.has(selectedProfile)) throw new Error(PROFILE_BUSY);
    activeProfiles.add(selectedProfile);
    profile = selectedProfile;
    signal.throwIfAborted();
    releaseProfile = await holdProfileLock(root, selectedProfile);
    signal.throwIfAborted();
    // Recorded evidence for a resumed conversation, read before anything is
    // opened for it. A damaged or relocated record refuses the resume.
    const prior = sessionId
      ? await bounded(
          readEffectiveCapabilitySnapshot(root, 'antigravity', sessionId),
        ).catch((error: unknown) => {
          signal.throwIfAborted();
          if (withdrawal.reason) throw error;
          throw new Error(CAPABILITIES_NOT_RECORDED);
        })
      : undefined;
    // Refused before anything is opened: a resume cannot add or drop
    // capabilities, or continue from a record that is incomplete.
    if (sessionId && (prior !== undefined) !== selectsCapabilities)
      throw new Error(CAPABILITIES_CHANGED);
    if (prior && !prior.snapshot.complete)
      throw new Error(CAPABILITIES_NOT_RECORDED);
    let current: EffectiveCapabilitySnapshot | undefined;
    if (selectsCapabilities && host.prepareCapabilities) {
      preparing = host.prepareCapabilities({
        signal,
        // Selected MCP tools carry no proof that they only read, so only an
        // explicit `dangerous_all` step may call them, and never while
        // correcting a response. Checked again on every call.
        toolCallAllowed: () =>
          !finished &&
          !signal.aborted &&
          !repairing &&
          request.permissionPreset === 'dangerous_all',
        ownsResources: () => !finished && !signal.aborted,
        stopTurn: () => {
          updateFailure ??= new Error(
            'Google workflow was stopped by an approval decision.',
          );
          runtime?.client.close();
        },
      });
      capabilities = await bounded(preparing);
      signal.throwIfAborted();
      // Every loaded server lists its tools through its host route before
      // Google opens; listing calls no tool. One that lists nothing within the
      // budget (an OAuth-required route without a usable credential, an
      // upstream that rejects listing, or no answer in time) fails the step
      // here, before any inference. The snapshot is evidence of what the step
      // was given; it never grants anything.
      const captured = await bounded(
        capabilities.captureSnapshot(signal),
      ).catch((error: unknown) => {
        signal.throwIfAborted();
        if (withdrawal.reason) throw error;
        throw new Error(capabilitiesUnconfirmed(undefined));
      });
      if (!captured.complete)
        throw new Error(capabilitiesUnconfirmed(captured));
      if (prior && effectiveCapabilityDigest(captured) !== prior.binding.digest)
        throw new Error(CAPABILITIES_CHANGED);
      current = captured;
    }
    const projection = new CursorEventProjection(
      'Google workflow output exceeded the local limit.',
      { recognizeCursorErrors: false, secretValues: secrets },
    );
    let deniedPermission = false;
    const deny = (): 'deny' => {
      deniedPermission = true;
      return 'deny';
    };
    // Tool calls that asked for approval. Some native tools (live 1.5.1
    // subagents among them) run without asking, so the preset and repair
    // ceilings cannot bound them. Where a ceiling applies, a tool that
    // completes without having asked stops the step.
    const askedToolCalls = new Set<string>();
    const ceilingApplies = (): boolean =>
      repairing || request.permissionPreset !== 'dangerous_all';
    opening = host
      .open({
        profile,
        signal,
        onUpdate: (update) => {
          if (signal.aborted) return;
          const native = update.update;
          if (
            (native.sessionUpdate === 'tool_call' ||
              native.sessionUpdate === 'tool_call_update') &&
            // Live 1.5.1 reports a call as in progress before it asks, so
            // only completion shows a tool ran. This detects an unasked
            // tool after it ran; it does not prevent its effects.
            native.status === 'completed' &&
            !askedToolCalls.has(native.toolCallId) &&
            ceilingApplies()
          ) {
            // Record the call in the transcript before stopping, and name its
            // ACP kind (never its title, which can hold paths) for diagnosis.
            try {
              const event = projection.update(update);
              for (const flushed of projection.takeFlushed()) emit(flushed);
              if (event) emit(event);
            } catch {
              // The step is already stopping; the approval failure is the cause.
            }
            // Native Antigravity never asks before MCP, so a selected MCP
            // call the host denied (during a repair) also lands here.
            updateFailure ??= new Error(
              capabilities && capabilities.servers.length > 0
                ? `Google ran a tool (${native.kind ?? 'unknown kind'}) without asking for approval, or tried a selected MCP tool this step denied, so the workflow was stopped.`
                : `Google ran a tool (${native.kind ?? 'unknown kind'}) without asking for approval, so the workflow was stopped.`,
            );
            runtime?.client.close();
            return;
          }
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
          askedToolCalls.add(permission.request.toolCall.toolCallId);
          const operation = antigravityNativeOperation(permission);
          if (
            signal.aborted ||
            permission.signal.aborted ||
            !operation ||
            request.permissionPreset === 'none' ||
            (operation.mutates &&
              (repairing || request.permissionPreset !== 'dangerous_all'))
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
        if (signal.aborted || updateFailure !== undefined) {
          await opened.close();
          signal.throwIfAborted();
          stopOnUpdateFailure();
        }
        return opened;
      });
    // Registered before `bounded` subscribes, so it is current whenever the
    // step's own handling of the open runs.
    void opening.then(
      () => {
        openSettled = true;
      },
      () => {
        openSettled = true;
      },
    );
    const openedRuntime = await bounded(opening);
    runtime = openedRuntime;
    stopOnUpdateFailure();
    const systemPrompt = [
      buildPipelineGlobalInstructionsBlock(
        getBrandEnv(request.environment, 'PREF_GLOBAL_INSTRUCTIONS_PIPELINES'),
        { harness: 'antigravity', model: request.model },
      ),
      request.systemPrompt,
      capabilities?.instructions,
    ]
      .filter(Boolean)
      .join('\n\n');
    if (
      capabilities?.servers.some((server) => 'url' in server) &&
      openedRuntime.client.getInitialization().agentCapabilities
        ?.mcpCapabilities?.http !== true
    )
      throw new Error(
        'This Google runtime cannot load the selected MCP servers. Update Antigravity and try again.',
      );
    const params = {
      cwd,
      mcpServers: capabilities ? [...capabilities.servers] : [],
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
    stopOnUpdateFailure();
    const selected = antigravityModelsFromConfig(native.configOptions).find(
      (entry) => entry.rawModelId === model,
    );
    if (!selected)
      throw new Error(
        'The selected Google model is unavailable on this account.',
      );
    // The step's model, effort and mode must be confirmed by the runtime.
    // Unlike chat turns, a step has no picker catalog, so the selected model's
    // live levels are authoritative and a model without a thinking control
    // runs without one.
    await bounded(
      applyAntigravitySessionConfig(
        openedRuntime.client,
        sessionId,
        {
          model,
          ...(request.thinkingLevel
            ? { thinkingLevel: request.thinkingLevel }
            : {}),
          mode: request.permissionPreset === 'plan' ? 'plan' : 'default',
        },
        { signal },
      ),
    );
    stopOnUpdateFailure();
    // A new conversation records its evidence before its session binding and
    // before its first prompt. Any later resume, including recovery after a
    // failure or timeout, can compare, and a binding never exists without its
    // record, so a resume cannot silently drop capabilities.
    if (current && !request.resumeSessionId)
      await bounded(
        saveEffectiveCapabilitySnapshot(root, sessionId, current, signal),
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
    const attempts = request.schema
      ? CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS + 1
      : 1;
    let prompt = appendCodexSchemaInstruction(
      capabilities ? capabilities.expandPrompt(request.prompt) : request.prompt,
      request.schema,
    );
    for (let attempt = 0; ; attempt++) {
      // Every attempt shares the step's single deadline and cancellation.
      await bounded(Promise.resolve(host.assertEnabled()));
      stopOnUpdateFailure();
      deniedPermission = false;
      askedToolCalls.clear();
      repairing = attempt > 0;
      // One projection spans every attempt, so its output limits bound the
      // whole step, repairs included, rather than each turn.
      const responseStart = projection.getResponseText().length;
      const result = await bounded(
        openedRuntime.client.prompt(
          { sessionId, prompt: [{ type: 'text', text: prompt }] },
          1,
          signal,
        ),
      );
      completedTurns += 1;
      cumulativeUsage = addAntigravityUsage(
        completedTurns === 1 ? null : cumulativeUsage,
        antigravityTokenUsage(result.usage),
      );
      stopOnUpdateFailure();
      if (result.stopReason !== 'end_turn')
        throw new Error(`Google workflow ended with ${result.stopReason}.`);
      for (const event of projection.finish()) emit(event);
      const text = projection.getResponseText().slice(responseStart);
      // A repair turn has no tools to wait on, so an empty repair is a schema
      // failure rather than an approval denial.
      if (!text.trim() && deniedPermission && !repairing)
        throw new Error(
          'Google could not complete this workflow because its requested tool was denied by the approval policy.',
        );
      let structured: unknown;
      if (request.schema) {
        let schemaError: string | undefined;
        try {
          structured = parseStructuredResponseText(text);
          const validation = validateAgainstSchema(request.schema, structured);
          if (!validation.ok)
            schemaError =
              validation.error ||
              'Response did not match the requested schema.';
        } catch (error) {
          schemaError =
            error instanceof Error
              ? error.message
              : 'Response was not valid JSON.';
        }
        if (schemaError) {
          if (attempt + 1 >= attempts)
            throw new Error(
              deniedPermission
                ? 'Google returned a response that does not match the required schema. A tool it requested while correcting the response was denied by the approval policy.'
                : 'Google returned a response that does not match the required schema.',
            );
          // Repairs start a new transcript message instead of extending the
          // rejected response.
          emit(
            projection.notice(
              'Correcting the response to match the required schema.',
            ),
          );
          prompt = `${buildCodexStructuredOutputRetryPrompt(
            request.schema,
            schemaError,
          )}\n\nOnly correct the response. Do not repeat earlier actions: tools that change files or run commands are unavailable for this correction.`;
          continue;
        }
      }
      resultEmitted = true;
      emit({
        type: 'result',
        is_error: false,
        session_id: sessionId,
        usage: cumulativeUsage,
        result: text,
      });
      return {
        status: 'success',
        sessionId,
        rawText: mask(text),
        transcript: `${transcript.join('\n')}\n`,
        usage: {
          inputTokens: cumulativeUsage?.input_tokens,
          outputTokens: cumulativeUsage?.output_tokens,
          cacheReadInputTokens: cumulativeUsage?.cache_read_input_tokens,
          cacheCreationInputTokens:
            cumulativeUsage?.cache_creation_input_tokens,
          reasoningOutputTokens: cumulativeUsage?.reasoning_tokens,
          messageCount: completedTurns,
          assistantMessageCount: completedTurns,
        },
        ...(structured !== undefined
          ? { structured: redactStructuredValue(structured, secrets) }
          : {}),
        ...(request.permissionPreset === 'plan'
          ? { proposedPlan: mask(extractProposedPlan(text) ?? '') }
          : {}),
      };
    }
  } catch (caught) {
    const error = updateError() ?? caught;
    const message = mask(
      withdrawal.reason === 'timeout'
        ? stepTimedOutMessage(request.totalTimeoutMs)
        : withdrawal.reason === 'cancelled'
          ? 'Google workflow was cancelled.'
          : error instanceof Error
            ? error.message
            : 'Google workflow failed.',
    );
    // Turns that completed before the failure still consumed native tokens.
    // A turn that threw before returning reported no usage to count.
    if (completedTurns > 0 && !resultEmitted)
      emit({
        type: 'result',
        is_error: true,
        session_id: sessionId,
        usage: cumulativeUsage,
        result: message,
      });
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
        message,
      },
    };
  } finally {
    finished = true;
    withdrawal.release();
    // A step withdrawn while the runtime was still opening returns now, but
    // the profile stays held until that late open settles and closes itself.
    // An open the step never adopted is closed before its profile is
    // released, even if it resolved just as the step was withdrawn. A late
    // open that never settles keeps the profile held for this process; that
    // fails closed (later runs report it as already running).
    const unadopted =
      !runtime && opening
        ? opening.then(
            (late) => late.close(),
            () => undefined,
          )
        : undefined;
    const releaseOwnedProfile = async (): Promise<void> => {
      try {
        await releaseProfile?.();
      } finally {
        if (profile) activeProfiles.delete(profile);
      }
    };
    try {
      await runtime?.close();
    } finally {
      try {
        if (unadopted && !openSettled)
          void unadopted
            .then(
              () => undefined,
              () => undefined,
            )
            .then(releaseOwnedProfile);
        else {
          await unadopted?.catch(() => undefined);
          await releaseOwnedProfile();
        }
      } finally {
        try {
          // Pending approvals end first, so a slow route or worker close
          // cannot keep one open.
          await host.dispose?.();
        } finally {
          try {
            // Routes, workers and delivered copies end with the step, also
            // when it was withdrawn while they were still opening.
            if (capabilities) await capabilities.close();
            else
              void preparing?.then(
                (late) => late.close().catch(() => undefined),
                () => undefined,
              );
          } catch {
            // Closing cannot change the step's result.
          }
        }
      }
    }
  }
}

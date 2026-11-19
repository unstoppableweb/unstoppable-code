import {
  parseOpenCodeReportedUsage,
  type OpenCodeReportedUsage,
} from '@canopy/protocol/remote-control/shell';
import { AcpClientError } from '../acp';
import {
  OpenCodeUpdateAccounting,
  type OpenCodeUpdateDiagnostics,
} from './update-diagnostics';
import {
  openCodeCapabilityDigest,
  openCodeCapabilityFiles,
  readOpenCodeCapabilityBinding,
  saveOpenCodeCapabilitySnapshot,
  type OpenCodeCapabilitySnapshot,
  type OpenCodeCapabilityBinding,
} from './capability-snapshot';
import { OpenCodeMetadataError, type OpenCodeUsage } from './runtime-api';
import {
  prepareOpenCodeInferenceRoute,
  assertOpenCodeInferenceBinding,
} from './inference-route';
import {
  readOpenCodeToolCatalog,
  openCodePromptUsage,
  readOpenCodeConnectionDigest,
} from './runtime-api';
import { openCodeMcpNativeKey } from './mcp-tool-identity';
import { openCodeToolDisplay } from './tool-display';
import type { ThinkingLevel } from '@canopy/protocol/thinking';
import type {
  ContentBlock,
  McpServer,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';
import { openCodeModelsFromConfig } from '@canopy/execution-engine/lib/opencode-models';
import { CursorEventProjection } from '../cursor/events';
import {
  startOpenCodeRuntime,
  type OpenCodeRuntimeOptions,
  type OwnedOpenCodeRuntime,
} from './runtime';

export interface OpenCodeTurnRequest extends Pick<
  OpenCodeRuntimeOptions,
  | 'runtimeIdentity'
  | 'executable'
  | 'spawnProcess'
  | 'processOwner'
  | 'prefix'
  | 'cwd'
  | 'profileDir'
  | 'env'
  | 'signal'
  | 'providerConfig'
  | 'inferenceRoute'
  | 'promptTimeoutMs'
  | 'skillDirectories'
> {
  rawModelId: string;
  thinkingLevel?: ThinkingLevel;
  secretValues?: readonly string[];
  model?: string;
  sessionId?: string;
  /** Explicit/headless resumes never replace missing provider context. */
  resumePolicy?: 'strict' | 'recover';
  contextReset?: boolean;
  capabilityContext?: unknown;
  capabilityRoots?: readonly string[];
  mcpSnapshot?: OpenCodeCapabilitySnapshot['mcp'];
  /** Interactive changes are announced; unattended resumes require an exact table. */
  capabilityChanges?: 'announce' | 'reject';
  prompt: string;
  /** Attachment bytes prepared by the host from an explicit user selection. */
  promptContent?: ContentBlock[];
  instructions?: string;
  /** Host-owned visible history; acknowledged only for this native session. */
  initialContext?: { text: string; appliedSessionId?: string };
  mcpServers?: McpServer[];
}

export interface OpenCodeTurnHost {
  authorize: OpenCodeRuntimeOptions['authorize'];
  beforeTool?: OpenCodeRuntimeOptions['beforeTool'];
  afterTool?: OpenCodeRuntimeOptions['afterTool'];
  displayTool?: (tool: { name: string; input: unknown; kind?: string }) => {
    name: string;
    input: unknown;
  };
  emit(event: Record<string, unknown>): void | Promise<void>;
  onSession?(
    sessionId: string,
    capabilities: OpenCodeCapabilityBinding,
  ): void | Promise<void>;
  onSessionCleared?(): void;
  beforePrompt?(): Promise<void>;
  onPromptAccepted?(): void;
  onToolCompleted?(name: string, input: unknown): void;
  /**
   * Each transcript tool block the turn writes. `toolCallId` is the ACP call
   * the block shows, set only once that call has reached `authorize`, so a
   * host can tie its own decision for the call to the transcript's
   * `toolUseId`. The ACP title and input are provider-reported and never
   * establish identity.
   */
  onToolBlock?(block: { toolUseId: string; toolCallId?: string }): void;
}

/** A local admission refusal, never a provider transport or cleanup failure. */
class OpenCodeRequestError extends Error {}

export interface OpenCodeTurnResult {
  /** An explicit worker refusal before prompt submission. */
  requestRejected?: boolean;
  diagnostics?: OpenCodeUpdateDiagnostics;
  sessionId?: string;
  responseText: string;
  isError: boolean;
  cancelled: boolean;
  message: string;
  /** Redacted ACP explanation for Copy details, separate from the headline. */
  providerErrorDetails?: string;
  usage?: OpenCodeUsage;
}

/** New/load, exact model selection, streaming and cancellation share one driver. */
export async function runOpenCodeTurn(
  request: OpenCodeTurnRequest,
  host: OpenCodeTurnHost,
): Promise<OpenCodeTurnResult> {
  let runtime: OwnedOpenCodeRuntime | undefined;
  const accounting = new OpenCodeUpdateAccounting();
  let sessionId = request.sessionId;
  let loading = true;
  let context: OpenCodeReportedUsage['context'];
  let submittingPrompt = false;
  let promptAccepted = false;
  const admitPrompt = (): void => {
    if (!promptAccepted && !request.signal.aborted) {
      promptAccepted = true;
      host.onPromptAccepted?.();
    }
  };
  let contextLost = request.contextReset === true;
  let capabilitiesChanged = false;
  let previous: OpenCodeCapabilityBinding | undefined;
  // The authorized ACP call the projection is writing a block for, if any.
  let authorizedCallId: string | undefined;
  // Gated calls that completed: a trailing update for the same invocation
  // still shows that call. A new tool_call reusing the ID is gated again.
  const completedCalls = new Set<string>();
  const projection = new CursorEventProjection(
    'OpenCode response exceeded the local chat limit.',
    {
      secretValues: request.secretValues,
      recognizeCursorErrors: false,
      onToolInvocation: (invocation): void =>
        host.onToolBlock?.({
          toolUseId: invocation.toolUseId,
          ...(authorizedCallId !== undefined
            ? { toolCallId: authorizedCallId }
            : {}),
        }),
      toolDisplay:
        host.displayTool ??
        ((tool): { name: string; input: unknown } =>
          openCodeToolDisplay(tool, request.cwd)),
    },
  );
  const tools = new Map<string, { name: string; input: unknown }>();
  try {
    const inference = request.inferenceRoute
      ? prepareOpenCodeInferenceRoute(request.inferenceRoute)
      : undefined;
    if (
      inference &&
      !inference.route.model.supportsVision &&
      request.promptContent?.some((block) => block.type === 'image')
    ) {
      throw new OpenCodeRequestError(
        'This OpenCode model does not support images. Remove them or choose another model.',
      );
    }
    if (inference && inference.rawModelId !== request.rawModelId)
      throw new OpenCodeRequestError(
        'OpenCode inference route does not match the selected model. Select the model again.',
      );
    if (sessionId) {
      previous = await readOpenCodeCapabilityBinding(
        request.profileDir,
        sessionId,
      );
      if (!previous) {
        if (request.resumePolicy !== 'recover')
          throw new OpenCodeRequestError(
            'OpenCode cannot verify the capabilities of this saved session. Start a new chat.',
          );
        contextLost = true;
        sessionId = undefined;
        host.onSessionCleared?.();
      }
    }
    if (previous) {
      // Legacy native snapshots never recorded a connection. Do not silently
      // attach their private history to whichever account happens to be active.
      if (!inference && previous.version === 1)
        throw new OpenCodeRequestError(
          "Couldn't verify the connection used by this saved OpenCode session. Start a new chat.",
        );
      try {
        assertOpenCodeInferenceBinding(
          previous,
          inference,
          request.capabilityChanges === 'announce',
        );
      } catch (error) {
        if (error instanceof Error)
          throw new OpenCodeRequestError(error.message);
        throw error;
      }
    }
    runtime = await startOpenCodeRuntime({
      ...request,
      inferenceRoute: inference?.route,
      beforeTool: host.beforeTool,
      afterTool: host.afterTool,
      authorize: async (input) => {
        const outcome = await host.authorize(input);
        tools.set(input.toolCallId, {
          name: input.toolName,
          input:
            outcome.decision === 'allow' && !outcome.stopTurn
              ? (outcome.updatedInput ?? input.toolArgs)
              : input.toolArgs,
        });
        return outcome;
      },
      onUpdate: async (notification) => {
        if (loading || notification.sessionId !== sessionId) return;
        const update = notification.update;
        accounting.observe(update);
        if (update.sessionUpdate === 'usage_update') {
          // ACP's cost is a session estimate; only its context belongs here.
          const reported = parseOpenCodeReportedUsage({
            context: { usedTokens: update.used, maxTokens: update.size },
          });
          if (
            !reported?.context ||
            (context?.usedTokens === reported.context.usedTokens &&
              context.maxTokens === reported.context.maxTokens)
          )
            return;
          context = reported.context;
          await host.emit({
            type: 'canopy_opencode_usage',
            provider: 'opencode',
            usage: { context },
          });
          return;
        }
        if (
          submittingPrompt &&
          ['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(
            update.sessionUpdate,
          )
        )
          admitPrompt();
        const tool =
          update.sessionUpdate === 'tool_call' ||
          update.sessionUpdate === 'tool_call_update'
            ? tools.get(update.toolCallId)
            : undefined;
        if (
          tool &&
          (update.sessionUpdate === 'tool_call' ||
            update.sessionUpdate === 'tool_call_update') &&
          update.status === 'completed'
        ) {
          tools.delete(update.toolCallId);
          completedCalls.add(update.toolCallId);
          host.onToolCompleted?.(tool.name, tool.input);
        } else if (update.sessionUpdate === 'tool_call' && !tool)
          completedCalls.delete(update.toolCallId);
        authorizedCallId =
          (tool &&
            (update.sessionUpdate === 'tool_call' ||
              update.sessionUpdate === 'tool_call_update')) ||
          (update.sessionUpdate === 'tool_call_update' &&
            completedCalls.has(update.toolCallId))
            ? update.toolCallId
            : undefined;
        let event: ReturnType<typeof projection.update>;
        try {
          event = projection.update(
            tool &&
              (update.sessionUpdate === 'tool_call' ||
                update.sessionUpdate === 'tool_call_update')
              ? {
                  ...notification,
                  update: { ...update, title: tool.name, rawInput: tool.input },
                }
              : notification,
          );
        } finally {
          authorizedCallId = undefined;
        }
        for (const flushed of projection.takeFlushed())
          await host.emit(flushed);
        if (event) await host.emit(event);
      },
    });
    const { client } = runtime;
    const promptCapabilities =
      client.getInitialization().agentCapabilities?.promptCapabilities;
    if (
      request.promptContent?.some(
        (block) =>
          (block.type === 'image' && !promptCapabilities?.image) ||
          (block.type === 'resource' && !promptCapabilities?.embeddedContext) ||
          (block.type === 'audio' && !promptCapabilities?.audio),
      )
    )
      throw new OpenCodeRequestError(
        'OpenCode does not support these attachments. Remove them or choose another harness.',
      );
    const mcpServers = request.mcpServers ?? [];
    if (
      mcpServers.length &&
      (!request.mcpSnapshot ||
        mcpServers.some(
          (server) =>
            !request.mcpSnapshot?.some((entry) => entry.name === server.name),
        ))
    )
      throw new OpenCodeRequestError(
        'OpenCode could not verify the selected MCP tools. Reconnect the servers and try again.',
      );
    const attach = async (): Promise<{
      sessionId?: string;
      configOptions?: SessionConfigOption[] | null;
    }> => {
      if (sessionId) {
        try {
          return await client.loadSession({
            sessionId,
            cwd: request.cwd,
            mcpServers,
          });
        } catch (error) {
          request.signal.throwIfAborted();
          // A pin that no longer advertises session/load is a known loss of
          // resumability. Generic provider or transport errors are not.
          let missing =
            error instanceof AcpClientError && error.code === 'unsupported';
          if (error instanceof AcpClientError && error.code === 'provider') {
            try {
              const metadata = await runtime?.readMetadata(
                `/sessions/${encodeURIComponent(sessionId)}`,
              );
              // V2 can reject load before initializing the location plugin.
              // Confirm absence through the complete ACP catalog in that case;
              // failed or incomplete pagination must preserve the saved context.
              if (metadata === undefined) {
                let cursor: string | undefined;
                const seen = new Set<string>();
                for (let page = 0; page < 100; page++) {
                  const result = await client.listSessions(
                    { cursor },
                    request.signal,
                  );
                  if (
                    result.sessions.some(
                      (entry) => entry.sessionId === sessionId,
                    )
                  )
                    break;
                  if (!result.nextCursor) {
                    missing = true;
                    break;
                  }
                  if (seen.has(result.nextCursor)) break;
                  seen.add(result.nextCursor);
                  cursor = result.nextCursor;
                }
              }
            } catch (metadataError) {
              missing =
                metadataError instanceof OpenCodeMetadataError &&
                metadataError.status === 404;
            }
          }
          if (!missing)
            throw new OpenCodeRequestError(
              'OpenCode could not resume this session. Check the connection and try again.',
            );
          if (request.resumePolicy !== 'recover')
            throw new OpenCodeRequestError(
              'OpenCode could not resume the requested session because its saved context is unavailable.',
            );
          contextLost = true;
          sessionId = undefined;
          previous = undefined;
          host.onSessionCleared?.();
        }
      }
      request.signal.throwIfAborted();
      return client.newSession({ cwd: request.cwd, mcpServers });
    };
    const attached = await attach();
    if ('sessionId' in attached && typeof attached.sessionId === 'string')
      sessionId = attached.sessionId;
    if (!sessionId)
      throw new OpenCodeRequestError('OpenCode did not create a session.');
    runtime.assertApprovalReady();
    const configOptions: SessionConfigOption[] = attached.configOptions ?? [];
    if (
      !openCodeModelsFromConfig(configOptions).some(
        (entry) => entry.rawModelId === request.rawModelId,
      )
    )
      throw new OpenCodeRequestError(
        'This OpenCode model is unavailable. Choose another model.',
      );
    const selected = await client.setSessionConfigOption(
      { sessionId, configId: 'model', value: request.rawModelId },
      request.signal,
    );
    if (
      !selected.configOptions.some(
        (option) =>
          option.id === 'model' && option.currentValue === request.rawModelId,
      )
    )
      throw new OpenCodeRequestError('OpenCode could not select this model.');
    if (request.thinkingLevel) {
      const effort = selected.configOptions.find(
        (option) => option.id === 'effort',
      );
      const supported =
        effort?.type === 'select' &&
        effort.options.some((option) =>
          'value' in option
            ? option.value === request.thinkingLevel
            : option.options.some(
                (choice) => choice.value === request.thinkingLevel,
              ),
        );
      const message =
        'OpenCode could not apply this thinking level. Choose another level and try again.';
      if (!supported) throw new OpenCodeRequestError(message);
      const applied = await client.setSessionConfigOption(
        { sessionId, configId: 'effort', value: request.thinkingLevel },
        request.signal,
      );
      if (
        !applied.configOptions.some(
          (option) =>
            option.id === 'effort' &&
            option.currentValue === request.thinkingLevel,
        ) ||
        !applied.configOptions.some(
          (option) =>
            option.id === 'model' && option.currentValue === request.rawModelId,
        )
      )
        throw new OpenCodeRequestError(message);
    }
    const owned = runtime;
    const connectionDigest = async (): Promise<string> => {
      try {
        return await readOpenCodeConnectionDigest(
          (pathname) => owned.readMetadata(pathname),
          request.rawModelId,
        );
      } catch (error) {
        // Stop during the read is a cancellation, not an admission refusal.
        request.signal.throwIfAborted();
        if (error instanceof Error)
          throw new OpenCodeRequestError(error.message);
        throw error;
      }
    };
    const nativeConnectionDigest = inference
      ? undefined
      : await connectionDigest();
    // The digest covers the provider too, so selecting another provider's
    // model is refused the same way as switching that provider's account.
    const connectionChanged = (): OpenCodeRequestError =>
      new OpenCodeRequestError(
        "Couldn't continue this chat because its OpenCode provider or connection changed. Switch back to the earlier model and connection, or start a new chat.",
      );
    if (previous && previous.nativeConnectionDigest !== nativeConnectionDigest)
      throw connectionChanged();
    const nativeTools = await readOpenCodeToolCatalog(
      () => owned.readMetadata('/tools'),
      (request.mcpSnapshot ?? []).flatMap((server) =>
        server.tools.map((tool) =>
          openCodeMcpNativeKey(server.name, tool.name),
        ),
      ),
      request.signal,
    );
    const snapshot: OpenCodeCapabilitySnapshot = {
      version: 1,
      runtime: {
        pin: request.runtimeIdentity,
        protocol: client.getInitialization().protocolVersion,
        agent: client.getInitialization().agentInfo,
        nativeTools,
      },
      contextDigest: openCodeCapabilityDigest(request.capabilityContext),
      providerSettingsDigest: runtime.providerSettingsDigest,
      ...(nativeConnectionDigest ? { nativeConnectionDigest } : {}),
      ...(inference ? { inferenceRouteDigest: inference.identityDigest } : {}),
      ...(inference?.selection
        ? { inferenceSelection: inference.selection }
        : {}),
      files: await openCodeCapabilityFiles(
        request.capabilityRoots ?? [],
        request.signal,
      ),
      mcp: request.mcpSnapshot ?? [],
    };
    const { inferenceSelection: addedSelection, ...legacySnapshot } = snapshot;
    const upgradesSelectionOnly =
      previous?.version === 2 &&
      addedSelection !== undefined &&
      previous.digest === openCodeCapabilityDigest(legacySnapshot);
    if (
      previous &&
      !upgradesSelectionOnly &&
      previous.digest !== openCodeCapabilityDigest(snapshot)
    ) {
      if (request.capabilityChanges !== 'announce')
        throw new OpenCodeRequestError(
          'OpenCode capabilities changed since this session was saved. Start a new chat to use the current selection.',
        );
      capabilitiesChanged = true;
    }
    request.signal.throwIfAborted();
    const capabilityBinding = await saveOpenCodeCapabilitySnapshot(
      request.profileDir,
      sessionId,
      snapshot,
      previous,
      request.signal,
    );
    await host.onSession?.(sessionId, capabilityBinding);
    await host.emit({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model: request.model,
      capability_snapshot: capabilityBinding.digest,
      resource_generation: capabilityBinding.generation,
    });
    if (contextLost || capabilitiesChanged) {
      await host.emit({
        type: 'canopy_assistant_patch',
        provider: 'opencode',
        messageId: `${sessionId}:capabilities:${capabilityBinding.generation}:${Date.now()}`,
        timestamp: Date.now(),
        revision: 1,
        role: 'system',
        patches: [
          {
            index: 0,
            block: {
              type: 'text',
              text: contextLost
                ? request.initialContext
                  ? 'Started a new OpenCode session because the previous session is unavailable. It will receive the copied fork text; context from later turns is unavailable.'
                  : 'Started a new OpenCode session because the previous session is unavailable. Earlier messages remain in this chat, but OpenCode no longer has their context.'
                : 'OpenCode capabilities changed. This turn uses the current selection of tools and skills.',
            },
          },
        ],
      });
    }
    runtime.activateSession(sessionId);
    loading = false;
    const prompt: ContentBlock[] = [
      {
        type: 'text',
        text: [
          request.instructions,
          request.initialContext?.appliedSessionId === sessionId
            ? undefined
            : request.initialContext?.text,
          request.prompt,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      ...(request.promptContent ?? []),
    ];
    if (
      request.promptContent?.length &&
      Buffer.byteLength(JSON.stringify(prompt)) > 7 * 1024 * 1024
    )
      throw new OpenCodeRequestError(
        'OpenCode attachments and instructions exceed the message size limit. Send fewer or smaller files.',
      );
    await host.beforePrompt?.();
    // Host preparation can wait for approvals. Check again after that wait;
    // interactive capability announcements never authorize an account switch.
    if (
      nativeConnectionDigest &&
      nativeConnectionDigest !== (await connectionDigest())
    )
      throw connectionChanged();
    request.signal.throwIfAborted();
    submittingPrompt = true;
    const response = await client.prompt(
      { sessionId, prompt },
      1,
      request.signal,
    );
    if (response.stopReason === 'end_turn') admitPrompt();
    const usage = openCodePromptUsage(response.usage);
    // Injected model metadata has no native prices. App billing is host-owned.
    if (inference && usage) delete usage.estimated_cost_usd;
    if (usage || context)
      await host.emit({
        type: 'canopy_opencode_usage',
        provider: 'opencode',
        usage: {
          ...(context ? { context } : {}),
          ...(usage
            ? {
                turn: {
                  inputTokens: usage.input_tokens,
                  outputTokens: usage.output_tokens - usage.reasoning_tokens,
                  reasoningTokens: usage.reasoning_tokens,
                  cacheReadTokens: usage.cache_read_input_tokens,
                  cacheWriteTokens: usage.cache_creation_input_tokens,
                  ...(usage.estimated_cost_usd !== undefined
                    ? { estimatedCostUsd: usage.estimated_cost_usd }
                    : {}),
                },
              }
            : {}),
        },
      });
    for (const event of projection.finish()) await host.emit(event);
    const cancelled = response.stopReason === 'cancelled';
    const isError = !cancelled && response.stopReason !== 'end_turn';
    return {
      sessionId,
      diagnostics: accounting.snapshot(),
      responseText: projection.getResponseText(),
      usage,
      cancelled,
      isError,
      message: cancelled
        ? 'Turn cancelled'
        : isError
          ? 'OpenCode stopped before finishing. Send a follow-up to continue.'
          : '',
    };
  } catch (error) {
    for (const event of projection.finish()) await host.emit(event);
    return {
      ...(error instanceof AcpClientError &&
      !request.signal.aborted &&
      error.providerDetails
        ? { providerErrorDetails: error.providerDetails }
        : {}),
      sessionId,
      diagnostics: accounting.snapshot(),
      responseText: projection.getResponseText(),
      ...(error instanceof OpenCodeRequestError && !submittingPrompt
        ? { requestRejected: true }
        : {}),
      cancelled: request.signal.aborted,
      isError: !request.signal.aborted,
      message: request.signal.aborted
        ? 'Turn cancelled'
        : error instanceof Error
          ? error.message
          : 'OpenCode failed to complete this turn.',
    };
  } finally {
    await runtime?.close();
  }
}

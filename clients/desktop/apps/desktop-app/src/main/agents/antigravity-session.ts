import { managedDelegationEnabled } from './delegation/gate';
import type { ManagedDelegationSession } from './delegation/service';
import {
  openAntigravityExtensions,
  type AntigravityExtensions,
} from '../antigravity/extensions';
import {
  openAntigravityAppTools,
  type AntigravityAppTools,
} from '../antigravity/app-tools';
import { assertAntigravityHarnessEnabled } from '../antigravity/feature-flag';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { createHash, randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type {
  NewSessionResponse,
  ResumeSessionResponse,
} from '@agentclientprotocol/sdk';
import type { ApprovalMode } from '@canopy/desktop-shared/types';
import { clampThinkingLevelToDeclared } from '@canopy/protocol/thinking';
import type { TurnBinding } from '@canopy/protocol/canopy-core';
import {
  antigravityModelsFromConfig,
  getRawAntigravityModelId,
  isAntigravityModel,
} from '@canopy/execution-engine/lib/antigravity-models';
import { CursorEventProjection } from '@canopy/desktop-shared/node/cursor/events';
import {
  readAntigravityAttachments,
  assertAntigravityAttachmentCapabilities,
} from '@canopy/desktop-shared/node/antigravity/prompt';
import { isAntigravitySessionMissing } from '@canopy/desktop-shared/node/antigravity/recovery';
import { antigravityTokenUsage } from '@canopy/desktop-shared/node/antigravity/usage';
import { assertAgentWorkerContext } from '../agent-runs/agent-worker-context';
import {
  antigravityProfileDirectory,
  openAntigravityRuntime,
  type AntigravityRuntime,
} from '../antigravity/runtime';
import { authorizeAntigravityTool } from '../antigravity/tool-approval';
import { isAntigravityConnectionEnabled } from '../antigravity/connection';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  buildSessionKey,
  drainChatSessionEvents,
  registerSession,
} from './session-manager';
import {
  getTurnLifecycleProducer,
  releaseTurnLifecycleProducer,
} from './provider-turn-lifecycle';
import { observeRoutedTurnBinding } from './session-event-router';
import { createOwnedTurnState } from './owned-turn-state';
import {
  TranscriptForkContext,
  readTranscriptRecoveryPrompt,
} from './transcript-fork-context';
import { CursorEventBuffer } from './cursor-event-buffer';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionOptions,
  AgentSessionSendOptions,
  AgentSessionTurnSettings,
} from './types';

/** Personal Google subscriptions execute only inside the existing worker turn. */
export class AntigravityProvider implements AgentProvider {
  createSession(
    opts: AgentSessionOptions,
    onEvent: (event: unknown) => void | Promise<void>,
    getWindow: () => BrowserWindow | null,
  ): AgentSession {
    assertAgentWorkerContext('AntigravityProvider.createSession');
    const key = buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId);
    const scope = {
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
    };
    const lifecycle = getTurnLifecycleProducer('antigravity', scope);
    const forkContext = new TranscriptForkContext(
      scope,
      'Google',
      `fork-context-${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`,
    );
    const lifetime = new AbortController();
    const turnState = createOwnedTurnState(key, () => session);
    let managedDelegation: ManagedDelegationSession | undefined;
    let currentTurn: string | undefined;
    let currentMessage: string | undefined;
    let sessionId = opts.sdkSessionId;
    let model = opts.model;
    let thinking = opts.thinkingLevel;
    let turnSettings: AgentSessionTurnSettings | undefined;
    let planMode = opts.planMode === true;
    let approvalMode: ApprovalMode = opts.approvalMode ?? 'ask';
    let active: { abort: AbortController; done: Promise<void> } | undefined;
    let approval: ApprovalSessionHandle | undefined;
    let runtime: AntigravityRuntime | undefined;

    const emit = async (
      event: Record<string, unknown>,
      userMessageId?: string,
    ): Promise<void> => {
      const data = {
        ...event,
        provider: 'antigravity',
        ...(userMessageId
          ? { canopy_turn_user_message_id: userMessageId }
          : {}),
      };
      managedDelegation?.observe(data, userMessageId);
      turnState.recordSessionEvent(data);
      await onEvent(data);
    };

    const run = async (
      text: string,
      abort: AbortController,
      send: AgentSessionSendOptions | undefined,
      buffer: CursorEventBuffer,
      updateFailure: { message?: string },
      requested: AgentSessionTurnSettings,
    ): Promise<Record<string, unknown>> => {
      const assertCurrent = (): void => {
        if (lifetime.signal.aborted || !turnState.ownsKeyResources())
          abort.abort();
        abort.signal.throwIfAborted();
      };
      assertCurrent();
      await emit(
        { type: 'canopy_turn_usage', usage: null },
        send?.userMessageId,
      );
      assertCurrent();
      const worker = assertAgentWorkerContext('AntigravityProvider.turn');
      assertAntigravityHarnessEnabled();
      if (!(await isAntigravityConnectionEnabled())) {
        throw new Error(
          'Antigravity is disconnected or its connection setting could not be read. Check its connection in Settings before sending another message.',
        );
      }
      const rawModel = getRawAntigravityModelId(requested.model ?? '');
      if (
        !rawModel ||
        !rawModel.startsWith('gemini-') ||
        opts.aiCreditsRouting?.active ||
        opts.accountProxyRouting === 'proxy'
      )
        throw new Error('Choose a Google subscription model for this chat.');
      if (opts.assistantMode && opts.assistantMode !== 'default')
        throw new Error(
          'Google subscription models are currently available in workspace chats.',
        );
      if (opts.inheritedCapabilityOverlay)
        throw new Error(
          'Google does not support inherited agent capabilities yet.',
        );
      const attachments = await readAntigravityAttachments(
        send?.attachments,
        abort.signal,
      );
      assertCurrent();
      const projection = new CursorEventProjection(
        'Google response exceeded the local chat limit.',
        { recognizeCursorErrors: false },
      );
      const currentApproval = createApprovalSession({
        sessionKey: key,
        ...scope,
        provider: 'antigravity',
        workspaceRoot: opts.cwd,
        mode: approvalMode,
        sessionRules: opts.sessionApprovalRules ?? [],
        getWindow,
        getTurnUserMessageId: () => send?.userMessageId,
        promptTimeoutMs: 240_000,
      });
      approval = currentApproval;
      let appTools: AntigravityAppTools | undefined;
      let extensions: AntigravityExtensions | undefined;
      try {
        if (!managedDelegation && managedDelegationEnabled(opts)) {
          const { createManagedDelegationSession } =
            await import('./delegation/service');
          const created = await createManagedDelegationSession({
            harness: 'antigravity',
            sessionKey: key,
            getWindow,
            currentTurn: (): string | undefined => currentTurn,
            currentMessage: (): string | undefined => currentMessage,
            currentOptions: () => ({
              ...opts,
              model,
              selectedModel: model,
              thinkingLevel: thinking,
              approvalMode,
              planMode,
              // The parent projection is not a complete child capability snapshot.
              // Withhold automatic inheritance until its content, MCP schemas
              // and permissions can be bound to the child execution.
              pluginSelections: undefined,
              packageOverlay: undefined,
              applyGlobalPluginDefaults: false,
              inheritedCapabilityOverlay: undefined,
              deferredToolsAllowed: false,
            }),
            onTranscript: (delegation, options) => {
              void emit(
                {
                  type: 'canopy_delegation',
                  delegation,
                  ...(options?.replay ? { canopy_replay: true } : {}),
                },
                delegation.parentTurnId,
              ).catch((error: unknown) =>
                logMainProcessWarn(
                  '[antigravity-session] Delegation transcript delivery failed',
                  error,
                ),
              );
            },
          });
          if (lifetime.signal.aborted) created.detach();
          else managedDelegation = created;
        }
        abort.signal.throwIfAborted();
        extensions = await openAntigravityExtensions({
          sessionKey: key,
          options: opts,
          approval: currentApproval,
          signal: abort.signal,
          planMode,
          stopTurn: () => abort.abort(),
          ownsSessionResources: () => turnState.ownsKeyResources(),
        });
        assertCurrent();
        const opened = await openAntigravityRuntime({
          cwd: opts.cwd,
          owner: { kind: worker.kind, id: worker.runId },
          onUpdate: async (update): Promise<void> => {
            if (
              abort.signal.aborted ||
              lifetime.signal.aborted ||
              !turnState.ownsKeyResources()
            )
              return;
            try {
              const event = projection.update(update);
              for (const flushed of projection.takeFlushed())
                await buffer.push(flushed);
              if (event) await buffer.push(event);
            } catch (error) {
              updateFailure.message =
                error instanceof Error ? error.message : 'Google chat failed.';
              abort.abort();
            }
          },
          onPermission: async (request) => {
            if (
              abort.signal.aborted ||
              lifetime.signal.aborted ||
              !turnState.ownsKeyResources()
            )
              return 'deny';
            const decision = await authorizeAntigravityTool(request, {
              approval: currentApproval,
              cwd: opts.cwd,
              planMode,
              stopTurn: () => abort.abort(),
            });
            return abort.signal.aborted ||
              lifetime.signal.aborted ||
              !turnState.ownsKeyResources()
              ? 'deny'
              : decision;
          },
        });
        runtime = opened;
        abort.signal.addEventListener('abort', () => opened.client.close(), {
          once: true,
        });
        assertCurrent();
        assertAntigravityAttachmentCapabilities(
          attachments,
          opened.client.getInitialization(),
        );
        if (
          opened.client.getInitialization().agentCapabilities?.mcpCapabilities
            ?.http !== true
        )
          throw new Error(
            'This Antigravity runtime does not support app tools. Update Antigravity and try again.',
          );
        appTools = await openAntigravityAppTools({
          sessionKey: key,
          options: { ...opts, model: requested.model, sdkSessionId: sessionId },
          approval: currentApproval,
          signal: abort.signal,
          planMode,
          stopTurn: () => abort.abort(),
          onAwaitingUser: () => turnState.markTurnAwaitingUser(),
          ownsSessionResources: () => turnState.ownsKeyResources(),
          ...(managedDelegation && currentTurn
            ? {
                delegation: {
                  session: managedDelegation,
                  turnId: currentTurn,
                  currentTurn: (): string | undefined => currentTurn,
                },
              }
            : {}),
        });
        const append = [
          opts.globalInstructionsBlock,
          opts.globalInstructionsSnapshot,
          opts.systemPromptAppend,
          appTools.instructions,
          managedDelegation?.systemPromptGuidance,
          extensions.instructions,
        ]
          .filter(Boolean)
          .join('\n\n');
        const params = {
          cwd: opts.cwd,
          mcpServers: [...appTools.servers, ...extensions.servers],
          _meta: { antigravity: { systemPrompt: { append } } },
        };
        assertCurrent();
        let recoveryContext: string | undefined;
        const native = await (async (): Promise<
          NewSessionResponse | ResumeSessionResponse
        > => {
          if (!sessionId) return opened.client.newSession(params);
          try {
            return await opened.client.resumeSession({ ...params, sessionId });
          } catch (error) {
            assertCurrent();
            if (
              !(await isAntigravitySessionMissing(
                opened.client,
                error,
                sessionId,
                abort.signal,
              ))
            )
              throw error;
            assertCurrent();
            recoveryContext = await readTranscriptRecoveryPrompt(
              scope,
              send?.userMessageId,
            );
            assertCurrent();
            return opened.client.newSession(params);
          }
        })();
        assertCurrent();
        const entries = antigravityModelsFromConfig(native.configOptions);
        const entry = entries.find(
          (candidate) => candidate.rawModelId === rawModel,
        );
        if (!entry)
          throw new Error(
            'This Google model is unavailable on your account. Refresh models and choose an available model.',
          );
        const nativeSessionId =
          'sessionId' in native && typeof native.sessionId === 'string'
            ? native.sessionId
            : sessionId;
        if (!nativeSessionId)
          throw new Error('Google did not create a conversation.');
        await opened.client.setSessionConfigOption({
          sessionId: nativeSessionId,
          configId: 'model',
          value: rawModel,
        });
        assertCurrent();
        const turnThinking =
          requested.thinkingLevel && entry.supportedThinkingLevels.length > 0
            ? clampThinkingLevelToDeclared(
                requested.thinkingLevel,
                entry.supportedThinkingLevels,
              )
            : undefined;
        if (turnThinking) {
          await opened.client.setSessionConfigOption({
            sessionId: nativeSessionId,
            configId: 'thought_level',
            value: turnThinking,
          });
        }
        assertCurrent();
        await opened.client.setSessionConfigOption({
          sessionId: nativeSessionId,
          configId: 'mode',
          value: planMode ? 'plan' : 'default',
        });
        assertCurrent();
        turnSettings = {
          model: requested.model,
          ...(turnThinking ? { thinkingLevel: turnThinking } : {}),
        };
        const publishSession = async (): Promise<void> => {
          assertCurrent();
          await emit(
            {
              type: 'system',
              subtype: 'init',
              session_id: nativeSessionId,
              model: requested.model,
            },
            send?.userMessageId,
          );
          await drainChatSessionEvents(
            opts.projectId,
            opts.worktreeId,
            opts.chatId,
          );
          sessionId = nativeSessionId;
        };
        // A failed or cancelled replacement must leave the missing ID saved.
        // Otherwise a reload could resume the new session without its history.
        if (recoveryContext === undefined) await publishSession();
        const extensionNotices = managedDelegation
          ? [
              ...extensions.notices,
              'Subagents do not automatically inherit the skills, plugins, commands or MCP servers selected for this chat.',
            ]
          : extensions.notices;
        if (extensionNotices.length > 0) {
          // Use the shared system transcript notice, so desktop and Portal
          // persist the explanation without attributing it to the model.
          await emit(
            {
              type: 'canopy_assistant_patch',
              messageId: `google-defaults:${randomUUID()}`,
              timestamp: Date.now(),
              revision: 1,
              role: 'system',
              patches: [
                {
                  index: 0,
                  block: {
                    type: 'text',
                    text: `Google extension notes:\n- ${extensionNotices.join('\n- ')}`,
                  },
                },
              ],
            },
            send?.userMessageId,
          );
        }
        if (recoveryContext !== undefined) {
          assertCurrent();
          await emit(
            {
              type: 'canopy_assistant_patch',
              messageId: `google-recovery:${randomUUID()}`,
              timestamp: Date.now(),
              revision: 1,
              role: 'system',
              patches: [
                {
                  index: 0,
                  block: {
                    type: 'text',
                    text: "Google's saved conversation is unavailable. Continuing with this chat's saved messages; earlier attachment contents may need to be attached again.",
                  },
                },
              ],
            },
            send?.userMessageId,
          );
        }
        const profile = antigravityProfileDirectory();
        const inheritedContext =
          recoveryContext ??
          (await forkContext.prompt(
            profile,
            nativeSessionId,
            send?.userMessageId,
          ));
        assertCurrent();
        const expanded = extensions.expandPrompt(text);
        const prompt = inheritedContext
          ? `${inheritedContext}\n\n${expanded}`
          : expanded;
        const result = await opened.client.prompt(
          {
            sessionId: nativeSessionId,
            prompt: [
              {
                type: 'text',
                text: managedDelegation?.applyPolicyGuidance(prompt) ?? prompt,
              },
              ...attachments,
            ],
          },
          1,
          abort.signal,
        );
        assertCurrent();
        if (updateFailure.message !== undefined)
          throw new Error(updateFailure.message);
        if (result.stopReason === 'end_turn') {
          if (inheritedContext)
            await forkContext.delivered(profile, nativeSessionId);
          if (recoveryContext !== undefined) await publishSession();
        }
        for (const event of projection.finish()) await buffer.push(event);
        const isError =
          result.stopReason !== 'end_turn' && result.stopReason !== 'cancelled';
        // Explain native refusal or turn limits instead of repeating streamed text.
        const stopMessage =
          result.stopReason === 'refusal'
            ? "Couldn't complete the request because Google declined it. Rephrase your request or choose another model."
            : "Couldn't finish the response because Google reached a limit for this turn. Send a follow-up to continue.";
        return {
          type: 'result',
          is_error: isError,
          usage: antigravityTokenUsage(result.usage),
          ...(result.stopReason === 'cancelled'
            ? { subtype: 'cancelled' }
            : {}),
          // Audit and worker consumers use the shared cancellation result text.
          result:
            result.stopReason === 'cancelled'
              ? 'Turn cancelled'
              : isError
                ? stopMessage
                : projection.getResponseText(),
        };
      } finally {
        appTools?.close();
        currentApproval.invalidatePending?.();
        currentApproval.dispose();
        approval = undefined;
        const opened = runtime;
        runtime = undefined;
        try {
          await opened?.close();
        } finally {
          await extensions?.close();
        }
      }
    };

    const session: AgentSession = {
      sendMessage(text, send): void {
        if (lifetime.signal.aborted)
          throw new Error('This Google session has ended.');
        if (active)
          throw new Error('Wait for the current Google response to finish.');
        const abort = new AbortController();
        const turnId =
          send?.lifecycleExecutionId ?? send?.userMessageId ?? randomUUID();
        currentTurn = turnId;
        currentMessage = send?.userMessageId;
        const binding: TurnBinding = {
          turnId,
          origin: 'user',
          binding: send?.userMessageId ? 'bound' : 'unbound',
          submissionIds: [],
          userMessageIds: send?.userMessageId ? [send.userMessageId] : [],
          providerUserMessageUuids: [],
        };
        const buffer = new CursorEventBuffer(async (event): Promise<void> => {
          await emit(event, send?.userMessageId);
          await drainChatSessionEvents(
            opts.projectId,
            opts.worktreeId,
            opts.chatId,
          );
        });
        turnState.markTurnActive(send?.userMessageId);
        lifecycle.turnStarted({
          ...binding,
          phase: 'start',
          startedAtMs: Date.now(),
          ...(sessionId ? { providerSessionId: sessionId } : {}),
        });
        if (send?.userMessageId)
          observeRoutedTurnBinding(
            scope,
            session,
            [send.userMessageId],
            undefined,
            turnId,
          );
        lifecycle.sessionState({
          state: 'running',
          source: 'provider',
          observedDuringTurnId: turnId,
        });
        const updateFailure: { message?: string } = {};
        turnSettings = undefined;
        const done = run(text, abort, send, buffer, updateFailure, {
          model,
          thinkingLevel: thinking,
        })
          .catch((error: unknown) => ({
            type: 'result',
            is_error: !abort.signal.aborted,
            result: abort.signal.aborted
              ? 'Turn cancelled'
              : error instanceof Error
                ? error.message
                : 'Google chat failed.',
            ...(abort.signal.aborted ? { subtype: 'cancelled' } : {}),
          }))
          .then(async (value: Record<string, unknown>): Promise<void> => {
            const result =
              updateFailure.message === undefined
                ? abort.signal.aborted
                  ? {
                      ...value,
                      is_error: false,
                      subtype: 'cancelled',
                      result: 'Turn cancelled',
                    }
                  : value
                : {
                    type: 'result',
                    is_error: true,
                    result: updateFailure.message,
                  };
            try {
              await buffer.flush();
              await drainChatSessionEvents(
                opts.projectId,
                opts.worktreeId,
                opts.chatId,
              );
              lifecycle.turnEnded({
                ...binding,
                endedAtMs: Date.now(),
                outcome:
                  updateFailure.message !== undefined
                    ? 'failed'
                    : abort.signal.aborted || result.subtype === 'cancelled'
                      ? 'cancelled'
                      : result.is_error
                        ? 'failed'
                        : 'completed',
                source: 'result',
                ...(sessionId ? { providerSessionId: sessionId } : {}),
              });
              lifecycle.sessionState({
                state: 'idle',
                source: 'result-fallback',
                observedDuringTurnId: turnId,
              });
              await emit(
                result.is_error === true
                  ? { type: 'error', error: result.result }
                  : result,
                send?.userMessageId,
              );
            } finally {
              currentTurn = undefined;
              currentMessage = undefined;
              managedDelegation?.retireTurn();
              active = undefined;
              turnState.markTurnIdle();
            }
          })
          .catch((error: unknown): void => {
            logMainProcessWarn(
              '[antigravity-session] Event delivery failed',
              error,
            );
          });
        active = { abort, done };
      },
      isDisposed: () => lifetime.signal.aborted,
      getProviderSessionId: () => sessionId,
      getAppliedApprovalMode: () => approvalMode,
      getAppliedApprovalRules: () => opts.sessionApprovalRules ?? [],
      cancel: async (): Promise<void> => {
        active?.abort.abort();
        approval?.invalidatePending?.();
        managedDelegation?.retireTurn();
        await active?.done;
      },
      destroy: async (): Promise<void> => {
        if (lifetime.signal.aborted) return;
        lifetime.abort();
        try {
          await session.cancel();
        } finally {
          managedDelegation?.detach();
          releaseTurnLifecycleProducer('antigravity', scope);
        }
      },
      setManagedDelegationMode: (mode): Promise<void> => {
        opts.managedDelegationMode = mode;
        if (mode !== undefined) managedDelegation?.updatePolicy(mode);
        return Promise.resolve();
      },
      setPlanMode: (enabled): Promise<void> => {
        if (active) throw new Error('Stop Google before changing plan mode.');
        planMode = enabled;
        return Promise.resolve();
      },
      setApprovalMode: async (mode): Promise<void> => {
        const previous = approvalMode;
        approvalMode = mode;
        approval?.setMode(mode);
        await approval?.reevaluatePendingApprovals(mode, previous);
      },
      settingApplication: { model: 'next_turn', thinkingLevel: 'next_turn' },
      getAppliedTurnSettings: () =>
        turnSettings ? { ...turnSettings } : undefined,
      setThinkingLevel: (level): Promise<void> => {
        thinking = level;
        return Promise.resolve();
      },
      setModel: (next): Promise<void> => {
        if (!isAntigravityModel(next))
          throw new Error('Choose a Google subscription model.');
        model = next;
        return Promise.resolve();
      },
    };
    registerSession(
      key,
      session,
      lifetime,
      'antigravity',
      opts.model,
      opts.assistantMode,
      opts.toolProfileHash,
      false,
      'antigravity',
    );
    return session;
  }
}

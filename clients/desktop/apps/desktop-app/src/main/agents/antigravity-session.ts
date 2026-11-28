import type { SessionResumeFailure } from '@canopy/protocol/session-recovery';
import { managedDelegationEnabled } from './delegation/gate';
import { assertAntigravityMcpServersRouted } from '@canopy/desktop-shared/node/antigravity/runtime';
import type { ManagedDelegationSession } from './delegation/service';
import {
  openAntigravityExtensions,
  type AntigravityExtensions,
} from '../antigravity/extensions';
import {
  antigravityAppToolServerNames,
  openAntigravityAppTools,
  type AntigravityAppTools,
} from '../antigravity/app-tools';
import { assertAntigravityHarnessEnabled } from '../antigravity/feature-flag';
import {
  mayExposeLedgerTools,
  openLedgerChatTools,
  type LedgerChatSettings,
  type LedgerChatTarget,
  type LedgerChatToolsSession,
} from '../canopy-tools/ledger-tools-runtime';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  captureAntigravityCapabilitySnapshot,
  saveAntigravityCapabilitySnapshot,
  type AntigravityToolListCache,
} from '../antigravity/capability-snapshot';
import type { EffectiveCapabilitySnapshot } from '@canopy/desktop-shared/node/capabilities/effective-snapshot';
import {
  logMainProcessInfo,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { AgentInterfacePort } from './agent-interface-port';
import type {
  NewSessionResponse,
  ResumeSessionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type {
  ApprovalMode,
  PlanExitRequestEvent,
} from '@canopy/desktop-shared/types';
import type { TurnBinding } from '@canopy/protocol/canopy-core';
import {
  antigravityModelsFromConfig,
  getRawAntigravityModelId,
  isAntigravityModel,
} from '@canopy/execution-engine/lib/antigravity-models';
import {
  ANTIGRAVITY_DENIED_STOP_MESSAGE,
  createAntigravityEventProjection,
} from '@canopy/desktop-shared/node/antigravity/event-projection';
import type { AntigravityToolRoutes } from '@canopy/desktop-shared/node/antigravity/tool-display';
import { normalizeCanopyMcpServerDisplayName } from '@canopy/desktop-shared/lib/turn-utils';
import {
  readAntigravityAttachments,
  readAntigravityHistoricalAttachments,
  antigravityHistoryNotice,
  antigravityPromptContent,
  antigravityUnrestoredCounts,
  assertAntigravityAttachmentCapabilities,
  type AntigravityHistoricalAttachments,
} from '@canopy/desktop-shared/node/antigravity/prompt';
import {
  AntigravityResumeFailure,
  antigravityResumeFailure,
  isAntigravitySessionMissing,
} from '@canopy/desktop-shared/node/antigravity/recovery';
import { antigravityTokenUsage } from '@canopy/desktop-shared/node/antigravity/usage';
import {
  ANTIGRAVITY_ARTIFACT_NOT_WRITTEN_MESSAGE,
  ANTIGRAVITY_PLAN_ARTIFACT_MESSAGE,
  antigravityPlanArtifact,
  collectAntigravityPlanProposal,
} from '@canopy/desktop-shared/node/antigravity/plan-proposal';
import {
  antigravityWorkspaceRootsBlock,
  readAntigravityRepositoryInstructions,
} from '@canopy/desktop-shared/node/antigravity/repository-instructions';
import {
  AntigravitySessionConfigError,
  applyAntigravitySessionConfig,
} from '@canopy/desktop-shared/node/antigravity/session-config';
import { getAntigravityModelEntries } from '@canopy/execution-engine/model-catalog';
import { markAntigravityCatalogStale } from '../antigravity/models';
import { assertAgentWorkerContext } from '../agent-runs/agent-worker-context';
import { resolveAgentAttachmentsDirCandidates } from '../lib/agent-attachments';
import {
  antigravityProfileDirectory,
  openAntigravityRuntime,
  type AntigravityRuntime,
} from '../antigravity/runtime';
import { authorizeAntigravityToolCall } from '../antigravity/tool-approval';
import { additionalDirectoriesParam } from '@canopy/desktop-shared/node/acp/capabilities';
import { antigravityAdditionalDirectories } from '../antigravity/workspace-directories';
import { isAntigravityConnectionEnabled } from '../antigravity/connection';
import { getAttentionTracker } from '../services/attention-tracker';
import { commitPendingPlanExit } from '../services/chat-state-plan-exit';
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
  type TranscriptContext,
} from './transcript-fork-context';
import { CursorEventBuffer } from './cursor-event-buffer';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionOptions,
  AgentSessionSendOptions,
  AgentSessionTurnSettings,
} from './types';

/** How long a finished turn waits for capability discovery before stopping it. */
const SNAPSHOT_GRACE_MS = 250;

/** Personal Google subscriptions execute only inside the existing worker turn. */
export class AntigravityProvider implements AgentProvider {
  createSession(
    opts: AgentSessionOptions,
    onEvent: (event: unknown) => void | Promise<void>,
    interfacePort: AgentInterfacePort,
  ): AgentSession {
    assertAgentWorkerContext('AntigravityProvider.createSession');
    const getWindow = (): BrowserWindow | null => interfacePort.legacyWindow();
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
    const toolLists: AntigravityToolListCache = new Map();
    // Default-mode worktree chats only, as for OpenCode and Copilot.
    const codeGraphToolsAdvertised =
      !isCoworkWorkspace(opts.projectId) &&
      (!opts.assistantMode || opts.assistantMode === 'default') &&
      opts.codeGraphToolsAdvertised === true;
    // Feed tools are decided once per session, when the first turn registers
    // the app route: later turns neither add nor drop them, and each call
    // re-checks the flag and the setting.
    const ledgerTarget: LedgerChatTarget = {
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
      ...(opts.assistantMode ? { assistantMode: opts.assistantMode } : {}),
    };
    const ledger: { decided: boolean; tools: LedgerChatToolsSession | null } = {
      decided: false,
      tools: null,
    };
    let ledgerSettings: LedgerChatSettings = {
      model: model ?? null,
      thinkingEffort: null,
      planMode,
    };
    lifetime.signal.addEventListener(
      'abort',
      () => {
        ledger.tools?.dispose();
        ledger.tools = null;
      },
      { once: true },
    );

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
      // Advertised route name -> the server's original name, filled once this
      // turn's routes are known; tool calls cannot arrive before then.
      const routeNames = new Map<string, string>();
      const routes: AntigravityToolRoutes = {
        canonicalNameFor: (
          server: string,
          tool: string,
        ): { server: string; tool: string } | undefined => {
          const original = routeNames.get(server);
          return original === undefined
            ? undefined
            : { server: original, tool };
        },
      };
      // Why each native call this turn was denied, by ACP tool call id: the
      // runtime reports a denial as an empty failure, and ACP cannot carry it.
      const deniedTools = new Map<string, string>();
      // What an artifact write's row says if the runtime fails it empty. Kept
      // apart from real denials, so a completed write never reads as denied.
      const artifactMessages = new Map<string, string>();
      let lastToolCallId: string | undefined;
      const projection = createAntigravityEventProjection({
        limitMessage: 'Google response exceeded the local chat limit.',
        routes,
        deniedToolResult: (toolCallId) =>
          deniedTools.get(toolCallId) ?? artifactMessages.get(toolCallId),
      });
      // The ACP plans a plan-mode turn reports, for its proposal.
      const planUpdates: SessionUpdate[] = [];
      // The last plan Gemini handed in as an artifact write this turn: plan
      // mode never writes the file, so the call's content is the plan.
      let planArtifact: { toolCallId: string; content: string } | undefined;
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
      // Settles this turn's snapshot; runs in finally, before routes close.
      let finishSnapshot: (() => Promise<void>) | undefined;
      try {
        if (!managedDelegation && managedDelegationEnabled(opts)) {
          const { createManagedDelegationSession } =
            await import('./delegation/service');
          const created = await createManagedDelegationSession({
            harness: 'antigravity',
            sessionKey: key,
            interfacePort,
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
        const appToolServers = antigravityAppToolServerNames();
        // Built once: the native gate and the delivered servers must agree.
        const routedMcpServers = [
          appToolServers.main,
          appToolServers.ui,
          ...extensions.servers.map((server) => server.name),
        ];
        for (const name of routedMcpServers)
          routeNames.set(name, normalizeCanopyMcpServerDisplayName(name));
        const opened = await openAntigravityRuntime({
          cwd: opts.cwd,
          owner: { kind: worker.kind, id: worker.runId },
          // The native tool gate admits MCP tools only from these routes.
          mcpServerNames: routedMcpServers,
          onUpdate: async (update): Promise<void> => {
            if (
              abort.signal.aborted ||
              lifetime.signal.aborted ||
              !turnState.ownsKeyResources()
            )
              return;
            try {
              if (planMode && update.update.sessionUpdate === 'plan')
                planUpdates.push(update.update);
              if (update.update.sessionUpdate === 'tool_call')
                lastToolCallId = update.update.toolCallId;
              const artifact = antigravityPlanArtifact(update.update);
              if (artifact !== undefined) {
                if (planMode) planArtifact = artifact;
                // The runtime reports the unwritten file as an empty failure.
                artifactMessages.set(
                  artifact.toolCallId,
                  planMode
                    ? ANTIGRAVITY_PLAN_ARTIFACT_MESSAGE
                    : ANTIGRAVITY_ARTIFACT_NOT_WRITTEN_MESSAGE,
                );
              }
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
            const authorization = await authorizeAntigravityToolCall(request, {
              approval: currentApproval,
              cwd: opts.cwd,
              planMode,
              stopTurn: () => abort.abort(),
            });
            const toolCallId = request.request.toolCall.toolCallId;
            // In plan mode the plan artifact's row explains its review instead.
            if (
              authorization.message !== undefined &&
              !(planMode && planArtifact?.toolCallId === toolCallId)
            )
              deniedTools.set(toolCallId, authorization.message);
            return abort.signal.aborted ||
              lifetime.signal.aborted ||
              !turnState.ownsKeyResources()
              ? 'deny'
              : authorization.decision;
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
        if (!ledger.decided) {
          ledger.decided = true;
          // A failed open leaves this session without Feed tools rather than
          // failing the turn. Cowork routes never list them.
          const opened =
            !isCoworkWorkspace(opts.projectId) &&
            mayExposeLedgerTools(ledgerTarget)
              ? await openLedgerChatTools({
                  target: ledgerTarget,
                  harness: 'antigravity',
                  readSettings: () => ledgerSettings,
                  ...(opts.selectedRepoId
                    ? { selectedRepoId: opts.selectedRepoId }
                    : {}),
                }).catch((error: unknown) => {
                  logMainProcessWarn(
                    '[antigravity-session] Feed tools unavailable',
                    error,
                  );
                  return null;
                })
              : null;
          if (lifetime.signal.aborted) opened?.dispose();
          else ledger.tools = opened;
        }
        assertCurrent();
        ledgerSettings = {
          model: requested.model ?? null,
          thinkingEffort: requested.thinkingLevel ?? null,
          planMode,
        };
        const ledgerHint = ledger.tools
          ? await ledger.tools.assignmentHint()
          : undefined;
        assertCurrent();
        appTools = await openAntigravityAppTools({
          sessionKey: key,
          codeGraphToolsAdvertised,
          deferredToolsAllowed: opts.deferredToolsAllowed !== false,
          ledgerTools: ledger.tools,
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
        // Evidence of what this turn was given (CAP-09). Discovery runs beside
        // the native turn and never delays the prompt; it authorizes nothing.
        const stopSnapshot = new AbortController();
        // Filled in once the native conversation is known.
        const snapshotTarget: { sessionId?: string } = {};
        const snapshotPending: Promise<
          | { ok: true; snapshot: EffectiveCapabilitySnapshot }
          | { ok: false; error: unknown }
        > = captureAntigravityCapabilitySnapshot({
          appServers: appTools.servers,
          extensions: extensions.snapshot,
          grants: {
            ...appTools.grants,
            planMode,
            approvalMode,
            childInheritance: 'none',
          },
          signal: abort.signal,
          stop: stopSnapshot.signal,
          toolLists,
        }).then(
          (snapshot) => ({ ok: true, snapshot }),
          (error: unknown) => ({ ok: false, error }),
        );
        finishSnapshot = async (): Promise<void> => {
          // A short grace, then whatever has not finished is recorded as
          // unavailable: evidence never holds the end of the turn. Until the
          // turn is bound to its native conversation nothing will be saved,
          // so stop at once.
          if (snapshotTarget.sessionId) {
            let grace: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              snapshotPending,
              new Promise<void>((resolve) => {
                grace = setTimeout(resolve, SNAPSHOT_GRACE_MS);
              }),
            ]);
            clearTimeout(grace);
          }
          stopSnapshot.abort();
          // Closing a stopped stdio child is bounded too.
          let closing: ReturnType<typeof setTimeout> | undefined;
          const captured = await Promise.race([
            snapshotPending,
            new Promise<{ ok: false; error: unknown }>((resolve) => {
              closing = setTimeout(
                () =>
                  resolve({
                    ok: false,
                    error: new Error(
                      'Snapshot discovery did not stop in time.',
                    ),
                  }),
                1_000,
              );
            }),
          ]);
          clearTimeout(closing);
          // No native conversation: nothing to bind the evidence to.
          const nativeId = snapshotTarget.sessionId;
          if (!nativeId) return;
          try {
            if (!captured.ok) throw captured.error;
            await saveAntigravityCapabilitySnapshot(
              nativeId,
              captured.snapshot,
              AbortSignal.timeout(5_000),
            );
          } catch (error) {
            // A missing record means nothing may inherit from this turn; the
            // turn itself keeps its own live grants and approvals. A cancelled
            // turn leaves no record by design and is not worth a warning.
            if (!abort.signal.aborted)
              logMainProcessWarn(
                '[antigravity-session] Capability snapshot unavailable',
                error,
              );
          }
        };
        // Other repositories of a multi-repo worktree, sent only when the
        // runtime advertised additional workspace roots.
        const additionalDirectories = await antigravityAdditionalDirectories({
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          cwd: opts.cwd,
        });
        assertCurrent();
        const sentDirectories = additionalDirectoriesParam(
          additionalDirectories,
          opened.client.supportsAdditionalDirectories(),
        );
        // The host delivers AGENTS.md and GEMINI.md, not native discovery,
        // from exactly the roots the runtime receives.
        const workspaceRoots = [
          opts.cwd,
          ...(sentDirectories.additionalDirectories ?? []),
        ];
        const repositoryInstructions =
          await readAntigravityRepositoryInstructions(
            workspaceRoots,
            abort.signal,
          );
        assertCurrent();
        const append = [
          opts.globalInstructionsBlock,
          opts.globalInstructionsSnapshot,
          antigravityWorkspaceRootsBlock(workspaceRoots),
          repositoryInstructions.block,
          opts.systemPromptAppend,
          appTools.instructions,
          managedDelegation?.systemPromptGuidance,
          extensions.instructions,
          // Last, so it sits next to the turn it opens.
          ledgerHint,
        ]
          .filter(Boolean)
          .join('\n\n');
        const params = {
          cwd: opts.cwd,
          ...sentDirectories,
          mcpServers: [...appTools.servers, ...extensions.servers],
          _meta: { antigravity: { systemPrompt: { append } } },
        };
        // New and resumed sessions use these params. Both lists come from the
        // same sources, so this is a tripwire against future drift.
        assertAntigravityMcpServersRouted(params.mcpServers, routedMcpServers);
        assertCurrent();
        let recovery: TranscriptContext | undefined;
        const native = await (async (): Promise<
          NewSessionResponse | ResumeSessionResponse
        > => {
          if (!sessionId) return opened.client.newSession(params);
          const resumeId = sessionId;
          try {
            return await opened.client.resumeSession({
              ...params,
              sessionId: resumeId,
            });
          } catch (error) {
            assertCurrent();
            if (
              !(await isAntigravitySessionMissing(
                opened.client,
                error,
                resumeId,
                abort.signal,
              ).catch((inventoryError: unknown) => {
                assertCurrent();
                // Inventory failure cannot prove absence or authorize replay.
                // Retain the original provider resume refusal as an optional offer.
                throw (
                  antigravityResumeFailure(error, resumeId) ?? inventoryError
                );
              }))
            )
              throw antigravityResumeFailure(error, resumeId) ?? error;
            assertCurrent();
            recovery = await readTranscriptRecoveryPrompt(
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
        // The catalog holds the levels the picker showed for this model; the
        // live entry cannot, because session options describe only the
        // current model. Without a catalog entry (for example before the first
        // discovery), the live levels are the only declared set.
        const catalogEntry = getAntigravityModelEntries().find(
          (candidate) => candidate.rawModelId === rawModel,
        );
        const nativeSessionId =
          'sessionId' in native && typeof native.sessionId === 'string'
            ? native.sessionId
            : sessionId;
        if (!nativeSessionId)
          throw new Error('Google did not create a conversation.');
        // Native current-session options are authoritative. Each step is
        // fenced, and a setting the runtime does not confirm fails the turn
        // before the prompt is sent.
        const applied = await applyAntigravitySessionConfig(
          opened.client,
          nativeSessionId,
          {
            model: rawModel,
            ...(requested.thinkingLevel
              ? { thinkingLevel: requested.thinkingLevel }
              : {}),
            ...(catalogEntry
              ? { declaredThinkingLevels: catalogEntry.supportedThinkingLevels }
              : {}),
            mode: planMode ? 'plan' : 'default',
          },
          { signal: abort.signal, assertCurrent },
        ).catch((error: unknown) => {
          // Only a missing model or level suggests catalog drift. Read-back
          // mismatches do not, and must not force a rediscovery each turn.
          if (
            error instanceof AntigravitySessionConfigError &&
            (error.code === 'model' || error.code === 'thinking-unsupported')
          )
            markAntigravityCatalogStale();
          throw error;
        });
        // The reverse drift is not an error: nothing was sent, as the picker
        // showed. Rediscover so the picker can offer the new levels.
        if (applied.thinkingControlAdded) markAntigravityCatalogStale();
        projection.observeMode(applied.mode);
        const turnThinking = applied.thinkingLevel;
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
        if (recovery === undefined) await publishSession();
        const profile = antigravityProfileDirectory();
        const inherited =
          recovery ??
          (await forkContext.context(
            profile,
            nativeSessionId,
            send?.userMessageId,
          ));
        assertCurrent();
        // Replayed history names earlier attachments. Restore the ones still in
        // this chat's attachment folder (the one uploads are saved to), and
        // say which ones were not. Files the new message attaches again are
        // sent once, with it.
        const resent = new Set(
          (send?.attachments?.paths ?? []).map((path) => resolve(path)),
        );
        const history: AntigravityHistoricalAttachments | undefined =
          inherited.prompt && inherited.attachmentPaths.length > 0
            ? await readAntigravityHistoricalAttachments({
                attachmentDirectories: resolveAgentAttachmentsDirCandidates(
                  opts.projectId,
                  opts.worktreeId,
                ),
                paths: inherited.attachmentPaths.filter(
                  (path) => !resent.has(resolve(path)),
                ),
                current: attachments,
                initialization: opened.client.getInitialization(),
                signal: abort.signal,
              })
            : undefined;
        assertCurrent();
        const extensionNotices = managedDelegation
          ? [
              ...repositoryInstructions.notices,
              ...extensions.notices,
              'Subagents do not automatically inherit the skills, plugins, commands or MCP servers selected for this chat.',
            ]
          : [...repositoryInstructions.notices, ...extensions.notices];
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
        if (history && history.unrestored.length > 0)
          logMainProcessWarn(
            '[antigravity-session] Earlier attachments not restored',
            antigravityUnrestoredCounts(history),
          );
        const historyNotice = antigravityHistoryNotice(
          recovery !== undefined,
          history,
        );
        if (historyNotice !== undefined) {
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
                    text: historyNotice,
                  },
                },
              ],
            },
            send?.userMessageId,
          );
        }
        snapshotTarget.sessionId = nativeSessionId;
        const inheritedContext = inherited.prompt;
        assertCurrent();
        const expanded = extensions.expandPrompt(text);
        const content = antigravityPromptContent({
          history: inheritedContext,
          restored: history,
          message: expanded,
          attachments,
          guide: (value) =>
            managedDelegation?.applyPolicyGuidance(value) ?? value,
        });
        const result = await opened.client.prompt(
          {
            sessionId: nativeSessionId,
            prompt: content,
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
          if (recovery !== undefined) await publishSession();
          if (send?.onPromptCompleted) {
            assertCurrent();
            await send.onPromptCompleted();
          }
        }
        for (const event of projection.finish()) await buffer.push(event);
        const proposal =
          planMode && result.stopReason === 'end_turn'
            ? collectAntigravityPlanProposal(
                planUpdates,
                projection.getFinalResponseText(),
                planArtifact?.content,
              )
            : null;
        // Gemini ends the turn silently once a native call is denied; say so
        // rather than leave the chat on a bare error count. A proposal
        // replaces the notice.
        const stoppedAfterDenial =
          proposal === null &&
          result.stopReason === 'end_turn' &&
          lastToolCallId !== undefined &&
          deniedTools.has(lastToolCallId) &&
          projection.getFinalResponseText().trim() === '';
        if (stoppedAfterDenial)
          await buffer.push(projection.notice(ANTIGRAVITY_DENIED_STOP_MESSAGE));
        // The plan's own text reaches the transcript before its review.
        if (proposal !== null) await buffer.flush();
        // A turn stopped by then commits no review: a committed one would
        // stay pending without ever being presented.
        if (proposal !== null && !abort.signal.aborted) {
          const event: PlanExitRequestEvent = {
            requestId: randomUUID(),
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
            source: 'antigravity',
            reviewMode: 'proposal',
            toolInput: {
              plan: proposal,
              source: 'antigravity',
              reviewMode: 'proposal',
            },
            ...(send?.userMessageId
              ? { turnUserMessageId: send.userMessageId }
              : {}),
          };
          await commitPendingPlanExit(event);
          // Once committed, the review is shown even if the turn stops now.
          interfacePort.presentPlanExit(event);
          // A plan awaiting review blocks on a human (CAN-3195).
          getAttentionTracker().mark({
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
            state: 'needs_input',
            reason: 'plan_review',
            sourceId: 'plan-review',
          });
        }
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
                : stoppedAfterDenial
                  ? ANTIGRAVITY_DENIED_STOP_MESSAGE
                  : projection.getResponseText(),
        };
      } finally {
        // Discovery reads this turn's routes, so settle it before they close.
        await finishSnapshot?.();
        appTools?.close();
        currentApproval.invalidatePending?.();
        currentApproval.dispose();
        approval = undefined;
        const opened = runtime;
        runtime = undefined;
        try {
          await opened?.close();
          // Reported for diagnosis only: `none` and `reaped` cover recorded
          // descendants, never every process the turn started (CAN-6738).
          void opened
            ?.descendantCleanup?.()
            .then((cleanup) => {
              if (cleanup)
                logMainProcessInfo('Antigravity descendant cleanup', {
                  cleanup,
                });
            })
            .catch(() => undefined);
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
            ...(!abort.signal.aborted &&
            error instanceof AntigravityResumeFailure
              ? {
                  canopy_session_recovery: {
                    kind: 'resume-failed',
                    provider: 'antigravity',
                    sessionId: error.sessionId,
                  } satisfies SessionResumeFailure,
                }
              : {}),
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
                  ? {
                      type: 'error',
                      error: result.result,
                      ...(result.canopy_session_recovery
                        ? {
                            canopy_session_recovery:
                              result.canopy_session_recovery,
                          }
                        : {}),
                    }
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
      codeGraphToolsAdvertised,
      'antigravity',
    );
    return session;
  }
}

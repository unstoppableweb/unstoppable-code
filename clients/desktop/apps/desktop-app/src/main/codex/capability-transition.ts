import { applyCodexMultiAgentConfig } from '@canopy/execution-engine/lib/codex-multi-agent';
import { getAppAdvisorLedgerToolNames } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { randomUUID } from 'node:crypto';
import { BRAND } from '@canopy/brand/current';
import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import type {
  ApprovalMode,
  AssistantMode,
  ChatModel,
  ChatTabPluginSelections,
  PluginSelectionTombstones,
} from '@canopy/desktop-shared/types';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  isOllamaServerUnavailableError,
} from '@canopy/desktop-shared/types';
import { codexApprovalPolicyFor, codexSandboxModeFor } from './approval-policy';
import {
  createCodexCapabilitySnapshotId,
  loadCodexThreadSeedItemsWithLoadCount,
  type CodexThreadHandle,
} from '@canopy/execution-engine/node/codex-runtime';
import { CODEX_PROJECT_DOC_THREAD_CONFIG } from '@canopy/execution-engine/node/codex-runtime/thread-config';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import { chatSurfaceUsesGlobalPluginDefaults } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { resolveCodexRuntimeEnvironmentProfile } from '../lib/user-environment-runtime';
import { resolveCodexMockAppServerOverride } from '@canopy/execution-engine/node/e2e-mock-env';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { buildWorktreeInjectedToolPrompt } from '../canopy-tools/prompting';
import { buildCoworkDispatchSystemPromptAppend } from '../lib/cowork-chat-system-prompt';
import { resolveLocalMemoryPolicy } from '../memory/local/policy';
import {
  ledgerToolPromptFor,
  resolveLedgerToolExposure,
  type LedgerChatTarget,
} from '../canopy-tools/ledger-tools-runtime';
import { isCodeGraphAvailableForWorkspace } from '../lib/code-graph-availability';
import { chatVisualsEligible } from '../lib/chat-visuals-feature-flag';
import { loadPersistedCodexFallbackSeedItems } from './transcript-seed';
import { getCodexRuntimeService } from './runtime-service';
import { getDesktopCodexCapabilityStore } from './capability-store';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import {
  type CodexReasoningProviderType,
  isGatewayOnlyModel,
  isGatewayReasoningRouteFamily,
  resolveCodexReasoningRouteFamily,
  resolveGatewayToolSchemaProfile,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { buildCodexSessionDynamicToolSpecs } from './session-dynamic-tools';
import { resolveCodexCompatibleOllamaInvocation } from '../ollama/codex-compatible';

function appendMcpDiscoveryInstructions(
  developerInstructions: string,
  mcpServers: Record<string, unknown>,
): string {
  const serverIds = Object.keys(mcpServers).sort();
  if (serverIds.length === 0) return developerInstructions;
  return [
    developerInstructions,
    '',
    'Selected plugin MCP servers configured for this chat:',
    ...serverIds.map((serverId) => `- ${serverId}`),
    '',
    'MCP resource and resource-template listings are not complete server inventories: tool-only plugin MCP servers do not appear in them. Use Codex tool search before concluding that a selected server is unavailable.',
  ].join('\n');
}

export interface CodexCapabilityTransition {
  handle: CodexThreadHandle;
  snapshotId: string;
  releaseRoutes(): Promise<void>;
}

/**
 * Build the replacement thread without touching the active chat session. The
 * caller commits tab persistence only after this returns, making successful
 * history injection the provider-side durability boundary.
 */
export async function materializeCodexCapabilityTransition(input: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  sourceThreadId: string;
  pluginSelections: ChatTabPluginSelections;
  /**
   * The not-yet-persisted tombstone update accompanying this transition.
   * Omitted means the persisted chat tombstones apply.
   */
  disabledGlobalPluginSelections?: PluginSelectionTombstones;
  selectedRepoId?: string;
  model?: ChatModel;
  multiAgentEnabled?: boolean;
  maxConcurrentSubagents?: number | null;
  localMemoryEnabled: boolean;
  assistantMode?: AssistantMode;
  codeGraphToolsAdvertised?: boolean;
  interfaceTools?: readonly InterfaceToolName[];
  /**
   * The chat's effective tool-approval mode, used to derive this
   * transitional thread's `approvalPolicy` / `sandbox`. No turn is ever run
   * on this handle today (the caller only persists its `threadId` before
   * unsubscribing), but it must not default to `full-access`-equivalent
   * (`'never'` + `danger-full-access`) — defaults to the safe `'ask'`
   * policy/sandbox when the caller cannot supply the resolved mode.
   */
  approvalMode?: ApprovalMode;
  /**
   * Tri-state AI-Credits routing signal. `true`/`false` come from a live
   * session and are authoritative; **omitted means unknown**, not "native".
   * The signal is read from the registered session, so it is unavailable
   * whenever the chat is idle — restart the app, then edit plugin or tool
   * selections before sending a message. Treating that absence as `false`
   * would downgrade a gateway-routed chat's lease to `native`, strip every
   * reasoning item from the rebuilt thread, and make the next real turn
   * detect a family mismatch and rebuild a second time.
   */
  aiCreditsRouted?: boolean;
  /**
   * Execution backend for this chat. Ollama threads are a distinct reasoning
   * route family, so omitting this would let an Ollama thread resume under a
   * native OpenAI model and replay provider-private reasoning.
   */
  providerType?: CodexReasoningProviderType;
}): Promise<CodexCapabilityTransition> {
  const service = getCodexRuntimeService();
  const routeOwnerId = `capability-transition:${input.projectId}/${input.worktreeId}/${input.chatId}:${randomUUID()}`;
  const releaseRoutes = async (): Promise<void> => {
    await service.revokeStdioMcpRoutes(routeOwnerId);
    getMcpHttpProxyService().unregisterRoutesForSession(routeOwnerId);
  };
  let handle: CodexThreadHandle | undefined;
  try {
    // One overlay pass: the transition's not-yet-persisted tombstones are
    // applied here, then the effective selections resolve as plain input.
    const pluginContext = await resolveEffectiveChatPluginContext(
      input.pluginSelections,
      input,
      chatSurfaceUsesGlobalPluginDefaults(input.projectId)
        ? { chatTombstones: input.disabledGlobalPluginSelections }
        : false,
    );
    const effectiveSelections = pluginContext.selections;
    const resolved = await resolvePlugins(
      effectiveSelections,
      input.projectId,
      input.worktreeId,
      input.chatId,
      {
        purpose: 'codex-session',
        installExternalPlugins: true,
        enableHttpMcpProxy: true,
        mcpHttpProxyService: getMcpHttpProxyService(),
        mcpStdioBroker: service,
        sessionId: routeOwnerId,
        ...(pluginContext.preferences
          ? { preferences: pluginContext.preferences }
          : {}),
      },
    );
    const cowork = isCoworkWorkspace(input.projectId);
    const sourceLease = await getDesktopCodexCapabilityStore().readLease(
      input.sourceThreadId,
    );
    // Recover the routing decision from the existing lease when the live
    // signal is unavailable — but the lease records a *family*, never a model,
    // so a recovered `true` is only trustworthy when the persisted model
    // resolves back to that same family:
    //
    // - gateway lease + a model that still routes to the same upstream: the
    //   chat really was AI-Credits routed and still is. Keep the family, keep
    //   the reasoning, keep the gateway tool schema.
    // - gateway lease + a model that would route elsewhere (a native model, or
    //   a different upstream): do **not** recover. Recovering there stamps the
    //   rebuilt thread and its dynamic-tool schema for a route the next real
    //   turn will not take, so that turn detects the mismatch and rebuilds a
    //   second time.
    // - gateway-only model: routed by definition, whatever the lease says.
    //   Forcing `true` is what makes a `native`-leased chat switched to a
    //   gateway-only model resolve a *different* target family and drop its
    //   OpenAI-private reasoning instead of replaying it through the gateway.
    const gatewayRoutedFamily = resolveCodexReasoningRouteFamily(
      input.model,
      true,
      input.providerType,
    );
    const aiCreditsRouted =
      input.aiCreditsRouted ??
      (isGatewayOnlyModel(input.model) ||
        (isGatewayReasoningRouteFamily(sourceLease?.reasoningRouteFamily) &&
          gatewayRoutedFamily === sourceLease?.reasoningRouteFamily));
    const toolSchemaProfile = resolveGatewayToolSchemaProfile(
      input.model,
      aiCreditsRouted,
    );
    const reasoningRouteFamily = resolveCodexReasoningRouteFamily(
      input.model,
      aiCreditsRouted,
      input.providerType,
    );
    // The tool list and the prompt paragraph must agree on ShowVisual.
    const includeChatVisuals = chatVisualsEligible({
      providerType: input.providerType,
      surface: cowork ? 'codex-cowork' : 'codex-worktree',
      assistantMode: input.assistantMode,
    });
    // The replacement thread carries the Ledger tools a session created now
    // would advertise, so the next session resumes it without a rebuild.
    const ledgerTarget: LedgerChatTarget = {
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      chatId: input.chatId,
      ...(input.assistantMode ? { assistantMode: input.assistantMode } : {}),
    };
    const ledgerScope = await resolveLedgerToolExposure(ledgerTarget);
    const dynamicTools = buildCodexSessionDynamicToolSpecs({
      assistantMode: input.assistantMode,
      workspaceMode: cowork ? 'cowork' : 'worktree',
      isCodeReview: input.projectId === CODE_REVIEW_CHAT_PROJECT_ID,
      includeChatVisuals,
      includeCodeGraph:
        input.codeGraphToolsAdvertised ??
        (!cowork && isCodeGraphAvailableForWorkspace(input.projectId)),
      includeLedger: ledgerScope !== null,
      interfaceTools: input.interfaceTools ?? [],
      toolSchemaProfile,
    });
    const snapshotId = createCodexCapabilitySnapshotId({
      roots: resolved.selectedCapabilityRoots,
      mcpServers: resolved.codexMcpServers,
      mcpAuthorityIds: getMcpHttpProxyService().getCodexCapabilityAuthorityIds(
        resolved.codexMcpServers,
      ),
      dynamicTools,
      toolSchemaProfile,
    });
    const fallbackItems = await loadPersistedCodexFallbackSeedItems(input);
    const { codexHome } = await service.getCanonicalState();
    const { items, loadedItemCount } =
      await loadCodexThreadSeedItemsWithLoadCount({
        codexHome,
        threadId: input.sourceThreadId,
        fallbackItems,
        targetRouteFamily: reasoningRouteFamily,
        sourceRouteFamily: sourceLease?.reasoningRouteFamily,
      });
    // "No chat history" is measured before sanitization, never on `items`.
    // Sanitization drops every `type: 'reasoning'` item when the source
    // provenance is unknown, so a chat with a legacy lease (no recorded
    // `reasoningRouteFamily`) whose loaded tail is all reasoning sanitizes down
    // to nothing even though history genuinely existed. Failing here would break
    // every tool-selection update on that chat; rebuilding with whatever
    // survived loses only the reasoning the target route could not have replayed
    // anyway.
    if (loadedItemCount === 0) {
      throw new Error('Cannot update Codex capabilities without chat history');
    }
    const cwd = resolveWorktreeCwd(
      input.projectId,
      input.worktreeId,
      input.selectedRepoId,
    );
    const memoryPolicy = await resolveLocalMemoryPolicy(input);
    const injectedToolInstructions = cowork
      ? buildCoworkDispatchSystemPromptAppend(
          'codex',
          input.localMemoryEnabled,
          memoryPolicy.kind === 'scoped' && memoryPolicy.privateMemory,
          includeChatVisuals,
        )
      : buildWorktreeInjectedToolPrompt(
          'codex',
          true,
          true,
          includeChatVisuals,
        );
    const baseInstructions =
      ledgerScope === null
        ? injectedToolInstructions
        : `${injectedToolInstructions}\n\n${ledgerToolPromptFor({
            target: ledgerTarget,
            scope: ledgerScope,
            harness: 'codex',
            // App Advisor advertises the Ledger tools under its own names.
            ...(input.assistantMode === 'app-advisor'
              ? { toolNames: getAppAdvisorLedgerToolNames('codex') }
              : {}),
            ...(input.selectedRepoId
              ? { selectedRepoId: input.selectedRepoId }
              : {}),
          })}`;
    // An Ollama-backed Codex chat must be rebuilt under Ollama, not just
    // labelled with the `ollama` reasoning family. Without this the
    // replacement thread would receive the persisted `ollama-*` UI model id
    // and no `model_provider`/loopback Responses configuration, so it would
    // fail or route to the wrong backend. `ensureRunningReason` is
    // deliberately omitted: a capability transition should not start a server
    // as a side effect, and a missing server fails loudly here either way.
    // `assertInstalled` matches every other caller (session, helper, pipeline):
    // this path already requires a reachable Ollama server, so rebuilding onto
    // a model that server cannot serve would swap the thread out and defer the
    // failure to the next turn, where it reads as a mid-conversation provider
    // error instead of a refused tool update.
    const ollamaInvocation =
      input.providerType === 'ollama'
        ? await resolveCodexCompatibleOllamaInvocation(input.model, {
            assertInstalled: true,
          }).catch((error: unknown) => {
            const cause =
              error instanceof Error ? error : new Error(String(error));
            // The rewrite is gated POSITIVELY on the one failure it can
            // actually remedy: no server answered the reachability probe.
            // Everything else this resolver rejects with — the
            // unsupported-platform guard, the non-Ollama-model guard, a model
            // that is not installed or does not advertise `completion` +
            // `tools`, a server too old for the Responses API — either never
            // reached a server or came *from* a running one. Rewriting those
            // into "Start Ollama" names an action that cannot fix them and
            // demotes the action that can (pull the model, pick another model,
            // upgrade Ollama) to a parenthetical.
            if (!isOllamaServerUnavailableError(cause)) {
              throw cause;
            }
            // Updating tool selections never needed the Ollama server
            // before, so a stopped server would surface an internal probe
            // message on a routine action. Lead with the action the user can
            // take and keep the underlying detail for support.
            throw new Error(
              `Start Ollama to update the tools for this chat. ${BRAND.displayName} rebuilds an Ollama chat's Codex thread through the local Ollama server. (${cause.message})`,
            );
          })
        : null;
    const runtimeModel = ollamaInvocation?.runtimeModel ?? input.model;
    const config: Record<string, JsonValue> = {
      ...CODEX_PROJECT_DOC_THREAD_CONFIG,
    };
    if (ollamaInvocation?.codexConfig) {
      Object.assign(config, ollamaInvocation.codexConfig);
    }
    if (Object.keys(resolved.codexMcpServers).length > 0) {
      config.mcp_servers = resolved.codexMcpServers;
    }
    const environmentProfile = resolveCodexRuntimeEnvironmentProfile({
      runtime: 'agent',
      workspaceId: input.projectId,
    });
    const mock = resolveCodexMockAppServerOverride();
    const approvalMode: ApprovalMode = input.approvalMode ?? 'ask';
    handle = await service.materializeThread({
      params: {
        cwd,
        approvalPolicy: codexApprovalPolicyFor(approvalMode),
        sandbox: codexSandboxModeFor(approvalMode),
        ...(runtimeModel ? { model: runtimeModel } : {}),
        config: applyCodexMultiAgentConfig(config, {
          enabled: input.multiAgentEnabled,
          maxConcurrentSubagents: input.maxConcurrentSubagents,
        }),
        developerInstructions: appendMcpDiscoveryInstructions(
          baseInstructions,
          resolved.codexMcpServers,
        ),
        dynamicTools,
        selectedCapabilityRoots: resolved.selectedCapabilityRoots,
        experimentalRawEvents: false,
      },
      items,
      capabilitySnapshotId: snapshotId,
      reasoningRouteFamily,
      profile: {
        environment: {
          ...environmentProfile.environment,
          ...(mock?.env ?? {}),
        },
        configArgs: mock?.configArgs ?? [],
        logicalWorkspaceEnvironmentId:
          environmentProfile.logicalWorkspaceEnvironmentId,
        ...(environmentProfile.secretVersionFingerprint
          ? {
              secretVersionFingerprint:
                environmentProfile.secretVersionFingerprint,
            }
          : {}),
        ...(mock ? { mockProviderId: 'canopy-e2e' } : {}),
      },
    });
    return { handle, snapshotId, releaseRoutes };
  } catch (error) {
    await handle?.delete().catch(() => {});
    await releaseRoutes();
    throw error;
  }
}

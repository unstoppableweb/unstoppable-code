/**
 * Per-turn settings a trusted send commits with its message (D2): the model,
 * runtime, model config, plan mode, approval mode and plugins one message runs
 * with, resolved against the chat as it is when the message is sent.
 */
import type { McpServerRef } from '@canopy/protocol/mcp-servers';
import {
  hasLegacyAccountMcpRefs,
  normalizeAccountMcpSelectionRefs,
  withoutAccountsPickedOver,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  getExecutionHarnessForModel,
  requireProviderForModel,
  resolveKnownModel,
  resolveProviderModelConfig,
  type AgentModelConfig,
  type AgentProviderType,
  type ApprovalMode,
  type ChatModel,
  type ChatSendTurnOverride,
  type ChatTabPluginSelections,
  type ModelHarness,
} from '@canopy/desktop-shared/types';
import { mergeAgentModelConfig } from '@canopy/execution-engine/lib/codex-speed';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type { ShareablePluginRef } from '@canopy/execution-engine/plugin-refs';
import { resolveSendModelPin } from '../agents/agent-default-model';
import {
  readApprovalPreferencesForSurface,
  resolveApprovalMode,
  surfaceForChat,
} from '../lib/approval-mode-resolution';
import { readWorkspaceApprovals } from '../lib/approvals-persistence';
import { mergePluginSelections } from '../lib/plugin-selection-utils';
import { readPreferencesFile } from '../lib/preferences-store';
import { readWorkspaceApprovalsManifest } from '../lib/workspace-approvals-manifest';
import {
  assertOpenCodeConnectionGeneration,
  assertOpenCodeModelAvailable,
  getOpenCodeConnectionGeneration,
} from '../opencode/connection';
import {
  loadShareablePluginCatalog,
  resolveShareablePluginRefs,
} from '../plugins/shareable-plugin-resolution';
import type { buildExistingTabDispatchOptions } from '../services/chat-service';

/** Requested per-turn settings, as a pipeline step or an automation stores them. */
export interface ChatTurnOverrideRequest {
  /** Aliases are resolved by the caller. */
  model?: string;
  /** Thinking effort and fast mode. */
  modelConfig?: AgentModelConfig;
  planMode?: boolean;
  approvalMode?: ApprovalMode;
  plugins?: ShareablePluginRef[];
  pluginSelections?: ChatTabPluginSelections;
}

/** The chat's own send settings, as the send reads them at dispatch. */
export type ExistingTabDispatchOptions = Awaited<
  ReturnType<typeof buildExistingTabDispatchOptions>
>;

export async function resolveAutomationApprovalMode(
  projectId: string,
  override: ApprovalMode | undefined,
): Promise<ApprovalMode> {
  const surface = surfaceForChat(projectId);
  const [workspaceApprovals, manifestApprovals, approvalPreferences] =
    await Promise.all([
      readWorkspaceApprovals(projectId),
      readWorkspaceApprovalsManifest(projectId),
      readApprovalPreferencesForSurface(surface),
    ]);
  return resolveApprovalMode({
    // Scheduled activities and pipeline steps are locally authored by the
    // user, so an explicit choice is authoritative like a per-tab mode.
    // Repository hook modes use `hookMode` and are clamped by
    // `resolveApprovalMode`.
    tabMode: override,
    workspaceDefault: workspaceApprovals.defaultMode,
    canopyJsonDefault: manifestApprovals.defaultMode,
    surface,
    defaults: approvalPreferences.defaults,
  });
}

/**
 * `defaults` without the account refs `direct` picks another account of the
 * connector over, where legacy `account:<connectionId>` refs on either side
 * are compared as the connector and account they name (CAN-7186). Every ref
 * it keeps is returned exactly as stored, so a queued send and a terminal
 * chat's settings check see what the chat holds. Compared as written when
 * the account list can't be read.
 */
async function withoutAccountsPickedOverCanonically(
  defaults: ChatTabPluginSelections | undefined,
  direct: ChatTabPluginSelections,
): Promise<ChatTabPluginSelections | undefined> {
  const { loadAccountMcpRefConnections } =
    await import('../mcp/account-catalog');
  const connections = await loadAccountMcpRefConnections();
  if (!defaults || connections === null)
    return withoutAccountsPickedOver(defaults, direct);
  // A legacy ref whose connection is gone has no connector to compare by,
  // so it reads as itself, and the run's check still names it.
  const canonical = (ref: McpServerRef): McpServerRef =>
    normalizeAccountMcpSelectionRefs(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [ref],
      },
      connections,
    ).selections.mcpServerRefs?.[0] ?? ref;
  const picks = { mcpServerRefs: (direct.mcpServerRefs ?? []).map(canonical) };
  const refs = defaults.mcpServerRefs ?? [];
  const kept = refs.filter(
    (ref) =>
      (withoutAccountsPickedOver(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [canonical(ref)],
        },
        picks,
      )?.mcpServerRefs?.length ?? 0) > 0,
  );
  return kept.length === refs.length
    ? defaults
    : { ...defaults, mcpServerRefs: kept };
}

export async function resolveAutomationPromptPlugins(
  defaults: ChatTabPluginSelections | undefined,
  plugins: ShareablePluginRef[] | undefined,
  directSelections: ChatTabPluginSelections | undefined,
): Promise<ChatTabPluginSelections | undefined> {
  const direct = directSelections
    ? normalizePluginSelections(directSelections)
    : undefined;
  // The automation's own account pick of a connector stands in for the
  // chat's (or the defaults') other account of it (CAN-6233), so a run acts
  // as the account its Send as names. Legacy `account:<connectionId>` refs
  // are compared as their connector, so one is still replaced (CAN-7186).
  const baseSelections = direct
    ? mergePluginSelections(
        hasLegacyAccountMcpRefs(defaults) || hasLegacyAccountMcpRefs(direct)
          ? await withoutAccountsPickedOverCanonically(defaults, direct)
          : withoutAccountsPickedOver(defaults, direct),
        direct,
      )
    : defaults;
  if (!plugins || plugins.length === 0) {
    return baseSelections;
  }

  const catalog = await loadShareablePluginCatalog();
  const matches = resolveShareablePluginRefs(plugins, catalog);
  const extras: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    mcpHttpAuthPreferences: [],
  };

  for (const match of matches) {
    if (match.matchState !== 'matched') {
      // Missing optional activity plugins should not stop scheduled work.
      // The created chat still gets workspace defaults and every available
      // selected plugin, matching hook-chat behavior.
      continue;
    }
    if (match.selection.kind === 'skill') {
      extras.skillRefs.push({
        sourceId: match.selection.sourceId,
        skillName: match.selection.skillName,
      });
    } else {
      extras.pluginRefs.push({
        marketplaceId: match.selection.marketplaceId,
        pluginName: match.selection.pluginName,
      });
    }
  }

  return mergePluginSelections(baseSelections, extras);
}

/**
 * The harness a turn runs on: the requested one, else the chat's, falling back
 * to the chat's provider.
 */
export function selectedTurnHarness(
  tab: ExistingTabDispatchOptions,
  model: ChatModel | undefined,
  harness: ModelHarness | undefined,
): ModelHarness | AgentProviderType | undefined {
  const selectedModel = model ?? tab.model;
  return (
    harness ??
    tab.executionHarness ??
    (selectedModel ? getExecutionHarnessForModel(selectedModel) : undefined) ??
    tab.providerType
  );
}

/**
 * Merge plugin selections the prompt's references bring. A caller that binds
 * its prompt after resolving the override (the prompt needs the resolved
 * runtime) adds them here.
 */
export function withPromptPluginSelections(
  override: ChatSendTurnOverride,
  tab: ExistingTabDispatchOptions,
  promptPluginSelections: ChatTabPluginSelections | undefined,
): ChatSendTurnOverride {
  if (!promptPluginSelections) return override;
  const pluginSelections = mergePluginSelections(
    override.pluginSelections ?? tab.pluginSelections,
    promptPluginSelections,
  );
  return { ...override, ...(pluginSelections ? { pluginSelections } : {}) };
}

/**
 * Resolve the settings one message runs with. Fields the request leaves unset
 * stay off the result, so an empty request returns `{ version: 1 }` and the
 * chat's own settings apply, unless the turn would run on Cursor, which is
 * refused even then. Errors are plain and worded for automations; another
 * caller maps them to its own refusal. Plugin authorization stays with each
 * caller: it needs the caller's execution context and refusal path.
 */
export async function resolveChatTurnOverride(
  target: { projectId: string; worktreeId: string; chatId: string },
  tab: ExistingTabDispatchOptions,
  request: ChatTurnOverrideRequest,
  promptPluginSelections?: ChatTabPluginSelections,
): Promise<ChatSendTurnOverride> {
  const namedModel = request.model
    ? resolveKnownModel(request.model)
    : undefined;
  // Resolve inherited Agents before OpenCode admission, matching the send.
  const model =
    namedModel &&
    ((await resolveSendModelPin(target.projectId, tab.model, namedModel, {
      ...target,
      executionHarness: getExecutionHarnessForModel(namedModel),
    })) ??
      namedModel);
  if (request.model && !model)
    throw new Error('The automation model is unavailable.');
  const harness = model ? getExecutionHarnessForModel(model) : undefined;
  if (model && !harness)
    throw new Error('The automation model is unsupported.');
  const selectedModel = model ?? tab.model;
  const selectedHarness = selectedTurnHarness(tab, model, harness);
  if (selectedHarness === 'cursor') {
    // Cursor's compatibility send does not bind inherited settings across
    // asynchronous preparation; retain the shared scheduling restriction.
    throw new Error(
      'Scheduled messages are not available for Cursor chats. Choose another model.',
    );
  }
  if (selectedHarness === 'opencode') {
    // Refuse disconnected or withdrawn models before chat dispatch can
    // append a user message, start a timer, or open an Advisor window.
    // The provider revalidates the connection again at execution time.
    const opencodeGeneration = getOpenCodeConnectionGeneration();
    await assertOpenCodeModelAvailable(selectedModel);
    assertOpenCodeConnectionGeneration(opencodeGeneration);
  }
  const providerType = model ? requireProviderForModel(model) : undefined;
  const providerChanged =
    model !== undefined &&
    (harness !== tab.executionHarness || providerType !== tab.providerType);
  const runtimeChanged =
    model !== undefined &&
    (providerChanged || (harness !== 'cursor' && model !== tab.model));
  const preferences =
    request.modelConfig || harness ? await readPreferencesFile() : undefined;
  const modelConfig = harness
    ? resolveProviderModelConfig(
        harness,
        {
          modelConfig: providerChanged
            ? request.modelConfig
            : request.modelConfig
              ? mergeAgentModelConfig(tab.modelConfig, request.modelConfig)
              : tab.modelConfig,
        },
        preferences?.providerModelConfigDefaults,
      )
    : request.modelConfig
      ? resolveProviderModelConfig(
          tab.executionHarness ?? tab.providerType ?? 'claude',
          {
            modelConfig: mergeAgentModelConfig(
              tab.modelConfig,
              request.modelConfig,
            ),
          },
          preferences?.providerModelConfigDefaults,
        )
      : undefined;
  // The chat's own selections apply unless the request or the prompt adds some.
  const requestedPluginSelections =
    request.plugins?.length || request.pluginSelections
      ? await resolveAutomationPromptPlugins(
          tab.pluginSelections,
          request.plugins,
          request.pluginSelections,
        )
      : undefined;
  const approvalMode =
    request.approvalMode === undefined
      ? undefined
      : await resolveAutomationApprovalMode(
          target.projectId,
          request.approvalMode,
        );
  return withPromptPluginSelections(
    {
      version: 1,
      ...(runtimeChanged && providerType && harness
        ? { resetRuntime: true, providerType, executionHarness: harness }
        : {}),
      ...(model ? { model } : {}),
      ...(modelConfig ? { modelConfig } : {}),
      ...(request.planMode !== undefined ? { planMode: request.planMode } : {}),
      ...(approvalMode ? { approvalMode } : {}),
      ...(requestedPluginSelections
        ? { pluginSelections: requestedPluginSelections }
        : {}),
    },
    tab,
    promptPluginSelections,
  );
}

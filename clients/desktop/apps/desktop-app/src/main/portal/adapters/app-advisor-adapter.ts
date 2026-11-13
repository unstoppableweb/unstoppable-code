import { isModelHarness } from '@canopy/execution-engine/model-harnesses';
import { isSidebarItemGroupId } from '@canopy/protocol/sidebar';
import { isCopilotRuntimeAvailable } from '../../copilot/runtime-availability';
import { broadcastPreferencesSynced } from '../../lib/preferences-broadcast';
import { randomUUID } from 'node:crypto';
import {
  APP_ADVISOR_PROJECT_ID,
  getProviderForModel,
  IPC_CHANNELS,
  isTerminalBackedInterfaceMode,
  resolveKnownModel,
  resolvePersistedChatExecutionHarness,
  type AppAdvisorAskUserAnswer,
  type ChatSendMessageRequest,
  type PortalAskUserQuestionAnswer,
  type PortalCommandEnvelope,
  type PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
import {
  buildAppAdvisorProjectAgentAccessOwnerOptions,
  normalizeAppAdvisorProjectAgentAccess,
} from '@canopy/desktop-shared/lib/app-advisor-project-agent-access';
import type { PortalAppAdvisorProjectAgentAccess } from '@canopy/protocol/portal';
import { trackDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  pinInheritingAgentToDestination,
  refreshCatalogAgentDefaults,
  resolveCatalogAgentDefaultModel,
  resolveSendModelPin,
} from '../../agents/agent-default-model';
import { CHAT_UNIT_LABEL, ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { THINKING_LEVELS } from '@canopy/protocol/thinking';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { MAX_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';
import { validateId } from '../../lib/validation';
import {
  captureChatTurnStop,
  isChatTurnStopCurrent,
  type ChatTurnStopContext,
} from '../../lib/chat-turn-cancel';
import { getAllActiveSessionInfos } from '../../agents/session-manager';
import { sendToWindow } from '../../lib/window-send';
import {
  createWorkEntry,
  listWorkEntries,
  resolveWorkEntryForChat,
} from '../../lib/cowork-work-entries';
import { readChatTabsFile } from '../../lib/chat-tabs-reader';
import { writeChatTabsFile } from '../../lib/chat-tabs';
import { enqueueChatTabMutation } from '../../lib/chat-tab-mutation-queue';
import { completeAppAdvisorAskUserRequest } from '../../ipc/app-advisor';
import { changeChatModel } from '../../ipc/chat';
import { getClaudeTerminalSessionService } from '../../integration/claude-terminal-session-service';
import { getPortalAppAdvisorSurfaces } from '../app-advisor-portal-surfaces';
import { captureAppAdvisorSyntheticResultFence } from '../../app-advisor/chat-service';
import type { AppAdvisorToolRuntimeSurfaces } from '../../app-advisor/runtime';
import type { PortalAdapterContext } from './types';
import { sanitizePortalFileReferences } from './chat-adapter';
import { portalFileReferences } from '../portal-file-references';
import { failServiceError, isRecord } from './validation';
import {
  readAppAdvisorClaudeMd,
  readAppAdvisorWorkspaceSettings,
  saveAppAdvisorClaudeMd,
  saveAppAdvisorWorkspaceSettings,
} from '../../lib/app-advisor-workspace';
import { setAppAdvisorProjectAgentAccess } from '../../lib/app-advisor-project-agent-access';
import {
  projectPreferencesForRuntime,
  readPreferencesFile,
  updatePreferencesFile,
} from '../../lib/preferences-store';
import { getWorkspaceContextService } from '../../lib/workspace-context-service';
import { buildProjectedModelCatalog } from '../model-catalog-projection';
import { peekPortalProviderAvailability } from '../../auth/provider-auth-state';
import { isCursorRuntimeAvailable } from '../../cursor/runtime-availability';
import { assertUntrustedChatInput } from '../../agent-messaging/untrusted-input';

/**
 * Portal adapter for the `portal.app_advisor.*` family (CAN-2565): a remote
 * view of the paired desktop's App Advisor. Unlike the worktree chat family,
 * payloads carry NO `projectId`/`worktreeId` routing — every command targets
 * the App Advisor sentinel workspace, and the owning Work Entry is resolved
 * host-side from `chatId`, so a remote client can never re-route the family
 * at another chat scope.
 */

function requireSurfaces(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
): AppAdvisorToolRuntimeSurfaces | null {
  const surfaces = getPortalAppAdvisorSurfaces();
  if (!surfaces) {
    context.fail(
      command,
      'execution_failed',
      `${ORCHESTRATOR_LABEL} is unavailable in this desktop build.`,
      true,
    );
    return null;
  }
  return surfaces;
}

function rejectUntrustedPortalChatInput(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
): boolean {
  try {
    assertUntrustedChatInput(command.payload);
    return false;
  } catch {
    context.fail(
      command,
      'invalid_payload',
      'Trusted agent attribution cannot be supplied by the Portal.',
    );
    return true;
  }
}

/**
 * Validate an optional wire id. An empty string is rejected rather than
 * treated as "omitted" — only an absent field means that.
 */
function readOptionalId(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${label}: must be a string id`);
  }
  validateId(value, label);
  return value;
}

/**
 * Resolve the Work Entry that owns `chatId`, minting one when the chat is new
 * (or its entry was archived). Minted entries reuse the founding chat's id —
 * the same convention the quick-prompt and migration paths use, which keeps
 * `resolveWorkEntryForChat` O(1) for them.
 */
async function resolveOrMintEntry(
  chatId: string | undefined,
  requestedEntryId?: string,
): Promise<{ chatId: string; entryId: string }> {
  if (requestedEntryId) {
    validateId(requestedEntryId, 'workEntryId');
  }
  if (chatId) {
    const resolution = await resolveWorkEntryForChat(
      APP_ADVISOR_PROJECT_ID,
      chatId,
    );
    if (resolution.entryId) {
      if (
        requestedEntryId !== undefined &&
        requestedEntryId !== resolution.entryId
      ) {
        throw new Error(
          `${ORCHESTRATOR_LABEL} chat ${chatId} belongs to Work Entry ${resolution.entryId}`,
        );
      }
      return { chatId, entryId: resolution.entryId };
    }
    if (resolution.archivedInEntryId && requestedEntryId) {
      throw new Error(`${ORCHESTRATOR_LABEL} chat ${chatId} is archived`);
    }
  }
  if (requestedEntryId) {
    const entries = await listWorkEntries(APP_ADVISOR_PROJECT_ID);
    if (!entries.some((entry) => entry.id === requestedEntryId)) {
      throw new Error(
        `Unknown ${ORCHESTRATOR_LABEL} Work Entry ${requestedEntryId}`,
      );
    }
    return { chatId: chatId ?? randomUUID(), entryId: requestedEntryId };
  }
  const mintedChatId = chatId ?? randomUUID();
  const created = await createWorkEntry(APP_ADVISOR_PROJECT_ID, {
    id: mintedChatId,
    createdAt: new Date().toISOString(),
  });
  return { chatId: mintedChatId, entryId: created.entry.id };
}

function readAgentProviderType(
  value: unknown,
):
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'cursor'
  | 'copilot'
  | 'opencode'
  | undefined {
  return value === 'claude' ||
    value === 'codex' ||
    value === 'ollama' ||
    value === 'cursor' ||
    value === 'copilot' ||
    value === 'opencode'
    ? value
    : undefined;
}

const APP_ADVISOR_THINKING_LEVELS = new Set<string>(THINKING_LEVELS);

function isAppAdvisorThinkingLevel(
  value: unknown,
): value is (typeof THINKING_LEVELS)[number] {
  return typeof value === 'string' && APP_ADVISOR_THINKING_LEVELS.has(value);
}

function isPortalAppAdvisorProjectAgentAccess(
  value: unknown,
): value is PortalAppAdvisorProjectAgentAccess {
  if (
    !isRecord(value) ||
    (value.mode !== 'enabled' &&
      value.mode !== 'selected-owners' &&
      value.mode !== 'disabled') ||
    !Array.isArray(value.selectedOwners)
  ) {
    return false;
  }
  return value.selectedOwners.every((owner) => {
    if (!isRecord(owner)) return false;
    if (owner.kind === 'personal') return true;
    return (
      owner.kind === 'organization' &&
      typeof owner.organizationId === 'string' &&
      owner.organizationId.trim().length > 0
    );
  });
}

/** Load the same backing stores consumed by the desktop settings modal. */
export async function handlePortalAppAdvisorSettingsGet(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.app_advisor.settings.get']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const surfaces = requireSurfaces(command, context);
  if (!surfaces) return;
  if (!isRecord(command.payload)) {
    context.fail(
      command,
      'invalid_payload',
      `${ORCHESTRATOR_LABEL} settings get requires an object payload.`,
    );
    return;
  }
  try {
    const [{ buildPluginCatalog }, preferences, instructions, settings] =
      await Promise.all([
        import('../../services/plugin-catalog-service'),
        readPreferencesFile(),
        readAppAdvisorClaudeMd(),
        readAppAdvisorWorkspaceSettings(),
      ]);
    const pluginCatalog = await buildPluginCatalog();
    const organizations = getWorkspaceContextService().getState().organizations;
    context.complete(command, {
      model: preferences.appAdvisorModel,
      thinkingLevel: preferences.appAdvisorThinkingLevel,
      pluginSelections: preferences.appAdvisorPluginSelections,
      projectAgentAccess: normalizeAppAdvisorProjectAgentAccess(
        preferences.appAdvisorProjectAgentAccess,
      ),
      projectAgentAccessOwnerOptions:
        buildAppAdvisorProjectAgentAccessOwnerOptions(organizations),
      instructions,
      archiveRetentionDays: settings.archiveRetentionDays,
      autoArchiveDays: settings.autoArchiveDays,
      availableModels: buildProjectedModelCatalog(preferences.appAdvisorModel, {
        cursor: true,
        owner: { kind: 'personal' },
        copilot: true,
        opencode: true,
        agentDefaultModel: await resolveCatalogAgentDefaultModel(
          APP_ADVISOR_PROJECT_ID,
        ),
      }),
      providerAvailability: peekPortalProviderAvailability(),
      pluginCatalog,
      approvalsUpgradeNoticeDismissed:
        preferences.approvalsUpgradeNoticeDismissed,
    });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/** Save a partial settings patch through the desktop's canonical stores. */
export async function handlePortalAppAdvisorSettingsSave(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.app_advisor.settings.save']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (!isRecord(payload)) {
    context.fail(
      command,
      'invalid_payload',
      `${ORCHESTRATOR_LABEL} settings save requires an object payload.`,
    );
    return;
  }
  const surfaces = requireSurfaces(command, context);
  if (!surfaces) return;

  const projectAgentAccess =
    payload.projectAgentAccess === undefined
      ? undefined
      : isPortalAppAdvisorProjectAgentAccess(payload.projectAgentAccess)
        ? normalizeAppAdvisorProjectAgentAccess(payload.projectAgentAccess)
        : null;

  if (
    (payload.model !== undefined &&
      (typeof payload.model !== 'string' ||
        payload.model.trim().length === 0 ||
        payload.model.length > 256)) ||
    (payload.thinkingLevel !== undefined &&
      !isAppAdvisorThinkingLevel(payload.thinkingLevel)) ||
    (payload.instructions !== undefined &&
      typeof payload.instructions !== 'string') ||
    (payload.archiveRetentionDays !== undefined &&
      payload.archiveRetentionDays !== null &&
      (typeof payload.archiveRetentionDays !== 'number' ||
        !Number.isInteger(payload.archiveRetentionDays) ||
        payload.archiveRetentionDays < 0 ||
        payload.archiveRetentionDays > MAX_ARCHIVE_RETENTION_DAYS)) ||
    (payload.autoArchiveDays !== undefined &&
      payload.autoArchiveDays !== null &&
      (typeof payload.autoArchiveDays !== 'number' ||
        !Number.isInteger(payload.autoArchiveDays) ||
        payload.autoArchiveDays < 1 ||
        payload.autoArchiveDays > MAX_ARCHIVE_RETENTION_DAYS)) ||
    (payload.pluginSelections !== undefined &&
      !isRecord(payload.pluginSelections)) ||
    (payload.approvalsUpgradeNoticeDismissed !== undefined &&
      typeof payload.approvalsUpgradeNoticeDismissed !== 'boolean') ||
    (payload.projectAgentAccess !== undefined && projectAgentAccess === null)
  ) {
    context.fail(
      command,
      'invalid_payload',
      `Invalid ${ORCHESTRATOR_LABEL} settings.`,
    );
    return;
  }

  try {
    const preferencePatch = {
      ...(typeof payload.model === 'string'
        ? { appAdvisorModel: payload.model }
        : {}),
      ...(isAppAdvisorThinkingLevel(payload.thinkingLevel)
        ? { appAdvisorThinkingLevel: payload.thinkingLevel }
        : {}),
      ...(isRecord(payload.pluginSelections)
        ? {
            appAdvisorPluginSelections: normalizePluginSelections(
              payload.pluginSelections,
            ),
          }
        : {}),
      ...(typeof payload.approvalsUpgradeNoticeDismissed === 'boolean'
        ? {
            approvalsUpgradeNoticeDismissed:
              payload.approvalsUpgradeNoticeDismissed,
          }
        : {}),
      ...(projectAgentAccess !== undefined && projectAgentAccess !== null
        ? { appAdvisorProjectAgentAccess: projectAgentAccess }
        : {}),
    };
    if (Object.keys(preferencePatch).length > 0) {
      // Apply the access cache inside the serialized commit, in the same
      // order as the desktop preferences save.
      const saved = await updatePreferencesFile(
        () => preferencePatch,
        projectAgentAccess
          ? (committed): void =>
              setAppAdvisorProjectAgentAccess(
                committed.appAdvisorProjectAgentAccess,
              )
          : undefined,
      );
      // Keep both desktop windows in sync with a settings change made from the
      // portal, matching the native preferences-save broadcast.
      broadcastPreferencesSynced(saved, projectPreferencesForRuntime);
      trackDetachedWork(() =>
        refreshCatalogAgentDefaults(preferencePatch).catch(() => undefined),
      );
    }
    if (typeof payload.instructions === 'string') {
      await saveAppAdvisorClaudeMd(payload.instructions);
    }
    if (
      payload.archiveRetentionDays !== undefined ||
      payload.autoArchiveDays !== undefined
    ) {
      const saved = await saveAppAdvisorWorkspaceSettings({
        ...(payload.archiveRetentionDays !== undefined
          ? { archiveRetentionDays: payload.archiveRetentionDays }
          : {}),
        ...(payload.autoArchiveDays !== undefined
          ? { autoArchiveDays: payload.autoArchiveDays }
          : {}),
      });
      sendToWindow(
        surfaces.getMainWindow(),
        IPC_CHANNELS.appAdvisorSettingsChanged,
        saved,
      );
      sendToWindow(
        surfaces.getAppAdvisorWindow(),
        IPC_CHANNELS.appAdvisorSettingsChanged,
        saved,
      );
    }
    context.complete(command, { ok: true });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalAppAdvisorSend(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.app_advisor.send']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (rejectUntrustedPortalChatInput(command, context)) return;
  if (
    !isRecord(command.payload) ||
    typeof command.payload.text !== 'string' ||
    command.payload.text.length === 0
  ) {
    context.fail(
      command,
      'invalid_payload',
      `Invalid ${ORCHESTRATOR_LABEL} send payload.`,
    );
    return;
  }
  const surfaces = requireSurfaces(command, context);
  if (!surfaces) {
    return;
  }
  try {
    const payload = command.payload;
    const knownModel =
      typeof payload.model === 'string'
        ? resolveKnownModel(payload.model)
        : undefined;
    const requestedChatId = readOptionalId(payload.chatId, 'chatId');
    const storedEntry = requestedChatId
      ? await resolveWorkEntryForChat(APP_ADVISOR_PROJECT_ID, requestedChatId)
      : undefined;
    const storedTab = storedEntry?.entryId
      ? (
          await readChatTabsFile(APP_ADVISOR_PROJECT_ID, storedEntry.entryId)
        ).tabs.find((tab) => tab.id === requestedChatId)
      : undefined;
    // The send's own resolver: a chat already on this Agent's route keeps it.
    const requestedModel = knownModel
      ? await resolveSendModelPin(
          APP_ADVISOR_PROJECT_ID,
          storedTab?.model,
          knownModel,
        ).then(
          (pinned) => pinned ?? knownModel,
          (): undefined => undefined,
        )
      : undefined;
    const requestedModelProvider = requestedModel
      ? getProviderForModel(requestedModel)
      : undefined;
    if (
      typeof payload.model === 'string' &&
      (!requestedModel || !requestedModelProvider)
    ) {
      context.fail(
        command,
        'invalid_payload',
        'model must be a known, available model id.',
      );
      return;
    }
    const storedProvider =
      requestedModel === undefined && storedTab
        ? ((storedTab.model
            ? getProviderForModel(storedTab.model)
            : undefined) ?? storedTab.providerType)
        : undefined;

    // A fresh chat with no explicit model runs on the saved App Advisor
    // default, so that is the model the Cursor preflight has to inspect.
    const defaultModelProvider =
      requestedModel === undefined && requestedChatId === undefined
        ? getProviderForModel((await readPreferencesFile()).appAdvisorModel)
        : undefined;
    // A Cursor turn runs on the desktop's managed runtime: the same preflight
    // the worktree chat family applies, so a disconnected runtime fails here
    // rather than after a Work Entry was minted.
    if (
      (requestedModelProvider === 'cursor' ||
        defaultModelProvider === 'cursor' ||
        storedProvider === 'cursor' ||
        payload.providerType === 'cursor') &&
      !(await isCursorRuntimeAvailable())
    ) {
      context.fail(
        command,
        'invalid_payload',
        'Connect Cursor in the desktop app to use it here.',
      );
      return;
    }
    if (
      (requestedModelProvider === 'copilot' ||
        defaultModelProvider === 'copilot' ||
        storedProvider === 'copilot' ||
        payload.providerType === 'copilot') &&
      !(await isCopilotRuntimeAvailable())
    ) {
      context.fail(
        command,
        'invalid_payload',
        'Connect Copilot in the desktop app to use it here.',
      );
      return;
    }
    const providerType = readAgentProviderType(payload.providerType);
    if (
      payload.providerType !== undefined &&
      (!providerType ||
        !requestedModel ||
        providerType !== requestedModelProvider)
    ) {
      context.fail(
        command,
        'invalid_payload',
        'providerType must match the explicit known model.',
      );
      return;
    }
    const requestedEntryId = readOptionalId(payload.workEntryId, 'workEntryId');
    const userMessageId =
      readOptionalId(payload.userMessageId, 'userMessageId') ?? randomUUID();
    const { chatId, entryId } = await resolveOrMintEntry(
      requestedChatId,
      requestedEntryId,
    );

    // Built field-by-field rather than spreading the raw payload: portal
    // payloads are untrusted runtime JSON, so unknown remote fields (e.g. a
    // forged `watcherFired` or `hiddenContext`) must not smuggle through to
    // the dispatch request.
    const fileReferences = sanitizePortalFileReferences(
      payload.fileReferences,
    )?.map((reference) =>
      portalFileReferences.resolve(
        {
          sessionId: context.sessionId ?? '',
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: entryId,
          canRead: context.canReadAssets,
        },
        reference,
      ),
    );
    const attachmentPaths = Array.isArray(payload.attachmentPaths)
      ? payload.attachmentPaths.filter(
          (path): path is string => typeof path === 'string',
        )
      : undefined;
    const effectiveProviderType = providerType ?? requestedModelProvider;
    // Portal sends cannot enter the managed terminal path (that path is only
    // available to automation dispatches). Guard the persisted interface mode
    // itself, including an empty Claude chat whose terminal has not launched
    // and therefore has no sdkSessionId yet.
    const existingTab =
      storedTab ??
      (await readChatTabsFile(APP_ADVISOR_PROJECT_ID, entryId)).tabs.find(
        (tab) => tab.id === chatId,
      );
    if (isTerminalBackedInterfaceMode(existingTab?.interfaceMode)) {
      context.fail(
        command,
        'conflict',
        `Terminal-backed ${ORCHESTRATOR_LABEL} chats cannot be driven from the portal yet.`,
      );
      return;
    }
    const sendRequest: ChatSendMessageRequest = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: entryId,
      chatId,
      userMessageId,
      text: payload.text,
      ...(fileReferences?.length ? { fileReferences } : {}),
      ...(attachmentPaths?.length ? { attachmentPaths } : {}),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(isRecord(payload.modelConfig)
        ? { modelConfig: payload.modelConfig }
        : {}),
      ...(isRecord(payload.pluginSelections)
        ? {
            pluginSelections: normalizePluginSelections(
              payload.pluginSelections,
            ),
          }
        : {}),
      ...(effectiveProviderType ? { providerType: effectiveProviderType } : {}),
      ...(payload.inputMode === 'typed' || payload.inputMode === 'voice'
        ? { inputMode: payload.inputMode }
        : {}),
    };

    // Break the adapter ↔ chat-service initialization cycle; sending is needed
    // only after the command and destination have both been validated.
    const { sendWorktreeChatMessage } =
      await import('../../services/chat-service');
    const result = await sendWorktreeChatMessage(sendRequest, {
      getWindow: context.getWindow,
      appAdvisorSurfaces: surfaces,
    });
    context.complete(command, { ok: true, chatId: result.chatId });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalAppAdvisorSetModel(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.chatId !== 'string' ||
    payload.chatId.length === 0 ||
    typeof payload.model !== 'string' ||
    payload.model.length === 0
  ) {
    context.fail(
      command,
      'invalid_payload',
      `${ORCHESTRATOR_LABEL} set_model requires chatId and model.`,
    );
    return;
  }
  const surfaces = requireSurfaces(command, context);
  if (!surfaces) return;
  try {
    validateId(payload.chatId, 'chatId');
    const knownModel = resolveKnownModel(payload.model);
    // Pin before the provider checks so they judge the route it will run on.
    const model = knownModel
      ? await pinInheritingAgentToDestination(
          knownModel,
          APP_ADVISOR_PROJECT_ID,
        )
      : undefined;
    if (!model) {
      context.fail(
        command,
        'invalid_payload',
        'model must be a known model id.',
      );
      return;
    }
    if (
      getProviderForModel(model) === 'cursor' &&
      !(await isCursorRuntimeAvailable())
    ) {
      context.fail(
        command,
        'invalid_payload',
        'Connect Cursor in the desktop app to use it here.',
      );
      return;
    }
    if (
      getProviderForModel(model) === 'copilot' &&
      !(await isCopilotRuntimeAvailable())
    ) {
      context.fail(
        command,
        'invalid_payload',
        'Connect Copilot in the desktop app to use it here.',
      );
      return;
    }
    const { entryId } = await resolveWorkEntryForChat(
      APP_ADVISOR_PROJECT_ID,
      payload.chatId,
    );
    if (!entryId) {
      context.fail(command, 'not_found', `Unknown ${ORCHESTRATOR_LABEL} chat.`);
      return;
    }
    const tabsFile = await readChatTabsFile(APP_ADVISOR_PROJECT_ID, entryId);
    const tab = tabsFile.tabs.find(
      (candidate) => candidate.id === payload.chatId,
    );
    if (!tab) {
      context.fail(command, 'not_found', `Unknown ${ORCHESTRATOR_LABEL} chat.`);
      return;
    }
    if (tab.readOnly) {
      context.fail(
        command,
        'conflict',
        `Read-only ${ORCHESTRATOR_LABEL} chats cannot change models.`,
      );
      return;
    }
    const terminalState = isTerminalBackedInterfaceMode(tab.interfaceMode)
      ? getClaudeTerminalSessionService().getState(
          APP_ADVISOR_PROJECT_ID,
          entryId,
          payload.chatId,
        )
      : undefined;
    if (
      terminalState?.terminalId &&
      terminalState.turnState !== 'exited' &&
      terminalState.turnState !== 'error'
    ) {
      context.fail(
        command,
        'conflict',
        `Active terminal-backed ${ORCHESTRATOR_LABEL} chats cannot change models from the portal yet.`,
      );
      return;
    }
    const hasPersistedRouting =
      tab.executionHarness !== undefined ||
      tab.model !== undefined ||
      tab.providerType !== undefined ||
      tab.sdkSessionId !== undefined;
    const lockedHarness =
      hasPersistedRouting &&
      (tab.transcript?.messageCount ??
        tab.transcript?.committedMessageCount ??
        tab.messages.length) > 0
        ? resolvePersistedChatExecutionHarness(tab)
        : undefined;
    const selectedHarness = payload.executionHarness;
    if (selectedHarness !== undefined && !isModelHarness(selectedHarness)) {
      context.fail(command, 'invalid_payload', 'executionHarness is invalid.');
      return;
    }
    const modelChangeRequest = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: entryId,
      chatId: payload.chatId,
      model,
      ...(selectedHarness ? { executionHarness: selectedHarness } : {}),
      ...(lockedHarness ? { lockedHarness } : {}),
    };
    const accepted =
      getProviderForModel(model) === 'claude'
        ? await changeChatModel(modelChangeRequest, undefined, {
            // The paired portal cannot drive managed terminal turns, so a
            // portal-originated Claude selection must remain native.
            interfaceModeOverride: 'canopy',
          })
        : await changeChatModel(modelChangeRequest);
    if (!accepted) {
      context.fail(
        command,
        'conflict',
        `The selected model is unavailable for this ${ORCHESTRATOR_LABEL} chat.`,
      );
      return;
    }
    // Break the adapter ↔ chat-service initialization cycle; projection is a
    // post-mutation notification rather than adapter startup work.
    const { projectAppAdvisorChatSummaries } =
      await import('../../services/chat-service');
    await projectAppAdvisorChatSummaries(entryId);
    context.complete(command, { ok: true });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalAppAdvisorCancel(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.app_advisor.cancel']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (!isRecord(payload) || typeof payload.chatId !== 'string') {
    context.fail(
      command,
      'invalid_payload',
      `${ORCHESTRATOR_LABEL} cancel requires a chatId.`,
    );
    return;
  }
  const surfaces = requireSurfaces(command, context);
  if (!surfaces) {
    return;
  }
  try {
    validateId(payload.chatId, 'chatId');
    const presentationFence = captureAppAdvisorSyntheticResultFence(
      payload.chatId,
    );
    const capturedSessions = getAllActiveSessionInfos()
      .filter(
        (info) =>
          info.projectId === APP_ADVISOR_PROJECT_ID &&
          info.chatId === payload.chatId,
      )
      .map((info) =>
        captureChatTurnStop({
          projectId: info.projectId,
          worktreeId: info.worktreeId,
          chatId: info.chatId,
        }),
      );
    const { entryId } = await resolveWorkEntryForChat(
      APP_ADVISOR_PROJECT_ID,
      payload.chatId,
    );
    if (!entryId) {
      context.fail(command, 'not_found', `Unknown ${ORCHESTRATOR_LABEL} chat.`);
      return;
    }
    const target = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: entryId,
      chatId: payload.chatId,
    };
    const stopContext =
      capturedSessions.find(
        (candidate) =>
          candidate.target.projectId === target.projectId &&
          candidate.target.worktreeId === target.worktreeId &&
          candidate.target.chatId === target.chatId,
      ) ??
      ({
        target,
        session: undefined,
        fence: undefined,
      } satisfies ChatTurnStopContext);
    // The Work Entry lookup is async. If a send/wake replaced the synchronously
    // captured session in the meantime, do not hand the stale Stop to service.
    if (!isChatTurnStopCurrent(stopContext)) {
      context.complete(command, { ok: true });
      return;
    }
    // Break the adapter ↔ chat-service initialization cycle; cancellation is
    // loaded only for an existing App Advisor entry.
    const { cancelWorktreeChat } = await import('../../services/chat-service');
    await cancelWorktreeChat(target, stopContext);
    // Provider cancellation resolves without a terminal chat event, so emit
    // the synthetic un-stream record both desktop windows and the portal use
    // to close the visible turn. Best-effort: the cancel itself succeeded.
    const { emitAppAdvisorSyntheticResultEvent } =
      await import('../../app-advisor/chat-service');
    await emitAppAdvisorSyntheticResultEvent(payload.chatId, surfaces, {
      fence: presentationFence,
      ...(stopContext.fence?.userMessageId
        ? { userMessageId: stopContext.fence.userMessageId }
        : {}),
      isCurrent: () => isChatTurnStopCurrent(stopContext),
    }).catch(() => undefined);
    context.complete(command, { ok: true });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalAppAdvisorCreateTab(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.app_advisor.create_tab']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (rejectUntrustedPortalChatInput(command, context)) return;
  const payload: unknown = command.payload;
  if (!isRecord(payload) || typeof payload.chatId !== 'string') {
    context.fail(
      command,
      'invalid_payload',
      `${ORCHESTRATOR_LABEL} create_tab requires a browser-minted chatId.`,
    );
    return;
  }
  const surfaces = requireSurfaces(command, context);
  if (!surfaces) {
    return;
  }
  try {
    const chatId = payload.chatId;
    validateId(chatId, 'chatId');
    if (
      payload.sidebarItemGroupId !== undefined &&
      (!isSidebarItemGroupId(payload.sidebarItemGroupId) ||
        payload.workEntryId !== undefined)
    )
      throw new Error('Invalid sidebar group for a new work entry.');
    const requestedEntryId = readOptionalId(payload.workEntryId, 'workEntryId');
    const entryId = requestedEntryId
      ? (await resolveOrMintEntry(chatId, requestedEntryId)).entryId
      : (
          await createWorkEntry(APP_ADVISOR_PROJECT_ID, {
            id: chatId,
            ...(isSidebarItemGroupId(payload.sidebarItemGroupId)
              ? { sidebarItemGroupId: payload.sidebarItemGroupId }
              : {}),
            createdAt: new Date().toISOString(),
          })
        ).entry.id;
    const tab = await enqueueChatTabMutation(
      APP_ADVISOR_PROJECT_ID,
      entryId,
      async () => {
        const tabsFile = await readChatTabsFile(
          APP_ADVISOR_PROJECT_ID,
          entryId,
        );
        const existing = tabsFile.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        // Idempotent: a duplicate create for an already-persisted tab is a
        // no-op, mirroring the renderer's duplicate-id handling.
        if (existing) {
          return existing;
        }
        const seededTab = {
          id: chatId,
          title: `New ${CHAT_UNIT_LABEL}`,
          createdAt: new Date().toISOString(),
          messages: [],
          kind: 'chat' as const,
        };
        await writeChatTabsFile(APP_ADVISOR_PROJECT_ID, entryId, {
          ...tabsFile,
          tabs: [...tabsFile.tabs, seededTab],
          activeTabId: chatId,
        });
        return seededTab;
      },
    );
    // The renderer persists chat tabs as whole files from its in-memory
    // store, so a store that never learns about this tab silently erases it
    // on its next save. Reuse the hook-tab-started insertion path without
    // activating the tab, fanned out to BOTH windows like other App Advisor
    // chat events.
    const tabStartedEvent = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: entryId,
      chatId,
      tab,
      activateTab: false,
    };
    sendToWindow(
      surfaces.getMainWindow(),
      IPC_CHANNELS.chatHookTabStarted,
      tabStartedEvent,
    );
    sendToWindow(
      surfaces.getAppAdvisorWindow(),
      IPC_CHANNELS.chatHookTabStarted,
      tabStartedEvent,
    );
    // Break the adapter ↔ chat-service initialization cycle; projection is a
    // post-persistence notification rather than adapter startup work.
    const { projectAppAdvisorChatSummaries } =
      await import('../../services/chat-service');
    await projectAppAdvisorChatSummaries(entryId);
    context.complete(command, { ok: true });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

function readPortalQuestionAnswer(
  value: unknown,
): PortalAskUserQuestionAnswer | null {
  if (!Array.isArray(value)) {
    return null;
  }
  // The App Advisor runtime asks one question per request, so only the first
  // answer is meaningful.
  const answer: unknown = value[0];
  if (
    !isRecord(answer) ||
    typeof answer.question !== 'string' ||
    !Array.isArray(answer.selectedOptions) ||
    !answer.selectedOptions.every(
      (option): option is string => typeof option === 'string',
    ) ||
    (answer.questionId !== undefined &&
      typeof answer.questionId !== 'string') ||
    (answer.freeformText !== undefined &&
      typeof answer.freeformText !== 'string')
  ) {
    return null;
  }
  return {
    question: answer.question,
    selectedOptions: answer.selectedOptions,
    ...(answer.questionId !== undefined
      ? { questionId: answer.questionId }
      : {}),
    ...(answer.freeformText !== undefined
      ? { freeformText: answer.freeformText }
      : {}),
  };
}

/**
 * Settle an awaiting App Advisor ask-user question from the portal. `answer`
 * carries the mapped {@link AppAdvisorAskUserAnswer} for an answer command,
 * or `null` for a dismissal. Shared by both commands because they differ only
 * in the settlement value. `chatId` is enforced by the settlement API itself
 * — request ids are globally keyed, so the chat binding is what stops a
 * remote client from answering another chat's question.
 */
function settleAskUserQuestion(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
  requestId: string,
  chatId: string,
  answer: AppAdvisorAskUserAnswer | null,
): void {
  if (
    !completeAppAdvisorAskUserRequest(requestId, chatId, answer, {
      agentOriginated: context.origin !== undefined,
    })
  ) {
    context.fail(
      command,
      'not_found',
      `${ORCHESTRATOR_LABEL} question is no longer awaiting an answer.`,
    );
    return;
  }
  // Close the desktop's own question card so it does not linger after the
  // remote settlement; the renderer treats this like an aborted request.
  const surfaces = getPortalAppAdvisorSurfaces();
  if (surfaces) {
    sendToWindow(
      surfaces.getAppAdvisorWindow(),
      IPC_CHANNELS.appAdvisorToolRequestCancelled,
      { requestId },
    );
  }
  context.complete(command, { ok: true });
}

export function handlePortalAppAdvisorAnswerQuestion(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.app_advisor.answer_question']
  >,
  context: PortalAdapterContext,
): void {
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.chatId !== 'string' ||
    payload.chatId.length === 0 ||
    typeof payload.requestId !== 'string' ||
    payload.requestId.length === 0
  ) {
    context.fail(
      command,
      'invalid_payload',
      `${ORCHESTRATOR_LABEL} answer requires chatId and requestId.`,
    );
    return;
  }
  const answer = readPortalQuestionAnswer(payload.answers);
  if (!answer) {
    context.fail(
      command,
      'invalid_payload',
      `${ORCHESTRATOR_LABEL} answer requires a valid answers array.`,
    );
    return;
  }
  settleAskUserQuestion(
    command,
    context,
    payload.requestId,
    payload.chatId,
    answer,
  );
}

export function handlePortalAppAdvisorDismissQuestion(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.app_advisor.dismiss_question']
  >,
  context: PortalAdapterContext,
): void {
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.chatId !== 'string' ||
    payload.chatId.length === 0 ||
    typeof payload.requestId !== 'string' ||
    payload.requestId.length === 0
  ) {
    context.fail(
      command,
      'invalid_payload',
      `${ORCHESTRATOR_LABEL} dismissal requires chatId and requestId.`,
    );
    return;
  }
  settleAskUserQuestion(
    command,
    context,
    payload.requestId,
    payload.chatId,
    null,
  );
}

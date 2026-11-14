import { resolveCoworkWorkspaceId } from '../../lib/cowork-migration-map';
import { IdentifierValidationError } from '../../lib/validation';
import {
  isSidebarItemGroupColor,
  isSidebarItemGroupId,
  normalizeSidebarItemGroupName,
} from '@canopy/protocol/sidebar';
import {
  isPortalChatAgentProviderType,
  type PortalArchivedWorkEntriesListResult,
  type PortalArchivedWorkEntry,
  type PortalStandaloneChatArchiveResult,
  type PortalStandaloneChatCreatePayload,
  type PortalStandaloneChatCreateResult,
  type PortalTaskFirstChat,
  type PortalTaskFirstChatResult,
  type PortalTaskSidebarItemGroupName,
} from '@canopy/protocol/portal';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { isArchivedContainerExpired } from '@canopy/desktop-shared/lib/archive-retention';
import { chatDisplayLabel } from '@canopy/desktop-shared/lib/chat-display-label';
import {
  getProviderForModel,
  isThinkingLevel,
  resolveKnownModel,
  type AgentModelConfig,
  type ChatTabPluginSelections,
  type PortalCommandEnvelope,
  type PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
import {
  codexSpeedFastMode,
  codexSpeedFromFastMode,
  isCodexSpeed,
  type CodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  isChatTabPluginSelections,
  normalizePluginSelections,
} from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type { PortalAdapterContext } from './types';
import {
  commitPortalPluginSelections,
  resolvePortalChat,
} from './chat-plugin-selections';
import { isCursorRuntimeAvailable } from '../../cursor/runtime-availability';
import { isCopilotRuntimeAvailable } from '../../copilot/runtime-availability';
import { isOpenCodeRuntimeAvailable } from '../../opencode/runtime-availability';
import {
  isModelBlockedByStoredPolicy,
  isOrgModelPolicyActiveForStoredAccount,
} from '../../lib/model-policy-state';
import { failServiceError, isRecord } from './validation';
import { resolveAiCreditsScopeOwner } from '../../agents/work-owner';
import {
  createStandaloneChatTab,
  resolveStandaloneChatTarget,
  sendStandaloneChatMessage,
} from '../../services/standalone-chat-service';
import {
  handlePortalChatSend,
  resolveRemoteCreateTabSeed,
  sanitizePortalFileReferences,
} from './chat-adapter';
import { readPortalChatCloudAttachmentRefs } from '../portal-chat-attachments';
import { validateId } from '../../lib/validation';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { PortalServiceError } from '../../services/portal-service-error';
import { LiveDelegationsError } from '../../agents/delegation/activity';
import { readCoworkFolderMissing } from '@canopy/protocol/canopy-core';
import { noDispatchableModelSendMessage } from '../../lib/send-billing-refusal';

class StandaloneArchivePermissionError extends Error {
  public readonly code = 'forbidden';
}

const STANDALONE_ARCHIVE_PORTAL_FAILURE = "Couldn't archive the chat.";

export async function handlePortalArchivedWorkEntriesList(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const { payload, target } = command;
  if (
    !isRecord(payload) ||
    typeof payload.projectLocalId !== 'string' ||
    target?.workspaceLocalId !== payload.projectLocalId ||
    target.worktreeLocalId !== undefined ||
    target.standaloneChatLocalId !== undefined ||
    (payload.offset !== undefined && payload.offset !== 0)
  ) {
    context.fail(command, 'invalid_payload', 'A matching project is required.');
    return;
  }
  const canRead = (): boolean =>
    context.origin === undefined &&
    context.canArchiveStandaloneChats?.() === true;
  if (!canRead()) {
    context.fail(
      command,
      'forbidden',
      'The paired session cannot list archives.',
    );
    return;
  }
  try {
    validateId(payload.projectLocalId, 'projectLocalId');
    const { listCoworkWorkspacesAsChatProjects } =
      await import('../../lib/cowork-workspace-crud');
    const projectId = resolveCoworkWorkspaceId(payload.projectLocalId);
    const { readAllSidebarItemsSnapshot } =
      await import('../../lib/sidebar-items');
    const sidebar = await readAllSidebarItemsSnapshot({
      persistRemovalCleanup: false,
    });
    const projects = await listCoworkWorkspacesAsChatProjects(sidebar, {
      provisionDefaults: false,
    });
    if (!projects.some((project) => project.id === projectId)) {
      context.fail(command, 'not_found', 'The cowork project is unavailable.');
      return;
    }
    const { listArchivedContainerManifests } =
      await import('../../lib/archived-containers');
    const { listChats } = await import('../../ipc/standalone-chat');
    const [manifests, legacy] = await Promise.all([
      listArchivedContainerManifests(projectId),
      listChats(projectId, { readOnly: true }),
    ]);
    if (!canRead()) {
      context.fail(
        command,
        'forbidden',
        'The paired session cannot list archives.',
      );
      return;
    }
    const now = Date.now();
    const items: PortalArchivedWorkEntry[] = [];
    for (const manifest of manifests) {
      if (
        manifest.kind !== 'work-entry' ||
        isArchivedContainerExpired(manifest, now)
      )
        continue;
      items.push({
        id: manifest.id,
        title: manifest.name.slice(0, 512),
        state: manifest.lockedAt === undefined ? 'deleted' : 'archived',
        archivedAt: manifest.lockedAt ?? manifest.archivedAt,
        expiresAt: manifest.expiresAt,
      });
    }
    for (const chat of legacy.chats) {
      if (chat.archived !== true) continue;
      items.push({
        id: chat.id,
        title: chatDisplayLabel({
          customTitle: chat.customTitle,
          title: chat.title,
          description: chat.description,
          fallback: `New ${CHAT_UNIT_LABEL}`,
        }).slice(0, 512),
        state: 'archived',
        archivedAt: chat.archivedAt ?? chat.lastMessageAt ?? chat.createdAt,
        legacyChat: true,
      });
    }
    const result: PortalArchivedWorkEntriesListResult = {
      items,
      nextOffset: null,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024) {
      throw new Error(
        'Archive overview result exceeded the Portal size budget',
      );
    }
    context.complete(command, { ...result });
  } catch (error) {
    logMainProcessWarn('Portal archived Work Entry list failed', { error });
    context.fail(
      command,
      'execution_failed',
      "Couldn't load archived and deleted items.",
    );
  }
}

/**
 * Archive failures reach the hosted Portal and the browser. Typed refusals
 * carry fixed, path-free copy; any other error (filesystem errors include
 * absolute desktop paths) stays in desktop logs and maps to fixed text.
 */
function portalSafeArchiveError(error: unknown): unknown {
  if (error instanceof IdentifierValidationError)
    return new PortalServiceError('invalid_payload', error.message);
  if (
    error instanceof PortalServiceError ||
    error instanceof StandaloneArchivePermissionError ||
    error instanceof LiveDelegationsError ||
    readCoworkFolderMissing(error) !== undefined
  )
    return error;
  logMainProcessWarn('Portal standalone chat archive failed', { error });
  return new PortalServiceError(
    'execution_failed',
    STANDALONE_ARCHIVE_PORTAL_FAILURE,
  );
}

/** Archive authority remains shared with desktop Work Entry deletion. */
export async function handlePortalStandaloneChatArchive(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  try {
    const payload = command.payload;
    if (
      !isRecord(payload) ||
      typeof payload.chatId !== 'string' ||
      typeof payload.workEntryId !== 'string' ||
      typeof payload.projectLocalId !== 'string'
    ) {
      throw new PortalServiceError(
        'invalid_payload',
        'Invalid standalone chat archive payload.',
      );
    }
    validateId(payload.chatId, 'chatId');
    validateId(payload.workEntryId, 'workEntryId');
    const expectedEntryId = payload.workEntryId;
    validateId(payload.projectLocalId, 'projectLocalId');
    if (
      command.target?.standaloneChatLocalId !== payload.chatId ||
      command.target.workspaceLocalId !== undefined ||
      command.target.worktreeLocalId !== undefined
    ) {
      throw new PortalServiceError(
        'invalid_target',
        'Archive requires the matching standalone chat target.',
      );
    }
    const assertAuthorized = (): void => {
      if (context.canArchiveStandaloneChats?.() !== true) {
        throw new StandaloneArchivePermissionError(
          'The paired session cannot archive Work Entries.',
        );
      }
    };
    assertAuthorized();
    const request = {
      chatId: payload.chatId,
      workEntryId: expectedEntryId,
      projectLocalId: payload.projectLocalId,
    };
    const resolved = await resolveStandaloneChatTarget(request, {
      forArchive: true,
    });
    assertAuthorized();
    if (
      resolveCoworkWorkspaceId(request.projectLocalId) !== resolved.workspaceId
    ) {
      throw new PortalServiceError(
        'invalid_target',
        'The chat does not belong to the supplied project.',
      );
    }
    if (
      !(resolved.isArchived ? resolved.archivedInEntryId : resolved.entryId)
    ) {
      throw new PortalServiceError(
        'not_found',
        'The chat has no verifiable Work Entry.',
      );
    }
    // Bind the displayed Work Entry before acquiring any lifecycle resources.
    if ((resolved.entryId ?? resolved.archivedInEntryId) !== expectedEntryId) {
      throw new PortalServiceError(
        'invalid_target',
        'The Work Entry changed before archive.',
      );
    }
    const { withArchivedWorkspaceOperationLock } =
      await import('../../lib/archived-containers');
    const { deleteWorkEntry, withWorkEntryDeletionRetirement } =
      await import('../../lib/work-entry-delete');
    const revalidate = async (): Promise<true> => {
      assertAuthorized();
      const current = await resolveStandaloneChatTarget(
        { ...request, projectLocalId: resolved.workspaceId },
        { forArchive: true },
      );
      assertAuthorized();
      if (
        current.workspaceId !== resolved.workspaceId ||
        (current.entryId ?? current.archivedInEntryId) !== expectedEntryId ||
        (resolved.isArchived && !current.isArchived)
      )
        throw new PortalServiceError(
          'invalid_target',
          'The Work Entry changed before archive.',
        );
      return true;
    };
    const result = await withWorkEntryDeletionRetirement(
      { workspaceId: resolved.workspaceId, entryId: expectedEntryId },
      async (retirement): Promise<PortalStandaloneChatArchiveResult> => {
        if (!retirement)
          throw new PortalServiceError(
            'invalid_target',
            'The Work Entry changed before archive.',
          );
        return withArchivedWorkspaceOperationLock(
          resolved.workspaceId,
          async (): Promise<PortalStandaloneChatArchiveResult> => {
            await revalidate();
            await deleteWorkEntry({
              workspaceId: resolved.workspaceId,
              entryId: expectedEntryId,
              lockAfterArchive: true,
              retirement,
              beforeTeardown: assertAuthorized,
              // The server confirms the pairing before the first destructive write.
              confirmBeforeCommit: async () => {
                if ((await context.confirmArchivePairing?.()) !== true)
                  throw new StandaloneArchivePermissionError(
                    'The paired session cannot archive Work Entries.',
                  );
                assertAuthorized();
              },
            });
            return {
              ok: true,
              chatId: request.chatId,
              projectLocalId: resolved.workspaceId,
              workEntryId: expectedEntryId,
            };
          },
        );
      },
      revalidate,
      // Retirement preparation awaits before disposing the entry's live
      // browser views; recheck authorization right before disposal.
      assertAuthorized,
    );
    context.complete(command, result);
  } catch (error) {
    failServiceError(command, context, portalSafeArchiveError(error));
  }
}

export async function handlePortalStandaloneChatCreate(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  try {
    const read = readStandaloneChatCreatePayload(command.payload);
    if (!read) {
      throw new PortalServiceError(
        'invalid_payload',
        'Invalid standalone chat create payload.',
      );
    }
    const { payload, firstChat } = read;
    if (
      context.canReadAssets?.() !== true ||
      command.target?.standaloneChatLocalId !== payload.chatId ||
      command.target.workspaceLocalId !== undefined ||
      command.target.worktreeLocalId !== undefined
    ) {
      throw new PortalServiceError(
        'invalid_target',
        'The new chat must target the current paired standalone session.',
      );
    }
    const dispatchCommand = context.dispatchChatCommand;
    if (!dispatchCommand) {
      throw new PortalServiceError(
        'execution_failed',
        'The chat service is temporarily unavailable.',
      );
    }
    const request = payload;
    const resolved = await resolveStandaloneChatTarget(request);
    if (resolved.isArchived) {
      throw new PortalServiceError(
        payload.workEntryId === undefined ? 'invalid_target' : 'not_found',
        'Archived chats must be restored before they can be used.',
      );
    }
    const requestedModel =
      firstChat?.payload.model === undefined
        ? undefined
        : {
            model:
              resolveKnownModel(firstChat.payload.model) ??
              firstChat.payload.model,
            ...(firstChat.payload.providerType === undefined
              ? {}
              : { providerType: firstChat.payload.providerType }),
          };
    const seed = resolved.entryId
      ? {}
      : await resolveRemoteCreateTabSeed(resolved.workspaceId, requestedModel);
    if ('noDispatchableModel' in seed) {
      throw new PortalServiceError(
        'invalid_payload',
        'No permitted model is available for a new chat.',
      );
    }
    const canCreate = (): boolean => context.canReadAssets?.() === true;
    const result = await createStandaloneChatTab(request, {
      commandId: command.id,
      dispatchCommand,
      seed,
      canCreate,
    });
    if (!canCreate()) {
      throw new PortalServiceError(
        'invalid_target',
        'The paired session is no longer authorized.',
      );
    }
    let response: PortalStandaloneChatCreateResult = result;
    let chatError: string | undefined;
    if (firstChat) {
      try {
        if (!canCreate()) {
          throw new PortalServiceError(
            'invalid_target',
            'The paired session is no longer authorized.',
          );
        }
        const sent = await sendStandaloneChatMessage(
          {
            projectLocalId: result.projectLocalId,
            workEntryId: result.workEntryId,
            chatId: firstChat.payload.chatId,
            userMessageId: firstChat.payload.userMessageId,
            message: firstChat.payload.text,
            initiationSource: 'portal',
            ...(context.origin ? { agentSent: context.origin } : {}),
            ...(firstChat.payload.planMode === undefined
              ? {}
              : { planMode: firstChat.payload.planMode }),
            ...(firstChat.payload.model === undefined
              ? {}
              : { model: firstChat.payload.model }),
            ...(firstChat.payload.providerType === undefined
              ? {}
              : { providerType: firstChat.payload.providerType }),
            ...(firstChat.modelConfig === undefined
              ? {}
              : { modelConfig: firstChat.modelConfig }),
            ...(firstChat.pluginSelections === undefined
              ? {}
              : { pluginSelections: firstChat.pluginSelections }),
          },
          { getWindow: context.getWindow, canCommitSend: canCreate },
        );
        if (!canCreate()) {
          throw new PortalServiceError(
            'invalid_target',
            'The paired session is no longer authorized.',
          );
        }
        const chat: PortalTaskFirstChatResult = {
          chatId: firstChat.payload.chatId,
          userMessageId: firstChat.payload.userMessageId,
          delivery: sent.delivery === 'queued' ? 'queued' : 'started',
        };
        response = { ...result, chat };
      } catch (error) {
        logMainProcessWarn(
          'Portal first chat message failed after standalone chat creation',
          { error },
        );
        chatError =
          'The chat was created, but its first message could not be sent.';
      }
      if (chatError) response = { ...result, chatError };
    }
    context.complete(command, response);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/** The validated Codex speed fields of an untrusted Portal `modelConfig`. */
type PortalModelConfigSpeedRead =
  | { ok: true; fields: { speed?: CodexSpeed; fastMode?: boolean } }
  | { ok: false; error: string };

/**
 * Validate the Codex speed fields of an untrusted Portal `modelConfig`.
 *
 * An upgraded client's exact `speed` is honored and paired with its derived
 * legacy boolean. A legacy boolean on its own is an explicit Fast or Regular
 * choice, so it is carried as that exact speed and replaces the current one,
 * including Ultra fast. A config naming neither carries no speed fields, so a
 * thinking-only change never restates the chat's speed. An invalid speed, a
 * non-boolean `fastMode`, or a boolean contradicting the speed is refused
 * rather than dropped.
 */
function readPortalModelConfigSpeed(
  modelConfig: Record<string, unknown>,
): PortalModelConfigSpeedRead {
  const speed: unknown = modelConfig.speed;
  const fastMode: unknown = modelConfig.fastMode;
  let legacyFastMode: boolean | undefined;
  if (typeof fastMode === 'boolean') {
    legacyFastMode = fastMode;
  } else if (fastMode !== undefined) {
    return { ok: false, error: 'modelConfig.fastMode must be a boolean.' };
  }
  if (speed === undefined) {
    return legacyFastMode === undefined
      ? { ok: true, fields: {} }
      : {
          ok: true,
          fields: {
            speed: codexSpeedFromFastMode(legacyFastMode),
            fastMode: legacyFastMode,
          },
        };
  }
  if (!isCodexSpeed(speed)) {
    return {
      ok: false,
      error: 'modelConfig.speed must be standard, fast, or ultrafast.',
    };
  }
  const derivedFastMode = codexSpeedFastMode(speed);
  if (legacyFastMode !== undefined && legacyFastMode !== derivedFastMode) {
    return {
      ok: false,
      error: 'modelConfig.fastMode must match modelConfig.speed.',
    };
  }
  return { ok: true, fields: { speed, fastMode: derivedFastMode } };
}

interface ParsedStandaloneFirstChat {
  payload: PortalTaskFirstChat;
  modelConfig?: AgentModelConfig;
  pluginSelections?: ChatTabPluginSelections;
}

interface ParsedStandaloneCreatePayload {
  payload: PortalStandaloneChatCreatePayload;
  firstChat?: ParsedStandaloneFirstChat;
}

function hasOnlyFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function recordArrayHasOnlyFields(
  value: unknown,
  allowed: readonly string[],
): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => isRecord(entry) && hasOnlyFields(entry, allowed))
  );
}

function isStrictPortalPluginSelections(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, [
      'unresolvedCapabilities',
      'collectionIds',
      'bundleIds',
      'skillRefs',
      'pluginRefs',
      'mcpServerRefs',
      'mcpHttpAuthPreferences',
    ]) ||
    !isChatTabPluginSelections(value) ||
    !recordArrayHasOnlyFields(value.skillRefs, ['sourceId', 'skillName']) ||
    !recordArrayHasOnlyFields(value.pluginRefs, ['marketplaceId', 'pluginName'])
  ) {
    return false;
  }
  if (
    value.mcpServerRefs !== undefined &&
    !recordArrayHasOnlyFields(value.mcpServerRefs, ['serverId', 'configId'])
  ) {
    return false;
  }
  if (value.mcpHttpAuthPreferences !== undefined) {
    if (
      !Array.isArray(value.mcpHttpAuthPreferences) ||
      !value.mcpHttpAuthPreferences.every((entry: unknown) => {
        if (
          !isRecord(entry) ||
          !hasOnlyFields(entry, ['target', 'handler']) ||
          !isRecord(entry.target)
        ) {
          return false;
        }
        const allowedTargetFields =
          entry.target.kind === 'standalone'
            ? ['kind', 'serverId', 'configId']
            : ['kind', 'marketplaceId', 'pluginName', 'serverName'];
        return hasOnlyFields(entry.target, allowedTargetFields);
      })
    ) {
      return false;
    }
  }
  return true;
}

function readSidebarItemGroupName(
  value: unknown,
): PortalTaskSidebarItemGroupName | null {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ['name', 'color']) ||
    typeof value.name !== 'string' ||
    !normalizeSidebarItemGroupName(value.name)
  ) {
    return null;
  }
  const color: unknown = value.color;
  if (color !== undefined && !isSidebarItemGroupColor(color)) return null;
  return {
    name: value.name,
    ...(color === undefined ? {} : { color }),
  };
}

function readStandaloneFirstChat(
  value: unknown,
  createChatId: string,
): ParsedStandaloneFirstChat | null {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, [
      'chatId',
      'userMessageId',
      'text',
      'planMode',
      'model',
      'providerType',
      'modelConfig',
      'pluginSelections',
    ]) ||
    typeof value.chatId !== 'string' ||
    value.chatId !== createChatId ||
    typeof value.userMessageId !== 'string' ||
    typeof value.text !== 'string' ||
    value.text.trim().length === 0 ||
    (value.planMode !== undefined && typeof value.planMode !== 'boolean') ||
    (value.model !== undefined &&
      (typeof value.model !== 'string' ||
        value.model.trim().length === 0 ||
        value.model.length > 256)) ||
    (value.providerType !== undefined && value.model === undefined) ||
    (value.providerType !== undefined &&
      !isPortalChatAgentProviderType(value.providerType)) ||
    (value.modelConfig !== undefined &&
      (!isRecord(value.modelConfig) ||
        !hasOnlyFields(value.modelConfig, [
          'thinkingLevel',
          'speed',
          'fastMode',
        ]))) ||
    (value.pluginSelections !== undefined &&
      !isStrictPortalPluginSelections(value.pluginSelections))
  ) {
    return null;
  }
  try {
    validateId(value.chatId, 'chatId');
    validateId(value.userMessageId, 'userMessageId');
  } catch {
    return null;
  }

  let modelConfig: AgentModelConfig | undefined;
  if (value.modelConfig !== undefined) {
    const thinkingLevel: unknown = value.modelConfig.thinkingLevel;
    if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) {
      return null;
    }
    const speed = readPortalModelConfigSpeed(value.modelConfig);
    if (!speed.ok) return null;
    modelConfig = {
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...speed.fields,
    };
  }

  const pluginSelections =
    value.pluginSelections === undefined
      ? undefined
      : normalizePluginSelections(value.pluginSelections);
  const firstChatPayload: PortalTaskFirstChat = {
    chatId: value.chatId,
    userMessageId: value.userMessageId,
    text: value.text,
    ...(value.planMode === undefined ? {} : { planMode: value.planMode }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.providerType === undefined
      ? {}
      : { providerType: value.providerType }),
    ...(modelConfig === undefined ? {} : { modelConfig }),
    ...(pluginSelections === undefined ? {} : { pluginSelections }),
  };
  return {
    payload: firstChatPayload,
    ...(modelConfig === undefined ? {} : { modelConfig }),
    ...(pluginSelections === undefined ? {} : { pluginSelections }),
  };
}

function readStandaloneChatCreatePayload(
  value: unknown,
): ParsedStandaloneCreatePayload | null {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, [
      'projectLocalId',
      'chatId',
      'workEntryId',
      'sidebarItemGroupId',
      'sidebarItemGroupName',
      'firstChat',
    ]) ||
    typeof value.projectLocalId !== 'string' ||
    typeof value.chatId !== 'string' ||
    (value.workEntryId !== undefined &&
      typeof value.workEntryId !== 'string') ||
    (value.sidebarItemGroupId !== undefined &&
      !isSidebarItemGroupId(value.sidebarItemGroupId))
  ) {
    return null;
  }
  try {
    validateId(value.projectLocalId, 'projectLocalId');
    validateId(value.chatId, 'chatId');
    if (value.workEntryId !== undefined)
      validateId(value.workEntryId, 'workEntryId');
    if (value.sidebarItemGroupId !== undefined)
      validateId(value.sidebarItemGroupId, 'sidebarItemGroupId');
  } catch {
    return null;
  }

  let sidebarItemGroupName: PortalTaskSidebarItemGroupName | undefined;
  if (value.sidebarItemGroupName !== undefined) {
    const parsed = readSidebarItemGroupName(value.sidebarItemGroupName);
    if (!parsed) return null;
    sidebarItemGroupName = parsed;
  }
  let firstChat: ParsedStandaloneFirstChat | undefined;
  if (value.firstChat !== undefined) {
    const parsed = readStandaloneFirstChat(value.firstChat, value.chatId);
    if (!parsed) return null;
    firstChat = parsed;
  }
  return {
    payload: {
      projectLocalId: value.projectLocalId,
      chatId: value.chatId,
      ...(value.workEntryId === undefined
        ? {}
        : { workEntryId: value.workEntryId }),
      ...(value.sidebarItemGroupId === undefined
        ? {}
        : { sidebarItemGroupId: value.sidebarItemGroupId }),
      ...(sidebarItemGroupName === undefined ? {} : { sidebarItemGroupName }),
      ...(firstChat === undefined ? {} : { firstChat: firstChat.payload }),
    },
    ...(firstChat === undefined ? {} : { firstChat }),
  };
}

/** The validated model-config patch of a worktree `portal.chat.send`. */
type PortalSendModelConfigPatchRead =
  | { ok: true; explicit: boolean; patch: AgentModelConfig }
  | { ok: false; error: string };

/**
 * Validate and assemble the model-config patch of an untrusted worktree
 * `portal.chat.send` payload (shared with the worktree adapter, which merges
 * it over the chat's persisted config with `mergeAgentModelConfig`).
 *
 * Field precedence is `modelConfig`, then the deprecated top-level
 * `thinkingLevel` and `codexFastModeEnabled`. The patch keeps command
 * semantics: an exact `speed` wins, a legacy boolean without one replaces the
 * speed (including `false` on Ultra fast), and a patch naming neither keeps
 * the chat's speed. An exact speed contradicted by either boolean is refused.
 * `explicit` is false when the payload names no model settings at all.
 */
export function readPortalSendModelConfigPatch(
  payload: PortalCommandPayloadMap['portal.chat.send'],
): PortalSendModelConfigPatchRead {
  const modelConfig: unknown = payload.modelConfig;
  if (modelConfig !== undefined && !isRecord(modelConfig)) {
    return { ok: false, error: 'modelConfig must be an object.' };
  }
  const legacyFastMode: unknown = payload.codexFastModeEnabled;
  if (legacyFastMode !== undefined && typeof legacyFastMode !== 'boolean') {
    return { ok: false, error: 'codexFastModeEnabled must be a boolean.' };
  }
  if (modelConfig !== undefined) {
    const speed = readPortalModelConfigSpeed(modelConfig);
    if (!speed.ok) return speed;
    if (
      modelConfig.speed !== undefined &&
      speed.fields.fastMode !== undefined &&
      typeof legacyFastMode === 'boolean' &&
      legacyFastMode !== speed.fields.fastMode
    ) {
      return {
        ok: false,
        error: 'codexFastModeEnabled must match modelConfig.speed.',
      };
    }
  }
  return {
    ok: true,
    explicit:
      payload.modelConfig !== undefined ||
      payload.thinkingLevel !== undefined ||
      legacyFastMode !== undefined,
    patch: {
      ...(payload.thinkingLevel !== undefined
        ? { thinkingLevel: payload.thinkingLevel }
        : {}),
      ...(typeof legacyFastMode === 'boolean'
        ? { fastMode: legacyFastMode }
        : {}),
      ...payload.modelConfig,
    },
  };
}

/**
 * Whether a text-only standalone send can use the canonical path, which keeps
 * the client's `userMessageId` and returns an idempotent receipt. It needs a
 * chat that already exists. Clients that announce nothing about the
 * `standalone_chat_create` handshake (released mobile builds, for example)
 * still send a `userMessageId` and rely on the first send creating the chat,
 * so every other text-only send keeps the older path, where the desktop
 * creates the chat and mints the message id. Attachment and file-reference
 * sends always take the canonical path and are refused there without a chat.
 */
async function isCanonicalStandaloneTextSend(
  command: PortalCommandEnvelope<unknown>,
  payload: {
    chatId: string;
    userMessageId?: string;
    projectId?: string;
    projectLocalId?: string;
  },
  context: PortalAdapterContext,
): Promise<boolean> {
  if (
    !payload.userMessageId ||
    context.canReadAssets?.() !== true ||
    !context.dispatchChatCommand ||
    command.target?.standaloneChatLocalId !== payload.chatId ||
    command.target.workspaceLocalId !== undefined ||
    command.target.worktreeLocalId !== undefined
  )
    return false;
  try {
    const resolved = await resolveStandaloneChatTarget(payload);
    return resolved.entryId !== null && !resolved.isArchived;
  } catch {
    // The older path validates the target and reports its own error.
    return false;
  }
}

export async function handlePortalStandaloneChatSend(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const read = readStandaloneChatSendPayload(command.payload);
  if (!read.ok) {
    context.fail(command, 'invalid_payload', read.error);
    return;
  }
  const payload = read.payload;
  const carriesAssets =
    isRecord(command.payload) &&
    (command.payload.cloudAttachments !== undefined ||
      command.payload.fileReferences !== undefined);
  if (
    carriesAssets ||
    (await isCanonicalStandaloneTextSend(command, payload, context))
  ) {
    try {
      if (context.canReadAssets?.() !== true || !context.dispatchChatCommand) {
        throw new PortalServiceError(
          'invalid_target',
          'This paired session cannot send chat attachments.',
        );
      }
      if (
        command.target?.standaloneChatLocalId !== payload.chatId ||
        command.target.workspaceLocalId !== undefined ||
        command.target.worktreeLocalId !== undefined ||
        !payload.userMessageId
      ) {
        throw new PortalServiceError(
          'invalid_target',
          'A canonical standalone target and user message id are required.',
        );
      }
      validateId(payload.chatId, 'chatId');
      validateId(payload.userMessageId, 'userMessageId');
      const resolved = await resolveStandaloneChatTarget(payload);
      if (!resolved.entryId || resolved.isArchived) {
        throw new PortalServiceError(
          'invalid_target',
          'Create or restore this chat before sending a message.',
        );
      }
      const cloudAttachments = readPortalChatCloudAttachmentRefs(
        isRecord(command.payload)
          ? command.payload.cloudAttachments
          : undefined,
      );
      const fileReferences = sanitizePortalFileReferences(
        isRecord(command.payload) ? command.payload.fileReferences : undefined,
      );
      await handlePortalChatSend(
        {
          ...command,
          type: 'portal.chat.send',
          payload: {
            projectId: resolved.workspaceId,
            worktreeId: resolved.entryId,
            chatId: payload.chatId,
            userMessageId: payload.userMessageId,
            text: payload.message,
            ...(cloudAttachments !== undefined ? { cloudAttachments } : {}),
            ...(fileReferences !== undefined ? { fileReferences } : {}),
            ...(payload.model !== undefined ? { model: payload.model } : {}),
            ...(payload.modelConfig !== undefined
              ? { modelConfig: payload.modelConfig }
              : {}),
            ...(payload.inputMode !== undefined
              ? { inputMode: payload.inputMode }
              : {}),
            ...(payload.providerType !== undefined
              ? { providerType: payload.providerType }
              : {}),
            ...(payload.thinkingLevel !== undefined
              ? { thinkingLevel: payload.thinkingLevel }
              : {}),
          },
        },
        {
          ...context,
          complete: (_mappedCommand, result): void =>
            context.complete(
              command,
              isRecord(result)
                ? {
                    ...result,
                    ok: true,
                    chatId: payload.chatId,
                    userMessageId: payload.userMessageId,
                  }
                : result,
            ),
          fail: (_mappedCommand, code, message, retryable): void =>
            context.fail(command, code, message, retryable),
        },
      );
    } catch (error) {
      failServiceError(command, context, error);
    }
    return;
  }
  // Reject a policy-blocked model BEFORE `sendStandaloneChatMessage` runs:
  // that service mints a durable Work Entry (`createWorkEntry()`) and persists
  // the user message, while `getOrCreateSession` only fail-closes once the
  // turn starts. Without this, a blocked cowork send leaves the same partial
  // state the worktree send guard exists to prevent.
  //
  // `resolveStandaloneChatPolicyModels` is the single resolver shared with the
  // send path, so the preflight judges the ONE model the send would actually
  // dispatch, by the same precedence: the payload's model, else the tab's
  // persisted model (dispatch inherits it), else
  // `defaultChatModelByProvider[provider]`. A chat pinned to a now-blocked
  // model is refused at the tab step rather than quietly falling through to a
  // different default — "refuse over substitute" comes from the precedence
  // itself, not from judging a union. Judging models the turn cannot reach was
  // tried and produced permanent false refusals; see the resolver's doc.
  //
  // `providerType` must be forwarded: `sendStandaloneChatMessage` hands it to
  // `dispatchWorktreeChatTurn`, which resolves the dispatched default as
  // `providerType ?? (model ? providerFor(model) : 'claude')`. Judging
  // `'claude'` for a payload that carries `providerType: 'codex'` and no model
  // checks a default the turn will never run, and lets the Codex default it
  // WILL run through — persisting a Work Entry and the user message before the
  // session gate refuses. Web sends this field on cowork sends today.
  try {
    const { resolveStandaloneChatPolicyModels } =
      await import('../../services/standalone-chat-service');
    const explicitModel =
      typeof payload.model === 'string'
        ? (resolveKnownModel(payload.model) ?? payload.model)
        : undefined;
    const payloadProvider =
      payload.providerType === 'claude' ||
      payload.providerType === 'codex' ||
      payload.providerType === 'ollama' ||
      payload.providerType === 'copilot' ||
      payload.providerType === 'antigravity' ||
      payload.providerType === 'opencode' ||
      payload.providerType === 'cursor'
        ? payload.providerType
        : undefined;
    // Same order as the desktop chat IPC: a disconnected runtime is the more
    // fundamental blocker, so a Cursor route the payload itself names is
    // checked against the runtime before its model requirement. Routes the
    // resolver derives (the tab's persisted model) are checked further down.
    const payloadRequestsCursor =
      payloadProvider === 'cursor' ||
      (explicitModel !== undefined &&
        getProviderForModel(explicitModel) === 'cursor');
    if (payloadRequestsCursor && !(await isCursorRuntimeAvailable())) {
      context.fail(
        command,
        'invalid_payload',
        'Connect Cursor in the desktop app to use it here.',
      );
      return;
    }
    const payloadRequestsCopilot =
      payloadProvider === 'copilot' ||
      (explicitModel !== undefined &&
        getProviderForModel(explicitModel) === 'copilot');
    if (payloadRequestsCopilot && !(await isCopilotRuntimeAvailable())) {
      context.fail(
        command,
        'invalid_payload',
        'Connect Copilot in the desktop app to use it here.',
      );
      return;
    }
    const payloadRequestsOpenCode =
      payloadProvider === 'opencode' ||
      (explicitModel !== undefined &&
        getProviderForModel(explicitModel) === 'opencode');
    if (payloadRequestsOpenCode && !(await isOpenCodeRuntimeAvailable())) {
      context.fail(
        command,
        'invalid_payload',
        'Connect OpenCode in the desktop app to use it here.',
      );
      return;
    }
    const {
      readable,
      models,
      noDispatchableModel,
      cursorModelRequired,
      copilotModelRequired,
      antigravityModelRequired,
      opencodeModelRequired,
    } = await resolveStandaloneChatPolicyModels({
      projectId: payload.projectId,
      projectLocalId: payload.projectLocalId,
      chatId: payload.chatId,
      model: explicitModel,
      ...(payloadProvider ? { providerType: payloadProvider } : {}),
    });
    const workOwner = await resolveAiCreditsScopeOwner(
      payload.projectId
        ? {
            kind: 'work',
            projectId: payload.projectId,
            chatId: payload.chatId,
          }
        : { kind: 'navigation' },
    );
    // A DEFINITE "nothing can run this" answer, refused for its own reason and
    // BEFORE the `readable` branch below. This is the second of exactly two
    // consumers of the resolver; ignoring the field here collapsed the dead end
    // back into `readable: false`, so an org-policied Portal user was told
    // "Your organization policy could not be applied" for a billing dead end,
    // and a non-org Portal user was waved through to mint a Work Entry and
    // persist their message before the service threw one layer down.
    //
    // A Cursor route with no model to run is refused first, with the message
    // the service and the chat IPC use, so the Portal user is never told about
    // a Claude default this send would not run.
    if (
      cursorModelRequired ||
      copilotModelRequired ||
      antigravityModelRequired ||
      opencodeModelRequired
    ) {
      context.fail(
        command,
        'invalid_payload',
        antigravityModelRequired
          ? 'Choose a Google subscription model before sending.'
          : opencodeModelRequired
            ? 'Choose an OpenCode model before sending.'
            : copilotModelRequired
              ? 'Choose a Copilot model to send with Copilot, or choose another model.'
              : 'Choose a Cursor model to send with Cursor, or choose another model.',
      );
      return;
    }
    if (noDispatchableModel) {
      context.fail(
        command,
        'invalid_payload',
        noDispatchableModelSendMessage(noDispatchableModel.missing),
      );
      return;
    }
    // Stored-account predicate for the same reason the worktree send uses it:
    // `currentPolicy` is empty until the first account read lands and startup
    // does not await that, so the sync predicate answers "no policy" for a
    // policed user during the window. This is the UNKNOWN-model branch, where
    // `isModelBlockedByStoredPolicy(undefined)` returns early without reading
    // the account — so if this waves the send through, nothing evaluates
    // policy at all. The stored variant consults the encrypted account and the
    // durable enforcing-org marker and therefore fails closed.
    if (
      !readable &&
      (await isOrgModelPolicyActiveForStoredAccount(workOwner))
    ) {
      // Refuse over substitute: the model this send would dispatch is unknown
      // — preferences were unreadable, or they carried no concrete default for
      // a policed provider — and every downstream check treats an unknown
      // model as permitted.
      context.fail(
        command,
        'invalid_payload',
        'Your organization policy could not be applied to this message. Try again.',
      );
      return;
    }
    const blocked = await Promise.all(
      models.map((model) => isModelBlockedByStoredPolicy(model, workOwner)),
    );
    if (blocked.some(Boolean)) {
      // `invalid_payload` is reused for policy denials because
      // `PortalAdapterFailureCode` is a closed union mirrored cross-repo; the
      // message is what distinguishes "forbidden" from "malformed".
      context.fail(
        command,
        'invalid_payload',
        'This model is blocked by your organization policy.',
      );
      return;
    }
    // A Cursor turn runs on the desktop's managed runtime: the same preflight
    // the worktree adapter applies, before `sendStandaloneChatMessage` mints a
    // Work Entry or persists the message. Check every routing input: the
    // explicit provider, the explicit model, and the resolver's models (the
    // tab's persisted model or the dispatched default when none was named).
    // The payload's own Cursor signals were already checked above; only a
    // route the resolver derived still needs the probe.
    const cursorRequested =
      !payloadRequestsCursor &&
      models.some((model) => getProviderForModel(model) === 'cursor');
    if (cursorRequested && !(await isCursorRuntimeAvailable())) {
      context.fail(
        command,
        'invalid_payload',
        'Connect Cursor in the desktop app to use it here.',
      );
      return;
    }
    if (
      !payloadRequestsCopilot &&
      models.some((model) => getProviderForModel(model) === 'copilot') &&
      !(await isCopilotRuntimeAvailable())
    ) {
      context.fail(
        command,
        'invalid_payload',
        'Connect Copilot in the desktop app to use it here.',
      );
      return;
    }
    if (
      !payloadRequestsOpenCode &&
      models.some((model) => getProviderForModel(model) === 'opencode') &&
      !(await isOpenCodeRuntimeAvailable())
    ) {
      context.fail(
        command,
        'invalid_payload',
        'Connect OpenCode in the desktop app to use it here.',
      );
      return;
    }
  } catch (error) {
    failServiceError(command, context, error);
    return;
  }
  try {
    const { sendStandaloneChatMessage } =
      await import('../../services/standalone-chat-service');
    const sendRequest = {
      initiationSource: 'portal' as const,
      ...(payload.projectLocalId !== undefined
        ? { projectLocalId: payload.projectLocalId }
        : {}),
      ...(payload.projectId !== undefined
        ? { projectId: payload.projectId }
        : {}),
      chatId: payload.chatId,
      message: payload.message,
      ...(payload.sidebarItemGroupId
        ? { sidebarItemGroupId: payload.sidebarItemGroupId }
        : {}),
      ...(payload.model !== undefined ? { model: payload.model } : {}),
      ...(payload.modelConfig !== undefined
        ? { modelConfig: payload.modelConfig }
        : {}),
      ...(payload.inputMode !== undefined
        ? { inputMode: payload.inputMode }
        : {}),
      ...(payload.thinkingLevel !== undefined
        ? { thinkingLevel: payload.thinkingLevel }
        : {}),
      // Forwarded so the service sees the provider this preflight judged.
      // The service refuses a Cursor route that has no model to run before
      // anything persists. When the tab already holds a model, dispatch
      // derives the provider from that model rather than from this field;
      // a provider-only send on an empty tab resolves the provider's
      // default there.
      ...(payload.providerType !== undefined
        ? { providerType: payload.providerType }
        : {}),
      ...(context.origin ? { agentSent: context.origin } : {}),
    };
    context.complete(
      command,
      await sendStandaloneChatMessage(sendRequest, {
        getWindow: context.getWindow,
      }),
    );
  } catch (error) {
    failServiceError(command, context, error);
  }
}

type StandaloneChatSendPayloadRead =
  | {
      ok: true;
      payload: PortalCommandPayloadMap['portal.standalone_chat.send'];
    }
  | { ok: false; error: string };

const INVALID_STANDALONE_SEND_PAYLOAD = 'Invalid standalone chat send payload.';

function readStandaloneChatSendPayload(
  value: unknown,
): StandaloneChatSendPayloadRead {
  if (
    !isRecord(value) ||
    typeof value.chatId !== 'string' ||
    typeof value.message !== 'string' ||
    (value.sidebarItemGroupId !== undefined &&
      !isSidebarItemGroupId(value.sidebarItemGroupId)) ||
    (value.projectLocalId !== undefined &&
      typeof value.projectLocalId !== 'string') ||
    (value.projectId !== undefined && typeof value.projectId !== 'string') ||
    (value.model !== undefined && typeof value.model !== 'string') ||
    (value.userMessageId !== undefined &&
      typeof value.userMessageId !== 'string') ||
    (value.inputMode !== undefined &&
      value.inputMode !== 'typed' &&
      value.inputMode !== 'voice') ||
    (value.providerType !== undefined &&
      value.providerType !== 'claude' &&
      value.providerType !== 'codex' &&
      value.providerType !== 'ollama' &&
      value.providerType !== 'cursor' &&
      value.providerType !== 'copilot' &&
      value.providerType !== 'antigravity' &&
      value.providerType !== 'opencode') ||
    (value.thinkingLevel !== undefined &&
      !isThinkingLevel(value.thinkingLevel)) ||
    (value.modelConfig !== undefined && !isRecord(value.modelConfig))
  ) {
    return { ok: false, error: INVALID_STANDALONE_SEND_PAYLOAD };
  }
  const modelConfig = value.modelConfig;
  const modelConfigThinkingLevel: unknown = modelConfig?.thinkingLevel;
  if (
    modelConfigThinkingLevel !== undefined &&
    !isThinkingLevel(modelConfigThinkingLevel)
  ) {
    return { ok: false, error: INVALID_STANDALONE_SEND_PAYLOAD };
  }
  // The exact speed rides the wire beside its legacy boolean. Validated here
  // so an upgraded client's Ultra fast reaches the service instead of being
  // silently dropped, and a contradictory pair is refused.
  const speed = modelConfig ? readPortalModelConfigSpeed(modelConfig) : null;
  if (speed && !speed.ok) {
    return speed;
  }
  return {
    ok: true,
    payload: {
      ...(value.projectLocalId !== undefined
        ? { projectLocalId: value.projectLocalId }
        : {}),
      ...(value.projectId !== undefined ? { projectId: value.projectId } : {}),
      chatId: value.chatId,
      ...(value.userMessageId !== undefined
        ? { userMessageId: value.userMessageId }
        : {}),
      ...(isSidebarItemGroupId(value.sidebarItemGroupId)
        ? { sidebarItemGroupId: value.sidebarItemGroupId }
        : {}),
      message: value.message,
      ...(value.model !== undefined ? { model: value.model } : {}),
      ...(modelConfig !== undefined
        ? {
            modelConfig: {
              ...(modelConfigThinkingLevel !== undefined
                ? { thinkingLevel: modelConfigThinkingLevel }
                : {}),
              ...speed?.fields,
            },
          }
        : {}),
      ...(value.inputMode !== undefined ? { inputMode: value.inputMode } : {}),
      ...(value.providerType !== undefined
        ? { providerType: value.providerType }
        : {}),
      ...(value.thinkingLevel !== undefined
        ? { thinkingLevel: value.thinkingLevel }
        : {}),
    },
  };
}

export async function handlePortalStandaloneChatSetModel(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.standalone_chat.set_model']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (
    !isRecord(command.payload) ||
    typeof command.payload.chatId !== 'string' ||
    command.payload.chatId.length === 0 ||
    typeof command.payload.model !== 'string' ||
    command.payload.model.length === 0
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid standalone chat set-model payload.',
    );
    return;
  }
  // Resolve aliases before the runtime preflight. The service performs the
  // authoritative policy and gateway checks after resolving this command's
  // targeted chat owner; navigation state is not authority for a remote
  // mutation.
  const requestedModel =
    resolveKnownModel(command.payload.model) ?? command.payload.model;
  // Same runtime preflight as the desktop model-change IPC: a Cursor model
  // must not be durably persisted while the managed runtime cannot run it.
  if (
    getProviderForModel(requestedModel) === 'cursor' &&
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
    getProviderForModel(requestedModel) === 'copilot' &&
    !(await isCopilotRuntimeAvailable())
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Connect Copilot in the desktop app to use it here.',
    );
    return;
  }
  if (
    getProviderForModel(requestedModel) === 'opencode' &&
    !(await isOpenCodeRuntimeAvailable())
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Connect OpenCode in the desktop app to use it here.',
    );
    return;
  }
  try {
    const { setStandaloneChatModel } =
      await import('../../services/standalone-chat-service');
    context.complete(
      command,
      await setStandaloneChatModel(command.payload, {
        getWindow: context.getWindow,
      }),
    );
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalStandaloneChatCancel(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.standalone_chat.cancel']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (
    !isRecord(command.payload) ||
    typeof command.payload.chatId !== 'string'
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid standalone chat cancel payload.',
    );
    return;
  }
  try {
    const { cancelStandaloneChat } =
      await import('../../services/standalone-chat-service');
    context.complete(command, await cancelStandaloneChat(command.payload));
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/**
 * Persist a standalone chat's full plugin selections without sending
 * (`portal.standalone_chat.set_plugin_selections`), the standalone equivalent
 * of `portal.chat.set_plugin_selections`. Legacy `bundleIds` are normalized
 * into `collectionIds`; MCP and HTTP auth choices are kept as sent.
 */
export async function handlePortalStandaloneChatSetPluginSelections(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = readStandaloneSelectionsPayload(command.payload);
  if (!payload) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid standalone chat plugin selections payload.',
    );
    return;
  }
  const chat = await resolvePortalChat(command, context, {
    kind: 'standalone',
    ...payload.chat,
  });
  if (!chat) return;
  const result = await commitPortalPluginSelections(
    command,
    context,
    chat,
    normalizePluginSelections(payload.selections),
    undefined,
    payload.deferredToolsAllowed,
  );
  if (result) context.complete(command, result);
}

function readStandaloneSelectionsPayload(value: unknown): {
  chat: { projectLocalId?: string; chatId: string };
  selections: Record<string, unknown>;
  deferredToolsAllowed?: boolean;
} | null {
  if (
    !isRecord(value) ||
    typeof value.chatId !== 'string' ||
    (value.deferredToolsAllowed !== undefined &&
      typeof value.deferredToolsAllowed !== 'boolean') ||
    !isRecord(value.selections)
  ) {
    return null;
  }
  const projectLocalId: unknown = value.projectLocalId ?? value.projectId;
  if (projectLocalId !== undefined && typeof projectLocalId !== 'string') {
    return null;
  }
  try {
    validateId(value.chatId, 'chatId');
    if (projectLocalId !== undefined) {
      validateId(projectLocalId, 'projectLocalId');
    }
  } catch {
    return null;
  }
  return {
    chat: {
      ...(projectLocalId !== undefined ? { projectLocalId } : {}),
      chatId: value.chatId,
    },
    selections: value.selections,
    ...(typeof value.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: value.deferredToolsAllowed }
      : {}),
  };
}

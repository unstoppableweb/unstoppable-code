import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import { isThinkingLevel } from '@canopy/protocol/thinking';
import { isCodexSpeed } from '@canopy/protocol/automations';
import {
  InitiatedWorkQueuedHookOutcomeSchema,
  type CanopyJsonValue,
} from '@canopy/protocol/canopy-core';
import { OperationCancelRefusedError } from '@canopy/core-runtime/node/operations';
import type {
  HookQueueHost,
  HookQueueSavedEntry,
} from '@canopy/core-runtime/node/initiated-work';
import { isModelHarness } from '@canopy/execution-engine/model-harnesses';
import { isApprovalMode } from '@canopy/desktop-shared/lib/approval-engine';
import { isChatInterfaceMode } from '@canopy/desktop-shared/node/preferences/field-normalizers';
import {
  buildShareablePluginDisplay,
  getExecutionHarnessForModel,
  requireProviderForModel,
  IPC_CHANNELS,
  isTerminalBackedInterfaceMode,
  resolveProviderModelConfig,
  type ResolvedAgentModelConfig,
  isInheritingAgentModel,
  resolveKnownModel,
  type AgentProviderType,
  type ApprovalMode,
  type CancelQueuedHookChatResponse,
  type ChatInterfaceMode,
  type ChatModel,
  type ModelHarness,
  type ChatTabPluginSelections,
  type ForceQueuedHookChatResponse,
  type FileReference,
  type ChatHookAction,
  type HookChatTabStartedEvent,
  type PersistedChatMessage,
  type PersistedChatTab,
  type PreferencesData,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  codexSpeedFastMode,
  codexSpeedFromFastMode,
  readCodexSpeedRecord,
  type CodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import type { ShareablePluginRef } from '@canopy/execution-engine/plugin-refs';
import { resolvePipelineModelAlias } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { readPreferencesFile } from '../lib/preferences-store';
import {
  readApprovalPreferencesForSurface,
  resolveApprovalMode,
  surfaceForChat,
} from './approval-mode-resolution';
import { readWorkspaceApprovals } from './approvals-persistence';
import { readWorkspaceApprovalsManifest } from './workspace-approvals-manifest';
import { resolveOptionalLaneAwareDefaultSelection } from '../lib/default-model-lane-resolver';
import {
  assertAgentRouteModel,
  formatInheritedAgentRoute,
} from '../agents/agent-default-model';
import { getEffectiveClaudeChatModePreferences } from './claude-tui-chats';
import { mergePluginSelections } from '../lib/plugin-selection-utils';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { newChatPluginDefaultsStamp } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { sendToWindow } from './window-send';
import { dispatchWorktreeChatTurn } from './worktree-chat-turn';
import { runAdmittedDirectDispatch } from '../services/chat-queue-service';
import { getChatStateService } from '../services/chat-state-service';
import {
  hasActiveChatTurnsForWorktree,
  subscribeChatSessionActivity,
} from '../agents/session-manager';
import {
  loadShareablePluginCatalog,
  resolveShareablePluginRefs,
} from '../plugins/shareable-plugin-resolution';
import {
  commitProviderChatEvent,
  completePersistedChatTabTurn,
  emitChatDispatchFailure,
  removePersistedChatTab,
} from './chat-tab-dispatch-utils';
import { getClaudeTerminalSessionService } from '../integration/claude-terminal-session-service';
import { notifyCanonicalChatStarted } from '../services/active-chat-input';
import { resolveConfiguredPrompt } from './configured-prompt-resolution';
import { buildSubmittedMessageText } from './chat-submitted-message';
import { resolveWorktreeCwd } from './resolve-worktree';

import { validateId } from './validation';
import { getHookChatClaims, getHookQueue } from './hook-initiated-work';
import { revalidateQueuedHookWork } from './hook-recovery';
import { logMainProcessInfo, logMainProcessWarn } from './main-process-logging';
import { registerHookChatPlaceholderReplayer } from './hook-chat-placeholders';

export interface HookChatLaunchIdentity {
  operationId: string;
  actionIndex: number;
}
export interface HookChatIds {
  chatId: string;
  userMessageId: string;
  queueId: string;
  hookInfoMessageId: string;
  unavailablePluginsMessageId: string;
}
export function hookChatIds(identity: HookChatLaunchIdentity): HookChatIds {
  if (!Number.isInteger(identity.actionIndex) || identity.actionIndex < 0)
    throw new Error('Invalid hook chat action index.');
  const suffix = `${identity.operationId}-${identity.actionIndex}`;
  const ids = {
    chatId: `chat-hook-${suffix}`,
    userMessageId: `msg-hook-${suffix}`,
    queueId: `queued-hook-${suffix}`,
    hookInfoMessageId: `msg-hook-${suffix}-info`,
    unavailablePluginsMessageId: `msg-hook-${suffix}-unavailable`,
  };
  validateId(ids.chatId, 'chatId');
  validateId(ids.userMessageId, 'userMessageId');
  return ids;
}
export type HookChatLaunchResult =
  | { status: 'started'; chatId: string }
  | { status: 'queued'; chatId: string; queueId: string }
  | { status: 'already_started'; chatId: string }
  | { status: 'removed'; chatId: string };

type HookChatStartOutcome =
  | 'started'
  | 'already_started'
  | 'removed'
  | 'cancelled';
const startingHookChatIds = new Set<string>();
const hookChatStartInProgressTargetKeys = new Set<string>();
const QUEUED_PROMPT_PREVIEW_MAX_LENGTH = 400;

export interface PreparedHookChatLaunch {
  identity: HookChatLaunchIdentity;
  ids: HookChatIds;
  projectId: string;
  worktreeId: string;
  prompt: string;
  executionContext?: string;
  fileReferences?: FileReference[];
  triggerName: string;
  /**
   * When the hook fired. Shown by the "Chat initiated by … hook" banner on
   * both the queued placeholder and the started chat, so a queued launch does
   * not move the banner's time when it finally starts.
   */
  triggeredAt: number;
  getWindow: () => BrowserWindow | null;
  model: ChatModel;
  providerType: AgentProviderType;
  executionHarness: ModelHarness;
  modelConfig: ResolvedAgentModelConfig;
  /**
   * Requested Codex speed kept independently of the resolved config, so a
   * queued Codex → other provider → Codex model change restores it instead of
   * the provider default. Never an execution input for non-Codex harnesses.
   */
  retainedCodexSpeed?: CodexSpeed;
  thinkingLevel: ThinkingLevel;
  planMode: boolean;
  approvalMode?: ApprovalMode;
  /**
   * Persisted `defaultChatInterfaceMode` preference snapshot applied to the
   * hook-chat tab when the resolved model is Claude. `undefined` for Codex
   * and Ollama models — the managed Claude Code terminal experience is
   * Claude-specific.
   */
  interfaceMode?: ChatInterfaceMode;
  pluginSelections?: ChatTabPluginSelections;
  deferredToolsAllowed?: boolean;
  missingPluginDisplays: string[];
  chatId: string;
  userMessageId: string;
  /**
   * For multi-repo workspaces: the child repo whose checkout should be the
   * agent's cwd. Set when the hook fired on `target: 'workspace-repo'`.
   * Workspace-root and single-repo hooks leave this undefined.
   */
  selectedRepoId?: string;
  /**
   * Mirrors `ChatHookAction.autoArchive`. When `true`, the launched chat tab
   * carries the auto-archive marker so the renderer archives it once its turn
   * finishes.
   */
  autoArchive?: boolean;
}

interface QueuedHookChatEntry {
  queueId: string;
  prepared: PreparedHookChatLaunch;
  cancelled: boolean;
  startExposed: boolean;
  latestModelUpdateSequence: number;
  pendingModelUpdateCount: number;
  startCompletion?: Promise<HookChatStartOutcome>;
  operationId?: string;
  admission: Promise<void>;
  recovering: boolean;
  recoveryOrder?: number;
  revision: number;
  pendingWriteCount: number;
  writeChain: Promise<void>;
  persistFailed: boolean;
  cancelPending: boolean;
  coreCancelPending?: boolean;
  startTransitionFailed?: boolean;
}

const queuedHookChats: QueuedHookChatEntry[] = [];
const recoveringHookChats = new Map<
  string,
  {
    targetKey: string;
    chatId: string;
    operationId: string;
    recoveryOrder: number;
    abort: AbortController;
    cancelled: boolean;
  }
>();
let nextRecoveryOrder = 0;
const startingQueuedHookChats = new Map<string, QueuedHookChatEntry>();

export type QueuedHookChatPayload = Omit<PreparedHookChatLaunch, 'getWindow'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseQueuedHookChatPayload(
  value: unknown,
): QueuedHookChatPayload | null {
  if (
    !isRecord(value) ||
    !isRecord(value.identity) ||
    typeof value.identity.operationId !== 'string' ||
    typeof value.identity.actionIndex !== 'number' ||
    !Number.isInteger(value.identity.actionIndex) ||
    value.identity.actionIndex < 0
  )
    return null;
  try {
    const identity = {
      operationId: value.identity.operationId,
      actionIndex: value.identity.actionIndex,
    };
    const ids = hookChatIds(identity);
    if (
      !isRecord(value.ids) ||
      Object.keys(value.ids).length !== Object.keys(ids).length ||
      Object.entries(ids).some(
        ([key, id]) => !isRecord(value.ids) || value.ids[key] !== id,
      ) ||
      value.chatId !== ids.chatId ||
      value.userMessageId !== ids.userMessageId
    )
      return null;
    validateId(value.projectId, 'projectId');
    validateId(value.worktreeId, 'worktreeId');
    if (
      typeof value.prompt !== 'string' ||
      typeof value.triggerName !== 'string' ||
      typeof value.triggeredAt !== 'number' ||
      !Number.isFinite(value.triggeredAt) ||
      typeof value.model !== 'string'
    )
      return null;
    const model = resolveKnownModel(value.model);
    const providerType = value.providerType;
    if (
      providerType !== 'claude' &&
      providerType !== 'codex' &&
      providerType !== 'ollama' &&
      providerType !== 'cursor' &&
      providerType !== 'opencode' &&
      providerType !== 'copilot'
    )
      return null;
    if (
      (model !== undefined &&
        requireProviderForModel(model) !== providerType) ||
      !isModelHarness(value.executionHarness) ||
      !isRecord(value.modelConfig) ||
      !isThinkingLevel(value.modelConfig.thinkingLevel) ||
      !isCodexSpeed(value.modelConfig.speed) ||
      typeof value.modelConfig.fastMode !== 'boolean' ||
      !isThinkingLevel(value.thinkingLevel) ||
      typeof value.planMode !== 'boolean' ||
      !Array.isArray(value.missingPluginDisplays) ||
      !value.missingPluginDisplays.every(
        (item: unknown) => typeof item === 'string',
      )
    )
      return null;
    if (
      value.retainedCodexSpeed !== undefined &&
      !isCodexSpeed(value.retainedCodexSpeed)
    )
      return null;
    if (value.approvalMode !== undefined && !isApprovalMode(value.approvalMode))
      return null;
    if (
      value.interfaceMode !== undefined &&
      !isChatInterfaceMode(value.interfaceMode)
    )
      return null;
    if (
      value.pluginSelections !== undefined &&
      !isRecord(value.pluginSelections)
    )
      return null;
    if (
      value.deferredToolsAllowed !== undefined &&
      typeof value.deferredToolsAllowed !== 'boolean'
    )
      return null;
    if (
      value.executionContext !== undefined &&
      typeof value.executionContext !== 'string'
    )
      return null;
    if (value.selectedRepoId !== undefined)
      validateId(value.selectedRepoId, 'selectedRepoId');
    if (
      value.autoArchive !== undefined &&
      typeof value.autoArchive !== 'boolean'
    )
      return null;
    let fileReferences: FileReference[] | undefined;
    if (value.fileReferences !== undefined) {
      if (!Array.isArray(value.fileReferences)) return null;
      fileReferences = [];
      const files: unknown[] = value.fileReferences;
      for (const file of files) {
        if (
          !isRecord(file) ||
          typeof file.displayPath !== 'string' ||
          typeof file.absolutePath !== 'string' ||
          (file.repoName !== undefined && typeof file.repoName !== 'string') ||
          (file.kind !== undefined && typeof file.kind !== 'string') ||
          (file.textStart !== undefined &&
            (typeof file.textStart !== 'number' ||
              !Number.isFinite(file.textStart)))
        )
          return null;
        fileReferences.push({
          displayPath: file.displayPath,
          absolutePath: file.absolutePath,
          ...(file.repoName !== undefined ? { repoName: file.repoName } : {}),
          ...(file.kind !== undefined ? { kind: file.kind } : {}),
          ...(file.textStart !== undefined
            ? { textStart: file.textStart }
            : {}),
        });
      }
    }
    return {
      identity,
      ids,
      projectId: value.projectId,
      worktreeId: value.worktreeId,
      prompt: value.prompt,
      triggerName: value.triggerName,
      triggeredAt: value.triggeredAt,
      model: value.model,
      providerType,
      executionHarness: value.executionHarness,
      modelConfig: {
        thinkingLevel: value.modelConfig.thinkingLevel,
        speed: value.modelConfig.speed,
        fastMode: value.modelConfig.fastMode,
      },
      thinkingLevel: value.thinkingLevel,
      planMode: value.planMode,
      missingPluginDisplays: value.missingPluginDisplays,
      chatId: ids.chatId,
      userMessageId: ids.userMessageId,
      ...(value.retainedCodexSpeed !== undefined
        ? { retainedCodexSpeed: value.retainedCodexSpeed }
        : {}),
      ...(value.approvalMode !== undefined
        ? { approvalMode: value.approvalMode }
        : {}),
      ...(value.interfaceMode !== undefined
        ? { interfaceMode: value.interfaceMode }
        : {}),
      ...(value.pluginSelections !== undefined
        ? {
            pluginSelections: normalizePluginSelections(value.pluginSelections),
          }
        : {}),
      ...(value.deferredToolsAllowed !== undefined
        ? { deferredToolsAllowed: value.deferredToolsAllowed }
        : {}),
      ...(fileReferences !== undefined ? { fileReferences } : {}),
      ...(value.executionContext !== undefined
        ? { executionContext: value.executionContext }
        : {}),
      ...(value.selectedRepoId !== undefined
        ? { selectedRepoId: value.selectedRepoId }
        : {}),
      ...(value.autoArchive !== undefined
        ? { autoArchive: value.autoArchive }
        : {}),
    };
  } catch {
    return null;
  }
}

function toQueuedHookChatPayload(
  prepared: PreparedHookChatLaunch,
): CanopyJsonValue {
  const payload: QueuedHookChatPayload = {
    identity: prepared.identity,
    ids: prepared.ids,
    projectId: prepared.projectId,
    worktreeId: prepared.worktreeId,
    prompt: prepared.prompt,
    triggerName: prepared.triggerName,
    triggeredAt: prepared.triggeredAt,
    model: prepared.model,
    providerType: prepared.providerType,
    executionHarness: prepared.executionHarness,
    modelConfig: prepared.modelConfig,
    retainedCodexSpeed: prepared.retainedCodexSpeed,
    thinkingLevel: prepared.thinkingLevel,
    planMode: prepared.planMode,
    approvalMode: prepared.approvalMode,
    interfaceMode: prepared.interfaceMode,
    pluginSelections: prepared.pluginSelections,
    deferredToolsAllowed: prepared.deferredToolsAllowed,
    missingPluginDisplays: prepared.missingPluginDisplays,
    fileReferences: prepared.fileReferences,
    executionContext: prepared.executionContext,
    chatId: prepared.chatId,
    userMessageId: prepared.userMessageId,
    selectedRepoId: prepared.selectedRepoId,
    autoArchive: prepared.autoArchive,
  };
  const serialized: unknown = JSON.parse(JSON.stringify(payload));
  return z.json().parse(serialized);
}

function isQueuedHookChatCancelled(
  entry: QueuedHookChatEntry | undefined,
): boolean {
  return entry?.cancelled === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildInitialTitle(prompt: string): string {
  return prompt.slice(0, 40) + (prompt.length > 40 ? '...' : '');
}

function buildQueuedPromptPreview(prompt: string): string {
  const normalizedPrompt = prompt.trim();
  return (
    normalizedPrompt.slice(0, QUEUED_PROMPT_PREVIEW_MAX_LENGTH) +
    (normalizedPrompt.length > QUEUED_PROMPT_PREVIEW_MAX_LENGTH ? '...' : '')
  );
}

/**
 * The hook chat's own selections. Project defaults are not copied in; the
 * chat inherits them live at each turn.
 */
async function resolveHookChatPluginSelections(
  providerType: AgentProviderType,
  plugins: ShareablePluginRef[] | undefined,
  directSelections: ChatTabPluginSelections | undefined,
): Promise<{
  selections: ChatTabPluginSelections | undefined;
  missingDisplays: string[];
}> {
  const baseSelections = directSelections
    ? mergePluginSelections(
        undefined,
        normalizePluginSelections(directSelections),
      )
    : undefined;
  if (!plugins || plugins.length === 0) {
    return {
      selections: baseSelections,
      missingDisplays: [],
    };
  }

  const catalog = await loadShareablePluginCatalog();
  const matches = resolveShareablePluginRefs(plugins, catalog, {
    providerType,
  });
  const extraSelections: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    mcpHttpAuthPreferences: [],
  };
  const missingDisplays: string[] = [];

  for (const match of matches) {
    if (match.matchState !== 'matched') {
      missingDisplays.push(buildShareablePluginDisplay(match.ref).title);
      continue;
    }
    if (match.selection.kind === 'skill') {
      extraSelections.skillRefs.push({
        sourceId: match.selection.sourceId,
        skillName: match.selection.skillName,
      });
      continue;
    }
    extraSelections.pluginRefs.push({
      marketplaceId: match.selection.marketplaceId,
      pluginName: match.selection.pluginName,
    });
  }

  return {
    selections: mergePluginSelections(baseSelections, extraSelections),
    missingDisplays,
  };
}

function buildInitialMessages(
  ids: HookChatIds,
  prompt: string,
  userMessageId: string,
  triggerName: string,
  triggeredAt: number,
  missingPluginDisplays: string[],
  fileReferences?: FileReference[],
): PersistedChatMessage[] {
  const timestamp = Date.now();
  const unavailableText =
    missingPluginDisplays.length === 1
      ? `Hook plugin unavailable and was not enabled: ${missingPluginDisplays[0]}.`
      : missingPluginDisplays.length > 1
        ? `Some hook plugins were unavailable and were not enabled: ${missingPluginDisplays.join(', ')}.`
        : undefined;
  return [
    {
      id: ids.hookInfoMessageId,
      role: 'system',
      blocks: [{ type: 'hook_info', triggerName, timestamp: triggeredAt }],
      timestamp: triggeredAt,
    },
    ...(unavailableText
      ? [
          {
            id: ids.unavailablePluginsMessageId,
            role: 'system' as const,
            blocks: [{ type: 'text' as const, text: unavailableText }],
            timestamp,
          },
        ]
      : []),
    {
      id: userMessageId,
      role: 'user',
      userMessageSource: 'hook',
      blocks: [
        ...(fileReferences?.length
          ? [{ type: 'file_references' as const, references: fileReferences }]
          : []),
        { type: 'text', text: prompt },
      ],
      timestamp,
    },
  ];
}

function buildHookChatTab(args: {
  ids: HookChatIds;
  projectId: string;
  chatId: string;
  prompt: string;
  executionContext?: string;
  fileReferences?: FileReference[];
  model: ChatModel;
  providerType: AgentProviderType;
  executionHarness: ModelHarness;
  thinkingLevel: ThinkingLevel;
  modelConfig: ResolvedAgentModelConfig;
  planMode: boolean;
  approvalMode?: ApprovalMode;
  interfaceMode?: ChatInterfaceMode;
  pluginSelections?: ChatTabPluginSelections;
  deferredToolsAllowed?: boolean;
  missingPluginDisplays: string[];
  userMessageId: string;
  triggerName: string;
  triggeredAt: number;
  selectedRepoId?: string;
  newChatStartedWatcherFiredAt?: string;
  autoArchive?: boolean;
}): PersistedChatTab {
  return {
    ...(args.executionContext === undefined
      ? {}
      : { executionContext: args.executionContext }),
    id: args.chatId,
    title: buildInitialTitle(args.prompt),
    messages: buildInitialMessages(
      args.ids,
      args.prompt,
      args.userMessageId,
      args.triggerName,
      args.triggeredAt,
      args.missingPluginDisplays,
      args.fileReferences,
    ),
    createdAt: new Date().toISOString(),
    ...(args.newChatStartedWatcherFiredAt
      ? { newChatStartedWatcherFiredAt: args.newChatStartedWatcherFiredAt }
      : {}),
    thinkingLevel: args.thinkingLevel,
    modelConfig: args.modelConfig,
    model: args.model,
    providerType: args.providerType,
    executionHarness: args.executionHarness,
    ...(args.planMode ? { planMode: true } : {}),
    ...(args.approvalMode ? { approvalMode: args.approvalMode } : {}),
    ...(args.interfaceMode ? { interfaceMode: args.interfaceMode } : {}),
    ...(args.pluginSelections
      ? { pluginSelections: args.pluginSelections }
      : {}),
    ...newChatPluginDefaultsStamp(args.projectId),
    ...(typeof args.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: args.deferredToolsAllowed }
      : {}),
    ...(args.selectedRepoId ? { selectedRepoId: args.selectedRepoId } : {}),
    ...(args.autoArchive === true ? { autoArchive: true } : {}),
  };
}

function buildQueuedHookChatTab(
  prepared: PreparedHookChatLaunch,
): PersistedChatTab {
  return {
    ...(prepared.executionContext === undefined
      ? {}
      : { executionContext: prepared.executionContext }),
    id: prepared.chatId,
    title: buildInitialTitle(prepared.prompt),
    messages: [],
    createdAt: new Date().toISOString(),
    thinkingLevel: prepared.thinkingLevel,
    modelConfig: prepared.modelConfig,
    model: prepared.model,
    providerType: prepared.providerType,
    executionHarness: prepared.executionHarness,
    ...(prepared.planMode ? { planMode: true } : {}),
    ...(prepared.approvalMode ? { approvalMode: prepared.approvalMode } : {}),
    ...(prepared.interfaceMode
      ? { interfaceMode: prepared.interfaceMode }
      : {}),
    ...(prepared.pluginSelections
      ? { pluginSelections: prepared.pluginSelections }
      : {}),
    ...newChatPluginDefaultsStamp(prepared.projectId),
    ...(typeof prepared.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: prepared.deferredToolsAllowed }
      : {}),
    ...(prepared.selectedRepoId
      ? { selectedRepoId: prepared.selectedRepoId }
      : {}),
    ...(prepared.autoArchive === true ? { autoArchive: true } : {}),
  };
}

function findQueuedHookChatEntry(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): QueuedHookChatEntry | undefined {
  return queuedHookChats.find(
    (entry) =>
      entry.cancelled !== true &&
      entry.prepared.projectId === args.projectId &&
      entry.prepared.worktreeId === args.worktreeId &&
      entry.prepared.chatId === args.chatId,
  );
}

export function hasQueuedHookChat(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): boolean {
  return findQueuedHookChatEntry(args) !== undefined;
}

function getHookChatTargetKey(prepared: PreparedHookChatLaunch): string {
  return `${prepared.projectId}/${prepared.worktreeId}`;
}

function isHookChatStartInProgressForTarget(
  prepared: PreparedHookChatLaunch,
): boolean {
  return hookChatStartInProgressTargetKeys.has(getHookChatTargetKey(prepared));
}

function hasQueuedHookChatForTarget(prepared: PreparedHookChatLaunch): boolean {
  const targetKey = getHookChatTargetKey(prepared);
  return (
    Array.from(recoveringHookChats.values()).some(
      (entry) => entry.targetKey === targetKey,
    ) ||
    queuedHookChats.some(
      (entry) =>
        entry.cancelled !== true &&
        getHookChatTargetKey(entry.prepared) === targetKey,
    )
  );
}

function resolveWorktreeProviderDefaultThinkingLevel(
  prefs: PreferencesData,
  providerType: AgentProviderType,
  fallback: ThinkingLevel,
): ThinkingLevel {
  const providerDefault = prefs.defaultWorktreeModelByProvider[providerType];
  return providerDefault?.thinkingLevel ?? fallback;
}

/** A non-Codex hook launch still retains the hook's explicit Codex speed. */
function readRetainedHookCodexSpeed(
  action: Pick<ChatHookAction, 'modelConfig' | 'codexFastMode'>,
): { retainedCodexSpeed?: CodexSpeed } {
  const speed = readCodexSpeedRecord(action.modelConfig, action.codexFastMode);
  return speed === undefined ? {} : { retainedCodexSpeed: speed };
}

async function rollbackHookChatTab(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): Promise<void> {
  await removePersistedChatTab(args);
}

async function markHookChatDispatchFailed(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  errorMessage: string;
  getWindow: () => BrowserWindow | null;
}): Promise<void> {
  await completePersistedChatTabTurn(args);
  await emitChatDispatchFailure(args);
}

async function prepareHookChatLaunch(args: {
  identity: HookChatLaunchIdentity;
  projectId: string;
  worktreeId: string;
  action: ChatHookAction;
  prompt: string;
  interpolateText?: (text: string) => string;
  triggerName: string;
  getWindow: () => BrowserWindow | null;
  selectedRepoId?: string;
}): Promise<PreparedHookChatLaunch> {
  const triggeredAt = Date.now();
  const approvalSurface = surfaceForChat(args.projectId);
  const [approvalPreferences, workspaceApprovals, manifestApprovals] =
    await Promise.all([
      readApprovalPreferencesForSurface(approvalSurface),
      readWorkspaceApprovals(args.projectId),
      readWorkspaceApprovalsManifest(args.projectId),
    ]);
  const prefs = approvalPreferences.preferences;
  // Skipped ENTIRELY when the hook names its own model.
  //
  // Deferring only the throw was not enough: lane resolution awaits both native
  // auth probes, the AI Credits lookup, and policy evaluation. On a cold cache
  // the Claude probe alone can take ~20s and the Codex probe can spin up an
  // app-server process — all for a default this hook is never going to use. So
  // the branch happens BEFORE the await, not after it.
  // Hook actions share the pipeline model alias vocabulary ($default-codex,
  // $fast, $cheap) so shareable canopy.json hooks roll model upgrades in one
  // place. Resolve the alias before the known-model lookup; an unknown $-alias
  // throws its own descriptive error here.
  const rawExplicitModel = args.action.model?.trim();
  const explicitModel = rawExplicitModel
    ? resolvePipelineModelAlias(rawExplicitModel)
    : undefined;
  if (explicitModel) assertAgentRouteModel(explicitModel);
  const inheritingAgent =
    explicitModel && isInheritingAgentModel(explicitModel)
      ? explicitModel
      : undefined;
  const worktreeDefault =
    explicitModel && !inheritingAgent
      ? undefined
      : await resolveOptionalLaneAwareDefaultSelection(prefs, 'worktree', {
          // Parity with the spawn: this launch dispatches a worktree chat turn
          // for `args.projectId`, so a Canopy Environments credential assigned to
          // that workspace must be visible to the selection too.
          workspaceId: args.projectId,
        });
  const defaultModel = worktreeDefault?.requireModel().model;
  // The hook chat keeps the route an inheriting Agent resolved here.
  const requestedModel = inheritingAgent
    ? defaultModel && formatInheritedAgentRoute(inheritingAgent, defaultModel)
    : explicitModel || defaultModel;
  if (!requestedModel) {
    throw new Error('No dispatchable model is available (billing-lane).');
  }
  const model = resolveKnownModel(requestedModel);
  if (!model) {
    throw new Error(`Unsupported hook chat model "${requestedModel}"`);
  }

  const providerType = requireProviderForModel(model);
  const executionHarness = getExecutionHarnessForModel(model);
  if (!executionHarness) {
    throw new Error(
      `No execution harness is available for hook chat model "${model}"`,
    );
  }
  const modelConfig = resolveProviderModelConfig(
    executionHarness,
    {
      // Keyed on the NAMED model's provider, never the surface's preferred
      // one. Borrowing the preferred provider's level for a differently-
      // provided model overrides that provider's own configuration; dropping
      // the fallback altogether loses the level the user deliberately set for
      // the same provider (a `low` Claude default silently became `high`).
      thinkingLevel:
        args.action.thinking ??
        worktreeDefault?.selection?.thinkingLevel ??
        prefs.defaultWorktreeModelByProvider[providerType]?.thinkingLevel,
      modelConfig: args.action.modelConfig,
    },
    prefs.providerModelConfigDefaults,
  );
  const thinkingLevel = modelConfig.thinkingLevel;
  const ids = hookChatIds(args.identity);
  const { chatId, userMessageId } = ids;
  const { selections: pluginSelections, missingDisplays } =
    await resolveHookChatPluginSelections(
      executionHarness,
      args.action.plugins,
      args.action.pluginSelections,
    );
  // Hook chats running on Claude inherit the user's persisted default chat
  // interface mode so a hook that fires on a Claude model lands in whichever
  // surface (Canopy transcript or managed Claude Code terminal) the user has
  // chosen for new Claude chats. Codex and Ollama hooks ignore this — the
  // terminal experience is Claude-specific.
  const effectivePrefs = getEffectiveClaudeChatModePreferences(prefs);
  const interfaceMode =
    providerType === 'claude' &&
    effectivePrefs.defaultChatInterfaceMode !== 'canopy'
      ? effectivePrefs.defaultChatInterfaceMode
      : undefined;
  const approvalMode = resolveApprovalMode({
    hookMode: args.action.approvalMode,
    workspaceDefault: workspaceApprovals.defaultMode,
    canopyJsonDefault: manifestApprovals.defaultMode,
    surface: approvalSurface,
    defaults: approvalPreferences.defaults,
  });
  const resolvedPrompt = await resolveConfiguredPrompt({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    providerType,
    executionHarness,
    selectedRepoId: args.selectedRepoId,
    prompt: args.prompt,
    promptReferences: args.action.promptReferences,
    interpolateText: args.interpolateText,
  });

  return {
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    prompt: resolvedPrompt.prompt,
    executionContext: args.action.executionContext ?? 'personal',
    fileReferences: resolvedPrompt.fileReferences,
    triggerName: args.triggerName,
    triggeredAt,
    getWindow: args.getWindow,
    model,
    providerType,
    executionHarness,
    modelConfig,
    ...(executionHarness === 'codex'
      ? { retainedCodexSpeed: modelConfig.speed }
      : readRetainedHookCodexSpeed(args.action)),
    thinkingLevel,
    planMode: args.action.planMode === true,
    approvalMode,
    pluginSelections: resolvedPrompt.referencedPluginSelections
      ? mergePluginSelections(
          pluginSelections,
          resolvedPrompt.referencedPluginSelections,
        )
      : pluginSelections,
    missingPluginDisplays: missingDisplays,
    chatId,
    userMessageId,
    identity: args.identity,
    ids,
    ...(interfaceMode ? { interfaceMode } : {}),
    ...(args.selectedRepoId ? { selectedRepoId: args.selectedRepoId } : {}),
    ...(args.action.autoArchive === true ? { autoArchive: true } : {}),
  };
}

async function startPreparedHookChatWithScopeLease(
  prepared: PreparedHookChatLaunch,
  options: {
    activateTab: boolean;
    queuedEntry?: QueuedHookChatEntry;
  },
): Promise<HookChatStartOutcome> {
  const scope = {
    projectId: prepared.projectId,
    worktreeId: prepared.worktreeId,
  };
  const state = getChatStateService();
  const claims = getHookChatClaims();
  const claimIds = {
    chatId: prepared.chatId,
    userMessageId: prepared.userMessageId,
  };
  const recordClaim = (write: Promise<void>): Promise<void> =>
    write.catch((error: unknown) =>
      logMainProcessWarn(
        '[hook-chat] Could not record the hook chat start claim.',
        error,
      ),
    );
  const newChatStartedAt = new Date().toISOString();
  const tab = buildHookChatTab({
    ids: prepared.ids,
    projectId: prepared.projectId,
    chatId: prepared.chatId,
    prompt: prepared.prompt,
    executionContext: prepared.executionContext,
    fileReferences: prepared.fileReferences,
    model: prepared.model,
    providerType: prepared.providerType,
    executionHarness: prepared.executionHarness,
    modelConfig: prepared.modelConfig,
    thinkingLevel: prepared.thinkingLevel,
    planMode: prepared.planMode,
    approvalMode: prepared.approvalMode,
    ...(prepared.interfaceMode
      ? { interfaceMode: prepared.interfaceMode }
      : {}),
    pluginSelections: prepared.pluginSelections,
    deferredToolsAllowed: prepared.deferredToolsAllowed,
    missingPluginDisplays: prepared.missingPluginDisplays,
    userMessageId: prepared.userMessageId,
    triggerName: prepared.triggerName,
    triggeredAt: prepared.triggeredAt,
    newChatStartedWatcherFiredAt: newChatStartedAt,
    ...(prepared.selectedRepoId
      ? { selectedRepoId: prepared.selectedRepoId }
      : {}),
    ...(prepared.autoArchive === true ? { autoArchive: true } : {}),
  });

  if (isQueuedHookChatCancelled(options.queuedEntry)) return 'cancelled';
  let outcome: HookChatStartOutcome = 'started';

  // Ordinary admission precedes the prompt's first effect (contracts §6).
  await runAdmittedDirectDispatch(
    {
      projectId: prepared.projectId,
      worktreeId: prepared.worktreeId,
      chatId: prepared.chatId,
    },
    prepared.userMessageId,
    async (authorization): Promise<boolean> => {
      const claim = await claims.claim({
        runOperationId: prepared.identity.operationId,
        ...claimIds,
        scope: {
          workspaceId: prepared.projectId,
          worktreeId: prepared.worktreeId,
        },
      });
      if (claim.status === 'already_claimed') {
        outcome = 'already_started';
        return false;
      }
      const claimId = claim.claimOperationId;
      let created;
      try {
        created = await state.createHookChat(scope, tab);
      } catch (error) {
        await recordClaim(claims.recordFailed(claimId, errorMessage(error)));
        throw error;
      }
      if (created === 'removed') {
        await recordClaim(
          claims.recordNotAccepted(claimId, claimIds, 'removed'),
        );
        outcome = 'removed';
        return false;
      }

      if (isQueuedHookChatCancelled(options.queuedEntry)) {
        if (created === 'created')
          await rollbackHookChatTab({
            projectId: prepared.projectId,
            worktreeId: prepared.worktreeId,
            chatId: prepared.chatId,
          });
        await recordClaim(
          claims.recordNotAccepted(claimId, claimIds, 'cancelled'),
        );
        outcome = 'cancelled';
        return false;
      }
      // No await may appear between exposing the canonical chat and marking this flag:
      // cancelQueuedHookChat uses it as the atomic boundary between "still safe to
      // cancel the queued launch" and "the normal active-chat lifecycle owns it".
      if (options.queuedEntry) options.queuedEntry.startExposed = true;

      const startedDelivered = sendToWindow(
        prepared.getWindow(),
        IPC_CHANNELS.chatHookTabStarted,
        {
          projectId: prepared.projectId,
          worktreeId: prepared.worktreeId,
          chatId: prepared.chatId,
          tab,
          activateTab: options.activateTab,
        },
      );
      if (!startedDelivered)
        logMainProcessInfo(
          `[hook-chat] No window received hook chat ${prepared.chatId}; it runs in the background.`,
        );

      if (created === 'created')
        await notifyCanonicalChatStarted(
          prepared,
          prepared.userMessageId,
          newChatStartedAt,
        ).catch(() => undefined);

      let accepted = false;
      try {
        if (
          prepared.providerType === 'claude' &&
          isTerminalBackedInterfaceMode(prepared.interfaceMode)
        ) {
          await getClaudeTerminalSessionService().launch(
            {
              projectId: prepared.projectId,
              worktreeId: prepared.worktreeId,
              chatId: prepared.chatId,
              initialPrompt: buildSubmittedMessageText({
                text: prepared.prompt,
                fileReferences: prepared.fileReferences,
                cwd: resolveWorktreeCwd(
                  prepared.projectId,
                  prepared.worktreeId,
                  prepared.selectedRepoId,
                ),
              }),
              interfaceMode: prepared.interfaceMode,
              cols: 80,
              rows: 24,
              ...(prepared.selectedRepoId
                ? { selectedRepoId: prepared.selectedRepoId }
                : {}),
            },
            {
              getWindow: prepared.getWindow,
              executionContext: prepared.executionContext,
            },
          );
          await recordClaim(claims.recordAccepted(claimId, claimIds));
          return false;
        }

        await dispatchWorktreeChatTurn({
          onTurnAccepted: () => {
            accepted = true;
          },
          ...(authorization ? { authorization } : {}),
          projectId: prepared.projectId,
          worktreeId: prepared.worktreeId,
          chatId: prepared.chatId,
          userMessageId: prepared.userMessageId,
          text: prepared.prompt,
          ...(prepared.executionContext === undefined
            ? {}
            : { executionContext: prepared.executionContext }),
          fileReferences: prepared.fileReferences,
          planMode: prepared.planMode,
          approvalMode: prepared.approvalMode,
          modelConfig: prepared.modelConfig,
          thinkingLevel: prepared.thinkingLevel,
          model: prepared.model,
          providerType: prepared.providerType,
          executionHarness: prepared.executionHarness,
          pluginSelections: prepared.pluginSelections,
          deferredToolsAllowed: prepared.deferredToolsAllowed,
          ...(prepared.selectedRepoId
            ? { selectedRepoId: prepared.selectedRepoId }
            : {}),
          initiationSource: 'hook',
          getWindow: prepared.getWindow,
          skipBranchNaming: true,
          onBeforeChatEvent: (event) =>
            commitProviderChatEvent({
              projectId: prepared.projectId,
              worktreeId: prepared.worktreeId,
              chatId: prepared.chatId,
              userMessageId: prepared.userMessageId,
              providerType: prepared.providerType,
              event,
            }),
        });
        await recordClaim(
          accepted
            ? claims.recordAccepted(claimId, claimIds)
            : claims.recordNotAccepted(claimId, claimIds, 'returned'),
        );
      } catch (error) {
        const message = errorMessage(error);
        await recordClaim(
          accepted
            ? claims.recordAccepted(claimId, claimIds)
            : claims.recordFailed(claimId, message),
        );
        await markHookChatDispatchFailed({
          projectId: prepared.projectId,
          worktreeId: prepared.worktreeId,
          chatId: prepared.chatId,
          errorMessage: message,
          getWindow: prepared.getWindow,
        });
        throw error;
      }
      return true;
    },
  );
  return outcome;
}

async function startPreparedHookChat(
  prepared: PreparedHookChatLaunch,
  options: {
    activateTab: boolean;
    queuedEntry?: QueuedHookChatEntry;
  },
): Promise<HookChatStartOutcome> {
  return getChatStateService().runWithScopeActivity(
    {
      projectId: prepared.projectId,
      worktreeId: prepared.worktreeId,
    },
    () => startPreparedHookChatWithScopeLease(prepared, options),
  );
}

function queuedPlaceholderEvent(
  prepared: PreparedHookChatLaunch,
  queueId: string,
): HookChatTabStartedEvent {
  return {
    projectId: prepared.projectId,
    worktreeId: prepared.worktreeId,
    chatId: prepared.chatId,
    tab: buildQueuedHookChatTab(prepared),
    activateTab: false,
    queuedMessage: {
      queueId,
      text: buildQueuedPromptPreview(prepared.prompt),
      reason: 'Waiting for active chat sessions to finish.',
      hookInfo: {
        triggerName: prepared.triggerName,
        timestamp: prepared.triggeredAt,
      },
    },
  };
}

class HookQueueEntryExistsError extends Error {}

async function queuePreparedHookChat(
  prepared: PreparedHookChatLaunch,
): Promise<string> {
  const queueId = prepared.ids.queueId;
  const entry: QueuedHookChatEntry = {
    queueId,
    prepared,
    cancelled: false,
    startExposed: false,
    latestModelUpdateSequence: 0,
    pendingModelUpdateCount: 0,
    admission: Promise.resolve(),
    recovering: false,
    revision: 1,
    pendingWriteCount: 0,
    writeChain: Promise.resolve(),
    persistFailed: false,
    cancelPending: false,
  };
  queuedHookChats.push(entry);
  entry.admission = (async (): Promise<void> => {
    const admitted = await getHookQueue().enqueue({
      kind: 'chat',
      queueId,
      runOperationId: prepared.identity.operationId,
      actionIndex: prepared.identity.actionIndex,
      scope: {
        workspaceId: prepared.projectId,
        worktreeId: prepared.worktreeId,
        chatId: prepared.chatId,
      },
      payload: toQueuedHookChatPayload(prepared),
    });
    if (admitted.status === 'existing') throw new HookQueueEntryExistsError();
    entry.operationId = admitted.operationId;
  })();
  try {
    await entry.admission;
  } catch (error) {
    removeQueuedHookChat(entry);
    scheduleDrain();
    if (error instanceof HookQueueEntryExistsError) return queueId;
    throw error;
  }
  if (entry.cancelled) {
    await finishQueue(entry, 'cancelled');
    return queueId;
  }
  const startedDelivered = sendToWindow(
    prepared.getWindow(),
    IPC_CHANNELS.chatHookTabStarted,
    queuedPlaceholderEvent(prepared, queueId),
  );
  if (!startedDelivered)
    logMainProcessInfo(
      `[hook-chat] No window received hook chat ${prepared.chatId}; it is queued in the background.`,
    );
  scheduleDrain();
  return queueId;
}

function removeQueuedHookChat(entry: QueuedHookChatEntry): void {
  const index = queuedHookChats.indexOf(entry);
  if (index >= 0) queuedHookChats.splice(index, 1);
}

function savedQueuedHookChat(
  entry: QueuedHookChatEntry,
  revision = entry.revision,
): HookQueueSavedEntry {
  return {
    version: 1,
    kind: 'chat',
    queueId: entry.queueId,
    runOperationId: entry.prepared.identity.operationId,
    actionIndex: entry.prepared.identity.actionIndex,
    revision,
    savedAt: new Date().toISOString(),
    payload: toQueuedHookChatPayload(entry.prepared),
  };
}

function persistQueuedHookChat(entry: QueuedHookChatEntry): void {
  entry.pendingWriteCount += 1;
  entry.revision += 1;
  const revision = entry.revision;
  entry.writeChain = entry.writeChain
    .then(async () => {
      if (!entry.operationId) await entry.admission.catch(() => undefined);
      await getHookQueue().saveEdit(savedQueuedHookChat(entry, revision));
      entry.persistFailed = false;
    })
    .catch((error: unknown) => {
      entry.persistFailed = true;
      logMainProcessWarn(
        '[hook-chat] Could not save a queued hook chat edit.',
        error,
      );
    })
    .finally(() => {
      entry.pendingWriteCount -= 1;
      scheduleDrain();
    });
}

async function persistNow(entry: QueuedHookChatEntry): Promise<void> {
  try {
    await getHookQueue().saveEdit(savedQueuedHookChat(entry));
    entry.persistFailed = false;
  } catch (error) {
    logMainProcessWarn(
      '[hook-chat] Could not save a queued hook chat edit.',
      error,
    );
  }
}

async function finishQueue(
  entry: QueuedHookChatEntry,
  outcome: unknown,
): Promise<void> {
  if (!entry.operationId) return;
  try {
    if (
      outcome === 'started' ||
      outcome === 'already_started' ||
      outcome === 'removed'
    )
      await getHookQueue().finishStarted(entry.operationId, entry.queueId, {
        kind: 'chat',
        chatId: entry.prepared.chatId,
        result: outcome,
      });
    else if (outcome === 'cancelled')
      await getHookQueue().finishCancelled(entry.operationId, entry.queueId);
    else
      await getHookQueue().finishFailed(
        entry.operationId,
        entry.queueId,
        'core.initiatedWork.hookQueue.startFailed',
        'The queued hook chat could not start.',
      );
  } catch (error) {
    logMainProcessWarn(
      '[hook-chat] Could not record how a queued hook chat ended.',
      error,
    );
    if (outcome === 'cancelled') throw error;
  }
}

async function startQueuedHookChat(
  entry: QueuedHookChatEntry,
): Promise<HookChatStartOutcome> {
  if (!entry.operationId) return 'cancelled';
  if (entry.persistFailed) await persistNow(entry);
  entry.startTransitionFailed = false;
  try {
    if ((await getHookQueue().markStarting(entry.operationId)) === 'ended')
      return 'cancelled';
  } catch (error) {
    if (!entry.cancelled) {
      entry.startTransitionFailed = true;
      queuedHookChats.unshift(entry);
    }
    throw error;
  }
  let outcome: HookChatStartOutcome;
  try {
    outcome = await startPreparedHookChat(entry.prepared, {
      activateTab: false,
      queuedEntry: entry,
    });
  } catch (error) {
    await finishQueue(entry, error);
    throw error;
  }
  await finishQueue(entry, outcome);
  return outcome;
}

function scheduleDrain(): void {
  while (queuedHookChats[0]?.cancelled === true) {
    queuedHookChats.shift();
  }

  const blockedTargetKeys = new Set(
    Array.from(recoveringHookChats.values(), (entry) => entry.targetKey),
  );
  let nextEntry: QueuedHookChatEntry | undefined;
  let nextEntryIndex = -1;
  for (let index = 0; index < queuedHookChats.length; index += 1) {
    const entry = queuedHookChats[index];
    if (!entry || entry.cancelled === true) {
      continue;
    }

    const targetKey = getHookChatTargetKey(entry.prepared);
    if (blockedTargetKeys.has(targetKey)) {
      continue;
    }

    if (
      hookChatStartInProgressTargetKeys.has(targetKey) ||
      entry.operationId === undefined ||
      entry.recovering ||
      entry.cancelPending ||
      entry.coreCancelPending ||
      entry.startTransitionFailed ||
      entry.pendingWriteCount > 0 ||
      entry.pendingModelUpdateCount > 0 ||
      hasActiveChatTurnsForWorktree(
        entry.prepared.projectId,
        entry.prepared.worktreeId,
      )
    ) {
      blockedTargetKeys.add(targetKey);
      continue;
    }

    nextEntry = entry;
    nextEntryIndex = index;
    break;
  }

  if (!nextEntry || nextEntryIndex < 0) {
    return;
  }

  queuedHookChats.splice(nextEntryIndex, 1);

  hookChatStartInProgressTargetKeys.add(
    getHookChatTargetKey(nextEntry.prepared),
  );
  startingQueuedHookChats.set(nextEntry.queueId, nextEntry);
  const start = startQueuedHookChat(nextEntry);
  nextEntry.startCompletion = start;
  void start
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[hook-chat] Failed to start queued hook chat:', error);
    })
    .finally(() => {
      // A cancelled start can fail while removing its persisted tab. Keep the
      // entry until cancellation confirms cleanup so the close can be retried.
      if (!nextEntry.cancelled) {
        startingQueuedHookChats.delete(nextEntry.queueId);
      }
      hookChatStartInProgressTargetKeys.delete(
        getHookChatTargetKey(nextEntry.prepared),
      );
      scheduleDrain();
    });
}

subscribeChatSessionActivity(() => {
  for (const entry of queuedHookChats) entry.startTransitionFailed = false;
  scheduleDrain();
});

function replayQueuedHookChatPlaceholders(window: BrowserWindow | null): void {
  for (const entry of queuedHookChats) {
    if (entry.cancelled || entry.operationId === undefined) continue;
    const replayed = sendToWindow(
      window,
      IPC_CHANNELS.chatHookTabStarted,
      queuedPlaceholderEvent(entry.prepared, entry.queueId),
    );
    if (!replayed) return;
  }
}
registerHookChatPlaceholderReplayer(replayQueuedHookChatPlaceholders);

export async function cancelQueuedHookChat(
  queueId: string,
): Promise<CancelQueuedHookChatResponse> {
  const entryIndex = queuedHookChats.findIndex(
    (entry) => entry.queueId === queueId,
  );
  if (entryIndex < 0) {
    const recovering = recoveringHookChats.get(queueId);
    if (recovering) {
      recovering.cancelled = true;
      recovering.abort.abort();
      await getHookQueue().finishCancelled(recovering.operationId, queueId);
      recoveringHookChats.delete(queueId);
      scheduleDrain();
      return { cancelled: true };
    }
    const startingEntry = startingQueuedHookChats.get(queueId);
    if (!startingEntry || startingEntry.startExposed) {
      return { cancelled: false };
    }
    startingEntry.cancelled = true;
    // A queued start may already have written its real tab. Acknowledge the
    // close only after that start observes cancellation and removes the tab;
    // otherwise a late canonical upsert can restore the closed tab.
    try {
      await startingEntry.startCompletion;
    } catch {
      // The start may fail after writing its tab, or while rolling that tab
      // back. Removal is idempotent and must finish before close is confirmed.
      // If removal also fails, retain the entry so another close can retry.
      await rollbackHookChatTab({
        projectId: startingEntry.prepared.projectId,
        worktreeId: startingEntry.prepared.worktreeId,
        chatId: startingEntry.prepared.chatId,
      });
    }
    if (startingEntry.operationId)
      await getHookQueue().finishCancelled(startingEntry.operationId, queueId);
    startingQueuedHookChats.delete(queueId);
    return { cancelled: true };
  }

  const entry = queuedHookChats[entryIndex];
  if (!entry) {
    return { cancelled: false };
  }

  if (entry.cancelPending) return { cancelled: false };
  entry.cancelPending = true;
  try {
    await entry.admission.catch(() => undefined);
    if (entry.operationId)
      await getHookQueue().finishCancelled(entry.operationId, entry.queueId);
  } catch (error) {
    entry.cancelPending = false;
    scheduleDrain();
    throw error;
  }
  entry.cancelled = true;
  removeQueuedHookChat(entry);
  scheduleDrain();
  return { cancelled: true };
}

export async function forceQueuedHookChat(
  queueId: string,
): Promise<ForceQueuedHookChatResponse> {
  const entryIndex = queuedHookChats.findIndex(
    (entry) => entry.queueId === queueId,
  );
  if (entryIndex < 0) {
    return { forced: false };
  }

  const entry = queuedHookChats[entryIndex];
  if (
    !entry ||
    entry.cancelled === true ||
    !entry.operationId ||
    entry.recovering ||
    entry.cancelPending ||
    entry.coreCancelPending
  ) {
    return { forced: false };
  }

  const targetKey = getHookChatTargetKey(entry.prepared);
  if (hookChatStartInProgressTargetKeys.has(targetKey)) {
    return { forced: false };
  }

  queuedHookChats.splice(entryIndex, 1);
  hookChatStartInProgressTargetKeys.add(targetKey);
  startingQueuedHookChats.set(entry.queueId, entry);
  try {
    const start = startQueuedHookChat(entry);
    entry.startCompletion = start;
    await start;
    return { forced: entry.startExposed };
  } finally {
    if (!entry.cancelled) {
      startingQueuedHookChats.delete(entry.queueId);
    }
    hookChatStartInProgressTargetKeys.delete(targetKey);
    scheduleDrain();
  }
}

export function updateQueuedHookChatPlanMode(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  enabled: boolean;
}): void {
  const entry = findQueuedHookChatEntry(args);
  if (!entry) {
    return;
  }

  entry.prepared.planMode = args.enabled;
  persistQueuedHookChat(entry);
}

export function updateQueuedHookChatApprovalMode(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  mode: ApprovalMode;
}): void {
  const entry = findQueuedHookChatEntry(args);
  if (!entry) {
    return;
  }

  entry.prepared.approvalMode = args.mode;
  persistQueuedHookChat(entry);
}

export function updateQueuedHookChatThinkingLevel(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  level: ThinkingLevel;
}): void {
  const entry = findQueuedHookChatEntry(args);
  if (!entry) {
    return;
  }

  entry.prepared.thinkingLevel = args.level;
  entry.prepared.modelConfig = {
    ...entry.prepared.modelConfig,
    thinkingLevel: args.level,
  };
  persistQueuedHookChat(entry);
}

/**
 * Applies an interface-mode switch made on a queued hook chat's placeholder.
 * The queued launch decides between the managed Claude Code terminal and a
 * Canopy turn when it starts, and the started tab carries the same mode.
 */
export function updateQueuedHookChatInterfaceMode(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  interfaceMode: ChatInterfaceMode;
}): boolean {
  const entry = findQueuedHookChatEntry(args);
  if (!entry || entry.prepared.providerType !== 'claude') {
    return false;
  }

  entry.prepared.interfaceMode =
    args.interfaceMode === 'canopy' ? undefined : args.interfaceMode;
  persistQueuedHookChat(entry);
  return true;
}

/**
 * Applies a speed command made on a queued hook chat's placeholder. An exact
 * `speed` is authoritative; otherwise the legacy boolean command replaces the
 * speed (true → Fast, false → Regular, including `false` on Ultra fast).
 */
export function updateQueuedHookChatCodexFastMode(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  enabled: boolean;
  speed?: CodexSpeed;
}): void {
  const entry = findQueuedHookChatEntry(args);
  if (!entry) {
    return;
  }

  const speed = args.speed ?? codexSpeedFromFastMode(args.enabled);
  entry.prepared.retainedCodexSpeed = speed;
  if (entry.prepared.executionHarness !== 'codex') {
    // Non-Codex execution never requests a Codex speed; keep only the
    // retained request for a later switch back to Codex.
    persistQueuedHookChat(entry);
    return;
  }
  entry.prepared.modelConfig = {
    ...entry.prepared.modelConfig,
    speed,
    fastMode: codexSpeedFastMode(speed),
  };
  persistQueuedHookChat(entry);
}

export async function updateQueuedHookChatModel(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  model: ChatModel;
}): Promise<void> {
  const queuedEntry = findQueuedHookChatEntry(args);
  if (!queuedEntry) {
    return;
  }

  queuedEntry.pendingModelUpdateCount += 1;
  try {
    const requestSequence = queuedEntry.latestModelUpdateSequence + 1;
    queuedEntry.latestModelUpdateSequence = requestSequence;
    const nextProviderType = requireProviderForModel(args.model);
    const nextExecutionHarness = getExecutionHarnessForModel(args.model);
    if (!nextExecutionHarness) {
      throw new Error(
        `No execution harness is available for hook chat model "${args.model}"`,
      );
    }
    const harnessChanged =
      queuedEntry.prepared.executionHarness !== nextExecutionHarness;
    const prefs = await readPreferencesFile();
    const nextThinkingLevelBase = harnessChanged
      ? resolveWorktreeProviderDefaultThinkingLevel(
          prefs,
          nextExecutionHarness,
          queuedEntry.prepared.thinkingLevel,
        )
      : queuedEntry.prepared.thinkingLevel;
    // The retained request (not a non-Codex resolved `standard`) is the
    // speed source, so Codex → other provider → Codex keeps the user's
    // choice and a queued launch never silently changes speed.
    const retainedSpeed = queuedEntry.prepared.retainedCodexSpeed;
    const nextModelConfig = resolveProviderModelConfig(
      nextExecutionHarness,
      {
        thinkingLevel: nextThinkingLevelBase,
        modelConfig: {
          thinkingLevel: nextThinkingLevelBase,
          ...(retainedSpeed === undefined
            ? {}
            : {
                speed: retainedSpeed,
                fastMode: codexSpeedFastMode(retainedSpeed),
              }),
        },
      },
      prefs.providerModelConfigDefaults,
    );
    const currentEntry = findQueuedHookChatEntry(args);
    if (!currentEntry) {
      return;
    }
    if (currentEntry.latestModelUpdateSequence !== requestSequence) {
      return;
    }

    currentEntry.prepared.model = args.model;
    currentEntry.prepared.providerType = nextProviderType;
    currentEntry.prepared.executionHarness = nextExecutionHarness;
    currentEntry.prepared.modelConfig = nextModelConfig;
    currentEntry.prepared.thinkingLevel = nextModelConfig.thinkingLevel;
    if (nextExecutionHarness === 'codex') {
      currentEntry.prepared.retainedCodexSpeed = nextModelConfig.speed;
    }
    persistQueuedHookChat(currentEntry);
  } finally {
    if (queuedEntry.pendingModelUpdateCount > 0) {
      queuedEntry.pendingModelUpdateCount -= 1;
    }
    scheduleDrain();
  }
}

export function updateQueuedHookChatPluginSelections(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  pluginSelections?: ChatTabPluginSelections;
  deferredToolsAllowed?: boolean;
}): void {
  const entry = findQueuedHookChatEntry(args);
  if (!entry) {
    return;
  }

  entry.prepared.pluginSelections = args.pluginSelections;
  if (typeof args.deferredToolsAllowed === 'boolean') {
    entry.prepared.deferredToolsAllowed = args.deferredToolsAllowed;
  }
  persistQueuedHookChat(entry);
}

type LaunchHookChatArgs = {
  identity: HookChatLaunchIdentity;
  projectId: string;
  worktreeId: string;
  action: ChatHookAction;
  prompt: string;
  interpolateText?: (text: string) => string;
  triggerName: string;
  getWindow: () => BrowserWindow | null;
  /**
   * For multi-repo workspaces: the child repo whose checkout should be the
   * agent's working directory. Set when the hook fired on a child repo
   * (`HookDescriptor.target === 'workspace-repo'`); leave undefined for
   * workspace-root and single-repo hooks.
   */
  selectedRepoId?: string;
};

function toLaunchResult(
  outcome: HookChatStartOutcome,
  chatId: string,
): HookChatLaunchResult {
  return { status: outcome === 'cancelled' ? 'removed' : outcome, chatId };
}

function inFlightHookChatLaunch(
  chatId: string,
): HookChatLaunchResult | undefined {
  for (const [queueId, entry] of recoveringHookChats)
    if (entry.chatId === chatId) return { status: 'queued', chatId, queueId };
  const queued = queuedHookChats.find(
    (entry) => !entry.cancelled && entry.prepared.chatId === chatId,
  );
  if (queued)
    return { status: 'queued', chatId: chatId, queueId: queued.queueId };
  if (
    startingHookChatIds.has(chatId) ||
    Array.from(startingQueuedHookChats.values()).some(
      (entry) => entry.prepared.chatId === chatId,
    )
  )
    return { status: 'already_started', chatId: chatId };
  return undefined;
}

async function recordedQueueLaunch(
  identity: HookChatLaunchIdentity,
  ids: HookChatIds,
): Promise<HookChatLaunchResult | undefined> {
  const recorded = await getHookQueue().lookup(
    'chat',
    ids.queueId,
    identity.operationId,
    identity.actionIndex,
  );
  if (recorded.status === 'none') return undefined;
  if (recorded.status === 'waiting')
    return { status: 'queued', chatId: ids.chatId, queueId: ids.queueId };
  const outcome = InitiatedWorkQueuedHookOutcomeSchema.safeParse(
    recorded.operation.outcome,
  );
  if (
    recorded.operation.status === 'completed' &&
    outcome.success &&
    outcome.data.kind === 'chat' &&
    (outcome.data.result === 'started' ||
      outcome.data.result === 'already_started')
  )
    return { status: 'already_started', chatId: ids.chatId };
  return { status: 'removed', chatId: ids.chatId };
}

async function launchHookChatWithScopeLease(
  args: LaunchHookChatArgs,
): Promise<HookChatLaunchResult> {
  const ids = hookChatIds(args.identity);
  const inFlight = inFlightHookChatLaunch(ids.chatId);
  if (inFlight) return inFlight;
  const queued = await recordedQueueLaunch(args.identity, ids);
  if (queued) return queued;
  const prepared = await prepareHookChatLaunch(args);
  const recorded = await getHookChatClaims().lookup({
    runOperationId: args.identity.operationId,
    chatId: ids.chatId,
    userMessageId: ids.userMessageId,
    scope: { workspaceId: args.projectId, worktreeId: args.worktreeId },
  });
  const preparedQueued = await recordedQueueLaunch(args.identity, ids);
  if (preparedQueued) return preparedQueued;
  const preparedInFlight = inFlightHookChatLaunch(ids.chatId);
  if (preparedInFlight) return preparedInFlight;
  if (recorded) return { status: 'already_started', chatId: ids.chatId };
  if (args.action.allowChatConcurrency === true) {
    startingHookChatIds.add(ids.chatId);
    try {
      return toLaunchResult(
        await startPreparedHookChat(prepared, { activateTab: false }),
        ids.chatId,
      );
    } finally {
      startingHookChatIds.delete(ids.chatId);
    }
  }
  if (
    isHookChatStartInProgressForTarget(prepared) ||
    hasActiveChatTurnsForWorktree(prepared.projectId, prepared.worktreeId) ||
    hasQueuedHookChatForTarget(prepared)
  )
    return {
      status: 'queued',
      chatId: ids.chatId,
      queueId: await queuePreparedHookChat(prepared),
    };
  hookChatStartInProgressTargetKeys.add(getHookChatTargetKey(prepared));
  startingHookChatIds.add(ids.chatId);
  try {
    return toLaunchResult(
      await startPreparedHookChat(prepared, { activateTab: false }),
      ids.chatId,
    );
  } finally {
    startingHookChatIds.delete(ids.chatId);
    hookChatStartInProgressTargetKeys.delete(getHookChatTargetKey(prepared));
    scheduleDrain();
  }
}

const pendingHookChatLaunches = new Map<
  string,
  Promise<HookChatLaunchResult>
>();

export async function launchHookChat(
  args: LaunchHookChatArgs,
): Promise<HookChatLaunchResult> {
  const { chatId } = hookChatIds(args.identity);
  const pending = pendingHookChatLaunches.get(chatId);
  if (pending) {
    const inFlight = inFlightHookChatLaunch(chatId);
    if (inFlight?.status === 'already_started') return inFlight;
    const result = await pending;
    return result.status === 'started'
      ? { status: 'already_started', chatId }
      : result;
  }
  const launch = getChatStateService().runWithScopeActivity(
    { projectId: args.projectId, worktreeId: args.worktreeId },
    () => launchHookChatWithScopeLease(args),
  );
  pendingHookChatLaunches.set(chatId, launch);
  try {
    return await launch;
  } finally {
    pendingHookChatLaunches.delete(chatId);
  }
}

let hookChatQueueHostRegistered = false;

export function registerHookChatQueueHost(
  getWindow: () => BrowserWindow | null,
): void {
  if (hookChatQueueHostRegistered) return;
  hookChatQueueHostRegistered = true;
  const host: HookQueueHost = {
    reserve(ref): void {
      const { workspaceId, worktreeId, chatId } = ref.operation.scope;
      if (!workspaceId || !worktreeId || !chatId)
        throw new Error('The queued hook chat names no worktree or chat.');
      recoveringHookChats.set(ref.queueId, {
        targetKey: `${workspaceId}/${worktreeId}`,
        chatId,
        operationId: ref.operationId,
        recoveryOrder: nextRecoveryOrder++,
        abort: new AbortController(),
        cancelled: false,
      });
    },
    release(ref): void {
      recoveringHookChats.delete(ref.queueId);
      scheduleDrain();
    },
    async resume(ref, saved, released) {
      const reservation = recoveringHookChats.get(ref.queueId);
      if (!reservation || reservation.cancelled)
        return {
          status: 'invalidated',
          message: 'This queued hook chat was cancelled.',
        };
      const payload = parseQueuedHookChatPayload(saved.payload);
      if (!payload)
        return {
          status: 'invalidated',
          message:
            "This queued hook work's saved details could not be read, so it was not run.",
        };
      const valid = await revalidateQueuedHookWork(
        ref.operation,
        saved.actionIndex,
        'chat',
        reservation.abort.signal,
      );
      if (valid.status === 'invalidated') return valid;
      if (
        reservation.cancelled ||
        reservation.abort.signal.aborted ||
        !recoveringHookChats.has(ref.queueId)
      )
        return {
          status: 'invalidated',
          message: 'This queued hook chat was cancelled.',
        };
      if (!resolveKnownModel(payload.model))
        return {
          status: 'model_unavailable',
        };
      const entry: QueuedHookChatEntry = {
        queueId: ref.queueId,
        prepared: { ...payload, getWindow },
        operationId: ref.operationId,
        admission: Promise.resolve(),
        recovering: true,
        recoveryOrder: reservation.recoveryOrder,
        revision: saved.revision,
        cancelled: false,
        startExposed: false,
        latestModelUpdateSequence: 0,
        pendingModelUpdateCount: 0,
        pendingWriteCount: 0,
        writeChain: Promise.resolve(),
        persistFailed: false,
        cancelPending: false,
      };
      const index = queuedHookChats.findIndex(
        (candidate) =>
          candidate.recoveryOrder === undefined ||
          candidate.recoveryOrder > reservation.recoveryOrder,
      );
      queuedHookChats.splice(
        index < 0 ? queuedHookChats.length : index,
        0,
        entry,
      );
      recoveringHookChats.delete(ref.queueId);
      void released.then(() => {
        entry.recovering = false;
        scheduleDrain();
      });
      replayQueuedHookChatPlaceholders(getWindow());
      return { status: 'queued' };
    },
    async reconcile(_ref, saved) {
      const payload = parseQueuedHookChatPayload(saved.payload);
      if (!payload) return { status: 'lost' };
      try {
        const claim = await getHookChatClaims().lookup({
          runOperationId: payload.identity.operationId,
          chatId: payload.chatId,
          userMessageId: payload.userMessageId,
          scope: {
            workspaceId: payload.projectId,
            worktreeId: payload.worktreeId,
          },
        });
        return claim
          ? {
              status: 'started',
              outcome: {
                kind: 'chat',
                chatId: payload.chatId,
                result: 'started',
              },
            }
          : { status: 'not_started' };
      } catch {
        return { status: 'lost' };
      }
    },
    cancelled(ref): void {
      const waiting = queuedHookChats.find(
        (entry) => entry.queueId === ref.queueId,
      );
      if (waiting) {
        waiting.cancelled = true;
        removeQueuedHookChat(waiting);
      }
      recoveringHookChats.delete(ref.queueId);
      scheduleDrain();
      const { workspaceId, worktreeId, chatId } = ref.operation.scope;
      if (!workspaceId || !worktreeId || !chatId) return;
      sendToWindow(getWindow(), IPC_CHANNELS.chatHookQueueRemoved, {
        projectId: workspaceId,
        worktreeId,
        chatId,
        queueId: ref.queueId,
      });
    },
    async cancel(ref): Promise<void> {
      const reservation = recoveringHookChats.get(ref.queueId);
      if (reservation) {
        reservation.cancelled = true;
        reservation.abort.abort();
        recoveringHookChats.delete(ref.queueId);
        scheduleDrain();
        return;
      }
      const waiting = queuedHookChats.find(
        (entry) => entry.queueId === ref.queueId,
      );
      if (waiting) {
        waiting.coreCancelPending = true;
        return;
      }
      const starting = startingQueuedHookChats.get(ref.queueId);
      if (starting?.startExposed)
        throw new OperationCancelRefusedError(
          'This hook chat already started; stop it from the chat.',
        );
      if (starting) await cancelQueuedHookChat(ref.queueId);
    },
  };
  getHookQueue().registerHost('chat', host);
}

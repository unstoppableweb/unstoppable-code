/**
 * Shell commands (CAN-5985) over desktop IPC: the chat, standalone chat and
 * editor operations the web shell used to reach only through Portal
 * commands. Each maps onto the channels the desktop renderer, mobile and
 * Portal's own executor use: the revisioned `chat:command` envelope for chat
 * changes, `chat:cancel` for stops, `work-entries:create` for a new
 * standalone chat, and file roots plus the file index for `@` mentions.
 *
 * Receipts keep the Portal reply shape shell code reads. A definite refusal
 * from the computer resolves `{ ok: false, error }`; anything that may have
 * run without a reply rejects, and nothing is retried here.
 *
 * The Orchestrator commands are in `./orchestrator`. Composer menus and the
 * plugin catalog use read-only host operations; pipeline reads use the
 * worktree-scoped pipeline channels; activity actions use their desktop
 * channels, and a hook pause is one host operation that applies the change to
 * the latest worktree row.
 */
import type {
  CommandMap,
  QueryMap,
  ShellCommandName,
  ShellCommandReceipt,
  ShellCommandTarget,
  ShellQueryName,
} from '@canopy/app-core';
import type {
  PortalAgentModelConfig,
  PortalChatCloudAttachmentRef,
  PortalChatFileReference,
  PortalChatSendPayload,
  PortalEditorFileMentionOption,
} from '@canopy/protocol/portal';
import { REMOTE_IPC_CHANNELS as C } from '@canopy/protocol/remote-control/channels';
import { isThinkingLevel } from '@canopy/protocol/thinking';
import {
  UnsupportedOperationError,
  type ChannelClient,
} from './channel-client';
import { isRecord, recordWith, recordWithArray, reply } from './decoders';
import {
  createOrchestratorHandlers,
  type OrchestratorHandlers,
} from './orchestrator';
import { joinRootPath } from './projections';
import type {
  WireChatCancelResult,
  WireChatCommandResult,
  WireChatState,
  WireCreatedWorkEntry,
  WireFileIndex,
  WireFileTreeRoot,
  WireFileTreeRoots,
  WireIpcResult,
  WireModelRegistry,
  WireHookPauseResult,
  WireScriptRunLog,
  WireResolvedInvocable,
  WireWatcherDeleteResult,
} from './wire';

export type ShellQueryHandlers = {
  [K in ShellQueryName]: (
    args: QueryMap[K]['args'],
  ) => Promise<QueryMap[K]['result']>;
};
export type ShellCommandHandlers = {
  [K in ShellCommandName]: (
    args: CommandMap[K]['args'],
  ) => Promise<CommandMap[K]['result']>;
};

export interface ShellCommandDeps {
  readonly channels: ChannelClient;
  /** The controller's App Advisor surface, for Orchestrator questions. */
  readonly appAdvisorSurface: ChannelClient | null;
  readonly randomId: () => string;
  readonly now: () => string;
  /**
   * Stores a composer attachment on the computer (`upload.put`) and returns
   * its path there. Absent: attachments are refused.
   */
  readonly uploadFile?: (
    fileName: string,
    bytes: Uint8Array,
  ) => Promise<string>;
  /**
   * A change to a worktree's panel rows this client made that the computer
   * does not announce (a log read, a hook pause): rows are read again.
   */
  readonly activityChanged?: (
    scope: { readonly projectId: string; readonly worktreeId: string },
    reason: 'hooks' | 'scripts',
  ) => void;
}

/** Shown when a shell action has no mapping on this connection. */
export const SHELL_COMMAND_UNAVAILABLE =
  "This action isn't available on this connection yet.";
const ATTACHMENTS_UNAVAILABLE =
  "Attachments can't be sent on this connection yet. Remove them and try again.";
const ATTACHMENT_UNKNOWN = 'Attach the file again, then send.';
const NO_TARGET = 'Open this worktree again, then try again.';
const RUN_GONE = 'This run is no longer available.';
const HOOK_SELECTION = 'Provide exactly one of hookKey or all: true.';
const FILE_REFERENCE_UNKNOWN = 'Pick the file again, then send.';
const DEFAULT_THINKING_UNAVAILABLE = 'Choose a thinking level for this chat.';
const UNKNOWN_MODEL = "This model isn't available on this computer.";
const CLOSE_BLOCKED =
  'The chat cannot be closed while work is active or awaiting review.';
const STANDALONE_NOT_FOUND = 'This chat is no longer available.';

/** Runtime statuses during which a tab may not close (as Portal refuses). */
const ACTIVE_RUNTIME_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
]);

/** References this client minted; oldest are dropped past the bound. */
const MAX_FILE_REFERENCES = 5_000;
const MAX_MENTIONS = 200;
const DEFAULT_MENTIONS = 50;

const isChatCommandResult = recordWith<WireChatCommandResult>('outcome');
const isChatCancelResult = reply<WireChatCancelResult>(isRecord);
const isExactCancelResult = reply<
  WireChatCancelResult & {
    readonly outcome: 'stop_requested' | 'turn_not_active';
  }
>(
  (value) =>
    isRecord(value) &&
    (value.outcome === 'stop_requested' || value.outcome === 'turn_not_active'),
);
const isChatState = reply<WireChatState & { readonly revision?: number }>(
  (value) =>
    isRecord(value) &&
    isRecord(value.tabsFile) &&
    Array.isArray(value.tabsFile.tabs),
);
const isFileTreeRoots = recordWithArray<WireFileTreeRoots>('roots');
const isRecordReply = reply<Record<string, unknown>>(isRecord);
const isNullableRecordReply = reply<Record<string, unknown> | null>(
  (value) => value === null || isRecord(value),
);
const isIpcResult = reply<WireIpcResult<unknown>>(
  (value) => isRecord(value) && typeof value.success === 'boolean',
);
const isResolvedInvocable = reply<WireResolvedInvocable>(
  (value) =>
    isRecord(value) &&
    typeof value.insertText === 'string' &&
    typeof value.invocationKey === 'string',
);
const isWatcherDeleteResult = reply<WireWatcherDeleteResult>(
  (value) => isRecord(value) && typeof value.ok === 'boolean',
);
const isFileIndex = recordWithArray<WireFileIndex>('repos');
const isScriptRunLog = reply<WireScriptRunLog>(
  (value) =>
    isRecord(value) &&
    Array.isArray(value.lines) &&
    value.lines.every((line: unknown) => typeof line === 'string'),
);
const isHookPauseResult = reply<WireHookPauseResult>(
  (value) =>
    isRecord(value) &&
    typeof value.ok === 'boolean' &&
    (value.pausedHookKeys === undefined ||
      (Array.isArray(value.pausedHookKeys) &&
        value.pausedHookKeys.every((key: unknown) => typeof key === 'string'))),
);
const isModelRegistry = reply<WireModelRegistry>(isRecord);
const isCreatedWorkEntry = reply<WireCreatedWorkEntry>(
  (value) =>
    isRecord(value) &&
    isRecord(value.entry) &&
    typeof value.entry.id === 'string',
);
const isStandaloneSnapshot = reply<{
  readonly standaloneChats: readonly {
    readonly localId: string;
    readonly projectLocalId: string;
    readonly workEntryId?: string;
    readonly archived?: boolean;
  }[];
}>(
  (value) =>
    isRecord(value) &&
    Array.isArray(value.standaloneChats) &&
    value.standaloneChats.every(
      (chat: unknown) =>
        isRecord(chat) &&
        typeof chat.localId === 'string' &&
        typeof chat.projectLocalId === 'string',
    ),
);

function unsupported(operation: string, message: string): Promise<never> {
  return Promise.reject(new UnsupportedOperationError(operation, message));
}

function isApplied(result: WireChatCommandResult): boolean {
  return result.outcome === 'applied' || result.outcome === 'already_applied';
}

function refusalMessage(outcome: string): string {
  switch (outcome) {
    case 'conflict':
      return 'The chat changed. Try again.';
    case 'not_found':
      return 'This chat is no longer available.';
    default:
      return "The computer didn't apply this change.";
  }
}

function acceptedReceipt(
  commandId: string,
  result: Record<string, unknown>,
  chatId?: string,
): ShellCommandReceipt {
  return {
    commandId,
    queuedWhileReconnecting: false,
    ok: true,
    ...(chatId === undefined ? {} : { chatId }),
    result: { ok: true, ...result },
  };
}

function refusedReceipt(
  commandId: string,
  error: string,
  result?: Record<string, unknown>,
): ShellCommandReceipt {
  return {
    commandId,
    queuedWhileReconnecting: false,
    ok: false,
    error,
    ...(result === undefined ? {} : { result }),
  };
}

/** A `chat:command` reply as a receipt: applied, or a definite refusal. */
function chatCommandReceipt(
  commandId: string,
  reply: WireChatCommandResult,
  extra: {
    readonly chatId?: string;
    readonly result?: Record<string, unknown>;
  } = {},
): ShellCommandReceipt {
  const fields: Record<string, unknown> = {
    commandId: reply.commandId ?? commandId,
    outcome: reply.outcome,
    ...(reply.revision === undefined ? {} : { revision: reply.revision }),
    ...(reply.entityId === undefined ? {} : { entityId: reply.entityId }),
    ...(reply.messageId === undefined ? {} : { messageId: reply.messageId }),
    ...extra.result,
  };
  return isApplied(reply)
    ? acceptedReceipt(commandId, fields, extra.chatId)
    : refusedReceipt(
        commandId,
        reply.reason ?? refusalMessage(reply.outcome),
        fields,
      );
}

/** The composer settings a send carries, as the Portal executor merges them. */
function sendModelConfig(
  payload: PortalChatSendPayload,
): PortalAgentModelConfig | undefined {
  const config: PortalAgentModelConfig = {
    ...(payload.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: payload.thinkingLevel }),
    ...(payload.codexFastModeEnabled === undefined
      ? {}
      : { fastMode: payload.codexFastModeEnabled }),
    ...payload.modelConfig,
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

/** A model's provider from the computer's registry, or null when unknown. */
function providerForModel(
  registry: WireModelRegistry,
  requested: string,
): string | null {
  const PROVIDERS = [
    'claude',
    'codex',
    'ollama',
    'cursor',
    'copilot',
    'opencode',
  ] as const;
  const find = (model: string): string | null => {
    for (const provider of PROVIDERS) {
      if (registry[provider]?.some((entry) => entry.id === model)) {
        return provider;
      }
    }
    return null;
  };
  const model = registry.aliases?.[requested] ?? requested;
  const native = find(model);
  if (native !== null) return native;
  const agent = registry.agents?.find((entry) => entry.id === model);
  if (agent === undefined) return null;
  return find(registry.aliases?.[agent.baseModel] ?? agent.baseModel);
}

interface MintedReference {
  readonly displayPath: string;
  readonly absolutePath: string;
  readonly repoName: string;
  readonly kind?: string;
}

/**
 * File references for `@` mentions. As Portal's reference broker, the client
 * hands shell code opaque ids and keeps the computer paths they stand for;
 * a send resolves them back. Ids are stable per path for the client's life.
 */
function createReferenceRegistry(): {
  mint(root: WireFileTreeRoot, relativePath: string, kind?: string): string;
  resolve(referenceId: string): MintedReference | undefined;
} {
  const byId = new Map<string, MintedReference>();
  const idByPath = new Map<string, string>();
  let sequence = 0;
  return {
    mint(root, relativePath, kind) {
      const absolutePath = joinRootPath(root.absolutePath, relativePath);
      const existing = idByPath.get(absolutePath);
      if (existing !== undefined) return existing;
      sequence += 1;
      const id = `direct-ref-${String(sequence)}`;
      byId.set(id, {
        displayPath: relativePath || root.repoName,
        absolutePath,
        repoName: root.repoName,
        ...(kind === undefined ? {} : { kind }),
      });
      idByPath.set(absolutePath, id);
      if (byId.size > MAX_FILE_REFERENCES) {
        const oldest = byId.keys().next();
        if (!oldest.done) {
          const dropped = byId.get(oldest.value);
          byId.delete(oldest.value);
          if (dropped) idByPath.delete(dropped.absolutePath);
        }
      }
      return id;
    },
    resolve: (referenceId) => byId.get(referenceId),
  };
}

function basename(relativePath: string): string {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? relativePath;
}

/** The worktree a shell command's navigation target names, if any. */
function targetWorktree(
  target: ShellCommandTarget | undefined,
): { projectId: string; worktreeId: string } | null {
  const projectId = target?.workspaceLocalId;
  const worktreeId = target?.worktreeLocalId;
  return projectId && worktreeId ? { projectId, worktreeId } : null;
}

/** A field the payload type does not declare (Portal-only markers). */
function extraField(payload: object, key: string): unknown {
  return Reflect.get(payload, key);
}

interface UploadedAttachment {
  readonly path: string;
}

/** Files this client stored on the computer, by the reference it minted. */
function createAttachmentRegistry(): {
  mint(path: string): string;
  resolve(attachmentId: string): UploadedAttachment | undefined;
} {
  const byId = new Map<string, UploadedAttachment>();
  let sequence = 0;
  return {
    mint(path) {
      sequence += 1;
      const id = `direct-upload-${String(sequence)}`;
      byId.set(id, { path });
      if (byId.size > MAX_FILE_REFERENCES) {
        const oldest = byId.keys().next();
        if (!oldest.done) byId.delete(oldest.value);
      }
      return id;
    },
    resolve: (attachmentId) => byId.get(attachmentId),
  };
}

export function createShellCommandHandlers(deps: ShellCommandDeps): {
  readonly queries: ShellQueryHandlers;
  readonly commands: ShellCommandHandlers;
  readonly orchestrator: Pick<OrchestratorHandlers, 'query' | 'subscribe'>;
  readonly uploadAttachment: (
    args: CommandMap['chat.attachments.upload']['args'],
  ) => Promise<CommandMap['chat.attachments.upload']['result']>;
} {
  const { channels, randomId } = deps;
  const references = createReferenceRegistry();
  const attachments = createAttachmentRegistry();

  /**
   * Attachments for a send: every reference must be one this client
   * uploaded, sent as its computer path. Null when one is not.
   */
  const resolveAttachments = (
    refs: readonly PortalChatCloudAttachmentRef[] | undefined,
    paths: readonly string[] | undefined,
  ): string[] | null | undefined => {
    if (refs === undefined || refs.length === 0) {
      return paths === undefined || paths.length === 0 ? undefined : [...paths];
    }
    if (deps.uploadFile === undefined) return null;
    const resolved = [...(paths ?? [])];
    for (const ref of refs) {
      const uploaded = attachments.resolve(ref.attachmentId);
      if (uploaded === undefined) return null;
      resolved.push(uploaded.path);
    }
    return resolved;
  };

  const chatCommand = async (
    target: { readonly projectId: string; readonly worktreeId: string },
    command: Record<string, unknown>,
    options: { readonly expectedRevision?: number } = {},
  ): Promise<{ commandId: string; reply: WireChatCommandResult }> => {
    const commandId = randomId();
    const reply = await channels.invoke(C.chatCommand, isChatCommandResult, {
      schemaVersion: 1,
      commandId,
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      ...(options.expectedRevision === undefined
        ? {}
        : { expectedRevision: options.expectedRevision }),
      command,
    });
    return { commandId, reply };
  };

  /** One revisioned chat change, as a receipt. */
  const chatChange = async (
    target: { readonly projectId: string; readonly worktreeId: string },
    command: Record<string, unknown>,
  ): Promise<ShellCommandReceipt> => {
    const { commandId, reply } = await chatCommand(target, command);
    return chatCommandReceipt(commandId, reply);
  };

  const modelProvider = async (model: string): Promise<string | null> =>
    providerForModel(
      await channels.invoke(C.modelRegistryGet, isModelRegistry),
      model,
    );

  /** A standalone chat's Work Entry, from the computer's session snapshot. */
  const standaloneTarget = async (
    projectLocalId: string | undefined,
    chatId: string,
  ): Promise<{ projectId: string; worktreeId: string } | null> => {
    const snapshot = await channels.invoke(
      C.desktopSessionSnapshot,
      isStandaloneSnapshot,
      {},
    );
    const chat = snapshot.standaloneChats.find(
      (candidate) =>
        candidate.localId === chatId &&
        (projectLocalId === undefined ||
          candidate.projectLocalId === projectLocalId),
    );
    if (
      chat === undefined ||
      chat.archived === true ||
      chat.workEntryId === undefined
    )
      return null;
    return { projectId: chat.projectLocalId, worktreeId: chat.workEntryId };
  };

  /** Resolve this client's references for a send; unknown ids never reach the computer. */
  const resolveReferences = (
    refs: readonly PortalChatFileReference[] | undefined,
  ): Record<string, unknown>[] | null | undefined => {
    if (refs === undefined || refs.length === 0) return undefined;
    const resolved: Record<string, unknown>[] = [];
    for (const ref of refs) {
      const minted = references.resolve(ref.referenceId);
      if (minted === undefined) return null;
      resolved.push({
        displayPath: minted.displayPath,
        absolutePath: minted.absolutePath,
        repoName: minted.repoName,
        ...(minted.kind === undefined ? {} : { kind: minted.kind }),
        ...(ref.textStart === undefined ? {} : { textStart: ref.textStart }),
      });
    }
    return resolved;
  };

  const orchestrator = createOrchestratorHandlers({
    channels,
    surface: deps.appAdvisorSurface,
    randomId,
    now: deps.now,
    modelProvider,
    resolveReferences,
  });

  /**
   * One pause or resume, applied by the computer to the latest worktree row
   * (as Portal's hook pause): a competing change is kept, never overwritten.
   */
  const changeHookPause = async (
    kind: 'pause' | 'resume',
    payload: CommandMap['hook.pause']['args']['payload'],
  ): Promise<ShellCommandReceipt> => {
    const hookKey =
      payload.hookKey !== undefined && payload.hookKey !== ''
        ? payload.hookKey
        : undefined;
    if ((hookKey !== undefined) === (payload.all === true))
      return refusedReceipt(randomId(), HOOK_SELECTION);
    const commandId = randomId();
    const changed = await channels.invoke(
      C.hookChangePause,
      isHookPauseResult,
      {
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
        kind,
        ...(hookKey === undefined ? { all: true } : { hookKey }),
      },
    );
    if (!changed.ok) {
      return refusedReceipt(
        commandId,
        changed.error ?? "The computer didn't apply this change.",
      );
    }
    deps.activityChanged?.(
      { projectId: payload.projectId, worktreeId: payload.worktreeId },
      'hooks',
    );
    return acceptedReceipt(commandId, {
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
      pausedHookKeys: [...(changed.pausedHookKeys ?? [])],
    });
  };

  /** A pipeline channel's `IPCResult` as a receipt. */
  const pipelineReceipt = (
    reply: WireIpcResult<unknown>,
    result: Record<string, unknown> = {},
  ): ShellCommandReceipt =>
    reply.success
      ? acceptedReceipt(randomId(), result)
      : refusedReceipt(
          randomId(),
          reply.error ?? "The computer didn't apply this change.",
        );

  const sendMessage = async (
    target: { readonly projectId: string; readonly worktreeId: string },
    input: {
      readonly chatId: string;
      readonly userMessageId: string;
      readonly text: string;
      readonly fileReferences: readonly Record<string, unknown>[] | undefined;
      readonly fields: Record<string, unknown>;
    },
  ): Promise<ShellCommandReceipt> => {
    const { commandId, reply } = await chatCommand(target, {
      type: 'chat.send_message',
      chatId: input.chatId,
      userMessageId: input.userMessageId,
      text: input.text,
      ...input.fields,
      ...(input.fileReferences === undefined
        ? {}
        : { fileReferences: input.fileReferences }),
    });
    return chatCommandReceipt(commandId, reply, {
      chatId: input.chatId,
      result: { userMessageId: input.userMessageId },
    });
  };

  const queries: ShellQueryHandlers = {
    'editor.fileMentions': async ({ payload }) => {
      const commandId = randomId();
      if (payload.rebind !== undefined) {
        // This client's references name computer paths, which hold in every
        // worktree; a reference minted elsewhere cannot be rebound here.
        const rebound = payload.rebind.fileReferences;
        if (
          !rebound.every(
            (ref) => references.resolve(ref.referenceId) !== undefined,
          )
        ) {
          return unsupported('editor.fileMentions', FILE_REFERENCE_UNKNOWN);
        }
        return acceptedReceipt(commandId, {
          files: [],
          fileReferences: rebound,
        });
      }
      const { roots } = await channels.invoke(
        C.fileTreeRoots,
        isFileTreeRoots,
        {
          projectId: payload.projectId,
          worktreeId: payload.worktreeId,
        },
      );
      const option = (
        root: WireFileTreeRoot,
        relativePath: string,
        kind: 'file' | 'directory',
      ): PortalEditorFileMentionOption => ({
        referenceId: references.mint(root, relativePath, kind),
        repoId: root.repoId,
        repoName: root.repoName,
        relativePath,
        filename: basename(relativePath) || root.repoName,
        kind,
      });
      const selector = payload.selector;
      if (selector !== undefined) {
        const root = roots.find(
          (candidate) => candidate.repoId === selector.repoId,
        );
        if (root === undefined) {
          return refusedReceipt(
            commandId,
            'This folder is no longer available.',
          );
        }
        return acceptedReceipt(commandId, {
          files: [option(root, selector.relativePath, selector.kind)],
        });
      }
      const index = await channels.invoke(C.fileIndexGet, isFileIndex, {
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
        purpose: 'mentions',
      });
      const needle = (payload.query ?? '').trim().toLowerCase();
      const limit = Math.max(
        0,
        Math.min(payload.limit ?? DEFAULT_MENTIONS, MAX_MENTIONS),
      );
      const files: PortalEditorFileMentionOption[] = [];
      for (const repo of index.repos) {
        const root = roots.find(
          (candidate) => candidate.repoId === repo.repoId,
        );
        if (root === undefined) continue;
        for (const file of repo.files) {
          if (files.length >= limit) break;
          if (needle && !file.relativePath.toLowerCase().includes(needle))
            continue;
          files.push(option(root, file.relativePath, 'file'));
        }
      }
      return acceptedReceipt(commandId, { files });
    },
    'editor.slashCommands': async ({ payload }) => {
      const commandId = randomId();
      const reply = await channels.invoke(
        C.editorListSlashCommands,
        recordWithArray<{ readonly commands: readonly unknown[] }>('commands'),
        {
          projectId: payload.projectId,
          worktreeId: payload.worktreeId,
          ...(payload.providerType === undefined
            ? {}
            : { providerType: payload.providerType }),
        },
      );
      return acceptedReceipt(commandId, { commands: reply.commands });
    },
    'editor.invocables': async ({ payload }) => {
      const commandId = randomId();
      const reply = await channels.invoke(
        C.editorListInvocables,
        recordWithArray<Record<string, unknown>>('commands'),
        {
          target: payload.target,
          ...(payload.providerType === undefined
            ? {}
            : { providerType: payload.providerType }),
        },
      );
      return acceptedReceipt(commandId, reply);
    },
    'editor.pluginCatalog': async ({ payload }) => {
      const commandId = randomId();
      const catalog = await channels.invoke(
        C.pluginCatalogList,
        isRecordReply,
        { projectId: payload.projectId },
      );
      return acceptedReceipt(commandId, catalog);
    },
    'pipeline.get': async ({ payload }) => {
      const commandId = randomId();
      const detail = await channels.invoke(
        C.pipelinesGetForWorktree,
        isRecordReply,
        {
          pipelineId: payload.pipelineId,
          projectId: payload.projectId,
          ...(payload.worktreeId === undefined
            ? {}
            : { worktreeId: payload.worktreeId }),
        },
      );
      return acceptedReceipt(commandId, detail);
    },
    'pipeline.executions': async ({ payload, target }) => {
      const commandId = randomId();
      const scope =
        payload.projectId !== undefined && payload.worktreeId !== undefined
          ? { projectId: payload.projectId, worktreeId: payload.worktreeId }
          : targetWorktree(target);
      if (scope === null) return refusedReceipt(commandId, NO_TARGET);
      const listed = await channels.invoke(
        C.pipelinesListWorktreeExecutions,
        recordWithArray<{
          readonly runs: readonly unknown[];
          readonly truncated?: boolean;
        }>('runs'),
        scope,
      );
      const limit = payload.limit;
      const runs =
        limit === undefined ? listed.runs : listed.runs.slice(0, limit);
      const truncated =
        listed.truncated === true || runs.length < listed.runs.length;
      return acceptedReceipt(commandId, {
        runs,
        ...(truncated ? { truncated: true } : {}),
      });
    },
    'pipeline.execution': async ({ payload, target }) => {
      const scope = targetWorktree(target);
      if (scope === null) {
        return unsupported('pipeline.execution', NO_TARGET);
      }
      const commandId = randomId();
      const run = await channels.invoke(
        C.pipelinesGetWorktreeExecution,
        isNullableRecordReply,
        { ...scope, executionId: payload.executionId },
      );
      return run === null
        ? refusedReceipt(commandId, RUN_GONE)
        : acceptedReceipt(commandId, run);
    },
  };

  const commands: ShellCommandHandlers = {
    'chat.send': async ({ payload }) => {
      const attachmentPaths = resolveAttachments(
        payload.cloudAttachments,
        payload.attachmentPaths,
      );
      if (attachmentPaths === null) {
        return unsupported(
          'chat.send',
          deps.uploadFile === undefined
            ? ATTACHMENTS_UNAVAILABLE
            : ATTACHMENT_UNKNOWN,
        );
      }
      const fileReferences = resolveReferences(payload.fileReferences);
      if (fileReferences === null) {
        return unsupported('chat.send', FILE_REFERENCE_UNKNOWN);
      }
      const target = {
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
      };
      let chatId = payload.chatId;
      if (chatId === undefined) {
        // Portal lets the computer mint the chat; here the client mints it
        // and creates it before the message, in that order.
        const minted = randomId();
        const created = await chatCommand(target, {
          type: 'chat.create_tab',
          tabId: minted,
        });
        if (!isApplied(created.reply)) {
          return chatCommandReceipt(created.commandId, created.reply);
        }
        chatId = created.reply.entityId ?? minted;
      }
      const modelConfig = sendModelConfig(payload);
      return sendMessage(target, {
        chatId,
        userMessageId: payload.userMessageId ?? randomId(),
        text: payload.text,
        fileReferences,
        fields: {
          // A worktree send runs on the chat's own model, as Portal's
          // canonical path does; the persistent setters change it.
          ...(payload.modelSelectionMode === 'auto'
            ? { modelSelectionMode: 'auto' }
            : {}),
          ...(payload.selectedRepoId === undefined
            ? {}
            : { selectedRepoId: payload.selectedRepoId }),
          ...(modelConfig === undefined ? {} : { modelConfig }),
          ...(payload.planReviewApproval === undefined
            ? {}
            : { planReviewApproval: payload.planReviewApproval }),
          ...(payload.planMode === undefined
            ? {}
            : { planMode: payload.planMode }),
          ...(payload.codexProposalMode === undefined
            ? {}
            : { codexProposalMode: payload.codexProposalMode }),
          ...(payload.inputMode === undefined
            ? {}
            : { inputMode: payload.inputMode }),
          ...(attachmentPaths === undefined ? {} : { attachmentPaths }),
        },
      });
    },
    'chat.cancel': async ({ payload, target }) => {
      const commandId = randomId();
      if (extraField(payload, 'withdrawFirstMessage') === true) {
        // No server holds the first message here: the computer already has
        // it. Stop stops that turn; Dismiss (of a message that never reached
        // the computer) has nothing to take back.
        if (extraField(payload, 'firstMessageWithdrawalMode') === 'dismiss') {
          return acceptedReceipt(commandId, {});
        }
        const scope = targetWorktree(target);
        if (scope === null) return unsupported('chat.cancel', NO_TARGET);
        await channels.invoke(C.chatCancel, isChatCancelResult, {
          ...scope,
          chatId: payload.chatId,
        });
        return acceptedReceipt(commandId, {});
      }
      const result = await channels.invoke(C.chatCancel, isChatCancelResult, {
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
        chatId: payload.chatId,
      });
      return acceptedReceipt(commandId, {
        ...(result.resumableTurn === undefined
          ? {}
          : { resumableTurn: result.resumableTurn }),
      });
    },
    'chat.cancelTurn': async ({ payload }) => {
      const commandId = randomId();
      const result = await channels.invoke(C.chatCancel, isExactCancelResult, {
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
        chatId: payload.chatId,
        // The turn is named by the user message that started it.
        expectedUserMessageId: payload.turnId,
      });
      return acceptedReceipt(commandId, { outcome: result.outcome });
    },
    'chat.createTab': async ({ payload }) => {
      const target = {
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
      };
      let model: { model: string; providerType: string } | undefined;
      if (payload.model !== undefined) {
        const providerType =
          payload.providerType ?? (await modelProvider(payload.model));
        if (providerType === null) {
          return refusedReceipt(randomId(), UNKNOWN_MODEL);
        }
        model = { model: payload.model, providerType };
      }
      return chatChange(target, {
        type: 'chat.create_tab',
        tabId: payload.chatId,
        ...model,
        ...(payload.pluginSelections === undefined
          ? {}
          : { pluginSelections: payload.pluginSelections }),
      });
    },
    'chat.closeTab': async ({ payload }) => {
      const target = {
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
      };
      const state = await channels.invoke(C.chatGetState, isChatState, target);
      const tab = state.tabsFile.tabs.find(
        (candidate) => candidate.id === payload.chatId,
      );
      // Closing a tab the computer does not have changes nothing, as on Portal.
      if (tab === undefined) return acceptedReceipt(randomId(), {});
      const runtime = state.runtimeByChatId?.[payload.chatId];
      if (
        tab.pendingPlanExit !== undefined ||
        (runtime?.status !== undefined &&
          ACTIVE_RUNTIME_STATUSES.has(runtime.status)) ||
        (runtime?.queuedMessageIds?.length ?? 0) > 0
      ) {
        return refusedReceipt(randomId(), CLOSE_BLOCKED);
      }
      const messageCount =
        tab.transcript?.messageCount ??
        tab.transcript?.committedMessageCount ??
        tab.messages?.length ??
        0;
      const { commandId, reply } = await chatCommand(
        target,
        {
          type: 'chat.close_tab',
          tabId: payload.chatId,
          mode: messageCount > 0 ? 'archive' : 'discard_empty',
          ...(state.tabsFile.tabs.length === 1
            ? { replacementTabId: randomId() }
            : {}),
        },
        state.revision === undefined
          ? {}
          : { expectedRevision: state.revision },
      );
      return chatCommandReceipt(commandId, reply);
    },
    'chat.setModel': async ({ payload }) => {
      const target = {
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
      };
      if (payload.selectionMode === 'auto') {
        return chatChange(target, {
          type: 'chat.patch_tab_settings',
          tabId: payload.chatId,
          patch: { modelSelectionMode: 'auto' },
        });
      }
      const providerType = await modelProvider(payload.model);
      if (providerType === null) {
        return refusedReceipt(randomId(), UNKNOWN_MODEL);
      }
      return chatChange(target, {
        type: 'chat.set_model',
        tabId: payload.chatId,
        model: payload.model,
        providerType,
        ...(payload.executionHarness === undefined
          ? {}
          : { executionHarness: payload.executionHarness }),
      });
    },
    'chat.setThinkingLevel': ({ payload }) => {
      if (!isThinkingLevel(payload.thinkingLevel)) {
        // `default` clears a cloud chat's override; computers keep a level.
        return unsupported(
          'chat.setThinkingLevel',
          DEFAULT_THINKING_UNAVAILABLE,
        );
      }
      return chatChange(payload, {
        type: 'chat.patch_tab_settings',
        tabId: payload.chatId,
        patch: { modelConfig: { thinkingLevel: payload.thinkingLevel } },
      });
    },
    'chat.setPlanMode': ({ payload }) =>
      chatChange(payload, {
        type: 'chat.patch_tab_settings',
        tabId: payload.chatId,
        patch: { planMode: payload.planMode },
      }),
    'chat.setFastMode': ({ payload }) =>
      chatChange(payload, {
        type: 'chat.patch_tab_settings',
        tabId: payload.chatId,
        patch: { modelConfig: { fastMode: payload.fastMode } },
      }),
    'chat.setPluginSelections': ({ payload }) =>
      chatChange(payload, {
        type: 'chat.patch_tab_settings',
        tabId: payload.chatId,
        patch: {
          pluginSelections: payload.selections,
          ...(payload.deferredToolsAllowed === undefined
            ? {}
            : { deferredToolsAllowed: payload.deferredToolsAllowed }),
        },
      }),
    'chat.answerQuestion': ({ payload }) =>
      chatChange(payload, {
        type: 'chat.answer_question',
        chatId: payload.chatId,
        questionId: payload.requestId,
        answers: payload.answers,
      }),
    'chat.dismissQuestion': ({ payload }) =>
      chatChange(payload, {
        type: 'chat.dismiss_question',
        chatId: payload.chatId,
        questionId: payload.requestId,
      }),
    'chat.markRead': async ({ payload }) => {
      const target =
        payload.scope === 'worktree'
          ? { projectId: payload.projectId, worktreeId: payload.worktreeId }
          : await standaloneTarget(payload.projectLocalId, payload.chatId);
      if (target === null) {
        return refusedReceipt(randomId(), STANDALONE_NOT_FOUND);
      }
      return chatChange(target, {
        type: 'chat.mark_read',
        chatId: payload.chatId,
      });
    },
    'chat.setUnread': async ({ payload }) => {
      const target =
        payload.scope === 'worktree'
          ? { projectId: payload.projectId, worktreeId: payload.worktreeId }
          : await standaloneTarget(payload.projectLocalId, payload.chatId);
      if (target === null) {
        return refusedReceipt(randomId(), STANDALONE_NOT_FOUND);
      }
      return chatChange(
        target,
        payload.unread
          ? { type: 'chat.mark_unread', chatId: payload.chatId, manual: true }
          : { type: 'chat.mark_read', chatId: payload.chatId },
      );
    },
    'standaloneChat.send': async ({ payload }) => {
      const attachmentPaths = resolveAttachments(
        payload.cloudAttachments,
        undefined,
      );
      if (attachmentPaths === null) {
        return unsupported(
          'standaloneChat.send',
          deps.uploadFile === undefined
            ? ATTACHMENTS_UNAVAILABLE
            : ATTACHMENT_UNKNOWN,
        );
      }
      const fileReferences = resolveReferences(payload.fileReferences);
      if (fileReferences === null) {
        return unsupported('standaloneChat.send', FILE_REFERENCE_UNKNOWN);
      }
      const projectLocalId = payload.projectLocalId ?? payload.projectId;
      let target = await standaloneTarget(projectLocalId, payload.chatId);
      if (target === null) {
        // A chat's first send creates it, as older Portal desktops do.
        if (projectLocalId === undefined) {
          return refusedReceipt(randomId(), STANDALONE_NOT_FOUND);
        }
        const created = await channels.invoke(
          C.workEntriesCreate,
          isCreatedWorkEntry,
          {
            projectId: projectLocalId,
            ...(payload.sidebarItemGroupId === undefined
              ? {}
              : { sidebarItemGroupId: payload.sidebarItemGroupId }),
          },
        );
        target = { projectId: projectLocalId, worktreeId: created.entry.id };
        const tab = await chatCommand(target, {
          type: 'chat.create_tab',
          tabId: payload.chatId,
        });
        if (!isApplied(tab.reply)) {
          return chatCommandReceipt(tab.commandId, tab.reply);
        }
        await channels.invokeVoid(C.desktopSessionSnapshotInvalidate);
      }
      const modelConfig =
        payload.modelConfig === undefined && payload.thinkingLevel === undefined
          ? undefined
          : {
              ...(payload.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: payload.thinkingLevel }),
              ...payload.modelConfig,
            };
      const providerType =
        payload.model === undefined
          ? payload.providerType
          : ((await modelProvider(payload.model)) ?? undefined);
      if (payload.model !== undefined && providerType === undefined) {
        return refusedReceipt(randomId(), UNKNOWN_MODEL);
      }
      return sendMessage(target, {
        chatId: payload.chatId,
        userMessageId: payload.userMessageId ?? randomId(),
        text: payload.message,
        fileReferences,
        fields: {
          // Cowork sends carry their model, as Portal's executor sends them.
          ...(payload.model === undefined ? {} : { model: payload.model }),
          ...(providerType === undefined ? {} : { providerType }),
          ...(modelConfig === undefined ? {} : { modelConfig }),
          ...(payload.inputMode === undefined
            ? {}
            : { inputMode: payload.inputMode }),
          ...(attachmentPaths === undefined ? {} : { attachmentPaths }),
        },
      });
    },
    'standaloneChat.create': async ({ payload }) => {
      const existing = await standaloneTarget(
        payload.projectLocalId,
        payload.chatId,
      );
      const commandId = randomId();
      const created = (worktreeId: string): ShellCommandReceipt =>
        acceptedReceipt(commandId, {
          chatId: payload.chatId,
          projectLocalId: payload.projectLocalId,
          projectId: payload.projectLocalId,
          worktreeId,
          workEntryId: worktreeId,
        });
      // Idempotent: a chat that already has its Work Entry is created.
      if (existing !== null) return created(existing.worktreeId);
      const entry = await channels.invoke(
        C.workEntriesCreate,
        isCreatedWorkEntry,
        {
          projectId: payload.projectLocalId,
          ...(payload.sidebarItemGroupId === undefined
            ? {}
            : { sidebarItemGroupId: payload.sidebarItemGroupId }),
        },
      );
      const target = {
        projectId: payload.projectLocalId,
        worktreeId: entry.entry.id,
      };
      const tab = await chatCommand(target, {
        type: 'chat.create_tab',
        tabId: payload.chatId,
      });
      if (!isApplied(tab.reply)) {
        return chatCommandReceipt(tab.commandId, tab.reply);
      }
      await channels.invokeVoid(C.desktopSessionSnapshotInvalidate);
      return created(entry.entry.id);
    },
    'standaloneChat.cancel': async ({ payload }) => {
      const target = await standaloneTarget(
        payload.projectLocalId ?? payload.projectId,
        payload.chatId,
      );
      if (target === null) {
        return refusedReceipt(randomId(), STANDALONE_NOT_FOUND);
      }
      const commandId = randomId();
      await channels.invoke(C.chatCancel, isChatCancelResult, {
        ...target,
        chatId: payload.chatId,
      });
      return acceptedReceipt(commandId, {});
    },
    'standaloneChat.setModel': async ({ payload }) => {
      const target = await standaloneTarget(
        payload.projectLocalId ?? payload.projectId,
        payload.chatId,
      );
      if (target === null) {
        return refusedReceipt(randomId(), STANDALONE_NOT_FOUND);
      }
      const providerType = await modelProvider(payload.model);
      if (providerType === null) {
        return refusedReceipt(randomId(), UNKNOWN_MODEL);
      }
      return chatChange(target, {
        type: 'chat.set_model',
        tabId: payload.chatId,
        model: payload.model,
        providerType,
        ...(payload.executionHarness === undefined
          ? {}
          : { executionHarness: payload.executionHarness }),
      });
    },
    'standaloneChat.setPluginSelections': async ({ payload }) => {
      const target = await standaloneTarget(
        payload.projectLocalId ?? payload.projectId,
        payload.chatId,
      );
      if (target === null) {
        return refusedReceipt(randomId(), STANDALONE_NOT_FOUND);
      }
      return chatChange(target, {
        type: 'chat.patch_tab_settings',
        tabId: payload.chatId,
        patch: {
          pluginSelections: payload.selections,
          ...(payload.deferredToolsAllowed === undefined
            ? {}
            : { deferredToolsAllowed: payload.deferredToolsAllowed }),
        },
      });
    },
    ...orchestrator.commands,
    'editor.resolveInvocable': async ({ payload }) => {
      const resolved = await channels.invoke(
        C.editorResolveInvocable,
        isResolvedInvocable,
        {
          target: payload.target,
          entryId: payload.entryId,
          ...(payload.providerType === undefined
            ? {}
            : { providerType: payload.providerType }),
        },
      );
      const text = {
        insertText: resolved.insertText,
        invocationKey: resolved.invocationKey,
      };
      const enable = resolved.enable;
      if (enable === undefined) return acceptedReceipt(randomId(), text);
      // Enabling conflicts when the chat's selections changed meanwhile, as
      // Portal's executor commits it.
      const { commandId, reply } = await chatCommand(
        { projectId: enable.projectId, worktreeId: enable.worktreeId },
        {
          type: 'chat.patch_tab_settings',
          tabId: enable.tabId,
          patch: { pluginSelections: enable.pluginSelections },
          expectedPluginSelections: enable.expectedPluginSelections,
        },
      );
      return isApplied(reply)
        ? acceptedReceipt(commandId, {
            ...text,
            pluginSelections: enable.pluginSelections,
          })
        : refusedReceipt(
            commandId,
            reply.reason ?? 'The plugin selections were not applied.',
          );
    },
    'pipeline.resume': async ({ payload }) =>
      pipelineReceipt(
        await channels.invoke(
          C.pipelinesResume,
          isIpcResult,
          payload.executionId,
          payload.pauseResponses === undefined
            ? {}
            : { pauseResponses: payload.pauseResponses },
        ),
      ),
    'pipeline.retry': async ({ payload }) =>
      pipelineReceipt(
        await channels.invoke(
          C.pipelinesRetryExecution,
          isIpcResult,
          payload.executionId,
        ),
      ),
    'pipeline.rerun': async ({ payload }) =>
      pipelineReceipt(
        await channels.invoke(
          C.pipelinesRerunExecution,
          isIpcResult,
          payload.executionId,
        ),
      ),
    'pipeline.requestLog': async ({ payload }) => {
      // Portal pushes the log into its event stream; here it is the reply.
      const read = await channels.invoke(
        C.pipelinesReadStepLog,
        isIpcResult,
        {
          executionId: payload.executionId,
          jobId: payload.jobId,
          stepId: payload.stepId,
          ...(payload.attempt === undefined
            ? {}
            : { attempt: payload.attempt }),
          ...(payload.iteration === undefined
            ? {}
            : { iteration: payload.iteration }),
        },
        { format: 'lines' },
      );
      return pipelineReceipt(read, read.success ? { log: read.data } : {});
    },
    'pipeline.installCurated': async ({ payload }) => {
      const imported = await channels.invoke(
        C.pipelinesCuratedImport,
        isIpcResult,
        { key: payload.key, expectedContentHash: payload.expectedContentHash },
      );
      const id =
        isRecord(imported.data) && typeof imported.data.id === 'string'
          ? imported.data.id
          : undefined;
      return pipelineReceipt(
        imported,
        id === undefined ? {} : { pipelineId: id },
      );
    },
    'script.requestLog': async ({ payload, target }) => {
      const projectId = payload.projectId ?? target?.workspaceLocalId;
      const worktreeId = payload.worktreeId ?? target?.worktreeLocalId;
      if (!projectId || !worktreeId) {
        return refusedReceipt(randomId(), NO_TARGET);
      }
      const commandId = randomId();
      // Portal pushes the run's tail into its event stream; here it is the
      // reply, and the worktree's rows are read again with the new tail.
      const log = await channels.invoke(C.scriptReadRunLog, isScriptRunLog, {
        projectId,
        worktreeId,
        scriptKey: payload.scriptKey,
      });
      deps.activityChanged?.({ projectId, worktreeId }, 'scripts');
      return acceptedReceipt(commandId, { lines: [...log.lines] });
    },
    'hook.pause': ({ payload }) => changeHookPause('pause', payload),
    'hook.resume': ({ payload }) => changeHookPause('resume', payload),
    'plan.delete': async ({ payload }) => {
      const commandId = randomId();
      await channels.invokeVoid(C.trackedPlansDelete, {
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
        planId: payload.planId,
      });
      return acceptedReceipt(commandId, {});
    },
    'summary.refresh': async ({ payload }) => {
      const commandId = randomId();
      // Generation runs on; its result arrives with the worktree summary.
      await channels.invokeVoid(C.worktreeSummaryRefresh, {
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
      });
      return acceptedReceipt(commandId, {});
    },
    'watcher.delete': async ({ payload }) => {
      const commandId = randomId();
      const deleted = await channels.invoke(
        C.appAdvisorWatcherDelete,
        isWatcherDeleteResult,
        {
          watcherId: payload.watcherId,
          notifySubscriber: payload.notifySubscriber,
        },
      );
      return deleted.ok
        ? acceptedReceipt(commandId, {})
        : refusedReceipt(
            commandId,
            deleted.error ?? 'Watcher not found or currently firing.',
          );
    },
  };

  const uploadAttachment = async (
    args: CommandMap['chat.attachments.upload']['args'],
  ): Promise<CommandMap['chat.attachments.upload']['result']> => {
    const upload = deps.uploadFile;
    if (upload === undefined) {
      return unsupported('chat.attachments.upload', ATTACHMENTS_UNAVAILABLE);
    }
    const path = await upload(args.fileName, args.bytes);
    return {
      attachmentId: attachments.mint(path),
      filename: args.fileName,
      mediaType: args.mediaType,
      size: args.bytes.byteLength,
      contentSha256: args.contentSha256,
      storageKind: 'blob',
      source: 'direct-upload',
    };
  };

  return {
    queries,
    commands,
    orchestrator: {
      query: orchestrator.query,
      subscribe: orchestrator.subscribe,
    },
    uploadAttachment,
  };
}

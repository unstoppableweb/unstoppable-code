import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  CanopyCallerDescriptor,
  CanopyInstructionName,
} from '@canopy/protocol/canopy-core';
import {
  CoreChatMessageSendParamsSchema,
  CoreChatQueueEntryCancelParamsSchema,
  CoreChatQueueEntryUpdateParamsSchema,
  CoreChatQueueEntryForceParamsSchema,
  CoreChatArchiveParamsSchema,
  CoreChatCreateParamsSchema,
  CoreChatDeleteParamsSchema,
  CoreChatForkParamsSchema,
  CoreChatLifecycleResultSchema,
  CoreChatUpdateParamsSchema,
} from '@canopy/protocol/canopy-core';
import type {
  ChatCommand,
  ChatCommandRequest,
  ChatCommandExecutionOptions,
  ChatCommandResult,
  ChatModel,
  ChatModelChangeNotice,
  ChatStateCommandPort,
  FileTreeRoot,
  ModelHarness,
  ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { isModelHarness, isThinkingLevel } from '@canopy/desktop-shared/types';
import {
  codexSpeedFastMode,
  codexSpeedFromFastMode,
  isCodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import type { CodexSpeed } from '@canopy/execution-engine/lib/codex-speed';
import {
  CanopyOperationError,
  canopyInvalidArgumentError,
  canopyCapabilityUnavailableError,
  canopyPermissionDeniedError,
  canopyUnavailableError,
} from '@canopy/core-runtime';
import { validateChatCommandRequest } from '../ipc/chat-state';
import { validateId } from '../lib/validation';
import { listFileTreeRoots } from '../services/files-service';
import type { DesktopCanopyDispatcher } from './desktop-runtime';
import { ChatCommandKeyFingerprints } from './chat-command-key-fingerprints';
import {
  CHAT_MESSAGE_COMMAND_ROUTES,
  withLegacyChatMessageCommand,
} from './core-chat-message-command-adapter';

interface ChatFileRef {
  fileRootId: string;
  relativePath: string;
}

interface ChatCommandCapture {
  request: ChatCommandRequest;
  executionOptions?: ChatCommandExecutionOptions;
  fileRef?: ChatFileRef;
  portResult?: Promise<ChatCommandResult>;
  releaseAdmission?: () => void;
}

const commandCapture = new AsyncLocalStorage<ChatCommandCapture>();
const commandAdmission = new Map<string, Promise<void>>();
let outOfRootPathFallthroughs = 0;
let unavailableFileRootsFallthroughs = 0;
let unsupportedHostPathFallthroughs = 0;
let incompatibleLegacyPayloadFallthroughs = 0;

export function getOutOfRootChatPathFallthroughCount(): number {
  return outOfRootPathFallthroughs;
}

export function getUnavailableChatFileRootsFallthroughCount(): number {
  return unavailableFileRootsFallthroughs;
}

export function getUnsupportedChatHostPathFallthroughCount(): number {
  return unsupportedHostPathFallthroughs;
}

export function getIncompatibleLegacyChatPayloadFallthroughCount(): number {
  return incompatibleLegacyPayloadFallthroughs;
}

function commandFilePath(command: ChatCommand): string | undefined {
  switch (command.type) {
    case 'chat.create_file_tab':
      return command.filePath || undefined;
    case 'chat.patch_tab_settings':
      return command.patch.filePath;
    case 'chat.create_tab':
      return command.seedTab?.filePath;
    case 'chat.close_tab':
    case 'chat.close_tabs':
      return command.replacementTab?.seedTab?.filePath;
    case 'chat.fork_tab':
      return command.destinationTab?.filePath;
    default:
      return undefined;
  }
}

async function realPathOfNearestAncestor(filePath: string): Promise<string> {
  let candidate = filePath;
  for (;;) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      let candidateExists = false;
      try {
        await lstat(candidate);
        candidateExists = true;
      } catch (statError) {
        if (!isRecord(statError) || statError.code !== 'ENOENT')
          throw statError;
      }
      if (candidateExists) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function resolveFileRef(
  filePath: string,
  roots: readonly FileTreeRoot[],
): Promise<ChatFileRef | undefined> {
  if (!isAbsolute(filePath)) return undefined;
  for (const root of [...roots].sort(
    (left, right) => right.absolutePath.length - left.absolutePath.length,
  )) {
    const pathWithinRoot = relative(
      resolve(root.absolutePath),
      resolve(filePath),
    );
    if (
      pathWithinRoot.length === 0 ||
      pathWithinRoot === '..' ||
      pathWithinRoot.startsWith(`..${sep}`) ||
      isAbsolute(pathWithinRoot)
    ) {
      continue;
    }
    const relativePath = pathWithinRoot.split(sep).join('/');
    if (
      relativePath.split('/').some((segment) => segment === '..') ||
      relativePath.includes('\\')
    ) {
      continue;
    }
    try {
      const rootReal = await realpath(root.absolutePath);
      const ancestorReal = await realPathOfNearestAncestor(filePath);
      const realRelative = relative(rootReal, ancestorReal);
      if (
        realRelative === '..' ||
        realRelative.startsWith(`..${sep}`) ||
        isAbsolute(realRelative)
      ) {
        continue;
      }
    } catch {
      continue;
    }
    return { fileRootId: root.repoId, relativePath };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function absolutePathForFileRef(
  ref: unknown,
  params: ChatLifecycleParams,
): Promise<string> {
  if (
    !isRecord(ref) ||
    typeof ref.fileRootId !== 'string' ||
    typeof ref.relativePath !== 'string'
  ) {
    throw canopyInvalidArgumentError('Invalid chat file reference.');
  }
  const { roots } = await listFileTreeRoots({
    projectId: params.projectId,
    worktreeId: params.worktreeId,
  });
  const root = roots.find((candidate) => candidate.repoId === ref.fileRootId);
  if (!root) throw canopyInvalidArgumentError('Unknown chat file root.');
  const absolutePath = resolve(
    join(root.absolutePath, ...ref.relativePath.split('/')),
  );
  if (
    (await resolveFileRef(absolutePath, [root]))?.relativePath !==
    ref.relativePath
  ) {
    throw canopyInvalidArgumentError('Chat file path escapes its root.');
  }
  return absolutePath;
}

async function restoreLegacyAction(
  action: unknown,
  params: ChatLifecycleParams,
): Promise<unknown> {
  if (!isRecord(action)) return action;
  if (action.type === 'chat.create_file_tab') {
    const { fileRef, ...rest } = action;
    return {
      ...rest,
      filePath: fileRef ? await absolutePathForFileRef(fileRef, params) : '',
    };
  }
  if (action.type === 'chat.patch_tab_settings') {
    const { fileRef, ...rest } = action;
    if (!isRecord(rest.patch)) return rest;
    return {
      ...rest,
      patch: {
        ...rest.patch,
        ...(fileRef
          ? { filePath: await absolutePathForFileRef(fileRef, params) }
          : {}),
      },
    };
  }
  if (action.type === 'chat.create_tab') {
    const { seedFileRef, ...rest } = action;
    if (isRecord(rest.seedTab) && rest.seedTab.filePath !== undefined) {
      throw canopyInvalidArgumentError(
        'Chat seed requires a portable file reference.',
      );
    }
    if (!seedFileRef) return rest;
    if (!isRecord(rest.seedTab)) return rest;
    return {
      ...rest,
      seedTab: {
        ...rest.seedTab,
        filePath: await absolutePathForFileRef(seedFileRef, params),
      },
    };
  }
  if (
    (action.type === 'chat.close_tab' || action.type === 'chat.close_tabs') &&
    isRecord(action.replacementTab)
  ) {
    return {
      ...action,
      replacementTab: await restoreLegacyAction(action.replacementTab, params),
    };
  }
  if (action.type === 'chat.fork_tab' && isRecord(action.destinationCreate)) {
    const { destinationCreate, ...rest } = action;
    if (destinationCreate.tabId !== action.targetTabId) {
      throw canopyInvalidArgumentError(
        'Fork destination must create the target tab.',
      );
    }
    const create = await restoreLegacyAction(destinationCreate, params);
    if (!isRecord(create) || create.seedTab === undefined) return rest;
    return { ...rest, destinationTab: create.seedTab };
  }
  return action;
}

function canonicalAction(
  command: ChatCommand,
  fileRef: ChatFileRef | undefined,
): unknown {
  if (command.type === 'chat.create_file_tab') {
    const { filePath, ...action } = command;
    void filePath;
    return { ...action, ...(fileRef ? { fileRef } : {}) };
  }
  if (command.type === 'chat.patch_tab_settings') {
    const patch = { ...command.patch };
    delete patch.filePath;
    return { ...command, patch, ...(fileRef ? { fileRef } : {}) };
  }
  if (
    command.type === 'chat.create_tab' &&
    command.seedTab?.filePath !== undefined
  ) {
    const seedTab = structuredClone(command.seedTab);
    delete seedTab.filePath;
    return {
      ...command,
      seedTab,
      ...(fileRef ? { seedFileRef: fileRef } : {}),
    };
  }
  if (
    (command.type === 'chat.close_tab' || command.type === 'chat.close_tabs') &&
    command.replacementTab?.seedTab?.filePath !== undefined
  ) {
    return {
      ...command,
      replacementTab: canonicalAction(command.replacementTab, fileRef),
    };
  }
  if (command.type === 'chat.fork_tab' && command.destinationTab) {
    const destinationTab = structuredClone(command.destinationTab);
    delete destinationTab.filePath;
    const { destinationTab: ignored, ...rest } = command;
    void ignored;
    return {
      ...rest,
      destinationCreate: {
        type: 'chat.create_tab',
        tabId: command.targetTabId,
        seedTab: destinationTab,
        ...(fileRef ? { seedFileRef: fileRef } : {}),
      },
    };
  }
  return command;
}

export interface ChatCommandRoute {
  instruction: CanopyInstructionName;
  toParams(command: ChatCommand, request: ChatCommandRequest): unknown;
  toLegacyResult(
    canonicalResult: unknown,
    captured: ChatCommandResult | undefined,
  ): ChatCommandResult;
}

function route(instruction: CanopyInstructionName): ChatCommandRoute {
  return {
    instruction,
    toParams: (command, request) => ({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      commandId: request.commandId,
      ...(request.origin === undefined ? {} : { origin: request.origin }),
      ...(request.expectedRevision === undefined
        ? {}
        : { expectedRevision: request.expectedRevision }),
      ...(request.expectedTabRevision === undefined
        ? {}
        : { expectedTabRevision: request.expectedTabRevision }),
      action: canonicalAction(command, commandCapture.getStore()?.fileRef),
      _meta: { idempotencyKey: request.commandId },
    }),
    toLegacyResult: (canonicalResult, captured) =>
      captured ?? CoreChatLifecycleResultSchema.parse(canonicalResult),
  };
}

export const CHAT_COMMAND_ROUTES: Partial<
  Record<ChatCommand['type'], ChatCommandRoute>
> = {
  'chat.create_tab': route('core.chat.create'),
  'chat.create_file_tab': route('core.chat.create'),
  'chat.activate_tab': route('core.chat.update'),
  'chat.reorder_tabs': route('core.chat.update'),
  'chat.patch_tab_settings': route('core.chat.update'),
  'chat.reject_plan_implementation_delivery': route('core.chat.update'),
  'chat.set_model': route('core.chat.update'),
  'chat.set_approval_mode': route('core.chat.update'),
  'chat.mark_read': route('core.chat.update'),
  'chat.mark_unread': route('core.chat.update'),
  'chat.mark_archive_read': route('core.chat.update'),
  'chat.mark_all_archives_read': route('core.chat.update'),
  'chat.dismiss_attention': route('core.chat.update'),
  'chat.archive_tab': route('core.chat.archive'),
  'chat.restore_archive': route('core.chat.archive'),
  'chat.close_tab': route('core.chat.delete'),
  'chat.close_tabs': route('core.chat.delete'),
  'chat.fork_tab': route('core.chat.fork'),
  ...CHAT_MESSAGE_COMMAND_ROUTES,
};

export interface DispatchChatCommandOptions {
  port: ChatStateCommandPort;
  executionOptions?: ChatCommandExecutionOptions;
  caller: CanopyCallerDescriptor;
  isShuttingDown?: () => boolean;
  instruction: (
    name: CanopyInstructionName,
    params: unknown,
    options: {
      caller: CanopyCallerDescriptor;
      metadata: { idempotencyKey: string };
    },
  ) => Promise<unknown>;
}

export function createChatCommandDispatchOptions(
  port: ChatStateCommandPort,
  dispatcher: DesktopCanopyDispatcher,
  caller: CanopyCallerDescriptor,
): DispatchChatCommandOptions {
  return {
    port,
    caller,
    isShuttingDown: () => dispatcher.isShuttingDown(),
    instruction: (name, params, options): Promise<unknown> => {
      switch (name) {
        case 'core.chat.create':
          return dispatcher.instruction(
            name,
            CoreChatCreateParamsSchema.parse(params),
            options,
          );
        case 'core.chat.update':
          return dispatcher.instruction(
            name,
            CoreChatUpdateParamsSchema.parse(params),
            options,
          );
        case 'core.chat.archive':
          return dispatcher.instruction(
            name,
            CoreChatArchiveParamsSchema.parse(params),
            options,
          );
        case 'core.chat.delete':
          return dispatcher.instruction(
            name,
            CoreChatDeleteParamsSchema.parse(params),
            options,
          );
        case 'core.chat.fork':
          return dispatcher.instruction(
            name,
            CoreChatForkParamsSchema.parse(params),
            options,
          );
        case 'core.chat.message.send':
          return dispatcher.instruction(
            name,
            CoreChatMessageSendParamsSchema.parse(params),
            options,
          );
        case 'core.chat.queue.entry.cancel':
          return dispatcher.instruction(
            name,
            CoreChatQueueEntryCancelParamsSchema.parse(params),
            options,
          );
        case 'core.chat.queue.entry.update':
          return dispatcher.instruction(
            name,
            CoreChatQueueEntryUpdateParamsSchema.parse(params),
            options,
          );
        case 'core.chat.queue.entry.force':
          return dispatcher.instruction(
            name,
            CoreChatQueueEntryForceParamsSchema.parse(params),
            options,
          );
        default:
          throw canopyCapabilityUnavailableError();
      }
    },
  };
}

export async function dispatchChatCommandForLegacyIpc(
  request: unknown,
  options: DispatchChatCommandOptions,
): Promise<ChatCommandResult> {
  const validated = validateChatCommandRequest(request);
  return dispatchTrustedChatCommand(validated, options);
}

export async function dispatchTrustedChatCommand(
  request: ChatCommandRequest,
  options: DispatchChatCommandOptions,
): Promise<ChatCommandResult> {
  const scope = JSON.stringify([request.projectId, request.worktreeId]);
  const previous = commandAdmission.get(scope);
  let release = (): void => undefined;
  const admitted = new Promise<void>((resolve) => {
    release = resolve;
  });
  commandAdmission.set(scope, admitted);
  try {
    if (previous) await previous;
    return await dispatchAdmittedChatCommand(request, options, release);
  } finally {
    release();
    if (commandAdmission.get(scope) === admitted)
      commandAdmission.delete(scope);
  }
}

// Admission orders port invocation, like the legacy IPC call it replaces; it
// is released once the port is invoked so long-running commands do not block
// the scope.
async function dispatchAdmittedChatCommand(
  request: ChatCommandRequest,
  options: DispatchChatCommandOptions,
  releaseAdmission: () => void,
): Promise<ChatCommandResult> {
  const commandPort = (): Promise<ChatCommandResult> => {
    const result = options.executionOptions
      ? options.port.command(request, options.executionOptions)
      : options.port.command(request);
    releaseAdmission();
    return result;
  };
  if (options.isShuttingDown?.()) return commandPort();
  const messageRoute = CHAT_MESSAGE_COMMAND_ROUTES[request.command.type];
  if (messageRoute) {
    const params = messageRoute.toParams(request.command, request);
    try {
      const result = await withLegacyChatMessageCommand(
        request,
        () =>
          options.instruction(messageRoute.instruction, params, {
            caller: options.caller,
            metadata: { idempotencyKey: request.commandId },
          }),
        releaseAdmission,
        options.executionOptions,
      );
      return messageRoute.toLegacyResult(result, undefined);
    } catch (error) {
      if (
        error instanceof CanopyOperationError &&
        error.runtimeCause instanceof Error
      ) {
        throw error.runtimeCause;
      }
      throw error;
    }
  }
  const commandRoute = CHAT_COMMAND_ROUTES[request.command.type];
  if (!commandRoute) return commandPort();
  if (
    request.command.type === 'chat.patch_tab_settings' &&
    request.command.patch.pendingRevertAttachmentPath != null
  ) {
    unsupportedHostPathFallthroughs += 1;
    return commandPort();
  }
  const filePath = commandFilePath(request.command);
  let fileRef: ChatFileRef | undefined;
  if (filePath) {
    let roots: FileTreeRoot[];
    try {
      roots = (
        await listFileTreeRoots({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
        })
      ).roots;
    } catch {
      unavailableFileRootsFallthroughs += 1;
      return commandPort();
    }
    fileRef = await resolveFileRef(filePath, roots);
    if (!fileRef) {
      outOfRootPathFallthroughs += 1;
      return commandPort();
    }
  }
  const capture: ChatCommandCapture = {
    request,
    fileRef,
    releaseAdmission,
    executionOptions: options.executionOptions,
  };
  try {
    return await commandCapture.run(capture, async () => {
      if (options.isShuttingDown?.()) return commandPort();
      const params = commandRoute.toParams(request.command, request);
      const schema =
        commandRoute.instruction === 'core.chat.create'
          ? CoreChatCreateParamsSchema
          : commandRoute.instruction === 'core.chat.update'
            ? CoreChatUpdateParamsSchema
            : commandRoute.instruction === 'core.chat.archive'
              ? CoreChatArchiveParamsSchema
              : commandRoute.instruction === 'core.chat.delete'
                ? CoreChatDeleteParamsSchema
                : commandRoute.instruction === 'core.chat.fork'
                  ? CoreChatForkParamsSchema
                  : undefined;
      if (schema && !schema.safeParse(params).success) {
        incompatibleLegacyPayloadFallthroughs += 1;
        return commandPort();
      }
      const canonicalResult = await options.instruction(
        commandRoute.instruction,
        params,
        {
          caller: options.caller,
          metadata: { idempotencyKey: request.commandId },
        },
      );
      return commandRoute.toLegacyResult(canonicalResult, undefined);
    });
  } catch (error) {
    if (
      options.isShuttingDown?.() &&
      error instanceof CanopyOperationError &&
      (error.payload.kind === 'unavailable' ||
        error.payload.kind === 'cancelled')
    ) {
      return capture.portResult ?? options.port.command(request);
    }
    if (
      error instanceof CanopyOperationError &&
      error.runtimeCause instanceof Error
    ) {
      throw error.runtimeCause;
    }
    throw error;
  }
}

export interface CoreChatSettingsTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

interface CoreChatSettingsCommand {
  commandId: string;
  target: CoreChatSettingsTarget;
  expectedRevision?: number;
  expectedTabRevision?: number;
  origin?: 'desktop' | 'portal';
}

/** A plan, thinking or speed change from a core client (CAN-4110 D3). At least one is set. */
export interface CoreChatSettingsChange extends CoreChatSettingsCommand {
  planMode?: boolean;
  thinkingLevel?: ThinkingLevel;
  speed?: CodexSpeed;
}

/** A model change from a core client (CAN-4110 D5). */
export interface CoreChatModelChange extends CoreChatSettingsCommand {
  model: ChatModel;
  executionHarness?: ModelHarness;
  notice?: ChatModelChangeNotice;
}

/** Runs a settings change end to end: commit through `port`, then live-session effects. */
export interface CoreChatSettingsHost {
  applySettings(
    change: CoreChatSettingsChange,
    port: ChatStateCommandPort,
  ): Promise<ChatCommandResult>;
  changeModel(
    change: CoreChatModelChange,
    port: ChatStateCommandPort,
  ): Promise<ChatCommandResult>;
}

let installedSettingsHost: CoreChatSettingsHost | null = null;

/** Installed by main's chat IPC registration; null until then. */
export function setCoreChatSettingsHost(
  host: CoreChatSettingsHost | null,
): void {
  installedSettingsHost = host;
}

type ClientSettingsAction =
  | {
      kind: 'settings';
      tabId: string;
      planMode?: boolean;
      thinkingLevel?: ThinkingLevel;
      speed?: CodexSpeed;
    }
  | {
      kind: 'model';
      tabId: string;
      model: ChatModel;
      executionHarness?: ModelHarness;
      notice?: ChatModelChangeNotice;
    }
  | null;

const CLIENT_MODEL_CHANGE_KEYS = new Set([
  'type',
  'tabId',
  'model',
  'providerType',
  'executionHarness',
  'notice',
]);
const ORCHESTRATED_SETTINGS_KEYS = new Set([
  'planMode',
  'thinkingLevel',
  'modelConfig',
]);
// The bound `validateChatCommandRequest` applies to `command.model`.
const MAX_MODEL_LENGTH = 512 * 1024;

function isModelChangeNotice(value: unknown): value is ChatModelChangeNotice {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    typeof value.text === 'string'
  );
}

/** Throws `invalid_argument` for a mixed, contradictory or main-only settings action. */
function classifyClientSettingsAction(action: unknown): ClientSettingsAction {
  if (!isRecord(action) || typeof action.tabId !== 'string') return null;
  if (action.type === 'chat.set_model') {
    if (Object.keys(action).some((key) => !CLIENT_MODEL_CHANGE_KEYS.has(key)))
      throw canopyInvalidArgumentError(
        'Model changes from a client carry only the model and harness.',
      );
    const { model, executionHarness, notice } = action;
    if (
      typeof model !== 'string' ||
      model.length === 0 ||
      model.length > MAX_MODEL_LENGTH ||
      (executionHarness !== undefined && !isModelHarness(executionHarness)) ||
      (notice !== undefined && !isModelChangeNotice(notice))
    )
      throw canopyInvalidArgumentError('Invalid model change.');
    return {
      kind: 'model',
      tabId: action.tabId,
      model,
      ...(executionHarness === undefined ? {} : { executionHarness }),
      ...(notice === undefined ? {} : { notice }),
    };
  }
  if (action.type !== 'chat.patch_tab_settings' || !isRecord(action.patch))
    return null;
  const patch = action.patch;
  const keys = Object.keys(patch);
  if (!keys.some((key) => ORCHESTRATED_SETTINGS_KEYS.has(key))) return null;
  if (
    keys.some((key) => !ORCHESTRATED_SETTINGS_KEYS.has(key)) ||
    action.fileRef !== undefined ||
    action.expectedPendingPlanExitRequestId !== undefined ||
    action.expectedPluginSelections !== undefined
  )
    throw canopyInvalidArgumentError(
      'Change model, thinking, plan and speed settings on their own.',
    );
  const modelConfig = isRecord(patch.modelConfig)
    ? patch.modelConfig
    : undefined;
  const directThinking = patch.thinkingLevel;
  const configThinking = modelConfig?.thinkingLevel;
  if (
    directThinking !== undefined &&
    configThinking !== undefined &&
    directThinking !== configThinking
  )
    throw canopyInvalidArgumentError(
      'Two different thinking levels were requested.',
    );
  const thinkingLevel = directThinking ?? configThinking;
  if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel))
    throw canopyInvalidArgumentError('Unsupported thinking level.');
  const requestedSpeed = modelConfig?.speed;
  if (requestedSpeed !== undefined && !isCodexSpeed(requestedSpeed))
    throw canopyInvalidArgumentError('Unsupported Codex speed.');
  const fastMode = modelConfig?.fastMode;
  const speed =
    requestedSpeed ??
    (typeof fastMode === 'boolean'
      ? codexSpeedFromFastMode(fastMode)
      : undefined);
  if (
    requestedSpeed !== undefined &&
    typeof fastMode === 'boolean' &&
    fastMode !== codexSpeedFastMode(requestedSpeed)
  )
    throw canopyInvalidArgumentError('Codex fast mode contradicts the speed.');
  const planMode =
    typeof patch.planMode === 'boolean' ? patch.planMode : undefined;
  if (
    planMode === undefined &&
    thinkingLevel === undefined &&
    speed === undefined
  )
    throw canopyInvalidArgumentError('Nothing to change.');
  return {
    kind: 'settings',
    tabId: action.tabId,
    ...(planMode === undefined ? {} : { planMode }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(speed === undefined ? {} : { speed }),
  };
}

interface ChatLifecycleParams {
  projectId: string;
  worktreeId: string;
  commandId: string;
  origin?: ChatCommandRequest['origin'];
  expectedRevision?: number;
  expectedTabRevision?: number;
  action: unknown;
  _meta: { idempotencyKey: string };
}

export function createCoreChatCommandAdapter(
  getPort: () => ChatStateCommandPort | null,
  getSettingsHost: () => CoreChatSettingsHost | null = () =>
    installedSettingsHost,
  fingerprints = new ChatCommandKeyFingerprints(),
): {
  instructions: {
    'core.chat.create': (
      params: unknown,
    ) => Promise<ReturnType<typeof CoreChatLifecycleResultSchema.parse>>;
    'core.chat.update': (
      params: unknown,
    ) => Promise<ReturnType<typeof CoreChatLifecycleResultSchema.parse>>;
    'core.chat.archive': (
      params: unknown,
    ) => Promise<ReturnType<typeof CoreChatLifecycleResultSchema.parse>>;
    'core.chat.delete': (
      params: unknown,
    ) => Promise<ReturnType<typeof CoreChatLifecycleResultSchema.parse>>;
    'core.chat.fork': (
      params: unknown,
    ) => Promise<ReturnType<typeof CoreChatLifecycleResultSchema.parse>>;
  };
} {
  const execute = async (
    operation: CanopyInstructionName,
    params: ChatLifecycleParams,
  ): Promise<ReturnType<typeof CoreChatLifecycleResultSchema.parse>> => {
    if (params._meta.idempotencyKey !== params.commandId) {
      throw canopyInvalidArgumentError(
        'Chat command ID and idempotency key must match.',
      );
    }
    const release = fingerprints.claim(
      { projectId: params.projectId, worktreeId: params.worktreeId },
      params.commandId,
      operation,
      params,
    );
    try {
      return await executeClaimed(params);
    } catch (error) {
      release();
      throw error;
    }
  };
  const executeClaimed = async (
    params: ChatLifecycleParams,
  ): Promise<ReturnType<typeof CoreChatLifecycleResultSchema.parse>> => {
    const port = getPort();
    if (!port)
      throw canopyUnavailableError('Chat state is unavailable.', {
        kind: 'same_idempotency_key',
      });
    const capture = commandCapture.getStore();
    const captured = capture?.request;
    if (
      captured?.commandId === params.commandId &&
      captured.projectId === params.projectId &&
      captured.worktreeId === params.worktreeId &&
      isDeepStrictEqual(
        params,
        CHAT_COMMAND_ROUTES[captured.command.type]?.toParams(
          captured.command,
          captured,
        ),
      )
    ) {
      const result = capture?.executionOptions
        ? port.command(captured, capture.executionOptions)
        : port.command(captured);
      if (capture) {
        capture.portResult = result;
        capture.releaseAdmission?.();
      }
      return CoreChatLifecycleResultSchema.parse(await result);
    }
    // Approval mode changes only through main's trusted dispatch (the capture
    // above), which the approval-mode setter uses to order the write against
    // the live runtimes.
    if (
      isRecord(params.action) &&
      params.action.type === 'chat.set_approval_mode'
    ) {
      throw canopyPermissionDeniedError(
        'Approval mode changes only through the approval-mode setter.',
      );
    }
    const settings = classifyClientSettingsAction(params.action);
    if (settings) {
      try {
        validateId(params.projectId, 'projectId');
        validateId(params.worktreeId, 'worktreeId');
        validateId(settings.tabId, 'tabId');
      } catch (error) {
        throw canopyInvalidArgumentError(
          error instanceof Error ? error.message : 'Invalid chat id.',
        );
      }
      const host = getSettingsHost();
      if (!host)
        throw canopyUnavailableError('Chat settings are unavailable.', {
          kind: 'same_idempotency_key',
        });
      const command = {
        commandId: params.commandId,
        target: {
          projectId: params.projectId,
          worktreeId: params.worktreeId,
          chatId: settings.tabId,
        },
        ...(params.expectedRevision === undefined
          ? {}
          : { expectedRevision: params.expectedRevision }),
        ...(params.expectedTabRevision === undefined
          ? {}
          : { expectedTabRevision: params.expectedTabRevision }),
        ...(params.origin === undefined ? {} : { origin: params.origin }),
      };
      const result =
        settings.kind === 'model'
          ? await host.changeModel(
              {
                ...command,
                model: settings.model,
                ...(settings.executionHarness === undefined
                  ? {}
                  : { executionHarness: settings.executionHarness }),
                ...(settings.notice === undefined
                  ? {}
                  : { notice: settings.notice }),
              },
              port,
            )
          : await host.applySettings(
              {
                ...command,
                ...(settings.planMode === undefined
                  ? {}
                  : { planMode: settings.planMode }),
                ...(settings.thinkingLevel === undefined
                  ? {}
                  : { thinkingLevel: settings.thinkingLevel }),
                ...(settings.speed === undefined
                  ? {}
                  : { speed: settings.speed }),
              },
              port,
            );
      return CoreChatLifecycleResultSchema.parse(result);
    }
    const action = await restoreLegacyAction(params.action, params);
    let reconstructed: ChatCommandRequest;
    try {
      reconstructed = validateChatCommandRequest(
        {
          schemaVersion: 1,
          commandId: params.commandId,
          projectId: params.projectId,
          worktreeId: params.worktreeId,
          ...(params.expectedRevision === undefined
            ? {}
            : { expectedRevision: params.expectedRevision }),
          ...(params.expectedTabRevision === undefined
            ? {}
            : { expectedTabRevision: params.expectedTabRevision }),
          command: action,
        },
        { allowMainOnlyFields: true },
      );
    } catch (error) {
      throw canopyInvalidArgumentError(
        error instanceof Error ? error.message : 'Invalid chat command.',
      );
    }
    return CoreChatLifecycleResultSchema.parse(
      await port.command({
        ...reconstructed,
        ...(params.origin === undefined ? {} : { origin: params.origin }),
      }),
    );
  };
  return {
    instructions: {
      'core.chat.create': (params: unknown) =>
        execute('core.chat.create', CoreChatCreateParamsSchema.parse(params)),
      'core.chat.update': (params: unknown) =>
        execute('core.chat.update', CoreChatUpdateParamsSchema.parse(params)),
      'core.chat.archive': (params: unknown) =>
        execute('core.chat.archive', CoreChatArchiveParamsSchema.parse(params)),
      'core.chat.delete': (params: unknown) =>
        execute('core.chat.delete', CoreChatDeleteParamsSchema.parse(params)),
      'core.chat.fork': (params: unknown) =>
        execute('core.chat.fork', CoreChatForkParamsSchema.parse(params)),
    },
  };
}

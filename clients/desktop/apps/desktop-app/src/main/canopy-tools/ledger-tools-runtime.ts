import {
  LEDGER_GRANTS,
  type CanopyCallerDescriptor,
  type LedgerContainer,
  type LedgerGlobalOwner,
} from '@canopy/protocol/canopy-core';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  COWORK_WORKSPACE_FILE_ROOT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import {
  LedgerChatToolsSession,
  type LedgerChatScope,
  type LedgerChatTarget,
  type LedgerChatToolsSessionOptions,
  type LedgerDelegateCaller,
  type LedgerHarness,
  type LedgerPipelineAgentCaller,
  type LedgerToolsDispatcher,
  type LedgerToolsHost,
} from '@canopy/execution-engine/node/ledger-tools/runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { getFeatureFlagService } from '../feature-flags';
import { readLedgerContainerLiveChats } from '../ledger/actor-directory';
import { getLedgerCallerBindingRegistry } from '../ledger/caller-bindings';
import { ledgerDatabaseMayExist } from '../ledger/lifecycle';
import { isSafeLedgerContainerId } from '../ledger/lifecycle-containers';
import { resolveLedgerContainerCreatedAt } from '../ledger/scope-bindings';
import {
  peekPreferencesLoadError,
  readPreferencesFile,
} from '../lib/preferences-store';
import { getWorkspaceType } from '../lib/workspace-registry';
import { buildLedgerToolPrompt, type LedgerToolNames } from './prompting';
import { agentCoreOperations } from './agent-core-operations';

export {
  LedgerChatToolsSession,
  executeLedgerInjectedTool,
  ledgerUnavailableResult,
  type LedgerChatScope,
  type LedgerChatSettings,
  type LedgerChatTarget,
  type LedgerChatToolsSessionOptions,
  type LedgerDelegateCaller,
  type LedgerDelegateParent,
  type LedgerDelegationFeedEntrySnapshot,
  type LedgerDelegationFeedRuntime,
  type LedgerDelegationFeedSearch,
  type LedgerDelegationFeedUpdate,
  type LedgerDelegationFeedValidation,
  type LedgerHarness,
  type LedgerPipelineAgentCaller,
  type LedgerToolInvocation,
  type LedgerToolKey,
  type LedgerToolsBindingRegistry,
  type LedgerToolsDispatcher,
  type LedgerToolsHost,
  type LedgerToolsRuntime,
  type LedgerToolsUnavailableReason,
} from '@canopy/execution-engine/node/ledger-tools/runtime';

/*
 * The desktop host of the Agent Ledger tools for chat sessions (native Code
 * and Cowork chats, Cursor, the Claude Code terminal and App Advisor), for
 * the runs of managed delegates and for the attempts of desktop-run pipeline
 * agents: the exposure gate, the desktop's caller, dispatcher and prompt,
 * and the session openers. The tools runtime itself is shared
 * (`@canopy/execution-engine/node/ledger-tools/runtime`).
 *
 * Every call goes through the desktop dispatcher (`core.ledger.*`) as a
 * trusted in-process host caller.
 */

/**
 * App-managed chats without a Ledger scope in v1 (LD07). App Advisor chats
 * have one: their Work Entry.
 */
const NON_LEDGER_PROJECT_IDS: ReadonlySet<string> = new Set([
  STANDALONE_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
]);

let boundDispatcher: LedgerToolsDispatcher | null = null;

/** The host supplies the already-running desktop dispatcher, or null at shutdown. */
export function bindLedgerToolsDispatcher(
  dispatcher: LedgerToolsDispatcher | null,
): void {
  boundDispatcher = dispatcher;
}

function isLedgerFlagEnabled(): boolean {
  try {
    return getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key,
    );
  } catch {
    return false;
  }
}

/**
 * Fails closed on a degraded read. When the preferences file is corrupt,
 * unreadable or on an unsupported version, `readPreferencesFile()` returns
 * recovered or default preferences, where recording is on, so a person's
 * earlier "off" could silently come back. Until the app has shown the
 * recovery notice, recording stays off: the safeguard approval defaults use
 * (`approvalDefaultsFromPreferences`). A fresh install has no load error and
 * keeps the default.
 */
async function readAgentRecordingEnabled(): Promise<boolean> {
  try {
    const preferences = await readPreferencesFile();
    if (peekPreferencesLoadError() !== null) return false;
    return preferences.ledgerAgentRecordingEnabled !== false;
  } catch {
    return false;
  }
}

async function readChatTitle(
  container: LedgerContainer,
  chatId: string,
): Promise<string | null> {
  const chats = await readLedgerContainerLiveChats(container);
  return chats.find((chat) => chat.chatId === chatId)?.title ?? null;
}

export const DESKTOP_LEDGER_TOOLS_HOST: LedgerToolsHost = {
  dispatcher: (): LedgerToolsDispatcher | null => boundDispatcher,
  agentDispatcher: (dispatcher) => agentCoreOperations('ledger', dispatcher),
  caller: callerFor,
  systemPrompt: (options) => ledgerToolPromptFor(options),
  registry: getLedgerCallerBindingRegistry,
  isFlagEnabled: isLedgerFlagEnabled,
  isRecordingEnabled: readAgentRecordingEnabled,
  workspaceType: getWorkspaceType,
  containerCreatedAt: (container): Promise<string | null> =>
    resolveLedgerContainerCreatedAt(container),
  chatTitle: readChatTitle,
  databaseMayExist: ledgerDatabaseMayExist,
};

/**
 * The container a chat's Ledger tools bind to, from synchronous checks only:
 * a default-mode chat in a known code workspace (its worktree) or Cowork
 * workspace (its Work Entry), or an App Advisor chat (the Work Entry its
 * session started in, never the entry selected later). Other app-managed
 * chats get none in v1 (LD07).
 */
export function ledgerChatContainerFor(
  target: Pick<LedgerChatTarget, 'projectId' | 'worktreeId' | 'assistantMode'>,
  host: Pick<LedgerToolsHost, 'workspaceType'> = DESKTOP_LEDGER_TOOLS_HOST,
): LedgerContainer | null {
  if (target.projectId === APP_ADVISOR_PROJECT_ID) {
    return target.assistantMode === 'app-advisor' &&
      isSafeLedgerContainerId(target.worktreeId)
      ? {
          kind: 'advisor_entry',
          appWorkspaceId: APP_ADVISOR_PROJECT_ID,
          entryId: target.worktreeId,
        }
      : null;
  }
  if ((target.assistantMode ?? 'default') !== 'default') return null;
  if (NON_LEDGER_PROJECT_IDS.has(target.projectId)) return null;
  if (
    !isSafeLedgerContainerId(target.projectId) ||
    !isSafeLedgerContainerId(target.worktreeId)
  ) {
    return null;
  }
  switch (host.workspaceType(target.projectId)) {
    case 'cowork':
      return {
        kind: 'cowork_entry',
        workspaceId: target.projectId,
        entryId: target.worktreeId,
      };
    case 'single-repo':
    case 'multi-repo':
      return {
        kind: 'code_worktree',
        workspaceId: target.projectId,
        worktreeId: target.worktreeId,
      };
    case null:
      return null;
  }
}

/**
 * The synchronous half of the exposure gate: the flag, and a chat that can
 * have a Ledger scope. False means the session gets no Ledger tools without
 * any I/O; true still needs `resolveLedgerToolExposure`.
 */
export function mayExposeLedgerTools(
  target: LedgerChatTarget,
  host: LedgerToolsHost = DESKTOP_LEDGER_TOOLS_HOST,
): boolean {
  return host.isFlagEnabled() && ledgerChatContainerFor(target, host) !== null;
}

/**
 * The advertisement gate: `canopy-ledger-enabled`, the "Agents add to the
 * Feed" setting, and a resolvable scope binding (a known container with a
 * creation time). Null when any fails. Reads no Ledger storage.
 */
export async function resolveLedgerToolExposure(
  target: LedgerChatTarget,
  host: LedgerToolsHost = DESKTOP_LEDGER_TOOLS_HOST,
): Promise<LedgerChatScope | null> {
  try {
    if (!host.isFlagEnabled()) return null;
    const container = ledgerChatContainerFor(target, host);
    if (container === null) return null;
    if (!(await host.isRecordingEnabled())) return null;
    const containerCreatedAt = await host.containerCreatedAt(container);
    return containerCreatedAt === null
      ? null
      : { container, containerCreatedAt };
  } catch {
    return null;
  }
}

/**
 * The advertisement gate of a pipeline agent with no task, recording to its
 * run owner's global (workflow) Ledger: `canopy-ledger-enabled`, the "Agents
 * add to the Feed" setting, and the owner's global Ledger for the signed-in
 * account, which binding mints on first use. Null when any fails.
 */
export async function resolveLedgerGlobalToolExposure(
  owner: LedgerGlobalOwner,
  host: LedgerToolsHost = DESKTOP_LEDGER_TOOLS_HOST,
): Promise<LedgerChatScope | null> {
  try {
    if (!host.isFlagEnabled()) return null;
    if (!(await host.isRecordingEnabled())) return null;
    const container: LedgerContainer = { kind: 'global', owner };
    const containerCreatedAt = await host.containerCreatedAt(container);
    return containerCreatedAt === null
      ? null
      : { container, containerCreatedAt };
  } catch {
    return null;
  }
}

/**
 * The file root a session's working directory belongs to, for Ledger
 * reference files: the App Advisor or Cowork folder, the selected repository
 * of a multi-repository project, or the single repository.
 */
export function ledgerReferenceRootIdFor(
  target: LedgerChatTarget,
  container: LedgerContainer,
  selectedRepoId: string | undefined,
  host: LedgerToolsHost = DESKTOP_LEDGER_TOOLS_HOST,
): string {
  if (container.kind === 'advisor_entry') return APP_ADVISOR_PROJECT_ID;
  if (container.kind === 'cowork_entry') return COWORK_WORKSPACE_FILE_ROOT_ID;
  return host.workspaceType(target.projectId) === 'multi-repo'
    ? (selectedRepoId ?? WORKSPACE_ROOT_REPO_ID)
    : target.projectId;
}

/**
 * The Ledger block for the system prompt or developer instructions of a
 * session whose Ledger tools are exposed.
 */
export function ledgerToolPromptFor(options: {
  readonly target: LedgerChatTarget;
  readonly scope: LedgerChatScope;
  readonly harness: LedgerHarness;
  readonly toolNames?: LedgerToolNames;
  readonly selectedRepoId?: string;
  readonly delegate?: LedgerDelegateCaller;
  readonly pipelineAgent?: LedgerPipelineAgentCaller;
  readonly host?: LedgerToolsHost;
}): string {
  // A global (workflow) Ledger's entries reference no files.
  if (options.scope.container.kind === 'global') {
    return buildLedgerToolPrompt(options.harness, {
      ...(options.toolNames ? { toolNames: options.toolNames } : {}),
      planModeException: false,
      pipelineAgent: true,
      globalScope: true,
    });
  }
  return buildLedgerToolPrompt(options.harness, {
    referenceRootId: ledgerReferenceRootIdFor(
      options.target,
      options.scope.container,
      options.selectedRepoId,
      options.host,
    ),
    ...(options.toolNames ? { toolNames: options.toolNames } : {}),
    // Neither App Advisor, a managed delegate nor a pipeline agent has a
    // Plan mode, so their prompts need no exception.
    ...(options.scope.container.kind === 'advisor_entry' ||
    options.delegate !== undefined ||
    options.pipelineAgent !== undefined
      ? { planModeException: false }
      : {}),
    ...(options.delegate !== undefined ? { delegate: true } : {}),
    ...(options.pipelineAgent !== undefined ? { pipelineAgent: true } : {}),
  });
}

/** Session options a desktop opener takes: the host defaults to the desktop's. */
type DesktopLedgerSessionOptions = Omit<
  LedgerChatToolsSessionOptions,
  'scope' | 'host'
> & { readonly host?: LedgerToolsHost };

async function openLedgerToolsSession(
  options: DesktopLedgerSessionOptions,
): Promise<LedgerChatToolsSession | null> {
  const host = options.host ?? DESKTOP_LEDGER_TOOLS_HOST;
  const scope = await resolveLedgerToolExposure(options.target, host);
  return scope === null
    ? null
    : new LedgerChatToolsSession({ ...options, host, scope });
}

/** Opens a session's Ledger tools when the exposure gate passes. */
export function openLedgerChatTools(
  options: Omit<DesktopLedgerSessionOptions, 'delegate' | 'pipelineAgent'>,
): Promise<LedgerChatToolsSession | null> {
  return openLedgerToolsSession(options);
}

/**
 * Opens the Ledger tools of one managed delegate run when the same gate as
 * its root chat's passes: `canopy-ledger-enabled`, the "Agents add to the
 * Feed" setting, and a Ledger scope for the chat (`target`) the delegation
 * belongs to. Null otherwise, so the child gets no Ledger tools.
 */
export function openLedgerDelegateTools(
  options: Omit<DesktopLedgerSessionOptions, 'delegate' | 'pipelineAgent'> & {
    readonly delegate: LedgerDelegateCaller;
  },
): Promise<LedgerChatToolsSession | null> {
  return openLedgerToolsSession(options);
}

/**
 * Opens the Ledger tools of one pipeline agent attempt when the gate passes:
 * `canopy-ledger-enabled`, the "Agents add to the Feed" setting and a Ledger
 * scope. An execution with a worktree records to it (`target`; its chat ID
 * only labels the route), and only code worktrees qualify; one without
 * (`globalOwner` set: a global or directory run) records to its owner's
 * global (workflow) Ledger. Null otherwise, and the step then runs without
 * Ledger tools.
 */
export async function openLedgerPipelineAgentTools(
  options: Omit<DesktopLedgerSessionOptions, 'delegate' | 'pipelineAgent'> & {
    readonly pipelineAgent: LedgerPipelineAgentCaller;
    /** The run's owner, for an execution without a worktree. */
    readonly globalOwner?: LedgerGlobalOwner;
  },
): Promise<LedgerChatToolsSession | null> {
  const { globalOwner, ...session } = options;
  const host = options.host ?? DESKTOP_LEDGER_TOOLS_HOST;
  if (globalOwner !== undefined) {
    const scope = await resolveLedgerGlobalToolExposure(globalOwner, host);
    return scope === null
      ? null
      : new LedgerChatToolsSession({ ...session, host, scope });
  }
  const scope = await resolveLedgerToolExposure(options.target, host);
  return scope === null || scope.container.kind !== 'code_worktree'
    ? null
    : new LedgerChatToolsSession({ ...session, host, scope });
}

function callerFor(bindingId: string): CanopyCallerDescriptor {
  return {
    principalId: bindingId,
    clientInstanceId: 'desktop-main',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    // A trusted in-process host call, as other main-process callers make;
    // the agent's own transport (MCP or Codex dynamic tools) stays upstream.
    interfaceKind: 'daemon',
    grants: [LEDGER_GRANTS.read, LEDGER_GRANTS.write],
  };
}

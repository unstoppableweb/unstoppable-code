import {
  AgentPortError,
  type AgentActionCall,
  type AgentActionErrorCode,
  type AgentChatDetail,
  type AgentEnvironmentPort,
  type AgentModelList,
  type AgentStartChatInput,
} from '@canopy/agent-actions';
import type {
  CanopyCallerDescriptor,
  CanopyGrantName,
  CanopyQueryResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import path from 'node:path';
import {
  inheritedDenyRules,
  isApprovalPolicyWithin,
  isRootWithin,
  startedChatApprovalMode,
  withDeniesOf,
} from '../approvals/approval-policy-dominance';
import type {
  ApprovalPolicySource,
  EffectiveApprovalPolicy,
} from '../approvals/effective-approval-policy';
import {
  callerBoundingApprovalMode,
  callerBoundingSessionApprovalRules,
  isApprovalModeDowngrade,
  reachableApprovalMode,
} from '../approvals/live-approval-modes';
import {
  FAIL_CLOSED_APPROVAL_MODE,
  type ApprovalMode,
  type ApprovalRule,
  type ClaudeTerminalTurnState,
} from '@canopy/desktop-shared/types';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { getDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  getApprovalSettingsRevision,
  getChatApprovalStateRevision,
} from '../approvals/rule-revisions';
import {
  type ChatSendAdmissionCheck,
  type ChatSendAdmissionTab,
} from '../services/chat-send-admission';
import {
  claudeTerminalTurnStates,
  isTerminalDrivenChat,
} from '../lib/terminal-driven-chat';

type DesktopAgentActionCall = AgentActionCall<CanopyInjectedToolRuntime>;

/** The registered operations the desktop port reaches through the dispatcher. */
export type DesktopEnvironmentRuntime = Pick<
  DesktopCanopyDispatcher,
  'query' | 'instruction'
>;

/**
 * The host services the desktop port composes. Registered reads and chat
 * writes go through `runtime`; the rest are retained paths that have no
 * registered operation yet.
 */
export interface DesktopEnvironmentPortDeps {
  runtime(): DesktopEnvironmentRuntime;
  /** The model catalog for the owner of the calling chat's work. */
  listModels(call: DesktopAgentActionCall): Promise<AgentModelList>;
  /**
   * The Work Entries of a Cowork workspace, in their persisted order. Each
   * is a chat container, addressed as the worktree of its chats.
   */
  listWorkEntries(workspaceId: string): Promise<readonly DesktopWorkEntry[]>;
  /**
   * The approval policy an existing chat's turns run with: its mode, resolved
   * as the send path resolves it (its tab's mode or the persisted defaults,
   * clamped to the mode of its live turn), and its session grants.
   */
  chatApprovalPolicy(
    chat: { workspaceId: string; worktreeId: string; chatId: string },
    call: DesktopAgentActionCall,
  ): Promise<DesktopChatApprovalPolicy>;
  /**
   * Everything the approval session of the chat `source` describes applies,
   * every rule tier included and file paths absolute in its root
   * (`effectiveApprovalPolicy`). Undefined when any part cannot be known.
   */
  effectiveApprovalPolicy(
    source: ApprovalPolicySource,
    call: DesktopAgentActionCall,
  ): Promise<EffectiveApprovalPolicy | undefined>;
  /** The approval mode a new chat in this worktree or Work Entry starts in. */
  newChatApprovalMode(
    worktree: { workspaceId: string; worktreeId: string },
    call: DesktopAgentActionCall,
  ): Promise<ApprovalMode>;
  /**
   * A chat's approval mode as of now, from the in-memory registry a mode
   * switch updates before it awaits anything. As a `bound` (the calling
   * chat), the strictest of `mode`, its live mode, a pending switch, and the
   * mode its live session applied; as a `reach` (a chat about to run), the
   * looser of `mode` and a pending switch. Synchronous, so no switch lands
   * between a check and the write it guards.
   */
  liveApprovalMode(
    chat: { workspaceId: string; worktreeId: string; chatId: string },
    mode: ApprovalMode,
    use: 'bound' | 'reach',
  ): ApprovalMode;
  /**
   * The calling chat's session rules `rules`, narrowed to the rules its live
   * session applies when it reports them, so an admitted turn's agent is
   * bounded by what that turn applied. Never wider than `rules`.
   */
  callerSessionApprovalRules(
    chat: { workspaceId: string; worktreeId: string; chatId: string },
    rules: readonly ApprovalRule[],
  ): readonly ApprovalRule[];
  /**
   * A revision of the approval settings every chat's policy reads beyond its
   * own tab: rule tiers, workspace approvals, and default modes. It changes
   * with any of them, so a policy read after one revision still holds while
   * the revision does. Synchronous.
   */
  approvalSettingsRevision(): number;
  /**
   * A chat's approval-state revision: it changes whenever a commit changes
   * the chat's tab mode, session grants, or selected repository. Synchronous.
   */
  chatApprovalStateRevision(chat: {
    workspaceId: string;
    worktreeId: string;
    chatId: string;
  }): number;
  /**
   * The directory a chat in this worktree or Work Entry runs in with this
   * selected repository, which its approval session uses as its root.
   * Undefined when it does not resolve.
   */
  chatExecutionRoot(chat: {
    workspaceId: string;
    worktreeId: string;
    selectedRepoId?: string;
  }): Promise<string | undefined>;
  /**
   * The chats among `chatIds` in one worktree or Work Entry whose managed
   * Claude Code terminal drives their turns. Their permissions come from the
   * terminal session rather than the chat's approval policy, so agents
   * cannot message them.
   */
  terminalDrivenChatIds(
    scope: { workspaceId: string; worktreeId: string },
    chatIds: readonly string[],
  ): Promise<readonly string[]>;
  /** A synchronous reader of chats' live Claude Code terminal turn states. */
  terminalTurnStates(): Promise<
    (chat: {
      workspaceId: string;
      worktreeId: string;
      chatId: string;
    }) => ClaudeTerminalTurnState | undefined
  >;
}

/** A rule target with a path a chat's root anchors. */
function hasPathTarget(target: ApprovalRule['target']): boolean {
  return (
    target.kind === 'file-write' ||
    (target.kind === 'browser-upload' && target.path !== undefined)
  );
}

/** A new worktree for a started chat, or why none was created (CAN-5830). */
export type DesktopChatWorktreeResult =
  | { ok: true; worktreeId: string }
  | {
      ok: false;
      code: 'surface_unavailable' | 'execution_failed';
      message: string;
      retryable: boolean;
    };

/** The refusal of an agent message to a terminal-driven chat. */
export function terminalChatRefusal(chatId: string): string {
  return `Chat ${chatId} runs in a Claude Code terminal, which agents cannot message yet.`;
}

/** The settings a chat's approval session is created with. */
export interface DesktopChatApprovalPolicy {
  mode: ApprovalMode;
  /** The mode the chat's tab sets; absent when its mode is the default. */
  tabMode?: ApprovalMode;
  sessionRules: readonly ApprovalRule[];
  /** The directory the chat runs in, its session's root. */
  root?: string;
  /** The repository the chat's tab selects, which its root resolves with. */
  selectedRepoId?: string;
}

/** What a started chat's policy derives from, read afresh for each step. */
interface StartContext {
  caller: DesktopChatApprovalPolicy;
  defaultMode: ApprovalMode;
  /** Where the started chat runs, resolved as its approval session will. */
  root: string | undefined;
  /** The root it may run within. */
  bound: string | undefined;
  /**
   * What the started chat is checked against: the calling chat's effective
   * policy as it applies where the started chat runs (in a new worktree,
   * carried to the same scope there), plus the calling chat's own denies.
   */
  boundPolicy: EffectiveApprovalPolicy | undefined;
  /** The started chat's session denies: the caller's, absolute. */
  denies: readonly ApprovalRule[];
  /** The started chat's effective policy with those denies. */
  startedPolicy: EffectiveApprovalPolicy | undefined;
}

function withMode(
  policy: EffectiveApprovalPolicy | undefined,
  mode: ApprovalMode,
): EffectiveApprovalPolicy | undefined {
  return policy && { ...policy, mode };
}

/**
 * A root agent message's approval admission: the check the chat state owner
 * runs as the message commits, and, after it refused, why.
 */
export interface DesktopAgentMessageAdmission {
  check: ChatSendAdmissionCheck;
  /** The refusal of the last failed check, or undefined if none failed. */
  refusal(): AgentPortError | undefined;
}

/** The desktop environment port, plus the admission root agent sends share. */
export interface DesktopEnvironmentPort extends AgentEnvironmentPort<CanopyInjectedToolRuntime> {
  agentMessageAdmission(
    targetChat: { workspaceId: string; worktreeId: string; chatId: string },
    call: DesktopAgentActionCall,
    sent?: ChatSendAdmissionTab,
  ): Promise<DesktopAgentMessageAdmission>;
  /**
   * The approval mode a chat a root agent creates in this task starts in.
   * With a first message, refuses first a chat that message's admission
   * would refuse.
   */
  agentChatStartAdmission(
    task: { workspaceId: string; worktreeId: string },
    firstMessage: boolean,
    call: DesktopAgentActionCall,
    newWorktree?: boolean,
  ): Promise<{ approvalMode: ApprovalMode; selectedRepoId?: string }>;
  /**
   * Refuses, before anything is created, a first message the calling chat
   * could not start a chat with: one carrying session deny rules, which a
   * new chat does not start with.
   */
  agentChatStartPrecheck(
    targetWorkspaceId: string,
    call: DesktopAgentActionCall,
  ): Promise<void>;
  /**
   * Admits again the first message of a chat the calling chat started in a
   * new worktree, as its start admitted it. Throws its refusal.
   */
  agentStartedChatMessageAdmission(
    target: { workspaceId: string; worktreeId: string; chatId: string },
    call: DesktopAgentActionCall,
  ): Promise<void>;
}

/** What a send is admitted against, read before it is sent. */
interface SendAdmissionGuard {
  targetPolicy: DesktopChatApprovalPolicy;
  settingsRevision: number;
  callerRevision: number | undefined;
  contained: () => boolean;
  /** Why `contained` refuses now. */
  refusal: () => string;
}

const APPROVAL_MODE_NAMES: Readonly<Record<ApprovalMode, string>> = {
  ask: 'Ask',
  auto: 'Auto',
  'full-access': 'Full Access',
};

/**
 * Why a message to chat `chatId` is refused: a policy that could not be read
 * in full, a mode broader than the calling chat's, or grants and denies the
 * two chats do not share.
 */
function containmentRefusal(
  chatId: string,
  state:
    | { unreadable: 'caller' | 'target' }
    | { target: ApprovalMode; bound: ApprovalMode },
): string {
  if ('unreadable' in state) {
    return state.unreadable === 'caller'
      ? `This chat's tool approvals could not be read in full, so it cannot message chat ${chatId}. A rule, setting or folder they depend on could not be resolved.`
      : `Chat ${chatId}'s tool approvals could not be read in full, so this chat cannot message it. A rule, setting or folder they depend on could not be resolved.`;
  }
  if (isApprovalModeDowngrade(state.target, state.bound)) {
    return `Chat ${chatId} can run in ${APPROVAL_MODE_NAMES[state.target]}, but this chat is limited to ${APPROVAL_MODE_NAMES[state.bound]} now, so this chat cannot message it.`;
  }
  return `Chat ${chatId} holds tool approvals this chat doesn't, or lacks a deny rule this chat has, so this chat cannot message it.`;
}

/** Whether a chat's canonical tab still holds the policy read from it. */
function tabHoldsPolicy(
  tab: ChatSendAdmissionTab,
  policy: DesktopChatApprovalPolicy,
): boolean {
  return (
    (tab.approvalMode || undefined) === policy.tabMode &&
    (tab.selectedRepoId || undefined) === policy.selectedRepoId &&
    JSON.stringify(tab.sessionApprovalRules ?? []) ===
      JSON.stringify(policy.sessionRules)
  );
}

export interface DesktopWorkEntry {
  entryId: string;
  title: string;
  createdAt: string;
}

const READ_GRANTS: CanopyGrantName[] = [
  'core.workspace.read',
  'core.worktree.read',
  'core.chat.read',
];
const PAGE_SIZE = 100;

/** The caller every agent action presents to the desktop dispatcher. */
export function agentActionCaller(
  call: DesktopAgentActionCall,
  grants: CanopyGrantName[],
): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: `agent-action:${call.scope?.chatId ?? 'unscoped'}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'mcp',
    grants,
  };
}

const ERROR_CODES: Partial<
  Record<CanopyOperationError['payload']['kind'], AgentActionErrorCode>
> = {
  invalid_argument: 'invalid_payload',
  not_found: 'not_found',
  permission_denied: 'authorization_conflict',
  unauthenticated: 'authentication_failed',
  conflict: 'stale_ui_state',
  failed_precondition: 'invalid_target',
  capability_unavailable: 'missing_capability',
  deadline_exceeded: 'timeout',
  unavailable: 'surface_unavailable',
  resource_exhausted: 'quota_exceeded',
};

/** A dispatcher failure as a port error the family reports. */
export function toAgentPortError(error: unknown): unknown {
  if (!(error instanceof CanopyOperationError)) return error;
  const code = ERROR_CODES[error.payload.kind];
  if (!code) return error;
  return new AgentPortError(
    code,
    error.payload.message,
    error.payload.retry.kind !== 'never',
  );
}

async function viaDispatcher<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toAgentPortError(error);
  }
}

function textOfBlocks(blocks: readonly unknown[]): string {
  return blocks
    .flatMap((block) =>
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string'
        ? [block.text]
        : [],
    )
    .join('\n')
    .trim();
}

type ChatListItem = CanopyQueryResult<'core.chat.list'>['items'][number];

/** Metadata-only lookup shared with transcript authorization; never loads lastResponse. */
export function createDesktopChatMetadataLookup(
  deps: Pick<DesktopEnvironmentPortDeps, 'runtime' | 'listWorkEntries'>,
): {
  findChatInWorktree(
    this: void,
    scope: { workspaceId: string; worktreeId: string },
    chatId: string,
    call: DesktopAgentActionCall,
  ): Promise<ChatListItem | null>;
  findChat(
    this: void,
    workspaceId: string,
    chatId: string,
    call: DesktopAgentActionCall,
  ): Promise<ChatListItem | null>;
  coworkEntries(
    this: void,
    workspaceId: string,
    call: DesktopAgentActionCall,
    requireWorkspace?: boolean,
  ): Promise<readonly DesktopWorkEntry[] | null>;
  isCoworkWorkspace(
    this: void,
    workspaceId: string,
    call: DesktopAgentActionCall,
    requireWorkspace?: boolean,
  ): Promise<boolean>;
} {
  const readOptions = (
    call: DesktopAgentActionCall,
  ): { caller: CanopyCallerDescriptor } => ({
    caller: agentActionCaller(call, READ_GRANTS),
  });

  async function findChatInWorktree(
    scope: { workspaceId: string; worktreeId: string },
    chatId: string,
    call: DesktopAgentActionCall,
  ): Promise<ChatListItem | null> {
    let cursor: string | undefined;
    do {
      const page = await deps.runtime().query(
        'core.chat.list',
        {
          scope,
          pageSize: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
        readOptions(call),
      );
      const found = page.items.find((item) => item.chatId === chatId);
      if (found) return found;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return null;
  }

  /** Whether a workspace is a Cowork workspace; a missing one is not. */
  async function isCoworkWorkspace(
    workspaceId: string,
    call: DesktopAgentActionCall,
    requireWorkspace = false,
  ): Promise<boolean> {
    const workspace = await viaDispatcher(() =>
      deps
        .runtime()
        .query(
          'core.workspace.get',
          { scope: { workspaceId }, workspaceId },
          readOptions(call),
        ),
    ).catch((error: unknown) => {
      if (
        !requireWorkspace &&
        error instanceof AgentPortError &&
        error.code === 'not_found'
      ) {
        return null;
      }
      throw error;
    });
    return workspace?.kind === 'cowork';
  }

  /** The Work Entries of a Cowork workspace, or null for any other one. */
  async function coworkEntries(
    workspaceId: string,
    call: DesktopAgentActionCall,
    requireWorkspace = false,
  ): Promise<readonly DesktopWorkEntry[] | null> {
    return (await isCoworkWorkspace(workspaceId, call, requireWorkspace))
      ? deps.listWorkEntries(workspaceId)
      : null;
  }

  async function findChat(
    workspaceId: string,
    chatId: string,
    call: DesktopAgentActionCall,
  ): Promise<ChatListItem | null> {
    const runtime = deps.runtime();
    const worktreeIds: string[] = [];
    if (call.scope?.workspaceId === workspaceId) {
      worktreeIds.push(call.scope.worktreeId);
    }
    const entries = await coworkEntries(workspaceId, call);
    for (const entry of entries ?? []) {
      if (!worktreeIds.includes(entry.entryId)) worktreeIds.push(entry.entryId);
    }
    // A Cowork workspace's chats live in its Work Entries; a git
    // workspace's live in its worktrees.
    if (!entries) {
      let worktreeCursor: string | undefined;
      do {
        const page = await runtime.query(
          'core.worktree.list',
          {
            scope: { workspaceId },
            pageSize: PAGE_SIZE,
            ...(worktreeCursor ? { cursor: worktreeCursor } : {}),
          },
          readOptions(call),
        );
        for (const worktree of page.items) {
          if (!worktreeIds.includes(worktree.worktreeId)) {
            worktreeIds.push(worktree.worktreeId);
          }
        }
        worktreeCursor = page.nextCursor ?? undefined;
      } while (worktreeCursor);
    }
    for (const worktreeId of worktreeIds) {
      const found = await findChatInWorktree(
        { workspaceId, worktreeId },
        chatId,
        call,
      );
      if (found) return found;
    }
    return null;
  }

  return { findChat, findChatInWorktree, coworkEntries, isCoworkWorkspace };
}

/**
 * The environment port of desktop chats. Registered `core.*` reads and chat
 * writes run through the desktop dispatcher with an `mcp` caller. A started
 * chat is reserved through the chat state owner, in a worktree the renderer
 * bridge creates for `new_worktree`, then sent its first message through the
 * dispatcher, whose turn waits for any worktree setup.
 */
export function createDesktopEnvironmentPort(
  deps: DesktopEnvironmentPortDeps,
): DesktopEnvironmentPort {
  const readOptions = (
    call: DesktopAgentActionCall,
  ): { caller: CanopyCallerDescriptor } => ({
    caller: agentActionCaller(call, READ_GRANTS),
  });

  const { findChat } = createDesktopChatMetadataLookup(deps);

  async function lastResponse(
    chat: ChatListItem,
    call: DesktopAgentActionCall,
  ): Promise<string | undefined> {
    if (chat.worktreeId === null || chat.state === 'archived') return undefined;
    try {
      const page = await deps.runtime().query(
        'core.chat.transcript.page',
        {
          scope: {
            workspaceId: chat.workspaceId,
            worktreeId: chat.worktreeId,
            chatId: chat.chatId,
          },
        },
        readOptions(call),
      );
      const text = page.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => textOfBlocks(message.blocks))
        .filter(Boolean);
      return text[text.length - 1] || undefined;
    } catch {
      // The latest response is optional; the chat itself was found.
      return undefined;
    }
  }

  /**
   * The root a started chat may run in: the calling chat's root, or, in a
   * new worktree, the same repository scope inside it. Undefined when any
   * root does not resolve.
   */
  async function startedChatRootBound(
    callerPolicy: DesktopChatApprovalPolicy,
    worktree: { workspaceId: string; worktreeId: string },
    placement: AgentStartChatInput['placement'],
    call: DesktopAgentActionCall,
  ): Promise<string | undefined> {
    if (placement !== 'new_worktree') return callerPolicy.root;
    const scope = call.scope;
    if (!scope || !callerPolicy.root) return undefined;
    const [callerBase, targetBase] = await Promise.all([
      deps.chatExecutionRoot({
        workspaceId: scope.workspaceId,
        worktreeId: scope.worktreeId,
      }),
      deps.chatExecutionRoot(worktree),
    ]);
    if (
      !callerBase ||
      !targetBase ||
      !isRootWithin(callerBase, callerPolicy.root)
    ) {
      return undefined;
    }
    return path.join(targetBase, path.relative(callerBase, callerPolicy.root));
  }

  /** The effective policy of a chat with these approval settings. */
  function effectivePolicyOf(
    chat: { workspaceId: string; worktreeId: string },
    policy: DesktopChatApprovalPolicy,
    call: DesktopAgentActionCall,
  ): Promise<EffectiveApprovalPolicy | undefined> {
    return deps.effectiveApprovalPolicy(
      {
        projectId: chat.workspaceId,
        worktreeId: chat.worktreeId,
        mode: policy.mode,
        sessionRules: policy.sessionRules,
        ...(policy.root ? { workspaceRoot: policy.root } : {}),
      },
      call,
    );
  }

  /**
   * The destination's default mode, the calling chat's current policy, the
   * roots both resolve to, and the effective policies a start is checked
   * with. The calling chat is read after the default, as close as it can be
   * to the step that uses it.
   */
  async function startContext(
    worktree: { workspaceId: string; worktreeId: string },
    placement: AgentStartChatInput['placement'],
    call: DesktopAgentActionCall,
  ): Promise<StartContext> {
    const defaultMode = await deps.newChatApprovalMode(
      { workspaceId: worktree.workspaceId, worktreeId: worktree.worktreeId },
      call,
    );
    const caller = await callerApprovalPolicy(call);
    const selectedRepoId = caller.selectedRepoId;
    const [root, bound] = await Promise.all([
      deps.chatExecutionRoot({
        ...worktree,
        ...(selectedRepoId ? { selectedRepoId } : {}),
      }),
      startedChatRootBound(caller, worktree, placement, call),
    ]);
    const scope = call.scope;
    const [callerPolicy, carriedPolicy] = await Promise.all([
      scope ? effectivePolicyOf(scope, caller, call) : undefined,
      placement === 'new_worktree' && bound
        ? effectivePolicyOf(worktree, { ...caller, root: bound }, call)
        : undefined,
    ]);
    const boundPolicy =
      callerPolicy &&
      (placement === 'new_worktree'
        ? carriedPolicy && withDeniesOf(carriedPolicy, callerPolicy)
        : callerPolicy);
    const denies = boundPolicy
      ? inheritedDenyRules(
          ...(callerPolicy ? [callerPolicy] : []),
          ...(carriedPolicy ? [carriedPolicy] : []),
        )
      : [];
    const startedPolicy =
      boundPolicy && root
        ? await effectivePolicyOf(
            worktree,
            { mode: caller.mode, sessionRules: denies, root },
            call,
          )
        : undefined;
    return {
      caller,
      defaultMode,
      root,
      bound,
      boundPolicy,
      denies,
      startedPolicy,
    };
  }

  /** The calling chat's mode, clamped to a live or pending switch. */
  function liveCallerMode(
    mode: ApprovalMode,
    call: DesktopAgentActionCall,
  ): ApprovalMode {
    return call.scope ? deps.liveApprovalMode(call.scope, mode, 'bound') : mode;
  }

  /**
   * The policy a chat an agent starts begins with: the stricter of the
   * calling chat's mode as of now and the mode a chat a user would start in
   * the same place gets, and the calling chat's denies of every tier with
   * file paths absolute in its root, so they keep protecting its files from
   * a new worktree too. Its root, resolved as its approval session will
   * resolve it, must lie within the calling chat's (in a new worktree,
   * within the same repository scope there), and its effective policy
   * within the calling chat's (`isApprovalPolicyWithin`), or the start is
   * refused. Synchronous, so the step it guards stamps the policy before any
   * mode switch can land.
   */
  function startedChatPolicy(
    context: StartContext,
    call: DesktopAgentActionCall,
  ): DesktopChatApprovalPolicy {
    const { caller, root, bound } = context;
    const selectedRepoId = caller.selectedRepoId;
    if (!root || !bound || !caller.root || !isRootWithin(bound, root)) {
      throw new AgentPortError(
        'authorization_conflict',
        "The new chat would run outside this chat's folder.",
      );
    }
    const callerMode = liveCallerMode(caller.mode, call);
    const mode = startedChatApprovalMode(callerMode, context.defaultMode);
    if (
      !isApprovalPolicyWithin(
        withMode(context.startedPolicy, mode),
        withMode(context.boundPolicy, callerMode),
      )
    ) {
      throw new AgentPortError(
        'authorization_conflict',
        'The new chat would run with broader tool approvals than this chat.',
      );
    }
    return {
      mode,
      sessionRules: context.denies,
      root,
      ...(selectedRepoId ? { selectedRepoId } : {}),
    };
  }

  /**
   * Refuses the first send of a reserved chat whose tab, which that send
   * runs with, would approve something the calling chat now asks about or
   * refuses, as `postMessage` refuses a broader target. Synchronous, so the
   * send it guards starts before any mode switch can land.
   */
  function assertReservedChatWithin(
    reserved: DesktopChatApprovalPolicy,
    reservedPolicy: EffectiveApprovalPolicy | undefined,
    target: { workspaceId: string; worktreeId: string; chatId: string },
    context: StartContext,
    call: DesktopAgentActionCall,
  ): void {
    const started = startedChatPolicy(context, call);
    if (
      reserved.selectedRepoId !== started.selectedRepoId ||
      !isApprovalPolicyWithin(
        withMode(
          reservedPolicy,
          deps.liveApprovalMode(target, reserved.mode, 'reach'),
        ),
        withMode(
          context.boundPolicy,
          liveCallerMode(context.caller.mode, call),
        ),
      )
    ) {
      throw new AgentPortError(
        'authorization_conflict',
        'The new chat would run with broader tool approvals than this chat.',
      );
    }
  }

  async function callerApprovalPolicy(
    call: DesktopAgentActionCall,
  ): Promise<DesktopChatApprovalPolicy> {
    const scope = call.scope;
    if (!scope) return { mode: FAIL_CLOSED_APPROVAL_MODE, sessionRules: [] };
    const policy = await deps.chatApprovalPolicy(scope, call);
    return {
      ...policy,
      sessionRules: deps.callerSessionApprovalRules(scope, policy.sessionRules),
    };
  }

  /** A started chat's start context and its reserved tab's policy. */
  function startedChatReads(
    target: { workspaceId: string; worktreeId: string; chatId: string },
    placement: AgentStartChatInput['placement'],
    call: DesktopAgentActionCall,
  ): Promise<
    readonly [
      StartContext,
      readonly [DesktopChatApprovalPolicy, EffectiveApprovalPolicy | undefined],
    ]
  > {
    return Promise.all([
      startContext(target, placement, call),
      deps
        .chatApprovalPolicy(target, call)
        .then(
          async (policy) =>
            [policy, await effectivePolicyOf(target, policy, call)] as const,
        ),
    ]);
  }

  async function agentStartedChatMessageAdmission(
    target: { workspaceId: string; worktreeId: string; chatId: string },
    call: DesktopAgentActionCall,
  ): Promise<void> {
    const [sending, [reserved, reservedPolicy]] = await startedChatReads(
      target,
      'new_worktree',
      call,
    );
    assertReservedChatWithin(reserved, reservedPolicy, target, sending, call);
  }

  /** The calling chat's approval-state revision, before its policy is read. */
  function callerApprovalRevision(
    call: DesktopAgentActionCall,
  ): number | undefined {
    return call.scope ? deps.chatApprovalStateRevision(call.scope) : undefined;
  }

  /**
   * The containment a message to an existing chat is admitted against: the
   * target's effective policy, with its live mode, must lie within the
   * calling chat's. Refuses at once when it does not.
   */
  async function messageGuard(
    targetChat: { workspaceId: string; worktreeId: string; chatId: string },
    call: DesktopAgentActionCall,
  ): Promise<SendAdmissionGuard> {
    const settingsRevision = deps.approvalSettingsRevision();
    const callerRevision = callerApprovalRevision(call);
    const [callerPolicy, targetPolicy] = await Promise.all([
      callerApprovalPolicy(call),
      deps.chatApprovalPolicy(targetChat, call),
    ]);
    const scope = call.scope;
    const [callerEffective, targetEffective] = await Promise.all([
      scope ? effectivePolicyOf(scope, callerPolicy, call) : undefined,
      effectivePolicyOf(targetChat, targetPolicy, call),
    ]);
    const reach = (): ApprovalMode =>
      deps.liveApprovalMode(targetChat, targetPolicy.mode, 'reach');
    const bound = (): ApprovalMode => liveCallerMode(callerPolicy.mode, call);
    const contained = (): boolean =>
      isApprovalPolicyWithin(
        withMode(targetEffective, reach()),
        withMode(callerEffective, bound()),
      );
    const refusal = (): string =>
      containmentRefusal(
        targetChat.chatId,
        callerEffective && targetEffective
          ? { target: reach(), bound: bound() }
          : { unreadable: callerEffective ? 'target' : 'caller' },
      );
    if (!contained()) {
      throw new AgentPortError('authorization_conflict', refusal());
    }
    return {
      targetPolicy,
      settingsRevision,
      callerRevision,
      contained,
      refusal,
    };
  }

  /** What changed since `guard` was read, as its commit-time check sees it. */
  function staleReads(
    tab: ChatSendAdmissionTab,
    guard: SendAdmissionGuard,
    chatId: string,
    call: DesktopAgentActionCall,
  ): string[] {
    return [
      ...(tabHoldsPolicy(tab, guard.targetPolicy)
        ? []
        : [`chat ${chatId}'s tool approvals`]),
      ...(deps.approvalSettingsRevision() === guard.settingsRevision
        ? []
        : ['the approval settings']),
      ...(callerApprovalRevision(call) === guard.callerRevision
        ? []
        : ["this chat's tool approvals"]),
    ];
  }

  /**
   * The admission a root agent's message to an existing chat in any project
   * must pass, read before it is sent and checked again as it commits. A
   * terminal-driven chat is refused: its permissions come from the terminal
   * session, so containment cannot be shown.
   */
  async function agentMessageAdmission(
    targetChat: { workspaceId: string; worktreeId: string; chatId: string },
    call: DesktopAgentActionCall,
    sent?: ChatSendAdmissionTab,
  ): Promise<DesktopAgentMessageAdmission> {
    const [terminal, terminalTurnState] = await Promise.all([
      deps.terminalDrivenChatIds(
        {
          workspaceId: targetChat.workspaceId,
          worktreeId: targetChat.worktreeId,
        },
        [targetChat.chatId],
      ),
      deps.terminalTurnStates(),
    ]);
    const terminalRefusal = terminalChatRefusal(targetChat.chatId);
    if (terminal.includes(targetChat.chatId)) {
      throw new AgentPortError('invalid_target', terminalRefusal);
    }
    const guard = await messageGuard(targetChat, call);
    let refused: AgentPortError | undefined;
    const admission: DesktopAgentMessageAdmission = {
      check: (tab): string | undefined => {
        if (isTerminalDrivenChat(tab, terminalTurnState(targetChat))) {
          refused = new AgentPortError('invalid_target', terminalRefusal);
          return terminalRefusal;
        }
        const stale = staleReads(tab, guard, targetChat.chatId, call);
        if (stale.length === 0 && guard.contained()) return undefined;
        refused =
          stale.length === 0
            ? new AgentPortError('authorization_conflict', guard.refusal())
            : new AgentPortError(
                'stale_ui_state',
                `The message to chat ${targetChat.chatId} was not sent because ${stale.join(' and ')} changed while it was checked. Try again.`,
                true,
              );
        return refused.message;
      },
      refusal: () => refused,
    };
    // A send carrying its own copy of the tab's settings must carry the ones
    // read here. A setting it does not carry is the tab's, and the mode the
    // tab runs in, resolved when it was queued, is the tab's mode.
    if (
      sent &&
      admission.check({
        ...sent,
        approvalMode:
          sent.approvalMode === undefined ||
          sent.approvalMode === guard.targetPolicy.mode
            ? guard.targetPolicy.tabMode
            : sent.approvalMode,
        selectedRepoId:
          sent.selectedRepoId ?? guard.targetPolicy.selectedRepoId,
        sessionApprovalRules: sent.sessionApprovalRules ?? [
          ...guard.targetPolicy.sessionRules,
        ],
      }) !== undefined
    ) {
      throw (
        admission.refusal() ??
        new AgentPortError('authorization_conflict', guard.refusal())
      );
    }
    return admission;
  }

  async function agentChatStartAdmission(
    task: { workspaceId: string; worktreeId: string },
    firstMessage: boolean,
    call: DesktopAgentActionCall,
    newWorktree = false,
  ): Promise<{ approvalMode: ApprovalMode; selectedRepoId?: string }> {
    const defaultMode = await deps.newChatApprovalMode(task, call);
    const caller = await callerApprovalPolicy(call);
    const approvalMode = startedChatApprovalMode(
      liveCallerMode(caller.mode, call),
      defaultMode,
    );
    if (!firstMessage) return { approvalMode };
    // The new chat starts with no session rules, so a calling chat with
    // session denies is refused here rather than at the first message.
    const scope = call.scope;
    // A new worktree in the caller's own project carries the caller's root
    // and selected repository over, as chat.create did. Another project's
    // worktree gets no projection, so it is held to the caller's own root.
    const carried = newWorktree && scope?.workspaceId === task.workspaceId;
    const selectedRepoId = carried ? caller.selectedRepoId : undefined;
    const [root, bound] = await Promise.all([
      deps.chatExecutionRoot({
        ...task,
        ...(selectedRepoId ? { selectedRepoId } : {}),
      }),
      carried
        ? startedChatRootBound(caller, task, 'new_worktree', call)
        : undefined,
    ]);
    const [callerEffective, carriedEffective, startedEffective] =
      await Promise.all([
        scope ? effectivePolicyOf(scope, caller, call) : undefined,
        bound
          ? effectivePolicyOf(task, { ...caller, root: bound }, call)
          : undefined,
        root
          ? effectivePolicyOf(
              task,
              { mode: approvalMode, sessionRules: [], root },
              call,
            )
          : undefined,
      ]);
    const callerBound = carried
      ? callerEffective &&
        carriedEffective &&
        withDeniesOf(carriedEffective, callerEffective)
      : callerEffective;
    if (
      !isApprovalPolicyWithin(
        startedEffective,
        withMode(callerBound, liveCallerMode(caller.mode, call)),
      )
    ) {
      throw new AgentPortError(
        'authorization_conflict',
        'The new chat would run with broader tool approvals than this chat.',
      );
    }
    return { approvalMode, ...(selectedRepoId ? { selectedRepoId } : {}) };
  }

  async function agentChatStartPrecheck(
    targetWorkspaceId: string,
    call: DesktopAgentActionCall,
  ): Promise<void> {
    const scope = call.scope;
    if (!scope) return;
    const caller = await callerApprovalPolicy(call);
    // A new worktree in another project gets none of the caller's root, so
    // only a Full Access caller's first message fits within its approvals.
    if (targetWorkspaceId !== scope.workspaceId) {
      // Another project's new worktree carries none of this chat's rules, so
      // its denies would refuse the first message only after creation.
      const own = await effectivePolicyOf(scope, caller, call);
      if (
        liveCallerMode(caller.mode, call) !== 'full-access' ||
        caller.sessionRules.some((rule) => rule.behavior === 'deny') ||
        (own !== undefined && inheritedDenyRules(own).length > 0)
      )
        throw new AgentPortError(
          'authorization_conflict',
          "A first message in a new task in another project needs this chat's approvals to be Full Access with no deny rules. Create the task without initialMessage instead.",
        );
      return;
    }
    // A new chat starts without session rules, and a relative deny cannot
    // be carried into a new worktree's root; either would be refused once
    // the worktree exists.
    // Effective rules hold anchored paths only, so a relative deny is one
    // whose anchored target moves when the same policy has another root.
    const [policy, probed] = await Promise.all([
      effectivePolicyOf(scope, caller, call),
      caller.root
        ? effectivePolicyOf(
            scope,
            { ...caller, root: path.join(caller.root, '.relative-deny-probe') },
            call,
          )
        : undefined,
    ]);
    const anchoredElsewhere = new Set(
      (probed ? inheritedDenyRules(probed) : []).map((rule) =>
        JSON.stringify(rule.target),
      ),
    );
    const relativeDeny = (policy ? inheritedDenyRules(policy) : []).some(
      (rule) =>
        hasPathTarget(rule.target) &&
        probed !== undefined &&
        !anchoredElsewhere.has(JSON.stringify(rule.target)),
    );
    if (
      caller.sessionRules.some((rule) => rule.behavior === 'deny') ||
      relativeDeny
    )
      throw new AgentPortError(
        'authorization_conflict',
        'This chat has session or relative-path deny rules that a new chat cannot start with, so it cannot start a chat with a first message. Create the task without initialMessage instead.',
      );
  }

  return {
    query: (name, params, call) =>
      viaDispatcher(() =>
        deps.runtime().query(name, params, readOptions(call)),
      ),
    getChat: async (input, call): Promise<AgentChatDetail | null> => {
      const chat = await viaDispatcher(() =>
        findChat(input.scope.workspaceId, input.chatId, call),
      ).catch((error: unknown) => {
        if (error instanceof AgentPortError && error.code === 'not_found') {
          return null;
        }
        throw error;
      });
      if (!chat) return null;
      const [response, terminalDriven] = await Promise.all([
        lastResponse(chat, call),
        chat.worktreeId === null || chat.state === 'archived'
          ? Promise.resolve(false)
          : deps
              .terminalDrivenChatIds(
                { workspaceId: chat.workspaceId, worktreeId: chat.worktreeId },
                [chat.chatId],
              )
              .then((ids) => ids.includes(chat.chatId)),
      ]);
      return {
        chatId: chat.chatId,
        workspaceId: chat.workspaceId,
        worktreeId: chat.worktreeId,
        title: chat.title,
        state: chat.state,
        modelId: chat.modelId ?? null,
        ...(response ? { lastResponse: response } : {}),
        ...(terminalDriven
          ? {
              messageable: false,
              unmessageableReason: terminalChatRefusal(chat.chatId),
            }
          : {}),
      };
    },
    unmessageableChatIds: (input) =>
      deps.terminalDrivenChatIds(input.scope, input.chatIds),
    // chat.create and chat.send_message are retired on desktop; the project
    // actions start and message chats through the agent messaging path.
    startChat: (): Promise<never> =>
      Promise.reject(
        new AgentPortError('unsupported_action', 'chat.create was removed.'),
      ),
    postMessage: (): Promise<never> =>
      Promise.reject(
        new AgentPortError(
          'unsupported_action',
          'chat.send_message was removed.',
        ),
      ),
    listModels: (_input, call) => deps.listModels(call),
    // The desktop has no depth cap, so every caller counts as depth 0.
    callerDepth: () => Promise.resolve(0),
    agentMessageAdmission,
    agentChatStartAdmission,
    agentChatStartPrecheck,
    agentStartedChatMessageAdmission,
  };
}

/**
 * The parent turn a tool call belongs to: the user message of the turn the
 * calling chat is running, as its trusted runtime recorded it when the turn
 * started. The chat queue records turns it dispatches; a managed Claude
 * terminal records the turn its prompt submit opened. A message queued
 * during the turn never changes it. Undefined when neither runtime names a
 * running turn; limited writes then fail closed.
 */
export async function resolveDesktopTurnKey(
  call: DesktopAgentActionCall,
): Promise<string | undefined> {
  const scope = call.scope;
  if (!scope) return undefined;
  const target = {
    projectId: scope.workspaceId,
    worktreeId: scope.worktreeId,
    chatId: scope.chatId,
  };
  const { getChatQueueService } =
    await import('../services/chat-queue-service');
  const queued = getChatQueueService().runningTurnUserMessageId(target);
  if (queued) return `${scope.chatId}:${queued}`;
  const { getClaudeTerminalSessionService } =
    await import('../integration/claude-terminal-session-service');
  const terminal = getClaudeTerminalSessionService().runningTurnUserMessageId(
    target.projectId,
    target.worktreeId,
    target.chatId,
  );
  return terminal ? `${scope.chatId}:${terminal}` : undefined;
}

const defaultDeps: DesktopEnvironmentPortDeps = {
  runtime: getDesktopCanopyRuntime,
  listModels: async (call): Promise<AgentModelList> => {
    // Deferred: the projection reads provider, policy, and flag state that
    // most injected tool calls never need.
    const [{ buildProjectedModelCatalog }, { resolveAiCreditsScopeOwner }] =
      await Promise.all([
        import('../remote-projection/model-catalog-projection'),
        import('../agents/work-owner'),
      ]);
    // Org policy filters by the owner of the calling chat's work: the owner
    // its session was bound to, else the owner of its workspace.
    const owner = call.scope
      ? await resolveAiCreditsScopeOwner({
          kind: 'work',
          projectId: call.scope.workspaceId,
          worktreeId: call.scope.worktreeId,
          chatId: call.scope.chatId,
        })
      : undefined;
    const { resolveCatalogAgentDefaultModel } =
      await import('../agents/agent-default-model');
    // The same harness rows the Portal and Orchestrator project, so a
    // chat.create can name any model a person could pick there.
    const models = buildProjectedModelCatalog(undefined, {
      cursor: true,
      antigravity: true,
      copilot: true,
      opencode: true,
      owner,
      agentDefaultModel: call.scope
        ? await resolveCatalogAgentDefaultModel(call.scope.workspaceId)
        : undefined,
    });
    return {
      models,
      defaultModelId: models.find((model) => model.isDefault)?.id ?? null,
    };
  },
  listWorkEntries: async (workspaceId) => {
    const { listWorkEntryChatSummaries } =
      await import('../lib/cowork-work-entries');
    const entries = await listWorkEntryChatSummaries(workspaceId);
    return entries.map((entry) => ({
      entryId: entry.entryId,
      title: entry.title,
      createdAt: entry.createdAt,
    }));
  },
  chatApprovalPolicy: async (chat): Promise<DesktopChatApprovalPolicy> => {
    const { resolveWorktreeChatApprovalPolicy } =
      await import('../services/chat-service');
    return resolveWorktreeChatApprovalPolicy({
      projectId: chat.workspaceId,
      worktreeId: chat.worktreeId,
      chatId: chat.chatId,
    });
  },
  effectiveApprovalPolicy: async (
    source,
  ): Promise<EffectiveApprovalPolicy | undefined> => {
    const { effectiveApprovalPolicy } =
      await import('../approvals/effective-approval-policy');
    return effectiveApprovalPolicy(source);
  },
  newChatApprovalMode: async (worktree): Promise<ApprovalMode> => {
    const { resolvePersistedApprovalMode } =
      await import('../lib/approval-mode-resolution');
    return resolvePersistedApprovalMode(
      worktree.workspaceId,
      worktree.worktreeId,
    );
  },
  liveApprovalMode: (chat, mode, use): ApprovalMode =>
    (use === 'bound' ? callerBoundingApprovalMode : reachableApprovalMode)(
      chat.workspaceId,
      chat.worktreeId,
      chat.chatId,
      mode,
    ),
  callerSessionApprovalRules: (chat, rules): readonly ApprovalRule[] =>
    callerBoundingSessionApprovalRules(
      chat.workspaceId,
      chat.worktreeId,
      chat.chatId,
      rules,
    ),
  approvalSettingsRevision: getApprovalSettingsRevision,
  chatApprovalStateRevision: (chat): number =>
    getChatApprovalStateRevision({
      projectId: chat.workspaceId,
      worktreeId: chat.worktreeId,
      chatId: chat.chatId,
    }),
  chatExecutionRoot: async (chat): Promise<string | undefined> => {
    const { resolveChatExecutionRoot } =
      await import('../services/chat-service');
    return resolveChatExecutionRoot(
      { projectId: chat.workspaceId, worktreeId: chat.worktreeId },
      chat.selectedRepoId,
    );
  },
  terminalDrivenChatIds: async (scope, chatIds): Promise<readonly string[]> => {
    const { listTerminalDrivenChatIds } =
      await import('../services/chat-service');
    return listTerminalDrivenChatIds(
      { projectId: scope.workspaceId, worktreeId: scope.worktreeId },
      chatIds,
    );
  },
  terminalTurnStates: async () => {
    const read = await claudeTerminalTurnStates();
    return (chat) =>
      read({
        projectId: chat.workspaceId,
        worktreeId: chat.worktreeId,
        chatId: chat.chatId,
      });
  },
};

/**
 * CAN-5830: the new worktree a started chat runs in, created in main through
 * the keyed W5 writer. Refused, before anything is written, while no
 * interface shows the calling chat (D9).
 */
export async function createDesktopChatWorktree(
  request: {
    workspaceId: string;
    baseWorktreeId: string;
    idempotencyKey: string;
  },
  call: DesktopAgentActionCall,
): Promise<DesktopChatWorktreeResult> {
  const runtime = call.host.worktreeActionRuntime;
  if (!runtime)
    return {
      ok: false,
      code: 'execution_failed',
      message: 'Starting chats needs a worktree chat.',
      retryable: false,
    };
  const [
    { agentChatInterfacePresent, AGENT_CHAT_INTERFACE_TEXTS },
    { createAgentChatWorktree },
  ] = await Promise.all([
    import('../canopy-tools/agent-chat-interface'),
    import('../lib/agent-chat-worktree'),
  ]);
  if (
    !agentChatInterfacePresent({
      projectId: runtime.projectId,
      worktreeId: runtime.worktreeId,
      chatId: runtime.chatId,
      action: {
        type: 'worktree.create',
        workspaceId: request.workspaceId,
        baseWorktreeId: request.baseWorktreeId,
        select: false,
      },
    })
  )
    return {
      ok: false,
      code: 'surface_unavailable',
      message: AGENT_CHAT_INTERFACE_TEXTS.needsWindow,
      retryable: true,
    };
  call.signal?.throwIfAborted();
  try {
    const created = await createAgentChatWorktree({
      ...request,
      interfacePort: runtime.interfacePort,
    });
    if (created.status === 'created')
      return { ok: true, worktreeId: created.worktreeId };
    return {
      ok: false,
      code:
        created.status === 'needs-repair'
          ? 'surface_unavailable'
          : 'execution_failed',
      message: created.message,
      retryable: false,
    };
  } catch (cause) {
    return {
      ok: false,
      code: 'execution_failed',
      message:
        cause instanceof Error
          ? cause.message
          : 'The new worktree could not be created.',
      retryable: false,
    };
  }
}

export function desktopEnvironmentPortDeps(
  overrides: Partial<DesktopEnvironmentPortDeps> = {},
): DesktopEnvironmentPortDeps {
  return { ...defaultDeps, ...overrides };
}

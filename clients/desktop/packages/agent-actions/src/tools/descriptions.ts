import type { AgentActionBrand } from '../brand';
import type { AgentActionCatalogEntry } from '../catalog/types';
import type { AgentActionHostCapabilities } from '../surface/capabilities';
import { agentActionCodexToolName } from '../tool-keys';
import { offersCanonicalChatWatchers } from '../watchers/chat-watchers';

/**
 * The host capabilities the tool descriptions depend on. Without them the
 * builders return the desktop wording, which every desktop surface keeps.
 */
export type AgentActionDescriptionCapabilities = Pick<
  AgentActionHostCapabilities,
  'hiddenInstructions' | 'watcherTargetScope'
> &
  Partial<Pick<AgentActionHostCapabilities, 'watcherTriggers'>>;

/**
 * What SearchActions and DispatchAction are worded from: the host's
 * capabilities and the catalog entries of the actions it dispatches, in
 * advertised order.
 */
export interface AgentActionDescriptionOffer {
  capabilities: AgentActionDescriptionCapabilities;
  actions: readonly Pick<AgentActionCatalogEntry, 'type' | 'category'>[];
}

/** Whether watcher tools offer only chat-completion watchers in the current project. */
export function workspaceChatWatchersOnly(
  capabilities: AgentActionDescriptionCapabilities | undefined,
): boolean {
  return capabilities?.watcherTargetScope === 'current_workspace';
}

/**
 * Whether a host whose watchers reach the current project also offers
 * pipeline-completion watchers, on the runs its chat started.
 */
export function workspacePipelineWatchers(
  capabilities: AgentActionDescriptionCapabilities | undefined,
): boolean {
  return (
    workspaceChatWatchersOnly(capabilities) &&
    (capabilities?.watcherTriggers?.includes('worktree_pipeline_completion') ??
      false)
  );
}

function visibleFollowUps(
  capabilities: AgentActionDescriptionCapabilities | undefined,
): boolean {
  return capabilities?.hiddenInstructions === false;
}

/**
 * The actions of a host whose reach is the current workspace, which the
 * action tools name instead of the desktop categories. Null keeps the
 * desktop wording.
 */
export function workspaceScopedActions(
  offer: AgentActionDescriptionOffer | undefined,
): AgentActionDescriptionOffer['actions'] | null {
  return offer && workspaceChatWatchersOnly(offer.capabilities)
    ? offer.actions
    : null;
}

/** The distinct categories of `actions`, in order of first appearance. */
export function agentActionCategories(
  actions: AgentActionDescriptionOffer['actions'],
): string[] {
  return Array.from(new Set(actions.map((action) => action.category)));
}

/** `a`, `a and b`, or `a, b, and c`, with `or` in place of `and` on request. */
export function listInProse(
  items: readonly string[],
  conjunction: 'and' | 'or' = 'and',
): string {
  if (items.length <= 2) return items.join(` ${conjunction} `);
  return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items[items.length - 1] ?? ''}`;
}

export function searchActionsDescription(
  brand: AgentActionBrand,
  offer?: AgentActionDescriptionOffer,
): string {
  const dispatch = agentActionCodexToolName(brand, 'dispatch_action');
  const actions = workspaceScopedActions(offer);
  if (actions) {
    return `Search the typed ${brand.displayName} actions available in this chat. Actions are scoped server-side to the current project. Categories: ${listInProse(agentActionCategories(actions))}. Use this before DispatchAction / ${dispatch} when you are unsure which action type or payload fields are supported.`;
  }
  return `Search the typed ${brand.displayName} actions available in this chat. Actions are scoped server-side to the current worktree or cowork project. Categories may include skills, pipeline, worktree, automations, tracked-plan, hook, and browser depending on the chat surface. Use this before DispatchAction / ${dispatch} when you are unsure which action type or payload fields are supported.`;
}

export function dispatchActionDescription(
  brand: AgentActionBrand,
  offer?: AgentActionDescriptionOffer,
): string {
  const actions = workspaceScopedActions(offer);
  if (actions) {
    return `Dispatch a typed ${brand.displayName} action. Actions run in the current project; the scope is applied server-side, so do not provide projectId or worktreeId. Supports ${listInProse(actions.map((action) => action.type))}.`;
  }
  return `Dispatch a typed ${brand.displayName} action. The current chat's worktree or cowork project scope is applied server-side; do not provide projectId or worktreeId. Supports skills, pipeline, and automation management plus in-app browser control; worktree chats also support reading hook status, listing and running configured worktree scripts, tracked-plan import, and hook pause/resume.`;
}

export function searchWatchersDescription(
  brand: AgentActionBrand,
  capabilities?: AgentActionDescriptionCapabilities,
): string {
  const setup = agentActionCodexToolName(brand, 'setup_watchers');
  if (workspacePipelineWatchers(capabilities)) {
    return `Search the ${brand.displayName} watcher catalog and list active watchers for this chat. Chat-completion watchers may target only chats in the current project, and pipeline-completion watchers only workflow runs this chat started. Use this before SetupWatchers / ${setup} for watch, notify, or wait-until-done requests. Prefer watchers over polling a chat's or a run's status in a loop.`;
  }
  if (workspaceChatWatchersOnly(capabilities)) {
    return `Search the ${brand.displayName} watcher catalog and list active watchers for this chat. Only chat-completion watchers are available here, and they may target only chats in the current project. Use this before SetupWatchers / ${setup} for watch, notify, or wait-until-done requests. Prefer watchers over polling a chat's status in a loop.`;
  }
  if (offersCanonicalChatWatchers(capabilities?.watcherTriggers)) {
    return `Search the ${brand.displayName} watcher catalog and list active watchers for this chat. Catalog query/limit are separate from instance activeQuery/activePageSize/activeCursor and target ID filters. Results include activeReturned, activeTotalMatches, and activeNextCursor when more instances match; authorized canonical targets appear at both detail levels. Pipeline watchers are scoped to this chat's worktree or entire cowork project; hook watchers are available only in worktree chats. Canonical project/bot chat-completion and new-chat-started watchers use projectId/botId, taskId, and chatId from discovery; automation-run watchers use automationId. Use this before SetupWatchers / ${setup} for watch, notify, or wait-until-done requests. Prefer watchers over polling pipeline status in a loop.`;
  }
  return `Search the ${brand.displayName} watcher catalog and list active watchers for this chat. Pipeline watchers are scoped to this chat's worktree or entire cowork project; hook watchers are available only in worktree chats. Chat-completion, new-chat-started, and automation-run watchers may target any project, chat, or automation by id. Use this before SetupWatchers / ${setup} for watch, notify, or wait-until-done requests. Prefer watchers over polling pipeline status in a loop.`;
}

export function setupWatchersDescription(
  brand: AgentActionBrand,
  capabilities?: AgentActionDescriptionCapabilities,
): string {
  if (workspaceChatWatchersOnly(capabilities)) {
    const arrival = visibleFollowUps(capabilities)
      ? 'The notification arrives in this chat as a visible message,'
      : 'The notification arrives in this chat as a short visible notice, with its event details in a hidden system instruction,';
    if (workspacePipelineWatchers(capabilities))
      return `Create one or more watchers that notify this same chat when a targeted chat in the current project finishes its turn, or when a workflow run this chat started ends. For a chat use trigger worktree_chat_completion and supply the full target ids (projectId, worktreeId, chatId); a chat cannot watch itself. Set armForNextCompletion:true to arm an idle chat for its next completed turn; otherwise idle chats are rejected. For a run use trigger worktree_pipeline_completion with target.executionId, the executionId pipeline.run returned, and optionally target.terminalStatuses (success, failure, cancelled; all by default); a run that already ended is rejected. Identical active watchers are deduped unless allowDuplicate is true. ${arrival} usually within about a minute of the target finishing. A watcher fires once and expires after 24 hours. The destination chat is always captured server-side; never provide destination ids, session ids, or display metadata.`;
    return `Create one or more watchers that notify this same chat when a targeted chat in the current project finishes its turn. Use trigger worktree_chat_completion and supply the full target ids (projectId, worktreeId, chatId); a chat cannot watch itself. Set armForNextCompletion:true to arm an idle target for its next completed turn; otherwise idle targets are rejected. Identical active watchers are deduped unless allowDuplicate is true. ${arrival} usually within about a minute of the target finishing. A watcher fires once and expires after 24 hours. The destination chat is always captured server-side; never provide destination ids, session ids, or display metadata.`;
  }
  if (offersCanonicalChatWatchers(capabilities?.watcherTriggers)) {
    return `Create one or more watchers that notify this same chat when: matching pipeline executions in its worktree or cowork project pause/reach a terminal state; matching worktree hook triggers fire automatically; a targeted chat (in any project) finishes its turn or a new chat starts in a targeted worktree/cowork project; or a targeted automation's run completes (failed/skipped runs fire immediately, successful runs fire when a dispatched chat turn ends or a dispatched pipeline completes). Pipeline pause notifications leave the watcher active; terminal notifications consume it. Hook watchers are worktree-only and also fire when the hook is paused or no hook action is configured; manual hook runs do not fire watchers. For pipeline and hook watchers ${brand.displayName} applies the current projectId and worktreeId server-side — do not provide them. For project_task_chat_completion supply target {projectId,taskId,chatId}; for bot_task_chat_completion supply {botId,taskId,chatId}. For project_new_chat_started supply {projectId,taskId?}; for bot_new_chat_started supply {botId,taskId?}. Canonical chat targets must not include kind or destination fields; a chat cannot watch itself. Set armForNextCompletion:true only on a chat-completion watcher to arm an idle target for its next completed turn; otherwise idle targets are rejected. For automation_run supply target.automationId. The destination chat is always captured server-side; never provide destination ids, session ids, or display metadata.`;
  }
  return `Create one or more watchers that notify this same chat when: matching pipeline executions in its worktree or cowork project pause/reach a terminal state; matching worktree hook triggers fire automatically; a targeted chat (in any project) finishes its turn or a new chat starts in a targeted worktree/cowork project; or a targeted automation's run completes (failed/skipped runs fire immediately, successful runs fire when a dispatched chat turn ends or a dispatched pipeline completes). Pipeline pause notifications leave the watcher active; terminal notifications consume it. Hook watchers are worktree-only and also fire when the hook is paused or no hook action is configured; manual hook runs do not fire watchers. For pipeline and hook watchers ${brand.displayName} applies the current projectId and worktreeId server-side — do not provide them. For chat triggers supply the full target ids (projectId, plus worktreeId/chatId as required); a chat cannot watch itself. Set armForNextCompletion:true only on a chat-completion watcher to arm an idle target for its next completed turn; otherwise idle targets are rejected. For automation_run supply target.automationId. The destination chat is always captured server-side; never provide destination ids, session ids, or display metadata.`;
}

export function deleteWatchersDescription(
  brand: AgentActionBrand,
  capabilities?: AgentActionDescriptionCapabilities,
): string {
  if (workspaceChatWatchersOnly(capabilities)) {
    return `Delete 1–20 agent-created watchers owned by this same chat. Use watcher ids returned by SearchWatchers or SetupWatchers. Results are reported per id as deleted, not_found, or busy (its notification is being delivered); watchers owned by another chat are never deletable through this tool and are reported as not_found. ${brand.displayName} captures the destination and ownership server-side; pass only watcherIds and never provide destination, project, worktree, chat, session, or subscriber-notification fields.`;
  }
  return `Delete 1–20 agent-created watchers owned by this same chat. Use watcher ids returned by SearchWatchers, SetupWatchers, or WatchGitHubItems. Results are reported per id as deleted, not_found, or busy; user-created watchers and watchers owned by another chat are never deletable through this tool and are reported as not_found. ${brand.displayName} captures the destination and ownership server-side; pass only watcherIds and never provide destination, project, worktree, chat, session, or subscriber-notification fields. Use ${agentActionCodexToolName(brand, 'delete_watchers')} instead of the global watcher.delete UI action for agent self-service cleanup.`;
}

const SPLIT_AGENT_CAUTION =
  'Use only when user intent to split off work is very clear, such as an explicit user or skill instruction. These are fire-and-forget independent chats, not inspectable subagents: no child transcript inspection, control, or automatic result delivery. The originating agent receives confirmation and continues running. Source chat and worktree scope are captured server-side.';
export const START_FORKED_AGENT_DESCRIPTION = `Fork this chat at its current mid-turn snapshot into a new chat in the same worktree, show Continue as the user message, deliver followUpInstruction in a hidden system instruction identifying the fork, and start it immediately. ${SPLIT_AGENT_CAUTION}`;
export const START_BRANCHED_AGENT_DESCRIPTION = `Fork this chat at its current mid-turn snapshot into a new worktree that is a child branch of the current branch. Queue a visible Continue user message until normal worktree setup completes, then start it automatically. A hidden system instruction supplies followUpInstruction, identifies the fresh branch and new working directory without naming the new branch, and marks the originating worktree location and branch as read-only references; all changes must stay in the new working directory. Returns the new worktreeId and chatId. ${SPLIT_AGENT_CAUTION}`;
const START_FORKED_AGENT_VISIBLE_DESCRIPTION = `Fork this chat at its current mid-turn snapshot into a new independent chat in a new worktree, then post followUpInstruction there as a visible message that starts it immediately. ${SPLIT_AGENT_CAUTION}`;
const START_FORKED_AGENT_NEW_WORKTREE_DESCRIPTION = `Fork this chat at its current mid-turn snapshot into a new independent chat in a new worktree, show Continue as the user message, deliver followUpInstruction in a hidden system instruction identifying the fork, and start it immediately. A followUpInstruction too long for a hidden instruction (about 7,800 characters) is posted as the visible message instead. ${SPLIT_AGENT_CAUTION}`;

export function startForkedAgentDescription(
  capabilities?: AgentActionDescriptionCapabilities,
): string {
  if (visibleFollowUps(capabilities)) {
    return START_FORKED_AGENT_VISIBLE_DESCRIPTION;
  }
  return workspaceChatWatchersOnly(capabilities)
    ? START_FORKED_AGENT_NEW_WORKTREE_DESCRIPTION
    : START_FORKED_AGENT_DESCRIPTION;
}

/**
 * Standing guidance for an agent whose host delivers instructions separately
 * from the tool descriptions, such as a cloud chat's session instructions.
 */
export function agentActionInstructions(brand: AgentActionBrand): string {
  return `${brand.displayName} action tools are available in this chat. Call SearchActions to find an action type and its payload fields before calling DispatchAction; this chat's scope is applied automatically, so never supply projectId or worktreeId. When the user asks for a pull request, dispatch pull_request.create: it commits, pushes and opens the pull request with the user's GitHub account, so never use gh or git push in the sandbox, and give the user the returned URL. Start other chats only when the user asks for parallel or delegated work.`;
}

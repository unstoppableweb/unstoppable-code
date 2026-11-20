import type {
  SubagentKind,
  SubagentNode,
  SubagentRecipient,
  SubagentStatus,
  SubagentStatusFilter,
} from '@canopy/agent-transcript';
import {
  DELEGATED_AGENT_CANCELLED_LABEL,
  DELEGATED_AGENT_DONE_LABEL,
  DELEGATED_AGENT_QUEUED_LABEL,
  DELEGATED_AGENT_STOPPED_BY_PARENT_LABEL,
} from '../delegated-agent-copy';

// Copy for the Subagents panel, the subagent chat panel, Open chat on agent
// cards and attached-subagent chips. Status words reuse the delegated-task
// vocabulary in `delegated-agent-copy.ts` (docs/ux-writing.md, "Delegated
// task status"); message states reuse "Message delivery states".

// ---------------------------------------------------------------------------
// Shared

/** Panel and tab title of the Subagents panel. */
export const SUBAGENTS_PANEL_TITLE = 'Subagents';

/** The agent-card and inspector action that opens a subagent's chat. */
export const SUBAGENT_OPEN_CHAT_LABEL = 'Open chat';

/** Fallback title for a subagent whose task has no description. */
export const SUBAGENT_UNTITLED_LABEL = 'Subagent';

/** Separator for lineage chains such as `via Plan › Port handlers`. */
export const SUBAGENT_LINEAGE_SEPARATOR = ' › ';

const statusLabels: Readonly<Record<SubagentStatus, string>> = {
  queued: DELEGATED_AGENT_QUEUED_LABEL,
  starting: 'Running',
  running: 'Running',
  approval: 'Awaiting approval',
  idle: 'Idle',
  completed: DELEGATED_AGENT_DONE_LABEL,
  interrupted: 'Interrupted',
  failed: 'Failed',
  cancelled: DELEGATED_AGENT_CANCELLED_LABEL,
  'stopped-by-parent': DELEGATED_AGENT_STOPPED_BY_PARENT_LABEL,
};

/** One word or short phrase per status, for rows, cards and pickers. */
export function subagentStatusLabel(status: SubagentStatus): string {
  return statusLabels[status];
}

/** `Idle · 3 active below` for an idle parent whose tasks still run (D10). */
export function subagentIdleWithLiveLabel(liveBelow: number): string {
  return `Idle · ${liveBelow} active below`;
}

/**
 * The status line for a node: idle parents say why they still matter, every
 * other status uses its label.
 */
export function subagentStatusDetail(
  node: Pick<SubagentNode, 'status' | 'liveDescendantCount'>,
): string {
  if (node.status === 'idle' && node.liveDescendantCount > 0)
    return subagentIdleWithLiveLabel(node.liveDescendantCount);
  return subagentStatusLabel(node.status);
}

/** Longest failure the banner facts line shows; Setup shows longer ones. */
export const SUBAGENT_FACTS_ERROR_MAX_LENGTH = 120;

/** A failed subagent's reported error, trimmed, when there is one. */
export function subagentFailureText(
  node: Pick<SubagentNode, 'status' | 'errorMessage' | 'snapshot'>,
): string | undefined {
  if (node.status !== 'failed') return undefined;
  const error = (node.errorMessage ?? node.snapshot?.error?.message)?.trim();
  return error ? error : undefined;
}

/** What a Claude Code workflow agent is called in place of a workspace. */
export const SUBAGENT_WORKFLOW_AGENT_LABEL = 'Workflow agent';

/**
 * `Claude subagent` / `Codex subagent` / `Workflow agent`, shown in place of a
 * workspace (D25). Workflow run and phase groups have none.
 */
export function subagentProviderLabel(kind: SubagentKind): string | null {
  if (kind === 'claude-native') return 'Claude subagent';
  if (kind === 'codex-native') return 'Codex subagent';
  if (kind === 'workflow-agent') return SUBAGENT_WORKFLOW_AGENT_LABEL;
  return null;
}

/** Short workspace word for list rows and node cards. */
export function subagentWorkspaceShortLabel(
  node: Pick<SubagentNode, 'kind' | 'workspace'>,
): string | null {
  const provider = subagentProviderLabel(node.kind);
  if (provider) return provider;
  if (node.workspace === 'isolated') return 'Isolated';
  if (node.workspace === 'shared') return 'Shared';
  return null;
}

/** Workspace value for the inspector and the banner's Setup section. */
export function subagentWorkspaceLabel(
  node: Pick<SubagentNode, 'kind' | 'workspace'>,
): string | null {
  const provider = subagentProviderLabel(node.kind);
  if (provider) return provider;
  if (node.workspace === 'isolated') return 'Isolated worktree';
  if (node.workspace === 'shared') return 'Shared with parent';
  return null;
}

/** `via Plan the slices › Port handlers`, naming hidden parents (D7). */
export function subagentViaLabel(
  via: readonly Pick<SubagentNode, 'title'>[],
): string {
  return `via ${via.map((node) => node.title).join(SUBAGENT_LINEAGE_SEPARATOR)}`;
}

/** `+12 -3` is drawn by the changes label; this is its accessible text. */
export function subagentChangesAccessibleLabel(
  additions: number,
  deletions: number,
): string {
  return `${additions} ${additions === 1 ? 'line' : 'lines'} added, ${deletions} ${deletions === 1 ? 'line' : 'lines'} removed`;
}

/** `in 3 files` after a change total. */
export function subagentFilesCountLabel(count: number): string {
  return `in ${count} ${count === 1 ? 'file' : 'files'}`;
}

// ---------------------------------------------------------------------------
// Subagents panel: toolbar

/** Accessible name of the root chat picker. */
export const SUBAGENTS_ROOT_PICKER_LABEL = 'Root chat';

/** Root picker section for trees with live work. */
export const SUBAGENTS_ROOT_SECTION_ACTIVE = 'Active';

/** Root picker section for trees whose work has settled. */
export const SUBAGENTS_ROOT_SECTION_FINISHED = 'Finished';

/** Root picker row detail: `4 active · 10 subagents`. */
export function subagentsRootLiveDetail(live: number, total: number): string {
  return `${live} active · ${subagentsCountLabel(total)}`;
}

/** `1 subagent` / `10 subagents`. */
export function subagentsCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'subagent' : 'subagents'}`;
}

/** Root picker row detail while its count is still loading. */

/** Accessible name of the status filter. */
export const SUBAGENTS_FILTER_GROUP_LABEL = 'Show subagents';

const filterLabels: Readonly<Record<SubagentStatusFilter, string>> = {
  all: 'All',
  active: 'Active',
  attention: 'Needs attention',
};

/** `All`, `Active`, `Needs attention` (D6). */
export function subagentsFilterLabel(filter: SubagentStatusFilter): string {
  return filterLabels[filter];
}

/**
 * A filter segment with its count, `Active 3`. Counts are left out when the
 * tree was built from a partial transcript, so they never read as totals.
 */
export function subagentsFilterLabelWithCount(
  filter: SubagentStatusFilter,
  count: number | null,
): string {
  return count === null
    ? subagentsFilterLabel(filter)
    : `${subagentsFilterLabel(filter)} ${count}`;
}

/** Accessible name of the Tree / List switch. */
export const SUBAGENTS_VIEW_GROUP_LABEL = 'View';
export const SUBAGENTS_VIEW_TREE_LABEL = 'Tree';
export const SUBAGENTS_VIEW_LIST_LABEL = 'List';

/** Visible caption of the Levels capsule. */
export const SUBAGENTS_LEVELS_LABEL = 'Levels';

/** Accessible name of the Levels capsule and heading of its menu. */
export const SUBAGENTS_LEVELS_MENU_LABEL = 'Levels shown';

export const SUBAGENTS_LEVELS_AUTO_LABEL = 'Auto';
export const SUBAGENTS_LEVELS_ALL_LABEL = 'All';

/** The capsule's value: `Auto · 3`, `All` or `6` (D13). */
export function subagentsLevelsValueLabel(
  setting: 'auto' | 'all' | number,
  autoLevels: number,
): string {
  if (setting === 'auto')
    return `${SUBAGENTS_LEVELS_AUTO_LABEL} · ${autoLevels}`;
  if (setting === 'all') return SUBAGENTS_LEVELS_ALL_LABEL;
  return String(setting);
}

/** Auto's menu description: `Fits this panel: 3 levels`. */
export function subagentsLevelsAutoDescription(autoLevels: number): string {
  return `Fits this panel: ${subagentsLevelsCountLabel(autoLevels)}`;
}

/** All's menu description: `Every level (7), scaled to fit`. */
export function subagentsLevelsAllDescription(depth: number): string {
  return `Every level (${depth}), scaled to fit`;
}

/** A numbered choice: `3 levels`. */
export function subagentsLevelsCountLabel(levels: number): string {
  return `${levels} ${levels === 1 ? 'level' : 'levels'}`;
}

// ---------------------------------------------------------------------------
// Subagents panel: tree, list and empty states

/** Accessible name of the tree canvas. */
export const SUBAGENTS_TREE_LABEL = 'Subagent tree';

/** Accessible name of the list. */
export const SUBAGENTS_LIST_LABEL = 'Subagents';

/** Root card and root row detail: `3 active` or `none active`. */
export function subagentsRootActiveLabel(live: number): string {
  return live > 0 ? `${live} active` : 'none active';
}

/** Stub at the edge of the Levels window: `5 more below`. */
export function subagentsMoreBelowLabel(hidden: number): string {
  return `${hidden} more below`;
}

/** Live count on a stub: `2 active`. */
export function subagentsMoreBelowLiveLabel(live: number): string {
  return `${live} active`;
}

/** Accessible name of a stub, which focuses its task on click (D12). */
export function subagentsMoreBelowAccessibleLabel(hidden: number): string {
  return `Focus to show ${hidden} more ${hidden === 1 ? 'task' : 'tasks'} below`;
}

/** The folded-parents card while focused: `4 parents · First › … › Last`. */
export function subagentsFoldedParentsLabel(
  ancestors: readonly Pick<SubagentNode, 'title'>[],
): string {
  const first = ancestors[0];
  const last = ancestors[ancestors.length - 1];
  const count = `${ancestors.length} ${ancestors.length === 1 ? 'parent' : 'parents'}`;
  if (!first || !last) return count;
  return ancestors.length > 1
    ? `${count} · ${first.title}${SUBAGENT_LINEAGE_SEPARATOR}…${SUBAGENT_LINEAGE_SEPARATOR}${last.title}`
    : `${count} · ${first.title}`;
}

/** Accessible name of the folded-parents card. */
export function subagentsFoldedParentsAccessibleLabel(count: number): string {
  return `Show ${count} ${count === 1 ? 'parent' : 'parents'}`;
}

/** List column headings (D9). */
export const SUBAGENTS_COLUMN_TASK = 'Task';
export const SUBAGENTS_COLUMN_STATUS = 'Status';
export const SUBAGENTS_COLUMN_MODEL = 'Model';
export const SUBAGENTS_COLUMN_WORKSPACE = 'Workspace';
export const SUBAGENTS_COLUMN_CHANGES = 'Changes';
export const SUBAGENTS_COLUMN_TIME = 'Time';

/** Accessible name of a capped indent's depth number (D11). */
export function subagentsDepthAccessibleLabel(depth: number): string {
  return `Depth ${depth}`;
}

/** Accessible name of a list row's open arrow: `Open Port handlers`. */
/**
 * Verb of a row's open control. The control's accessible name joins it with
 * the row's masked title through `aria-labelledby`, so the title stays out
 * of recorded attributes.
 */
export const SUBAGENTS_OPEN_ROW_LABEL = 'Open';

/** Empty state title for a root chat with no subagents (D4). */
export const SUBAGENTS_EMPTY_TITLE = "This chat hasn't started subagents";

/** Empty state body. */
export const SUBAGENTS_EMPTY_BODY =
  'When its agent delegates a task, the task and anything it starts appear here. Pick another chat to see its subagents.';

/** Shown when no open chat in this place has started subagents. */
export const SUBAGENTS_NO_ROOTS_TITLE = 'No chats have started subagents';

/** Body for the no-roots state. */
export const SUBAGENTS_NO_ROOTS_BODY =
  'When an agent delegates a task, its chat appears here.';

/** Empty filter result: nothing in the tree matches Active. */
export const SUBAGENTS_FILTER_EMPTY_ACTIVE = 'No subagents are active';

/** Empty filter result: nothing needs attention. */
export const SUBAGENTS_FILTER_EMPTY_ATTENTION = 'No subagents need attention';

/** Quiet notice when the host built the tree from a partial transcript. */
export const SUBAGENTS_PARTIAL_TREE_NOTICE =
  'Showing subagents from the messages loaded so far';

/** Loading state while the selected root chat's tree is read. */
export const SUBAGENTS_LOADING_LABEL = 'Loading subagents…';

/** Error when the tree could not be read. */
export const SUBAGENTS_LOAD_FAILED_LABEL = "Couldn't load subagents.";

/** Shown where the place's host doesn't serve the subagent viewer. */
export const SUBAGENTS_UNAVAILABLE_TITLE =
  "Subagents aren't available for this task";

/** Retry after the tree could not be read. */
export const SUBAGENTS_RETRY_LABEL = 'Try again';

// ---------------------------------------------------------------------------
// Subagents panel: focus, inspector and drawer

/** Inspector and drawer action that re-roots the tree on a task (D14). */
export const SUBAGENTS_FOCUS_LABEL = 'Focus';

/** Focus bar action that leaves focus. */
export const SUBAGENTS_SHOW_ALL_LABEL = 'Show all';

/** Focus bar Up's accessible name: `Up to Plan the slices`. */
export function subagentsFocusUpAccessibleLabel(parentTitle: string): string {
  return `Up to ${parentTitle}`;
}

/** Focus bar context: `in Plan the slices · depth 5`. */
export function subagentsFocusContextLabel(
  parentTitle: string,
  depth: number,
): string {
  return `in ${parentTitle} · depth ${depth}`;
}

/** The inspector and drawer close control. */
export const SUBAGENTS_CLOSE_DETAILS_LABEL = 'Close details';

/** Inspector rows. */
export const SUBAGENTS_INSPECTOR_MODEL = 'Model';
export const SUBAGENTS_INSPECTOR_WORKSPACE = 'Workspace';
export const SUBAGENTS_INSPECTOR_CHANGES = 'Changes';
export const SUBAGENTS_INSPECTOR_LINEAGE = 'Lineage';
/** When the task started: `4m ago`. */
export const SUBAGENTS_INSPECTOR_STARTED = 'Started';
/** The tasks this task started (its child subagents). */
export const SUBAGENTS_INSPECTOR_STARTED_TASKS = 'Started tasks';
export const SUBAGENTS_INSPECTOR_LATEST = 'Latest';

/** Inspector `Started tasks` value for a task that started nothing. */
export const SUBAGENTS_INSPECTOR_STARTED_NONE = 'None';
/** The classic details card's `Started` value for a task that started nothing. */
export const SUBAGENTS_INSPECTOR_STARTED_NONE_CLASSIC = 'No subagents';

/** Inspector notice when Stop failed: reuses the card's wording. */
export const SUBAGENTS_STOP_FAILED_LABEL = "Couldn't stop the delegation.";

/** Stop's reason when the host cannot stop delegations. */
export const SUBAGENTS_STOP_UNAVAILABLE_LABEL =
  "Stopping delegations isn't available here";

// ---------------------------------------------------------------------------
// Claude Code workflow runs, phases and agents

/** Inspector, list row and details action that opens a run's workflow view. */
export const SUBAGENT_OPEN_WORKFLOW_LABEL = 'Open workflow';

/** Inspector action that stops a live workflow run. */
export const SUBAGENT_STOP_WORKFLOW_LABEL = 'Stop workflow';

/** Stop workflow while its request is in flight. */
export const SUBAGENT_STOPPING_WORKFLOW_LABEL = 'Stopping…';

/** Inspector notice when Stop workflow failed. */
export const SUBAGENT_STOP_WORKFLOW_FAILED_LABEL =
  "Couldn't stop the workflow.";

/** `1 agent` / `9 agents`. */
export function subagentWorkflowAgentCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'agent' : 'agents'}`;
}

/** `1 phase` / `4 phases`. */
export function subagentWorkflowPhaseCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'phase' : 'phases'}`;
}

/** `6 of 7 done`. */
export function subagentWorkflowDoneOfLabel(
  done: number,
  total: number,
): string {
  return `${done} of ${total} done`;
}

/** `2 of 9 failed`. */
export function subagentWorkflowFailedOfLabel(
  failed: number,
  total: number,
): string {
  return `${failed} of ${total} failed`;
}

/** `2 failed`, the short form for list rows. */
export function subagentWorkflowFailedLabel(failed: number): string {
  return `${failed} failed`;
}

/** A phase's place in its run: `1 of 3`, from a zero-based index. */
export function subagentWorkflowPhasePositionLabel(
  phaseIndex: number,
  phaseCount: number,
): string {
  return `${phaseIndex + 1} of ${phaseCount}`;
}

/**
 * A live run's third line starts with its phase position, `Phase 3 of 3`;
 * the phase title follows after `SUBAGENT_DETAIL_SEPARATOR` in its own
 * element so session replay can mask it.
 */
export function subagentWorkflowCurrentPhaseLabel(
  phaseIndex: number,
  phaseCount: number,
): string {
  return `Phase ${phaseIndex + 1} of ${phaseCount}`;
}

/** Joins a position or count to the title after it: ` · `. */
export const SUBAGENT_DETAIL_SEPARATOR = ' · ';

/** A live run row's note: `6 of 7 done · phase 3 of 3`. */
export function subagentWorkflowRunLiveNote(
  done: number,
  total: number,
  phaseIndex: number | undefined,
  phaseCount: number,
): string {
  const counts = subagentWorkflowDoneOfLabel(done, total);
  if (phaseIndex === undefined || phaseCount === 0) return counts;
  return `${counts} · phase ${phaseIndex + 1} of ${phaseCount}`;
}

/** A finished run row's note: `9 agents · 4 phases`. */
export function subagentWorkflowRunSettledNote(
  total: number,
  phaseCount: number,
): string {
  const agents = subagentWorkflowAgentCountLabel(total);
  return phaseCount > 0
    ? `${agents} · ${subagentWorkflowPhaseCountLabel(phaseCount)}`
    : agents;
}

/** Inspector `Run`: `3 of 3 in this chat`. */
export function subagentWorkflowRunPositionLabel(
  runOrdinal: number,
  runCount: number,
): string {
  return `${runOrdinal} of ${runCount} in this chat`;
}

/** `Agent 5 of 7 · phase 2 of 3`: where an agent sits in its run. */
export function subagentWorkflowAgentPositionLabel(
  agentPosition: number | undefined,
  agentCount: number,
  phaseIndex: number | undefined,
  phaseCount: number,
): string | null {
  const parts: string[] = [];
  if (agentPosition !== undefined)
    parts.push(`Agent ${agentPosition} of ${agentCount}`);
  if (phaseIndex !== undefined && phaseCount > 0)
    parts.push(
      parts.length > 0
        ? `phase ${phaseIndex + 1} of ${phaseCount}`
        : `Phase ${phaseIndex + 1} of ${phaseCount}`,
    );
  return parts.length > 0 ? parts.join(' · ') : null;
}

function compactTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${tokens}`;
}

/** `3.9M tokens · 598 tool calls`; either half alone; null when neither. */
export function subagentWorkflowUsageLabel(
  tokens: number | undefined,
  toolCalls: number | undefined,
): string | null {
  const parts: string[] = [];
  if (tokens !== undefined) parts.push(`${compactTokenCount(tokens)} tokens`);
  if (toolCalls !== undefined)
    parts.push(`${toolCalls} ${toolCalls === 1 ? 'tool call' : 'tool calls'}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Accessible name of a phase card: `Write phase of billing-plan`. */
export function subagentsWorkflowPhaseAccessibleLabel(
  phaseTitle: string,
  runName: string,
): string {
  return `${phaseTitle} phase of ${runName}`;
}

/** Run inspector rows. */
export const SUBAGENTS_INSPECTOR_CHAT = 'Chat';
export const SUBAGENTS_INSPECTOR_RUN = 'Run';
export const SUBAGENTS_INSPECTOR_PHASES = 'Phases';
export const SUBAGENTS_INSPECTOR_USAGE = 'Usage';
export const SUBAGENTS_INSPECTOR_TIME = 'Time';

/** Subagent chat details section for a workflow agent, and its rows. */
export const SUBAGENT_DETAILS_WORKFLOW = 'Workflow';
export const SUBAGENT_WORKFLOW_RUN = 'Run';
export const SUBAGENT_WORKFLOW_STATUS = 'Status';
export const SUBAGENT_WORKFLOW_POSITION = 'Position';
export const SUBAGENT_WORKFLOW_USAGE = 'Usage';

// ---------------------------------------------------------------------------
// Subagent chat panel: banner and details

/** Accessible name of the banner's breadcrumb. */
export const SUBAGENT_BANNER_LINEAGE_LABEL = 'Lineage';

/** Accessible names of the banner's disclosure. */
export const SUBAGENT_BANNER_SHOW_DETAILS_LABEL = 'Show details';
export const SUBAGENT_BANNER_HIDE_DETAILS_LABEL = 'Hide details';

/** Details section headings (D17). */
export const SUBAGENT_DETAILS_SETUP = 'Setup';
export const SUBAGENT_DETAILS_COST = 'Cost';
export const SUBAGENT_DETAILS_LINEAGE = 'Lineage';
export const SUBAGENT_DETAILS_WORKTREE = 'Worktree';

/** Setup rows. Native subagents list only what the provider reports (D26). */
export const SUBAGENT_SETUP_TYPE = 'Type';
export const SUBAGENT_SETUP_MODEL = 'Model';
export const SUBAGENT_SETUP_HARNESS = 'Harness';
export const SUBAGENT_SETUP_THINKING = 'Thinking';
export const SUBAGENT_SETUP_RUNS = 'Runs';
export const SUBAGENT_SETUP_WORKSPACE = 'Workspace';
export const SUBAGENT_SETUP_PERMISSIONS = 'Permissions';
export const SUBAGENT_SETUP_CAPABILITIES = 'Capabilities';
export const SUBAGENT_SETUP_SUBAGENTS = 'Subagents';
export const SUBAGENT_SETUP_USAGE = 'Usage';
export const SUBAGENT_SETUP_ERROR = 'Error';

/** Setup `Permissions` for a managed delegate without write paths. */
export const SUBAGENT_PERMISSIONS_READ_ONLY = 'Read and search';
/** Note below a managed delegate's write paths. */
export const SUBAGENT_PERMISSIONS_APPROVALS_NOTE = 'Parent approvals apply.';

/** Setup `Permissions` summary: `Read/search and edits within 3 paths`. */
export function subagentPermissionsEditsLabel(count: number): string {
  return `Read/search and edits within ${count} ${count === 1 ? 'path' : 'paths'}`;
}

/** Visible label that reveals omitted write paths: `Show more (12)`. */
export function subagentShowMorePathsLabel(remaining: number): string {
  return `Show more (${remaining})`;
}

/** Accessible name that reveals omitted write paths. */
export function subagentShowMorePathsAccessibleLabel(
  remaining: number,
): string {
  return `Show more paths (${remaining} remaining)`;
}

export const SUBAGENT_SHOW_FEWER_PATHS_LABEL = 'Show fewer paths';
export const SUBAGENT_SHOW_FULL_ERROR_LABEL = 'Show full error';
export const SUBAGENT_SHOW_LESS_ERROR_LABEL = 'Show less of the error';
export const SUBAGENT_SHOW_MORE_LABEL = 'Show more';
export const SUBAGENT_SHOW_LESS_LABEL = 'Show less';

/** Setup `Runs`: `Background · 2 runs`. */
export function subagentRunsLabel(
  executionMode: 'foreground' | 'background' | undefined,
  runCount: number,
): string {
  const mode =
    executionMode === 'background'
      ? 'Background'
      : executionMode === 'foreground'
        ? 'Foreground'
        : null;
  const runs = `${runCount} ${runCount === 1 ? 'run' : 'runs'}`;
  return mode ? `${mode} · ${runs}` : runs;
}

/** Setup `Subagents`: `Started 2` or `Started none`. */
export function subagentStartedCountLabel(count: number): string {
  return count > 0 ? `Started ${count}` : 'Started none';
}

/** Lineage section line naming siblings: `Alongside`. */
export const SUBAGENT_LINEAGE_ALONGSIDE = 'Alongside';

/** Worktree rows (D18). */
export const SUBAGENT_WORKTREE_CHECKOUT = 'Checkout';
export const SUBAGENT_WORKTREE_STARTED_FROM = 'Started from';
export const SUBAGENT_WORKTREE_CHANGES = 'Changes';
export const SUBAGENT_WORKTREE_HISTORY = 'History';
export const SUBAGENT_WORKTREE_APPLIED = 'Applied';

const checkoutLabels: Readonly<
  Record<'retained' | 'discarded' | 'missing', string>
> = {
  retained: 'Isolated · kept',
  discarded: 'Isolated · discarded',
  missing: 'Isolated · missing',
};

/** Worktree `Checkout` value. */
export function subagentCheckoutLabel(
  checkout: 'retained' | 'discarded' | 'missing',
): string {
  return checkoutLabels[checkout];
}

const applyLabels: Readonly<
  Record<'not_applied' | 'applied' | 'apply_failed' | 'discarded', string>
> = {
  not_applied: 'Not applied',
  applied: 'Applied',
  apply_failed: "Couldn't apply",
  discarded: 'Discarded',
};

/** Worktree `Applied` value. */
export function subagentApplyStateLabel(
  state: 'not_applied' | 'applied' | 'apply_failed' | 'discarded',
): string {
  return applyLabels[state];
}

/** Worktree `Started from` branch suffix: `on main`. */
export function subagentStartingBranchLabel(branch: string): string {
  return `on ${branch}`;
}

/** Worktree `History`: `2 commits, 1 untracked file`. */
export function subagentHistoryLabel(
  commits: number,
  untracked: number,
): string {
  return `${commits} ${commits === 1 ? 'commit' : 'commits'}, ${untracked} untracked ${untracked === 1 ? 'file' : 'files'}`;
}

/** Shown under the top files when the list was cut. */
export function subagentTopFilesShownLabel(shown: number): string {
  return `Showing ${shown} ${shown === 1 ? 'file' : 'files'}`;
}

/** Isolated delegates start from a commit, without uncommitted changes. */
export const SUBAGENT_WORKTREE_NO_UNCOMMITTED_NOTE =
  'Started without your uncommitted changes.';

/** Worktree summary states. */
export const SUBAGENT_WORKTREE_LOADING_LABEL = 'Loading worktree…';
export const SUBAGENT_WORKTREE_FAILED_LABEL = "Couldn't read the worktree.";
export const SUBAGENT_WORKTREE_UNAVAILABLE_LABEL =
  "Worktree details aren't available here";

/** Reuses the card's action label. */
export const SUBAGENT_SHOW_CHANGES_LABEL = 'Show changes';

// ---------------------------------------------------------------------------
// Subagent chat panel: transcript

/** Header of the parent's first message: `Task from Plan the slices`. */
export function subagentTaskFromLabel(sender: string): string {
  return `Task from ${sender}`;
}

/** Header of a later parent message: `Follow-up from Plan the slices`. */
export function subagentFollowUpFromLabel(sender: string): string {
  return `Follow-up from ${sender}`;
}

/** Header of a delegate's request for steering: `Steering request from Port handlers`. */
export function subagentSteeringRequestFromLabel(sender: string): string {
  return `Steering request from ${sender}`;
}

/** Header of a delegate's steering request whose sender is unknown. */
export const SUBAGENT_STEERING_REQUEST_LABEL = 'Steering request';

/** Body of a message that only carries instructions the model sees. */
export const SUBAGENT_HIDDEN_INSTRUCTIONS_LABEL = 'Hidden system instructions';

/** A list row's expand/collapse toggle: `Collapse Port handlers`. */
/** Verb of a row's expand toggle; named with the title like the open control. */
export function subagentsToggleRowLabel(collapsed: boolean): string {
  return collapsed ? 'Expand' : 'Collapse';
}

/** Older transcript items page in from the delegation record. */
export const SUBAGENT_LOAD_OLDER_LABEL = 'Show earlier messages';

/** Divider before a later run of the same subagent: `Run 2`. */
export function subagentRunDividerLabel(runGeneration: number): string {
  return `Run ${runGeneration}`;
}

// ---------------------------------------------------------------------------
// Subagent chat panel: composer

/** The To capsule's caption. */
export const SUBAGENT_COMPOSER_TO_LABEL = 'To';

/** The To menu heading. */
export const SUBAGENT_COMPOSER_TO_MENU_LABEL = 'Send to';

/** The To capsule's accessible name: `Send to Port handlers`. */
export function subagentComposerToAccessibleLabel(title: string): string {
  return `Send to ${title}`;
}

/** Where a recipient sits relative to this subagent (D20). */
export function subagentRecipientRelationLabel(
  recipient: Pick<SubagentRecipient, 'kind' | 'levelsUp' | 'canMessage'>,
): string {
  if (recipient.kind === 'self')
    return recipient.canMessage
      ? 'This subagent'
      : 'This subagent · interrupt only';
  if (recipient.kind === 'root')
    return recipient.levelsUp <= 1 ? 'Parent · root chat' : 'Root chat';
  return recipient.levelsUp === 1
    ? 'Parent'
    : `${recipient.levelsUp} levels up`;
}

/** A root chat recipient's state, which the tree does not carry. */
export function subagentRootChatStateLabel(busy: boolean): string {
  return busy ? 'Working' : 'Idle';
}

/** The input's placeholder by recipient (D20, D22, D26). */
export function subagentComposerPlaceholder(
  recipient: Pick<SubagentRecipient, 'kind' | 'title' | 'canMessage'>,
  busy: boolean,
): string {
  if (!recipient.canMessage) return SUBAGENT_COMPOSER_NATIVE_NOTICE;
  if (recipient.kind === 'self')
    return busy
      ? 'Message this subagent'
      : 'Message this subagent to start a new run';
  if (recipient.kind === 'root') return 'Ask the root chat about this subagent';
  return `Ask ${recipient.title} about this subagent`;
}

/** A native subagent's own row cannot take messages (D26). */
export const SUBAGENT_COMPOSER_NATIVE_NOTICE =
  "This subagent can't take messages. Choose its parent in To to ask about it.";

/** Read-only notice when the host cannot deliver messages at all. */
export const SUBAGENT_COMPOSER_READ_ONLY_NOTICE =
  "Messaging subagents isn't available here";

/** Send's tooltip and accessible name. */
export const SUBAGENT_COMPOSER_SEND_LABEL = 'Send';
export const SUBAGENT_COMPOSER_SEND_ACCESSIBLE_LABEL = 'Send message';

/** Send's tooltip for any other recipient: `Send and open Plan the slices`. */
export function subagentComposerSendAndOpenLabel(title: string): string {
  return `Send and open ${title}`;
}

/** The composer's interrupt, the panel's only stop (D21). */
export const SUBAGENT_COMPOSER_INTERRUPT_LABEL = 'Interrupt this subagent';

/** Interrupt's reason when the host cannot interrupt this subagent. */
export const SUBAGENT_COMPOSER_INTERRUPT_UNAVAILABLE_LABEL =
  "Interrupting this subagent isn't available here";

/** Inline errors on a queued draft (Retry keeps it). */
export const SUBAGENT_QUEUE_RETRY_LABEL = 'Try again';
export const SUBAGENT_QUEUE_SEND_FAILED_LABEL = "Couldn't send the message.";
export const SUBAGENT_SEND_FAILED_LABEL = "Couldn't send the message.";
export const SUBAGENT_INTERRUPT_FAILED_LABEL =
  "Couldn't interrupt the subagent.";

/** Error text when the host gives no reason. */
export function subagentFailureWithReason(
  prefix: string,
  reason: string | undefined,
): string {
  const trimmed = reason?.trim();
  return trimmed ? `${prefix} ${trimmed}` : prefix;
}

// ---------------------------------------------------------------------------
// Attached-subagent chips

/** Spoken before an attached-subagent chip's title: `About Port handlers`. */
export const SUBAGENT_REFERENCE_PREFIX = 'About';

/** Accessible name of an attached-subagent chip: `About Port handlers`. */
export function subagentReferenceAccessibleLabel(title: string): string {
  return `About ${title || SUBAGENT_UNTITLED_LABEL}`;
}

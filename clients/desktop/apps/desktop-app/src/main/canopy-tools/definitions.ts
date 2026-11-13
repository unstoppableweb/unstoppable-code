import type {
  WorkEntryAutoDeleteTeardown,
  WorkEntryAutoDeleteUnmergedBranch,
} from '@canopy/protocol';
import { sharingOpenDialogSchema } from '@canopy/desktop-shared/lib/sharing-action-schema';
import { scopedSidebarItemGroupSchemas } from './sidebar-item-group-schema';
import { SIDEBAR_ITEM_GROUP_COLORS } from '@canopy/protocol/sidebar';
import { z } from 'zod/v4';
import { BRAND } from '@canopy/brand/current';
import {
  buildSearchWatchersJsonSchema,
  agentActionDispatchJsonSchema,
  buildSetupWatchersJsonSchema,
  createDispatchActionInputSchema,
  createSearchWatchersInputSchema,
  createSetupWatchersInputSchema,
  DELETE_WATCHERS_JSON_SCHEMA,
  deleteWatchersDescription,
  deleteWatchersInputSchema,
  dispatchActionDescription,
  BROWSER_ACTION_TYPES,
  browserDispatchJsonSchema,
  ENVIRONMENT_ACTION_TYPES,
  INSTALLED_ITEM_ACTION_TYPES,
  installedItemDispatchJsonSchema,
  EXPERIMENT_ACTION_TYPES,
  BOT_ACTION_TYPES,
  botDispatchJsonSchema,
  PROJECT_ACTION_TYPES,
  projectDispatchJsonSchema,
  CAPABILITY_PACKAGE_ACTION_TYPES,
  capabilityPackageDispatchJsonSchema,
  experimentDispatchJsonSchema,
  PIPELINES_ACTION_TYPES,
  pipelinesDispatchJsonSchema,
  PIPELINE_EXECUTIONS_ACTION_TYPES,
  pipelineExecutionsDispatchJsonSchema,
  SETTINGS_ACTION_TYPES,
  settingsDispatchJsonSchema,
  environmentDispatchJsonSchema,
  findUiOnlyActionField,
  SEARCH_ACTIONS_JSON_SCHEMA,
  searchActionsDescription,
  searchActionsInputSchema,
  SEARCHABLE_WATCHER_TRIGGERS,
  searchWatchersDescription,
  SETUP_WATCHER_TRIGGERS,
  setupWatchersDescription,
  START_SPLIT_AGENT_JSON_SCHEMA,
  startSplitAgentInputSchema,
  TRANSCRIPT_READ_ACTION_TYPES,
  transcriptReadDispatchJsonSchema,
  type AgentActionBrand,
  type AgentActionFamilyJsonSchema,
  type AgentChatCreatePlacement,
  type AgentJsonSchema,
} from '@canopy/agent-actions';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  validateAutomationActionForWrite,
  validateAutomationCreateRequest,
  validateAutomationIfCommand,
  validateAutomationTrigger,
} from '@canopy/desktop-shared/lib/automations';
import { SUPPORTED_HOOK_TRIGGERS } from '@canopy/desktop-shared/hooks';
import {
  CODE_GRAPH_IMPACT_MAX_DEPTH,
  CODE_GRAPH_IMPACT_MAX_NODES,
  CODE_GRAPH_QUERY_MODES,
  CODE_GRAPH_TOOL_MAX_RESULTS,
} from '@canopy/desktop-shared/types/code-graph-tools';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import {
  type AutomationCreateRequest,
  type AutomationUpdateRequest,
  GITHUB_WORKFLOW_JOB_CONCLUSIONS,
  GITHUB_WORKFLOW_RUN_CONCLUSIONS,
  GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES,
} from '@canopy/desktop-shared/types';
import type { PrMergeQueueKnownPhase } from '@canopy/desktop-shared/types/github';
import { PR_MERGE_QUEUE_KNOWN_PHASES } from '@canopy/desktop-shared/lib/pr-merge-queue';
import { validatePipelineRuntimeIdentifier } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import {
  LedgerAddEntryToolInputSchema,
  LedgerSearchEntriesToolInputSchema,
  LedgerUpdateEntryToolInputSchema,
} from '@canopy/protocol/canopy-core';

const appName = BRAND.displayName;

/** Longest a worktree.run_script call may wait for its run to finish. */
export const MAX_SCRIPT_WAIT_SECONDS = 600;

export const pipelineRuntimeIdentifierSchema = z
  .string()
  .superRefine((value, context) => {
    try {
      validatePipelineRuntimeIdentifier(value, 'pipeline runtime identifier');
    } catch (error: unknown) {
      context.addIssue({
        code: 'custom',
        message:
          error instanceof Error
            ? error.message
            : 'Invalid pipeline runtime identifier',
      });
    }
  });
const watchGitHubItemsToolName =
  CANOPY_INJECTED_TOOL_REGISTRY.watch_github_items.codexToolName;

/** This app's brand as the shared agent action tools describe it. */
export const AGENT_ACTION_BRAND: AgentActionBrand = {
  displayName: BRAND.displayName,
  toolNamespace: BRAND.tools.namespace,
};

export const ASK_USER_QUESTION_DESCRIPTION =
  'Collect user decisions and parameters inline in chat. Use control buttons for choices, select for a picker, or text, textarea, number, date for form fields (with options: []). Set required for mandatory answers. Omit control for the usual options with an Other free-form answer. The user must explicitly submit; a selection never grants permission automatically.';

export const GET_SCRIPT_OUTPUT_DESCRIPTION =
  'Read output from a worktree script run such as setup, launch, teardown, workspace-root lifecycle scripts, or custom repo scripts. Also accepts the watcher output scriptId from WatchCommand to resolve a bounded preview and full file path after archive/restore. Use when asked to check script logs or output';

export const GET_GIT_PREFERENCES_DESCRIPTION =
  'Read the user\'s saved Git preferences for worktree chat tasks. Use type "branch-name" before naming or renaming branches, "pr-generation" before drafting pull request titles/descriptions, and "commit-message" before writing commit messages.';

export const SAVE_MEMORY_DESCRIPTION =
  'Save durable local memory. Use user scope for personal preferences that apply everywhere, and workspace scope for facts about this repo or project. An explicit "remember this" request from the user MUST trigger this tool.';

export const SEARCH_MEMORY_DESCRIPTION =
  'Search local memory across both user and workspace scopes. Returns matching files with topic or inbox heading context and readable snippets. SearchMemory finds memory files; ReadMemory opens one.';

export const READ_MEMORY_DESCRIPTION =
  'Open one local memory file returned by SearchMemory and read its normalized content. SearchMemory finds memory files; ReadMemory opens one. Files are limited to MEMORY.md or one .md file directly under topics/ or inbox/.';

export const READ_PIPELINE_YAML_DESCRIPTION =
  'Read the raw YAML definition for a pipeline in the current project scope. Supports full reads, line number ranges, and grep-like filtering options including pattern, fixed string matching, ignore case, inverted matches, before/after context, and max matches.';

export const SHOW_FILES_DESCRIPTION =
  'Open one or more files in a file panel beside this agent chat. Always use this tool when the user asks to see a file or a section of a file. Present requested deliverables and files the user should review, never internal workflow state, scheduling JSON, logs, caches, checkpoints, or temporary bookkeeping unless the user explicitly asks. Automation-origin requests are deferred without opening panels; other agent requests during a browser handoff open in the background. Report the returned opened, activated, and deferred outcomes accurately. Supports up to 10 files in requested tab order; foreground requests activate the first valid file. Optional annotations are non-destructive raw-line markers; an annotation comment starts a comment thread the user can reply to and submit back to an agent. line and annotation ranges are 1-based raw-file lines. view defaults to rich; unsupported line/view options for an otherwise valid file are ignored. HTML pages open rendered in the in-app browser, where their linked styles and scripts load; pass view: "raw", a line, or annotations to show the page source instead. Valid files still open when other requested files fail.';

export const SHOW_VISUAL_DESCRIPTION =
  'Show a complete HTML visual for charts, comparisons, timelines, collages, or UI mockups; prefer a mermaid fence for simple diagrams and markdown for short tables. Do not hide essentials behind hover or a click, and never move focus by script. Use a borderless, fluid reply-column layout without outer padding or a title banner; give charts fixed pixel heights. Use injected theme variables, not hardcoded colors. Inline data and workspace images; only pinned, allowlisted CDN scripts and styles may load. Fetch, XHR, WebSockets, and remote images are blocked. Aim well under 1 MiB and downscale screenshots. Links open externally rather than navigating the frame. After showing the visual, do not announce, describe, or restate it.';

export const GET_FILE_COMMENTS_DESCRIPTION =
  "Read file, diff, and Change Diagram comment threads in this chat's project, and tracked-plan comment threads. Diff anchors include comparison source, snapshot and old/new side; their coordinates are not current-file coordinates. A plan thread reports the plan, its latest revision, the comment's source (document passage, diagram node, or general note), its anchor, and whether that anchor still matches the latest revision. Provide a threadId to read that thread's file location, selected text, and full submitted comment history. Omit threadId to summarize every open file, diff, diagram, or plan thread. Staged user drafts are redacted until the user submits them.";

export const RESPOND_TO_FILE_COMMENT_DESCRIPTION =
  "Post an agent reply to a file, diff, or Change Diagram comment thread in this chat's project, or to a tracked-plan comment thread. Provide the threadId and reply body. Set resolve: true after you have answered the question or applied the requested change; omit it when asking for clarification or intentionally leaving the thread open. Plan replies and resolutions sync to that plan's shared collaborators when it is shared. A thread made only of unsubmitted drafts cannot be replied to. Use GetFileComments first when you need the thread id or history.";

export const SEARCH_ACTIONS_DESCRIPTION =
  searchActionsDescription(AGENT_ACTION_BRAND);

export const DISPATCH_ACTION_DESCRIPTION =
  dispatchActionDescription(AGENT_ACTION_BRAND);

export const SEARCH_WATCHERS_DESCRIPTION =
  searchWatchersDescription(AGENT_ACTION_BRAND);

export const WATCH_GITHUB_ITEMS_DESCRIPTION = `Create one durable watcher for 1–20 GitHub items of one kind, either GitHub Actions workflow runs or pull requests, and notify this same chat. Workflow runs: report selected future run changes or completed jobs. For every completed job use {"notifyOn":{"jobs":{"conclusions":"any"}}}; for whole-run lifecycle changes use notifyOn.run.statuses and/or notifyOn.run.conclusions. Run items may be bare run ids, owner/repository#run_id references, or GitHub run, attempt, job, or step URLs; a job/step URL only identifies its parent run and does not itself select job notifications. Pull requests: pass {"kind":"pull_request","target":"<PR URL or owner/repository#number>"}. The watcher always wakes when a PR merges, closes without merging, or is removed from the merge queue (with GitHub's reason when verifiable), and keeps watching after a removal. To also wake on queue entry or phase moves, add notifyOn.queue, for example {"notifyOn":{"queue":{"entered":true}}} or {"notifyOn":{"queue":{"phases":["unmergeable"]}}}; position-only changes never wake. notifyOn.run and notifyOn.jobs are for workflow runs only. A pull request that is already merged or closed is reported per item in the result and is not watched. Do not mix runs and pull requests in one call. Use ${watchGitHubItemsToolName} instead of gh run watch, gh pr view, repeated status checks, shell polling loops, or keeping the agent turn open. ${appName} captures the destination server-side; never provide destination, runtime, display, retry, or delivery state.`;

/**
 * GetGitHubPullRequestStatus description, naming the WatchGitHubItems tool the
 * surface advertises so the read and the watcher steer to each other.
 */
export function buildGetGitHubPullRequestStatusDescription(
  watchGitHubItemsName: string,
): string {
  return `Read one GitHub.com pull request's current status from ${appName}'s shared, briefly cached read model: state (open, closed, merged), draft, head and base branches, head commit, mergeability, review decision, a checks summary with failing check names, and merge queue position. Pass pullRequest as a pull request URL or owner/repository#number. Read-only: repeated and concurrent reads share one GitHub request, and fetchedAt says how fresh the result is. Use it for a one-off status check instead of gh pr view, gh pr checks, or gh api. To wait for CI, a merge, a close, or a merge queue change, use ${watchGitHubItemsName} instead of calling this repeatedly. Never poll GitHub from the shell (gh pr checks --watch, gh run watch, or repeated gh pr view or gh api loops): agents and ${appName} share one GitHub rate limit.`;
}

export const GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION =
  buildGetGitHubPullRequestStatusDescription(
    `WatchGitHubItems / ${watchGitHubItemsToolName}`,
  );

export const DELETE_WATCHERS_DESCRIPTION =
  deleteWatchersDescription(AGENT_ACTION_BRAND);

export const RESPOND_TO_REVIEW_COMMENT_DESCRIPTION =
  'Post a reply to a specific code-review comment thread. Provide the threadId and your reply body. Set resolve: true to mark the thread resolved once you have addressed it (answered the question or applied the requested fix); leave resolve unset to keep the thread open, such as when you are asking for clarification. Use GetReviewComments first if you need the thread id or its history.';

export const GET_REVIEW_COMMENTS_DESCRIPTION =
  "Read code-review comment threads. Provide a threadId to read that thread's anchored diff excerpt and full comment history (author, body, time, status). Omit threadId to get a summary of all OPEN threads (id, anchor, comment count, status). Read-only.";

export const REPORT_STRUCTURED_RESULT_DESCRIPTION =
  'Report the final structured result for this worker task. Call this exactly once with arguments that match the provided JSON Schema, then stop.';

export const SETUP_WATCHERS_DESCRIPTION =
  setupWatchersDescription(AGENT_ACTION_BRAND);

export const SET_AUTO_ARCHIVE_DESCRIPTION =
  'Archive this chat (only this chat) when the active agent turn fully completes. Set enabled to true to enable chat auto-archive, or false to keep this chat open. Other chats and future sessions are unaffected. Use SetWorkEntryAutoDelete to remove the whole worktree or work entry instead.';

export const SET_WORK_ENTRY_AUTO_DELETE_DESCRIPTION =
  'Arm removal of this chat’s own worktree, Cowork work entry, or Orchestrator work entry once fully idle: no agents, workflows, or background work are active. Only the owning root chat can call this tool; delegates cannot. Set enabled to true to arm or replace an existing arm. Set enabled to false alone to turn it off. By default, Delete keeps a restorable archive for the retention window; archive: true keeps an archive until the user deletes it. Worktrees only: teardown defaults to error (a teardown failure stops removal); force removes without teardown if teardown fails. Worktrees only: unmergedLocalBranchDelete defaults to ask; error stops removal for an unmerged local branch, force deletes it. This branch option applies only when the Git setting “Delete fully merged branches on archive” is on. Both worktree-only options are rejected for Cowork and Orchestrator work entries. A recurring scheduled automation targeting this item makes the call fail. Failures turn auto-delete off and are reported back to this chat as a message. The result states the mode and what the item is waiting for.';

export const SET_BASE_BRANCH_DESCRIPTION =
  "Set the base branch for this chat's current worktree. The project and worktree are captured server-side and cannot be overridden. Provide repoId only for a multi-repository project. The operation reuses the visible base-branch UX, including branch availability checks, active-operation guards, pull-request alignment confirmation, stale-state protection, and canonical error reporting.";

const CODE_GRAPH_TARGET_FORM_NOTE =
  'Use the `path/to/file.ts::Parent.name` form for symbol targets (nested members separated by `.`); a bare file path targets the whole file.';
const CALL_CODE_GRAPH_CONTEXT_FIRST_NOTE =
  'Call GetCodeGraphContext first if you have not already.';
const CODE_GRAPH_QUERY_MODE_LIST = CODE_GRAPH_QUERY_MODES.join(', ');
// Shared verbatim between queryCodeGraphSchema's/queryCodeGraphJsonSchema's
// `target` field description AND QUERY_CODE_GRAPH_DESCRIPTION so the two
// hand-maintained schema copies and the tool-level description stay in
// lockstep. Spelled out because an agent reading renderer/preload call sites
// most plausibly sees the channel's STRING VALUE (its `signature`, e.g.
// `panel-layout:load`), not its bare declaration KEY (its `name`, e.g.
// `panelLayoutLoad`) -- without this note the obvious guess is "not found".
const CODE_GRAPH_IPC_CHANNEL_TARGET_NOTE =
  'For mode "ipc-channel", target is the channel\'s bare declaration key (e.g. `panelLayoutLoad`) or a qualified name (`path/to/file.ts::ipc.<key>`); its string value (e.g. `panel-layout:load`) also resolves it, as a fallback when the key lookup finds no match.';
const CODE_GRAPH_DERIVED_MODE_TARGET_NOTE =
  'target is ignored for modes "communities"/"hubs" (omit it); for mode "flows" it is an optional symbol qualified name filter (omit to list top flows overall, or provide one to list only flows containing that symbol). Every other mode requires target. Modes "call-path" (directed calls) and "relationship-path" (undirected explanation) also require to; the returned hops preserve edge direction and evidence, and distinguish no path from budget exhaustion.';
const CODE_GRAPH_TARGET_FIELD_DESCRIPTION = `Symbol qualified name (path/to/file.ts::Parent.name form) or file path, depending on mode. ${CODE_GRAPH_IPC_CHANNEL_TARGET_NOTE} ${CODE_GRAPH_DERIVED_MODE_TARGET_NOTE}`;

// --- Change-impact tool descriptions/schemas (Phase 4) ---------------------

const CODE_GRAPH_BASE_REF_NOTE =
  'baseRef defaults to a merge-base against origin/develop, then develop, then origin/main, then main (first of those that resolves); if none resolve, falls back to the literal HEAD (a working-tree-vs-HEAD diff).';
const CODE_GRAPH_BASE_REF_PARAM_DESCRIPTION =
  'Git ref/branch/commit to diff against. Omit to use the default resolution chain: merge-base against origin/develop, then develop, then origin/main, then main (first that resolves), else HEAD.';
const CODE_GRAPH_CHANGE_IMPACT_REPO_ID_DESCRIPTION =
  'Optional repo id/name for multi-repo projects. Omit to use the first repository in this worktree.';
const CODE_GRAPH_QUALIFIED_NAME_RESULT_NOTE =
  'Returned symbols use the same qualified-name form as every other code-graph tool (path/to/file.ts::Parent.name), so a hit can be fed straight into QueryCodeGraph, ExplainCodeSymbol, or GetImpactRadius.';

export const GET_CODE_GRAPH_CONTEXT_DESCRIPTION = `Read a lightweight status summary of the code graph for this worktree: whether it exists, how fresh it is, file/symbol/edge counts, and top communities by size. Call this first, before BuildOrUpdateCodeGraph, QueryCodeGraph, SearchCodeGraph, ExplainCodeSymbol, or GetImpactRadius, so you know whether a graph needs to be built.`;

export const BUILD_OR_UPDATE_CODE_GRAPH_DESCRIPTION = `Build a fresh code graph for this worktree, or incrementally update an existing one, by scanning and parsing source files. ${CALL_CODE_GRAPH_CONTEXT_FIRST_NOTE}`;

export const QUERY_CODE_GRAPH_DESCRIPTION = `Query the code graph in one of several modes: ${CODE_GRAPH_QUERY_MODE_LIST}. ${CODE_GRAPH_TARGET_FORM_NOTE} ${CODE_GRAPH_IPC_CHANNEL_TARGET_NOTE} ${CODE_GRAPH_DERIVED_MODE_TARGET_NOTE} ${CALL_CODE_GRAPH_CONTEXT_FIRST_NOTE}`;

export const SEARCH_CODE_GRAPH_DESCRIPTION = `Full-text search for symbols across the code graph by name or fragment. ${CALL_CODE_GRAPH_CONTEXT_FIRST_NOTE}`;

export const EXPLAIN_CODE_SYMBOL_DESCRIPTION = `Read full detail for a single symbol: its signature, location, callers, callees, tests, community, and up to 3 flows it participates in. ${CODE_GRAPH_TARGET_FORM_NOTE} ${CALL_CODE_GRAPH_CONTEXT_FIRST_NOTE}`;

export const GET_IMPACT_RADIUS_DESCRIPTION = `Compute the set of symbols transitively impacted by changing a given target, up to a bounded depth and node count. ${CODE_GRAPH_TARGET_FORM_NOTE} ${CALL_CODE_GRAPH_CONTEXT_FIRST_NOTE}`;

export const DETECT_CHANGED_SYMBOLS_DESCRIPTION = `List the code-graph symbols touched by the current diff against a base ref. ${CODE_GRAPH_BASE_REF_NOTE} ${CODE_GRAPH_QUALIFIED_NAME_RESULT_NOTE} Escalate to CompareChangeImpact for blast radius and a risk assessment, or GetReviewContext for a review-oriented summary with test gaps and priorities. ${CALL_CODE_GRAPH_CONTEXT_FIRST_NOTE}`;

export const COMPARE_CHANGE_IMPACT_DESCRIPTION = `Compute the change delta (added/removed/signature-changed symbols), transitive impact radius, and a risk assessment for the current diff against a base ref. ${CODE_GRAPH_BASE_REF_NOTE} ${CODE_GRAPH_QUALIFIED_NAME_RESULT_NOTE} ${CALL_CODE_GRAPH_CONTEXT_FIRST_NOTE}`;

export const GET_REVIEW_CONTEXT_DESCRIPTION = `Build a review-oriented summary of the current diff against a base ref: changed symbols with risk reasons, impacted files/tests, test gaps, and top review priorities. ${CODE_GRAPH_BASE_REF_NOTE} ${CODE_GRAPH_QUALIFIED_NAME_RESULT_NOTE} ${CALL_CODE_GRAPH_CONTEXT_FIRST_NOTE}`;

export const askUserQuestionSchema = z.object({
  questions: z.array(
    z
      .object({
        control: z
          .enum(['buttons', 'select', 'text', 'textarea', 'number', 'date'])
          .optional(),
        required: z.boolean().optional(),
        placeholder: z.string().max(200).optional(),
        question: z.string().describe('The question to ask'),
        options: z
          .array(z.string())
          .describe(
            'Available options to choose from; the person can also type their own answer',
          ),
        multiSelect: z
          .boolean()
          .optional()
          .describe('Allow selecting multiple options'),
      })
      .refine((question) => {
        if (!question.control) return true;
        if (question.control === 'buttons' || question.control === 'select')
          return (
            question.options.length > 0 &&
            question.options.every((option) => option.trim().length > 0) &&
            new Set(question.options).size === question.options.length
          );
        return question.options.length === 0 && !question.multiSelect;
      }, 'Choice controls need distinct non-empty options; form fields need options: [] and no multiSelect.'),
  ),
});

export const getScriptOutputSchema = z.object({
  scriptId: z.string().describe('Script name or canonical script key'),
  repo: z
    .string()
    .optional()
    .describe(
      'Repo id/name for multi-repo projects. Use "workspace-root" for workspace-root scripts.',
    ),
  maxLines: z
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .describe('Maximum lines to return. Defaults to 200.'),
});

export const getGitPreferencesSchema = z.object({
  type: z
    .enum(['branch-name', 'pr-generation', 'commit-message'])
    .describe('Which Git preference type to read.'),
});

export const saveMemorySchema = z.object({
  text: z.string().min(1).max(2000).describe('The durable fact to remember.'),
  scope: z
    .enum(['user', 'workspace'])
    .describe(
      'Use user for personal preferences that apply everywhere; use workspace for facts about this repo or project.',
    ),
});

export const searchMemorySchema = z.object({
  query: z.string().min(1).describe('Search text for local memory.'),
});

export const readMemorySchema = z.object({
  scope: z
    .enum(['user', 'workspace'])
    .describe('The scope shown for the SearchMemory result.'),
  file: z
    .string()
    .regex(/^(?:MEMORY\.md|(?:topics|inbox)\/[^/\\]+\.md)$/)
    .refine((file) => !file.includes('..'), {
      message: 'Memory file keys cannot contain traversal segments.',
    })
    .describe('An exact file key returned by SearchMemory.'),
});

const pipelineYamlRangeSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
  })
  .refine(
    (range) => range.endLine === undefined || range.startLine <= range.endLine,
    { message: 'startLine must be less than or equal to endLine.' },
  );

export const readPipelineYamlBaseSchema = z.object({
  pipelineId: z.string().describe('Pipeline id from pipeline.list.'),
  repoId: z
    .string()
    .optional()
    .describe(
      'Optional repo id/name for project-local pipeline YAML in multi-repo projects. Omit for workspace-root/default repo or user/bundled pipelines.',
    ),
  startLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Optional 1-based first line to include.'),
  endLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Optional 1-based final line to include.'),
  ranges: z
    .array(pipelineYamlRangeSchema)
    .max(20)
    .optional()
    .describe(
      'Optional explicit 1-based line ranges. When provided, ranges override startLine/endLine.',
    ),
  pattern: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional grep pattern. Regex by default; fixedString changes to literal matching.',
    ),
  fixedString: z
    .boolean()
    .optional()
    .describe(
      'Treat pattern as a literal string instead of a regular expression.',
    ),
  ignoreCase: z.boolean().optional().describe('Case-insensitive matching.'),
  invertMatch: z
    .boolean()
    .optional()
    .describe('Return lines that do not match the pattern.'),
  context: z
    .number()
    .int()
    .min(0)
    .max(200)
    .optional()
    .describe('Include this many lines before and after each match.'),
  beforeContext: z
    .number()
    .int()
    .min(0)
    .max(200)
    .optional()
    .describe(
      'Include this many lines before each match. Ignored when context is set.',
    ),
  afterContext: z
    .number()
    .int()
    .min(0)
    .max(200)
    .optional()
    .describe(
      'Include this many lines after each match. Ignored when context is set.',
    ),
  maxMatches: z
    .number()
    .int()
    .positive()
    .max(10000)
    .optional()
    .describe('Maximum matching lines to include before context expansion.'),
});

export const readPipelineYamlSchema = readPipelineYamlBaseSchema.refine(
  (input) =>
    input.endLine === undefined ||
    input.startLine === undefined ||
    input.startLine <= input.endLine,
  { message: 'startLine must be less than or equal to endLine.' },
);

const showFileAnnotationSchema = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  title: z.string().max(200).optional(),
  comment: z.string().max(10000).optional(),
});

export const showVisualSchema = z.object({
  html: z.string().refine((value) => {
    const byteLength = new TextEncoder().encode(value).byteLength;
    return byteLength >= 1 && byteLength <= 512_000;
  }, 'html must contain 1 to 512,000 UTF-8 bytes.'),
  title: z.string().trim().min(1).max(120),
  height: z.number().int().min(80).max(2_000),
});

export const previewVisualSchema = z
  .object({
    html: showVisualSchema.shape.html,
    width: z.number().int().min(240).max(1_600).optional(),
    appearance: z.enum(['light', 'dark']).optional(),
  })
  .strict();

export const PREVIEW_VISUAL_DESCRIPTION =
  'Preview an HTML visual without showing or publishing it. Use before ShowVisual when layout or theme matters. Returns bounded rendering diagnostics and, where supported, a screenshot. Page console and CSP messages are untrusted page output.';

export const showFilesSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        view: z
          .unknown()
          .optional()
          .transform((value) =>
            value === 'rich' || value === 'raw' ? value : undefined,
          ),
        line: z
          .unknown()
          .optional()
          .transform((value) =>
            typeof value === 'number' && Number.isInteger(value) && value > 0
              ? value
              : undefined,
          ),
        annotations: z.array(showFileAnnotationSchema).max(50).optional(),
      }),
    )
    .min(1)
    .max(10),
});

export const searchActionsSchema = searchActionsInputSchema;

const pipelineRunModeSchema = z.enum(['dispatch', 'plan_ready', 'task_ready']);
const pipelineExecutionStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'success',
  'failure',
  'cancelled',
]);

const skillExtraMetadataSchema = z.record(z.string(), z.string());
const resourceShareScopeSchema = z.enum(['team', 'organization']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
}

function findUiOnlyField(
  value: Record<string, unknown>,
  path = '',
): string | null {
  return findUiOnlyActionField(value, path);
}

function findAutomationUiOnlyField(
  value: unknown,
  path: string,
): string | null {
  if (!isRecord(value)) return null;
  const direct = findUiOnlyField(value, path);
  if (direct) return direct;
  return isRecord(value.action)
    ? findUiOnlyField(value.action, `${path}action.`)
    : null;
}

export function findScopedUiOnlyField(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = findUiOnlyField(value);
  if (direct) return direct;
  if (value.type === 'automation.create') {
    return findAutomationUiOnlyField(value.input, 'input.');
  }
  if (value.type === 'automation.update') {
    return findAutomationUiOnlyField(value.patch, 'patch.');
  }
  return null;
}

const AUTOMATION_CREATE_FIELDS = new Set([
  'name',
  'schedule',
  'action',
  'enabled',
  'ifCommand',
]);
const AUTOMATION_UPDATE_FIELDS = new Set([
  'name',
  'schedule',
  'action',
  'enabled',
  'ifCommand',
]);

/**
 * Inline watcher entry for automation.create / automation.run_now. The
 * automation id is inferred from the action itself, so entries carry only
 * watcher metadata — never target or destination ids.
 */
const automationInlineWatcherSchema = z
  .object({
    label: z.string().optional(),
    followUpInstruction: z.string().optional(),
    allowDuplicate: z.boolean().optional(),
  })
  .strict();

const genericAutomationCreateSchema = z.custom<AutomationCreateRequest>(
  (value) =>
    isRecord(value) &&
    Object.keys(value).every((key) => AUTOMATION_CREATE_FIELDS.has(key)) &&
    isJsonValue(value) &&
    findAutomationUiOnlyField(value, '') === null &&
    validateAutomationCreateRequest(value) === null,
);

const genericAutomationUpdateSchema = z.custom<
  Omit<AutomationUpdateRequest, 'id'>
>((value) => {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    !Object.keys(value).every((key) => AUTOMATION_UPDATE_FIELDS.has(key)) ||
    !isJsonValue(value) ||
    findAutomationUiOnlyField(value, '') !== null
  ) {
    return false;
  }
  const patch = value;
  return (
    (patch.name === undefined ||
      (typeof patch.name === 'string' && patch.name.trim().length > 0)) &&
    (patch.schedule === undefined ||
      validateAutomationTrigger(patch.schedule) === null) &&
    // Writes use the write-time validator (as create does) so an agent
    // cannot store an action a run would have to reject, e.g. Ultra fast on
    // a pipeline automation.
    (patch.action === undefined ||
      validateAutomationActionForWrite(patch.action) === null) &&
    (patch.enabled === undefined || typeof patch.enabled === 'boolean') &&
    validateAutomationIfCommand(patch.ifCommand) === null
  );
});

const scopedWorktreeActionBaseSchema = z.discriminatedUnion('type', [
  ...scopedSidebarItemGroupSchemas,
  sharingOpenDialogSchema,
  z.object({
    type: z.literal('skills.list'),
    query: z.string().optional(),
    customOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('skills.read'),
    sourceId: z.string().min(1),
    skillName: z.string().min(1),
  }),
  z.object({
    type: z.literal('skills.read_file'),
    sourceId: z.string().min(1),
    skillName: z.string().min(1),
    filePath: z.string().min(1),
  }),
  z.object({
    type: z.literal('skills.create_custom'),
    name: z.string().min(1),
    description: z.string(),
    body: z.string(),
    extraMetadata: skillExtraMetadataSchema.optional(),
  }),
  z
    .object({
      type: z.literal('skills.update_custom'),
      originalName: z.string().min(1),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      body: z.string().optional(),
      extraMetadata: skillExtraMetadataSchema.optional(),
    })
    .refine(
      (action) =>
        action.name !== undefined ||
        action.description !== undefined ||
        action.body !== undefined ||
        action.extraMetadata !== undefined,
      { message: 'skills.update_custom requires an update field.' },
    ),
  z.object({
    type: z.literal('skills.delete_custom'),
    name: z.string().min(1),
  }),
  z.object({
    type: z.literal('skills.list_shared'),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
    createdBy: z.enum(['me', 'anyone']).optional(),
  }),
  z.object({
    type: z.literal('skills.read_shared'),
    skillId: z.string().min(1),
  }),
  z.object({
    type: z.literal('skills.share_custom'),
    name: z.string().min(1),
    shareScope: resourceShareScopeSchema,
    teamId: z.string().optional(),
    organizationId: z.string().optional(),
  }),
  z.object({
    type: z.literal('skills.import_shared'),
    skillId: z.string().min(1),
  }),
  z.object({
    type: z.literal('skills.update_shared'),
    skillId: z.string().min(1),
    name: z.string().min(1),
  }),
  z.object({
    type: z.literal('skills.delete_shared'),
    skillId: z.string().min(1),
  }),
  z.object({
    type: z.literal('pipeline.list'),
    query: z.string().optional(),
    runModes: z.array(pipelineRunModeSchema).optional(),
    includeDisabled: z.boolean().optional(),
    limit: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.get'),
    pipelineId: z.string(),
    includeYaml: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('pipeline.create'),
    rawYaml: z.string().optional(),
    yamlFilePath: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
  }),
  z.object({
    type: z.literal('pipeline.update'),
    pipelineId: z.string().min(1),
    rawYaml: z.string().optional(),
    yamlFilePath: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
  }),
  z.object({
    type: z.literal('pipeline.delete'),
    pipelineId: z.string().min(1),
  }),
  z.object({
    type: z.literal('pipeline.duplicate'),
    pipelineId: z.string().min(1),
  }),
  z.object({
    type: z.literal('pipeline.share'),
    pipelineId: z.string().min(1),
    shareScope: resourceShareScopeSchema,
    teamId: z.string().optional(),
    organizationId: z.string().optional(),
    deleteLocal: z
      .boolean()
      .optional()
      .describe(
        'Deprecated and ignored. Sharing keeps the local pipeline; use pipeline.delete.',
      ),
  }),
  z.object({
    type: z.literal('pipeline.update_shared'),
    pipelineId: z.string().min(1).optional(),
    remoteId: z.string().min(1).optional(),
    rawYaml: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
  }),
  z.object({
    type: z.literal('pipeline.delete_shared'),
    pipelineId: z.string().min(1).optional(),
    remoteId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.set_enabled'),
    pipelineId: z.string().min(1),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('pipeline.execution_list_for_worktree'),
    query: z.string().optional(),
    pipelineId: z.string().optional(),
    status: pipelineExecutionStatusSchema.optional(),
    limit: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_list'),
    query: z.string().optional(),
    pipelineId: z.string().optional(),
    status: pipelineExecutionStatusSchema.optional(),
    limit: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_get'),
    executionId: z.string(),
    includeReport: z.boolean().optional(),
    includePlan: z.boolean().optional(),
    maxChars: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_cancel'),
    executionId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline.execution_resume'),
    executionId: z.string(),
    statusReasonIds: z.array(z.string().uuid()).min(1).optional(),
    pauseResponses: z
      .array(
        z.object({
          checkpointId: z.string().min(1),
          jobId: pipelineRuntimeIdentifierSchema,
          stepId: pipelineRuntimeIdentifierSchema,
          answers: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .optional(),
        }),
      )
      .min(1)
      .optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_retry_matrix_job'),
    executionId: z.string(),
    jobId: z.string(),
    mode: z.enum(['all', 'failed', 'variants', 'expansion']),
    variantJobIds: z.array(z.string()).min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_cancel_matrix_variant'),
    executionId: z.string(),
    jobId: z.string(),
    variantJobId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline.execution_retry'),
    executionId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline.execution_chain'),
    executionId: z.string(),
    pipelineId: z.string(),
    inputs: z.record(z.string(), z.string()).optional(),
    repoId: z.string().optional(),
  }),
  z.object({
    type: z.literal('tracked-plan.import'),
    filePath: z.string(),
    repoId: z.string(),
  }),
  z.object({ type: z.literal('worktree.get_settings') }),
  z.object({ type: z.literal('worktree.list_scripts') }),
  z.object({
    type: z.literal('worktree.run_script'),
    scriptId: z.string().min(1),
    repo: z.string().min(1).optional(),
    waitSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_SCRIPT_WAIT_SECONDS)
      .optional(),
  }),
  z.object({
    type: z.literal('hook.pause'),
    hookKey: z.string().optional(),
    all: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('hook.resume'),
    hookKey: z.string().optional(),
    all: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('automation.list'),
    includeRuns: z.boolean().optional(),
  }),
  z.object({ type: z.literal('automation.get'), id: z.string().min(1) }),
  z.object({
    type: z.literal('automation.create'),
    input: genericAutomationCreateSchema,
    watchers: z.array(automationInlineWatcherSchema).max(10).optional(),
  }),
  z.object({
    type: z.literal('automation.update'),
    id: z.string().min(1),
    patch: genericAutomationUpdateSchema,
  }),
  z.object({ type: z.literal('automation.disable'), id: z.string().min(1) }),
  z.object({ type: z.literal('automation.delete'), id: z.string().min(1) }),
  z.object({
    type: z.literal('automation.run_now'),
    id: z.string().min(1),
    watchers: z.array(automationInlineWatcherSchema).max(10).optional(),
  }),
]);

export const scopedWorktreeActionSchema =
  scopedWorktreeActionBaseSchema.superRefine((action, context) => {
    if (
      action.type === 'pipeline.execution_resume' &&
      action.statusReasonIds === undefined &&
      action.pauseResponses === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'pipeline.execution_resume requires statusReasonIds or pauseResponses from the observed pause.',
      });
    }
  });

/** The legacy desktop action schema, after server-side normalization. */
export const scopedDispatchActionSchema = scopedWorktreeActionSchema.transform(
  (action) => {
    if (action.type !== 'sidebar.item_groups.set_item') return action;
    if (action.newGroup !== undefined)
      return { type: action.type, newGroup: action.newGroup };
    if (action.groupId !== undefined)
      return { type: action.type, groupId: action.groupId };
    throw new Error('Group assignment destination is missing.');
  },
);

export const dispatchActionSchema = createDispatchActionInputSchema(
  scopedDispatchActionSchema,
  { findUiOnlyField: findScopedUiOnlyField },
);

export const searchWatchersSchema = createSearchWatchersInputSchema(
  SEARCHABLE_WATCHER_TRIGGERS,
);
export const setupWatchersSchema = createSetupWatchersInputSchema({
  triggers: SETUP_WATCHER_TRIGGERS,
  hookTriggerNames: SUPPORTED_HOOK_TRIGGERS,
});

export const deleteWatchersSchema = deleteWatchersInputSchema;

const githubWorkflowRunStatusSchema = z.enum(
  GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES,
);
const githubWorkflowRunConclusionSchema = z.enum(
  GITHUB_WORKFLOW_RUN_CONCLUSIONS,
);
const githubStatusSelectionSchema = z.union([
  z.literal('any'),
  z
    .array(githubWorkflowRunStatusSchema)
    .min(1)
    .max(GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES.length)
    .refine((statuses) => new Set(statuses).size === statuses.length, {
      message: 'statuses must not contain duplicates.',
    }),
]);
const githubConclusionSelectionSchema = z.union([
  z.literal('any'),
  z
    .array(githubWorkflowRunConclusionSchema)
    .min(1)
    .max(GITHUB_WORKFLOW_RUN_CONCLUSIONS.length)
    .refine((conclusions) => new Set(conclusions).size === conclusions.length, {
      message: 'conclusions must not contain duplicates.',
    }),
]);
const githubWorkflowJobConclusionSchema = z.enum(
  GITHUB_WORKFLOW_JOB_CONCLUSIONS,
);
const githubJobConclusionSelectionSchema = z.union([
  z.literal('any'),
  z
    .array(githubWorkflowJobConclusionSchema)
    .min(1)
    .max(GITHUB_WORKFLOW_JOB_CONCLUSIONS.length)
    .refine((conclusions) => new Set(conclusions).size === conclusions.length, {
      message: 'conclusions must not contain duplicates.',
    }),
]);

const githubRunNotificationSchema = z
  .object({
    statuses: githubStatusSelectionSchema
      .optional()
      .describe(
        'Future workflow-run lifecycle statuses such as queued, waiting, or in_progress. This does not report individual job progress.',
      ),
    conclusions: githubConclusionSelectionSchema
      .optional()
      .describe(
        'Terminal conclusions for the entire workflow run, such as success or failure.',
      ),
  })
  .strict()
  .refine(
    (selection) =>
      selection.statuses !== undefined || selection.conclusions !== undefined,
    { message: 'Select at least one run status or conclusion.' },
  );

const githubJobNotificationSchema = z
  .object({
    conclusions: githubJobConclusionSelectionSchema.describe(
      'Notify whenever an individual workflow job completes with a selected conclusion. Use "any" for every completed job.',
    ),
  })
  .strict();

function nonEmptyPhases(
  phases: readonly PrMergeQueueKnownPhase[],
): [PrMergeQueueKnownPhase, ...PrMergeQueueKnownPhase[]] {
  const [first, ...rest] = phases;
  if (first === undefined) throw new Error('No merge queue phases defined.');
  return [first, ...rest];
}

const PR_MERGE_QUEUE_WATCH_PHASES = nonEmptyPhases(PR_MERGE_QUEUE_KNOWN_PHASES);

const githubQueuePhaseSelectionSchema = z.union([
  z.literal('any'),
  z
    .array(z.enum(PR_MERGE_QUEUE_WATCH_PHASES))
    .min(1)
    .max(PR_MERGE_QUEUE_WATCH_PHASES.length)
    .refine((phases) => new Set(phases).size === phases.length, {
      message: 'phases must not contain duplicates.',
    }),
]);

const GITHUB_QUEUE_ENTERED_DESCRIPTION =
  'Also wake when the pull request enters or re-enters the merge queue.';
const GITHUB_QUEUE_PHASES_DESCRIPTION =
  'Also wake when the queue entry moves into one of these phases. Position-only changes never wake.';
const GITHUB_QUEUE_NOTIFICATION_DESCRIPTION =
  'Pull requests only. Optional merge queue notifications on top of the default merge, close, and queue-removal wakes.';

const githubQueueNotificationSchema = z
  .object({
    entered: z.boolean().optional().describe(GITHUB_QUEUE_ENTERED_DESCRIPTION),
    phases: githubQueuePhaseSelectionSchema
      .optional()
      .describe(GITHUB_QUEUE_PHASES_DESCRIPTION),
  })
  .strict()
  .refine(
    (selection) =>
      selection.entered !== undefined || selection.phases !== undefined,
    { message: 'Select queue.entered or queue.phases.' },
  );

const githubPositiveIntegerSchema = z.number().int().positive();

const WORKFLOW_RUN_NOTIFY_ON_KEYS = [
  'run',
  'jobs',
  'statuses',
  'conclusions',
] as const;

function isPullRequestItem(item: unknown): boolean {
  return (
    typeof item === 'object' &&
    item !== null &&
    'kind' in item &&
    item.kind === 'pull_request'
  );
}

const GITHUB_ITEMS_FIELD_DESCRIPTION =
  '1–20 items of one kind: workflow runs (bare ids, owner/repository#run_id, URLs, or {kind:"workflow_run"} objects) or pull requests ({kind:"pull_request"} objects). Do not mix kinds.';
const GITHUB_REPOSITORY_FIELD_DESCRIPTION =
  'Default GitHub owner/repository for bare workflow-run ids and numbered pull requests.';
const GITHUB_NOTIFY_ON_FIELD_DESCRIPTION =
  'Required for workflow runs: run and/or jobs. Pull requests always wake on merge, close without merging, and removal from the merge queue; queue is the only notifyOn key they accept.';

export const watchGitHubItemsSchema = z
  .object({
    items: z
      .array(
        z.union([
          z.string(),
          githubPositiveIntegerSchema,
          z
            .object({
              kind: z.literal('workflow_run'),
              target: z.union([z.string(), githubPositiveIntegerSchema]),
              repository: z.string().optional(),
              runAttempt: githubPositiveIntegerSchema.optional(),
            })
            .strict(),
          z
            .object({
              kind: z.literal('workflow_run'),
              repository: z.string().optional(),
              runId: z.union([z.string(), githubPositiveIntegerSchema]),
              runAttempt: githubPositiveIntegerSchema.optional(),
            })
            .strict(),
          z
            .object({
              kind: z.literal('pull_request'),
              target: z
                .string()
                .describe(
                  'A GitHub.com pull request URL or owner/repository#number.',
                ),
            })
            .strict(),
          z
            .object({
              kind: z.literal('pull_request'),
              repository: z.string().optional(),
              number: z.union([z.string(), githubPositiveIntegerSchema]),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(20)
      .describe(GITHUB_ITEMS_FIELD_DESCRIPTION),
    repository: z
      .string()
      .optional()
      .describe(GITHUB_REPOSITORY_FIELD_DESCRIPTION),
    notifyOn: z
      .object({
        run: githubRunNotificationSchema.optional(),
        jobs: githubJobNotificationSchema.optional(),
        statuses: githubStatusSelectionSchema
          .optional()
          .describe('Compatibility alias for run.statuses.'),
        conclusions: githubConclusionSelectionSchema
          .optional()
          .describe('Compatibility alias for run.conclusions.'),
        queue: githubQueueNotificationSchema
          .optional()
          .describe(GITHUB_QUEUE_NOTIFICATION_DESCRIPTION),
      })
      .strict()
      .refine(
        (selection) =>
          selection.statuses !== undefined ||
          selection.conclusions !== undefined ||
          selection.run !== undefined ||
          selection.jobs !== undefined ||
          selection.queue !== undefined,
        {
          message:
            'Select notifyOn.run or notifyOn.jobs for workflow runs, or notifyOn.queue for pull requests.',
        },
      )
      .optional()
      .describe(GITHUB_NOTIFY_ON_FIELD_DESCRIPTION),
    label: z.string().optional(),
    followUpInstruction: z.string().optional(),
    allowDuplicate: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const notifyOn = input.notifyOn;
    if (!notifyOn) return;
    const pullRequests = input.items.some(isPullRequestItem);
    const workflowRuns = input.items.some((item) => !isPullRequestItem(item));
    if (pullRequests) {
      for (const key of WORKFLOW_RUN_NOTIFY_ON_KEYS) {
        if (notifyOn[key] === undefined) continue;
        context.addIssue({
          code: 'custom',
          path: ['notifyOn', key],
          message: `notifyOn.${key} is for workflow runs. Pull requests accept only notifyOn.queue.`,
        });
      }
    }
    if (workflowRuns && notifyOn.queue !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['notifyOn', 'queue'],
        message: 'notifyOn.queue is for pull requests only.',
      });
    }
  });

const GITHUB_PULL_REQUEST_REFERENCE_FIELD_DESCRIPTION =
  'GitHub.com pull request URL (https://github.com/owner/repository/pull/123) or owner/repository#123.';

export const getGitHubPullRequestStatusSchema = z
  .object({
    pullRequest: z
      .string()
      .min(1)
      .max(512)
      .describe(GITHUB_PULL_REQUEST_REFERENCE_FIELD_DESCRIPTION),
  })
  .strict();

export const setAutoArchiveSchema = z
  .object({
    enabled: z
      .boolean()
      .describe(
        'Whether this chat should be archived automatically when the active turn completes.',
      ),
  })
  .strict();

const WORK_ENTRY_AUTO_DELETE_TEARDOWNS = [
  'error',
  'force',
] as const satisfies readonly WorkEntryAutoDeleteTeardown[];
const WORK_ENTRY_AUTO_DELETE_UNMERGED_BRANCHES = [
  'ask',
  'error',
  'force',
] as const satisfies readonly WorkEntryAutoDeleteUnmergedBranch[];
const WORK_ENTRY_AUTO_DELETE_ENABLED_DESCRIPTION =
  'True arms or replaces removal of this chat’s own work entry when fully idle. False turns it off and accepts no other options.';
const WORK_ENTRY_AUTO_DELETE_ARCHIVE_DESCRIPTION =
  'Archive until the user deletes the archive instead of Delete (restorable for the retention window). Default false.';
const WORK_ENTRY_AUTO_DELETE_TEARDOWN_DESCRIPTION =
  'Worktrees only. On teardown failure: error stops removal; force removes without teardown. Default error. Rejected for work entries.';
const WORK_ENTRY_AUTO_DELETE_BRANCH_DESCRIPTION =
  'Worktrees only, when Git settings → “Delete fully merged branches on archive” is on. For unmerged local branches: ask waits for the user, error stops removal, force deletes the branch. Default ask. Rejected for work entries.';

export const setWorkEntryAutoDeleteSchema = z
  .object({
    enabled: z.boolean().describe(WORK_ENTRY_AUTO_DELETE_ENABLED_DESCRIPTION),
    archive: z
      .boolean()
      .optional()
      .describe(WORK_ENTRY_AUTO_DELETE_ARCHIVE_DESCRIPTION),
    teardown: z
      .enum(WORK_ENTRY_AUTO_DELETE_TEARDOWNS)
      .optional()
      .describe(WORK_ENTRY_AUTO_DELETE_TEARDOWN_DESCRIPTION),
    unmergedLocalBranchDelete: z
      .enum(WORK_ENTRY_AUTO_DELETE_UNMERGED_BRANCHES)
      .optional()
      .describe(WORK_ENTRY_AUTO_DELETE_BRANCH_DESCRIPTION),
  })
  .strict();

export const setBaseBranchSchema = z
  .object({
    baseBranch: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !value.startsWith('-') && value !== 'HEAD', {
        message: 'baseBranch must be a valid branch name and cannot be HEAD.',
      })
      .describe('Local or origin branch to track as the worktree base.'),
    repoId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Repository id for a multi-repository project. Omit for a single-repository project.',
      ),
  })
  .strict();

export const getCodeGraphContextSchema = z.object({}).strict();

export const buildOrUpdateCodeGraphSchema = z.object({}).strict();

const codeGraphDetailLevelSchema = z.enum(['minimal', 'standard']);

export const queryCodeGraphSchema = z.object({
  mode: z
    .enum(CODE_GRAPH_QUERY_MODES)
    .describe(`Query mode. One of: ${CODE_GRAPH_QUERY_MODES.join(', ')}.`),
  // Required for every mode except 'communities'/'hubs' (ignored) and
  // 'flows' (optional symbol filter) — see CODE_GRAPH_DERIVED_MODE_TARGET_NOTE.
  target: z
    .string()
    .min(1)
    .optional()
    .describe(CODE_GRAPH_TARGET_FIELD_DESCRIPTION),
  to: z
    .string()
    .min(1)
    .optional()
    .describe('Second endpoint for call-path or relationship-path.'),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe('Path depth budget (default 6, maximum 12).'),
  maxNodes: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Path visited-node budget (default 200, maximum 500).'),
  repoId: z
    .string()
    .optional()
    .describe(
      'Optional repo id/name for multi-repo projects. Omit for a single-repo worktree.',
    ),
  detailLevel: codeGraphDetailLevelSchema
    .optional()
    .describe(
      'minimal (default) returns up to 5 hits; standard returns up to `limit` hits.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CODE_GRAPH_TOOL_MAX_RESULTS)
    .optional()
    .describe(
      `Maximum hits to return at detailLevel "standard" (1-${CODE_GRAPH_TOOL_MAX_RESULTS}).`,
    ),
});

export const searchCodeGraphSchema = z.object({
  query: z.string().min(1).describe('Search text for symbol name or fragment.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CODE_GRAPH_TOOL_MAX_RESULTS)
    .optional()
    .describe(
      `Maximum hits to return at detailLevel "standard" (1-${CODE_GRAPH_TOOL_MAX_RESULTS}).`,
    ),
  detailLevel: codeGraphDetailLevelSchema
    .optional()
    .describe(
      'minimal (default) returns up to 5 hits; standard returns up to `limit` hits.',
    ),
});

export const explainCodeSymbolSchema = z.object({
  qualifiedName: z
    .string()
    .min(1)
    .describe('Symbol qualified name in path/to/file.ts::Parent.name form.'),
  repoId: z
    .string()
    .optional()
    .describe(
      'Optional repo id/name for multi-repo projects. Omit for a single-repo worktree.',
    ),
});

export const getImpactRadiusSchema = z.object({
  target: z
    .string()
    .min(1)
    .describe(
      'Symbol qualified name (path/to/file.ts::Parent.name form) or file path.',
    ),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(CODE_GRAPH_IMPACT_MAX_DEPTH)
    .optional()
    .describe(`Maximum traversal depth (1-${CODE_GRAPH_IMPACT_MAX_DEPTH}).`),
  maxNodes: z
    .number()
    .int()
    .min(1)
    .max(CODE_GRAPH_IMPACT_MAX_NODES)
    .optional()
    .describe(`Maximum impacted nodes (1-${CODE_GRAPH_IMPACT_MAX_NODES}).`),
  detailLevel: codeGraphDetailLevelSchema
    .optional()
    .describe(
      'minimal (default) returns up to 5 hits; standard returns up to maxNodes hits.',
    ),
});

export const detectChangedSymbolsSchema = z.object({
  baseRef: z
    .string()
    .optional()
    .describe(CODE_GRAPH_BASE_REF_PARAM_DESCRIPTION),
  repoId: z
    .string()
    .optional()
    .describe(CODE_GRAPH_CHANGE_IMPACT_REPO_ID_DESCRIPTION),
  detailLevel: codeGraphDetailLevelSchema
    .optional()
    .describe(
      'minimal (default) returns up to 5 changed symbols; standard returns up to 200.',
    ),
});

export const compareChangeImpactSchema = z.object({
  baseRef: z
    .string()
    .optional()
    .describe(CODE_GRAPH_BASE_REF_PARAM_DESCRIPTION),
  repoId: z
    .string()
    .optional()
    .describe(CODE_GRAPH_CHANGE_IMPACT_REPO_ID_DESCRIPTION),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(CODE_GRAPH_IMPACT_MAX_DEPTH)
    .optional()
    .describe(`Maximum traversal depth (1-${CODE_GRAPH_IMPACT_MAX_DEPTH}).`),
  detailLevel: codeGraphDetailLevelSchema
    .optional()
    .describe(
      'minimal (default) returns up to 5 items per list field; standard returns full lists (capped at 200 for added/removed/signature-changed and impacted symbols).',
    ),
});

export const getReviewContextSchema = z.object({
  baseRef: z
    .string()
    .optional()
    .describe(CODE_GRAPH_BASE_REF_PARAM_DESCRIPTION),
  repoId: z
    .string()
    .optional()
    .describe(CODE_GRAPH_CHANGE_IMPACT_REPO_ID_DESCRIPTION),
  detailLevel: codeGraphDetailLevelSchema
    .optional()
    .describe(
      'minimal (default) returns up to 5 items per list field; standard returns full lists (capped at 200 changed symbols).',
    ),
});

export const respondToCommentSchema = z.object({
  threadId: z.string().describe('Id of the comment thread to reply to'),
  body: z.string().describe('Reply text posted as an agent comment'),
  resolve: z
    .boolean()
    .optional()
    .describe('Mark the thread resolved after replying'),
});

export type RespondToCommentArgs = z.infer<typeof respondToCommentSchema>;

export const getReviewCommentsSchema = z.object({
  threadId: z
    .string()
    .optional()
    .describe(
      'Optional comment thread id. Omit to summarize all open threads.',
    ),
});

export type GetReviewCommentsArgs = z.infer<typeof getReviewCommentsSchema>;

export const getFileCommentsSchema = getReviewCommentsSchema;
export type GetFileCommentsArgs = z.infer<typeof getFileCommentsSchema>;

export const respondToFileCommentSchema = respondToCommentSchema;
export type RespondToFileCommentArgs = z.infer<
  typeof respondToFileCommentSchema
>;

export type AskUserQuestionArgs = z.infer<typeof askUserQuestionSchema>;
export type GetScriptOutputArgs = z.infer<typeof getScriptOutputSchema>;
export type GetGitPreferencesArgs = z.infer<typeof getGitPreferencesSchema>;
export type SaveMemoryArgs = z.infer<typeof saveMemorySchema>;
export type SearchMemoryArgs = z.infer<typeof searchMemorySchema>;
export type ReadMemoryArgs = z.infer<typeof readMemorySchema>;
export type ReadPipelineYamlArgs = z.infer<typeof readPipelineYamlSchema>;
export type SearchActionsArgs = z.infer<typeof searchActionsSchema>;
export type DispatchActionArgs = z.infer<typeof dispatchActionSchema>;
export type SearchWatchersArgs = z.infer<typeof searchWatchersSchema>;
export type SetupWatchersArgs = z.infer<typeof setupWatchersSchema>;
export type WatchGitHubItemsArgs = z.infer<typeof watchGitHubItemsSchema>;
export type GetGitHubPullRequestStatusArgs = z.infer<
  typeof getGitHubPullRequestStatusSchema
>;
export type DeleteWatchersArgs = z.infer<typeof deleteWatchersSchema>;
export type SetAutoArchiveArgs = z.infer<typeof setAutoArchiveSchema>;
export type SetWorkEntryAutoDeleteArgs = z.infer<
  typeof setWorkEntryAutoDeleteSchema
>;
export type SetBaseBranchArgs = z.infer<typeof setBaseBranchSchema>;
export type GetCodeGraphContextArgs = z.infer<typeof getCodeGraphContextSchema>;
export type BuildOrUpdateCodeGraphArgs = z.infer<
  typeof buildOrUpdateCodeGraphSchema
>;
export type QueryCodeGraphArgs = z.infer<typeof queryCodeGraphSchema>;
export type SearchCodeGraphArgs = z.infer<typeof searchCodeGraphSchema>;
export type ExplainCodeSymbolArgs = z.infer<typeof explainCodeSymbolSchema>;
export type GetImpactRadiusArgs = z.infer<typeof getImpactRadiusSchema>;
export type DetectChangedSymbolsArgs = z.infer<
  typeof detectChangedSymbolsSchema
>;
export type CompareChangeImpactArgs = z.infer<typeof compareChangeImpactSchema>;
export type GetReviewContextArgs = z.infer<typeof getReviewContextSchema>;

export const respondToCommentJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    threadId: {
      type: 'string',
      description: 'Id of the comment thread to reply to',
    },
    body: {
      type: 'string',
      description: 'Reply text posted as an agent comment',
    },
    resolve: {
      type: 'boolean',
      description: 'Mark the thread resolved after replying',
    },
  },
  required: ['threadId', 'body'],
  additionalProperties: false,
};

export const getReviewCommentsJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    threadId: {
      type: 'string',
      description:
        'Optional comment thread id. Omit to summarize all open threads.',
    },
  },
  additionalProperties: false,
};

export const getFileCommentsJsonSchema = getReviewCommentsJsonSchema;
export const respondToFileCommentJsonSchema = respondToCommentJsonSchema;

export const askUserQuestionJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          control: {
            type: 'string',
            enum: ['buttons', 'select', 'text', 'textarea', 'number', 'date'],
            description:
              'Optional inline control; text, textarea, number and date use options: [].',
          },
          required: {
            type: 'boolean',
            description: 'Require an answer before submitting.',
          },
          placeholder: { type: 'string', maxLength: 200 },
          question: {
            type: 'string',
            description: 'The question to ask',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Available options to choose from; the person can also type their own answer',
          },
          multiSelect: {
            type: 'boolean',
            description: 'Allow selecting multiple options',
          },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

export const getScriptOutputJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    scriptId: {
      type: 'string',
      description: 'Script name or canonical script key',
    },
    repo: {
      type: 'string',
      description:
        'Repo id/name for multi-repo projects. Use "workspace-root" for workspace-root scripts.',
    },
    maxLines: {
      type: 'integer',
      minimum: 1,
      maximum: 2000,
      description: 'Maximum lines to return. Defaults to 200.',
    },
  },
  required: ['scriptId'],
  additionalProperties: false,
};

export const getGitPreferencesJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['branch-name', 'pr-generation', 'commit-message'],
      description:
        'Which Git preference type to read: branch-name, pr-generation, or commit-message.',
    },
  },
  required: ['type'],
  additionalProperties: false,
};

export const saveMemoryJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description: 'The durable fact to remember.',
    },
    scope: {
      type: 'string',
      enum: ['user', 'workspace'],
      description:
        'Use user for personal preferences that apply everywhere; use workspace for facts about this repo or project.',
    },
  },
  required: ['text', 'scope'],
  additionalProperties: false,
};

export const searchMemoryJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'Search text for local memory.',
    },
  },
  required: ['query'],
  additionalProperties: false,
};

export const readMemoryJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    scope: {
      type: 'string',
      enum: ['user', 'workspace'],
      description: 'The scope shown for the SearchMemory result.',
    },
    file: {
      type: 'string',
      pattern:
        '^(?!.*\\.\\.)(?:MEMORY\\.md|(?:topics|inbox)\\/[^/\\\\]+\\.md)$',
      description:
        'An exact file key returned by SearchMemory. Traversal segments are not allowed.',
    },
  },
  required: ['scope', 'file'],
  additionalProperties: false,
};

export const readPipelineYamlJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    pipelineId: {
      type: 'string',
      description: 'Pipeline id from pipeline.list.',
    },
    repoId: {
      type: 'string',
      description:
        'Optional repo id/name for project-local pipeline YAML in multi-repo projects. Omit for workspace-root/default repo or user/bundled pipelines.',
    },
    startLine: {
      type: 'integer',
      minimum: 1,
      description: 'Optional 1-based first line to include.',
    },
    endLine: {
      type: 'integer',
      minimum: 1,
      description: 'Optional 1-based final line to include.',
    },
    ranges: {
      type: 'array',
      maxItems: 20,
      description:
        'Optional explicit 1-based line ranges. When provided, ranges override startLine/endLine.',
      items: {
        type: 'object',
        required: ['startLine'],
        properties: {
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    },
    pattern: {
      type: 'string',
      minLength: 1,
      description:
        'Optional grep pattern. Regex by default; fixedString changes to literal matching.',
    },
    fixedString: {
      type: 'boolean',
      description:
        'Treat pattern as a literal string instead of a regular expression.',
    },
    ignoreCase: {
      type: 'boolean',
      description: 'Case-insensitive matching.',
    },
    invertMatch: {
      type: 'boolean',
      description: 'Return lines that do not match the pattern.',
    },
    context: {
      type: 'integer',
      minimum: 0,
      maximum: 200,
      description: 'Include this many lines before and after each match.',
    },
    beforeContext: {
      type: 'integer',
      minimum: 0,
      maximum: 200,
      description:
        'Include this many lines before each match. Ignored when context is set.',
    },
    afterContext: {
      type: 'integer',
      minimum: 0,
      maximum: 200,
      description:
        'Include this many lines after each match. Ignored when context is set.',
    },
    maxMatches: {
      type: 'integer',
      minimum: 1,
      maximum: 10000,
      description:
        'Maximum matching lines to include before context expansion.',
    },
  },
  required: ['pipelineId'],
  additionalProperties: false,
};

export const showVisualJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    html: {
      type: 'string',
      minLength: 1,
      maxLength: 512000,
      description: 'One complete HTML document, at most 512,000 UTF-8 bytes.',
    },
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'Short title (trimmed to 1–120 characters).',
    },
    height: {
      type: 'integer',
      minimum: 80,
      maximum: 2000,
      description: 'Maximum frame height in pixels.',
    },
  },
  required: ['html', 'title', 'height'],
  additionalProperties: false,
};

export const previewVisualJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    html: {
      type: 'string',
      minLength: 1,
      maxLength: 512000,
      description: 'One complete HTML document, at most 512,000 UTF-8 bytes.',
    },
    width: {
      type: 'integer',
      minimum: 240,
      maximum: 1600,
      description: 'Preview width in CSS pixels (default 720).',
    },
    appearance: {
      type: 'string',
      enum: ['light', 'dark'],
      description:
        'Optional light or dark appearance; defaults to the current appearance.',
    },
  },
  required: ['html'],
  additionalProperties: false,
};

export const showFilesJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      description:
        'Files to open in requested tab order. The first valid file becomes active.',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            description:
              'Absolute file path or path relative to the current project root.',
          },
          view: {
            description:
              'Requested view: "rich" or "raw". Defaults to rich; invalid values are ignored.',
          },
          line: {
            description:
              'Optional positive integer raw-file line to reveal. Invalid values are ignored.',
          },
          annotations: {
            type: 'array',
            maxItems: 50,
            description:
              'Non-destructive raw-file line annotations. Supplying comment starts an agent-authored comment thread.',
            items: {
              type: 'object',
              properties: {
                startLine: { type: 'integer', minimum: 1 },
                endLine: { type: 'integer', minimum: 1 },
                title: { type: 'string', maxLength: 200 },
                comment: { type: 'string', maxLength: 10000 },
              },
              required: ['startLine'],
              additionalProperties: false,
            },
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  required: ['files'],
  additionalProperties: false,
};

export const searchActionsJsonSchema: JsonValue = SEARCH_ACTIONS_JSON_SCHEMA;

/**
 * The DispatchAction type enum order the legacy desktop actions have always
 * been advertised in. It differs from the dispatch support list order.
 */
export const DESKTOP_LEGACY_ACTION_JSON_ENUM_ORDER = [
  'sidebar.item_groups.list',
  'sidebar.item_groups.list_items',
  'sidebar.item_groups.set_item',
  'sidebar.item_groups.update',
  'skills.list',
  'skills.read',
  'skills.read_file',
  'skills.create_custom',
  'skills.update_custom',
  'skills.delete_custom',
  'skills.list_shared',
  'skills.read_shared',
  'skills.share_custom',
  'sharing.open_dialog',
  'skills.import_shared',
  'skills.update_shared',
  'skills.delete_shared',
  'pipeline.list',
  'pipeline.get',
  'pipeline.create',
  'pipeline.update',
  'pipeline.delete',
  'pipeline.duplicate',
  'pipeline.share',
  'pipeline.update_shared',
  'pipeline.delete_shared',
  'pipeline.set_enabled',
  'worktree.get_settings',
  'worktree.list_scripts',
  'worktree.run_script',
  'tracked-plan.import',
  'hook.pause',
  'hook.resume',
  'automation.list',
  'automation.get',
  'automation.create',
  'automation.update',
  'automation.disable',
  'automation.delete',
  'automation.run_now',
] as const;

/** Advertised payload properties of the legacy desktop actions. */
export const DESKTOP_LEGACY_DISPATCH_JSON_PROPERTIES: AgentJsonSchema = {
  groupId: {
    type: ['string', 'null'],
    description:
      'Sidebar group id; null removes the current item from its group.',
  },
  color: { type: 'string', enum: [...SIDEBAR_ITEM_GROUP_COLORS] },
  collapsed: { type: 'boolean' },
  newGroup: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      color: { type: 'string', enum: [...SIDEBAR_ITEM_GROUP_COLORS] },
    },
    additionalProperties: false,
    description:
      'Create and assign a new sidebar group inline. Mutually exclusive with groupId.',
  },
  scriptId: {
    type: 'string',
    minLength: 1,
    description:
      'For worktree.run_script, a script name such as "test" or a scriptKey from worktree.list_scripts.',
  },
  repo: {
    type: 'string',
    minLength: 1,
    description:
      'For worktree.run_script in a multi-repo project, "workspace-root", a repo id, or a unique repo name.',
  },
  waitSeconds: {
    type: 'integer',
    minimum: 0,
    maximum: MAX_SCRIPT_WAIT_SECONDS,
    description: `For worktree.run_script, seconds to wait for the run to finish (0–${MAX_SCRIPT_WAIT_SECONDS}). Defaults to 0, which returns once the run starts.`,
  },
};

/** Where a worktree chat may start another chat. */
export const DESKTOP_WORKTREE_CHAT_PLACEMENTS: readonly AgentChatCreatePlacement[] =
  ['current', 'new_worktree'];

/** Cowork chats have no worktrees; they start chats beside themselves. */
export const DESKTOP_COWORK_CHAT_PLACEMENTS: readonly AgentChatCreatePlacement[] =
  ['current'];

/** The desktop-legacy family's advertised DispatchAction payload schema. */
export const DESKTOP_LEGACY_DISPATCH_JSON_SCHEMA: AgentActionFamilyJsonSchema =
  {
    properties: DESKTOP_LEGACY_DISPATCH_JSON_PROPERTIES,
  };

/**
 * DispatchAction as the desktop surface advertises it, for the static tool
 * lists: the same package composition the surface engine runs over the
 * environment, transcript-read and desktop-legacy families.
 */
function desktopDispatchActionJsonSchema(
  placements: readonly AgentChatCreatePlacement[],
): AgentJsonSchema {
  return agentActionDispatchJsonSchema(
    AGENT_ACTION_BRAND,
    [
      {
        types: ENVIRONMENT_ACTION_TYPES,
        dispatchJsonSchema: environmentDispatchJsonSchema(placements),
      },
      {
        types: TRANSCRIPT_READ_ACTION_TYPES,
        dispatchJsonSchema: transcriptReadDispatchJsonSchema,
      },
      {
        types: PROJECT_ACTION_TYPES,
        dispatchJsonSchema: projectDispatchJsonSchema,
        targetFields: ['projectId'],
      },
      {
        types: BOT_ACTION_TYPES,
        dispatchJsonSchema: botDispatchJsonSchema,
      },
      {
        types: INSTALLED_ITEM_ACTION_TYPES,
        dispatchJsonSchema: installedItemDispatchJsonSchema,
      },
      {
        types: EXPERIMENT_ACTION_TYPES,
        dispatchJsonSchema: experimentDispatchJsonSchema,
      },
      {
        types: SETTINGS_ACTION_TYPES,
        dispatchJsonSchema: settingsDispatchJsonSchema,
      },
      {
        types: CAPABILITY_PACKAGE_ACTION_TYPES,
        dispatchJsonSchema: capabilityPackageDispatchJsonSchema,
      },
      {
        types: PIPELINES_ACTION_TYPES,
        dispatchJsonSchema: pipelinesDispatchJsonSchema,
      },
      {
        types: PIPELINE_EXECUTIONS_ACTION_TYPES,
        dispatchJsonSchema: pipelineExecutionsDispatchJsonSchema,
      },
      {
        types: BROWSER_ACTION_TYPES,
        dispatchJsonSchema: browserDispatchJsonSchema,
      },
      {
        types: DESKTOP_LEGACY_ACTION_JSON_ENUM_ORDER,
        dispatchJsonSchema: DESKTOP_LEGACY_DISPATCH_JSON_SCHEMA,
      },
    ],
    [
      ...ENVIRONMENT_ACTION_TYPES,
      ...TRANSCRIPT_READ_ACTION_TYPES,
      ...PROJECT_ACTION_TYPES,
      ...BOT_ACTION_TYPES,
      ...INSTALLED_ITEM_ACTION_TYPES,
      ...EXPERIMENT_ACTION_TYPES,
      ...SETTINGS_ACTION_TYPES,
      ...CAPABILITY_PACKAGE_ACTION_TYPES,
      ...PIPELINES_ACTION_TYPES,
      ...PIPELINE_EXECUTIONS_ACTION_TYPES,
      ...BROWSER_ACTION_TYPES,
      ...DESKTOP_LEGACY_ACTION_JSON_ENUM_ORDER,
    ],
  );
}

/** DispatchAction as worktree chats advertise it. */
export const dispatchActionJsonSchema: JsonValue =
  desktopDispatchActionJsonSchema(DESKTOP_WORKTREE_CHAT_PLACEMENTS);

/** DispatchAction as Cowork chats advertise it. */
export const coworkDispatchActionJsonSchema: JsonValue =
  desktopDispatchActionJsonSchema(DESKTOP_COWORK_CHAT_PLACEMENTS);

export const searchWatchersJsonSchema: JsonValue =
  buildSearchWatchersJsonSchema(SEARCHABLE_WATCHER_TRIGGERS);

export const watchGitHubItemsJsonSchema: JsonValue = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      description: GITHUB_ITEMS_FIELD_DESCRIPTION,
      items: {
        oneOf: [
          { type: 'string' },
          { type: 'integer', minimum: 1 },
          {
            type: 'object',
            required: ['kind', 'target'],
            properties: {
              kind: { type: 'string', enum: ['workflow_run'] },
              target: {
                oneOf: [{ type: 'string' }, { type: 'integer', minimum: 1 }],
              },
              repository: { type: 'string' },
              runAttempt: { type: 'integer', minimum: 1 },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['kind', 'runId'],
            properties: {
              kind: { type: 'string', enum: ['workflow_run'] },
              repository: { type: 'string' },
              runId: {
                oneOf: [{ type: 'string' }, { type: 'integer', minimum: 1 }],
              },
              runAttempt: { type: 'integer', minimum: 1 },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['kind', 'target'],
            properties: {
              kind: { type: 'string', enum: ['pull_request'] },
              target: {
                type: 'string',
                description:
                  'A GitHub.com pull request URL or owner/repository#number.',
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['kind', 'number'],
            properties: {
              kind: { type: 'string', enum: ['pull_request'] },
              repository: { type: 'string' },
              number: {
                oneOf: [{ type: 'string' }, { type: 'integer', minimum: 1 }],
              },
            },
            additionalProperties: false,
          },
        ],
      },
    },
    repository: {
      type: 'string',
      description: GITHUB_REPOSITORY_FIELD_DESCRIPTION,
    },
    notifyOn: {
      type: 'object',
      description: GITHUB_NOTIFY_ON_FIELD_DESCRIPTION,
      anyOf: [
        { required: ['run'] },
        { required: ['jobs'] },
        { required: ['statuses'] },
        { required: ['conclusions'] },
        { required: ['queue'] },
      ],
      properties: {
        queue: {
          type: 'object',
          anyOf: [{ required: ['entered'] }, { required: ['phases'] }],
          description: GITHUB_QUEUE_NOTIFICATION_DESCRIPTION,
          properties: {
            entered: {
              type: 'boolean',
              description: GITHUB_QUEUE_ENTERED_DESCRIPTION,
            },
            phases: {
              oneOf: [
                { type: 'string', enum: ['any'] },
                {
                  type: 'array',
                  minItems: 1,
                  maxItems: PR_MERGE_QUEUE_WATCH_PHASES.length,
                  uniqueItems: true,
                  items: {
                    type: 'string',
                    enum: [...PR_MERGE_QUEUE_WATCH_PHASES],
                  },
                },
              ],
              description: GITHUB_QUEUE_PHASES_DESCRIPTION,
            },
          },
          additionalProperties: false,
        },
        run: {
          type: 'object',
          anyOf: [{ required: ['statuses'] }, { required: ['conclusions'] }],
          description:
            'Whole workflow-run lifecycle notifications. These do not report individual job progress.',
          properties: {
            statuses: {
              oneOf: [
                { type: 'string', enum: ['any'] },
                {
                  type: 'array',
                  minItems: 1,
                  maxItems: GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES.length,
                  uniqueItems: true,
                  items: {
                    type: 'string',
                    enum: [...GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES],
                  },
                },
              ],
              description:
                'Future run statuses such as queued, waiting, or in_progress.',
            },
            conclusions: {
              oneOf: [
                { type: 'string', enum: ['any'] },
                {
                  type: 'array',
                  minItems: 1,
                  maxItems: GITHUB_WORKFLOW_RUN_CONCLUSIONS.length,
                  uniqueItems: true,
                  items: {
                    type: 'string',
                    enum: [...GITHUB_WORKFLOW_RUN_CONCLUSIONS],
                  },
                },
              ],
              description: 'Terminal conclusions for the entire workflow run.',
            },
          },
          additionalProperties: false,
        },
        jobs: {
          type: 'object',
          required: ['conclusions'],
          description:
            'Individual workflow-job completion notifications. Use conclusions: "any" to receive every completed job.',
          properties: {
            conclusions: {
              oneOf: [
                { type: 'string', enum: ['any'] },
                {
                  type: 'array',
                  minItems: 1,
                  maxItems: GITHUB_WORKFLOW_JOB_CONCLUSIONS.length,
                  uniqueItems: true,
                  items: {
                    type: 'string',
                    enum: [...GITHUB_WORKFLOW_JOB_CONCLUSIONS],
                  },
                },
              ],
              description:
                'Selected job conclusions. A matching event means that individual job completed.',
            },
          },
          additionalProperties: false,
        },
        statuses: {
          oneOf: [
            { type: 'string', enum: ['any'] },
            {
              type: 'array',
              minItems: 1,
              maxItems: GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES.length,
              uniqueItems: true,
              items: {
                type: 'string',
                enum: [...GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES],
              },
            },
          ],
          description: 'Compatibility alias for run.statuses.',
        },
        conclusions: {
          oneOf: [
            { type: 'string', enum: ['any'] },
            {
              type: 'array',
              minItems: 1,
              maxItems: GITHUB_WORKFLOW_RUN_CONCLUSIONS.length,
              uniqueItems: true,
              items: {
                type: 'string',
                enum: [...GITHUB_WORKFLOW_RUN_CONCLUSIONS],
              },
            },
          ],
          description: 'Compatibility alias for run.conclusions.',
        },
      },
      additionalProperties: false,
    },
    label: { type: 'string' },
    followUpInstruction: { type: 'string' },
    allowDuplicate: { type: 'boolean' },
  },
  additionalProperties: false,
};

export const getGitHubPullRequestStatusJsonSchema: JsonValue = {
  type: 'object',
  required: ['pullRequest'],
  properties: {
    pullRequest: {
      type: 'string',
      minLength: 1,
      maxLength: 512,
      description: GITHUB_PULL_REQUEST_REFERENCE_FIELD_DESCRIPTION,
    },
  },
  additionalProperties: false,
};

export const deleteWatchersJsonSchema: JsonValue = DELETE_WATCHERS_JSON_SCHEMA;

export const setupWatchersJsonSchema: JsonValue = buildSetupWatchersJsonSchema(
  AGENT_ACTION_BRAND,
  SETUP_WATCHER_TRIGGERS,
);

export const setAutoArchiveJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    enabled: {
      type: 'boolean',
      description:
        'Whether this chat should be archived automatically when the active turn completes.',
    },
  },
  required: ['enabled'],
  additionalProperties: false,
};

export const setWorkEntryAutoDeleteJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    enabled: {
      type: 'boolean',
      description: WORK_ENTRY_AUTO_DELETE_ENABLED_DESCRIPTION,
    },
    archive: {
      type: 'boolean',
      description: WORK_ENTRY_AUTO_DELETE_ARCHIVE_DESCRIPTION,
    },
    teardown: {
      type: 'string',
      enum: [...WORK_ENTRY_AUTO_DELETE_TEARDOWNS],
      description: WORK_ENTRY_AUTO_DELETE_TEARDOWN_DESCRIPTION,
    },
    unmergedLocalBranchDelete: {
      type: 'string',
      enum: [...WORK_ENTRY_AUTO_DELETE_UNMERGED_BRANCHES],
      description: WORK_ENTRY_AUTO_DELETE_BRANCH_DESCRIPTION,
    },
  },
  required: ['enabled'],
  additionalProperties: false,
};

export const setBaseBranchJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    baseBranch: {
      type: 'string',
      minLength: 1,
      description: 'Local or origin branch to track as the worktree base.',
    },
    repoId: {
      type: 'string',
      minLength: 1,
      description:
        'Repository id for a multi-repository project. Omit for a single-repository project.',
    },
  },
  required: ['baseBranch'],
  additionalProperties: false,
};

export const getCodeGraphContextJsonSchema: JsonValue = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

export const buildOrUpdateCodeGraphJsonSchema: JsonValue = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const codeGraphDetailLevelJsonSchemaProperty: JsonValue = {
  type: 'string',
  enum: ['minimal', 'standard'],
  description:
    'minimal (default) returns up to 5 hits; standard returns up to the requested limit/maxNodes.',
};

export const queryCodeGraphJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: [...CODE_GRAPH_QUERY_MODES],
      description: `Query mode. One of: ${CODE_GRAPH_QUERY_MODES.join(', ')}.`,
    },
    target: {
      type: 'string',
      minLength: 1,
      description: CODE_GRAPH_TARGET_FIELD_DESCRIPTION,
    },
    to: {
      type: 'string',
      minLength: 1,
      description: 'Second endpoint for call-path or relationship-path.',
    },
    maxDepth: {
      type: 'integer',
      minimum: 1,
      maximum: 12,
      description: 'Path depth budget (default 6).',
    },
    maxNodes: {
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: 'Path visited-node budget (default 200).',
    },
    repoId: {
      type: 'string',
      description:
        'Optional repo id/name for multi-repo projects. Omit for a single-repo worktree.',
    },
    detailLevel: codeGraphDetailLevelJsonSchemaProperty,
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: CODE_GRAPH_TOOL_MAX_RESULTS,
      description: `Maximum hits to return at detailLevel "standard" (1-${CODE_GRAPH_TOOL_MAX_RESULTS}).`,
    },
  },
  // target is intentionally NOT required — see CODE_GRAPH_DERIVED_MODE_TARGET_NOTE.
  required: ['mode'],
  additionalProperties: false,
};

export const searchCodeGraphJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'Search text for symbol name or fragment.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: CODE_GRAPH_TOOL_MAX_RESULTS,
      description: `Maximum hits to return at detailLevel "standard" (1-${CODE_GRAPH_TOOL_MAX_RESULTS}).`,
    },
    detailLevel: codeGraphDetailLevelJsonSchemaProperty,
  },
  required: ['query'],
  additionalProperties: false,
};

export const explainCodeSymbolJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    qualifiedName: {
      type: 'string',
      minLength: 1,
      description:
        'Symbol qualified name in path/to/file.ts::Parent.name form.',
    },
    repoId: {
      type: 'string',
      description:
        'Optional repo id/name for multi-repo projects. Omit for a single-repo worktree.',
    },
  },
  required: ['qualifiedName'],
  additionalProperties: false,
};

export const getImpactRadiusJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      minLength: 1,
      description:
        'Symbol qualified name (path/to/file.ts::Parent.name form) or file path.',
    },
    maxDepth: {
      type: 'integer',
      minimum: 1,
      maximum: CODE_GRAPH_IMPACT_MAX_DEPTH,
      description: `Maximum traversal depth (1-${CODE_GRAPH_IMPACT_MAX_DEPTH}).`,
    },
    maxNodes: {
      type: 'integer',
      minimum: 1,
      maximum: CODE_GRAPH_IMPACT_MAX_NODES,
      description: `Maximum impacted nodes (1-${CODE_GRAPH_IMPACT_MAX_NODES}).`,
    },
    detailLevel: codeGraphDetailLevelJsonSchemaProperty,
  },
  required: ['target'],
  additionalProperties: false,
};

const codeGraphBaseRefJsonSchemaProperty: JsonValue = {
  type: 'string',
  description: CODE_GRAPH_BASE_REF_PARAM_DESCRIPTION,
};

const codeGraphChangeImpactRepoIdJsonSchemaProperty: JsonValue = {
  type: 'string',
  description: CODE_GRAPH_CHANGE_IMPACT_REPO_ID_DESCRIPTION,
};

export const detectChangedSymbolsJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    baseRef: codeGraphBaseRefJsonSchemaProperty,
    repoId: codeGraphChangeImpactRepoIdJsonSchemaProperty,
    detailLevel: {
      type: 'string',
      enum: ['minimal', 'standard'],
      description:
        'minimal (default) returns up to 5 changed symbols; standard returns up to 200.',
    },
  },
  additionalProperties: false,
};

export const compareChangeImpactJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    baseRef: codeGraphBaseRefJsonSchemaProperty,
    repoId: codeGraphChangeImpactRepoIdJsonSchemaProperty,
    maxDepth: {
      type: 'integer',
      minimum: 1,
      maximum: CODE_GRAPH_IMPACT_MAX_DEPTH,
      description: `Maximum traversal depth (1-${CODE_GRAPH_IMPACT_MAX_DEPTH}).`,
    },
    detailLevel: {
      type: 'string',
      enum: ['minimal', 'standard'],
      description:
        'minimal (default) returns up to 5 items per list field; standard returns full lists (capped at 200 for added/removed/signature-changed and impacted symbols).',
    },
  },
  additionalProperties: false,
};

export const getReviewContextJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    baseRef: codeGraphBaseRefJsonSchemaProperty,
    repoId: codeGraphChangeImpactRepoIdJsonSchemaProperty,
    detailLevel: {
      type: 'string',
      enum: ['minimal', 'standard'],
      description:
        'minimal (default) returns up to 5 items per list field; standard returns full lists (capped at 200 changed symbols).',
    },
  },
  additionalProperties: false,
};

export {
  START_BRANCHED_AGENT_DESCRIPTION,
  START_FORKED_AGENT_DESCRIPTION,
} from '@canopy/agent-actions';
export const startSplitAgentSchema = startSplitAgentInputSchema;
export const startSplitAgentJsonSchema: JsonValue =
  START_SPLIT_AGENT_JSON_SCHEMA;

// ---------------------------------------------------------------------------
// Agent Ledger tools. The handler validates with the protocol's tool input
// schemas (`@canopy/protocol/canopy-core`), and the advertised JSON Schemas
// below are derived from those same schemas, so the model-facing shape cannot
// drift from what the Ledger accepts. JSON Schema is advisory to the model;
// the protocol schema remains the authority at execution.
// ---------------------------------------------------------------------------

const searchLedgerEntriesToolName =
  CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries.codexToolName;

const LEDGER_PLAN_MODE_TOOL_NOTE =
  'Allowed in Plan mode as bookkeeping; it does not edit files or run commands.';

export const ADD_LEDGER_ENTRY_DESCRIPTION = `Add one entry to this chat's Feed, a concise record of noteworthy work for future readers. Plan with one OPERATION per independent work line. Use parentEntryId to put TASKs under operations and subtasks under tasks (operation > task > subtask); ACTION, DECISION and OBSERVATION entries may also sit under an operation or task. Operations are top-level. Use TASK for scoped, multi-step work (default status TODO), ACTION for a significant or unexpected action (default IN_PROGRESS), and DECISION or OBSERVATION for a choice or useful finding (default INFO). Keep the title and content brief; put extensive notes in files and list them in referenceFiles. owner defaults to "self"; to assign another owner, pass { actorId, eligibilityToken } from SearchFeedEntries / ${searchLedgerEntriesToolName} with includeAssignableOwners. Set supersedesEntryId to record a correction to an earlier entry. After an uncertain failure, retry with the same requestKey or search for the entry first. ${appName} records the scope, author and time. ${LEDGER_PLAN_MODE_TOOL_NOTE}`;

export const SEARCH_LEDGER_ENTRIES_DESCRIPTION = `Search this chat's Feed. Filter by query words, entryIds (up to 25), owner or author ("self" or { actorId }), types, statuses, attribution, and created/updated time bounds; sort by created_desc (default) or updated_desc; page with limit (default 30, maximum 100) and cursor. Use parentEntryId for direct children or null for top-level entries, rootEntryId for an entry and its whole subtree, and authorIn for entries by any listed author. At the start of a turn or resumed task, search with owner "self" and statuses TODO, IN_PROGRESS, BLOCKED and NEEDS_REVIEW. Results include each entry's revision for UpdateFeedEntry. Set includeAssignableOwners to also list the owners you can assign, with eligibility tokens (page them with ownersCursor). Read-only.`;

export const UPDATE_LEDGER_ENTRY_DESCRIPTION = `Change the status, owner and/or parent of an open entry in this chat's Feed that you own. Pass entryId and the expectedRevision you last read. Use parentEntryId to move it in the operation > task > subtask hierarchy or null to make it top-level. Nothing else about an entry can change, and Completed, Failed and Info entries cannot change at all: add a new entry with supersedesEntryId for a correction. Closing an entry with open children requires openChildren: complete, fail or detach; detach moves the open children and their subtrees to top level. If the entry changed since you read it, the current entry is returned instead: reconsider before retrying rather than overwriting. owner accepts "self" or { actorId, eligibilityToken } from SearchFeedEntries / ${searchLedgerEntriesToolName} with includeAssignableOwners; assignment records responsibility and does not start another session. After an uncertain failure, retry with the same requestKey or search first. ${LEDGER_PLAN_MODE_TOOL_NOTE}`;

const LEDGER_OWNER_TARGET_DESCRIPTION =
  '"self", or { actorId, eligibilityToken } from SearchFeedEntries with includeAssignableOwners.';
const LEDGER_REQUEST_KEY_DESCRIPTION =
  'Optional retry key (1–128 characters). Reuse it only to retry this same request after an uncertain failure.';

const ADD_LEDGER_ENTRY_PROPERTY_DESCRIPTIONS: Readonly<Record<string, string>> =
  {
    type: 'OPERATION, TASK, ACTION, DECISION or OBSERVATION.',
    parentEntryId:
      'Parent operation or task ID; use the operation > task > subtask hierarchy.',
    title: 'Brief single-line title.',
    content: 'Brief plain-text details.',
    highlights: 'Optional short key points.',
    referenceFiles:
      'Files that hold longer notes: { rootId, path, startLine? } with path relative to the root.',
    status:
      'Initial status. Defaults to TODO for OPERATION and TASK, IN_PROGRESS for ACTION, and INFO for DECISION or OBSERVATION.',
    owner: LEDGER_OWNER_TARGET_DESCRIPTION,
    supersedesEntryId: 'The earlier entry this one corrects.',
    requestKey: LEDGER_REQUEST_KEY_DESCRIPTION,
  };

const SEARCH_LEDGER_ENTRIES_PROPERTY_DESCRIPTIONS: Readonly<
  Record<string, string>
> = {
  query: 'Words that must all match, each by the start of a word.',
  entryIds: 'Exact entry IDs.',
  owner: '"self" or { actorId }.',
  author: '"self" or { actorId }.',
  types: 'Match any of these entry types.',
  statuses: 'Match any of these statuses.',
  attribution: 'Match any of these attribution kinds.',
  createdAfter: 'ISO 8601 lower bound on creation time.',
  createdBefore: 'ISO 8601 upper bound on creation time.',
  updatedAfter: 'ISO 8601 lower bound on the last change.',
  updatedBefore: 'ISO 8601 upper bound on the last change.',
  sort: 'created_desc (default) or updated_desc.',
  limit: 'Entries per page (default 30).',
  cursor: 'nextCursor from the previous page of the same search.',
  includeAssignableOwners:
    'Also list the owners you can assign, with eligibility tokens.',
  ownersCursor: 'owners.nextCursor from the previous owners page.',
  parentEntryId:
    'Find the direct children of this entry; use null for top-level entries.',
  rootEntryId: 'Return this entry and its full subtree.',
  authorIn: 'Match entries authored by any of these actor IDs.',
};

const UPDATE_LEDGER_ENTRY_PROPERTY_DESCRIPTIONS: Readonly<
  Record<string, string>
> = {
  entryId: 'The entry to change.',
  expectedRevision: 'The revision you last read.',
  status: 'New status.',
  owner: LEDGER_OWNER_TARGET_DESCRIPTION,
  parentEntryId:
    'Set the new parent entry ID, or null to move this entry to the top level.',
  openChildren:
    'When closing a parent with open children, choose complete, fail or detach; detach moves them and their subtrees to the top level.',
  requestKey: LEDGER_REQUEST_KEY_DESCRIPTION,
};

/**
 * Rebuilds a generated JSON Schema as plain JSON, dropping what only adds
 * noise to a tool prompt: the `$schema` marker, the long UUID regex that
 * accompanies `format: "uuid"`, and safe-integer bounds.
 */
function toAdvisoryJsonSchema(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item: unknown): JsonValue => toAdvisoryJsonSchema(item));
  }
  if (!isRecord(value)) return null;
  const hasFormat = typeof value.format === 'string';
  const result: { [key: string]: JsonValue } = {};
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined || key === '$schema') continue;
    if (key === 'pattern' && hasFormat) continue;
    if (key === 'maximum' && member === Number.MAX_SAFE_INTEGER) continue;
    if (key === 'minimum' && member === Number.MIN_SAFE_INTEGER) continue;
    result[key] = toAdvisoryJsonSchema(member);
  }
  return result;
}

/** A Ledger tool's advertised JSON Schema, derived from its protocol schema. */
function ledgerToolJsonSchema(
  schema: z.ZodType,
  propertyDescriptions: Readonly<Record<string, string>>,
): JsonValue {
  const generated = toAdvisoryJsonSchema(
    z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
  );
  if (
    generated === null ||
    typeof generated !== 'object' ||
    Array.isArray(generated)
  ) {
    return generated;
  }
  const properties = generated.properties;
  if (
    properties === null ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  ) {
    return generated;
  }
  const described: { [key: string]: JsonValue } = {};
  for (const [name, property] of Object.entries(properties)) {
    if (property === undefined) continue;
    const description = propertyDescriptions[name];
    described[name] =
      description !== undefined &&
      property !== null &&
      typeof property === 'object' &&
      !Array.isArray(property)
        ? { ...property, description }
        : property;
  }
  return { ...generated, properties: described };
}

export const addLedgerEntryJsonSchema: JsonValue = ledgerToolJsonSchema(
  LedgerAddEntryToolInputSchema,
  ADD_LEDGER_ENTRY_PROPERTY_DESCRIPTIONS,
);

export const searchLedgerEntriesJsonSchema: JsonValue = ledgerToolJsonSchema(
  LedgerSearchEntriesToolInputSchema,
  SEARCH_LEDGER_ENTRIES_PROPERTY_DESCRIPTIONS,
);

export const updateLedgerEntryJsonSchema: JsonValue = ledgerToolJsonSchema(
  LedgerUpdateEntryToolInputSchema,
  UPDATE_LEDGER_ENTRY_PROPERTY_DESCRIPTIONS,
);

import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  BellIcon,
  ChatIcon,
  CodeIcon,
  CognitionIcon,
  FileIcon,
  FilterIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  GlobeIcon,
  InputIcon,
  MessageIcon,
  PipelineIcon,
  PlayCircleIcon,
  ShieldAiIcon,
  SplitIcon,
  TaskIcon,
  TerminalIcon,
  WorkflowIcon,
  WorktreeIcon,
} from '@canopy/ui-shared/icons/AppIcons';

/** The designer's purpose groups, in picker order. */
export type WorkflowStepGroup =
  | 'ai'
  | 'flow'
  | 'code'
  | 'git'
  | 'send'
  | 'input';

export const WORKFLOW_STEP_GROUP_LABELS: Readonly<
  Record<WorkflowStepGroup, string>
> = {
  ai: 'AI',
  flow: 'Flow',
  code: 'Code',
  git: 'Git',
  send: 'Send',
  input: 'Input',
};

export const WORKFLOW_STEP_GROUP_ORDER: readonly WorkflowStepGroup[] = [
  'ai',
  'flow',
  'code',
  'git',
  'send',
  'input',
];

export type WorkflowStepGlyphIcon = typeof CognitionIcon;

export interface WorkflowStepCatalogEntry {
  /** The task name shown on cards and in the picker, never the action id. */
  readonly label: string;
  /** One line for the picker. */
  readonly description: string;
  readonly group: WorkflowStepGroup;
  readonly icon: WorkflowStepGlyphIcon;
  /** Samples and building blocks of the bundled workflows stay out of the picker. */
  readonly hidden?: boolean;
}

const entry = (
  label: string,
  description: string,
  group: WorkflowStepGroup,
  icon: WorkflowStepGlyphIcon,
  hidden = false,
): WorkflowStepCatalogEntry => ({
  label,
  description,
  group,
  icon,
  ...(hidden ? { hidden } : {}),
});

/** Built-in actions by their `uses` id. */
const BUILTIN_STEP_ENTRIES: Readonly<Record<string, WorkflowStepCatalogEntry>> =
  {
    'agent-prompt': entry(
      'Ask an agent',
      'Send a prompt to an agent and use its answer in later steps.',
      'ai',
      CognitionIcon,
    ),
    'agent-resume': entry(
      'Continue an agent session',
      'Send a follow-up to an earlier agent session.',
      'ai',
      CognitionIcon,
    ),
    'agent-loop': entry(
      'Repeat until a check passes',
      'Prompt an agent again until a shell check passes.',
      'ai',
      CognitionIcon,
    ),
    'parallel-agents': entry(
      'Ask several agents at once',
      'Run several prompts at the same time and combine the answers.',
      'ai',
      CognitionIcon,
    ),
    'plan-with-review': entry(
      'Plan with review',
      'Write a plan, review it, and revise it.',
      'ai',
      CognitionIcon,
    ),
    condenser: entry(
      'Summarize',
      'Condense earlier text or transcripts.',
      'ai',
      CognitionIcon,
    ),
    router: entry(
      'Split into paths',
      'Choose one path to continue on.',
      'flow',
      SplitIcon,
    ),
    'quality-gate': entry(
      'Check quality',
      'Score content against criteria and stop below a threshold.',
      'flow',
      ShieldAiIcon,
    ),
    'run-pipeline': entry(
      'Run another workflow',
      'Start another workflow and wait for it.',
      'flow',
      WorkflowIcon,
    ),
    'request-input': entry(
      'Ask for input',
      'Pause and ask a person for answers.',
      'input',
      InputIcon,
    ),
    'read-linear-ticket': entry(
      'Read a Linear ticket',
      'Load a ticket’s details from its id or link.',
      'input',
      TaskIcon,
    ),
    'gather-linear-context': entry(
      'Find Linear tickets',
      'Find the tickets this work refers to.',
      'input',
      TaskIcon,
    ),
    'create-worktree': entry(
      'Create worktree',
      'Create a worktree for later steps.',
      'git',
      WorktreeIcon,
    ),
    'git-commit-push': entry(
      'Commit and push',
      'Commit the changes and push them.',
      'git',
      GitCommitIcon,
    ),
    'git-workspace-details': entry(
      'Read the changes',
      'Collect the diff and instructions for the workspace.',
      'git',
      GitCommitIcon,
    ),
    'github-create-pr': entry(
      'Create pull request',
      'Open a pull request for the changes.',
      'git',
      GitPullRequestIcon,
    ),
    'github-fetch-branch-pr': entry(
      'Find the pull request',
      'Load the current branch’s pull request.',
      'git',
      GitPullRequestIcon,
    ),
    'github-post-review-comment': entry(
      'Comment on pull request',
      'Post a review comment on the pull request.',
      'git',
      GitPullRequestIcon,
    ),
    'github-publish-review': entry(
      'Publish review',
      'Post a code review on the pull request.',
      'git',
      GitPullRequestIcon,
    ),
    'send-agent-message': entry(
      'Send message to chat',
      'Send a message to a chat, starting one if needed.',
      'send',
      MessageIcon,
    ),
    'wait-for-agent-reply': entry(
      'Wait for chat reply',
      'Wait for a chat to answer and use its reply.',
      'send',
      ChatIcon,
    ),
    'create-project-entry': entry(
      'Create task',
      'Create a task with its first chat.',
      'send',
      ChatIcon,
    ),
    'create-bot-entry': entry(
      `Create ${ORCHESTRATOR_LABEL} task`,
      `Create a task for ${ORCHESTRATOR_LABEL}.`,
      'send',
      ChatIcon,
    ),
    'move-to-group': entry(
      'Move to group',
      'Move a task into a sidebar group.',
      'send',
      FilterIcon,
    ),
    notify: entry(
      'Send notification',
      'Show a notification on this computer.',
      'send',
      BellIcon,
    ),
    'http-request': entry(
      'Send web request',
      'Call a URL and use its response.',
      'send',
      GlobeIcon,
    ),
    'pipeline-report': entry(
      'Write report',
      'Write the run’s final report.',
      'send',
      FileIcon,
    ),
    memory: entry(
      'Remember',
      'Store and look up saved values.',
      'code',
      CodeIcon,
    ),
    'memory-read': entry(
      'Read memory file',
      'Read records from a memory file.',
      'code',
      CodeIcon,
    ),
    'memory-write': entry(
      'Write memory file',
      'Add a record to a memory file.',
      'code',
      CodeIcon,
    ),
  };

/**
 * Building blocks the bundled workflows compose, and the samples. Cards show
 * their task names; the picker leaves them out.
 */
const INTERNAL_STEP_LABEL_ENTRIES: Readonly<Record<string, string>> = {
  coder: 'Write code',
  'comms-setup': 'Set up agent messaging',
  'complexity-assessor': 'Assess complexity',
  'context-discovery': 'Find context',
  'discover-review-tracks': 'Find review tracks',
  discovery: 'Explore the project',
  'greenfield-detection': 'Check for a new project',
  'historical-context': 'Read past work',
  'phase-compaction': 'Compact a phase',
  'plan-path-validation': 'Check plan paths',
  'plan-validation': 'Check the plan',
  planner: 'Write a plan',
  'qa-fixer': 'Fix review findings',
  'qa-reviewer': 'Review the work',
  'requirements-from-task': 'Read the task’s requirements',
  'requirements-interactive': 'Gather requirements',
  'spec-critic': 'Critique the spec',
  'spec-gatherer': 'Gather the spec',
  'spec-quick': 'Write a quick spec',
  'spec-researcher': 'Research the spec',
  'spec-validation': 'Check the spec',
  'spec-writer': 'Write the spec',
  'hello-world-js': 'Sample step',
  'hello-world-py': 'Sample step',
  'hello-world-ts': 'Sample step',
};

// Maps, so an id such as `constructor` never resolves an inherited key.
const BUILTIN_STEPS: ReadonlyMap<string, WorkflowStepCatalogEntry> = new Map(
  Object.entries(BUILTIN_STEP_ENTRIES),
);
const INTERNAL_STEP_LABELS: ReadonlyMap<string, string> = new Map(
  Object.entries(INTERNAL_STEP_LABEL_ENTRIES),
);

const SCRIPT_STEP = entry(
  'Run script',
  'Run shell commands.',
  'code',
  TerminalIcon,
);

/**
 * The bundled action a `uses` reference names, as the executor resolves it, or
 * null. The executor takes the text after `builtin/`, trims it and resolves it
 * as a path inside the bundled actions folder, so `builtin/ router` and
 * `builtin/./router` both run `router`. Either separator counts, as a Windows
 * path resolve would.
 */
export function builtinActionId(uses: string): string | null {
  const [scope, ...rest] = uses.trim().split('/');
  if (scope !== 'builtin') return null;
  const actionPath = rest.join('/').trim();
  // An absolute path resolves outside the bundled folder unless it names the
  // folder's own location, which the designer doesn't know.
  if (/^[\\/]/.test(actionPath)) return null;
  const segments: string[] = [];
  for (const segment of actionPath.split(/[\\/]/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Where a path above the bundled folder lands depends on the install.
      if (segments.pop() === undefined) return null;
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join('/') : null;
}

/** A `builtin/` reference written plainly: lowercase segments, nothing else. */
const PLAIN_BUILTIN_REF =
  /^builtin\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;

/**
 * Whether a `uses` reference may run the bundled action `id`. Only a plainly
 * written `builtin/<id>` is judged by its id. Any other `builtin/` spelling
 * (spaces, `.` or `..`, empty or absolute segments, other letter case) may
 * resolve to `id` on some filesystem or install, so it counts too. Hosts use
 * it to lock conservatively; a spelling the executor rejects locks as well.
 */
export function mayRunBuiltinAction(uses: string, id: string): boolean {
  const trimmed = uses.trim();
  if (PLAIN_BUILTIN_REF.test(trimmed)) return trimmed === `builtin/${id}`;
  return /^builtin(?:\/|\\)/i.test(trimmed);
}

/** The catalog entry for a step, or null for an action the catalog doesn't know. */
export function workflowStepCatalogEntry(step: {
  readonly uses?: string;
  readonly script: boolean;
}): WorkflowStepCatalogEntry | null {
  if (typeof step.uses !== 'string') return step.script ? SCRIPT_STEP : null;
  const id = builtinActionId(step.uses);
  if (id === null) return null;
  const known = BUILTIN_STEPS.get(id);
  if (known) return known;
  const internal = INTERNAL_STEP_LABELS.get(id);
  if (internal !== undefined)
    return entry(internal, internal, 'ai', PipelineIcon, true);
  return null;
}

/** What a card shows for a step: its task name and icon, with fallbacks. */
export function workflowStepDisplay(step: {
  readonly uses?: string;
  readonly script: boolean;
  readonly name?: string;
  readonly id?: string;
}): {
  readonly task: string;
  readonly title: string;
  readonly icon: WorkflowStepGlyphIcon;
  /** The action id, shown only when the catalog has no task name for it. */
  readonly actionId?: string;
} {
  // `hidden` only keeps an entry out of the picker; cards still name it.
  const known = workflowStepCatalogEntry(step);
  if (known) {
    return {
      task: known.label,
      title: step.name ?? step.id ?? known.label,
      icon: known.icon,
    };
  }
  const title = step.name ?? step.id ?? (step.uses ? 'Action' : 'New step');
  return {
    task: step.uses ? 'Action' : 'Step',
    title,
    icon: PipelineIcon,
    ...(step.uses ? { actionId: step.uses } : {}),
  };
}

/** What the step picker adds: a built-in action, a script, or any action. */
export type WorkflowStepChoice =
  | { readonly kind: 'builtin'; readonly actionId: string }
  | { readonly kind: 'script' }
  | { readonly kind: 'custom' }
  /** A router and paths after it, offered where a job can end in paths. */
  | { readonly kind: 'split' };

export interface WorkflowStepPickerOption {
  readonly key: string;
  readonly choice: WorkflowStepChoice;
  readonly entry: WorkflowStepCatalogEntry;
}

export interface WorkflowStepPickerSection {
  readonly group: WorkflowStepGroup | 'other';
  readonly label: string;
  readonly options: readonly WorkflowStepPickerOption[];
}

const CUSTOM_STEP = entry(
  'Custom action',
  'Use any action by its reference.',
  'code',
  PipelineIcon,
);

/**
 * Built-in actions the picker offers only in their own way. A router is
 * "Split into paths", which adds paths with it, and only where a job can
 * end in paths (`offerSplit`).
 */
const PICKER_DEFERRED: ReadonlySet<string> = new Set(['router']);

/**
 * The step picker's options in purpose order, filtered by `query` against
 * each option's task name and description. Hidden entries never show.
 */
export function workflowStepPickerSections(
  query = '',
  { offerSplit = false }: { readonly offerSplit?: boolean } = {},
): readonly WorkflowStepPickerSection[] {
  const needle = query.trim().toLowerCase();
  const matches = (option: WorkflowStepPickerOption): boolean =>
    needle === '' ||
    option.entry.label.toLowerCase().includes(needle) ||
    option.entry.description.toLowerCase().includes(needle);
  const builtins: WorkflowStepPickerOption[] = [];
  for (const [actionId, known] of BUILTIN_STEPS) {
    if (known.hidden === true || PICKER_DEFERRED.has(actionId)) continue;
    builtins.push({
      key: `builtin:${actionId}`,
      choice: { kind: 'builtin', actionId },
      entry: known,
    });
  }
  const router = BUILTIN_STEPS.get('router');
  if (offerSplit && router)
    builtins.push({ key: 'split', choice: { kind: 'split' }, entry: router });
  builtins.push({
    key: 'script',
    choice: { kind: 'script' },
    entry: SCRIPT_STEP,
  });
  const sections: WorkflowStepPickerSection[] = [];
  for (const group of WORKFLOW_STEP_GROUP_ORDER) {
    const options = builtins.filter(
      (option) => option.entry.group === group && matches(option),
    );
    if (options.length > 0)
      sections.push({
        group,
        label: WORKFLOW_STEP_GROUP_LABELS[group],
        options,
      });
  }
  const custom: WorkflowStepPickerOption = {
    key: 'custom',
    choice: { kind: 'custom' },
    entry: CUSTOM_STEP,
  };
  if (matches(custom))
    sections.push({ group: 'other', label: 'Other', options: [custom] });
  return sections;
}

/**
 * What an automation does, as its one action card (CAN-4224 phase 06). These
 * are never steps a workflow adds, so the picker never offers them.
 */
export type WorkflowDesignerActionKind =
  | 'start-chat'
  | 'send-message'
  | 'run-workflow'
  | 'resume-run';

export const WORKFLOW_DESIGNER_ACTIONS: Readonly<
  Record<
    WorkflowDesignerActionKind,
    { readonly label: string; readonly icon: WorkflowStepGlyphIcon }
  >
> = {
  'start-chat': { label: 'Start chat', icon: ChatIcon },
  'send-message': { label: 'Send message', icon: MessageIcon },
  'run-workflow': { label: 'Run workflow', icon: WorkflowIcon },
  'resume-run': { label: 'Resume run', icon: PlayCircleIcon },
};

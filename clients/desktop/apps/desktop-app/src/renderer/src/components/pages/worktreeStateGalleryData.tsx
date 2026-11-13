import type { JSX } from 'react';
import type {
  ChatPreviewRow,
  WorktreeRowProps,
} from '@canopy/ui-shared/components';
import {
  GraphIcon,
  HookIcon,
  PipelineIcon,
  QuestionMarkIcon,
  RocketLaunchIcon,
  SplitPrIcon,
  TerminalIcon,
  TimeFliesIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  AppAdvisorWatcherIcon,
  DoneCheckIcon,
  PlanMapIcon,
} from '@canopy/ui-shared/icons';

/**
 * Catalog data for the dev/E2E-only Worktree States gallery page
 * (`WorktreeStateGalleryPage.tsx`). Kept in its own module so the page file
 * only exports components (react-refresh) and so tests can iterate the
 * catalog without rendering.
 */

/** Per-state row props: everything except the identity fields the page owns. */
type GalleryRowProps = Omit<
  WorktreeRowProps,
  'branchLabel' | 'branchName' | 'dataTestId'
>;

export interface WorktreeGalleryState {
  /** Stable id used in testids and as the row's sub-label. */
  id: string;
  /** Human state name, rendered as the row's branch label. */
  label: string;
  /** One-line explanation rendered beside the row. */
  description: string;
  props: GalleryRowProps;
}

export interface WorktreeGallerySection {
  title: string;
  description?: string;
  states: WorktreeGalleryState[];
}

/** Slug used in section testids (`gallery-section-<slug>`). */
export function sectionSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const DEMO_PR_OPEN: WorktreeRowProps['lastKnownPrStatus'] = {
  state: 'open',
  checkStatus: 'passing',
  reviewStatus: 'approved',
  label: 'PR #2445',
  title: 'Split sidebar placement from classification',
};

export const WORKTREE_STATE_GALLERY_SECTIONS: WorktreeGallerySection[] = [
  {
    title: 'Chats & plans',
    description:
      'Agent turn states. The spinner means the agent is working now; the blue dot means it finished and you have not looked yet; orange always means it is blocked on you.',
    states: [
      {
        id: 'idle',
        label: 'Idle',
        description: 'Nothing running, nothing unread. The resting row.',
        props: { uiStatus: 'idle' },
      },
      {
        id: 'working',
        label: 'Agent working',
        description:
          'Chat is streaming — accent spinner in the trailing slot, no dot.',
        props: { uiStatus: 'working', isStreaming: true },
      },
      {
        id: 'unread',
        label: 'Unread reply',
        description:
          'The agent finished while you were away — blue unread dot.',
        props: { uiStatus: 'unread', hasUnread: true },
      },
      {
        id: 'question',
        label: 'Needs your answer',
        description:
          'Agent asked a question: orange question-mark leading glyph + orange dot. Outranks the blue unread dot.',
        props: { uiStatus: 'idle', hasPendingQuestion: true },
      },
      {
        id: 'question-while-working',
        label: 'Question while working',
        description:
          'Spinner and the single top-priority attention dot coexist in the trailing cluster.',
        props: {
          uiStatus: 'working',
          isStreaming: true,
          hasPendingQuestion: true,
        },
      },
      {
        id: 'tool-approval',
        label: 'Waiting on approval',
        description:
          'A tool-approval prompt is blocking a chat: orange dot only, and the working spinner is suppressed — the agent is parked, not progressing.',
        props: { uiStatus: 'idle', hasPendingToolApproval: true },
      },
      {
        id: 'tool-approval-unread',
        label: 'Approval + unread',
        description:
          'Needs-input outranks unread: the orange approval dot takes the single dot slot.',
        props: {
          uiStatus: 'unread',
          hasUnread: true,
          hasPendingToolApproval: true,
        },
      },
      {
        id: 'plan-review',
        label: 'Plan ready for review',
        description:
          'Plan-approval shield in the leading slot (question and workflow states outrank it).',
        props: { uiStatus: 'planning', awaitingApproval: true },
      },
      {
        id: 'plan-review-unread',
        label: 'Plan review + unread',
        description:
          'The shield keeps the leading slot; the unread dot still shows on the right.',
        props: {
          uiStatus: 'planning',
          awaitingApproval: true,
          hasUnread: true,
        },
      },
      {
        id: 'planning',
        label: 'Planning',
        description: 'Plan mode active, no approval pending yet.',
        props: { uiStatus: 'planning' },
      },
    ],
  },
  {
    title: 'Workflows',
    description:
      'The workflow glyph carries its state in color: gray running, orange paused, green succeeded-unseen, red failed-unseen. Unseen results also raise a trailing dot.',
    states: [
      {
        id: 'pipeline-running',
        label: 'Workflow running',
        description:
          'Gray glyph while a run executes; the run spinner sits beside the run controls in the real sidebar.',
        props: {
          uiStatus: 'idle',
          isRunningRun: true,
          pipelineStatus: 'running',
        },
      },
      {
        id: 'pipeline-paused',
        label: 'Workflow paused',
        description: 'Orange glyph — the run is waiting on input.',
        props: { uiStatus: 'idle', pipelineStatus: 'paused' },
      },
      {
        id: 'pipeline-unseen',
        label: 'Workflow succeeded (unseen)',
        description: 'Green glyph + blue dot until you open the run.',
        props: { uiStatus: 'idle', pipelineStatus: 'unseen' },
      },
      {
        id: 'pipeline-failed',
        label: 'Workflow failed (unseen)',
        description: 'Red glyph + red dot until you open the run.',
        props: { uiStatus: 'idle', pipelineStatus: 'unseen-failure' },
      },
      {
        id: 'pipeline-failed-unread',
        label: 'Failure + unread chat',
        description:
          'One dot only: the red failure outranks the blue unread; the glyph stays red.',
        props: {
          uiStatus: 'unread',
          hasUnread: true,
          pipelineStatus: 'unseen-failure',
        },
      },
      {
        id: 'pipeline-failed-question',
        label: 'Failure + question',
        description:
          'The red workflow glyph keeps the leading slot; the dot still goes needs-input orange (dot priority is unchanged).',
        props: {
          uiStatus: 'idle',
          hasPendingQuestion: true,
          pipelineStatus: 'unseen-failure',
        },
      },
    ],
  },
  {
    title: 'Terminals',
    description:
      'Terminal glyph tint (promoted to the leading slot when free): neutral while a command runs (the status rail spins), blue when it finished unseen, red when it failed unseen.',
    states: [
      {
        id: 'terminal-running',
        label: 'Terminal running',
        description:
          'Neutral badge with a spinner on the right — a command is executing right now.',
        props: { uiStatus: 'idle', terminalStatus: 'running' },
      },
      {
        id: 'terminal-unseen',
        label: 'Terminal finished (unseen)',
        description: 'Blue badge — the command completed while you were away.',
        props: { uiStatus: 'idle', terminalStatus: 'unseen' },
      },
      {
        id: 'terminal-failed',
        label: 'Terminal failed (unseen)',
        description: 'Red badge — non-zero exit you have not looked at.',
        props: { uiStatus: 'idle', terminalStatus: 'unseen-failure' },
      },
    ],
  },
  {
    title: 'Scripts, graph & standing subjects',
    description:
      'When nothing higher claims the leading slot, the top-priority subject icon is promoted out of the subtitle. Fallback order: split, watchers, scheduled, script, hook, terminal, code graph.',
    states: [
      {
        id: 'script-running',
        label: 'Script running',
        description:
          'Blue rocket promoted to the leading slot; launch/setup/run scripts all collapse into it.',
        props: { uiStatus: 'idle', scriptStatus: 'running' },
      },
      {
        id: 'hook-running',
        label: 'Hook running',
        description:
          'Blue hook promoted to the leading slot while a hook executes.',
        props: { uiStatus: 'idle', hookStatus: 'running' },
      },
      {
        id: 'graph-building',
        label: 'Code graph building',
        description:
          'Neutral hub icon promoted to the leading slot — informational, nothing to act on.',
        props: { uiStatus: 'idle', graphBuildStatus: 'building' },
      },
      {
        id: 'watchers',
        label: 'Watchers standing by',
        description: 'Watcher eye promoted to the leading slot when idle.',
        props: { uiStatus: 'idle', hasIdleWatcherChats: true },
      },
      {
        id: 'scheduled',
        label: 'Scheduled messages',
        description: 'Clock promoted to the leading slot when idle.',
        props: { uiStatus: 'idle', hasScheduledMessages: true },
      },
      {
        id: 'script-behind-pipeline',
        label: 'Script behind a workflow',
        description:
          'The workflow outranks the promotion, so the rocket stays in the subtitle.',
        props: {
          uiStatus: 'idle',
          scriptStatus: 'running',
          isRunningRun: true,
          pipelineStatus: 'running',
        },
      },
    ],
  },
  {
    title: 'Split PR',
    description:
      'The split glyph is promoted to the leading slot when free; the phase shows in the right rail — loader while carving, orange dot in review, purple dot when done.',
    states: [
      {
        id: 'split-active',
        label: 'Split in progress',
        description: 'Carving child branches — trailing loader.',
        props: {
          uiStatus: 'idle',
          splitStatus: 'active',
          splitStatusMessage: 'Carving child branch (2/4)',
        },
      },
      {
        id: 'split-review',
        label: 'Split ready for review',
        description: 'Orange dot — the split plan is waiting on you.',
        props: { uiStatus: 'idle', splitStatus: 'review' },
      },
      {
        id: 'split-done',
        label: 'Split done',
        description: 'Purple dot — child PRs created.',
        props: { uiStatus: 'idle', splitStatus: 'done' },
      },
    ],
  },
  {
    title: 'Lifecycle',
    description:
      'Setup, discovery, and teardown are housekeeping: accent loaders, never attention dots.',
    states: [
      {
        id: 'setup-git-pending',
        label: 'Creating worktree',
        description: 'Git operations still pending — trailing setup loader.',
        props: { uiStatus: 'idle', setupPhase: 'git-pending' },
      },
      {
        id: 'setup-running',
        label: 'Running setup script',
        description: 'Setup script executing — same loader, setup title.',
        props: { uiStatus: 'idle', setupPhase: 'running-setup' },
      },
      {
        id: 'cloud-task-creating',
        label: 'Creating cloud task',
        description:
          'A cloud task opened before the web core created it (CAN-6098): the setup loader, worded as creating the task.',
        props: { uiStatus: 'idle', setupPhase: 'creating' },
      },
      {
        id: 'cloud-task-creation-failed',
        label: 'Cloud task not created',
        description:
          'The web core refused the task (CAN-6098): the status line reads why, with Try again under the same id. No loader.',
        props: {
          uiStatus: 'idle',
          creationFailure: {
            reason: 'This project has reached its task limit.',
            onRetry: (): void => undefined,
          },
        },
      },
      {
        id: 'teardown',
        label: 'Deleting worktree',
        description:
          'Row content fades and goes inert; the loader stays at full opacity.',
        props: {
          uiStatus: 'idle',
          setupPhase: 'running-teardown',
          isTearingDownVisual: true,
        },
      },
      {
        id: 'discovery',
        label: 'Discovering',
        description: 'SDK discovery in flight after creation.',
        props: { uiStatus: 'idle', isDiscovering: true },
      },
      {
        id: 'done',
        label: 'Done (PR merged)',
        description:
          'Purple check when nothing else is active; the checkmark is the quiet-state fallback.',
        props: {
          uiStatus: 'done',
          runtimeState: 'done',
          lastKnownPrStatus: { state: 'merged', label: 'PR #2445' },
        },
      },
      {
        id: 'done-unread',
        label: 'Done + unread',
        description:
          'Done keeps the checkmark (unread is a dot state) but the blue unread dot still shows.',
        props: {
          uiStatus: 'done',
          runtimeState: 'done',
          hasUnread: true,
        },
      },
      {
        id: 'done-active',
        label: 'Done + activity',
        description:
          'Active subjects outrank the checkmark on a done row: the question glyph claims the leading slot, the orange dot and working spinner stay live.',
        props: {
          uiStatus: 'done',
          runtimeState: 'done',
          hasPendingQuestion: true,
          isStreaming: true,
          scriptStatus: 'running',
        },
      },
      {
        id: 'archived',
        label: 'Archived',
        description: 'Badges hidden entirely.',
        props: { uiStatus: 'done', runtimeState: 'archived' },
      },
    ],
  },
  {
    title: 'PRs & metadata',
    description:
      'The metadata line composes independently of status: PR badge, diff stats, depth badge, health warnings.',
    states: [
      {
        id: 'pr-open-passing',
        label: 'PR open, checks passing',
        description: 'Green PR badge with approved review.',
        props: {
          uiStatus: 'idle',
          lastKnownPrStatus: DEMO_PR_OPEN,
          diffStats: { insertions: 128, deletions: 34 },
        },
      },
      {
        id: 'pr-open-failing',
        label: 'PR open, checks failing',
        description: 'Red PR badge.',
        props: {
          uiStatus: 'idle',
          lastKnownPrStatus: {
            state: 'open',
            checkStatus: 'failing',
            reviewStatus: 'pending',
            label: 'PR #2446',
          },
        },
      },
      {
        id: 'pr-draft',
        label: 'Draft PR',
        description: 'Gray draft glyph.',
        props: {
          uiStatus: 'idle',
          lastKnownPrStatus: { state: 'draft', label: 'PR #2447' },
        },
      },
      {
        id: 'pr-conflicts',
        label: 'PR with conflicts',
        description: 'Merge-conflict glyph on an otherwise green PR.',
        props: {
          uiStatus: 'idle',
          lastKnownPrStatus: {
            state: 'open',
            checkStatus: 'passing',
            hasConflicts: true,
            label: 'PR #2448',
          },
        },
      },
      {
        id: 'pr-merge-queue',
        label: 'PR in merge queue',
        description:
          'PR label in the pending tint with a merge glyph in place of the approval check while GitHub runs the merge queue checks. Conflicts outrank it; the glyph reads "In merge queue, position 2" and the tooltip adds "Queue: Awaiting queue checks".',
        props: {
          uiStatus: 'idle',
          lastKnownPrStatus: {
            state: 'open',
            checkStatus: 'passing',
            reviewStatus: 'approved',
            isMergeReady: false,
            inMergeQueue: true,
            mergeQueuePosition: 2,
            mergeQueuePhase: 'awaiting_checks',
            label: 'PR #2450',
          },
        },
      },
      {
        id: 'pr-closed',
        label: 'PR closed',
        description: 'Closed-PR glyph.',
        props: {
          uiStatus: 'idle',
          lastKnownPrStatus: { state: 'closed', label: 'PR #2449' },
        },
      },
      {
        id: 'pr-creating',
        label: 'Creating PR',
        description: 'Inline `PR` label with a creation spinner.',
        props: { uiStatus: 'idle', isCreatingPr: true },
      },
      {
        id: 'shared-with-teammates',
        label: 'Shared with teammates',
        description:
          'Persistent share badge at the trailing edge of the title line, the same slot Cowork rows use. It is metadata, not an activity subject, so it never enters the leading-icon chain, and it fades out under a fine pointer while the row reveals its actions over those pixels.',
        props: { uiStatus: 'idle', sharedWithTeammates: true },
      },
      {
        id: 'shared-while-working',
        label: 'Shared while the agent works',
        description:
          'The share badge coexists with a live subject: the workflow glyph keeps the leading slot and the badge sits on the title line just left of the trailing status cluster.',
        props: {
          uiStatus: 'working',
          isStreaming: true,
          pipelineStatus: 'running',
          lastKnownPrStatus: DEMO_PR_OPEN,
          sharedWithTeammates: true,
        },
      },
      {
        id: 'depth-nested',
        label: 'Nested child branch',
        description:
          'Nested indent + depth badge naming the base-branch ancestry.',
        props: {
          uiStatus: 'idle',
          nested: true,
          nestedChildDepth: 1,
          depthBadge: {
            depth: 2,
            topMost: { branchName: 'develop', animalName: 'brave-otter' },
            directParent: {
              branchName: 'feature/base-branch',
              animalName: 'calm-lynx',
            },
          },
          diffStats: { insertions: 12, deletions: 3 },
        },
      },
      {
        id: 'pinned',
        label: 'Pinned',
        description:
          'Early access: a pin icon sits on the right of the title line, before the age.',
        props: { uiStatus: 'idle', pinnedToTop: true },
      },
      {
        id: 'health-broken',
        label: 'Broken worktree',
        description: 'Warning button — the checkout is missing or damaged.',
        props: {
          uiStatus: 'idle',
          healthIssue: {
            status: 'broken',
            reason: 'Worktree directory missing on disk',
          },
        },
      },
      {
        id: 'health-mismatch',
        label: 'Branch mismatch',
        description: 'Multi-repo child branches diverged from the project.',
        props: {
          uiStatus: 'idle',
          healthIssue: {
            status: 'mismatch',
            reason: 'Child repo branches diverged',
          },
          hasMismatch: true,
        },
      },
    ],
  },
  {
    title: 'Everything at once',
    description:
      'Overlap stress test: every subject stays visible — one leading glyph, one trailing dot, tinted subtitle badges for the rest.',
    states: [
      {
        id: 'composite',
        label: 'All subjects overlapping',
        description:
          'Streaming + failed workflow + unseen terminal + running script + graph build + watchers + scheduled + PR + diff. The red dot wins the trailing slot; everything else keeps its subtitle badge.',
        props: {
          uiStatus: 'working',
          isStreaming: true,
          hasUnread: true,
          pipelineStatus: 'unseen-failure',
          terminalStatus: 'unseen',
          scriptStatus: 'running',
          graphBuildStatus: 'building',
          hasIdleWatcherChats: true,
          hasScheduledMessages: true,
          lastKnownPrStatus: DEMO_PR_OPEN,
          diffStats: { insertions: 245, deletions: 87 },
        },
      },
    ],
  },
];

export interface LegendEntry {
  /** fg-* token class; the swatch dot uses `bg-current` inside it. */
  toneClassName: string;
  title: string;
  description: string;
}

export const LEGEND_ENTRIES: LegendEntry[] = [
  {
    toneClassName: 'fg-info',
    title: 'Blue — running now',
    description: 'A script or hook is executing at this moment.',
  },
  {
    toneClassName: 'fg-accent',
    title: 'Accent spinner — agent working',
    description: 'The chat is streaming; shown as a spinner, never a dot.',
  },
  {
    toneClassName: 'fg-blue',
    title: 'Blue — finished, not seen',
    description:
      'Something completed while you were away: an unread reply, a finished terminal command, an unseen workflow result.',
  },
  {
    toneClassName: 'fg-destructive',
    title: 'Red — failed, not seen',
    description: 'A workflow or terminal command failed and is still unseen.',
  },
  {
    toneClassName: 'fg-warning',
    title: 'Orange — needs your input',
    description: 'Agent question, plan review, or a paused workflow.',
  },
  {
    toneClassName: 'fg-success',
    title: 'Green — succeeded, not seen',
    description: 'The workflow glyph turns green for an unseen success.',
  },
  {
    toneClassName: 'fg-purple',
    title: 'Purple — done',
    description: 'PR merged, split completed, worktree wrapped up.',
  },
  {
    toneClassName: 'fg-quaternary',
    title: 'Gray — housekeeping',
    description:
      'Setup, discovery, code-graph builds: informational only, nothing to act on.',
  },
];

// ---------------------------------------------------------------------------
// Leading-icon priority list (design proposal tool)
// ---------------------------------------------------------------------------

/** Sentinel entry separating promoted subjects from subtitle-only ones. */
export const NOT_PROMOTED_DIVIDER_ID = 'not-promoted-divider';

export interface LeadingPriorityItem {
  label: string;
  /** One-line reminder of what the subject is / how it renders today. */
  description: string;
  icon: JSX.Element;
}

export const LEADING_PRIORITY_ITEMS: Record<string, LeadingPriorityItem> = {
  done: {
    label: 'Done check',
    description:
      'PR merged / wrapped up — fallback when nothing else is active.',
    icon: (
      <span className="fg-purple">
        <DoneCheckIcon size="sm" aria-hidden="true" />
      </span>
    ),
  },
  'plan-review': {
    label: 'Plan review shield',
    description: 'Plan awaiting your approval.',
    icon: (
      <span className="fg-warning">
        <PlanMapIcon size="sm" aria-hidden="true" />
      </span>
    ),
  },
  question: {
    label: 'Question mark',
    description: 'Agent blocked on your answer.',
    icon: (
      <span className="fg-warning">
        <QuestionMarkIcon size={16} />
      </span>
    ),
  },
  'pipeline-paused': {
    label: 'Workflow paused',
    description: 'Orange workflow glyph.',
    icon: (
      <span className="fg-warning">
        <PipelineIcon size={16} />
      </span>
    ),
  },
  'pipeline-result': {
    label: 'Workflow result (unseen)',
    description: 'Green success / red failure glyph.',
    icon: (
      <span className="fg-success">
        <PipelineIcon size={16} />
      </span>
    ),
  },
  'pipeline-running': {
    label: 'Workflow running',
    description: 'Gray workflow glyph.',
    icon: (
      <span className="fg-secondary">
        <PipelineIcon size={16} />
      </span>
    ),
  },
  planning: {
    label: 'Planning',
    description: 'Plan mode active, nothing to approve yet.',
    icon: (
      <span className="fg-secondary">
        <PlanMapIcon size="sm" aria-hidden="true" />
      </span>
    ),
  },
  script: {
    label: 'Script running',
    description: 'Blue rocket (setup/launch/run scripts).',
    icon: (
      <span className="fg-info">
        <RocketLaunchIcon size={16} />
      </span>
    ),
  },
  watchers: {
    label: 'Watchers',
    description: 'Idle chats with active watchers.',
    icon: (
      <span className="fg-secondary">
        <AppAdvisorWatcherIcon size="sm" />
      </span>
    ),
  },
  scheduled: {
    label: 'Scheduled messages',
    description: 'Upcoming scheduled chat messages.',
    icon: (
      <span className="fg-secondary">
        <TimeFliesIcon size={16} />
      </span>
    ),
  },
  terminal: {
    label: 'Terminal',
    description:
      'Promoted when free; neutral while running, then blue or red for the result.',
    icon: (
      <span className="fg-info">
        <TerminalIcon size={16} />
      </span>
    ),
  },
  hook: {
    label: 'Hook running',
    description: 'Promoted when free (blue tint).',
    icon: (
      <span className="fg-info">
        <HookIcon size={16} />
      </span>
    ),
  },
  graph: {
    label: 'Code graph build',
    description: 'Promoted when free (neutral, informational).',
    icon: (
      <span className="fg-secondary">
        <GraphIcon size={16} />
      </span>
    ),
  },
  split: {
    label: 'Split PR',
    description: 'Promoted when free; phase stays in the right rail.',
    icon: (
      <span className="fg-secondary">
        <SplitPrIcon size={16} />
      </span>
    ),
  },
};

/**
 * Default list = the finalized chain implemented in `WorktreeRow`: every
 * subject is promotable, so nothing sits below the divider by default.
 */
export const DEFAULT_LEADING_PRIORITY_ENTRIES: readonly string[] = [
  'pipeline-paused',
  'pipeline-result',
  'pipeline-running',
  'question',
  'plan-review',
  'planning',
  'split',
  'watchers',
  'scheduled',
  'script',
  'hook',
  'terminal',
  'graph',
  'done',
  NOT_PROMOTED_DIVIDER_ID,
];

/**
 * Reconcile a stored (localStorage) priority order against the known entry
 * set: keep known ids in stored order, drop unknown ids, ensure the divider
 * exists, and append missing ids on the side of the divider they occupy in
 * the default list. Any unparsable payload falls back to the default.
 */
export function parseStoredLeadingPriority(raw: string | null): string[] {
  const fallback = [...DEFAULT_LEADING_PRIORITY_ENTRIES];
  if (raw === null || raw === '') return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!Array.isArray(parsed)) return fallback;
  const known = new Set(DEFAULT_LEADING_PRIORITY_ENTRIES);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const id of parsed) {
    if (typeof id === 'string' && known.has(id) && !seen.has(id)) {
      seen.add(id);
      kept.push(id);
    }
  }
  if (!seen.has(NOT_PROMOTED_DIVIDER_ID)) {
    kept.push(NOT_PROMOTED_DIVIDER_ID);
    seen.add(NOT_PROMOTED_DIVIDER_ID);
  }
  const dividerIndex = kept.indexOf(NOT_PROMOTED_DIVIDER_ID);
  const above = kept.slice(0, dividerIndex);
  const below = kept.slice(dividerIndex + 1);
  const defaultDividerIndex = DEFAULT_LEADING_PRIORITY_ENTRIES.indexOf(
    NOT_PROMOTED_DIVIDER_ID,
  );
  DEFAULT_LEADING_PRIORITY_ENTRIES.forEach((id, index) => {
    if (seen.has(id)) return;
    if (index < defaultDividerIndex) above.push(id);
    else below.push(id);
  });
  return [...above, NOT_PROMOTED_DIVIDER_ID, ...below];
}

/** localStorage key for the (dev-only) proposal order. */
export const LEADING_PRIORITY_STORAGE_KEY = 'canopy.dev.leadingIconPriority';

/**
 * Sample unread tail shown by the real `ChatPreviewPopover` when hovering a
 * blue unread dot on the demo page (the live sidebar shows the actual chats).
 */
export const DEMO_UNREAD_PREVIEW_ROWS: ChatPreviewRow[] = [
  {
    chatId: 'demo-chat-1',
    title: 'Fix flaky sidebar spec',
    providerType: 'claude',
    preview:
      'Found it — the hover reserve raced the capture. Patched the spec and re-ran the suite green.',
  },
  {
    chatId: 'demo-chat-2',
    title: 'Refactor terminal badges',
    providerType: 'codex',
    preview: 'Done. Tinted badges now share the split-status color helper.',
  },
];

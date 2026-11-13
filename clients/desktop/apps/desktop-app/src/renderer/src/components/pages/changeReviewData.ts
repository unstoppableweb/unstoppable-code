import type { ChatTabUsage, WakeLockState } from '@canopy/desktop-shared/types';
import type { PipelineAdvisorSnapshot } from '@canopy/execution-engine/types/pipeline';
import type {
  ChatPreviewRow,
  WorktreeRowProps,
} from '@canopy/ui-shared/components';
import type { QueuedChatMessage } from '@/stores/chatStore';
import { createSeededTabUsage } from '@/lib/chatUsageNormalization';
import type { DisplayMessage } from '../chat/types';

/**
 * Fixtures for the dev-only Change review page
 * ({@link ../pages/ChangeReviewPage}): one section per UI fix that landed in
 * the batch `601a4d1575..e4a26ccc52`, plus the seeded props each live
 * "After" rendering needs. Kept apart from the page so the section list reads
 * as data and the page test can iterate it without rendering. Mirrors how
 * `headerStateGalleryData` backs the Header States page.
 */

export const CHANGE_REVIEW_SECTION_IDS = [
  'git-actions',
  'user-bubble',
  'activity-cards',
  'sleep-paused-pill',
  'panel-min-width',
  'plan-updated-badge',
  'context-meter',
  'rich-tooltips',
  'unread-after-answer',
] as const;

export type ChangeReviewSectionId = (typeof CHANGE_REVIEW_SECTION_IDS)[number];

export interface ChangeReviewSection {
  id: ChangeReviewSectionId;
  title: string;
  /** What changed, one or two sentences. */
  summary: string;
  /** Who reported it and where. */
  reportedBy: string;
  /** The old state, described in words — there is no live "before". */
  before: string;
}

export const CHANGE_REVIEW_SECTIONS: readonly ChangeReviewSection[] = [
  {
    id: 'git-actions',
    title: 'Git action buttons in the worktree header',
    summary:
      'The primary git actions (Commit, Commit & Push, Push, Pull, local Merge) now take the accent ink, matching Create PR, while keeping the ghost shell. Nothing gains a fill or a border; the accent colour alone marks the one thing to do next.',
    reportedBy: 'Reported by Mike Standing and Tommy Irish in #design.',
    before:
      'Since the Aug 20 header redesign every git action was ghost text on a transparent body, so Commit and Create PR blended into the breadcrumb and people stopped finding them.',
  },
  {
    id: 'user-bubble',
    title: 'User bubbles in dark mode',
    summary:
      'Sent and queued user bubbles step up to the quaternary surface and carry an inset hairline on the line token, so they read as raised cards in both color modes. Corner badges over the bubble carry the same hairline ring.',
    reportedBy: 'Reported by Tommy Irish (DM).',
    before:
      'The bubble sat one ramp step above the transcript with a black drop shadow. In dark mode the shadow vanished and the bubble merged into the background.',
  },
  {
    id: 'activity-cards',
    title: 'Activity card icons, header actions, and drag reorder',
    summary:
      'Notes and Prompts use the Central note and document-pencil icons their tabs already used. Body-only cards (Notes, Prompts, Attachments, Plans) lift their header action into the shared title-row controls slot, so it aligns with the title like Changed Files. Card reordering activates after 4px of pointer movement again.',
    reportedBy: 'Reported by Tommy Irish (DM).',
    before:
      'Notes and Prompts drew hand-rolled terminal-style glyphs. The + and import buttons were absolute overlays centered on the two-line title block, so they sat visibly lower than the Changed Files action. Drag used a 250ms press delay that cancelled any immediate press-and-drag, so cards could not be rearranged.',
  },
  {
    id: 'sleep-paused-pill',
    title: 'Sleep paused chip',
    summary:
      'The keep-awake indicator is an independent floating chip in the bottom-right corner of the main shell: a labeled pill on the quaternary surface with the house hairline ring, floating above whatever panel content is there like a quiet persistent toast. It appears while an agent turn or workflow runs and "Keep system awake" is enabled in Performance settings.',
    reportedBy: 'Reported by Nick Shatilo in #design.',
    before:
      'The bottom status host became a floating overlay in the header redesign while the indicator was still mounted collapsed, so a bare alarm-clock glyph floated under the composer with no label. A first fix labeled it and centered it along the bottom edge, where it visually sat inside the collapsed terminal tab strip and read as one of its controls.',
  },
  {
    id: 'panel-min-width',
    title: 'Panel minimum width keeps card actions visible',
    summary:
      'The panel leaf floor rises from 100px to 320px, so a card header can no longer be clipped by the leaf when a panel is dragged narrow, and card bodies such as the MCP server rows keep their layout. Persisted layouts below the floor clamp on restore.',
    reportedBy: 'Reported by Paul Costas in #design.',
    before:
      'A panel could be dragged to 100px, at which point the leaf clipped the header and the action button disappeared with no way to reach it.',
  },
  {
    id: 'plan-updated-badge',
    title: 'Workflow row chips',
    summary:
      'Every chip in a workflow run row is one of two shapes. Status badges (execution status, Plan updated, Input required, Advisor ETA) are the shared Badge: an 18px capsule with an 11px label, a subtle status fill and the tone’s strong ink, never bordered; muted completed-row badges keep the geometry and drop to the quiet colour set. Action buttons (Chat, Pipeline, Retry, Start over, Resume, Cancel) share a 24px rounded-md chip with a 2xs label on the same secondary surface as the header Open in pill — quaternary shell, shadow, hairline ring, subtle hover wash — and differ by ink only: neutral, warning, or destructive text on one shell, never a tinted fill. Both come from shared class builders so the row cannot drift again.',
    reportedBy:
      'Follow-up to Torrey Jones’s light-mode pills report in #design (Jul 31) and the CAN-1911 advisor badge fix; the designer standardized the whole row.',
    before:
      'One row mixed a py-1 status pill, a py-0.5 muted pill, a violet Plan updated literal, an Input required badge on an inert border utility, a bordered Advisor ETA badge, sky-tinted follow-up buttons, amber Retry, and bare-text report chips — no two shared a height, radius, or edge treatment.',
  },
  {
    id: 'context-meter',
    title: 'Context meter stays alive across model and session switches',
    summary:
      'A chat whose session has not produced a turn yet still gets a usable meter: the popover opens with a hint, and a tab handed off to another harness or model is seeded with a zeroed usage sized to the target model’s context window.',
    reportedBy: 'CAN-2799, reported by Paul Costas.',
    before:
      'Continue-on-other-harness and stale-session replacement tabs had no usage object, so the meter painted 0% and the popover never opened; in-place model changes kept the old model’s context window.',
  },
  {
    id: 'rich-tooltips',
    title: 'Rich tooltips on composer and sidebar controls',
    summary:
      'Composer chips, Fast mode, message copy, voice input, and sidebar rows use the shared rich Tooltip instead of native title attributes. The unread dot keeps its richer sidebar behavior: hovering or focusing it opens the unread preview popover listing the chats, exactly as the sidebar does.',
    reportedBy: 'CAN-2799.',
    before:
      'Native title tooltips took about a second to appear on macOS and rendered in the OS style, so hover help felt broken.',
  },
  {
    id: 'unread-after-answer',
    title: 'Answering a question clears its unread dot',
    summary:
      'When an agent asks a question, the unread it raises is tagged as question-raised. Answering clears that unread, prunes the worktree key, and marks the chat read on live scopes so the dot does not return on relaunch. Unread from a completed turn is untouched.',
    reportedBy: 'Reported by Sergii Iurevych in #design.',
    before:
      'Answering set answeredAt but left the tab’s unread flag behind, so the orange question dot disappeared and a bare blue unread dot stayed on the sidebar row with nothing new to see.',
  },
];

// ---------------------------------------------------------------------------
// Section 1: git actions — rows from the Header States gallery
// ---------------------------------------------------------------------------

export interface GitActionRow {
  /** `HeaderGalleryState.id` in `headerStateGalleryData`. */
  worktreeId: string;
  caption: string;
}

export const GIT_ACTION_ROWS: readonly GitActionRow[] = [
  {
    worktreeId: 'uncommitted',
    caption: 'Commit & Push and Create PR — accent ink on the ghost shell.',
  },
  {
    worktreeId: 'unpushed',
    caption: 'Push and Create PR — the same accent ink.',
  },
  {
    worktreeId: 'pr-approved',
    caption: 'Merge PR — unchanged, merged ink on the ghost shell.',
  },
  {
    worktreeId: 'pr-failing',
    caption: 'Fix CI — unchanged, warning ink.',
  },
  {
    worktreeId: 'pr-conflicts',
    caption:
      'Commit & Push beside a PR with conflicts — accent ink next to the neutral badges.',
  },
  {
    worktreeId: 'local-only',
    caption:
      'Local Commit (no origin remote) — accent ink as well, since it is the primary action for that worktree.',
  },
];

// ---------------------------------------------------------------------------
// Section 2: user bubbles
// ---------------------------------------------------------------------------

/** Fixed epoch (2026-01-01T00:00:00Z) so rendered stamps are stable. */
export const CHANGE_REVIEW_FIXED_NOW = 1_767_225_600_000;

export interface UserBubbleFixture {
  id: string;
  title: string;
  message: DisplayMessage;
}

export const USER_BUBBLE_FIXTURES: readonly UserBubbleFixture[] = [
  {
    id: 'default',
    title: 'Sent message (default surface)',
    message: {
      id: 'change-review-user-default',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: 'Refactor the sidebar status chain:\n\n- keep the spinner in the trailing slot\n- collapse the dots into one attention dot\n\nThen run the targeted Jest suite.',
        },
      ],
      timestamp: CHANGE_REVIEW_FIXED_NOW,
    },
  },
  {
    id: 'info',
    title: 'Watcher-fired (info tint, same hairline)',
    message: {
      id: 'change-review-user-info',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: 'The Deploy workflow finished. Summarize what shipped and flag anything that needs a follow-up.',
        },
      ],
      timestamp: CHANGE_REVIEW_FIXED_NOW,
      watcherFired: { kind: 'Workflow completion (Deploy)' },
    },
  },
];

export interface QueuedBubbleFixture {
  id: string;
  title: string;
  message: QueuedChatMessage;
}

export const QUEUED_BUBBLE_FIXTURES: readonly QueuedBubbleFixture[] = [
  {
    id: 'queued',
    title: 'Queued while streaming (shares the sent surface)',
    message: {
      text: 'After that, also update the dark-mode captures.',
      hostQueueEntryId: 'change-review-queued',
      turnPhase: 'foreground',
      enqueuedAtMs: CHANGE_REVIEW_FIXED_NOW,
    },
  },
  {
    id: 'queued-info',
    title: 'Queued watcher message (info tint)',
    message: {
      text: 'CI guard fired on the release branch — triage the failing job.',
      hostQueueEntryId: 'change-review-queued-info',
      turnPhase: 'foreground',
      enqueuedAtMs: CHANGE_REVIEW_FIXED_NOW,
      watcherFired: { kind: 'Hook (CI guard)' },
    },
  },
];

// ---------------------------------------------------------------------------
// Section 3: activity cards
// ---------------------------------------------------------------------------

export type ActivityCardIcon = 'notes' | 'prompts' | 'attachments' | 'plans';

export interface ActivityCardFixture {
  id: ActivityCardIcon;
  title: string;
  /** Header subtitle as the shipping chrome hook would compute it. */
  subtitle: string;
  actionLabel: string;
  /** Static body rows standing in for the section's list. */
  rows: readonly string[];
}

export const ACTIVITY_CARD_FIXTURES: readonly ActivityCardFixture[] = [
  {
    id: 'notes',
    title: 'Notes',
    subtitle: '1 note',
    actionLabel: 'Add note',
    rows: ['Release checklist'],
  },
  {
    id: 'prompts',
    title: 'Prompts',
    subtitle: '2 prompts',
    actionLabel: 'Add prompt',
    rows: ['Code review pass', 'Write PR description'],
  },
  {
    id: 'attachments',
    title: 'Attachments',
    subtitle: '1 file',
    actionLabel: 'Import attachments',
    rows: ['design.png'],
  },
  {
    id: 'plans',
    title: 'Plans',
    subtitle: '1 tracked',
    actionLabel: 'Import plan document',
    rows: ['Sidebar status rework'],
  },
];

export const CHANGED_FILES_REFERENCE = {
  title: 'Changed Files',
  subtitle: '3 files',
  actionLabel: 'Review changes',
  rows: [
    'src/renderer/src/components/sidebar/WorktreeRow.tsx',
    'packages/ui-shared/src/components/PanelSection.tsx',
    'docs/sidebar-worktree-status.md',
  ],
} as const;

// ---------------------------------------------------------------------------
// Section 4: sleep paused pill
// ---------------------------------------------------------------------------

export const DEMO_WAKE_LOCK_STATE: WakeLockState = {
  active: true,
  enabled: true,
  holderCount: 1,
};

// ---------------------------------------------------------------------------
// Section 6: pipeline row chips — an advisor snapshot for the ETA badge
// ---------------------------------------------------------------------------

export const DEMO_ADVISOR_SNAPSHOT: PipelineAdvisorSnapshot = {
  version: 1,
  executionId: 'change-review-execution',
  executionDataDir: '/demo/executions/change-review',
  stateFilePath: '/demo/executions/change-review/advisor.json',
  provider: 'claude',
  model: 'opus',
  thinkingLevel: 'medium',
  status: 'running',
  turnCount: 1,
  backoffIndex: 0,
  lastUpdatedAt: '2026-01-01T00:00:00.000Z',
  reports: [],
};

// ---------------------------------------------------------------------------
// Section 7: context meter
// ---------------------------------------------------------------------------

/** The Claude model the seeded meter is sized for. */
export const CONTEXT_METER_MODEL = 'claude-sonnet-4-6';

/**
 * Fallback for jsdom and any runtime where the model registry has not been
 * initialized: the same all-zero shape `createSeededTabUsage` produces, with
 * the model's published 200K window.
 */
const FALLBACK_SEEDED_USAGE: ChatTabUsage = {
  contextTokens: 0,
  contextWindow: 200_000,
  maxOutputTokens: 0,
  totalCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  durationMs: 0,
  durationApiMs: 0,
  numTurns: 0,
  model: CONTEXT_METER_MODEL,
};

/**
 * The zeroed usage a handed-off tab is seeded with (CAN-2799), computed by
 * the shipping helper when the model registry knows the window.
 */
export function buildSeededContextMeterUsage(): ChatTabUsage {
  return createSeededTabUsage(CONTEXT_METER_MODEL) ?? FALLBACK_SEEDED_USAGE;
}

// ---------------------------------------------------------------------------
// Sections 8 and 9: sidebar rows
// ---------------------------------------------------------------------------

export type SidebarRowFixtureProps = Omit<
  WorktreeRowProps,
  'branchLabel' | 'branchName' | 'dataTestId'
>;

export interface SidebarRowFixture {
  id: string;
  label: string;
  caption: string;
  props: SidebarRowFixtureProps;
  /**
   * Seeded chats behind the row's unread dot. When present, the page wires
   * the dot to the same `ChatPreviewPopover` the sidebar opens on hover and
   * focus (see `WorktreeItem`), so the dot never falls back to the plain
   * "Unread messages" tooltip the bare `WorktreeRow` shows without a host.
   */
  unreadPreviewRows?: readonly ChatPreviewRow[];
}

/** Static stand-ins for `buildChatPreviewRows(wtKey, 'unread')`. */
const TOOLTIP_ROW_UNREAD_PREVIEWS: readonly ChatPreviewRow[] = [
  {
    chatId: 'change-review-unread-tooltip-1',
    title: 'Wire the retry banner',
    providerType: 'claude',
    preview:
      'Added the banner and a unit test; the copy follows the ux-writing guide.',
  },
  {
    chatId: 'change-review-unread-tooltip-2',
    title: 'Investigate flaky workflow step',
    providerType: 'codex',
    preview: 'The step races the cache warm-up. I have a fix ready to review.',
  },
  {
    chatId: 'change-review-unread-tooltip-3',
    title: 'Release notes draft',
    providerType: 'claude',
    preview: 'Drafted the notes for 0.26.8 from the merged PR titles.',
  },
];

const ANSWERED_BEFORE_UNREAD_PREVIEWS: readonly ChatPreviewRow[] = [
  {
    chatId: 'change-review-unread-answered-1',
    title: 'Migrate settings storage',
    providerType: 'claude',
    preview: 'Which of the two storage roots should win on conflict?',
  },
  {
    chatId: 'change-review-unread-answered-2',
    title: 'Tidy sidebar status colors',
    providerType: 'codex',
    preview: 'Swapped the literals for the *-subtle roles; all tests green.',
  },
];

/** A busy row for the tooltip strip: pipeline badge plus an unread dot. */
export const TOOLTIP_SIDEBAR_ROW: SidebarRowFixture = {
  id: 'tooltip-row',
  label: 'Workflow running',
  caption:
    'Hover the status badge for its tooltip. Hover or focus the dot to open the unread preview listing the chats, as in the sidebar.',
  props: {
    uiStatus: 'working',
    pipelineStatus: 'running',
    hasUnread: true,
  },
  unreadPreviewRows: TOOLTIP_ROW_UNREAD_PREVIEWS,
};

export const UNREAD_AFTER_ANSWER_ROWS: readonly SidebarRowFixture[] = [
  {
    id: 'question-open',
    label: 'Question open',
    caption:
      'The agent asked something: orange question glyph and dot, with the unread it raised underneath.',
    props: { uiStatus: 'idle', hasPendingQuestion: true, hasUnread: true },
  },
  {
    id: 'answered-now',
    label: 'After answering (now)',
    caption:
      'The question-raised unread clears with the answer, so the row goes back to resting.',
    props: { uiStatus: 'idle', hasUnread: false },
  },
  {
    id: 'answered-before',
    label: 'After answering (before)',
    caption:
      'Previously the blue dot stayed behind with nothing new to see. Hover or focus it to open the unread preview, as in the sidebar.',
    props: { uiStatus: 'unread', hasUnread: true },
    unreadPreviewRows: ANSWERED_BEFORE_UNREAD_PREVIEWS,
  },
];

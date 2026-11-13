import type { QueuedChatMessage } from '@/stores/chatStore';
import type { ScheduledQueuedMessage } from '@/lib/worktreeSessionPromptAutomations';
import type { DisplayMessage } from '../chat/types';

/**
 * Fixture data for the dev-only Message Bubble States gallery page. Every
 * entry feeds the REAL chat components (`ChatMessageItem`,
 * `QueuedMessageBubble`) with direct props so the gallery always reflects the
 * shipped styling — including the shared `UserBubble` shell from
 * `@canopy/ui-shared`.
 */

export interface MessageGalleryState {
  id: string;
  title: string;
  description: string;
  message: DisplayMessage;
  /** Renders the revert hover affordance when true. */
  withRevert?: boolean;
}

export interface QueuedGalleryState {
  id: string;
  title: string;
  description: string;
  message: QueuedChatMessage;
  canForce?: boolean;
  scheduled?: boolean;
  /** A scheduled message other schedules' shared workflow makes read-only. */
  scheduledWorkflow?: boolean;
  /** The row offers Steer as well as Interrupt. */
  steerable?: boolean;
}

/**
 * Fixed epoch rather than `Date.now()`. The gallery is the surface the capture
 * spec screenshots, and the queued/scheduled bubbles render values derived
 * from these timestamps — a wall-clock value would change on every run and
 * make before/after captures impossible to compare.
 *
 * 2026-01-01T00:00:00Z.
 */
export const GALLERY_FIXED_NOW = 1_767_225_600_000;

const NOW = GALLERY_FIXED_NOW;

function userMessage(
  id: string,
  text: string,
  extra?: Partial<DisplayMessage>,
): DisplayMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: NOW,
    ...extra,
  };
}

export const USER_BUBBLE_STATES: MessageGalleryState[] = [
  {
    id: 'short-text',
    title: 'Short prompt',
    description:
      'Single-line user message — the baseline pill. Hover to reveal the copy affordance.',
    message: userMessage('demo-user-short', 'Fix the flaky sidebar test'),
  },
  {
    id: 'multiline-markdown',
    title: 'Multiline with markdown',
    description:
      'Paragraphs, inline code, and a list — checks padding and line rhythm inside the shell.',
    message: userMessage(
      'demo-user-markdown',
      'Refactor the `chatStore` persistence:\n\n- debounce saves at 500ms\n- keep writes debounced\n- do **not** switch to synchronous writes\n\nThen run the targeted Jest suite.',
    ),
  },
  {
    id: 'with-revert',
    title: 'Revertible turn',
    description:
      'Worktree chats pass a revert handler — hover shows Revert next to Copy in the top-right cluster.',
    message: userMessage(
      'demo-user-revert',
      'Rename the feature flag and update both defaults.',
    ),
    withRevert: true,
  },
  {
    id: 'file-references',
    title: 'With file references',
    description:
      'Composer @-mentions arrive as a file_references block rendered above the prompt text.',
    message: {
      id: 'demo-user-files',
      role: 'user',
      blocks: [
        {
          type: 'file_references',
          references: [
            {
              displayPath: 'src/renderer/src/components/chat/UserBubble.tsx',
              absolutePath:
                '/demo/src/renderer/src/components/chat/UserBubble.tsx',
            },
            {
              displayPath: 'packages/ui-shared/src/components/UserBubble.tsx',
              absolutePath:
                '/demo/packages/ui-shared/src/components/UserBubble.tsx',
            },
          ],
        },
        { type: 'text', text: 'Align the paddings between these two shells.' },
      ],
      timestamp: NOW,
    },
  },
  {
    id: 'very-long',
    title: 'Very long message (clamped)',
    description:
      'Long content clamps to four measured line boxes — three at full strength plus a fourth sliced by a fading mask — so it reads as continuing rather than ending. Hovering reveals a Show more pill over the cut; expanding reveals the whole message.',
    message: userMessage(
      'demo-user-long',
      Array.from(
        { length: 12 },
        (_, i) =>
          `Paragraph ${i + 1}: pasted specs and stack traces run long, so the bubble clamps and offers Show more rather than growing without bound.`,
      ).join('\n\n'),
    ),
  },
  {
    id: 'overflow',
    title: 'Unbroken overflow',
    description:
      'A long unbreakable token — verifies the bubble clamps width instead of forcing horizontal scroll.',
    message: userMessage(
      'demo-user-overflow',
      'Why does https://example.com/very/long/path/that/never/ends/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html 404?',
    ),
  },
];

export const ASSISTANT_MESSAGE_STATES: MessageGalleryState[] = [
  {
    id: 'assistant-text',
    title: 'Assistant reply',
    description:
      'Assistant output renders flat (no shell) — shown here for side-by-side contrast with the user pill.',
    message: {
      id: 'demo-assistant-text',
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text: 'Done — the padding now matches on both shells. I ran the targeted Jest suite and everything passes:\n\n- `UserBubble` uses `px-3 py-1.5`\n- the queued bubble keeps `p-3`\n\nLet me know if you want the radius aligned too.',
        },
      ],
      timestamp: NOW,
    },
  },
];

export const QUEUED_BUBBLE_STATES: QueuedGalleryState[] = [
  {
    id: 'queued-default',
    title: 'Queued while streaming',
    description:
      'Message waiting for the current turn to finish. Interrupt is available; hover for actions.',
    message: {
      text: 'After that, also update the dark-mode captures.',
      hostQueueEntryId: 'demo-host-queue-entry',
      turnPhase: 'foreground',
      enqueuedAtMs: NOW,
    },
    canForce: true,
  },
  {
    id: 'queued-settings-held',
    title: 'Queued while new settings wait',
    description:
      'The model and plugins changed while background work runs. A warning before Steer and Interrupt names them and explains that Steer joins the current reply without them, and Interrupt still waits for the background work.',
    message: {
      text: 'Use the new model to review the migration.',
      hostQueueEntryId: 'demo-host-queue-entry-settings-held',
      turnPhase: 'foreground',
      canSteer: true,
      restartHeldChanges: ['model', 'plugins'],
      enqueuedAtMs: NOW,
    },
    canForce: true,
    steerable: true,
  },
  {
    id: 'queued-background',
    title: 'Still queued with no turn running',
    description:
      'The turn has ended and only background agents are working, so there is nothing to steer or interrupt. Try again sends the message now.',
    message: {
      text: 'Then summarize what the agents found.',
      hostQueueEntryId: 'demo-host-queue-entry-background',
      turnPhase: 'background',
      enqueuedAtMs: NOW,
    },
    canForce: true,
  },
  {
    id: 'queued-hook',
    title: 'Hook-queue placeholder',
    description:
      'Hook-chat concurrency queue: a reason line renders under the header, Edit is hidden, and Run now starts it without waiting.',
    message: {
      text: 'Triage the failing pre-commit hook output.',
      reason: 'Waiting for active chat sessions to finish.',
      queuedHookQueueId: 'demo-hook-queue-entry',
      enqueuedAtMs: NOW,
    },
    canForce: true,
  },
  {
    id: 'queued-retry',
    title: 'Kept after a failed launch',
    description:
      'The Claude Code terminal did not start, so the prompt stays queued on this device. Try again resends it.',
    message: {
      text: 'Rerun the migration check.',
      enqueuedAtMs: NOW,
    },
    canForce: true,
  },
  {
    id: 'scheduled',
    title: 'Scheduled message',
    description:
      'One-time automation-backed send: a single "Sends …" row, the prompt clamped to three rows, and automation actions.',
    message: {
      text: [
        'Post the nightly summary of merged PRs to the team channel.',
        'Group the pull requests by area (desktop, web, shared packages) and call out anything that touched persistence or the core/worker boundary.',
        'For each group, list the PR title, author, and a one-line summary of the user-visible change.',
        'Close with the count of PRs still waiting on review and link the oldest three.',
      ].join('\n\n'),
      enqueuedAtMs: NOW,
    },
    scheduled: true,
  },
  {
    id: 'scheduled-shared-workflow',
    title: 'Scheduled message, shared workflow',
    description:
      'Other schedules run the same workflow, so the message is edited on its Workflow page: no Edit, and an "Open workflow" link.',
    message: {
      text: 'Post the nightly summary of merged PRs to the team channel.',
      enqueuedAtMs: NOW,
    },
    scheduled: true,
    scheduledWorkflow: true,
  },
];

export interface RecurringNoticeGalleryState {
  id: string;
  title: string;
  description: string;
  automations: ScheduledQueuedMessage[];
}

function recurringAutomation(
  automationId: string,
  activityName: string,
  scheduleExpression: string,
  offsetMs: number,
): ScheduledQueuedMessage {
  return {
    automationId,
    activityName,
    chatId: 'demo-chat',
    text: 'Summarize the macOS runner minutes saved since the last report.\nCompare against the previous week.\nFlag any job that got slower.',
    scheduledAt: new Date(NOW + offsetMs).toISOString(),
    scheduleKind: 'cron',
    scheduleExpression,
  };
}

/**
 * Recurring automations never render as transcript bubbles; they surface as
 * one composer notice line. Shown here so the capture spec can compare it
 * against the one-time bubble above.
 */
export const RECURRING_NOTICE_STATES: RecurringNoticeGalleryState[] = [
  {
    id: 'scheduled-recurring-notice',
    title: 'Recurring automation',
    description:
      'A recurring automation targeting the chat: cadence, name, and next run on one line above the composer, with Run now and an options menu.',
    automations: [
      recurringAutomation(
        'demo-recurring',
        'macOS runner savings report',
        '0 * * * *',
        3_600_000,
      ),
    ],
  },
  {
    id: 'scheduled-recurring-notice-several',
    title: 'Several recurring automations',
    description:
      'More than one recurring automation in the same chat collapses to a count, the soonest next run, and Manage.',
    automations: [
      recurringAutomation(
        'demo-recurring',
        'macOS runner savings report',
        '0 * * * *',
        3_600_000,
      ),
      recurringAutomation(
        'demo-recurring-daily',
        'Daily standup notes',
        '30 9 * * *',
        7_200_000,
      ),
    ],
  },
];

export function messageSectionSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

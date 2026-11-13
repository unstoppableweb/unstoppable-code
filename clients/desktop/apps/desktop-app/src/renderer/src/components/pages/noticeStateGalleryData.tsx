import type { ReactNode } from 'react';
import type {
  NoticeActionsPlacement,
  NoticeButtonVariant,
  NoticeIntent,
} from '@canopy/ui-shared/components';
import { NoticeList, NoticeListItem, RetryCountdown } from '@canopy/ui-shared';
import { LIFETIME_LIMIT_NOTICE_COPY } from '@canopy/ui-shared/components/chat/subagents/panel/LifetimeLimitNoticeDisplay';
import {
  AgentAssistantIcon,
  CoinsIcon,
  DocumentIcon,
  PluginsIcon,
  RevertIcon,
  SkillIcon,
  TimeslotIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  DATA_SHARING_OPT_IN_PERSONAL_COPY,
  DATA_SHARING_OPT_IN_STATE_COPY,
  DataSharingOptInScopeSummary,
  dataSharingOptInActionLabel,
  dataSharingOptInErrorText,
  dataSharingOptInHeadline,
} from '@canopy/ui-shared/components/DataSharingOptInCta';
import {
  FIRST_SEND_FAILED_CHOOSE_MODEL_LABEL,
  FIRST_SEND_FAILED_RETRY_LABEL,
  usageLimitModelSwitchActionLabel,
  usageLimitModelSwitchFailureDetail,
  usageLimitModelSwitchMessage,
} from '@canopy/ui-shared/components';
import {
  FIRST_SEND_FAILED_TITLE,
  homeModelFailureMessage,
} from '@/components/home/homeModelFailureCopy';
import { SPLIT_PR_BLOCKER_COPY } from '@/lib/splitPrEligibilityInputs';
import { brandText } from '@/lib/brand';
import { SKILL_SHARE_NUDGE_COPY } from '@/components/chat/SkillShareNudgeBanner';
import { SKILL_SUGGESTION_COPY } from '@canopy/ui-app';
import { automationRevealNoticeCopy } from '@/components/automations/automationRevealNotice';
import { installRevealNotice } from '@/components/share/installRevealNotice';
import { automationRunsInMessage } from '@canopy/execution-engine/lib/automation-context-copy';
import {
  askOwnerToChoosePlanCopy,
  CHOOSE_ORG_PLAN_COPY,
  CHOOSE_ORG_PLAN_LABEL,
  orgWithoutPlanTitle,
} from '@/lib/organizationPlan';
import {
  CONTACT_ORG_ADMIN_COPY,
  CONTACT_ORG_ADMIN_LAPSED_COPY,
} from '@/lib/openBillingPage';
import {
  CHAT_STATE_COMMAND_FAILED_NOTICE,
  CHAT_STATE_COMMAND_FAILED_TITLE,
  CHAT_STATE_CONFLICT_NOTICE,
  CHAT_STATE_CONFLICT_TITLE,
  CHAT_STATE_REFRESH_ERROR_HEADING,
  CHAT_STATE_REFRESH_ERROR_HELPER,
  CHAT_STATE_REFRESH_RETRY_LABEL,
  CHAT_STATE_REFRESHING_TOAST,
} from '@/stores/chat/revisioned-copy';

/**
 * Fixtures for the Notice States gallery page
 * ({@link ../pages/NoticeStateGalleryPage}).
 *
 * The composer notices and the other title-first notices, as the props they
 * hand the shared `Notice`, grouped by the surface they appear on. Static
 * copy is quoted from the shipping component (or imported where a constant
 * exists); rows whose copy is built from runtime data (a data-folder path, a
 * transcript timestamp, a pipeline pause reason) carry a representative
 * example instead. When a notice's wording changes, update the entry here in
 * the same change. Fixture facts (org names, counts, times) are examples and
 * are labelled as such on the page.
 */

const brand = brandText.appName;

export interface NoticeGalleryAction {
  label: string;
  variant?: NoticeButtonVariant;
  disabled?: boolean;
}

export interface NoticeGalleryEntry {
  /** Stable id; also the row's test id suffix. */
  id: string;
  /** Row caption: which notice and which of its states this is. */
  title: string;
  /** What raises it, or what to look at. */
  note?: string;
  intent: NoticeIntent;
  /** Override the intent glyph; `null` hides the icon column. */
  icon?: ReactNode | null;
  heading?: ReactNode;
  message: ReactNode;
  detail?: ReactNode;
  actions?: readonly NoticeGalleryAction[];
  /** Plain trailing content in the actions slot (a live value, not a button), ahead of any buttons. */
  aside?: ReactNode;
  actionsPlacement?: NoticeActionsPlacement;
  dismissible?: boolean;
  /** Static prose rendered without a live region. */
  live?: boolean;
}

export interface NoticeGallerySection {
  id: string;
  title: string;
  note: string;
  entries: readonly NoticeGalleryEntry[];
}

const lower = (copy: string): string =>
  copy.charAt(0).toLowerCase() + copy.slice(1);

export const NOTICE_GALLERY_SECTIONS: readonly NoticeGallerySection[] = [
  {
    id: 'delegation-lifetime-limit',
    title: 'Managed-delegate lifetime limit',
    note: 'Shared panel and refused-chat notices. The capability gate is static; unavailable storage never claims the worktree is full.',
    entries: [
      {
        id: 'lifetime-limit-full',
        title: 'Full: extension available',
        intent: 'attention',
        heading: LIFETIME_LIMIT_NOTICE_COPY.fullTitle,
        message: LIFETIME_LIMIT_NOTICE_COPY.fullMessage,
        actions: [
          { label: LIFETIME_LIMIT_NOTICE_COPY.extend, variant: 'primary' },
        ],
      },
      {
        id: 'lifetime-limit-at-cap',
        title: 'Full: build maximum',
        intent: 'attention',
        heading: LIFETIME_LIMIT_NOTICE_COPY.fullTitle,
        message: LIFETIME_LIMIT_NOTICE_COPY.atCapMessage,
      },
      {
        id: 'lifetime-limit-read-only',
        title: 'Full: extension unavailable',
        intent: 'attention',
        heading: LIFETIME_LIMIT_NOTICE_COPY.fullTitle,
        message: LIFETIME_LIMIT_NOTICE_COPY.readOnlyMessage,
      },
      {
        id: 'lifetime-limit-unavailable',
        title: 'Status unavailable',
        intent: 'neutral',
        heading: LIFETIME_LIMIT_NOTICE_COPY.unavailableTitle,
        message: LIFETIME_LIMIT_NOTICE_COPY.unavailableMessage,
      },
      {
        id: 'lifetime-limit-gated',
        title: 'Capability gated',
        intent: 'neutral',
        live: false,
        heading: LIFETIME_LIMIT_NOTICE_COPY.gatedTitle,
        message: LIFETIME_LIMIT_NOTICE_COPY.gatedMessage,
      },
      {
        id: 'lifetime-limit-pending',
        title: 'Extension pending',
        intent: 'attention',
        heading: LIFETIME_LIMIT_NOTICE_COPY.fullTitle,
        message: LIFETIME_LIMIT_NOTICE_COPY.fullMessage,
        actions: [
          {
            label: LIFETIME_LIMIT_NOTICE_COPY.extend,
            variant: 'primary',
            disabled: true,
          },
        ],
      },
      {
        id: 'lifetime-limit-failed',
        title: 'Extension failed',
        intent: 'attention',
        heading: LIFETIME_LIMIT_NOTICE_COPY.fullTitle,
        message: LIFETIME_LIMIT_NOTICE_COPY.fullMessage,
        detail: LIFETIME_LIMIT_NOTICE_COPY.failed,
        actions: [
          { label: LIFETIME_LIMIT_NOTICE_COPY.extend, variant: 'primary' },
        ],
      },
      {
        id: 'lifetime-limit-uncertain',
        title: 'Extension uncertain',
        intent: 'attention',
        heading: LIFETIME_LIMIT_NOTICE_COPY.fullTitle,
        message: LIFETIME_LIMIT_NOTICE_COPY.fullMessage,
        detail: LIFETIME_LIMIT_NOTICE_COPY.uncertain,
        actions: [
          { label: LIFETIME_LIMIT_NOTICE_COPY.extend, variant: 'primary' },
        ],
      },
    ],
  },
  {
    id: 'standing-conditions',
    title: 'Standing conditions',
    note: 'One app-level banner: the highest-ranked active condition and a count of the rest. Appearance only; detection lives in the hosts.',
    entries: [
      {
        id: 'standing-offline',
        title: 'Device offline',
        note: 'Hides conditions that need the network from the banner and its count.',
        intent: 'attention',
        heading: "Couldn't reach the network.",
        message: 'Check your connection, then try again.',
      },
      {
        id: 'standing-session-expired',
        title: 'Session expired, with one more issue',
        note: 'Offers Open settings instead for a manual credential.',
        intent: 'attention',
        heading: 'Your sign-in has expired.',
        message: 'Sign in again to continue.',
        aside: '1 more issue',
        actions: [{ label: 'Sign in' }],
      },
      {
        id: 'standing-runtime-defect',
        title: 'Claude or Codex unreachable (defect)',
        note: 'Two failed auth probes, 5 seconds apart. Retests every 30 seconds until it recovers.',
        intent: 'destructive',
        heading: "Couldn't reach Claude.",
        message:
          "Agents on it can't start. Try again, or report this if it continues.",
        detail: 'Reference ERR-0000AB12',
        aside: '2 more issues',
        actions: [{ label: 'Try again' }, { label: 'Report this' }],
        actionsPlacement: 'below',
      },
      {
        id: 'standing-runtime-external',
        title: 'Ollama unreachable (external)',
        note: 'Retests every 30 seconds, and clears on the next send.',
        intent: 'attention',
        heading: "Couldn't reach Ollama.",
        message: 'Start it or check its connection settings.',
        actions: [{ label: 'Open Ollama settings' }],
      },
      {
        id: 'standing-sync-paused',
        title: 'Sync paused',
        note: 'Clears on its own when sync resumes.',
        intent: 'neutral',
        heading: 'Sync is paused.',
        message: 'Your work is saved on this device and syncs later.',
      },
    ],
  },
  {
    id: 'composer',
    title: 'Composer',
    note: 'Stacked above the chat input in one column that collapses when nothing is up. Every one is a short title for the state, then the choice or next step on the same line.',
    entries: [
      {
        id: 'plan-mode-suggestion',
        title: 'Multi-step draft: plan mode suggestion',
        intent: 'neutral',
        heading: 'Plan first?',
        message:
          'This looks like a multi-step task. Plan mode works out the approach before making changes.',
        actions: [{ label: 'Plan first', variant: 'primary' }],
        dismissible: true,
      },
      {
        id: 'usage-limit-offer',
        title: 'Usage limit reached: credits available',
        note: 'Shown only when no purchase from this chat was recorded. The message ends with a question and the buttons answer it on their own row; the accent action is last. The per-chat action is the accent; the global action is never the accent.',
        intent: 'attention',
        heading: 'Claude usage limit reached',
        message:
          'Your quota resets around 6:00 PM. Do you want to use AI Credits to keep going?',
        actions: [
          { label: 'No, resume at 6:00 PM' },
          { label: 'Always' },
          { label: 'Just this chat', variant: 'primary' },
        ],
        actionsPlacement: 'below',
        dismissible: true,
      },
      {
        id: 'usage-limit-model-not-routable',
        title: 'Usage limit reached: model cannot use credits',
        note: "The chat's model has no AI Credits route, so no credits are offered. The accent action moves this chat onto the credits model and routes it through credits until the limit resets. Worktree chats only; other surfaces show the message without the button.",
        intent: 'attention',
        heading: 'Codex usage limit reached',
        message: usageLimitModelSwitchMessage({
          modelLabel: 'GPT 6 Sol',
          targetModelLabel: 'GPT 6 Luna',
          resetsLabel: '8:14 PM',
        }),
        actions: [
          { label: 'Resume at 8:14 PM' },
          {
            label: usageLimitModelSwitchActionLabel('GPT 6 Luna'),
            variant: 'primary',
          },
        ],
        actionsPlacement: 'below',
        dismissible: true,
      },
      {
        id: 'usage-limit-model-switch-failed',
        title: 'Usage limit reached: model switch failed',
        note: 'The switch was rejected, so routing is untouched and the notice keeps focus.',
        intent: 'attention',
        heading: 'Codex usage limit reached',
        message: usageLimitModelSwitchMessage({
          modelLabel: 'GPT 6 Sol',
          targetModelLabel: 'GPT 6 Luna',
          resetsLabel: '8:14 PM',
        }),
        detail: usageLimitModelSwitchFailureDetail({
          targetModelLabel: 'GPT 6 Luna',
          resetsLabel: '8:14 PM',
        }),
        actions: [
          { label: 'Resume at 8:14 PM' },
          {
            label: usageLimitModelSwitchActionLabel('GPT 6 Luna'),
            variant: 'primary',
          },
        ],
        actionsPlacement: 'below',
        dismissible: true,
      },
      {
        id: 'usage-limit-use-ai-credits',
        title: 'Usage limit reached: credits unconfirmed',
        note: 'Coverage is still loading or routing is already on; the accent action routes this chat through credits.',
        intent: 'attention',
        heading: 'Claude usage limit reached',
        message: 'Do you want to use AI Credits until your quota resets?',
        actions: [{ label: 'Use AI Credits', variant: 'primary' }],
        actionsPlacement: 'below',
        dismissible: true,
      },
      {
        id: 'usage-limit-arrival-routed',
        title: 'Credits bought: using AI Credits',
        note: "Buy AI Credits routed this chat once the purchase landed. The purchase is the card's state until the first credits turn starts, so no balance repeats it; the reset time sits beside the secondary switch it explains.",
        intent: 'positive',
        heading: '16 AI Credits added.',
        message: 'Ready to use in this chat.',
        aside: (
          <span className="mr-1 shrink-0 whitespace-nowrap tabular-nums fg-tertiary">
            Claude resets 5:30 PM
          </span>
        ),
        actions: [{ label: 'Switch to subscription' }],
      },
      {
        id: 'usage-limit-arrival-fallback',
        title: 'Credits bought: no per-chat choice',
        note: 'The billing toggle is hidden or locked, so the chat cannot be routed and there is no per-chat action to take the accent. Both actions are secondary: a global action never takes the accent.',
        intent: 'positive',
        heading: '16 AI Credits added.',
        message:
          'Your quota resets around 6:00 PM. Do you want to use your credits to keep going?',
        actions: [{ label: 'No, resume at 6:00 PM' }, { label: 'Always' }],
        actionsPlacement: 'below',
        dismissible: true,
      },
      {
        id: 'claude-turn-limit',
        title: 'Claude chat: turn limit reached',
        intent: 'destructive',
        heading: 'Claude turn limit reached',
        message: 'Resume to continue where Claude left off.',
        actions: [
          { label: 'Resume', variant: 'primary' },
          { label: 'Claude settings' },
        ],
      },
      {
        id: 'usage-limit-scheduled',
        title: 'Usage limit reached: resume scheduled',
        note: 'After "No, resume at …" the message states the outcome and the used button is gone.',
        intent: 'attention',
        heading: 'Codex usage limit reached',
        message:
          'This chat resumes automatically at Tue 9:00 AM. Do you want to use AI Credits to keep going now?',
        actions: [
          { label: 'Always' },
          { label: 'Just this chat', variant: 'primary' },
        ],
        actionsPlacement: 'below',
        dismissible: true,
      },
      {
        id: 'usage-limit-schedule-failed',
        title: 'Usage limit reached: scheduling failed',
        note: 'Post-action feedback is the only thing that ever appears under the line.',
        intent: 'attention',
        heading: 'Codex usage limit reached',
        message:
          'Your quota resets around 6:00 PM. Do you want to use AI Credits to keep going?',
        detail: "Couldn't schedule the resume. Try again.",
        actions: [
          { label: 'No, resume at 6:00 PM' },
          { label: 'Always' },
          { label: 'Just this chat', variant: 'primary' },
        ],
        actionsPlacement: 'below',
        dismissible: true,
      },
      {
        id: 'usage-limit-pricing',
        title: 'Usage limit reached: no credits to spend',
        note: 'Names the credits its button gets, never a plan upgrade.',
        intent: 'attention',
        heading: 'Claude usage limit reached',
        message:
          'Buy AI Credits to keep going now, or wait for your quota to reset around 6:00 PM.',
        actions: [
          { label: 'Resume at reset' },
          { label: 'Buy AI Credits', variant: 'primary' },
        ],
        dismissible: true,
      },
      {
        id: 'usage-limit-pricing-handoff',
        title: 'Usage limit reached: finishing checkout',
        note: 'After Buy AI Credits opens the browser, the checkout step replaces the limit, as on every purchase path. Waiting is not a warning.',
        intent: 'neutral',
        icon: <TimeslotIcon size={16} aria-hidden="true" />,
        heading: 'Finish checkout in your browser',
        message: 'Your credits show up here once the payment goes through.',
        actions: [
          { label: 'Resume at reset' },
          { label: 'Reopen billing' },
          { label: 'Check again', variant: 'primary' },
        ],
        actionsPlacement: 'below',
        dismissible: true,
      },
      {
        id: 'usage-limit-contact-admin',
        title: 'Usage limit reached: org has no headroom',
        intent: 'attention',
        heading: 'Claude usage limit reached',
        message: CONTACT_ORG_ADMIN_COPY,
        actions: [{ label: 'Resume at reset' }],
        dismissible: true,
      },
      {
        id: 'no-billing-source',
        title: 'No billing source: not connected',
        note: 'The title names the missing half; the buttons carry both remedies, Connect first.',
        intent: 'attention',
        heading: 'Not connected to Claude',
        message: `You have no ${brand} AI Credits to cover this chat either.`,
        actions: [
          { label: 'Connect Claude', variant: 'primary' },
          { label: 'Buy AI Credits' },
        ],
      },
      {
        id: 'no-billing-source-runtime',
        title: 'No billing source: a send already failed',
        intent: 'attention',
        heading: 'Message not sent',
        message: `Your ${brand} AI Credits didn't cover that message.`,
        actions: [{ label: 'Buy AI Credits', variant: 'primary' }],
      },
      {
        id: 'no-billing-source-policy',
        title: 'No billing source: org policy dead end',
        note: 'No button can help, so the message carries the next step.',
        intent: 'attention',
        heading: 'No model available',
        message:
          "Your organization's model policy doesn't allow any model you can run right now, so ask your organization admin to allow a model you can use.",
      },
      {
        id: 'no-billing-source-handoff',
        title: 'No billing source: finishing checkout',
        note: 'After Buy AI Credits opens the browser, the title and message name the step. Waiting is not a warning, and every action is a button on its own row.',
        intent: 'neutral',
        icon: <TimeslotIcon size={16} aria-hidden="true" />,
        heading: 'Finish checkout in your browser',
        message: 'Your credits show up here once the payment goes through.',
        actions: [
          { label: 'Connect Claude instead' },
          { label: 'Reopen billing' },
          { label: 'Check again', variant: 'primary' },
        ],
        actionsPlacement: 'below',
      },
      {
        id: 'no-billing-source-handoff-uncovered',
        title: 'No billing source: Check again found nothing yet',
        note: 'The verdict becomes the title instead of a footnote.',
        intent: 'neutral',
        icon: <TimeslotIcon size={16} aria-hidden="true" />,
        heading: 'No credits yet',
        message: "If you've paid, they can take a minute to arrive.",
        actions: [
          { label: 'Connect Claude instead' },
          { label: 'Reopen billing' },
          { label: 'Check again', variant: 'primary' },
        ],
        actionsPlacement: 'below',
      },
      {
        id: 'no-billing-source-handoff-failed',
        title: 'No billing source: Check again failed',
        note: 'Says nothing about the balance; Check again is the retry.',
        intent: 'attention',
        heading: "Couldn't check your balance",
        message: 'Try again in a moment.',
        actions: [
          { label: 'Connect Claude instead' },
          { label: 'Check again', variant: 'primary' },
        ],
        actionsPlacement: 'below',
      },
      {
        id: 'no-billing-source-arrival-card',
        title: 'No billing source: credits bought',
        note: 'The Using AI Credits card confirms the purchase, with no second notice and no switch back to a subscription that could not pay. Clears on the next send.',
        intent: 'positive',
        heading: '16 AI Credits added.',
        message: 'Ready to use in this chat.',
      },
      {
        id: 'no-billing-source-arrival-notice',
        title: 'No billing source: credits bought, no card',
        note: 'Only for a chat that has no Using AI Credits card, such as a credits-only model without a provider sign-in.',
        intent: 'positive',
        heading: '16 AI Credits added.',
        message: 'You can send it now.',
        dismissible: true,
      },
      {
        id: 'org-lapsed',
        title: 'Organization plan lapsed',
        intent: 'attention',
        heading: 'Acme has no active plan',
        message: `Its paused credit pool is not paying for this chat; ${lower(CONTACT_ORG_ADMIN_LAPSED_COPY)}`,
        dismissible: true,
      },
      {
        id: 'home-org-without-plan-owner',
        title: 'Home: selected organization has no plan (owner)',
        note: 'Home composer is disabled while an organization without an active plan is selected.',
        intent: 'attention',
        heading: orgWithoutPlanTitle('Acme'),
        message: CHOOSE_ORG_PLAN_COPY,
        actions: [{ label: CHOOSE_ORG_PLAN_LABEL, variant: 'primary' }],
      },
      {
        id: 'home-org-without-plan-member',
        title: 'Home: selected organization has no plan (admin or member)',
        note: 'Only an owner can choose a plan, so everyone else is sent to one.',
        intent: 'attention',
        heading: orgWithoutPlanTitle('Acme'),
        message: askOwnerToChoosePlanCopy('Acme'),
        actions: [{ label: 'Back to Personal' }],
      },
      {
        id: 'home-first-send-model-refused',
        title: 'Home: selected model refused before sending',
        note: 'CAN-5021. Home keeps the whole draft; the action opens the Home model picker and takes focus.',
        intent: 'destructive',
        heading: FIRST_SEND_FAILED_TITLE,
        message: homeModelFailureMessage('not-routable', 'Sonnet 4.5'),
        actions: [
          { label: FIRST_SEND_FAILED_CHOOSE_MODEL_LABEL, variant: 'primary' },
        ],
      },
      {
        id: 'chat-first-send-model-refused',
        title: 'Chat: first send kept after its model was refused',
        note: 'CAN-5021. The prompt stays above; nothing sends until Try again.',
        intent: 'destructive',
        heading: FIRST_SEND_FAILED_TITLE,
        message: homeModelFailureMessage('model-rejected', 'Sonnet 4.5'),
        actions: [
          { label: FIRST_SEND_FAILED_RETRY_LABEL },
          { label: FIRST_SEND_FAILED_CHOOSE_MODEL_LABEL, variant: 'primary' },
        ],
      },
      {
        id: 'transient-retry-counting',
        title: 'Transient provider error: retrying',
        note: 'Live countdown from the shared RetryCountdown.',
        intent: 'attention',
        heading: 'Temporary provider error',
        message: (
          <RetryCountdown
            attempt={2}
            maxAttempts={5}
            nextRetryAt={Date.now() + 90_000}
            exhausted={false}
          />
        ),
        dismissible: true,
      },
      {
        id: 'transient-retry-exhausted',
        title: 'Transient provider error: gave up',
        intent: 'attention',
        heading: 'Temporary provider error',
        message: (
          <RetryCountdown
            attempt={5}
            maxAttempts={5}
            nextRetryAt={null}
            exhausted
          />
        ),
        dismissible: true,
      },
      {
        id: 'gateway-key-missing',
        title: 'AI gateway: key missing',
        intent: 'attention',
        heading: 'Gateway key needed',
        message:
          'Acme routes your agents through its own AI gateway, so add your gateway key to send this.',
        actions: [{ label: 'Add your gateway key', variant: 'primary' }],
      },
      {
        id: 'gateway-key-stale',
        title: 'AI gateway: endpoint moved',
        intent: 'attention',
        heading: 'Gateway endpoint changed',
        message:
          'Acme moved its AI gateway, so add a key for the new one to send this.',
        actions: [{ label: 'Add your gateway key', variant: 'primary' }],
      },
      {
        id: 'gateway-key-rejected',
        title: 'AI gateway: key rejected',
        intent: 'attention',
        heading: 'Gateway key rejected',
        message:
          "Acme didn't accept your gateway key, so paste a current one or ask your admin for a new key.",
        actions: [{ label: 'Add your gateway key', variant: 'primary' }],
      },
      {
        id: 'approvals-upgrade',
        title: 'Approvals upgrade notice',
        intent: 'neutral',
        heading: 'Approval defaults updated',
        message:
          'Existing profiles were set to Full access, so review them in Settings.',
        actions: [{ label: 'Open settings' }],
        dismissible: true,
      },
      {
        id: 'plan-detected',
        title: 'Plan document detected',
        intent: 'neutral',
        icon: <DocumentIcon size={16} aria-hidden="true" />,
        heading: 'Track rollout-plan.md as a plan?',
        message:
          'Review and comment on it in Plans, then implement it from there.',
        actions: [{ label: 'Track plan', variant: 'primary' }],
        dismissible: true,
      },
      {
        id: 'skill-share-nudge-skill',
        title: 'Share suggestion: skill',
        note: 'Shown once per skill, after repeated use of one that is not shared anywhere.',
        intent: 'neutral',
        icon: <SkillIcon size={16} aria-hidden="true" />,
        heading: SKILL_SHARE_NUDGE_COPY.title('release-notes'),
        message: SKILL_SHARE_NUDGE_COPY.skillMessage,
        actions: [{ label: SKILL_SHARE_NUDGE_COPY.action, variant: 'primary' }],
        dismissible: true,
      },
      {
        id: 'skill-share-nudge-plugin',
        title: 'Share suggestion: plugin',
        note: 'Uses of any skill in the plugin count toward the same suggestion.',
        intent: 'neutral',
        icon: <PluginsIcon size={16} aria-hidden="true" />,
        heading: SKILL_SHARE_NUDGE_COPY.title('Release tools'),
        message: SKILL_SHARE_NUDGE_COPY.pluginMessage,
        actions: [{ label: SKILL_SHARE_NUDGE_COPY.action, variant: 'primary' }],
        dismissible: true,
      },
      {
        id: 'skill-suggestion-prompt',
        title: 'Skill suggestion: repeated request',
        note: 'Shown on the next repeat after a scan confirms the user keeps asking for the same kind of task.',
        intent: 'neutral',
        icon: <SkillIcon size={16} aria-hidden="true" />,
        heading: SKILL_SUGGESTION_COPY.title(4),
        message: SKILL_SUGGESTION_COPY.promptMessage,
        actions: [
          { label: SKILL_SUGGESTION_COPY.dismissForever, variant: 'secondary' },
          { label: SKILL_SUGGESTION_COPY.create, variant: 'primary' },
        ],
        dismissible: true,
      },
      {
        id: 'skill-suggestion-chain',
        title: 'Skill suggestion: skill chain',
        note: 'The same skills run in the same order across several chats.',
        intent: 'neutral',
        icon: <SkillIcon size={16} aria-hidden="true" />,
        heading: SKILL_SUGGESTION_COPY.title(3),
        message: SKILL_SUGGESTION_COPY.chainMessage(3),
        actions: [
          { label: SKILL_SUGGESTION_COPY.dismissForever, variant: 'secondary' },
          { label: SKILL_SUGGESTION_COPY.create, variant: 'primary' },
        ],
        dismissible: true,
      },
      {
        id: 'routing-status-personal',
        title: 'AI Credits routing: personal balance',
        note: 'One line at the composer width: the balance rides in the sentence, and the trailing slot keeps the reset time beside the secondary switch.',
        intent: 'neutral',
        icon: <CoinsIcon size={16} aria-hidden="true" />,
        heading: 'Using AI Credits',
        message: '1,240 credits left.',
        aside: (
          <span className="mr-1 shrink-0 whitespace-nowrap tabular-nums fg-tertiary">
            Claude resets 5:30 PM
          </span>
        ),
        actions: [{ label: 'Switch to subscription' }],
      },
      {
        id: 'routing-status-org',
        title: 'AI Credits routing: org pool',
        intent: 'neutral',
        icon: <CoinsIcon size={16} aria-hidden="true" />,
        heading: 'Using AI Credits',
        message: "Acme's shared credit pool is covering this session.",
        aside: (
          <span className="min-w-0 max-w-64 truncate pr-3 font-medium">
            Covered by Acme
          </span>
        ),
      },
      {
        id: 'resource-guard-memory',
        title: 'Resource guard: memory pressure',
        intent: 'attention',
        heading: 'Sending paused',
        message:
          'Memory pressure is high, so sends resume when active work finishes.',
        actions: [{ label: 'Open performance settings' }],
      },
      {
        id: 'resource-guard-concurrency',
        title: 'Resource guard: concurrency cap',
        intent: 'attention',
        heading: 'Sending paused',
        message: `${brand} is at its limit of 4 concurrent chat turns, so wait for one to finish before sending another.`,
        actions: [{ label: 'Open performance settings' }],
      },
      {
        id: 'stuck-agent',
        title: 'Stuck agent',
        intent: 'attention',
        heading: 'No response for 6 minutes',
        message: 'The agent might be stuck.',
        actions: [{ label: 'Check status' }],
      },
      {
        id: 'stuck-agent-checked',
        title: 'Stuck agent: checked state',
        intent: 'attention',
        heading: 'No response for 6 minutes',
        message: 'The agent is still working.',
      },
      {
        id: 'catching-up',
        title: 'Catching up',
        note: 'Main is behind the agent. Replaces the stuck warning and offers no action; the minutes follow the lag.',
        intent: 'neutral',
        heading: 'Catching up',
        message: 'Updates are about 2 minutes behind the agent.',
      },
    ],
  },
  {
    id: 'transcript',
    title: 'Transcript',
    note: 'Notices that belong to a turn rather than to the composer: a title carries the state and the message explains it.',
    entries: [
      {
        id: 'proxy-error-no-response',
        title: "Proxy error: provider didn't respond",
        intent: 'attention',
        heading: "The AI provider didn't respond",
        message: (
          <>
            {brand} tried a few times and couldn&apos;t reach the AI provider.
            This usually clears up quickly, so send your message again in a
            moment.{' '}
            <span className="whitespace-nowrap">
              Error id{' '}
              <span className="font-mono select-all">req_8f3a2c9e1b</span>
            </span>
          </>
        ),
        actions: [
          { label: 'Copy id' },
          { label: 'Try again', variant: 'primary' },
        ],
      },
      {
        id: 'chat-state-refreshing',
        title: 'Chat state: refreshing',
        note: 'No glyph, no live region: a quiet status line.',
        intent: 'neutral',
        icon: null,
        message: CHAT_STATE_REFRESHING_TOAST,
        live: false,
      },
      {
        id: 'chat-state-refresh-error',
        title: 'Chat state: refresh failed',
        intent: 'destructive',
        heading: CHAT_STATE_REFRESH_ERROR_HEADING,
        message: CHAT_STATE_REFRESH_ERROR_HELPER,
        actions: [
          { label: CHAT_STATE_REFRESH_RETRY_LABEL, variant: 'primary' },
        ],
      },
      {
        id: 'chat-state-conflict',
        title: 'Chat state: changed elsewhere',
        intent: 'attention',
        heading: CHAT_STATE_CONFLICT_TITLE,
        message: CHAT_STATE_CONFLICT_NOTICE,
        dismissible: true,
      },
      {
        id: 'chat-state-command-failed',
        title: 'Chat state: change not saved',
        intent: 'attention',
        heading: CHAT_STATE_COMMAND_FAILED_TITLE,
        message: CHAT_STATE_COMMAND_FAILED_NOTICE,
        dismissible: true,
      },
      {
        id: 'transcript-sync-failed',
        title: 'Claude Code transcript sync failed',
        intent: 'attention',
        heading: 'Claude Code transcript sync failed at 10:11 AM',
        message:
          'The terminal session kept running, but this transcript may be missing its latest turns.',
        live: false,
      },
      {
        id: 'transcript-reverted',
        title: 'Reverted prior turn',
        intent: 'attention',
        icon: <RevertIcon size={16} aria-hidden="true" />,
        heading: 'Reverted prior turn at 10:14 AM',
        message: 'The files changed in that turn were restored.',
        live: false,
      },
    ],
  },
  {
    id: 'pipelines',
    title: 'Workflows',
    note: 'Run detail and the editor.',
    entries: [
      {
        id: 'pipeline-paused',
        title: 'Run paused on a usage limit',
        intent: 'attention',
        heading: 'Run paused',
        message:
          'Claude usage limit reached. Steps on Claude wait until the quota resets. 2 paused steps need attention.',
        actions: [
          { label: 'Schedule resume' },
          { label: 'Resume run', variant: 'primary' },
        ],
      },
      {
        id: 'terminal-mode',
        title: 'Step running in terminal mode',
        note: 'Operational status ink on the glyph, not an intent.',
        intent: 'neutral',
        icon: (
          <AgentAssistantIcon
            size={16}
            aria-hidden="true"
            className="fg-info"
          />
        ),
        heading: 'Running in terminal mode',
        message: 'This step runs as a managed Claude Code worker.',
        actions: [{ label: 'View worker' }],
      },
      {
        id: 'terminal-mode-queued',
        title: 'Step queued for a worker',
        intent: 'neutral',
        icon: (
          <AgentAssistantIcon
            size={16}
            aria-hidden="true"
            className="fg-info"
          />
        ),
        heading: 'Queued',
        message: 'Waiting for an available Claude Code worker slot.',
      },
      {
        id: 'editor-read-only',
        title: 'Read-only workflow',
        intent: 'attention',
        heading: 'Read-only workflow',
        message: 'Duplicate this shared workflow to make local changes.',
        live: false,
      },
      {
        id: 'editor-validation',
        title: 'Validation errors',
        intent: 'destructive',
        heading: '2 validation issues',
        message: (
          <NoticeList>
            <NoticeListItem>
              jobs.build.steps[1]: `run` or `uses` is required.
            </NoticeListItem>
            <NoticeListItem>
              on.dispatch.inputs.branch: unknown input type `text`.
            </NoticeListItem>
          </NoticeList>
        ),
      },
    ],
  },
  {
    id: 'settings',
    title: 'Settings and pages',
    note: 'The same primitive on settings tabs, panels, and dialogs.',
    entries: [
      {
        id: 'file-readonly-hint-edit',
        title: 'Read-only preview: typing in a Cowork Markdown file',
        note: 'File viewer. Raised by a typing attempt in an editable rendered view; Cowork names the raw view Edit. Escape or dismiss returns focus to the preview.',
        intent: 'neutral',
        heading: 'Formatted view is read-only.',
        message: 'Switch to Edit to change the text.',
        actions: [{ label: 'Switch to Edit', variant: 'primary' }],
        dismissible: true,
      },
      {
        id: 'file-readonly-hint-source',
        title: 'Read-only preview: typing in a Code project table',
        note: 'File viewer. Code projects keep the Source label.',
        intent: 'neutral',
        heading: 'Table view is read-only.',
        message: 'Switch to Source to change the text.',
        actions: [{ label: 'Switch to Source', variant: 'primary' }],
        dismissible: true,
      },
      {
        id: 'file-readonly-hint-html',
        title: 'Read-only preview: editable HTML',
        note: 'File viewer. The HTML frame keeps its own keys, so the hint stays in place while the rendered view is shown. Not dismissible.',
        intent: 'neutral',
        heading: 'Formatted view is read-only.',
        message: 'Switch to Edit to change the text.',
        actions: [{ label: 'Switch to Edit', variant: 'primary' }],
        live: false,
      },
      {
        id: 'data-sharing-opt-in-offer',
        title: 'Data-sharing opt-in: offer',
        note: 'Organization memory settings. Quiet and static; dismissal hides it on this device.',
        intent: 'neutral',
        icon: null,
        message: (
          <>
            <p className="font-medium fg-primary">
              {dataSharingOptInHeadline('organization-memory')}
            </p>
            <DataSharingOptInScopeSummary
              organizationName="Acme"
              productName={brand}
              allowedScopes={['metadata', 'transcripts']}
              additionalScopes={['summaries']}
            />
          </>
        ),
        actions: [
          { label: dataSharingOptInActionLabel('Acme'), variant: 'primary' },
        ],
        actionsPlacement: 'below',
        dismissible: true,
        live: false,
      },
      {
        id: 'data-sharing-opt-in-partial',
        title: 'Data-sharing opt-in: partly restricted by policy',
        intent: 'neutral',
        icon: null,
        message: (
          <>
            <p className="font-medium fg-primary">
              {dataSharingOptInHeadline('leaderboards')}
            </p>
            <DataSharingOptInScopeSummary
              organizationName="Acme"
              productName={brand}
              allowedScopes={['metadata']}
              skippedScopes={['plans']}
            />
          </>
        ),
        detail: dataSharingOptInErrorText('application-failed'),
        actions: [{ label: 'Try again', variant: 'primary' }],
        actionsPlacement: 'below',
      },
      {
        id: 'data-sharing-opt-in-personal',
        title: 'Data-sharing opt-in: personal project',
        note: 'Invite modal for personal work with work stats Off. Only the viewer sees what it saves.',
        intent: 'neutral',
        icon: null,
        message: (
          <>
            <p className="font-medium fg-primary">
              {dataSharingOptInHeadline('shared-projects')}
            </p>
            <ul className="flex flex-col gap-0.5 break-words fg-tertiary">
              <li>
                {DATA_SHARING_OPT_IN_PERSONAL_COPY.saves(['metadata'], brand)}
              </li>
              <li>{DATA_SHARING_OPT_IN_PERSONAL_COPY.audience}</li>
            </ul>
          </>
        ),
        actions: [
          {
            label: DATA_SHARING_OPT_IN_PERSONAL_COPY.actionLabel,
            variant: 'primary',
          },
        ],
        actionsPlacement: 'below',
        live: false,
      },
      {
        id: 'data-sharing-opt-in-saved',
        title: 'Data-sharing opt-in: saved',
        intent: 'neutral',
        icon: null,
        heading: DATA_SHARING_OPT_IN_STATE_COPY.savedTitle,
        message: DATA_SHARING_OPT_IN_STATE_COPY.savedDetail,
      },
      {
        id: 'data-sharing-opt-in-managed',
        title: 'Data-sharing opt-in: managed by the organization',
        intent: 'neutral',
        icon: null,
        message: DATA_SHARING_OPT_IN_STATE_COPY.managed('Acme'),
        live: false,
      },
      {
        id: 'data-dir-fallback',
        title: `${brand}: data folder fallback`,
        intent: 'attention',
        heading: 'Using an existing data folder from a previous install.',
        message: `${brand} is storing its data in ~/.${brand.toLowerCase()}-legacy.`,
        detail:
          'Switching to the primary folder moves nothing; restart after switching.',
        actions: [{ label: 'Use primary folder', variant: 'primary' }],
      },
      {
        id: 'ollama-unsupported',
        title: 'Ollama: unsupported server',
        intent: 'attention',
        heading: 'Ollama server not supported',
        message: 'Update Ollama 0.3.2 to 0.6.0 or newer to use local models.',
        actions: [
          { label: 'Detect again' },
          { label: 'Download Ollama', variant: 'primary' },
        ],
      },
      {
        id: 'ollama-install-failed',
        title: 'Ollama: install failed',
        intent: 'destructive',
        heading: 'Install failed',
        message: 'The Ollama install failed.',
        actions: [
          { label: 'Browse…' },
          { label: 'Detect again' },
          { label: 'Install Ollama', variant: 'primary' },
        ],
        actionsPlacement: 'below',
      },
      {
        id: 'mcp-oauth-note',
        title: 'MCP server: OAuth note',
        intent: 'attention',
        heading: 'OAuth covers proxied sessions',
        message: 'The static token is kept only for non-OAuth use.',
        live: false,
      },
      {
        id: 'usage-fetch-error',
        title: 'Usage: fetch failed',
        intent: 'attention',
        heading: 'Usage not loaded',
        message: 'Try again to load Claude usage.',
        note: 'The raw error opens under the message from a secondary action, never a text link.',
        actions: [
          { label: 'Show details' },
          { label: 'Try again', variant: 'primary' },
        ],
      },
      {
        id: 'cloud-account-recovery',
        title: 'Account: saved sign-in unreadable',
        note: 'The reset is destructive, so it stays secondary; the confirmation dialog carries the weight.',
        intent: 'attention',
        heading: 'Saved sign-in can’t be read',
        message: `Another desktop build may have used the same ${brand} Cloud secure storage; reset it to sign in again.`,
        actions: [{ label: 'Reset saved sign-in' }],
      },
      {
        id: 'split-preflight-blockers',
        title: 'Split PR: not ready',
        intent: 'destructive',
        heading: 'Not ready to start',
        message: `${SPLIT_PR_BLOCKER_COPY.uncommitted_changes}. ${SPLIT_PR_BLOCKER_COPY.active_chats}.`,
        live: false,
      },
      {
        id: 'import-privacy',
        title: 'Import session: privacy note',
        intent: 'attention',
        heading: 'Exports are not redacted',
        message:
          'They hold the full transcript and uncommitted repository changes, are private to your account, and leave out unpushed commits.',
        live: false,
      },
      {
        id: 'pr-merge-conflict',
        title: 'Pull request: merge conflict',
        intent: 'attention',
        heading: 'Merge conflict',
        message: 'Resolve it on the branch before this pull request can merge.',
      },
      {
        id: 'archived-truncation',
        title: 'Archive: changed-files list truncated',
        intent: 'attention',
        heading: 'List truncated',
        message: 'Showing the first 50,000 of 61,204 changed files.',
        live: false,
      },
      {
        id: 'bg-process-output-unreadable',
        title: 'Background process: output file unreadable',
        note: 'The detail modal fell back to the output captured while the task ran.',
        intent: 'attention',
        heading: 'Showing captured output only',
        message: "The output file couldn't be read.",
      },
      {
        id: 'bg-process-output-truncated',
        title: 'Background process: output truncated',
        note: 'No title: the whole notice is the one thing it has to say.',
        intent: 'attention',
        message: 'Showing the latest output only.',
      },
      {
        id: 'error-banner',
        title: 'ErrorBanner (shared)',
        note: 'The shared destructive notice used by list pages and the web app.',
        intent: 'destructive',
        heading: "Couldn't load skills.",
        message: 'Try again.',
      },
      {
        id: 'automation-installed-off',
        title: 'Automations: installed from a share link, off',
        note: 'Shown on Workflows → Library after a share-link install. A fresh install is always off.',
        intent: 'positive',
        heading: automationRevealNoticeCopy('installed', {
          kind: 'shown',
          enabled: false,
          runsInLabel: null,
        }).title,
        message: automationRevealNoticeCopy('installed', {
          kind: 'shown',
          enabled: false,
          runsInLabel: null,
        }).message,
        dismissible: true,
      },
      {
        id: 'automation-installed-on',
        title: 'Automations: installed, turned on since',
        note: 'The message follows the live enabled state.',
        intent: 'positive',
        heading: automationRevealNoticeCopy('installed', {
          kind: 'shown',
          enabled: true,
          runsInLabel: null,
        }).title,
        message: automationRevealNoticeCopy('installed', {
          kind: 'shown',
          enabled: true,
          runsInLabel: null,
        }).message,
        dismissible: true,
      },
      {
        id: 'automation-updated-on',
        title: 'Automations: updated, still on',
        note: 'A shared update kept the schedule, so the copy stayed on.',
        intent: 'positive',
        heading: automationRevealNoticeCopy('updated', {
          kind: 'shown',
          enabled: true,
          runsInLabel: null,
        }).title,
        message: automationRevealNoticeCopy('updated', {
          kind: 'shown',
          enabled: true,
          runsInLabel: null,
        }).message,
        dismissible: true,
      },
      {
        id: 'automation-updated-off',
        title: 'Automations: updated, off',
        note: 'A shared update changed the schedule, or the copy was already off.',
        intent: 'positive',
        heading: automationRevealNoticeCopy('updated', {
          kind: 'shown',
          enabled: false,
          runsInLabel: null,
        }).title,
        message: automationRevealNoticeCopy('updated', {
          kind: 'shown',
          enabled: false,
          runsInLabel: null,
        }).message,
        dismissible: true,
      },
      {
        id: 'automation-installed-other-context',
        title: 'Automations: installed outside the selected context',
        note: 'An organization is selected, so the row stays hidden and the notice names where it runs.',
        intent: 'positive',
        heading: automationRevealNoticeCopy('installed', {
          kind: 'shown',
          enabled: true,
          runsInLabel: automationRunsInMessage('Personal'),
        }).title,
        message: automationRevealNoticeCopy('installed', {
          kind: 'shown',
          enabled: true,
          runsInLabel: automationRunsInMessage('Personal'),
        }).message,
        dismissible: true,
      },
      {
        id: 'automation-installed-unavailable',
        title: 'Automations: installed, row not found',
        note: 'The install succeeded, but a refresh still did not return the row.',
        intent: 'positive',
        heading: automationRevealNoticeCopy('installed', {
          kind: 'unavailable',
        }).title,
        message: automationRevealNoticeCopy('installed', {
          kind: 'unavailable',
        }).message,
        dismissible: true,
      },
      {
        id: 'share-install-skill',
        title: 'Install review: skill installed',
        note: 'Toast after the install review closes and the skill opens under Installed › Skills (CAN-3710). Plugin, workflow and agent read the same way.',
        intent: 'positive',
        message: installRevealNotice('skill', 'installed'),
      },
      {
        id: 'share-install-pipeline-updated',
        title: 'Install review: workflow updated',
        note: 'An update lands on the same Library row, marked.',
        intent: 'positive',
        message: installRevealNotice('pipeline', 'updated'),
      },
      {
        id: 'share-install-project',
        title: 'Install review: project added',
        note: 'A project template opens the new project.',
        intent: 'positive',
        message: installRevealNotice('workspace', 'installed'),
      },
      {
        id: 'share-install-collection-partial',
        title: 'Install review: collection with unavailable items',
        note: "The install's own status replaces the default, so a partial install is never reported as complete.",
        intent: 'positive',
        message: installRevealNotice(
          'collection',
          'installed',
          'Collection installed with 2 items unavailable.',
        ),
      },
    ],
  },
];

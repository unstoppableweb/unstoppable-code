import type { JSX, ReactNode } from 'react';
import type { OnboardingTipId } from '@canopy/protocol/onboarding-tips';
import type { OnboardingTipPlacement } from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  McpServerIcon,
  ScheduleIcon,
  SteerIcon,
  WorkflowsIcon,
  WorktreeIcon,
} from '@canopy/ui-shared/icons/AppIcons';

/** Names a tip may mention; each is optional, with a neutral fallback. */
export interface OnboardingTipContext {
  /** The project a worktree chat works on (`canopy`). */
  readonly projectName?: string;
  /** The worktree's name (`tuatara`). */
  readonly worktreeName?: string;
}

export interface OnboardingTipCopy {
  readonly placement: OnboardingTipPlacement;
  readonly icon: JSX.Element;
  readonly title: (context: OnboardingTipContext) => ReactNode;
  readonly body: (context: OnboardingTipContext) => ReactNode;
  /** The verb that does what the tip describes; acting dismisses the tip. */
  readonly actionLabel?: string;
}

/**
 * Every tip's copy and placement (CAN-4904). Priority order lives with the
 * ids in `@canopy/protocol/onboarding-tips`. The glyph is the feature's own
 * icon; no "Tip:" prefix.
 */
export const ONBOARDING_TIP_COPY: Readonly<
  Record<OnboardingTipId, OnboardingTipCopy>
> = {
  workflows: {
    placement: 'inline',
    icon: <WorkflowsIcon size={20} />,
    title: () => 'Repeat work with workflows',
    body: () =>
      'A workflow chains prompts and scripts, and runs them by hand, on a timer, or when something happens.',
  },
  'worktree-chat': {
    placement: 'composer',
    icon: <WorktreeIcon size={20} />,
    // Project and worktree names are user-authored, so session replay masks
    // them; the rest of the sentence stays readable.
    title: ({ projectName }) =>
      projectName ? (
        <>
          This chat has its own copy of{' '}
          <span className={REPLAY_MASK_CLASS}>{projectName}</span>
        </>
      ) : (
        'This chat has its own copy of the project'
      ),
    body: ({ worktreeName }) =>
      worktreeName ? (
        <>
          Changes stay in{' '}
          <span className={REPLAY_MASK_CLASS}>{worktreeName}</span> until you
          commit or open a pull request.
        </>
      ) : (
        'Changes stay in this worktree until you commit or open a pull request.'
      ),
  },
  'workflows-schedule': {
    placement: 'inline',
    icon: <ScheduleIcon size={20} />,
    title: () => 'Schedules live on workflows',
    body: () => 'Open a workflow and add a trigger to run it on a timer.',
    actionLabel: 'Open Library',
  },
  // Shown by `OrgProjectConnectorsNotice`, which names each connector; this
  // copy is the fallback for a slot that lists the id.
  'org-project-connectors': {
    placement: 'composer',
    icon: <McpServerIcon size={20} />,
    title: () => 'Your connectors stay out of organization projects',
    body: () => 'Add one to a project to use it there.',
  },
  // Shown only behind the Steer by default Labs experiment (CAN-7349); no
  // surface lists it yet.
  'steer-by-default': {
    placement: 'composer',
    icon: <SteerIcon size={20} />,
    title: () => 'Send during a reply',
    body: () => 'Your message guides the current reply instead of waiting.',
  },
};

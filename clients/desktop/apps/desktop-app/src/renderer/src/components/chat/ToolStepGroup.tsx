import { memo, type JSX, type ReactNode } from 'react';
import {
  ChatToolStepGroup,
  liveToolCallActivity,
  stepKindIcon,
  useToolApprovalWait,
  type ChatToolStepLive,
  type ToolApprovalWait,
} from '@canopy/ui-shared/components';
import { AgentIcon, QuestionMarkIcon } from '@canopy/ui-shared/icons';
import { isAskUserQuestionToolName } from '@/lib/canopy-tool-aliases';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { brand } from '@/lib/brand';
import type { TurnOutcomeEvidence } from '@canopy/protocol/portal';
import {
  cleanBlockRole,
  describeCleanSteps,
  stepsBeforeLiveWindow,
  type CleanStepSegment,
} from './tool-step-groups';

type CleanStepsSegment = Extract<CleanStepSegment, { kind: 'steps' }>;

/** Words that can carry paths, commands or task text stay out of replay. */
function replayBlocked(label: ReactNode): JSX.Element {
  return <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{label}</span>;
}

/**
 * What the running turn is doing now, from the last step of its live run. A
 * call the turn's approvals hold says it waits instead of shimmering.
 */
function liveActivity(
  segment: CleanStepsSegment | undefined,
  workingLabel: string | undefined,
  scope: { isCodeReview?: boolean; trustedMcpNamespace: string },
  approvalWait: ToolApprovalWait,
): ChatToolStepLive {
  const thinking = {
    label: workingLabel ?? 'Thinking',
    icon: null,
    showWhenUngrouped: true,
  };
  const messages = segment?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const blocks = messages[index].blocks;
    for (let at = blocks.length - 1; at >= 0; at -= 1) {
      const block = blocks[at];
      if (cleanBlockRole(block) !== 'step') continue;
      if (block.type === 'text' && block.asyncQuestion) {
        return { label: 'Waiting for your answer', icon: <QuestionMarkIcon /> };
      }
      if (block.type === 'tool_use' && block.result === undefined) {
        if (isAskUserQuestionToolName(block.toolName)) {
          return {
            label: 'Waiting for your answer',
            icon: <QuestionMarkIcon />,
          };
        }
        return liveToolCallActivity(block, approvalWait, scope);
      }
      if (
        (block.type === 'agent' || block.type === 'workflow') &&
        block.result === undefined
      ) {
        return {
          label:
            block.type === 'agent'
              ? block.description
                ? replayBlocked(block.description)
                : 'Running a helper agent'
              : block.workflowName,
          icon: <AgentIcon />,
        };
      }
      // The newest step is done (or is a thought): the agent is thinking
      // about the next one.
      return block.type === 'thinking'
        ? { ...thinking, showWhenUngrouped: false }
        : thinking;
    }
  }
  return thinking;
}

/**
 * Clean chat look: one closed line for every step between two replies.
 * Done, it counts what the run did ("Ran 4 commands, read 2 files · 1
 * failed"); as the running turn's tail (`live`) it shimmers what the turn is
 * doing now in the same place. Without a segment it is the running turn's
 * "Thinking" line, which the next run takes over in place.
 */
export const CleanToolStepGroup = memo(function CleanToolStepGroup({
  segment,
  live,
  workingLabel,
  forceExpanded = false,
  openRequest,
  isCodeReviewChat,
  liveSteps,
  hiddenSteps,
  trailingActivity,
  outcomeEvidence,
  deniedToolUseIds,
  children,
}: {
  segment?: CleanStepsSegment;
  /** The run is the running turn's tail. */
  live: boolean;
  /** Replaces "Thinking" while the turn waits on something else. */
  workingLabel?: string;
  forceExpanded?: boolean;
  /** Opens the line as saved state once per new object (a call reveal). */
  openRequest?: object;
  isCodeReviewChat?: boolean;
  /** "Show only recent steps": the newest steps, under the closed line. */
  liveSteps?: ReactNode;
  hiddenSteps?: ReactNode;
  trailingActivity?: ReactNode;
  /**
   * Whether the turn settled with every result loaded, so a call without a
   * result counts as interrupted; the turn's outcome counts use the same.
   */
  outcomeEvidence?: TurnOutcomeEvidence;
  /** Authoritative denials, including receipts outside this run. */
  deniedToolUseIds?: ReadonlySet<string>;
  /** The run's steps, rendered when the line is open. */
  children?: ReactNode;
}): JSX.Element {
  const scope = {
    isCodeReview: isCodeReviewChat,
    trustedMcpNamespace: brand.tools.namespace,
  };
  const approvalWait = useToolApprovalWait();
  // "Recent": the newest steps show under the line, so the line counts only
  // the steps before them and the running step is not said twice. With no
  // earlier step there is nothing to count, so the steps show on their own.
  const hidden =
    segment && liveSteps !== undefined
      ? stepsBeforeLiveWindow(segment.messages)
      : undefined;
  const done = segment
    ? describeCleanSteps(
        hidden === undefined ? segment : { ...segment, messages: hidden },
        scope,
        outcomeEvidence,
        deniedToolUseIds,
      )
    : undefined;
  return (
    <ChatToolStepGroup
      summary={done?.label ?? ''}
      failedCount={done?.failed ?? 0}
      blockedCount={done?.blocked ?? 0}
      interruptedCount={done?.interrupted ?? 0}
      icon={done?.firstKind ? stepKindIcon(done.firstKind) : undefined}
      forceExpanded={forceExpanded}
      openRequest={openRequest}
      liveSteps={liveSteps}
      hiddenSteps={hiddenSteps}
      trailingActivity={trailingActivity}
      collapsedStepCount={
        segment
          ? (hidden ?? segment.messages).reduce(
              (count, message) =>
                count +
                message.blocks.filter(
                  (block) =>
                    cleanBlockRole(block) === 'step' &&
                    block.type !== 'thinking',
                ).length,
              0,
            )
          : undefined
      }
      {...(live && hidden === undefined
        ? { live: liveActivity(segment, workingLabel, scope, approvalWait) }
        : {})}
    >
      {children}
    </ChatToolStepGroup>
  );
});

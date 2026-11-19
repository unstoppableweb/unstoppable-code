import { ControlButton } from '../Button';
import type { JSX } from 'react';
import type {
  TurnOutcomeCounts,
  TurnOutcomeStepDetail,
} from '@canopy/protocol/remote-control/shell';
import { StopIcon } from '../../icons';
import { ShieldIcon, WarningIcon } from '../../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { StepTenseProvider, useChatAppName } from '../chat-look';
import { getToolDisplayInfo } from './tool-display';
import { summarizeToolOutcome } from './tool-outcome-summary';
import {
  TURN_OUTCOME_ORDER,
  TURN_OUTCOME_UNKNOWN_IMPACT,
} from './turn-outcome-label';

/** How many steps the tooltip lists before "+N more". */
export const TURN_OUTCOME_TOOLTIP_LIMIT = 5;

/**
 * Blocked steps first, then errored ones, then interrupted ones, each in the
 * given (transcript) order: the order a click on the outcome lands in.
 */
export function orderTurnOutcomeSteps(
  steps: readonly TurnOutcomeStepDetail[],
): TurnOutcomeStepDetail[] {
  return TURN_OUTCOME_ORDER.flatMap((outcome) =>
    steps.filter((step) => step.outcome === outcome),
  );
}

/**
 * What an errored step did to the turn's result. Nothing a step records says
 * whether the agent recovered (a later retry, another approach), so the
 * tooltip says so plainly rather than implying the result is fine (CAN-5355).
 */
export { TURN_OUTCOME_UNKNOWN_IMPACT } from './turn-outcome-label';

/**
 * The count-only sentences for a turn whose rows are not loaded: "1 step was
 * blocked", "2 steps ran into errors" and its unknown effect on the result,
 * "1 step was interrupted".
 */
export function formatTurnOutcomeSentences(
  outcomes: TurnOutcomeCounts | undefined,
): string[] {
  const sentences: string[] = [];
  if (outcomes && outcomes.blocked > 0) {
    sentences.push(
      outcomes.blocked === 1
        ? '1 step was blocked'
        : `${outcomes.blocked} steps were blocked`,
    );
  }
  if (outcomes && outcomes.failed > 0) {
    sentences.push(
      outcomes.failed === 1
        ? '1 step ran into an error'
        : `${outcomes.failed} steps ran into errors`,
      TURN_OUTCOME_UNKNOWN_IMPACT,
    );
  }
  if (outcomes && outcomes.interrupted > 0) {
    sentences.push(
      outcomes.interrupted === 1
        ? '1 step was interrupted'
        : `${outcomes.interrupted} steps were interrupted`,
    );
  }
  return sentences;
}

export interface TurnOutcomeTooltipProps {
  outcomes?: TurnOutcomeCounts;
  /** The outcome steps from loaded rows; empty or omitted shows counts only. */
  steps?: readonly TurnOutcomeStepDetail[];
  /** Jump to one step. Without it, entries are plain rows. */
  onSelectStep?: (toolUseId: string) => void;
}

function TurnOutcomeTooltipEntry({
  step,
  onSelectStep,
}: {
  step: TurnOutcomeStepDetail;
  onSelectStep?: (toolUseId: string) => void;
}): JSX.Element {
  const { label } = getToolDisplayInfo(step.toolName, step.input);
  const brandAppName = useChatAppName();
  const interrupted = step.outcome === 'interrupted';
  const body = (
    <>
      <span
        className={`flex h-4 flex-shrink-0 items-center [&_svg]:size-3.5 ${
          interrupted ? 'fg-secondary' : 'fg-warning-strong'
        }`}
        aria-hidden="true"
      >
        {step.outcome === 'blocked' ? (
          <ShieldIcon />
        ) : interrupted ? (
          <StopIcon />
        ) : (
          <WarningIcon />
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span
          className={`truncate fg-primary ${REPLAY_BLOCK_CLASS}`}
          data-turn-outcome-step-label=""
        >
          {/* Keep the step label stable; the reason below names its outcome. */}
          <StepTenseProvider value={step.outcome}>{label}</StepTenseProvider>
        </span>
        <span
          className={`line-clamp-2 break-words fg-tertiary ${REPLAY_BLOCK_CLASS}`}
          data-turn-outcome-step-reason=""
        >
          {summarizeToolOutcome(step, brandAppName)}
        </span>
        {step.outcome === 'failed' && (
          <span className="fg-tertiary" data-turn-outcome-step-impact="">
            {TURN_OUTCOME_UNKNOWN_IMPACT}
          </span>
        )}
      </span>
    </>
  );
  const rowClass = 'flex w-full items-start gap-1.5 rounded-sm px-1 py-0.5';
  if (!onSelectStep) {
    return (
      <div className={rowClass} data-turn-outcome-step={step.toolUseId}>
        {body}
      </div>
    );
  }
  return (
    <ControlButton
      type="button"
      presentation="turn-outcome-step"
      data-turn-outcome-step={step.toolUseId}
      onClick={(): void => onSelectStep(step.toolUseId)}
    >
      {body}
    </ControlButton>
  );
}

/**
 * The outcome control's tooltip: each blocked, errored or interrupted step's
 * label and a one-line reason (an errored one adds its effect on the result), in that order, up to {@link TURN_OUTCOME_TOOLTIP_LIMIT}
 * then "+N more". A turn whose rows aren't loaded (a paged desktop turn)
 * has counts but no steps, so it says the counts in a sentence instead.
 *
 * Labels and reasons quote tool input and output, and this content portals
 * out of the transcript's replay-blocked wrapper, so they carry
 * `REPLAY_BLOCK_CLASS` themselves. Reasons are derived here, so nothing is
 * summarized until the tooltip is shown.
 */
export function TurnOutcomeTooltip({
  outcomes,
  steps,
  onSelectStep,
}: TurnOutcomeTooltipProps): JSX.Element {
  if (!steps || steps.length === 0) {
    return (
      <div className="flex flex-col gap-0.5" data-testid="turn-outcome-tooltip">
        {formatTurnOutcomeSentences(outcomes).map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
      </div>
    );
  }
  const ordered = orderTurnOutcomeSteps(steps);
  const shown = ordered.slice(0, TURN_OUTCOME_TOOLTIP_LIMIT);
  // Counts can cover steps the rows can't name (a Portal call without an
  // id, or a desktop count projected past the loaded rows).
  const counted =
    (outcomes?.blocked ?? 0) +
    (outcomes?.failed ?? 0) +
    (outcomes?.interrupted ?? 0);
  const more = Math.max(counted, ordered.length) - shown.length;
  return (
    <div className="flex flex-col gap-0.5" data-testid="turn-outcome-tooltip">
      <ul className="flex flex-col gap-0.5">
        {shown.map((step) => (
          <li key={step.toolUseId}>
            <TurnOutcomeTooltipEntry step={step} onSelectStep={onSelectStep} />
          </li>
        ))}
      </ul>
      {more > 0 && (
        <p className="px-1 fg-tertiary" data-turn-outcome-more={more}>
          +{more} more
        </p>
      )}
    </div>
  );
}

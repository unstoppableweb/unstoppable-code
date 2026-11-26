import type { JSX } from 'react';
import type { ChatComposerToolbarChipConfig } from './ChatComposerToolbar';
import { CloseMediumIcon, PipelineIcon } from '../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

/** The Workflow chip's label when sending will ask which workflow to run. */
export const WORKFLOW_CHIP_ANY_LABEL = 'Workflow';

export interface WorkflowChipOptions {
  /**
   * The workflow a send runs, or null when sending asks which one. The chip
   * names it.
   */
  workflowName: string | null;
  disabled: boolean;
  /** Turns workflow mode off; the chip is only shown while it is on. */
  onDisable: () => void;
  /** A narrow box draws the glyph alone, in a circle. */
  compact?: boolean;
  /**
   * The id of the host's {@link WorkflowChipDescription}, which names the
   * workflow to assistive technology.
   */
  descriptionId: string;
  dataTestId?: string;
}

/**
 * The Workflow chip beside +, shown while workflow mode is on. Like the Plan
 * chip it keeps the mode visible and removes it in one click; it names the
 * workflow a send will run, which is chosen from the + menu's Workflow row.
 * Render a {@link WorkflowChipDescription} beside it.
 */
export function buildWorkflowChip({
  workflowName,
  disabled,
  onDisable,
  compact = false,
  descriptionId,
  dataTestId = 'composer-workflow-chip',
}: WorkflowChipOptions): ChatComposerToolbarChipConfig {
  const label = workflowName ?? WORKFLOW_CHIP_ANY_LABEL;
  return {
    onClick: onDisable,
    disabled,
    active: true,
    ariaPressed: true,
    activeTone: 'warning',
    // A workflow's name is user-authored, so session replay must not record
    // it: it stays out of the button's attributes, and its visible text is
    // masked. Assistive technology reads it as the button's description. No
    // tooltip: it would only repeat the label and claim the description.
    ariaLabel: 'Turn off workflow',
    'aria-describedby': descriptionId,
    icon: <PipelineIcon size="sm" />,
    ...(compact
      ? {}
      : {
          label,
          labelClassName: `max-w-48 truncate ${REPLAY_MASK_CLASS}`,
          trailing: <CloseMediumIcon size="sm" aria-hidden />,
        }),
    variant: 'capsule',
    dataTestId,
  };
}

/**
 * The Workflow chip's description: the workflow's name, visually hidden and
 * replay-masked. Render it beside the chip, outside its button, so a click's
 * captured element text never picks the name up from it.
 */
export function WorkflowChipDescription({
  id,
  workflowName,
}: {
  readonly id: string;
  readonly workflowName: string | null;
}): JSX.Element {
  return (
    <span id={id} className={`sr-only ${REPLAY_MASK_CLASS}`}>
      {workflowName ?? WORKFLOW_CHIP_ANY_LABEL}
    </span>
  );
}

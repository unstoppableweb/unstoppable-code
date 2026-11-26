import type { JSX } from 'react';
import { Button } from '@canopy/ui-shared/components';
import { PipelineIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { ComposerMenuItem } from './ComposerMenu';

/**
 * The words of the composer's Attach a workflow dialog (CAN-7513), the same
 * on desktop and web: a task workflow is picked and inserted into the
 * composer, then runs when the task is sent.
 */
export const ATTACH_WORKFLOW_COPY = {
  title: 'Attach a workflow',
  subtitle: 'Choose a workflow to run when you send this task',
  insertLabel: 'Insert',
  createLabel: 'Create a workflow',
} as const;

export interface ComposerWorkflowMenuOptions {
  /** The attached workflow's name, or null when none is attached. */
  attachedName: string | null;
  /** Opens the host's Attach a workflow dialog. */
  onOpen: () => void;
  disabled?: boolean;
  dataTestId: string;
}

/**
 * The + menu's Workflow row (CAN-7513): it opens the Attach a workflow
 * dialog, as Slack's + › Workflow does. Every host builds the row here, so
 * the menu reads the same on desktop and web.
 */
export function buildWorkflowMenuItem({
  attachedName,
  onOpen,
  disabled = false,
  dataTestId,
}: ComposerWorkflowMenuOptions): ComposerMenuItem {
  return {
    id: 'pipeline',
    group: 'settings',
    label: 'Workflow',
    description:
      attachedName === null
        ? 'Attach a workflow to run with this task'
        : 'Change the attached workflow',
    value: attachedName ?? undefined,
    icon: <PipelineIcon size="sm" />,
    popupRole: 'dialog',
    ariaChecked: attachedName !== null,
    disabled,
    dataTestId,
    onSelect: onOpen,
  };
}

/**
 * The Attach a workflow dialog's Create a workflow button. It leads the
 * dialog's footer, before Cancel and Insert.
 */
export function CreateWorkflowButton({
  onCreate,
  disabled = false,
  dataTestId,
}: {
  readonly onCreate: () => void;
  readonly disabled?: boolean;
  readonly dataTestId: string;
}): JSX.Element {
  return (
    <Button
      variant="secondary"
      size="compact"
      className="mr-auto"
      disabled={disabled}
      onClick={onCreate}
      data-testid={dataTestId}
    >
      {ATTACH_WORKFLOW_COPY.createLabel}
    </Button>
  );
}

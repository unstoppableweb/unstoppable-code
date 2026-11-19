// Icon button + anchored popover for setting an optional follow-up instruction
// on a watcher (the text sent to the notified chat when the watcher fires).
// Shows the "assignment add" glyph in default colors when no instruction is set
// and the filled "assignment" glyph in the primary color once one is. Clicking
// opens the shared `Popover` with a textarea; the popover portals itself, so an
// ancestor's `overflow-hidden` (e.g. the pipeline-run modal) never clips it.

import { useRef, useState, type JSX } from 'react';
import { AssignmentAddIcon, AssignmentIcon } from '@canopy/ui-shared/icons';
import { Popover, Tooltip } from '@canopy/ui-shared';
import { Button, TextArea } from '@canopy/ui-shared/components';

export interface WatcherFollowUpButtonProps {
  value: string;
  onChange: (value: string) => void;
  /** Open the popover above (`top`) or below (`bottom`). Defaults to top. */
  placement?: 'top' | 'bottom';
  dataTestId?: string;
}

export function WatcherFollowUpButton({
  value,
  onChange,
  placement = 'top',
  dataTestId = 'watcher-followup',
}: WatcherFollowUpButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  const hasInstruction = value.trim().length > 0;

  const Icon = hasInstruction ? AssignmentIcon : AssignmentAddIcon;

  return (
    <div className="electron-no-drag relative inline-flex">
      <Tooltip label="Set follow-up instructions">
        <Button
          ref={triggerRef}
          // Set, it takes the accent ink beside the filled glyph; unset, the
          // routine secondary surface.
          variant={hasInstruction ? 'ghost' : 'secondary'}
          size="sm"
          iconOnly
          onClick={(): void => setOpen((prev) => !prev)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Set follow-up instructions"
          data-testid={`${dataTestId}-trigger`}
          data-has-instruction={hasInstruction ? 'true' : 'false'}
        >
          <Icon size="sm" aria-hidden="true" />
        </Button>
      </Tooltip>

      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        initialFocusRef={textAreaRef}
        // Right edges line up with the trigger, above it unless asked below.
        placement={placement === 'top' ? 'top-right' : 'bottom-right'}
        aria-label="Follow-up instruction"
        data-testid={`${dataTestId}-popover`}
      >
        <div className="electron-no-drag flex flex-col gap-1.5">
          <div
            id={`${dataTestId}-label`}
            className="text-3xs font-semibold fg-secondary"
          >
            Follow-up instruction
          </div>
          <TextArea
            ref={textAreaRef}
            aria-labelledby={`${dataTestId}-label`}
            value={value}
            onChange={(event): void => onChange(event.target.value)}
            rows={4}
            placeholder="Instruction for the notified chat when this workflow completes…"
            data-testid={`${dataTestId}-textarea`}
          />
        </div>
      </Popover>
    </div>
  );
}

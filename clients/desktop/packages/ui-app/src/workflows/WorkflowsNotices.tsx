'use client';

import { useRef, useState, type JSX } from 'react';
import {
  ActionMenuRowStyle,
  Button,
  MenuItem,
  MenuItemIcon,
  Menu,
} from '@canopy/ui-shared/components';
import { PipelineIcon, ScheduleIcon } from '@canopy/ui-shared/icons/AppIcons';

export interface NewWorkflowMenuProps {
  /** Creates an automation. Omitted when the host cannot. */
  readonly onSchedule?: () => void;
  /** Creates a pipeline by describing it to an agent. */
  readonly onDescribePipeline?: () => void;
  /** Creates a pipeline in the editor. */
  readonly onBuildPipeline?: () => void;
  readonly variant?: 'primary' | 'secondary';
}

/**
 * `New workflow`: "On a schedule" creates an automation, "When you start it"
 * creates a pipeline. Renders nothing when the host can create neither.
 *
 * Two-line rows (a label over a description), so the rows are
 * `MenuItem`s with their icon in `MenuItemIcon` rather than
 * the single-line shared action rows. The two pipeline rows are one action's
 * two forms and share an icon, shown on the first of them only.
 */
export function NewWorkflowMenu({
  onSchedule,
  onDescribePipeline,
  onBuildPipeline,
  variant = 'primary',
}: NewWorkflowMenuProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  if (!onSchedule && !onDescribePipeline && !onBuildPipeline) return null;
  return (
    <>
      <Button
        ref={anchorRef}
        variant={variant}
        size="compact"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="workflows-new"
        onClick={(): void => setOpen((current) => !current)}
      >
        New workflow
      </Button>
      <Menu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        className="min-w-64"
        data-testid="workflows-new-menu"
      >
        <ActionMenuRowStyle>
          {onSchedule ? (
            <MenuItem
              multiline
              data-testid="workflows-new-schedule"
              onClick={onSchedule}
            >
              <MenuItemIcon>
                <ScheduleIcon />
              </MenuItemIcon>
              <span className="flex min-w-0 flex-col">
                <span>On a schedule</span>
                <span className="text-xs fg-tertiary">
                  Runs at set times, or once at a time you pick
                </span>
              </span>
            </MenuItem>
          ) : null}
          {onDescribePipeline ? (
            <MenuItem
              multiline
              data-testid="workflows-new-describe"
              onClick={onDescribePipeline}
            >
              <MenuItemIcon>
                <PipelineIcon />
              </MenuItemIcon>
              <span className="flex min-w-0 flex-col">
                <span>When you start it</span>
                <span className="text-xs fg-tertiary">
                  Describe the workflow to an agent
                </span>
              </span>
            </MenuItem>
          ) : null}
          {onBuildPipeline ? (
            <MenuItem
              multiline
              data-testid="workflows-new-build"
              onClick={onBuildPipeline}
            >
              <MenuItemIcon>
                {onDescribePipeline ? null : <PipelineIcon />}
              </MenuItemIcon>
              <span className="flex min-w-0 flex-col">
                <span>
                  {onDescribePipeline
                    ? 'When you start it, built by hand'
                    : 'When you start it'}
                </span>
                <span className="text-xs fg-tertiary">
                  {onDescribePipeline
                    ? 'Build the workflow in the editor'
                    : 'Describe it to the assistant, or build it yourself'}
                </span>
              </span>
            </MenuItem>
          ) : null}
        </ActionMenuRowStyle>
      </Menu>
    </>
  );
}

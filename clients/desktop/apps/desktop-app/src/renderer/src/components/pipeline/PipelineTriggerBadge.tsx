import { ControlButton } from '@canopy/ui-shared/components';
import { type JSX } from 'react';
import { Tooltip } from '@canopy/ui-shared';
import type { PipelineTriggerType } from '@canopy/execution-engine/types/pipeline';
import { TriggerIcon, WorkflowIcon } from '@canopy/ui-shared/icons/AppIcons';
import { PlanModeIcon, TaskIcon } from '@canopy/ui-shared/icons';
import { getTriggerMeta } from './pipeline-trigger-meta';

interface TriggerBadgeProps {
  type: PipelineTriggerType;
}

/**
 * Glyph for a pipeline trigger type. Shared so every surface that renders a
 * trigger uses the same icon vocabulary as the pipelines table.
 */
export const PIPELINE_TRIGGER_GLYPHS: Readonly<
  Record<PipelineTriggerType, JSX.Element>
> = {
  dispatch: <TriggerIcon size="sm" />,
  task_ready: <TaskIcon size="sm" />,
  plan_ready: <PlanModeIcon size="sm" />,
  workflow: <WorkflowIcon size="sm" />,
};

export function PipelineTriggerDetails({
  type,
}: TriggerBadgeProps): JSX.Element {
  const meta = getTriggerMeta(type);

  if (!meta) {
    return <></>;
  }

  return (
    <Tooltip label={meta.label} description={meta.description}>
      <ControlButton
        type="button"
        aria-label={`${meta.label}: ${meta.description}`}
        presentation="workflow-trigger-info"
        appearance={type}
      >
        {PIPELINE_TRIGGER_GLYPHS[type]}
      </ControlButton>
    </Tooltip>
  );
}

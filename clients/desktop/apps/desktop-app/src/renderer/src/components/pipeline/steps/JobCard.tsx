import { ControlButton } from '@canopy/ui-shared/components';
import {
  WorkflowEditorJob,
  WorkflowEditorJobHeader,
} from '@canopy/ui-shared/components';
import { type JSX, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import type { Job, Step } from '@canopy/execution-engine/types/pipeline';
import { normalizeNeeds } from '@canopy/execution-engine/types/pipeline';
import type { Selection } from '../../../hooks/usePipelineEditor';
import { Badge, Count } from '@canopy/ui-shared/components';
import { StepCard } from './StepCard';
import { DragHandleIcon } from '@canopy/ui-shared/icons/AppIcons';
import { Button } from '@canopy/ui-shared/components';
import {
  ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon,
  PlusIcon as AppCatalogPlusIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { EmptyStateRow } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

interface JobCardProps {
  jobId: string;
  job: Job;
  selection: Selection;
  onSelectJob: (jobId: string) => void;
  onSelectStep: (jobId: string, stepIndex: number) => void;
  onAddStep: (jobId: string) => void;
  onDeleteStep: (jobId: string, stepIndex: number) => void;
  readonly?: boolean;
}

export function JobCard({
  jobId,
  job,
  selection,
  onSelectJob,
  onSelectStep,
  onAddStep,
  onDeleteStep,
  readonly = false,
}: JobCardProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);

  const isSelected = selection.type === 'job' && selection.jobId === jobId;

  const needs: string[] = normalizeNeeds(job.needs);

  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `job:${jobId}`,
    data: { type: 'job', jobId },
  });

  const { setNodeRef: setDropRef } = useDroppable({
    id: `job-drop:${jobId}`,
    data: { type: 'job-drop', jobId },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const sortableStepIds: string[] = job.steps.map(
    (_: Step, i: number): string => `${jobId}:step:${i}`,
  );

  return (
    <WorkflowEditorJob ref={setSortableRef} style={style} selected={isSelected}>
      {/* Job header */}
      <WorkflowEditorJobHeader onClick={() => onSelectJob(jobId)}>
        {/* Drag handle */}
        {!readonly && (
          <ControlButton
            {...attributes}
            {...listeners}
            presentation="workflow-job-handle"
            onClick={(e) => e.stopPropagation()}
          >
            <DragHandleIcon size="sm" />
          </ControlButton>
        )}

        {/* Collapse toggle */}
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed(!collapsed);
          }}
          aria-label={collapsed ? 'Expand job' : 'Collapse job'}
          aria-expanded={!collapsed}
        >
          <AppCatalogChevronRightMediumIcon
            size="sm"
            className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
        </Button>

        {/* Job name */}
        {/* Job names are authored, as in the Designer: never recorded. */}
        <span
          className={`text-s font-medium fg-primary truncate flex-1 ${REPLAY_BLOCK_CLASS}`}
        >
          {job.name || jobId}
        </span>

        {/* Dependency pills */}
        {needs.length > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            {needs.map((dep: string) => (
              <Badge key={dep}>{dep}</Badge>
            ))}
          </div>
        )}

        {/* Step count badge */}
        <Count value={job.steps.length} className="shrink-0" />

        {/* Add step button */}
        {!readonly && (
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            onClick={(e) => {
              e.stopPropagation();
              onAddStep(jobId);
            }}
            aria-label="Add step"
          >
            <AppCatalogPlusIcon size="sm" />
          </Button>
        )}
      </WorkflowEditorJobHeader>

      {/* Job body (steps) */}
      {!collapsed && (
        // 2px inside the job's 12px corners keeps the 10px rows concentric.
        <div ref={setDropRef} className="flex flex-col p-0.5 min-h-10">
          {job.steps.length === 0 ? (
            <EmptyStateRow title="No steps yet" />
          ) : (
            <SortableContext
              items={sortableStepIds}
              strategy={verticalListSortingStrategy}
            >
              {job.steps.map((step: Step, index: number) => (
                <StepCard
                  key={sortableStepIds[index]}
                  step={step}
                  stepIndex={index}
                  jobId={jobId}
                  selected={
                    selection.type === 'step' &&
                    selection.jobId === jobId &&
                    selection.stepIndex === index
                  }
                  onSelect={() => onSelectStep(jobId, index)}
                  onDelete={() => onDeleteStep(jobId, index)}
                  readonly={readonly}
                />
              ))}
            </SortableContext>
          )}
        </div>
      )}
    </WorkflowEditorJob>
  );
}

import { type JSX, useState, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { Pipeline, Step } from '@canopy/execution-engine/types/pipeline';
import type { Selection } from '../../../hooks/usePipelineEditor';
import {
  Surface,
  Button,
  EmptyState,
  Heading,
} from '@canopy/ui-shared/components';
import { PipelineStepRow } from '@canopy/ui-app';
import { JobCard } from './JobCard';
import { stepKind, stepSummary } from './stepDisplay';

interface JobListProps {
  pipeline: Pipeline;
  jobOrder: string[];
  selection: Selection;
  onSelectJob: (jobId: string) => void;
  onSelectStep: (jobId: string, stepIndex: number) => void;
  onAddStep: (jobId: string) => void;
  onDeleteStep: (jobId: string, stepIndex: number) => void;
  onReorderSteps: (jobId: string, fromIndex: number, toIndex: number) => void;
  onMoveStep: (
    fromJobId: string,
    fromIndex: number,
    toJobId: string,
    toIndex: number,
  ) => void;
  onAddJob: () => void;
  readonly?: boolean;
}

interface ActiveDrag {
  jobId: string;
  stepIndex: number;
}

function parseSortableId(
  id: string,
): { jobId: string; stepIndex: number } | null {
  const parts: string[] = id.split(':step:');
  if (parts.length !== 2) return null;
  const jobId: string = parts[0];
  const stepIndex: number = parseInt(parts[1], 10);
  if (Number.isNaN(stepIndex)) return null;
  return { jobId, stepIndex };
}

export function JobList({
  pipeline,
  jobOrder,
  selection,
  onSelectJob,
  onSelectStep,
  onAddStep,
  onDeleteStep,
  onReorderSteps,
  onMoveStep,
  onAddJob,
  readonly = false,
}: JobListProps): JSX.Element {
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = useCallback((event: DragStartEvent): void => {
    const id: string = String(event.active.id);
    const parsed = parseSortableId(id);
    if (parsed) {
      setActiveDrag(parsed);
    }
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent): void => {
      const { active, over } = event;
      if (!over || !activeDrag) return;

      const activeId: string = String(active.id);
      const overId: string = String(over.id);
      if (activeId === overId) return;

      const activeParsed = parseSortableId(activeId);
      if (!activeParsed) return;

      // Determine target job and index
      let targetJobId: string | undefined;
      let targetIndex: number | undefined;

      // Hovering over a step in another job
      const overParsed = parseSortableId(overId);
      if (overParsed) {
        if (overParsed.jobId === activeParsed.jobId) return; // same job handled in dragEnd
        targetJobId = overParsed.jobId;
        targetIndex = overParsed.stepIndex;
      }

      // Hovering over a job droppable area
      if (!targetJobId && overId.startsWith('job-drop:')) {
        targetJobId = overId.replace('job-drop:', '');
        if (targetJobId === activeParsed.jobId) return;
        const targetJob = pipeline.jobs[targetJobId];
        targetIndex = targetJob ? targetJob.steps.length : 0;
      }

      // Hovering over a job sortable (header)
      if (!targetJobId && overId.startsWith('job:')) {
        targetJobId = overId.replace('job:', '');
        if (targetJobId === activeParsed.jobId) return;
        const targetJob = pipeline.jobs[targetJobId];
        targetIndex = targetJob ? targetJob.steps.length : 0;
      }

      if (targetJobId === undefined || targetIndex === undefined) return;

      onMoveStep(
        activeParsed.jobId,
        activeParsed.stepIndex,
        targetJobId,
        targetIndex,
      );

      // Update activeDrag to reflect the new location
      setActiveDrag({ jobId: targetJobId, stepIndex: targetIndex });
    },
    [activeDrag, pipeline.jobs, onMoveStep],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event;
      setActiveDrag(null);

      if (!over || active.id === over.id) return;

      const activeParsed = parseSortableId(String(active.id));
      const overParsed = parseSortableId(String(over.id));

      if (!activeParsed || !overParsed) return;

      // Only handle within-job reorder here (cross-job is handled in dragOver)
      if (activeParsed.jobId !== overParsed.jobId) return;

      onReorderSteps(
        activeParsed.jobId,
        activeParsed.stepIndex,
        overParsed.stepIndex,
      );
    },
    [onReorderSteps],
  );

  // Build the list of all sortable step IDs across all jobs for the overlay
  const activeStep: Step | undefined = activeDrag
    ? pipeline.jobs[activeDrag.jobId]?.steps[activeDrag.stepIndex]
    : undefined;

  // Collect all sortable step IDs for the top-level SortableContext
  const allSortableIds: string[] = jobOrder.flatMap((jid: string): string[] => {
    const job = pipeline.jobs[jid];
    if (!job) return [];
    return job.steps.map((_: Step, i: number): string => `${jid}:step:${i}`);
  });

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <Surface variant="section" boundary="bottom">
        <div className="flex items-center justify-between px-4 py-3">
          <Heading level={3} variant="label">
            Jobs ({jobOrder.length})
          </Heading>
        </div>
      </Surface>

      {/* Job list */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4 [&>*]:shrink-0">
        {jobOrder.length === 0 ? (
          <EmptyState
            title="No jobs yet"
            subtitle={'Click "Add job" to get started'}
          />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={allSortableIds}
              strategy={verticalListSortingStrategy}
            >
              {jobOrder.map((jid: string) => {
                const job = pipeline.jobs[jid];
                if (!job) return null;
                return (
                  <JobCard
                    key={jid}
                    jobId={jid}
                    job={job}
                    selection={selection}
                    onSelectJob={onSelectJob}
                    onSelectStep={onSelectStep}
                    onAddStep={onAddStep}
                    onDeleteStep={onDeleteStep}
                    readonly={readonly}
                  />
                );
              })}
            </SortableContext>

            <DragOverlay>
              {activeStep ? (
                <div className="opacity-80">
                  <Surface variant="raised" size="small">
                    <PipelineStepRow
                      name={activeStep.name ?? activeStep.id ?? 'Step'}
                      kind={stepKind(activeStep)}
                      summary={stepSummary(activeStep)}
                    />
                  </Surface>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}

        {/* Add Job button */}
        {!readonly && (
          <Button size="compact" onClick={onAddJob} className="self-start">
            Add job
          </Button>
        )}
      </div>
    </div>
  );
}

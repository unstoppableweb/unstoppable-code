'use client';

import { useState, type JSX } from 'react';
import { ListRow } from '@canopy/ui-shared/components';
import { PipelineRunChildRow } from './PipelineRunChildRow';
import {
  pipelineRunDetailStatusClassName,
  pipelineRunStepKey,
  type PipelineRunDetailJobGroup,
  type PipelineRunDetailStepEntry,
} from './PipelineRunDetailModel';

export interface PipelineRunStepTreeSelection {
  readonly job_id: string;
  readonly step_id: string;
}

export interface PipelineRunStepTreeProps {
  readonly groups: readonly PipelineRunDetailJobGroup[];
  readonly selected: PipelineRunStepTreeSelection | null;
  readonly onSelect: (selection: PipelineRunStepTreeSelection) => void;
  /** Opens a step's child run in a full view of its own (CAN-6868). */
  readonly onOpenChild?: (executionId: string) => void;
}

/** What a step's child row needs from the tree. */
interface ChildRowState {
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
  readonly onOpen?: (executionId: string) => void;
}

function isSelected(
  entry: PipelineRunDetailStepEntry,
  selected: PipelineRunStepTreeSelection | null,
): boolean {
  return (
    selected !== null &&
    selected.job_id === entry.job_id &&
    selected.step_id === entry.step.step_id
  );
}

function StepButton({
  entry,
  selected,
  onSelect,
  indented,
  childRows,
}: {
  entry: PipelineRunDetailStepEntry;
  selected: PipelineRunStepTreeSelection | null;
  onSelect: (selection: PipelineRunStepTreeSelection) => void;
  indented: boolean;
  childRows: ChildRowState;
}): JSX.Element {
  const active = isSelected(entry, selected);
  const row = (
    <ListRow
      selected={active}
      aria-pressed={active}
      data-testid={`remote-control-pipeline-step-${entry.job_id}-${entry.step.step_id}`}
      onClick={(): void =>
        onSelect({ job_id: entry.job_id, step_id: entry.step.step_id })
      }
      trailing={
        <span className={pipelineRunDetailStatusClassName(entry.step.status)}>
          {entry.step.status}
        </span>
      }
    >
      {entry.step.name}
    </ListRow>
  );
  const { child } = entry.step;
  const key = pipelineRunStepKey(entry.job_id, entry.step.step_id);
  const onOpen = childRows.onOpen;
  // A step's child run sits under its step, its status beside its name.
  const withChild =
    child === undefined ? (
      row
    ) : (
      <div className="flex flex-col gap-0.5">
        {row}
        <div className="pl-3">
          <PipelineRunChildRow
            stepId={entry.step.step_id}
            label={child.name}
            status={
              child.status === null ? undefined : (
                <span
                  className={pipelineRunDetailStatusClassName(child.status)}
                >
                  {child.status}
                </span>
              )
            }
            expanded={childRows.expanded.has(key)}
            onToggle={(): void => childRows.onToggle(key)}
            {...(onOpen !== undefined && {
              onOpen: (): void => onOpen(child.execution_id),
            })}
          >
            <p className="px-2 py-1 text-2xs fg-secondary">
              {child.status === null
                ? 'The child workflow this step started.'
                : `The child workflow this step started is ${child.status}. Open it to see its steps and logs.`}
            </p>
          </PipelineRunChildRow>
        </div>
      </div>
    );
  // A matrix variant's steps sit one level in, under the variant's heading.
  return indented ? <div className="pl-3">{withChild}</div> : withChild;
}

/**
 * Job-grouped step tree. Jobs head their own steps; matrix variants nest one
 * level below their logical job. See `buildPipelineRunDetailJobs` for why one
 * level is the ceiling.
 */
export function PipelineRunStepTree({
  groups,
  selected,
  onSelect,
  onOpenChild,
}: PipelineRunStepTreeProps): JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const childRows: ChildRowState = {
    expanded,
    onToggle: (key) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    ...(onOpenChild !== undefined && { onOpen: onOpenChild }),
  };
  return (
    <div
      className="flex flex-col gap-2 p-2"
      data-testid="pipeline-run-step-tree"
    >
      {groups.map((group) => (
        <div
          key={group.job_id}
          className="flex flex-col gap-0.5"
          data-testid={`pipeline-run-job-${group.job_id}`}
        >
          <div className="flex items-center justify-between gap-2 px-2 py-1">
            <span className="truncate text-2xs font-semibold fg-secondary">
              {group.name}
            </span>
            <span className={pipelineRunDetailStatusClassName(group.status)}>
              {group.status}
            </span>
          </div>
          {group.steps.map((entry) => (
            <StepButton
              key={pipelineRunStepKey(entry.job_id, entry.step.step_id)}
              entry={entry}
              selected={selected}
              onSelect={onSelect}
              indented={false}
              childRows={childRows}
            />
          ))}
          {group.variants.map((variant) => (
            <div
              key={variant.job_id}
              className="flex flex-col gap-0.5"
              data-testid={`pipeline-run-variant-${variant.job_id}`}
            >
              <div className="flex items-center justify-between gap-2 pl-4 pr-2 py-1">
                <span className="truncate text-3xs fg-secondary">
                  {variant.name}
                </span>
                <span
                  className={pipelineRunDetailStatusClassName(variant.status)}
                >
                  {variant.status}
                </span>
              </div>
              {variant.steps.map((entry) => (
                <StepButton
                  key={pipelineRunStepKey(entry.job_id, entry.step.step_id)}
                  entry={entry}
                  selected={selected}
                  onSelect={onSelect}
                  indented
                  childRows={childRows}
                />
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

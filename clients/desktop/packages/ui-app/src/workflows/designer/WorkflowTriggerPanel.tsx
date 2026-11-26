'use client';

import type { JSX } from 'react';
import {
  Button,
  ChoiceList,
  ChoiceField,
  EmptyStateRow,
  FieldError,
  Heading,
  Notice,
  NoticeButton,
  Stack,
} from '@canopy/ui-shared/components';
import { PlusIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/** The entries a person can start a workflow from by hand. */
export type WorkflowDesignerEntry = 'run' | 'approved-plan' | 'new-task';

export const WORKFLOW_DESIGNER_ENTRY_LABELS: Readonly<
  Record<WorkflowDesignerEntry, string>
> = {
  run: 'Run',
  'approved-plan': 'Approved plan',
  'new-task': 'New task',
};

const ENTRY_HINTS: Readonly<Record<WorkflowDesignerEntry, string>> = {
  run: 'Started by hand, or by a schedule.',
  'approved-plan': 'Starts when a plan is approved in a task.',
  'new-task': 'Starts when a new task begins.',
};

const ENTRY_ORDER: readonly WorkflowDesignerEntry[] = [
  'run',
  'approved-plan',
  'new-task',
];

export interface WorkflowTriggerSchedule {
  readonly key: string;
  /** When it runs, as `Weekdays at 9:00 AM`. */
  readonly summary: string;
  /** Its name when it has one: authored text. */
  readonly name?: string;
  readonly enabled: boolean;
}

export interface WorkflowTriggerPanelProps {
  readonly entries: readonly WorkflowDesignerEntry[];
  /** Absent when the workflow is read-only. */
  readonly onToggleEntry?: (
    entry: WorkflowDesignerEntry,
    next: boolean,
  ) => void;
  /** Why the last entry change was refused; it can quote an authored name. */
  readonly entryError?: string;
  /** `on:` names `workflow`, shown read-only. */
  readonly fromWorkflow: boolean;
  readonly schedules: readonly WorkflowTriggerSchedule[];
  readonly onEditSchedule?: (key: string) => void;
  /** Adds a schedule or a one-time run; absent when none can be added. */
  readonly onAddSchedule?: (kind: 'schedule' | 'once') => void;
  /** Why a schedule can't be added now. */
  readonly addScheduleBlockedReason?: string;
  /** Says what happens to a schedule chosen before the workflow is saved. */
  readonly scheduleNotice?: string;
  /** Drops the schedule waiting for a save. */
  readonly onCancelPendingSchedule?: () => void;
}

/**
 * The trigger card's details (CAN-4224 phase 04): the entries a person
 * starts the workflow from, a workflow entry shown read-only, and the
 * schedules that start it, with the host's ways to edit and add them.
 */
export function WorkflowTriggerPanel({
  entries,
  onToggleEntry,
  entryError,
  fromWorkflow,
  schedules,
  onEditSchedule,
  onAddSchedule,
  addScheduleBlockedReason,
  scheduleNotice,
  onCancelPendingSchedule,
}: WorkflowTriggerPanelProps): JSX.Element {
  return (
    <Stack gap="section" data-testid="workflow-trigger-panel">
      <Stack gap="inline">
        <Heading level={4} variant="label">
          Manual
        </Heading>
        <span className="text-xs fg-tertiary">
          Ways a person starts this workflow. Keep at least one.
        </span>
        <ChoiceList aria-label="Manual entries">
          {ENTRY_ORDER.map((entry) => (
            <ChoiceField
              key={entry}
              layout="row"
              checked={entries.includes(entry)}
              onChange={() => onToggleEntry?.(entry, !entries.includes(entry))}
              disabled={onToggleEntry === undefined}
              data-testid={`workflow-trigger-entry-${entry}`}
              label={
                <span className="flex flex-col">
                  <span>{WORKFLOW_DESIGNER_ENTRY_LABELS[entry]}</span>
                  <span className="text-xs fg-tertiary">
                    {ENTRY_HINTS[entry]}
                  </span>
                </span>
              }
            />
          ))}
        </ChoiceList>
        {entryError !== undefined ? (
          <FieldError
            id="workflow-trigger-entry-error"
            announce
            data-testid="workflow-trigger-entry-error"
          >
            {/* It can quote an authored name: never recorded. */}
            <span className={REPLAY_BLOCK_CLASS}>{entryError}</span>
          </FieldError>
        ) : null}
      </Stack>
      {fromWorkflow ? (
        <Notice intent="neutral" role="none">
          Another workflow can also start this one. Change that in YAML.
        </Notice>
      ) : null}
      <Stack gap="inline">
        <Heading level={4} variant="label">
          Schedules
        </Heading>
        <span className="text-xs fg-tertiary">
          Schedules start the workflow as a run.
        </span>
        <Stack gap="inline">
          {schedules.length === 0 ? (
            <EmptyStateRow
              title="No schedules yet."
              testId="workflow-trigger-no-schedules"
            />
          ) : (
            schedules.map((schedule) => (
              <div
                key={schedule.key}
                className="flex items-center gap-2"
                data-testid="workflow-trigger-schedule"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-s fg-primary">
                    {schedule.summary}
                  </span>
                  {schedule.name !== undefined ? (
                    <span
                      className={`truncate text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`}
                    >
                      {schedule.name}
                    </span>
                  ) : null}
                  {schedule.enabled ? null : (
                    <span className="text-xs fg-tertiary">Paused</span>
                  )}
                </span>
                {onEditSchedule ? (
                  <Button
                    variant="secondary"
                    size="compact"
                    data-testid="workflow-trigger-edit-schedule"
                    onClick={() => onEditSchedule(schedule.key)}
                  >
                    Edit
                  </Button>
                ) : null}
              </div>
            ))
          )}
          {scheduleNotice !== undefined ? (
            <Notice
              intent="neutral"
              role="none"
              {...(onCancelPendingSchedule
                ? {
                    actions: (
                      <NoticeButton
                        data-testid="workflow-trigger-cancel-pending"
                        onClick={onCancelPendingSchedule}
                      >
                        Cancel
                      </NoticeButton>
                    ),
                  }
                : {})}
            >
              {scheduleNotice}
            </Notice>
          ) : null}
          {onAddSchedule ? (
            <span className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="compact"
                data-testid="workflow-trigger-add-schedule"
                disabled={addScheduleBlockedReason !== undefined}
                onClick={() => onAddSchedule('schedule')}
              >
                <PlusIcon size="sm" aria-hidden="true" />
                Add a schedule
              </Button>
              <Button
                variant="secondary"
                size="compact"
                data-testid="workflow-trigger-add-once"
                disabled={addScheduleBlockedReason !== undefined}
                onClick={() => onAddSchedule('once')}
              >
                <PlusIcon size="sm" aria-hidden="true" />
                Run once later
              </Button>
            </span>
          ) : null}
          {addScheduleBlockedReason !== undefined ? (
            <span className="text-xs fg-tertiary">
              {addScheduleBlockedReason}
            </span>
          ) : null}
        </Stack>
      </Stack>
    </Stack>
  );
}

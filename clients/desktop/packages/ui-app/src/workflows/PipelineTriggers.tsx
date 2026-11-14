'use client';

import { Fragment, type JSX, type ReactNode } from 'react';
import { ORCHESTRATOR_LABEL, REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import {
  Button,
  Disclosure,
  Divider,
  Heading,
  Notice,
  Surface,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import { ChevronRightIcon } from '@canopy/ui-shared/icons';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  WORKFLOW_TRIGGER_LABELS,
  type WorkflowTriggerKind,
} from './workflow-library-model';

/** A trigger a pipeline declares itself, in the Library's vocabulary. */
export type PipelineStartKind = Extract<
  WorkflowTriggerKind,
  'manual' | 'plan-approved' | 'task-ready' | 'workflow'
>;

export const PIPELINE_START_KINDS: readonly PipelineStartKind[] = [
  'workflow',
  'manual',
  'plan-approved',
  'task-ready',
];

const PIPELINE_START_DESCRIPTIONS: Readonly<Record<PipelineStartKind, string>> =
  {
    // The page's Run button is a manual start, so Manual names it and the
    // Workflow row names only the schedules (CAN-5782).
    manual: `Run button, ${ORCHESTRATOR_LABEL} or ${REMOTE_CONTROL_LABEL}`,
    'plan-approved': 'From an approved plan',
    'task-ready': 'From a new task in workflow mode',
    workflow: 'On its schedules',
  };

/** A hook that runs the pipeline. */
export interface PipelineTriggerHookRow {
  readonly key: string;
  /** The hook's event, as `PR Checks Finished`. */
  readonly eventLabel: string;
  /** The project, and the repository in a multi-repo project. */
  readonly where: string;
}

/** An automation that runs the pipeline. */
export interface PipelineTriggerAutomationRow {
  readonly key: string;
  readonly name: string;
  readonly scheduleText: string;
  readonly enabled: boolean;
}

/**
 * One schedule of a workflow page (CAN-5782): an automation record that runs
 * the pipeline on a time, shown as its own trigger row with its own switch.
 */
export interface PipelineTriggerScheduleRow {
  readonly key: string;
  /** When it runs, as `Weekdays at 9:00 AM`. */
  readonly summary: string;
  readonly enabled: boolean;
  /** The switch is writing. */
  readonly busy?: boolean;
  /** Edits not saved yet. */
  readonly dirty?: boolean;
  /** A note under the row, such as whose restrictions its runs keep. */
  readonly notice?: ReactNode;
  /** Why the row's last switch or action was refused. */
  readonly error?: string;
}

/** A workflow page's schedules, in place of the automations that run it. */
export interface PipelineTriggerSchedules {
  readonly rows: readonly PipelineTriggerScheduleRow[];
  readonly expandedKey: string | null;
  readonly onExpand: (key: string | null) => void;
  readonly onToggle: (row: PipelineTriggerScheduleRow, next: boolean) => void;
  /** The expanded row's editor. */
  readonly renderBody: (row: PipelineTriggerScheduleRow) => ReactNode;
  /** Adds a schedule; absent when the workflow can't have another. */
  readonly onAdd?: () => void;
  /** Why it can't, shown under the rows. */
  readonly addBlockedReason?: string;
}

export interface PipelineTriggersProps {
  /** The triggers the pipeline declares. */
  readonly starts: readonly PipelineStartKind[];
  readonly hooks: readonly PipelineTriggerHookRow[];
  readonly automations: readonly PipelineTriggerAutomationRow[];
  readonly onOpenHook: (row: PipelineTriggerHookRow) => void;
  readonly onOpenAutomation: (row: PipelineTriggerAutomationRow) => void;
  /** Opens where the declared triggers are edited; absent when read-only. */
  readonly onEditStarts?: () => void;
  /**
   * A workflow page's schedules (CAN-5782). When present they replace the
   * Automations section: each schedule is one of the ways it starts.
   */
  readonly schedules?: PipelineTriggerSchedules;
}

function Section({
  id,
  title,
  action,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  const headingId = `pipeline-trigger-${id}-heading`;
  return (
    <section className="flex flex-col gap-2" aria-labelledby={headingId}>
      <div className="flex min-h-7 items-center gap-2">
        <Heading level={2} variant="title" id={headingId}>
          {title}
        </Heading>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function EmptyRow({
  testId,
  children,
}: {
  readonly testId: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Surface variant="outline">
      <p className="px-4 py-3 text-s fg-tertiary" data-testid={testId}>
        {children}
      </p>
    </Surface>
  );
}

function RowButton({
  onClick,
  children,
  ...data
}: {
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly [dataAttribute: `data-${string}`]: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring flex w-full items-center gap-4 px-4 py-3 text-left text-s transition-colors hover:bg-secondary"
      {...data}
    >
      {children}
      <ChevronRightIcon
        size="sm"
        aria-hidden="true"
        className="shrink-0 fg-tertiary"
      />
    </button>
  );
}

function ScheduleRow({
  row,
  expanded,
  schedules,
}: {
  readonly row: PipelineTriggerScheduleRow;
  readonly expanded: boolean;
  readonly schedules: PipelineTriggerSchedules;
}): JSX.Element {
  return (
    <li
      data-testid="pipeline-trigger-schedule"
      data-schedule-key={row.key}
      data-on={String(row.enabled)}
      className="flex flex-col gap-2 px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <Disclosure
          className="min-w-0 flex-1"
          label={
            <span className="flex min-w-0 items-center gap-3">
              <span className="fg-primary">Schedule</span>
              <span className="truncate">{row.summary}</span>
            </span>
          }
          {...(row.dirty ? { hint: 'Unsaved' } : {})}
          open={expanded}
          onOpenChange={(open): void =>
            schedules.onExpand(open ? row.key : null)
          }
          dataTestId="pipeline-trigger-schedule-disclosure"
          toggleTestId="pipeline-trigger-schedule-expand"
        >
          <div data-testid="pipeline-trigger-schedule-body">
            {schedules.renderBody(row)}
          </div>
        </Disclosure>
        <ToggleSwitch
          checked={row.enabled}
          disabled={row.busy}
          busy={row.busy}
          label={`Schedule ${row.summary} is ${row.enabled ? 'on' : 'off'}`}
          dataTestId="pipeline-trigger-schedule-toggle"
          onChange={(next): void => schedules.onToggle(row, next)}
        />
      </div>
      {/* The expanded body shows its own error; a collapsed row says why a
          switch or an action was refused here, where it was pressed. */}
      {row.error && !expanded ? (
        <Notice
          errorSource="pipeline-trigger-schedule-error"
          intent="destructive"
          data-testid="pipeline-trigger-schedule-error"
        >
          {row.error}
        </Notice>
      ) : null}
      {row.notice ?? null}
    </li>
  );
}

function SchedulesSection({
  schedules,
}: {
  readonly schedules: PipelineTriggerSchedules;
}): JSX.Element {
  return (
    <Section
      id="schedules"
      title="Schedules"
      action={
        schedules.onAdd ? (
          <Button
            variant="ghost"
            size="compact"
            onClick={schedules.onAdd}
            data-testid="pipeline-trigger-add-schedule"
          >
            Add schedule
          </Button>
        ) : undefined
      }
    >
      {schedules.rows.length === 0 ? (
        <EmptyRow testId="pipeline-trigger-schedules-empty">
          No schedules. It runs only when it's started.
        </EmptyRow>
      ) : (
        <Surface
          as="ul"
          variant="outline"
          data-testid="pipeline-trigger-schedules"
        >
          {schedules.rows.map((row, index) => (
            <Fragment key={row.key}>
              {index > 0 ? <Divider aria-hidden /> : null}
              <ScheduleRow
                row={row}
                expanded={schedules.expandedKey === row.key}
                schedules={schedules}
              />
            </Fragment>
          ))}
        </Surface>
      )}
      {schedules.addBlockedReason ? (
        <p
          className="text-xs fg-tertiary"
          data-testid="pipeline-trigger-add-schedule-blocked"
        >
          {schedules.addBlockedReason}
        </p>
      ) : null}
    </Section>
  );
}

/**
 * A pipeline's Trigger section (CAN-4072): everything that can start it. The
 * triggers it declares come first; hooks and automations start it through
 * its Manual trigger, so without one they say so instead of reading as
 * simply unused.
 */
export function PipelineTriggers({
  starts,
  hooks,
  automations,
  onOpenHook,
  onOpenAutomation,
  onEditStarts,
  schedules,
}: PipelineTriggersProps): JSX.Element {
  const manual = starts.includes('manual');
  // Schedules start the pipeline through its Manual trigger (CAN-5782).
  const scheduleCount = schedules?.rows.length ?? 0;
  return (
    <div className="flex flex-col gap-6" data-testid="pipeline-triggers">
      <Section
        id="starts"
        title="Starts from"
        action={
          onEditStarts ? (
            <Button
              variant="ghost"
              size="compact"
              onClick={onEditStarts}
              data-testid="pipeline-trigger-edit-starts"
            >
              Edit
            </Button>
          ) : undefined
        }
      >
        <Surface variant="outline">
          <ul className="divide-y" data-testid="pipeline-trigger-starts">
            {PIPELINE_START_KINDS.map((kind) => {
              const on = starts.includes(kind);
              return (
                <li
                  key={kind}
                  className="flex items-center gap-4 px-4 py-3 text-s"
                  data-testid="pipeline-trigger-start"
                  data-trigger={kind}
                  data-on={String(on)}
                >
                  <span
                    className={`w-32 shrink-0 ${on ? 'fg-primary' : 'fg-tertiary'}`}
                  >
                    {WORKFLOW_TRIGGER_LABELS[kind]}
                  </span>
                  <span className="min-w-0 flex-1 truncate fg-secondary">
                    {PIPELINE_START_DESCRIPTIONS[kind]}
                    {kind === 'manual' && on && scheduleCount > 0
                      ? ` · Used by ${String(scheduleCount)} ${scheduleCount === 1 ? 'schedule' : 'schedules'}`
                      : null}
                  </span>
                  <span
                    className={`w-10 shrink-0 text-xs ${on ? 'fg-secondary' : 'fg-tertiary'}`}
                  >
                    {on ? 'On' : 'Off'}
                  </span>
                  {/* Lines On and Off up with the rows below, which end in a chevron. */}
                  <span className="w-3.5 shrink-0" aria-hidden="true" />
                </li>
              );
            })}
          </ul>
        </Surface>
      </Section>

      <Section id="hooks" title="Hooks">
        {hooks.length === 0 ? (
          <EmptyRow testId="pipeline-trigger-hooks-empty">
            {manual
              ? 'No hooks run this workflow.'
              : 'Hooks only run workflows with a Manual trigger.'}
          </EmptyRow>
        ) : (
          <Surface variant="outline">
            <ul className="divide-y" data-testid="pipeline-trigger-hooks">
              {hooks.map((row) => (
                <li key={row.key}>
                  <RowButton
                    onClick={(): void => onOpenHook(row)}
                    data-testid="pipeline-trigger-hook"
                    data-hook-key={row.key}
                  >
                    <span className="min-w-0 flex-1 truncate fg-primary">
                      {row.eventLabel}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate fg-secondary ${REPLAY_MASK_CLASS}`}
                    >
                      {row.where}
                    </span>
                  </RowButton>
                </li>
              ))}
            </ul>
          </Surface>
        )}
      </Section>

      {schedules ? <SchedulesSection schedules={schedules} /> : null}

      {schedules ? null : (
        <Section id="automations" title="Automations">
          {automations.length === 0 ? (
            <EmptyRow testId="pipeline-trigger-automations-empty">
              {manual
                ? 'No automations run this workflow.'
                : 'Automations only run workflows with a Manual trigger.'}
            </EmptyRow>
          ) : (
            <Surface variant="outline">
              <ul
                className="divide-y"
                data-testid="pipeline-trigger-automations"
              >
                {automations.map((row) => (
                  <li key={row.key}>
                    <RowButton
                      onClick={(): void => onOpenAutomation(row)}
                      data-testid="pipeline-trigger-automation"
                      data-activity-id={row.key}
                    >
                      <span
                        className={`min-w-0 flex-1 truncate fg-primary ${REPLAY_MASK_CLASS}`}
                      >
                        {row.name}
                      </span>
                      <span className="min-w-0 flex-1 truncate fg-secondary">
                        {row.scheduleText}
                      </span>
                      <span className="w-10 shrink-0 text-xs fg-secondary">
                        {row.enabled ? 'On' : 'Off'}
                      </span>
                    </RowButton>
                  </li>
                ))}
              </ul>
            </Surface>
          )}
        </Section>
      )}
    </div>
  );
}

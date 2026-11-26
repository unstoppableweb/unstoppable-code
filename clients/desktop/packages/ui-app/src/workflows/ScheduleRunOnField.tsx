import { useId, type JSX } from 'react';
import type { CanopyCapabilities } from '@canopy/app-core';
import {
  Button,
  ChoiceList,
  ChoiceField,
  FieldError,
  Notice,
  NoticeButton,
  Select,
  type SelectOption,
} from '@canopy/ui-shared/components';
import { PIPELINE_RUN_CONTEXT_COPY } from './PipelineRunContextFields';

/**
 * Where one workflow schedule runs (CAN-6917, plan CP-47): on this computer
 * or in the cloud. The Run dialog's Run on choice (CAN-6187), for a
 * schedule: the label and rows are the same, so one term names one choice.
 * Choosing moves the schedule; the host's move may ask for a cloud place or
 * for cloud models first, which this field shows until the person answers.
 */
export type ScheduleRunOn = 'local' | 'cloud';

export const SCHEDULE_RUN_ON_COPY = {
  ...PIPELINE_RUN_CONTEXT_COPY,
  thisComputerDetail: 'Runs on time while this computer is on.',
  cloudDetail: 'Runs in the cloud on time, even while this computer is off.',
  moving: 'Moving this schedule…',
  choosePlace: 'Cloud project or task',
  choosePlaceholder: 'Choose where it runs',
  move: 'Move to cloud',
  cancel: 'Cancel',
  finishingTitle: 'Schedule paused',
  finishing: 'It stays paused until its move to the cloud finishes.',
  finish: 'Finish moving',
} as const;

/** A move that asked for a cloud place: pick one, then move again. */
export interface ScheduleRunOnPlacePick {
  readonly message: string;
  readonly options: readonly SelectOption[];
  readonly value: string | null;
  readonly onChange: (value: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export interface ScheduleRunOnFieldProps {
  /**
   * The CAN-6085 axis: the field shows only while the host's web core
   * reports cloud workflows available.
   */
  readonly capabilities: Pick<CanopyCapabilities, 'pipelineCloudRuns'>;
  readonly value: ScheduleRunOn;
  readonly onChange: (value: ScheduleRunOn) => void;
  /** While a move is in flight: both rows are disabled. */
  readonly busy?: boolean;
  /** Why this schedule can't run in the cloud (an Orchestrator workflow). */
  readonly cloudUnavailableReason?: string;
  /** Why it can't move right now (unsaved edits), shown under the rows. */
  readonly blockedReason?: string;
  /** A move that asked where in the cloud it runs. */
  readonly placePick?: ScheduleRunOnPlacePick;
  /** A move held until it finishes (models the person hasn't chosen yet). */
  readonly onFinish?: () => void;
  /** Why the last move was refused. */
  readonly error?: string | null;
}

export function ScheduleRunOnField({
  capabilities,
  value,
  onChange,
  busy = false,
  cloudUnavailableReason,
  blockedReason,
  placePick,
  onFinish,
  error,
}: ScheduleRunOnFieldProps): JSX.Element | null {
  const labelId = useId();
  const placeLabelId = useId();
  // A schedule already in the cloud always shows, so it can come back.
  if (capabilities.pipelineCloudRuns !== true && value === 'local') return null;
  const disabled = busy || blockedReason !== undefined;
  const choose = (next: ScheduleRunOn): void => {
    // A radio row: pressing the chosen row changes nothing.
    if (next !== value) onChange(next);
  };
  // Radio rows, not a segmented control: Cloud can be unavailable with a
  // reason (docs/design/forms.md), as in the Run dialog.
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid="workflow-schedule-run-on"
      data-run-on={value}
    >
      <span id={labelId} className="text-s font-medium fg-primary">
        {SCHEDULE_RUN_ON_COPY.runOn}
      </span>
      <ChoiceList
        kind="radio"
        aria-label={SCHEDULE_RUN_ON_COPY.runOn}
        data-testid="workflow-schedule-run-on-choices"
      >
        <ChoiceField
          layout="row"
          kind="radio"
          checked={value === 'local'}
          disabled={disabled}
          onChange={(): void => choose('local')}
          data-testid="workflow-schedule-run-on-local"
          label={
            <>
              <span className="block">{SCHEDULE_RUN_ON_COPY.thisComputer}</span>
              <span className="block text-xs fg-secondary">
                {SCHEDULE_RUN_ON_COPY.thisComputerDetail}
              </span>
            </>
          }
        />
        <ChoiceField
          layout="row"
          kind="radio"
          checked={value === 'cloud'}
          disabled={
            disabled ||
            (value !== 'cloud' && cloudUnavailableReason !== undefined)
          }
          onChange={(): void => choose('cloud')}
          data-testid="workflow-schedule-run-on-cloud"
          label={
            <>
              <span className="block">{SCHEDULE_RUN_ON_COPY.cloud}</span>
              <span className="block text-xs fg-secondary">
                {value !== 'cloud' && cloudUnavailableReason !== undefined
                  ? cloudUnavailableReason
                  : SCHEDULE_RUN_ON_COPY.cloudDetail}
              </span>
            </>
          }
        />
      </ChoiceList>
      {busy ? (
        <p
          role="status"
          className="text-xs fg-tertiary"
          data-testid="workflow-schedule-run-on-moving"
        >
          {SCHEDULE_RUN_ON_COPY.moving}
        </p>
      ) : null}
      {blockedReason !== undefined ? (
        <p
          className="text-xs fg-tertiary"
          data-testid="workflow-schedule-run-on-blocked"
        >
          {blockedReason}
        </p>
      ) : null}
      {placePick !== undefined ? (
        <div
          className="flex flex-col gap-2"
          data-testid="workflow-schedule-run-on-place"
        >
          <p className="text-xs fg-secondary">{placePick.message}</p>
          <span id={placeLabelId} className="sr-only">
            {SCHEDULE_RUN_ON_COPY.choosePlace}
          </span>
          <Select
            options={placePick.options}
            value={placePick.value}
            onValueChange={placePick.onChange}
            placeholder={SCHEDULE_RUN_ON_COPY.choosePlaceholder}
            disabled={busy}
            required
            aria-labelledby={placeLabelId}
            data-testid="workflow-schedule-run-on-place-select"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="compact"
              disabled={
                busy || blockedReason !== undefined || placePick.value === null
              }
              onClick={placePick.onConfirm}
              data-testid="workflow-schedule-run-on-place-move"
            >
              {SCHEDULE_RUN_ON_COPY.move}
            </Button>
            <Button
              variant="ghost"
              size="compact"
              disabled={busy}
              onClick={placePick.onCancel}
              data-testid="workflow-schedule-run-on-place-cancel"
            >
              {SCHEDULE_RUN_ON_COPY.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      {onFinish !== undefined ? (
        <Notice
          intent="neutral"
          title={SCHEDULE_RUN_ON_COPY.finishingTitle}
          data-testid="workflow-schedule-run-on-finishing"
          actions={
            <NoticeButton type="button" disabled={busy} onClick={onFinish}>
              {SCHEDULE_RUN_ON_COPY.finish}
            </NoticeButton>
          }
        >
          {SCHEDULE_RUN_ON_COPY.finishing}
        </Notice>
      ) : null}
      {error ? (
        <FieldError
          id="workflow-schedule-run-on-error"
          announce
          data-testid="workflow-schedule-run-on-error"
        >
          {error}
        </FieldError>
      ) : null}
    </div>
  );
}

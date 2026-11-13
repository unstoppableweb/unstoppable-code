'use client';

import { useMemo, useState, type JSX } from 'react';
import {
  Stack,
  Button,
  Checkbox,
  FormField,
  Select,
  Surface,
  TextArea,
  TextInput,
} from '@canopy/ui-shared/components';
import type { PipelineRunPauseResponse } from './PipelineRunRows';
import type {
  PipelineRunDetailPauseCheckpoint,
  PipelineRunDetailPauseField,
} from './PipelineRunDetailModel';
import { pipelinePauseInputHeading } from './pipeline-pause-input-heading';

export type PipelineRunPauseScalar = string | number | boolean;

type PauseAnswers = Record<string, Record<string, PipelineRunPauseScalar>>;

export function defaultPauseAnswer(
  field: PipelineRunDetailPauseField,
): PipelineRunPauseScalar {
  if (field.default !== undefined) return field.default;
  if (field.type === 'boolean') return false;
  if (field.type === 'choice') {
    return field.required ? (field.options?.[0] ?? '') : '';
  }
  if (field.type === 'number') return field.required ? (field.min ?? 0) : '';
  return '';
}

export function pauseAnswerError(
  field: PipelineRunDetailPauseField,
  value: PipelineRunPauseScalar | undefined,
): string | undefined {
  const missing =
    value === undefined ||
    (typeof value === 'string' && value.trim().length === 0);
  if (missing) return field.required ? `${field.key} is required` : undefined;

  if (field.type === 'boolean') {
    return typeof value === 'boolean'
      ? undefined
      : `${field.key} must be true or false`;
  }
  if (field.type === 'string') {
    return typeof value === 'string' ? undefined : `${field.key} must be text`;
  }
  if (field.type === 'choice') {
    return (field.options ?? []).includes(String(value))
      ? undefined
      : `${field.key} must be one of: ${(field.options ?? []).join(', ')}`;
  }

  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return `${field.key} must be a number`;
  if (field.min !== undefined && field.max !== undefined) {
    return number < field.min || number > field.max
      ? `${field.key} must be between ${field.min} and ${field.max}`
      : undefined;
  }
  if (field.min !== undefined && number < field.min) {
    return `${field.key} must be at least ${field.min}`;
  }
  if (field.max !== undefined && number > field.max) {
    return `${field.key} must be at most ${field.max}`;
  }
  return undefined;
}

export function initialPauseAnswers(
  checkpoints: readonly PipelineRunDetailPauseCheckpoint[],
): PauseAnswers {
  return Object.fromEntries(
    checkpoints.map((checkpoint) => [
      checkpoint.id,
      Object.fromEntries(
        (checkpoint.request?.fields ?? []).map((field) => [
          field.key,
          defaultPauseAnswer(field),
        ]),
      ),
    ]),
  );
}

/** A choice field's options; an optional field can be cleared. */
function choiceOptions(
  field: PipelineRunDetailPauseField,
): { value: string; label: string }[] {
  const options = (field.options ?? []).map((option) => ({
    value: option,
    label: option,
  }));
  return field.required !== true
    ? [{ value: '', label: 'No selection' }, ...options]
    : options;
}

/** The chosen option, or `null` so the select shows its placeholder. */
function choiceValue(
  field: PipelineRunDetailPauseField,
  value: PipelineRunPauseScalar | undefined,
): string | null {
  const chosen = String(value ?? '');
  return choiceOptions(field).some((option) => option.value === chosen)
    ? chosen
    : null;
}

function PipelineRunPauseField({
  field,
  value,
  error,
  onChange,
}: {
  readonly field: PipelineRunDetailPauseField;
  readonly value: PipelineRunPauseScalar | undefined;
  readonly error?: string;
  readonly onChange: (value: PipelineRunPauseScalar) => void;
}): JSX.Element {
  const testId = `portal-pipeline-pause-field-${field.key}`;
  return (
    <FormField label={field.label} error={error}>
      {(control) =>
        field.type === 'boolean' ? (
          <Checkbox
            {...control}
            checked={value === true}
            data-testid={testId}
            onChange={(event): void => onChange(event.target.checked)}
          />
        ) : field.type === 'choice' ? (
          <Select
            {...control}
            value={choiceValue(field, value)}
            data-testid={testId}
            placeholder="No selection"
            options={choiceOptions(field)}
            onValueChange={onChange}
          />
        ) : field.multiline ? (
          <TextArea
            {...control}
            value={String(value ?? '')}
            data-testid={testId}
            onChange={(event): void => onChange(event.target.value)}
          />
        ) : (
          <TextInput
            {...control}
            type={field.type === 'number' ? 'number' : 'text'}
            min={field.min}
            max={field.max}
            value={String(value ?? '')}
            data-testid={testId}
            onChange={(event): void =>
              onChange(
                field.type === 'number'
                  ? event.target.value === ''
                    ? ''
                    : Number(event.target.value)
                  : event.target.value,
              )
            }
          />
        )
      }
    </FormField>
  );
}

export interface PipelineRunPauseFormProps {
  readonly checkpoints: readonly PipelineRunDetailPauseCheckpoint[];
  readonly submitting?: boolean;
  readonly onSubmit: (responses: readonly PipelineRunPauseResponse[]) => void;
}

/**
 * The paused-checkpoint form. Its submit button IS the resume affordance —
 * the detail deliberately suppresses its bare Resume chip while this is
 * showing, because a second control would discard typed answers.
 */
export function PipelineRunPauseForm({
  checkpoints,
  submitting = false,
  onSubmit,
}: PipelineRunPauseFormProps): JSX.Element {
  const [answers, setAnswers] = useState<PauseAnswers>(() =>
    initialPauseAnswers(checkpoints),
  );

  const effectiveAnswers = useMemo(() => {
    const defaults = initialPauseAnswers(checkpoints);
    return Object.fromEntries(
      checkpoints.map((checkpoint) => [
        checkpoint.id,
        { ...defaults[checkpoint.id], ...answers[checkpoint.id] },
      ]),
    );
  }, [answers, checkpoints]);

  const answerErrors = useMemo(
    () =>
      Object.fromEntries(
        checkpoints.map((checkpoint) => [
          checkpoint.id,
          Object.fromEntries(
            (checkpoint.request?.fields ?? []).flatMap((field) => {
              const error = pauseAnswerError(
                field,
                effectiveAnswers[checkpoint.id]?.[field.key],
              );
              return error ? [[field.key, error]] : [];
            }),
          ),
        ]),
      ),
    [checkpoints, effectiveAnswers],
  );

  const canSubmit = checkpoints.every(
    (checkpoint) =>
      checkpoint.request_unavailable_reason === undefined &&
      (checkpoint.kind !== 'input' || checkpoint.request !== undefined) &&
      Object.keys(answerErrors[checkpoint.id] ?? {}).length === 0,
  );

  return (
    // Keeps its own height up to the cap in a column the log fills, so the
    // question and its fields stay readable; the fields scroll past the cap.
    <div className="flex max-h-[40vh] shrink-0 flex-col">
      <Surface
        variant="group"
        size="small"
        padding="compact"
        className="flex min-h-0 flex-col"
        data-testid="pipeline-run-pause-form"
      >
        <p className="text-xs font-semibold fg-warning">
          {pipelinePauseInputHeading(checkpoints.length)}
        </p>
        <div
          className="min-h-0 overflow-y-auto overscroll-contain pr-1"
          data-testid="pipeline-run-pause-fields"
        >
          {checkpoints.map((checkpoint) => (
            <Stack key={checkpoint.id} gap="inline" className="mt-2">
              {checkpoint.request?.title && (
                <p className="text-xs font-medium fg-primary">
                  {checkpoint.request.title}
                </p>
              )}
              {checkpoint.request?.message && (
                <p className="text-xs fg-secondary">
                  {checkpoint.request.message}
                </p>
              )}
              {checkpoint.request_unavailable_reason === 'too_large' && (
                <p className="text-xs fg-secondary">
                  This input request is too large to answer from Remote Control.
                  Resume it in the desktop app.
                </p>
              )}
              {checkpoint.kind === 'input' &&
                checkpoint.request === undefined &&
                checkpoint.request_unavailable_reason === undefined && (
                  <p className="text-xs fg-secondary">
                    This input request is unavailable in Remote Control. Resume
                    it in the desktop app.
                  </p>
                )}
              {(checkpoint.request?.fields ?? []).map((field) => (
                <PipelineRunPauseField
                  key={field.key}
                  field={field}
                  value={effectiveAnswers[checkpoint.id]?.[field.key]}
                  error={answerErrors[checkpoint.id]?.[field.key]}
                  onChange={(value): void =>
                    setAnswers((current) => ({
                      ...current,
                      [checkpoint.id]: {
                        ...current[checkpoint.id],
                        [field.key]: value,
                      },
                    }))
                  }
                />
              ))}
            </Stack>
          ))}
        </div>
        <Button
          type="button"
          variant="primary"
          size="compact"
          className="mt-3"
          data-testid="portal-pipeline-pause-submit"
          disabled={!canSubmit || submitting}
          onClick={(): void =>
            onSubmit(
              checkpoints.map((checkpoint) => ({
                checkpoint_id: checkpoint.id,
                job_id: checkpoint.job_id,
                step_id: checkpoint.step_id,
                ...(checkpoint.request
                  ? { answers: effectiveAnswers[checkpoint.id] ?? {} }
                  : {}),
              })),
            )
          }
        >
          {submitting
            ? 'Resuming…'
            : checkpoints.some((checkpoint) => checkpoint.request)
              ? 'Submit responses'
              : 'Resume'}
        </Button>
      </Surface>
    </div>
  );
}

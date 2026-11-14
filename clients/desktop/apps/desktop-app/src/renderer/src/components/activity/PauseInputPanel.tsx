import { Stack } from '@canopy/ui-shared/components';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  ExecutionState,
  PauseInputField,
  PipelinePauseCheckpoint,
  PipelinePauseResponse,
  PipelineScalar,
} from '@canopy/execution-engine/types/pipeline';
import {
  validatePauseInputAnswerErrors,
  type PauseInputAnswerError,
} from '@canopy/execution-engine/pipelines/pause-input-validation';
import {
  ChoiceField,
  ErrorBanner,
  FormField,
  Select,
  Surface,
  TextArea,
  TextInput,
} from '@canopy/ui-shared/components';
import { InputIcon } from '@canopy/ui-shared/icons';
import { pipelinePauseInputHeading } from '@canopy/ui-app';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  revalidatePauseDrafts,
  useRetainedSessionValue,
  useSessionWriter,
} from './details/pipelineDetailSession';
import { Button } from '@canopy/ui-shared/components';

interface PauseInputPanelProps {
  executionId: string;
  state: ExecutionState;
  /**
   * Prefix that keeps this panel's field ids unique when several pipeline
   * details are open at once. Defaults to a per-instance React id.
   */
  idScope?: string;
}

function defaultFor(field: PauseInputField): PipelineScalar {
  if (field.default !== undefined) {
    return field.default;
  }
  if (field.type === 'boolean') {
    return false;
  }
  if (field.type === 'choice') {
    return field.required ? (field.options?.[0] ?? '') : '';
  }
  if (field.type === 'number') {
    return field.required ? (field.min ?? 0) : '';
  }
  return '';
}

function initialAnswers(
  fields: PauseInputField[],
): Record<string, PipelineScalar> {
  const answers: Record<string, PipelineScalar> = {};
  for (const field of fields) {
    answers[field.key] = defaultFor(field);
  }
  return answers;
}

function errorsForField(
  errors: PauseInputAnswerError[],
  fieldKey: string,
): string[] {
  return errors
    .filter((error) => error.field === fieldKey)
    .map((error) => error.message);
}

export function PauseInputPanel({
  executionId,
  state,
  idScope,
}: PauseInputPanelProps): JSX.Element {
  const instanceId = useId();
  const fieldIdPrefix = `pause-input-${idScope ?? instanceId}`;
  const resumeExecution = usePipelineRunsStore((s) => s.resumeExecution);
  const checkpoints = state.pending_pauses;
  const [selectedId, setSelectedId] = useState(checkpoints[0]?.id ?? '');
  // A panel keeps unsent answers across remounts. They are revalidated
  // against the checkpoints pending now: answers for a resumed checkpoint or
  // a field the request no longer asks for are dropped, never submitted.
  const retainedDrafts = useRetainedSessionValue(
    (session) => session.pauseDrafts[executionId],
  );
  const writeSession = useSessionWriter();
  const [drafts, setDraftsState] = useState<
    Record<string, Record<string, PipelineScalar>>
  >(() => {
    const retained = revalidatePauseDrafts(retainedDrafts, checkpoints);
    return Object.fromEntries(
      checkpoints.map((checkpoint) => [
        checkpoint.id,
        {
          ...initialAnswers(checkpoint.request?.fields ?? []),
          ...retained[checkpoint.id],
        },
      ]),
    );
  });
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const setDrafts = useCallback(
    (
      update: (
        current: Record<string, Record<string, PipelineScalar>>,
      ) => Record<string, Record<string, PipelineScalar>>,
    ): void => {
      const next = update(draftsRef.current);
      draftsRef.current = next;
      setDraftsState(next);
      writeSession((previous) => ({
        ...previous,
        pauseDrafts: { ...previous.pauseDrafts, [executionId]: next },
      }));
    },
    [executionId, writeSession],
  );
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // Field errors show only after a submit attempt, keyed
  // `${checkpointId}:${fieldKey}`, and each clears when its field is edited.
  const [shownErrors, setShownErrors] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    setDrafts((current) =>
      Object.fromEntries(
        checkpoints.map((checkpoint) => [
          checkpoint.id,
          current[checkpoint.id] ??
            initialAnswers(checkpoint.request?.fields ?? []),
        ]),
      ),
    );
    if (!checkpoints.some((checkpoint) => checkpoint.id === selectedId)) {
      setSelectedId(checkpoints[0]?.id ?? '');
    }
  }, [checkpoints, selectedId, setDrafts]);

  const selected =
    checkpoints.find((checkpoint) => checkpoint.id === selectedId) ??
    checkpoints[0];
  const request = selected?.request;
  const answers = useMemo(
    () => (selected ? (drafts[selected.id] ?? {}) : {}),
    [drafts, selected],
  );

  const errors = useMemo(
    () => (request ? validatePauseInputAnswerErrors(request, answers) : []),
    [answers, request],
  );
  const setAnswer = (key: string, value: PipelineScalar): void => {
    if (!selected) return;
    const shownKey = `${selected.id}:${key}`;
    if (shownErrors.has(shownKey)) {
      setShownErrors((current) => {
        const next = new Set(current);
        next.delete(shownKey);
        return next;
      });
    }
    setDrafts((current) => ({
      ...current,
      [selected.id]: { ...current[selected.id], [key]: value },
    }));
  };

  /**
   * Shows the field errors of `targets` and reports whether any exist, so a
   * submit with missing or invalid answers stops and says why.
   */
  const revealErrors = (targets: PipelinePauseCheckpoint[]): boolean => {
    const invalid: string[] = [];
    let firstInvalid: string | undefined;
    for (const checkpoint of targets) {
      if (!checkpoint.request) continue;
      for (const error of validatePauseInputAnswerErrors(
        checkpoint.request,
        drafts[checkpoint.id] ?? {},
      )) {
        invalid.push(`${checkpoint.id}:${error.field}`);
        firstInvalid ??= checkpoint.id;
      }
    }
    if (invalid.length === 0) return false;
    setShownErrors(new Set(invalid));
    if (firstInvalid !== undefined && firstInvalid !== selected?.id) {
      setSelectedId(firstInvalid);
    }
    return true;
  };

  const responseFor = (
    checkpoint: PipelinePauseCheckpoint,
  ): PipelinePauseResponse => ({
    checkpoint_id: checkpoint.id,
    job_id: checkpoint.job_id,
    step_id: checkpoint.step_id,
    ...(checkpoint.request ? { answers: drafts[checkpoint.id] ?? {} } : {}),
  });

  const submit = async (responses: PipelinePauseResponse[]): Promise<void> => {
    if (submitting) return;

    // Answer only checkpoints that are still waiting. A view restored or
    // revealed from an older snapshot must not answer a request the run has
    // already moved past.
    const live = usePipelineRunsStore.getState().statesById[executionId];
    const pendingIds =
      live === undefined
        ? null
        : new Set(live.pending_pauses.map((checkpoint) => checkpoint.id));
    const current =
      pendingIds === null
        ? responses
        : responses.filter(
            (response) =>
              response.checkpoint_id === undefined ||
              pendingIds.has(response.checkpoint_id),
          );
    if (current.length === 0) {
      setServerError('This request is no longer waiting for input.');
      return;
    }

    setSubmitting(true);
    setServerError(null);
    try {
      const result = await resumeExecution(executionId, {
        pauseResponses: current,
      });
      if (!result.success) {
        setServerError(result.error ?? 'Failed to resume execution');
      }
    } catch (err) {
      setServerError(
        err instanceof Error ? err.message : 'Failed to resume execution',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!selected) return <></>;
  const definition = state.job_definitions[selected.job_id];
  const matrixLabel = definition?.matrix
    ? ` (${Object.entries(definition.matrix.values)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(', ')})`
    : '';

  return (
    <Surface variant="group" padding="default" data-testid="pause-input-panel">
      <Stack gap="group">
        <Stack gap="item">
          <Stack gap="group">
            <Stack gap="inline">
              <Stack gap="item">
                <Stack gap="tight">
                  <div className="flex items-center gap-2 fg-warning">
                    <InputIcon
                      size="sm"
                      className="shrink-0"
                      aria-hidden="true"
                    />
                    <span className="text-s font-semibold">
                      {pipelinePauseInputHeading(checkpoints.length)}
                    </span>
                  </div>
                  {checkpoints.length > 1 ? (
                    <p className="text-s fg-secondary">
                      {checkpoints.length} jobs are waiting for input. Submit
                      one response or complete all requests and resume them
                      together.
                    </p>
                  ) : null}
                </Stack>
                {checkpoints.length > 1 ? (
                  <div className="flex flex-col gap-1 text-xs fg-secondary">
                    <span id={`${instanceId}-waiting-job`}>Waiting job</span>
                    <Select
                      data-testid="pause-input-selector"
                      aria-labelledby={`${instanceId}-waiting-job`}
                      disabled={submitting}
                      value={selected.id}
                      onValueChange={setSelectedId}
                      options={checkpoints.map((checkpoint, index) => {
                        const job = state.job_definitions[checkpoint.job_id];
                        const matrix = job?.matrix
                          ? ` (${Object.entries(job.matrix.values)
                              .map(
                                ([key, value]) =>
                                  `${key}=${JSON.stringify(value)}`,
                              )
                              .join(', ')})`
                          : '';
                        return {
                          value: checkpoint.id,
                          label: `${job?.name ?? checkpoint.logical_job_id}${matrix} — Request ${index + 1} of ${checkpoints.length}`,
                        };
                      })}
                    />
                  </div>
                ) : null}
              </Stack>
              <Stack gap={request?.title ? 'inline' : 'tight'}>
                <div className="text-xs fg-secondary">
                  {definition?.name ?? selected.logical_job_id}
                  {matrixLabel}
                </div>
                <Stack gap="tight">
                  {request?.title ? (
                    <div className="text-s font-medium fg-primary">
                      {request.title}
                    </div>
                  ) : null}
                  <p className="whitespace-pre-wrap text-s fg-secondary">
                    {request?.message ??
                      (request
                        ? 'This run is paused and waiting for input.'
                        : 'This job is paused and ready to continue.')}
                  </p>
                </Stack>
              </Stack>
            </Stack>
            {request ? (
              // The answers are blocked from session replay; the request itself,
              // the job, and the actions stay recorded.
              <div
                className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex flex-col gap-3`}
              >
                {request.fields.map((field) => (
                  <PauseField
                    key={field.key}
                    field={field}
                    value={answers[field.key]}
                    errors={
                      shownErrors.has(`${selected.id}:${field.key}`)
                        ? errorsForField(errors, field.key)
                        : []
                    }
                    onChange={(value) => setAnswer(field.key, value)}
                    disabled={submitting}
                    inputId={`${fieldIdPrefix}-${field.key}`}
                  />
                ))}
              </div>
            ) : null}
          </Stack>
          {serverError ? (
            <ErrorBanner
              errorSource="pause-input-panel-server"
              error={serverError}
              className=""
            />
          ) : null}
        </Stack>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            data-testid="pause-input-resume"
            disabled={submitting}
            onClick={() => {
              if (revealErrors([selected])) return;
              void submit([responseFor(selected)]);
            }}
          >
            {submitting
              ? 'Resuming…'
              : request
                ? 'Submit response'
                : 'Resume job'}
          </Button>
          {checkpoints.length > 1 ? (
            <Button
              data-testid="pause-input-submit-all"
              disabled={submitting}
              onClick={() => {
                if (revealErrors(checkpoints)) return;
                void submit(
                  checkpoints.map((checkpoint) => responseFor(checkpoint)),
                );
              }}
            >
              {submitting ? 'Resuming…' : 'Submit all responses'}
            </Button>
          ) : null}
        </div>
      </Stack>
    </Surface>
  );
}

interface PauseFieldProps {
  field: PauseInputField;
  value: PipelineScalar;
  errors: string[];
  onChange: (value: PipelineScalar) => void;
  disabled: boolean;
  inputId: string;
}

/** A choice field's options; an optional field without a default can be cleared. */
function choiceOptions(
  field: PauseInputField,
): { value: string; label: string }[] {
  const options = (field.options ?? []).map((option) => ({
    value: option,
    label: option,
  }));
  return !field.required && field.default === undefined
    ? [{ value: '', label: 'No selection' }, ...options]
    : options;
}

/** The chosen option, or `null` so the select shows its placeholder. */
function choiceValue(
  field: PauseInputField,
  value: PipelineScalar,
): string | null {
  const chosen = String(value);
  return choiceOptions(field).some((option) => option.value === chosen)
    ? chosen
    : null;
}

function PauseField({
  field,
  value,
  errors,
  onChange,
  disabled,
  inputId,
}: PauseFieldProps): JSX.Element {
  return (
    <FormField
      id={inputId}
      label={field.label}
      labelMeta={
        field.required ? (
          <span className="text-3xs font-medium fg-warning">Required</span>
        ) : null
      }
      description={field.description}
      error={errors.length > 0 ? errors.join(' ') : undefined}
    >
      {(control) =>
        field.type === 'choice' ? (
          <Select
            {...control}
            data-testid={`pause-field-${field.key}`}
            disabled={disabled}
            value={choiceValue(field, value)}
            onValueChange={onChange}
            placeholder="No selection"
            options={choiceOptions(field)}
          />
        ) : field.type === 'boolean' ? (
          <ChoiceField
            {...control}
            data-testid={`pause-field-${field.key}`}
            disabled={disabled}
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
            label={value === true ? 'Yes' : 'No'}
          />
        ) : field.type === 'number' ? (
          <TextInput
            {...control}
            data-testid={`pause-field-${field.key}`}
            type="number"
            disabled={disabled}
            min={field.min}
            max={field.max}
            value={String(value)}
            onChange={(event) => {
              const next = event.target.value;
              onChange(next === '' ? '' : Number(next));
            }}
          />
        ) : field.multiline ? (
          <TextArea
            {...control}
            data-testid={`pause-field-${field.key}`}
            disabled={disabled}
            rows={3}
            value={String(value)}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <TextInput
            {...control}
            data-testid={`pause-field-${field.key}`}
            disabled={disabled}
            value={String(value)}
            onChange={(event) => onChange(event.target.value)}
          />
        )
      }
    </FormField>
  );
}

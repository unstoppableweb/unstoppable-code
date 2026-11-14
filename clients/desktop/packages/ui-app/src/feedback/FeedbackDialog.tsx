'use client';

import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  FeedbackReferenceIdSchema,
  MAX_FEEDBACK_DESCRIPTION_LENGTH,
  MAX_FEEDBACK_TITLE_LENGTH,
  type FeedbackReportResult,
} from '@canopy/protocol/feedback-report';
import {
  Surface,
  Button,
  CopyButton,
  DialogFormField,
  LoadingSpinner,
  SegmentedControl,
  TextArea,
  TextInput,
  Notice,
} from '@canopy/ui-shared/components';

import { FeedbackDialogShell } from './FeedbackDialogShell';
import { FeedbackSubmissionHeldError } from './feedback-submission-held-error';

export { FeedbackSubmissionHeldError } from './feedback-submission-held-error';

/**
 * The feedback form `FeedbackReportDialog` renders on desktop and web. The form
 * owns type, description, optional title, submitting/error/success state and
 * the footer; its host owns submission and may add an attachments block and
 * error-time actions.
 */
export type FeedbackDialogReportType = 'bug' | 'idea';

export interface FeedbackDialogSubmission {
  readonly type: FeedbackDialogReportType;
  readonly description: string;
  readonly title?: string;
}

export interface FeedbackDialogProps {
  readonly appName: string;
  /**
   * `error` reports a failure the person just hit: the type is fixed to bug,
   * and the only question is what they were trying to do.
   */
  readonly mode?: 'feedback' | 'error';
  /** Resolving means the report was filed; its reference ID shows after. */
  readonly onSubmit: (
    submission: FeedbackDialogSubmission,
  ) => Promise<FeedbackReportResult | void>;
  readonly onClose: () => void;
  /** Blocks Submit while the host waits on an explicit choice in its block. */
  readonly submitBlocked?: boolean;
  /** A host note under the confirmation (diagnostics delivery). */
  readonly successDetail?: ReactNode;
  /** Host block explaining what else is sent (desktop: context + diagnostics). */
  readonly attachments?: ReactNode;
  /** Host actions rendered inside the error notice (desktop: save diagnostics). */
  readonly errorActions?: ReactNode;
  /** A host note under the form body (desktop: "Saved … to Downloads"). */
  readonly note?: ReactNode;
  /** Lets a host learn what the user typed (desktop's diagnostics fallback). */
  readonly onDescriptionChange?: (description: string) => void;
  /** The current fields, for inspection/export before submission. */
  readonly onDraftChange?: (draft: FeedbackDialogSubmission) => void;
  /**
   * Seeds the report type. Defaults to `idea` (CAN-2682: a suggestion should
   * not have to correct a bug-first form). Hosts opening this FROM a failure
   * the user just hit pass `bug`, because there the assumption is correct.
   */
  readonly initialReportType?: FeedbackDialogReportType;
  /** The window to draw in, when it isn't the one this code loaded in. */
  readonly ownerDocument?: Document | undefined;
}

const SUBMIT_ERROR_FALLBACK =
  'Could not submit your feedback. Please try again.';

const REPORT_TYPE_OPTIONS: ReadonlyArray<{
  value: FeedbackDialogReportType;
  label: string;
}> = [
  { value: 'idea', label: 'Idea' },
  { value: 'bug', label: 'Bug' },
];

const FIELD_LABEL_CLASSNAME = 'block text-xs font-medium fg-secondary';

function descriptionPlaceholder(type: FeedbackDialogReportType): string {
  return type === 'bug'
    ? 'What happened, what you expected, and how to reproduce it'
    : 'What you would like to see, and what it would help you do';
}

export function FeedbackDialog({
  appName,
  mode = 'feedback',
  onSubmit,
  onClose,
  submitBlocked = false,
  successDetail,
  attachments,
  errorActions,
  note,
  onDescriptionChange,
  onDraftChange,
  initialReportType,
  ownerDocument,
}: FeedbackDialogProps): JSX.Element {
  const errorMode = mode === 'error';
  const [type, setType] = useState<FeedbackDialogReportType>(
    errorMode ? 'bug' : (initialReportType ?? 'idea'),
  );
  const [description, setDescription] = useState('');
  const [title, setTitle] = useState('');
  useEffect(() => {
    onDraftChange?.({
      type,
      description: description.trim(),
      ...(title.trim() ? { title: title.trim() } : {}),
    });
  }, [type, description, title, onDraftChange]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A second click can land before `submitting` renders.
  const submitInFlight = useRef(false);
  const canSubmit =
    description.trim().length > 0 && !submitting && !submitBlocked;

  async function handleSubmit(): Promise<void> {
    if (!canSubmit || submitInFlight.current) return;
    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    if (trimmedDescription.length > MAX_FEEDBACK_DESCRIPTION_LENGTH) {
      setError(
        `Keep this under ${MAX_FEEDBACK_DESCRIPTION_LENGTH.toLocaleString('en-US')} characters.`,
      );
      return;
    }
    if (trimmedTitle.length > MAX_FEEDBACK_TITLE_LENGTH) {
      setError(
        `Keep the title under ${MAX_FEEDBACK_TITLE_LENGTH.toLocaleString('en-US')} characters.`,
      );
      return;
    }
    submitInFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit({
        type,
        description: trimmedDescription,
        ...(trimmedTitle.length > 0 ? { title: trimmedTitle } : {}),
      });
      // An older server may acknowledge without one; never invent an ID.
      const reference = FeedbackReferenceIdSchema.safeParse(
        result ? result.referenceId : undefined,
      );
      setReferenceId(reference.success ? reference.data : null);
      setSubmitted(true);
    } catch (err: unknown) {
      if (!(err instanceof FeedbackSubmissionHeldError)) {
        setError(
          err instanceof Error && err.message.length > 0
            ? err.message
            : SUBMIT_ERROR_FALLBACK,
        );
      }
    } finally {
      submitInFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <FeedbackDialogShell
      appName={appName}
      errorMode={errorMode}
      onClose={onClose}
      ownerDocument={ownerDocument}
    >
      {submitted ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
            <p
              className="text-s fg-primary"
              data-testid="feedback-modal-success"
            >
              Thanks — your {errorMode ? 'report' : 'feedback'} is with the{' '}
              {appName} team.
            </p>
            {referenceId !== null && (
              <div
                className="flex items-center gap-2 text-xs fg-secondary"
                data-testid="feedback-modal-reference"
              >
                <span>Reference</span>
                <span className="font-mono" data-selectable>
                  {referenceId}
                </span>
                <CopyButton
                  value={referenceId}
                  ariaLabel="Copy reference"
                  title="Copy reference"
                  dataTestId="feedback-modal-reference-copy"
                />
              </div>
            )}
            {successDetail}
          </div>
          <Surface
            variant="section"
            boundary="top"
            padding="dialog-footer"
            className="flex items-center justify-end"
            data-testid="feedback-modal-success-footer"
          >
            <Button
              type="button"
              variant="primary"
              size="compact"
              onClick={onClose}
              data-testid="feedback-modal-done"
            >
              Done
            </Button>
          </Surface>
        </>
      ) : (
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event): void => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <div
            className="grid grid-cols-1 content-start min-h-0 flex-1 overflow-y-auto px-6 py-4 gap-4"
            data-testid="feedback-modal-body"
          >
            {errorMode ? null : (
              <div className="flex flex-col gap-1.5">
                <span className={FIELD_LABEL_CLASSNAME}>Type</span>
                <SegmentedControl
                  label="Feedback type"
                  shape="capsule"
                  width="content"
                  value={type}
                  options={REPORT_TYPE_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                    dataTestId: `feedback-modal-type-${option.value}`,
                  }))}
                  onChange={setType}
                />
              </div>
            )}

            <DialogFormField
              label={errorMode ? 'What were you trying to do?' : 'Description'}
              htmlFor="feedback-modal-description"
              {...(errorMode
                ? { description: 'Needed to send the report.' }
                : {})}
            >
              <TextArea
                id="feedback-modal-description"
                data-testid="feedback-modal-description"
                value={description}
                onChange={(event): void => {
                  setDescription(event.target.value);
                  onDescriptionChange?.(event.target.value);
                  setError(null);
                }}
                {...(errorMode
                  ? {}
                  : { placeholder: descriptionPlaceholder(type) })}
                rows={5}
              />
            </DialogFormField>

            {errorMode ? null : (
              <DialogFormField
                label="Title (optional)"
                htmlFor="feedback-modal-title"
              >
                <TextInput
                  id="feedback-modal-title"
                  type="text"
                  data-testid="feedback-modal-title"
                  value={title}
                  onChange={(event): void => setTitle(event.target.value)}
                  placeholder="Summarized from your description if left blank"
                />
              </DialogFormField>
            )}

            {attachments}

            {error !== null && (
              <Notice
                errorSource="feedback-modal-error"
                intent="destructive"
                data-testid="feedback-modal-error"
                actions={errorActions}
              >
                {error}
              </Notice>
            )}

            {note}
          </div>

          <div
            className="flex items-center justify-end gap-3 border-t px-6 py-3"
            data-testid="feedback-modal-footer"
          >
            <Button
              type="button"
              size="compact"
              onClick={onClose}
              data-testid="feedback-modal-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="compact"
              disabled={!canSubmit}
              data-testid="feedback-modal-submit"
            >
              {submitting ? (
                <>
                  <LoadingSpinner tone="emphasis" />
                  <span>Submitting…</span>
                </>
              ) : (
                <span>Submit</span>
              )}
            </Button>
          </div>
        </form>
      )}
    </FeedbackDialogShell>
  );
}

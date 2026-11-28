'use client';

import { useId, useRef, useState, type JSX } from 'react';
import type { SharedArtifactsClient } from '@canopy/app-core';
import {
  MAX_SHARED_ARTIFACT_REPORT_DETAIL_LENGTH,
  SHARED_ARTIFACT_REPORT_REASONS,
  type SharedArtifactReportReason,
} from '@canopy/protocol/shared-artifacts';
import { Button, ErrorBanner, Stack } from '@canopy/ui-shared/components';
import {
  ChoiceField,
  ChoiceList,
  DialogModal,
  FormField,
  TextArea,
} from '@canopy/ui-shared/primitives';
import {
  SHARED_ARTIFACT_COPY,
  SHARED_ARTIFACT_REPORT_REASON_LABELS,
} from './shared-artifact-copy';
import { newSharedArtifactIdempotencyKey } from './shared-artifact-view-model';

type ReportStatus = 'editing' | 'submitting' | 'sent' | 'failed';

/**
 * Report an artifact: one reason, optional detail, then a confirmation. A
 * failure keeps the form. One idempotency key covers retries of the same
 * input; a changed input mints a new one.
 */
export function SharedArtifactReportDialog({
  client,
  artifactId,
  onClose,
}: {
  readonly client: SharedArtifactsClient;
  readonly artifactId: string;
  readonly onClose: () => void;
}): JSX.Element {
  const [reason, setReason] = useState<SharedArtifactReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [status, setStatus] = useState<ReportStatus>('editing');
  const keyRef = useRef<{ input: string; key: string } | null>(null);
  const detailId = useId();
  const detailTooLong =
    detail.length > MAX_SHARED_ARTIFACT_REPORT_DETAIL_LENGTH;
  const submitting = status === 'submitting';

  const submit = async (): Promise<void> => {
    if (reason === null || detailTooLong || submitting) return;
    const trimmed = detail.trim();
    const input = JSON.stringify([reason, trimmed]);
    if (keyRef.current?.input !== input)
      keyRef.current = { input, key: newSharedArtifactIdempotencyKey() };
    setStatus('submitting');
    try {
      await client.report({
        artifactId,
        reason,
        ...(trimmed === '' ? {} : { detail: trimmed }),
        idempotencyKey: keyRef.current.key,
      });
      keyRef.current = null;
      setStatus('sent');
    } catch {
      setStatus('failed');
    }
  };

  if (status === 'sent') {
    return (
      <DialogModal
        title={SHARED_ARTIFACT_COPY.reportTitle}
        onClose={onClose}
        maxWidth="md"
        footer={
          <Button
            type="button"
            variant="primary"
            onClick={onClose}
            data-testid="shared-artifact-report-done"
          >
            {SHARED_ARTIFACT_COPY.reportDone}
          </Button>
        }
      >
        <p
          className="text-s fg-secondary"
          role="status"
          data-testid="shared-artifact-report-sent"
        >
          {SHARED_ARTIFACT_COPY.reportSent}
        </p>
      </DialogModal>
    );
  }

  return (
    <DialogModal
      title={SHARED_ARTIFACT_COPY.reportTitle}
      onClose={onClose}
      maxWidth="md"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      closeButtonDisabled={submitting}
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={submitting}
            loadingLabel={SHARED_ARTIFACT_COPY.reportSubmitting}
            disabled={reason === null || detailTooLong || submitting}
            onClick={(): void => {
              void submit();
            }}
            data-testid="shared-artifact-report-submit"
          >
            {SHARED_ARTIFACT_COPY.reportSubmit}
          </Button>
        </>
      }
    >
      <Stack gap="group" data-testid="shared-artifact-report-dialog">
        <ChoiceList
          kind="radio"
          aria-label={SHARED_ARTIFACT_COPY.reportReasonLabel}
        >
          {SHARED_ARTIFACT_REPORT_REASONS.map((value) => (
            <ChoiceField
              key={value}
              kind="radio"
              layout="row"
              name="shared-artifact-report-reason"
              value={value}
              checked={reason === value}
              disabled={submitting}
              label={SHARED_ARTIFACT_REPORT_REASON_LABELS[value]}
              onChange={(): void => setReason(value)}
              data-testid={`shared-artifact-report-reason-${value}`}
            />
          ))}
        </ChoiceList>
        <FormField
          id={detailId}
          label={SHARED_ARTIFACT_COPY.reportDetailLabel}
          {...(detailTooLong
            ? {
                error: SHARED_ARTIFACT_COPY.reportDetailTooLong(
                  MAX_SHARED_ARTIFACT_REPORT_DETAIL_LENGTH,
                ),
              }
            : {})}
        >
          {(control): JSX.Element => (
            <TextArea
              {...control}
              rows={4}
              value={detail}
              disabled={submitting}
              onChange={(event): void => setDetail(event.target.value)}
              data-testid="shared-artifact-report-detail"
            />
          )}
        </FormField>
        {status === 'failed' && (
          <ErrorBanner
            className=""
            errorSource="shared-artifact-report"
            blockMessageFromReplay={false}
            error={SHARED_ARTIFACT_COPY.reportFailed}
          />
        )}
      </Stack>
    </DialogModal>
  );
}

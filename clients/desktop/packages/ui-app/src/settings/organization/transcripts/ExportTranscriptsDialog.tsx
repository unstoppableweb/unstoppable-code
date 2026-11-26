'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import type { OrgTranscriptExportEstimateResult } from '@canopy/protocol/canopy-core/core';
import {
  ChoiceList,
  ChoiceField,
  DialogModal,
  ErrorBanner,
  Fact,
  FactList,
  InlineMeasuredSkeleton,
  Notice,
  Button,
} from '@canopy/ui-shared/components';
import type { SettingsFailure } from '../../errors';
import { useSettingsClient, useSettingsPrivacy } from '../../host';
import { withPrivacyClass } from '../../account/privacy-class';
import { useTranscriptsErrorCopy } from './transcripts-errors';
import {
  formatCount,
  formatTranscriptBytes,
  formatTranscriptRange,
  sessionCountLabel,
  type TranscriptRange,
} from './transcripts-format';

/** The Sessions filters an export copies. */
export interface TranscriptExportFilters {
  readonly range: TranscriptRange;
  readonly memberUserId: string | null;
  readonly projectId: string | null;
  readonly model: string | null;
}

export interface ExportTranscriptsDialogProps {
  readonly organizationId: string;
  readonly filters: TranscriptExportFilters;
  /** "All members" or the chosen member's name. */
  readonly memberLabel: string;
  /** "All projects" or the chosen project's name. */
  readonly projectLabel: string;
  readonly onClose: () => void;
  /** The export was queued. */
  readonly onStarted: () => void;
}

const ESTIMATE_DEBOUNCE_MS = 300;

type EstimateState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly failure: SettingsFailure }
  | {
      readonly status: 'ready';
      readonly estimate: OrgTranscriptExportEstimateResult;
    };

function filterParams(
  organizationId: string,
  filters: TranscriptExportFilters,
): {
  organizationId: string;
  from: string;
  to: string;
  memberUserId?: string;
  projectId?: string;
  model?: string;
} {
  return {
    organizationId,
    from: filters.range.from,
    to: filters.range.to,
    ...(filters.memberUserId === null
      ? {}
      : { memberUserId: filters.memberUserId }),
    ...(filters.projectId === null ? {} : { projectId: filters.projectId }),
    ...(filters.model === null ? {} : { model: filters.model }),
  };
}

function tooLargeCopy(estimate: OrgTranscriptExportEstimateResult): string {
  if (estimate.sessionCount > estimate.sessionLimit)
    return `This matches ${formatCount(estimate.sessionCount)} sessions. Exports hold up to ${formatCount(estimate.sessionLimit)}, so narrow the date range.`;
  // Under the session cap but over the size cap.
  return `This matches about ${formatTranscriptBytes(estimate.approximateBytes)}. Exports hold up to 1 GB, so narrow the date range.`;
}

function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * "Export transcripts": the Sessions filters as read-only rows, the
 * matching count from `exports.estimate` (read on open and again, debounced,
 * when an extra changes), the two opt-in extras, and Start export, which
 * stays off until the latest estimate returns and fits.
 */
export function ExportTranscriptsDialog({
  organizationId,
  filters,
  memberLabel,
  projectLabel,
  onClose,
  onStarted,
}: ExportTranscriptsDialogProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useTranscriptsErrorCopy();
  const { blockClassName } = useSettingsPrivacy();
  const [includePlans, setIncludePlans] = useState(false);
  const [includeSummaries, setIncludeSummaries] = useState(false);
  const [estimate, setEstimate] = useState<EstimateState>({
    status: 'loading',
  });
  const [estimateAttempt, setEstimateAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startFailure, setStartFailure] = useState<SettingsFailure | null>(
    null,
  );
  // One key per dialog: a retried Start replays the same request.
  const idempotencyKey = useRef(newIdempotencyKey());
  const firstEstimate = useRef(true);

  useEffect(() => {
    let cancelled = false;
    setEstimate({ status: 'loading' });
    const delay = firstEstimate.current ? 0 : ESTIMATE_DEBOUNCE_MS;
    firstEstimate.current = false;
    const timer = setTimeout(() => {
      client
        .read('organization.transcripts.exports.estimate', {
          ...filterParams(organizationId, filters),
          includePlans,
          includeSummaries,
        })
        .then(
          (result) => {
            if (!cancelled) setEstimate({ status: 'ready', estimate: result });
          },
          (error: unknown) => {
            if (!cancelled)
              setEstimate({
                status: 'error',
                failure: errorCopy.loadFailure(error),
              });
          },
        );
    }, delay);
    return (): void => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    client,
    errorCopy,
    organizationId,
    filters,
    includePlans,
    includeSummaries,
    estimateAttempt,
  ]);

  const toggle = (setter: (update: (value: boolean) => boolean) => void) => {
    return (): void => {
      // Other extras are another request: give it its own key.
      idempotencyKey.current = newIdempotencyKey();
      setStartFailure(null);
      setter((value) => !value);
    };
  };

  const start = async (): Promise<void> => {
    setStarting(true);
    setStartFailure(null);
    try {
      await client.write('organization.transcripts.exports.create', {
        ...filterParams(organizationId, filters),
        includePlans,
        includeSummaries,
        idempotencyKey: idempotencyKey.current,
      });
      onStarted();
    } catch (error) {
      setStartFailure(errorCopy.actionFailure(error, 'start the export'));
      setStarting(false);
    }
  };

  const ready = estimate.status === 'ready' ? estimate.estimate : null;
  const canStart = ready !== null && !ready.tooLarge && ready.sessionCount > 0;

  return (
    <DialogModal
      title="Export transcripts"
      dataTestId="transcripts-export-dialog"
      maxWidth="lg"
      trapFocus
      onClose={(): void => {
        if (!starting) onClose();
      }}
      footer={
        <div className="flex justify-end">
          <Button
            variant="primary"
            loading={starting}
            loadingLabel="Starting export…"
            disabled={!canStart || starting}
            onClick={(): void => void start()}
            data-testid="transcripts-export-start"
          >
            Start export
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <p className="text-s text-pretty fg-secondary">
          We&apos;ll put together a ZIP of every matching session and email you
          when it&apos;s ready. It stays available for 7 days.
        </p>
        <FactList dataTestId="transcripts-export-facts">
          <Fact label="Date range">{formatTranscriptRange(filters.range)}</Fact>
          <Fact label="Members">
            <span className={withPrivacyClass('', blockClassName)}>
              {memberLabel}
            </span>
          </Fact>
          <Fact label="Projects">{projectLabel}</Fact>
          <Fact label="Matches" dataTestId="transcripts-export-matches">
            {ready === null ? (
              <InlineMeasuredSkeleton>
                {`${sessionCountLabel(24)}, about ${formatTranscriptBytes(524288)}`}
              </InlineMeasuredSkeleton>
            ) : (
              `${sessionCountLabel(ready.sessionCount)}, about ${formatTranscriptBytes(ready.approximateBytes)}`
            )}
          </Fact>
        </FactList>
        {estimate.status === 'error' ? (
          <ErrorBanner
            errorSource="organization-transcripts-export-estimate"
            error={estimate.failure.copy}
            details={estimate.failure.details}
            onRetry={(): void => setEstimateAttempt((value) => value + 1)}
          />
        ) : null}
        {ready?.tooLarge === true ? (
          <Notice intent="attention" data-testid="transcripts-export-too-large">
            {tooLargeCopy(ready)}
          </Notice>
        ) : null}
        <ChoiceList aria-label="Include in the export">
          <ChoiceField
            layout="row"
            checked={includePlans}
            onChange={toggle(setIncludePlans)}
            disabled={starting}
            data-testid="transcripts-export-include-plans"
            label={
              <>
                <span className="block">Include plans</span>
                <span className="block text-xs fg-secondary">
                  Plans members shared with the organization
                </span>
              </>
            }
          />
          <ChoiceField
            layout="row"
            checked={includeSummaries}
            onChange={toggle(setIncludeSummaries)}
            disabled={starting}
            data-testid="transcripts-export-include-summaries"
            label={
              <>
                <span className="block">Include session summaries</span>
                <span className="block text-xs fg-secondary">
                  Short recaps written for each branch
                </span>
              </>
            }
          />
        </ChoiceList>
        {startFailure !== null ? (
          <ErrorBanner
            errorSource="organization-transcripts-export-start"
            error={startFailure.copy}
            details={startFailure.details}
          />
        ) : null}
      </div>
    </DialogModal>
  );
}

import { repositoryCloneErrorMessage } from '@canopy/protocol/portal';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import {
  Fact,
  FactList,
  RepositoryCloneError,
  StatusLabel,
} from '@canopy/ui-shared/components';
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Button, DialogModal } from '@canopy/ui-shared';
import type { CloneJobSnapshot } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ProgressBar } from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { formatElapsed } from '@/lib/pipelineTiming';
import { announceBackgroundCloneOutcomes } from '@/lib/cloneJobOutcomes';
import {
  backgroundCloneJobs,
  cloneJobHeadline,
  summarizeCloneJobs,
  useCloneJobsStore,
} from '@/stores/cloneJobsStore';

const PHASE_LABELS: Record<CloneJobSnapshot['phase'], string> = {
  starting: 'Connecting to the remote…',
  counting: 'Counting objects',
  compressing: 'Compressing objects',
  receiving: 'Receiving objects',
  resolving: 'Resolving deltas',
  checkout: 'Checking out files',
  finishing: 'Download complete',
};

const numberFormat = new Intl.NumberFormat();

function phaseDetail(job: CloneJobSnapshot): string {
  if (job.status === 'cancelling') return 'Stopping and removing the download…';
  const parts = [PHASE_LABELS[job.phase]];
  if (job.processedCount !== null && job.totalCount !== null)
    parts.push(
      `${numberFormat.format(job.processedCount)} of ${numberFormat.format(job.totalCount)}`,
    );
  else if (job.processedCount !== null)
    parts.push(numberFormat.format(job.processedCount));
  return parts.join(' · ');
}

function transferDetail(job: CloneJobSnapshot): string | null {
  if (!job.received) return null;
  return job.throughput && job.status === 'running'
    ? `${job.received} at ${job.throughput}`
    : `${job.received} received`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return (): void => clearInterval(timer);
  }, [active]);
  return now;
}

interface CloneJobRowProps {
  job: CloneJobSnapshot;
  now: number;
}

function CloneJobRow({ job, now }: CloneJobRowProps): JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<InlineFailure | null>(null);
  // The row action that failed, so Try again repeats it.
  const [failedAction, setFailedAction] = useState<
    (() => Promise<void>) | null
  >(null);
  const failed = job.status === 'failed';
  const finished = job.status === 'succeeded';
  const transfer = transferDetail(job);
  const act = async (
    action: () => Promise<void>,
    kind: 'cancel' | 'dismiss',
  ): Promise<void> => {
    setPending(true);
    setError(null);
    setFailedAction(null);
    try {
      await action();
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError) {
        setError(
          inlineFailure(
            appError,
            kind === 'dismiss'
              ? "Couldn't dismiss this clone."
              : "Couldn't cancel the clone.",
          ),
        );
        setFailedAction(() => (): Promise<void> => act(action, kind));
      }
    } finally {
      setPending(false);
    }
  };
  return (
    <li
      data-testid={`clone-progress-job-${job.id}`}
      className="flex flex-col gap-2 py-3"
    >
      <div className="flex items-center justify-between gap-4 text-s">
        <span className="truncate font-medium fg-primary" title={job.repoName}>
          {failed ? (
            <StatusLabel>{cloneJobHeadline(job)}</StatusLabel>
          ) : (
            cloneJobHeadline(job)
          )}
        </span>
        {!failed && !finished && (
          <span className="shrink-0 fg-secondary">
            {Math.floor(job.percent)}%
          </span>
        )}
      </div>
      {!failed && !finished && (
        <ProgressBar
          value={Math.floor(job.percent)}
          label={`Clone progress for ${job.repoName}`}
          hideLabel
        />
      )}
      {failed ? (
        <div className={POSTHOG_REPLAY_BLOCK_CLASS}>
          <RepositoryCloneError
            message={
              job.error?.includes('Remove it manually.')
                ? job.error
                : repositoryCloneErrorMessage(job.error)
            }
          />
        </div>
      ) : finished ? (
        <p className="text-xs fg-secondary">Project added.</p>
      ) : (
        <p className="text-xs fg-secondary">
          {phaseDetail(job)}
          {transfer ? ` · ${transfer}` : ''}
          {` · ${formatElapsed(Math.max(0, now - job.startedAt))} elapsed`}
        </p>
      )}
      <FactList columnGap="3" rowGap="0.5" labelTone="secondary">
        <Fact label="From" fit="truncate" title={job.remoteUrl}>
          {job.remoteUrl}
        </Fact>
        {job.destinationPath && (
          <>
            <Fact label="To" fit="truncate" title={job.destinationPath}>
              {job.destinationPath}
            </Fact>
          </>
        )}
      </FactList>
      <DesktopErrorBanner
        errorSource="clone-job-row"
        className=""
        error={error?.error}
        details={error?.details}
        retrying={pending}
        {...(failedAction ? { onRetry: () => void failedAction() } : {})}
        onDismiss={() => {
          setError(null);
          setFailedAction(null);
        }}
      />
      {(job.cancellable || failed || finished) && (
        <div className="flex justify-end">
          {failed || finished ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              data-testid={`clone-progress-dismiss-${job.id}`}
              onClick={() => {
                void act(() => window.api.dismissCloneJob(job.id), 'dismiss');
              }}
            >
              Dismiss
            </Button>
          ) : (
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              data-testid={`clone-progress-cancel-${job.id}`}
              onClick={() => {
                void act(() => window.api.cancelCloneJob(job.id), 'cancel');
              }}
            >
              {pending ? 'Cancelling…' : 'Cancel clone'}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Progress dialog for Add project clones handed to the sidebar. Always
 * mounted in the main window: it also mirrors main's clone jobs into the
 * store and announces background outcomes while the dialog is closed.
 */
export function CloneProgressModal(): JSX.Element | null {
  const jobs = useCloneJobsStore((state) => state.jobs);
  const isOpen = useCloneJobsStore((state) => state.isOpen);
  const close = useCloneJobsStore((state) => state.close);
  const visible = useMemo(() => backgroundCloneJobs(jobs), [jobs]);
  const summary = useMemo(() => summarizeCloneJobs(jobs), [jobs]);
  const open = isOpen && visible.length > 0;
  const now = useNow(
    open &&
      visible.some(
        (job) => job.status === 'running' || job.status === 'cancelling',
      ),
  );

  useCurrentUiStateReporter('projects.cloneProgressModal', {
    open,
    running: summary?.running ?? 0,
    failed: summary?.failed ?? 0,
    percent: summary?.percent ?? 0,
  });

  useEffect(() => {
    let disposed = false;
    const { apply, hydrate } = useCloneJobsStore.getState();
    const unsubscribe = window.api.onCloneJobsChanged((next): void => {
      apply(next);
      announceBackgroundCloneOutcomes(next);
    });
    void window.api
      .listCloneJobs()
      .then((initial): void => {
        if (disposed) return;
        hydrate(initial);
        announceBackgroundCloneOutcomes(initial);
      })
      .catch((error: unknown): void => {
        // The subscription above still delivers every later change.
        reportClientAppError(error);
      });
    return (): void => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  if (!open) return null;
  return (
    <DialogModal
      inset="flush"
      title="Clone progress"
      onClose={close}
      maxWidth="lg"
      subtitle={
        summary && summary.running > 0
          ? 'You can close this window. Cloning continues in the background.'
          : undefined
      }
    >
      <div data-testid="clone-progress-modal" className="flex flex-col">
        <ol
          aria-label="Clones"
          aria-live="polite"
          className="max-h-[55vh] overflow-y-auto px-6 py-1"
        >
          {visible.map((job) => (
            <CloneJobRow key={job.id} job={job} now={now} />
          ))}
        </ol>
        <div className="flex justify-end px-6 py-4">
          <Button
            size="sm"
            variant="secondary"
            onClick={close}
            data-testid="clone-progress-close"
          >
            Close
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}

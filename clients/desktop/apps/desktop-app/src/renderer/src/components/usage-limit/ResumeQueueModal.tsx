import { useEffect, useRef, useState, type JSX } from 'react';
import {
  Button,
  DialogModal,
  getModelCatalogProviderLabel,
  InterruptedSessionRow,
} from '@canopy/ui-shared';
import {
  ErrorBanner,
  StatusGlyph,
  StatusLabel,
  Surface,
} from '@canopy/ui-shared/components';
import { ChevronRightIcon } from '@canopy/ui-shared/icons/AppIcons';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useShallow } from 'zustand/shallow';
import type {
  ResumeQueueControl,
  ResumeQueueEntry,
} from '@canopy/desktop-shared/types';
import {
  useResumeQueueStore,
  resumeQueueEntryGlyphState,
  resumeQueueProgress,
  resumeQueueStatusGlyphState,
  resumeQueueStatusLabel,
} from '@/stores/resumeQueueStore';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { ProgressBar } from '@canopy/ui-shared/components';
import {
  openResumeQueueEntry,
  resumeQueueEntryDestinationLabel,
  soleResumedChatEntry,
} from '@/lib/usage-limit/open-resumed-session';

const labels: Record<ResumeQueueEntry['status'], string> = {
  waiting: 'Waiting',
  resuming: 'Resuming…',
  resumed: 'Resumed',
  skipped: 'No longer interrupted',
  failed: 'Needs attention',
  stopped: 'Stopped',
};

type PendingAction = 'control' | 'navigation' | null;

// A lone entry gets a sentence about its own handoff instead of batch counts.
// The queue records handoffs, not live turns, so a resumed entry has started,
// not finished.
function singleEntrySentence(
  entry: ResumeQueueEntry,
  held: boolean,
): string | null {
  const noun = entry.target.kind === 'pipeline' ? 'workflow' : 'chat';
  if (entry.status === 'resumed')
    return `Your ${noun} has started again. Open it to follow along.`;
  if (held) return null;
  if (entry.status === 'waiting') return `Your ${noun} is waiting to start.`;
  if (entry.status === 'resuming') return `Starting your ${noun} now.`;
  return null;
}

export function ResumeQueueModal(): JSX.Element | null {
  const {
    snapshot,
    isOpen,
    close,
    apply,
    dismiss,
    connectionError,
    navigationError,
    openWithNavigationError,
    clearNavigationError,
  } = useResumeQueueStore(
    useShallow((state) => ({
      snapshot: state.snapshot,
      isOpen: state.isOpen,
      close: state.close,
      apply: state.apply,
      dismiss: state.dismiss,
      connectionError: state.connectionError,
      navigationError: state.navigationError,
      openWithNavigationError: state.openWithNavigationError,
      clearNavigationError: state.clearNavigationError,
    })),
  );
  const selecting = useUsageLimitResumePromptStore((state) => state.isOpen);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const pending = pendingAction !== null;
  const pendingRef = useRef<PendingAction>(null);
  const mountedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const progress = snapshot ? resumeQueueProgress(snapshot) : null;
  useCurrentUiStateReporter('usage.resumeQueueModal', {
    open: isOpen && !selecting,
    paused: snapshot?.paused ?? false,
    pending,
    processed: progress?.processed ?? 0,
    total: progress?.total ?? 0,
    active: progress?.active ?? false,
    errorVisible: Boolean(
      error || navigationError || snapshot?.error || connectionError,
    ),
  });
  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    const unsubscribe = window.api.onResumeQueueChanged(apply);
    void window.api
      .getResumeQueue()
      .then((state): void => {
        if (!disposed) apply(state);
      })
      .catch((): void => {
        if (!disposed)
          useResumeQueueStore.setState({
            connectionError: 'Could not load the resume queue.',
          });
      });
    return (): void => {
      mountedRef.current = false;
      disposed = true;
      unsubscribe();
    };
  }, [apply]);

  if (!isOpen || selecting) return null;
  const control = async (action: ResumeQueueControl): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = 'control';
    setPendingAction('control');
    setError(null);
    try {
      if (action === 'dismiss') {
        await dismiss();
        close();
      } else {
        apply(await window.api.controlResumeQueue(action));
      }
    } catch {
      if (mountedRef.current)
        setError('Could not update the queue. Try again.');
    } finally {
      pendingRef.current = null;
      if (mountedRef.current) setPendingAction(null);
    }
  };
  // Opening a session leaves the queue running; the dialog stays as the
  // retry route until the destination opens.
  const openEntry = async (entry: ResumeQueueEntry): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = 'navigation';
    setPendingAction('navigation');
    setError(null);
    clearNavigationError();
    try {
      const opened = await openResumeQueueEntry(entry);
      if (opened.ok) close();
      else openWithNavigationError(opened.error);
    } finally {
      pendingRef.current = null;
      if (mountedRef.current) setPendingAction(null);
    }
  };
  // Done opens the only resumed chat before dismissing, so an unavailable
  // chat leaves its queue entry in place to retry.
  const done = async (): Promise<void> => {
    if (pendingRef.current) return;
    const entry = snapshot ? soleResumedChatEntry(snapshot) : null;
    if (!entry) {
      clearNavigationError();
      await control('dismiss');
      return;
    }
    pendingRef.current = 'navigation';
    setPendingAction('navigation');
    setError(null);
    clearNavigationError();
    try {
      const opened = await openResumeQueueEntry(entry);
      if (!opened.ok) {
        openWithNavigationError(opened.error);
        return;
      }
      await dismiss();
      close();
    } catch {
      if (mountedRef.current)
        setError('Could not update the queue. Try again.');
    } finally {
      pendingRef.current = null;
      if (mountedRef.current) setPendingAction(null);
    }
  };
  const visibleError =
    error || navigationError || snapshot?.error || connectionError;
  const status = snapshot ? resumeQueueStatusLabel(snapshot) : null;
  const active = progress?.active ?? false;
  const total = progress?.total ?? 0;
  // Paused or errored queues make no promise that starts are continuing.
  const held = Boolean(snapshot?.paused || snapshot?.error);
  const [soleEntry] = total === 1 ? (snapshot?.entries ?? []) : [];
  const sentence = soleEntry ? singleEntrySentence(soleEntry, held) : null;
  const statusGlyph = status ? resumeQueueStatusGlyphState(status) : null;
  // The bar shows how far an active batch has come; a terminal batch would
  // always read full, so it drops the bar.
  const showProgress = progress !== null && total > 1 && active;
  const footer = (
    // A terminal queue has one footer action; ✕ and Escape still close it
    // through the guarded onClose path.
    <div
      data-testid="resume-queue-footer"
      className="flex flex-1 items-center gap-2"
    >
      {active && (
        <span className="mr-auto text-xs fg-tertiary">Saved automatically</span>
      )}
      {active ? (
        <>
          <Button
            size="compact"
            className="ml-auto"
            disabled={pending || !!snapshot?.error}
            onClick={() => {
              void control('stop');
            }}
          >
            Stop remaining
          </Button>
          <Button
            variant="primary"
            size="compact"
            disabled={pending || !!snapshot?.error}
            onClick={() => {
              void control(snapshot?.paused ? 'resume' : 'pause');
            }}
          >
            {snapshot?.paused ? 'Resume queue' : 'Pause queue'}
          </Button>
        </>
      ) : (
        <Button
          variant="primary"
          size="compact"
          className="ml-auto"
          data-testid="resume-queue-done"
          disabled={pending || !snapshot || !!snapshot.error}
          onClick={() => {
            void done();
          }}
        >
          Done
        </Button>
      )}
    </div>
  );
  return (
    <DialogModal
      inset="flush"
      title="Resume queue"
      onClose={() => {
        if (pendingRef.current !== 'navigation') close();
      }}
      maxWidth="lg"
      footer={footer}
      // On the card, so the footer actions sit inside the queue's test scope.
      dataTestId="resume-queue-modal"
    >
      <div className="flex flex-col">
        <div
          className="flex flex-col px-6 pb-3.5 pt-3 gap-2.5"
          role="status"
          aria-live="polite"
        >
          {status && (
            <div className="flex items-center justify-between gap-3 text-s">
              <span className="flex items-center gap-2">
                {statusGlyph && <StatusGlyph state={statusGlyph} />}
                <span data-testid="resume-queue-status" className="font-medium">
                  {status}
                </span>
              </span>
              {progress && total > 1 && (
                <span className="text-xs tabular-nums fg-tertiary">
                  {progress.resumed} of {total} started
                </span>
              )}
            </div>
          )}
          {showProgress && (
            // The bar tracks how much of the queue has been handled, not how
            // many entries started.
            <ProgressBar
              value={progress.percentage}
              label="Resume progress"
              valueText={`${progress.processed} of ${total} handled`}
              hideLabel
            />
          )}
          {sentence && <p className="text-s fg-secondary">{sentence}</p>}
          {active && snapshot?.paused && (
            <p className="text-xs fg-tertiary">
              Waiting sessions stay paused, even after a restart. Started
              sessions keep running.
            </p>
          )}
          {active && total > 1 && !held && (
            <p className="text-xs fg-tertiary">
              One session starts every 10 seconds. Started sessions keep
              running.
            </p>
          )}
          <ErrorBanner
            errorSource="resume-queue-modal-visible"
            className=""
            error={visibleError}
          />
        </div>
        <Surface variant="group" className="flex min-h-0 flex-col">
          <div className="overflow-hidden">
            <ol
              className="max-h-[45vh] overflow-y-auto px-3 [&>li+li]:border-t [&>li+li]:border-[var(--line-base)]"
              aria-label="Sessions to resume"
            >
              {snapshot?.entries.map((entry) => (
                <InterruptedSessionRow
                  childrenGap="tight"
                  as="li"
                  key={entry.id}
                  data-testid={`resume-queue-entry-${entry.id}`}
                  layout="queue"
                  leading={
                    <StatusGlyph
                      state={resumeQueueEntryGlyphState(entry.status)}
                      className="mt-0.75"
                    />
                  }
                  title={entry.title}
                  titleId={`resume-queue-entry-title-${entry.id}`}
                  replayMaskTitle
                  context={
                    <span data-testid="resume-queue-entry-identity">
                      <span className={POSTHOG_REPLAY_MASK_CLASS}>
                        {entry.workspaceName}
                      </span>
                      {` · ${entry.target.kind === 'pipeline' ? 'Workflow · ' : ''}${
                        entry.providers?.length
                          ? entry.providers
                              .map(getModelCatalogProviderLabel)
                              .join(', ')
                          : 'Provider unavailable'
                      }`}
                    </span>
                  }
                  trailing={
                    <div className="flex shrink-0 items-center gap-2 self-center">
                      {entry.status === 'failed' ? (
                        <StatusLabel size="xs">
                          {labels[entry.status]}
                        </StatusLabel>
                      ) : (
                        <span className="text-xs fg-tertiary">
                          {labels[entry.status]}
                        </span>
                      )}
                      <Button
                        variant="ghost-quiet"
                        size="compact"
                        data-testid={`resume-queue-entry-open-${entry.id}`}
                        aria-describedby={`resume-queue-entry-title-${entry.id}`}
                        disabled={pending}
                        onClick={() => {
                          void openEntry(entry);
                        }}
                      >
                        {resumeQueueEntryDestinationLabel(entry)}
                        <ChevronRightIcon size={12} aria-hidden />
                      </Button>
                    </div>
                  }
                >
                  {entry.error && (
                    <p className="text-xs">
                      <StatusLabel>{entry.error}</StatusLabel>
                    </p>
                  )}
                </InterruptedSessionRow>
              ))}
            </ol>
          </div>
        </Surface>
      </div>
    </DialogModal>
  );
}

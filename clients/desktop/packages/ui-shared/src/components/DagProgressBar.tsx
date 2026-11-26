import { ControlButton } from '../primitives/Button';
import { Badge, type BadgeTone } from '../primitives/Badge';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import {
  runStatusGlyphState,
  type StatusGlyphState,
} from '../lib/status-glyph';
import { StatusGlyph } from '../primitives/StatusGlyph';
import {
  ProgressStageRule,
  ProgressStepMark,
  ProgressSteps,
} from '../primitives/Progress';
import { RichHoverTooltip } from '../primitives/RichHoverTooltip';

/**
 * Closed enumeration of DAG job statuses understood by the shared progress
 * bar. Mirrors the desktop executor enum but is intentionally portable so
 * the web portal can map its own status strings into this shape.
 */
export type DagJobStatus =
  | 'pending'
  | 'running'
  | 'restarting'
  | 'success'
  | 'failure'
  | 'paused'
  | 'cancelled'
  | 'skipped';

export interface DagJobMeta {
  /** Job id used as the React key and the `data-job-id` selector. */
  jobId: string;
  /** Human-readable job name shown in the popover title. */
  name: string;
  status: DagJobStatus | undefined;
  /**
   * The source's own word for a finished job when `status` is broader than
   * it: GitHub's `neutral` and `stale` both draw as `skipped`. Lists that
   * name a job's outcome show this instead of the status.
   */
  outcomeLabel?: string;
  /** Optional started-at ISO 8601 timestamp; drives the duration field. */
  startedAt?: string;
  /** Optional completed-at ISO 8601 timestamp; clamps the duration. */
  completedAt?: string;
  /** Optional `completed/total` step progress for the popover. Caller pre-
   * computes this so the shared component does not need to walk the
   * executor's step result map. */
  stepProgress?: string;
  /** Optional `3 / 5 complete` progress for a logical matrix group. */
  variantProgress?: string;
  /** Optional `3 succeeded · 1 failed · 1 running` aggregate variant counts. */
  variantBreakdown?: string;
  /** Optional resolved concurrency limit, rendered verbatim. */
  maxParallel?: number;
}

export interface DagProgressBarProps {
  /** Tiers of job ids, layered by dependency depth. Caller computes this
   * (desktop uses `computeDagTiers` against the executor snapshot; the web
   * portal does the equivalent from the protocol payload). */
  tiers: string[][];
  /** Job lookup keyed by job id. */
  jobs: Record<string, DagJobMeta>;
  /** Render the bar in a low-opacity muted form (used for completed runs). */
  muted?: boolean;
  /** Click handler invoked when a job dot is clicked. */
  onJobClick?: (jobId: string) => void;
}

/**
 * A job's place on the shared status glyph map. A job that has not started
 * yet is queued; a skipped one ends without an outcome, like a cancelled one.
 */
function jobGlyphState(status: DagJobStatus | undefined): StatusGlyphState {
  return runStatusGlyphState(status) ?? 'queued';
}

function getPopoverStatusBadge(status: DagJobStatus | undefined): {
  label: string;
  tone: BadgeTone;
  muted?: boolean;
} {
  switch (status) {
    case 'running':
    case 'restarting':
      return {
        label: status,
        tone: 'info',
      };
    case 'success':
      return {
        label: 'success',
        tone: 'success',
      };
    case 'failure':
      return {
        label: 'failure',
        tone: 'danger',
      };
    case 'paused':
      return {
        label: 'paused',
        tone: 'neutral',
      };
    case 'cancelled':
      return {
        label: 'cancelled',
        tone: 'neutral',
        muted: true,
      };
    case 'skipped':
      return {
        label: 'skipped',
        tone: 'neutral',
        muted: true,
      };
    default:
      return {
        label: status ?? 'pending',
        tone: 'neutral',
        muted: true,
      };
  }
}

function formatDuration(
  startedAt: string | undefined,
  completedAt: string | undefined,
): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diffMs = end - start;
  const totalSeconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Pixels to scroll per arrow click. */
const SCROLL_STEP = 80;
const OVERFLOW_MEASUREMENTS_PER_FRAME = 8;
const pendingOverflowMeasurements = new Set<() => void>();
let overflowMeasurementFramePending = false;

function flushOverflowMeasurements(): void {
  overflowMeasurementFramePending = false;
  const callbacks = Array.from(pendingOverflowMeasurements).slice(
    0,
    OVERFLOW_MEASUREMENTS_PER_FRAME,
  );
  for (const callback of callbacks) {
    pendingOverflowMeasurements.delete(callback);
    callback();
  }
  if (pendingOverflowMeasurements.size > 0) {
    requestOverflowMeasurementFrame();
  }
}

function requestOverflowMeasurementFrame(): void {
  if (overflowMeasurementFramePending) return;
  overflowMeasurementFramePending = true;
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(flushOverflowMeasurements);
  } else {
    setTimeout(flushOverflowMeasurements, 0);
  }
}

function scheduleOverflowMeasurement(callback: () => void): void {
  pendingOverflowMeasurements.add(callback);
  requestOverflowMeasurementFrame();
}

function cancelOverflowMeasurement(callback: () => void): void {
  pendingOverflowMeasurements.delete(callback);
}

function ScrollArrow({
  direction,
  onClick,
}: {
  direction: 'left' | 'right';
  onClick: () => void;
}): JSX.Element {
  const isLeft = direction === 'left';
  return (
    <ControlButton
      type="button"
      aria-label={`Scroll ${direction}`}
      onClick={(e: MouseEvent<HTMLButtonElement>): void => {
        e.stopPropagation();
        onClick();
      }}
      presentation="dag-scroll"
      appearance={{ isLeft }}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="fg-primary/30 transition-colors hover:fg-primary/60"
      >
        <path d={isLeft ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
      </svg>
    </ControlButton>
  );
}

function JobDot({
  job,
  onJobClick,
}: {
  job: DagJobMeta;
  onJobClick?: (jobId: string) => void;
}): JSX.Element {
  const statusBadge = getPopoverStatusBadge(job.status);
  const isActive = job.status === 'running' || job.status === 'restarting';
  const durationLabel = isActive ? 'Elapsed' : 'Duration';
  const duration = formatDuration(job.startedAt, job.completedAt);

  const detail = (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-2xs font-semibold fg-primary/80">
        <StatusGlyph state={jobGlyphState(job.status)} size={12} />
        {job.name}
      </div>
      <div>
        <div className="flex items-center justify-between py-0.5 text-3xs fg-secondary">
          <span>Status</span>
          <Badge tone={statusBadge.tone} muted={statusBadge.muted}>
            {statusBadge.label}
          </Badge>
        </div>
        {duration && (
          <div className="flex items-center justify-between py-0.5 text-3xs fg-secondary">
            <span>{durationLabel}</span>
            <span className="font-medium fg-primary/80">{duration}</span>
          </div>
        )}
        {job.stepProgress && (
          <div className="flex items-center justify-between py-0.5 text-3xs fg-secondary">
            <span>Steps</span>
            <span className="font-medium fg-primary/80">
              {job.stepProgress}
            </span>
          </div>
        )}
        {job.variantProgress && (
          <div className="flex items-center justify-between py-0.5 text-3xs fg-secondary">
            <span>Children</span>
            <span className="font-medium fg-primary/80">
              {job.variantProgress}
            </span>
          </div>
        )}
        {job.maxParallel !== undefined && (
          <div className="flex items-center justify-between py-0.5 text-3xs fg-secondary">
            <span>Max parallel</span>
            <span className="font-medium fg-primary/80">{job.maxParallel}</span>
          </div>
        )}
        {job.variantBreakdown && (
          <div className="pt-0.5 text-3xs fg-secondary">
            {job.variantBreakdown}
          </div>
        )}
      </div>
    </div>
  );

  // The press stops here, past the card's own press handler, so it opens
  // the job (or its card) without also reaching the row around the strip.
  return (
    <span
      className="contents"
      onClick={(e: MouseEvent<HTMLSpanElement>): void => e.stopPropagation()}
    >
      <RichHoverTooltip
        content={detail}
        // The job's card: the menu's corners and shadow, above the dot and
        // below it when there is no room.
        elevation="menu"
        surfacePadding="card"
        surfaceClassName="min-w-45 max-w-55"
        dataTestId={`dag-job-detail-${job.jobId}`}
        // A strip with nowhere to go (the read-only web run list) opens the
        // card on press too, since a tap neither hovers nor, on iOS, focuses.
        showOnPress={onJobClick === undefined}
      >
        <ControlButton
          type="button"
          data-job-id={job.jobId}
          onClick={(): void => onJobClick?.(job.jobId)}
          onKeyDown={(e: KeyboardEvent<HTMLButtonElement>): void => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
            }
          }}
          presentation="dag-job-dot"
          data-status-glyph-state={jobGlyphState(job.status)}
          aria-label={`${job.name}: ${job.status ?? 'pending'}`}
        >
          <ProgressStepMark state={jobGlyphState(job.status)} />
        </ControlButton>
      </RichHoverTooltip>
    </span>
  );
}

function DagProgressBarInner({
  tiers,
  jobs,
  muted = false,
  onJobClick,
}: DagProgressBarProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevOverflowRef = useRef({ left: false, right: false });
  const [overflow, setOverflow] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });

  const tierStructureKey = useMemo(
    () => tiers.map((tier) => tier.join('\u001f')).join('\u001e'),
    [tiers],
  );

  const activeJobKey = useMemo((): string => {
    const ids: string[] = [];
    for (const tier of tiers) {
      for (const jobId of tier) {
        const status = jobs[jobId]?.status;
        if (status === 'running' || status === 'restarting') {
          ids.push(jobId);
        }
      }
    }
    return ids.join(',');
  }, [tiers, jobs]);

  // A mark's width follows its state (the running comet is wider than a
  // dot), so a status change can resize the strip without resizing the
  // scroller or changing its tiers.
  const markStateKey = useMemo(
    (): string =>
      tiers
        .map((tier) =>
          tier.map((jobId) => jobGlyphState(jobs[jobId]?.status)).join(','),
        )
        .join('|'),
    [tiers, jobs],
  );

  const recalcOverflow = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 2;
    const left = el.scrollLeft > threshold;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - threshold;
    if (
      left !== prevOverflowRef.current.left ||
      right !== prevOverflowRef.current.right
    ) {
      prevOverflowRef.current = { left, right };
      setOverflow({ left, right });
    }
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = (): void =>
      scheduleOverflowMeasurement(recalcOverflow);
    el.addEventListener('scroll', handleScroll, { passive: true });
    return (): void => {
      el.removeEventListener('scroll', handleScroll);
      cancelOverflowMeasurement(recalcOverflow);
    };
  }, [recalcOverflow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() =>
      scheduleOverflowMeasurement(recalcOverflow),
    );
    observer.observe(el);
    return (): void => {
      observer.disconnect();
      cancelOverflowMeasurement(recalcOverflow);
    };
  }, [recalcOverflow]);

  useEffect(() => {
    scheduleOverflowMeasurement(recalcOverflow);
    return (): void => cancelOverflowMeasurement(recalcOverflow);
  }, [tierStructureKey, markStateKey, recalcOverflow]);

  // The same change moves every mark after the one that changed, without
  // resizing anything an open job card watches. Announce it as a scroll of
  // the strip: the card re-anchors on scroll (it listens in the capture
  // phase), so it stays on its mark while the run goes on.
  useLayoutEffect(() => {
    scrollRef.current?.dispatchEvent(new Event('scroll'));
  }, [markStateKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || activeJobKey === '') return;
    const firstActiveId = activeJobKey.split(',')[0];
    const dotEl = el.querySelector<HTMLElement>(
      `[data-job-id="${CSS.escape(firstActiveId)}"]`,
    );
    if (!dotEl) return;
    const dotRect = dotEl.getBoundingClientRect();
    const containerRect = el.getBoundingClientRect();
    const containerWidth = containerRect.width;
    const dotCenter =
      dotRect.left - containerRect.left + el.scrollLeft + dotRect.width / 2;
    const targetScroll = dotCenter - containerWidth / 2;
    el.scrollTo({ left: Math.max(0, targetScroll), behavior: 'smooth' });
  }, [activeJobKey]);

  const handleScrollLeft = useCallback((): void => {
    scrollRef.current?.scrollBy({ left: -SCROLL_STEP, behavior: 'smooth' });
  }, []);

  const handleScrollRight = useCallback((): void => {
    scrollRef.current?.scrollBy({ left: SCROLL_STEP, behavior: 'smooth' });
  }, []);

  if (tiers.length === 0) {
    return <div />;
  }

  return (
    <div
      className={`relative pt-[calc(1.125rem+var(--border-hairline))] before:pointer-events-none before:absolute before:inset-x-0 before:top-2.5 before:h-[var(--border-hairline)] before:bg-line-base ${muted ? 'opacity-70' : ''}`}
    >
      <div className="relative flex items-center">
        {overflow.left && (
          <ScrollArrow direction="left" onClick={handleScrollLeft} />
        )}
        {/* The same dots, spacing and stage rules as the drawer's
            `DagProgressDots` (`ProgressSteps` dots), with each job a button
            that opens its card. The 4px inset keeps focus rings and the
            hover scale inside the scroller's clip. */}
        <div
          ref={scrollRef}
          // min-h-5 fits the 12px running comet and the inset, so the strip
          // keeps its height as jobs start and finish.
          className="scrollbar-hide flex min-h-5 min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1"
        >
          {tiers.map((tier, tierIndex) => (
            <span
              key={tierIndex}
              data-testid="dag-progress-tier"
              className="inline-flex shrink-0 items-center gap-1.5"
            >
              {tierIndex > 0 && <ProgressStageRule />}
              <span className="inline-flex items-center gap-1.5">
                {tier.map((jobId) => {
                  const job = jobs[jobId] ?? {
                    jobId,
                    name: jobId,
                    status: undefined,
                  };
                  return (
                    <JobDot key={jobId} job={job} onJobClick={onJobClick} />
                  );
                })}
              </span>
            </span>
          ))}
        </div>
        {overflow.right && (
          <ScrollArrow direction="right" onClick={handleScrollRight} />
        )}
      </div>
    </div>
  );
}

export const DagProgressBar = memo(DagProgressBarInner);

/**
 * The progress bar inline, for the composer's background drawer rows: the
 * same dots as {@link DagProgressBar}, drawn by the shared
 * {@link ProgressSteps}, with no popovers or clicks. Decorative: the row is
 * itself the control and names the run's state.
 */
export const DagProgressDots = memo(function DagProgressDots({
  tiers,
  jobs,
  className,
}: Pick<DagProgressBarProps, 'tiers' | 'jobs'> & {
  /** Placement only. */
  readonly className?: string;
}): JSX.Element | null {
  const stages = useMemo(
    () =>
      tiers.map((tier) =>
        tier.map((jobId) => ({
          id: jobId,
          state: jobGlyphState(jobs[jobId]?.status),
        })),
      ),
    [tiers, jobs],
  );
  return (
    <ProgressSteps
      appearance="dots"
      stages={stages}
      className={className}
      dataTestId="dag-progress-dots"
    />
  );
});

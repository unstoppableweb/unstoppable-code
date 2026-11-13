import type { JSX, Ref } from 'react';
import { STATUS_GLYPHS, type StatusGlyphState } from '../lib/status-glyph';
import { CometSpinner } from './CometSpinner';
import { SpinnerStyleProvider } from './spinner-style';
import { StatusGlyph } from './StatusGlyph';

/**
 * The one progress set (docs/design/feedback.md#progress): a labelled 6px
 * bar, a 16px ring for a control too small for a bar, and a row of status
 * glyphs for work made of steps. Every part takes a role, never a color.
 * `SegmentsBar` shares the capsule for data rather than progress, so its
 * parts take chart colors.
 */

/**
 * The role a progress mark takes. `accent` is ordinary progress; `warning`
 * and `destructive` mark a meter nearing or at its limit; `neutral` is
 * progress that is paused or carries no state of its own.
 */
export type ProgressTone = 'accent' | 'warning' | 'destructive' | 'neutral';

/** `default` is the 6px bar; `compact` the 4px bar inside a dense row. */
export type ProgressBarSize = 'default' | 'compact';

const BAR_FILL: Readonly<Record<ProgressTone, string>> = {
  accent: 'bg-accent',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  neutral: 'bg-fg-tertiary',
};

const BAR_HEIGHT: Readonly<Record<ProgressBarSize, string>> = {
  default: 'h-1.5',
  compact: 'h-1',
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 100);
}

export interface ProgressBarProps {
  /** 0–100, clamped. Ignored while indeterminate. */
  readonly value: number;
  /**
   * What is progressing. Names the bar for assistive technology and shows
   * above it, at the left of the label row, unless `hideLabel`.
   */
  readonly label: string;
  /**
   * Draw the bar alone, when the row around it already names the work and
   * shows its value. The label still names the bar.
   */
  readonly hideLabel?: boolean;
  /**
   * The value in words (`3 of 10 handled`), at the right of the label row and
   * read as `aria-valuetext`. Defaults to the rounded percent on screen.
   */
  readonly valueText?: string;
  /** Work whose share is unknown: a third of the track sweeps across it. */
  readonly indeterminate?: boolean;
  readonly tone?: ProgressTone;
  readonly size?: ProgressBarSize;
  /** Placement only: margin, width and flex participation. */
  readonly className?: string;
  readonly dataTestId?: string;
}

/**
 * A determinate or indeterminate bar on the muted track, with an optional
 * label row above it: the label in 12px secondary ink at the left, the value
 * in tertiary tabular figures at the right. The fill moves by transform, so a
 * change never lays the row out again, and it holds still under reduced
 * motion.
 */
export function ProgressBar({
  value,
  label,
  hideLabel = false,
  valueText,
  indeterminate = false,
  tone = 'accent',
  size = 'default',
  className = '',
  dataTestId,
}: ProgressBarProps): JSX.Element {
  const clamped = clampPercent(value);
  const bar = (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
      aria-valuetext={indeterminate ? undefined : valueText}
      data-tone={tone}
      data-testid={hideLabel ? dataTestId : undefined}
      className={`relative w-full overflow-hidden rounded-full bg-muted ${BAR_HEIGHT[size]}${hideLabel && className ? ` ${className}` : ''}`}
    >
      {indeterminate ? (
        <div
          className={`${BAR_FILL[tone]} h-full w-1/3 rounded-full animate-progress-indeterminate motion-reduce:animate-none`}
        />
      ) : (
        <div
          className={`${BAR_FILL[tone]} h-full w-full rounded-full transition-transform duration-300 ease-out motion-reduce:transition-none`}
          style={{ transform: `translateX(${clamped - 100}%)` }}
        />
      )}
    </div>
  );
  if (hideLabel) return bar;
  return (
    <div
      className={`flex w-full min-w-0 flex-col gap-1${className ? ` ${className}` : ''}`}
      data-testid={dataTestId}
    >
      <div
        className="flex min-w-0 items-baseline justify-between gap-3 text-xs"
        aria-hidden="true"
        data-progress-label-row=""
      >
        <span className="min-w-0 truncate fg-secondary">{label}</span>
        {indeterminate ? null : (
          <span className="shrink-0 tabular-nums fg-tertiary">
            {valueText ?? `${Math.round(clamped)}%`}
          </span>
        )}
      </div>
      {bar}
    </div>
  );
}

/** One part of a {@link SegmentsBar}. */
export interface BarSegment {
  readonly key: string;
  /** The part's size in the caller's unit. Only positive finite values draw. */
  readonly value: number;
  /** A chart series color: this is data, so it takes a color, not a tone. */
  readonly color: string;
}

/** `compact` is 4px, `default` 6px and `large` 8px. */
export type SegmentsBarSize = ProgressBarSize | 'large';

const SEGMENTS_HEIGHT: Readonly<Record<SegmentsBarSize, string>> = {
  ...BAR_HEIGHT,
  large: 'h-2',
};

export interface SegmentsBarProps {
  readonly segments: readonly BarSegment[];
  /** The filled length, 0..1, clamped. The segments split it by value. */
  readonly scale?: number;
  /**
   * The bar's whole accessible name, with its figures. Leave it out when the
   * row around the bar already says them: the bar is then decorative.
   */
  readonly label?: string;
  readonly size?: SegmentsBarSize;
  /**
   * The filled length, for a caller that animates it. It rests without a
   * transform, with its origin at the top left, as `useFlipBox` needs.
   */
  readonly fillRef?: Ref<HTMLDivElement>;
  readonly dataTestId?: string;
}

/**
 * A stacked share on the muted track: a filled length split into colored
 * parts, a pixel apart. For a chart-like split (cost, context window) or one
 * row's share of the largest, never for work in progress. A part with no value
 * draws nothing, and with none left the track stays empty.
 */
export function SegmentsBar({
  segments,
  scale = 1,
  label,
  size = 'default',
  fillRef,
  dataTestId,
}: SegmentsBarProps): JSX.Element {
  const parts = segments.filter(
    (segment) => Number.isFinite(segment.value) && segment.value > 0,
  );
  // Normalize before summing so large finite values cannot overflow the sum.
  const largest = parts.reduce(
    (max, segment) => Math.max(max, segment.value),
    0,
  );
  const total = parts.reduce(
    (sum, segment) => sum + segment.value / largest,
    0,
  );
  return (
    <div
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      data-testid={dataTestId}
      className={`flex w-full overflow-hidden rounded-full bg-muted ${SEGMENTS_HEIGHT[size]}`}
    >
      <div
        ref={fillRef}
        aria-hidden="true"
        className="flex h-full origin-top-left gap-px overflow-hidden rounded-full"
        style={{ width: `${total > 0 ? clampPercent(scale * 100) : 0}%` }}
      >
        {parts.map((segment) => (
          <span
            key={segment.key}
            className="h-full"
            style={{
              flexGrow: segment.value / largest / total,
              flexBasis: 0,
              backgroundColor: segment.color,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** Ring box and stroke: one size, the 16px of an icon beside a label. */
const RING_SIZE = 16;
const RING_STROKE = 2;

/**
 * The arc takes the role's ink and the full track the same role's subtle
 * surface, so a ring reads as one color at two strengths; `neutral` sits on
 * the muted surface.
 */
const RING_STROKES: Readonly<
  Record<ProgressTone, { readonly arc: string; readonly track: string }>
> = {
  neutral: { arc: 'var(--fg-secondary)', track: 'var(--bg-muted)' },
  accent: { arc: 'var(--fg-accent)', track: 'var(--bg-accent-subtle)' },
  warning: { arc: 'var(--fg-warning)', track: 'var(--bg-warning-subtle)' },
  destructive: {
    arc: 'var(--fg-destructive)',
    track: 'var(--bg-destructive-subtle)',
  },
};

export interface ProgressRingProps {
  /** 0–100, clamped. */
  readonly value: number;
  readonly tone: ProgressTone;
  /**
   * Accessible name. Omit when the control around the ring names it (a
   * button's label or tooltip); the ring is then hidden from assistive
   * technology.
   */
  readonly label?: string;
  /** The value in words, read as `aria-valuetext` when the ring is named. */
  readonly valueText?: string;
  /** Placement only. */
  readonly className?: string;
}

/** A 16px ring with a 2px stroke, for progress inside a small control. */
export function ProgressRing({
  value,
  tone,
  label,
  valueText,
  className,
}: ProgressRingProps): JSX.Element {
  const clamped = clampPercent(value);
  const center = RING_SIZE / 2;
  const radius = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokes = RING_STROKES[tone];
  const named = label !== undefined;
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className={className}
      data-tone={tone}
      role={named ? 'progressbar' : undefined}
      aria-label={label}
      aria-valuemin={named ? 0 : undefined}
      aria-valuemax={named ? 100 : undefined}
      aria-valuenow={named ? Math.round(clamped) : undefined}
      aria-valuetext={named ? valueText : undefined}
      aria-hidden={named ? undefined : true}
    >
      <circle
        data-part="track"
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={strokes.track}
        strokeWidth={RING_STROKE}
      />
      <circle
        data-part="arc"
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={strokes.arc}
        strokeWidth={RING_STROKE}
        strokeDasharray={circumference}
        strokeDashoffset={circumference - (clamped / 100) * circumference}
        strokeLinecap="round"
        transform={`rotate(-90 ${center} ${center})`}
        className="transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none"
      />
    </svg>
  );
}

export interface ProgressStep {
  /** Stable key, also the step's `data-progress-step` value. */
  readonly id: string;
  readonly state: StatusGlyphState;
}

export interface ProgressStepsProps {
  /**
   * Compact inline job strips use 4px state dots with a 12px comet for running
   * work; full step rows use glyphs.
   */
  readonly appearance?: 'glyphs' | 'dots';
  /**
   * The steps in order, grouped into stages. Steps in one stage run side by
   * side and sit 3px apart; a short rule separates one stage from the next.
   */
  readonly stages: readonly (readonly ProgressStep[])[];
  /**
   * Accessible name. Omit when the row around the steps names the work; the
   * strip is then decorative.
   */
  readonly label?: string;
  /** Placement only. */
  readonly className?: string;
  readonly dataTestId?: string;
}

/**
 * A compact strip's job: a 4px dot in its state's ink. Work that hasn't run
 * (queued, cancelled) is a faint dot, so finished and failed jobs stand out.
 */
function StepDot({ state }: { readonly state: StatusGlyphState }): JSX.Element {
  const ink =
    state === 'queued' || state === 'cancelled'
      ? 'fg-tertiary/40'
      : STATUS_GLYPHS[state].ink || 'fg-tertiary';
  return (
    <svg
      width={4}
      height={4}
      viewBox="0 0 4 4"
      aria-hidden="true"
      className={ink}
    >
      <circle cx={2} cy={2} r={2} fill="currentColor" />
    </svg>
  );
}

/**
 * A compact strip's running job, like an in-progress CI check: the 12px comet
 * turning around a center dot over a faint ring.
 */
function RunningStepDot(): JSX.Element {
  return (
    <span className="relative inline-flex size-3 shrink-0 items-center justify-center">
      <span className="absolute inset-0 rounded-full border-2 border-current fg-primary/25" />
      <span className="absolute inset-0 flex items-center justify-center">
        <CometSpinner sizePx={12} tone="primary" />
      </span>
      <svg
        width={4}
        height={4}
        viewBox="0 0 4 4"
        aria-hidden="true"
        className="fg-primary"
      >
        <circle cx={2} cy={2} r={2} fill="currentColor" />
      </svg>
    </span>
  );
}

function isFinished(state: StatusGlyphState): boolean {
  return state === 'done' || state === 'merged';
}

/**
 * Work made of steps, as a row of 12px status glyphs. A strip is a row of
 * circles, so a running step always draws the round comet, whatever spinner
 * style the host uses.
 */
export function ProgressSteps({
  stages,
  appearance = 'glyphs',
  label,
  className,
  dataTestId,
}: ProgressStepsProps): JSX.Element | null {
  const steps = stages.flat();
  if (steps.length === 0) return null;
  const finished = steps.filter((step) => isFinished(step.state)).length;
  const dots = appearance === 'dots';
  const named = label !== undefined;
  return (
    <SpinnerStyleProvider value="comet">
      <span
        className={`inline-flex shrink-0 items-center gap-1${className ? ` ${className}` : ''}`}
        data-testid={dataTestId}
        data-progress-appearance={appearance}
        role={named ? 'progressbar' : undefined}
        aria-label={label}
        aria-valuemin={named ? 0 : undefined}
        aria-valuemax={named ? steps.length : undefined}
        aria-valuenow={named ? finished : undefined}
        aria-valuetext={
          named ? `${finished} of ${steps.length} done` : undefined
        }
        aria-hidden={named ? undefined : true}
      >
        {stages.map((stage, stageIndex) =>
          stage.length === 0 ? null : (
            <span
              key={stage[0].id}
              className={`inline-flex items-center ${dots ? 'gap-1.5' : 'gap-1'}`}
            >
              {stageIndex > 0 && (
                <span
                  className="h-px w-1.5 bg-fg-primary/20"
                  data-progress-stage-separator=""
                />
              )}
              <span
                className={`inline-flex items-center ${dots ? 'gap-1.5' : 'gap-0.75'}`}
              >
                {stage.map((step) => (
                  <span
                    key={step.id}
                    className="inline-flex"
                    data-progress-step={step.id}
                    data-status-glyph-state={step.state}
                  >
                    {!dots ? (
                      <StatusGlyph state={step.state} size={12} />
                    ) : step.state === 'running' ? (
                      <RunningStepDot />
                    ) : (
                      <StepDot state={step.state} />
                    )}
                  </span>
                ))}
              </span>
            </span>
          ),
        )}
      </span>
    </SpinnerStyleProvider>
  );
}

'use client';

import { useRef, type JSX } from 'react';

export interface SliderProps {
  /** The selected stop, from 0. Below 0 means none: the thumb rests at 0. */
  readonly value: number;
  /** How many stops the track has. */
  readonly stops: number;
  /** Accessible name. Required: the track renders no text of its own. */
  readonly label: string;
  /** What the selected stop means, read out instead of its number. */
  readonly valueText?: string;
  readonly disabled?: boolean;
  /**
   * A stop was landed on: on release after a drag or click, or on a key press.
   * It also fires when the stop did not change, such as an arrow key at an end.
   */
  readonly onChange: (next: number) => void;
  /** The stop under a drag that is still moving, before it lands. */
  readonly onPreview?: (next: number) => void;
  readonly dataTestId?: string;
}

/** A 28px thumb over a 20px track. */
const THUMB_PX = 28;

/**
 * Where stop `index` of `stops` puts the thumb's left edge. The thumb stands
 * proud of the track, and its stops run from edge to edge. `span` is the
 * slider's width: `100%` for a `left`, or `100cqw` inside a `translate`, where
 * a percentage would measure the moving element instead.
 */
function stopLeft(
  index: number,
  stops: number,
  span: '100%' | '100cqw' = '100%',
): string {
  const fraction = stops <= 1 ? 0 : index / (stops - 1);
  return `calc((${span} - ${THUMB_PX}px) * ${fraction})`;
}

/**
 * A stepped slider: one stop per choice, a filled track up to the thumb, drag
 * or click to pick, arrow keys to step, Home and End for the ends. The host
 * owns `value`, and a drag only moves the thumb if the host follows
 * `onPreview`.
 */
export function Slider({
  value,
  stops,
  label,
  valueText,
  disabled = false,
  onChange,
  onPreview,
  dataTestId,
}: SliderProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragStopRef = useRef<number | null>(null);
  const clampStop = (next: number): number =>
    Math.min(stops - 1, Math.max(0, next));
  const stopAt = (clientX: number): number => {
    const track = trackRef.current;
    if (!track || stops <= 1) return 0;
    const rect = track.getBoundingClientRect();
    const usable = rect.width - THUMB_PX;
    const offset = clientX - rect.left - THUMB_PX / 2;
    return clampStop(Math.round((offset / usable) * (stops - 1)));
  };
  const land = (): void => {
    const landed = dragStopRef.current;
    dragStopRef.current = null;
    if (landed !== null) onChange(landed);
  };
  // The thumb and fill move by `translate` on the compositor, not by `left`
  // and `width`, measured against the slider as a size container.
  const thumbLeft = stopLeft(Math.max(0, value), stops, '100cqw');
  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, stops - 1)}
      aria-valuenow={Math.max(0, value)}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      data-testid={dataTestId}
      className="focus-ring @container relative h-7 w-full cursor-pointer touch-none rounded-full aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
      onPointerDown={(event): void => {
        if (disabled) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragStopRef.current = stopAt(event.clientX);
        onPreview?.(dragStopRef.current);
      }}
      onPointerMove={(event): void => {
        if (disabled) return;
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        dragStopRef.current = stopAt(event.clientX);
        onPreview?.(dragStopRef.current);
      }}
      // The drag lands where the pointer lets go.
      onPointerUp={land}
      onPointerCancel={land}
      onKeyDown={(event): void => {
        if (disabled) return;
        const step =
          event.key === 'ArrowRight' || event.key === 'ArrowUp'
            ? 1
            : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
              ? -1
              : 0;
        if (step !== 0) {
          event.preventDefault();
          onChange(clampStop(value + step));
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          onChange(event.key === 'Home' ? 0 : stops - 1);
        }
      }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-1/2 h-5 -translate-y-1/2 rounded-full bg-muted"
      />
      {/* Filled up to the thumb's middle: a full-length fill slid along its
          own clipped track, so its round end stays round as it moves. */}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-1/2 h-5 -translate-y-1/2 overflow-hidden rounded-full"
      >
        <span
          className="block h-full w-full rounded-full bg-accent transition-[translate] duration-150 ease-out motion-reduce:transition-none"
          style={{
            translate: `calc(${thumbLeft} + ${THUMB_PX / 2}px - 100%)`,
          }}
        />
      </span>
      {Array.from({ length: stops }, (_, stop) => (
        <span
          key={stop}
          aria-hidden="true"
          className={`absolute top-1/2 h-0.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${
            stop <= value ? 'bg-fg-emphasis/30' : 'bg-fg-tertiary/60'
          }`}
          style={{
            left: `calc(${stopLeft(stop, stops)} + ${THUMB_PX / 2}px)`,
          }}
        />
      ))}
      <span
        aria-hidden="true"
        // The accent's own ink: light on the blue fill in both themes.
        className="absolute left-0 top-0 h-7 w-7 rounded-full bg-fg-emphasis shadow-lg transition-[translate] duration-150 ease-out motion-reduce:transition-none"
        style={{ translate: thumbLeft }}
      />
    </div>
  );
}

import type { JSX, ReactNode } from 'react';
import { LoadingSpinner } from './LoadingSpinner';

/**
 * `app` is the house pill's gap between spinner and label; `share-lander` is
 * the public landers' squared control (`ControlButton`
 * `presentation="share-lander-primary"`), which spaces them wider.
 */
export type BusyLayersPresentation = 'app' | 'share-lander';

/**
 * Both labels share one grid cell, so the button is as wide as the wider of
 * them from the first render and never changes width when it turns busy.
 * Each layer keeps its presentation's own gap between spinner and label.
 */
const LAYER_CLASS_NAMES: Record<BusyLayersPresentation, string> = {
  app: 'col-start-1 row-start-1 inline-flex min-w-0 items-center justify-center gap-1.5',
  'share-lander':
    'col-start-1 row-start-1 inline-flex min-w-0 items-center justify-center gap-2',
};

/**
 * The spinner's footprint while the button rests: the dot grid's 10px box,
 * so the busy layer reserves the spinner's room without running it.
 */
const SPINNER_SPACER_CLASS_NAME = 'inline-block size-2.5 shrink-0';

/** A label made only of text and numbers, as one string; otherwise `null`. */
function plainText(label: ReactNode): string | null {
  if (typeof label === 'string' || typeof label === 'number') {
    return String(label);
  }
  if (!Array.isArray(label)) return null;
  let text = '';
  for (const part of label) {
    if (typeof part !== 'string' && typeof part !== 'number') return null;
    text += String(part);
  }
  return text;
}

/**
 * The label of the layer that is not showing, there only to hold its width.
 * A text label is drawn by CSS from an attribute, so it adds no text to the
 * DOM: queries and the button's text content see the showing label alone.
 */
export function ReservedLabel({
  label,
}: {
  readonly label: ReactNode;
}): JSX.Element {
  const text = plainText(label);
  if (text !== null) {
    return (
      <span
        aria-hidden="true"
        data-reserved-label={text}
        className="canopy-reserved-label whitespace-pre"
      />
    );
  }
  return <span aria-hidden="true">{label}</span>;
}

/**
 * The inside of a button that can turn busy: the resting label and the busy
 * one (spinner plus `busyLabel`) on top of each other in one grid cell, so
 * the button is as wide as the wider of them from the first render. Only
 * the showing layer is exposed to assistive technology. `Button` and
 * `ControlButton` draw a `loading` label through it; the button itself still
 * sets `aria-busy` and `aria-disabled`.
 */
export function BusyLayers({
  busy,
  busyLabel,
  spinnerOnly = false,
  leading,
  spinnerTestId,
  presentation = 'app',
  children,
}: {
  readonly busy: boolean;
  /** Label while busy. Defaults to the resting label. */
  readonly busyLabel?: ReactNode;
  /** The busy layer is the spinner alone; its label is screen-reader only. */
  readonly spinnerOnly?: boolean;
  /** A glyph before the resting label; the spinner takes its place. */
  readonly leading?: ReactNode;
  readonly spinnerTestId?: string;
  readonly presentation?: BusyLayersPresentation;
  readonly children: ReactNode;
}): JSX.Element {
  const layerClassName = LAYER_CLASS_NAMES[presentation];
  return (
    <span className="grid min-w-0">
      <span
        aria-hidden={busy ? true : undefined}
        className={`${layerClassName} ${busy ? 'invisible' : ''}`}
        data-busy-layer="rest"
      >
        {leading}
        {busy ? <ReservedLabel label={children} /> : children}
      </span>
      <span
        aria-hidden={busy ? undefined : true}
        className={`${layerClassName} ${busy ? '' : 'invisible'}`}
        data-busy-layer="busy"
      >
        {busy ? (
          <LoadingSpinner
            className="shrink-0"
            dataTestId={spinnerTestId}
            decorative
          />
        ) : (
          <span className={SPINNER_SPACER_CLASS_NAME} />
        )}
        {spinnerOnly ? (
          busy ? (
            <span className="sr-only">{busyLabel ?? children}</span>
          ) : null
        ) : busy ? (
          (busyLabel ?? children)
        ) : (
          <ReservedLabel label={busyLabel ?? children} />
        )}
      </span>
    </span>
  );
}

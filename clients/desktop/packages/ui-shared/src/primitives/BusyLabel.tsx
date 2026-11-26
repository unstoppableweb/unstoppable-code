import type { JSX, ReactNode } from 'react';
import { LoadingSpinner } from './LoadingSpinner';
import { useLoadingIndicatorStyle } from './LoadingIndicatorStyle';
import { ReservedLabel } from './busy-layers';

/**
 * A control's label while its work runs ("Load more" while the next page
 * loads). Under the `text` loading style the label is replaced by
 * `busyText`; both share one grid cell, like a loading `Button`'s labels, so the
 * control is as wide as the wider of them and never resizes. Under `spinner`
 * the label stays in place, invisible, so the control keeps its width, and a
 * spinner sits centered over it. The control should also set `aria-busy`.
 */
export function BusyLabel({
  busy,
  busyText = 'Loading…',
  children,
}: {
  readonly busy: boolean;
  /** Copy shown while busy under the `text` loading style. */
  readonly busyText?: string;
  readonly children: ReactNode;
}): JSX.Element {
  const style = useLoadingIndicatorStyle();
  if (style === 'text') {
    return (
      <span className="inline-grid">
        <span
          aria-hidden={busy ? true : undefined}
          className={`col-start-1 row-start-1 text-center ${busy ? 'invisible' : ''}`}
        >
          {busy ? <ReservedLabel label={children} /> : children}
        </span>
        <span
          aria-hidden={busy ? undefined : true}
          className={`col-start-1 row-start-1 text-center ${busy ? '' : 'invisible'}`}
        >
          {busy ? busyText : <ReservedLabel label={busyText} />}
        </span>
      </span>
    );
  }
  return (
    <span className="relative inline-flex items-center justify-center">
      <span className={busy ? 'invisible' : undefined}>{children}</span>
      {busy ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <LoadingSpinner sizePx={14} />
        </span>
      ) : null}
    </span>
  );
}

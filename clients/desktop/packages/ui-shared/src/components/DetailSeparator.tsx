import { Fragment, type JSX, type ReactNode } from 'react';

/**
 * The middle dot between a row's details ("Running · 1m 35s"). Padding, not
 * word spaces, sets its room: 6px on each side, the same as the gap between
 * a row's name and its details, so every separation in a row's text is one
 * width. Screen readers hear a comma instead of the dot.
 */
export function DetailSeparator(): JSX.Element {
  return (
    <span className="shrink-0 px-1.5">
      <span aria-hidden="true">·</span>
      <span className="sr-only">, </span>
    </span>
  );
}

/** The parts, skipping empty ones, joined by {@link DetailSeparator}. */
export function joinDetails(
  parts: readonly (ReactNode | null | undefined | false)[],
): ReactNode {
  const shown = parts.filter(
    (part): part is ReactNode =>
      part !== null && part !== undefined && part !== false && part !== '',
  );
  if (shown.length === 0) return null;
  return shown.map((part, index) => (
    // The parts are positional: a row's details in a fixed order.
    <Fragment key={index}>
      {index > 0 && <DetailSeparator />}
      {part}
    </Fragment>
  ));
}

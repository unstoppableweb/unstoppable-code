import type { CSSProperties, JSX, ReactNode } from 'react';

// The hole is 112px across (h-28) in a 192px disc: transparent out to 56px.
const DONUT_HOLE = 'radial-gradient(circle, transparent 56px, black 56.5px)';
const DONUT_HOLE_MASK: CSSProperties = {
  maskImage: DONUT_HOLE,
  WebkitMaskImage: DONUT_HOLE,
};

/** A compact usage donut with room for a total and label at its center. */
export function ActivityDonut({
  gradient,
  children,
}: {
  readonly gradient: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="relative mx-auto grid h-48 w-48 place-items-center">
      {/* The ring is masked, not covered, so the hole shows what is behind. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 rounded-full"
        style={{ background: gradient, ...DONUT_HOLE_MASK }}
      />
      <div className="relative grid h-28 w-28 place-items-center text-center">
        {children}
      </div>
    </div>
  );
}

/** Matches the segment color in a chart's summary or legend. */
export function ActivitySwatch({
  color,
  size = 'legend',
}: {
  readonly color: string;
  readonly size?: 'legend' | 'summary' | 'selector';
}): JSX.Element {
  const sizeClass = {
    legend: 'h-2 w-2 rounded-full',
    summary: 'h-2.5 w-2.5 rounded-full',
    selector: 'inline-block h-2 w-2 rounded-sm',
  }[size];
  return (
    <span
      aria-hidden="true"
      className={sizeClass}
      style={{ backgroundColor: color }}
    />
  );
}

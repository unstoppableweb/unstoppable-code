import type { JSX, ReactNode } from 'react';

const LAYER_SURFACE = {
  script: {
    base: 'flex flex-col gap-1 rounded border px-2 py-1.5',
    active: 'border-line-positive bg-success-subtle',
    inherited: 'bg-base/50',
  },
  detail: {
    base: 'rounded-lg border p-3 text-xs',
    active: 'border-line-positive bg-success-subtle',
    inherited: 'bg-fg-primary/[0.02]',
  },
} as const;

/** The provenance box for one source in resolution order. */
export function SourceLayerSurface({
  variant = 'detail',
  active = false,
  separateBody = false,
  children,
}: {
  readonly variant?: keyof typeof LAYER_SURFACE;
  readonly active?: boolean;
  readonly separateBody?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const surface = LAYER_SURFACE[variant];
  return (
    <div
      className={`${surface.base} ${active ? surface.active : surface.inherited}${separateBody ? ' flex flex-col gap-1.5' : ''}`}
    >
      {children}
    </div>
  );
}

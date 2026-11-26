import type { JSX, ReactNode } from 'react';
import { Surface } from '../primitives/Surface';

export function ProductPreviewWindowControls(): JSX.Element {
  return (
    <Surface variant="section" boundary="bottom">
      <div className="flex items-center gap-1.5 px-3 py-2.5">
        <span className="size-2.5 rounded-full bg-destructive/60" />
        <span className="size-2.5 rounded-full bg-warning/60" />
        <span className="size-2.5 rounded-full bg-success/60" />
      </div>
    </Surface>
  );
}

export function ProductPreviewIconTile({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <span className="flex size-10 flex-none items-center justify-center rounded-md bg-accent-subtle">
      {children}
    </span>
  );
}

export function ProductPreviewConversation({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <p className="max-w-17/20 rounded-lg rounded-tr-sm bg-secondary px-3 py-2 fg-primary">
      {children}
    </p>
  );
}

export function ProductPreviewSelection({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 fg-primary">
      {children}
    </div>
  );
}

export function ProductPreviewSend({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <span className="flex size-5 flex-none items-center justify-center rounded-full bg-accent fg-emphasis">
      {children}
    </span>
  );
}

export function ProductPreviewAnnotation({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <p className="rounded bg-accent-subtle px-1.5 py-1 fg-primary">
      {children}
    </p>
  );
}

export function ProductPreviewChartBar({
  height,
}: {
  readonly height: string;
}): JSX.Element {
  return <span className={`flex-1 rounded-t bg-accent-subtle ${height}`} />;
}

export function ProductPreviewGlow(): JSX.Element {
  return (
    <div className="absolute -top-24 right-0 size-96 rounded-full bg-accent-subtle blur-3xl" />
  );
}

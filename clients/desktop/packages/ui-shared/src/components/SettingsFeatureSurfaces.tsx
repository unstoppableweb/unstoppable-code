import type { JSX, ReactNode } from 'react';
import { Dot } from '../primitives/Badge';

export function PaymentHandoffNotice({
  children,
  testId,
}: {
  readonly children: ReactNode;
  readonly testId: string;
}): JSX.Element {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg bg-muted px-4 py-3"
      data-testid={testId}
      role="status"
    >
      {children}
    </div>
  );
}

export function DigestRequestSurface({
  children,
  testId,
  unavailable = false,
}: {
  readonly children: ReactNode;
  readonly testId: string;
  readonly unavailable?: boolean;
}): JSX.Element {
  return (
    <section
      className={`rounded-xl border bg-depth p-5${unavailable ? ' flex flex-col gap-1' : ''}`}
      data-testid={testId}
    >
      {children}
    </section>
  );
}

/** The adjacent “Shared” label supplies the accessible state. */
export function DigestSharedMarker(): JSX.Element {
  return <Dot tone="success" />;
}

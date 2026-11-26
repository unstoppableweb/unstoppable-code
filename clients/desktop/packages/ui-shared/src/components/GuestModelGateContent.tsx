import type { JSX, ReactNode } from 'react';
import {
  guestModelGateCopy,
  type GuestModelGateCopyInput,
  type GuestModelGateCopy,
} from './guestModelGate';
import { Button } from '../primitives/Button';
import { LoadingSpinner } from '../primitives/LoadingSpinner';
import { ErrorBanner } from '../primitives/StatusBlocks';

/** Refusals without a display label retain their existing generic copy. */
export type GuestModelGateSubject =
  | Omit<GuestModelGateCopyInput, 'fallbackLabel'>
  | { readonly copy: Omit<GuestModelGateCopy, 'fallbackAction'> };

export interface GuestModelGateContentProps {
  readonly subject: GuestModelGateSubject;
  readonly fallback?: {
    readonly label: string;
    readonly onActivate: () => void;
  };
  /**
   * Hosts retain sign-in navigation and authentication, including its ref.
   */
  readonly renderSignIn: (label: string) => ReactNode;
  readonly busy?: boolean;
  readonly error?: string | null;
  /** Neutral progress, announced, and kept when the fallback is withdrawn. */
  readonly status?: string | null;
  readonly dataTestId: string;
  readonly bodyTestId?: string;
}

/**
 * The same guest gate body and ordered actions on every supported host. It
 * offers only the ways forward; the dialog's close button and a click
 * outside it dismiss the gate.
 */
export function GuestModelGateContent({
  subject,
  fallback,
  renderSignIn,
  busy = false,
  error,
  status,
  dataTestId,
  bodyTestId = `${dataTestId}-body`,
}: GuestModelGateContentProps): JSX.Element {
  const actionableFallback = 'copy' in subject ? undefined : fallback;
  const copy: GuestModelGateCopy =
    'copy' in subject
      ? subject.copy
      : guestModelGateCopy({
          ...subject,
          ...(actionableFallback === undefined
            ? {}
            : { fallbackLabel: actionableFallback.label }),
        });
  const spinner = (testId: string): ReactNode =>
    busy && <LoadingSpinner dataTestId={testId} decorative />;
  return (
    <div className="flex flex-col gap-4 px-6 pb-6 pt-4">
      <div
        className="text-s leading-relaxed fg-secondary"
        data-testid={bodyTestId}
      >
        {copy.body}
      </div>
      <ErrorBanner
        className=""
        errorSource="guest-model-gate"
        error={error}
        testId={`${dataTestId}-fallback-blocked`}
      />
      {status && (
        <div
          role="status"
          className="text-s fg-secondary"
          data-testid={`${dataTestId}-fallback-status`}
        >
          {status}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {renderSignIn(copy.signInAction)}
        {actionableFallback && (
          <Button
            variant="secondary"
            size="lg"
            className="w-full"
            data-testid={`${dataTestId}-guest-fallback`}
            disabled={busy}
            onClick={actionableFallback.onActivate}
          >
            {spinner(`${dataTestId}-guest-fallback-spinner`)}
            {copy.fallbackAction}
          </Button>
        )}
      </div>
    </div>
  );
}

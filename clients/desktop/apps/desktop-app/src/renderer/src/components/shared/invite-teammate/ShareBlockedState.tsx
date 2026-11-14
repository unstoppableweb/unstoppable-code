import type { JSX, ReactNode } from 'react';
import { ErrorBanner, Heading } from '@canopy/ui-shared/components';

export interface ShareBlockedStateProps {
  /**
   * Both are optional because one caller has no message of its own: the setup
   * CTA supplies its whole message through `children`, and typing these as
   * required strings only got it two empty paragraphs' worth of gap in the
   * stack.
   */
  title?: string;
  description?: string;
  /** Rendered above the message, e.g. the organization picker. */
  header?: ReactNode;
  /** Rendered after the message, e.g. a setup CTA. */
  children?: ReactNode;
  /**
   * A failure from this state's own primary action, announced in place.
   *
   * Separate from `description` so a retryable failure reads as an event that
   * just happened rather than as part of the standing explanation, and so it
   * can be announced without re-announcing the whole refusal.
   */
  actionError?: string | null;
  /** Marks the body busy while the frame's recovery action is running. */
  busy?: boolean;
  dataTestId: string;
}

/**
 * The refusal body. `ShareDialogFrame` owns every action in the footer so a
 * gate cannot drift back to its own button row.
 *
 * Every refusal that reaches here follows `ShareSetupCta`'s honesty rule - it
 * either offers an action this user can perform, or it names who can and
 * stops. It must never promise a fix the user cannot carry out.
 */
export function ShareBlockedState({
  title,
  description,
  header,
  children,
  actionError,
  busy,
  dataTestId,
}: ShareBlockedStateProps): JSX.Element {
  return (
    <div
      className="flex flex-col px-6 py-6 gap-3"
      data-testid={dataTestId}
      aria-busy={busy ? 'true' : undefined}
    >
      {header}
      {(title || description) && (
        <div className={`flex flex-col gap-3${header ? ' pt-2' : ''}`}>
          {title && (
            <Heading level={3} variant="section">
              {title}
            </Heading>
          )}
          {description && <p className="text-xs fg-secondary">{description}</p>}
        </div>
      )}
      {children}
      <ErrorBanner
        errorSource="shared-container-invite-github-error"
        className=""
        error={actionError}
        testId="shared-container-invite-github-error"
      />
    </div>
  );
}

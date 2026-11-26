'use client';

import { useId, type JSX, type ReactNode } from 'react';
import { CloseMediumIcon } from '../icons/AppIcons';
import { BusyLabel } from '../primitives/BusyLabel';
import { Button } from '../primitives/Button';
import { ComposerDrawerSection } from './ComposerDrawer';
import { Notice, NoticeButton } from '../primitives/Notice';

/**
 * Where a tip sits. `inline` heads a page or panel body as its own card;
 * `composer` is a section of the chat composer's top `ComposerDrawer`.
 */
export type OnboardingTipPlacement = 'inline' | 'composer';

/** An optional verb that does what the tip describes (`Open Library`). */
export interface OnboardingTipAction {
  /** A node, so a private part (an account login) can be replay-blocked. */
  readonly label: ReactNode;
  readonly onClick: () => void;
  readonly testId?: string;
  /** Names the subject when several tips share a verb (`Connect: Linear`). */
  readonly ariaLabel?: string;
  /** The verb's work is running: the button stays, but a click does nothing. */
  readonly busy?: boolean;
  /** Shown while busy under the `text` loading style. */
  readonly busyText?: string;
  /** `primary` when the verb is the tip's point (`Star on GitHub`). */
  readonly variant?: 'primary' | 'secondary';
}

export interface OnboardingTipProps {
  readonly placement: OnboardingTipPlacement;
  /** The feature's own glyph, drawn in the quiet tertiary ink. */
  readonly icon: ReactNode;
  /** What the user might not know, in a few words. No "Tip:" prefix. */
  readonly title: ReactNode;
  /** One sentence. */
  readonly children: ReactNode;
  /** Acting on the tip; the host dismisses the tip when it runs. */
  readonly action?: OnboardingTipAction;
  /** Got it and the close button both call this. */
  readonly onDismiss: () => void;
  /**
   * How a `composer` tip draws. `drawer` (default): a section of the
   * composer's `ComposerDrawer`. `notice`: the shared composer `Notice`, a
   * banner of its own above the drawer (Compact queue's tabbed drawer).
   */
  readonly appearance?: 'drawer' | 'notice';
  /**
   * The text dismiss button's label. `null` leaves only the close button,
   * for a tip whose action is the point (`Connect`) rather than the reading.
   */
  readonly dismissLabel?: string | null;
  /** The close button's accessible name when it needs the tip's subject. */
  readonly dismissAriaLabel?: string;
  /**
   * Keeps the title and the sentence to one line each, ending in an
   * ellipsis, for copy that carries a user-supplied name.
   */
  readonly truncate?: boolean;
  /** Announce a draft-triggered tip politely without moving focus. */
  readonly announce?: boolean;
  /** Placement only (margins); the surface and type are owned here. */
  readonly className?: string;
  readonly 'data-testid'?: string;
  /** Host markers on the tip's outer element (`data-connector-offer`). */
  readonly [dataAttribute: `data-${string}`]: string | undefined;
}

/**
 * The one onboarding tip (CAN-4904): a title, one sentence, a "Got it"
 * capsule and a close button that is always visible, never only on hover.
 * Hosts decide which tip shows and remember dismissals; this component only
 * draws one. Capsule controls throughout: the close button is the shared
 * 28px icon circle and every action is the shared 28px pill.
 */
export function OnboardingTip({
  placement,
  icon,
  title,
  children,
  action,
  onDismiss,
  appearance = 'drawer',
  dismissLabel = 'Got it',
  dismissAriaLabel = 'Dismiss tip',
  truncate = false,
  announce = false,
  className = '',
  'data-testid': testId,
  ...dataAttributes
}: OnboardingTipProps): JSX.Element {
  const titleId = useId();
  const gotIt =
    dismissLabel === null ? null : (
      <Button
        variant="secondary"
        size="sm"
        onClick={onDismiss}
        data-testid={testId ? `${testId}-got-it` : undefined}
      >
        {dismissLabel}
      </Button>
    );
  const verb = action ? (
    <Button
      variant={action.variant ?? 'secondary'}
      size="sm"
      aria-label={action.ariaLabel}
      aria-busy={action.busy || undefined}
      aria-disabled={action.busy || undefined}
      onClick={(): void => {
        if (action.busy) return;
        action.onClick();
      }}
      data-testid={action.testId}
    >
      <BusyLabel busy={action.busy === true} busyText={action.busyText}>
        {action.label}
      </BusyLabel>
    </Button>
  ) : null;
  const close = (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label={dismissAriaLabel}
      onClick={onDismiss}
      data-testid={testId ? `${testId}-dismiss` : undefined}
    >
      <CloseMediumIcon size={16} aria-hidden="true" />
    </Button>
  );
  const glyph = (
    <span
      aria-hidden="true"
      className="flex h-5 w-5 shrink-0 items-center justify-center fg-tertiary"
    >
      {icon}
    </span>
  );
  const copy = (
    <div className="min-w-0 flex-1">
      <div
        id={titleId}
        className={`font-medium fg-primary ${truncate ? 'truncate' : 'text-balance'}`}
      >
        {title}
      </div>
      <div
        className={`mt-0.5 fg-secondary ${truncate ? 'truncate' : 'text-pretty'}`}
      >
        {children}
      </div>
    </div>
  );

  if (placement === 'composer' && appearance === 'notice') {
    // A banner of its own: the composer notice, its glyph in the quiet ink,
    // the tip's verb and Got it (unless the tip drops it) as the notice's
    // actions, then its close.
    return (
      <Notice
        intent="neutral"
        icon={icon}
        title={title}
        actions={
          <>
            {action ? (
              <NoticeButton
                variant={action.variant ?? 'secondary'}
                aria-label={action.ariaLabel}
                busy={action.busy}
                busyLabel={action.busyText}
                aria-disabled={action.busy || undefined}
                onClick={(): void => {
                  if (!action.busy) action.onClick();
                }}
                data-testid={action.testId}
              >
                {action.label}
              </NoticeButton>
            ) : null}
            {dismissLabel === null ? null : (
              <NoticeButton
                variant="secondary"
                onClick={onDismiss}
                data-testid={testId ? `${testId}-got-it` : undefined}
              >
                {dismissLabel}
              </NoticeButton>
            )}
          </>
        }
        onDismiss={onDismiss}
        dismissLabel="Dismiss tip"
        dismissTestId={testId ? `${testId}-dismiss` : undefined}
        className={className}
        data-testid={testId}
        data-onboarding-tip-placement="notice"
      >
        {children}
      </Notice>
    );
  }

  if (placement === 'composer') {
    // A section of the composer's drawer, above its background work: the
    // drawer draws the surface, and the glyph sits in the column the
    // background header's glyph uses, so the two read as one drawer.
    return (
      <ComposerDrawerSection
        {...dataAttributes}
        role={announce ? 'status' : 'note'}
        aria-live={announce ? 'polite' : undefined}
        aria-labelledby={titleId}
        data-testid={testId}
        data-onboarding-tip-placement="composer"
        className={className}
      >
        <div className="flex min-w-0 items-center gap-1.5 py-1 pl-1 text-xs">
          <span
            aria-hidden="true"
            className="flex w-6 shrink-0 justify-center fg-tertiary"
          >
            {icon}
          </span>
          {copy}
          <div className="flex shrink-0 items-center gap-1">
            {verb ?? gotIt}
            {close}
          </div>
        </div>
      </ComposerDrawerSection>
    );
  }

  // The close button sits 8px from the top and right edges, so its circle
  // nests in the card's corner instead of crossing it.
  return (
    <div
      {...dataAttributes}
      role={announce ? 'status' : 'note'}
      aria-live={announce ? 'polite' : undefined}
      aria-labelledby={titleId}
      data-testid={testId}
      data-onboarding-tip-placement="inline"
      className={`relative flex items-start gap-2.5 rounded-xl bg-secondary py-3 pl-3.5 pr-11 text-xs shadow-xs ring-[length:var(--border-hairline)] ring-line-secondary ${className}`}
    >
      {glyph}
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {copy}
        {gotIt !== null || verb !== null ? (
          <div className="flex flex-wrap items-center gap-2">
            {gotIt}
            {verb}
          </div>
        ) : null}
      </div>
      <div className="absolute top-2 right-2">{close}</div>
    </div>
  );
}

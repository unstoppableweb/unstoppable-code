'use client';

import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react';
import { DialogModal } from '../primitives/DialogModal';
import { focusableWithin } from '../lib/focusable';
import { Button } from '../primitives/Button';

/**
 * The install review for a shared resource (CAN-3710): one small dialog with
 * the item's name and type, who shared it, a short plain-text description,
 * what installing it does, any input the install cannot proceed without, and
 * exactly one primary action.
 *
 * There is no Cancel: the close button, Escape and the backdrop dismiss it,
 * and all three are inert while `busy` so an install is never abandoned
 * halfway. Warnings, opt-ins and dependency lists deliberately have no slot;
 * setup a result still needs is shown where the install lands.
 *
 * Focus moves into the review on open (the close button first, never the
 * primary), Tab stays inside it, and closing returns focus to the opener.
 */

export interface ShareInstallDialogPrimary {
  readonly label: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** Shows the button's own spinner; `busyLabel` replaces the label meanwhile. */
  readonly busy?: boolean;
  readonly busyLabel?: string;
  readonly testId?: string;
  readonly spinnerTestId?: string;
}

export interface ShareInstallDialogProps {
  /** The item's name, or a placeholder (`Shared skill`) while it loads. */
  readonly title: ReactNode;
  /** The item's type (`Skill`, `Plugin`, `Project`, …). */
  readonly typeLabel?: string;
  /** Who shared it. A node, so the host can block the person's name from replay. */
  readonly publisher?: ReactNode;
  /** Plain text, clamped to about three lines. */
  readonly description?: string;
  /** One line on what installing does: where the copy lands and how it updates. */
  readonly effect?: ReactNode;
  /** Required inputs only, with defaults preselected wherever possible. */
  readonly inputs?: ReactNode;
  /** One line for a genuine blocker or the install's progress. */
  readonly blocker?: ReactNode;
  /** A one-line installed status, shown in place of a blocker. */
  readonly status?: ReactNode;
  readonly statusTestId?: string;
  /** The loading state's body. */
  readonly loading?: ReactNode;
  /** Omitted while there is nothing to do (loading, or a dead end). */
  readonly primary?: ShareInstallDialogPrimary;
  /** The installed ⋯ menu, beside the primary. */
  readonly menu?: ReactNode;
  /** True while the install writes: every close affordance is inert. */
  readonly busy?: boolean;
  readonly onClose: () => void;
  readonly dataTestId?: string;
  readonly titleId?: string;
}

export function ShareInstallDialog({
  title,
  typeLabel,
  publisher,
  description,
  effect,
  inputs,
  blocker,
  status,
  statusTestId = 'share-install-status',
  loading,
  primary,
  menu,
  busy = false,
  onClose,
  dataTestId = 'share-install-dialog',
  titleId = 'share-install-dialog-title',
}: ShareInstallDialogProps): JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const primaryDisabled = primary?.disabled === true || primary?.busy === true;
  // Disabling or removing the focused primary can drop focus to the page.
  // Prefer the remaining Tab stop (normally close); when every control is
  // busy, the body holds focus and DialogModal prevents Tab from escaping.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const doc = body.ownerDocument;
    const active = doc.activeElement;
    const card = body.closest('[role="dialog"]');
    const stranded =
      active === null ||
      active === doc.body ||
      (card !== null &&
        card.contains(active) &&
        active.hasAttribute('disabled'));
    if (stranded) {
      const target =
        card instanceof HTMLElement ? focusableWithin(card)[0] : undefined;
      (target ?? body).focus({ preventScroll: true });
    }
  }, [busy, primaryDisabled, primary === undefined, loading !== undefined]);
  const subtitle =
    typeLabel !== undefined || publisher !== undefined ? (
      <>
        {typeLabel !== undefined && (
          <span data-testid="share-install-type-label">{typeLabel}</span>
        )}
        {typeLabel !== undefined && publisher !== undefined && ' · '}
        {publisher !== undefined && (
          <span data-testid="share-install-publisher" className="break-words">
            {publisher}
          </span>
        )}
      </>
    ) : undefined;
  return (
    <DialogModal
      title={title}
      subtitle={subtitle}
      titleId={titleId}
      maxWidth="md"
      onClose={busy ? (): void => undefined : onClose}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeButtonDisabled={busy}
      headerSpacing="tight"
      headerBorder={false}
      dataTestId={dataTestId}
      trapFocus
    >
      <div
        ref={bodyRef}
        tabIndex={-1}
        className="flex flex-col gap-3 outline-none"
      >
        {loading}
        {description !== undefined && description !== '' && (
          <p
            data-testid="share-install-description"
            title={description}
            className="line-clamp-3 text-s fg-secondary"
          >
            {description}
          </p>
        )}
        {effect !== undefined && effect !== null && effect !== '' && (
          <p
            data-testid="share-install-effect"
            className="break-words text-s fg-secondary"
          >
            {effect}
          </p>
        )}
        {inputs !== undefined && inputs !== null && (
          <div
            data-testid="share-install-inputs"
            className="flex flex-col gap-2"
          >
            {inputs}
          </div>
        )}
        {/* Each region is mounted before its text arrives, so assistive technology announces it; `contents` adds no gap while empty. */}
        <div role="status" className="contents">
          {blocker !== undefined && blocker !== null && blocker !== '' && (
            <p
              data-testid="share-install-blocker"
              className="text-s fg-secondary"
            >
              {blocker}
            </p>
          )}
        </div>
        <div role="status" className="contents">
          {status !== undefined && status !== null && status !== '' && (
            <p data-testid={statusTestId} className="text-s fg-secondary">
              {status}
            </p>
          )}
        </div>
        {(primary !== undefined || menu !== undefined) && (
          <div className="flex items-center justify-end gap-2 pt-1">
            {menu}
            {primary !== undefined && (
              <Button
                type="button"
                variant="primary"
                size="lg"
                data-testid={primary.testId ?? 'share-install-primary'}
                disabled={primary.disabled === true}
                loading={primary.busy === true}
                {...(primary.busyLabel !== undefined
                  ? { loadingLabel: primary.busyLabel }
                  : {})}
                {...(primary.spinnerTestId !== undefined
                  ? { spinnerTestId: primary.spinnerTestId }
                  : {})}
                onClick={primary.onClick}
              >
                {primary.label}
              </Button>
            )}
          </div>
        )}
      </div>
    </DialogModal>
  );
}

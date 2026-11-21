'use client';

import { ButtonLink } from './ButtonLink';
import type { JSX, RefObject } from 'react';
import { useRef } from 'react';
import type { ReleaseNotesEntry } from '@canopy/protocol/release-notes';
import { Button } from './Button';
import { DialogModal } from './DialogModal';
import { ReleaseHighlightsList } from './ReleaseHighlightsList';

export interface ReleaseHighlightsDialogProps {
  /** Product name from the host's brand runtime. */
  readonly appName: string;
  /** Entry with brand tokens already applied. */
  readonly entry: ReleaseNotesEntry;
  readonly onClose: () => void;
  /**
   * Destination for "View full release notes". Rendered as a real link when
   * no `onOpenFullNotes` callback is supplied.
   */
  readonly fullNotesHref?: string | null;
  /**
   * Host-owned opener (for example, the desktop external-open bridge). When
   * supplied, the action is a button that invokes it; the dialog stays open
   * and a rejection is swallowed so it never surfaces as an unhandled promise.
   */
  readonly onOpenFullNotes?: () => void | Promise<void>;
  /** Where focus lands on close if the opening control is gone. */
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
  readonly dataTestId?: string;
}

export function ReleaseHighlightsDialog({
  appName,
  entry,
  onClose,
  fullNotesHref,
  onOpenFullNotes,
  restoreFocusRef,
  dataTestId = 'release-highlights-dialog',
}: ReleaseHighlightsDialogProps): JSX.Element {
  const gotItRef = useRef<HTMLButtonElement | null>(null);

  const openNotes = (): void => {
    if (!onOpenFullNotes) return;
    try {
      void Promise.resolve(onOpenFullNotes()).catch((): void => undefined);
    } catch {
      // A synchronous host failure must not close or break the dialog.
    }
  };

  let fullNotesAction: JSX.Element | null = null;
  if (onOpenFullNotes) {
    fullNotesAction = (
      <Button
        variant="secondary"
        size="lg"
        onClick={openNotes}
        data-testid="release-highlights-full-notes"
      >
        View full release notes
      </Button>
    );
  } else if (fullNotesHref) {
    fullNotesAction = (
      <ButtonLink
        href={fullNotesHref}
        target="_blank"
        rel="noopener noreferrer"
        variant="secondary"
        size="lg"
        data-testid="release-highlights-full-notes"
      >
        View full release notes
      </ButtonLink>
    );
  }

  return (
    <DialogModal
      title={`What's new in ${appName}`}
      subtitle={`Version ${entry.version}`}
      titleId="release-highlights-dialog-title"
      headerSpacing="tight"
      maxWidth="md"
      onClose={onClose}
      trapFocus
      initialFocusRef={gotItRef}
      restoreFocusRef={restoreFocusRef}
      dataTestId={dataTestId}
      // The body scrolls on its own so the actions stay reachable for long
      // releases and short windows.
      scrollableBody={false}
    >
      <div
        // Focusable, so Safari keyboard users can scroll a long release.
        tabIndex={0}
        role="region"
        aria-label="Release highlights"
        className="focus-ring focus-ring-inset flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain"
      >
        {entry.headline ? (
          <p
            className="text-s fg-secondary"
            data-testid="release-highlights-headline"
          >
            {entry.headline}
          </p>
        ) : null}
        <ReleaseHighlightsList
          highlights={entry.highlights}
          dataTestId="release-highlights-list"
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {fullNotesAction}
        <Button
          ref={gotItRef}
          variant="primary"
          size="lg"
          onClick={onClose}
          data-testid="release-highlights-got-it"
        >
          Got it
        </Button>
      </div>
    </DialogModal>
  );
}

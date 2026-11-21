'use client';

import { memo, type JSX, type MouseEvent, type ReactNode } from 'react';
import type {
  LedgerActorLabel,
  LedgerEntrySearchItem,
  LedgerFileRef,
} from '@canopy/protocol/canopy-core';
import {
  LEDGER_SYNC_STATE_LABELS,
  ledgerEntryShowsStatus,
  ledgerSourceAction,
} from '../../lib/ledger-display';
import { markdownToPlainText } from '../../lib/markdown-plain-text';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { LedgerActorAvatar } from './LedgerActorAvatar';
import {
  LedgerEntryActions,
  LedgerEntryBody,
  LedgerEntryHeader,
  LedgerRelativeTime,
} from './LedgerEntryParts';
import { LedgerEntryOpenArea } from './LedgerEntryDetails';
import { LedgerStatusPill } from './LedgerStatusPill';
import { LedgerEntryTypeAvatar } from './LedgerEntryTypeLabel';
import {
  ledgerActorReplayClass,
  ledgerAttributedActorName,
  type LedgerEntryRowDetails,
} from './ledger-entry-attribution';
import type {
  LedgerDensity,
  LedgerEntrySlots,
  LedgerOpenEntry,
} from './ledger-entry-slots';

/** What one entry needs from the list, beyond its data. */
export interface LedgerEntryPostContext {
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  readonly density: LedgerDensity;
  readonly now: Date;
  readonly timeField: 'createdAt' | 'updatedAt';
  readonly onOpenFile: (
    entry: LedgerEntrySearchItem,
    file: LedgerFileRef,
  ) => void;
  /** Opens an entry, or closes it when it is the open one (null). */
  readonly onToggleOpen: (entryId: string | null) => void;
  /** Opens the entry a correction corrects (the details' "Show the entry this corrects"). */
  readonly onShowEntry?: (entryId: string) => void;
}

/** Inputs for one full entry row. */
export interface LedgerEntryPostProps {
  readonly entry: LedgerEntrySearchItem;
  readonly context: LedgerEntryPostContext;
  readonly details?: LedgerEntryRowDetails;
  readonly slots?: LedgerEntrySlots;
  readonly open?: LedgerOpenEntry | null;
  /** The replies, activity and correction box under this row. */
  readonly children?: ReactNode;
  /** True when the correction's target is already represented by this thread. */
  readonly correctsLoadedEntry?: boolean;
  /** False hides Add correction here; the thread decides where it shows. Defaults to true. */
  readonly canAddCorrection?: boolean;
}

const EMPTY_SLOTS: LedgerEntrySlots = {};

function actionSlotsForOpenEntry(
  slots: LedgerEntrySlots | undefined,
  open: LedgerOpenEntry | null,
  canAddCorrection: boolean,
): LedgerEntrySlots {
  const initial = slots ?? EMPTY_SLOTS;
  const base: LedgerEntrySlots = canAddCorrection
    ? initial
    : {
        ...initial,
        onAddCorrection: undefined,
        addCorrectionLabel: undefined,
        addCorrectionDisabledReason: undefined,
      };
  if (
    base.readOnlyNote !== undefined ||
    open?.view === null ||
    open?.view === undefined
  ) {
    return base;
  }
  const sourceAction =
    open.view.source === null ? null : ledgerSourceAction(open.view.source);
  return { ...base, sourceAction };
}

/**
 * The first paragraph of an entry's content as one line of plain text, a
 * resting row's preview.
 */
function restingPreview(content: string): string {
  return markdownToPlainText(
    content.trim().split(/\r?\n\s*\r?\n/u, 1)[0] ?? '',
  );
}

/**
 * A complete entry row, with its details and thread in the list column. The
 * Feed page and its panel share one layout. Resting, a row is its title with
 * the status and time, then (on the page) who recorded it and where, then a
 * line of its content. Open, the same title and byline lead the whole entry
 * and its details. The title opens and closes the row; a click elsewhere on a
 * resting row opens it.
 */
export const LedgerEntryPost = memo(function LedgerEntryPost({
  entry,
  context,
  details,
  slots,
  open,
  children,
  correctsLoadedEntry,
  canAddCorrection = true,
}: LedgerEntryPostProps): JSX.Element {
  const activeOpen = open?.entryId === entry.entryId ? open : null;
  const isOpen = activeOpen !== null;
  const attribution = details?.attribution;
  const readOnly = slots?.readOnlyNote !== undefined;
  const actionSlots = actionSlotsForOpenEntry(
    slots,
    activeOpen,
    canAddCorrection,
  );
  const pageDensity = context.density === 'page';
  const onShowEntry = context.onShowEntry;
  const supersedesEntryId = entry.supersedesEntryId;
  const onShowCorrectedEntry =
    onShowEntry === undefined ||
    correctsLoadedEntry === true ||
    supersedesEntryId === undefined
      ? undefined
      : (): void => onShowEntry(supersedesEntryId);
  const toggleOpen = (): void =>
    context.onToggleOpen(isOpen ? null : entry.entryId);
  const onRowClick = (event: MouseEvent<HTMLElement>): void => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('button, a, input, textarea, select') !== null) {
      return;
    }
    // The replies and correction box under the row are their own rows.
    if (event.target.closest('[data-row-thread]') !== null) return;
    // An open row closes only from its summary, so selecting text in its
    // body or details never closes it.
    if (isOpen && event.target.closest('[data-row-summary]') === null) return;
    toggleOpen();
  };
  const preview = isOpen ? '' : restingPreview(entry.content);

  return (
    <article
      data-testid="ledger-entry-row"
      data-entry-id={entry.entryId}
      data-origin={attribution?.kind}
      aria-current={isOpen ? 'true' : undefined}
      onClick={onRowClick}
      className={`flex gap-3 ${pageDensity ? 'py-4' : 'py-3'}`}
    >
      <LedgerEntryTypeAvatar
        type={entry.type}
        size={pageDensity ? 'large' : 'small'}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div
          data-row-summary
          data-testid="ledger-entry-row-summary"
          className="flex min-w-0 flex-col gap-1"
        >
          <LedgerEntryHeader
            entry={entry}
            actors={context.actors}
            density={context.density}
            now={context.now}
            timeField={context.timeField}
            details={details}
            statusControl={readOnly ? undefined : slots?.statusControl}
            ownerControl={readOnly ? undefined : slots?.ownerControl}
            expanded={isOpen}
            byline={pageDensity || isOpen}
          />
          {preview !== '' && (
            <div
              data-testid="ledger-entry-resting-preview"
              className={`min-w-0 truncate fg-secondary ${pageDensity ? 'text-s' : 'text-xs leading-5'}`}
            >
              <span className={REPLAY_BLOCK_CLASS}>{preview}</span>
            </div>
          )}
        </div>
        {isOpen && (
          <LedgerEntryBody
            entry={entry}
            density={context.density}
            onOpenFile={(file): void => context.onOpenFile(entry, file)}
            title={null}
          />
        )}
        {/* Resting, the actions stay for keyboards and screen readers: Show
            details is how they open the row. They show while focused, so
            the focus ring is visible. */}
        <div
          className={isOpen ? undefined : 'sr-only focus-within:not-sr-only'}
        >
          <LedgerEntryActions
            slots={actionSlots}
            detailsOpen={isOpen}
            onToggleDetails={toggleOpen}
          />
        </div>
        {activeOpen !== null && (
          <LedgerEntryOpenArea
            entry={entry}
            open={activeOpen}
            actors={context.actors}
            attribution={attribution}
            now={context.now}
            showActivity={false}
            onShowCorrectedEntry={onShowCorrectedEntry}
          />
        )}
        <div data-row-thread className="contents">
          {children}
        </div>
      </div>
    </article>
  );
});

/** Inputs for a correction reply shown below its thread root. */
export interface LedgerEntryReplyProps {
  readonly entry: LedgerEntrySearchItem;
  readonly context: LedgerEntryPostContext;
  readonly details?: LedgerEntryRowDetails;
  readonly slots?: LedgerEntrySlots;
  readonly open?: LedgerOpenEntry | null;
  readonly rootEntryId: string;
  /** False hides Add correction here; the thread decides where it shows. Defaults to true. */
  readonly canAddCorrection?: boolean;
}

/** A correction reply, with optional status, actions and its own open details. */
export const LedgerEntryReply = memo(function LedgerEntryReply({
  entry,
  context,
  details,
  slots,
  open,
  rootEntryId,
  canAddCorrection = true,
}: LedgerEntryReplyProps): JSX.Element {
  const activeOpen = open?.entryId === entry.entryId ? open : null;
  const attribution = details?.attribution;
  const readOnly = slots?.readOnlyNote !== undefined;
  const actorName = ledgerAttributedActorName(
    entry.author,
    context.actors,
    attribution,
  );
  const syncState =
    entry.syncState === 'mirrored' ? undefined : entry.syncState;
  const actionSlots = actionSlotsForOpenEntry(
    slots,
    activeOpen,
    canAddCorrection,
  );
  const hasStatus =
    (!readOnly && slots?.statusControl !== undefined) ||
    ledgerEntryShowsStatus(entry);

  return (
    <li
      data-testid="ledger-entry-correction"
      data-entry-id={entry.entryId}
      aria-current={activeOpen === null ? undefined : 'true'}
      className="flex gap-2"
    >
      <LedgerActorAvatar
        kind={entry.author.kind}
        name={actorName}
        size="small"
        localUser={attribution?.kind !== 'teammate'}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="rounded-lg bg-subtle px-3 py-2">
          <span
            className={`${ledgerActorReplayClass(entry.author.kind, attribution?.kind !== 'teammate')} text-xs font-medium fg-primary`}
          >
            {actorName}
          </span>
          {entry.supersedesEntryId !== undefined &&
            entry.supersedesEntryId !== rootEntryId && (
              <p
                data-testid="ledger-entry-correction-target"
                className="text-2xs fg-tertiary"
              >
                Corrects a reply
              </p>
            )}
          <LedgerEntryBody
            entry={entry}
            density={context.density}
            onOpenFile={(file): void => context.onOpenFile(entry, file)}
            title={null}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 px-3 text-2xs fg-tertiary">
          <span>Correction</span>
          <span aria-hidden="true">·</span>
          <LedgerRelativeTime
            iso={entry[context.timeField]}
            now={context.now}
          />
          {hasStatus && (
            <>
              <span aria-hidden="true">·</span>
              {!readOnly && slots?.statusControl !== undefined ? (
                slots.statusControl
              ) : (
                <LedgerStatusPill
                  status={entry.status}
                  data-testid="ledger-entry-row-status"
                />
              )}
            </>
          )}
          {!readOnly && slots?.ownerControl !== undefined && (
            <>
              <span aria-hidden="true">·</span>
              {slots.ownerControl}
            </>
          )}
          {syncState !== undefined && (
            <>
              <span aria-hidden="true">·</span>
              <span
                data-testid="ledger-entry-row-sync"
                data-sync-state={syncState}
                className={
                  syncState === 'repair_needed' ? 'fg-attention' : undefined
                }
              >
                {LEDGER_SYNC_STATE_LABELS[syncState]}
              </span>
            </>
          )}
        </div>
        <LedgerEntryActions
          slots={actionSlots}
          detailsOpen={activeOpen !== null}
          onToggleDetails={(): void =>
            context.onToggleOpen(activeOpen === null ? entry.entryId : null)
          }
        />
        {/* Below the actions, as on a root row, so opening never moves them. */}
        {activeOpen !== null && (
          <div className="px-3">
            <LedgerEntryOpenArea
              entry={entry}
              open={activeOpen}
              actors={context.actors}
              attribution={attribution}
              now={context.now}
              showActivity
            />
          </div>
        )}
      </div>
    </li>
  );
});

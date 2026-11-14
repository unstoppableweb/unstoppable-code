'use client';

import { BusyLabel } from '../BusyLabel';
import { useMemo, type JSX } from 'react';
import type {
  LedgerActorLabel,
  LedgerAuthorDetails,
  LedgerEntrySearchItem,
} from '@canopy/protocol/canopy-core';
import type { LedgerViewEntry } from '@canopy/protocol/ledger-view';
import {
  LEDGER_SYNC_STATE_LABELS,
  formatLedgerDateTime,
  formatLedgerRelativeTime,
  indexLedgerActorLabels,
  ledgerMutationSentenceParts,
  ledgerSourceDescription,
  type LedgerMutationSentencePart,
} from '../../lib/ledger-display';
import { HistoryIcon } from '../../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { Button } from '../Button';
import { Disclosure } from '../Disclosure';
import { ErrorBanner } from '../StatusBlocks';
import {
  ledgerAttributedActorName,
  type LedgerEntryRowAttribution,
} from './ledger-entry-attribution';
import type { LedgerOpenEntry } from './ledger-entry-slots';
import { LedgerActorNameText } from './LedgerEntryParts';
import { Fact, FactList } from '../FactList';

/** One change to an entry, ready to show in its thread. */
export interface LedgerActivityItem {
  readonly key: string;
  readonly text: string;
  /**
   * `text` in pieces, each actor's name its own part. When present the line
   * renders these, so session replay can block a teammate's name.
   */
  readonly parts?: readonly LedgerMutationSentencePart[];
  readonly occurredAt: string;
}

/** Adds the entry read's actor labels, keeping the read's labels current. */
export function ledgerOpenEntryActors(
  actors: Readonly<Record<string, LedgerActorLabel>>,
  view: LedgerViewEntry | null,
): Readonly<Record<string, LedgerActorLabel>> {
  const readActors = indexLedgerActorLabels(view?.entry.actors);
  const readLabels = Object.values(readActors);
  if (readLabels.length === 0) return actors;
  const addsNothing = readLabels.every((label) => {
    const current = actors[label.actorId];
    return (
      current !== undefined &&
      current.kind === label.kind &&
      current.displayName === label.displayName
    );
  });
  return addsNothing ? actors : { ...actors, ...readActors };
}

/** Returns non-create history changes from oldest to newest. */
export function ledgerActivityItems(
  view: LedgerViewEntry | null,
  actors: Readonly<Record<string, LedgerActorLabel>>,
  attribution?: LedgerEntryRowAttribution,
): LedgerActivityItem[] {
  const history = view?.entry.history;
  if (history === undefined || history === null) return [];
  return history.mutations
    .filter((mutation) => mutation.kind !== 'create')
    .sort((left, right) => {
      const difference =
        new Date(left.occurredAt).getTime() -
        new Date(right.occurredAt).getTime();
      return Number.isNaN(difference) ? 0 : difference;
    })
    .map((mutation) => {
      const parts = ledgerMutationSentenceParts(mutation, (actor) =>
        ledgerAttributedActorName(actor, actors, attribution),
      );
      return {
        key: mutation.mutationId,
        text: parts
          .map((part) => (typeof part === 'string' ? part : part.name))
          .join(''),
        parts,
        occurredAt: mutation.occurredAt,
      };
    });
}

export interface LedgerActivityLineProps {
  readonly item: LedgerActivityItem;
  readonly now: Date;
  readonly localUser?: boolean;
}

/** Shows one recorded change and when it happened. */
export function LedgerActivityLine({
  item,
  now,
  localUser = false,
}: LedgerActivityLineProps): JSX.Element {
  return (
    <li
      data-testid="ledger-entry-activity"
      className="flex items-center gap-2 text-2xs fg-tertiary"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center">
        <HistoryIcon size="sm" aria-hidden="true" />
      </span>
      <span className="min-w-0 break-words">
        {item.parts === undefined
          ? item.text
          : item.parts.map((part, index) =>
              typeof part === 'string' ? (
                part
              ) : (
                <LedgerActorNameText
                  key={index}
                  kind={part.actor.kind}
                  name={part.name}
                  localUser={localUser}
                />
              ),
            )}{' '}
        · {formatLedgerRelativeTime(item.occurredAt, now)}
      </span>
    </li>
  );
}

export interface LedgerHistoryMoreProps {
  readonly onLoadMore: () => void;
  readonly loading: boolean;
}

/** Requests the next page of an entry's history. */
export function LedgerHistoryMore({
  onLoadMore,
  loading,
}: LedgerHistoryMoreProps): JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="compact"
      data-testid="ledger-entry-history-more"
      disabled={loading}
      aria-busy={loading}
      onClick={onLoadMore}
    >
      <BusyLabel busy={loading}>Show more changes</BusyLabel>
    </Button>
  );
}

const AUTHOR_DETAIL_LABELS: ReadonlyArray<
  readonly [keyof LedgerAuthorDetails, string]
> = [
  ['harness', 'Harness'],
  ['model', 'Model'],
  ['thinkingEffort', 'Thinking'],
  ['mode', 'Mode'],
];

export interface LedgerEntryDetailsProps {
  readonly entry: LedgerEntrySearchItem;
  readonly view: LedgerViewEntry | null;
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  readonly attribution?: LedgerEntryRowAttribution;
  readonly onShowCorrectedEntry?: () => void;
}

/** Shows an entry's exact details, source and author settings. */
export function LedgerEntryDetails({
  entry,
  view,
  actors,
  attribution,
  onShowCorrectedEntry,
}: LedgerEntryDetailsProps): JSX.Element {
  const detailEntry = view?.entry.entry ?? entry;
  const ownerName = ledgerAttributedActorName(
    detailEntry.owner,
    actors,
    attribution,
  );
  const sourceTarget = view?.source?.target ?? null;
  const authorDetailRows =
    view === null
      ? []
      : AUTHOR_DETAIL_LABELS.flatMap(
          ([key, label]): Array<{ label: string; value: string }> => {
            const value = view.entry.entry.authorDetails[key];
            return typeof value === 'string' ? [{ label, value }] : [];
          },
        );
  const syncState = view?.entry.syncState ?? entry.syncState;

  return (
    <section
      data-testid="ledger-entry-details"
      aria-label="Details"
      className="flex min-w-0 flex-col gap-1.5"
    >
      <FactList labelWidth="6rem" columnGap="3" rowGap="1">
        <Fact valueTone="secondary" label="Added by">
          <LedgerActorNameText
            kind={detailEntry.author.kind}
            localUser={attribution?.kind !== 'teammate'}
            name={ledgerAttributedActorName(
              detailEntry.author,
              actors,
              attribution,
            )}
          />
        </Fact>
        <Fact
          valueTone="secondary"
          label="Owner"
          dataTestId="ledger-entry-detail-owner"
        >
          <LedgerActorNameText
            kind={detailEntry.owner.kind}
            name={ownerName}
            localUser={attribution?.kind !== 'teammate'}
          />
        </Fact>
        {view !== null && (
          <Fact valueTone="secondary" label="Source">
            <div className="flex flex-col gap-1.5">
              <p>
                {ledgerSourceDescription(view.entry.entry.origin, view.source)}
              </p>
              {sourceTarget?.kind === 'summary' && (
                <Disclosure
                  label="Show recorded summary"
                  dataTestId="ledger-entry-summary-snapshot"
                >
                  <div
                    className={`${REPLAY_BLOCK_CLASS} flex flex-col gap-1.5 text-xs fg-secondary`}
                  >
                    <p className="font-medium fg-primary">
                      {sourceTarget.snapshot.title}
                    </p>
                    <p className="whitespace-pre-wrap break-words">
                      {sourceTarget.snapshot.description}
                    </p>
                    {sourceTarget.snapshot.highlights.length > 0 && (
                      <ul className="flex list-disc flex-col gap-1 pl-4">
                        {sourceTarget.snapshot.highlights.map(
                          (highlight, index) => (
                            <li
                              key={`${index}:${highlight}`}
                              className="break-words"
                            >
                              {highlight}
                            </li>
                          ),
                        )}
                      </ul>
                    )}
                    <p className="text-2xs fg-tertiary">
                      {`Generated ${formatLedgerDateTime(sourceTarget.snapshot.generatedAt)}`}
                    </p>
                  </div>
                </Disclosure>
              )}
            </div>
          </Fact>
        )}
        <Fact valueTone="secondary" label="Recorded">
          {formatLedgerDateTime(detailEntry.createdAt)}
        </Fact>
        {detailEntry.updatedAt !== detailEntry.createdAt && (
          <Fact valueTone="secondary" label="Updated">
            {formatLedgerDateTime(detailEntry.updatedAt)}
          </Fact>
        )}
        {authorDetailRows.map(({ label, value }) => (
          <Fact valueTone="secondary" key={label} label={label}>
            {value}
          </Fact>
        ))}
        {syncState !== undefined && (
          <Fact valueTone="secondary" label="Sync">
            <span
              data-testid="ledger-entry-detail-sync"
              data-sync-state={syncState}
              className={
                syncState === 'repair_needed' ? 'fg-attention' : undefined
              }
            >
              {LEDGER_SYNC_STATE_LABELS[syncState]}
            </span>
          </Fact>
        )}
        <Fact valueTone="secondary" label="Revision">
          <span className="tabular-nums">{detailEntry.revision}</span>
        </Fact>
        <Fact valueTone="secondary" label="Entry ID">
          <span className="font-mono text-2xs">{detailEntry.entryId}</span>
        </Fact>
      </FactList>
      {onShowCorrectedEntry !== undefined &&
        detailEntry.supersedesEntryId !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="compact"
            data-testid="ledger-entry-supersedes"
            onClick={onShowCorrectedEntry}
          >
            Show the entry this corrects
          </Button>
        )}
    </section>
  );
}

export interface LedgerEntryOpenAreaProps {
  readonly entry: LedgerEntrySearchItem;
  readonly open: LedgerOpenEntry;
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  readonly attribution?: LedgerEntryRowAttribution;
  readonly now: Date;
  readonly showActivity: boolean;
  readonly onShowCorrectedEntry?: () => void;
}

/** Shows the activity and details revealed for one open entry. */
export function LedgerEntryOpenArea({
  entry,
  open,
  actors,
  attribution,
  now,
  showActivity,
  onShowCorrectedEntry,
}: LedgerEntryOpenAreaProps): JSX.Element {
  const readActors = useMemo(
    () => ledgerOpenEntryActors(actors, open.view),
    [actors, open.view],
  );
  const activityItems = useMemo(
    () => ledgerActivityItems(open.view, readActors, attribution),
    [attribution, open.view, readActors],
  );
  const history = open.view?.entry.history;
  const hasMoreHistory =
    history !== undefined && history !== null && history.nextCursor !== null;

  return (
    <div className="flex flex-col gap-3">
      {open.notice}
      {open.closedExplanation}
      <ErrorBanner
        errorSource="ledger-entry-open-error"
        className=""
        error={open.openError}
        testId="ledger-entry-open-error"
      />
      {open.readState}
      {showActivity && (
        <>
          {activityItems.length > 0 && (
            <ul className="flex flex-col gap-2.5">
              {activityItems.map((item) => (
                <LedgerActivityLine
                  key={item.key}
                  item={item}
                  now={now}
                  localUser={attribution?.kind !== 'teammate'}
                />
              ))}
            </ul>
          )}
          {hasMoreHistory && open.onLoadMoreHistory !== undefined && (
            <LedgerHistoryMore
              onLoadMore={open.onLoadMoreHistory}
              loading={open.loadingMoreHistory ?? false}
            />
          )}
        </>
      )}
      <LedgerEntryDetails
        entry={entry}
        view={open.view}
        actors={readActors}
        attribution={attribution}
        onShowCorrectedEntry={onShowCorrectedEntry}
      />
    </div>
  );
}

'use client';

import type { JSX, ReactNode } from 'react';
import type {
  LedgerActorKind,
  LedgerActorLabel,
  LedgerEntrySearchItem,
  LedgerFileRef,
} from '@canopy/protocol/canopy-core';
import {
  ArchiveIcon,
  BuildingIcon,
  ChatIcon,
  FileIcon,
  MacbookIcon,
  MessageIcon,
  PersonIcon,
  PipelineIcon,
  type AppIcon,
} from '../../icons/AppIcons';
import {
  LEDGER_SYNC_STATE_LABELS,
  formatLedgerFullDateTime,
  formatLedgerRelativeTime,
  ledgerEntryShowsOwner,
  ledgerEntryShowsStatus,
  type LedgerSourceActionGlyph,
} from '../../lib/ledger-display';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '../../lib/replay-privacy';
import { ControlButton, Button } from '../../primitives/Button';
import { Heading } from '../../primitives/Heading';
import { Tooltip } from '../../primitives/Tooltip';
import { WorkPath } from '../WorkPath';
import { LedgerActorGlyph } from './LedgerActorAvatar';
import { LedgerStatusPill } from './LedgerStatusPill';
import {
  ledgerActorReplayClass,
  ledgerAttributedActorName,
  type LedgerEntryRowDetails,
} from './ledger-entry-attribution';
import type { LedgerDensity, LedgerEntrySlots } from './ledger-entry-slots';
import { LedgerEntryMarkdown } from './ledger-entry-markdown';

const ORIGIN_CLASS_NAME = 'inline-flex min-w-0 items-baseline gap-1';
const ORIGIN_ICON_CLASS_NAME = 'shrink-0 self-center';

export interface LedgerRelativeTimeProps {
  readonly iso: string;
  readonly now: Date;
}

/** A relative time whose tooltip shows the full local date and time. */
export function LedgerRelativeTime({
  iso,
  now,
}: LedgerRelativeTimeProps): JSX.Element {
  return (
    <Tooltip label={formatLedgerFullDateTime(iso)}>
      <time dateTime={iso}>{formatLedgerRelativeTime(iso, now)}</time>
    </Tooltip>
  );
}

export interface LedgerEntryHeaderProps {
  readonly entry: LedgerEntrySearchItem;
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  readonly density: LedgerDensity;
  readonly now: Date;
  readonly timeField: 'createdAt' | 'updatedAt';
  readonly details?: LedgerEntryRowDetails;
  readonly statusControl?: ReactNode;
  readonly ownerControl?: ReactNode;
  /** An open entry: the title wraps, and the byline adds the owner and sync. */
  readonly expanded?: boolean;
  /** Who recorded the entry and where; a resting panel row leaves it out. */
  readonly byline?: boolean;
}

/**
 * Heads an entry's row, the same on the Feed page and in its panel: the
 * title, with the status and time at the trailing edge so they line up down
 * the column. Who recorded it follows on a quieter line, behind the glyph of
 * what recorded it (a person, a chat, a delegate, a pipeline agent), then
 * where; an open entry adds its owner and how it syncs. The row's avatar is
 * the type's glyph and names it on hover, so the header never prints it.
 */
export function LedgerEntryHeader({
  entry,
  actors,
  density,
  now,
  timeField,
  details,
  statusControl,
  ownerControl,
  expanded = false,
  byline = true,
}: LedgerEntryHeaderProps): JSX.Element {
  const attribution = details?.attribution;
  const origin = rowOrigin(entry, details);
  const syncState =
    !expanded || entry.syncState === 'mirrored' ? undefined : entry.syncState;
  const status =
    statusControl ??
    (ledgerEntryShowsStatus(entry) ? (
      <LedgerStatusPill
        status={entry.status}
        data-testid="ledger-entry-row-status"
      />
    ) : null);
  const showOwner =
    expanded && (ownerControl !== undefined || ledgerEntryShowsOwner(entry));
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <div className="min-w-0 flex-1">
          {entry.titlePending !== true && (
            <LedgerEntryTitle
              title={entry.title}
              density={density}
              compact={!expanded}
            />
          )}
        </div>
        {status}
        <span className="shrink-0 text-2xs fg-tertiary">
          <LedgerRelativeTime iso={entry[timeField]} now={now} />
        </span>
      </div>
      {byline && (
        // The gap spaces the separators: a flex item drops its own edge spaces.
        <div
          data-testid="ledger-entry-row-byline"
          className={`flex min-w-0 items-center gap-x-1 text-2xs fg-tertiary ${
            expanded ? 'flex-wrap' : 'flex-nowrap overflow-hidden'
          }`}
        >
          <span className="inline-flex min-w-0 shrink items-center gap-1 fg-secondary">
            <span
              aria-hidden="true"
              data-testid="ledger-entry-row-author-icon"
              data-actor-kind={entry.author.kind}
              className="inline-flex shrink-0"
            >
              <LedgerActorGlyph kind={entry.author.kind} size={12} />
            </span>
            <span
              data-testid="ledger-entry-row-author"
              className={`${ledgerActorReplayClass(entry.author.kind, attribution?.kind !== 'teammate')} min-w-0 truncate`}
            >
              {ledgerAttributedActorName(entry.author, actors, attribution)}
            </span>
          </span>
          {origin !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span className="flex min-w-0 shrink items-center gap-x-1 overflow-hidden whitespace-nowrap">
                {origin}
              </span>
            </>
          )}
          {showOwner && (
            <>
              <span aria-hidden="true">·</span>
              {ownerControl !== undefined ? (
                ownerControl
              ) : (
                <span
                  data-testid="ledger-entry-row-owner"
                  className="fg-secondary"
                >
                  Owner:{' '}
                  <LedgerActorNameText
                    kind={entry.owner.kind}
                    localUser={attribution?.kind !== 'teammate'}
                    name={ledgerAttributedActorName(
                      entry.owner,
                      actors,
                      attribution,
                    )}
                  />
                </span>
              )}
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
      )}
    </div>
  );
}

function rowOrigin(
  entry: LedgerEntrySearchItem,
  details: LedgerEntryRowDetails | undefined,
): JSX.Element | null {
  const attribution = rowAttribution(entry, details?.attribution);
  const workPath =
    details?.workPath === undefined ? null : (
      <span className={`min-w-0 text-2xs fg-secondary ${REPLAY_MASK_CLASS}`}>
        <WorkPath parts={details.workPath} testId="ledger-entry-work-path" />
      </span>
    );
  // A work path stands in for the context, after who recorded the row.
  if (workPath !== null) {
    if (attribution === null) return workPath;
    return (
      <>
        {attribution}
        <span aria-hidden="true">·</span>
        {workPath}
      </>
    );
  }
  const context = details?.context;
  if (context === undefined) return attribution;
  // A long context, such as an organization's name, truncates; the title
  // keeps it whole.
  const contextLabel = (
    <span
      data-testid="ledger-entry-row-context"
      className="min-w-0 truncate"
      title={context}
    >
      {context}
    </span>
  );
  if (attribution === null) return contextLabel;
  return (
    <>
      {contextLabel}
      <span aria-hidden="true">·</span>
      {attribution}
    </>
  );
}

/** Who recorded a row elsewhere: a teammate or another device. */
function rowAttribution(
  entry: LedgerEntrySearchItem,
  attribution: LedgerEntryRowDetails['attribution'],
): JSX.Element | null {
  if (attribution?.kind === 'teammate') {
    const ownEntry = entry.author.kind === 'user';
    const Icon = ownEntry ? BuildingIcon : PersonIcon;
    return (
      <span className={`${ORIGIN_CLASS_NAME} fg-secondary`}>
        <Icon size={12} aria-hidden="true" className={ORIGIN_ICON_CLASS_NAME} />
        <span className="sr-only">Teammate: </span>
        <span
          data-testid="ledger-entry-row-teammate"
          className="min-w-0 truncate"
        >
          {/* The teammate's name is blocked from replay; the organization is not. */}
          {!ownEntry && (
            <>
              <span className={REPLAY_BLOCK_CLASS}>{attribution.name}</span>
              {', '}
            </>
          )}
          {attribution.organization}
        </span>
      </span>
    );
  }
  if (attribution?.kind === 'device') {
    return (
      <span className={ORIGIN_CLASS_NAME}>
        <MacbookIcon
          size={12}
          aria-hidden="true"
          className={ORIGIN_ICON_CLASS_NAME}
        />
        <span className="sr-only">Device: </span>
        <span
          data-testid="ledger-entry-row-device"
          className="min-w-0 truncate"
        >
          {attribution.label}
        </span>
      </span>
    );
  }
  return null;
}

export interface LedgerActorNameTextProps {
  readonly kind: LedgerActorKind;
  readonly name: string;
  readonly localUser?: boolean;
}

/** An actor's name; a teammate's is blocked from session replay. */
export function LedgerActorNameText({
  kind,
  name,
  localUser = false,
}: LedgerActorNameTextProps): JSX.Element {
  const replayClassName = ledgerActorReplayClass(kind, localUser);
  return (
    <span className={replayClassName === '' ? undefined : replayClassName}>
      {name}
    </span>
  );
}

export interface LedgerEntryTitleProps {
  readonly title: string;
  readonly density: LedgerDensity;
  readonly compact?: boolean;
}

/** Shows an entry title as text. */
export function LedgerEntryTitle({
  title,
  density,
  compact = false,
}: LedgerEntryTitleProps): JSX.Element {
  // Entry text is agent-written from conversations: replay records a box.
  // The block sits on the text, because a heading's classes must be static.
  return (
    <Heading
      level={3}
      variant={density === 'page' ? 'section' : 'title'}
      truncate={compact}
      data-testid="ledger-entry-row-title"
      className={compact ? 'min-w-0 flex-1' : 'min-w-0 break-words'}
    >
      <span className={REPLAY_BLOCK_CLASS}>{title}</span>
    </Heading>
  );
}

function ledgerFileLabel(file: LedgerFileRef): string {
  return file.startLine === undefined
    ? file.path
    : `${file.path}:${file.startLine}`;
}

export interface LedgerFileChipProps {
  readonly file: LedgerFileRef;
  readonly onOpen: (file: LedgerFileRef) => void;
}

/** Opens a referenced file from an entry. */
export function LedgerFileChip({
  file,
  onOpen,
}: LedgerFileChipProps): JSX.Element {
  const label = ledgerFileLabel(file);
  return (
    <ControlButton
      type="button"
      data-testid="ledger-entry-file-ref"
      aria-label={`Open ${label}`}
      onClick={() => onOpen(file)}
      presentation="ledger-file"
    >
      <FileIcon size={12} aria-hidden="true" className="shrink-0" />
      <span className="truncate">{label}</span>
    </ControlButton>
  );
}

export interface LedgerEntryBodyProps {
  readonly entry: LedgerEntrySearchItem;
  readonly density: LedgerDensity;
  readonly onOpenFile: (file: LedgerFileRef) => void;
  readonly title?: ReactNode | null;
}

/** Shows the title, content, highlights and files of an entry. */
export function LedgerEntryBody({
  entry,
  density,
  onOpenFile,
  title,
}: LedgerEntryBodyProps): JSX.Element {
  const defaultTitle =
    entry.titlePending === true ? null : (
      <LedgerEntryTitle title={entry.title} density={density} />
    );
  return (
    <div className="flex flex-col gap-2">
      {title === undefined ? defaultTitle : title}
      <div className={REPLAY_BLOCK_CLASS}>
        <LedgerEntryMarkdown
          content={entry.content}
          density={density}
          data-testid="ledger-entry-row-content"
        />
      </div>
      {entry.highlights.length > 0 && (
        <ul
          className={`${REPLAY_BLOCK_CLASS} flex list-disc flex-col gap-0.5 pl-5 fg-primary ${density === 'page' ? 'text-s' : 'text-xs'}`}
        >
          {entry.highlights.map((highlight, index) => (
            <li key={`${index}:${highlight}`}>{highlight}</li>
          ))}
        </ul>
      )}
      {entry.referenceFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {entry.referenceFiles.map((file, index) => (
            <LedgerFileChip
              key={`${index}:${file.rootId}:${ledgerFileLabel(file)}`}
              file={file}
              onOpen={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const SOURCE_ACTION_ICONS: Readonly<Record<LedgerSourceActionGlyph, AppIcon>> =
  {
    chat: ChatIcon,
    run: PipelineIcon,
    archived: ArchiveIcon,
  };

export interface LedgerEntryActionsProps {
  readonly slots: LedgerEntrySlots;
  /** Whether this entry's details show; labels the toggle and sets aria-expanded. */
  readonly detailsOpen: boolean;
  /** Shows or hides this entry's details. */
  readonly onToggleDetails: () => void;
}

/**
 * Shows an entry's source action, details toggle and correction action or
 * read-only note. A source action that opens an archived chat takes the
 * archive glyph and says whose chat it is in its tooltip.
 *
 * That tooltip deliberately deviates from DESIGN.md's "A row or button that
 * already shows its label gets no tooltip that repeats or describes it"
 * (Interaction states), on this action only: the label cannot say whether the
 * archived chat is the entry's own or the one that started its delegate.
 */
export function LedgerEntryActions({
  slots,
  detailsOpen,
  onToggleDetails,
}: LedgerEntryActionsProps): JSX.Element {
  const sourceAction = slots.sourceAction ?? null;
  const onOpenSource = slots.onOpenSource;
  const onAddCorrection = slots.onAddCorrection;
  const disabledReason = slots.addCorrectionDisabledReason;
  const addCorrectionDisabled =
    typeof disabledReason === 'string' && disabledReason.length > 0;
  const addCorrection = slots.readOnlyNote === undefined &&
    onAddCorrection !== undefined && (
      <Button
        type="button"
        variant="ghost"
        size="compact"
        data-testid="ledger-entry-add-correction"
        disabled={addCorrectionDisabled}
        aria-description={addCorrectionDisabled ? disabledReason : undefined}
        onClick={onAddCorrection}
      >
        <MessageIcon size={14} aria-hidden="true" />
        {slots.addCorrectionLabel ?? 'Add correction'}
      </Button>
    );
  const SourceIcon =
    sourceAction === null ? null : SOURCE_ACTION_ICONS[sourceAction.glyph];
  const openSource = sourceAction !== null &&
    SourceIcon !== null &&
    onOpenSource !== undefined && (
      <Button
        type="button"
        variant="ghost"
        size="compact"
        data-testid="ledger-entry-source-open"
        data-source-archived={
          sourceAction.glyph === 'archived' ? 'true' : undefined
        }
        onClick={onOpenSource}
      >
        <SourceIcon size={14} aria-hidden="true" />
        {sourceAction.label}
      </Button>
    );
  return (
    <div className="-ml-2.5 flex min-w-0 flex-wrap items-center gap-1">
      {openSource !== false &&
      sourceAction !== null &&
      sourceAction.tooltip !== null ? (
        <Tooltip label={sourceAction.tooltip}>{openSource}</Tooltip>
      ) : (
        openSource
      )}
      <Button
        type="button"
        variant="ghost"
        size="compact"
        data-testid="ledger-entry-details-toggle"
        aria-expanded={detailsOpen}
        onClick={onToggleDetails}
      >
        {detailsOpen ? 'Hide details' : 'Show details'}
      </Button>
      {slots.readOnlyNote !== undefined && (
        <span
          data-testid="ledger-entry-read-only"
          className="px-2.5 py-1.5 text-xs fg-tertiary"
        >
          {slots.readOnlyNote}
        </span>
      )}
      {/* A disabled button takes no pointer events, so the reason's tooltip
          hangs on its wrapper. */}
      {addCorrection !== false && addCorrectionDisabled ? (
        <Tooltip label={disabledReason}>{addCorrection}</Tooltip>
      ) : (
        addCorrection
      )}
    </div>
  );
}

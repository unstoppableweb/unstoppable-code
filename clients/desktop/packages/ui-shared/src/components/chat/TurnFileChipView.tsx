import { memo, useId, type JSX } from 'react';
import { FolderIcon } from '../../icons/AppIcons';
import { TitlebarIconButton } from '../TitlebarIconButton';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import { TOOL_APPROVAL_WAITING_LABEL } from './tool-approval-wait';
import { TURN_FILE_ROW_CLASS_NAME } from './turn-file-styles';

const filenameSegments = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

export interface TurnFileChipReveal {
  /** Accessible name naming the file, such as "Show report.csv in Finder". */
  readonly label: string;
  readonly tooltip: string;
  /** Host-local file-manager name, such as "Open in Finder". */
  readonly actionLabel?: string;
  readonly onReveal: () => void;
}
export interface TurnFileChipViewProps {
  readonly filename: string;
  readonly change?: 'updated';
  /** The change is still in flight: shown, not openable. */
  readonly pending?: boolean;
  /** A pending change held for the person's approval, not yet running. */
  readonly waiting?: boolean;
  readonly opening?: boolean;
  /** Host status (opening, an error); a pending chip says its own otherwise. */
  readonly status?: string;
  readonly location?: string;
  readonly onOpen: () => void;
  readonly reveal?: TurnFileChipReveal;
  /** Header content for a one-file summary, without the list row's insets. */
  readonly presentation?: 'row' | 'summary';
}

function FileReveal({
  reveal,
  describedBy,
}: {
  reveal: TurnFileChipReveal;
  describedBy: string;
}): JSX.Element {
  return (
    <TitlebarIconButton
      icon={FolderIcon}
      foreground="top-bar"
      coarsePointerTarget
      data-testid="turn-file-chip-reveal"
      onClick={reveal.onReveal}
      aria-label={reveal.label}
      aria-describedby={describedBy || undefined}
      tooltipLabel={reveal.tooltip}
    />
  );
}

function FileLabel({ filename }: { filename: string }): JSX.Element {
  const characters = Array.from(
    filenameSegments.segment(filename),
    ({ segment }) => segment,
  );
  const middle = Math.ceil(characters.length / 2);
  return (
    <span className="flex w-full min-w-0 items-center gap-3">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={`${REPLAY_MASK_CLASS} flex min-w-0 fg-primary`}>
          <span className="min-w-0 truncate whitespace-pre">
            {characters.slice(0, middle).join('')}
          </span>
          <span className="flex min-w-0 shrink justify-end overflow-hidden">
            <span className="whitespace-pre">
              {characters.slice(middle).join('')}
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}

/** What a pending chip says: "Creating…", "Updating…" or "Waiting for approval". */
export function turnFilePendingStatus(
  change: 'updated' | undefined,
  waiting: boolean,
): string {
  if (waiting) return TOOL_APPROVAL_WAITING_LABEL;
  return change === 'updated' ? 'Updating…' : 'Creating…';
}

/** Separate preview/reveal controls preserve each host's routing and focus. */
export const TurnFileChipView = memo(function TurnFileChipView({
  filename,
  change,
  pending = false,
  waiting = false,
  opening = false,
  status: hostStatus,
  location,
  onOpen,
  reveal,
  presentation = 'row',
}: TurnFileChipViewProps): JSX.Element {
  const id = useId();
  const locationId = `${id}-location`;
  const statusId = `${id}-status`;
  const shownLocation = pending || hostStatus ? undefined : location;
  const isWaiting = pending && waiting;
  const status = isWaiting
    ? TOOL_APPROVAL_WAITING_LABEL
    : hostStatus || (pending ? turnFilePendingStatus(change, false) : '');
  // A waiting chip is not working on anything yet, so it is never busy.
  const busy = !isWaiting && (opening || pending);
  const disabled = opening || pending;
  const describedBy = [
    shownLocation ? locationId : undefined,
    status ? statusId : undefined,
  ]
    .filter((value) => value !== undefined)
    .join(' ');
  return (
    <div
      data-testid="turn-file-chip"
      data-file-change={change ?? 'created'}
      data-file-approval={isWaiting ? 'waiting' : undefined}
      className={
        presentation === 'summary'
          ? '@container/turn-file group/turn-file flex min-w-0 flex-1 cursor-default select-none items-center gap-3 text-s'
          : `@container/turn-file group/turn-file relative cursor-default select-none ${TURN_FILE_ROW_CLASS_NAME}`
      }
    >
      <button
        type="button"
        data-testid="turn-file-chip-open"
        onClick={disabled ? undefined : onOpen}
        aria-label={
          isWaiting
            ? `${filename}, ${TOOL_APPROVAL_WAITING_LABEL.toLowerCase()}`
            : pending
              ? `${change === 'updated' ? 'Updating' : 'Creating'} ${filename}`
              : `Open ${filename}`
        }
        aria-busy={busy}
        aria-disabled={disabled}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        className={`focus-ring focus-ring-stretched inline-flex min-h-8 min-w-0 max-w-3/5 shrink items-center rounded-sm text-left before:absolute ${presentation === 'summary' ? 'before:inset-1 before:rounded-lg' : 'focus-ring-inset before:inset-0 before:rounded-[calc(var(--radius-xl)-5px)]'} aria-disabled:cursor-default pointer-coarse:min-h-11`}
      >
        <FileLabel filename={filename} />
      </button>
      {status && (
        <span
          id={statusId}
          role="status"
          data-testid="turn-file-chip-status"
          className="relative z-10 block min-w-0 max-w-2/5 shrink-0 truncate whitespace-nowrap text-xs fg-tertiary"
        >
          {status}
        </span>
      )}
      {shownLocation && (
        <span
          id={locationId}
          data-testid="turn-file-chip-location"
          className={`${REPLAY_MASK_CLASS} relative z-10 block min-w-0 max-w-2/5 shrink-0 truncate text-xs fg-secondary`}
        >
          {shownLocation}
        </span>
      )}
      {reveal && !pending && (
        <span
          className={`relative z-10 ml-auto inline-flex shrink-0 p-1 ${presentation === 'summary' ? '' : '-mr-2'}`}
        >
          <FileReveal reveal={reveal} describedBy={describedBy} />
        </span>
      )}
    </div>
  );
});

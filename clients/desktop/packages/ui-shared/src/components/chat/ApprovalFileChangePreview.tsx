import { Badge } from '../../primitives/Badge';
import { useMemo, type JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { Button } from '../../primitives/Button';
import {
  APPROVAL_FILE_CHANGE_COMPACT_LIMITS,
  APPROVAL_FILE_CHANGE_EXPANDED_LIMITS,
  approvalFileChangeExpansionCopy,
  buildApprovalFileChangeRows,
  type ApprovalFileChangeEndingMarker,
  type ApprovalFileChangeInput,
  type ApprovalFileChangeRow,
} from './approval-file-change-rows';

export interface ApprovalFileChangePreviewProps {
  change: ApprovalFileChangeInput;
  /** `compact` applies the card limits; `expanded` shows every supplied line. */
  mode: 'compact' | 'expanded';
  /** Opens the expanded view. Only offered in compact mode when rows were hidden. */
  onExpand?: () => void;
}

const SIGN: Record<'context' | 'deleted' | 'added' | 'content', string> = {
  context: ' ',
  deleted: '−',
  added: '+',
  content: ' ',
};

/** Read before each row so the change is clear without color. */
const SCREEN_READER_PREFIX: Record<
  'context' | 'deleted' | 'added' | 'content',
  string
> = {
  context: 'Unchanged line: ',
  deleted: 'Deleted line: ',
  added: 'Added line: ',
  content: '',
};

const ROW_CLASS: Record<'context' | 'deleted' | 'added' | 'content', string> = {
  context: 'fg-secondary',
  deleted: 'bg-destructive-subtle fg-destructive-strong',
  added: 'bg-success-subtle fg-success-strong',
  content: 'fg-primary/80',
};

const ENDING_LABEL: Record<ApprovalFileChangeEndingMarker, string> = {
  crlf: 'CRLF',
  'no-final-newline': 'No newline at end',
};

function omittedLabel(
  block: 'deleted' | 'added' | 'content',
  count: number,
): string {
  const lines = count === 1 ? 'line' : 'lines';
  if (block === 'content') return `${count} more ${lines}`;
  return `${count} more ${block} ${lines}`;
}

function ChangeRow({ row }: { row: ApprovalFileChangeRow }): JSX.Element {
  if (row.kind === 'omitted') {
    return (
      <li
        data-row-kind="omitted"
        className="px-2 py-0.5 font-sans italic fg-secondary"
      >
        {omittedLabel(row.block, row.count)}
      </li>
    );
  }
  return (
    <li
      data-row-kind={row.kind}
      className={`flex min-w-max gap-2 px-2 ${ROW_CLASS[row.kind]}`}
    >
      <span aria-hidden="true" className="w-2 shrink-0 select-none">
        {SIGN[row.kind]}
      </span>
      <span className="whitespace-pre">
        {SCREEN_READER_PREFIX[row.kind] && (
          <span className="sr-only">{SCREEN_READER_PREFIX[row.kind]}</span>
        )}
        {row.text}
        {row.shortened && (
          <span data-testid="approval-file-change-shortened">
            <span aria-hidden="true">…</span>
            <span className="sr-only"> (line shortened)</span>
          </span>
        )}
      </span>
      {row.text.length === 0 && !row.shortened && (
        <span
          data-testid="approval-file-change-blank"
          className="select-none font-sans italic fg-secondary"
        >
          Blank line
        </span>
      )}
      {row.endingMarker && (
        <span className="inline-flex shrink-0 select-none font-sans">
          <Badge size="compact" data-testid="approval-file-change-ending">
            {ENDING_LABEL[row.endingMarker]}
          </Badge>
        </span>
      )}
    </li>
  );
}

type ExpandedSourceRow = Exclude<ApprovalFileChangeRow, { kind: 'omitted' }>;

/** Compact ranges keep annotation text bounded even for thousands of blanks. */
function lineRanges(
  rows: readonly ExpandedSourceRow[],
  matches: (row: ExpandedSourceRow) => boolean,
): string {
  const ranges: string[] = [];
  let first = 0;
  let last = 0;
  const flush = (): void => {
    if (first > 0)
      ranges.push(first === last ? `${first}` : `${first}–${last}`);
  };
  rows.forEach((row, index) => {
    if (!matches(row)) return;
    const line = index + 1;
    if (line !== last + 1) {
      flush();
      first = line;
    } else if (first === 0) first = line;
    last = line;
  });
  flush();
  return ranges.join(', ');
}

/** Expanded content keeps source text separate from block-level annotations. */
function ExpandedChangeRows({
  rows,
}: {
  rows: readonly ApprovalFileChangeRow[];
}): JSX.Element {
  const blocks: {
    kind: ExpandedSourceRow['kind'];
    rows: ExpandedSourceRow[];
  }[] = [];
  for (const row of rows) {
    // Expanded row construction has no display limits or omission rows.
    if (row.kind === 'omitted') continue;
    const last = blocks[blocks.length - 1];
    if (last?.kind === row.kind) last.rows.push(row);
    else blocks.push({ kind: row.kind, rows: [row] });
  }
  return (
    <>
      {blocks.map((block, index) => {
        const blanks = lineRanges(block.rows, (row) => row.text.length === 0);
        const crlf = lineRanges(
          block.rows,
          (row) => row.endingMarker === 'crlf',
        );
        const noFinalNewline = block.rows.some(
          (row) => row.endingMarker === 'no-final-newline',
        );
        return (
          <li
            key={index}
            data-row-kind={block.kind}
            className={`min-w-max px-2 ${ROW_CLASS[block.kind]}`}
          >
            <span className="sr-only">
              {block.kind === 'deleted' && 'Deleted lines: '}
              {block.kind === 'added' && 'Added lines: '}
              {block.kind === 'context' && 'Unchanged lines: '}
            </span>
            {(blanks || crlf || noFinalNewline) && (
              <div
                data-testid="approval-file-change-annotations"
                className="font-sans text-2xs fg-secondary"
              >
                {blanks && <div>Blank lines in this block: {blanks}</div>}
                {crlf && <div>CRLF lines in this block: {crlf}</div>}
                {noFinalNewline && (
                  <div>{ENDING_LABEL['no-final-newline']}</div>
                )}
              </div>
            )}
            <div
              data-testid="approval-file-change-block-text"
              className="whitespace-pre"
            >
              {block.rows
                .map((row) => `${SIGN[row.kind]} ${row.text}`)
                .join('\n')}
            </div>
          </li>
        );
      })}
    </>
  );
}

/**
 * The text an Edit or Write approval proposes (CAN-5165). Compact mode is the
 * card's bounded preview; expanded mode removes the display limits but cannot
 * restore text capped before delivery, so that warning persists. All supplied
 * text renders as escaped text, and the root blocks session replay.
 */
export function ApprovalFileChangePreview({
  change,
  mode,
  onExpand,
}: ApprovalFileChangePreviewProps): JSX.Element {
  const result = useMemo(
    () =>
      buildApprovalFileChangeRows(
        change,
        mode === 'compact'
          ? APPROVAL_FILE_CHANGE_COMPACT_LIMITS
          : APPROVAL_FILE_CHANGE_EXPANDED_LIMITS,
      ),
    [change, mode],
  );
  const label = change.kind === 'edit' ? 'Proposed edit' : 'Proposed content';
  const expansion = approvalFileChangeExpansionCopy(result.sourceTruncated);
  const canExpand = mode === 'compact' && result.previewTruncated && onExpand;

  return (
    <div
      data-testid="approval-file-change-preview"
      data-mode={mode}
      className={`${REPLAY_BLOCK_CLASS} flex min-w-0 flex-col gap-1`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 text-2xs fg-secondary">
        <span>{label}</span>
        {change.kind === 'edit' && change.replaceAll === true && (
          <span data-testid="approval-file-change-replace-all">
            Replaces every occurrence
          </span>
        )}
      </div>
      {result.sourceTruncated && (
        <div
          data-testid="approval-file-change-source-truncated"
          role="note"
          className="text-2xs fg-secondary"
        >
          Part of the requested change is too long to show and is unavailable.
        </div>
      )}
      {result.state === 'changes' ? (
        <ul
          data-testid="approval-file-change-rows"
          aria-label={label}
          className={`overflow-x-auto rounded bg-fg-primary/[0.06] py-1 font-mono ${
            mode === 'compact' ? 'text-2xs' : 'text-xs'
          }`}
        >
          {mode === 'expanded' ? (
            <ExpandedChangeRows rows={result.rows} />
          ) : (
            result.rows.map((row, index) => <ChangeRow key={index} row={row} />)
          )}
        </ul>
      ) : (
        <div
          data-testid="approval-file-change-state"
          className="rounded bg-fg-primary/[0.06] px-2 py-1.5 text-2xs italic fg-secondary"
        >
          {result.state === 'empty' && 'Empty content'}
          {result.state === 'unchanged' && 'No text change'}
          {result.state === 'indeterminate' &&
            'No difference in the available text'}
        </div>
      )}
      {canExpand && (
        // The link action takes the size of the copy around it.
        <div className="text-2xs">
          <Button
            variant="link"
            data-testid="approval-file-change-expand"
            onClick={onExpand}
          >
            {expansion.action}
          </Button>
        </div>
      )}
    </div>
  );
}

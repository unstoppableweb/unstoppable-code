'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  buildKeepEditsPrompt,
  formatOverlapEditSpan,
  summarizeOverlapEdits,
  useFileViewerStore,
  type FileOverlapComparison,
  type FileViewerSession,
  type OverlapChoice,
  type OverlapEditConsequence,
  type OverlapEditSpan,
  type OverlapQuoteSegment,
  type OverlapRegion,
  type OverlapSideEdits,
} from '@canopy/app-state';
import {
  Button,
  ChoiceList,
  ChoiceMark,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared/components';
import { SparkleIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { isProseFilePath } from './file-kind';

/** Quotes longer than this show collapsed until expanded. */
const COLLAPSED_QUOTE_LINES = 6;
/** A single line longer than this also collapses (very long lines wrap). */
const COLLAPSED_QUOTE_CHARS = 480;

export interface FileOverlapNoticeProps {
  readonly session: FileViewerSession;
  readonly overlap: FileOverlapComparison;
  /**
   * Moves focus to the viewer (Save, else the header) when an action inside
   * the notice removes it.
   */
  readonly onFocusFallback: () => void;
  /**
   * The last explicit save request this viewer has focused. Owned by the
   * viewer so switching presentations does not focus the notice again.
   */
  readonly handledFocusRequestRef: RefObject<number>;
  readonly appName?: string;
  /**
   * Inserts a follow-up draft into the file's chat. Shown only for an
   * attributed agent change; never sends, edits the file, or resolves.
   */
  readonly onAskToKeepEdits?: (prompt: string) => void;
}

/** The first passage still awaiting a choice, or `null` once all are chosen. */
export function firstUnresolvedPassage(
  overlap: FileOverlapComparison,
): number | null {
  const index = overlap.choices.indexOf(null);
  return index === -1 ? null : index;
}

function quoteLineCount(text: string): number {
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function quoteCollapses(text: string): boolean {
  return (
    quoteLineCount(text) > COLLAPSED_QUOTE_LINES ||
    text.length > COLLAPSED_QUOTE_CHARS
  );
}

/** `80% → 85%, 1,200 → 1,350`, with ` and N more` when some aren't shown. */
function spanList(spans: readonly OverlapEditSpan[], more: number): string {
  const list = spans.map(formatOverlapEditSpan).join(', ');
  return more > 0 ? `${list} and ${more} more` : list;
}

/** One note line: plain copy, then file content kept out of session replay. */
function OverlapNote({
  testId,
  lead,
  content,
}: {
  readonly testId: string;
  readonly lead: string;
  readonly content?: string;
}): JSX.Element {
  return (
    <p className="text-xs fg-tertiary" data-testid={testId}>
      {lead}
      {content !== undefined && content.length > 0 && (
        <>
          {' '}
          <span className={`${REPLAY_BLOCK_CLASS} fg-secondary wrap-anywhere`}>
            {content}
          </span>
        </>
      )}
    </p>
  );
}

/**
 * The user's edits when the quote cannot show them: larger edits, which are
 * not marked, and short ones when a collapsed quote may hide their marks.
 */
function yourChangeNote(
  edits: OverlapSideEdits,
  quoteCollapsed: boolean,
): JSX.Element | null {
  const testId = 'file-overlap-your-change';
  switch (edits.kind) {
    case 'none':
      return null;
    case 'spans': {
      if (!quoteCollapsed) return null;
      const plural = edits.spans.length + edits.more > 1;
      return (
        <OverlapNote
          testId={testId}
          lead={plural ? 'Your changes:' : 'Your change:'}
          content={spanList(edits.spans, edits.more)}
        />
      );
    }
    case 'formatting':
      return (
        <OverlapNote
          testId={testId}
          lead="You changed spacing or line breaks."
        />
      );
    case 'added':
      return <OverlapNote testId={testId} lead="You added to this passage." />;
    case 'removed':
      return <OverlapNote testId={testId} lead="You removed this passage." />;
    case 'rewritten':
      return <OverlapNote testId={testId} lead="You rewrote this passage." />;
  }
}

/**
 * What a choice drops from the other wording's edits: `Drops your change:
 * 80% → 85%`, or `May drop …` when analysis cannot confirm the loss.
 */
function droppedNote(
  consequence: OverlapEditConsequence,
  owner: string,
  testId: string,
): JSX.Element | null {
  if (consequence.kind === 'kept') return null;
  const verb = consequence.kind === 'removes' ? 'Drops' : 'May drop';
  if (consequence.spans.length === 0) {
    return (
      <OverlapNote
        testId={testId}
        lead={`${verb} ${owner} changes to this passage.`}
      />
    );
  }
  const plural = consequence.spans.length + consequence.more !== 1;
  return (
    <OverlapNote
      testId={testId}
      lead={`${verb} ${owner} ${plural ? 'changes' : 'change'}:`}
      content={spanList(consequence.spans, consequence.more)}
    />
  );
}

/**
 * One choice: a row whose mark and label are the control, the version's
 * full wording, and what choosing it drops. Pressing anywhere on the row
 * chooses it; only the label is in the button, so the wording and notes stay
 * readable to assistive technology.
 */
function OverlapOption({
  side,
  label,
  wordingName,
  text,
  segments,
  prose,
  notes,
  selected,
  disabled,
  choiceLabel,
  passageNumber,
  onChoose,
}: {
  readonly side: OverlapChoice;
  /** The choice's visible label: `Keep mine`, `Keep {App}'s`, `Keep latest`. */
  readonly label: string;
  /** Names the wording for the expand control: `your wording`. */
  readonly wordingName: string;
  readonly text: string;
  /** Exact segments of `text`; changed ones are marked, removed ones struck. */
  readonly segments: readonly OverlapQuoteSegment[];
  /** Prose files quote in the body font; code keeps the monospace font. */
  readonly prose: boolean;
  readonly notes: ReactNode;
  readonly selected: boolean;
  readonly disabled: boolean;
  /** Accessible name, with ` for passage N` when there are several. */
  readonly choiceLabel: string;
  readonly passageNumber: number;
  readonly onChoose: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const notesId = useId();
  const collapses = quoteCollapses(text);
  // Display drops one final line break: the quote shows whole lines.
  const trimmed = text.endsWith('\n');
  const display = trimmed ? text.slice(0, -1) : text;
  const marked = segments.some((segment) => segment.changed);
  const body = marked ? (
    <QuoteSegments segments={segments} dropFinalBreak={trimmed} />
  ) : (
    display
  );
  const chooseFromRow = (event: MouseEvent<HTMLDivElement>): void => {
    if (disabled) return;
    if (
      event.target instanceof Element &&
      event.target.closest('button, a') !== null
    ) {
      return;
    }
    // Selecting this row's wording to copy is not a choice.
    const selection = window.getSelection();
    if (
      selection !== null &&
      selection.toString().length > 0 &&
      event.currentTarget.contains(selection.anchorNode)
    ) {
      return;
    }
    onChoose();
  };
  return (
    <div
      className={`flex flex-col gap-1 px-3 py-2.5 transition-colors ${
        disabled ? '' : 'cursor-pointer hover:bg-subtle'
      }`}
      data-testid={`file-overlap-side-${side}`}
      data-selected={selected}
      onClick={chooseFromRow}
    >
      <button
        type="button"
        aria-label={choiceLabel}
        aria-pressed={selected}
        aria-describedby={notes === null ? undefined : notesId}
        disabled={disabled}
        className="focus-ring flex items-center gap-3 self-start rounded text-left text-s font-medium fg-primary disabled:cursor-not-allowed disabled:opacity-60"
        data-testid={`file-overlap-choose-${side}`}
        onClick={onChoose}
      >
        <ChoiceMark kind="radio" checked={selected} disabled={disabled} />
        {label}
      </button>
      <div className="flex min-w-0 flex-col gap-1 pl-7">
        {text.length === 0 ? (
          <div
            className="text-xs fg-tertiary"
            data-testid={`file-overlap-quote-${side}`}
          >
            (nothing)
          </div>
        ) : (
          <pre
            className={`${REPLAY_BLOCK_CLASS} whitespace-pre-wrap fg-primary wrap-anywhere ${
              prose
                ? 'font-sans text-s leading-5'
                : 'font-mono text-xs leading-5'
            } ${collapses && !expanded ? 'max-h-30 overflow-hidden' : ''}`}
            data-testid={`file-overlap-quote-${side}`}
          >
            {body}
          </pre>
        )}
        {collapses && (
          <Button
            variant="ghost"
            size="compact"
            className="self-start"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Show less' : 'Show all'} of ${wordingName} for passage ${passageNumber}`}
            data-testid={`file-overlap-expand-${side}`}
            onClick={(): void => setExpanded((value) => !value)}
          >
            {expanded ? 'Show less' : 'Show all'}
          </Button>
        )}
        {notes !== null && (
          <div id={notesId} className="flex flex-col gap-0.5">
            {notes}
          </div>
        )}
      </div>
    </div>
  );
}

/** Quote text with each small edit marked and deleted words struck. */
function QuoteSegments({
  segments,
  dropFinalBreak,
}: {
  readonly segments: readonly OverlapQuoteSegment[];
  readonly dropFinalBreak: boolean;
}): JSX.Element {
  // The final line break belongs to the last segment of the side's own text.
  let last = -1;
  segments.forEach((segment, index) => {
    if (segment.removed !== true) last = index;
  });
  return (
    <>
      {segments.map((segment, index) => {
        const text =
          dropFinalBreak && index === last && segment.text.endsWith('\n')
            ? segment.text.slice(0, -1)
            : segment.text;
        if (segment.removed === true) {
          return (
            <del
              key={index}
              className="fg-tertiary line-through"
              data-testid="file-overlap-removed"
            >
              {text}
            </del>
          );
        }
        return segment.changed ? (
          <mark
            key={index}
            className="rounded-sm bg-accent-subtle fg-primary"
            data-testid="file-overlap-mark"
          >
            {text}
          </mark>
        ) : (
          <span key={index}>{text}</span>
        );
      })}
    </>
  );
}

/** The notes under a choice, or `null` when none applies. */
function optionNotes(
  first: JSX.Element | null,
  second: JSX.Element | null = null,
): ReactNode {
  if (first === null && second === null) return null;
  return (
    <>
      {first}
      {second}
    </>
  );
}

/**
 * Compares each passage both the user and a newer version changed: two
 * choices per passage, **Keep mine** and **Keep {App}'s** / **Keep latest**,
 * each quoting its wording with its own edits marked and noting which of
 * the other side's edits it drops. Changes outside the passages are kept.
 * Choices apply to the buffer once every passage has one; nothing is written
 * until Save. For an attributed agent change, **Combine with AI** drafts a
 * follow-up in the file's chat.
 */
export function FileOverlapNotice({
  session,
  overlap,
  onFocusFallback,
  handledFocusRequestRef,
  appName,
  onAskToKeepEdits,
}: FileOverlapNoticeProps): JSX.Element {
  const chooseOverlapVersion = useFileViewerStore(
    (state) => state.chooseOverlapVersion,
  );
  const dismissExternalChange = useFileViewerStore(
    (state) => state.dismissExternalChange,
  );
  const noticeRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const saveConflict = session.saveConflict ?? null;
  const change = session.externalChange ?? null;
  const busy =
    session.status === 'saving' ||
    change?.reloading === true ||
    (saveConflict !== null && saveConflict.resolving !== null);
  const source = saveConflict?.source ?? change?.source ?? null;
  const attributed = Boolean(appName) && source === 'agent-edit';
  const total = overlap.regions.length;
  const plural = total > 1;
  const active = firstUnresolvedPassage(overlap);
  const theirsChoice = attributed ? `Keep ${appName}'s` : 'Keep latest';
  const theirsOwner = attributed ? `${appName}'s` : 'the latest';
  const askAction =
    attributed && onAskToKeepEdits !== undefined ? onAskToKeepEdits : null;
  const prose = isProseFilePath(session.request.relativePath);

  const headline = attributed
    ? plural
      ? `${appName} edited ${total} passages you also changed`
      : `${appName} edited text you also changed`
    : plural
      ? `This document changed in ${total} places you also edited`
      : 'This document changed where you also edited it';
  const pick = plural
    ? 'Pick a version for each. Everything else is kept.'
    : 'Pick a version. Everything else is kept.';
  const detail =
    saveConflict?.error != null
      ? saveConflict.error.kind === 'latest-unavailable'
        ? "Couldn't get the latest version."
        : `Couldn't save your version. ${saveConflict.error.message}`
      : change?.error
        ? `Couldn't load the latest version. ${change.error}`
        : undefined;

  // Focus the first enabled choice once per explicit save request; never for
  // autosave, refreshes, or typing.
  const focusRequest = saveConflict?.focusRequest ?? 0;
  useEffect(() => {
    if (focusRequest <= handledFocusRequestRef.current) return;
    if (busy) return;
    handledFocusRequestRef.current = focusRequest;
    noticeRef.current
      ?.querySelector<HTMLButtonElement>(
        '[data-testid^="file-overlap-choose-"]:not(:disabled)',
      )
      ?.focus();
  }, [busy, focusRequest, handledFocusRequestRef]);

  // Keep the active passage in view inside the bounded list without
  // scrolling any ancestor.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || active === null) return;
    const passage = list.querySelector<HTMLElement>(
      `[data-passage-index="${active}"]`,
    );
    if (!passage) return;
    const top = passage.offsetTop - list.offsetTop;
    const bottom = top + passage.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      // A long expanded passage cannot fit: keep its heading and first
      // wording visible rather than jumping straight to its bottom.
      list.scrollTop = Math.min(top, bottom - list.clientHeight);
    }
  }, [active, overlap.token]);

  const choose = (index: number, choice: OverlapChoice): void => {
    const ownedFocus =
      noticeRef.current?.contains(document.activeElement) === true;
    const remaining = overlap.choices.filter(
      (entry, position) => entry === null && position !== index,
    ).length;
    chooseOverlapVersion(session.key, overlap.token, index, choice);
    if (!ownedFocus) return;
    // After React commits: the next passage's choice, or the header once
    // the final choice removes the comparison.
    setTimeout(() => {
      const notice = noticeRef.current;
      if (remaining === 0 || notice === null || !notice.isConnected) {
        const { activeElement } = document;
        if (
          activeElement === null ||
          activeElement === document.body ||
          notice?.contains(activeElement) === true
        ) {
          onFocusFallback();
        }
        return;
      }
      const next = notice.querySelector<HTMLElement>(
        '[data-active-passage="true"] [data-testid^="file-overlap-choose-"]:not(:disabled)',
      );
      next?.focus();
    }, 0);
  };

  return (
    <div
      ref={noticeRef}
      className="flex flex-col gap-2 border-b px-3 pt-1 pb-3"
      data-testid="file-overlap-notice"
      data-origin={saveConflict ? 'save' : 'refresh'}
    >
      <Notice
        intent="attention"
        surface="none"
        role={saveConflict ? 'alert' : undefined}
        title={saveConflict ? 'Not saved' : headline}
        detail={detail}
        actions={
          saveConflict ? undefined : (
            <NoticeButton
              data-testid="file-overlap-decide-later"
              disabled={busy}
              onClick={(): void => {
                if (noticeRef.current?.contains(document.activeElement)) {
                  onFocusFallback();
                }
                dismissExternalChange(session.key);
              }}
            >
              Decide later
            </NoticeButton>
          )
        }
      >
        {saveConflict ? `${headline}. ${pick}` : pick}
      </Notice>
      <div
        ref={listRef}
        className="flex max-h-[40vh] flex-col gap-3 overflow-y-auto"
        data-testid="file-overlap-passages"
      >
        {overlap.regions.map((region: OverlapRegion) => {
          const chosen = overlap.choices[region.index] ?? null;
          const position = region.index + 1;
          const name = plural
            ? `Passage ${position} of ${total}`
            : 'Overlapping passage';
          const suffix = plural ? ` for passage ${position}` : '';
          const summary = summarizeOverlapEdits(region);
          return (
            <div
              key={region.index}
              className="flex flex-col gap-2"
              data-testid="file-overlap-passage"
              data-passage-index={region.index}
              data-active-passage={region.index === active}
            >
              {plural && <div className="text-xs fg-secondary">{name}</div>}
              <ChoiceList aria-label={name} className="shrink-0">
                <OverlapOption
                  side="ours"
                  label="Keep mine"
                  wordingName="your wording"
                  text={region.ours}
                  segments={summary.oursSegments}
                  prose={prose}
                  notes={optionNotes(
                    yourChangeNote(summary.ours, quoteCollapses(region.ours)),
                    droppedNote(
                      summary.choosingOurs,
                      theirsOwner,
                      'file-overlap-consequence-ours',
                    ),
                  )}
                  selected={chosen === 'ours'}
                  disabled={busy}
                  choiceLabel={`Keep mine${suffix}`}
                  passageNumber={position}
                  onChoose={(): void => choose(region.index, 'ours')}
                />
                <OverlapOption
                  side="theirs"
                  label={theirsChoice}
                  wordingName={`${theirsOwner} wording`}
                  text={region.theirs}
                  segments={summary.theirsSegments}
                  prose={prose}
                  notes={optionNotes(
                    droppedNote(
                      summary.choosingTheirs,
                      'your',
                      'file-overlap-consequence-theirs',
                    ),
                  )}
                  selected={chosen === 'theirs'}
                  disabled={busy}
                  choiceLabel={`${theirsChoice}${suffix}`}
                  passageNumber={position}
                  onChoose={(): void => choose(region.index, 'theirs')}
                />
              </ChoiceList>
              {askAction !== null && summary.ours.kind !== 'none' && (
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <NoticeButton
                    aria-label={`Combine with AI${suffix}`}
                    icon={<SparkleIcon size="sm" />}
                    disabled={busy}
                    data-testid="file-overlap-ask-keep"
                    onClick={(): void =>
                      askAction(
                        buildKeepEditsPrompt({
                          path: session.request.relativePath,
                          region,
                          passageNumber: position,
                          passageCount: total,
                        }),
                      )
                    }
                  >
                    Combine with AI
                  </NoticeButton>
                  <span className="text-xs fg-tertiary">
                    Drafts a request in chat to keep both
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

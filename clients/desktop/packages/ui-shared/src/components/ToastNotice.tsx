'use client';

import type { JSX, ReactNode } from 'react';
import { splitLongPaths } from '../lib/notification-message';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Notice, type NoticeIntent } from './Notice';
import { ToastStackDescription, ToastStackTitle } from './ToastStack';

/**
 * A long path in a toast, shortened in its middle so the folder it ends in
 * stays readable. The whole path is still the element's text, so selecting
 * and copying it copies all of it, and hovering shows it in full.
 */
function ToastPath({
  path,
  after,
}: {
  readonly path: string;
  /** Punctuation that follows the path, kept on its line. */
  readonly after: string;
}): JSX.Element {
  // Keep the last part whole; a short last part keeps its parent too
  // (`…/worktrees/sloth`), so the tail still says where it is.
  const separators = [...path.matchAll(/[\\/]/g)].map((match) => match.index);
  const last = separators.length > 0 ? separators[separators.length - 1] : 0;
  const parent = separators.length > 1 ? separators[separators.length - 2] : 0;
  const tailStart = path.length - last < 12 && parent > 0 ? parent : last;
  return (
    <span
      title={path}
      data-testid="toast-path"
      // One atomic box no wider than the line: it moves to its own line when
      // it doesn't fit beside the text before it, then gives up its middle.
      className="inline-flex max-w-full whitespace-pre align-top"
    >
      <span className="min-w-0 truncate">{path.slice(0, tailStart)}</span>
      <span className="shrink-0">
        {path.slice(tailStart)}
        {after}
      </span>
    </span>
  );
}

/** A toast's message with every long path in it shortened in the middle. */
export function ToastMessageText({
  text,
}: {
  readonly text: string;
}): JSX.Element {
  const parts = splitLongPaths(text);
  const nodes: ReactNode[] = [];
  let carried = 0;
  for (const [index, part] of parts.entries()) {
    const plain = part.text.slice(carried);
    carried = 0;
    if (!part.path) {
      nodes.push(plain);
      continue;
    }
    // The punctuation right after a path ("…/sloth." or "…/sloth,") stays on
    // the path's line instead of wrapping to the start of the next one.
    const next = parts[index + 1];
    const after =
      next === undefined || next.path
        ? ''
        : (/^\S+/.exec(next.text)?.[0] ?? '');
    carried = after.length;
    nodes.push(<ToastPath key={index} path={plain} after={after} />);
  }
  return <>{nodes}</>;
}

export interface ToastNoticeProps {
  /** Picks the leading glyph and its ink; nothing else changes by intent. */
  readonly intent: NoticeIntent;
  /** Replaces the intent's glyph, such as a project's icon on its updates. */
  readonly icon?: ReactNode;
  /** The headline, on its own line above the message. */
  readonly title?: ReactNode;
  /** The message as the card shows it (see `previewToastMessage`). */
  readonly text: string;
  /**
   * Keep the message out of session replay: it can quote output, a reply or
   * a person's name.
   */
  readonly blockTextFromReplay?: boolean;
  /** A closing line kept below the message within its three lines. */
  readonly textContext?: ReactNode;
  /** Reports whether the three-line clamp hides any of the message. */
  readonly onOverflowChange?: (overflowing: boolean) => void;
  /** Supporting content under the message, such as a failure's reference. */
  readonly footer?: ReactNode;
  /** The toast's buttons, on their own row under the message. */
  readonly actions?: ReactNode;
  /** Every toast can be closed. */
  readonly onDismiss: () => void;
  readonly dismissLabel?: string;
}

/**
 * The one toast layout every host draws inside `ToastStack`: glyph, optional
 * title, message, optional actions, and a close button in the top-right
 * corner. Long paths in the message are shortened in the middle.
 */
export function ToastNotice({
  intent,
  icon,
  title,
  text,
  blockTextFromReplay = false,
  textContext,
  onOverflowChange,
  footer,
  actions,
  onDismiss,
  dismissLabel = 'Dismiss notification',
}: ToastNoticeProps): JSX.Element {
  return (
    <Notice
      intent={intent}
      {...(icon === undefined ? {} : { icon })}
      surface="none"
      shape="toast"
      errorRecordingDisabled
      titleLayout="stacked"
      // The stack's region announces additions; a per-notice alert would
      // nest a second live region inside it.
      role="none"
      title={
        title === undefined ? undefined : (
          <ToastStackTitle>{title}</ToastStackTitle>
        )
      }
      actions={actions}
      // Buttons get their own row under the message, so the close button
      // stays in the top-right corner of every toast.
      actionsPlacement="below"
      onDismiss={onDismiss}
      dismissLabel={dismissLabel}
      dismissTestId="toast-dismiss"
    >
      <ToastStackDescription
        {...(onOverflowChange === undefined ? {} : { onOverflowChange })}
      >
        <span
          className={
            blockTextFromReplay
              ? `${REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words`
              : 'whitespace-pre-wrap break-words'
          }
        >
          {textContext === undefined ? (
            <ToastMessageText text={text} />
          ) : (
            <>
              {/* Reserve the last line for context within the card's
                  three-line budget. Hosts keep the full message elsewhere. */}
              <span className="line-clamp-2">
                <ToastMessageText text={text} />
              </span>
              <span data-testid="toast-message-context" className="block">
                {textContext}
              </span>
            </>
          )}
        </span>
      </ToastStackDescription>
      {footer}
    </Notice>
  );
}

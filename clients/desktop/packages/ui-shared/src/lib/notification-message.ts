/**
 * How much of a message a notification shows before it is cut short. A longer
 * message is cut at a word-agnostic boundary; the host then offers the whole
 * text in a details view.
 */
export const NOTIFICATION_PREVIEW_CHARS = 240;
export const NOTIFICATION_PREVIEW_LINES = 4;

export interface NotificationMessagePreview {
  readonly text: string;
  readonly truncated: boolean;
}

export interface NotificationMessagePreviewOptions {
  readonly maxLines?: number;
  readonly maxChars?: number;
}

/** A notification's view of a message: whole, or cut short with an ellipsis. */
export function previewNotificationMessage(
  message: string,
  {
    maxLines = NOTIFICATION_PREVIEW_LINES,
    maxChars = NOTIFICATION_PREVIEW_CHARS,
  }: NotificationMessagePreviewOptions = {},
): NotificationMessagePreview {
  const lines = message.split('\n');
  let text =
    lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : message;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
  }
  if (text === message) return { text, truncated: false };
  return { text: `${text.trimEnd()}…`, truncated: true };
}

/**
 * A toast shows at most three lines (`ToastStackDescription` clamps it), so
 * its preview stops near that length and the host can offer the rest.
 */
export const TOAST_PREVIEW_CHARS = 120;
export const TOAST_PREVIEW_LINES = 3;

/**
 * A path at least this long is shortened in its middle when a toast shows it
 * (`ToastMessageText`), so it counts as this many characters of the preview.
 */
export const TOAST_PATH_PREVIEW_CHARS = 32;

/** One run of a message: plain text, or a long path shortened on screen. */
export interface MessagePart {
  readonly text: string;
  readonly path: boolean;
}

// An absolute path (`/a/b`, `~/a/b`, `C:\a\b`) with at least two parts, at
// the start of the text or after a space, quote or bracket, so a URL's
// `//host/…` and a branch such as `user/topic` stay plain text.
const PATH_PATTERN =
  /(?<=^|[\s"'(\[‘“])(?:~|[A-Za-z]:)?[\\/](?:[^\s"'`<>|\\/]+[\\/])+[^\s"'`<>|\\/]*/g;
// A sentence's closing punctuation is not part of the path before it.
const PATH_TRAILING_PUNCTUATION = /[.,;:!?)\]’”]+$/;

interface PathSpan {
  readonly start: number;
  readonly end: number;
}

function longPathSpans(text: string): PathSpan[] {
  const spans: PathSpan[] = [];
  for (const match of text.matchAll(PATH_PATTERN)) {
    const path = match[0].replace(PATH_TRAILING_PUNCTUATION, '');
    if (path.length < TOAST_PATH_PREVIEW_CHARS) continue;
    spans.push({ start: match.index, end: match.index + path.length });
  }
  return spans;
}

/**
 * Splits a message into plain runs and the long paths in it, which a toast
 * shortens in the middle so the folder they end in stays readable.
 */
export function splitLongPaths(text: string): readonly MessagePart[] {
  const parts: MessagePart[] = [];
  let at = 0;
  for (const { start, end } of longPathSpans(text)) {
    if (start > at) parts.push({ text: text.slice(at, start), path: false });
    parts.push({ text: text.slice(start, end), path: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), path: false });
  return parts;
}

/**
 * A toast's view of a message, cut to fit its three lines. A long path is
 * shortened on screen, so it spends only {@link TOAST_PATH_PREVIEW_CHARS} of
 * the budget, and the cut never lands inside one.
 */
export function previewToastMessage(
  message: string,
): NotificationMessagePreview {
  const spans = longPathSpans(message);
  const saved = spans.reduce(
    (total, span) =>
      total + Math.max(0, span.end - span.start - TOAST_PATH_PREVIEW_CHARS),
    0,
  );
  const preview = previewNotificationMessage(message, {
    maxLines: TOAST_PREVIEW_LINES,
    maxChars: TOAST_PREVIEW_CHARS + saved,
  });
  if (!preview.truncated) return preview;
  const kept = preview.text.length - 1;
  const cut = spans.find((span) => span.start < kept && kept < span.end);
  if (cut === undefined) return preview;
  return { text: `${message.slice(0, cut.start).trimEnd()}…`, truncated: true };
}

export interface CommandFailureSummary {
  readonly summary: string;
  /** True when the summary leaves out any line or text of the message. */
  readonly truncated: boolean;
}

const LINE_BREAK = /\r\n|\r|\n/;
const CAUSE_PREFIX = /^(?:error|fatal):\s*/i;

/**
 * A short summary of a failed command's output: its first line plus the last
 * `error:` / `fatal:` line, which usually names the cause. Progress output
 * (git overwrites `Updating files:` lines with bare `\r`) is dropped. The
 * summary is at most two lines and the default preview length.
 */
export function summarizeCommandFailure(
  message: string,
): CommandFailureSummary {
  const lines = message
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { summary: '', truncated: false };

  const picked = [lines[0]];
  let causeIndex = -1;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    if (CAUSE_PREFIX.test(lines[index])) {
      causeIndex = index;
      break;
    }
  }
  if (causeIndex > 0) {
    picked.push(lines[causeIndex].replace(CAUSE_PREFIX, ''));
  }

  const preview = previewNotificationMessage(picked.join('\n'), {
    maxLines: 2,
  });
  return {
    summary: preview.text,
    truncated: preview.truncated || picked.length < lines.length,
  };
}

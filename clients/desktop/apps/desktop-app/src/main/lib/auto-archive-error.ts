import { homedir } from 'node:os';
import { parse } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { toAppError, type AppError } from '@canopy/protocol/app-errors';
import { toFeedbackReportError } from '@canopy/protocol/feedback-report';

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const TRAILING_SEPARATORS = /[/\\]+$/;
const TEXT_END = String.raw`$|[\s"'\`)\]},;:]`;
// The home must end its segment: `/Users/jo` must not cut into `/Users/john`
// or `/Users/jo.bak`. A period that ends the sentence also ends it.
const HOME_END = String.raw`(?=${TEXT_END}|[/\\]|\.(?=${TEXT_END}))`;
const MAX_FAILURE_MESSAGE_LENGTH = 4000;
// toAppError keeps this much of an Error's message.
const APP_ERROR_MESSAGE_LENGTH = 4096;

/**
 * Main knows the real home, so it masks it exactly, whatever sits around the
 * path (a branch name directly before it, a username with spaces).
 */
function homeMasker(home: string): (text: string) => string {
  const { root } = parse(home);
  const trimmed =
    home.length > root.length ? home.replace(TRAILING_SEPARATORS, '') : home;
  if (trimmed.length < 2 || trimmed.length <= root.length)
    return (text) => text;
  // Not hostPlatformOperatingSystem: it throws on an unsupported host, and
  // this runs inside callers' catch blocks.
  const os = hostOperatingSystem();
  const pattern = new RegExp(
    trimmed.replace(REGEX_SPECIAL, '\\$&') + HOME_END,
    // Both default filesystems ignore case, so either spelling is this home.
    os === 'win32' || os === 'darwin' ? 'gi' : 'g',
  );
  return (text) => text.replace(pattern, '<user-home>');
}

// Runs inside callers' catch blocks, so a hostile message getter or toString
// must not throw.
function failureText(value: unknown): string {
  try {
    return value instanceof Error ? String(value.message) : String(value);
  } catch {
    return 'Unrecognized error value';
  }
}

/**
 * The failure as its notification shows it. A refusal's reason follows its
 * branch list, so a long message keeps its end; autoArchiveAppError keeps
 * the same end for the report.
 */
export function autoArchiveFailureMessage(value: unknown): string {
  return failureText(value).slice(-MAX_FAILURE_MESSAGE_LENGTH);
}

/** The failure behind the notification, not its work-entry/recovery prose. */
export function autoArchiveAppError(
  value: unknown,
  home: string = homedir(),
): AppError | undefined {
  const error = toAppError(value);
  if (!error) return undefined;
  const mask = homeMasker(home);
  const { copy, detail } = error;
  // toAppError keeps a long message's start; the shown failure keeps its end.
  // The whole message goes to redaction, which cuts it only afterwards. A
  // restored or typed error carries its own message, which is kept.
  const shown = failureText(value);
  const message =
    shown.slice(0, APP_ERROR_MESSAGE_LENGTH) === detail.message
      ? shown
      : detail.message;
  // toFeedbackReportError then applies the general redaction on top.
  const redacted = toFeedbackReportError(
    {
      ...error,
      copy: {
        title: mask(copy.title),
        ...(copy.description === undefined
          ? {}
          : { description: mask(copy.description) }),
      },
      detail: {
        ...detail,
        message: mask(message),
        ...(detail.name === undefined ? {} : { name: mask(detail.name) }),
        ...(detail.stack === undefined ? {} : { stack: mask(detail.stack) }),
        ...(typeof detail.status === 'string'
          ? { status: mask(detail.status) }
          : {}),
      },
    },
    { keepMessageEnd: true },
  );
  const sent = { ...redacted.detail };
  delete sent.stack;
  return { ...error, copy: redacted.copy, detail: sent };
}

import { memo, type JSX, type MouseEvent } from 'react';
import {
  readAutoResumeMetadata,
  type AutoResumeMetadata,
} from '@canopy/protocol/remote-control/shell';
import { useChatAppName } from '../chat-look';
import { ChatCopyAction } from './ChatCopyAction';
import { getWindow } from '../../panels/window-registry';

// Cached at module load: transcript rows render often. The marker always
// shows its date so the label never depends on when it is rendered.
const markerTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const markerFullFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** A resume's persisted time, independent of the current clock. */
export function formatAutoResumeTime(timestamp: number): string {
  return Number.isFinite(timestamp) && timestamp >= 0
    ? markerTimeFormatter.format(timestamp)
    : '';
}

/**
 * The marker's headline for a resume's recorded reason. Says "closed" only
 * for a known app shutdown and never claims a usage limit reset.
 */
export function autoResumeHeadline(
  autoResume: AutoResumeMetadata | undefined,
  time: string,
  appName: string | undefined,
  providerName?: string,
): string {
  const withTime = (text: string): string =>
    time ? `${text} · ${time}` : text;
  switch (autoResume?.reason) {
    case 'app_shutdown':
      return time
        ? `${appName ?? 'The app'} closed · resumed ${time}`
        : `${appName ?? 'The app'} closed · resumed`;
    case 'usage_limit':
      return withTime(
        providerName
          ? `Resumed after ${providerName} usage limit`
          : 'Resumed after a usage limit',
      );
    case 'provider_sign_in':
      return withTime('Resumed after signing in');
    case 'authentication':
      return withTime('Resumed after an account change');
    case 'auth_recovery':
      return withTime('Resumed after sign-in recovery');
    case undefined:
      return withTime('Sent automatically');
  }
}

/**
 * The attribution under a known resume: the generated nudge's own text, or
 * that the person's last message was re-sent (its body stays below).
 */
export function autoResumeAttribution(
  autoResume: AutoResumeMetadata | undefined,
  text: string,
): string | null {
  if (!autoResume) return null;
  if (autoResume.resendsUserMessage) {
    return 'Sent automatically · re-sent your last message';
  }
  const nudge = text.trim();
  return nudge ? `Sent automatically: ${nudge}` : 'Sent automatically';
}

/**
 * Read trusted resume provenance from a message's direct field or, on older
 * relays, its cached `prompt_source` part. Never inferred from prompt text.
 */
export function readMessageAutoResume(message: {
  readonly autoResume?: unknown;
  readonly parts?: unknown;
}): AutoResumeMetadata | undefined {
  const direct = readAutoResumeMetadata(message.autoResume);
  if (direct) return direct;
  if (!Array.isArray(message.parts)) return undefined;
  const parts: readonly unknown[] = message.parts;
  for (const part of parts) {
    if (
      typeof part !== 'object' ||
      part === null ||
      !('kind' in part) ||
      part.kind !== 'prompt_source' ||
      !('data' in part) ||
      typeof part.data !== 'object' ||
      part.data === null ||
      !('autoResume' in part.data)
    )
      continue;
    const value = readAutoResumeMetadata(part.data.autoResume);
    if (value) return value;
  }
  return undefined;
}

export interface AutoResumeMarkerProps {
  /**
   * Trusted provenance. Absent for a message known to be application-sent
   * whose resume details are missing or unrecognized: the marker then says
   * only "Sent automatically" and the host keeps the message body.
   */
  readonly autoResume?: AutoResumeMetadata;
  /** The resume message's persisted time (epoch ms), never render time. */
  readonly timestamp: number;
  /** The message's text; a generated nudge shows it in the attribution. */
  readonly text: string;
  /** Overrides the host's `ChatAppNameProvider` value. */
  readonly appName?: string;
  /** Provider display name for a usage-limit resume, when known. */
  readonly providerName?: string;
  readonly outputless?: boolean;
  /** Generated nudges retain the prompt row's copy action without a bubble. */
  readonly copyText?: string;
  readonly onJumpToMessage?: (element: HTMLElement) => void;
}

/**
 * A system divider in place of a human bubble for a prompt the app sent to
 * resume an interrupted turn: "Canopy closed · resumed Oct 25, 9:41 PM",
 * then "Sent automatically: Continue". A re-sent prompt keeps its body
 * below, rendered by the host with non-human attribution.
 */
export const AutoResumeMarker = memo(function AutoResumeMarker({
  autoResume,
  timestamp,
  text,
  appName,
  providerName,
  outputless = false,
  copyText,
  onJumpToMessage,
}: AutoResumeMarkerProps): JSX.Element {
  const contextAppName = useChatAppName();
  const time = formatAutoResumeTime(timestamp);
  const tried =
    outputless &&
    autoResume?.reason === 'usage_limit' &&
    autoResume.resendsUserMessage;
  const triedHeadline = providerName
    ? `Tried to resume after ${providerName} usage limit`
    : 'Tried to resume after a usage limit';
  const headline = tried
    ? `${triedHeadline}${time ? ` · ${time}` : ''}`
    : autoResumeHeadline(
        autoResume,
        time,
        appName ?? contextAppName,
        providerName,
      );
  const attribution = tried
    ? 'Sent automatically · no response'
    : autoResumeAttribution(autoResume, text);
  const handleJump = (event: MouseEvent<HTMLDivElement>): void => {
    if (!onJumpToMessage) return;
    const target = event.target;
    if (
      target instanceof getWindow(event.currentTarget).Element &&
      target.closest('button, a')
    )
      return;
    if (event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false)
      return;
    onJumpToMessage(event.currentTarget);
  };
  return (
    <div
      role="note"
      onClick={onJumpToMessage ? handleJump : undefined}
      data-testid="auto-resume-marker"
      data-auto-resume-reason={autoResume?.reason ?? 'unknown'}
      data-auto-resume-resends={
        autoResume ? String(autoResume.resendsUserMessage) : undefined
      }
      className="flex flex-col items-center py-2 gap-0.5 text-2xs fg-tertiary"
    >
      <div className="flex w-full min-w-0 items-center gap-2">
        <span aria-hidden="true" className="min-w-4 flex-1 border-t" />
        <span
          data-testid="auto-resume-marker-headline"
          className="min-w-0 truncate"
          title={
            Number.isFinite(timestamp) && timestamp >= 0
              ? markerFullFormatter.format(timestamp)
              : undefined
          }
        >
          {headline}
        </span>
        <span aria-hidden="true" className="min-w-4 flex-1 border-t" />
      </div>
      <div className="flex max-w-full items-center gap-1">
        {attribution != null && (
          <span
            data-testid="auto-resume-marker-attribution"
            className="max-w-full truncate"
          >
            {attribution}
          </span>
        )}
        {copyText !== undefined && (
          <ChatCopyAction text={copyText} dataTestId="auto-resume-copy" />
        )}
      </div>
    </div>
  );
});

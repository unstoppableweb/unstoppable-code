import { memo, type JSX } from 'react';
import { RestoreIcon as AppCatalogRestoreIcon } from '../../icons/AppIcons';
import { useCleanChatLook } from '../chat-look';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

/**
 * Who compacted the session, keyed off both provider and interface mode so a
 * native Codex compaction never inherits the Claude-specific copy and a Claude
 * Code terminal compaction is named as such. The ONE rule for every host: the
 * desktop transcript and the shared portal transcript both read it, so the
 * same persisted compaction is captioned the same way everywhere
 * (docs/ux-writing.md, "Context compaction").
 */
export function compactionHeadline(
  provider: string | undefined,
  interfaceMode: string | undefined,
): string {
  if (provider === 'codex') return 'Codex compacted this session';
  if (provider === 'claude') {
    return interfaceMode === 'claude-code'
      ? 'Claude Code compacted this session'
      : 'Claude compacted this session';
  }
  return 'Context compacted for this session';
}

export interface CompactionInfoBlockProps {
  /** Who compacted the session, e.g. `Claude compacted this session`. */
  headline: string;
  /** Epoch ms when the compaction completed. */
  timestamp: number;
  /** Optional summary text produced by the provider. */
  summary?: string;
  dataTestId?: string;
}

/**
 * Append-only transcript banner marking a context compaction. Pure display:
 * the host resolves the provider-specific headline and the timestamp; the
 * block never rewrites earlier transcript content.
 */
function CompactionInfoBlockComponent({
  headline,
  timestamp,
  summary,
  dataTestId = 'compaction-info-block',
}: CompactionInfoBlockProps): JSX.Element {
  const localTime = new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  // Clean chat look: a quiet notice centered in the chat column between
  // the messages, like a date divider, instead of a boxed banner.
  const clean = useCleanChatLook();
  if (clean) {
    return (
      <div
        data-testid={dataTestId}
        data-chat-notice=""
        className="flex w-full flex-col items-center gap-1 py-2 text-center text-s fg-tertiary"
      >
        <span className="flex max-w-full items-center gap-2">
          <span
            className="flex h-5 shrink-0 items-center [&_svg]:size-3.5"
            aria-hidden="true"
          >
            <AppCatalogRestoreIcon />
          </span>
          <span className="min-w-0 truncate">
            {headline} at {localTime}
          </span>
        </span>
        {summary !== undefined && summary.length > 0 ? (
          <span
            className={`${REPLAY_BLOCK_CLASS} max-w-full whitespace-pre-wrap break-words`}
          >
            {summary}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div
      data-testid={dataTestId}
      className="flex flex-col gap-1 rounded-lg ring-1 ring-inset ring-line-base bg-fg-primary/[0.03] px-3 py-1.5 text-xs fg-secondary"
    >
      <div className="flex items-center gap-2">
        <AppCatalogRestoreIcon
          size="sm"
          className="flex-shrink-0"
          aria-hidden="true"
        />
        <span>
          {headline} <span className="fg-secondary/80">at {localTime}</span>
        </span>
      </div>
      {summary !== undefined && summary.length > 0 ? (
        <div className={`${REPLAY_BLOCK_CLASS} pl-6 fg-secondary/80`}>
          {summary}
        </div>
      ) : null}
    </div>
  );
}

export const CompactionInfoBlock = memo(CompactionInfoBlockComponent);

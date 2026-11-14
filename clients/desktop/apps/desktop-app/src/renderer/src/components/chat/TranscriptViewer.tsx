import { useDeferredValue, useMemo, useRef, type JSX } from 'react';
import { ChatMessageContextMenuScope } from '@canopy/ui-shared/components';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { parseAgentTranscriptLines } from '@/lib/transcript-parser';
import {
  computeIncrementalTurnGroups,
  createEmptyTurnGroupCache,
  findLastForkableTurnGroupIndex,
} from './incremental-turn-groups';
import { ChatMessageItem } from './ChatMessageItem';
import { TurnGroupRenderer } from './TurnGroupRenderer';

interface TranscriptViewerProps {
  transcriptKey: string;
  lines: string[];
  providerHint?: AgentProviderType;
  closeOpenTurnAtEnd?: boolean;
  emptyMessage: string;
  className?: string;
  contentClassName?: string;
  dataTestId?: string;
}

export function TranscriptViewer({
  transcriptKey,
  lines,
  providerHint,
  closeOpenTurnAtEnd = false,
  emptyMessage,
  className = '',
  contentClassName = 'flex flex-col gap-2',
  dataTestId,
}: TranscriptViewerProps): JSX.Element {
  const deferredLines = useDeferredValue(lines);
  const parsedTranscript = useMemo(
    () =>
      parseAgentTranscriptLines(deferredLines, providerHint, {
        closeOpenTurnAtEnd,
      }),
    [closeOpenTurnAtEnd, deferredLines, providerHint],
  );
  const transcriptCacheRef = useRef(createEmptyTurnGroupCache());
  const turnGroups = useMemo(
    () =>
      computeIncrementalTurnGroups(
        transcriptKey,
        parsedTranscript.messages,
        parsedTranscript.agentUsage,
        transcriptCacheRef.current,
      ),
    [parsedTranscript.agentUsage, parsedTranscript.messages, transcriptKey],
  );
  const lastForkableTurnGroupIndex = useMemo(
    () => findLastForkableTurnGroupIndex(turnGroups),
    [turnGroups],
  );

  return (
    <ChatMessageContextMenuScope enabled={false}>
      <div
        // Chat keeps plain line breaks (see canopy-tokens-core.css).
        data-chat-window
        className={
          className
            ? `${POSTHOG_REPLAY_BLOCK_CLASS} ${className}`
            : POSTHOG_REPLAY_BLOCK_CLASS
        }
        data-testid={dataTestId}
        data-owns-context-menu=""
      >
        {turnGroups.length === 0 ? (
          <div className="flex min-h-50 items-center justify-center text-s fg-secondary">
            {emptyMessage}
          </div>
        ) : (
          <div className={contentClassName}>
            {turnGroups.map((item, index) =>
              item.kind === 'turn-group' ? (
                <TurnGroupRenderer
                  key={item.userMessage.id}
                  group={item}
                  chatPendingQuestions={[]}
                  isLastTurnGroup={index === turnGroups.length - 1}
                  isLastForkableTurnGroup={index === lastForkableTurnGroupIndex}
                  // No per-turn `group/turn` wrapper here, so the completed
                  // footer must not hide behind its hover reveal (CAN-4278).
                />
              ) : (
                <ChatMessageItem
                  key={item.message.id}
                  message={item.message}
                  chatPendingQuestions={[]}
                />
              ),
            )}
          </div>
        )}
      </div>
    </ChatMessageContextMenuScope>
  );
}

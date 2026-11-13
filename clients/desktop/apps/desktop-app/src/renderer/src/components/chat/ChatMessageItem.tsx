import type { AgentSentReceivingContext } from '@canopy/ui-shared';
import { TranscriptSearchRevealContext } from './transcript-search-reveal';
import { memo, type ReactNode } from 'react';
import {
  MARKDOWN_ROOT_PROPS,
  useChatMessageContextMenu,
} from '@canopy/ui-shared/components';
import type { AppliedOrgMemoryTurn, PendingQuestion } from '@/stores/chatStore';
import { ChatBlockRenderer, ChatVisualResult } from './ChatBlockRenderer';
import { getDisplayBlockKey } from './display-block-keys';
import { LAYOUT_BLOCK_TYPES } from '@canopy/desktop-shared/lib/transcript-fingerprint';
import { UserBubble } from './UserBubble';
import { WakeTurnBoundary } from '@canopy/ui-shared/components';
import type { DisplayMessage } from './types';

/** What started a wake's task: its tool call, else the prompt that made it. */
export interface SpawningCallTarget {
  toolUseId?: string;
  userMessageId?: string;
}
import type { InvocableMentionIndex } from '@/lib/invocableMentionIndex';
import type { FilePathMentionIndex } from '@/lib/filePathMentionIndex';

export const ChatMessageItem = memo(function ChatMessageItem({
  message,
  receivingContext,
  turnExpanded = false,
  streaming = false,
  settled = !streaming,
  turnSettled = false,
  chatPendingQuestions,
  onResetToPoint,
  invocableMentionIndex,
  filePathMentionIndex,
  originChatTabId,
  isCodeReviewChat,
  appliedMemory,
  forceSearchExpanded = false,
  forceExpandedUserMessage = false,
  visualOnly = false,
  onJumpToMessage,
  onShowSpawningCall,
  blockKeyOffset = 0,
}: {
  message: DisplayMessage;
  receivingContext?: AgentSentReceivingContext;
  turnExpanded?: boolean;
  streaming?: boolean;
  /** No more text will arrive for this message, even if its turn streams. */
  settled?: boolean;
  /** The owning turn settled; unresolved tool calls render interrupted. */
  turnSettled?: boolean;
  chatPendingQuestions: PendingQuestion[];
  onResetToPoint?: (userMessageId: string) => Promise<void>;
  invocableMentionIndex?: InvocableMentionIndex | null;
  filePathMentionIndex?: FilePathMentionIndex | null;
  originChatTabId?: string;
  /** True inside a Code Review sidecar chat — forwarded to `ChatBlockRenderer`
   * so the shared plan/review comment tools pick the code-flavored icon. */
  isCodeReviewChat?: boolean;
  appliedMemory?: AppliedOrgMemoryTurn;
  forceSearchExpanded?: boolean;
  forceExpandedUserMessage?: boolean;
  /** Collapsed intermediate reply: show its visual without the tool row. */
  visualOnly?: boolean;
  /** Transcript-supplied click-to-jump handler for user bubbles. */
  onJumpToMessage?: (element: HTMLElement) => void;
  /** Brings a wake's spawning tool call (or its prompt) into view. */
  onShowSpawningCall?: (target: SpawningCallTarget) => void;
  /**
   * Index of `message.blocks[0]` in the transcript message it was cut from
   * (live step window rows), so block keys stay put as the cut moves.
   */
  blockKeyOffset?: number;
}): ReactNode {
  // The message menu (CAN-4277) copies a selection inside the row. User
  // bubbles own their menu in `UserBubble`. Registered layout chrome, hidden
  // question placeholders and collapsed visual projections stay presentation-only.
  // Genuine system text and visible question messages remain eligible.
  const { targetProps: contextMenuTarget, menu: contextMenu } =
    useChatMessageContextMenu({
      messageId: message.id,
      // Rows with no text block (tool-only) get no Tab stop.
      focusable: message.blocks.some(
        (block) => block.type === 'text' && block.text !== '',
      ),
    });
  const wake = message.blocks[0];
  if (message.role === 'system' && wake?.type === 'wake_boundary') {
    const target: SpawningCallTarget = {
      toolUseId: wake.spawningToolUseId,
      userMessageId: wake.spawningUserMessageId,
    };
    return (
      <WakeTurnBoundary
        taskLabel={wake.taskLabel}
        event={wake.taskEvent === true}
        scheduled={wake.scheduled === true}
        toolsLoaded={wake.toolsLoaded === true}
        onShowSpawningTurn={
          (target.toolUseId !== undefined ||
            target.userMessageId !== undefined) &&
          onShowSpawningCall
            ? (): void => onShowSpawningCall(target)
            : undefined
        }
      />
    );
  }
  if (visualOnly) {
    return (
      // px-3 keeps the visual on the same inset as the expanded turn's rows.
      <div
        className="px-3"
        data-role={message.role}
        data-chat-message-id={message.id}
      >
        {message.blocks.map((block, index) =>
          block.type === 'tool_use' ? (
            <ChatVisualResult
              key={getDisplayBlockKey(block, index + blockKeyOffset)}
              result={block.result}
              variant="visual-only"
            />
          ) : block.type === 'approval_safety_denied_info' ? (
            <ChatBlockRenderer
              key={getDisplayBlockKey(block, index + blockKeyOffset)}
              block={block}
              chatPendingQuestions={chatPendingQuestions}
              originChatTabId={originChatTabId}
              originMessageId={message.id}
            />
          ) : null,
        )}
      </div>
    );
  }
  const isSystemSingleBlock =
    message.role === 'system' &&
    message.blocks.length === 1 &&
    LAYOUT_BLOCK_TYPES.has(message.blocks[0].type);

  if (isSystemSingleBlock) {
    return message.blocks.map((block, i) => (
      <ChatBlockRenderer
        key={getDisplayBlockKey(block, i)}
        block={block}
        chatPendingQuestions={chatPendingQuestions}
        invocableMentionIndex={null}
        filePathMentionIndex={null}
        originChatTabId={originChatTabId}
        originMessageId={message.id}
        isSystemMessage
      />
    ));
  }

  if (
    message.role === 'user' &&
    !message.blocks.some(
      (block) => block.type === 'text' && block.asyncQuestionAnswer,
    )
  ) {
    return (
      <UserBubble
        message={message}
        receivingContext={receivingContext}
        appliedMemory={appliedMemory}
        onResetToPoint={onResetToPoint}
        invocableMentionIndex={invocableMentionIndex}
        filePathMentionIndex={filePathMentionIndex}
        originChatTabId={originChatTabId}
        forceExpanded={forceExpandedUserMessage || forceSearchExpanded}
        onJumpToMessage={onJumpToMessage}
      />
    );
  }

  // Keep the request component mounted while its submission settles, but
  // leave no wrapper or spacing behind once it renders nothing.
  if (
    message.blocks.length > 0 &&
    message.blocks.every(
      (block) =>
        block.type === 'text' &&
        block.asyncQuestion &&
        chatPendingQuestions.some(
          (question) =>
            question.requestId === block.asyncQuestion?.requestId &&
            question.dismissedAt === undefined,
        ),
    )
  ) {
    return message.blocks.map((block, index) => (
      <ChatBlockRenderer
        key={getDisplayBlockKey(block, index)}
        block={block}
        chatPendingQuestions={chatPendingQuestions}
        originChatTabId={originChatTabId}
        originMessageId={message.id}
      />
    ));
  }

  // Messages whose blocks all render as nothing (empty text/thinking, e.g.
  // streaming artifacts) must not mount a wrapper div: the transcript's
  // space-y rules give even an empty div a margin slot, which makes the
  // bubble→reply gap visibly wider in turns that carry one.
  const hasVisibleBlocks = message.blocks.some(
    (block) =>
      !(
        (block.type === 'text' || block.type === 'thinking') &&
        block.text.trim().length === 0
      ),
  );
  if (!hasVisibleBlocks) {
    return null;
  }

  return (
    <TranscriptSearchRevealContext.Provider value={forceSearchExpanded}>
      <div
        // px-3 matches the user bubble's internal text inset so flat assistant/
        // system content shares the same left/right text edges as bubble text.
        className="focus-ring flex min-w-0 max-w-full justify-start px-3"
        data-role={message.role}
        data-chat-message-id={message.id}
        // Diagram names read headings from this message only.
        {...MARKDOWN_ROOT_PROPS}
        // The row has no existing message-level tab stop. Its interactive
        // descendants still receive their own events through the shared guard.
        {...contextMenuTarget}
      >
        <div className="flex flex-col min-w-0 max-w-full text-s fg-primary has-[[data-testid=ask-user-question-card]]:w-full has-[[data-testid=chat-visual-block]]:w-full has-[[data-chat-notice]]:w-full has-[[data-step-row]]:w-full gap-1">
          {message.blocks.map((block, i) => (
            <ChatBlockRenderer
              key={getDisplayBlockKey(block, i + blockKeyOffset)}
              block={block}
              streaming={streaming}
              settled={settled || i < message.blocks.length - 1}
              turnSettled={turnSettled}
              chatPendingQuestions={chatPendingQuestions}
              invocableMentionIndex={
                message.role === 'assistant' ? invocableMentionIndex : null
              }
              filePathMentionIndex={
                message.role === 'assistant' ? filePathMentionIndex : null
              }
              originChatTabId={originChatTabId}
              originMessageId={message.id}
              isCodeReviewChat={isCodeReviewChat}
              stripAgentCitations={message.role === 'assistant'}
              isSystemMessage={message.role === 'system'}
              progressiveMarkdown={
                message.role === 'assistant' &&
                turnExpanded &&
                !forceSearchExpanded
              }
            />
          ))}
        </div>
      </div>
      {contextMenu}
    </TranscriptSearchRevealContext.Provider>
  );
});

import { useSentAttachments } from '@/hooks/useSentAttachments';
import type { FilePathMentionIndex } from '@/lib/filePathMentionIndex';
import type { InvocableMentionIndex } from '@/lib/invocableMentionIndex';
import { buildPluginMentionIndex } from '@/lib/pluginMentionIndex';
import type { AppliedOrgMemoryTurn } from '@/stores/chatStore';
import {
  UserBubble as SharedUserBubble,
  UserBubbleCancelledNote,
  SteeringTitle,
  steeringRequestPresentation,
} from '@canopy/ui-shared';
import {
  AutoResumeMarker,
  readMessageAutoResume,
  SUBAGENT_REFERENCE_PREFIX,
  SubagentReferenceAttachment,
  splitSubagentReference,
  useChatMessageContextMenu,
} from '@canopy/ui-shared/components';
import {
  AgentSentTitle,
  useAgentSentReceivingContext,
  type AgentSentReceivingContext,
} from '@canopy/ui-shared';
import {
  memo,
  useCallback,
  useContext,
  useMemo,
  useState,
  type JSX,
} from 'react';
import { ChatBlockRenderer } from './ChatBlockRenderer';
import { CollapsibleUserMessageContent } from './CollapsibleUserMessageContent';
import { MemoryUsedButton } from './MemoryUsedDialog';
import { MessageImages } from './MessageImages';
import { MutedUserBubblesContext } from './muted-user-bubbles-context';
import { ResetToPointDialog } from './ResetToPointDialog';
import type { DisplayMessage } from './types';
import { WatcherFiredTitle } from './WatcherFiredTitle';

interface UserBubbleProps {
  receivingContext?: AgentSentReceivingContext;
  message: DisplayMessage;
  /**
   * Worktree-only revert handler. When provided, the bubble renders a
   * "Revert" hover action that opens the confirmation dialog.
   */
  onResetToPoint?: (userMessageId: string) => Promise<void>;
  invocableMentionIndex?: InvocableMentionIndex | null;
  filePathMentionIndex?: FilePathMentionIndex | null;
  originChatTabId?: string;
  appliedMemory?: AppliedOrgMemoryTurn;
  forceExpanded?: boolean;
  /**
   * Jump-to-this-message handler supplied by the transcript. Clicking the
   * bubble body (not its toggles/links) scrolls the message to the top of the
   * panel; the bubble advertises it with a pointer cursor.
   */
  onJumpToMessage?: (element: HTMLElement) => void;
}

export const UserBubble = memo(function UserBubble({
  message,
  receivingContext: explicitContext,
  onResetToPoint,
  invocableMentionIndex,
  filePathMentionIndex,
  originChatTabId,
  appliedMemory,
  forceExpanded = false,
  onJumpToMessage,
}: UserBubbleProps): JSX.Element {
  const receivingContext = useAgentSentReceivingContext(explicitContext);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const mutedBubble = useContext(MutedUserBubblesContext);
  // Everything sent with the message is a tile inside the bubble.
  const attachments = useSentAttachments(message.attachmentPaths);
  const hasBody = message.blocks.some(
    (block) => block.type !== 'text' || block.text.trim() !== '',
  );
  // Early access: Copy and Revert sit on the bubble's corner at every width,
  // so a narrow bubble (the App Advisor panel) reserves no room for them.

  // Whole-plugin `@` mentions render as chips only where this message's own
  // pills say so — never by scanning prose against the plugin catalog.
  const pluginMentionIndex = useMemo(
    () =>
      buildPluginMentionIndex(
        message.blocks.flatMap((block) =>
          block.type === 'file_references' ? block.references : [],
        ),
      ),
    [message.blocks],
  );

  // A delegate's steering request arrives as a hidden instruction block; show
  // the request and its sender instead. An outside agent controls its message
  // text, so text-derived presentation never applies to it: its trusted
  // sender marker always shows.
  const agentSent = message.agentSent;
  const steeringRequest = useMemo(() => {
    const textBlockIndex = message.blocks.findIndex(
      (block) => block.type === 'text',
    );
    const textBlock = message.blocks[textBlockIndex];
    if (textBlock?.type !== 'text') return null;
    // Only a managed delegate's request keeps a text-derived presentation.
    if (agentSent && !('kind' in agentSent)) return null;
    const request = steeringRequestPresentation(textBlock.text, agentSent);
    return request ? { ...request, textBlockIndex } : null;
  }, [agentSent, message.blocks]);

  const attachedSubagentReference = useMemo(() => {
    const firstTextBlockIndex = message.blocks.findIndex(
      (block) => block.type === 'text',
    );
    const firstTextBlock = message.blocks[firstTextBlockIndex];
    if (
      agentSent ||
      firstTextBlock?.type !== 'text' ||
      !firstTextBlock.text.startsWith(`${SUBAGENT_REFERENCE_PREFIX} `)
    ) {
      return null;
    }
    const split = splitSubagentReference(firstTextBlock.text);
    if (!split.reference) return null;
    return {
      firstTextBlockIndex,
      body: split.body,
      title: split.reference.title,
    };
  }, [agentSent, message.blocks]);

  const copyText = message.blocks
    .flatMap((block, blockIndex) => {
      if (block.type === 'text') {
        return [
          steeringRequest?.textBlockIndex === blockIndex
            ? steeringRequest.text
            : attachedSubagentReference?.firstTextBlockIndex === blockIndex
              ? attachedSubagentReference.body
              : block.text,
        ];
      }
      if (block.type === 'file_references') {
        return block.references.map((reference) => `@${reference.displayPath}`);
      }
      return [];
    })
    .join('\n');
  // The message menu (CAN-4277) copies a selection inside the bubble; the
  // corner Copy badge copies `copyText`.
  const { targetProps: contextMenuTarget, menu: contextMenu } =
    useChatMessageContextMenu({ messageId: message.id });

  const handleResetClick = useCallback((): void => {
    setResetDialogOpen(true);
  }, []);

  const handleResetConfirm = useCallback(async (): Promise<void> => {
    if (!onResetToPoint) return;
    await onResetToPoint(message.id);
    setResetDialogOpen(false);
  }, [message.id, onResetToPoint]);

  const handleResetCancel = useCallback((): void => {
    setResetDialogOpen(false);
  }, []);

  const handleRevertClick = onResetToPoint ? handleResetClick : undefined;
  // Only an input the provider consumed inside a running turn is steering. A
  // steer picked up after its turn settled starts a brand new turn, so it is
  // an ordinary prompt and anchors its own turn group.
  const isSteering = message.blocks.some(
    (block) =>
      block.type === 'text' &&
      block.steering !== undefined &&
      block.steering.startsTurn !== true,
  );
  // An app-sent resume prompt is never a human bubble. Its provenance is the
  // persisted source and metadata, never the prompt's text.
  const isAutoResume = message.userMessageSource === 'auto_resume';
  const autoResume = isAutoResume ? readMessageAutoResume(message) : undefined;
  const autoResumeMarker = isAutoResume ? (
    <AutoResumeMarker
      autoResume={autoResume}
      providerName={autoResume?.providerName}
      timestamp={message.timestamp}
      text={copyText}
      copyText={
        autoResume && !autoResume.resendsUserMessage ? copyText : undefined
      }
      onJumpToMessage={onJumpToMessage}
    />
  ) : null;
  if (autoResume && !autoResume.resendsUserMessage) {
    // A generated nudge: the marker takes the bubble's slot and keeps its
    // message anchor for jumps, search and turn grouping.
    return (
      <>
        <div
          {...contextMenuTarget}
          data-role="user"
          data-chat-message-id={message.id}
        >
          {autoResumeMarker}
        </div>
        {contextMenu}
      </>
    );
  }
  const statusHeader = message.watcherFired ? (
    <WatcherFiredTitle watcherFired={message.watcherFired} />
  ) : steeringRequest ? (
    steeringRequest.title
  ) : isSteering ? (
    <SteeringTitle />
  ) : undefined;

  return (
    <>
      {autoResumeMarker}
      {attachedSubagentReference ? (
        <SubagentReferenceAttachment title={attachedSubagentReference.title} />
      ) : null}
      <SharedUserBubble
        copyText={copyText}
        onRevert={handleRevertClick}
        onNavigate={onJumpToMessage}
        contextMenu={contextMenuTarget}
        actionsOnCorner={true}
        variant={
          message.watcherFired || steeringRequest?.variant === 'info'
            ? 'info'
            : mutedBubble || isAutoResume
              ? 'muted'
              : 'default'
        }
        header={
          // Plain messages keep an undefined header so the bubble can skip.
          // An agent-sent message has no text-derived presentation, so its
          // title row carries the steering state itself.
          message.agentSent ? (
            <AgentSentTitle
              agentSent={message.agentSent}
              receivingContext={receivingContext}
              steering={isSteering}
            />
          ) : (
            statusHeader
          )
        }
        media={
          attachments.length > 0 ? (
            <MessageImages attachments={attachments} alone={!hasBody} />
          ) : null
        }
        footerGap="tight"
        footer={
          appliedMemory ? <MemoryUsedButton memory={appliedMemory} /> : null
        }
      >
        <div data-chat-message-id={message.id}>
          <CollapsibleUserMessageContent
            forceExpanded={forceExpanded}
            measurementKey={message.id}
          >
            {message.blocks.map((block, i) => (
              <ChatBlockRenderer
                key={i}
                block={
                  block.type !== 'text'
                    ? block
                    : steeringRequest?.textBlockIndex === i
                      ? { ...block, text: steeringRequest.text }
                      : attachedSubagentReference?.firstTextBlockIndex === i
                        ? { ...block, text: attachedSubagentReference.body }
                        : block
                }
                invocableMentionIndex={invocableMentionIndex}
                filePathMentionIndex={filePathMentionIndex}
                pluginMentionIndex={pluginMentionIndex}
                originChatTabId={originChatTabId}
                preserveLineBreaks
              />
            ))}
          </CollapsibleUserMessageContent>
        </div>
        {message.cancelled ? <UserBubbleCancelledNote /> : null}
      </SharedUserBubble>
      {contextMenu}
      {resetDialogOpen && (
        <ResetToPointDialog
          onConfirm={handleResetConfirm}
          onCancel={handleResetCancel}
        />
      )}
    </>
  );
});

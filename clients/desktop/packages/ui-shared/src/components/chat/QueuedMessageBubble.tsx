import { Stack } from '../../primitives/Stack';
import type { AgentSentInfo } from '@canopy/protocol/remote-control/shell/external-agent-sender';
import {
  AgentSentTitle,
  type AgentSentReceivingContext,
} from './AgentSentTitle';
import { useAgentSentReceivingContext } from './AgentSentReceivingContext';
import { memo, type JSX, type ReactNode } from 'react';
import type {
  ChatTurnPhase,
  ChatWatcherFiredInfo,
  QueuedMessageRetryBlockedReason,
  QueuedMessageWaitingReason,
  SettingsHeldChange,
} from '@canopy/protocol/remote-control/shell';
import { QueuedMessageActions } from './QueuedMessageActions';
import { QueuedMessageContent } from './QueuedMessageReason';
import { hostMessagePresentation } from './SteeringRequestTitle';
import { QueuedWatcherRow } from './QueuedWatcherRow';
import {
  MessageEditSurface,
  type MessageEditHandler,
} from './MessageEditEntry';

export {
  QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP,
  QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP_TITLE,
  QUEUED_MESSAGE_RETRY_BLOCKED_TOOLTIPS,
} from './QueuedMessageActions';

export interface QueuedMessageBubbleMessage {
  readonly agentSent?: AgentSentInfo;
  readonly id: string;
  readonly text: string;
  /** The host's marker on a fired watcher's message. */
  readonly watcherFired?: ChatWatcherFiredInfo;
  readonly reason?: string;
  readonly waitingReason?: QueuedMessageWaitingReason;
  readonly editLocked?: boolean;
  /** The host cannot hold the row while editing, so double-click stays off. */
  readonly editLockAdvisory?: boolean;
  readonly forceLocked?: boolean;
  /** The host holds this row: Retry renders disabled with the reason. */
  readonly retryBlockedReason?: QueuedMessageRetryBlockedReason;
  readonly steerBlockedByCapabilityChange?: boolean;
  /** See `QueuedMessageActionsProps.settingsHeld`. */
  readonly restartHeldChanges?: readonly SettingsHeldChange[];
}

export interface QueuedMessageBubbleProps {
  readonly receivingContext?: AgentSentReceivingContext;
  readonly message: QueuedMessageBubbleMessage;
  /** Optional attachment rendered above the bubble surface. */
  readonly attachment?: ReactNode;
  readonly onCancel?: () => void;
  /** Opens the editor from the Edit badge or a double-click on the bubble. */
  readonly onEdit?: MessageEditHandler;
  /** Interrupt: stops the running turn so this message sends now. */
  readonly onForce?: () => void;
  readonly onSteer?: () => void;
  /** Retry a send whose delivery failed or is uncertain. */
  readonly onRetry?: () => void;
  /** Start a message that waits on something other than a running turn. */
  readonly onRunNow?: () => void;
  readonly steeringSupported?: boolean;
  /**
   * The host-reported phase of the chat's turn. Steer and Interrupt render
   * only in `foreground`; `undefined` (an older host) keeps the earlier rule.
   */
  readonly turnPhase?: ChatTurnPhase;
}

export const QueuedMessageBubble = memo(function QueuedMessageBubble({
  message,
  receivingContext: explicitContext,
  attachment,
  onCancel,
  onEdit,
  onForce,
  onSteer,
  onRetry,
  onRunNow,
  steeringSupported = false,
  turnPhase,
}: QueuedMessageBubbleProps): JSX.Element {
  const receivingContext = useAgentSentReceivingContext(explicitContext);
  // A delegate's steering request or a fired watcher arrives as a hidden
  // instruction block; show its readable part under its title instead.
  const steeringRequest = hostMessagePresentation(
    message.text,
    undefined,
    'block',
    message.watcherFired,
  );
  const paragraphs = (steeringRequest?.text ?? message.text).split(/\n{2,}/);
  const editHandler = message.editLocked ? undefined : onEdit;
  const footer = (
    <QueuedMessageActions
      placement="footer"
      turnPhase={turnPhase}
      onSteer={onSteer}
      onInterrupt={onForce}
      onRetry={onRetry}
      onRunNow={onRunNow}
      retryBlockedReason={message.retryBlockedReason}
      steeringSupported={steeringSupported}
      steerBlockedByCapabilityChange={message.steerBlockedByCapabilityChange}
      editLocked={message.editLocked}
      forceLocked={message.forceLocked}
      settingsHeld={message.restartHeldChanges}
    />
  );
  // A fired watcher waits as the quiet row it becomes, not an info bubble
  // (chat-blocks.md, Watchers). A message with a sender keeps its bubble.
  if (message.watcherFired && !message.agentSent) {
    return (
      <QueuedWatcherRow
        watcherFired={message.watcherFired}
        text={message.text}
        reason={message.reason}
        waitingReason={message.waitingReason}
        onCancel={onCancel}
        footer={footer}
      />
    );
  }
  return (
    <div className="flex justify-end" data-testid="queued-message-bubble">
      {/*
        `min-w-0` is load-bearing: as a flex item this bubble's automatic
        minimum size is its content's min-content width, so a single
        unbreakable token (a pasted URL) would size the box wider than the
        row and `justify-end` would push the excess off the panel's left
        edge. The inner `break-words` can only wrap once the box is
        constrained.
      */}
      <div className="group relative min-w-0 max-w-full">
        <Stack gap="tight" className="min-w-0">
          {attachment ? (
            <div className="flex justify-end" data-no-double-click-edit>
              {attachment}
            </div>
          ) : null}
          <MessageEditSurface
            onEdit={message.editLockAdvisory ? undefined : editHandler}
            variant="draft"
            tone={steeringRequest?.variant === 'info' ? 'info' : 'default'}
          >
            <QueuedMessageActions
              placement="corner"
              variant="badge"
              onEdit={onEdit}
              onCancel={onCancel}
              editLocked={message.editLocked}
              editLabel="Edit queued message"
            />
            <QueuedMessageContent
              reason={message.reason}
              waitingReason={message.waitingReason}
              heading={
                <>
                  {message.agentSent && (
                    <AgentSentTitle
                      agentSent={message.agentSent}
                      receivingContext={receivingContext}
                    />
                  )}
                  {steeringRequest?.title}
                </>
              }
            >
              <div className="flex flex-col gap-2 break-words">
                {paragraphs.map((paragraph, index) => (
                  <p
                    key={`${message.id}-${index}`}
                    className="whitespace-pre-wrap"
                  >
                    {paragraph}
                  </p>
                ))}
              </div>
            </QueuedMessageContent>
          </MessageEditSurface>
        </Stack>
        {footer}
      </div>
    </div>
  );
});

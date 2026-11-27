import { memo, useMemo, type JSX } from 'react';
import {
  AgentSentTitle,
  useAgentSentReceivingContext,
} from '@canopy/ui-shared';
import {
  QUEUED_MESSAGE_BUSY_TOOLTIP,
  QUEUED_MESSAGE_EDITING_TOOLTIP,
  QUEUED_MESSAGE_SENDING_TOOLTIP,
  QueuedMessageReason,
  QueuedMessageRow,
  Stack,
  splitSubagentReference,
  SUBAGENT_REFERENCE_PREFIX,
  type QueuedMessageAttachment,
  type QueuedMessageReorderProps,
} from '@canopy/ui-shared/components';
import { ArrowUpIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { QueuedMessageForceKind } from '@canopy/ui-shared/lib';
import type { SettingsHeldChange } from '@canopy/desktop-shared/types';
import { useImagePreviews } from '@/hooks/useSentAttachments';
import {
  getFilenameFromPath,
  PREVIEWABLE_IMAGE_FILENAME,
  VIDEO_FILENAME,
} from '@/lib/file-type';
import type { QueuedChatMessage } from '@/stores/chatStore';
import { QueuedMessageEditFailureBanner } from './QueuedMessageEditFailureBanner';

const NO_PATHS: readonly string[] = [];

/**
 * The queued message's attachments for the row: images with their preview,
 * videos with their first frame (an empty tile where the OS draws none), and
 * every other file by name. An
 * image whose preview does not come back as an image shows as a file.
 */
function useQueuedAttachments(
  attachmentPaths: readonly string[] | undefined,
): QueuedMessageAttachment[] {
  const paths = attachmentPaths ?? NO_PATHS;
  const imagePaths = useMemo(
    () => paths.filter((path) => PREVIEWABLE_IMAGE_FILENAME.test(path)),
    [paths],
  );
  const previews = useImagePreviews(imagePaths);
  const videoPaths = useMemo(
    () => paths.filter((path) => VIDEO_FILENAME.test(path)),
    [paths],
  );
  const frames = useImagePreviews(videoPaths, { videoFrame: true });
  return useMemo(
    () =>
      paths.map((path): QueuedMessageAttachment => {
        const name = getFilenameFromPath(path);
        if (VIDEO_FILENAME.test(path))
          return {
            key: path,
            kind: 'video',
            name,
            src: frames.get(path) ?? null,
          };
        const preview = previews.get(path);
        if (PREVIEWABLE_IMAGE_FILENAME.test(path) && preview !== null)
          return { key: path, kind: 'image', name, src: preview ?? null };
        // The row's own file glyph, in its quiet ink: type icons such as the
        // PDF mark lose their contrast on the dark card.
        return { key: path, kind: 'file', name };
      }),
    [frames, paths, previews],
  );
}

interface QueuedMessageCompactRowProps {
  readonly message: QueuedChatMessage;
  readonly index: number;
  readonly onClear?: (index: number) => void;
  readonly onForce?: (index: number) => void;
  readonly forceKind?: QueuedMessageForceKind;
  readonly onSteer?: (index: number) => void;
  readonly steeringSupported?: boolean;
  /** Settings that wait for live background work; see `QueuedMessageRow`. */
  readonly settingsHeld?: readonly SettingsHeldChange[];
  readonly onEdit?: (index: number, message: QueuedChatMessage) => void;
  readonly canForce?: boolean;
  /** Another queued message is open in the editor. */
  readonly anyEditing?: boolean;
  readonly reorder?: QueuedMessageReorderProps;
  /**
   * `drawer`: a row of the composer work drawer's Queued tab, with Interrupt
   * as the arrow-up icon button.
   */
  readonly surface?: 'tray' | 'drawer';
}

/**
 * The desktop host of the shared {@link QueuedMessageRow}: it maps a queued
 * chat message and the queue's handlers onto the row, with the same
 * eligibility the transcript bubble uses.
 */
export const QueuedMessageCompactRow = memo(function QueuedMessageCompactRow({
  message,
  index,
  onClear,
  onForce,
  forceKind,
  onSteer,
  steeringSupported = false,
  settingsHeld,
  onEdit,
  canForce = false,
  anyEditing = false,
  reorder,
  surface = 'tray',
}: QueuedMessageCompactRowProps): JSX.Element {
  const receivingContext = useAgentSentReceivingContext();
  const attachments = useQueuedAttachments(message.attachmentPaths);
  const agentSent = message.agentSent ?? message.dispatchOptions?.agentSent;
  // Host-mirror rows carry the marker directly; renderer-local rows carry it
  // inside their queued dispatch options.
  const watcherFired =
    message.watcherFired ?? message.dispatchOptions?.watcherFired;
  const text = message.text.startsWith(`${SUBAGENT_REFERENCE_PREFIX} `)
    ? splitSubagentReference(message.text).body
    : message.text;
  // Until the host queues the message its actions wait; the row shows them
  // disabled, with the reason, rather than hiding Edit message.
  const sending = message.pendingSend === true;
  const canEdit =
    !message.editLocked &&
    Boolean(onEdit) &&
    message.queuedHookQueueId === undefined &&
    !anyEditing;
  const reason =
    message.reason ??
    (message.waitingReason !== undefined ? (
      <QueuedMessageReason
        waitingReason={message.waitingReason}
        layout="inline"
      />
    ) : undefined);
  // Steer and Send now stay on the row whenever the chat offers them; when
  // they can't run now they wait, disabled, and say why. A row the host
  // locks (behind a turn its worktree's setup holds) waits for that step.
  const waitReason = sending
    ? QUEUED_MESSAGE_SENDING_TOOLTIP
    : anyEditing
      ? QUEUED_MESSAGE_EDITING_TOOLTIP
      : message.forceLocked === true
        ? QUEUED_MESSAGE_BUSY_TOOLTIP
        : undefined;
  const steerReady = Boolean(onSteer) && waitReason === undefined;
  const capabilityChange =
    steeringSupported &&
    !anyEditing &&
    !sending &&
    message.steerBlockedByCapabilityChange === true;
  // On a chat that can steer, a row the host doesn't mark steerable yet
  // (the agent is between steps) waits for the current step.
  const steerUnavailableReason =
    steeringSupported && !steerReady && !capabilityChange
      ? (waitReason ?? QUEUED_MESSAGE_BUSY_TOOLTIP)
      : undefined;
  const interruptReady =
    canForce && Boolean(onForce) && waitReason === undefined;
  return (
    <Stack gap="tight">
      <QueuedMessageRow
        data-testid="queued-message-bubble"
        data-queued-message-id={message.hostQueueEntryId}
        text={text}
        watcherFired={watcherFired}
        label={
          agentSent ? (
            <AgentSentTitle
              agentSent={agentSent}
              receivingContext={receivingContext}
              layout="inline"
            />
          ) : undefined
        }
        status={reason}
        attachments={attachments}
        reorder={reorder}
        sending={sending}
        onEdit={canEdit ? (): void => onEdit?.(index, message) : undefined}
        onSteer={steerReady ? (): void => onSteer?.(index) : undefined}
        steerUnavailableReason={steerUnavailableReason}
        steerBlockedByCapabilityChange={capabilityChange}
        settingsHeld={settingsHeld}
        onInterrupt={
          interruptReady && message.retryBlockedReason === undefined
            ? (): void => onForce?.(index)
            : undefined
        }
        forceKind={forceKind}
        interruptUnavailableReason={
          onForce && !interruptReady
            ? (waitReason ?? QUEUED_MESSAGE_BUSY_TOOLTIP)
            : undefined
        }
        sendBlockedReason={
          canForce && !anyEditing && !message.editLocked
            ? message.retryBlockedReason
            : undefined
        }
        onDelete={onClear ? (): void => onClear(index) : undefined}
        surface={surface}
        interruptIcon={surface === 'drawer' ? ArrowUpIcon : undefined}
      />
      <QueuedMessageEditFailureBanner message={message} />
    </Stack>
  );
});

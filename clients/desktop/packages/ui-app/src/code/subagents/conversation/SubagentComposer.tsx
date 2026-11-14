'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import {
  isLiveSubagentStatus,
  subagentRecipients,
  withSubagentReference,
  type SubagentNode,
  type SubagentRecipient,
  type SubagentTree,
} from '@canopy/ui-shared';
import { ArrowUp, StopFilledIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  ChatComposerShell,
  ChatComposerToolbar,
  QueuedMessageBubble,
  SubagentReferenceChip,
  SubagentRecipientMenu,
  SubagentRecipientTrigger,
  Tooltip,
  Button,
  SUBAGENT_COMPOSER_INTERRUPT_LABEL,
  SUBAGENT_COMPOSER_INTERRUPT_UNAVAILABLE_LABEL,
  SUBAGENT_COMPOSER_NATIVE_NOTICE,
  SUBAGENT_COMPOSER_READ_ONLY_NOTICE,
  SUBAGENT_COMPOSER_SEND_ACCESSIBLE_LABEL,
  SUBAGENT_COMPOSER_SEND_LABEL,
  SUBAGENT_INTERRUPT_FAILED_LABEL,
  SUBAGENT_QUEUE_AWAITING_SETTLE_LABEL,
  SUBAGENT_QUEUE_INTERRUPT_LABEL,
  SUBAGENT_QUEUE_RETRY_LABEL,
  SUBAGENT_QUEUE_SENDING_LABEL,
  SUBAGENT_SEND_FAILED_LABEL,
  subagentComposerPlaceholder,
  subagentComposerSendAndOpenLabel,
  subagentFailureWithReason,
} from '@canopy/ui-shared';
import type {
  SubagentCommandResult,
  SubagentMessageResult,
  SubagentMessageRequest,
  SubagentNativeInterruptResult as SubagentNativeInterruptResultType,
  SubagentViewerCapabilities,
} from '../types';
import {
  getSubagentComposerDraft,
  subagentDraftKey,
  useSubagentComposerDraft,
  useSubagentComposerStore,
} from './subagent-composer-store';
import { useSubagentMessageQueue } from './useSubagentMessageQueue';
import {
  ErrorBanner,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared/components';

export interface SubagentComposerProps {
  /** Root chat whose tree owns this subagent. */
  readonly rootChatId: string;
  /** Complete or partial root-chat subagent tree. */
  readonly tree: SubagentTree;
  /** Selected subagent node. */
  readonly node: SubagentNode;
  /** Host-derived capability gates for this shared composer. */
  readonly capabilities: SubagentViewerCapabilities;
  /** Recipient order already memoized by the panel for this tree. */
  readonly recipients?: readonly SubagentRecipient[];
  /** Root chat busy state shown by its recipient option. */
  readonly rootChatBusy?: boolean;
  /** Deliver follow-up, steer, and interrupt operations to this managed node. */
  readonly onMessageSubagent?: (
    request: SubagentMessageRequest,
  ) => Promise<SubagentMessageResult>;
  /** Interrupt a provider-native Claude or Codex subagent. */
  readonly onInterruptNative?: () => Promise<SubagentNativeInterruptResultType>;
  /** Send to a parent/root recipient and open or focus that chat. */
  readonly onSendToRecipient?: (
    recipient: SubagentRecipient,
    text: string,
  ) => Promise<SubagentCommandResult>;
  /** Inject a deterministic operation identifier generator in tests. */
  readonly createOperationId?: () => string;
}

function reasonFromError(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function queuedStateLabel(state: string): string | undefined {
  if (state === 'sending') return SUBAGENT_QUEUE_SENDING_LABEL;
  if (state === 'interrupting') return SUBAGENT_QUEUE_INTERRUPT_LABEL;
  if (state === 'awaiting-settle') return SUBAGENT_QUEUE_AWAITING_SETTLE_LABEL;
  return undefined;
}

/** Composer, To picker and persistent local queue for one subagent chat. */
export function SubagentComposer({
  rootChatId,
  tree,
  node,
  capabilities,
  recipients: recipientInput,
  rootChatBusy = false,
  onMessageSubagent,
  onInterruptNative,
  onSendToRecipient,
  createOperationId,
}: SubagentComposerProps): JSX.Element {
  const key = subagentDraftKey(rootChatId, node.id);
  const draft = useSubagentComposerDraft(key);
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recipients = useMemo(
    () => recipientInput ?? subagentRecipients(tree, node.id),
    [recipientInput, tree, node.id],
  );
  const firstRecipient = recipients[0];
  const selectedRecipient =
    recipients.find((recipient) => recipient.id === draft.recipientId) ??
    firstRecipient;
  const queueActions = useSubagentMessageQueue({
    key,
    node,
    onMessageSubagent,
    createOperationId,
  });

  useEffect((): void => {
    if (firstRecipient) {
      useSubagentComposerStore.getState().ensureDraft(key, firstRecipient.id);
    }
  }, [firstRecipient, key]);

  const setInput = useCallback(
    (input: string): void => {
      useSubagentComposerStore.getState().setInput(key, input);
    },
    [key],
  );

  // A parent delegate is messaged through the delegation messaging the host
  // gates with `messaging`; the root chat is the ordinary chat send and only
  // needs `onSendToRecipient`.
  const otherRecipientSendable = useCallback(
    (recipient: SubagentRecipient): boolean =>
      recipient.kind !== 'self' &&
      recipient.canMessage &&
      onSendToRecipient !== undefined &&
      (recipient.kind !== 'ancestor' || capabilities.messaging),
    [capabilities.messaging, onSendToRecipient],
  );

  const canSelectRecipient = useCallback(
    (recipient: SubagentRecipient): boolean => {
      if (recipient.kind === 'self') {
        // A native subagent takes no messages, but choosing it reaches
        // Interrupt; its input stays disabled.
        return node.kind === 'managed'
          ? capabilities.messaging && onMessageSubagent !== undefined
          : capabilities.nativeInterrupt && onInterruptNative !== undefined;
      }
      return otherRecipientSendable(recipient);
    },
    [
      capabilities.messaging,
      capabilities.nativeInterrupt,
      node.kind,
      onInterruptNative,
      onMessageSubagent,
      otherRecipientSendable,
    ],
  );

  const recipientDisabledReason = useCallback(
    (recipient: SubagentRecipient): string | undefined => {
      if (!recipient.canMessage && recipient.kind === 'self') {
        return node.kind === 'managed'
          ? SUBAGENT_COMPOSER_READ_ONLY_NOTICE
          : SUBAGENT_COMPOSER_NATIVE_NOTICE;
      }
      if (recipient.kind === 'self' && !capabilities.messaging) {
        return SUBAGENT_COMPOSER_READ_ONLY_NOTICE;
      }
      if (recipient.kind !== 'self' && onSendToRecipient === undefined) {
        return SUBAGENT_COMPOSER_READ_ONLY_NOTICE;
      }
      if (recipient.kind === 'ancestor' && !capabilities.messaging) {
        return SUBAGENT_COMPOSER_READ_ONLY_NOTICE;
      }
      return undefined;
    },
    [capabilities.messaging, node.kind, onSendToRecipient],
  );

  const selfRecipient = selectedRecipient?.kind === 'self';
  const live = isLiveSubagentStatus(node.status);
  const nativeSelf = selfRecipient && node.kind !== 'managed';
  const selfMessagingAvailable =
    node.kind === 'managed' &&
    capabilities.messaging &&
    onMessageSubagent !== undefined;
  const otherRecipientAvailable = recipients.some(otherRecipientSendable);
  const onlyReadOnlyNotice =
    node.kind === 'managed' &&
    !selfMessagingAvailable &&
    !otherRecipientAvailable;
  const selectedOtherUnavailable =
    selectedRecipient !== undefined &&
    !selfRecipient &&
    !otherRecipientSendable(selectedRecipient);
  const inputDisabled =
    nativeSelf ||
    (selfRecipient && !selfMessagingAvailable) ||
    selectedOtherUnavailable ||
    selectedRecipient === undefined;
  const placeholder = nativeSelf
    ? SUBAGENT_COMPOSER_NATIVE_NOTICE
    : (selfRecipient && !selfMessagingAvailable) || selectedOtherUnavailable
      ? SUBAGENT_COMPOSER_READ_ONLY_NOTICE
      : selectedRecipient
        ? subagentComposerPlaceholder(selectedRecipient, live)
        : SUBAGENT_COMPOSER_READ_ONLY_NOTICE;
  const canSendToSelected =
    selectedRecipient !== undefined &&
    (selfRecipient
      ? selfMessagingAvailable
      : otherRecipientSendable(selectedRecipient));

  const sendToRecipient = useCallback(
    (recipient: SubagentRecipient, rawText: string): void => {
      const text = rawText.trim();
      if (
        !onSendToRecipient ||
        !otherRecipientSendable(recipient) ||
        text.length === 0
      )
        return;
      const store = useSubagentComposerStore.getState();
      // One delivery at a time: a second Send before this one settles must
      // not deliver the same message again.
      if (!store.beginOperation(key)) return;
      store.setError(key, null);
      const attachedText = withSubagentReference(
        { kind: node.kind, id: node.id, title: node.title },
        text,
      );
      void (async (): Promise<void> => {
        try {
          const result = await onSendToRecipient(recipient, attachedText);
          if (result.ok) {
            if (getSubagentComposerDraft(key).input === rawText) {
              store.setInput(key, '');
            }
            store.setError(key, null);
          } else {
            store.setError(
              key,
              subagentFailureWithReason(
                SUBAGENT_SEND_FAILED_LABEL,
                result.error,
              ),
            );
          }
        } catch (error: unknown) {
          store.setError(
            key,
            subagentFailureWithReason(
              SUBAGENT_SEND_FAILED_LABEL,
              reasonFromError(error),
            ),
          );
        } finally {
          store.endOperation(key);
        }
      })();
    },
    [
      key,
      node.id,
      node.kind,
      node.title,
      onSendToRecipient,
      otherRecipientSendable,
    ],
  );

  const interruptNative = useCallback((): void => {
    if (!capabilities.nativeInterrupt || !onInterruptNative) return;
    const store = useSubagentComposerStore.getState();
    store.setError(key, null);
    void (async (): Promise<void> => {
      try {
        const result: SubagentNativeInterruptResultType =
          await onInterruptNative();
        if (result.ok) {
          store.setError(key, null);
        } else {
          store.setError(
            key,
            subagentFailureWithReason(
              SUBAGENT_INTERRUPT_FAILED_LABEL,
              result.error,
            ),
          );
        }
      } catch (error: unknown) {
        store.setError(
          key,
          subagentFailureWithReason(
            SUBAGENT_INTERRUPT_FAILED_LABEL,
            reasonFromError(error),
          ),
        );
      }
    })();
  }, [capabilities.nativeInterrupt, key, onInterruptNative]);

  const send = useCallback((): void => {
    if (!selectedRecipient || inputDisabled || !canSendToSelected) return;
    if (selectedRecipient.kind === 'self') {
      if (node.kind === 'managed') queueActions.submit(draft.input);
      return;
    }
    sendToRecipient(selectedRecipient, draft.input);
  }, [
    canSendToSelected,
    draft.input,
    inputDisabled,
    node.kind,
    queueActions,
    selectedRecipient,
    sendToRecipient,
  ]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (
        event.key !== 'Enter' ||
        event.shiftKey ||
        event.nativeEvent.isComposing
      ) {
        return;
      }
      event.preventDefault();
      send();
    },
    [send],
  );

  // A native subagent takes no messages, so a kept draft (typed for another
  // recipient) must not hide its only action.
  const interruptVisible =
    selfRecipient &&
    live &&
    (nativeSelf || (selfMessagingAvailable && draft.input.trim().length === 0));
  const interruptEnabled = nativeSelf
    ? capabilities.nativeInterrupt && onInterruptNative !== undefined
    : selfMessagingAvailable;
  const buttonTooltip = interruptVisible
    ? interruptEnabled
      ? SUBAGENT_COMPOSER_INTERRUPT_LABEL
      : SUBAGENT_COMPOSER_INTERRUPT_UNAVAILABLE_LABEL
    : selfRecipient
      ? SUBAGENT_COMPOSER_SEND_LABEL
      : selectedRecipient
        ? subagentComposerSendAndOpenLabel(selectedRecipient.title)
        : SUBAGENT_COMPOSER_SEND_LABEL;
  // Self sends queue behind an in-flight command; other recipients wait.
  const buttonDisabled = interruptVisible
    ? !interruptEnabled
    : !canSendToSelected ||
      draft.input.trim().length === 0 ||
      (!selfRecipient && draft.inFlight);

  const handleAction = useCallback((): void => {
    if (interruptVisible) {
      if (nativeSelf) interruptNative();
      else queueActions.interrupt();
      return;
    }
    send();
  }, [interruptNative, interruptVisible, nativeSelf, queueActions, send]);

  if (!selectedRecipient) {
    return (
      <div data-testid="subagent-composer" className="shrink-0 px-4 pb-4 pt-2">
        <p className="text-xs fg-secondary" role="status">
          {SUBAGENT_COMPOSER_READ_ONLY_NOTICE}
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="subagent-composer"
      className="relative shrink-0 px-4 pb-4 pt-2 flex flex-col gap-2"
    >
      {node.kind === 'managed' && draft.queue.length > 0 ? (
        <div className="mx-auto flex max-w-3xl flex-col gap-2 w-full">
          {draft.queue.map((queued, index) => {
            const isLocked =
              queued.state === 'sending' || queued.state === 'interrupting';
            const statusLabel = queuedStateLabel(queued.state);
            return (
              <div
                key={queued.id}
                data-testid={`subagent-queued-${index}`}
                data-state={queued.state}
                className="flex flex-col items-end gap-1"
              >
                <QueuedMessageBubble
                  message={{
                    id: queued.id,
                    text: queued.text,
                    editLocked: isLocked,
                    forceLocked: isLocked,
                  }}
                  steeringSupported
                  onSteer={
                    isLocked
                      ? undefined
                      : (): void => queueActions.steerDraft(queued.id)
                  }
                  onForce={
                    isLocked
                      ? undefined
                      : (): void => queueActions.interruptDraft(queued.id)
                  }
                  onEdit={
                    isLocked
                      ? undefined
                      : (): void => {
                          queueActions.editDraft(queued.id);
                          queueMicrotask(() => {
                            const input = inputRef.current;
                            if (!input) return;
                            input.focus({ preventScroll: true });
                            input.setSelectionRange(
                              input.value.length,
                              input.value.length,
                            );
                          });
                        }
                  }
                  onCancel={
                    isLocked
                      ? undefined
                      : (): void => queueActions.clearDraft(queued.id)
                  }
                />
                {queued.error ? (
                  <Notice
                    errorSource="subagent-composer-queued"
                    intent="destructive"
                    liveRegionScope="content"
                    actions={
                      <NoticeButton
                        onClick={(): void => queueActions.retryDraft(queued.id)}
                        data-testid="subagent-queue-retry"
                      >
                        {SUBAGENT_QUEUE_RETRY_LABEL}
                      </NoticeButton>
                    }
                  >
                    {queued.error}
                  </Notice>
                ) : statusLabel ? (
                  <span className="text-2xs fg-tertiary" role="status">
                    {statusLabel}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {onlyReadOnlyNotice ? (
        <p
          className="mx-auto max-w-3xl text-xs fg-secondary w-full"
          role="status"
        >
          {SUBAGENT_COMPOSER_READ_ONLY_NOTICE}
        </p>
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5 w-full">
          <ChatComposerShell>
            <div className="flex min-h-16 flex-col gap-2 px-4 pb-1 pt-3">
              {!selfRecipient ? (
                <SubagentReferenceChip title={node.title} className="w-fit" />
              ) : null}
              <textarea
                ref={inputRef}
                value={draft.input}
                onChange={(event): void => setInput(event.currentTarget.value)}
                onKeyDown={handleKeyDown}
                disabled={inputDisabled}
                placeholder={placeholder}
                data-testid="subagent-composer-input"
                rows={1}
                className="min-h-11 max-h-64 resize-none overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-1 py-1 text-s leading-5 fg-primary outline-none placeholder:fg-secondary disabled:cursor-not-allowed disabled:placeholder:fg-tertiary"
              />
            </div>
            <ChatComposerToolbar
              capsuleLayout
              leadingSlot={
                <SubagentRecipientTrigger
                  recipient={selectedRecipient}
                  open={menuOpen}
                  onClick={(): void => setMenuOpen((open) => !open)}
                  buttonRef={triggerRef}
                />
              }
              trailingSlot={
                <Tooltip
                  label={buttonTooltip}
                  shortcut={interruptVisible ? undefined : '↵'}
                >
                  <span className="inline-flex">
                    <Button
                      variant="primary"
                      iconOnly
                      onClick={handleAction}
                      disabled={buttonDisabled}
                      aria-label={
                        interruptVisible
                          ? SUBAGENT_COMPOSER_INTERRUPT_LABEL
                          : SUBAGENT_COMPOSER_SEND_ACCESSIBLE_LABEL
                      }
                      data-testid={
                        interruptVisible
                          ? 'subagent-composer-interrupt'
                          : 'subagent-composer-send'
                      }
                    >
                      {interruptVisible ? (
                        <StopFilledIcon size={16} aria-hidden />
                      ) : (
                        <ArrowUp size={16} aria-hidden />
                      )}
                    </Button>
                  </span>
                </Tooltip>
              }
            />
          </ChatComposerShell>
          <ErrorBanner
            errorSource="subagent-composer-draft"
            className="mt-2"
            error={draft.error}
          />
          <SubagentRecipientMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            anchorRef={triggerRef}
            recipients={recipients}
            selectedId={selectedRecipient.id}
            rootBusy={rootChatBusy}
            onSelect={(recipient): void =>
              useSubagentComposerStore
                .getState()
                .setRecipientId(key, recipient.id)
            }
            canSelect={canSelectRecipient}
            disabledReason={recipientDisabledReason}
          />
        </div>
      )}
    </div>
  );
}

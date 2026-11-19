'use client';

import { Stack } from '../Stack';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  ChatInputDeliveryAction,
  ChatInputDeliveryView,
} from '@canopy/protocol/portal';
import { TrashIcon } from '../../icons';
import { Button } from '../Button';
import { Tooltip } from '../Tooltip';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import {
  AgentSentTitle,
  type AgentSentReceivingContext,
} from './AgentSentTitle';
import { useAgentSentReceivingContext } from './AgentSentReceivingContext';
import { MessageEditCard } from './MessageEditCard';
import { WatcherFiredTitle } from './WatcherFiredTitle';
import { hostMessagePresentation } from './SteeringRequestTitle';
import {
  MessageEditBadge,
  MessageEditNotice,
  MessageEditSurface,
} from './MessageEditEntry';

const LABELS = {
  // Until the provider confirms, the message is still on its way.
  sending: 'Sending…',
  pending: 'Sending…',
  cancelling: 'Cancelling',
  editing: 'Editing',
  cancelled: 'Cancelled',
  'picked-up': 'Picked up',
  uncertain: 'Delivery uncertain',
  queued: 'Queued',
};

const DRAFT_REVISION_TIMEOUT_MS = 10_000;

export interface InputDeliveryListProps {
  receivingContext?: AgentSentReceivingContext;
  /** Host notice outlives a conditionally mounted queue list; empty clears it. */
  onError?: (message: string) => void;
  rows: readonly ChatInputDeliveryView[];
  onFocusedRowRemoved?: () => void;
  onAction: (
    row: ChatInputDeliveryView,
    action: ChatInputDeliveryAction,
    text?: string,
  ) => Promise<void>;
}

interface InputDeliveryRowProps {
  row: ChatInputDeliveryView;
  onAction: InputDeliveryListProps['onAction'];
  receivingContext?: AgentSentReceivingContext;
  /** Reports an action's outcome so the list can outlive a removed row. */
  onActionSettled: (rowId: string, error: string) => void;
  reportErrorInHost: boolean;
}

const InputDeliveryRow = memo(function InputDeliveryRow({
  row,
  onAction,
  receivingContext: explicitContext,
  onActionSettled,
  reportErrorInHost,
}: InputDeliveryRowProps): JSX.Element {
  const receivingContext = useAgentSentReceivingContext(explicitContext);
  const agentTitle = row.agentSent ? (
    <AgentSentTitle
      agentSent={row.agentSent}
      receivingContext={receivingContext}
    />
  ) : null;
  const [draft, setDraft] = useState(row.draft ?? row.text);
  const [acting, setBusy] = useState(false);
  // A saved draft bumps the row revision on the host. Hold every action until
  // that revision arrives so none is sent with the one the draft replaced.
  const [draftSave, setDraftSave] = useState<{ revision: number }>();
  const awaitingDraftRevision =
    row.state === 'editing' &&
    draftSave !== undefined &&
    row.revision <= draftSave.revision;
  const busy = acting || awaitingDraftRevision;
  const [error, setError] = useState('');
  const [resendWarningOpen, setResendWarningOpen] = useState(false);
  useEffect(() => {
    if (!awaitingDraftRevision) return;
    // A host can acknowledge the draft before running it (the Portal answers
    // 202), so a draft that later fails never bumps the revision. Release the
    // wait instead of leaving the row locked.
    const timer = setTimeout(() => {
      setDraftSave(undefined);
      setError('Your draft wasn’t confirmed. Check your edits before saving.');
    }, DRAFT_REVISION_TIMEOUT_MS);
    return (): void => clearTimeout(timer);
  }, [awaitingDraftRevision, draftSave]);
  const pendingAction = useRef(false);
  const editFocus = useRef<{ allowed: boolean; dispose: () => void } | null>(
    null,
  );
  useEffect(
    () => (): void => {
      editFocus.current?.dispose();
    },
    [],
  );
  const rowRef = useRef<HTMLDivElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const resendButtonRef = useRef<HTMLButtonElement>(null);
  const resendKeepButtonRef = useRef<HTMLButtonElement>(null);
  const returnEditFocus = useRef(false);
  const localDraft = useRef(false);
  const saveRevision = useRef<{ revision: number; draft: string } | undefined>(
    undefined,
  );
  const currentAction = useRef({ row, onAction });
  useEffect(() => {
    currentAction.current = { row, onAction };
  }, [row, onAction]);
  useEffect(() => {
    if (row.state !== 'editing' || !localDraft.current) {
      setDraft(row.draft ?? row.text);
      localDraft.current = false;
    }
  }, [row.draft, row.text, row.state]);
  useEffect(() => {
    if (row.state !== 'uncertain') setResendWarningOpen(false);
  }, [row.state]);
  useLayoutEffect(() => {
    if (resendWarningOpen) resendKeepButtonRef.current?.focus();
  }, [resendWarningOpen]);
  const act = async (
    action: ChatInputDeliveryAction,
    text?: string,
  ): Promise<void> => {
    if (pendingAction.current || busy) return;
    if (row.state === 'editing') {
      const element = rowRef.current;
      returnEditFocus.current =
        element?.contains(element.ownerDocument.activeElement) ?? false;
    }
    if (action === 'edit') {
      editFocus.current?.dispose();
      const document = rowRef.current?.ownerDocument;
      const attempt = {
        allowed: true,
        dispose: (): void => document?.removeEventListener('focusin', onFocus),
      };
      const onFocus = (): void => {
        attempt.allowed = false;
      };
      editFocus.current = attempt;
      document?.addEventListener('focusin', onFocus);
    }
    pendingAction.current = true;
    setBusy(true);
    setError('');
    try {
      await onAction(row, action, text);
      onActionSettled(row.id, '');
    } catch (failure) {
      if (action === 'edit') {
        editFocus.current?.dispose();
        editFocus.current = null;
      }
      const message =
        failure instanceof Error
          ? failure.message
          : 'The message action could not be completed.';
      if (!reportErrorInHost) setError(message);
      onActionSettled(row.id, message);
    } finally {
      pendingAction.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (row.state !== 'editing' || busy || draft === (row.draft ?? row.text))
      return;
    if (
      saveRevision.current?.revision === row.revision &&
      saveRevision.current.draft === draft
    )
      return;
    const timer = setTimeout(() => {
      if (pendingAction.current) return;
      pendingAction.current = true;
      setBusy(true);
      saveRevision.current = { revision: row.revision, draft };
      const current = currentAction.current;
      void current
        .onAction(current.row, 'save-draft', draft)
        .then((): void => setDraftSave({ revision: current.row.revision }))
        .catch((failure: unknown) => {
          setError(
            failure instanceof Error
              ? failure.message
              : 'The draft could not be saved.',
          );
        })
        .finally((): void => {
          pendingAction.current = false;
          setBusy(false);
        });
    }, 250);
    return (): void => clearTimeout(timer);
  }, [row.state, row.revision, row.draft, row.text, draft, busy]);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (row.state !== 'editing') return;
    const attempt = editFocus.current;
    attempt?.dispose();
    editFocus.current = null;
    const input = editorRef.current;
    if (!input || attempt?.allowed === false) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }, [row.state]);
  useEffect(() => {
    if (row.state !== 'cancelled' || busy || !returnEditFocus.current) return;
    returnEditFocus.current = false;
    const element = rowRef.current;
    const active = element?.ownerDocument.activeElement;
    // Restore the editor's focus without taking it from a different control
    // the user selected while the canonical mutation was in flight.
    if (
      active === element?.ownerDocument.body ||
      element?.contains(active ?? null)
    ) {
      editButtonRef.current?.focus();
    }
  }, [row.state, busy]);
  const statusLabel =
    row.state === 'cancelled' && row.notDelivered
      ? 'Not delivered'
      : LABELS[row.state];
  const detail =
    error ||
    row.reason ||
    (row.state === 'uncertain'
      ? 'Delivery could not be confirmed. This message will not be resent automatically.'
      : row.state === 'cancelled' && row.notDelivered
        ? 'This message never reached the agent.'
        : '');
  const shownText =
    row.state === 'cancelled' ? (row.draft ?? row.text) : row.text;
  // A generated internal row can be cancelled or resent, never edited.
  const editable =
    ((row.state === 'pending' && row.canWithdraw) ||
      row.state === 'cancelled') &&
    !row.generated;
  const steeringRequest = hostMessagePresentation(shownText);
  return (
    <div
      ref={rowRef}
      data-testid="input-delivery-row"
      data-input-row-id={row.id}
      className="min-w-0 py-3"
    >
      {row.state === 'editing' ? (
        <Stack gap="item">
          {agentTitle}
          <div className="text-s fg-secondary" role="status" aria-live="polite">
            {LABELS[row.state]}
          </div>
          <MessageEditCard
            inputRef={editorRef}
            inputTestId="input-delivery-editor"
            ariaLabel="Edit pending message"
            value={draft}
            onChange={(text) => {
              localDraft.current = true;
              setDraft(text);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                void act('close-editor', draft);
              }
            }}
            actions={
              <>
                {row.editResubmits && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void act('resend-original')}
                  >
                    Cancel edits and resend original
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void act('close-editor', draft)}
                >
                  Close
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || !draft.trim()}
                  onClick={() => void act('save', draft)}
                >
                  {row.editResubmits ? 'Save and resend' : 'Save'}
                </Button>
              </>
            }
            childrenGap="tight"
          >
            {row.attachmentCount > 0 && (
              <div className="text-xs fg-secondary">
                {row.attachmentCount} retained attachment
                {row.attachmentCount === 1 ? '' : 's'}
              </div>
            )}
            {(error || row.reason) && (
              <p
                className="text-s fg-secondary"
                role={error ? 'alert' : undefined}
              >
                {error ? (
                  <span className={REPLAY_BLOCK_CLASS}>{error}</span>
                ) : (
                  row.reason
                )}
              </p>
            )}
          </MessageEditCard>
        </Stack>
      ) : (
        <div className="flex justify-end">
          <div className="group relative flex min-w-0 max-w-full flex-col gap-1">
            <MessageEditSurface
              onEdit={
                editable && !busy ? (): Promise<void> => act('edit') : undefined
              }
              data-testid="input-delivery-bubble"
              tone={
                row.watcherFired || steeringRequest?.variant === 'info'
                  ? 'info'
                  : 'default'
              }
            >
              {((row.state === 'pending' && row.canWithdraw) ||
                row.state === 'cancelled') && (
                // On touch each Button's hit area reaches 8px past its 28px
                // disc; `pointer-coarse:gap-4` lets the 44px targets meet
                // without overlapping.
                <div className="absolute -right-2 -top-2 z-10 flex gap-1 transition-colors pointer-coarse:gap-4">
                  {editable && (
                    <MessageEditBadge
                      buttonRef={
                        row.state === 'cancelled' ? editButtonRef : undefined
                      }
                      testId="input-delivery-edit"
                      label={`Edit ${row.state} message`}
                      disabled={busy}
                      onEdit={() => act('edit')}
                    />
                  )}
                  {row.state === 'pending' && (
                    <Button
                      variant="secondary"
                      size="compact"
                      iconOnly
                      data-testid="input-delivery-cancel"
                      aria-label="Cancel pending message"
                      disabled={busy}
                      onClick={() => void act('cancel')}
                    >
                      <TrashIcon size="sm" aria-hidden="true" />
                    </Button>
                  )}
                  {row.state === 'cancelled' && (
                    <Tooltip label="Dismiss message">
                      <Button
                        variant="secondary"
                        size="compact"
                        iconOnly
                        data-testid="input-delivery-dismiss"
                        aria-label="Dismiss message"
                        disabled={busy}
                        onClick={() => void act('dismiss')}
                      >
                        <TrashIcon size="sm" aria-hidden="true" />
                      </Button>
                    </Tooltip>
                  )}
                </div>
              )}
              {row.state === 'uncertain' && (
                <div className="absolute -right-2 -top-2 z-10 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:right-0 pointer-coarse:top-0 pointer-coarse:opacity-100">
                  <Tooltip label="Dismiss message">
                    <Button
                      variant="secondary"
                      size="compact"
                      iconOnly
                      data-testid="input-delivery-dismiss"
                      aria-label="Dismiss message"
                      disabled={busy}
                      onClick={() => void act('dismiss')}
                    >
                      <TrashIcon size="sm" aria-hidden="true" />
                    </Button>
                  </Tooltip>
                </div>
              )}
              <Stack gap="tight">
                <div
                  className="text-3xs fg-secondary"
                  role="status"
                  aria-live="polite"
                >
                  {statusLabel}
                </div>
                {/* The title controls keep their own spacing above the text. */}
                <div>
                  {agentTitle}
                  {row.watcherFired ? (
                    <WatcherFiredTitle watcherFired={row.watcherFired} />
                  ) : (
                    steeringRequest?.title
                  )}
                  <div className="whitespace-pre-wrap break-words">
                    {steeringRequest?.text ?? shownText}
                  </div>
                </div>
                {row.attachmentCount > 0 && (
                  <div className="text-3xs fg-secondary">
                    {row.attachmentCount} retained attachment
                    {row.attachmentCount === 1 ? '' : 's'}
                  </div>
                )}
                {detail && (
                  <p
                    className="text-3xs fg-secondary"
                    role={error ? 'alert' : undefined}
                  >
                    {detail}
                  </p>
                )}
              </Stack>
            </MessageEditSurface>
            {((row.state === 'pending' && row.canWithdraw) ||
              row.state === 'cancelled' ||
              row.state === 'uncertain') && (
              // The resend warning only follows these actions (it needs the
              // uncertain state), so they share one group.
              <Stack gap="inline">
                <div className="flex flex-wrap justify-end gap-2">
                  {(row.state === 'cancelled' || row.state === 'uncertain') && (
                    <Button
                      ref={
                        row.state === 'uncertain' ? resendButtonRef : undefined
                      }
                      variant="secondary"
                      size="compact"
                      data-testid="input-delivery-resend"
                      disabled={busy}
                      onClick={() => {
                        if (row.state === 'uncertain') {
                          setResendWarningOpen(true);
                        } else {
                          void act('resend');
                        }
                      }}
                    >
                      Resend
                    </Button>
                  )}
                  {row.state !== 'uncertain' && (
                    <Button
                      variant="secondary"
                      size="compact"
                      data-testid="input-delivery-queue"
                      disabled={busy}
                      onClick={() => void act('queue')}
                    >
                      Queue
                    </Button>
                  )}
                </div>
                {row.state === 'uncertain' && resendWarningOpen && (
                  <div
                    data-testid="input-delivery-resend-warning"
                    className="flex flex-wrap items-center justify-end gap-2 text-3xs fg-secondary"
                    role="status"
                    aria-live="polite"
                  >
                    <span>Send again? It may arrive twice.</span>
                    <Button
                      variant="secondary"
                      size="compact"
                      data-testid="input-delivery-resend-confirm"
                      disabled={busy}
                      onClick={() => void act('resend')}
                    >
                      Send again
                    </Button>
                    <Button
                      ref={resendKeepButtonRef}
                      variant="secondary"
                      size="compact"
                      data-testid="input-delivery-resend-keep"
                      disabled={busy}
                      onClick={() => {
                        setResendWarningOpen(false);
                        resendButtonRef.current?.focus();
                      }}
                    >
                      Keep
                    </Button>
                  </div>
                )}
              </Stack>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export const InputDeliveryList = memo(function InputDeliveryList({
  rows,
  receivingContext,
  onAction,
  onFocusedRowRemoved,
  onError,
}: InputDeliveryListProps): JSX.Element {
  const focusedRow = useRef<{ id: string; document: Document } | null>(null);
  const [failure, setFailure] = useState<{
    rowId: string;
    message: string;
  } | null>(null);
  const onActionSettled = useCallback(
    (rowId: string, error: string): void => {
      setFailure(error && !onError ? { rowId, message: error } : null);
      onError?.(error);
    },
    [onError],
  );
  const visible = rows.filter(
    (row) => row.state !== 'picked-up' && row.state !== 'queued',
  );
  // A row shows its own error; once the row is gone, the list keeps the
  // explanation so a rejected action never disappears silently.
  const orphanedFailure =
    failure && !visible.some((row) => row.id === failure.rowId)
      ? failure
      : null;
  useLayoutEffect(() => {
    const focused = focusedRow.current;
    if (!focused || visible.some((row) => row.id === focused.id)) return;
    focusedRow.current = null;
    if (focused.document.activeElement === focused.document.body) {
      onFocusedRowRemoved?.();
    }
  }, [visible, onFocusedRowRemoved]);
  const notice = orphanedFailure ? (
    <MessageEditNotice
      message={orphanedFailure.message}
      onDismiss={() => setFailure(null)}
    />
  ) : null;
  if (visible.length === 0) return <>{notice}</>;
  return (
    <Stack
      aria-label="Pending and cancelled messages"
      as="section"
      gap="item"
      onFocusCapture={(event) => {
        const row = event.target.closest<HTMLElement>('[data-input-row-id]');
        if (row?.dataset.inputRowId) {
          focusedRow.current = {
            id: row.dataset.inputRowId,
            document: row.ownerDocument,
          };
        }
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          focusedRow.current = null;
        }
      }}
    >
      {notice}
      {visible.map((row) => (
        <InputDeliveryRow
          key={row.id}
          row={row}
          onAction={onAction}
          onActionSettled={onActionSettled}
          reportErrorInHost={onError !== undefined}
          receivingContext={receivingContext}
        />
      ))}
    </Stack>
  );
});

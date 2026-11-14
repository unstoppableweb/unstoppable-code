// Modal that lists every watcher matching a surface (pipeline card,
// pipeline detail, chat panel, or the Automations Watchers tab) and exposes
// the per-watcher actions the user can take: jump to the subscribing chat
// and delete (with an optional "notify subscribing chat" checkbox).
//
// The modal does not hydrate the watcher store itself — the caller owns
// subscription and passes a fresh snapshot in via `watchers`. When a delete
// succeeds, the App Advisor watcher broadcast removes the row from the next
// snapshot the caller passes in; the modal therefore only needs to maintain
// per-row confirmation state.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  Stack,
  Fact,
  FactList,
  FieldError,
  Surface,
} from '@canopy/ui-shared/components';
import {
  ChoiceField,
  DialogModal,
  ExecutionActionButton,
  FormField,
  OverlayScrollArea,
  ErrorBanner,
  TextArea,
} from '@canopy/ui-shared/components';
import { useShallow } from 'zustand/react/shallow';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  AppAdvisorWatcherDestination,
  AppAdvisorWatcherSummary,
  AppAdvisorWatcherTarget,
  AppAdvisorWatcherTriggerType,
} from '@canopy/desktop-shared/types';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  useAppAdvisorWatchersStore,
  type AppAdvisorWatchersStore,
} from '@/stores/appAdvisorWatchersStore';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import {
  formatGitHubRunSampleLabel,
  githubRunSampleOverflow,
  githubWatcherTargetDisplay,
  liveWatcherDestinationTitle,
  triggerTitle,
  watcherDestinationDisplay,
  watcherOwnerDelegateDisplay,
  watcherStatusLabelWithFailure,
  watcherTargetDisplay,
  localWatcherProgressLabel,
  watcherTitleReplayClass,
} from './watcherDisplay';
import { formatRelativeTime } from '@/lib/format';
import { jumpToWatcherSubscriberChat } from './jumpToWatcherSubscriberChat';
import {
  WatcherRecipientPicker,
  type WatcherRecipientGroup,
} from './WatcherRecipientPicker';

/**
 * Opt-in configuration enabling the modal's "Add a watcher" section. When
 * present the modal renders a recipient picker plus an optional follow-up
 * instruction field that creates a watcher with the supplied trigger/target and
 * the chosen recipient as destination.
 */
export interface WatcherManagementModalAddConfig {
  trigger: AppAdvisorWatcherTriggerType;
  target: AppAdvisorWatcherTarget;
  recipientGroups: WatcherRecipientGroup[];
  /** Heading for the add section. Defaults to "Add a watcher". */
  heading?: string;
  /** Helper text under the heading. */
  description?: string;
}

export interface WatcherManagementModalProps {
  title: string;
  emptyMessage: string;
  watchers: AppAdvisorWatcherSummary[];
  onClose: () => void;
  /**
   * Optional override for the jump-to-chat action. The default behavior is
   * {@link jumpToWatcherSubscriberChat}; the Automations Watchers tab passes
   * its own implementation so it can keep the page open while emitting an
   * inline row-level error.
   */
  onJumpToChat?: (
    watcher: AppAdvisorWatcherSummary,
  ) => { ok: true } | { ok: false; error: string };
  /** When provided, renders the "Add a watcher" section. */
  add?: WatcherManagementModalAddConfig;
  /** When true, each row exposes an inline edit-follow-up affordance. */
  allowEditFollowUp?: boolean;
  /** Document that owns the invoking surface, including auxiliary windows. */
  ownerDocument?: Document;
}

interface RowJumpError {
  watcherId: string;
  message: string;
}

export function WatcherManagementModal({
  title,
  emptyMessage,
  watchers,
  onClose,
  onJumpToChat,
  add,
  allowEditFollowUp = false,
  ownerDocument,
}: WatcherManagementModalProps): JSX.Element {
  const modalDocument = ownerDocument ?? document;
  const deleteErrors = useAppAdvisorWatchersStore((s) => s.deleteErrors);
  const deleteWatcher = useAppAdvisorWatchersStore(
    (s): AppAdvisorWatchersStore['deleteWatcher'] => s.deleteWatcher,
  );
  const createWatcher = useAppAdvisorWatchersStore(
    (s): AppAdvisorWatchersStore['createWatcher'] => s.createWatcher,
  );
  const updateWatcherFollowUp = useAppAdvisorWatchersStore(
    (s): AppAdvisorWatchersStore['updateWatcherFollowUp'] =>
      s.updateWatcherFollowUp,
  );
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const confirmingDeleteRef = useRef(confirmingDeleteId);
  confirmingDeleteRef.current = confirmingDeleteId;
  const [notifySubscriber, setNotifySubscriber] = useState(false);
  const [jumpError, setJumpError] = useState<RowJumpError | null>(null);
  // Row-aligned current titles, so a renamed subscribing chat shows its name.
  const liveDestinationTitles = useChatSidebarStore(
    useShallow((s) =>
      watchers.map((watcher) =>
        liveWatcherDestinationTitle(s.worktrees, watcher.destination),
      ),
    ),
  );

  // Add-section state.
  const [addRecipient, setAddRecipient] =
    useState<AppAdvisorWatcherDestination | null>(null);
  const [addFollowUp, setAddFollowUp] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);

  // Per-row follow-up edit state.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const handleAdd = useCallback(async (): Promise<void> => {
    if (!add) return;
    if (!addRecipient) {
      setAddError('Select a chat to notify.');
      return;
    }
    setAddBusy(true);
    setAddError(null);
    const trimmed = addFollowUp.trim();
    const result = await createWatcher({
      destination: addRecipient,
      watcher: {
        trigger: add.trigger,
        target: add.target,
        followUpInstruction: trimmed.length > 0 ? trimmed : undefined,
      },
    });
    setAddBusy(false);
    if (result.ok) {
      // Reset the picker: the just-added destination is removed from the
      // available recipients, so clear the selection back to the placeholder.
      setAddRecipient(null);
      setAddFollowUp('');
      setAddError(null);
    } else {
      setAddError(result.error);
    }
  }, [add, addRecipient, addFollowUp, createWatcher]);

  const handleStartEdit = useCallback(
    (watcher: AppAdvisorWatcherSummary): void => {
      setEditingId(watcher.id);
      setEditText(watcher.followUpInstruction ?? '');
      setEditError(null);
    },
    [],
  );

  const handleSaveEdit = useCallback(async (): Promise<void> => {
    if (!editingId) return;
    setEditBusy(true);
    setEditError(null);
    const result = await updateWatcherFollowUp(editingId, editText);
    setEditBusy(false);
    if (result.ok) {
      setEditingId(null);
      setEditText('');
    } else {
      setEditError(result.error);
    }
  }, [editingId, editText, updateWatcherFollowUp]);
  const modalChatId = useMemo(() => {
    const chatIds = new Set(
      watchers
        .map((watcher) => watcher.destination.chatId)
        .filter((chatId): chatId is string => typeof chatId === 'string'),
    );
    return chatIds.size === 1 ? Array.from(chatIds)[0] : undefined;
  }, [watchers]);

  useCurrentUiStateReporter('appAdvisor.watchersModal', {
    open: true,
    watcherCount: watchers.length,
    confirmingDelete: confirmingDeleteId !== null,
    ...(modalChatId ? { chatId: modalChatId } : {}),
  });

  // If the row currently in confirmation state disappears (delete broadcast
  // or filter change), reset the local UI state so we never confirm-delete
  // against a stale id.
  useEffect(() => {
    if (
      confirmingDeleteId &&
      !watchers.some((watcher) => watcher.id === confirmingDeleteId)
    ) {
      setConfirmingDeleteId(null);
      setNotifySubscriber(false);
    }
    if (jumpError && !watchers.some((w) => w.id === jumpError.watcherId)) {
      setJumpError(null);
    }
    if (editingId && !watchers.some((w) => w.id === editingId)) {
      setEditingId(null);
      setEditText('');
      setEditError(null);
    }
  }, [watchers, confirmingDeleteId, jumpError, editingId]);

  const handleDeleteClick = useCallback(
    (watcherId: string): void => {
      if (confirmingDeleteId !== watcherId) {
        setConfirmingDeleteId(watcherId);
        setNotifySubscriber(false);
        return;
      }
      // Second click — actually perform the delete with the current notify
      // selection. Success is acknowledged by the next watcher snapshot
      // (which drops the row); failures surface in `deleteErrors`.
      const requestedNotify = notifySubscriber;
      void deleteWatcher(watcherId, {
        notifySubscriber: requestedNotify,
      }).then((result) => {
        // Another row may have been armed while this delete was settling.
        if (result.ok && confirmingDeleteRef.current === watcherId) {
          setConfirmingDeleteId(null);
          setNotifySubscriber(false);
        }
      });
    },
    [confirmingDeleteId, deleteWatcher, notifySubscriber],
  );

  const handleCancelDelete = useCallback((): void => {
    setConfirmingDeleteId(null);
    setNotifySubscriber(false);
  }, []);

  const handleJumpClick = useCallback(
    (watcher: AppAdvisorWatcherSummary): void => {
      const result = onJumpToChat
        ? onJumpToChat(watcher)
        : jumpToWatcherSubscriberChat(watcher);
      if (result.ok) {
        setJumpError(null);
        // For the App Advisor / management button case we close the modal so
        // the user can see the destination chat they just jumped to. The
        // Automations page passes its own onJumpToChat that returns ok and
        // also closes the page-level modal it owns.
        onClose();
      } else {
        setJumpError({ watcherId: watcher.id, message: result.error });
      }
    },
    [onClose, onJumpToChat],
  );

  return (
    <DialogModal
      inset="flush"
      title={title}
      onClose={onClose}
      ownerDocument={modalDocument}
      dataTestId="watcher-management-modal"
      maxWidth="md"
      maxHeight="70vh"
      headerAlignment="center"
      closeButtonAppearance="compact"
      placement="center"
      scrollableBody={false}
      trapFocus
    >
      <OverlayScrollArea
        className="flex-1"
        viewportClassName="overscroll-contain"
      >
        <div className="p-2">
          {add && (
            <div
              className="flex flex-col border-b border-line-tertiary px-3 py-3 gap-2"
              data-testid="watcher-management-add-section"
            >
              <Stack gap="tight">
                <div className="text-xs font-semibold fg-secondary">
                  {add.heading ?? 'Add a watcher'}
                </div>
                {add.description && (
                  <p className="text-2xs fg-secondary">{add.description}</p>
                )}
              </Stack>
              <Stack gap="inline">
                <div className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-2xs fg-secondary">
                    Notify
                  </span>
                  <WatcherRecipientPicker
                    groups={add.recipientGroups}
                    value={addRecipient}
                    onChange={(destination): void => {
                      setAddRecipient(destination);
                      setAddError(null);
                    }}
                    dataTestId="watcher-management-add-recipient"
                  />
                </div>
                <TextArea
                  aria-label="Follow-up instruction (optional)"
                  value={addFollowUp}
                  onChange={(event): void => setAddFollowUp(event.target.value)}
                  placeholder="Optional follow-up instruction for the notified chat…"
                  rows={2}
                  data-testid="watcher-management-add-followup"
                />
                <div className="flex items-center justify-between gap-2">
                  {addError ? (
                    <FieldError
                      id="watcher-management-add-error"
                      announce
                      data-testid="watcher-management-add-error"
                    >
                      {addError}
                    </FieldError>
                  ) : (
                    <span />
                  )}
                  <ExecutionActionButton
                    disabled={addBusy || !addRecipient}
                    onClick={(): void => {
                      void handleAdd();
                    }}
                    dataTestId="watcher-management-add-submit"
                    label={addBusy ? 'Adding…' : 'Add watcher'}
                    ariaLabel="Add watcher"
                    variant="primary"
                    stopKeyDownPropagation={false}
                  />
                </div>
              </Stack>
            </div>
          )}
          <div className="flex min-h-0 flex-col">
            {watchers.length === 0 ? (
              <p
                className="text-s fg-secondary"
                data-testid="watcher-management-empty"
              >
                {emptyMessage}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {watchers.map((watcher, index) => {
                  const target = watcherTargetDisplay(watcher.target);
                  const github = githubWatcherTargetDisplay(watcher.target);
                  const destinationLabel = watcherDestinationDisplay(
                    watcher.destination,
                    liveDestinationTitles[index],
                  );
                  const owner = watcher.ownerDelegate
                    ? watcherOwnerDelegateDisplay(watcher.ownerDelegate)
                    : null;
                  const isConfirming = confirmingDeleteId === watcher.id;
                  const deleteError = deleteErrors[watcher.id];
                  const rowJumpError =
                    jumpError?.watcherId === watcher.id
                      ? jumpError.message
                      : null;
                  return (
                    <Surface
                      key={watcher.id}
                      data-testid={`watcher-management-row-${watcher.id}`}
                      as="li"
                      variant="group"
                      padding="compact"
                    >
                      <Stack gap="item" className="min-w-0">
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                          <Stack gap="tight">
                            <div>
                              <div
                                className={`${watcherTitleReplayClass(watcher.target)} break-words text-s font-normal fg-primary`}
                              >
                                {watcher.label || target.title}
                              </div>
                              <div className="mt-0.5 break-words text-xs fg-tertiary">
                                {triggerTitle(watcher.trigger)}
                              </div>
                            </div>
                            {watcher.localProgress && (
                              <div
                                className="text-xs fg-secondary"
                                data-testid={`local-watcher-progress-${watcher.id}`}
                              >
                                {localWatcherProgressLabel(watcher)}
                              </div>
                            )}
                          </Stack>
                          <FactList
                            labelWidth="6.5rem"
                            columnGap="3"
                            rowGap="1"
                          >
                            <Fact label="Watching">
                              <span className="inline-flex flex-wrap items-baseline gap-1">
                                <span
                                  className={`${watcherTitleReplayClass(watcher.target)} font-medium`}
                                >
                                  {target.title}
                                </span>
                                {target.subtitle && (
                                  <span className="fg-secondary">
                                    · {target.subtitle}
                                  </span>
                                )}
                              </span>
                            </Fact>
                            <Fact
                              label="Subscribed chat"
                              dataTestId={`watcher-management-destination-${watcher.id}`}
                            >
                              {destinationLabel}
                            </Fact>
                            {owner && (
                              <Fact
                                label="Delegate"
                                dataTestId={`watcher-management-owner-${watcher.id}`}
                              >
                                {owner.name}
                                {owner.detail && (
                                  <span className="fg-secondary">
                                    {` · ${owner.detail}`}
                                  </span>
                                )}
                              </Fact>
                            )}
                            <Fact label="Created">
                              {formatRelativeTime(watcher.createdAt)}
                            </Fact>
                            <Fact
                              label="Status"
                              dataTestId={`watcher-management-status-${watcher.id}`}
                            >
                              {watcherStatusLabelWithFailure(
                                watcher.status,
                                watcher.failureKind,
                              )}
                            </Fact>
                            {watcher.status === 'delivery_failed' &&
                              watcher.deliveryError && (
                                <Fact
                                  label="Delivery error"
                                  valueTone="destructive"
                                  dataTestId={`watcher-management-delivery-error-${watcher.id}`}
                                >
                                  {watcher.deliveryError}
                                </Fact>
                              )}
                          </FactList>
                          {github &&
                            (github.filters.length > 0 ||
                              github.sample.length > 0) && (
                              <div
                                className="flex flex-col gap-1"
                                data-testid={`watcher-management-github-${watcher.id}`}
                              >
                                {github.filters.length > 0 && (
                                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs">
                                    {github.filters.map((filter) => (
                                      <span key={filter.label}>
                                        <span className="fg-secondary">
                                          {filter.label}:
                                        </span>{' '}
                                        <span className="fg-primary">
                                          {filter.value}
                                        </span>
                                      </span>
                                    ))}
                                  </div>
                                )}
                                {github.sample.length > 0 && (
                                  <ul className="flex flex-col gap-0.5">
                                    {github.sample.map((run) => (
                                      <li
                                        key={`${run.repository}#${run.runId}`}
                                        className="truncate text-2xs fg-secondary"
                                      >
                                        {formatGitHubRunSampleLabel(run)}
                                      </li>
                                    ))}
                                    {githubRunSampleOverflow(
                                      github,
                                      github.sample.length,
                                    ) > 0 && (
                                      <li className="text-2xs fg-secondary/80">
                                        +
                                        {githubRunSampleOverflow(
                                          github,
                                          github.sample.length,
                                        )}{' '}
                                        more
                                      </li>
                                    )}
                                  </ul>
                                )}
                              </div>
                            )}
                          {(watcher.followUpInstruction ||
                            allowEditFollowUp) && (
                            <div className="text-xs">
                              {editingId === watcher.id ? (
                                <Stack gap="tight">
                                  <FormField label="Follow-up instruction">
                                    {(control) => (
                                      <TextArea
                                        {...control}
                                        value={editText}
                                        onChange={(event): void =>
                                          setEditText(event.target.value)
                                        }
                                        rows={2}
                                        placeholder="Instruction for the notified chat…"
                                        data-testid={`watcher-management-edit-followup-${watcher.id}`}
                                      />
                                    )}
                                  </FormField>
                                  {editError && (
                                    <FieldError
                                      id={`watcher-management-edit-error-${watcher.id}`}
                                      announce
                                      data-testid={`watcher-management-edit-error-${watcher.id}`}
                                    >
                                      {editError}
                                    </FieldError>
                                  )}
                                  <div className="flex items-center gap-2">
                                    <ExecutionActionButton
                                      disabled={editBusy}
                                      onClick={(): void => {
                                        void handleSaveEdit();
                                      }}
                                      dataTestId={`watcher-management-edit-save-${watcher.id}`}
                                      label={editBusy ? 'Saving…' : 'Save'}
                                      ariaLabel="Save"
                                      variant="primary"
                                      stopKeyDownPropagation={false}
                                    />
                                    <ExecutionActionButton
                                      onClick={(): void => {
                                        setEditingId(null);
                                        setEditText('');
                                        setEditError(null);
                                      }}
                                      label="Cancel"
                                      ariaLabel="Cancel"
                                      variant="text"
                                      stopKeyDownPropagation={false}
                                    />
                                  </div>
                                </Stack>
                              ) : (
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <span className="fg-secondary">
                                      Follow-up
                                    </span>{' '}
                                    <span
                                      className={`${POSTHOG_REPLAY_BLOCK_CLASS} break-words fg-primary`}
                                    >
                                      {watcher.followUpInstruction || 'None'}
                                    </span>
                                  </div>
                                  {allowEditFollowUp && (
                                    <ExecutionActionButton
                                      onClick={(): void =>
                                        handleStartEdit(watcher)
                                      }
                                      dataTestId={`watcher-management-edit-followup-button-${watcher.id}`}
                                      label="Edit"
                                      ariaLabel="Edit"
                                      variant="text"
                                      stopKeyDownPropagation={false}
                                    />
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex min-w-0 flex-col items-end gap-1">
                          <div className="-mr-2.5 flex flex-wrap items-center gap-0">
                            <ExecutionActionButton
                              onClick={(): void => handleJumpClick(watcher)}
                              dataTestId={`watcher-management-jump-${watcher.id}`}
                              label="Jump to chat"
                              ariaLabel="Jump to chat"
                              variant="text"
                              stopKeyDownPropagation={false}
                            />
                            {isConfirming ? (
                              <ExecutionActionButton
                                onClick={(): void =>
                                  handleDeleteClick(watcher.id)
                                }
                                dataTestId={`watcher-management-confirm-delete-${watcher.id}`}
                                label="Confirm delete"
                                ariaLabel="Confirm delete"
                                variant="destructive"
                                stopKeyDownPropagation={false}
                              />
                            ) : (
                              <ExecutionActionButton
                                onClick={(): void =>
                                  handleDeleteClick(watcher.id)
                                }
                                dataTestId={`watcher-management-delete-${watcher.id}`}
                                label="Delete"
                                ariaLabel="Delete"
                                variant="text"
                                stopKeyDownPropagation={false}
                              />
                            )}
                          </div>
                          {isConfirming && (
                            <div className="flex flex-col items-end gap-0.5">
                              <ChoiceField
                                label="Notify subscribing chat"
                                checked={notifySubscriber}
                                data-testid={`watcher-management-notify-${watcher.id}`}
                                onChange={(event): void =>
                                  setNotifySubscriber(event.target.checked)
                                }
                              />
                              <span className="max-w-64 text-right text-3xs fg-secondary">
                                Sends a final watcher-deleted message to the
                                chat that subscribed to this watcher.
                              </span>
                              <ExecutionActionButton
                                onClick={handleCancelDelete}
                                label="Cancel"
                                ariaLabel="Cancel"
                                variant="text"
                                stopKeyDownPropagation={false}
                              />
                            </div>
                          )}
                          {deleteError && (
                            <ErrorBanner
                              errorSource="watcher-management-modal"
                              className=""
                              testId={`watcher-management-delete-error-${watcher.id}`}
                              error="Could not delete watcher."
                            />
                          )}
                          {rowJumpError && (
                            <ErrorBanner
                              errorSource="watcher-management-modal-row-jump"
                              className=""
                              testId={`watcher-management-jump-error-${watcher.id}`}
                              error={rowJumpError}
                            />
                          )}
                        </div>
                      </Stack>
                    </Surface>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </OverlayScrollArea>
    </DialogModal>
  );
}

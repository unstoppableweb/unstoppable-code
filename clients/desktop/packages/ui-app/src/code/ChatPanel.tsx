'use client';

import { isPlanModeReadOnly } from '@canopy/ui-shared/lib/plan-mode-suggestion';
import { usePlanModeHintStore } from './composer/PlanModeHintContext';

import type { ChatPlanReviewApproval } from '@canopy/protocol/portal';

import {
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  useCanopyClient,
  useChatStore,
  useRetainChatThread,
} from '@canopy/app-state';
import { portalChatMessageAttachmentsFromRefs } from '@canopy/protocol/portal';
import type {
  PortalChatCloudAttachmentRef,
  PortalChatFileReference,
  PortalChatMessage,
  PortalChatThinkingLevel,
  PortalQueuedMessage,
} from '@canopy/protocol/portal';
import type { ModelCatalogThinkingLevel } from '@canopy/protocol/models';
import {
  MESSAGE_NO_LONGER_EDITABLE_NOTICE,
  MessageEditNotice,
  QueuedMessageBubble,
  queuedMessageForceKind,
  splitSubagentReference,
  SubagentReferenceChip,
} from '@canopy/ui-shared';
import { InputDeliveryList } from '@canopy/ui-shared';
import {
  ComposerTray,
  ComposerTrayProvider,
  MessageEditSurface,
  QueuedMessageRow,
  Notice,
  QueuedMessageReason,
  UnsavedMessageEdits,
  useCompactQueue,
  type UnsavedMessageEdit,
} from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  AgentSentTitle,
  AgentSentReceivingContextProvider,
  type AgentSentReceivingContext,
} from '@canopy/ui-shared';
import { ChatComposer } from './ChatComposer';
import { QueuedEditComposerSlot } from './composer/QueuedEditComposerSlot';
import {
  QueuedMessageComposer,
  type QueuedMessageEditControls,
} from './composer/QueuedMessageComposer';
import type { ChatTranscriptProps } from './ChatTranscript';
import { ChatWaitingDelegationsContext } from './ChatPartView';
import { QueuedMessageStack } from './QueuedMessageStack';
import { useChatTranscriptFind } from '../find/useChatTranscriptFind';
import { isPersonPromptText } from './sent-prompt-summary';

const EMPTY_QUEUED_MESSAGES: readonly PortalQueuedMessage[] = [];

const LazyChatTranscript = lazy(async () => {
  const module = await import('./ChatTranscript');
  return { default: module.ChatTranscript };
});

function ChatTranscriptPlaceholder({
  emptyState,
}: Pick<ChatTranscriptProps, 'emptyState'>): JSX.Element {
  return (
    <div
      className="flex h-full items-center justify-center p-6 text-center text-s fg-secondary"
      data-testid="chat-transcript-empty"
    >
      {emptyState ?? <span>Send a message to start working</span>}
    </div>
  );
}

/**
 * Per-send context the panel hands to {@link ChatPanelProps.onSend}. It carries
 * the optimistic identity the panel minted for this send so a host can later ask
 * the shared chat store to roll that exact send back on a pre-host rejection
 * (see `ChatStoreState.rollbackOptimisticSend` in `@canopy/app-state`).
 *
 * Contract (binding on both the panel and its hosts):
 * - `optimisticLocalId` is present ONLY for an idle-path send that inserted an
 *   optimistic transcript message.
 * - Queue-path sends (mid-turn or behind a pending row) pass
 *   `optimisticLocalId: undefined`.
 */
export interface ChatPanelSendContext {
  /** The host reports the existing dispatch identity before sending. */
  readonly onSubmissionIdentity?: (userMessageId: string) => void;
  readonly planReviewApproval?: ChatPlanReviewApproval;
  /** localId of the optimistic transcript row this send inserted, if any. */
  readonly optimisticLocalId?: string;
  /**
   * `@`-mention file references serialized alongside the drafted text by a
   * host composer (see {@link ChatComposerSendOptions}). Present only when the
   * draft carried at least one pill; hosts that ignore them are unaffected.
   */
  readonly fileReferences?: readonly PortalChatFileReference[];
  /** Ready cloud attachment references serialized by the host composer. */
  readonly cloudAttachments?: readonly PortalChatCloudAttachmentRef[];
}

/**
 * Optional per-send data a host composer passes through
 * {@link ChatComposerHostControls.onSend}. The panel forwards it verbatim on
 * the {@link ChatPanelSendContext} after minting the optimistic identity.
 */
export interface ChatComposerSendOptions {
  readonly onSubmissionIdentity?: (userMessageId: string) => void;
  readonly planReviewApproval?: ChatPlanReviewApproval;
  readonly fileReferences?: readonly PortalChatFileReference[];
  readonly cloudAttachments?: readonly PortalChatCloudAttachmentRef[];
}

/**
 * The write-once Code-tab chat panel: reads the neutral thread from the shared
 * {@link useChatStore} and composes the presentational {@link ChatTranscript}
 * with the {@link ChatComposer}. Rendered by both the desktop renderer and the
 * web portal (each injects its own {@link import('@canopy/app-core').CanopyClient}
 * via `CanopyClientProvider`, plus its send/stop transport as props).
 *
 * Send/stop are injected callbacks because a shared `chat.send`/`chat.stop`
 * command is not in the client contract yet; the adopt tickets (CAN-741 desktop,
 * CAN-742 web) pass the host transport here, and migrate to a store command when
 * one lands.
 */
export interface ChatPanelProps {
  /** Lets the host place the shared compact queue in its grouped drawer. */
  readonly composerWorkDrawer?: boolean;
  readonly receivingContext?: AgentSentReceivingContext;
  readonly chatId: string;
  readonly transcriptInitialized?: boolean;
  /**
   * Host transport for sending a drafted message; omit for a read-only host.
   * Receives the drafted `text` plus a {@link ChatPanelSendContext} carrying the
   * per-send optimistic identity. Hosts that do not need the context (desktop,
   * `CodeShell`) may keep a plain `(text) => void` surface and discard it —
   * widening this callback must not become an accidental API change for them.
   */
  readonly onSend?: (
    text: string,
    context: ChatPanelSendContext,
  ) => void | Promise<void>;
  /** Host transport for stopping the in-flight turn. */
  readonly onStop?: () => void;
  /**
   * Optional host handler for queued entries that are not addressable through
   * the canonical queue route yet. Return true when the host removed the entry;
   * false lets the panel fall back to the ordinary `chat.queue.cancel` command.
   */
  readonly onCancelQueuedMessage?: (messageId: string) => boolean;
  /** Whether queue mutation controls are available for this viewer. */
  readonly queueActionsEnabled?: boolean;
  /**
   * True when the host queues a send whenever an earlier queue row is pending,
   * even if no turn is currently active. Such sends must not create an
   * optimistic transcript row before the host accepts the queued entry.
   */
  readonly queuesSendsBehindPendingMessages?: boolean;
  /** Provider hint for the thinking-level cycle (`'codex'` drops `max`). */
  readonly providerType?: string;
  /** Optional branded app icon threaded to tool/agent parts. */
  readonly appIcon?: ReactNode;
  /** Overrides the transcript's empty-state placeholder. */
  readonly emptyState?: ReactNode;
  /**
   * Host status rendered under the queue tail inside the transcript column.
   * Supplying it keeps the transcript mounted on a chat with no messages.
   */
  readonly footerStatus?: ReactNode;
  readonly firstSendStartingEnabled?: boolean;
  /** The chat's worktree setup, for the first turn's starting status. */
  readonly worktreeSetup?: ChatTranscriptProps['worktreeSetup'];
  /** Host-owned action rendered beside the latest transcript turn. */
  readonly renderLatestTurnAction?: ChatTranscriptProps['renderLatestTurnAction'];
  /**
   * Optional host transcript renderer. Desktop uses this parity bridge while
   * its interactive workflow/ask-user/queued-message blocks are still richer
   * than the neutral transcript. The shared panel remains the store-backed
   * shell and hands the canonical state to the host renderer.
   */
  readonly onLoadOlder?: () => Promise<void>;
  /**
   * Dedupe keys of the live runs the host lists in its background drawer;
   * the built-in transcript's turns leave them out until they finish.
   */
  readonly liveRunKeys?: ReadonlySet<string>;
  readonly renderTranscript?: (
    controls: ChatTranscriptHostControls,
  ) => ReactNode;
  /**
   * Registers this panel's transcript with the shared find bar (CAN-3048) as
   * the chat scope `chatId`, titled for the bar's scope menu. The search runs
   * over the `ChatTranscript` rendered inside the panel, built-in or supplied
   * through `renderTranscript`. Desktop omits it: its transcript renderer
   * registers its own canonical search.
   */
  readonly findScope?: { readonly title: string };
  /**
   * Optional host-supplied composer. When provided, the panel renders this in
   * place of the built-in {@link ChatComposer}, handing back the store-backed
   * send/stop/plan/thinking controls so a host can substitute a bespoke
   * composer while keeping the shared transcript + optimistic-echo wiring. Omit
   * to render the built-in composer (the desktop and default web paths).
   */
  readonly renderComposer?: (controls: ChatComposerHostControls) => ReactNode;
  /** The host composer already owns the queued-credit recovery notice. */
  readonly queuedCreditNoticeHandled?: boolean;
  /**
   * Editing a queued message happens in the composer's place (CAN-3607): the
   * panel's own queue opens a {@link QueuedMessageComposer} there. A host that
   * renders its own queue through `renderTranscript` (desktop) passes its
   * editor here instead, null when nothing is being edited. Either way the
   * composer stays mounted, hidden, so its draft survives the edit.
   */
  readonly hostQueuedMessageEditor?: ReactElement | null;
}

/**
 * The store-backed composer controls the panel hands to {@link ChatPanelProps.renderComposer}.
 * A host composer wires these to its own send button and plan/thinking chips so
 * the shared store stays the single source of truth for thread state.
 */
export interface ChatComposerHostControls {
  readonly queuedPanel?: ReactNode;
  readonly queuedCount?: number;
  /**
   * Optimistic-echo-wrapped send transport; absent for a read-only host.
   * `options` carries per-send extras (e.g. serialized `@`-mention file
   * references) the panel forwards to the host on the send context.
   */
  readonly onSend?: (
    text: string,
    options?: ChatComposerSendOptions,
  ) => void | Promise<void>;
  /** Stop the in-flight turn. */
  readonly onStop?: () => void;
  /** True while the thread is streaming. */
  readonly isStreaming: boolean;
  /** Current plan-mode from the shared store. */
  readonly planMode: boolean;
  /** Toggle plan-mode in the shared store. */
  readonly onTogglePlanMode: () => void;
  /** Current thinking level from the shared store (undefined when unset). */
  readonly thinkingLevel?: PortalChatThinkingLevel;
  /**
   * Advance the thinking level in the shared store.
   *
   * `supportedLevels` are the efforts the connected desktop projected for the
   * active model (CAN-2441). Passing them makes the cycle that model's own set
   * so `max` / `ultra` are reachable; omitting them keeps the provider cycle.
   */
  readonly onCycleThinking: (
    supportedLevels?: readonly ModelCatalogThinkingLevel[],
  ) => void;
}

export interface ChatTranscriptHostControls {
  readonly messages: ChatTranscriptProps['messages'];
  readonly turnGroups: ChatTranscriptProps['turnGroups'];
  readonly status: ChatTranscriptProps['status'];
  readonly error: ChatTranscriptProps['error'];
  readonly renderLatestTurnAction: ChatTranscriptProps['renderLatestTurnAction'];
  readonly footerStatus: ChatTranscriptProps['footerStatus'];
  readonly firstSendStartingEnabled?: boolean;
  readonly worktreeSetup: ChatTranscriptProps['worktreeSetup'];
  readonly chatId: ChatTranscriptProps['chatId'];
  /** Person-authored prompts in the queue the panel renders beside it. */
  readonly queuedPromptCount: ChatTranscriptProps['queuedPromptCount'];
  readonly queuedPromptIds: ChatTranscriptProps['queuedPromptIds'];
  readonly queuedPromptMessageIds: ChatTranscriptProps['queuedPromptMessageIds'];
  readonly initialized: ChatTranscriptProps['initialized'];
  /** Queue rows the host marked `delivering`, which the transcript renders. */
  readonly deliveringMessages: ChatTranscriptProps['deliveringMessages'];
}

export function ChatPanel({
  chatId,
  receivingContext: explicitContext,
  transcriptInitialized,
  onSend,
  onStop,
  onCancelQueuedMessage,
  queueActionsEnabled = true,
  queuesSendsBehindPendingMessages = false,
  providerType,
  appIcon,
  emptyState,
  footerStatus,
  firstSendStartingEnabled = true,
  worktreeSetup,
  renderLatestTurnAction,
  liveRunKeys,
  renderTranscript,
  renderComposer,
  queuedCreditNoticeHandled = false,
  composerWorkDrawer = false,
  hostQueuedMessageEditor = null,
  onLoadOlder,
  findScope,
}: ChatPanelProps): JSX.Element {
  useRetainChatThread(chatId);
  const composerContainer = useRef<HTMLDivElement>(null);
  const panelRoot = useRef<HTMLDivElement>(null);
  const find = useChatTranscriptFind({
    enabled: findScope !== undefined,
    scopeKey: chatId,
    title: findScope?.title ?? '',
    rootRef: panelRoot,
  });
  const thread = useChatStore((state) => state.threads[chatId]);
  const waitingDelegationIds = useChatStore(
    (state) => state.threads[chatId]?.waitingDelegationIds,
  );
  const waitingDelegations = useMemo(
    () => new Set(waitingDelegationIds ?? []),
    [waitingDelegationIds],
  );
  const client = useCanopyClient();
  /* eslint-disable @typescript-eslint/unbound-method --
     Zustand store actions are closure-based (they capture `set`/`get`, never
     use `this`), so selecting them by reference — the idiomatic zustand
     pattern — is safe to call detached. */
  const setPlanMode = useChatStore((state) => state.setPlanMode);
  const cycleThinkingLevel = useChatStore((state) => state.cycleThinkingLevel);
  const addOptimisticUserMessage = useChatStore(
    (state) => state.addOptimisticUserMessage,
  );
  /* eslint-enable @typescript-eslint/unbound-method */

  const messages = thread?.messages ?? [];
  const turnGroups = thread?.turnGroups ?? [];
  const status = thread?.status ?? 'idle';
  const error = thread?.error ?? null;
  const hintStore = usePlanModeHintStore();
  const planMode = thread?.planMode ?? false;
  const thinkingLevel = thread?.thinkingLevel;
  const queuedMessages = thread?.queuedMessages ?? EMPTY_QUEUED_MESSAGES;
  const compactQueuePreference = useCompactQueue();
  const compactQueue = composerWorkDrawer || compactQueuePreference;
  // A row the host is delivering to an idle agent reads as sent, in the
  // transcript; only rows waiting behind other work keep the queued look.
  const waitingQueuedMessages = useMemo(
    () => queuedMessages.filter((message) => message.delivering !== true),
    [queuedMessages],
  );
  const deliveringMessages = useMemo(
    () =>
      queuedMessages
        .filter((message) => message.delivering === true)
        .map(
          (message): PortalChatMessage => ({
            messageId: message.id,
            chatId,
            role: 'user',
            status: 'complete',
            text: message.text,
            createdAtMs: message.enqueuedAtMs,
            promptSource: message.promptSource ?? 'human',
            ...(message.agentSent ? { agentSent: message.agentSent } : {}),
          }),
        ),
    [chatId, queuedMessages],
  );
  const route = thread?.route;
  const targetCapabilities =
    route?.workspaceLocalId === undefined
      ? client.capabilities
      : (client.capabilitiesFor?.(route.workspaceLocalId) ??
        client.capabilities);
  const genuinePlanAvailable =
    (targetCapabilities.workspaceCreation === 'full' ||
      targetCapabilities.workspaceCreation === 'remote-clone') &&
    !isPlanModeReadOnly(providerType);
  const receivingContext = useMemo<AgentSentReceivingContext | undefined>(
    () =>
      explicitContext ??
      (route?.scope === 'app_advisor'
        ? { kind: 'bot', botId: 'app_advisor' }
        : route?.workspaceLocalId
          ? { kind: 'project', projectId: route.workspaceLocalId }
          : undefined),
    [explicitContext, route],
  );
  const threadQueuedMessages = thread?.queuedMessages;
  const queuedPromptIds = useMemo(
    () =>
      (threadQueuedMessages ?? [])
        .filter(
          (message) =>
            message.promptSource === 'human' &&
            isPersonPromptText(message.text),
        )
        .map((message) => message.id),
    [threadQueuedMessages],
  );
  const queuedPromptCount = queuedPromptIds.length;
  const queuedPromptMessageIds = useMemo(
    () =>
      (threadQueuedMessages ?? [])
        .filter((message) => message.promptSource === 'human')
        .flatMap((message) =>
          message.supersedesUserMessageId
            ? [message.supersedesUserMessageId]
            : [],
        ),
    [threadQueuedMessages],
  );
  const initialized = transcriptInitialized ?? thread !== undefined;

  const queueTarget = useMemo(
    () =>
      route?.scope === 'worktree' &&
      route.workspaceLocalId !== undefined &&
      route.worktreeLocalId !== undefined
        ? {
            projectId: route.workspaceLocalId,
            worktreeId: route.worktreeLocalId,
            chatId,
          }
        : undefined,
    [chatId, route],
  );
  const [editingQueueEntry, setEditingQueueEntry] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const editingQueueEntryRef = useRef<{
    entry: { id: string; text: string };
    target: NonNullable<typeof queueTarget>;
  } | null>(null);
  const pendingQueueEdit = useRef<{
    entry: { id: string; text: string };
    target: NonNullable<typeof queueTarget>;
    focusMoved: boolean;
  } | null>(null);
  const [queueEditPending, setQueueEditPending] = useState(false);
  // The editor closes before the host confirms a save; entry stays hidden
  // until then, since a new edit cannot begin while the save holds the row.
  const [queueEditSaving, setQueueEditSaving] = useState(false);
  const currentQueue = useRef({
    queuedMessages,
    queueTarget,
    queueActionsEnabled,
  });
  useLayoutEffect(() => {
    currentQueue.current = { queuedMessages, queueTarget, queueActionsEnabled };
  }, [queuedMessages, queueTarget, queueActionsEnabled]);
  const [queueEditNotice, setQueueEditNotice] = useState('');
  // Unsaved text from editors whose rows left the queue while open, by entry.
  const [unsavedQueueEdits, setUnsavedQueueEdits] = useState<
    readonly UnsavedMessageEdit[]
  >([]);
  // The editor focuses itself once when it opens, unless focus moved
  // elsewhere while the edit lock was being acquired.
  const [queueEditAutoFocus, setQueueEditAutoFocus] = useState(true);

  // The {entry, target} pair is captured ONLY when an editor opens and
  // cleared on save/cancel — never re-synced on prop changes, which would
  // mispair an old entry with a new chat's target (review a2 #2). A chat or
  // worktree switch remounts this panel (composite key at the call sites),
  // so the unmount cleanup below releases the lock with the captured pair.

  useEffect(
    () => (): void => {
      pendingQueueEdit.current = null;
      const editing = editingQueueEntryRef.current;
      editingQueueEntryRef.current = null;
      if (!editing) return;
      void client.command('chat.queue.set_edit_lock', {
        ...editing.target,
        entryId: editing.entry.id,
        locked: false,
      });
    },
    [client, chatId, queueTarget?.projectId, queueTarget?.worktreeId],
  );

  // A row can leave the queue while its editor is open (it ran, or another
  // client cancelled it). Release the edit so other rows stay editable, and
  // keep any changed text visible so the user can copy it.
  useEffect(() => {
    const editing = editingQueueEntryRef.current;
    if (
      !editingQueueEntry ||
      !editing ||
      queuedMessages.some((row) => row.id === editingQueueEntry.id)
    )
      return;
    editingQueueEntryRef.current = null;
    setEditingQueueEntry(null);
    setQueueEditNotice(MESSAGE_NO_LONGER_EDITABLE_NOTICE);
    if (editingQueueEntry.text !== editing.entry.text) {
      const recovered = { id: editing.entry.id, text: editingQueueEntry.text };
      setUnsavedQueueEdits((drafts) => [
        ...drafts.filter((draft) => draft.id !== recovered.id),
        recovered,
      ]);
    }
    client
      .command('chat.queue.set_edit_lock', {
        ...editing.target,
        entryId: editing.entry.id,
        locked: false,
      })
      .catch(() => undefined);
  }, [client, editingQueueEntry, queuedMessages]);

  const beginQueueEdit = async (id: string): Promise<void> => {
    if (pendingQueueEdit.current || editingQueueEntryRef.current) return;
    const current = currentQueue.current;
    const message = current.queuedMessages.find((row) => row.id === id);
    if (
      !current.queueTarget ||
      !current.queueActionsEnabled ||
      !message ||
      message.editLocked ||
      (message.hasAttachments && !message.attachmentEditsPreservePayload)
    ) {
      setQueueEditNotice(MESSAGE_NO_LONGER_EDITABLE_NOTICE);
      return;
    }
    const attempt = {
      entry: { id, text: message.text },
      target: current.queueTarget,
      focusMoved: false,
    };
    pendingQueueEdit.current = attempt;
    setQueueEditPending(true);
    const document =
      composerContainer.current?.ownerDocument ?? globalThis.document;
    const recordFocusMove = (): void => {
      attempt.focusMoved = true;
    };
    document.addEventListener('focusin', recordFocusMove);
    const release = (): Promise<void> =>
      client.command('chat.queue.set_edit_lock', {
        ...attempt.target,
        entryId: id,
        locked: false,
      });
    try {
      await client.command('chat.queue.set_edit_lock', {
        ...attempt.target,
        entryId: id,
        locked: true,
      });
      if (pendingQueueEdit.current !== attempt) {
        await release();
        return;
      }
      const latest = currentQueue.current;
      const row = latest.queuedMessages.find(
        (candidate) => candidate.id === id,
      );
      if (
        !row ||
        !latest.queueActionsEnabled ||
        latest.queueTarget?.chatId !== attempt.target.chatId ||
        latest.queueTarget?.projectId !== attempt.target.projectId ||
        latest.queueTarget?.worktreeId !== attempt.target.worktreeId ||
        (row.hasAttachments && !row.attachmentEditsPreservePayload)
      ) {
        await release();
        setQueueEditNotice(MESSAGE_NO_LONGER_EDITABLE_NOTICE);
        return;
      }
      editingQueueEntryRef.current = attempt;
      setQueueEditAutoFocus(!attempt.focusMoved);
      setQueueEditNotice('');
      setEditingQueueEntry({ id, text: row.text });
    } catch (error) {
      if (pendingQueueEdit.current === attempt) {
        setQueueEditNotice(
          error instanceof Error
            ? error.message
            : MESSAGE_NO_LONGER_EDITABLE_NOTICE,
        );
      }
    } finally {
      document.removeEventListener('focusin', recordFocusMove);
      if (pendingQueueEdit.current === attempt) {
        pendingQueueEdit.current = null;
        setQueueEditPending(false);
      }
    }
  };

  const saveEditingQueueEntry = (text: string): void => {
    const editing = editingQueueEntryRef.current;
    if (!editing || editingQueueEntry?.id !== editing.entry.id) return;

    const { entry, target } = editing;
    const clearCapturedEdit = (): void => {
      if (editingQueueEntryRef.current === editing) {
        editingQueueEntryRef.current = null;
        setQueueEditSaving(false);
      }
    };
    const releaseEditLock = (error?: unknown): void => {
      setQueueEditNotice(
        error instanceof Error
          ? error.message
          : MESSAGE_NO_LONGER_EDITABLE_NOTICE,
      );
      // The editor already closed; keep changed text the host refused.
      if (text !== entry.text) {
        setUnsavedQueueEdits((drafts) => [
          ...drafts.filter((draft) => draft.id !== entry.id),
          { id: entry.id, text },
        ]);
      }
      clearCapturedEdit();
      void client.command('chat.queue.set_edit_lock', {
        ...target,
        entryId: entry.id,
        locked: false,
      });
    };

    // Close the editor before dispatching so a synchronous host failure cannot
    // leave the submitted draft visibly wedged in edit mode.
    setEditingQueueEntry(null);
    setQueueEditSaving(true);
    try {
      void client
        .command('chat.queue.edit', {
          ...target,
          entryId: entry.id,
          text,
        })
        .then(clearCapturedEdit)
        .catch(releaseEditLock);
    } catch {
      releaseEditLock();
    }
  };

  const cancelEditingQueueEntry = (): void => {
    const editing = editingQueueEntryRef.current;
    editingQueueEntryRef.current = null;
    setEditingQueueEntry(null);
    if (!editing) return;
    void client.command('chat.queue.set_edit_lock', {
      ...editing.target,
      entryId: editing.entry.id,
      locked: false,
    });
  };

  const editingQueuedMessage =
    editingQueueEntry === null
      ? undefined
      : queuedMessages.find((message) => message.id === editingQueueEntry.id);

  const sendSeq = useRef(0);
  const handleSend =
    onSend === undefined
      ? undefined
      : (
          text: string,
          options?: ChatComposerSendOptions,
        ): void | Promise<void> => {
          // A send behind an active turn or pending queue is queued by the host
          // (it surfaces via the queuedMessages mirror), so it must NOT also
          // push an optimistic transcript row: that double-renders the same
          // text, and if the queued row is cancelled no host frame ever
          // reconciles the echo, orphaning a "sent" message that was actually
          // cancelled. Only echo when this send starts a fresh turn.
          const isQueuedFollowUp =
            thread?.turnActive === true ||
            status === 'streaming' ||
            (queuesSendsBehindPendingMessages && queuedMessages.length > 0);
          // The per-send optimistic identity handed to the host via
          // `ChatPanelSendContext`. Present ONLY for an idle-path send that
          // seeded an optimistic transcript row; a queue-path send leaves it
          // `undefined` (nothing to roll back). The portal host uses it to ask
          // the store to roll THIS exact send back on a pre-host rejection
          // (CAN-1429), while stale/authoritative rollbacks are store no-ops.
          const cloudAttachments = options?.cloudAttachments;
          let optimisticLocalId: string | undefined;
          if (!isQueuedFollowUp) {
            // Optimistic echo appears immediately; the authoritative frame from
            // the host transport reconciles it on ingest. A per-send counter in
            // the localId avoids two same-millisecond sends colliding on one id.
            const now = Date.now();
            sendSeq.current += 1;
            optimisticLocalId = `optimistic-${now}-${sendSeq.current}`;
            addOptimisticUserMessage(chatId, {
              text,
              createdAtMs: now,
              localId: optimisticLocalId,
              ...(cloudAttachments && cloudAttachments.length > 0
                ? {
                    attachments:
                      portalChatMessageAttachmentsFromRefs(cloudAttachments),
                  }
                : {}),
            });
          }
          // Queue-path sends still call the host (they surface as queued
          // follow-ups) but pass `optimisticLocalId: undefined` so a later
          // rejection cannot lower the active host turn.
          const fileReferences = options?.fileReferences;
          const sent = onSend(text, {
            optimisticLocalId,
            ...(options?.onSubmissionIdentity
              ? { onSubmissionIdentity: options.onSubmissionIdentity }
              : {}),
            ...(options?.planReviewApproval
              ? { planReviewApproval: options.planReviewApproval }
              : {}),
            ...(fileReferences && fileReferences.length > 0
              ? { fileReferences }
              : {}),
            ...(cloudAttachments && cloudAttachments.length > 0
              ? { cloudAttachments }
              : {}),
          });
          // The acknowledgement, including queued admission, defines successful
          // plan use. Failure never retires; later execution failure cannot undo it.
          if (
            renderComposer === undefined &&
            planMode &&
            genuinePlanAvailable
          ) {
            if (sent === undefined) void hintStore?.getState().markTried();
            else
              return sent.then(() => {
                void hintStore?.getState().markTried();
              });
          }
          return sent;
        };

  // Queued messages are the tail of the conversation, so they render INSIDE
  // the transcript scroll container (see `footerSlot`) exactly as the desktop
  // transcript renders them inside its own scroll area. Hosts that supply
  // their own transcript keep rendering it as a sibling below.
  // Input-delivery rows render only with a queue target and enabled actions;
  // otherwise they would leave an empty container that reads as a queue tail.
  // Queued and delivering messages are user prompts: session replay keeps a
  // placeholder for the whole list.
  /**
   * One queued row's actions, shared by the transcript bubble and the compact
   * list's row, so both offer the same actions with the same eligibility.
   */
  const queuedEntryActions = (
    message: PortalQueuedMessage,
  ): {
    onSteer?: () => void;
    onCancel?: () => void;
    onEdit?: () => Promise<void>;
    onForce?: () => void;
    onRetry?: () => void;
    onRunNow?: () => void;
  } => {
    const forceKind = queuedMessageForceKind(message);
    // A force-locked row (a rebound delivery the host may already have sent)
    // must not offer to send it again; hosts without the lock use the edit lock.
    // A held row gets no send callback: its Retry renders disabled until the
    // host lifts the hold and republishes the row.
    const forceQueuedMessage =
      queueActionsEnabled &&
      queueTarget &&
      message.retryBlockedReason === undefined &&
      !(message.forceLocked ?? message.editLocked)
        ? (): void => {
            void client.command('chat.queue.force', {
              ...queueTarget,
              entryId: message.id,
            });
          }
        : undefined;
    return {
      onSteer:
        queueActionsEnabled &&
        queueTarget &&
        thread?.steeringCapabilities?.steer &&
        message.canSteer === true &&
        message.retryBlockedReason === undefined &&
        !message.editLocked
          ? (): void => {
              void client.command('chat.queue.steer', {
                ...queueTarget,
                entryId: message.id,
              });
            }
          : undefined,
      onCancel: queueActionsEnabled
        ? (): void => {
            if (onCancelQueuedMessage?.(message.id)) return;
            if (!queueTarget) return;
            void client.command('chat.queue.cancel', {
              ...queueTarget,
              entryId: message.id,
            });
          }
        : undefined,
      onEdit:
        queueActionsEnabled &&
        queueTarget &&
        !queueEditPending &&
        !queueEditSaving &&
        !editingQueueEntry &&
        !message.editLocked &&
        (!message.hasAttachments ||
          message.attachmentEditsPreservePayload === true)
          ? (): Promise<void> => beginQueueEdit(message.id)
          : undefined,
      // Retryable or idle/background rows retry, and rows held for background
      // work run now. Other rows interrupt the running turn, which the strip
      // offers only in the foreground phase.
      onForce: forceKind === 'interrupt' ? forceQueuedMessage : undefined,
      onRetry: forceKind === 'retry' ? forceQueuedMessage : undefined,
      onRunNow: forceKind === 'run-now' ? forceQueuedMessage : undefined,
    };
  };

  const renderQueuedEntry = (
    message: PortalQueuedMessage,
  ): JSX.Element | null => {
    // The entry being edited steps out of the queue: its editor sits in the
    // composer's place (CAN-3607).
    if (queueActionsEnabled && editingQueueEntry?.id === message.id) {
      return null;
    }
    const actions = queuedEntryActions(message);
    const subagentReference = splitSubagentReference(message.text);
    const displayMessage = subagentReference.reference
      ? { ...message, text: subagentReference.body }
      : message;
    const attachment = subagentReference.reference ? (
      <SubagentReferenceChip title={subagentReference.reference.title} />
    ) : undefined;
    return (
      <QueuedMessageBubble
        key={message.id}
        message={displayMessage}
        attachment={attachment}
        steeringSupported={thread?.steeringCapabilities?.steer === true}
        onSteer={actions.onSteer}
        onCancel={actions.onCancel}
        onEdit={actions.onEdit}
        onForce={actions.onForce}
        onRetry={actions.onRetry}
        onRunNow={actions.onRunNow}
        turnPhase={message.turnPhase}
      />
    );
  };

  // Compact queue (Labs): the queued rows leave the transcript tail for the
  // one-line list above the composer. The row being edited leaves the list;
  // its editor sits in the composer's place, as in the transcript queue.
  const compactRows = compactQueue
    ? waitingQueuedMessages.filter(
        (message) => editingQueueEntry?.id !== message.id,
      )
    : [];
  const compactQueueList =
    compactRows.length > 0 ? (
      <div
        // The card lands on the host composer's box, under every notice the
        // host stacks above it, and tucks under the box's top edge; the box
        // paints over it as its later sibling. The built-in composer has no
        // such box, so there the card sits flush on the composer instead.
        className={
          renderComposer
            ? REPLAY_BLOCK_CLASS
            : `${REPLAY_BLOCK_CLASS} relative z-30 mx-auto -mb-3 w-full max-w-[var(--chat-reading-width)] chat-width-transition px-4 pt-2`
        }
      >
        <QueuedMessageStack
          surface={composerWorkDrawer ? 'drawer' : 'tray'}
          ids={compactRows.map((message) => message.id)}
          renderRow={(id) => {
            const message = compactRows.find((row) => row.id === id);
            if (!message) return null;
            const actions = queuedEntryActions(message);
            const subagentReference = splitSubagentReference(message.text);
            return (
              <QueuedMessageRow
                surface={composerWorkDrawer ? 'drawer' : 'tray'}
                data-testid="queued-message-bubble"
                text={
                  subagentReference.reference
                    ? subagentReference.body
                    : message.text
                }
                watcherFired={message.watcherFired}
                label={
                  message.agentSent ? (
                    <AgentSentTitle
                      agentSent={message.agentSent}
                      receivingContext={
                        receivingContext ?? { kind: 'project', projectId: '' }
                      }
                      layout="inline"
                    />
                  ) : undefined
                }
                // The cloud queue says only that a message has files, not
                // which; the row shows that much without naming any.
                attachments={
                  message.hasAttachments === true
                    ? [{ key: 'attachments', kind: 'file', name: 'Attachment' }]
                    : undefined
                }
                editLockAdvisory={message.editLockAdvisory}
                status={
                  message.waitingReason ? (
                    <QueuedMessageReason
                      waitingReason={message.waitingReason}
                      layout="inline"
                    />
                  ) : undefined
                }
                forceKind={queuedMessageForceKind(message)}
                onEdit={actions.onEdit}
                onSteer={actions.onSteer}
                steerBlockedByCapabilityChange={
                  thread?.steeringCapabilities?.steer === true &&
                  message.steerBlockedByCapabilityChange === true
                }
                settingsHeld={message.restartHeldChanges}
                // Send now runs whichever force the row offers: interrupt,
                // retry or run now.
                onInterrupt={
                  actions.onForce ?? actions.onRetry ?? actions.onRunNow
                }
                sendBlockedReason={
                  queueActionsEnabled &&
                  !(message.forceLocked ?? message.editLocked)
                    ? message.retryBlockedReason
                    : undefined
                }
                onDelete={actions.onCancel}
              />
            );
          }}
        />
      </div>
    ) : null;

  const creditHeld =
    !queuedCreditNoticeHandled &&
    waitingQueuedMessages.some(
      (message) => message.retryBlockedReason === 'insufficient_credits',
    );
  const queuedList =
    creditHeld ||
    (!compactQueue && waitingQueuedMessages.length > 0) ||
    (queueTarget !== undefined &&
      queueActionsEnabled &&
      (thread?.inputDelivery?.length ?? 0) > 0) ||
    queueEditNotice !== '' ||
    unsavedQueueEdits.length > 0 ? (
      <div
        className={`${REPLAY_BLOCK_CLASS} flex flex-col gap-2 px-4 pb-2`}
        data-testid="queued-message-list"
      >
        {creditHeld && (
          <Notice intent="attention">
            Your queued message is still saved. Add credits, then click Try
            again.
          </Notice>
        )}
        {queueTarget && queueActionsEnabled && (
          <InputDeliveryList
            onError={setQueueEditNotice}
            rows={thread?.inputDelivery ?? []}
            onFocusedRowRemoved={() => {
              composerContainer.current
                ?.querySelector<HTMLElement>(
                  '[contenteditable="true"], textarea',
                )
                ?.focus();
            }}
            onAction={(row, action, text) =>
              client.command('chat.inputDelivery', {
                ...queueTarget,
                rowId: row.id,
                rowRevision: row.revision,
                action,
                ...(text !== undefined ? { text } : {}),
              })
            }
          />
        )}
        {queueEditNotice !== '' && (
          <MessageEditNotice
            message={queueEditNotice}
            onDismiss={() => setQueueEditNotice('')}
          />
        )}
        <UnsavedMessageEdits
          drafts={unsavedQueueEdits}
          onDismiss={(draft): void =>
            setUnsavedQueueEdits((drafts) =>
              drafts.filter((candidate) => candidate !== draft),
            )
          }
        />
        {(compactQueue ? [] : waitingQueuedMessages).map(renderQueuedEntry)}
      </div>
    ) : null;

  const queueEdit: QueuedMessageEditControls | null =
    queueActionsEnabled && editingQueueEntry && editingQueuedMessage
      ? {
          entryId: editingQueueEntry.id,
          initialText: editingQueueEntry.text,
          allowEmpty: editingQueuedMessage.hasAttachments === true,
          autoFocus: queueEditAutoFocus,
          label: editingQueuedMessage.agentSent ? (
            <AgentSentTitle
              agentSent={editingQueuedMessage.agentSent}
              receivingContext={
                receivingContext ?? { kind: 'project', projectId: '' }
              }
            />
          ) : undefined,
          onTextChange: (text): void =>
            setEditingQueueEntry({ id: editingQueueEntry.id, text }),
          onSave: saveEditingQueueEntry,
          onCancel: cancelEditingQueueEntry,
        }
      : null;
  const queueEditor =
    queueEdit === null ? (
      hostQueuedMessageEditor
    ) : (
      <QueuedMessageComposer
        key={`queued-edit:${queueEdit.entryId}`}
        edit={queueEdit}
      />
    );

  // A queue on a chat with no messages is the start of the transcript (desktop
  // parity), unless the host's own empty state says the history is still
  // loading. A host footer status always means the transcript is live.
  const showPlaceholder =
    !renderTranscript &&
    messages.length === 0 &&
    deliveringMessages.length === 0 &&
    footerStatus == null &&
    (queuedList === null || emptyState != null);

  return (
    // A host composer draws the shared box, which takes the composer tray;
    // a host transcript's compact queue lands there too.
    <ComposerTrayProvider enabled={renderComposer !== undefined}>
      <AgentSentReceivingContextProvider receivingContext={receivingContext}>
        <div
          ref={panelRoot}
          className="flex h-full flex-col outline-none"
          data-testid="chat-panel"
          // Chat keeps plain line breaks (see canopy-tokens-core.css).
          data-chat-window
          {...find.surfaceProps}
        >
          {findScope !== undefined ? (
            <style>{find.highlightStyle}</style>
          ) : null}
          <ChatWaitingDelegationsContext.Provider value={waitingDelegations}>
            <div className="flex min-h-0 flex-1 flex-col">
              {renderTranscript ? (
                renderTranscript({
                  messages,
                  turnGroups,
                  status,
                  error,
                  renderLatestTurnAction,
                  footerStatus,
                  firstSendStartingEnabled,
                  worktreeSetup,
                  chatId,
                  queuedPromptCount,
                  queuedPromptIds,
                  queuedPromptMessageIds,
                  initialized,
                  deliveringMessages,
                })
              ) : showPlaceholder ? (
                <ChatTranscriptPlaceholder emptyState={emptyState} />
              ) : (
                <Suspense
                  fallback={
                    // Carries the queue tail and host status so a first send stays
                    // on screen while the transcript chunk loads.
                    <div
                      className="h-full p-3"
                      data-testid="chat-transcript-loading"
                    >
                      {(queuedList !== null ||
                        footerStatus != null ||
                        deliveringMessages.length > 0) && (
                        <div className="mx-auto w-full max-w-[var(--chat-reading-width)] chat-width-transition">
                          {/* The sent-bubble surface, without the transcript
                          chunk this placeholder waits for. */}
                          {deliveringMessages.map((message) => (
                            <MessageEditSurface key={message.messageId}>
                              <p className="whitespace-pre-wrap">
                                {message.text}
                              </p>
                            </MessageEditSurface>
                          ))}
                          {queuedList}
                          {footerStatus}
                        </div>
                      )}
                    </div>
                  }
                >
                  <LazyChatTranscript
                    chatId={chatId}
                    messages={messages}
                    turnGroups={turnGroups}
                    liveRunKeys={liveRunKeys}
                    status={status}
                    error={error}
                    appIcon={appIcon}
                    emptyState={emptyState}
                    renderLatestTurnAction={renderLatestTurnAction}
                    footerSlot={queuedList}
                    footerStatus={footerStatus}
                    firstSendStartingEnabled={firstSendStartingEnabled}
                    worktreeSetup={worktreeSetup}
                    deliveringMessages={deliveringMessages}
                    queuedPromptCount={queuedPromptCount}
                    queuedPromptIds={queuedPromptIds}
                    queuedPromptMessageIds={queuedPromptMessageIds}
                    initialized={initialized}
                    onLoadOlder={onLoadOlder}
                  />
                </Suspense>
              )}
            </div>
          </ChatWaitingDelegationsContext.Provider>
          {/* The shared transcript owns the queue (footerSlot), including on a chat
          with no messages yet. A host-supplied transcript and the host's
          loading placeholder keep it as a sibling; the reading column aligns
          it with the composer. */}
          {(renderTranscript || showPlaceholder) && queuedList ? (
            <div className="mx-auto w-full max-w-[var(--chat-reading-width)] chat-width-transition">
              {queuedList}
            </div>
          ) : null}
          {compactQueueList && (!composerWorkDrawer || queueEditor != null) ? (
            <ComposerTray>
              {composerWorkDrawer ? (
                <div
                  className="max-h-[min(40vh,20rem)] overflow-y-auto"
                  data-testid="queued-edit-queue-scroll"
                >
                  {compactQueueList}
                </div>
              ) : (
                compactQueueList
              )}
            </ComposerTray>
          ) : null}
          <div ref={composerContainer} className="contents">
            <QueuedEditComposerSlot editor={queueEditor}>
              {renderComposer ? (
                renderComposer({
                  queuedPanel:
                    composerWorkDrawer && queueEditor == null
                      ? compactQueueList
                      : undefined,
                  queuedCount: compactRows.length,
                  onSend: handleSend,
                  onStop,
                  isStreaming: status === 'streaming',
                  planMode,
                  onTogglePlanMode: () => setPlanMode(chatId, !planMode),
                  thinkingLevel,
                  onCycleThinking: (supportedLevels) =>
                    cycleThinkingLevel(chatId, providerType, supportedLevels),
                })
              ) : (
                <ChatComposer
                  key={chatId}
                  typeToFocus
                  onSend={handleSend}
                  onStop={onStop}
                  isStreaming={status === 'streaming'}
                  planMode={planMode}
                  onTogglePlanMode={() => setPlanMode(chatId, !planMode)}
                  draftKey={chatId}
                  planAvailable={onSend !== undefined && genuinePlanAvailable}
                  onEnablePlanMode={() => {
                    setPlanMode(chatId, true);
                    return true;
                  }}
                  thinkingLevel={thinkingLevel}
                  onCycleThinking={() =>
                    cycleThinkingLevel(chatId, providerType)
                  }
                  providerType={providerType}
                />
              )}
            </QueuedEditComposerSlot>
          </div>
        </div>
      </AgentSentReceivingContextProvider>
    </ComposerTrayProvider>
  );
}

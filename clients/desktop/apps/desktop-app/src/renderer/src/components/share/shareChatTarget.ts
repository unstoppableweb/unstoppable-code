import { shareInstallActionLabel } from '@canopy/ui-app/sharing/share-install-copy';
import type { ReactNode } from 'react';
import {
  INSERT_CHAT_TEXT_EVENT,
  type InsertChatTextDetail,
} from '@/lib/editorSelectionContext';
import { useChatStore } from '@/stores/chatStore';
import { isEditableChatTab } from '@/stores/chat/tab-utils';
import { worktreeKey } from '@/stores/chat/utils';
import { useGitHubStore } from '@/stores/githubStore';
import {
  toastStack,
  useToastStore,
  type ToastAction,
} from '@/stores/toastStore';
import {
  useNavigationStore,
  type NavigationPage,
} from '@/stores/navigationStore';

/**
 * The chat a share landing opened over (CAN-5219). Installing a shared skill
 * from it keeps the user in that chat and offers **Use in this chat**, which
 * appends the skill's invocation to that chat's composer without sending.
 *
 * The target is captured when the landing opens and never re-resolved: a
 * click after the user moved on must not write into whichever chat is now
 * active. Only the active, editable chat tab of the selected worktree on the
 * worktree chat page qualifies; a remembered chat behind a file tab does not,
 * because its composer is not the one on screen. The cowork `chat` page is
 * excluded: its composer is not addressed by a worktree tab.
 */
export interface ShareChatTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly tabId: string;
}

const SHARE_CHAT_PAGES: ReadonlySet<NavigationPage> = new Set(['main']);

/**
 * The selected worktree's active editable chat tab while one of `pages` is
 * showing and neither Settings nor the portal covers it. Identity only, so
 * it is cheap to call on every store update.
 */
export function activeChatTarget(
  pages: ReadonlySet<NavigationPage>,
): ShareChatTarget | null {
  const navigation = useNavigationStore.getState();
  if (
    !pages.has(navigation.activePage) ||
    navigation.settingsOpen ||
    navigation.remoteControlDialogOpen
  ) {
    return null;
  }
  const { selectedWorktree, worktreeChats } = useChatStore.getState();
  if (!selectedWorktree) return null;
  const chats = worktreeChats[worktreeKey(selectedWorktree)];
  if (!chats) return null;
  const activeTab = chats.tabs.find((tab) => tab.id === chats.activeTabId);
  if (!isEditableChatTab(activeTab)) return null;
  return {
    projectId: selectedWorktree.projectId,
    worktreeId: selectedWorktree.worktreeId,
    tabId: activeTab.id,
  };
}

/** The chat whose composer is on screen right now, or null. */
export function captureShareChatTarget(): ShareChatTarget | null {
  const target = activeChatTarget(SHARE_CHAT_PAGES);
  if (target === null) return null;
  // Targeted editor-selection events intentionally reach hidden composers.
  // This offer has a stricter contract: the captured tab must own a mounted,
  // visible editor, including when a layout has collapsed its chat panel.
  const visible = Array.from(
    document.querySelectorAll<HTMLElement>('[data-chat-composer-tab-id]'),
  ).some(
    (node): boolean =>
      node.dataset.chatComposerTabId === target.tabId &&
      node.getClientRects().length > 0 &&
      node.querySelector('[data-chat-textarea][contenteditable="true"]') !==
        null,
  );
  if (!visible) return null;
  return target;
}

/** Both identify the same tab of the same worktree. */
export function isSameChatTarget(
  current: ShareChatTarget | null,
  target: ShareChatTarget,
): boolean {
  return (
    current !== null &&
    current.projectId === target.projectId &&
    current.worktreeId === target.worktreeId &&
    current.tabId === target.tabId
  );
}

function hasCurrentIdentity(target: ShareChatTarget): boolean {
  return isSameChatTarget(activeChatTarget(SHARE_CHAT_PAGES), target);
}

/** The captured chat is still the one on screen. */
export function isShareChatTargetCurrent(target: ShareChatTarget): boolean {
  return isSameChatTarget(captureShareChatTarget(), target);
}

/**
 * Calls `onInvalid` once, the first time `isCurrent` turns false after a chat
 * or navigation store update. Returns the unsubscribe.
 */
export function watchChatTarget(
  isCurrent: () => boolean,
  onInvalid: () => void,
): () => void {
  let active = true;
  const check = (): void => {
    if (!active || isCurrent()) return;
    stop();
    onInvalid();
  };
  const unsubscribeChat = useChatStore.subscribe(check);
  const unsubscribeNavigation = useNavigationStore.subscribe(check);
  function stop(): void {
    active = false;
    unsubscribeChat();
    unsubscribeNavigation();
  }
  return stop;
}

/**
 * Calls `onInvalid` once, the first time the captured chat stops being the
 * one on screen (a page, worktree, or tab change, or the tab closing).
 * Returns the unsubscribe.
 */
export function watchShareChatTarget(
  target: ShareChatTarget,
  onInvalid: () => void,
): () => void {
  return watchChatTarget(() => hasCurrentIdentity(target), onInvalid);
}

/**
 * The composer text that invokes an installed skill: its installed folder
 * name (a collision rename included) as a slash command, with a trailing
 * space so the user can keep typing. Null when the name cannot be invoked.
 */
function skillInvocationText(skillName: string): string | null {
  return skillName === '' || /\s/.test(skillName) ? null : `/${skillName} `;
}

export type ShareChatInsertOutcome =
  /** The captured composer appended the invocation. */
  | 'inserted'
  /** The captured chat is no longer the one on screen. */
  | 'stale'
  /** No composer for the captured chat accepted the text. */
  | 'unhandled'
  /** The installed skill has no invocable name. */
  | 'invalid';

/**
 * Appends a skill's invocation to the captured chat's composer, keeping its
 * draft, and never sends. Revalidates the target first; a request no
 * composer acknowledges reports `unhandled` and changes nothing.
 */
export function insertSkillInvocation(
  target: ShareChatTarget,
  skillName: string,
): ShareChatInsertOutcome {
  const text = skillInvocationText(skillName);
  if (text === null) return 'invalid';
  if (!isShareChatTargetCurrent(target)) return 'stale';
  let handled = false;
  const detail: InsertChatTextDetail = {
    text,
    targetTabId: target.tabId,
    markHandled: (): void => {
      handled = true;
    },
  };
  document.dispatchEvent(new CustomEvent(INSERT_CHAT_TEXT_EVENT, { detail }));
  return handled ? 'inserted' : 'unhandled';
}

/**
 * Says why Use in this chat could not stage the skill. It answers a click,
 * so like the offer it shows with in-app notifications off and raises no
 * native banner.
 */
export function notifyUseInChatFailure(
  outcome: Exclude<ShareChatInsertOutcome, 'inserted'>,
): void {
  useGitHubStore
    .getState()
    .addToast(
      outcome === 'stale'
        ? 'That chat is no longer open. Type / in a chat to use the skill.'
        : 'Couldn’t add the skill to the chat. Type / in a chat to use it.',
      'warning',
      undefined,
      { forceInApp: true, suppressOsNotification: true },
    );
}

export interface UseInChatOffer {
  /** The installation notice the action rides on. */
  message: string;
  target: ShareChatTarget;
  /** Stages the skill in the target chat; see `insertSkillInvocation`. */
  stage: () => ShareChatInsertOutcome | Promise<ShareChatInsertOutcome>;
}

export interface ChatActionOffer<
  Outcome extends string,
  Succeeded extends Outcome,
> {
  /** The installation notice the action rides on. */
  message: string;
  label: ReactNode;
  /** The label while the staged work runs. */
  busyLabel?: string;
  target: ShareChatTarget;
  /** Calls `onInvalid` once the target stops qualifying; returns the unsubscribe. */
  watch: (target: ShareChatTarget, onInvalid: () => void) => () => void;
  stage: () => Outcome | Promise<Outcome>;
  succeeded: Succeeded;
  onFailure: (outcome: Exclude<Outcome, Succeeded>) => void;
}

function isFailure<Outcome extends string, Succeeded extends Outcome>(
  outcome: Outcome,
  succeeded: Succeeded,
): outcome is Exclude<Outcome, Succeeded> {
  return outcome !== succeeded;
}

/**
 * Shows an installation notice with one chat action. The notice stays up
 * until it is dismissed so keyboard and screen reader users can reach it,
 * shows even with in-app notifications off (the landing it replaces has
 * closed), and leaves when it is used, dismissed, the target stops
 * qualifying, or another share request arrives. The action stages at most
 * once.
 */
export function offerChatAction<
  Outcome extends string,
  Succeeded extends Outcome,
>({
  message,
  label,
  busyLabel,
  target,
  watch,
  stage,
  succeeded,
  onFailure,
}: ChatActionOffer<Outcome, Succeeded>): void {
  let settled = false;
  let stopWatching = (): void => undefined;
  let stopReview = (): void => undefined;
  const settle = (): void => {
    settled = true;
    stopWatching();
    stopReview();
  };
  const action: ToastAction = {
    label,
    ...(busyLabel === undefined ? {} : { busyLabel }),
    onClick: async (): Promise<void> => {
      if (settled) return;
      settle();
      const outcome = await stage();
      if (isFailure(outcome, succeeded)) onFailure(outcome);
    },
  };
  const github = useGitHubStore.getState();
  github.addToast(
    message,
    'success',
    undefined,
    {
      action,
      keepUntilDismissed: true,
      forceInApp: true,
      suppressOsNotification: true,
    },
    settle,
  );
  const { notifications } = useToastStore.getState();
  const toastId = [...toastStack.getSnapshot(), ...notifications].find(
    (toast) => toast.meta?.action === action,
  )?.id;
  const invalidate = (): void => {
    if (settled) return;
    settle();
    if (toastId !== undefined) useToastStore.getState().dismissToast(toastId);
  };
  stopWatching = watch(target, invalidate);
  stopReview = useNavigationStore.subscribe((state): void => {
    if (state.pendingShareInstall !== undefined) invalidate();
  });
}

/**
 * Shows the installation notice with **Use in this chat** as its one
 * action; see {@link offerChatAction}.
 */
export function offerUseInChat({
  message,
  target,
  stage,
}: UseInChatOffer): void {
  offerChatAction({
    message,
    label: shareInstallActionLabel('skill', 'use-in-chat'),
    target,
    watch: watchShareChatTarget,
    stage,
    succeeded: 'inserted',
    onFailure: notifyUseInChatFailure,
  });
}

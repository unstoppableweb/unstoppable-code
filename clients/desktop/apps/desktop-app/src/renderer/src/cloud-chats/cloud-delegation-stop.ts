import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  CloudDelegationStopError,
  createCloudManagedDelegationStore,
  type CloudDelegationChatScope,
  type CoreCoworkInvoker,
} from '@canopy/app-state/core-cowork';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { createRelayCoreCoworkInvoker } from '@/cloud-chats/relay-invoker';
import { webCoreLocalId } from '@/lib/chat-authority';
import { webCoreChatId } from '@/stores/chat/web-core';
import { worktreeKey } from '@/stores/chat/utils';
import { useChatStore, type ChatMessage } from '@/stores/chatStore';

/** The chat whose delegates a stop reads or targets, by its local ids. */
export interface CloudDelegationChatTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

export type CloudDelegationStopResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** One store for the window: every view of a chat shares its read loop. */
const store = createCloudManagedDelegationStore();

/**
 * One invoker for the window: the store reads a chat afresh whenever its
 * invoker changes, so every caller hands it the same one.
 */
let relayInvoker: CoreCoworkInvoker | null = null;

function invoker(): CoreCoworkInvoker | null {
  if (relayInvoker !== null) return relayInvoker;
  if (typeof window === 'undefined' || !window.canopyCore) return null;
  relayInvoker = createRelayCoreCoworkInvoker(window.canopyCore);
  return relayInvoker;
}

/** A cloud chat's web core ids, or null for any other chat (CAN-7245). */
export function cloudDelegationChatScope(
  target: CloudDelegationChatTarget,
): CloudDelegationChatScope | null {
  const workspaceId = webCoreLocalId(target.projectId);
  const worktreeId = webCoreLocalId(target.worktreeId);
  const chatId = webCoreChatId(target.chatId);
  if (workspaceId === null || worktreeId === null || !chatId) return null;
  return { workspaceId, worktreeId, chatId };
}

/**
 * The delegates on a chat's own cards: its messages' delegate blocks, not a
 * delegate's own delegates shown in a card's pages. Only these are stopped.
 */
export function chatsOwnDelegationIds(
  messages: readonly ChatMessage[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of messages)
    for (const block of message.blocks)
      if (block.type === 'delegated_agent_call') ids.add(block.delegationId);
  return ids;
}

/** Whether `delegationId` is on a delegate card in that chat's transcript. */
function isChatsOwnDelegate(
  target: CloudDelegationChatTarget,
  delegationId: string,
): boolean {
  const tab = useChatStore.getState().worktreeChats[
    worktreeKey({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
    })
  ]?.tabs.find((entry) => entry.id === target.chatId);
  return (
    tab !== undefined && chatsOwnDelegationIds(tab.messages).has(delegationId)
  );
}

const NOT_THIS_CHATS_DELEGATE = "That delegate isn't part of this chat.";
const NOT_A_CLOUD_CHAT = "This chat's delegates can't be stopped here.";

/**
 * Stops one of a cloud chat's own delegates and the tasks it started, as the
 * user, through the web core. Only a delegate whose card is in that chat is
 * asked for; anything else is refused with no request.
 */
export async function stopCloudDelegation(
  target: CloudDelegationChatTarget,
  delegationId: string,
): Promise<CloudDelegationStopResult> {
  const scope = cloudDelegationChatScope(target);
  const relay = invoker();
  if (scope === null || relay === null)
    return { ok: false, error: NOT_A_CLOUD_CHAT };
  if (!isChatsOwnDelegate(target, delegationId))
    return { ok: false, error: NOT_THIS_CHATS_DELEGATE };
  try {
    await store.stop(relay, scope, delegationId);
    return { ok: true };
  } catch (error: unknown) {
    // The web core's refusal, in its own words; anything else is a defect.
    if (error instanceof CloudDelegationStopError)
      return { ok: false, error: error.message };
    reportClientAppError(error);
    return { ok: false, error: '' };
  }
}

/** Stops every live delegate of a cloud chat, as the user. */
export async function stopAllCloudDelegations(
  target: CloudDelegationChatTarget,
): Promise<CloudDelegationStopResult> {
  const scope = cloudDelegationChatScope(target);
  const relay = invoker();
  if (scope === null || relay === null)
    return { ok: false, error: NOT_A_CLOUD_CHAT };
  try {
    await store.stopAll(relay, scope);
    return { ok: true };
  } catch (error: unknown) {
    // The web core's refusal, in its own words; anything else is a defect.
    if (error instanceof CloudDelegationStopError)
      return { ok: false, error: error.message };
    reportClientAppError(error);
    return { ok: false, error: '' };
  }
}

/**
 * The live snapshots the window already holds for a cloud chat's delegates,
 * read by whichever view watches it, or null for any other chat. Never
 * starts a read (CAN-7133).
 */
export function heldCloudDelegationSnapshots(
  target: CloudDelegationChatTarget,
): ReadonlyMap<string, AgentDelegationSnapshot> | null {
  const scope = cloudDelegationChatScope(target);
  return scope === null ? null : store.view(scope).snapshots;
}

/** Calls `listener` whenever any cloud chat's held live state changes. */
export function subscribeHeldCloudDelegations(
  listener: () => void,
): () => void {
  return store.subscribe(listener);
}

/** A cloud chat's delegates as the web core last read them. */
export interface CloudDelegationLiveState {
  readonly snapshots: ReadonlyMap<string, AgentDelegationSnapshot>;
  /**
   * Per delegate, bumps whenever its lifecycle changes: its open child pages
   * read the newest page again, as the web's do.
   */
  readonly epochs: ReadonlyMap<string, number>;
}

const NO_LIVE_STATE: CloudDelegationLiveState = {
  snapshots: new Map(),
  epochs: new Map(),
};

/**
 * The live state of a cloud chat's delegates, as the web core reads them,
 * while the caller is mounted; null for no target. `delegationIds` are the
 * chat's own cards: the store keeps a delegate it read once the list stops
 * returning it.
 */
export function useCloudDelegationLiveState(
  target: CloudDelegationChatTarget | null,
  delegationIds: readonly string[],
  options: {
    /**
     * The parent's turn is running: its agent may start a new run on a
     * settled delegate, so the chat is read while it does.
     */
    readonly parentActive: boolean;
    /** Changes with the chat's transcript: a new card or turn re-reads. */
    readonly changeKey: string;
  },
): CloudDelegationLiveState | null {
  const projectId = target?.projectId;
  const worktreeId = target?.worktreeId;
  const chatId = target?.chatId;
  const scope = useMemo(
    () =>
      projectId === undefined ||
      worktreeId === undefined ||
      chatId === undefined
        ? null
        : cloudDelegationChatScope({ projectId, worktreeId, chatId }),
    [chatId, projectId, worktreeId],
  );
  useEffect(() => {
    const relay = invoker();
    if (scope === null || relay === null) return undefined;
    return store.watch(relay, scope);
  }, [scope]);
  useEffect(() => {
    if (scope !== null) store.refresh(scope);
  }, [options.changeKey, scope]);
  const { parentActive } = options;
  useEffect(() => {
    if (scope === null || !parentActive) return undefined;
    return store.holdActive(scope);
  }, [parentActive, scope]);
  const idsKey = delegationIds.join('\n');
  useEffect(() => {
    if (scope !== null) store.track(scope, idsKey ? idsKey.split('\n') : []);
  }, [idsKey, scope]);
  const view = useSyncExternalStore(store.subscribe, () =>
    scope === null ? null : store.view(scope),
  );
  const snapshots = view?.snapshots;
  const epochs = view?.epochs;
  return useMemo(
    () =>
      scope === null
        ? null
        : snapshots === undefined || epochs === undefined
          ? NO_LIVE_STATE
          : { snapshots, epochs },
    [epochs, scope, snapshots],
  );
}

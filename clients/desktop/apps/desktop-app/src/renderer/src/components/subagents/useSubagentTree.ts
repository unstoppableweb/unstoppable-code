import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useShallow } from 'zustand/shallow';
import type { AgentUsage, SubagentTree } from '@canopy/agent-transcript';
import type { ManagedDelegationTreeEntry } from '@canopy/desktop-shared/types';
import type { SubagentTreeLoadState } from '@canopy/ui-app/subagents';
import {
  chatsOwnDelegationIds,
  useCloudDelegationLiveState,
} from '@/cloud-chats/cloud-delegation-stop';
import { isWebCoreScope } from '@/lib/chat-authority';
import { getChatTabLabel } from '@/lib/chatTabLabel';
import { extractIpcErrorMessage } from '@/lib/errors';
import { useChatStore, type ChatMessage } from '@/stores/chatStore';
import { hydratedKeys } from '@/stores/chat/hydration';
import { flushChatInterest } from '@/lib/chat-interest';
import { catchUpStaleChat } from '@/stores/chat/stale-catch-up';
import { localTurnActivity } from '@/stores/chat/turn-activity';
import {
  loadChatTranscriptPage,
  TRANSCRIPT_PAGE_LOAD_ERROR,
} from '@/stores/chat/transcript-pages';
import {
  acquireSubagentTree,
  getSubagentTreeSnapshot,
  subscribeSubagentTree,
  updateSubagentTreeLiveSnapshots,
  updateSubagentTreeRootChat,
} from './subagent-tree-store';
import type { SubagentHostScope } from './subagent-scope';

/** Shared, per-root query consumed by the Subagents and subagent-chat panels. */
export interface SubagentTreeQuery {
  readonly tree: SubagentTree | null;
  readonly treeState: SubagentTreeLoadState;
  readonly settled: boolean;
  readonly rootChatOpen: boolean;
  readonly hydrated: boolean;
  readonly managedEntries: ReadonlyMap<string, ManagedDelegationTreeEntry>;
}

export interface UseSubagentTreeOptions {
  readonly enabled: boolean;
  /**
   * Reload the root's transcript when it was evicted. Only views that show
   * the root's tree pass it: the residency sweep keeps their root resident,
   * so a background consumer reloading would only be evicted again.
   */
  readonly reloadEvictedTranscript?: boolean;
  /**
   * A cloud root's delegates' live state may be read from the web core: its
   * scope serves it (`delegationStop`, CAN-7245). Its cards keep their first
   * state, so the tree reads the live one over them (CAN-7133).
   */
  readonly liveReads?: boolean;
}

interface RootChatProjection {
  readonly messages: readonly ChatMessage[] | null;
  readonly agentUsage?: Readonly<Record<string, AgentUsage>>;
  readonly hydrated: boolean;
  readonly rootChatOpen: boolean;
  readonly needsTranscriptReload: boolean;
  readonly transcriptStale: boolean;
  readonly title: string;
  /**
   * The root's turn is streaming or dispatching, as its chat view reads it:
   * its agent may start a new run on a settled delegate meanwhile.
   */
  readonly turnActive: boolean;
}

const EMPTY_PROJECTION: RootChatProjection = {
  messages: null,
  hydrated: false,
  rootChatOpen: false,
  needsTranscriptReload: false,
  transcriptStale: false,
  title: '',
  turnActive: false,
};

const NOOP_UNSUBSCRIBE = (): void => undefined;

function isTurnRunning(
  activity: ReturnType<typeof localTurnActivity>,
): boolean {
  return activity === 'streaming' || activity === 'dispatching';
}

/** Reads one root chat without subscribing to unrelated worktree chat updates. */
export function useSubagentTree(
  scope: SubagentHostScope | null,
  rootChatId: string | null,
  options: UseSubagentTreeOptions,
): SubagentTreeQuery {
  const enabled = options.enabled && scope !== null && rootChatId !== null;
  const reloadEvictedTranscript = options.reloadEvictedTranscript === true;
  const projectId = scope?.projectId;
  const worktreeId = scope?.worktreeId;
  const inFlightTranscriptReloads = useRef(new Set<string>());
  const reloadKey =
    projectId !== undefined && worktreeId !== undefined && rootChatId !== null
      ? `${projectId}/${worktreeId}\u0000${rootChatId}`
      : null;
  // A failed reload waits for the view's retry instead of looping.
  const [failedReload, setFailedReload] = useState<{
    readonly key: string;
    readonly error: string;
  } | null>(null);

  const projection = useChatStore(
    useShallow((state): RootChatProjection => {
      if (!enabled || projectId === undefined || worktreeId === undefined) {
        return EMPTY_PROJECTION;
      }
      const worktreeKey = `${projectId}/${worktreeId}`;
      const hydrated = hydratedKeys.has(worktreeKey);
      const tab = state.worktreeChats[worktreeKey]?.tabs.find(
        (candidate) => candidate.id === rootChatId && candidate.kind !== 'file',
      );
      const rootChatOpen = hydrated && tab !== undefined;
      return {
        messages: rootChatOpen && tab ? tab.messages : null,
        ...(rootChatOpen && tab?.agentUsage
          ? { agentUsage: tab.agentUsage }
          : {}),
        hydrated,
        rootChatOpen,
        // Evicted, or holding only rows that arrived since.
        needsTranscriptReload:
          rootChatOpen && tab !== undefined && tab.transcriptLoaded === false,
        transcriptStale: rootChatOpen && tab?.transcriptStale === true,
        title: rootChatOpen && tab ? getChatTabLabel(tab) : (rootChatId ?? ''),
        turnActive:
          rootChatOpen &&
          tab !== undefined &&
          rootChatId !== null &&
          isTurnRunning(
            localTurnActivity(
              tab,
              Date.now(),
              state.runtimeByChatId[rootChatId],
            ),
          ),
      };
    }),
  );

  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      if (!enabled || !scope || !rootChatId) return NOOP_UNSUBSCRIBE;
      return subscribeSubagentTree(scope, rootChatId, listener);
    },
    [enabled, rootChatId, scope],
  );

  const getSnapshot = useCallback(
    () => getSubagentTreeSnapshot(scope, rootChatId),
    [rootChatId, scope],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!enabled || !scope || !rootChatId) return undefined;
    return acquireSubagentTree(scope, rootChatId);
  }, [enabled, projectId, rootChatId, scope, worktreeId]);

  useEffect(() => {
    if (
      !enabled ||
      !reloadEvictedTranscript ||
      projectId === undefined ||
      worktreeId === undefined ||
      !rootChatId ||
      reloadKey === null ||
      !projection.needsTranscriptReload ||
      failedReload?.key === reloadKey
    ) {
      return;
    }
    // Only one load per root in flight; a later eviction reloads the next
    // time the root needs it.
    const inFlight = inFlightTranscriptReloads.current;
    if (inFlight.has(reloadKey)) return;
    inFlight.add(reloadKey);
    const target = { projectId, worktreeId, chatId: rootChatId };
    // The newest-page read skips a stale transcript; catch-up installs it.
    const read = projection.transcriptStale
      ? catchUpStaleChat(target, flushChatInterest)
      : loadChatTranscriptPage(target, false);
    void read
      .then(
        (): void => {
          // A read can settle without installing a page; offer a retry
          // rather than loading forever.
          const tab = useChatStore
            .getState()
            .worktreeChats[
              `${projectId}/${worktreeId}`
            ]?.tabs.find((candidate) => candidate.id === rootChatId);
          if (tab?.transcriptLoaded === false) {
            setFailedReload({
              key: reloadKey,
              error: TRANSCRIPT_PAGE_LOAD_ERROR,
            });
          }
        },
        (error: unknown): void => {
          setFailedReload({
            key: reloadKey,
            error: extractIpcErrorMessage(error),
          });
        },
      )
      .finally(() => inFlight.delete(reloadKey));
  }, [
    enabled,
    failedReload,
    projectId,
    projection.needsTranscriptReload,
    projection.transcriptStale,
    reloadEvictedTranscript,
    reloadKey,
    rootChatId,
    worktreeId,
  ]);

  useEffect(() => {
    if (!enabled || !scope || !rootChatId) return;
    updateSubagentTreeRootChat(scope, rootChatId, projection);
  }, [enabled, projectId, projection, rootChatId, scope, worktreeId]);

  // A cloud root's cards keep their first state; the web core reads their
  // delegates' current one while its scope serves it (CAN-7133).
  const liveReads = options.liveReads === true;
  const liveTarget = useMemo(
    () =>
      enabled &&
      liveReads &&
      projectId !== undefined &&
      worktreeId !== undefined &&
      rootChatId !== null &&
      isWebCoreScope(projectId)
        ? { projectId, worktreeId, chatId: rootChatId }
        : null,
    [enabled, liveReads, projectId, rootChatId, worktreeId],
  );
  const ownDelegationIds = useMemo(
    () =>
      liveTarget === null || projection.messages === null
        ? []
        : Array.from(chatsOwnDelegationIds(projection.messages)).sort(),
    [liveTarget, projection.messages],
  );
  const live = useCloudDelegationLiveState(liveTarget, ownDelegationIds, {
    parentActive: projection.turnActive,
    changeKey: String(projection.messages?.length ?? 0),
  });
  const liveSnapshots = live?.snapshots ?? null;
  useEffect(() => {
    if (!enabled || !scope || !rootChatId) return;
    updateSubagentTreeLiveSnapshots(scope, rootChatId, liveSnapshots);
  }, [enabled, liveSnapshots, rootChatId, scope]);

  // Until an evicted root's rows are back, its tree is incomplete: report it
  // loading so views keep their focus, or the failure so they can retry.
  const awaitingReload =
    enabled && reloadEvictedTranscript && projection.needsTranscriptReload;
  const reloadError =
    awaitingReload && failedReload !== null && failedReload.key === reloadKey
      ? failedReload.error
      : null;
  return useMemo((): SubagentTreeQuery => {
    if (!awaitingReload) return snapshot;
    return {
      ...snapshot,
      settled: false,
      treeState:
        reloadError === null
          ? { status: 'loading' }
          : {
              status: 'error',
              error: reloadError,
              onRetry: (): void => setFailedReload(null),
            },
    };
  }, [awaitingReload, reloadError, snapshot]);
}

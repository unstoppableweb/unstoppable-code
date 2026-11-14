import { readTurnOutcomeCounts } from '@canopy/protocol/portal';
import {
  isTranscriptPageForCurrentWindow,
  type TranscriptWindowIdentity,
} from '@canopy/app-state';
import type {
  ChatTranscriptPageRequest,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import { sanitizePersistedChatMessages } from '@/lib/chatMessageSanitization';
import { preservePendingUserMessages } from './optimistic-presentation';
import type { ChatMessage, ChatTab } from './types';
import { chatStoreApi } from './store-ref';
import { chatScopeKey } from './revisioned-sync';
import {
  beginTranscriptPerformanceStage,
  recordTranscriptPerformanceCounter,
} from '@/lib/transcript-performance';
import {
  coalesceTranscriptResetReload,
  hasPendingTranscriptReset,
  MAX_TRANSCRIPT_RESET_PAGES,
  pendingTranscriptResetRevision,
  loadedTranscriptPageCount,
  recordLoadedTranscriptPage,
  replaceLoadedTranscriptPageCount,
  transcriptResetReloadKey,
  isLocallyRebasedTranscriptWindow,
} from './transcript-reset';
import { useActivityStore } from '../activityStore';
import { chatBackendFor, servesTurnPages } from './backend';
import { retireFinishedPendingTurn } from './canonical-changes';

export const TRANSCRIPT_PAGE_LOAD_ERROR = "Couldn't load messages.";

/**
 * Whether a transcript loads its newest page before it can page back: it is
 * not loaded, or it is a raw window to upgrade to a turn view where its host
 * serves one. A host without turn frames pages its window back by `before`.
 */
export function needsNewestTranscriptPage(
  transcript:
    | Pick<PersistedChatTab, 'transcriptLoaded' | 'transcriptWindow'>
    | null
    | undefined,
  scope: { readonly projectId: string } | undefined,
): boolean {
  return (
    transcript?.transcriptLoaded === false ||
    (transcript?.transcriptWindow?.before !== undefined &&
      transcript.transcriptWindow.view !== 'turns' &&
      (scope === undefined || servesTurnPages(scope)))
  );
}

function watchTranscriptWindow(
  api: ReturnType<typeof chatStoreApi>,
  key: string,
  chatId: string,
  initial: Pick<
    PersistedChatTab,
    'createdAt' | 'transcriptLoaded' | 'transcriptWindow'
  >,
): {
  initial: TranscriptWindowIdentity;
  current(
    tab:
      | Pick<
          PersistedChatTab,
          'createdAt' | 'transcriptLoaded' | 'transcriptWindow'
        >
      | undefined,
  ): TranscriptWindowIdentity | undefined;
  stop(): void;
} {
  let generation = 0;
  let previousTabPresent = true;
  let previousCreatedAt: string | undefined = initial.createdAt;
  let previousWindowPresent = initial.transcriptWindow !== undefined;
  let previousResetRevision = pendingTranscriptResetRevision(initial);
  let previousResetPending = hasPendingTranscriptReset(initial);
  let previousWindow = initial.transcriptWindow;
  const unsubscribe = api.subscribe((state) => {
    const tab = state.worktreeChats[key]?.tabs.find(
      (candidate) => candidate.id === chatId,
    );
    const resetPending = tab ? hasPendingTranscriptReset(tab) : false;
    const resetRevision = tab ? pendingTranscriptResetRevision(tab) : undefined;
    const resetAdvanced =
      resetPending &&
      (!previousResetPending || resetRevision !== previousResetRevision);
    if (
      previousTabPresent &&
      (!tab ||
        tab.createdAt !== previousCreatedAt ||
        (previousWindowPresent && tab.transcriptWindow === undefined) ||
        resetAdvanced ||
        (tab.transcriptWindow !== previousWindow &&
          isLocallyRebasedTranscriptWindow(tab.transcriptWindow)))
    ) {
      generation += 1;
    }
    previousWindow = tab?.transcriptWindow;
    previousTabPresent = tab !== undefined;
    previousCreatedAt = tab?.createdAt;
    previousWindowPresent = tab?.transcriptWindow !== undefined;
    previousResetRevision = resetRevision;
    previousResetPending = resetPending;
  });
  return {
    initial: {
      chatId: `${key}\u0000${chatId}\u0000${initial.createdAt}`,
      generation: 0,
    },
    current(
      tab:
        | Pick<
            PersistedChatTab,
            'createdAt' | 'transcriptLoaded' | 'transcriptWindow'
          >
        | undefined,
    ): TranscriptWindowIdentity | undefined {
      return tab
        ? {
            chatId: `${key}\u0000${chatId}\u0000${tab.createdAt}`,
            generation,
          }
        : undefined;
    },
    stop: unsubscribe,
  };
}

function orderRowsByTranscriptOrdinal(
  rows: Map<string, ChatMessage>,
  ordinals: Record<string, number>,
  retainedMessages: readonly ChatMessage[],
): ChatMessage[] {
  const positions = new Map<
    string,
    { ordinal: number; side: number; sequence: number }
  >();
  for (const [id, ordinal] of Object.entries(ordinals)) {
    positions.set(id, { ordinal, side: 0, sequence: -1 });
  }

  for (let index = 0; index < retainedMessages.length; index += 1) {
    const message = retainedMessages[index];
    if (!message || !rows.has(message.id) || positions.has(message.id))
      continue;
    let predecessorPosition:
      | { ordinal: number; side: number; sequence: number }
      | undefined;
    for (
      let previousIndex = index - 1;
      previousIndex >= 0;
      previousIndex -= 1
    ) {
      const predecessor = retainedMessages[previousIndex];
      const position = predecessor ? positions.get(predecessor.id) : undefined;
      if (position) {
        predecessorPosition = position;
        break;
      }
    }
    if (predecessorPosition) {
      positions.set(message.id, {
        ordinal: predecessorPosition.ordinal,
        side: 1,
        sequence: index,
      });
      continue;
    }

    let successorOrdinal: number | undefined;
    for (
      let nextIndex = index + 1;
      nextIndex < retainedMessages.length;
      nextIndex += 1
    ) {
      const successor = retainedMessages[nextIndex];
      const position = successor ? positions.get(successor.id) : undefined;
      if (position) {
        successorOrdinal = position.ordinal;
        break;
      }
    }
    positions.set(message.id, {
      ordinal: successorOrdinal === undefined ? 0 : successorOrdinal - 1,
      side: -1,
      sequence: index,
    });
  }

  const unpositioned = Array.from(rows.keys()).filter(
    (id) => !positions.has(id),
  );
  for (let index = 0; index < unpositioned.length; index += 1) {
    const id = unpositioned[index];
    if (id)
      positions.set(id, {
        ordinal: -1,
        side: -1,
        sequence: index,
      });
  }

  return Array.from(rows.values()).sort((left, right) => {
    const leftPosition = positions.get(left.id);
    const rightPosition = positions.get(right.id);
    if (!leftPosition || !rightPosition) return 0;
    return (
      leftPosition.ordinal - rightPosition.ordinal ||
      leftPosition.side - rightPosition.side ||
      leftPosition.sequence - rightPosition.sequence
    );
  });
}

/**
 * A tab with the turn ends its page names laid over its own (CAN-6560): a
 * host that records none on its tabs names them on its pages instead.
 */
function withPageTurnEnds<T extends Pick<PersistedChatTab, 'turnEnds'>>(
  tab: T,
  page: TranscriptPage,
): T {
  return page.turnEnds === undefined
    ? tab
    : { ...tab, turnEnds: { ...tab.turnEnds, ...page.turnEnds } };
}

export function installTranscriptPage<
  T extends Pick<
    PersistedChatTab,
    'messages' | 'transcriptWindow' | 'transcriptLoaded' | 'turnEnds'
  > & { pendingUserMessages?: ChatMessage[] },
>(tab: T, page: TranscriptPage, older: boolean): T {
  const finishPerformanceStage = beginTranscriptPerformanceStage(
    'page_install',
    {
      pageRows: page.messages.length,
      retainedRows: older ? tab.messages.length : 0,
    },
  );
  recordTranscriptPerformanceCounter('page_installs');
  if (page.view === 'turns') {
    const previous = older ? tab.transcriptWindow : undefined;
    const ordinals = { ...previous?.messageOrdinals, ...page.messageOrdinals };
    const rows = new Map(
      (older ? tab.messages : []).map((row) => [row.id, row]),
    );
    for (const row of sanitizePersistedChatMessages(page.messages))
      rows.set(row.id, row);
    const turns = new Map(
      previous?.turns?.map((turn) => [turn.id, turn]) ?? [],
    );
    for (const wireTurn of page.turns ?? []) {
      // Remote peers may still send the two-count projection. Normalize only
      // at the wire boundary; persisted index validation stays strict.
      const turn = {
        ...wireTurn,
        outcomes: readTurnOutcomeCounts(wireTurn.outcomes),
        ...(wireTurn.continuations === undefined
          ? {}
          : {
              continuations: Object.fromEntries(
                Object.entries(wireTurn.continuations).map(
                  ([id, continuation]) => [
                    id,
                    {
                      ...continuation,
                      outcomes: readTurnOutcomeCounts(continuation.outcomes),
                    },
                  ],
                ),
              ),
            }),
      };
      const retained = turns.get(turn.id);
      turns.set(
        turn.id,
        retained
          ? {
              ...turn,
              before:
                retained.before === undefined || turn.before === undefined
                  ? undefined
                  : Math.min(retained.before, turn.before),
            }
          : turn,
      );
    }
    const orderedMessages = orderRowsByTranscriptOrdinal(
      rows,
      ordinals,
      tab.messages,
    );
    const preserved = preservePendingUserMessages(
      tab,
      orderedMessages,
      page.messages,
    );
    finishPerformanceStage({ installedRows: preserved.messages.length });
    return withPageTurnEnds(
      {
        ...preserved,
        transcriptLoaded: true,
        transcriptWindow: {
          view: 'turns',
          before: page.turnId ? previous?.before : page.before,
          turns: Array.from(turns.values()).sort((a, b) => a.start - b.start),
          messageOrdinals: ordinals,
          totalMessages: page.totalMessages,
          transcriptRevision: page.transcriptRevision,
        },
      },
      page,
    );
  }
  const supplementalId = tab.transcriptWindow?.latestHumanMessage?.id;
  const rawHuman =
    page.latestHumanMessage ?? tab.transcriptWindow?.latestHumanMessage;
  const candidates =
    rawHuman && !page.messages.some((message) => message.id === rawHuman.id)
      ? [rawHuman, ...page.messages]
      : page.messages;
  const sanitizedById = new Map(
    sanitizePersistedChatMessages(candidates).map((message) => [
      message.id,
      message,
    ]),
  );
  const rows = new Map(
    page.messages.flatMap((message) => {
      const sanitized = sanitizedById.get(message.id);
      return sanitized ? [[message.id, sanitized] as const] : [];
    }),
  );
  if (older) {
    for (const message of tab.messages) {
      if (message.id !== supplementalId && !rows.has(message.id))
        rows.set(message.id, message);
    }
  }
  const human = rawHuman ? sanitizedById.get(rawHuman.id) : undefined;
  const supplement = human && !rows.has(human.id) ? human : undefined;
  const messages = [
    ...(supplement ? [supplement] : []),
    ...Array.from(rows.values()),
  ];
  const preserved = preservePendingUserMessages(tab, messages, page.messages);
  finishPerformanceStage({ installedRows: preserved.messages.length });
  return withPageTurnEnds(
    {
      ...preserved,
      transcriptLoaded: true,
      transcriptWindow: {
        before: page.before,
        totalMessages: page.totalMessages,
        transcriptRevision: page.transcriptRevision,
        ...(supplement ? { latestHumanMessage: supplement } : {}),
      },
    },
    page,
  );
}

/** An in-flight read can never recreate a removed chat or overwrite a newer
 * stream/reset. Pagination changes only the selected chat's transient view. */
export async function loadChatTranscriptPage(
  target: Pick<
    ChatTranscriptPageRequest,
    'projectId' | 'worktreeId' | 'chatId'
  >,
  older = false,
  turnId?: string,
  options: {
    retainOlderWindow?: boolean;
    /** Installs a stale chat's newest page with its replayed changes. */
    catchUp?: (tab: ChatTab, page: TranscriptPage) => ChatTab;
  } = {},
): Promise<void> {
  const api = chatStoreApi();
  const key = chatScopeKey(target.projectId, target.worktreeId);
  const initial = api
    .getState()
    .worktreeChats[key]?.tabs.find((tab) => tab.id === target.chatId);
  // Hook startup persists its initial transcript before the queue releases the
  // placeholder. Hydrating it early would make the still-cancellable queue
  // entry look like a normal conversation with sent messages.
  if (!initial || initial.queuedHookPlaceholder === true) return;
  const { catchUp } = options;
  // Stale newest-page reads have one replay-aware owner. Earlier pages
  // retain their normal lazy merge path.
  if (initial.transcriptStale && !older && !catchUp) return;

  const windowWatch = watchTranscriptWindow(api, key, target.chatId, initial);
  const reloadKey = transcriptResetReloadKey(
    key,
    target.chatId,
    initial.createdAt,
  );
  const reloadForPendingReset = (): Promise<void> =>
    coalesceTranscriptResetReload(reloadKey, () =>
      reloadTranscriptWindowAfterReset(
        api,
        target,
        key,
        initial,
        windowWatch,
        options.retainOlderWindow ?? true,
      ),
    );

  // A chat that was not loaded at startup gets its messages here. Adopt its
  // background launches into the activity store, as hydration does for
  // loaded chats, so the resolution pass settles what its session no longer
  // runs. Without it a finished agent's launch receipt read as running
  // forever. Adoption only adds this chat's entries; other chats' live work
  // stays as it is. A reset reload installs the window too, so it adopts.
  const adoptIfFirstLoad = (): void => {
    if (initial.transcriptLoaded !== false) return;
    const loaded = currentTranscriptTab(api, key, target.chatId);
    if (
      loaded &&
      loaded.createdAt === initial.createdAt &&
      loaded.transcriptLoaded !== false
    ) {
      useActivityStore
        .getState()
        .adoptChatMessages(target.projectId, target.worktreeId, loaded);
    }
  };

  // A catch-up installs a fresh newest page, which supersedes a pending reset;
  // the reset reload would neither replay its changes nor clear the stale mark.
  if (!catchUp && hasPendingTranscriptReset(initial)) {
    try {
      await reloadForPendingReset();
      adoptIfFirstLoad();
    } finally {
      windowWatch.stop();
    }
    return;
  }

  const recoverChangedWindow = async (
    current: ChatTab | undefined,
  ): Promise<void> => {
    if (!current || current.createdAt !== initial.createdAt) return;
    if (hasPendingTranscriptReset(current)) {
      await reloadForPendingReset();
      adoptIfFirstLoad();
    } else if (
      older &&
      isLocallyRebasedTranscriptWindow(current.transcriptWindow)
    ) {
      // The loaded boundary is still valid, but main rejected the old rank revision.
      await loadChatTranscriptPage(target, older, turnId, options);
    }
  };

  // A turn outside the loaded window has no interior cursor yet: walk the
  // global history cursor one page at a time until it appears (the same loop
  // transcript search uses), instead of dropping the request.
  const knownTurn = turnId
    ? initial.transcriptWindow?.turns?.find((turn) => turn.id === turnId)
    : undefined;
  const before = knownTurn
    ? knownTurn.before
    : initial.transcriptWindow?.before;
  if (older && before === undefined) {
    windowWatch.stop();
    return;
  }
  const requestedIdentity = windowWatch.initial;
  try {
    let page: TranscriptPage;
    try {
      page = await chatBackendFor(target).chat.getTranscriptPage({
        ...target,
        view: 'turns',
        ...(knownTurn ? { turnId } : {}),
        ...(older
          ? {
              before,
              transcriptRevision:
                initial.transcript?.transcriptRevision ??
                initial.transcriptWindow?.transcriptRevision,
            }
          : {}),
      });
    } catch (error) {
      const current = currentTranscriptTab(api, key, target.chatId);
      const currentIdentity = windowWatch.current(current);
      if (
        !catchUp &&
        !isTranscriptPageForCurrentWindow(requestedIdentity, currentIdentity)
      ) {
        await recoverChangedWindow(current);
        return;
      }
      throw error;
    }
    let changed = false;
    let installed = false;
    api.setState((state) => {
      const scope = state.worktreeChats[key];
      const current = scope?.tabs.find((tab) => tab.id === target.chatId);
      if (!scope || !current || current.queuedHookPlaceholder === true)
        return state;
      const currentIdentity = windowWatch.current(current);
      // A catch-up replays whatever committed meanwhile, so only a replaced
      // chat invalidates its page.
      const stale = catchUp
        ? current.createdAt !== initial.createdAt
        : !isTranscriptPageForCurrentWindow(
            requestedIdentity,
            currentIdentity,
          ) ||
          (older
            ? // Main guarantees ordinary inserts do not reset ordinal ranks;
              // reset identity, rather than revision ordering, guards this map.
              current.createdAt !== initial.createdAt ||
              current.transcriptWindow === undefined
            : current.createdAt !== initial.createdAt ||
              current.messages !== initial.messages ||
              current.transcript?.transcriptRevision !==
                initial.transcript?.transcriptRevision);
      if (stale) {
        changed = true;
        return state;
      }
      installed = true;
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: {
            ...scope,
            tabs: scope.tabs.map((tab) =>
              tab.id === target.chatId
                ? // A page can carry the prompt's echo after its turn ended.
                  retireFinishedPendingTurn(
                    catchUp
                      ? catchUp(tab, page)
                      : installTranscriptPage(tab, page, older),
                    state.runtimeByChatId[target.chatId],
                  )
                : tab,
            ),
          },
        },
      };
    });
    if (installed) recordLoadedTranscriptPage(api, reloadKey, older);
    if (changed) {
      const current = currentTranscriptTab(api, key, target.chatId);
      const currentIdentity = windowWatch.current(current);
      if (
        !catchUp &&
        !isTranscriptPageForCurrentWindow(requestedIdentity, currentIdentity)
      ) {
        await recoverChangedWindow(current);
        return;
      }
      if (!current) return;
      throw new Error(TRANSCRIPT_PAGE_LOAD_ERROR);
    }
    // Hover prefetch loads it through `catchUp`, so that path counts too.
    if (installed && !older) adoptIfFirstLoad();
  } finally {
    windowWatch.stop();
  }
}

function currentTranscriptTab(
  api: ReturnType<typeof chatStoreApi>,
  key: string,
  chatId: string,
): ChatTab | undefined {
  return api
    .getState()
    .worktreeChats[key]?.tabs.find((tab) => tab.id === chatId);
}

function reloadTranscriptWindowAfterReset(
  api: ReturnType<typeof chatStoreApi>,
  target: Pick<
    ChatTranscriptPageRequest,
    'projectId' | 'worktreeId' | 'chatId'
  >,
  key: string,
  initial: ChatTab,
  windowWatch: ReturnType<typeof watchTranscriptWindow>,
  retainOlderWindow: boolean,
): Promise<void> {
  return reloadTranscriptWindowAfterResetLoop(
    api,
    target,
    key,
    initial,
    windowWatch,
    retainOlderWindow,
  );
}

async function reloadTranscriptWindowAfterResetLoop(
  api: ReturnType<typeof chatStoreApi>,
  target: Pick<
    ChatTranscriptPageRequest,
    'projectId' | 'worktreeId' | 'chatId'
  >,
  key: string,
  initial: ChatTab,
  windowWatch: ReturnType<typeof watchTranscriptWindow>,
  retainOlderWindow: boolean,
): Promise<void> {
  // A newest turn page can carry a sticky prompt from before its history cursor.
  // That supplement alone must not make a multi-page window look restored.
  const historyBefore = initial.transcriptWindow?.before;
  const oldestPreResetMessageId = retainOlderWindow
    ? (initial.messages.find((message) => {
        const ordinal = initial.transcriptWindow?.messageOrdinals?.[message.id];
        return (
          historyBefore === undefined ||
          (ordinal !== undefined && ordinal >= historyBefore)
        );
      })?.id ?? initial.messages[0]?.id)
    : undefined;

  const reloadKey = transcriptResetReloadKey(
    key,
    target.chatId,
    initial.createdAt,
  );
  const pageLimit = retainOlderWindow
    ? Math.min(
        loadedTranscriptPageCount(api, reloadKey),
        MAX_TRANSCRIPT_RESET_PAGES,
      )
    : 1;

  while (true) {
    const resetTab = currentTranscriptTab(api, key, target.chatId);
    if (!resetTab || resetTab.createdAt !== initial.createdAt) return;
    if (!hasPendingTranscriptReset(resetTab)) return;

    const reloadIdentity = windowWatch.current(resetTab);
    if (!reloadIdentity) return;
    let stagedTab: ChatTab = {
      ...resetTab,
      messages: [],
      transcriptLoaded: false,
      transcriptWindow: undefined,
    };
    let requests = 0;
    let before: number | undefined;
    let restartForNewReset = false;

    while (requests < pageLimit) {
      const current = currentTranscriptTab(api, key, target.chatId);
      if (!current || current.createdAt !== initial.createdAt) return;
      if (!hasPendingTranscriptReset(current)) return;
      if (
        !isTranscriptPageForCurrentWindow(
          reloadIdentity,
          windowWatch.current(current),
        )
      ) {
        restartForNewReset = true;
        break;
      }

      const newestRequest = requests === 0;
      const transcriptRevision =
        stagedTab.transcriptWindow?.transcriptRevision ??
        current.transcript?.transcriptRevision ??
        current.transcriptWindow?.transcriptRevision;
      let page: TranscriptPage;
      requests += 1;
      try {
        page = await chatBackendFor(target).chat.getTranscriptPage({
          ...target,
          view: 'turns',
          ...(newestRequest
            ? {}
            : {
                before,
                transcriptRevision,
              }),
        });
      } catch (error) {
        const afterFailure = currentTranscriptTab(api, key, target.chatId);
        if (
          afterFailure &&
          afterFailure.createdAt === initial.createdAt &&
          hasPendingTranscriptReset(afterFailure) &&
          !isTranscriptPageForCurrentWindow(
            reloadIdentity,
            windowWatch.current(afterFailure),
          )
        ) {
          restartForNewReset = true;
          break;
        }
        throw error;
      }

      const afterRead = currentTranscriptTab(api, key, target.chatId);
      if (!afterRead || afterRead.createdAt !== initial.createdAt) return;
      if (!hasPendingTranscriptReset(afterRead)) return;
      if (
        !isTranscriptPageForCurrentWindow(
          reloadIdentity,
          windowWatch.current(afterRead),
        )
      ) {
        restartForNewReset = true;
        break;
      }

      stagedTab = installTranscriptPage(stagedTab, page, !newestRequest);
      const foundOldest =
        oldestPreResetMessageId === undefined ||
        stagedTab.messages.some(
          (message) => message.id === oldestPreResetMessageId,
        );
      before = stagedTab.transcriptWindow?.before;
      if (foundOldest || before === undefined) break;
    }

    if (restartForNewReset) continue;

    const latest = currentTranscriptTab(api, key, target.chatId);
    if (!latest || latest.createdAt !== initial.createdAt) return;
    if (!hasPendingTranscriptReset(latest)) return;
    if (
      !isTranscriptPageForCurrentWindow(
        reloadIdentity,
        windowWatch.current(latest),
      )
    ) {
      continue;
    }

    // Retain live edits and optimistic sends that arrived during the staged
    // read, but let the fetched pages decide which persisted rows survived.
    const resetMessages = new Map(
      resetTab.messages.map((message) => [message.id, message]),
    );
    const rows = new Map(
      stagedTab.messages.map((message) => [message.id, message]),
    );
    const liveRevision = latest.transcript?.transcriptRevision;
    if (
      liveRevision === undefined ||
      liveRevision >= (stagedTab.transcriptWindow?.transcriptRevision ?? 0)
    ) {
      for (const message of latest.messages) {
        if (
          message !== resetMessages.get(message.id) &&
          (rows.has(message.id) || !resetMessages.has(message.id))
        ) {
          rows.set(message.id, message);
        }
      }
    }
    const mergedMessages = orderRowsByTranscriptOrdinal(
      rows,
      stagedTab.transcriptWindow?.messageOrdinals ?? {},
      latest.messages,
    );
    const finalTab = preservePendingUserMessages(
      {
        ...latest,
        transcriptLoaded: true,
        transcriptWindow: stagedTab.transcriptWindow,
      },
      mergedMessages,
      stagedTab.messages,
    );
    let installed = false;
    api.setState((state) => {
      const scope = state.worktreeChats[key];
      const current = scope?.tabs.find((tab) => tab.id === target.chatId);
      if (
        !scope ||
        !current ||
        current.createdAt !== initial.createdAt ||
        !hasPendingTranscriptReset(current) ||
        !isTranscriptPageForCurrentWindow(
          reloadIdentity,
          windowWatch.current(current),
        )
      ) {
        return state;
      }
      installed = true;
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: {
            ...scope,
            tabs: scope.tabs.map((tab) =>
              tab.id === target.chatId
                ? retireFinishedPendingTurn(
                    finalTab,
                    state.runtimeByChatId[target.chatId],
                  )
                : tab,
            ),
          },
        },
      };
    });
    if (installed) replaceLoadedTranscriptPageCount(api, reloadKey, requests);
    const afterInstall = currentTranscriptTab(api, key, target.chatId);
    if (
      afterInstall &&
      afterInstall.createdAt === initial.createdAt &&
      hasPendingTranscriptReset(afterInstall)
    )
      continue;
    return;
  }
}

import { TrackedPlanImplementationSchema } from '@canopy/protocol/remote-control/shell';
import type {
  ArchivedChatsFile,
  ChatCoreMutation,
  ChatRuntimeState,
  ChatTabMetadataPatch,
  ChatTabsFile,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  defineChatTabMetadataProperty,
  isSafeChatTabMetadataKey,
} from '@canopy/desktop-shared/chat-tab-metadata';
import { mergeAgentModelConfig } from '@canopy/execution-engine/lib/codex-speed';

export interface CanonicalChatState {
  tabsFile: ChatTabsFile;
  archivesFile: ArchivedChatsFile;
  runtimeByChatId: Record<string, ChatRuntimeState>;
}

export class ChatStateInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ChatStateInvariantError';
  }
}

function uniqueIds(values: readonly string[], label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (!value || ids.has(value)) {
      throw new ChatStateInvariantError(
        `Invalid or duplicate ${label}: ${value}`,
      );
    }
    ids.add(value);
  }
}

function validateMessageIds(messages: readonly PersistedChatMessage[]): void {
  uniqueIds(
    messages.map((message) => message.id),
    'message id',
  );
}

function validateCanonicalChatStructure(state: CanonicalChatState): void {
  const tabIds = state.tabsFile.tabs.map((tab) => tab.id);
  uniqueIds(tabIds, 'tab id');

  if (
    state.tabsFile.activeTabId !== '' &&
    !tabIds.includes(state.tabsFile.activeTabId)
  ) {
    throw new ChatStateInvariantError('Active tab does not exist');
  }
  if (
    state.tabsFile.lastActiveEditableChatId &&
    !state.tabsFile.tabs.some(
      (tab) =>
        tab.id === state.tabsFile.lastActiveEditableChatId &&
        tab.kind !== 'file' &&
        tab.readOnly !== true,
    )
  ) {
    throw new ChatStateInvariantError(
      'Last active editable chat does not exist or is not editable',
    );
  }

  uniqueIds(
    state.archivesFile.archived.map((entry) => entry.tab.id),
    'archive chat id',
  );
  const liveIds = new Set(tabIds);
  for (const entry of state.archivesFile.archived) {
    if (liveIds.has(entry.tab.id)) {
      throw new ChatStateInvariantError(
        `Chat ${entry.tab.id} cannot be live and archived`,
      );
    }
  }

  for (const question of state.tabsFile.pendingQuestions ?? []) {
    if (!liveIds.has(question.chatId)) {
      throw new ChatStateInvariantError(
        `Pending question ${question.requestId} targets a missing chat`,
      );
    }
  }
}

export function validateCanonicalChatState(state: CanonicalChatState): void {
  validateCanonicalChatStructure(state);
  for (const tab of state.tabsFile.tabs) validateMessageIds(tab.messages);
  for (const entry of state.archivesFile.archived) {
    validateMessageIds(entry.tab.messages);
  }
}

function updateTab(
  tabs: readonly PersistedChatTab[],
  tabId: string,
  update: (tab: PersistedChatTab) => PersistedChatTab,
): PersistedChatTab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) throw new ChatStateInvariantError(`Unknown tab: ${tabId}`);
  const next = tabs.slice();
  next[index] = update(tabs[index]);
  return next;
}

function applySettingsPatch(
  tab: PersistedChatTab,
  patch: ChatTabMetadataPatch,
): PersistedChatTab {
  if (tab.kind === 'file') {
    const unsupported = Object.keys(patch).find(
      (key) =>
        key !== 'pinned' &&
        key !== 'fileViewMode' &&
        key !== 'fileDiffContext' &&
        key !== 'filePath' &&
        key !== 'title',
    );
    if (unsupported) {
      throw new ChatStateInvariantError(
        `Chat setting ${unsupported} cannot patch a file tab`,
      );
    }
    const next: PersistedChatTab = { ...tab };
    if (patch.pinned === null) delete next.pinned;
    else if (patch.pinned !== undefined) next.pinned = patch.pinned;
    if (patch.fileViewMode === null) {
      delete next.fileViewMode;
    } else if (patch.fileViewMode !== undefined) {
      next.fileViewMode = patch.fileViewMode;
    }
    if (patch.fileDiffContext === null) delete next.fileDiffContext;
    else if (patch.fileDiffContext !== undefined)
      next.fileDiffContext = patch.fileDiffContext;
    if (patch.filePath !== undefined) next.filePath = patch.filePath;
    if (patch.title !== undefined && patch.title !== null) {
      next.title = patch.title;
    }
    return next;
  }
  if (patch.fileViewMode !== undefined || patch.fileDiffContext !== undefined) {
    throw new ChatStateInvariantError('File view mode cannot patch a chat tab');
  }
  if (patch.filePath !== undefined) {
    throw new ChatStateInvariantError(
      'File path patches only apply to file tabs',
    );
  }
  const next: PersistedChatTab = { ...tab };
  const { modelConfig, ...rest } = patch;
  for (const [key, value] of Object.entries(rest)) {
    if (!isSafeChatTabMetadataKey(key)) continue;
    if (value === null || value === undefined) {
      if (value === null) Reflect.deleteProperty(next, key);
      continue;
    }
    defineChatTabMetadataProperty(next, key, value);
  }
  // Only `chat.mark_unread` sets the manual flag; any other unread write
  // replaces the user's mark.
  if (rest.unread !== undefined) delete next.unreadMarkedManually;
  if (modelConfig === null) {
    delete next.modelConfig;
  } else if (modelConfig !== undefined) {
    // Partial modelConfig patches (a lone thinking or speed change) merge
    // field-wise so concurrent independent toggles commute instead of
    // clobbering each other's sibling fields. The shared merge also keeps the
    // Codex speed canonical: an explicit `speed` wins with its derived
    // `fastMode`, a legacy boolean `fastMode` replaces the speed (including
    // `false` on Ultra fast), and unrelated patches preserve it.
    next.modelConfig = mergeAgentModelConfig(tab.modelConfig, modelConfig);
  }
  return reconcilePlanImplementation(tab, next);
}

/** Deterministic canonical reduction: settlement survives bounded end eviction. */
function reconcilePlanImplementation(
  previous: PersistedChatTab,
  next: PersistedChatTab,
): PersistedChatTab {
  const link = next.trackedPlanImplementation;
  if (!link) return next;
  if (
    link === previous.trackedPlanImplementation &&
    next.trackedPlanId === link.planId &&
    next.turnEnds === previous.turnEnds
  )
    return next;
  if (!TrackedPlanImplementationSchema.safeParse(link).success)
    throw new ChatStateInvariantError('Invalid tracked plan implementation');
  if (next.trackedPlanId !== link.planId) {
    delete next.trackedPlanImplementation;
    return next;
  }
  const prior = previous.trackedPlanImplementation;
  if (
    prior?.planId === link.planId &&
    prior.userMessageId === link.userMessageId &&
    prior.revisionNumber === link.revisionNumber &&
    prior.startedAt === link.startedAt &&
    prior.outcome
  ) {
    next.trackedPlanImplementation = prior;
    return next;
  }
  const end = next.turnEnds?.[link.userMessageId];
  if (!link.outcome && end)
    next.trackedPlanImplementation = {
      ...link,
      outcome: end.outcome,
      endedAt: new Date(end.endedAt).toISOString(),
    };
  return next;
}

export function applyMutation(
  state: CanonicalChatState,
  mutation: ChatCoreMutation,
): CanonicalChatState {
  switch (mutation.type) {
    case 'tab.created': {
      validateMessageIds(mutation.tab.messages);
      const existingIndex = state.tabsFile.tabs.findIndex(
        (tab) => tab.id === mutation.tab.id,
      );
      const tabs = state.tabsFile.tabs.slice();
      const nextTab = reconcilePlanImplementation(
        existingIndex < 0 ? mutation.tab : tabs[existingIndex],
        { ...mutation.tab },
      );
      if (existingIndex < 0) tabs.push(nextTab);
      else tabs[existingIndex] = nextTab;
      return {
        ...state,
        tabsFile: {
          ...state.tabsFile,
          tabs,
          activeTabId: state.tabsFile.activeTabId || mutation.tab.id,
        },
      };
    }
    case 'tab.metadata_patched':
      return {
        ...state,
        tabsFile: {
          ...state.tabsFile,
          tabs: updateTab(state.tabsFile.tabs, mutation.tabId, (tab) =>
            applySettingsPatch(tab, mutation.patch),
          ),
        },
      };
    case 'tab.removed': {
      if (!state.tabsFile.tabs.some((tab) => tab.id === mutation.tabId)) {
        throw new ChatStateInvariantError(`Unknown tab: ${mutation.tabId}`);
      }
      const tabs = state.tabsFile.tabs.filter(
        (tab) => tab.id !== mutation.tabId,
      );
      const runtimeByChatId = { ...state.runtimeByChatId };
      Reflect.deleteProperty(runtimeByChatId, mutation.tabId);
      return {
        ...state,
        runtimeByChatId,
        tabsFile: {
          ...state.tabsFile,
          tabs,
          activeTabId:
            state.tabsFile.activeTabId === mutation.tabId
              ? (tabs[0]?.id ?? '')
              : state.tabsFile.activeTabId,
          ...(state.tabsFile.lastActiveEditableChatId === mutation.tabId
            ? { lastActiveEditableChatId: undefined }
            : {}),
          pendingQuestions: (state.tabsFile.pendingQuestions ?? []).filter(
            (question) => question.chatId !== mutation.tabId,
          ),
        },
      };
    }
    case 'tab.order_changed': {
      uniqueIds(mutation.tabIds, 'ordered tab id');
      const currentIds = new Set(state.tabsFile.tabs.map((tab) => tab.id));
      if (
        mutation.tabIds.length !== currentIds.size ||
        mutation.tabIds.some((id) => !currentIds.has(id))
      ) {
        throw new ChatStateInvariantError(
          'Tab order must contain every live tab',
        );
      }
      const byId = new Map(state.tabsFile.tabs.map((tab) => [tab.id, tab]));
      const orderedTabs = mutation.tabIds.map((id) => {
        const orderedTab = byId.get(id);
        if (!orderedTab) {
          throw new ChatStateInvariantError(`Unknown ordered tab: ${id}`);
        }
        return orderedTab;
      });
      return {
        ...state,
        tabsFile: {
          ...state.tabsFile,
          tabs: orderedTabs,
        },
      };
    }
    case 'tab.active_changed':
      if (!state.tabsFile.tabs.some((tab) => tab.id === mutation.activeTabId)) {
        throw new ChatStateInvariantError(
          `Unknown active tab: ${mutation.activeTabId}`,
        );
      }
      return {
        ...state,
        tabsFile: {
          ...state.tabsFile,
          activeTabId: mutation.activeTabId,
          ...(mutation.lastActiveEditableChatId !== undefined
            ? { lastActiveEditableChatId: mutation.lastActiveEditableChatId }
            : {}),
          ...(mutation.lastActiveChatProvider !== undefined
            ? { lastActiveChatProvider: mutation.lastActiveChatProvider }
            : {}),
        },
      };
    case 'message.upserted':
      validateMessageIds([mutation.message]);
      return {
        ...state,
        tabsFile: {
          ...state.tabsFile,
          tabs: updateTab(state.tabsFile.tabs, mutation.chatId, (tab) => {
            const index = tab.messages.findIndex(
              (message) => message.id === mutation.message.id,
            );
            const messages = tab.messages.slice();
            if (index < 0) {
              const anchor = mutation.afterMessageId
                ? messages.findIndex(
                    (message) => message.id === mutation.afterMessageId,
                  )
                : -1;
              let insertAt = anchor < 0 ? messages.length : anchor + 1;
              while (
                insertAt < messages.length &&
                messages[insertAt]?.parentBlockId === mutation.afterMessageId
              )
                insertAt += 1;
              messages.splice(insertAt, 0, mutation.message);
            } else messages[index] = mutation.message;
            return { ...tab, messages };
          }),
        },
      };
    case 'message.removed':
      return {
        ...state,
        tabsFile: {
          ...state.tabsFile,
          tabs: updateTab(state.tabsFile.tabs, mutation.chatId, (tab) => ({
            ...tab,
            messages: tab.messages.filter(
              (message) => message.id !== mutation.messageId,
            ),
          })),
        },
      };
    case 'messages.replaced':
      validateMessageIds(mutation.messages);
      return {
        ...state,
        tabsFile: {
          ...state.tabsFile,
          tabs: updateTab(state.tabsFile.tabs, mutation.chatId, (tab) => ({
            ...tab,
            messages: mutation.messages,
          })),
        },
      };
    case 'pending_question.upserted': {
      if (
        !state.tabsFile.tabs.some(
          (tab) => tab.id === mutation.question.chatId && tab.kind !== 'file',
        )
      ) {
        throw new ChatStateInvariantError(
          `Question targets unknown chat: ${mutation.question.chatId}`,
        );
      }
      const questions = state.tabsFile.pendingQuestions?.slice() ?? [];
      const index = questions.findIndex(
        (question) => question.requestId === mutation.question.requestId,
      );
      if (index < 0) questions.push(mutation.question);
      else questions[index] = mutation.question;
      return {
        ...state,
        tabsFile: { ...state.tabsFile, pendingQuestions: questions },
      };
    }
    case 'pending_question.removed':
      return {
        ...state,
        tabsFile: {
          ...state.tabsFile,
          pendingQuestions: (state.tabsFile.pendingQuestions ?? []).filter(
            (question) =>
              question.requestId !== mutation.requestId ||
              question.chatId !== mutation.chatId,
          ),
        },
      };
    case 'runtime.patched': {
      if (!state.tabsFile.tabs.some((tab) => tab.id === mutation.chatId)) {
        throw new ChatStateInvariantError(
          `Runtime targets unknown chat: ${mutation.chatId}`,
        );
      }
      const previousRuntime = state.runtimeByChatId[mutation.chatId];
      const runtime =
        mutation.runtime.turn === undefined &&
        previousRuntime?.turn !== undefined
          ? { ...mutation.runtime, turn: previousRuntime.turn }
          : mutation.runtime;
      return {
        ...state,
        runtimeByChatId: {
          ...state.runtimeByChatId,
          [mutation.chatId]: runtime,
        },
      };
    }
    case 'archive.upserted': {
      validateMessageIds(mutation.entry.tab.messages);
      if (state.tabsFile.tabs.some((tab) => tab.id === mutation.entry.tab.id)) {
        throw new ChatStateInvariantError(
          `Cannot archive live tab ${mutation.entry.tab.id}`,
        );
      }
      const existingArchiveIndex = state.archivesFile.archived.findIndex(
        (entry) => entry.tab.id === mutation.entry.tab.id,
      );
      const archived = [...state.archivesFile.archived];
      if (existingArchiveIndex >= 0) {
        archived[existingArchiveIndex] = mutation.entry;
      } else {
        archived.unshift(mutation.entry);
      }
      return {
        ...state,
        archivesFile: {
          ...state.archivesFile,
          archived,
        },
      };
    }
    case 'archive.removed':
      return {
        ...state,
        archivesFile: {
          ...state.archivesFile,
          archived: state.archivesFile.archived.filter(
            (entry) =>
              entry.tab.id !== mutation.chatId &&
              entry.tab.id !== mutation.archiveEntryId,
          ),
        },
      };
    case 'archive.read_state_changed':
      return {
        ...state,
        archivesFile: {
          ...state.archivesFile,
          archived: state.archivesFile.archived.map((entry) =>
            entry.tab.id === mutation.chatId ||
            entry.tab.id === mutation.archiveEntryId
              ? { ...entry, unread: mutation.unread }
              : entry,
          ),
        },
      };
  }
}

export function reduceChatState(
  current: CanonicalChatState,
  mutations: readonly ChatCoreMutation[],
): CanonicalChatState {
  let next = current;
  for (const mutation of mutations) next = applyMutation(next, mutation);
  // The loaded/current aggregate has already passed full validation. Each
  // transcript-bearing mutation validates only the message collection it
  // introduces above; rescanning every unchanged transcript here would make a
  // runtime patch scale with the entire workspace history.
  validateCanonicalChatStructure(next);
  return next;
}

import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { inferLegacyExecutionHarness } from '@canopy/desktop-shared/types';
import {
  hydrateChatTurnState,
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { iterateAsync } from './cooperative-json';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import type {
  ArchivedChatsFile,
  ChatTabsFile,
  ChatJournalRecord,
  ChatCoreMutation,
  ChatRuntimeState,
  PersistedCommandReceipt,
} from '@canopy/desktop-shared/types';
import {
  createEmptyArchivedChatsFile,
  createEmptyChatTabsFile,
  normalizeLegacyChatTabsFile,
  normalizeLegacyPersistedChatTab,
  persistedFileRevision,
} from '@canopy/desktop-shared/persisted-chat-state';
import {
  applyMutation,
  ChatStateInvariantError,
  validateCanonicalChatState,
  type CanonicalChatState,
} from '../services/chat-state-reducer';
import { LegacyChatInput, type LegacyInputLocation } from './legacy-chat-input';
import {
  isArchivedSnapshot,
  isChatTabsSnapshot,
  repairLegacySnapshots,
} from './chat-state-snapshots';
import { isErrnoException } from './type-guards';
import { isChatJournalRecord } from './chat-state-journal';
import {
  type ChatStorageV2,
  type ChatMigrationSource,
  type ChatMigrationEntry,
} from './chat-storage-v2';
import { SettlementAnswerTracker } from '@canopy/agent-transcript/settlement';
import {
  buildPersistedTurnSettlement,
  collectPersistedSettlementEvidence,
  hasOpenPersistedChatTurn,
  settlePersistedInterruptedStream,
} from './persisted-chat-settle';

export interface LegacyChatScopePaths {
  tabs: string;
  archives: string;
  journal: string;
}

/**
 * A v1 scope whose snapshots and journal no longer form one contiguous
 * revision chain (for example a stale archive snapshot whose bridging journal
 * records were compacted). Metadata only: it never carries chat content.
 */
export interface LegacyChatRevisionGapRecovery {
  /** First revision the chain needed but the journal did not contain. */
  expectedRevision: number;
  /** First retained revision above the hole; absent when none was retained. */
  foundRevision?: number;
  newestRevision: number;
  tabsRevision: number;
  archiveRevision: number;
  /** The snapshot left behind the other, or `journal` for an internal hole. */
  staleComponent: 'tabs' | 'archives' | 'journal';
  /** Retained mutations that could not apply to the recovered base state. */
  skippedMutationCount: number;
}

export interface LegacyChatMigrationSource extends ChatMigrationSource {
  revisionGapRecovery?: LegacyChatRevisionGapRecovery;
}

export interface LegacyChatMigrationReport {
  /** Set only when this call migrated the scope across a revision gap. */
  revisionGapRecovery?: LegacyChatRevisionGapRecovery;
}

function retain(set: Set<string>, id: string, limit: number): void {
  set.delete(id);
  set.add(id);
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/** The spilled array is empty regardless of transcript length; use its last
 * row to retain the legacy started-session normalization without hydration. */
async function normalizeMigrationTab(
  input: LegacyChatInput,
  tab: PersistedChatTab,
): Promise<void> {
  if (tab.pluginSelections)
    tab.pluginSelections = normalizePluginSelections(tab.pluginSelections);
  const last = await input.messages(tab.messages).last();
  if (!last) {
    if (tab.executionHarnessExplicitlyChosen !== true)
      delete tab.executionHarness;
  } else {
    tab.executionHarness ??= inferLegacyExecutionHarness({
      model: tab.model,
      providerType: tab.providerType,
      hasStarted: true,
    });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Recovers the same v1 revision/component semantics without retaining bodies. */
export async function loadLegacyChatMigrationSource(
  input: LegacyChatInput,
  paths: LegacyChatScopePaths,
): Promise<LegacyChatMigrationSource> {
  const evidence = new Set<string>();
  const inventory = async (): Promise<string[]> => {
    const files = new Set(
      [paths.tabs, paths.archives, paths.journal].flatMap((path) => [
        path,
        path + '.bak',
      ]),
    );
    for (const path of [paths.tabs, paths.archives, paths.journal]) {
      try {
        for (const name of await readdir(dirname(path)))
          if (name.startsWith(basename(path) + '.'))
            files.add(join(dirname(path), name));
      } catch (error) {
        if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
      }
    }
    return Array.from(files).sort();
  };
  const sourceFiles = await inventory();
  for (const file of sourceFiles)
    if (
      ![paths.tabs, paths.archives, paths.journal].some(
        (path) => file === path || file === path + '.bak',
      )
    )
      evidence.add(file);
  const fingerprints = async (): Promise<string[]> =>
    Promise.all(
      (await inventory()).map(async (path) => {
        try {
          const value = await stat(path, { bigint: true });
          return `${path}:${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
        } catch (error) {
          if (isErrnoException(error) && error.code === 'ENOENT')
            return `${path}:missing`;
          throw error;
        }
      }),
    );
  const sourceFingerprints = await fingerprints();
  const records = new Map<
    number,
    { fingerprint: string; location: LegacyInputLocation }
  >();
  const lifecycle = new Map<
    string,
    { type: 'tab.created' | 'tab.removed'; revision: number; index: number }
  >();
  const lifecycleEvents: Array<{
    id: string;
    type: 'tab.created' | 'tab.removed';
    revision: number;
    index: number;
  }> = [];
  const receipts = new Map<string, PersistedCommandReceipt>();
  const mutationIds = new Set<string>();
  const removedTabIds = new Set<string>();
  const removedArchiveEntryIds = new Set<string>();
  const removedMessageIds = new Set<string>();
  const removedMessageKeys = new Set<string>();
  let maxJournalRevision = 0;
  try {
    for await (const record of input.journal(paths.journal, true)) {
      const fingerprint = input.fingerprint(record);
      const existing = records.get(record.revision);
      if (existing && existing.fingerprint !== fingerprint)
        throw new Error(
          `Conflicting duplicate chat revision ${record.revision}`,
        );
      records.set(record.revision, {
        fingerprint,
        location: input.origin(record),
      });
      maxJournalRevision = Math.max(maxJournalRevision, record.revision);
      if (!existing)
        record.mutations.forEach((mutation, index) => {
          if (mutation.type === 'tab.created')
            lifecycleEvents.push({
              id: mutation.tab.id,
              type: mutation.type,
              revision: record.revision,
              index,
            });
          if (mutation.type === 'tab.removed')
            lifecycleEvents.push({
              id: mutation.tabId,
              type: mutation.type,
              revision: record.revision,
              index,
            });
        });
    }
  } catch (error) {
    if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
  }

  // Which family files the source below is built from, and which it read
  // but set aside for a newer copy; cleanup removes only the former, or a
  // file whose bytes migration kept as evidence.
  const consumed = new Set<string>();
  const superseded = new Set<string>();
  const snapshot = async <T extends { revision?: number }>(
    path: string,
    validate: (value: unknown) => value is T,
    empty: () => T,
  ): Promise<{ value: T; present: boolean }> => {
    const read = async (
      file: string,
    ): Promise<{ value?: T; error?: unknown }> => {
      try {
        const value = await input.snapshot(file);
        if (!validate(value))
          throw new Error(`Invalid legacy snapshot ${file}`);
        return { value };
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') return {};
        evidence.add(file);
        return { error };
      }
    };
    const primary = await read(path);
    const backup = await read(path + '.bak');
    if (!primary.value) {
      if (backup.value) {
        consumed.add(path + '.bak');
        return { value: backup.value, present: true };
      }
      if (primary.error || backup.error)
        throw Object.assign(
          new Error('Unable to recover legacy chat snapshot'),
          {
            cause: primary.error ?? backup.error,
          },
        );
      return { value: empty(), present: false };
    }
    if (
      backup.value &&
      persistedFileRevision(backup.value) >
        persistedFileRevision(primary.value) &&
      maxJournalRevision >= persistedFileRevision(backup.value)
    ) {
      consumed.add(path + '.bak');
      superseded.add(path);
      return { value: backup.value, present: true };
    }
    consumed.add(path);
    if (backup.value) superseded.add(path + '.bak');
    return { value: primary.value, present: true };
  };
  const {
    value: tabs,
    present: tabsPresent,
  }: {
    value: ChatTabsFile;
    present: boolean;
  } = await snapshot(paths.tabs, isChatTabsSnapshot, createEmptyChatTabsFile);
  const {
    value: archives,
    present: archivesPresent,
  }: {
    value: ArchivedChatsFile;
    present: boolean;
  } = await snapshot(
    paths.archives,
    isArchivedSnapshot,
    createEmptyArchivedChatsFile,
  );
  const tabsRevision = persistedFileRevision(tabs);
  const archiveRevision = persistedFileRevision(archives);
  const ordered = Array.from(records.keys()).sort((a, b) => a - b);
  // An absent file carries no revision claim, so only present snapshots set
  // where the retained journal chain must begin.
  const presentRevisions = [
    ...(tabsPresent ? [tabsRevision] : []),
    ...(archivesPresent ? [archiveRevision] : []),
  ];
  let expected =
    (presentRevisions.length ? Math.min(...presentRevisions) : 0) + 1;
  let gap: { expected: number; found?: number } | undefined;
  for (const revision of ordered) {
    if (revision < expected) continue;
    if (revision !== expected) gap ??= { expected, found: revision };
    expected = revision + 1;
  }
  // v1 checkpoints wrote both snapshots at one revision and compacted the
  // journal only above the older backup pair, so a component that fell
  // behind (a crash between the two renames or a recovered backup) is
  // normally bridged by retained records. Only two present snapshots can
  // diverge.
  const newestRevision = Math.max(tabsRevision, archiveRevision);
  const staleComponent: LegacyChatRevisionGapRecovery['staleComponent'] =
    tabsPresent && archivesPresent && tabsRevision !== archiveRevision
      ? tabsRevision < archiveRevision
        ? 'tabs'
        : 'archives'
      : 'journal';
  if (!gap && staleComponent !== 'journal' && expected <= newestRevision)
    gap = { expected };
  // A revision gap is recoverable without guessing: each snapshot is
  // internally consistent at its own revision, and every retained record is
  // replayed only to the component it postdates. Where the two snapshots
  // disagree about a chat, the newer component wins (restored chats stay
  // live, chats archived in the hole stay archived); a chat present in either
  // file is kept. The complete source is retained as evidence below.
  const recovering = gap !== undefined;
  const archivedIds = new Set(archives.archived.map((entry) => entry.tab.id));
  const tabsBase: ChatTabsFile =
    recovering && staleComponent === 'tabs'
      ? {
          ...tabs,
          tabs: tabs.tabs.filter((tab) => !archivedIds.has(tab.id)),
        }
      : tabs;
  const repaired = repairLegacySnapshots(
    normalizeLegacyChatTabsFile(tabsBase),
    {
      ...archives,
      archived: archives.archived.map((entry) => ({
        ...entry,
        tab: normalizeLegacyPersistedChatTab(entry.tab),
      })),
    },
  );
  let state: CanonicalChatState = {
    tabsFile: repaired.tabsFile,
    archivesFile: repaired.archivesFile,
    runtimeByChatId: {},
  };
  for (const tab of state.tabsFile.tabs) {
    if (tab.kind === 'file') continue;
    const last = await input.messages(tab.messages).last();
    state.runtimeByChatId[tab.id] = {
      status: 'idle',
      queuedMessageIds: [],
      turn: serializeChatTurnState(initialChatTurnState()),
      ...(last ? { lastActivityAt: last.timestamp } : {}),
    };
  }
  let skippedMutationCount = 0;
  if (recovering) {
    // The original bytes of every snapshot, backup and journal survive the
    // legacy family cleanup, so anything the hole made unrecoverable here can
    // still be inspected.
    for (const path of [paths.tabs, paths.archives, paths.journal])
      for (const file of [path, path + '.bak']) {
        try {
          await stat(file);
          evidence.add(file);
        } catch (error) {
          if (!(isErrnoException(error) && error.code === 'ENOENT'))
            throw error;
        }
      }
  }
  const readRecord = async (revision: number): Promise<ChatJournalRecord> => {
    const descriptor = records.get(revision);
    if (!descriptor) throw new Error('Missing legacy journal record location');
    const value = await input.snapshot(paths.journal, descriptor.location);
    if (
      !isChatJournalRecord(value) ||
      input.fingerprint(value) !== descriptor.fingerprint
    )
      throw new Error('Legacy journal changed during migration');
    return value;
  };
  // Lifecycle selection follows revision order, including records already
  // represented by snapshots. It fences stale runtime patches after deletion.
  for (const event of lifecycleEvents.sort(
    (a, b) => a.revision - b.revision || a.index - b.index,
  )) {
    const prior = lifecycle.get(event.id);
    if (event.type === 'tab.removed' || !prior || prior.type === 'tab.removed')
      lifecycle.set(event.id, event);
  }
  for (const revision of ordered) {
    const record = await readRecord(revision);
    retain(mutationIds, record.mutationId, 4096);
    if (record.commandResult) {
      receipts.delete(record.commandResult.commandId);
      receipts.set(record.commandResult.commandId, record.commandResult);
      while (receipts.size > 256) {
        const oldest = receipts.keys().next().value;
        if (oldest === undefined) break;
        receipts.delete(oldest);
      }
    }
    for (const mutation of record.mutations) {
      if (mutation.type === 'tab.removed')
        retain(removedTabIds, mutation.tabId, 1024);
      if (mutation.type === 'archive.removed')
        retain(removedArchiveEntryIds, mutation.archiveEntryId, 1024);
      if (mutation.type === 'message.removed') {
        retain(removedMessageIds, mutation.messageId, 1024);
        retain(
          removedMessageKeys,
          JSON.stringify([mutation.chatId, mutation.messageId]),
          1024,
        );
      }
      if (mutation.type === 'messages.replaced')
        for (const id of mutation.removedMessageIds) {
          retain(removedMessageIds, id, 1024);
          retain(
            removedMessageKeys,
            JSON.stringify([mutation.chatId, id]),
            1024,
          );
        }
    }
    for (const [index, mutation] of Array.from(record.mutations.entries())) {
      if (mutation.type === 'runtime.patched') {
        const boundary = lifecycle.get(mutation.chatId);
        if (
          boundary
            ? boundary.type === 'tab.removed' ||
              revision < boundary.revision ||
              (revision === boundary.revision && index <= boundary.index)
            : !state.tabsFile.tabs.some((tab) => tab.id === mutation.chatId)
        )
          continue;
      } else if (
        revision <=
        (mutation.type.startsWith('archive.') ? archiveRevision : tabsRevision)
      )
        continue;
      if (
        mutation.type === 'message.upserted' ||
        mutation.type === 'message.removed'
      ) {
        const tab = state.tabsFile.tabs.find(
          (tab) => tab.id === mutation.chatId,
        );
        if (!tab) {
          // Across a revision gap the chat may have been created in the hole.
          if (recovering) {
            skippedMutationCount += 1;
            continue;
          }
          throw new Error(`Message targets unknown chat ${mutation.chatId}`);
        }
        const list = input.messages(tab.messages);
        if (mutation.type === 'message.upserted')
          await list.upsert(mutation.message);
        else list.remove(mutation.messageId);
      } else {
        const messages = transcriptArray(mutation);
        if (messages && input.messages(messages).duplicateIds)
          throw new Error('Duplicate message ids in legacy journal mutation');
        try {
          state = applyMutation(state, mutation);
        } catch (error) {
          // A retained mutation whose context fell into the hole (an unknown
          // tab, an order that omits a chat) cannot apply; the recovered
          // state keeps its last consistent value for that entity.
          if (!(recovering && error instanceof ChatStateInvariantError))
            throw error;
          skippedMutationCount += 1;
        }
      }
    }
    validateCanonicalChatState(state);
  }
  for (const tab of state.tabsFile.tabs)
    await normalizeMigrationTab(input, tab);
  for (const entry of state.archivesFile.archived)
    await normalizeMigrationTab(input, entry.tab);
  for (const [chatId, runtime] of Object.entries(state.runtimeByChatId)) {
    const turn = hydrateChatTurnState(runtime.turn) ?? initialChatTurnState();
    state = applyMutation(state, {
      type: 'runtime.patched',
      chatId,
      runtime: { ...runtime, turn: serializeChatTurnState(turn) },
    });
  }
  validateCanonicalChatState(state);
  const interrupted = new Set<string>();
  const interruptedRuntimes = new Map<string, ChatRuntimeState>();
  const completedAt = Date.now();
  // Admission guarantees that no provider owns this scope. Runtime left in a
  // v1 journal belongs to a process that ended before this cold load.
  for (const [chatId, runtime] of Object.entries(state.runtimeByChatId)) {
    if (
      ![
        'queued',
        'starting',
        'streaming',
        'awaiting_input',
        'completing',
      ].includes(runtime.status) &&
      !runtime.queuedMessageIds.length &&
      !hasOpenPersistedChatTurn(runtime.turn)
    )
      continue;
    interrupted.add(chatId);
    interruptedRuntimes.set(chatId, runtime);
    const tab = state.tabsFile.tabs.find(
      (candidate) => candidate.id === chatId,
    );
    // Evidence drops transcript text, so the answer is classified on the
    // original rows as they stream past, within the orphan's own turn.
    const answer = new SettlementAnswerTracker(
      runtime.activeTurn?.userMessageId ??
        hydrateChatTurnState(runtime.turn)?.current?.userMessageId,
    );
    const evidence = tab
      ? await collectPersistedSettlementEvidence(
          input.messages(tab.messages).iterate(),
          completedAt,
          answer,
        )
      : [];
    const settlement = await buildPersistedTurnSettlement(
      chatId,
      evidence,
      runtime,
      completedAt,
      [],
      tab,
      {
        endsInAnswer: answer.endsInAnswer,
        pendingQuestion: (state.tabsFile.pendingQuestions ?? []).some(
          (question) =>
            question.chatId === chatId && question.delivery !== 'async',
        ),
        terminalActive:
          tab?.claudeTerminal !== undefined &&
          ['running', 'starting'].includes(tab.claudeTerminal.turnState),
        // Loaded on demand: only a turn that otherwise completed reads the
        // registry, and the migration graph stays free of it until then.
        hasShutdownRecord: async (userMessageId) =>
          (
            await import('./usage-limited-chats-registry')
          ).hasShutdownRecordForTurn(chatId, userMessageId),
      },
    );
    for (const mutation of settlement.mutations)
      if (mutation.type !== 'message.upserted')
        state = applyMutation(state, mutation);
  }
  const revision =
    Math.max(tabsRevision, archiveRevision, maxJournalRevision) +
    (interrupted.size ? 1 : 0);
  const {
    tabs: _tabs,
    version: _version,
    revision: _revision,
    ...index
  } = state.tabsFile;
  void _tabs;
  void _version;
  void _revision;
  return {
    revision,
    ...(gap
      ? {
          revisionGapRecovery: {
            expectedRevision: gap.expected,
            ...(gap.found !== undefined ? { foundRevision: gap.found } : {}),
            newestRevision,
            tabsRevision,
            archiveRevision,
            staleComponent,
            skippedMutationCount,
          },
        }
      : {}),
    evidence: Array.from(evidence),
    // The journal has no backup fallback, so migration never reads its .bak;
    // a snapshot copy set aside for a newer one is read but not used. Keep a
    // verified copy of each before legacy cleanup may remove it.
    optionalEvidence: [
      ...superseded,
      ...((await exists(`${paths.journal}.bak`))
        ? [`${paths.journal}.bak`]
        : []),
    ],
    consumedSources: [
      ...consumed,
      ...((await exists(paths.journal)) ? [paths.journal] : []),
    ],
    assertUnchanged: async (): Promise<void> => {
      const current = await fingerprints();
      if (
        current.length !== sourceFingerprints.length ||
        current.some((value, index) => value !== sourceFingerprints[index])
      )
        throw new Error('Legacy source changed during migration');
    },
    index: { ...index, runtimeByChatId: state.runtimeByChatId },
    recovery: {
      receipts: Array.from(receipts.values()),
      mutationIds: Array.from(mutationIds),
      removedTabIds: Array.from(removedTabIds),
      removedArchiveEntryIds: Array.from(removedArchiveEntryIds),
      removedMessageIds: Array.from(removedMessageIds),
      ...(removedMessageKeys.size > 0
        ? { removedMessageKeys: Array.from(removedMessageKeys) }
        : {}),
    },
    chats: iterateAsync(
      (function* (): Generator<ChatMigrationEntry> {
        for (const tab of state.tabsFile.tabs) {
          const { messages, ...metadata } = tab;
          const rows = (): AsyncGenerator<PersistedChatMessage> =>
            input.messages(messages).iterate();
          yield {
            metadata,
            messages: interrupted.has(tab.id)
              ? settlePersistedInterruptedStream(
                  rows,
                  completedAt,
                  interruptedRuntimes.get(tab.id),
                )
              : rows(),
          };
        }
        for (const entry of state.archivesFile.archived) {
          const { tab, ...archive } = entry;
          const { messages, ...metadata } = tab;
          yield {
            metadata,
            archive,
            messages: input.messages(messages).iterate(),
          };
        }
      })(),
    ),
  };
}

function transcriptArray(
  mutation: ChatCoreMutation,
): ChatTabsFile['tabs'][number]['messages'] | undefined {
  if (mutation.type === 'tab.created') return mutation.tab.messages;
  if (mutation.type === 'archive.upserted') return mutation.entry.tab.messages;
  if (mutation.type === 'messages.replaced') return mutation.messages;
  return undefined;
}

/** Caller owns scope admission for the duration; no v1 snapshot is rewritten. */
export async function migrateLegacyChatScope(
  store: ChatStorageV2,
  paths: LegacyChatScopePaths,
  options: { retainLegacy?: boolean } = {},
): Promise<LegacyChatMigrationReport> {
  let scratch: string | undefined;
  let input: LegacyChatInput | undefined;
  let revisionGapRecovery: LegacyChatRevisionGapRecovery | undefined;
  try {
    await store.migrate(
      async () => {
        await mkdir(dirname(dirname(paths.tabs)), { recursive: true });
        scratch = await mkdtemp(
          join(dirname(dirname(paths.tabs)), '.chat-migration-'),
        );
        input = await LegacyChatInput.create(scratch);
        const source = await loadLegacyChatMigrationSource(input, paths);
        revisionGapRecovery = source.revisionGapRecovery;
        return source;
      },
      undefined,
      options,
    );
    return revisionGapRecovery ? { revisionGapRecovery } : {};
  } finally {
    await input?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

import { readMcpActivationRecord } from '@canopy/protocol/mcp-servers';
import {
  CANOPY_STREAM_DEFINITIONS,
  type CanopyErrorPayload,
  type CanopyStreamCursor,
  type CanopyStreamItem,
} from '@canopy/protocol/canopy-core';
import type {
  ChatStateChangedEvent,
  ChatStateCommandPort,
  ChatTabMetadataPatch,
  PersistedChatMessage,
  PersistedChatBlock,
} from '@canopy/desktop-shared/types';
import type {
  CanopyDispatcherStreamHandlerMap,
  CanopyHandlerContext,
} from '@canopy/core-runtime';
import { projectChatRuntime } from '../services/chat-state-projection';
import type { ChatEventReplayLog } from './chat-event-replay-log';
import { unservedRevision } from './core-chat-read-adapter';

const LIVE_WINDOW = 128;
const MAX_CURSOR_ALIASES = 128;
type EventsHandler = Pick<
  CanopyDispatcherStreamHandlerMap<typeof CANOPY_STREAM_DEFINITIONS>,
  'core.chat.events'
>;

function withoutField<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const portable = { ...value };
  Reflect.deleteProperty(portable, key);
  return portable;
}

function projectBlock(block: PersistedChatBlock): object | null {
  if (block.type === 'mcp_activation') {
    const record = readMcpActivationRecord(block.record);
    return record ? { type: 'mcp_activation', record } : null;
  }
  if (block.type === 'image') return withoutField(block, 'path');
  if (block.type === 'file_references')
    return {
      ...block,
      references: block.references.map((reference) =>
        withoutField(withoutField(reference, 'absolutePath'), 'displayPath'),
      ),
    };
  if (block.type === 'compaction_info')
    return withoutField(block, 'transcriptPath');
  if (block.type === 'revert_info')
    return withoutField(block, 'attachmentPath');
  return block;
}

// Allowlist: host-neutral scalar tab metadata. Other tab fields can carry host
// paths or host-only state (approval rules, stale-session file references).
const PORTABLE_TAB_FIELDS = [
  'title',
  'customTitle',
  'description',
  'fileViewMode',
  'pinned',
  'planMode',
  'approvalMode',
  'thinkingLevel',
  'model',
  'modelSelectionMode',
  'modelExplicitlyChosen',
  'providerType',
  'codexFastModeEnabled',
  'modelConfig',
  'interfaceMode',
  'unread',
  'hasOutstandingProposal',
  'latestRevisionNumber',
  'proposalMode',
  'trackedPlanId',
  'trackedPlanReviewStatus',
  'autoArchive',
  'lastAcceptedUserMessageId',
] as const satisfies readonly (keyof ChatTabMetadataPatch)[];

function pickPortableTabFields(
  value: Partial<Record<(typeof PORTABLE_TAB_FIELDS)[number], unknown>>,
): Record<string, unknown> {
  const portable: Record<string, unknown> = {};
  for (const key of PORTABLE_TAB_FIELDS)
    if (Object.prototype.hasOwnProperty.call(value, key))
      portable[key] = value[key];
  return portable;
}

function projectMessage(
  message: PersistedChatMessage,
): Omit<PersistedChatMessage, 'blocks'> & { blocks: object[] } {
  const projected = { ...message };
  delete projected.attachmentPaths;
  delete projected.attachmentPromptContexts;
  // Hidden messages are host-only orchestration input; keep identity, drop content.
  if (message.hidden) return { ...projected, blocks: [] };
  return {
    ...projected,
    blocks: message.blocks.flatMap((block) => {
      const portable = projectBlock(block);
      return portable ? [portable] : [];
    }),
  };
}

function projectEvent(event: ChatStateChangedEvent): object {
  return {
    ...event,
    changes: event.changes.map((change) => {
      // Already portable; no host-path projection or synthetic message.
      if (change.type === 'delegation.card_state_updated') return change;
      if (change.type === 'tab.upserted')
        return {
          ...change,
          tab: {
            ...pickPortableTabFields(change.tab),
            id: change.tab.id,
            title: change.tab.title,
            createdAt: change.tab.createdAt,
            ...(change.tab.kind === undefined ? {} : { kind: change.tab.kind }),
            messages: change.tab.messages.map(projectMessage),
          },
        };
      if (change.type === 'tab.metadata_patched')
        return { ...change, patch: pickPortableTabFields(change.patch) };
      if (change.type === 'message.upserted')
        return { ...change, message: projectMessage(change.message) };
      if (change.type === 'messages.replaced')
        return {
          ...change,
          messages: change.messages.map(projectMessage),
        };
      if (change.type === 'runtime.patched') {
        const runtime = projectChatRuntime(change.runtime);
        delete runtime.queuedMessages;
        delete runtime.turn;
        return { ...change, runtime };
      }
      return change;
    }),
  };
}

const OPEN_SNAPSHOT_MESSAGE =
  'Read a chat snapshot before reopening the event stream.';
const LIVE_SNAPSHOT_MESSAGE =
  'The chat event stream lost its place. Read a chat snapshot.';

function snapshotRequired(message: string): CanopyErrorPayload {
  return {
    kind: 'failed_precondition',
    code: 'core.chat.snapshotRequired',
    message,
    retry: { kind: 'after_refresh', resource: 'core.chat.snapshot.get' },
  };
}

export function createCoreChatEventsAdapter(
  getPort: () => ChatStateCommandPort | null,
  // Runs before emit so synchronous (onFrame) consumers can resolve the event;
  // the returned callback receives the assigned cursor, or null if not emitted.
  captureEvent: (
    event: ChatStateChangedEvent,
    context: CanopyHandlerContext,
  ) => ((cursor: CanopyStreamCursor | null) => void) | void,
  replay: ChatEventReplayLog,
): { handlers: EventsHandler; closeLegacy: () => void } {
  const history: Array<{
    cursors: Array<{
      daemonEpoch: string;
      sequence: number;
      scopeKey: string;
    }>;
    event: ChatStateChangedEvent;
  }> = [];
  let active = 0;
  let legacyActiveUnsubscribe: (() => void) | undefined;
  let legacyStrandedUnsubscribe: (() => void) | undefined;
  let legacyClosed = false;
  const legacyBacklog: ChatStateChangedEvent[] = [];
  const portable = new WeakMap<
    ChatStateChangedEvent,
    CanopyStreamItem<'core.chat.events'> | null
  >();
  const portableItem = (
    event: ChatStateChangedEvent,
  ): CanopyStreamItem<'core.chat.events'> | null => {
    const memo = portable.get(event);
    if (memo !== undefined) return memo;
    const parsed = CANOPY_STREAM_DEFINITIONS['core.chat.events'].item.safeParse(
      projectEvent(event),
    );
    const item = parsed.success ? parsed.data : null;
    portable.set(event, item);
    return item;
  };
  const openScoped = (
    scope: { projectId: string; worktreeId: string },
    cursor: CanopyStreamCursor | null,
    sink: Parameters<EventsHandler['core.chat.events']>[2],
  ): Promise<() => void> => {
    if (!replay.attach()) throw new Error('Chat state service is unavailable.');
    const resumed = replay.resume(scope, cursor);
    if (resumed.kind === 'snapshot_required') {
      sink.end('error', snapshotRequired(OPEN_SNAPSHOT_MESSAGE));
      return Promise.resolve((): void => undefined);
    }
    const epoch = resumed.epoch;
    let position = cursor ? cursor.sequence : null;
    let ended = false;
    let unlisten = (): void => undefined;
    const endLost = (): void => {
      if (ended) return;
      ended = true;
      unlisten();
      sink.end('error', snapshotRequired(LIVE_SNAPSHOT_MESSAGE));
    };
    const deliver = (event: ChatStateChangedEvent): void => {
      if (ended) return;
      if (position !== null && event.revision <= position) return;
      if (position !== null && event.baseRevision > position) return endLost();
      const item = portableItem(event);
      if (!item) return endLost();
      // Before emitting: onFrame runs synchronously and may publish the next batch.
      position = event.revision;
      if (
        sink.emitAt({ daemonEpoch: epoch, sequence: event.revision }, item) ===
        null
      ) {
        ended = true;
        unlisten();
      }
    };
    // Follow before replaying: a batch published from a replayed frame's
    // callback waits behind the replay instead of bypassing this stream.
    let replaying = true;
    const pending: ChatStateChangedEvent[] = [];
    unlisten = replay.follow(scope, {
      event: (event, eventEpoch) => {
        if (eventEpoch !== epoch) endLost();
        else if (replaying) pending.push(event);
        else deliver(event);
      },
      reset: endLost,
    });
    for (const event of resumed.events) deliver(event);
    for (let index = 0; index < pending.length; index += 1)
      deliver(pending[index]);
    replaying = false;
    return Promise.resolve((): void => {
      ended = true;
      unlisten();
    });
  };
  return {
    closeLegacy: (): void => {
      legacyClosed = true;
      legacyActiveUnsubscribe?.();
      legacyStrandedUnsubscribe?.();
      legacyActiveUnsubscribe = undefined;
      legacyStrandedUnsubscribe = undefined;
      legacyBacklog.length = 0;
      if (active === 0) history.length = 0;
    },
    handlers: {
      'core.chat.events': (params, context, sink): Promise<() => void> => {
        // A cloud chat's meters (CAN-6509); desktop advertises no revision.
        if (params.revision !== undefined)
          return Promise.reject(unservedRevision());
        if (params.scope !== 'all')
          return openScoped(params.scope, params.cursor ?? null, sink);
        const port = getPort();
        if (!port) throw new Error('Chat state service is unavailable.');
        const legacy =
          context.caller.clientInstanceId === 'electron-main-chat-push';
        const scopeKey = 'all';
        if (legacy) {
          legacyStrandedUnsubscribe?.();
          legacyStrandedUnsubscribe = undefined;
        }
        active += 1;
        let replaying = true;
        const pending: ChatStateChangedEvent[] = [];
        const deliver = (
          event: ChatStateChangedEvent,
        ): CanopyStreamCursor | null => {
          const item = CANOPY_STREAM_DEFINITIONS['core.chat.events'].item.parse(
            projectEvent(event),
          );
          const settleCapture = captureEvent(event, context);
          const cursor = sink.emit(item, (assignedCursor) => {
            settleCapture?.(assignedCursor);
            const existing = history.find((entry) => entry.event === event);
            if (existing) {
              existing.cursors.push({ ...assignedCursor, scopeKey });
              if (existing.cursors.length > MAX_CURSOR_ALIASES)
                existing.cursors.shift();
            } else {
              history.push({
                cursors: [{ ...assignedCursor, scopeKey }],
                event,
              });
              if (history.length > LIVE_WINDOW) history.shift();
            }
          });
          if (!cursor) settleCapture?.(null);
          return cursor;
        };
        const unsubscribe = port.subscribe((event) => {
          if (!history.some((entry) => entry.event === event)) {
            history.push({ cursors: [], event });
            if (history.length > LIVE_WINDOW) history.shift();
          }
          if (replaying) pending.push(event);
          else if (deliver(event) === null && legacy) legacyBacklog.push(event);
        });
        if (legacy) legacyActiveUnsubscribe = unsubscribe;
        const cursor = params.cursor;
        if (cursor) {
          const index = history.findIndex((entry) =>
            entry.cursors.some(
              (issued) =>
                issued.daemonEpoch === cursor.daemonEpoch &&
                issued.sequence === cursor.sequence &&
                issued.scopeKey === scopeKey,
            ),
          );
          if (index < 0) {
            sink.end('error', snapshotRequired(OPEN_SNAPSHOT_MESSAGE));
          } else {
            for (const entry of history.slice(index + 1)) deliver(entry.event);
          }
        }
        replaying = false;
        const backlog = legacy ? legacyBacklog.splice(0) : [];
        for (const event of [...backlog, ...pending]) {
          if (deliver(event) === null && legacy) legacyBacklog.push(event);
        }
        return Promise.resolve(() => {
          if (legacy && !legacyClosed && !context.signal.aborted) {
            legacyActiveUnsubscribe = undefined;
            legacyStrandedUnsubscribe = unsubscribe;
          } else unsubscribe();
          active -= 1;
          if (active === 0 && !legacyStrandedUnsubscribe) history.length = 0;
        });
      },
    },
  };
}

/** @jest-environment jsdom */
import '../../../cloud-chats/__tests__/jsdom-globals';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { CanopyClientProvider } from '@canopy/app-state/CanopyClientProvider';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
// eslint-disable-next-line no-restricted-imports
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import { DesktopTerminalRuntime } from '@/client/DesktopTerminalRuntime';
import { createTerminalPanel } from '@/lib/panels/panel-creation-actions';
import {
  createDesktopCanopyClient,
  createDesktopCapabilities,
} from '@/client/ipc-canopy-client';
import { cloudCoworkStore } from '@/cloud-chats/cloud-cowork-store';
import { discardDeletedCloudTask } from '@/cloud-chats/cloud-task-deletion';
import { isCloudChatDeleted } from '@/stores/chat/web-core/task-deletions';
import { resetWebCoreServedOperations } from '@/lib/web-core-served-operations';
import { createRelayCoreCoworkInvoker } from '@/cloud-chats/relay-invoker';
import {
  createCloudSidebarTask,
  retryCloudTask,
} from '@/cloud-chats/useCloudCoworkSidebar';
import { webCoreFilePath } from '@/lib/chat-authority';
import { openCoworkWorkEntryFromSidebar } from '@/lib/openCoworkWorkEntryFromSidebar';
import {
  disposeWorktreePanelHydration,
  ensureWorktreePanelLayout,
} from '@/lib/panels/persistence-bridge';
import { setWorkspacePanelLayoutMode } from '@/lib/panels/workspace-layout-mode-actions';
import { panelKindsUnavailableFor } from '@/lib/panels/scope-panel-kinds';
import { listAddablePanels } from '@/lib/panels/registry';
import { webCoreScopeCapabilities } from '@/lib/web-core-scope-capabilities';
import { clearWebCoreModelCatalog } from '@/stores/chat/web-core/model-catalog';
import { refreshChatScopeRevisioned } from '@/stores/chat/slices/revisioned';
import { closeWebCoreChatBackend } from '@/stores/chat/web-core';
import { trackSelectionSave } from '@/stores/chat/web-core/selection-saves';
import { useWebCoreStartingTurnStore } from '@/stores/chat/web-core/starting-turns';
import { liveReplyKey } from '@/stores/chat/web-core/live-replies';
import {
  CLOUD_STOP_RETRY_AFTER_MS,
  presentedCloudStop,
} from '@/stores/chat/cloud-stop';
import { ACTIVITY_SECTIONS } from '@/components/activity/activity-sections';
import {
  CHAT_TAB_SETTINGS_PATCH_KEYS,
  initClaudeModels,
} from '@canopy/desktop-shared/types';
import {
  SERVED_TAB_SETTINGS,
  WINDOW_TAB_SETTINGS,
} from '@/stores/chat/web-core/translate';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { ChatMessageList } from '@/components/chat/ChatMessageList';
import { persistedMessageToPortalMessage } from '@canopy/desktop-shared/portal/persisted-chat-projection';
import { useExperimentalFeaturesStore } from '@/stores/experimentalFeaturesStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { StandaloneChatPage } from '../StandaloneChatPage';
import { DesktopCostCurrencyProvider } from '../../activity/cost/DesktopCostCurrencyProvider';
import { setRendererBillingLaneAvailability } from '@/stores/billingLaneRuntime';
import { ChatQuestionPlayground } from '../ChatQuestionPlayground';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { MessageImages } from '../../chat/MessageImages';
import { useChatEventSubscriptions } from '@/hooks/useChatEventSubscriptions';
import { INSERT_CHAT_TEXT_EVENT } from '@/lib/editorSelectionContext';
import { DISCARD_CHAT_DRAFT_EVENT } from '@/lib/chatDrafts';
import { serializeEditorValue } from '@canopy/ui-rich/editor';
import { Editor, Transforms } from 'slate';
import { cloudAttachmentPath } from '@/cloud-chats/cloud-chat-attachments';
import { CLOUD_ATTACHMENT_MAX_BYTES } from '@canopy/protocol/cloud-attachments';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}
Object.defineProperty(globalThis, 'ResizeObserver', { value: InertObserver });
Object.defineProperty(globalThis, 'IntersectionObserver', {
  value: InertObserver,
});
// jsdom has no font loading, which a file tile waits on to fit its name.
if (!('fonts' in document))
  Object.defineProperty(document, 'fonts', {
    value: { ready: Promise.resolve() },
  });
// jsdom's Blob has no arrayBuffer, which the renderer reads an attachment with.
if (typeof Blob.prototype.arrayBuffer !== 'function')
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    value(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (): void => {
          if (reader.result instanceof ArrayBuffer) resolve(reader.result);
          else reject(new Error('not read as bytes'));
        };
        reader.onerror = (): void => reject(new Error('not read'));
        reader.readAsArrayBuffer(this);
      });
    },
  });
// xterm probes a canvas when the terminal package loads.
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => null,
});

interface BridgeCall {
  readonly path: string;
  readonly args: readonly unknown[];
}

const calls: BridgeCall[] = [];

/** What the window's own reads answer; everything else never replies. */
const REPLIES: Readonly<Record<string, unknown>> = {
  'api.loadPreferences': DEFAULT_PREFERENCES,
  'api.chat.setStateScopes': undefined,
  'api.standaloneChat.list': { chats: [] },
  'api.panelLayout.loadDefaultLayout': { layout: null },
  // Signed in, so the composer takes files.
  'api.loadCanopyCloudAccount': {
    account: { id: 'account-1' },
    credentialSource: 'oauth_desktop',
  },
};

function reply(value: unknown, settles: boolean): unknown {
  const never = (): Promise<never> => new Promise(() => {});
  const settled = Promise.resolve(value);
  return Object.assign(() => {}, {
    then: settles ? settled.then.bind(settled) : never,
    catch: settles ? settled.catch.bind(settled) : never,
    finally: settles ? settled.finally.bind(settled) : never,
  });
}

/** Holds main's upload replies until released, as a slow upload would. */
let uploadGate: Promise<void> | null = null;
/** The files main uploaded to the task's chat, which its list then serves. */
const uploadedAttachments: { name: string; mimeType: string; size: number }[] =
  [];
/** Set to have `core.artifact.list` serve the chat's uploaded attachments. */
let servesAttachmentList = false;

/** Main's upload takes every file the web core would; its answer names it. */
function uploadReply(_target: unknown, file: unknown): unknown {
  const { name, mimeType, bytes } = file as {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  };
  uploadedAttachments.push({ name, mimeType, size: bytes.byteLength });
  return {
    ok: true,
    attachmentId: `att-${name}`,
    attachment: {
      attachmentId: `att-${name}`,
      filename: name,
      mediaType: mimeType,
      size: bytes.byteLength,
      contentSha256: '0'.repeat(64),
      storageKind: 'blob',
      source: 'upload',
    },
  };
}

/** Files picked from this computer's disk, by the path main knows them by. */
const diskPaths = new WeakMap<object, string>();

// Every preload bridge records its calls.
function recordingBridge(path: string): unknown {
  const call = (...args: unknown[]): unknown => {
    calls.push({ path, args });
    // A pasted file, or one dragged from another app, has no path.
    if (path === 'api.getPathForFile') {
      const [file] = args;
      return (
        (typeof file === 'object' && file !== null
          ? diskPaths.get(file)
          : undefined) ?? ''
      );
    }
    if (path === 'api.cloudChats.uploadAttachment')
      // As main answers the web core's not_found for a chat it doesn't hold.
      return uncreated(Reflect.get(Object(args[0]), 'worktreeId'))
        ? Promise.resolve({ ok: false, reason: 'rejected' })
        : Reflect.get(Object(args[1]), 'name') === 'full.md'
          ? // As main answers a refusal the web core explains (CAN-6369).
            Promise.resolve({
              ok: false,
              reason: 'rejected',
              message: 'Attachment storage is full.',
            })
          : (uploadGate ?? Promise.resolve()).then(() =>
              uploadReply(args[0], args[1]),
            );
    return reply(REPLIES[path], path in REPLIES);
  };
  return new Proxy(call, {
    get(_target, key) {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      return recordingBridge(`${path}.${key}`);
    },
  });
}

for (const bridge of [
  'agents',
  'api',
  'appErrors',
  'bundles',
  'canopyClientTransport',
  'collections',
  'electron',
  'installedItems',
  'invocableInventory',
  'mcpServers',
  'pipelines',
  'plugins',
  'skillShareNudge',
  'skillSuggestions',
  'skills',
]) {
  Object.defineProperty(window, bridge, {
    value: recordingBridge(bridge),
    writable: true,
  });
}

const CREATED_AT = '2026-11-10T00:00:00.000Z';

let snapshotReads = 0;
/** The actions each `core.chat.update` asked the web core to apply. */
const chatUpdates: unknown[] = [];
/** The catalog model's thinking levels; null for a model that declares none. */
let cloudModelLevels: string[] | null = ['low', 'medium', 'high'];
/** The chat ids the web core minted tabs under, as `core.chat.create` took them. */
const createdChatIds: string[] = [];
/** The catalog entries the chat has saved, as `core.catalog.selection.get` reads them. */
let savedSelection: string[] = [];
/** MCP servers a test adds to the catalog: id, name, state, availability. */
let extraMcpServers: ReadonlyArray<
  readonly [string, string, string | undefined, string]
> = [];
/** Holds each `core.chat.update` reply until released. */
let updateGate: Promise<void> | null = null;
/** Every method the web core was asked to run, in order. */
const coreRequests: string[] = [];
/** Each request's method and params, for what names a scope. */
const coreRequestLog: { method: string; params: Record<string, unknown> }[] =
  [];
/** Set to make the web core refuse every message send, with an error. */
let sendRefusal: string | null = null;
/** Holds each message send's reply until released. */
let sendGate: Promise<void> | null = null;
/** Set to make the web core answer a turn cancel as for a turn it no longer knows. */
let cancelTurnGone = false;
/** Set to make each send's turn keep running, as `runningTurn`. */
let sendsKeepRunning = false;
/** The task chat's runtime as the snapshot reports it, over `runningTurn`. */
let taskRuntime: Record<string, unknown> | null = null;
/**
 * The prompts Core holds queued behind the task chat's running turn, in
 * order: a send while a turn runs queues there (CAN-6689).
 */
const queuedSends: { text: string; turnId: string; messageId: string }[] = [];
/**
 * The turn Core starts now, which it still lists in the queue, ahead of
 * `queuedSends`, until it runs (CAN-6689).
 */
let startingSend: { text: string; turnId: string; messageId: string } | null =
  null;
/** Set to make a send's receipt name its prompt's Core message id. */
let sendsNameMessage = false;
/**
 * Prompts deleted from the queue, as the web core keeps them: in the
 * transcript, marked cancelled (CAN-6689).
 */
const cancelledPrompts: Record<string, unknown>[] = [];
/** Prompts whose turns Core started, in the transcript in order. */
const startedPrompts: Record<string, unknown>[] = [];
/** Holds each turn cancel reply until released. */
let cancelGate: Promise<void> | null = null;
/** Set to hold each turn cancel until the case answers it from `heldCancels`. */
let holdCancels = false;
/** Each held turn cancel's answer, in the order they were sent. */
const heldCancels: ((reply: unknown) => void)[] = [];
/** As the web core accepts a turn cancel. */
const acceptedCancel = { ok: true, value: {} };
/** As the web core refuses a turn cancel it can't serve now. */
const refusedCancel = {
  ok: false,
  error: {
    kind: 'unavailable',
    message: 'The web core is busy.',
    retry: { kind: 'never' },
  },
};
/**
 * Set to make every message send time out and its receipt unreadable: the
 * window can't tell whether it landed.
 */
let sendOutcomeUnknown = false;
/** Holds each new task's `core.chat.create` until released. */
let createGate: Promise<void> | null = null;
/** Set to make the web core refuse the next new task's create, with an error. */
let createRefusal: string | null = null;
/** The tasks the web core created, by id. */
const createdTasks = new Set<string>();
/** The new tasks a create named, created or not. */
const startedTasks = new Set<string>();
/** As the web core answers a chat it doesn't hold. */
const chatNotFound = {
  ok: false,
  error: {
    kind: 'not_found',
    message: 'The chat was not found.',
    retry: { kind: 'never' },
  },
} as const;
/** Whether `id` names a new task the web core hasn't created. */
const uncreated = (id: unknown): boolean =>
  typeof id === 'string' && startedTasks.has(id) && !createdTasks.has(id);
/**
 * Set to apply the next new task's create at once but lose its reply, which
 * fails once `createGate` lets it.
 */
let loseCreateReply = false;
/**
 * Whether the stub lists projects and tasks, so the cloud cowork store can
 * connect through the relay. Off by default: the cases that seed the store
 * directly must not have the sidebar's own connection replace it.
 */
let servesCoworkLists = false;
/**
 * Set to have the sandbox refuse its files as asleep, with the web core's own
 * reason, until a turn wakes it (CAN-6543).
 */
let sandboxAsleep = false;
/**
 * The not-awake code and wake permission the web core passes on from Core:
 * a session that ended while idle answers SANDBOX_SESSION_EXPIRED, which only
 * a turn restarts (CAN-6654).
 */
let asleepAs: { cloudCode: string; wakeAllowed: boolean } = {
  cloudCode: 'SANDBOX_NOT_READY',
  wakeAllowed: true,
};
/** The task's own chat's running turn, as its snapshot reports it. */
let runningTurn: string | null = null;
/** The paths `worker.filesystem.entry.delete` removed from the sandbox. */
const deletedPaths = new Set<string>();
/** Set while the web core's folder listings still show what a delete removed. */
let listingLags = false;
/** Holds each folder listing's reply until released. */
let listingGate: Promise<void> | null = null;

/** A sandbox read refused as the web core refuses one while the sandbox sleeps. */
function sandboxSleeping(namespace: string): Promise<unknown> {
  return Promise.resolve({
    ok: false,
    error: {
      kind: 'failed_precondition',
      message: 'The sandbox is asleep.',
      code: `${namespace}.invalidState`,
      details: {
        reason: 'sandbox_sleeping',
        wakeAllowed: asleepAs.wakeAllowed,
        cloudCode: asleepAs.cloudCode,
      },
      retry: { kind: 'after_refresh', resource: namespace },
    },
  });
}

/** The cloud scope's capabilities as the desktop client reports them now. */
function cloudScopeCapabilitiesNow(): CanopyCapabilities {
  const capabilities = createDesktopCanopyClient(
    createDesktopCapabilities('darwin', {}, {}),
  ).capabilitiesFor?.('web-core:ws-1');
  if (capabilities === undefined) throw new Error('No scope capabilities.');
  return capabilities;
}

/** Whether the web core's manifest serves a cloud task's cost (CAN-6180). */
let servesCost = false;
/** The day a cloud task's cost is observed from, when its history is partial. */
let costCoverageStart: string | undefined;

const costOperation = (name: string): Record<string, unknown> => ({
  name,
  kind: 'query',
  version: 1,
  placement: 'core-only',
  requiredGrants: ['core.cost.read'],
  available: true,
});

/** A request's scope worktree, under whichever field the method names it. */
function worktreeOf(params: Record<string, unknown> | undefined): unknown {
  const scope = params?.scope;
  return typeof scope === 'object' && scope !== null && 'worktreeId' in scope
    ? scope.worktreeId
    : params?.worktreeId;
}
/** A stream the window opened, and the frames the web core has for it. */
interface OpenedStream {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly frames: unknown[];
  read: ((frame: unknown) => void) | null;
}
const openedStreams = new Map<string, OpenedStream>();
let streamCount = 0;

/** Pushes `frame` to every open `method` stream whose params `matches`. */
function pushFrame(
  method: string,
  matches: (params: Record<string, unknown>) => boolean,
  frame: unknown,
): void {
  for (const stream of openedStreams.values()) {
    if (stream.method !== method || !matches(stream.params)) continue;
    const read = stream.read;
    stream.read = null;
    if (read === null) stream.frames.push(frame);
    else read(frame);
  }
}

/** Tasks deleted on another device: the web core finds none of their chats. */
const deletedTasks = new Set<string>();
/** Chats deleted on another device while their task stays. */
const removedChats = new Set<string>();

/**
 * Deletes one chat of a live task on another device: its task's stream
 * sends `tab.removed` for it, and the web core lists it no more.
 */
function removeChatElsewhere(task: string, chatId: string): void {
  removedChats.add(chatId);
  snapshotRevision += 1;
  pushFrame('core.chat.events', (params) => worktreeOf(params) === task, {
    kind: 'item',
    cursor: { daemonEpoch: 'e1', sequence: snapshotRevision },
    item: {
      schemaVersion: 1,
      eventId: `removed-${chatId}`,
      occurredAt: CREATED_AT,
      projectId: 'ws-1',
      worktreeId: task,
      baseRevision: snapshotRevision - 1,
      revision: snapshotRevision,
      changes: [{ type: 'tab.removed', tabId: chatId }],
    },
  });
}

/**
 * Deletes `task` on another device, as the web core reports it: its event
 * stream sends `tab.removed` for the task's chats, or ends `not_found`
 * (apps/web/src/lib/web-core/chat-events.ts), and the sidebar's stream names
 * the task, so its project is listed again without it.
 */
function deleteTaskElsewhere(
  task: string,
  report: 'tab-removed' | 'not-found',
  /**
   * With `tab-removed`, the chats removed one feed item each, in this order,
   * as production's core.chat.events sends one item per chat batch.
   */
  perChat?: readonly string[],
): void {
  deletedTasks.add(task);
  const follows = (params: Record<string, unknown>): boolean =>
    worktreeOf(params) === task;
  if (report === 'tab-removed' && perChat !== undefined) {
    for (const tabId of perChat) {
      snapshotRevision += 1;
      pushFrame('core.chat.events', follows, {
        kind: 'item',
        cursor: { daemonEpoch: 'e1', sequence: snapshotRevision },
        item: {
          schemaVersion: 1,
          eventId: `deleted-${task}-${tabId}`,
          occurredAt: CREATED_AT,
          projectId: 'ws-1',
          worktreeId: task,
          baseRevision: snapshotRevision - 1,
          revision: snapshotRevision,
          changes: [{ type: 'tab.removed', tabId }],
        },
      });
    }
  } else if (report === 'tab-removed') {
    snapshotRevision += 1;
    pushFrame('core.chat.events', follows, {
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: snapshotRevision },
      item: {
        schemaVersion: 1,
        eventId: `deleted-${task}`,
        occurredAt: CREATED_AT,
        projectId: 'ws-1',
        worktreeId: task,
        baseRevision: snapshotRevision - 1,
        revision: snapshotRevision,
        // The task's own chat goes, and every other chat with it.
        changes: [task, 'chat-2'].map((tabId) => ({
          type: 'tab.removed',
          tabId,
        })),
      },
    });
  } else
    pushFrame('core.chat.events', follows, {
      kind: 'end',
      outcome: 'error',
      error: {
        kind: 'not_found',
        message: 'The task was not found.',
        retry: { kind: 'never' },
      },
    });
  pushFrame('core.chat.task.events', () => true, {
    kind: 'item',
    cursor: { daemonEpoch: 'e1', sequence: snapshotRevision + 100 },
    item: {
      kind: 'task',
      workspaceId: 'ws-1',
      worktreeId: task,
      batchId: `deleted-${task}`,
    },
  });
}

/** The model the snapshot names for the task's own chat. */
let snapshotModel: string | undefined = 'cloud-model';
/** The snapshot's revision, which a change made since moves past. */
let snapshotRevision = 1;
/** Holds each transcript page reply until released. */
let pageGate: Promise<void> | null = null;
/**
 * Holds each task snapshot reply until released. The snapshot is read as the
 * request arrives, so a held reply lands stale.
 */
let snapshotGate: Promise<void> | null = null;
/** Holds the catalog snapshot read until a test releases it. */
let catalogGate: Promise<void> | null = null;
/** Set to make the web core refuse a model change, as its handler does: with an error. */
let setModelRefusal: string | null = null;

/** The entries a `chat.patch_tab_settings` selection names, as the web core saves them. */
function appliedSelection(action: unknown): string[] | undefined {
  if (
    typeof action !== 'object' ||
    action === null ||
    !('patch' in action) ||
    typeof action.patch !== 'object' ||
    action.patch === null ||
    !('pluginSelections' in action.patch)
  )
    return undefined;
  const selections = action.patch.pluginSelections as {
    skillRefs?: { sourceId: string; skillName: string }[];
    mcpServerRefs?: { serverId: string; configId: string }[];
  };
  return [
    ...(selections.skillRefs ?? []).map(
      (ref) => `skill:${ref.sourceId}/${ref.skillName}`,
    ),
    ...(selections.mcpServerRefs ?? []).map(
      (ref) => `mcp:${ref.serverId}/${ref.configId}`,
    ),
  ];
}

/** The model a `chat.set_model` names. */
function modelOf(action: unknown): string | undefined {
  return typeof action === 'object' &&
    action !== null &&
    'type' in action &&
    action.type === 'chat.set_model' &&
    'model' in action &&
    typeof action.model === 'string'
    ? action.model
    : undefined;
}

/** Whether a `chat.patch_tab_settings` renames the chat. */
function renameOf(action: unknown): boolean {
  return (
    typeof action === 'object' &&
    action !== null &&
    'patch' in action &&
    typeof action.patch === 'object' &&
    action.patch !== null &&
    'customTitle' in action.patch
  );
}

/** The web core, as the relay answers a task with one idle chat. */
Object.defineProperty(window, 'canopyCore', {
  writable: true,
  value: {
    invoke: (request: {
      kind: string;
      method?: string;
      params?: Record<string, unknown>;
      subscriptionId?: string;
    }): Promise<unknown> => {
      // Each task's chat is the task itself.
      const scoped = worktreeOf(request.params);
      const task = typeof scoped === 'string' ? scoped : 'wt-1';
      const ok = (value: unknown): Promise<unknown> =>
        Promise.resolve({ ok: true, value });
      const heldSnapshot = (value: unknown): Promise<unknown> => {
        const read = ok(value);
        return snapshotGate === null ? read : snapshotGate.then(() => read);
      };
      if (request.kind === 'openStream') {
        streamCount += 1;
        const subscriptionId = `s${streamCount}`;
        openedStreams.set(subscriptionId, {
          method: request.method ?? '',
          params: request.params ?? {},
          frames: [],
          read: null,
        });
        return ok({ subscriptionId });
      }
      // A stream reads what the web core pushed to it, and waits otherwise.
      if (request.kind === 'readStream') {
        const stream = openedStreams.get(request.subscriptionId ?? '');
        if (stream === undefined) return new Promise(() => {});
        if (stream.frames.length > 0) return ok(stream.frames.shift());
        return new Promise((resolve) => {
          stream.read = (frame): void => resolve({ ok: true, value: frame });
        });
      }
      if (request.kind === 'closeStream') {
        openedStreams.delete(request.subscriptionId ?? '');
        return ok(null);
      }
      if (request.method !== undefined) {
        coreRequests.push(request.method);
        coreRequestLog.push({
          method: request.method,
          params: request.params ?? {},
        });
      }
      const newTask = worktreeOf(request.params);
      // A deleted task's chats are gone, as the web core answers them.
      if (
        deletedTasks.has(task) &&
        [
          'core.chat.snapshot.get',
          'core.chat.list',
          'core.chat.transcript.page',
          'core.chat.create',
          'core.chat.update',
          'core.chat.message.send',
          'core.catalog.selection.get',
        ].includes(request.method ?? '')
      )
        return Promise.resolve({
          ok: false,
          error: {
            kind: 'not_found',
            message: 'The task was not found.',
            retry: { kind: 'never' },
          },
        });
      if (
        !servesCoworkLists &&
        (request.method === 'core.workspace.list' ||
          request.method === 'core.chat.task.list')
      )
        return Promise.resolve({
          ok: false,
          error: {
            kind: 'capability_unavailable',
            message: 'Not served here.',
            retry: { kind: 'never' },
          },
        });
      if (servesCost && request.method === 'core.runtime.manifest.get')
        return ok({
          runtime: {
            runtimeId: 'web-core',
            hostId: 'web',
            authorityId: null,
            profile: 'core',
            daemonEpoch: 'e1',
            protocolVersions: [1],
            state: 'ready',
          },
          operations: [
            costOperation('core.cost.scope.get'),
            costOperation('core.cost.chat.get'),
          ],
          generatedAt: CREATED_AT,
        });
      if (servesCost && request.method === 'core.cost.scope.get') {
        const totals = {
          usd: 0.45,
          bySource: {
            chat: 0.45,
            pipeline: 0,
            subagents: 0,
            delegations: 0,
            background: 0,
          },
          byBilling: {
            subscription: 0,
            ai_credits: 0.45,
            account_proxy: 0,
            api_key: 0,
            org_gateway: 0,
            local: 0,
            unknown: 0,
          },
          tokens: {
            input: 1200,
            output: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            reasoningOutputTokens: 0,
          },
          notPricedCount: 0,
          hasEstimate: false,
        };
        return ok({
          scope: request.params?.scope,
          updatedAt: CREATED_AT,
          building: false,
          retentionDays: 90,
          ...(costCoverageStart === undefined
            ? {}
            : { coverageStart: costCoverageStart }),
          totals,
          chats:
            costCoverageStart === undefined
              ? []
              : [
                  {
                    chatId: 'wt-1',
                    label: 'Plan the launch',
                    state: 'open',
                    totals,
                    turnCount: 3,
                    lastActivityAt: CREATED_AT,
                    running: false,
                    models: [],
                    coverageStart: costCoverageStart,
                  },
                ],
          pipelineRuns: [],
          hasCodexEstimate: false,
        });
      }
      switch (request.method) {
        case 'core.workspace.list':
          return ok({
            items: [
              {
                workspaceId: 'ws-1',
                name: 'Cloud research',
                kind: 'cowork',
                ownerOrganizationId: null,
                revision: 1,
                repositorySources: [],
                settings: {},
              },
            ],
            nextCursor: null,
          });
        case 'core.chat.task.list':
          return ok({
            items: [
              ...[...createdTasks].map((worktreeId) => ({
                workspaceId: 'ws-1',
                worktreeId,
                title: '',
                state: 'idle',
                updatedAt: CREATED_AT,
                revision: 1,
              })),
              ...(deletedTasks.has('wt-1')
                ? []
                : [
                    {
                      workspaceId: 'ws-1',
                      worktreeId: 'wt-1',
                      title: 'Draft the brief',
                      state: 'idle',
                      updatedAt: CREATED_AT,
                      revision: 1,
                    },
                  ]),
            ],
            nextCursor: null,
          });
        case 'core.chat.snapshot.get':
          snapshotReads += 1;
          // A task the web core created since: its own chat, idle.
          if (typeof newTask === 'string' && createdTasks.has(newTask))
            return ok({
              workspaceId: 'ws-1',
              worktreeId: newTask,
              revision: 1,
              eventsCursor: { daemonEpoch: 'e1', sequence: 1 },
              tabs: {
                activeTabId: newTask,
                items: [
                  {
                    chatId: newTask,
                    title: '',
                    kind: 'chat',
                    createdAt: CREATED_AT,
                  },
                ],
              },
              archives: [],
              runtimeByChatId: {
                [newTask]: { status: 'idle', queuedMessageIds: [] },
              },
              queue: [],
            });
          return heldSnapshot({
            workspaceId: 'ws-1',
            worktreeId: task,
            revision: snapshotRevision,
            eventsCursor: { daemonEpoch: 'e1', sequence: snapshotRevision },
            tabs: {
              activeTabId: task,
              items: [
                {
                  chatId: task,
                  title: 'Brief',
                  kind: 'chat',
                  createdAt: CREATED_AT,
                  ...(snapshotModel === undefined
                    ? {}
                    : { modelId: snapshotModel }),
                },
                ...(removedChats.has('chat-2')
                  ? []
                  : [
                      {
                        chatId: 'chat-2',
                        title: 'Notes',
                        kind: 'chat',
                        createdAt: CREATED_AT,
                      },
                    ]),
              ],
            },
            archives: [],
            runtimeByChatId: {
              [task]:
                taskRuntime ??
                (runningTurn === null
                  ? { status: 'idle', queuedMessageIds: [] }
                  : {
                      status: 'streaming',
                      activeTurnId: runningTurn,
                      queuedMessageIds: queuedSends.map(
                        (each) => each.messageId,
                      ),
                    }),
              'chat-2': { status: 'idle', queuedMessageIds: [] },
            },
            queue:
              startingSend === null && queuedSends.length === 0
                ? []
                : [
                    {
                      chatId: task,
                      stateVersion: String(snapshotRevision),
                      sessionId: 'session-1',
                      entries: [
                        ...(startingSend === null ? [] : [startingSend]),
                        ...queuedSends,
                      ].map((each, index) => ({
                        id: each.turnId,
                        origin: 'desktop',
                        enqueuedAtMs: 4_000 + index,
                        revision: 1,
                        text: each.text,
                        messageId: each.messageId,
                        queueOrder: String(index + 1),
                        promptSource: 'human',
                      })),
                    },
                  ],
          });
        case 'core.chat.transcript.page': {
          const page = ok({
            messages: [...startedPrompts, ...cancelledPrompts],
            totalMessages: startedPrompts.length + cancelledPrompts.length,
            transcriptRevision: 1,
          });
          return (pageGate ?? Promise.resolve()).then(() => page);
        }
        case 'core.catalog.snapshot.get': {
          const snapshot = ok({
            revision: 1,
            generatedAt: CREATED_AT,
            entries: [
              {
                entryId: 'model:cloud-model',
                kind: 'model',
                name: 'Cloud model',
                description: '',
                source: 'remote',
                content: {
                  kind: 'model',
                  providerId: 'claude',
                  modelName: 'cloud-model',
                  contextWindow: 200_000,
                  capabilities: [],
                  ...(cloudModelLevels === null
                    ? {}
                    : { thinkingLevels: cloudModelLevels }),
                  fastMode: true,
                },
                availability: 'available',
                revision: 0,
                createdAt: CREATED_AT,
                updatedAt: CREATED_AT,
              },
              {
                entryId: 'model:second-model',
                kind: 'model',
                name: 'Second model',
                description: '',
                source: 'remote',
                content: {
                  kind: 'model',
                  providerId: 'claude',
                  modelName: 'second-model',
                  contextWindow: 200_000,
                  capabilities: [],
                },
                availability: 'available',
                revision: 0,
                createdAt: CREATED_AT,
                updatedAt: CREATED_AT,
              },
              {
                entryId: 'skill:curated/review',
                kind: 'skill',
                name: 'Review',
                description: 'Reviews a change',
                source: 'remote',
                content: {
                  kind: 'skill',
                  entrypoint: null,
                  selectionRef: { sourceId: 'curated', skillName: 'review' },
                },
                availability: 'available',
                revision: 0,
                createdAt: CREATED_AT,
                updatedAt: CREATED_AT,
              },
              {
                entryId: 'mcp:linear/default',
                kind: 'mcp_server',
                name: 'Linear',
                description: '',
                source: 'remote',
                content: {
                  kind: 'mcp_server',
                  transport: 'http',
                  commandRef: null,
                  url: null,
                  authIntegrationId: null,
                  connectionState: 'connected',
                  selectionRef: { serverId: 'linear', configId: 'default' },
                },
                availability: 'available',
                revision: 0,
                createdAt: CREATED_AT,
                updatedAt: CREATED_AT,
              },
              ...extraMcpServers.map(([id, name, state, availability]) => ({
                entryId: `mcp:${id}/default`,
                kind: 'mcp_server',
                name,
                description: '',
                source: 'remote',
                content: {
                  kind: 'mcp_server',
                  transport: 'http',
                  commandRef: null,
                  url: null,
                  authIntegrationId: null,
                  ...(state === undefined ? {} : { connectionState: state }),
                  selectionRef: { serverId: id, configId: 'default' },
                },
                availability,
                revision: 0,
                createdAt: CREATED_AT,
                updatedAt: CREATED_AT,
              })),
            ],
          });
          return (catalogGate ?? Promise.resolve()).then(() => snapshot);
        }
        case 'core.catalog.selection.get':
          if (uncreated(Reflect.get(Object(request.params?.scope), 'chatId')))
            return Promise.resolve(chatNotFound);
          return ok({
            revision: 1,
            selectedItemIds: savedSelection,
            unavailableItemIds: [],
          });
        case 'core.chat.create': {
          const action = request.params?.action;
          const tabId =
            typeof action === 'object' &&
            action !== null &&
            'tabId' in action &&
            typeof action.tabId === 'string'
              ? action.tabId
              : undefined;
          if (tabId !== undefined) createdChatIds.push(tabId);
          const reply = {
            commandId: request.params?.commandId,
            // The web core's lifecycle handlers answer revision 0.
            revision: 0,
            outcome: 'applied',
            ...(tabId === undefined ? {} : { entityId: tabId }),
          };
          // A new task: its own chat is the task (the tab id is its id). The
          // seeded task's own chat, which the store also creates, is not new.
          if (
            tabId === undefined ||
            tabId === 'wt-1' ||
            request.params?.worktreeId !== tabId
          )
            return ok(reply);
          startedTasks.add(tabId);
          if (loseCreateReply) {
            loseCreateReply = false;
            createdTasks.add(tabId);
            return (createGate ?? Promise.resolve()).then(() => ({
              ok: false,
              error: {
                kind: 'unavailable',
                message: 'The reply was lost.',
                retry: { kind: 'same_idempotency_key' },
              },
            }));
          }
          return (createGate ?? Promise.resolve()).then(() => {
            const refusal = createRefusal;
            createRefusal = null;
            if (refusal !== null)
              return {
                ok: false,
                error: {
                  kind: 'failed_precondition',
                  message: refusal,
                  retry: { kind: 'never' },
                },
              };
            createdTasks.add(tabId);
            return { ok: true, value: reply };
          });
        }
        case 'core.chat.update': {
          if (uncreated(worktreeOf(request.params)))
            return Promise.resolve(chatNotFound);
          chatUpdates.push(request.params?.action);
          const action = request.params?.action;
          const refusal = setModelRefusal;
          if (
            refusal !== null &&
            typeof action === 'object' &&
            action !== null &&
            'type' in action &&
            action.type === 'chat.set_model'
          )
            return (updateGate ?? Promise.resolve()).then(() => ({
              ok: false,
              error: {
                kind: 'permission_denied',
                message: refusal,
                retry: { kind: 'never' },
              },
            }));
          return (updateGate ?? Promise.resolve()).then(() => {
            savedSelection =
              appliedSelection(request.params?.action) ?? savedSelection;
            // As the web core applies it: a model change or a rename appends
            // a task feed batch and answers its revision (CAN-6346); a
            // selection save changes nothing the feed follows and answers 0.
            const model = modelOf(action);
            const renamed = renameOf(action);
            if (model !== undefined) snapshotModel = model;
            if (model !== undefined || renamed) snapshotRevision += 1;
            return ok({
              commandId: request.params?.commandId,
              revision: model !== undefined || renamed ? snapshotRevision : 0,
              outcome: 'applied',
            });
          });
        }
        case 'core.chat.message.send': {
          const refusal = sendRefusal;
          if (sendOutcomeUnknown)
            return Promise.resolve({
              ok: false,
              error: {
                kind: 'unavailable',
                message: 'The web core did not answer in time.',
                retry: { kind: 'same_idempotency_key' },
              },
            });
          if (refusal !== null)
            return (sendGate ?? Promise.resolve()).then(() => ({
              ok: false,
              error: {
                kind: 'failed_precondition',
                message: refusal,
                retry: { kind: 'never' },
              },
            }));
          // A send while a turn runs queues behind it (CAN-6689).
          if (runningTurn !== null && sendsKeepRunning) {
            const turnId = `turn-${queuedSends.length + 2}`;
            const messageId = `${turnId}-u`;
            queuedSends.push({
              text: String(request.params?.text),
              turnId,
              messageId,
            });
            const queued = {
              ok: true,
              value: {
                commandId: request.params?.commandId,
                revision: 3,
                outcome: 'applied',
                entityId: turnId,
                messageId,
              },
            };
            return (sendGate ?? Promise.resolve()).then(() => queued);
          }
          if (sendsKeepRunning) runningTurn = 'turn-1';
          const accepted = {
            ok: true,
            value: {
              commandId: request.params?.commandId,
              revision: 3,
              outcome: 'applied',
              entityId: 'turn-1',
              ...(sendsNameMessage ? { messageId: 'turn-1-u' } : {}),
            },
          };
          return (sendGate ?? Promise.resolve()).then(() => accepted);
        }
        // A turn the web core accepts a cancel for keeps running until it
        // ends; one it no longer knows has ended.
        case 'core.chat.turn.cancel':
          if (holdCancels)
            return new Promise((resolve) => {
              heldCancels.push(resolve);
            });
          if (!cancelTurnGone)
            return (cancelGate ?? Promise.resolve()).then(() => ({
              ok: true,
              value: {},
            }));
          runningTurn = null;
          return Promise.resolve(chatNotFound);
        // Core takes a deleted entry off the queue and keeps its prompt,
        // which the web core serves marked cancelled (CAN-6689).
        case 'core.chat.queue.entry.cancel': {
          const entryId = request.params?.entryId;
          const index = queuedSends.findIndex(
            (each) => each.turnId === entryId,
          );
          if (index >= 0) {
            const [deleted] = queuedSends.splice(index, 1);
            if (deleted !== undefined)
              cancelledPrompts.push({
                id: deleted.messageId,
                role: 'user',
                blocks: [{ type: 'text', text: deleted.text }],
                timestamp: Date.now(),
                cancelled: true,
              });
          }
          return ok({
            commandId: request.params?.commandId,
            revision: snapshotRevision,
            outcome: index >= 0 ? 'applied' : 'not_found',
          });
        }
        case 'core.chat.send.receipt':
          return Promise.resolve({
            ok: false,
            error: {
              kind: 'unavailable',
              message: 'The web core did not answer in time.',
              retry: { kind: 'same_request' },
            },
          });
        case 'worker.filesystem.roots.list':
          return ok({
            roots: [
              {
                fileRootId: 'workspace',
                name: 'Workspace',
                kind: 'workspace-root',
              },
            ],
          });
        case 'worker.filesystem.directory.list': {
          if (sandboxAsleep)
            return sandboxSleeping('worker.filesystem.directory');
          // The root holds brief.md and docs/, which holds its own brief.md.
          const entry = (
            relativePath: string,
            kind: 'file' | 'directory',
          ): Record<string, unknown> => ({
            name: relativePath.split('/').pop(),
            relativePath,
            kind,
            isIgnored: false,
            isIndexExcluded: false,
            isSymlink: false,
            hasChildren: kind === 'directory',
          });
          const entries = (
            request.params?.relativePath === 'docs'
              ? [entry('docs/brief.md', 'file')]
              : [entry('docs', 'directory'), entry('brief.md', 'file')]
          ).filter(
            (each) =>
              listingLags ||
              typeof each.relativePath !== 'string' ||
              !deletedPaths.has(each.relativePath),
          );
          return (listingGate ?? Promise.resolve()).then(() => ({
            ok: true,
            value: { entries },
          }));
        }
        case 'worker.filesystem.entry.delete': {
          if (sandboxAsleep) return sandboxSleeping('worker.filesystem.entry');
          const relativePath = request.params?.relativePath;
          if (typeof relativePath === 'string') deletedPaths.add(relativePath);
          return ok({
            deleted: true,
            deletedEntryCount: 1,
            disposition: request.params?.disposition,
          });
        }
        case 'worker.filesystem.file.read':
          return ok({
            fileRootId: 'workspace',
            relativePath: 'brief.md',
            name: 'brief.md',
            contentKind: 'text',
            encoding: 'utf8',
            content: 'Sandbox brief body\n',
            sizeBytes: 19,
            returnedBytes: 19,
            truncated: false,
            modifiedAt: CREATED_AT,
            version: 'v1',
          });
        // docs/brief.md exists, so the sandbox refuses a move onto it.
        case 'worker.filesystem.entry.move':
          return Promise.resolve({
            ok: false,
            error: {
              kind: 'already_exists',
              message: 'The destination already exists.',
              retry: { kind: 'never' },
            },
          });
        case 'core.artifact.list': {
          const owner: unknown = request.params?.owner;
          if (
            !servesAttachmentList ||
            Reflect.get(Object(owner), 'kind') !== 'chat'
          )
            return Promise.resolve({
              ok: false,
              error: {
                kind: 'capability_unavailable',
                message: 'Not served here.',
                retry: { kind: 'never' },
              },
            });
          const chatId = String(Reflect.get(Object(owner), 'id'));
          return ok({
            artifacts: uploadedAttachments.map((file) => ({
              artifactId: `att:${chatId}:att-${file.name}`,
              owner: { kind: 'chat', id: chatId },
              kind: 'attachment',
              name: file.name,
              mediaType: file.mimeType,
              sizeBytes: file.size,
              sha256: '0'.repeat(64),
              createdAt: CREATED_AT,
              availability: 'available',
              transfer: null,
            })),
            nextCursor: null,
          });
        }
        case 'core.chat.list':
          if (typeof newTask === 'string' && createdTasks.has(newTask))
            return ok({
              items: [
                {
                  chatId: newTask,
                  title: '',
                  state: 'idle',
                  workspaceId: 'ws-1',
                  worktreeId: newTask,
                  revision: 1,
                  createdAt: CREATED_AT,
                },
              ],
              nextCursor: null,
            });
          return ok({
            items: [
              {
                chatId: task,
                title: 'Brief',
                state: 'idle',
                workspaceId: 'ws-1',
                worktreeId: task,
                revision: 1,
                createdAt: CREATED_AT,
              },
              ...(removedChats.has('chat-2')
                ? []
                : [
                    {
                      chatId: 'chat-2',
                      title: 'Notes',
                      state: 'idle',
                      workspaceId: 'ws-1',
                      worktreeId: task,
                      revision: 1,
                      createdAt: CREATED_AT,
                    },
                  ]),
            ],
            nextCursor: null,
          });
        default:
          return Promise.resolve({
            ok: false,
            error: {
              kind: 'capability_unavailable',
              message: 'Not served here.',
              retry: { kind: 'never' },
            },
          });
      }
    },
  },
});

let container: HTMLDivElement;
let root: Root;

/** The cloud while it is reachable: one project with one idle task. */
function connectCloud(): void {
  cloudCoworkStore.setState({
    status: 'online',
    projects: [
      {
        key: 'web-core:ws-1',
        workspaceId: 'ws-1',
        name: 'Cloud research',
        kind: 'cowork',
        ownerOrganizationId: null,
      },
    ],
    tasksByProject: {
      'web-core:ws-1': [
        {
          key: 'web-core:ws-1:wt-1',
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          title: 'Draft the brief',
          state: 'idle',
          updatedAt: CREATED_AT,
        },
      ],
    },
  });
}

beforeEach(() => {
  calls.length = 0;
  chatUpdates.length = 0;
  createdChatIds.length = 0;
  startedTasks.clear();
  savedSelection = [];
  extraMcpServers = [];
  catalogGate = null;
  updateGate = null;
  coreRequests.length = 0;
  coreRequestLog.length = 0;
  createGate = null;
  createRefusal = null;
  sendRefusal = null;
  sendGate = null;
  cancelTurnGone = false;
  sendsKeepRunning = false;
  taskRuntime = null;
  cancelGate = null;
  holdCancels = false;
  heldCancels.length = 0;
  sendOutcomeUnknown = false;
  createdTasks.clear();
  loseCreateReply = false;
  servesCoworkLists = false;
  servesCost = false;
  costCoverageStart = undefined;
  resetWebCoreServedOperations();
  setRendererBillingLaneAvailability({
    claudeNativeAuth: undefined,
    codexNativeAuth: undefined,
    creditsEligible: undefined,
  });
  snapshotModel = 'cloud-model';
  snapshotRevision = 1;
  pageGate = null;
  snapshotGate = null;
  setModelRefusal = null;
  cloudModelLevels = ['low', 'medium', 'high'];
  openedStreams.clear();
  deletedTasks.clear();
  removedChats.clear();
  sandboxAsleep = false;
  asleepAs = { cloudCode: 'SANDBOX_NOT_READY', wakeAllowed: true };
  runningTurn = null;
  queuedSends.length = 0;
  startingSend = null;
  sendsNameMessage = false;
  cancelledPrompts.length = 0;
  startedPrompts.length = 0;
  deletedPaths.clear();
  uploadedAttachments.length = 0;
  servesAttachmentList = false;
  listingLags = false;
  listingGate = null;
  // Each case reads the catalog its own stub serves, and starts the web core
  // backend afresh, as a reconnect does: the stub's revisions restart.
  clearWebCoreModelCatalog();
  closeWebCoreChatBackend();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  connectCloud();
  useExperimentalFeaturesStore.setState({ hydrated: true });
  useFeatureFlagsStore.setState({
    isEnabled: (key) =>
      key === CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key,
  });
  // The window's own cold start is not what these cases open.
  useStandaloneChatStore.setState({
    initialized: true,
    chatProjectsLoaded: true,
  });
});

afterEach(() => {
  jest.useRealTimers();
  act(() => root.unmount());
  container.remove();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

/** The window's chat event subscriptions, which deliver pushed changes. */
function ChatEventSubscriptions(): null {
  useChatEventSubscriptions();
  return null;
}

function renderPage(options?: { readonly followsEvents?: boolean }): void {
  const client = createDesktopCanopyClient(
    createDesktopCapabilities('darwin', {}, {}),
  );
  act(() => {
    root.render(
      <CanopyClientProvider client={client}>
        <DesktopCostCurrencyProvider>
          {options?.followsEvents === true ? <ChatEventSubscriptions /> : null}
          <DesktopTerminalRuntime />
          <StandaloneChatPage />
        </DesktopCostCurrencyProvider>
      </CanopyClientProvider>,
    );
  });
}

function shown(testId: string): boolean {
  return container.querySelector(`[data-testid="${testId}"]`) !== null;
}

/** Main's cloud chat upload, which takes a cloud chat's ids by design. */
const CLOUD_UPLOAD = 'api.cloudChats.uploadAttachment';

function callsCarryingWebCoreIds(): readonly string[] {
  return [
    ...new Set(
      calls
        .filter(
          (call) =>
            call.path !== CLOUD_UPLOAD &&
            JSON.stringify(call.args).includes('web-core:'),
        )
        .map((call) => call.path),
    ),
  ].sort();
}

/** The + menu's rows, by test id. */
function menuRows(): readonly string[] {
  return Array.from(
    document.querySelectorAll('[data-testid^="chat-input-plus-"]'),
    (row) => row.getAttribute('data-testid') ?? '',
  )
    .filter(
      (id) =>
        ![
          'chat-input-plus-button',
          'chat-input-plus-menu',
          'chat-input-plus-add',
        ].includes(id),
    )
    .sort();
}

/** The Slate editor behind a composer's editable, as its typing reaches it. */
function composerEditorOf(node: HTMLElement): Editor {
  const key = Object.keys(node).find((name) =>
    name.startsWith('__reactFiber$'),
  );
  let fiber: unknown = key === undefined ? null : Reflect.get(node, key);
  while (fiber !== null && fiber !== undefined) {
    const props: unknown = Reflect.get(Object(fiber), 'memoizedProps');
    const editor: unknown =
      typeof props === 'object' && props !== null
        ? Reflect.get(props, 'editor')
        : undefined;
    if (Editor.isEditor(editor)) return editor;
    fiber = Reflect.get(Object(fiber), 'return');
  }
  throw new Error('No editor.');
}

/**
 * Clicks into the shown composer while it is empty and types a long prompt
 * as Playwright's keyboard.type() does, as fast as keys arrive: keys that
 * queue while the window is busy are each handled before React's scheduler
 * runs again. Each key's update renders at once, as its event is still
 * being dispatched, and only microtasks run between keys. Expects the whole
 * prompt in the composer, with React never stopping it at its nested update
 * limit (#185, CAN-6649).
 */
async function expectTypedAsFastAsKeysArrive(): Promise<void> {
  const editable = container.querySelector<HTMLElement>(
    '[data-chat-composer-root] [contenteditable="true"]',
  );
  if (editable === null) throw new Error('No composer.');
  const editor = composerEditorOf(editable);
  expect(serializeEditorValue(editor.children).text).toBe('');
  act(() => {
    Transforms.select(editor, Editor.end(editor, []));
  });
  const prompt =
    'Do these in order: 1) Use your to-do tool to plan three steps. 2) Run ls -la and summarise it. 3) Then reply with one word: started.';
  let key: Event | undefined;
  const event = jest
    .spyOn(window, 'event', 'get')
    .mockImplementation(() => key);
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    for (const character of prompt) {
      key = new InputEvent('beforeinput', {
        data: character,
        inputType: 'insertText',
      });
      Editor.insertText(editor, character);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      key = undefined;
    }
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    event.mockRestore();
  }
  await settle();
  expect(serializeEditorValue(editor.children).text).toBe(prompt);
  expect(editable.textContent).toBe(prompt);
}

describe('a cloud task in the cowork page (CAN-6175 R2)', () => {
  it("opens the cowork page for the retired cloud chat page's id", () => {
    act(() => useNavigationStore.getState().navigate('cloud-chat'));
    expect(useNavigationStore.getState().activePage).toBe('chat');
  });

  it('opens like a local task and sends main no cloud id', async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();

    expect(useNavigationStore.getState().activePage).toBe('chat');
    const standalone = useStandaloneChatStore.getState();
    expect([
      standalone.activeChatProjectId,
      standalone.activeWorkEntryId,
    ]).toEqual(['web-core:ws-1', 'web-core:wt-1']);
    expect(
      container.querySelector('[data-testid="cowork-top-workspace-name"]')
        ?.textContent,
    ).toBe('Cloud research');
    // The App Advisor sees which cloud task is open, as on the old cloud
    // chat page (CAN-5974).
    expect(useCurrentUiStateStore.getState().slices['cloudChat.open']).toEqual({
      chatId: 'wt-1',
      projectId: 'ws-1',
      title: 'Draft the brief',
    });
    expect(shown('chat-panel')).toBe(true);
    expect(shown('activity-panel')).toBe(true);
    // The scope has no local terminal: no panel and no drawer toggle.
    expect(shown('terminal-panel-surface')).toBe(false);
    expect(shown('workspace-layout-terminal-toggle')).toBe(false);
    // The chat's model offers its catalog's thinking levels and fast mode
    // (R5, CAN-6322), and never through this computer's Codex speed route.
    expect(shown('chat-input-thinking-level-button')).toBe(true);
    expect(calls.filter((call) => call.path.includes('codexSpeed'))).toEqual(
      [],
    );
    // Composer controls the web core refuses are hidden, and the task's own
    // chat can't be closed, which would archive the task.
    expect(shown('approval-mode-picker')).toBe(false);
    expect(shown('usage-indicator')).toBe(false);
    expect(shown('panel-tab-panel-chat-web-core:wt-1')).toBe(true);
    expect(shown('panel-tab-close-panel-chat-web-core:wt-1')).toBe(false);
    expect(shown('approvals-upgrade-notice')).toBe(false);
    // The chat is a Claude chat, whose harness would offer plan mode: the
    // scope decides instead. Its skills, plugins and MCP servers come from
    // the cloud catalog (R5), and attachments upload to the cloud chat (R6),
    // so the + menu keeps its button and offers attachments.
    expect(shown('chat-input-plus-button')).toBe(true);
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="chat-input-plus-button"]')
        ?.click();
    });
    expect(menuRows()).toContain('chat-input-plus-attachment');
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    // The @ file picker would browse this computer's disk.
    expect(container.textContent).not.toContain('@ to mention');
    // Any other chat of the task closes as usual.
    expect(shown('panel-tab-close-panel-chat-web-core:chat-2')).toBe(true);
    expect(callsCarryingWebCoreIds()).toEqual([]);
    // Its layout is kept in this renderer, never in main's layout files.
    expect(
      calls.some((call) => call.path === 'api.panelLayout.saveWorktreeLayout'),
    ).toBe(false);

    // Neither layout mode brings a terminal back.
    const layoutKey = 'web-core:ws-1/web-core:wt-1';
    for (const mode of ['advanced', 'minimal'] as const) {
      await act(() => setWorkspacePanelLayoutMode(layoutKey, mode));
      await settle();
      const groups = usePanelLayoutStore.getState().layouts[layoutKey]?.groups;
      expect(
        Object.values(groups ?? {}).flatMap((group) =>
          group.tabs.map((tab) => tab.kind),
        ),
      ).not.toContain('terminal');
    }
    expect(shown('terminal-panel-surface')).toBe(false);
    // Reopening it in Minimal doesn't ask main for its terminals.
    act(() => disposeWorktreePanelHydration(layoutKey));
    await act(() => ensureWorktreePanelLayout(layoutKey));
    expect(callsCarryingWebCoreIds()).toEqual([]);

    // Text typed in the task's other chat and not yet sent.
    const unsent = [
      { type: 'paragraph' as const, children: [{ text: 'Unsent note' }] },
    ];
    act(() => {
      useChatStore.getState().saveTabDraft('web-core:chat-2', unsent);
    });

    act(() => {
      cloudCoworkStore.getState().disconnect('offline');
    });
    await settle();
    expect(shown('standalone-chat-offline')).toBe(true);
    expect(shown('chat-panel')).toBe(false);
    expect(
      Object.keys(useChatStore.getState().worktreeChats).filter((key) =>
        key.startsWith('web-core:'),
      ),
    ).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);

    // Back online, the task's chats load again from a fresh snapshot.
    const readsWhileOffline = snapshotReads;
    act(() => {
      connectCloud();
    });
    await settle();
    expect(shown('standalone-chat-offline')).toBe(false);
    expect(shown('chat-panel')).toBe(true);
    expect(shown('panel-tab-panel-chat-web-core:chat-2')).toBe(true);
    expect(snapshotReads).toBeGreaterThan(readsWhileOffline);
    // A disconnect never costs unsent text.
    expect(useChatStore.getState().getTabDraft('web-core:chat-2')).toEqual(
      unsent,
    );
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("attaches files to a cloud task's chat through main's upload (R6)", async () => {
    // A draft, so the composer shows its send button.
    useChatStore
      .getState()
      .saveTabDraft('web-core:wt-1', [
        { type: 'paragraph', children: [{ text: 'See the notes' }] },
      ]);
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    // The person picks files from the + menu's attachment row.
    const pick = async (files: readonly File[]): Promise<void> => {
      const click = jest
        .spyOn(HTMLInputElement.prototype, 'click')
        .mockImplementation(function (this: HTMLInputElement) {
          Object.defineProperty(this, 'files', { value: files });
          this.dispatchEvent(new Event('change'));
        });
      try {
        act(() => {
          container
            .querySelector<HTMLElement>(
              '[data-testid="chat-input-plus-button"]',
            )
            ?.click();
        });
        act(() => {
          document
            .querySelector<HTMLElement>(
              '[data-testid="chat-input-plus-attachment"]',
            )
            ?.click();
        });
        await settle();
      } finally {
        click.mockRestore();
      }
    };
    const uploads = (): unknown[] =>
      calls
        .filter((call) => call.path === CLOUD_UPLOAD)
        .map((call) => call.args);

    // A file the web core would refuse never reaches main, and an oversized
    // one is refused before its bytes are read.
    const oversized = new File(['x'], 'huge.pdf', { type: 'application/pdf' });
    const readOversized = jest.fn(() => Promise.resolve(new ArrayBuffer(1)));
    Object.defineProperties(oversized, {
      size: { value: CLOUD_ATTACHMENT_MAX_BYTES + 1 },
      arrayBuffer: { value: readOversized },
    });
    await pick([
      new File([''], 'empty.md', { type: 'text/markdown' }),
      new File(['MZ'], 'tool.exe', { type: 'application/x-msdownload' }),
      oversized,
    ]);
    expect(uploads()).toEqual([]);
    expect(readOversized).not.toHaveBeenCalled();
    // The composer says why, as the web composer does.
    const problems = (): string | null | undefined =>
      container.querySelector('[data-testid="chat-input-attachment-problems"]')
        ?.textContent;
    expect(problems()).toContain('empty.md: Attachment is empty');
    expect(problems()).toContain('tool.exe: Attachment type is not supported');
    expect(problems()).toContain('huge.pdf: Attachment is too large');

    // A file it takes uploads to the task's chat, under its web core ids,
    // and shows as the composer's attachment.
    await pick([new File(['# Brief'], 'brief.md', { type: 'text/markdown' })]);
    expect(uploads()).toEqual([
      [
        { key: 'web-core:wt-1', workspaceId: 'ws-1', worktreeId: 'wt-1' },
        {
          name: 'brief.md',
          mimeType: 'text/markdown',
          bytes: new TextEncoder().encode('# Brief'),
        },
      ],
    ]);
    expect(
      Array.from(
        container.querySelectorAll('[data-testid="attachment-pill"]'),
        (pill) => pill.textContent,
      ),
    ).toEqual([expect.stringContaining('brief.md')]);
    expect(problems()).toBeUndefined();

    // A file that can't be read leaves the rest of its pick attached.
    const moved = new File(['# Gone'], 'moved.md', { type: 'text/markdown' });
    Object.defineProperty(moved, 'arrayBuffer', {
      value: (): Promise<ArrayBuffer> => Promise.reject(new Error('moved')),
    });
    await pick([
      moved,
      new File(['# Kept'], 'kept.md', { type: 'text/markdown' }),
    ]);
    expect(problems()).toContain(
      "moved.md: Couldn't read it. It may have moved",
    );
    // A file the web core refuses says why, in the web core's words, and
    // is not attached (CAN-6369).
    await pick([new File(['# Full'], 'full.md', { type: 'text/markdown' })]);
    expect(problems()).toContain('full.md: Attachment storage is full.');
    expect(
      Array.from(
        container.querySelectorAll('[data-testid="attachment-pill"]'),
        (pill) => pill.textContent,
      ),
    ).toEqual([
      expect.stringContaining('brief.md'),
      expect.stringContaining('kept.md'),
    ]);

    // While its attachments upload, the message can't be sent without them.
    const send = (): HTMLButtonElement | null =>
      container.querySelector('button[aria-label="Send message"]');
    // A message takes eight. Uploads still on their way count toward it, and
    // a refused file takes no place: with two attached and five uploading, a
    // second pick of an .exe and three notes takes one note.
    let release = (): void => undefined;
    uploadGate = new Promise((resolve) => {
      release = resolve;
    });
    const note = (name: string): File =>
      new File(['# Note'], name, { type: 'text/markdown' });
    await pick(Array.from({ length: 5 }, (_, index) => note(`p${index}.md`)));
    await pick([
      new File(['MZ'], 'tool.exe', { type: 'application/x-msdownload' }),
      note('q1.md'),
      note('q2.md'),
      note('q3.md'),
    ]);
    expect(send()?.disabled).toBe(true);
    release();
    uploadGate = null;
    await settle();
    // Eight that uploaded, and full.md, which reached main and was refused.
    expect(uploads()).toHaveLength(9);
    expect(send()?.disabled).toBe(false);
    expect(problems()).toContain('Attach up to eight files per message');
    expect(problems()).toContain('tool.exe: Attachment type is not supported');
    expect(
      container.querySelectorAll('[data-testid="attachment-pill"]'),
    ).toHaveLength(8);

    // Leave the chat as the next case finds it: no draft, nothing attached.
    // The composer saves its text as it unmounts, so it goes first.
    act(() => root.unmount());
    root = createRoot(container);
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:wt-1',
    };
    act(() => {
      const chat = useChatStore.getState();
      chat.clearTabDraft(target.chatId);
      for (const attachment of chat.worktreeChats[
        'web-core:ws-1/web-core:wt-1'
      ]?.tabs.find((tab) => tab.id === target.chatId)?.pendingAttachments ?? [])
        chat.removePendingAttachment(attachment.absolutePath, target);
    });
    // Its preview and every other call stay off main's local file reads.
    expect(calls.some((call) => call.path === 'api.readFilePreview')).toBe(
      false,
    );
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("never opens a sent cloud attachment through main's local file open (R6)", () => {
    act(() => {
      root.render(
        <MessageImages
          attachments={[
            {
              kind: 'file',
              absolutePath: cloudAttachmentPath('att-1', 'brief.md'),
            },
            { kind: 'file', absolutePath: '/Users/me/notes.md' },
          ]}
        />,
      );
    });
    const tiles = Array.from(
      container.querySelectorAll('[data-testid="message-file-attachment"]'),
    );
    expect(tiles.map((tile) => tile.getAttribute('aria-label'))).toEqual([
      'File',
      'Open file',
    ]);
    act(() => {
      tiles[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(calls.some((call) => call.path === 'api.openExternalFile')).toBe(
      false,
    );
  });

  it("offers an empty cloud chat the cowork starters without reading this computer's MCP servers", async () => {
    useFeatureFlagsStore.setState({
      isEnabled: (key) =>
        key === CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key ||
        key === CLIENT_FEATURE_FLAGS.canopyDesktopSuggestedPrompts.key,
    });
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();

    // The same empty state as a local cowork chat, from the generic pool.
    expect(shown('chat-panel')).toBe(true);
    expect(shown('suggested-prompt-chips')).toBe(true);
    // A cloud chat's MCP servers are its account's, not this computer's.
    expect(
      calls.filter((call) => call.path.startsWith('mcpServers.listDetected')),
    ).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("picks a cloud chat's skills from its web core catalog and saves them there", async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const doc = container.ownerDocument;
    const plus = doc.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-plus-button"]',
    );
    act(() => {
      plus?.click();
    });
    await settle();
    const pluginsRow = doc.querySelector<HTMLButtonElement>(
      '[data-testid="chat-plugins-button"]',
    );
    expect(pluginsRow).not.toBeNull();
    // The + menu offers no inline pick from this computer's marketplaces,
    // whose enable writes the local core's selection.
    expect(
      calls.filter((call) => call.path.startsWith('plugins.loadMarketplaces')),
    ).toEqual([]);
    act(() => {
      pluginsRow?.click();
    });
    await settle();
    // The shared picker the web's cloud chats use, over the cloud catalog.
    expect(doc.body.textContent).toContain('Review');
    const reviewToggle = doc.querySelector<HTMLInputElement>(
      'input[aria-label="Select Review"]',
    );
    expect(reviewToggle).not.toBeNull();
    act(() => {
      reviewToggle?.click();
    });
    act(() => {
      doc
        .querySelector<HTMLButtonElement>('[data-testid="portal-plugins-save"]')
        ?.click();
    });
    await settle();
    expect(chatUpdates).toHaveLength(1);
    expect(chatUpdates[0]).toMatchObject({
      type: 'chat.patch_tab_settings',
      patch: {
        pluginSelections: {
          skillRefs: [{ sourceId: 'curated', skillName: 'review' }],
        },
      },
    });
    // Nothing reached this computer's plugin store with a cloud id.
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("opens a cloud chat's picker on its saved selection and lists its connected MCP servers", async () => {
    savedSelection = ['skill:curated/review'];
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const doc = container.ownerDocument;
    act(() => {
      doc
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-plus-button"]',
        )
        ?.click();
    });
    await settle();
    act(() => {
      doc
        .querySelector<HTMLButtonElement>('[data-testid="chat-plugins-button"]')
        ?.click();
    });
    await settle();
    // The saved skill is checked once the picker opens, so Save keeps it.
    expect(
      doc.querySelector<HTMLInputElement>('input[aria-label="Select Review"]')
        ?.checked,
    ).toBe(true);
    // A connected cloud MCP server is offered even before it is selected.
    expect(doc.body.textContent).toContain('Linear');
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it('opens the cloud picker on a tab this window created and saves to the chat the web core minted', async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    act(() => {
      useChatStore.getState().createTab({
        projectId: 'web-core:ws-1',
        worktreeId: 'web-core:wt-1',
      });
    });
    await settle();
    // The new tab keeps the id this window minted; the web core took another.
    const minted = createdChatIds.at(-1);
    expect(minted).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const doc = container.ownerDocument;
    act(() => {
      doc
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-plus-button"]',
        )
        ?.click();
    });
    await settle();
    act(() => {
      doc
        .querySelector<HTMLButtonElement>('[data-testid="chat-plugins-button"]')
        ?.click();
    });
    await settle();
    const reviewToggle = doc.querySelector<HTMLInputElement>(
      'input[aria-label="Select Review"]',
    );
    expect(reviewToggle).not.toBeNull();
    act(() => {
      reviewToggle?.click();
    });
    act(() => {
      doc
        .querySelector<HTMLButtonElement>('[data-testid="portal-plugins-save"]')
        ?.click();
    });
    await settle();
    expect(chatUpdates).toHaveLength(1);
    expect(chatUpdates[0]).toMatchObject({
      type: 'chat.patch_tab_settings',
      tabId: minted,
    });
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it('offers fast mode for a cloud model that runs it without effort levels', async () => {
    cloudModelLevels = null;
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    // The chat on the catalog model, whichever tab an earlier case left focused.
    act(() => {
      useChatStore.getState().switchTab('web-core:wt-1', {
        projectId: 'web-core:ws-1',
        worktreeId: 'web-core:wt-1',
      });
    });
    await settle();
    // The speed-only panel, as on the web: Speed, not Effort.
    const trigger = container.ownerDocument.querySelector(
      '[data-testid="chat-input-thinking-level-button"]',
    );
    expect(trigger?.getAttribute('aria-label') ?? '').toContain('Speed');
    expect(calls.filter((call) => call.path.includes('codexSpeed'))).toEqual(
      [],
    );
  });

  it('keeps a cloud model pick shown while a snapshot refresh lands during the change (CAN-6328)', async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:wt-1',
    };
    act(() => {
      useChatStore.getState().switchTab(target.chatId, target);
    });
    await settle();
    const shownModel = (): string | undefined =>
      useChatStore
        .getState()
        .worktreeChats[
          'web-core:ws-1/web-core:wt-1'
        ]?.tabs.find((tab) => tab.id === target.chatId)?.model;
    expect(shownModel()).toBe('cloud-model');

    let accept = (): void => undefined;
    updateGate = new Promise<void>((resolve) => {
      accept = resolve;
    });
    let picked: Promise<boolean> = Promise.resolve(false);
    act(() => {
      picked = useChatStore.getState().setModelAndWait('second-model', target);
    });
    await settle();
    expect(shownModel()).toBe('second-model');
    // A refresh while the change is in flight installs a snapshot that still
    // names the old model.
    const readsBefore = snapshotReads;
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await settle();
    expect(snapshotReads).toBeGreaterThan(readsBefore);
    expect(shownModel()).toBe('second-model');
    accept();
    await act(() => picked);
    await settle();
    expect(chatUpdates).toContainEqual(
      expect.objectContaining({
        type: 'chat.set_model',
        model: 'second-model',
      }),
    );
    expect(shownModel()).toBe('second-model');
  });

  it('keeps a background sync of settings a cloud chat holds in the window off the wire, with no notice (CAN-6646)', async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:wt-1',
    };
    const updatesBefore = chatUpdates.length;
    let disposition: Promise<unknown> = Promise.resolve();
    act(() => {
      // As the model pick and instruction syncs patch the tab's own copy.
      disposition = useChatStore.getState().dispatchChatCommand(target, {
        type: 'chat.patch_tab_settings',
        tabId: target.chatId,
        patch: {
          providerType: 'claude',
          modelExplicitlyChosen: true,
          interfaceMode: null,
          globalInstructionsSnapshot: 'Be brief.',
          selectedRepoId: null,
          aiCreditsRouting: null,
          subscriptionBillingOverride: false,
        },
      });
    });
    await act(async () => {
      expect(await disposition).toBe('accepted');
    });
    await settle();
    expect(chatUpdates.length).toBe(updatesBefore);
    expect(
      useChatStore.getState().chatStateNotices['web-core:ws-1/web-core:wt-1'],
    ).toBeUndefined();
  });

  it("says briefly that a change a cloud chat can't keep isn't available, never 'Change not saved' (CAN-6646)", async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:wt-1',
    };
    act(() => {
      useChatStore.getState().setTabPinned(target.chatId, true, target);
    });
    await settle();
    expect(
      useChatStore.getState().chatStateNotices['web-core:ws-1/web-core:wt-1'],
    ).toEqual({
      kind: 'unavailable',
      message: 'This setting is not available in cloud chats yet.',
    });
    expect(
      document.querySelector(
        '[data-testid="chat-state-command-failed-notice"]',
      ),
    ).toBeNull();
  });

  it('places every tab setting for a cloud chat on purpose: served, kept in the window, or refused (CAN-6646)', () => {
    expect(SERVED_TAB_SETTINGS).toEqual([
      'customTitle',
      'modelSelectionMode',
      'pluginSelections',
    ]);
    expect(WINDOW_TAB_SETTINGS).toEqual([
      'model',
      'providerType',
      'modelExplicitlyChosen',
      'thinkingLevel',
      'codexFastModeEnabled',
      'modelConfig',
      'billingExplicitlyChosen',
      'aiCreditsRouting',
      'subscriptionBillingOverride',
      'interfaceMode',
      'sdkSessionId',
      'globalInstructionsSnapshot',
      'selectedRepoId',
    ]);
    // A new setting fails here until it is placed: refused is the default.
    expect(
      CHAT_TAB_SETTINGS_PATCH_KEYS.filter(
        (key) =>
          !SERVED_TAB_SETTINGS.includes(key) &&
          !WINDOW_TAB_SETTINGS.includes(key),
      ),
    ).toEqual([
      'unread',
      'description',
      'autoArchive',
      'pinned',
      'fileViewMode',
      'fileDiffContext',
      'filePath',
      'title',
      'approvalMode',
      'planMode',
      'proposalMode',
      'deferredToolsAllowed',
      'attentionDismissedAt',
      'sharedRun',
      'scheduledSendDraft',
      'pendingRevertAttachmentPath',
      'newChatStartedWatcherPending',
      'newChatStartedWatcherFiredAt',
      'pendingPlanExit',
      'pendingPlanExitRequestId',
      'trackedPlanImplementation',
      'trackedPlanId',
      'trackedPlanSource',
      'trackedPlanReviewStatus',
      'hasOutstandingProposal',
      'latestRevisionNumber',
      'pendingSystemInstructions',
      'agentArtifactCarryByTurn',
    ]);
  });

  it('keeps the newest queued cloud model pick shown through a refresh while an older one is in flight (CAN-6345)', async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:wt-1',
    };
    act(() => {
      useChatStore.getState().switchTab(target.chatId, target);
    });
    await settle();
    const shownModel = (): string | undefined =>
      useChatStore
        .getState()
        .worktreeChats[
          'web-core:ws-1/web-core:wt-1'
        ]?.tabs.find((tab) => tab.id === target.chatId)?.model;
    let accept = (): void => undefined;
    updateGate = new Promise<void>((resolve) => {
      accept = resolve;
    });
    let first: Promise<boolean> = Promise.resolve(false);
    let newest: Promise<boolean> = Promise.resolve(false);
    act(() => {
      first = useChatStore.getState().setModelAndWait('second-model', target);
    });
    await settle();
    // A newer pick waits for the one in flight, and a refresh lands meanwhile.
    act(() => {
      newest = useChatStore.getState().setModelAndWait('cloud-model', target);
    });
    await settle();
    expect(shownModel()).toBe('cloud-model');
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await settle();
    expect(shownModel()).toBe('cloud-model');
    updateGate = null;
    accept();
    await act(() => Promise.all([first, newest]));
    await settle();
    expect(shownModel()).toBe('cloud-model');
  });

  it('rolls a refused cloud model pick back even when a refresh lands around the refusal (CAN-6345)', async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:wt-1',
    };
    act(() => {
      useChatStore.getState().switchTab(target.chatId, target);
    });
    await settle();
    const shownModel = (): string | undefined =>
      useChatStore
        .getState()
        .worktreeChats[
          'web-core:ws-1/web-core:wt-1'
        ]?.tabs.find((tab) => tab.id === target.chatId)?.model;
    expect(shownModel()).toBe('cloud-model');
    setModelRefusal = 'Not served.';
    let refuse = (): void => undefined;
    updateGate = new Promise<void>((resolve) => {
      refuse = resolve;
    });
    let picked: Promise<boolean> = Promise.resolve(true);
    act(() => {
      picked = useChatStore.getState().setModelAndWait('second-model', target);
    });
    await settle();
    // A refresh reads the snapshot while the pick is in flight, then waits
    // for the chat's page; the refusal lands meanwhile.
    let pageServed = (): void => undefined;
    pageGate = new Promise<void>((resolve) => {
      pageServed = resolve;
    });
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await settle();
    updateGate = null;
    refuse();
    await act(async () => {
      await picked;
    });
    await settle();
    pageGate = null;
    pageServed();
    await settle();
    expect(shownModel()).toBe('cloud-model');
  });

  it('takes a newer model another client set once a refresh after the pick reads it (CAN-6345)', async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:wt-1',
    };
    act(() => {
      useChatStore.getState().switchTab(target.chatId, target);
    });
    await settle();
    const shownModel = (): string | undefined =>
      useChatStore
        .getState()
        .worktreeChats[
          'web-core:ws-1/web-core:wt-1'
        ]?.tabs.find((tab) => tab.id === target.chatId)?.model;
    let accept = (): void => undefined;
    updateGate = new Promise<void>((resolve) => {
      accept = resolve;
    });
    let picked: Promise<boolean> = Promise.resolve(false);
    act(() => {
      picked = useChatStore.getState().setModelAndWait('second-model', target);
    });
    await settle();
    accept();
    await act(() => picked);
    await settle();
    expect(shownModel()).toBe('second-model');
    // Another client set a third model after this pick applied, so the
    // task's revision moved on: a refresh now reads it, and it shows.
    snapshotModel = 'third-model';
    snapshotRevision = 3;
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await settle();
    expect(shownModel()).toBe('third-model');
  });

  it("reopens a cloud chat's picker on the selection a save in flight writes, so a second save keeps both (CAN-6331)", async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    act(() => {
      useChatStore.getState().switchTab('web-core:wt-1', {
        projectId: 'web-core:ws-1',
        worktreeId: 'web-core:wt-1',
      });
    });
    await settle();
    const doc = container.ownerDocument;
    const openPicker = async (): Promise<void> => {
      act(() => {
        doc
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-input-plus-button"]',
          )
          ?.click();
      });
      await settle();
      act(() => {
        doc
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-plugins-button"]',
          )
          ?.click();
      });
      await settle();
    };
    const pick = (label: string): void => {
      act(() => {
        doc
          // An MCP row's label also names its configuration.
          .querySelector<HTMLInputElement>(
            `input[aria-label^="Select ${label}"]`,
          )
          ?.click();
      });
      act(() => {
        doc
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-plugins-save"]',
          )
          ?.click();
      });
    };

    let saved = (): void => undefined;
    updateGate = new Promise<void>((resolve) => {
      saved = resolve;
    });
    await openPicker();
    pick('Review');
    await settle();
    // The picker closed with the save still in flight; reopen it meanwhile.
    expect(chatUpdates).toHaveLength(1);
    await openPicker();
    updateGate = null;
    saved();
    await settle();
    expect(
      doc.querySelector<HTMLInputElement>('input[aria-label="Select Review"]')
        ?.checked,
    ).toBe(true);
    pick('Linear');
    await settle();
    expect(chatUpdates).toHaveLength(2);
    expect(chatUpdates[1]).toMatchObject({
      type: 'chat.patch_tab_settings',
      patch: {
        pluginSelections: {
          skillRefs: [{ sourceId: 'curated', skillName: 'review' }],
          mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
        },
      },
    });
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it('withdraws a cloud send that Stop catches waiting for a selection save (CAN-6335)', async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:wt-1',
    };
    act(() => {
      useChatStore.getState().switchTab(target.chatId, target);
    });
    await settle();
    // The picker closed with its save still in flight.
    let saved = (): void => undefined;
    trackSelectionSave(
      target.chatId,
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
    );
    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = useChatStore
        .getState()
        .sendMessage('after the save', undefined, target);
    });
    await settle();
    const sends = (): number =>
      coreRequests.filter((method) => method === 'core.chat.message.send')
        .length;
    expect(sends()).toBe(0);
    await act(() => useChatStore.getState().cancelSession(target));
    saved();
    await act(() => sending);
    await settle();
    // Nothing reached the web core, and the composer is idle again, as a
    // local chat's send is when Stop withdraws it before dispatch.
    expect(sends()).toBe(0);
    const tab = useChatStore
      .getState()
      .worktreeChats[
        'web-core:ws-1/web-core:wt-1'
      ]?.tabs.find((each) => each.id === target.chatId);
    expect(tab).toMatchObject({ status: 'idle', pendingUserMessages: [] });
    expect(tab?.sendingLease).toBeUndefined();
    expect(tab?.pendingTurn).toBeUndefined();
  });

  it('Stop is there and enabled from Send, stays the same control across the send, and one press cancels its turn once (CAN-6592)', async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:wt-1',
    };
    act(() => {
      useChatStore.getState().switchTab(target.chatId, target);
    });
    await settle();
    const stopControl = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-stop-generation"]',
      );
    const cancels = (): unknown[] =>
      coreRequestLog
        .filter((entry) => entry.method === 'core.chat.turn.cancel')
        .map((entry) => entry.params.turnId);
    // The web core holds the send's reply, and reports no turn running yet
    // once it answers: the turn is still starting.
    let release = (): void => undefined;
    sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = useChatStore
        .getState()
        .sendMessage('start slowly', undefined, target);
    });
    await settle();
    const stop = stopControl();
    expect(stop).not.toBeNull();
    expect(stop?.disabled).toBe(false);
    expect(stop?.getAttribute('aria-disabled')).not.toBe('true');
    act(() => {
      stop?.click();
    });
    await settle();
    // Nothing to cancel by yet: the receipt names the turn.
    expect(cancels()).toEqual([]);
    release();
    await act(() => sending);
    await settle();
    // The receipt named the turn: one cancel, by its id, and Stop is the
    // same control, still there while the turn starts.
    expect(cancels()).toEqual(['turn-1']);
    expect(stopControl()).toBe(stop);
    expect(stop?.isConnected).toBe(true);
    await settle();
    expect(cancels()).toEqual(['turn-1']);
    expect(
      coreRequests.filter((method) => method === 'core.chat.message.send'),
    ).toHaveLength(1);
  });

  /** Opens the seeded task's own chat and returns its target and Stop helpers. */
  async function openTaskChat(options?: {
    /** Delivers the backends' pushed events, as the window does. */
    readonly followsEvents?: boolean;
  }): Promise<{
    readonly stop: () => Promise<void>;
    /** Presses Stop without waiting for it, outside act, for a held cancel. */
    readonly press: () => Promise<void>;
    readonly cancels: () => unknown[];
    readonly shown: () => ReturnType<typeof presentedCloudStop>;
    readonly flush: () => Promise<void>;
    readonly refresh: () => Promise<void>;
    /** Runs what the fake clock still holds, then restores real timers. */
    readonly settleTimers: () => Promise<void>;
    /**
     * Ends the case's turn as the web core would, with an idle snapshot: the
     * store keeps the task's tabs across cases, and a turn left running
     * would queue the next case's send behind it.
     */
    readonly endTurn: () => Promise<void>;
  }> {
    renderPage(options);
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:wt-1',
    };
    act(() => {
      useChatStore.getState().switchTab(target.chatId, target);
    });
    await settle();
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 60; i += 1)
        await act(() => jest.advanceTimersByTimeAsync(0));
    };
    return {
      stop: () => act(() => useChatStore.getState().cancelSession(target)),
      press: () => useChatStore.getState().cancelSession(target),
      cancels: () =>
        coreRequestLog
          .filter((entry) => entry.method === 'core.chat.turn.cancel')
          .map((entry) => entry.params.turnId),
      shown: () =>
        presentedCloudStop(
          useChatStore
            .getState()
            .worktreeChats[
              'web-core:ws-1/web-core:wt-1'
            ]?.tabs.find((each) => each.id === target.chatId),
        ),
      flush,
      endTurn: async () => {
        taskRuntime = null;
        runningTurn = null;
        sendsKeepRunning = false;
        snapshotRevision += 1;
        act(() => {
          refreshChatScopeRevisioned(target.projectId, target.worktreeId);
        });
        await settle();
      },
      settleTimers: async () => {
        await act(() => jest.runOnlyPendingTimersAsync());
        await flush();
        jest.useRealTimers();
        await settle();
      },
      refresh: async () => {
        snapshotRevision += 1;
        act(() => {
          refreshChatScopeRevisioned(target.projectId, target.worktreeId);
        });
        await flush();
      },
    };
  }

  it("keeps a cloud Stop's retry while its unnamed starting turn reads running, then not, then running (CAN-6592)", async () => {
    const chat = await openTaskChat();
    // Core starts the sent turn and names none yet.
    taskRuntime = { status: 'starting', queuedMessageIds: [] };
    await act(() =>
      useChatStore.getState().sendMessage('start slowly', undefined, {
        projectId: 'web-core:ws-1',
        worktreeId: 'web-core:wt-1',
        chatId: 'web-core:wt-1',
      }),
    );
    await settle();
    jest.useFakeTimers({
      doNotFake: ['Date', 'nextTick', 'queueMicrotask', 'setImmediate'],
    });
    try {
      await chat.refresh();
      // The web core takes the cancel, and the turn goes on starting.
      await chat.stop();
      await chat.flush();
      expect(chat.cancels()).toEqual(['turn-1']);
      expect(chat.shown()).toBe('stopping');
      // The same starting turn reads queued (not running), then starting again.
      taskRuntime = {
        status: 'awaiting_input',
        queuedMessageIds: ['queued-1'],
      };
      await chat.refresh();
      taskRuntime = { status: 'starting', queuedMessageIds: [] };
      await chat.refresh();
      // The retry still opens, and sends the cancel again.
      await act(() => jest.advanceTimersByTimeAsync(CLOUD_STOP_RETRY_AFTER_MS));
      await chat.flush();
      expect(chat.shown()).toBe('retryable');
      await chat.stop();
      await chat.flush();
      expect(chat.cancels()).toEqual(['turn-1', 'turn-1']);
    } finally {
      await chat.settleTimers();
      await chat.endTurn();
    }
  });

  it('a cloud Stop pressed again after the retry window sends a new cancel while the first still waits (CAN-6592)', async () => {
    const chat = await openTaskChat();
    sendsKeepRunning = true;
    await act(() =>
      useChatStore.getState().sendMessage('count slowly', undefined, {
        projectId: 'web-core:ws-1',
        worktreeId: 'web-core:wt-1',
        chatId: 'web-core:wt-1',
      }),
    );
    await settle();
    jest.useFakeTimers({
      doNotFake: ['Date', 'nextTick', 'queueMicrotask', 'setImmediate'],
    });
    // The web core holds the first cancel's reply.
    let release = (): void => undefined;
    cancelGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pressed: Promise<void> = Promise.resolve();
    let retried: Promise<void> = Promise.resolve();
    try {
      pressed = chat.press();
      await chat.flush();
      expect(chat.cancels()).toEqual(['turn-1']);
      await act(() => jest.advanceTimersByTimeAsync(CLOUD_STOP_RETRY_AFTER_MS));
      await chat.flush();
      expect(chat.shown()).toBe('retryable');
      // The retry is its own cancel; it doesn't wait on the first.
      retried = chat.press();
      await chat.flush();
      expect(chat.cancels()).toEqual(['turn-1', 'turn-1']);
    } finally {
      cancelGate = null;
      release();
      await act(() => Promise.allSettled([pressed, retried]));
      await chat.flush();
      jest.useRealTimers();
      await settle();
      await chat.endTurn();
    }
  });

  const TASK_CHAT = {
    projectId: 'web-core:ws-1',
    worktreeId: 'web-core:wt-1',
    chatId: 'web-core:wt-1',
  };
  const FAKE_TIMERS: Parameters<typeof jest.useFakeTimers>[0] = {
    doNotFake: ['Date', 'nextTick', 'queueMicrotask', 'setImmediate'],
  };

  it("an earlier Stop attempt's late failure leaves the accepted retry Stopping… (CAN-6592)", async () => {
    const chat = await openTaskChat();
    sendsKeepRunning = true;
    await act(() =>
      useChatStore.getState().sendMessage('count slowly', undefined, TASK_CHAT),
    );
    await settle();
    jest.useFakeTimers(FAKE_TIMERS);
    holdCancels = true;
    let first: Promise<void> = Promise.resolve();
    let retry: Promise<void> = Promise.resolve();
    try {
      first = chat.press();
      await chat.flush();
      expect(heldCancels).toHaveLength(1);
      await act(() => jest.advanceTimersByTimeAsync(CLOUD_STOP_RETRY_AFTER_MS));
      await chat.flush();
      expect(chat.shown()).toBe('retryable');
      retry = chat.press();
      await chat.flush();
      expect(heldCancels).toHaveLength(2);
      // The retry's cancel is accepted; the first attempt's then fails.
      heldCancels[1]?.(acceptedCancel);
      await chat.flush();
      expect(chat.shown()).toBe('stopping');
      heldCancels[0]?.(refusedCancel);
      await chat.flush();
      expect(chat.shown()).toBe('stopping');
    } finally {
      holdCancels = false;
      for (const answer of heldCancels.splice(0)) answer(acceptedCancel);
      await act(() => Promise.allSettled([first, retry]));
      await chat.settleTimers();
      await chat.endTurn();
    }
  });

  it('a Stop on an ended turn that fails late never marks the next turn (CAN-6592)', async () => {
    const chat = await openTaskChat();
    sendsKeepRunning = true;
    await act(() =>
      useChatStore.getState().sendMessage('count slowly', undefined, TASK_CHAT),
    );
    await settle();
    jest.useFakeTimers(FAKE_TIMERS);
    holdCancels = true;
    let pressed: Promise<void> = Promise.resolve();
    try {
      pressed = chat.press();
      await chat.flush();
      expect(heldCancels).toHaveLength(1);
      // Turn A ends while its cancel is held, and turn B is sent.
      runningTurn = null;
      await chat.refresh();
      const sendingB = useChatStore
        .getState()
        .sendMessage('next turn', undefined, TASK_CHAT);
      await chat.flush();
      await act(() => sendingB);
      await chat.flush();
      expect(chat.shown()).toBeUndefined();
      // A's cancel fails now: B, which nobody stopped, shows no failure.
      heldCancels[0]?.(refusedCancel);
      await chat.flush();
      expect(chat.shown()).toBeUndefined();
    } finally {
      holdCancels = false;
      for (const answer of heldCancels.splice(0)) answer(acceptedCancel);
      await act(() => Promise.allSettled([pressed]));
      await chat.settleTimers();
      await chat.endTurn();
    }
  });

  it('a message sent while a cloud turn runs waits in the queue, not the transcript, as a reload shows it (CAN-6689)', async () => {
    const chat = await openTaskChat({ followsEvents: true });
    const tabOf = ():
      | {
          readonly messages: readonly PersistedChatMessage[];
          readonly queuedMessages: readonly { readonly text: string }[];
          readonly pendingTurn?: unknown;
        }
      | undefined =>
      useChatStore
        .getState()
        .worktreeChats[
          `${TASK_CHAT.projectId}/${TASK_CHAT.worktreeId}`
        ]?.tabs.find((tab) => tab.id === TASK_CHAT.chatId);
    const userTexts = (): string[] =>
      (tabOf()?.messages ?? []).flatMap((message) =>
        message.role === 'user'
          ? [
              message.blocks
                .flatMap((block) => (block.type === 'text' ? [block.text] : []))
                .join(''),
            ]
          : [],
      );
    // The store keeps the task's tabs across cases: read this case's prompts.
    sendsKeepRunning = true;
    sendsNameMessage = true;
    let release = (): void => undefined;
    try {
      await act(() =>
        useChatStore.getState().sendMessage('five', undefined, TASK_CHAT),
      );
      await settle();
      // Core holds the first turn queued while it starts, and lists it in
      // the queue, as staging reads it seconds in (13 Nov 2026): the desktop
      // shows the chat idle. The prompt starting now stays, with its timer.
      startingSend = { text: 'five', turnId: 'turn-1', messageId: 'turn-1-u' };
      taskRuntime = { status: 'queued', queuedMessageIds: ['turn-1-u'] };
      await chat.refresh();
      await settle();
      expect(userTexts()).toContain('five');
      expect(tabOf()?.pendingTurn).toBeDefined();
      // Core queues the follow-up behind it, and a queue read lands before
      // the send's receipt names the prompt.
      sendGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sending = useChatStore
        .getState()
        .sendMessage('six', undefined, TASK_CHAT);
      await settle();
      taskRuntime = {
        status: 'queued',
        queuedMessageIds: ['turn-1-u', 'turn-2-u'],
      };
      await chat.refresh();
      await settle();
      release();
      sendGate = null;
      await act(() => sending);
      await settle();
      expect(userTexts()).not.toContain('six');
      expect(userTexts()).toContain('five');
      // The first turn now runs, with the follow-up queued behind it, and
      // Core writes its prompt.
      startingSend = null;
      startedPrompts.push({
        id: 'turn-1-u',
        role: 'user',
        blocks: [{ type: 'text', text: 'five' }],
        timestamp: Date.now(),
      });
      taskRuntime = null;
      await chat.refresh();
      await settle();
      expect(queuedSends.map((each) => each.text)).toEqual(['six']);
      // It shows as the queued row only: the transcript, like a reload's,
      // still ends with the running turn's prompt, so its reply stays under it.
      expect(tabOf()?.queuedMessages.map((row) => row.text)).toEqual(['six']);
      expect(userTexts()).not.toContain('six');
      expect(userTexts()).toContain('five');
      // Deleted from the queue: the web core keeps the prompt, marked
      // cancelled, and the desktop shows it labelled Cancelled, as the web
      // does, live and on the page a reload reads.
      act(() => {
        useChatStore.getState().clearQueuedMessage(0, TASK_CHAT);
      });
      await settle();
      expect(cancelledPrompts.map((each) => each.id)).toEqual(['turn-2-u']);
      snapshotRevision += 1;
      pushFrame('core.chat.events', (params) => worktreeOf(params) === 'wt-1', {
        kind: 'item',
        cursor: { daemonEpoch: 'e1', sequence: snapshotRevision },
        item: {
          schemaVersion: 1,
          eventId: `cancelled-${snapshotRevision}`,
          occurredAt: CREATED_AT,
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          baseRevision: snapshotRevision - 1,
          revision: snapshotRevision,
          changes: [
            {
              type: 'message.upserted',
              chatId: 'wt-1',
              message: cancelledPrompts[0],
            },
            {
              type: 'runtime.patched',
              chatId: 'wt-1',
              runtime: {
                status: 'streaming',
                activeTurnId: 'turn-1',
                queuedMessageIds: [],
              },
            },
          ],
        },
      });
      await settle();
      await chat.refresh();
      await settle();
      expect(tabOf()?.queuedMessages ?? []).toEqual([]);
      expect(userTexts().indexOf('five')).toBeGreaterThanOrEqual(0);
      expect(userTexts().indexOf('six')).toBeGreaterThan(
        userTexts().indexOf('five'),
      );
      const six = tabOf()?.messages.find(
        (message) =>
          message.role === 'user' &&
          message.blocks.some(
            (block) => block.type === 'text' && block.text === 'six',
          ),
      );
      expect(
        six === undefined
          ? undefined
          : persistedMessageToPortalMessage({
              scope: 'worktree',
              chatId: TASK_CHAT.chatId,
              message: six,
            }).status,
      ).toBe('cancelled');
      // And the desktop transcript draws it so: the deleted prompt's bubble
      // says Cancelled, under its text, and the prompt that ran does not.
      const list = document.createElement('div');
      document.body.append(list);
      const listRoot = createRoot(list);
      try {
        act(() => {
          listRoot.render(
            <CanopyClientProvider
              client={createDesktopCanopyClient(
                createDesktopCapabilities('darwin', {}, {}),
              )}
            >
              <ChatMessageList
                messages={[...(tabOf()?.messages ?? [])]}
                queuedMessages={[]}
                chatId={TASK_CHAT.chatId}
                targetOverride={TASK_CHAT}
                onClearQueuedMessage={() => undefined}
              />
            </CanopyClientProvider>,
          );
        });
        await settle();
        const bubbleOf = (text: string): string | undefined =>
          [
            ...list.querySelectorAll(
              '[data-testid="portal-chat-message-content"]',
            ),
          ]
            .map((bubble) => bubble.textContent ?? '')
            .find((content) => content.startsWith(text));
        expect(bubbleOf('six')).toBe('sixCancelled');
        expect(bubbleOf('five')).toBe('five');
        // A turn stopped once it ran keeps its prompt unmarked: its label
        // still comes from its recorded end, on the turn, not the bubble.
        const fiveId = tabOf()?.messages.find(
          (message) =>
            message.role === 'user' &&
            message.blocks.some(
              (block) => block.type === 'text' && block.text === 'five',
            ),
        )?.id;
        act(() => {
          useChatStore.setState((state) => {
            const key = `${TASK_CHAT.projectId}/${TASK_CHAT.worktreeId}`;
            const worktree = state.worktreeChats[key];
            if (worktree === undefined || fiveId === undefined) return state;
            return {
              worktreeChats: {
                ...state.worktreeChats,
                [key]: {
                  ...worktree,
                  tabs: worktree.tabs.map((tab) =>
                    tab.id === TASK_CHAT.chatId
                      ? {
                          ...tab,
                          turnEnds: {
                            ...tab.turnEnds,
                            [fiveId]: {
                              outcome: 'cancelled',
                              endedAt: Date.now(),
                            },
                          },
                        }
                      : tab,
                  ),
                },
              },
            };
          });
        });
        await settle();
        expect(bubbleOf('five')).toBe('five');
        expect(bubbleOf('six')).toBe('sixCancelled');
      } finally {
        act(() => {
          listRoot.unmount();
        });
        list.remove();
      }
    } finally {
      release();
      sendGate = null;
      queuedSends.length = 0;
      startingSend = null;
      taskRuntime = null;
      await chat.endTurn();
    }
    // It drives two sends, a deletion and a transcript render: longer than
    // the default on a loaded CI runner.
  }, 20_000);

  it("keeps a cloud Stop's retry through a snapshot that names the starting turn (CAN-6592)", async () => {
    const chat = await openTaskChat();
    // The snapshot names no turn until the case says so.
    await act(() =>
      useChatStore.getState().sendMessage('start slowly', undefined, TASK_CHAT),
    );
    await settle();
    jest.useFakeTimers(FAKE_TIMERS);
    try {
      await chat.stop();
      await chat.flush();
      expect(chat.cancels()).toEqual(['turn-1']);
      expect(chat.shown()).toBe('stopping');
      // A snapshot then names the turn, running: the handoff from starting
      // to running keeps the retry.
      runningTurn = 'turn-1';
      await chat.refresh();
      await act(() => jest.advanceTimersByTimeAsync(CLOUD_STOP_RETRY_AFTER_MS));
      await chat.flush();
      expect(chat.shown()).toBe('retryable');
    } finally {
      await chat.settleTimers();
      await chat.endTurn();
    }
  });

  it('a Stop on a cloud turn that is still starting says it waits for the project to wake, until a runtime runs the turn (CAN-6721)', async () => {
    const chat = await openTaskChat();
    const stopControl = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-stop-generation"]',
      );
    // The reason as text on screen, not only Stop's tooltip and name: the
    // user may wait half a minute without hovering.
    const shownReason = (): string[] =>
      Array.from(container.querySelectorAll('*'))
        .filter(
          (element) =>
            element.children.length === 0 &&
            element.textContent === 'Stopping… waiting for the project to wake',
        )
        .map((element) => element.tagName);
    // The send is accepted and its receipt names the turn, but the web core
    // holds its start: no runtime runs it yet.
    await act(() =>
      useChatStore.getState().sendMessage('start slowly', undefined, TASK_CHAT),
    );
    await settle();
    try {
      await chat.stop();
      await settle();
      // The cancel is accepted, and the turn is still starting: Stop says
      // what it waits for, as busy, until Core ends the turn.
      expect(chat.cancels()).toEqual(['turn-1']);
      expect(chat.shown()).toBe('stopping');
      expect(stopControl()?.getAttribute('aria-label')).toBe(
        'Stopping… waiting for the project to wake',
      );
      expect(stopControl()?.getAttribute('aria-busy')).toBe('true');
      expect(stopControl()?.disabled).toBe(true);
      expect(shownReason()).toHaveLength(1);
      // A runtime then runs the turn: the same Stopping state reads plain
      // Stopping…, as a streaming turn's does.
      runningTurn = 'turn-1';
      snapshotRevision += 1;
      act(() => {
        refreshChatScopeRevisioned(TASK_CHAT.projectId, TASK_CHAT.worktreeId);
      });
      await settle();
      expect(chat.shown()).toBe('stopping');
      expect(stopControl()?.getAttribute('aria-label')).toBe('Stopping…');
      expect(stopControl()?.disabled).toBe(true);
      expect(shownReason()).toEqual([]);
      // Nothing is sent again or shown stopped before the turn ends.
      expect(chat.cancels()).toEqual(['turn-1']);
      expect(
        coreRequests.filter((method) => method === 'core.chat.message.send'),
      ).toHaveLength(1);
    } finally {
      await chat.endTurn();
    }
    // The turn's end clears Stopping as before: Send is back.
    expect(stopControl()).toBeNull();
    expect(
      container.querySelector('button[aria-label="Send message"]'),
    ).not.toBeNull();
  });

  it("keeps Stop while a snapshot that names the sent turn waits for the chat's transcript (CAN-6677)", async () => {
    const chat = await openTaskChat();
    const stopControl = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-stop-generation"]',
      );
    const starting = (): boolean =>
      useWebCoreStartingTurnStore.getState().byChat[liveReplyKey(TASK_CHAT)] ===
      true;
    const heldStatus = (): string | undefined =>
      useChatStore.getState().runtimeByChatId[TASK_CHAT.chatId]?.status;
    await act(() =>
      useChatStore.getState().sendMessage('start slowly', undefined, TASK_CHAT),
    );
    await settle();
    // The receipt named the turn; nothing reports it running yet.
    const stop = stopControl();
    expect(stop).not.toBeNull();
    // A snapshot names the turn running while the chat's transcript page is
    // slow: the store installs neither until the page lands.
    let pageServed = (): void => undefined;
    pageGate = new Promise<void>((resolve) => {
      pageServed = resolve;
    });
    runningTurn = 'turn-1';
    snapshotRevision += 1;
    try {
      act(() => {
        refreshChatScopeRevisioned(TASK_CHAT.projectId, TASK_CHAT.worktreeId);
      });
      await settle();
      // Stop stays, enabled and the same control, while the page loads: the
      // turn still reads starting, and the store holds no running runtime.
      expect(stopControl()).toBe(stop);
      expect(stop?.disabled).toBe(false);
      expect(stop?.getAttribute('aria-disabled')).not.toBe('true');
      expect(starting()).toBe(true);
      expect(heldStatus()).not.toBe('streaming');
      pageServed();
      pageGate = null;
      await settle();
      // The installed runtime keeps it, and the turn no longer reads
      // starting while it replies.
      expect(heldStatus()).toBe('streaming');
      expect(starting()).toBe(false);
      expect(stopControl()).toBe(stop);
      await chat.stop();
      await settle();
      expect(chat.cancels()).toEqual(['turn-1']);
      expect(
        coreRequests.filter((method) => method === 'core.chat.message.send'),
      ).toHaveLength(1);
    } finally {
      pageServed();
      pageGate = null;
      await chat.endTurn();
    }
  });

  it("keeps a cloud Stop pressed before the receipt Stopping…, and the composer busy, through a snapshot read before the receipt, until Core reports the turn's end (CAN-6733)", async () => {
    const chat = await openTaskChat();
    const stopControl = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-stop-generation"]',
      );
    const sendControl = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Send message"]',
      );
    /**
     * Stop as the composer shows it once pressed: Stopping…, busy, and not
     * pressable. While the turn still starts it also says it waits for the
     * project to wake (CAN-6721).
     */
    const stopping = (): boolean => {
      const stop = stopControl();
      return (
        stop !== null &&
        ['Stopping…', 'Stopping… waiting for the project to wake'].includes(
          stop.getAttribute('aria-label') ?? '',
        ) &&
        stop.getAttribute('aria-busy') === 'true' &&
        stop.disabled
      );
    };
    // The web core holds the send's reply: the turn is still starting.
    let release = (): void => undefined;
    sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sending: Promise<void> = Promise.resolve();
    let snapshotServed = (): void => undefined;
    try {
      act(() => {
        sending = useChatStore
          .getState()
          .sendMessage('start slowly', undefined, TASK_CHAT);
      });
      await settle();
      const stop = stopControl();
      expect(stop).not.toBeNull();
      act(() => {
        stop?.click();
      });
      await settle();
      expect(stopping()).toBe(true);
      expect(chat.cancels()).toEqual([]);
      // A refresh reads the chat idle before the receipt, and the web core
      // holds that snapshot until after it.
      snapshotGate = new Promise<void>((resolve) => {
        snapshotServed = resolve;
      });
      await chat.refresh();
      // The receipt names the turn: one cancel, by its id.
      release();
      await act(() => sending);
      await settle();
      expect(chat.cancels()).toEqual(['turn-1']);
      expect(stopping()).toBe(true);
      // The stale idle snapshot lands. Core hasn't reported the turn's end:
      // Stop stays the same control, Stopping…, and the composer never
      // offers Send as if idle, so a follow-up isn't sent as if idle.
      snapshotGate = null;
      snapshotServed();
      await settle();
      expect(stopControl()).toBe(stop);
      expect(stopping()).toBe(true);
      expect(sendControl()).toBeNull();
      expect(chat.shown()).toBe('stopping');
      expect(chat.cancels()).toEqual(['turn-1']);
      expect(
        coreRequests.filter((method) => method === 'core.chat.message.send'),
      ).toHaveLength(1);
      // Core reports the turn's end: a snapshot read after the receipt
      // finds the chat idle. Only now does Stop go.
      await chat.refresh();
      await settle();
      // The composer repaints from the store a moment later.
      for (let i = 0; i < 50 && stopControl() !== null; i += 1)
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
      expect(stopControl()).toBeNull();
      expect(sendControl()).not.toBeNull();
    } finally {
      // A failure above leaves nothing held for the next case.
      release();
      sendGate = null;
      await act(() => sending);
      snapshotServed();
      snapshotGate = null;
      await chat.endTurn();
    }
  });

  it('a message sent while a stopped cloud turn is still starting goes to the web core queue, not out as if the chat were idle (CAN-6733)', async () => {
    const chat = await openTaskChat();
    const tabNow = (): ChatTab | undefined =>
      useChatStore
        .getState()
        .worktreeChats[
          'web-core:ws-1/web-core:wt-1'
        ]?.tabs.find((each) => each.id === TASK_CHAT.chatId);
    const sends = (): unknown[] =>
      coreRequestLog
        .filter((entry) => entry.method === 'core.chat.message.send')
        .map((entry) => entry.params.text);
    // Stop is pressed while the send is in flight; the receipt names the
    // turn and its cancel goes out. Core hasn't ended it: it still starts.
    let release = (): void => undefined;
    sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = useChatStore
        .getState()
        .sendMessage('start slowly', undefined, TASK_CHAT);
    });
    await settle();
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-stop-generation"]',
        )
        ?.click();
    });
    await settle();
    release();
    await act(() => sending);
    await settle();
    expect(chat.cancels()).toEqual(['turn-1']);
    expect(
      useWebCoreStartingTurnStore.getState().byChat[liveReplyKey(TASK_CHAT)],
    ).toBe(true);
    const stoppedPrompt =
      chat.shown() === 'stopping' ? tabNow()?.cloudStop : undefined;
    expect(stoppedPrompt).toBeDefined();
    try {
      // A follow-up sent now, below the composer, waits behind the starting
      // turn as one sent behind a running turn does: the web core queues it.
      // It never takes the immediate path, which would make it the chat's
      // sending turn and drop the Stop that is still waiting on the first.
      sendGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      act(() => {
        sending = useChatStore
          .getState()
          .sendMessage('follow up', undefined, TASK_CHAT, undefined, {
            userMessageId: 'follow-up-1',
          });
      });
      await settle();
      expect(sends()).toEqual(['start slowly', 'follow up']);
      expect(tabNow()?.sendingLease?.userMessageId).not.toBe('follow-up-1');
      expect(tabNow()?.pendingTurn?.userMessageId).not.toBe('follow-up-1');
      expect(chat.shown()).toBe('stopping');
      expect(tabNow()?.cloudStop).toBe(stoppedPrompt);
      release();
      await act(() => sending);
      await settle();
      expect(chat.cancels()).toEqual(['turn-1']);
    } finally {
      release();
      sendGate = null;
      await chat.endTurn();
    }
  });

  it('a cloud Stop reads Stopping… and can be sent again for the same turn only after a while (CAN-6592)', async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:wt-1',
    };
    act(() => {
      useChatStore.getState().switchTab(target.chatId, target);
    });
    await settle();
    sendsKeepRunning = true;
    await act(() =>
      useChatStore.getState().sendMessage('count slowly', undefined, target),
    );
    await settle();
    const count = (method: string): number =>
      coreRequests.filter((each) => each === method).length;
    const cancels = (): unknown[] =>
      coreRequestLog
        .filter((entry) => entry.method === 'core.chat.turn.cancel')
        .map((entry) => entry.params.turnId);
    const stop = (): Promise<void> =>
      act(() => useChatStore.getState().cancelSession(target));
    const shown = (): ReturnType<typeof presentedCloudStop> =>
      presentedCloudStop(
        useChatStore
          .getState()
          .worktreeChats[
            'web-core:ws-1/web-core:wt-1'
          ]?.tabs.find((each) => each.id === target.chatId),
      );
    expect(count('core.chat.message.send')).toBe(1);

    // Only the store's timers move with the fake clock: each flush runs what
    // is due now, and the retry window passes when the test says so.
    jest.useFakeTimers({
      doNotFake: ['Date', 'nextTick', 'queueMicrotask', 'setImmediate'],
    });
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 60; i += 1)
        await act(() => jest.advanceTimersByTimeAsync(0));
    };
    try {
      await stop();
      await flush();
      expect(cancels()).toEqual(['turn-1']);
      expect(shown()).toBe('stopping');
      // Pressed again while it is stopping: nothing more goes out.
      await stop();
      await flush();
      expect(cancels()).toEqual(['turn-1']);
      expect(shown()).toBe('stopping');

      // The turn hasn't ended after a while: Stop can be sent again, still
      // reading Stopping…, for the same turn. It starts nothing.
      await act(() => jest.advanceTimersByTimeAsync(CLOUD_STOP_RETRY_AFTER_MS));
      await flush();
      expect(shown()).toBe('retryable');
      await stop();
      await flush();
      expect(cancels()).toEqual(['turn-1', 'turn-1']);
      expect(shown()).toBe('stopping');
      // A third press in the new window sends nothing more.
      await stop();
      await flush();
      expect(cancels()).toEqual(['turn-1', 'turn-1']);
      expect(count('core.chat.message.send')).toBe(1);

      // A web core that no longer knows the turn answers not active: the
      // chat shows no stop failure, only what the snapshot says.
      await act(() => jest.advanceTimersByTimeAsync(CLOUD_STOP_RETRY_AFTER_MS));
      await flush();
      cancelTurnGone = true;
      await stop();
      await flush();
      expect(cancels()).toEqual(['turn-1', 'turn-1', 'turn-1']);
      expect(shown()).toBeUndefined();
      expect(count('core.chat.message.send')).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  /** Connects the cloud cowork store through the relay, as the sidebar does. */
  const connectCowork = async (): Promise<void> => {
    servesCoworkLists = true;
    const relay = window.canopyCore;
    if (relay === undefined) throw new Error('No relay.');
    await act(() =>
      cloudCoworkStore.getState().connect(createRelayCoreCoworkInvoker(relay)),
    );
    expect(cloudCoworkStore.getState().status).toBe('online');
  };
  const newTaskRow = (taskId: string): unknown =>
    cloudCoworkStore
      .getState()
      .tasksByProject[
        'web-core:ws-1'
      ]?.find((task) => task.worktreeId === taskId);
  const sendsTo = (taskId: string): number =>
    coreRequestLog.filter(
      (entry) =>
        entry.method === 'core.chat.message.send' &&
        entry.params.chatId === taskId,
    ).length;

  it('opens a new cloud task at once and sends its first message once the web core creates it (CAN-6098)', async () => {
    renderPage();
    await connectCowork();
    let created = (): void => undefined;
    createGate = new Promise<void>((resolve) => {
      created = resolve;
    });
    let opened: Promise<unknown> = Promise.resolve();
    act(() => {
      opened = createCloudSidebarTask('web-core:ws-1');
    });
    await settle();
    const taskId = createdChatIds.at(-1) ?? '';
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: `web-core:${taskId}`,
      chatId: `web-core:${taskId}`,
    };
    // Open before the web core answered, with the task's own chat.
    await expect(opened).resolves.toEqual({
      status: 'completed',
      worktreeId: target.worktreeId,
    });
    expect(
      useChatStore
        .getState()
        .worktreeChats[
          `${target.projectId}/${target.worktreeId}`
        ]?.tabs.map((tab) => tab.id),
    ).toEqual([target.chatId]);
    expect(newTaskRow(taskId)).toMatchObject({ creation: 'pending' });
    // Nothing about the task reached the web core but its create.
    expect(
      coreRequestLog
        .filter((entry) => worktreeOf(entry.params) === taskId)
        .map((entry) => entry.method),
    ).toEqual(['core.chat.create']);

    // The first message waits for the task, then goes to it.
    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = useChatStore.getState().sendMessage('first', undefined, target);
    });
    await settle();
    expect(sendsTo(taskId)).toBe(0);
    createGate = null;
    created();
    await act(() => sending);
    await settle();
    expect(sendsTo(taskId)).toBe(1);
    expect(newTaskRow(taskId)).not.toHaveProperty('creation');
    act(() => {
      cloudCoworkStore.getState().disconnect('offline');
    });
  });

  it('hands a waiting send its draft back when the web core refuses a new task, and retries it under the same id (CAN-6098)', async () => {
    renderPage();
    await connectCowork();
    createRefusal = 'This project is full.';
    let refused = (): void => undefined;
    createGate = new Promise<void>((resolve) => {
      refused = resolve;
    });
    act(() => {
      void createCloudSidebarTask('web-core:ws-1');
    });
    await settle();
    const taskId = createdChatIds.at(-1) ?? '';
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: `web-core:${taskId}`,
      chatId: `web-core:${taskId}`,
    };
    const draftBack = jest.fn();
    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = useChatStore
        .getState()
        .sendMessage('first', undefined, target, undefined, {
          onPreDispatchRejected: draftBack,
        });
    });
    await settle();
    createGate = null;
    refused();
    await act(() => sending);
    await settle();
    // Nothing was sent, and the composer took its draft back.
    expect(sendsTo(taskId)).toBe(0);
    expect(draftBack).toHaveBeenCalledTimes(1);
    expect(newTaskRow(taskId)).toMatchObject({
      creation: 'failed',
      creationError: 'This project is full.',
    });

    // A retry creates the same task, and the next message goes to it.
    act(() => {
      retryCloudTask(target.projectId, target.worktreeId);
    });
    await settle();
    expect(createdChatIds.filter((id) => id === taskId)).toHaveLength(2);
    expect(newTaskRow(taskId)).not.toHaveProperty('creation');
    act(() => {
      sending = useChatStore.getState().sendMessage('again', undefined, target);
    });
    await act(() => sending);
    await settle();
    expect(sendsTo(taskId)).toBe(1);
    act(() => {
      cloudCoworkStore.getState().disconnect('offline');
    });
  });

  it('applies a model picked while a new cloud task is created once it exists, and drops one when the create is refused (CAN-6098)', async () => {
    renderPage();
    await connectCowork();
    /** Opens a new task through the sidebar with its create held. */
    const openHeld = async (): Promise<{
      taskId: string;
      target: { projectId: string; worktreeId: string; chatId: string };
      release: () => void;
    }> => {
      let release = (): void => undefined;
      createGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      act(() => {
        void createCloudSidebarTask('web-core:ws-1');
      });
      await settle();
      const taskId = createdChatIds.at(-1) ?? '';
      return {
        taskId,
        target: {
          projectId: 'web-core:ws-1',
          worktreeId: `web-core:${taskId}`,
          chatId: `web-core:${taskId}`,
        },
        release: (): void => {
          createGate = null;
          release();
        },
      };
    };
    const shownModel = (target: {
      projectId: string;
      worktreeId: string;
      chatId: string;
    }): string | undefined =>
      useChatStore
        .getState()
        .worktreeChats[
          `${target.projectId}/${target.worktreeId}`
        ]?.tabs.find((tab) => tab.id === target.chatId)?.model;

    // Picked while the create is held: shown at once, sent once the task exists.
    const held = await openHeld();
    let picked: Promise<boolean> = Promise.resolve(false);
    act(() => {
      picked = useChatStore
        .getState()
        .setModelAndWait('second-model', held.target);
    });
    await settle();
    expect(shownModel(held.target)).toBe('second-model');
    expect(chatUpdates).toEqual([]);
    held.release();
    let applied: boolean | undefined;
    await act(async () => {
      applied = await picked;
    });
    expect(applied).toBe(true);
    await settle();
    expect(chatUpdates).toEqual([
      expect.objectContaining({
        type: 'chat.set_model',
        tabId: held.taskId,
        model: 'second-model',
      }),
    ]);
    expect(shownModel(held.target)).toBe('second-model');

    // Picked while a create the web core refuses is held: never sent, rolled
    // back, and only the task's creation notice says why.
    createRefusal = 'This project is full.';
    const refused = await openHeld();
    const before = shownModel(refused.target);
    act(() => {
      picked = useChatStore
        .getState()
        .setModelAndWait('second-model', refused.target);
    });
    await settle();
    refused.release();
    await act(async () => {
      applied = await picked;
    });
    expect(applied).toBe(false);
    await settle();
    expect(chatUpdates).toHaveLength(1);
    expect(shownModel(refused.target)).toBe(before);
    expect(newTaskRow(refused.taskId)).toMatchObject({ creation: 'failed' });
    expect(
      useChatStore.getState().chatStateNotices[
        `${refused.target.projectId}/${refused.target.worktreeId}`
      ],
    ).toBeUndefined();
    act(() => {
      cloudCoworkStore.getState().disconnect('offline');
    });
  });

  it('opens the cloud plugins picker on a new cloud task once the web core creates it, and saves to it (CAN-6098)', async () => {
    renderPage();
    await connectCowork();
    let created = (): void => undefined;
    createGate = new Promise<void>((resolve) => {
      created = resolve;
    });
    act(() => {
      void createCloudSidebarTask('web-core:ws-1');
    });
    await settle();
    const taskId = createdChatIds.at(-1) ?? '';
    const doc = container.ownerDocument;
    act(() => {
      doc
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-plus-button"]',
        )
        ?.click();
    });
    await settle();
    act(() => {
      doc
        .querySelector<HTMLButtonElement>('[data-testid="chat-plugins-button"]')
        ?.click();
    });
    await settle();
    // The task has no selection to read yet: the picker waits for it.
    const selectionReads = (): number =>
      coreRequestLog.filter(
        (entry) =>
          entry.method === 'core.catalog.selection.get' &&
          Reflect.get(Object(entry.params.scope), 'chatId') === taskId,
      ).length;
    expect(selectionReads()).toBe(0);
    expect(doc.querySelector('input[aria-label="Select Review"]')).toBeNull();
    createGate = null;
    created();
    await settle();
    const reviewToggle = doc.querySelector<HTMLInputElement>(
      'input[aria-label="Select Review"]',
    );
    expect(reviewToggle).not.toBeNull();
    act(() => {
      reviewToggle?.click();
    });
    act(() => {
      doc
        .querySelector<HTMLButtonElement>('[data-testid="portal-plugins-save"]')
        ?.click();
    });
    await settle();
    expect(chatUpdates).toEqual([
      expect.objectContaining({
        type: 'chat.patch_tab_settings',
        tabId: taskId,
      }),
    ]);
    act(() => {
      cloudCoworkStore.getState().disconnect('offline');
    });
  });

  it('uploads a file picked while a new cloud task is created once the web core creates it (CAN-6098)', async () => {
    renderPage();
    await connectCowork();
    let created = (): void => undefined;
    createGate = new Promise<void>((resolve) => {
      created = resolve;
    });
    act(() => {
      void createCloudSidebarTask('web-core:ws-1');
    });
    await settle();
    const taskId = createdChatIds.at(-1) ?? '';
    const click = jest
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(function (this: HTMLInputElement) {
        Object.defineProperty(this, 'files', {
          value: [new File(['# Brief'], 'brief.md', { type: 'text/markdown' })],
        });
        this.dispatchEvent(new Event('change'));
      });
    try {
      act(() => {
        container
          .querySelector<HTMLElement>('[data-testid="chat-input-plus-button"]')
          ?.click();
      });
      act(() => {
        document
          .querySelector<HTMLElement>(
            '[data-testid="chat-input-plus-attachment"]',
          )
          ?.click();
      });
      await settle();
    } finally {
      click.mockRestore();
    }
    const uploads = (): unknown[] =>
      calls
        .filter((call) => call.path === CLOUD_UPLOAD)
        .map((call) => call.args);
    // The task's chat doesn't exist yet: the file waits for it.
    expect(uploads()).toEqual([]);
    createGate = null;
    created();
    await settle();
    expect(uploads()).toEqual([
      [
        expect.objectContaining({ worktreeId: taskId }),
        expect.objectContaining({ name: 'brief.md' }),
      ],
    ]);
    expect(
      Array.from(
        container.querySelectorAll('[data-testid="attachment-pill"]'),
        (pill) => pill.textContent,
      ),
    ).toEqual([expect.stringContaining('brief.md')]);
    expect(
      container.querySelector('[data-testid="chat-input-attachment-problems"]'),
    ).toBeNull();
    act(() => {
      cloudCoworkStore.getState().disconnect('offline');
    });
  });

  it("sends to a new cloud task the web core lists while its create's reply is lost, and keeps it created (CAN-6098)", async () => {
    renderPage();
    await connectCowork();
    loseCreateReply = true;
    let failReply = (): void => undefined;
    createGate = new Promise<void>((resolve) => {
      failReply = resolve;
    });
    act(() => {
      void createCloudSidebarTask('web-core:ws-1');
    });
    await settle();
    const taskId = createdChatIds.at(-1) ?? '';
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: `web-core:${taskId}`,
      chatId: `web-core:${taskId}`,
    };
    expect(newTaskRow(taskId)).toMatchObject({ creation: 'pending' });
    // The first message waits for the task.
    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = useChatStore
        .getState()
        .sendMessage('while it is created', undefined, target);
    });
    await settle();
    expect(sendsTo(taskId)).toBe(0);
    // A re-read lists the task the web core did create, before the create's
    // reply is known to be lost.
    act(() => {
      const listed = cloudCoworkStore
        .getState()
        .tasksByProject['web-core:ws-1']?.map((task) =>
          task.worktreeId === taskId
            ? {
                key: task.key,
                workspaceId: task.workspaceId,
                worktreeId: task.worktreeId,
                title: task.title,
                state: 'idle',
                updatedAt: task.updatedAt,
              }
            : task,
        );
      cloudCoworkStore.setState({
        tasksByProject: { 'web-core:ws-1': listed ?? [] },
      });
    });
    await act(() => sending);
    await settle();
    // The chat reads it from the web core, and the message goes out.
    expect(
      coreRequestLog.some(
        (entry) =>
          entry.method === 'core.chat.snapshot.get' &&
          worktreeOf(entry.params) === taskId,
      ),
    ).toBe(true);
    expect(sendsTo(taskId)).toBe(1);
    // The lost reply fails late: the listed task stays created.
    act(() => {
      failReply();
    });
    await settle();
    expect(newTaskRow(taskId)).not.toHaveProperty('creation');
    expect(sendsTo(taskId)).toBe(1);
    act(() => {
      cloudCoworkStore.getState().disconnect('offline');
    });
  });

  it("never shows this computer's default model on a cloud chat the web core names none for (CAN-6365)", async () => {
    snapshotModel = undefined;
    // This computer runs its default model, so it can stamp it on a chat.
    initClaudeModels([{ id: 'opus[1m]', label: 'Opus' }]);
    // The chat's transcript is still on its way, so it reads as empty.
    let pages = (): void => undefined;
    pageGate = new Promise<void>((resolve) => {
      pages = resolve;
    });
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    // The window fills an empty local chat with its default model; a cloud
    // chat's model is the web core's.
    useChatStore.setState({
      selectedWorktree: {
        projectId: 'web-core:ws-1',
        worktreeId: 'web-core:wt-1',
      },
    });
    await act(() => useChatStore.getState().syncActiveEmptyTabToDefaults());
    // Nor does a chat this window adds to the task.
    act(() => {
      useChatStore.getState().createTab({
        projectId: 'web-core:ws-1',
        worktreeId: 'web-core:wt-1',
      });
    });
    await settle();
    initClaudeModels([]);
    const added = (
      useChatStore.getState().worktreeChats['web-core:ws-1/web-core:wt-1']
        ?.tabs ?? []
    ).filter(
      (tab) => tab.id !== 'web-core:wt-1' && tab.id !== 'web-core:chat-2',
    );
    expect(added.map((tab) => tab.model)).toEqual([undefined]);
    pageGate = null;
    pages();
    await settle();
    const tabs =
      useChatStore.getState().worktreeChats['web-core:ws-1/web-core:wt-1']
        ?.tabs ?? [];
    expect(
      tabs
        .filter(
          (tab) => tab.id === 'web-core:wt-1' || tab.id === 'web-core:chat-2',
        )
        .map((tab) => [tab.id, tab.model]),
    ).toEqual([
      ['web-core:wt-1', undefined],
      ['web-core:chat-2', undefined],
    ]);
    expect(
      Array.from(
        container.querySelectorAll('button[aria-label^="Select model"]'),
        (button) => button.getAttribute('aria-label'),
      ),
    ).toEqual(['Select model, current model Model']);
  });

  it('keeps the draft and says why when the web core refuses a cloud send, and shows nothing as sent (CAN-6364)', async () => {
    const draft = [
      { type: 'paragraph' as const, children: [{ text: 'Book Studio B.' }] },
    ];
    useChatStore.getState().saveTabDraft('web-core:wt-1', draft);
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    // With a file attached, from the + menu's attachment row.
    const click = jest
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(function (this: HTMLInputElement) {
        Object.defineProperty(this, 'files', {
          value: [new File(['# Room'], 'room.md', { type: 'text/markdown' })],
        });
        this.dispatchEvent(new Event('change'));
      });
    try {
      act(() => {
        container
          .querySelector<HTMLElement>('[data-testid="chat-input-plus-button"]')
          ?.click();
      });
      act(() => {
        document
          .querySelector<HTMLElement>(
            '[data-testid="chat-input-plus-attachment"]',
          )
          ?.click();
      });
      await settle();
    } finally {
      click.mockRestore();
    }
    const pills = (): (string | null)[] =>
      Array.from(
        container.querySelectorAll('[data-testid="attachment-pill"]'),
        (pill) => pill.textContent,
      );
    expect(pills()).toEqual([expect.stringContaining('room.md')]);
    sendRefusal = 'The cloud sandbox is waking up. Try again in a moment.';
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        ?.click();
    });
    await settle();
    // The web core was asked once, and refused.
    expect(
      coreRequestLog.filter(
        (entry) => entry.method === 'core.chat.message.send',
      ),
    ).toHaveLength(1);
    // Nothing reads as sent: no user message, and no failure note under one.
    const tab = useChatStore
      .getState()
      .worktreeChats[
        'web-core:ws-1/web-core:wt-1'
      ]?.tabs.find((entry) => entry.id === 'web-core:wt-1');
    expect(
      (tab?.messages ?? []).filter((message) =>
        message.blocks.some(
          (block) =>
            block.type === 'text' &&
            (block.text.includes('Book Studio B.') ||
              block.text.includes('waking up')),
        ),
      ),
    ).toEqual([]);
    // The composer has the draft and its file back, and says why it wasn't
    // sent.
    expect(container.textContent).toContain('Book Studio B.');
    expect(pills()).toEqual([expect.stringContaining('room.md')]);
    expect(
      container.querySelector('[data-testid="chat-input-send-refused"]')
        ?.textContent,
    ).toContain(
      "Your message wasn't sent: The cloud sandbox is waking up. Try again in a moment.",
    );
    // A dismiss clears the notice.
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-send-refused"] button[aria-label="Dismiss"]',
        )
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="chat-input-send-refused"]'),
    ).toBeNull();
    // Leave the chat as the next case finds it: no draft, nothing attached.
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    act(() => {
      const chat = useChatStore.getState();
      chat.clearTabDraft('web-core:wt-1');
      for (const attachment of chat.worktreeChats[
        'web-core:ws-1/web-core:wt-1'
      ]?.tabs.find((entry) => entry.id === 'web-core:wt-1')
        ?.pendingAttachments ?? [])
        chat.removePendingAttachment(attachment.absolutePath, {
          projectId: 'web-core:ws-1',
          worktreeId: 'web-core:wt-1',
          chatId: 'web-core:wt-1',
        });
    });
  });

  /** Sends 'Book Studio B.' from the task's own chat on the cowork page. */
  const sendFromCoworkPage = async (): Promise<void> => {
    useChatStore
      .getState()
      .saveTabDraft('web-core:wt-1', [
        { type: 'paragraph' as const, children: [{ text: 'Book Studio B.' }] },
      ]);
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        ?.click();
    });
  };
  /** The task's own chat's messages that carry `text`. */
  const rootMessagesWith = (text: string): number =>
    (
      useChatStore
        .getState()
        .worktreeChats[
          'web-core:ws-1/web-core:wt-1'
        ]?.tabs.find((entry) => entry.id === 'web-core:wt-1')?.messages ?? []
    ).filter((message) =>
      message.blocks.some(
        (block) => block.type === 'text' && block.text.includes(text),
      ),
    ).length;

  it('keeps a cloud send whose outcome is unknown, rather than hand it back to be sent twice (CAN-6364)', async () => {
    sendOutcomeUnknown = true;
    const sent = rootMessagesWith('Book Studio B.');
    await sendFromCoworkPage();
    await settle();
    // The send may have landed: it stays in the transcript, failed, and the
    // composer doesn't offer it again.
    expect(rootMessagesWith('Book Studio B.')).toBe(sent + 1);
    expect(rootMessagesWith('did not answer in time')).toBe(1);
    expect(
      container.querySelector('[data-testid="chat-input-send-refused"]'),
    ).toBeNull();
    expect(useChatStore.getState().getTabDraft('web-core:wt-1') ?? []).toEqual(
      [],
    );
  });

  it('keeps a refused cloud send in the transcript when the composer could not take it back (CAN-6364)', async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    sendRefusal = 'The cloud sandbox is waking up. Try again in a moment.';
    const sent = rootMessagesWith('Book Studio B.');
    const notes = rootMessagesWith('waking up');
    // A composer that moved on, say to a newer draft, can't restore this one.
    const restore = jest.fn((): boolean => false);
    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = useChatStore.getState().sendMessage(
        'Book Studio B.',
        undefined,
        {
          projectId: 'web-core:ws-1',
          worktreeId: 'web-core:wt-1',
          chatId: 'web-core:wt-1',
        },
        undefined,
        { onPreDispatchRejected: restore },
      );
    });
    await act(() => sending);
    await settle();
    expect(restore).toHaveBeenCalledTimes(1);
    // So the text stays where it can be read, with why it wasn't sent.
    expect(rootMessagesWith('Book Studio B.')).toBe(sent + 1);
    expect(rootMessagesWith('waking up')).toBe(notes + 1);
    expect(
      container.querySelector('[data-testid="chat-input-send-refused"]'),
    ).toBeNull();
  });

  it('mounts the sandbox files and terminals, and sends main no cloud id (R9, R10)', async () => {
    useFeatureFlagsStore.setState({
      isEnabled: (key) =>
        key === CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key ||
        key === CLIENT_FEATURE_FLAGS.canopyCloudDurableTerminals.key,
    });
    // Its own task, so no earlier case's chat state carries over.
    cloudCoworkStore.setState((state) => ({
      tasksByProject: {
        'web-core:ws-1': [
          ...(state.tasksByProject['web-core:ws-1'] ?? []),
          {
            key: 'web-core:ws-1:wt-2',
            workspaceId: 'ws-1',
            worktreeId: 'wt-2',
            title: 'Edit the brief',
            state: 'idle',
            updatedAt: CREATED_AT,
          },
        ],
      },
    }));
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-2');
    });
    await settle();
    expect(shown('workspace-layout-terminal-toggle')).toBe(true);

    const worktreeKey = 'web-core:ws-1/web-core:wt-2';
    const [groupId] = Object.keys(
      usePanelLayoutStore.getState().layouts[worktreeKey]?.groups ?? {},
    );
    act(() => {
      usePanelLayoutStore
        .getState()
        .addTab(worktreeKey, groupId ?? '', 'file-explorer');
    });
    await settle();
    // The explorer lists the sandbox through the web core, without the row
    // actions that hand a file to this computer.
    expect(container.textContent).toContain('brief.md');
    expect(coreRequests).toContain('worker.filesystem.directory.list');
    expect(shown('files-tree-row-open-in-file-manager')).toBe(false);

    // The menu keeps what the sandbox serves and drops what hands the file
    // to this computer, and mentions until the composer takes them (R7).
    act(() => {
      container
        .querySelector('[data-file-tree-id="workspace:brief.md"]')
        ?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          }),
        );
    });
    await settle();
    // The menu is portalled to the document.
    const inMenu = (id: string): boolean =>
      document.querySelector(`[data-testid="files-tree-action-${id}"]`) !==
      null;
    expect(inMenu('menu')).toBe(true);
    for (const kept of ['rename', 'delete', 'cut'])
      expect([kept, inMenu(kept)]).toEqual([kept, true]);
    for (const hidden of [
      'open-external',
      'open-in-file-manager',
      'copy-entry',
      'copy-absolute-path',
      'send-to-chat',
    ])
      expect([hidden, inMenu(hidden)]).toEqual([hidden, false]);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await settle();

    // A move never replaces what is already at its destination (CAN-6282):
    // docs/ holds a brief.md, so the sandbox refuses cut and paste, and
    // drag, and the explorer shows why.
    const row = (relativePath: string): HTMLElement => {
      const found = container.querySelector<HTMLElement>(
        `[data-file-tree-id="workspace:${relativePath}"]`,
      );
      if (!found) throw new Error(`No ${relativePath} row`);
      return found;
    };
    const refusal = 'A file or folder named brief.md already exists there.';
    const key = (element: HTMLElement, letter: string): void => {
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: letter,
          metaKey: true,
          bubbles: true,
        }),
      );
    };
    act(() => {
      key(row('brief.md'), 'x');
    });
    act(() => {
      key(row('docs'), 'v');
    });
    await settle();
    expect(container.textContent).toContain(refusal);
    expect(coreRequests).toContain('worker.filesystem.entry.move');

    coreRequests.length = 0;
    const drag = (element: HTMLElement, type: string): void => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: {
          effectAllowed: 'all',
          dropEffect: 'none',
          setData: (): void => {},
          getData: (): string => '',
        },
      });
      element.dispatchEvent(event);
    };
    act(() => {
      drag(row('brief.md'), 'dragstart');
      drag(row('docs'), 'dragover');
      drag(row('docs'), 'drop');
    });
    await settle();
    expect(coreRequests).toContain('worker.filesystem.entry.move');
    expect(container.textContent).toContain(refusal);
    expect(row('brief.md')).toBeTruthy();

    act(() => {
      useChatStore.getState().openFileTab(
        {
          absolutePath: webCoreFilePath({
            chatId: 'wt-2',
            fileRootId: 'workspace',
            relativePath: 'brief.md',
          }),
          filename: 'brief.md',
        },
        { projectId: 'web-core:ws-1', worktreeId: 'web-core:wt-2' },
      );
    });
    await settle();
    // The viewer reads it through the web core too.
    expect(coreRequests).toContain('worker.filesystem.file.read');
    expect(container.textContent).toContain('Sandbox brief body');

    act(() => {
      container
        .querySelector<HTMLElement>(
          '[data-testid="workspace-layout-terminal-toggle"]',
        )
        ?.click();
    });
    await settle();
    // The drawer's terminal is a durable shell in the chat's sandbox.
    expect(coreRequests).toContain('worker.terminal.create');
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it('opens a Terminal panel on a cloud task as a durable shell in its sandbox, never a local spawn (CAN-6542)', async () => {
    useFeatureFlagsStore.setState({
      isEnabled: (key) =>
        key === CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key ||
        key === CLIENT_FEATURE_FLAGS.canopyCloudDurableTerminals.key,
    });
    cloudCoworkStore.setState((state) => ({
      tasksByProject: {
        'web-core:ws-1': [
          ...(state.tasksByProject['web-core:ws-1'] ?? []),
          {
            key: 'web-core:ws-1:wt-6542',
            workspaceId: 'ws-1',
            worktreeId: 'wt-6542',
            title: 'Run the build',
            state: 'idle',
            updatedAt: CREATED_AT,
          },
        ],
      },
    }));
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-6542');
    });
    await settle();
    const worktreeKey = 'web-core:ws-1/web-core:wt-6542';
    const [groupId] = Object.keys(
      usePanelLayoutStore.getState().layouts[worktreeKey]?.groups ?? {},
    );
    let opened: boolean | undefined;
    act(() => {
      void createTerminalPanel(worktreeKey, groupId ?? '').then((result) => {
        opened = result;
      });
    });
    await settle();
    await settle();
    // Main's local terminal host never sees the cloud task's ids.
    expect(callsCarryingWebCoreIds()).toEqual([]);
    // The panel's shell runs in the chat's sandbox over the web core relay.
    expect(coreRequests).toContain('worker.terminal.create');
    expect(opened).toBe(true);
    const tabs = Object.values(
      usePanelLayoutStore.getState().layouts[worktreeKey]?.groups ?? {},
    ).flatMap((group) => group.tabs);
    expect(tabs.some((tab) => tab.kind === 'terminal')).toBe(true);
  });

  /** Opens a fresh cloud task of its own and adds the File explorer tab. */
  const openExplorerOnNewTask = async (worktreeId: string): Promise<void> => {
    cloudCoworkStore.setState((state) => ({
      tasksByProject: {
        'web-core:ws-1': [
          ...(state.tasksByProject['web-core:ws-1'] ?? []),
          {
            key: `web-core:ws-1:${worktreeId}`,
            workspaceId: 'ws-1',
            worktreeId,
            title: 'Read the brief',
            state: 'idle',
            updatedAt: CREATED_AT,
          },
        ],
      },
    }));
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', `web-core:${worktreeId}`);
    });
    await settle();
    const worktreeKey = `web-core:ws-1/web-core:${worktreeId}`;
    const [groupId] = Object.keys(
      usePanelLayoutStore.getState().layouts[worktreeKey]?.groups ?? {},
    );
    act(() => {
      usePanelLayoutStore
        .getState()
        .addTab(worktreeKey, groupId ?? '', 'file-explorer');
    });
    await settle();
  };

  /** Whether a filesystem request asked the web core to wake the sandbox. */
  const askedToWake = (): boolean =>
    coreRequestLog.some(
      (entry) =>
        entry.method.startsWith('worker.filesystem.') && 'wake' in entry.params,
    );

  it("says a cloud task's sandbox is asleep, and lists it once a turn runs, without waking it (CAN-6543)", async () => {
    sandboxAsleep = true;
    await openExplorerOnNewTask('wt-3');
    // The explorer asked, and says why it lists nothing: the project sleeps.
    expect(coreRequests).toContain('worker.filesystem.directory.list');
    expect(shown('files-tree-sandbox-sleeping')).toBe(true);
    expect(shown('files-tree-folder-error')).toBe(false);
    expect(container.textContent).not.toContain('brief.md');

    // A turn runs in the sandbox, which wakes it. The explorer lists the
    // folder again on its own, with no refresh.
    const target = { projectId: 'web-core:ws-1', worktreeId: 'web-core:wt-3' };
    sandboxAsleep = false;
    runningTurn = 'turn-wakes';
    snapshotRevision += 1;
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await settle();
    expect(container.textContent).toContain('brief.md');
    expect(shown('files-tree-sandbox-sleeping')).toBe(false);

    // The turn ends; the folder stays listed.
    runningTurn = null;
    snapshotRevision += 1;
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await settle();
    expect(container.textContent).toContain('brief.md');
    // Nothing here woke the sandbox: only a turn does.
    expect(askedToWake()).toBe(false);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it('says a sandbox whose idle session ended is sleeping, not expired, and that a message wakes it (CAN-6654)', async () => {
    sandboxAsleep = true;
    // As the web core passes it on: Core's code, and no wake from a read.
    asleepAs = { cloudCode: 'SANDBOX_SESSION_EXPIRED', wakeAllowed: false };
    await openExplorerOnNewTask('wt-6654');
    expect(shown('files-tree-sandbox-sleeping')).toBe(true);
    expect(shown('files-tree-sandbox-expired')).toBe(false);
    expect(container.textContent).toContain(
      'Project is sleeping. Send a message to wake it.',
    );
    expect(container.textContent).not.toContain('has expired');
    expect(askedToWake()).toBe(false);
  });

  it('drops a deleted cloud row at once, and a listing that still shows it never brings it back (CAN-6543)', async () => {
    await openExplorerOnNewTask('wt-4');
    const briefRow = (): Element | null =>
      container.querySelector('[data-file-tree-id="workspace:brief.md"]');
    expect(briefRow()).not.toBeNull();

    // The web core's listings lag the delete, and the next one is held.
    listingLags = true;
    let releaseListing = (): void => undefined;
    listingGate = new Promise<void>((resolve) => {
      releaseListing = resolve;
    });
    act(() => {
      briefRow()?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    });
    await settle();
    act(() => {
      document
        .querySelector<HTMLElement>('[data-testid="files-tree-action-delete"]')
        ?.click();
    });
    await settle();
    act(() => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="files-tree-delete-confirm-button"]',
        )
        ?.click();
    });
    await settle();
    expect(
      coreRequestLog
        .filter((entry) => entry.method === 'worker.filesystem.entry.delete')
        .map(({ params }) => [params.relativePath, params.disposition]),
    ).toEqual([['brief.md', 'permanent']]);
    // Gone as soon as the delete lands, before the listing after it settles.
    expect(briefRow()).toBeNull();
    expect(
      container.querySelector('[data-file-tree-id="workspace:docs"]'),
    ).not.toBeNull();

    // That listing still shows the deleted file; the row stays gone.
    releaseListing();
    listingGate = null;
    await settle();
    expect(briefRow()).toBeNull();
    expect(
      container.querySelector('[data-file-tree-id="workspace:docs"]'),
    ).not.toBeNull();
  });

  it('a local scope keeps every composer and tab control a cloud scope hides', () => {
    const local = createDesktopCapabilities('darwin', {}, {});
    const cloud = webCoreScopeCapabilities(local);
    for (const key of [
      'chatApprovalMode',
      'chatTabFork',
      'chatRootTabLifecycle',
      'chatResetToPoint',
      'chatContextUsage',
      'chatFileMentions',
      'chatInterfaceModes',
    ] as const) {
      expect([key, local[key]]).toEqual([key, true]);
      expect([key, cloud[key] === true]).toEqual([key, false]);
    }
    // Attachments upload to a cloud chat through main's web core connection.
    expect(cloud.chatAttachments).toBe(true);
    // Edit and Run now on a queued prompt reach Core (CAN-6651).
    expect(cloud.chatQueueEdits).toBe(true);
    expect(local.chatWorkflows?.planMode).toBe(true);
    expect(cloud.chatWorkflows?.planMode === true).toBe(false);
    // Each send carries it, within the model's web core catalog (R5).
    expect(cloud.chatThinkingLevel).toBe(true);
    // Chosen from the chat's web core catalog (R5).
    expect(cloud.chatPluginSelections).toBe(true);
    // Rides each send where the model's catalog runs it (CAN-6322).
    expect(cloud.chatFastMode).toBe(true);
  });

  it('offers a local scope every panel kind a cloud scope lacks', () => {
    const local = createDesktopCapabilities('darwin', {}, {});
    expect(panelKindsUnavailableFor(local)).toEqual([]);
    expect(panelKindsUnavailableFor(webCoreScopeCapabilities(local))).toEqual(
      expect.arrayContaining(['terminal', 'browser', 'ledger', 'cost']),
    );
    // The sandbox's files always; its terminals once the desktop binds them.
    const withTerminals = webCoreScopeCapabilities(local, {
      durableTerminals: true,
    });
    expect(withTerminals).toBe(
      webCoreScopeCapabilities(local, { durableTerminals: true }),
    );
    expect(withTerminals.fileSystemAccess).toBe('read-write');
    expect(withTerminals.scriptActions === true).toBe(false);
    expect(panelKindsUnavailableFor(withTerminals)).not.toEqual(
      expect.arrayContaining(['terminal']),
    );
    expect(panelKindsUnavailableFor(withTerminals)).not.toEqual(
      expect.arrayContaining(['file-explorer']),
    );
    expect(
      panelKindsUnavailableFor({ ...local, fileSystemAccess: 'none' }),
    ).toEqual(['file-explorer', 'file-diff']);
    // Cost and its Activity section follow the web core's manifest together
    // (CAN-6180).
    const withCost = webCoreScopeCapabilities(local, {
      durableTerminals: false,
      costInsights: true,
    });
    expect(withCost.costInsights).toBe(true);
    expect(withCost.activitySectionIds).toContain('cost');
    expect(panelKindsUnavailableFor(withCost)).not.toContain('cost');
    const withoutCost = webCoreScopeCapabilities(local);
    expect(withoutCost.costInsights).toBe(false);
    expect(withoutCost.activitySectionIds).not.toContain('cost');
  });

  it('offers a cloud task only the Activity it has data for, and its Activity shows it (CAN-6430, CAN-6431)', async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const cards = (worktreeKey: string): string[] =>
      listAddablePanels(worktreeKey)
        .filter((entry) => entry.kind === 'activity-card')
        .map((entry) => entry.instance?.sectionId ?? '');
    // Only the sections the web core feeds, the chat's attachments among
    // them (CAN-6175 R8d): no Cost (no cost insights), no Summary (no task
    // summary), Notes, Prompts or Memory, which would read this computer with
    // the cloud task's ids. MCP servers come from the chat's web core catalog
    // (CAN-6608). This web core serves no workspace files
    // (capability_unavailable), so Workspace files is not offered either
    // (CAN-6568).
    expect(cards('web-core:ws-1/web-core:wt-1').sort()).toEqual([
      'attachments',
      'background-processes',
      'mcp-servers',
      'todo',
    ]);
    // Nor Cost: this web core's manifest serves no cost (CAN-6180).
    expect(panelKindsUnavailableFor(cloudScopeCapabilitiesNow())).toContain(
      'cost',
    );
    // With no agent tasks and no MCP servers yet, the Activity tab offers
    // to add one rather than staying blank, beside the Attachments card
    // (R8d).
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="panel-tab-panel-activity"]')
        ?.click();
    });
    await settle();
    expect(shown('activity-mcp-add')).toBe(true);
    expect(shown('cloud-attachments-add')).toBe(true);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("takes a long prompt typed into a cloud task's empty composer as fast as keys arrive, right after the task opens (CAN-6649)", async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    await expectTypedAsFastAsKeysArrive();
  });

  it('takes a long prompt typed into a local composer as fast as keys arrive (CAN-6649)', async () => {
    const client = createDesktopCanopyClient(
      createDesktopCapabilities('darwin', {}, {}),
    );
    // The sandbox's composer is the local chat composer, over its own store.
    act(() => {
      root.render(
        <CanopyClientProvider client={client}>
          <ChatQuestionPlayground />
        </CanopyClientProvider>,
      );
    });
    await settle();
    await expectTypedAsFastAsKeysArrive();
  });

  describe('a cloud task deleted on another device (CAN-6614)', () => {
    const DRAFT = [
      { type: 'paragraph' as const, children: [{ text: 'Keep this draft' }] },
    ];
    const OLD_CHAT = 'web-core:wt-1';

    /** Opens the seeded task with a draft, as the person left it. */
    const openWithDraft = async (): Promise<void> => {
      // The page opens it once the cloud is connected, not before.
      useStandaloneChatStore.getState().clearActiveWorkEntry();
      useChatStore.getState().saveTabDraft(OLD_CHAT, DRAFT);
      renderPage({ followsEvents: true });
      await connectCowork();
      act(() => {
        openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
      });
      await settle();
      // On the task's own chat, whichever this window showed last.
      act(() => {
        useChatStore.getState().switchTab(OLD_CHAT, {
          projectId: 'web-core:ws-1',
          worktreeId: 'web-core:wt-1',
        });
      });
      await settle();
    };

    /** Attaches files from the + menu's attachment row. */
    const attach = async (files: readonly File[]): Promise<void> => {
      const click = jest
        .spyOn(HTMLInputElement.prototype, 'click')
        .mockImplementation(function (this: HTMLInputElement) {
          Object.defineProperty(this, 'files', { value: files });
          this.dispatchEvent(new Event('change'));
        });
      try {
        act(() => {
          container
            .querySelector<HTMLElement>(
              '[data-testid="chat-input-plus-button"]',
            )
            ?.click();
        });
        act(() => {
          document
            .querySelector<HTMLElement>(
              '[data-testid="chat-input-plus-attachment"]',
            )
            ?.click();
        });
        await settle();
      } finally {
        click.mockRestore();
      }
    };

    /** A file picked from this computer's disk. */
    const diskFile = (name: string, path: string): File => {
      const file = new File(['# Brief'], name, { type: 'text/markdown' });
      diskPaths.set(file, path);
      return file;
    };

    const pills = (): (string | null)[] =>
      Array.from(
        container.querySelectorAll('[data-testid="attachment-pill"]'),
        (pill) => pill.textContent,
      );
    const notice = (): Element | null =>
      container.querySelector('[data-testid="chat-input-chat-deleted"]');
    /** The new chat's notice for files that didn't come over with it. */
    const notAttached = (): string | null | undefined =>
      container.querySelector('[data-testid="chat-input-files-not-attached"]')
        ?.textContent;
    const click = (testId: string): void => {
      act(() => {
        document
          .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
          ?.click();
      });
    };
    /** What the window asked the web core about `task` after `from`. */
    const requestsFor = (task: string, from: number): string[] =>
      coreRequestLog
        .slice(from)
        .filter((entry) => worktreeOf(entry.params) === task)
        .map((entry) => entry.method);
    const uploadsTo = (task: string): string[] =>
      calls
        .filter(
          (call) =>
            call.path === CLOUD_UPLOAD &&
            Reflect.get(Object(call.args[0]), 'worktreeId') === task,
        )
        .map((call) => String(Reflect.get(Object(call.args[1]), 'name')));
    const storedDraft = (chatId: string): string | null =>
      window.localStorage.getItem(`canopy:chat-draft:v1:${chatId}`);
    /**
     * Types into a chat's composer as typing does: the editor changes and its
     * write waits, while the store's draft map hasn't seen it.
     */
    const typeInto = async (chatId: string, text: string): Promise<void> => {
      act(() => {
        document.dispatchEvent(
          new CustomEvent(INSERT_CHAT_TEXT_EVENT, {
            detail: { text, targetTabId: chatId },
          }),
        );
      });
      await settle();
    };
    /** A chat's saved draft as text, once the open composers save. */
    const savedText = (chatId: string): string | undefined => {
      const draft = useChatStore.getState().getTabDraft(chatId);
      return draft === undefined
        ? undefined
        : serializeEditorValue(draft).text.trim();
    };

    /** Expects the deleted task's composer to keep what the person left. */
    const expectKept = (from: number): void => {
      // Nothing makes a chat in a task the web core no longer holds, and no
      // change fails over it.
      expect(requestsFor('wt-1', from)).not.toContain('core.chat.create');
      expect(container.textContent).not.toContain('Change not saved');
      expect(shown('standalone-chat-load-error')).toBe(false);
      expect(notice()?.textContent).toContain('Chat deleted.');
      expect(container.textContent).toContain('Keep this draft');
      expect(useChatStore.getState().getTabDraft(OLD_CHAT)).toEqual(DRAFT);
      // Its row stays, marked deleted, though the web core no longer lists it.
      expect(newTaskRow('wt-1')).toMatchObject({ deleted: true });
    };

    // An earlier case leaves a draft in the task's second chat, which a
    // deleted task would keep; each case here starts without it.
    beforeEach(() => {
      useChatStore.getState().clearTabDraft('web-core:chat-2');
    });

    afterEach(() => {
      act(() => {
        // A deleted task's chat stays through offline: drop it, so the next
        // case reads the seeded task afresh.
        discardDeletedCloudTask({
          projectId: 'web-core:ws-1',
          worktreeId: 'web-core:wt-1',
        });
        cloudCoworkStore.getState().disconnect('offline');
      });
    });

    it('keeps the draft and its file, and starts a new chat with both, when the web core removes the task’s chat', async () => {
      await openWithDraft();
      await attach([diskFile('brief.md', '/Users/me/brief.md')]);
      expect(pills()).toEqual([expect.stringContaining('brief.md')]);
      const from = coreRequestLog.length;

      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expectKept(from);
      expect(pills()).toEqual([expect.stringContaining('brief.md')]);
      expect(notice()?.textContent).toContain(
        'It was deleted on another device. Your draft and attachments are still here.',
      );
      // A refresh that finds the task gone keeps it as it is.
      act(() => refreshChatScopeRevisioned('web-core:ws-1', 'web-core:wt-1'));
      await settle();
      expectKept(from);

      click('chat-input-chat-deleted-start');
      await settle();
      // One new task, in the same project, opened with the draft and the
      // file attached again from the disk, and nothing sent.
      expect([...startedTasks]).toHaveLength(1);
      const [newTask = ''] = [...startedTasks];
      expect([...createdTasks]).toEqual([newTask]);
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
        `web-core:${newTask}`,
      );
      expect(
        useChatStore.getState().getTabDraft(`web-core:${newTask}`),
      ).toEqual(DRAFT);
      expect(uploadsTo(newTask)).toEqual(['brief.md']);
      expect(pills()).toEqual([expect.stringContaining('brief.md')]);
      expect(requestsFor(newTask, from)).not.toContain(
        'core.chat.message.send',
      );
      // The deleted task's row and stored draft go with it.
      expect(newTaskRow('wt-1')).toBeUndefined();
      expect(storedDraft(OLD_CHAT)).toBeNull();
      expect(notice()).toBeNull();
      expect(callsCarryingWebCoreIds()).toEqual([]);
    });

    it('keeps the draft when the task’s event stream ends not found', async () => {
      await openWithDraft();
      const from = coreRequestLog.length;
      act(() => deleteTaskElsewhere('wt-1', 'not-found'));
      await settle();
      expectKept(from);
      expect(notice()?.textContent).toContain(
        'It was deleted on another device. Your draft is still here.',
      );
      // A new chat in the deleted task never reaches the web core, and no
      // change fails over it.
      const tabs = (): string[] | undefined =>
        useChatStore
          .getState()
          .worktreeChats[
            'web-core:ws-1/web-core:wt-1'
          ]?.tabs.map((tab) => tab.id);
      const before = tabs();
      act(() => {
        useChatStore.getState().createTab({
          projectId: 'web-core:ws-1',
          worktreeId: 'web-core:wt-1',
        });
      });
      await settle();
      expectKept(from);
      expect(requestsFor('wt-1', from)).toEqual([]);
      expect(tabs()).toEqual(before);
    });

    it('says the chat was deleted in every chat of a task whose stream ends not found, and starts a new chat from another chat’s draft', async () => {
      const NOTES = [
        { type: 'paragraph' as const, children: [{ text: 'Notes draft' }] },
      ];
      useChatStore.getState().saveTabDraft('web-core:chat-2', NOTES);
      await openWithDraft();
      const from = coreRequestLog.length;
      act(() => deleteTaskElsewhere('wt-1', 'not-found'));
      await settle();
      expectKept(from);
      // The task's other chat says so too, with its own draft kept.
      click('panel-tab-panel-chat-web-core:chat-2');
      await settle();
      expect(notice()?.textContent).toContain('Chat deleted.');
      expect(notice()?.textContent).toContain('Your draft is still here.');
      expect(container.textContent).toContain('Notes draft');
      expect(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="Send message"]',
        )?.disabled,
      ).toBe(true);

      // A new chat from it carries its draft; the task's own chat still
      // holds one, so the deleted row stays.
      click('chat-input-chat-deleted-start');
      await settle();
      const [newTask = ''] = [...startedTasks];
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
        `web-core:${newTask}`,
      );
      expect(
        useChatStore.getState().getTabDraft(`web-core:${newTask}`),
      ).toEqual(NOTES);
      expect(useChatStore.getState().getTabDraft('web-core:chat-2')).toBe(
        undefined,
      );
      expect(useChatStore.getState().getTabDraft(OLD_CHAT)).toEqual(DRAFT);
      expect(newTaskRow('wt-1')).toMatchObject({ deleted: true });
      expect(requestsFor('wt-1', from)).toEqual([]);
      // Back on the deleted task, its own chat still says so, with its draft.
      act(() => {
        openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
      });
      await settle();
      expectKept(from);
      expect(shown('panel-tab-panel-chat-web-core:chat-2')).toBe(false);
    });

    it('keeps every chat with a draft when the web core removes all the task’s chats, and one chat’s Discard leaves the other and the row', async () => {
      const NOTES = [
        { type: 'paragraph' as const, children: [{ text: 'Notes draft' }] },
      ];
      useChatStore.getState().saveTabDraft('web-core:chat-2', NOTES);
      await openWithDraft();
      const from = coreRequestLog.length;
      // tab.removed for the task's own chat and its second chat.
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expectKept(from);
      // The second chat stays reachable, with its own draft and the notice.
      expect(shown('panel-tab-panel-chat-web-core:chat-2')).toBe(true);
      click('panel-tab-panel-chat-web-core:chat-2');
      await settle();
      expect(notice()?.textContent).toContain('Chat deleted.');
      expect(container.textContent).toContain('Notes draft');
      expect(useChatStore.getState().getTabDraft('web-core:chat-2')).toEqual(
        NOTES,
      );

      // Discarding the second chat's draft leaves the own chat and the row.
      click('chat-input-chat-deleted-discard');
      await settle();
      click('chat-deleted-discard-confirm');
      await settle();
      expect(useChatStore.getState().getTabDraft('web-core:chat-2')).toBe(
        undefined,
      );
      expect(shown('panel-tab-panel-chat-web-core:chat-2')).toBe(false);
      expect(newTaskRow('wt-1')).toMatchObject({ deleted: true });
      act(() => {
        useChatStore.getState().switchTab(OLD_CHAT, {
          projectId: 'web-core:ws-1',
          worktreeId: 'web-core:wt-1',
        });
      });
      await settle();
      expectKept(from);

      // Start new chat from the last chat holding a draft: the row goes.
      click('chat-input-chat-deleted-start');
      await settle();
      const [newTask = ''] = [...startedTasks];
      expect(
        useChatStore.getState().getTabDraft(`web-core:${newTask}`),
      ).toEqual(DRAFT);
      expect(newTaskRow('wt-1')).toBeUndefined();
      expect(requestsFor('wt-1', from)).not.toContain('core.chat.create');
    });

    it('asks to attach a pasted file again, and starts the new chat with the draft alone', async () => {
      await openWithDraft();
      // Pasted, so the file has no path on this computer.
      await attach([
        new File(['# Pasted'], 'pasted.md', { type: 'text/markdown' }),
      ]);
      expect(pills()).toEqual([expect.stringContaining('pasted.md')]);
      const from = coreRequestLog.length;
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expectKept(from);
      expect(notice()?.textContent).toContain(
        'Your draft is still here. Attach your files again in the new chat.',
      );
      click('chat-input-chat-deleted-start');
      await settle();
      const [newTask = ''] = [...startedTasks];
      expect(
        useChatStore.getState().getTabDraft(`web-core:${newTask}`),
      ).toEqual(DRAFT);
      expect(uploadsTo(newTask)).toEqual([]);
      expect(pills()).toEqual([]);
      // The new chat still names the file to attach again.
      expect(notAttached()).toContain(
        "Couldn't attach pasted.md to the new chat. Attach it again.",
      );
      expect(newTaskRow('wt-1')).toBeUndefined();
    });

    it('names a file it couldn’t attach again on the new chat, and attaches the rest', async () => {
      await openWithDraft();
      // A file moved on disk after it was attached: it reads once, then not.
      const moved = diskFile('moved.md', '/Users/me/moved.md');
      let reads = 0;
      Object.defineProperty(moved, 'arrayBuffer', {
        value: (): Promise<ArrayBuffer> => {
          reads += 1;
          return reads === 1
            ? Promise.resolve(new TextEncoder().encode('# Moved').buffer)
            : Promise.reject(new Error('moved'));
        },
      });
      await attach([diskFile('brief.md', '/Users/me/brief.md'), moved]);
      expect(pills()).toEqual([
        expect.stringContaining('brief.md'),
        expect.stringContaining('moved.md'),
      ]);
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expectKept(coreRequestLog.length);
      click('chat-input-chat-deleted-start');
      await settle();
      const [newTask = ''] = [...startedTasks];
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
        `web-core:${newTask}`,
      );
      expect(uploadsTo(newTask)).toEqual(['brief.md']);
      expect(pills()).toEqual([expect.stringContaining('brief.md')]);
      expect(notAttached()).toContain(
        "Couldn't attach moved.md to the new chat. Attach it again.",
      );
      // The deleted task goes once the new one exists, as before.
      expect(newTaskRow('wt-1')).toBeUndefined();
    });

    it('keeps a Deleted row, its draft and its file through going offline and back', async () => {
      await openWithDraft();
      await attach([diskFile('brief.md', '/Users/me/brief.md')]);
      const from = coreRequestLog.length;
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expectKept(from);

      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
      await settle();
      expect(shown('standalone-chat-offline')).toBe(true);
      // Back online, the web core lists the task no more, yet its row,
      // draft and file are all still here, and it is still deleted.
      await connectCowork();
      await settle();
      expect(shown('standalone-chat-offline')).toBe(false);
      expectKept(from);
      expect(pills()).toEqual([expect.stringContaining('brief.md')]);
      click('chat-input-chat-deleted-start');
      await settle();
      const [newTask = ''] = [...startedTasks];
      expect(
        useChatStore.getState().getTabDraft(`web-core:${newTask}`),
      ).toEqual(DRAFT);
      expect(uploadsTo(newTask)).toEqual(['brief.md']);
      expect(newTaskRow('wt-1')).toBeUndefined();
    });

    it('offers Copy draft beside Try again when the new chat can’t be created, and keeps the deleted task', async () => {
      const copied: string[] = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string): Promise<void> => {
            copied.push(text);
            return Promise.resolve();
          },
        },
      });
      await openWithDraft();
      const from = coreRequestLog.length;
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expectKept(from);
      // The project itself is gone too: the web core refuses the new task.
      createRefusal = 'The project was not found.';
      click('chat-input-chat-deleted-start');
      await settle();
      const [newTask = ''] = [...startedTasks];
      expect(createdTasks.size).toBe(0);
      expect(newTaskRow(newTask)).toMatchObject({ creation: 'failed' });
      expect(shown('chat-input-cloud-task-creation-retry')).toBe(true);
      // Copy draft puts the draft's text on the clipboard, so it is never
      // stranded in a task that can't be created.
      click('chat-input-cloud-task-creation-copy-draft');
      await settle();
      expect(copied).toEqual(['Keep this draft']);
      // The deleted task keeps its draft and its row.
      expect(useChatStore.getState().getTabDraft(OLD_CHAT)).toEqual(DRAFT);
      expect(newTaskRow('wt-1')).toMatchObject({ deleted: true });
    });

    it('carries text typed since the last save, keeps it when the new task is refused, and confirms its Discard', async () => {
      const TYPED = 'Typed since it opened';
      useStandaloneChatStore.getState().clearActiveWorkEntry();
      renderPage({ followsEvents: true });
      await connectCowork();
      act(() => {
        openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
      });
      await settle();
      act(() => {
        useChatStore.getState().switchTab(OLD_CHAT, {
          projectId: 'web-core:ws-1',
          worktreeId: 'web-core:wt-1',
        });
      });
      await settle();
      // Text reaches the composer as typing does: the editor changes and its
      // write waits, while the store's draft map hasn't seen it.
      act(() => {
        document.dispatchEvent(
          new CustomEvent(INSERT_CHAT_TEXT_EVENT, {
            detail: { text: TYPED, targetTabId: OLD_CHAT },
          }),
        );
      });
      await settle();
      expect(container.textContent).toContain(TYPED);
      expect(useChatStore.getState().tabDrafts[OLD_CHAT]).toBeUndefined();
      const textOf = (chatId: string): string | undefined => {
        const draft = useChatStore.getState().getTabDraft(chatId);
        return draft === undefined
          ? undefined
          : serializeEditorValue(draft).text.trim();
      };

      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expect(notice()?.textContent).toContain('Chat deleted.');
      expect(newTaskRow('wt-1')).toMatchObject({ deleted: true });

      // The typed text is lost for good if discarded, so it asks first.
      click('chat-input-chat-deleted-discard');
      await settle();
      expect(
        document.querySelector('[data-testid="chat-deleted-discard-confirm"]'),
      ).not.toBeNull();
      click('chat-deleted-discard-cancel');
      await settle();

      // A refused new task carries exactly that text, and the source keeps it.
      createRefusal = 'The project was not found.';
      click('chat-input-chat-deleted-start');
      await settle();
      const [newTask = ''] = [...startedTasks];
      expect(createdTasks.size).toBe(0);
      expect(textOf(`web-core:${newTask}`)).toBe(TYPED);
      expect(textOf(OLD_CHAT)).toBe(TYPED);
      expect(newTaskRow('wt-1')).toMatchObject({ deleted: true });
    });

    it('keeps Send off while a file attaches again to the new chat, and sends it with the file', async () => {
      await openWithDraft();
      await attach([diskFile('brief.md', '/Users/me/brief.md')]);
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expectKept(coreRequestLog.length);
      // The new chat's upload is slow.
      let release = (): void => undefined;
      uploadGate = new Promise((resolve) => {
        release = resolve;
      });
      try {
        click('chat-input-chat-deleted-start');
        await settle();
        const [newTask = ''] = [...startedTasks];
        expect(createdTasks.has(newTask)).toBe(true);
        expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
          `web-core:${newTask}`,
        );
        const send = (): HTMLButtonElement | null =>
          container.querySelector('button[aria-label="Send message"]');
        expect(container.textContent).toContain('Keep this draft');
        expect(send()?.disabled).toBe(true);
        release();
        await settle();
        expect(pills()).toEqual([expect.stringContaining('brief.md')]);
        expect(send()?.disabled).toBe(false);
        act(() => {
          send()?.click();
        });
        await settle();
        const sent = coreRequestLog.filter(
          (entry) =>
            entry.method === 'core.chat.message.send' &&
            entry.params.chatId === newTask,
        );
        expect(sent).toHaveLength(1);
        expect(sent[0]?.params.attachments).toEqual([
          { attachmentId: 'att-brief.md' },
        ]);
      } finally {
        release();
        uploadGate = null;
      }
    });

    it('keeps an edit made to the deleted chat while its new task is created', async () => {
      await openWithDraft();
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expectKept(coreRequestLog.length);
      let created = (): void => undefined;
      createGate = new Promise<void>((resolve) => {
        created = resolve;
      });
      click('chat-input-chat-deleted-start');
      await settle();
      const [newTask = ''] = [...startedTasks];
      expect(createdTasks.size).toBe(0);
      // Back on the deleted chat while the create waits, the person types.
      act(() => {
        openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
      });
      await settle();
      act(() => {
        useChatStore.getState().switchTab(OLD_CHAT, {
          projectId: 'web-core:ws-1',
          worktreeId: 'web-core:wt-1',
        });
      });
      await settle();
      await typeInto(OLD_CHAT, 'Added while it was created');
      createGate = null;
      created();
      await settle();
      expect(createdTasks.has(newTask)).toBe(true);
      // The new chat has what was carried; the edit stays on the deleted
      // chat, which keeps its notice and its row.
      expect(savedText(`web-core:${newTask}`)).toBe('Keep this draft');
      expect(savedText(OLD_CHAT)).toContain('Added while it was created');
      expect(newTaskRow('wt-1')).toMatchObject({ deleted: true });
      expect(notice()?.textContent).toContain('Chat deleted.');
    });

    /** Records what Copy draft puts on the clipboard. */
    const stubClipboard = (): string[] => {
      const copied: string[] = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string): Promise<void> => {
            copied.push(text);
            return Promise.resolve();
          },
        },
      });
      return copied;
    };

    it('copies the carried draft as edited after the new task is refused', async () => {
      const copied = stubClipboard();
      await openWithDraft();
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expectKept(coreRequestLog.length);
      createRefusal = 'The project was not found.';
      click('chat-input-chat-deleted-start');
      await settle();
      const [newTask = ''] = [...startedTasks];
      expect(newTaskRow(newTask)).toMatchObject({ creation: 'failed' });
      await typeInto(`web-core:${newTask}`, 'Edited after it was refused');
      click('chat-input-cloud-task-creation-copy-draft');
      await settle();
      expect(copied).toEqual([
        'Keep this draft\n\nEdited after it was refused',
      ]);
    });

    it('offers Copy draft for text typed into a refused new task from the sidebar', async () => {
      const copied = stubClipboard();
      renderPage({ followsEvents: true });
      await connectCowork();
      createRefusal = 'This project is full.';
      act(() => {
        void createCloudSidebarTask('web-core:ws-1');
      });
      await settle();
      const taskId = createdChatIds.at(-1) ?? '';
      expect(newTaskRow(taskId)).toMatchObject({ creation: 'failed' });
      await typeInto(`web-core:${taskId}`, 'Typed into a task that failed');
      expect(shown('chat-input-cloud-task-creation-copy-draft')).toBe(true);
      click('chat-input-cloud-task-creation-copy-draft');
      await settle();
      expect(copied).toEqual(['Typed into a task that failed']);
    });

    it('says the draft is still here for text typed after the deletion', async () => {
      await openWithDraft();
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expectKept(coreRequestLog.length);
      // The person clears the composer, then types again.
      act(() => {
        useChatStore.getState().clearTabDraft(OLD_CHAT);
        document.dispatchEvent(
          new CustomEvent(DISCARD_CHAT_DRAFT_EVENT, {
            detail: { tabId: OLD_CHAT },
          }),
        );
      });
      await settle();
      expect(notice()?.textContent).not.toContain('Your draft is still here.');
      await typeInto(OLD_CHAT, 'Typed after it was deleted');
      expect(notice()?.textContent).toContain('Your draft is still here.');
    });

    /** Opens the seeded task with nothing unsent, then deletes it. */
    const deleteWhileEmpty = async (): Promise<void> => {
      useStandaloneChatStore.getState().clearActiveWorkEntry();
      useChatStore.getState().clearTabDraft(OLD_CHAT);
      renderPage({ followsEvents: true });
      await connectCowork();
      act(() => {
        openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
      });
      await settle();
      act(() => {
        useChatStore.getState().switchTab(OLD_CHAT, {
          projectId: 'web-core:ws-1',
          worktreeId: 'web-core:wt-1',
        });
      });
      await settle();
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expect(notice()?.textContent).toContain('Chat deleted.');
    };
    const SCOPE_KEY = 'web-core:ws-1/web-core:wt-1';

    it('keeps a draft typed after an empty task was deleted through offline, and shows its row again', async () => {
      await deleteWhileEmpty();
      await typeInto(OLD_CHAT, 'Typed after it was deleted');
      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
      await settle();
      expect(useChatStore.getState().worktreeChats[SCOPE_KEY]).toBeDefined();
      expect(savedText(OLD_CHAT)).toBe('Typed after it was deleted');
      await connectCowork();
      await settle();
      expect(newTaskRow('wt-1')).toMatchObject({ deleted: true });
      expect(notice()?.textContent).toContain('Chat deleted.');
      expect(container.textContent).toContain('Typed after it was deleted');
    });

    it('cleans up an empty deleted task when going offline, and shows no row again', async () => {
      await deleteWhileEmpty();
      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
      await settle();
      expect(useChatStore.getState().worktreeChats[SCOPE_KEY]).toBeUndefined();
      await connectCowork();
      await settle();
      expect(newTaskRow('wt-1')).toBeUndefined();
    });

    it('shows the Deleted row once text is typed into an empty deleted task', async () => {
      await deleteWhileEmpty();
      await typeInto(OLD_CHAT, 'Typed after it was deleted');
      expect(newTaskRow('wt-1')).toMatchObject({ deleted: true });
    });

    for (const order of [
      ['chat-2', 'wt-1'],
      ['wt-1', 'chat-2'],
    ] as const)
      it(`keeps both chats' drafts when the web core removes them one item each, ${order[0]} first`, async () => {
        const NOTES = [
          { type: 'paragraph' as const, children: [{ text: 'Notes draft' }] },
        ];
        useChatStore.getState().saveTabDraft('web-core:chat-2', NOTES);
        await openWithDraft();
        const from = coreRequestLog.length;
        act(() => deleteTaskElsewhere('wt-1', 'tab-removed', order));
        await settle();
        expectKept(from);
        expect(shown('panel-tab-panel-chat-web-core:chat-2')).toBe(true);
        click('panel-tab-panel-chat-web-core:chat-2');
        await settle();
        expect(notice()?.textContent).toContain('Chat deleted.');
        expect(container.textContent).toContain('Notes draft');
        expect(useChatStore.getState().getTabDraft('web-core:chat-2')).toEqual(
          NOTES,
        );
        expect(requestsFor('wt-1', from)).not.toContain('core.chat.create');
      });

    it('keeps only a second chat with a draft deleted while its task stays, and the own chat still sends', async () => {
      const NOTES = [
        { type: 'paragraph' as const, children: [{ text: 'Notes draft' }] },
      ];
      useChatStore.getState().saveTabDraft('web-core:chat-2', NOTES);
      await openWithDraft();
      const from = coreRequestLog.length;
      act(() => removeChatElsewhere('wt-1', 'chat-2'));
      await settle();
      const deletedRow = (): unknown =>
        (newTaskRow('wt-1') as { deleted?: boolean } | undefined)?.deleted;
      // The task is live: its own chat has no notice, and no Deleted row.
      expect(notice()).toBeNull();
      expect(deletedRow()).toBeUndefined();
      // The second chat is kept, read-only, with its draft and the notice.
      expect(shown('panel-tab-panel-chat-web-core:chat-2')).toBe(true);
      click('panel-tab-panel-chat-web-core:chat-2');
      await settle();
      expect(notice()?.textContent).toContain('Chat deleted.');
      expect(container.textContent).toContain('Notes draft');
      const send = (): HTMLButtonElement | null =>
        container.querySelector('button[aria-label="Send message"]');
      expect(send()?.disabled).toBe(true);

      // The own chat still sends to the web core.
      act(() => {
        useChatStore.getState().switchTab(OLD_CHAT, {
          projectId: 'web-core:ws-1',
          worktreeId: 'web-core:wt-1',
        });
      });
      await settle();
      expect(notice()).toBeNull();
      expect(send()?.disabled).toBe(false);
      act(() => {
        send()?.click();
      });
      await settle();
      expect(
        coreRequestLog
          .slice(from)
          .filter(
            (entry) =>
              entry.method === 'core.chat.message.send' &&
              entry.params.chatId === 'wt-1',
          ),
      ).toHaveLength(1);
      expect(requestsFor('wt-1', from)).not.toContain('core.chat.create');

      // Discarding the kept chat drops it alone; the task stays live.
      click('panel-tab-panel-chat-web-core:chat-2');
      await settle();
      click('chat-input-chat-deleted-discard');
      await settle();
      click('chat-deleted-discard-confirm');
      await settle();
      expect(shown('panel-tab-panel-chat-web-core:chat-2')).toBe(false);
      expect(useChatStore.getState().getTabDraft('web-core:chat-2')).toBe(
        undefined,
      );
      expect(deletedRow()).toBeUndefined();
      expect(newTaskRow('wt-1')).toBeDefined();
    });

    it('keeps a second chat deleted on its own through offline, while its live task is cleaned up and comes back', async () => {
      const NOTES = [
        { type: 'paragraph' as const, children: [{ text: 'Notes draft' }] },
      ];
      useChatStore.getState().saveTabDraft('web-core:chat-2', NOTES);
      await openWithDraft();
      const from = coreRequestLog.length;
      act(() => removeChatElsewhere('wt-1', 'chat-2'));
      await settle();
      expect(shown('panel-tab-panel-chat-web-core:chat-2')).toBe(true);
      const scope = { projectId: 'web-core:ws-1', worktreeId: 'web-core:wt-1' };
      const deletedRow = (): unknown =>
        (newTaskRow('wt-1') as { deleted?: boolean } | undefined)?.deleted;

      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
      await settle();
      // The live task is cleaned up as usual; the kept chat stays deleted,
      // with its draft saved.
      expect(
        useChatStore.getState().worktreeChats['web-core:ws-1/web-core:wt-1'],
      ).toBeUndefined();
      expect(isCloudChatDeleted(scope, 'web-core:chat-2')).toBe(true);
      expect(storedDraft('web-core:chat-2')).not.toBeNull();

      await connectCowork();
      await settle();
      // Back: the task is read afresh, and the kept chat is there again
      // with its draft and notice; the task stays live, with no Deleted row.
      expect(shown('panel-tab-panel-chat-web-core:chat-2')).toBe(true);
      click('panel-tab-panel-chat-web-core:chat-2');
      await settle();
      expect(notice()?.textContent).toContain('Chat deleted.');
      expect(container.textContent).toContain('Notes draft');
      expect(deletedRow()).toBeUndefined();
      act(() => {
        useChatStore.getState().switchTab(OLD_CHAT, scope);
      });
      await settle();
      expect(notice()).toBeNull();
      const send = (): HTMLButtonElement | null =>
        container.querySelector('button[aria-label="Send message"]');
      expect(send()?.disabled).toBe(false);
      act(() => {
        send()?.click();
      });
      await settle();
      expect(
        coreRequestLog
          .slice(from)
          .filter(
            (entry) =>
              entry.method === 'core.chat.message.send' &&
              entry.params.chatId === 'wt-1',
          ),
      ).toHaveLength(1);
      expect(requestsFor('wt-1', from)).not.toContain('core.chat.create');
    });

    /** Attachment reads and deletes the web core was asked for `chatId`. */
    const attachmentCallsFor = (chatId: string, from: number): string[] =>
      coreRequestLog
        .slice(from)
        .filter(
          (entry) =>
            ['core.artifact.list', 'worker.artifact.delete'].includes(
              entry.method,
            ) &&
            (Reflect.get(Object(entry.params.owner), 'id') === chatId ||
              Reflect.get(Object(entry.params.scope), 'chatId') === chatId),
        )
        .map((entry) => entry.method);
    /** Opens the Activity tab, and picks a file in its Attachments card. */
    const openRailAndPick = async (file: File): Promise<void> => {
      act(() => {
        container
          .querySelector<HTMLElement>(
            '[data-testid="panel-tab-panel-activity"]',
          )
          ?.click();
      });
      await settle();
      const pick = jest
        .spyOn(HTMLInputElement.prototype, 'click')
        .mockImplementation(function (this: HTMLInputElement) {
          Object.defineProperty(this, 'files', { value: [file] });
          this.dispatchEvent(new Event('change'));
        });
      try {
        act(() => {
          container
            .querySelector<HTMLElement>('[data-testid="cloud-attachments-add"]')
            ?.click();
        });
        await settle();
      } finally {
        pick.mockRestore();
      }
    };

    it('asks the web core nothing about a deleted task’s attachments, from the composer or the Attachments card', async () => {
      servesAttachmentList = true;
      await openWithDraft();
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expectKept(coreRequestLog.length);
      const from = coreRequestLog.length;
      const uploadsBefore = uploadsTo('wt-1').length;
      // A file attached in the deleted chat's composer.
      await attach([diskFile('late.md', '/Users/me/late.md')]);
      // The Attachments card, opened on the deleted chat, and a file picked.
      await openRailAndPick(
        new File(['# Rail'], 'rail.md', { type: 'text/markdown' }),
      );
      expect(attachmentCallsFor('wt-1', from)).toEqual([]);
      expect(uploadsTo('wt-1').length).toBe(uploadsBefore);
    });

    it('asks the web core nothing about a kept chat’s attachments while its task stays', async () => {
      servesAttachmentList = true;
      const NOTES = [
        { type: 'paragraph' as const, children: [{ text: 'Notes draft' }] },
      ];
      useChatStore.getState().saveTabDraft('web-core:chat-2', NOTES);
      await openWithDraft();
      act(() => removeChatElsewhere('wt-1', 'chat-2'));
      await settle();
      const from = coreRequestLog.length;
      act(() => {
        useChatStore.getState().switchTab('web-core:chat-2', {
          projectId: 'web-core:ws-1',
          worktreeId: 'web-core:wt-1',
        });
      });
      await settle();
      expect(notice()?.textContent).toContain('Chat deleted.');
      const uploads = (): number =>
        calls.filter(
          (call) =>
            call.path === CLOUD_UPLOAD &&
            Reflect.get(Object(call.args[0]), 'key') === 'web-core:chat-2',
        ).length;
      const uploadsBefore = uploads();
      await openRailAndPick(
        new File(['# Rail'], 'rail.md', { type: 'text/markdown' }),
      );
      expect(attachmentCallsFor('chat-2', from)).toEqual([]);
      expect(uploads()).toBe(uploadsBefore);
    });

    it('discards the deleted task’s draft after a confirm, and its row goes', async () => {
      await openWithDraft();
      const from = coreRequestLog.length;
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expectKept(from);
      click('chat-input-chat-deleted-discard');
      await settle();
      // The draft has text, so it asks first; Cancel keeps everything.
      expect(
        document.querySelector('[data-testid="chat-deleted-discard-confirm"]'),
      ).not.toBeNull();
      click('chat-deleted-discard-cancel');
      await settle();
      expectKept(from);
      click('chat-input-chat-deleted-discard');
      await settle();
      click('chat-deleted-discard-confirm');
      await settle();
      expect(useChatStore.getState().getTabDraft(OLD_CHAT)).toBeUndefined();
      expect(storedDraft(OLD_CHAT)).toBeNull();
      expect(newTaskRow('wt-1')).toBeUndefined();
      expect(
        useChatStore.getState().worktreeChats['web-core:ws-1/web-core:wt-1'],
      ).toBeUndefined();
      expect(useStandaloneChatStore.getState().activeWorkEntryId).not.toBe(
        'web-core:wt-1',
      );
      expect(requestsFor('wt-1', from)).not.toContain('core.chat.create');
      expect(startedTasks.size).toBe(0);
    });
  });

  it("uploads every file picked in an empty cloud chat's Attachments card, though the first one fills it (CAN-6175 R8d)", async () => {
    servesAttachmentList = true;
    let release = (): void => undefined;
    uploadGate = new Promise((resolve) => {
      release = resolve;
    });
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="panel-tab-panel-activity"]')
        ?.click();
    });
    await settle();
    expect(shown('cloud-attachments-add')).toBe(true);

    const files = ['one.md', 'two.md', 'three.md'].map(
      (name) => new File([`# ${name}`], name, { type: 'text/markdown' }),
    );
    const click = jest
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(function (this: HTMLInputElement) {
        Object.defineProperty(this, 'files', { value: files });
        this.dispatchEvent(new Event('change', { bubbles: true }));
      });
    try {
      act(() => {
        container
          .querySelector<HTMLElement>('[data-testid="cloud-attachments-add"]')
          ?.click();
      });
      await settle();
    } finally {
      click.mockRestore();
    }
    // The first upload is under way and the other two wait their turn.
    expect(calls.filter((call) => call.path === CLOUD_UPLOAD).length).toBe(1);

    // The first lands and the card lists it. The card keeps its upload
    // queue, so the other two follow, and all three are listed.
    release();
    uploadGate = null;
    for (let i = 0; i < 5; i += 1) await settle();
    expect(
      calls
        .filter((call) => call.path === CLOUD_UPLOAD)
        .map((call) => String(Reflect.get(Object(call.args[1]), 'name'))),
    ).toEqual(['one.md', 'two.md', 'three.md']);
    for (const name of ['one.md', 'two.md', 'three.md'])
      expect(container.textContent).toContain(name);
  });

  it("offers a cloud task's Cost once the web core serves it, and reads it there, not from this computer (CAN-6180)", async () => {
    servesCost = true;
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    // The capability follows the manifest, which loads after first render.
    await settle();
    // The add menu offers the Cost panel (the Activity Cost card is that
    // panel, CAN-6432), and the rail's allowlist names its section.
    const capabilities = cloudScopeCapabilitiesNow();
    expect(capabilities.costInsights).toBe(true);
    expect(capabilities.activitySectionIds).toContain('cost');
    expect(panelKindsUnavailableFor(capabilities)).not.toContain('cost');
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="panel-tab-panel-activity"]')
        ?.click();
    });
    await settle();
    expect(shown('activity-section-cost')).toBe(true);
    expect(coreRequests).toContain('core.runtime.manifest.get');
    expect(
      coreRequestLog
        .filter((entry) => entry.method === 'core.cost.scope.get')
        .map((entry) => entry.params.scope),
    ).toContainEqual({ kind: 'entry', projectId: 'ws-1', worktreeId: 'wt-1' });
    // The cost read never reaches main with the cloud task's ids.
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("shows a cloud task's cost in AI Credits, and never USD for an account that bills only to AI Credits (CAN-6180)", async () => {
    servesCost = true;
    const costText = async (): Promise<string> => {
      renderPage();
      act(() => {
        openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
      });
      await settle();
      await settle();
      act(() => {
        container
          .querySelector<HTMLElement>(
            '[data-testid="panel-tab-panel-activity"]',
          )
          ?.click();
      });
      await settle();
      return (
        container.querySelector('[data-testid="activity-section-cost"]')
          ?.textContent ?? ''
      );
    };
    // Every turn here bills to AI Credits: $0.45 is 3 credits.
    setRendererBillingLaneAvailability({
      claudeNativeAuth: false,
      codexNativeAuth: false,
      creditsEligible: true,
    });
    const creditsOnly = await costText();
    expect(creditsOnly).toContain('3 credits');
    expect(creditsOnly).not.toContain('$');
    act(() => root.unmount());
    root = createRoot(container);
    // An account with its own Claude access sees credits with USD alongside.
    setRendererBillingLaneAvailability({
      claudeNativeAuth: true,
      codexNativeAuth: false,
      creditsEligible: true,
    });
    expect(await costText()).toContain('3 credits · $0.45');
  });

  it("labels a cloud task's Cost with the day it starts when its earlier usage isn't counted (CAN-6668)", async () => {
    servesCost = true;
    costCoverageStart = '2026-11-13';
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    await settle();
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="panel-tab-panel-activity"]')
        ?.click();
    });
    await settle();
    const section =
      container.querySelector('[data-testid="activity-section-cost"]')
        ?.textContent ?? '';
    // The total and the chat's row both say where the data starts.
    expect(section.match(/\$0\.45 since Nov 13/g)?.length).toBe(2);
  });

  it("lists a cloud chat's MCP servers in its Activity from the web core catalog, asking this computer nothing (CAN-6608)", async () => {
    savedSelection = ['mcp_server:linear/default'];
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="panel-tab-panel-activity"]')
        ?.click();
    });
    await settle();
    const activity =
      container.querySelector('[data-testid="activity-panel"]')?.textContent ??
      '';
    // The chat's selected server, with the state its catalog names.
    expect(activity).toContain('MCP servers');
    expect(activity).toContain('Linear');
    expect(activity).toContain('Connected');
    expect(coreRequests).toContain('core.catalog.snapshot.get');
    // This computer's MCP detection never hears of the cloud chat's servers.
    expect(
      calls.filter((call) => call.path === 'mcpServers.listDetected'),
    ).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });
  it("shows every selected server in its Activity with its state, also those the web core won't run now (CAN-6608)", async () => {
    extraMcpServers = [
      ['figma', 'Figma', 'reauth_required', 'auth_required'],
      ['notion', 'Notion', undefined, 'auth_required'],
      ['sentry', 'Sentry', 'not_connected', 'auth_required'],
      ['postgres', 'Local Postgres', 'desktop_only', 'incompatible'],
      ['jira', 'Jira', 'connected', 'disabled'],
    ];
    savedSelection = [
      'mcp_server:linear/default',
      ...extraMcpServers.map(([id]) => `mcp_server:${id}/default`),
    ];
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="panel-tab-panel-activity"]')
        ?.click();
    });
    await settle();
    const activity =
      container.querySelector('[data-testid="activity-panel"]')?.textContent ??
      '';
    for (const [name, state] of [
      ['Linear', 'Connected'],
      ['Figma', 'Needs sign-in'],
      // Signing in is all it lacks, though the catalog names no state.
      ['Notion', 'Needs sign-in'],
      ['Sentry', 'Not connected'],
      ['Local Postgres', 'On this desktop'],
      ['Jira', 'Turned off'],
    ])
      expect(activity).toContain(`${name}${state}`);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it('reads the Activity MCP servers again once a picker save of the chat settles (CAN-6608)', async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="panel-tab-panel-activity"]')
        ?.click();
    });
    await settle();
    expect(shown('activity-mcp-add')).toBe(true);
    // The picker saves through its own catalog and tracks the save.
    const tabId =
      useChatStore.getState().worktreeChats['web-core:ws-1/web-core:wt-1']
        ?.activeTabId;
    if (tabId === undefined) throw new Error('no active cloud chat');
    savedSelection = ['mcp_server:linear/default'];
    await act(async () => {
      trackSelectionSave(tabId, Promise.resolve());
      await Promise.resolve();
    });
    await settle();
    const activity =
      container.querySelector('[data-testid="activity-panel"]')?.textContent ??
      '';
    expect(activity).toContain('Linear');
    expect(shown('activity-mcp-add')).toBe(false);
  });
  it("shows a cloud task's servers in the MCP servers card opened on its own, asking this computer nothing (CAN-6608)", async () => {
    savedSelection = ['mcp_server:linear/default'];
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const section = ACTIVITY_SECTIONS.find(
      (definition) => definition.id === 'mcp-servers',
    );
    if (section === undefined) throw new Error('no MCP servers section');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const cardRoot = createRoot(host);
    const before = calls.length;
    try {
      act(() => {
        cardRoot.render(
          section.render({
            projectId: 'web-core:ws-1',
            worktreeId: 'web-core:wt-1',
          }),
        );
      });
      await settle();
      expect(host.textContent).toContain('Linear');
      expect(host.textContent).toContain('Connected');
      expect(
        calls
          .slice(before)
          .filter((call) => call.path === 'mcpServers.listDetected'),
      ).toEqual([]);
      expect(callsCarryingWebCoreIds()).toEqual([]);
    } finally {
      act(() => {
        cardRoot.unmount();
      });
      host.remove();
    }
  });

  it('never offers "Add MCP server" while the cloud chat\'s catalog is still being read (CAN-6608)', async () => {
    savedSelection = ['mcp_server:linear/default'];
    let release = (): void => undefined;
    catalogGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="panel-tab-panel-activity"]')
        ?.click();
    });
    await settle();
    expect(shown('activity-mcp-add')).toBe(false);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await settle();
    expect(
      container.querySelector('[data-testid="activity-panel"]')?.textContent,
    ).toContain('Linear');
    expect(shown('activity-mcp-add')).toBe(false);
  });
  it('refreshes the cloud MCP servers card opened on its own, and reads again when the window comes back from the web (CAN-6608)', async () => {
    extraMcpServers = [['figma', 'Figma', 'reauth_required', 'auth_required']];
    savedSelection = ['mcp_server:linear/default'];
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const section = ACTIVITY_SECTIONS.find(
      (definition) => definition.id === 'mcp-servers',
    );
    if (section === undefined) throw new Error('no MCP servers section');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const cardRoot = createRoot(host);
    try {
      act(() => {
        cardRoot.render(
          section.render({
            projectId: 'web-core:ws-1',
            worktreeId: 'web-core:wt-1',
          }),
        );
      });
      await settle();
      expect(host.textContent).not.toContain('Figma');
      // Selected elsewhere: Refresh reads it.
      savedSelection = [
        'mcp_server:linear/default',
        'mcp_server:figma/default',
      ];
      act(() => {
        host
          .querySelector<HTMLElement>(
            '[data-testid="mcp-servers-card-refresh"]',
          )
          ?.click();
      });
      await settle();
      expect(host.textContent).toContain('FigmaNeeds sign-in');
      // Signed in on the web: coming back to the window reads it again.
      extraMcpServers = [['figma', 'Figma', 'connected', 'available']];
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await settle();
      expect(host.textContent).toContain('FigmaConnected');
    } finally {
      act(() => {
        cardRoot.unmount();
      });
      host.remove();
    }
  });
});

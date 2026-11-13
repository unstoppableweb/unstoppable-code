/** @jest-environment jsdom */
import '../../../cloud-chats/__tests__/jsdom-globals';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state/CanopyClientProvider';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
// eslint-disable-next-line no-restricted-imports
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import { DesktopTerminalRuntime } from '@/client/DesktopTerminalRuntime';
import {
  createDesktopCanopyClient,
  createDesktopCapabilities,
} from '@/client/ipc-canopy-client';
import { cloudCoworkStore } from '@/cloud-chats/cloud-cowork-store';
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
import { initClaudeModels } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useExperimentalFeaturesStore } from '@/stores/experimentalFeaturesStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { StandaloneChatPage } from '../StandaloneChatPage';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { MessageImages } from '../../chat/MessageImages';
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

/** Main's upload takes every file the web core would; its answer names it. */
function uploadReply(_target: unknown, file: unknown): unknown {
  const { name, mimeType, bytes } = file as {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  };
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

// Every preload bridge records its calls.
function recordingBridge(path: string): unknown {
  const call = (...args: unknown[]): unknown => {
    calls.push({ path, args });
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

/** A request's scope worktree, under whichever field the method names it. */
function worktreeOf(params: Record<string, unknown> | undefined): unknown {
  const scope = params?.scope;
  return typeof scope === 'object' && scope !== null && 'worktreeId' in scope
    ? scope.worktreeId
    : params?.worktreeId;
}
/** The model the snapshot names for the task's own chat. */
let snapshotModel: string | undefined = 'cloud-model';
/** The snapshot's revision, which a change made since moves past. */
let snapshotRevision = 1;
/** Holds each transcript page reply until released. */
let pageGate: Promise<void> | null = null;
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
    }): Promise<unknown> => {
      // Each task's chat is the task itself.
      const scoped = worktreeOf(request.params);
      const task = typeof scoped === 'string' ? scoped : 'wt-1';
      const ok = (value: unknown): Promise<unknown> =>
        Promise.resolve({ ok: true, value });
      if (request.kind === 'openStream') return ok({ subscriptionId: 's1' });
      if (request.kind === 'readStream') return new Promise(() => {});
      if (request.kind === 'closeStream') return ok(null);
      if (request.method !== undefined) {
        coreRequests.push(request.method);
        coreRequestLog.push({
          method: request.method,
          params: request.params ?? {},
        });
      }
      const newTask = worktreeOf(request.params);
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
              {
                workspaceId: 'ws-1',
                worktreeId: 'wt-1',
                title: 'Draft the brief',
                state: 'idle',
                updatedAt: CREATED_AT,
                revision: 1,
              },
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
          return ok({
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
                {
                  chatId: 'chat-2',
                  title: 'Notes',
                  kind: 'chat',
                  createdAt: CREATED_AT,
                },
              ],
            },
            archives: [],
            runtimeByChatId: {
              [task]: { status: 'idle', queuedMessageIds: [] },
              'chat-2': { status: 'idle', queuedMessageIds: [] },
            },
            queue: [],
          });
        case 'core.chat.transcript.page': {
          const page = ok({
            messages: [],
            totalMessages: 0,
            transcriptRevision: 1,
          });
          return (pageGate ?? Promise.resolve()).then(() => page);
        }
        case 'core.catalog.snapshot.get':
          return ok({
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
            ],
          });
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
          return ok({
            commandId: request.params?.commandId,
            revision: 3,
            outcome: 'applied',
            entityId: 'turn-1',
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
          return ok({
            entries:
              request.params?.relativePath === 'docs'
                ? [entry('docs/brief.md', 'file')]
                : [entry('docs', 'directory'), entry('brief.md', 'file')],
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
              {
                chatId: 'chat-2',
                title: 'Notes',
                state: 'idle',
                workspaceId: 'ws-1',
                worktreeId: task,
                revision: 1,
                createdAt: CREATED_AT,
              },
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
  updateGate = null;
  coreRequests.length = 0;
  coreRequestLog.length = 0;
  createGate = null;
  createRefusal = null;
  sendRefusal = null;
  sendGate = null;
  sendOutcomeUnknown = false;
  createdTasks.clear();
  loseCreateReply = false;
  servesCoworkLists = false;
  snapshotModel = 'cloud-model';
  snapshotRevision = 1;
  pageGate = null;
  setModelRefusal = null;
  cloudModelLevels = ['low', 'medium', 'high'];
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
  act(() => root.unmount());
  container.remove();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

function renderPage(): void {
  const client = createDesktopCanopyClient(
    createDesktopCapabilities('darwin', {}, {}),
  );
  act(() => {
    root.render(
      <CanopyClientProvider client={client}>
        <DesktopTerminalRuntime />
        <StandaloneChatPage />
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

  it('a local scope keeps every composer and tab control a cloud scope hides', () => {
    const local = createDesktopCapabilities('darwin', {}, {});
    const cloud = webCoreScopeCapabilities(local);
    for (const key of [
      'chatApprovalMode',
      'chatTabFork',
      'chatRootTabLifecycle',
      'chatQueueEdits',
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
    // Only the sections the web core feeds: no Cost (no cost insights), no
    // Summary, MCP servers, Notes, Prompts, Attachments or Memory, which
    // would read this computer with the cloud task's ids.
    expect(cards('web-core:ws-1/web-core:wt-1').sort()).toEqual([
      'background-processes',
      'todo',
    ]);
    // With no agent tasks yet, the Activity tab says so rather than staying
    // blank.
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="panel-tab-panel-activity"]')
        ?.click();
    });
    await settle();
    expect(shown('activity-list-empty')).toBe(true);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });
});

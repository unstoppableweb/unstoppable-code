/** @jest-environment jsdom */
import '../../../cloud-chats/__tests__/jsdom-globals';
// eslint-disable-next-line no-restricted-imports
import { AsyncLocalStorage } from 'node:async_hooks';
import { act as reactAct } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities } from '@canopy/app-core';
import type * as OpenBillingPageModule from '@/lib/openBillingPage';
import type * as WebCoreScopeCapabilitiesModule from '@/lib/web-core-scope-capabilities';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { CanopyClientProvider } from '@canopy/app-state/CanopyClientProvider';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { MODEL_LIBRARY_UNLOCK_LABELS } from '@canopy/ui-shared/components';
// eslint-disable-next-line no-restricted-imports
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import { DesktopTerminalRuntime } from '@/client/DesktopTerminalRuntime';
import { createTerminalPanel } from '@/lib/panels/panel-creation-actions';
import {
  createDesktopCanopyClient,
  createDesktopCapabilities,
} from '@/client/ipc-canopy-client';
import { ipcTranscriptReadClient } from '@/client/ipc-transcript-read-client';
import { requestManagedDelegationStop } from '@/components/chat/managed-delegation-stop';
import { LIVE_DELEGATION_POLL_MS } from '@canopy/app-state/core-cowork';
import { cloudCoworkStore } from '@/cloud-chats/cloud-cowork-store';
import { discardDeletedCloudTask } from '@/cloud-chats/cloud-task-deletion';
import {
  isCloudChatDeleted,
  isCloudTaskDeleted,
} from '@/stores/chat/web-core/task-deletions';
import { useCloudArchivedTasksStore } from '@/cloud-chats/cloud-archived-tasks';
import { resetWebCoreServedOperations } from '@/lib/web-core-served-operations';
import { dispatchAppAction } from '@/lib/app-actions/dispatcher';
import type { AppAdvisorActionResponse } from '@/lib/app-actions/types';
import { desktopCostNavigatorFor } from '@/lib/cost/cost-navigator';
import { createRelayCoreCoworkInvoker } from '@/cloud-chats/relay-invoker';
import { CloudChatFileTargetContext } from '@/cloud-chats/cloud-chat-file-target';
import {
  createCloudSidebarTask,
  retryCloudTask,
} from '@/cloud-chats/useCloudCoworkSidebar';
import { webCoreFilePath } from '@/lib/chat-authority';
import { openCoworkWorkEntryFromSidebar } from '@/lib/openCoworkWorkEntryFromSidebar';
import { announceCanopyCloudAccountChanged } from '@/lib/canopyCloudAccountChange';
import {
  disposeWorktreePanelHydration,
  ensureWorktreePanelLayout,
} from '@/lib/panels/persistence-bridge';
import { setWorkspacePanelLayoutMode } from '@/lib/panels/workspace-layout-mode-actions';
import {
  layoutScopeServesPanelKind,
  panelKindsUnavailableFor,
} from '@/lib/panels/scope-panel-kinds';
import { listAddablePanels } from '@/lib/panels/registry';
import { openSubagentChatPanel } from '@/lib/panels/subagent-panel-open';
import { getSubagentTreeSnapshot } from '@/components/subagents/subagent-tree-store';
import { stopSubagent } from '@/components/subagents/subagent-commands';
import { evictChatTabTranscript } from '@/stores/chat/transcript-residency';
import { webCoreScopeCapabilities } from '@/lib/web-core-scope-capabilities';
import { clearWebCoreModelCatalog } from '@/stores/chat/web-core/model-catalog';
import { refreshChatScopeRevisioned } from '@/stores/chat/slices/revisioned';
import { closeWebCoreChatBackend } from '@/stores/chat/web-core';
import { resetWebCoreSendBinding } from '@/stores/chat/web-core/send-binding';
import { resetCloudSendOrder } from '@/stores/chat/web-core/send-order';
import { WEB_CORE_SEND_UNKNOWN_NOTICE } from '@/stores/chat/web-core/send-refusal';
import { refreshInAppNotificationPrefs } from '@/lib/osNotifications';
import {
  resetToastStack,
  toastStack,
  useToastStore,
} from '@/stores/toastStore';
import { useGitHubStore } from '@/stores/githubStore';
import { trackSelectionSave } from '@/stores/chat/web-core/selection-saves';
import { useCloudSandboxStateStore } from '@/stores/chat/web-core/sandbox-states';
import { useWebCoreStartingTurnStore } from '@/stores/chat/web-core/starting-turns';
import { liveReplyKey } from '@/stores/chat/web-core/live-replies';
import {
  CLOUD_STOP_RETRY_AFTER_MS,
  presentedCloudStop,
} from '@/stores/chat/cloud-stop';
import { ACTIVITY_SECTIONS } from '@/components/activity/activity-sections';
import { COWORK_ARCHIVE_SWEEP_CONCURRENCY } from '@/components/pages/cowork-archive-sweep';
import { CLOUD_FILES_WAKE_RETRY_MAX_MS } from '@/components/activity/cloud-files-wake';
import {
  CHAT_TAB_SETTINGS_PATCH_KEYS,
  initClaudeModels,
} from '@canopy/desktop-shared/types';
import {
  SERVED_TAB_SETTINGS,
  WINDOW_TAB_SETTINGS,
} from '@/stores/chat/web-core/translate';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { importChatAttachments } from '@/lib/chatAttachments';
import { HomeSurface } from '../../home/HomeSurface';
import { installHomeDraftPersistence } from '../../home/homeDraftPersistence';
import { submissionWatchForTest } from '../../home/homeSend';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { REPEAT_TASK_HISTORY_STORAGE_KEY } from '@/lib/repeat-task-automation/history';
import { maybeOfferRepeatTaskAutomation } from '@/lib/repeat-task-automation/offer';
import { snapshotHomeTask } from '@/lib/repeat-task-automation/draft';
import { useRepeatTaskOfferStore } from '@/lib/repeat-task-automation/offerStore';
import { LOADING_PLACEHOLDER_DELAY_MS } from '@canopy/ui-shared/lib';
import { ChatMessageList } from '@/components/chat/ChatMessageList';
import { persistedMessageToRemoteControlMessage } from '@canopy/desktop-shared/remote-control/persisted-chat-projection';
import { useExperimentalFeaturesStore } from '@/stores/experimentalFeaturesStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import {
  clearCloudForks,
  forkCloudChat,
} from '@/stores/chat/web-core/cloud-forks';
import { UsagePanel } from '@/components/panels/usage/UsagePanel';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { resetSubagentTreeStoreForTests } from '@/components/subagents/subagent-tree-store';
import { useSubagentViewStateStore } from '@canopy/ui-app/subagents';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { StandaloneChatPage } from '../StandaloneChatPage';
import { DesktopCostCurrencyProvider } from '../../activity/cost/DesktopCostCurrencyProvider';
import { setRendererBillingLaneAvailability } from '@/stores/billingLaneRuntime';
import { ChatQuestionPlayground } from '../ChatQuestionPlayground';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { MessageImages } from '../../chat/MessageImages';
import { useChatEventSubscriptions } from '@/hooks/useChatEventSubscriptions';
import {
  endChatIntent,
  noteChatIntent,
  useChatPrefetch,
} from '@/stores/chat/chat-prefetch';
import { INSERT_CHAT_TEXT_EVENT } from '@/lib/editorSelectionContext';
import { DISCARD_CHAT_DRAFT_EVENT } from '@/lib/chatDrafts';
import { serializeEditorValue } from '@canopy/ui-rich/editor';
import { Editor, Transforms } from 'slate';
import { cloudAttachmentPath } from '@/cloud-chats/cloud-chat-attachments';
import { CLOUD_ATTACHMENT_THUMBNAIL_MAX_BYTES } from '@/cloud-chats/cloud-attachment-thumbnails';
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
/** The account main's saved-account read names; null once signed out (CAN-6798). */
let savedAccountId: string | null = 'account-1';
/** Set to have main's saved-account read fail, as a locked keychain does. */
let savedAccountRead: 'ok' | 'unavailable' = 'ok';
/**
 * Holds main's saved-account reads until released (CAN-6798). Each read
 * answers the account it started under, as one under way when the account
 * changes does.
 */
let accountGate: Promise<void> | null = null;
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

/** Main's answers a case sets for itself, by bridge path; cleared after each case. */
const caseReplies = new Map<string, (...args: unknown[]) => unknown>();

/** Files picked from this computer's disk, by the path main knows them by. */
const diskPaths = new WeakMap<object, string>();

/** Main's Files wake, which takes a cloud chat's ids by design (CAN-6724). */
const CLOUD_WAKE_FILES = 'api.cloudChats.wakeFiles';

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
    if (path === CLOUD_WAKE_FILES) return wakeFilesAnswer();
    if (path === 'api.loadCanopyCloudAccount') {
      const id = savedAccountId;
      const read = savedAccountRead;
      return held(accountGate).then(() =>
        read !== 'ok'
          ? { read, hasApiKey: false, credentialSource: null }
          : id === null
            ? { hasApiKey: false, credentialSource: null }
            : { account: { id }, credentialSource: 'oauth_desktop' },
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
          : Reflect.get(Object(args[1]), 'name') === 'lost.md'
            ? // As main answers an upload whose answer never came (CAN-7196).
              Promise.resolve({ ok: false, reason: 'unknown' })
            : held(uploadGate).then(() => uploadReply(args[0], args[1]));
    const answer = caseReplies.get(path);
    if (answer !== undefined) return answer(...args);
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
/** The owner's library access the hosted catalog names (CAN-6937). */
let cloudModelLibrary: string = 'unlocked';
/** Whether the owner's library has unlocked the locked model (CAN-6937). */
let lockedModelEligibility: 'available' | 'locked' = 'locked';
/** The unlock a locked row starts, the one a local chat's locked row starts. */
const mockUnlockModels = jest.fn(
  (): Promise<{ outcome: string }> => Promise.resolve({ outcome: 'opened' }),
);
/** The open model menu's locked row named `label`, if it lists one. */
function lockedRowNamed(label: string): HTMLElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="remote-control-chat-model-menu"] [data-locked="true"]',
    ),
  ).find((row) => (row.textContent ?? '').includes(label));
}
/**
 * Whether a cloud scope stops its own delegates through the web core
 * (CAN-7245). The desktop ships it off; a case turns it on as its switch-on
 * would.
 */
let mockDelegationStop = false;
/**
 * Whether a cloud scope serves the Subagents and subagent chat panels
 * (CAN-7133). The desktop ships it off; a case turns it on as its switch-on
 * would.
 */
let mockCloudSubagentPanels = false;
jest.mock('@/lib/web-core-scope-capabilities', () => {
  const actual = jest.requireActual<typeof WebCoreScopeCapabilitiesModule>(
    '@/lib/web-core-scope-capabilities',
  );
  return {
    ...actual,
    webCoreScopeCapabilities: (
      ...[host, options]: Parameters<typeof actual.webCoreScopeCapabilities>
    ): ReturnType<typeof actual.webCoreScopeCapabilities> =>
      actual.webCoreScopeCapabilities(host, {
        ...(options ?? { durableTerminals: false }),
        ...(mockDelegationStop ? { delegationStop: true } : {}),
        ...(mockCloudSubagentPanels ? { cloudSubagentPanels: true } : {}),
      }),
  };
});

jest.mock('@/lib/openBillingPage', () => ({
  ...jest.requireActual<typeof OpenBillingPageModule>('@/lib/openBillingPage'),
  useUnlockModelsAction: (): typeof mockUnlockModels => mockUnlockModels,
}));

/**
 * The hosted model catalog, as `GET /api/cloud/models` sends it and the web
 * core answers it at revision 2 (CAN-6093): Core's provider is the model's
 * vendor, never a harness. Two vendors, and a model the account's library
 * keeps locked (CAN-6753).
 */
interface FakeCloudModel {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly family: string;
  readonly familyLabel: string;
  readonly harness: 'claude' | 'codex';
  readonly contextWindow?: number;
  readonly thinkingLevels?: string[];
  readonly fastModeSupported?: boolean;
  readonly libraryEligibility: 'available' | 'locked';
}

function cloudCatalogModels(): FakeCloudModel[] {
  return [
    {
      id: 'cloud-model',
      label: 'Cloud model',
      provider: 'anthropic',
      family: 'family-a',
      familyLabel: 'Family A',
      harness: 'claude',
      contextWindow: 200_000,
      ...(cloudModelLevels === null
        ? {}
        : { thinkingLevels: cloudModelLevels }),
      fastModeSupported: true,
      libraryEligibility: 'available',
    },
    {
      id: 'second-model',
      label: 'Second model',
      provider: 'anthropic',
      family: 'family-a',
      familyLabel: 'Family A',
      harness: 'claude',
      contextWindow: 200_000,
      libraryEligibility: 'available',
    },
    {
      id: 'vendor-b-model',
      label: 'Vendor B model',
      provider: 'openai',
      family: 'family-b',
      familyLabel: 'Family B',
      harness: 'codex',
      contextWindow: 400_000,
      libraryEligibility: 'available',
    },
    {
      id: 'locked-model',
      label: 'Locked model',
      provider: 'anthropic',
      family: 'family-a',
      familyLabel: 'Family A',
      harness: 'claude',
      libraryEligibility: lockedModelEligibility,
    },
  ];
}

/** The hosted catalog's models as the web core lists them as entries. */
function cloudCatalogModelEntries(): Record<string, unknown>[] {
  return cloudCatalogModels().map((model) => ({
    entryId: `model:${model.id}`,
    kind: 'model',
    name: model.label,
    description: '',
    source: 'remote',
    content: {
      kind: 'model',
      providerId: model.provider,
      modelName: model.id,
      contextWindow: model.contextWindow ?? null,
      capabilities: [],
      harness: model.harness,
      ...(model.thinkingLevels === undefined
        ? {}
        : { thinkingLevels: model.thinkingLevels }),
      ...(model.fastModeSupported === undefined
        ? {}
        : { fastMode: model.fastModeSupported }),
    },
    availability:
      model.libraryEligibility === 'locked' ? 'disabled' : 'available',
    revision: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }));
}
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
/** The account the stub web core serves this window's connection as (CAN-6828). */
let servedPrincipal = 'u-1';
/** Whether the stub advertises the send revision that binds a send to its account. */
let advertisesSendBinding = false;
/**
 * The core.chat.events revision the web core advertises to `describe`
 * (CAN-6841): 3 carries sandbox.changed; null advertises none.
 */
let advertisedEventsRevision: number | null = 3;
/** The opened chat's sandbox state each task snapshot reports (CAN-6841). */
let snapshotSandbox: 'asleep' | 'waking' | 'ready' | undefined;
/** How the stub answers the relay's describe: as usual, failed, or naming no account. */
let describeReply: 'described' | 'failed' | 'noPrincipal' | 'emptyPrincipal' =
  'described';
/** A message send the web core refuses, by its text (CAN-6828). */
let refusedSendText: string | null = null;
/** A message send whose outcome the web core can't tell, by its text (CAN-6828). */
let unknownOutcomeSendText: string | null = null;
/** Holds each send receipt read's reply until released (CAN-6828). */
let receiptGate: Promise<void> | null = null;
/** Holds each message send's reply until released. */
let sendGate: Promise<void> | null = null;
/**
 * The sends the web core applied, by command id, in order (CAN-6798). A send
 * again under one of these ids is answered `already_applied` and applied no
 * second time.
 */
const appliedSends: { chatId: string; commandId: string; text: string }[] = [];
/** Set to have the web core apply a send before its held reply goes. */
let appliesBeforeReply = false;
/**
 * The commands the web core refused (CAN-6798): a send again under one of
 * them is refused again, and its receipt says so.
 */
const refusedCommands = new Set<string>();
/**
 * The commands a supersede fenced (CAN-6856): a late send under one of them
 * is refused, as the web core refuses a send its settled fence holds.
 */
const supersededCommands = new Set<string>();
/**
 * How the web core answers `core.chat.send.supersede`: it fences the send,
 * or its Agentic Core has no send fences, or it can't answer now.
 */
let supersedeAnswer: 'fence' | 'unfenced' | 'unavailable' = 'fence';
/**
 * Retryable failures the web core answers before it fences (CAN-6856): a
 * call deadline, or an attempt whose lease lapsed.
 */
const supersedeFailuresFirst: ('deadline_exceeded' | 'unavailable')[] = [];
/** Conversation v1 chats, which can't stop a send (CAN-6856). */
const v1Chats = new Set<string>();
/** Set to have `core.chat.send.receipt` answer from `appliedSends`. */
let servesSendReceipts = false;
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
/**
 * The chats' uploaded attachments `worker.artifact.download.read` serves, by
 * artifact id: each one's whole size and its bytes from the start.
 */
const attachmentBytes = new Map<
  string,
  { readonly sizeBytes: number; readonly head: Uint8Array }
>();
/** Each `worker.artifact.download.read` the web core received. */
const artifactReads: Record<string, unknown>[] = [];
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
 * Whether a create whose reply is lost reached the web core, and how its
 * lost reply reads: a same-key retry, or S7c's unavailable and never
 * retried (CAN-7196).
 */
let lostCreateLands = true;
let lostCreateRetry: 'same_idempotency_key' | 'never' = 'same_idempotency_key';
/**
 * How the stub answers the next core.chat.fork (CAN-7007): apply it, refuse
 * it, or apply it and lose the reply.
 */
let forkAnswer: 'apply' | 'refuse' | 'lose' = 'apply';
/** The claim each core.chat.fork carried, in order. */
const forkClaims: string[] = [];
/** The forks the stub made, one per claim it hadn't seen (CAN-5541). */
let forkCreations = 0;
/** Whether the web core's manifest serves core.chat.fork (CAN-7007). */
let servesFork = false;
/**
 * The `details` the manifest lists for core.chat.transcript.page (CAN-7027):
 * `null` leaves the operation out of the manifest, and undefined lists it
 * with none, as an older web core does.
 */
let transcriptPageDetails: string[] | undefined | null = null;
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
/** The second chat's running turn, when a case runs one (CAN-7133). */
let secondChatTurn: string | null = null;
/**
 * Main's answer to a Files wake (CAN-6724). Refused unless a case says
 * otherwise, so a case about something else never wakes the sandbox.
 */
let wakeFilesAnswer: () => Promise<unknown> = () =>
  Promise.resolve({ ok: false, reason: 'refused' });
/** The paths `worker.filesystem.entry.delete` removed from the sandbox. */
const deletedPaths = new Set<string>();
/** Set while the web core's folder listings still show what a delete removed. */
let listingLags = false;
/** Holds each folder listing's reply until released. */
let listingGate: Promise<void> | null = null;
/** The sandbox's docs/ folder is empty, as a new folder is (CAN-6756). */
let docsEmpty = false;

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
/**
 * The `detail` values the manifest declares for core.cost.chat.get
 * (CAN-6941); undefined declares none, as an older web core does.
 */
let costChatDetails: string[] | undefined = ['summary'];

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
/**
 * The harness the snapshot's settings name for the task's own chat
 * (CAN-6761); undefined serves no settings, as a web core from before it.
 */
let snapshotHarness: 'claude' | 'codex' | null | undefined;
/**
 * The harness chat-2's own snapshot names (CAN-6761). Only a snapshot read
 * for that chat carries it, as the web core opens only the chat it reads.
 */
let secondaryHarness: 'claude' | 'codex' | undefined;
/** The snapshot's revision, which a change made since moves past. */
let snapshotRevision = 1;
/** Holds each transcript page reply until released. */
let pageGate: Promise<void> | null = null;
/**
 * Each chat's transcript rows by chat id, as the web core's page serves them
 * through main's relay, which reads it at revision 2 when the web core
 * advertises it (CAN-6755); a chat not listed has none.
 */
let transcripts: Record<string, unknown[]> = {};
/** Each delegation's own chat rows, which a delegation target reads. */
const delegateTranscripts = new Map<string, unknown[]>();
/**
 * Each delegation's live state, as core.managedDelegation.list (open ones
 * only) and .get answer it (CAN-7245).
 */
const delegationSnapshots = new Map<string, Record<string, unknown>>();
/** How the fake web core answers core.managedDelegation.stop (CAN-7245). */
let delegationStopAnswer: 'accept' | 'not_found' | 'hang' = 'accept';
/**
 * Holds each task snapshot reply until released. The snapshot is read as the
 * request arrives, so a held reply lands stale.
 */
let snapshotGate: Promise<void> | null = null;
/**
 * Holds one task's snapshot replies until a test settles them: served, or
 * refused as a web core that can't read the task answers (CAN-6754).
 */
const snapshotHolds = new Map<string, Promise<'serve' | 'refuse'>>();
/** Holds one task's `core.chat.list` replies until a test releases them (CAN-6774). */
const listHolds = new Map<string, Promise<void>>();
/** Holds one task's transcript page replies until a test releases them (CAN-6774). */
const pageHolds = new Map<string, Promise<void>>();
/**
 * How many revisions behind the task's feed head a chat list reads, as one
 * the web core answered before a change the snapshot then covered (CAN-6774).
 */
let listRevisionLag = 0;
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
        const gated = held(snapshotGate).then(() => read);
        const hold = snapshotHolds.get(task);
        if (hold === undefined) return gated;
        return Promise.race([
          hold,
          caseEnded.then((): 'serve' => 'serve'),
        ]).then((outcome) =>
          outcome === 'serve'
            ? gated
            : {
                ok: false,
                error: {
                  kind: 'unavailable',
                  message: 'The web core could not read this task.',
                  retry: { kind: 'never' },
                },
              },
        );
      };
      if (request.kind === 'describe') {
        if (describeReply === 'failed')
          return Promise.resolve({
            ok: false,
            error: {
              kind: 'unavailable',
              message: 'The renderer relay connection closed.',
              retry: { kind: 'never' },
            },
          });
        return ok({
          principalId:
            describeReply === 'noPrincipal'
              ? null
              : describeReply === 'emptyPrincipal'
                ? ''
                : servedPrincipal,
          schemaRevisions: {
            ...(advertisesSendBinding ? { 'core.chat.message.send': 3 } : {}),
            ...(advertisedEventsRevision === null
              ? {}
              : { 'core.chat.events': advertisedEventsRevision }),
          },
        });
      }
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
      const delegationParams = request.params ?? {};
      const delegationRefusal = (): Promise<unknown> =>
        Promise.resolve({
          ok: false,
          error: {
            kind: 'not_found',
            message: 'The delegation was not found.',
            retry: { kind: 'never' },
          },
        });
      const stopped = (snapshot: Record<string, unknown>): void => {
        delegationSnapshots.set(String(snapshot.delegationId), {
          ...snapshot,
          status: 'cancelled',
          phase: 'idle',
          stopReason: 'user_cancelled',
          cancelledByUser: true,
        });
      };
      const isOpen = (snapshot: Record<string, unknown>): boolean =>
        snapshot.status === 'pending' || snapshot.status === 'running';
      if (request.method === 'core.managedDelegation.list')
        return ok({
          items: [...delegationSnapshots.values()].filter(isOpen),
          nextCursor: null,
        });
      if (request.method === 'core.managedDelegation.get') {
        const snapshot = delegationSnapshots.get(
          String(delegationParams.delegationId),
        );
        return snapshot === undefined ? delegationRefusal() : ok(snapshot);
      }
      if (request.method === 'core.managedDelegation.stop') {
        if (delegationStopAnswer === 'hang') return new Promise(() => {});
        if (delegationStopAnswer === 'not_found') return delegationRefusal();
        const snapshot = delegationSnapshots.get(
          String(delegationParams.delegationId),
        );
        if (snapshot !== undefined && isOpen(snapshot)) stopped(snapshot);
        return ok({ accepted: true });
      }
      if (request.method === 'core.managedDelegation.stopAll') {
        const open = [...delegationSnapshots.values()].filter(isOpen);
        open.forEach(stopped);
        return ok({ stopped: open.length });
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
      if (
        (servesCost || servesFork || transcriptPageDetails !== null) &&
        request.method === 'core.runtime.manifest.get'
      )
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
            ...(servesCost
              ? [
                  costOperation('core.cost.scope.get'),
                  {
                    ...costOperation('core.cost.chat.get'),
                    ...(costChatDetails === undefined
                      ? {}
                      : { details: costChatDetails }),
                  },
                ]
              : []),
            ...(servesFork
              ? [
                  {
                    name: 'core.chat.fork',
                    kind: 'instruction',
                    version: 1,
                    placement: 'core-only',
                    requiredGrants: ['core.chat.write'],
                    available: true,
                  },
                ]
              : []),
            ...(transcriptPageDetails === null
              ? []
              : [
                  {
                    name: 'core.chat.transcript.page',
                    kind: 'query',
                    version: 1,
                    placement: 'core-only',
                    requiredGrants: ['core.chat.read'],
                    available: true,
                    ...(transcriptPageDetails === undefined
                      ? {}
                      : { details: transcriptPageDetails }),
                  },
                ]),
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
              ...(snapshotSandbox === undefined
                ? {}
                : { sandbox: { state: snapshotSandbox } }),
            });
          return heldSnapshot({
            workspaceId: 'ws-1',
            worktreeId: task,
            revision: snapshotRevision,
            ...(snapshotSandbox === undefined
              ? {}
              : { sandbox: { state: snapshotSandbox } }),
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
                  ...(snapshotHarness === undefined
                    ? {}
                    : {
                        settings: {
                          model: snapshotModel ?? null,
                          providerId: null,
                          executionHarness: snapshotHarness,
                          modelSelectionMode: 'manual',
                          thinkingLevel: null,
                          speed: null,
                          planMode: false,
                          approvalMode: null,
                          interfaceMode: null,
                          customTitle: null,
                        },
                      }),
                },
                ...(removedChats.has('chat-2')
                  ? []
                  : [
                      {
                        chatId: 'chat-2',
                        title: 'Notes',
                        kind: 'chat',
                        createdAt: CREATED_AT,
                        ...(request.params?.chatId === 'chat-2' &&
                        secondaryHarness !== undefined
                          ? {
                              settings: {
                                model: null,
                                providerId: null,
                                executionHarness: secondaryHarness,
                                modelSelectionMode: 'manual',
                                thinkingLevel: null,
                                speed: null,
                                planMode: false,
                                approvalMode: null,
                                interfaceMode: null,
                                customTitle: null,
                              },
                            }
                          : {}),
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
              'chat-2':
                secondChatTurn === null
                  ? { status: 'idle', queuedMessageIds: [] }
                  : {
                      status: 'streaming',
                      activeTurnId: secondChatTurn,
                      queuedMessageIds: [],
                    },
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
          const target = request.params?.target;
          // A delegation target reads that delegate's own chat, as the web
          // core does for the parent's owner, and is not found otherwise.
          if (
            typeof target === 'object' &&
            target !== null &&
            'kind' in target &&
            target.kind === 'delegation'
          ) {
            // A run's own rows when a case gives them (`<id>#<run>`), else
            // the delegate's (CAN-7133).
            const rows =
              'delegationId' in target &&
              typeof target.delegationId === 'string'
                ? (delegateTranscripts.get(
                    `${target.delegationId}#${String(
                      'runGeneration' in target ? target.runGeneration : '',
                    )}`,
                  ) ?? delegateTranscripts.get(target.delegationId))
                : undefined;
            return rows === undefined
              ? Promise.resolve({
                  ok: false,
                  error: {
                    kind: 'not_found',
                    message: 'The delegation was not found.',
                    retry: { kind: 'never' },
                  },
                })
              : ok({
                  messages: rows,
                  totalMessages: rows.length,
                  transcriptRevision: Math.max(1, rows.length),
                });
          }
          const scope = request.params?.scope;
          const chatId =
            typeof scope === 'object' &&
            scope !== null &&
            'chatId' in scope &&
            typeof scope.chatId === 'string'
              ? scope.chatId
              : task;
          const messages = transcripts[chatId] ?? [];
          const page = ok({
            // A chat's seeded rows, then the prompts a send started or a
            // Stop cancelled (CAN-6755, CAN-6733).
            messages: [...messages, ...startedPrompts, ...cancelledPrompts],
            totalMessages:
              messages.length + startedPrompts.length + cancelledPrompts.length,
            transcriptRevision: Math.max(1, messages.length),
          });
          return held(pageGate)
            .then(() => held(pageHolds.get(task) ?? null))
            .then(() => page);
        }
        case 'core.catalog.snapshot.get': {
          const kinds = request.params?.kinds;
          const wantsModels =
            !Array.isArray(kinds) ||
            kinds.length === 0 ||
            kinds.includes('model');
          const snapshot = ok({
            revision: 1,
            generatedAt: CREATED_AT,
            // Revision 2 also answers the hosted model catalog (CAN-6093).
            ...(request.params?.revision !== undefined && wantsModels
              ? {
                  cloudModels: {
                    models: cloudCatalogModels(),
                    modelHarnesses: Object.fromEntries(
                      cloudCatalogModels().map((model): [string, string] => [
                        model.id,
                        model.harness,
                      ]),
                    ),
                    defaultModelId: 'cloud-model',
                    defaultModelBlocked: false,
                    modelLibrary: cloudModelLibrary,
                  },
                }
              : {}),
            entries: [
              ...cloudCatalogModelEntries(),
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
          return held(catalogGate).then(() => snapshot);
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
            if (lostCreateLands) createdTasks.add(tabId);
            return held(createGate).then(() => ({
              ok: false,
              error: {
                kind: 'unavailable',
                message: 'The reply was lost.',
                retry: { kind: lostCreateRetry },
              },
            }));
          }
          return held(createGate).then(() => {
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
        case 'core.chat.fork': {
          const action = request.params?.action;
          const claim =
            typeof action === 'object' &&
            action !== null &&
            'targetTabId' in action &&
            typeof action.targetTabId === 'string'
              ? action.targetTabId
              : '';
          forkClaims.push(claim);
          const answer = forkAnswer;
          forkAnswer = 'apply';
          if (answer === 'refuse')
            return Promise.resolve({
              ok: false,
              error: {
                kind: 'failed_precondition',
                code: 'core.chat.notTransferable',
                message: 'This chat cannot be forked.',
                retry: { kind: 'never' },
              },
            });
          // The fork is a new task whose own chat it is; this stub names it
          // by its claim.
          const replayed = createdTasks.has(claim);
          if (!replayed) forkCreations += 1;
          createdTasks.add(claim);
          if (answer === 'lose')
            return Promise.resolve({
              ok: false,
              error: {
                kind: 'unavailable',
                message: 'The reply was lost.',
                retry: { kind: 'same_idempotency_key' },
              },
            });
          return ok({
            commandId: request.params?.commandId,
            revision: 0,
            outcome: replayed ? 'already_applied' : 'applied',
            entityId: claim,
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
            return held(updateGate).then(() => ({
              ok: false,
              error: {
                kind: 'permission_denied',
                message: refusal,
                retry: { kind: 'never' },
              },
            }));
          return held(updateGate).then(() => {
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
          // A send pressed under another account (CAN-6828).
          const bound = request.params?.expectedPrincipalId;
          if (bound !== undefined && bound !== servedPrincipal)
            return held(sendGate).then(() => ({
              ok: false,
              error: {
                kind: 'failed_precondition',
                code: 'core.chat.message.accountChanged',
                message: 'This message was sent from another account.',
                retry: { kind: 'never' },
              },
            }));
          const sentCommand = String(request.params?.commandId);
          // A send its supersede fenced never applies (CAN-6856).
          if (supersededCommands.has(sentCommand))
            return held(sendGate).then(() => ({
              ok: false,
              error: {
                kind: 'failed_precondition',
                message: 'This message was replaced by a newer send.',
                retry: { kind: 'never' },
              },
            }));
          if (
            refusedCommands.has(sentCommand) ||
            (refusedSendText !== null &&
              request.params?.text === refusedSendText)
          )
            return held(sendGate).then(() => {
              refusedCommands.add(sentCommand);
              return {
                ok: false,
                error: {
                  kind: 'failed_precondition',
                  message: 'The web core refused this message.',
                  retry: { kind: 'never' },
                },
              };
            });
          if (
            sendOutcomeUnknown ||
            (unknownOutcomeSendText !== null &&
              request.params?.text === unknownOutcomeSendText)
          )
            return held(sendGate).then(() => ({
              ok: false,
              error: {
                kind: 'unavailable',
                message: 'The web core did not answer in time.',
                retry: { kind: 'same_idempotency_key' },
              },
            }));
          if (refusal !== null)
            return held(sendGate).then(() => ({
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
            return held(sendGate).then(() => queued);
          }
          if (sendsKeepRunning) runningTurn = 'turn-1';
          const commandId = String(request.params?.commandId);
          // Applied once per command id, as the web core takes a send.
          const apply = (): 'applied' | 'already_applied' => {
            if (appliedSends.some((sent) => sent.commandId === commandId))
              return 'already_applied';
            appliedSends.push({
              chatId: String(request.params?.chatId),
              commandId,
              text: String(request.params?.text),
            });
            return 'applied';
          };
          const accepted = (outcome: string): unknown => ({
            ok: true,
            value: {
              commandId: request.params?.commandId,
              revision: 3,
              outcome,
              entityId: 'turn-1',
              ...(sendsNameMessage ? { messageId: 'turn-1-u' } : {}),
            },
          });
          if (appliesBeforeReply) {
            const outcome = apply();
            return held(sendGate).then(() => accepted(outcome));
          }
          // Fenced while it was on its way: it arrives too late to apply.
          return held(sendGate).then(() =>
            supersededCommands.has(commandId)
              ? {
                  ok: false,
                  error: {
                    kind: 'failed_precondition',
                    message: 'This message was replaced by a newer send.',
                    retry: { kind: 'never' },
                  },
                }
              : accepted(apply()),
          );
        }
        // A turn the web core accepts a cancel for keeps running until it
        // ends; one it no longer knows has ended.
        case 'core.chat.turn.cancel':
          if (holdCancels)
            return new Promise((resolve) => {
              heldCancels.push(resolve);
            });
          if (!cancelTurnGone)
            return held(cancelGate).then(() => ({
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
        case 'core.chat.send.supersede': {
          const commandId = String(request.params?.commandId);
          if (v1Chats.has(String(request.params?.chatId)))
            return Promise.resolve({
              ok: false,
              error: {
                kind: 'failed_precondition',
                code: 'core.chat.send.supersede.invalidState',
                message: "This chat can't stop a send.",
                retry: { kind: 'never' },
              },
            });
          if (supersedeAnswer === 'unfenced')
            return Promise.resolve({
              ok: false,
              error: {
                kind: 'capability_unavailable',
                code: 'core.chat.send.supersede.unavailable',
                message: "This chat can't stop a send yet.",
                retry: { kind: 'never' },
              },
            });
          const failure = supersedeFailuresFirst.shift();
          if (failure !== undefined)
            return Promise.resolve({
              ok: false,
              error: {
                kind: failure,
                message: 'The web core did not finish stopping the send.',
                retry: { kind: 'same_request' },
              },
            });
          if (supersedeAnswer === 'unavailable')
            return Promise.resolve({
              ok: false,
              error: {
                kind: 'unavailable',
                message: 'The web core did not answer in time.',
                retry: { kind: 'same_request' },
              },
            });
          const applied = appliedSends.find(
            (sent) => sent.commandId === commandId,
          );
          if (applied !== undefined)
            return ok({
              outcome: 'applied',
              commandId,
              entityId: 'turn-1',
              messageId: 'turn-1-u',
            });
          supersededCommands.add(commandId);
          refusedCommands.add(commandId);
          return ok({ outcome: 'superseded', commandId });
        }
        case 'core.chat.send.receipt': {
          const commandId = String(request.params?.commandId);
          if (servesSendReceipts)
            return ok(
              appliedSends.some((sent) => sent.commandId === commandId)
                ? {
                    outcome: 'matched',
                    receipt: { commandId, revision: 3, outcome: 'applied' },
                  }
                : refusedCommands.has(commandId)
                  ? {
                      outcome: 'matched',
                      receipt: { commandId, revision: 3, outcome: 'rejected' },
                    }
                  : { outcome: 'missing' },
            );
          return held(receiptGate).then(() => ({
            ok: false,
            error: {
              kind: 'unavailable',
              message: 'The web core did not answer in time.',
              retry: { kind: 'same_request' },
            },
          }));
        }
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
              ? docsEmpty
                ? []
                : [entry('docs/brief.md', 'file')]
              : [entry('docs', 'directory'), entry('brief.md', 'file')]
          ).filter(
            (each) =>
              listingLags ||
              typeof each.relativePath !== 'string' ||
              !deletedPaths.has(each.relativePath),
          );
          return held(listingGate).then(() => ({
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
        case 'worker.artifact.download.read': {
          const params = request.params ?? {};
          artifactReads.push(params);
          const artifactId = params.artifactId;
          const offset = typeof params.offset === 'number' ? params.offset : 0;
          const length = typeof params.length === 'number' ? params.length : 0;
          const held =
            typeof artifactId === 'string'
              ? attachmentBytes.get(artifactId)
              : undefined;
          if (held === undefined) return Promise.resolve(chatNotFound);
          const range = held.head.subarray(offset, offset + length);
          const end = offset + range.byteLength;
          return ok({
            sizeBytes: held.sizeBytes,
            offset,
            data: btoa(String.fromCharCode(...range)),
            nextOffset: end < held.sizeBytes ? end : null,
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
        // In place, as the web core restores an archived task (CAN-6511):
        // its listing shows it again.
        case 'core.archive.container.restore': {
          const archiveId =
            typeof request.params?.archiveId === 'string'
              ? request.params.archiveId
              : '';
          const [, chatId = ''] = archiveId.split(':');
          deletedTasks.delete(chatId);
          return ok({
            operation: {
              operationId: `restore-${chatId}`,
              kind: 'core.archive.container.restore',
              status: 'completed',
            },
            restoredScope: { workspaceId: 'ws-1', chatId },
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
          {
            // The task's feed head, read before the chats, as the web core
            // names it on every item (CAN-6774).
            const listed = ok({
              items: [
                {
                  chatId: task,
                  title: 'Brief',
                  state: 'idle',
                  workspaceId: 'ws-1',
                  worktreeId: task,
                  revision: snapshotRevision - listRevisionLag,
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
                        revision: snapshotRevision - listRevisionLag,
                        createdAt: CREATED_AT,
                      },
                    ]),
              ],
              nextCursor: null,
            });
            const held = listHolds.get(task);
            return held === undefined ? listed : held.then(() => listed);
          }
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

/**
 * CAN-6793: Jest abandons a case it times out, but the case's body keeps
 * running into later cases, and the stub requests its gates held stay held.
 * Each case runs under its own id. Once it ends, its body never resumes from
 * `act` (so neither from `settle`), and every request it held is let go and
 * drained before the next case starts.
 */
const caseScope = new AsyncLocalStorage<number>();
let liveCase: number | null = null;
let caseCount = 0;
let caseEnded: Promise<void> = Promise.resolve();
let endCase = (): void => undefined;
const NEVER = new Promise<never>(() => undefined);

/** True in hooks and in the case that is running; false in an ended one. */
function caseIsLive(): boolean {
  const id = caseScope.getStore();
  return id === undefined || id === liveCase;
}

/**
 * What a case may take before Jest times it out. The default 5 s isn't enough
 * for this page's renders on a loaded CI runner. A case that runs out still
 * fails alone: it no longer takes later cases with it.
 */
const CASE_TIMEOUT_MS = 20_000;

function it(
  name: string,
  body: () => Promise<void> | void,
  timeout = CASE_TIMEOUT_MS,
): void {
  globalThis.it(
    name,
    async () => {
      caseCount += 1;
      const id = caseCount;
      liveCase = id;
      await caseScope.run(id, body);
    },
    timeout,
  );
}

let actsInFlight = 0;

/**
 * React's act, which an ended case's body never gets past. React keeps one
 * act queue, so `afterEach` waits out an act the ended case left running
 * before it starts its own: overlapping acts leave that queue unflushed for
 * every later case.
 */
declare const syncActOnly: unique symbol;
/** As React's own act types it: a sync callback's act returns nothing. */
type SyncActResult = void | { readonly [syncActOnly]: never };
function act(callback: () => SyncActResult): void;
function act<T>(callback: () => T | Promise<T>): Promise<T>;
function act<T>(callback: () => T | Promise<T>): Promise<T> | void {
  if (!caseIsLive()) return NEVER;
  actsInFlight += 1;
  let pending: Promise<T>;
  try {
    pending = reactAct(callback);
  } catch (error) {
    actsInFlight -= 1;
    throw error;
  }
  // A case Jest timed out while this act was pending doesn't resume from
  // it: the act's result never reaches the ended case's body.
  return Promise.resolve(pending).then(
    (value): T | Promise<never> => {
      actsInFlight -= 1;
      return caseIsLive() ? value : NEVER;
    },
    (error: unknown): Promise<never> => {
      actsInFlight -= 1;
      if (!caseIsLive()) return NEVER;
      throw error;
    },
  );
}

/** This file's real setTimeout, which a case's fake timers don't replace. */
const realSetTimeout = globalThis.setTimeout;

/** Waits up to 5 s, on real time, for acts the ended case left running. */
async function actsSettled(): Promise<void> {
  for (let i = 0; i < 500 && actsInFlight > 0; i += 1)
    await new Promise((resolve) => realSetTimeout(resolve, 10));
}

const caseCleanups: (() => Promise<void> | void)[] = [];

/**
 * Cleanup for the next case's sake. `afterEach` runs it, because Jest runs
 * that even for a case it timed out, whose own `finally` never runs.
 */
function onCaseEnd(cleanup: () => Promise<void> | void): void {
  caseCleanups.push(cleanup);
}

function restoreSpy(
  target: object,
  property: string,
  slot: 'value' | 'get',
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  const fn: unknown =
    descriptor === undefined ? undefined : Reflect.get(descriptor, slot);
  if (jest.isMockFunction(fn)) fn.mockRestore();
}

/** A stub request held on `gate` until the case releases it or ends. */
function held(gate: Promise<unknown> | null): Promise<unknown> {
  return gate === null ? Promise.resolve() : Promise.race([gate, caseEnded]);
}

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
  caseEnded = new Promise<void>((resolve) => {
    endCase = resolve;
  });
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
  lostCreateLands = true;
  lostCreateRetry = 'same_idempotency_key';
  sendRefusal = null;
  servedPrincipal = 'u-1';
  advertisesSendBinding = false;
  advertisedEventsRevision = 3;
  snapshotSandbox = undefined;
  describeReply = 'described';
  resetWebCoreSendBinding();
  resetCloudSendOrder();
  refusedSendText = null;
  caseReplies.clear();
  unknownOutcomeSendText = null;
  receiptGate = null;
  sendGate = null;
  appliedSends.length = 0;
  refusedCommands.clear();
  supersededCommands.clear();
  supersedeAnswer = 'fence';
  supersedeFailuresFirst.length = 0;
  v1Chats.clear();
  appliesBeforeReply = false;
  servesSendReceipts = false;
  savedAccountId = 'account-1';
  savedAccountRead = 'ok';
  accountGate = null;
  for (const key of Object.keys(window.localStorage))
    if (key.startsWith('canopy:home-draft:v1:'))
      window.localStorage.removeItem(key);
  cancelTurnGone = false;
  sendsKeepRunning = false;
  taskRuntime = null;
  cancelGate = null;
  holdCancels = false;
  heldCancels.length = 0;
  sendOutcomeUnknown = false;
  createdTasks.clear();
  forkAnswer = 'apply';
  forkClaims.length = 0;
  forkCreations = 0;
  servesFork = false;
  transcriptPageDetails = null;
  clearCloudForks();
  loseCreateReply = false;
  servesCoworkLists = false;
  servesCost = false;
  costCoverageStart = undefined;
  costChatDetails = ['summary'];
  resetWebCoreServedOperations();
  setRendererBillingLaneAvailability({
    claudeNativeAuth: undefined,
    codexNativeAuth: undefined,
    creditsEligible: undefined,
  });
  snapshotModel = 'cloud-model';
  snapshotHarness = undefined;
  secondaryHarness = undefined;
  snapshotRevision = 1;
  pageGate = null;
  transcripts = {};
  snapshotGate = null;
  snapshotHolds.clear();
  listHolds.clear();
  pageHolds.clear();
  listRevisionLag = 0;
  setModelRefusal = null;
  cloudModelLevels = ['low', 'medium', 'high'];
  cloudModelLibrary = 'unlocked';
  lockedModelEligibility = 'locked';
  mockUnlockModels.mockClear();
  openedStreams.clear();
  deletedTasks.clear();
  removedChats.clear();
  sandboxAsleep = false;
  asleepAs = { cloudCode: 'SANDBOX_NOT_READY', wakeAllowed: true };
  runningTurn = null;
  wakeFilesAnswer = (): Promise<unknown> =>
    Promise.resolve({ ok: false, reason: 'refused' });
  queuedSends.length = 0;
  startingSend = null;
  sendsNameMessage = false;
  cancelledPrompts.length = 0;
  startedPrompts.length = 0;
  delegateTranscripts.clear();
  delegationSnapshots.clear();
  delegationStopAnswer = 'accept';
  mockDelegationStop = false;
  mockCloudSubagentPanels = false;
  resetSubagentTreeStoreForTests();
  useSubagentViewStateStore.setState(
    useSubagentViewStateStore.getInitialState(),
  );
  attachmentBytes.clear();
  artifactReads.length = 0;
  deletedPaths.clear();
  uploadedAttachments.length = 0;
  servesAttachmentList = false;
  listingLags = false;
  listingGate = null;
  docsEmpty = false;
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

afterEach(async () => {
  // The case is over: its body stops, and what it held is let go and drained
  // here, so the next case starts from settled state.
  liveCase = null;
  await actsSettled();
  endCase();
  for (const answer of heldCancels.splice(0)) answer(refusedCancel);
  // A case's cleanup runs on the clock the case left installed, as its own
  // finally did, so a fake-timer case's drains still drain. A cleanup that
  // throws doesn't stop the rest, nor the teardown below; the case still
  // fails with its error.
  let failure: Error | undefined;
  try {
    for (const cleanup of caseCleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  } finally {
    jest.useRealTimers();
    // A case cut off mid-way never reached its own restores of the spies the
    // cases put on the composer's file input and on window.event.
    restoreSpy(HTMLInputElement.prototype, 'click', 'value');
    restoreSpy(window, 'event', 'get');
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.unmount());
    container.remove();
    await settle();
  }
  if (failure !== undefined) throw failure;
}, CASE_TIMEOUT_MS);

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

/**
 * Reconnects the cloud so the relay describes the connection again, with the
 * revisions and reply the case has set since `beforeEach` connected it.
 */
async function describeConnectionAgain(): Promise<void> {
  act(() => {
    cloudCoworkStore.getState().disconnect('offline');
  });
  act(() => {
    connectCloud();
  });
  await settle();
}

/**
 * Settles until `ready` holds: it stops as soon as the case's own state is
 * there, and on a loaded machine keeps settling for up to `withinMs` rather
 * than giving up after a fixed number of ticks (CAN-6793).
 */
async function settleUntil(
  ready: () => boolean,
  withinMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + withinMs;
  for (let i = 0; !ready() && (i < 60 || Date.now() < deadline); i += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

/** The window's chat event subscriptions, which deliver pushed changes. */
function ChatEventSubscriptions(): null {
  useChatEventSubscriptions();
  return null;
}

/** The window's sidebar hover prefetch, as the app mounts it. */
function ChatPrefetch(): null {
  useChatPrefetch();
  return null;
}

function renderPage(options?: {
  readonly followsEvents?: boolean;
  readonly prefetches?: boolean;
  /** Capabilities a cloud scope gains in this harness only (CAN-7007). */
  readonly cloudScopeExtras?: Partial<CanopyCapabilities>;
}): void {
  const desktopClient = createDesktopCanopyClient(
    createDesktopCapabilities('darwin', {}, {}),
  );
  const extras = options?.cloudScopeExtras;
  const extended = new Map<string, CanopyCapabilities>();
  const client =
    extras !== undefined
      ? new Proxy(desktopClient, {
          get(target, property, receiver): unknown {
            if (property !== 'capabilitiesFor')
              return Reflect.get(target, property, receiver);
            return (localId: string): CanopyCapabilities => {
              const capabilities =
                target.capabilitiesFor?.(localId) ?? target.capabilities;
              if (!localId.startsWith('web-core:')) return capabilities;
              const known = extended.get(localId);
              if (known !== undefined) return known;
              const withExtras = { ...capabilities, ...extras };
              extended.set(localId, withExtras);
              return withExtras;
            };
          },
        })
      : desktopClient;
  act(() => {
    root.render(
      <CanopyClientProvider client={client}>
        <DesktopCostCurrencyProvider>
          {options?.followsEvents === true ? <ChatEventSubscriptions /> : null}
          {options?.prefetches === true ? <ChatPrefetch /> : null}
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
            call.path !== CLOUD_WAKE_FILES &&
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
    // chat can't be closed, which would archive the task. A chat with no
    // answer meter shows no usage meter, never a zero one (CAN-6755).
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

  it('shows no usage meter for a cloud chat whose answers carry no meter (CAN-6755)', async () => {
    transcripts['wt-1'] = [
      {
        id: 'plain-u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'Draft the brief' }],
        timestamp: 1,
      },
      {
        id: 'plain-a1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Drafted.' }],
        timestamp: 2,
      },
    ];
    // Earlier cases leave the task's chats in the store: going offline drops
    // them, so this one reads its transcript afresh.
    act(() => {
      cloudCoworkStore.getState().disconnect('offline');
    });
    connectCloud();
    try {
      renderPage({ followsEvents: true });
      act(() => {
        openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
      });
      await settle();

      // The store holds the chat's answer, and no usage for it.
      const tab = useChatStore
        .getState()
        .worktreeChats[
          'web-core:ws-1/web-core:wt-1'
        ]?.tabs.find((each) => each.id === 'web-core:wt-1');
      expect(tab?.messages.map((message) => message.id)).toEqual([
        'plain-u1',
        'plain-a1',
      ]);
      expect(tab?.usage).toBeUndefined();
      expect(shown('usage-indicator')).toBe(false);
    } finally {
      // Later cases open the task with an empty transcript.
      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
    }
  });

  it("shows a cloud chat's context in its composer meter from its answers' meters, and never USD (CAN-6755)", async () => {
    transcripts['wt-1'] = [
      {
        id: 'metered-u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'Draft the brief' }],
        timestamp: 1,
      },
      {
        id: 'metered-a1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Drafted.' }],
        timestamp: 2,
        meter: {
          model: { id: 'cloud-model', contextWindow: 200_000 },
          usage: {
            inputTokens: 20_000,
            outputTokens: 1_000,
            contextTokens: 50_000,
          },
          costUsd: '0.42',
          sourceKey: 'turn-1',
        },
      },
    ];
    // Earlier cases leave the task's chats in the store: going offline drops
    // them, so this one reads its transcript afresh.
    act(() => {
      cloudCoworkStore.getState().disconnect('offline');
    });
    connectCloud();
    try {
      renderPage({ followsEvents: true });
      act(() => {
        openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
      });
      await settle();

      expect(shown('usage-indicator')).toBe(true);
      act(() => {
        container
          .querySelector<HTMLElement>('[data-testid="usage-indicator"]')
          ?.click();
      });
      await settle();
      // The popover opens in the window's document, outside the page.
      expect(
        document.querySelector('[data-testid="usage-indicator-context"]')
          ?.textContent,
      ).toContain('50.0k / 200.0k');
      // Every cloud turn bills to AI Credits, so the meter shows no USD, as
      // the web's cloud composer hides it (CAN-5028).
      expect(document.body.textContent).not.toContain('$0.42');
      // The meter asks this computer nothing about a cloud chat.
      expect(callsCarryingWebCoreIds()).toEqual([]);
      expect(
        calls.filter((call) => call.path === 'api.chat.getContextUsage'),
      ).toEqual([]);
    } finally {
      // Later cases open the task with an empty transcript.
      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
    }
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
    // One whose answer never came may be stored: it says so, never that it
    // failed, and is not attached (CAN-7196).
    await pick([new File(['# Lost'], 'lost.md', { type: 'text/markdown' })]);
    expect(problems()).toContain(
      "lost.md: Couldn't confirm the file uploaded. Attach it again to be sure",
    );
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
    // Eight that uploaded, full.md, which reached main and was refused, and
    // lost.md, whose answer never came.
    expect(uploads()).toHaveLength(10);
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

  it("saves a sent cloud attachment through its chat's own web core read when the transcript names the chat (CAN-6771)", () => {
    const target = {
      key: 'web-core:chat-1',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
    };
    act(() => {
      root.render(
        <CloudChatFileTargetContext.Provider value={target}>
          <MessageImages
            attachments={[
              {
                kind: 'file',
                absolutePath: cloudAttachmentPath('att-1', 'brief.md'),
              },
            ]}
          />
        </CloudChatFileTargetContext.Provider>,
      );
    });
    const [tile] = Array.from(
      container.querySelectorAll('[data-testid="message-file-attachment"]'),
    );
    expect(tile?.getAttribute('aria-label')).toBe('Open file');
    act(() => {
      tile?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      calls
        .filter((call) => call.path === 'api.cloudChats.downloadFile')
        .map((call) => call.args),
    ).toEqual([
      [target, { kind: 'attachment', id: 'att-1', filename: 'brief.md' }],
    ]);
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

  it("keeps a queued edit that wasn't saved in an otherwise empty cloud chat, to copy, restore or dismiss (CAN-6799)", async () => {
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const worktreeKey = 'web-core:ws-1/web-core:wt-1';
    const chatId =
      useChatStore.getState().worktreeChats[worktreeKey]?.activeTabId ?? '';
    expect(chatId).not.toBe('');
    expect(shown('queued-message-unsaved-edit')).toBe(false);
    const keep = (text: string): void => {
      act(() => {
        useChatStore.getState().keepUnsavedQueuedEdit({
          worktreeKey,
          chatId,
          id: 'entry-1',
          text,
        });
      });
    };
    const click = (testId: string): void => {
      act(() => {
        container
          .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
          ?.click();
      });
    };

    // Another client's Stop cancelled the chat's only queued message
    // while it was being edited: the chat has nothing else in it.
    keep('Edited prompt');
    await settle();
    expect(shown('queued-message-unsaved-edit')).toBe(true);

    const writeText = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    onCaseEnd(() => {
      Reflect.deleteProperty(navigator, 'clipboard');
    });
    try {
      click('queued-message-unsaved-edit-copy');
      await settle();
      expect(writeText).toHaveBeenCalledWith('Edited prompt');
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }

    // Restore hands the text to this chat's composer, and the card goes.
    click('queued-message-unsaved-edit-restore');
    await settle();
    const editable = container.querySelector<HTMLElement>(
      '[data-chat-composer-root] [contenteditable="true"]',
    );
    if (editable === null) throw new Error('No composer.');
    expect(
      serializeEditorValue(composerEditorOf(editable).children).text,
    ).toContain('Edited prompt');
    expect(shown('queued-message-unsaved-edit')).toBe(false);

    // A cleared edit is kept as empty text, never as the message's old text.
    keep('');
    await settle();
    expect(shown('queued-message-unsaved-edit')).toBe(true);
    click('queued-message-unsaved-edit-dismiss');
    await settle();
    expect(shown('queued-message-unsaved-edit')).toBe(false);
    expect(useChatStore.getState().unsavedQueuedEdits).toEqual([]);
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
    const search = doc.querySelector<HTMLInputElement>(
      '[aria-label="Search by name"]',
    );
    expect(search).not.toBeNull();
    expect(doc.activeElement).toBe(search);
    const reviewToggle = doc.querySelector<HTMLInputElement>(
      'input[aria-label="Select Review"]',
    );
    expect(reviewToggle).not.toBeNull();
    act(() => {
      reviewToggle?.click();
    });
    act(() => {
      doc
        .querySelector<HTMLButtonElement>(
          '[data-testid="remote-control-plugins-save"]',
        )
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
        .querySelector<HTMLButtonElement>(
          '[data-testid="remote-control-plugins-save"]',
        )
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

  it("shows a cloud chat's model with its mark and lists the hosted catalog by vendor, as the web does (CAN-6753)", async () => {
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
    // The chip draws the model's mark, never the letter fallback a provider
    // the picker can't name gets.
    const triggers = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="remote-control-chat-model-picker"]',
      ),
    );
    expect(triggers.length).toBeGreaterThan(0);
    expect(
      triggers.map(
        (trigger) =>
          trigger
            .querySelector(
              '[data-testid="remote-control-chat-model-picker-provider-icon"]',
            )
            ?.getAttribute('data-provider') ?? null,
      ),
    ).toEqual(triggers.map(() => 'claude'));
    expect(
      triggers.some(
        (trigger) =>
          trigger.querySelector('[data-generic-provider-icon]') !== null,
      ),
    ).toBe(false);
    // Its rows sit under their vendors, never one "Other models" section,
    // and a model the library keeps locked stays out of the list.
    act(() => {
      triggers[0]?.click();
    });
    await settle();
    const menu = document.querySelector(
      '[data-testid="remote-control-chat-model-menu"]',
    );
    expect(menu).not.toBeNull();
    const sections = Array.from(
      menu?.querySelectorAll('[role="group"][aria-label]') ?? [],
      (group) => group.getAttribute('aria-label'),
    );
    expect(sections).toEqual(expect.arrayContaining(['Anthropic', 'OpenAI']));
    expect(sections).not.toContain('Other models');
    expect(menu?.textContent ?? '').not.toContain('Locked model');
    // The catalog is read at revision 2, the hosted catalog the web reads.
    expect(
      coreRequestLog.some(
        (request) =>
          request.method === 'core.catalog.snapshot.get' &&
          request.params.revision === 2,
      ),
    ).toBe(true);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
  });

  /** The navigation context, read; the unlock bills it (CAN-6937). */
  const withNavigationContext = (
    context:
      | { kind: 'personal' }
      | { kind: 'organization'; organizationId: string },
  ): (() => void) => {
    const before = useWorkspaceContextStore.getState();
    useWorkspaceContextStore.setState((store) => ({
      hydrated: true,
      state: { ...store.state, context },
    }));
    return () =>
      useWorkspaceContextStore.setState({
        hydrated: before.hydrated,
        state: before.state,
      });
  };

  it("lists a model the owner's library keeps locked as locked, as the web does, and unlocks it without selecting it (CAN-6937)", async () => {
    cloudModelLibrary = 'needs_purchase';
    // The cloud workspace is personal; another organization's context
    // can't unlock it, so its locked model isn't listed there.
    let restoreContext = withNavigationContext({
      kind: 'organization',
      organizationId: 'org-2',
    });
    try {
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
      const before = shownModel();
      act(() => {
        container
          .querySelector<HTMLElement>(
            '[data-testid="remote-control-chat-model-picker"]',
          )
          ?.click();
      });
      await settle();
      expect(lockedRowNamed('Locked model')).toBeUndefined();
      expect(
        document.querySelector('[data-testid="remote-control-chat-model-menu"]')
          ?.textContent ?? '',
      ).not.toContain('Locked model');
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      await settle();
      restoreContext();
      restoreContext = withNavigationContext({ kind: 'personal' });
      await settle();
      const trigger = container.querySelector<HTMLElement>(
        '[data-testid="remote-control-chat-model-picker"]',
      );
      act(() => {
        trigger?.click();
      });
      await settle();
      const menu = document.querySelector(
        '[data-testid="remote-control-chat-model-menu"]',
      );
      // Listed, greyed out as locked, with the web's shared unlock label.
      const locked = Array.from(
        menu?.querySelectorAll<HTMLElement>('[data-locked="true"]') ?? [],
      ).find((row) => (row.textContent ?? '').includes('Locked model'));
      expect(locked).toBeDefined();
      expect(locked?.textContent ?? '').toContain(
        MODEL_LIBRARY_UNLOCK_LABELS.needs_purchase,
      );
      const updatesBefore = chatUpdates.length;
      act(() => {
        locked?.click();
      });
      await settle();
      // Its action starts the unlock, naming no model to apply afterwards.
      expect(mockUnlockModels).toHaveBeenCalledTimes(1);
      expect(mockUnlockModels).toHaveBeenCalledWith({ source: 'desktop' });
      // It is never selected: no model change goes out, and the chat keeps its own.
      expect(chatUpdates.slice(updatesBefore).map(modelOf)).not.toContain(
        'locked-model',
      );
      expect(shownModel()).toBe(before);
      expect(shownModel()).not.toBe('locked-model');
      // An unlock that opened says nothing more.
      expect(
        container.querySelector('[data-testid="chat-input-unlock-failed"]'),
      ).toBeNull();
      // One that couldn't open says so in the composer, never as a toast.
      mockUnlockModels.mockResolvedValueOnce({ outcome: 'failed' });
      act(() => {
        container
          .querySelector<HTMLElement>(
            '[data-testid="remote-control-chat-model-picker"]',
          )
          ?.click();
      });
      await settle();
      act(() => {
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-testid="remote-control-chat-model-menu"] [data-locked="true"]',
          ),
        )
          .find((row) => (row.textContent ?? '').includes('Locked model'))
          ?.click();
      });
      await settle();
      expect(
        container.querySelector('[data-testid="chat-input-unlock-failed"]'),
      ).not.toBeNull();
      expect(shownModel()).toBe(before);
      // One that finds the library already unlocked lists the model as it now
      // is, still without selecting it.
      cloudModelLibrary = 'unlocked';
      lockedModelEligibility = 'available';
      mockUnlockModels.mockResolvedValueOnce({ outcome: 'unlocked' });
      act(() => {
        container
          .querySelector<HTMLElement>(
            '[data-testid="remote-control-chat-model-picker"]',
          )
          ?.click();
      });
      await settle();
      act(() => {
        lockedRowNamed('Locked model')?.click();
      });
      await settle();
      expect(shownModel()).toBe(before);
      act(() => {
        container
          .querySelector<HTMLElement>(
            '[data-testid="remote-control-chat-model-picker"]',
          )
          ?.click();
      });
      await settle();
      expect(lockedRowNamed('Locked model')).toBeUndefined();
      expect(
        document.querySelector('[data-testid="remote-control-chat-model-menu"]')
          ?.textContent ?? '',
      ).toContain('Locked model');
    } finally {
      restoreContext();
    }
  });

  it("reads a cloud chat's locked models again when a confirmed unlock refreshes the account (CAN-6937)", async () => {
    cloudModelLibrary = 'needs_purchase';
    const restoreContext = withNavigationContext({ kind: 'personal' });
    try {
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
      const openPicker = async (): Promise<void> => {
        act(() => {
          container
            .querySelector<HTMLElement>(
              '[data-testid="remote-control-chat-model-picker"]',
            )
            ?.click();
        });
        await settle();
      };
      await openPicker();
      expect(lockedRowNamed('Locked model')).toBeDefined();
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      await settle();
      // The purchase is confirmed elsewhere, which refreshes the account.
      cloudModelLibrary = 'unlocked';
      lockedModelEligibility = 'available';
      act(() => {
        announceCanopyCloudAccountChanged('same-account-refresh');
      });
      await settle();
      await openPicker();
      expect(lockedRowNamed('Locked model')).toBeUndefined();
      expect(
        document.querySelector('[data-testid="remote-control-chat-model-menu"]')
          ?.textContent ?? '',
      ).toContain('Locked model');
    } finally {
      restoreContext();
    }
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

  it("holds a cloud chat to the harness its first answer names on its events, with no snapshot read, as the web's picker does after each turn (CAN-6777)", async () => {
    // Earlier cases leave the task's chats in the store: going offline drops
    // them, so this one opens the task afresh and follows its events.
    act(() => {
      cloudCoworkStore.getState().disconnect('offline');
    });
    connectCloud();
    try {
      // The snapshot names no harness yet: nothing has answered.
      renderPage({ followsEvents: true });
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
      const readsBefore = snapshotReads;
      // The first answer commits: its batch names the answering model's harness.
      snapshotRevision += 1;
      pushFrame('core.chat.events', (params) => worktreeOf(params) === 'wt-1', {
        kind: 'item',
        cursor: { daemonEpoch: 'e1', sequence: snapshotRevision },
        item: {
          schemaVersion: 1,
          eventId: `harness-${snapshotRevision}`,
          occurredAt: CREATED_AT,
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          baseRevision: snapshotRevision - 1,
          revision: snapshotRevision,
          changes: [
            {
              type: 'tab.metadata_patched',
              tabId: 'wt-1',
              patch: { executionHarness: 'claude' },
            },
          ],
        },
      });
      await settle();
      const doc = container.ownerDocument;
      const trigger = doc.querySelector<HTMLElement>(
        '[data-testid="remote-control-chat-model-picker"]',
      );
      expect(trigger).not.toBeNull();
      act(() => {
        trigger?.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        );
        trigger?.click();
      });
      await settle();
      const all = doc.querySelector<HTMLElement>(
        '[data-testid="remote-control-chat-model-harness-tab-all"]',
      );
      if (all !== null) {
        act(() => {
          all.click();
        });
        await settle();
      }
      const other = doc.querySelector<HTMLElement>(
        '[data-testid="remote-control-chat-model-menu"] [data-model-id="vendor-b-model"]',
      );
      // The other harness's model is greyed out, or not listed, as on the web.
      expect(
        other !== null &&
          other.getAttribute('aria-disabled') !== 'true' &&
          !other.hasAttribute('disabled'),
      ).toBe(false);
      if (other !== null) {
        act(() => {
          other.click();
        });
        await settle();
      }
      expect(chatUpdates.map(modelOf)).not.toContain('vendor-b-model');
      expect(snapshotReads).toBe(readsBefore);
    } finally {
      // Later cases open the task with no harness named.
      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
    }
  });

  it("keeps a cloud chat to the harness it runs on, as the web's picker does: a model on another harness can't be picked and never reaches the web core (CAN-6761)", async () => {
    // The chat's answers ran on one harness; the catalog's vendor B model
    // runs on another.
    snapshotHarness = 'claude';
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
    // The window reads the chat's snapshot again, whatever an earlier read
    // held.
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await settle();
    const doc = container.ownerDocument;
    const openPicker = async (): Promise<void> => {
      const trigger = doc.querySelector<HTMLElement>(
        '[data-testid="remote-control-chat-model-picker"]',
      );
      expect(trigger).not.toBeNull();
      act(() => {
        trigger?.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        );
        trigger?.click();
      });
      await settle();
      // Every harness's models, as the All tab lists them.
      const all = doc.querySelector<HTMLElement>(
        '[data-testid="remote-control-chat-model-harness-tab-all"]',
      );
      if (all !== null) {
        act(() => {
          all.click();
        });
        await settle();
      }
    };
    const row = (modelId: string): HTMLElement | null =>
      doc.querySelector<HTMLElement>(
        `[data-testid="remote-control-chat-model-menu"] [data-model-id="${modelId}"]`,
      );
    const offered = (modelId: string): boolean => {
      const element = row(modelId);
      return (
        element !== null &&
        element.getAttribute('aria-disabled') !== 'true' &&
        !element.hasAttribute('disabled')
      );
    };
    await openPicker();
    expect(
      doc.querySelector('[data-testid="remote-control-chat-model-menu"]'),
    ).not.toBeNull();
    expect(offered('cloud-model')).toBe(true);
    // The other harness's model is greyed out, or not listed, as on the web.
    expect(offered('vendor-b-model')).toBe(false);
    const other = row('vendor-b-model');
    if (other !== null) {
      expect(doc.body.textContent ?? '').toContain(
        'can only switch to models that run on it',
      );
      act(() => {
        other.click();
      });
      await settle();
    }
    expect(chatUpdates.map(modelOf)).not.toContain('vendor-b-model');
    expect(
      useChatStore
        .getState()
        .worktreeChats[
          'web-core:ws-1/web-core:wt-1'
        ]?.tabs.find((tab) => tab.id === target.chatId)?.model,
    ).toBe('cloud-model');
  });

  it("offers every catalog model in a cloud chat the web core names no harness for, as the web's picker does (CAN-6761)", async () => {
    // No answer yet, or a web core from before CAN-6761: nothing to hold to.
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
    // The window reads the chat again: a snapshot that names no harness
    // lifts a restriction an earlier read left.
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await settle();
    const doc = container.ownerDocument;
    const trigger = doc.querySelector<HTMLElement>(
      '[data-testid="remote-control-chat-model-picker"]',
    );
    act(() => {
      trigger?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
      trigger?.click();
    });
    await settle();
    const all = doc.querySelector<HTMLElement>(
      '[data-testid="remote-control-chat-model-harness-tab-all"]',
    );
    if (all !== null) {
      act(() => {
        all.click();
      });
      await settle();
    }
    const other = doc.querySelector<HTMLElement>(
      '[data-testid="remote-control-chat-model-menu"] [data-model-id="vendor-b-model"]',
    );
    expect(other).not.toBeNull();
    expect(other?.getAttribute('aria-disabled')).not.toBe('true');
    act(() => {
      other?.click();
    });
    await settle();
    expect(chatUpdates.map(modelOf)).toContain('vendor-b-model');
  });

  it("keeps a reopened secondary cloud chat to the harness its own snapshot names: a model on another harness can't be picked, and a send keeps the chat's model (CAN-6761)", async () => {
    // The task's snapshot opens the task's chat; chat-2's harness comes only
    // from chat-2's own snapshot, which opening it reads.
    secondaryHarness = 'claude';
    renderPage();
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:chat-2',
    };
    act(() => {
      useChatStore.getState().switchTab(target.chatId, target);
    });
    await settle();
    // The window reads the task's snapshot again, which names only the
    // task's chat: chat-2 keeps the harness its own snapshot named.
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await settle();
    const tabModel = (): string | undefined =>
      useChatStore
        .getState()
        .worktreeChats[
          'web-core:ws-1/web-core:wt-1'
        ]?.tabs.find((tab) => tab.id === target.chatId)?.model;
    const modelBefore = tabModel();
    const doc = container.ownerDocument;
    const trigger = doc.querySelector<HTMLElement>(
      '[data-testid="remote-control-chat-model-picker"]',
    );
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
      trigger?.click();
    });
    await settle();
    const all = doc.querySelector<HTMLElement>(
      '[data-testid="remote-control-chat-model-harness-tab-all"]',
    );
    if (all !== null) {
      act(() => {
        all.click();
      });
      await settle();
    }
    const row = (modelId: string): HTMLElement | null =>
      doc.querySelector<HTMLElement>(
        `[data-testid="remote-control-chat-model-menu"] [data-model-id="${modelId}"]`,
      );
    expect(
      doc.querySelector('[data-testid="remote-control-chat-model-menu"]'),
    ).not.toBeNull();
    // The other harness's model is greyed out, or not listed, as on the web.
    const other = row('vendor-b-model');
    expect(
      other !== null &&
        other.getAttribute('aria-disabled') !== 'true' &&
        !other.hasAttribute('disabled'),
    ).toBe(false);
    if (other !== null) {
      act(() => {
        other.click();
      });
      await settle();
    }
    act(() => {
      doc.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await settle();
    // No pick on another harness reaches the web core, so none can revert
    // on the next send: the chat sends on the model it shows.
    const editable = container.querySelector<HTMLElement>(
      '[data-chat-composer-root] [contenteditable="true"]',
    );
    expect(editable).not.toBeNull();
    if (editable !== null) {
      const editor = composerEditorOf(editable);
      // Whatever the composer holds is replaced: the send is this text alone.
      act(() => {
        Transforms.select(editor, {
          anchor: Editor.start(editor, []),
          focus: Editor.end(editor, []),
        });
        Editor.insertText(editor, 'For the notes chat');
      });
      await settle();
    }
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        ?.click();
    });
    await settle();
    expect(
      coreRequestLog.filter(
        (entry) =>
          entry.method === 'core.chat.message.send' &&
          entry.params.text === 'For the notes chat',
      ),
    ).toHaveLength(1);
    expect(chatUpdates.map(modelOf)).not.toContain('vendor-b-model');
    expect(tabModel()).toBe(modelBefore);
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
            '[data-testid="remote-control-plugins-save"]',
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
    /**
     * Settles after opening the task and after selecting its chat, in place
     * of the fixed `settle()`. Only the CAN-6689 queued-message case passes
     * one (CAN-7223); every other case keeps the fixed settles.
     */
    readonly settleWith?: (step: 'opened' | 'selected') => Promise<void>;
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
    const settleStep = options?.settleWith ?? ((): Promise<void> => settle());
    renderPage(options);
    act(() => {
      openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
    });
    await settleStep('opened');
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:wt-1',
    };
    act(() => {
      useChatStore.getState().switchTab(target.chatId, target);
    });
    await settleStep('selected');
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

  it("shows a transcript image this window never uploaded as its picture, read through its chat's web core, and keeps a larger one a file tile (CAN-6824)", async () => {
    const picture = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
    attachmentBytes.set('attachment:att-web-image', {
      sizeBytes: picture.byteLength,
      head: picture,
    });
    // Past one read: the head alone is served, as the web core's first range.
    attachmentBytes.set('attachment:att-large-image', {
      sizeBytes: CLOUD_ATTACHMENT_THUMBNAIL_MAX_BYTES + 1,
      head: picture,
    });
    // Sent from the web, so this window holds neither file.
    startedPrompts.push({
      id: 'web-image-u',
      role: 'user',
      blocks: [{ type: 'text', text: 'Here is the diagram' }],
      timestamp: Date.now(),
      attachments: [
        {
          attachmentId: 'att-web-image',
          filename: 'diagram.png',
          mediaType: 'image/png',
          size: picture.byteLength,
        },
        {
          attachmentId: 'att-large-image',
          filename: 'poster.png',
          mediaType: 'image/png',
          size: CLOUD_ATTACHMENT_THUMBNAIL_MAX_BYTES + 1,
        },
      ],
    });
    await openTaskChat();
    await rereadTranscript();
    const pictures = Array.from(
      container.querySelectorAll<HTMLImageElement>(
        '[data-testid="message-image-attachments"] img',
      ),
    );
    expect(pictures.map((image) => [image.alt, image.src])).toEqual([
      [
        'diagram.png',
        `data:image/png;base64,${btoa(String.fromCharCode(...picture))}`,
      ],
    ]);
    expect(
      Array.from(
        container.querySelectorAll('[data-testid="message-file-attachment"]'),
      ).map((tile) => tile.textContent),
    ).toEqual([expect.stringContaining('poster.png')]);
    // Each read once, scoped to the chat, one range at most: nothing past
    // the larger file's first range.
    expect(artifactReads).toEqual([
      {
        artifactId: 'attachment:att-web-image',
        scope: { chatId: 'wt-1' },
        offset: 0,
        length: CLOUD_ATTACHMENT_THUMBNAIL_MAX_BYTES,
      },
      {
        artifactId: 'attachment:att-large-image',
        scope: { chatId: 'wt-1' },
        offset: 0,
        length: CLOUD_ATTACHMENT_THUMBNAIL_MAX_BYTES,
      },
    ]);
    expect(calls.some((call) => call.path === 'api.readFilePreview')).toBe(
      false,
    );
  });

  function runningDelegateCard(run: string): Record<string, unknown> {
    return {
      type: 'delegated_agent_call',
      delegationId: `cloud-delegate-${run}`,
      agentBlockId: `delegated-agent-cloud-delegate-${run}`,
      runGeneration: 1,
      status: 'running',
      outputTruncated: false,
      transcriptStore: 'chat-stream-v2',
      sequence: 1,
      parentHarnessId: 'claude',
      parentTurnId: 'cloud-turn',
      parentToolCallId: `cloud-spawn-${run}`,
      selectedModelId: 'cloud-model',
      runtimeModelId: 'cloud-model',
      targetHarnessId: 'claude',
      description: `Review ${run}`,
      prompt: `Review ${run}.`,
      executionMode: 'background',
      createdAt: Date.now() - 1000,
    };
  }

  it("offers no delegate Stop, Stop all or Load changes on a cloud chat, whose scope can't stop its delegates, and sends main no cloud id for them", async () => {
    startedPrompts.push(
      {
        id: 'delegating-u',
        role: 'user',
        blocks: [{ type: 'text', text: 'Review both halves' }],
        timestamp: Date.now(),
      },
      {
        id: 'delegating-a',
        role: 'assistant',
        blocks: [
          {
            ...runningDelegateCard('first'),
            isolatedWorkspace: {
              revision: 'rev-1',
              dirtyParentChangesIncluded: false,
            },
          },
          runningDelegateCard('second'),
        ],
        timestamp: Date.now(),
      },
    );
    await openTaskChat();
    await rereadTranscript();
    expect(cloudScopeCapabilitiesNow().delegationStop === true).toBe(false);
    // The finished turn folds its steps under its Worked header, whose
    // toggle scrolls with CSS.escape, which jsdom lacks.
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { escape: (value: string): string => value },
    });
    onCaseEnd(() => {
      Reflect.deleteProperty(globalThis, 'CSS');
    });
    const header = container.querySelector<HTMLElement>(
      '[data-testid="turn-work-header"] button',
    );
    expect(header).not.toBeNull();
    act(() => {
      header?.click();
    });
    await settle();
    expect(
      container.querySelectorAll('[data-testid="chat-delegated-agent"]'),
    ).toHaveLength(2);
    const details = container.querySelector<HTMLElement>(
      '[data-delegation-id="cloud-delegate-first"] button[aria-label="Expand delegated task"]',
    );
    expect(details).not.toBeNull();
    act(() => {
      details?.click();
    });
    await settle();
    expect(shown('delegated-agent-metadata')).toBe(true);
    const toggle = container.querySelector<HTMLElement>(
      '[data-testid="background-tray-toggle"]',
    );
    if (toggle !== null)
      act(() => {
        toggle.click();
      });
    await settle();
    expect(
      container.querySelectorAll('[data-testid="background-tray-agent"]'),
    ).toHaveLength(2);
    expect({
      cardStop: shown('delegated-agent-stop'),
      loadChanges: shown('delegated-agent-show-changes'),
      trayRowStop: shown('background-tray-agent-stop'),
      stopAll: shown('background-tray-stop-all'),
    }).toEqual({
      cardStop: false,
      loadChanges: false,
      trayRowStop: false,
      stopAll: false,
    });
    // Reading an expanded card's transcript is CAN-7027's.
    expect(
      calls.filter((call) =>
        [
          'api.managedDelegation.stop',
          'api.managedDelegation.stopAll',
          'api.managedDelegation.changes',
        ].includes(call.path),
      ),
    ).toEqual([]);
  });

  /** A delegate's live state as the web core lists it (CAN-7245). */
  function liveDelegateSnapshot(run: string): Record<string, unknown> {
    return {
      delegationId: `cloud-delegate-${run}`,
      status: 'running',
      phase: 'running',
      runGeneration: 1,
      requestedModelId: 'cloud-model',
      outputTruncated: false,
    };
  }

  /**
   * Opens the task with running delegate cards in its chat, the first of
   * them isolated, and unfolds its Worked section (CAN-7245).
   */
  async function openDelegateCards(
    runs: readonly string[] = ['first', 'second'],
    cards: Readonly<Record<string, Record<string, unknown>>> = {},
  ): Promise<void> {
    startedPrompts.push(
      {
        id: 'delegating-u',
        role: 'user',
        blocks: [{ type: 'text', text: 'Review both halves' }],
        timestamp: Date.now(),
      },
      {
        id: 'delegating-a',
        role: 'assistant',
        blocks: runs.map((run, index) =>
          index === 0
            ? {
                ...runningDelegateCard(run),
                isolatedWorkspace: {
                  revision: 'rev-1',
                  dirtyParentChangesIncluded: false,
                },
                ...cards[run],
              }
            : { ...runningDelegateCard(run), ...cards[run] },
        ),
        timestamp: Date.now(),
      },
    );
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { escape: (value: string): string => value },
    });
    onCaseEnd(() => {
      Reflect.deleteProperty(globalThis, 'CSS');
    });
    await openTaskChat();
    await rereadTranscript();
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="turn-work-header"] button')
        ?.click();
    });
    await settle();
  }

  const cardStop = (run: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(
      `[data-delegation-id="cloud-delegate-${run}"] [data-testid="delegated-agent-stop"]`,
    );
  const cardText = (run: string): string =>
    container.querySelector(`[data-delegation-id="cloud-delegate-${run}"]`)
      ?.textContent ?? '';
  const delegationRequests = (method: string): Record<string, unknown>[] =>
    coreRequestLog
      .filter((entry) => entry.method === method)
      .map((entry) => entry.params);
  /** A keyed request's params without its key, and the key's type. */
  const keyedRequests = (
    method: string,
  ): { params: Record<string, unknown>; key: string }[] =>
    delegationRequests(method).map((params) => ({
      params: Object.fromEntries(
        Object.entries(params).filter(([field]) => field !== '_meta'),
      ),
      key: typeof Reflect.get(Object(params._meta), 'idempotencyKey'),
    }));
  const delegationIpcCalls = (): string[] =>
    calls
      .filter((call) =>
        [
          'api.managedDelegation.stop',
          'api.managedDelegation.stopAll',
          'api.managedDelegation.changes',
        ].includes(call.path),
      )
      .map((call) => call.path);

  it("stops a cloud chat's own delegate from its card, and all of them from the drawer, through the web core and never main (CAN-7245)", async () => {
    mockDelegationStop = true;
    for (const run of ['first', 'second', 'third'])
      delegationSnapshots.set(
        `cloud-delegate-${run}`,
        liveDelegateSnapshot(run),
      );
    await openDelegateCards(['first', 'second', 'third']);
    await settle();
    expect(cloudScopeCapabilitiesNow().delegationStop).toBe(true);
    // The cards read their delegates' live state for that chat.
    expect(delegationRequests('core.managedDelegation.list')[0]).toEqual({
      scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
      chatId: 'wt-1',
    });
    expect(cardStop('first')).not.toBeNull();
    expect(cardStop('second')).not.toBeNull();
    // A cloud delegate has no retained worktree on this computer to diff.
    act(() => {
      container
        .querySelector<HTMLElement>(
          '[data-delegation-id="cloud-delegate-first"] button[aria-label="Expand delegated task"]',
        )
        ?.click();
    });
    await settle();
    expect(shown('delegated-agent-show-changes')).toBe(false);

    act(() => {
      cardStop('first')?.click();
    });
    await settle();
    await settle();
    expect(keyedRequests('core.managedDelegation.stop')).toEqual([
      {
        params: {
          scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
          chatId: 'wt-1',
          delegationId: 'cloud-delegate-first',
        },
        key: 'string',
      },
    ]);
    // Only a read that says so shows it stopped.
    expect(cardText('first')).toContain('Cancelled');
    expect(cardStop('first')).toBeNull();
    expect(cardStop('second')).not.toBeNull();

    // The drawer keeps its open state across chats; open it only if shut.
    const toggle = container.querySelector<HTMLElement>(
      '[data-testid="background-tray-toggle"]',
    );
    if (toggle !== null && !shown('background-tray-stop-all'))
      act(() => {
        toggle.click();
      });
    await settle();
    // The stopped delegate leaves the drawer; the two still running stay.
    expect(
      container.querySelectorAll('[data-testid="background-tray-agent"]'),
    ).toHaveLength(2);
    expect(shown('background-tray-stop-all')).toBe(true);
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="background-tray-stop-all"]')
        ?.click();
    });
    await settle();
    act(() => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="background-tray-stop-all-confirm"]',
        )
        ?.click();
    });
    await settle();
    await settle();
    expect(keyedRequests('core.managedDelegation.stopAll')).toEqual([
      {
        params: {
          scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
          chatId: 'wt-1',
        },
        key: 'string',
      },
    ]);
    expect(cardText('second')).toContain('Cancelled');
    expect(cardText('third')).toContain('Cancelled');
    expect(delegationIpcCalls()).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it('offers no Load changes on a cloud delegate the web core reports isolated, as its scope reads no retained worktree here (CAN-7245)', async () => {
    mockDelegationStop = true;
    delegationSnapshots.set('cloud-delegate-first', {
      ...liveDelegateSnapshot('first'),
      isolatedWorkspace: {
        revision: 'rev-1',
        dirtyParentChangesIncluded: false,
      },
    });
    await openDelegateCards(['first']);
    await settle();
    act(() => {
      container
        .querySelector<HTMLElement>(
          '[data-delegation-id="cloud-delegate-first"] button[aria-label="Expand delegated task"]',
        )
        ?.click();
    });
    await settle();
    expect(cloudScopeCapabilitiesNow().delegationWorktreeDetails === true).toBe(
      false,
    );
    expect(shown('delegated-agent-metadata')).toBe(true);
    expect(cardStop('first')).not.toBeNull();
    expect(shown('delegated-agent-show-changes')).toBe(false);
    expect(delegationIpcCalls()).toEqual([]);
  });

  it("lists a cloud chat's delegates in the drawer by the web core's live state, as their cards show them (CAN-7245)", async () => {
    mockDelegationStop = true;
    // Its card says queued; the web core says it runs.
    delegationSnapshots.set(
      'cloud-delegate-started',
      liveDelegateSnapshot('started'),
    );
    // Its card says done; the web core says its second run runs.
    delegationSnapshots.set('cloud-delegate-resumed', {
      ...liveDelegateSnapshot('resumed'),
      runGeneration: 2,
    });
    await openDelegateCards(['started', 'resumed'], {
      started: { status: 'pending' },
      resumed: { status: 'completed' },
    });
    await settle();
    const toggle = container.querySelector<HTMLElement>(
      '[data-testid="background-tray-toggle"]',
    );
    if (toggle?.getAttribute('data-chevron') === 'up')
      act(() => {
        toggle.click();
      });
    await settle();
    const row = (run: string): Element | null =>
      container.querySelector(
        `[data-tray-row="agent:managed:cloud-delegate-${run}"]`,
      );
    expect(row('started')).not.toBeNull();
    expect(row('started')?.querySelector('[data-status="queued"]')).toBeNull();
    expect(row('resumed')).not.toBeNull();
    expect(cardStop('started')).not.toBeNull();
    expect(cardStop('resumed')).not.toBeNull();
  });

  it("refuses to stop a delegate that isn't on a card in that cloud chat, or one asked for another chat, and never shows a refused or unanswered stop as stopped (CAN-7245)", async () => {
    mockDelegationStop = true;
    delegationSnapshots.set(
      'cloud-delegate-first',
      liveDelegateSnapshot('first'),
    );
    delegationSnapshots.set(
      'cloud-delegate-second',
      liveDelegateSnapshot('second'),
    );
    await openDelegateCards();
    await settle();
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-1',
      chatId: 'web-core:wt-1',
    };
    await expect(
      requestManagedDelegationStop(target, 'not-on-a-card'),
    ).resolves.toBe(false);
    await expect(
      requestManagedDelegationStop(
        { ...target, chatId: 'web-core:other-chat' },
        'cloud-delegate-first',
      ),
    ).resolves.toBe(false);
    expect(delegationRequests('core.managedDelegation.stop')).toEqual([]);

    // The web core refuses: the stop fails, and the card still runs.
    delegationStopAnswer = 'not_found';
    act(() => {
      cardStop('first')?.click();
    });
    await settle();
    await settle();
    expect(delegationRequests('core.managedDelegation.stop')).toHaveLength(1);
    expect(cardText('first')).not.toContain('Cancelled');
    expect(cardStop('first')).not.toBeNull();

    // No answer at all: nothing says it stopped.
    delegationStopAnswer = 'hang';
    act(() => {
      cardStop('second')?.click();
    });
    await settle();
    await settle();
    expect(delegationRequests('core.managedDelegation.stop')).toHaveLength(2);
    expect(cardText('second')).not.toContain('Cancelled');
    expect(delegationIpcCalls()).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("reads a cloud delegate's current run once the web core reports a newer one, not the card's first (CAN-7245)", async () => {
    mockDelegationStop = true;
    transcriptPageDetails = ['delegation'];
    delegationSnapshots.set('cloud-delegate-first', {
      ...liveDelegateSnapshot('first'),
      runGeneration: 2,
    });
    delegationSnapshots.set(
      'cloud-delegate-second',
      liveDelegateSnapshot('second'),
    );
    await openDelegateCards();
    await settle();
    act(() => {
      container
        .querySelector<HTMLElement>(
          '[data-delegation-id="cloud-delegate-first"] button[aria-label="Expand delegated task"]',
        )
        ?.click();
    });
    await settle();
    await settle();
    expect(
      coreRequestLog
        .filter(
          (entry) =>
            entry.method === 'core.chat.transcript.page' &&
            entry.params.target !== undefined,
        )
        .map((entry): unknown =>
          Reflect.get(Object(entry.params.target), 'runGeneration'),
        ),
    ).toEqual([2]);
  });

  it("keeps reading a cloud chat's settled delegates while its turn runs, so one it resumes shows Stop again (CAN-7245)", async () => {
    mockDelegationStop = true;
    runningTurn = 'cloud-turn';
    onCaseEnd(() => {
      runningTurn = null;
    });
    delegationSnapshots.set('cloud-delegate-first', {
      ...liveDelegateSnapshot('first'),
      status: 'completed',
      phase: 'idle',
    });
    await openDelegateCards(['first']);
    await settle();
    expect(cardStop('first')).toBeNull();
    // The parent's agent starts it again under the same delegation id.
    delegationSnapshots.set(
      'cloud-delegate-first',
      liveDelegateSnapshot('first'),
    );
    await act(
      () =>
        new Promise((resolve) =>
          setTimeout(resolve, LIVE_DELEGATION_POLL_MS + 500),
        ),
    );
    await settle();
    expect(cardStop('first')).not.toBeNull();
  });

  /** A running background delegate of the cloud task's chat (CAN-7027). */
  function cloudDelegateCard(delegationId: string): Record<string, unknown> {
    return {
      type: 'delegated_agent_call',
      delegationId,
      agentBlockId: `delegated-agent-${delegationId}`,
      runGeneration: 1,
      status: 'running',
      outputTruncated: false,
      transcriptStore: 'chat-stream-v2',
      sequence: 1,
      parentHarnessId: 'claude',
      parentTurnId: 'cloud-turn',
      parentToolCallId: `cloud-spawn-${delegationId}`,
      selectedModelId: 'cloud-model',
      runtimeModelId: 'cloud-model',
      targetHarnessId: 'claude',
      description: 'Review the notes',
      prompt: 'Review the notes.',
      executionMode: 'background',
      createdAt: Date.now() - 1000,
    };
  }

  /**
   * Opens the task with one delegate card in its chat and expands it: the
   * finished turn folds its steps under its Worked header, whose toggle
   * scrolls with CSS.escape, which jsdom lacks.
   */
  async function openDelegateCard(delegationId: string): Promise<void> {
    startedPrompts.push(
      {
        id: 'delegating-u',
        role: 'user',
        blocks: [{ type: 'text', text: 'Review the notes' }],
        timestamp: Date.now(),
      },
      {
        id: 'delegating-a',
        role: 'assistant',
        blocks: [cloudDelegateCard(delegationId)],
        timestamp: Date.now(),
      },
    );
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { escape: (value: string): string => value },
    });
    onCaseEnd(() => {
      Reflect.deleteProperty(globalThis, 'CSS');
    });
    await openTaskChat();
    await rereadTranscript();
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="turn-work-header"] button')
        ?.click();
    });
    await settle();
    act(() => {
      container
        .querySelector<HTMLElement>(
          `[data-delegation-id="${delegationId}"] button[aria-label="Expand delegated task"]`,
        )
        ?.click();
    });
    await settle();
  }

  const delegationReads = (): Record<string, unknown>[] =>
    coreRequestLog
      .filter(
        (entry) =>
          entry.method === 'core.chat.transcript.page' &&
          entry.params.target !== undefined,
      )
      .map((entry) => entry.params);

  const delegationIpc = (): string[] =>
    calls
      .filter((call) => call.path.startsWith('api.managedDelegation.'))
      .map((call) => call.path);

  it("reads none of a cloud delegate's pages while the cloud scope doesn't read delegate transcripts, and asks main for none (CAN-7027)", async () => {
    delegateTranscripts.set('cloud-delegate-off', [
      {
        id: 'child-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Child row' }],
        timestamp: Date.now(),
      },
    ]);
    await openDelegateCard('cloud-delegate-off');
    expect(cloudScopeCapabilitiesNow().delegationTranscriptReads === true).toBe(
      false,
    );
    expect(shown('chat-delegated-agent')).toBe(true);
    expect(shown('delegation-child-pages-unavailable')).toBe(true);
    expect(delegationReads()).toEqual([]);
    expect(delegationIpc()).toEqual([]);
  });

  it("reads a cloud chat's own delegate's pages from the web core by a delegation target scoped to that chat, and never from main (CAN-7027)", async () => {
    transcriptPageDetails = ['delegation'];
    delegateTranscripts.set('cloud-delegate-on', [
      {
        id: 'child-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'CHILD-ROW-FROM-WEB-CORE' }],
        timestamp: Date.now(),
      },
    ]);
    await openDelegateCard('cloud-delegate-on');
    await settle();
    expect(cloudScopeCapabilitiesNow().delegationTranscriptReads).toBe(true);
    expect(delegationReads()).toEqual([
      {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: 'wt-1' },
        target: {
          kind: 'delegation',
          chatId: 'wt-1',
          delegationId: 'cloud-delegate-on',
          runGeneration: 1,
        },
      },
    ]);
    expect(
      container.querySelector('[data-testid="delegation-child-pages"]')
        ?.textContent,
    ).toContain('CHILD-ROW-FROM-WEB-CORE');
    expect(delegationIpc()).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
    // The delegate's rows reach only its card: no window bridge call (main's
    // notifications and stores) carries them, and nothing else on the page
    // shows them, the Activity tab included.
    const outsideTheCard = (): boolean => {
      const page = container.cloneNode(true);
      if (!(page instanceof HTMLElement)) throw new Error('No page.');
      for (const pages of page.querySelectorAll(
        '[data-testid="delegation-child-pages"]',
      ))
        pages.remove();
      return (page.textContent ?? '').includes('CHILD-ROW-FROM-WEB-CORE');
    };
    expect(
      calls
        .filter((call) =>
          JSON.stringify(call.args).includes('CHILD-ROW-FROM-WEB-CORE'),
        )
        .map((call) => call.path),
    ).toEqual([]);
    expect(outsideTheCard()).toBe(false);
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="panel-tab-panel-activity"]')
        ?.click();
    });
    await settle();
    expect(shown('cloud-attachments-add')).toBe(true);
    expect(outsideTheCard()).toBe(false);
  });

  it("reads a cloud delegate's open pages again once the web core reports its lifecycle changed, so its last messages show (CAN-7245)", async () => {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    delegationSnapshots.set(
      'cloud-delegate-reload',
      liveDelegateSnapshot('reload'),
    );
    const childRow = (id: string, text: string): Record<string, unknown> => ({
      id,
      role: 'assistant',
      blocks: [{ type: 'text', text }],
      timestamp: Date.now(),
    });
    delegateTranscripts.set('cloud-delegate-reload', [
      childRow('child-1', 'CHILD-ROW-BEFORE-STOP'),
    ]);
    await openDelegateCard('cloud-delegate-reload');
    await settle();
    const childPages = (): string =>
      container.querySelector('[data-testid="delegation-child-pages"]')
        ?.textContent ?? '';
    expect(childPages()).toContain('CHILD-ROW-BEFORE-STOP');
    const readsBefore = delegationReads().length;
    delegateTranscripts.set('cloud-delegate-reload', [
      childRow('child-1', 'CHILD-ROW-BEFORE-STOP'),
      childRow('child-2', 'CHILD-ROW-AFTER-STOP'),
    ]);

    act(() => {
      cardStop('reload')?.click();
    });
    await settle();
    await settle();
    expect(cardText('reload')).toContain('Cancelled');
    expect(delegationReads().length).toBeGreaterThan(readsBefore);
    expect(childPages()).toContain('CHILD-ROW-AFTER-STOP');
    expect(delegationIpcCalls()).toEqual([]);
  });

  it("offers no Stop on a delegate's own delegate shown in a cloud card's pages, which isn't on that chat's cards, and keeps the chat's own card's Stop (CAN-7245)", async () => {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    delegationSnapshots.set(
      'cloud-delegate-parent',
      liveDelegateSnapshot('parent'),
    );
    delegateTranscripts.set('cloud-delegate-parent', [
      {
        id: 'child-1',
        role: 'assistant',
        blocks: [
          {
            ...cloudDelegateCard('cloud-delegate-nested'),
            routeSnapshot: {
              selectedModelId: 'cloud-model',
              runtimeModelId: 'cloud-model',
              harnessId: 'claude',
            },
          },
          { type: 'text', text: 'NESTED-CARD-ROW' },
        ],
        timestamp: Date.now(),
      },
    ]);
    await openDelegateCard('cloud-delegate-parent');
    await settle();
    const nested = container.querySelector(
      '[data-testid="delegation-child-pages"] [data-delegation-id="cloud-delegate-nested"]',
    );
    expect(nested).not.toBeNull();
    expect(
      nested?.querySelector('[data-testid="delegated-agent-stop"]') ?? null,
    ).toBeNull();
    const ownStops = [
      ...container.querySelectorAll(
        '[data-delegation-id="cloud-delegate-parent"] [data-testid="delegated-agent-stop"]',
      ),
    ].filter((button) => nested === null || !nested.contains(button));
    expect(ownStops).toHaveLength(1);
    expect(delegationRequests('core.managedDelegation.stop')).toEqual([]);
  });

  it("refuses a delegate that isn't on a card in that cloud chat, or is read for another chat, before asking the web core, and shows a web core refusal as unavailable (CAN-7027)", async () => {
    transcriptPageDetails = ['delegation'];
    await openDelegateCard('cloud-delegate-own');
    const before = delegationReads().length;
    const read = (
      delegationId: string,
      chatId = 'web-core:wt-1',
    ): ReturnType<typeof ipcTranscriptReadClient.delegationPage> =>
      ipcTranscriptReadClient.delegationPage(
        {
          scope: {
            workspaceId: 'web-core:ws-1',
            worktreeId: 'web-core:wt-1',
            chatId: 'web-core:wt-1',
          },
          target: {
            kind: 'delegation',
            chatId,
            delegationId,
            runGeneration: 1,
          },
        },
        new AbortController().signal,
      );
    await expect(read('not-on-a-card')).resolves.toEqual({
      ok: false,
      kind: 'unavailable',
    });
    await expect(
      read('cloud-delegate-own', 'web-core:other-chat'),
    ).resolves.toEqual({ ok: false, kind: 'unavailable' });
    expect(delegationReads().length).toBe(before);
    // Its own delegate goes out; the web core finds no such delegation for
    // this caller, and the reader treats that as unavailable.
    await expect(read('cloud-delegate-own')).resolves.toEqual({
      ok: false,
      kind: 'unavailable',
    });
    expect(delegationReads().length).toBe(before + 1);
    expect(delegationIpc()).toEqual([]);
  });

  for (const [label, details, reads] of [
    ['lists no details for it, as an older web core does', undefined, false],
    ['lists a detail other than delegation', ['other'], false],
    ['lists the delegation target', ['delegation'], true],
  ] as const) {
    it(`reads a cloud chat's delegate pages only when the web core's manifest ${label}, and never offers the Subagents panels there (CAN-7027)`, async () => {
      transcriptPageDetails = details === undefined ? undefined : [...details];
      renderPage();
      act(() => {
        openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
      });
      await settle();
      // The capability follows the manifest, which loads after first render.
      await settle();
      expect(coreRequests).toContain('core.runtime.manifest.get');
      const capabilities = cloudScopeCapabilitiesNow();
      expect(capabilities.delegationTranscriptReads === true).toBe(reads);
      // Without cloudSubagentPanels, which nothing passes yet (CAN-7133),
      // the add menu and the layout refuse both kinds either way.
      expect(
        panelKindsUnavailableFor(capabilities).filter(
          (kind) => kind === 'subagents' || kind === 'subagent-chat',
        ),
      ).toEqual(['subagents', 'subagent-chat']);
      expect(
        (['subagents', 'subagent-chat'] as const).map((kind) =>
          layoutScopeServesPanelKind('web-core:ws-1/web-core:wt-1', kind),
        ),
      ).toEqual([false, false]);
    });
  }

  /** A cloud chat's local id, as the chat store keys its tab. */
  const cloudChat = (chatId: string): string => `web-core:${chatId}`;
  const CLOUD_SCOPE = {
    projectId: 'web-core:ws-1',
    worktreeId: 'web-core:wt-1',
  } as const;
  const CLOUD_SCOPE_KEY = 'web-core:ws-1/web-core:wt-1';

  /**
   * The cloud task's two chats, each with its own running delegate card
   * (CAN-7133): the task's chat ("Brief") starts delegate a and a Claude Task
   * agent, the second chat ("Notes") starts delegate b. A's card recorded it
   * done; the web core says it runs again. The web core's list
   * answers every chat's delegates alike here, so a chat's store also holds
   * the other chat's snapshot: only its own cards may put one in its tree.
   */
  function seedTwoRoots(): void {
    const at = Date.now();
    transcripts['wt-1'] = [
      {
        id: 'brief-u',
        role: 'user',
        blocks: [{ type: 'text', text: 'Review a' }],
        timestamp: at,
      },
      {
        id: 'brief-a',
        role: 'assistant',
        blocks: [
          { ...runningDelegateCard('a'), status: 'completed' },
          {
            type: 'tool_use',
            toolUseId: 'native-task-a',
            toolName: 'Task',
            input: JSON.stringify({
              description: 'Scan the files',
              prompt: 'Scan the files.',
              subagent_type: 'general-purpose',
            }),
          },
        ],
        timestamp: at,
      },
    ];
    transcripts['chat-2'] = [
      {
        id: 'notes-u',
        role: 'user',
        blocks: [{ type: 'text', text: 'Review b' }],
        timestamp: at,
      },
      {
        id: 'notes-a',
        role: 'assistant',
        blocks: [runningDelegateCard('b')],
        timestamp: at,
      },
    ];
    delegationSnapshots.set('cloud-delegate-a', liveDelegateSnapshot('a'));
    delegationSnapshots.set('cloud-delegate-b', liveDelegateSnapshot('b'));
  }

  /**
   * Adds a Subagents tab to the task's layout, if it serves one and has none.
   * An earlier case may leave the task's minimal layout, whose chat group
   * takes only chats: the extras group takes any panel.
   */
  function addSubagentsTab(): void {
    const groups =
      usePanelLayoutStore.getState().layouts[CLOUD_SCOPE_KEY]?.groups ?? {};
    const groupId =
      'group-extras' in groups ? 'group-extras' : Object.keys(groups)[0];
    act(() => {
      usePanelLayoutStore
        .getState()
        .addTab(CLOUD_SCOPE_KEY, groupId ?? '', 'subagents');
    });
  }

  /** Opens the task, then a Subagents panel in its layout, if it serves one. */
  async function openSubagentsPanel(): Promise<void> {
    // The layout store keeps a task's panels across cases, and each kind
    // opens once: close them as the case ends.
    onCaseEnd(() => {
      const layouts = usePanelLayoutStore.getState();
      for (const [groupId, group] of Object.entries(
        layouts.layouts[CLOUD_SCOPE_KEY]?.groups ?? {},
      ))
        layouts.closeTabs(
          CLOUD_SCOPE_KEY,
          groupId,
          group.tabs
            .filter(
              (tab) => tab.kind === 'subagents' || tab.kind === 'subagent-chat',
            )
            .map((tab) => tab.panelId),
        );
    });
    await openTaskChat();
    await rereadTranscript();
    // The second chat's transcript, as opening its tab reads it.
    act(() => {
      useChatStore.getState().switchTab(cloudChat('chat-2'), CLOUD_SCOPE);
    });
    await settle();
    act(() => {
      useChatStore.getState().switchTab(cloudChat('wt-1'), CLOUD_SCOPE);
    });
    await settle();
    addSubagentsTab();
    await settle();
    await settle();
  }

  async function selectSubagentRoot(chatId: string): Promise<void> {
    act(() => {
      const viewState = useSubagentViewStateStore.getState();
      // The list view: the tree view draws a lazy canvas jsdom can't.
      viewState.setView(CLOUD_SCOPE_KEY, 'list');
      viewState.setSelectedRoot(CLOUD_SCOPE_KEY, cloudChat(chatId));
    });
    await settle();
    await settle();
  }

  /** The Subagents panel's rows, by subagent id. */
  const subagentRows = (): string[] =>
    Array.from(
      container.querySelectorAll('[data-testid^="subagents-list-row-"]'),
      (row) =>
        (row.getAttribute('data-testid') ?? '').replace(
          'subagents-list-row-',
          '',
        ),
    ).sort();

  /** The root picker's options, by chat id. */
  async function subagentRootOptions(): Promise<string[]> {
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="subagents-root-picker"]')
        ?.click();
    });
    await settle();
    const options = Array.from(
      document.querySelectorAll('[data-testid^="subagents-root-option-"]'),
      (row) =>
        (row.getAttribute('data-testid') ?? '').replace(
          'subagents-root-option-',
          '',
        ),
    ).sort();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await settle();
    return options;
  }

  /** Main's subagent reads and commands: none may carry a cloud id. */
  const SUBAGENT_IPC = [
    'api.managedDelegation.tree',
    'api.managedDelegation.roots',
    'api.managedDelegation.transcriptPage',
    'api.managedDelegation.stop',
    'api.managedDelegation.message',
    'api.managedDelegation.worktreeSummary',
    'api.managedDelegation.changes',
    'api.chat.readToolOutput',
    'api.activity.stopBgProcess',
    'api.activity.readWorkflowRun',
    'api.nativeSubagents.interrupt',
  ];
  const subagentIpc = (): string[] =>
    calls
      .filter((call) => SUBAGENT_IPC.includes(call.path))
      .map((call) => call.path);

  it("sends main no cloud id from the Subagents panels' reads or commands while they're off (CAN-7133)", async () => {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    seedTwoRoots();
    await openSubagentsPanel();
    expect(cloudScopeCapabilitiesNow().subagentPanels).toBeUndefined();
    expect(layoutScopeServesPanelKind(CLOUD_SCOPE_KEY, 'subagents')).toBe(
      false,
    );
    expect(shown('subagents-panel')).toBe(false);
    expect(subagentIpc()).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("lists a cloud task's root chats, and each root's own delegates and native subagents, from what the desktop already holds (CAN-7133)", async () => {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    mockCloudSubagentPanels = true;
    seedTwoRoots();
    await openSubagentsPanel();
    expect(shown('subagents-panel')).toBe(true);
    // Both of the task's chats are roots: each holds its own delegate card.
    expect(await subagentRootOptions()).toEqual([
      cloudChat('chat-2'),
      cloudChat('wt-1'),
    ]);

    await selectSubagentRoot('wt-1');
    expect(subagentRows()).toEqual(['cloud-delegate-a', 'native-task-a']);
    // A's card keeps its first state; the tree reads the web core's.
    expect(
      getSubagentTreeSnapshot(CLOUD_SCOPE, cloudChat('wt-1')).tree?.nodes.get(
        'cloud-delegate-a',
      )?.status,
    ).toBe('running');

    // Two roots in the same task: B's tree never shows A's delegates, though
    // its chat's live read lists them.
    await selectSubagentRoot('chat-2');
    expect(subagentRows()).toEqual(['cloud-delegate-b']);
    const treeB = getSubagentTreeSnapshot(CLOUD_SCOPE, cloudChat('chat-2'));
    expect(treeB.tree?.nodes.has('cloud-delegate-a')).toBe(false);
    expect(treeB.tree?.nodes.has('native-task-a')).toBe(false);
    // ...and A's never shows B's.
    expect(
      getSubagentTreeSnapshot(CLOUD_SCOPE, cloudChat('wt-1')).tree?.nodes.has(
        'cloud-delegate-b',
      ),
    ).toBe(false);
    // Each chat's live state is read with that chat alone.
    expect(
      [
        ...new Set(
          delegationRequests('core.managedDelegation.list').map((params) =>
            JSON.stringify(params),
          ),
        ),
      ].sort(),
    ).toEqual(
      ['chat-2', 'wt-1'].map((chatId) =>
        JSON.stringify({
          scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
          chatId,
        }),
      ),
    );
    expect(subagentIpc()).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  /** Opens delegate `run`'s subagent chat under root chat `chatId`. */
  async function openCloudSubagentChat(
    chatId: string,
    run: string,
  ): Promise<void> {
    await act(async () => {
      await openSubagentChatPanel(CLOUD_SCOPE, {
        rootChatId: cloudChat(chatId),
        subagentId: `cloud-delegate-${run}`,
        subagentKind: 'managed',
        title: `Review ${run}`,
      });
    });
    await settle();
    await settle();
  }

  it("opens a cloud delegate's subagent chat and reads its pages from the web core, scoped to its own root chat (CAN-7133)", async () => {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    mockCloudSubagentPanels = true;
    seedTwoRoots();
    delegateTranscripts.set('cloud-delegate-b', [
      {
        id: 'child-b-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'B-CHILD-ROW-FROM-WEB-CORE' }],
        timestamp: Date.now(),
      },
    ]);
    await openSubagentsPanel();
    await openCloudSubagentChat('chat-2', 'b');
    expect(shown('subagent-chat-panel')).toBe(true);
    expect(
      container.querySelector('[data-testid="subagent-chat-panel"]')
        ?.textContent,
    ).toContain('B-CHILD-ROW-FROM-WEB-CORE');
    // Only B's delegate, under B's own chat.
    expect([
      ...new Set(delegationReads().map((params) => JSON.stringify(params))),
    ]).toEqual([
      JSON.stringify({
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-2' },
        target: {
          kind: 'delegation',
          chatId: 'chat-2',
          delegationId: 'cloud-delegate-b',
          runGeneration: 1,
        },
      }),
    ]);
    // No legacy item pages and no tool output from main.
    expect(subagentIpc()).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it('offers a cloud subagent only the controls its scope serves (CAN-7133)', async () => {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    mockCloudSubagentPanels = true;
    seedTwoRoots();
    await openSubagentsPanel();
    await selectSubagentRoot('chat-2');
    act(() => {
      container
        .querySelector<HTMLElement>(
          '[data-testid="subagents-list-select-cloud-delegate-b"]',
        )
        ?.click();
    });
    await settle();
    // Stop follows the scope's delegationStop, through the web core for B's
    // own chat.
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="subagents-inspector-stop"]')
        ?.click();
    });
    await settle();
    expect(keyedRequests('core.managedDelegation.stop')).toEqual([
      {
        params: {
          scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
          chatId: 'chat-2',
          delegationId: 'cloud-delegate-b',
        },
        key: 'string',
      },
    ]);
    // No worktree details, workflows or delegate messaging for a cloud scope.
    expect(shown('subagents-inspector-show-changes')).toBe(false);
    await openCloudSubagentChat('chat-2', 'b');
    expect(shown('subagent-chat-details-worktree')).toBe(false);
    expect(shown('subagent-chat-open-workflow')).toBe(false);
    expect(subagentIpc()).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("offers no Stop on a cloud subagent while its scope doesn't stop delegates (CAN-7133)", async () => {
    transcriptPageDetails = ['delegation'];
    mockCloudSubagentPanels = true;
    seedTwoRoots();
    await openSubagentsPanel();
    await selectSubagentRoot('chat-2');
    // The panel lists B's running delegate...
    expect(subagentRows()).toEqual(['cloud-delegate-b']);
    act(() => {
      container
        .querySelector<HTMLElement>(
          '[data-testid="subagents-list-select-cloud-delegate-b"]',
        )
        ?.click();
    });
    await settle();
    // ...and offers no Stop for it.
    expect(shown('subagents-inspector-stop')).toBe(false);
    // Nor are live states read: the card's first state shows.
    expect(delegationRequests('core.managedDelegation.list')).toEqual([]);
    expect(subagentIpc()).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("refuses a delegate that isn't on its root chat's cards, with no request (CAN-7133)", async () => {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    mockCloudSubagentPanels = true;
    seedTwoRoots();
    delegateTranscripts.set('cloud-delegate-b', [
      {
        id: 'child-b-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'B-CHILD-ROW-FROM-WEB-CORE' }],
        timestamp: Date.now(),
      },
    ]);
    await openSubagentsPanel();
    // B's delegate asked for under A's chat: not on A's cards.
    await openCloudSubagentChat('wt-1', 'b');
    expect(shown('subagent-chat-unavailable')).toBe(true);
    expect(container.textContent).not.toContain('B-CHILD-ROW-FROM-WEB-CORE');
    expect(delegationReads()).toEqual([]);
    // Nor does a Stop for it under A's chat reach anything.
    let result: { ok: boolean } = { ok: true };
    await act(async () => {
      result = await stopSubagent(CLOUD_SCOPE, cloudChat('wt-1'), {
        id: 'cloud-delegate-b',
        kind: 'managed',
      });
    });
    expect(result.ok).toBe(false);
    expect(delegationRequests('core.managedDelegation.stop')).toEqual([]);
    expect(subagentIpc()).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  /** A chat's recorded rows: a prompt, then the given delegate cards. */
  function chatWithCards(
    id: string,
    cards: readonly Record<string, unknown>[],
  ): unknown[] {
    const at = Date.now();
    return [
      {
        id: `${id}-u`,
        role: 'user',
        blocks: [{ type: 'text', text: 'Review it' }],
        timestamp: at,
      },
      { id: `${id}-a`, role: 'assistant', blocks: cards, timestamp: at },
    ];
  }

  /** One delegate's child row, as the web core pages it for any run. */
  function delegatePage(run: string): void {
    delegateTranscripts.set(`cloud-delegate-${run}`, [
      {
        id: `child-${run}-1`,
        role: 'assistant',
        blocks: [{ type: 'text', text: `${run.toUpperCase()}-CHILD-ROW` }],
        timestamp: Date.now(),
      },
    ]);
  }

  /** Each delegate page read, once, as its chat, delegate and run. */
  const pageReads = (): string[] =>
    [
      ...new Set(
        delegationReads().map((params) => {
          const target: unknown = params.target;
          const field = (name: string): string =>
            typeof target === 'object' && target !== null
              ? String(Reflect.get(target, name))
              : '';
          return `${field('chatId')}/${field('delegationId')}/${field('runGeneration')}`;
        }),
      ),
    ].sort();

  /** The recorded card of `delegationId` in local chat `chatId`. */
  function recordedCard(
    chatId: string,
    delegationId: string,
  ): Record<string, unknown> | undefined {
    const tab = useChatStore
      .getState()
      .worktreeChats[
        CLOUD_SCOPE_KEY
      ]?.tabs.find((entry) => entry.id === cloudChat(chatId));
    for (const message of tab?.messages ?? [])
      for (const block of message.blocks)
        if (
          block.type === 'delegated_agent_call' &&
          block.delegationId === delegationId
        )
          return {
            agentBlockId: block.agentBlockId,
            runGeneration: block.runGeneration,
            status: block.status,
          };
    return undefined;
  }

  /** One run's child rows, as the web core pages that run alone. */
  function delegateRunPage(
    run: string,
    runGeneration: number,
    texts: readonly string[],
  ): void {
    delegateTranscripts.set(
      `cloud-delegate-${run}#${String(runGeneration)}`,
      texts.map((text, index) => ({
        id: `child-${run}-${String(runGeneration)}-${String(index)}`,
        role: 'assistant',
        blocks: [{ type: 'text', text }],
        timestamp: Date.now() + index,
      })),
    );
  }

  /** The subagent chat's text for one run. */
  const runText = (runGeneration: number): string =>
    container.querySelector(
      `[data-testid="cloud-subagent-run"][data-run-generation="${String(runGeneration)}"]`,
    )?.textContent ?? '';

  const occurrences = (text: string, needle: string): number =>
    text.split(needle).length - 1;

  /** Waits out one live delegation poll. */
  async function onePoll(): Promise<void> {
    await act(
      () =>
        new Promise((resolve) =>
          setTimeout(resolve, LIVE_DELEGATION_POLL_MS + 500),
        ),
    );
    await settle();
  }

  it("keeps reading a cloud root's settled delegates in the Subagents panel while the root's turn runs, and stops once it ends (CAN-7133)", async () => {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    mockCloudSubagentPanels = true;
    // The second chat runs a turn; its delegate b has settled. The task's
    // chat is the one opened, so only the panel watches the second chat.
    secondChatTurn = 'notes-turn';
    onCaseEnd(() => {
      secondChatTurn = null;
    });
    transcripts['wt-1'] = chatWithCards('brief', [runningDelegateCard('a')]);
    transcripts['chat-2'] = chatWithCards('notes', [
      { ...runningDelegateCard('b'), status: 'completed' },
    ]);
    // No live delegate but b: the fake web core lists every chat's open
    // delegates for each chat, and a live one keeps a chat's reads going.
    delegationSnapshots.set('cloud-delegate-b', {
      ...liveDelegateSnapshot('b'),
      status: 'completed',
      phase: 'idle',
    });
    await openSubagentsPanel();
    // The store keeps tabs across cases: an earlier send can leave the
    // second chat a pending turn, which reads as dispatching.
    act(() => {
      useChatStore.setState((state) => {
        const chats = state.worktreeChats[CLOUD_SCOPE_KEY];
        if (chats === undefined) return {};
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [CLOUD_SCOPE_KEY]: {
              ...chats,
              tabs: chats.tabs.map((tab) => {
                if (tab.id !== cloudChat('chat-2')) return tab;
                const next = { ...tab };
                delete next.pendingTurn;
                return next;
              }),
            },
          },
        };
      });
    });
    await settle();
    await selectSubagentRoot('chat-2');
    expect(shown('subagents-panel')).toBe(true);
    const statusOfB = (): string | undefined =>
      getSubagentTreeSnapshot(CLOUD_SCOPE, cloudChat('chat-2')).tree?.nodes.get(
        'cloud-delegate-b',
      )?.status;
    expect(statusOfB()).toBe('completed');

    // The root's agent starts b again, with no new message in the root.
    delegationSnapshots.set('cloud-delegate-b', liveDelegateSnapshot('b'));
    await onePoll();
    expect(statusOfB()).toBe('running');
    act(() => {
      container
        .querySelector<HTMLElement>(
          '[data-testid="subagents-list-select-cloud-delegate-b"]',
        )
        ?.click();
    });
    await settle();
    expect(shown('subagents-inspector-stop')).toBe(true);

    // b settles; then the turn ends, and the panel lets the chat go.
    delegationSnapshots.set('cloud-delegate-b', {
      ...liveDelegateSnapshot('b'),
      status: 'completed',
      phase: 'idle',
    });
    await onePoll();
    expect(statusOfB()).toBe('completed');
    secondChatTurn = null;
    snapshotRevision += 1;
    act(() => {
      refreshChatScopeRevisioned(CLOUD_SCOPE.projectId, CLOUD_SCOPE.worktreeId);
    });
    await settle();
    // The second chat's turn reads ended, as its chat view would read it.
    const secondTab = useChatStore
      .getState()
      .worktreeChats[
        CLOUD_SCOPE_KEY
      ]?.tabs.find((tab) => tab.id === cloudChat('chat-2'));
    expect([secondTab?.status, secondTab?.pendingTurn]).toEqual([
      'idle',
      undefined,
    ]);
    const listsForRoot = (): number =>
      delegationRequests('core.managedDelegation.list').filter(
        (params) => params.chatId === 'chat-2',
      ).length;
    // At most the poll it had already scheduled reads once more; then none.
    const afterTurn = listsForRoot();
    await onePoll();
    const settledReads = listsForRoot();
    expect(settledReads - afterTurn).toBeLessThanOrEqual(1);
    await onePoll();
    await onePoll();
    expect(listsForRoot()).toBe(settledReads);
    expect(subagentIpc()).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
    // Five live polls run on real time.
  }, 60_000);

  it("shows a cloud delegate's final answer once in its subagent chat when its pages repeat it (CAN-7133)", async () => {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    mockCloudSubagentPanels = true;
    transcripts['wt-1'] = chatWithCards('brief', [runningDelegateCard('a')]);
    transcripts['chat-2'] = chatWithCards('notes', [
      {
        ...runningDelegateCard('b'),
        status: 'completed',
        finalText: 'B-FINAL-ANSWER',
      },
    ]);
    delegateRunPage('b', 1, ['B-CHILD-ROW', 'B-FINAL-ANSWER']);
    await openSubagentsPanel();
    await openCloudSubagentChat('chat-2', 'b');
    expect(runText(1)).toContain('B-CHILD-ROW');
    expect(occurrences(runText(1), 'B-FINAL-ANSWER')).toBe(1);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("shows a newer cloud run's own final text once, though it repeats the recorded run's answer (CAN-7133)", async () => {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    mockCloudSubagentPanels = true;
    // Both runs end the same way; run 2 has no card, so its view is drawn
    // from run 1's.
    transcripts['wt-1'] = chatWithCards('brief', [runningDelegateCard('a')]);
    transcripts['chat-2'] = chatWithCards('notes', [
      { ...runningDelegateCard('b'), status: 'completed', finalText: 'Done.' },
    ]);
    delegationSnapshots.set('cloud-delegate-b', {
      ...liveDelegateSnapshot('b'),
      runGeneration: 2,
    });
    delegateRunPage('b', 1, ['B-RUN-1-WORK', 'Done.']);
    delegateRunPage('b', 2, ['B-RUN-2-WORK', 'Done.']);
    await openSubagentsPanel();
    await openCloudSubagentChat('chat-2', 'b');
    // Run 2's own pages aren't filtered by run 1's answer: nothing drops.
    expect(occurrences(runText(2), 'B-RUN-2-WORK')).toBe(1);
    expect(occurrences(runText(2), 'Done.')).toBe(1);
    expect(occurrences(runText(1), 'Done.')).toBe(1);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("keeps a cloud delegate's earlier runs when the web core reports a newer one, and reads each run's pages only under its own root (CAN-7133)", async () => {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    mockCloudSubagentPanels = true;
    // B's chat recorded run 1, settled; the web core says run 2 now runs.
    // A's chat has a delegate of its own and no card for B's.
    transcripts['wt-1'] = chatWithCards('brief', [runningDelegateCard('a')]);
    transcripts['chat-2'] = chatWithCards('notes', [
      {
        ...runningDelegateCard('b'),
        status: 'completed',
        finalText: 'B-RUN-1-ANSWER',
      },
    ]);
    delegationSnapshots.set('cloud-delegate-a', liveDelegateSnapshot('a'));
    delegationSnapshots.set('cloud-delegate-b', {
      ...liveDelegateSnapshot('b'),
      runGeneration: 2,
    });
    // Run 1's pages end in its answer; run 2's hold only its own work.
    delegateRunPage('b', 1, ['B-CHILD-ROW', 'B-RUN-1-ANSWER']);
    delegateRunPage('b', 2, ['B-RUN-2-WORK']);
    await openSubagentsPanel();
    await selectSubagentRoot('chat-2');

    const nodeB = getSubagentTreeSnapshot(
      CLOUD_SCOPE,
      cloudChat('chat-2'),
    ).tree?.nodes.get('cloud-delegate-b');
    // Both runs, the live one beside the recorded one under its own id.
    expect(nodeB?.runs).toEqual([
      { runGeneration: 1, agentBlockId: 'delegated-agent-cloud-delegate-b' },
      {
        runGeneration: 2,
        agentBlockId: 'delegated-agent-cloud-delegate-b-run-2',
      },
    ]);
    expect(nodeB?.status).toBe('running');
    // The recorded run-1 card keeps its own id and settled state.
    expect(recordedCard('chat-2', 'cloud-delegate-b')).toEqual({
      agentBlockId: 'delegated-agent-cloud-delegate-b',
      runGeneration: 1,
      status: 'completed',
    });

    // The other root has no card for B's delegate: its run 2 adds nothing
    // there, and nothing is read for it under that root.
    await selectSubagentRoot('wt-1');
    expect(
      getSubagentTreeSnapshot(CLOUD_SCOPE, cloudChat('wt-1')).tree?.nodes.has(
        'cloud-delegate-b',
      ),
    ).toBe(false);
    await openCloudSubagentChat('wt-1', 'b');
    expect(shown('subagent-chat-unavailable')).toBe(true);
    expect(pageReads()).toEqual([]);

    // Under its own root, each run's pages are read by its own generation.
    await openCloudSubagentChat('chat-2', 'b');
    expect(
      container.querySelector('[data-testid="subagent-chat-panel"]')
        ?.textContent,
    ).toContain('B-CHILD-ROW');
    expect(pageReads()).toEqual([
      'chat-2/cloud-delegate-b/1',
      'chat-2/cloud-delegate-b/2',
    ]);
    // Run 1's answer shows once, in run 1; run 2's view, drawn from run 1's
    // card, never shows it.
    expect(occurrences(runText(1), 'B-RUN-1-ANSWER')).toBe(1);
    expect(occurrences(runText(2), 'B-RUN-1-ANSWER')).toBe(0);
    expect(occurrences(runText(2), 'B-RUN-2-WORK')).toBe(1);
    expect(subagentIpc()).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  /** The root picker's line for one root chat, as the panel shows it. */
  async function rootOptionText(chatId: string): Promise<string> {
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="subagents-root-picker"]')
        ?.click();
    });
    await settle();
    const text =
      document.querySelector(
        `[data-testid="subagents-root-option-${cloudChat(chatId)}"]`,
      )?.textContent ?? '';
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await settle();
    return text;
  }

  /** B's chat with one settled run-2 card for c, and c's live run. */
  async function openRootWithLiveRun(liveRun: number): Promise<void> {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    mockCloudSubagentPanels = true;
    transcripts['wt-1'] = chatWithCards('brief', [runningDelegateCard('a')]);
    transcripts['chat-2'] = chatWithCards('notes', [
      {
        ...runningDelegateCard('c'),
        agentBlockId: 'delegated-agent-cloud-delegate-c-run-2',
        runGeneration: 2,
        status: 'completed',
      },
    ]);
    delegationSnapshots.set('cloud-delegate-c', {
      ...liveDelegateSnapshot('c'),
      runGeneration: liveRun,
    });
    await openSubagentsPanel();
    // The panel reads the selected root's live state.
    await selectSubagentRoot('chat-2');
  }

  it("doesn't count a cloud root live by a live run older than its delegate's latest card (CAN-7133)", async () => {
    await openRootWithLiveRun(1);
    expect(
      getSubagentTreeSnapshot(CLOUD_SCOPE, cloudChat('chat-2')).tree?.nodes.get(
        'cloud-delegate-c',
      )?.status,
    ).toBe('completed');
    // The root list agrees with the tree: nothing active.
    const text = await rootOptionText('chat-2');
    expect(text).toContain('1 subagent');
    expect(text).not.toContain('active');
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("counts a cloud root live by a live run at its delegate's latest card (CAN-7133)", async () => {
    await openRootWithLiveRun(2);
    expect(
      getSubagentTreeSnapshot(CLOUD_SCOPE, cloudChat('chat-2')).tree?.nodes.get(
        'cloud-delegate-c',
      )?.status,
    ).toBe('running');
    expect(await rootOptionText('chat-2')).toContain('1 active');
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it('keeps a managed-only cloud root in the Subagents picker after its transcript is evicted, and reloads it when selected (CAN-7133)', async () => {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    mockCloudSubagentPanels = true;
    transcripts['wt-1'] = chatWithCards('brief', [runningDelegateCard('a')]);
    // The second chat's only subagent is a managed delegate.
    transcripts['chat-2'] = chatWithCards('notes', [
      { ...runningDelegateCard('b'), status: 'completed' },
    ]);
    await openSubagentsPanel();
    await selectSubagentRoot('wt-1');
    expect(await rootOptionText('chat-2')).toContain('1 subagent');
    // The residency sweep evicts the idle second chat's transcript.
    act(() => {
      useChatStore.setState((state) => {
        const chats = state.worktreeChats[CLOUD_SCOPE_KEY];
        if (chats === undefined) return {};
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [CLOUD_SCOPE_KEY]: {
              ...chats,
              tabs: chats.tabs.map((tab) =>
                tab.id === cloudChat('chat-2')
                  ? evictChatTabTranscript(tab)
                  : tab,
              ),
            },
          },
        };
      });
    });
    await settle();
    const evicted = useChatStore
      .getState()
      .worktreeChats[
        CLOUD_SCOPE_KEY
      ]?.tabs.find((tab) => tab.id === cloudChat('chat-2'));
    expect([evicted?.transcriptLoaded, evicted?.messages.length]).toEqual([
      false,
      0,
    ]);
    // The root stays listed by its own card.
    expect(await rootOptionText('chat-2')).toContain('1 subagent');
    // The evicted summary holds only delegation ids and run numbers: no
    // message text or card content.
    expect(evicted?.evictedSubagentRoot?.ownDelegationRuns).toEqual({
      'cloud-delegate-b': 1,
    });
    const kept = JSON.stringify(evicted?.evictedSubagentRoot);
    for (const text of ['Review b', 'Review it', 'cloud-spawn-b'])
      expect(kept).not.toContain(text);

    // Selecting it reloads its transcript, and the delegate is back.
    await selectSubagentRoot('chat-2');
    await settle();
    const reloaded = useChatStore
      .getState()
      .worktreeChats[
        CLOUD_SCOPE_KEY
      ]?.tabs.find((tab) => tab.id === cloudChat('chat-2'));
    expect(reloaded?.transcriptLoaded).not.toBe(false);
    expect(subagentRows()).toEqual(['cloud-delegate-b']);
    // The kept runs and the reloaded card agree: still one, not two.
    const after = await rootOptionText('chat-2');
    expect(after).toContain('1 subagent');
    expect(after).not.toContain('2 subagents');
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it("ignores a cloud delegate's live state from a run older than its latest card (CAN-7133)", async () => {
    transcriptPageDetails = ['delegation'];
    mockDelegationStop = true;
    mockCloudSubagentPanels = true;
    // C's chat recorded run 2, settled; the web core still reports run 1.
    transcripts['wt-1'] = chatWithCards('brief', [runningDelegateCard('a')]);
    transcripts['chat-2'] = chatWithCards('notes', [
      {
        ...runningDelegateCard('c'),
        agentBlockId: 'delegated-agent-cloud-delegate-c-run-2',
        runGeneration: 2,
        status: 'completed',
      },
    ]);
    delegationSnapshots.set('cloud-delegate-c', liveDelegateSnapshot('c'));
    delegatePage('c');
    await openSubagentsPanel();
    await selectSubagentRoot('chat-2');

    const nodeC = getSubagentTreeSnapshot(
      CLOUD_SCOPE,
      cloudChat('chat-2'),
    ).tree?.nodes.get('cloud-delegate-c');
    expect(nodeC?.runs).toEqual([
      {
        runGeneration: 2,
        agentBlockId: 'delegated-agent-cloud-delegate-c-run-2',
      },
    ]);
    expect(nodeC?.status).toBe('completed');
    await openCloudSubagentChat('chat-2', 'c');
    expect(pageReads()).toEqual(['chat-2/cloud-delegate-c/2']);
    expect(subagentIpc()).toEqual([]);
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  /** Reads the task's transcript again: the store keeps tabs across cases. */
  async function rereadTranscript(): Promise<void> {
    snapshotRevision += 1;
    act(() => {
      refreshChatScopeRevisioned('web-core:ws-1', 'web-core:wt-1');
    });
    await settle();
  }

  const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 3, 4]);

  function webPrompt(
    id: string,
    attachments: readonly { attachmentId: string; filename: string }[],
  ): Record<string, unknown> {
    return {
      id,
      role: 'user',
      blocks: [{ type: 'text', text: `prompt ${id}` }],
      timestamp: Date.now(),
      attachments: attachments.map((attachment) => ({
        ...attachment,
        mediaType: 'image/png',
        size: PNG.byteLength,
      })),
    };
  }

  const fileTiles = (): string[] =>
    Array.from(
      container.querySelectorAll('[data-testid="message-file-attachment"]'),
    ).map((tile) => tile.textContent ?? '');

  it('keeps an SVG and a picture whose bytes are not its type as file tiles, and reads a failed one once (CAN-6824)', async () => {
    attachmentBytes.set('attachment:att-svg', {
      sizeBytes: 12,
      head: new TextEncoder().encode('<svg></svg>\n'),
    });
    // Named a PNG, but its bytes are text.
    attachmentBytes.set('attachment:att-not-png', {
      sizeBytes: 5,
      head: new TextEncoder().encode('hello'),
    });
    startedPrompts.push(
      webPrompt('svg-u', [
        { attachmentId: 'att-svg', filename: 'logo.svg' },
        { attachmentId: 'att-not-png', filename: 'fake.png' },
      ]),
    );
    await openTaskChat();
    await rereadTranscript();
    expect(
      container.querySelectorAll(
        '[data-testid="message-image-attachments"] img',
      ),
    ).toHaveLength(0);
    expect(fileTiles()).toEqual([
      expect.stringContaining('logo.svg'),
      expect.stringContaining('fake.png'),
    ]);
    // An SVG is never read; the mismatched one is read once, and a re-render
    // keeps its file tile without reading it again.
    await rereadTranscript();
    expect(artifactReads.map((read) => read.artifactId)).toEqual([
      'attachment:att-not-png',
    ]);
  });

  it('reads a picture two messages share once (CAN-6824)', async () => {
    attachmentBytes.set('attachment:att-shared', {
      sizeBytes: PNG.byteLength,
      head: PNG,
    });
    const shared = { attachmentId: 'att-shared', filename: 'shared.png' };
    startedPrompts.push(
      webPrompt('shared-1-u', [shared]),
      webPrompt('shared-2-u', [shared]),
    );
    await openTaskChat();
    await rereadTranscript();
    expect(
      Array.from(
        container.querySelectorAll<HTMLImageElement>(
          '[data-testid="message-image-attachments"] img',
        ),
      ).map((image) => image.alt),
    ).toEqual(['shared.png', 'shared.png']);
    expect(artifactReads.map((read) => read.artifactId)).toEqual([
      'attachment:att-shared',
    ]);
  });

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
    // A failure or timeout below leaves nothing held for the next case.
    onCaseEnd(async () => {
      await chat.settleTimers();
      await chat.endTurn();
    });
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
    // A failure or timeout below leaves nothing held for the next case.
    onCaseEnd(async () => {
      cancelGate = null;
      release();
      await act(() => Promise.allSettled([pressed, retried]));
      await chat.flush();
      jest.useRealTimers();
      await settle();
      await chat.endTurn();
    });
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
    // A failure or timeout below leaves nothing held for the next case.
    onCaseEnd(async () => {
      holdCancels = false;
      for (const answer of heldCancels.splice(0)) answer(acceptedCancel);
      await act(() => Promise.allSettled([first, retry]));
      await chat.settleTimers();
      await chat.endTurn();
    });
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
    // A failure or timeout below leaves nothing held for the next case.
    onCaseEnd(async () => {
      holdCancels = false;
      for (const answer of heldCancels.splice(0)) answer(acceptedCancel);
      await act(() => Promise.allSettled([pressed]));
      await chat.settleTimers();
      await chat.endTurn();
    });
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
  });

  it('a message sent while a cloud turn runs waits in the queue, not the transcript, as a reload shows it (CAN-6689)', async () => {
    const tabOf = ():
      | {
          readonly messages: readonly PersistedChatMessage[];
          readonly queuedMessages: readonly { readonly text: string }[];
          readonly pendingTurn?: unknown;
          readonly transcriptLoaded?: boolean;
          readonly turnEnds?: Readonly<Record<string, unknown>>;
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
    const queuedTexts = (): string[] =>
      (tabOf()?.queuedMessages ?? []).map((row) => row.text);
    const textsAre = (
      texts: readonly string[],
      expected: readonly string[],
    ): boolean =>
      texts.length === expected.length &&
      texts.every((text, index) => text === expected[index]);
    const sixFollowsFive = (): boolean => {
      const texts = userTexts();
      return (
        texts.includes('five') && texts.indexOf('six') > texts.indexOf('five')
      );
    };
    // CAN-7223: the shared settle and refresh run a fixed 60 ticks each,
    // about 1,100 act() calls for this case, more than a loaded runner fits
    // in the case's timeout. Each step here settles until the state its
    // checks read is there and the fake core has had no new request for a
    // few ticks, so whatever the step started has been answered and applied.
    // A check that something did not happen runs only after that.
    const settleQuietly = async (ready: () => boolean): Promise<void> => {
      let requests = coreRequestLog.length;
      let quietTicks = 0;
      await settleUntil(() => {
        if (coreRequestLog.length !== requests) {
          requests = coreRequestLog.length;
          quietTicks = 0;
          return false;
        }
        quietTicks += 1;
        return quietTicks > 5 && ready();
      }, 5_000);
    };
    // A reload of the scope, as `chat.refresh()` makes, read until applied.
    const reloadUntil = async (ready: () => boolean): Promise<void> => {
      const from = coreRequestLog.length;
      snapshotRevision += 1;
      act(() => {
        refreshChatScopeRevisioned(TASK_CHAT.projectId, TASK_CHAT.worktreeId);
      });
      await settleQuietly(
        () =>
          coreRequestLog
            .slice(from)
            .some((entry) => entry.method === 'core.chat.snapshot.get') &&
          ready(),
      );
    };
    const chat = await openTaskChat({
      followsEvents: true,
      settleWith: (step) =>
        settleQuietly(() =>
          step === 'opened'
            ? useChatStore.getState().worktreeChats[
                `${TASK_CHAT.projectId}/${TASK_CHAT.worktreeId}`
              ] !== undefined
            : tabOf() !== undefined && tabOf()?.transcriptLoaded !== false,
        ),
    });
    // The store keeps the task's tabs across cases: read this case's prompts.
    sendsKeepRunning = true;
    sendsNameMessage = true;
    let release = (): void => undefined;
    // A failure or timeout below leaves nothing held for the next case.
    onCaseEnd(async () => {
      release();
      sendGate = null;
      queuedSends.length = 0;
      startingSend = null;
      taskRuntime = null;
      await chat.endTurn();
    });
    await act(() =>
      useChatStore.getState().sendMessage('five', undefined, TASK_CHAT),
    );
    await settleQuietly(
      () => userTexts().includes('five') && tabOf()?.pendingTurn !== undefined,
    );
    // Core holds the first turn queued while it starts, and lists it in
    // the queue, as staging reads it seconds in (13 Nov 2026): the desktop
    // shows the chat idle. The prompt starting now stays, with its timer.
    startingSend = { text: 'five', turnId: 'turn-1', messageId: 'turn-1-u' };
    taskRuntime = { status: 'queued', queuedMessageIds: ['turn-1-u'] };
    await reloadUntil(() => textsAre(queuedTexts(), ['five']));
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
    await settleQuietly(() => queuedSends.some((each) => each.text === 'six'));
    taskRuntime = {
      status: 'queued',
      queuedMessageIds: ['turn-1-u', 'turn-2-u'],
    };
    await reloadUntil(() => textsAre(queuedTexts(), ['five', 'six']));
    release();
    sendGate = null;
    await act(() => sending);
    // The receipt has landed: its send resolved, and nothing it started is
    // still unanswered.
    await settleQuietly(() => true);
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
    await reloadUntil(() => textsAre(queuedTexts(), ['six']));
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
    await settleQuietly(
      () =>
        cancelledPrompts.some((each) => each.id === 'turn-2-u') &&
        queuedTexts().length === 0,
    );
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
    await settleQuietly(sixFollowsFive);
    await reloadUntil(() => queuedTexts().length === 0 && sixFollowsFive());
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
        : persistedMessageToRemoteControlMessage({
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
    onCaseEnd(() => {
      act(() => {
        listRoot.unmount();
      });
      list.remove();
    });
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
      const bubbleOf = (text: string): string | undefined =>
        [
          ...list.querySelectorAll(
            '[data-testid="remote-control-chat-message-content"]',
          ),
        ]
          .map((bubble) => bubble.textContent ?? '')
          .find((content) => content.startsWith(text));
      await settleQuietly(
        () =>
          bubbleOf('six') === 'sixCancelled' && bubbleOf('five') !== undefined,
      );
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
      await settleQuietly(
        () => fiveId !== undefined && tabOf()?.turnEnds?.[fiveId] !== undefined,
      );
      expect(bubbleOf('five')).toBe('five');
      expect(bubbleOf('six')).toBe('sixCancelled');
    } finally {
      act(() => {
        listRoot.unmount();
      });
      list.remove();
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
    // A failure or timeout below leaves nothing held for the next case.
    onCaseEnd(async () => {
      await chat.settleTimers();
      await chat.endTurn();
    });
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
  });

  it('a Stop on a cloud turn that is still starting reads plain Stopping…, with no wake reason, before and after a runtime runs the turn (CAN-6759)', async () => {
    const chat = await openTaskChat();
    // A timeout below still ends the turn for the next case.
    onCaseEnd(() => chat.endTurn());
    const stopControl = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-stop-generation"]',
      );
    // Core ends a starting turn's stop at once, and the web core has not
    // reported the sandbox asleep or waking here (CAN-6766), so nothing on
    // screen says the stop waits for the project to wake.
    const shownReason = (): string[] =>
      Array.from(container.querySelectorAll('*'))
        .filter(
          (element) =>
            element.children.length === 0 &&
            element.textContent?.includes('waiting for the project to wake') ===
              true,
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
      // The cancel is accepted, and the turn is still starting: Stop reads
      // plain Stopping…, busy, until Core ends the turn.
      expect(chat.cancels()).toEqual(['turn-1']);
      expect(chat.shown()).toBe('stopping');
      expect(stopControl()?.getAttribute('aria-label')).toBe('Stopping…');
      expect(stopControl()?.getAttribute('aria-busy')).toBe('true');
      expect(stopControl()?.disabled).toBe(true);
      expect(shownReason()).toEqual([]);
      expect(
        container.querySelector('[data-testid="chat-composer-stop-status"]'),
      ).toBeNull();
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

  for (const [_case, eventsRevision, reply] of [
    ['advertises events below revision 3', 2, 'described'],
    ['cannot be described', 3, 'failed'],
  ] as const)
    it(`reads plain Stopping… on a starting cloud turn when the web core ${_case}, though its snapshot reports the sandbox asleep: nothing would keep that state current, so it stays unknown (CAN-6841)`, async () => {
      advertisedEventsRevision = eventsRevision;
      describeReply = reply;
      snapshotSandbox = 'asleep';
      await describeConnectionAgain();
      const chat = await openTaskChat();
      const stopControl = (): HTMLButtonElement | null =>
        container.querySelector<HTMLButtonElement>(
          '[data-testid="chat-stop-generation"]',
        );
      await act(() =>
        useChatStore
          .getState()
          .sendMessage('start slowly', undefined, TASK_CHAT),
      );
      await settle();
      onCaseEnd(async () => {
        await chat.endTurn();
        useCloudSandboxStateStore.getState().clear();
      });
      try {
        await chat.stop();
        await settle();
        // The sandbox reads unknown, never asleep.
        expect(
          useCloudSandboxStateStore.getState().byChat[liveReplyKey(TASK_CHAT)],
        ).toBeUndefined();
        expect(chat.cancels()).toEqual(['turn-1']);
        expect(stopControl()?.getAttribute('aria-label')).toBe('Stopping…');
        expect(
          container.querySelector('[data-testid="chat-composer-stop-status"]'),
        ).toBeNull();
      } finally {
        await chat.endTurn();
        useCloudSandboxStateStore.getState().clear();
      }
    });

  it('a Stop on a starting cloud turn says it waits for the project to wake only while the web core reports the sandbox asleep or waking, and reads plain Stopping… once it reports ready (CAN-6766)', async () => {
    const chat = await openTaskChat();
    // The chat's sandbox as the web core backend publishes it from the
    // snapshot and sandbox.changed (that publishing is pinned by the desktop
    // store's equivalence golden).
    const reportSandbox = (state: 'asleep' | 'waking' | 'ready'): void => {
      act(() => {
        useCloudSandboxStateStore
          .getState()
          .set(liveReplyKey(TASK_CHAT), state);
      });
    };
    reportSandbox('asleep');
    const stopControl = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-stop-generation"]',
      );
    const stopStatus = (): string | null =>
      container.querySelector('[data-testid="chat-composer-stop-status"]')
        ?.textContent ?? null;
    await act(() =>
      useChatStore.getState().sendMessage('start slowly', undefined, TASK_CHAT),
    );
    await settle();
    // A timeout below still ends the turn and forgets the sandbox's state.
    onCaseEnd(async () => {
      await chat.endTurn();
      useCloudSandboxStateStore.getState().clear();
    });
    try {
      await chat.stop();
      await settle();
      // Asleep: the stop waits for the project to wake, and says so in the
      // button and in the status row under it.
      expect(chat.cancels()).toEqual(['turn-1']);
      expect(stopControl()?.getAttribute('aria-label')).toBe(
        'Stopping… waiting for the project to wake',
      );
      expect(stopStatus()).toBe('Stopping… waiting for the project to wake');
      // Waking reads the same.
      reportSandbox('waking');
      await settle();
      expect(stopStatus()).toBe('Stopping… waiting for the project to wake');
      // Ready: nothing is waited for, so Stop reads plain Stopping….
      reportSandbox('ready');
      await settle();
      expect(stopControl()?.getAttribute('aria-label')).toBe('Stopping…');
      expect(stopControl()?.disabled).toBe(true);
      expect(stopStatus()).toBeNull();
      expect(chat.cancels()).toEqual(['turn-1']);
    } finally {
      await chat.endTurn();
      useCloudSandboxStateStore.getState().clear();
    }
    expect(stopControl()).toBeNull();
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
    // A failure or timeout below leaves nothing held for the next case.
    onCaseEnd(async () => {
      pageServed();
      pageGate = null;
      await chat.endTurn();
    });
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
    /** Stop as the composer shows it once pressed: Stopping…, busy, and not pressable. */
    const stopping = (): boolean => {
      const stop = stopControl();
      return (
        stop !== null &&
        stop.getAttribute('aria-label') === 'Stopping…' &&
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
    // A failure or timeout below leaves nothing held for the next case.
    onCaseEnd(async () => {
      release();
      sendGate = null;
      await act(() => sending);
      snapshotServed();
      snapshotGate = null;
      await chat.endTurn();
    });
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
    await settleUntil(() => chat.cancels().length > 0);
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
    await settleUntil(() => stopControl() === null);
    // The composer repaints from the store a moment later.
    for (let i = 0; i < 50 && stopControl() !== null; i += 1)
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(stopControl()).toBeNull();
    expect(sendControl()).not.toBeNull();
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
    // A failure or timeout below leaves nothing held for the next case.
    onCaseEnd(async () => {
      release();
      sendGate = null;
      await chat.endTurn();
    });
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
  });

  it('sends follow-ups typed while a cloud turn runs in the order they were pressed, each after the one before it posted (CAN-6828)', async () => {
    const chat = await openTaskChat();
    sendsKeepRunning = true;
    await act(() =>
      useChatStore.getState().sendMessage('count slowly', undefined, TASK_CHAT),
    );
    await settle();
    const sends = (): unknown[] =>
      coreRequestLog
        .filter((entry) => entry.method === 'core.chat.message.send')
        .map((entry) => entry.params.text);
    // The web core holds each send's reply.
    let release = (): void => undefined;
    sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A failure or timeout below leaves nothing held for the next case.
    onCaseEnd(async () => {
      release();
      sendGate = null;
      await chat.endTurn();
    });
    act(() => {
      void useChatStore
        .getState()
        .sendMessage('first follow-up', undefined, TASK_CHAT);
    });
    await settle();
    act(() => {
      void useChatStore
        .getState()
        .sendMessage('second follow-up', undefined, TASK_CHAT);
    });
    await settle();
    // Both wait behind the running turn; the second goes only once the
    // first has posted.
    expect(sends()).toEqual(['count slowly', 'first follow-up']);
    sendGate = null;
    release();
    await settle();
    expect(sends()).toEqual([
      'count slowly',
      'first follow-up',
      'second follow-up',
    ]);
  });

  it('never parks a cloud send in the renderer queue: it goes to the web core under its place, in pressed order (CAN-6828)', async () => {
    await openTaskChat();
    const sends = (): unknown[] =>
      coreRequestLog
        .filter((entry) => entry.method === 'core.chat.message.send')
        .map((entry) => entry.params.text);
    // A tab state that parks a local chat's sends in the renderer's own
    // queue; the web core never produces it for a cloud chat.
    act(() => {
      useChatStore.setState((state) => {
        const scope = state.worktreeChats['web-core:ws-1/web-core:wt-1'];
        if (scope === undefined) return state;
        return {
          worktreeChats: {
            ...state.worktreeChats,
            'web-core:ws-1/web-core:wt-1': {
              ...scope,
              tabs: scope.tabs.map((tab) =>
                tab.id === TASK_CHAT.chatId
                  ? { ...tab, queuedHookPlaceholder: true, queuedMessages: [] }
                  : tab,
              ),
            },
          },
        };
      });
    });
    // The web core holds the first send's reply while the second is pressed.
    let release = (): void => undefined;
    sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    onCaseEnd(async () => {
      sendGate = null;
      release();
      await act(() => Promise.allSettled([first, second]));
    });
    act(() => {
      first = useChatStore
        .getState()
        .sendMessage('first', undefined, TASK_CHAT);
    });
    await settle();
    act(() => {
      second = useChatStore
        .getState()
        .sendMessage('second', undefined, TASK_CHAT);
    });
    await settle();
    expect(
      useChatStore
        .getState()
        .worktreeChats[
          'web-core:ws-1/web-core:wt-1'
        ]?.tabs.find((tab) => tab.id === TASK_CHAT.chatId)?.queuedMessages,
    ).toEqual([]);
    // The second waits for the first's place.
    expect(sends()).toEqual(['first']);
    sendGate = null;
    release();
    await act(() => Promise.allSettled([first, second]));
    await settle();
    expect(sends()).toEqual(['first', 'second']);
  });

  it('stops the send pressed first, not a later one that reached the web core backend before it (CAN-6828)', async () => {
    const chat = await openTaskChat();
    sendsKeepRunning = true;
    // The web core holds each send's reply, so Stop lands before either
    // receipt names a turn.
    let release = (): void => undefined;
    sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    onCaseEnd(async () => {
      sendGate = null;
      release();
      await act(() => Promise.allSettled([first, second]));
      await chat.endTurn();
    });
    // The second takes the queued path straight to the backend, while the
    // first still prepares on the idle path.
    act(() => {
      first = useChatStore
        .getState()
        .sendMessage('first', undefined, TASK_CHAT);
      second = useChatStore
        .getState()
        .sendMessage('second', undefined, TASK_CHAT);
    });
    await settle();
    act(() => {
      void useChatStore.getState().cancelSession(TASK_CHAT);
    });
    await settle();
    sendGate = null;
    release();
    await act(() => Promise.allSettled([first, second]));
    await settle();
    expect(
      coreRequestLog
        .filter((entry) => entry.method === 'core.chat.message.send')
        .map((entry) => entry.params.text),
    ).toEqual(['first', 'second']);
    // The turn the first send started, not the one queued behind it.
    expect(chat.cancels()).toEqual(['turn-1']);
  });

  it('holds later sends to a cloud chat while an earlier send whose outcome is unknown checks its receipt (CAN-6828)', async () => {
    const chat = await openTaskChat();
    const sends = (): unknown[] =>
      coreRequestLog
        .filter((entry) => entry.method === 'core.chat.message.send')
        .map((entry) => entry.params.text);
    // The first send's outcome is unknown, and the web core holds the
    // receipt read that would settle it.
    unknownOutcomeSendText = 'first';
    let release = (): void => undefined;
    receiptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    // A failure or timeout below leaves nothing held for the next case.
    onCaseEnd(async () => {
      receiptGate = null;
      release();
      await act(() => Promise.allSettled([first, second]));
      await chat.endTurn();
    });
    act(() => {
      first = useChatStore
        .getState()
        .sendMessage('first', undefined, TASK_CHAT);
    });
    await settle();
    act(() => {
      second = useChatStore
        .getState()
        .sendMessage('second', undefined, TASK_CHAT);
    });
    await settle();
    // The second waits for the first's receipt: the first may have landed.
    expect(sends()).toEqual(['first']);
    receiptGate = null;
    release();
    await act(() => Promise.allSettled([first, second]));
    await settle();
    expect(sends()).toEqual(['first', 'second']);
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
        .querySelector<HTMLButtonElement>(
          '[data-testid="remote-control-plugins-save"]',
        )
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

  it("a new cloud task whose create's answer never came says it couldn't confirm it was created, never that it wasn't, and Try again creates it once under the same id (CAN-7196)", async () => {
    renderPage();
    await connectCowork();
    // S7c's shape for a lost reply; this create never reached the web core,
    // so no listing holds it.
    loseCreateReply = true;
    lostCreateLands = false;
    lostCreateRetry = 'never';
    act(() => {
      void createCloudSidebarTask('web-core:ws-1');
    });
    await settle();
    const taskId = createdChatIds.at(-1) ?? '';
    const lists = (): number =>
      coreRequestLog.filter((entry) => entry.method === 'core.chat.task.list')
        .length;
    const listed = lists();
    // The project is read again, and the task stays unknown, not refused.
    await settleUntil(() => lists() > listed);
    expect(newTaskRow(taskId)).toMatchObject({ creation: 'unknown' });
    expect(newTaskRow(taskId)).not.toHaveProperty('creationError');
    const unknown = container.querySelector(
      '[data-testid="chat-input-cloud-task-creation-unknown"]',
    );
    expect(unknown?.textContent).toContain(
      "Couldn't confirm this task was created",
    );
    expect(unknown?.textContent).toContain("It'll show in the list if it was.");
    expect(
      container.querySelector(
        '[data-testid="chat-input-cloud-task-creation-failed"]',
      ),
    ).toBeNull();
    // Nothing created it again on its own.
    expect(createdChatIds.filter((id) => id === taskId)).toHaveLength(1);
    // Try again creates it under the same id, and the notice leaves.
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-cloud-task-creation-retry"]',
        )
        ?.click();
    });
    await settleUntil(() => {
      const row = cloudCoworkStore
        .getState()
        .tasksByProject[
          'web-core:ws-1'
        ]?.find((task) => task.worktreeId === taskId);
      return row !== undefined && row.creation === undefined;
    });
    expect(newTaskRow(taskId)).not.toHaveProperty('creation');
    expect(createdChatIds.filter((id) => id === taskId)).toHaveLength(2);
    expect(
      container.querySelector(
        '[data-testid="chat-input-cloud-task-creation-unknown"]',
      ),
    ).toBeNull();
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

  it('keeps a cloud send whose outcome is unknown and says it may have sent, never that it failed, rather than hand it back to be sent twice (CAN-7196)', async () => {
    sendOutcomeUnknown = true;
    const addToast = jest.fn();
    const shownToast = useGitHubStore.getState().addToast;
    useGitHubStore.setState({ addToast });
    onCaseEnd(() => {
      useGitHubStore.setState({ addToast: shownToast });
    });
    const sent = rootMessagesWith('Book Studio B.');
    const sends = (): number =>
      coreRequestLog.filter(
        (entry) =>
          entry.method === 'core.chat.message.send' &&
          entry.params.text === 'Book Studio B.',
      ).length;
    await sendFromCoworkPage();
    await settle();
    // The send may have landed: it stays in the transcript, and the
    // composer doesn't offer it again.
    expect(rootMessagesWith('Book Studio B.')).toBe(sent + 1);
    expect(
      container.querySelector('[data-testid="chat-input-send-refused"]'),
    ).toBeNull();
    expect(useChatStore.getState().getTabDraft('web-core:wt-1') ?? []).toEqual(
      [],
    );
    // It went once and is never sent again on its own.
    expect(sends()).toBe(1);
    // It isn't shown as failed: no error under it and none on the tab.
    expect(rootMessagesWith('did not answer in time')).toBe(0);
    const tab = useChatStore
      .getState()
      .worktreeChats[
        'web-core:ws-1/web-core:wt-1'
      ]?.tabs.find((entry) => entry.id === 'web-core:wt-1');
    expect(tab?.status).not.toBe('error');
    expect(tab?.error ?? null).toBeNull();
    // It says the message may have sent, as a notice, not an error.
    expect(
      addToast.mock.calls.map(([message, type]: unknown[]) => [message, type]),
    ).toEqual([[WEB_CORE_SEND_UNKNOWN_NOTICE, 'info']]);
    expect(WEB_CORE_SEND_UNKNOWN_NOTICE).toBe(
      "Your message may have sent. It'll show here if it did.",
    );
  });

  // CAN-7196 (review round 4): the notice is the only word of a send whose
  // outcome is unknown, so it shows in the app, and is kept in its history,
  // even when in-app notifications are off.
  it('shows a cloud send whose outcome is unknown as a notice even with in-app notifications off (CAN-7196)', async () => {
    sendOutcomeUnknown = true;
    refreshInAppNotificationPrefs({ enabled: false } as never);
    resetToastStack();
    useToastStore.setState({ notifications: [] });
    onCaseEnd(() => {
      refreshInAppNotificationPrefs(null as never);
      resetToastStack();
      useToastStore.setState({ notifications: [] });
    });
    await sendFromCoworkPage();
    await settle();
    expect(
      toastStack
        .getSnapshot()
        .filter((toast) => toast.message === WEB_CORE_SEND_UNKNOWN_NOTICE),
    ).toHaveLength(1);
    expect(
      useToastStore
        .getState()
        .notifications.filter(
          (entry) => entry.message === WEB_CORE_SEND_UNKNOWN_NOTICE,
        ),
    ).toHaveLength(1);
  });

  it('shows nothing for a cloud send whose outcome turns out unknown after the cloud chat was cleared (CAN-7196)', async () => {
    sendOutcomeUnknown = true;
    let release: () => void = () => undefined;
    sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const addToast = jest.fn();
    const shownToast = useGitHubStore.getState().addToast;
    useGitHubStore.setState({ addToast });
    onCaseEnd(() => {
      useGitHubStore.setState({ addToast: shownToast });
    });
    await sendFromCoworkPage();
    await settle();
    // The cloud chat is cleared while the send's answer is still out.
    act(() => {
      cloudCoworkStore.getState().disconnect('offline');
    });
    await settle();
    expect(
      Object.keys(useChatStore.getState().worktreeChats).filter((key) =>
        key.startsWith('web-core:'),
      ),
    ).toEqual([]);
    release();
    await settle();
    // Nothing of it shows after the chat is gone.
    expect(addToast).not.toHaveBeenCalled();
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
    // Said once above the tree: no folder reads as loading or empty.
    expect(shown('files-tree-folder-loading')).toBe(false);
    expect(shown('files-tree-folder-empty')).toBe(false);
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

  /** Main's Files wakes, each with the chat it named. */
  /**
   * Main's Files wakes of one chat, each with the target it named. The page
   * may still show an earlier case's chat for a moment on render, so each
   * case counts only its own chat's wakes.
   */
  const filesWakes = (worktreeId: string): readonly unknown[] =>
    calls
      .filter(
        (call) =>
          call.path === CLOUD_WAKE_FILES &&
          Reflect.get(Object(call.args[0]), 'worktreeId') === worktreeId,
      )
      .map((c) => c.args);
  const FILES_FAKE_TIMERS: Parameters<typeof jest.useFakeTimers>[0] = {
    doNotFake: ['Date', 'nextTick', 'queueMicrotask', 'setImmediate'],
  };
  const flushFake = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1)
      await act(() => jest.advanceTimersByTimeAsync(0));
  };

  it('says the project is waking while a turn wakes it, and lists the folder once it is awake, with no refresh (CAN-6724)', async () => {
    sandboxAsleep = true;
    // A turn restarts a sandbox whose idle session ended; a read can't.
    asleepAs = { cloudCode: 'SANDBOX_SESSION_EXPIRED', wakeAllowed: false };
    await openExplorerOnNewTask('wt-6724-turn');
    expect(shown('files-tree-sandbox-sleeping')).toBe(true);

    // A message starts a turn, which wakes the sandbox; it isn't awake yet.
    jest.useFakeTimers(FILES_FAKE_TIMERS);
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-6724-turn',
    };
    runningTurn = 'turn-wakes';
    snapshotRevision += 1;
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await flushFake();
    expect(shown('files-tree-sandbox-waking')).toBe(true);
    expect(shown('files-tree-sandbox-sleeping')).toBe(false);
    expect(container.textContent).not.toContain('Send a message to wake it');

    // Still asleep at the next try: still waking, never the sleeping notice.
    await act(() =>
      jest.advanceTimersByTimeAsync(CLOUD_FILES_WAKE_RETRY_MAX_MS),
    );
    await flushFake();
    expect(shown('files-tree-sandbox-waking')).toBe(true);
    expect(shown('files-tree-sandbox-sleeping')).toBe(false);

    // The sandbox wakes while the turn runs. The pane lists the folder on
    // its own, with no refresh and no change to the turn.
    sandboxAsleep = false;
    await act(() =>
      jest.advanceTimersByTimeAsync(CLOUD_FILES_WAKE_RETRY_MAX_MS),
    );
    await flushFake();
    expect(container.textContent).toContain('brief.md');
    expect(shown('files-tree-sandbox-waking')).toBe(false);
    expect(shown('files-tree-sandbox-sleeping')).toBe(false);
    // The turn woke it; Files didn't ask main or the web core to.
    expect(filesWakes('wt-6724-turn')).toEqual([]);
    expect(askedToWake()).toBe(false);
  });

  it('falls back to the sleeping notice when the turn that was waking the project ends with it still asleep (CAN-6724)', async () => {
    sandboxAsleep = true;
    asleepAs = { cloudCode: 'SANDBOX_SESSION_EXPIRED', wakeAllowed: false };
    await openExplorerOnNewTask('wt-6724-turn-fails');
    jest.useFakeTimers(FILES_FAKE_TIMERS);
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-6724-turn-fails',
    };
    runningTurn = 'turn-wakes';
    snapshotRevision += 1;
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await flushFake();
    expect(shown('files-tree-sandbox-waking')).toBe(true);

    runningTurn = null;
    snapshotRevision += 1;
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await flushFake();
    expect(shown('files-tree-sandbox-waking')).toBe(false);
    expect(shown('files-tree-sandbox-sleeping')).toBe(true);
    // No more tries once nothing is waking it.
    const lists = coreRequests.filter(
      (method) => method === 'worker.filesystem.directory.list',
    ).length;
    await act(() =>
      jest.advanceTimersByTimeAsync(CLOUD_FILES_WAKE_RETRY_MAX_MS * 4),
    );
    await flushFake();
    expect(
      coreRequests.filter(
        (method) => method === 'worker.filesystem.directory.list',
      ).length,
    ).toBe(lists);
  });

  for (const [eventsRevision, reads] of [
    [2, 'sleeping'],
    [3, 'waking'],
  ] as const)
    it(`trusts a snapshot's report that the project is waking only where the web core's events keep it current: at events revision ${eventsRevision}, Files on a sleeping project whose own wake is refused reads ${reads} (CAN-6841)`, async () => {
      advertisedEventsRevision = eventsRevision;
      snapshotSandbox = 'waking';
      sandboxAsleep = true;
      await describeConnectionAgain();
      const task = `wt-6841-files-${eventsRevision}`;
      onCaseEnd(() => useCloudSandboxStateStore.getState().clear());
      try {
        await openExplorerOnNewTask(task);
        await settle();
        // Files tries its one wake either way, and main refuses it. At
        // revision 2 the snapshot's report is unknown, so Files keeps its
        // own inference: the wake failed and the project is asleep. At 3 the
        // report is published, and Files says a wake is under way.
        expect(filesWakes(task)).toHaveLength(1);
        expect(
          useCloudSandboxStateStore.getState().byWorktree[
            `web-core:ws-1/web-core:${task}`
          ]?.state,
        ).toBe(eventsRevision === 3 ? 'waking' : undefined);
        expect(shown('files-tree-sandbox-waking')).toBe(reads === 'waking');
        expect(shown('files-tree-sandbox-sleeping')).toBe(reads === 'sleeping');
      } finally {
        useCloudSandboxStateStore.getState().clear();
      }
    });

  it('opening Files on a sleeping project asks main to wake it once, says it is waking, then lists the folder (CAN-6724)', async () => {
    sandboxAsleep = true;
    let finishWake = (): void => undefined;
    wakeFilesAnswer = (): Promise<unknown> =>
      new Promise((resolve) => {
        finishWake = (): void => {
          sandboxAsleep = false;
          resolve({ ok: true });
        };
      });
    await openExplorerOnNewTask('wt-6724-open');
    // Main's one wake for this chat, while the pane says it is waking.
    expect(filesWakes('wt-6724-open')).toEqual([
      [
        {
          key: 'web-core:wt-6724-open',
          workspaceId: 'ws-1',
          worktreeId: 'wt-6724-open',
        },
      ],
    ]);
    expect(shown('files-tree-sandbox-waking')).toBe(true);
    expect(shown('files-tree-sandbox-sleeping')).toBe(false);

    act(() => finishWake());
    await settle();
    expect(container.textContent).toContain('brief.md');
    expect(shown('files-tree-sandbox-waking')).toBe(false);
    // Only main woke it: no relay call carried wake.
    expect(askedToWake()).toBe(false);
    expect(filesWakes('wt-6724-open')).toHaveLength(1);
  });

  it("a turn already waking the project is the open's one wake: when it ends still asleep, Files doesn't wake it again (CAN-6724)", async () => {
    sandboxAsleep = true;
    // A read could wake this sandbox, but a turn is already waking it.
    runningTurn = 'turn-wakes';
    await openExplorerOnNewTask('wt-6724-turn-then-files');
    const target = {
      projectId: 'web-core:ws-1',
      worktreeId: 'web-core:wt-6724-turn-then-files',
    };
    snapshotRevision += 1;
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await settle();
    expect(shown('files-tree-sandbox-waking')).toBe(true);
    expect(filesWakes('wt-6724-turn-then-files')).toEqual([]);

    // The turn ends with the sandbox still asleep: the wake failed. Files
    // falls back to the notice and doesn't start a wake of its own.
    runningTurn = null;
    snapshotRevision += 1;
    act(() => {
      refreshChatScopeRevisioned(target.projectId, target.worktreeId);
    });
    await settle();
    expect(shown('files-tree-sandbox-sleeping')).toBe(true);
    expect(shown('files-tree-sandbox-waking')).toBe(false);
    expect(filesWakes('wt-6724-turn-then-files')).toEqual([]);
    expect(askedToWake()).toBe(false);
  });

  it('a refused Files wake keeps the sleeping notice and is not tried again in the same open (CAN-6724)', async () => {
    sandboxAsleep = true;
    await openExplorerOnNewTask('wt-6724-refused');
    expect(filesWakes('wt-6724-refused')).toHaveLength(1);
    expect(shown('files-tree-sandbox-sleeping')).toBe(true);
    expect(shown('files-tree-sandbox-waking')).toBe(false);
    expect(container.textContent).toContain(
      'Project is sleeping. Send a message to wake it.',
    );
    // Another asleep answer in the same open doesn't wake again.
    const [groupId] = Object.keys(
      usePanelLayoutStore.getState().layouts[
        'web-core:ws-1/web-core:wt-6724-refused'
      ]?.groups ?? {},
    );
    expect(groupId).toBeDefined();
    await settle();
    expect(filesWakes('wt-6724-refused')).toHaveLength(1);
    expect(askedToWake()).toBe(false);
  });

  it("says waking while the web core reports the project's sandbox waking, though this open's wake was refused, and lists once it reports ready (CAN-6766)", async () => {
    sandboxAsleep = true;
    await openExplorerOnNewTask('wt-6766-files');
    expect(filesWakes('wt-6766-files')).toHaveLength(1);
    expect(shown('files-tree-sandbox-sleeping')).toBe(true);
    // A timeout skips the finally below; the case's end still clears it.
    onCaseEnd(() => useCloudSandboxStateStore.getState().clear());
    // Someone else wakes it (the web, another window): the web core reports
    // the sandbox waking on the task's chat.
    const reportSandbox = (state: 'waking' | 'ready'): void => {
      act(() => {
        useCloudSandboxStateStore.getState().set(
          liveReplyKey({
            projectId: 'web-core:ws-1',
            worktreeId: 'web-core:wt-6766-files',
            chatId: 'web-core:wt-6766-files',
          }),
          state,
        );
      });
    };
    try {
      reportSandbox('waking');
      await settle();
      expect(shown('files-tree-sandbox-waking')).toBe(true);
      expect(shown('files-tree-sandbox-sleeping')).toBe(false);
      // Awake: the web core reports ready, and the panel lists the folder
      // with no refresh and no wake of its own.
      sandboxAsleep = false;
      reportSandbox('ready');
      await settle();
      expect(container.textContent).toContain('brief.md');
      expect(shown('files-tree-sandbox-waking')).toBe(false);
      expect(filesWakes('wt-6766-files')).toHaveLength(1);
      expect(askedToWake()).toBe(false);
    } finally {
      useCloudSandboxStateStore.getState().clear();
    }
  });

  it("keeps the newest sandbox state by the task's revision, so a late older report from another chat never overwrites it (CAN-6766)", async () => {
    sandboxAsleep = true;
    await openExplorerOnNewTask('wt-6766-order');
    // A timeout skips the finally below; the case's end still clears it.
    onCaseEnd(() => useCloudSandboxStateStore.getState().clear());
    const report = (
      chatId: string,
      state: 'waking' | 'ready',
      revision: number,
    ): void => {
      act(() => {
        useCloudSandboxStateStore.getState().set(
          liveReplyKey({
            projectId: 'web-core:ws-1',
            worktreeId: 'web-core:wt-6766-order',
            chatId,
          }),
          state,
          revision,
        );
      });
    };
    try {
      report('web-core:wt-6766-order', 'waking', 5);
      await settle();
      expect(shown('files-tree-sandbox-waking')).toBe(true);
      // Another chat's older report lands late: the sandbox is still waking.
      report('web-core:chat-6766-other', 'ready', 3);
      await settle();
      expect(shown('files-tree-sandbox-waking')).toBe(true);
      expect(shown('files-tree-sandbox-sleeping')).toBe(false);
    } finally {
      useCloudSandboxStateStore.getState().clear();
    }
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

  it('shows a cloud folder still listing as loading, and an empty one as empty, never alike (CAN-6756)', async () => {
    await openExplorerOnNewTask('wt-6756');
    const docsRow = (): HTMLElement | null =>
      container.querySelector<HTMLElement>(
        '[data-file-tree-id="workspace:docs"]',
      );
    expect(docsRow()).not.toBeNull();

    // docs/ is empty, and its listing takes a while, as a cloud one does.
    docsEmpty = true;
    let releaseListing = (): void => undefined;
    listingGate = new Promise<void>((resolve) => {
      releaseListing = resolve;
    });
    act(() => {
      docsRow()?.click();
    });
    await settle();
    // Past the shared loading delay, the open folder says it is loading.
    await act(
      () =>
        new Promise((resolve) =>
          setTimeout(resolve, LOADING_PLACEHOLDER_DELAY_MS + 50),
        ),
    );
    expect(shown('files-tree-folder-loading')).toBe(true);
    expect(shown('files-tree-folder-empty')).toBe(false);

    // Its listing lands empty: the folder says so, and loads no longer.
    releaseListing();
    listingGate = null;
    await settle();
    expect(shown('files-tree-folder-loading')).toBe(false);
    expect(shown('files-tree-folder-empty')).toBe(true);
    expect(
      container.querySelector('[data-testid="files-tree-folder-empty"]')
        ?.textContent,
    ).toBe('Empty folder');
    expect(callsCarryingWebCoreIds()).toEqual([]);
  });

  it('a local scope keeps every composer, tab and delegate control a cloud scope hides', () => {
    const local = createDesktopCapabilities('darwin', {}, {});
    const cloud = webCoreScopeCapabilities(local);
    for (const key of [
      'chatApprovalMode',
      'chatTabFork',
      'chatRootTabLifecycle',
      'chatResetToPoint',
      'chatFileMentions',
      'chatInterfaceModes',
      // A delegate card's Stop, and the drawer's Stop and Stop all
      // (CAN-7055).
      'delegationStop',
      // A delegate card's Load changes, which follows it (CAN-7245).
      'delegationWorktreeDetails',
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
    // Folded from each answer's meter, which the web core serves (CAN-6755).
    expect(local.chatContextUsage).toBe(true);
    expect(cloud.chatContextUsage).toBe(true);
  });

  it("keeps a cloud scope's whole-chat fork and delegate transcript reads on separate cached capability sets (CAN-7027)", () => {
    const host = createDesktopCapabilities('darwin', {}, {});
    const base = webCoreScopeCapabilities(host, { durableTerminals: false });
    const fork = webCoreScopeCapabilities(host, {
      durableTerminals: false,
      taskFork: true,
    });
    const reads = webCoreScopeCapabilities(host, {
      durableTerminals: false,
      delegationTranscriptReads: true,
    });
    expect(new Set([base, fork, reads]).size).toBe(3);
    expect([
      base.chatTaskFork === true,
      base.delegationTranscriptReads === true,
    ]).toEqual([false, false]);
    expect([
      fork.chatTaskFork === true,
      fork.delegationTranscriptReads === true,
    ]).toEqual([true, false]);
    expect([
      reads.chatTaskFork === true,
      reads.delegationTranscriptReads === true,
    ]).toEqual([false, true]);
  });

  it('offers the Subagents panels only to a scope that runs its delegates on this computer and reads their transcripts (CAN-7027)', () => {
    const local = createDesktopCapabilities('darwin', {}, {});
    const subagentKinds = (capabilities: CanopyCapabilities): string[] =>
      panelKindsUnavailableFor(capabilities).filter(
        (kind) => kind === 'subagents' || kind === 'subagent-chat',
      );
    expect([local.localExecution, local.delegationTranscriptReads]).toEqual([
      true,
      true,
    ]);
    expect(subagentKinds(local)).toEqual([]);
    // Without the reads, as before.
    expect(
      subagentKinds({ ...local, delegationTranscriptReads: false }),
    ).toEqual(['subagents', 'subagent-chat']);
    // With the reads but not run here: a cloud scope's delegates aren't in
    // this computer's delegation service, which the panels read.
    const cloud = webCoreScopeCapabilities(local, {
      durableTerminals: false,
      delegationTranscriptReads: true,
    });
    expect([cloud.localExecution, cloud.delegationTranscriptReads]).toEqual([
      false,
      true,
    ]);
    expect(subagentKinds(cloud)).toEqual(['subagents', 'subagent-chat']);
    expect(subagentKinds({ ...local, localExecution: false })).toEqual([
      'subagents',
      'subagent-chat',
    ]);
  });

  it('offers a cloud scope the Subagents and subagent chat panels only with cloudSubagentPanels on (CAN-7133)', () => {
    const local = createDesktopCapabilities('darwin', {}, {});
    const subagentKinds = (capabilities: CanopyCapabilities): string[] =>
      panelKindsUnavailableFor(capabilities).filter(
        (kind) => kind === 'subagents' || kind === 'subagent-chat',
      );
    const off = webCoreScopeCapabilities(local, {
      durableTerminals: false,
      delegationTranscriptReads: true,
    });
    expect(off.subagentPanels).toBeUndefined();
    expect(subagentKinds(off)).toEqual(['subagents', 'subagent-chat']);
    const on = webCoreScopeCapabilities(local, {
      durableTerminals: false,
      delegationTranscriptReads: true,
      cloudSubagentPanels: true,
    });
    // Its delegates still don't run here: the hosts read the web core.
    expect([on.subagentPanels, on.localExecution]).toEqual([true, false]);
    expect(subagentKinds(on)).toEqual([]);
    // The two are separate cached sets.
    expect(
      webCoreScopeCapabilities(local, {
        durableTerminals: false,
        delegationTranscriptReads: true,
      }),
    ).toBe(off);
    // A local scope is unchanged and never carries it.
    expect(local.subagentPanels).toBeUndefined();
    expect(subagentKinds(local)).toEqual([]);
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

  it('forks a cowork cloud chat into a new task when the web core serves the fork, from its latest turn under one claim: a refusal changes nothing, and a lost reply waits for Try again with the same claim and forks once (CAN-7007)', async () => {
    transcripts['wt-1'] = [
      {
        id: 'fork-u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'Draft the brief' }],
        timestamp: 1,
      },
      {
        id: 'fork-a1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Drafted.' }],
        timestamp: 2,
      },
      {
        id: 'fork-u2',
        role: 'user',
        blocks: [{ type: 'text', text: 'Shorter, please' }],
        timestamp: 3,
      },
      {
        id: 'fork-a2',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Shortened.' }],
        timestamp: 4,
      },
    ];
    act(() => {
      cloudCoworkStore.getState().disconnect('offline');
    });
    connectCloud();
    const forkButtons = (): HTMLElement[] =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid="fork-chat-button"]',
        ),
      );
    try {
      // A cowork project's scope offers no Fork while the web core's
      // manifest doesn't serve the fork.
      renderPage({ followsEvents: true });
      act(() => {
        openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
      });
      await settle();
      expect(forkButtons()).toHaveLength(0);
      expect(cloudScopeCapabilitiesNow().chatTaskFork).not.toBe(true);
      // An agent's fork action (a chat agent's or App Advisor's, both
      // dispatched in this window) refuses there before any request.
      const forkAction = (
        requestId: string,
      ): Promise<AppAdvisorActionResponse> =>
        dispatchAppAction({
          requestId,
          source: 'assistant',
          action: {
            type: 'worktree-chat.run_chat_action',
            projectId: 'web-core:ws-1',
            worktreeId: 'web-core:wt-1',
            chatId: 'web-core:wt-1',
            action: 'fork',
          },
        });
      let refusedAction: unknown;
      await act(async () => {
        refusedAction = await forkAction('fork-action-off');
      });
      expect(refusedAction).toMatchObject({
        ok: false,
        error: { code: 'surface_unavailable' },
      });
      expect(forkClaims).toEqual([]);

      // The tab fork gate, which the local scope reports, offers Fork on
      // every completed turn.
      renderPage({
        followsEvents: true,
        cloudScopeExtras: { chatTabFork: true },
      });
      await settle();
      expect(forkButtons()).toHaveLength(2);
      expect(createDesktopCapabilities('darwin', {}, {})).toMatchObject({
        chatTabFork: true,
      });
      expect(
        createDesktopCapabilities('darwin', {}, {}).chatTaskFork,
      ).toBeUndefined();
      // A cloud scope never reports the tab fork, and reports the whole-chat
      // fork only when its project and the web core allow it.
      const host = createDesktopCapabilities('darwin', {}, {});
      const cloud = webCoreScopeCapabilities(host);
      expect(cloud.chatTabFork).not.toBe(true);
      expect(cloud.chatTaskFork).not.toBe(true);
      expect(
        webCoreScopeCapabilities(host, {
          durableTerminals: false,
          taskFork: true,
        }),
      ).toMatchObject({ chatTabFork: false, chatTaskFork: true });

      // With the manifest serving core.chat.fork, a listed cowork project's
      // scope reports it, and an unlisted project's doesn't.
      servesFork = true;
      resetWebCoreServedOperations();
      renderPage({ followsEvents: true });
      await settle();
      expect(cloudScopeCapabilitiesNow().chatTaskFork).toBe(true);
      expect(
        createDesktopCanopyClient(host).capabilitiesFor?.('web-core:ws-9')
          ?.chatTaskFork,
      ).not.toBe(true);
      // A whole-chat fork into a new task has no fork point, so only the
      // latest completed turn offers it.
      expect(forkButtons()).toHaveLength(1);
      // Branch, Share and Run comments act on a local session, so a cloud
      // turn offers none of them beside its Fork, inline or in its menu.
      expect(
        container.querySelector('[data-testid="turn-share-session"]'),
      ).toBeNull();
      const moreMenus = Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid="turn-more-actions"]',
        ),
      );
      expect(moreMenus.length).toBeGreaterThan(0);
      for (const menu of moreMenus) {
        act(() => {
          menu.click();
        });
        await settle();
        expect(
          document.querySelector('[data-testid="turn-more-actions-menu"]'),
        ).not.toBeNull();
        expect(
          document.querySelector(
            '[data-testid="turn-more-share"], [data-testid="turn-more-branch"]',
          ),
        ).toBeNull();
        act(() => {
          menu.click();
        });
        await settle();
      }

      // A repository project's fork would stay in a worktree this window
      // can't open (CAN-6177), so it offers no Fork and forks nothing.
      const asKind = (kind: 'cowork' | 'git'): void => {
        act(() => {
          cloudCoworkStore.setState((state) => ({
            projects: state.projects.map((project) =>
              project.key === 'web-core:ws-1' ? { ...project, kind } : project,
            ),
          }));
        });
      };
      asKind('git');
      await settle();
      expect(cloudScopeCapabilitiesNow().chatTaskFork).not.toBe(true);
      expect(forkButtons()).toHaveLength(0);
      await act(async () => {
        expect(
          await forkCloudChat({
            projectId: 'web-core:ws-1',
            worktreeId: 'web-core:wt-1',
            chatId: 'web-core:wt-1',
          }),
        ).toEqual({ kind: 'refused', reason: 'not_openable' });
      });
      expect(forkClaims).toEqual([]);
      clearCloudForks();
      asKind('cowork');
      await settle();
      expect(cloudScopeCapabilitiesNow().chatTaskFork).toBe(true);
      expect(forkButtons()).toHaveLength(1);

      // A stray tab fork on a cloud chat is still refused: it never reaches
      // the web core as a fork or a new chat.
      const sentBefore = coreRequests.length;
      let strayDisposition: unknown;
      await act(async () => {
        strayDisposition = await useChatStore
          .getState()
          .dispatchChatCommand(
            { projectId: 'web-core:ws-1', worktreeId: 'web-core:wt-1' },
            {
              type: 'chat.fork_tab',
              sourceTabId: 'web-core:wt-1',
              targetTabId: 'web-core:stray-fork',
            },
          )
          .catch(() => 'rejected');
      });
      expect(strayDisposition).not.toBe('accepted');
      expect(
        coreRequests
          .slice(sentBefore)
          .filter(
            (method) =>
              method === 'core.chat.fork' || method === 'core.chat.create',
          ),
      ).toEqual([]);

      // A refusal makes no fork and leaves the chat where it was.
      forkAnswer = 'refuse';
      act(() => {
        forkButtons()[0]?.click();
      });
      await settle();
      expect(shown('cloud-fork-refused')).toBe(true);
      expect(useChatStore.getState().selectedWorktree).toEqual({
        projectId: 'web-core:ws-1',
        worktreeId: 'web-core:wt-1',
      });

      // A lost reply is an unknown outcome: nothing retries on its own.
      forkAnswer = 'lose';
      act(() => {
        forkButtons()[0]?.click();
      });
      await settle();
      expect(shown('cloud-fork-unknown')).toBe(true);
      expect(forkClaims).toHaveLength(2);
      expect(forkClaims[1]).not.toBe(forkClaims[0]);
      await settle();
      expect(forkClaims).toHaveLength(2);
      expect(useChatStore.getState().selectedWorktree?.worktreeId).toBe(
        'web-core:wt-1',
      );

      // Try again sends the same claim, so the web core can't fork twice,
      // then opens the new task.
      act(() => {
        Array.from(
          container.querySelectorAll<HTMLElement>(
            '[data-testid="cloud-fork-unknown"] button',
          ),
        )
          .find((button) => button.textContent === 'Try again')
          ?.click();
      });
      await settle();
      const claim = forkClaims[1];
      expect(forkClaims).toEqual([forkClaims[0], claim, claim]);
      // The lost reply's fork and its retry are one fork, never two
      // (CAN-5541).
      expect(forkCreations).toBe(1);
      expect(claim).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(
        coreRequestLog.filter((entry) => entry.method === 'core.chat.fork')[2]
          ?.params,
      ).toMatchObject({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        commandId: claim,
        action: {
          type: 'chat.fork_tab',
          sourceTabId: 'wt-1',
          targetTabId: claim,
        },
        _meta: { idempotencyKey: claim },
      });
      expect(useChatStore.getState().selectedWorktree).toEqual({
        projectId: 'web-core:ws-1',
        worktreeId: `web-core:${claim}`,
      });
      expect(shown('cloud-fork-unknown')).toBe(false);
      expect(callsCarryingWebCoreIds()).toEqual([]);

      // With the fork served, the agent's fork action takes the same cloud
      // path under a fresh claim and names the new task.
      let forkedAction: unknown;
      await act(async () => {
        forkedAction = await forkAction('fork-action-on');
      });
      const actionClaim = forkClaims[3];
      expect(actionClaim).toBeDefined();
      expect(actionClaim).not.toBe(claim);
      expect(forkedAction).toMatchObject({
        ok: true,
        result: { action: 'fork', worktreeId: `web-core:${actionClaim}` },
      });
      expect(forkCreations).toBe(2);
    } finally {
      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
    }
  });

  it("shows a cloud chat's AI Credits in Usage (Active Chat), never this computer's account for its model's provider (CAN-6942)", async () => {
    // A cloud scope's chats don't run on this computer's subscriptions; a
    // local scope's do.
    const local = createDesktopCapabilities('darwin', {}, {});
    expect(local.subscriptionProviders).toBe(true);
    expect(webCoreScopeCapabilities(local).subscriptionProviders).not.toBe(
      true,
    );
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
    // The cloud chat's tab resolves to a provider this computer is signed in
    // to, as a cloud chat on staging did.
    const key = `${target.projectId}/${target.worktreeId}`;
    act(() => {
      useChatStore.setState((state) => {
        const chat = state.worktreeChats[key];
        if (chat === undefined) throw new Error('No cloud chat state.');
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: {
              ...chat,
              tabs: chat.tabs.map((tab) =>
                tab.id === target.chatId
                  ? { ...tab, providerType: 'codex' }
                  : tab,
              ),
            },
          },
        };
      });
    });
    const observability = useObservabilityStore.getState();
    act(() => {
      useObservabilityStore.setState({
        initialize: () => Promise.resolve(),
        usage: {
          updatedAt: new Date(0).toISOString(),
          providers: [
            {
              provider: 'codex',
              authState: 'authenticated',
              hasRemainingLimits: true,
              accountEmail: 'local-account@example.com',
              subscriptionLabel: 'Local plan',
            },
          ],
        },
      });
    });
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    const panelRoot = createRoot(panel);
    try {
      act(() => {
        panelRoot.render(
          <CanopyClientProvider
            client={createDesktopCanopyClient(
              createDesktopCapabilities('darwin', {}, {}),
            )}
          >
            <UsagePanel
              variant="active-chat"
              projectId={target.projectId}
              worktreeId={target.worktreeId}
              visible
            />
          </CanopyClientProvider>,
        );
      });
      await settle();
      const text = panel.textContent ?? '';
      expect(text).not.toContain('local-account@example.com');
      expect(text).not.toContain('Local plan');
      expect(
        panel.querySelector('[data-testid="usage-panel-cloud-chat"]'),
      ).not.toBeNull();
    } finally {
      act(() => {
        panelRoot.unmount();
      });
      panel.remove();
      act(() => {
        useObservabilityStore.setState({
          initialize: observability.initialize,
          usage: observability.usage,
        });
      });
    }
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

  describe('switching between cloud tasks (CAN-6754)', () => {
    /**
     * Adds tasks of their own to the cloud project, so no earlier case has
     * read them: each one's first open reads its snapshot, as the first open
     * of a task after app start does.
     */
    function addTasks(...ids: readonly string[]): void {
      cloudCoworkStore.setState((state) => ({
        tasksByProject: {
          'web-core:ws-1': [
            ...(state.tasksByProject['web-core:ws-1'] ?? []),
            ...ids.map((worktreeId) => ({
              key: `web-core:ws-1:${worktreeId}`,
              workspaceId: 'ws-1',
              worktreeId,
              title: `Task ${worktreeId}`,
              state: 'idle' as const,
              updatedAt: CREATED_AT,
            })),
          ],
        },
      }));
    }

    /** Holds a task's snapshot until the case serves or refuses it. */
    function holdSnapshotOf(task: string): {
      readonly serve: () => void;
      readonly refuse: () => void;
    } {
      let settleHold: (outcome: 'serve' | 'refuse') => void = () => undefined;
      snapshotHolds.set(
        task,
        new Promise((resolve) => {
          settleHold = resolve;
        }),
      );
      return {
        serve: () => settleHold('serve'),
        refuse: () => settleHold('refuse'),
      };
    }

    function openFromSidebar(task: string): void {
      act(() => {
        openCoworkWorkEntryFromSidebar('web-core:ws-1', `web-core:${task}`);
      });
    }

    function composerShown(): boolean {
      return (
        container.querySelector(
          '[data-chat-composer-root] [contenteditable="true"]',
        ) !== null
      );
    }

    /** What the page shows as open: its entry, and the sidebar's highlight. */
    function pageEntry(): string | null {
      return useStandaloneChatStore.getState().activeWorkEntryId;
    }

    /**
     * Types into whatever composer the page shows and presses Send, as a user
     * who thinks the click already landed does. Returns whether there was a
     * composer to type into.
     */
    async function typeAndSend(text: string): Promise<boolean> {
      const editable = container.querySelector<HTMLElement>(
        '[data-chat-composer-root] [contenteditable="true"]',
      );
      if (editable === null) return false;
      const editor = composerEditorOf(editable);
      act(() => {
        Transforms.select(editor, Editor.end(editor, []));
        Editor.insertText(editor, text);
      });
      await settle();
      act(() => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
          ?.click();
      });
      await settle();
      return true;
    }

    /**
     * Picks the second model in whatever composer the page shows, through its
     * model picker. Returns whether there was a picker to pick from.
     */
    async function pickModelInComposer(): Promise<boolean> {
      const trigger = container.querySelector<HTMLButtonElement>(
        '[data-chat-composer-root] [data-testid="remote-control-chat-model-picker"]',
      );
      if (trigger === null) return false;
      act(() => {
        trigger.click();
      });
      await settle();
      const option = Array.from(
        container.ownerDocument.querySelectorAll<HTMLElement>(
          '[data-testid="remote-control-chat-model-option"]',
        ),
      ).find((row) => row.textContent?.includes('Second model'));
      if (option === undefined) throw new Error('No Second model row.');
      act(() => {
        option.click();
      });
      await settle();
      return true;
    }

    /**
     * Turns on the Review skill in whatever composer the page shows, through
     * its + menu's plugins picker, and saves. Returns whether there was a
     * composer to open it from.
     */
    async function saveSkillInComposer(): Promise<boolean> {
      const plus = container.querySelector<HTMLButtonElement>(
        '[data-chat-composer-root] [data-testid="chat-input-plus-button"]',
      );
      if (plus === null) return false;
      const doc = container.ownerDocument;
      act(() => {
        plus.click();
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
      act(() => {
        doc
          .querySelector<HTMLInputElement>('input[aria-label="Select Review"]')
          ?.click();
      });
      act(() => {
        doc
          .querySelector<HTMLButtonElement>(
            '[data-testid="remote-control-plugins-save"]',
          )
          ?.click();
      });
      await settle();
      return true;
    }

    /**
     * What the web core was asked to do to a task's chats: a send names its
     * text, a change names its action.
     */
    function writesTo(task: string): unknown[] {
      return coreRequestLog
        .filter(
          (entry) =>
            ['core.chat.message.send', 'core.chat.update'].includes(
              entry.method,
            ) &&
            (worktreeOf(entry.params) === task || entry.params.chatId === task),
        )
        .map((entry) =>
          entry.method === 'core.chat.message.send'
            ? `send ${String(entry.params.text)}`
            : String(Reflect.get(Object(entry.params.action), 'type')),
        );
    }

    /** The texts the web core was asked to send to a task's chats. */
    function sentTo(task: string): unknown[] {
      return coreRequestLog
        .filter(
          (entry) =>
            entry.method === 'core.chat.message.send' &&
            (worktreeOf(entry.params) === task || entry.params.chatId === task),
        )
        .map((entry) => entry.params.text);
    }

    it('moves the page to a clicked cloud task at once, and nothing sent, picked or saved while it loads reaches the task open before (CAN-6754)', async () => {
      addTasks('wt-6754-a1', 'wt-6754-b1');
      renderPage();
      openFromSidebar('wt-6754-a1');
      await settle();
      expect(pageEntry()).toBe('web-core:wt-6754-a1');
      expect(composerShown()).toBe(true);

      // B's first read is held, as a cold read right after app start is.
      const b = holdSnapshotOf('wt-6754-b1');
      openFromSidebar('wt-6754-b1');
      await settle();
      const atOnce = {
        page: pageEntry(),
        loading:
          shown('standalone-chat-loading') || shown('panel-binding-loading'),
        composer: composerShown(),
      };
      // A user who thinks B is open picks a model, turns on a skill, and
      // types and sends, in whatever composer the page shows.
      await pickModelInComposer();
      await saveSkillInComposer();
      await typeAndSend('Meant for B');
      expect({ ...atOnce, toA: writesTo('wt-6754-a1') }).toEqual({
        page: 'web-core:wt-6754-b1',
        loading: true,
        composer: false,
        toA: [],
      });

      // B's tabs land: B's own composer, sending to B.
      b.serve();
      await settle();
      expect(pageEntry()).toBe('web-core:wt-6754-b1');
      expect(composerShown()).toBe(true);
      expect(await pickModelInComposer()).toBe(true);
      expect(await saveSkillInComposer()).toBe(true);
      expect(await typeAndSend('For B')).toBe(true);
      expect(writesTo('wt-6754-b1')).toEqual([
        'chat.set_model',
        'chat.patch_tab_settings',
        'send For B',
      ]);
      expect(writesTo('wt-6754-a1')).toEqual([]);
    });

    it("sweeps a project's archives a few tasks at a time, and never ahead of a task the user opens (CAN-6778)", async () => {
      const clicked = 'wt-6778-clicked';
      const swept = [
        'wt-6778-b',
        'wt-6778-c',
        'wt-6778-d',
        'wt-6778-e',
        'wt-6778-f',
        'wt-6778-g',
      ];
      addTasks(...swept, clicked);
      // The sweep runs only for a project with no known activity: forget any
      // archive an earlier case read for it.
      useChatStore.setState({ archivedChats: {} });
      useStandaloneChatStore.setState({ legacyArchivedByProject: {} });
      const holds = swept.map((task) => holdSnapshotOf(task));
      const sweepReads = (): number =>
        coreRequestLog.filter(
          (entry) =>
            entry.method === 'core.chat.snapshot.get' &&
            swept.includes(String(worktreeOf(entry.params))),
        ).length;
      renderPage();
      openFromSidebar('wt-1');
      await settle();
      // An earlier case may have listed the project's entries before these
      // tasks were added: list them again, as the sidebar's listing does.
      await act(() =>
        useStandaloneChatStore.getState().refreshWorkEntries('web-core:ws-1'),
      );
      await settle();
      // The first open settled; the sweep reads a few tasks at once, each
      // held read keeping its slot.
      expect(sweepReads()).toBe(COWORK_ARCHIVE_SWEEP_CONCURRENCY);

      // The user opens another task while the sweep runs; its read is held.
      const open = holdSnapshotOf(clicked);
      openFromSidebar(clicked);
      await settle();
      // Sweep reads finish while that open loads: no new one starts ahead
      // of it.
      holds[0]?.serve();
      holds[1]?.serve();
      await settle();
      expect(sweepReads()).toBe(COWORK_ARCHIVE_SWEEP_CONCURRENCY);

      // Once it lands, the sweep goes on, still a few at a time.
      open.serve();
      await settle();
      expect(sweepReads()).toBe(COWORK_ARCHIVE_SWEEP_CONCURRENCY + 2);
      for (const hold of holds) hold.serve();
      await settle();
      expect(sweepReads()).toBe(swept.length);
    });

    it('never re-reads a queued task whose archive an open read meanwhile (CAN-6778)', async () => {
      const held = ['wt-6778-h1', 'wt-6778-h2', 'wt-6778-h3'];
      const queued = ['wt-6778-q1', 'wt-6778-q2'];
      const opened = 'wt-6778-opened';
      addTasks(...held, ...queued, opened);
      useChatStore.setState({ archivedChats: {} });
      useStandaloneChatStore.setState({ legacyArchivedByProject: {} });
      const holds = held.map((task) => holdSnapshotOf(task));
      const readsOf = (task: string): number =>
        coreRequestLog.filter(
          (entry) =>
            entry.method === 'core.chat.snapshot.get' &&
            String(worktreeOf(entry.params)) === task,
        ).length;
      renderPage();
      openFromSidebar('wt-1');
      await settle();
      await act(() =>
        useStandaloneChatStore.getState().refreshWorkEntries('web-core:ws-1'),
      );
      await settle();

      // The sweep holds its slots; the user opens a task still queued.
      openFromSidebar(opened);
      await settle();
      expect(
        Object.prototype.hasOwnProperty.call(
          useChatStore.getState().archivedChats,
          `web-core:ws-1/web-core:${opened}`,
        ),
      ).toBe(true);
      const readsByTheOpen = readsOf(opened);

      for (const hold of holds) hold.serve();
      await settle();
      expect(queued.map(readsOf)).toEqual([1, 1]);
      expect(readsOf(opened)).toBe(readsByTheOpen);
    });

    it("keeps the last clicked cloud task when an earlier click's load lands after it (CAN-6754)", async () => {
      addTasks('wt-6754-a2', 'wt-6754-b2', 'wt-6754-c2');
      renderPage();
      openFromSidebar('wt-6754-a2');
      await settle();
      expect(composerShown()).toBe(true);

      const b = holdSnapshotOf('wt-6754-b2');
      const c = holdSnapshotOf('wt-6754-c2');
      openFromSidebar('wt-6754-b2');
      await settle();
      openFromSidebar('wt-6754-c2');
      await settle();
      expect({ page: pageEntry(), composer: composerShown() }).toEqual({
        page: 'web-core:wt-6754-c2',
        composer: false,
      });

      // B's late read never moves the page back, to B or to A.
      b.serve();
      await settle();
      expect({ page: pageEntry(), composer: composerShown() }).toEqual({
        page: 'web-core:wt-6754-c2',
        composer: false,
      });
      expect(useChatStore.getState().selectedWorktree).toEqual({
        projectId: 'web-core:ws-1',
        worktreeId: 'web-core:wt-6754-c2',
      });

      c.serve();
      await settle();
      expect(pageEntry()).toBe('web-core:wt-6754-c2');
      expect(await typeAndSend('For C')).toBe(true);
      expect(sentTo('wt-6754-c2')).toHaveLength(1);
      expect([...sentTo('wt-6754-a2'), ...sentTo('wt-6754-b2')]).toEqual([]);
    });

    it("shows a clicked cloud task's own load failure, never the task open before (CAN-6754)", async () => {
      addTasks('wt-6754-a3', 'wt-6754-b3');
      renderPage();
      openFromSidebar('wt-6754-a3');
      await settle();
      expect(composerShown()).toBe(true);

      const b = holdSnapshotOf('wt-6754-b3');
      openFromSidebar('wt-6754-b3');
      await settle();
      expect({ page: pageEntry(), composer: composerShown() }).toEqual({
        page: 'web-core:wt-6754-b3',
        composer: false,
      });

      b.refuse();
      await settle();
      expect({
        page: pageEntry(),
        failure: shown('standalone-chat-load-error'),
        composer: composerShown(),
      }).toEqual({
        page: 'web-core:wt-6754-b3',
        failure: true,
        composer: false,
      });
      expect(container.textContent).toContain(
        'The web core could not read this task.',
      );
      expect(sentTo('wt-6754-a3')).toEqual([]);
    });

    /** Holds a task's chat list replies until the case releases them. */
    function holdListOf(task: string): () => void {
      let release = (): void => undefined;
      listHolds.set(
        task,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => release();
    }

    /** Holds a task's transcript page replies until the case releases them. */
    function holdPagesOf(task: string): () => void {
      let release = (): void => undefined;
      pageHolds.set(
        task,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => release();
    }

    /**
     * The reads a task's open waits on, in the order the window sent them:
     * its task snapshot, its chat list and its transcript pages. A chat's own
     * snapshot, read for its agent tasks, is not one of them. Counted from
     * `since`, a point in the request log: the page's archive sweep reads
     * each task once when the project's tasks load, before any case's click.
     */
    function readsOf(task: string, since: number): string[] {
      return coreRequestLog
        .slice(since)
        .filter((entry) => worktreeOf(entry.params) === task)
        .flatMap((entry) => {
          if (entry.method === 'core.chat.snapshot.get')
            return entry.params.chatId === undefined ? ['snapshot'] : [];
          if (entry.method === 'core.chat.list') return ['list'];
          if (entry.method === 'core.chat.transcript.page') return ['page'];
          return [];
        });
    }

    /** Every method the window asked the web core about a task since `since`. */
    function methodsFor(task: string, since: number): string[] {
      return [
        ...new Set(
          coreRequestLog
            .slice(since)
            .filter(
              (entry) =>
                worktreeOf(entry.params) === task ||
                entry.params.chatId === task,
            )
            .map((entry) => entry.method),
        ),
      ];
    }

    /** Whether the chat store holds or follows anything of a task. */
    function storeHolds(task: string): boolean {
      const key = `web-core:ws-1/web-core:${task}`;
      const state = useChatStore.getState();
      return (
        state.worktreeChats[key] !== undefined ||
        state.chatStateSync[key] !== undefined
      );
    }

    /** The streams the window opened for a task. */
    function streamsFor(task: string): string[] {
      return [...openedStreams.values()]
        .filter((stream) => worktreeOf(stream.params) === task)
        .map((stream) => stream.method);
    }

    /** Whether a task's open tab has its transcript loaded. */
    function transcriptLoaded(task: string): boolean {
      const state =
        useChatStore.getState().worktreeChats[`web-core:ws-1/web-core:${task}`];
      const tab = state?.tabs.find((each) => each.id === state.activeTabId);
      return tab !== undefined && tab.transcriptLoaded !== false;
    }

    /** A sidebar cloud row's hover target, as the shared sidebar names it. */
    function rowIntent(task: string): Parameters<typeof noteChatIntent>[0] {
      return {
        kind: 'cloudTask',
        projectId: 'web-core:ws-1',
        worktreeId: `web-core:${task}`,
      };
    }

    /** Waits past the pointer's dwell, as a pointer resting on a row does. */
    async function dwell(): Promise<void> {
      await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
      await settle();
    }

    it("reads a clicked cloud task's chat list with its snapshot, and its first transcript page as soon as the snapshot answers (CAN-6774)", async () => {
      addTasks('wt-6754-a4', 'wt-6754-b4');
      renderPage();
      openFromSidebar('wt-6754-a4');
      await settle();
      expect(composerShown()).toBe(true);

      // B's three reads are held, as cold replies are right after app start.
      const snapshot = holdSnapshotOf('wt-6754-b4');
      const releaseList = holdListOf('wt-6754-b4');
      const releasePages = holdPagesOf('wt-6754-b4');
      const click = coreRequestLog.length;
      openFromSidebar('wt-6754-b4');
      await settle();
      // The chat list needs nothing the snapshot answers: both go at once.
      const beforeSnapshot = readsOf('wt-6754-b4', click);
      snapshot.serve();
      await settle();
      // The first page goes as the snapshot answers, while the list waits.
      const beforeList = readsOf('wt-6754-b4', click);
      releaseList();
      await settle();
      releasePages();
      await settle();
      expect({
        beforeSnapshot,
        beforeList,
        after: readsOf('wt-6754-b4', click),
        loaded: transcriptLoaded('wt-6754-b4'),
        composer: composerShown(),
      }).toEqual({
        beforeSnapshot: ['snapshot', 'list'],
        beforeList: ['snapshot', 'list', 'page'],
        // Each read once: the page read early is the one the tab shows.
        after: ['snapshot', 'list', 'page'],
        loaded: true,
        composer: true,
      });
    });

    it("reads a cloud task's chat list again after its snapshot when the list was read at an older revision (CAN-6774)", async () => {
      addTasks('wt-6754-a5', 'wt-6754-b5');
      renderPage();
      openFromSidebar('wt-6754-a5');
      await settle();
      expect(composerShown()).toBe(true);

      // The list answers first, from before a change the snapshot covers.
      snapshotRevision = 2;
      listRevisionLag = 1;
      const snapshot = holdSnapshotOf('wt-6754-b5');
      const click = coreRequestLog.length;
      openFromSidebar('wt-6754-b5');
      await settle();
      const beforeSnapshot = readsOf('wt-6754-b5', click);
      listRevisionLag = 0;
      snapshot.serve();
      await settle();
      expect({
        beforeSnapshot,
        // The older list is never installed: it is read again after the
        // snapshot, as the open did before the two went together.
        after: readsOf('wt-6754-b5', click).filter((read) => read !== 'page'),
        composer: composerShown(),
      }).toEqual({
        beforeSnapshot: ['snapshot', 'list'],
        after: ['snapshot', 'list', 'list'],
        composer: true,
      });
    });

    it('reads a hovered cloud task ahead with chat reads only, opens it from them, and drops them when the pointer leaves (CAN-6774)', async () => {
      addTasks('wt-6754-a6', 'wt-6754-b6', 'wt-6754-c6', 'wt-6754-d6');
      renderPage({ prefetches: true });
      openFromSidebar('wt-6754-a6');
      await settle();
      expect(composerShown()).toBe(true);

      // The pointer rests on B's row.
      const hoverB = coreRequestLog.length;
      act(() => {
        noteChatIntent(rowIntent('wt-6754-b6'), 'pointer');
      });
      await dwell();
      expect({
        reads: readsOf('wt-6754-b6', hoverB),
        // Chat reads only: nothing that wakes a sandbox, sends or saves.
        asked: methodsFor('wt-6754-b6', hoverB),
        // A hover is not an open: nothing installed, followed or told main.
        held: storeHolds('wt-6754-b6'),
        streams: streamsFor('wt-6754-b6'),
        mainCalls: callsCarryingWebCoreIds(),
      }).toEqual({
        reads: ['snapshot', 'list', 'page'],
        asked: [
          'core.chat.snapshot.get',
          'core.chat.list',
          'core.chat.transcript.page',
        ],
        held: false,
        streams: [],
        mainCalls: [],
      });

      // The click opens B from what the hover read: nothing is read again.
      openFromSidebar('wt-6754-b6');
      await settle();
      act(() => {
        endChatIntent(rowIntent('wt-6754-b6'));
      });
      expect({
        reads: readsOf('wt-6754-b6', hoverB),
        loaded: transcriptLoaded('wt-6754-b6'),
        composer: composerShown(),
      }).toEqual({
        reads: ['snapshot', 'list', 'page'],
        loaded: true,
        composer: true,
      });

      // The pointer rests on C's row, then leaves it: the reads are dropped,
      // and opening C later reads it afresh.
      const hoverC = coreRequestLog.length;
      act(() => {
        noteChatIntent(rowIntent('wt-6754-c6'), 'pointer');
      });
      await dwell();
      act(() => {
        endChatIntent(rowIntent('wt-6754-c6'));
      });
      await settle();
      expect(storeHolds('wt-6754-c6')).toBe(false);
      openFromSidebar('wt-6754-c6');
      await settle();
      expect(readsOf('wt-6754-c6', hoverC)).toEqual([
        'snapshot',
        'list',
        'page',
        'snapshot',
        'list',
        'page',
      ]);

      // A pointer that leaves D's row before the dwell reads nothing.
      const hoverD = coreRequestLog.length;
      act(() => {
        noteChatIntent(rowIntent('wt-6754-d6'), 'pointer');
      });
      act(() => {
        endChatIntent(rowIntent('wt-6754-d6'));
      });
      await dwell();
      expect(readsOf('wt-6754-d6', hoverD)).toEqual([]);
      expect(callsCarryingWebCoreIds()).toEqual([]);
    });

    it('bounds hover read-ahead across a sidebar sweep: a fast sweep reads nothing, a slow one keeps one task in flight, and a task the store holds is never read ahead (CAN-6774)', async () => {
      const [a, b, c, d, e] = [
        'wt-6774-a7',
        'wt-6774-b7',
        'wt-6774-c7',
        'wt-6774-d7',
        'wt-6774-e7',
      ];
      addTasks(a, b, c, d, e);
      renderPage({ prefetches: true });
      openFromSidebar(a);
      await settle();
      expect(composerShown()).toBe(true);
      const since = coreRequestLog.length;
      const snapshotsOf = (task: string): number =>
        readsOf(task, since).filter((read) => read === 'snapshot').length;

      // A fast sweep over every row: no row is rested on, so nothing is read.
      for (const task of [b, c, d, e])
        act(() => {
          noteChatIntent(rowIntent(task), 'pointer');
          endChatIntent(rowIntent(task));
        });
      await dwell();
      expect([b, c, d, e].map(snapshotsOf)).toEqual([0, 0, 0, 0]);

      // A slow sweep that rests on B, C and D in turn while B's snapshot is
      // slow: only B is read while it is in flight. C, left meanwhile, is
      // never read; D, still under the pointer, is read once B settles.
      const slowB = holdSnapshotOf(b);
      const slowD = holdSnapshotOf(d);
      act(() => {
        noteChatIntent(rowIntent(b), 'pointer');
      });
      await dwell();
      act(() => {
        endChatIntent(rowIntent(b));
        noteChatIntent(rowIntent(c), 'pointer');
      });
      await dwell();
      act(() => {
        endChatIntent(rowIntent(c));
        noteChatIntent(rowIntent(d), 'pointer');
      });
      await dwell();
      const whileBInFlight = [b, c, d].map(snapshotsOf);
      slowB.serve();
      await settle();
      await dwell();
      const afterB = [b, c, d].map(snapshotsOf);
      slowD.serve();
      act(() => {
        endChatIntent(rowIntent(d));
      });
      await settle();

      // Resting on A, which the store holds, reads nothing ahead.
      const atA = coreRequestLog.length;
      act(() => {
        noteChatIntent(rowIntent(a), 'pointer');
      });
      await dwell();
      act(() => {
        endChatIntent(rowIntent(a));
      });
      expect({
        whileBInFlight,
        afterB,
        heldTask: readsOf(a, atA),
        e: snapshotsOf(e),
      }).toEqual({
        whileBInFlight: [1, 0, 0],
        afterB: [1, 0, 1],
        heldTask: [],
        e: 0,
      });
    });
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

    it('a kept deleted task the person restores from the archive comes back live, not marked Deleted (CAN-6511)', async () => {
      servesCoworkLists = true;
      await openWithDraft();
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expect(newTaskRow('wt-1')).toMatchObject({ deleted: true });

      useCloudArchivedTasksStore.setState({
        byProject: {
          'web-core:ws-1': {
            status: 'loaded',
            tasks: [
              {
                archiveId: 'work-entry:wt-1',
                revision: 2,
                worktreeId: 'wt-1',
                title: 'Brief',
                archivedAt: CREATED_AT,
                state: 'deleted',
                expiresAt: null,
              },
            ],
            restoring: [],
            restoreFailed: null,
          },
        },
      });
      await act(async () => {
        await useCloudArchivedTasksStore
          .getState()
          .restore('web-core:ws-1', 'work-entry:wt-1');
      });
      await settle();

      // Listed again, live: no row kept as deleted, and the draft stays.
      expect(newTaskRow('wt-1')).not.toMatchObject({ deleted: true });
      expect(newTaskRow('wt-1')).toBeDefined();
      expect(
        isCloudTaskDeleted({
          projectId: 'web-core:ws-1',
          worktreeId: 'web-core:wt-1',
        }),
      ).toBe(false);
      expect(useChatStore.getState().getTabDraft(OLD_CHAT)).toEqual(DRAFT);
    });

    it('restoring a task keeps a chat that was deleted on its own, with its draft, even when the task is deleted again (CAN-6511)', async () => {
      const NOTES = [
        { type: 'paragraph' as const, children: [{ text: 'Notes draft' }] },
      ];
      servesCoworkLists = true;
      useChatStore.getState().saveTabDraft('web-core:chat-2', NOTES);
      await openWithDraft();
      const scope = { projectId: 'web-core:ws-1', worktreeId: 'web-core:wt-1' };
      // A second chat is deleted on its own first, then the whole task.
      act(() => removeChatElsewhere('wt-1', 'chat-2'));
      await settle();
      expect(isCloudChatDeleted(scope, 'web-core:chat-2')).toBe(true);
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();

      useCloudArchivedTasksStore.setState({
        byProject: {
          'web-core:ws-1': {
            status: 'loaded',
            tasks: [
              {
                archiveId: 'work-entry:wt-1',
                revision: 2,
                worktreeId: 'wt-1',
                title: 'Brief',
                archivedAt: CREATED_AT,
                state: 'deleted',
                expiresAt: null,
              },
            ],
            restoring: [],
            restoreFailed: null,
          },
        },
      });
      await act(async () => {
        await useCloudArchivedTasksStore
          .getState()
          .restore('web-core:ws-1', 'work-entry:wt-1');
      });
      await settle();

      // The restore brings the task back, not the chat deleted on its own:
      // it stays kept, read-only, with its draft.
      expect(isCloudTaskDeleted(scope)).toBe(false);
      expect(isCloudChatDeleted(scope, 'web-core:chat-2')).toBe(true);
      expect(shown('panel-tab-panel-chat-web-core:chat-2')).toBe(true);
      expect(useChatStore.getState().getTabDraft('web-core:chat-2')).toEqual(
        NOTES,
      );

      // Deleted again after the restore: the kept chat is still there.
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      expect(isCloudChatDeleted(scope, 'web-core:chat-2')).toBe(true);
      expect(shown('panel-tab-panel-chat-web-core:chat-2')).toBe(true);
      expect(useChatStore.getState().getTabDraft('web-core:chat-2')).toEqual(
        NOTES,
      );
    });

    it('a kept deleted task restored from the archive follows its event stream again (CAN-6511)', async () => {
      servesCoworkLists = true;
      await openWithDraft();
      act(() => deleteTaskElsewhere('wt-1', 'tab-removed'));
      await settle();
      const taskStreams = (): OpenedStream[] =>
        [...openedStreams.values()].filter(
          (stream) =>
            stream.method === 'core.chat.events' &&
            worktreeOf(stream.params) === 'wt-1',
        );
      // Deleted elsewhere: its stream stops for good.
      expect(taskStreams()).toEqual([]);

      useCloudArchivedTasksStore.setState({
        byProject: {
          'web-core:ws-1': {
            status: 'loaded',
            tasks: [
              {
                archiveId: 'work-entry:wt-1',
                revision: 2,
                worktreeId: 'wt-1',
                title: 'Brief',
                archivedAt: CREATED_AT,
                state: 'deleted',
                expiresAt: null,
              },
            ],
            restoring: [],
            restoreFailed: null,
          },
        },
      });
      await act(async () => {
        await useCloudArchivedTasksStore
          .getState()
          .restore('web-core:ws-1', 'work-entry:wt-1');
      });
      await settle();

      // Restored: the task follows its stream again, and reads what the web
      // core commits next instead of leaving it unread.
      expect(taskStreams()).toHaveLength(1);
      act(() => removeChatElsewhere('wt-1', 'chat-2'));
      await settle();
      expect(taskStreams()).toHaveLength(1);
      expect(taskStreams()[0]?.frames).toEqual([]);
      expect(useChatStore.getState().getTabDraft(OLD_CHAT)).toEqual(DRAFT);
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
      // A failure or timeout below leaves nothing held for the next case.
      onCaseEnd(() => {
        release();
        uploadGate = null;
      });
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

  for (const [label, details, offered] of [
    ['serves only its summary row', ['summary'], false],
    ['declares no details, as an older web core', undefined, false],
    ['serves its full breakdown', ['summary', 'full'], true],
  ] as const) {
    it(`offers a cloud chat's Session breakdown only when the web core ${label} (CAN-6941)`, async () => {
      servesCost = true;
      costChatDetails = details === undefined ? undefined : [...details];
      renderPage();
      act(() => {
        openCoworkWorkEntryFromSidebar('web-core:ws-1', 'web-core:wt-1');
      });
      await settle();
      // The capability follows the manifest, which loads after first render.
      await settle();
      const capabilities = cloudScopeCapabilitiesNow();
      // Cost stays on either way: the summary row serves it.
      expect(capabilities.costInsights).toBe(true);
      expect(panelKindsUnavailableFor(capabilities)).not.toContain('cost');
      expect(capabilities.sessionBreakdown === true).toBe(offered);
      expect(
        panelKindsUnavailableFor(capabilities).includes('session-breakdown'),
      ).toBe(!offered);
      // The cost views' chat rows open the breakdown only when it's served;
      // otherwise the navigator has no action and they render static.
      expect(
        desktopCostNavigatorFor(capabilities).openSessionBreakdown !==
          undefined,
      ).toBe(offered);
    });
  }

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
    onCaseEnd(() => {
      act(() => {
        cardRoot.unmount();
      });
      host.remove();
    });
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
    onCaseEnd(() => {
      act(() => {
        cardRoot.unmount();
      });
      host.remove();
    });
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

  describe('New task starts a cloud chat in a cloud project (CAN-6757)', () => {
    const LOCAL_PROJECT = {
      id: 'local-notes',
      name: 'Local notes',
      type: 'cowork' as const,
      color: '#5b8def',
      collapsed: false,
      order: 0,
    };
    const ORG_PROJECT = {
      key: 'web-core:ws-org',
      workspaceId: 'ws-org',
      name: 'Org launch',
      kind: 'cowork' as const,
      ownerOrganizationId: 'ORG-1',
    };

    beforeEach(() => {
      useFeatureFlagsStore.setState({
        isEnabled: (key) =>
          key === CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key ||
          key === CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      });
      useWorkspaceContextStore.setState((store) => ({
        hydrated: true,
        state: { ...store.state, context: { kind: 'personal' } },
      }));
      useProjectsStore.setState({
        projects: [LOCAL_PROJECT],
        hasHydratedProjects: true,
      });
      useHomeComposerStore.getState().reset();
    });

    afterEach(() => {
      // Each case starts a window with no draft kept from another (CAN-6798).
      installHomeDraftPersistence()();
      act(() => {
        useHomeComposerStore.getState().reset();
        useHomeComposerStore.setState({
          outboxCards: [],
          sendAgainMayDuplicate: false,
        });
        useProjectsStore.setState({ projects: [] });
        useWorkspaceContextStore.setState((store) => ({
          hydrated: false,
          state: { ...store.state, context: { kind: 'personal' } },
        }));
        cloudCoworkStore.getState().disconnect('offline');
      });
    });

    function renderHome(): void {
      const client = createDesktopCanopyClient(
        createDesktopCapabilities('darwin', {}, {}),
      );
      act(() => {
        root.render(
          <CanopyClientProvider client={client}>
            <HomeSurface variant="page" />
          </CanopyClientProvider>,
        );
      });
    }

    /** The cloud online with this account's project and an organization's. */
    async function connectWithOrgProject(): Promise<void> {
      await connectCowork();
      act(() => {
        cloudCoworkStore.setState((state) => ({
          projects: [...state.projects, ORG_PROJECT],
        }));
      });
    }

    function homeOptions(): readonly string[] {
      return Array.from(
        document.querySelectorAll('[data-testid^="home-workspace-option-"]'),
        (row) =>
          (row.getAttribute('data-testid') ?? '').slice(
            'home-workspace-option-'.length,
          ),
      );
    }

    async function pickHomeProject(projectId: string): Promise<void> {
      act(() => {
        container
          .querySelector<HTMLElement>('[data-testid="home-workspace-select"]')
          ?.click();
      });
      await settle();
      act(() => {
        document
          .querySelector<HTMLElement>(
            `[data-testid="home-workspace-option-${projectId}"]`,
          )
          ?.click();
      });
      await settle();
    }

    /** The rows New task's + menu offers, by test id. */
    function homePlusRows(): readonly string[] {
      return Array.from(
        document.querySelectorAll(
          '[data-testid^="home-composer-plus-"], [data-testid^="home-plugins-"], [data-testid^="home-pipeline-"], [data-testid^="home-plan-"], [data-testid^="home-schedule-"]',
        ),
        (row) => row.getAttribute('data-testid') ?? '',
      )
        .filter(
          (id) =>
            ![
              'home-composer-plus-button',
              'home-composer-plus-menu',
              'home-composer-plus-add',
            ].includes(id),
        )
        .sort();
    }

    /** Picks files through New task's + menu, as the file picker returns them. */
    async function pickHomeFiles(files: readonly File[]): Promise<void> {
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
              '[data-testid="home-composer-plus-button"]',
            )
            ?.click();
        });
        await settle();
        act(() => {
          document
            .querySelector<HTMLElement>(
              '[data-testid="home-composer-plus-attachment"]',
            )
            ?.click();
        });
        await settle();
      } finally {
        click.mockRestore();
      }
    }

    /** The files New task holds for a cloud project, by name. */
    function homeCloudFiles(): readonly (string | null)[] {
      return Array.from(
        container.querySelectorAll(
          '[data-testid="remote-control-pending-attachments"] [data-state="staged"]',
        ),
        (chip) => chip.getAttribute('title'),
      );
    }

    function sendFromHome(text: string): void {
      act(() => {
        useHomeComposerStore.getState().setText(text);
      });
      act(() => {
        container
          .querySelector<HTMLElement>('[data-testid="home-send-button"]')
          ?.click();
      });
    }

    it("lists the context's cloud projects beside local ones, and sending starts a cloud chat there on the cloud default model", async () => {
      // This computer's default model, which a cloud chat must never take.
      initClaudeModels([{ id: 'opus[1m]', label: 'Opus' }]);
      renderHome();
      await connectWithOrgProject();
      await settle();

      // The local project and this context's cloud project; never the
      // organization's, which the sidebar shows only in its own context.
      act(() => {
        container
          .querySelector<HTMLElement>('[data-testid="home-workspace-select"]')
          ?.click();
      });
      await settle();
      expect(homeOptions()).toEqual(['local-notes', 'web-core:ws-1']);
      act(() => {
        document
          .querySelector<HTMLElement>(
            '[data-testid="home-workspace-option-web-core:ws-1"]',
          )
          ?.click();
      });
      await settle();
      expect(
        container.querySelector('[data-testid="home-workspace-select"]')
          ?.textContent,
      ).toContain('Cloud research');

      // The controls only this computer serves are gone, not disabled.
      for (const control of [
        'home-branch-picker-see-more',
        'home-thinking-level-button',
      ])
        expect(shown(control)).toBe(false);
      // + offers only files, which go to the new task's chat (CAN-6763).
      act(() => {
        container
          .querySelector<HTMLElement>(
            '[data-testid="home-composer-plus-button"]',
          )
          ?.click();
      });
      await settle();
      expect(homePlusRows()).toEqual(['home-composer-plus-attachment']);
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      await settle();
      expect(
        container.querySelector('button[aria-label^="Select model"]'),
      ).toBeNull();
      expect(shown('home-send-button')).toBe(true);

      sendFromHome('Plan the launch');
      await settle();

      // A new task in the cloud project, and the message sent to its chat.
      const taskId = createdChatIds.at(-1) ?? '';
      expect(taskId).not.toBe('');
      const creates = coreRequestLog.filter(
        (entry) =>
          entry.method === 'core.chat.create' &&
          worktreeOf(entry.params) === taskId,
      );
      expect(creates).toHaveLength(1);
      expect(JSON.stringify(creates[0]?.params)).toContain('"ws-1"');
      expect(sendsTo(taskId)).toBe(1);
      const sent = coreRequestLog.find(
        (entry) =>
          entry.method === 'core.chat.message.send' &&
          entry.params.chatId === taskId,
      );
      expect(JSON.stringify(sent?.params)).toContain('Plan the launch');
      // The web core's default model: nothing names this computer's.
      expect(JSON.stringify(coreRequestLog)).not.toContain('opus[1m]');
      expect(
        useChatStore
          .getState()
          .worktreeChats[
            `web-core:ws-1/web-core:${taskId}`
          ]?.tabs.map((tab) => tab.model),
      ).toEqual([undefined]);
      // Nothing about the cloud project reached this computer's bridge.
      expect(callsCarryingWebCoreIds()).toEqual([]);
      // Home's draft went with the message.
      expect(useHomeComposerStore.getState().text).toBe('');
      initClaudeModels([]);
    });

    it('shows no local link destination for a cloud project, so a pasted link goes where the picker shows', async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();

      // With the local project selected, the link proposes a destination,
      // which shows this check can see one.
      const draft = 'Review https://github.com/acme/rocket please';
      act(() => {
        useHomeComposerStore.getState().setText(draft);
      });
      await settle();
      expect(useHomeComposerStore.getState().linkTarget.status).not.toBe(
        'idle',
      );

      // Picking a cloud project drops it, and typing the link again proposes
      // nothing: the picker still names the cloud project, and no link chip
      // offers a local one.
      await pickHomeProject('web-core:ws-1');
      act(() => {
        useHomeComposerStore.getState().setText(`${draft} `);
      });
      await settle();
      expect(useHomeComposerStore.getState().linkTarget.status).toBe('idle');
      expect(shown('home-link-target')).toBe(false);
      expect(
        container.querySelector('[data-testid="home-workspace-select"]')
          ?.textContent,
      ).toContain('Cloud research');

      act(() => {
        container
          .querySelector<HTMLElement>('[data-testid="home-send-button"]')
          ?.click();
      });
      await settle();
      const taskId = createdChatIds.at(-1) ?? '';
      expect(taskId).not.toBe('');
      const create = coreRequestLog.find(
        (entry) =>
          entry.method === 'core.chat.create' &&
          worktreeOf(entry.params) === taskId,
      );
      expect(JSON.stringify(create?.params)).toContain('"ws-1"');
      const sent = coreRequestLog.find(
        (entry) =>
          entry.method === 'core.chat.message.send' &&
          entry.params.chatId === taskId,
      );
      expect(JSON.stringify(sent?.params)).toContain('github.com/acme/rocket');
      expect(callsCarryingWebCoreIds()).toEqual([]);
    });

    it("lists an organization's cloud project in its context, and drops a selection the context doesn't hold", async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      expect(useHomeComposerStore.getState().workspaceId).toBe('web-core:ws-1');

      act(() => {
        useWorkspaceContextStore.setState((store) => ({
          state: {
            ...store.state,
            context: { kind: 'organization', organizationId: 'org-1' },
          },
        }));
      });
      await settle();
      // The Personal cloud project no longer stays chosen.
      expect(useHomeComposerStore.getState().workspaceId).not.toBe(
        'web-core:ws-1',
      );
      act(() => {
        container
          .querySelector<HTMLElement>('[data-testid="home-workspace-select"]')
          ?.click();
      });
      await settle();
      // CAN-7038 adds the context's projectless destination above its projects.
      expect(homeOptions()).toEqual(['no-project', 'web-core:ws-org']);
      expect(callsCarryingWebCoreIds()).toEqual([]);
    });

    it('keeps the draft in New task and says why when the cloud goes offline or the project goes before the send', async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      // Home says why under its composer, as for any send it refuses.
      const errorText = (): string =>
        container.querySelector('[data-testid="home-composer-error"]')
          ?.textContent ?? '';

      // Offline between picking and sending: refused, with the cloud's own
      // words, and nothing created.
      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
      await settle();
      sendFromHome('Keep this draft');
      await settle();
      expect(errorText()).toContain('Cloud chats are offline.');
      expect(useHomeComposerStore.getState().text).toBe('Keep this draft');
      expect(useHomeComposerStore.getState().workspaceId).toBe('web-core:ws-1');
      expect(
        coreRequestLog.filter((entry) => entry.method === 'core.chat.create'),
      ).toEqual([]);

      // Back online, and then the project is removed on another device while
      // the draft waits: the selection and the draft stay until a send says
      // why, never handed to a local project.
      await connectWithOrgProject();
      await settle();
      expect(useHomeComposerStore.getState().workspaceId).toBe('web-core:ws-1');
      act(() => {
        cloudCoworkStore.setState((state) => ({
          projects: state.projects.filter(
            (project) => project.workspaceId !== 'ws-1',
          ),
        }));
      });
      await settle();
      expect(useHomeComposerStore.getState().workspaceId).toBe('web-core:ws-1');
      expect(useHomeComposerStore.getState().text).toBe('Keep this draft');
      sendFromHome('Keep this draft');
      await settle();
      expect(errorText()).toContain(
        "That cloud project isn't available any more.",
      );
      expect(useHomeComposerStore.getState().text).toBe('Keep this draft');
      expect(
        coreRequestLog.filter((entry) => entry.method === 'core.chat.create'),
      ).toEqual([]);
      expect(callsCarryingWebCoreIds()).toEqual([]);
    });

    it('never records a New task send to a cloud project as a task to repeat, nor offers it as an automation', async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();
      const remembered = new Map<string, string>();
      const storage = {
        getItem: (key: string): string | null => remembered.get(key) ?? null,
        setItem: (key: string, value: string): void => {
          remembered.set(key, value);
        },
        removeItem: (key: string): void => {
          remembered.delete(key);
        },
      };
      const deps = {
        now: (): number => 1_000,
        loadAccountKey: (): Promise<string> => Promise.resolve('account-1'),
        loadSuggestionsEnabled: (): Promise<boolean> => Promise.resolve(true),
        storage,
      };
      const prompt = 'Summarise the weekly launch notes for the team';
      act(() => {
        useHomeComposerStore.getState().setText(prompt);
      });

      // A local project's task is remembered, so the check below can see one.
      const local = snapshotHomeTask('page');
      expect(local.workspaceId).toBe('local-notes');
      await act(() => maybeOfferRepeatTaskAutomation(local, deps));
      expect(remembered.get(REPEAT_TASK_HISTORY_STORAGE_KEY)).toContain(
        'local-notes',
      );
      remembered.clear();

      // A cloud project's is not, however often it repeats: an automation
      // made from it would start a local chat in a project no IPC resolves.
      await pickHomeProject('web-core:ws-1');
      act(() => {
        useHomeComposerStore.getState().setText(prompt);
      });
      const cloud = snapshotHomeTask('page');
      expect(cloud.workspaceId).toBe('web-core:ws-1');
      for (let send = 0; send < 3; send += 1)
        await act(() => maybeOfferRepeatTaskAutomation(cloud, deps));
      expect(remembered.get(REPEAT_TASK_HISTORY_STORAGE_KEY)).toBeUndefined();
      expect(useRepeatTaskOfferStore.getState().offer).toBeNull();
    });

    function renderHomeBesidePage(): void {
      const client = createDesktopCanopyClient(
        createDesktopCapabilities('darwin', {}, {}),
      );
      // New task beside the page it opens, as the window shows them.
      act(() => {
        root.render(
          <CanopyClientProvider client={client}>
            <HomeSurface variant="page" />
            <StandaloneChatPage />
          </CanopyClientProvider>,
        );
      });
    }

    it('shows a first message the web core refuses, once the new task exists, as not sent, with the reason, and back in the composer', async () => {
      renderHomeBesidePage();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      sendRefusal = 'The cloud sandbox is waking up. Try again in a moment.';

      sendFromHome('Plan the launch');
      await settle();

      const taskId = createdChatIds.at(-1) ?? '';
      // The task exists, and the web core was asked once, and refused.
      expect(
        coreRequestLog.filter(
          (entry) =>
            entry.method === 'core.chat.create' &&
            worktreeOf(entry.params) === taskId,
        ),
      ).toHaveLength(1);
      expect(sendsTo(taskId)).toBe(1);
      // Nothing reads as sent: no user message, and no failure under one.
      const tab = useChatStore
        .getState()
        .worktreeChats[
          `web-core:ws-1/web-core:${taskId}`
        ]?.tabs.find((entry) => entry.id === `web-core:${taskId}`);
      expect(
        (tab?.messages ?? []).filter((message) =>
          message.blocks.some(
            (block) =>
              block.type === 'text' && block.text.includes('Plan the launch'),
          ),
        ),
      ).toEqual([]);
      // The composer has it back, once, and says why it wasn't sent.
      expect(
        container.querySelector(
          '[data-testid="chat-panel"] [data-chat-textarea]',
        )?.textContent,
      ).toBe('Plan the launch');
      expect(
        container.querySelector('[data-testid="chat-input-send-refused"]')
          ?.textContent,
      ).toContain(
        "Your message wasn't sent: The cloud sandbox is waking up. Try again in a moment.",
      );
      expect(callsCarryingWebCoreIds()).toEqual([]);
      // Its chat's composer holds it: the outbox lets it go (CAN-6798).
      expect(outboxIds()).toEqual([]);
    });

    it('holds a file pasted into New task for a cloud project until Send, sending this computer nothing (CAN-6763)', async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const editor = container.querySelector<HTMLElement>(
        '[data-testid="home-composer-editor"]',
      );
      expect(editor).not.toBeNull();
      const file = new File(['png'], 'shot.png', { type: 'image/png' });
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', {
        value: {
          items: [
            { kind: 'file', type: 'image/png', getAsFile: (): File => file },
          ],
          files: [file],
          types: ['Files'],
          getData: (): string => '',
        },
      });
      // jsdom has no isContentEditable, which the editor reads to take a paste.
      const editable = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'isContentEditable',
      );
      Object.defineProperty(HTMLElement.prototype, 'isContentEditable', {
        configurable: true,
        get(this: HTMLElement): boolean {
          return this.closest('[contenteditable="true"]') !== null;
        },
      });
      onCaseEnd(() => {
        if (editable === undefined)
          Reflect.deleteProperty(HTMLElement.prototype, 'isContentEditable');
        else
          Object.defineProperty(
            HTMLElement.prototype,
            'isContentEditable',
            editable,
          );
      });
      try {
        act(() => {
          editor?.dispatchEvent(paste);
        });
      } finally {
        if (editable === undefined)
          Reflect.deleteProperty(HTMLElement.prototype, 'isContentEditable');
        else
          Object.defineProperty(
            HTMLElement.prototype,
            'isContentEditable',
            editable,
          );
      }
      expect(paste.defaultPrevented).toBe(true);
      await settle();
      // No local staging was asked to take the cloud project's id, and
      // nothing uploads before Send.
      expect(callsCarryingWebCoreIds()).toEqual([]);
      expect(calls.filter((call) => call.path === CLOUD_UPLOAD)).toEqual([]);
      expect(useHomeComposerStore.getState().attachments).toEqual([]);
      expect(homeCloudFiles()).toEqual(['shot.png']);
      expect(shown('home-composer-error')).toBe(false);
    });

    /** The web core advertises the account-bound send, read afresh (CAN-6828). */
    async function bindSendsToTheAccount(): Promise<void> {
      advertisesSendBinding = true;
      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
      await connectWithOrgProject();
      await settle();
    }

    const sendsOf = (
      taskId: string,
    ): { text: unknown; expectedPrincipalId: unknown; revision: unknown }[] =>
      coreRequestLog
        .filter(
          (entry) =>
            entry.method === 'core.chat.message.send' &&
            entry.params.chatId === taskId,
        )
        .map((entry) => ({
          text: entry.params.text,
          expectedPrincipalId: entry.params.expectedPrincipalId,
          revision: entry.params.revision,
        }));

    /**
     * New task's message, with the create held, and a follow-up typed in the
     * new chat meanwhile. Answers the new task's id and its chat.
     */
    async function newTaskWithFollowUp(): Promise<{
      readonly taskId: string;
      readonly create: () => void;
    }> {
      await pickHomeProject('web-core:ws-1');
      let create = (): void => undefined;
      createGate = new Promise<void>((resolve) => {
        create = resolve;
      });
      sendFromHome('Plan the launch');
      await settle();
      const taskId = createdChatIds.at(-1) ?? '';
      expect(taskId).not.toBe('');
      act(() => {
        void useChatStore.getState().sendMessage('And a follow-up', undefined, {
          projectId: 'web-core:ws-1',
          worktreeId: `web-core:${taskId}`,
          chatId: `web-core:${taskId}`,
        });
      });
      await settle();
      // Nothing posts to a task the web core hasn't created.
      expect(sendsOf(taskId)).toEqual([]);
      return {
        taskId,
        create: (): void => {
          createGate = null;
          create();
        },
      };
    }

    it("binds New task's first message to its account, shows it at once, and sends a follow-up typed during the create after it (CAN-6828)", async () => {
      renderHome();
      await bindSendsToTheAccount();
      const { taskId, create } = await newTaskWithFollowUp();
      // Shown in the new chat at once, while the web core creates the task.
      expect(
        useChatStore
          .getState()
          .worktreeChats[`web-core:ws-1/web-core:${taskId}`]?.tabs.find(
            (tab) => tab.id === `web-core:${taskId}`,
          )
          ?.messages.filter((message) => message.role === 'user')
          .map((message) => message.blocks)[0],
      ).toEqual([{ type: 'text', text: 'Plan the launch' }]);
      create();
      await settle();
      // In the order they were pressed, both bound to the account.
      expect(sendsOf(taskId)).toEqual([
        { text: 'Plan the launch', expectedPrincipalId: 'u-1', revision: 3 },
        { text: 'And a follow-up', expectedPrincipalId: 'u-1', revision: 3 },
      ]);
      expect(callsCarryingWebCoreIds()).toEqual([]);
    });

    it("sends a follow-up typed during the create after New task's first message against a web core that can't bind a send (CAN-6828)", async () => {
      renderHome();
      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
      await connectWithOrgProject();
      await settle();
      const { taskId, create } = await newTaskWithFollowUp();
      create();
      await settle();
      // New task's place was taken on the click, before the follow-up's.
      expect(sendsOf(taskId).map((send) => send.text)).toEqual([
        'Plan the launch',
        'And a follow-up',
      ]);
    });

    it("lets a follow-up typed during the create through when the web core refuses New task's first message (CAN-6828)", async () => {
      renderHome();
      await bindSendsToTheAccount();
      refusedSendText = 'Plan the launch';
      const { taskId, create } = await newTaskWithFollowUp();
      create();
      await settle();
      // The refused message settles its place; the follow-up still posts.
      expect(sendsOf(taskId).map((send) => send.text)).toEqual([
        'Plan the launch',
        'And a follow-up',
      ]);
    });

    it("sends nothing for the earlier account and restores nothing when the web core refuses New task's first message as another account's (CAN-6828)", async () => {
      renderHome();
      await bindSendsToTheAccount();
      await pickHomeProject('web-core:ws-1');
      let create = (): void => undefined;
      createGate = new Promise<void>((resolve) => {
        create = resolve;
      });
      sendFromHome('Earlier account prompt');
      await settle();
      const taskId = createdChatIds.at(-1) ?? '';
      expect(taskId).not.toBe('');
      // The desktop switches account while the task is created: the web core
      // now serves another account.
      servedPrincipal = 'u-2';
      act(() => {
        useWorkspaceContextStore.setState((store) => ({
          accountEpoch: store.accountEpoch + 1,
        }));
      });
      createGate = null;
      create();
      await settle();
      // Refused as another account's: nothing posted, nothing put back.
      expect(sendsOf(taskId)).toEqual([
        {
          text: 'Earlier account prompt',
          expectedPrincipalId: 'u-1',
          revision: 3,
        },
      ]);
      const tab = useChatStore
        .getState()
        .worktreeChats[
          `web-core:ws-1/web-core:${taskId}`
        ]?.tabs.find((entry) => entry.id === `web-core:${taskId}`);
      expect(
        tab?.messages.some((message) =>
          JSON.stringify(message.blocks).includes('Earlier account prompt'),
        ),
      ).toBe(false);
      expect(
        serializeEditorValue(
          useChatStore.getState().getTabDraft(`web-core:${taskId}`) ?? [],
        ).text,
      ).not.toContain('Earlier account prompt');
    });

    it("waits for the create and sends unbound against a web core that can't bind a send to its account (CAN-6828)", async () => {
      renderHome();
      // Described, but without the account-bound send.
      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      let create = (): void => undefined;
      createGate = new Promise<void>((resolve) => {
        create = resolve;
      });
      sendFromHome('Plan the launch');
      await settle();
      const taskId = createdChatIds.at(-1) ?? '';
      // As before: New task keeps the message until the created chat takes it.
      // New task holds it as a read-only sending entry in its outbox
      // (CAN-6798), not in its editor.
      expect(
        useHomeComposerStore
          .getState()
          .outboxCards.filter((card) => card.state === 'sending')
          .map((card) => card.entry.text),
      ).toEqual(['Plan the launch']);
      createGate = null;
      create();
      await settle();
      expect(sendsOf(taskId)).toEqual([
        {
          text: 'Plan the launch',
          expectedPrincipalId: undefined,
          revision: undefined,
        },
      ]);
    });

    /** New task against a connection it couldn't bind: #9332's wait, then an unbound send. */
    async function expectUnboundNewTaskSend(): Promise<void> {
      await pickHomeProject('web-core:ws-1');
      let create = (): void => undefined;
      createGate = new Promise<void>((resolve) => {
        create = resolve;
      });
      sendFromHome('Plan the launch');
      await settle();
      const taskId = createdChatIds.at(-1) ?? '';
      expect(taskId).not.toBe('');
      // New task holds it as a read-only sending entry in its outbox
      // (CAN-6798), not in its editor.
      expect(
        useHomeComposerStore
          .getState()
          .outboxCards.filter((card) => card.state === 'sending')
          .map((card) => card.entry.text),
      ).toEqual(['Plan the launch']);
      createGate = null;
      create();
      await settle();
      expect(sendsOf(taskId)).toEqual([
        {
          text: 'Plan the launch',
          expectedPrincipalId: undefined,
          revision: undefined,
        },
      ]);
    }

    it("waits for the create and sends unbound when the relay can't describe the connection (CAN-6828)", async () => {
      renderHome();
      describeReply = 'failed';
      await bindSendsToTheAccount();
      await expectUnboundNewTaskSend();
    });

    for (const [reply, account] of [
      ['noPrincipal', 'no account'],
      ['emptyPrincipal', 'an empty account'],
    ] as const) {
      it(`waits for the create and sends unbound when the connection is described with ${account} (CAN-6828)`, async () => {
        renderHome();
        describeReply = reply;
        await bindSendsToTheAccount();
        await expectUnboundNewTaskSend();
      });
    }

    it('keeps the draft in New task until the new cloud chat takes its first message', async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      // The web core is slow to create the task.
      let create = (): void => undefined;
      createGate = new Promise<void>((resolve) => {
        create = resolve;
      });
      sendFromHome('Plan the launch');
      await settle();
      const taskId = createdChatIds.at(-1) ?? '';
      expect(taskId).not.toBe('');
      // Until the message is sent, Home still holds it, and a second send
      // can't start another task.
      expect(sendsTo(taskId)).toBe(0);
      // New task holds it as a read-only sending entry in its outbox
      // (CAN-6798), not in its editor.
      expect(
        useHomeComposerStore
          .getState()
          .outboxCards.filter((card) => card.state === 'sending')
          .map((card) => card.entry.text),
      ).toEqual(['Plan the launch']);
      act(() => {
        container
          .querySelector<HTMLElement>('[data-testid="home-send-button"]')
          ?.click();
      });
      await settle();
      expect(
        coreRequestLog.filter((entry) => entry.method === 'core.chat.create'),
      ).toHaveLength(1);

      createGate = null;
      create();
      await settle();
      // Sent once, and only then does Home let it go.
      expect(sendsTo(taskId)).toBe(1);
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(useHomeComposerStore.getState().outboxCards).toEqual([]);
      expect(callsCarryingWebCoreIds()).toEqual([]);
    });

    it('sends nothing and restores nothing when the account changes while the new cloud chat opens', async () => {
      const switchAccount = (): void => {
        act(() => {
          useWorkspaceContextStore.setState((store) => ({
            accountEpoch: store.accountEpoch + 1,
          }));
        });
      };
      const draftOf = (taskId: string): string =>
        serializeEditorValue(
          useChatStore.getState().getTabDraft(`web-core:${taskId}`) ?? [],
        ).text;
      renderHome();
      await connectWithOrgProject();
      await settle();

      // Created after the account changed: the earlier account's prompt is
      // never sent.
      await pickHomeProject('web-core:ws-1');
      let create = (): void => undefined;
      createGate = new Promise<void>((resolve) => {
        create = resolve;
      });
      sendFromHome('Earlier account prompt');
      await settle();
      const sentTask = createdChatIds.at(-1) ?? '';
      expect(sentTask).not.toBe('');
      switchAccount();
      createGate = null;
      create();
      await settle();
      expect(sendsTo(sentTask)).toBe(0);
      expect(draftOf(sentTask)).not.toContain('Earlier account prompt');

      // Refused after the account changed: the prompt isn't put back into any
      // composer either.
      act(() => {
        useHomeComposerStore.getState().reset();
      });
      await pickHomeProject('web-core:ws-1');
      createRefusal = 'This project is full.';
      let refuse = (): void => undefined;
      createGate = new Promise<void>((resolve) => {
        refuse = resolve;
      });
      sendFromHome('Another earlier prompt');
      await settle();
      const refusedTask = createdChatIds.at(-1) ?? '';
      expect(refusedTask).not.toBe(sentTask);
      switchAccount();
      createGate = null;
      refuse();
      await settle();
      expect(draftOf(refusedTask)).not.toContain('Another earlier prompt');
      expect(callsCarryingWebCoreIds()).toEqual([]);
    });

    it('keeps both the refused first message and a draft typed in the new chat meanwhile', async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      // The web core refuses the new task, but only after a while.
      createRefusal = 'This project is full.';
      let refuse = (): void => undefined;
      createGate = new Promise<void>((resolve) => {
        refuse = resolve;
      });
      sendFromHome('Plan the launch');
      await settle();
      const taskId = createdChatIds.at(-1) ?? '';
      expect(taskId).not.toBe('');
      // Meanwhile the person typed in the new chat, whose composer saved it
      // and closed.
      act(() => {
        useChatStore
          .getState()
          .saveTabDraft(`web-core:${taskId}`, [
            { type: 'paragraph', children: [{ text: 'Follow-up note' }] },
          ]);
      });
      createGate = null;
      refuse();
      await settle();
      // Neither is lost.
      const draft = serializeEditorValue(
        useChatStore.getState().getTabDraft(`web-core:${taskId}`) ?? [],
      ).text;
      expect(draft).toContain('Plan the launch');
      expect(draft).toContain('Follow-up note');
    });

    it("refuses to stage a file for a cloud project through this computer's attachment import, and still stages a local project's", async () => {
      // Every New task attach path (+ menu, paste, /attach, Linear) imports
      // through it; a cloud project has no local folder.
      await expect(
        importChatAttachments(
          { projectId: 'web-core:ws-1', worktreeId: 'home' },
          ['/Users/me/shot.png'],
        ),
      ).rejects.toThrow();
      expect(callsCarryingWebCoreIds()).toEqual([]);

      // A local project's file still stages through this computer.
      void importChatAttachments(
        { projectId: 'local-notes', worktreeId: 'home' },
        ['/Users/me/notes.md'],
      ).catch(() => undefined);
      await settle();
      expect(
        calls
          .filter(
            (call) => call.path === 'api.workspaceItems.importAttachments',
          )
          .map((call) => call.args),
      ).toEqual([
        [
          {
            projectId: 'local-notes',
            worktreeId: 'home',
            filePaths: ['/Users/me/notes.md'],
            clipboardItems: undefined,
          },
        ],
      ]);
    });

    it("sends New task's first message to a cloud project with the files picked for it (CAN-6763)", async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      await pickHomeFiles([
        new File(['# Brief'], 'brief.md', { type: 'text/markdown' }),
        new File(['{}'], 'notes.json', { type: 'application/json' }),
      ]);
      expect(homeCloudFiles()).toEqual(['brief.md', 'notes.json']);
      // Held until Send: nothing uploads and nothing reaches this computer.
      expect(calls.filter((call) => call.path === CLOUD_UPLOAD)).toEqual([]);
      expect(callsCarryingWebCoreIds()).toEqual([]);

      sendFromHome('Plan the launch');
      await settle();

      const taskId = createdChatIds.at(-1) ?? '';
      expect(taskId).not.toBe('');
      expect(
        calls
          .filter((call) => call.path === CLOUD_UPLOAD)
          .map((call): unknown[] => [
            Reflect.get(Object(call.args[0]), 'worktreeId'),
            Reflect.get(Object(call.args[1]), 'name'),
          ]),
      ).toEqual([
        [taskId, 'brief.md'],
        [taskId, 'notes.json'],
      ]);
      const sent = coreRequestLog.filter(
        (entry) =>
          entry.method === 'core.chat.message.send' &&
          entry.params.chatId === taskId,
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]?.params.text).toBe('Plan the launch');
      expect(sent[0]?.params.attachments).toEqual([
        { attachmentId: 'att-brief.md' },
        { attachmentId: 'att-notes.json' },
      ]);
      expect(callsCarryingWebCoreIds()).toEqual([]);
      // Home's draft, files and all, went with the message.
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(useHomeComposerStore.getState().cloudFiles).toEqual([]);
    });

    it('refuses a file the web core would refuse when it is picked for a cloud project in New task, before reading it (CAN-6763)', async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const oversized = new File(['x'], 'huge.pdf', {
        type: 'application/pdf',
      });
      const readOversized = jest.fn(() => Promise.resolve(new ArrayBuffer(1)));
      Object.defineProperties(oversized, {
        size: { value: CLOUD_ATTACHMENT_MAX_BYTES + 1 },
        arrayBuffer: { value: readOversized },
      });
      await pickHomeFiles([
        oversized,
        new File(['# Brief'], 'brief.md', { type: 'text/markdown' }),
      ]);
      expect(homeCloudFiles()).toEqual(['brief.md']);
      expect(readOversized).not.toHaveBeenCalled();
      // New task says why, in the web composer's words.
      expect(
        container.querySelector('[data-testid="home-composer-error"]')
          ?.textContent,
      ).toContain('huge.pdf: Attachment is too large');
    });

    it("posts nothing when a file picked in New task doesn't upload, and leaves the message and the uploaded file in the new chat's composer (CAN-6763)", async () => {
      renderHomeBesidePage();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      // The web core refuses full.md's upload.
      await pickHomeFiles([
        new File(['# Brief'], 'brief.md', { type: 'text/markdown' }),
        new File(['# Full'], 'full.md', { type: 'text/markdown' }),
      ]);
      expect(homeCloudFiles()).toEqual(['brief.md', 'full.md']);

      sendFromHome('Plan the launch');
      await settle();

      const taskId = createdChatIds.at(-1) ?? '';
      expect(taskId).not.toBe('');
      const target = {
        projectId: 'web-core:ws-1',
        worktreeId: `web-core:${taskId}`,
        chatId: `web-core:${taskId}`,
      };
      // Nothing posted without the refused file.
      expect(sendsTo(taskId)).toBe(0);
      // The new chat's composer holds the message and the file that uploaded,
      // and names the one that didn't.
      expect(
        container.querySelector(
          '[data-testid="chat-panel"] [data-chat-textarea]',
        )?.textContent,
      ).toContain('Plan the launch');
      expect(
        useChatStore
          .getState()
          .worktreeChats[`${target.projectId}/${target.worktreeId}`]?.tabs.find(
            (tab) => tab.id === target.chatId,
          )
          ?.pendingAttachments?.map((attachment) => attachment.filename),
      ).toEqual(['brief.md']);
      const notice = container.querySelector(
        '[data-testid="chat-input-files-not-attached"]',
      )?.textContent;
      expect(notice).toContain('full.md');
      expect(notice).not.toContain('brief.md');
      // Home's draft moved to the new chat.
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(useHomeComposerStore.getState().cloudFiles).toEqual([]);
      expect(callsCarryingWebCoreIds()).toEqual([]);

      // The dropped send holds up no later one in that chat.
      act(() => {
        void useChatStore
          .getState()
          .sendMessage('Without the full one', undefined, target);
      });
      await settle();
      expect(sendsTo(taskId)).toBe(1);
      // Its chat's composer holds it: the outbox lets it go (CAN-6798).
      expect(outboxIds()).toEqual([]);
    });

    it("uploads none of New task's files for a cloud project once the account changes before the task exists (CAN-6763)", async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      await pickHomeFiles([
        new File(['# Brief'], 'brief.md', { type: 'text/markdown' }),
      ]);
      let create = (): void => undefined;
      createGate = new Promise<void>((resolve) => {
        create = resolve;
      });
      sendFromHome('Earlier account prompt');
      await settle();
      const taskId = createdChatIds.at(-1) ?? '';
      expect(taskId).not.toBe('');
      act(() => {
        useWorkspaceContextStore.setState((store) => ({
          accountEpoch: store.accountEpoch + 1,
        }));
      });
      createGate = null;
      create();
      await settle();
      // Nothing goes up under the account that replaced it, and nothing posts.
      expect(calls.filter((call) => call.path === CLOUD_UPLOAD)).toEqual([]);
      expect(sendsTo(taskId)).toBe(0);
    });

    /**
     * Reloads the window as New task sees it (CAN-6798): the page hides, its
     * draft store starts empty, and New task mounts again.
     */
    async function reloadHome(render: () => void): Promise<void> {
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      act(() => {
        root.render(<></>);
      });
      installHomeDraftPersistence()();
      // The renderer's in-memory send order goes with it.
      resetCloudSendOrder();
      act(() => {
        useHomeComposerStore.getState().reset();
        useHomeComposerStore.setState({
          outboxCards: [],
          sendAgainMayDuplicate: false,
        });
      });
      render();
      await settle();
    }

    /** The command ids the web core was sent for a task's chat, in order. */
    const sendCommandsTo = (taskId: string): unknown[] =>
      coreRequestLog
        .filter(
          (entry) =>
            entry.method === 'core.chat.message.send' &&
            entry.params.chatId === taskId,
        )
        .map((entry) => entry.params.commandId);

    const noticeText = (testId: string): string | null | undefined =>
      container.querySelector(`[data-testid="${testId}"]`)?.textContent;

    /** New task's first message, held at the web core until `release`. */
    async function sendHeldFromHome(text: string): Promise<{
      readonly taskId: string;
      readonly release: () => void;
    }> {
      let release = (): void => undefined;
      sendGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      sendFromHome(text);
      await settle();
      const taskId = createdChatIds.at(-1) ?? '';
      expect(taskId).not.toBe('');
      expect(sendCommandsTo(taskId)).toHaveLength(1);
      return {
        taskId,
        release: (): void => {
          sendGate = null;
          release();
        },
      };
    }

    const OUTBOX_KEY = 'canopy:home-draft:v1:account:account-1';

    /** What New task's record holds now, as an earlier run would leave it. */
    const savedRecord = (): Record<string, unknown> => {
      const raw = window.localStorage.getItem(OUTBOX_KEY);
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
    };

    /** The ids of the messages New task's outbox holds. */
    const outboxIds = (): unknown[] => {
      const outbox: unknown = savedRecord().outbox;
      return Array.isArray(outbox)
        ? outbox.map((entry: unknown): unknown => {
            if (typeof entry !== 'object' || entry === null) return undefined;
            const id: unknown = Reflect.get(entry, 'id');
            return id;
          })
        : [];
    };

    /** Leaves a record as an earlier run would, before New task mounts. */
    const plantRecord = (record: {
      readonly draft?: unknown;
      readonly outbox?: readonly unknown[];
      readonly kept?: readonly unknown[];
    }): void => {
      window.localStorage.setItem(
        OUTBOX_KEY,
        JSON.stringify({ version: 1, owner: 'account:account-1', ...record }),
      );
    };

    /** A cloud message an earlier run dispatched to a task's chat. */
    const cloudEntry = (
      commandId: string,
      taskId: string,
      text: string,
      cloudFileNames: readonly string[] = [],
    ): unknown => ({
      id: commandId,
      userMessageId: `msg-${commandId}`,
      workspaceId: 'web-core:ws-1',
      destination: {
        projectId: 'web-core:ws-1',
        worktreeId: `web-core:${taskId}`,
        chatId: `web-core:${taskId}`,
      },
      text,
      fileReferences: [],
      attachments: [],
      cloudFileNames,
    });

    const cardStates = (): string[] =>
      useHomeComposerStore.getState().outboxCards.map((card) => card.state);

    const click = (testId: string): void => {
      act(() => {
        container
          .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
          ?.click();
      });
    };

    /** A task the web core lists, from a first message it took. */
    async function startTask(text: string): Promise<string> {
      sendFromHome(text);
      await settle();
      const taskId = createdChatIds.at(-1) ?? '';
      expect(taskId).not.toBe('');
      return taskId;
    }

    it('keeps an unsent New task draft for a cloud project across a reload, naming its files to attach again (CAN-6798)', async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      await pickHomeFiles([
        new File(['# Brief'], 'brief.md', { type: 'text/markdown' }),
      ]);
      act(() => {
        useHomeComposerStore.getState().setText('Plan the launch');
      });

      await reloadHome(renderHome);

      expect(useHomeComposerStore.getState().text).toBe('Plan the launch');
      expect(useHomeComposerStore.getState().workspaceId).toBe('web-core:ws-1');
      // The file's bytes weren't kept: the person attaches it again.
      expect(useHomeComposerStore.getState().cloudFiles).toEqual([]);
      expect(noticeText('home-draft-restored')).toContain('Your draft is back');
      expect(noticeText('home-draft-restored')).toContain('brief.md');
      expect(
        coreRequestLog.filter(
          (entry) => entry.method === 'core.chat.message.send',
        ),
      ).toEqual([]);
    });

    it("brings nothing back after a reload when the web core took New task's first message before the window heard, and says it was sent (CAN-6798)", async () => {
      servesSendReceipts = true;
      appliesBeforeReply = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const { release } = await sendHeldFromHome('Plan the launch');
      expect(appliedSends.map((sent) => sent.text)).toEqual([
        'Plan the launch',
      ]);
      // Dispatched, it's the outbox's: never a draft of its own.
      expect(savedRecord().draft).toBeUndefined();
      expect(outboxIds()).toHaveLength(1);

      await reloadHome(renderHome);

      // Taken: it isn't shown again, so it can't be sent twice.
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(noticeText('home-outbox-sent')).toContain(
        'Your earlier message was sent',
      );
      expect(outboxIds()).toEqual([]);
      release();
      await settle();
      expect(appliedSends).toHaveLength(1);
      // Nor after the cloud goes offline and comes back.
      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
      await connectWithOrgProject();
      await settle();
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(shown('home-outbox-missing')).toBe(false);
    });

    it("never brings one account's New task draft into another's when the account changes while its read is held (CAN-6798)", async () => {
      const recordOf = (accountId: string): unknown => {
        const raw = window.localStorage.getItem(
          `canopy:home-draft:v1:account:${accountId}`,
        );
        return raw === null ? null : JSON.parse(raw);
      };
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      act(() => {
        useHomeComposerStore.getState().setText('Account A plan');
      });
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(JSON.stringify(recordOf('account-1'))).toContain('Account A plan');

      // The window reloads with account A's read held, and the account
      // changes to B before it answers. A's answer comes while B's read is
      // still out.
      const holdRead = (): (() => void) => {
        let release = (): void => undefined;
        accountGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        return release;
      };
      const releaseA = holdRead();
      await reloadHome(renderHome);
      const releaseB = holdRead();
      savedAccountId = 'account-2';
      act(() => {
        useWorkspaceContextStore.setState((store) => ({
          accountEpoch: store.accountEpoch + 1,
        }));
      });
      await settle();
      accountGate = null;
      releaseA();
      await settle();
      releaseB();
      await settle();

      // Nothing from A reaches B's New task. A is no longer the account
      // signed in, so its record went once B's read answered.
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(shown('home-draft-restored')).toBe(false);
      expect(recordOf('account-1')).toBeNull();
      // B's own draft goes under B's key.
      act(() => {
        useHomeComposerStore.getState().setText('Account B plan');
      });
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(JSON.stringify(recordOf('account-2'))).toContain('Account B plan');
    });

    it("drops an account's New task draft and outbox once another account is the one signed in, whether the window saw the change or the app quit first (CAN-6798)", async () => {
      const keyOf = (accountId: string): string =>
        `canopy:home-draft:v1:account:${accountId}`;
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      act(() => {
        useHomeComposerStore.getState().setText('Account A plan');
      });
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      // A message A sent was still on its way.
      plantRecord({
        draft: savedRecord().draft,
        outbox: [cloudEntry('cmd-a', 'task-a', 'Account A message')],
      });
      const left = window.localStorage.getItem(keyOf('account-1'));
      expect(left).toContain('Account A plan');
      expect(left).toContain('Account A message');

      // Signing in as B signs A out: A's draft and outbox go with it.
      savedAccountId = 'account-2';
      act(() => {
        useWorkspaceContextStore.setState((store) => ({
          accountEpoch: store.accountEpoch + 1,
        }));
      });
      await settle();
      expect(window.localStorage.getItem(keyOf('account-1'))).toBeNull();
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(useHomeComposerStore.getState().outboxCards).toEqual([]);

      // A record the app quit with before the window saw A go is dropped at
      // the next start, under B, and nothing of it comes back.
      window.localStorage.setItem(keyOf('account-1'), left ?? '');
      await reloadHome(renderHome);
      expect(window.localStorage.getItem(keyOf('account-1'))).toBeNull();
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(useHomeComposerStore.getState().outboxCards).toEqual([]);
      expect(shown('home-draft-restored')).toBe(false);
    });

    it("deletes and restores nothing while the saved account can't be read, and restores once it can (CAN-6798)", async () => {
      const keyOf = (accountId: string): string =>
        `canopy:home-draft:v1:account:${accountId}`;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      act(() => {
        useHomeComposerStore.getState().setText('Account A plan');
      });
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      const left = window.localStorage.getItem(keyOf('account-1'));
      expect(left).toContain('Account A plan');
      // Another account's record a quit left, which only a definite read may
      // judge.
      window.localStorage.setItem(keyOf('account-2'), left ?? '');

      // The account can't be read at the next start: nothing is deleted, and
      // nothing comes back.
      savedAccountRead = 'unavailable';
      await reloadHome(renderHome);
      expect(window.localStorage.getItem(keyOf('account-1'))).toBe(left);
      expect(window.localStorage.getItem(keyOf('account-2'))).toBe(left);
      expect(useHomeComposerStore.getState().text).toBe('');

      // Once it can be read, A's draft comes back and the other goes.
      savedAccountRead = 'ok';
      await reloadHome(renderHome);
      expect(useHomeComposerStore.getState().text).toBe('Account A plan');
      expect(window.localStorage.getItem(keyOf('account-2'))).toBeNull();
    });

    it("drops an account's New task draft and outbox when it signs out, so signing back in brings nothing back (CAN-6798)", async () => {
      const changeAccount = async (accountId: string | null): Promise<void> => {
        savedAccountId = accountId;
        act(() => {
          useWorkspaceContextStore.setState((store) => ({
            accountEpoch: store.accountEpoch + 1,
          }));
        });
        await settle();
      };
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      await pickHomeFiles([
        new File(['# Brief'], 'brief.md', { type: 'text/markdown' }),
      ]);
      act(() => {
        useHomeComposerStore.getState().setText('Account A plan');
      });
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      // A message A sent was still on its way, and a draft was kept apart.
      plantRecord({
        draft: savedRecord().draft,
        outbox: [cloudEntry('cmd-a', 'task-a', 'Account A message')],
        kept: [
          {
            id: 'kept-a',
            workspaceId: 'local-notes',
            mode: 'chat',
            text: 'Account A kept draft',
            fileReferences: [],
            attachments: [],
            cloudFileNames: [],
          },
        ],
      });
      expect(window.localStorage.getItem(OUTBOX_KEY)).toContain('brief.md');
      expect(outboxIds()).toEqual(['cmd-a']);

      // Signed out: A's draft, its held file names and its outbox go with A.
      await changeAccount(null);
      expect(window.localStorage.getItem(OUTBOX_KEY)).toBeNull();

      await changeAccount('account-1');
      await reloadHome(renderHome);
      await pickHomeProject('web-core:ws-1');
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(shown('home-draft-restored')).toBe(false);
      expect(useHomeComposerStore.getState().outboxCards).toEqual([]);
      expect(shown('home-outbox-missing')).toBe(false);
      expect(useHomeComposerStore.getState().keptDrafts).toEqual([]);
      expect(shown('home-kept-draft')).toBe(false);
    });

    it('brings back only what was typed after a message the web core took, across two reloads while the cloud is offline (CAN-6798)', async () => {
      servesSendReceipts = true;
      appliesBeforeReply = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const { release } = await sendHeldFromHome('Original A');
      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
      await reloadHome(renderHome);
      // Nothing can be asked yet: the message stays in the outbox, and never
      // in the editor.
      expect(cardStates()).toEqual(['checking']);
      expect(useHomeComposerStore.getState().text).toBe('');
      act(() => {
        useHomeComposerStore.getState().setText('New B');
      });
      await reloadHome(renderHome);

      await connectWithOrgProject();
      await settle();

      // Taken, so only what was typed since comes back.
      expect(useHomeComposerStore.getState().text).toBe('New B');
      expect(cardStates()).toEqual(['sent']);
      expect(outboxIds()).toEqual([]);
      release();
      await settle();
      expect(appliedSends.map((sent) => sent.text)).toEqual(['Original A']);
    });

    it("brings a message the web core refused back into New task's draft as an edit, which sends as a new message (CAN-6798)", async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const taskId = await startTask('Earlier task');
      // The window reloaded as the refusal arrived, before it gave the
      // message back.
      refusedCommands.add('cmd-refused');
      plantRecord({
        outbox: [cloudEntry('cmd-refused', taskId, 'Plan the launch')],
      });
      await reloadHome(renderHome);

      expect(useHomeComposerStore.getState().text).toBe('Plan the launch');
      expect(useHomeComposerStore.getState().workspaceId).toBe('web-core:ws-1');
      expect(noticeText('home-outbox-restored')).toContain(
        "Your earlier message wasn't sent",
      );
      expect(outboxIds()).toEqual([]);

      sendFromHome('Plan the launch, with dates');
      await settle();
      // Never applied, so its edit goes as an ordinary message, once.
      expect(appliedSends.map((each) => each.text)).toEqual([
        'Earlier task',
        'Plan the launch, with dates',
      ]);
      expect(sendCommandsTo(taskId)).not.toContain('cmd-refused');
    });

    it("keeps a refused message for its own project while New task holds another project's draft, until the person moves it back (CAN-6798)", async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const taskId = await startTask('Earlier task');
      refusedCommands.add('cmd-refused');
      plantRecord({
        outbox: [cloudEntry('cmd-refused', taskId, 'Plan the launch')],
      });
      // New task holds a local project's draft when the window reloads.
      await pickHomeProject('local-notes');
      act(() => {
        useHomeComposerStore.getState().setText('Local note');
      });
      await reloadHome(renderHome);

      // It never joins another project's draft: it waits, kept, with a way
      // to move it back once New task is free.
      expect(useHomeComposerStore.getState().text).toBe('Local note');
      expect(noticeText('home-outbox-returned')).toContain('Plan the launch');
      expect(
        container
          .querySelector<HTMLButtonElement>('[data-testid="home-outbox-move"]')
          ?.hasAttribute('disabled'),
      ).toBe(true);
      expect(outboxIds()).toEqual(['cmd-refused']);
      // Kept across another reload as it was.
      await reloadHome(renderHome);
      expect(noticeText('home-outbox-returned')).toContain('Plan the launch');

      act(() => {
        useHomeComposerStore.getState().setText('');
      });
      await settle();
      click('home-outbox-move');
      await settle();

      expect(useHomeComposerStore.getState().text).toBe('Plan the launch');
      expect(useHomeComposerStore.getState().workspaceId).toBe('web-core:ws-1');
      expect(outboxIds()).toEqual([]);
    });

    it('keeps the names of files to attach again across a second reload (CAN-6798)', async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      await pickHomeFiles([
        new File(['# Brief'], 'brief.md', { type: 'text/markdown' }),
      ]);
      act(() => {
        useHomeComposerStore.getState().setText('Plan the launch');
      });
      await reloadHome(renderHome);
      expect(noticeText('home-draft-restored')).toContain('brief.md');

      await reloadHome(renderHome);
      expect(useHomeComposerStore.getState().text).toBe('Plan the launch');
      expect(noticeText('home-draft-restored')).toContain('brief.md');
    });

    it('shows a message a reload cut off as pending in its own project, and sends it again only when the person chooses, under a new command (CAN-6798)', async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const taskId = await startTask('Earlier task');
      const tasksCreated = createdChatIds.length;
      // An earlier run dispatched it, and the web core has no such send.
      plantRecord({
        outbox: [cloudEntry('cmd-pending', taskId, 'Plan the launch')],
      });
      await reloadHome(renderHome);
      await pickHomeProject('web-core:ws-1');

      // Never put back in the editor, and nothing sent by itself.
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(noticeText('home-outbox-missing')).toContain(
        'Sending it again stops the earlier one first, so it arrives once.',
      );
      expect(noticeText('home-outbox-missing')).toContain('Plan the launch');
      expect(sendCommandsTo(taskId)).toHaveLength(1);
      // Only in its own project.
      await pickHomeProject('local-notes');
      expect(shown('home-outbox-missing')).toBe(false);
      await pickHomeProject('web-core:ws-1');
      expect(shown('home-outbox-missing')).toBe(true);

      click('home-outbox-send-again');
      await settle();

      // Once, to its own task, under a new command, which replaces the
      // earlier entry until its receipt settles it.
      const sent = sendCommandsTo(taskId);
      expect(sent).toHaveLength(2);
      expect(sent[1]).not.toBe('cmd-pending');
      expect(appliedSends.map((each) => each.text)).toEqual([
        'Earlier task',
        'Plan the launch',
      ]);
      expect(createdChatIds).toHaveLength(tasksCreated);
      expect(shown('home-outbox-missing')).toBe(false);
      expect(outboxIds()).toEqual([sent[1]]);
      await reloadHome(renderHome);
      expect(cardStates()).toEqual(['sent']);
      expect(outboxIds()).toEqual([]);
    });

    it('asks again on the next reload about a message that may still arrive, and says it was sent once its task took it (CAN-6798)', async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const { release } = await sendHeldFromHome('Plan the launch');
      await reloadHome(renderHome);
      expect(cardStates()).toEqual(['missing']);
      // It reaches its task moments later.
      release();
      await settle();
      expect(appliedSends).toHaveLength(1);

      await reloadHome(renderHome);

      expect(cardStates()).toEqual(['sent']);
      expect(outboxIds()).toEqual([]);
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(appliedSends).toHaveLength(1);
    });

    it('sends nothing again for a pending message that arrived after the card showed, and says it was sent (CAN-6798)', async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const { taskId, release } = await sendHeldFromHome('Plan the launch');
      const [command] = sendCommandsTo(taskId);
      await reloadHome(renderHome);
      sendGate = null;
      await pickHomeProject('web-core:ws-1');
      expect(cardStates()).toEqual(['missing']);
      // It reaches its task while the card still says it may arrive.
      release();
      await settle();

      click('home-outbox-send-again');
      await settle();

      // Asked once more first: taken, so it isn't sent a second time.
      expect(sendCommandsTo(taskId)).toEqual([command]);
      expect(appliedSends).toHaveLength(1);
      expect(cardStates()).toEqual(['sent']);
      expect(outboxIds()).toEqual([]);
    });

    it('sends a pending message again as a new task when its task is gone (CAN-6798)', async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const { taskId } = await sendHeldFromHome('Plan the launch');
      await reloadHome(renderHome);
      sendGate = null;
      await pickHomeProject('web-core:ws-1');
      expect(cardStates()).toEqual(['missing']);
      // Its task is deleted before the person sends it again.
      act(() => {
        cloudCoworkStore.setState((state) => ({
          tasksByProject: {
            ...state.tasksByProject,
            'web-core:ws-1': (
              state.tasksByProject['web-core:ws-1'] ?? []
            ).filter((task) => task.worktreeId !== taskId),
          },
        }));
      });

      click('home-outbox-send-again');
      await settle();

      // A new task takes it; nothing more goes to the deleted one.
      const newTask = createdChatIds.at(-1) ?? '';
      expect(newTask).not.toBe(taskId);
      expect(sendCommandsTo(taskId)).toHaveLength(1);
      expect(appliedSends).toEqual([
        expect.objectContaining({ chatId: newTask, text: 'Plan the launch' }),
      ]);
      expect(outboxIds()).toEqual([]);
    });

    /** The supersedes the web core was asked for, by command id. */
    const supersededAt = (): unknown[] =>
      coreRequestLog
        .filter((entry) => entry.method === 'core.chat.send.supersede')
        .map((entry) => entry.params.commandId);

    const discardPending = (): void => {
      act(() => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="home-outbox-missing"] button[aria-label="Discard it"]',
          )
          ?.click();
      });
    };

    it('stops the earlier send before sending a pending message again, so the late one never arrives (CAN-6856)', async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const { taskId, release } = await sendHeldFromHome('Plan the launch');
      const [original] = sendCommandsTo(taskId);
      await reloadHome(renderHome);
      sendGate = null;
      await pickHomeProject('web-core:ws-1');
      expect(cardStates()).toEqual(['missing']);

      click('home-outbox-send-again');
      await settle();

      // Stopped first, then sent once under a new command.
      expect(supersededAt()).toEqual([original]);
      const sent = sendCommandsTo(taskId);
      expect(sent).toHaveLength(2);
      expect(sent[1]).not.toBe(original);
      expect(appliedSends.map((each) => each.text)).toEqual([
        'Plan the launch',
      ]);
      // The earlier send reaches the web core late, and never applies.
      release();
      await settle();
      expect(appliedSends.map((each) => each.text)).toEqual([
        'Plan the launch',
      ]);
    });

    it("sends a pending message again as before, saying it could arrive twice, where the cloud can't stop the earlier send (CAN-6856)", async () => {
      servesSendReceipts = true;
      supersedeAnswer = 'unfenced';
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const { taskId, release } = await sendHeldFromHome('Plan the launch');
      await reloadHome(renderHome);
      sendGate = null;
      await pickHomeProject('web-core:ws-1');

      // Asked once: the cloud can't stop it, so nothing goes yet, and the
      // card now says it could arrive twice.
      click('home-outbox-send-again');
      await settle();
      expect(sendCommandsTo(taskId)).toHaveLength(1);
      expect(noticeText('home-outbox-missing')).toContain(
        'Sending it again could deliver it twice.',
      );

      // Sent again knowing that, as before send fences.
      click('home-outbox-send-again');
      await settle();
      expect(sendCommandsTo(taskId)).toHaveLength(2);
      expect(appliedSends.map((each) => each.text)).toEqual([
        'Plan the launch',
      ]);
      release();
      await settle();
      expect(appliedSends.map((each) => each.text)).toEqual([
        'Plan the launch',
        'Plan the launch',
      ]);
    });

    it("sends nothing again, and keeps the card, when the cloud can't say whether it stopped the earlier send (CAN-6856)", async () => {
      servesSendReceipts = true;
      supersedeAnswer = 'unavailable';
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const { taskId } = await sendHeldFromHome('Plan the launch');
      const [original] = sendCommandsTo(taskId);
      await reloadHome(renderHome);
      sendGate = null;
      await pickHomeProject('web-core:ws-1');

      click('home-outbox-send-again');
      await settleUntil(
        () => useHomeComposerStore.getState().sendError !== null,
      );

      // Asked again a bounded number of times, always for the same send.
      expect(supersededAt()).toEqual([original, original, original]);
      expect(sendCommandsTo(taskId)).toHaveLength(1);
      expect(cardStates()).toEqual(['missing']);
      expect(useHomeComposerStore.getState().sendError?.error).toBe(
        "Couldn't check whether your earlier message arrived. Try again in a moment.",
      );
    });

    it('asks again, for the same send, when stopping the earlier one fails for now, and sends once it is stopped (CAN-6856)', async () => {
      servesSendReceipts = true;
      supersedeFailuresFirst.push('deadline_exceeded', 'unavailable');
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const { taskId, release } = await sendHeldFromHome('Plan the launch');
      const [original] = sendCommandsTo(taskId);
      await reloadHome(renderHome);
      sendGate = null;
      await pickHomeProject('web-core:ws-1');

      click('home-outbox-send-again');
      // Nothing goes while the cloud hasn't answered for certain.
      await settleUntil(() => supersededAt().length >= 2);
      expect(sendCommandsTo(taskId)).toHaveLength(1);
      await settleUntil(() => sendCommandsTo(taskId).length === 2);

      expect(supersededAt()).toEqual([original, original, original]);
      expect(sendCommandsTo(taskId)).toHaveLength(2);
      expect(useHomeComposerStore.getState().sendError).toBeNull();
      release();
      await settle();
      expect(appliedSends.map((each) => each.text)).toEqual([
        'Plan the launch',
      ]);
    });

    it("warns only on a chat that can't stop a send, leaving another chat's pending message to be stopped first (CAN-6856)", async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const oldChat = await startTask('An older chat');
      const newChat = await startTask('A newer chat');
      v1Chats.add(oldChat);
      plantRecord({
        outbox: [
          cloudEntry('cmd-old', oldChat, 'Plan the launch'),
          cloudEntry('cmd-new', newChat, 'Book the venue'),
        ],
      });
      await reloadHome(renderHome);
      await pickHomeProject('web-core:ws-1');
      expect(cardStates()).toEqual(['missing', 'missing']);
      const card = (text: string): HTMLElement | undefined =>
        Array.from(
          container.querySelectorAll<HTMLElement>(
            '[data-testid="home-outbox-missing"]',
          ),
        ).find((each) => each.textContent?.includes(text) === true);
      const sendAgain = (text: string): void => {
        act(() => {
          card(text)
            ?.querySelector<HTMLElement>(
              '[data-testid="home-outbox-send-again"]',
            )
            ?.click();
        });
      };

      // The older chat can't stop its send: only its card says so.
      sendAgain('Plan the launch');
      await settle();
      expect(sendCommandsTo(oldChat)).toHaveLength(1);
      expect(card('Plan the launch')?.textContent).toContain(
        'Sending it again could deliver it twice.',
      );
      expect(card('Book the venue')?.textContent).toContain(
        'Sending it again stops the earlier one first, so it arrives once.',
      );

      // The newer chat's message is still stopped first, then sent once.
      sendAgain('Book the venue');
      await settle();
      expect(supersededAt()).toEqual(['cmd-old', 'cmd-new']);
      expect(sendCommandsTo(newChat)).toHaveLength(2);
      expect(appliedSends.map((each) => each.text)).toEqual([
        'An older chat',
        'A newer chat',
        'Book the venue',
      ]);
    });

    it('stops a pending message for good when the person discards it (CAN-6856)', async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const { taskId, release } = await sendHeldFromHome('Plan the launch');
      const [original] = sendCommandsTo(taskId);
      await reloadHome(renderHome);
      sendGate = null;
      await pickHomeProject('web-core:ws-1');

      discardPending();
      await settle();

      expect(supersededAt()).toEqual([original]);
      expect(cardStates()).toEqual([]);
      expect(outboxIds()).toEqual([]);
      // Discarded means never sent: the late send doesn't apply.
      release();
      await settle();
      expect(appliedSends).toEqual([]);
    });

    it("keeps a pending message the person discards when the cloud can't say whether it stopped it (CAN-6856)", async () => {
      servesSendReceipts = true;
      supersedeAnswer = 'unavailable';
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const { taskId } = await sendHeldFromHome('Plan the launch');
      const [original] = sendCommandsTo(taskId);
      await reloadHome(renderHome);
      sendGate = null;
      await pickHomeProject('web-core:ws-1');

      discardPending();
      await settleUntil(
        () => useHomeComposerStore.getState().sendError !== null,
      );

      expect(supersededAt()).toEqual([original, original, original]);
      expect(cardStates()).toEqual(['missing']);
      expect(outboxIds()).toHaveLength(1);
      expect(useHomeComposerStore.getState().sendError?.error).toBe(
        "Couldn't stop your earlier message from arriving. Try again in a moment.",
      );
    });

    it("won't send a pending message again without the files whose task is gone, and names them (CAN-6798)", async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      plantRecord({
        outbox: [
          cloudEntry('cmd-gone', 'task-deleted', 'Plan the launch', [
            'brief.md',
          ]),
        ],
      });
      await reloadHome(renderHome);
      await pickHomeProject('web-core:ws-1');

      // Sent again as a new task, it would go without the files it was sent
      // with: a different message.
      expect(noticeText('home-outbox-missing')).toContain('brief.md');
      expect(
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="home-outbox-send-again"]',
          )
          ?.hasAttribute('disabled'),
      ).toBe(true);
      expect(shown('home-outbox-copy')).toBe(true);
      click('home-outbox-send-again');
      await settle();
      expect(
        coreRequestLog.filter(
          (entry) => entry.method === 'core.chat.message.send',
        ),
      ).toEqual([]);
      expect(outboxIds()).toEqual(['cmd-gone']);
    });

    it('settles each message an earlier run left on its own: one taken, one refused, one still on its way (CAN-6798)', async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const taskId = await startTask('Earlier task');
      appliedSends.push({
        chatId: taskId,
        commandId: 'cmd-taken',
        text: 'Taken note',
      });
      refusedCommands.add('cmd-refused');
      plantRecord({
        outbox: [
          cloudEntry('cmd-taken', taskId, 'Taken note'),
          cloudEntry('cmd-refused', taskId, 'Refused note'),
          cloudEntry('cmd-pending', taskId, 'Pending note'),
        ],
      });

      await reloadHome(renderHome);
      await pickHomeProject('web-core:ws-1');

      const states = Object.fromEntries(
        useHomeComposerStore
          .getState()
          .outboxCards.map((card) => [card.entry.id, card.state]),
      );
      expect(states).toEqual({
        'cmd-taken': 'sent',
        'cmd-refused': 'restored',
        'cmd-pending': 'missing',
      });
      // Only the refused one comes back into the editor.
      expect(useHomeComposerStore.getState().text).toBe('Refused note');
      expect(outboxIds()).toEqual(['cmd-pending']);
    });

    it("keeps a restored attachment's prompt kind and a mention's position (CAN-6798)", async () => {
      // As an earlier run left it, before this window's New task mounts.
      plantRecord({
        draft: {
          workspaceId: 'local-notes',
          mode: 'chat',
          text: 'notes.md and then notes.md',
          fileReferences: [
            {
              displayPath: 'notes.md',
              absolutePath: '/Users/me/notes.md',
              textStart: 18,
            },
          ],
          attachments: [
            {
              filename: 'CAN-1.md',
              absolutePath: '/Users/me/CAN-1.md',
              promptKind: 'linear-ticket',
            },
          ],
          cloudFileNames: [],
        },
      });

      renderHome();
      await settle();

      const restored = useHomeComposerStore.getState();
      expect(restored.text).toBe('notes.md and then notes.md');
      expect(restored.attachments).toEqual([
        expect.objectContaining({ promptKind: 'linear-ticket' }),
      ]);
      expect(restored.fileReferences).toEqual([
        expect.objectContaining({ textStart: 18 }),
      ]);
    });

    it("keeps a first message whose outcome the web core couldn't tell, and settles it by its receipt at the next start (CAN-6798)", async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      unknownOutcomeSendText = 'Plan the launch';
      sendFromHome('Plan the launch');
      await settle();

      // It may have landed: its entry stays, though the send has ended.
      expect(outboxIds()).toHaveLength(1);
      await reloadHome(renderHome);
      await pickHomeProject('web-core:ws-1');
      expect(cardStates()).toEqual(['missing']);
      expect(noticeText('home-outbox-missing')).toContain('Plan the launch');
    });

    it('never keeps a first message of files alone as a draft beside its outbox entry (CAN-6798)', async () => {
      servesSendReceipts = true;
      appliesBeforeReply = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      await pickHomeFiles([
        new File(['# Brief'], 'brief.md', { type: 'text/markdown' }),
      ]);
      await sendHeldFromHome('');
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(outboxIds()).toHaveLength(1);
      expect(savedRecord().draft).toBeUndefined();

      await reloadHome(renderHome);

      // Taken: its files don't come back to be sent again.
      expect(cardStates()).toEqual(['sent']);
      expect(shown('home-draft-restored')).toBe(false);
      expect(useHomeComposerStore.getState().text).toBe('');
    });

    it('takes a cloud message out of New task as it is dispatched, so anything typed there after is a new draft, even the same text (CAN-6798)', async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      await sendHeldFromHome('Plan the launch');
      // It left the editor as it went, and shows read-only meanwhile.
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(cardStates()).toEqual(['sending']);
      expect(outboxIds()).toHaveLength(1);
      // Typed after it went: a new draft, never compared with the message.
      await pickHomeProject('web-core:ws-1');
      act(() => {
        useHomeComposerStore.getState().setText('Plan the launch');
      });
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(JSON.stringify(savedRecord().draft)).toContain('Plan the launch');

      await reloadHome(renderHome);
      await pickHomeProject('web-core:ws-1');
      expect(useHomeComposerStore.getState().text).toBe('Plan the launch');
      expect(cardStates()).toEqual(['missing']);
    });

    it('never merges a restored message into a draft New task holds for its own project (CAN-6798)', async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const taskId = await startTask('Earlier task');
      refusedCommands.add('cmd-refused');
      plantRecord({
        outbox: [cloudEntry('cmd-refused', taskId, 'Plan the launch')],
      });
      await pickHomeProject('web-core:ws-1');
      act(() => {
        useHomeComposerStore.getState().setText('Pricing notes');
      });
      await reloadHome(renderHome);

      expect(useHomeComposerStore.getState().text).toBe('Pricing notes');
      expect(noticeText('home-outbox-returned')).toContain('Plan the launch');
      expect(outboxIds()).toEqual(['cmd-refused']);
    });

    it('keeps the entry of a send that ended without word before the account was read, and settles it after a reload (CAN-6798)', async () => {
      servesSendReceipts = true;
      // The account read is slow: nothing can be written until it answers.
      let answer = (): void => undefined;
      accountGate = new Promise<void>((resolve) => {
        answer = resolve;
      });
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      unknownOutcomeSendText = 'Plan the launch';
      sendFromHome('Plan the launch');
      await settle();
      expect(sendCommandsTo(createdChatIds.at(-1) ?? '')).toHaveLength(1);

      accountGate = null;
      answer();
      await settle();
      // Written once the account is known, never dropped before.
      expect(outboxIds()).toHaveLength(1);
      await reloadHome(renderHome);
      await pickHomeProject('web-core:ws-1');
      expect(cardStates()).toEqual(['missing']);
    });

    it('keeps a draft kept apart before the account was read, and writes it once the account is known (CAN-6798)', async () => {
      // The account read is slow: nothing can be written until it answers.
      let answer = (): void => undefined;
      accountGate = new Promise<void>((resolve) => {
        answer = resolve;
      });
      renderHome();
      await settle();
      await pickHomeProject('local-notes');
      act(() => {
        useHomeComposerStore.getState().setText('Newer note');
      });
      // As a failed send whose chat was rolled back leaves its message, kept
      // beside the newer draft, before the account is known.
      act(() => {
        useHomeComposerStore.setState({
          keptDrafts: [
            {
              id: 'kept-early',
              workspaceId: 'local-notes',
              mode: 'chat',
              text: 'Kept before the read',
              fileReferences: [],
              attachments: [],
              cloudFileNames: [],
            },
          ],
        });
      });
      accountGate = null;
      answer();
      await settle();

      // Never dropped before it is written (rule 3), and never merged.
      expect(useHomeComposerStore.getState().text).toBe('Newer note');
      expect(
        useHomeComposerStore.getState().keptDrafts.map((each) => each.text),
      ).toEqual(['Kept before the read']);
      expect(JSON.stringify(savedRecord().kept)).toContain(
        'Kept before the read',
      );
      await reloadHome(renderHome);
      await pickHomeProject('local-notes');
      expect(noticeText('home-kept-draft')).toContain('Kept before the read');
    });

    it("shows a message sent again as pending when its running task's queue refuses it after it went (CAN-6798)", async () => {
      servesSendReceipts = true;
      sendsKeepRunning = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      // Its task is still running a turn when the person sends it again.
      const taskId = await startTask('Earlier task');
      plantRecord({
        outbox: [cloudEntry('cmd-pending', taskId, 'Plan the launch')],
      });
      await reloadHome(renderHome);
      await pickHomeProject('web-core:ws-1');
      expect(cardStates()).toEqual(['missing']);
      // The task's queue refuses it, and only after the send has gone.
      refusedSendText = 'Plan the launch';
      let release = (): void => undefined;
      sendGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      onCaseEnd(async () => {
        sendGate = null;
        release();
        await settle();
      });
      click('home-outbox-send-again');
      await settle();
      sendGate = null;
      release();
      await settle();

      // Never lost from view: it shows as pending again, to send or copy.
      expect(cardStates()).toEqual(['missing']);
      expect(shown('home-outbox-missing')).toBe(true);
      expect(appliedSends.map((each) => each.text)).toEqual(['Earlier task']);
    });

    it('lets a message go for good when the person discards it before the account was read (CAN-6798)', async () => {
      servesSendReceipts = true;
      // The account read is slow: nothing can be written until it answers.
      let answer = (): void => undefined;
      accountGate = new Promise<void>((resolve) => {
        answer = resolve;
      });
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      // The send fails outright, so it shows as pending at once.
      unknownOutcomeSendText = 'Plan the launch';
      sendFromHome('Plan the launch');
      await settle();
      expect(cardStates()).toEqual(['missing']);
      act(() => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="home-outbox-missing"] button[aria-label="Discard it"]',
          )
          ?.click();
      });
      await settle();
      expect(cardStates()).toEqual([]);

      accountGate = null;
      answer();
      await settle();
      // The person's choice stands once the account is known.
      expect(outboxIds()).toEqual([]);
      await reloadHome(renderHome);
      await pickHomeProject('web-core:ws-1');
      expect(cardStates()).toEqual([]);
      expect(useHomeComposerStore.getState().text).toBe('');
    });

    it("keeps a draft for another organization's project as a card across a reload, never moving it to a project here (CAN-6798)", async () => {
      const setContext = (
        context:
          | { kind: 'personal' }
          | { kind: 'organization'; organizationId: string },
      ): void => {
        act(() => {
          useWorkspaceContextStore.setState((store) => ({
            state: { ...store.state, context },
          }));
        });
      };
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      await pickHomeFiles([
        new File(['# Brief'], 'brief.md', { type: 'text/markdown' }),
      ]);
      act(() => {
        useHomeComposerStore.getState().setText('Personal launch plan');
      });
      // The window comes back in the organization's context.
      await reloadHome(() => {
        setContext({ kind: 'organization', organizationId: 'org-1' });
        renderHome();
      });

      // Kept apart, whole, and never moved to the organization's project.
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(useHomeComposerStore.getState().workspaceId).not.toBe(
        'web-core:ws-1',
      );
      expect(noticeText('home-kept-draft')).toContain('Personal launch plan');
      expect(noticeText('home-kept-draft')).toContain(
        'Switch to its organization to move it back.',
      );
      expect(
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="home-kept-draft-move"]',
          )
          ?.hasAttribute('disabled'),
      ).toBe(true);
      expect(JSON.stringify(savedRecord().kept)).toContain(
        'Personal launch plan',
      );

      // Back in its context, it moves into New task as it was.
      setContext({ kind: 'personal' });
      await settle();
      act(() => {
        useHomeComposerStore.getState().setText('');
      });
      await settle();
      click('home-kept-draft-move');
      await settle();
      expect(useHomeComposerStore.getState().text).toBe('Personal launch plan');
      expect(useHomeComposerStore.getState().workspaceId).toBe('web-core:ws-1');
      expect(noticeText('home-draft-restored')).toContain('brief.md');
    });

    it('keeps a draft as a card while the context is still unknown, which the person can move in, and brings it in once the context is known (CAN-6798)', async () => {
      const setHydrated = (hydrated: boolean): void => {
        act(() => {
          useWorkspaceContextStore.setState({ hydrated });
        });
      };
      renderHome();
      await settle();
      await pickHomeProject('local-notes');
      act(() => {
        useHomeComposerStore.getState().setText('Unplaced note');
      });
      // The window comes back before main has said which context it is in.
      await reloadHome(() => {
        setHydrated(false);
        renderHome();
      });

      // Never lost and never hidden: kept, to copy or move in now.
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(noticeText('home-kept-draft')).toContain('Unplaced note');
      expect(
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="home-kept-draft-move"]',
          )
          ?.hasAttribute('disabled'),
      ).toBe(false);
      expect(JSON.stringify(savedRecord().kept)).toContain('Unplaced note');

      // Once the context is known, it comes back into New task by itself.
      setHydrated(true);
      await settle();
      expect(useHomeComposerStore.getState().text).toBe('Unplaced note');
      expect(useHomeComposerStore.getState().workspaceId).toBe('local-notes');
      expect(shown('home-kept-draft')).toBe(false);
    });

    it('keeps a draft as a card when the person switches to another organization, never throwing it away (CAN-6798)', async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      act(() => {
        useHomeComposerStore.getState().setText('Personal launch plan');
      });
      await settle();

      act(() => {
        useWorkspaceContextStore.setState((store) => ({
          state: {
            ...store.state,
            context: { kind: 'organization', organizationId: 'org-1' },
          },
        }));
      });
      await settle();

      // New task is the organization's now, and the draft is kept, whole.
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(noticeText('home-kept-draft')).toContain('Personal launch plan');
      expect(noticeText('home-kept-draft')).toContain(
        'Switch to its organization to move it back.',
      );
      expect(JSON.stringify(savedRecord().kept)).toContain(
        'Personal launch plan',
      );
    });

    it("keeps a draft restored before the cloud listed its project as a card once the listing shows another organization's (CAN-6798)", async () => {
      const setContext = (
        context:
          | { kind: 'personal' }
          | { kind: 'organization'; organizationId: string },
      ): void => {
        act(() => {
          useWorkspaceContextStore.setState((store) => ({
            state: { ...store.state, context },
          }));
        });
      };
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      await pickHomeFiles([
        new File(['# Brief'], 'brief.md', { type: 'text/markdown' }),
      ]);
      act(() => {
        useHomeComposerStore.getState().setText('Personal launch plan');
      });
      // The window comes back in the organization, before the cloud answers.
      await reloadHome(() => {
        act(() => {
          cloudCoworkStore.getState().disconnect('offline');
        });
        setContext({ kind: 'organization', organizationId: 'org-1' });
        renderHome();
      });

      // The cloud lists the project as Personal's: the draft is kept, not lost.
      await connectWithOrgProject();
      await settle();
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(noticeText('home-kept-draft')).toContain('Personal launch plan');
      expect(JSON.stringify(savedRecord().kept)).toContain('brief.md');

      // Back in its context, it moves into New task as it was.
      setContext({ kind: 'personal' });
      await settle();
      act(() => {
        useHomeComposerStore.getState().setText('');
      });
      await settle();
      click('home-kept-draft-move');
      await settle();
      expect(useHomeComposerStore.getState().text).toBe('Personal launch plan');
      expect(useHomeComposerStore.getState().workspaceId).toBe('web-core:ws-1');
      expect(noticeText('home-draft-restored')).toContain('brief.md');
    });

    it('clears everything a send took when New task only moved meanwhile, and keeps where it moved to (CAN-6798)', () => {
      const branch = {
        kind: 'branch' as const,
        branchName: 'next',
        isRemote: false,
      };
      const base = { kind: 'worktree' as const, worktreeId: 'wt-base' };
      act(() => {
        useHomeComposerStore.setState({
          workspaceId: 'local-notes',
          mode: 'chat',
          branchTarget: branch,
          newWorktreeBaseTarget: base,
          text: 'Sent plan',
          attachments: [
            { filename: 'brief.md', absolutePath: '/tmp/stage/brief.md' },
          ],
          cloudFiles: [
            {
              id: 'cloud-1',
              file: new File(['# Notes'], 'notes.md', {
                type: 'text/markdown',
              }),
            },
          ],
          scheduledSendDraft: { runAt: '2026-11-15T09:00:00.000Z' },
        });
      });

      act(() => {
        useHomeComposerStore.getState().clearSubmittedDraft();
      });

      const state = useHomeComposerStore.getState();
      expect(state.text).toBe('');
      expect(state.fileReferences).toEqual([]);
      expect(state.attachments).toEqual([]);
      expect(state.cloudFiles).toEqual([]);
      expect(state.scheduledSendDraft).toBeNull();
      expect(state.workspaceId).toBe('local-notes');
      expect(state.mode).toBe('chat');
      expect(state.branchTarget).toEqual(branch);
      expect(state.newWorktreeBaseTarget).toEqual(base);
    });

    it("never keeps a local first message on its way as a card when the context changes, so it can't be sent twice (CAN-6798)", async () => {
      // Main answers a local Cowork send up to its work entry, and holds that.
      let release = (): void => undefined;
      const created = new Promise<void>((resolve) => {
        release = resolve;
      });
      onCaseEnd(() => {
        release();
      });
      caseReplies.set('api.loadCanopyCloudEntitlements', () =>
        Promise.resolve({ entitlements: [] }),
      );
      caseReplies.set('api.chatProject.checkFolder', () =>
        Promise.resolve({ kind: 'internal' }),
      );
      caseReplies.set('api.chatProject.list', () =>
        Promise.resolve({
          projects: [
            {
              id: 'local-notes',
              name: 'Local notes',
              path: '/tmp/local-notes',
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
            },
          ],
        }),
      );
      caseReplies.set('api.standaloneChat.init', () =>
        Promise.resolve(undefined),
      );
      caseReplies.set('api.workEntries.list', () =>
        Promise.resolve({ entries: [] }),
      );
      caseReplies.set('api.workEntries.create', () => created.then(() => null));
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('local-notes');
      sendFromHome('Local launch plan');
      await settle();
      expect(calls.some((call) => call.path === 'api.workEntries.create')).toBe(
        true,
      );

      // The person moves to the organization while the message is on its way.
      act(() => {
        useWorkspaceContextStore.setState((store) => ({
          state: {
            ...store.state,
            context: { kind: 'organization', organizationId: 'org-1' },
          },
        }));
      });
      await settle();

      // The message is the send's, not a draft to keep: no copy to send again.
      expect(shown('home-kept-draft')).toBe(false);
      expect(useHomeComposerStore.getState().keptDrafts).toEqual([]);
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(JSON.stringify(savedRecord())).not.toContain('Local launch plan');
    });

    it('keeps a local draft whose send was refused before it went as a card when the context changes (CAN-6798)', async () => {
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('local-notes');
      // A Cursor model with no Cursor connected stops the send before it goes.
      act(() => {
        useHomeComposerStore.setState({ model: 'cursor:auto' });
      });
      sendFromHome('Local launch plan');
      await settle();
      expect(useHomeComposerStore.getState().isSending).toBe(false);
      expect(useHomeComposerStore.getState().text).toBe('Local launch plan');
      expect(calls.some((call) => call.path === 'api.workEntries.create')).toBe(
        false,
      );

      // The person moves to the organization without editing it.
      act(() => {
        useWorkspaceContextStore.setState((store) => ({
          state: {
            ...store.state,
            context: { kind: 'organization', organizationId: 'org-1' },
          },
        }));
      });
      await settle();

      // Never sent, so never thrown away: it is kept as a card.
      expect(noticeText('home-kept-draft')).toContain('Local launch plan');
      expect(JSON.stringify(savedRecord().kept)).toContain('Local launch plan');
    });

    it('clears a scheduled message from New task once it is scheduled, even after a switch to pipeline mode meanwhile (CAN-6798)', async () => {
      // Main schedules it once released.
      let release = (): void => undefined;
      const scheduled = new Promise<void>((resolve) => {
        release = resolve;
      });
      onCaseEnd(() => {
        release();
      });
      caseReplies.set('api.loadCanopyCloudEntitlements', () =>
        Promise.resolve({ entitlements: [] }),
      );
      caseReplies.set('api.chatProject.checkFolder', () =>
        Promise.resolve({ kind: 'internal' }),
      );
      caseReplies.set('api.automations.create', () =>
        scheduled.then(() => ({
          ok: true,
          activity: {
            id: 'activity-1',
            name: 'Scheduled message',
            enabled: true,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          },
        })),
      );
      renderHome();
      await settle();
      await pickHomeProject('local-notes');
      act(() => {
        useHomeComposerStore.setState({
          scheduledSendDraft: { runAt: '2026-11-20T09:00:00.000Z' },
        });
      });
      sendFromHome('Scheduled launch plan');
      await settle();
      expect(calls.some((call) => call.path === 'api.automations.create')).toBe(
        true,
      );

      // The person switches to pipeline mode while it is scheduled.
      act(() => {
        useHomeComposerStore.getState().setMode('pipeline');
      });
      release();
      await settle();

      // Scheduled once, and nowhere left to send it from again.
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(useHomeComposerStore.getState().mode).toBe('pipeline');
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(JSON.stringify(savedRecord())).not.toContain(
        'Scheduled launch plan',
      );
    });

    it("keeps watching New task while a send's chat holds it failed, so a later Try again never resets what was typed since (CAN-6798)", () => {
      const watches = submissionWatchForTest;
      act(() => {
        useHomeComposerStore.getState().setText('First message');
      });
      watches.watch('held-edit');
      // Its chat holds the send failed; the send itself has returned.
      watches.hold('held-edit');
      watches.release('held-edit');
      act(() => {
        useHomeComposerStore.getState().setText('A newer draft');
      });
      expect(watches.untouched('held-edit')).toBe(false);
      void watches.resume('held-edit', () => Promise.resolve(true));
    });

    it("keeps a held send's watch when the send returns, untouched while nothing was typed (CAN-6798)", async () => {
      const watches = submissionWatchForTest;
      watches.watch('held-kept');
      watches.hold('held-kept');
      watches.release('held-kept');
      expect(watches.untouched('held-kept')).toBe(true);
      await watches.resume('held-kept', () => Promise.resolve(true));
    });

    it("releases a held send's watch once its Try again settles, unless its chat holds it failed again (CAN-6798)", async () => {
      const watches = submissionWatchForTest;
      watches.watch('held-sent');
      watches.hold('held-sent');
      watches.release('held-sent');
      await watches.resume('held-sent', () => Promise.resolve(true));
      expect(watches.untouched('held-sent')).toBeUndefined();

      watches.watch('held-again');
      watches.hold('held-again');
      watches.release('held-again');
      await watches.resume('held-again', () => {
        watches.hold('held-again');
        return Promise.resolve(false);
      });
      expect(watches.untouched('held-again')).toBe(true);
      await watches.resume('held-again', () => Promise.resolve(true));
      expect(watches.untouched('held-again')).toBeUndefined();
    });

    it('keeps a file attached while the send was on its way as a draft beside its entry (CAN-6798)', async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      // The task is still being created when the person attaches a file.
      let create = (): void => undefined;
      createGate = new Promise<void>((resolve) => {
        create = resolve;
      });
      let release = (): void => undefined;
      sendGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      sendFromHome('Plan the launch');
      await settle();
      act(() => {
        useHomeComposerStore
          .getState()
          .addCloudFiles([
            new File(['# Brief'], 'brief.md', { type: 'text/markdown' }),
          ]);
      });
      createGate = null;
      create();
      await settle();
      const taskId = createdChatIds.at(-1) ?? '';
      expect(sendCommandsTo(taskId)).toHaveLength(1);

      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });

      // The message went without it: the file is the person's own draft.
      expect(outboxIds()).toHaveLength(1);
      expect(JSON.stringify(savedRecord().draft)).toContain('brief.md');
      sendGate = null;
      release();
      await settle();
    });

    it("keeps an earlier run's draft for another project apart when New task holds a draft by the time it is read, until the person moves it back (CAN-6798)", async () => {
      plantRecord({
        draft: {
          workspaceId: 'web-core:ws-1',
          mode: 'chat',
          text: 'Cloud plan',
          fileReferences: [],
          attachments: [],
          cloudFileNames: [],
        },
      });
      // The account read is slow: the person picks a local project and types
      // before it answers.
      let answer = (): void => undefined;
      accountGate = new Promise<void>((resolve) => {
        answer = resolve;
      });
      renderHome();
      await settle();
      await pickHomeProject('local-notes');
      act(() => {
        useHomeComposerStore.getState().setText('Local note');
      });
      accountGate = null;
      answer();
      await settle();

      // Never merged into the local draft, and kept across a reload.
      expect(useHomeComposerStore.getState().text).toBe('Local note');
      expect(useHomeComposerStore.getState().workspaceId).toBe('local-notes');
      expect(noticeText('home-kept-draft')).toContain('Cloud plan');
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(JSON.stringify(savedRecord().kept)).toContain('Cloud plan');
      await reloadHome(renderHome);
      expect(useHomeComposerStore.getState().text).toBe('Local note');
      expect(noticeText('home-kept-draft')).toContain('Cloud plan');

      act(() => {
        useHomeComposerStore.getState().setText('');
      });
      await settle();
      click('home-kept-draft-move');
      await settle();
      expect(useHomeComposerStore.getState().text).toBe('Cloud plan');
      expect(useHomeComposerStore.getState().workspaceId).toBe('web-core:ws-1');
      expect(savedRecord().kept).toBeUndefined();
    });

    it('keeps a cloud message a reload cut off while the cloud is offline apart from what was typed meanwhile (CAN-6798)', async () => {
      servesSendReceipts = true;
      renderHome();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      const { taskId, release } = await sendHeldFromHome('Plan the launch');
      const [command] = sendCommandsTo(taskId);
      act(() => {
        cloudCoworkStore.getState().disconnect('offline');
      });
      await reloadHome(renderHome);
      expect(cardStates()).toEqual(['checking']);
      act(() => {
        useHomeComposerStore.getState().setText('And a note on pricing');
      });
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });

      await connectWithOrgProject();
      await settle();

      // The draft and the message stay apart: the message never joins it.
      expect(useHomeComposerStore.getState().text).toBe(
        'And a note on pricing',
      );
      expect(cardStates()).toEqual(['missing']);
      expect(outboxIds()).toEqual([command]);
      release();
      await settle();
      expect(sendCommandsTo(taskId)).toEqual([command]);
    });

    it("hands a message the web core refuses back to the new chat's open composer", async () => {
      renderHomeBesidePage();
      await connectWithOrgProject();
      await settle();
      await pickHomeProject('web-core:ws-1');
      // The web core refuses the new task, but only once its chat is open.
      createRefusal = 'This project is full.';
      let refuse = (): void => undefined;
      createGate = new Promise<void>((resolve) => {
        refuse = resolve;
      });

      sendFromHome('Plan the launch');
      await settle();
      const chatEditor = (): Element | null =>
        container.querySelector(
          '[data-testid="chat-panel"] [data-chat-textarea]',
        );
      expect(chatEditor()).not.toBeNull();
      createGate = null;
      refuse();
      await settle();

      const taskId = createdChatIds.at(-1) ?? '';
      expect(taskId).not.toBe('');
      expect(sendsTo(taskId)).toBe(0);
      // The new chat's composer, already open, shows the message again.
      expect(chatEditor()?.textContent).toContain('Plan the launch');
      expect(callsCarryingWebCoreIds()).toEqual([]);
      // Its chat's composer holds it: the outbox lets it go (CAN-6798).
      expect(outboxIds()).toEqual([]);
    });
  });
});

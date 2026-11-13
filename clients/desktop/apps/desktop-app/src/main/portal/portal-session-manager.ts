import type {
  PairingTelemetryAttempt,
  PairingTelemetryOutcome,
} from '@canopy/desktop-instrumentation/pairing';
import { beginPairingTelemetry } from '../lib/pairing-telemetry';
import { startRemotePairingTelemetry } from '../lib/desktop-telemetry';
import { clearPortalWatcherProjection } from './adapters/watchers-adapter';
import {
  PORTAL_CAPABILITY_CHAT_WATCHERS,
  PORTAL_CAPABILITY_WATCHED_GITHUB_ITEMS,
  PORTAL_CAPABILITY_LIFECYCLE_JOURNAL_QUARANTINE,
} from '@canopy/protocol/portal';
import {
  PORTAL_CAPABILITY_SUGGESTIONS,
  PORTAL_CAPABILITY_ONBOARDING_TIPS,
  PORTAL_CAPABILITY_CLAUDE_MOD_ADMISSION,
  PORTAL_CAPABILITY_SCRIPT_ACTIONS,
  readAutoResumeMetadata,
  readToolInterruption,
} from '@canopy/protocol/portal';
import {
  serializeAgentArtifactReceipts,
  MAX_AGENT_ARTIFACT_METADATA_BYTES,
} from '@canopy/protocol/agent-artifacts';
import { readCodexAccountModelAccessFailure } from '@canopy/protocol/auth-recovery';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import { portalSnapshotWorkBudget } from './portal-snapshot-work-budget';
import { portalFileReferences } from './portal-file-references';
import { closePortalAssetTransfers } from '../services/portal-asset-service';
import {
  PORTAL_CAPABILITY_ITEM_GROUPING,
  PORTAL_CAPABILITY_QUEUE_EDIT_LOCK_OWNERSHIP,
  PORTAL_CAPABILITY_CHAT_MARK_READ,
  PORTAL_CAPABILITY_CHAT_SET_UNREAD,
  PORTAL_CAPABILITY_PR_WORKTREE_ACTIONS,
  PORTAL_CAPABILITY_PR_STATUS_PUSH,
  PORTAL_CAPABILITY_COMMAND_ORIGIN,
  PORTAL_CAPABILITY_CHAT_CANCEL_TURN,
} from '@canopy/protocol/portal';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { randomInt } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { app, type BrowserWindow } from 'electron';
import { MODEL_LIBRARY_PORTAL_CAPABILITY } from '@canopy/protocol/models';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { BRAND } from '@canopy/brand/current';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import { getCanonicalCanopyToolKey } from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  PORTAL_EVENT_BATCH_MAX_BYTES,
  PORTAL_EVENT_BATCH_MAX_COUNT,
} from '@canopy/desktop-shared/types';
import type {
  CanopyPortalState,
  PortalEventEnvelope,
  PortalStateRequestPayload,
  CancelCanopyPortalPairingCodeResponse,
  RegenerateCanopyPortalPairingCodeResponse,
  StartCanopyPortalResponse,
  StopCanopyPortalResponse,
} from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import {
  PORTAL_CAPABILITY_APP_ADVISOR,
  PORTAL_CAPABILITY_CHAT_ATTACHMENTS,
  PORTAL_CAPABILITY_CHAT_ASSETS,
  PORTAL_CAPABILITY_TRANSCRIPT_READS,
  PORTAL_CAPABILITY_TRANSCRIPT_READS_V2,
  PORTAL_CAPABILITY_CHAT_CREATE_TAB_SETTINGS,
  PORTAL_CAPABILITY_CHAT_PLAN_REVIEW,
  PORTAL_CAPABILITY_STANDALONE_CHAT_CREATE,
  PORTAL_CAPABILITY_WORKTREE_CREATE_FROM,
  PORTAL_CAPABILITY_WORK_ENTRY_COMMANDS,
  PORTAL_CAPABILITY_SIDEBAR_ITEM_GROUP_NAMES,
  PORTAL_CAPABILITY_TASK_REFS,
  PORTAL_CAPABILITY_PROJECT_REPOSITORY_IDENTITY,
  PORTAL_CAPABILITY_PLUGIN_MUTATIONS,
  PORTAL_CAPABILITY_PLUGIN_SHARE_PREFLIGHT,
  PORTAL_CAPABILITY_INSTALLED_ITEMS,
  PORTAL_CAPABILITY_WORKTREE_DISCARD,
  PORTAL_CAPABILITY_PROJECT_DELETION_DISCARD,
  PORTAL_CAPABILITY_MCP_MANAGEMENT,
  PORTAL_CAPABILITY_COLLECTION_MUTATIONS,
  PORTAL_CAPABILITY_COLLECTION_UPDATES,
  PORTAL_CAPABILITY_CURATED_PIPELINE_IMPORT,
  PORTAL_CAPABILITY_WORKSPACE_ITEMS,
  PORTAL_CAPABILITY_WORKTREE_ACTIONS_SCOPE,
  PORTAL_CAPABILITY_WORKTREE_CHAT_SUMMARIES_SCOPE,
  PORTAL_CAPABILITY_SIDEBAR_ACTIVITY_INVENTORY,
  PORTAL_CAPABILITY_PIPELINE_CHAT_FOLLOW_UP,
  PORTAL_CAPABILITY_PIPELINE_CONTENT,
  PORTAL_CAPABILITY_PIPELINE_DISPATCH,
  PORTAL_CAPABILITY_PIPELINE_RUN_CHAT_LINKS,
  PORTAL_CAPABILITY_PROVIDER_USAGE,
  PORTAL_CAPABILITY_INVOCABLE_INVENTORY,
  PORTAL_CAPABILITY_DEFERRED_PLUGIN_POLICY,
  PORTAL_CAPABILITY_WORKTREE_RETENTION,
  PORTAL_CAPABILITY_FOREGROUND_WORKTREE_CHAT,
  type PortalChatPart,
  type PortalChatModsSkippedData,
  PORTAL_CAPABILITY_CHAT_VISUALS,
  parseChatWatcherFiredInfo,
  readPortalChatPartVisual,
  sanitizePortalEventEnvelope,
  readPortalToolOccurrence,
  readPortalToolOutputLocator,
  type ChatWatcherFiredInfo,
} from '@canopy/protocol/portal';
import {
  PORTAL_CHAT_SEED_MESSAGE_LIMIT,
  PORTAL_CHAT_TEXT_MAX_CHARS,
} from '@canopy/desktop-shared/portal/persisted-chat-projection';
import { projectPortalDelegationPart } from '@canopy/desktop-shared/portal/delegation-wire-projection';
import {
  hasCanopyCloudIdentityChanged,
  loadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  subscribePortalDelegationCardEvents,
  type PortalCardEventAdapter,
} from './portal-delegation-card-events';
import { getFeatureFlagService } from '../feature-flags';
import { getObservabilityService } from '../observability';
import {
  assertLiveCanopyPortalSupport,
  CanopyPortalClientError,
  createPortalSession,
  endPortalSession,
  openPortalCommandStream,
  pollPortalCommands,
  sendPortalEvents,
  sendPortalHeartbeat,
} from './canopy-portal-client';
import {
  isPortalHostCode,
  resolvePortalClientPlatform,
} from './portal-client-platform';
import {
  runPortalCommandSseTransport,
  type PortalCommandSseDeps,
} from './command-sse-transport';
import {
  executePortalStateRequest,
  handlePortalCommand,
  normalizeStateRequestPayload,
} from './portal-command-handlers';
import { validatePortalCommandProvenance } from './portal-command-provenance';
import {
  createPortalSnapshotLane,
  type PortalCommandGroupDrop,
  type PortalSnapshotLaneErrorPhase,
} from './portal-snapshot-lane';
import type { PollPortalCommandsResponse } from '@canopy/desktop-shared/types';
import { subscribeTerminalPortalEvents } from '../services/terminal-service';
import { subscribePortalProviderUsage } from './provider-usage-projection';
import { subscribePortalCanonicalTurnTimers } from './canonical-turn-timer-projection';
import { subscribePortalCanonicalTurnSummaries } from './canonical-turn-summary-projection';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  startWorktreeRuntimeStatusService,
  stopWorktreeRuntimeStatusService,
} from '../services/worktree-runtime-status-service';
import {
  clearActivePortalSession,
  persistCompletedPortalCommand,
  persistActivePortalSession,
  persistPortalCommandCursor,
  persistPortalEventOutbox,
  persistPortalStopReason,
  readCompletedPortalCommand,
  readPortalStateStore,
} from './portal-state-store';
import {
  createCommandFailedPayload,
  createPortalCommandEvent,
  setCanopyPortalEventSink,
  invalidatePortalEmissionContexts,
} from './portal-event-bus';
import { clearWorktreeSummaryPortalFingerprints } from '../lib/worktree-summary-persistence';
import { clearPortalMcpServerFingerprints } from './adapters/mcp-adapter';
import {
  clearPortalBackgroundProcessFingerprints,
  startPortalBackgroundProcessProjection,
} from './adapters/bg-processes-adapter';
import {
  cachedPortalEventByteLength,
  computePortalOutboxTrim,
  createDroppedRangeMarkers,
  isPortalControlEvent,
  PORTAL_OUTBOX_MAX_BYTES,
  resolvePortalDroppedCommandEvent,
  type PortalDroppedCommandGroup,
  shouldRecordPortalCoalesceDiagnostic,
  restorePortalRoutingSequenceCounters,
  stampPortalEventRouting,
  shouldRecordPortalOutboxLatency,
  splitOversizedPortalSnapshotEvent,
} from './portal-outbox';
import { performance } from 'node:perf_hooks';
import {
  elapsedMilliseconds,
  elapsedSinceTimestamp,
  recordPortalOutboxUploadLatency,
  recordPortalSnapshotTiming,
} from './portal-performance-diagnostics';
import {
  getPortalEventWorktreeIdentity,
  isPortalEventForeground,
  isPortalWorktreeIdentityForeground,
  portalWorktreeKey,
  type PortalWorktreeIdentity,
} from './portal-event-routing';

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
/**
 * Shown when a pending pairing code (and its QR code) lapses unredeemed
 * (CAN-2938). The modal pairs it with Enable, which mints a fresh code.
 */
const PAIRING_CODE_EXPIRED_MESSAGE =
  'The QR code expired before a device connected.';
const portalDisplayName = REMOTE_CONTROL_LABEL;
// Lowercase form for mid-sentence prose; portalDisplayName stays proper-cased
// for sentence-start usage.
const portalDisplayNameInline = REMOTE_CONTROL_LABEL.toLowerCase();
const cloudDisplayName = `${BRAND.displayName} Cloud`;
const PORTAL_SESSION_CAPABILITIES = {
  [PORTAL_CAPABILITY_CHAT_WATCHERS]: true,
  [PORTAL_CAPABILITY_WATCHED_GITHUB_ITEMS]: true,
  [PORTAL_CAPABILITY_LIFECYCLE_JOURNAL_QUARANTINE]: true,
  [MODEL_LIBRARY_PORTAL_CAPABILITY]: true,
  personal_organization_projects: true,
  'org-shared-multi-repo-setup-v1': true,
  [PORTAL_CAPABILITY_ITEM_GROUPING]: true,
  [PORTAL_CAPABILITY_QUEUE_EDIT_LOCK_OWNERSHIP]: true,
  [PORTAL_CAPABILITY_PR_WORKTREE_ACTIONS]: true,
  [PORTAL_CAPABILITY_PR_STATUS_PUSH]: true,
  'portal-v1': true,
  [PORTAL_CAPABILITY_CHAT_MARK_READ]: true,
  [PORTAL_CAPABILITY_CHAT_SET_UNREAD]: true,
  [PORTAL_CAPABILITY_WORKTREE_ACTIONS_SCOPE]: true,
  [PORTAL_CAPABILITY_WORKTREE_CHAT_SUMMARIES_SCOPE]: true,
  // Strict `includeChatSummaries` inventory for sidebar Activity (CAN-390).
  [PORTAL_CAPABILITY_SIDEBAR_ACTIVITY_INVENTORY]: true,
  [PORTAL_CAPABILITY_FOREGROUND_WORKTREE_CHAT]: true,
  [PORTAL_CAPABILITY_APP_ADVISOR]: true,
  [PORTAL_CAPABILITY_PLUGIN_MUTATIONS]: true,
  [PORTAL_CAPABILITY_INSTALLED_ITEMS]: true,
  [PORTAL_CAPABILITY_PLUGIN_SHARE_PREFLIGHT]: true,
  [PORTAL_CAPABILITY_WORKTREE_DISCARD]: true,
  [PORTAL_CAPABILITY_PROJECT_DELETION_DISCARD]: true,
  [PORTAL_CAPABILITY_MCP_MANAGEMENT]: true,
  // `portal.collections.save` (plugin-catalog-adapter, CAN-4847).
  [PORTAL_CAPABILITY_COLLECTION_MUTATIONS]: true,
  [PORTAL_CAPABILITY_COLLECTION_UPDATES]: true,
  [PORTAL_CAPABILITY_CURATED_PIPELINE_IMPORT]: true,
  [PORTAL_CAPABILITY_WORKSPACE_ITEMS]: true,
  [PORTAL_CAPABILITY_CHAT_ATTACHMENTS]: true,
  [PORTAL_CAPABILITY_CHAT_VISUALS]: true,
  [PORTAL_CAPABILITY_CHAT_ASSETS]: true,
  [PORTAL_CAPABILITY_TRANSCRIPT_READS]: true,
  [PORTAL_CAPABILITY_TRANSCRIPT_READS_V2]: true,
  // Announced with `portal.standalone_chat.create` (standalone-chat-adapter).
  [PORTAL_CAPABILITY_STANDALONE_CHAT_CREATE]: true,
  // Task commands for the Tasks tools: create from a branch, base or pull
  // request with a group and first chat (worktree-adapter); Work Entry
  // update/delete and cowork create extensions (work-entry-adapter,
  // standalone-chat-adapter); groups by name; and the task ref list.
  [PORTAL_CAPABILITY_WORKTREE_CREATE_FROM]: true,
  [PORTAL_CAPABILITY_WORK_ENTRY_COMMANDS]: true,
  [PORTAL_CAPABILITY_SIDEBAR_ITEM_GROUP_NAMES]: true,
  [PORTAL_CAPABILITY_TASK_REFS]: true,
  [PORTAL_CAPABILITY_PROJECT_REPOSITORY_IDENTITY]: true,
  // `portal.chat.create_tab` applies a remote New Task's model, provider and
  // plugins, and the canonical send keeps Auto (chat-adapter).
  [PORTAL_CAPABILITY_CHAT_CREATE_TAB_SETTINGS]: true,
  [PORTAL_CAPABILITY_CHAT_PLAN_REVIEW]: true,
  [PORTAL_CAPABILITY_WORKTREE_RETENTION]: true,
  [PORTAL_CAPABILITY_PIPELINE_DISPATCH]: true,
  // Every projected pipeline_run carries desktop-attributed chat turn links
  // (`pipelines-service` stateToPortalRun + `pipeline-run-chat-links`).
  [PORTAL_CAPABILITY_PIPELINE_RUN_CHAT_LINKS]: true,
  // Every projected pipeline_run carries saved-output availability, and the
  // prepare command resolves the review prompt (`pipelines-service`).
  [PORTAL_CAPABILITY_PIPELINE_CHAT_FOLLOW_UP]: true,
  // `portal.pipeline.content.read` serves complete step output and the saved
  // report (`pipelines-service` readPipelineContent).
  [PORTAL_CAPABILITY_PIPELINE_CONTENT]: true,
  [PORTAL_CAPABILITY_PROVIDER_USAGE]: true,
  // List/resolve inventory and standalone plugin selections (CAN-3923).
  [PORTAL_CAPABILITY_INVOCABLE_INVENTORY]: true,
  [PORTAL_CAPABILITY_SCRIPT_ACTIONS]: true,
  // `portal.onboarding_tips.get` / `.update` (onboarding-tips-adapter).
  [PORTAL_CAPABILITY_SUGGESTIONS]: true,
  [PORTAL_CAPABILITY_ONBOARDING_TIPS]: true,
  // Mod admission state carries the feature flag; transport support is stable.
  [PORTAL_CAPABILITY_CLAUDE_MOD_ADMISSION]: true,
  [PORTAL_CAPABILITY_COMMAND_ORIGIN]: true,
  [PORTAL_CAPABILITY_CHAT_CANCEL_TURN]: true,
  [PORTAL_CAPABILITY_DEFERRED_PLUGIN_POLICY]: true,
} satisfies Record<string, boolean>;

function portalSessionCapabilities(): Record<string, boolean> {
  const capabilities: Record<string, boolean> = {
    ...PORTAL_SESSION_CAPABILITIES,
  };
  if (typeof __CANOPY_E2E__ === 'undefined' || !__CANOPY_E2E__) {
    return capabilities;
  }
  const disabledCapabilities =
    process.env.CANOPY_E2E_PORTAL_DISABLE_CAPABILITIES;
  if (!disabledCapabilities) return capabilities;
  for (const capability of disabledCapabilities.split(',')) {
    const normalized = capability.trim();
    if (Object.prototype.hasOwnProperty.call(capabilities, normalized)) {
      delete capabilities[normalized];
    }
  }
  return capabilities;
}
const HEARTBEAT_INTERVAL_MS = 15_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
// SSE command transport tuning (TS-02).
const SSE_COMMAND_MAX_IMMEDIATE_FAILURES = 3;
// A delivered connection must last this long to count as healthy (else back off
// to avoid a reconnect storm against a server that flushes then closes).
const SSE_COMMAND_MIN_HEALTHY_CONNECTION_MS = 1_000;
// Bound the connection/header phase separately from the stream-read watchdog.
const SSE_COMMAND_CONNECT_TIMEOUT_MS = 30_000;
// Force a reconnect if no bytes arrive in this window. The server emits a frame
// at least every ~25s (keepalive comments arrive more often but deliberately
// do NOT re-arm the watchdog — CAN-2358), so ~60s without a frame reliably
// detects a half-open socket or a wedged server poll loop.
const SSE_COMMAND_IDLE_TIMEOUT_MS = 60_000;
const POLL_PROGRESS_STALL_MS = 5 * 60_000;
const POLL_STALL_CHECK_INTERVAL_MS = 60_000;
const PORTAL_EVENT_BATCH_TARGET_BYTES = Math.floor(
  PORTAL_EVENT_BATCH_MAX_BYTES * 0.9,
);
const PORTAL_OUTBOX_JSON_MAX_CHARS = 4_000;
const PORTAL_OUTBOX_JSON_MAX_DEPTH = 3;
const PORTAL_OUTBOX_JSON_MAX_KEYS = 24;
const PORTAL_OUTBOX_ARRAY_MAX_ITEMS = 24;
const PORTAL_OUTBOX_WATCHER_TEXT_MAX_CHARS = 1_000;
const PORTAL_OUTBOX_MAX_EVENTS = 500;
/** Last reclaim-only trim diagnostic timestamp; throttles the routine case. */
let lastCoalesceDiagnosticAt = 0;
const PORTAL_OUTBOX_PERSIST_DEBOUNCE_MS = 250;
export const PORTAL_OUTBOX_STARVATION_BOUND_MS = 10_000;
// Cap on promoted control events per batch (CAN-2360): completions are tiny,
// but an unbounded lane would let a sustained completion burst crowd out the
// bulk lanes and defeat the FIFO starvation bound above.
export const PORTAL_CONTROL_LANE_MAX_COUNT = 25;

/**
 * The name this machine registers with the server as `clientName`, and the one
 * the pairing QR code names (CAN-2938). One helper so the two cannot differ.
 */
function resolvePortalMachineName(): string {
  return hostname() || BRAND.displayName;
}

const stateEvents = new EventEmitter();
let state: CanopyPortalState = {
  status: 'disabled',
  connectionStatus: 'inactive',
  sessionId: null,
  hostCode: null,
  pairingCode: null,
  pairingCodeExpiresAt: null,
  machineName: resolvePortalMachineName(),
  activatedAt: null,
  lastSeenAt: null,
  lastErrorAt: null,
  error: null,
};

let commandCursor = 0;
// Detached commands may advance the live polling cursor so later
// commands keep flowing, but the durable cursor stays behind the earliest
// detached sequence until its terminal event has a completed-command record.
// A restart therefore redelivers an interrupted command instead of losing it.
const deferredCommandSequences = new Set<number>();
let eventOutbox: PortalEventEnvelope[] = [];
let routingSequenceCounters = new Map<string, number>();
const PORTAL_DROPPED_COMMAND_TRACKING_MAX = 200;
const PORTAL_STATE_REQUEST_TRACKING_MAX = 500;
// `portal.state.request` commands. Only their dropped groups fail as
// retryable; a mutating command's dropped delta keeps its real completion.
const stateRequestCommandIds = new Set<string>();
// State requests a trim dropped before their completion was enqueued; the
// completion is rewritten as a retryable failure when it arrives.
const droppedStateCommandIds = new Set<string>();
// Why each recently trimmed state request was dropped, for delivery timing.
const droppedCommandDeliveries = new Map<string, PortalCommandGroupDrop>();
// The queued terminal standing for a dropped state request: its only receipt.
const droppedCommandFailures = new Map<string, PortalEventEnvelope>();
// Events of the batch being uploaded; trim keeps them until the upload
// settles.
let inFlightEvents: ReadonlySet<PortalEventEnvelope> = new Set();
let pollAbort = false;
// Epoch ms before which SSE command-stream attempts are suppressed. 0 = no
// suppression. Set after a transport fallback so long-poll takes over, and
// re-probed after a cooldown instead of staying sticky for the whole session
// (CAN-2359): one bad patch of edge weather must not lock a session into
// long-polling until portal restart. Worst-case re-probe latency is one
// in-flight long-poll cycle (~25s) past cooldown expiry, and worst-case
// re-probe cost is the 3-strike budget (~3s) once per cooldown.
export const SSE_COMMAND_FALLBACK_COOLDOWN_MS = 10 * 60_000;
export const SSE_COMMAND_FALLBACK_COOLDOWN_CAP_MS = 60 * 60_000;
let sseCommandsRetryAfterMs = 0;
let sseCommandFallbackStreak = 0;

export function shouldAttemptSseCommands(
  nowMs: number,
  retryAfterMs: number,
  flagEnabled: boolean,
): boolean {
  return flagEnabled && nowMs >= retryAfterMs;
}

/**
 * Escalates 10m -> 20m -> 40m -> 60m cap on consecutive fallbacks so an
 * environment that can never hold an SSE stream (e.g. a buffering proxy that
 * accepts connects but strands them) converges to ~1 probe/hour instead of
 * paying the worst-case ~3min probe window every 10 minutes forever — the
 * same never-escalates anti-pattern the browser terminal-relay fix removes.
 */
export function nextSseCommandRetryAfter(
  nowMs: number,
  consecutiveFallbacks: number,
): number {
  const exponent = Math.min(Math.max(consecutiveFallbacks, 1) - 1, 6);
  return (
    nowMs +
    Math.min(
      SSE_COMMAND_FALLBACK_COOLDOWN_CAP_MS,
      SSE_COMMAND_FALLBACK_COOLDOWN_MS * 2 ** exponent,
    )
  );
}
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let pollStallTimer: ReturnType<typeof setInterval> | null = null;
let codeExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let phonePairingGeneration = 0;
let phonePairingTelemetry:
  | { code: string; attempt: PairingTelemetryAttempt }
  | undefined;

function finishPhonePairingTelemetry(outcome: PairingTelemetryOutcome): void {
  phonePairingGeneration += 1;
  const tracking = phonePairingTelemetry;
  phonePairingTelemetry = undefined;
  tracking?.attempt.end(outcome);
}

function armPhonePairingTelemetry(code: string, additional: boolean): void {
  finishPhonePairingTelemetry('cancelled');
  const attempt = beginPairingTelemetry(startRemotePairingTelemetry, {
    pairing_kind: 'phone_code',
    pairing_entry: 'portal_modal',
    peer_platform: 'unknown',
    is_additional_device: additional,
  });
  if (attempt) phonePairingTelemetry = { code, attempt };
}

let cardEventGeneration = 0;
// Only this exact account-produced fence may clean up an in-flight operation.
// A later start/stop advances the generation again and owns the state instead.
let accountInvalidation:
  | { readonly generation: number; readonly operationGeneration: number }
  | undefined;
// Teardown must not disable a newer installed identity, but account-only
// invalidation must still let teardown finish for the same installed session.
let portalSessionIdentityGeneration = 0;
let cardEventAdapter: PortalCardEventAdapter | undefined;
function invalidateCardEvents(): void {
  invalidatePortalEmissionContexts();
  cardEventGeneration++;
  cardEventAdapter?.dispose();
  cardEventAdapter = undefined;
}
// The account entry the Portal last loaded or was told about; undefined until
// the first one, so an unknown predecessor is never treated as a change.
let knownAccount: CanopyCloudAccountEntry | null | undefined;
// An identity change (or sign-out) fences card events and an in-flight
// start/resume. A save that keeps the identity, such as the periodic
// enforced-settings re-probe, leaves them alone.
subscribeCanopyCloudAccountChanges((entry): void => {
  const previous = knownAccount;
  knownAccount = entry;
  if (
    entry !== null &&
    (previous === undefined ||
      (previous !== null && !hasCanopyCloudIdentityChanged(previous, entry)))
  )
    return;
  const operationGeneration =
    accountInvalidation?.generation === cardEventGeneration
      ? accountInvalidation.operationGeneration
      : cardEventGeneration;
  invalidateCardEvents();
  accountInvalidation = {
    generation: cardEventGeneration,
    operationGeneration,
  };
});
let unsubscribeFeatureEvents: (() => void) | null = null;
let unsubscribeProviderUsage: (() => void) | null = null;
let unsubscribeCanonicalTurnTimers: (() => void) | null = null;
let unsubscribeCanonicalTurnSummaries: (() => void) | null = null;
let getWindowForPortalCommands: () => BrowserWindow | null = getNullWindow;
let chatCommandDispatcher: DesktopCanopyDispatcher | undefined;
let outboxFlush: Promise<void> | null = null;
let outboxFlushRetryTimer: ReturnType<typeof setTimeout> | null = null;
let outboxFlushBackoffIndex = 0;
let outboxPersistTimer: ReturnType<typeof setTimeout> | null = null;
let startingPortal: Promise<StartCanopyPortalResponse> | null = null;
let pollAbortController: AbortController | null = null;
let heartbeatAbortController: AbortController | null = null;
let lastPollProgressAt = Date.now();
let lastOutboxLatencyDiagnosticAt = 0;
let lastTargetedPortalWorktreeKey: string | null = null;
const outboxEnqueuedAt = new WeakMap<PortalEventEnvelope, number>();

function getNullWindow(): BrowserWindow | null {
  return null;
}

export function setCanopyPortalWindowAccessor(
  getWindow: () => BrowserWindow | null,
): void {
  getWindowForPortalCommands = getWindow;
}

export function setCanopyPortalChatDispatcher(
  dispatcher: DesktopCanopyDispatcher,
): void {
  chatCommandDispatcher = dispatcher;
}

export function getCanopyPortalState(): CanopyPortalState {
  return { ...state };
}

export function onCanopyPortalStateChanged(
  listener: (state: CanopyPortalState) => void,
): () => void {
  stateEvents.on('changed', listener);
  return () => {
    stateEvents.off('changed', listener);
  };
}

function setState(patch: Partial<CanopyPortalState>): void {
  if (patch.sessionId !== undefined) portalSessionIdentityGeneration++;
  if (
    state.sessionId &&
    ((patch.sessionId !== undefined && patch.sessionId !== state.sessionId) ||
      patch.status === 'inactive' ||
      patch.status === 'disabled' ||
      patch.status === 'stopping')
  ) {
    portalFileReferences.clearSession(state.sessionId);
    closePortalAssetTransfers();
  }
  state = { ...state, ...patch };
  stateEvents.emit('changed', getCanopyPortalState());
}

function generatePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncatePortalString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = `\n\n[truncated ${value.length - maxChars} chars]`;
  let sliceEnd = Math.max(0, maxChars - suffix.length);
  const lastRetainedCodeUnit = value.charCodeAt(sliceEnd - 1);
  const firstDroppedCodeUnit = value.charCodeAt(sliceEnd);
  if (
    lastRetainedCodeUnit >= 0xd800 &&
    lastRetainedCodeUnit <= 0xdbff &&
    firstDroppedCodeUnit >= 0xdc00 &&
    firstDroppedCodeUnit <= 0xdfff
  ) {
    sliceEnd -= 1;
  }
  return `${value.slice(0, sliceEnd)}${suffix}`;
}

function summarizePortalJson(value: unknown): string {
  try {
    return truncatePortalString(
      JSON.stringify(value),
      PORTAL_OUTBOX_JSON_MAX_CHARS,
    );
  } catch {
    return truncatePortalString(String(value), PORTAL_OUTBOX_JSON_MAX_CHARS);
  }
}

function compactPortalJson(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return truncatePortalString(value, PORTAL_OUTBOX_JSON_MAX_CHARS);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (depth >= PORTAL_OUTBOX_JSON_MAX_DEPTH) {
    return summarizePortalJson(value);
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, PORTAL_OUTBOX_ARRAY_MAX_ITEMS)
      .map((item) => compactPortalJson(item, depth + 1));
    if (value.length > PORTAL_OUTBOX_ARRAY_MAX_ITEMS) {
      items.push(
        `[truncated ${value.length - PORTAL_OUTBOX_ARRAY_MAX_ITEMS} items]`,
      );
    }
    return items;
  }
  if (isRecord(value)) {
    const compacted: Record<string, unknown> = {};
    const entries = Object.entries(value);
    for (const [key, fieldValue] of entries.slice(
      0,
      PORTAL_OUTBOX_JSON_MAX_KEYS,
    )) {
      compacted[key] = compactPortalJson(fieldValue, depth + 1);
    }
    if (entries.length > PORTAL_OUTBOX_JSON_MAX_KEYS) {
      compacted._truncatedKeys = entries.length - PORTAL_OUTBOX_JSON_MAX_KEYS;
    }
    return compacted;
  }
  return summarizePortalJson(value);
}

/** Watcher attribution stays structured so cached Portal history can read it. */
function compactWatcherFired(value: unknown): ChatWatcherFiredInfo | undefined {
  const watcherFired = parseChatWatcherFiredInfo(value);
  if (!watcherFired) return undefined;
  const kind = truncatePortalString(
    watcherFired.kind,
    PORTAL_OUTBOX_WATCHER_TEXT_MAX_CHARS,
  );
  if (!watcherFired.combinedWatchers) return { kind };
  return {
    kind,
    combinedWatchers: watcherFired.combinedWatchers
      .slice(0, PORTAL_OUTBOX_ARRAY_MAX_ITEMS)
      .map((watcher) => ({
        kind: truncatePortalString(
          watcher.kind,
          PORTAL_OUTBOX_WATCHER_TEXT_MAX_CHARS,
        ),
        text: truncatePortalString(
          watcher.text,
          PORTAL_OUTBOX_WATCHER_TEXT_MAX_CHARS,
        ),
      })),
  };
}

/** A `mods_skipped` part's mods, kept structured: string entries, at most 50. */
function compactModsSkipped(value: unknown): PortalChatModsSkippedData['mods'] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) =>
      isRecord(entry) &&
      typeof entry.pluginId === 'string' &&
      typeof entry.reason === 'string'
        ? [
            {
              pluginId: truncatePortalString(
                entry.pluginId,
                PORTAL_OUTBOX_WATCHER_TEXT_MAX_CHARS,
              ),
              reason: truncatePortalString(
                entry.reason,
                PORTAL_OUTBOX_WATCHER_TEXT_MAX_CHARS,
              ),
            },
          ]
        : [],
    )
    .slice(0, 50);
}

/** A visual-bearing tool result reduced to its ids and reference. */
function visualOnlyPortalPart(part: unknown): unknown[] {
  if (!isRecord(part) || part.kind !== 'tool_result') return [];
  const visual = readPortalChatPartVisual({
    kind: 'tool_result',
    data: part.data,
  });
  if (!visual || !isRecord(part.data)) return [];
  const { toolUseId, messageId } = part.data;
  return [
    {
      kind: 'tool_result',
      data: {
        ...(typeof toolUseId === 'string' ? { toolUseId } : {}),
        ...(typeof messageId === 'string' ? { messageId } : {}),
        visual,
      },
    },
  ];
}

function compactPortalChatMessage(message: unknown): unknown {
  if (!isRecord(message)) {
    return message;
  }
  const sourceParts: readonly unknown[] | undefined = Array.isArray(
    message.parts,
  )
    ? message.parts
    : undefined;
  const compactedParts = sourceParts
    ? compactPortalChatParts(Array.from(sourceParts))
    : undefined;
  if (Array.isArray(compactedParts) && sourceParts) {
    for (
      let index = 0;
      index < sourceParts.length && index < compactedParts.length;
      index++
    ) {
      const part: unknown = sourceParts[index];
      const compacted: unknown = compactedParts[index];
      if (!isRecord(part) || !isRecord(compacted)) continue;
      const visual = readPortalChatPartVisual({
        kind: 'tool_result',
        data: part.kind === 'tool_result' ? part.data : undefined,
      });
      if (!visual) continue;
      compactedParts[index] = {
        ...compacted,
        data: { ...(isRecord(compacted.data) ? compacted.data : {}), visual },
      };
    }
    // A visual past the part cap would otherwise vanish from the transcript,
    // so keep it as a visual-only part ahead of the truncation marker.
    const lateVisuals = sourceParts
      .slice(PORTAL_OUTBOX_ARRAY_MAX_ITEMS)
      .flatMap(visualOnlyPortalPart)
      .slice(0, PORTAL_OUTBOX_ARRAY_MAX_ITEMS);
    if (lateVisuals.length > 0) {
      compactedParts.splice(PORTAL_OUTBOX_ARRAY_MAX_ITEMS, 0, ...lateVisuals);
    }
  }
  return {
    ...message,
    ...(typeof message.text === 'string'
      ? {
          text: truncatePortalString(message.text, PORTAL_CHAT_TEXT_MAX_CHARS),
        }
      : {}),
    ...(typeof message.content === 'string'
      ? {
          content: truncatePortalString(
            message.content,
            PORTAL_CHAT_TEXT_MAX_CHARS,
          ),
        }
      : {}),
    ...(message.watcherFired === undefined
      ? {}
      : { watcherFired: compactWatcherFired(message.watcherFired) }),
    ...(compactedParts === undefined ? {} : { parts: compactedParts }),
  };
}

/**
 * Compact previews while retaining validated locators, artifact receipts and
 * managed delegation cards. Inline tool results stay structured so their
 * error flags and read metadata survive preview truncation.
 */
function compactPortalChatParts(parts: unknown[]): unknown[] {
  const receiptBudget = { remaining: MAX_AGENT_ARTIFACT_METADATA_BYTES };
  const compacted = parts
    .slice(0, PORTAL_OUTBOX_ARRAY_MAX_ITEMS)
    .map((part) => compactPortalChatPart(part, receiptBudget));
  for (const part of parts.slice(
    PORTAL_OUTBOX_ARRAY_MAX_ITEMS,
    PORTAL_OUTBOX_ARRAY_MAX_ITEMS + 64,
  )) {
    if (!isRecord(part) || !isRecord(part.data)) continue;
    const data = part.data;
    const result =
      part.kind === 'tool_use' && isRecord(data.result)
        ? data.result
        : part.kind === 'tool_result'
          ? data
          : undefined;
    if (
      !result ||
      result.isError !== false ||
      !serializeAgentArtifactReceipts(result.agentArtifacts).length
    )
      continue;
    const normalized = compactPortalChatPart(part, receiptBudget);
    if (isRecord(normalized) && isRecord(normalized.data)) {
      const normalizedResult = isRecord(normalized.data.result)
        ? normalized.data.result
        : normalized.data;
      if (
        Array.isArray(normalizedResult.agentArtifacts) &&
        normalizedResult.agentArtifacts.length
      )
        compacted.push(normalized);
    }
  }
  if (parts.length > PORTAL_OUTBOX_ARRAY_MAX_ITEMS) {
    compacted.push(
      `[truncated ${parts.length - PORTAL_OUTBOX_ARRAY_MAX_ITEMS} items]`,
    );
  }
  return compacted;
}

type PortalOutputLocator = NonNullable<PortalChatPart['outputLocator']>;

function parsePortalOutputLocator(value: unknown): PortalOutputLocator | null {
  return readPortalToolOutputLocator(value) ?? null;
}

function compactPortalChatPart(
  part: unknown,
  receiptBudget = { remaining: MAX_AGENT_ARTIFACT_METADATA_BYTES },
): unknown {
  const delegationPart = projectPortalDelegationPart(part);
  if (
    delegationPart !== null ||
    (isRecord(part) &&
      part.kind === 'agent' &&
      isRecord(part.data) &&
      isRecord(part.data.delegation))
  ) {
    // A managed card must never enter generic compaction, even on failure.
    return delegationPart;
  }

  const occurrence = isRecord(part)
    ? readPortalToolOccurrence(part.occurrence)
    : undefined;
  const damagedOccurrence =
    isRecord(part) && part.occurrence !== undefined && !occurrence;
  const standaloneOutputLocator =
    isRecord(part) && part.kind === 'tool_result'
      ? damagedOccurrence
        ? null
        : parsePortalOutputLocator(part.outputLocator)
      : null;
  const generic = compactPortalJson(part, 1);
  // Rebuild read metadata, never retain an unvalidated generic copy.
  const compactedPart =
    isRecord(generic) &&
    isRecord(part) &&
    (part.kind === 'tool_use' || part.kind === 'tool_result')
      ? ((): Record<string, unknown> => {
          const preview = { ...generic };
          delete preview.occurrence;
          delete preview.outputLocator;
          return {
            ...preview,
            ...(occurrence ? { occurrence } : {}),
            ...(standaloneOutputLocator
              ? { outputLocator: standaloneOutputLocator }
              : {}),
          };
        })()
      : generic;
  if (
    isRecord(part) &&
    part.kind === 'prompt_source' &&
    isRecord(part.data) &&
    (part.data.watcherFired !== undefined ||
      part.data.autoResume !== undefined) &&
    isRecord(compactedPart) &&
    isRecord(compactedPart.data)
  ) {
    const data = { ...compactedPart.data };
    if (part.data.watcherFired !== undefined) {
      const watcherFired = compactWatcherFired(part.data.watcherFired);
      if (watcherFired) data.watcherFired = watcherFired;
      else delete data.watcherFired;
    }
    // Resume provenance sits past the depth limit; keep it validated and
    // structured so cached Portal history still renders the resume marker.
    if (part.data.autoResume !== undefined) {
      const autoResume = readAutoResumeMetadata(part.data.autoResume);
      if (autoResume) data.autoResume = autoResume;
      else delete data.autoResume;
    }
    return { ...compactedPart, data };
  }
  if (
    isRecord(part) &&
    part.kind === 'text' &&
    isRecord(part.data) &&
    part.data.modelAccessFailure !== undefined &&
    isRecord(compactedPart) &&
    isRecord(compactedPart.data)
  ) {
    // The Codex account model notice's carrier (CAN-4716) sits past the
    // depth limit; keep it validated and structured so the Portal renders
    // the notice instead of the raw provider error.
    const data = { ...compactedPart.data };
    const modelAccessFailure = readCodexAccountModelAccessFailure(
      part.data.modelAccessFailure,
    );
    if (modelAccessFailure) data.modelAccessFailure = modelAccessFailure;
    else delete data.modelAccessFailure;
    return { ...compactedPart, data };
  }
  if (
    isRecord(part) &&
    part.kind === 'mods_skipped' &&
    isRecord(part.data) &&
    isRecord(compactedPart) &&
    isRecord(compactedPart.data)
  ) {
    // The skipped mods sit past the depth limit; keep them validated and
    // structured so the Portal renders the skipped-Mod notice.
    const data = { ...compactedPart.data };
    const mods = compactModsSkipped(part.data.mods);
    if (mods.length) data.mods = mods;
    else delete data.mods;
    return { ...compactedPart, data };
  }
  if (
    isRecord(part) &&
    isRecord(part.data) &&
    isRecord(compactedPart) &&
    isRecord(compactedPart.data)
  ) {
    const source =
      part.kind === 'tool_use' && isRecord(part.data.result)
        ? part.data.result
        : part.kind === 'tool_result'
          ? part.data
          : undefined;
    // An inline result sits past the depth limit, so keep it structured
    // rather than serialized text that loses isError once truncated.
    if (
      source &&
      (part.kind === 'tool_use' ||
        Object.prototype.hasOwnProperty.call(source, 'agentArtifacts'))
    ) {
      const receipts =
        source.isError === false
          ? serializeAgentArtifactReceipts(source.agentArtifacts)
          : [];
      const bytes = new TextEncoder().encode(
        JSON.stringify(receipts),
      ).byteLength;
      const accepted = bytes <= receiptBudget.remaining ? receipts : [];
      if (accepted.length) receiptBudget.remaining -= bytes;
      const outputLocator =
        part.kind === 'tool_use' && !damagedOccurrence
          ? parsePortalOutputLocator(source.outputLocator)
          : null;
      const interruption = readToolInterruption(source.interruption);
      const isDelegateTask =
        part.kind === 'tool_use' &&
        typeof part.data.toolName === 'string' &&
        getCanonicalCanopyToolKey(part.data.toolName) === 'delegate_task';
      const result = {
        output:
          isDelegateTask || outputLocator
            ? compactPortalJson(source.output, 3)
            : typeof source.output === 'string'
              ? truncatePortalString(
                  source.output,
                  PORTAL_OUTBOX_JSON_MAX_CHARS,
                )
              : '',
        isError: source.isError === true,
        ...(interruption ? { interruption } : {}),
        ...(accepted.length ? { agentArtifacts: accepted } : {}),
        ...(outputLocator ? { outputLocator } : {}),
      };
      if (part.kind === 'tool_use')
        return { ...compactedPart, data: { ...compactedPart.data, result } };
      const data = { ...compactedPart.data, ...result };
      delete data.agentArtifacts;
      return {
        ...compactedPart,
        data: {
          ...data,
          ...(accepted.length ? { agentArtifacts: accepted } : {}),
        },
      };
    }
    // Interruption metadata also sits past the depth limit on a standalone
    // result; keep it validated so the Portal renders Interrupted, not Error.
    if (source && part.kind === 'tool_result' && 'interruption' in source) {
      const data = { ...compactedPart.data };
      const interruption = readToolInterruption(source.interruption);
      if (interruption) data.interruption = interruption;
      else delete data.interruption;
      return { ...compactedPart, data };
    }
  }
  return compactedPart;
}

export function compactPortalEvent(
  event: PortalEventEnvelope,
): PortalEventEnvelope {
  if (!isRecord(event.payload)) {
    return event;
  }

  if (
    event.type === 'portal.state.snapshot' &&
    Array.isArray(event.payload.chatMessages)
  ) {
    return {
      ...event,
      payload: {
        ...event.payload,
        chatMessages: event.payload.chatMessages
          .slice(-PORTAL_CHAT_SEED_MESSAGE_LIMIT)
          .map(compactPortalChatMessage),
      },
    };
  }

  if (
    (event.type === 'portal.chat.event' ||
      event.type === 'portal.app_advisor.event') &&
    isRecord(event.payload.message)
  ) {
    return {
      ...event,
      payload: {
        ...event.payload,
        message: compactPortalChatMessage(event.payload.message),
      },
    };
  }

  return event;
}

/**
 * Queues an event and returns the envelope that now stands for it in the
 * outbox: the stamped event, the retryable failure that replaced a dropped
 * state request's completion, or null when nothing was queued for it.
 */
function enqueueEvent(event: PortalEventEnvelope): PortalEventEnvelope | null {
  const commandId = event.commandId;
  const lateForDroppedGroup =
    commandId !== undefined && droppedStateCommandIds.has(commandId);
  const resolved = resolvePortalDroppedCommandEvent(
    event,
    droppedStateCommandIds,
  );
  if (!resolved) return null;
  // CAN-3535: NUL and lone UTF-16 surrogates are rejected by the server's
  // PostgreSQL JSONB/TEXT columns, which turned one such event into a head
  // batch the outbox retried forever. Sanitize once here, on the single path
  // every queued event takes, rather than on each flush. The server sanitizes
  // too and stays authoritative for desktop versions that predate this.
  const sanitized = sanitizePortalEventEnvelope(resolved);
  const compactedEvent = stampPortalEventRouting(
    compactPortalEvent(sanitized),
    routingSequenceCounters,
  );
  outboxEnqueuedAt.set(compactedEvent, Date.now());
  if (lateForDroppedGroup && commandId !== undefined) {
    droppedCommandFailures.set(commandId, compactedEvent);
  }
  eventOutbox.push(compactedEvent);
  const trimmed = trimEventOutbox();
  scheduleOutboxPersist();
  scheduleOutboxFlush();
  if (!trimmed || eventOutbox.includes(compactedEvent)) return compactedEvent;
  return (
    (isPortalControlEvent(compactedEvent) && commandId !== undefined
      ? droppedCommandFailures.get(commandId)
      : undefined) ?? null
  );
}

function recordStateRequestCommand(commandId: string): void {
  stateRequestCommandIds.add(commandId);
  rememberBounded(stateRequestCommandIds, PORTAL_STATE_REQUEST_TRACKING_MAX);
}

/** A dropped state request replays only its failure, never partial state. */
function commandReceipt(
  commandId: string,
  events: PortalEventEnvelope[],
): PortalEventEnvelope[] {
  if (!droppedCommandDeliveries.has(commandId)) return events;
  const failure = droppedCommandFailures.get(commandId);
  return failure
    ? [failure]
    : events.filter((event) => event.type === 'portal.command.failed');
}

function persistCommandReceipt(input: {
  commandId: string;
  sequence: number;
  events: PortalEventEnvelope[];
}): Promise<void> {
  return persistCompletedPortalCommand({
    ...input,
    events: commandReceipt(input.commandId, input.events),
  });
}

function commandCursorSafeToPersist(): number {
  let safeCursor = commandCursor;
  deferredCommandSequences.forEach((sequence) => {
    safeCursor = Math.min(safeCursor, sequence - 1);
  });
  return Math.max(0, safeCursor);
}

/**
 * Commands whose handler returns before the operation settles. Their receipt
 * and the durable cursor wait for the terminal event, so a desktop that exits
 * mid-operation is redelivered the command instead of skipping it.
 */
function isDetachedCommand(type: string): boolean {
  return (
    type === 'portal.terminal.open' ||
    type === 'portal.pipeline.run' ||
    type === 'portal.pipeline.cancel' ||
    type === 'portal.pipeline.resume' ||
    type === 'portal.pipeline.retry' ||
    type === 'portal.pipeline.rerun' ||
    type === 'portal.personal_organization.projects.convert'
  );
}

function isTerminalCommandEvent(event: PortalEventEnvelope): boolean {
  return (
    event.type === 'portal.command.completed' ||
    event.type === 'portal.command.failed'
  );
}

export async function enqueuePortalEventForTest(
  event: PortalEventEnvelope,
): Promise<PortalEventEnvelope | null> {
  const enqueuedEvent = enqueueEvent(event);
  if (outboxFlush) await outboxFlush;
  return enqueuedEvent;
}

function stampRestoredOutboxEvents(events: PortalEventEnvelope[]): void {
  const restoredAt = Date.now();
  for (const event of events) {
    outboxEnqueuedAt.set(event, restoredAt);
  }
}

export function getPortalEventWorktreeIdentityForTest(
  event: PortalEventEnvelope,
): PortalWorktreeIdentity | null {
  return getPortalEventWorktreeIdentity(event);
}

function recordStateRequestTarget(request: PortalStateRequestPayload): void {
  if (request.scope !== 'chat' && request.scope !== 'worktree') {
    return;
  }
  const workspaceLocalId = request.target?.workspaceLocalId;
  const worktreeLocalId = request.target?.worktreeLocalId;
  if (workspaceLocalId && worktreeLocalId) {
    // The latest chat/worktree snapshot target is treated as selected. Explicit
    // browser-selection plumbing is the documented upgrade path if fixture
    // measurements show this heuristic missing the foreground worktree.
    lastTargetedPortalWorktreeKey = portalWorktreeKey({
      workspaceLocalId,
      worktreeLocalId,
    });
  }
}

export function getLastTargetedPortalWorktreeKeyForTest(): string | null {
  return lastTargetedPortalWorktreeKey;
}

function recordAcknowledgedOutboxBatch(
  sessionId: string,
  batch: PortalEventEnvelope[],
  queueDepthAfterSelection: number,
): void {
  try {
    // Control-only batches (pure completion/failure signals, ~200 bytes) are
    // still sampled — they are the direct verification signal for the
    // CAN-2360 control-lane promotion — but labeled so dashboards can split
    // them from bulk upload-pressure measurements.
    const controlOnly = batch.length > 0 && batch.every(isPortalControlEvent);
    const acknowledgedAt = Date.now();
    const latenciesByKey = new Map<
      string,
      { identity: PortalWorktreeIdentity | null; latencies: number[] }
    >();
    let oldestEventAgeMs = 0;
    for (const event of batch) {
      const enqueuedAt = outboxEnqueuedAt.get(event);
      if (enqueuedAt === undefined) {
        continue;
      }
      const latency = Math.max(0, acknowledgedAt - enqueuedAt);
      oldestEventAgeMs = Math.max(oldestEventAgeMs, latency);
      const identity = getPortalEventWorktreeIdentity(event);
      const key = identity ? portalWorktreeKey(identity) : '';
      const aggregate = latenciesByKey.get(key) ?? { identity, latencies: [] };
      aggregate.latencies.push(latency);
      latenciesByKey.set(key, aggregate);
    }
    if (latenciesByKey.size === 0) {
      // Restored-from-disk events carry no enqueue stamps; an unmeasurable
      // batch must not consume the throttle window for the next real sample.
      return;
    }
    if (
      !shouldRecordPortalOutboxLatency(
        oldestEventAgeMs,
        acknowledgedAt,
        lastOutboxLatencyDiagnosticAt,
      )
    ) {
      return;
    }
    lastOutboxLatencyDiagnosticAt = acknowledgedAt;
    recordPortalOutboxUploadLatency({
      sessionId,
      batchSize: batch.length,
      queueDepthAfterSelection,
      oldestEventAgeMs,
      controlOnly,
      latencyAggregates: Array.from(latenciesByKey, ([, aggregate]) => ({
        ...(aggregate.identity ?? {}),
        meanEnqueueToAckMs:
          aggregate.latencies.reduce((sum, latency) => sum + latency, 0) /
          aggregate.latencies.length,
        maxEnqueueToAckMs: Math.max(...aggregate.latencies),
        eventCount: aggregate.latencies.length,
        selected: isPortalWorktreeIdentityForeground(
          aggregate.identity,
          lastTargetedPortalWorktreeKey,
        ),
      })),
    });
  } catch {
    // Diagnostics must never affect portal delivery.
  }
}

function rememberBounded<T>(
  collection: Set<T> | Map<T, unknown>,
  max = PORTAL_DROPPED_COMMAND_TRACKING_MAX,
): void {
  while (collection.size > max) {
    const oldest = collection.keys().next();
    if (oldest.done) return;
    collection.delete(oldest.value);
  }
}

function rememberDroppedCommandGroups(
  groups: PortalDroppedCommandGroup[],
  reason: 'count' | 'bytes',
): void {
  for (const group of groups) {
    droppedCommandDeliveries.set(group.commandId, {
      reason,
      eventTypes: group.eventTypes,
      chunkCount: group.chunkCount,
    });
    if (!group.failureEvent) {
      droppedStateCommandIds.add(group.commandId);
      continue;
    }
    droppedCommandFailures.set(group.commandId, group.failureEvent);
    // The build already finished, so its receipt may be durable; replace it
    // so a redelivery replays the failure, not partial state plus completed.
    const payload = group.failureEvent.payload;
    if (isRecord(payload) && typeof payload.sequenceNumber === 'number') {
      void persistCompletedPortalCommand({
        commandId: group.commandId,
        sequence: payload.sequenceNumber,
        events: [group.failureEvent],
      }).catch(() => undefined);
    }
  }
  rememberBounded(droppedCommandDeliveries);
  rememberBounded(droppedStateCommandIds);
  rememberBounded(droppedCommandFailures);
}

function resetCommandDeliveryTracking(): void {
  stateRequestCommandIds.clear();
  droppedStateCommandIds.clear();
  droppedCommandDeliveries.clear();
  droppedCommandFailures.clear();
}

function isCommandGroupQueued(commandId: string): boolean {
  return eventOutbox.some(
    (event) => event.commandId === commandId && !isPortalControlEvent(event),
  );
}

/** Returns whether the outbox was replaced. */
function trimEventOutbox(): boolean {
  const result = computePortalOutboxTrim(
    eventOutbox,
    PORTAL_OUTBOX_MAX_EVENTS,
    lastTargetedPortalWorktreeKey,
    outboxEnqueuedAt,
    undefined,
    {
      maxBytes: PORTAL_OUTBOX_MAX_BYTES,
      stateRequestCommandIds,
      inFlightEvents,
    },
  );
  // Coalescing runs even when nothing overflowed, so a compaction with zero
  // drops must still replace the outbox — otherwise a queue sitting just
  // under the byte budget keeps its redundant snapshots forever.
  if (result.droppedCount === 0 && result.coalescedSnapshotCount === 0) {
    return false;
  }
  eventOutbox = result.kept;
  stampRestoredOutboxEvents(
    eventOutbox.filter((event) => outboxEnqueuedAt.get(event) === undefined),
  );
  if (result.trimReason) {
    rememberDroppedCommandGroups(
      result.droppedCommandGroups,
      result.trimReason,
    );
  }
  // Surface the overflow: dropped chat events are unrecoverable transcript
  // gaps in the server cache. The browser self-heals these by re-requesting a
  // chat snapshot on tab open, but the drop must be visible for triage.
  //
  // A reclaim-only trim (no drops) is routine and fires on most enqueues once
  // snapshots start superseding each other, so it is throttled: recording each
  // one would add an app-diagnostic write per event, which is exactly the IO
  // pressure the reclaim exists to relieve.
  const now = Date.now();
  if (result.droppedCount === 0) {
    if (!shouldRecordPortalCoalesceDiagnostic(now, lastCoalesceDiagnosticAt)) {
      return true;
    }
    lastCoalesceDiagnosticAt = now;
  }
  getObservabilityService().recordAppDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'portal_outbox_overflow_trimmed',
    droppedCount: result.droppedCount,
    droppedChatEventCount: result.droppedChatEventCount,
    droppedRangeCount: result.droppedRangeCount,
    coalescedSnapshotCount: result.coalescedSnapshotCount,
    ...(result.trimReason
      ? {
          trimReason: result.trimReason,
          droppedEventTypes: result.droppedEventTypes,
          droppedChunkCount: result.droppedChunkCount,
          droppedCommandGroupCount: result.droppedCommandGroups.length,
          failedCommandCount: result.droppedCommandGroups.filter(
            (group) => group.failureQueued,
          ).length,
        }
      : {}),
    maxEvents: PORTAL_OUTBOX_MAX_EVENTS,
    maxBytes: PORTAL_OUTBOX_MAX_BYTES,
  });
  return true;
}

function persistOutboxNow(): Promise<void> {
  if (outboxPersistTimer) {
    clearTimeout(outboxPersistTimer);
    outboxPersistTimer = null;
  }
  return persistPortalEventOutbox(
    eventOutbox,
    routingSequenceCounters,
    stateRequestCommandIds,
  );
}

function scheduleOutboxPersist(): void {
  if (outboxPersistTimer) {
    return;
  }
  outboxPersistTimer = setTimeout(() => {
    outboxPersistTimer = null;
    void persistPortalEventOutbox(
      eventOutbox,
      routingSequenceCounters,
      stateRequestCommandIds,
    ).catch(() => undefined);
  }, PORTAL_OUTBOX_PERSIST_DEBOUNCE_MS);
}

function portalEventsRequestByteLength(events: PortalEventEnvelope[]): number {
  return Buffer.byteLength(JSON.stringify({ events }), 'utf8');
}

// `{"events":[a,b]}` is the empty envelope plus each event's own envelope
// body and one comma per extra event, so a batch is sized from cached
// per-event sizes instead of re-serializing it per candidate.
const PORTAL_EVENTS_REQUEST_EMPTY_BYTES = portalEventsRequestByteLength([]);

export function selectPortalEventBatchForTest(
  events: PortalEventEnvelope[],
  foregroundWorktreeKey: string | null = null,
  enqueuedAt: WeakMap<PortalEventEnvelope, number> = new WeakMap(),
  now = Date.now(),
): PortalEventEnvelope[] {
  const oldestEnqueuedAt = events[0] ? enqueuedAt.get(events[0]) : undefined;
  const useFifo =
    oldestEnqueuedAt !== undefined &&
    now - oldestEnqueuedAt >= PORTAL_OUTBOX_STARVATION_BOUND_MS;
  const batch: PortalEventEnvelope[] = [];
  // Control lane (CAN-2360): completed/failed events carry no entity state
  // and no routing identity, so under the rules below each one would be an
  // unscoped FIFO barrier — a completion could never jump a jumbo snapshot
  // already queued, which is exactly what starves the browser's 5s
  // wait-for-result. PROMOTED controls are selected first in both modes and
  // excluded from the barrier computation; a HELD-BACK control (one whose
  // command still has unsent non-control events ahead of it — snapshot and
  // follow-up chunks share the envelope commandId) stays in `rest` and still
  // barriers like any unscoped event, which is deliberately conservative.
  // This promotes "command-correlated events must carry `commandId`" from
  // convention to correctness invariant. The lane is capped so a burst of
  // completions can never starve the bulk lanes or the FIFO starvation bound.
  const heldBackCommandIds = new Set<string>();
  for (const event of events) {
    if (!isPortalControlEvent(event) && event.commandId !== undefined) {
      heldBackCommandIds.add(event.commandId);
    }
  }
  const controlLane: PortalEventEnvelope[] = [];
  for (const event of events) {
    if (controlLane.length >= PORTAL_CONTROL_LANE_MAX_COUNT) {
      break;
    }
    if (
      isPortalControlEvent(event) &&
      (event.commandId === undefined ||
        !heldBackCommandIds.has(event.commandId))
    ) {
      controlLane.push(event);
    }
  }
  // 'exhausted': every lane event selected, budget remains.
  // 'byte-limited': stopped on the byte target with lane events unselected.
  // 'full': count cap or byte target consumed — no further appends at all.
  type LaneResult = 'exhausted' | 'byte-limited' | 'full';
  let batchBytes = PORTAL_EVENTS_REQUEST_EMPTY_BYTES;
  const appendLane = (lane: PortalEventEnvelope[]): LaneResult => {
    for (const event of lane) {
      if (batch.length >= PORTAL_EVENT_BATCH_MAX_COUNT) {
        return 'full';
      }
      const nextBytes =
        batchBytes +
        cachedPortalEventByteLength(event) -
        PORTAL_EVENTS_REQUEST_EMPTY_BYTES +
        (batch.length > 0 ? 1 : 0);
      if (batch.length > 0 && nextBytes > PORTAL_EVENT_BATCH_TARGET_BYTES) {
        return 'byte-limited';
      }
      batch.push(event);
      batchBytes = nextBytes;
      if (nextBytes >= PORTAL_EVENT_BATCH_TARGET_BYTES) {
        return 'full';
      }
    }
    return 'exhausted';
  };
  appendLane(controlLane);
  const selectedControls = new Set(batch);
  const rest = events.filter((event) => !selectedControls.has(event));
  if (useFifo) {
    appendLane(rest);
  } else {
    // Unscoped events (overview/workspace/multi-worktree snapshots) overlap
    // EVERY routing key, and web projection is last-write-wins without
    // per-entity revision guards — so nothing may be promoted across one:
    // an older overlapping snapshot uploaded after a newer targeted delta
    // would restore stale state. Treat the first unscoped event as an
    // ordering barrier: priority reordering applies only to the prefix
    // before it; the barrier and everything after stays in FIFO order.
    const firstUnscopedIndex = rest.findIndex(
      (event) => getPortalEventWorktreeIdentity(event) === null,
    );
    const prioritizable =
      firstUnscopedIndex === -1 ? rest : rest.slice(0, firstUnscopedIndex);
    const fifoTail =
      firstUnscopedIndex === -1 ? [] : rest.slice(firstUnscopedIndex);
    const foregroundResult = appendLane(
      prioritizable.filter((event) =>
        isPortalEventForeground(event, foregroundWorktreeKey),
      ),
    );
    if (foregroundResult !== 'full') {
      const backgroundResult = appendLane(
        prioritizable.filter(
          (event) => !isPortalEventForeground(event, foregroundWorktreeKey),
        ),
      );
      // The tail begins with the unscoped barrier. It may only follow when
      // EVERY pre-barrier event was selected: appending it past an
      // unselected older event would deliver the (newer) unscoped snapshot
      // first, letting the older event later overwrite newer state.
      if (
        foregroundResult === 'exhausted' &&
        backgroundResult === 'exhausted'
      ) {
        appendLane(fifoTail);
      }
    }
  }
  return batch.length > 0 ? batch : events.slice(0, 1);
}

export function removePortalEventBatchForTest(
  events: PortalEventEnvelope[],
  batch: PortalEventEnvelope[],
): PortalEventEnvelope[] {
  const selectedCounts = new Map<PortalEventEnvelope, number>();
  for (const event of batch) {
    selectedCounts.set(event, (selectedCounts.get(event) ?? 0) + 1);
  }
  return events.filter((event) => {
    const remaining = selectedCounts.get(event) ?? 0;
    if (remaining === 0) {
      return true;
    }
    selectedCounts.set(event, remaining - 1);
    return false;
  });
}

async function flushOutboxOnce(): Promise<void> {
  if (!state.sessionId || eventOutbox.length === 0) {
    return;
  }

  let oversizedIndex = eventOutbox.findIndex(
    (event) =>
      cachedPortalEventByteLength(event) > PORTAL_EVENT_BATCH_MAX_BYTES,
  );
  while (oversizedIndex >= 0) {
    const oversized = eventOutbox[oversizedIndex];
    // Oversized snapshots are recovered by splitting (snapshot head + delta
    // chunks) instead of being dropped — a dropped worktree snapshot left the
    // browser permanently empty for that worktree. Only genuinely
    // unsplittable events still fall through to the drop-with-diagnostic.
    const split = splitOversizedPortalSnapshotEvent(
      oversized,
      PORTAL_EVENT_BATCH_MAX_BYTES,
    );
    if (
      split !== null &&
      (split.events.length > 1 ||
        split.events[0] !== oversized ||
        split.droppedEntityCount > 0)
    ) {
      const replacementEvents = [
        ...split.events,
        ...(split.droppedEntityMarker ? [split.droppedEntityMarker] : []),
      ];
      const enqueuedAt = outboxEnqueuedAt.get(oversized);
      if (enqueuedAt !== undefined) {
        for (const part of replacementEvents) {
          outboxEnqueuedAt.set(part, enqueuedAt);
        }
      }
      eventOutbox = [
        ...eventOutbox.slice(0, oversizedIndex),
        ...replacementEvents,
        ...eventOutbox.slice(oversizedIndex + 1),
      ];
      oversizedIndex = eventOutbox.findIndex(
        (event) =>
          cachedPortalEventByteLength(event) > PORTAL_EVENT_BATCH_MAX_BYTES,
      );
      continue;
    }
    const marked = createDroppedRangeMarkers({
      kept: [
        ...eventOutbox.slice(0, oversizedIndex),
        ...eventOutbox.slice(oversizedIndex + 1),
      ],
      dropped: [oversized],
      reason: 'oversized',
      createEventId: () => `portal-drop-oversized-${randomUUID()}`,
      enqueuedAt: outboxEnqueuedAt,
    });
    const oversizedMarkers = marked.events.filter(
      (event) =>
        String(event.type) === 'portal.events.dropped' &&
        cachedPortalEventByteLength(event) > PORTAL_EVENT_BATCH_MAX_BYTES,
    );
    eventOutbox = marked.events.filter(
      (event) => !oversizedMarkers.includes(event),
    );
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'portal_oversized_event_dropped',
      portalEventType: oversized.type,
      bytes: cachedPortalEventByteLength(oversized),
      thresholdBytes: PORTAL_EVENT_BATCH_MAX_BYTES,
      droppedRangeCount: marked.markerCount - oversizedMarkers.length,
    });
    oversizedIndex = eventOutbox.findIndex(
      (event) =>
        cachedPortalEventByteLength(event) > PORTAL_EVENT_BATCH_MAX_BYTES,
    );
  }
  trimEventOutbox();
  if (eventOutbox.length === 0) {
    await persistOutboxNow().catch(() => undefined);
    return;
  }

  const batch = selectPortalEventBatchForTest(
    eventOutbox,
    lastTargetedPortalWorktreeKey,
    outboxEnqueuedAt,
  );
  // Snapshot before awaiting the upload: events enqueued while the request is
  // in flight must not inflate the queue-pressure measurement.
  const queueDepthAfterSelection = Math.max(
    0,
    eventOutbox.length - batch.length,
  );
  inFlightEvents = new Set(batch);
  try {
    await sendPortalEvents({
      sessionId: state.sessionId,
      request: { events: batch },
    });
  } finally {
    inFlightEvents = new Set();
  }
  recordAcknowledgedOutboxBatch(
    state.sessionId,
    batch,
    queueDepthAfterSelection,
  );
  eventOutbox = removePortalEventBatchForTest(eventOutbox, batch);
  // Debounced: re-serializing the whole store after every upload is main-
  // thread work proportional to the outbox. Losing this write only re-sends
  // uploaded events after a crash, which the server deduplicates by id.
  scheduleOutboxPersist();
  if (outboxFlushRetryTimer) {
    clearTimeout(outboxFlushRetryTimer);
    outboxFlushRetryTimer = null;
  }
  outboxFlushBackoffIndex = 0;
  setState({
    status: state.status === 'reconnecting' ? 'active' : state.status,
    connectionStatus: 'active',
    lastSeenAt: new Date().toISOString(),
    error: null,
  });
}

async function flushOutbox(): Promise<void> {
  if (outboxFlush) {
    await outboxFlush;
    return;
  }
  outboxFlush = flushOutboxOnce().finally(() => {
    outboxFlush = null;
  });
  await outboxFlush;
}

export async function flushPortalOutboxForTest(): Promise<void> {
  await flushOutbox();
}

/**
 * Whether `portal.state.request` builds run on the async snapshot lane
 * (CAN-2360) instead of inline in the serial command loop.
 */
function isAsyncSnapshotsEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyPortalAsyncSnapshots.key,
  );
}

function snapshotSchedulingMode(): 'keyed' | 'serial' {
  return getBrandEnv(process.env, 'PORTAL_SNAPSHOT_SCHEDULER') === 'serial'
    ? 'serial'
    : 'keyed';
}

async function flushOutboxBeforeNextCommandBatch(): Promise<void> {
  if (isAsyncSnapshotsEnabled() && snapshotSchedulingMode() === 'keyed') {
    // Fence cursor advancement on local durability, not network delivery.
    // Completed-command records only replay on redelivery; once the cursor
    // passes a command, restart restores its unsent events from the outbox.
    // Let local persistence errors propagate so the cursor remains behind.
    await persistOutboxNow();
    // Receiving the next selected request must not wait for an unrelated
    // snapshot's upload. The existing single-flight sender owns ordering,
    // retries and error handling; only the command receive loop is released.
    scheduleOutboxFlush();
  } else {
    await flushOutbox();
  }
}

/**
 * Failure routing for the async snapshot lane. Flush-phase errors get the
 * same treatment as the poll loop's transport errors: inactive-session and
 * 404 tear the session down through the shared handlers, anything else is a
 * network blip — mark it and let the outbox's own scheduled flush retry with
 * backoff (the events are still queued). Execute/persist-phase errors need
 * no routing here: the lane already synthesized a terminal
 * portal.command.failed for the browser.
 */
function handleSnapshotLaneError(
  error: unknown,
  phase: PortalSnapshotLaneErrorPhase,
): void {
  if (phase !== 'flush') {
    return;
  }
  if (isInactiveSessionResponse(error)) {
    // CAN-2651: probe before tearing down; a revived session just retries.
    void handleInactiveSessionResponse()
      .then((outcome) => {
        if (outcome === 'revived') {
          scheduleOutboxFlush();
        }
      })
      .catch(() => undefined);
    return;
  }
  if (error instanceof CanopyPortalClientError && error.status === 404) {
    void clearActivePortalSession('replaced')
      .catch(() => undefined)
      .then(() => stopCanopyPortal('replaced'))
      .catch(() => undefined);
    return;
  }
  markNetworkFailure(error);
  scheduleOutboxFlush();
}

export function handleSnapshotLaneErrorForTest(
  error: unknown,
  phase: PortalSnapshotLaneErrorPhase,
): void {
  handleSnapshotLaneError(error, phase);
}

// Async snapshot lane (CAN-2360): a large-workspace snapshot build takes
// 6-28s, and inline in the serial loop it blocks every command queued behind
// it. Keyed scheduling preserves overlapping snapshot ordering; the epoch reset
// (wired into stopCanopyPortal/transitionInactiveFromServer) ties in-flight
// builds to the session that requested them.
const snapshotLane = createPortalSnapshotLane({
  mode: snapshotSchedulingMode,
  recordScheduling: recordPortalSnapshotTiming,
  onForegroundBusy: (busy) => portalSnapshotWorkBudget.setForegroundBusy(busy),
  execute: executePortalStateRequest,
  enqueueEvent: (event) => enqueueEvent(event),
  flushOutbox: () => flushOutbox(),
  persistCompletedCommand: (input) => persistCommandReceipt(input),
  isCommandGroupQueued,
  droppedCommandGroup: (commandId) => droppedCommandDeliveries.get(commandId),
  outboxDepth: () => eventOutbox.length,
  recordTiming: recordPortalSnapshotTiming,
  now: () => performance.now(),
  buildFailureEvent: (command) =>
    createPortalCommandEvent(
      command,
      'portal.command.failed',
      createCommandFailedPayload(
        command,
        'execution_failed',
        'Unable to prepare the requested state. Reconnect and try again.',
        false,
      ),
    ),
  onError: handleSnapshotLaneError,
});

function scheduleOutboxFlush(): void {
  if (outboxFlush || outboxFlushRetryTimer || eventOutbox.length === 0) {
    return;
  }
  outboxFlush = flushOutboxOnce()
    .catch((error) => {
      if (isInactiveSessionResponse(error)) {
        // CAN-2651: this is the request that lands first on reconnect (the
        // poll loop flushes the outbox at the top of every iteration), so a
        // 409 here is the single most likely place a recoverable stale flag
        // gets mistaken for a teardown. Arm the retry timer BEFORE probing so
        // the `finally` below cannot re-enter the flush while the probe is in
        // flight; a terminal probe clears the timer via `clearTimers`.
        const probeDelay =
          BACKOFF_MS[Math.min(outboxFlushBackoffIndex, BACKOFF_MS.length - 1)];
        outboxFlushBackoffIndex += 1;
        outboxFlushRetryTimer = setTimeout(() => {
          outboxFlushRetryTimer = null;
          scheduleOutboxFlush();
        }, probeDelay);
        void handleInactiveSessionResponse().catch(() => undefined);
        return;
      }
      markNetworkFailure(error);
      const delay =
        BACKOFF_MS[Math.min(outboxFlushBackoffIndex, BACKOFF_MS.length - 1)];
      outboxFlushBackoffIndex += 1;
      outboxFlushRetryTimer = setTimeout(() => {
        outboxFlushRetryTimer = null;
        scheduleOutboxFlush();
      }, delay);
    })
    .finally(() => {
      outboxFlush = null;
      if (eventOutbox.length > 0 && !pollAbort && !outboxFlushRetryTimer) {
        scheduleOutboxFlush();
      }
    });
}

function markNetworkFailure(error: unknown): void {
  if (state.status === 'active') {
    setState({ status: 'reconnecting', connectionStatus: 'reconnecting' });
  }
  setState({
    lastErrorAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  });
}

function markNetworkSuccess(patch: Partial<CanopyPortalState> = {}): void {
  setState({
    status: state.status === 'reconnecting' ? 'active' : state.status,
    connectionStatus: 'active',
    lastSeenAt: new Date().toISOString(),
    error: null,
    ...patch,
  });
}

function isInactiveSessionResponse(error: unknown): boolean {
  return (
    error instanceof CanopyPortalClientError &&
    error.status === 409 &&
    /Portal session is inactive\./i.test(error.message)
  );
}

/**
 * Outcome of a one-shot heartbeat probe (CAN-2651).
 *
 * - `active` — the server reports a live session (it reactivates a merely
 *   stale row on any desktop-facing request), so whatever 409'd is recoverable.
 * - `inactive` — the server considers the session terminal.
 * - `unavailable` — the probe itself could not be completed (no session id, or
 *   a transport failure). Deliberately NOT terminal: a network blip during the
 *   probe must not be the thing that ends a session.
 */
type PortalHeartbeatProbe = 'active' | 'inactive' | 'unavailable';

/**
 * Fire a heartbeat right now, outside the {@link scheduleHeartbeat} cadence.
 *
 * Used both to heal a stale-but-revivable session and to disambiguate a 409:
 * the heartbeat route reactivates an INACTIVE-but-not-ENDED row, so a single
 * heartbeat is what flips the session back to ACTIVE server-side.
 */
async function sendHeartbeatNow(
  expectedSessionId = state.sessionId,
): Promise<PortalHeartbeatProbe> {
  const sessionId = expectedSessionId;
  if (!sessionId || pollAbort || state.sessionId !== sessionId) {
    return 'unavailable';
  }
  try {
    const clientPlatform = resolvePortalClientPlatform();
    const response = await sendPortalHeartbeat({
      sessionId,
      capabilities: portalSessionCapabilities(),
      clientVersion: app.getVersion(),
      ...(clientPlatform === undefined ? {} : { clientPlatform }),
    });
    if (pollAbort || state.sessionId !== sessionId) {
      return 'unavailable';
    }
    if (response.status === 'inactive') {
      return 'inactive';
    }
    markNetworkSuccess(
      isPortalHostCode(response.hostCode)
        ? { hostCode: response.hostCode }
        : {},
    );
    return 'active';
  } catch (error) {
    if (pollAbort || state.sessionId !== sessionId) {
      return 'unavailable';
    }
    if (isInactiveSessionResponse(error)) {
      return 'inactive';
    }
    markNetworkFailure(error);
    return 'unavailable';
  }
}

let inactiveSessionProbe: {
  sessionId: string;
  promise: Promise<'revived' | 'terminal'>;
} | null = null;

/**
 * Route a `409 Portal session is inactive.` response (CAN-2651).
 *
 * The every-minute server sweep flips a session whose heartbeat lapsed past 90s
 * to INACTIVE but deliberately leaves it revivable (`endedAt` stays null). After
 * a sleep or a Wi-Fi drop the first request to land on reconnect is the outbox
 * flush, so a 409 there is far more often that recoverable stale flag than a
 * real teardown — and treating it as terminal is what silently killed live
 * sessions.
 *
 * Probe with a single heartbeat instead: a live reply means the server revived
 * the row, so stay connected and let the caller retry on its existing backoff.
 * Only an explicitly `inactive` reply tears the session down. This is also what
 * protects a new desktop talking to a server that predates the events-route
 * revival fix — there, the heartbeat itself performs the revival.
 *
 * Single-flighted: five independent call sites (poll loop, outbox flush,
 * snapshot lane, SSE transport connect, SSE transport stream) can 409 within
 * the same instant and must not each mint their own probe.
 */
async function handleInactiveSessionResponse(): Promise<
  'revived' | 'terminal'
> {
  const sessionId = state.sessionId;
  if (pollAbort || !sessionId) {
    return 'terminal';
  }
  const existing = inactiveSessionProbe;
  if (existing?.sessionId === sessionId) {
    return existing.promise;
  }
  const probe = (async (): Promise<'revived' | 'terminal'> => {
    const heartbeat = await sendHeartbeatNow(sessionId);
    // A stop/re-pair can complete while the heartbeat is in flight. Stop the
    // old caller without mutating or joining the replacement session.
    if (pollAbort || state.sessionId !== sessionId) {
      return 'terminal';
    }
    if (heartbeat !== 'inactive') {
      return 'revived';
    }
    await transitionInactiveFromServer();
    return 'terminal';
  })();
  const entry = { sessionId, promise: probe };
  inactiveSessionProbe = entry;
  try {
    return await probe;
  } finally {
    if (inactiveSessionProbe === entry) {
      inactiveSessionProbe = null;
    }
  }
}

/**
 * Minimal structural subset of Electron's `powerMonitor`, so this module keeps
 * no direct `electron` runtime import and stays unit-testable with an injected
 * stub.
 */
export interface PortalPowerMonitor {
  on(event: 'resume', listener: () => void): void;
  removeListener(event: 'resume', listener: () => void): void;
}

let portalPowerMonitor: PortalPowerMonitor | null = null;
let portalPowerResumeListener: (() => void) | null = null;

/**
 * Inject the process-wide power monitor whose `resume` event drives portal wake
 * recovery. Called once from `main/index.ts`; pass `null` to detach (tests).
 */
export function setCanopyPortalPowerMonitor(
  monitor: PortalPowerMonitor | null,
): void {
  releasePowerResumeListener();
  portalPowerMonitor = monitor;
  if (monitor && state.sessionId && !pollAbort) {
    armPowerResumeListener();
  }
}

function armPowerResumeListener(): void {
  if (!portalPowerMonitor || portalPowerResumeListener) {
    return;
  }
  const listener = (): void => {
    void handlePowerResume();
  };
  portalPowerResumeListener = listener;
  portalPowerMonitor.on('resume', listener);
}

function releasePowerResumeListener(): void {
  if (portalPowerMonitor && portalPowerResumeListener) {
    portalPowerMonitor.removeListener('resume', portalPowerResumeListener);
  }
  portalPowerResumeListener = null;
}

/**
 * Wake recovery (CAN-2651). `heartbeatTimer` is a `setTimeout` chain and the
 * long-poll await both freeze across sleep, so a >90s suspend lands the desktop
 * past the server's reap threshold with nothing in flight to notice. On resume:
 * drop the (likely OS-killed) in-flight poll socket so the loop reconnects
 * immediately, then heartbeat right away — which reactivates the row
 * server-side before the session can be treated as gone.
 */
async function handlePowerResume(): Promise<void> {
  if (pollAbort || !state.sessionId) {
    return;
  }
  pollAbortController?.abort();
  pollAbortController = null;
  lastPollProgressAt = Date.now();
  const probe = await sendHeartbeatNow();
  if (pollAbort) {
    return;
  }
  if (probe === 'inactive') {
    await transitionInactiveFromServer();
    return;
  }
  // Re-arm the cadence from now so the next beat is a full interval away
  // rather than whatever remained on the frozen timer.
  startHeartbeat();
}

/** Test seam: drive the `powerMonitor` `resume` path without Electron. */
export async function handlePortalPowerResumeForTest(): Promise<void> {
  await handlePowerResume();
}

async function transitionInactiveFromServer(): Promise<void> {
  finishPhonePairingTelemetry('failed');
  invalidateCardEvents();
  if (state.sessionId) portalFileReferences.clearSession(state.sessionId);
  closePortalAssetTransfers();
  pollAbort = true;
  clearTimers();
  snapshotLane.reset();
  setCanopyPortalEventSink(null);
  unsubscribeFeatureEventSinks();
  const sessionGeneration = portalSessionIdentityGeneration;
  eventOutbox = [];
  routingSequenceCounters = new Map();
  resetCommandDeliveryTracking();
  commandCursor = 0;
  deferredCommandSequences.clear();
  await Promise.all([
    persistPortalEventOutbox(eventOutbox, routingSequenceCounters).catch(
      () => undefined,
    ),
    clearActivePortalSession('server_disconnect').catch(() => undefined),
  ]);
  if (sessionGeneration !== portalSessionIdentityGeneration) return;
  setState({
    status: 'inactive',
    connectionStatus: 'inactive',
    sessionId: null,
    hostCode: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    activatedAt: null,
    lastSeenAt: null,
    lastErrorAt: new Date().toISOString(),
    error: `${portalDisplayName} session ended on the server.`,
  });
}

/**
 * Apply one command-poll response — from either transport (HTTP long-poll or the
 * SSE stream). Handles inactive-session teardown, connection-status updates, and
 * per-command processing (expired skip, completed-command replay, dispatch,
 * cursor persistence). Returns `'stopped'` when the portal was torn down or is
 * aborting, else `'ok'`. This is the single shared processor so both transports
 * behave identically.
 */
async function applyPollResponse(
  response: PollPortalCommandsResponse,
): Promise<'ok' | 'stopped'> {
  lastPollProgressAt = Date.now();
  if (response.session.status === 'inactive') {
    // CAN-2651: `status: 'inactive'` on its own is NOT terminal. The sweep
    // flips a session whose heartbeat lapsed past 90s to INACTIVE while
    // leaving it revivable; `connectionStatus` is the field that
    // discriminates (`derivePortalConnectionStatus` returns `'ended'` only
    // when `endedAt` is set or the row is ENDED). Tearing down here — and
    // `stopCanopyPortal` also POSTs `end` — is what let the desktop finish
    // the job the sweep started, landing on the silent `disabled` state.
    if (response.session.connectionStatus === 'ended') {
      await transitionInactiveFromServer();
      return 'stopped';
    }
    setState({
      status: state.status === 'active' ? 'reconnecting' : state.status,
      connectionStatus: 'reconnecting',
      lastSeenAt: response.session.lastSeenAt,
    });
    // Heal it in place: a heartbeat reactivates the row server-side. The
    // command cursor is untouched, so anything queued behind this response is
    // redelivered on the next poll. Awaited so a persistently stale session
    // paces the loop instead of spinning.
    if ((await sendHeartbeatNow()) === 'inactive') {
      await transitionInactiveFromServer();
      return 'stopped';
    }
    return 'ok';
  }

  if (response.session.connectionStatus === 'active') {
    markNetworkSuccess({ lastSeenAt: response.session.lastSeenAt });
  } else {
    setState({
      connectionStatus: response.session.connectionStatus,
      lastSeenAt: response.session.lastSeenAt,
      error: null,
    });
  }

  for (const command of response.commands) {
    if (pollAbort) {
      return 'stopped';
    }

    const commandReceivedAt = performance.now();
    if (command.type === 'portal.state.request') {
      recordStateRequestCommand(command.id);
      recordPortalSnapshotTiming({
        commandId: command.id,
        stage: 'command_received',
        elapsedMs: elapsedSinceTimestamp(command.createdAt),
      });
    }

    const completed = await readCompletedPortalCommand(command.id).catch(
      () => null,
    );
    if (completed) {
      for (const event of completed.events) {
        enqueueEvent(event);
      }
      await flushOutboxBeforeNextCommandBatch();
      if (pollAbort) {
        return 'stopped';
      }
      commandCursor = Math.max(commandCursor, command.sequence);
      await persistPortalCommandCursor({
        commandCursor: commandCursorSafeToPersist(),
        lastSeenAt: response.session.lastSeenAt,
      }).catch(() => undefined);
      continue;
    }

    if (command.status === 'expired' || command.status === 'failed') {
      if (
        command.type === 'portal.worktree.create' ||
        command.type === 'portal.state.request' ||
        command.type === 'portal.chat.send' ||
        command.type === 'portal.chat.answer_question' ||
        command.type === 'portal.chat.dismiss_question' ||
        command.type === 'portal.pipeline.run' ||
        command.type === 'portal.pipeline.cancel' ||
        command.type === 'portal.pipeline.resume' ||
        command.type === 'portal.pipeline.retry' ||
        command.type === 'portal.pipeline.rerun'
      ) {
        const failureEvent = createPortalCommandEvent(
          command,
          'portal.command.failed',
          createCommandFailedPayload(
            command,
            'execution_failed',
            command.status === 'expired'
              ? 'The request expired before it completed. Check the current state, then try again.'
              : 'The request could not be delivered. Check the current state, then try again.',
            false,
          ),
        );
        const stampedFailureEvent = enqueueEvent(failureEvent);
        await persistCompletedPortalCommand({
          commandId: command.id,
          sequence: command.sequence,
          events: stampedFailureEvent ? [stampedFailureEvent] : [],
        });
        await flushOutbox();
      }
      commandCursor = Math.max(commandCursor, command.sequence);
      await persistPortalCommandCursor({
        commandCursor: commandCursorSafeToPersist(),
        lastSeenAt: response.session.lastSeenAt,
      }).catch(() => undefined);
      continue;
    }

    if (
      command.type === 'portal.state.request' &&
      isAsyncSnapshotsEnabled() &&
      validatePortalCommandProvenance(command).ok
    ) {
      const request = normalizeStateRequestPayload(
        command.payload,
        command.target,
      );
      // Foreground prioritization must not wait for the build: the outbox
      // picks foreground batches from the latest requested target, so record
      // it at hand-off, not when the lane gets around to building. With
      // several state.requests in one poll batch this means the NEWEST
      // target wins foreground classification while earlier builds are still
      // queued — intended, since it matches what the user is looking at now.
      recordStateRequestTarget(request);
      snapshotLane.enqueue({
        command,
        request,
        receivedAtPerf: commandReceivedAt,
      });
      // The cursor advances at hand-off — a WEAKER recovery surface than the
      // inline path. Today a crash mid-build leaves the cursor behind the
      // command, so the next poll redelivers it, the expired/failed branch
      // above fires, and the browser receives portal.command.failed. A
      // handed-off command that dies with the process is NEVER redelivered
      // (the cursor is already persisted past it), so no terminal signal is
      // ever sent for it; the browser recovers through its own guards
      // instead (5s route timeout, repair retries, 60s hydration cap).
      // Possible follow-up: persist a handed-off marker so a restart can
      // synthesize the failure event.
      commandCursor = Math.max(commandCursor, command.sequence);
      await persistPortalCommandCursor({
        commandCursor: commandCursorSafeToPersist(),
        lastSeenAt: response.session.lastSeenAt,
      }).catch(() => undefined);
      continue;
    }

    const commandEvents: PortalEventEnvelope[] = [];
    const commandSessionId = state.sessionId;
    const commandSessionGeneration = portalSessionIdentityGeneration;
    let deferred = false;
    let finalizing = false;
    let acceptingCommandEvents = true;
    const finalizeDeferredCommand = async (): Promise<void> => {
      if (
        finalizing ||
        state.sessionId !== commandSessionId ||
        portalSessionIdentityGeneration !== commandSessionGeneration ||
        pollAbort
      )
        return;
      finalizing = true;
      acceptingCommandEvents = false;
      try {
        await persistCommandReceipt({
          commandId: command.id,
          sequence: command.sequence,
          events: commandEvents,
        });
        deferredCommandSequences.delete(command.sequence);
        await persistPortalCommandCursor({
          commandCursor: commandCursorSafeToPersist(),
          lastSeenAt: response.session.lastSeenAt,
        }).catch(() => undefined);
      } catch {
        finalizing = false;
        return;
      }
      await flushOutbox().catch(() => undefined);
    };
    const enqueueCommandEvent = (event: PortalEventEnvelope): void => {
      if (
        state.sessionId !== commandSessionId ||
        portalSessionIdentityGeneration !== commandSessionGeneration ||
        pollAbort
      )
        return;
      const enqueuedEvent = enqueueEvent(event);
      if (acceptingCommandEvents) {
        if (enqueuedEvent) commandEvents.push(enqueuedEvent);
        if (isTerminalCommandEvent(event)) {
          acceptingCommandEvents = false;
          if (deferred) {
            void finalizeDeferredCommand();
          }
        }
      }
    };

    const canReadSession = (): boolean =>
      state.status === 'active' &&
      state.sessionId === commandSessionId &&
      portalSessionIdentityGeneration === commandSessionGeneration &&
      !pollAbort;
    const pairingAtCommand = phonePairingTelemetry;
    await handlePortalCommand(command, {
      sessionId: commandSessionId ?? undefined,
      chatDispatcher: chatCommandDispatcher,
      canReadAssets: canReadSession,
      canMutateResources: canReadSession,
      canReadTranscripts: canReadSession,
      pairingCode: state.pairingCode,
      getWindow: getWindowForPortalCommands,
      enqueueEvent: enqueueCommandEvent,
      markAuthenticated: () => {
        if (
          command.type === 'portal.auth.validate_code' &&
          pairingAtCommand !== undefined &&
          pairingAtCommand === phonePairingTelemetry &&
          state.pairingCode === pairingAtCommand.code
        ) {
          finishPhonePairingTelemetry('approved');
        }
        clearCodeExpiryTimer();
        if (state.status === 'active') {
          // CAN-2981: an additional device redeemed a re-armed code on the
          // live session. Consume the code; the session, its activation time,
          // and every already-paired device are untouched.
          setState({ pairingCode: null, pairingCodeExpiresAt: null });
          return;
        }
        const activatedAt = new Date().toISOString();
        setState({
          status: 'active',
          connectionStatus: 'active',
          pairingCode: null,
          pairingCodeExpiresAt: null,
          activatedAt,
        });
        if (state.sessionId) {
          void persistActivePortalSession({
            serverId: CANOPY_CLOUD_SERVER_ID,
            sessionId: state.sessionId,
            commandCursor,
            activatedAt,
            lastSeenAt: state.lastSeenAt,
          });
        }
      },
      recordStateRequestTarget,
      stop: async (reason) => {
        await stopCanopyPortal(reason);
      },
    });
    // A long clone may finish after the user pairs a replacement session.
    // Its result and acknowledgement must never advance that session's cursor.
    if (pollAbort || state.sessionId !== commandSessionId) return 'stopped';
    await flushOutboxBeforeNextCommandBatch();
    if (
      command.type === 'portal.state.request' &&
      (commandEvents.some((event) => event.type === 'portal.state.snapshot') ||
        droppedCommandDeliveries.has(command.id))
    ) {
      // One flushOutbox() round posts only the head batch, so this command's
      // parts can still be queued behind earlier events. Keep flushing while
      // forward progress is being made. Posted means every part left through
      // an upload; a trimmed group is recorded as dropped. On a stalled
      // outbox (no progress), record neither.
      let previousOutboxLength = eventOutbox.length;
      while (isCommandGroupQueued(command.id)) {
        await flushOutbox();
        if (eventOutbox.length >= previousOutboxLength) {
          break;
        }
        previousOutboxLength = eventOutbox.length;
      }
      const drop = droppedCommandDeliveries.get(command.id);
      if (drop) {
        recordPortalSnapshotTiming({
          commandId: command.id,
          stage: 'snapshot_event_dropped',
          elapsedMs: elapsedMilliseconds(commandReceivedAt),
          drop,
        });
      } else if (!isCommandGroupQueued(command.id)) {
        recordPortalSnapshotTiming({
          commandId: command.id,
          stage: 'snapshot_event_posted',
          elapsedMs: elapsedMilliseconds(commandReceivedAt),
        });
      }
    }
    if (pollAbort || state.sessionId !== commandSessionId) {
      return 'stopped';
    }
    if (
      isDetachedCommand(command.type) &&
      !commandEvents.some(isTerminalCommandEvent)
    ) {
      deferred = true;
      deferredCommandSequences.add(command.sequence);
      commandCursor = Math.max(commandCursor, command.sequence);
      await persistPortalCommandCursor({
        commandCursor: commandCursorSafeToPersist(),
        lastSeenAt: response.session.lastSeenAt,
      }).catch(() => undefined);
      continue;
    }
    acceptingCommandEvents = false;
    await persistCommandReceipt({
      commandId: command.id,
      sequence: command.sequence,
      events: commandEvents,
    }).catch(() => undefined);
    if (pollAbort || state.sessionId !== commandSessionId) return 'stopped';
    commandCursor = Math.max(commandCursor, command.sequence);
    await persistPortalCommandCursor({
      sessionId: commandSessionId ?? undefined,
      commandCursor: commandCursorSafeToPersist(),
      lastSeenAt: response.session.lastSeenAt,
    }).catch(() => undefined);
  }

  await flushOutboxBeforeNextCommandBatch();
  return 'ok';
}

/** Whether the SSE command transport is enabled for this runtime (TS-02). */
function isSseCommandsEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyPortalSseCommands.key,
  );
}

/**
 * Runtime type guard for a `PollPortalCommandsResponse` decoded from an SSE
 * frame. Frames come from our own server, but this gates out malformed data
 * without an `as` cast.
 */
function isPollPortalCommandsResponse(
  value: unknown,
): value is PollPortalCommandsResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (
    !('session' in value) ||
    !('commands' in value) ||
    !('nextCursor' in value)
  ) {
    return false;
  }
  const session = value.session;
  if (typeof session !== 'object' || session === null) {
    return false;
  }
  if (!('status' in session) || !('connectionStatus' in session)) {
    return false;
  }
  return Array.isArray(value.commands) && typeof value.nextCursor === 'number';
}

function parsePollCommandsResponse(
  data: string,
): PollPortalCommandsResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return isPollPortalCommandsResponse(parsed) ? parsed : null;
}

/**
 * Classify an SSE `error` frame. Auth/not-found statuses are terminal: the
 * driver falls back to long-poll, which re-hits the same status and owns the
 * stop decision (avoids burning reconnect attempts). Everything else is
 * transient and just reconnects.
 */
function classifyPortalSseErrorFrame(data: string): 'terminal' | 'transient' {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === 'object' && parsed !== null && 'status' in parsed) {
      const status = parsed.status;
      if (status === 401 || status === 403 || status === 404) {
        return 'terminal';
      }
    }
  } catch {
    // Malformed error frame → treat as transient.
  }
  return 'transient';
}

const portalCommandSseDeps: PortalCommandSseDeps = {
  isAborted: (): boolean => pollAbort,
  getSessionId: (): string | null => state.sessionId,
  getCursor: (): number => commandCursor,
  openStream: (input): Promise<Response> => openPortalCommandStream(input),
  onPollFrame: async (data): Promise<'ok' | 'stopped'> => {
    const response = parsePollCommandsResponse(data);
    if (!response) {
      return 'ok';
    }
    return applyPollResponse(response);
  },
  classifyErrorFrame: (data): 'terminal' | 'transient' =>
    classifyPortalSseErrorFrame(data),
  flushOutbox: (): Promise<void> => flushOutbox(),
  onNetworkFailure: (error): void => markNetworkFailure(error),
  isInactiveSessionError: (error): boolean => isInactiveSessionResponse(error),
  // CAN-2651: the SSE transport flushes the outbox on every reconnect, so it
  // hits the same recoverable-409 race the long-poll loop does — probe before
  // tearing down.
  onInactiveSessionResponse: (): Promise<'revived' | 'terminal'> =>
    handleInactiveSessionResponse(),
  is404: (error): boolean =>
    error instanceof CanopyPortalClientError && error.status === 404,
  delay: (ms): Promise<void> =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  now: (): number => Date.now(),
  connectTimeoutMs: SSE_COMMAND_CONNECT_TIMEOUT_MS,
  armTimeout: (ms, onFire): (() => void) => {
    const timer = setTimeout(onFire, ms);
    return (): void => {
      clearTimeout(timer);
    };
  },
  setAbortController: (controller): void => {
    pollAbortController = controller;
  },
  backoffMs: BACKOFF_MS,
  maxImmediateFailures: SSE_COMMAND_MAX_IMMEDIATE_FAILURES,
  minHealthyConnectionMs: SSE_COMMAND_MIN_HEALTHY_CONNECTION_MS,
  idleTimeoutMs: SSE_COMMAND_IDLE_TIMEOUT_MS,
};

async function pollLoop(): Promise<void> {
  let backoffIndex = 0;

  while (!pollAbort && state.sessionId) {
    try {
      await flushOutboxBeforeNextCommandBatch();
      if (pollAbort) {
        return;
      }

      // Preferred transport: server→desktop command SSE stream (TS-02). On
      // fallback, drop to HTTP long-poll until the cooldown elapses, then
      // re-probe (CAN-2359). When the flag is off (default), this branch is
      // skipped entirely and behavior is byte-identical to the pre-TS-02
      // long-poll path.
      if (
        shouldAttemptSseCommands(
          Date.now(),
          sseCommandsRetryAfterMs,
          isSseCommandsEnabled(),
        )
      ) {
        const outcome =
          await runPortalCommandSseTransport(portalCommandSseDeps);
        pollAbortController = null;
        if (pollAbort) {
          return;
        }
        if (outcome === 'stopped') {
          return;
        }
        sseCommandFallbackStreak += 1;
        sseCommandsRetryAfterMs = nextSseCommandRetryAfter(
          Date.now(),
          sseCommandFallbackStreak,
        );
        backoffIndex = 0;
        continue;
      }

      const controller = new AbortController();
      pollAbortController = controller;
      const response = await pollPortalCommands({
        sessionId: state.sessionId,
        afterSeq: commandCursor,
        timeoutMs: 25_000,
        signal: controller.signal,
      });
      if (pollAbortController === controller) {
        pollAbortController = null;
      }

      if (pollAbort) {
        return;
      }

      const applied = await applyPollResponse(response);
      if (applied === 'stopped') {
        return;
      }
      backoffIndex = 0;
    } catch (error) {
      pollAbortController = null;
      if (pollAbort) {
        return;
      }
      if (isInactiveSessionResponse(error)) {
        if ((await handleInactiveSessionResponse()) === 'terminal') {
          return;
        }
        // Revived server-side (CAN-2651): retry the poll on the existing
        // backoff instead of ending the session.
        const probeDelay =
          BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
        backoffIndex += 1;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, probeDelay);
        });
        continue;
      }
      if (error instanceof CanopyPortalClientError && error.status === 404) {
        await clearActivePortalSession('replaced').catch(() => undefined);
        await stopCanopyPortal('replaced');
        return;
      }
      markNetworkFailure(error);
      const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
      backoffIndex += 1;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });
    }
  }
}

function scheduleHeartbeat(): void {
  // Idempotent: an out-of-band re-arm (wake recovery) plus a stale in-flight
  // beat's `finally` would otherwise leave two overlapping timer chains.
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
  heartbeatTimer = setTimeout(() => {
    heartbeatTimer = null;
    const sessionId = state.sessionId;
    if (pollAbort || !sessionId) {
      return;
    }

    const controller = new AbortController();
    heartbeatAbortController = controller;
    const clientPlatform = resolvePortalClientPlatform();
    void sendPortalHeartbeat({
      sessionId,
      signal: controller.signal,
      capabilities: portalSessionCapabilities(),
      clientVersion: app.getVersion(),
      ...(clientPlatform === undefined ? {} : { clientPlatform }),
    })
      .then((response) => {
        if (pollAbort || state.sessionId !== sessionId) {
          return;
        }
        if (response.status === 'inactive') {
          void transitionInactiveFromServer();
          return;
        }
        markNetworkSuccess(
          isPortalHostCode(response.hostCode)
            ? { hostCode: response.hostCode }
            : {},
        );
      })
      .catch((error) => {
        if (pollAbort || state.sessionId !== sessionId) {
          return;
        }
        if (isInactiveSessionResponse(error)) {
          // Keep all inactive-session responses on the same recovery path.
          // This second, single-flighted heartbeat is deliberate: a transient
          // stale response must not make the cadence itself the one remaining
          // handler that tears down without confirming the server's current
          // state (CAN-2651).
          void handleInactiveSessionResponse().catch(() => undefined);
          return;
        }
        markNetworkFailure(error);
      })
      .finally(() => {
        if (heartbeatAbortController === controller) {
          heartbeatAbortController = null;
        }
        if (!pollAbort && state.sessionId === sessionId) {
          scheduleHeartbeat();
        }
      });
  }, HEARTBEAT_INTERVAL_MS);
}

function startHeartbeat(): void {
  scheduleHeartbeat();
}

function startPollStallWatchdog(): void {
  if (pollStallTimer) {
    clearInterval(pollStallTimer);
  }
  pollStallTimer = setInterval(() => {
    // `lastPollProgressAt` tracks response ARRIVAL (applyPollResponse), not
    // processing completion. Detection intentionally does not require an
    // in-flight transport request: the long-poll branch nulls
    // `pollAbortController` before `applyPollResponse` runs, so a
    // processing-phase wedge on the default transport must still surface
    // here. The abort below only force-recovers transport-phase awaits —
    // processing-phase wedges are detected (diagnostic) but cannot be
    // force-settled from outside.
    if (
      !state.sessionId ||
      pollAbort ||
      Date.now() - lastPollProgressAt <= POLL_PROGRESS_STALL_MS
    ) {
      return;
    }
    pollAbortController?.abort();
    lastPollProgressAt = Date.now();
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'portal_channel_stalled',
    });
  }, POLL_STALL_CHECK_INTERVAL_MS);
  // Unlike the heartbeat/code-expiry timers (torn down via clearTimers on
  // quit), this interval also runs in Jest — unref keeps it from holding the
  // process open as a leaked handle.
  pollStallTimer.unref?.();
}

function clearCodeExpiryTimer(): void {
  if (codeExpiryTimer) {
    clearTimeout(codeExpiryTimer);
    codeExpiryTimer = null;
  }
}

function clearTimers(): void {
  releasePowerResumeListener();
  // In-flight probes are not cancellable at the client boundary, but clearing
  // the entry prevents a replacement session from joining them. Their captured
  // session-id guard discards any late result.
  inactiveSessionProbe = null;
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (pollStallTimer) {
    clearInterval(pollStallTimer);
    pollStallTimer = null;
  }
  pollAbortController?.abort();
  pollAbortController = null;
  heartbeatAbortController?.abort();
  heartbeatAbortController = null;
  if (outboxFlushRetryTimer) {
    clearTimeout(outboxFlushRetryTimer);
    outboxFlushRetryTimer = null;
  }
  if (outboxPersistTimer) {
    clearTimeout(outboxPersistTimer);
    outboxPersistTimer = null;
  }
  clearCodeExpiryTimer();
}

async function subscribeFeatureEvents(
  sessionId: string,
  generation: number,
): Promise<void> {
  // Chat-state construction lazily reaches chat-service and the Portal event bus.
  // Keep that graph out of module initialization and recheck the session after import.
  try {
    const { getChatStateService } =
      await import('../services/chat-state-service');
    if (generation !== cardEventGeneration || state.sessionId !== sessionId)
      return;
    const service = getChatStateService();
    cardEventAdapter = subscribePortalDelegationCardEvents(
      {
        subscribe: (listener) => service.subscribe(listener),
        generation: (scope, target) => service.generation(scope, target),
        readStoredParentMessage: (scope, chatId, messageId) =>
          service.readStoredParentMessage(scope, chatId, messageId),
        resolveOwner: (scope) => {
          // Committed events already carry the canonical owner scope, never navigation.
          // Match chat-service's persisted source mapping, including legacy cowork aliases.
          const projectId = scope.projectId;
          const worktreeId = scope.worktreeId;
          const source =
            projectId === APP_ADVISOR_PROJECT_ID
              ? { scope: 'app_advisor' as const }
              : isCoworkWorkspace(projectId)
                ? {
                    scope: 'standalone' as const,
                    projectLocalId:
                      projectId === STANDALONE_CHAT_PROJECT_ID
                        ? worktreeId
                        : projectId,
                    projectId:
                      projectId === STANDALONE_CHAT_PROJECT_ID
                        ? worktreeId
                        : projectId,
                    workEntryId: worktreeId,
                  }
                : {
                    scope: 'worktree' as const,
                    workspaceLocalId: projectId,
                    worktreeLocalId: worktreeId,
                  };
          return Promise.resolve({ scope, source });
        },
      },
      enqueueEvent,
      () => generation === cardEventGeneration && state.sessionId === sessionId,
    );

    unsubscribeFeatureEvents?.();
    unsubscribeFeatureEvents = subscribeTerminalPortalEvents(enqueueEvent);
    unsubscribeProviderUsage?.();
    unsubscribeProviderUsage = subscribePortalProviderUsage(enqueueEvent);
    unsubscribeCanonicalTurnTimers?.();
    unsubscribeCanonicalTurnTimers =
      subscribePortalCanonicalTurnTimers(enqueueEvent);
    unsubscribeCanonicalTurnSummaries?.();
    unsubscribeCanonicalTurnSummaries = subscribePortalCanonicalTurnSummaries(
      (scope): void => {
        // Deferred, as chat-service's own deferred imports, to keep the main
        // service graph free of an import cycle.
        void import('../services/chat-service')
          .then(({ emitLatestTargetChatSummary }) =>
            emitLatestTargetChatSummary({
              workspaceId: scope.projectId,
              worktreeId: scope.worktreeId,
              chatId: scope.chatId,
            }),
          )
          .catch((error: unknown) =>
            logMainProcessError('Portal canonical turn summary failed', error),
          );
      },
    );
    // The worktree runtime-status aggregator only needs to observe session/
    // chat activity while a portal session can consume its deltas; tying its
    // lifecycle to the feature-event sinks covers every start/resume/stop/
    // error transition in this file.
    startWorktreeRuntimeStatusService();
    startPortalBackgroundProcessProjection();
  } catch (error) {
    if (generation === cardEventGeneration) {
      unsubscribeFeatureEventSinks();
      setCanopyPortalEventSink(null);
    }
    throw error;
  }
}

function unsubscribeFeatureEventSinks(): void {
  invalidateCardEvents();
  unsubscribeFeatureEvents?.();
  unsubscribeFeatureEvents = null;
  unsubscribeProviderUsage?.();
  unsubscribeProviderUsage = null;
  unsubscribeCanonicalTurnTimers?.();
  unsubscribeCanonicalTurnTimers = null;
  unsubscribeCanonicalTurnSummaries?.();
  unsubscribeCanonicalTurnSummaries = null;
  stopWorktreeRuntimeStatusService();
}

export async function startCanopyPortal(): Promise<StartCanopyPortalResponse> {
  if (startingPortal) {
    return startingPortal;
  }
  startingPortal = startCanopyPortalImpl().finally(() => {
    startingPortal = null;
  });
  return startingPortal;
}

function isPortalOperationAccountFenced(generation: number): boolean {
  return (
    accountInvalidation?.generation === cardEventGeneration &&
    accountInvalidation.operationGeneration === generation
  );
}

async function cleanupAccountFencedPortalOperation(
  generation: number,
  createdSessionId?: string,
): Promise<void> {
  if (!isPortalOperationAccountFenced(generation)) return;

  const installedSessionId = state.sessionId;
  // Stop fences and clears local work synchronously before its first await.
  // A create response may not yet be installed, so stop cannot end it itself.
  await Promise.all([
    stopCanopyPortal('replaced'),
    createdSessionId && createdSessionId !== installedSessionId
      ? endPortalSession({ sessionId: createdSessionId }).catch(() => undefined)
      : undefined,
  ]);
}

async function startCanopyPortalImpl(): Promise<StartCanopyPortalResponse> {
  invalidateCardEvents();
  if (
    !getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key,
    )
  ) {
    throw new Error(`${portalDisplayName} is not available.`);
  }

  const replacement =
    state.status !== 'disabled' ? stopCanopyPortal('replaced') : undefined;
  const generation = cardEventGeneration;
  if (replacement) await replacement;
  if (generation !== cardEventGeneration) {
    await cleanupAccountFencedPortalOperation(generation);
    return { state: getCanopyPortalState() };
  }
  const account = await loadCanopyCloudAccount();
  if (generation !== cardEventGeneration) {
    await cleanupAccountFencedPortalOperation(generation);
    return { state: getCanopyPortalState() };
  }
  knownAccount = account;
  if (!account || !account.apiKey.trim()) {
    throw new Error(
      `Connect ${cloudDisplayName} in Settings before enabling ${portalDisplayNameInline}.`,
    );
  }
  if (!account.capabilities.includes('portal-v1')) {
    throw new Error(
      `${cloudDisplayName} does not support ${portalDisplayNameInline}.`,
    );
  }

  const pairingCode = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
  // Read once per session so the name the QR code shows and the `clientName`
  // the server reports back on pairing cannot diverge (e.g. a host rename
  // while the app stays open).
  const machineName = resolvePortalMachineName();
  lastTargetedPortalWorktreeKey = null;
  armPhonePairingTelemetry(pairingCode, false);
  const pairingGeneration = phonePairingGeneration;

  setState({
    status: 'starting',
    connectionStatus: 'inactive',
    sessionId: null,
    hostCode: null,
    pairingCode,
    pairingCodeExpiresAt: expiresAt.toISOString(),
    machineName,
    activatedAt: null,
    lastSeenAt: null,
    lastErrorAt: null,
    error: null,
  });

  let session: Awaited<ReturnType<typeof createPortalSession>> | null = null;
  try {
    await assertLiveCanopyPortalSupport();
    if (generation !== cardEventGeneration) {
      await cleanupAccountFencedPortalOperation(generation);
      return { state: getCanopyPortalState() };
    }
    const persisted = await readPortalStateStore();
    if (generation !== cardEventGeneration) {
      await cleanupAccountFencedPortalOperation(generation);
      return { state: getCanopyPortalState() };
    }
    const clientPlatform = resolvePortalClientPlatform();
    session = await createPortalSession({
      clientDeviceId: persisted.clientDeviceId,
      clientName: machineName,
      clientHostname: hostname(),
      capabilities: portalSessionCapabilities(),
      clientVersion: app.getVersion(),
      ...(clientPlatform === undefined ? {} : { clientPlatform }),
    });
  } catch (error) {
    if (generation !== cardEventGeneration) {
      await cleanupAccountFencedPortalOperation(generation, session?.sessionId);
      return { state: getCanopyPortalState() };
    }
    finishPhonePairingTelemetry('failed');
    clearTimers();
    pollAbort = true;
    setCanopyPortalEventSink(null);
    unsubscribeFeatureEventSinks();
    setState({
      status: 'error',
      connectionStatus: 'inactive',
      sessionId: null,
      hostCode: null,
      pairingCode: null,
      pairingCodeExpiresAt: null,
      activatedAt: null,
      lastSeenAt: null,
      lastErrorAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (generation !== cardEventGeneration) {
    await cleanupAccountFencedPortalOperation(generation, session?.sessionId);
    return { state: getCanopyPortalState() };
  }
  if (!session) {
    throw new Error(`Failed to start ${portalDisplayNameInline} session.`);
  }

  commandCursor = session.commandCursor;
  deferredCommandSequences.clear();
  eventOutbox = [];
  routingSequenceCounters = new Map();
  resetCommandDeliveryTracking();
  await persistOutboxNow().catch(() => undefined);
  pollAbort = false;
  sseCommandsRetryAfterMs = 0;
  sseCommandFallbackStreak = 0;
  lastPollProgressAt = Date.now();
  if (generation !== cardEventGeneration) {
    await cleanupAccountFencedPortalOperation(generation, session.sessionId);
    return { state: getCanopyPortalState() };
  }
  setCanopyPortalEventSink(enqueueEvent);
  setState({
    status: 'pending_auth',
    sessionId: session.sessionId,
    hostCode: null,
    pairingCode,
    pairingCodeExpiresAt: session.pendingExpiresAt,
  });
  try {
    await subscribeFeatureEvents(session.sessionId, generation);
  } catch (error) {
    if (!isPortalOperationAccountFenced(generation)) throw error;
    await cleanupAccountFencedPortalOperation(generation, session.sessionId);
    return { state: getCanopyPortalState() };
  }
  if (generation !== cardEventGeneration) {
    await cleanupAccountFencedPortalOperation(generation, session.sessionId);
    return { state: getCanopyPortalState() };
  }

  codeExpiryTimer = setTimeout(() => {
    if (
      phonePairingGeneration === pairingGeneration &&
      state.status === 'pending_auth' &&
      state.pairingCode === pairingCode
    ) {
      finishPhonePairingTelemetry('expired');
      void stopCanopyPortal('local_disconnect').then(() => {
        // Say why pairing stopped, unless a new attempt already started.
        if (state.status === 'disabled') {
          setState({
            lastErrorAt: new Date().toISOString(),
            error: PAIRING_CODE_EXPIRED_MESSAGE,
          });
        }
      });
    }
  }, PAIRING_CODE_TTL_MS);
  startHeartbeat();
  startPollStallWatchdog();
  armPowerResumeListener();
  void pollLoop();

  return { state: getCanopyPortalState() };
}

/**
 * Arm a fresh pairing code on the live session so another device (web,
 * mobile) can pair without disconnecting the devices already connected
 * (CAN-2981). The server fans code redemption out to active sessions, and
 * `markAuthenticated` consumes the code in place instead of re-activating.
 * The code expires on its own; expiry never ends the session.
 */
export function regenerateCanopyPortalPairingCode(): RegenerateCanopyPortalPairingCodeResponse {
  if (state.status !== 'active') {
    throw new Error(
      `${portalDisplayName} must be connected before pairing another device.`,
    );
  }
  clearCodeExpiryTimer();
  const pairingCode = generatePairingCode();
  armPhonePairingTelemetry(pairingCode, true);
  const pairingGeneration = phonePairingGeneration;
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
  setState({ pairingCode, pairingCodeExpiresAt: expiresAt.toISOString() });
  codeExpiryTimer = setTimeout(() => {
    if (phonePairingGeneration !== pairingGeneration) return;
    codeExpiryTimer = null;
    // Identity-guarded only: a transient `reconnecting` hop must not let the
    // code outlive its TTL, and a newer code is never cleared by an old timer.
    if (state.pairingCode === pairingCode) {
      finishPhonePairingTelemetry('expired');
      setState({ pairingCode: null, pairingCodeExpiresAt: null });
    }
  }, PAIRING_CODE_TTL_MS);
  return { state: getCanopyPortalState() };
}

/**
 * Drop a re-armed pairing code before anyone redeems it (CAN-2981). The live
 * session and its paired devices are untouched; a later redemption of the
 * dropped code is refused because the desktop no longer holds it. Safe to
 * call with nothing armed.
 */
export function cancelCanopyPortalPairingCode(): CancelCanopyPortalPairingCodeResponse {
  if (state.status === 'active' && state.pairingCode !== null) {
    finishPhonePairingTelemetry('cancelled');
    clearCodeExpiryTimer();
    setState({ pairingCode: null, pairingCodeExpiresAt: null });
  }
  return { state: getCanopyPortalState() };
}

export async function stopCanopyPortal(
  reason: 'local_disconnect' | 'replaced' | 'app_shutdown' = 'local_disconnect',
): Promise<StopCanopyPortalResponse> {
  finishPhonePairingTelemetry('cancelled');
  unsubscribeFeatureEventSinks();
  const sessionGeneration = portalSessionIdentityGeneration;
  const sessionId = state.sessionId;

  if (sessionId) portalFileReferences.clearSession(sessionId);
  closePortalAssetTransfers();

  if (reason !== 'app_shutdown') {
    setState({ status: 'stopping' });
  }
  pollAbort = true;
  clearTimers();
  deferredCommandSequences.clear();
  // Discard queued snapshot builds and orphan in-flight ones: their events
  // must not leak into a later session's outbox.
  snapshotLane.reset();
  await persistPortalStopReason(reason).catch(() => undefined);
  if (sessionGeneration !== portalSessionIdentityGeneration)
    return { state: getCanopyPortalState() };

  if (sessionId && reason !== 'app_shutdown') {
    await flushOutbox().catch(() => undefined);
    if (sessionGeneration !== portalSessionIdentityGeneration)
      return { state: getCanopyPortalState() };
    await endPortalSession({ sessionId }).catch(() => undefined);
    if (sessionGeneration !== portalSessionIdentityGeneration)
      return { state: getCanopyPortalState() };
  }

  if (reason === 'app_shutdown') {
    await persistOutboxNow().catch(() => undefined);
  } else {
    commandCursor = 0;
    eventOutbox = [];
    routingSequenceCounters = new Map();
    resetCommandDeliveryTracking();
    await persistPortalEventOutbox(eventOutbox, routingSequenceCounters).catch(
      () => undefined,
    );
  }
  if (sessionGeneration !== portalSessionIdentityGeneration)
    return { state: getCanopyPortalState() };
  setCanopyPortalEventSink(null);
  clearWorktreeSummaryPortalFingerprints();
  clearPortalMcpServerFingerprints();
  clearPortalBackgroundProcessFingerprints();
  clearPortalWatcherProjection();
  if (reason !== 'app_shutdown') {
    await clearActivePortalSession(reason).catch(() => undefined);
    if (sessionGeneration !== portalSessionIdentityGeneration)
      return { state: getCanopyPortalState() };
  }
  setState({
    status: 'disabled',
    connectionStatus: 'inactive',
    sessionId: null,
    hostCode: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    activatedAt: null,
    lastSeenAt: null,
    error: null,
  });

  return { state: getCanopyPortalState() };
}

export async function resumeCanopyPortalIfPossible(): Promise<void> {
  if (
    !getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key,
    )
  ) {
    return;
  }

  if (state.status !== 'disabled') {
    return;
  }

  invalidateCardEvents();
  const generation = cardEventGeneration;
  const persisted = await readPortalStateStore();
  if (generation !== cardEventGeneration) {
    await cleanupAccountFencedPortalOperation(generation);
    return;
  }
  if (
    !persisted.activeSession ||
    (persisted.lastStopReason && persisted.lastStopReason !== 'app_shutdown')
  ) {
    return;
  }

  if (persisted.activeSession.serverId !== CANOPY_CLOUD_SERVER_ID) {
    await clearActivePortalSession('replaced').catch(() => undefined);
    return;
  }

  const account = await loadCanopyCloudAccount();
  if (generation !== cardEventGeneration) {
    await cleanupAccountFencedPortalOperation(generation);
    return;
  }
  knownAccount = account;
  if (!account || !account.apiKey.trim()) {
    await clearActivePortalSession('replaced').catch(() => undefined);
    return;
  }
  if (!account.capabilities.includes('portal-v1')) {
    await clearActivePortalSession('replaced').catch(() => undefined);
    return;
  }

  commandCursor = persisted.activeSession.commandCursor;
  deferredCommandSequences.clear();
  // Older outboxes may predate enqueue-time sanitization and compaction.
  // Normalize once on restore, before deriving routing counters and timestamps;
  // flushes then send the already-bounded envelopes without another
  // deep traversal or per-send clone.
  eventOutbox = (persisted.eventOutbox ?? []).map((event) =>
    compactPortalEvent(sanitizePortalEventEnvelope(event)),
  );
  routingSequenceCounters = restorePortalRoutingSequenceCounters(
    persisted.routingSequenceCounters,
    eventOutbox,
  );
  resetCommandDeliveryTracking();
  for (const commandId of persisted.stateRequestCommandIds ?? []) {
    recordStateRequestCommand(commandId);
  }
  stampRestoredOutboxEvents(eventOutbox);
  pollAbort = false;
  sseCommandsRetryAfterMs = 0;
  sseCommandFallbackStreak = 0;
  lastPollProgressAt = Date.now();
  setCanopyPortalEventSink(enqueueEvent);
  setState({
    status: 'reconnecting',
    connectionStatus: 'reconnecting',
    sessionId: persisted.activeSession.sessionId,
    hostCode: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    activatedAt: persisted.activeSession.activatedAt,
    lastSeenAt: persisted.activeSession.lastSeenAt,
    lastErrorAt: null,
    error: null,
  });

  try {
    await subscribeFeatureEvents(persisted.activeSession.sessionId, generation);
  } catch (error) {
    if (!isPortalOperationAccountFenced(generation)) throw error;
    await cleanupAccountFencedPortalOperation(generation);
    return;
  }
  if (generation !== cardEventGeneration) {
    await cleanupAccountFencedPortalOperation(generation);
    return;
  }
  startHeartbeat();
  startPollStallWatchdog();
  armPowerResumeListener();
  void sendHeartbeatNow()
    .then((probe) => {
      if (probe === 'inactive') {
        return transitionInactiveFromServer();
      }
    })
    .catch(() => undefined);
  void pollLoop();
}

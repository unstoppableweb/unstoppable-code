import type {
  RemoteControlChatMessage,
  RemoteControlConnectionStatus,
} from '@canopy/protocol/remote-control/shell';
import type { OrgProjectSetupProgress } from '@canopy/protocol/org-projects';
import type {
  WorkspaceContext,
  WorkspaceContextState,
} from '@canopy/protocol/workspace-context';
import type {
  TerminalExitEvent,
  TerminalOutputEvent,
  TerminalRunningChangedEvent,
} from '@canopy/protocol/terminal';
import type { ManagedDelegationLifetimeChangedEvent } from '@canopy/protocol/delegation';
import type { ClaudeModSurfacePushEvent } from '@canopy/protocol/extension-ui';

/**
 * Canonical streaming contract for the shared UI.
 *
 * Both transports already emit conceptually identical updates — the desktop
 * via `ipcRenderer.on(IPC_CHANNELS.*)` push, the web via the portal long-poll
 * event service. Each adapter maps its native frames into this normalized
 * `DomainEvent` union so components never see whether an update arrived by
 * push or by poll.
 *
 * This map is intentionally seeded with the connection-status event only.
 * Feature slices (chat, file/diff, activity, overview) extend
 * {@link DomainEventMap} here as they move into `@canopy/app-state`; keeping
 * the canonical union in one file avoids cross-package declaration merging.
 */

/**
 * Fields shared by normalized domain events. `terminal.output` is the sole
 * exception: it preserves the raw structured-clone frame by identity and does
 * not allocate an `occurredAt` wrapper on the PTY hot path.
 */
export interface DomainEventBase {
  /** Stable producer identity for reconnect/duplicate-delivery dedupe. */
  readonly eventId?: string;
  /** ISO-8601 timestamp of when the source change occurred. */
  readonly occurredAt: string;
  /** Canonical project/worktree scope when this event belongs to chat state. */
  readonly projectId?: string;
  readonly worktreeId?: string;
  /** Ordered commit identity; omitted only for legacy non-revisioned sources. */
  readonly baseRevision?: number;
  readonly revision?: number;
}

/** Host ↔ client connection health changed (desktop link / portal session). */
export interface ConnectionStatusEvent extends DomainEventBase {
  readonly status: RemoteControlConnectionStatus;
}

/** The host's neutral session snapshot is stale and should be queried again. */
export type SessionSnapshotStaleEvent = DomainEventBase;

/**
 * A chat message was created or updated. Mirrors the portal wire envelope
 * {@link import('@canopy/protocol/remote-control/shell').RemoteControlChatEventPayload}: each event
 * carries exactly one {@link RemoteControlChatMessage} representing the message's
 * *current* state, not a raw delta. The transport (desktop IPC projector / web
 * portal projection) owns delta-merging and re-emits the whole message after
 * each merge, so consumers upsert by `message.messageId` rather than
 * reconstructing text from fragments. The routing context lets a subscriber
 * attach the row to the right workspace/worktree/chat slice.
 */
export interface ChatMessageEvent extends DomainEventBase {
  readonly scope: 'worktree' | 'standalone' | 'app_advisor';
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  readonly chatId: string;
  readonly message: RemoteControlChatMessage;
}

/**
 * Ordered, materialized chat-state event shared by desktop IPC and Portal.
 * `changes` contains canonical projection values, never raw SDK deltas.
 */
export interface ChatStateRevisionEvent<
  TChange = unknown,
> extends DomainEventBase {
  readonly eventId: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly baseRevision: number;
  readonly revision: number;
  readonly changes: readonly TChange[];
}

/** The host's workspace context changed (this window or another one). */
export interface WorkspaceContextChangedEvent extends DomainEventBase {
  /** Account changes start a new revision space, including revision-zero resets. */
  readonly reason: 'switch' | 'account-change' | 'departed' | 'organizations';
  readonly state: WorkspaceContextState;
}

/**
 * The catalog for one workspace context changed on the server or on this
 * device (a grant, a preference, or an instance). Consumers re-query the
 * catalog rather than patching rows from the event.
 */
export interface OrgProjectsChangedEvent extends DomainEventBase {
  readonly context: WorkspaceContext;
  readonly reason: 'catalog' | 'preference' | 'instance';
}

/** A project setup on this device reported progress. */
export interface OrgProjectSetupProgressEvent extends DomainEventBase {
  readonly progress: OrgProjectSetupProgress;
}

/** The authoritative lifetime allowance for a worktree may have changed. */
export type DelegationLifetimeChangedEvent =
  ManagedDelegationLifetimeChangedEvent & DomainEventBase;

/** Durable script-action state changed for this project/worktree. Refetch the list. */
export interface ScriptActionsChangedEvent extends DomainEventBase {
  readonly projectId: string;
  readonly worktreeId: string;
}

/**
 * A Claude Mod's toast, status line or log line for one chat (site group M1),
 * never persisted. Hosts send it only while `capabilities.claudeModSurface`.
 */
export type ClaudeModSurfaceEvent = ClaudeModSurfacePushEvent & DomainEventBase;

/**
 * The paired computer's Orchestrator questions changed: one arrived, was
 * answered elsewhere or was withdrawn (CAN-5985). Re-query `appAdvisor.chats`.
 * Subscribing also tells the computer this client shows Orchestrator
 * questions, so it delivers the ones already waiting.
 */
export interface AppAdvisorChangedEvent extends DomainEventBase {
  readonly reason: 'question';
}

/**
 * A worktree's plan, script, hook, pipeline or summary rows changed on the
 * paired computer (CAN-5985): re-query `worktree.activity`. The worktree is
 * absent when the computer did not name it (re-read every worktree shown).
 */
export interface WorktreeActivityChangedEvent extends DomainEventBase {
  readonly projectId?: string;
  readonly worktreeId?: string;
  readonly reason: 'pipelines' | 'plans' | 'hooks' | 'scripts' | 'summary';
}

/**
 * Map of domain-event name → payload. Extend this interface (do not augment it
 * from another package) when a feature slice introduces new events. Every
 * payload extends {@link DomainEventBase} except raw `terminal.output` frames,
 * whose identity and binary payload must pass through unchanged.
 */
export interface DomainEventMap {
  'terminal.output': TerminalOutputEvent;
  'terminal.exit': TerminalExitEvent & DomainEventBase;
  'terminal.running-changed': TerminalRunningChangedEvent & DomainEventBase;
  'connection.status': ConnectionStatusEvent;
  'session.snapshot-stale': SessionSnapshotStaleEvent;
  'chat.message': ChatMessageEvent;
  'workspace-context.changed': WorkspaceContextChangedEvent;
  'org-projects.changed': OrgProjectsChangedEvent;
  'org-projects.setup-progress': OrgProjectSetupProgressEvent;
  'delegation.lifetimeChanged': DelegationLifetimeChangedEvent;
  'scriptActions.changed': ScriptActionsChangedEvent;
  'claudeMods.surface': ClaudeModSurfaceEvent;
  'appAdvisor.changed': AppAdvisorChangedEvent;
  'worktree.activityChanged': WorktreeActivityChangedEvent;
}

/** Closed set of supported domain-event names. */
export type DomainEventName = keyof DomainEventMap;

/** Payload type for a given domain-event name (defaults to the full union). */
export type DomainEvent<K extends DomainEventName = DomainEventName> =
  DomainEventMap[K];

/** Returned by {@link CanopyClient.subscribe}; call to stop receiving events. */
export type Unsubscribe = () => void;

/**
 * Optional scoping for a subscription. Adapters use it to filter the firehose
 * down to the workspace/worktree/chat the caller cares about. Field names match
 * the portal `*LocalId` namespace so the web adapter maps them by identity.
 */
export interface SubscriptionFilter {
  /** Canonical revisioned-chat scope. */
  readonly projectId?: string;
  readonly worktreeId?: string;
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  readonly chatLocalId?: string;
}

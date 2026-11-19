import type {
  AgentDelegationError,
  AgentDelegationEvent,
  AgentDelegationSpawnRequest,
  DelegationStopReason,
  ManagedDelegationSurface,
  PersistedAgentOverlaySummary,
  PersistedAgentRouteSnapshot,
} from '@canopy/protocol/delegation';
import type { ChatInputAdmission } from '@canopy/protocol/remote-control/shell/input-delivery';
import type { DelegationCapabilityGrant } from './capability-grant';
import type { DelegationTranscriptTarget } from './transcript-port';

export type { DelegationStopReason } from '@canopy/protocol/delegation';

/** Shared with the Electron recorder so broker-authored chat items fit its
 * retained transcript budget too. */
export const DELEGATION_TRANSCRIPT_LIMITS = Object.freeze({
  items: 2048,
  itemBytes: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
});

/** Trusted host context. Never deserialize this from model tool arguments. */
export interface DelegationParentContext {
  readonly harnessId: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly sessionKey: string;
  readonly turnId: string;
  /** Host chat message identity, distinct from a native provider turn. */
  readonly userMessageId?: string;
  readonly toolCallId: string;
  readonly runtimeGeneration: number;
  readonly depth: number;
  /** Set only by the trusted host when a user initiated a control action. */
  readonly controlAuthor?: 'user' | 'agent';
  /** Host-issued identity of the caller when the caller is itself delegated. */
  readonly parentDelegationId?: string;
  readonly parentRunGeneration?: number;
  readonly parentDescription?: string;
}

/** Structural check only; the broker additionally validates live ownership. */
export function hasValidDelegationLineage(
  parent: Pick<
    DelegationParentContext,
    'depth' | 'parentDelegationId' | 'parentRunGeneration'
  >,
): boolean {
  return (
    Number.isInteger(parent.depth) &&
    parent.depth >= 0 &&
    parent.depth < 10 &&
    (parent.depth === 0
      ? parent.parentDelegationId === undefined &&
        parent.parentRunGeneration === undefined
      : typeof parent.parentDelegationId === 'string' &&
        parent.parentDelegationId.length > 0 &&
        parent.parentDelegationId.length <= 256 &&
        Number.isSafeInteger(parent.parentRunGeneration) &&
        (parent.parentRunGeneration ?? 0) > 0)
  );
}

export interface ResolvedAgentOverlaySnapshot extends PersistedAgentOverlaySummary {
  readonly systemPromptAppend?: string;
  /** Private artifact locator; the host verifies and mounts it before launch. */
  readonly artifact: {
    readonly artifactId: string;
    readonly formatVersion: 1 | 2;
    readonly manifestHash: string;
  };
}

/**
 * Private locator of a retained version 3 capability overlay: the plugins,
 * skills and MCP selections a child runs with, independent of Agent identity.
 * Never projected into public route snapshots.
 */
export interface ResolvedCapabilityOverlaySnapshot {
  /** Content hash of the overlay (files, capabilities, provenance, items). */
  readonly capabilityProjectionHash: string;
  readonly artifact: {
    readonly artifactId: string;
    readonly formatVersion: 3;
    readonly manifestHash: string;
  };
}

export interface ResolvedAgentRouteSnapshot extends Omit<
  PersistedAgentRouteSnapshot,
  'agentOverlay'
> {
  readonly authAccountKey?: string;
  /** Configured Agent identity and system prompt. */
  readonly agentOverlay?: ResolvedAgentOverlaySnapshot;
  /**
   * Retained capabilities. Absent on routes written before capability
   * overlays existed; their Agent artifact then carries the capabilities.
   */
  readonly capabilityOverlay?: ResolvedCapabilityOverlaySnapshot;
}

/**
 * Host output of route resolution. `capabilityGrant` is set only for a new
 * delegation that has one; the broker moves it onto the stored record and
 * never retains it on the route.
 */
export interface ResolvedDelegationRoute extends ResolvedAgentRouteSnapshot {
  readonly capabilityGrant?: DelegationCapabilityGrant;
}

export interface AgentRunRequest {
  /**
   * Ephemeral trusted root policy. Omitted means the Code surface; the broker
   * supplies it once a non-Code surface is enabled. Never persist this on
   * parent or route.
   */
  readonly surface?: ManagedDelegationSurface;
  readonly delegationId: string;
  readonly runGeneration: number;
  readonly launchKey: string;
  readonly resumeSessionId?: string;
  readonly parent: DelegationParentContext;
  readonly task: AgentDelegationSpawnRequest;
  readonly route: ResolvedAgentRouteSnapshot;
  readonly cwd: string;
  readonly effectivePermission: 'read-only';
  readonly signal: AbortSignal;
  /**
   * Set only for a stream-backed generation, which production does not
   * create before promotion: the child stream its runner admits canonical
   * rows to through the transcript port.
   */
  readonly transcriptStream?: { readonly target: DelegationTranscriptTarget };
}

export type DelegatedEventSink = (event: AgentDelegationEvent) => Promise<void>;

/** Adapter-owned opaque identity. Never a root chat session key. */
export interface NativeRunHandle {
  readonly runId: string;
}

export interface AgentSteeringRequest {
  readonly delegationId: string;
  readonly runGeneration: number;
  readonly attemptId: string;
  readonly message: string;
}

export type RunnerAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly error: AgentDelegationError };

export type DelegationStopReceipt =
  | { readonly stopped: true }
  | { readonly stopped: false; readonly error: AgentDelegationError };

export interface AgentRunnerAdapter {
  readonly harnessId: string;
  readonly runtimeKind: string;
  readonly adapterVersion: string;
  canRun(route: ResolvedAgentRouteSnapshot): Promise<RunnerAvailability>;
  start(
    request: AgentRunRequest,
    sink: DelegatedEventSink,
  ): Promise<NativeRunHandle>;
  stop(
    handle: NativeRunHandle,
    reason: DelegationStopReason,
  ): Promise<DelegationStopReceipt>;
  steer?(
    handle: NativeRunHandle,
    request: AgentSteeringRequest,
  ): Promise<ChatInputAdmission>;
  close(handle: NativeRunHandle): Promise<void>;
}

/** Dispatching is durable *before* a provider operation may take effect. */
export type DelegationDeliveryState =
  | { readonly status: 'unclaimed' }
  | { readonly status: 'queued'; readonly channel: 'foreground' | 'background' }
  | {
      readonly status: 'dispatching';
      readonly channel: 'foreground' | 'background';
    }
  | {
      readonly status: 'acknowledged';
      readonly channel: 'foreground' | 'background';
      readonly receiptId: string;
    }
  | {
      readonly status: 'uncertain';
      readonly channel: 'foreground' | 'background';
    }
  | {
      readonly status: 'suppressed';
      readonly reason:
        | 'parent_gone'
        | 'user_cancelled'
        | 'automatic_delivery_removed';
    };

export type DelegationDeliveryReceipt =
  | {
      readonly deliveryId: string;
      readonly status: 'acknowledged';
      readonly receiptId: string;
    }
  | { readonly deliveryId: string; readonly status: 'uncertain' };

/** A parent is eligible only after its implementation proves these boundaries. */
export interface DelegationToolSurfaceAdapter<
  TCall,
  TProjection,
  TNotification,
> {
  readonly harnessId: string;
  getParentContext(call: TCall): DelegationParentContext;
  replaceTools(
    projection: TProjection,
    generation: number,
    signal: AbortSignal,
  ): Promise<{ committedGeneration: number }>;
  deliverNotification(
    parent: DelegationParentContext,
    notification: TNotification,
  ): Promise<DelegationDeliveryReceipt>;
}

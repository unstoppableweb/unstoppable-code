import type {
  AgentRunnerAdapter,
  AgentRunRequest,
  DelegatedEventSink,
  NativeRunHandle,
  ResolvedAgentRouteSnapshot,
  DelegationParentContext,
  DelegationToolSurfaceAdapter,
  DelegationDeliveryReceipt,
  DelegationStopReceipt,
} from '../types';
import type { ChatInputAdmission } from '@canopy/protocol/remote-control/shell/input-delivery';

export function routeFixture(
  overrides: Partial<ResolvedAgentRouteSnapshot> = {},
): ResolvedAgentRouteSnapshot {
  return {
    selectedModelId: 'logical-review-model',
    runtimeModelId: 'native-model',
    harnessId: 'third-harness',
    runtimeKind: 'local-sdk',
    runnerRegistrationId: 'third-local',
    runtimeVersion: '1.0',
    adapterVersion: '1',
    modelSource: 'test',
    providerType: 'test-inference',
    assignmentRevision: 'assignment-1',
    billingAuthority: 'native',
    aiCreditsRouted: false,
    capabilities: ['read', 'progress'],
    supportedThinkingLevels: ['low', 'high'],
    capabilitySnapshotHash: 'capability-1',
    capabilityGeneration: 1,
    policyRevision: 'read-only-1',
    authAccountKey: 'private-account@example.test',
    ...overrides,
  };
}

/** A target with manual event delivery; no vendor or provider is consulted. */
export class FakeRunner implements AgentRunnerAdapter {
  readonly harnessId = 'third-harness';
  readonly adapterVersion = '1';
  starts: AgentRunRequest[] = [];
  stopped: string[] = [];
  closed: string[] = [];
  sink?: DelegatedEventSink;
  readonly sinks = new Map<string, DelegatedEventSink>();
  steeringAdmission: ChatInputAdmission = {
    kind: 'accepted',
    attemptId: 'fixture',
  };
  steeringRequests: Array<{
    handle: NativeRunHandle;
    request: Parameters<NonNullable<AgentRunnerAdapter['steer']>>[1];
  }> = [];

  constructor(readonly runtimeKind: string) {}

  canRun(): Promise<{ available: true }> {
    return Promise.resolve({ available: true });
  }

  start(
    request: AgentRunRequest,
    sink: DelegatedEventSink,
  ): Promise<NativeRunHandle> {
    this.starts.push(request);
    this.sink = sink;
    this.sinks.set(request.delegationId, sink);
    return Promise.resolve({ runId: request.delegationId });
  }

  stop(handle: NativeRunHandle): Promise<DelegationStopReceipt> {
    this.stopped.push(handle.runId);
    return Promise.resolve({ stopped: true });
  }

  steer(
    handle: NativeRunHandle,
    request: Parameters<NonNullable<AgentRunnerAdapter['steer']>>[1],
  ): Promise<ChatInputAdmission> {
    this.steeringRequests.push({ handle, request });
    return Promise.resolve({
      ...this.steeringAdmission,
      attemptId: request.attemptId,
    });
  }

  close(handle: NativeRunHandle): Promise<void> {
    this.closed.push(handle.runId);
    return Promise.resolve();
  }
}

/** Independent third parent. Receipts here certify only fixture dispatch. */
export class FakeParent implements DelegationToolSurfaceAdapter<
  string,
  readonly string[],
  { deliveryId: string; text: string }
> {
  readonly harnessId = 'third-parent';
  generation = 0;
  tools: readonly string[] = [];
  readonly notifications = new Map<string, string>();
  readonly callers = new Map<string, DelegationParentContext>();

  getParentContext(call: string): DelegationParentContext {
    const context = this.callers.get(call);
    if (!context) throw new Error('Unknown caller');
    return context;
  }

  replaceTools(
    projection: readonly string[],
    generation: number,
    signal: AbortSignal,
  ): Promise<{ committedGeneration: number }> {
    if (signal.aborted || generation <= this.generation)
      return Promise.reject(new Error('Stale capability transition'));
    this.tools = Object.freeze([...projection]);
    this.generation = generation;
    return Promise.resolve({ committedGeneration: generation });
  }

  deliverNotification(
    _parent: DelegationParentContext,
    notification: { deliveryId: string; text: string },
  ): Promise<DelegationDeliveryReceipt> {
    const prior = this.notifications.get(notification.deliveryId);
    if (prior !== undefined && prior !== notification.text)
      return Promise.resolve({
        status: 'uncertain',
        deliveryId: notification.deliveryId,
      });
    this.notifications.set(notification.deliveryId, notification.text);
    return Promise.resolve({
      status: 'acknowledged',
      deliveryId: notification.deliveryId,
      receiptId: `fixture:${notification.deliveryId}`,
    });
  }
}

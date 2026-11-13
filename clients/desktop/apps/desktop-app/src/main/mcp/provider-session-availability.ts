import { randomUUID } from 'node:crypto';
import { McpAvailabilityObserver } from '@canopy/execution-engine/node/codex-runtime/mcp-availability-observer';
import type { McpActivationHandoff } from './activation-handoff';
import {
  mcpCapabilityIdentityKey,
  type McpActivationProvider,
  type McpActivationScope,
  type McpCapabilityIdentity,
  type McpSessionStatus,
} from '@canopy/protocol/mcp-servers';
import {
  mcpSessionAvailability,
  type McpSessionBinding,
  type McpSessionObservation,
} from './session-availability';

const owners = new Map<string, ProviderMcpSession>();
let nextGeneration = 0;
const credentialRevisions = new Map<string, number>();
let nextCredentialRevision = 0;
export function mcpCredentialRevision(serverId: string): number {
  return credentialRevisions.get(serverId) ?? 0;
}
export function reserveMcpGeneration(): number {
  return ++nextGeneration;
}

function scopeKey(scope: McpActivationScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId, scope.chatId]);
}

/** Evidence belongs to this provider instance, never a settings/discovery client. */
export class ProviderMcpSession {
  private identities: Readonly<
    Record<string, readonly McpCapabilityIdentity[]>
  > = {};
  private currentBinding: McpSessionBinding;
  private disposed = false;
  private segments = 0;
  private readonly segmentWaiters = new Set<() => void>();
  private readonly connections = new Map<string, object>();
  private authRoutes: Record<string, { serverId: string; configId: string }> =
    {};

  constructor(
    scope: McpActivationScope,
    provider: McpActivationProvider,
    private readonly handoff?: McpActivationHandoff,
  ) {
    nextGeneration = Math.max(nextGeneration, handoff?.generation ?? 0);
    const ownerId = scopeKey(scope);
    owners.get(ownerId)?.dispose();
    this.currentBinding = {
      ownerId,
      scope: {
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      },
      provider,
      sessionId: randomUUID(),
      generation: handoff?.generation ?? reserveMcpGeneration(),
    };
    owners.set(ownerId, this);
  }

  get binding(): McpSessionBinding | undefined {
    return this.isCurrent() ? this.currentBinding : undefined;
  }

  get completedSegments(): number {
    return this.segments;
  }

  /** Called only after a native terminal event and its admitted output settle. */
  segmentSettled(): void {
    if (!this.isCurrent()) return;
    this.segments += 1;
    for (const listener of Array.from(this.segmentWaiters)) listener();
  }

  async waitForSegmentAfter(
    completed: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (!this.isCurrent()) throw new Error('MCP session changed');
    if (this.segments > completed) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.segmentWaiters.delete(check);
        signal.removeEventListener('abort', abort);
      };
      const check = (): void => {
        if (!this.isCurrent()) {
          cleanup();
          reject(new Error('MCP session changed'));
        } else if (this.segments > completed) {
          cleanup();
          resolve();
        }
      };
      const abort = (): void => {
        cleanup();
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('MCP activation cancelled'),
        );
      };
      this.segmentWaiters.add(check);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
  }

  configure(
    identities: Readonly<Record<string, readonly McpCapabilityIdentity[]>>,
    disabledNames: ReadonlySet<string> = new Set(),
    authRoutes: Record<string, { serverId: string; configId: string }> = {},
  ): void {
    if (!this.isCurrent()) return;
    this.identities = identities;
    this.authRoutes = authRoutes;
    this.currentBinding = {
      ...this.currentBinding,
      generation: this.handoff?.pending
        ? this.handoff.generation
        : reserveMcpGeneration(),
    };
    const selections = new Map<
      string,
      {
        identity: McpCapabilityIdentity;
        selected: boolean;
        enabled: boolean;
        permitted: boolean;
        authRequirement: 'unknown';
      }
    >();
    for (const [name, targets] of Object.entries(identities)) {
      for (const identity of targets) {
        selections.set(mcpCapabilityIdentityKey(identity), {
          identity,
          selected: true,
          enabled: !disabledNames.has(name),
          permitted: !disabledNames.has(name),
          authRequirement: 'unknown',
        });
      }
    }
    mcpSessionAvailability.begin(
      this.currentBinding,
      Array.from(selections.values()),
    );
    if (this.handoff?.pending)
      this.handoff.preparedSession(this.currentBinding);
  }

  observe(
    binding: McpSessionBinding,
    name: string,
    observation:
      | Omit<Extract<McpSessionObservation, { kind: 'connecting' }>, 'identity'>
      | Omit<Extract<McpSessionObservation, { kind: 'tools' }>, 'identity'>
      | Omit<
          Extract<McpSessionObservation, { kind: 'auth_required' }>,
          'identity'
        >
      | Omit<
          Extract<McpSessionObservation, { kind: 'unavailable' }>,
          'identity'
        >,
  ): void {
    if (!this.isCurrent() || binding !== this.currentBinding) return;
    for (const identity of this.identities[name] ?? []) {
      mcpSessionAvailability.observe(binding, { ...observation, identity });
    }
  }

  snapshot(): McpSessionStatus[] {
    return this.isCurrent()
      ? mcpSessionAvailability.snapshot(this.currentBinding)
      : [];
  }

  revokeMissingSelections(selected: ReadonlySet<string>): void {
    if (this.isCurrent())
      mcpSessionAvailability.revokeMissingSelections(
        this.currentBinding,
        selected,
      );
  }

  authTargets(): Array<{
    serverId: string;
    configId: string;
    identity: McpCapabilityIdentity;
  }> {
    return Object.entries(this.authRoutes).flatMap(([name, route]) =>
      (this.identities[name] ?? []).map((identity) => ({ ...route, identity })),
    );
  }

  observeConnection(name: string): McpAvailabilityObserver {
    const binding = this.currentBinding;
    const connection = {};
    this.connections.set(name, connection);
    this.observe(binding, name, { kind: 'connecting' });
    return new McpAvailabilityObserver((evidence) => {
      if (this.connections.get(name) === connection)
        this.observe(binding, name, evidence);
    });
  }

  hasServer(name: string): boolean {
    return this.isCurrent() && (this.identities[name]?.length ?? 0) > 0;
  }

  invalidateCredentials(serverIds: ReadonlySet<string>): void {
    if (
      !this.isCurrent() ||
      !Object.values(this.authRoutes).some((route) =>
        serverIds.has(route.serverId),
      )
    )
      return;
    const previous = this.snapshot();
    this.currentBinding = {
      ...this.currentBinding,
      generation: reserveMcpGeneration(),
    };
    this.connections.clear();
    mcpSessionAvailability.begin(
      this.currentBinding,
      previous.map(
        ({ identity, selected, enabled, permitted, authRequirement }) => ({
          identity,
          selected,
          enabled,
          permitted,
          authRequirement,
        }),
      ),
    );
    for (const status of previous) {
      mcpSessionAvailability.observe(this.currentBinding, {
        identity: status.identity,
        kind: 'unavailable',
        reasonCode: 'unchecked',
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const listener of Array.from(this.segmentWaiters)) listener();
    this.handoff?.failed();
    this.connections.clear();
    mcpSessionAvailability.clear(this.currentBinding);
    if (owners.get(this.currentBinding.ownerId) === this) {
      owners.delete(this.currentBinding.ownerId);
    }
  }

  private isCurrent(): boolean {
    return !this.disposed && owners.get(this.currentBinding.ownerId) === this;
  }
}

export function getProviderMcpSession(
  scope: McpActivationScope,
): ProviderMcpSession | undefined {
  return owners.get(scopeKey(scope));
}

/** Committed credential changes invalidate evidence from every old connection. */
export function invalidateMcpCredentialEvidence(
  serverIds: readonly string[],
): void {
  const changed = new Set(serverIds);
  for (const id of Array.from(changed)) {
    credentialRevisions.delete(id);
    credentialRevisions.set(id, ++nextCredentialRevision);
  }
  while (credentialRevisions.size > 4096) {
    const oldest = credentialRevisions.keys().next().value;
    if (oldest === undefined) break;
    credentialRevisions.delete(oldest);
  }
  for (const owner of Array.from(owners.values()))
    owner.invalidateCredentials(changed);
}

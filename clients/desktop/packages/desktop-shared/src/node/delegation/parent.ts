import {
  isWatchDelegatesCompatibilityName,
  watchDelegatesCompatibilityResult,
} from './watch-delegates-tombstone';
import type { DelegationModelDiscovery } from '@canopy/protocol/delegation/discovery';
import { createHash, type UUID } from 'node:crypto';
import type {
  AgentDelegationResult,
  AgentDelegationSnapshot,
  AgentDelegationSpawnRequest,
  DelegationNestingState,
  RequestSteeringRequest,
} from '@canopy/protocol/delegation';
import {
  parseClaudeDelegationSpawn,
  parseCodexDelegationSpawn,
} from '@canopy/protocol/delegation/spawn-projections';
import { DelegationCallBindings } from './call-bindings';
import {
  createDelegationProjection,
  type DelegationCapabilityDiscovery,
  type DelegationFeedHooks,
  type DelegationProjectionBroker,
  type DelegationProjectionNames,
} from './projections';
import {
  DELEGATION_APPLY_RESPONSE_WAIT_MS,
  type AgentDelegationBroker,
} from './broker';
import {
  hasValidDelegationLineage,
  type DelegationParentContext,
  type DelegationStopReason,
} from './types';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function unavailable(): AgentDelegationResult<never> {
  return {
    ok: false,
    error: {
      code: 'parent_unavailable',
      message: 'The owning parent turn is unavailable.',
      retryable: false,
    },
  };
}

export type DelegationParentBroker = DelegationProjectionBroker &
  Pick<AgentDelegationBroker, 'closeOwner'>;

type DelegationParentCallContext = DelegationParentContext & {
  readonly signal?: AbortSignal;
};

/**
 * Host-generated hidden messages a parent admitted to its chat queue. A root
 * chat shares one store across its successive tool generations, so a message
 * admitted under one provider session can still be dispatched, claimed and
 * acknowledged after that session is replaced.
 */
export class DelegationHostMessages {
  private readonly admitted = new Set<string>();
  private readonly submitted = new Set<string>();

  get ids(): readonly string[] {
    return Array.from(this.admitted);
  }

  admit(id: string): boolean {
    if (this.admitted.size >= 1024) return false;
    this.admitted.add(id);
    return true;
  }

  canDispatch(id: string): boolean {
    return this.admitted.has(id) && !this.submitted.has(id);
  }

  claim(id: string): boolean {
    if (!this.canDispatch(id)) return false;
    this.submitted.add(id);
    return true;
  }

  release(id: string): void {
    if (this.admitted.has(id)) this.submitted.delete(id);
  }

  isSubmitted(id: string): boolean {
    return this.submitted.has(id);
  }

  retire(id: string): void {
    this.admitted.delete(id);
    this.submitted.delete(id);
  }

  /** Forgets every admitted message and returns the IDs it held. */
  clear(): string[] {
    const ids = Array.from(this.admitted);
    this.admitted.clear();
    this.submitted.clear();
    return ids;
  }
}

/** One native parent generation. Host callbacks, never tool arguments, own identity. */
export class DelegationParent {
  private readonly controller = new AbortController();
  private binding?: { turnId: string; calls: DelegationCallBindings };
  private readonly hostMessages: DelegationHostMessages;
  private feedHooks?: DelegationFeedHooks;
  private currentProjection: ReturnType<typeof createDelegationProjection>;

  constructor(
    readonly options: {
      owner: Omit<DelegationParentContext, 'turnId' | 'toolCallId'>;
      harness:
        | 'claude'
        | 'codex'
        | 'cursor'
        | 'copilot'
        | 'antigravity'
        | 'opencode';
      namespace: string;
      names: DelegationProjectionNames;
      broker: DelegationParentBroker;
      currentTurn: () => string | undefined;
      /**
       * Transcript message that anchors delegate cards. When omitted, the
       * card anchors to `currentTurn()` as before.
       */
      currentMessage?: () => string | undefined;
      removeQueued: (ids: readonly string[]) => Promise<void>;
      reportError: (error: unknown) => void;
      responseBudgetMs?: number;
      /** Budget for an isolated apply, which may wait for its outcome. */
      applyResponseBudgetMs?: number;
      discoverModels?: (
        parent: DelegationParentContext,
        signal?: AbortSignal,
      ) => Promise<DelegationModelDiscovery>;
      discoverCapabilities?: (
        parent: DelegationParentContext,
        signal?: AbortSignal,
      ) => Promise<DelegationCapabilityDiscovery>;
      authorizeSpawn?: () => boolean;
      onInvocation?: (
        parent: DelegationParentContext,
        task: AgentDelegationSpawnRequest,
        result: AgentDelegationResult<AgentDelegationSnapshot>,
      ) => void;
      enableDelegationTools?: boolean;
      /** Why a child's delegation tools are withheld, when that is known. */
      delegationToolsWithheld?: Exclude<DelegationNestingState, 'enabled'>;
      requestSteering?: (
        parent: DelegationParentContext,
        request: RequestSteeringRequest,
      ) => Promise<AgentDelegationResult<unknown>>;
      /** Shared by a root chat's tool generations; private when omitted. */
      hostMessages?: DelegationHostMessages;
    },
  ) {
    this.hostMessages = options.hostMessages ?? new DelegationHostMessages();
    this.currentProjection = this.createProjection();
  }

  get projection(): ReturnType<typeof createDelegationProjection> {
    return this.currentProjection;
  }

  /** Configure this parent's host-built Feed readers and rebuild the tool gate. */
  configureFeed(hooks: DelegationFeedHooks | undefined): void {
    if (
      this.feedHooks?.readFeedSummary === hooks?.readFeedSummary &&
      this.feedHooks?.readFeedAssignment === hooks?.readFeedAssignment
    )
      return;
    this.feedHooks = hooks;
    // In-flight native Claude calls still resolve their turn-bound arguments;
    // invocation reparses them against the new Feed gate before broker access.
    this.currentProjection = this.createProjection();
  }

  get active(): boolean {
    return !this.controller.signal.aborted;
  }

  get delegationToolsEnabled(): boolean {
    return this.options.enableDelegationTools === true;
  }

  /** Why this child cannot start delegates, when that is known. */
  get delegationToolsWithheld():
    | Exclude<DelegationNestingState, 'enabled'>
    | undefined {
    return this.delegationToolsEnabled
      ? undefined
      : this.options.delegationToolsWithheld;
  }

  context(
    turnId = this.options.currentTurn(),
    toolCallId = 'host',
    signal?: AbortSignal,
  ): DelegationParentCallContext | undefined {
    return this.active && turnId
      ? {
          ...this.options.owner,
          turnId,
          toolCallId,
          ...(signal !== undefined ? { signal } : {}),
          userMessageId:
            this.options.owner.userMessageId ??
            (this.options.currentMessage
              ? this.options.currentMessage()
              : this.options.currentTurn()),
        }
      : undefined;
  }

  ownsTool(name: string): boolean {
    return this.projection.tools.some((tool) => tool.name === name);
  }

  /** Called only by the native Claude PreToolUse hook, after application approval. */
  bindClaude(
    name: string,
    input: unknown,
    callId: string,
    agentId?: string,
  ): AgentDelegationResult<Record<string, unknown>> {
    const context = this.context(undefined, callId);
    if (
      !context ||
      agentId ||
      (!isWatchDelegatesCompatibilityName(name, this.options.harness) &&
        !this.ownsTool(name)) ||
      !record(input) ||
      '_hostCorrelation' in input
    )
      return unavailable();
    const request = this.bindingRequest(name, input);
    if (!request.ok) return request;
    if (this.binding?.turnId !== context.turnId) {
      this.binding?.calls.dispose();
      this.binding = {
        turnId: context.turnId,
        calls: new DelegationCallBindings(context, this.controller.signal),
      };
    }
    const bound = this.binding.calls.bind(callId, request.value, context);
    return bound.ok
      ? { ok: true, value: { ...input, _hostCorrelation: bound.value } }
      : bound;
  }

  async invokeClaude(
    name: string,
    input: unknown,
  ): Promise<AgentDelegationResult<unknown>> {
    const owner = this.context();
    if (
      !owner ||
      !this.binding ||
      !record(input) ||
      typeof input._hostCorrelation !== 'string'
    )
      return unavailable();
    const { _hostCorrelation: token, ...argumentsOnly } = input;
    const request = this.bindingRequest(name, argumentsOnly);
    if (!request.ok) return request;
    const bound = this.binding.calls.resolve(token, request.value, owner);
    return bound.ok ? this.invoke(bound.value, name, argumentsOnly) : bound;
  }

  /** Native app-server dispatch supplies all three IDs and verifies the root thread. */
  invokeCodex(
    name: string,
    input: unknown,
    native: {
      callId: string;
      turnId: string;
      threadId: string;
      signal?: AbortSignal;
    },
    rootThreadId: string | undefined,
    rootTurnId: string | undefined,
  ): Promise<AgentDelegationResult<unknown>> {
    if (
      !rootThreadId ||
      !rootTurnId ||
      native.threadId !== rootThreadId ||
      native.turnId !== rootTurnId
    )
      return Promise.resolve(unavailable());
    const parent = this.context(
      native.turnId,
      native.callId,
      isWatchDelegatesCompatibilityName(name, this.options.harness)
        ? native.signal
        : undefined,
    );
    return parent
      ? this.invoke(parent, name, input)
      : Promise.resolve(unavailable());
  }

  /** The authenticated per-turn MCP route supplies identity, never tool arguments. */
  invokeCursor(
    name: string,
    input: unknown,
    native: { callId: string; turnId: string },
  ): Promise<AgentDelegationResult<unknown>> {
    if (
      (this.options.harness !== 'cursor' &&
        this.options.harness !== 'copilot' &&
        this.options.harness !== 'antigravity' &&
        this.options.harness !== 'opencode') ||
      !native.callId ||
      native.turnId !== this.options.currentTurn() ||
      !record(input) ||
      '_hostCorrelation' in input
    )
      return Promise.resolve(unavailable());
    const parent = this.context(native.turnId, native.callId);
    return parent
      ? this.invoke(parent, name, input)
      : Promise.resolve(unavailable());
  }

  /** Native hook/item acknowledgement, never invoked when merely writing a response. */
  acknowledgeTool(
    callId: string,
    nativeReceipt: string,
    turnId?: string,
  ): void {
    void callId;
    void nativeReceipt;
    void turnId;
  }

  acknowledgeMessage(id: string, nativeReceipt: string): void {
    void nativeReceipt;
    if (this.active) this.retireHostMessage(id);
  }

  /** A recovered queue cannot launch a paid continuation without its live owner. */
  canDispatchMessage(id: string): boolean {
    return this.active && this.hostMessages.canDispatch(id);
  }

  claimMessageDispatch(id: string): boolean {
    return this.active && this.hostMessages.claim(id);
  }

  releaseMessageDispatch(id: string): void {
    if (this.active) this.hostMessages.release(id);
  }

  /** Admit a host-generated hidden message into the existing queue lifecycle. */
  authorizeHostMessage(id: string): boolean {
    return this.active && this.hostMessages.admit(id);
  }

  retireHostMessage(id: string): void {
    this.hostMessages.retire(id);
  }

  nativeMessageUuid(id: string | undefined): UUID | undefined {
    return this.active && id && isUuid(id) && this.hostMessages.isSubmitted(id)
      ? id
      : undefined;
  }

  /** Retire this native turn's tool bindings without cancelling its delegated work. */
  detach(): void {
    this.controller.abort();
    this.binding?.calls.dispose();
  }

  async close(reason: DelegationStopReason): Promise<void> {
    const parent = {
      ...this.options.owner,
      turnId: 'host-close',
      toolCallId: 'host-close',
    };
    this.controller.abort();
    this.binding?.calls.dispose();
    const cleanup = await Promise.allSettled([
      this.options.removeQueued(Array.from(this.hostMessages.ids)),
      this.options.broker.closeOwner(parent, reason),
    ]);
    if (cleanup.some((result) => result.status === 'rejected'))
      throw new Error('Delegation parent cleanup was incomplete');
  }

  private invoke(
    parent: DelegationParentCallContext,
    name: string,
    input: unknown,
  ): Promise<AgentDelegationResult<unknown>> {
    // An ambiguous transport response never aborts admitted work. A retry with
    // the same native call binding observes the original durable admission.
    const apply =
      name === this.options.names.manageWorktree &&
      typeof input === 'object' &&
      input !== null &&
      'operation' in input &&
      input.operation === 'apply';
    const budgetMs = apply
      ? (this.options.applyResponseBudgetMs ??
        DELEGATION_APPLY_RESPONSE_WAIT_MS + 5_000)
      : (this.options.responseBudgetMs ?? 5_000);
    return new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          resolve({
            ok: false,
            error: {
              code: 'runtime_error',
              retryable: true,
              message:
                'The response budget elapsed. Admission may still complete. Inspect retained children or retry this same call identity; do not issue a replacement spawn.',
            },
          }),
        budgetMs,
      );
      void this.invokeOwned(parent, name, input)
        .then(resolve, () =>
          resolve({
            ok: false,
            error: {
              code: 'runtime_error',
              retryable: true,
              message:
                'The delegation request could not be confirmed. Retry the same call identity.',
            },
          }),
        )
        .finally(() => clearTimeout(timer));
    });
  }

  private createProjection(): ReturnType<typeof createDelegationProjection> {
    const hooks = this.feedHooks;
    return createDelegationProjection(
      this.options.harness,
      this.options.namespace,
      this.options.broker,
      {
        names: this.options.names,
        discoverModels: this.options.discoverModels,
        discoverCapabilities: this.options.discoverCapabilities,
        enableDelegationTools: this.options.enableDelegationTools,
        requestSteering: this.options.requestSteering,
        ...(hooks
          ? {
              includeFeed: true,
              readFeedSummary: hooks.readFeedSummary,
              readFeedAssignment: hooks.readFeedAssignment,
            }
          : {}),
        onError: this.options.reportError,
      },
    );
  }

  private async enrichFeedAssignment(
    parent: DelegationParentContext,
    task: AgentDelegationSpawnRequest,
    result: AgentDelegationResult<AgentDelegationSnapshot>,
  ): Promise<AgentDelegationResult<AgentDelegationSnapshot>> {
    if (!result.ok || !task.taskIds?.length || !this.feedHooks) return result;
    try {
      const feedAssignment = await this.feedHooks.readFeedAssignment(
        parent,
        task,
        result.value.delegationId,
      );
      return feedAssignment === undefined
        ? result
        : { ok: true, value: { ...result.value, feedAssignment } };
    } catch {
      try {
        this.options.reportError(
          new Error('Delegation Feed assignment unavailable'),
        );
      } catch {
        // The host diagnostic must not turn a Feed read failure into spawn failure.
      }
      return result;
    }
  }

  private async invokeOwned(
    parent: DelegationParentCallContext,
    name: string,
    input: unknown,
  ): Promise<AgentDelegationResult<unknown>> {
    if (
      !this.active ||
      parent.signal?.aborted ||
      !hasValidDelegationLineage(parent)
    )
      return unavailable();
    if (isWatchDelegatesCompatibilityName(name, this.options.harness))
      return watchDelegatesCompatibilityResult(input);
    if (!this.ownsTool(name)) return unavailable();
    if (
      (name === this.options.names.manageWorktree ||
        name === this.options.names.message) &&
      this.options.authorizeSpawn?.() === false
    )
      return unavailable();
    if (name !== this.options.names.spawn)
      return this.projection.invoke(
        parent,
        name,
        input,
        this.controller.signal,
      );
    const parsed =
      this.options.harness !== 'codex'
        ? parseClaudeDelegationSpawn(input, {
            includeFeed: this.feedHooks !== undefined,
          })
        : parseCodexDelegationSpawn(input, {
            includeFeed: this.feedHooks !== undefined,
          });
    if (!parsed.ok) return parsed;
    if (this.options.authorizeSpawn?.() === false) {
      const blocked: AgentDelegationResult<AgentDelegationSnapshot> = {
        ok: false,
        error: {
          code: 'policy_blocked',
          message:
            'Managed consultation was disabled. Start a new turn to refresh tools.',
          retryable: false,
        },
      };
      this.options.onInvocation?.(parent, parsed.value, blocked);
      return blocked;
    }
    const result = await this.options.broker.spawn(parent, {
      ...parsed.value,
      executionMode: 'background',
    });
    const enriched = await this.enrichFeedAssignment(
      parent,
      parsed.value,
      result,
    );
    this.options.onInvocation?.(parent, parsed.value, enriched);
    return enriched;
  }

  private bindingRequest(
    name: string,
    input: unknown,
  ): AgentDelegationResult<AgentDelegationSpawnRequest> {
    if (name === this.options.names.spawn)
      return this.options.harness !== 'codex'
        ? parseClaudeDelegationSpawn(input, {
            includeFeed: this.feedHooks !== undefined,
          })
        : parseCodexDelegationSpawn(input, {
            includeFeed: this.feedHooks !== undefined,
          });
    if (
      !isWatchDelegatesCompatibilityName(name, this.options.harness) &&
      !this.ownsTool(name)
    )
      return unavailable();
    return {
      ok: true,
      value: {
        modelId: 'host-tool-binding',
        description: name,
        prompt: createHash('sha256')
          .update(JSON.stringify([name, input]))
          .digest('hex'),
        executionMode: 'background',
        contextPolicy: 'task_only',
        isolation: 'shared_worktree',
      },
    };
  }
}

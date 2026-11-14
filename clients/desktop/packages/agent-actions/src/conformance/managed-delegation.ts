import type {
  AgentDelegationError,
  AgentDelegationResult,
  AgentDelegationSpawnRequest,
} from '@canopy/protocol/delegation';
import type {
  AgentDelegateOutputValue,
  AgentDelegationModelsValue,
  AgentDelegationSnapshotValue,
  AgentManagedDelegationPort,
} from '../port/managed-delegation-port';
import {
  NARROWEST_DELEGATED_CHILD_GRANT,
  restrictAgentActionSurfaceForDelegatedChild,
} from '../delegated-child';
import type { AgentActionBrand } from '../brand';
import {
  createAgentActionSurface,
  type AgentActionSurface,
} from '../surface/engine';
import type { AgentActionCall } from '../surface/family';
import type { AgentActionToolKey } from '../tool-keys';
import { MANAGED_DELEGATION_PARENT_TOOL_KEYS } from '../tools/managed-delegation';
import type { AgentActionToolResult } from '../tools/definition';
import { at, check, checkEqual } from './assert';
import type {
  AgentConformanceCallIdentity,
  AgentConformanceTestApi,
} from './suite';

/**
 * The delegations the managed delegation suite's backend holds before any
 * call. IDs are lowercase UUIDs, so a host can seed stores that only take
 * UUIDs.
 */
export interface ManagedDelegationConformanceWorld {
  /** A delegate of the calling chat that settled one run. */
  readonly settled: {
    readonly delegationId: string;
    readonly resultText: string;
  };
  /** A delegation of another chat: the caller must never reach it. */
  readonly foreignDelegationId: string;
  /** The model delegates run on, and one they can't. */
  readonly models: AgentDelegationModelsValue;
}

export const MANAGED_DELEGATION_CONFORMANCE_WORLD: ManagedDelegationConformanceWorld =
  {
    settled: {
      delegationId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      resultText: 'The review found two issues.',
    },
    foreignDelegationId: '8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e',
    models: {
      models: [
        {
          modelId: 'M1',
          label: 'Model one',
          harnessId: 'claude',
          runtimeKind: 'cloud',
          supportedThinkingLevels: ['low', 'high'],
          capabilities: [],
          availability: 'available',
          authState: 'ready',
        },
        {
          modelId: 'M2',
          label: 'Model two',
          harnessId: 'codex',
          runtimeKind: 'cloud',
          supportedThinkingLevels: [],
          capabilities: [],
          availability: 'unknown',
          authState: 'ready',
          disabledReason: 'Not available for delegates here.',
        },
      ],
      recommendedModelId: 'M1',
      truncated: false,
    },
  };

/** One write that reached a delegation backend. */
export interface ManagedDelegationBackendWrite {
  readonly kind: 'spawn' | 'stop' | 'message' | 'steering';
  /** The tool call's idempotency key, as the host passed it on. */
  readonly key: string;
}

/**
 * The in-memory delegation backend the reference host serves the tools
 * from, over `MANAGED_DELEGATION_CONFORMANCE_WORLD`. A host whose real
 * backend can't run in a test serves its own adapter from it, so the suite
 * reaches the host's real tool, port and error mapping. Spawns are keyed:
 * the same key returns the same delegation.
 */
export function createReferenceDelegationBackend(
  world: ManagedDelegationConformanceWorld = MANAGED_DELEGATION_CONFORMANCE_WORLD,
): {
  readonly port: AgentManagedDelegationPort<unknown>;
  readonly writes: () => readonly ManagedDelegationBackendWrite[];
  /** The spawn requests the backend accepted, in order. */
  readonly spawns: () => readonly AgentDelegationSpawnRequest[];
} {
  const writes: ManagedDelegationBackendWrite[] = [];
  const spawns: AgentDelegationSpawnRequest[] = [];
  const byKey = new Map<string, string>();
  const delegations = new Map<string, AgentDelegationSnapshotValue>([
    [
      world.settled.delegationId,
      {
        delegationId: world.settled.delegationId,
        status: 'completed',
        phase: 'idle',
        depth: 1,
        runGeneration: 1,
        resultIndex: 1,
        outputTruncated: false,
      },
    ],
  ]);
  const notDescendant = (): {
    readonly ok: false;
    readonly error: AgentDelegationError;
  } => ({
    ok: false,
    error: {
      code: 'parent_unavailable',
      message: 'That delegation is not one of your descendants.',
      retryable: false,
    },
  });
  const find = (
    delegationId: string,
  ): AgentDelegationResult<AgentDelegationSnapshotValue> => {
    const found = delegations.get(delegationId);
    return found === undefined ? notDescendant() : { ok: true, value: found };
  };
  const port: AgentManagedDelegationPort<unknown> = {
    spawn: (_call, request, key) => {
      const known = byKey.get(key);
      if (known !== undefined) return Promise.resolve(find(known));
      writes.push({ kind: 'spawn', key });
      spawns.push(request);
      const delegationId = `00000000-0000-4000-8000-${String(delegations.size).padStart(12, '0')}`;
      const snapshot: AgentDelegationSnapshotValue = {
        delegationId,
        status: 'running',
        phase: 'running',
        depth: 1,
        runGeneration: 1,
        requestedModelId: request.modelId,
        outputTruncated: false,
      };
      delegations.set(delegationId, snapshot);
      byKey.set(key, delegationId);
      return Promise.resolve({ ok: true, value: snapshot });
    },
    output: (_call, request) => {
      const found = find(request.delegationId);
      if (!found.ok) return Promise.resolve(found);
      const settled = request.delegationId === world.settled.delegationId;
      if (
        request.resultIndex !== undefined &&
        (!settled || request.resultIndex !== 1)
      )
        return Promise.resolve({
          ok: false,
          error: {
            code: 'invalid_request',
            message: 'That delegate has no result with this resultIndex.',
            retryable: false,
          },
        });
      const value: AgentDelegateOutputValue = {
        delegationId: request.delegationId,
        currentRunGeneration: 1,
        currentStatus: found.value.status,
        latestResultIndex: settled ? 1 : null,
        result: settled
          ? {
              resultIndex: 1,
              runGeneration: 1,
              status: 'completed',
              finalText: world.settled.resultText,
              outputTruncated: false,
            }
          : null,
      };
      return Promise.resolve({ ok: true, value });
    },
    inspect: (_call, delegationId) => Promise.resolve(find(delegationId)),
    list: (_call, filter) =>
      Promise.resolve(
        filter.underDelegationId !== undefined &&
          !delegations.has(filter.underDelegationId)
          ? notDescendant()
          : {
              ok: true,
              value: {
                delegations:
                  filter.underDelegationId === undefined
                    ? [...delegations.values()].reverse()
                    : [],
              },
            },
      ),
    models: () => Promise.resolve({ ok: true, value: world.models }),
    stop: (_call, delegationId, key) => {
      const found = find(delegationId);
      if (!found.ok) return Promise.resolve(found);
      writes.push({ kind: 'stop', key });
      delegations.set(delegationId, {
        ...found.value,
        status: 'cancelled',
        stopReason: 'stopped_by_parent',
      });
      return Promise.resolve({ ok: true, value: { accepted: true } });
    },
    message: (_call, request, key) => {
      const found = find(request.delegationId);
      if (!found.ok) return Promise.resolve(found);
      writes.push({ kind: 'message', key });
      const runGeneration =
        request.operation === 'interrupt'
          ? (found.value.runGeneration ?? 1)
          : (found.value.runGeneration ?? 1) + 1;
      delegations.set(request.delegationId, {
        ...found.value,
        runGeneration,
        status: 'running',
        phase: 'queued',
      });
      return Promise.resolve({
        ok: true,
        value: { runGeneration, phase: 'queued' },
      });
    },
    requestSteering: (_call, _request, key) => {
      writes.push({ kind: 'steering', key });
      return Promise.resolve({
        ok: true,
        value: { requestId: `steering-${String(writes.length)}` },
      });
    },
  };
  return {
    port,
    writes: () => [...writes],
    spawns: () => [...spawns],
  };
}

/**
 * A host that offers the managed delegation tools (CAN-6301). Its parent
 * and delegate surfaces are built through its real path over the backend it
 * was made with, seeded with the world.
 */
export interface ManagedDelegationConformanceHost<H> {
  /** The surface a chat that may delegate gets. */
  parent: AgentActionSurface<H>;
  /** The surface a read-only delegate of that chat gets. */
  delegate: AgentActionSurface<H>;
  call(identity: AgentConformanceCallIdentity): AgentActionCall<H>;
  /** Every write that reached the delegation backend, in order. */
  writes(): readonly ManagedDelegationBackendWrite[];
  /** The spawn requests the backend accepted, in order. */
  spawns(): readonly AgentDelegationSpawnRequest[];
}

export type MakeManagedDelegationConformanceHost<H> = (
  world: ManagedDelegationConformanceWorld,
) =>
  | ManagedDelegationConformanceHost<H>
  | Promise<ManagedDelegationConformanceHost<H>>;

function parsed(result: AgentActionToolResult): unknown {
  try {
    const value: unknown = JSON.parse(result.text);
    return value;
  } catch {
    return undefined;
  }
}

function toolKeys<H>(surface: AgentActionSurface<H>): AgentActionToolKey[] {
  return surface.toolDefinitions().map((definition) => definition.key);
}

const DELEGATION_TOOL_KEYS: readonly AgentActionToolKey[] = [
  ...MANAGED_DELEGATION_PARENT_TOOL_KEYS,
  'request_steering',
];

/**
 * The managed delegation conformance suite: a chat that may delegate gets
 * DelegateTask and its controls, a delegate gets RequestSteering; input the
 * surface doesn't run is refused before the backend; Codex field names are
 * accepted; a retried call reaches the same delegation; and results and
 * refusals come back in the delegation result envelope.
 */
export function runManagedDelegationConformance<H>(
  t: AgentConformanceTestApi,
  makeHost: MakeManagedDelegationConformanceHost<H>,
): void {
  const world = MANAGED_DELEGATION_CONFORMANCE_WORLD;
  let calls = 0;
  const identity = (toolUseId?: string): AgentConformanceCallIdentity => {
    calls += 1;
    return {
      actorKey: 'conformance-actor',
      turnKey: 'managed-delegation-turn',
      toolUseId: toolUseId ?? `managed-delegation-tool-${String(calls)}`,
    };
  };
  const run = async (
    host: ManagedDelegationConformanceHost<H>,
    surface: AgentActionSurface<H>,
    key: AgentActionToolKey,
    args: unknown,
    toolUseId?: string,
  ): Promise<{
    readonly result: AgentActionToolResult;
    readonly body: unknown;
  }> => {
    const result = await surface.execute(
      key,
      args,
      host.call(identity(toolUseId)),
    );
    return { result, body: parsed(result) };
  };

  t.describe('managed delegation tools', () => {
    t.it(
      'offers the parent tools to a parent and RequestSteering to a delegate',
      async () => {
        const host = await makeHost(world);
        const parentTools = toolKeys(host.parent).filter((key) =>
          DELEGATION_TOOL_KEYS.includes(key),
        );
        checkEqual(
          parentTools,
          [...MANAGED_DELEGATION_PARENT_TOOL_KEYS],
          'parent delegation tools',
        );
        const delegateTools = toolKeys(host.delegate).filter((key) =>
          DELEGATION_TOOL_KEYS.includes(key),
        );
        checkEqual(
          delegateTools,
          ['request_steering'],
          'delegate delegation tools',
        );
      },
    );

    t.it(
      'starts a delegate, and a retried call reaches the same one',
      async () => {
        const host = await makeHost(world);
        const args = {
          model: 'M1',
          description: 'Review the API',
          prompt: 'Review the API module and report issues.',
          thinking_level: 'high',
        };
        const first = await run(
          host,
          host.parent,
          'delegate_task',
          args,
          'spawn-retry',
        );
        checkEqual(at(first.body, 'ok'), true, 'DelegateTask ok');
        check(first.result.isError !== true, 'DelegateTask is not an error');
        const delegationId = at(first.body, 'value', 'delegationId');
        check(
          typeof delegationId === 'string',
          'DelegateTask returns a delegationId',
        );
        const retry = await run(
          host,
          host.parent,
          'delegate_task',
          args,
          'spawn-retry',
        );
        checkEqual(
          at(retry.body, 'value', 'delegationId'),
          delegationId,
          'a retried DelegateTask reaches the same delegation',
        );
        checkEqual(host.spawns().length, 1, 'spawns after a retry');
        const [spawned] = host.spawns();
        checkEqual(
          {
            modelId: spawned?.modelId,
            description: spawned?.description,
            thinkingLevel: spawned?.thinkingLevel,
            executionMode: spawned?.executionMode,
            isolation: spawned?.isolation,
            permissions: spawned?.permissions,
          },
          {
            modelId: 'M1',
            description: 'Review the API',
            thinkingLevel: 'high',
            executionMode: 'background',
            isolation: 'shared_worktree',
          },
          'the spawn request the backend got',
        );
        const inspected = await run(host, host.parent, 'inspect_delegate', {
          delegationId,
        });
        checkEqual(
          at(inspected.body, 'value', 'delegationId'),
          delegationId,
          'InspectDelegate',
        );
      },
    );

    t.it('accepts Codex field names', async () => {
      const host = await makeHost(world);
      const { body } = await run(host, host.parent, 'delegate_task', {
        model: 'M1',
        task_name: 'Docs',
        message: 'Update the docs for the new route.',
      });
      checkEqual(at(body, 'ok'), true, 'DelegateTask with Codex fields ok');
      const [spawned] = host.spawns();
      checkEqual(
        spawned?.description,
        'Docs',
        'Codex task_name as description',
      );
      checkEqual(
        spawned?.prompt,
        'Update the docs for the new route.',
        'Codex message as prompt',
      );
    });

    t.it(
      'refuses what the surface does not run before the backend',
      async () => {
        const host = await makeHost(world);
        const base = {
          model: 'M1',
          description: 'Edit',
          prompt: 'Edit the file.',
        };
        const refused: readonly [string, unknown, string][] = [
          [
            'narrower write paths',
            { ...base, permissions: { writePaths: ['src'] } },
            'capability_unavailable',
          ],
          [
            'an isolated worktree',
            { ...base, isolation: 'worktree' },
            'capability_unavailable',
          ],
          [
            'explicit capabilities',
            { ...base, capabilities: [`deferred:v1:${'a'.repeat(43)}`] },
            'capability_unavailable',
          ],
          [
            'a foreground run',
            { ...base, run_in_background: false },
            'capability_unavailable',
          ],
          [
            'nested delegation',
            { ...base, allow_nested_delegation: true },
            'capability_unavailable',
          ],
          ['an unknown field', { ...base, unknown: true }, 'invalid_request'],
          [
            'a missing prompt',
            { model: 'M1', description: 'Edit' },
            'invalid_request',
          ],
        ];
        for (const [label, args, code] of refused) {
          const { result, body } = await run(
            host,
            host.parent,
            'delegate_task',
            args,
          );
          check(result.isError === true, `${label} is an error`);
          checkEqual(at(body, 'error', 'code'), code, `${label} error code`);
        }
        const followUp = await run(host, host.parent, 'message_delegate', {
          delegationId: world.settled.delegationId,
          operation: 'follow_up',
          message: 'Now fix them.',
          permissions: { writePaths: ['.'] },
        });
        checkEqual(
          at(followUp.body, 'error', 'code'),
          'capability_unavailable',
          'a follow-up that changes write access',
        );
        checkEqual(host.writes(), [], 'backend writes after refused calls');
      },
    );

    t.it('reads a settled result, lists delegates and models', async () => {
      const host = await makeHost(world);
      const output = await run(host, host.parent, 'get_delegate_output', {
        delegationId: world.settled.delegationId,
        resultIndex: 1,
      });
      checkEqual(
        at(output.body, 'value', 'result', 'finalText'),
        world.settled.resultText,
        'GetDelegateOutput result text',
      );
      const missing = await run(host, host.parent, 'get_delegate_output', {
        delegationId: world.settled.delegationId,
        resultIndex: 2,
      });
      checkEqual(
        at(missing.body, 'error', 'code'),
        'invalid_request',
        'a resultIndex the delegate lacks',
      );
      const listed = await run(host, host.parent, 'list_delegates', {});
      const ids = at(listed.body, 'value', 'delegations');
      check(
        Array.isArray(ids) &&
          ids.some(
            (entry) => at(entry, 'delegationId') === world.settled.delegationId,
          ),
        'ListDelegates lists the settled delegate',
      );
      const withModels = await run(host, host.parent, 'list_delegates', {
        includeModels: true,
      });
      checkEqual(
        at(withModels.body, 'value', 'recommendedModelId'),
        world.models.recommendedModelId,
        'ListDelegates includeModels recommends a model',
      );
      checkEqual(
        at(withModels.body, 'value', 'models', 0, 'modelId'),
        'M1',
        'ListDelegates includeModels lists models',
      );
      const badList = await run(host, host.parent, 'list_delegates', {
        includeCapabilities: true,
      });
      checkEqual(
        at(badList.body, 'error', 'code'),
        'invalid_request',
        'ListDelegates includeCapabilities',
      );
    });

    t.it(
      'answers a delegation outside the caller’s tree as not one of its descendants',
      async () => {
        const host = await makeHost(world);
        for (const key of [
          'inspect_delegate',
          'get_delegate_output',
          'stop_delegate',
        ] as const) {
          const { body } = await run(host, host.parent, key, {
            delegationId: world.foreignDelegationId,
          });
          checkEqual(
            at(body, 'error', 'code'),
            'parent_unavailable',
            `${key} on a foreign delegation`,
          );
        }
        checkEqual(host.writes(), [], 'backend writes after foreign calls');
      },
    );

    t.it('messages and stops a delegate, keyed by the tool call', async () => {
      const host = await makeHost(world);
      const followUp = await run(host, host.parent, 'message_delegate', {
        delegationId: world.settled.delegationId,
        operation: 'follow_up',
        message: 'Now fix them.',
      });
      checkEqual(
        at(followUp.body, 'value', 'runGeneration'),
        2,
        'follow-up run generation',
      );
      const interrupt = await run(host, host.parent, 'message_delegate', {
        delegationId: world.settled.delegationId,
        operation: 'interrupt',
      });
      checkEqual(at(interrupt.body, 'ok'), true, 'interrupt ok');
      const stop = await run(host, host.parent, 'stop_delegate', {
        delegationId: world.settled.delegationId,
      });
      checkEqual(
        at(stop.body, 'value', 'accepted'),
        true,
        'StopDelegate accepted',
      );
      const writes = host.writes();
      checkEqual(
        writes.map((write) => write.kind),
        ['message', 'message', 'stop'],
        'backend writes',
      );
      check(
        new Set(writes.map((write) => write.key)).size === writes.length,
        'each tool call has its own key',
      );
    });

    t.it('lets a delegate ask for steering', async () => {
      const host = await makeHost(world);
      const { body } = await run(host, host.delegate, 'request_steering', {
        message: 'Should I also update the OpenAPI file?',
      });
      check(
        typeof at(body, 'value', 'requestId') === 'string',
        'RequestSteering requestId',
      );
      checkEqual(
        host.writes().map((write) => write.kind),
        ['steering'],
        'backend writes after RequestSteering',
      );
      const refused = await run(host, host.delegate, 'delegate_task', {
        model: 'M1',
        description: 'Nested',
        prompt: 'Start another.',
      });
      check(
        refused.result.isError === true,
        'a read-only delegate can’t delegate',
      );
    });
  });
}

/**
 * The reference host for the managed delegation suite: the shared surface
 * over the in-memory backend, with the parent tools for the world's chat and
 * a read-only delegate's restricted surface.
 */
export function createReferenceManagedDelegationHost(
  world: ManagedDelegationConformanceWorld,
  brand: AgentActionBrand,
): ManagedDelegationConformanceHost<null> {
  const backend = createReferenceDelegationBackend(world);
  const surface = (role: 'parent' | 'delegate'): AgentActionSurface<null> =>
    createAgentActionSurface<null, never>({
      brand,
      capabilities: {
        executionScope: 'worktree',
        actionTypes: [],
        chatCreatePlacements: [],
        watcherTriggers: [],
        watcherTargetScope: 'current_workspace',
        split: { forked: false, branched: false },
        hiddenInstructions: false,
        limits: false,
        managedDelegation: true,
      },
      families: [],
      managedDelegation: {
        port: backend.port,
        parentTools: role === 'parent',
        requestSteering: role === 'delegate',
      },
    });
  return {
    parent: surface('parent'),
    delegate: restrictAgentActionSurfaceForDelegatedChild(
      surface('delegate'),
      NARROWEST_DELEGATED_CHILD_GRANT,
    ),
    call: (identity) => ({
      scope: { workspaceId: 'w1', worktreeId: 't1', chatId: 'c1' },
      actorKey: identity.actorKey,
      ...(identity.turnKey === undefined ? {} : { turnKey: identity.turnKey }),
      ...(identity.toolUseId === undefined
        ? {}
        : { toolUseId: identity.toolUseId }),
      host: null,
    }),
    writes: backend.writes,
    spawns: backend.spawns,
  };
}

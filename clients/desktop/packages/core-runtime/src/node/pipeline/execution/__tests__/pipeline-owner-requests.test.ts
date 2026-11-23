// CAN-5095: pipeline owner requests ride worker.pipeline.hostRequests beside
// host steps; their capabilities return host-locally in
// _execution.pipelineOwnerValues and never in params.
import {
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_OWNER_ACTIONS,
  WORKER_PIPELINE_OWNER_SCOPE_PENDING_MAX,
  WORKER_PIPELINE_STREAM_DEFINITIONS,
  WorkerPipelineExecutionStartParamsSchema,
  WorkerPipelineHostActionRequestSchema,
  WorkerPipelineHostRequestsParamsSchema,
  WorkerPipelineHostResultSchema,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostRequestsItem,
  type WorkerPipelineHostRespondResult,
  type WorkerPipelineHostResult,
} from '@canopy/protocol/canopy-core';

import { createCanopyDispatcher } from '../../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../../runtime/errors';
import type { CanopyDispatcher } from '../../../../runtime/types';
import {
  PipelineHostRequestBroker,
  PipelineHostUnavailableError,
  createWorkerPipelineHostRequestHandlers,
  pipelineHostCoreCaller,
  settlePipelineHostRequests,
} from '../host-requests';

const caller = pipelineHostCoreCaller('authority');
const CANARY = 'http://127.0.0.1:9/codex-gateway/canary-5095';
const REDACTED: WorkerPipelineHostResult = {
  status: 'failure',
  failureReason: null,
  message: 'The host step failed unexpectedly.',
  outputs: {},
};

const instructions = {
  'worker.pipeline.hostRequest.respond':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
      'worker.pipeline.hostRequest.respond'
    ],
};
const streams = {
  'worker.pipeline.hostRequests':
    WORKER_PIPELINE_STREAM_DEFINITIONS['worker.pipeline.hostRequests'],
};

function compose(
  broker: PipelineHostRequestBroker,
): CanopyDispatcher<Record<never, never>, typeof instructions, typeof streams> {
  const handlers = createWorkerPipelineHostRequestHandlers(broker);
  return createCanopyDispatcher({
    profile: 'core+worker',
    definitions: { queries: {}, instructions, streams },
    handlers: { queries: {}, ...handlers },
  });
}

function hostRequest(
  requestId: string,
  request: WorkerPipelineHostRequest['request'],
): WorkerPipelineHostRequest {
  return {
    requestId,
    executionId: 'execution-1',
    jobId: 'job',
    stepId: 'step',
    childExecutionId: null,
    attempt: 0,
    iteration: 0,
    owner: null,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    request,
  };
}

const invocation = {
  action: 'owner.model.invocation',
  harness: 'claude',
  routeSessionId: 'route-1',
} as const;

const invocationValue = {
  kind: 'model.invocation',
  source: 'claude-managed',
  harness: 'claude',
  runtimeModel: 'opus',
  aiCreditsRouted: false,
  modelGatewayRouted: false,
  accountProxyRouted: true,
  accountProxyConnectionId: 'connection-1',
} as const;

describe('pipeline owner requests', () => {
  it('an owner request round-trips with host-local values that stay out of params', async () => {
    const broker = new PipelineHostRequestBroker();
    const dispatcher = compose(broker);
    const instruction = jest.spyOn(dispatcher, 'instruction');
    const stop = await settlePipelineHostRequests({
      dispatcher,
      caller,
      apply: (request) =>
        Promise.resolve({
          result: { status: 'owner', value: invocationValue },
          values: {
            requestId: request.requestId,
            env: { ANTHROPIC_BASE_URL: CANARY },
          },
        }),
    });
    const settlement = await broker.raiseOwner(
      hostRequest('owner-1', invocation),
      new AbortController().signal,
    );
    expect(settlement).toEqual({
      result: { status: 'owner', value: invocationValue },
      values: { requestId: 'owner-1', env: { ANTHROPIC_BASE_URL: CANARY } },
    });
    expect(instruction).toHaveBeenCalledTimes(1);
    const [, params, options] = instruction.mock.calls[0] ?? [];
    expect(JSON.stringify(params)).not.toContain(CANARY);
    expect(options?.execution?.pipelineOwnerValues).toEqual({
      requestId: 'owner-1',
      env: { ANTHROPIC_BASE_URL: CANARY },
    });
    stop();
    await dispatcher.shutdown();
  });

  it('values for another request are refused and the request stays pending', async () => {
    const broker = new PipelineHostRequestBroker();
    const dispatcher = compose(broker);
    broker.subscribe(() => undefined);
    const raised = broker.raiseOwner(
      hostRequest('owner-2', invocation),
      new AbortController().signal,
    );
    const respond = (
      requestId: string,
    ): Promise<WorkerPipelineHostRespondResult> =>
      dispatcher.instruction(
        'worker.pipeline.hostRequest.respond',
        {
          executionId: 'execution-1',
          requestId: 'owner-2',
          result: { status: 'owner', value: invocationValue },
        },
        {
          caller,
          metadata: {},
          execution: {
            childEnvironment: {},
            pipelineOwnerValues: { requestId, env: { A: 'b' } },
          },
        },
      );
    const refused: unknown = await respond('owner-other').catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(CanopyOperationError);
    expect(refused).toMatchObject({ payload: { kind: 'invalid_argument' } });
    await expect(respond('owner-2')).resolves.toMatchObject({
      outcome: 'applied',
    });
    await expect(raised).resolves.toEqual({
      result: { status: 'owner', value: invocationValue },
      values: { requestId: 'owner-2', env: { A: 'b' } },
    });
    await dispatcher.shutdown();
  });

  it('a host step never takes an owner answer, and an owner request never takes a host-step answer', async () => {
    const broker = new PipelineHostRequestBroker();
    broker.subscribe(() => undefined);
    const signal = new AbortController().signal;

    const hostStep = broker.raise(
      hostRequest('host-1', {
        action: 'move-to-group',
        task: { kind: 'project', projectId: 'p', taskId: 't' },
        target: { kind: 'remove' },
      }),
      signal,
    );
    broker.respond('execution-1', 'host-1', {
      status: 'owner',
      value: invocationValue,
    });
    await expect(hostStep).resolves.toEqual(REDACTED);

    const answeredSuccess = broker.raiseOwner(
      hostRequest('owner-3', invocation),
      signal,
    );
    broker.respond(
      'execution-1',
      'owner-3',
      { status: 'success', outputs: {} },
      { requestId: 'owner-3', env: { A: 'b' } },
    );
    await expect(answeredSuccess).resolves.toEqual({ result: REDACTED });

    const wrongKind = broker.raiseOwner(
      hostRequest('owner-4', invocation),
      signal,
    );
    broker.respond('execution-1', 'owner-4', {
      status: 'owner',
      value: { kind: 'model.release' },
    });
    await expect(wrongKind).resolves.toEqual({ result: REDACTED });
  });

  it('the request schema admits each owner action and refuses extras', () => {
    const call = { callId: 'c', tool: 't', arguments: {} };
    const variantId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const minimal: Record<
      (typeof WORKER_PIPELINE_OWNER_ACTIONS)[number],
      object
    > = {
      'owner.model.invocation': { harness: 'claude' },
      'owner.model.routing': { provider: 'codex' },
      'owner.model.release': { routeSessionId: 'r' },
      'owner.model.policy': { check: 'active' },
      'owner.model.policyRefusal': { modelId: 'm' },
      'owner.ledger.open': {
        physicalJobId: 'j',
        logicalJobId: 'j',
        jobName: 'Job',
        stepId: 's',
        stepName: 'Step',
        attempt: 0,
        iteration: 0,
        harness: 'claude',
        permissionPreset: 'read_only',
      },
      'owner.ledger.subprocessTools': { attemptKey: 'a', cwd: '/tmp/run' },
      'owner.ledger.close': { attemptKey: 'a', outcome: { kind: 'settled' } },
      'owner.ledger.codexTools': { attemptKey: 'a', cwd: '/tmp/run' },
      'owner.ledger.codexToolAuthorize': { toolsKey: 'k', threadId: 't', call },
      'owner.ledger.codexToolExecute': { toolsKey: 'k', threadId: 't', call },
      'owner.ledger.codexToolsDispose': { toolsKey: 'k' },
      'owner.ledger.operation': {
        attemptKey: 'a',
        operation: 'core.ledger.owners.list',
        params: {},
      },
      'owner.claude.modAdmission': { cwd: '/tmp/run', settingSources: [] },
      'owner.model.agentAlias': { agentId: 'agent_model_1' },
      'owner.plan.create': { content: '# Plan' },
      'owner.plan.update': { planId: 'plan-1', approve: false },
      'owner.mcp.bind': {
        marketplaceId: 'market',
        pluginName: 'notes',
        serverName: 'docs',
        contentHash: 'a'.repeat(64),
      },
      'owner.mcp.authorize': { routeRef: 'mcpr1_AAAAAAAAAAAAAAAAAAAAAA' },
      'owner.mcp.rejected': { grantId: 'mcpg1_AAAAAAAAAAAAAAAAAAAAAA' },
      'owner.codex.pluginRefs': { selections: { pluginRefs: [] } },
      'owner.precommit.failure': {
        repositories: [{ error: 'hook failed', precommitFailureError: 'lint' }],
      },
      'owner.pipeline.childCapabilities': {
        childExecutionId: 'child-1',
        document: '{"name":"Child"}',
      },
      'owner.isolatedJob.write': {
        side: 'request',
        variantId,
        payload: { sha256: 'a'.repeat(64), byteSize: 4 },
        offset: 0,
        chunk: 'e30=',
      },
      'owner.isolatedJob.read': { side: 'request', offset: 0 },
      'owner.isolatedJob.run': {
        variantId,
        commit: 'b'.repeat(40),
        request: { sha256: 'a'.repeat(64), byteSize: 4 },
        logicalJobId: 'review',
      },
      'owner.definition.precheck': {
        op: 'delete',
        definitionId: 'definition-1',
        scope: {},
      },
      'owner.definition.effects': {
        op: 'reconcile',
        phase: 'reconcile',
        definitionId: null,
      },
    };
    for (const action of WORKER_PIPELINE_OWNER_ACTIONS) {
      expect(
        WorkerPipelineHostActionRequestSchema.safeParse({
          action,
          ...minimal[action],
        }).success,
      ).toBe(true);
    }
    expect(
      WorkerPipelineHostActionRequestSchema.safeParse({
        action: 'owner.model.release',
        routeSessionId: 'r',
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      WorkerPipelineHostActionRequestSchema.safeParse({
        action: 'owner.model.policy',
        check: 'blocked',
      }).success,
    ).toBe(false);
    // CAN-6892: the parent names its variant's request and reads its
    // outcome; the variant's own host names no variant.
    for (const [action, body] of [
      [
        'owner.isolatedJob.write',
        { ...minimal['owner.isolatedJob.write'], side: 'outcome' },
      ],
      ['owner.isolatedJob.read', { side: 'request', variantId, offset: 0 }],
      ['owner.isolatedJob.read', { side: 'outcome', offset: 0 }],
      [
        'owner.isolatedJob.run',
        { ...minimal['owner.isolatedJob.run'], variantId: 'not-a-uuid' },
      ],
    ] as const)
      expect(
        WorkerPipelineHostActionRequestSchema.safeParse({ action, ...body })
          .success,
      ).toBe(false);
    // CAN-6168: a bind names a server and a hash; no OAuth field crosses.
    expect(
      WorkerPipelineHostActionRequestSchema.safeParse({
        action: 'owner.mcp.bind',
        ...minimal['owner.mcp.bind'],
        url: 'https://evil.example.test/',
      }).success,
    ).toBe(false);
    // CAN-5832: an Agent alias names an Agent model id, nothing else.
    expect(
      WorkerPipelineHostActionRequestSchema.safeParse({
        action: 'owner.model.agentAlias',
        agentId: 'sonnet',
      }).success,
    ).toBe(false);
    expect(
      WorkerPipelineHostActionRequestSchema.safeParse({
        action: 'owner.ledger.codexToolExecute',
        toolsKey: 'k',
        threadId: 't',
        call: { payload: 'x'.repeat(2 * 1024 * 1024) },
      }).success,
    ).toBe(false);
    // Tool payloads take their own 1 MiB bound, past the 32 KiB JSON default.
    const large = {
      contentItems: [{ type: 'inputText', text: 'x'.repeat(100 * 1024) }],
    };
    expect(
      WorkerPipelineHostActionRequestSchema.safeParse({
        action: 'owner.ledger.codexToolExecute',
        toolsKey: 'k',
        threadId: 't',
        call: large,
      }).success,
    ).toBe(true);
    expect(
      WorkerPipelineHostResultSchema.safeParse({
        status: 'owner',
        value: { kind: 'ledger.codexToolExecute', response: large },
      }).success,
    ).toBe(true);
  });

  it('an MCP header rides only the authorization that granted it (CAN-6168)', async () => {
    const HEADER = 'Bearer mcp-header-canary-6168';
    const settle = async (
      request: WorkerPipelineHostRequest['request'],
      value: unknown,
    ): Promise<unknown> => {
      const broker = new PipelineHostRequestBroker();
      const dispatcher = compose(broker);
      const stop = await settlePipelineHostRequests({
        dispatcher,
        caller,
        apply: (raised) =>
          Promise.resolve({
            result: WorkerPipelineHostResultSchema.parse({
              status: 'owner',
              value,
            }),
            values: {
              requestId: raised.requestId,
              mcpAuthorization: { authorization: HEADER },
            },
          }),
      });
      const settlement = await broker.raiseOwner(
        hostRequest('owner-mcp', request),
        new AbortController().signal,
      );
      stop();
      await dispatcher.shutdown();
      return settlement;
    };
    const authorize = {
      action: 'owner.mcp.authorize',
      routeRef: 'mcpr1_AAAAAAAAAAAAAAAAAAAAAA',
    } as const;
    await expect(
      settle(authorize, {
        kind: 'mcp.authorize',
        grantId: 'mcpg1_AAAAAAAAAAAAAAAAAAAAAA',
      }),
    ).resolves.toMatchObject({
      values: { mcpAuthorization: { authorization: HEADER } },
    });
    for (const [request, value] of [
      [authorize, { kind: 'mcp.authorize', grantId: null }],
      [invocation, invocationValue],
    ] as const) {
      const settlement = await settle(request, value);
      expect(JSON.stringify(settlement)).not.toContain(HEADER);
    }
  });

  // CAN-7522: definition requests belong to no run. They ride a reserved
  // scope, reach only an owner that says it serves them, and a scope holds a
  // bounded number pending.
  const DEFINITIONS_SCOPE = 'core:pipeline-definitions';
  const SERVES = [
    { kind: 'owner.definition.precheck', revision: 1 },
    { kind: 'owner.definition.effects', revision: 1 },
  ];
  const precheck = {
    action: 'owner.definition.precheck',
    op: 'delete',
    definitionId: 'definition-1',
    scope: {},
  } as const;
  const allowed: WorkerPipelineHostResult = {
    status: 'owner',
    value: { kind: 'definition.precheck', answer: { allowed: true } },
  };

  function scopeRequest(requestId: string): WorkerPipelineHostRequest {
    return {
      ...hostRequest(requestId, precheck),
      executionId: DEFINITIONS_SCOPE,
      jobId: '_run',
      stepId: '_run',
    };
  }

  function ids(items: readonly WorkerPipelineHostRequestsItem[]): string[] {
    return items.map((item) => item.requestId);
  }

  it('a definition request reaches only an owner that serves it; every owner still gets the rest (CAN-7522)', async () => {
    const broker = new PipelineHostRequestBroker();
    const signal = new AbortController().signal;
    const legacy: WorkerPipelineHostRequestsItem[] = [];
    broker.subscribe((item) => legacy.push(item));
    await expect(
      broker.raiseOwner(scopeRequest('definition-0'), signal),
    ).rejects.toBeInstanceOf(PipelineHostUnavailableError);
    expect(legacy).toEqual([]);

    const unknownOnly: WorkerPipelineHostRequestsItem[] = [];
    broker.subscribe((item) => unknownOnly.push(item), {
      serves: [{ kind: 'owner.future.kind', revision: 7 }],
    });
    const serving: WorkerPipelineHostRequestsItem[] = [];
    broker.subscribe((item) => serving.push(item), { serves: SERVES });
    const raised = broker.raiseOwner(scopeRequest('definition-1'), signal);
    expect(ids(serving)).toEqual(['definition-1']);
    expect(legacy).toEqual([]);
    expect(unknownOnly).toEqual([]);

    // A pending definition request reaches a later owner only if it serves it.
    const lateLegacy: WorkerPipelineHostRequestsItem[] = [];
    broker.subscribe((item) => lateLegacy.push(item));
    const lateServing: WorkerPipelineHostRequestsItem[] = [];
    broker.subscribe((item) => lateServing.push(item), { serves: SERVES });
    expect(lateLegacy).toEqual([]);
    expect(ids(lateServing)).toEqual(['definition-1']);

    // Every owner still receives the requests every owner answers.
    const run = broker.raiseOwner(hostRequest('owner-1', invocation), signal);
    for (const items of [legacy, unknownOnly, serving, lateLegacy, lateServing])
      expect(ids(items)).toContain('owner-1');

    expect(broker.respond(DEFINITIONS_SCOPE, 'definition-1', allowed)).toEqual(
      expect.objectContaining({ outcome: 'applied' }),
    );
    await expect(raised).resolves.toEqual({ result: allowed });
    broker.respond('execution-1', 'owner-1', {
      status: 'owner',
      value: invocationValue,
    });
    await run;
  });

  it('the owner names what it serves when it opens the stream (CAN-7522)', async () => {
    const broker = new PipelineHostRequestBroker();
    const dispatcher = compose(broker);
    const received: unknown[] = [];
    const handle = await dispatcher.openStream(
      'worker.pipeline.hostRequests',
      { serves: SERVES },
      {
        caller,
        onFrame: (frame) => {
          if (frame.kind === 'item') received.push(frame.item);
        },
      },
    );
    const raised = broker.raiseOwner(
      scopeRequest('definition-2'),
      new AbortController().signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual([
      expect.objectContaining({ requestId: 'definition-2' }),
    ]);
    broker.respond(DEFINITIONS_SCOPE, 'definition-2', allowed);
    await raised;
    handle.close();
    await dispatcher.shutdown();

    expect(
      WorkerPipelineHostRequestsParamsSchema.safeParse({
        serves: Array.from({ length: 65 }, () => SERVES[0]),
      }).success,
    ).toBe(false);
    expect(
      WorkerPipelineHostRequestsParamsSchema.safeParse({
        serves: [{ kind: 'owner.definition.precheck', revision: 0 }],
      }).success,
    ).toBe(false);
  });

  it('a scope holds at most 64 pending requests, and the 65th is refused before anyone sees it (CAN-7522)', async () => {
    expect(WORKER_PIPELINE_OWNER_SCOPE_PENDING_MAX).toBe(64);
    const broker = new PipelineHostRequestBroker();
    const seen: WorkerPipelineHostRequestsItem[] = [];
    broker.subscribe((item) => seen.push(item), { serves: SERVES });
    const controller = new AbortController();
    const raised = Array.from({ length: 64 }, (_, index) =>
      broker.raiseOwner(scopeRequest(`definition-${index}`), controller.signal),
    );
    await expect(
      broker.raiseOwner(scopeRequest('definition-64'), controller.signal),
    ).rejects.toBeInstanceOf(PipelineHostUnavailableError);
    expect(seen).toHaveLength(64);
    expect(ids(seen)).not.toContain('definition-64');

    // A run's own requests never count against a scope.
    const runs = Array.from({ length: 65 }, (_, index) =>
      broker.raiseOwner(
        hostRequest(`owner-${index}`, invocation),
        controller.signal,
      ),
    );
    expect(seen).toHaveLength(129);

    // Settling one makes room for one more.
    broker.respond(DEFINITIONS_SCOPE, 'definition-0', allowed);
    await expect(raised[0]).resolves.toEqual({ result: allowed });
    const next = broker.raiseOwner(
      scopeRequest('definition-65'),
      controller.signal,
    );
    expect(ids(seen)).toContain('definition-65');
    controller.abort(new Error('test over'));
    await Promise.allSettled([...raised, ...runs, next]);
  });

  it('a scope request withdrawn at its deadline is announced, and a late answer is already settled (CAN-7522)', async () => {
    const broker = new PipelineHostRequestBroker({ announceWithdrawals: true });
    const seen: WorkerPipelineHostRequestsItem[] = [];
    broker.subscribe((item) => seen.push(item), { serves: SERVES });
    const controller = new AbortController();
    const raised = broker.raiseOwner(
      scopeRequest('definition-late'),
      controller.signal,
    );
    controller.abort(new Error('deadline'));
    await expect(raised).rejects.toThrow('deadline');
    expect(seen).toEqual([
      expect.objectContaining({ requestId: 'definition-late' }),
      {
        withdrawn: true,
        executionId: DEFINITIONS_SCOPE,
        requestId: 'definition-late',
      },
    ]);
    expect(
      broker.respond(DEFINITIONS_SCOPE, 'definition-late', allowed),
    ).toEqual(expect.objectContaining({ outcome: 'already_settled' }));
  });

  it('a run id never takes a reserved scope (CAN-7522)', () => {
    const start = {
      executionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      pipelineId: 'pipeline-1',
      definitionSource: 'user',
      runScope: 'global',
      workspaceId: null,
      worktreeId: null,
      owner: 'personal',
      initiationSource: 'user',
    };
    expect(
      WorkerPipelineExecutionStartParamsSchema.safeParse(start).success,
    ).toBe(true);
    for (const executionId of ['run-1', 'exec_42', 'scheduled:abc', 'Core:x'])
      expect(
        WorkerPipelineExecutionStartParamsSchema.safeParse({
          ...start,
          executionId,
        }).success,
      ).toBe(true);
    for (const executionId of [
      'core:pipeline-definitions',
      'core:operation-ledger',
      'core:anything',
    ])
      expect(
        WorkerPipelineExecutionStartParamsSchema.safeParse({
          ...start,
          executionId,
        }).success,
      ).toBe(false);
    const child = {
      action: 'run-pipeline',
      pipelineId: 'child',
      document: '{"name":"Child"}',
      inputs: {},
      target: { scope: 'global' },
    };
    expect(
      WorkerPipelineHostActionRequestSchema.safeParse({
        ...child,
        childExecutionId: 'child-1',
      }).success,
    ).toBe(true);
    expect(
      WorkerPipelineHostActionRequestSchema.safeParse({
        ...child,
        childExecutionId: 'core:pipeline-definitions',
      }).success,
    ).toBe(false);
  });
});

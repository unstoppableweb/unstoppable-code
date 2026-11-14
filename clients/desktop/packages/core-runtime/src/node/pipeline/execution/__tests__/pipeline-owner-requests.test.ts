// CAN-5095: pipeline owner requests ride worker.pipeline.hostRequests beside
// host steps; their capabilities return host-locally in
// _execution.pipelineOwnerValues and never in params.
import {
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_OWNER_ACTIONS,
  WORKER_PIPELINE_STREAM_DEFINITIONS,
  WorkerPipelineHostActionRequestSchema,
  WorkerPipelineHostResultSchema,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostRespondResult,
  type WorkerPipelineHostResult,
} from '@canopy/protocol/canopy-core';

import { createCanopyDispatcher } from '../../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../../runtime/errors';
import type { CanopyDispatcher } from '../../../../runtime/types';
import {
  PipelineHostRequestBroker,
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
});

// CAN-5771: the supervisor relays an owner-bound run's host steps to the
// daemon's owner channel and settlements back, waits for an owner, and
// pauses owner-bound runs once the owner is gone. A fake host records
// requests and lets each test answer.
import { EventEmitter } from 'node:events';
import type {
  CanopyHostExecution,
  WorkerPipelineExecution,
  WorkerPipelineExecutionStartParams,
  WorkerPipelineHostRequest,
  WorkerPipelineHostRequestsItem,
  WorkerPipelineHostStepValues,
} from '@canopy/protocol/canopy-core';
import type { CanopyHandlerContext } from '../../../../runtime/types';
import { NO_EXECUTION_SECRETS } from '../../../execution-secrets';
import { createPipelineOwnerChannel } from '../../execution';
import {
  PipelineHostSupervisor,
  prepareNativePipelineOwnerRun,
  prepareNativePipelineSurvival,
  preparePipelineOwnerSetupLeases,
  pausedPipelineSurvivalAssessment,
  unadmittedPipelineSetupFailure,
  type PipelineHostLaunch,
  type PipelineHostMessage,
  type PipelineHostProcess,
  type PipelineHostRequest,
  type PipelineHostRequestMessage,
  type PipelineHostSupervisorOptions,
  type PipelineNativeRouteEvidence,
  type PipelineOwnerRunAuthority,
  type PipelineOwnerRunIdentity,
  type PipelineOwnerSetupLease,
} from '..';

class FakeHost extends EventEmitter implements PipelineHostProcess {
  readonly requests: PipelineHostRequestMessage[] = [];

  postMessage(message: PipelineHostRequestMessage): void {
    this.requests.push(message);
    const { request } = message;
    if (
      request.op === 'configure' ||
      request.op === 'hostSettled' ||
      request.op === 'ledgerOwnerAvailability'
    )
      this.reply(message.id, null);
    if (request.op === 'checkpoint')
      this.reply(message.id, { checkpointedCount: 0 });
    if (request.op === 'exit') {
      this.reply(message.id, null);
      queueMicrotask(() => this.emit('exit', 0));
    }
  }

  kill(): boolean {
    return true;
  }

  of<O extends PipelineHostRequest['op']>(
    op: O,
  ): Array<Extract<PipelineHostRequest, { op: O }>> {
    return this.requests
      .map(({ request }) => request)
      .filter(
        (request): request is Extract<PipelineHostRequest, { op: O }> =>
          request.op === op,
      );
  }

  last(op: PipelineHostRequest['op']): PipelineHostRequestMessage {
    const found = [...this.requests]
      .reverse()
      .find((message) => message.request.op === op);
    if (!found) throw new Error(`No ${op} request.`);
    return found;
  }

  reply(id: number, value: unknown): void {
    this.send({ kind: 'response', id, ok: true, value });
  }

  send(message: PipelineHostMessage): void {
    queueMicrotask(() => this.emit('message', message));
  }

  /** Delivers messages in one turn, as one read chunk does. */
  sendTogether(...messages: PipelineHostMessage[]): void {
    queueMicrotask(() => {
      for (const message of messages) this.emit('message', message);
    });
  }
}

function startParams(executionId: string): WorkerPipelineExecutionStartParams {
  return {
    executionId,
    pipelineId: 'pipeline',
    definitionSource: 'inline',
    runScope: 'worktree',
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    owner: 'personal',
    initiationSource: 'user',
  };
}

function hostExecution(ownerBound: boolean): CanopyHostExecution {
  return {
    childEnvironment: { PATH: '/usr/bin' },
    pipelineLaunch: {
      pipeline: { name: 'p', on: 'dispatch', jobs: {} },
      cwd: '/work/tree',
      bundledActionsDir: '/app/actions',
      env: {},
      secretEnv: {},
      ...(ownerBound && { ownerBound: true }),
    },
  };
}

function projection(executionId: string): WorkerPipelineExecution {
  return {
    executionId,
    pipelineId: 'pipeline',
    name: 'p',
    status: 'running',
    runScope: 'worktree',
    definitionSource: 'inline',
    owner: 'personal',
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    parentExecutionId: null,
    startedAt: '2026-11-06T00:00:00.000Z',
    completedAt: null,
    pendingPauseCount: 0,
    error: null,
  };
}

function hostRequest(
  executionId: string,
  requestId: string,
): WorkerPipelineHostRequest {
  return {
    requestId,
    executionId,
    jobId: 'j',
    stepId: 's',
    childExecutionId: null,
    attempt: 0,
    iteration: 0,
    owner: 'personal',
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    request: {
      action: 'create-worktree',
      projectId: 'workspace',
      branch: { kind: 'new', name: 'b' },
      repair: false,
      setup: 'skip',
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

const context = {} as CanopyHandlerContext;

type OwnerAnswer = (
  request: WorkerPipelineHostRequest,
  identity: PipelineOwnerRunIdentity,
  signal: AbortSignal,
) => ReturnType<PipelineOwnerRunAuthority['answer']>;

function harness(
  answerOwnerRequest?: OwnerAnswer,
  prepareOwnerRun?: PipelineHostSupervisorOptions['prepareOwnerRun'],
): {
  hosts: FakeHost[];
  supervisor: PipelineHostSupervisor;
  channel: ReturnType<typeof createPipelineOwnerChannel>;
  launch: jest.Mock<PipelineHostProcess, []>;
} {
  const hosts: FakeHost[] = [];
  const channel = createPipelineOwnerChannel();
  const launch = jest.fn<PipelineHostProcess, []>(() => {
    const host = new FakeHost();
    hosts.push(host);
    return host;
  });
  const supervisor = new PipelineHostSupervisor({
    launch,
    configure: { dataRoot: '/data' },
    resolveLaunch: (params, execution): Promise<PipelineHostLaunch> =>
      Promise.resolve({
        params,
        launch: execution.pipelineLaunch,
        processEnvironment: execution.childEnvironment,
      }),
    idleStopMs: 600_000,
    owner: channel,
    ...(prepareOwnerRun
      ? { prepareOwnerRun }
      : answerOwnerRequest && {
          prepareOwnerRun: (identity): Promise<PipelineOwnerRunAuthority> =>
            Promise.resolve({
              answer: (request, signal) =>
                answerOwnerRequest(request, identity, signal),
              dispose: () => undefined,
            }),
        }),
  });
  return { hosts, supervisor, channel, launch };
}

/**
 * An owner subscription through the channel's own stream handler. After
 * `close`, its transport is gone: the next emit returns null.
 */
async function subscribeOwner(
  channel: ReturnType<typeof createPipelineOwnerChannel>,
): Promise<{
  items: WorkerPipelineHostRequestsItem[];
  stop: () => void;
  close: () => void;
}> {
  const items: WorkerPipelineHostRequestsItem[] = [];
  let closed = false;
  const stopped = await channel.handlers.streams[
    'worker.pipeline.hostRequests'
  ]({}, context, {
    emit: (item: WorkerPipelineHostRequestsItem) => {
      if (closed) return null;
      items.push(item);
      return { epoch: 'e', sequence: items.length };
    },
    emitAt: () => null,
    end: () => undefined,
    endAt: () => undefined,
  } as never);
  return {
    items,
    stop: stopped ?? ((): void => undefined),
    close: (): void => {
      closed = true;
    },
  };
}

async function startRun(
  h: ReturnType<typeof harness>,
  executionId: string,
  ownerBound: boolean,
): Promise<FakeHost> {
  const result = h.supervisor.start(
    startParams(executionId),
    new AbortController().signal,
    NO_EXECUTION_SECRETS,
    hostExecution(ownerBound),
  );
  await settle();
  const host = h.hosts[h.hosts.length - 1];
  host.reply(host.last('start').id, projection(executionId));
  await result;
  return host;
}

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'],
  });
});

function nativeEvidence(): PipelineNativeRouteEvidence {
  return {
    version: 1,
    identity: {
      executionId: 'run-1',
      owner: 'personal',
      runScope: 'worktree',
      workspaceId: 'workspace',
      worktreeId: 'worktree',
    },
    configurationEpoch: 'configuration-1',
    catalogFingerprint: 'fixture-catalog',
    policy: 'account-independent-personal',
    gateway: 'absent',
    accountProxy: 'absent',
    aiCredits: 'absent',
    futureSelections: 'closed',
    routes: [
      {
        harness: 'claude',
        selection: 'claude-sonnet',
        requestModel: 'sonnet',
        runtimeModel: 'sonnet',
        source: 'claude-managed',
        effectiveRoute: 'native',
        authentication: 'vendor-profile',
      },
      {
        harness: 'codex',
        selection: 'gpt-codex',
        requestModel: 'gpt-codex',
        runtimeModel: 'gpt-codex',
        source: 'codex-managed',
        effectiveRoute: 'native',
        authentication: 'explicit-environment',
      },
    ],
  };
}

function nativePreparation(
  evidence: unknown = nativeEvidence(),
  ports: Parameters<typeof prepareNativePipelineOwnerRun>[2] = {
    isConfigurationCurrent: (): boolean => true,
    recordPolicyRefusal: (): void => undefined,
  },
): ReturnType<typeof prepareNativePipelineOwnerRun> {
  return prepareNativePipelineOwnerRun(
    nativeEvidence().identity,
    evidence,
    ports,
  );
}

describe('run-scoped setup leases (CAN-6996)', () => {
  function lease(): PipelineOwnerSetupLease {
    return {
      identity: nativeEvidence().identity,
      jobId: 'j',
      stepId: 's',
      request: {
        action: 'owner.model.agentAlias',
        agentId: 'agent_model_reviewer',
      },
      result: {
        kind: 'model.agentAlias',
        alias: {
          agentId: 'agent_model_reviewer',
          name: 'Reviewer',
          base: 'claude-sonnet',
          instructions: 'Review carefully.',
        },
      },
      facts: [{ id: 'agent-and-resources', version: 'content-v1' }],
    };
  }
  const signal = new AbortController().signal;

  it('answers exact versioned Mod, Agent and expanded Codex setup without answering model policy', async () => {
    const agent = lease();
    const snapshots: PipelineOwnerSetupLease[] = [
      agent,
      {
        ...lease(),
        request: {
          action: 'owner.claude.modAdmission',
          cwd: '/work/tree',
          settingSources: ['user', 'project'],
        },
        result: {
          kind: 'claude.modAdmission',
          context: {
            enabled: true,
            authority: 'ok',
            modsDisabled: true,
            admissions: [],
            ambientPlugins: [],
          },
        },
      },
      {
        ...lease(),
        request: {
          action: 'owner.codex.pluginRefs',
          selections: {
            collectionIds: ['review'],
            skillRefs: [],
            pluginRefs: [],
          },
        },
        result: {
          kind: 'codex.pluginRefs',
          selections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [{ marketplaceId: 'market', pluginName: 'review' }],
          },
          warnings: ['Expanded collection.'],
        },
      },
    ];
    let version = 'content-v1';
    const prepared = await preparePipelineOwnerSetupLeases(
      nativeEvidence().identity,
      snapshots,
      {
        isFactCurrent: (_identity, fact) =>
          Promise.resolve(fact.version === version),
      },
    );
    if (prepared.kind !== 'setup-leases') throw new Error('No setup leases.');
    const base = hostRequest('run-1', 'leased');
    for (const snapshot of snapshots) {
      expect(
        await prepared.authority.answer(
          { ...base, request: snapshot.request },
          signal,
        ),
      ).toEqual({ result: { status: 'owner', value: snapshot.result } });
    }
    expect(
      await prepared.authority.answer(
        { ...base, request: { action: 'owner.model.policy', check: 'active' } },
        signal,
      ),
    ).toBeUndefined();
    version = 'changed';
    expect(
      await prepared.authority.answer(
        { ...base, request: agent.request },
        signal,
      ),
    ).toBeUndefined();
    prepared.authority.dispose();
  });

  it('never leases an empty, foreign, ambiguous, stale or unexpanded setup', async () => {
    const valid = lease();
    for (const snapshots of [
      [],
      [{ ...lease(), identity: { ...valid.identity, executionId: 'foreign' } }],
      [{ ...lease(), identity: { ...valid.identity, workspaceId: 'foreign' } }],
      [
        valid,
        {
          ...lease(),
          result: {
            kind: 'model.agentAlias',
            alias: {
              agentId: 'agent_model_reviewer',
              name: 'Changed',
              base: 'claude-sonnet',
            },
          },
        },
      ],
      [{ ...lease(), facts: [] }],
      [
        {
          ...lease(),
          result: {
            kind: 'model.agentAlias',
            alias: {
              agentId: 'agent_model_reviewer',
              name: 'Unresolved resources',
              base: 'claude-sonnet',
              pluginSelections: {
                collectionIds: ['unexpanded'],
                skillRefs: [],
                pluginRefs: [],
                unresolvedCapabilities: [
                  {
                    kind: 'plugin',
                    sourceId: 'm',
                    catalogId: 'c',
                    name: 'missing',
                  },
                ],
              },
            },
          },
        },
      ],
      [
        {
          ...lease(),
          request: {
            action: 'owner.claude.modAdmission',
            cwd: '/work/tree',
            settingSources: ['user'],
          },
          result: {
            kind: 'claude.modAdmission',
            context: {
              enabled: true,
              authority: 'unreadable',
              modsDisabled: false,
              admissions: [],
              ambientPlugins: [],
            },
          },
        },
      ],
      [
        {
          ...lease(),
          request: { action: 'owner.codex.pluginRefs', selections: {} },
          result: { kind: 'codex.pluginRefs', selections: {}, warnings: [] },
        },
      ],
      [
        {
          ...lease(),
          request: { action: 'owner.codex.pluginRefs', selections: {} },
          result: {
            kind: 'codex.pluginRefs',
            selections: {
              collectionIds: ['unexpanded'],
              skillRefs: [],
              pluginRefs: [],
            },
            warnings: [],
          },
        },
      ],
    ] satisfies PipelineOwnerSetupLease[][]) {
      expect(
        (
          await preparePipelineOwnerSetupLeases(valid.identity, snapshots, {
            isFactCurrent: () => Promise.resolve(true),
          })
        ).kind,
      ).toBe('app-dependent');
    }
    expect(
      await preparePipelineOwnerSetupLeases(valid.identity, [valid], {
        isFactCurrent: () => Promise.resolve(false),
      }),
    ).toEqual({ kind: 'app-dependent', reason: 'stale-lease' });
    expect(
      await preparePipelineOwnerSetupLeases(valid.identity, [valid], {
        isFactCurrent: () => Promise.reject(new Error('unreadable content')),
      }),
    ).toEqual({ kind: 'app-dependent', reason: 'stale-lease' });
  });

  it('does not share leases with another step, run, child or changed request, and revokes them on disposal', async () => {
    const snapshot = lease();
    const prepared = await preparePipelineOwnerSetupLeases(
      snapshot.identity,
      [snapshot],
      { isFactCurrent: () => Promise.resolve(true) },
    );
    if (prepared.kind !== 'setup-leases') throw new Error('No setup leases.');
    const request = {
      ...hostRequest('run-1', 'lease'),
      request: snapshot.request,
    };
    for (const foreign of [
      { ...request, executionId: 'other' },
      { ...request, owner: 'org:other' },
      { ...request, childExecutionId: 'child' },
      { ...request, jobId: 'another' },
      { ...request, stepId: 'another' },
      {
        ...request,
        request: {
          action: 'owner.model.agentAlias',
          agentId: 'agent_model_other',
        },
      },
    ] satisfies WorkerPipelineHostRequest[])
      expect(await prepared.authority.answer(foreign, signal)).toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await prepared.authority.answer(request, aborted.signal),
    ).toBeUndefined();
    prepared.authority.dispose();
    expect(await prepared.authority.answer(request, signal)).toBeUndefined();
  });
});

describe('run-scoped daemon native model answers (CAN-6996)', () => {
  it('requires current, harness-matched native evidence', () => {
    for (const [harness, source] of [
      ['claude', 'codex-managed'],
      ['codex', 'claude-managed'],
    ] as const) {
      const proof = nativeEvidence();
      proof.routes = proof.routes.map((route) =>
        route.harness === harness ? { ...route, source } : route,
      );
      expect(nativePreparation(proof).kind).toBe('app-dependent');
    }
    expect(
      nativePreparation(nativeEvidence(), {
        isConfigurationCurrent: () => false,
        recordPolicyRefusal: () => undefined,
      }).kind,
    ).toBe('app-dependent');
    expect(
      nativePreparation(nativeEvidence(), {
        isConfigurationCurrent: () => {
          throw new Error('configuration unavailable');
        },
        recordPolicyRefusal: () => undefined,
      }),
    ).toEqual({ kind: 'app-dependent', blockers: ['configuration-stale'] });
  });

  it("keeps the app's pause explanation when it withheld route evidence", async () => {
    const identity = nativeEvidence().identity;
    /** The setup failure a run pauses with, as the daemon and its host record it. */
    const pausedWith = async (
      launch: Partial<PipelineHostLaunch['launch']>,
    ): Promise<PipelineHostLaunch['launch']['nativeSetupFailure']> => {
      const start: PipelineHostLaunch = {
        params: startParams('run-1'),
        launch: {
          pipeline: { name: 'p', on: 'dispatch', jobs: {} },
          cwd: '/work/tree',
          bundledActionsDir: '/app/actions',
          env: {},
          secretEnv: {},
          ownerBound: true,
          ...launch,
        },
        processEnvironment: {},
      };
      await expect(
        prepareNativePipelineSurvival(
          identity,
          start,
          '/data',
          new AbortController().signal,
          'darwin',
          (reason): void => {
            start.launch.nativeSetupFailure = reason;
          },
        ),
      ).resolves.toBeUndefined();
      return unadmittedPipelineSetupFailure(start.launch);
    };
    const setupLease = (
      launch: Partial<PipelineHostLaunch['launch']>,
      failure: PipelineHostLaunch['launch']['nativeSetupFailure'],
    ): string | undefined =>
      pausedPipelineSurvivalAssessment({
        identity,
        blockers: [...(launch.nativeRouteBlockers ?? []), 'setup-lease'],
        ...(failure && { setupFailure: failure }),
      }).blockers.find((blocker) => blocker.code === 'setup-lease')
        ?.explanation;

    // An organization route whose Agent also failed resource admission.
    const orgOwned = {
      nativeRouteBlockers: ['policy' as const, 'setup-lease' as const],
      nativeSetupFailure: 'resource-selection' as const,
    };
    const orgFailure = await pausedWith(orgOwned);
    expect(orgFailure).toBe('resource-selection');
    expect(setupLease(orgOwned, orgFailure)).toBe(
      'The selected Agent or resources have unverified content, ownership or installed-item settings.',
    );
    // An AI Credits route whose start-time setup was prepared: its route
    // blocker explains the pause, and the background service reports no
    // failure of its own.
    const credits = {
      nativeRouteBlockers: ['ai-credits' as const],
      nativeStartSetup: { prepared: true },
    };
    const creditsFailure = await pausedWith(credits);
    expect(creditsFailure).toBeUndefined();
    expect(setupLease(credits, creditsFailure)).toBe(
      'This workflow still needs the app to prepare its Agent or resources.',
    );
    // A setup the background service received with route evidence and could
    // not admit is its own failure.
    expect(
      unadmittedPipelineSetupFailure({
        nativeRouteEvidence: nativeEvidence(),
        nativeStartSetup: { prepared: true },
      }),
    ).toBe('daemon-validation');
    // Neither evidence nor an explanation from the app.
    expect(await pausedWith({})).toBe('daemon-route');
    expect(await pausedWith({ nativeRouteBlockers: [] })).toBe('daemon-route');
  });

  it('keeps uncovered requests app-settled and native cleanup available after configuration changes', async () => {
    let current = true;
    const prepared = nativePreparation(nativeEvidence(), {
      isConfigurationCurrent: () => current,
      recordPolicyRefusal: () => undefined,
    });
    if (prepared.kind !== 'native-model-answers')
      throw new Error('No authority.');
    current = false;
    const base = hostRequest('run-1', 'changed-epoch');
    const signal = new AbortController().signal;
    expect(
      await prepared.authority.answer(
        {
          ...base,
          request: { action: 'owner.model.agentAlias', agentId: 'agent' },
        },
        signal,
      ),
    ).toBeUndefined();
    expect(
      (
        await prepared.authority.answer(
          {
            ...base,
            request: {
              action: 'owner.model.release',
              routeSessionId: 'pipeline:run-1:step',
            },
          },
          signal,
        )
      )?.result,
    ).toEqual({ status: 'owner', value: { kind: 'model.release' } });
    expect(
      (
        await prepared.authority.answer(
          {
            ...base,
            request: {
              action: 'owner.model.invocation',
              harness: 'claude',
              model: 'claude-sonnet',
            },
          },
          signal,
        )
      )?.result.status,
    ).toBe('failure');
    prepared.authority.dispose();
  });

  it('synchronizes Ledger owner loss during host configuration before starting a run', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    h.launch.mockImplementationOnce(() => {
      const host = new FakeHost();
      h.hosts.push(host);
      const post = host.postMessage.bind(host);
      host.postMessage = (message): void => {
        post(message);
        if (message.request.op === 'configure') owner.stop();
      };
      return host;
    });
    const host = await startRun(h, 'run-1', true);
    expect(host.of('configure')[0]).toMatchObject({
      ledgerOwnerAvailable: true,
    });
    expect(host.of('ledgerOwnerAvailability')).toContainEqual({
      op: 'ledgerOwnerAvailability',
      available: false,
    });
    const availability = host.requests.findIndex(
      ({ request }) => request.op === 'ledgerOwnerAvailability',
    );
    const start = host.requests.findIndex(
      ({ request }) => request.op === 'start',
    );
    expect(availability).toBeLessThan(start);
    await h.supervisor.stop();
  });

  it.each(['claude', 'codex'] as const)(
    'answers exact %s invocation and routing selections without paid fallback',
    async (harness) => {
      const prepared = nativePreparation();
      if (prepared.kind !== 'native-model-answers')
        throw new Error('No authority.');
      const signal = new AbortController().signal;
      const model = harness === 'claude' ? 'sonnet' : 'gpt-codex';
      const request: WorkerPipelineHostRequest = {
        ...hostRequest('run-1', 'native'),
        request: {
          action: 'owner.model.invocation',
          harness,
          model,
          routeSessionId: 'pipeline:run-1:j:s:1',
          allowNoNativeAuthFallback: true,
        },
      };
      const answer = await prepared.authority.answer(request, signal);
      expect(answer).toEqual({
        result: {
          status: 'owner',
          value: {
            kind: 'model.invocation',
            source: `${harness}-managed`,
            harness,
            runtimeModel: harness === 'claude' ? 'sonnet' : model,
            aiCreditsRouted: false,
            modelGatewayRouted: false,
            accountProxyRouted: false,
          },
        },
      });
      expect(
        await prepared.authority.answer(
          {
            ...request,
            request: {
              action: 'owner.model.routing',
              provider: harness,
              model,
            },
          },
          signal,
        ),
      ).toEqual({
        result: {
          status: 'owner',
          value: { kind: 'model.routing', override: null },
        },
      });
      // Neither an omitted model nor a newly selected model inherits approval.
      for (const selection of [undefined, 'new-model']) {
        const refused = await prepared.authority.answer(
          {
            ...request,
            request: {
              action: 'owner.model.invocation',
              harness,
              model: selection,
            },
          },
          signal,
        );
        expect(refused?.result.status).toBe('failure');
      }
      prepared.authority.dispose();
    },
  );

  it.each(['gateway', 'accountProxy', 'aiCredits'] as const)(
    'requires positive absence of %s rather than an inconclusive lookup',
    (key) => {
      for (const value of ['required', 'unknown'] as const) {
        const proof = nativeEvidence();
        proof[key] = value;
        expect(nativePreparation(proof).kind).toBe('app-dependent');
      }
    },
  );

  it('refuses empty, foreign, dynamic, policy-dependent and non-native evidence', () => {
    for (const evidence of [null, {}, { ...nativeEvidence(), routes: [] }])
      expect(nativePreparation(evidence).kind).toBe('app-dependent');
    for (const effectiveRoute of [
      'gateway',
      'account-proxy',
      'ai-credits',
      'ollama',
      'unknown',
    ] as const) {
      const proof = nativeEvidence();
      proof.routes[0].effectiveRoute = effectiveRoute;
      expect(nativePreparation(proof).kind).toBe('app-dependent');
    }
    const unknownAuth = nativeEvidence();
    unknownAuth.routes[0].authentication = 'unknown';
    expect(nativePreparation(unknownAuth).kind).toBe('app-dependent');
    const unknownPolicy = nativeEvidence();
    unknownPolicy.policy = 'unknown';
    expect(nativePreparation(unknownPolicy)).toEqual({
      kind: 'app-dependent',
      blockers: ['policy-dependent'],
    });
    const dynamic = nativeEvidence();
    dynamic.futureSelections = 'dynamic';
    expect(nativePreparation(dynamic).kind).toBe('app-dependent');
    const duplicate = nativeEvidence();
    duplicate.routes.push({ ...duplicate.routes[0], runtimeModel: 'other' });
    expect(nativePreparation(duplicate).kind).toBe('app-dependent');
    for (const identity of [
      { ...nativeEvidence().identity, executionId: 'other' },
      { ...nativeEvidence().identity, workspaceId: 'other' },
      { ...nativeEvidence().identity, worktreeId: 'other' },
      { ...nativeEvidence().identity, owner: 'organization' },
    ]) {
      expect(nativePreparation({ ...nativeEvidence(), identity }).kind).toBe(
        'app-dependent',
      );
    }
    expect(
      prepareNativePipelineOwnerRun(
        { ...nativeEvidence().identity, owner: 'organization' },
        {
          ...nativeEvidence(),
          identity: { ...nativeEvidence().identity, owner: 'organization' },
        },
        {
          isConfigurationCurrent: () => true,
          recordPolicyRefusal: () => undefined,
        },
      ).kind,
    ).toBe('app-dependent');
  });

  it('isolates immutable launch facts, refuses stale configuration and permanently closes on disposal', async () => {
    const proof = nativeEvidence();
    let current = true;
    let readable = true;
    const prepared = nativePreparation(proof, {
      isConfigurationCurrent: () => {
        if (!readable) throw new Error('configuration unavailable');
        return current;
      },
      recordPolicyRefusal: () => undefined,
    });
    if (prepared.kind !== 'native-model-answers')
      throw new Error('No authority.');
    proof.routes[0].runtimeModel = 'replaced';
    proof.identity.owner = 'replaced';
    expect(prepared.assessment.routes[0].runtimeModel).toBe('sonnet');
    expect(prepared.assessment.identity.owner).toBe('personal');
    const request: WorkerPipelineHostRequest = {
      ...hostRequest('run-1', 'policy'),
      request: {
        action: 'owner.model.policy',
        check: 'blocked',
        modelId: 'sonnet',
      },
    };
    const signal = new AbortController().signal;
    expect((await prepared.authority.answer(request, signal))?.result).toEqual({
      status: 'owner',
      value: { kind: 'model.policy', answer: false },
    });
    expect(
      (
        await prepared.authority.answer(
          {
            ...request,
            request: {
              action: 'owner.model.policy',
              check: 'blocked',
              modelId: 'not-admitted',
            },
          },
          signal,
        )
      )?.result,
    ).toMatchObject({ status: 'failure' });
    current = false;
    expect(
      (await prepared.authority.answer(request, signal))?.result.status,
    ).toBe('failure');
    current = true;
    readable = false;
    expect(
      (await prepared.authority.answer(request, signal))?.result.status,
    ).toBe('failure');
    readable = true;
    const abort = new AbortController();
    abort.abort();
    expect(
      (await prepared.authority.answer(request, abort.signal))?.result.status,
    ).toBe('failure');
    prepared.authority.dispose();
    prepared.authority.dispose();
    expect(
      (await prepared.authority.answer(request, signal))?.result.status,
    ).toBe('failure');
  });

  it('does not inherit authority across runs, owners, children or proxy continuations', async () => {
    const prepared = nativePreparation();
    if (prepared.kind !== 'native-model-answers')
      throw new Error('No authority.');
    const request: WorkerPipelineHostRequest = {
      ...hostRequest('run-1', 'native'),
      request: {
        action: 'owner.model.invocation',
        harness: 'claude',
        model: 'claude-sonnet',
      },
    };
    for (const foreign of [
      { ...request, executionId: 'other' },
      { ...request, owner: 'other' },
      { ...request, childExecutionId: 'child' },
      {
        ...request,
        request: {
          ...request.request,
          action: 'owner.model.invocation' as const,
          harness: 'claude' as const,
          model: 'claude-sonnet',
          routeSessionId: 'pipeline:other:s',
        },
      },
      {
        ...request,
        request: {
          ...request.request,
          action: 'owner.model.invocation' as const,
          harness: 'claude' as const,
          model: 'claude-sonnet',
          requiredAccountProxyConnectionId: 'proxy',
        },
      },
    ]) {
      expect(
        (await prepared.authority.answer(foreign, new AbortController().signal))
          ?.result.status,
      ).toBe('failure');
    }
    expect(
      await prepared.authority.answer(
        hostRequest('run-1', 'host'),
        new AbortController().signal,
      ),
    ).toBeUndefined();
    prepared.authority.dispose();
  });

  it('keeps a cancelled start typed even when its prepared authority cleanup fails', async () => {
    const controller = new AbortController();
    const dispose = jest.fn(() => {
      throw new Error('cleanup failed');
    });
    const h = harness(undefined, () => {
      controller.abort();
      return Promise.resolve({
        answer: () => Promise.resolve(undefined),
        dispose,
      });
    });
    const owner = await subscribeOwner(h.channel);
    await expect(
      h.supervisor.start(
        startParams('run-1'),
        controller.signal,
        NO_EXECUTION_SECRETS,
        hostExecution(true),
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.startFailed' },
    });
    expect(h.hosts[0]?.of('start')).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(1);
    owner.stop();
    await h.supervisor.stop();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes a prepared daemon authority when its host settles the run', async () => {
    const dispose = jest.fn(() => undefined);
    const prepare = jest.fn<
      ReturnType<NonNullable<PipelineHostSupervisorOptions['prepareOwnerRun']>>,
      Parameters<NonNullable<PipelineHostSupervisorOptions['prepareOwnerRun']>>
    >(() =>
      Promise.resolve({
        answer: () => Promise.resolve(undefined),
        dispose,
      }),
    );
    const h = harness(undefined, prepare);
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toEqual(nativeEvidence().identity);
    expect(prepare.mock.calls[0]?.[1].launch.ownerBound).toBe(true);
    host.send({
      kind: 'execution',
      executionId: 'run-1',
      event: 'execution:completed',
      execution: { ...projection('run-1'), status: 'success' },
    });
    await settle();
    expect(dispose).toHaveBeenCalledTimes(1);
    owner.stop();
    await h.supervisor.stop();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
afterEach(() => {
  jest.useRealTimers();
});

// CAN-6996: a desktop quit aborts its calls without answering them. A
// survivor's request still with that app is withdrawn when its subscription
// ends, so neither the request deadline nor a reopened app settles it.
describe('survivor owner requests across app subscriptions (CAN-6996)', () => {
  const daemonInvocation = {
    status: 'owner' as const,
    value: {
      kind: 'model.invocation' as const,
      source: 'daemon',
      harness: 'claude',
      runtimeModel: 'sonnet',
      aiCreditsRouted: false,
      modelGatewayRouted: false,
      accountProxyRouted: false,
    },
  };

  function invocation(
    executionId: string,
    requestId: string,
  ): WorkerPipelineHostRequest {
    return {
      ...hostRequest(executionId, requestId),
      request: {
        action: 'owner.model.invocation',
        harness: 'claude',
        model: 'sonnet',
      },
    };
  }

  /** The ids of the requests (not withdrawals) an app subscription received. */
  function requestIds(items: readonly WorkerPipelineHostRequestsItem[]): {
    requests: string[];
  } {
    return {
      requests: items.flatMap((item) =>
        'withdrawn' in item ? [] : [item.requestId],
      ),
    };
  }

  /** run-1 survives owner loss; any other run stays app-dependent. */
  async function survivor(
    answer: PipelineOwnerRunAuthority['answer'],
    options: { readonly requestBeforeStart?: WorkerPipelineHostRequest } = {},
  ): Promise<{
    h: ReturnType<typeof harness>;
    host: FakeHost;
    owner: Awaited<ReturnType<typeof subscribeOwner>>;
  }> {
    const { h, host, owner, answerStart } = await startingSurvivor(answer);
    if (options.requestBeforeStart) {
      host.send({ kind: 'hostRequest', request: options.requestBeforeStart });
      await settle();
      expect(requestIds(owner.items).requests).toEqual([
        options.requestBeforeStart.requestId,
      ]);
      // The starting app quits before the start answers.
      owner.stop();
      await settle();
    }
    await answerStart();
    return { h, host, owner };
  }

  /** run-1's start, sent with a continuing assessment and not yet answered. */
  async function startingSurvivor(
    answer: PipelineOwnerRunAuthority['answer'],
    execution: CanopyHostExecution = hostExecution(true),
  ): Promise<{
    h: ReturnType<typeof harness>;
    host: FakeHost;
    owner: Awaited<ReturnType<typeof subscribeOwner>>;
    answerStart: () => Promise<WorkerPipelineExecution>;
  }> {
    const evidence = nativeEvidence();
    const assessment = {
      ...pausedPipelineSurvivalAssessment({
        identity: evidence.identity,
        evidence,
        blockers: [],
      }),
      disposition: 'continues' as const,
      blockers: [],
    };
    const h = harness(undefined, (identity) =>
      Promise.resolve(
        identity.executionId === 'run-1'
          ? {
              survivalAssessment: assessment,
              answer,
              dispose: (): void => undefined,
            }
          : undefined,
      ),
    );
    const owner = await subscribeOwner(h.channel);
    const starting = h.supervisor.start(
      startParams('run-1'),
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
      execution,
    );
    await settle();
    const host = h.hosts[0];
    return {
      h,
      host,
      owner,
      answerStart: async (): Promise<WorkerPipelineExecution> => {
        host.reply(startMessage(host, 'run-1').id, {
          ...projection('run-1'),
          survival: assessment,
        });
        const started = await starting;
        await settle();
        return started;
      },
    };
  }

  function startMessage(
    host: FakeHost,
    executionId: string,
  ): PipelineHostRequestMessage {
    const found = host.requests.find(
      ({ request }) =>
        request.op === 'start' &&
        request.start.params.executionId === executionId,
    );
    if (!found) throw new Error(`No start of ${executionId}.`);
    return found;
  }

  /** An owner-bound launch whose model catalog maps `claude-sonnet` to `model`. */
  function catalogLaunch(model: string): PipelineHostLaunch['launch'] {
    return {
      pipeline: { name: 'p', on: 'dispatch', jobs: {} },
      cwd: '/work/tree',
      bundledActionsDir: '/app/actions',
      env: {},
      secretEnv: {},
      ownerBound: true,
      modelCatalog: {
        MODEL_CATALOG: JSON.stringify({
          version: 1,
          claudeModels: [model],
          codexModels: [],
          modelAliases: { 'claude-sonnet': model },
        }),
        MODEL_HARNESS_ASSIGNMENTS: JSON.stringify({
          revision: 1,
          assignments: [],
        }),
      },
    };
  }

  function catalogExecution(model: string): CanopyHostExecution {
    return {
      childEnvironment: { PATH: '/usr/bin' },
      pipelineLaunch: catalogLaunch(model),
    };
  }

  async function startWith(
    h: ReturnType<typeof harness>,
    executionId: string,
    execution: CanopyHostExecution,
  ): Promise<{
    readonly answer: () => Promise<WorkerPipelineExecution>;
  }> {
    const started = h.supervisor.start(
      startParams(executionId),
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
      execution,
    );
    await settle();
    return {
      answer: async (): Promise<WorkerPipelineExecution> => {
        const host = h.hosts[h.hosts.length - 1];
        host.reply(startMessage(host, executionId).id, projection(executionId));
        return started;
      },
    };
  }

  const CATALOG_CHANGED = {
    code: 'configuration-unverified',
    explanation: 'Model settings changed after this workflow started.',
  };

  it('starts a later run with a changed model catalog and revokes survival of runs admitted under the earlier one', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve({ result: daemonInvocation }));
    const { h, host, owner, answerStart } = await startingSurvivor(
      answer,
      catalogExecution('sonnet'),
    );
    await answerStart();
    // The same catalog leaves the survivor's survival alone.
    await (await startWith(h, 'run-2', catalogExecution('sonnet'))).answer();
    expect(host.of('invalidateSurvival')).toEqual([]);

    const changed = await startWith(h, 'run-3', catalogExecution('opus'));
    // Revoked before the host applies the later catalog.
    expect(
      host.requests
        .map(({ request }) => request.op)
        .filter((op) => op === 'invalidateSurvival' || op === 'start'),
    ).toEqual(['start', 'start', 'invalidateSurvival', 'start']);
    expect(host.of('invalidateSurvival')).toEqual([
      {
        op: 'invalidateSurvival',
        executionId: 'run-1',
        blocker: CATALOG_CHANGED,
      },
    ]);
    host.reply(host.last('invalidateSurvival').id, null);
    await expect(changed.answer()).resolves.toMatchObject({
      executionId: 'run-3',
    });
    await settle();

    // The revoked run pauses with the app-dependent ones when the app quits.
    owner.stop();
    await settle();
    await jest.advanceTimersByTimeAsync(10_001);
    await settle();
    expect(host.of('pause').flatMap((request) => request.executionIds)).toEqual(
      expect.arrayContaining(['run-1', 'run-2', 'run-3']),
    );
    await h.supervisor.stop();
  });

  it('records the revocation once the host registers a survivor whose start was pending when the catalog changed', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve({ result: daemonInvocation }));
    const { h, host, owner, answerStart } = await startingSurvivor(
      answer,
      catalogExecution('sonnet'),
    );
    const changed = await startWith(h, 'run-3', catalogExecution('opus'));
    expect(host.of('invalidateSurvival')).toEqual([
      {
        op: 'invalidateSurvival',
        executionId: 'run-1',
        blocker: CATALOG_CHANGED,
      },
    ]);
    // The host is still admitting run-1: it has no live run to revoke yet.
    host.send({
      kind: 'response',
      id: host.last('invalidateSurvival').id,
      ok: false,
      error: { code: 'not_found', message: 'No live run.' },
    });
    await changed.answer();
    const started = await answerStart();
    // Once registered, the host records the pause and its reason.
    expect(host.of('invalidateSurvival')).toEqual([
      {
        op: 'invalidateSurvival',
        executionId: 'run-1',
        blocker: CATALOG_CHANGED,
      },
      {
        op: 'invalidateSurvival',
        executionId: 'run-1',
        blocker: CATALOG_CHANGED,
      },
    ]);
    expect(started.survival).toMatchObject({
      disposition: 'pauses',
      blockers: [CATALOG_CHANGED],
    });
    host.reply(host.last('invalidateSurvival').id, null);
    owner.stop();
    await settle();
    await jest.advanceTimersByTimeAsync(10_001);
    await settle();
    expect(host.of('pause').flatMap((request) => request.executionIds)).toEqual(
      expect.arrayContaining(['run-1', 'run-3']),
    );
    await h.supervisor.stop();
  });

  it('checkpoints a survivor its app already left when a reopened app starts a run with another catalog', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve({ result: daemonInvocation }));
    const { h, host, owner, answerStart } = await startingSurvivor(
      answer,
      catalogExecution('sonnet'),
    );
    await answerStart();
    owner.stop();
    await settle();
    const reopened = await subscribeOwner(h.channel);
    await settle();
    expect(host.of('pause')).toEqual([]);
    const changed = await startWith(h, 'run-3', catalogExecution('opus'));
    expect(host.of('invalidateSurvival')).toEqual([
      {
        op: 'invalidateSurvival',
        executionId: 'run-1',
        blocker: CATALOG_CHANGED,
      },
    ]);
    host.reply(host.last('invalidateSurvival').id, null);
    await settle();
    // The reopened app has no context for it, so it never receives its
    // requests: the run checkpoints with its reason instead.
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['run-1'] },
    ]);
    await expect(changed.answer()).resolves.toMatchObject({
      executionId: 'run-3',
    });
    reopened.stop();
    await h.supervisor.stop();
  });

  it('answers a detached survivor as paused, never through a reopened app, while its revocation is in flight', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve({ result: daemonInvocation }));
    const { h, host, owner, answerStart } = await startingSurvivor(
      answer,
      catalogExecution('sonnet'),
    );
    await answerStart();
    owner.stop();
    await settle();
    const reopened = await subscribeOwner(h.channel);
    await settle();
    const changed = await startWith(h, 'run-3', catalogExecution('opus'));
    expect(host.of('invalidateSurvival')).toHaveLength(1);
    // A model step raised before the host acknowledged the revocation.
    host.send({
      kind: 'hostRequest',
      request: invocation('run-1', 'during-revocation'),
    });
    await settle();
    expect(requestIds(reopened.items).requests).toEqual([]);
    expect(settledFor(host, 'during-revocation')).toEqual([]);
    host.reply(host.last('invalidateSurvival').id, null);
    await settle();
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['run-1'] },
    ]);
    // Still held: the step must not fail before its checkpoint.
    expect(settledFor(host, 'during-revocation')).toEqual([]);
    host.reply(host.last('pause').id, { pausedCount: 1 });
    await settle();
    expect(settledFor(host, 'during-revocation')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'during-revocation',
        settlement: { kind: 'unavailable' },
      },
    ]);
    expect(requestIds(reopened.items).requests).toEqual([]);
    expect(answer).not.toHaveBeenCalled();
    await changed.answer();
    reopened.stop();
    await h.supervisor.stop();
  });

  it('revokes survival of runs admitted under another model catalog when a resume applies a changed one', async () => {
    const evidence = nativeEvidence();
    const assessment = {
      ...pausedPipelineSurvivalAssessment({
        identity: evidence.identity,
        evidence,
        blockers: [],
      }),
      disposition: 'continues' as const,
      blockers: [],
    };
    // The catalog the next resolved launch carries.
    let catalog = 'sonnet';
    const hosts: FakeHost[] = [];
    const channel = createPipelineOwnerChannel();
    const supervisor = new PipelineHostSupervisor({
      launch: (): FakeHost => {
        const host = new FakeHost();
        hosts.push(host);
        return host;
      },
      configure: { dataRoot: '/data' },
      resolveLaunch: (): Promise<PipelineHostLaunch> =>
        Promise.reject(new Error('Not a host-local run.')),
      resolvePortableLaunch: (params): Promise<PipelineHostLaunch> =>
        Promise.resolve({
          params,
          launch: catalogLaunch(catalog),
          processEnvironment: {},
        }),
      idleStopMs: 600_000,
      owner: channel,
      // Continues only for run-1, the identity its assessment names.
      prepareOwnerRun: (): Promise<PipelineOwnerRunAuthority> =>
        Promise.resolve({
          survivalAssessment: assessment,
          answer: (): Promise<undefined> => Promise.resolve(undefined),
          dispose: (): void => undefined,
        }),
    });
    const owner = await subscribeOwner(channel);
    async function startPortable(executionId: string): Promise<FakeHost> {
      const starting = supervisor.start(
        {
          ...startParams(executionId),
          portableLaunch: {
            definition: {
              pin: { contentHash: 'a'.repeat(64), packageDigest: null },
              snapshot: { name: 'p', on: 'dispatch', jobs: {} },
            },
            env: {},
            delegationLease: { leaseTtlMs: 60_000 },
            ownerBound: true,
          },
        },
        new AbortController().signal,
        NO_EXECUTION_SECRETS,
      );
      await settle();
      const host = hosts[0];
      host.reply(startMessage(host, executionId).id, {
        ...projection(executionId),
        survival: assessment,
      });
      await starting;
      return host;
    }
    async function pauseAndResume(requestId: string): Promise<void> {
      host.send({
        kind: 'execution',
        executionId: 'run-2',
        event: 'execution.paused',
        execution: { ...projection('run-2'), status: 'paused' },
      });
      await settle();
      const resumed = supervisor.control(
        {
          operation: 'worker.pipeline.execution.resume',
          params: { requestId, executionId: 'run-2', initiationSource: 'user' },
        },
        new AbortController().signal,
        NO_EXECUTION_SECRETS,
      );
      await settle();
      host.reply(host.last('control').id, {
        outcome: 'started',
        execution: projection('run-2'),
      });
      await settle();
      host.reply(host.last('get').id, projection('run-2'));
      await resumed;
    }
    const host = await startPortable('run-1');
    await startPortable('run-2');

    // A resume resolved against the same catalog leaves the survivor alone.
    await pauseAndResume('resume-1');
    expect(host.of('invalidateSurvival')).toEqual([]);

    catalog = 'opus';
    await pauseAndResume('resume-2');
    // Revoked before the host applies the resumed launch's catalog.
    expect(
      host.requests
        .map(({ request }) => request.op)
        .filter((op) => op === 'invalidateSurvival' || op === 'control'),
    ).toEqual(['control', 'invalidateSurvival', 'control']);
    expect(host.of('invalidateSurvival')).toEqual([
      {
        op: 'invalidateSurvival',
        executionId: 'run-1',
        blocker: CATALOG_CHANGED,
      },
    ]);
    host.reply(host.last('invalidateSurvival').id, null);
    await settle();

    // The revoked survivor pauses with the resumed run when the app quits.
    owner.stop();
    await jest.advanceTimersByTimeAsync(10_001);
    await settle();
    expect(host.of('pause').flatMap((request) => request.executionIds)).toEqual(
      expect.arrayContaining(['run-1', 'run-2']),
    );
    await supervisor.stop();
  });

  function planRequest(requestId: string): WorkerPipelineHostRequest {
    return {
      ...hostRequest('run-1', requestId),
      request: { action: 'owner.plan.create', content: '# Plan' },
    };
  }

  function settledFor(
    host: FakeHost,
    requestId: string,
  ): Array<Extract<PipelineHostRequest, { op: 'hostSettled' }>> {
    return host
      .of('hostSettled')
      .filter((settled) => settled.requestId === requestId);
  }

  it('answers an in-flight covered request from the daemon when the app quits, and never replays it', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve({ result: daemonInvocation }));
    const { h, host, owner } = await survivor(answer);
    await startRun(h, 'run-2', true);
    const surviving = invocation('run-1', 'survivor-in-flight');
    const dependent = invocation('run-2', 'dependent-in-flight');
    host.send({ kind: 'hostRequest', request: surviving });
    host.send({ kind: 'hostRequest', request: dependent });
    await settle();
    expect(requestIds(owner.items).requests).toEqual([
      'survivor-in-flight',
      'dependent-in-flight',
    ]);
    expect(answer).not.toHaveBeenCalled();

    // The app quits: its calls are aborted, never answered.
    owner.stop();
    await settle();
    // No deadline passes before the daemon settles it.
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0]?.[0]).toEqual(surviving);
    expect(settledFor(host, 'survivor-in-flight')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'survivor-in-flight',
        settlement: { kind: 'owner', settlement: { result: daemonInvocation } },
      },
    ]);
    expect(host.of('invalidateSurvival')).toEqual([]);

    // A reopened app is never handed the survivor's request; an
    // app-dependent run keeps its replay.
    const reopened = await subscribeOwner(h.channel);
    await settle();
    expect(requestIds(reopened.items).requests).toEqual([
      'dependent-in-flight',
    ]);
    await expect(
      h.channel.handlers.instructions['worker.pipeline.hostRequest.respond'](
        {
          executionId: 'run-1',
          requestId: 'survivor-in-flight',
          result: daemonInvocation,
        },
        context,
      ),
    ).resolves.toMatchObject({ outcome: 'already_settled' });

    // The host's deadline withdrawal finds nothing left to settle.
    host.send({
      kind: 'hostRequestWithdrawn',
      executionId: 'run-1',
      requestId: 'survivor-in-flight',
    });
    await jest.advanceTimersByTimeAsync(120_001);
    await settle();
    expect(settledFor(host, 'survivor-in-flight')).toHaveLength(1);
    expect(settledFor(host, 'dependent-in-flight')).toEqual([]);
    expect(
      host.of('pause').flatMap((request) => request.executionIds),
    ).not.toContain('run-1');
    expect(answer).toHaveBeenCalledTimes(1);
    reopened.stop();
    await h.supervisor.stop();
  });

  it('checkpoints a survivor whose in-flight request the daemon cannot answer, without replaying it', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve(undefined));
    const { h, host, owner } = await survivor(answer);
    const plan: WorkerPipelineHostRequest = {
      ...hostRequest('run-1', 'plan-in-flight'),
      request: { action: 'owner.plan.create', content: '# Plan' },
    };
    host.send({ kind: 'hostRequest', request: plan });
    await settle();
    expect(requestIds(owner.items).requests).toEqual(['plan-in-flight']);

    // The app may already have written the plan: it is never sent again.
    owner.stop();
    await settle();
    const reopened = await subscribeOwner(h.channel);
    await settle();
    expect(reopened.items).toEqual([]);
    expect(host.of('invalidateSurvival')).toEqual([
      {
        op: 'invalidateSurvival',
        executionId: 'run-1',
        blocker: {
          code: 'unknown',
          explanation:
            'The app closed before a workflow request was confirmed. Reopen it to continue safely.',
        },
      },
    ]);
    host.reply(host.last('invalidateSurvival').id, null);
    await settle();
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['run-1'] },
    ]);
    host.reply(host.last('pause').id, { pausedCount: 1 });
    await settle();
    expect(settledFor(host, 'plan-in-flight')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'plan-in-flight',
        settlement: { kind: 'unavailable' },
      },
    ]);
    reopened.stop();
    await h.supervisor.stop();
  });

  it('checkpoints before failing a withdrawn request whose survival another request revoked', async () => {
    let refuse: (() => void) | undefined;
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >((request) =>
      request.request.action === 'owner.plan.create'
        ? Promise.resolve(undefined)
        : new Promise((resolve) => {
            // The disposed authority refuses once the plan revoked survival.
            refuse = (): void =>
              resolve({
                result: {
                  status: 'failure',
                  failureReason: null,
                  message: 'This model selection still needs the app.',
                  outputs: {},
                },
              });
          }),
    );
    const { h, host, owner } = await survivor(answer);
    host.send({
      kind: 'hostRequest',
      request: {
        ...hostRequest('run-1', 'plan-in-flight'),
        request: { action: 'owner.plan.create', content: '# Plan' },
      },
    });
    host.send({
      kind: 'hostRequest',
      request: invocation('run-1', 'invocation-in-flight'),
    });
    await settle();
    expect(requestIds(owner.items).requests).toEqual([
      'plan-in-flight',
      'invocation-in-flight',
    ]);
    owner.stop();
    await settle();
    expect(host.of('invalidateSurvival')).toHaveLength(1);
    refuse?.();
    await settle();
    // The step waits for its checkpoint instead of failing as unanswered.
    expect(settledFor(host, 'invocation-in-flight')).toEqual([]);
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['run-1'] },
    ]);
    host.reply(host.last('invalidateSurvival').id, null);
    await settle();
    for (const message of host.requests)
      if (message.request.op === 'pause')
        host.reply(message.id, { pausedCount: 1 });
    await settle();
    expect(host.of('invalidateSurvival')).toHaveLength(1);
    for (const message of host.requests)
      if (message.request.op === 'pause')
        host.reply(message.id, { pausedCount: 1 });
    await settle();
    expect(settledFor(host, 'invocation-in-flight')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'invocation-in-flight',
        settlement: { kind: 'unavailable' },
      },
    ]);
    expect(settledFor(host, 'plan-in-flight')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'plan-in-flight',
        settlement: { kind: 'unavailable' },
      },
    ]);
    await h.supervisor.stop();
  });

  it('holds a request a reopened app could receive while the daemon revokes its survivor', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >((request) =>
      Promise.resolve(
        request.request.action === 'owner.plan.create'
          ? undefined
          : { result: daemonInvocation },
      ),
    );
    const { h, host, owner } = await survivor(answer);
    owner.stop();
    await settle();
    const reopened = await subscribeOwner(h.channel);
    await settle();
    // The daemon cannot answer the plan, so it revokes the run's survival.
    host.send({ kind: 'hostRequest', request: planRequest('plan-after-quit') });
    await settle();
    expect(host.of('invalidateSurvival')).toHaveLength(1);
    host.send({
      kind: 'hostRequest',
      request: invocation('run-1', 'during-revocation'),
    });
    await settle();
    expect(requestIds(reopened.items).requests).toEqual([]);
    expect(answer).toHaveBeenCalledTimes(1);
    host.reply(host.last('invalidateSurvival').id, null);
    await settle();
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['run-1'] },
    ]);
    expect(settledFor(host, 'during-revocation')).toEqual([]);
    host.reply(host.last('pause').id, { pausedCount: 1 });
    await settle();
    for (const requestId of ['plan-after-quit', 'during-revocation'])
      expect(settledFor(host, requestId)).toEqual([
        {
          op: 'hostSettled',
          requestId,
          settlement: { kind: 'unavailable' },
        },
      ]);
    expect(requestIds(reopened.items).requests).toEqual([]);
    reopened.stop();
    await h.supervisor.stop();
  });

  it('withdraws an in-flight Ledger operation as no Ledger, without a checkpoint or a replay', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve(undefined));
    const { h, host, owner } = await survivor(answer);
    const write: WorkerPipelineHostRequest = {
      ...hostRequest('run-1', 'ledger-in-flight'),
      request: {
        action: 'owner.ledger.operation',
        attemptKey: 'attempt-1',
        operation: 'core.ledger.entry.add',
        params: { title: 'Entry' },
      },
    };
    host.send({ kind: 'hostRequest', request: write });
    await settle();
    expect(requestIds(owner.items).requests).toEqual(['ledger-in-flight']);
    owner.stop();
    await settle();
    const reopened = await subscribeOwner(h.channel);
    await settle();
    expect(reopened.items).toEqual([]);
    expect(settledFor(host, 'ledger-in-flight')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'ledger-in-flight',
        settlement: { kind: 'unavailable' },
      },
    ]);
    // The host hears the Ledger is gone before the settlement arrives.
    const ops = host.requests.map(({ request }) => request);
    expect(
      ops.findIndex(
        (request) =>
          request.op === 'ledgerOwnerAvailability' && !request.available,
      ),
    ).toBeLessThan(
      ops.findIndex(
        (request) =>
          request.op === 'hostSettled' &&
          request.requestId === 'ledger-in-flight',
      ),
    );
    expect(host.of('invalidateSurvival')).toEqual([]);
    expect(host.of('pause')).toEqual([]);
    reopened.stop();
    await h.supervisor.stop();
  });

  it('treats a replaced app subscription as a new app for a survivor', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve({ result: daemonInvocation }));
    const { h, host, owner } = await survivor(answer);
    host.send({
      kind: 'hostRequest',
      request: invocation('run-1', 'before-replace'),
    });
    await settle();
    expect(requestIds(owner.items).requests).toEqual(['before-replace']);
    // A new subscription replaces the old before the old one is seen to end.
    const replacement = await subscribeOwner(h.channel);
    await settle();
    expect(replacement.items).toEqual([]);
    expect(settledFor(host, 'before-replace')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'before-replace',
        settlement: { kind: 'owner', settlement: { result: daemonInvocation } },
      },
    ]);
    host.send({
      kind: 'hostRequest',
      request: invocation('run-1', 'after-replace'),
    });
    await settle();
    expect(replacement.items).toEqual([]);
    expect(answer).toHaveBeenCalledTimes(2);
    expect(settledFor(host, 'after-replace')).toHaveLength(1);
    replacement.stop();
    await h.supervisor.stop();
  });

  it('ends the Ledger epoch when another app subscription replaces the one holding Ledger calls', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve(undefined));
    const { h, host, owner } = await survivor(answer);
    await startRun(h, 'run-2', true);
    const ledgerWrite = (
      executionId: string,
      requestId: string,
    ): WorkerPipelineHostRequest => ({
      ...hostRequest(executionId, requestId),
      request: {
        action: 'owner.ledger.operation',
        attemptKey: `attempt-${executionId}`,
        operation: 'core.ledger.entry.add',
        params: { title: 'Entry' },
      },
    });
    host.send({
      kind: 'hostRequest',
      request: ledgerWrite('run-1', 'survivor-ledger'),
    });
    host.send({
      kind: 'hostRequest',
      request: ledgerWrite('run-2', 'dependent-ledger'),
    });
    await settle();
    expect(requestIds(owner.items).requests).toEqual([
      'survivor-ledger',
      'dependent-ledger',
    ]);
    const before = host.requests.length;

    const replacement = await subscribeOwner(h.channel);
    await settle();
    const ops = host.requests.slice(before).map(({ request }) => request);
    const ended = ops.findIndex(
      (request) =>
        request.op === 'ledgerOwnerAvailability' && !request.available,
    );
    expect(ended).toBeGreaterThanOrEqual(0);
    // The host ends its epoch before any withdrawn call settles, then opens
    // a fresh one for the replacing app.
    expect(ended).toBeLessThan(
      ops.findIndex(
        (request) =>
          request.op === 'hostSettled' &&
          request.requestId === 'survivor-ledger',
      ),
    );
    expect(
      ops.findIndex(
        (request, index) =>
          index > ended &&
          request.op === 'ledgerOwnerAvailability' &&
          request.available,
      ),
    ).toBeGreaterThan(ended);
    // The old app may have written either entry: neither is sent again.
    expect(requestIds(replacement.items).requests).toEqual([]);
    expect(settledFor(host, 'survivor-ledger')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'survivor-ledger',
        settlement: { kind: 'unavailable' },
      },
    ]);
    expect(host.of('invalidateSurvival')).toEqual([]);
    expect(host.of('pause')).toEqual([]);
    replacement.stop();
    await h.supervisor.stop();
  });

  it('withdraws a request raised before the start answered once the run survives a departed app', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve({ result: daemonInvocation }));
    const early = invocation('run-1', 'before-start-answer');
    const { h, host } = await survivor(answer, { requestBeforeStart: early });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(settledFor(host, 'before-start-answer')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'before-start-answer',
        settlement: { kind: 'owner', settlement: { result: daemonInvocation } },
      },
    ]);
    const reopened = await subscribeOwner(h.channel);
    await settle();
    expect(reopened.items).toEqual([]);
    reopened.stop();
    await h.supervisor.stop();
  });

  it('never hands a reopened app a request raised before the start answered', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve({ result: daemonInvocation }));
    const { h, host, owner, answerStart } = await startingSurvivor(answer);
    host.send({
      kind: 'hostRequest',
      request: invocation('run-1', 'before-start-answer'),
    });
    await settle();
    expect(requestIds(owner.items).requests).toEqual(['before-start-answer']);
    // The app quits and reopens while the start is still pending.
    owner.stop();
    await settle();
    const reopened = await subscribeOwner(h.channel);
    await settle();
    await answerStart();
    expect(requestIds(reopened.items).requests).toEqual([]);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(settledFor(host, 'before-start-answer')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'before-start-answer',
        settlement: { kind: 'owner', settlement: { result: daemonInvocation } },
      },
    ]);
    // Detached: a later request stays with the daemon, not the reopened app.
    host.send({
      kind: 'hostRequest',
      request: invocation('run-1', 'after-start-answer'),
    });
    await settle();
    expect(requestIds(reopened.items).requests).toEqual([]);
    expect(settledFor(host, 'after-start-answer')).toHaveLength(1);
    reopened.stop();
    await h.supervisor.stop();
  });

  it('revokes survival for an uncertain request in flight when the app quits before the start answers', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve(undefined));
    const { h, host, owner, answerStart } = await startingSurvivor(answer);
    host.send({ kind: 'hostRequest', request: planRequest('plan-early') });
    await settle();
    owner.stop();
    await settle();
    const reopened = await subscribeOwner(h.channel);
    await settle();
    expect(requestIds(reopened.items).requests).toEqual([]);
    expect(host.of('invalidateSurvival')).toHaveLength(1);
    host.reply(host.last('invalidateSurvival').id, null);
    await settle();
    // The host already runs it, so it pauses before its start answers.
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['run-1'] },
    ]);
    await answerStart();
    host.reply(host.last('pause').id, { pausedCount: 1 });
    await settle();
    expect(settledFor(host, 'plan-early')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'plan-early',
        settlement: { kind: 'unavailable' },
      },
    ]);
    // Its start answer no longer makes it a survivor: the next quit pauses it.
    reopened.stop();
    await settle();
    await jest.advanceTimersByTimeAsync(10_001);
    await settle();
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['run-1'] },
      { op: 'pause', executionIds: ['run-1'] },
    ]);
    await h.supervisor.stop();
  });

  it('checkpoints an uncovered request raised after the app quit, before the start answers', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve(undefined));
    const { h, host, owner, answerStart } = await startingSurvivor(answer);
    owner.stop();
    await settle();
    host.send({ kind: 'hostRequest', request: planRequest('plan-after-quit') });
    await settle();
    expect(host.of('invalidateSurvival')).toHaveLength(1);
    host.reply(host.last('invalidateSurvival').id, null);
    await settle();
    // The step waits for its checkpoint instead of failing as unanswered.
    expect(settledFor(host, 'plan-after-quit')).toEqual([]);
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['run-1'] },
    ]);
    await answerStart();
    host.reply(host.last('pause').id, { pausedCount: 1 });
    await settle();
    expect(settledFor(host, 'plan-after-quit')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'plan-after-quit',
        settlement: { kind: 'unavailable' },
      },
    ]);
    await h.supervisor.stop();
  });

  it('answers a survivor request from the daemon when another request finds the app transport closed', async () => {
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve({ result: daemonInvocation }));
    const { h, host, owner } = await survivor(answer);
    await startRun(h, 'run-2', true);
    // The app's transport closed; the daemon learns it on the next emit.
    owner.close();
    host.sendTogether(
      { kind: 'hostRequest', request: invocation('run-2', 'dependent') },
      { kind: 'hostRequest', request: invocation('run-1', 'survivor') },
    );
    await settle();
    expect(host.of('invalidateSurvival')).toEqual([]);
    expect(settledFor(host, 'survivor')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'survivor',
        settlement: { kind: 'owner', settlement: { result: daemonInvocation } },
      },
    ]);
    // The app-dependent request waits for the returning app.
    expect(settledFor(host, 'dependent')).toEqual([]);
    const reopened = await subscribeOwner(h.channel);
    await settle();
    expect(requestIds(reopened.items).requests).toEqual(['dependent']);
    reopened.stop();
    owner.stop();
    await h.supervisor.stop();
  });
});

describe('pipeline host supervisor owner channel (CAN-5771)', () => {
  it.each(['declines', 'fails', 'throws'] as const)(
    'keeps connected model invocation with the app when the launch authority %s',
    async (outcome) => {
      const evidence = nativeEvidence();
      const assessment = {
        ...pausedPipelineSurvivalAssessment({
          identity: evidence.identity,
          evidence,
          blockers: [],
        }),
        disposition: 'continues' as const,
        blockers: [],
        coveredOwnerKinds: ['model.invocation'],
      };
      const answer = jest.fn<
        ReturnType<PipelineOwnerRunAuthority['answer']>,
        Parameters<PipelineOwnerRunAuthority['answer']>
      >(() => {
        if (outcome === 'throws')
          return Promise.reject(new Error('stale launch authority'));
        if (outcome === 'fails')
          return Promise.resolve({
            result: {
              status: 'failure',
              failureReason: 'owner_context_unavailable',
              message: 'stale setup',
              outputs: {},
            },
          });
        return Promise.resolve(undefined);
      });
      const h = harness(
        undefined,
        (): Promise<PipelineOwnerRunAuthority> =>
          Promise.resolve({
            survivalAssessment: assessment,
            answer,
            dispose: (): void => undefined,
          }),
      );
      const owner = await subscribeOwner(h.channel);
      const starting = h.supervisor.start(
        startParams('run-1'),
        new AbortController().signal,
        NO_EXECUTION_SECRETS,
        hostExecution(true),
      );
      await settle();
      const host = h.hosts[0];
      host.reply(host.last('start').id, {
        ...projection('run-1'),
        survival: assessment,
      });
      await starting;
      const request: WorkerPipelineHostRequest = {
        ...hostRequest('run-1', 'connected-invocation'),
        request: {
          action: 'owner.model.invocation',
          harness: 'claude',
          model: 'sonnet',
        },
      };
      host.send({ kind: 'hostRequest', request });
      await settle();
      expect(owner.items).toEqual([request]);
      const result = {
        status: 'owner' as const,
        value: {
          kind: 'model.invocation' as const,
          source: 'connected-app',
          harness: 'claude',
          runtimeModel: 'sonnet',
          aiCreditsRouted: false,
          modelGatewayRouted: false,
          accountProxyRouted: false,
        },
      };
      await h.channel.handlers.instructions[
        'worker.pipeline.hostRequest.respond'
      ](
        { executionId: 'run-1', requestId: request.requestId, result },
        context,
      );
      await settle();
      expect(host.of('hostSettled')).toEqual([
        {
          op: 'hostSettled',
          requestId: request.requestId,
          settlement: { kind: 'owner', settlement: { result } },
        },
      ]);
      expect(answer).not.toHaveBeenCalled();
      expect(host.of('pause')).toEqual([]);
      expect(host.of('invalidateSurvival')).toEqual([]);
      owner.stop();
      await h.supervisor.stop();
    },
  );

  it('keeps a detached survivor daemon-owned when a different app subscribes', async () => {
    const evidence = nativeEvidence();
    const assessment = {
      ...pausedPipelineSurvivalAssessment({
        identity: evidence.identity,
        evidence,
        blockers: [],
      }),
      disposition: 'continues' as const,
      blockers: [],
    };
    const result = {
      status: 'owner' as const,
      value: {
        kind: 'model.invocation' as const,
        source: 'daemon',
        harness: 'claude',
        runtimeModel: 'sonnet',
        aiCreditsRouted: false,
        modelGatewayRouted: false,
        accountProxyRouted: false,
      },
    };
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve({ result }));
    const dispose = jest.fn();
    const h = harness(undefined, (identity) =>
      Promise.resolve(
        identity.executionId === assessment.identity.executionId
          ? { survivalAssessment: assessment, answer, dispose }
          : undefined,
      ),
    );
    const firstOwner = await subscribeOwner(h.channel);
    const starting = h.supervisor.start(
      startParams('run-1'),
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
      hostExecution(true),
    );
    await settle();
    const host = h.hosts[0];
    host.reply(host.last('start').id, {
      ...projection('run-1'),
      survival: assessment,
    });
    await starting;
    firstOwner.stop();
    await settle();
    const newOwner = await subscribeOwner(h.channel);
    await settle();
    expect(dispose).not.toHaveBeenCalled();
    expect(host.of('invalidateSurvival')).toEqual([]);
    const request: WorkerPipelineHostRequest = {
      ...hostRequest('run-1', 'after-reconnect'),
      request: {
        action: 'owner.model.invocation',
        harness: 'claude',
        model: 'sonnet',
      },
    };
    host.send({ kind: 'hostRequest', request });
    await settle();
    expect(answer).toHaveBeenCalledTimes(1);
    expect(newOwner.items).toEqual([]);
    expect(host.of('hostSettled')).toContainEqual({
      op: 'hostSettled',
      requestId: request.requestId,
      settlement: { kind: 'owner', settlement: { result } },
    });
    await startRun(h, 'run-2', true);
    const connectedRequest: WorkerPipelineHostRequest = {
      ...request,
      executionId: 'run-2',
      requestId: 'connected-run',
    };
    host.send({ kind: 'hostRequest', request: connectedRequest });
    await settle();
    expect(newOwner.items).toEqual([connectedRequest]);
    expect(answer).toHaveBeenCalledTimes(1);
    newOwner.stop();
    await jest.advanceTimersByTimeAsync(10_001);
    await settle();
    const paused = host.of('pause').flatMap((request) => request.executionIds);
    expect(paused).not.toContain('run-1');
    expect(paused).toContain('run-2');
    await h.supervisor.stop();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps a survivor daemon-owned when its app is replaced before the start answers', async () => {
    const evidence = nativeEvidence();
    const assessment = {
      ...pausedPipelineSurvivalAssessment({
        identity: evidence.identity,
        evidence,
        blockers: [],
      }),
      disposition: 'continues' as const,
      blockers: [],
    };
    const result = {
      status: 'owner' as const,
      value: { kind: 'model.release' as const },
    };
    const answer = jest.fn<
      ReturnType<PipelineOwnerRunAuthority['answer']>,
      Parameters<PipelineOwnerRunAuthority['answer']>
    >(() => Promise.resolve({ result }));
    const h = harness(undefined, () =>
      Promise.resolve({
        survivalAssessment: assessment,
        answer,
        dispose: () => undefined,
      }),
    );
    const firstOwner = await subscribeOwner(h.channel);
    const starting = h.supervisor.start(
      startParams('run-1'),
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
      hostExecution(true),
    );
    await settle();
    const host = h.hosts[0];
    // The starting app quits and a reopened one subscribes before the answer.
    firstOwner.stop();
    await settle();
    const reopened = await subscribeOwner(h.channel);
    host.reply(host.last('start').id, {
      ...projection('run-1'),
      survival: assessment,
    });
    await starting;
    const request: WorkerPipelineHostRequest = {
      ...hostRequest('run-1', 'release-after-replace'),
      request: {
        action: 'owner.model.release',
        routeSessionId: 'route-session-1',
      },
    };
    host.send({ kind: 'hostRequest', request });
    await settle();
    expect(reopened.items).toEqual([]);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(host.of('hostSettled')).toContainEqual({
      op: 'hostSettled',
      requestId: request.requestId,
      settlement: { kind: 'owner', settlement: { result } },
    });
    await h.supervisor.stop();
  });

  it('pauses a survivor at owner loss once a pause released it and a resume ran it again', async () => {
    const evidence = nativeEvidence();
    const assessment = {
      ...pausedPipelineSurvivalAssessment({
        identity: evidence.identity,
        evidence,
        blockers: [],
      }),
      disposition: 'continues' as const,
      blockers: [],
    };
    const dispose = jest.fn();
    const prepareOwnerRun = jest.fn<
      ReturnType<NonNullable<PipelineHostSupervisorOptions['prepareOwnerRun']>>,
      Parameters<NonNullable<PipelineHostSupervisorOptions['prepareOwnerRun']>>
    >(() =>
      Promise.resolve({
        survivalAssessment: assessment,
        answer: (): Promise<undefined> => Promise.resolve(undefined),
        dispose,
      }),
    );
    const hosts: FakeHost[] = [];
    const channel = createPipelineOwnerChannel();
    const supervisor = new PipelineHostSupervisor({
      launch: (): FakeHost => {
        const host = new FakeHost();
        hosts.push(host);
        return host;
      },
      configure: { dataRoot: '/data' },
      resolveLaunch: (): Promise<PipelineHostLaunch> =>
        Promise.reject(new Error('Not a host-local run.')),
      resolvePortableLaunch: (params): Promise<PipelineHostLaunch> =>
        Promise.resolve({
          params,
          launch: {
            pipeline: { name: 'p', on: 'dispatch', jobs: {} },
            cwd: '/work/tree',
            bundledActionsDir: '/app/actions',
            env: {},
            secretEnv: {},
            ownerBound: true,
          },
          processEnvironment: {},
        }),
      idleStopMs: 600_000,
      owner: channel,
      prepareOwnerRun,
    });
    const owner = await subscribeOwner(channel);
    const starting = supervisor.start(
      {
        ...startParams('run-1'),
        portableLaunch: {
          definition: {
            pin: { contentHash: 'a'.repeat(64), packageDigest: null },
            snapshot: { name: 'p', on: 'dispatch', jobs: {} },
          },
          env: {},
          delegationLease: { leaseTtlMs: 60_000 },
          ownerBound: true,
        },
      },
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
    );
    await settle();
    const host = hosts[0];
    host.reply(host.last('start').id, {
      ...projection('run-1'),
      survival: assessment,
    });
    await starting;
    // A settled pause releases the run's daemon authority.
    host.send({
      kind: 'execution',
      executionId: 'run-1',
      event: 'execution.paused',
      execution: { ...projection('run-1'), status: 'paused' },
    });
    await settle();
    expect(dispose).toHaveBeenCalledTimes(1);
    const resumed = supervisor.control(
      {
        operation: 'worker.pipeline.execution.resume',
        params: {
          requestId: 'resume-1',
          executionId: 'run-1',
          initiationSource: 'user',
        },
      },
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
    );
    await settle();
    host.reply(host.last('control').id, {
      outcome: 'started',
      execution: projection('run-1'),
    });
    await settle();
    host.reply(host.last('get').id, projection('run-1'));
    await resumed;
    // Resume never re-admits: the executor records `pauses` (rollover golden)
    // and the supervisor pauses the run with its owner.
    expect(prepareOwnerRun).toHaveBeenCalledTimes(1);
    owner.stop();
    await jest.advanceTimersByTimeAsync(10_001);
    await settle();
    expect(host.of('pause').flatMap((request) => request.executionIds)).toEqual(
      ['run-1'],
    );
    await supervisor.stop();
  });

  it.each([
    { acknowledged: true, foreign: false, continues: true },
    { acknowledged: false, foreign: false, continues: false },
    { acknowledged: true, foreign: true, continues: false },
  ])(
    'exempts only a run-scoped readiness acknowledged by execution authority: %j',
    async ({ acknowledged, foreign, continues }) => {
      const evidence = nativeEvidence();
      const assessment = {
        ...pausedPipelineSurvivalAssessment({
          identity: evidence.identity,
          evidence,
          blockers: [],
        }),
        identity: {
          ...evidence.identity,
          executionId: foreign ? 'other-run' : 'run-1',
        },
        disposition: 'continues' as const,
        blockers: [],
        coveredOwnerKinds: [
          'model.invocation',
          'model.routing',
          'model.policy',
        ],
      };
      const dispose = jest.fn();
      const h = harness(
        undefined,
        (): Promise<PipelineOwnerRunAuthority> =>
          Promise.resolve({
            survivalAssessment: assessment,
            answer: (): Promise<undefined> => Promise.resolve(undefined),
            dispose,
          }),
      );
      const owner = await subscribeOwner(h.channel);
      const starting = h.supervisor.start(
        startParams('run-1'),
        new AbortController().signal,
        NO_EXECUTION_SECRETS,
        hostExecution(true),
      );
      await settle();
      const host = h.hosts[0];
      expect(host.of('start')[0]?.start.launch.ownerBound).toBe(true);
      expect(host.of('start')[0]?.start.survivalAssessment).toEqual(
        foreign ? undefined : assessment,
      );
      host.reply(host.last('start').id, {
        ...projection('run-1'),
        ...(acknowledged && { survival: assessment }),
      });
      await starting;
      // Another owner-bound run must still pause, even in the same host.
      await startRun(h, 'run-2', true);
      owner.stop();
      await jest.advanceTimersByTimeAsync(10_001);
      await settle();
      const paused = host
        .of('pause')
        .flatMap((request) => request.executionIds);
      expect(paused.includes('run-1')).toBe(!continues);
      expect(paused).toContain('run-2');
      expect(h.channel.ownerSubscribed()).toBe(false);
      expect(dispose).not.toHaveBeenCalled();
      host.send({
        kind: 'execution',
        executionId: 'run-1',
        event: 'execution:completed',
        execution: { ...projection('run-1'), status: 'success' },
      });
      await settle();
      expect(dispose).toHaveBeenCalledTimes(1);
      await h.supervisor.stop();
    },
  );

  it('answers a covered local owner request without pretending the owner is subscribed', async () => {
    const answer = jest.fn<ReturnType<OwnerAnswer>, Parameters<OwnerAnswer>>(
      () =>
        Promise.resolve({
          result: {
            status: 'owner',
            value: { kind: 'ledger.open', attempt: null },
          },
        }),
    );
    const h = harness(answer);
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    const request: WorkerPipelineHostRequest = {
      ...hostRequest('run-1', 'local-1'),
      request: {
        action: 'owner.ledger.open',
        physicalJobId: 'j',
        logicalJobId: 'j',
        jobName: 'j',
        stepId: 's',
        stepName: 's',
        attempt: 1,
        iteration: 0,
        harness: 'claude',
        permissionPreset: 'none',
      },
    };
    owner.stop();
    host.send({ kind: 'hostRequest', request });
    await settle();
    expect(h.channel.ownerSubscribed()).toBe(false);
    expect(answer.mock.calls[0]?.[1]).toEqual({
      executionId: 'run-1',
      owner: 'personal',
      runScope: 'worktree',
      workspaceId: 'workspace',
      worktreeId: 'worktree',
    });
    expect(host.of('ledgerOwnerAvailability')).toContainEqual({
      op: 'ledgerOwnerAvailability',
      available: false,
    });
    expect(owner.items).toEqual([]);
    expect(host.of('hostSettled')).toContainEqual({
      op: 'hostSettled',
      requestId: 'local-1',
      settlement: {
        kind: 'owner',
        settlement: {
          result: {
            status: 'owner',
            value: { kind: 'ledger.open', attempt: null },
          },
        },
      },
    });
    // Answering requests is not survival eligibility: the safe pause remains.
    jest.advanceTimersByTime(10_000);
    await settle();
    expect(host.of('pause')).toContainEqual({
      op: 'pause',
      executionIds: ['run-1'],
    });
    await h.supervisor.stop();
  });
  it('relays a host request to the owner and its settlement and host-local values back', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    const request = hostRequest('run-1', 'request-1');
    host.send({ kind: 'hostRequest', request });
    await settle();
    expect(owner.items).toEqual([request]);
    const values: WorkerPipelineHostStepValues = {
      pathOutputs: { path: '/work/new-tree' },
      timeout: 'none',
    };
    await h.channel.handlers.instructions[
      'worker.pipeline.hostRequest.respond'
    ](
      {
        executionId: 'run-1',
        requestId: 'request-1',
        result: { status: 'success', outputs: { branch: 'b' } },
      },
      {
        ...context,
        execution: { childEnvironment: {}, pipelineHostStep: values },
      },
    );
    await settle();
    expect(host.of('hostSettled')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'request-1',
        settlement: {
          kind: 'settled',
          result: { status: 'success', outputs: { branch: 'b' } },
          values,
        },
      },
    ]);
    owner.stop();
    await h.supervisor.stop();
  });

  it('leaves uncovered requests with the app but never falls back after a selected daemon authority fails', async () => {
    const answer = jest
      .fn<ReturnType<OwnerAnswer>, Parameters<OwnerAnswer>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('authority unavailable'))
      .mockResolvedValueOnce({
        result: {
          status: 'owner',
          value: { kind: 'model.policy', answer: false },
        },
      });
    const h = harness(answer);
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    const base: WorkerPipelineHostRequest = {
      ...hostRequest('run-1', 'uncovered'),
      request: {
        action: 'owner.ledger.close',
        attemptKey: 'attempt-1',
        outcome: { kind: 'settled' },
      },
    };
    host.send({ kind: 'hostRequest', request: base });
    host.send({
      kind: 'hostRequest',
      request: hostRequest('run-1', 'host-step'),
    });
    await settle();
    expect(owner.items).toEqual([base, hostRequest('run-1', 'host-step')]);
    // Connected app authority stays current; start snapshots are used only
    // after loss. Still exercise all three daemon failure/isolation cases.
    expect(answer).not.toHaveBeenCalled();
    owner.stop();
    host.send({
      kind: 'hostRequest',
      request: { ...base, requestId: 'uncovered-daemon' },
    });
    host.send({
      kind: 'hostRequest',
      request: { ...base, requestId: 'failed' },
    });
    host.send({
      kind: 'hostRequest',
      request: { ...base, requestId: 'wrong-kind' },
    });
    host.send({
      kind: 'hostRequest',
      request: { ...base, requestId: 'foreign', executionId: 'foreign' },
    });
    await settle();
    expect(answer).toHaveBeenCalledTimes(3);
    expect(
      owner.items.map((item) => ('requestId' in item ? item.requestId : null)),
    ).toEqual(['uncovered', 'host-step']);
    expect(host.of('hostSettled')).toContainEqual({
      op: 'hostSettled',
      requestId: 'failed',
      settlement: { kind: 'unavailable' },
    });
    const wrong = host
      .of('hostSettled')
      .find((value) => value.requestId === 'wrong-kind');
    expect(wrong?.settlement.kind).toBe('owner');
    if (wrong?.settlement.kind !== 'owner') throw new Error('No answer.');
    expect(wrong.settlement.settlement.result.status).toBe('failure');
    owner.stop();
    await h.supervisor.stop();
  });

  // CAN-6868: a cloud runner's host runs a run's child workflows in the
  // run's executor; their host requests are the run's.
  it("relays a child workflow's host request once its host reported the child, and no other execution's", async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    // Before the host reports it, the child is no run this host holds.
    host.send({
      kind: 'hostRequest',
      request: hostRequest('child-1', 'early'),
    });
    await settle();
    expect(owner.items).toEqual([]);
    host.send({
      kind: 'child',
      executionId: 'run-1',
      event: 'execution.started',
      execution: { ...projection('child-1'), parentExecutionId: 'run-1' },
    });
    const request = hostRequest('child-1', 'request-1');
    host.send({ kind: 'hostRequest', request });
    host.send({
      kind: 'hostRequest',
      request: hostRequest('stranger', 'request-2'),
    });
    await settle();
    expect(owner.items).toEqual([request]);
    owner.stop();
    await h.supervisor.stop();
  });

  it('a second answer for an applied request is a no-op (CAN-6171)', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    host.send({
      kind: 'hostRequest',
      request: hostRequest('run-1', 'request-1'),
    });
    await settle();
    const respond =
      h.channel.handlers.instructions['worker.pipeline.hostRequest.respond'];
    const answer = (
      branch: string,
      path: string,
    ): Parameters<typeof respond> => [
      {
        executionId: 'run-1',
        requestId: 'request-1',
        result: { status: 'success', outputs: { branch } },
      },
      {
        ...context,
        execution: {
          childEnvironment: {},
          pipelineHostStep: { pathOutputs: { path }, timeout: 'none' },
        },
      },
    ];
    await expect(
      respond(...answer('first', '/work/first')),
    ).resolves.toMatchObject({
      outcome: 'applied',
    });
    // A later answer, from any owner session, changes nothing.
    await expect(
      respond(...answer('second', '/work/second')),
    ).resolves.toMatchObject({
      outcome: 'already_settled',
    });
    await settle();
    expect(host.of('hostSettled')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'request-1',
        settlement: {
          kind: 'settled',
          result: { status: 'success', outputs: { branch: 'first' } },
          values: { pathOutputs: { path: '/work/first' }, timeout: 'none' },
        },
      },
    ]);
    owner.stop();
    await h.supervisor.stop();
  });

  it('relays a model step owner request and its owner values back (CAN-5095)', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    const request: WorkerPipelineHostRequest = {
      ...hostRequest('run-1', 'owner:run-1:1'),
      request: { action: 'owner.model.policy', check: 'active' },
    };
    host.send({ kind: 'hostRequest', request });
    await settle();
    expect(owner.items).toEqual([request]);
    await h.channel.handlers.instructions[
      'worker.pipeline.hostRequest.respond'
    ](
      {
        executionId: 'run-1',
        requestId: 'owner:run-1:1',
        result: {
          status: 'owner',
          value: { kind: 'model.policy', answer: true },
        },
      },
      {
        ...context,
        execution: {
          childEnvironment: {},
          pipelineOwnerValues: {
            requestId: 'owner:run-1:1',
            env: { ROUTE: 'host-local' },
          },
        },
      },
    );
    await settle();
    expect(host.of('hostSettled')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'owner:run-1:1',
        settlement: {
          kind: 'owner',
          settlement: {
            result: {
              status: 'owner',
              value: { kind: 'model.policy', answer: true },
            },
            values: {
              requestId: 'owner:run-1:1',
              env: { ROUTE: 'host-local' },
            },
          },
        },
      },
    ]);
    owner.stop();
    await h.supervisor.stop();
  });

  it('holds a host request up to 10 s for an owner, then answers unavailable', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    owner.stop();
    host.send({
      kind: 'hostRequest',
      request: hostRequest('run-1', 'request-1'),
    });
    await settle();
    jest.advanceTimersByTime(9_999);
    await settle();
    expect(host.of('hostSettled')).toEqual([]);
    jest.advanceTimersByTime(1);
    await settle();
    expect(host.of('hostSettled')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'request-1',
        settlement: { kind: 'unavailable' },
      },
    ]);

    host.send({
      kind: 'hostRequest',
      request: hostRequest('run-1', 'request-2'),
    });
    await settle();
    jest.advanceTimersByTime(5_000);
    const late = await subscribeOwner(h.channel);
    await settle();
    expect(
      late.items.map((item) => ('withdrawn' in item ? null : item.requestId)),
    ).toEqual(['request-2']);
    late.stop();
    await h.supervisor.stop();
  });

  it('a withdrawal from the host withdraws the request and announces it', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    host.send({
      kind: 'hostRequest',
      request: hostRequest('run-1', 'request-1'),
    });
    await settle();
    host.send({
      kind: 'hostRequestWithdrawn',
      executionId: 'run-1',
      requestId: 'request-1',
    });
    await settle();
    expect(owner.items[1]).toEqual({
      withdrawn: true,
      executionId: 'run-1',
      requestId: 'request-1',
    });
    await expect(
      h.channel.handlers.instructions['worker.pipeline.hostRequest.respond'](
        {
          executionId: 'run-1',
          requestId: 'request-1',
          result: { status: 'success', outputs: {} },
        },
        context,
      ),
    ).resolves.toMatchObject({ outcome: 'already_settled' });
    expect(host.of('hostSettled')).toEqual([]);
    owner.stop();
    await h.supervisor.stop();
  });

  it('pauses owner-bound executions 10 s after the owner goes, and a returning owner cancels it', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'bound', true);
    await startRun(h, 'free', false);
    owner.stop();
    jest.advanceTimersByTime(9_000);
    const back = await subscribeOwner(h.channel);
    jest.advanceTimersByTime(5_000);
    await settle();
    expect(host.of('pause')).toEqual([]);

    back.stop();
    jest.advanceTimersByTime(10_000);
    await settle();
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['bound'] },
    ]);
    host.reply(host.last('pause').id, { pausedCount: 1 });
    await settle();
    await h.supervisor.stop();
  });

  it('relays a host request that arrives with its start response', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const result = h.supervisor.start(
      startParams('run-1'),
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
      hostExecution(true),
    );
    await settle();
    const host = h.hosts[0];
    const request = hostRequest('run-1', 'request-1');
    host.sendTogether(
      {
        kind: 'response',
        id: host.last('start').id,
        ok: true,
        value: projection('run-1'),
      },
      { kind: 'hostRequest', request },
    );
    await result;
    await settle();
    expect(owner.items).toEqual([request]);
    owner.stop();
    await h.supervisor.stop();
  });

  it('pauses an owner-bound run whose start finished after the owner had gone', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const result = h.supervisor.start(
      startParams('run-1'),
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
      hostExecution(true),
    );
    await settle();
    const host = h.hosts[0];
    owner.stop();
    jest.advanceTimersByTime(10_000);
    await settle();
    host.reply(host.last('start').id, projection('run-1'));
    await result;
    await settle();
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['run-1'] },
    ]);
    host.reply(host.last('pause').id, { pausedCount: 1 });
    await settle();
    await h.supervisor.stop();
  });

  it('refuses an owner-bound start while no owner is subscribed', async () => {
    const h = harness();
    await expect(
      h.supervisor.start(
        startParams('run-1'),
        new AbortController().signal,
        NO_EXECUTION_SECRETS,
        hostExecution(true),
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.ownerUnavailable' },
    });
    expect(h.launch).not.toHaveBeenCalled();
    await h.supervisor.stop();
  });
});

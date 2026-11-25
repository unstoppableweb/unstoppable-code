import type {
  WorkerAgentProvider,
  WorkerAgentProviderId,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../../../runtime/errors';
import type { CanopyHandlerContext } from '../../../../runtime/types';
import {
  createWorkerAgentProviderHandlers,
  createWorkerAgentUsageLimitsHandlers,
  type WorkerAgentProviderHandlers,
  type WorkerAgentProviderHost,
} from '..';

const context: CanopyHandlerContext = {
  requestId: 'request',
  caller: {
    principalId: 'core',
    clientInstanceId: 'test',
    authorityId: 'local-desktop',
    interfaceKind: 'daemon',
    grants: ['worker.agent.read'],
  },
  metadata: {},
  signal: new AbortController().signal,
};

it('usage reads distinguish an absent host from a failed source without exposing raw errors', async () => {
  await expect(
    createWorkerAgentUsageLimitsHandlers().queries[
      'worker.agent.usageLimits.get'
    ]({ scope: {} }, context),
  ).rejects.toMatchObject({
    payload: { kind: 'capability_unavailable', retry: { kind: 'never' } },
  });
  const get = jest.fn((): never => {
    throw new Error('raw credential path /private/identity');
  });
  const handler = createWorkerAgentUsageLimitsHandlers({
    authorityId: 'local-desktop',
    targetId: 'in_process_worker',
    get,
  }).queries['worker.agent.usageLimits.get'];
  await expect(handler({ scope: {} }, context)).rejects.toMatchObject({
    payload: {
      kind: 'internal',
      message: 'Cached provider usage could not be read.',
      retry: { kind: 'never' },
    },
  });
});

function provider(
  providerId: WorkerAgentProviderId,
  modelIds: readonly string[] = [],
): WorkerAgentProvider {
  return {
    providerId,
    name: providerId,
    authState: 'ready',
    checkedAt: '2026-11-05T12:00:00.000Z',
    models: modelIds.map((modelId) => ({
      modelId,
      name: modelId,
      contextWindow: null,
      outputLimit: null,
      billingSources: ['provider_account'],
      gatewayOrigin: null,
      thinkingLevels: null,
      blockedByOrganization: false,
    })),
    usageLimit: null,
  };
}

function fakeHost(
  list: WorkerAgentProviderHost['list'] = () =>
    Promise.resolve({ providers: [provider('claude', ['opus'])] }),
  platformSupport: WorkerAgentProviderHost['platformSupport'] = () =>
    Promise.resolve(['claude', 'codex', 'antigravity']),
): WorkerAgentProviderHost & { list: jest.Mock; platformSupport: jest.Mock } {
  return {
    authorityId: 'local-desktop',
    targetId: 'in_process_worker',
    list: jest.fn(list),
    platformSupport: jest.fn(platformSupport),
  };
}

function platformHandlerFor(
  host: WorkerAgentProviderHost,
): WorkerAgentProviderHandlers['queries']['worker.agent.provider.platform.get'] {
  return createWorkerAgentProviderHandlers(host).queries[
    'worker.agent.provider.platform.get'
  ];
}

it('platform support answers from the host port in the fixed order, refusing another worker first', async () => {
  const host = fakeHost();
  const handler = platformHandlerFor(host);
  for (const scope of [{ authorityId: 'other' }, { targetId: 'remote-1' }])
    await expect(handler({ scope }, context)).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
  expect(host.platformSupport).not.toHaveBeenCalled();
  await expect(handler({ scope: {} }, context)).resolves.toEqual({
    authorityId: 'local-desktop',
    targetId: 'in_process_worker',
    providerIds: ['claude', 'codex', 'antigravity'],
  });
  // It never reads the provider list, which carries status and models.
  expect(host.list).not.toHaveBeenCalled();
});

it('platform support refuses an unordered or failed host answer without raw text', async () => {
  const unordered = platformHandlerFor(
    fakeHost(undefined, () => Promise.resolve(['antigravity', 'claude'])),
  );
  await expect(unordered({ scope: {} }, context)).rejects.toMatchObject({
    payload: { kind: 'internal' },
  });
  const failed = platformHandlerFor(
    fakeHost(undefined, () =>
      Promise.reject(new Error('raw manifest path /private/agy')),
    ),
  );
  await expect(failed({ scope: {} }, context)).rejects.toMatchObject({
    payload: {
      kind: 'internal',
      message: 'The agent provider platform support could not be read.',
    },
  });
});

function handlerFor(
  host: WorkerAgentProviderHost,
): WorkerAgentProviderHandlers['queries']['worker.agent.provider.list'] {
  return createWorkerAgentProviderHandlers(host).queries[
    'worker.agent.provider.list'
  ];
}

it('refuses another authority or target before reading', async () => {
  const host = fakeHost();
  const handler = handlerFor(host);
  for (const scope of [{ authorityId: 'other' }, { targetId: 'remote-1' }]) {
    await expect(
      handler({ scope, probe: false }, context),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
  }
  expect(host.list).not.toHaveBeenCalled();
  await handler({ scope: { targetId: host.targetId }, probe: false }, context);
  expect(host.list).toHaveBeenCalledTimes(1);
  await handler({ scope: {}, probe: false }, context);
  expect(host.list).toHaveBeenCalledTimes(2);
});

it('returns the host inventory with the selection and the probe echo', async () => {
  const host = fakeHost();
  const result = await handlerFor(host)({ scope: {}, probe: true }, context);
  expect(result).toEqual({
    authorityId: 'local-desktop',
    targetId: 'in_process_worker',
    probed: true,
    providers: [provider('claude', ['opus'])],
  });
  expect(host.list).toHaveBeenCalledWith({ scope: {}, probe: true }, context);
});

it('a host failure is internal and keeps its cause', async () => {
  const boom = new Error('boom');
  let failure: unknown;
  try {
    await handlerFor(fakeHost(() => Promise.reject(boom)))(
      { scope: {}, probe: false },
      context,
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CanopyOperationError);
  if (!(failure instanceof CanopyOperationError)) return;
  expect(failure.payload.kind).toBe('internal');
  expect(failure.payload.code).toBeUndefined();
  expect(failure.payload.message).toBe(
    'The agent provider list could not be read.',
  );
  expect(failure.runtimeCause).toBe(boom);

  const typed = new CanopyOperationError({
    kind: 'unavailable',
    message: 'Shutting down.',
    retry: { kind: 'never' },
  });
  await expect(
    handlerFor(fakeHost(() => Promise.reject(typed)))(
      { scope: {}, probe: false },
      context,
    ),
  ).rejects.toBe(typed);
});

it('refuses a repeated provider or model', async () => {
  for (const providers of [
    [provider('claude'), provider('claude')],
    [provider('codex'), provider('claude')],
    [provider('claude', ['opus', 'opus'])],
  ]) {
    await expect(
      handlerFor(fakeHost(() => Promise.resolve({ providers })))(
        { scope: {}, probe: false },
        context,
      ),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
  }
});

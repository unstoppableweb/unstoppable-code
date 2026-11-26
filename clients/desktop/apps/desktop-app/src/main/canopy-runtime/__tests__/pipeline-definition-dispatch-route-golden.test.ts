interface KeyedParams {
  readonly _meta?: { readonly idempotencyKey?: string };
}
interface KeyedOptions {
  readonly metadata?: { readonly idempotencyKey?: string };
}
type InstructionArgs = [
  name: string,
  params: KeyedParams,
  options: KeyedOptions,
];
let mockRuntime: { instruction: jest.Mock<Promise<unknown>, InstructionArgs> };
jest.mock('../desktop-runtime-access', () => ({
  getDesktopCanopyRuntime: (): unknown => mockRuntime,
}));
const mockStoredInfo = {
  id: 'copy-1',
  name: 'Copy',
  filename: 'copy-1.yaml',
  description: '',
  icon: '',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  source: 'user',
  readonly: false,
};
jest.mock('../../pipelines/pipeline-service', () => ({
  getStoredPipelineBySource: (): unknown => ({
    success: true,
    data: { info: mockStoredInfo },
  }),
}));
jest.mock('../../pipelines/pipeline-definition-presentation', () => ({
  withPipelinePresentation: <T>(run: (presentation: unknown) => T): T =>
    run({}),
}));
jest.mock('../../pipelines/pipeline-enablement-commit', () => ({
  withPipelineEnablementCommit: async (
    run: () => Promise<void>,
  ): Promise<undefined> => {
    await run();
    return undefined;
  },
}));
jest.mock('../../pipelines/pipeline-local-metadata-store', () => ({
  readPipelineLocalMetadata: (): unknown => ({}),
}));

import { CanopyClientError } from '@canopy/core-client';
import type * as OutcomeModule from '@canopy/core-client/outcome';
import type {
  PipelineDefinition,
  PipelineDefinitionImportResult,
} from '@canopy/protocol/canopy-core';
import type { Pipeline } from '@canopy/execution-engine/types/pipeline';
import { pipelineDefinitionOwnerKey } from '@canopy/core-runtime/node/pipeline';
import type * as DispatchModule from '../pipeline-definition-dispatch';
import type * as PendingOwnersModule from '../../pipelines/daemon-definition-pending-owners';
import type {
  PipelineDefinitionWriteOperation,
  PipelineDefinitionWriteRoute,
} from '../pipeline-definition-dispatch';

type Dispatch = typeof DispatchModule;
// The route provider is set once per process, so each case loads a fresh
// dispatch module instead of resetting it.
let deleteUserPipeline: Dispatch['deleteUserPipeline'];
let duplicatePipelineDefinition: Dispatch['duplicatePipelineDefinition'];
let importRemotePipeline: Dispatch['importRemotePipeline'];
let saveUserPipeline: Dispatch['saveUserPipeline'];
let setPipelineDefinitionEnabled: Dispatch['setPipelineDefinitionEnabled'];
let setPipelineDefinitionRouteProvider: Dispatch['setPipelineDefinitionRouteProvider'];
// From the same fresh module registry as the dispatch, so `instanceof` holds.
let CanopyOutcomeUnknownError: typeof OutcomeModule.CanopyOutcomeUnknownError;
let pendingDefinitionOwner: typeof PendingOwnersModule.pendingDefinitionOwner;
let CANOPY_OUTCOME_UNKNOWN_MESSAGE: string;

jest.setTimeout(30_000);

const CONTENT: Pipeline = {
  name: 'Release',
  on: 'dispatch',
  jobs: { main: { steps: [{ id: 'note', run: 'echo release' }] } },
} as unknown as Pipeline;

function definition(id: string): PipelineDefinition {
  return {
    definitionId: id,
    name: 'Release',
    description: '',
    icon: '',
    revision: 2,
    triggerTypes: ['dispatch'],
    executionScopes: ['global'],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  } as unknown as PipelineDefinition;
}

const lostReply = (): CanopyClientError =>
  new CanopyClientError({
    kind: 'unavailable',
    message: 'The daemon connection closed before the reply.',
    retry: { kind: 'same_idempotency_key' },
  });

const lostNeverResent = (): CanopyClientError =>
  new CanopyClientError({
    kind: 'unavailable',
    message: 'The daemon connection closed before the reply.',
    retry: { kind: 'never' },
  });

const sessionDown = (): CanopyClientError =>
  new CanopyClientError({
    kind: 'failed_precondition',
    code: 'core.pipeline.targetUnavailable',
    message: 'No daemon session is open.',
    retry: { kind: 'never' },
  });

interface FakeRoute extends PipelineDefinitionWriteRoute {
  upsert: jest.MockedFunction<PipelineDefinitionWriteRoute['upsert']>;
  delete: jest.MockedFunction<PipelineDefinitionWriteRoute['delete']>;
  duplicate: jest.MockedFunction<PipelineDefinitionWriteRoute['duplicate']>;
  setEnabled: jest.MockedFunction<PipelineDefinitionWriteRoute['setEnabled']>;
  import: jest.MockedFunction<PipelineDefinitionWriteRoute['import']>;
}

function fakeRoute(
  served: readonly PipelineDefinitionWriteOperation[],
): FakeRoute {
  return {
    serves: (operation) => served.includes(operation),
    clientInstanceId: 'owner-client',
    upsert: jest.fn(),
    delete: jest.fn(),
    duplicate: jest.fn(),
    setEnabled: jest.fn(),
    import: jest.fn(),
  };
}

const IMPORTED_DOCUMENT = [
  'pipeline:',
  '  name: Release',
  '  on: dispatch',
  '  jobs:',
  '    main:',
  '      steps:',
  '        - id: note',
  '          run: echo release',
  '',
].join('\n');

function imported(id: string): PipelineDefinitionImportResult {
  return {
    definition: {
      ...definition(id),
      document: IMPORTED_DOCUMENT,
    },
    remoteDefinitionId: 'curated:release',
    remoteVersion: 'sha256:release',
  };
}

const CURATED_IMPORT = {
  remoteDefinitionId: 'curated:release',
  expectedRemoteVersion: null,
  nameOverride: null,
};

function keyOf(params: KeyedParams): string {
  const key = params._meta?.idempotencyKey;
  if (key === undefined) throw new Error('The write carries no key.');
  return key;
}

beforeEach(async () => {
  mockRuntime = {
    instruction: jest.fn<Promise<unknown>, InstructionArgs>(),
  };
  jest.resetModules();
  ({
    deleteUserPipeline,
    duplicatePipelineDefinition,
    importRemotePipeline,
    saveUserPipeline,
    setPipelineDefinitionEnabled,
    setPipelineDefinitionRouteProvider,
  } = await import('../pipeline-definition-dispatch'));
  ({ CanopyOutcomeUnknownError, CANOPY_OUTCOME_UNKNOWN_MESSAGE } =
    await import('@canopy/core-client/outcome'));
  ({ pendingDefinitionOwner } =
    await import('../../pipelines/daemon-definition-pending-owners'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('pipeline definition writes over the daemon route (CAN-7507)', () => {
  it('keeps every write in process while no route provider is set', async () => {
    mockRuntime.instruction
      .mockResolvedValue({ definition: definition('a') })
      .mockResolvedValueOnce({ definition: definition('a') })
      .mockResolvedValueOnce({ definitionId: 'a', deleted: true, revision: 2 })
      .mockResolvedValueOnce({
        definition: { ...definition('copy-1'), document: IMPORTED_DOCUMENT },
        sourceDefinitionId: 'a',
      });
    const saved = await saveUserPipeline({
      name: 'Release',
      description: '',
      icon: '',
      content: CONTENT,
    });
    expect(saved.success).toBe(true);
    await expect(deleteUserPipeline('a', 2)).resolves.toEqual({
      success: true,
    });
    await expect(
      duplicatePipelineDefinition('a', { name: 'Copy' }),
    ).resolves.toMatchObject({ success: true, data: { id: 'copy-1' } });
    await setPipelineDefinitionEnabled('a', false);
    expect(mockRuntime.instruction.mock.calls.map(([name]) => name)).toEqual([
      'core.pipeline.definition.upsert',
      'core.pipeline.definition.delete',
      'core.pipeline.definition.duplicate',
      'core.pipeline.definition.setEnabled',
    ]);
    for (const [, params, options] of mockRuntime.instruction.mock.calls)
      expect(options?.metadata?.idempotencyKey).toBe(keyOf(params));
  });

  it('keeps writes in process while the provider answers no route', async () => {
    setPipelineDefinitionRouteProvider(() => null);
    mockRuntime.instruction.mockResolvedValue({ definition: definition('a') });
    await saveUserPipeline({
      name: 'Release',
      description: '',
      icon: '',
      content: CONTENT,
    });
    expect(mockRuntime.instruction).toHaveBeenCalledTimes(1);
  });

  it('refuses a second route provider and keeps the first', async () => {
    const first = fakeRoute(['upsert']);
    const second = fakeRoute(['upsert']);
    first.upsert.mockResolvedValue({ definition: definition('g') });
    setPipelineDefinitionRouteProvider(() => first);
    expect(() => setPipelineDefinitionRouteProvider(() => second)).toThrow(
      'The pipeline definition route provider is already set.',
    );
    await saveUserPipeline({
      name: 'Release',
      description: '',
      icon: '',
      content: CONTENT,
    });
    expect(first.upsert).toHaveBeenCalledTimes(1);
    expect(second.upsert).not.toHaveBeenCalled();
    expect(mockRuntime.instruction).not.toHaveBeenCalled();
  });

  it('accepts the same route provider again', async () => {
    const route = fakeRoute(['upsert']);
    route.upsert.mockResolvedValue({ definition: definition('h') });
    const provider = (): PipelineDefinitionWriteRoute => route;
    setPipelineDefinitionRouteProvider(provider);
    expect(() => setPipelineDefinitionRouteProvider(provider)).not.toThrow();
    await saveUserPipeline({
      name: 'Release',
      description: '',
      icon: '',
      content: CONTENT,
    });
    expect(route.upsert).toHaveBeenCalledTimes(1);
  });

  it('keeps a write in process when the route does not serve it', async () => {
    const route = fakeRoute(['delete']);
    setPipelineDefinitionRouteProvider(() => route);
    mockRuntime.instruction.mockResolvedValue({ definition: definition('a') });
    await saveUserPipeline({
      name: 'Release',
      description: '',
      icon: '',
      content: CONTENT,
    });
    expect(mockRuntime.instruction).toHaveBeenCalledTimes(1);
    expect(route.upsert).not.toHaveBeenCalled();
  });

  it('sends a served save to the route with its key, never in process', async () => {
    const route = fakeRoute(['upsert']);
    route.upsert.mockResolvedValue({ definition: definition('b') });
    setPipelineDefinitionRouteProvider(() => route);
    const saved = await saveUserPipeline({
      id: 'b',
      expectedRevision: 1,
      name: 'Release',
      description: '',
      icon: '',
      content: CONTENT,
    });
    expect(saved).toMatchObject({
      success: true,
      data: { id: 'b', revision: 2, source: 'user' },
    });
    expect(mockRuntime.instruction).not.toHaveBeenCalled();
    expect(route.upsert).toHaveBeenCalledTimes(1);
    const [params, options] = route.upsert.mock.calls[0];
    expect(params).toMatchObject({
      definitionId: 'b',
      expectedRevision: 1,
      source: 'user',
    });
    expect(options?.metadata?.idempotencyKey).toBe(keyOf(params));
  });

  it('resends a lost reply with the same key and answers the first outcome', async () => {
    const route = fakeRoute(['upsert']);
    route.upsert
      .mockRejectedValueOnce(lostReply())
      .mockResolvedValueOnce({ definition: definition('c') });
    setPipelineDefinitionRouteProvider(() => route);
    const saved = await saveUserPipeline({
      name: 'Release',
      description: '',
      icon: '',
      content: CONTENT,
    });
    expect(saved).toMatchObject({ success: true, data: { id: 'c' } });
    expect(route.upsert).toHaveBeenCalledTimes(2);
    const [first, firstOptions] = route.upsert.mock.calls[0];
    const [second, secondOptions] = route.upsert.mock.calls[1];
    expect(keyOf(second)).toBe(keyOf(first));
    expect(secondOptions?.metadata?.idempotencyKey).toBe(
      firstOptions?.metadata?.idempotencyKey,
    );
    expect(mockRuntime.instruction).not.toHaveBeenCalled();
  });

  it('answers an unknown outcome when a lost reply outlasts the deadline', async () => {
    jest.useFakeTimers();
    const route = fakeRoute(['upsert']);
    route.upsert.mockRejectedValue(lostReply());
    setPipelineDefinitionRouteProvider(() => route);
    const saving = saveUserPipeline({
      name: 'Release',
      description: '',
      icon: '',
      content: CONTENT,
    });
    await jest.advanceTimersByTimeAsync(60_000);
    await expect(saving).resolves.toEqual({
      success: false,
      outcome: 'unknown',
      error: CANOPY_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(route.upsert.mock.calls.length).toBeGreaterThan(1);
    const [[first, firstOptions]] = route.upsert.mock.calls;
    for (const [params, options] of route.upsert.mock.calls) {
      expect(keyOf(params)).toBe(keyOf(first));
      expect(options?.metadata?.idempotencyKey).toBe(
        firstOptions?.metadata?.idempotencyKey,
      );
    }
    expect(mockRuntime.instruction).not.toHaveBeenCalled();
  });

  it('answers an unknown outcome when the first reply never comes before the deadline', async () => {
    jest.useFakeTimers();
    const route = fakeRoute(['upsert']);
    route.upsert.mockReturnValue(new Promise(() => {}));
    setPipelineDefinitionRouteProvider(() => route);
    const saving = saveUserPipeline({
      name: 'Release',
      description: '',
      icon: '',
      content: CONTENT,
    });
    await jest.advanceTimersByTimeAsync(60_000);
    await expect(saving).resolves.toEqual({
      success: false,
      outcome: 'unknown',
      error: CANOPY_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(route.upsert).toHaveBeenCalledTimes(1);
    expect(mockRuntime.instruction).not.toHaveBeenCalled();
  });

  it('answers an unknown outcome when the deadline aborts the first attempt', async () => {
    jest.useFakeTimers();
    const route = fakeRoute(['upsert']);
    route.upsert.mockImplementation(
      (_params, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () =>
            reject(
              new CanopyClientError({
                kind: 'cancelled',
                message: 'The daemon call was aborted.',
                retry: { kind: 'never' },
              }),
            ),
          ),
        ),
    );
    setPipelineDefinitionRouteProvider(() => route);
    const saving = saveUserPipeline({
      name: 'Release',
      description: '',
      icon: '',
      content: CONTENT,
    });
    await jest.advanceTimersByTimeAsync(60_000);
    await expect(saving).resolves.toEqual({
      success: false,
      outcome: 'unknown',
      error: CANOPY_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(route.upsert).toHaveBeenCalledTimes(1);
    expect(mockRuntime.instruction).not.toHaveBeenCalled();
  });

  it('answers an unknown outcome for a committed reply that settles past the deadline', async () => {
    const realNow = performance.now.bind(performance);
    let skew = 0;
    const clock = jest
      .spyOn(performance, 'now')
      .mockImplementation(() => realNow() + skew);
    try {
      const route = fakeRoute(['upsert']);
      route.upsert.mockImplementation(() => {
        skew = 30_001;
        return Promise.resolve({ definition: definition('late') });
      });
      setPipelineDefinitionRouteProvider(() => route);
      await expect(
        saveUserPipeline({
          name: 'Release',
          description: '',
          icon: '',
          content: CONTENT,
        }),
      ).resolves.toEqual({
        success: false,
        outcome: 'unknown',
        error: CANOPY_OUTCOME_UNKNOWN_MESSAGE,
      });
      expect(route.upsert).toHaveBeenCalledTimes(1);
      expect(mockRuntime.instruction).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('still answers a committed reply that settles just before the deadline', async () => {
    const realNow = performance.now.bind(performance);
    let skew = 0;
    const clock = jest
      .spyOn(performance, 'now')
      .mockImplementation(() => realNow() + skew);
    try {
      const route = fakeRoute(['upsert']);
      route.upsert.mockImplementation(() => {
        skew = 29_000;
        return Promise.resolve({ definition: definition('on-time') });
      });
      setPipelineDefinitionRouteProvider(() => route);
      await expect(
        saveUserPipeline({
          name: 'Release',
          description: '',
          icon: '',
          content: CONTENT,
        }),
      ).resolves.toMatchObject({ success: true, data: { id: 'on-time' } });
      expect(route.upsert).toHaveBeenCalledTimes(1);
      expect(mockRuntime.instruction).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps a lost reply unknown when the resend is refused', async () => {
    const route = fakeRoute(['upsert']);
    route.upsert
      .mockRejectedValueOnce(lostReply())
      .mockRejectedValueOnce(sessionDown());
    setPipelineDefinitionRouteProvider(() => route);
    await expect(
      saveUserPipeline({
        name: 'Release',
        description: '',
        icon: '',
        content: CONTENT,
      }),
    ).resolves.toEqual({
      success: false,
      outcome: 'unknown',
      error: CANOPY_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(route.upsert).toHaveBeenCalledTimes(2);
    const [[first, firstOptions], [second, secondOptions]] =
      route.upsert.mock.calls;
    expect(keyOf(second)).toBe(keyOf(first));
    expect(secondOptions?.metadata?.idempotencyKey).toBe(
      firstOptions?.metadata?.idempotencyKey,
    );
    expect(mockRuntime.instruction).not.toHaveBeenCalled();
  });

  it('answers an unknown outcome for a lost reply that is never resent', async () => {
    const route = fakeRoute(['upsert', 'delete', 'duplicate', 'setEnabled']);
    route.upsert.mockRejectedValue(lostNeverResent());
    route.delete.mockRejectedValue(lostNeverResent());
    route.duplicate.mockRejectedValue(lostNeverResent());
    route.setEnabled.mockRejectedValue(lostNeverResent());
    setPipelineDefinitionRouteProvider(() => route);
    const unknown = {
      success: false,
      outcome: 'unknown',
      error: CANOPY_OUTCOME_UNKNOWN_MESSAGE,
    };
    await expect(
      saveUserPipeline({
        name: 'Release',
        description: '',
        icon: '',
        content: CONTENT,
      }),
    ).resolves.toEqual(unknown);
    await expect(deleteUserPipeline('d', null)).resolves.toEqual(unknown);
    await expect(duplicatePipelineDefinition('d', {})).resolves.toEqual(
      unknown,
    );
    await expect(
      setPipelineDefinitionEnabled('d', false),
    ).rejects.toBeInstanceOf(CanopyOutcomeUnknownError);
    for (const method of [
      route.upsert,
      route.delete,
      route.duplicate,
      route.setEnabled,
    ])
      expect(method).toHaveBeenCalledTimes(1);
    expect(mockRuntime.instruction).not.toHaveBeenCalled();
  });

  it('surfaces a definite routed refusal as typed and never falls back in process', async () => {
    const route = fakeRoute(['upsert', 'delete', 'duplicate', 'setEnabled']);
    route.upsert.mockRejectedValue(sessionDown());
    route.delete.mockRejectedValue(sessionDown());
    route.duplicate.mockRejectedValue(sessionDown());
    route.setEnabled.mockRejectedValue(sessionDown());
    setPipelineDefinitionRouteProvider(() => route);
    await expect(
      saveUserPipeline({
        name: 'Release',
        description: '',
        icon: '',
        content: CONTENT,
      }),
    ).resolves.toEqual({ success: false, error: 'No daemon session is open.' });
    await expect(deleteUserPipeline('d', null)).resolves.toEqual({
      success: false,
      error: 'No daemon session is open.',
    });
    await expect(duplicatePipelineDefinition('d', {})).resolves.toEqual({
      success: false,
      error: 'No daemon session is open.',
    });
    const refusal = setPipelineDefinitionEnabled('d', false);
    await expect(refusal).rejects.toThrow('No daemon session is open.');
    await expect(refusal).rejects.not.toBeInstanceOf(CanopyOutcomeUnknownError);
    for (const method of [
      route.upsert,
      route.delete,
      route.duplicate,
      route.setEnabled,
    ])
      expect(method).toHaveBeenCalledTimes(1);
    expect(mockRuntime.instruction).not.toHaveBeenCalled();
  });

  it('sends served deletes, duplicates and enablement writes with their keys', async () => {
    const route = fakeRoute(['delete', 'duplicate', 'setEnabled']);
    route.delete.mockResolvedValue({
      definitionId: 'e',
      deleted: true,
      revision: 3,
    });
    route.duplicate.mockResolvedValue({
      definition: { ...definition('copy-1'), document: IMPORTED_DOCUMENT },
      sourceDefinitionId: 'e',
    });
    route.setEnabled.mockResolvedValue({ definitionId: 'e', enabled: false });
    setPipelineDefinitionRouteProvider(() => route);
    await expect(deleteUserPipeline('e', 3)).resolves.toEqual({
      success: true,
    });
    await expect(
      duplicatePipelineDefinition('e', { name: 'Copy' }),
    ).resolves.toMatchObject({ success: true, data: { id: 'copy-1' } });
    await setPipelineDefinitionEnabled('e', false);
    const [deleteParams, deleteOptions] = route.delete.mock.calls[0];
    expect(deleteParams).toMatchObject({
      definitionId: 'e',
      expectedRevision: 3,
    });
    expect(deleteOptions?.metadata?.idempotencyKey).toBe(keyOf(deleteParams));
    const [duplicateParams, duplicateOptions] = route.duplicate.mock.calls[0];
    expect(duplicateParams).toMatchObject({
      sourceDefinitionId: 'e',
      name: 'Copy',
    });
    expect(duplicateOptions?.metadata?.idempotencyKey).toBe(
      keyOf(duplicateParams),
    );
    const [enabledParams, enabledOptions] = route.setEnabled.mock.calls[0];
    expect(enabledParams).toMatchObject({ definitionId: 'e', enabled: false });
    expect(enabledOptions?.metadata?.idempotencyKey).toBe(keyOf(enabledParams));
    expect(mockRuntime.instruction).not.toHaveBeenCalled();
  });

  it('gives two separate saves two keys', async () => {
    const route = fakeRoute(['upsert']);
    route.upsert.mockResolvedValue({ definition: definition('f') });
    setPipelineDefinitionRouteProvider(() => route);
    const write = {
      name: 'Release',
      description: '',
      icon: '',
      content: CONTENT,
    };
    await saveUserPipeline(write);
    await saveUserPipeline(write);
    expect(keyOf(route.upsert.mock.calls[1][0])).not.toBe(
      keyOf(route.upsert.mock.calls[0][0]),
    );
  });

  it('sends a served import to the route with its key, never in process', async () => {
    const route = fakeRoute(['import']);
    route.import.mockResolvedValue(imported('i'));
    setPipelineDefinitionRouteProvider(() => route);
    await expect(importRemotePipeline(CURATED_IMPORT)).resolves.toMatchObject({
      id: 'i',
      revision: 2,
      source: 'user',
    });
    expect(mockRuntime.instruction).not.toHaveBeenCalled();
    expect(route.import).toHaveBeenCalledTimes(1);
    const [params, options] = route.import.mock.calls[0];
    expect(params).toMatchObject({
      remoteDefinitionId: 'curated:release',
      targetScope: {},
      expectedRemoteVersion: null,
      nameOverride: null,
    });
    expect(options?.metadata?.idempotencyKey).toBe(keyOf(params));
  });

  it('keeps an import in process when no route serves it', async () => {
    mockRuntime.instruction.mockResolvedValue(imported('j'));
    await expect(importRemotePipeline(CURATED_IMPORT)).resolves.toMatchObject({
      id: 'j',
    });
    const route = fakeRoute(['upsert', 'delete', 'duplicate', 'setEnabled']);
    setPipelineDefinitionRouteProvider(() => route);
    await expect(importRemotePipeline(CURATED_IMPORT)).resolves.toMatchObject({
      id: 'j',
    });
    expect(route.import).not.toHaveBeenCalled();
    expect(mockRuntime.instruction.mock.calls.map(([name]) => name)).toEqual([
      'core.pipeline.definition.import',
      'core.pipeline.definition.import',
    ]);
    for (const [, params, options] of mockRuntime.instruction.mock.calls)
      expect(options?.metadata?.idempotencyKey).toBe(keyOf(params));
  });

  it('resends a lost import reply with the same key, and never re-keys an unknown one', async () => {
    const route = fakeRoute(['import']);
    route.import
      .mockRejectedValueOnce(lostReply())
      .mockResolvedValueOnce(imported('k'))
      .mockRejectedValueOnce(lostNeverResent());
    setPipelineDefinitionRouteProvider(() => route);
    await expect(importRemotePipeline(CURATED_IMPORT)).resolves.toMatchObject({
      id: 'k',
    });
    const [[first, firstOptions], [second, secondOptions]] =
      route.import.mock.calls;
    expect(keyOf(second)).toBe(keyOf(first));
    expect(secondOptions?.metadata?.idempotencyKey).toBe(
      firstOptions?.metadata?.idempotencyKey,
    );
    await expect(importRemotePipeline(CURATED_IMPORT)).rejects.toBeInstanceOf(
      CanopyOutcomeUnknownError,
    );
    expect(route.import).toHaveBeenCalledTimes(3);
    expect(keyOf(route.import.mock.calls[2][0])).not.toBe(keyOf(first));
    expect(mockRuntime.instruction).not.toHaveBeenCalled();
  });

  it('surfaces a definite routed import refusal as typed and never falls back in process', async () => {
    const route = fakeRoute(['import']);
    route.import.mockRejectedValue(sessionDown());
    setPipelineDefinitionRouteProvider(() => route);
    const refusal = importRemotePipeline(CURATED_IMPORT);
    await expect(refusal).rejects.toThrow('No daemon session is open.');
    await expect(refusal).rejects.not.toBeInstanceOf(CanopyOutcomeUnknownError);
    expect(route.import).toHaveBeenCalledTimes(1);
    expect(mockRuntime.instruction).not.toHaveBeenCalled();
  });

  // CAN-7507: a routed create's id is the daemon's, so its owner is
  // registered under the key the daemon derives from this route's client
  // and the request's key, for the effect it raises before the commit.
  describe("a routed create's owner (CAN-7507)", () => {
    const OWNER = { owner: 'org:golden', agentAuthor: null };
    const save = (
      owner?: DispatchModule.PendingDefinitionOwnerSource,
    ): ReturnType<Dispatch['saveUserPipeline']> =>
      saveUserPipeline({
        name: 'Release',
        description: '',
        icon: '',
        content: CONTENT,
        ...(owner === undefined ? {} : { owner }),
      });

    it('registers it under the sender-bound key while the routed write is out, and clears it when the write answers', async () => {
      const route = fakeRoute(['upsert']);
      let key = '';
      let during: unknown;
      route.upsert.mockImplementation((params) => {
        key = pipelineDefinitionOwnerKey('owner-client', keyOf(params));
        during = pendingDefinitionOwner(key);
        return Promise.resolve({ definition: definition('a') });
      });
      setPipelineDefinitionRouteProvider(() => route);
      await expect(save(OWNER)).resolves.toMatchObject({ success: true });
      expect(during).toEqual(OWNER);
      expect(
        pendingDefinitionOwner(
          pipelineDefinitionOwnerKey(
            'another-client',
            keyOf(route.upsert.mock.calls[0][0]),
          ),
        ),
      ).toBeUndefined();
      expect(pendingDefinitionOwner(key)).toBeUndefined();
    });

    it('keeps it after a lost reply ends as an unknown outcome, for an effect that arrives late, until it expires', async () => {
      jest.useFakeTimers();
      const route = fakeRoute(['upsert']);
      let key = '';
      const during: unknown[] = [];
      route.upsert.mockImplementation((params) => {
        key = pipelineDefinitionOwnerKey('owner-client', keyOf(params));
        during.push(pendingDefinitionOwner(key));
        return Promise.reject(lostReply());
      });
      setPipelineDefinitionRouteProvider(() => route);
      const saving = save(() => Promise.resolve(OWNER));
      await jest.advanceTimersByTimeAsync(60_000);
      await expect(saving).resolves.toMatchObject({ outcome: 'unknown' });
      expect(during.length).toBeGreaterThan(1);
      expect(during.every((owner) => owner !== undefined)).toBe(true);
      expect(pendingDefinitionOwner(key)).toEqual(OWNER);
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(pendingDefinitionOwner(key)).toBeUndefined();
    });

    it('refuses a routed create, typed and retryable, while every registration is unsettled, and keeps the oldest', async () => {
      const route = fakeRoute(['upsert']);
      const held: (() => void)[] = [];
      const keys: string[] = [];
      route.upsert.mockImplementation((params) => {
        keys.push(pipelineDefinitionOwnerKey('owner-client', keyOf(params)));
        return new Promise((resolve) => {
          held.push(() => resolve({ definition: definition('a') }));
        });
      });
      setPipelineDefinitionRouteProvider(() => route);
      const out = Array.from({ length: 64 }, () => save(OWNER));
      for (let turn = 0; keys.length < 64 && turn < 1_000; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
      expect(keys).toHaveLength(64);
      const refused = save(OWNER);
      for (let turn = 0; keys.length < 65 && turn < 50; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
      // A 65th routed create would be held like the others; it must never be sent.
      expect(route.upsert).toHaveBeenCalledTimes(64);
      await expect(refused).resolves.toMatchObject({
        success: false,
        error:
          'Too many workflow changes are waiting to be saved. Try again in a moment.',
      });
      expect(pendingDefinitionOwner(keys[0])).toEqual(OWNER);
      for (const settle of held) settle();
      await Promise.all(out);
      expect(pendingDefinitionOwner(keys[0])).toBeUndefined();
    });

    it('never reads the owner in process, and registers none for an edit', async () => {
      const read = jest.fn(() => Promise.resolve(OWNER));
      mockRuntime.instruction.mockResolvedValue({
        definition: definition('a'),
      });
      await save(read);
      expect(read).not.toHaveBeenCalled();
      const route = fakeRoute(['upsert']);
      let during: unknown = 'unread';
      route.upsert.mockImplementation((params) => {
        during = pendingDefinitionOwner(
          pipelineDefinitionOwnerKey('owner-client', keyOf(params)),
        );
        return Promise.resolve({ definition: definition('a') });
      });
      setPipelineDefinitionRouteProvider(() => route);
      await saveUserPipeline({
        id: 'a',
        name: 'Release',
        description: '',
        icon: '',
        content: CONTENT,
        owner: read,
      });
      expect(during).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    });
  });
});

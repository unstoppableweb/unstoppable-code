// CAN-7522: a core that commits pipeline definition writes for the app asks
// the app, its owner, to check each write before the commit and to apply its
// effects around it, over the owner channel in the definitions' reserved
// scope. Nothing commits unless the owner allows it in time, a committed
// write is always answered, and an owner that attaches reconciles.
import {
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_STREAM_DEFINITIONS,
  WORKER_PIPELINE_OWNER_SCOPE_PENDING_MAX,
  WorkerPipelineHostRequestSchema,
  isUnknownKeyedWriteOutcome,
  isWorkerPipelineHostWithdrawal,
  type CanopyErrorPayload,
  type PipelineDefinitionUpsertParams,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostRequestsItem,
  type WorkerPipelineHostResult,
} from '@canopy/protocol/canopy-core';
import type { Pipeline } from '@canopy/pipeline-interop';

import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import { STORAGE_OWNERSHIP, type StorageOwnershipRow } from '../../../storage';
import { pipelineDefinitionOwnerKey } from '../core-pipeline-definitions';
import {
  createDaemonDefinitionOwnerEffects,
  createDaemonPipelineDefinitionHost,
} from '../daemon-definitions';
import {
  createPipelineDefinitionService,
  type PipelineDefinitionSourceDocument,
  type PipelineDefinitionSourcePort,
  type PipelineDefinitionWritePort,
} from '../definitions';
import {
  createPipelineOwnerChannel,
  type PipelineOwnerChannel,
} from '../execution/owner-channel';
import { pipelineHostCoreCaller } from '../execution/host-requests';

const SCOPE = 'core:pipeline-definitions';
const SERVES = [
  { kind: 'owner.definition.precheck', revision: 1 },
  { kind: 'owner.definition.effects', revision: 1 },
];
const SOURCE_TEXT = [
  'name: Source',
  'on: dispatch',
  'jobs:',
  '  build:',
  '    steps:',
  '      - id: echo',
  '        run: echo hi',
  '',
].join('\n');
const pipeline: Pipeline = {
  name: 'Edited',
  on: { dispatch: {} },
  jobs: { build: { steps: [{ id: 'echo', run: 'echo edited' }] } },
};

function stored(
  definitionId: string,
  name: string,
  revision = 1,
): PipelineDefinitionSourceDocument {
  return {
    source: 'user',
    definitionId,
    name,
    description: '',
    icon: '',
    readonly: false,
    revision,
    owner: null,
    createdAt: null,
    updatedAt: null,
    format: 'yaml',
    text: SOURCE_TEXT,
  };
}

/** A user store in memory that logs each write as it commits. */
function memoryStore(log: string[]): {
  docs: Map<string, PipelineDefinitionSourceDocument>;
  port: PipelineDefinitionSourcePort;
  writer: PipelineDefinitionWritePort;
  failCopy: { next: boolean };
} {
  const docs = new Map<string, PipelineDefinitionSourceDocument>([
    ['definition-1', stored('definition-1', 'Edited before')],
    ['source-1', stored('source-1', 'Source')],
  ]);
  const failCopy = { next: false };
  return {
    docs,
    failCopy,
    port: {
      sources: ['user'],
      list: () => Promise.resolve([...docs.values()]),
      read: (_source, definitionId) =>
        Promise.resolve(docs.get(definitionId) ?? null),
    },
    writer: {
      upsert: (write) => {
        const definitionId =
          write.definitionId ?? write.createId ?? 'created-1';
        const document = {
          ...stored(definitionId, write.name),
          revision: (docs.get(definitionId)?.revision ?? 0) + 1,
          text: write.text,
        };
        docs.set(definitionId, document);
        log.push(`store upsert ${definitionId}`);
        return Promise.resolve(document);
      },
      copy: (copy) => {
        if (failCopy.next) {
          failCopy.next = false;
          log.push(`store copy failed ${copy.definitionId}`);
          return Promise.reject(new Error('The disk is full.'));
        }
        const document = {
          ...stored(copy.definitionId, copy.name),
          text: copy.text,
        };
        docs.set(copy.definitionId, document);
        log.push(`store copy ${copy.definitionId}`);
        return Promise.resolve(document);
      },
      revision: (definitionId) =>
        Promise.resolve(docs.get(definitionId)?.revision ?? null),
      delete: (definitionId) => {
        const document = docs.get(definitionId);
        if (!document) return Promise.reject(new Error('Not found.'));
        docs.delete(definitionId);
        log.push(`store delete ${definitionId}`);
        return Promise.resolve(document.revision);
      },
    },
  };
}

const allowed: WorkerPipelineHostResult = {
  status: 'owner',
  value: { kind: 'definition.precheck', answer: { allowed: true } },
};
const applied: WorkerPipelineHostResult = {
  status: 'owner',
  value: { kind: 'definition.effects' },
};

function describeRequest(request: WorkerPipelineHostRequest): string {
  const action = request.request;
  if (action.action === 'owner.definition.precheck')
    return `owner precheck ${action.op} ${action.definitionId ?? '-'}`;
  if (action.action === 'owner.definition.effects')
    return `owner ${action.phase} ${action.op} ${action.definitionId ?? '-'}`;
  return `owner ${action.action}`;
}

/**
 * An owner that serves the definition requests and answers each with
 * `answer`, or leaves it pending when that returns undefined.
 */
function serveOwner(
  channel: PipelineOwnerChannel,
  log: string[],
  answer: (
    request: WorkerPipelineHostRequest,
  ) => WorkerPipelineHostResult | undefined = (request) =>
    request.request.action === 'owner.definition.precheck' ? allowed : applied,
): {
  requests: WorkerPipelineHostRequest[];
  items: WorkerPipelineHostRequestsItem[];
  stop(): void;
} {
  const requests: WorkerPipelineHostRequest[] = [];
  const items: WorkerPipelineHostRequestsItem[] = [];
  const stop = channel.broker.subscribe(
    (item) => {
      items.push(item);
      if (isWorkerPipelineHostWithdrawal(item)) return;
      requests.push(item);
      log.push(describeRequest(item));
      const result = answer(item);
      if (result)
        queueMicrotask(() =>
          channel.broker.respond(item.executionId, item.requestId, result),
        );
    },
    { serves: SERVES },
  );
  return { requests, items, stop };
}

function edit(): Omit<PipelineDefinitionUpsertParams, '_meta'> {
  return {
    definitionId: 'definition-1',
    expectedRevision: 1,
    scope: { workspaceId: 'workspace-1' },
    source: 'user',
    name: 'Edited',
    description: '',
    icon: '',
    format: 'yaml',
    document: { pipeline },
  };
}

const signal = new AbortController().signal;

describe('definition owner effects (CAN-7522)', () => {
  it('an edit, a delete and a copy are checked, then their effects applied around the commit, in the definitions scope', async () => {
    const log: string[] = [];
    const store = memoryStore(log);
    const channel = createPipelineOwnerChannel();
    const owner = serveOwner(channel, log);
    const service = createPipelineDefinitionService({
      ports: [store.port],
      writer: store.writer,
      ownerEffects: createDaemonDefinitionOwnerEffects(channel),
    });
    await expect(service.upsert(edit(), signal)).resolves.toMatchObject({
      definitionId: 'definition-1',
      revision: 2,
    });
    await service.duplicate(
      { sourceDefinitionId: 'source-1', scope: {} },
      signal,
      { createId: 'copy-1' },
    );
    await service.delete(
      { definitionId: 'definition-1', expectedRevision: null },
      signal,
    );
    expect(log).toEqual([
      'owner precheck upsert definition-1',
      'owner beforeCommit upsert definition-1',
      'store upsert definition-1',
      'owner afterCommit upsert definition-1',
      'owner precheck duplicate -',
      'owner beforeCommit duplicate copy-1',
      'store copy copy-1',
      'owner afterCommit duplicate copy-1',
      'owner precheck delete definition-1',
      'owner beforeCommit delete definition-1',
      'store delete definition-1',
      'owner afterCommit delete definition-1',
    ]);
    for (const request of owner.requests) {
      expect(WorkerPipelineHostRequestSchema.parse(request)).toEqual(request);
      expect(request).toMatchObject({
        executionId: SCOPE,
        jobId: '_run',
        stepId: '_run',
        childExecutionId: null,
        owner: null,
      });
    }
    expect(owner.requests[0]?.request).toEqual({
      action: 'owner.definition.precheck',
      op: 'upsert',
      definitionId: 'definition-1',
      scope: { workspaceId: 'workspace-1' },
    });
    expect(owner.requests[3]?.request).toEqual({
      action: 'owner.definition.precheck',
      op: 'duplicate',
      definitionId: null,
      origin: { source: 'user', definitionId: 'source-1' },
      scope: {},
    });
    expect(owner.requests[4]?.request).toEqual({
      action: 'owner.definition.effects',
      op: 'duplicate',
      phase: 'beforeCommit',
      definitionId: 'copy-1',
      origin: { source: 'user', definitionId: 'source-1' },
    });
  });

  it('a create needs no check and raises only its effects after the commit', async () => {
    const log: string[] = [];
    const store = memoryStore(log);
    const channel = createPipelineOwnerChannel();
    const owner = serveOwner(channel, log);
    const service = createPipelineDefinitionService({
      ports: [store.port],
      writer: store.writer,
      ownerEffects: createDaemonDefinitionOwnerEffects(channel),
    });
    await expect(
      service.upsert(
        { ...edit(), definitionId: null, expectedRevision: null },
        signal,
        { createId: 'created-2' },
      ),
    ).resolves.toMatchObject({ definitionId: 'created-2', revision: 1 });
    expect(log).toEqual([
      'store upsert created-2',
      'owner afterCommit upsert created-2',
    ]);
    expect(owner.requests[0]?.request).toEqual({
      action: 'owner.definition.effects',
      op: 'upsert',
      phase: 'afterCommit',
      definitionId: 'created-2',
    });
  });

  it("the owner's refusal refuses the write, typed, and commits nothing", async () => {
    const log: string[] = [];
    const store = memoryStore(log);
    const channel = createPipelineOwnerChannel();
    serveOwner(channel, log, (request) =>
      request.request.action === 'owner.definition.precheck'
        ? {
            status: 'owner',
            value: {
              kind: 'definition.precheck',
              answer: {
                allowed: false,
                code: 'contextMismatch',
                message: 'Workflow unavailable (context-mismatch)',
              },
            },
          }
        : applied,
    );
    const service = createPipelineDefinitionService({
      ports: [store.port],
      writer: store.writer,
      ownerEffects: createDaemonDefinitionOwnerEffects(channel),
    });
    await expect(service.upsert(edit(), signal)).rejects.toMatchObject({
      payload: {
        kind: 'permission_denied',
        code: 'core.pipeline.contextMismatch',
      },
    });
    await expect(
      service.delete(
        { definitionId: 'definition-1', expectedRevision: null },
        signal,
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(log).toEqual([
      'owner precheck upsert definition-1',
      'owner precheck delete definition-1',
    ]);
    expect(store.docs.get('definition-1')?.name).toBe('Edited before');
  });

  it("an owner that doesn't answer in time refuses the write for a resend, commits nothing, and a late answer is already settled", async () => {
    const log: string[] = [];
    const store = memoryStore(log);
    const channel = createPipelineOwnerChannel();
    const owner = serveOwner(channel, log, () => undefined);
    const service = createPipelineDefinitionService({
      ports: [store.port],
      writer: store.writer,
      ownerEffects: createDaemonDefinitionOwnerEffects(channel, {
        precheckMs: 50,
      }),
    });
    const late = await refusalOf(service.upsert(edit(), signal));
    expect(late).toMatchObject({
      kind: 'unavailable',
      code: 'core.pipeline.sourceUnavailable',
      retry: { kind: 'same_idempotency_key' },
    });
    // The owner was asked and may have acted: the caller can't confirm.
    expect(isUnknownKeyedWriteOutcome(late)).toBe(true);
    expect(log).toEqual(['owner precheck upsert definition-1']);
    expect(store.docs.get('definition-1')?.revision).toBe(1);
    const [request] = owner.requests;
    if (!request) throw new Error('The precheck was never raised.');
    expect(owner.items).toContainEqual({
      withdrawn: true,
      executionId: SCOPE,
      requestId: request.requestId,
    });
    expect(
      channel.broker.respond(SCOPE, request.requestId, allowed),
    ).toMatchObject({ outcome: 'already_settled' });
  });

  /** The refusal a write ended with. */
  async function refusalOf(
    write: Promise<unknown>,
  ): Promise<CanopyErrorPayload> {
    const error = await write.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    if (!(error instanceof CanopyOperationError))
      throw new Error('The write was not refused with a typed error.');
    return error.payload;
  }

  it('with no owner, none serving these requests, or a full scope, the write is refused definitely: nothing was asked or written', async () => {
    const log: string[] = [];
    const store = memoryStore(log);
    const channel = createPipelineOwnerChannel();
    const service = createPipelineDefinitionService({
      ports: [store.port],
      writer: store.writer,
      ownerEffects: createDaemonDefinitionOwnerEffects(channel),
    });
    const definite = {
      kind: 'unavailable',
      code: 'core.pipeline.ownerUnavailable',
      retry: { kind: 'same_idempotency_key' },
    };
    // No owner subscribed.
    const absent = await refusalOf(service.upsert(edit(), signal));
    expect(absent).toMatchObject(definite);
    // A routed write's caller reads it as a refusal, never couldn't-confirm.
    expect(isUnknownKeyedWriteOutcome(absent)).toBe(false);

    // An owner that serves none of these requests.
    const legacy: WorkerPipelineHostRequestsItem[] = [];
    const stopLegacy = channel.broker.subscribe((item) => legacy.push(item));
    const unserved = await refusalOf(service.upsert(edit(), signal));
    expect(unserved).toMatchObject(definite);
    expect(isUnknownKeyedWriteOutcome(unserved)).toBe(false);
    expect(legacy).toEqual([]);
    stopLegacy();

    // A full scope: the 65th request is never raised.
    const held: WorkerPipelineHostRequestsItem[] = [];
    channel.broker.subscribe((item) => held.push(item), { serves: SERVES });
    const filler = new AbortController();
    const pending = Array.from(
      { length: WORKER_PIPELINE_OWNER_SCOPE_PENDING_MAX },
      (_, index) =>
        channel.broker.raiseOwner(
          {
            requestId: `filler-${index}`,
            executionId: SCOPE,
            jobId: '_run',
            stepId: '_run',
            childExecutionId: null,
            attempt: 0,
            iteration: 0,
            owner: null,
            deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            request: {
              action: 'owner.definition.effects',
              op: 'reconcile',
              phase: 'reconcile',
              definitionId: null,
            },
          },
          filler.signal,
        ),
    );
    const full = await refusalOf(service.upsert(edit(), signal));
    expect(full).toMatchObject(definite);
    expect(isUnknownKeyedWriteOutcome(full)).toBe(false);
    expect(held).toHaveLength(WORKER_PIPELINE_OWNER_SCOPE_PENDING_MAX);
    filler.abort(new Error('test over'));
    await Promise.allSettled(pending);

    expect(log).toEqual([]);
    expect(store.docs.get('definition-1')?.revision).toBe(1);
  });

  it('effects that fail after the commit still answer the committed write', async () => {
    const log: string[] = [];
    const store = memoryStore(log);
    const channel = createPipelineOwnerChannel();
    serveOwner(channel, log, (request) => {
      const action = request.request;
      if (action.action === 'owner.definition.precheck') return allowed;
      return action.action === 'owner.definition.effects' &&
        action.phase === 'afterCommit'
        ? {
            status: 'failure',
            failureReason: null,
            message: 'The host step failed unexpectedly.',
            outputs: {},
          }
        : applied;
    });
    const service = createPipelineDefinitionService({
      ports: [store.port],
      writer: store.writer,
      ownerEffects: createDaemonDefinitionOwnerEffects(channel),
    });
    await expect(service.upsert(edit(), signal)).resolves.toMatchObject({
      revision: 2,
    });
    expect(store.docs.get('definition-1')?.revision).toBe(2);
  });

  it('a copy that fails after its receipts were applied asks the owner to reconcile once the write is done', async () => {
    const log: string[] = [];
    const store = memoryStore(log);
    const channel = createPipelineOwnerChannel();
    serveOwner(channel, log);
    const service = createPipelineDefinitionService({
      ports: [store.port],
      writer: store.writer,
      ownerEffects: createDaemonDefinitionOwnerEffects(channel),
    });
    store.failCopy.next = true;
    await expect(
      service.duplicate({ sourceDefinitionId: 'source-1', scope: {} }, signal, {
        createId: 'copy-1',
      }),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toEqual([
      'owner precheck duplicate -',
      'owner beforeCommit duplicate copy-1',
      'store copy failed copy-1',
      'owner reconcile reconcile -',
    ]);
    expect(store.docs.has('copy-1')).toBe(false);
  });

  it('a reconcile waits for a write whose effects are in flight', async () => {
    const log: string[] = [];
    const store = memoryStore(log);
    const channel = createPipelineOwnerChannel();
    const owner = serveOwner(channel, log, (request) =>
      request.request.action === 'owner.definition.precheck'
        ? undefined
        : applied,
    );
    const service = createPipelineDefinitionService({
      ports: [store.port],
      writer: store.writer,
      ownerEffects: createDaemonDefinitionOwnerEffects(channel),
    });
    const written = service.upsert(edit(), signal);
    await new Promise((resolve) => setImmediate(resolve));
    const reconciled = service.reconcileOwnerEffects(signal);
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toEqual(['owner precheck upsert definition-1']);
    const [precheck] = owner.requests;
    if (!precheck) throw new Error('The precheck was never raised.');
    channel.broker.respond(SCOPE, precheck.requestId, allowed);
    await written;
    await reconciled;
    expect(log).toEqual([
      'owner precheck upsert definition-1',
      'owner beforeCommit upsert definition-1',
      'store upsert definition-1',
      'owner afterCommit upsert definition-1',
      'owner reconcile reconcile -',
    ]);
  });

  it('an owner that attaches, or replaces another, is asked for one reconcile pass over the stream (crash recovery)', async () => {
    const log: string[] = [];
    const store = memoryStore(log);
    const channel = createPipelineOwnerChannel();
    const flipped: readonly StorageOwnershipRow[] = STORAGE_OWNERSHIP.map(
      (row): StorageOwnershipRow =>
        row.id === 'pipeline_definitions'
          ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
          : row,
    );
    const host = createDaemonPipelineDefinitionHost({
      dataRoot: '/data',
      authorityId: 'authority',
      ownership: flipped,
      flushDirectory: () => Promise.resolve(),
      sources: () =>
        Promise.resolve({
          ports: [store.port],
          writer: store.writer,
          dataRoot: '/data',
        }),
      owner: channel,
    });
    expect(host.authorityId).toBe('authority');
    const dispatcher = createCanopyDispatcher({
      profile: 'core+worker',
      definitions: {
        queries: {},
        instructions: {
          'worker.pipeline.hostRequest.respond':
            WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
              'worker.pipeline.hostRequest.respond'
            ],
        },
        streams: {
          'worker.pipeline.hostRequests':
            WORKER_PIPELINE_STREAM_DEFINITIONS['worker.pipeline.hostRequests'],
        },
      },
      handlers: { queries: {}, ...channel.handlers },
    });
    const caller = pipelineHostCoreCaller('authority');
    const reconcile = {
      action: 'owner.definition.effects',
      op: 'reconcile',
      phase: 'reconcile',
      definitionId: null,
    };
    /** An owner subscription that answers everything it receives. */
    const attach = async (
      received: WorkerPipelineHostRequest[],
    ): Promise<{ close(): void }> =>
      dispatcher.openStream(
        'worker.pipeline.hostRequests',
        { serves: SERVES },
        {
          caller,
          onFrame: (frame) => {
            if (frame.kind !== 'item') return;
            const item = frame.item;
            if (isWorkerPipelineHostWithdrawal(item)) return;
            received.push(item);
            void dispatcher.instruction(
              'worker.pipeline.hostRequest.respond',
              {
                executionId: item.executionId,
                requestId: item.requestId,
                result: applied,
              },
              { caller, metadata: {} },
            );
          },
        },
      );
    const settle = async (
      received: readonly WorkerPipelineHostRequest[],
    ): Promise<void> => {
      for (
        let attempt = 0;
        attempt < 100 && received.length === 0;
        attempt += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
    };
    const first: WorkerPipelineHostRequest[] = [];
    const firstHandle = await attach(first);
    await settle(first);
    expect(first.map((request) => request.request)).toEqual([reconcile]);
    // A second subscription replaces the first: ownerSubscribed() never
    // changes, and the replacement is asked too.
    const second: WorkerPipelineHostRequest[] = [];
    const secondHandle = await attach(second);
    await settle(second);
    expect(second.map((request) => request.request)).toEqual([reconcile]);
    expect(first).toHaveLength(1);
    firstHandle.close();
    secondHandle.close();
    await dispatcher.shutdown();
  });
});

// CAN-7507: a routed create, import or copy raises its owner effect before
// the commit with a key bound to its sender, so the app records the owner it
// registered for the write; only an owner serving effects revision 2 is sent
// the key or an import's effects, and a revision-1 owner keeps today's.
describe('the owner of a routed write before its commit (CAN-7507)', () => {
  const OWNER_KEY = 'a'.repeat(64);
  const curatedImport = {
    remoteDefinitionId: 'curated:release',
    targetScope: {},
    expectedRemoteVersion: null,
    nameOverride: null,
  };

  function keyedService(effectsRevision: number): {
    log: string[];
    requests: WorkerPipelineHostRequest[];
    service: ReturnType<typeof createPipelineDefinitionService>;
    install: { entered?: () => void; pause?: Promise<void> };
  } {
    const log: string[] = [];
    const store = memoryStore(log);
    const install: { entered?: () => void; pause?: Promise<void> } = {};
    const curated: PipelineDefinitionSourcePort = {
      sources: ['curated'],
      list: () => Promise.resolve([]),
      read: () => Promise.resolve(null),
      remote: () =>
        Promise.resolve({
          document: {
            name: 'Curated',
            description: '',
            icon: '',
            format: 'yaml',
            text: SOURCE_TEXT,
          },
          remoteVersion: 'sha256:curated',
          install: async (write) => {
            install.entered?.();
            await install.pause;
            const document = stored(write.definitionId, write.name);
            store.docs.set(write.definitionId, document);
            log.push(`store install ${write.definitionId}`);
            return document;
          },
        }),
    };
    const channel = createPipelineOwnerChannel();
    const requests: WorkerPipelineHostRequest[] = [];
    channel.broker.subscribe(
      (item) => {
        if (isWorkerPipelineHostWithdrawal(item)) return;
        requests.push(item);
        log.push(describeRequest(item));
        queueMicrotask(() =>
          channel.broker.respond(
            item.executionId,
            item.requestId,
            item.request.action === 'owner.definition.precheck'
              ? allowed
              : applied,
          ),
        );
      },
      {
        serves: [
          { kind: 'owner.definition.precheck', revision: 1 },
          { kind: 'owner.definition.effects', revision: effectsRevision },
        ],
      },
    );
    let next = 0;
    const service = createPipelineDefinitionService({
      ports: [store.port, curated],
      writer: store.writer,
      ownerEffects: createDaemonDefinitionOwnerEffects(channel),
      createDefinitionId: () => `imported-${(next += 1)}`,
    });
    return { log, requests, service, install };
  }
  const keyed = (request: WorkerPipelineHostRequest | undefined): unknown =>
    (request?.request as { ownerKey?: string } | undefined)?.ownerKey;

  it('a keyed create has its owner effect raised before the commit, with its key, and no check', async () => {
    const { log, requests, service } = keyedService(2);
    await service.upsert(
      { ...edit(), definitionId: null, expectedRevision: null },
      signal,
      { createId: 'created-2', ownerKey: OWNER_KEY },
    );
    expect(log).toEqual([
      'owner beforeCommit upsert created-2',
      'store upsert created-2',
      'owner afterCommit upsert created-2',
    ]);
    expect(requests.map(keyed)).toEqual([OWNER_KEY, undefined]);
    for (const request of requests)
      expect(WorkerPipelineHostRequestSchema.parse(request)).toEqual(request);
  });

  it("a keyed import has its effects raised around its install, and a copy's check carries its key before the commit", async () => {
    const { log, requests, service } = keyedService(2);
    await service.import(curatedImport, signal, { ownerKey: OWNER_KEY });
    await service.duplicate(
      { sourceDefinitionId: 'source-1', scope: {} },
      signal,
      { createId: 'copy-1', ownerKey: OWNER_KEY },
    );
    expect(log).toEqual([
      'owner beforeCommit import imported-1',
      'store install imported-1',
      'owner afterCommit import imported-1',
      'owner precheck duplicate -',
      'owner beforeCommit duplicate copy-1',
      'store copy copy-1',
      'owner afterCommit duplicate copy-1',
    ]);
    expect(requests.map(keyed)).toEqual([
      OWNER_KEY,
      undefined,
      undefined,
      OWNER_KEY,
      undefined,
    ]);
  });

  it('a revision-1 owner is sent no key, no import effects and no create effect before the commit', async () => {
    const { log, requests, service } = keyedService(1);
    await service.upsert(
      { ...edit(), definitionId: null, expectedRevision: null },
      signal,
      { createId: 'created-3', ownerKey: OWNER_KEY },
    );
    await service.import(curatedImport, signal, { ownerKey: OWNER_KEY });
    await service.duplicate(
      { sourceDefinitionId: 'source-1', scope: {} },
      signal,
      { createId: 'copy-2', ownerKey: OWNER_KEY },
    );
    expect(log).toEqual([
      'store upsert created-3',
      'owner afterCommit upsert created-3',
      'store install imported-1',
      'owner precheck duplicate -',
      'owner beforeCommit duplicate copy-2',
      'store copy copy-2',
      'owner afterCommit duplicate copy-2',
    ]);
    expect(requests.map(keyed)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("the owner key is bound to the sender's client instance and never carries the idempotency key", () => {
    const mine = pipelineDefinitionOwnerKey('desktop-main', 'save-1');
    expect(mine).toMatch(/^[0-9a-f]{64}$/);
    expect(mine).not.toContain('save-1');
    expect(pipelineDefinitionOwnerKey('cli', 'save-1')).not.toBe(mine);
    expect(pipelineDefinitionOwnerKey('desktop-main', 'save-1')).toBe(mine);
  });

  it('a reconcile waits for an import whose owner was recorded and whose install is in flight', async () => {
    const { log, service, install } = keyedService(2);
    let entered = (): void => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = (): void => undefined;
    install.entered = entered;
    install.pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const importing = service.import(curatedImport, signal, {
      ownerKey: OWNER_KEY,
    });
    await inside;
    const reconcile = service.reconcileOwnerEffects(signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log.some((line) => line.includes('reconcile'))).toBe(false);
    release();
    await importing;
    await reconcile;
    expect(log.indexOf('store install imported-1')).toBeLessThan(
      log.findIndex((line) => line.includes('reconcile')),
    );
  });
});

import {
  CanopyClientError,
  createCanopyClient,
  type CanopyClient,
} from '@canopy/core-client';
import { createInMemoryFramedPair } from '@canopy/core-transport';
import { WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS } from '@canopy/protocol/canopy-core';

import {
  CANONICAL_DEFINITIONS,
  CanonicalCoreError,
  canonicalInitializeResult,
  serveCanonicalCore,
} from './fixtures/canonical-core';

// q-22(d): abandoning an entry response is not proof its effect was cancelled.
const entryDefinitions = {
  ...CANONICAL_DEFINITIONS,
  instructions: WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
};
type EntryClient = CanopyClient<
  typeof entryDefinitions.queries,
  typeof entryDefinitions.instructions,
  typeof entryDefinitions.streams
>;
function entryCall(
  client: EntryClient,
  operation: 'delete' | 'copy' | 'move',
  signal: AbortSignal,
): Promise<unknown> {
  const scope = { workspaceId: 'workspace', worktreeId: 'home' };
  const metadata = { idempotencyKey: 'same-key' };
  if (operation === 'delete')
    return client.instruction(
      'worker.filesystem.entry.delete',
      {
        scope,
        fileRootId: 'root',
        relativePath: 'entry',
        expectedVersion: null,
        recursive: false,
        disposition: 'permanent',
        _meta: metadata,
      },
      { signal },
    );
  const common = {
    scope,
    sourceFileRootId: 'root',
    destinationFileRootId: 'root',
    expectedSourceVersion: null,
    conflictPolicy: 'error' as const,
    _meta: metadata,
  };
  return operation === 'copy'
    ? client.instruction(
        'worker.filesystem.entry.copy',
        {
          ...common,
          sourceRelativePath: 'entry',
          destinationRelativePath: 'target',
        },
        { signal },
      )
    : client.instruction(
        'worker.filesystem.entry.move',
        {
          ...common,
          fromRelativePath: 'entry',
          toRelativePath: 'target',
          expectedDestinationAbsent: true,
        },
        { signal },
      );
}

describe.each(['delete', 'copy', 'move'] as const)(
  '%s entry response interruption',
  (operation) => {
    it.each(['abort', 'close'] as const)(
      '%s after dispatch is uncertain and same-key retryable',
      async (interruption) => {
        const pair = await createInMemoryFramedPair();
        let entered!: () => void;
        let release!: () => void;
        const admitted = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const name = `worker.filesystem.entry.${operation}` as const;
        const core = serveCanonicalCore(
          pair.server,
          {
            [name]: async () => {
              entered();
              await held;
              return {};
            },
            'core.test.echo': () => ({ text: 'ok', length: 2 }),
          },
          {
            initialize: canonicalInitializeResult({
              capabilities: {
                operations: [
                  'core.test.echo',
                  ...Object.keys(
                    WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
                  ),
                ],
                events: [],
                streams: [],
              },
            }),
          },
        );
        const client = await createCanopyClient({
          connection: pair.client,
          clientName: 'test',
          clientVersion: '0',
          definitions: entryDefinitions,
        });
        try {
          await expect(
            entryCall(client, operation, AbortSignal.abort()),
          ).rejects.toMatchObject({
            payload: { kind: 'cancelled', retry: { kind: 'never' } },
          });
          expect(core.requests).toHaveLength(1);
          const abort = new AbortController();
          const pending = entryCall(client, operation, abort.signal);
          const refusal = expect(pending).rejects.toMatchObject({
            payload: {
              kind: 'unavailable',
              retry: { kind: 'same_idempotency_key' },
            },
          });
          await Promise.race([admitted, pending]);
          if (interruption === 'abort') abort.abort();
          else await client.close();
          await refusal;
          expect(core.requests[1]?.params._meta).toMatchObject({
            idempotencyKey: 'same-key',
          });
          release();
          if (interruption === 'abort') {
            // Even a malformed late result is ignored; the session stays usable.
            await expect(
              client.query('core.test.echo', { text: 'ok' }),
            ).resolves.toEqual({ text: 'ok', length: 2 });
          }
        } finally {
          release();
          await client.close();
          await core.done;
        }
      },
    );
  },
);

it.each(['delete', 'copy', 'move'] as const)(
  '%s cancelled send after delivery remains uncertain',
  async (operation) => {
    const pair = await createInMemoryFramedPair();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const name = `worker.filesystem.entry.${operation}` as const;
    const core = serveCanonicalCore(
      pair.server,
      {
        [name]: async () => {
          entered();
          await held;
          return {};
        },
        'core.test.echo': () => ({ text: 'ok', length: 2 }),
      },
      {
        initialize: canonicalInitializeResult({
          capabilities: {
            operations: ['core.test.echo', name],
            events: [],
            streams: [],
          },
        }),
      },
    );
    const client = await createCanopyClient({
      connection: {
        connectionId: pair.client.connectionId,
        signal: pair.client.signal,
        receive: (options) => pair.client.receive(options),
        close: (error) => pair.client.close(error),
        openChannel: (request) => pair.client.openChannel(request),
        onChannel: (listener, options) =>
          pair.client.onChannel(listener, options),
        send: async (message, options) => {
          await pair.client.send(message, options);
          if ('method' in message && message.method === name) {
            await admitted;
            throw new CanopyClientError({
              kind: 'cancelled',
              message: 'Send cancelled.',
              retry: { kind: 'never' },
            });
          }
        },
      },
      clientName: 'test',
      clientVersion: '0',
      definitions: entryDefinitions,
    });
    try {
      await expect(
        entryCall(client, operation, new AbortController().signal),
      ).rejects.toMatchObject({
        payload: {
          kind: 'unavailable',
          retry: { kind: 'same_idempotency_key' },
        },
      });
      release();
      await expect(
        client.query('core.test.echo', { text: 'ok' }),
      ).resolves.toEqual({ text: 'ok', length: 2 });
    } finally {
      release();
      await client.close();
      await core.done;
    }
  },
);

const entryResults = {
  delete: { deleted: true, deletedEntryCount: 1, disposition: 'permanent' },
  copy: {
    sourceFileRootId: 'root',
    sourceRelativePath: 'entry',
    destinationFileRootId: 'root',
    requestedDestinationRelativePath: 'target',
    destinationRelativePath: 'target',
    copiedEntryCount: 1,
    version: 'v1',
  },
  move: {
    sourceFileRootId: 'root',
    fromRelativePath: 'entry',
    destinationFileRootId: 'root',
    requestedToRelativePath: 'target',
    toRelativePath: 'target',
    conflictPolicy: 'error',
    version: 'v1',
  },
} as const;

describe.each(['delete', 'copy', 'move'] as const)(
  '%s settled entry response',
  (operation) => {
    it.each(['success', 'error'] as const)(
      'late abort/close preserves %s and releases the listener',
      async (outcome) => {
        const pair = await createInMemoryFramedPair();
        const name = `worker.filesystem.entry.${operation}` as const;
        const payload = {
          kind: 'permission_denied',
          message: 'Refused.',
          retry: { kind: 'never' },
        } as const;
        const core = serveCanonicalCore(
          pair.server,
          {
            [name]: () => {
              if (outcome === 'error') throw new CanonicalCoreError(payload);
              return entryResults[operation];
            },
            'core.test.echo': () => ({ text: 'ok', length: 2 }),
          },
          {
            initialize: canonicalInitializeResult({
              capabilities: {
                operations: [name, 'core.test.echo'],
                events: [],
                streams: [],
              },
            }),
          },
        );
        const client = await createCanopyClient({
          connection: pair.client,
          clientName: 'test',
          clientVersion: '0',
          definitions: entryDefinitions,
        });
        const abort = new AbortController();
        const added = jest.spyOn(abort.signal, 'addEventListener');
        const removed = jest.spyOn(abort.signal, 'removeEventListener');
        try {
          const pending = entryCall(client, operation, abort.signal);
          if (outcome === 'success')
            await expect(pending).resolves.toEqual(entryResults[operation]);
          else await expect(pending).rejects.toMatchObject({ payload });
          const listener = added.mock.calls.find(
            ([event]) => event === 'abort',
          )?.[1];
          expect(listener).toBeDefined();
          expect(removed).toHaveBeenCalledWith('abort', listener);
          abort.abort();
          // Even a callback already queued before release must be harmless.
          if (typeof listener === 'function')
            listener.call(abort.signal, new Event('abort'));
          else listener?.handleEvent(new Event('abort'));
          await expect(
            client.query('core.test.echo', { text: 'ok' }),
          ).resolves.toEqual({ text: 'ok', length: 2 });
          await client.close();
          if (outcome === 'success')
            await expect(pending).resolves.toEqual(entryResults[operation]);
          else await expect(pending).rejects.toMatchObject({ payload });
        } finally {
          added.mockRestore();
          removed.mockRestore();
          await client.close();
          await core.done;
        }
      },
    );
  },
);

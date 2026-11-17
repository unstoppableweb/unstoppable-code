import { PassThrough, Duplex } from 'node:stream';
import {
  createRuntimeProfileGraph,
  defineRuntimeModule,
} from '@canopy/core-runtime';
import {
  createCanopyObligationRegistry,
  serveCanopyControlStream,
} from '@canopy/core-runtime/node';
import { createCanopyClient } from '@canopy/core-client';
import { createCanopyFramedConnection } from '@canopy/core-transport';
import { CORE_MIGRATION_INSTRUCTION_DEFINITIONS } from '@canopy/protocol/canopy-core';
import type { MigrationWireFrame } from '@canopy/core-runtime/node/vault';

/** Synthetic admitted endpoint over real D3 bytes, schemas and a single-flight dispatcher. */
export async function encodedCopilotEndpoint(
  handler: (
    raw: unknown,
    signal: AbortSignal,
  ) => Promise<{ frames: MigrationWireFrame[] }>,
): Promise<{
  exchange(
    frame: MigrationWireFrame,
    metadata: { deadlineMs: number; signal: AbortSignal },
  ): Promise<{ frames: MigrationWireFrame[] }>;
  close(): Promise<void>;
}> {
  const toCore = new PassThrough();
  const toMain = new PassThrough();
  const iterator = toCore[Symbol.asyncIterator]();
  const stopped = new AbortController();
  const auth = { secret: 'a'.repeat(64), dataRootHash: 'b'.repeat(64) };
  const runtime = createRuntimeProfileGraph({
    profile: 'core',
    identity: {
      authorityId: 'authority',
      runtimeId: 'p7-fixture',
      hostId: 'host',
    },
    modules: [
      defineRuntimeModule({
        name: 'core.vaultMigration',
        plane: 'core',
        definitions: {
          queries: {},
          instructions: CORE_MIGRATION_INSTRUCTION_DEFINITIONS,
          streams: {},
        },
        handlers: {
          queries: {},
          instructions: {
            'core.vaultMigration.exchange': ({ frame }, context) =>
              handler(frame, context.signal),
          },
          streams: {},
        },
      }),
    ],
    principalFor: () => 'migration-launcher',
    phaseDeadlineMs: 5000,
  });
  await runtime.start();
  const serving = serveCanopyControlStream({
    stream: {
      signal: stopped.signal,
      async read(): Promise<Uint8Array | null> {
        const result: IteratorResult<unknown> = await iterator.next();
        if (result.done) return null;
        if (!(result.value instanceof Uint8Array))
          throw new Error('Invalid endpoint bytes.');
        return result.value;
      },
      write: (bytes): Promise<void> =>
        new Promise((resolve, reject) => {
          toMain.write(bytes, (error) => (error ? reject(error) : resolve()));
        }),
      close: (): Promise<void> => {
        toCore.end();
        toMain.end();
        return Promise.resolve();
      },
    },
    auth,
    dispatcher: runtime.dispatcher,
    operations: runtime.operations,
    caller: {
      principalId: 'migration-launcher',
      clientInstanceId: 'synthetic-channel',
      authorityId: 'authority',
      interfaceKind: 'daemon',
      grants: ['core.runtime.read', 'core.vaultMigration.import'],
    },
    obligations: createCanopyObligationRegistry(),
    buildVersion: '1',
    maxActiveRequests: 1,
  });
  const connection = await createCanopyFramedConnection(
    Duplex.from({ readable: toMain, writable: toCore }),
    { role: 'client', auth },
  );
  const client = await createCanopyClient({
    connection,
    clientName: 'p7-synthetic-launcher',
    clientVersion: '1',
    definitions: {
      queries: {},
      instructions: CORE_MIGRATION_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
  });
  return {
    exchange: (frame, metadata) =>
      client.instruction(
        'core.vaultMigration.exchange',
        { frame },
        {
          metadata: { deadlineAt: new Date(metadata.deadlineMs).toISOString() },
          signal: metadata.signal,
        },
      ),
    async close() {
      await client.close();
      stopped.abort();
      await serving.close();
      await serving.done;
      await runtime.shutdown('qualification endpoint closed');
    },
  };
}

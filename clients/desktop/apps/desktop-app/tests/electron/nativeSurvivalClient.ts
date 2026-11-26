import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { require as tsRequire } from 'tsx/cjs/api';
import type * as NodeClient from '@canopy/core-client/node';
import type * as Client from '@canopy/core-client';
import type * as Runtime from '@canopy/core-runtime';
import type * as Protocol from '@canopy/protocol/canopy-core';

interface ObserverModuleLoader {
  (id: '@canopy/core-client/node', from: string): typeof NodeClient;
  (id: '@canopy/core-client', from: string): typeof Client;
  (id: '@canopy/core-runtime', from: string): typeof Runtime;
  (id: '@canopy/protocol/canopy-core', from: string): typeof Protocol;
}

// Literal IDs tie this trusted test-only loader to the modules' declared exports.
const loadObserverModule: ObserverModuleLoader = tsRequire;

interface ObserverDefinitions {
  queries: typeof Runtime.CANOPY_RUNTIME_QUERY_DEFINITIONS &
    typeof Protocol.WORKER_PIPELINE_QUERY_DEFINITIONS &
    typeof Protocol.CORE_CLOUD_ACCOUNT_CUSTODY_QUERY_DEFINITIONS;
  instructions: typeof Protocol.CORE_TRANSPORT_INSTRUCTION_DEFINITIONS &
    Pick<
      typeof Protocol.WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
      'worker.pipeline.execution.cancel'
    > &
    typeof Protocol.CORE_CLOUD_ACCOUNT_CUSTODY_INSTRUCTION_DEFINITIONS &
    Pick<
      typeof Protocol.CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS,
      | 'core.integration.cloudAccount.connectWithKey'
      | 'core.integration.cloudAccount.disconnect'
    >;
  streams: typeof Protocol.WORKER_PIPELINE_STREAM_DEFINITIONS;
}

interface NativeObserver {
  readonly client: Client.CanopyClient<
    ObserverDefinitions['queries'],
    ObserverDefinitions['instructions'],
    ObserverDefinitions['streams']
  >;
  readonly identity: { readonly pid: number; readonly build: string };
  close(): Promise<void>;
}

/** Ordinary public client. No owner-settlement proof, configure or respond API. */
export async function openNativeObserver(
  dataRoot: string,
): Promise<NativeObserver> {
  // Keep the workspace TS imports in tsx's CommonJS graph, not a second
  // Node ESM graph. Nothing loads that graph while a lane collects its specs.
  const { connectCanopyClient, parseCanopyRuntimeDescriptor } =
    loadObserverModule('@canopy/core-client/node', import.meta.url);
  const { createCanopyClientLease } = loadObserverModule(
    '@canopy/core-client',
    import.meta.url,
  );
  const protocol = loadObserverModule(
    '@canopy/protocol/canopy-core',
    import.meta.url,
  );
  const runtime = loadObserverModule('@canopy/core-runtime', import.meta.url);
  const definitions: ObserverDefinitions = {
    queries: {
      ...runtime.CANOPY_RUNTIME_QUERY_DEFINITIONS,
      ...protocol.WORKER_PIPELINE_QUERY_DEFINITIONS,
      ...protocol.CORE_CLOUD_ACCOUNT_CUSTODY_QUERY_DEFINITIONS,
    },
    instructions: {
      ...protocol.CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
      ...protocol.CORE_CLOUD_ACCOUNT_CUSTODY_INSTRUCTION_DEFINITIONS,
      'core.integration.cloudAccount.connectWithKey':
        protocol.CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS[
          'core.integration.cloudAccount.connectWithKey'
        ],
      'core.integration.cloudAccount.disconnect':
        protocol.CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS[
          'core.integration.cloudAccount.disconnect'
        ],
      'worker.pipeline.execution.cancel':
        protocol.WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
          'worker.pipeline.execution.cancel'
        ],
    },
    streams: protocol.WORKER_PIPELINE_STREAM_DEFINITIONS,
  };
  const root = await realpath(dataRoot);
  const descriptor = parseCanopyRuntimeDescriptor(
    JSON.parse(await readFile(join(root, 'runtime/core.json'), 'utf8')),
  );
  if (!descriptor) throw new Error('Daemon has no valid public descriptor');
  const client = await connectCanopyClient({
    endpoint: {
      ...descriptor.endpoint,
      auth: {
        secret: await readFile(descriptor.tokenRef, 'utf8'),
        dataRootHash: createHash('sha256').update(root).digest('hex'),
      },
    },
    timeoutMs: 15_000,
    clientName: 'native-survival-observer',
    clientVersion: '1',
    definitions,
  });
  const lease = createCanopyClientLease({
    client,
    attach: () => Promise.reject(new Error('Workflow observer disconnected')),
    identity: {
      clientInstanceId: randomUUID(),
      interfaceKind: 'cli',
      label: 'Workflow observer',
    },
    renewalIntervalMs: 5000,
    presence: () => ({ foreground: false, interactive: false }),
  });
  try {
    await lease.acquire();
    return {
      client,
      identity: { pid: descriptor.pid, build: descriptor.buildVersion },
      async close(): Promise<void> {
        try {
          await lease.release('normal_shutdown');
        } finally {
          await client.close();
        }
      },
    };
  } catch (error) {
    try {
      await lease.release('normal_shutdown');
    } finally {
      await client.close();
    }
    throw error;
  }
}

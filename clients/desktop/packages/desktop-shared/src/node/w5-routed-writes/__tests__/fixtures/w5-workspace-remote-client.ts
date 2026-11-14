import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { connectCanopyClient } from '@canopy/core-client/node';
import {
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import { createScopedW5RoutedRecordStore } from '../../record-store';
import { createRoutedCliWorkspace } from '../../workspace-create';
import { getWorkspaceItem } from '../../../lib/workspace-cli-reads';
import { serviceRecordTransport } from './w5-service-adapter';
import { W5_RECORD_TEST_AUTH } from './w5-daemon-record-harness';

async function main(): Promise<void> {
  const [endpoint, remoteUrl, destinationDir, dataRoot] = process.argv.slice(2);
  if (!endpoint || !remoteUrl || !destinationDir || !dataRoot)
    throw new Error('Missing remote golden inputs');
  const client = await connectCanopyClient({
    endpoint: { kind: 'socket', path: endpoint, auth: W5_RECORD_TEST_AUTH },
    clientName: 'remote-golden',
    clientVersion: '1',
    definitions: {
      queries: {
        ...CORE_TRANSPORT_QUERY_DEFINITIONS,
        ...CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
      },
      instructions: {
        ...CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
        ...CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
      },
      streams: {},
    },
  });
  const opened = createScopedW5RoutedRecordStore({
    root: join(dataRoot, 'workspaces'),
    transport: serviceRecordTransport(client),
    warn: () => undefined,
  });
  try {
    await client.instruction('core.client.lease.acquire', {
      clientInstanceId: 'cli-subprocess',
      interfaceKind: 'cli',
      label: 'remote-golden',
      interactive: false,
      foreground: false,
      renewalIntervalMs: 300000,
      _meta: { idempotencyKey: randomUUID() },
    });
    await opened.run(async (store) => {
      const record = await createRoutedCliWorkspace(
        { kind: 'remote', remoteUrl, destinationDir },
        {
          store,
          idempotencyKey: randomUUID(),
          signal: new AbortController().signal,
        },
      );
      const workspace = await getWorkspaceItem(record.id, store);
      process.stdout.write(JSON.stringify(workspace));
    });
  } finally {
    opened.close();
    await client.close();
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});

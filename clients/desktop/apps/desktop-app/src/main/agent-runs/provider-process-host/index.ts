import type { ProviderProcessSpawner } from '@canopy/desktop-shared/node/provider-process/spawn';
import { getExecutionHostPort } from '../../execution-host/utility-process-host';
import { createProviderProcessHostClient } from '@canopy/execution-engine/node/agent-host/process/provider-process-host/runner';

/*
 * Electron main's provider spawner (CAN-4118): every provider CLI child is a
 * child of the provider process host, never of Electron main.
 */
const client = createProviderProcessHostClient(() => getExecutionHostPort());

export const spawnProviderProcess: ProviderProcessSpawner = (request) =>
  client.spawn(request);

export function shutdownProviderProcessHost(): Promise<void> {
  return client.shutdown();
}

export function resetProviderProcessHostForTests(): Promise<void> {
  return client.shutdown();
}

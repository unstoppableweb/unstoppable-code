import { isBotProjectId } from '@canopy/protocol/chat-targets';

/** Pins name saved local projects, never app-managed Bot workspaces. */
export async function savedLocalProjectExists(
  projectId: string,
): Promise<boolean> {
  if (isBotProjectId(projectId)) return false;
  const { getWorkspaceIndexRepository } = await import('../lib/sidebar-items');
  const index = await getWorkspaceIndexRepository().read();
  if (index.authority === 'unreadable' || index.authority === 'partial') {
    throw new Error('Saved project inventory could not be read.');
  }
  return (
    index.authority === 'ok' &&
    index.entries.some((entry) => entry.id === projectId)
  );
}

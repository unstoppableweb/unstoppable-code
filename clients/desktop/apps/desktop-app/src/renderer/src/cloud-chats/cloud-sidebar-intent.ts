import { isWebCoreScope } from '@/lib/chat-authority';

/**
 * Whether a sidebar row's hover or focus may warm the local chat store. A
 * cloud row never does: its ids name the web core, so a local prefetch would
 * send them to local stores and IPC (CAN-4185 D6).
 */
export function shouldPrefetchWorktreeChat(
  projectId: string,
  worktreeId: string,
  cloudWorktreeKeys: ReadonlySet<string>,
): boolean {
  return (
    !isWebCoreScope(projectId) &&
    !cloudWorktreeKeys.has(`${projectId}/${worktreeId}`)
  );
}

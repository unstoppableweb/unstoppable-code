/**
 * Extracts the originating thread id from an approval-shaped Codex
 * app-server request's `params`. v2 approval methods (`item/commandExecution/
 * requestApproval`, `item/fileChange/requestApproval`, etc.) and
 * `item/tool/requestUserInput` carry it under `threadId`; the legacy
 * `execCommandApproval` / `applyPatchApproval` pair carries it under
 * `conversationId` instead.
 *
 * Shared by the connection's approval routing and the desktop app-server
 * client's approval display attribution so both extraction sites stay in
 * sync.
 */
export function extractApprovalThreadId(
  params: Record<string, unknown> | null,
): string | undefined {
  if (!params) {
    return undefined;
  }
  const threadId = params.threadId;
  if (typeof threadId === 'string') {
    return threadId;
  }
  const conversationId = params.conversationId;
  return typeof conversationId === 'string' ? conversationId : undefined;
}

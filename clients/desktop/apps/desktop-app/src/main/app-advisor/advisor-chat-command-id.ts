import { createHash } from 'node:crypto';

/**
 * The core.chat.* command id of an Orchestrator write keyed by
 * `idempotencyKey`. The key names the Orchestrator chat and the provider's
 * tool call, but command ids are safe ids (lowercase letters, digits and
 * hyphens), so the id is the whole key's digest: a retried call keeps its
 * command, and every other call, chat or write gets its own (CAN-7221).
 */
export function advisorChatCommandId(idempotencyKey: string): string {
  return `app-advisor-action-${createHash('sha256')
    .update(idempotencyKey)
    .digest('hex')
    .slice(0, 40)}`;
}

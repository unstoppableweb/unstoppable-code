/**
 * Identity for chats served by the web core (CAN-4185 D6, CAN-6175 D1). Every
 * cloud id carries its authority, and no local id starts with its prefix, so
 * a cloud chat, task or file can never be mistaken for, or sent as, a local
 * one. The prefix is the web core's authority qualifier from
 * `@canopy/protocol/authority-qualified-id` (CAN-7757), which also qualifies
 * paired computers' ids. The renderer reads it through `lib/chat-authority`,
 * and the preload, which keeps cloud ids off main's local IPC, reads it here.
 */
import {
  WEB_CORE_AUTHORITY_ID,
  parseAuthorityQualifiedId,
} from '@canopy/protocol/authority-qualified-id';

/**
 * The scope for a web core chat id. It never throws: an id the web core sent
 * that could not be read back simply names no web core chat.
 */
export function webCoreScopeId(localId: string): string {
  return `${WEB_CORE_AUTHORITY_ID}:${localId}`;
}

/** The web core chat id a scope names, or null for any other scope. */
export function webCoreLocalId(scopeId: string): string | null {
  const parsed = parseAuthorityQualifiedId(scopeId);
  return parsed?.authority.kind === 'web-core' ? parsed.localId : null;
}

/** Whether either id of a scope is a web core one, which no local IPC resolves. */
export function isWebCoreTarget(scope: {
  readonly projectId: string;
  readonly worktreeId: string;
}): boolean {
  return (
    webCoreLocalId(scope.projectId) !== null ||
    webCoreLocalId(scope.worktreeId) !== null
  );
}

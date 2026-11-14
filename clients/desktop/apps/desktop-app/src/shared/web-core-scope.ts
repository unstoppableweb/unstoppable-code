import type { CanopyCoreRelayAuthority } from './canopy-core-relay';

/**
 * Identity for chats served by the web core (CAN-4185 D6, CAN-6175 D1). Every
 * cloud id carries its authority, and no local id starts with this prefix,
 * so a cloud chat, task or file can never be mistaken for, or sent as, a
 * local one. This module is the only reader of the prefix: the renderer
 * reads it through `lib/chat-authority`, and the preload, which keeps cloud
 * ids off main's local IPC, reads it here.
 */
const AUTHORITY: CanopyCoreRelayAuthority = 'web-core';
const PREFIX = `${AUTHORITY}:`;

/** The scope for a web core chat id. */
export function webCoreScopeId(localId: string): string {
  return `${PREFIX}${localId}`;
}

/** The web core chat id a scope names, or null for any other scope. */
export function webCoreLocalId(scopeId: string): string | null {
  if (!scopeId.startsWith(PREFIX)) return null;
  const localId = scopeId.slice(PREFIX.length);
  return localId.length > 0 && !/[:/]/.test(localId) ? localId : null;
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

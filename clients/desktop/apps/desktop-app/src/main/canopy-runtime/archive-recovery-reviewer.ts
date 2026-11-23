import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  REMOTE_BRIDGE_CLIENT_INSTANCE_PREFIX,
  REMOTE_DEVICE_PRINCIPAL_PREFIX,
} from './desktop-ipc-caller';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

export interface ArchiveRecoveryReviewerOptions {
  /** Also accept the local user on the portal interface (the core adapter's rule). */
  readonly portal?: boolean;
}

function hasNonEmptySuffix(value: string, prefix: string): boolean {
  return value.startsWith(prefix) && value.length > prefix.length;
}

/**
 * CAN-7444: who may resolve or finish an archive recovery entry. Exactly two
 * callers review one: the local desktop user, and a paired controller acting
 * through the remote-control bridge. The bridge is told apart by its
 * `remote-bridge:` client instance id, which only the bridge caller derivation
 * mints; the remote core session and hosted chat callers share the
 * `remote-device:` principal but not that id, so they stay refused, as do
 * agents, MCP callers and renderer relay principals.
 *
 * The bridge caller is the same for every controller kind, so this admits
 * desktop, browser, mobile and hosted bridge calls alike. The controller
 * profile channel lists are what keep mobile and hosted controllers out.
 */
export function isArchiveRecoveryReviewer(
  caller: CanopyCallerDescriptor,
  options: ArchiveRecoveryReviewerOptions = {},
): boolean {
  if (caller.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID) return false;
  if (caller.principalId === 'local-desktop-user')
    return (
      caller.interfaceKind === 'desktop' ||
      (options.portal === true && caller.interfaceKind === 'portal')
    );
  return (
    caller.interfaceKind === 'desktop' &&
    hasNonEmptySuffix(caller.principalId, REMOTE_DEVICE_PRINCIPAL_PREFIX) &&
    hasNonEmptySuffix(
      caller.clientInstanceId,
      REMOTE_BRIDGE_CLIENT_INSTANCE_PREFIX,
    )
  );
}

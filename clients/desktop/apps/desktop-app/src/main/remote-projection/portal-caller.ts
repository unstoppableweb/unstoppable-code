import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';

export function createPortalCaller(
  session: { sessionId: string },
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: `portal-session:${session.sessionId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'portal',
    grants,
  };
}

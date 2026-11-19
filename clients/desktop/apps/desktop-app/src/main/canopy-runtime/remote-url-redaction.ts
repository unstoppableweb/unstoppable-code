import {
  gitRemoteEndpoint,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

const LOCAL_WINDOW_INSTANCE_PREFIX = 'electron-web-contents:';

/**
 * The caller trusted main derives for one of its own tracked windows
 * (desktop-ipc-caller.ts). A paired controller arrives through the remote
 * bridge under its own principal and is not one; nor is any other caller.
 */
export function isLocalDesktopWindowCaller(
  caller: CanopyCallerDescriptor,
): boolean {
  return (
    caller.principalId === 'local-desktop-user' &&
    caller.interfaceKind === 'desktop' &&
    caller.authorityId === LOCAL_DESKTOP_AUTHORITY_ID &&
    caller.clientInstanceId.startsWith(LOCAL_WINDOW_INSTANCE_PREFIX)
  );
}

/**
 * The origin URL `caller` may see (CAN-7017). The local window keeps the URL
 * as Git printed it. Every other caller gets what `worker.git.remote.get`
 * answers: a network URL without the userinfo that can carry a token, and no
 * URL for a local remote, whose path names this host's filesystem.
 */
export function remoteUrlForCaller(
  caller: CanopyCallerDescriptor,
  remoteUrl: string | null,
): string | null {
  if (remoteUrl === null || isLocalDesktopWindowCaller(caller))
    return remoteUrl;
  const endpoint = gitRemoteEndpoint(remoteUrl.trim());
  return endpoint.kind === 'network' ? endpoint.url : null;
}

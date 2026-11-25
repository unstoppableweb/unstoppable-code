/**
 * Channel-level IPC transport shared by the portable CanopyClient adapter
 * (`@canopy/ipc-canopy-client`) and the hosts that carry it: the desktop
 * preload bridge, the browser direct-control worker and hosted MCP sessions
 * (`@canopy/remote-session`).
 *
 * - `invoke` resolves with the host handler's result or rejects with the
 *   host's error. A transport never replays an invoke after a disconnect: one
 *   in flight when the connection drops rejects with
 *   {@link RemoteTransportDisconnectedError}, and its outcome is unknown.
 * - `send` is fire-and-forget. While disconnected it is dropped, not queued.
 * - `on` adds a push listener for one channel. The returned function removes
 *   it and may be called more than once. Listeners stay registered across a
 *   reconnect; the owner resubscribes host-side interest itself.
 */
export interface RemoteIpcTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (...args: unknown[]) => void): () => void;
}

/** Remote Control's browser catalog Add can opt into invoke-envelope metadata. */
export interface BrowserRemoteIpcTransport extends RemoteIpcTransport {
  invokeWithInstallRefreshToken?(
    channel: string,
    args: readonly unknown[],
    installRefreshToken: string,
  ): Promise<unknown>;
}

export const REMOTE_TRANSPORT_DISCONNECTED_CODE =
  'remote_transport_disconnected';

/**
 * The connection dropped before a call finished. The host may or may not have
 * run it, so callers must not retry a mutation automatically.
 */
export class RemoteTransportDisconnectedError extends Error {
  readonly code = REMOTE_TRANSPORT_DISCONNECTED_CODE;
  readonly outcome = 'unknown';
  constructor(channel: string) {
    super(`The connection closed before "${channel}" finished.`);
    this.name = 'RemoteTransportDisconnectedError';
  }
}

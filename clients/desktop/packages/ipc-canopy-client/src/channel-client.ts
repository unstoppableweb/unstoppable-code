import { OPERATION_UNSUPPORTED_CODE, type Unsubscribe } from '@canopy/app-core';
import { restoreIpcRejection } from '@canopy/protocol/app-errors/ipc-rejection';
import type { RemoteIpcChannel } from '@canopy/protocol/remote-control/channels';
import type { RemoteIpcTransport } from '@canopy/protocol/remote-control';

/** Accepts a reply or push payload of the expected shape. */
export type Decoder<T> = (value: unknown) => value is T;

export const REMOTE_IPC_UNAUTHORIZED_CODE = 'remote_ipc_channel_unauthorized';
export const REMOTE_IPC_MALFORMED_REPLY_CODE = 'remote_ipc_malformed_reply';
export { OPERATION_UNSUPPORTED_CODE };

/**
 * This controller may not use the channel. Raised before anything reaches the
 * transport, so nothing ran on the host.
 */
export class RemoteIpcChannelUnauthorizedError extends Error {
  readonly code = REMOTE_IPC_UNAUTHORIZED_CODE;
  constructor(readonly channel: string) {
    super(`This connection can't use "${channel}".`);
    this.name = 'RemoteIpcChannelUnauthorizedError';
  }
}

/**
 * The host answered with a reply of the wrong shape (for example an older
 * host without the operation). The call ran; its result is unusable.
 */
export class RemoteIpcMalformedReplyError extends Error {
  readonly code = REMOTE_IPC_MALFORMED_REPLY_CODE;
  constructor(readonly channel: string) {
    super(`Malformed reply on ${channel}`);
    this.name = 'RemoteIpcMalformedReplyError';
  }
}

/** The adapter has no mapping for this operation on this transport. */
export class UnsupportedOperationError extends Error {
  readonly code = OPERATION_UNSUPPORTED_CODE;
  constructor(
    readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedOperationError';
  }
}

/** Typed channel calls over a {@link RemoteIpcTransport}. */
export interface ChannelClient {
  /** Invoke and decode the reply; a wrong shape rejects. */
  invoke<T>(
    channel: RemoteIpcChannel,
    decode: Decoder<T>,
    ...args: unknown[]
  ): Promise<T>;
  /** Invoke for its effect; the reply is ignored. */
  invokeVoid(channel: RemoteIpcChannel, ...args: unknown[]): Promise<void>;
  /**
   * Listen for pushes. Payloads `accept` rejects are dropped, as the desktop
   * preload drops them. The returned function is idempotent.
   */
  listen<T>(
    channel: RemoteIpcChannel,
    accept: Decoder<T>,
    listener: (payload: T) => void,
  ): Unsubscribe;
}

export interface ChannelClientOptions {
  /**
   * Channels this controller may use. When set, any other channel rejects
   * (invoke) or throws (listen) with {@link RemoteIpcChannelUnauthorizedError}
   * before reaching the transport. Absent means the transport's own policy
   * applies (the desktop preload's channel allowlist).
   */
  readonly authorizedChannels?: ReadonlySet<string>;
}

/**
 * Every invoke rejection passes through {@link restoreIpcRejection}, the
 * portable half of the desktop preload's `restoreIpcAppError`: an app-error
 * carrier becomes the legacy `Error invoking remote method …` error, so
 * shared UI sees the same messages on every transport. It is idempotent, so a
 * transport that already restored composes with it.
 */
export function createChannelClient(
  transport: RemoteIpcTransport,
  options: ChannelClientOptions = {},
): ChannelClient {
  const authorize = (channel: string): void => {
    if (
      options.authorizedChannels !== undefined &&
      !options.authorizedChannels.has(channel)
    ) {
      throw new RemoteIpcChannelUnauthorizedError(channel);
    }
  };
  const call = async (
    channel: RemoteIpcChannel,
    args: readonly unknown[],
  ): Promise<unknown> => {
    authorize(channel);
    try {
      return await transport.invoke(channel, ...args);
    } catch (error) {
      return restoreIpcRejection(error);
    }
  };
  return {
    async invoke<T>(
      channel: RemoteIpcChannel,
      decode: Decoder<T>,
      ...args: unknown[]
    ): Promise<T> {
      const reply = await call(channel, args);
      if (!decode(reply)) throw new RemoteIpcMalformedReplyError(channel);
      return reply;
    },
    async invokeVoid(
      channel: RemoteIpcChannel,
      ...args: unknown[]
    ): Promise<void> {
      await call(channel, args);
    },
    listen<T>(
      channel: RemoteIpcChannel,
      accept: Decoder<T>,
      listener: (payload: T) => void,
    ): Unsubscribe {
      authorize(channel);
      const remove = transport.on(channel, (payload: unknown): void => {
        if (accept(payload)) listener(payload);
      });
      let active = true;
      return (): void => {
        if (!active) return;
        active = false;
        remove();
      };
    },
  };
}

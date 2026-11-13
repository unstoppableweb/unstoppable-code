import type { CanopyClientStreamHandle } from '@canopy/core-client';
import type { CanopyStreamCursor } from '@canopy/protocol/canopy-core';

/**
 * A stream's items, each acknowledged as it arrives. The web core holds only
 * a few unacknowledged requests per subscription (eight for reach-back), so
 * without the ack the stream stays open but stops delivering. Each ack names
 * the subscription the frame came on, so a reconnect's new subscription
 * starts its own credit.
 */
export async function* acknowledgedItems<Item>(
  stream: Pick<
    CanopyClientStreamHandle<Item, unknown>,
    'frames' | 'openResult'
  >,
  ack: (params: {
    subscriptionId: string;
    cursor: CanopyStreamCursor;
  }) => Promise<unknown>,
): AsyncGenerator<Item> {
  for await (const frame of stream.frames) {
    if (frame.kind === 'end') return;
    await ack({
      subscriptionId: stream.openResult.subscriptionId,
      cursor: frame.cursor,
    });
    yield frame.item;
  }
}

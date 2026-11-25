// Browser-safe: no Node or host dependencies.
import type { CanopyJsonRpcNotification } from '@canopy/protocol/canopy-core';

import { STREAM_BUDGET_BYTES, encodedSize } from './stream-budget';

/**
 * Bounded by encoded bytes, not frame count: a frame can be anything up to the
 * inbound frame cap, so only bytes bound what is held. The cap is one stream's
 * own budget, which a registered stream would refuse past anyway. It is not
 * charged to the connection budget: frames are held only while an open waits.
 */
export const MAX_PENDING_FRAME_BYTES = STREAM_BUDGET_BYTES;

/** One stream open awaiting its reply. */
export interface PendingOpen {
  /** Frames were discarded while it waited; it cannot be delivered gap-free. */
  overflowed: boolean;
}

/**
 * Frames that reach a connection before the open reply naming their
 * subscription. The POST plus SSE binding carries replies and frames on two
 * legs, so they race; an in-order socket only ever holds frames no open will
 * claim. The session drops a locally ended stream's frames before they get
 * here. Frames are held only while an open is pending and dropped once none
 * is, so an error reply drops them.
 */
export class PendingFrames {
  private readonly opens = new Set<PendingOpen>();
  private readonly held = new Map<
    string,
    { message: CanopyJsonRpcNotification; bytes: number }[]
  >();
  private bytes = 0;

  begin(): PendingOpen {
    const open = { overflowed: false };
    this.opens.add(open);
    return open;
  }

  /** Ends `open`'s wait and takes the frames held for its subscription. */
  settle(
    open: PendingOpen,
    subscriptionId?: string,
  ): CanopyJsonRpcNotification[] {
    if (!this.opens.delete(open)) return [];
    const frames =
      subscriptionId === undefined ? [] : this.take(subscriptionId);
    if (this.opens.size === 0) this.clear();
    return frames;
  }

  /**
   * Holds a frame for an unregistered subscription while any open waits;
   * false when none waits, so no open could claim it.
   */
  hold(subscriptionId: string, message: CanopyJsonRpcNotification): boolean {
    if (this.opens.size === 0) return false;
    const bytes = encodedSize(message);
    if (this.bytes + bytes > MAX_PENDING_FRAME_BYTES) {
      // The lost frame belongs to an open waiting now (a later open's frames
      // follow its request), so each of them ends instead of skipping it.
      // shortcut: frames that outran an abandoned open's late reply, or of
      // an orphan the session forgot, also count here and can end a waiting
      // open needlessly (it resumes from its cursor); upgrade if that is seen.
      this.opens.forEach((open) => {
        open.overflowed = true;
      });
      this.clear();
      return true;
    }
    this.bytes += bytes;
    const frames = this.held.get(subscriptionId);
    if (frames) frames.push({ message, bytes });
    else this.held.set(subscriptionId, [{ message, bytes }]);
    return true;
  }

  clear(): void {
    this.held.clear();
    this.bytes = 0;
  }

  private take(subscriptionId: string): CanopyJsonRpcNotification[] {
    const frames = this.held.get(subscriptionId) ?? [];
    this.held.delete(subscriptionId);
    return frames.map(({ message, bytes }) => {
      this.bytes -= bytes;
      return message;
    });
  }
}

import {
  readRemoteControlChatPartVisual,
  type RemoteControlChatPart,
} from '@canopy/protocol/remote-control/shell';

/**
 * Tolerate older or malformed Portal parts; only a complete visual reference
 * counts, because a Portal read needs every field of it.
 */
export function remoteControlPartHasVisual(
  part: RemoteControlChatPart,
): boolean {
  return readRemoteControlChatPartVisual(part) !== null;
}

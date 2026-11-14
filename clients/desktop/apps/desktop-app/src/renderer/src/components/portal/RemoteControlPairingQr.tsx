import type { JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { Surface } from '@canopy/ui-shared/components';

/** A transparent pixel: the tile's stand-in while the code is drawn. */
const PLACEHOLDER_SRC =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * The pairing link as a QR code a phone's camera opens (CAN-5985 A2). The
 * dialog's subtitle says what to do with it. The link authorizes a pairing,
 * so session replay never records the code.
 *
 * The tile is white in both color modes: a QR code inverted by a dark surface
 * is unreliable for phone cameras (same rule as `MobileAppQrPromo`).
 *
 * Once the link expires, `expired` draws a blank `group` surface of the same
 * size and corners, whatever `qrSrc` is, so the dialog keeps its layout and a
 * stale code is never shown. It holds no code, so it needs no replay block
 * class.
 */
export function RemoteControlPairingQr({
  qrSrc,
  expired = false,
}: {
  /**
   * Null while the code is still being drawn: an empty image keeps the
   * tile's space, and a surrounding `Skeleton` draws it as one block.
   */
  qrSrc: string | null;
  /** The link expired: draw the blank tile in the code's place. */
  expired?: boolean;
}): JSX.Element {
  if (expired) {
    return (
      <div aria-hidden="true" className="h-44 w-44">
        <Surface variant="group" extent="parent" />
      </div>
    );
  }
  if (qrSrc === null) {
    return (
      <img
        src={PLACEHOLDER_SRC}
        alt=""
        aria-hidden="true"
        className="h-44 w-44"
        draggable={false}
      />
    );
  }
  return (
    <div
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} rounded-lg bg-white p-2`}
      data-testid="remote-control-pairing-qr"
    >
      <img
        src={qrSrc}
        alt={`QR code to pair a device with ${REMOTE_CONTROL_LABEL}`}
        className="h-40 w-40"
        draggable={false}
        data-testid="remote-control-pairing-qr-image"
      />
    </div>
  );
}

import type { IpcMainInvokeEvent, WebContents } from 'electron';
import {
  IPC_CHANNELS,
  type OverlayLayerFocusRequest,
  type OverlayLayerSetBoundsRequest,
} from '@canopy/desktop-shared/types';
import { isOverlayLayerSlot } from '@canopy/desktop-shared/lib/overlay-layer';
import { registerIpcHandler } from './register';

const INVALID_REQUEST = 'Invalid overlay layer request.';
const INVALID_SENDER =
  'Overlay layer IPC requires a live renderer that hosts Browser views.';

export interface OverlayLayerHandlerAccessors {
  /**
   * Whether `contents` is a trusted renderer that may drive its own layers:
   * the main renderer, or the Orchestrator page in its full window.
   */
  isOverlayLayerOpener: (contents: WebContents) => boolean;
  overlayLayerHost: {
    setBounds(opener: WebContents, request: OverlayLayerSetBoundsRequest): void;
    focus(opener: WebContents, request: OverlayLayerFocusRequest): void;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  );
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseSetBoundsRequest(request: unknown): OverlayLayerSetBoundsRequest {
  if (!isPlainObject(request) || !hasExactlyKeys(request, ['slot', 'bounds']))
    throw new Error(INVALID_REQUEST);

  const slot = request.slot;
  if (!isOverlayLayerSlot(slot)) throw new Error(INVALID_REQUEST);

  const bounds = request.bounds;
  if (bounds === null) return { slot, bounds: null };
  if (
    !isPlainObject(bounds) ||
    !hasExactlyKeys(bounds, ['x', 'y', 'width', 'height'])
  )
    throw new Error(INVALID_REQUEST);

  const { x, y, width, height } = bounds;
  if (
    !isFiniteNonNegative(x) ||
    !isFiniteNonNegative(y) ||
    !isFiniteNonNegative(width) ||
    !isFiniteNonNegative(height)
  )
    throw new Error(INVALID_REQUEST);

  return { slot, bounds: { x, y, width, height } };
}

function parseFocusRequest(request: unknown): OverlayLayerFocusRequest {
  if (!isPlainObject(request) || !hasExactlyKeys(request, ['slot', 'target']))
    throw new Error(INVALID_REQUEST);

  const slot = request.slot;
  const target = request.target;
  if (!isOverlayLayerSlot(slot) || (target !== 'layer' && target !== 'main'))
    throw new Error(INVALID_REQUEST);

  return { slot, target };
}

function assertOpenerSender(
  event: IpcMainInvokeEvent,
  accessors: OverlayLayerHandlerAccessors,
): WebContents {
  const { sender } = event;
  if (
    sender.isDestroyed() ||
    event.senderFrame !== sender.mainFrame ||
    !accessors.isOverlayLayerOpener(sender)
  )
    throw new Error(INVALID_SENDER);
  return sender;
}

export function registerOverlayLayerHandlers(
  accessors: OverlayLayerHandlerAccessors,
): void {
  registerIpcHandler<[request: unknown], void>(
    IPC_CHANNELS.overlayLayerSetBounds,
    (event, request): void => {
      const opener = assertOpenerSender(event, accessors);
      accessors.overlayLayerHost.setBounds(
        opener,
        parseSetBoundsRequest(request),
      );
    },
  );

  registerIpcHandler<[request: unknown], void>(
    IPC_CHANNELS.overlayLayerFocus,
    (event, request): void => {
      const opener = assertOpenerSender(event, accessors);
      accessors.overlayLayerHost.focus(opener, parseFocusRequest(request));
    },
  );
}

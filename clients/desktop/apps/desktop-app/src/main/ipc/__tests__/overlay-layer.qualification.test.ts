import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerOverlayLayerHandlers } from '../overlay-layer';

type Handler = (event: unknown, request: unknown) => void;
const mockHandlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    mockHandlers.set(channel, handler);
  },
}));

interface Opener {
  id: number;
  mainFrame: object;
  isDestroyed: () => boolean;
}

function opener(id: number): Opener {
  return { id, mainFrame: {}, isDestroyed: (): boolean => false };
}

describe('native overlay-layer opener boundary', () => {
  const main = opener(1);
  const advisor = opener(2);
  const setBounds = jest.fn();
  const focus = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockHandlers.clear();
    registerOverlayLayerHandlers({
      isOverlayLayerOpener: (sender) => sender === main || sender === advisor,
      overlayLayerHost: { setBounds, focus },
      // Retain the old accessor in the fixture for the pre-change qualification.
      ...{
        getMainWindow: (): {
          isDestroyed: () => boolean;
          webContents: Opener;
        } => ({ isDestroyed: (): boolean => false, webContents: main }),
      },
    });
  });

  function invoke(
    channel: string,
    sender: ReturnType<typeof opener>,
    request: unknown,
    frame = sender.mainFrame,
  ): void {
    const handler = mockHandlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    handler({ sender, senderFrame: frame }, request);
  }

  it.each([main, advisor])(
    'routes bounds and focus using opener $id',
    (sender) => {
      const bounds = {
        slot: 'notifications',
        bounds: { x: 1, y: 2, width: 300, height: 90 },
      };
      const request = { slot: 'notifications', target: 'main' };
      invoke(IPC_CHANNELS.overlayLayerSetBounds, sender, bounds);
      invoke(IPC_CHANNELS.overlayLayerFocus, sender, request);
      expect(setBounds).toHaveBeenCalledWith(sender, bounds);
      expect(focus).toHaveBeenCalledWith(sender, request);
    },
  );

  it('refuses untrusted, subframe and destroyed senders before touching a layer', () => {
    const request = { slot: 'notifications', target: 'layer' };
    for (const sender of [
      opener(3),
      { ...advisor, isDestroyed: (): boolean => true },
    ]) {
      expect(() =>
        invoke(IPC_CHANNELS.overlayLayerFocus, sender, request),
      ).toThrow('live renderer');
    }
    expect(() =>
      invoke(IPC_CHANNELS.overlayLayerFocus, advisor, request, {}),
    ).toThrow('live renderer');
    expect(focus).not.toHaveBeenCalled();
  });

  it('allows hiding an owned slot but refuses malformed bounds and focus requests', () => {
    const hidden = { slot: 'notifications', bounds: null };
    invoke(IPC_CHANNELS.overlayLayerSetBounds, advisor, hidden);
    expect(setBounds).toHaveBeenCalledWith(advisor, hidden);
    setBounds.mockClear();
    expect(() =>
      invoke(IPC_CHANNELS.overlayLayerSetBounds, advisor, {
        slot: 'notifications',
        bounds: { x: -1, y: 0, width: 1, height: 1 },
      }),
    ).toThrow('Invalid overlay layer request');
    expect(() =>
      invoke(IPC_CHANNELS.overlayLayerFocus, advisor, {
        slot: 'notifications',
        target: 'another-renderer',
      }),
    ).toThrow('Invalid overlay layer request');
    expect(setBounds).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});

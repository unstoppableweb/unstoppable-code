import { create } from 'zustand';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { parseAuthorityQualifiedId } from '@canopy/protocol/authority-qualified-id';
import type {
  CanopyApi,
  RemoteControlApi,
  RemoteControlContext,
  RemoteControlForgetDeviceRequest,
  RemoteControlOpenPairingWindowResult,
  RemoteControlRespondToPairingRequest,
  RemoteControlUpdateHostRequest,
  RemoteControlState,
} from '@canopy/desktop-shared/types';

/**
 * Renderer-side cache of device-to-device Remote Control: the single opt-in,
 * pairings, and the pairing link window (CAN-5985).
 *
 * Main is the source of truth. The renderer receives copies through
 * `window.api.remoteControl.getState()` (initial fetch) and
 * `onStateChanged()` (push updates); every action returns the new state,
 * which replaces the cached copy.
 *
 * The state always describes the computer the user is sitting at, also in a
 * window that shows another computer: those channels never tunnel. `context`
 * says which computer this window shows.
 *
 * Pairing codes and pairing links are render-only, like the Portal's: never
 * persisted, logged, or copied anywhere except to the person's clipboard on
 * request.
 */

/**
 * The bridge, or `null` where it is not installed (unit tests of unrelated
 * surfaces, auxiliary windows that never wired it).
 */
export function getRemoteControlApi(): RemoteControlApi | null {
  const api: Partial<Pick<CanopyApi, 'remoteControl'>> | undefined =
    typeof window === 'undefined' ? undefined : window.api;
  return api?.remoteControl ?? null;
}

function requireRemoteControlApi(): RemoteControlApi {
  const api = getRemoteControlApi();
  if (!api) {
    throw new Error(`${REMOTE_CONTROL_LABEL} isn't available in this window.`);
  }
  return api;
}

/** Where a paired computer's id lives: the computer and its own id there. */
export interface PairedComputerAddress {
  /** The computer's relay device id, as `PairedComputersApi` takes it. */
  deviceId: string;
  /** The id as that computer knows it; pass this in its calls. */
  localId: string;
}

/**
 * Splits a `computer-<deviceId>:<localId>` id (CAN-7757) into the computer
 * and the id it knows. Null for this computer's own ids and for cloud ids:
 * those keep their own paths. Whoever calls the computer strips the
 * qualifier, since main and the other computer refuse qualified ids.
 */
export function pairedComputerAddress(
  id: string,
): PairedComputerAddress | null {
  const parsed = parseAuthorityQualifiedId(id);
  if (parsed?.authority.kind !== 'paired-computer') return null;
  return { deviceId: parsed.authority.deviceId, localId: parsed.localId };
}

export function readRemoteControlContext(): RemoteControlContext {
  const api = getRemoteControlApi();
  if (!api) return { mode: 'local' };
  try {
    return api.getContext();
  } catch {
    return { mode: 'local' };
  }
}

export function defaultRemoteControlState(): RemoteControlState {
  return {
    available: false,
    signedIn: false,
    relayStatus: 'stopped',
    relayDetail: null,
    thisDevice: null,
    allowIncoming: false,
    allowRemoteUpdates: false,
    allowWebPreview: false,
    hosts: [],
    controllers: [],
    discoverable: [],
    outgoingPairing: null,
    incomingPairings: [],
    pairingWindow: null,
  };
}

interface RemoteControlStoreState {
  /** True once the renderer has done its initial fetch from main. */
  hydrated: boolean;
  /** Which computer this window shows. */
  context: RemoteControlContext;
  /** Latest snapshot from main. */
  state: RemoteControlState;
  /** The Add a computer dialog is open. */
  pairDialogOpen: boolean;
  /** Fetches the current state; safe to call repeatedly. */
  hydrate: () => Promise<void>;
  /** Replaces the cached state with a pushed snapshot. */
  setState: (next: RemoteControlState) => void;
  /**
   * Asks main to keep the connection up for a few minutes so the state lists
   * computers that can be paired.
   */
  discover: () => Promise<void>;
  openPairDialog: () => void;
  closePairDialog: () => void;
  /** Opens or focuses a computer's window; `null` is this computer. */
  openMachine: (deviceId: string | null) => Promise<void>;
  setAllowIncoming: (allow: boolean) => Promise<void>;
  setAllowRemoteUpdates: (allow: boolean) => Promise<void>;
  setAllowWebPreview: (allow: boolean) => Promise<void>;
  /**
   * This computer's inventory sync switch (CAN-5986). Turning it off deletes
   * this computer's synced lists from the web; callers confirm first.
   */
  setInventorySyncEnabled: (enabled: boolean) => Promise<void>;
  /**
   * Opens, or replaces, the pairing link window. The link is returned to the
   * caller only; it is never cached here.
   */
  openPairingWindow: () => Promise<RemoteControlOpenPairingWindowResult>;
  startPairing: (deviceId: string) => Promise<void>;
  cancelPairing: () => Promise<void>;
  respondToPairing: (
    request: RemoteControlRespondToPairingRequest,
  ) => Promise<void>;
  forgetDevice: (request: RemoteControlForgetDeviceRequest) => Promise<void>;
  disconnectController: (deviceId: string) => Promise<void>;
  /** Runs an update step on a paired computer on an older protocol. */
  updateHost: (request: RemoteControlUpdateHostRequest) => Promise<void>;
}

export const useRemoteControlStore = create<RemoteControlStoreState>((set) => {
  const apply = async (
    action: (api: RemoteControlApi) => Promise<RemoteControlState>,
  ): Promise<void> => {
    const next = await action(requireRemoteControlApi());
    set({ hydrated: true, state: next });
  };
  return {
    hydrated: false,
    context: readRemoteControlContext(),
    state: defaultRemoteControlState(),
    pairDialogOpen: false,
    hydrate: async (): Promise<void> => {
      const api = getRemoteControlApi();
      set({ context: readRemoteControlContext() });
      if (!api) return;
      try {
        const snapshot = await api.getState();
        set({ hydrated: true, state: snapshot });
      } catch {
        // Non-fatal: the next pushed update populates the store.
        set({ hydrated: true });
      }
    },
    setState: (next): void => {
      set({ hydrated: true, state: next });
    },
    discover: (): Promise<void> =>
      apply((api) => api.getState({ discover: true })),
    openPairDialog: (): void => {
      set({ pairDialogOpen: true });
    },
    closePairDialog: (): void => {
      set({ pairDialogOpen: false });
    },
    openMachine: async (deviceId): Promise<void> => {
      await requireRemoteControlApi().openMachine(deviceId);
    },
    setAllowIncoming: (allow): Promise<void> =>
      apply((api) => api.setAllowIncoming(allow)),
    setAllowRemoteUpdates: (allow): Promise<void> =>
      apply((api) => api.setAllowRemoteUpdates(allow)),
    setAllowWebPreview: (allow): Promise<void> =>
      apply((api) => api.setAllowWebPreview(allow)),
    setInventorySyncEnabled: (enabled): Promise<void> =>
      apply((api) => api.setInventorySyncEnabled(enabled)),
    openPairingWindow: (): Promise<RemoteControlOpenPairingWindowResult> =>
      requireRemoteControlApi().openPairingWindow(),
    startPairing: (deviceId): Promise<void> =>
      apply((api) => api.startPairing(deviceId)),
    cancelPairing: (): Promise<void> => apply((api) => api.cancelPairing()),
    respondToPairing: (request): Promise<void> =>
      apply((api) => api.respondToPairing(request)),
    forgetDevice: (request): Promise<void> =>
      apply((api) => api.forgetDevice(request)),
    disconnectController: (deviceId): Promise<void> =>
      apply((api) => api.disconnectController(deviceId)),
    updateHost: async (request): Promise<void> => {
      await requireRemoteControlApi().updateHost(request);
    },
  };
});

/** Remote access can be offered in this window: flag on and signed in. */
export function selectRemoteAccessReady(
  store: Pick<RemoteControlStoreState, 'state'>,
): boolean {
  return store.state.available && store.state.signedIn;
}

import { create } from 'zustand';
import type { PairedComputerState } from '@canopy/desktop-shared/types';
import { pairedComputerAddress } from '@/stores/remoteControlStore';

export interface PairedComputerConnectionEntry {
  readonly state: PairedComputerState;
  /** True once this device has reached `connected` in the current hold epoch. */
  readonly everConnected: boolean;
  /**
   * Monotonic counter incremented each time this device enters a new connected
   * session (initial connect, disconnect-to-reconnect, or explicit tunnel
   * `reconnected` update).
   */
  readonly connectionEpoch: number;
}

export interface PairedComputerConnectionStoreState {
  readonly byDevice: Readonly<Record<string, PairedComputerConnectionEntry>>;
}

const lastEpochByDevice = new Map<string, number>();

function nextConnectionEpoch(deviceId: string): number {
  const next = (lastEpochByDevice.get(deviceId) ?? 0) + 1;
  lastEpochByDevice.set(deviceId, next);
  return next;
}

export const usePairedComputerConnectionStore =
  create<PairedComputerConnectionStoreState>(() => ({
    byDevice: {},
  }));

export function publishPairedComputerConnectionState(
  deviceId: string,
  state: PairedComputerState,
): void {
  usePairedComputerConnectionStore.setState((current) => {
    const previous = current.byDevice[deviceId];
    const everConnected =
      state.status === 'connected' || previous?.everConnected === true;
    const enteringConnected =
      state.status === 'connected' && previous?.state.status !== 'connected';
    const hadComposer =
      previous?.state.status === 'connected' &&
      previous.state.capabilities.includes('composer');
    const hasComposer =
      state.status === 'connected' && state.capabilities.includes('composer');
    const composerReturned = !hadComposer && hasComposer;
    const connectionEpoch =
      enteringConnected || composerReturned
        ? nextConnectionEpoch(deviceId)
        : (previous?.connectionEpoch ?? lastEpochByDevice.get(deviceId) ?? 0);
    if (
      previous?.state === state &&
      previous.everConnected === everConnected &&
      previous.connectionEpoch === connectionEpoch
    ) {
      return current;
    }
    return {
      byDevice: {
        ...current.byDevice,
        [deviceId]: { state, everConnected, connectionEpoch },
      },
    };
  });
}

export function bumpPairedComputerConnectionEpoch(deviceId: string): void {
  usePairedComputerConnectionStore.setState((current) => {
    const previous = current.byDevice[deviceId];
    if (previous === undefined) return current;
    const connectionEpoch = nextConnectionEpoch(deviceId);
    return {
      byDevice: {
        ...current.byDevice,
        [deviceId]: {
          ...previous,
          everConnected: true,
          connectionEpoch,
        },
      },
    };
  });
}

export function clearPairedComputerConnectionState(deviceId?: string): void {
  usePairedComputerConnectionStore.setState((current) => {
    if (deviceId === undefined) {
      return Object.keys(current.byDevice).length === 0
        ? current
        : { byDevice: {} };
    }
    if (!(deviceId in current.byDevice)) return current;
    const next = { ...current.byDevice };
    delete next[deviceId];
    return { byDevice: next };
  });
}

export function pairedComputerConnectionForProject(
  state: PairedComputerConnectionStoreState,
  projectId: string,
): PairedComputerConnectionEntry | undefined {
  const parsed = pairedComputerAddress(projectId);
  if (parsed === null) return undefined;
  return state.byDevice[parsed.deviceId];
}

export function pairedComputerHasCapability(
  state: PairedComputerConnectionStoreState,
  projectId: string,
  capability: string,
): boolean {
  const entry = pairedComputerConnectionForProject(state, projectId);
  if (entry === undefined || entry.state.status !== 'connected') return false;
  return entry.state.capabilities.includes(capability);
}

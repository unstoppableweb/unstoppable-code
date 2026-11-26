import type { IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  type PairedComputerHoldResult,
  type PairedComputerLocalProjectFacts,
  type PairedComputerState,
  type PairedComputerUpdate,
  type PairedComputerWindowEvent,
  type PairedComputersApi,
} from '@canopy/desktop-shared/types';
import type { PreloadIpcRenderer } from '../ipc-router';

interface ComputerListeners {
  updates: Set<(update: PairedComputerUpdate) => void>;
  states: Set<(state: PairedComputerState) => void>;
}

/**
 * The main window's per-computer transport (CAN-7761), beside the IPC router
 * and independent of it: the router still decides once per window whether
 * this window talks to this computer, and local calls keep going straight
 * to Electron. Calls name the computer and go to main, which checks every
 * one. Main's events for every held computer arrive on one channel and are
 * split here by computer, so a listener hears only the computer it named.
 * Nothing is subscribed on that channel until the first listener is added.
 */
export function createPairedComputersApi(
  ipc: PreloadIpcRenderer,
): PairedComputersApi {
  const byComputer = new Map<string, ComputerListeners>();
  let listening = false;

  // Only main sends on this channel (it is never tunnelled).
  const dispatch = (
    _event: IpcRendererEvent,
    event: PairedComputerWindowEvent,
  ): void => {
    const listeners = byComputer.get(event.deviceId);
    if (!listeners) return;
    if (event.type === 'state') {
      for (const listener of Array.from(listeners.states))
        listener(event.state);
      return;
    }
    const update: PairedComputerUpdate =
      event.type === 'push'
        ? { type: 'push', channel: event.channel, args: event.args }
        : { type: 'reconnected' };
    for (const listener of Array.from(listeners.updates)) listener(update);
  };

  const listenersFor = (deviceId: string): ComputerListeners => {
    let listeners = byComputer.get(deviceId);
    if (!listeners) {
      listeners = { updates: new Set(), states: new Set() };
      byComputer.set(deviceId, listeners);
    }
    if (!listening) {
      listening = true;
      ipc.on(IPC_CHANNELS.remoteControlComputerEvent, dispatch);
    }
    return listeners;
  };

  const forget = (deviceId: string): void => {
    const listeners = byComputer.get(deviceId);
    if (listeners && listeners.updates.size + listeners.states.size === 0)
      byComputer.delete(deviceId);
    if (listening && byComputer.size === 0) {
      listening = false;
      ipc.removeListener(IPC_CHANNELS.remoteControlComputerEvent, dispatch);
    }
  };

  return {
    hold: (deviceId): Promise<PairedComputerHoldResult> =>
      ipc.invoke(IPC_CHANNELS.remoteControlComputerHold, deviceId),
    release: async (holdId): Promise<void> => {
      await ipc.invoke(IPC_CHANNELS.remoteControlComputerRelease, holdId);
    },
    invoke: (deviceId, channel, args): Promise<unknown> =>
      ipc.invoke(
        IPC_CHANNELS.remoteControlComputerInvoke,
        deviceId,
        channel,
        args,
      ),
    send: (deviceId, channel, args): void => {
      ipc.send(IPC_CHANNELS.remoteControlComputerSend, deviceId, channel, args);
    },
    getState: (deviceId): Promise<PairedComputerState> =>
      ipc.invoke(IPC_CHANNELS.remoteControlComputerState, deviceId),
    localProjectFacts: (
      projectIds,
    ): Promise<Record<string, PairedComputerLocalProjectFacts>> =>
      ipc.invoke(IPC_CHANNELS.remoteControlComputerProjectFacts, projectIds),
    onUpdate: (deviceId, listener) => {
      listenersFor(deviceId).updates.add(listener);
      return () => {
        byComputer.get(deviceId)?.updates.delete(listener);
        forget(deviceId);
      };
    },
    onStateChanged: (deviceId, listener) => {
      listenersFor(deviceId).states.add(listener);
      return () => {
        byComputer.get(deviceId)?.states.delete(listener);
        forget(deviceId);
      };
    },
  };
}

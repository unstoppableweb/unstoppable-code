import { useCallback, useEffect, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import type {
  RemoteControlApi,
  RemotePathPickerRequest,
} from '@canopy/desktop-shared/types';
import {
  getRemoteControlApi,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { IncomingPairingPrompt } from './IncomingPairingPrompt';
import { PairComputerDialog } from './PairComputerDialog';
import { RemotePathPicker } from './RemotePathPicker';

/**
 * App-root host for the remote access dialogs:
 *
 * - the Add a computer dialog, opened from the sidebar picker and Settings;
 * - the incoming pairing prompt, in this computer's own windows only, since a
 *   window showing another computer is not where this computer's owner looks;
 * - the remote file picker, in windows that show another computer.
 */
export function RemoteAccessHost(): JSX.Element {
  const { local, pairDialogOpen, closePairDialog, incoming } =
    useRemoteControlStore(
      useShallow((store) => ({
        local: store.context.mode === 'local',
        pairDialogOpen: store.pairDialogOpen,
        closePairDialog: store.closePairDialog,
        incoming: store.state.available
          ? (store.state.incomingPairings[0] ?? null)
          : null,
      })),
    );
  // The Remote Control dialog answers requests itself while it is open.
  const remoteControlDialogOpen = useNavigationStore(
    (store) => store.remoteControlDialogOpen,
  );
  const api = getRemoteControlApi();
  return (
    <>
      {pairDialogOpen ? <PairComputerDialog onClose={closePairDialog} /> : null}
      {local && incoming && !pairDialogOpen && !remoteControlDialogOpen ? (
        <IncomingPairingPrompt key={incoming.pairingId} request={incoming} />
      ) : null}
      {!local && api ? <RemotePathPickerHost api={api} /> : null}
    </>
  );
}

function RemotePathPickerHost({
  api,
}: {
  readonly api: RemoteControlApi;
}): JSX.Element | null {
  const [queue, setQueue] = useState<readonly RemotePathPickerRequest[]>([]);

  useEffect(
    () =>
      api.onPathPickerRequest((request) => {
        setQueue((current) => [...current, request]);
      }),
    [api],
  );

  const resolve = useCallback(
    (requestId: string, path: string | null): void => {
      setQueue((current) =>
        current.filter((entry) => entry.requestId !== requestId),
      );
      void api.resolvePathPicker({ requestId, path }).catch(() => undefined);
    },
    [api],
  );

  const listDirectory = useCallback<RemoteControlApi['listDirectory']>(
    (request) => api.listDirectory(request),
    [api],
  );

  const current = queue[0];
  if (!current) return null;
  return (
    <RemotePathPicker
      key={current.requestId}
      request={current}
      listDirectory={listDirectory}
      onResolve={(path) => resolve(current.requestId, path)}
    />
  );
}

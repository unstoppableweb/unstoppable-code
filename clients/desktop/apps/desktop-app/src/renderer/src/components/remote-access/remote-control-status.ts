import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import type { RemoteControlController } from '@canopy/desktop-shared/types';
import { toAppError } from '@canopy/protocol/app-errors';
import { isRemoteControllerLive } from '@canopy/ui-app/remote-control';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { useRemoteControlStore } from '@/stores/remoteControlStore';

/**
 * Who is controlling this computer, as one sentence: the account menu's
 * Remote Control item announces it beside its connected dot.
 */
export function remoteControlStatusSentence(
  controllers: readonly Pick<RemoteControlController, 'name'>[],
): string {
  const [only] = controllers;
  if (controllers.length === 1 && only) {
    return `${only.name} is controlling this computer`;
  }
  return `${controllers.length} devices are controlling this computer`;
}

/**
 * The devices controlling this computer right now. Empty in a window that
 * shows another computer: only this computer's own windows report on it.
 */
export function useLiveRemoteControllers(): readonly RemoteControlController[] {
  return useRemoteControlStore(
    useShallow((store) =>
      store.context.mode === 'local'
        ? store.state.controllers.filter(isRemoteControllerLive)
        : [],
    ),
  );
}

interface RemoteControlStatusUiState {
  /** The connected-devices dialog is open. */
  readonly open: boolean;
  /** The last Disconnect that failed, shown in the dialog. */
  readonly failure: InlineFailure | null;
  /** Opens or closes the dialog; closing clears its failure. */
  readonly setOpen: (open: boolean) => void;
  readonly setFailure: (failure: InlineFailure | null) => void;
}

/**
 * The connected-devices dialog's state, shared by the account menu (which
 * opens it), the dialog, and the connect toast: a Disconnect that fails from
 * the toast opens the dialog with the error, since the toast closes once
 * its action settles.
 */
export const useRemoteControlStatusUi = create<RemoteControlStatusUiState>(
  (set) => ({
    open: false,
    failure: null,
    setOpen: (open): void => {
      set(open ? { open } : { open, failure: null });
    },
    setFailure: (failure): void => {
      set({ failure });
    },
  }),
);

/**
 * Ends a controller's session. A failure opens the connected-devices dialog
 * with the error, wherever Disconnect was pressed, so a session that is still live is
 * never reported as ended. A cancellation is not a failure: `toAppError`
 * returns nothing for it, and nothing is shown.
 */
export function disconnectRemoteController(
  controller: Pick<RemoteControlController, 'deviceId' | 'name'>,
): Promise<void> {
  useRemoteControlStatusUi.getState().setFailure(null);
  return useRemoteControlStore
    .getState()
    .disconnectController(controller.deviceId)
    .catch((cause: unknown) => {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError) {
        useRemoteControlStatusUi.setState({
          open: true,
          // Names the device: the dialog lists every connected one.
          failure: inlineFailure(
            appError,
            `Couldn't disconnect ${controller.name}. Try again.`,
          ),
        });
      }
    });
}

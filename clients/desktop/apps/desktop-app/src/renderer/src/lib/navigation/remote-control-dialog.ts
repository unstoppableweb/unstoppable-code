import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';

/*
 * Renderer entry points for the Remote Control dialog (CAN-7298). The
 * sidebar row, the dialog's account settings link, the Plugins page, the
 * share dialog and main's `remote-control:dialog-request` push all come
 * through here, so the availability guard and its notice exist once. This
 * module must not import the App Advisor dispatcher.
 */

export const REMOTE_CONTROL_DISABLED_TOAST = `${REMOTE_CONTROL_LABEL} is not available.`;

/**
 * Opens the Remote Control dialog, or shows the unavailable notice when this
 * window's Remote Control state says it is unavailable. That happens before
 * the first state load, or on a host from before Remote Control graduated
 * (CAN-5986).
 */
export function requestRemoteControlDialogOpen(): 'opened' | 'unavailable' {
  if (!useRemoteControlStore.getState().state.available) {
    useGitHubStore.getState().addToast(REMOTE_CONTROL_DISABLED_TOAST, 'info');
    return 'unavailable';
  }
  useNavigationStore.getState().openRemoteControlDialog();
  return 'opened';
}

/** Closes the Remote Control dialog, then opens Account settings. */
export function openAccountSettingsFromRemoteControl(): void {
  useNavigationStore.getState().closeRemoteControlDialog();
  openCloudAccountSettings();
}

import { isRemoteSignInLink } from '@canopy/desktop-shared/lib/provider-sign-in-links';
import { readRemoteControlContext } from '@/stores/remoteControlStore';

/**
 * Opens a provider sign-in or device-code link in the browser of the computer
 * the person is using, and says whether it did.
 *
 * In a window that shows another computer, the system-browser channel is
 * blocked (it would open that computer's browser, where nobody is). The
 * window's own open handler sends http(s) links to this computer's browser
 * instead (`remote-control/client/remote-windows.ts`), so this opens only
 * https pages on the providers' sign-in hosts: the other computer can't
 * point this browser anywhere else. A link to another site can still be
 * copied from the sign-in terminal.
 */
export function openSignInLink(url: string): boolean {
  if (readRemoteControlContext().mode === 'remote') {
    if (!isRemoteSignInLink(url)) return false;
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
  void window.api.browser.openExternal({ url });
  return true;
}

/** Whether a sign-in started from this window runs on another computer. */
export function isRemoteSignIn(): boolean {
  return readRemoteControlContext().mode === 'remote';
}

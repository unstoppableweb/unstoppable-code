import { openExternalGuarded } from '../lib/open-external';

/** How a Cursor sign-in reaches the person. */
export interface CursorSignInOptions {
  /**
   * Another computer started it through Remote Control. The sign-in link is
   * sent with the progress status (`signInUrl`) for that computer to open,
   * instead of opening this computer's browser. Cursor's sign-in completes
   * on cursor.com, which the CLI polls, so any browser can finish it.
   */
  remote?: boolean;
  /**
   * The controlling computer shows `signInUrl`: its app sends
   * `{ signInLink: true }` with Connect and Change account. Releases before
   * CAN-6718 send nothing and would never show the link.
   */
  showsLink?: boolean;
}

/**
 * The options for one Connect or Change account call. `client` is the
 * optional argument the caller's app sent after the call's own arguments.
 */
export function readCursorSignInOptions(
  remote: boolean,
  client: unknown,
): CursorSignInOptions {
  if (!remote) return {};
  const showsLink =
    typeof client === 'object' &&
    client !== null &&
    'signInLink' in client &&
    client.signInLink === true;
  return showsLink ? { remote, showsLink } : { remote };
}

/**
 * Refuses a sign-in another computer started when that computer can't show
 * the link: nobody could finish it, and Change account would first sign this
 * computer out. Runs before any sign-out.
 */
export function assertCursorSignInReachable(
  options: CursorSignInOptions,
): void {
  if (options.remote === true && options.showsLink !== true)
    throw new Error(
      'Update the app on the computer you are using to sign in to Cursor from it.',
    );
}

/**
 * Where a sign-in link goes: this computer's browser, or, for a sign-in
 * another computer started, `present`, which puts it on the progress status.
 */
export function cursorSignInLinkOpener(
  options: CursorSignInOptions,
  present: (url: string) => void,
): (url: string) => Promise<void> {
  if (options.remote !== true) return openExternalGuarded;
  return (url) => {
    present(url);
    return Promise.resolve();
  };
}

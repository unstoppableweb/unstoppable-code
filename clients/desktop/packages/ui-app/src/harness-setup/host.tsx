'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type { AppError } from '@canopy/protocol/app-errors';
import type { HarnessSignInProvider } from '@canopy/protocol/remote-control/harness-setup';

/**
 * A failure shown under a provider row: the host's own sentence for a known
 * action, with the raw reason in `details`, or a structured error the host
 * knows how to present.
 */
export interface HarnessSetupFailure {
  readonly error: string | AppError;
  readonly details?: string;
}

/**
 * How a failure's sentence is chosen. `host-leads`: the computer's own
 * sentence (a declined sign-in, a blocking policy) leads when it has one, and
 * `fallback` otherwise. `fallback`: always `fallback`, with the cause as
 * details.
 */
export type HarnessSetupFailureMode = 'host-leads' | 'fallback';

/**
 * What the provider rows need from the surface that mounts them. Transport
 * and execution stay in the host's `CanopyClient` (`harnessSetup`); these
 * ports carry only presentation and host-local follow-ups, so the rows never
 * branch on which host they are in.
 */
export interface HarnessSetupHost {
  /**
   * The failure to show for `cause`, or `null` when there is nothing to show
   * (the host already reported it, or it is no error the person can act on).
   */
  failure(
    cause: unknown,
    fallback: string,
    mode: HarnessSetupFailureMode,
  ): HarnessSetupFailure | null;
  /** Records an error nobody sees, such as a failed cleanup. */
  reportError(cause: unknown): void;
  /**
   * The failure banner under a row; renders nothing without a failure.
   * `flush` drops the banner's own outer spacing, for banners inside a row's
   * detail stack.
   */
  renderFailure(props: {
    readonly source: string;
    readonly testId?: string;
    readonly failure: HarnessSetupFailure | null;
    readonly onDismiss?: () => void;
    readonly flush?: boolean;
  }): ReactNode;
  /**
   * Opens a sign-in page in the person's own browser, in a new tab. `link`
   * names the page: the host opens a `cursor` link only on Cursor's own
   * sign-in host, since the computer that sent it is checked again here.
   */
  openSignInLink(url: string, link: HarnessSignInLink): void;
  /**
   * Runs after a connection changed (Connect, Disconnect, account change),
   * for host-local state such as the desktop's preference subscribers.
   */
  afterConnectionChange?(): Promise<void>;
  /**
   * The sign-in surface for a fixed sign-in command, while it is open: the
   * desktop's terminal modal, or the web's text-and-code dialog.
   */
  renderSignIn(props: {
    readonly provider: HarnessSignInProvider;
    readonly onClose: () => void;
  }): ReactNode;
  /** The app's display name, for copy such as "Disconnect from …". */
  readonly appName: string;
  /**
   * How the rows name the computer they set up and the device the person
   * uses: `THIS_COMPUTER_WORDING` where the rows run on that computer,
   * `PAIRED_COMPUTER_WORDING` where they drive it from elsewhere. The rows
   * render this text as given, so they never branch on which host they are
   * in.
   */
  readonly wording: HarnessSetupWording;
  /**
   * The operating system of the computer the rows set up, as Node names it
   * (`darwin`, `linux`, `win32`), when the host knows it. Some copy depends
   * on it: Cursor shares its sign-in with the person's own CLI only on
   * macOS, and a Linux computer without Copilot says so.
   */
  readonly computerPlatform?: string;
}

/**
 * Which sign-in page a row opens: Cursor's sign-in, or GitHub's device page
 * for Copilot.
 */
export type HarnessSignInLink = 'cursor' | 'github-device';

const HarnessSetupHostContext = createContext<HarnessSetupHost | null>(null);

export function HarnessSetupHostProvider({
  host,
  children,
}: {
  readonly host: HarnessSetupHost;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <HarnessSetupHostContext.Provider value={host}>
      {children}
    </HarnessSetupHostContext.Provider>
  );
}

/** The mounting surface's ports; the rows render only under a provider. */
export function useHarnessSetupHost(): HarnessSetupHost {
  const host = useContext(HarnessSetupHostContext);
  if (!host)
    throw new Error(
      'Provider rows need a HarnessSetupHostProvider above them.',
    );
  return host;
}

/** The host-chosen text the rows put where a sentence names a computer. */
export interface HarnessSetupWording {
  /** The computer the rows set up, in running text. */
  readonly computer: string;
  /** The note under a connected Copilot row. */
  readonly copilotSignOutNote: string;
  /** Where the person opens a Cursor sign-in link the computer sent. */
  readonly cursorSignInDevice: string;
  /**
   * What Change account signs out on a computer that keeps Cursor's sign-in
   * private to the app.
   */
  readonly cursorAppSignIn: string;
  /**
   * The name for the person's own Antigravity CLI when the computer sent no
   * path. Absent where the rows don't run on that computer: a browser never
   * receives the path, so it names none.
   */
  readonly antigravityOwnCopyFallback?: string;
}

/** The rows run on the computer they set up. */
export const THIS_COMPUTER_WORDING: HarnessSetupWording = Object.freeze({
  computer: 'this computer',
  copilotSignOutNote:
    'Disconnect signs out of Copilot on this device. Change account signs out first.',
  cursorSignInDevice: 'this computer',
  cursorAppSignIn: 'this app',
  antigravityOwnCopyFallback: 'agy',
});

/** The rows drive a paired computer from another device. */
export const PAIRED_COMPUTER_WORDING: HarnessSetupWording = Object.freeze({
  computer: 'the paired computer',
  copilotSignOutNote:
    'Disconnect signs out of Copilot on the paired computer. Change account signs out first.',
  cursorSignInDevice: 'this device',
  cursorAppSignIn: 'the app on the paired computer',
});

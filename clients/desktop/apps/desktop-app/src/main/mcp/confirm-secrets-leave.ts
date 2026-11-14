import { BRAND } from '@canopy/brand/current';
import type { BrowserWindow, MessageBoxOptions } from 'electron';

/** What the person is asked to let leave this computer. Names only. */
export interface SecretsLeaveRequest {
  readonly serverName: string;
  /** Readable names, such as "X-Api-Key header" or "bearer token". */
  readonly secretNames: readonly string[];
  /** The origin the cloud account will send them to. */
  readonly destinationOrigin: string;
  /**
   * Where an OAuth client secret goes instead: the token endpoint's origin,
   * which can differ from the server's.
   */
  readonly tokenEndpointOrigin?: string;
}

/**
 * What the person agreed to: the cloud account the dialog named, and the
 * destination and secrets it showed. The caller sends only if all three
 * still hold for what is about to leave.
 */
export interface SecretsLeaveApproval {
  readonly accountId: string;
  readonly destinationOrigin: string;
  readonly tokenEndpointOrigin?: string;
  readonly secretNames: readonly string[];
}

/** A signed-in cloud account: its id, and its name as the person knows it. */
export interface SecretsLeaveAccount {
  readonly id: string;
  readonly label: string;
}

export interface ConfirmSecretsLeaveDeps {
  readonly mainWindow: () => BrowserWindow | null;
  /** The signed-in cloud account; null when signed out. */
  readonly account: () => Promise<SecretsLeaveAccount | null>;
  readonly showMessageBox: (
    window: BrowserWindow,
    options: MessageBoxOptions,
  ) => Promise<{ response: number }>;
}

const CANCEL = 0;
const SEND = 1;

/**
 * The native confirmation main shows before any secret leaves this computer
 * for the cloud account (CAN-6176, Nick 11 Nov): after the renderer's consent
 * screen, so a renderer can't consent for the person. It names each secret,
 * the destination origin and the cloud account, never a value, and answers
 * with exactly what it showed: the account's id, the origin and the secret
 * names. The caller sends only if they still match, so a switch or an edit
 * while the dialog is open can't carry the secrets anywhere else. Cancel, a
 * closed dialog, no main window, no signed-in account or any failure answers
 * null, and nothing is sent.
 */
export async function confirmSecretsLeave(
  request: SecretsLeaveRequest,
  deps: ConfirmSecretsLeaveDeps,
): Promise<SecretsLeaveApproval | null> {
  try {
    const window = deps.mainWindow();
    if (window === null || window.isDestroyed()) return null;
    const account = await deps.account();
    if (account === null) return null;
    const { response } = await deps.showMessageBox(window, {
      type: 'warning',
      buttons: ['Cancel', 'Send to cloud'],
      defaultId: CANCEL,
      cancelId: CANCEL,
      noLink: true,
      title: 'Send secrets to your cloud account?',
      message: `Send ${request.serverName}'s secrets to your cloud account?`,
      detail: [
        'These saved secrets will leave this computer:',
        ...request.secretNames.map((name) => `  • ${name}`),
        '',
        `Cloud account: ${account.label}`,
        `${BRAND.displayName} Cloud keeps them for that account and sends them only to: ${request.destinationOrigin}`,
        ...(request.tokenEndpointOrigin === undefined
          ? []
          : [
              `The OAuth client secret goes only to the sign-in token endpoint: ${request.tokenEndpointOrigin}`,
            ]),
      ].join('\n'),
    });
    return response === SEND
      ? {
          accountId: account.id,
          destinationOrigin: request.destinationOrigin,
          ...(request.tokenEndpointOrigin === undefined
            ? {}
            : { tokenEndpointOrigin: request.tokenEndpointOrigin }),
          secretNames: [...request.secretNames],
        }
      : null;
  } catch {
    return null;
  }
}

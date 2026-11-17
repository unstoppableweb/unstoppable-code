import type { JSX, ReactNode } from 'react';
import { CREDITS_ROW_DESCRIPTION } from '@canopy/ui-shared/components/providerChoiceCopy';
import { ReadyStatusLine } from '@canopy/ui-shared/components/ReadyStatusLine';
import { ProviderSourceRow } from '../providers/ProviderSourceRow';
import {
  FIRST_RUN_ACCOUNT_CHECKING,
  FIRST_RUN_ACCOUNT_READY,
  FIRST_RUN_ACCOUNT_SIGNED_IN,
} from './first-run-account-copy';

/**
 * What the account row says. `handoff` carries the host's sentence while a
 * purchase is open in the browser.
 */
export type FirstRunAccountRowState =
  | { readonly kind: 'offer' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'handoff'; readonly message: string };

export interface FirstRunAccountRowProps {
  readonly state: FirstRunAccountRowState;
  /** The host's brand mark, shown before the label. */
  readonly logo: ReactNode;
  /** The host's brand app name, the row's label. */
  readonly appName: string;
  /**
   * Whether a real account is signed in, shown as the label's status dot:
   * `true` signed in, `false` a guest or signed out, `null` while the host
   * is still reading it (no dot).
   */
  readonly signedIn: boolean | null;
  /**
   * Who is signed in, shown under the label once `signedIn` is `true`. The
   * host renders it and blocks it from session replay; without it the row
   * says `Signed in`.
   */
  readonly account?: ReactNode;
  /** The host's sign-in, purchase, or account-change control. */
  readonly action?: ReactNode;
  /**
   * Something that needs the user's attention, such as a failed sign-in,
   * shown under the state sentence without the ready check.
   */
  readonly attention?: string | null;
}

/** The account's state sentence; only the ready state takes the check. */
function stateSentence(state: FirstRunAccountRowState): ReactNode {
  switch (state.kind) {
    case 'ready':
      return <ReadyStatusLine>{FIRST_RUN_ACCOUNT_READY}</ReadyStatusLine>;
    case 'handoff':
      return state.message;
    case 'offer':
      // The same description the Switch provider dialog's credits row has.
      return CREDITS_ROW_DESCRIPTION;
  }
}

/**
 * The account's AI Credits, the third way in beside Claude and Codex
 * (CAN-4762, CAN-4765). It is the shared provider row
 * ({@link ProviderSourceRow}), as the Switch provider dialog shows it: logo, name
 * and a sign-in dot; once signed in, who is signed in under the label and
 * where the account stands on the line below, with the ready check when
 * credits are spendable. The host owns sign-in, the purchase, and changing
 * the account. The state sentence is one live region, so a screen reader
 * hears the hand-off and the ready state as they arrive. Signing in moves it
 * to the line below as a new node, so a sentence that changes in that same
 * render may not be announced.
 */
export function FirstRunAccountRow({
  state,
  logo,
  appName,
  signedIn,
  account,
  action,
  attention,
}: FirstRunAccountRowProps): JSX.Element {
  const stateLine = (
    <span
      role="status"
      className="block"
      data-testid="first-run-account-description"
      data-state={signedIn === null ? 'checking' : state.kind}
    >
      {signedIn === null ? FIRST_RUN_ACCOUNT_CHECKING : stateSentence(state)}
    </span>
  );
  return (
    <ProviderSourceRow
      dataTestId="first-run-account"
      icon={logo}
      name={<span data-testid="first-run-account-label">{appName}</span>}
      {...(signedIn === null
        ? {}
        : {
            status: signedIn ? 'connected' : 'signed-out',
            statusTestId: 'first-run-account-status',
          })}
      description={
        signedIn === true ? (account ?? FIRST_RUN_ACCOUNT_SIGNED_IN) : stateLine
      }
      control={action}
    >
      {signedIn === true || attention ? (
        <span className="block text-xs fg-secondary">
          {signedIn === true && stateLine}
          {attention && (
            <span
              data-testid="first-run-account-attention"
              className="block fg-warning"
            >
              {attention}
            </span>
          )}
        </span>
      ) : null}
    </ProviderSourceRow>
  );
}

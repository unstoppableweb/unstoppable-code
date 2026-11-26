'use client';

import {
  createContext,
  useContext,
  useMemo,
  type JSX,
  type ReactNode,
} from 'react';
// Schema-free import: web's signed-in layout mounts this host provider.
import { settingsRouteToPath } from '@canopy/protocol/settings/route-paths';
import { useSettingsHost } from '../host/settings-host';

// ---------------------------------------------------------------------------
// Slack-local host ports for Account → Integrations → Slack (CAN-7606).
//
// Linking a Slack account is a browser round trip through Slack's sign-in.
// Two hosts start it differently, and shared code only reads which port it
// was given, never which host it runs in:
//
// - `inline` (web): Connect calls the link start route with the session and
//   follows Slack's authorize URL in this tab. It also hands over a connect
//   intent the desktop put in the page address, already removed from it.
// - `thisComputer` (desktop): Connect runs desktop main's one-click flow,
//   which turns on listening for Slack mentions and Allow incoming, pairs
//   this computer for agents when needed, and opens the browser straight at
//   Slack's sign-in. The section then says to finish in the browser and
//   reads again until the link lands.
//
// Without a provider, Connect opens the web Integrations page in the browser.
//
// The slots are separate: the desktop reports this computer (its relay
// device and whether it listens for Slack mentions, with a way to change
// that), and learns whether the section is showing so its own fallback
// switch never renders where the section is.
// ---------------------------------------------------------------------------

/** Exactly one: a computer picked here, or a desktop connect intent. */
export type SlackLinkStartRequest =
  | { readonly remoteId: string }
  | { readonly intent: string };

/**
 * Why the link start route refused. `failed`: no answer, or one this client
 * doesn't know.
 */
export type SlackLinkStartRefusal =
  | 'unavailable'
  | 'intent_invalid'
  | 'computer_not_paired'
  | 'too_many_attempts'
  | 'failed';

export type SlackLinkStartResult =
  | {
      readonly ok: true;
      /** Slack's authorize URL, to follow in this tab. */
      readonly authorizeUrl: string;
    }
  | {
      readonly ok: false;
      readonly reason: SlackLinkStartRefusal;
      /** The intent's computer, when the route named one. */
      readonly remoteId?: string;
    };

/** What a host that runs Sign in with Slack on this page supplies. */
export interface SlackLinkInlinePorts {
  /** Calls the link start route; never rejects, resolves `failed` instead. */
  readonly startLink: (
    request: SlackLinkStartRequest,
  ) => Promise<SlackLinkStartResult>;
  /** Leaves this page for Slack's authorize URL. */
  readonly followAuthorizeUrl: (url: string) => void;
  /**
   * The desktop's connect intent from this page's address, removed from the
   * address before it returns; `null` when there is none. A second call
   * returns `null`, so a re-run effect never redeems it twice.
   */
  readonly takeConnectIntent: () => string | null;
}

/**
 * Why Connect Slack on this computer did not finish, as desktop main
 * reports it. Mirrors the desktop's `SlackConnectThisComputerFailure`.
 */
export type SlackConnectThisComputerRefusal =
  | 'not_enabled'
  | 'signed_out'
  | 'identity_changed'
  | 'entitlement_denied'
  | 'personal_account_required'
  | 'feature_disabled'
  | 'hosted_pairing_busy'
  | 'hosted_capacity'
  | 'entitlement_unavailable'
  | 'device_relay_not_configured'
  | 'forbidden'
  | 'denied'
  | 'offline'
  | 'host_unsupported'
  | 'timeout'
  | 'failed'
  | 'link_failed'
  | 'too_many_attempts'
  | 'browser_failed';

export type SlackConnectThisComputerResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SlackConnectThisComputerRefusal };

/** What a host that connects the computer it runs on supplies. */
export interface SlackThisComputerPorts {
  /** Resolves a refusal with its reason; rejects only when unanswered. */
  readonly connectThisComputer: () => Promise<SlackConnectThisComputerResult>;
}

export interface SlackLinkInlineHost extends SlackLinkInlinePorts {
  readonly kind: 'inline';
}

export interface SlackThisComputerHost extends SlackThisComputerPorts {
  readonly kind: 'thisComputer';
}

/** Connect continues on the web Integrations page in the browser. */
export interface SlackLinkBrowserHost {
  readonly kind: 'browser';
  readonly continueInBrowser: () => void;
}

export type SlackLinkHost =
  | SlackLinkInlineHost
  | SlackThisComputerHost
  | SlackLinkBrowserHost;

export type SlackLinkHostPorts =
  | ({ readonly kind: 'inline' } & SlackLinkInlinePorts)
  | ({ readonly kind: 'thisComputer' } & SlackThisComputerPorts);

const SlackLinkHostContext = createContext<SlackLinkHostPorts | null>(null);

export interface SlackLinkHostProviderProps {
  /** Created once by the host; never swapped while mounted. */
  readonly ports: SlackLinkHostPorts;
  readonly children: ReactNode;
}

export function SlackLinkHostProvider({
  ports,
  children,
}: SlackLinkHostProviderProps): JSX.Element {
  return (
    <SlackLinkHostContext.Provider value={ports}>
      {children}
    </SlackLinkHostContext.Provider>
  );
}

const INTEGRATIONS_PATH = settingsRouteToPath({
  scope: 'account',
  page: 'integrations',
});

/** Connect on the web Integrations page, in the browser. */
function useBrowserHandoffHost(): SlackLinkBrowserHost {
  const host = useSettingsHost();
  const navigation = host.useNavigation();
  return useMemo(
    (): SlackLinkBrowserHost => ({
      kind: 'browser',
      continueInBrowser: (): void => {
        navigation.openExternal(`${host.webOrigin()}${INTEGRATIONS_PATH}`);
      },
    }),
    [host, navigation],
  );
}

const UNUSED_HANDOFF: SlackLinkBrowserHost = {
  kind: 'browser',
  continueInBrowser: (): void => undefined,
};

function useProvidedHostHandoff(): SlackLinkBrowserHost {
  return UNUSED_HANDOFF;
}

/**
 * The Slack ports for this surface: the mounted provider's, else the browser
 * handoff. A provider is mounted once by its host and never added or removed
 * above a mounted view, so which handoff hook runs is stable for a mount.
 */
export function useSlackLinkHost(): SlackLinkHost {
  const provided = useContext(SlackLinkHostContext);
  const useHandoff =
    provided === null ? useBrowserHandoffHost : useProvidedHostHandoff;
  const handoff = useHandoff();
  return provided ?? handoff;
}

/** Host-supplied pieces of the Slack section. */
export interface SlackSettingsSlots {
  /**
   * Called with `true` while the Slack section is on the page and `false`
   * once the Integrations page settles without it, so a host can show its
   * own fallback only where the section isn't.
   */
  readonly onSectionPresence?: (present: boolean) => void;
  /**
   * A hook reporting the computer the host runs on, so the section can show
   * that computer's own link instead of Connect Slack, offer Turn on when it
   * isn't listening, and stop listening when its link is disconnected.
   * Stable for the provider's life.
   */
  readonly useThisComputer?: () => SlackThisComputerState;
}

/** The computer a desktop host runs on, as the Slack section needs it. */
export interface SlackThisComputerState {
  /** This computer's relay device id, or `null` while unknown. */
  readonly deviceId: string | null;
  /** Whether this computer listens for Slack mentions; `null` while unknown. */
  readonly listening: boolean | null;
  /**
   * Turns listening on or off here. Turning it on also lets other devices
   * control this computer, which every Slack request needs. Rejects when
   * the setting can't be saved. Absent where the host can't change it.
   */
  readonly setListening?: (listening: boolean) => Promise<void>;
}

const NO_THIS_COMPUTER: SlackThisComputerState = {
  deviceId: null,
  listening: null,
};

function useNoThisComputer(): SlackThisComputerState {
  return NO_THIS_COMPUTER;
}

const NO_SLOTS: SlackSettingsSlots = {};

const SlackSettingsSlotsContext = createContext<SlackSettingsSlots>(NO_SLOTS);

export interface SlackSettingsSlotsProviderProps {
  /** Stable for the provider's life. */
  readonly slots: SlackSettingsSlots;
  readonly children: ReactNode;
}

export function SlackSettingsSlotsProvider({
  slots,
  children,
}: SlackSettingsSlotsProviderProps): JSX.Element {
  return (
    <SlackSettingsSlotsContext.Provider value={slots}>
      {children}
    </SlackSettingsSlotsContext.Provider>
  );
}

export function useSlackSettingsSlots(): SlackSettingsSlots {
  return useContext(SlackSettingsSlotsContext);
}

/**
 * The host's computer, or nothing known on a host that doesn't run on one.
 * Slots are stable for a provider's life, so which hook runs is too.
 */
export function useSlackThisComputer(): SlackThisComputerState {
  const { useThisComputer } = useContext(SlackSettingsSlotsContext);
  const useComputer = useThisComputer ?? useNoThisComputer;
  return useComputer();
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  slackConnectHandoffPath,
  type AccountSlackLinks,
} from '@canopy/protocol/settings/account-slack-link';
import { SettingsOperationError } from '@canopy/protocol/settings/errors';
import { useSettingsClient, useSettingsHost } from '../host';
import { useSettingsErrorCopy, type SettingsFailure } from '../errors';
import {
  useSlackLinkHost,
  type SlackConnectThisComputerRefusal,
  type SlackLinkStartRefusal,
} from './slack-settings-host';

const ERROR_SCOPE = 'slack-link-settings';

/** How often the section reads again while a connect finishes elsewhere. */
export const SLACK_CONNECT_POLL_MS = 3_000;
/** How long it keeps reading: past the desktop's two-minute connect run. */
export const SLACK_CONNECT_POLL_LIMIT_MS = 3 * 60_000;

/** Where the last Connect Slack got to. */
export type SlackConnectState =
  | { readonly kind: 'idle' }
  /**
   * Connecting runs on (desktop main, or a browser handoff). `dismissed`
   * hides the notice; the section keeps reading until the link lands.
   */
  | { readonly kind: 'continue_in_browser'; readonly dismissed?: true }
  | {
      readonly kind: 'start_refused';
      readonly reason: Exclude<SlackLinkStartRefusal, 'intent_invalid'>;
    }
  | {
      readonly kind: 'connect_refused';
      readonly reason: SlackConnectThisComputerRefusal;
    }
  /** Change computer didn't move the link. */
  | {
      readonly kind: 'move_refused';
      readonly reason: 'computer_not_paired' | 'failed';
    }
  /** Change computer moved the link to another computer, by name. */
  | { readonly kind: 'moved_elsewhere'; readonly computerName: string };

/** How a Change computer ended. */
export type SlackLinkMoveOutcome = 'moved' | 'gone' | 'refused';

export interface SlackLinksController {
  /** The last good read; kept while a refresh runs or fails. */
  readonly data: AccountSlackLinks | null;
  readonly loading: boolean;
  readonly loadError: SettingsFailure | null;
  /** Reads again; `quiet` keeps the current view instead of a loading one. */
  readonly refresh: (options?: { readonly quiet?: boolean }) => void;
  /** The link a Disconnect is running for. */
  readonly busyLinkId: string | null;
  readonly actionError: SettingsFailure | null;
  /** Resolves true once the link is gone. */
  readonly remove: (linkId: string) => Promise<boolean>;
  readonly clearActionError: () => void;
  /**
   * Connect Slack for `remoteId`, a computer picked on this page. `null` is
   * this computer, where the host connects the computer it runs on; another
   * computer there continues in the browser, signed in, at Slack's consent
   * page for that computer.
   */
  readonly connect: (remoteId: string | null) => void;
  readonly connecting: boolean;
  /**
   * Change computer: points the link at another computer paired for agents,
   * with no new Slack sign-in. `computerName` names a computer other than
   * this one, so the section can say it must be listening; omit it where
   * this computer turns listening on itself. Resolves `gone` when the link
   * ended meanwhile, which needs no retry.
   */
  readonly move: (
    linkId: string,
    remoteId: string,
    computerName?: string,
  ) => Promise<SlackLinkMoveOutcome>;
  /** The link a Change computer is running for. */
  readonly movingLinkId: string | null;
  readonly connectState: SlackConnectState;
  /** Hides the connect notice; a wait for the new link goes on. */
  readonly dismissConnectNotice: () => void;
  /** Counts the links that landed while a connect finished elsewhere. */
  readonly connectedCount: number;
  /** The computer a refused connect intent named, to preselect. */
  readonly preselectedRemoteId: string | null;
}

/**
 * The one Slack link controller for the Integrations page (CAN-7606). It
 * reads the links through the settings client, runs Disconnect, and starts
 * Connect through the Slack host port. Pause and Resume live on External
 * agents. On a host that hands over a desktop connect intent, it redeems it
 * once on mount and follows Slack's sign-in; without a valid intent it never
 * starts on its own. It reads again when the window regains focus, and
 * every few seconds while a connect finishes in the browser, so coming back
 * needs no click.
 */
export function useSlackLinks({
  userId,
}: {
  readonly userId: string;
}): SlackLinksController {
  const client = useSettingsClient();
  const settingsHost = useSettingsHost();
  const navigation = settingsHost.useNavigation();
  const host = useSlackLinkHost();
  const errorCopy = useSettingsErrorCopy(ERROR_SCOPE);
  const [data, setData] = useState<AccountSlackLinks | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<SettingsFailure | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [movingLinkId, setMovingLinkId] = useState<string | null>(null);
  const [connectState, setConnectState] = useState<SlackConnectState>({
    kind: 'idle',
  });
  const [preselectedRemoteId, setPreselectedRemoteId] = useState<string | null>(
    null,
  );
  const [connectedCount, setConnectedCount] = useState(0);
  // Bumped per read and per account, so an older answer never lands.
  const readGeneration = useRef(0);
  // The links on screen when a connect handed off, so a new one can be told
  // apart; `null` while no connect is finishing elsewhere.
  const linksBeforeConnect = useRef<ReadonlySet<string> | null>(null);
  // When the current hand-off started, for the wait's time limit.
  const handOffStartedAt = useRef(0);
  // The generation of the read still in flight, so a poll tick never drops
  // a read that hasn't answered yet; `null` when none is.
  const readInFlight = useRef<number | null>(null);
  // The last good read, for a hand-off that runs after an await.
  const dataRef = useRef(data);
  dataRef.current = data;

  const refresh = useCallback(
    (options?: { readonly quiet?: boolean }): void => {
      const generation = ++readGeneration.current;
      readInFlight.current = generation;
      if (options?.quiet !== true) setLoading(true);
      void client
        .read('account.slack.link.read', {})
        .then((next) => {
          if (generation !== readGeneration.current) return;
          setData(next);
          setLoadError(null);
          const before = linksBeforeConnect.current;
          if (
            before !== null &&
            next.links.some((link) => !before.has(link.linkId))
          ) {
            linksBeforeConnect.current = null;
            // The header's dot and the new row say it's connected; the
            // section announces it.
            setConnectState({ kind: 'idle' });
            setConnectedCount((count) => count + 1);
          }
        })
        .catch((error: unknown) => {
          if (generation !== readGeneration.current) return;
          setLoadError(errorCopy.loadFailure(error));
        })
        .finally(() => {
          if (readInFlight.current === generation) readInFlight.current = null;
          if (generation === readGeneration.current) setLoading(false);
        });
    },
    [client, errorCopy],
  );

  // A new account starts over.
  useEffect(() => {
    setData(null);
    setActionError(null);
    linksBeforeConnect.current = null;
    setConnectState({ kind: 'idle' });
    refresh();
    return (): void => {
      readGeneration.current += 1;
      readInFlight.current = null;
    };
  }, [userId, refresh]);

  useEffect(() => {
    const onFocus = (): void => refresh({ quiet: true });
    window.addEventListener('focus', onFocus);
    return (): void => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // While a connect finishes in the browser, read quietly until the new link
  // lands (the read above ends the wait) or the run is
  // long over.
  const finishingElsewhere = connectState.kind === 'continue_in_browser';
  useEffect(() => {
    if (!finishingElsewhere) return undefined;
    const timer = window.setInterval(() => {
      if (Date.now() - handOffStartedAt.current > SLACK_CONNECT_POLL_LIMIT_MS) {
        // Long past the desktop's run: the person likely cancelled, so stop
        // saying to finish in the browser. A later focus still reads again.
        window.clearInterval(timer);
        linksBeforeConnect.current = null;
        setConnectState({ kind: 'idle' });
        return;
      }
      // A read that takes longer than a tick still lands: a new one would
      // drop it.
      if (readInFlight.current !== null) return;
      refresh({ quiet: true });
    }, SLACK_CONNECT_POLL_MS);
    return (): void => window.clearInterval(timer);
  }, [finishingElsewhere, refresh]);

  // Through refs: on desktop this runs after a connect that can take
  // minutes, and a second click restarts the time limit.
  const handOff = useCallback((): void => {
    const current = dataRef.current;
    // Before the first read there's nothing to compare against, and every
    // link would look new; the wait then ends at its time limit instead.
    linksBeforeConnect.current =
      current === null
        ? null
        : new Set(current.links.map((link) => link.linkId));
    handOffStartedAt.current = Date.now();
    setConnectState({ kind: 'continue_in_browser' });
  }, []);

  // A desktop connect intent in the page address: redeemed once. The port
  // has already removed it from the address, and a second take returns
  // null, so a re-run effect never starts twice. The result is never
  // dropped on cleanup: the intent is single use.
  useEffect(() => {
    if (host.kind !== 'inline') return;
    const intent = host.takeConnectIntent();
    if (intent === null) return;
    setConnecting(true);
    void host.startLink({ intent }).then((result) => {
      if (result.ok) {
        host.followAuthorizeUrl(result.authorizeUrl);
        return;
      }
      setConnecting(false);
      if (result.remoteId !== undefined)
        setPreselectedRemoteId(result.remoteId);
      // An invalid intent shows the normal state; nothing starts.
      if (result.reason !== 'intent_invalid')
        setConnectState({ kind: 'start_refused', reason: result.reason });
    });
  }, [host]);

  const remove = useCallback(
    async (linkId: string): Promise<boolean> => {
      setBusyLinkId(linkId);
      setActionError(null);
      try {
        await client.write('account.slack.link.remove', { linkId });
        setData((current) =>
          current === null
            ? current
            : {
                ...current,
                links: current.links.filter((link) => link.linkId !== linkId),
              },
        );
        refresh({ quiet: true });
        return true;
      } catch (error: unknown) {
        setActionError(
          errorCopy.actionFailure(error, { action: 'disconnect Slack' }),
        );
        return false;
      } finally {
        setBusyLinkId(null);
      }
    },
    [client, errorCopy, refresh],
  );

  const connect = useCallback(
    (remoteId: string | null): void => {
      setConnectState({ kind: 'idle' });
      switch (host.kind) {
        case 'browser':
          host.continueInBrowser();
          handOff();
          return;
        case 'thisComputer':
          if (remoteId !== null) {
            // Another computer: mint its connect intent and open the
            // hand-off page, signed in, which goes on to Slack's consent.
            setConnecting(true);
            void client
              .write('account.slack.link.intent', { remoteId })
              .then(
                (result) => {
                  if (result.ok) {
                    navigation.openExternal(
                      `${settingsHost.webOrigin()}${slackConnectHandoffPath(result.intent)}`,
                    );
                    handOff();
                    return;
                  }
                  setConnectState({
                    kind: 'start_refused',
                    reason: result.reason,
                  });
                  if (result.reason === 'computer_not_paired')
                    refresh({ quiet: true });
                },
                (error: unknown) => {
                  // Logged with its raw reason; the section shows our copy.
                  errorCopy.actionFailure(error, { action: 'connect Slack' });
                  setConnectState({ kind: 'start_refused', reason: 'failed' });
                },
              )
              .finally(() => setConnecting(false));
            return;
          }
          setConnecting(true);
          void host
            .connectThisComputer()
            .then(
              (result) => {
                if (result.ok) handOff();
                else
                  setConnectState({
                    kind: 'connect_refused',
                    reason: result.reason,
                  });
              },
              (error: unknown) => {
                // Logged with its raw reason; the section shows our copy.
                errorCopy.actionFailure(error, { action: 'connect Slack' });
                setConnectState({ kind: 'connect_refused', reason: 'failed' });
              },
            )
            .finally(() => {
              setConnecting(false);
              refresh({ quiet: true });
            });
          return;
        case 'inline':
          if (remoteId === null) return;
          setConnecting(true);
          void host.startLink({ remoteId }).then((result) => {
            if (result.ok) {
              // Leaving for Slack: stay busy until the page goes.
              host.followAuthorizeUrl(result.authorizeUrl);
              return;
            }
            setConnecting(false);
            if (result.reason !== 'intent_invalid')
              setConnectState({
                kind: 'start_refused',
                reason: result.reason,
              });
            if (result.reason === 'computer_not_paired')
              refresh({ quiet: true });
          });
          return;
      }
    },
    [host, client, navigation, settingsHost, refresh, errorCopy, handOff],
  );

  const move = useCallback(
    async (
      linkId: string,
      remoteId: string,
      computerName?: string,
    ): Promise<SlackLinkMoveOutcome> => {
      setMovingLinkId(linkId);
      setConnectState({ kind: 'idle' });
      try {
        const result = await client.write('account.slack.link.move', {
          linkId,
          remoteId,
        });
        if (!result.ok) {
          setConnectState({ kind: 'move_refused', reason: result.reason });
          return 'refused';
        }
        if (computerName !== undefined)
          setConnectState({ kind: 'moved_elsewhere', computerName });
        return 'moved';
      } catch (error: unknown) {
        // A link that ended meanwhile is not found: there's nothing to
        // retry, and the read below drops its row.
        if (
          error instanceof SettingsOperationError &&
          error.code === 'not_found'
        )
          return 'gone';
        errorCopy.actionFailure(error, { action: 'change computer' });
        setConnectState({ kind: 'move_refused', reason: 'failed' });
        return 'refused';
      } finally {
        setMovingLinkId(null);
        refresh({ quiet: true });
      }
    },
    [client, errorCopy, refresh],
  );

  const dismissConnectNotice = useCallback((): void => {
    setConnectState((current) =>
      current.kind === 'continue_in_browser'
        ? { kind: 'continue_in_browser', dismissed: true }
        : { kind: 'idle' },
    );
  }, []);

  const clearActionError = useCallback((): void => setActionError(null), []);

  return {
    data,
    loading,
    loadError,
    refresh,
    busyLinkId,
    actionError,
    remove,
    clearActionError,
    connect,
    connecting,
    move,
    movingLinkId,
    connectState,
    dismissConnectNotice,
    connectedCount,
    preselectedRemoteId,
  };
}

'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import {
  Button,
  DelayedLoadingPlaceholder,
  Divider,
  ErrorBanner,
  Notice,
  NoticeButton,
  SettingsSelect,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_ROW_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { SlackIcon } from '@canopy/ui-shared/icons/AppIcons';
import type {
  AccountSlackLinks,
  SlackAccountLink,
  SlackLinkComputer,
} from '@canopy/protocol/settings/account-slack-link';
import {
  DESKTOP_DOWNLOAD_PATH,
  EXTERNAL_AGENTS_LABEL,
  EXTERNAL_AGENTS_PATH,
} from '../../external-agents/paths';
import {
  SettingsConfirmDialog,
  useSettingsBrand,
  useSettingsHost,
  useSettingsPathname,
  useSettingsPrivacy,
  useSettingsRouter,
  useSettingsSearchParams,
} from '../host';
import { withPrivacyClass } from '../account/privacy-class';
import {
  isSlackCallbackOutcome,
  SLACK_ADD_FIRST_LINK_LABEL,
  SLACK_CARD_TITLE,
  SLACK_CHANGE_COMPUTER_LABEL,
  SLACK_COMPUTER_OFFLINE_LABEL,
  SLACK_CONNECTED_ANNOUNCEMENT,
  SLACK_CONNECTED_LABEL,
  SLACK_CONSENT_THIS_COMPUTER,
  SLACK_CONSENT_UNPICKED,
  SLACK_CONNECT_UNFINISHED_TITLE,
  SLACK_CONTINUE_IN_BROWSER_TEXT,
  SLACK_LISTEN_SAVE_FAILED_TEXT,
  SLACK_NO_COMPUTER_TITLE,
  SLACK_NOT_CONNECTED_LABEL,
  SLACK_STATUS_LABELS,
  SLACK_THIS_COMPUTER_NOT_LISTENING_TEXT,
  SLACK_NOT_OFFERED_NEXT_STEP_TEXT,
  SLACK_UNAVAILABLE_TEXT,
  SLACK_UNPAIRED_CHANGE_TEXT,
  SLACK_USE_THIS_COMPUTER_LABEL,
  slackActiveLinkText,
  slackAttentionText,
  slackCallbackOutcomeText,
  slackCardSubtitle,
  slackConnectRefusalText,
  slackConsentText,
  slackMoveRefusalText,
  slackMovedElsewhereText,
  SLACK_CONNECT_ANOTHER_LABEL,
  slackNewWorkspaceText,
  slackNoComputerText,
  slackOfflineLinkText,
  slackPausedLinkText,
  slackStartRefusalText,
  type SlackCallbackNoticeOutcome,
} from './slack-link-copy';
import {
  useSlackLinkHost,
  useSlackSettingsSlots,
  useSlackThisComputer,
  type SlackThisComputerState,
} from './slack-settings-host';
import { useSlackLinks, type SlackLinksController } from './use-slack-links';
import {
  ProviderSectionHeader,
  type ProviderSectionStatus,
} from '../layout/ProviderSectionHeader';

// ---------------------------------------------------------------------------
// Account → Integrations → Slack (CAN-7606): link a Slack account to this
// account and one computer paired for agents.
//
// One row per link, one decision per row. Its actions sit on one line
// under the text, the fix first, then Change computer, then Disconnect:
// - active: the workspace and where mentions go;
// - paused: says so and points to External agents, where Pause and Resume
//   live beside the connection's computer and access;
// - needs attention: why, with the one button that fixes it (Connect again,
//   Add to Slack, Change computer for an unpaired computer, or Turn on for
//   this desktop when it isn't listening);
// - offline computer: says so, with Change computer (and, on a desktop that
//   isn't that computer, Use this computer), and the header dot turns amber.
// Change computer moves a link to another of the person's computers with no
// new Slack sign-in (`account.slack.link.move`). The bot's offline reply
// opens it (`?slack=change`).
// Below the links, Connect. With no link yet it is the call to action: a
// computer picker with Connect Slack, the consent line, and "Is your
// workspace new to …? Add it to Slack first.", which opens `/slack` before
// any connect attempt fails (CAN-7689). Once a workspace is connected it
// folds into a quiet Connect another Slack workspace that opens the same
// form; the bot's setup link (`?slack=connect`) opens it. On web the picker
// lists the computers paired for agents, or the section says how to set one
// up when there is none. On desktop it starts at this computer, which
// Connect pairs and links itself, and lists the person's other computers,
// which continue in the browser at Slack's consent page; the section reads
// again until the link lands.
// A `?slack=` outcome shows once and leaves the address bar.
// Other states: loading, load failure, and Unavailable (one line).
// ---------------------------------------------------------------------------

const SLACK_INSTALL_PATH = '/slack';

/**
 * Opens the public Add to Slack page (`/slack`) in the browser; on desktop
 * the host opens it signed in.
 */
function useOpenSlackInstall(): () => void {
  const host = useSettingsHost();
  const navigation = host.useNavigation();
  return (): void =>
    navigation.openExternal(`${host.webOrigin()}${SLACK_INSTALL_PATH}`);
}

/** The `?slack=` outcome, read once and removed from the address. */
function useCallbackOutcome(): {
  readonly outcome: SlackCallbackNoticeOutcome | null;
  readonly dismiss: () => void;
  /** Sign in with Slack came back with a new link. */
  readonly linked: boolean;
  /** The bot's offline reply: open Change computer. */
  readonly changeRequested: boolean;
  /** The bot's setup link: open the connect form. */
  readonly connectRequested: boolean;
} {
  const params = useSettingsSearchParams();
  const router = useSettingsRouter();
  const pathname = useSettingsPathname();
  const raw = params.get('slack');
  const [outcome, setOutcome] = useState<SlackCallbackNoticeOutcome | null>(
    null,
  );
  const [linked, setLinked] = useState(false);
  const [changeRequested, setChangeRequested] = useState(false);
  const [connectRequested, setConnectRequested] = useState(false);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  useEffect(() => {
    if (raw === null) return;
    if (isSlackCallbackOutcome(raw)) {
      if (raw === 'linked') setLinked(true);
      else setOutcome(raw);
    } else if (raw === 'change') setChangeRequested(true);
    else if (raw === 'connect') setConnectRequested(true);
    const next = new URLSearchParams(paramsRef.current.toString());
    next.delete('slack');
    next.delete('intent');
    const query = next.toString();
    router.replace(query === '' ? pathname : `${pathname}?${query}`, {
      scroll: false,
    });
  }, [raw, router, pathname]);
  return {
    outcome,
    dismiss: () => setOutcome(null),
    linked,
    changeRequested,
    connectRequested,
  };
}

function OutcomeNotice({
  outcome,
  onDismiss,
}: {
  readonly outcome: SlackCallbackNoticeOutcome;
  readonly onDismiss: () => void;
}): JSX.Element {
  const brand = useSettingsBrand();
  const openSlackInstall = useOpenSlackInstall();
  const text = slackCallbackOutcomeText(outcome, brand.displayName);
  if (
    outcome === 'failed' ||
    outcome === 'expired' ||
    outcome === 'computer_not_paired' ||
    outcome === 'too_many_attempts'
  )
    return (
      <Notice
        intent="destructive"
        errorSource="slack-link-callback"
        onDismiss={onDismiss}
        data-testid="slack-link-outcome"
      >
        {text}
      </Notice>
    );
  return (
    <Notice
      intent={
        outcome === 'not_installed' || outcome === 'forwarded_workspace'
          ? 'attention'
          : 'neutral'
      }
      onDismiss={onDismiss}
      data-testid="slack-link-outcome"
      actions={
        outcome === 'not_installed' ? (
          <NoticeButton onClick={openSlackInstall}>Add to Slack</NoticeButton>
        ) : undefined
      }
    >
      {text}
    </Notice>
  );
}

function ConnectStateNotice({
  controller,
}: {
  readonly controller: SlackLinksController;
}): JSX.Element | null {
  const brand = useSettingsBrand();
  const state = controller.connectState;
  switch (state.kind) {
    case 'idle':
      return null;
    case 'continue_in_browser':
      if (state.dismissed === true) return null;
      return (
        <Notice
          intent="neutral"
          onDismiss={controller.dismissConnectNotice}
          data-testid="slack-link-continue-in-browser"
        >
          {SLACK_CONTINUE_IN_BROWSER_TEXT}
        </Notice>
      );
    case 'start_refused':
      return (
        <Notice
          intent="destructive"
          errorSource="slack-link-start"
          onDismiss={controller.dismissConnectNotice}
          data-testid="slack-link-start-refused"
        >
          {slackStartRefusalText(state.reason)}
        </Notice>
      );
    case 'connect_refused':
      return (
        <Notice
          intent="destructive"
          errorSource="slack-connect-this-computer"
          title={SLACK_CONNECT_UNFINISHED_TITLE}
          onDismiss={controller.dismissConnectNotice}
          data-testid="slack-link-connect-refused"
        >
          {slackConnectRefusalText(state.reason, brand.displayName)}
        </Notice>
      );
    case 'move_refused':
      return (
        <Notice
          intent="destructive"
          errorSource="slack-link-move"
          onDismiss={controller.dismissConnectNotice}
          data-testid="slack-link-move-refused"
        >
          {slackMoveRefusalText(state.reason)}
        </Notice>
      );
    case 'moved_elsewhere':
      return (
        <Notice
          intent="neutral"
          onDismiss={controller.dismissConnectNotice}
          data-testid="slack-link-moved-elsewhere"
        >
          {slackMovedElsewhereText(state.computerName, brand.displayName)}
        </Notice>
      );
  }
}

/**
 * Opens External agents: in this tab where Sign in with Slack runs on the
 * page (web), else in the browser, where that page lives.
 */
function useOpenExternalAgents(): () => void {
  const slackHost = useSlackLinkHost();
  const host = useSettingsHost();
  const navigation = host.useNavigation();
  const router = useSettingsRouter();
  return slackHost.kind === 'inline'
    ? (): void => router.push(EXTERNAL_AGENTS_PATH)
    : (): void =>
        navigation.openExternal(`${host.webOrigin()}${EXTERNAL_AGENTS_PATH}`);
}

/** Whether a link's computer is the one this desktop runs on. */
function isThisComputer(
  computer: SlackLinkComputer,
  thisDeviceId: string | null,
): boolean {
  return (
    thisDeviceId !== null &&
    computer.deviceId !== undefined &&
    computer.deviceId === thisDeviceId
  );
}

/** The desktop picker's entry for the computer it runs on. */
const THIS_COMPUTER_OPTION = 'this-computer';

/** A Change computer choice; `online` picks where the form starts. */
interface ComputerOption {
  readonly value: string;
  readonly label: string;
  readonly online: boolean;
}

function computerLabel(computer: SlackLinkComputer): string {
  return computer.online ? computer.name : `${computer.name} (offline)`;
}

/**
 * Where Change computer can move a link: the person's other computers paired
 * for agents, online ones first so the form starts on one that can take
 * mentions, and, on a desktop that isn't the link's computer, "This
 * computer" before them. This desktop is offered even before it's paired:
 * moving there then runs its one-click Connect.
 */
function changeComputerOptions(
  link: SlackAccountLink,
  computers: readonly SlackLinkComputer[],
  thisComputer: SlackThisComputerState,
  hostConnectsItself: boolean,
): readonly ComputerOption[] {
  const here = isThisComputer(link.computer, thisComputer.deviceId);
  const others = computers
    .filter(
      (computer) =>
        computer.remoteId !== link.computer.remoteId &&
        !(
          hostConnectsItself && isThisComputer(computer, thisComputer.deviceId)
        ),
    )
    .sort((a, b) => Number(b.online) - Number(a.online))
    .map((computer) => ({
      value: computer.remoteId,
      label: computerLabel(computer),
      online: computer.online,
    }));
  return hostConnectsItself && !here
    ? [
        { value: THIS_COMPUTER_OPTION, label: 'This computer', online: true },
        ...others,
      ]
    : others;
}

/** The link's computer was unpaired: moving it is the fix. */
function isUnpairedLink(link: SlackAccountLink): boolean {
  return (
    link.status === 'needs_attention' &&
    link.attentionReason === 'desktop_unpaired'
  );
}

/**
 * Change computer is offered for a working link, or one whose computer was
 * unpaired, when there's somewhere to move it. Another attention reason has
 * its own fix, which moving wouldn't change.
 */
function canChangeLink(
  link: SlackAccountLink,
  options: readonly { value: string; label: string }[],
): boolean {
  return (
    options.length > 0 && (link.status === 'active' || isUnpairedLink(link))
  );
}

/**
 * Moves a link to the computer picked by value, resolving whether the form
 * is done. On desktop, "This computer" moves it here when this computer is
 * paired and turns listening on, else runs the one-click Connect, which
 * pairs it and signs in to Slack again. Starting Connect counts as done: the
 * form closes and the section's notice shows Connect's progress and
 * outcome. So does a link that ended meanwhile: the refresh drops its row.
 */
function moveLinkFor(
  controller: SlackLinksController,
  computers: readonly SlackLinkComputer[],
  thisComputer: SlackThisComputerState,
  changeListening: (listening: boolean) => Promise<void>,
): (link: SlackAccountLink, value: string) => Promise<boolean> {
  return async (link, value) => {
    if (value !== THIS_COMPUTER_OPTION)
      return (
        (await controller.move(
          link.linkId,
          value,
          computers.find((computer) => computer.remoteId === value)?.name,
        )) !== 'refused'
      );
    const pairedHere = computers.find((computer) =>
      isThisComputer(computer, thisComputer.deviceId),
    );
    if (pairedHere === undefined) {
      controller.connect(null);
      return true;
    }
    const outcome = await controller.move(link.linkId, pairedHere.remoteId);
    if (
      outcome === 'moved' &&
      thisComputer.setListening !== undefined &&
      thisComputer.listening !== true
    )
      // changeListening shows its own failure in the section.
      await changeListening(true);
    return outcome !== 'refused';
  };
}

/** Change computer, in place of the row's detail: the picker and Save. */
function ChangeComputerForm({
  link,
  options,
  controller,
  onMove,
  onDone,
}: {
  readonly link: SlackAccountLink;
  readonly options: readonly ComputerOption[];
  readonly controller: SlackLinksController;
  readonly onMove: (link: SlackAccountLink, value: string) => Promise<boolean>;
  readonly onDone: () => void;
}): JSX.Element {
  const privacy = useSettingsPrivacy();
  // Starts at the first online choice: "This computer" on desktop, which is
  // the likely fix when the linked computer is offline. With every choice
  // offline it starts empty, so Save can't move a link to another computer
  // that can't answer either.
  const [value, setValue] = useState(
    options.find((option) => option.online)?.value ?? null,
  );
  const moving = controller.movingLinkId === link.linkId;
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="slack-link-change-form"
    >
      <SettingsSelect
        aria-label={`Computer for ${link.workspaceName}`}
        placeholder="Choose a computer"
        width="field"
        options={options}
        value={value}
        onValueChange={setValue}
        replayPrivacy={{ blockClassName: privacy.blockClassName }}
        data-testid="slack-link-change-computer"
      />
      <Button
        size="compact"
        variant="primary"
        aria-disabled={moving || value === null}
        aria-busy={moving}
        onClick={() => {
          if (moving || value === null) return;
          void onMove(link, value).then((moved) => {
            if (moved) onDone();
          });
        }}
        data-testid="slack-link-change-save"
      >
        {moving ? 'Saving…' : 'Save'}
      </Button>
      <Button
        size="compact"
        variant="ghost"
        onClick={onDone}
        data-testid="slack-link-change-cancel"
      >
        Cancel
      </Button>
    </div>
  );
}

function LinkRow({
  link,
  computers,
  controller,
  onDisconnect,
  thisComputer,
  changeListening,
  changing,
  onChangingChange,
}: {
  readonly link: SlackAccountLink;
  readonly computers: readonly SlackLinkComputer[];
  readonly controller: SlackLinksController;
  readonly onDisconnect: (link: SlackAccountLink) => void;
  readonly thisComputer: SlackThisComputerState;
  readonly changeListening: (listening: boolean) => Promise<void>;
  /** Change computer is open on this row; one row at a time. */
  readonly changing: boolean;
  readonly onChangingChange: (open: boolean) => void;
}): JSX.Element {
  const brand = useSettingsBrand();
  const openSlackInstall = useOpenSlackInstall();
  const privacy = useSettingsPrivacy();
  const slackHost = useSlackLinkHost();
  const [turningOn, setTurningOn] = useState(false);
  const busy = controller.busyLinkId === link.linkId;
  const here = isThisComputer(link.computer, thisComputer.deviceId);
  const hostConnectsItself = slackHost.kind === 'thisComputer';
  const options = changeComputerOptions(
    link,
    computers,
    thisComputer,
    hostConnectsItself,
  );
  const canChange = canChangeLink(link, options);
  const moveLink = moveLinkFor(
    controller,
    computers,
    thisComputer,
    changeListening,
  );
  const moving = controller.movingLinkId === link.linkId;
  const { setListening } = thisComputer;
  // This desktop is the linked computer and isn't listening: the link is
  // fine, so the fix is here, not another Slack sign-in.
  const notListeningHere =
    here &&
    link.status === 'active' &&
    thisComputer.listening === false &&
    setListening !== undefined;
  const attention = link.status === 'needs_attention';
  // The linked computer is off: mentions can't start work until it's back
  // or the link moves. A desktop knows it's on itself.
  const offline = link.status === 'active' && !here && !link.computer.online;
  // On a desktop that isn't the offline computer, the one-click fix.
  const useThisComputer = offline && hostConnectsItself;
  const unpaired = isUnpairedLink(link);
  // Offline or unpaired, moving is the fix, so it's a button; on a working
  // link it's a quiet link under the text.
  const moveIsTheFix = offline || unpaired;
  const openExternalAgents = useOpenExternalAgents();
  let detail: JSX.Element;
  if (attention)
    detail = (
      <span data-testid="slack-link-attention">
        {`${SLACK_STATUS_LABELS.needs_attention}. ${
          unpaired && canChange
            ? SLACK_UNPAIRED_CHANGE_TEXT
            : slackAttentionText(link.attentionReason, brand.displayName)
        }`}
      </span>
    );
  else if (link.status === 'paused')
    detail = (
      <span data-testid="slack-link-paused">
        {slackPausedLinkText(EXTERNAL_AGENTS_LABEL)}
      </span>
    );
  else if (notListeningHere)
    detail = (
      <span data-testid="slack-link-not-listening">
        {SLACK_THIS_COMPUTER_NOT_LISTENING_TEXT}
      </span>
    );
  else if (offline)
    detail = (
      <span className={privacy.blockClassName} data-testid="slack-link-offline">
        {slackOfflineLinkText(link.computer.name, brand.displayName, canChange)}
      </span>
    );
  else
    detail = (
      <span className={privacy.blockClassName}>
        {slackActiveLinkText(here ? null : link.computer.name)}
      </span>
    );
  return (
    <div
      className={`${SETTINGS_CARD_ROW_CLASS} flex-wrap`}
      data-testid="slack-link-row"
      data-slack-link-status={link.status}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          className={withPrivacyClass(
            'text-s font-medium fg-primary',
            privacy.blockClassName,
          )}
        >
          {link.workspaceName}
        </p>
        <p className="text-xs text-pretty fg-secondary">{detail}</p>
        {/* Every way to act on this connection sits on one line under the
            text: the fix first, then Change computer, then Disconnect. The
            text keeps the row's full width. Change computer's form takes
            the line's place until Save or Cancel. */}
        {canChange && changing ? (
          <ChangeComputerForm
            link={link}
            options={options}
            controller={controller}
            onMove={moveLink}
            onDone={() => onChangingChange(false)}
          />
        ) : (
          <div
            className="flex flex-wrap items-center gap-2 pt-1"
            data-testid="slack-link-actions"
          >
            {attention && link.attentionReason === 'not_installed' ? (
              <Button size="compact" onClick={openSlackInstall}>
                Add to Slack
              </Button>
            ) : null}
            {attention &&
            link.attentionReason !== 'not_installed' &&
            !(unpaired && canChange) ? (
              <Button
                size="compact"
                variant="primary"
                aria-disabled={controller.connecting}
                onClick={() => {
                  if (controller.connecting) return;
                  // `null` is this computer, which the desktop connects itself.
                  controller.connect(here ? null : link.computer.remoteId);
                }}
                data-testid="slack-link-connect-again"
              >
                Connect again
              </Button>
            ) : null}
            {notListeningHere ? (
              <Button
                size="compact"
                variant="primary"
                aria-disabled={turningOn}
                aria-busy={turningOn}
                onClick={() => {
                  if (turningOn) return;
                  setTurningOn(true);
                  void changeListening(true).finally(() => setTurningOn(false));
                }}
                data-testid="slack-link-turn-on"
              >
                Turn on
              </Button>
            ) : null}
            {useThisComputer ? (
              <Button
                size="compact"
                variant="primary"
                aria-disabled={moving || controller.connecting}
                aria-busy={moving}
                onClick={() => {
                  if (moving || controller.connecting) return;
                  void moveLink(link, THIS_COMPUTER_OPTION);
                }}
                data-testid="slack-link-use-this-computer"
              >
                {SLACK_USE_THIS_COMPUTER_LABEL}
              </Button>
            ) : null}
            {link.status === 'paused' ? (
              <Button
                size="compact"
                onClick={openExternalAgents}
                data-testid="slack-link-open-external-agents"
              >
                {`Open ${EXTERNAL_AGENTS_LABEL}`}
              </Button>
            ) : null}
            {canChange ? (
              <Button
                size="compact"
                variant={
                  moveIsTheFix && !useThisComputer ? 'primary' : 'secondary'
                }
                onClick={() => onChangingChange(true)}
                data-testid="slack-link-change"
              >
                {SLACK_CHANGE_COMPUTER_LABEL}
              </Button>
            ) : null}
            <Button
              size="compact"
              variant="ghost-destructive"
              aria-disabled={busy}
              onClick={() => {
                if (!busy) onDisconnect(link);
              }}
              data-testid="slack-link-disconnect"
            >
              Disconnect
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Web, no computer paired for agents: how to set one up. The text sits
 * above the actions so it never squeezes into a column beside them; the
 * section reads again on focus, so there's no Check again.
 */
function NoComputerView(): JSX.Element {
  const brand = useSettingsBrand();
  const host = useSettingsHost();
  const navigation = host.useNavigation();
  const openExternalAgents = useOpenExternalAgents();
  return (
    <div
      className={`${SETTINGS_CARD_ROW_CLASS} flex-col items-stretch gap-3`}
      data-testid="slack-link-no-computer"
    >
      <div className="flex flex-col gap-1">
        <p className="text-s font-medium fg-primary">
          {SLACK_NO_COMPUTER_TITLE}
        </p>
        <p className="text-xs text-pretty fg-secondary">
          {slackNoComputerText(brand.displayName, EXTERNAL_AGENTS_LABEL)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="compact"
          variant="primary"
          onClick={() =>
            navigation.openExternal(
              `${host.webOrigin()}${DESKTOP_DOWNLOAD_PATH}`,
            )
          }
        >
          {`Download ${brand.displayName}`}
        </Button>
        <Button size="compact" variant="ghost" onClick={openExternalAgents}>
          {`Open ${EXTERNAL_AGENTS_LABEL}`}
        </Button>
      </div>
    </div>
  );
}

/**
 * The computer web's picker starts at, so a reload shows one where the
 * choice is clear: the computer the newest link uses while it's online, else
 * the only one online, else the linked one, else the only one. With several
 * and no link, the person picks; guessing could run their mentions on the
 * wrong computer.
 */
function defaultWebComputer(
  links: readonly SlackAccountLink[],
  computers: readonly SlackLinkComputer[],
): string | null {
  const linked = links
    .map((link) =>
      computers.find(
        (computer) => computer.remoteId === link.computer.remoteId,
      ),
    )
    .find((computer) => computer !== undefined);
  if (linked?.online === true) return linked.remoteId;
  const online = computers.filter((computer) => computer.online);
  if (online.length === 1) return online[0]?.remoteId ?? null;
  if (linked !== undefined) return linked.remoteId;
  return computers.length === 1 ? (computers[0]?.remoteId ?? null) : null;
}

/**
 * The computer Connect Slack would link. On web, a computer picked from those
 * paired for agents, starting at {@link defaultWebComputer}. On desktop, this
 * computer (`remoteId: null`) unless another is picked.
 */
function usePickedComputer(
  controller: SlackLinksController,
  links: readonly SlackAccountLink[],
  computers: readonly SlackLinkComputer[],
): {
  readonly options: readonly { value: string; label: string }[];
  readonly value: string | null;
  readonly pick: (value: string) => void;
  /** `undefined` while web has nothing picked. */
  readonly target: { remoteId: string | null; name: string | null } | undefined;
} {
  const host = useSlackLinkHost();
  const thisComputer = useSlackThisComputer();
  const [picked, setPicked] = useState<string | null>(null);
  if (host.kind !== 'thisComputer') {
    const preferred =
      picked ??
      controller.preselectedRemoteId ??
      defaultWebComputer(links, computers);
    const selected =
      computers.find((computer) => computer.remoteId === preferred) ?? null;
    return {
      // One computer needs no picker.
      options:
        host.kind === 'inline' && computers.length > 1
          ? computers.map((computer) => ({
              value: computer.remoteId,
              label: computerLabel(computer),
            }))
          : [],
      value: selected?.remoteId ?? null,
      pick: setPicked,
      target:
        host.kind !== 'inline'
          ? { remoteId: null, name: null }
          : selected === null
            ? undefined
            : { remoteId: selected.remoteId, name: selected.name },
    };
  }
  const others = computers.filter(
    (computer) => !isThisComputer(computer, thisComputer.deviceId),
  );
  const selected =
    others.find((computer) => computer.remoteId === picked) ?? null;
  return {
    // With no other computer, Connect links this one and needs no picker.
    options:
      others.length === 0
        ? []
        : [
            { value: THIS_COMPUTER_OPTION, label: 'This computer' },
            ...others.map((computer) => ({
              value: computer.remoteId,
              label: computerLabel(computer),
            })),
          ],
    value: selected?.remoteId ?? THIS_COMPUTER_OPTION,
    pick: setPicked,
    target:
      selected === null
        ? { remoteId: null, name: null }
        : { remoteId: selected.remoteId, name: selected.name },
  };
}

/** Folds the connect form away once the person has a link. */

/**
 * Connect. With no link yet it is the section's one call to action: the
 * computer picker with Connect Slack beside it, the consent line, and the Add
 * to Slack line for a workspace without the app. Once a workspace is
 * connected the links are what matter, so it folds into a quiet Connect
 * another Slack workspace that opens the same form, with Cancel.
 */
function ConnectView({
  controller,
  links,
  computers,
  startExpanded,
}: {
  readonly controller: SlackLinksController;
  readonly links: readonly SlackAccountLink[];
  readonly computers: readonly SlackLinkComputer[];
  /** The bot's setup link led here: open the form. */
  readonly startExpanded: boolean;
}): JSX.Element {
  const brand = useSettingsBrand();
  const privacy = useSettingsPrivacy();
  const openSlackInstall = useOpenSlackInstall();
  const picker = usePickedComputer(controller, links, computers);
  const hasLinks = links.length > 0;
  const { target } = picker;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (startExpanded) setExpanded(true);
  }, [startExpanded]);
  // A new link landed: its row says so, and the form folds away.
  const landed = useRef(controller.connectedCount);
  useEffect(() => {
    if (controller.connectedCount === landed.current) return;
    landed.current = controller.connectedCount;
    setExpanded(false);
  }, [controller.connectedCount]);
  if (hasLinks && !expanded)
    return (
      <div className={SETTINGS_CARD_ROW_CLASS} data-testid="slack-link-ready">
        <Button
          size="compact"
          variant="ghost"
          onClick={() => setExpanded(true)}
          data-testid="slack-link-connect-another"
        >
          {SLACK_CONNECT_ANOTHER_LABEL}
        </Button>
      </div>
    );
  return (
    <div
      className={`${SETTINGS_CARD_ROW_CLASS} flex-wrap`}
      data-testid="slack-link-ready"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {/* Connect sits beside the picker it acts on. */}
        <div className="flex flex-wrap items-center gap-2">
          {picker.options.length > 0 ? (
            <SettingsSelect
              aria-label="Computer"
              placeholder="Choose a computer"
              // The 144px default cut "Choose a computer" and most computer
              // names short.
              width="field"
              options={picker.options}
              value={picker.value}
              onValueChange={picker.pick}
              replayPrivacy={{ blockClassName: privacy.blockClassName }}
              data-testid="slack-link-computer"
            />
          ) : null}
          <Button
            size="compact"
            variant="primary"
            aria-disabled={controller.connecting || target === undefined}
            aria-busy={controller.connecting}
            onClick={() => {
              if (controller.connecting || target === undefined) return;
              controller.connect(target.remoteId);
            }}
            data-testid="slack-link-connect"
          >
            {controller.connecting
              ? 'Connecting…'
              : hasLinks
                ? 'Connect'
                : 'Connect Slack'}
          </Button>
          {hasLinks ? (
            <Button
              size="compact"
              variant="ghost"
              onClick={() => setExpanded(false)}
              data-testid="slack-link-connect-cancel"
            >
              Cancel
            </Button>
          ) : null}
        </div>
        {/* One paragraph: the consent line, then the Add to Slack line for
            a workspace without the app. */}
        <p className="text-xs text-pretty fg-secondary">
          <span data-testid="slack-link-consent">
            {slackConsentText(
              target === undefined
                ? SLACK_CONSENT_UNPICKED
                : (target.name ?? SLACK_CONSENT_THIS_COMPUTER),
            )}
          </span>{' '}
          <span data-testid="slack-link-add-first">
            {slackNewWorkspaceText(brand.displayName)}{' '}
            <Button
              onClick={openSlackInstall}
              variant="link"
              data-settings-control="link"
            >
              {SLACK_ADD_FIRST_LINK_LABEL}
            </Button>
          </span>
        </p>
      </div>
    </div>
  );
}

function DisconnectDialog({
  link,
  controller,
  onClose,
  changeListening,
}: {
  readonly link: SlackAccountLink;
  readonly controller: SlackLinksController;
  readonly onClose: () => void;
  readonly changeListening: (listening: boolean) => Promise<void>;
}): JSX.Element {
  const thisComputer = useSlackThisComputer();
  const busy = controller.busyLinkId === link.linkId;
  return (
    <SettingsConfirmDialog
      title="Disconnect Slack?"
      message={`Your mentions in ${link.workspaceName} stop reaching ${link.computer.name}. You can connect again any time.`}
      confirmLabel="Disconnect"
      busyLabel="Disconnecting…"
      busy={busy}
      destructive
      onConfirm={() => {
        void controller.remove(link.linkId).then((removed) => {
          if (!removed) return;
          onClose();
          // Disconnecting this desktop's last link also stops it listening,
          // the reverse of what Connect Slack turned on. Another workspace's
          // link to this computer keeps it listening.
          const anotherLinkHere = (controller.data?.links ?? []).some(
            (other) =>
              other.linkId !== link.linkId &&
              isThisComputer(other.computer, thisComputer.deviceId),
          );
          if (
            thisComputer.setListening !== undefined &&
            thisComputer.listening === true &&
            isThisComputer(link.computer, thisComputer.deviceId) &&
            !anotherLinkHere
          )
            void changeListening(false);
        });
      }}
      onCancel={() => {
        controller.clearActionError();
        onClose();
      }}
      dataTestId="slack-link-disconnect-dialog"
      errorMessage={controller.actionError?.copy}
      errorSource="slack-link-remove"
      errorDetails={controller.actionError?.details}
    />
  );
}

function SlackSectionBody({
  controller,
  onDisconnect,
  changeListening,
  changeRequested,
  connectRequested,
}: {
  readonly controller: SlackLinksController;
  readonly onDisconnect: (link: SlackAccountLink) => void;
  readonly changeListening: (listening: boolean) => Promise<void>;
  /** The bot's offline reply led here: open Change computer on one link. */
  readonly changeRequested: boolean;
  /** The bot's setup link led here: open the connect form. */
  readonly connectRequested: boolean;
}): JSX.Element | null {
  const host = useSlackLinkHost();
  const thisComputer = useSlackThisComputer();
  const data = controller.data;
  // The one row with Change computer open, if any.
  const [changingLinkId, setChangingLinkId] = useState<string | null>(null);
  // The rows Change computer can open on. A link with nowhere to move, or
  // one that isn't working, never opens it, so it never hides Connect.
  const changeable = (data?.links ?? []).filter((link) =>
    canChangeLink(
      link,
      changeComputerOptions(
        link,
        data?.computers ?? [],
        thisComputer,
        host.kind === 'thisComputer',
      ),
    ),
  );
  // The link the bot's offline reply is about: one whose computer is off,
  // else the newest that can move. Opened once, the first time one reads.
  const requestedLinkId = changeRequested
    ? (
        changeable.find(
          (link) => link.status === 'active' && !link.computer.online,
        ) ?? changeable[0]
      )?.linkId
    : undefined;
  const requestHandled = useRef(false);
  useEffect(() => {
    if (requestHandled.current || requestedLinkId === undefined) return;
    requestHandled.current = true;
    setChangingLinkId(requestedLinkId);
  }, [requestedLinkId]);
  if (data === null) {
    if (controller.loadError !== null)
      return (
        <div className="py-3">
          <ErrorBanner
            errorSource="slack-link-load"
            className=""
            error={controller.loadError.copy}
            details={controller.loadError.details}
            onRetry={() => controller.refresh()}
          />
        </div>
      );
    return (
      <DelayedLoadingPlaceholder>
        <p
          className="py-3 text-xs fg-secondary"
          data-testid="slack-link-loading"
        >
          Loading Slack…
        </p>
      </DelayedLoadingPlaceholder>
    );
  }
  if (!data.available)
    return (
      <p
        className="py-3 text-xs text-pretty fg-secondary"
        data-testid="slack-link-unavailable"
      >
        {SLACK_UNAVAILABLE_TEXT}
      </p>
    );
  const changing = changeable.some((link) => link.linkId === changingLinkId);
  return (
    <div className="flex flex-col">
      {data.links.map((link) => (
        <LinkRow
          key={link.linkId}
          link={link}
          computers={data.computers}
          controller={controller}
          onDisconnect={onDisconnect}
          thisComputer={thisComputer}
          changeListening={changeListening}
          changing={link.linkId === changingLinkId}
          onChangingChange={(open) =>
            setChangingLinkId(open ? link.linkId : null)
          }
        />
      ))}
      {/* While a link's computer is being changed, a second picker for a new
          workspace below it would read as the same choice. */}
      {changing ? null : host.kind === 'inline' &&
        data.computers.length === 0 ? (
        <NoComputerView />
      ) : (
        <ConnectView
          controller={controller}
          links={data.links}
          computers={data.computers}
          startExpanded={connectRequested}
        />
      )}
    </div>
  );
}

/**
 * Reports the section's presence to the host while it is mounted; the page
 * reports its absence with {@link SlackSectionAbsent}.
 */
function useReportSectionPresence(): void {
  const { onSectionPresence } = useSlackSettingsSlots();
  useEffect(() => {
    if (onSectionPresence === undefined) return undefined;
    onSectionPresence(true);
    return (): void => onSectionPresence(false);
  }, [onSectionPresence]);
}

/** Where Start a task goes: the new task page. */
const NEW_TASK_PATH = '/chat';

/**
 * Rendered by the Integrations page where Slack isn't offered. Arriving from
 * a Slack link (`?slack=`, such as the bot's setup link) says why there's no
 * Slack section and offers the way to give agents work without it. It has
 * no close button: where nothing else is offered, it is the whole page.
 */
export function SlackSectionAbsent(): JSX.Element | null {
  const { onSectionPresence } = useSlackSettingsSlots();
  const params = useSettingsSearchParams();
  const router = useSettingsRouter();
  // Read once: the address may change under the page later.
  const [fromSlackLink] = useState(() => params.get('slack') !== null);
  useEffect(() => {
    onSectionPresence?.(false);
  }, [onSectionPresence]);
  if (!fromSlackLink) return null;
  return (
    <Notice
      intent="neutral"
      title={SLACK_UNAVAILABLE_TEXT}
      actions={
        <NoticeButton
          onClick={() => router.push(NEW_TASK_PATH)}
          data-testid="slack-link-not-offered-start-task"
        >
          Start a task
        </NoticeButton>
      }
      data-testid="slack-link-not-offered"
    >
      {SLACK_NOT_OFFERED_NEXT_STEP_TEXT}
    </Notice>
  );
}

export interface SlackLinkSettingsProps {
  /** The signed-in session user; a change drops pending work and reloads. */
  readonly userId: string;
}

/**
 * The header dot, as GitHub and Linear show theirs: red when a link needs a
 * fix, amber when a link's computer is offline, green when a link works,
 * grey when every link is paused, and a hollow ring with none. Nothing until
 * the first read, or when Slack is unavailable.
 *
 * On desktop, an active link to this computer also turns it red while this
 * computer isn't listening for Slack mentions. Web has no computer of its
 * own (`thisComputer` knows no device or listening value), so there the dot
 * follows each link's own status only.
 */
function slackStatus(
  data: AccountSlackLinks | null,
  thisComputer: SlackThisComputerState,
): ProviderSectionStatus | null {
  if (data === null || !data.available) return null;
  const { links } = data;
  if (links.length === 0)
    return { tone: 'signed-out', label: SLACK_NOT_CONNECTED_LABEL };
  const notListeningHere = (link: SlackAccountLink): boolean =>
    link.status === 'active' &&
    thisComputer.listening === false &&
    thisComputer.setListening !== undefined &&
    isThisComputer(link.computer, thisComputer.deviceId);
  if (
    links.some(
      (link) => link.status === 'needs_attention' || notListeningHere(link),
    )
  )
    return { tone: 'failed', label: SLACK_STATUS_LABELS.needs_attention };
  // A link whose computer is off can't start work until it's back or moves.
  // A desktop is never offline to itself.
  if (
    links.some(
      (link) =>
        link.status === 'active' &&
        !link.computer.online &&
        !isThisComputer(link.computer, thisComputer.deviceId),
    )
  )
    return { tone: 'limited', label: SLACK_COMPUTER_OFFLINE_LABEL };
  if (links.some((link) => link.status === 'active'))
    return { tone: 'connected', label: SLACK_CONNECTED_LABEL };
  return { tone: 'idle', label: SLACK_STATUS_LABELS.paused };
}

/** The Slack section of the Integrations page. */
export function SlackLinkSettings({
  userId,
}: SlackLinkSettingsProps): JSX.Element {
  // First, so a desktop connect intent leaves the address before the
  // outcome reader rewrites it.
  const controller = useSlackLinks({ userId });
  const { outcome, dismiss, linked, changeRequested, connectRequested } =
    useCallbackOutcome();
  // A new link lands quietly (the dot and the new row show it), so a polite
  // status says it. Each landing replaces the node, so a second one is read
  // too.
  const announcements = controller.connectedCount + (linked ? 1 : 0);
  useReportSectionPresence();
  const [disconnecting, setDisconnecting] = useState<SlackAccountLink | null>(
    null,
  );
  const thisComputer = useSlackThisComputer();
  const [listenFailed, setListenFailed] = useState(false);
  // Every listening change clears the last failure and reports its own.
  const changeListening = (listening: boolean): Promise<void> => {
    const { setListening } = thisComputer;
    if (setListening === undefined) return Promise.resolve();
    setListenFailed(false);
    return setListening(listening).catch(() => setListenFailed(true));
  };
  const cardActionError =
    disconnecting === null ? controller.actionError : null;
  const hasNotice =
    outcome !== null ||
    (controller.connectState.kind !== 'idle' &&
      !(
        controller.connectState.kind === 'continue_in_browser' &&
        controller.connectState.dismissed === true
      )) ||
    cardActionError !== null ||
    listenFailed;
  return (
    <section className={SETTINGS_CARD_CLASS} data-testid="slack-link-card">
      {/* Rendered empty first, so the text that lands in it is read. */}
      <p
        role="status"
        className="sr-only"
        data-testid="slack-link-announcement"
      >
        {announcements === 0 ? null : (
          <span key={announcements}>{SLACK_CONNECTED_ANNOUNCEMENT}</span>
        )}
      </p>
      <div className={SETTINGS_CARD_GROUP_CLASS}>
        <ProviderSectionHeader
          icon={
            <SlackIcon size="md" className="shrink-0 fg-primary" aria-hidden />
          }
          title={SLACK_CARD_TITLE}
          status={slackStatus(controller.data, thisComputer)}
          subtitle={slackCardSubtitle()}
          testId="slack-link-header"
          statusTestId="slack-link-status-dot"
        />
        {/* Notices and rows sit under a hairline, as GitHub and Linear's
            rows do. */}
        <Divider />
        <div className="flex flex-col">
          {hasNotice ? (
            <div className="flex flex-col gap-3 pt-3">
              {outcome === null ? null : (
                <OutcomeNotice outcome={outcome} onDismiss={dismiss} />
              )}
              <ConnectStateNotice controller={controller} />
              {cardActionError === null ? null : (
                <ErrorBanner
                  errorSource="slack-link-action"
                  className=""
                  error={cardActionError.copy}
                  details={cardActionError.details}
                />
              )}
              {listenFailed ? (
                <ErrorBanner
                  errorSource="slack-link-listen"
                  className=""
                  error={SLACK_LISTEN_SAVE_FAILED_TEXT}
                />
              ) : null}
            </div>
          ) : null}
          <SlackSectionBody
            controller={controller}
            onDisconnect={setDisconnecting}
            changeListening={changeListening}
            changeRequested={changeRequested}
            connectRequested={connectRequested}
          />
        </div>
      </div>
      {disconnecting === null ? null : (
        <DisconnectDialog
          link={disconnecting}
          controller={controller}
          onClose={() => setDisconnecting(null)}
          changeListening={changeListening}
        />
      )}
    </section>
  );
}

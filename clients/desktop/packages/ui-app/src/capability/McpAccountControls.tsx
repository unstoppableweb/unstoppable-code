'use client';

import { useId, useState, type JSX, type ReactNode } from 'react';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  ACCOUNT_MCP_LABEL_MAX_LENGTH,
  accountMcpDefaultConnection,
  type AccountMcpConnection,
} from '@canopy/protocol/mcp-servers';
import {
  Badge,
  Button,
  ConfirmDialog,
  CustomizeRowMenu,
  DisclosureChevron,
  DisclosureToggle,
  ErrorBanner,
  RenameDialog,
  SettingsRowsGroup,
  SettingsRowsRow,
  type CustomizeRowMenuItem,
} from '@canopy/ui-shared/components';
import { accountMcpAccountName } from './accountMcpRows';
import {
  mcpConnectActionButtonLabel,
  type McpConnectAction,
} from './McpConnectActionButton';

/**
 * What a host does for the account controls (CAN-6226). Each call answers
 * `null` once the change is saved and the host's list refreshed, or the
 * sentence to show when it could not be.
 */
export interface McpAccountActionsPort {
  /**
   * Starts signing in to another account of the server, named `label`. The
   * host owns the sign-in (a browser tab, an embedded page) as for Connect.
   * Absent where the host can't start one (a connector only the desktop can
   * sign in to); the existing accounts stay manageable.
   */
  readonly addAccount?: (label: string) => Promise<string | null>;
  /**
   * Runs as the Add name dialog opens, before {@link addAccount}, so a host
   * can note what the person is adding under (their signed-in account) and
   * refuse a submit made under another.
   */
  readonly beginAddAccount?: () => void;
  /**
   * Starts the sign-in of an account that isn't connected, from its own row:
   * one still waiting on its first sign-in (opening the page again when it
   * was missed), one that needs reconnecting, or one signed out. The host
   * owns the sign-in as for Connect. Absent where the host can't start one.
   */
  readonly signInAccount?: (
    connection: AccountMcpConnection,
  ) => Promise<string | null>;
  /** Renames an account; `null` clears the name. */
  readonly renameAccount: (
    connectionId: string,
    label: string | null,
  ) => Promise<string | null>;
  /** Makes an account the person's default for its server. */
  readonly makeDefault: (connectionId: string) => Promise<string | null>;
  /**
   * Deletes an account from the person's cloud account, with its sign-in.
   * Another account becomes the default when the default goes.
   */
  readonly removeAccount: (connectionId: string) => Promise<string | null>;
  /**
   * The host already recorded the failure its last `removeAccount` answered,
   * so the confirmation shows it without recording it again. A host without
   * it leaves the recording to the confirmation.
   */
  readonly removeFailureRecorded?: () => boolean;
}

/** The row the detail describes: one of the accounts, or the device copy. */
export type McpAccountSelection =
  | { readonly kind: 'account'; readonly id: string }
  | { readonly kind: 'device' };

/**
 * What a chat on this computer does with an account a project or chat picked,
 * when a device file has the connector key as its id: the resolver reads that
 * file first and runs the configuration with the account's id from it
 * (`replaced`), or leaves the server out when the file has no such enabled
 * configuration (`skipped`). The host decides; this list only says so.
 */
export type McpAccountDeviceEffect = 'replaced' | 'skipped';

/** By account id, the accounts whose picks a device file changes. */
export type McpAccountDeviceEffects = Readonly<
  Partial<Record<string, McpAccountDeviceEffect>>
>;

/** The note on an account a device copy changes, naming no one. */
function deviceEffectNote(
  effect: McpAccountDeviceEffect | undefined,
  serverName: string,
): string | undefined {
  switch (effect) {
    case 'replaced':
      return `On this computer, chats that pick this account use the ${serverName} copy set up on this computer instead.`;
    case 'skipped':
      return `On this computer, chats that pick this account don’t get ${serverName}: the copy set up on this computer has no setup for it.`;
    case undefined:
      return undefined;
  }
}

type OpenDialog =
  | { kind: 'add' }
  | { kind: 'rename'; connectionId: string }
  | { kind: 'remove'; connectionId: string };

/** A short word for where an account's sign-in stands. */
function accountStatus(connection: AccountMcpConnection): string {
  if (connection.enabled === false) return 'Turned off';
  switch (connection.status) {
    case 'CONNECTED':
      return 'Connected';
    case 'REAUTH_REQUIRED':
      return 'Needs reconnecting';
    case 'PENDING':
      return 'Waiting for sign-in';
    case 'DISCONNECTED':
      return 'Not connected';
  }
}

/**
 * The row's own sign-in action, for an account that is on but not connected;
 * `undefined` for one that is connected or turned off.
 */
function accountSignInAction(
  connection: AccountMcpConnection,
): McpConnectAction | undefined {
  if (connection.enabled === false) return undefined;
  switch (connection.status) {
    case 'CONNECTED':
      return undefined;
    case 'REAUTH_REQUIRED':
      return 'reconnect';
    case 'PENDING':
    case 'DISCONNECTED':
      return 'connect';
  }
}

/**
 * The account's name in this list. The first account, made before accounts
 * could be named, sits on the `default` configuration; it reads as the
 * connector rather than "Default", which the badge beside the actual default
 * would contradict.
 */
function listedAccountName(
  connection: AccountMcpConnection,
  serverName: string,
): string {
  if (!connection.label?.trim() && connection.configId === 'default')
    return serverName;
  return accountMcpAccountName(connection);
}

/**
 * One row of the list. With more than one row its name is a disclosure:
 * opening it selects it, and the open row shows the host's details below its
 * name. The open row stays open; another row's toggle moves the selection.
 */
function McpAccountRow({
  dataTestId,
  name,
  badges,
  description,
  note,
  open,
  collapsible,
  disabled,
  menu,
  details,
  onOpen,
}: {
  dataTestId: string;
  name: string;
  badges: ReactNode;
  description: string;
  note?: string;
  open: boolean;
  collapsible: boolean;
  disabled: boolean;
  /** The row's menu, given the id of the element showing its name. */
  menu?: (nameId: string) => ReactNode;
  details: ReactNode;
  onOpen: () => void;
}): JSX.Element {
  const bodyId = useId();
  const nameId = useId();
  const title = (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
      {/* A name the person gave the account, often an email. */}
      <span id={nameId} className={REPLAY_BLOCK_CLASS}>
        {name}
      </span>
      {badges}
    </span>
  );
  const body = open && details ? details : null;
  return (
    <SettingsRowsRow
      dataTestId={dataTestId}
      label={
        collapsible ? (
          <DisclosureToggle
            variant="row"
            open={open}
            bodyId={body ? bodyId : undefined}
            disabled={disabled && !open}
            data-testid={`${dataTestId}-toggle`}
            onClick={(): void => {
              if (!open) onOpen();
            }}
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <DisclosureChevron
                direction={open ? 'down' : 'right'}
                size="sm"
              />
              {title}
            </span>
          </DisclosureToggle>
        ) : (
          title
        )
      }
      description={
        note ? (
          <span className="flex flex-col gap-0.5">
            <span>{description}</span>
            <span data-testid={`${dataTestId}-note`}>{note}</span>
          </span>
        ) : (
          description
        )
      }
      control={menu?.(nameId)}
    >
      {body ? (
        <div
          id={bodyId}
          role="region"
          aria-labelledby={nameId}
          className={`min-w-0 ${collapsible ? 'pl-6' : ''}`}
          data-testid={`${dataTestId}-details`}
        >
          {body}
        </div>
      ) : null}
    </SettingsRowsRow>
  );
}

/**
 * Every account a person holds for one connector, in one list (CAN-6226),
 * each row naming the account, marking the default of several and saying
 * whether it is connected, with Make default, Rename and Remove in its menu
 * and Add another account on the list's own row. The row the detail describes is
 * open and holds the host's `details` (its health, placement, connection and
 * projects), so an account's facts and actions sit inside its own row. The
 * desktop adds its device copy as one more row. Shown on desktop and web
 * wherever the connection detail is; it renders nothing when the person
 * holds no account, unless their only connection is the copy on this device
 * (`deviceCopy`): the list then offers Add a cloud account beside its row, so
 * the connector can reach cloud chats and their other devices too.
 */
export function McpAccountControls({
  serverName,
  connections,
  selected,
  actions,
  onSelect,
  details,
  device = false,
  deviceEffects,
  deviceCopy = false,
  disabled = false,
  addPending = false,
}: {
  /** The connector's name, for the default account and a new account's name. */
  serverName: string;
  /** This person's accounts of the connector. */
  connections: readonly AccountMcpConnection[];
  /** The row the detail describes; the default account when null. */
  selected: McpAccountSelection | null;
  actions: McpAccountActionsPort | null | undefined;
  /** Shows another row's details. Without it only the selected row lists. */
  onSelect?: (selection: McpAccountSelection) => void;
  /** The selected row's details, drawn inside that row. */
  details: ReactNode;
  /** Lists the desktop's copy on this computer as its own row. */
  device?: boolean;
  /** Notes on the accounts a device file named after the connector changes. */
  deviceEffects?: McpAccountDeviceEffects;
  /**
   * The person holds only a copy of the connector on this device, listed as
   * its `device` row. With no account, the list then offers adding the first
   * one beside it.
   */
  deviceCopy?: boolean;
  disabled?: boolean;
  /**
   * An added account is still signing in. Add another account waits for it,
   * so a retry can't start a second sign-in under the same name; removing the
   * waiting account cancels it.
   */
  addPending?: boolean;
}): JSX.Element | null {
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The host recorded the failure the remove confirmation shows.
  const [errorRecorded, setErrorRecorded] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  // Only a device copy: the first account is a cloud one, added beside it.
  const firstBesideDevice = connections.length === 0 && deviceCopy;
  if (connections.length === 0 && !(firstBesideDevice && actions)) return null;
  const several = connections.length > 1;
  const addLabel = firstBesideDevice
    ? 'Add a cloud account'
    : 'Add another account';
  // One account is always the default: the flagged one, else the `default`
  // configuration, else the oldest, as the run itself picks it.
  const defaultAccount =
    accountMcpDefaultConnection(connections, connections[0]?.serverKey ?? '') ??
    connections[0];
  const ordered = [
    ...connections.filter((connection) => connection === defaultAccount),
    ...connections.filter((connection) => connection !== defaultAccount),
  ];
  const deviceSelected = device && selected?.kind === 'device';
  const selectedAccount = deviceSelected
    ? undefined
    : (connections.find(
        (connection) =>
          selected?.kind === 'account' && connection.id === selected.id,
      ) ?? defaultAccount);
  const collapsible = Boolean(onSelect) && (several || device);
  const run = async (
    work: () => Promise<string | null>,
    inDialog: boolean,
    recordedByHost?: () => boolean,
  ): Promise<void> => {
    setBusy(true);
    setRowError(null);
    try {
      const failure = await work();
      if (failure === null) {
        setDialog(null);
        setError(null);
      } else if (inDialog) {
        // Asked as the attempt fails, while it is still the host's last.
        setErrorRecorded(recordedByHost?.() ?? false);
        setError(failure);
      } else setRowError(failure);
    } finally {
      setBusy(false);
    }
  };
  const locked = disabled || busy;
  const addAccount = actions?.addAccount;
  const signInAccount = actions?.signInAccount;
  const removing =
    dialog?.kind === 'remove'
      ? connections.find((connection) => connection.id === dialog.connectionId)
      : undefined;
  const menuItems = (
    connection: AccountMcpConnection,
    isDefault: boolean,
  ): CustomizeRowMenuItem[] =>
    actions
      ? [
          ...(isDefault
            ? []
            : [
                {
                  id: 'make-default',
                  label: 'Make default',
                  disabled: locked,
                  onSelect: (): void => {
                    void run(() => actions.makeDefault(connection.id), false);
                  },
                },
              ]),
          {
            id: 'rename',
            label: 'Rename',
            disabled: locked,
            onSelect: (): void => {
              setError(null);
              setDialog({ kind: 'rename', connectionId: connection.id });
            },
          },
          {
            id: 'remove',
            label: 'Remove…',
            destructive: true,
            disabled: locked,
            onSelect: (): void => {
              setError(null);
              setDialog({ kind: 'remove', connectionId: connection.id });
            },
          },
        ]
      : [];
  return (
    <SettingsRowsGroup dataTestId="mcp-account-controls" ariaLabel="Accounts">
      <SettingsRowsRow
        label="Accounts"
        description={
          addPending
            ? signInAccount
              ? "Finish signing in to the new account in your browser. If the page didn't open, choose Sign in on its row, or remove the account to cancel."
              : 'Finish signing in to the new account in your browser, or remove it to cancel.'
            : several
              ? 'New chats use the default account unless a project or chat picks another.'
              : firstBesideDevice
                ? // Says what a cloud account adds over the device copy, which
                  // stays as it is. Never "connected": the copy may not be
                  // signed in yet.
                  `Only on this device. Add a cloud account so cloud chats and your other devices can use ${serverName} too.`
                : undefined
        }
        dataTestId="mcp-accounts-header"
        control={
          addAccount ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={locked || addPending}
              data-testid="mcp-account-add"
              onClick={(): void => {
                setError(null);
                actions?.beginAddAccount?.();
                setDialog({ kind: 'add' });
              }}
            >
              {addLabel}
            </Button>
          ) : undefined
        }
      >
        <ErrorBanner
          className=""
          error={rowError}
          errorSource="mcp-account-controls"
          testId="mcp-account-controls-error"
          onDismiss={(): void => setRowError(null)}
        />
      </SettingsRowsRow>
      {ordered.map((connection) => {
        const isDefault = connection === defaultAccount;
        const name = listedAccountName(connection, serverName);
        return (
          <McpAccountRow
            key={connection.id}
            dataTestId={`mcp-account-row-${connection.id}`}
            name={name}
            badges={
              isDefault && several ? (
                <Badge tone="neutral" data-testid="mcp-account-default-badge">
                  Default
                </Badge>
              ) : null
            }
            description={accountStatus(connection)}
            open={connection === selectedAccount}
            collapsible={collapsible}
            disabled={locked}
            note={deviceEffectNote(deviceEffects?.[connection.id], serverName)}
            menu={(nameId): ReactNode => {
              // The trigger reads the replay-blocked name by reference, so
              // the account's label never sits in its own attribute.
              const menu = (
                <CustomizeRowMenu
                  entryName={name}
                  entryNameId={nameId}
                  idPrefix={`mcp-account-${connection.id}`}
                  items={menuItems(connection, isDefault)}
                  testId={`mcp-account-menu-${connection.id}`}
                />
              );
              const signInAction = signInAccount
                ? accountSignInAction(connection)
                : undefined;
              if (!signInAccount || !signInAction) return menu;
              // A waiting or signed-out account signs in from its own row,
              // so a sign-in page that never opened, or was closed, is one
              // click away without leaving the list.
              return (
                <span className="inline-flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={locked}
                    aria-describedby={nameId}
                    data-testid={`mcp-account-sign-in-${connection.id}`}
                    onClick={(): void => {
                      void run(() => signInAccount(connection), false);
                    }}
                  >
                    {mcpConnectActionButtonLabel(signInAction, 'idle')}
                  </Button>
                  {menu}
                </span>
              );
            }}
            details={details}
            onOpen={(): void =>
              onSelect?.({ kind: 'account', id: connection.id })
            }
          />
        );
      })}
      {device ? (
        <McpAccountRow
          dataTestId="mcp-account-row-device"
          name="This device"
          badges={
            <Badge tone="neutral" data-testid="mcp-account-device-badge">
              Local
            </Badge>
          }
          // Its own copy of the server's setup, outside the person's account.
          description="Set up only on this computer"
          open={deviceSelected}
          collapsible={collapsible}
          disabled={locked}
          details={details}
          onOpen={(): void => onSelect?.({ kind: 'device' })}
        />
      ) : null}
      {addAccount && dialog?.kind === 'add' ? (
        <RenameDialog
          // The name tells this account apart from the others, for example
          // its workspace; the person can rename it later.
          title={addLabel}
          label="Account name"
          // The first account needs no number to tell it apart.
          initialValue={
            firstBesideDevice
              ? serverName
              : `${serverName} ${connections.length + 1}`
          }
          helperText={`Shown wherever this account is listed, such as its workspace name. You sign in to ${serverName} next.`}
          maxLength={ACCOUNT_MCP_LABEL_MAX_LENGTH}
          submitLabel="Continue"
          busy={busy}
          error={error}
          dataTestId="mcp-account-add-dialog"
          onSubmit={(value): void => {
            const label = value.trim();
            if (!label) {
              setError('Enter a name for this account.');
              return;
            }
            void run(() => addAccount(label), true);
          }}
          onClose={(): void => setDialog(null)}
        />
      ) : null}
      {actions && dialog?.kind === 'rename' ? (
        <RenameDialog
          title="Rename account"
          label="Account name"
          initialValue={
            connections.find(
              (connection) => connection.id === dialog.connectionId,
            )?.label ?? ''
          }
          helperText="Leave it empty to use the default name."
          maxLength={ACCOUNT_MCP_LABEL_MAX_LENGTH}
          submitLabel="Save"
          busy={busy}
          error={error}
          dataTestId="mcp-account-rename-dialog"
          onSubmit={(value): void => {
            const label = value.trim();
            void run(
              () =>
                actions.renameAccount(
                  dialog.connectionId,
                  label === '' ? null : label,
                ),
              true,
            );
          }}
          onClose={(): void => setDialog(null)}
        />
      ) : null}
      {actions && dialog?.kind === 'remove' && removing ? (
        <ConfirmDialog
          title={
            <>
              Remove{' '}
              <span className={REPLAY_BLOCK_CLASS}>
                {listedAccountName(removing, serverName)}
              </span>
              ?
            </>
          }
          message={
            removing === defaultAccount && several
              ? 'Its sign-in is deleted, and projects and chats set to use it stop using it. Another account becomes the default.'
              : 'Its sign-in is deleted, and projects and chats set to use it stop using it.'
          }
          confirmLabel="Remove account"
          busyLabel="Removing…"
          busy={busy}
          {...(errorRecorded
            ? { errorMessage: error, errorRecordingDisabled: true as const }
            : { errorMessage: error, errorSource: 'mcp-account-remove' })}
          destructive
          dataTestId="mcp-account-remove-dialog"
          confirmTestId="mcp-account-remove-confirm"
          onConfirm={(): void => {
            // Each attempt's failure is a new sighting, even with the same text.
            setError(null);
            void run(
              () => actions.removeAccount(dialog.connectionId),
              true,
              (): boolean => actions.removeFailureRecorded?.() === true,
            );
          }}
          onCancel={(): void => setDialog(null)}
        />
      ) : null}
    </SettingsRowsGroup>
  );
}

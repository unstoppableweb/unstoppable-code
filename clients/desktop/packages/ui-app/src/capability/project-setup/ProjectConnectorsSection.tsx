'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import {
  CAPABILITY_SETUP_CONNECTOR_TOOL_LIMIT,
  type CapabilitySetupConnectorItem,
  type CatalogProjectConnectorSetup,
  type SharedConnectionOwn,
  type SharedConnectionTool,
} from '@canopy/protocol/canopy-core';
import {
  Badge,
  Button,
  ChoiceList,
  ChoiceField,
  DialogModal,
  EmptyStateRow,
  ErrorBanner,
  FloatingPickerMenu,
  Notice,
  PickList,
  PickerMenuOptionContent,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  Skeleton,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
  SettingsCardSwitch,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  logSettingsError,
  settingsActionErrorCopy,
  settingsFailure,
  type SettingsFailure,
} from '../../settings/errors';
import type { SettingsLogger } from '../../settings/host/settings-host';
import {
  connectorLimitChoiceOf,
  connectorLimitFor,
  connectorLimitSummary,
  connectorOtherProjects,
  connectorReadOnlyTools,
  connectorToolOptions,
  projectConnectorCandidates,
  projectConnectorRows,
  type ConnectorLimitChoice,
  type ConnectorOtherProject,
  type ProjectConnectorRow,
} from './project-connectors-model';
import {
  MaskedNameList,
  SignInPendingRow,
  sharedConnectionStatus,
  useReadAgainOnReturn,
} from '../../settings/organization/settings/shared-connection-display';
import { PROJECT_SETUP_SOURCE_LABEL } from './project-setup-model';
import { ShareYourConnectors } from './ShareYourConnectors';

/** The pending-save key of the Connectors add picker. */
export const PROJECT_CONNECTOR_ADD_KEY = 'add:connector';

/** The pending-save key of a connection's tool limit. */
export function projectConnectorLimitKey(row: ProjectConnectorRow): string {
  return `limit:${row.key}`;
}

const TOOLS_LOAD_ERROR_COPY =
  "Couldn't load this connection's tools. You can still allow all tools, or try again.";

export interface ProjectConnectorsSectionProps {
  readonly client: AccountOrganizationSettingsClient;
  readonly organizationId: string;
  readonly projectId: string;
  readonly connectors: CatalogProjectConnectorSetup;
  /**
   * Whether the caller may change the project's other items. Someone who may
   * not change its connections but may change the rest is told who can.
   */
  readonly setupCanEdit: boolean;
  /** True while no change may go out: a save is out, or the setup is stale. */
  readonly disabled: boolean;
  readonly pendingKey: string | null;
  /** The panel's last save failure, shown in the tool limit dialog too. */
  readonly saveError: SettingsFailure | null;
  readonly logger?: SettingsLogger;
  readonly onSwitch: (row: ProjectConnectorRow, on: boolean) => void;
  readonly onRemove: (row: ProjectConnectorRow) => void;
  readonly onAdd: (item: CapabilitySetupConnectorItem) => void;
  /** Saves a tool limit (null for every tool); resolves true once saved. */
  readonly onLimit: (
    row: ProjectConnectorRow,
    limit: string[] | null,
  ) => Promise<boolean>;
  /**
   * Opens the organization's sign-in for "Share with this project"
   * (CAN-6251). Without it, the admin's own connectors aren't offered.
   */
  readonly openSignIn?: (signInPath: string) => void;
  /** Reads the setup again after a connector was shared with the project. */
  readonly onShared?: () => void;
}

/**
 * The project's shared connections (CAN-6246, CAN-6248; spec FR-4.1–4.3):
 * the organization's default connections, which an owner or admin may switch
 * off here, and the ones the project added, each with the tools the project
 * allows. Everyone else reads them.
 */
export function ProjectConnectorsSection({
  client,
  organizationId,
  projectId,
  connectors,
  setupCanEdit,
  disabled,
  pendingKey,
  saveError,
  logger,
  onSwitch,
  onRemove,
  onAdd,
  onLimit,
  openSignIn,
  onShared,
}: ProjectConnectorsSectionProps): JSX.Element {
  const canEdit = connectors.canEdit;
  const rows = projectConnectorRows(connectors);
  const [otherProjects, setOtherProjects] = useState<ReadonlyMap<
    string,
    readonly ConnectorOtherProject[]
  > | null>(null);
  /** The admin's own connectors this project doesn't hold a connection for. */
  const [yours, setYours] = useState<readonly SharedConnectionOwn[]>([]);
  /** Each connection's tools, once its limit editor read them. */
  const [knownTools, setKnownTools] = useState<
    ReadonlyMap<string, readonly SharedConnectionTool[]>
  >(new Map());
  const [editing, setEditing] = useState<ProjectConnectorRow | null>(null);
  /** The connection whose reconnect is starting. */
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [reconnectError, setReconnectError] = useState<SettingsFailure | null>(
    null,
  );
  /**
   * A reconnect's sign-in and its connection, until the setup reads that
   * connection signed in again. Offered again in case the browser blocked
   * it: on web it opens after the reconnect request, outside the click.
   */
  const [reconnectSignIn, setReconnectSignIn] = useState<{
    readonly signInPath: string;
    readonly connectionId: string;
  } | null>(null);
  const awaitingSignIn = reconnectSignIn !== null;
  const reconnectStatus =
    reconnectSignIn === null
      ? undefined
      : rows.find((row) => row.ref.id === reconnectSignIn.connectionId)?.status;
  // Done once the setup reads the connection as no longer waiting for a
  // sign-in (or no longer in the project).
  useEffect(() => {
    if (
      reconnectSignIn !== null &&
      reconnectStatus !== 'pending' &&
      reconnectStatus !== 'needsSignIn'
    )
      setReconnectSignIn(null);
  }, [reconnectSignIn, reconnectStatus]);
  // An owner or admin reconnects an expired connection from here when the
  // host can open the organization's sign-in (CAN-6253).
  const canReconnect =
    canEdit && openSignIn !== undefined && onShared !== undefined;
  const rememberTools = useCallback(
    (connectionId: string, tools: readonly SharedConnectionTool[]): void => {
      setKnownTools((current) => new Map(current).set(connectionId, tools));
    },
    [],
  );

  // "Also in" comes from the organization's Connectors list, which only its
  // owners and admins read; a failure only leaves it out.
  useEffect(() => {
    if (!canEdit) return;
    let active = true;
    void (async (): Promise<void> => {
      try {
        const result = await client.read('organization.settings.connections', {
          organizationId,
        });
        if (!active) return;
        setOtherProjects(connectorOtherProjects(result.connections, projectId));
        const held = new Set(
          result.connections
            .filter((connection) =>
              connection.projects.some((project) => project.id === projectId),
            )
            .map((connection) => connection.serverKey),
        );
        setYours(
          (result.yours ?? []).filter((own) => !held.has(own.serverKey)),
        );
      } catch (error) {
        if (!active) return;
        if (logger)
          logSettingsError(logger, 'load organization connections', error);
        setOtherProjects(null);
        setYours([]);
      }
    })();
    return (): void => {
      active = false;
    };
    // The setup changes after a save or a share, which can change which
    // connections the project holds.
  }, [client, organizationId, projectId, canEdit, logger, connectors]);

  useReadAgainOnReturn(awaitingSignIn, onShared);

  const reconnect = async (row: ProjectConnectorRow): Promise<void> => {
    if (openSignIn === undefined || onShared === undefined) return;
    setReconnecting(row.key);
    setReconnectError(null);
    try {
      const started = await client.write(
        'organization.settings.connections.reconnect',
        {
          organizationId,
          connectionId: row.ref.id,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      if (started.signInPath === undefined) onShared();
      else {
        setReconnectSignIn({
          signInPath: started.signInPath,
          connectionId: row.ref.id,
        });
        openSignIn(started.signInPath);
      }
    } catch (failure) {
      if (logger) logSettingsError(logger, 'reconnect a connection', failure);
      setReconnectError(
        settingsFailure(
          failure,
          settingsActionErrorCopy(failure, { action: `reconnect ${row.name}` }),
        ),
      );
    } finally {
      setReconnecting(null);
    }
  };

  // Both can hold at once (the member who created a member project edits
  // its skills but not its connections, and may not be on it): say both.
  const notes = [
    ...(setupCanEdit && !canEdit
      ? [
          'Only organization owners and admins can change this project’s connections.',
        ]
      : []),
    ...(connectors.canUse === false
      ? ['You need to be added to this project to use its shared connections.']
      : []),
  ];
  const subtitle = notes.length === 0 ? undefined : notes.join(' ');

  return (
    <>
      <SettingsCard
        title="Connectors"
        subtitle={subtitle}
        testId="project-setup-section-connectors"
      >
        <ErrorBanner
          errorSource="project-setup-connector-reconnect"
          testId="project-setup-connector-reconnect-error"
          className=""
          error={reconnectError?.copy}
          details={reconnectError?.details}
        />
        {reconnectSignIn !== null && openSignIn !== undefined && (
          <SignInPendingRow
            connectionName={
              rows.find((row) => row.ref.id === reconnectSignIn.connectionId)
                ?.name
            }
            onOpen={() => openSignIn(reconnectSignIn.signInPath)}
            testId="project-setup-connector-reconnect-pending"
            openTestId="project-setup-connector-reconnect-open-sign-in"
          />
        )}
        {rows.length === 0 ? (
          <EmptyStateRow
            title="No connectors in this project yet"
            testId="project-setup-section-connectors-empty"
          />
        ) : (
          rows.map((row) => (
            <ProjectConnectorRowView
              key={row.key}
              row={row}
              summary={connectorLimitSummary(
                row.limit,
                knownTools.get(row.ref.id) ?? null,
              )}
              alsoIn={(canEdit ? otherProjects : null)?.get(row.ref.id) ?? []}
              canEdit={canEdit}
              canReconnect={canReconnect}
              disabled={disabled || reconnecting !== null}
              busy={
                pendingKey === row.key ||
                pendingKey === projectConnectorLimitKey(row) ||
                reconnecting === row.key
              }
              onReconnect={() => void reconnect(row)}
              onSwitch={(on) => onSwitch(row, on)}
              onRemove={() => onRemove(row)}
              onEditTools={() => setEditing(row)}
            />
          ))
        )}
        {canEdit && (
          <AddConnectorRow
            offered={projectConnectorCandidates(connectors)}
            disabled={disabled}
            busy={pendingKey === PROJECT_CONNECTOR_ADD_KEY}
            onAdd={onAdd}
          />
        )}
        {canEdit && openSignIn !== undefined && onShared !== undefined && (
          <ShareYourConnectors
            client={client}
            organizationId={organizationId}
            projectId={projectId}
            yours={yours}
            disabled={disabled}
            openSignIn={openSignIn}
            onShared={onShared}
            connectionStatus={(connectionId) =>
              rows.find((row) => row.ref.id === connectionId)?.status
            }
            logger={logger}
          />
        )}
      </SettingsCard>
      {editing !== null && (
        <ConnectorToolsDialog
          client={client}
          organizationId={organizationId}
          row={editing}
          tools={knownTools.get(editing.ref.id) ?? null}
          busy={pendingKey === projectConnectorLimitKey(editing)}
          disabled={disabled}
          saveError={saveError}
          logger={logger}
          onToolsLoaded={rememberTools}
          onClose={() => setEditing(null)}
          onSave={async (limit) => {
            if (await onLimit(editing, limit)) setEditing(null);
          }}
        />
      )}
    </>
  );
}

function ProjectConnectorRowView({
  row,
  summary,
  alsoIn,
  canEdit,
  canReconnect,
  disabled,
  busy,
  onReconnect,
  onSwitch,
  onRemove,
  onEditTools,
}: {
  row: ProjectConnectorRow;
  summary: string;
  alsoIn: readonly ConnectorOtherProject[];
  canEdit: boolean;
  /** An owner or admin who can sign an expired connection in again here. */
  canReconnect: boolean;
  disabled: boolean;
  busy: boolean;
  onReconnect: () => void;
  onSwitch: (on: boolean) => void;
  onRemove: () => void;
  onEditTools: () => void;
}): JSX.Element {
  const nameId = useId();
  const editId = useId();
  const removeId = useId();
  const reconnectId = useId();
  const status = row.available ? sharedConnectionStatus(row.status) : undefined;
  // Its sign-in expired (CAN-6253): an admin reconnects it; anyone else is
  // told who can.
  const expired = row.available && row.status === 'needsSignIn';
  return (
    <div
      className={SETTINGS_CARD_ROW_CLASS}
      data-testid={`project-setup-row-${row.testKey}`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <p
            id={nameId}
            className={`truncate text-s font-medium fg-primary ${REPLAY_MASK_CLASS}`}
          >
            {row.name}
          </p>
          {!row.available && (
            <Badge data-testid={`project-setup-unavailable-${row.testKey}`}>
              Unavailable
            </Badge>
          )}
          {status !== undefined && (
            <Badge
              tone={status.tone}
              data-testid={`project-setup-connector-status-${row.testKey}`}
            >
              {status.label}
            </Badge>
          )}
        </div>
        <p
          className="text-xs text-pretty fg-secondary"
          data-testid={`project-setup-source-${row.testKey}`}
        >
          {PROJECT_SETUP_SOURCE_LABEL[row.source]}
        </p>
        {/* One detail line, as the setup's other rows have: what the
            project may use, then where else the connection is used. */}
        {!row.available ? (
          <p className="line-clamp-2 text-xs text-pretty fg-tertiary">
            It was deleted or is no longer the organization’s.
          </p>
        ) : row.on || alsoIn.length > 0 ? (
          <p className="line-clamp-2 text-xs text-pretty fg-tertiary">
            {row.on && (
              <span
                data-testid={`project-setup-connector-limit-${row.testKey}`}
              >
                {summary}
              </span>
            )}
            {row.on && alsoIn.length > 0 && ' · '}
            {alsoIn.length > 0 && (
              <span
                data-testid={`project-setup-connector-also-in-${row.testKey}`}
              >
                Also in <MaskedNameList names={alsoIn} />
              </span>
            )}
          </p>
        ) : null}
        {expired && (
          <p
            className="text-xs text-pretty fg-secondary"
            data-testid={`project-setup-connector-reconnect-prompt-${row.testKey}`}
          >
            {canReconnect ? (
              'Its sign-in expired, so this project can’t use it.'
            ) : (
              <>
                Ask an organization owner or admin to reconnect{' '}
                <span className={REPLAY_MASK_CLASS}>{row.name}</span>.
              </>
            )}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {expired && canReconnect && (
          <Button
            id={reconnectId}
            variant="secondary"
            size="compact"
            disabled={disabled}
            aria-busy={busy}
            aria-labelledby={`${reconnectId} ${nameId}`}
            data-testid={`project-setup-connector-reconnect-${row.testKey}`}
            onClick={onReconnect}
          >
            Reconnect
          </Button>
        )}
        {/* Its tools are read from the server with the organization's
            sign-in, so only a connected connection can list them. */}
        {canEdit && row.available && row.on && row.status === 'connected' && (
          <Button
            id={editId}
            variant="secondary"
            size="compact"
            disabled={disabled}
            aria-busy={busy}
            // The connection's name is masked in replay, so the button is
            // named by the masked element rather than an aria-label.
            aria-labelledby={`${editId} ${nameId}`}
            data-testid={`project-setup-connector-tools-${row.testKey}`}
            onClick={onEditTools}
          >
            Edit tools
          </Button>
        )}
        {row.source === 'organization' ? (
          // Masked so the switch's accessible name, which holds the
          // connection's name, stays out of replay; its clicks still record.
          <span className={REPLAY_MASK_CLASS}>
            <SettingsCardSwitch
              checked={row.on}
              disabled={disabled || !canEdit}
              busy={busy}
              label={`On in this project: ${row.name}`}
              onChange={onSwitch}
              dataTestId={`project-setup-toggle-${row.testKey}`}
            />
          </span>
        ) : canEdit ? (
          <Button
            id={removeId}
            variant="secondary"
            size="compact"
            disabled={disabled}
            aria-labelledby={`${removeId} ${nameId}`}
            data-testid={`project-setup-remove-${row.testKey}`}
            onClick={onRemove}
          >
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AddConnectorRow({
  offered,
  disabled,
  busy,
  onAdd,
}: {
  offered: readonly CapabilitySetupConnectorItem[];
  disabled: boolean;
  busy: boolean;
  onAdd: (item: CapabilitySetupConnectorItem) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div className={SETTINGS_CARD_ROW_CLASS}>
      <p
        className="text-xs text-pretty fg-secondary"
        data-testid="project-setup-add-connector-note"
      >
        {offered.length === 0
          ? // No navigation from here: the panel opens in desktop project
            // settings too, where the organization's pages are elsewhere.
            'No other connections to add. Connect one in the organization’s Connectors settings.'
          : 'Add one of the organization’s connections for everyone in this project.'}
      </p>
      <Button
        ref={anchorRef}
        variant="secondary"
        size="compact"
        disabled={disabled || offered.length === 0}
        aria-busy={busy}
        aria-expanded={open}
        data-testid="project-setup-add-connector"
        onClick={() => setOpen((current) => !current)}
      >
        Add connector
      </Button>
      <FloatingPickerMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        role="dialog"
        aria-label="Add connector"
      >
        <PickList
          items={offered}
          getKey={(item) => item.ref.id}
          getLabel={(item) => item.name}
          searchLabel="Search connectors"
          listLabel="Add connector"
          emptyLabel="No matches."
          listMaxHeight="md"
          optionTestId={(item) => `project-setup-add-option-${item.ref.id}`}
          onPick={(item) => {
            setOpen(false);
            onAdd(item);
          }}
          renderItem={(item) => {
            const status = sharedConnectionStatus(item.status)?.label;
            return (
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>
                  <span className={REPLAY_MASK_CLASS}>{item.name}</span>
                </PickerMenuOptionLabel>
                {status !== undefined ? (
                  <PickerMenuOptionDescription>
                    {status}
                  </PickerMenuOptionDescription>
                ) : null}
              </PickerMenuOptionContent>
            );
          }}
        />
      </FloatingPickerMenu>
    </div>
  );
}

const CHOICE_COPY: Record<ConnectorLimitChoice, string> = {
  all: 'All tools',
  readOnly: 'Read only',
  chosen: 'Chosen tools',
};

/** Sample tools for the editor while it loads: plain, of the loaded shape. */
const SAMPLE_TOOLS: readonly SharedConnectionTool[] = [
  { name: 'sample_tool_1', title: 'Sample tool' },
  { name: 'sample_tool_2', title: 'Sample tool' },
  { name: 'sample_tool_3', title: 'Sample tool' },
];

type ToolsRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: SettingsFailure }
  | {
      readonly kind: 'loaded';
      readonly tools: readonly SharedConnectionTool[];
    };

/**
 * The project's tool limit on one connection: every tool it allows, the
 * tools its server says change nothing, or a chosen list. The tools come
 * from the connection's server, which may be unreachable; then only "All
 * tools" and the names the limit already keeps can be chosen.
 */
function ConnectorToolsDialog({
  client,
  organizationId,
  row,
  tools: cachedTools,
  busy,
  disabled,
  saveError,
  logger,
  onToolsLoaded,
  onClose,
  onSave,
}: {
  client: AccountOrganizationSettingsClient;
  organizationId: string;
  row: ProjectConnectorRow;
  tools: readonly SharedConnectionTool[] | null;
  busy: boolean;
  disabled: boolean;
  saveError: SettingsFailure | null;
  logger: SettingsLogger | undefined;
  onToolsLoaded: (
    connectionId: string,
    tools: readonly SharedConnectionTool[],
  ) => void;
  onClose: () => void;
  onSave: (limit: string[] | null) => Promise<void>;
}): JSX.Element {
  const [read, setRead] = useState<ToolsRead>(
    cachedTools === null
      ? { kind: 'loading' }
      : { kind: 'loaded', tools: cachedTools },
  );
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState<ConnectorLimitChoice>(
    connectorLimitChoiceOf(row.limit, cachedTools),
  );
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    new Set(row.limit ?? []),
  );
  /** Whether the person changed the choice, so a late read leaves it be. */
  const touched = useRef(false);
  // Only the first save failure after opening belongs to this dialog.
  const [showSaveError, setShowSaveError] = useState(false);
  const connectionId = row.ref.id;
  const limit = row.limit;
  const needsRead = cachedTools === null || attempt > 0;

  useEffect(() => {
    if (!needsRead) return;
    let active = true;
    void (async (): Promise<void> => {
      try {
        const result = await client.read(
          'organization.settings.connections.tools',
          { organizationId, connectionId },
        );
        if (!active) return;
        setRead({ kind: 'loaded', tools: result.tools });
        onToolsLoaded(connectionId, result.tools);
        if (!touched.current)
          setChoice(connectorLimitChoiceOf(limit, result.tools));
      } catch (error) {
        if (!active) return;
        if (logger) logSettingsError(logger, 'load connection tools', error);
        setRead({
          kind: 'failed',
          failure: settingsFailure(error, TOOLS_LOAD_ERROR_COPY),
        });
      }
    })();
    return (): void => {
      active = false;
    };
  }, [
    client,
    organizationId,
    connectionId,
    limit,
    logger,
    attempt,
    needsRead,
    onToolsLoaded,
  ]);

  const tools = read.kind === 'loaded' ? read.tools : null;
  const readOnly = tools === null ? [] : connectorReadOnlyTools(tools);
  const options = connectorToolOptions(tools, limit);
  const locked = busy || disabled;
  // A limit names at most CAPABILITY_SETUP_CONNECTOR_TOOL_LIMIT tools; a
  // server can list more, so a choice past it can't be saved.
  const pendingLimit = connectorLimitFor(choice, chosen, options);
  const tooMany =
    pendingLimit !== null &&
    pendingLimit.length > CAPABILITY_SETUP_CONNECTOR_TOOL_LIMIT;
  const pick = (next: ConnectorLimitChoice): void => {
    touched.current = true;
    setChoice(next);
  };

  return (
    <DialogModal
      title="Edit tools"
      subtitle={<span className={REPLAY_MASK_CLASS}>{row.name}</span>}
      maxWidth="md"
      dataTestId="project-setup-connector-tools-dialog"
      closeOnBackdrop={!busy}
      closeButtonDisabled={busy}
      onClose={onClose}
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={busy}
            data-testid="project-setup-connector-tools-cancel"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="compact"
            disabled={
              locked || tooMany || (choice === 'readOnly' && tools === null)
            }
            data-testid="project-setup-connector-tools-save"
            onClick={() => {
              setShowSaveError(true);
              void onSave(pendingLimit);
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <ErrorBanner
        errorSource="project-setup-connector-tools-save"
        testId="project-setup-connector-tools-save-error"
        className=""
        error={showSaveError && !busy ? saveError?.copy : undefined}
        details={showSaveError && !busy ? saveError?.details : undefined}
      />
      {tooMany && (
        <Notice data-testid="project-setup-connector-tools-too-many">
          {`A project can allow up to ${CAPABILITY_SETUP_CONNECTOR_TOOL_LIMIT} tools from one connection. Choose fewer, or allow all tools.`}
        </Notice>
      )}
      <ErrorBanner
        errorSource="project-setup-connector-tools-load"
        testId="project-setup-connector-tools-load-error"
        className=""
        error={read.kind === 'failed' ? read.failure.copy : undefined}
        details={read.kind === 'failed' ? read.failure.details : undefined}
        onRetry={() => {
          setRead({ kind: 'loading' });
          setAttempt((current) => current + 1);
        }}
      />
      <ChoiceList
        kind="radio"
        aria-label="Tools this project can use"
        data-testid="project-setup-connector-tools-choice"
      >
        {(['all', 'readOnly', 'chosen'] as const).map((option) => (
          <ChoiceField
            key={option}
            layout="row"
            kind="radio"
            checked={choice === option}
            disabled={
              locked || (option === 'readOnly' && readOnly.length === 0)
            }
            focusableWhenDisabled
            data-testid={`project-setup-connector-tools-${option}`}
            end={
              option === 'readOnly' && tools !== null && readOnly.length === 0
                ? 'No read-only tools'
                : undefined
            }
            onChange={() => pick(option)}
            // Pressing the chosen row keeps it over the default the tools
            // load with; a radio fires no change for that press.
            onClick={choice === option ? () => pick(option) : undefined}
            label={CHOICE_COPY[option]}
          />
        ))}
      </ChoiceList>
      {choice === 'chosen' && (
        <div className="flex flex-col gap-1.5">
          {read.kind === 'loading' ? (
            <Skeleton
              loading
              label="Loading this connection's tools"
              testId="project-setup-connector-tools-loading"
              className="w-full"
            >
              <ToolChoices
                options={SAMPLE_TOOLS}
                chosen={new Set()}
                disabled
                onToggle={noop}
              />
            </Skeleton>
          ) : options.length === 0 ? (
            <p className="text-xs text-pretty fg-secondary">
              This connection offers no tools.
            </p>
          ) : (
            <ToolChoices
              options={options}
              chosen={chosen}
              disabled={locked}
              onToggle={(name) => {
                touched.current = true;
                setChosen((current) => {
                  const next = new Set(current);
                  if (next.has(name)) next.delete(name);
                  else next.add(name);
                  return next;
                });
              }}
            />
          )}
          {chosen.size === 0 && read.kind !== 'loading' && (
            <p
              className="text-xs text-pretty fg-secondary"
              data-testid="project-setup-connector-tools-none"
            >
              No tools chosen, so agents in this project can’t use this
              connection.
            </p>
          )}
        </div>
      )}
    </DialogModal>
  );
}

function ToolChoices({
  options,
  chosen,
  disabled,
  onToggle,
}: {
  options: readonly SharedConnectionTool[];
  chosen: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (name: string) => void;
}): JSX.Element {
  // The list scrolls inside a bounded parent; ChoiceList owns its own box.
  return (
    <div className="flex max-h-72 min-h-0 flex-col">
      <ChoiceList
        aria-label="Chosen tools"
        data-testid="project-setup-connector-tools-list"
      >
        {options.map((tool) => (
          <ChoiceField
            key={tool.name}
            layout="row"
            checked={chosen.has(tool.name)}
            disabled={disabled}
            data-testid={`project-setup-connector-tool-${tool.name}`}
            end={tool.readOnly === true ? 'Read only' : undefined}
            onChange={() => onToggle(tool.name)}
            label={
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{tool.title ?? tool.name}</span>
                {tool.description !== undefined && (
                  <span className="line-clamp-2 text-xs text-pretty fg-secondary">
                    {tool.description}
                  </span>
                )}
              </span>
            }
          />
        ))}
      </ChoiceList>
    </div>
  );
}

const noop = (): void => undefined;

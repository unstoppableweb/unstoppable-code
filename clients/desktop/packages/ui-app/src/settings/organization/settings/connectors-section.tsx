'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  Badge,
  Button,
  DelayedLoadingPlaceholder,
  Divider,
  EmptyStateRow,
  ErrorBanner,
  Notice,
  NoticeButton,
  OverlayScrollArea,
  PageSearchField,
  PageSearchRow,
  Skeleton,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import type {
  OrganizationConnection,
  SharedConnectionCatalogEntry,
  SharedConnectionStartResult,
} from '@canopy/protocol/canopy-core';
import { ConnectionProjectsDialog } from './connection-projects-dialog';
import {
  connectionProjectsSummary,
  type ConnectionProjectsSummary,
} from './connection-projects-model';
import { ConnectionUsageCard } from './connection-usage-card';
import {
  matchesCatalogSearch,
  matchesConnectionSearch,
} from './connectors-search';
import {
  MaskedNameList,
  sharedConnectionStatus,
  SignInPendingRow,
  useReadAgainOnReturn,
} from './shared-connection-display';
import {
  SettingsConfirmDialog,
  useSettingsClient,
  useSettingsHost,
  useSettingsNavigation,
} from '../../host';
import {
  useSettingsErrorCopy,
  useSettingsLoadFailure,
  type KnownSettingsError,
  type SettingsFailure,
} from '../../errors';

const CONNECTORS_ERROR_SCOPE = 'settings.organization.connectors';

/** A server that predates the page (desktop against an older web). */
const LOAD_KNOWN: readonly KnownSettingsError[] = [
  {
    code: 'unsupported_server',
    copy: "Shared connections aren't available yet.",
  },
];

interface ConnectorsState {
  readonly connections: readonly OrganizationConnection[];
  readonly catalog: readonly SharedConnectionCatalogEntry[];
}

/** What the page is asking the admin to confirm. */
type Confirming =
  | { readonly kind: 'connect'; readonly entry: SharedConnectionCatalogEntry }
  | { readonly kind: 'remove'; readonly connection: OrganizationConnection }
  | {
      readonly kind: 'disconnect';
      readonly connection: OrganizationConnection;
    };

/**
 * The organization's connections (CAN-6245; spec FR-3.1): the tools the
 * organization holds for its projects, who connected each and the projects
 * that use it. Owners and admins connect, reconnect, disconnect and delete
 * them here; members never see this page. Connecting always starts a fresh
 * sign-in owned by the organization, and the dialog says so before it starts.
 */
export function ConnectorsSection({
  detail,
}: {
  detail: OrganizationDetail;
}): JSX.Element {
  const client = useSettingsClient();
  const navigation = useSettingsNavigation();
  const host = useSettingsHost();
  const orgId = detail.id;
  const loadFailure = useSettingsLoadFailure(CONNECTORS_ERROR_SCOPE);
  const errorCopy = useSettingsErrorCopy(CONNECTORS_ERROR_SCOPE);
  const [state, setState] = useState<ConnectorsState | null>(null);
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [actionError, setActionError] = useState<SettingsFailure | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [busy, setBusy] = useState(false);
  /** A sign-in opened in the browser; the list is read again on return. */
  const [signingIn, setSigningIn] = useState(false);
  // The last sign-in opened, offered again in case the browser blocked it:
  // on web it opens after the start request, outside the click.
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const generation = useRef(0);
  /** The connection whose projects are being chosen. */
  const [choosingId, setChoosingId] = useState<string | null>(null);
  /** A connection just connected and in no project yet, offered sharing. */
  const [promptId, setPromptId] = useState<string | null>(null);
  /**
   * The connection this page's last connect started, named by the server:
   * once it is connected, and in no project yet, it is offered sharing.
   * Never another admin's connection, which the list also shows.
   */
  const startedConnectionId = useRef<string | null>(null);

  const reload = useCallback((): void => {
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    let active = true;
    void (async (): Promise<void> => {
      try {
        const result = await client.read('organization.settings.connections', {
          organizationId: orgId,
        });
        if (!active || current !== generation.current) return;
        setState({
          connections: result.connections,
          catalog: result.catalog ?? [],
        });
        const started = result.connections.find(
          (connection) => connection.id === startedConnectionId.current,
        );
        if (started !== undefined && started.status !== 'pending') {
          startedConnectionId.current = null;
          if (
            started.status === 'connected' &&
            connectionProjectsSummary(started).kind === 'none'
          )
            setPromptId(started.id);
        }
        // Connect and reconnect leave the row pending until the sign-in
        // completes; once none is pending there is nothing left to finish.
        if (
          !result.connections.some(
            (connection) => connection.status === 'pending',
          )
        ) {
          setSigningIn(false);
          setSignInUrl(null);
        }
        setLoadError(null);
      } catch (error) {
        if (!active || current !== generation.current) return;
        setLoadError(loadFailure(error, LOAD_KNOWN));
      }
    })();
    return (): void => {
      active = false;
    };
  }, [client, orgId, loadFailure, loadAttempt]);

  useReadAgainOnReturn(signingIn, reload);

  /** Opens the sign-in, or shows the connection when none was needed. */
  const followStart = (started: SharedConnectionStartResult): void => {
    if (started.signInPath !== undefined) {
      const url = new URL(started.signInPath, host.webOrigin()).toString();
      navigation.openExternal(url);
      setSignInUrl(url);
      setSigningIn(true);
      return;
    }
    reload();
  };

  const run = async (
    action: string,
    work: () => Promise<void>,
  ): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      setConfirming(null);
    } catch (error) {
      setActionError(errorCopy.actionFailure(error, { action }));
    } finally {
      setBusy(false);
    }
  };

  const confirm = (): void => {
    if (confirming === null) return;
    if (confirming.kind === 'connect')
      void run(`connect ${confirming.entry.name}`, async () => {
        const started = await client.write(
          'organization.settings.connections.connect',
          {
            organizationId: orgId,
            serverKey: confirming.entry.serverKey,
            idempotencyKey: crypto.randomUUID(),
          },
        );
        // A server from before `connectionId` names it only when no
        // sign-in was needed; without either, nothing is offered.
        startedConnectionId.current =
          started.connection?.id ?? started.connectionId ?? null;
        setPromptId(null);
        followStart(started);
      });
    else if (confirming.kind === 'disconnect')
      void run(`disconnect ${confirming.connection.name}`, async () => {
        await client.write('organization.settings.connections.disconnect', {
          organizationId: orgId,
          connectionId: confirming.connection.id,
          idempotencyKey: crypto.randomUUID(),
        });
        reload();
      });
    else
      void run(`delete ${confirming.connection.name}`, async () => {
        await client.write('organization.settings.connections.remove', {
          organizationId: orgId,
          connectionId: confirming.connection.id,
          idempotencyKey: crypto.randomUUID(),
        });
        reload();
      });
  };

  const reconnect = (connection: OrganizationConnection): void => {
    void run(`reconnect ${connection.name}`, async () => {
      followStart(
        await client.write('organization.settings.connections.reconnect', {
          organizationId: orgId,
          connectionId: connection.id,
          idempotencyKey: crypto.randomUUID(),
        }),
      );
    });
  };

  if (state === null) {
    if (loadError !== null)
      return (
        <ErrorBanner
          errorSource="organization-connectors-load"
          testId="organization-connectors-load-error"
          className=""
          error={loadError.copy}
          details={loadError.details}
          onRetry={() => {
            setLoadError(null);
            reload();
          }}
        />
      );
    return (
      <DelayedLoadingPlaceholder>
        <ConnectorsSkeleton />
      </DelayedLoadingPlaceholder>
    );
  }

  const choosing =
    state.connections.find((connection) => connection.id === choosingId) ??
    null;
  const prompted =
    state.connections.find(
      (connection) =>
        connection.id === promptId &&
        connection.status === 'connected' &&
        connectionProjectsSummary(connection).kind === 'none',
    ) ?? null;
  const searching = query.trim() !== '';
  const connections = state.connections.filter((connection) =>
    matchesConnectionSearch(connection, query),
  );
  const catalog = state.catalog.filter((entry) =>
    matchesCatalogSearch(entry, query),
  );
  const total = state.connections.length + state.catalog.length;

  return (
    <div className="flex flex-col gap-10" data-testid="organization-connectors">
      {/* Just connected and in no project yet: offer the next step here,
          where the person already is, rather than on another tab. */}
      {prompted !== null && (
        <Notice
          intent="positive"
          title={
            <>
              <span className={REPLAY_MASK_CLASS}>{prompted.name}</span> is
              connected
            </>
          }
          data-testid="organization-connectors-share-prompt"
          actions={
            <>
              <NoticeButton
                variant="secondary"
                onClick={() => setPromptId(null)}
                data-testid="organization-connectors-share-prompt-later"
              >
                Later
              </NoticeButton>
              <NoticeButton
                variant="primary"
                onClick={() => {
                  setPromptId(null);
                  setChoosingId(prompted.id);
                }}
                data-testid="organization-connectors-share-prompt-choose"
              >
                Choose projects
              </NoticeButton>
            </>
          }
        >
          Choose the projects that can use it.
        </Notice>
      )}
      {/* A refresh that failed after the first load: the rows below may be
          out of date, so say so and offer to read again. */}
      <ErrorBanner
        errorSource="organization-connectors-reload"
        testId="organization-connectors-reload-error"
        className=""
        error={loadError?.copy}
        details={loadError?.details}
        onRetry={() => {
          setLoadError(null);
          reload();
        }}
      />
      <ErrorBanner
        errorSource="organization-connectors-action"
        testId="organization-connectors-error"
        className=""
        error={confirming === null ? actionError?.copy : undefined}
        details={confirming === null ? actionError?.details : undefined}
      />
      <div className="flex flex-col gap-4">
        {total > 0 && (
          <PageSearchRow>
            <PageSearchField
              aria-label="Search connectors"
              placeholder="Search connectors"
              data-testid="organization-connectors-search"
              clearTestId="organization-connectors-search-clear"
              value={query}
              onValueChange={setQuery}
              count={
                searching
                  ? `${connections.length + catalog.length} of ${total}`
                  : undefined
              }
            />
          </PageSearchRow>
        )}
        <div className="flex flex-col gap-10">
          <SettingsCard
            title="Shared connections"
            subtitle="Tools connected as the organization. People on the projects that use one can use it without seeing its sign-in."
            testId="organization-connectors-connections"
          >
            {state.connections.length === 0 ? (
              <EmptyStateRow
                title="The organization doesn't hold any connections yet"
                testId="organization-connectors-empty"
              />
            ) : connections.length === 0 ? (
              <EmptyStateRow
                title="No connections match your search"
                testId="organization-connectors-no-results"
              />
            ) : (
              <ConnectorRowsScroller testId="organization-connectors-connections-list">
                {connections.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    disabled={busy}
                    onChooseProjects={() => {
                      setActionError(null);
                      setPromptId(null);
                      setChoosingId(connection.id);
                    }}
                    onReconnect={() => reconnect(connection)}
                    onDisconnect={() => {
                      setActionError(null);
                      setConfirming({ kind: 'disconnect', connection });
                    }}
                    onRemove={() => {
                      setActionError(null);
                      setConfirming({ kind: 'remove', connection });
                    }}
                  />
                ))}
              </ConnectorRowsScroller>
            )}
          </SettingsCard>
          <SettingsCard
            title="Connect a tool"
            subtitle="Sign in as the organization, then choose the projects that can use it."
            testId="organization-connectors-catalog"
          >
            {signingIn && signInUrl !== null && (
              <SignInPendingRow
                onOpen={() => navigation.openExternal(signInUrl)}
                testId="organization-connectors-sign-in-pending"
                openTestId="organization-connectors-open-sign-in"
              />
            )}
            {state.catalog.length === 0 ? (
              <EmptyStateRow
                title="No tools can be connected for the organization yet"
                testId="organization-connectors-catalog-empty"
              />
            ) : catalog.length === 0 ? (
              <EmptyStateRow
                title="No tools match your search"
                testId="organization-connectors-catalog-no-results"
              />
            ) : (
              <>
                {/* Rows split themselves; the scroller after the sign-in
                    row isn't one, so it draws that row's hairline. */}
                {signingIn && signInUrl !== null && <Divider />}
                <ConnectorRowsScroller testId="organization-connectors-catalog-list">
                  {catalog.map((entry) => (
                    <div
                      key={entry.serverKey}
                      className={SETTINGS_CARD_ROW_CLASS}
                      data-testid={`organization-connectors-catalog-${entry.serverKey}`}
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <p className="truncate text-s font-medium fg-primary">
                          {entry.name}
                        </p>
                        {!entry.available && (
                          <p className="text-xs text-pretty fg-secondary">
                            Connects as a bot, which isn&apos;t set up yet.
                          </p>
                        )}
                      </div>
                      <Button
                        size="compact"
                        variant="secondary"
                        disabled={busy || !entry.available}
                        onClick={() => {
                          setActionError(null);
                          setConfirming({ kind: 'connect', entry });
                        }}
                        data-testid={`organization-connectors-connect-${entry.serverKey}`}
                      >
                        Connect
                      </Button>
                    </div>
                  ))}
                </ConnectorRowsScroller>
              </>
            )}
          </SettingsCard>
        </div>
      </div>
      {confirming !== null && (
        <SettingsConfirmDialog
          title={confirmTitle(confirming)}
          message={<ConfirmMessage confirming={confirming} />}
          confirmLabel={confirmLabel(confirming)}
          busyLabel={confirming.kind === 'connect' ? 'Starting…' : 'Working…'}
          busy={busy}
          destructive={confirming.kind !== 'connect'}
          onConfirm={confirm}
          onCancel={() => {
            setConfirming(null);
            setActionError(null);
          }}
          errorMessage={actionError?.copy ?? null}
          errorSource="organization-connectors-confirm"
          {...(actionError?.details === undefined
            ? {}
            : { errorDetails: actionError.details })}
          dataTestId={`organization-connectors-confirm-${confirming.kind}`}
        />
      )}
      {choosing !== null && (
        <ConnectionProjectsDialog
          organizationId={orgId}
          connection={choosing}
          onClose={() => setChoosingId(null)}
          onSaved={reload}
        />
      )}
      <ConnectionUsageCard organizationId={orgId} />
    </div>
  );
}

/**
 * A card's rows, capped at five and a half: an organization can hold, and
 * connect, many tools, and the page has more below. The cap cuts the sixth
 * row through its middle, so the list reads as scrollable and never ends on
 * a row's hairline just above the box's own edge. The scroller spans the
 * box's side inset so its overlay thumb rides the box's edge while the rows
 * keep theirs.
 */
function ConnectorRowsScroller({
  children,
  testId,
}: {
  children: ReactNode;
  testId: string;
}): JSX.Element {
  return (
    <OverlayScrollArea
      className="-mx-4 max-h-88"
      contentClassName="px-4"
      edgeFadeSize={24}
      viewportProps={{ 'data-testid': testId }}
    >
      {children}
    </OverlayScrollArea>
  );
}

function confirmTitle(confirming: Confirming): string {
  switch (confirming.kind) {
    case 'connect':
      return `Connect ${confirming.entry.name} for the organization?`;
    case 'disconnect':
      return `Disconnect ${confirming.connection.name}?`;
    case 'remove':
      return `Delete ${confirming.connection.name}?`;
  }
}

function confirmLabel(confirming: Confirming): string {
  switch (confirming.kind) {
    case 'connect':
      return 'Continue to sign in';
    case 'disconnect':
      return 'Disconnect';
    case 'remove':
      return 'Delete';
  }
}

function ConfirmMessage({
  confirming,
}: {
  confirming: Confirming;
}): JSX.Element {
  if (confirming.kind === 'connect')
    return (
      <div className="flex flex-col gap-2">
        <p>
          The organization will hold this connection. Next, you&apos;ll choose
          the projects that can use it. Nobody sees its sign-in.
        </p>
        {confirming.entry.identityKind === 'user' && (
          <p data-testid="organization-connectors-acts-as-you">
            You&apos;ll sign in with your own account, so teammates&apos; agents
            will act as you in {confirming.entry.name}.
          </p>
        )}
      </div>
    );
  const used = confirming.connection.projects.length > 0;
  const names = <MaskedNameList names={confirming.connection.projects} />;
  if (confirming.kind === 'disconnect')
    return (
      <p>
        {used ? (
          <>It stops working in {names} until someone reconnects it.</>
        ) : (
          'It stops working until someone reconnects it.'
        )}
      </p>
    );
  return (
    <p>
      {used ? (
        <>
          It&apos;s removed from {names}, and their chats and scheduled runs
          that use it stop working. This can&apos;t be undone.
        </>
      ) : (
        "It's removed from the organization. This can't be undone."
      )}
    </p>
  );
}

/** Where a connection is used, as its row says it. */
function ProjectsSummaryText({
  summary,
}: {
  summary: ConnectionProjectsSummary;
}): JSX.Element {
  switch (summary.kind) {
    case 'every':
      // A default, never "every project": private projects can switch it
      // off without being named, so the named exceptions are only those an
      // admin can see.
      return summary.excluded !== undefined && summary.excluded.length > 0 ? (
        <>
          On by default for projects, except{' '}
          <MaskedNameList names={summary.excluded} />.
        </>
      ) : (
        <>On by default for projects, including new ones.</>
      );
    case 'some':
      return (
        <>
          Used in <MaskedNameList names={summary.projects} />.
        </>
      );
    case 'none':
      return <>Not in any project yet.</>;
  }
}

function ConnectionRow({
  connection,
  disabled,
  onChooseProjects,
  onReconnect,
  onDisconnect,
  onRemove,
}: {
  connection: OrganizationConnection;
  disabled: boolean;
  onChooseProjects: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
}): JSX.Element {
  const status = sharedConnectionStatus(connection.status);
  const summary = connectionProjectsSummary(connection);
  const expired = connection.status === 'needsSignIn';
  const testKey = connection.id;
  return (
    <div
      className={SETTINGS_CARD_ROW_CLASS}
      data-testid={`organization-connector-row-${testKey}`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <p
            className={`truncate text-s font-medium fg-primary ${REPLAY_MASK_CLASS}`}
          >
            {connection.name}
          </p>
          {/* Who the service sees acting. A person is the usual case, so
              only a bot is marked. */}
          {connection.identityKind === 'bot' && <Badge>Bot</Badge>}
          {status !== undefined && (
            <Badge
              tone={status.tone}
              data-testid={`organization-connector-status-${testKey}`}
            >
              {status.label}
            </Badge>
          )}
        </div>
        <p className="text-xs text-pretty fg-secondary">
          {connection.connectedBy && (
            <>
              Connected by{' '}
              <span className={REPLAY_BLOCK_CLASS}>
                {connection.connectedBy.name}
              </span>
              .{' '}
            </>
          )}
          {/* A sign-in that expired stops it everywhere until an owner or
              admin signs in again (CAN-6253). */}
          {expired ? (
            <span
              data-testid={`organization-connector-reconnect-prompt-${testKey}`}
            >
              {summary.kind === 'every' ? (
                'Its sign-in expired, so it stopped working wherever it’s used.'
              ) : summary.kind === 'some' ? (
                <>
                  Its sign-in expired, so it stopped working in{' '}
                  <MaskedNameList names={summary.projects} />.
                </>
              ) : (
                'Its sign-in expired.'
              )}
            </span>
          ) : (
            <span data-testid={`organization-connector-projects-${testKey}`}>
              <ProjectsSummaryText summary={summary} />
            </span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* Pending until its sign-in completes: nothing to share yet. */}
        {connection.status !== 'pending' && (
          <Button
            size="compact"
            variant="secondary"
            disabled={disabled}
            onClick={onChooseProjects}
            data-testid={`organization-connector-choose-projects-${testKey}`}
          >
            Choose projects
          </Button>
        )}
        {connection.status === 'connected' ? (
          <Button
            size="compact"
            variant="secondary"
            disabled={disabled}
            onClick={onDisconnect}
            data-testid={`organization-connector-disconnect-${testKey}`}
          >
            Disconnect
          </Button>
        ) : (
          <Button
            size="compact"
            variant="secondary"
            disabled={disabled}
            onClick={onReconnect}
            data-testid={`organization-connector-reconnect-${testKey}`}
          >
            Reconnect
          </Button>
        )}
        <Button
          size="compact"
          variant="ghost-destructive"
          disabled={disabled}
          onClick={onRemove}
          data-testid={`organization-connector-remove-${testKey}`}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

const SAMPLE_CONNECTION: OrganizationConnection = {
  id: 'sample',
  serverKey: 'sample',
  configId: 'org-sample',
  name: 'Sample connection',
  serviceName: 'Sample',
  label: null,
  identityKind: 'user',
  status: 'connected',
  connectedBy: { name: 'Sample person' },
  connectedAt: null,
  organizationDefault: false,
  projects: [],
};

const noop = (): void => undefined;

function ConnectorsSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading connections"
      testId="settings-skeleton-form"
      className="w-full"
    >
      <SettingsCard title="Shared connections" subtitle="">
        <ConnectionRow
          connection={SAMPLE_CONNECTION}
          disabled
          onChooseProjects={noop}
          onReconnect={noop}
          onDisconnect={noop}
          onRemove={noop}
        />
        <ConnectionRow
          connection={{ ...SAMPLE_CONNECTION, id: 'sample-2' }}
          disabled
          onChooseProjects={noop}
          onReconnect={noop}
          onDisconnect={noop}
          onRemove={noop}
        />
      </SettingsCard>
    </Skeleton>
  );
}

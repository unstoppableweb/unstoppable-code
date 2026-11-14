'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  Button,
  ConfirmDialog,
  McpConnectionStatusBadge,
  SettingsSelect,
} from '@canopy/ui-shared';
import {
  Stack,
  DetailMoreMenu,
  DetailPageActions,
  ErrorBanner,
  Heading,
  Notice,
  DETAIL_FACT_VALUE_OFFSET_CLASS,
  DetailFact,
  DetailFactList,
  Tooltip,
  useContributeDetailMoreItems,
  type DetailMoreMenuItem,
} from '@canopy/ui-shared/components';
import { TrashIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  mcpAuthStatusBadgeClass,
  mcpAuthStatusLabel,
  mcpDeleteScopeDescription,
  mcpPlacementLabel,
  resolveMcpConnectionBadge,
  type McpCardAuthStatus,
  type McpConnectionStatusSource,
  type McpServerPlacement,
} from '@canopy/ui-shared/lib/mcp-card-display';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type { HostAction } from '@canopy/ui-shared/lib/host-action';

/**
 * A host port for one MCP action. An omitted port means the action does not
 * apply to this server; an unavailable port renders disabled with its reason.
 */
export type McpAction<F> = HostAction<F>;

/** Cached status, structurally satisfied by desktop entries and the Portal projection. */
export interface McpHealthStatusInput extends McpConnectionStatusSource {
  readonly configs: ReadonlyArray<{
    readonly configId: string;
    readonly authStatus: string;
    readonly canRefresh?: boolean;
  }>;
  readonly lastCheckedAt?: string;
}

export interface McpTestConnectionOutcome {
  readonly success: boolean;
  readonly message: string;
  readonly error?: string;
  readonly tools?: readonly string[];
  readonly responseTime?: number;
}

export interface McpHealthConfigOption {
  readonly id: string;
  readonly name: string;
}

const AUTH_STATUSES: ReadonlySet<string> = new Set<McpCardAuthStatus>([
  'unsupported',
  'not_configured',
  'not_connected',
  'connected',
  'expired',
  'error',
]);

function isAuthStatus(value: string): value is McpCardAuthStatus {
  return AUTH_STATUSES.has(value);
}

function defaultFormatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

function validTimestamp(value: string | undefined): string | undefined {
  return value !== undefined && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** A disabled control's reason, read inline and by assistive technology. */
function UnavailableReason({
  id,
  testId,
  children,
}: {
  id: string;
  testId: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <p id={id} data-testid={testId} className="sr-only">
      {children}
    </p>
  );
}

/** Says why a button is disabled on hover; the button itself can't take focus. */
function UnavailableTooltip({
  reason,
  children,
}: {
  reason: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  if (reason === undefined) return children;
  return (
    <Tooltip label={reason}>
      <span
        tabIndex={0}
        role="group"
        aria-label={reason}
        className="focus-ring inline-flex"
      >
        {children}
      </span>
    </Tooltip>
  );
}

export interface McpServerHealthSectionProps {
  /** Canonical identity; results and pending work never outlive it. */
  readonly targetKey: string;
  readonly status?: McpHealthStatusInput;
  /** Cloud connection state, used only when no cached status exists. */
  readonly accountConnectionStatus?: string;
  readonly configs: readonly McpHealthConfigOption[];
  /** Configurations the host can test; defaults to every configuration. */
  readonly testableConfigIds?: readonly string[];
  /** Omitted when testing does not apply to this server. */
  readonly testConnection?: McpAction<
    (configId: string) => Promise<McpTestConnectionOutcome>
  >;
  /** Disables testing while another action on this server runs. */
  readonly busy?: boolean;
  readonly onPendingChange?: (pending: boolean) => void;
  /** Called after a finished test so the host can refetch status. */
  readonly onTested?: () => void;
  readonly formatTimestamp?: (iso: string) => string;
  /**
   * `section` (default) is the MCP server page's titled Health section;
   * `inline` drops the heading and fits one table row: health on the left,
   * Test connection on the right (the plugin detail's MCP servers rows);
   * `row` is the Health row of {@link McpServerManagementCard}.
   */
  readonly presentation?: 'section' | 'inline' | 'row';
  /** The inline group's accessible name; defaults to "Health". */
  readonly label?: string;
}

interface KeyedOutcome {
  readonly key: string;
  readonly outcome: McpTestConnectionOutcome;
}

/**
 * Cached health, per-configuration auth, and Test connection for one MCP
 * server. Shows the recorded check time and never infers freshness.
 */
export function McpServerHealthSection(
  props: McpServerHealthSectionProps,
): JSX.Element {
  return <McpServerHealthSectionForTarget key={props.targetKey} {...props} />;
}

function McpServerHealthSectionForTarget({
  targetKey,
  status,
  accountConnectionStatus,
  configs,
  testableConfigIds,
  testConnection,
  busy = false,
  onPendingChange,
  onTested,
  formatTimestamp = defaultFormatTimestamp,
  presentation = 'section',
  label = 'Health',
}: McpServerHealthSectionProps): JSX.Element {
  const reasonId = useId();
  const badge = resolveMcpConnectionBadge(status, accountConnectionStatus);
  const lastCheckedAt = validTimestamp(status?.lastCheckedAt);
  const testable = configs.filter(
    (config) =>
      testableConfigIds === undefined || testableConfigIds.includes(config.id),
  );
  const [selectedConfigId, setSelectedConfigId] = useState<string | undefined>(
    testable[0]?.id,
  );
  // Repair a selection the configuration list no longer offers.
  const effectiveConfigId = testable.some(
    (config) => config.id === selectedConfigId,
  )
    ? selectedConfigId
    : testable[0]?.id;
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [result, setResult] = useState<KeyedOutcome | null>(null);
  const generationRef = useRef(0);

  const resultKey =
    effectiveConfigId === undefined
      ? null
      : `${targetKey}\u0000${effectiveConfigId}`;
  const pendingRef = useRef(false);
  const currentKeyRef = useRef(resultKey);
  currentKeyRef.current = resultKey;
  useEffect(() => {
    generationRef.current += 1;
    pendingRef.current = false;
    setPendingKey(null);
    setResult(null);
    setSelectedConfigId(effectiveConfigId);
    return (): void => {
      generationRef.current += 1;
    };
  }, [targetKey, effectiveConfigId]);

  useEffect(() => {
    onPendingChange?.(pendingKey !== null);
    return (): void => onPendingChange?.(false);
  }, [onPendingChange, pendingKey]);

  const shownResult =
    result !== null && result.key === resultKey ? result.outcome : null;
  const pending = pendingKey !== null;

  const handleTest = useCallback(async (): Promise<void> => {
    if (
      testConnection?.available !== true ||
      effectiveConfigId === undefined ||
      resultKey === null ||
      pendingRef.current ||
      busy
    )
      return;
    const generation = generationRef.current;
    pendingRef.current = true;
    setPendingKey(resultKey);
    setResult(null);
    let outcome: McpTestConnectionOutcome;
    try {
      outcome = await testConnection.run(effectiveConfigId);
    } catch (error) {
      outcome = {
        success: false,
        message: 'Connection test failed',
        error: errorText(error, 'The test did not finish.'),
      };
    }
    if (
      generation !== generationRef.current ||
      resultKey !== currentKeyRef.current
    )
      return;
    pendingRef.current = false;
    setPendingKey(null);
    setResult({ key: resultKey, outcome });
    onTested?.();
  }, [busy, effectiveConfigId, onTested, resultKey, testConnection]);

  const testReason =
    testConnection === undefined
      ? undefined
      : !testConnection.available
        ? testConnection.reason
        : testable.length === 0
          ? 'Add a configuration before testing this server.'
          : undefined;
  const authRows = (status?.configs ?? []).flatMap((config) => {
    if (!isAuthStatus(config.authStatus)) return [];
    const name = configs.find((option) => option.id === config.configId)?.name;
    if (name === undefined) return [];
    return [{ ...config, authStatus: config.authStatus, name }];
  });

  const badgeNode = (
    <McpConnectionStatusBadge
      badge={badge}
      dataTestId="mcp-health-badge"
      providerTestId="mcp-health-provider"
    />
  );
  const lastCheckedNode = (
    <p data-testid="mcp-health-last-checked" className="text-xs fg-tertiary">
      {lastCheckedAt !== undefined
        ? `Last checked ${formatTimestamp(lastCheckedAt)}`
        : 'No recorded check'}
    </p>
  );
  const authListOf = (rows: typeof authRows): ReactNode =>
    rows.length > 0 && (
      <Stack as="ul" gap="tight">
        {rows.map((config) => (
          <li
            key={config.configId}
            data-testid={`mcp-health-auth-${config.configId}`}
            className="flex items-center gap-2 text-xs fg-secondary"
          >
            <span className="min-w-0 truncate">{config.name}</span>
            <span
              className={mcpAuthStatusBadgeClass(
                config.authStatus,
                config.canRefresh,
              )}
            >
              {mcpAuthStatusLabel(config.authStatus, config.canRefresh)}
            </span>
          </li>
        ))}
      </Stack>
    );
  const testButtons = (
    <div className="flex flex-wrap items-center gap-2">
      {testable.length > 1 && (
        <SettingsSelect
          aria-label="Configuration to test"
          data-testid="mcp-health-config-select"
          width="fit"
          value={effectiveConfigId ?? null}
          disabled={pending}
          onValueChange={setSelectedConfigId}
          options={testable.map((config) => ({
            value: config.id,
            label: config.name,
          }))}
        />
      )}
      <UnavailableTooltip reason={testReason}>
        <Button
          variant="secondary"
          size="compact"
          data-testid="mcp-health-test"
          disabled={testReason !== undefined || pending || busy}
          aria-describedby={testReason !== undefined ? reasonId : undefined}
          onClick={(): void => {
            void handleTest();
          }}
        >
          {pending ? 'Testing…' : 'Test connection'}
        </Button>
      </UnavailableTooltip>
    </div>
  );
  const testFeedback = (
    <>
      {testReason !== undefined && (
        <UnavailableReason id={reasonId} testId="mcp-health-test-reason">
          {testReason}
        </UnavailableReason>
      )}
      {shownResult !== null && <TestResultPanel outcome={shownResult} />}
    </>
  );

  if (presentation === 'row') {
    // One configuration's "Connected" under a Connected badge repeats it, and
    // its "No auth" repeats the Connection row. Other statuses add something.
    const onlyRow =
      configs.length === 1 && authRows.length === 1 ? authRows[0] : undefined;
    const repeatsBadge =
      onlyRow?.authStatus === 'not_configured' ||
      (onlyRow?.authStatus === 'connected' && badge.status === 'connected');
    return (
      <section
        data-testid="mcp-health-section"
        aria-label={label}
        className="flex flex-col gap-1"
      >
        <DetailFactList>
          <DetailFact label="Health">
            {badgeNode}
            {lastCheckedNode}
            {testConnection !== undefined && (
              <span className="ml-auto">{testButtons}</span>
            )}
          </DetailFact>
        </DetailFactList>
        <div
          className={`${DETAIL_FACT_VALUE_OFFSET_CLASS} flex flex-col gap-2 empty:hidden`}
        >
          {!repeatsBadge && authListOf(authRows)}
          {testConnection !== undefined && testFeedback}
        </div>
      </section>
    );
  }

  const authList = authListOf(authRows);
  const testControls = (
    <>
      {testButtons}
      {testFeedback}
    </>
  );

  if (presentation === 'inline') {
    // Inline renders once per server row, so it is a group rather than a
    // repeated "Health" landmark.
    return (
      <div
        role="group"
        data-testid="mcp-health-section"
        aria-label={label}
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <Stack gap="tight" className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {badgeNode}
            {lastCheckedNode}
          </div>
          {authList}
        </Stack>
        {testConnection !== undefined && (
          <div className="flex min-w-0 flex-col items-end gap-2">
            {testControls}
          </div>
        )}
      </div>
    );
  }

  return (
    <Stack
      data-testid="mcp-health-section"
      aria-labelledby={`${reasonId}-heading`}
      as="section"
      gap="item"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading level={3} variant="title" id={`${reasonId}-heading`}>
          Health
        </Heading>
        {badgeNode}
      </div>
      {lastCheckedNode}
      {authList}
      {testConnection !== undefined && (
        <Stack gap="inline">{testControls}</Stack>
      )}
    </Stack>
  );
}

function TestResultPanel({
  outcome,
}: {
  outcome: McpTestConnectionOutcome;
}): JSX.Element {
  const showError =
    outcome.error !== undefined && outcome.error !== outcome.message;
  const tools = outcome.tools ?? [];
  const showTools = tools.length > 0;
  return (
    <Notice
      errorSource="mcp-health-result"
      intent={outcome.success ? 'positive' : 'destructive'}
      role="status"
      data-testid="mcp-health-result"
      data-success={outcome.success ? 'true' : 'false'}
      title={outcome.success ? 'Connection succeeded' : 'Connection failed'}
      actions={
        outcome.responseTime !== undefined ? (
          <span className="tabular-nums">
            {`${Math.round(outcome.responseTime)} ms`}
          </span>
        ) : undefined
      }
      detail={
        showError || showTools ? (
          <>
            {showError && (
              <p
                data-testid="mcp-health-result-error"
                className={`break-words ${REPLAY_BLOCK_CLASS}`}
              >
                {outcome.error}
              </p>
            )}
            {showTools && (
              <p
                data-testid="mcp-health-result-tools"
                className={`break-words ${REPLAY_BLOCK_CLASS}`}
              >
                {`${tools.length} tool${tools.length === 1 ? '' : 's'}: ${tools.join(', ')}`}
              </p>
            )}
          </>
        ) : undefined
      }
    >
      {/* Server output can carry credentials; keep it out of session replay. */}
      <span className={REPLAY_BLOCK_CLASS}>{outcome.message}</span>
    </Notice>
  );
}

export interface McpAccountActionPort {
  readonly label: string;
  readonly action: McpAction<() => void | Promise<void>>;
}

export interface McpServerManagementActionsProps {
  readonly targetKey: string;
  readonly onConfirmationChange?: (open: boolean) => void;
  readonly serverName: string;
  readonly placement: McpServerPlacement;
  readonly deleteScope?:
    | McpServerPlacement
    | 'device-and-cloud'
    | 'device-retaining-cloud';
  /** Connect or disconnect the cloud account connection. */
  readonly account?: McpAccountActionPort;
  readonly moveToCloud?: McpAction<() => Promise<void>>;
  readonly moveToDevice?: McpAction<() => Promise<void>>;
  readonly deleteServer?: McpAction<() => Promise<void>>;
  /** Called once after a confirmed deletion succeeds. */
  readonly onDeleted?: () => void;
  /** Disables every action while other work on this server runs. */
  readonly busy?: boolean;
  readonly onPendingChange?: (pending: boolean) => void;
  /** Joins the owning surface's synchronous action-error reset. */
  readonly registerErrorClearer?: (clear: () => void) => () => void;
}

type ManagementActionId = 'account' | 'move-cloud' | 'move-device' | 'delete';

interface ActionRowSpec {
  readonly id: ManagementActionId;
  readonly label: string;
  readonly pendingLabel: string;
  readonly action: McpAction<() => void | Promise<void>>;
}

/**
 * The Placement row of {@link McpServerManagementCard}: account and move
 * actions on the row, and Delete in the page's ⋯ More menu. Actions the server
 * does not support are omitted; supported-but-unavailable actions stay
 * visible, disabled, with their reason.
 */
export function McpServerManagementActions(
  props: McpServerManagementActionsProps,
): JSX.Element {
  return (
    <McpServerManagementActionsForTarget key={props.targetKey} {...props} />
  );
}

function McpServerManagementActionsForTarget({
  onConfirmationChange,
  serverName,
  placement,
  deleteScope,
  account,
  moveToCloud,
  moveToDevice,
  deleteServer,
  onDeleted,
  busy = false,
  onPendingChange,
  registerErrorClearer,
}: McpServerManagementActionsProps): JSX.Element {
  const idPrefix = useId();
  const [pending, setPending] = useState<ManagementActionId | null>(null);
  const pendingRef = useRef<ManagementActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  useEffect(
    (): (() => void) | undefined =>
      registerErrorClearer?.((): void => {
        setError(null);
        setDeleteError(null);
      }),
    [registerErrorClearer],
  );
  const deleteRef = useRef(deleteServer);
  deleteRef.current = deleteServer;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    onPendingChange?.(pending !== null || confirmingDelete);
    return (): void => onPendingChange?.(false);
  }, [confirmingDelete, onPendingChange, pending]);
  useEffect(() => {
    onConfirmationChange?.(confirmingDelete);
    return (): void => onConfirmationChange?.(false);
  }, [confirmingDelete, onConfirmationChange]);

  const begin = (id: ManagementActionId): boolean => {
    if (pendingRef.current !== null || busy) return false;
    pendingRef.current = id;
    setPending(id);
    setError(null);
    return true;
  };
  const end = (): void => {
    pendingRef.current = null;
    setPending(null);
  };

  const runAction = async (
    id: ManagementActionId,
    run: () => void | Promise<void>,
  ): Promise<void> => {
    if (!begin(id)) return;
    try {
      await run();
    } catch (caught) {
      if (mounted.current)
        setError(errorText(caught, 'The action did not finish.'));
    } finally {
      end();
    }
  };

  const confirmDelete = async (): Promise<void> => {
    // Recheck at submission: capability or target may have changed.
    const current = deleteRef.current;
    if (current?.available !== true) {
      setDeleteError(
        current?.available === false
          ? current.reason
          : 'This server can no longer be deleted here.',
      );
      return;
    }
    if (!begin('delete')) return;
    setDeleteError(null);
    try {
      await current.run();
    } catch (caught) {
      if (!mounted.current) return;
      setDeleteError(errorText(caught, 'The server could not be deleted.'));
      end();
      return;
    }
    if (!mounted.current) return;
    end();
    setConfirmingDelete(false);
    onDeleted?.();
  };

  const rows: ActionRowSpec[] = [];
  if (account)
    rows.push({
      id: 'account',
      label: account.label,
      pendingLabel: 'Working…',
      action: account.action,
    });
  if (moveToCloud)
    rows.push({
      id: 'move-cloud',
      label: 'Move to cloud',
      pendingLabel: 'Moving…',
      action: moveToCloud,
    });
  if (moveToDevice)
    rows.push({
      id: 'move-device',
      label: 'Move to device',
      pendingLabel: 'Moving…',
      action: moveToDevice,
    });

  // Controls blocked for the same reason share one line, read by each of them.
  const reasonIds = new Map<string, string>();
  const reasonLines = rows.flatMap((row) => {
    if (row.action.available || reasonIds.has(row.action.reason)) return [];
    const id = `${idPrefix}-${row.id}-reason`;
    reasonIds.set(row.action.reason, id);
    return [
      <UnavailableReason
        key={id}
        id={id}
        testId={`mcp-management-${row.id}-reason`}
      >
        {row.action.reason}
      </UnavailableReason>,
    ];
  });

  const openDeleteConfirmation = (): void => {
    // Recheck at selection: an open menu can outlive the state it drew.
    if (
      deleteRef.current?.available !== true ||
      pendingRef.current !== null ||
      busy
    )
      return;
    setDeleteError(null);
    setConfirmingDelete(true);
  };
  const deleteItems: readonly DetailMoreMenuItem[] = deleteServer
    ? [
        {
          id: `${idPrefix}-delete`,
          label: pending === 'delete' ? 'Deleting…' : 'Delete…',
          icon: <TrashIcon />,
          testId: 'mcp-management-delete',
          onSelect: openDeleteConfirmation,
          disabled: !deleteServer.available || pending !== null || busy,
          ...(deleteServer.available ? {} : { reason: deleteServer.reason }),
          destructive: true,
        },
      ]
    : [];
  const deleteInHostMenu = useContributeDetailMoreItems(
    `mcp-management-${idPrefix}`,
    deleteItems,
  );

  return (
    <section
      data-testid="mcp-management-section"
      aria-label="Placement"
      className="flex flex-col gap-1"
    >
      <DetailFactList>
        <DetailFact label="Placement">
          <span
            data-testid="mcp-management-placement"
            data-placement={placement}
          >
            {mcpPlacementLabel(placement)}
          </span>
          {rows.length > 0 && (
            <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {rows.map((row) => {
                const reasonId = row.action.available
                  ? undefined
                  : reasonIds.get(row.action.reason);
                return (
                  <UnavailableTooltip
                    key={row.id}
                    reason={
                      row.action.available ? undefined : row.action.reason
                    }
                  >
                    <Button
                      variant="secondary"
                      size="compact"
                      data-testid={`mcp-management-${row.id}`}
                      disabled={
                        !row.action.available || pending !== null || busy
                      }
                      aria-describedby={reasonId}
                      onClick={(): void => {
                        if (!row.action.available) return;
                        void runAction(row.id, row.action.run);
                      }}
                    >
                      {pending === row.id ? row.pendingLabel : row.label}
                    </Button>
                  </UnavailableTooltip>
                );
              })}
            </span>
          )}
        </DetailFact>
      </DetailFactList>
      <div
        className={`${DETAIL_FACT_VALUE_OFFSET_CLASS} flex flex-col gap-2 empty:hidden`}
      >
        {reasonLines}
        <ErrorBanner
          errorSource="mcp-management-error"
          className=""
          error={error}
          testId="mcp-management-error"
        />
        {!deleteInHostMenu && deleteItems.length > 0 && (
          <DetailPageActions
            more={
              <DetailMoreMenu
                name={serverName}
                items={deleteItems}
                triggerTestId="mcp-management-more"
                menuTestId="mcp-management-menu"
                placement="bottom-right"
              />
            }
          />
        )}
        {confirmingDelete && (
          <ConfirmDialog
            title={`Delete ${serverName}?`}
            message={mcpDeleteScopeDescription(
              serverName,
              deleteScope ?? placement,
            )}
            confirmLabel="Delete"
            busyLabel="Deleting…"
            busy={pending === 'delete'}
            errorMessage={deleteError}
            destructive
            dataTestId="mcp-management-delete-dialog"
            confirmTestId="mcp-management-delete-confirm"
            cancelTestId="mcp-management-delete-cancel"
            onConfirm={(): void => {
              void confirmDelete();
            }}
            onCancel={(): void => {
              if (pendingRef.current === 'delete') return;
              setConfirmingDelete(false);
              setDeleteError(null);
            }}
          />
        )}
      </div>
    </section>
  );
}

export interface McpServerManagementCardProps {
  /** Each section's host wiring, unchanged; the card owns the presentation. */
  readonly health: Omit<McpServerHealthSectionProps, 'presentation' | 'label'>;
  readonly management: McpServerManagementActionsProps;
}

/**
 * Health and Placement as facts for one MCP server. The MCP server page on
 * desktop and web both mount it.
 */
export function McpServerManagementCard({
  health,
  management,
}: McpServerManagementCardProps): JSX.Element {
  return (
    <div
      role="group"
      data-testid="mcp-management-card"
      aria-label="Server management"
      className="flex flex-col gap-1"
    >
      <McpServerHealthSection {...health} presentation="row" />
      <McpServerManagementActions {...management} />
    </div>
  );
}

'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { CanopyClient } from '@canopy/app-core';
import {
  McpRemovalCandidatesResultSchema,
  type McpRemovalCandidatesResult,
  InspectMcpRemovalRequestSchema,
  type InspectMcpRemovalResult,
  type ForceMcpRemovalRequest,
  type ForceMcpRemovalResult,
} from '@canopy/protocol/mcp-removal';
import {
  Button,
  ConfirmDialog,
  Disclosure,
  FormField,
  Heading,
  Inline,
  Notice,
  NoticeButton,
  Stack,
  TextInput,
  Tooltip,
} from '@canopy/ui-shared/components';
import { CheckIcon, CloseIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  dismissMcpDeleteCleanup,
  registerMcpDeleteCleanupSurface,
  reportMcpDeleteCleanupComplete,
  usePendingMcpDeleteCleanups,
  type InstalledItemSnapshotState,
  type McpDeleteCleanupIncomplete,
} from '@canopy/ui-shared/lib';
import { useCustomizeDiscoveryEnabled } from './CustomizeDiscoveryProvider';

const repairRequested = 'canopy:mcp-removal-repair-requested';

function dispatchRepairRequest(
  serverId: string,
  fromCleanupNotice: boolean,
): boolean {
  if (!InspectMcpRemovalRequestSchema.safeParse({ serverId }).success)
    return false;
  // The panel cancels the event to acknowledge it synchronously.
  return !window.dispatchEvent(
    new CustomEvent(repairRequested, {
      detail: { serverId, fromCleanupNotice },
      cancelable: true,
    }),
  );
}

/** Review only. Returns whether an available Repair panel accepted the request. */
export function requestMcpRemovalRepair(serverId: string): boolean {
  return dispatchRepairRequest(serverId, false);
}

const stateLabels = {
  valid: 'Readable',
  absent: 'Missing',
  malformed: 'Damaged',
  unsupported: 'Newer format',
  unreadable: 'Cannot be read',
  unexpected: 'Unexpected file',
};

function mcpRemovalRepairAvailable(client: CanopyClient | null): boolean {
  return (
    client?.capabilities.mcpRemoval === true && client.mcpRemoval !== undefined
  );
}

/**
 * The latest device MCP server deleted with cleanup left incomplete
 * (CAN-7362). Mount it with McpRemovalRepair, where it outlives the detail
 * page the deletion may close. Notices are kept per server for the window,
 * not this page, so leaving and reopening the page keeps the way back to
 * Repair, and clearing one shows the previous server's again. Only a Delete
 * started with a Repair-capable surface can report here. A notice clears
 * when dismissed, when Repair finishes that server's uninstall, or when the
 * host no longer holds a saved uninstall for it, as after an agent's retry.
 * That is checked for every kept notice when one appears and again on each
 * `installedItems` refresh, whether the inventory read succeeded or failed.
 */
export function useMcpDeleteCleanupNotice(
  client: CanopyClient | null,
  installedItems?: InstalledItemSnapshotState,
): {
  readonly notice: McpDeleteCleanupIncomplete | null;
  readonly dismiss: () => void;
} {
  const canRepair = mcpRemovalRepairAvailable(client);
  useEffect(
    () => (canRepair ? registerMcpDeleteCleanupSurface() : undefined),
    [canRepair],
  );
  const notices = usePendingMcpDeleteCleanups();
  const notice = notices[notices.length - 1] ?? null;
  const port = canRepair ? client?.mcpRemoval : undefined;
  // Saved uninstalls do not depend on the inventory, so a failed inventory
  // read is a refresh too; each one is a new state object.
  const refreshed =
    installedItems?.kind === 'ready' || installedItems?.kind === 'error'
      ? installedItems
      : null;
  useEffect(() => {
    if (notices.length === 0 || !port) return;
    // A read answered after the notices changed may predate a receipt.
    let active = true;
    void port.candidates().then(
      (listed) => {
        const parsed = McpRemovalCandidatesResultSchema.safeParse(listed);
        // Only a complete list proves a receipt is gone.
        if (!active || !parsed.success || parsed.data.incomplete) return;
        const pending = new Set(
          parsed.data.candidates
            .filter((candidate) => candidate.pendingUninstall)
            .map((candidate) => candidate.serverId),
        );
        for (const kept of notices)
          if (!pending.has(kept.serverId))
            reportMcpDeleteCleanupComplete(kept.serverId);
      },
      // An unreadable list proves nothing; the notices and Repair stay.
      () => undefined,
    );
    return (): void => {
      active = false;
    };
  }, [notices, port, refreshed]);
  const dismiss = useCallback((): void => {
    if (notice) dismissMcpDeleteCleanup(notice.serverId);
  }, [notice]);
  return { notice, dismiss };
}

/** Says the server is gone and points to Repair; there is nothing to retry. */
export function McpDeleteCleanupNotice({
  client,
  notice,
  onDismiss,
}: {
  readonly client: CanopyClient | null;
  readonly notice: McpDeleteCleanupIncomplete | null;
  readonly onDismiss: () => void;
}): JSX.Element | null {
  if (!notice) return null;
  const canRepair = mcpRemovalRepairAvailable(client);
  return (
    <Notice
      intent="attention"
      title={`${notice.serverName} was deleted from this device.`}
      data-testid="mcp-delete-cleanup-notice"
      onDismiss={onDismiss}
      dismissLabel="Dismiss deletion notice"
      dismissTestId="mcp-delete-cleanup-notice-dismiss"
      actions={
        canRepair ? (
          <NoticeButton
            variant="primary"
            data-testid="mcp-delete-cleanup-notice-repair"
            // Repair can be hidden before cleanup finishes, so the notice
            // stays as the way back until it is dismissed or cleanup ends.
            onClick={(): void => {
              dispatchRepairRequest(notice.serverId, true);
            }}
          >
            Open repair
          </NoticeButton>
        ) : undefined
      }
    >
      Cleanup is incomplete.
    </Notice>
  );
}

/** Deliberately outside inventory/detail regions: damaged files must not hide repair. */
export function McpRemovalRepair({
  client,
  pageKey,
}: {
  readonly client: CanopyClient | null;
  /**
   * The page the host shows, such as the selected entry. Leaving the page
   * where a failed deletion opened this tool hides it again (CAN-7362).
   */
  readonly pageKey?: string | null;
}): JSX.Element {
  const id = useId();
  const serverInput = useRef<HTMLInputElement | null>(null);
  const [repairRequest, setRepairRequest] = useState(0);
  // New Customize hides this recovery tool until a deletion has failed; the
  // failure opens it already pointed at that server. Off, it always shows.
  const discoveryEnabled = useCustomizeDiscoveryEnabled();
  const [revealed, setRevealed] = useState(false);
  const [serverId, setServerId] = useState('');
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] =
    useState<McpRemovalCandidatesResult | null>(null);
  const [inspection, setInspection] = useState<InspectMcpRemovalResult | null>(
    null,
  );
  const [outcome, setOutcome] = useState<ForceMcpRemovalResult | null>(null);
  const [confirmation, setConfirmation] =
    useState<ForceMcpRemovalRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const port =
    client?.capabilities.mcpRemoval === true ? client.mcpRemoval : undefined;
  const canRemove = client?.capabilities.mcpRemovalForce === true;
  const activePort = useRef(port);
  useEffect(() => {
    activePort.current = port;
    setInspection(null);
    setConfirmation(null);
    setOutcome(null);
    setCandidates(null);
    setBusy(false);
    setError(null);
    return (): void => {
      activePort.current = undefined;
    };
  }, [port]);
  useEffect(() => {
    if (!canRemove) setConfirmation(null);
  }, [canRemove]);
  const openRepair = useCallback((requestedId: string): void => {
    setServerId(requestedId);
    setRevealed(true);
    setInspection(null);
    setOutcome(null);
    setConfirmation(null);
    setError(null);
    setOpen(true);
    setRepairRequest((previous) => previous + 1);
  }, []);
  // Use one path for idle and busy requests. Only the latest request on the
  // current page and port can open Repair once there is no operation running.
  const cleanupNotices = usePendingMcpDeleteCleanups();
  const [pendingRequest, setPendingRequest] = useState<{
    readonly serverId: string;
    readonly port: NonNullable<typeof port>;
    readonly pageKey: typeof pageKey;
    readonly fromCleanupNotice: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    const requested = (event: Event): void => {
      if (!port || !(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (
        !detail ||
        typeof detail !== 'object' ||
        !('serverId' in detail) ||
        typeof detail.serverId !== 'string'
      )
        return;
      event.preventDefault();
      setPendingRequest({
        serverId: detail.serverId,
        port,
        pageKey,
        fromCleanupNotice:
          'fromCleanupNotice' in detail && detail.fromCleanupNotice === true,
      });
    };
    window.addEventListener(repairRequested, requested);
    return (): void => window.removeEventListener(repairRequested, requested);
  }, [port, pageKey]);
  const hide = useCallback((): void => {
    setRevealed(false);
    setOpen(false);
    setConfirmation(null);
  }, []);
  const shownPage = useRef(pageKey);
  useLayoutEffect(() => {
    if (shownPage.current === pageKey) return;
    shownPage.current = pageKey;
    hide();
  }, [pageKey, hide]);
  useLayoutEffect(() => {
    if (!pendingRequest) return;
    const stillRelevant =
      pendingRequest.port === port &&
      pendingRequest.pageKey === pageKey &&
      (!pendingRequest.fromCleanupNotice ||
        cleanupNotices.some(
          (notice) => notice.serverId === pendingRequest.serverId,
        ));
    if (busy && stillRelevant) return;
    setPendingRequest((current) =>
      current === pendingRequest ? null : current,
    );
    if (stillRelevant) openRepair(pendingRequest.serverId);
  }, [busy, pendingRequest, port, pageKey, cleanupNotices, openRepair]);
  useEffect(() => {
    if (repairRequest > 0) serverInput.current?.focus();
  }, [repairRequest]);
  // Each accepted request reloads, so a receipt saved since the last load
  // still offers Finish saved uninstall for the requested server.
  useEffect(() => {
    if (!open || !port) return;
    let active = true;
    void port
      .candidates()
      .then((result) => {
        if (active)
          setCandidates(McpRemovalCandidatesResultSchema.parse(result));
      })
      .catch(() => {
        if (active) setCandidates({ candidates: [], incomplete: true });
      });
    return (): void => {
      active = false;
    };
  }, [open, port, outcome, repairRequest]);
  const inspect = async (): Promise<void> => {
    if (!port || busy) return;
    const request = InspectMcpRemovalRequestSchema.safeParse({
      serverId: serverId.trim(),
    });
    if (!request.success) {
      setError(
        'Enter the exact device server ID, using lowercase letters a–f, numbers and hyphens.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    setInspection(null);
    setOutcome(null);
    try {
      const result = await port.inspect(request.data);
      if (activePort.current === port) setInspection(result);
    } catch {
      if (activePort.current === port)
        setError(
          'The device server could not be inspected. Connect the desktop and try again.',
        );
    } finally {
      if (activePort.current === port) setBusy(false);
    }
  };
  const force = async (): Promise<void> => {
    if (!port || !canRemove || !confirmation || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await port.force(confirmation);
      if (result.status === 'complete' && result.uninstall === 'complete')
        reportMcpDeleteCleanupComplete(result.serverId);
      if (activePort.current !== port) return;
      setOutcome(result);
      setConfirmation(null);
      setInspection(null);
    } catch {
      if (activePort.current !== port) return;
      setError(
        'Removal could not be confirmed. Inspect the server again to find its saved recovery record.',
      );
      setConfirmation(null);
      setInspection(null);
    } finally {
      if (activePort.current === port) setBusy(false);
    }
  };
  if (discoveryEnabled && !revealed) return <></>;
  const disclosure = (
    <Disclosure
      label="Repair device MCP removal"
      dataTestId="mcp-removal-repair"
      open={open}
      onOpenChange={setOpen}
      className={discoveryEnabled ? 'min-w-0 flex-1' : 'max-w-prose'}
    >
      <div className="text-s text-pretty">
        <Stack gap="group">
          <p>
            Repair a device MCP server that cannot be deleted normally. Files
            are preserved as evidence; account connections are not removed.
          </p>
          {!port ? (
            <Notice intent="neutral" title="Repair is unavailable">
              Connect a desktop that supports device MCP repair to continue.
            </Notice>
          ) : (
            <>
              {!canRemove && (
                <Notice
                  intent="neutral"
                  title="Removal is unavailable"
                  role="none"
                >
                  You can inspect server files. Use a session that allows
                  removal to remove a server or finish a saved uninstall.
                </Notice>
              )}
              {candidates && (
                <Stack gap="inline" data-testid="mcp-removal-candidates">
                  <Heading level={2} variant="label">
                    Device server files and saved removals
                  </Heading>
                  <Inline gap="inline" wrap>
                    {candidates.candidates.map((candidate) => (
                      <Button
                        key={candidate.serverId}
                        variant={
                          serverId === candidate.serverId
                            ? 'secondary'
                            : 'ghost'
                        }
                        size="compact"
                        className="max-w-full"
                        aria-pressed={serverId === candidate.serverId}
                        disabled={busy}
                        onClick={() => {
                          setServerId(candidate.serverId);
                          setInspection(null);
                          setOutcome(null);
                          setError(null);
                        }}
                      >
                        {serverId === candidate.serverId && (
                          <CheckIcon size="sm" aria-hidden="true" />
                        )}
                        <span className="truncate">{candidate.serverId}</span>
                        {candidate.pendingUninstall
                          ? ' · Uninstall pending'
                          : ''}
                      </Button>
                    ))}
                  </Inline>
                  {candidates.incomplete && (
                    <Notice
                      intent="attention"
                      title="Couldn't list some servers"
                    >
                      The list may be incomplete. A server selected after a
                      failed deletion can still be inspected.
                    </Notice>
                  )}
                  {!candidates.incomplete &&
                    candidates.candidates.length === 0 && (
                      <p>
                        No device server files or saved removals were found.
                      </p>
                    )}
                </Stack>
              )}
              <FormField label="Device server ID" id={id}>
                <TextInput
                  ref={serverInput}
                  id={id}
                  value={serverId}
                  disabled={busy}
                  onChange={(event) => {
                    setServerId(event.target.value);
                    setInspection(null);
                    setOutcome(null);
                    setError(null);
                  }}
                  data-testid="mcp-removal-server-id"
                />
              </FormField>
              <div>
                <Button
                  loading={busy && confirmation === null}
                  loadingLabel="Inspecting server…"
                  disabled={busy || serverId.trim() === ''}
                  onClick={() => {
                    void inspect();
                  }}
                  data-testid="mcp-removal-inspect"
                >
                  Inspect server
                </Button>
              </div>
              {inspection && (
                <>
                  <p>
                    Server file: {stateLabels[inspection.target]}. Shared index:{' '}
                    {stateLabels[inspection.index]}.
                  </p>
                  <p>
                    If the shared index cannot be read safely, it stays
                    unchanged. Other servers are not rebuilt.
                  </p>
                  {canRemove && inspection.scope === 'preserve-evidence' && (
                    <div>
                      <Button
                        variant="destructive"
                        disabled={busy}
                        onClick={() =>
                          setConfirmation({
                            serverId: inspection.serverId,
                            mode: 'preserve-evidence',
                            inspectedState: inspection.inspectedState,
                          })
                        }
                        data-testid="mcp-removal-force"
                      >
                        Remove server and keep evidence
                      </Button>
                    </div>
                  )}
                  {inspection.scope === 'unavailable' && (
                    <Notice intent="attention" title="Repair cannot start">
                      The device server files could not be safely preserved.
                      They have not been removed.
                    </Notice>
                  )}
                  {inspection.recoveries.map((recovery) => (
                    <div
                      key={recovery.recoveryId}
                      className="flex flex-col items-start gap-2"
                    >
                      <p>
                        Saved recovery {recovery.recoveryId}: files{' '}
                        {recovery.custody ? 'preserved' : 'pending'}, sign-ins{' '}
                        {recovery.credentials ? 'cleared' : 'pending'}, index{' '}
                        {recovery.index}.
                      </p>
                      {canRemove && (
                        <Button
                          disabled={busy}
                          onClick={() =>
                            setConfirmation({
                              serverId: inspection.serverId,
                              mode: 'preserve-evidence',
                              recoveryId: recovery.recoveryId,
                            })
                          }
                        >
                          Resume saved removal
                        </Button>
                      )}
                      {canRemove &&
                        candidates?.candidates.some(
                          (candidate) =>
                            candidate.serverId === inspection.serverId &&
                            candidate.pendingUninstall,
                        ) && (
                          <Button
                            disabled={busy}
                            onClick={() =>
                              setConfirmation({
                                serverId: inspection.serverId,
                                mode: 'preserve-evidence',
                                recoveryId: recovery.recoveryId,
                                finishUninstall: true,
                              })
                            }
                            data-testid="mcp-removal-finish-uninstall"
                          >
                            Finish saved uninstall
                          </Button>
                        )}
                    </div>
                  ))}
                </>
              )}
              {outcome && (
                <Notice
                  intent={
                    outcome.status === 'complete' &&
                    outcome.uninstall !== 'pending'
                      ? 'positive'
                      : 'attention'
                  }
                  title={
                    outcome.status === 'complete'
                      ? outcome.uninstall === 'complete'
                        ? 'Device server uninstalled'
                        : outcome.uninstall === 'pending'
                          ? 'Saved uninstall is incomplete'
                          : 'Device server removed'
                      : outcome.status === 'refused'
                        ? 'Device server removal was refused'
                        : 'Device server removal is incomplete'
                  }
                  data-testid="mcp-removal-outcome"
                >
                  {outcome.code === 'previous_removal_pending'
                    ? 'An earlier removal for this server ID is incomplete. Resolve that saved removal before removing this server.'
                    : outcome.status === 'complete'
                      ? outcome.uninstall === 'complete'
                        ? 'The server files are preserved, its sign-ins and index entry are cleared, and saved references are removed. The server list may still be unavailable.'
                        : outcome.uninstall === 'pending'
                          ? 'The server files are preserved, but saved references could not be confirmed. Inspect again and choose Finish saved uninstall.'
                          : 'The server files are preserved and its sign-ins and index entry are cleared. Inspect again to finish any saved uninstall.'
                      : outcome.status === 'unresolved'
                        ? 'The server files are preserved, but the shared index is unchanged. Inspect again to review the saved recovery.'
                        : 'Some steps may have changed. Inspect again before retrying. The saved recovery record tracks what remains.'}
                </Notice>
              )}
            </>
          )}
          {error && (
            <Notice
              intent="destructive"
              errorSource="mcp-removal-repair"
              title="Repair needs attention"
            >
              {error}
            </Notice>
          )}
          {canRemove && confirmation && (
            <ConfirmDialog
              title={
                confirmation.finishUninstall
                  ? 'Finish saved device server uninstall?'
                  : 'Remove device server and keep evidence?'
              }
              message={
                confirmation.finishUninstall
                  ? 'This resumes the exact saved removal and clears its saved workspace and chat references only after removal is confirmed; account connections are not removed.'
                  : "This clears this device server's sign-ins and moves its files into private evidence storage; a damaged shared index stays unchanged and removal remains incomplete."
              }
              confirmLabel={
                confirmation.finishUninstall
                  ? 'Finish saved uninstall'
                  : 'Remove server and keep evidence'
              }
              destructive
              busy={busy}
              busyLabel="Removing server…"
              onConfirm={() => {
                void force();
              }}
              onCancel={() => setConfirmation(null)}
              dataTestId="mcp-removal-confirm"
            />
          )}
        </Stack>
      </div>
    </Disclosure>
  );
  // Off, the tool always shows; new Customize reveals it, so it can go again.
  if (!discoveryEnabled) return disclosure;
  return (
    <div className="flex max-w-prose items-start gap-2">
      {disclosure}
      <Tooltip label="Dismiss repair">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          disabled={busy}
          onClick={hide}
          aria-label="Dismiss repair"
          data-testid="mcp-removal-repair-dismiss"
        >
          <CloseIcon size="md" aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  );
}

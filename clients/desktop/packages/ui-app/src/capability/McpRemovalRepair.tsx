'use client';

import { useEffect, useId, useRef, useState, type JSX } from 'react';
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
  DialogFormField,
  Heading,
  Inline,
  LoadingButton,
  Notice,
  Stack,
  TextInput,
} from '@canopy/ui-shared/components';
import { CheckIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useCustomizeDiscoveryEnabled } from './CustomizeDiscoveryProvider';

const repairRequested = 'canopy:mcp-removal-repair-requested';

/** A failed ordinary deletion offers review, never implicit force or an account removal. */
export function requestMcpRemovalRepair(serverId: string): void {
  if (InspectMcpRemovalRequestSchema.safeParse({ serverId }).success)
    window.dispatchEvent(
      new CustomEvent(repairRequested, { detail: serverId }),
    );
}

const stateLabels = {
  valid: 'Readable',
  absent: 'Missing',
  malformed: 'Damaged',
  unsupported: 'Newer format',
  unreadable: 'Cannot be read',
  unexpected: 'Unexpected file',
};

/** Deliberately outside inventory/detail regions: damaged files must not hide repair. */
export function McpRemovalRepair({
  client,
}: {
  readonly client: CanopyClient | null;
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
  useEffect(() => {
    const requested = (event: Event): void => {
      if (
        busy ||
        !port ||
        !(event instanceof CustomEvent) ||
        typeof event.detail !== 'string'
      )
        return;
      setServerId(event.detail);
      setRevealed(true);
      setInspection(null);
      setOutcome(null);
      setConfirmation(null);
      setOpen(true);
      setRepairRequest((previous) => previous + 1);
    };
    window.addEventListener(repairRequested, requested);
    return (): void => window.removeEventListener(repairRequested, requested);
  }, [port, busy]);
  useEffect(() => {
    if (repairRequest > 0) serverInput.current?.focus();
  }, [repairRequest]);
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
  }, [open, port, outcome]);
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
  return (
    <Disclosure
      label="Repair device MCP removal"
      dataTestId="mcp-removal-repair"
      open={open}
      onOpenChange={setOpen}
      className="max-w-prose"
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
                            : 'tinted'
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
                      title="Some servers could not be listed"
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
              <DialogFormField label="Device server ID" htmlFor={id}>
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
              </DialogFormField>
              <div>
                <LoadingButton
                  loading={busy && confirmation === null}
                  loadingLabel="Inspecting server…"
                  disabled={busy || serverId.trim() === ''}
                  onClick={() => {
                    void inspect();
                  }}
                  data-testid="mcp-removal-inspect"
                >
                  Inspect server
                </LoadingButton>
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
}

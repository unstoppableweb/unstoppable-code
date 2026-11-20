import {
  aggregateInstalledItemStatus,
  installedItemKey,
  normalizeInstalledItemRef,
  SetInstalledItemStatusRequestSchema,
  UninstallInstalledItemRequestSchema,
  type InstalledItemRef,
  type InstalledItemTarget,
  type InstalledItemSnapshot,
  type InstalledItemSnapshotEntry,
  type InstalledItemMutationResult,
  type SetInstalledItemStatusRequest,
  type UninstallInstalledItemRequest,
  type InstalledItemStatus,
} from '@canopy/protocol/installed-items';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import type {
  ForceMcpRemovalResult,
  McpRemovalRecovery,
} from '@canopy/protocol/mcp-removal';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';

export type ParkedCodexPlugin = NonNullable<
  PreferencesData['parkedCodexPlugins']
>[number];
export interface InstalledItemRecord {
  ref: InstalledItemRef;
  /** Selection identity differs from connection identity for account MCP. */
  selectionRef?: { serverId: string; configId: string };
  enabled: boolean;
  removable: boolean;
  reason?: string;
  claudeIds?: string[];
  claudeEnabled?: boolean;
  codex?: Omit<ParkedCodexPlugin, 'state' | 'key'>;
  codexEnabled?: boolean;
}
export interface InstalledItemStatusPort {
  readPreferences(this: void): Promise<PreferencesData>;
  updatePreferences(
    this: void,
    update: (
      current: PreferencesData,
    ) => Partial<PreferencesData> | Promise<Partial<PreferencesData>>,
  ): Promise<PreferencesData>;
  list(this: void): Promise<InstalledItemRecord[]>;
  deviceServerIds?(this: void): readonly string[];
  canonical(this: void, ref: InstalledItemRef): Promise<InstalledItemRef>;
  serialize<T>(this: void, operation: () => Promise<T>): Promise<T>;
  setClaudeEnabled(this: void, id: string, enabled: boolean): Promise<void>;
  parkCodex(this: void, pluginId: string): Promise<void>;
  restoreCodex(this: void, record: ParkedCodexPlugin): Promise<void>;
  setMcpEnabled(
    this: void,
    ref: InstalledItemRef,
    enabled: boolean,
  ): Promise<void>;
  remove(this: void, record: InstalledItemRecord): Promise<void>;
  /**
   * A rejection whose error carries `serverUnlinked: true` confirms the
   * server file was removed before a later step, such as the index write,
   * failed.
   */
  removeDeviceServer(this: void, serverId: string): Promise<void>;
  /** Re-checks the server definition under its per-server mutation lease. */
  confirmDeviceServerAbsent?(this: void, serverId: string): Promise<boolean>;
  /** Receipt-bound device repair, never the combined device/account remover. */
  resumeDeviceRemoval?(
    this: void,
    serverId: string,
    recovery: McpRemovalRecovery,
  ): Promise<ForceMcpRemovalResult>;
  reconcileDeviceRemoval?<T>(
    this: void,
    serverId: string,
    recovery: McpRemovalRecovery,
    reconcile: () => Promise<T>,
  ): Promise<T>;
  assertAbsent?(this: void, ref: InstalledItemRef): Promise<void>;
  prune(
    this: void,
    refs: InstalledItemRef[],
    target: InstalledItemTarget,
  ): Promise<void>;
  publish(this: void, target: InstalledItemTarget): Promise<void>;
  /** Records a provider step's underlying error; never throws. */
  logError?(this: void, message: string, error: unknown): void;
}

type ProviderName = 'Claude' | 'Codex';

/** A provider's error as one plain line: its first line, CLI marks dropped. */
function providerReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const line =
    raw
      .split('\n')
      .map((part) => part.replace(/^[\s✘✖×!-]+/u, '').trim())
      .find((part) => part !== '') ?? 'Unknown error.';
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

/** The shape of a device MCP server id; anything else is not device-owned. */
const DEVICE_SERVER_ID_PATTERN = /^[a-f0-9-]{1,256}$/;

/**
 * The server id for a log line, only when it is a valid device id. An
 * uninstall request carries an unvalidated string, and the persistent log
 * ships in feedback bundles, so arbitrary text must not reach it.
 */
function loggableDeviceServerId(serverId: string): string {
  return DEVICE_SERVER_ID_PATTERN.test(serverId)
    ? serverId
    : 'invalid device MCP server ID';
}

/**
 * An uninstall failure as allowlisted tokens only: the error's `name`, an
 * errno-style `code` and a workspace plugins refusal `reason`. Message and
 * stack are never included: a cleanup step that parses chat files can throw
 * with file contents in them, and the persistent log ships in feedback
 * bundles regardless of chat sharing.
 */
function uninstallFailureDiagnostic(error: unknown): string {
  // Structural, not `instanceof`: errors from another realm are still read.
  if (typeof error !== 'object' || error === null)
    return `thrown=${typeof error}`;
  const rawName = 'name' in error ? error.name : undefined;
  const name =
    typeof rawName === 'string' && /^[A-Za-z_$][\w$]{0,63}$/.test(rawName)
      ? rawName
      : 'unnamed';
  const parts = [`name=${name}`];
  const code = 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && /^E[A-Z0-9_]{1,39}$/.test(code))
    parts.push(`code=${code}`);
  const reason = 'reason' in error ? error.reason : undefined;
  if (
    name === 'WorkspacePluginsRefusedError' &&
    typeof reason === 'string' &&
    /^[a-z]+(?:-[a-z]+){0,4}$/.test(reason)
  )
    parts.push(`reason=${reason}`);
  return parts.join(' ');
}

/**
 * Whether a `removeDeviceServer` rejection confirms the server file is gone.
 * Structural, like the diagnostic above: only the typed field counts.
 */
function rejectedAfterServerUnlink(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'serverUnlinked' in error &&
    error.serverUnlinked === true
  );
}

function selectionFor(
  ref: InstalledItemRef,
  record?: InstalledItemRecord,
): ReturnType<typeof normalizePluginSelections> {
  const selections = normalizePluginSelections(undefined);
  switch (ref.kind) {
    case 'plugin':
      selections.pluginRefs.push({
        marketplaceId: ref.marketplaceId,
        pluginName: ref.pluginName,
      });
      break;
    case 'skill':
      selections.skillRefs.push({
        sourceId: ref.sourceId,
        skillName: ref.skillName,
      });
      break;
    case 'collection':
      selections.collectionIds.push(ref.collectionId);
      break;
    case 'mcp-config':
      selections.mcpServerRefs = [
        { serverId: ref.serverId, configId: ref.configId },
      ];
      break;
    case 'account-mcp':
      selections.mcpServerRefs = record?.selectionRef
        ? [record.selectionRef]
        : [];
      break;
  }
  return selections;
}

function selected(
  ref: InstalledItemRef,
  preferences: PreferencesData,
  record: InstalledItemRecord,
): boolean {
  const selections = normalizePluginSelections(
    preferences.globalPluginSelections,
  );
  const target = selectionFor(ref, record);
  return (
    target.collectionIds.some((id) => selections.collectionIds.includes(id)) ||
    target.pluginRefs.some((candidate) =>
      selections.pluginRefs.some(
        (entry) =>
          installedItemKey({ kind: 'plugin', ...entry }) ===
          installedItemKey({ kind: 'plugin', ...candidate }),
      ),
    ) ||
    target.skillRefs.some((candidate) =>
      selections.skillRefs.some(
        (entry) =>
          entry.sourceId === candidate.sourceId &&
          entry.skillName === candidate.skillName,
      ),
    ) ||
    (target.mcpServerRefs ?? []).some((candidate) =>
      selections.mcpServerRefs?.some(
        (entry) =>
          entry.serverId === candidate.serverId &&
          entry.configId === candidate.configId,
      ),
    ) ||
    (ref.kind === 'account-mcp' &&
      selections.mcpServerRefs?.some(
        (entry) =>
          entry.serverId === `account:${ref.connectionId}` &&
          entry.configId === record.selectionRef?.configId,
      ) === true)
  );
}

export function createInstalledItemStatusService(
  port: InstalledItemStatusPort,
): {
  finishDeviceMcpRemoval(
    this: void,
    serverId: string,
    recoveryId: string,
  ): Promise<InstalledItemMutationResult>;
  listStatus(this: void): Promise<InstalledItemSnapshot>;
  setStatus(
    this: void,
    request: SetInstalledItemStatusRequest,
  ): Promise<InstalledItemMutationResult>;
  uninstall(
    this: void,
    request: UninstallInstalledItemRequest,
  ): Promise<InstalledItemMutationResult>;
} {
  let lastSnapshot: InstalledItemSnapshot = { items: [] };
  async function snapshot(
    input?: InstalledItemRecord[],
  ): Promise<InstalledItemSnapshot> {
    const records = input ?? (await port.list());
    const preferences = await canonicalPreferences(
      await port.readPreferences(),
    );
    const disabled = new Set(preferences.disabledInstalledItems ?? []);
    const parked = new Map(
      (preferences.parkedCodexPlugins ?? []).map((entry) => [entry.key, entry]),
    );
    const items: InstalledItemSnapshotEntry[] = records.map((record) => {
      const { ref } = record;
      const key = installedItemKey(ref);
      const intentDisabled =
        disabled.has(key) ||
        preferences.pendingInstalledItemUninstalls?.some((entry) =>
          entry.refs.some(
            (candidate) =>
              candidate.kind !== 'mcp-config' &&
              candidate.kind !== 'account-mcp' &&
              installedItemKey(candidate) === key,
          ),
        ) === true;
      const recovery = parked.get(key);
      const status =
        intentDisabled || recovery || !record.enabled
          ? 'disabled'
          : selected(ref, preferences, record)
            ? 'active'
            : 'available';
      return {
        target: ref,
        status,
        removable: ref.kind !== 'mcp-config' && record.removable,
        ...(ref.kind === 'mcp-config'
          ? {
              reason:
                'Delete the device server to delete all its configurations.',
            }
          : {}),
        uninstallDescription:
          ref.kind === 'collection'
            ? 'Removes the collection and its saved selections. Members stay installed.'
            : ref.kind === 'account-mcp'
              ? 'Removes this account connection and its sign-in across the account.'
              : ref.kind === 'plugin'
                ? 'Removes the provider installations, managed cache and saved selections. Claude persistent data is kept.'
                : ref.kind === 'skill'
                  ? 'Removes the local skill files and saved selections.'
                  : 'Delete the device server to delete every configuration and its sign-ins.',
        ...(record.selectionRef ? { selectionRef: record.selectionRef } : {}),
        ...(record.reason ? { reason: record.reason } : {}),
        ...(ref.kind !== 'mcp-config'
          ? {
              uninstallTarget: ref,
              removalScope: ref.kind === 'account-mcp' ? 'account' : 'item',
            }
          : {}),
        notices: [
          ...(intentDisabled && record.codex
            ? [
                {
                  code: 'provider_pending',
                  provider: 'codex',
                  message:
                    'Disabled in application loading. Codex may still load this plugin until parking completes; retry the status change.',
                  retryable: true,
                } as const,
              ]
            : []),
          ...(intentDisabled &&
          (record.claudeEnabled ?? record.enabled) &&
          record.claudeIds?.length
            ? [
                {
                  code: 'provider_pending',
                  provider: 'claude',
                  message:
                    'Disabled in application loading. Claude may still load this plugin until the provider applies the change; retry the status change.',
                  retryable: true,
                } as const,
              ]
            : []),
          ...(recovery && (!intentDisabled || recovery.state !== 'parked')
            ? [
                {
                  code: 'provider_pending',
                  provider: 'codex',
                  message:
                    'Codex plugin transition is incomplete. Retry to finish the saved transition.',
                  retryable: true,
                } as const,
              ]
            : []),
          ...(status === 'disabled'
            ? [
                {
                  code: 'session_recreation_required',
                  message:
                    'New sessions and supported next-turn refreshes apply this state. Already-running provider tools may require session recreation.',
                  retryable: false,
                } as const,
              ]
            : []),
        ],
      };
    });
    const servers = new Set([
      ...(port.deviceServerIds?.() ?? []),
      ...records.flatMap((record) =>
        record.ref.kind === 'mcp-config' ? [record.ref.serverId] : [],
      ),
    ]);
    for (const serverId of Array.from(servers)) {
      const configs = items.filter(
        (item) =>
          item.target.kind === 'mcp-config' &&
          item.target.serverId === serverId,
      );
      items.push({
        target: { kind: 'mcp-server', serverId },
        status: aggregateInstalledItemStatus(
          configs.flatMap((item) => (item.status ? [item.status] : [])),
        ),
        removable: true,
        uninstallTarget: { kind: 'mcp-server', serverId },
        removalScope: 'device-server',
        uninstallDescription:
          'Deletes this device server, all its configurations and their sign-ins.',
        configurations: records.flatMap((record) =>
          record.ref.kind === 'mcp-config' && record.ref.serverId === serverId
            ? [record.ref]
            : [],
        ),
        notices: [],
      });
    }
    for (const pending of preferences.pendingInstalledItemUninstalls ?? []) {
      const notice = {
        code: 'partial_removal',
        message:
          'Uninstall is incomplete. Retry to reconcile remaining installations and saved references.',
        retryable: true,
      } as const;
      const existing = items.find(
        (item) =>
          JSON.stringify(item.target) === JSON.stringify(pending.target),
      );
      if (existing) existing.notices.push(notice);
      else
        items.push({
          target: pending.target,
          status: null,
          removable: true,
          uninstallTarget: pending.target,
          notices: [notice],
        });
    }
    lastSnapshot = { items };
    return lastSnapshot;
  }

  async function canonicalPreferences(
    current: PreferencesData,
  ): Promise<PreferencesData> {
    const disabled = await Promise.all(
      (current.disabledInstalledItems ?? []).map(async (key) => {
        const { parseInstalledItemKey } =
          await import('@canopy/protocol/installed-items');
        const ref = parseInstalledItemKey(key);
        return ref ? installedItemKey(await port.canonical(ref)) : key;
      }),
    );
    const selections = normalizePluginSelections(
      current.globalPluginSelections,
    );
    const pluginRefs = await Promise.all(
      selections.pluginRefs.map(async (ref) => {
        const canonical = await port.canonical({ kind: 'plugin', ...ref });
        return canonical.kind === 'plugin'
          ? {
              marketplaceId: canonical.marketplaceId,
              pluginName: canonical.pluginName,
            }
          : ref;
      }),
    );
    return {
      ...current,
      disabledInstalledItems: Array.from(new Set(disabled)),
      globalPluginSelections: { ...selections, pluginRefs },
    };
  }

  async function updateSelections(
    record: InstalledItemRecord,
    status: InstalledItemStatus,
  ): Promise<void> {
    const { unionPluginSelections, subtractPluginSelections } =
      await import('@canopy/desktop-shared/lib/effective-plugin-selections');
    await port.updatePreferences(async (stored) => {
      const current = await canonicalPreferences(stored);
      const key = installedItemKey(record.ref);
      const generic =
        record.ref.kind !== 'mcp-config' && record.ref.kind !== 'account-mcp';
      const disabled = new Set(current.disabledInstalledItems ?? []);
      if (generic) {
        if (status === 'disabled') disabled.add(key);
        else disabled.delete(key);
      }
      let selections = normalizePluginSelections(
        current.globalPluginSelections,
      );
      if (record.ref.kind === 'account-mcp' && record.selectionRef) {
        selections = subtractPluginSelections(selections, {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [
            {
              serverId: `account:${record.ref.connectionId}`,
              configId: record.selectionRef.configId,
            },
          ],
        });
      }
      const target = selectionFor(record.ref, record);
      return {
        disabledInstalledItems: Array.from(disabled),
        globalPluginSelections:
          status === 'active'
            ? unionPluginSelections(selections, target)
            : subtractPluginSelections(selections, target),
      };
    });
  }

  async function transition(
    record: InstalledItemRecord,
    status: InstalledItemStatus,
  ): Promise<void> {
    const ref = normalizeInstalledItemRef(record.ref);
    const key = installedItemKey(ref);
    if (ref.kind === 'mcp-config' || ref.kind === 'account-mcp') {
      // An authoritative MCP write must succeed before selection bookkeeping changes.
      await port.setMcpEnabled(ref, status !== 'disabled');
      await updateSelections(record, status);
      return;
    }
    if (status === 'disabled') await updateSelections(record, status);
    let preferences = await port.readPreferences();
    let recovery = preferences.parkedCodexPlugins?.find(
      (entry) => entry.key === key,
    );
    if (
      status !== 'disabled' &&
      record.codex &&
      record.codexEnabled === false &&
      !recovery
    ) {
      const saved: ParkedCodexPlugin = {
        ...record.codex,
        key,
        state: 'parking',
      };
      await port.updatePreferences((current) => ({
        parkedCodexPlugins: [
          ...(current.parkedCodexPlugins ?? []).filter(
            (entry) => entry.key !== key,
          ),
          saved,
        ],
      }));
      await port.parkCodex(saved.pluginId);
      recovery = saved;
    }
    const failures: { provider: ProviderName; error: unknown }[] = [];
    for (const id of record.claudeIds ?? []) {
      try {
        await port.setClaudeEnabled(id, status !== 'disabled');
      } catch (error) {
        failures.push({ provider: 'Claude', error });
      }
    }
    try {
      if (status === 'disabled') {
        if (!recovery && record.codex) {
          const saved: ParkedCodexPlugin = {
            ...record.codex,
            key,
            state: 'parking',
          };
          preferences = await port.updatePreferences((current) => ({
            parkedCodexPlugins: [
              ...(current.parkedCodexPlugins ?? []).filter(
                (entry) => entry.key !== key,
              ),
              saved,
            ],
          }));
          recovery = saved;
        }
        if (recovery) {
          // Retry even for an unchanged status. `list` reconciles an interrupted park.
          if (record.codex) await port.parkCodex(recovery.pluginId);
          await port.updatePreferences((current) => ({
            parkedCodexPlugins: (current.parkedCodexPlugins ?? []).map(
              (entry) =>
                entry.key === key ? { ...entry, state: 'parked' } : entry,
            ),
          }));
        }
      } else if (recovery) {
        await port.updatePreferences((current) => ({
          parkedCodexPlugins: (current.parkedCodexPlugins ?? []).map((entry) =>
            entry.key === key ? { ...entry, state: 'restoring' } : entry,
          ),
        }));
        await port.restoreCodex(recovery);
        await port.updatePreferences((current) => ({
          parkedCodexPlugins: (current.parkedCodexPlugins ?? []).filter(
            (entry) => entry.key !== key,
          ),
        }));
      }
    } catch (error) {
      failures.push({ provider: 'Codex', error });
    }
    if (failures.length) {
      for (const failure of failures)
        port.logError?.(
          `[installed-items] ${failure.provider} step failed setting ${key} to ${status}`,
          failure.error,
        );
      // One plain reason per provider: "Couldn't turn it on for Codex: …".
      const verb = status === 'disabled' ? 'turn it off' : 'turn it on';
      const reasons = new Map<ProviderName, string>();
      for (const failure of failures)
        if (!reasons.has(failure.provider))
          reasons.set(failure.provider, providerReason(failure.error));
      throw new Error(
        Array.from(
          reasons,
          ([provider, reason]) => `Couldn't ${verb} for ${provider}: ${reason}`,
        ).join(' '),
      );
    }
    if (status !== 'disabled') await updateSelections(record, status);
  }

  async function result(
    requestedStatus: InstalledItemStatus | undefined,
    removed: InstalledItemTarget[],
    errors: InstalledItemMutationResult['errors'],
    target: InstalledItemTarget,
  ): Promise<InstalledItemMutationResult> {
    try {
      await port.publish(target);
    } catch {
      errors.push({
        target,
        code: 'refresh_failed',
        message:
          'The change was saved, but the catalog could not be refreshed. Retry to reconcile its state.',
        retryable: true,
      });
    }
    let current: InstalledItemSnapshot;
    try {
      current = await snapshot();
    } catch {
      current = {
        items: lastSnapshot.items.map((item) => ({
          ...item,
          status: null,
          notices: [
            ...item.notices,
            {
              code: 'provider_unavailable',
              message:
                'Current installed-item state could not be read. Retry to reconcile the saved operation.',
              retryable: true,
            },
          ],
        })),
      };
      for (const item of current.items)
        errors.push({
          target: item.target,
          code: 'state_unavailable',
          message: 'Current installed-item state is unavailable.',
          retryable: true,
        });
      if (!current.items.length)
        errors.push({
          target,
          code: 'state_unavailable',
          message: 'Current installed-item state is unavailable.',
          retryable: true,
        });
    }
    return {
      success: errors.length === 0,
      ...(requestedStatus ? { requestedStatus } : {}),
      removed,
      errors,
      snapshot: current,
    };
  }

  function uninstallWithinSerial(
    request: UninstallInstalledItemRequest,
    expectedRecoveryId?: string,
  ): Promise<InstalledItemMutationResult> {
    return port.serialize(async () => {
      const deviceTarget = request.target;
      if (
        deviceTarget.kind === 'mcp-server' &&
        DEVICE_SERVER_ID_PATTERN.test(deviceTarget.serverId)
      ) {
        // Saved device intent is sufficient to resume. Catalog, plugin,
        // skills, collection and account reads are not removal authority.
        const saved = (
          await port.readPreferences()
        ).pendingInstalledItemUninstalls?.find(
          (entry) =>
            entry.target.kind === 'mcp-server' &&
            entry.target.serverId === deviceTarget.serverId,
        );
        if (
          expectedRecoveryId !== undefined &&
          saved?.mcpRemoval?.recoveryId !== expectedRecoveryId
        )
          throw new Error('Saved device MCP uninstall identity changed.');
        if (saved) {
          const errors: InstalledItemMutationResult['errors'] = [];
          const removed: InstalledItemTarget[] = [];
          // Receipt-bound retries confirm inside their fenced reconciliation.
          // Ordinary retries re-check absence after a later step fails.
          let serverRemoved = false;
          let ordinaryRemovalSucceeded = false;
          try {
            if (
              !saved.refs.every(
                (ref) =>
                  ref.kind === 'mcp-config' &&
                  ref.serverId === deviceTarget.serverId,
              )
            )
              throw new Error('Invalid device MCP uninstall references.');
            if (saved.mcpRemoval) {
              const outcome = await port.resumeDeviceRemoval?.(
                deviceTarget.serverId,
                saved.mcpRemoval,
              );
              if (
                outcome?.status !== 'complete' ||
                outcome.serverId !== deviceTarget.serverId ||
                outcome.recoveryId !== saved.mcpRemoval.recoveryId ||
                !outcome.custody ||
                !outcome.credentials ||
                outcome.index !== 'complete'
              )
                throw new Error('Device MCP removal is incomplete.');
            } else {
              // Legacy {target, refs} entries retain ordinary, non-escalating retry.
              try {
                await port.removeDeviceServer(deviceTarget.serverId);
              } catch (error) {
                serverRemoved = rejectedAfterServerUnlink(error);
                throw error;
              }
              ordinaryRemovalSucceeded = true;
            }
            const reconcile = async (): Promise<void> => {
              const pending = (
                await port.readPreferences()
              ).pendingInstalledItemUninstalls?.find(
                (entry) =>
                  entry.target.kind === 'mcp-server' &&
                  entry.target.serverId === deviceTarget.serverId,
              );
              if (JSON.stringify(pending) !== JSON.stringify(saved))
                throw new Error('Device MCP uninstall recovery changed.');
              await port.prune(saved.refs, deviceTarget);
              await port.updatePreferences((current) => {
                const entries = current.pendingInstalledItemUninstalls ?? [];
                const matching = entries.filter(
                  (entry) =>
                    entry.target.kind === 'mcp-server' &&
                    entry.target.serverId === deviceTarget.serverId,
                );
                if (
                  matching.some(
                    (entry) => JSON.stringify(entry) !== JSON.stringify(saved),
                  )
                )
                  throw new Error('Device MCP uninstall recovery changed.');
                return {
                  pendingInstalledItemUninstalls: entries.filter(
                    (entry) => !matching.includes(entry),
                  ),
                };
              });
            };
            if (saved.mcpRemoval) {
              if (!port.reconcileDeviceRemoval)
                throw new Error(
                  'Device MCP recovery reconciliation is unavailable.',
                );
              await port.reconcileDeviceRemoval(
                deviceTarget.serverId,
                saved.mcpRemoval,
                async () => {
                  // Runs only once the server is confirmed absent under its
                  // lease; a same-ID recreation rejects before this.
                  serverRemoved = true;
                  await reconcile();
                },
              );
            } else await reconcile();
            removed.push(deviceTarget);
          } catch (error) {
            if (ordinaryRemovalSucceeded) {
              try {
                serverRemoved =
                  (await port.confirmDeviceServerAbsent?.(
                    deviceTarget.serverId,
                  )) === true;
              } catch {
                serverRemoved = false;
              }
            }
            // The result keeps generic text; only an allowlisted summary of
            // the cause is logged.
            port.logError?.(
              `[installed-items] Saved uninstall of device MCP server ${loggableDeviceServerId(deviceTarget.serverId)} is incomplete`,
              uninstallFailureDiagnostic(error),
            );
            errors.push({
              target: deviceTarget,
              code: 'uninstall_incomplete',
              message:
                'Uninstall is incomplete. Retry to reconcile remaining installations and saved references.',
              retryable: true,
              ...(serverRemoved ? { serverRemoved: true } : {}),
            });
          }
          // Refresh can fail independently; `removed` still records confirmed
          // completion and the result never re-creates a consumed intent.
          return result(undefined, removed, errors, deviceTarget);
        }
      }
      const inventory = await port.list();
      await snapshot(inventory);
      const target = UninstallInstalledItemRequestSchema.shape.target.parse(
        request.target.kind === 'mcp-server'
          ? request.target
          : await port.canonical(request.target),
      );
      const records = inventory.filter((record) =>
        target.kind === 'mcp-server'
          ? record.ref.kind === 'mcp-config' &&
            record.ref.serverId === target.serverId
          : installedItemKey(record.ref) === installedItemKey(target),
      );
      const errors: InstalledItemMutationResult['errors'] = [];
      const removed: InstalledItemTarget[] = [];
      // A successful ordinary removal is re-confirmed if a later step fails.
      let serverRemoved = false;
      let ordinaryDeviceRemovalSucceeded = false;
      try {
        const refused = records.find((record) => !record.removable);
        if (refused)
          throw new Error(
            refused.reason ?? 'This installed item cannot be removed.',
          );
        const targetKey = JSON.stringify(target);
        if (!records.length && target.kind !== 'mcp-server')
          await port.assertAbsent?.(target);
        const saved = (
          await port.readPreferences()
        ).pendingInstalledItemUninstalls?.find(
          (entry) => JSON.stringify(entry.target) === targetKey,
        );
        const refs =
          saved?.refs ??
          (target.kind === 'mcp-server'
            ? records.map((record) => record.ref)
            : [target]);
        // Custody recovery is device-only and must validate the receipt's
        // original incarnation. Never downgrade it to ordinary delete, which
        // could adopt a newly created server at the same ID.
        if (saved?.mcpRemoval)
          throw new Error(
            'Resume device MCP removal through its repair operation.',
          );
        for (const record of records)
          if (record.ref.kind === 'account-mcp' && record.selectionRef)
            refs.push({ kind: 'mcp-config', ...record.selectionRef });
        await port.updatePreferences((current) => ({
          pendingInstalledItemUninstalls: [
            ...(current.pendingInstalledItemUninstalls ?? []).filter(
              (entry) => JSON.stringify(entry.target) !== targetKey,
            ),
            { target, refs },
          ],
        }));
        if (target.kind === 'mcp-server') {
          try {
            await port.removeDeviceServer(target.serverId);
          } catch (error) {
            serverRemoved = rejectedAfterServerUnlink(error);
            throw error;
          }
          ordinaryDeviceRemovalSucceeded = true;
        } else for (const record of records) await port.remove(record);
        // An absent target is an idempotent retry, including cleanup after a crash.
        await port.prune(refs, target);
        await port.updatePreferences((current) => ({
          pendingInstalledItemUninstalls: (
            current.pendingInstalledItemUninstalls ?? []
          ).filter((entry) => JSON.stringify(entry.target) !== targetKey),
        }));
        removed.push(target);
      } catch (error) {
        if (ordinaryDeviceRemovalSucceeded && target.kind === 'mcp-server') {
          try {
            serverRemoved =
              (await port.confirmDeviceServerAbsent?.(target.serverId)) ===
              true;
          } catch {
            serverRemoved = false;
          }
        }
        const refused = records.find((record) => !record.removable);
        // The result keeps generic text. Only the target's kind, its device
        // server id and an allowlisted summary of the cause are logged.
        port.logError?.(
          `[installed-items] Uninstall of ${
            target.kind === 'mcp-server'
              ? `device MCP server ${loggableDeviceServerId(target.serverId)}`
              : `a ${target.kind}`
          } is incomplete`,
          uninstallFailureDiagnostic(error),
        );
        errors.push({
          target,
          code: refused ? 'not_removable' : 'uninstall_incomplete',
          message:
            refused?.reason ??
            'Uninstall is incomplete. Retry to reconcile remaining installations and saved references.',
          retryable: !refused,
          ...(serverRemoved ? { serverRemoved: true } : {}),
        });
      }
      return result(undefined, removed, errors, target);
    });
  }

  return {
    listStatus: snapshot,
    setStatus(raw): Promise<InstalledItemMutationResult> {
      const request = SetInstalledItemStatusRequestSchema.parse(raw);
      return port.serialize(async () => {
        const records = await port.list();
        await snapshot(records);
        const target =
          request.target.kind === 'mcp-server'
            ? request.target
            : await port.canonical(request.target);
        const targets = records.filter((record) =>
          target.kind === 'mcp-server'
            ? record.ref.kind === 'mcp-config' &&
              record.ref.serverId === target.serverId
            : installedItemKey(record.ref) === installedItemKey(target),
        );
        const errors: InstalledItemMutationResult['errors'] = [];
        if (!targets.length)
          errors.push({
            target,
            code: 'not_found',
            message: 'Installed item was not found.',
            retryable: false,
          });
        for (const record of targets) {
          try {
            await transition(record, request.status);
          } catch (error) {
            errors.push({
              target: record.ref,
              code: 'transition_failed',
              message:
                error instanceof Error
                  ? error.message
                  : 'Status change failed.',
              retryable: true,
            });
          }
        }
        const outcome = await result(request.status, [], errors, target);
        const actual = outcome.snapshot.items.find(
          (item) => JSON.stringify(item.target) === JSON.stringify(target),
        );
        if (!errors.length && actual?.status !== request.status) {
          outcome.success = false;
          outcome.errors.push({
            target,
            code: 'provider_pending',
            message:
              'The requested status has not taken effect. Retry after the provider becomes available.',
            retryable: true,
          });
        }
        return outcome;
      });
    },
    uninstall(raw): Promise<InstalledItemMutationResult> {
      return uninstallWithinSerial(
        UninstallInstalledItemRequestSchema.parse(raw),
      );
    },
    finishDeviceMcpRemoval(
      serverId: string,
      recoveryId: string,
    ): Promise<InstalledItemMutationResult> {
      return uninstallWithinSerial(
        UninstallInstalledItemRequestSchema.parse({
          target: { kind: 'mcp-server', serverId },
        }),
        recoveryId,
      );
    },
  };
}

/**
 * Install subscriptions for shared items (CAN-2334).
 *
 * Desktop tells the signed-in account which shared items it installed so web
 * can email the user when the owner publishes an update. This module is the
 * device-local ledger of those installs and the outbox that uploads them.
 *
 * Ledger, at `getSharedItemUpdateSubscriptionsFilePath()`:
 *
 * - `installs`: one entry per key (`kind:sourceKind:remoteId`) with the
 *   content hash the install holds and every local copy (`localIds`) that
 *   came from it. The entry exists while at least one local copy does.
 * - `byAccount[accountId]`: which keys this device already uploaded to that
 *   account with their current hash (`syncedKeys`), which keys the server
 *   holds an install row for from this device, at any hash (`heldKeys`),
 *   which removals it still owes it (`pendingRemovals`), and whether the
 *   one-time backfill of installs that predate this module finished
 *   (`backfillVersion`). A hash change unsyncs a key but leaves it held, so
 *   an uninstall before the re-upload still owes the account a removal.
 *
 * A pending upsert is an install whose key is not in the account's
 * `syncedKeys`. Uploads go only to a signed-in non-guest account; entries for
 * one account are never sent under another's credential.
 *
 * The ledger is device-local and best effort. A missing, unreadable or
 * unparseable file reads as empty and is rewritten on the next change. Every
 * exported entry point resolves or returns without throwing, because callers
 * fire and forget after their own local write already succeeded.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomically } from '@canopy/execution-engine/node/lib/atomic-file';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  isPermanentSharedItemSubscriptionError,
  isValidSharedItemSourceKey,
  MAX_SHARED_ITEM_BATCH_SIZE,
  parseSharedItemInstallRemoval,
  parseSharedItemInstallUpsert,
  parseSharedItemKind,
  parseSharedItemSourceKind,
  parseSharedItemSubscriptionBatchResult,
  sharedItemSubscriptionKey,
  type SharedItemInstallRemoval,
  type SharedItemInstallUpsert,
  type SharedItemKind,
  type SharedItemSourceKind,
  type SharedItemSubscriptionItemResult,
} from '@canopy/protocol/shared-item-subscriptions';
import { requestCanopyCloudJson } from './client';
import {
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getSharedItemUpdateSubscriptionsFilePath } from '../lib/paths';
import { readPortalStateStore } from '../portal/portal-state-store';

const BATCH_PATH = '/api/v1/shared-item-subscriptions/batch';
const BATCH_TIMEOUT_MS = 15_000;
const LOG_PREFIX = '[shared-item-subscriptions]';

/**
 * Bump to re-run the backfill for every account, for example when the
 * collector learns a new source.
 */
const CURRENT_BACKFILL_VERSION = 1;

/** One local copy of a shared item, as a call site reports it. */
export interface SharedItemInstallRecord {
  kind: SharedItemKind;
  remoteId: string;
  sourceKind: SharedItemSourceKind;
  /** The hash the install holds, or `null` when it is unknown. */
  contentHash: string | null;
  /** Identifies the local copy, so a second copy keeps the subscription. */
  localId: string;
}

export type SharedItemUninstallRecord = Omit<
  SharedItemInstallRecord,
  'contentHash'
>;

/** A removed local copy, named only by its kind and local id. */
export type SharedItemLocalUninstallRecord = Pick<
  SharedItemInstallRecord,
  'kind' | 'localId'
>;

export interface SharedItemSubscriptionLedgerInstall {
  kind: SharedItemKind;
  remoteId: string;
  sourceKind: SharedItemSourceKind;
  contentHash: string | null;
  localIds: string[];
}

export interface SharedItemSubscriptionLedgerAccount {
  syncedKeys: string[];
  heldKeys: string[];
  pendingRemovals: string[];
  backfillVersion: number;
}

export interface SharedItemSubscriptionLedger {
  version: 1;
  installs: SharedItemSubscriptionLedgerInstall[];
  byAccount: Record<string, SharedItemSubscriptionLedgerAccount>;
}

function emptyLedger(): SharedItemSubscriptionLedger {
  return { version: 1, installs: [], byAccount: {} };
}

function emptyAccount(): SharedItemSubscriptionLedgerAccount {
  return {
    syncedKeys: [],
    heldKeys: [],
    pendingRemovals: [],
    backfillVersion: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (!isNonEmptyString(entry)) return null;
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

function parseLedgerInstall(
  value: unknown,
): SharedItemSubscriptionLedgerInstall | null {
  if (!isRecord(value)) return null;
  const kind = parseSharedItemKind(value.kind);
  const sourceKind = parseSharedItemSourceKind(value.sourceKind);
  const localIds = parseStringList(value.localIds);
  if (
    kind === null ||
    sourceKind === null ||
    !isNonEmptyString(value.remoteId) ||
    localIds === null ||
    localIds.length === 0
  ) {
    return null;
  }
  const { contentHash } = value;
  if (contentHash !== null && !isNonEmptyString(contentHash)) return null;
  return { kind, remoteId: value.remoteId, sourceKind, contentHash, localIds };
}

function parseLedgerAccount(
  value: unknown,
): SharedItemSubscriptionLedgerAccount | null {
  if (!isRecord(value)) return null;
  const syncedKeys = parseStringList(value.syncedKeys);
  // Files written before `heldKeys` existed held exactly what they synced.
  const heldKeys =
    value.heldKeys === undefined ? syncedKeys : parseStringList(value.heldKeys);
  const pendingRemovals = parseStringList(value.pendingRemovals);
  const { backfillVersion } = value;
  if (
    syncedKeys === null ||
    heldKeys === null ||
    pendingRemovals === null ||
    typeof backfillVersion !== 'number' ||
    !Number.isSafeInteger(backfillVersion) ||
    backfillVersion < 0
  ) {
    return null;
  }
  return {
    syncedKeys,
    heldKeys: union(heldKeys, syncedKeys),
    pendingRemovals,
    backfillVersion,
  };
}

/** Normalize a parsed file, dropping malformed entries instead of failing. */
function normalizeLedger(value: unknown): SharedItemSubscriptionLedger {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.installs) ||
    !isRecord(value.byAccount)
  ) {
    return emptyLedger();
  }
  const ledger = emptyLedger();
  for (const entry of value.installs) {
    const parsed = parseLedgerInstall(entry);
    if (parsed === null) continue;
    const existing = findInstall(ledger, sharedItemSubscriptionKey(parsed));
    if (existing === undefined) {
      ledger.installs.push(parsed);
    } else {
      existing.localIds = union(existing.localIds, parsed.localIds);
    }
  }
  for (const [accountId, entry] of Object.entries(value.byAccount)) {
    const parsed = parseLedgerAccount(entry);
    if (accountId.length > 0 && parsed !== null) {
      ledger.byAccount[accountId] = parsed;
    }
  }
  return ledger;
}

async function readLedgerFile(): Promise<SharedItemSubscriptionLedger> {
  let raw: string;
  try {
    raw = await readFile(getSharedItemUpdateSubscriptionsFilePath(), 'utf8');
  } catch {
    // Missing or unreadable: start empty, rewritten on the next change.
    return emptyLedger();
  }
  try {
    return normalizeLedger(JSON.parse(raw));
  } catch {
    return emptyLedger();
  }
}

async function writeLedgerFile(
  ledger: SharedItemSubscriptionLedger,
): Promise<void> {
  const filePath = getSharedItemUpdateSubscriptionsFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFileAtomically(filePath, JSON.stringify(ledger, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

let ledgerChain: Promise<unknown> = Promise.resolve();

/**
 * Run one ledger read-modify-write at a time, so concurrent fire-and-forget
 * calls cannot overwrite each other's changes.
 */
function serializeLedger<T>(operation: () => Promise<T>): Promise<T> {
  const pending = ledgerChain.then(operation, operation);
  ledgerChain = pending.catch(() => undefined);
  return pending;
}

/**
 * Apply `mutate` to the current ledger and persist it when it reports a
 * change. Resolves with `mutate`'s result.
 */
function updateLedger<T>(
  mutate: (ledger: SharedItemSubscriptionLedger) => {
    changed: boolean;
    result: T;
  },
): Promise<T> {
  return serializeLedger(async () => {
    const ledger = await readLedgerFile();
    const { changed, result } = mutate(ledger);
    if (changed) await writeLedgerFile(ledger);
    return result;
  });
}

/** The current ledger, read after every change queued before this call. */
export function readSharedItemSubscriptionLedger(): Promise<SharedItemSubscriptionLedger> {
  return serializeLedger(readLedgerFile).catch(() => emptyLedger());
}

function union(left: readonly string[], right: readonly string[]): string[] {
  const result = [...left];
  for (const entry of right) {
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

function without(list: readonly string[], entry: string): string[] {
  return list.filter((candidate) => candidate !== entry);
}

function findInstall(
  ledger: SharedItemSubscriptionLedger,
  key: string,
): SharedItemSubscriptionLedgerInstall | undefined {
  return ledger.installs.find(
    (install) => sharedItemSubscriptionKey(install) === key,
  );
}

function accountState(
  ledger: SharedItemSubscriptionLedger,
  accountId: string,
): SharedItemSubscriptionLedgerAccount {
  const existing = ledger.byAccount[accountId];
  if (existing !== undefined) return existing;
  const created = emptyAccount();
  ledger.byAccount[accountId] = created;
  return created;
}

/** Re-upload `key` to every account on the next flush. */
function markUnsyncedEverywhere(
  ledger: SharedItemSubscriptionLedger,
  key: string,
): void {
  for (const account of Object.values(ledger.byAccount)) {
    account.syncedKeys = without(account.syncedKeys, key);
  }
}

/**
 * A malformed hash would make the server reject the whole batch, so it is
 * recorded as unknown instead and the server records the live hash.
 */
function normalizeContentHash(
  item: Omit<SharedItemInstallRecord, 'localId'>,
): string | null {
  if (item.contentHash === null) return null;
  const candidate: SharedItemInstallUpsert = {
    kind: item.kind,
    remoteId: item.remoteId,
    sourceKind: item.sourceKind,
    sourceKey: 'desktop:ledger',
    contentHash: item.contentHash,
  };
  return parseSharedItemInstallUpsert(candidate) === null
    ? null
    : item.contentHash;
}

function isValidRecordIdentity(item: {
  kind: unknown;
  remoteId: unknown;
  sourceKind: unknown;
  localId: unknown;
}): boolean {
  return (
    parseSharedItemKind(item.kind) !== null &&
    parseSharedItemSourceKind(item.sourceKind) !== null &&
    isNonEmptyString(item.remoteId) &&
    isNonEmptyString(item.localId)
  );
}

/**
 * Add one local copy to the ledger. A new key, or a known key with a
 * different hash, becomes a pending upsert for every account, and any
 * removal still owed for the key is cancelled.
 */
function applyInstall(
  ledger: SharedItemSubscriptionLedger,
  record: SharedItemInstallRecord,
): boolean {
  const key = sharedItemSubscriptionKey(record);
  const contentHash = normalizeContentHash(record);
  let changed = false;
  for (const account of Object.values(ledger.byAccount)) {
    if (account.pendingRemovals.includes(key)) {
      account.pendingRemovals = without(account.pendingRemovals, key);
      changed = true;
    }
  }
  const existing = findInstall(ledger, key);
  if (existing === undefined) {
    ledger.installs.push({
      kind: record.kind,
      remoteId: record.remoteId,
      sourceKind: record.sourceKind,
      contentHash,
      localIds: [record.localId],
    });
    markUnsyncedEverywhere(ledger, key);
    return true;
  }
  if (!existing.localIds.includes(record.localId)) {
    existing.localIds.push(record.localId);
    changed = true;
  }
  if (existing.contentHash !== contentHash) {
    existing.contentHash = contentHash;
    markUnsyncedEverywhere(ledger, key);
    changed = true;
  }
  return changed;
}

/**
 * Remove one local copy. When it was the last one the entry goes, which
 * cancels any upsert not yet sent, and every account that already holds the
 * key, at any hash, is owed a removal.
 */
function applyUninstall(
  ledger: SharedItemSubscriptionLedger,
  record: SharedItemUninstallRecord,
): boolean {
  const existing = findInstall(ledger, sharedItemSubscriptionKey(record));
  if (existing === undefined) return false;
  return removeLocalCopy(ledger, existing, record.localId);
}

/**
 * Remove one local copy from every entry of `kind` that lists it, for call
 * sites that can no longer tell which share the copy came from.
 */
function applyLocalUninstall(
  ledger: SharedItemSubscriptionLedger,
  record: SharedItemLocalUninstallRecord,
): boolean {
  let changed = false;
  for (const install of [...ledger.installs]) {
    if (install.kind !== record.kind) continue;
    changed = removeLocalCopy(ledger, install, record.localId) || changed;
  }
  return changed;
}

function removeLocalCopy(
  ledger: SharedItemSubscriptionLedger,
  existing: SharedItemSubscriptionLedgerInstall,
  localId: string,
): boolean {
  if (!existing.localIds.includes(localId)) return false;
  const key = sharedItemSubscriptionKey(existing);
  existing.localIds = without(existing.localIds, localId);
  if (existing.localIds.length > 0) return true;
  ledger.installs = ledger.installs.filter((install) => install !== existing);
  for (const account of Object.values(ledger.byAccount)) {
    if (!account.syncedKeys.includes(key) && !account.heldKeys.includes(key))
      continue;
    account.syncedKeys = without(account.syncedKeys, key);
    account.pendingRemovals = union(account.pendingRemovals, [key]);
  }
  return true;
}

/**
 * Merge backfilled installs. Known keys gain the backfilled local ids; a
 * stored hash fills in an unknown one but never replaces a recorded hash.
 */
function applyBackfill(
  ledger: SharedItemSubscriptionLedger,
  records: readonly SharedItemInstallRecord[],
): boolean {
  let changed = false;
  for (const record of records) {
    if (!isValidRecordIdentity(record)) continue;
    const existing = findInstall(ledger, sharedItemSubscriptionKey(record));
    if (existing === undefined || existing.contentHash === null) {
      changed = applyInstall(ledger, record) || changed;
      continue;
    }
    if (!existing.localIds.includes(record.localId)) {
      existing.localIds.push(record.localId);
      changed = true;
    }
  }
  return changed;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Record that a local copy of a shared item was installed, then upload it in
 * the background. Call after the local write succeeded. Never throws.
 */
export function recordSharedItemInstall(input: SharedItemInstallRecord): void {
  try {
    if (!isValidRecordIdentity(input)) {
      logMainProcessWarn(`${LOG_PREFIX} Ignored an invalid install record.`);
      return;
    }
    const record: SharedItemInstallRecord = {
      kind: input.kind,
      remoteId: input.remoteId,
      sourceKind: input.sourceKind,
      contentHash: input.contentHash,
      localId: input.localId,
    };
    void updateLedger((ledger) => ({
      changed: applyInstall(ledger, record),
      result: undefined,
    }))
      .then(() => flushSharedItemSubscriptions())
      .catch((error: unknown) => {
        logMainProcessWarn(`${LOG_PREFIX} Failed to record an install.`, {
          reason: describeError(error),
        });
      });
  } catch (error) {
    logMainProcessWarn(`${LOG_PREFIX} Failed to record an install.`, {
      reason: describeError(error),
    });
  }
}

/**
 * Record that a local copy of a shared item was removed, then upload any
 * resulting removal in the background. Never throws.
 */
export function recordSharedItemUninstall(
  input: SharedItemUninstallRecord,
): void {
  try {
    if (!isValidRecordIdentity(input)) {
      logMainProcessWarn(`${LOG_PREFIX} Ignored an invalid uninstall record.`);
      return;
    }
    const record: SharedItemUninstallRecord = {
      kind: input.kind,
      remoteId: input.remoteId,
      sourceKind: input.sourceKind,
      localId: input.localId,
    };
    void updateLedger((ledger) => ({
      changed: applyUninstall(ledger, record),
      result: undefined,
    }))
      .then(() => flushSharedItemSubscriptions())
      .catch((error: unknown) => {
        logMainProcessWarn(`${LOG_PREFIX} Failed to record an uninstall.`, {
          reason: describeError(error),
        });
      });
  } catch (error) {
    logMainProcessWarn(`${LOG_PREFIX} Failed to record an uninstall.`, {
      reason: describeError(error),
    });
  }
}

/**
 * Record that a local copy was removed when the call site cannot name the
 * share it came from: every recorded install of `kind` listing `localId`
 * drops it, and any removal that leaves is uploaded in the background.
 * Never throws.
 */
export function recordSharedItemLocalUninstall(
  input: SharedItemLocalUninstallRecord,
): void {
  try {
    if (
      parseSharedItemKind(input.kind) === null ||
      !isNonEmptyString(input.localId)
    ) {
      logMainProcessWarn(`${LOG_PREFIX} Ignored an invalid uninstall record.`);
      return;
    }
    const record: SharedItemLocalUninstallRecord = {
      kind: input.kind,
      localId: input.localId,
    };
    void updateLedger((ledger) => ({
      changed: applyLocalUninstall(ledger, record),
      result: undefined,
    }))
      .then(() => flushSharedItemSubscriptions())
      .catch((error: unknown) => {
        logMainProcessWarn(`${LOG_PREFIX} Failed to record an uninstall.`, {
          reason: describeError(error),
        });
      });
  } catch (error) {
    logMainProcessWarn(`${LOG_PREFIX} Failed to record an uninstall.`, {
      reason: describeError(error),
    });
  }
}

/**
 * Collect shared items installed before this module existed and merge them
 * into the ledger. Rejects when the collector or any one of its sources
 * failed, after merging what it found, so the flush uploads those but does
 * not mark the backfill complete.
 */
export async function runSharedItemSubscriptionBackfill(): Promise<
  SharedItemInstallRecord[]
> {
  const { collectSharedItemInstallsForBackfill } =
    await import('./shared-item-subscription-backfill');
  const { records, complete } = await collectSharedItemInstallsForBackfill();
  await updateLedger((ledger) => ({
    changed: applyBackfill(ledger, records),
    result: undefined,
  }));
  if (!complete) throw new Error('A backfill source could not be read.');
  return records;
}

/** The signed-in non-guest account id, or `null` for none or unknown. */
async function readUploadAccountId(): Promise<string | null> {
  try {
    const result = await readCanopyCloudAccountWithStatus();
    if (result.status !== 'ok' || result.entry === null) return null;
    if (isGuestAccount(result.entry)) return null;
    const accountId = result.entry.account?.id.trim();
    return accountId === undefined || accountId.length === 0 ? null : accountId;
  } catch {
    return null;
  }
}

async function readSourceKey(): Promise<string | null> {
  try {
    const state = await readPortalStateStore();
    const sourceKey = `desktop:${state.clientDeviceId}`;
    return isValidSharedItemSourceKey(sourceKey) ? sourceKey : null;
  } catch {
    return null;
  }
}

type BatchOperation =
  | {
      type: 'upsert';
      key: string;
      contentHash: string | null;
      wire: SharedItemInstallUpsert;
    }
  | { type: 'removal'; key: string; wire: SharedItemInstallRemoval };

function removalFromKey(
  key: string,
  sourceKey: string,
): SharedItemInstallRemoval | null {
  const [kind, sourceKind, ...rest] = key.split(':');
  return parseSharedItemInstallRemoval({
    kind,
    sourceKind,
    remoteId: rest.join(':'),
    sourceKey,
  });
}

/**
 * Collect what `accountId` is owed. Entries the server would reject as
 * malformed are settled here, so one bad entry cannot fail every batch.
 */
function collectPendingWork(
  ledger: SharedItemSubscriptionLedger,
  accountId: string,
  sourceKey: string,
): { changed: boolean; result: BatchOperation[] } {
  const account = ledger.byAccount[accountId] ?? emptyAccount();
  let changed = false;
  const operations: BatchOperation[] = [];
  for (const install of ledger.installs) {
    const key = sharedItemSubscriptionKey(install);
    if (account.syncedKeys.includes(key)) continue;
    const wire = parseSharedItemInstallUpsert({
      kind: install.kind,
      remoteId: install.remoteId,
      sourceKind: install.sourceKind,
      sourceKey,
      contentHash: install.contentHash,
    });
    if (wire === null) {
      accountState(ledger, accountId).syncedKeys.push(key);
      changed = true;
      continue;
    }
    operations.push({
      type: 'upsert',
      key,
      contentHash: install.contentHash,
      wire,
    });
  }
  for (const key of account.pendingRemovals) {
    const wire = removalFromKey(key, sourceKey);
    if (wire === null) {
      const state = accountState(ledger, accountId);
      state.pendingRemovals = without(state.pendingRemovals, key);
      changed = true;
      continue;
    }
    operations.push({ type: 'removal', key, wire });
  }
  return { changed, result: operations };
}

function isSettled(result: SharedItemSubscriptionItemResult): boolean {
  return result.ok || isPermanentSharedItemSubscriptionError(result.code);
}

/**
 * Record one chunk's per-item results for `accountId`. Permanent failures
 * settle like successes; transient ones stay pending. An upsert only counts
 * when the ledger still holds the hash that was sent, and a successful upsert
 * for an item uninstalled meanwhile is owed a removal.
 */
function applyChunkResults(
  ledger: SharedItemSubscriptionLedger,
  accountId: string,
  upserts: readonly Extract<BatchOperation, { type: 'upsert' }>[],
  removals: readonly Extract<BatchOperation, { type: 'removal' }>[],
  results: {
    upserts: readonly SharedItemSubscriptionItemResult[];
    removals: readonly SharedItemSubscriptionItemResult[];
  },
): boolean {
  const account = accountState(ledger, accountId);
  upserts.forEach((operation, index) => {
    const result = results.upserts[index];
    if (result === undefined || !isSettled(result)) return;
    if (result.ok) account.heldKeys = union(account.heldKeys, [operation.key]);
    const install = findInstall(ledger, operation.key);
    if (install === undefined) {
      if (result.ok) {
        account.pendingRemovals = union(account.pendingRemovals, [
          operation.key,
        ]);
      }
      return;
    }
    if (install.contentHash !== operation.contentHash) return;
    account.syncedKeys = union(account.syncedKeys, [operation.key]);
  });
  removals.forEach((operation, index) => {
    const result = results.removals[index];
    if (result === undefined || !isSettled(result)) return;
    account.pendingRemovals = without(account.pendingRemovals, operation.key);
    account.heldKeys = without(account.heldKeys, operation.key);
  });
  return true;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Send one chunk. Returns `false` when the whole request failed. */
async function sendChunk(
  accountId: string,
  operations: readonly BatchOperation[],
): Promise<boolean> {
  const upserts = operations.filter(
    (operation): operation is Extract<BatchOperation, { type: 'upsert' }> =>
      operation.type === 'upsert',
  );
  const removals = operations.filter(
    (operation): operation is Extract<BatchOperation, { type: 'removal' }> =>
      operation.type === 'removal',
  );
  let response: unknown;
  try {
    response = await requestCanopyCloudJson<unknown>(BATCH_PATH, {
      method: 'POST',
      body: JSON.stringify({
        upserts: upserts.map((operation) => operation.wire),
        removals: removals.map((operation) => operation.wire),
      }),
      timeoutMs: BATCH_TIMEOUT_MS,
    });
  } catch (error) {
    logMainProcessWarn(`${LOG_PREFIX} Upload failed; will retry later.`, {
      reason: describeError(error),
    });
    return false;
  }
  const results = parseSharedItemSubscriptionBatchResult(response);
  if (
    results === null ||
    results.upserts.length !== upserts.length ||
    results.removals.length !== removals.length
  ) {
    logMainProcessWarn(`${LOG_PREFIX} Upload returned an invalid response.`);
    return false;
  }
  await updateLedger((ledger) => ({
    changed: applyChunkResults(ledger, accountId, upserts, removals, results),
    result: undefined,
  }));
  return true;
}

async function flushOnce(): Promise<void> {
  const accountId = await readUploadAccountId();
  if (accountId === null) return;
  const sourceKey = await readSourceKey();
  if (sourceKey === null) return;

  const before = await readSharedItemSubscriptionLedger();
  const needsBackfill =
    (before.byAccount[accountId]?.backfillVersion ?? 0) <
    CURRENT_BACKFILL_VERSION;
  let backfillCollected = false;
  if (needsBackfill) {
    try {
      await runSharedItemSubscriptionBackfill();
      backfillCollected = true;
    } catch (error) {
      logMainProcessWarn(`${LOG_PREFIX} Backfill failed; will retry later.`, {
        reason: describeError(error),
      });
    }
  }

  const pending = await updateLedger((ledger) =>
    collectPendingWork(ledger, accountId, sourceKey),
  );
  for (const operations of chunk(pending, MAX_SHARED_ITEM_BATCH_SIZE)) {
    // `requestCanopyCloudJson` resolves credentials per request. Never send
    // one account's entries under another account's key.
    if ((await readUploadAccountId()) !== accountId) return;
    if (!(await sendChunk(accountId, operations))) return;
  }
  if (needsBackfill && backfillCollected) {
    await updateLedger((ledger) => {
      accountState(ledger, accountId).backfillVersion =
        CURRENT_BACKFILL_VERSION;
      return { changed: true, result: undefined };
    });
  }
}

let flushInFlight: Promise<void> | null = null;
let flushRequested = false;

/**
 * Upload pending upserts and removals for the signed-in non-guest account.
 * Single-flight: a call while a flush runs joins it, and the flush runs once
 * more afterwards so a change recorded mid-flight is not left waiting for the
 * next trigger. There is no retry timer. Never rejects.
 */
export function flushSharedItemSubscriptions(): Promise<void> {
  if (flushInFlight !== null) {
    flushRequested = true;
    return flushInFlight;
  }
  const run = async (): Promise<void> => {
    do {
      flushRequested = false;
      try {
        await flushOnce();
      } catch (error) {
        logMainProcessWarn(`${LOG_PREFIX} Flush failed.`, {
          reason: describeError(error),
        });
      }
    } while (flushRequested);
  };
  flushInFlight = run().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

/**
 * Flush whenever the signed-in non-guest account changes, which covers
 * sign-in and account switches. Re-persisting the same account (capability
 * re-probes, token refreshes) and guest sessions do not trigger a flush.
 * Returns an unsubscribe closure.
 */
export function subscribeSharedItemSubscriptionFlush(): () => void {
  // `undefined` is "not yet observed", so the first real account always
  // flushes, including when that first event is the sign-in itself.
  let lastAccountId: string | null | undefined;
  return subscribeCanopyCloudAccountChanges((entry): void => {
    const id =
      entry === null || isGuestAccount(entry) ? '' : entry.account?.id.trim();
    const accountId = id === undefined || id.length === 0 ? null : id;
    if (accountId === lastAccountId) return;
    lastAccountId = accountId;
    if (accountId === null) return;
    void flushSharedItemSubscriptions();
  });
}

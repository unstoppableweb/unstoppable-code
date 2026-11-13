import * as fs from 'fs';
import * as path from 'path';
import { BRAND } from '@canopy/brand/current';
import { writeFileAtomicallySync } from '@canopy/execution-engine/node/lib/atomic-file';
import {
  damagedCopyPath,
  pruneDamagedCopiesSync,
} from '@canopy/execution-engine/node/lib/damaged-copies';
import type { PluginProvider } from '@canopy/execution-engine/types/plugins';
import { getBuiltInPluginMarketplacesFilePath } from '../lib/paths';
import { logMainProcessWarn } from '../lib/main-process-logging';

/**
 * Receipts for the managed marketplaces (built-in and curated) this app
 * registered with a provider: one per provider, marketplace name and local
 * root. A receipt lets a later install recognize a managed registration whose
 * root has since moved, such as the bundled root of an older app version, and
 * repair it instead of reporting a foreign marketplace (CAN-4482).
 *
 * Reads have no side effects. Only the writers (`record`, `reconcile`) copy a
 * damaged file aside, keeping the newest `DAMAGED_COPY_LIMIT` copies, and
 * they never write over a newer or unreadable one.
 * Each write is a synchronous read-modify-write that only adds receipts, so
 * writers in this process never interleave; the single-instance lock keeps
 * other app processes out.
 */

const LEDGER_VERSION = 1;

export interface ManagedMarketplaceReceiptKey {
  provider: PluginProvider;
  marketplaceName: string;
  sourceRoot: string;
}

export interface ManagedMarketplaceReceipt extends ManagedMarketplaceReceiptKey {
  brandId?: string;
  recordedAt?: string;
}

/**
 * `damaged`: the file does not parse, has the wrong shape, or holds invalid
 * entries; the valid ones are still returned. `newer` and `unreadable` return
 * no receipts, which only ever makes a registration look foreign, never ours.
 */
export type ManagedMarketplaceLedgerStatus =
  | 'ok'
  | 'missing'
  | 'damaged'
  | 'newer'
  | 'unreadable';

export interface ManagedMarketplaceLedgerRead {
  status: ManagedMarketplaceLedgerStatus;
  receipts: ManagedMarketplaceReceipt[];
}

/** What a provider currently has registered under one managed name. */
export interface ManagedMarketplaceObservation {
  provider: PluginProvider;
  marketplaceName: string;
  managedRoot: string;
  /** The registered local root, or `null` when there is none to compare. */
  registeredRoot: string | null;
}

export type ManagedMarketplaceReceiptWrite =
  | { status: 'recorded'; added: number }
  | { status: 'unchanged' }
  | { status: 'refused'; reason: 'newer' | 'unreadable' }
  | { status: 'failed'; error: string };

let reportedRefusedWrite = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseReceipt(value: unknown): ManagedMarketplaceReceipt | null {
  if (!isRecord(value)) return null;
  const { provider, marketplaceName, sourceRoot, brandId, recordedAt } = value;
  if (
    (provider !== 'claude' && provider !== 'codex') ||
    typeof marketplaceName !== 'string' ||
    typeof sourceRoot !== 'string' ||
    !path.isAbsolute(sourceRoot)
  ) {
    return null;
  }
  return {
    provider,
    marketplaceName,
    sourceRoot,
    ...(typeof brandId === 'string' ? { brandId } : {}),
    ...(typeof recordedAt === 'string' ? { recordedAt } : {}),
  };
}

function matchesReceipt(
  receipt: ManagedMarketplaceReceiptKey,
  key: ManagedMarketplaceReceiptKey,
): boolean {
  return (
    receipt.provider === key.provider &&
    receipt.marketplaceName.toLowerCase() ===
      key.marketplaceName.toLowerCase() &&
    path.resolve(receipt.sourceRoot) === path.resolve(key.sourceRoot)
  );
}

export function readManagedMarketplaceLedger(): ManagedMarketplaceLedgerRead {
  const filePath = getBuiltInPluginMarketplacesFilePath();
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return {
      status: errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable',
      receipts: [],
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { status: 'damaged', receipts: [] };
  }
  if (!isRecord(data) || typeof data.version !== 'number') {
    return { status: 'damaged', receipts: [] };
  }
  if (data.version > LEDGER_VERSION) return { status: 'newer', receipts: [] };
  if (data.version !== LEDGER_VERSION || !Array.isArray(data.entries)) {
    return { status: 'damaged', receipts: [] };
  }
  const receipts = data.entries.flatMap((entry: unknown) => {
    const receipt = parseReceipt(entry);
    return receipt ? [receipt] : [];
  });
  return {
    status: receipts.length === data.entries.length ? 'ok' : 'damaged',
    receipts,
  };
}

export function hasManagedMarketplaceReceipt(
  key: ManagedMarketplaceReceiptKey,
): boolean {
  if (!path.isAbsolute(key.sourceRoot)) return false;
  return readManagedMarketplaceLedger().receipts.some((receipt) =>
    matchesReceipt(receipt, key),
  );
}

/**
 * The receipts `observations` prove missing: a provider registration at the
 * current managed root with no receipt for it. Any other observation (a
 * different root, a missing root, no registration) proves nothing, and no
 * receipt is ever removed.
 */
export function missingManagedMarketplaceReceipts(
  receipts: readonly ManagedMarketplaceReceiptKey[],
  observations: readonly ManagedMarketplaceObservation[],
): ManagedMarketplaceReceiptKey[] {
  const missing: ManagedMarketplaceReceiptKey[] = [];
  for (const observation of observations) {
    const { registeredRoot, managedRoot } = observation;
    if (
      registeredRoot === null ||
      !path.isAbsolute(registeredRoot) ||
      !path.isAbsolute(managedRoot) ||
      path.resolve(registeredRoot) !== path.resolve(managedRoot)
    ) {
      continue;
    }
    const key: ManagedMarketplaceReceiptKey = {
      provider: observation.provider,
      marketplaceName: observation.marketplaceName,
      sourceRoot: path.resolve(managedRoot),
    };
    if (
      receipts.some((receipt) => matchesReceipt(receipt, key)) ||
      missing.some((receipt) => matchesReceipt(receipt, key))
    ) {
      continue;
    }
    missing.push(key);
  }
  return missing;
}

function addReceipts(
  additions: readonly ManagedMarketplaceReceiptKey[],
  { durable }: { durable: boolean },
): ManagedMarketplaceReceiptWrite {
  try {
    const filePath = getBuiltInPluginMarketplacesFilePath();
    const current = readManagedMarketplaceLedger();
    if (current.status === 'newer' || current.status === 'unreadable') {
      if (!reportedRefusedWrite) {
        reportedRefusedWrite = true;
        logMainProcessWarn(
          `managed-marketplace-ledger: not recording receipts; the receipt file is ${
            current.status === 'newer' ? 'from a newer version' : 'unreadable'
          }`,
        );
      }
      return { status: 'refused', reason: current.status };
    }
    const missing = additions.filter(
      (key) =>
        !current.receipts.some((receipt) => matchesReceipt(receipt, key)),
    );
    if (missing.length === 0) return { status: 'unchanged' };
    const recordedAt = new Date().toISOString();
    const entries: ManagedMarketplaceReceipt[] = [
      ...current.receipts,
      ...missing.map((key) => ({ ...key, brandId: BRAND.id, recordedAt })),
    ];
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const aside =
      current.status === 'damaged' ? damagedCopyPath(filePath) : null;
    // Copied, not moved: the damaged file and its valid receipts stay readable
    // until the rewrite renames over it.
    if (aside) {
      fs.copyFileSync(filePath, aside);
      pruneDamagedCopiesSync(filePath);
    }
    writeFileAtomicallySync(
      filePath,
      JSON.stringify({ version: LEDGER_VERSION, entries }, null, 2),
      { encoding: 'utf8', durable },
    );
    if (aside) {
      logMainProcessWarn(
        `managed-marketplace-ledger: copied a damaged receipt file aside as ${path.basename(aside)}`,
      );
    }
    return { status: 'recorded', added: missing.length };
  } catch (error) {
    return { status: 'failed', error: errorMessage(error) };
  }
}

/** Records one receipt. Never throws: a failed write is returned, not raised. */
export function recordManagedMarketplaceReceipt(
  key: ManagedMarketplaceReceiptKey,
): ManagedMarketplaceReceiptWrite {
  if (!path.isAbsolute(key.sourceRoot)) return { status: 'unchanged' };
  return addReceipts([{ ...key, sourceRoot: path.resolve(key.sourceRoot) }], {
    durable: true,
  });
}

/**
 * Adds the receipts `observations` prove missing, in at most one write. It
 * makes no provider call of its own. Never throws.
 */
export function reconcileManagedMarketplaceReceipts(
  observations: readonly ManagedMarketplaceObservation[],
): ManagedMarketplaceReceiptWrite {
  const candidates = missingManagedMarketplaceReceipts([], observations);
  if (candidates.length === 0) return { status: 'unchanged' };
  // Atomic, not fsynced (Mike, 2026-10-29): each receipt here is derived from
  // a registration the provider already holds, so a write lost to power loss
  // is rewritten by the next reconcile.
  return addReceipts(candidates, { durable: false });
}

/** @internal Test-only: re-arm the once-per-process refused-write warning. */
export function resetManagedMarketplaceLedgerForTests(): void {
  reportedRefusedWrite = false;
}

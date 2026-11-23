import { readFile } from 'node:fs/promises';
import {
  isInstallReceipt,
  normalizeInstallReceiptDisplayNames,
  type InstallReceipt,
} from '@canopy/execution-engine/lib/resource-context-policy';

/** The install receipts file's name under the data root. */
export const RESOURCE_INSTALL_RECEIPTS_FILE_NAME =
  'resource-install-receipts.json';

interface ReceiptFile {
  version: 1;
  byAccount: Record<string, unknown[]>;
}

function normalizeReceipt(receipt: InstallReceipt): InstallReceipt {
  return {
    ...(receipt.localResourceIds
      ? { localResourceIds: Array.from(new Set(receipt.localResourceIds)) }
      : {}),
    ...(receipt.uninstalledLocalResourceIds
      ? {
          uninstalledLocalResourceIds: [...receipt.uninstalledLocalResourceIds],
        }
      : {}),
    family: receipt.family,
    remoteId: receipt.remoteId,
    ...(receipt.sourceKind ? { sourceKind: receipt.sourceKind } : {}),
    shareScope: receipt.shareScope,
    ownerContext:
      receipt.ownerContext.kind === 'personal'
        ? { kind: 'personal' }
        : {
            kind: 'organization',
            organizationId: receipt.ownerContext.organizationId,
          },
    hash: receipt.hash,
    authorizedAt: receipt.authorizedAt,
    ...(receipt.localContentHashes
      ? { localContentHashes: { ...receipt.localContentHashes } }
      : {}),
    ...(receipt.localResourceRoles
      ? { localResourceRoles: { ...receipt.localResourceRoles } }
      : {}),
    ...normalizeInstallReceiptDisplayNames(receipt),
  };
}

interface ReadReceiptFile extends ReceiptFile {
  /** Accounts whose entry is not a list; non-strict reads skip them. */
  unreadableAccounts: string[];
}

async function readReceipts(
  file: string,
  strict = false,
): Promise<ReadReceiptFile> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return { version: 1, byAccount: {}, unreadableAccounts: [] };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid resource install receipt file');
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'number' &&
    value.version > 1
  ) {
    throw new Error('Resource install receipt file is from a newer version');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('byAccount' in value) ||
    typeof value.byAccount !== 'object' ||
    value.byAccount === null ||
    Array.isArray(value.byAccount)
  ) {
    throw new Error('Invalid resource install receipt file');
  }
  const unreadableAccounts: string[] = [];
  const entries = Object.entries(value.byAccount).map(
    ([account, receipts]: [string, unknown]): [string, unknown[]] => {
      if (!Array.isArray(receipts)) {
        if (strict) throw new Error('Invalid resource install receipt file');
        unreadableAccounts.push(account);
        return [account, []];
      }
      // Mutations retain raw rows, including malformed or future-version data.
      // Only lookup results are filtered and normalized.
      return [account, receipts];
    },
  );
  return {
    version: 1,
    byAccount: Object.fromEntries(entries),
    unreadableAccounts,
  };
}

/**
 * Provenance lookups fail closed: a row this build cannot read may still
 * record an organization origin for the resource being looked up.
 */
function assertNoUnreadableProvenance(
  state: ReadReceiptFile,
  family: string,
  names: (row: Record<string, unknown>) => boolean,
): void {
  const unreadable =
    state.unreadableAccounts.length > 0 ||
    Object.values(state.byAccount).some((rows) =>
      rows.some(
        (row) =>
          !isInstallReceipt(row) &&
          typeof row === 'object' &&
          row !== null &&
          !Array.isArray(row) &&
          (!('family' in row) ||
            typeof row.family !== 'string' ||
            row.family === family) &&
          names(Object.fromEntries(Object.entries(row))),
      ),
    );
  if (unreadable) throw new Error('Unreadable resource install receipt');
}

/**
 * The receipt that names a local resource, under any account. A row this
 * build can't read that may name it fails the lookup closed.
 */
async function findLocalInstallReceipt(
  file: string,
  family: string,
  localId: string,
): Promise<{ accountId: string; receipt: InstallReceipt } | undefined> {
  const state = await readReceipts(file);
  assertNoUnreadableProvenance(
    state,
    family,
    (row) =>
      Array.isArray(row.localResourceIds) &&
      row.localResourceIds.includes(localId),
  );
  for (const [ownerAccount, receipts] of Object.entries(state.byAccount)) {
    const receipt = receipts
      .filter(isInstallReceipt)
      .find(
        (row) =>
          row.family === family && row.localResourceIds?.includes(localId),
      );
    if (receipt)
      return {
        accountId: ownerAccount,
        receipt: normalizeReceipt(receipt),
      };
  }
  return undefined;
}

export {
  assertNoUnreadableProvenance,
  findLocalInstallReceipt,
  normalizeReceipt,
  readReceipts,
};
export type { ReceiptFile };

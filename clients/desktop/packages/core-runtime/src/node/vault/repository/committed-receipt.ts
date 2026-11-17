import { vaultPutReceiptMatches } from './receipts';
import { openVaultSecret } from './sealed-secret';
import type { VaultStoredEntry, VaultStoredIntent } from './store-records';
import type { VaultSubkeys } from './vault-keys';
import { zeroBytes } from './zero-bytes';

/** Correlate the live encrypted revision to its exact input key, not just a bare intent row. */
export function verifyCommittedReceipt(
  keys: VaultSubkeys,
  entry: VaultStoredEntry,
  intent: VaultStoredIntent,
): boolean {
  if (
    intent.kind !== 'put' ||
    intent.state !== 'committed' ||
    intent.entryId !== entry.entryId ||
    intent.family !== entry.family ||
    intent.outcomeRevision !== entry.revision
  )
    return false;
  const opened = openVaultSecret(
    keys,
    { ...entry, vaultId: keys.vaultId },
    entry.sealed,
  );
  if (opened.kind !== 'opened') return false;
  try {
    return vaultPutReceiptMatches(
      keys,
      {
        vaultId: keys.vaultId,
        family: entry.family,
        entryId: intent.expectedRevision === null ? null : entry.entryId,
        expectedRevision: intent.expectedRevision,
        label: entry.label,
        expiresAt: entry.expiresAt,
        idempotencyKey: intent.idempotencyKey,
        material: opened.material,
      },
      intent.receipt,
    );
  } finally {
    zeroBytes(opened.material);
  }
}

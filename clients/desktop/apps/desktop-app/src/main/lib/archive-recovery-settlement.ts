import {
  ArchiveRecoveryRefusedError,
  type ArchiveRecoveryReceipt,
  type ArchiveRecoveryStore,
} from '@canopy/desktop-shared/node/archive-recovery-store';

export interface ArchiveRecoverySettlementPorts {
  store: ArchiveRecoveryStore;
  admitResolution(receipt: ArchiveRecoveryReceipt): Promise<void>;
  admitDeletion(): Promise<void>;
  qualifyRefs(receipt: ArchiveRecoveryReceipt): Promise<void>;
  deleteRefs(receipt: ArchiveRecoveryReceipt): Promise<void>;
  withdraw(receipt: ArchiveRecoveryReceipt): Promise<ArchiveRecoveryReceipt>;
}

/** Resource admission guards only effects still ahead, not already-committed acknowledgements. */
export async function settleArchiveRecovery(
  receipt: ArchiveRecoveryReceipt,
  goal: 'resolve' | 'delete-hold' | 'committed-parent',
  ports: ArchiveRecoverySettlementPorts,
): Promise<ArchiveRecoveryReceipt> {
  const { store } = ports;
  await store.normalize(receipt.workspaceId, receipt.operationId);
  if (receipt.cancelled) {
    if (goal !== 'resolve')
      throw new ArchiveRecoveryRefusedError('The resolution was cancelled.');
    await ports.admitResolution(receipt);
    await ports.qualifyRefs(receipt);
    receipt = await store.restartCancelled(receipt);
  }
  if (goal !== 'resolve') {
    if (receipt.stage !== 'completed')
      throw new ArchiveRecoveryRefusedError(
        `Unfinished archive resolution ${receipt.operationId} requires recovery.`,
      );
    if (receipt.retention === 'deleted') return receipt;
    if (!receipt.retention) {
      if (goal !== 'committed-parent') await ports.admitDeletion();
      await ports.qualifyRefs(receipt);
      const evidence = await store.inspect(receipt);
      if (
        evidence.copies.some((copy) => copy !== 'retired') ||
        evidence.payload === 'conflict' ||
        evidence.payload === 'subset'
      )
        throw new ArchiveRecoveryRefusedError(
          'Retained hold evidence changed before deletion.',
        );
      receipt = await store.beginDeletion(receipt);
    }
    await ports.deleteRefs(receipt);
    return store.deletePayload(receipt);
  }
  if (receipt.stage === 'completed') return receipt;
  if (
    ['prepared', 'retention-intent', 'retained', 'reset-intent'].includes(
      receipt.stage,
    )
  ) {
    const evidence = await store.inspect(receipt);
    // A rename without its acknowledgement is forward-only, even if the project vanished.
    if (evidence.reset !== 'performed') {
      try {
        await ports.admitResolution(receipt);
      } catch (error) {
        if (
          error instanceof ArchiveRecoveryRefusedError &&
          evidence.effectFree
        ) {
          // Ref preservation is independent of the now-refused project/checkout admission.
          await ports.qualifyRefs(receipt);
          await store.cancel(receipt);
        }
        throw error;
      }
    }
    if (receipt.stage !== 'reset-intent')
      receipt = await store.publishRetention(receipt);
    receipt = await store.resetStaging(receipt);
  }
  if (
    receipt.stage === 'staging-reset' ||
    receipt.stage === 'withdrawal-intent'
  )
    receipt = await ports.withdraw(receipt);
  if (receipt.stage === 'withdrawn')
    receipt = await store.writeStage(receipt, 'completed');
  return receipt;
}

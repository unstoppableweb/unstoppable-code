// Owned test process: reserve through the real daemon W5 host and framed
// authority, then remain alive until the test crashes this process.
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { STORAGE_OWNERSHIP } from '@canopy/core-runtime/storage';
import { startW5DaemonRecordHarness } from '@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-daemon-record-harness';
import { createDaemonW5Host } from '../../../../../../core-daemon/src/w5-host';

async function main(): Promise<void> {
  const [dataRoot, workerEntry] = process.argv.slice(2);
  if (!dataRoot || !workerEntry) throw new Error('Missing test-owned paths');
  for (const row of STORAGE_OWNERSHIP)
    if (
      ['workspace_index', 'workspace_manifest', 'worktree_list'].includes(
        row.id,
      )
    )
      Object.assign(row, { transitionOwner: 'daemon', currentWriters: [] });
  const daemon = createDaemonW5Host({
    os: hostPlatformOperatingSystem(),
    canonicalDataRoot: dataRoot,
    workerEntry,
    admission: () => Promise.resolve(),
  });
  await daemon.open();
  const harness = await startW5DaemonRecordHarness({ host: daemon.port });
  const client = await harness.connect();
  await client.instruction('core.workspaceRecords.reservation.reserve', {
    reservationId: 'crashed',
    operation: 'core.workspace.update',
    diagnostics: '{}',
  });
  process.stdout.write(
    `${JSON.stringify({ reserved: 'crashed', hostPid: process.pid })}\n`,
  );
}
process.stdin.resume();
void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});

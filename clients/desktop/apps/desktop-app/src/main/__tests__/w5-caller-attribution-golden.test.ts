import { installRoutedW5GoldenStore } from '../lib/__tests__/fixtures/w5-routed-golden-store';
// CAN-6944: W5 capture requests and store reads are charged to the IPC
// caller that made them, even when the record port's batching reader sends
// several callers' reads in one capture. Real W5 authority, framed record
// port and batching reader; the build flag is the only thing the test sets.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resetWorkCounters,
  runWithW5Caller,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { desktopW5FileStore } from '../lib/w5-commit-log-file-store';
import { getWorkspacesRootDir } from '../lib/paths';

jest.setTimeout(60_000);

let dir: string;
let originalDataDir: string | undefined;
let closeW5Store: (() => Promise<void>) | undefined;

function setE2eBuild(value: boolean): void {
  Object.defineProperty(globalThis, '__CANOPY_E2E__', {
    value,
    configurable: true,
    writable: true,
  });
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'w5-caller-attribution-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  closeW5Store = await installRoutedW5GoldenStore();
});

afterAll(async () => {
  await closeW5Store?.();
  Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

function readList(workspaceId: string): Promise<unknown> {
  return desktopW5FileStore.read(
    join(getWorkspacesRootDir(), workspaceId, 'worktrees.json'),
  );
}

/** Two callers whose record reads all enter the batching reader in one tick. */
async function burst(): Promise<void> {
  await Promise.all([
    runWithW5Caller('caller:a', () =>
      Promise.all([readList('ws-a1'), readList('ws-a2')]),
    ),
    runWithW5Caller('caller:b', () => readList('ws-b1')),
  ]);
}

describe('W5 work is charged to the caller that asked', () => {
  it('charges each caller in one batched burst exactly its own reads', async () => {
    setE2eBuild(true);
    resetWorkCounters();
    await burst();
    const { w5, w5Caller } = snapshotWorkCounters();
    // The batching reader served the burst in fewer captures than reads.
    expect(w5['port.capture']).toBeLessThan(3);
    expect(w5Caller).toEqual({
      'caller:a.capture': 2,
      'caller:a.storeRead': 2,
      'caller:b.capture': 1,
      'caller:b.storeRead': 1,
    });
  });

  it('charges nothing outside E2E builds', async () => {
    setE2eBuild(false);
    resetWorkCounters();
    await burst();
    const { w5, w5Caller } = snapshotWorkCounters();
    expect(w5['read.backend.capture']).toBe(3);
    expect(w5Caller).toEqual({});
  });
});

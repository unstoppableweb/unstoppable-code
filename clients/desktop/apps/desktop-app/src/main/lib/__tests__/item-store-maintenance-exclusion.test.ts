import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import { acquireW5DesktopDeleteGate } from '@canopy/core-platform/w5-process-file-lock';
import {
  ExclusiveMaintenanceRefusedError,
  withExclusiveOfflineMaintenance,
} from '@canopy/core-runtime/node/maintenance/exclusive-window';
import { ItemStoreMaintenanceRefusedError } from '@canopy/core-runtime/node/maintenance/item-store-quiesce';
import type {
  ItemStoreDiagnosis,
  ItemStoreMaintenanceTarget,
} from '@canopy/core-runtime/node/maintenance/item-store-targets';
import { W5CommitLog } from '@canopy/core-runtime/node/w5/commit-log';
import {
  joinW5RootPresence,
  leaveW5RootPresenceSync,
} from '@canopy/desktop-shared/node/w5-root-presence';
import {
  createElectronItemStoreQuiesce,
  diagnoseElectronItemStores,
  electronItemStoreMaintenanceOptions,
} from '../item-store-maintenance';

// CAN-4498: the item-store window over real claim, presence and record files,
// against real host and maintenance children on a temporary POSIX root.
jest.setTimeout(60_000);
const posix = process.platform === 'win32' ? test.skip : test;
const fixture = join(__dirname, 'fixtures/item-store-maintenance-child.ts');
const workerEntry = join(__dirname, 'fixtures/w5-commit-log-source-worker.ts');
const [primaryDir, alternateDir] = BRAND.storage.projectConfigDirNames;
// Lock inodes a refused host may create; neither holds store bytes.
const LOCKS = new Set([
  'data/w5-presence/w5-root-presence.sqlite',
  'data/runtime/locks/desktop-delete.sqlite',
]);
const EVIDENCE = [
  'data/runtime/w5-recovery-result.json',
  'data/w5/commit-log.sqlite',
  `data/w5/destructive-lifecycles/${'a'.repeat(64)}.json`,
  'data/workspaces/local/notes/note.json.damaged-1',
];
// memberLiveness proves a running cohort member live only from a darwin start
// identity; elsewhere it stays 'unknown', so its hostKind is never reported.
const LIVE_COHORT_PEERS = process.platform === 'darwin' ? ['cli'] : ['unknown'];

interface Exit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
interface Child {
  readonly pid: number;
  /** The first stdout JSON line; rejects if the child exits first. */
  ready(): Promise<unknown>;
  readonly exited: Promise<Exit>;
  release(): void;
}

let temporary: string;
let data: string;
let external: string;
const running = new Set<ChildProcessWithoutNullStreams>();

function start(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Child {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
  running.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  child.stderr.on('data', (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  const exited = new Promise<Exit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      running.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
  const ready = (): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        const end = stdout.indexOf('\n');
        if (end < 0) return;
        child.stdout.off('data', check);
        resolve(JSON.parse(stdout.slice(0, end)));
      };
      child.stdout.on('data', check);
      check();
      void exited.then((exit) =>
        reject(new Error(`Child exited ${exit.code}: ${exit.stderr}`)),
      );
    });
  return {
    pid: child.pid ?? 0,
    ready,
    exited,
    release: () => child.stdin.end(),
  };
}

function startChild(mode: string, arg = '-', hold = ''): Child {
  // ESM too: host admission imports core-platform dynamically.
  return start(process.execPath, [
    '--import',
    'tsx',
    fixture,
    mode,
    data,
    arg,
    hold,
  ]);
}

function lines(stdout: string): unknown[] {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line));
}

/** Every file under the data root and the external Cowork folder. */
function snapshot(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const key = relative(temporary, path);
      if (entry.isDirectory()) walk(path);
      else if (!LOCKS.has(key))
        files[key] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex');
    }
  };
  for (const root of [data, external]) if (existsSync(root)) walk(root);
  return files;
}

function evidence(): Record<string, string | undefined> {
  const files = snapshot();
  return Object.fromEntries(EVIDENCE.map((path) => [path, files[path]]));
}

/** The startup claim or CAN-3797 record a window failed to withdraw. */
function leftovers(): string[] {
  return ['runtime/startup-claim.json', 'runtime/w5-maintenance.json'].filter(
    (path) => existsSync(join(data, path)),
  );
}

function put(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600 });
}

function quiesce(
  mutating: boolean,
): ReturnType<typeof createElectronItemStoreQuiesce> {
  return createElectronItemStoreQuiesce(data, { mutating });
}

beforeEach(() => {
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'ism-')));
  data = join(temporary, 'data');
  external = join(temporary, 'cowork-folder');
  mkdirSync(join(data, 'runtime'), { recursive: true, mode: 0o700 });
  const local = join(data, 'workspaces/local');
  put(join(data, 'workspaces/index.json'), '{"version":1,"workspaces":[]}');
  put(join(local, 'notes/note.json'), '{"version":1,"body":"note"}');
  put(join(local, 'notes/note.json.damaged-1'), 'damaged');
  put(join(local, 'prompts/prompt.json'), '{"version":1}');
  put(join(local, 'CLAUDE.md'), '# Local');
  put(join(local, 'repo-rules.json'), '{"version":1,"rules":[]}');
  put(join(local, 'worktree-data/main/file-annotations.json'), '{}');
  put(
    join(data, 'workspaces/cowork/workspace.json'),
    JSON.stringify({ type: 'cowork', externalPath: external }),
  );
  put(join(external, `${primaryDir}/notes/a.json`), '{"version":1}');
  put(join(external, `${alternateDir}/notes/b.json`), '{"version":1}');
  // Evidence the window must never change.
  put(join(data, 'runtime/w5-recovery-result.json'), '{"version":1}');
  put(join(data, `w5/destructive-lifecycles/${'a'.repeat(64)}.json`), '{}');
  W5CommitLog.open(join(data, 'w5/commit-log.sqlite')).close();
});

afterEach(async () => {
  leaveW5RootPresenceSync();
  const exits = [...running].map(
    (child) => new Promise((resolve) => child.once('close', resolve)),
  );
  for (const child of running) child.kill('SIGKILL');
  await Promise.all(exits);
  rmSync(temporary, { recursive: true, force: true });
});

posix.each([
  ['a. an Electron writer holding SHARED', 'electron', []],
  ['c. a presence holder labelled daemon', 'daemon', []],
  ['d. a live legacy cohort member', 'cohort', LIVE_COHORT_PEERS],
] as const)(
  '%s: host-active, op never runs, nothing changes',
  async (_case, mode, peers) => {
    const holder = startChild(mode, '-', 'hold');
    expect(await holder.ready()).toEqual({ admitted: true });
    const before = snapshot();
    const op = jest.fn(() => Promise.resolve('ran'));
    const refusal: unknown = await quiesce(true)(op).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ItemStoreMaintenanceRefusedError);
    // Labels come from the host cohort only, never from presence peers.
    expect(refusal).toMatchObject({ reason: 'host-active', held: false });
    expect(refusal).toHaveProperty('peers', peers);
    expect(op).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect(leftovers()).toEqual([]);
    holder.release();
    expect((await holder.exited).code).toBe(0);
  },
);

posix(
  'b, e. Electron admission under a held window exits maintenance-held before touching a store, then is admitted and writes after release',
  async () => {
    const store = join(data, 'workspaces/local/notes/admitted.json');
    const before = snapshot();
    const refused = await quiesce(true)(
      () => startChild('electron', store).exited,
    );
    expect(refused.code).toBe(1);
    expect(lines(refused.stdout)).toEqual([{ refused: 'maintenance-held' }]);
    expect(refused.stderr).toContain('Data maintenance is running.');
    expect(snapshot()).toEqual(before);
    expect(leftovers()).toEqual([]);
    const admitted = await startChild('electron', store).exited;
    expect(admitted.code).toBe(0);
    expect(readFileSync(store, 'utf8')).toBe('{"version":1,"admitted":true}');
  },
);

posix(
  'b2. the CLI joining presence under a held window refuses maintenance-held',
  async () => {
    const home = join(temporary, 'home');
    mkdirSync(home);
    const tsx = resolve(process.cwd(), 'node_modules/.bin/tsx');
    const before = snapshot();
    const cli = await quiesce(true)(
      () =>
        start(tsx, ['apps/desktop-cli/src/index.ts', 'workspace', 'list'], {
          HOME: home,
          CANOPY_CLOUD_BASE_URL: '',
          CANOPY_DATA_DIR: data,
          CANOPY_SECURE_DATA_DIR: join(temporary, 'secure'),
        }).exited,
    );
    expect(cli.code).not.toBe(0);
    expect(cli.stderr).toContain('Data maintenance is running.');
    expect(snapshot()).toEqual(before);
  },
);

posix(
  'f. refusal and success keep evidence byte-identical and peer files untouched',
  async () => {
    // A departed presence peer, which listW5RootPresencePeers would prune.
    const departed = start(process.execPath, ['-e', '']);
    await departed.exited;
    const peer = join(data, `w5-presence/peers/${randomUUID()}.json`);
    put(
      peer,
      JSON.stringify({
        version: 1,
        pid: departed.pid,
        startIdentity: 'gone',
        hostKind: 'electron',
      }),
    );
    const peerBytes = readFileSync(peer, 'utf8');
    const kept = evidence();
    expect(Object.values(kept).every(Boolean)).toBe(true);
    const member = startChild('cohort', '-', 'hold');
    expect(await member.ready()).toEqual({ admitted: true });
    await expect(quiesce(true)(() => Promise.resolve())).rejects.toMatchObject({
      reason: 'host-active',
      peers: LIVE_COHORT_PEERS,
    });
    member.release();
    await member.exited;
    expect(evidence()).toEqual(kept);
    expect(readFileSync(peer, 'utf8')).toBe(peerBytes);

    const options = await electronItemStoreMaintenanceOptions(data, {
      mutating: true,
    });
    const targets: readonly ItemStoreMaintenanceTarget[] = options.targets;
    const note = join(data, 'workspaces/local/notes/note.json');
    const copy = await withExclusiveOfflineMaintenance(
      options,
      async (window) => {
        const notes = targets.find(
          (target) => target.key.row === 'workspace_notes',
        );
        if (!notes || !window.roots.some((root) => root.key === notes.key))
          throw new Error('Notes root not held');
        const aside = notes.setAside.copyPath(note);
        renameSync(note, aside);
        await window.assertHeld();
        return aside;
      },
    );
    expect(existsSync(note)).toBe(false);
    expect(readFileSync(copy, 'utf8')).toBe('{"version":1,"body":"note"}');
    expect(evidence()).toEqual(kept);
    expect(readFileSync(peer, 'utf8')).toBe(peerBytes);
    expect(leftovers()).toEqual([]);
  },
);

posix('g. W5 maintenance and the window exclude each other', async () => {
  const refused = await quiesce(false)(
    () => startChild('w5-maintenance', workerEntry).exited,
  );
  expect(lines(refused.stdout)).toEqual([{ refused: 'claim-held' }]);

  const w5 = startChild('w5-maintenance', workerEntry, 'hold');
  expect(await w5.ready()).toEqual({ held: true });
  const op = jest.fn(() => Promise.resolve());
  await expect(quiesce(true)(op)).rejects.toMatchObject({
    reason: 'host-active',
  });
  expect(op).not.toHaveBeenCalled();
  // W5 maintenance's own claim and record are left in place.
  expect(leftovers()).toEqual([
    'runtime/startup-claim.json',
    'runtime/w5-maintenance.json',
  ]);
  w5.release();
  expect(lines((await w5.exited).stdout)).toEqual([
    { held: true },
    { completed: 'diagnose' },
  ]);
  expect(leftovers()).toEqual([]);
});

posix(
  'h. a caller that already joined presence refuses caller-admitted, touching nothing',
  async () => {
    await joinW5RootPresence(data, 'electron');
    const before = snapshot();
    await expect(diagnoseElectronItemStores(data)).rejects.toMatchObject({
      reason: 'caller-admitted',
    });
    expect(snapshot()).toEqual(before);
  },
);

posix(
  'h2. a caller holding only the desktop delete gate still opens the window (W6)',
  async () => {
    const gate = await acquireW5DesktopDeleteGate(data, 'desktop');
    try {
      const diagnosis = await diagnoseElectronItemStores(data);
      expect(
        diagnosis
          .find((entry) => entry.row === 'workspace_notes')
          ?.files.map((file) => [file.path, file.damaged]),
      ).toEqual([
        ['local/notes/note.json', false],
        ['local/notes/note.json.damaged-1', true],
      ]);
    } finally {
      gate.close();
    }
    expect(leftovers()).toEqual([]);
  },
);

posix(
  'i. Cowork external roots: both brand folders are enumerated, a swapped root refuses, an unmounted one is unavailable',
  async () => {
    const diagnosis = await diagnoseElectronItemStores(data);
    expect(
      diagnosis
        .find(
          (entry) =>
            entry.row === 'cowork_managed_dir' && entry.root === external,
        )
        ?.files.map((file) => file.path),
    ).toEqual([`${primaryDir}/notes/a.json`, `${alternateDir}/notes/b.json`]);

    const options = await electronItemStoreMaintenanceOptions(data, {
      mutating: false,
    });
    const held: unknown[] = [];
    const swapped = withExclusiveOfflineMaintenance(options, async (window) => {
      held.push(
        ...window.roots.filter((root) => root.placement === 'external'),
      );
      renameSync(external, `${external}-moved`);
      mkdirSync(external);
      await window.assertHeld();
    });
    await expect(swapped).rejects.toMatchObject({ reason: 'root-changed' });
    expect(held).toEqual([
      expect.objectContaining({ path: external, state: 'present' }),
    ]);
    expect(leftovers()).toEqual([]);

    rmSync(external, { recursive: true });
    await expect(diagnoseElectronItemStores(data)).rejects.toMatchObject({
      reason: 'root-unavailable',
    });
    expect(leftovers()).toEqual([]);
  },
);

posix(
  "j. quiesce returns op's result; a refusal throws a typed error",
  async () => {
    await expect(
      quiesce(true)(() => Promise.resolve({ copied: 3 })),
    ).resolves.toEqual({ copied: 3 });
    expect(leftovers()).toEqual([]);
    await joinW5RootPresence(data, 'cli');
    const refusal: unknown = await quiesce(true)(() => Promise.resolve()).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ItemStoreMaintenanceRefusedError);
    expect(refusal).toBeInstanceOf(ExclusiveMaintenanceRefusedError);
    expect(refusal).toMatchObject({ reason: 'caller-admitted', held: false });
  },
);

posix(
  'k. a read-only op with an uncertain step releases every hold; a mutating one keeps them (D17)',
  async () => {
    const before = snapshot();
    const uncertain = new Error('uncertain step');
    await expect(quiesce(false)(() => Promise.reject(uncertain))).rejects.toBe(
      uncertain,
    );
    expect(snapshot()).toEqual(before);
    expect(leftovers()).toEqual([]);
    expect((await startChild('electron').exited).code).toBe(0);

    // The contrast: the same failure in a mutating window keeps every hold
    // until its process exits.
    const kept = startChild('failed-window', 'mutating', 'hold');
    expect(await kept.ready()).toEqual({
      reason: 'outcome-uncertain',
      held: true,
    });
    const writer = await startChild('electron').exited;
    expect(writer.code).toBe(1);
    expect(lines(writer.stdout)).toEqual([{ refused: 'maintenance-held' }]);
    kept.release();
    expect((await kept.exited).code).toBe(0);
  },
);

posix(
  'l. preferences (CAN-7995): <data> is held; diagnose reports each file, its envelope version, the generation against its record and a missing backup or owner record; set-aside takes only the four live files',
  async () => {
    const digest = (text: string): string =>
      createHash('sha256').update(text).digest('hex');
    const envelope = (version: number, generation: number): string =>
      JSON.stringify({ version, generation, preferences: { theme: 'dark' } });
    const diagnosePreferences = async (): Promise<ItemStoreDiagnosis> => {
      const found = (await diagnoseElectronItemStores(data)).find(
        (entry) => entry.row === 'preferences',
      );
      if (!found) throw new Error('Preferences were not diagnosed');
      return found;
    };
    const rotating = 'preferences.backup-2026-11-26T00-00-00-000Z-a1.json';
    const primary = envelope(2, 3);
    const lastGood = envelope(1, 2);
    const record = '{"version":1,"generation":3}';
    const denied = '{"denied":["crashReports"]}';
    put(join(data, 'preferences.json'), primary);
    put(join(data, 'preferences.last-good.json'), lastGood);
    put(join(data, 'preferences.generation.json'), record);
    put(join(data, 'preferences.json.usage-data-denied.json'), denied);
    put(join(data, rotating), 'torn');

    const before = snapshot();
    const first = await diagnosePreferences();
    expect(snapshot()).toEqual(before);
    const file = (path: string, text: string, damaged = false): object => ({
      path,
      size: Buffer.byteLength(text),
      sha256: digest(text),
      damaged,
      newer: false,
    });
    expect(first).toMatchObject({
      root: data,
      status: 'present',
      unreadable: [],
      truncated: false,
    });
    expect(first.files).toEqual([
      file('preferences.json', primary),
      file(rotating, 'torn', true),
      file('preferences.generation.json', record),
      file('preferences.last-good.json', lastGood),
      file('preferences.json.usage-data-denied.json', denied),
    ]);
    // Until G's backup and R's record exist, both are reported missing.
    expect(first.preferences).toEqual({
      versions: {
        'preferences.json': 2,
        [rotating]: null,
        'preferences.generation.json': 1,
        'preferences.last-good.json': 1,
        'preferences.json.usage-data-denied.json': null,
      },
      generation: {
        record: 3,
        primary: 3,
        lastGood: 2,
        primaryVersusRecord: 'current',
        lastGoodVersusRecord: 'behind',
      },
      ownerFlip: { kind: 'absent' },
      namespaceBackup: { kind: 'absent' },
      namespaceBackups: [],
      missing: ['namespace-backup', 'owner-flip-record'],
    });

    const backupDigest = 'b'.repeat(64);
    const backupRecord = (name: string): string =>
      JSON.stringify({
        namespaceId: 'preferences',
        backupPath: `backups/preferences/${name}`,
        verifiedBy: { algorithm: 'sha256', digest: backupDigest },
      });
    const newer = envelope(3, 3);
    put(join(data, 'backups/preferences/before-flip/preferences.json'), newer);
    put(
      join(data, 'storage-records/preferences/namespace-backup.json'),
      backupRecord('before-flip'),
    );
    const flip = {
      namespaceId: 'preferences',
      fromOwner: 'legacy',
      toOwner: 'daemon',
      workPackage: 'W5',
      backupRecord: `storage-records/preferences/namespace-backup.json#sha256:${backupDigest}`,
      flippedAt: '2026-11-26T00:00:00Z',
    };
    put(
      join(data, 'storage-records/preferences/owner-flip.json'),
      JSON.stringify(flip),
    );
    const second = await diagnosePreferences();
    expect(second.files.slice(5)).toEqual([
      file('storage-records/preferences/owner-flip.json', JSON.stringify(flip)),
      file(
        'storage-records/preferences/namespace-backup.json',
        backupRecord('before-flip'),
      ),
      {
        ...file('backups/preferences/before-flip/preferences.json', newer),
        newer: true,
      },
    ]);
    expect(second.preferences).toMatchObject({
      ownerFlip: { kind: 'record', record: flip },
      namespaceBackup: {
        kind: 'record',
        backupPath: 'backups/preferences/before-flip',
        digest: backupDigest,
        folder: 'present',
      },
      namespaceBackups: ['before-flip'],
      missing: [],
    });
    // A record naming a removed backup reports the backup missing.
    put(
      join(data, 'storage-records/preferences/namespace-backup.json'),
      backupRecord('removed'),
    );
    expect((await diagnosePreferences()).preferences).toMatchObject({
      namespaceBackup: { kind: 'record', folder: 'absent' },
      missing: ['namespace-backup'],
    });

    const options = await electronItemStoreMaintenanceOptions(data, {
      mutating: true,
    });
    const targets: readonly ItemStoreMaintenanceTarget[] = options.targets;
    const preferences = targets.find(
      (target) => target.key.row === 'preferences',
    );
    expect(preferences).toMatchObject({
      key: { row: 'preferences' },
      patterns: [
        '<data>/preferences.json',
        '<data>/preferences.backup-{}.json',
        '<data>/preferences.generation.json',
        '<data>/preferences.last-good.json',
        '<data>/preferences.json.usage-data-denied.json',
      ],
      principals: ['electron_main', 'daemon'],
    });
    if (!preferences) throw new Error('No preferences target');
    const kept = snapshot();
    const live = join(data, 'preferences.json');
    const aside = await withExclusiveOfflineMaintenance(
      options,
      async (window) => {
        expect(
          window.roots.filter((root) => root.key === preferences.key),
        ).toEqual([
          expect.objectContaining({
            path: data,
            placement: 'data',
            state: 'present',
          }),
        ]);
        for (const path of [
          rotating,
          'backups/preferences/before-flip/preferences.json',
          'storage-records/preferences/owner-flip.json',
          'workspaces/local/notes/note.json',
        ])
          expect(() => preferences.setAside.copyPath(join(data, path))).toThrow(
            'Only the live preferences files can be set aside.',
          );
        const copy = preferences.setAside.copyPath(live);
        renameSync(live, copy);
        await window.assertHeld();
        return copy;
      },
    );
    expect(relative(data, aside)).toMatch(/^preferences\.json\.damaged-\d+$/);
    const after = snapshot();
    const moved = `data/${relative(data, aside)}`;
    const without = (
      files: Record<string, string>,
      path: string,
    ): Record<string, string> =>
      Object.fromEntries(Object.entries(files).filter(([key]) => key !== path));
    // Only the live file moved; the rotating backup and records are intact.
    expect(after[moved]).toBe(kept['data/preferences.json']);
    expect(without(after, moved)).toEqual(
      without(kept, 'data/preferences.json'),
    );
    expect(leftovers()).toEqual([]);
    const third = await diagnosePreferences();
    expect(third.files[0]).toEqual(file(relative(data, aside), primary, true));
    expect(third.preferences?.generation).toMatchObject({
      primary: 'absent',
      primaryVersusRecord: 'unknown',
    });
  },
);

test('win32: platform-unsupported before anything is read', async () => {
  const before = snapshot();
  const op = jest.fn(() => Promise.resolve());
  // The composition's own guard, with the host OS injected on every platform.
  await jest.isolateModulesAsync(async () => {
    jest.doMock('@canopy/core-platform', () => ({
      ...jest.requireActual<object>('@canopy/core-platform'),
      hostPlatformOperatingSystem: (): 'win32' => 'win32',
    }));
    const composition = await import('../item-store-maintenance');
    const refusal = {
      name: 'ItemStoreMaintenanceRefusedError',
      reason: 'platform-unsupported',
    };
    await expect(
      composition.electronItemStoreMaintenanceOptions(data, { mutating: true }),
    ).rejects.toMatchObject(refusal);
    await expect(
      composition.createElectronItemStoreQuiesce(data, { mutating: true })(op),
    ).rejects.toMatchObject(refusal);
    await expect(
      composition.diagnoseElectronItemStores(data),
    ).rejects.toMatchObject(refusal);
  });
  jest.dontMock('@canopy/core-platform');
  if (process.platform !== 'win32') {
    // The window's own guard runs before the caller check.
    const options = await electronItemStoreMaintenanceOptions(data, {
      mutating: true,
    });
    const { deps } = options;
    const callerJoinedPresence = jest.fn((root: string) =>
      deps.callerJoinedPresence(root),
    );
    await expect(
      withExclusiveOfflineMaintenance(
        { ...options, os: 'win32', deps: { ...deps, callerJoinedPresence } },
        op,
      ),
    ).rejects.toMatchObject({ reason: 'platform-unsupported' });
    expect(callerJoinedPresence).not.toHaveBeenCalled();
    expect(op).not.toHaveBeenCalled();
  }
  expect(snapshot()).toEqual(before);
  expect(existsSync(join(data, 'w5-presence'))).toBe(false);
});

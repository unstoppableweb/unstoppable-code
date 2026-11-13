// First: the main modules below reach `electron`.
import './use-electron-mock';
// Default imports: the live module objects, so patching them reaches every
// store that calls through them.
import fs, {
  type MakeDirectoryOptions,
  type Mode,
  type PathLike,
} from 'node:fs';
import fsp from 'node:fs/promises';
import * as path from 'node:path';
import { hashPipelinePackageYaml } from '@canopy/desktop-shared/node';
import type { InstallReceipt } from '@canopy/execution-engine/lib/resource-context-policy';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { saveStoredPipeline } from '@canopy/execution-engine/pipelines/store';
import type { PipelinePackageInstallRecordV1 } from '@canopy/execution-engine/types/pipeline';
import {
  getDataDir,
  getPipelinePackageInstallStorePath,
} from '../../../lib/paths';
import { createResourceInstallReceiptsStore } from '../../../lib/resource-install-receipts';
import {
  beginPipelineInstallIntent,
  recoverInterruptedPipelineInstalls,
} from '../../pipeline-install-intents';
import { upsertPipelinePackageInstall } from '../../pipeline-package-install-store';

/*
 * One pipeline install, or one startup recovery, in its own process
 * (CAN-5678). Every filesystem call that changes what a restart can find is a
 * boundary: creating, renaming, linking or removing an entry, and flushing a
 * file or folder. With a boundary number the process kills itself right after
 * that call returns, without running any cleanup, as a power cut or a crash
 * would; Windows terminates it with TerminateProcess. Without one it runs to
 * the end and prints every boundary as JSON, for the parent to count and to
 * audit the order of its flushes.
 *
 *   pipeline-install-kill-process.ts <created|replaced|rollback|recover> <boundary>
 *
 * The data root comes from CANOPY_DATA_DIR. Boundary 0 means none.
 */

export const KILL_FIXTURE = {
  definitionId: 'kill-qualification',
  accountId: 'account-1',
  remoteId: 'remote-1',
  digest: `pp:v1:${'a'.repeat(43)}`,
  previousDigest: `pp:v1:${'b'.repeat(43)}`,
} as const;

export function killFixtureYaml(name: string): string {
  return `name: ${name}\non: dispatch\njobs:\n  run:\n    steps:\n      - run: echo ${name}\n`;
}

export function killFixtureRecord(
  text: string,
  digest: string = KILL_FIXTURE.digest,
): PipelinePackageInstallRecordV1 {
  return {
    localPipelineId: KILL_FIXTURE.definitionId,
    originExternalId: KILL_FIXTURE.remoteId,
    pipelineContentHash: hashPipelinePackageYaml(text),
    distributionMode: 'package',
    packageDigest: digest,
    installedAt: '2026-11-08T00:00:00.000Z',
  };
}

export function killFixtureReceipt(text: string): InstallReceipt {
  return {
    family: 'pipelines',
    remoteId: KILL_FIXTURE.remoteId,
    localResourceIds: [KILL_FIXTURE.definitionId],
    shareScope: 'team',
    ownerContext: {
      kind: 'organization',
      organizationId: '33333333-3333-4333-8333-333333333333',
    },
    hash: hashPipelinePackageYaml(text),
    authorizedAt: '2026-11-08T00:00:00.000Z',
  };
}

/** One boundary, with paths relative to the data root in `/` form. */
export type KillBoundary =
  | { op: 'create'; path: string; directory: boolean }
  | { op: 'rename' | 'link'; path: string; to: string }
  | { op: 'remove'; path: string }
  | { op: 'flush'; path: string; directory: boolean };

const BEFORE_TEXT = killFixtureYaml('Before');
const INSTALLED_TEXT = killFixtureYaml('Installed');

/** The definition text a scenario installs. */
export const KILL_FIXTURE_TEXT = {
  before: BEFORE_TEXT,
  installed: INSTALLED_TEXT,
} as const;

type Scenario = 'created' | 'replaced' | 'rollback' | 'recover';

function isScenario(value: string | undefined): value is Scenario {
  return (
    value === 'created' ||
    value === 'replaced' ||
    value === 'rollback' ||
    value === 'recover'
  );
}

interface Instrumented {
  readonly boundaries: KillBoundary[];
  readonly patchHandles: () => Promise<void>;
}

function instrument(killAt: number): Instrumented {
  const root = path.resolve(getDataDir());
  const relative = (target: unknown): string =>
    path
      .relative(root, path.resolve(String(target)))
      .split(path.sep)
      .join('/');
  const boundaries: KillBoundary[] = [];
  const record = (boundary: KillBoundary): void => {
    boundaries.push(boundary);
    if (boundaries.length !== killAt) return;
    process.kill(process.pid, 'SIGKILL');
    // Nothing more may reach the disk while the kill lands.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  };
  const isDirectory = (target: string): boolean => {
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  };
  /** Components of `target` a recursive create would add, outermost first. */
  const missing = (target: string): string[] => {
    const added: string[] = [];
    let current = path.resolve(target);
    while (!fs.existsSync(current)) {
      added.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return added;
  };
  const creates = (flags: unknown): boolean =>
    typeof flags === 'string' && /[wax]/.test(flags);

  const fdPaths = new Map<number, string>();
  const openSync = fs.openSync;
  fs.openSync = (...args: Parameters<typeof fs.openSync>): number => {
    const target = String(args[0]);
    const existed = fs.existsSync(target);
    const fd = openSync(...args);
    fdPaths.set(fd, target);
    if (!existed && creates(args[1]))
      record({ op: 'create', path: relative(target), directory: false });
    return fd;
  };
  const closeSync = fs.closeSync;
  fs.closeSync = (fd: number): void => {
    fdPaths.delete(fd);
    closeSync(fd);
  };
  const fsyncSync = fs.fsyncSync;
  fs.fsyncSync = (fd: number): void => {
    fsyncSync(fd);
    const target = fdPaths.get(fd) ?? '';
    record({
      op: 'flush',
      path: relative(target),
      directory: isDirectory(target),
    });
  };
  const renameSync = fs.renameSync;
  fs.renameSync = (from, to): void => {
    renameSync(from, to);
    record({ op: 'rename', path: relative(from), to: relative(to) });
  };
  const linkSync = fs.linkSync;
  fs.linkSync = (from, to): void => {
    linkSync(from, to);
    record({ op: 'link', path: relative(from), to: relative(to) });
  };
  const unlinkSync = fs.unlinkSync;
  fs.unlinkSync = (target): void => {
    unlinkSync(target);
    record({ op: 'remove', path: relative(target) });
  };
  const rmSync = fs.rmSync;
  fs.rmSync = (target, options): void => {
    const existed = fs.existsSync(target);
    rmSync(target, options);
    if (existed) record({ op: 'remove', path: relative(target) });
  };
  const rmdirSync = fs.rmdirSync;
  fs.rmdirSync = (target, options): void => {
    rmdirSync(target, options);
    record({ op: 'remove', path: relative(target) });
  };
  const mkdirSync = fs.mkdirSync;
  Reflect.set(
    fs,
    'mkdirSync',
    (
      target: PathLike,
      options?: MakeDirectoryOptions | Mode | null,
    ): string | undefined => {
      const added = missing(String(target));
      const result = mkdirSync(target, options);
      for (const entry of added)
        record({ op: 'create', path: relative(entry), directory: true });
      return result;
    },
  );

  const handlePaths = new WeakMap<object, string>();
  const open = fsp.open;
  fsp.open = async (
    ...args: Parameters<typeof fsp.open>
  ): ReturnType<typeof fsp.open> => {
    const target = String(args[0]);
    const existed = fs.existsSync(target);
    const handle = await open(...args);
    handlePaths.set(handle, target);
    if (!existed && creates(args[1]))
      record({ op: 'create', path: relative(target), directory: false });
    return handle;
  };
  const rename = fsp.rename;
  fsp.rename = async (from, to): Promise<void> => {
    await rename(from, to);
    record({ op: 'rename', path: relative(from), to: relative(to) });
  };
  const link = fsp.link;
  fsp.link = async (from, to): Promise<void> => {
    await link(from, to);
    record({ op: 'link', path: relative(from), to: relative(to) });
  };
  const symlink = fsp.symlink;
  fsp.symlink = async (target, at, type): Promise<void> => {
    await symlink(target, at, type);
    record({ op: 'create', path: relative(at), directory: false });
  };
  const unlink = fsp.unlink;
  fsp.unlink = async (target): Promise<void> => {
    await unlink(target);
    record({ op: 'remove', path: relative(target) });
  };
  const rm = fsp.rm;
  fsp.rm = async (target, options): Promise<void> => {
    const existed = fs.existsSync(target);
    await rm(target, options);
    if (existed) record({ op: 'remove', path: relative(target) });
  };
  const rmdir = fsp.rmdir;
  fsp.rmdir = async (target, options): Promise<void> => {
    await rmdir(target, options);
    record({ op: 'remove', path: relative(target) });
  };
  const mkdir = fsp.mkdir;
  Reflect.set(
    fsp,
    'mkdir',
    async (
      target: PathLike,
      options?: MakeDirectoryOptions | Mode | null,
    ): Promise<string | undefined> => {
      const added = missing(String(target));
      const result = await mkdir(target, options);
      for (const entry of added)
        record({ op: 'create', path: relative(entry), directory: true });
      return result;
    },
  );
  return {
    boundaries,
    patchHandles: async (): Promise<void> => {
      const probe = await open(__filename, 'r');
      const prototype: unknown = Object.getPrototypeOf(probe);
      await probe.close();
      const sync: unknown =
        typeof prototype === 'object' && prototype !== null
          ? Reflect.get(prototype, 'sync')
          : undefined;
      if (
        typeof sync !== 'function' ||
        typeof prototype !== 'object' ||
        prototype === null
      )
        throw new Error('FileHandle has no sync method');
      Reflect.set(
        prototype,
        'sync',
        async function (this: object): Promise<void> {
          await Reflect.apply(sync, this, []);
          const target = handlePaths.get(this) ?? '';
          record({
            op: 'flush',
            path: relative(target),
            directory: isDirectory(target),
          });
        },
      );
    },
  };
}

async function install(
  scenario: 'created' | 'replaced' | 'rollback',
): Promise<void> {
  const id = KILL_FIXTURE.definitionId;
  const text = INSTALLED_TEXT;
  const receipts = createResourceInstallReceiptsStore(KILL_FIXTURE.accountId);
  const receipt = killFixtureReceipt(text);
  const change = scenario === 'replaced' ? 'replaced' : 'created';
  const intent = await beginPipelineInstallIntent('shared');
  await intent.noteDefinition({
    definitionId: id,
    change,
    contentHash: hashPipelinePackageYaml(text),
  });
  const saved = saveStoredPipeline(
    {
      id,
      name: 'Installed',
      description: '',
      icon: '',
      content: parsePipelineText(text),
      rawContent: text,
    },
    change === 'created' ? { id } : undefined,
  );
  if (!saved.success) throw new Error(saved.error);
  await intent.noteReceipt(id, {
    accountId: KILL_FIXTURE.accountId,
    receipt,
    previous: await receipts.find('pipelines', KILL_FIXTURE.remoteId),
  });
  await receipts.record(receipt);
  await intent.noteInstallRecord(id, killFixtureRecord(text));
  await upsertPipelinePackageInstall(
    getPipelinePackageInstallStorePath(),
    killFixtureRecord(text),
  );
  if (scenario === 'rollback') await intent.rollBack();
  else await intent.finish();
}

async function main(): Promise<void> {
  const [scenario, boundary] = process.argv.slice(2);
  const killAt = Number(boundary);
  if (!isScenario(scenario) || !Number.isInteger(killAt) || killAt < 0)
    throw new Error(
      'Usage: pipeline-install-kill-process.ts <created|replaced|rollback|recover> <boundary>',
    );
  const { boundaries, patchHandles } = instrument(killAt);
  await patchHandles();
  if (scenario === 'recover') await recoverInterruptedPipelineInstalls();
  else await install(scenario);
  process.stdout.write(
    `${JSON.stringify({ done: true, boundaries: [...boundaries] })}\n`,
  );
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}

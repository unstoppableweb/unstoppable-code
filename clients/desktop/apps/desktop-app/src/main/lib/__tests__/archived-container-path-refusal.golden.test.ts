// CAN-7346 golden: archived-container readers and cleanup refuse symbolic
// links, and chat-archive file keys refuse raw ids. Real files in a temporary
// data directory go through the registered archived report and step log
// handlers (IPC_CHANNELS.archivedContainersReadExecutionReport and
// IPC_CHANNELS.archivedContainersReadExecutionStepLog), the real
// partial-restore cleanup and the real path helpers. An archive capture
// copies inner links verbatim, so a link inside an archived container must
// never lead a reader or a removal outside it. Refusals log a fixed reason
// code and ids only: no file content and no link target.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  IPC_CHANNELS,
  type ArchivedContainerManifestV1,
} from '@canopy/desktop-shared/types';
import type * as Paths from '../paths';
import type * as Archives from '../archived-containers';
import type * as PathSafety from '../path-safety';
import type * as ArchiveSourceKey from '../../chat-search/archive-source-key';
import type * as ArchivedContainerIpc from '../../ipc/archived-containers';

type CapturedHandler = (event: unknown, ...args: unknown[]) => unknown;

const mockWarnings: { message: string; context: unknown }[] = [];
const mockHandlers = new Map<string, CapturedHandler>();
type FsHook = { target: string; run: () => Promise<void> };
/** Each runs once, right after `realpath` resolves or `open` opens `target`. */
const mockFsHooks: { realpath?: FsHook; open?: FsHook } = {};

async function mockRunFsHook(
  name: 'realpath' | 'open',
  path: unknown,
): Promise<void> {
  const hook = mockFsHooks[name];
  if (!hook || path !== hook.target) return;
  delete mockFsHooks[name];
  await hook.run();
}

// Lets a case change the tree at an exact point inside a read: after the
// containment walk resolves the file, or once the file is open.
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    realpath: async (path: string): Promise<string> => {
      const resolved = await actual.realpath(path);
      await mockRunFsHook('realpath', path);
      return resolved;
    },
    open: async (
      path: string,
      flags?: number | string,
      mode?: number,
    ): Promise<FsPromises.FileHandle> => {
      const handle = await actual.open(path, flags, mode);
      await mockRunFsHook('open', path);
      return handle;
    },
  };
});
jest.mock('../main-process-logging', () => ({
  ...jest.requireActual<object>('../main-process-logging'),
  logMainProcessWarn: (message: string, context?: unknown): void => {
    mockWarnings.push({ message, context });
  },
}));
// Handlers are captured and invoked directly, without Electron's IPC.
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: CapturedHandler): void => {
    mockHandlers.set(channel, handler);
  },
}));
// The chat search index is derived and rebuildable; its worker needs a build.
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: (): object => ({}),
}));
// Disk usage is measured in the background; it has no part in these paths.
jest.mock('../archived-container-disk-usage', () => ({
  scheduleArchivedContainerDiskUsage: (): void => {},
}));

jest.setTimeout(30_000);

const PROJECT = 'refusal-project';
const CONTAINER = 'archived-one';
const SECRET = 'outside-secret-content';

let dataDir: string;
let outsideDir: string;
let previousDataDir: string | undefined;

let paths: typeof Paths;
let archives: typeof Archives;
let pathSafety: typeof PathSafety;
let sourceKey: typeof ArchiveSourceKey;
let ipc: typeof ArchivedContainerIpc;

function manifest(id: string): ArchivedContainerManifestV1 {
  return {
    version: 1,
    kind: 'worktree',
    id,
    projectId: PROJECT,
    name: `Archive ${id}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    archivedAt: '2026-10-02T00:00:00.000Z',
    retentionDays: 30,
    expiresAt: '2099-11-01T00:00:00.000Z',
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
  };
}

/** The chat-archives folder, read the way chat search reads it. */
function chatArchivesDir(): string {
  return dirname(
    paths.getWorkspaceChatArchivesFilePath(PROJECT, 'placeholder'),
  );
}

function executionsDir(): string {
  return paths.getArchivedContainerExecutionsDir(PROJECT, CONTAINER);
}

function invoke(channel: string, request: object): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return Promise.resolve().then(() => handler({}, request));
}

/** A stored execution whose text report was written at `reportFile`. */
async function storeExecution(
  executionId: string,
  reportFile: string,
): Promise<void> {
  await writeFile(
    join(executionsDir(), `${executionId}.json`),
    JSON.stringify({
      version: 10,
      id: executionId,
      jobs: {},
      job_definitions: {},
      job_groups: {},
      pending_pauses: [],
      pipeline_snapshot: { jobs: {} },
      report_outputs: { report_file: reportFile },
    }),
  );
}

/** Moves exec-1 aside and links its name to the outside folder. */
async function linkExecutionOutside(): Promise<void> {
  await rename(
    join(executionsDir(), 'exec-1'),
    join(executionsDir(), 'exec-1-moved'),
  );
  await symlink(outsideDir, join(executionsDir(), 'exec-1'), 'dir');
}

function readReport(executionId: string): Promise<unknown> {
  return invoke(IPC_CHANNELS.archivedContainersReadExecutionReport, {
    projectId: PROJECT,
    containerId: CONTAINER,
    executionId,
    kind: 'text',
  });
}

function readStepLog(executionId: string, logFile: string): Promise<unknown> {
  return invoke(IPC_CHANNELS.archivedContainersReadExecutionStepLog, {
    projectId: PROJECT,
    containerId: CONTAINER,
    executionId,
    jobId: 'build',
    stepId: 'greet',
    logFilePath: join(executionsDir(), executionId, logFile),
  });
}

/** The refusal reason, or the error itself when it was not a refusal. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof pathSafety.ContainedPathRefusedError) {
      expect(error.message).not.toContain(outsideDir);
      expect(error.message).not.toContain(SECRET);
      return error.reason;
    }
    return error;
  }
  return 'read';
}

function expectSafeLogs(): void {
  const logged = JSON.stringify(mockWarnings);
  expect(logged).not.toContain(outsideDir);
  expect(logged).not.toContain(dataDir);
  expect(logged).not.toContain(SECRET);
}

beforeEach(async () => {
  jest.resetModules();
  mockWarnings.length = 0;
  mockHandlers.clear();
  delete mockFsHooks.realpath;
  delete mockFsHooks.open;
  dataDir = mkdtempSync(join(tmpdir(), 'archived-path-refusal-golden-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'archived-path-refusal-outside-'));
  previousDataDir = process.env['CANOPY_DATA_DIR'];
  process.env['CANOPY_DATA_DIR'] = dataDir;
  paths = await import('../paths');
  archives = await import('../archived-containers');
  pathSafety = await import('../path-safety');
  sourceKey = await import('../../chat-search/archive-source-key');
  ipc = await import('../../ipc/archived-containers');
  ipc.registerArchivedContainerHandlers({
    dispatcher: {
      instruction: () => {
        throw new Error('Archived reads do not dispatch instructions.');
      },
    },
    resolveCaller: () => {
      throw new Error('Archived reads do not resolve a caller.');
    },
  });
  await mkdir(join(executionsDir(), 'exec-1'), { recursive: true });
  await archives.commitArchivedContainer(manifest(CONTAINER));
  await writeFile(join(outsideDir, 'report.md'), SECRET);
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env['CANOPY_DATA_DIR'];
  else process.env['CANOPY_DATA_DIR'] = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('archived-container path refusal (CAN-7346)', () => {
  it('reads regular reports and step logs and keeps the not-found answers', async () => {
    const report = join(executionsDir(), 'exec-1', 'report.md');
    await mkdir(join(executionsDir(), 'exec-1', 'logs'));
    await writeFile(report, '# Report');
    await writeFile(
      join(executionsDir(), 'exec-1', 'logs', 'step.log'),
      'line one\nline two\n',
    );
    await storeExecution('exec-1', report);

    await expect(readReport('exec-1')).resolves.toEqual({
      content: '# Report',
      filePath: report,
    });
    await expect(readStepLog('exec-1', 'logs/step.log')).resolves.toEqual({
      lines: ['line one', 'line two'],
    });
    // A missing step log is an empty log; a missing report still rejects.
    await expect(readStepLog('exec-1', 'missing.log')).resolves.toEqual({
      lines: [],
    });
    await storeExecution('exec-3', join(executionsDir(), 'exec-3', 'gone.md'));
    await expect(readReport('exec-3')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(mockWarnings).toEqual([]);
  });

  it('refuses a report or step log file that links outside the container', async () => {
    const report = join(executionsDir(), 'exec-1', 'report.md');
    await symlink(join(outsideDir, 'report.md'), report, 'file');
    await symlink(
      join(outsideDir, 'report.md'),
      join(executionsDir(), 'exec-1', 'step.log'),
      'file',
    );
    await storeExecution('exec-1', report);

    expect(await refusal(readReport('exec-1'))).toBe('symbolic-link');
    expect(await refusal(readStepLog('exec-1', 'step.log'))).toBe(
      'symbolic-link',
    );
    expect(mockWarnings).toEqual([
      {
        message: '[archived-containers] Refused a path inside a container',
        context: {
          reason: 'archived-container-symbolic-link',
          operation: 'execution-report',
          projectId: PROJECT,
          containerId: CONTAINER,
        },
      },
      {
        message: '[archived-containers] Refused a path inside a container',
        context: {
          reason: 'archived-container-symbolic-link',
          operation: 'step-log',
          projectId: PROJECT,
          containerId: CONTAINER,
        },
      },
    ]);
    expectSafeLogs();
  });

  it('refuses a linked directory partway down the path for both readers', async () => {
    await symlink(outsideDir, join(executionsDir(), 'exec-2'), 'dir');
    await storeExecution(
      'exec-2',
      join(executionsDir(), 'exec-2', 'report.md'),
    );

    expect(await refusal(readReport('exec-2'))).toBe('symbolic-link');
    // A refusal is not a missing log: the step log reader must not answer it
    // with an empty log.
    expect(await refusal(readStepLog('exec-2', 'report.md'))).toBe(
      'symbolic-link',
    );
    expect(mockWarnings).toHaveLength(2);
    expectSafeLogs();
  });

  it('refuses a read when a parent directory becomes a link after validation', async () => {
    const report = join(executionsDir(), 'exec-1', 'report.md');
    await writeFile(report, '# Report');
    await storeExecution('exec-1', report);
    mockFsHooks.realpath = { target: report, run: linkExecutionOutside };

    expect(await refusal(readReport('exec-1'))).toBe('symbolic-link');
    // The swap ran inside the read.
    expect(mockFsHooks.realpath).toBeUndefined();
    expectSafeLogs();
  });

  it('refuses a read when the link is swapped back before the recheck', async () => {
    const report = join(executionsDir(), 'exec-1', 'report.md');
    await writeFile(report, '# Report');
    await storeExecution('exec-1', report);
    // The open goes through the link to the outside file; by the recheck the
    // real directory is back, so only the held file's identity tells them apart.
    mockFsHooks.realpath = { target: report, run: linkExecutionOutside };
    mockFsHooks.open = {
      target: report,
      run: async (): Promise<void> => {
        await rm(join(executionsDir(), 'exec-1'));
        await rename(
          join(executionsDir(), 'exec-1-moved'),
          join(executionsDir(), 'exec-1'),
        );
      },
    };

    expect(await refusal(readReport('exec-1'))).toBe('symbolic-link');
    expect(mockFsHooks).toEqual({});
    expectSafeLogs();
  });

  it('refuses partial-restore cleanup through a linked container directory', async () => {
    const realContainer = join(outsideDir, 'real-container');
    await mkdir(join(realContainer, 'provider-sessions'), { recursive: true });
    await writeFile(
      join(realContainer, 'provider-sessions', 'session.jsonl'),
      SECRET,
    );
    await writeFile(
      join(realContainer, 'container.json'),
      JSON.stringify(manifest('linked-container')),
    );
    await symlink(
      realContainer,
      paths.getArchivedContainerDir(PROJECT, 'linked-container'),
      'dir',
    );

    expect(
      await refusal(
        archives.removeArchivedContainerPayloadsAfterPartialRestore(
          PROJECT,
          'linked-container',
        ),
      ),
    ).toBe('root-not-directory');
    expect(
      readFileSync(
        join(realContainer, 'provider-sessions', 'session.jsonl'),
        'utf8',
      ),
    ).toBe(SECRET);
    expect(existsSync(join(realContainer, 'container.json'))).toBe(true);
    expect(mockWarnings).toEqual([
      {
        message: '[archived-containers] Refused a path inside a container',
        context: {
          reason: 'archived-container-root-not-directory',
          operation: 'partial-restore-cleanup',
          projectId: PROJECT,
          containerId: 'linked-container',
        },
      },
    ]);
    expectSafeLogs();
  });

  it('refuses raw chat-archive ids and keeps every valid id unchanged', () => {
    const archivesDir = chatArchivesDir();
    for (const id of [
      'home',
      'placeholder',
      'code-review-feature-login-2',
      'feature-login-page',
    ]) {
      expect(paths.getWorkspaceChatArchivesFilePath(PROJECT, id)).toBe(
        join(archivesDir, `${id}.json`),
      );
    }
    for (const id of ['../x', '/abs', 'a/b', '..', 'Upper']) {
      expect(() => paths.getWorkspaceChatArchivesFilePath(PROJECT, id)).toThrow(
        'Invalid worktreeId',
      );
    }
  });

  // The skipped scope's archived chats stay out of the chat search index, so
  // they no longer appear in chat-search:query or core.search.query results.
  it('skips one chat-search scope with an invalid stored id and logs a fixed reason', () => {
    expect(sourceKey.chatArchiveSourceKey(PROJECT, 'feature-login-page')).toBe(
      join(chatArchivesDir(), 'feature-login-page.json'),
    );
    expect(mockWarnings).toEqual([]);

    expect(
      sourceKey.chatArchiveSourceKey(PROJECT, '../escape'),
    ).toBeUndefined();
    expect(mockWarnings).toEqual([
      {
        message: '[chat-search] Skipped a chat scope with an invalid id',
        context: {
          reason: 'chat-search-archive-scope-id-invalid',
          projectId: PROJECT,
        },
      },
    ]);
    expect(JSON.stringify(mockWarnings)).not.toContain('escape');
    expectSafeLogs();
  });
});

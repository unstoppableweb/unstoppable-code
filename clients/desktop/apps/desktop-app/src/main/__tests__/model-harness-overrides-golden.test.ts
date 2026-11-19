// Saved model harness overrides survive a state file that can't be read
// (CAN-7094). The registered harness assignment handlers, the desktop
// assignment controller and the override store run as production code over
// the real overrides file under a temporary data root. Only IPC registration
// is captured, and one fs seam fails reads or the corrupt-file set-aside on
// demand, so the failures are deterministic and need no file permissions.
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS, initOllamaModels } from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirCache } from '@canopy/execution-engine/canopy-paths';

const mockFaults: { read?: string; rename?: string } = {};

function mockFault(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  const isOverridesFile = (path: unknown): boolean =>
    String(path).endsWith('model-harness-overrides.json');
  return {
    __esModule: true,
    ...actual,
    readFile: (
      ...args: Parameters<typeof actual.readFile>
    ): ReturnType<typeof actual.readFile> =>
      mockFaults.read !== undefined && isOverridesFile(args[0])
        ? Promise.reject(mockFault(mockFaults.read))
        : actual.readFile(...args),
    rename: (
      ...args: Parameters<typeof actual.rename>
    ): ReturnType<typeof actual.rename> =>
      mockFaults.rename !== undefined &&
      isOverridesFile(args[0]) &&
      String(args[1]).includes('.corrupt-')
        ? Promise.reject(mockFault(mockFaults.rename))
        : actual.rename(...args),
  };
});

// The test reads and writes the file itself without the fault seam.
const { mkdtemp, readFile, readdir, rm, writeFile } =
  jest.requireActual<typeof FsPromises>('node:fs/promises');

const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

import {
  registerModelHarnessAssignmentHandlers,
  setModelHarnessAssignmentController,
} from '../ipc/model-harness-assignments';
import {
  modelHarnessAssignmentController,
  resetModelHarnessRegistryForTests,
} from '../models/model-registry';

// Ollama models run on Codex by default and may be moved to Claude, so both
// are configurable with no account, gateway or runtime.
const SAVED = 'ollama-saved-model';
const EDITED = 'ollama-edited-model';
const SAVED_FILE = `${JSON.stringify(
  { version: 1, overrides: { [SAVED]: 'claude' } },
  null,
  2,
)}\n`;
const CORRUPT_FILE = '{"version": 1, "overrides": {';

let root = '';
let originalDataDir: string | undefined;

function overridesPath(): string {
  return join(root, 'model-harness-overrides.json');
}

function invoke(channel: string, request?: unknown): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`Missing ${channel} handler`);
  return handler({ sender: {} }, request);
}

function setHarness(modelId: string, harness: string): Promise<unknown> {
  return invoke(IPC_CHANNELS.harnessAssignmentsSet, { modelId, harness });
}

function resetHarness(modelId: string): Promise<unknown> {
  return invoke(IPC_CHANNELS.harnessAssignmentsReset, { modelId });
}

async function savedOverrides(): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(overridesPath(), 'utf8'));
  return typeof parsed === 'object' && parsed !== null && 'overrides' in parsed
    ? parsed.overrides
    : undefined;
}

/** Starts the desktop the way main does, over the overrides file on disk. */
async function startDesktop(): Promise<void> {
  resetModelHarnessRegistryForTests();
  setModelHarnessAssignmentController(modelHarnessAssignmentController);
  await invoke(IPC_CHANNELS.harnessAssignmentsLoad);
}

beforeAll(() => {
  registerModelHarnessAssignmentHandlers();
  initOllamaModels(
    [SAVED, EDITED].map((id) => ({
      id,
      rawModelId: id.replace(/^ollama-/, ''),
      label: id,
      show: { capabilities: ['completion', 'tools'] },
    })),
  );
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-overrides-golden-'));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = root;
  resetResolvedCanopyDataDirCache();
  delete mockFaults.read;
  delete mockFaults.rename;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  resetResolvedCanopyDataDirCache();
  resetModelHarnessRegistryForTests();
  setModelHarnessAssignmentController(undefined);
  await rm(root, { recursive: true, force: true });
});

it('refuses a change while the saved overrides cannot be read, then builds on them', async () => {
  await writeFile(overridesPath(), SAVED_FILE);
  mockFaults.read = 'EIO';
  await startDesktop();

  await expect(setHarness(EDITED, 'claude')).rejects.toThrow(
    /MODEL_HARNESS_ASSIGNMENT_UNAVAILABLE.*could not be read \(EIO\)/,
  );
  await expect(resetHarness(SAVED)).rejects.toThrow(
    /MODEL_HARNESS_ASSIGNMENT_UNAVAILABLE/,
  );
  await expect(readFile(overridesPath(), 'utf8')).resolves.toBe(SAVED_FILE);

  // The read recovers: the next change keeps what was saved.
  delete mockFaults.read;
  await setHarness(EDITED, 'claude');
  await expect(savedOverrides()).resolves.toEqual({
    [SAVED]: 'claude',
    [EDITED]: 'claude',
  });
});

it('leaves a corrupt overrides file in place while it cannot be set aside', async () => {
  await writeFile(overridesPath(), CORRUPT_FILE);
  mockFaults.rename = 'EACCES';
  await startDesktop();

  await expect(setHarness(EDITED, 'claude')).rejects.toThrow(
    /MODEL_HARNESS_ASSIGNMENT_UNAVAILABLE.*could not be set aside \(EACCES\)/,
  );
  await expect(readFile(overridesPath(), 'utf8')).resolves.toBe(CORRUPT_FILE);

  // Once it can be set aside, a copy is kept and the change is saved.
  delete mockFaults.rename;
  await setHarness(EDITED, 'claude');
  await expect(savedOverrides()).resolves.toEqual({ [EDITED]: 'claude' });
  const copies = (await readdir(root)).filter((name) =>
    name.startsWith('model-harness-overrides.json.corrupt-'),
  );
  expect(copies).toHaveLength(1);
  await expect(readFile(join(root, copies[0] ?? ''), 'utf8')).resolves.toBe(
    CORRUPT_FILE,
  );
});

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as AtomicFileModule from '../../lib/atomic-file';
import type * as CanopyPathsModule from '@canopy/execution-engine/canopy-paths';

// CAN-4710: Settings' preferences:create-primary-data-dir handler is the
// adoption marker's only admitted writer, and writes it durably.

jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp', on: jest.fn() },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
  nativeTheme: { themeSource: 'system' },
  shell: { openPath: jest.fn() },
}));
jest.mock('../../lib/native-crash-policy', () => ({
  nativeCrashAnnotation: {
    suspendForOptOut: jest.fn(),
    resumeAfterOptIn: jest.fn(),
  },
}));
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (): null => null,
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const mockHandlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    mockHandlers.set(channel, handler);
  },
}));

const mockRoots = { primary: '', resolved: '' };
jest.mock('@canopy/execution-engine/canopy-paths', () => ({
  ...jest.requireActual<typeof CanopyPathsModule>(
    '@canopy/execution-engine/canopy-paths',
  ),
  getPrimaryBrandDataDir: (): string => mockRoots.primary,
  getCanopyDataDir: (): string => mockRoots.resolved,
  getResolvedCanopyDataDir: (): { path: string; source: string } => ({
    path: mockRoots.resolved,
    source: mockRoots.resolved === mockRoots.primary ? 'primary' : 'override',
  }),
}));

const mockWrites: Array<{
  name: string;
  options: AtomicFileModule.AtomicFileWriteOptions | undefined;
}> = [];
const mockFolders: string[] = [];
jest.mock('../../lib/atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFileModule>(
    '../../lib/atomic-file',
  );
  return {
    ...actual,
    writeFileAtomically: (
      ...args: Parameters<typeof actual.writeFileAtomically>
    ): Promise<void> => {
      mockWrites.push({ name: args[0], options: args[2] });
      return actual.writeFileAtomically(...args);
    },
    createDirectoryDurably: (
      folder: string,
      options: { readonly dataRoot: string },
    ): Promise<void> => {
      mockFolders.push(folder);
      return actual.createDirectoryDurably(folder, options);
    },
  };
});

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerPreferenceHandlers } from '../preferences';

let base: string;

function createPrimaryDataDir(): Promise<unknown> {
  const handler = mockHandlers.get(
    IPC_CHANNELS.preferencesCreatePrimaryDataDir,
  );
  if (!handler)
    throw new Error('preferences:create-primary-data-dir is not registered');
  return handler({});
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'canopy-adoption-marker-'));
  mockRoots.primary = join(base, 'primary');
  mockRoots.resolved = mockRoots.primary;
  mockWrites.length = 0;
  mockFolders.length = 0;
  mockHandlers.clear();
  registerPreferenceHandlers();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('preferences:create-primary-data-dir (CAN-4710)', () => {
  it('creates the primary folder durably and writes only the marker, as its admitted writer', async () => {
    await expect(createPrimaryDataDir()).resolves.toMatchObject({
      path: mockRoots.primary,
      source: 'primary',
    });

    expect(mockFolders).toEqual([mockRoots.primary]);
    const marker = join(mockRoots.primary, 'data-dir-adopted.json');
    expect(mockWrites.map((write) => write.name)).toEqual([marker]);
    expect(mockWrites[0]?.options?.durable).toBe(true);
    expect(mockWrites[0]?.options?.admittedWriter).toEqual({
      namespace: 'data_dir_adoption_marker',
      writer: 'electron_main',
      module: 'main/ipc/preferences',
    });
    await expect(readdir(mockRoots.primary)).resolves.toEqual([
      'data-dir-adopted.json',
    ]);
    const parsed: unknown = JSON.parse(await readFile(marker, 'utf8'));
    expect(parsed).toMatchObject({ version: 1 });
    expect(
      typeof parsed === 'object' &&
        parsed !== null &&
        'adoptedAt' in parsed &&
        typeof parsed.adoptedAt === 'string',
    ).toBe(true);
  });

  it('overwrites the marker on a repeat', async () => {
    await createPrimaryDataDir();
    await createPrimaryDataDir();
    await expect(readdir(mockRoots.primary)).resolves.toEqual([
      'data-dir-adopted.json',
    ]);
  });

  it('still writes the marker when an explicit override is the resolved root', async () => {
    mockRoots.resolved = join(base, 'override');

    await expect(createPrimaryDataDir()).resolves.toMatchObject({
      path: mockRoots.resolved,
      source: 'override',
    });
    await expect(readdir(mockRoots.primary)).resolves.toEqual([
      'data-dir-adopted.json',
    ]);
  });
});

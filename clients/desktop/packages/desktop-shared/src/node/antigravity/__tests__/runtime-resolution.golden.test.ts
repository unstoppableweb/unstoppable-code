// Golden: every Antigravity launch prefers the managed copy whose sha256
// matches the pinned manifest, then ANTIGRAVITY_EXECUTABLE, then a PATH
// `agy`/`antigravity`. A tampered managed copy is skipped, never launched.
// Signature and version checks run downstream in verifyAntigravityExecutable
// (runtime-integrity.test.ts), so these cases stop at resolution.
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as CorePlatform from '@canopy/core-platform';
import type * as ConfigPaths from '@canopy/desktop-shared/pipelines/config-paths';
import type * as RuntimeArtifacts from '../runtime-artifacts';
import type { AntigravityRuntimeArtifact } from '../runtime-artifacts';
import { resolveAntigravityExecutable } from '../runtime';

const MANAGED_BYTES = '#!/bin/sh\necho managed antigravity\n';
const MANAGED_SHA256 = createHash('sha256').update(MANAGED_BYTES).digest('hex');

jest.mock('@canopy/desktop-shared/node/acp', () => ({
  connectAcp: (): never => {
    throw new Error('ACP reached');
  },
}));

let mockArtifact: AntigravityRuntimeArtifact | undefined;

// The test controls the pinned executableSha256.
jest.mock('../runtime-artifacts', () => {
  const actual = jest.requireActual<typeof RuntimeArtifacts>(
    '../runtime-artifacts',
  );
  return {
    ...actual,
    getAntigravityRuntimeArtifact: (): AntigravityRuntimeArtifact | undefined =>
      mockArtifact,
  };
});

// Resolution runs on every CI host; only macOS reaches it in production.
jest.mock('@canopy/core-platform', () => ({
  ...jest.requireActual<typeof CorePlatform>('@canopy/core-platform'),
  hostPlatformOperatingSystem: (): string => 'darwin',
}));

// The login-shell PATH would find a developer's own agy; each case owns PATH.
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  ...jest.requireActual<typeof ConfigPaths>(
    '@canopy/desktop-shared/pipelines/config-paths',
  ),
  getEnhancedEnv: (): Record<string, string | undefined> => ({
    ...process.env,
  }),
}));

const savedEnv = { ...process.env };
let root: string;
let managedRoot: string;
let pathDir: string;

function executable(file: string, contents: string): string {
  writeFileSync(file, contents, { mode: 0o755 });
  return file;
}

function managedCopy(contents = MANAGED_BYTES): string {
  mkdirSync(join(managedRoot, '1.5.1'), { recursive: true });
  return executable(join(managedRoot, '1.5.1', 'antigravity'), contents);
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agy-resolve-')));
  managedRoot = join(root, 'antigravity-runtime');
  pathDir = join(root, 'bin');
  mkdirSync(pathDir);
  process.env.PATH = pathDir;
  delete process.env.ANTIGRAVITY_EXECUTABLE;
  mockArtifact = {
    version: '1.5.1',
    url: 'https://example.invalid/agy_cli_mac_arm64.tar.gz',
    integrity: 'sha512-unused',
    archiveBytes: 1,
    executableSha256: MANAGED_SHA256,
  };
});

afterEach(() => {
  process.env = { ...savedEnv };
  jest.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const posixIt = process.platform === 'win32' ? it.skip : it;

describe('Antigravity executable resolution', () => {
  posixIt('prefers the managed copy over a PATH binary', async () => {
    const managed = managedCopy();
    executable(join(pathDir, 'agy'), '#!/bin/sh\necho 1.4.0\n');
    process.env.ANTIGRAVITY_EXECUTABLE = executable(
      join(root, 'override-agy'),
      '#!/bin/sh\necho override\n',
    );
    await expect(
      resolveAntigravityExecutable({ managedRootDir: managedRoot }),
    ).resolves.toBe(managed);
  });

  posixIt('skips a managed copy whose sha256 does not match', async () => {
    const warning = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    managedCopy(`${MANAGED_BYTES}tampered\n`);
    const onPath = executable(join(pathDir, 'agy'), '#!/bin/sh\n');
    await expect(
      resolveAntigravityExecutable({ managedRootDir: managedRoot }),
    ).resolves.toBe(onPath);
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(/Antigravity runtime verification failed/),
      expect.anything(),
    );
  });

  posixIt(
    'uses ANTIGRAVITY_EXECUTABLE before PATH when no managed copy',
    async () => {
      executable(join(pathDir, 'agy'), '#!/bin/sh\n');
      const override = executable(join(root, 'override-agy'), '#!/bin/sh\n');
      process.env.ANTIGRAVITY_EXECUTABLE = override;
      await expect(
        resolveAntigravityExecutable({ managedRootDir: managedRoot }),
      ).resolves.toBe(override);
    },
  );

  posixIt('uses PATH when the platform has no managed artifact', async () => {
    mockArtifact = undefined;
    managedCopy();
    const onPath = executable(join(pathDir, 'antigravity'), '#!/bin/sh\n');
    await expect(
      resolveAntigravityExecutable({ managedRootDir: managedRoot }),
    ).resolves.toBe(onPath);
  });

  posixIt(
    'tests can disable the managed lookup with an empty root',
    async () => {
      managedCopy();
      const emptyRoot = join(root, 'no-managed-runtime');
      mkdirSync(emptyRoot);
      const override = executable(join(root, 'override-agy'), '#!/bin/sh\n');
      process.env.ANTIGRAVITY_EXECUTABLE = override;
      await expect(
        resolveAntigravityExecutable({ managedRootDir: emptyRoot }),
      ).resolves.toBe(override);
    },
  );

  it('errors with the Settings wording when nothing resolves', async () => {
    await expect(
      resolveAntigravityExecutable({ managedRootDir: managedRoot }),
    ).rejects.toThrow(
      'Install Antigravity CLI 1.5.1 from Settings, then refresh Google models.',
    );
  });

  posixIt(
    'keeps the reason of a launch cancelled during managed verification',
    async () => {
      managedCopy();
      executable(join(pathDir, 'agy'), '#!/bin/sh\n');
      const controller = new AbortController();
      controller.abort(new Error('Stopped by the user'));
      await expect(
        resolveAntigravityExecutable({
          managedRootDir: managedRoot,
          signal: controller.signal,
        }),
      ).rejects.toThrow('Stopped by the user');
    },
  );
});

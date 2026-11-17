/**
 * Antigravity launches fail closed on an untrusted executable (CAN-6691).
 *
 * Every Antigravity surface opens its native runtime through
 * openAntigravityRuntime. On macOS it must refuse any file that is not
 * Google's Developer ID-signed CLI before a child starts; elsewhere it must
 * refuse the platform before resolving an executable at all. The child
 * environment must never let a caller re-enable the runtime's self-update.
 *
 * Google's signed release is not available to CI, so the accepted path,
 * verdict caching and replacement re-verification are qualified locally
 * against the official binary (docs/planning/2026-11-13-antigravity-followups/
 * platform-performance.md).
 */
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ProviderProcessSpawner } from '../../provider-process/spawn';
import { antigravityEnvironment, openAntigravityRuntime } from '../runtime';

jest.mock('@canopy/desktop-shared/node/acp', () => ({
  connectAcp: (): never => {
    throw new Error('ACP reached');
  },
}));

const darwin = process.platform === 'darwin';
const savedEnv = { ...process.env };
const execFileAsync = promisify(execFile);
let root: string;
let spawned: string[];

const spawnSpy: ProviderProcessSpawner = (request) => {
  spawned.push(request.command);
  throw new Error('spawn reached');
};

function open(
  executable: string,
  signal?: AbortSignal,
): ReturnType<typeof openAntigravityRuntime> {
  process.env.ANTIGRAVITY_EXECUTABLE = executable;
  return openAntigravityRuntime({
    cwd: root,
    profile: join(root, 'profile'),
    spawnProcess: spawnSpy,
    assertEnabled: () => undefined,
    owner: { kind: 'discovery', id: 'runtime-integrity' },
    onUpdate: () => undefined,
    signal,
  });
}

/** A script that would leave a marker if anything executed it. */
function markerScript(): { file: string; marker: string } {
  const file = join(root, 'agy');
  const marker = join(root, 'executed');
  writeFileSync(file, `#!/bin/sh\n/usr/bin/touch '${marker}'\n`, {
    mode: 0o755,
  });
  return { file, marker };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-integrity-')));
  spawned = [];
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(root, { recursive: true, force: true });
});

const darwinIt = darwin ? it : it.skip;
const otherIt = darwin ? it.skip : it;

describe('Antigravity executable integrity', () => {
  darwinIt('refuses an unsigned executable before it can run', async () => {
    const { file, marker } = markerScript();
    await expect(open(file)).rejects.toThrow(/Google's signed release/);
    expect(spawned).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  darwinIt('refuses a symlink to an unsigned executable', async () => {
    const { file, marker } = markerScript();
    const link = join(root, 'linked-agy');
    symlinkSync(file, link);
    await expect(open(link)).rejects.toThrow(/Google's signed release/);
    expect(spawned).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  darwinIt('refuses an Apple-signed binary that is not the CLI', async () => {
    const file = join(root, 'agy');
    copyFileSync('/usr/bin/true', file);
    await expect(open(file)).rejects.toThrow(/Google's signed release/);
    expect(spawned).toEqual([]);
  });

  darwinIt(
    'refuses a re-signed copy that claims the CLI identifier',
    async () => {
      const file = join(root, 'agy');
      copyFileSync('/usr/bin/true', file);
      await execFileAsync('/usr/bin/codesign', [
        '--force',
        '--sign',
        '-',
        '--identifier',
        'cli',
        file,
      ]);
      await expect(open(file)).rejects.toThrow(/Google's signed release/);
      expect(spawned).toEqual([]);
    },
  );

  darwinIt(
    'keeps the reason of a launch cancelled before verification',
    async () => {
      const { file, marker } = markerScript();
      const controller = new AbortController();
      const pending = open(file, controller.signal);
      controller.abort(new Error('Stopped by the user'));
      await expect(pending).rejects.toThrow('Stopped by the user');
      expect(spawned).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    },
  );

  otherIt('refuses unsupported platforms before any launch', async () => {
    const { file } = markerScript();
    await expect(open(file)).rejects.toThrow(/available on macOS/);
    expect(spawned).toEqual([]);
  });

  it('never lets a caller re-enable self-update', () => {
    process.env.AGY_CLI_DISABLE_AUTO_UPDATE = '0';
    expect(
      antigravityEnvironment({ AGY_CLI_DISABLE_AUTO_UPDATE: 'false' })
        .AGY_CLI_DISABLE_AUTO_UPDATE,
    ).toBe('true');
  });
});

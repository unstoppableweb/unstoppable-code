/**
 * Antigravity launches fail closed on an untrusted executable (CAN-6691).
 *
 * Every Antigravity surface opens its native runtime through
 * openAntigravityRuntime. On macOS it must refuse any file that is not
 * Google's Developer ID-signed CLI before a child starts; elsewhere it must
 * refuse the platform before resolving an executable at all. The child
 * environment must never let a caller re-enable the runtime's self-update.
 *
 * Google's signed release is not available to CI, so the refusals run the
 * real codesign, while the accepted path, verdict caching, replacement
 * re-verification and cancellation run against a stubbed codesign that
 * accepts only the files a case marks as signed. The official binary itself
 * is qualified locally (docs/planning/2026-11-13-antigravity-followups/
 * platform-performance.md).
 */
import { execFile } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type * as Util from 'node:util';
import type { ProviderProcessSpawner } from '../../provider-process/spawn';
import { antigravityEnvironment, openAntigravityRuntime } from '../runtime';
import {
  assertAntigravityExecutableUnchanged,
  verifyAntigravityExecutable,
} from '../runtime-integrity';

/**
 * Answers codesign for the verified file while a stubbed case runs; unset,
 * every execFile call, including codesign, reaches the real binary.
 */
let mockCodesign: ((file: string) => Promise<void>) | undefined;

// runtime-integrity promisifies execFile at load, so the stub sits on the
// promisify hook that call reads.
jest.mock('node:child_process', () => {
  const processes =
    jest.requireActual<typeof ChildProcess>('node:child_process');
  const util = jest.requireActual<typeof Util>('node:util');
  const real = util.promisify(processes.execFile);
  return {
    ...processes,
    execFile: Object.assign(
      (...args: Parameters<typeof processes.execFile>) =>
        processes.execFile(...args),
      {
        [util.promisify.custom]: (
          command: string,
          args: readonly string[],
          options: ChildProcess.ExecFileOptions,
        ): Promise<unknown> => {
          const file = args.at(-1);
          if (!mockCodesign || command !== '/usr/bin/codesign' || !file)
            return real(command, args, options);
          return mockCodesign(file).then(() => ({ stdout: '', stderr: '' }));
        },
      },
    ),
  };
});

jest.mock('@canopy/desktop-shared/node/acp', () => ({
  connectAcp: (): never => {
    throw new Error('ACP reached');
  },
}));

// Delegates to the real verifier unless a case sets mockTrustExecutable, which
// stands in for Google's signed release (unavailable to CI).
let mockTrustExecutable = false;
interface RuntimeIntegrity {
  verifyAntigravityExecutable: typeof verifyAntigravityExecutable;
  assertAntigravityExecutableUnchanged: typeof assertAntigravityExecutableUnchanged;
}
jest.mock('../runtime-integrity', () => {
  const actual = jest.requireActual<RuntimeIntegrity>('../runtime-integrity');
  return {
    ...actual,
    verifyAntigravityExecutable: (
      ...args: Parameters<typeof actual.verifyAntigravityExecutable>
    ): ReturnType<typeof actual.verifyAntigravityExecutable> =>
      mockTrustExecutable
        ? Promise.resolve(args[0])
        : actual.verifyAntigravityExecutable(...args),
    assertAntigravityExecutableUnchanged: (
      ...args: Parameters<typeof actual.assertAntigravityExecutableUnchanged>
    ): ReturnType<typeof actual.assertAntigravityExecutableUnchanged> =>
      mockTrustExecutable
        ? Promise.resolve()
        : actual.assertAntigravityExecutableUnchanged(...args),
  };
});

const darwin = process.platform === 'darwin';
const savedEnv = { ...process.env };
const execFileAsync = promisify(execFile);
let root: string;
let spawned: string[];
let requests: Parameters<ProviderProcessSpawner>[0][];

const spawnSpy: ProviderProcessSpawner = (request) => {
  spawned.push(request.command);
  requests.push(request);
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
  // Production resolves with fs/promises realpath, which has realpath.native
  // semantics: on Windows it expands 8.3 short names (RUNNER~1) that the JS
  // realpathSync keeps. Fixture paths must use the same form.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agy-integrity-')));
  spawned = [];
  requests = [];
  mockTrustExecutable = false;
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

  darwinIt('spawns the runtime with descendant-group reaping', async () => {
    mockTrustExecutable = true;
    const { file } = markerScript();
    await expect(open(file)).rejects.toThrow('spawn reached');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.reapDescendantGroups).toBe(true);
  });

  otherIt('refuses unsupported platforms before any launch', async () => {
    const { file } = markerScript();
    await expect(open(file)).rejects.toThrow(/available on macOS/);
    expect(spawned).toEqual([]);
  });

  it.each([undefined, '', '0', '1', 'unexpected'])(
    'keeps vendor CLI mode despite inherited or supplied value %p',
    (value) => {
      if (value === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = value;
      expect(antigravityEnvironment().ELECTRON_RUN_AS_NODE).toBe('1');
      if (value !== undefined)
        expect(
          antigravityEnvironment({ ELECTRON_RUN_AS_NODE: value })
            .ELECTRON_RUN_AS_NODE,
        ).toBe('1');
    },
  );

  it('never lets a caller re-enable self-update', () => {
    process.env.AGY_CLI_DISABLE_AUTO_UPDATE = '0';
    expect(
      antigravityEnvironment({ AGY_CLI_DISABLE_AUTO_UPDATE: 'false' })
        .AGY_CLI_DISABLE_AUTO_UPDATE,
    ).toBe('true');
  });
});

describe('verification with a stubbed codesign', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;
  let signed: Set<string>;
  let codesign: jest.Mock<Promise<void>, [string]>;

  /** A regular file the stub accepts while it stays in `signed`. */
  function signedFile(name = 'agy'): string {
    const file = join(root, name);
    writeFileSync(file, 'signed release\n', { mode: 0o755 });
    signed.add(file);
    return file;
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = (): void => undefined;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    signed = new Set();
    codesign = jest.fn((file: string) =>
      signed.has(file)
        ? Promise.resolve()
        : Promise.reject(new Error('codesign: invalid signature')),
    );
    mockCodesign = codesign;
  });

  afterEach(() => {
    mockCodesign = undefined;
  });

  posixIt('accepts a signed file and returns its real path', async () => {
    const file = signedFile();
    const link = join(root, 'linked-agy');
    symlinkSync(file, link);
    await expect(verifyAntigravityExecutable(link)).resolves.toBe(file);
    expect(codesign.mock.calls).toEqual([[file]]);
    await expect(assertAntigravityExecutableUnchanged(file)).resolves.toBe(
      undefined,
    );
  });

  it('reuses the verdict while the file is unchanged', async () => {
    const file = signedFile();
    await expect(verifyAntigravityExecutable(file)).resolves.toBe(file);
    await expect(verifyAntigravityExecutable(file)).resolves.toBe(file);
    expect(codesign).toHaveBeenCalledTimes(1);
  });

  it('re-verifies once the bytes change', async () => {
    const file = signedFile();
    await verifyAntigravityExecutable(file);
    appendFileSync(file, 'tampered\n');
    await expect(verifyAntigravityExecutable(file)).resolves.toBe(file);
    expect(codesign).toHaveBeenCalledTimes(2);
    signed.delete(file);
    appendFileSync(file, 'tampered again\n');
    await expect(verifyAntigravityExecutable(file)).rejects.toThrow(
      /Google's signed release/,
    );
    expect(codesign).toHaveBeenCalledTimes(3);
    await expect(assertAntigravityExecutableUnchanged(file)).rejects.toThrow(
      /changed during launch/,
    );
  });

  it('does not cache a file changed during verification', async () => {
    const file = signedFile();
    codesign.mockImplementationOnce((target) => {
      appendFileSync(target, 'reinstalled\n');
      return Promise.resolve();
    });
    await expect(verifyAntigravityExecutable(file)).rejects.toThrow(
      /changed during launch\. Try again/,
    );
    await expect(assertAntigravityExecutableUnchanged(file)).rejects.toThrow(
      /changed during launch/,
    );
    // The retry verifies the new bytes once and caches that verdict.
    await expect(verifyAntigravityExecutable(file)).resolves.toBe(file);
    await expect(verifyAntigravityExecutable(file)).resolves.toBe(file);
    expect(codesign).toHaveBeenCalledTimes(2);
    await expect(assertAntigravityExecutableUnchanged(file)).resolves.toBe(
      undefined,
    );
  });

  it('refuses the spawn after a verified file is replaced', async () => {
    const file = signedFile();
    await verifyAntigravityExecutable(file);
    await expect(assertAntigravityExecutableUnchanged(file)).resolves.toBe(
      undefined,
    );
    const replacement = join(root, 'agy.new');
    writeFileSync(replacement, 'signed release\n', { mode: 0o755 });
    renameSync(replacement, file);
    await expect(assertAntigravityExecutableUnchanged(file)).rejects.toThrow(
      /changed during launch/,
    );
  });

  it('cancels a waiting launch while the shared run caches', async () => {
    const file = signedFile();
    const gate = deferred();
    codesign.mockImplementationOnce(() => gate.promise);
    const controller = new AbortController();
    const cancelled = verifyAntigravityExecutable(file, controller.signal);
    const sharing = verifyAntigravityExecutable(file);
    while (codesign.mock.calls.length === 0)
      await new Promise((done) => setImmediate(done));
    controller.abort(new Error('Stopped by the user'));
    await expect(cancelled).rejects.toThrow('Stopped by the user');
    gate.resolve();
    await expect(sharing).resolves.toBe(file);
    await expect(verifyAntigravityExecutable(file)).resolves.toBe(file);
    expect(codesign).toHaveBeenCalledTimes(1);
  });
});

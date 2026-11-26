/**
 * Antigravity launches fail closed on an untrusted executable (CAN-6691,
 * CAN-6718).
 *
 * Every Antigravity surface opens its native runtime through
 * openAntigravityRuntime. On macOS it must refuse any file that is not
 * Google's Developer ID-signed CLI before a child starts. On Linux, which has
 * no OS signature, it must refuse any file whose SHA-256 is not the pinned
 * executableSha256 for the host. Elsewhere, Windows included, it must refuse
 * the platform before resolving an executable at all. The child environment
 * must never let a caller re-enable the runtime's self-update.
 *
 * Google's release is not available to CI, so the refusals run the real
 * codesign or the real digest check, the Linux accepted path runs the real
 * digest check against a pinned digest the case controls, and verdict
 * caching, replacement re-verification and cancellation run against a stubbed
 * platform check that accepts only the files a case marks as trusted. The
 * official binaries themselves are qualified locally (docs/planning/
 * 2026-11-13-antigravity-followups/platform-performance.md).
 */
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type * as Util from 'node:util';
import type * as Verification from '../../managed-runtime/verification';
import { verifyManagedExecutable } from '../../managed-runtime/verification';
import type { ProviderProcessSpawner } from '../../provider-process/spawn';
import type * as RuntimeArtifacts from '../runtime-artifacts';
import type { AntigravityRuntimeArtifact } from '../runtime-artifacts';
import type {
  AcpClientOptions,
  AcpPermissionRequest,
} from '@canopy/desktop-shared/node/acp';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ProviderProcess } from '../../provider-process/spawn';
import { antigravityEnvironment, openAntigravityRuntime } from '../runtime';
import { ANTIGRAVITY_RUNTIME_VERSION } from '../runtime-metadata';
import {
  assertAntigravityExecutableUnchanged,
  antigravityExecutableIdentityForLaunch,
  assertAntigravityExecutableIdentity,
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

/**
 * Answers the Linux digest check while a stubbed case runs; unset, the real
 * streaming SHA-256 check runs.
 */
let mockDigestCheck: ((file: string) => Promise<void>) | undefined;

jest.mock('../../managed-runtime/verification', () => {
  const actual = jest.requireActual<typeof Verification>(
    '../../managed-runtime/verification',
  );
  return {
    ...actual,
    verifyManagedExecutable: (
      ...args: Parameters<typeof actual.verifyManagedExecutable>
    ): ReturnType<typeof actual.verifyManagedExecutable> =>
      mockDigestCheck
        ? mockDigestCheck(args[0])
        : actual.verifyManagedExecutable(...args),
  };
});

/**
 * Runs before each fs/promises lstat, stat or access a case watches, so a
 * case can rename or replace files at the moments a same-user attacker would.
 * The changes are real; the hook only times them. Unset, the calls pass
 * straight through.
 */
let fsTimingHook:
  | ((call: 'lstat' | 'stat' | 'access', path: unknown) => void)
  | undefined;

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  const timed =
    <A extends [unknown, ...unknown[]], R>(
      call: 'lstat' | 'stat' | 'access',
      method: (...args: A) => R,
    ) =>
    (...args: A): R => {
      fsTimingHook?.(call, args[0]);
      return method(...args);
    };
  return {
    ...actual,
    lstat: timed('lstat', actual.lstat),
    stat: timed('stat', actual.stat),
    access: timed('access', actual.access),
  };
});

/**
 * The pinned Linux executableSha256 a case uses in place of Google's; `null`
 * stands for a host without a pinned artifact. Unset, the manifest applies.
 */
let mockPinnedSha256: string | null | undefined;

jest.mock('../runtime-artifacts', () => {
  const actual = jest.requireActual<typeof RuntimeArtifacts>(
    '../runtime-artifacts',
  );
  return {
    ...actual,
    getAntigravityRuntimeArtifact: (
      ...args: Parameters<typeof actual.getAntigravityRuntimeArtifact>
    ): AntigravityRuntimeArtifact | undefined => {
      const artifact = actual.getAntigravityRuntimeArtifact(...args);
      if (mockPinnedSha256 === undefined || !artifact) return artifact;
      return mockPinnedSha256 === null
        ? undefined
        : { ...artifact, executableSha256: mockPinnedSha256 };
    },
  };
});

// A case that sets mockConnect receives the opener's client options; every
// other case must never reach ACP.
let mockConnect: ((options: AcpClientOptions) => unknown) | undefined;
jest.mock('@canopy/desktop-shared/node/acp', () => ({
  connectAcp: (options: AcpClientOptions): unknown => {
    if (!mockConnect) throw new Error('ACP reached');
    return mockConnect(options);
  },
}));

// Delegates to the real verifier unless a case sets mockTrustExecutable, which
// stands in for Google's signed release (unavailable to CI).
let mockTrustExecutable = false;
interface RuntimeIntegrity {
  verifyAntigravityExecutable: typeof verifyAntigravityExecutable;
  assertAntigravityExecutableUnchanged: typeof assertAntigravityExecutableUnchanged;
  antigravityExecutableIdentityForLaunch: typeof antigravityExecutableIdentityForLaunch;
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
    antigravityExecutableIdentityForLaunch: (
      ...args: Parameters<typeof actual.antigravityExecutableIdentityForLaunch>
    ): ReturnType<typeof actual.antigravityExecutableIdentityForLaunch> =>
      mockTrustExecutable
        ? Promise.resolve('trusted')
        : actual.antigravityExecutableIdentityForLaunch(...args),
  };
});

const darwin = process.platform === 'darwin';
const linux = process.platform === 'linux';
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
    // An empty root: a developer's installed managed copy must not replace
    // the file each case launches through ANTIGRAVITY_EXECUTABLE.
    managedRootDir: join(root, 'no-managed-runtime'),
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
  mockPinnedSha256 = undefined;
  mockConnect = undefined;
  fsTimingHook = undefined;
});

afterEach(() => {
  fsTimingHook = undefined;
  process.env = { ...savedEnv };
  rmSync(root, { recursive: true, force: true });
});

const darwinIt = darwin ? it : it.skip;
const linuxIt = linux ? it : it.skip;
const supportedIt = darwin || linux ? it : it.skip;
const otherIt = darwin || linux ? it.skip : it;

/** The refusal copy for the host's check. */
/** The Linux refusal names the pinned release. */
const PINNED_REFUSAL = new RegExp(
  `isn't Google's ${ANTIGRAVITY_RUNTIME_VERSION.replace(/\./g, '\\.')} release`,
);
const REFUSAL = linux ? PINNED_REFUSAL : /Google's signed release/;

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

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

  linuxIt('refuses an executable that is not the pinned build', async () => {
    const { file, marker } = markerScript();
    await expect(open(file)).rejects.toThrow(
      `This Antigravity CLI isn't Google's ${ANTIGRAVITY_RUNTIME_VERSION} release. Install Antigravity CLI ${ANTIGRAVITY_RUNTIME_VERSION} from Settings.`,
    );
    expect(spawned).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  linuxIt('refuses a symlink to an executable that is not pinned', async () => {
    const { file, marker } = markerScript();
    const link = join(root, 'linked-agy');
    symlinkSync(file, link);
    await expect(open(link)).rejects.toThrow(PINNED_REFUSAL);
    expect(spawned).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  linuxIt('refuses a system binary that is not the CLI', async () => {
    const file = join(root, 'agy');
    copyFileSync('/usr/bin/true', file);
    await expect(open(file)).rejects.toThrow(PINNED_REFUSAL);
    expect(spawned).toEqual([]);
  });

  linuxIt(
    'runs only the file whose bytes match the pinned digest',
    async () => {
      const { file, marker } = markerScript();
      mockPinnedSha256 = sha256(file);
      const link = join(root, 'linked-agy');
      symlinkSync(file, link);
      await expect(open(link)).rejects.toThrow('spawn reached');
      // The real path is spawned, not the link.
      expect(spawned).toEqual([file]);
      expect(requests[0]?.reapDescendantGroups).toBe(true);
      expect(existsSync(marker)).toBe(false);
      appendFileSync(file, '# one more byte\n');
      spawned = [];
      await expect(open(link)).rejects.toThrow(PINNED_REFUSAL);
      expect(spawned).toEqual([]);
    },
  );

  linuxIt(
    'refuses a file whose directory is swapped while its digest is read',
    async () => {
      // The launched path names the attacker's file A. A copy of the pinned
      // bytes B waits in another directory. Once the check has taken A's
      // identity, the directories swap so the path names B while it is
      // hashed, then swap back before the identity is compared again.
      const launched = join(root, 'd');
      const pinned = join(root, 'd-pinned');
      const parked = join(root, 'd-parked');
      mkdirSync(launched);
      mkdirSync(pinned);
      const file = join(launched, 'agy');
      const marker = join(root, 'executed');
      writeFileSync(file, `#!/bin/sh\n/usr/bin/touch '${marker}'\n`, {
        mode: 0o755,
      });
      writeFileSync(join(pinned, 'agy'), '#!/bin/sh\necho pinned build\n', {
        mode: 0o755,
      });
      mockPinnedSha256 = sha256(join(pinned, 'agy'));
      let phase: 'before' | 'swapped' | 'restored' = 'before';
      fsTimingHook = (call, path): void => {
        if (path !== file) return;
        if (phase === 'before' && call === 'lstat') {
          phase = 'swapped';
          renameSync(launched, parked);
          renameSync(pinned, launched);
        } else if (phase === 'swapped' && call === 'stat') {
          phase = 'restored';
          renameSync(launched, pinned);
          renameSync(parked, launched);
        }
      };
      // The check itself, as the launch runs it, so only its own file calls
      // drive the swaps.
      await expect(verifyAntigravityExecutable(file)).rejects.toThrow(
        new RegExp(`${PINNED_REFUSAL.source}|changed during launch`),
      );
      // Both swaps happened, so the check really raced them.
      expect(phase).toBe('restored');
      // Nothing was cached for A: the pre-spawn check refuses, and a launch
      // without the race hashes A again and refuses it.
      fsTimingHook = undefined;
      await expect(assertAntigravityExecutableUnchanged(file)).rejects.toThrow(
        /changed before launch|changed during launch/,
      );
      await expect(open(file)).rejects.toThrow(PINNED_REFUSAL);
      expect(spawned).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    },
  );

  linuxIt(
    'refuses every file when no artifact is pinned for the host',
    async () => {
      const { file } = markerScript();
      mockPinnedSha256 = null;
      await expect(verifyAntigravityExecutable(file)).rejects.toThrow(
        PINNED_REFUSAL,
      );
    },
  );

  supportedIt(
    'does not pass a digest check cancelled during its final checks',
    async () => {
      // The installer prunes older runtimes once a check passes, so a check
      // cancelled after its last read must not report success.
      const { file } = markerScript();
      const controller = new AbortController();
      let lstats = 0;
      fsTimingHook = (call, path): void => {
        if (call === 'lstat' && path === file && ++lstats === 2)
          controller.abort(new Error('Stopped by the user'));
      };
      await expect(
        verifyManagedExecutable(
          file,
          sha256(file),
          controller.signal,
          'Antigravity',
        ),
      ).rejects.toThrow('Stopped by the user');
      // The final lstat was the one cancelled.
      expect(lstats).toBe(2);
    },
  );

  supportedIt(
    'refuses a FIFO swapped in after the file checks without waiting',
    async () => {
      // A FIFO opened for reading waits for a writer, so a swap after the
      // lstat must not leave the check (and a sign-in with no cancel) hung.
      const { file } = markerScript();
      // Opens the FIFO's write end, which releases a reader blocked on it.
      const releaseReader = (): void => {
        try {
          closeSync(
            openSync(file, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK),
          );
        } catch {
          // No reader is waiting.
        }
      };
      let release: NodeJS.Timeout | undefined;
      fsTimingHook = (call, path): void => {
        if (call !== 'access' || path !== file) return;
        fsTimingHook = undefined;
        rmSync(file);
        execFileSync('/usr/bin/mkfifo', ['-m', '755', file]);
        // A regression that blocks the open is released well before the
        // test times out, so no open stays in flight; the elapsed-time
        // check below still fails it.
        release = setTimeout(releaseReader, 2_000);
      };
      const started = Date.now();
      try {
        await expect(
          verifyManagedExecutable(
            file,
            sha256(file),
            AbortSignal.timeout(60_000),
            'Antigravity',
          ),
        ).rejects.toThrow('Antigravity runtime verification failed');
        expect(Date.now() - started).toBeLessThan(1_000);
      } finally {
        clearTimeout(release);
        releaseReader();
      }
    },
  );

  supportedIt(
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
    await expect(open(file)).rejects.toThrow(
      /available on macOS and Linux \(x64 and arm64\)/,
    );
    expect(spawned).toEqual([]);
    // The check itself also refuses, even for a file it is handed directly.
    await expect(verifyAntigravityExecutable(file)).rejects.toThrow(
      /Google's signed release/,
    );
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

  it('drops variable names that would arrive as another variable', () => {
    // A child receives each entry as `key=value`, so a key holding `=`
    // arrives as the variable before it: `BASH_ENV=/w/x` with value `y`
    // arrives as BASH_ENV=/w/x=y and would pass the exact-name filters.
    const env = antigravityEnvironment({
      'BASH_ENV=/w/x': 'y',
      'HOME=/w': 'z',
      'ANTIGRAVITY_EXECUTABLE=/w/agy': 'q',
      '': 'empty',
      'NUL\0KEY': 'n',
      KEPT_INPUT: '1',
    });
    expect(
      Object.keys(env).filter((key) => key === '' || /[=\0]/.test(key)),
    ).toEqual([]);
    expect(env.KEPT_INPUT).toBe('1');
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.ANTIGRAVITY_EXECUTABLE).toBeUndefined();
  });

  it('never lets a caller re-enable self-update', () => {
    process.env.AGY_CLI_DISABLE_AUTO_UPDATE = '0';
    expect(
      antigravityEnvironment({ AGY_CLI_DISABLE_AUTO_UPDATE: 'false' })
        .AGY_CLI_DISABLE_AUTO_UPDATE,
    ).toBe('true');
  });
});

// The platform check (codesign on macOS, the digest on Linux) is stubbed;
// other hosts have no check to stub and refuse every file above.
const stubbedDescribe = darwin || linux ? describe : describe.skip;

stubbedDescribe('verification with a stubbed platform check', () => {
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
    mockDigestCheck = codesign;
  });

  afterEach(() => {
    mockCodesign = undefined;
    mockDigestCheck = undefined;
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
    await expect(verifyAntigravityExecutable(file)).rejects.toThrow(REFUSAL);
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

  // CAN-6718 review round 11: the identity a launch confirmed stays its
  // own. A later verification of another file at the same path updates the
  // shared verdict, which the cache check then accepts; the exact-identity
  // check refuses it.
  it('holds a launch to the identity it confirmed when the path is re-verified', async () => {
    const file = signedFile();
    await verifyAntigravityExecutable(file);
    const confirmed = await antigravityExecutableIdentityForLaunch(file);
    await expect(
      assertAntigravityExecutableIdentity(file, confirmed),
    ).resolves.toBeUndefined();
    const replacement = join(root, 'agy.other');
    writeFileSync(replacement, 'signed release\nanother build\n', {
      mode: 0o755,
    });
    signed.add(replacement);
    renameSync(replacement, file);
    signed.add(file);
    await expect(verifyAntigravityExecutable(file)).resolves.toBe(file);
    await expect(assertAntigravityExecutableUnchanged(file)).resolves.toBe(
      undefined,
    );
    await expect(
      assertAntigravityExecutableIdentity(file, confirmed),
    ).rejects.toThrow(/changed during launch/);
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

/** A provider process that stays open until stopped; ACP is stubbed. */
class OpenProcess extends EventEmitter implements ProviderProcess {
  readonly pid = 1;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stop = (): Promise<void> => {
    this.stdout.end();
    return Promise.resolve();
  };
}

function permissionRequest(
  toolCall: Record<string, unknown>,
  signal = new AbortController().signal,
): AcpPermissionRequest {
  return {
    requestId: 1,
    resourceGeneration: 1,
    request: {
      sessionId: 's',
      toolCall: { toolCallId: 't', ...toolCall },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    },
    signal,
  };
}

// Antigravity 1.5.14 asks ACP permission for MCP calls, which 1.5.1 ran
// without asking. The opener answers a routed server's calls itself, since
// the host route authorizes each one at execution; every other request keeps
// the existing path.
describe('Antigravity opener permission answers', () => {
  supportedIt(
    'allows only routed MCP calls and sends native calls to the host',
    async () => {
      mockTrustExecutable = true;
      let answer: AcpClientOptions['onPermission'];
      mockConnect = (options): unknown => {
        answer = options.onPermission;
        return {
          getInitialization: (): { agentInfo: { version: string } } => ({
            agentInfo: { version: ANTIGRAVITY_RUNTIME_VERSION },
          }),
          close: (): void => undefined,
        };
      };
      const host = jest.fn(
        (): Promise<'allow' | 'deny'> => Promise.resolve('allow'),
      );
      const { file } = markerScript();
      process.env.ANTIGRAVITY_EXECUTABLE = file;
      const runtime = await openAntigravityRuntime({
        cwd: root,
        profile: join(root, 'profile'),
        spawnProcess: () => new OpenProcess(),
        assertEnabled: () => undefined,
        owner: { kind: 'discovery', id: 'runtime-permission' },
        onUpdate: () => undefined,
        onPermission: host,
        mcpServerNames: ['canopy', 'sel-ected'],
        managedRootDir: join(root, 'no-managed-runtime'),
      });
      try {
        if (!answer)
          throw new Error('The opener passed no permission handler.');
        const decide = answer;
        for (const name of ['mcp_canopy_GetGitPreferences', 'mcp_sel-ected_x'])
          await expect(
            decide(permissionRequest({ name, kind: 'other' })),
          ).resolves.toBe('allow');
        for (const name of [
          'mcp_other_tool',
          'mcp_canopy_',
          'mcp_canopyX_tool',
          'mcp_canopy_tool\n',
          'invoke_subagent',
        ])
          await expect(
            decide(permissionRequest({ name, kind: 'other' })),
          ).resolves.toBe('deny');
        const aborted = new AbortController();
        aborted.abort();
        await expect(
          decide(
            permissionRequest(
              { name: 'mcp_canopy_GetGitPreferences', kind: 'other' },
              aborted.signal,
            ),
          ),
        ).resolves.toBe('deny');
        expect(host).not.toHaveBeenCalled();
        await expect(
          decide(
            permissionRequest({
              name: 'run_command',
              kind: 'execute',
              rawInput: { CommandLine: 'pwd' },
            }),
          ),
        ).resolves.toBe('allow');
        expect(host).toHaveBeenCalledTimes(1);
      } finally {
        await runtime.close();
      }
    },
  );
});

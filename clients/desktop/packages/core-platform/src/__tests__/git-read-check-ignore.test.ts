import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitReadRunner } from '../git-read/runner';
import { evidenceRecorder } from './git-read-evidence';

const HOST =
  process.platform === 'darwin' || process.platform === 'linux'
    ? process.platform
    : undefined;
const posix = HOST ? describe : describe.skip;
const runner = createGitReadRunner({ os: HOST ?? 'linux' });
const evidence = evidenceRecorder('check-ignore');
const CONTRACT = 'checkIgnoredPathsWith: desktop execution contract (POSIX only: sh fixtures)'; // prettier-ignore
const REAL_GIT = 'checkIgnoredPathsWith: real Git (G0) (POSIX only; Windows: git-read-windows.test.ts)'; // prettier-ignore

let base = '';
let home = '';
let serial = 0;

/** Isolated from the user's and this worktree's Git state. */
function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CEILING_DIRECTORIES: base,
    ...extra,
  };
}

function repository(gitignore: string, config: string[][] = []): string {
  serial += 1;
  const repo = join(base, `repo-${serial}`);
  const env = gitEnv();
  execFileSync('git', ['init', '-q', repo], { env });
  for (const [key = '', value = ''] of config)
    execFileSync('git', ['-C', repo, 'config', key, value], { env });
  writeFileSync(join(repo, '.gitignore'), gitignore);
  return repo;
}

/** A fake `git` that logs each chunk's NUL count, then runs `body`. */
function fakeGit(body: string): { file: string; log: string } {
  serial += 1;
  const file = join(base, `fake-git-${serial}.sh`);
  const log = join(base, `fake-git-${serial}.log`);
  writeFileSync(
    file,
    `#!/bin/sh
in="$0.$$.in"
cat > "$in"
n=$(tr -cd '\\000' < "$in" | wc -c | tr -d ' ')
echo "$n" >> "${log}"
call=$(wc -l < "${log}" | tr -d ' ')
${body}
`,
  );
  chmodSync(file, 0o755);
  return { file, log };
}

const calls = (log: string): string[] =>
  readFileSync(log, 'utf8').trim().split('\n');
const paths = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `p${i}`);
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
/** Bounded, so a regression fails the test instead of polling past it. */
async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error(`Not met within ${ms} ms`);
    await delay(5);
  }
}

const settle = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

beforeAll(() => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 'git-read-ignore-'));
  home = join(base, 'home');
  mkdirSync(home);
});

afterAll(() => {
  evidence.flush();
  rmSync(base, { recursive: true, force: true });
});

posix(CONTRACT, () => {
  it('runs sequential 5,000-path chunks and unions the results', async () => {
    const { file, log } = fakeGit('cat "$in"');
    const input = paths(10_001);
    const result = await runner.checkIgnoredPathsWith(
      file,
      base,
      input,
      gitEnv(),
    );
    expect(calls(log)).toEqual(['5000', '5000', '1']);
    expect(result).toEqual(new Set(input));
  });

  it('spawns nothing for no paths', async () => {
    const { file, log } = fakeGit('cat "$in"');
    const result = await runner.checkIgnoredPathsWith(file, base, [], gitEnv());
    expect(result).toEqual(new Set());
    expect(() => readFileSync(log)).toThrow();
  });

  it('decodes UTF-8, splits on NUL, drops empty entries and trims nothing', async () => {
    const { file } = fakeGit(
      "printf 'a\\000\\000 b \\000caf\\303\\251\\000\\377\\000line\\nbreak\\000'",
    );
    const result = await runner.checkIgnoredPathsWith(file, base, ['x'], gitEnv()); // prettier-ignore
    expect(result).toEqual(new Set(['a', ' b ', 'café', '�', 'line\nbreak']));
  });

  it('treats exit 1 as an empty chunk and keeps the other chunks', async () => {
    const { file } = fakeGit(
      'if [ "$call" = 2 ]; then echo ignored-output; exit 1; fi; cat "$in"',
    );
    const input = paths(12_000);
    const result = await runner.checkIgnoredPathsWith(file, base, input, gitEnv()); // prettier-ignore
    expect(result).toEqual(
      new Set([...input.slice(0, 5000), ...input.slice(10_000)]),
    );
  });

  it.each([
    ['exit 128', 'exit 128', { code: 'exit_status', exitCode: 128 }],
    ['a signal', 'kill -9 $$', { code: 'exit_status', exitCode: null, signal: 'SIGKILL' }], // prettier-ignore
    ['output over 8 MiB', 'head -c 8388609 /dev/zero', { code: 'output_limit', stream: 'stdout' }], // prettier-ignore
  ])(
    'a later chunk failing with %s discards earlier results',
    async (_, failure, expected) => {
      const { file, log } = fakeGit(
        `if [ "$call" = 2 ]; then ${failure}; fi; cat "$in"`,
      );
      const outcome = await settle(
        runner.checkIgnoredPathsWith(file, base, paths(15_000), gitEnv()),
      );
      expect(outcome).toMatchObject({ error: expected });
      expect(calls(log)).toEqual(['5000', '5000']);
    },
  );

  it('resolves a relative executable through the supplied PATH and runs it in the cwd', async () => {
    const bin = join(base, 'relative-bin');
    mkdirSync(bin);
    const { file } = fakeGit('printf "%s\\000" "$(pwd -P)"');
    writeFileSync(join(bin, 'git'), readFileSync(file));
    chmodSync(join(bin, 'git'), 0o755);
    const cwd = mkdtempSync(join(base, 'cwd-'));
    const result = await runner.checkIgnoredPathsWith(
      'git',
      cwd,
      ['x'],
      gitEnv({ PATH: `${bin}:/usr/bin:/bin` }),
    );
    expect(result).toEqual(new Set([cwd]));
  });

  it('rejects a relative executable found only in the cwd with command_not_found', async () => {
    const cwd = mkdtempSync(join(base, 'cwd-only-'));
    const { file, log } = fakeGit('cat "$in"');
    writeFileSync(join(cwd, 'git'), readFileSync(file));
    chmodSync(join(cwd, 'git'), 0o755);
    const outcome = await settle(
      runner.checkIgnoredPathsWith(
        'git',
        cwd,
        paths(6000),
        gitEnv({ PATH: `:.:${mkdtempSync(join(base, 'empty-bin-'))}` }),
      ),
    );
    expect(outcome).toMatchObject({ error: { code: 'command_not_found' } });
    expect(existsSync(log)).toBe(false);
  });

  it('rejects with the request abort reason and stops later chunks', async () => {
    const { file, log } = fakeGit('sleep 30');
    const controller = new AbortController();
    const reason = { aborted: 'by client' };
    const work = settle(
      runner.checkIgnoredPathsWith(
        file,
        base,
        paths(6000),
        gitEnv(),
        controller.signal,
      ),
    );
    // A freshly written script can take a while to start on macOS. Wait for
    // the first chunk's complete line: the shell creates the log before echo
    // writes to it, and an abort in that gap leaves it empty (CAN-7025).
    await until(
      () => existsSync(log) && readFileSync(log, 'utf8').endsWith('\n'),
    );
    controller.abort(reason);
    const outcome = await work;
    expect(outcome).toEqual({ error: reason });
    expect(calls(log)).toEqual(['5000']);
  });

  it('applies one request deadline across every chunk', async () => {
    const quick = createGitReadRunner({
      os: HOST ?? 'linux',
      timing: { requestDeadlineMs: 1200, cleanupReserveMs: 300 },
    });
    const { file, log } = fakeGit('sleep 0.4; cat "$in"');
    const started = performance.now();
    const outcome = await settle(
      quick.checkIgnoredPathsWith(file, base, paths(25_000), gitEnv()),
    );
    expect(outcome).toMatchObject({ error: { code: 'deadline_exceeded' } });
    expect(performance.now() - started).toBeLessThan(1400);
    expect(calls(log).length).toBeLessThan(5);
  });
});

// R5 §2.3: the host selects each chunk's executable under the request bounds.
posix(
  'checkIgnoredPathsSelected: per-chunk selection (POSIX only: sh fixtures)',
  () => {
    interface Selection {
      readonly chunk: number;
      readonly signal: AbortSignal;
      readonly deadlineAt: number;
      readonly callsBefore: number;
    }
    const never = (): Promise<string> => new Promise(() => undefined);
    const quick = createGitReadRunner({
      os: HOST ?? 'linux',
      timing: { cleanupReserveMs: 300 },
    });
    function select(
      selections: Selection[],
      log: string,
      choose: (chunk: number) => Promise<string>,
    ): (
      chunk: number,
      signal: AbortSignal,
      deadlineAt: number,
    ) => Promise<string> {
      return (chunk, signal, deadlineAt) => {
        const callsBefore = existsSync(log) ? calls(log).length : 0;
        selections.push({ chunk, signal, deadlineAt, callsBefore });
        return choose(chunk);
      };
    }

    it('selects before each sequential chunk and runs the chunk with its executable', async () => {
      const shared = join(base, `selected-${(serial += 1)}.log`);
      const cat = fakeGit(`echo cat >> "${shared}"; cat "$in"`);
      const empty = fakeGit(`echo empty >> "${shared}"; exit 1`);
      const selections: Selection[] = [];
      const controller = new AbortController();
      const deadlineAt = performance.now() + 10_000;
      const input = paths(12_000);
      const result = await runner.checkIgnoredPathsSelected({
        cwd: base,
        paths: input,
        environment: gitEnv(),
        deadlineAt,
        signal: controller.signal,
        executableForChunk: select(selections, shared, (chunk) =>
          Promise.resolve(chunk === 1 ? empty.file : cat.file),
        ),
      });
      expect(result).toEqual(
        new Set([...input.slice(0, 5000), ...input.slice(10_000)]),
      );
      expect(calls(shared)).toEqual(['cat', 'empty', 'cat']);
      expect(
        selections.map(({ chunk, deadlineAt: at, callsBefore }) => [chunk, at, callsBefore]), // prettier-ignore
      ).toEqual([
        [0, deadlineAt, 0],
        [1, deadlineAt, 1],
        [2, deadlineAt, 2],
      ]);
      expect(selections.some(({ signal }) => signal.aborted)).toBe(false);
    });

    it('selects nothing for no paths', async () => {
      const selections: Selection[] = [];
      const result = await runner.checkIgnoredPathsSelected({
        cwd: base,
        paths: [],
        environment: gitEnv(),
        deadlineAt: performance.now() + 10_000,
        signal: new AbortController().signal,
        executableForChunk: select(selections, '', never),
      });
      expect(result).toEqual(new Set());
      expect(selections).toEqual([]);
    });

    it.each(['request', 'host'] as const)(
      'a pre-aborted %s signal rejects without selecting',
      async (source) => {
        const reason = { source };
        const signal = AbortSignal.abort(reason);
        const r = createGitReadRunner({
          os: HOST ?? 'linux',
          hostSignal: source === 'host' ? signal : undefined,
        });
        const selections: Selection[] = [];
        const outcome = await settle(
          r.checkIgnoredPathsSelected({
            cwd: base,
            paths: ['x'],
            environment: gitEnv(),
            deadlineAt: performance.now() + 10_000,
            signal:
              source === 'request' ? signal : new AbortController().signal,
            executableForChunk: select(selections, '', never),
          }),
        );
        expect(outcome).toEqual({ error: reason });
        expect(selections).toEqual([]);
      },
    );

    it('rejects with a later selection failure and discards earlier chunks', async () => {
      const { file, log } = fakeGit('cat "$in"');
      const failure = new Error('saved path unreadable');
      const outcome = await settle(
        runner.checkIgnoredPathsSelected({
          cwd: base,
          paths: paths(12_000),
          environment: gitEnv(),
          deadlineAt: performance.now() + 10_000,
          signal: new AbortController().signal,
          executableForChunk: (chunk) =>
            chunk === 1 ? Promise.reject(failure) : Promise.resolve(file),
        }),
      );
      expect(outcome).toEqual({ error: failure });
      expect(calls(log)).toEqual(['5000']);
    });

    it('passes a synchronous selection throw through', async () => {
      const failure = new Error('thrown');
      const outcome = await settle(
        runner.checkIgnoredPathsSelected({
          cwd: base,
          paths: ['x'],
          environment: gitEnv(),
          deadlineAt: performance.now() + 10_000,
          signal: new AbortController().signal,
          executableForChunk: () => {
            throw failure;
          },
        }),
      );
      expect(outcome).toEqual({ error: failure });
    });

    it.each(['request', 'host'] as const)(
      'rejects with the %s abort reason during selection and aborts its signal',
      async (source) => {
        const controller = new AbortController();
        const reason = new Error(`${source} stop`);
        const r = createGitReadRunner({
          os: HOST ?? 'linux',
          hostSignal: source === 'host' ? controller.signal : undefined,
        });
        const selections: Selection[] = [];
        const work = settle(
          r.checkIgnoredPathsSelected({
            cwd: base,
            paths: ['x'],
            environment: gitEnv(),
            deadlineAt: performance.now() + 10_000,
            signal: source === 'request' ? controller.signal : new AbortController().signal, // prettier-ignore
            executableForChunk: select(selections, '', never),
          }),
        );
        await until(() => selections.length > 0);
        expect(await r.whenIdle(AbortSignal.abort())).toBe('pending');
        controller.abort(reason);
        expect(await work).toEqual({ error: reason });
        expect(selections[0]?.signal.aborted).toBe(true);
        expect(selections[0]?.signal.reason).toBe(reason);
        // An abandoned selection is the caller's work, not the runner's.
        expect(await r.whenIdle(AbortSignal.abort())).toBe('idle');
      },
    );

    it('stops waiting for a selection at the cleanup reserve', async () => {
      const selections: Selection[] = [];
      const begun = performance.now();
      const deadlineAt = begun + 900;
      const outcome = await settle(
        quick.checkIgnoredPathsSelected({
          cwd: base,
          paths: ['x'],
          environment: gitEnv(),
          deadlineAt,
          signal: new AbortController().signal,
          executableForChunk: select(selections, '', never),
        }),
      );
      const elapsed = performance.now() - begun;
      expect(outcome).toMatchObject({ error: { code: 'deadline_exceeded' } });
      expect(elapsed).toBeGreaterThanOrEqual(550);
      expect(elapsed).toBeLessThan(900);
      expect(selections[0]?.signal.reason).toMatchObject({
        code: 'deadline_exceeded',
      });
    });

    it('applies the caller deadline across selection and every chunk', async () => {
      const { file, log } = fakeGit('cat "$in"');
      const selections: Selection[] = [];
      const begun = performance.now();
      const deadlineAt = begun + 2000;
      const outcome = await settle(
        quick.checkIgnoredPathsSelected({
          cwd: base,
          paths: paths(15_000),
          environment: gitEnv(),
          deadlineAt,
          signal: new AbortController().signal,
          // Chunk 0 runs; chunk 1's selection outlasts the 1,700 ms stop time.
          executableForChunk: select(selections, log, (chunk) =>
            chunk === 0 ? Promise.resolve(file) : never(),
          ),
        }),
      );
      expect(outcome).toMatchObject({ error: { code: 'deadline_exceeded' } });
      expect(performance.now() - begun).toBeGreaterThanOrEqual(1650);
      expect(performance.now()).toBeLessThan(deadlineAt);
      expect(
        selections.map(({ chunk, deadlineAt: at, callsBefore }) => [chunk, at, callsBefore]), // prettier-ignore
      ).toEqual([
        [0, deadlineAt, 0],
        [1, deadlineAt, 1],
      ]);
      expect(calls(log)).toEqual(['5000']);
    });

    it.each<[string, Record<string, unknown>]>([
      ['a non-finite deadline', { deadlineAt: Number.NaN }],
      ['a missing selector', { executableForChunk: undefined }],
      ['a missing signal', { signal: undefined }],
      ['non-string paths', { paths: [1] }],
    ])('rejects %s before selecting', async (_, overrides) => {
      const selections: Selection[] = [];
      const request = {
        cwd: base,
        paths: ['x'],
        environment: gitEnv(),
        deadlineAt: performance.now() + 10_000,
        signal: new AbortController().signal,
        executableForChunk: select(selections, '', never),
        ...overrides,
      };
      const outcome = await settle(
        Promise.resolve<unknown>(
          Reflect.apply(
            runner.checkIgnoredPathsSelected.bind(runner),
            undefined,
            [request],
          ),
        ),
      );
      expect(outcome).toMatchObject({ error: { code: 'invalid_request' } });
      expect(selections).toEqual([]);
    });

    it.each<[string, Record<string, unknown>]>([
      ['a relative cwd', { cwd: 'relative' }],
      ['a non-string environment value', { environment: { PATH: '/usr/bin', A: 1 } }], // prettier-ignore
    ])('rejects %s before selecting', async (_, overrides) => {
      const selections: Selection[] = [];
      const request = {
        cwd: base,
        paths: ['x'],
        environment: gitEnv(),
        deadlineAt: performance.now() + 10_000,
        signal: new AbortController().signal,
        executableForChunk: select(selections, '', never),
        ...overrides,
      };
      const outcome = await settle(
        Promise.resolve<unknown>(
          Reflect.apply(
            runner.checkIgnoredPathsSelected.bind(runner),
            undefined,
            [request],
          ),
        ),
      );
      expect(outcome).toMatchObject({ error: { code: 'invalid_request' } });
      expect(selections).toEqual([]);
    });

    it('rejects a Windows environment without SystemRoot before selecting', async () => {
      const selections: Selection[] = [];
      const outcome = await settle(
        createGitReadRunner({ os: 'win32' }).checkIgnoredPathsSelected({
          cwd: 'C:\\repo',
          paths: ['x'],
          environment: { PATH: 'C:\\Windows\\System32' },
          deadlineAt: performance.now() + 10_000,
          signal: new AbortController().signal,
          executableForChunk: select(selections, '', never),
        }),
      );
      expect(outcome).toMatchObject({ error: { code: 'invalid_request' } });
      expect(selections).toEqual([]);
    });

    // libuv reads `"bin;C:\Git"` as one relative entry, so PATH has no directory.
    it('rejects a Windows PATH whose only absolute text is quoted inside a relative entry before selecting', async () => {
      const selections: Selection[] = [];
      const outcome = await settle(
        createGitReadRunner({ os: 'win32' }).checkIgnoredPathsSelected({
          cwd: 'C:\\repo',
          paths: ['x'],
          environment: { SystemRoot: 'C:\\Windows', PATH: '"bin;C:\\Git"' },
          deadlineAt: performance.now() + 10_000,
          signal: new AbortController().signal,
          executableForChunk: select(selections, '', never),
        }),
      );
      expect(outcome).toMatchObject({ error: { code: 'invalid_request' } });
      expect(selections).toEqual([]);
    });

    it('returns an empty set for no paths, without checking cwd or environment', async () => {
      const result = await runner.checkIgnoredPathsSelected({
        cwd: 'relative',
        paths: [],
        environment: {},
        deadlineAt: performance.now() + 10_000,
        signal: new AbortController().signal,
        executableForChunk: never,
      });
      expect(result).toEqual(new Set());
    });

    it('does not select a later chunk after an abort between chunks', async () => {
      const { file, log } = fakeGit('cat "$in"');
      const controller = new AbortController();
      const reason = new Error('between chunks');
      const selections: Selection[] = [];
      // The loop reads `length` after chunk 0's run settles and before the
      // next selection: abort there, once chunk 0 has run.
      const input = new Proxy(paths(6000), {
        get(target, key, receiver): unknown {
          if (key === 'length' && existsSync(log) && !controller.signal.aborted)
            controller.abort(reason);
          return Reflect.get(target, key, receiver);
        },
      });
      const outcome = await settle(
        runner.checkIgnoredPathsSelected({
          cwd: base,
          paths: input,
          environment: gitEnv(),
          deadlineAt: performance.now() + 10_000,
          signal: controller.signal,
          executableForChunk: select(selections, log, () =>
            Promise.resolve(file),
          ),
        }),
      );
      expect(outcome).toEqual({ error: reason });
      expect(calls(log)).toEqual(['5000']);
      expect(selections.map(({ chunk }) => chunk)).toEqual([0]);
    });

    it('reports each chunk once its process starts, with its selected executable and version', async () => {
      const { file, log } = fakeGit('cat "$in"');
      const started: [number, unknown][] = [];
      /** Chunks reported by the time each chunk's process ran. */
      const reportedBefore: number[] = [];
      const result = await runner.checkIgnoredPathsSelected({
        cwd: base,
        paths: paths(12_000),
        environment: gitEnv(),
        deadlineAt: performance.now() + 10_000,
        signal: new AbortController().signal,
        executableForChunk: (chunk) => {
          reportedBefore.push(started.length);
          return Promise.resolve(
            chunk === 1 ? file : { executable: file, version: 'git version 2.47.1' }, // prettier-ignore
          );
        },
        onChunkStarted: (chunk, selected) => started.push([chunk, selected]),
      });
      expect(result.size).toBe(12_000);
      expect(calls(log)).toEqual(['5000', '5000', '2000']);
      expect(started).toEqual([
        [0, { executable: file, version: 'git version 2.47.1' }],
        [1, { executable: file, version: undefined }],
        [2, { executable: file, version: 'git version 2.47.1' }],
      ]);
      // Reported per chunk as it runs, not once at the end.
      expect(reportedBefore).toEqual([0, 1, 2]);
      expect(started.every(([, selected]) => Object.isFrozen(selected))).toBe(true); // prettier-ignore
    });

    it('reports no chunk that fails planning or spawn after selection', async () => {
      const missing = join(base, `missing-git-${(serial += 1)}`);
      for (const [selected, error] of [
        [missing, { code: 'ENOENT', syscall: `spawn ${missing}` }],
        ['', { code: 'invalid_request' }],
        [`absent-git-${serial}`, { code: 'command_not_found' }],
      ] as const) {
        const started: unknown[] = [];
        const outcome = await settle(
          runner.checkIgnoredPathsSelected({
            cwd: base,
            paths: ['x'],
            environment: gitEnv({ PATH: base }),
            deadlineAt: performance.now() + 10_000,
            signal: new AbortController().signal,
            executableForChunk: () => Promise.resolve(selected),
            onChunkStarted: (chunk) => started.push(chunk),
          }),
        );
        expect(outcome).toMatchObject({ error });
        expect(started).toEqual([]);
      }
    });

    it('reports no chunk aborted after its selection and before its spawn', async () => {
      const { file, log } = fakeGit('cat "$in"');
      const controller = new AbortController();
      const reason = new Error('after selection');
      // The abort lands during the bare command's PATH lookup, after selection.
      const r = createGitReadRunner({
        os: HOST ?? 'linux',
        isExecutable: (candidate) => {
          controller.abort(reason);
          return Promise.resolve(candidate === file);
        },
      });
      const selections: Selection[] = [];
      const started: unknown[] = [];
      const outcome = await settle(
        r.checkIgnoredPathsSelected({
          cwd: base,
          paths: ['x'],
          environment: gitEnv({ PATH: base }),
          deadlineAt: performance.now() + 10_000,
          signal: controller.signal,
          executableForChunk: select(selections, log, () =>
            Promise.resolve(file.slice(base.length + 1)),
          ),
          onChunkStarted: (chunk) => started.push(chunk),
        }),
      );
      expect(outcome).toEqual({ error: reason });
      expect(selections.map(({ chunk }) => chunk)).toEqual([0]);
      expect(existsSync(log)).toBe(false);
      expect(started).toEqual([]);
    });

    it('reports no absolute-path chunk aborted after its selection was accepted', async () => {
      const { file, log } = fakeGit('cat "$in"');
      const controller = new AbortController();
      const reason = new Error('after acceptance');
      const started: unknown[] = [];
      // The runner reads the accepted selection's fields before planning:
      // abort there, with no PATH lookup between it and the spawn.
      const accepted = {
        get executable(): string {
          controller.abort(reason);
          return file;
        },
        version: 'git version 2.47.1',
      };
      const outcome = await settle(
        runner.checkIgnoredPathsSelected({
          cwd: base,
          paths: ['x'],
          environment: gitEnv(),
          deadlineAt: performance.now() + 10_000,
          signal: controller.signal,
          executableForChunk: () => Promise.resolve(accepted),
          onChunkStarted: (chunk) => started.push(chunk),
        }),
      );
      expect(controller.signal.aborted).toBe(true);
      expect(outcome).toEqual({ error: reason });
      expect(existsSync(log)).toBe(false);
      expect(started).toEqual([]);
    });

    it('keeps the result when the start observer throws', async () => {
      const { file } = fakeGit('cat "$in"');
      const result = await runner.checkIgnoredPathsSelected({
        cwd: base,
        paths: ['x'],
        environment: gitEnv(),
        deadlineAt: performance.now() + 10_000,
        signal: new AbortController().signal,
        executableForChunk: () => Promise.resolve(file),
        onChunkStarted: () => {
          throw new Error('observer');
        },
      });
      expect(result).toEqual(new Set(['x']));
    });

    it.each(['', './git'])(
      'rejects a selected executable %p before spawning',
      async (selected) => {
        const outcome = await settle(
          runner.checkIgnoredPathsSelected({
            cwd: base,
            paths: ['x'],
            environment: gitEnv(),
            deadlineAt: performance.now() + 10_000,
            signal: new AbortController().signal,
            executableForChunk: () => Promise.resolve(selected),
          }),
        );
        expect(outcome).toMatchObject({ error: { code: 'invalid_request' } });
      },
    );
  },
);

posix(REAL_GIT, () => {
  // E7: Git exits 128 outside a repository without reading stdin.
  it('rejects with stdin EPIPE before exit 128 for 4 MiB outside a repository', async () => {
    const outside = mkdtempSync(join(base, 'outside-'));
    const long = paths(5000).map((name) => `${name}-${'x'.repeat(900)}`);
    const outcome = await settle(
      runner.checkIgnoredPathsWith('git', outside, long, gitEnv()),
    );
    const error: unknown = Reflect.get(Object(outcome), 'error');
    const code: unknown = Reflect.get(Object(error), 'code');
    const syscall: unknown = Reflect.get(Object(error), 'syscall');
    evidence.record('E7 4 MiB outside a repository', { code, syscall });
    expect(outcome).toMatchObject({ error: { code: 'EPIPE' } });
  });

  // Outside a repository, Git can exit before even a small write lands, so
  // that case races EPIPE (as E7 records for 4 MiB). Git must read this path
  // before it rejects it, so the input is always written first.
  it('rejects with exit 128 when Git fails after reading the small input', async () => {
    const repo = repository('');
    const outcome = await settle(
      runner.checkIgnoredPathsWith('git', repo, ['../outside'], gitEnv()),
    );
    expect(outcome).toMatchObject({
      error: { code: 'exit_status', exitCode: 128 },
    });
  });

  // E4: descriptors stay stable across repeated runs.
  it('does not grow open descriptors across runs', async () => {
    const repo = repository('*.log\n');
    const fdDir = HOST === 'linux' ? '/proc/self/fd' : '/dev/fd';
    const run = (): Promise<Set<string>> =>
      runner.checkIgnoredPathsWith('git', repo, ['a.log', 'b'], gitEnv());
    await expect(run()).resolves.toEqual(new Set(['a.log']));
    const before = readdirSync(fdDir).length;
    for (let i = 0; i < 60; i += 1) await run();
    const after = readdirSync(fdDir).length;
    evidence.record('E4 descriptors across 60 runs', { before, after });
    expect(after).toBeLessThanOrEqual(before);
  });

  // E9: output is unquoted bytes and independent of the locale.
  it('returns identical unquoted results under every locale', async () => {
    const repo = repository('*.log\n');
    const input = ['café x.log', 'new\nline.log', 'keep.txt', ' spaced .log'];
    const expected = new Set(['café x.log', 'new\nline.log', ' spaced .log']);
    const locales = ['C', 'en_US.UTF-8', 'ja_JP.eucJP', 'KOI8-R'];
    // An uninstalled locale falls back to C; record which ones really ran.
    const installed = new Set(
      (spawnSync('locale', ['-a'], { encoding: 'utf8' }).stdout ?? '')
        .split('\n')
        .map((name) => name.toLowerCase().replace(/[-_.]/g, '')),
    );
    const results = new Map<string, Set<string>>();
    for (const locale of locales) {
      const env = gitEnv({ LANG: locale, LC_ALL: locale });
      results.set(locale, await runner.checkIgnoredPathsWith('git', repo, input, env)); // prettier-ignore
    }
    evidence.record(
      'E9 locales',
      Object.fromEntries(
        locales.map((locale) => [
          locale,
          {
            installed: installed.has(locale.toLowerCase().replace(/[-_.]/g, '')), // prettier-ignore
            result: Array.from(results.get(locale) ?? []),
          },
        ]),
      ),
    );
    for (const locale of locales)
      expect([locale, results.get(locale)]).toEqual([locale, expected]);
  });

  // E10 (ASCII only): core.ignorecase governs case-folded matches.
  it.each([
    ['true', new Set(['NODE_MODULES/q'])],
    ['false', new Set()],
  ])('core.ignorecase=%s', async (ignorecase, expected) => {
    const repo = repository('node_modules/\n', [['core.ignorecase', ignorecase]]); // prettier-ignore
    const result = await runner.checkIgnoredPathsWith(
      'git',
      repo,
      ['NODE_MODULES/q'],
      gitEnv(),
    );
    expect(result).toEqual(expected);
  });

  // E10 (Unicode): stdin paths are matched and echoed byte-exactly; neither
  // form is normalized, whatever core.precomposeunicode says.
  it.each(['true', 'false'])(
    'core.precomposeunicode=%s matches NFC and NFD byte-exactly',
    async (precompose) => {
      const nfc = 'caf\u00e9.log';
      const nfd = 'cafe\u0301.log';
      const repo = repository(`${nfc}\n`, [['core.precomposeunicode', precompose]]); // prettier-ignore
      const result = await runner.checkIgnoredPathsWith(
        'git',
        repo,
        [nfd, nfc],
        gitEnv(),
      );
      expect(result).toEqual(new Set([nfc]));
    },
  );

  // E6: the supplied environment decides; ambient process.env never does.
  it('uses only the supplied environment for global excludes', async () => {
    const repo = repository('');
    const xdg = join(base, 'xdg');
    mkdirSync(join(xdg, 'git'), { recursive: true });
    writeFileSync(join(xdg, 'git', 'ignore'), '*.secret\n');
    const check = (env: Record<string, string>): Promise<Set<string>> =>
      runner.checkIgnoredPathsWith('git', repo, ['a.secret'], env);
    await expect(check(gitEnv({ XDG_CONFIG_HOME: xdg }))).resolves.toEqual(
      new Set(['a.secret']),
    );
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      await expect(check(gitEnv())).resolves.toEqual(new Set());
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });

  // E5: a configured fsmonitor hook runs inside the owned group; a member it
  // leaves behind is not the runner's to kill after a normal exit.
  it('runs an fsmonitor hook inside the owned group', async () => {
    const marker = join(base, 'hook.marker');
    const hook = join(base, 'fsmonitor-hook.sh');
    writeFileSync(
      hook,
      `#!/bin/sh\nps -o pgid= -p $$ | tr -d ' ' > "${marker}"\nsleep 30 </dev/null >/dev/null &\nprintf '/\\000'\n`,
    );
    chmodSync(hook, 0o755);
    const repo = repository('*.log\n', [['core.fsmonitor', hook]]);
    const env = gitEnv();
    execFileSync('git', ['-C', repo, '-c', 'core.fsmonitor=', 'add', '.gitignore'], { env }); // prettier-ignore
    let pgid = 0;
    try {
      const result = await runner.checkIgnoredPathsWith(
        'git',
        repo,
        ['a.log', 'b'],
        env,
      );
      pgid = Number(readFileSync(marker, 'utf8'));
      const ownPgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]).toString().trim()); // prettier-ignore
      let memberAlive = true;
      try {
        process.kill(-pgid, 0);
      } catch {
        memberAlive = false;
      }
      evidence.record('E5 fsmonitor hook', {
        result: Array.from(result),
        hookInOwnGroup: pgid > 1 && pgid !== ownPgid,
        leftMemberAliveAfterSettle: memberAlive,
      });
      expect(result).toEqual(new Set(['a.log']));
      expect(pgid).toBeGreaterThan(1);
      expect(pgid).not.toBe(ownPgid);
      expect(memberAlive).toBe(true);
    } finally {
      if (pgid > 1) process.kill(-pgid, 'SIGKILL');
    }
  });

  // E5: the builtin daemon detaches and outlives the request where Git has
  // it (macOS, Windows); elsewhere (Linux) Git reports it unsupported.
  it('builtin fsmonitor daemon: outlives the request where Git supports it', async () => {
    const env = gitEnv();
    const supported = execFileSync('git', ['version', '--build-options'], { env }).toString().includes('fsmonitor--daemon'); // prettier-ignore
    const repo = repository('*.log\n', [['core.fsmonitor', 'true']]);
    const status = (): { code: number | null; out: string } => {
      const run = spawnSync('git', ['-C', repo, 'fsmonitor--daemon', 'status'], { env, encoding: 'utf8' }); // prettier-ignore
      return { code: run.status, out: `${run.stdout}${run.stderr}` };
    };
    try {
      const result = await runner.checkIgnoredPathsWith('git', repo, ['a.log'], env); // prettier-ignore
      const after = status();
      evidence.record('E5 fsmonitor daemon', {
        supported,
        result: Array.from(result),
        statusCode: after.code,
        watching: after.out.includes('is watching'),
        unsupportedMessage: /not supported/i.test(after.out),
      });
      expect(result).toEqual(new Set(['a.log']));
      if (HOST === 'darwin') expect(supported).toBe(true);
      if (supported) expect(after.out).toMatch('is watching');
      else {
        expect(after.code).toBe(128);
        expect(after.out).toMatch(/not supported/i);
      }
    } finally {
      spawnSync('git', ['-C', repo, 'fsmonitor--daemon', 'stop'], { env, stdio: 'ignore' }); // prettier-ignore
    }
  });

  // E8: each Git configuration input changes results only when supplied.
  describe('E8 environment sensitivity', () => {
    let excludes = '';
    let other = '';
    const cases: [string, () => Record<string, string>][] = [
      ['HOME (~/.gitconfig core.excludesFile)', (): Record<string, string> => {
        const configured = mkdtempSync(join(base, 'e8-home-'));
        writeFileSync(join(configured, '.gitconfig'), `[core]\n\texcludesFile = ${excludes}\n`); // prettier-ignore
        return { HOME: configured };
      }],
      ['GIT_CONFIG_GLOBAL', (): Record<string, string> => {
        const config = join(mkdtempSync(join(base, 'e8-global-')), 'config');
        writeFileSync(config, `[core]\n\texcludesFile = ${excludes}\n`);
        return { GIT_CONFIG_GLOBAL: config };
      }],
      ['XDG_CONFIG_HOME', (): Record<string, string> => {
        const xdg = mkdtempSync(join(base, 'e8-xdg-'));
        mkdirSync(join(xdg, 'git'));
        writeFileSync(join(xdg, 'git', 'ignore'), '*.e8\n');
        return { XDG_CONFIG_HOME: xdg };
      }],
      ['GIT_CONFIG_COUNT/KEY/VALUE', (): Record<string, string> => ({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.excludesFile',
        GIT_CONFIG_VALUE_0: excludes,
      })],
      ['GIT_CONFIG_PARAMETERS', (): Record<string, string> => ({
        GIT_CONFIG_PARAMETERS: `'core.excludesFile=${excludes}'`,
      })],
      ['GIT_DIR', (): Record<string, string> => ({ GIT_DIR: join(other, '.git') })],
    ]; // prettier-ignore

    /** No global config file, and a HOME without one. */
    function bare(): Record<string, string> {
      const env = Object.entries(gitEnv()).filter(([key]) => key !== 'GIT_CONFIG_GLOBAL'); // prettier-ignore
      return { ...Object.fromEntries(env), HOME: mkdtempSync(join(base, 'e8-empty-home-')) }; // prettier-ignore
    }

    /** `bare()` without `keys`, so only an ambient value could supply them. */
    function bareWithout(keys: readonly string[]): Record<string, string> {
      return Object.fromEntries(Object.entries(bare()).filter(([key]) => !keys.includes(key))); // prettier-ignore
    }

    async function withAmbient<T>(
      values: Record<string, string>,
      work: () => Promise<T>,
    ): Promise<T> {
      const saved = Object.keys(values).map((key): [string, string | undefined] => [key, process.env[key]]); // prettier-ignore
      Object.assign(process.env, values);
      try {
        return await work();
      } finally {
        for (const [key, value] of saved)
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }
    }

    beforeAll(() => {
      excludes = join(base, 'e8-excludes');
      writeFileSync(excludes, '*.e8\n');
      other = repository('');
      writeFileSync(join(other, '.git', 'info', 'exclude'), '*.e8\n');
    });

    it.each(cases)('%s', async (name, input) => {
      const repo = repository('');
      const values = input();
      const check = (env: Record<string, string>): Promise<Set<string>> =>
        runner.checkIgnoredPathsWith('git', repo, ['a.e8', 'b'], env);
      const baseline = await check(bare());
      const supplied = await check({ ...bare(), ...values });
      // The keys are absent from the request, so a leak of process.env would apply them.
      const unsupplied = bareWithout(Object.keys(values));
      const ambientOnly = await withAmbient(values, () => check(unsupplied));
      evidence.record(`E8 ${name}`, {
        baseline: Array.from(baseline),
        supplied: Array.from(supplied),
        ambientOnly: Array.from(ambientOnly),
        ambientRunOmitted: Object.keys(values).filter((key) => !(key in unsupplied)), // prettier-ignore
      });
      expect(baseline).toEqual(new Set());
      expect(supplied).toEqual(new Set(['a.e8']));
      expect(ambientOnly).toEqual(new Set());
    });
  });
});

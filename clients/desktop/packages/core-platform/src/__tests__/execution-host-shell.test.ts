import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import type {
  PlatformExecutionProcessServices,
  PlatformOperatingSystem,
} from '@canopy/core-runtime';
import { createExecutionProcessServices } from '../index';
import { encodeExecutionHostFrame } from '../execution-host/channel';
import {
  createOwnedProcessHostPort,
  type OwnedExecutionHostPort,
} from '../execution-host/owned-process-host';
import {
  EXECUTION_HOST_LIMIT_EXIT_CODES,
  executionHostLimitFromExitCode,
  type ExecutionHostBudget,
  type ExecutionHostProcess,
} from '../execution-host/port';
import {
  EXECUTION_HOST_SHELL_USAGE_EXIT_CODE,
  executionHostHeapLimits,
  executionHostHeapSampleDelayMs,
  executionHostShellArgs,
  parseExecutionHostShellArgs,
} from '../execution-host/shell';

// Budgeted hosts under plain Node: the shell runner stands in for a
// shell-capable executable such as the core daemon, and runs the production
// shell around the port suite's host fixture.

const os = ((): PlatformOperatingSystem => {
  const platform: string = process.platform;
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32')
    return platform;
  throw new Error(`unsupported test host ${platform}`);
})();
const ROOT = path.resolve(__dirname, '../../../..');
const addon = process.env.CANOPY_OWNED_CHILD_ADDON
  ? path.resolve(ROOT, process.env.CANOPY_OWNED_CHILD_ADDON)
  : undefined;
const available = os !== 'win32' || (addon !== undefined && existsSync(addon));
const ENTRY = 'channel-host.js';
const SHELL = 'shell.js';
const BUDGET: ExecutionHostBudget = { heapMb: 64, rssMb: 2048 };

jest.setTimeout(60_000);

let dir = '';
let services: PlatformExecutionProcessServices;
let port: OwnedExecutionHostPort;
let diagnostics: string[];

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

function record(host: ExecutionHostProcess): {
  messages: unknown[];
  exit: Promise<number>;
  next: (type: string) => Promise<unknown>;
} {
  const messages: unknown[] = [];
  const waiters: { type: string; resolve: (message: unknown) => void }[] = [];
  host.on('message', (message) => {
    messages.push(message);
    for (const waiter of waiters.splice(0))
      if (field(message, 'type') === waiter.type) waiter.resolve(message);
      else waiters.push(waiter);
  });
  return {
    messages,
    exit: new Promise((resolve) => host.on('exit', resolve)),
    next: (type) =>
      new Promise((resolve) => {
        const seen = messages.find(
          (message) => field(message, 'type') === type,
        );
        if (seen !== undefined) resolve(seen);
        else waiters.push({ type, resolve });
      }),
  };
}

function launch(budget: ExecutionHostBudget = BUDGET): ExecutionHostProcess {
  return port.launch({ entry: ENTRY, serviceName: 'test-host', budget });
}

beforeAll(() => {
  dir = realpathSync.native(
    mkdtempSync(path.join(realpathSync.native(tmpdir()), 'execution-shell-')),
  );
  for (const [source, outfile] of [
    ['execution-host-channel-host.ts', ENTRY],
    ['execution-host-shell.ts', SHELL],
  ] as const)
    buildSync({
      entryPoints: [path.join(__dirname, 'fixtures', source)],
      outfile: path.join(dir, outfile),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
});

beforeEach(() => {
  diagnostics = [];
  services = createExecutionProcessServices({ os, nativePath: addon });
  port = createOwnedProcessHostPort({
    services,
    shell: { executable: process.execPath, args: [path.join(dir, SHELL)] },
    cwd: dir,
    environment: () => process.env,
    diagnostics: (stream, bytes) =>
      diagnostics.push(`${stream}:${Buffer.from(bytes).toString('utf8')}`),
  });
});

afterEach(async () => {
  if (available) await services.shutdown();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('execution host shell arguments', () => {
  it('round-trips a request and refuses malformed ones', () => {
    const args = executionHostShellArgs({ entry: ENTRY, budget: BUDGET });
    expect(parseExecutionHostShellArgs(args)).toEqual({
      entry: ENTRY,
      budget: BUDGET,
    });
    expect(parseExecutionHostShellArgs(['--version'])).toBeUndefined();
    expect(() => parseExecutionHostShellArgs([...args, '--extra'])).toThrow();
    expect(() =>
      executionHostShellArgs({ entry: path.join(dir, ENTRY), budget: BUDGET }),
    ).toThrow();
    expect(() =>
      parseExecutionHostShellArgs([
        `--canopy-execution-host=${path.join(dir, ENTRY)}`,
        ...args.slice(1),
      ]),
    ).toThrow();
    expect(() =>
      executionHostShellArgs({ entry: ENTRY, budget: { heapMb: 0, rssMb: 1 } }),
    ).toThrow();
  });

  it('stops the entry well before V8 reaches its own heap cap', () => {
    // At its cap V8 gives a worker only this much grace before a fast
    // allocator aborts the whole process instead of exiting at the limit.
    const workerHeapGraceBytes = 16 * 1024 * 1024;
    for (const heapMb of [64, 512, 2048, 6144, 10240]) {
      const limits = executionHostHeapLimits({ heapMb, rssMb: heapMb });
      expect(limits.stopBytes).toBeGreaterThan(heapMb * 1024 * 1024);
      expect(
        limits.v8CapMb * 1024 * 1024 - limits.stopBytes,
      ).toBeGreaterThanOrEqual(4 * workerHeapGraceBytes);
    }
  });

  it('samples the heap sooner as it nears the stop', () => {
    const MiB = 1024 * 1024;
    const { stopBytes } = executionHostHeapLimits(BUDGET);
    const delay = (
      usedBytes: number,
      growthBytesPerMs = 0,
      stop = stopBytes,
    ): number =>
      executionHostHeapSampleDelayMs({
        usedBytes,
        growthBytesPerMs,
        stopBytes: stop,
        intervalMs: 100,
      });
    // Far from the stop the interval caps the wait; close to it, the floor.
    expect(delay(0, 0, 1024 * MiB)).toBe(100);
    expect(delay(stopBytes - MiB)).toBe(10);
    // Slow or shrinking growth still plans for about 1 GiB/s: twice before
    // a 64 MiB gap closes at that rate.
    expect(delay(stopBytes - 64 * MiB, -MiB)).toBe(32);
    // Faster observed growth samples sooner.
    expect(delay(stopBytes - 64 * MiB, 4 * MiB)).toBe(10);
    expect(delay(stopBytes - 64 * MiB, 2 * MiB)).toBe(16);
  });

  it('refuses a budget on a port without a shell, and an unbudgeted host without Node', () => {
    const unbudgeted = createOwnedProcessHostPort({
      services,
      nodeExecutable: process.execPath,
      entryDirectory: dir,
      cwd: dir,
      environment: () => process.env,
    });
    expect(() =>
      unbudgeted.launch({ entry: ENTRY, serviceName: 'x', budget: BUDGET }),
    ).toThrow('cannot enforce a budget');
    expect(() => port.launch({ entry: ENTRY, serviceName: 'x' })).toThrow(
      'only budgeted hosts',
    );
  });
});

(available ? describe : describe.skip)('budgeted execution hosts', () => {
  it('serves the channel and exits with the entry code after its last message', async () => {
    const host = launch();
    const seen = record(host);
    host.postMessage({ type: 'burst', count: 64, size: 64 * 1024 });
    expect(await seen.exit).toBe(0);
    expect(seen.messages).toHaveLength(65);
    expect(field(seen.messages[64], 'type')).toBe('done');
    expect(diagnostics.join('')).toContain('not a frame');
    expect(diagnostics.join('')).toMatch(
      /The execution host peaked at \d+ MiB of heap and \d+ MiB resident\./,
    );
  });

  it('runs only the entries the shell serves', async () => {
    const host = port.launch({
      entry: 'shell.js',
      serviceName: 'test-host',
      budget: BUDGET,
    });
    const seen = record(host);
    expect(await seen.exit).toBe(EXECUTION_HOST_SHELL_USAGE_EXIT_CODE);
    expect(seen.messages).toEqual([]);
    expect(diagnostics.join('')).toContain('Malformed execution host request.');
  });

  it('runs the entry under a V8 heap cap above the sampled heap limit', async () => {
    const host = launch();
    const seen = record(host);
    host.postMessage({ type: 'heap-limit' });
    const capMb = Number(
      field(await seen.next('heap-limit'), 'oldGenerationMb'),
    );
    host.postMessage({ type: 'exit', code: 0 });
    expect(await seen.exit).toBe(0);
    // Room past the sampled stop, beyond Node's 16 MiB worker grace.
    expect(capMb * 1024 * 1024).toBeGreaterThan(
      executionHostHeapLimits(BUDGET).stopBytes + 2 * 16 * 1024 * 1024,
    );
  });

  it('stops an entry at its heap limit while the entry blocks its thread', async () => {
    const host = launch();
    const seen = record(host);
    host.postMessage({ type: 'exhaust', memory: 'heap' });
    const code = await seen.exit;
    // The output first: a failure then prints all host output, including V8's
    // reason when the process aborted instead.
    const output = diagnostics.join('');
    expect(output).toContain('heap limit of 64 MiB');
    expect(output).not.toContain('<--- Last few GCs --->');
    expect(code).toBe(EXECUTION_HOST_LIMIT_EXIT_CODES.heap);
  });

  it('samples a fast allocator before it can reach V8 cap between ticks', async () => {
    // A tick longer than the time the entry needs to fill the whole cap: a
    // sampler that waits a fixed tick leaves the stop to V8's backstop, whose
    // isolate teardown can abort the process with its writers open.
    const slowTicks = createOwnedProcessHostPort({
      services,
      shell: { executable: process.execPath, args: [path.join(dir, SHELL)] },
      cwd: dir,
      environment: () => ({
        ...process.env,
        EXECUTION_HOST_SHELL_TEST_SAMPLE_INTERVAL_MS: '10000',
      }),
      diagnostics: (stream, bytes) =>
        diagnostics.push(`${stream}:${Buffer.from(bytes).toString('utf8')}`),
    });
    const host = slowTicks.launch({
      entry: ENTRY,
      serviceName: 'test-host',
      budget: BUDGET,
    });
    const seen = record(host);
    host.postMessage({ type: 'exhaust', memory: 'heap' });
    const code = await seen.exit;
    const output = diagnostics.join('');
    expect(output).toContain('heap limit of 64 MiB');
    expect(output).not.toContain('<--- Last few GCs --->');
    // The sampled stop saw the heap past it; V8's backstop leaves no sample.
    const peakMb = Number(/peaked at (\d+) MiB of heap/.exec(output)?.[1]);
    expect(peakMb * 1024 * 1024).toBeGreaterThan(
      executionHostHeapLimits(BUDGET).stopBytes,
    );
    expect(code).toBe(EXECUTION_HOST_LIMIT_EXIT_CODES.heap);
  });

  it('keeps the heap limit when the launcher environment sets Node heap options', async () => {
    const withOptions = createOwnedProcessHostPort({
      services,
      shell: { executable: process.execPath, args: [path.join(dir, SHELL)] },
      cwd: dir,
      environment: () => ({
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=4096',
      }),
    });
    const host = withOptions.launch({
      entry: ENTRY,
      serviceName: 'test-host',
      budget: BUDGET,
    });
    const seen = record(host);
    host.postMessage({ type: 'exhaust', memory: 'heap' });
    expect(executionHostLimitFromExitCode(await seen.exit)).toBe('heap');
  });

  it('holds the heap limit when a process-wide option lifts the thread cap', async () => {
    const child = spawn(
      process.execPath,
      [
        path.join(dir, SHELL),
        ...executionHostShellArgs({ entry: ENTRY, budget: BUDGET }),
      ],
      {
        env: {
          ...process.env,
          CANOPY_EXECUTION_HOST_CHANNEL: 'stdio',
          NODE_OPTIONS: '--max-old-space-size=4096',
        },
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.write(
      encodeExecutionHostFrame({ type: 'exhaust', memory: 'heap' }),
    );
    const code = await new Promise<number | null>((resolve) =>
      child.on('exit', resolve),
    );
    expect(code).toBe(EXECUTION_HOST_LIMIT_EXIT_CODES.heap);
    expect(stderr).toContain('heap limit of 64 MiB');
  });

  it('stops an entry at its resident memory limit', async () => {
    const host = launch({ heapMb: 512, rssMb: 256 });
    const seen = record(host);
    host.postMessage({ type: 'exhaust', memory: 'resident' });
    expect(await seen.exit).toBe(EXECUTION_HOST_LIMIT_EXIT_CODES.rss);
    expect(diagnostics.join('')).toContain('resident memory limit of 256 MiB');
  });

  // A win32 cancel ends the whole job at once, so only the limits unwind there.
  it.each([
    ['the heap limit', 'heap'],
    ['the resident memory limit', 'resident'],
    ...(os === 'win32'
      ? []
      : [
          ['a cancel', 'kill'],
          ['a port shutdown', 'shutdown'],
        ]),
  ])('closes the entry SQLite writer at %s', async (_name, how) => {
    const database = path.join(dir, `writer-${how}.db`);
    // Each case leaves room under the limit it does not exercise.
    const host = launch(
      how === 'resident'
        ? { heapMb: 512, rssMb: 256 }
        : { heapMb: 64, rssMb: 2048 },
    );
    const seen = record(host);
    host.postMessage({ type: 'writer', path: database });
    await seen.next('writer');
    expect(existsSync(`${database}-wal`)).toBe(true);
    if (how === 'kill') expect(host.kill()).toBe(true);
    else if (how === 'shutdown') await port.shutdown();
    else host.postMessage({ type: 'exhaust', memory: how });
    const code = await seen.exit;
    if (how === 'kill' || how === 'shutdown') expect(code).toBe(143);
    else
      expect(executionHostLimitFromExitCode(code)).toBe(
        how === 'heap' ? 'heap' : 'rss',
      );
    // Closing the last connection checkpoints and removes the WAL; a process
    // that died holding the writer leaves it behind.
    expect(existsSync(`${database}-wal`)).toBe(false);
  });
});

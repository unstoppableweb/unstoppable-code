import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as Runtime from '@canopy/core-runtime';
import {
  createJobLauncher,
  createOwnedChildServices,
  OwnedChildError,
} from '../supervision/owned-child';

const linux = process.platform === 'linux';
// The native suite fails rather than skips on both POSIX hosts: its build in
// beforeAll throws when the addon cannot be built.
const posix = linux || process.platform === 'darwin';
const posixDescribe = posix ? describe : describe.skip;
const os: 'darwin' | 'linux' = linux ? 'linux' : 'darwin';
const BUILD = path.resolve(
  __dirname,
  '../../../../scripts/build-owned-child.mjs',
);
const MODULE = path.resolve(__dirname, '../supervision/owned-child.ts');
const ENV = { PATH: '/usr/bin:/bin' };
// `$1` receives the descendant PID; the descendant ignores SIGTERM.
const TREE = `trap '' TERM; /bin/sh -c 'trap "" TERM; n=0; while [ ! -f "$1" ] && [ "$n" -lt 600 ]; do /bin/sleep 0.05; n=$((n+1)); done' sh "$2" & echo $! > "$1";`;

/**
 * Test-only addon: leak() opens /dev/null without FD_CLOEXEC; subreaper()
 * (Linux) makes the caller adopt orphans it never reaps, as a container's
 * PID 1 or a CLI running as PID 1 does.
 */
const PROBE = `#include <node_api.h>
#include <fcntl.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif
static napi_value leak(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
  napi_create_int32(env, open("/dev/null", O_RDONLY), &out);
  return out;
}
static napi_value flags(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t fd = -1;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_get_value_int32(env, argv[0], &fd);
  napi_value out;
  napi_create_int32(env, fcntl(fd, F_GETFD), &out);
  return out;
}
static napi_value subreaper(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
#ifdef __linux__
  napi_create_int32(env, prctl(PR_SET_CHILD_SUBREAPER, 1), &out);
#else
  napi_create_int32(env, -1, &out);
#endif
  return out;
}
NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
      {"leak", NULL, leak, NULL, NULL, NULL, napi_enumerable, NULL},
      {"flags", NULL, flags, NULL, NULL, NULL, napi_enumerable, NULL},
      {"subreaper", NULL, subreaper, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  napi_define_properties(env, exports, 3, methods);
  return exports;
}
`;

let dir = '';
let addon = '';
/** Fixture PIDs; the fallback stop below only ever targets these. */
const fixtures = new Set<number>();
const stops = new Map<number, string>();
const rawCleanups = new Set<() => unknown>();
const children = new Set<Runtime.PlatformOwnedChild>();

function present(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), 'code') !== 'ESRCH';
  }
}

/**
 * Independent observation; '' once the PID is gone (reaped, not a zombie).
 * `start` names one process: a reused PID has another. Linux reads /proc,
 * which minimal images have without `ps`.
 */
function ps(pid: number, column: 'stat' | 'pgid' | 'start'): string {
  if (linux) return proc(pid)[{ stat: 0, pgid: 2, start: 19 }[column]] ?? '';
  try {
    return execFileSync(
      '/bin/ps',
      ['-o', `${column === 'start' ? 'lstart' : column}=`, '-p', String(pid)],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return '';
  }
}

/**
 * Linux /proc/<pid>/stat fields after the command name, in one read: state,
 * ppid, pgrp, ... num_threads (index 17), itrealvalue, starttime (19).
 * Empty once the PID is gone.
 */
function proc(pid: number): string[] {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return text.slice(text.lastIndexOf(')') + 2).split(' ');
  } catch {
    return [];
  }
}

/** Linux: gone, or a zombie none of whose threads still runs. */
function finished(pid: number): boolean {
  const fields = proc(pid);
  return (
    fields.length === 0 ||
    (/^[ZX]$/.test(fields[0] ?? '') && Number(fields[17]) <= 1)
  );
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Already absent, not even a zombie: a released root is reaped. */
function gone(pid: number): void {
  expect(ps(pid, 'stat')).toBe('');
  expect(present(pid)).toBe(false);
}

/**
 * A stopped group member. Darwin cleanup waits for the group to be reaped;
 * Linux cleanup ignores exited members, whose reaping is up to whichever
 * process adopted them.
 */
function dead(pid: number): void {
  if (linux) expect(finished(pid)).toBe(true);
  else gone(pid);
}

/** Still to clean up: on Linux until it exits, on Darwin until it is reaped. */
const lingering = (pid: number): boolean =>
  linux ? !finished(pid) : present(pid);

async function descendantOf(file: string): Promise<number> {
  let pid = 0;
  await until(() => {
    try {
      pid = Number(readFileSync(file, 'utf8').trim());
    } catch {
      pid = 0;
    }
    return pid > 1;
  });
  fixtures.add(pid);
  stops.set(pid, `${file}.stop`);
  return pid;
}

let probeFile = '';
/** Builds PROBE once per suite and returns its path. */
function probe(): string {
  if (probeFile) return probeFile;
  const source = path.join(dir, 'probe.c');
  const out = path.join(dir, 'probe.node');
  writeFileSync(source, PROBE);
  execFileSync(
    linux ? '/usr/bin/cc' : '/usr/bin/clang',
    [
      '-std=c11',
      '-fPIC',
      ...(linux ? ['-shared'] : ['-bundle', '-undefined', 'dynamic_lookup']),
      '-DNAPI_VERSION=8',
      '-I',
      path.resolve(path.dirname(process.execPath), '..', 'include', 'node'),
      '-o',
      out,
      source,
    ],
    { stdio: 'pipe' },
  );
  probeFile = out;
  return out;
}

/**
 * Test-only executable: its main thread exits and a sibling thread runs until
 * the file named by argv[1] exists, at most 30 s.
 */
const THREADED = `#define _POSIX_C_SOURCE 200809L
#include <pthread.h>
#include <time.h>
#include <unistd.h>
static void *run(void *file) {
  struct timespec pause = {0, 50000000};
  for (int n = 0; n < 600 && access(file, F_OK) != 0; n++)
    nanosleep(&pause, NULL);
  return NULL;
}
int main(int argc, char **argv) {
  pthread_t thread;
  if (argc < 2 || pthread_create(&thread, NULL, run, argv[1]) != 0) return 1;
  pthread_exit(NULL);
}
`;

function threaded(): string {
  const source = path.join(dir, 'threaded.c');
  const out = path.join(dir, 'threaded');
  writeFileSync(source, THREADED);
  execFileSync('/usr/bin/cc', ['-std=c11', '-pthread', '-o', out, source], {
    stdio: 'pipe',
  });
  return out;
}

const services = (): Runtime.PlatformOwnedChildServices =>
  createOwnedChildServices({ os, nativePath: addon });

/** Spawns `sh -c "<TREE> <tail>"`; returns the owned root and its descendant. */
async function tree(
  tail: string,
): Promise<[Runtime.PlatformOwnedChild, number]> {
  const file = path.join(dir, `pid-${fixtures.size}-${Date.now()}`);
  const child = await services().spawn({
    executable: '/bin/sh',
    args: ['-c', `${TREE} ${tail}`, 'sh', file, `${file}.stop`],
    environment: ENV,
  });
  children.add(child);
  fixtures.add(child.pid);
  return [child, await descendantOf(file)];
}

async function rejection(work: () => unknown): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const typed = (code: string): unknown =>
  expect.objectContaining({ name: 'OwnedChildError', code });

const get = (value: unknown, key: string): unknown =>
  Reflect.get(Object(value), key);

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'owned-child-'));
  if (!posix) return;
  // A per-suite output: parallel suites never share a build file.
  addon = path.join(dir, 'core-owned-child.node');
  execFileSync(process.execPath, [BUILD, '--out', addon], { stdio: 'pipe' });
}, 60_000);

afterEach(async () => {
  for (const child of Array.from(children))
    await child.terminate().catch(() => undefined);
  children.clear();
  // Fixture-owned files request self-exit; no post-reap PID is signal authority.
  stops.forEach((file) => writeFileSync(file, ''));
  rawCleanups.forEach((cleanup) => {
    try {
      cleanup();
    } catch {
      /* already released */
    }
  });
  rawCleanups.clear();
  await until(() => Array.from(fixtures).every((pid) => !lingering(pid)));
  stops.clear();
  fixtures.clear();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('unsupported hosts', () => {
  it('rejects every spawn on a host without a backend as capability_unavailable without loading', async () => {
    const dlopen = jest.spyOn(process, 'dlopen');
    try {
      const options: Parameters<typeof createOwnedChildServices>[0] = {
        os: 'linux',
        nativePath: '/missing.node',
      };
      Object.assign(options, { os: 'freebsd' });
      const owned = createOwnedChildServices(options);
      const request = { executable: '/bin/true', args: [], environment: {} };
      for (const spawned of [
        (): Promise<unknown> => owned.spawn(request),
        (): Promise<unknown> => owned.spawnWithChannel(request),
      ]) {
        const error = await rejection(spawned);
        expect(error).toBeInstanceOf(OwnedChildError);
        expect(error).toEqual(typed('capability_unavailable'));
      }
      expect(dlopen).not.toHaveBeenCalled();
    } finally {
      dlopen.mockRestore();
    }
  });

  it.each(['darwin', 'linux'] as const)(
    'refuses the Windows-only job launcher on %s without loading',
    (host) => {
      const dlopen = jest.spyOn(process, 'dlopen');
      try {
        const launcher = createJobLauncher({
          os: host,
          nativePath: '/controlled/backend.node',
        });
        expect(thrown(() => launcher.ready())).toEqual(
          typed('capability_unavailable'),
        );
        expect(dlopen).not.toHaveBeenCalled();
      } finally {
        dlopen.mockRestore();
      }
    },
  );

  it('rejects a POSIX executable path on win32 as invalid_argument without loading', async () => {
    const dlopen = jest.spyOn(process, 'dlopen');
    try {
      const owned = createOwnedChildServices({
        os: 'win32',
        nativePath: 'C:\\missing\\core-owned-child.node',
      });
      const error = await rejection(() =>
        owned.spawn({ executable: '/bin/true', args: [], environment: {} }),
      );
      expect(error).toEqual(typed('invalid_argument'));
      expect(dlopen).not.toHaveBeenCalled();
    } finally {
      dlopen.mockRestore();
    }
  });

  it.each(
    (['darwin', 'linux'] as const).flatMap((host) => [
      [host, 'missing', '/nonexistent/core-owned-child.node'],
      [host, 'relative', 'core-owned-child.node'],
      [host, 'Windows', 'C:\\app\\core-owned-child.node'],
      [host, 'not an addon', '/bin/sh'],
    ]),
  )(
    'rejects on %s a %s addon as capability_unavailable',
    async (host, _, nativePath) => {
      const owned = createOwnedChildServices({ os: host, nativePath });
      const error = await rejection(() =>
        owned.spawn({ executable: '/bin/true', args: [], environment: {} }),
      );
      expect(error).toEqual(typed('capability_unavailable'));
      if (host === 'linux' && nativePath === '/bin/sh') {
        expect(error).toBeInstanceOf(OwnedChildError);
        if (error instanceof OwnedChildError) {
          expect(error.loadDiagnostic).toContain('<addon>');
          expect(error.loadDiagnostic).not.toContain(nativePath);
          expect(
            Buffer.byteLength(error.loadDiagnostic ?? ''),
          ).toBeLessThanOrEqual(1024);
        }
      }
    },
  );

  it.each([
    ['missing', 'C:\\nonexistent\\core-owned-child.node'],
    ['relative', 'core-owned-child.node'],
    ['drive-relative', 'C:core-owned-child.node'],
    ['POSIX', '/nonexistent/core-owned-child.node'],
    ['device namespace', '\\\\?\\C:\\core-owned-child.node'],
  ])(
    'rejects a %s win32 addon path as capability_unavailable',
    async (_, nativePath) => {
      const owned = createOwnedChildServices({ os: 'win32', nativePath });
      const error = await rejection(() =>
        owned.spawn({
          executable: 'C:\\Windows\\System32\\cmd.exe',
          args: [],
          environment: {},
        }),
      );
      expect(error).toEqual(typed('capability_unavailable'));
    },
  );
});

posixDescribe(`${os} owned child`, () => {
  if (linux) {
    it('reports closed spawn errnos for absent and non-executable roots', async () => {
      const absent = await rejection(() =>
        services().spawn({
          executable: path.join(dir, 'absent-daemon'),
          args: [],
          environment: ENV,
        }),
      );
      expect(absent).toMatchObject({
        code: 'failed_precondition',
        spawnErrno: 'ENOENT',
      });

      const deniedPath = path.join(dir, 'non-executable-daemon');
      writeFileSync(deniedPath, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      const denied = await rejection(() =>
        services().spawn({
          executable: deniedPath,
          args: [],
          environment: ENV,
        }),
      );
      expect(denied).toMatchObject({
        code: 'failed_precondition',
        spawnErrno: 'EACCES',
      });
    });

    it('retains a genuinely unread stderr descriptor through root exit', async () => {
      const module = { exports: {} };
      process.dlopen(module, addon);
      const native: Record<string, (...args: unknown[]) => unknown> =
        module.exports;
      const spawned = native.spawn(
        '/bin/sh',
        ['/bin/sh', '-c', 'printf "CAPTURE-END\\n" >&2; exit 7'],
        [],
        null,
        true,
      );
      const handle = get(spawned, 'handle');
      if (typeof handle !== 'object' || handle === null)
        throw new Error('no native handle');
      fixtures.add(Number(get(spawned, 'pid')));
      rawCleanups.add(() => native.rollbackSync(handle));
      const fd = get(spawned, 'stderr');
      if (typeof fd !== 'number' || !Number.isSafeInteger(fd) || fd < 0)
        throw new Error('no native stderr descriptor');
      let closeStderr = (): void => closeSync(fd);
      rawCleanups.add(() => closeStderr());

      // No Socket (and therefore no libuv read) exists until after root exit.
      await until(() => get(native.observe(handle), 'state') === 'exited');
      expect(native.observe(handle)).toEqual({
        state: 'exited',
        code: 7,
        signal: null,
      });
      const stderr = new Socket({ fd, readable: true, writable: false });
      closeStderr = (): void => {
        stderr.destroy();
      };
      expect(stderr.writable).toBe(false);
      const chunks: Buffer[] = [];
      const ended = new Promise<void>((resolve, reject) => {
        stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
        stderr.once('end', resolve);
        stderr.once('error', reject);
      });
      await ended;
      expect(Buffer.concat(chunks).toString()).toBe('CAPTURE-END\n');
      await until(() => native.release(handle) === true);
    });

    it('returns a read-only stderr stream that drains after root exit', async () => {
      const child = await services().spawn({
        executable: '/bin/sh',
        args: ['-c', 'printf "CAPTURE-END\\n" >&2; exit 7'],
        environment: ENV,
        captureStderr: true,
      });
      children.add(child);
      expect(child.stderr).toBeDefined();
      // Adapter coverage: Socket may buffer before this listener is attached.
      await expect(child.exited).resolves.toEqual({ code: 7, signal: null });
      const chunks: Buffer[] = [];
      const ended = new Promise<void>((resolve, reject) => {
        child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.stderr?.once('end', resolve);
        child.stderr?.once('error', reject);
      });
      await ended;
      expect(Buffer.concat(chunks).toString()).toBe('CAPTURE-END\n');
      await child.terminate();
    });
  }

  it('holds an exited root until its TERM-ignoring group is gone', async () => {
    const [child, descendant] = await tree('exit 17');
    await expect(child.exited).resolves.toEqual({ code: 17, signal: null });
    // Root exited but unreaped: its PID, and so its group ID, stays reserved.
    expect(ps(child.pid, 'stat')).toMatch(/^Z/);
    expect(ps(descendant, 'pgid')).toBe(String(child.pid));
    expect(present(descendant)).toBe(true);

    // libuv reaps only its own children, never this root.
    for (let round = 0; round < 8; round++)
      await new Promise<void>((resolve, reject) =>
        spawn('/bin/sh', ['-c', 'exit 0'])
          .on('error', reject)
          .on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
          ),
      );
    expect(ps(child.pid, 'stat')).toMatch(/^Z/);

    await child.terminate();
    dead(descendant);
    expect(ps(child.pid, 'stat')).toBe('');
    await expect(child.terminate()).resolves.toBeUndefined();
    expect(thrown(() => child.commit())).toEqual(typed('failed_precondition'));
  });

  it('stops a running root together with its group', async () => {
    const [child, descendant] = await tree('wait');
    await child.terminate();
    await expect(child.exited).resolves.toEqual({
      code: null,
      signal: 'SIGKILL',
    });
    dead(descendant);
    expect(ps(child.pid, 'stat')).toBe('');
  });

  it('never stops a committed child and reaps it after a later exit', async () => {
    const [child, descendant] = await tree('wait');
    child.commit();
    child.commit();
    expect(await rejection(() => child.terminate())).toEqual(
      typed('failed_precondition'),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(present(child.pid) && present(descendant)).toBe(true);

    // The daemon's own later exit, simulated through fixture control.
    const stop = stops.get(descendant);
    if (!stop) throw new Error('missing fixture control');
    writeFileSync(stop, '');
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await until(() => ps(child.pid, 'stat') === '');
  });

  it('refuses to commit an exited root and rolls back its group', async () => {
    // Root exit between readiness and commit must not disown its group.
    const [child, descendant] = await tree('exit 0');
    await child.exited;
    expect(thrown(() => child.commit())).toEqual(typed('failed_precondition'));
    expect(present(descendant)).toBe(true);
    await child.terminate();
    dead(descendant);
    expect(ps(child.pid, 'stat')).toBe('');
  });

  it('restores default signal dispositions in the root', async () => {
    // Node ignores SIGPIPE; a shell cannot un-ignore an inherited ignore.
    const child = await services().spawn({
      executable: '/bin/sh',
      args: ['-c', 'kill -PIPE $$; exit 0'],
      environment: ENV,
    });
    children.add(child);
    await expect(child.exited).resolves.toEqual({
      code: null,
      signal: 'SIGPIPE',
    });
  });

  it('checks cancellation before any effect', async () => {
    const [child, descendant] = await tree('wait');
    const aborted = AbortSignal.abort();
    expect(() => child.commit(aborted)).toThrow();
    await expect(child.terminate(aborted)).rejects.toBe(aborted.reason);
    expect(present(child.pid) && present(descendant)).toBe(true);
    await child.terminate();
    dead(descendant);
  });

  it('serializes commit against a started stop', async () => {
    const [child, descendant] = await tree('wait');
    const first = child.terminate();
    const second = child.terminate();
    expect(thrown(() => child.commit())).toEqual(typed('failed_precondition'));
    await Promise.all([first, second]);
    dead(descendant);
    expect(ps(child.pid, 'stat')).toBe('');
  });

  it('keeps cleaning up after the caller stops waiting', async () => {
    const [child, descendant] = await tree('wait');
    const controller = new AbortController();
    const waiting = child.terminate(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBe(controller.signal.reason);
    await child.terminate();
    dead(descendant);
    expect(ps(child.pid, 'stat')).toBe('');
  });

  it('hands stdin and the exact environment over privately', async () => {
    const out = path.join(dir, 'handoff');
    const secret = JSON.stringify({ claim: 'x'.repeat(4000) });
    const child = await services().spawn({
      executable: '/bin/sh',
      args: ['-c', '/bin/cat > "$1"; /usr/bin/env > "$1.env"', 'sh', out],
      environment: { ...ENV, MARKER: 'stdin-v1' },
      stdin: secret,
    });
    children.add(child);
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await child.terminate();
    expect(readFileSync(out, 'utf8')).toBe(secret);
    const env = readFileSync(`${out}.env`, 'utf8');
    expect(env).toContain('MARKER=stdin-v1');
    expect(env).not.toContain('HOME=');
    expect(env).not.toContain(secret);
  });

  it('passes the root no descriptor above stderr', async () => {
    // Node marks the descriptors it creates or inherits CLOEXEC, so only
    // native code (Electron, another addon) leaves one inheritable: this probe
    // stands in for it.
    const native = { exports: {} };
    process.dlopen(native, probe());
    const call = (name: string, ...args: unknown[]): unknown => {
      const method = get(native.exports, name);
      if (typeof method !== 'function') throw new Error(`no probe ${name}`);
      return Reflect.apply(method, null, args);
    };
    const leaked = Number(call('leak'));
    try {
      expect(leaked).toBeGreaterThan(2);
      // FD_CLOEXEC is clear: a plain posix_spawn would pass it on.
      expect(call('flags', leaked)).toBe(0);
      const out = path.join(dir, 'fds');
      const child = await services().spawn({
        executable: '/bin/sh',
        args: [
          '-c',
          '[ -e /dev/fd/2 ]; a=$?; [ -e "/dev/fd/$2" ]; echo "$a $?" > "$1"',
          'sh',
          out,
          String(leaked),
        ],
        environment: ENV,
      });
      children.add(child);
      await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
      // stderr is visible to the check; the leaked descriptor is not.
      expect(readFileSync(out, 'utf8')).toBe('0 1\n');
    } finally {
      closeSync(leaked);
    }
  });

  it('holds an exited root so its PID names no other process until release', async () => {
    const stop = path.join(dir, `reuse-${Date.now()}`);
    const child = await services().spawn({
      executable: '/bin/sh',
      args: ['-c', 'while [ ! -f "$1" ]; do /bin/sleep 0.05; done', 'sh', stop],
      environment: ENV,
    });
    children.add(child);
    fixtures.add(child.pid);
    const started = ps(child.pid, 'start');
    expect(started).not.toBe('');
    writeFileSync(stop, '');
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    // Exited yet unreaped: the same process, not absence or a successor.
    expect(ps(child.pid, 'stat')).toMatch(/^Z/);
    expect(ps(child.pid, 'start')).toBe(started);
    await child.terminate();
    gone(child.pid);
  });

  // Linux lists the group from /proc; Darwin's listing is a kernel snapshot.
  const linuxIt = linux ? it : it.skip;

  linuxIt(
    'stops a group whose orphans its host adopts and never reaps',
    async () => {
      const SUBREAPER_HOST = `
      const [, , module, nativePath, probePath, file] = process.argv;
      const { readFileSync } = await import('node:fs');
      const probe = { exports: {} };
      process.dlopen(probe, probePath);
      if (probe.exports.subreaper() !== 0) process.exit(4);
      const { createOwnedChildServices } = await import(module);
      const child = await createOwnedChildServices({ os: 'linux', nativePath })
        .spawn({ executable: '/bin/sh', args: ['-c', ${JSON.stringify(TREE)} + ' wait', 'sh', file, file + '.stop'], environment: { PATH: '/usr/bin:/bin' } });
      const read = () => { try { return readFileSync(file, 'utf8').trim(); } catch { return ''; } };
      while (!/^[0-9]+$/.test(read())) await new Promise((r) => setTimeout(r, 10));
      const descendant = read();
      process.stdout.write(child.pid + ' ' + descendant);
      try { await child.terminate(); } catch (error) { process.stdout.write(' ' + error.code); process.exit(2); }
      const stat = readFileSync('/proc/' + descendant + '/stat', 'utf8');
      const [state, parent] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      process.stdout.write(state === 'Z' && Number(parent) === process.pid ? ' adopted' : ' ' + state + ' ' + parent);
    `;
      const script = path.join(dir, 'subreaper.mjs');
      const file = path.join(dir, `subreaper-${Date.now()}`);
      writeFileSync(script, SUBREAPER_HOST);
      const args = [script, pathToFileURL(MODULE).href, addon, probe(), file];
      const [code, stdout] = await new Promise<[number | null, string]>(
        (resolve) => {
          execFile(
            process.execPath,
            args,
            { env: ENV, timeout: 10_000 },
            (error, out) =>
              resolve([error ? Number(Reflect.get(error, 'code')) : 0, out]),
          );
        },
      );
      const [root, descendant] = stdout.split(' ').map(Number);
      fixtures.add(root);
      fixtures.add(descendant);
      // The killed descendant was left a zombie of the host, yet the stop held.
      expect([code, stdout.split(' ').slice(2).join(' ')]).toEqual([
        0,
        'adopted',
      ]);
    },
  );

  linuxIt(
    'stops the members of an exited uncommitted root before reaping it',
    async () => {
      // A /proc scan can miss a process forked during it, so the group is
      // signaled before an empty scan is trusted.
      const module = { exports: {} };
      process.dlopen(module, addon);
      const native: Record<string, (...args: unknown[]) => unknown> =
        module.exports;
      const file = path.join(dir, `member-${Date.now()}`);
      const spawned = native.spawn(
        '/bin/sh',
        ['/bin/sh', '-c', '/bin/sleep 30 & echo $! > "$1"', 'sh', file],
        [],
        null,
      );
      const handle = get(spawned, 'handle');
      if (typeof handle !== 'object' || handle === null)
        throw new Error('no native handle');
      fixtures.add(Number(get(spawned, 'pid')));
      rawCleanups.add(() => native.rollbackSync(handle));
      const member = await descendantOf(file);
      stops.delete(member);
      await until(() => get(native.observe(handle), 'state') === 'exited');
      expect(present(member)).toBe(true);
      // No stopGroup: release alone ends the member and then reaps the root.
      await until(() => native.release(handle) === true);
      dead(member);
    },
  );

  linuxIt(
    'counts a member whose exited main thread leaves a live thread',
    async () => {
      // /proc lists only the thread-group leader, which turns zombie while
      // its other threads still run.
      const program = threaded();
      const module = { exports: {} };
      process.dlopen(module, addon);
      const native: Record<string, (...args: unknown[]) => unknown> =
        module.exports;
      const file = path.join(dir, `threaded-${Date.now()}`);
      const spawned = native.spawn(
        '/bin/sh',
        [
          '/bin/sh',
          '-c',
          '"$1" "$2.stop" & echo $! > "$2"; wait',
          'sh',
          program,
          file,
        ],
        [],
        null,
      );
      const handle = get(spawned, 'handle');
      if (typeof handle !== 'object' || handle === null)
        throw new Error('no native handle');
      fixtures.add(Number(get(spawned, 'pid')));
      rawCleanups.add(() => native.rollbackSync(handle));
      const member = await descendantOf(file);
      // Zombie leader, one other thread.
      await until(() => {
        const fields = proc(member);
        return fields[0] === 'Z' && fields[17] === '2';
      });
      expect(native.members(handle)).toBe(1);
      expect(native.stopGroup(handle)).toBe(true);
      await until(() => native.release(handle) === true);
      dead(member);
    },
  );

  it.each<
    [
      string,
      Partial<Parameters<Runtime.PlatformOwnedChildServices['spawn']>[0]>,
    ]
  >([
    ['relative executable', { executable: 'sh' }],
    ['oversized stdin', { stdin: 'x'.repeat(4097) }],
    ['malformed environment', { environment: { 'A=B': 'c' } }],
    ['NUL argument', { args: ['\0'] }],
  ])('rejects a %s with no child', async (_, change) => {
    const error = await rejection(() =>
      services().spawn({
        executable: '/bin/sh',
        args: ['-c', 'exit 0'],
        environment: ENV,
        ...change,
      }),
    );
    expect(error).toEqual(typed('invalid_argument'));
  });

  it('rejects a spawn that creates no process', async () => {
    const error = await rejection(() =>
      services().spawn({
        executable: path.join(dir, 'missing'),
        args: [],
        environment: ENV,
      }),
    );
    expect(error).toEqual(typed('failed_precondition'));
  });

  it('binds native handles to the load that issued them', async () => {
    const load = (
      file: string,
    ): Record<string, (...args: unknown[]) => unknown> => {
      const module = { exports: {} };
      process.dlopen(module, file);
      return module.exports;
    };
    const copy = path.join(dir, 'second.node');
    copyFileSync(addon, copy);
    // Same file twice (two service compositions) and a separately built copy.
    const loads = [load(addon), load(addon), load(copy)];
    const handleOf = (
      native: Record<string, (...args: unknown[]) => unknown>,
      spawned: unknown,
    ): object => {
      fixtures.add(Number(get(spawned, 'pid')));
      const handle = get(spawned, 'handle');
      if (typeof handle !== 'object' || handle === null)
        throw new Error('no native handle');
      rawCleanups.add(() => native.rollbackSync(handle));
      return handle;
    };
    const handles = loads.map((native) =>
      handleOf(
        native,
        native.spawn('/bin/sleep', ['/bin/sleep', '30'], [], null),
      ),
    );
    const code = (run: () => unknown): unknown => {
      try {
        return run();
      } catch (error) {
        return get(error, 'code');
      }
    };
    loads.forEach((native, n) => {
      expect(code(() => native.stopGroup({}))).toBe('ERR_OWNED_CHILD_HANDLE');
      expect(code(() => native.stopGroup(42))).toBe('ERR_OWNED_CHILD_HANDLE');
      handles.forEach((handle, m) => {
        if (m !== n)
          expect(code(() => native.stopGroup(handle))).toBe(
            'ERR_OWNED_CHILD_HANDLE',
          );
      });
      // Later loads left earlier handles valid.
      expect(native.observe(handles[n])).toEqual({ state: 'running' });
    });
    loads.forEach((native, n) => {
      expect(native.rollbackSync(handles[n])).toBe(true);
      expect(code(() => native.stopGroup(handles[n]))).toBe(
        'ERR_OWNED_CHILD_HANDLE',
      );
      expect(code(() => native.observe(handles[n]))).toBe(
        'ERR_OWNED_CHILD_HANDLE',
      );
    });

    // Native refusal, independent of the adapter's own exit observation.
    const [native] = loads;
    const handleSpawn = native.spawn(
      '/bin/sh',
      ['/bin/sh', '-c', 'exit 0'],
      [],
      null,
    );
    const handle = handleOf(native, handleSpawn);
    await until(() => get(native.observe(handle), 'state') === 'exited');
    expect(code(() => native.commit(handle))).toBe('ERR_OWNED_CHILD_EXITED');
    // A group left with only its exited root has nothing to stop; Darwin
    // refuses a group signal to it with EPERM rather than ESRCH, and Linux
    // signals the zombie root successfully.
    expect(ps(Number(get(handleSpawn, 'pid')), 'stat')).toMatch(/^Z/);
    expect(native.members(handle)).toBe(0);
    expect(code(() => native.stopGroup(handle))).toBe(true);
    expect(native.rollbackSync(handle)).toBe(true);
  });

  describe('host exit', () => {
    const HOST = `
      const [, , module, nativePath, file, tail, mode, os] = process.argv;
      const { createOwnedChildServices } = await import(module);
      const child = await createOwnedChildServices({ os, nativePath })
        .spawn({ executable: '/bin/sh', args: ['-c', ${JSON.stringify(TREE)} + ' ' + tail, 'sh', file, file + '.stop'], environment: { PATH: '/usr/bin:/bin' } });
      process.stdout.write(String(child.pid));
      const { readFileSync } = await import('node:fs');
      // The shell creates the file before writing the PID: wait for the PID.
      const written = () => { try { return /^[0-9]+$/.test(readFileSync(file, 'utf8').trim()); } catch { return false; } };
      while (!written()) await new Promise((r) => setTimeout(r, 10));
      if (mode.startsWith('commit')) child.commit();
      if (mode.endsWith('exit')) process.exit(3);
      if (mode === 'owned-throw') throw new Error('host failed');
      if (mode === 'owned') await child.exited;
    `;

    async function host(
      tail: string,
      mode: string,
    ): Promise<{ code: number | null; root: number; descendant: number }> {
      const script = path.join(dir, 'host.mjs');
      const file = path.join(dir, `host-${mode}`);
      writeFileSync(script, HOST);
      const args = [
        script,
        pathToFileURL(MODULE).href,
        addon,
        file,
        tail,
        mode,
        os,
      ];
      const [code, stdout] = await new Promise<[number | null, string]>(
        (resolve) => {
          execFile(
            process.execPath,
            args,
            { env: ENV, timeout: 10_000 },
            (error, out) =>
              resolve([error ? Number(Reflect.get(error, 'code')) : 0, out]),
          );
        },
      );
      const root = Number(stdout);
      fixtures.add(root);
      return { code, root, descendant: await descendantOf(file) };
    }

    it.each([
      ['process.exit', 'wait', 'owned-exit', 3],
      ['an uncaught error', 'wait', 'owned-throw', 1],
      ['a natural end after root exit', 'exit 17', 'owned', 0],
    ])('rolls back an uncommitted group on %s', async (_, tail, mode, exit) => {
      const { code, root, descendant } = await host(tail, mode);
      expect(code).toBe(exit);
      dead(descendant);
      gone(root);
    });

    it.each(['commit', 'commit-exit'])(
      'leaves a committed daemon running after %s',
      async (mode) => {
        const { code, root, descendant } = await host('wait', mode);
        expect(code).toBe(mode === 'commit' ? 0 : 3);
        expect(ps(root, 'stat')).toMatch(/^S/);
        expect(present(descendant)).toBe(true);
        const stop = stops.get(descendant);
        if (!stop) throw new Error('missing fixture control');
        writeFileSync(stop, '');
        await until(() => !lingering(root) && !lingering(descendant));
      },
    );
  });
});

describe('controlled native failures', () => {
  const listeners = new Set<(code: number) => void>();
  beforeEach(() => {
    jest.useFakeTimers();
    process.listeners('exit').forEach((listener) => listeners.add(listener));
  });
  afterEach(() => {
    process.listeners('exit').forEach((listener) => {
      if (!listeners.has(listener)) process.removeListener('exit', listener);
    });
    listeners.clear();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  type ControlledNative = {
    spawn(this: void): { handle: object; pid: number };
    observe(this: void): {
      state: 'running' | 'exited' | 'lost';
      code?: number | null;
      signal?: number | null;
    };
    stopGroup(this: void): boolean;
    members(this: void): number;
    release(this: void): boolean;
    commit(this: void): boolean;
    rollbackSync(this: void): boolean;
    rollbackUndelivered(this: void): boolean;
  };
  function backend(os: Runtime.PlatformOperatingSystem = 'darwin'): {
    native: jest.Mocked<ControlledNative>;
    services: ReturnType<typeof createOwnedChildServices>;
    state(next: 'running' | 'exited' | 'lost'): void;
    dlopen: jest.SpiedFunction<typeof process.dlopen>;
  } {
    let state: 'running' | 'exited' | 'lost' = 'running';
    const native = {
      spawn: jest.fn(() => ({ handle: {}, pid: 101 })),
      observe: jest.fn(() =>
        state === 'exited' ? { state, code: 17, signal: null } : { state },
      ),
      stopGroup: jest.fn(() => {
        state = 'exited';
        return true;
      }),
      members: jest.fn(() => 0),
      release: jest.fn(() => true),
      commit: jest.fn(() => true),
      rollbackSync: jest.fn(() => true),
      rollbackUndelivered: jest.fn(() => true),
    };
    const dlopen = jest
      .spyOn(process, 'dlopen')
      .mockImplementation((module) => {
        Object.assign(module, { exports: native });
      });
    return {
      dlopen,
      native,
      services: createOwnedChildServices({
        os,
        nativePath:
          os === 'win32'
            ? 'C:\\controlled\\backend.node'
            : '/controlled/backend.node',
      }),
      state: (next: typeof state): void => {
        state = next;
      },
    };
  }

  const request = {
    executable: '/controlled/child',
    args: [],
    environment: {},
  };

  it('rejects committed exit if native reap fails instead of reporting successful exit', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    child.commit();
    b.state('exited');
    b.native.release.mockImplementation(() => {
      throw new Error('lost reservation');
    });
    const result = expect(child.exited).rejects.toMatchObject({
      code: 'unavailable',
    });
    await jest.advanceTimersByTimeAsync(20);
    await result;
    expect(b.native.stopGroup).not.toHaveBeenCalled();
  });

  it('does not signal after a lost reservation or simulated reused identity', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('lost');
    await expect(child.terminate()).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(b.native.stopGroup).not.toHaveBeenCalled();
    expect(b.native.release).not.toHaveBeenCalled();
  });

  it('keeps cleanup unconfirmed on enumeration failure and can retry the same owner', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('exited');
    b.native.release.mockImplementationOnce(() => {
      throw new Error('enumeration failed');
    });
    await expect(child.terminate()).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(b.native.stopGroup).not.toHaveBeenCalled();
    await expect(child.terminate()).resolves.toBeUndefined();
  });

  it('retries a transient native group enumeration failure within the same cleanup', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.native.release.mockImplementationOnce(() => {
      throw Object.assign(new Error('group listing changed'), {
        code: 'ERR_OWNED_CHILD_ENUMERATION',
      });
    });
    const result = child.terminate().then(
      () => null,
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(30);
    expect(await result).toBeNull();
    expect(b.native.release).toHaveBeenCalledTimes(2);
    expect(b.native.stopGroup).toHaveBeenCalledTimes(2);
    await expect(child.terminate()).resolves.toBeUndefined();
  });

  it('bounds persistent native enumeration failures without releasing ownership', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('exited');
    b.native.release.mockImplementation(() => {
      throw Object.assign(new Error('group listing unavailable'), {
        code: 'ERR_OWNED_CHILD_ENUMERATION',
      });
    });
    const result = child.terminate().then(
      () => null,
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(1_990);
    expect(b.native.release.mock.calls.length).toBeGreaterThan(1);
    expect(thrown(() => child.commit())).toEqual(typed('failed_precondition'));
    await jest.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({
      code: 'unavailable',
      message: 'Owned child cleanup did not complete.',
    });
    b.native.release.mockReturnValue(true);
    await expect(child.terminate()).resolves.toBeUndefined();
  });

  it('stops retrying enumeration if the root reservation is lost', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('exited');
    b.native.release.mockImplementationOnce(() => {
      throw Object.assign(new Error('group listing changed'), {
        code: 'ERR_OWNED_CHILD_ENUMERATION',
      });
    });
    const result = child.terminate().then(
      () => null,
      (error: unknown) => error,
    );
    b.state('lost');
    await jest.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({
      code: 'unavailable',
      message: 'Owned child ownership was lost.',
    });
    expect(b.native.release).toHaveBeenCalledTimes(1);
    expect(b.native.stopGroup).toHaveBeenCalledTimes(1);
  });

  it('keeps shared cleanup running when one caller aborts during enumeration retry', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('exited');
    b.native.release.mockImplementationOnce(() => {
      throw Object.assign(new Error('group listing changed'), {
        code: 'ERR_OWNED_CHILD_ENUMERATION',
      });
    });
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const cancelled = expect(child.terminate(controller.signal)).rejects.toBe(
      reason,
    );
    const shared = child.terminate();
    controller.abort(reason);
    await cancelled;
    expect(b.native.release).toHaveBeenCalledTimes(1);
    expect(thrown(() => child.commit())).toEqual(typed('failed_precondition'));
    await jest.advanceTimersByTimeAsync(10);
    await expect(shared).resolves.toBeUndefined();
    expect(b.native.release).toHaveBeenCalledTimes(2);
    expect(b.native.stopGroup).toHaveBeenCalledTimes(1);
  });

  it.each([
    'ERR_OWNED_CHILD_LOST',
    'ERR_OWNED_CHILD_HANDLE',
    'ERR_OWNED_CHILD_CLEANUP',
  ])('does not retry a non-enumeration release error: %s', async (code) => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('exited');
    b.native.release.mockImplementationOnce(() => {
      throw Object.assign(new Error('private native detail'), { code });
    });
    await expect(child.terminate()).rejects.toMatchObject({
      code: 'unavailable',
      message:
        code === 'ERR_OWNED_CHILD_CLEANUP'
          ? 'Owned child cleanup did not complete.'
          : 'Owned child ownership was lost.',
    });
    expect(b.native.release).toHaveBeenCalledTimes(1);
    expect(b.native.stopGroup).not.toHaveBeenCalled();
    await expect(child.terminate()).resolves.toBeUndefined();
  });

  it('reports the native cleanup deadline without releasing an unconfirmed group', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('exited');
    b.native.release.mockReturnValue(false);
    const result = expect(child.terminate()).rejects.toMatchObject({
      code: 'unavailable',
    });
    await jest.advanceTimersByTimeAsync(2_010);
    await result;
    b.native.release.mockReturnValue(true);
    await child.terminate();
  });

  it('retains undelivered native records for host-exit rollback without touching delivered children', async () => {
    const b = backend();
    b.native.spawn.mockImplementation(() => {
      throw Object.assign(new Error('private detail'), {
        code: 'ERR_OWNED_CHILD_CLEANUP',
      });
    });
    await expect(b.services.spawn(request)).rejects.toMatchObject({
      code: 'unavailable',
    });
    process
      .listeners('exit')
      .filter((listener) => !listeners.has(listener))
      .forEach((listener) => listener(0));
    expect(b.native.rollbackUndelivered).toHaveBeenCalledTimes(1);
    expect(b.native.stopGroup).not.toHaveBeenCalled();
  });

  describe('win32 backend', () => {
    const windowsRequest = {
      executable: 'C:\\controlled\\canopyd.exe',
      args: ['--data-root', 'C:\\Users\\a b\\data'],
      environment: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows' },
    };

    it('passes a fully qualified request to the native backend', async () => {
      const b = backend('win32');
      for (const executable of [
        windowsRequest.executable,
        'C:/controlled/canopyd.exe',
        '\\\\server\\share\\canopyd.exe',
      ]) {
        const child = await b.services.spawn({ ...windowsRequest, executable });
        expect(b.native.spawn).toHaveBeenLastCalledWith(
          executable,
          [executable, ...windowsRequest.args],
          ['SystemRoot=C:\\Windows', 'PATH=C:\\Windows'],
          null,
        );
        b.state('exited');
        await child.terminate();
        b.state('running');
      }
    });

    it.each<
      [
        string,
        Partial<Parameters<Runtime.PlatformOwnedChildServices['spawn']>[0]>,
      ]
    >([
      ['POSIX executable', { executable: '/controlled/canopyd' }],
      ['relative executable', { executable: 'canopyd.exe' }],
      ['drive-relative executable', { executable: 'C:canopyd.exe' }],
      ['rooted-only executable', { executable: '\\controlled\\canopyd.exe' }],
      ['device executable', { executable: '\\\\?\\C:\\canopyd.exe' }],
      ['pipe executable', { executable: '\\\\.\\pipe\\canopyd' }],
      ['startup claim on stdin', { stdin: '{"claim":null}' }],
      ['empty stdin', { stdin: '' }],
      [
        'case-duplicate environment names',
        { environment: { Path: 'C:\\a', PATH: 'C:\\b' } },
      ],
      ['malformed environment', { environment: { '=C:': 'C:\\' } }],
      ['NUL argument', { args: ['\0'] }],
    ])('rejects a %s with no native call', async (_, change) => {
      const b = backend('win32');
      const error = await rejection(() =>
        b.services.spawn({ ...windowsRequest, ...change }),
      );
      expect(error).toEqual(typed('invalid_argument'));
      expect(b.native.spawn).not.toHaveBeenCalled();
    });

    it('keeps case-distinct environment names on darwin', async () => {
      const b = backend('darwin');
      const child = await b.services.spawn({
        ...request,
        environment: { Path: '/a', PATH: '/b' },
      });
      expect(b.native.spawn).toHaveBeenLastCalledWith(
        request.executable,
        [request.executable],
        ['Path=/a', 'PATH=/b'],
        null,
      );
      b.state('exited');
      await child.terminate();
    });

    it('refuses a Windows path on darwin', async () => {
      const b = backend('darwin');
      const error = await rejection(() =>
        b.services.spawn({ ...request, executable: 'C:\\controlled\\child' }),
      );
      expect(error).toEqual(typed('invalid_argument'));
      expect(b.native.spawn).not.toHaveBeenCalled();
    });

    it('reports a backend-terminated root as SIGKILL and any other exit as its unsigned code', async () => {
      const b = backend('win32');
      const killed = await b.services.spawn(windowsRequest);
      b.native.observe.mockReturnValue({
        state: 'exited',
        code: null,
        signal: 9,
      });
      await jest.advanceTimersByTimeAsync(20);
      await expect(killed.exited).resolves.toEqual({
        code: null,
        signal: 'SIGKILL',
      });
      await killed.terminate();

      b.native.observe.mockReturnValue({
        state: 'exited',
        code: 0xc0000005,
        signal: null,
      });
      const crashed = await b.services.spawn(windowsRequest);
      await jest.advanceTimersByTimeAsync(20);
      await expect(crashed.exited).resolves.toEqual({
        code: 3221225477,
        signal: null,
      });
      await crashed.terminate();
    });

    it('keeps ownership when the job cannot be committed', async () => {
      const b = backend('win32');
      const child = await b.services.spawn(windowsRequest);
      b.native.commit.mockImplementationOnce(() => {
        throw Object.assign(new Error('private native detail'), {
          code: 'ERR_OWNED_CHILD_COMMIT',
        });
      });
      expect(thrown(() => child.commit())).toEqual(
        expect.objectContaining({
          name: 'OwnedChildError',
          code: 'failed_precondition',
          message: 'Owned child could not be committed.',
        }),
      );
      const stopped = child.terminate();
      await jest.advanceTimersByTimeAsync(20);
      await expect(stopped).resolves.toBeUndefined();
      expect(b.native.stopGroup).toHaveBeenCalledTimes(1);
    });

    it('refuses a backend missing launcher-channel exports', async () => {
      const b = backend('win32');
      const error = await rejection(() =>
        b.services.spawnWithChannel(windowsRequest),
      );
      expect(error).toEqual(typed('capability_unavailable'));
      expect(b.native.spawn).not.toHaveBeenCalled();
    });
  });

  describe('linux backend', () => {
    it('passes the request, stdin and case-distinct names to the native backend', async () => {
      const b = backend('linux');
      const child = await b.services.spawn({
        executable: '/controlled/canopyd',
        args: ['--data-root', '/home/a b/data'],
        environment: { Path: '/a', PATH: '/b' },
        stdin: '{"claim":null}',
      });
      expect(b.dlopen).toHaveBeenCalledWith(
        expect.anything(),
        '/controlled/backend.node',
      );
      expect(b.native.spawn).toHaveBeenLastCalledWith(
        '/controlled/canopyd',
        ['/controlled/canopyd', '--data-root', '/home/a b/data'],
        ['Path=/a', 'PATH=/b'],
        '{"claim":null}',
      );
      child.commit();
      expect(b.native.commit).toHaveBeenCalledTimes(1);
      expect(await rejection(() => child.terminate())).toEqual(
        typed('failed_precondition'),
      );
      expect(b.native.stopGroup).not.toHaveBeenCalled();
    });

    it('rolls an uncommitted root back through the group backend', async () => {
      const b = backend('linux');
      const child = await b.services.spawn(request);
      const stopped = child.terminate();
      await jest.advanceTimersByTimeAsync(20);
      await expect(stopped).resolves.toBeUndefined();
      expect(b.native.stopGroup).toHaveBeenCalledTimes(1);
      expect(b.native.release).toHaveBeenCalled();
      await expect(child.exited).resolves.toEqual({ code: 17, signal: null });
    });

    it.each<
      [
        string,
        Partial<Parameters<Runtime.PlatformOwnedChildServices['spawn']>[0]>,
      ]
    >([
      ['Windows executable', { executable: 'C:\\controlled\\canopyd.exe' }],
      ['relative executable', { executable: 'canopyd' }],
      ['oversized stdin', { stdin: 'x'.repeat(4097) }],
      ['malformed environment', { environment: { 'A=B': 'c' } }],
      ['NUL argument', { args: ['\0'] }],
    ])('rejects a %s with no native call', async (_, change) => {
      const b = backend('linux');
      const error = await rejection(() =>
        b.services.spawn({ ...request, ...change }),
      );
      expect(error).toEqual(typed('invalid_argument'));
      expect(b.native.spawn).not.toHaveBeenCalled();
    });

    // L1 intentionally extends the native launch contract, not admission.
    it('refuses missing channel exports without claiming ownership loss', async () => {
      const b = backend('linux');
      await expect(b.services.spawnWithChannel(request)).rejects.toMatchObject({
        code: 'capability_unavailable',
      });
      expect(b.dlopen).toHaveBeenCalledTimes(1);
      expect(b.native.spawn).not.toHaveBeenCalled();
    });

    it('uses the Linux channel export without falling back to ordinary spawn', async () => {
      const b = backend('linux');
      const spawnChannel = jest.fn(() => ({ handle: {}, pid: 101 }));
      const channelClose = jest.fn();
      Object.assign(b.native, {
        spawnChannel,
        channelRead: jest.fn(),
        channelWrite: jest.fn(),
        channelPeer: jest.fn(),
        channelClose,
      });
      const { channel, child } = await b.services.spawnWithChannel(request);
      expect(spawnChannel).toHaveBeenCalledWith(
        '/controlled/child',
        ['/controlled/child'],
        [],
        null,
      );
      expect(b.native.spawn).not.toHaveBeenCalled();
      channel.close();
      expect(channelClose).toHaveBeenCalledTimes(1);
      const stopped = child.terminate();
      await jest.advanceTimersByTimeAsync(20);
      await stopped;
    });

    it('reports unavailable stale-sender pidfd facilities accurately with no fallback', async () => {
      const b = backend('linux');
      Object.assign(b.native, {
        spawnChannel: jest.fn(() => {
          throw Object.assign(new Error('private kernel details'), {
            code: 'ERR_OWNED_CHILD_CHANNEL_UNSUPPORTED',
          });
        }),
        channelRead: jest.fn(),
        channelWrite: jest.fn(),
        channelPeer: jest.fn(),
        channelClose: jest.fn(),
      });
      await expect(b.services.spawnWithChannel(request)).rejects.toMatchObject({
        code: 'capability_unavailable',
        message:
          'Linux launcher channels require stale-sender pidfds and pidfs.',
      });
      expect(b.native.spawn).not.toHaveBeenCalled();
    });
  });
});

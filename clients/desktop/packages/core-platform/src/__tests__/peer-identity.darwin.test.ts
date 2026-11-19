import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, connect, type Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as peerIdentity from '../peer-identity';
import {
  createPeerIdentityServices,
  type DaemonIdentity,
  daemonRequirement,
  type DaemonRequirement,
  launcherRequirement,
  type LauncherRequirement,
  peerEvidenceFor,
  PeerIdentityError,
} from '../peer-identity';
import {
  channelPeer,
  createOwnedChildServices,
  type OwnedChildChannel,
  type OwnedChildLaunch,
} from '../supervision/owned-child';

const darwin = process.platform === 'darwin';
const darwinDescribe = darwin ? describe : describe.skip;
const ROOT = path.resolve(__dirname, '../../../..');
const MODULE = path.resolve(__dirname, '../peer-identity/index.ts');
const ENV = { PATH: '/usr/bin:/bin' };
// Node's own release signature: the jest worker and its node children.
const NODE_TEAM = 'HX7739G8FX';

let dir = '';
let ownedAddon = '';
let peerAddon = '';
let nodeCdhash = '';
let register = '';
let fixture = '';
let fdinfo = '';
const launches = new Set<OwnedChildLaunch>();
const servers = new Set<Server>();
const sockets = new Set<Socket>();
const cleanups = new Set<() => void>();

/** The CDHash codesign reports (on stderr), or '' when the file is not signed. */
function cdhash(file: string): string {
  const { stdout, stderr } = spawnSync('/usr/bin/codesign', ['-dvvv', file], {
    encoding: 'utf8',
  });
  return /CDHash=([0-9a-f]{40})/.exec(`${stdout}${stderr}`)?.[1] ?? '';
}

// Node children import the TypeScript adapter directly; `resolve` handles its
// extensionless relative imports. `load` is the only test seam: no test
// runtime has a signed `CanopyBuildId`, so it appends, in these children only,
// a builder that issues a launcher requirement through the module's own
// validated private builder, bound to a cdhash instead. Production source
// has no such export; a rename of either private builder fails these tests.
const HOOKS = `
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (!specifier.startsWith('.')) throw error;
    return next(specifier + '.ts', context);
  }
}
export async function load(url, context, next) {
  const loaded = await next(url, context);
  if (!url.endsWith('/peer-identity/index.ts')) return loaded;
  const seam = 'export function launcherRequirementForTests({ team, identifier, cdhash }) {' +
    " return requirement('launcher', team, identifier, cdhashBinding(cdhash)); }";
  return { ...loaded, source: String(loaded.source) + '\\n' + seam + '\\n' };
}`;

// The daemon side. stdout is /dev/null under owned-child; results go back
// over the channel, or to a file when there is none.
const FIXTURE = `
import { writeFileSync } from 'node:fs';
const [, , modulePath, nativePath, mode, arg] = process.argv;
const peer = await import(modulePath);
const services = peer.createPeerIdentityServices({ os: 'darwin', nativePath });
const encode = (value) => new TextEncoder().encode(JSON.stringify(value) + '\\n');
const code = (run) => { try { run(); return 'allowed'; } catch (error) { return error.code; } };
async function line(channel) {
  let text = '';
  while (!text.includes('\\n')) {
    const bytes = await channel.read();
    if (bytes === null) return null;
    text += Buffer.from(bytes).toString();
  }
  return text.trim();
}
// A spec with a cdhash stands in for the signed build id, through the seam
// the loader hooks add.
const launcher = (spec) =>
  spec.cdhash ? peer.launcherRequirementForTests(spec) : peer.launcherRequirement(spec);
if (mode === 'genuine') {
  const claim = services.claimLauncherChannel();
  if (!claim.ok) process.exit(20);
  const second = code(() => services.claimLauncherChannel());
  const { channel } = claim;
  const spec = JSON.parse(arg);
  const early = services.captureLauncherEvidence(channel, launcher(spec));
  await channel.write(encode('hello'));
  await line(channel);
  // The early attempt spent this channel's one capture.
  const spent = code(() => services.captureLauncherEvidence(channel, launcher(spec)));
  await channel.write(encode({ early, second, spent }));
  await line(channel);
  process.exit(0);
}
if (mode === 'evidence') {
  const claim = services.claimLauncherChannel();
  if (!claim.ok) process.exit(20);
  const { channel } = claim;
  await channel.write(encode('hello'));
  await line(channel);
  const spec = JSON.parse(arg);
  const required = launcher(spec);
  // The same binding built for the other role, a copy of the right one, and
  // this channel given to the other role's capture: all refused before the
  // capture below, without spending it.
  const daemonSide = peer.daemonRequirement({
    team: spec.team,
    identifier: spec.identifier,
    build: { kind: 'cdhash', cdhash: spec.cdhash ?? '0'.repeat(40) },
  });
  const wrongRole = code(() => services.captureLauncherEvidence(channel, daemonSide));
  const forged = code(() => services.captureLauncherEvidence(channel, { ...required }));
  const crossed = code(() => services.captureDaemonEvidence(channel, daemonSide));
  const result = services.captureLauncherEvidence(channel, required);
  const held = peer.peerEvidenceFor(channel) ?? null;
  await channel.write(encode({ wrongRole, forged, crossed, result, held, ppid: process.ppid }));
  await line(channel);
  process.exit(0);
}
if (mode === 'report') {
  // Waits to be orphaned when asked, so the parent check sees launchd.
  if (process.argv[6] === 'orphan') {
    const deadline = Date.now() + 5000;
    while (process.ppid !== 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  }
  const claim = services.claimLauncherChannel();
  writeFileSync(arg, JSON.stringify(claim.ok ? { ok: true } : claim));
  process.exit(0);
}
if (mode === 'detached') {
  // Captures once the launcher sends a line or closes; the result goes to a
  // file because the channel may be gone by then.
  const claim = services.claimLauncherChannel();
  if (!claim.ok) process.exit(20);
  const { channel } = claim;
  await channel.write(encode('hello'));
  const sent = await line(channel);
  const result = services.captureLauncherEvidence(channel, peer.launcherRequirement(JSON.parse(process.argv[6])));
  writeFileSync(arg, JSON.stringify({ sent, result, ppid: process.ppid }));
  process.exit(0);
}
if (mode === 'inventory') {
  const claim = services.claimLauncherChannel();
  if (!claim.ok) process.exit(20);
  await claim.channel.write(encode('claimed'));
  await line(claim.channel);
  process.exit(0);
}
if (mode === 'coholder') {
  // Never touches fd 3 itself: a grandchild holding it writes the frame.
  const { spawn } = await import('node:child_process');
  spawn('/bin/sh', ['-c', 'printf "hello\\\\n" >&3; read x <&3'], { stdio: ['ignore', 'ignore', 'ignore', 3] });
  setInterval(() => undefined, 1000);
}
`;

// Reports whether another process's descriptor is close-on-exec.
const FDINFO = `#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>
int main(int argc, char **argv) {
  struct socket_fdinfo info;
  if (argc != 3) return 64;
  int n = proc_pidfdinfo(atoi(argv[1]), atoi(argv[2]), PROC_PIDFDSOCKETINFO, &info, sizeof info);
  puts(n != (int)sizeof info ? "none" : (info.pfi.fi_status & PROC_FP_CLEXEC) ? "cloexec" : "inherit");
  return 0;
}
`;

const owned = (): ReturnType<typeof createOwnedChildServices> =>
  createOwnedChildServices({ os: 'darwin', nativePath: ownedAddon });
const peers = (): ReturnType<typeof createPeerIdentityServices> =>
  createPeerIdentityServices({ os: 'darwin', nativePath: peerAddon });

function nodeArgs(mode: string, arg = '', ...rest: string[]): string[] {
  return [
    '--import',
    pathToFileURL(register).href,
    fixture,
    pathToFileURL(MODULE).href,
    peerAddon,
    mode,
    arg,
    ...rest,
  ];
}

async function launch(
  executable: string,
  args: readonly string[],
): Promise<OwnedChildLaunch> {
  const launched = await owned().spawnWithChannel({
    executable,
    args,
    environment: ENV,
  });
  launches.add(launched);
  return launched;
}

const launchNode = (mode: string, arg = ''): Promise<OwnedChildLaunch> =>
  launch(process.execPath, nodeArgs(mode, arg));

/** Reads one newline-terminated frame; null at end of stream. */
async function frame(channel: OwnedChildChannel): Promise<string | null> {
  let text = '';
  const signal = AbortSignal.timeout(10_000);
  while (!text.includes('\n')) {
    const bytes = await channel.read(signal);
    if (bytes === null) return text === '' ? null : text;
    text += Buffer.from(bytes).toString();
  }
  return text.trim();
}

const send = (channel: OwnedChildChannel, value: unknown): Promise<void> =>
  channel.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));

const nodeIdentity = (hash = nodeCdhash): DaemonIdentity => ({
  team: NODE_TEAM,
  identifier: 'node',
  build: { kind: 'cdhash', cdhash: hash },
});

const nodeRequirement = (): DaemonRequirement =>
  daemonRequirement(nodeIdentity());

/** Node as a launcher: its cdhash stands in for the signed build id. */
const nodeLauncher = (): {
  team: string;
  identifier: string;
  cdhash: string;
} => ({ team: NODE_TEAM, identifier: 'node', cdhash: nodeCdhash });

/** A production launcher requirement; no test runtime can satisfy it. */
const buildLauncherRequirement = (): LauncherRequirement =>
  launcherRequirement({ team: NODE_TEAM, identifier: 'node', buildId: 'b1' });

// `expect.any` is typed `any`; matchers are held as `unknown`.
const anyNumber: unknown = expect.any(Number);

const typed = (code: string): unknown =>
  expect.objectContaining({ name: 'PeerIdentityError', code });

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

/** Spawns node with fd 3 from `stdio3`; returns what its claim reported. */
async function report(
  stdio3: 'pipe' | number | Socket | null,
  orphan = false,
): Promise<unknown> {
  const out = path.join(dir, `report-${Date.now()}-${Math.random()}`);
  const args = nodeArgs('report', out, orphan ? 'orphan' : 'direct');
  const child = orphan
    ? // The shell exits at once; its node child is reparented to launchd.
      spawn(
        '/bin/sh',
        ['-c', '"$0" "$@" & exit 0', process.execPath, ...args],
        {
          stdio: ['ignore', 'ignore', 'ignore', stdio3 ?? 'ignore'],
          env: ENV,
        },
      )
    : spawn(process.execPath, args, {
        stdio:
          stdio3 === null
            ? ['ignore', 'ignore', 'ignore']
            : ['ignore', 'ignore', 'ignore', stdio3],
        env: ENV,
      });
  await new Promise((resolve) => child.on('exit', resolve));
  const deadline = Date.now() + 10_000;
  while (!existsSync(out)) {
    if (Date.now() > deadline) throw new Error('no report');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  return JSON.parse(readFileSync(out, 'utf8'));
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'peer-identity-'));
  if (!darwin) return;
  ownedAddon = path.join(dir, 'core-owned-child.node');
  peerAddon = path.join(dir, 'core-peer-identity.node');
  const build = (script: string, out: string): void => {
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', script), '--out', out],
      { stdio: 'pipe' },
    );
  };
  build('build-owned-child.mjs', ownedAddon);
  build('build-peer-identity.mjs', peerAddon);
  nodeCdhash = cdhash(process.execPath);
  register = path.join(dir, 'register.mjs');
  writeFileSync(path.join(dir, 'hooks.mjs'), HOOKS);
  writeFileSync(
    register,
    "import { register } from 'node:module';\nregister('./hooks.mjs', import.meta.url);\n",
  );
  fixture = path.join(dir, 'daemon.mjs');
  writeFileSync(fixture, FIXTURE);
  fdinfo = path.join(dir, 'fdinfo');
  writeFileSync(`${fdinfo}.c`, FDINFO);
  execFileSync('/usr/bin/clang', ['-o', fdinfo, `${fdinfo}.c`], {
    stdio: 'pipe',
  });
}, 120_000);

afterEach(async () => {
  for (const { child, channel } of Array.from(launches)) {
    channel.close();
    await child.terminate().catch(() => undefined);
  }
  launches.clear();
  sockets.forEach((socket) => socket.destroy());
  sockets.clear();
  servers.forEach((server) => server.close());
  servers.clear();
  cleanups.forEach((cleanup) => cleanup());
  cleanups.clear();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('requirements', () => {
  it('builds the launcher and daemon requirements from validated parts', () => {
    expect(
      launcherRequirement({
        team: 'ABCDE12345',
        identifier: 'com.example.app',
        buildId: 'build-1.2_3',
      }).text,
    ).toBe(
      'anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345" and identifier "com.example.app" and info[CanopyBuildId] = "build-1.2_3"',
    );
    expect(
      daemonRequirement({
        team: 'ABCDE12345',
        identifier: 'com.example.app.daemon',
        build: { kind: 'entitlement', key: 'com.example.build', value: 'b1' },
      }).text,
    ).toBe(
      'anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345" and identifier "com.example.app.daemon" and entitlement["com.example.build"] = "b1"',
    );
    expect(
      daemonRequirement({
        team: 'ABCDE12345',
        identifier: 'd',
        build: { kind: 'cdhash', cdhash: 'AB'.repeat(20) },
      }).text,
    ).toMatch(/ and cdhash H"(ab){20}"$/);
  });

  it('builds each requirement for one role only', () => {
    const team = 'ABCDE12345';
    const launcher = launcherRequirement({
      team,
      identifier: 'a',
      buildId: 'b',
    });
    const daemon = daemonRequirement({
      team,
      identifier: 'd',
      build: { kind: 'cdhash', cdhash: 'ab'.repeat(20) },
    });
    expect([launcher.role, daemon.role]).toEqual(['launcher', 'daemon']);
    // @ts-expect-error a daemon requirement is not a launcher requirement
    const asLauncher: LauncherRequirement = daemon;
    // @ts-expect-error a launcher requirement is not a daemon requirement
    const asDaemon: DaemonRequirement = launcher;
    expect([asLauncher, asDaemon]).toEqual([daemon, launcher]);
    // @ts-expect-error only this module can write a requirement
    const literal: DaemonRequirement = { role: 'daemon', text: daemon.text };
    expect(literal.text).toBe(daemon.text);
    expect([Object.isFrozen(launcher), Object.isFrozen(daemon)]).toEqual([
      true,
      true,
    ]);
  });

  it.each([
    ['a lowercase team', { team: 'abcde12345' }],
    ['a short team', { team: 'ABC' }],
    ['a quoted identifier', { identifier: 'a" or identifier "b' }],
    ['an empty identifier', { identifier: '' }],
    ['a quoted build id', { buildId: 'x" or anchor apple "' }],
    ['an empty build id', { buildId: '' }],
  ])('rejects %s', (_, change) => {
    const identity = {
      team: 'ABCDE12345',
      identifier: 'com.example.app',
      buildId: 'b1',
      ...change,
    };
    expect(thrown(() => launcherRequirement(identity))).toEqual(
      typed('invalid_argument'),
    );
  });

  it.each([
    ['a short cdhash', { kind: 'cdhash', cdhash: 'ab' }],
    [
      'a quoted entitlement key',
      { kind: 'entitlement', key: 'a"]', value: 'b' },
    ],
    [
      'a spaced entitlement value',
      { kind: 'entitlement', key: 'a', value: 'b c' },
    ],
  ] as const)('rejects a daemon build binding with %s', (_, build) => {
    expect(
      thrown(() =>
        daemonRequirement({ team: 'ABCDE12345', identifier: 'd', build }),
      ),
    ).toEqual(typed('invalid_argument'));
  });
});

describe('host and addon boundaries', () => {
  it.each(['linux', 'win32'] as const)(
    'keeps Darwin peer-identity claims unavailable on %s without loading',
    (os) => {
      const dlopen = jest.spyOn(process, 'dlopen');
      try {
        const services = createPeerIdentityServices({
          os,
          nativePath: '/missing.node',
        });
        expect(thrown(() => services.claimLauncherChannel())).toEqual(
          typed('capability_unavailable'),
        );
        expect(dlopen).not.toHaveBeenCalled();
      } finally {
        dlopen.mockRestore();
      }
    },
  );

  it('validates Linux channel executables before loading without granting Darwin claims', async () => {
    const dlopen = jest.spyOn(process, 'dlopen');
    try {
      await expect(
        createOwnedChildServices({
          os: 'linux',
          nativePath: '/missing.node',
        }).spawnWithChannel({
          executable: 'relative',
          args: [],
          environment: {},
        }),
      ).rejects.toMatchObject({ code: 'invalid_argument' });
      expect(dlopen).not.toHaveBeenCalled();
    } finally {
      dlopen.mockRestore();
    }
  });

  it('validates Windows channel executables as drive/UNC paths before loading, without granting Darwin claims', async () => {
    const dlopen = jest.spyOn(process, 'dlopen');
    try {
      await expect(
        createOwnedChildServices({
          os: 'win32',
          nativePath: 'C:\\missing.node',
        }).spawnWithChannel({
          executable: '/bin/true',
          args: [],
          environment: {},
        }),
      ).rejects.toMatchObject({ code: 'invalid_argument' });
      expect(dlopen).not.toHaveBeenCalled();
    } finally {
      dlopen.mockRestore();
    }
  });

  it.each([
    ['missing', '/nonexistent/core-peer-identity.node'],
    ['relative', 'core-peer-identity.node'],
    ['not an addon', '/bin/sh'],
  ])('refuses a %s addon', (_, nativePath) => {
    const services = createPeerIdentityServices({ os: 'darwin', nativePath });
    expect(thrown(() => services.claimLauncherChannel())).toBeInstanceOf(
      PeerIdentityError,
    );
    expect(thrown(() => services.claimLauncherChannel())).toEqual(
      typed('capability_unavailable'),
    );
  });

  it('keeps plain spawn on an owned-child addon without channel calls', async () => {
    const native = {
      spawn: jest.fn(() => ({ handle: {}, pid: 101 })),
      observe: jest.fn(() => ({ state: 'exited', code: 0, signal: null })),
      stopGroup: jest.fn(() => true),
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
    try {
      const services = createOwnedChildServices({
        os: 'darwin',
        nativePath: '/controlled/backend.node',
      });
      const request = {
        executable: '/controlled/child',
        args: [],
        environment: {},
      };
      await expect(services.spawnWithChannel(request)).rejects.toMatchObject({
        code: 'capability_unavailable',
      });
      const child = await services.spawn(request);
      await child.terminate();
      expect(native.spawn).toHaveBeenCalledTimes(1);
    } finally {
      dlopen.mockRestore();
    }
  });
});

darwinDescribe('darwin launcher channel', () => {
  it('found a signed node to act as both peers', () => {
    expect(nodeCdhash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('accepts both genuine peers after each first frame', async () => {
    const { child, channel } = await launchNode(
      'evidence',
      JSON.stringify(nodeLauncher()),
    );
    expect(await frame(channel)).toBe('"hello"');
    const services = peers();
    // An untyped caller reaches the runtime check: a typed refusal, not the
    // `requirement_unsatisfied` result this text would earn, and it spends
    // nothing.
    const wrongRole = (): unknown =>
      services.captureDaemonEvidence(
        channel,
        // @ts-expect-error a launcher requirement cannot check the daemon
        buildLauncherRequirement(),
      );
    expect(thrown(wrongRole)).toEqual(typed('invalid_argument'));
    const captured = services.captureDaemonEvidence(channel, nodeRequirement());
    expect(captured).toEqual({
      ok: true,
      evidence: {
        role: 'daemon',
        pid: child.pid,
        pidversion: anyNumber,
      },
    });
    expect(peerEvidenceFor(channel)).toEqual(
      captured.ok ? captured.evidence : undefined,
    );
    await send(channel, 'launcher');
    const reply: unknown = JSON.parse((await frame(channel)) ?? 'null');
    const result: unknown = Reflect.get(Object(reply), 'result');
    const held: unknown = Reflect.get(Object(result), 'evidence');
    expect(reply).toEqual({
      wrongRole: 'invalid_argument',
      forged: 'invalid_argument',
      crossed: 'invalid_argument',
      result: {
        ok: true,
        evidence: { role: 'launcher', pid: process.pid, pidversion: anyNumber },
      },
      held,
      ppid: process.pid,
    });
    // There is no recheck: the one capture stands.
    expect(
      thrown(() => peers().captureDaemonEvidence(channel, nodeRequirement())),
    ).toEqual(typed('failed_precondition'));
  }, 20_000);

  it('refuses captures before the first frame and spends the attempt', async () => {
    const { channel } = await launchNode(
      'genuine',
      JSON.stringify(nodeLauncher()),
    );
    const services = peers();
    expect(services.captureDaemonEvidence(channel, nodeRequirement())).toEqual({
      ok: false,
      reason: 'no_frame',
    });
    expect(peerEvidenceFor(channel)).toBeUndefined();
    expect(await frame(channel)).toBe('"hello"');
    expect(
      thrown(() => services.captureDaemonEvidence(channel, nodeRequirement())),
    ).toEqual(typed('failed_precondition'));
    await send(channel, 'go');
    expect(JSON.parse((await frame(channel)) ?? 'null')).toEqual({
      early: { ok: false, reason: 'no_frame' },
      second: 'failed_precondition',
      spent: 'failed_precondition',
    });
  }, 20_000);

  it.each([
    ['another build', (): DaemonIdentity => nodeIdentity('0'.repeat(40))],
    [
      'another team',
      (): DaemonIdentity => ({ ...nodeIdentity(), team: 'ABCDE12345' }),
    ],
    [
      'another identifier',
      (): DaemonIdentity => ({ ...nodeIdentity(), identifier: 'nodex' }),
    ],
  ])(
    'refuses a daemon of %s',
    async (_, identity) => {
      const { channel } = await launchNode(
        'evidence',
        JSON.stringify(nodeLauncher()),
      );
      expect(await frame(channel)).toBe('"hello"');
      expect(
        peers().captureDaemonEvidence(channel, daemonRequirement(identity())),
      ).toEqual({ ok: false, reason: 'requirement_unsatisfied' });
      expect(peerEvidenceFor(channel)).toBeUndefined();
    },
    20_000,
  );

  it('refuses a launcher without the signed build id', async () => {
    const identity = { team: NODE_TEAM, identifier: 'node', buildId: 'b1' };
    const { channel } = await launchNode('evidence', JSON.stringify(identity));
    expect(await frame(channel)).toBe('"hello"');
    await send(channel, 'launcher');
    expect(JSON.parse((await frame(channel)) ?? 'null')).toEqual({
      wrongRole: 'invalid_argument',
      forged: 'invalid_argument',
      crossed: 'invalid_argument',
      result: { ok: false, reason: 'requirement_unsatisfied' },
      held: null,
      ppid: process.pid,
    });
  }, 20_000);

  it('refuses an exec-self after spawn by its pidversion', async () => {
    const { channel } = await launch('/bin/sh', [
      '-c',
      `exec /bin/sh -c 'printf "hello\\n" >&3; read x <&3'`,
    ]);
    expect(await frame(channel)).toBe('hello');
    // Same pid: only the pidversion tells the images apart.
    expect(peers().captureDaemonEvidence(channel, nodeRequirement())).toEqual({
      ok: false,
      reason: 'pidversion_changed',
    });
  }, 20_000);

  it('refuses an exec made as soon as the child runs', async () => {
    // Without a suspended start, an exec this early can precede the spawn-time
    // pidversion read (about 1 in 500 spawns), or race it and fail the spawn.
    const source = path.join(dir, 'execer.c');
    const execer = path.join(dir, 'execer');
    writeFileSync(
      source,
      `#include <unistd.h>
int main(void) { execl("/bin/sh", "sh", "-c", "printf 'hi\\\\n' >&3; read x <&3", (char *)0); return 1; }
`,
    );
    execFileSync('/usr/bin/clang', ['-O2', '-o', execer, source], {
      stdio: 'pipe',
    });
    const services = owned();
    const reasons = new Map<string, number>();
    for (let n = 0; n < 300; n++) {
      const { child, channel } = await services.spawnWithChannel({
        executable: execer,
        args: [],
        environment: ENV,
      });
      try {
        expect(await frame(channel)).toBe('hi');
        const peer = channelPeer(channel);
        const reason = peer.state === 'refused' ? peer.reason : 'accepted';
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      } finally {
        channel.close();
        await child.terminate();
      }
    }
    expect(Object.fromEntries(reasons)).toEqual({ pidversion_changed: 300 });
  }, 120_000);

  it('hands fd 3 over inheritable, and the claim leaves it CLOEXEC', async () => {
    const flag = (pid: number): string =>
      execFileSync(fdinfo, [String(pid), '3'], { encoding: 'utf8' }).trim();
    // adddup2 clears CLOEXEC on fd 3, so the daemon must set it again.
    const shell = await launch('/bin/sh', [
      '-c',
      'printf "x\\n" >&3; read y <&3',
    ]);
    expect(await frame(shell.channel)).toBe('x');
    expect(flag(shell.child.pid)).toBe('inherit');
    // Node also marks inherited descriptors at startup; the claim does not
    // rely on that, but it means this cannot isolate the claim's own fcntl.
    const daemon = await launchNode('inventory');
    expect(await frame(daemon.channel)).toBe('"claimed"');
    expect(flag(daemon.child.pid)).toBe('cloexec');
  }, 20_000);

  it('refuses a frame written by a co-holder of fd 3', async () => {
    const { channel } = await launchNode('coholder');
    expect(await frame(channel)).toBe('hello');
    expect(peers().captureDaemonEvidence(channel, nodeRequirement())).toEqual({
      ok: false,
      reason: 'pid_mismatch',
    });
  }, 20_000);

  it('refuses an exited peer and a closed channel', async () => {
    const exited = await launch('/bin/sh', ['-c', 'printf "hi\\n" >&3']);
    expect(await frame(exited.channel)).toBe('hi');
    await exited.child.exited;
    expect(channelPeer(exited.channel)).toEqual({
      state: 'refused',
      reason: 'not_running',
    });

    const closed = await launch('/bin/sh', [
      '-c',
      'printf "hi\\n" >&3; exec 3>&-; /bin/sleep 30',
    ]);
    expect(await frame(closed.channel)).toBe('hi');
    expect(await closed.channel.read()).toBeNull();
    expect(channelPeer(closed.channel)).toEqual({
      state: 'refused',
      reason: 'not_connected',
    });

    const local = await launch('/bin/sh', [
      '-c',
      'printf "hi\\n" >&3; /bin/sleep 30',
    ]);
    expect(await frame(local.channel)).toBe('hi');
    local.channel.close();
    expect(
      peers().captureDaemonEvidence(local.channel, nodeRequirement()),
    ).toEqual({ ok: false, reason: 'not_connected' });
    await expect(local.channel.read()).rejects.toMatchObject({
      code: 'unavailable',
    });

    // Reaping the root closes its channel.
    await local.child.terminate();
    expect(channelPeer(local.channel)).toEqual({
      state: 'refused',
      reason: 'not_running',
    });
  }, 20_000);

  it('refuses channels this process did not spawn', () => {
    const services = peers();
    const stranger: OwnedChildChannel = {
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
      close: () => undefined,
    };
    expect(
      thrown(() => services.captureDaemonEvidence(stranger, nodeRequirement())),
    ).toEqual(typed('invalid_argument'));
    expect(
      thrown(() =>
        services.captureLauncherEvidence(stranger, buildLauncherRequirement()),
      ),
    ).toEqual(typed('invalid_argument'));
  });

  it('refuses requirements it did not build', async () => {
    const { channel } = await launchNode(
      'evidence',
      JSON.stringify(nodeLauncher()),
    );
    expect(await frame(channel)).toBe('"hello"');
    const issued = nodeRequirement();
    const forgeries: unknown[] = [
      { role: 'daemon', text: issued.text },
      { ...issued },
      Object.create(issued),
      new Proxy(issued, {}),
      new Proxy(issued, {
        getOwnPropertyDescriptor: (): never => {
          throw new Error('read');
        },
      }),
    ];
    for (const forged of forgeries)
      expect(
        thrown(() =>
          peers().captureDaemonEvidence(
            channel,
            // @ts-expect-error only this module can write a requirement
            forged,
          ),
        ),
      ).toEqual(typed('invalid_argument'));
    // The refusal did not spend the channel's one capture.
    expect(
      peers().captureDaemonEvidence(channel, nodeRequirement()),
    ).toMatchObject({ ok: true });
  }, 20_000);

  it('exposes bytes only: no descriptor, handle, or token on a channel', async () => {
    const { channel } = await launch('/bin/sh', ['-c', 'read x <&3']);
    expect(Object.isFrozen(channel)).toBe(true);
    expect(Reflect.ownKeys(channel).sort()).toEqual(['close', 'read', 'write']);
  });

  it('moves frames larger than one native call both ways', async () => {
    const { channel } = await launch('/bin/sh', ['-c', '/bin/cat <&3 >&3']);
    const payload = new Uint8Array(200_000).map((_, n) => n % 251);
    const writing = channel.write(payload);
    const received: number[] = [];
    while (received.length < payload.length) {
      const bytes = await channel.read(AbortSignal.timeout(10_000));
      if (bytes === null) break;
      received.push(...bytes);
    }
    await writing;
    expect(Buffer.from(received).equals(Buffer.from(payload))).toBe(true);
    // Concurrent reads are refused rather than interleaved.
    const pending = channel.read();
    await expect(channel.read()).rejects.toMatchObject({
      code: 'failed_precondition',
    });
    channel.close();
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
  }, 20_000);

  it('validates native channel arguments', () => {
    const module = { exports: {} };
    process.dlopen(module, ownedAddon);
    const native = module.exports;
    const fn = (name: string): ((...args: unknown[]) => unknown) => {
      const value: unknown = Reflect.get(native, name);
      if (typeof value !== 'function') throw new Error(`no ${name}`);
      return (...args): unknown => {
        const result: unknown = Reflect.apply(value, native, args);
        return result;
      };
    };
    const code = (run: () => unknown): unknown => {
      try {
        return run();
      } catch (error) {
        return Reflect.get(Object(error), 'code');
      }
    };
    const plain = fn('spawn')('/bin/sleep', ['/bin/sleep', '30'], [], null);
    const handle: unknown = Reflect.get(Object(plain), 'handle');
    try {
      // A plain spawn has no channel.
      expect(code(() => fn('channelRead')(handle, 16))).toBe(
        'ERR_OWNED_CHILD_CHANNEL',
      );
      expect(code(() => fn('channelPeer')(handle))).toBe(
        'ERR_OWNED_CHILD_CHANNEL',
      );
      expect(code(() => fn('channelRead')({}, 16))).toBe(
        'ERR_OWNED_CHILD_HANDLE',
      );
    } finally {
      fn('rollbackSync')(handle);
    }
    const spawned = fn('spawnChannel')(
      '/bin/sh',
      ['/bin/sh', '-c', 'read x <&3'],
      [],
      null,
    );
    const channelHandle: unknown = Reflect.get(Object(spawned), 'handle');
    try {
      expect(code(() => fn('channelWrite')(channelHandle, 'text'))).toBe(
        'ERR_OWNED_CHILD_ARGUMENT',
      );
      expect(
        code(() => fn('channelWrite')(channelHandle, new Uint16Array(2))),
      ).toBe('ERR_OWNED_CHILD_ARGUMENT');
      expect(code(() => fn('channelRead')(channelHandle, 0))).toBe(
        'ERR_OWNED_CHILD_ARGUMENT',
      );
      expect(code(() => fn('channelRead')(channelHandle, 65_537))).toBe(
        'ERR_OWNED_CHILD_ARGUMENT',
      );
      expect(fn('channelRead')(channelHandle, 16)).toEqual(Buffer.alloc(0));
      expect(fn('channelPeer')(channelHandle)).toEqual({
        state: 'refused',
        reason: 'no_frame',
      });
    } finally {
      fn('rollbackSync')(channelHandle);
    }
  });

  describe('daemon claim', () => {
    it('refuses a missing or non-socket fd 3', async () => {
      const file = path.join(dir, 'not-a-socket');
      writeFileSync(file, '');
      const fd = openSync(file, 'r');
      try {
        expect(await report(fd)).toEqual({
          ok: false,
          reason: 'wrong_channel_type',
        });
      } finally {
        closeSync(fd);
      }
      // Without an inherited fd 3, Node may already use it: either way refused.
      const oneOf: unknown = expect.stringMatching(
        /^(no_channel|wrong_channel_type)$/,
      );
      const none = await report(null);
      expect(none).toMatchObject({
        ok: false,
        reason: oneOf,
      });
    }, 30_000);

    it('accepts any socketpair end but refuses a client of a named endpoint', async () => {
      expect(await report('pipe')).toEqual({ ok: true });
      // Unix socket paths are limited to 104 bytes.
      const short = mkdtempSync('/tmp/pi-');
      cleanups.add(() => rmSync(short, { recursive: true, force: true }));
      const socketPath = path.join(short, 'endpoint.sock');
      const server = createServer((peer) => sockets.add(peer));
      servers.add(server);
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const client = connect(socketPath);
      sockets.add(client);
      await new Promise<void>((resolve) => client.on('connect', resolve));
      expect(await report(client)).toEqual({
        ok: false,
        reason: 'wrong_channel_type',
      });
    }, 30_000);

    it('refuses a channel whose launcher is gone', async () => {
      expect(await report('pipe', true)).toEqual({
        ok: false,
        reason: 'reparented',
      });
    }, 30_000);
  });

  describe('daemon capture', () => {
    // A launcher that is not this process: it spawns the daemon on a
    // socketpair, waits for its first frame, and (`exec`) may then exec
    // itself, keeping its end, before sending its own frame.
    const LAUNCHER = `#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
static int line(int fd, char *buf, size_t size) {
  size_t n = 0;
  while (n + 1 < size) {
    if (read(fd, buf + n, 1) != 1) return -1;
    if (buf[n++] == '\\n') break;
  }
  buf[n] = 0;
  return 0;
}
static int converse(int fd, const char *out, pid_t daemon) {
  char buf[4096];
  if (write(fd, "\\"launcher\\"\\n", 11) != 11 || line(fd, buf, sizeof buf)) return 65;
  FILE *file = fopen(out, "w");
  if (!file || fputs(buf, file) < 0 || fclose(file)) return 66;
  if (write(fd, "\\"bye\\"\\n", 6) != 6) return 67;
  int status;
  waitpid(daemon, &status, 0);
  return 0;
}
int main(int argc, char **argv) {
  if (argc == 5 && !strcmp(argv[1], "after"))
    return converse(atoi(argv[2]), argv[3], (pid_t)atoi(argv[4]));
  if (argc < 4) return 64;
  int sv[2];
  char buf[4096], fd[16], pid[16];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) || fcntl(sv[0], F_SETFD, FD_CLOEXEC) ||
      fcntl(sv[1], F_SETFD, FD_CLOEXEC)) return 68;
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, sv[1], 3);
  pid_t daemon;
  if (posix_spawn(&daemon, argv[3], &actions, NULL, argv + 3, environ)) return 69;
  close(sv[1]);
  if (line(sv[0], buf, sizeof buf)) return 70;
  if (strcmp(argv[1], "exec")) return converse(sv[0], argv[2], daemon);
  snprintf(fd, sizeof fd, "%d", sv[0]);
  snprintf(pid, sizeof pid, "%d", daemon);
  fcntl(sv[0], F_SETFD, 0);
  execl(argv[0], argv[0], "after", fd, argv[2], pid, (char *)0);
  return 71;
}
`;
    let launcher = '';

    beforeAll(() => {
      const source = path.join(dir, 'launcher.c');
      launcher = path.join(dir, 'launcher');
      writeFileSync(source, LAUNCHER);
      execFileSync('/usr/bin/clang', ['-o', launcher, source], {
        stdio: 'pipe',
      });
    }, 60_000);

    const identity = JSON.stringify({
      team: NODE_TEAM,
      identifier: 'launcher',
      buildId: 'b1',
    });

    /** Runs the C launcher over the `evidence` daemon; returns its reply. */
    function viaLauncher(mode: 'stay' | 'exec'): unknown {
      const out = path.join(dir, `launcher-${mode}-${Date.now()}`);
      execFileSync(
        launcher,
        [mode, out, process.execPath, ...nodeArgs('evidence', identity)],
        { env: ENV, stdio: 'pipe', timeout: 15_000 },
      );
      return JSON.parse(readFileSync(out, 'utf8'));
    }

    it('checks the code of its unchanged launcher', () => {
      // The ad hoc launcher fails only the requirement: pid and pidversion hold.
      expect(viaLauncher('stay')).toEqual({
        wrongRole: 'invalid_argument',
        forged: 'invalid_argument',
        crossed: 'invalid_argument',
        result: { ok: false, reason: 'requirement_unsatisfied' },
        held: null,
        ppid: anyNumber,
      });
    }, 20_000);

    it('refuses a launcher that exec-ed after the claim by its pidversion', () => {
      expect(viaLauncher('exec')).toEqual({
        wrongRole: 'invalid_argument',
        forged: 'invalid_argument',
        crossed: 'invalid_argument',
        result: { ok: false, reason: 'pidversion_changed' },
        held: null,
        ppid: anyNumber,
      });
    }, 20_000);

    it('refuses a daemon attached to a channel its parent does not hold', async () => {
      // The shell is the daemon's parent; this process wrote the frame.
      const { channel } = await launch('/bin/sh', [
        '-c',
        '"$0" "$@"; exit $?',
        process.execPath,
        ...nodeArgs('evidence', identity),
      ]);
      expect(await frame(channel)).toBe('"hello"');
      await send(channel, 'launcher');
      const reply: unknown = JSON.parse((await frame(channel)) ?? 'null');
      expect(reply).toEqual({
        wrongRole: 'invalid_argument',
        forged: 'invalid_argument',
        crossed: 'invalid_argument',
        result: { ok: false, reason: 'pid_mismatch' },
        held: null,
        ppid: anyNumber,
      });
      expect(Reflect.get(Object(reply), 'ppid')).not.toBe(process.pid);
    }, 20_000);

    /**
     * Runs the `detached` daemon under a shell that holds stdin open, with
     * this process holding the launcher end. `after` runs once the daemon's
     * first frame arrives; returns what the daemon's capture reported.
     */
    async function detached(
      after: (end: Socket, shell: ReturnType<typeof spawn>) => Promise<void>,
    ): Promise<unknown> {
      const out = path.join(dir, `detached-${Date.now()}-${Math.random()}`);
      const shell = spawn(
        '/bin/sh',
        [
          '-c',
          '"$0" "$@" & read x',
          process.execPath,
          ...nodeArgs('detached', out, identity),
        ],
        { stdio: ['pipe', 'ignore', 'ignore', 'pipe'], env: ENV },
      );
      const end = shell.stdio[3];
      if (!(end instanceof Socket)) throw new Error('no launcher end');
      sockets.add(end);
      cleanups.add(() => shell.kill('SIGKILL'));
      let text = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no frame')), 10_000);
        end.on('data', (bytes: Buffer) => {
          text += bytes.toString();
          if (text.includes('\n')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      expect(text.trim()).toBe('"hello"');
      await after(end, shell);
      const deadline = Date.now() + 10_000;
      while (!existsSync(out)) {
        if (Date.now() > deadline) throw new Error('no report');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return JSON.parse(readFileSync(out, 'utf8'));
    }

    it('refuses a launcher that left while its end stayed connected', async () => {
      // The shell that launched the daemon exits; the end it was given is
      // still held here, so only the parent check refuses it.
      const reply = await detached(async (end, shell) => {
        const exited = new Promise((resolve) => shell.on('exit', resolve));
        shell.stdin?.end();
        await exited;
        end.write('"launcher"\n');
      });
      expect(reply).toEqual({
        sent: '"launcher"',
        result: { ok: false, reason: 'reparented' },
        ppid: 1,
      });
    }, 30_000);

    it('refuses a launcher that closed its end after its frame', async () => {
      // No newline: the daemon reads the frame, then end of stream, then
      // captures. A half-close would leave the end connected.
      const reply = await detached(
        (end) =>
          new Promise<void>((resolve) =>
            end.write('"launcher"', () => {
              end.destroy();
              resolve();
            }),
          ),
      );
      expect(reply).toEqual({
        sent: null,
        result: { ok: false, reason: 'not_connected' },
        ppid: anyNumber,
      });
    }, 30_000);
  });

  describe('runtime flag', () => {
    const SOURCE = `#include <unistd.h>
int main(void) { char c; if (write(3, "hi\\n", 3) != 3) return 9; return (int)read(3, &c, 1); }
`;
    let plain = '';
    let hardened = '';

    beforeAll(() => {
      const source = path.join(dir, 'peer.c');
      writeFileSync(source, SOURCE);
      plain = path.join(dir, 'peer-plain');
      hardened = path.join(dir, 'peer-hardened');
      for (const [out, options] of [
        [plain, []],
        [hardened, ['-o', 'runtime']],
      ] as const) {
        execFileSync('/usr/bin/clang', ['-o', out, source], { stdio: 'pipe' });
        execFileSync('/usr/bin/codesign', ['-f', '-s', '-', ...options, out], {
          stdio: 'pipe',
        });
      }
    }, 60_000);

    it.each([
      [
        'refuses a peer without',
        (): string => plain,
        { state: 'refused', reason: 'runtime_missing' },
      ],
      ['accepts a peer with', (): string => hardened, { state: 'satisfied' }],
    ])(
      '%s the hardened runtime',
      async (_, file, expected) => {
        const { channel } = await launch(file(), []);
        expect(await frame(channel)).toBe('hi');
        const peer = channelPeer(channel);
        if (peer.state !== 'peer') throw new Error(`refused: ${peer.reason}`);
        const module = { exports: {} };
        process.dlopen(module, peerAddon);
        const check: unknown = Reflect.get(module.exports, 'checkGuest');
        if (typeof check !== 'function') throw new Error('no checkGuest');
        // Ad hoc code has no anchor, so this binds the cdhash alone.
        expect(
          Reflect.apply(check, module.exports, [
            peer.token,
            `cdhash H"${cdhash(file())}"`,
          ]),
        ).toEqual(expected);
      },
      20_000,
    );
  });
});

describe('consumer boundary', () => {
  it('permits only the disabled daemon and Electron main launcher-channel consumers', () => {
    const names = [
      'spawnWithChannel',
      'createPeerIdentityServices',
      'core-peer-identity',
      'channelPeer',
    ];
    // Source archives have no Git metadata. Audit exported JS/TS source files,
    // skipping dependencies, dot-directories and ignored build output.
    function scan(directory: string): string[] {
      return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
        if (/^(node_modules|out(-.*)?|dist|coverage|\..*)$/.test(entry.name)) return [];
        const file = directory + '/' + entry.name;
        if (entry.isDirectory()) return scan(file);
        if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(file)) return [];
        const content = readFileSync(path.join(ROOT, file), 'utf8');
        return names.some((name) => content.includes(name)) ? [file] : [];
      });
    }
    const hits = ['apps', 'packages', 'scripts'].flatMap(scan).sort()
      .filter(Boolean)
      .filter((file) => !file.startsWith('packages/core-platform/'))
      // Named fixtures exercise host-only composition, not production consumers.
      .filter(
        (file) =>
          file !== 'apps/core-daemon/src/__tests__/closure-sources.test.ts' &&
          file !==
            'apps/desktop-app/src/main/canopy-runtime/__tests__/migration-channel.test.ts',
      );
    // Exact membership excludes CLI, renderer, preload, agent, Portal, relay and remote exposure.
    expect(hits).toEqual([
      'apps/core-daemon/src/main.ts',
      'apps/desktop-app/src/main/canopy-runtime/migration-channel.ts',
      'scripts/build-peer-identity.mjs',
    ]);
  });

  it('exports no test seam: only the fixture loader adds one', () => {
    expect(Object.keys(peerIdentity)).not.toContain(
      'launcherRequirementForTests',
    );
    expect(
      readFileSync(MODULE, 'utf8').includes('launcherRequirementForTests'),
    ).toBe(false);
  });
});

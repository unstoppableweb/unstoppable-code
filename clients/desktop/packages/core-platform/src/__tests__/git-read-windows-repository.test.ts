import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir, userInfo } from 'node:os';
import { createServer as createTcpServer } from 'node:net';
import path from 'node:path';
import {
  createGitReadRunner,
  type GitReadRunnerOptions,
} from '../git-read/runner';
import { createGitReadHost, createGitReadHostWith } from '../git-read/host';
import {
  gitRepositoryCommandFor,
  planGitReadCommand,
  type GitReadCommand,
} from '../git-read/commands';
import type { GitRepositoryRead } from '@canopy/core-runtime/node/git';
import type { PlatformExecutionProcessServices } from '@canopy/core-runtime';
import {
  createExecutionProcessServices,
  ExecutionProcessError,
  type ExecutionProcessOperations,
} from '../supervision/execution-process';
import { createWindowsClosureWitness } from '../supervision/windows-closure';

// Native jobs on Windows; the same runner branch with real POSIX custody elsewhere.
// The latter is development evidence, never a Windows qualification receipt.
const windows = process.platform === 'win32';
const os = windows
  ? 'win32'
  : process.platform === 'darwin'
    ? 'darwin'
    : 'linux';
const root = path.resolve(__dirname, '../../../..');
const addon = path.resolve(
  root,
  process.env.CANOPY_OWNED_CHILD_ADDON ??
    `.cache/native-owned-child/win32-${process.arch}/core-owned-child.node`,
);
const portable = (file: string): string => (windows ? file : `/${file}`);
// The non-executable fixture fails Node's spawn, which the host reports as git_unavailable.
// POSIX names the file (`spawn <file>`); windows-2022 reports a bare `spawn`
// (Internal Release 44214585771). The host's isSpawnFailure accepts both.
const spawnSyscall: unknown = windows
  ? 'spawn'
  : expect.stringMatching(/^spawn /);
const UNCONTAINED_SPAWN_FAILURE = { syscall: spawnSyscall };
const quote = (file: string): string =>
  `'${file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
const USER = 'can5943-fixture';
const PASSWORD = 'disposable-fixture-only';
let dir = '';
let repo = '';
let remote = '';
let helper = '';
let gitExecutable = '';
let server: Server | undefined;
let helperEnvironment: Record<string, string> = {};
let teardown = new AbortController();
const runners: ReturnType<typeof createGitReadRunner>[] = [];
const sshServers: (() => Promise<void>)[] = [];
const hosts: ReturnType<typeof createGitReadHost>[] = [];

function openSshTools(): { server: string; client: string; keygen: string } {
  if (!windows)
    return {
      server: '/usr/sbin/sshd',
      client: '/usr/bin/ssh',
      keygen: '/usr/bin/ssh-keygen',
    };
  const systemRoot = Object.entries(process.env).find(
    ([key]) => key.toUpperCase() === 'SYSTEMROOT',
  )?.[1];
  if (!systemRoot)
    throw new Error('Windows SSH qualification requires SystemRoot');
  const server = path.join(systemRoot, 'System32', 'OpenSSH', 'sshd.exe');
  if (!existsSync(server))
    throw new Error(
      'Windows SSH qualification requires the Windows OpenSSH Server optional feature (System32/OpenSSH/sshd.exe)',
    );
  let candidate = path.dirname(gitExecutable);
  for (let depth = 0; depth < 4; depth++, candidate = path.dirname(candidate)) {
    const bin = path.join(candidate, 'usr', 'bin');
    if (
      existsSync(path.join(bin, 'ssh.exe')) &&
      existsSync(path.join(bin, 'ssh-keygen.exe'))
    )
      return {
        server,
        client: path.join(bin, 'ssh.exe'),
        keygen: path.join(bin, 'ssh-keygen.exe'),
      };
  }
  throw new Error(
    'Windows SSH qualification requires Git for Windows bundled usr/bin/ssh.exe and ssh-keygen.exe',
  );
}

const sshPath = (file: string): string =>
  windows
    ? file
        .replaceAll('\\', '/')
        .replace(
          /^([A-Za-z]):/,
          (_, drive: string) => `/${drive.toLowerCase()}`,
        )
    : file;

const serverPath = (file: string): string =>
  windows ? file.replaceAll('\\', '/') : file;
const serverQuote = (file: string): string =>
  windows ? `"${serverPath(file)}"` : quote(file);

async function freePort(): Promise<number> {
  const reservation = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === 'string')
    throw new Error('SSH port reservation failed');
  return address.port;
}

function sshServerEnvironment(): Record<string, string> {
  if (!windows) return environment();
  const env: Record<string, string> = {};
  // Win32-OpenSSH needs the real account profile; only the Git session is fixture-scoped.
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      [
        'PATH',
        'SYSTEMROOT',
        'WINDIR',
        'PROGRAMDATA',
        'PROGRAMFILES',
        'PROGRAMFILES(X86)',
        'PROGRAMW6432',
        'COMSPEC',
        'PATHEXT',
        'TEMP',
        'TMP',
        'USERNAME',
        'USERDOMAIN',
        'USERPROFILE',
        'HOMEDRIVE',
        'HOMEPATH',
        'LOCALAPPDATA',
        'APPDATA',
      ].includes(key.toUpperCase())
    )
      env[key] = value;
  return env;
}

async function startSshServer(
  executable: string,
  config: string,
): Promise<void> {
  // The server is fixture infrastructure, not request-owned Git closure evidence.
  const env = sshServerEnvironment();
  const child = spawn(executable, ['-D', '-e', '-f', config], {
    cwd: dir,
    env,
    detached: !windows,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let listening = (): void => undefined;
  let failed: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    listening = resolve;
    failed = reject;
  });
  let diagnostics = '';
  const recordOutput = (bytes: Buffer): void => {
    diagnostics = (diagnostics + bytes.toString('utf8')).slice(-8192);
    if (diagnostics.includes('Server listening on 127.0.0.1')) listening();
  };
  child.stdout.on('data', recordOutput);
  child.stderr.on('data', recordOutput);
  child.once('error', (error) => {
    failed(
      new Error(`fixture sshd launch failed: ${error.message}`, {
        cause: error,
      }),
    );
  });
  // `close`, unlike `exit`, follows the final stdout/stderr data events.
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      resolve();
      failed(
        new Error(
          `fixture sshd exited before listening (code=${code}, signal=${signal}): ${diagnostics}`,
        ),
      );
    });
  });
  sshServers.push(async (): Promise<void> => {
    if (
      child.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      if (windows) {
        const systemRoot = Object.entries(env).find(
          ([key]) => key.toUpperCase() === 'SYSTEMROOT',
        )?.[1];
        if (!systemRoot) throw new Error('sshd cleanup requires SystemRoot');
        execFileSync(
          path.join(systemRoot, 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/t', '/f'],
          {
            env,
            windowsHide: true,
            timeout: 5000,
            stdio: 'pipe',
          },
        );
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`fixture sshd cleanup unconfirmed: ${diagnostics}`),
              ),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
  const timer = setTimeout(
    () => failed(new Error(`fixture sshd failed to listen: ${diagnostics}`)),
    5000,
  );
  try {
    await ready;
  } finally {
    clearTimeout(timer);
  }
}

async function authenticatedSsh(): Promise<{
  host: ReturnType<typeof createGitReadHost>;
  forwarded: Record<string, string>;
  wrong: string;
}> {
  const tools = openSshTools();
  const hostKey = path.join(dir, 'ssh-host');
  const clientKey = path.join(dir, 'ssh-client');
  const wrongKey = path.join(dir, 'ssh-wrong');
  for (const file of [hostKey, clientKey, wrongKey])
    execFileSync(tools.keygen, ['-q', '-t', 'ed25519', '-N', '', '-f', file], {
      env: environment(),
      stdio: 'pipe',
      input: '',
      timeout: 5000,
    });
  const authorized = path.join(dir, 'authorized_keys');
  writeFileSync(authorized, readFileSync(`${clientKey}.pub`));
  const port = await freePort();
  const known = path.join(dir, 'known_hosts');
  writeFileSync(
    known,
    `[127.0.0.1]:${port} ${readFileSync(`${hostKey}.pub`, 'utf8').trim()}\n`,
  );
  const config = path.join(dir, 'sshd_config');
  writeFileSync(
    config,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey "${serverPath(hostKey)}"`,
      `AuthorizedKeysFile "${serverPath(authorized)}"`,
      `PidFile "${serverPath(path.join(dir, 'sshd.pid'))}"`,
      ...(!windows ? ['UsePAM no'] : []),
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes',
      'AuthenticationMethods publickey',
      'StrictModes no',
      'PermitUserRC no',
      'PermitUserEnvironment no',
      'AllowAgentForwarding no',
      'AllowTcpForwarding no',
      'X11Forwarding no',
      'PermitTTY no',
      // sshd builds a fresh session environment; keep shell/Git config fixture-owned too.
      `SetEnv "HOME=${serverPath(dir)}" "USERPROFILE=${serverPath(dir)}" "GIT_CONFIG_NOSYSTEM=1" "GIT_CONFIG_GLOBAL=${serverPath(path.join(dir, 'empty-config'))}"`,
      `ForceCommand ${serverQuote(gitExecutable)} upload-pack ${serverQuote(remote)}`,
      'LogLevel VERBOSE',
      '',
    ].join('\n'),
  );
  await startSshServer(tools.server, config);
  git(
    'remote',
    'set-url',
    'origin',
    `ssh://${encodeURIComponent(userInfo().username)}@127.0.0.1:${port}${sshPath(remote)}`,
  );
  const command = (key: string): string =>
    [
      quote(tools.client),
      '-F',
      quote(path.join(dir, 'empty-config')),
      '-i',
      quote(key),
      '-o IdentitiesOnly=yes',
      '-o IdentityAgent=none',
      '-o BatchMode=yes',
      '-o StrictHostKeyChecking=yes',
      '-o ConnectTimeout=5',
      '-o UserKnownHostsFile=' + quote(known),
      '-p',
      String(port),
    ].join(' ');
  const host = createGitReadHost({
    os,
    nativePath: addon,
    environment: environment(),
    probeDirectory: dir,
  });
  hosts.push(host);
  return {
    host,
    forwarded: environment({
      GIT_SSH_COMMAND: command(clientKey),
      GIT_SSH_VARIANT: 'ssh',
    }),
    wrong: command(wrongKey),
  };
}

function environment(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      [
        'PATH',
        'SYSTEMROOT',
        'TEMP',
        'TMP',
        'PROGRAMFILES',
        'PROGRAMFILES(X86)',
      ].includes(key.toUpperCase())
    )
      env[key] = value;
  return {
    ...env,
    HOME: dir,
    USERPROFILE: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(dir, 'empty-config'),
    GIT_TERMINAL_PROMPT: '1',
    GCM_INTERACTIVE: 'always',
    FIXTURE_GIT: gitExecutable,
    FIXTURE_REMOTE: remote,
    FIXTURE_RECORD: path.join(dir, 'record.json'),
    ...extra,
  };
}

function git(...args: string[]): string {
  return execFileSync(gitExecutable, args, {
    cwd: repo,
    env: environment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function processServices(
  onRootTreeEmpty: NonNullable<ExecutionProcessOperations['onRootTreeEmpty']>,
): ReturnType<typeof createExecutionProcessServices> {
  const services = createExecutionProcessServices(
    { os, nativePath: addon },
    { onRootTreeEmpty },
  );
  if (windows) return services;
  return {
    start: (request) =>
      services.start({
        ...request,
        environment: {
          ...request.environment,
          PATH: request.environment.PATH?.split(';').join(':') ?? '',
        },
      }),
    shutdown: (options) => services.shutdown(options),
  };
}

function runner(
  overrides: Partial<GitReadRunnerOptions> = {},
): ReturnType<typeof createGitReadRunner> {
  const value = createGitReadRunner({
    os: 'win32',
    nativePath: addon,
    hostSignal: teardown.signal,
    timing: { cleanupReserveMs: 2000 },
    ...(!windows ? { createWindowsProcesses: processServices } : {}),
    ...overrides,
  });
  runners.push(value);
  return value;
}

function requestEnvironment(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env = environment({ ...helperEnvironment, ...extra });
  if (!windows) {
    env.PATH = (env.PATH ?? '')
      .split(':')
      .filter((p) => p.startsWith('/'))
      .map(portable)
      .join(';');
    env.SystemRoot = 'C:\\Windows';
  }
  return env;
}

function run(
  command: GitReadCommand,
  extra: Record<string, string> = {},
  options: { signal?: AbortSignal; ms?: number } = {},
): ReturnType<ReturnType<typeof createGitReadRunner>['run']> {
  if (!('executable' in command))
    throw new Error('repository fixture requires an executable command');
  return runner().run(
    { ...command, executable: portable(gitExecutable) },
    {
      cwd: portable(repo),
      environment: requestEnvironment(extra),
      deadlineAt: performance.now() + (options.ms ?? 15_000),
      signal: options.signal,
    },
  );
}

function read(value: GitRepositoryRead): GitReadCommand {
  return gitRepositoryCommandFor('win32', value)(gitExecutable);
}

function record(file = 'record.json'): {
  pid: number;
  prompt: string;
  interactive: string;
  marker?: string;
  survivor?: number;
} {
  const value: unknown = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  if (
    typeof value !== 'object' ||
    value === null ||
    !('pid' in value) ||
    typeof value.pid !== 'number' ||
    !('prompt' in value) ||
    typeof value.prompt !== 'string' ||
    !('interactive' in value) ||
    typeof value.interactive !== 'string' ||
    ('marker' in value && typeof value.marker !== 'string') ||
    ('survivor' in value && typeof value.survivor !== 'number')
  )
    throw new Error('Invalid helper record');
  return {
    pid: value.pid,
    prompt: value.prompt,
    interactive: value.interactive,
    ...('marker' in value && typeof value.marker === 'string'
      ? { marker: value.marker }
      : {}),
    ...('survivor' in value && typeof value.survivor === 'number'
      ? { survivor: value.survivor }
      : {}),
  };
}

function ready(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error('helper did not start'));
    }, 10_000);
    const check = (): void => {
      if (!existsSync(path.join(dir, 'record.json'))) return;
      clearTimeout(timer);
      watcher.close();
      resolve();
    };
    const watcher = watch(dir, check);
    check();
  });
}

const helperSource = `
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const mode = process.argv[2];
if (mode === 'linger') { setInterval(() => {}, 1000); return; }
if (mode === 'forbidden') { fs.writeFileSync(process.env.FIXTURE_RECORD + '.forbidden', mode); process.exit(1); }
if (mode === 'credential' && !process.argv.includes('get')) process.exit(0);
const data = { pid: process.pid, prompt: process.env.GIT_TERMINAL_PROMPT, interactive: process.env.GCM_INTERACTIVE, marker: process.env.FIXTURE_MARKER };
if (process.env.FIXTURE_BEHAVIOR === 'survive' || process.env.FIXTURE_BEHAVIOR === 'hold-stderr') {
  const child = spawn(process.execPath, [__filename, 'linger'], { stdio: process.env.FIXTURE_BEHAVIOR === 'hold-stderr' ? ['ignore', 'ignore', 'inherit'] : 'ignore', detached: process.platform === 'win32' });
  data.survivor = child.pid; child.unref();
}
if (mode === 'held-pipe-root') {
  const stream = process.env.FIXTURE_HELD_PIPE;
  const child = spawn(process.execPath, [__filename, 'linger'], { stdio: ['ignore', stream === 'stdout' ? 'inherit' : 'ignore', stream === 'stderr' ? 'inherit' : 'ignore'], detached: process.platform === 'win32' });
  data.survivor = child.pid; child.unref();
}
fs.writeFileSync(process.env.FIXTURE_RECORD + '.tmp', JSON.stringify(data));
fs.renameSync(process.env.FIXTURE_RECORD + '.tmp', process.env.FIXTURE_RECORD);
if (mode === 'held-pipe-root') {
  const result = spawnSync(process.env.FIXTURE_GIT, process.argv.slice(3), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
if (process.env.FIXTURE_BEHAVIOR === 'block') { setInterval(() => {}, 1000); return; }
if (process.env.FIXTURE_BEHAVIOR === 'flood') { process.stderr.write(Buffer.alloc(9 * 1024 * 1024, 120)); setInterval(() => {}, 1000); return; }
if (mode === 'credential') { process.stdout.write('username=${USER}\\npassword=' + (process.env.FIXTURE_BEHAVIOR === 'wrong' ? 'wrong-fixture-only' : '${PASSWORD}') + '\\n'); return; }
if (mode === 'filter') { process.stdin.pipe(process.stdout); return; }
const result = spawnSync(process.env.FIXTURE_GIT, ['upload-pack', process.env.FIXTURE_REMOTE], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`;

beforeEach(async () => {
  helperEnvironment = {};
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'can5943-')));
  repo = dir;
  writeFileSync(path.join(dir, 'empty-config'), '');
  const host = createGitReadHost({
    os,
    environment: environment(),
    probeDirectory: dir,
  });
  try {
    gitExecutable = await host.selectWriteExecutable(
      () => Promise.resolve(''),
      AbortSignal.timeout(10_000),
    );
  } finally {
    expect(await host.stop(AbortSignal.timeout(10_000))).toEqual({
      state: 'stopped',
    });
  }
  if (windows && !existsSync(addon))
    throw new Error(
      'Windows qualification requires the built owned-child addon',
    );
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'protocol.version', '0');
  writeFileSync(path.join(dir, 'tracked.dat'), 'one\n');
  git('add', 'tracked.dat');
  git('commit', '--quiet', '-m', 'fixture');
  remote = path.join(dir, 'remote.git');
  git('clone', '--quiet', '--bare', dir, remote);
  git('remote', 'add', 'origin', remote);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  helper = path.join(dir, 'fixture-helper.cjs');
  writeFileSync(helper, helperSource);
  writeFileSync(
    path.join(dir, '.gitignore'),
    'remote.git/\nfixture-helper.cjs\nempty-config\nrecord*\n',
  );
});

afterEach(async () => {
  teardown.abort(new Error('test ended'));
  teardown = new AbortController();
  server?.closeAllConnections();
  const cleanup = await Promise.allSettled([
    ...runners
      .splice(0)
      .map(async (value) =>
        expect(await value.whenIdle(AbortSignal.timeout(10_000))).toBe('idle'),
      ),
    ...hosts.splice(0).map(async (host) =>
      expect(await host.stop(AbortSignal.timeout(10_000))).toEqual({
        state: 'stopped',
      }),
    ),
    ...sshServers.splice(0).map((stop) => stop()),
    ...(server
      ? [new Promise<void>((resolve) => server?.close(() => resolve()))]
      : []),
  ]);
  server = undefined;
  const failed = cleanup.filter((result) => result.status === 'rejected');
  if (failed.length)
    throw new AggregateError(
      failed.map((result): unknown => result.reason),
      'fixture cleanup was not confirmed',
    );
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('Windows repository command custody', () => {
  const nativeSsh = windows || existsSync('/usr/sbin/sshd') ? it : it.skip;
  nativeSsh(
    'authenticates real SSH with fixture keys and rejects a wrong key noninteractively (requires host sshd)',
    async () => {
      const { host, forwarded, wrong } = await authenticatedSsh();
      const readRemote = (env: Record<string, string>): Promise<string> =>
        host.repository.readRepository({
          read: { kind: 'remote-head' },
          cwd: repo,
          environment: env,
          signal: AbortSignal.timeout(15_000),
          readSavedExecutablePath: () => Promise.resolve(gitExecutable),
        });
      expect(await readRemote(forwarded)).toContain('refs/heads/main');
      const startedAt = performance.now();
      await expect(
        readRemote({ ...forwarded, GIT_SSH_COMMAND: wrong }),
      ).rejects.toMatchObject({
        name: 'GitRepositoryReadError',
        code: 'exit_status',
        exitCode: 128,
      });
      expect(performance.now() - startedAt).toBeLessThan(10_000);
      // A failed request must not poison the next authenticated request or host snapshot.
      expect(await readRemote(forwarded)).toContain('refs/heads/main');
    },
    60_000,
  );
  it('matches all fifteen direct Git results and exit statuses with closed native jobs', async () => {
    writeFileSync(path.join(dir, 'tracked.dat'), 'two\n');
    const witness = createWindowsClosureWitness();
    await witness.run(async () => {
      for (const value of fifteenReads()) {
        const command = read(value);
        const plan = planGitReadCommand(os, command, environment());
        const direct = git(...plan.args);
        expect(await run(command)).toMatchObject({
          code: 0,
          signal: null,
          stdout: direct,
          pipes: 'closed',
        });
      }
      expect(
        await run(read({ kind: 'origin-branch', branch: 'develop' })),
      ).toMatchObject({ code: 128, pipes: 'closed' });
      expect(
        await run(read({ kind: 'object-exists', object: '0'.repeat(40) })),
      ).toMatchObject({ code: 1, pipes: 'closed' });
    });
    expect(witness.accepts(witness.finalize())).toBe(true);
  }, 60_000);

  function fifteenReads(): GitRepositoryRead[] {
    return [
      { kind: 'branch-refs' },
      { kind: 'common-dir' },
      { kind: 'worktree-list' },
      { kind: 'origin-url' },
      { kind: 'remote-names' },
      { kind: 'git-dir' },
      { kind: 'remote-head' },
      { kind: 'origin-head' },
      { kind: 'origin-branch', branch: 'main' },
      { kind: 'inside-work-tree' },
      { kind: 'diff-name-status', range: { kind: 'worktree', base: 'HEAD' } },
      {
        kind: 'diff-numstat',
        range: {
          kind: 'objects',
          base: git('rev-parse', 'HEAD').trim(),
          head: 'HEAD',
        },
      },
      { kind: 'untracked-files' },
      { kind: 'unmerged-files' },
      { kind: 'object-exists', object: 'HEAD' },
    ];
  }

  function ssh(): void {
    git(
      'remote',
      'set-url',
      'origin',
      'ssh://fixture@example.invalid/repo.git',
    );
    git(
      'config',
      'core.sshCommand',
      `${quote(process.execPath)} ${quote(helper)} ssh`,
    );
    git('config', 'ssh.variant', 'simple');
  }

  async function credential(): Promise<void> {
    server = createServer((request, response) => {
      if (
        request.headers.authorization !==
        `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`
      ) {
        response.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="fixture"',
        });
        response.end();
        return;
      }
      const refs = execFileSync(
        gitExecutable,
        ['upload-pack', '--stateless-rpc', '--advertise-refs', remote],
        { env: environment() },
      );
      response.writeHead(200, {
        'Content-Type': 'application/x-git-upload-pack-advertisement',
      });
      response.end(
        Buffer.concat([
          Buffer.from('001e# service=git-upload-pack\n0000'),
          refs,
        ]),
      );
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('fixture server not listening');
    git(
      'remote',
      'set-url',
      'origin',
      `http://127.0.0.1:${address.port}/repo.git`,
    );
    helperEnvironment = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: `!${quote(process.execPath)} ${quote(helper)} credential`,
    };
  }

  it('authenticates HTTP through a forwarded fixture credential helper and projects noninteractive auth failure', async () => {
    await credential();
    const host = createGitReadHost({
      os,
      nativePath: addon,
      environment: environment(),
      probeDirectory: dir,
    });
    hosts.push(host);
    const readRemote = (extra: Record<string, string> = {}): Promise<string> =>
      host.repository.readRepository({
        read: { kind: 'remote-head' },
        cwd: repo,
        environment: environment({ ...helperEnvironment, ...extra }),
        signal: AbortSignal.timeout(15_000),
        readSavedExecutablePath: () => Promise.resolve(gitExecutable),
      });
    expect(await readRemote()).toContain('refs/heads/main');
    expect(record()).toMatchObject({ prompt: '0', interactive: 'never' });
    const startedAt = performance.now();
    await expect(
      readRemote({ FIXTURE_BEHAVIOR: 'wrong' }),
    ).rejects.toMatchObject({
      name: 'GitRepositoryReadError',
      code: 'exit_status',
      exitCode: 128,
    });
    expect(performance.now() - startedAt).toBeLessThan(10_000);
    expect(await readRemote()).toContain('refs/heads/main');
  }, 30_000);

  it.each([
    ['SSH', ssh],
    ['credential', credential],
  ] as const)(
    'runs a controlled %s helper with request-local noninteractive overrides',
    async (_, setup) => {
      await setup();
      const witness = createWindowsClosureWitness();
      await witness.run(async () => {
        const command = read({ kind: 'remote-head' });
        const results = await Promise.all([
          run(command, {
            FIXTURE_MARKER: 'first',
            FIXTURE_RECORD: path.join(dir, 'first.json'),
          }),
          run(command, {
            FIXTURE_MARKER: 'second',
            FIXTURE_RECORD: path.join(dir, 'second.json'),
          }),
        ]);
        const remoteHead: unknown = expect.stringContaining('refs/heads/main');
        for (const result of results)
          expect(result).toMatchObject({
            code: 0,
            pipes: 'closed',
            stdout: remoteHead,
          });
        for (const marker of ['first', 'second'])
          expect(record(`${marker}.json`)).toMatchObject({
            marker,
            prompt: '0',
            interactive: 'never',
          });
        await run(command);
        expect(record()).not.toHaveProperty('marker');
      });
      expect(witness.accepts(witness.finalize())).toBe(true);
    },
    30_000,
  );

  it.each([
    ['SSH', ssh],
    ['credential', credential],
  ] as const)(
    'ends a blocked %s helper on cancellation and deadline',
    async (_, setup) => {
      await setup();
      for (const cancel of [true, false]) {
        rmSync(path.join(dir, 'record.json'), { force: true });
        const controller = new AbortController();
        const reason = new Error('cancelled fixture');
        const started = ready();
        const work = run(
          read({ kind: 'remote-head' }),
          { FIXTURE_BEHAVIOR: 'block' },
          { signal: controller.signal, ms: cancel ? 15_000 : 6000 },
        ).catch((error: unknown) => error);
        await started;
        const { pid } = record();
        if (cancel) controller.abort(reason);
        const error = await work;
        if (cancel) expect(error).toBe(reason);
        else expect(error).toMatchObject({ code: 'deadline_exceeded' });
        expect(() => process.kill(pid, 0)).toThrow();
      }
    },
    30_000,
  );

  it('bounds helper stderr and never accepts overflow as closure evidence', async () => {
    ssh();
    const witness = createWindowsClosureWitness();
    await witness.run(async () => {
      await expect(
        run(read({ kind: 'remote-head' }), { FIXTURE_BEHAVIOR: 'flood' }),
      ).rejects.toMatchObject({ code: 'output_limit', stream: 'stderr' });
    });
    expect(witness.accepts(witness.finalize())).toBe(false);
  });

  it.each(['stderr', 'stdout'] as const)(
    'preserves the root result when a descendant holds %s past the drain window',
    async (stream) => {
      for (const branch of ['main', 'develop'] as const) {
        const target = runner({
          createWindowsProcesses: (
            observe,
          ): PlatformExecutionProcessServices => {
            const services = processServices(observe);
            return {
              start: (request) =>
                services.start({
                  ...request,
                  executable: process.execPath,
                  args: [helper, 'held-pipe-root', ...request.args],
                }),
              shutdown: (options) => services.shutdown(options),
            };
          },
        });
        const witness = createWindowsClosureWitness();
        const startedAt = performance.now();
        await witness.run(async () => {
          expect(
            await target.run(
              {
                kind: 'git-origin-branch',
                branch,
                executable: portable(gitExecutable),
              },
              {
                cwd: portable(repo),
                environment: requestEnvironment({ FIXTURE_HELD_PIPE: stream }),
                deadlineAt: performance.now() + 15_000,
              },
            ),
          ).toMatchObject({
            code: branch === 'main' ? 0 : 128,
            signal: null,
            stdout: branch === 'main' ? git('rev-parse', 'HEAD') : '',
            pipes: 'abandoned',
          });
        });
        expect(performance.now() - startedAt).toBeLessThan(5000);
        expect(witness.accepts(witness.finalize())).toBe(false);
        const { survivor } = record();
        if (survivor === undefined)
          throw new Error('root did not start its pipe holder');
        expect(() => process.kill(survivor, 0)).toThrow();
        expect(await target.whenIdle(AbortSignal.timeout(10_000))).toBe('idle');
      }
    },
    30_000,
  );

  it('preserves cancellation during the post-exit drain window', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel held-pipe drain');
    const target = runner({
      timing: { drainMs: 5000, cleanupReserveMs: 2000 },
      createWindowsProcesses: (observe): PlatformExecutionProcessServices => {
        const services = processServices((...args) => {
          observe(...args);
          // A later turn puts the abort after root observation, while stderr is held.
          setImmediate(() => controller.abort(reason));
        });
        return {
          start: (request) =>
            services.start({
              ...request,
              executable: process.execPath,
              args: [helper, 'held-pipe-root', ...request.args],
            }),
          shutdown: (options) => services.shutdown(options),
        };
      },
    });
    const witness = createWindowsClosureWitness();
    await witness.run(async () => {
      await expect(
        target.run(
          { kind: 'git-dir', executable: portable(gitExecutable) },
          {
            cwd: portable(repo),
            environment: requestEnvironment({ FIXTURE_HELD_PIPE: 'stderr' }),
            deadlineAt: performance.now() + 15_000,
            signal: controller.signal,
          },
        ),
      ).rejects.toBe(reason);
    });
    expect(witness.accepts(witness.finalize())).toBe(false);
    const { survivor } = record();
    if (survivor === undefined) throw new Error('missing pipe holder');
    expect(() => process.kill(survivor, 0)).toThrow();
    expect(await target.whenIdle(AbortSignal.timeout(10_000))).toBe('idle');
  });

  it.each([false, true])(
    'returns the abandoned-pipe result despite unconfirmed cleanup unless a late abort=%s',
    async (abortDuringCleanup) => {
      const reported: string[] = [];
      let release = (): void => undefined;
      const delayed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const controller = new AbortController();
      const reason = new Error('abort after drain abandonment');
      let rootExited = false;
      const target = runner({
        timing: { drainMs: 25, cleanupReserveMs: 200 },
        onKillCleanup: (outcome) => reported.push(outcome),
        createWindowsProcesses: (observe): PlatformExecutionProcessServices => {
          const services = processServices((...args) => {
            rootExited = true;
            observe(...args);
          });
          return {
            start: (request) =>
              services.start({
                ...request,
                executable: process.execPath,
                args: [helper, 'held-pipe-root', ...request.args],
              }),
            shutdown: async (): Promise<void> => {
              expect(rootExited).toBe(true);
              if (abortDuringCleanup) controller.abort(reason);
              await services.shutdown();
              await delayed;
            },
          };
        },
      });
      const witness = createWindowsClosureWitness();
      const command: GitReadCommand = {
        kind: 'git-dir',
        executable: portable(gitExecutable),
      };
      try {
        await witness.run(async () => {
          const work = target.run(command, {
            cwd: portable(repo),
            environment: requestEnvironment({
              FIXTURE_HELD_PIPE: 'stderr',
            }),
            deadlineAt: performance.now() + 10_000,
            signal: controller.signal,
          });
          // Git's own result stands; only the late abort rejects it.
          if (abortDuringCleanup)
            await expect(work).rejects.toMatchObject({
              code: 'cleanup_unconfirmed',
              failure: reason,
            });
          else
            await expect(work).resolves.toMatchObject({
              code: 0,
              signal: null,
              stdout: git(
                ...planGitReadCommand(os, command, environment()).args,
              ),
              pipes: 'abandoned',
            });
          expect(await target.whenIdle(AbortSignal.abort())).toBe('pending');
        });
        expect(witness.accepts(witness.finalize())).toBe(false);
        expect(reported).toContain('cleanup_unconfirmed');
        const { survivor } = record();
        if (survivor === undefined) throw new Error('missing pipe holder');
        expect(() => process.kill(survivor, 0)).toThrow();
      } finally {
        release();
        expect(await target.whenIdle(AbortSignal.timeout(10_000))).toBe('idle');
      }
    },
    20_000,
  );

  it('returns successful ls-remote when an SSH descendant holds stderr after Git exits', async () => {
    ssh();
    const direct = git('ls-remote', '--symref', remote, 'HEAD');
    const witness = createWindowsClosureWitness();
    await witness.run(async () => {
      expect(
        await run(read({ kind: 'remote-head' }), {
          FIXTURE_BEHAVIOR: 'hold-stderr',
        }),
      ).toMatchObject({
        code: 0,
        signal: null,
        stdout: direct,
        pipes: 'abandoned',
      });
    });
    const { survivor } = record();
    if (survivor === undefined)
      throw new Error('SSH helper did not start its pipe holder');
    expect(() => process.kill(survivor, 0)).toThrow();
    expect(witness.accepts(witness.finalize())).toBe(false);
  }, 20_000);

  it.each([
    [-1, 'deadline_exceeded'],
    [0, 'deadline_exceeded'],
    [1, 'timeout'],
  ] as const)(
    'classifies a command cap with request stop offset %s ms',
    async (offset, code) => {
      // Freeze monotonic time through async planning to make the tie exact.
      jest.useFakeTimers();
      try {
        let rejectStart: (reason: unknown) => void = () => undefined;
        const target = runner({
          createWindowsProcesses: (): PlatformExecutionProcessServices => ({
            start: () =>
              new Promise((_, reject) => {
                rejectStart = reject;
              }),
            shutdown: (): Promise<void> => {
              rejectStart(
                new ExecutionProcessError('unavailable', 'stopped startup'),
              );
              return Promise.resolve();
            },
          }),
        });
        const command: GitReadCommand = {
          kind: 'git-inside-work-tree',
          executable: portable(gitExecutable),
        };
        const cap = planGitReadCommand(
          'win32',
          command,
          requestEnvironment(),
        ).timeoutMs;
        expect(cap).toBe(5000);
        const work = target
          .run(command, {
            cwd: portable(repo),
            environment: requestEnvironment(),
            deadlineAt: performance.now() + 7000 + offset,
          })
          .catch((error: unknown) => error);
        await jest.advanceTimersByTimeAsync(5000);
        expect(await work).toMatchObject({ code });
        expect(await target.whenIdle(AbortSignal.abort())).toBe('idle');
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    'keeps output overflow ahead of an abort during cleanup, expired=%s',
    async (expireCleanup) => {
      ssh();
      let release = (): void => undefined;
      const delayed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const controller = new AbortController();
      const target = runner({
        createWindowsProcesses: (observe): PlatformExecutionProcessServices => {
          const services = processServices(observe);
          return {
            start: (request) => services.start(request),
            shutdown: async (): Promise<void> => {
              controller.abort(new Error('abort after output overflow'));
              await services.shutdown();
              if (expireCleanup) await delayed;
            },
          };
        },
      });
      try {
        const failure = { code: 'output_limit', stream: 'stderr' };
        await expect(
          target.run(
            { kind: 'git-remote-head', executable: portable(gitExecutable) },
            {
              cwd: portable(repo),
              environment: requestEnvironment({ FIXTURE_BEHAVIOR: 'flood' }),
              deadlineAt: performance.now() + 15_000,
              signal: controller.signal,
            },
          ),
        ).rejects.toMatchObject(
          expireCleanup ? { code: 'cleanup_unconfirmed', failure } : failure,
        );
        expect(() => process.kill(record().pid, 0)).toThrow();
        expect(await target.whenIdle(AbortSignal.abort())).toBe(
          expireCleanup ? 'pending' : 'idle',
        );
      } finally {
        release();
        expect(await target.whenIdle(AbortSignal.timeout(10_000))).toBe('idle');
      }
    },
  );

  it.each([false, true])(
    'reports an uncapped read deadline with a late cleanup abort=%s',
    async (abortDuringCleanup) => {
      git(
        'config',
        'filter.fixture.clean',
        `${quote(process.execPath)} ${quote(helper)} filter`,
      );
      writeFileSync(path.join(dir, '.gitattributes'), '*.dat filter=fixture\n');
      writeFileSync(path.join(dir, 'tracked.dat'), 'modified\n');
      const controller = new AbortController();
      const target = runner({
        createWindowsProcesses: (observe): PlatformExecutionProcessServices => {
          const services = processServices(observe);
          return {
            start: (request) => services.start(request),
            shutdown: async (): Promise<void> => {
              if (abortDuringCleanup)
                controller.abort(new Error('late cleanup abort'));
              await services.shutdown();
            },
          };
        },
      });
      const command = gitRepositoryCommandFor('win32', {
        kind: 'diff-numstat',
        range: { kind: 'worktree', base: 'HEAD' },
      })(portable(gitExecutable));
      expect(
        planGitReadCommand(os, command, environment()).timeoutMs,
      ).toBeUndefined();
      const started = ready();
      const work = target
        .run(command, {
          cwd: portable(repo),
          environment: requestEnvironment({ FIXTURE_BEHAVIOR: 'block' }),
          deadlineAt: performance.now() + 6000,
          signal: controller.signal,
        })
        .catch((error: unknown) => error);
      await started;
      const { pid } = record();
      expect(await work).toMatchObject({ code: 'deadline_exceeded' });
      expect(() => process.kill(pid, 0)).toThrow();
    },
    15_000,
  );

  it('preserves the first abort reason when another signal aborts during cleanup', async () => {
    ssh();
    const host = new AbortController();
    const request = new AbortController();
    const firstReason = new Error('first host abort');
    const target = runner({
      hostSignal: host.signal,
      createWindowsProcesses: (observe): PlatformExecutionProcessServices => {
        const services = processServices(observe);
        return {
          start: (value) => services.start(value),
          shutdown: async (): Promise<void> => {
            request.abort(new Error('late request abort'));
            await services.shutdown();
          },
        };
      },
    });
    const started = ready();
    const work = target
      .run(
        { kind: 'git-remote-head', executable: portable(gitExecutable) },
        {
          cwd: portable(repo),
          environment: requestEnvironment({ FIXTURE_BEHAVIOR: 'block' }),
          deadlineAt: performance.now() + 15_000,
          signal: request.signal,
        },
      )
      .catch((error: unknown) => error);
    await started;
    const { pid } = record();
    host.abort(firstReason);
    expect(await work).toBe(firstReason);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('preserves the first abort during cleanup after a successful root exit', async () => {
    const host = new AbortController();
    const request = new AbortController();
    const firstReason = new Error('first cleanup abort');
    const target = runner({
      hostSignal: host.signal,
      createWindowsProcesses: (observe): PlatformExecutionProcessServices => {
        const services = processServices(observe);
        return {
          start: (value) => services.start(value),
          shutdown: async (): Promise<void> => {
            host.abort(firstReason);
            request.abort(new Error('second cleanup abort'));
            await services.shutdown();
          },
        };
      },
    });
    await expect(
      target.run(
        { kind: 'git-dir', executable: portable(gitExecutable) },
        {
          cwd: portable(repo),
          environment: requestEnvironment(),
          deadlineAt: performance.now() + 15_000,
          signal: request.signal,
        },
      ),
    ).rejects.toBe(firstReason);
  });

  it('bounds repository stdout and never accepts overflow as closure evidence', async () => {
    git('remote', 'remove', 'origin');
    // Write config directly: the fixture must not depend on Windows' argv limit.
    appendFileSync(
      path.join(dir, '.git', 'config'),
      `\n[remote "origin"]\nurl = https://example.invalid/${'x'.repeat(9 * 1024 * 1024)}\n`,
    );
    const witness = createWindowsClosureWitness();
    await witness.run(async () => {
      await expect(run(read({ kind: 'origin-url' }))).rejects.toMatchObject({
        code: 'output_limit',
        stream: 'stdout',
      });
    });
    expect(witness.accepts(witness.finalize())).toBe(false);
  });

  it('returns the read, reports unconfirmed cleanup and stays non-idle until the owned cleanup actually settles', async () => {
    let release = (): void => undefined;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reported: string[] = [];
    const witness = createWindowsClosureWitness();
    let target: ReturnType<typeof createGitReadRunner> | undefined;
    const command: GitReadCommand = {
      kind: 'git-dir',
      executable: portable(gitExecutable),
    };
    try {
      await witness.run(async () => {
        const value = runner({
          timing: { cleanupReserveMs: 200 },
          onKillCleanup: (outcome) => reported.push(outcome),
          createWindowsProcesses: (
            observe,
          ): PlatformExecutionProcessServices => {
            const services = processServices(observe);
            return {
              start: (request) => services.start(request),
              shutdown: (): Promise<void> =>
                services.shutdown().then(() => delayed),
            };
          },
        });
        target = value;
        const host = createGitReadHostWith(
          {
            os: 'win32',
            environment: requestEnvironment(),
            probeDirectory: portable(repo),
          },
          { createRunner: () => value },
        );
        host.prewarm();
        await expect(
          value.run(command, {
            cwd: portable(repo),
            environment: requestEnvironment(),
            deadlineAt: performance.now() + 10_000,
          }),
        ).resolves.toMatchObject({
          code: 0,
          signal: null,
          stdout: git(...planGitReadCommand(os, command, environment()).args),
          pipes: 'closed',
        });
        expect(await value.whenIdle(AbortSignal.abort())).toBe('pending');
        await expect(host.stop(AbortSignal.abort())).resolves.toEqual({
          state: 'cleanup_unconfirmed',
        });
      });
      const report = witness.finalize();
      expect(witness.accepts(report)).toBe(false);
      expect(reported).toContain('cleanup_unconfirmed');
      release();
      expect(await target?.whenIdle(AbortSignal.timeout(10_000))).toBe('idle');
      expect(witness.accepts(report)).toBe(false);
    } finally {
      release();
    }
  });

  it.each([undefined, 'missing-addon.node'])(
    'runs a read uncontained, never refused or accepted as closure, without a native addon at %s',
    async (addonFile) => {
      const witness = createWindowsClosureWitness();
      const target = runner({
        nativePath:
          addonFile === undefined
            ? undefined
            : portable(path.join(dir, addonFile)),
        createWindowsProcesses: undefined,
      });
      writeFileSync(path.join(dir, 'tracked.dat'), 'two\n');
      await witness.run(async () => {
        for (const value of fifteenReads()) {
          const command = read(value);
          const plan = planGitReadCommand(os, command, environment());
          expect(
            await target.run(
              gitRepositoryCommandFor('win32', value)(portable(gitExecutable)),
              {
                cwd: portable(repo),
                environment: requestEnvironment(),
                deadlineAt: performance.now() + 15_000,
              },
            ),
          ).toMatchObject({
            code: 0,
            signal: null,
            stdout: git(...plan.args),
            pipes: 'closed',
          });
        }
      });
      expect(witness.accepts(witness.finalize())).toBe(false);
      expect(await target.whenIdle(AbortSignal.timeout(10_000))).toBe('idle');
    },
    60_000,
  );

  it.each([
    'capability_unavailable',
    'invalid_argument',
    'failed_precondition',
    'unavailable',
  ] as const)(
    'runs a read uncontained after a %s launch that started nothing',
    async (code) => {
      const witness = createWindowsClosureWitness();
      const starts: string[] = [];
      const target = runner({
        createWindowsProcesses: (): PlatformExecutionProcessServices => ({
          start: (request): Promise<never> => {
            starts.push(request.executable);
            return Promise.reject(new ExecutionProcessError(code, 'fixture'));
          },
          shutdown: (): Promise<void> => Promise.resolve(),
        }),
      });
      const output = await witness.run(() =>
        target.run(
          gitRepositoryCommandFor('win32', { kind: 'branch-refs' })(
            portable(gitExecutable),
          ),
          {
            cwd: portable(repo),
            environment: requestEnvironment(),
            deadlineAt: performance.now() + 10_000,
          },
        ),
      );
      expect(starts).toHaveLength(1);
      expect(output).toMatchObject({
        code: 0,
        stdout: git(
          ...planGitReadCommand(
            os,
            read({ kind: 'branch-refs' }),
            environment(),
          ).args,
        ),
      });
      expect(witness.accepts(witness.finalize())).toBe(false);
    },
  );

  it('rejects an aborted read during failed-launch cleanup instead of running it uncontained', async () => {
    const controller = new AbortController();
    const reason = new Error('abort during failed-launch cleanup');
    const target = runner({
      createWindowsProcesses: (): PlatformExecutionProcessServices => ({
        start: (): Promise<never> =>
          Promise.reject(
            new ExecutionProcessError('capability_unavailable', 'fixture'),
          ),
        shutdown: (): Promise<void> => {
          controller.abort(reason);
          return Promise.resolve();
        },
      }),
    });
    await expect(
      target.run(
        { kind: 'git-dir', executable: portable(gitExecutable) },
        {
          cwd: portable(repo),
          environment: requestEnvironment(),
          deadlineAt: performance.now() + 10_000,
          signal: controller.signal,
        },
      ),
    ).rejects.toBe(reason);
  });

  it.each([false, true])(
    'keeps runner custody and runs uncontained after undelivered native launch cleanup fails=%s',
    async (unconfirmed) => {
      const executable = path.join(dir, 'fixture-git.exe');
      writeFileSync(executable, 'not executed');
      const listeners = new Set(process.listeners('exit'));
      const native = {
        spawn: (): void => undefined,
        observe: (): void => undefined,
        stopGroup: (): void => undefined,
        members: (): void => undefined,
        release: (): void => undefined,
        commit: (): void => undefined,
        rollbackSync: (): boolean => true,
        rollbackUndelivered: (): boolean => true,
        resume: (): void => undefined,
        launch: (): never => {
          throw Object.assign(new Error('fixture launch rollback'), {
            code: unconfirmed
              ? 'ERR_OWNED_CHILD_CLEANUP'
              : 'ERR_OWNED_CHILD_SPAWN',
          });
        },
      };
      const load = jest
        .spyOn(process, 'dlopen')
        .mockImplementation((module) => {
          Object.assign(module, { exports: native });
        });
      const witness = createWindowsClosureWitness();
      const target = createGitReadRunner({
        os: 'win32',
        nativePath: 'C:\\fixture\\core-owned-child.node',
      });
      try {
        await witness.run(async () => {
          const host = createGitReadHostWith(
            {
              os: 'win32',
              environment: requestEnvironment(),
              probeDirectory: portable(repo),
            },
            { createRunner: () => target },
          );
          host.prewarm();
          await expect(
            target.run(
              { kind: 'git-dir', executable: portable(executable) },
              {
                cwd: portable(repo),
                environment: requestEnvironment(),
                deadlineAt: performance.now() + 10_000,
              },
            ),
          ).rejects.toMatchObject(UNCONTAINED_SPAWN_FAILURE);
          expect(await target.whenIdle(AbortSignal.abort())).toBe(
            unconfirmed ? 'pending' : 'idle',
          );
          await expect(host.stop(AbortSignal.abort())).resolves.toEqual({
            state: unconfirmed ? 'cleanup_unconfirmed' : 'stopped',
          });
        });
        expect(witness.accepts(witness.finalize())).toBe(false);
        expect(load).toHaveBeenCalledTimes(1);
      } finally {
        load.mockRestore();
        // Only fake native records exist; do not leave their host-exit hook installed.
        for (const listener of process.listeners('exit'))
          if (!listeners.has(listener))
            process.removeListener('exit', listener);
      }
    },
  );

  it('retries a failed load then loads one native addon per runner across sequential and concurrent repository reads, running uncontained meanwhile', async () => {
    const executable = path.join(dir, 'fixture-git.exe');
    writeFileSync(executable, 'not executed');
    const environments: (readonly string[])[] = [];
    const native = {
      spawn: (): void => undefined,
      observe: (): void => undefined,
      stopGroup: (): void => undefined,
      members: (): void => undefined,
      release: (): void => undefined,
      commit: (): void => undefined,
      rollbackSync: (): boolean => true,
      rollbackUndelivered: (): boolean => true,
      resume: (): void => undefined,
      launch: (
        _file: string,
        _args: readonly string[],
        environment: readonly string[],
      ): never => {
        environments.push(environment);
        throw Object.assign(new Error('fixture confirmed rollback'), {
          code: 'ERR_OWNED_CHILD_SPAWN',
        });
      },
    };
    const load = jest.spyOn(process, 'dlopen').mockImplementation((module) => {
      Object.assign(module, { exports: native });
    });
    load.mockImplementationOnce((): never => {
      throw new Error('fixture unavailable addon');
    });
    const target = runner({
      nativePath: 'C:\\fixture\\core-owned-child.node',
      createWindowsProcesses: undefined,
    });
    const read = (value: string): Promise<void> =>
      expect(
        target.run(
          { kind: 'git-dir', executable: portable(executable) },
          {
            cwd: portable(repo),
            environment: requestEnvironment({ FIXTURE_REQUEST: value }),
            deadlineAt: performance.now() + 10_000,
          },
        ),
      ).rejects.toMatchObject(UNCONTAINED_SPAWN_FAILURE);
    try {
      await expect(
        target.run(
          { kind: 'git-dir', executable: portable(executable) },
          {
            cwd: portable(repo),
            environment: requestEnvironment(),
            deadlineAt: performance.now() + 10_000,
          },
        ),
      ).rejects.toMatchObject(UNCONTAINED_SPAWN_FAILURE);
      expect(await target.whenIdle(AbortSignal.abort())).toBe('idle');
      expect(environments).toEqual([]);
      expect(load).toHaveBeenCalledTimes(1);
      await read('first');
      await Promise.all([read('second'), read('third')]);
      expect(load).toHaveBeenCalledTimes(2);
      expect(
        environments.map((env) =>
          env.find((pair) => pair.startsWith('FIXTURE_REQUEST=')),
        ),
      ).toEqual([
        'FIXTURE_REQUEST=first',
        'FIXTURE_REQUEST=second',
        'FIXTURE_REQUEST=third',
      ]);
      expect(await target.whenIdle(AbortSignal.abort())).toBe('idle');
    } finally {
      load.mockRestore();
    }
  });

  it('returns the read but never reports idle or accepted evidence after cleanup proof fails', async () => {
    const witness = createWindowsClosureWitness();
    const failure = new Error('injected lost cleanup proof');
    const reported: string[] = [];
    const command: GitReadCommand = {
      kind: 'git-dir',
      executable: portable(gitExecutable),
    };
    await witness.run(async () => {
      const target = runner({
        onKillCleanup: (outcome) => reported.push(outcome),
        createWindowsProcesses: (observe): PlatformExecutionProcessServices => {
          const services = processServices(observe);
          return {
            start: (request) => services.start(request),
            shutdown: async (): Promise<void> => {
              await services.shutdown();
              throw failure;
            },
          };
        },
      });
      // The injected failure models lost proof; the actual fixture job is stopped.
      runners.splice(runners.indexOf(target), 1);
      const host = createGitReadHostWith(
        {
          os: 'win32',
          environment: requestEnvironment(),
          probeDirectory: portable(repo),
        },
        { createRunner: () => target },
      );
      host.prewarm();
      await expect(
        target.run(command, {
          cwd: portable(repo),
          environment: requestEnvironment(),
          deadlineAt: performance.now() + 10_000,
        }),
      ).resolves.toMatchObject({
        code: 0,
        signal: null,
        stdout: git(...planGitReadCommand(os, command, environment()).args),
        pipes: 'closed',
      });
      expect(await target.whenIdle(AbortSignal.abort())).toBe('pending');
      expect(reported).toEqual(
        expect.arrayContaining(['failed', 'cleanup_unconfirmed']),
      );
      await expect(host.stop(AbortSignal.abort())).resolves.toEqual({
        state: 'cleanup_unconfirmed',
      });
    });
    expect(witness.accepts(witness.finalize())).toBe(false);
  });

  it('disables fsmonitor and external diff while preserving clean filters and rejecting surviving-helper evidence', async () => {
    git(
      'config',
      'core.fsmonitor',
      `${quote(process.execPath)} ${quote(helper)} forbidden`,
    );
    git(
      'config',
      'diff.external',
      `${quote(process.execPath)} ${quote(helper)} forbidden`,
    );
    git(
      'config',
      'filter.fixture.clean',
      `${quote(process.execPath)} ${quote(helper)} filter`,
    );
    writeFileSync(path.join(dir, '.gitattributes'), '*.dat filter=fixture\n');
    writeFileSync(path.join(dir, 'tracked.dat'), 'modified\n');
    const witness = createWindowsClosureWitness();
    await witness.run(async () => {
      const trackedFile: unknown = expect.stringContaining('tracked.dat');
      expect(
        await run(
          read({
            kind: 'diff-numstat',
            range: { kind: 'worktree', base: 'HEAD' },
          }),
          { FIXTURE_BEHAVIOR: 'survive' },
        ),
      ).toMatchObject({
        code: 0,
        stdout: trackedFile,
        pipes: 'closed',
      });
    });
    expect(existsSync(path.join(dir, 'record.json.forbidden'))).toBe(false);
    const survivor = record().survivor;
    expect(survivor).toBeGreaterThan(1);
    if (survivor === undefined)
      throw new Error('filter did not start its survivor');
    expect(() => process.kill(survivor, 0)).toThrow();
    expect(witness.accepts(witness.finalize())).toBe(false);
  }, 30_000);
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeEnvVars } from '@canopy/execution-engine/lib/mcp-security';
import { getLinuxProbeEnv } from '@canopy/execution-engine/pipelines/config-paths';
import {
  GIT_BRANCH_LIST_REF_ARGS,
  GIT_CONVENTIONAL_DEFAULT_BRANCHES,
  gitChangeSetReadArgs,
} from '@canopy/core-runtime/node/git';
import {
  AUDITED_GIT_FOR_WINDOWS,
  bareInitEnvironment,
  dischargesFsmonitor,
  readsWorkingTree,
  fsmonitorDischargeAudited,
  gitRepositoryCommandFor,
  type GitReadCommand,
  linuxProbeEnvironment,
  nonInteractiveEnvironment,
  planGitReadCommand,
  windowsChildEnvironment,
} from '../git-read/commands';

const ENV = Object.freeze({
  PATH: '/usr/bin',
  HOME: '/home/u',
  SHELL: '/bin/fish',
  GIT_DIR: '/elsewhere',
  NODE_OPTIONS: '--require x',
  ld_preload: 'x.so',
  DYLD_FALLBACK_LIBRARY_PATH: '/x',
  BASH_FUNC_f: '() { :; }',
  BASH_ENV: '/x',
  Env: '/x',
  shellopts: 'x',
  BASHOPTS: 'x',
  GCONV_PATH: '/x',
  GLIBC_TUNABLES: 'x',
  PYTHONPATH: '/x',
  pythonstartup: '/x',
  NODE_PATH: '/x',
  LANG: 'C',
});
const PROBE_ENV = { PATH: '/usr/bin', HOME: '/home/u', SHELL: '/bin/fish', GIT_DIR: '/elsewhere', LANG: 'C' }; // prettier-ignore
// `PATH` sorts before `Path`, so Node keeps `PATH` and drops `Path`.
const WIN_ENV = Object.freeze({
  SystemRoot: 'C:\\Windows',
  Path: 'C:\\Dropped',
  PATH: 'C:\\Git\\cmd;C:\\Windows\\System32',
  HOME: 'C:\\h',
  TEMP: '',
});
/** libuv's required keys the block lacks are added empty (D1). */
const WIN_CHILD_ENV = {
  SystemRoot: 'C:\\Windows',
  PATH: 'C:\\Git\\cmd;C:\\Windows\\System32',
  HOME: 'C:\\h',
  TEMP: '',
  HOMEDRIVE: '',
  HOMEPATH: '',
  LOGONSERVER: '',
  SYSTEMDRIVE: '',
  USERDOMAIN: '',
  USERNAME: '',
  USERPROFILE: '',
  WINDIR: '',
};
const MiB = 1024 * 1024;
const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};
const git = '/opt/git';
const AUDITED = 'git version 2.47.1.windows.2';

type Row<Command extends GitReadCommand = GitReadCommand> = [
  Command,
  file: string,
  args: string[],
  maxBuffer: number,
  timeoutMs: number | undefined,
  killMode: 'graceful' | 'force',
  env: Readonly<Record<string, string>>,
];

/** Desktop's values: git-executable.ts, config-paths.ts and git.ts:1535–1586. */
const input = new Uint8Array([0x61, 0, 0xff, 0]);
/** The supplied environment plus Git's non-interactive switches (D8). */
const NON_INTERACTIVE = { ...ENV, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }; // prettier-ignore
const CHANGE_SET_PREFIX = ['--no-optional-locks', '-c', 'core.fsmonitor='];
/** Change-set reads never fetch a partial clone's missing objects. */
const CHANGE_SET_ENV = { ...NON_INTERACTIVE, GIT_NO_LAZY_FETCH: '1' };
const OID = 'a'.repeat(40);
const OID256 = 'b'.repeat(64);
/**
 * The worker.git repository reads: desktop's argv, its 8 MiB runGit buffer,
 * desktop-shared's 30 s default-branch timeout and the health check's 5 s
 * execFile bound. Windows uses the same manifest under native job custody.
 */
const REPOSITORY_ROWS: Row<
  Extract<GitReadCommand, { readonly executable: string }>
>[] = [
  [{ kind: 'git-branch-refs', executable: git }, git, [...GIT_BRANCH_LIST_REF_ARGS], 8 * MiB, undefined, 'graceful', NON_INTERACTIVE], // prettier-ignore
  [{ kind: 'git-common-dir', executable: git }, git, ['rev-parse', '--git-common-dir'], 8 * MiB, undefined, 'graceful', NON_INTERACTIVE], // prettier-ignore
  [{ kind: 'git-worktree-list', executable: git }, git, ['worktree', 'list', '--porcelain'], 8 * MiB, undefined, 'graceful', NON_INTERACTIVE], // prettier-ignore
  [{ kind: 'git-origin-url', executable: git }, git, ['remote', 'get-url', 'origin'], 8 * MiB, undefined, 'graceful', NON_INTERACTIVE], // prettier-ignore
  [{ kind: 'git-remote-names', executable: git }, git, ['remote'], 8 * MiB, undefined, 'graceful', NON_INTERACTIVE], // prettier-ignore
  [{ kind: 'git-dir', executable: git }, git, ['rev-parse', '--git-dir'], 8 * MiB, undefined, 'graceful', NON_INTERACTIVE], // prettier-ignore
  [{ kind: 'git-remote-head', executable: git }, git, ['ls-remote', '--symref', 'origin', 'HEAD'], 8 * MiB, 30_000, 'force', NON_INTERACTIVE], // prettier-ignore
  [{ kind: 'git-origin-head', executable: git }, git, ['symbolic-ref', 'refs/remotes/origin/HEAD'], 8 * MiB, 30_000, 'force', NON_INTERACTIVE], // prettier-ignore
  [{ kind: 'git-origin-branch', executable: git, branch: 'develop' }, git, ['rev-parse', '--verify', 'refs/remotes/origin/develop'], 8 * MiB, 30_000, 'graceful', NON_INTERACTIVE], // prettier-ignore
  [{ kind: 'git-inside-work-tree', executable: git }, git, ['rev-parse', '--is-inside-work-tree'], MiB, 5000, 'graceful', NON_INTERACTIVE], // prettier-ignore
  // CAN-4103's change-set reads: the engine's argv after no optional locks
  // and no fsmonitor, diffs without an external driver, no lazy fetch, and
  // desktop's 32 MiB gitChangeSetReads buffer under the request deadline alone.
  [{ kind: 'git-diff-name-status', executable: git, range: { kind: 'worktree', base: 'HEAD' } }, git, [...CHANGE_SET_PREFIX, 'diff', 'HEAD', '--name-status', '-z', '--find-renames', '--find-copies', '--no-ext-diff'], 32 * MiB, undefined, 'graceful', CHANGE_SET_ENV], // prettier-ignore
  [{ kind: 'git-diff-numstat', executable: git, range: { kind: 'objects', base: OID, head: OID256 } }, git, [...CHANGE_SET_PREFIX, 'diff', `${OID}..${OID256}`, '--numstat', '-z', '--find-renames', '--find-copies', '--no-ext-diff'], 32 * MiB, undefined, 'graceful', CHANGE_SET_ENV], // prettier-ignore
  [{ kind: 'git-untracked-files', executable: git }, git, [...CHANGE_SET_PREFIX, 'ls-files', '--others', '--exclude-standard', '-z'], 32 * MiB, undefined, 'graceful', CHANGE_SET_ENV], // prettier-ignore
  [{ kind: 'git-unmerged-files', executable: git }, git, [...CHANGE_SET_PREFIX, 'ls-files', '--unmerged', '-z'], 32 * MiB, undefined, 'graceful', CHANGE_SET_ENV], // prettier-ignore
  [{ kind: 'git-object-exists', executable: git, object: OID }, git, [...CHANGE_SET_PREFIX, 'rev-parse', '--verify', '--quiet', `${OID}^{object}`], 32 * MiB, undefined, 'graceful', CHANGE_SET_ENV], // prettier-ignore
];
const TABLE: Record<'darwin' | 'linux' | 'win32', Row[]> = {
  darwin: [
    [{ kind: 'git-version', executable: git }, git, ['--version'], MiB, 5000, 'graceful', ENV], // prettier-ignore
    [{ kind: 'git-check-ignore', executable: 'git', input }, 'git', ['check-ignore', '-z', '--stdin'], 8 * MiB, undefined, 'graceful', ENV], // prettier-ignore
    [{ kind: 'git-ls-files-ignored', executable: 'git' }, 'git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], 64 * MiB, undefined, 'graceful', ENV], // prettier-ignore
    [{ kind: 'xcode-select-print-path' }, '/usr/bin/xcode-select', ['--print-path'], 4096, 5000, 'graceful', ENV], // prettier-ignore
    [{ kind: 'macos-login-shell-path' }, '/bin/fish', ['-lic', 'exec /usr/bin/printf \'%s\\n\' "$PATH"'], MiB, 10_000, 'force', ENV], // prettier-ignore
    ...REPOSITORY_ROWS,
  ],
  linux: [
    [{ kind: 'git-version', executable: git }, git, ['--version'], MiB, 5000, 'force', PROBE_ENV], // prettier-ignore
    [{ kind: 'git-check-ignore', executable: 'git', input }, 'git', ['check-ignore', '-z', '--stdin'], 8 * MiB, undefined, 'graceful', ENV], // prettier-ignore
    [{ kind: 'git-ls-files-ignored', executable: 'git' }, 'git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], 64 * MiB, undefined, 'graceful', ENV], // prettier-ignore
    [{ kind: 'linux-login-shell-path', shell: '/bin/bash' }, '/bin/bash', ['-lic', 'exec /usr/bin/printf \'__CANOPY_LOGIN_PATH__%s\\n\' "$PATH"'], 64 * 1024, 10_000, 'force', PROBE_ENV], // prettier-ignore
    [{ kind: 'getent-passwd', uid: 501 }, '/usr/bin/getent', ['passwd', '501'], 16 * 1024, 1000, 'force', PROBE_ENV], // prettier-ignore
    ...REPOSITORY_ROWS,
  ],
  win32: [
    ...REPOSITORY_ROWS.map(
      ([command, , args, maxBuffer, timeoutMs, killMode, env]): Row => [
        { ...command, executable: 'git.exe' },
        'git.exe',
        args,
        maxBuffer,
        timeoutMs,
        killMode,
        windowsChildEnvironment({
          ...WIN_ENV,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          ...(env.GIT_NO_LAZY_FETCH ? { GIT_NO_LAZY_FETCH: '1' } : {}),
        }),
      ],
    ),
    [{ kind: 'git-version', executable: 'C:\\Git\\cmd\\git.exe' }, 'C:\\Git\\cmd\\git.exe', ['--version'], MiB, 5000, 'graceful', WIN_CHILD_ENV], // prettier-ignore
    // Fsmonitor off for an audited Git for Windows: no daemon outlives the request (C1 audit).
    [{ kind: 'git-check-ignore', executable: 'git.exe', input, version: AUDITED }, 'git.exe', ['-c', 'core.fsmonitor=false', 'check-ignore', '-z', '--stdin'], 8 * MiB, undefined, 'graceful', WIN_CHILD_ENV], // prettier-ignore
    // The ignored listing reads the working tree too, so it carries the same discharge.
    [{ kind: 'git-ls-files-ignored', executable: 'git.exe', version: AUDITED }, 'git.exe', ['-c', 'core.fsmonitor=false', ...['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']], 64 * MiB, undefined, 'graceful', WIN_CHILD_ENV], // prettier-ignore
    // The runner resolves a bare name through the supplied PATH alone (D2).
    [{ kind: 'where-git' }, 'where.exe', ['git'], MiB, 5000, 'graceful', WIN_CHILD_ENV], // prettier-ignore
    [{ kind: 'where-winget' }, 'where.exe', ['winget'], MiB, 5000, 'graceful', WIN_CHILD_ENV], // prettier-ignore
  ],
};

describe.each(Object.keys(TABLE) as (keyof typeof TABLE)[])(
  '%s command table',
  (os) => {
    it.each(TABLE[os].map((row) => [row[0].kind, row] as const))(
      '%s',
      (_, [command, file, args, maxBuffer, timeoutMs, killMode, env]) => {
        const plan = planGitReadCommand(
          os,
          command,
          os === 'win32' ? WIN_ENV : ENV,
        );
        expect(plan).toEqual({
          file,
          args,
          env,
          maxBuffer,
          timeoutMs,
          killMode,
          input: command.kind === 'git-check-ignore' ? input : undefined,
        });
        expect(Object.isFrozen(plan.env)).toBe(true);
      },
    );

    it('rejects every command outside its host', () => {
      const listed = new Set(TABLE[os].map(([command]) => command.kind));
      if (os === 'darwin') listed.add('git-bare-init-smoke');
      const all: GitReadCommand[] = [
        { kind: 'git-version', executable: git },
        { kind: 'git-bare-init-smoke', executable: git, temporaryRoot: '/t' },
        { kind: 'git-check-ignore', executable: git, input },
        { kind: 'git-ls-files-ignored', executable: git },
        { kind: 'xcode-select-print-path' },
        { kind: 'macos-login-shell-path' },
        { kind: 'linux-login-shell-path', shell: '/bin/bash' },
        { kind: 'getent-passwd', uid: 1 },
        { kind: 'where-git' },
        ...REPOSITORY_ROWS.map(([command]) => command),
      ];
      for (const command of all.filter(({ kind }) => !listed.has(kind)))
        expect(
          thrown(
            () =>
            planGitReadCommand(os, command, os === 'win32' ? WIN_ENV : ENV, '/t/x'), // prettier-ignore
          ),
        ).toMatchObject({ code: 'unsupported_command' });
    });
  },
);

describe('fsmonitor discharge', () => {
  it.each([
    [['-c', 'core.fsmonitor=false', 'check-ignore'], true],
    [['check-ignore', '-z', '--stdin'], false],
    [['-c', 'core.fsmonitor=true', 'check-ignore'], false],
    [['-c', 'core.fsmonitor=0', 'check-ignore'], false],
    [['-c'], false],
    [[], false],
    [['check-ignore', '-c', 'core.fsmonitor=false'], false],
  ])('%j discharges: %s', (args, expected) => {
    expect(dischargesFsmonitor(args)).toBe(expected);
  });

  it('counts only audited Git for Windows releases', () => {
    expect(AUDITED_GIT_FOR_WINDOWS).toEqual({ min: 36, max: 56 });
    for (const [version, audited] of [
      ['git version 2.36.0.windows.1', true],
      [AUDITED, true],
      ['git version 2.56.0.windows.2', true],
      ['git version 2.35.1.windows.1', false],
      ['git version 2.35.3.windows.1', false],
      ['git version 2.57.0.windows.1', false],
      ['git version 2.47.1', false],
      ['git version 3.0.0.windows.1', false],
      ['git version 2.47.1.windows.1 ', false],
      // Not Git for Windows release sources: microsoft/git, a release
      // candidate, a snapshot build.
      ['git version 2.47.0.vfs.0.1', false],
      ['git version 2.48.0-rc1.windows.1', false],
      ['git version 2.47.1.windows.1.1.g1a2b3c4', false],
      ['', false],
      [undefined, false],
      [47, false],
    ] as const)
      expect([version, fsmonitorDischargeAudited(version)]).toEqual([version, audited]); // prettier-ignore
  });

  const checkIgnore = (
    executable: string,
    version: string | undefined,
  ): GitReadCommand => ({
    kind: 'git-check-ignore',
    executable,
    input,
    ...(version === undefined ? {} : { version }),
  });

  it('only audited Git for Windows check-ignore plans carry it', () => {
    for (const [executable, version, discharged] of [
      ['git.exe', AUDITED, true],
      ['git', AUDITED, true],
      ['C:\\Program Files\\Git\\cmd\\GIT.EXE', AUDITED, true],
      ['C:\\Program Files\\nodejs\\node.exe', AUDITED, false],
      ['C:\\tools\\git.cmd', AUDITED, false],
      ['C:\\tools\\git.exe.bak', AUDITED, false],
      // 2.35 reads `core.fsmonitor=false` as a hook path.
      ['C:\\Git\\cmd\\git.exe', 'git version 2.35.1.windows.1', false],
      ['C:\\Git\\cmd\\git.exe', 'git version 2.57.0.windows.1', false],
      ['C:\\Git\\cmd\\git.exe', 'git version 2.47.0.vfs.0.1', false],
      ['C:\\Git\\cmd\\git.exe', 'git version 2.48.0-rc1.windows.1', false],
      ['C:\\Git\\cmd\\git.exe', undefined, false],
    ] as const) {
      const { args } = planGitReadCommand('win32', checkIgnore(executable, version), WIN_ENV); // prettier-ignore
      expect([executable, version, dischargesFsmonitor(args)]).toEqual([executable, version, discharged]); // prettier-ignore
      expect(args.slice(discharged ? 2 : 0)).toEqual(['check-ignore', '-z', '--stdin']); // prettier-ignore
    }
  });

  it('discharges the ignored listing exactly as check-ignore', () => {
    for (const [executable, version, discharged] of [
      ['git.exe', AUDITED, true],
      ['C:\\Program Files\\Git\\cmd\\GIT.EXE', AUDITED, true],
      ['C:\\tools\\git.cmd', AUDITED, false],
      ['C:\\Git\\cmd\\git.exe', 'git version 2.35.1.windows.1', false],
      ['C:\\Git\\cmd\\git.exe', undefined, false],
    ] as const) {
      const listing: GitReadCommand = {
        kind: 'git-ls-files-ignored',
        executable,
        ...(version === undefined ? {} : { version }),
      };
      const { args } = planGitReadCommand('win32', listing, WIN_ENV);
      expect([executable, dischargesFsmonitor(args)]).toEqual([executable, discharged]); // prettier-ignore
      expect(args.slice(discharged ? 2 : 0)).toEqual(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']); // prettier-ignore
      expect(dischargesFsmonitor(planGitReadCommand('win32', checkIgnore(executable, version), WIN_ENV).args)).toBe(discharged); // prettier-ignore
    }
    for (const os of ['darwin', 'linux'] as const)
      expect(
        planGitReadCommand(os, { kind: 'git-ls-files-ignored', executable: 'git', version: AUDITED }, ENV).args, // prettier-ignore
      ).toEqual([
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '-z',
      ]);
    expect(readsWorkingTree('git-ls-files-ignored')).toBe(true);
    expect(readsWorkingTree('git-check-ignore')).toBe(true);
    expect(readsWorkingTree('git-version')).toBe(false);
  });

  it('leaves POSIX argv unchanged whatever the version', () => {
    for (const os of ['darwin', 'linux'] as const)
      for (const version of [
        AUDITED,
        'git version 2.35.1.windows.1',
        undefined,
      ])
        expect(
          planGitReadCommand(os, checkIgnore('git', version), ENV).args,
        ).toEqual(['check-ignore', '-z', '--stdin']);
  });
});

describe('repository reads', () => {
  const READS = [
    { kind: 'branch-refs' },
    { kind: 'common-dir' },
    { kind: 'worktree-list' },
    { kind: 'origin-url' },
    { kind: 'remote-names' },
    { kind: 'git-dir' },
    { kind: 'remote-head' },
    { kind: 'origin-head' },
    ...GIT_CONVENTIONAL_DEFAULT_BRANCHES.map((branch) => ({
      kind: 'origin-branch',
      branch,
    })),
    { kind: 'inside-work-tree' },
    { kind: 'diff-name-status', range: { kind: 'worktree', base: 'HEAD' } },
    { kind: 'diff-name-status', range: { kind: 'worktree', base: OID } },
    { kind: 'diff-numstat', range: { kind: 'objects', base: OID, head: 'HEAD' } }, // prettier-ignore
    { kind: 'untracked-files' },
    { kind: 'unmerged-files' },
    { kind: 'object-exists', object: 'HEAD' },
    { kind: 'object-exists', object: OID256 },
  ];

  it('maps each read to exactly one fixed POSIX command', () => {
    const planned = READS.map((read) => {
      const command = gitRepositoryCommandFor('linux', read)(git);
      return planGitReadCommand('linux', command, ENV).args.join(' ');
    });
    expect(planned).toEqual([
      GIT_BRANCH_LIST_REF_ARGS.join(' '),
      'rev-parse --git-common-dir',
      'worktree list --porcelain',
      'remote get-url origin',
      'remote',
      'rev-parse --git-dir',
      'ls-remote --symref origin HEAD',
      'symbolic-ref refs/remotes/origin/HEAD',
      'rev-parse --verify refs/remotes/origin/main',
      'rev-parse --verify refs/remotes/origin/master',
      'rev-parse --verify refs/remotes/origin/develop',
      'rev-parse --is-inside-work-tree',
      ...[
        'diff HEAD --name-status -z --find-renames --find-copies --no-ext-diff',
        `diff ${OID} --name-status -z --find-renames --find-copies --no-ext-diff`,
        `diff ${OID}..HEAD --numstat -z --find-renames --find-copies --no-ext-diff`,
        'ls-files --others --exclude-standard -z',
        'ls-files --unmerged -z',
        'rev-parse --verify --quiet HEAD^{object}',
        `rev-parse --verify --quiet ${OID256}^{object}`,
      ].map((args) => `--no-optional-locks -c core.fsmonitor= ${args}`),
    ]);
  });

  it('runs the change-set reads with the engine argv the desktop runs, after the prefix', () => {
    for (const read of [
      { kind: 'diff-name-status', range: { kind: 'objects', base: OID, head: OID256 } }, // prettier-ignore
      { kind: 'untracked-files' },
      { kind: 'object-exists', object: 'HEAD' },
    ] as const) {
      const { args } = planGitReadCommand('darwin', gitRepositoryCommandFor('darwin', read)(git), ENV); // prettier-ignore
      const engine = gitChangeSetReadArgs(read);
      expect(args.slice(0, CHANGE_SET_PREFIX.length + engine.length)).toEqual([...CHANGE_SET_PREFIX, ...engine]); // prettier-ignore
    }
  });

  it('copies a validated range, so a later change to the request cannot reach Git', () => {
    const range = { kind: 'worktree', base: 'HEAD' };
    const command = gitRepositoryCommandFor('linux', { kind: 'diff-numstat', range })(git); // prettier-ignore
    range.base = '--output=/tmp/x';
    expect(planGitReadCommand('linux', command, ENV).args).toContain('HEAD');
    expect(Reflect.get(command, 'range')).not.toBe(range);
  });

  it('admits the exact repository manifest on win32 with unchanged argv and limits', () => {
    for (const read of READS)
      expect(gitRepositoryCommandFor('win32', read)('git.exe').kind).toBe(
        gitRepositoryCommandFor('linux', read)('git').kind,
      );
    for (const [command, , args, maxBuffer, timeoutMs] of REPOSITORY_ROWS)
      expect(
        planGitReadCommand(
          'win32',
          { ...command, executable: 'git.exe' },
          WIN_ENV,
        ),
      ).toMatchObject({ args, maxBuffer, timeoutMs });
  });

  it.each<[string, unknown]>([
    ['an unknown read', { kind: 'set-head' }],
    ['a free command', { kind: 'git', args: ['remote', 'set-head'] }],
    ['an inherited kind', { kind: 'toString' }],
    ['no read', undefined],
    [
      'a branch outside the enum',
      { kind: 'origin-branch', branch: 'main; rm' },
    ],
    ['a missing branch', { kind: 'origin-branch' }],
    // Change-set revisions are HEAD or a full lowercase object id, only.
    ...(
      [
        'main',
        'refs/heads/main',
        'HEAD~1',
        'HEAD^{tree}',
        `${OID}..${OID}`,
        '--output=/tmp/x',
        '-p',
        'A'.repeat(40),
        'a'.repeat(39),
        'a'.repeat(41),
        'head',
        'WORKTREE',
        '',
        42,
        undefined,
      ] as const
    ).flatMap((base): [string, unknown][] => [
      [`a worktree base ${String(base)}`, { kind: 'diff-name-status', range: { kind: 'worktree', base } }], // prettier-ignore
      [`an object ${String(base)}`, { kind: 'object-exists', object: base }],
      [`an objects head ${String(base)}`, { kind: 'diff-numstat', range: { kind: 'objects', base: OID, head: base } }], // prettier-ignore
    ]),
    ['HEAD as an objects base', { kind: 'diff-numstat', range: { kind: 'objects', base: 'HEAD', head: OID } }], // prettier-ignore
    ['a range of another kind', { kind: 'diff-numstat', range: { kind: 'no-index', base: OID } }], // prettier-ignore
    ['a missing range', { kind: 'diff-name-status' }],
    ['a range string', { kind: 'diff-name-status', range: 'HEAD' }],
  ])('rejects %s', (_, read) => {
    expect(thrown(() => gitRepositoryCommandFor('darwin', read))).toMatchObject({ code: 'invalid_request' }); // prettier-ignore
  });

  it('rejects a branch outside the enum at planning too', () => {
    const command: GitReadCommand = { kind: 'git-origin-branch', executable: git, branch: 'main' }; // prettier-ignore
    Reflect.set(command, 'branch', 'x');
    expect(thrown(() => planGitReadCommand('darwin', command, ENV))).toMatchObject({ code: 'invalid_request' }); // prettier-ignore
  });

  it('rejects a change-set revision outside HEAD and object ids at planning too', () => {
    const commands: GitReadCommand[] = [
      { kind: 'git-object-exists', executable: git, object: 'HEAD' },
      { kind: 'git-diff-name-status', executable: git, range: { kind: 'worktree', base: 'HEAD' } }, // prettier-ignore
      { kind: 'git-diff-numstat', executable: git, range: { kind: 'objects', base: OID, head: 'HEAD' } }, // prettier-ignore
    ];
    Reflect.set(commands[0] ?? {}, 'object', '--output=/tmp/x');
    Reflect.set(Reflect.get(commands[1] ?? {}, 'range'), 'base', 'main');
    Reflect.set(Reflect.get(commands[2] ?? {}, 'range'), 'base', 'HEAD');
    for (const command of commands)
      expect(thrown(() => planGitReadCommand('linux', command, ENV))).toMatchObject({ code: 'invalid_request' }); // prettier-ignore
  });

  it('adds only the non-interactive switches, overriding supplied values', () => {
    expect(
      nonInteractiveEnvironment({ PATH: '/bin', GIT_TERMINAL_PROMPT: '1' }),
    ).toEqual({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }); // prettier-ignore
  });
});

describe('command inputs', () => {
  it('builds the macOS bare-init smoke against a scratch directory', () => {
    const command = {
      kind: 'git-bare-init-smoke',
      executable: git,
      temporaryRoot: '/tmp',
    } as const;
    const plan = planGitReadCommand('darwin', command, ENV, '/tmp/git-v-1');
    expect(plan).toMatchObject({
      file: git,
      args: ['-c', 'init.templateDir=', 'init', '--bare', '/tmp/git-v-1'],
      maxBuffer: 8192,
      timeoutMs: 5000,
      killMode: 'graceful',
    });
    expect(plan.env).toEqual(bareInitEnvironment(ENV));
    expect(() => planGitReadCommand('darwin', command, ENV)).toThrow(
      'Git read request is invalid.',
    );
  });

  it('falls back to /bin/zsh for an unset or empty macOS SHELL', () => {
    const command = { kind: 'macos-login-shell-path' } as const;
    const envs: Record<string, string>[] = [{}, { SHELL: '' }];
    for (const env of envs)
      expect(planGitReadCommand('darwin', command, env).file).toBe('/bin/zsh');
  });

  it.each<[string, GitReadCommand]>([
    ['empty executable', { kind: 'git-version', executable: '' }],
    ['NUL executable', { kind: 'git-version', executable: 'g\0it' }],
    ['relative shell', { kind: 'linux-login-shell-path', shell: 'bash' }],
    ['newline shell', { kind: 'linux-login-shell-path', shell: '/bin/b\nsh' }],
    ['negative uid', { kind: 'getent-passwd', uid: -1 }],
    ['fractional uid', { kind: 'getent-passwd', uid: 1.5 }],
  ])('rejects %s', (_, command) => {
    expect(thrown(() => planGitReadCommand('linux', command, ENV))).toMatchObject({ code: 'invalid_request' }); // prettier-ignore
  });
});

// Spawn resolves a relative command against the cwd, and without PATH through
// the host's PATH (Windows) or a fixed default (POSIX). D2: only a bare name,
// searched on the supplied PATH by the runner.
describe('relative command resolution', () => {
  const where = { kind: 'where-git' } as const;
  const relativeGit = (executable: string): GitReadCommand => ({
    kind: 'git-check-ignore',
    executable,
    input,
  });
  const WIN = { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' };

  it.each<
    [
      string,
      'darwin' | 'linux' | 'win32',
      GitReadCommand,
      Record<string, string>,
    ]
  >([
    ['bare where.exe without PATH', 'win32', where, { SystemRoot: 'C:\\Windows' }], // prettier-ignore
    ['bare where.exe with an empty PATH', 'win32', where, { SystemRoot: 'C:\\Windows', Path: '' }], // prettier-ignore
    // Node keeps the first key in sort order: `PATH` precedes `Path`.
    ['bare where.exe whose kept PATH is empty', 'win32', where, { SystemRoot: 'C:\\Windows', Path: 'C:\\Git\\cmd', PATH: '' }], // prettier-ignore
    ['bare where.exe whose PATH has only relative entries', 'win32', where, { SystemRoot: 'C:\\Windows', PATH: 'bin;.;C:relative' }], // prettier-ignore
    ['a relative Windows git without PATH', 'win32', relativeGit('git.exe'), { SystemRoot: 'C:\\Windows', HOME: 'C:\\h' }], // prettier-ignore
    ['a drive-relative Windows git', 'win32', relativeGit('C:git.exe'), WIN],
    ['a rooted Windows git without a drive', 'win32', relativeGit('\\Git\\git.exe'), WIN], // prettier-ignore
    ['a dot-relative Windows git', 'win32', relativeGit('.\\git.exe'), WIN],
    ['a Windows git in a subdirectory', 'win32', relativeGit('sub\\git.exe'), WIN], // prettier-ignore
    ['a forward-slash Windows git in a subdirectory', 'win32', relativeGit('sub/git.exe'), WIN], // prettier-ignore
    ['a relative macOS git without PATH', 'darwin', relativeGit('git'), { HOME: '/h' }], // prettier-ignore
    ['a relative Linux git with an empty PATH', 'linux', { kind: 'git-version', executable: 'git' }, { PATH: '' }], // prettier-ignore
    // Empty and relative entries name the cwd.
    ['a relative Linux git whose PATH has only empty and relative entries', 'linux', relativeGit('git'), { PATH: ':bin:.' }], // prettier-ignore
    // POSIX keys are case-sensitive.
    ['a relative Linux git with only a lowercase path', 'linux', relativeGit('git'), { path: '/usr/bin' }], // prettier-ignore
    ['a dot-relative Linux git', 'linux', relativeGit('./git'), { PATH: '/usr/bin' }], // prettier-ignore
    ['a Linux git in a subdirectory', 'linux', relativeGit('bin/git'), { PATH: '/usr/bin' }], // prettier-ignore
    ['a parent-directory Linux git', 'linux', relativeGit('..'), { PATH: '/usr/bin' }], // prettier-ignore
    ['a relative macOS SHELL without PATH', 'darwin', { kind: 'macos-login-shell-path' }, { SHELL: 'zsh' }], // prettier-ignore
    ['a macOS SHELL in a subdirectory', 'darwin', { kind: 'macos-login-shell-path' }, { SHELL: 'bin/zsh', PATH: '/bin' }], // prettier-ignore
    ['a relative bare-init git without PATH', 'darwin', { kind: 'git-bare-init-smoke', executable: 'git', temporaryRoot: '/t' }, {}], // prettier-ignore
  ])('rejects %s', (_, os, command, env) => {
    expect(
      thrown(() => planGitReadCommand(os, command, env, '/t/x')),
    ).toMatchObject({ code: 'invalid_request' });
  });

  it.each<
    [
      string,
      'darwin' | 'linux' | 'win32',
      GitReadCommand,
      Record<string, string>,
    ]
  >([
    ['bare where.exe with a mixed-case Path', 'win32', where, { SystemRoot: 'C:\\Windows', Path: 'C:\\Git\\cmd' }], // prettier-ignore
    ['bare where.exe whose kept PATH is set', 'win32', where, { SystemRoot: 'C:\\Windows', PATH: 'C:\\Git\\cmd', Path: '' }], // prettier-ignore
    ['bare where.exe on a quoted PATH entry', 'win32', where, { SystemRoot: 'C:\\Windows', PATH: '"C:\\Program Files\\Git\\cmd"' }], // prettier-ignore
    ['bare where.exe on a quoted PATH entry containing ;', 'win32', where, { SystemRoot: 'C:\\Windows', PATH: '"C:\\Git;cmd"' }], // prettier-ignore
    ['a bare Windows git', 'win32', relativeGit('git'), WIN],
    ['an absolute Windows git', 'win32', { kind: 'git-version', executable: 'C:\\Git\\cmd\\git.exe' }, WIN], // prettier-ignore
    ['a UNC Windows git', 'win32', relativeGit('\\\\server\\share\\git.exe'), WIN], // prettier-ignore
    ['an absolute Linux git without PATH', 'linux', { kind: 'git-version', executable: '/usr/bin/git' }, {}], // prettier-ignore
    ['the fixed macOS probes without PATH', 'darwin', { kind: 'xcode-select-print-path' }, {}], // prettier-ignore
    ['getent without PATH', 'linux', { kind: 'getent-passwd', uid: 1 }, {}],
    ['a relative Linux git with PATH', 'linux', relativeGit('git'), { PATH: '/usr/bin' }], // prettier-ignore
    ['a relative Linux git whose PATH has one absolute entry', 'linux', relativeGit('git'), { PATH: ':bin:/usr/bin' }], // prettier-ignore
    ['a bare macOS SHELL with PATH', 'darwin', { kind: 'macos-login-shell-path' }, { SHELL: 'zsh', PATH: '/bin' }], // prettier-ignore
  ])('plans %s', (_, os, command, env) => {
    expect(() => planGitReadCommand(os, command, env, '/t/x')).not.toThrow();
  });
});

// D1: libuv copies each required key a Windows block lacks from the host.
describe('Windows child environment', () => {
  const absoluteGit = {
    kind: 'git-version',
    executable: 'C:\\Git\\cmd\\git.exe',
  } as const;

  it('adds each absent libuv-required key empty and keeps the supplied values', () => {
    expect(windowsChildEnvironment(WIN_ENV)).toEqual(WIN_CHILD_ENV);
    expect(Object.isFrozen(windowsChildEnvironment(WIN_ENV))).toBe(true);
  });

  it('matches keys case-insensitively and keeps the variant Node keeps', () => {
    const child = windowsChildEnvironment({
      systemroot: 'C:\\Win',
      windir: 'C:\\Win',
      Path: 'C:\\Git',
      PATH: 'C:\\Kept',
      temp: 'C:\\b',
      TEMP: 'C:\\a',
    });
    expect(child).toEqual({
      systemroot: 'C:\\Win',
      windir: 'C:\\Win',
      PATH: 'C:\\Kept',
      TEMP: 'C:\\a',
      HOMEDRIVE: '',
      HOMEPATH: '',
      LOGONSERVER: '',
      SYSTEMDRIVE: '',
      USERDOMAIN: '',
      USERNAME: '',
      USERPROFILE: '',
    });
  });

  it.each<[string, Record<string, string>]>([
    ['no PATH', { SystemRoot: 'C:\\Windows' }],
    ['an empty PATH', { SystemRoot: 'C:\\Windows', PATH: '' }],
    ['a PATH of only relative entries', { SystemRoot: 'C:\\Windows', PATH: 'bin;;C:rel' }], // prettier-ignore
    ['an empty kept PATH variant', { SystemRoot: 'C:\\Windows', PATH: '', Path: 'C:\\Git' }], // prettier-ignore
    // libuv reads one relative entry, `bin;C:\Git`, from the quotes.
    ['a PATH whose only absolute text is inside a quoted relative entry', { SystemRoot: 'C:\\Windows', PATH: '"bin;C:\\Git"' }], // prettier-ignore
    ['no SystemRoot', { PATH: 'C:\\Windows\\System32' }],
    ['an empty SystemRoot', { SystemRoot: '', PATH: 'C:\\Windows\\System32' }],
    ['a relative SystemRoot', { SystemRoot: 'Windows', PATH: 'C:\\Windows\\System32' }], // prettier-ignore
    ['a forward-slash SystemRoot', { SystemRoot: 'C:/Windows', PATH: 'C:\\Windows\\System32' }], // prettier-ignore
    ['a UNC SystemRoot', { SystemRoot: '\\\\server\\Windows', PATH: 'C:\\Windows\\System32' }], // prettier-ignore
    ['a SystemRoot with a control character', { SystemRoot: 'C:\\Win\ndows', PATH: 'C:\\Windows\\System32' }], // prettier-ignore
    // `SYSTEMROOT` precedes `SystemRoot`: the child would see an empty value.
    ['an empty kept SystemRoot variant', { SYSTEMROOT: '', SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' }], // prettier-ignore
  ])('rejects %s, even for an absolute command', (_, env) => {
    expect(thrown(() => windowsChildEnvironment(env))).toMatchObject({
      code: 'invalid_request',
    });
    expect(
      thrown(() => planGitReadCommand('win32', absoluteGit, env)),
    ).toMatchObject({ code: 'invalid_request' });
  });

  it('leaves POSIX environments as supplied', () => {
    const env = { PATH: '/usr/bin' };
    const command = { kind: 'git-version', executable: '/usr/bin/git' } as const; // prettier-ignore
    expect(planGitReadCommand('darwin', command, env).env).toBe(env);
  });
});

describe('environments', () => {
  it('bare-init drops GIT_* and pins isolated config', () => {
    expect(
      bareInitEnvironment({ GIT_DIR: '/x', git_dir: '/y', HOME: '/h' }),
    ).toEqual({
      git_dir: '/y',
      HOME: '/h',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  // Golden (C3): the daemon cannot import desktop-shared, so pin parity here.
  it('matches desktop getLinuxProbeEnv and sanitizeEnvVars', () => {
    const saved = process.env;
    process.env = { ...ENV };
    try {
      expect(linuxProbeEnvironment(ENV)).toEqual(getLinuxProbeEnv());
    } finally {
      process.env = saved;
    }
    expect(linuxProbeEnvironment(ENV)).toEqual(PROBE_ENV);
    const blocked = Object.fromEntries(
      ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'PYTHONSTARTUP', 'PYTHONPATH', 'KEEP'] // prettier-ignore
        .flatMap((key) => [key, key.toLowerCase()])
        .map((key) => [key, 'x']),
    );
    const desktop = sanitizeEnvVars(blocked);
    expect(desktop).toEqual({ KEEP: 'x', keep: 'x' });
    expect(linuxProbeEnvironment(blocked)).toEqual(desktop);
  });

  /** String literals of the first `[...]` after `anchor` in a desktop package source. */
  function desktopKeys(
    file: string,
    anchor: string,
    pkg = 'desktop-shared',
  ): string[] {
    const source = readFileSync(
      join(__dirname, '../../..', pkg, 'src', file),
      'utf8',
    );
    const open = source.indexOf('[', source.indexOf(anchor));
    const list = source.slice(open, source.indexOf(']', open));
    return Array.from(list.matchAll(/'([^']+)'/g), ([, key = '']) => key);
  }

  // A key desktop adds to either list must fail here until it is mirrored.
  it('drops every key desktop drops, read from desktop source', () => {
    const blocked = desktopKeys(
      'lib/mcp-security.ts',
      'BLOCKED_ENV_KEYS =',
      'execution-engine',
    );
    const startup = desktopKeys(
      'pipelines/config-paths.ts',
      "startsWith('BASH_FUNC_')",
      'execution-engine',
    );
    expect(blocked).toContain('NODE_OPTIONS');
    expect(startup).toContain('GLIBC_TUNABLES');
    const env = Object.fromEntries(
      [...blocked, ...startup, 'KEEP']
        .flatMap((key) => [key, key.toLowerCase()])
        .map((key) => [key, 'x']),
    );
    const saved = process.env;
    process.env = { ...env };
    try {
      const desktop = getLinuxProbeEnv();
      expect(desktop).toEqual({ KEEP: 'x', keep: 'x' });
      expect(linuxProbeEnvironment(env)).toEqual(desktop);
    } finally {
      process.env = saved;
    }
  });
});

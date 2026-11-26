import { createWindowsClosureWitness } from '../supervision/windows-closure';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type * as Runtime from '@canopy/core-runtime';
import { createSecureFileServices } from '../secure-files';
import {
  readWindowsAcl,
  readWindowsAclSync,
  evaluateWindowsAcl,
  windowsAclEnvironment,
} from '../secure-files/windows-acl';

const USER = 'S-1-5-21-1-2-3-1001';
const nativeIt = process.platform === 'win32' ? it : it.skip;
const SID_COMMAND =
  '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value';
type Kind = Runtime.PlatformPermissionRequest['kind'];
type Ace = { readonly type: number; readonly sid: string | null };
const allow = (...sids: string[]): Ace[] =>
  sids.map((sid) => ({ type: 0, sid }));
const receipt = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ...{ user: USER, owner: USER, reparse: false, directory: false },
    ...{ dacl: true, aces: allow(USER), ...overrides },
  });

let dir = '';
let target = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'windows-acl-'));
  target = path.join(dir, 'token');
  await fs.writeFile(target, 'token');
  await fs.chmod(target, 0o644);
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

const BASE = { kind: 'file', mode: 'owner-only', action: 'verify' } as const;
let reads: string[] = [];
async function check(
  request: Partial<Runtime.PlatformPermissionRequest>,
  output: string | Error = receipt(),
): Promise<Runtime.PlatformPermissionResult> {
  reads = [];
  const secure = createSecureFileServices('win32', {
    readWindowsAcl: (requested) => {
      reads.push(requested);
      return typeof output === 'string'
        ? Promise.resolve(output)
        : Promise.reject(output);
    },
  });
  expect(reads).toEqual([]);
  return secure.permissions({ ...BASE, path: target, ...request });
}

const ace = (type: number, sid: string | null): string =>
  receipt({ aces: [{ type, sid }] });
const privileged = [...allow(USER, 'S-1-5-18', 'S-1-5-32-544')];
const denyAll = { type: 1, sid: 'S-1-1-0' };
const timeout = Object.assign(new Error('timed out'), { killed: true });
const cases: ReadonlyArray<[string, string | Error, string]> = [
  ['current-user owner and DACL', receipt(), 'private'],
  ['privileged, deny', receipt({ aces: [...privileged, denyAll] }), 'private'],
  ['an empty DACL', receipt({ aces: [] }), 'private'],
  ['another owner', receipt({ owner: 'S-1-5-32-544' }), 'insecure'],
  ['a broad group', receipt({ aces: allow(USER, 'S-1-5-11') }), 'insecure'],
  ['another user', receipt({ aces: allow('S-1-5-21-1-2-3-1002') }), 'insecure'],
  ['a null DACL', receipt({ dacl: false, aces: [] }), 'insecure'],
  ['a reparse point', receipt({ reparse: true }), 'insecure'],
  ['a directory', receipt({ directory: true }), 'insecure'],
  ['a conditional ACE', ace(9, USER), 'unverifiable'],
  ['an ACE without a SID', ace(0, null), 'unverifiable'],
  ['a missing identity', receipt({ user: null }), 'unverifiable'],
  ['malformed output', '{"user":', 'unverifiable'],
  ['an unexpected shape', '[]', 'unverifiable'],
  ['a timed-out reader', timeout, 'unverifiable'],
];

describe('secure files: Windows ACL receipts', () => {
  it.each(cases)('classifies %s', async (_name, output, expected) => {
    expect((await check({}, output)).state).toBe(expected);
    expect(reads).toEqual([target]);
  });

  it('refuses links and wrong kinds before reading the ACL', async () => {
    expect((await check({ kind: 'directory' })).state).toBe('insecure');
    await fs.link(target, path.join(dir, 'second'));
    expect((await check({})).state).toBe('insecure');
    expect(reads).toEqual([]);
  });

  it('ignores POSIX mode bits and never repairs on restrict', async () => {
    const before = (await fs.stat(target)).mode;
    const restrict = { action: 'restrict' } as const;
    expect(await check(restrict)).toEqual({ state: 'private' });
    const broad = receipt({ aces: allow(USER, 'S-1-1-0') });
    const result = JSON.stringify(await check(restrict, broad));
    expect(result).toMatch(/"insecure".*not repaired/);
    expect((await fs.stat(target)).mode).toBe(before);
  });

  it.each(['verify', 'restrict'] as const)(
    'rejects a new hard link during %s ACL reading',
    async (action) => {
      const secure = createSecureFileServices('win32', {
        readWindowsAcl: async () => {
          await fs.link(target, path.join(dir, 'second'));
          return receipt();
        },
      });
      const result = await secure.permissions({
        ...BASE,
        path: target,
        action,
      });
      expect(result.state).toBe('insecure');
      expect((await fs.stat(target)).nlink).toBe(2);
    },
  );

  it.each(['file', 'directory'] as const)(
    'rejects a replaced %s during ACL reading',
    async (kind) => {
      if (kind === 'directory') {
        await fs.unlink(target);
        await fs.mkdir(target);
      }
      const secure = createSecureFileServices('win32', {
        readWindowsAcl: async () => {
          await fs.rename(target, path.join(dir, 'original'));
          if (kind === 'directory') await fs.mkdir(target);
          else await fs.writeFile(target, 'replacement');
          return receipt({ directory: kind === 'directory' });
        },
      });
      const result = await secure.permissions({ ...BASE, path: target, kind });
      // Hosts retry this POSIX reason: atomic descriptor publication can
      // replace core.json during a launcher's probe.
      expect(result).toEqual({
        state: 'unverifiable',
        reason: 'path changed during permission check',
        cause: 'path_changed',
      });
    },
  );

  it('fails closed if the path disappears during ACL reading', async () => {
    const secure = createSecureFileServices('win32', {
      readWindowsAcl: async () => {
        await fs.unlink(target);
        return receipt();
      },
    });
    expect((await secure.permissions({ ...BASE, path: target })).state).toBe(
      'unverifiable',
    );
  });
});

describe('secure files: Windows ACL receipts accepting foreign trustees (CAN-7915)', () => {
  const OTHER = 'S-1-5-21-1-2-3-1002';
  const accept = { foreignTrustees: 'accept' } as const;
  const accepted = (
    ...trustees: string[]
  ): Runtime.PlatformPermissionResult => ({
    state: 'private',
    accepted: { cause: 'accepted_foreign_trustee', trustees },
  });

  it.each<[string, string, Runtime.PlatformPermissionResult]>([
    [
      'a broad group',
      receipt({ aces: allow(USER, 'S-1-5-11') }),
      accepted('S-1-5-11'),
    ],
    [
      'repeated trustees once each',
      receipt({ aces: [...allow(OTHER, USER, 'S-1-1-0', OTHER), denyAll] }),
      accepted(OTHER, 'S-1-1-0'),
    ],
    [
      'only privileged trustees',
      receipt({ aces: privileged }),
      { state: 'private' },
    ],
  ])('admits %s', async (_name, output, expected) => {
    expect(await check(accept, output)).toEqual(expected);
    expect(evaluateWindowsAcl(output, 'file', 'accept')).toEqual(expected);
  });

  it.each<[string, string, Runtime.PlatformPermissionCause]>([
    [
      'another owner',
      receipt({ owner: OTHER, aces: allow(OTHER) }),
      'foreign_owner',
    ],
    ['a null DACL', receipt({ dacl: false, aces: [] }), 'null_dacl'],
    [
      'a reparse point',
      receipt({ reparse: true, aces: allow(OTHER) }),
      'reparse_point',
    ],
    ['a directory receipt', receipt({ directory: true }), 'wrong_kind'],
    [
      'a later ACE without a SID',
      receipt({ aces: [...allow(OTHER), { type: 0, sid: null }] }),
      'unverifiable',
    ],
    [
      'a later conditional ACE',
      receipt({ aces: [...allow(OTHER), { type: 9, sid: OTHER }] }),
      'unverifiable',
    ],
    ['a missing identity', receipt({ user: null }), 'unverifiable'],
    ['malformed output', '{"user":', 'unverifiable'],
  ])('still refuses %s', async (_name, output, cause) => {
    const result = await check(accept, output);
    expect(result.state).not.toBe('private');
    expect(result).toMatchObject({ cause });
  });

  it('stays strict unless the request opts in', async () => {
    const broad = receipt({ aces: allow(USER, OTHER) });
    const strict = {
      state: 'insecure',
      reason: `ACL grants access to ${OTHER}`,
      cause: 'foreign_trustee',
    };
    expect(await check({}, broad)).toEqual(strict);
    expect(await check({ foreignTrustees: 'refuse' }, broad)).toEqual(strict);
    expect(evaluateWindowsAcl(broad, 'file')).toEqual(strict);
  });

  it('still refuses links and never repairs on restrict', async () => {
    const before = (await fs.stat(target)).mode;
    const broad = receipt({ aces: allow(USER, OTHER) });
    expect(await check({ ...accept, action: 'restrict' }, broad)).toEqual(
      accepted(OTHER),
    );
    expect((await fs.stat(target)).mode).toBe(before);
    await fs.link(target, path.join(dir, 'second'));
    expect(await check(accept, broad)).toMatchObject({ cause: 'hard_link' });
    expect(reads).toEqual([]);
  });
});

describe('secure files: Windows ACL reader environment', () => {
  const ROOT = 'C:\\Windows';
  const PROFILE = 'C:\\temp\\acl-profile';
  const PINNED = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
  const isModulePath = (key: string): boolean => /^psmodulepath$/i.test(key);

  it('replaces every PSModulePath case variant with the System32 modules', () => {
    const input: NodeJS.ProcessEnv = {
      PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
      PSMODULEPATH: 'C:\\Users\\x\\Documents\\PowerShell\\Modules',
      psmodulepath: 'C:\\Program Files\\PowerShell\\Modules',
      PSModuleAnalysisCachePath: 'C:\\untrusted-cache',
      psmoduleanalysiscachepath: 'C:\\another-cache',
      Path: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\x',
      userprofile: 'C:\\Users\\other',
      HOME: 'C:\\Users\\x',
      home: 'C:\\Users\\other',
      APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
      appdata: 'C:\\Users\\other\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      localappdata: 'C:\\Users\\other\\AppData\\Local',
    };
    const snapshot = { ...input };
    const env = windowsAclEnvironment(input, ROOT, 'C:\\data\\token', PROFILE);
    expect(Object.keys(env).filter(isModulePath)).toEqual(['PSModulePath']);
    expect(env).toEqual({
      PSModulePath: PINNED,
      PSModuleAnalysisCachePath: 'NUL',
      Path: 'C:\\Windows\\System32',
      HOME: PROFILE,
      USERPROFILE: PROFILE,
      APPDATA: `${PROFILE}\\AppData\\Roaming`,
      LOCALAPPDATA: `${PROFILE}\\AppData\\Local`,
      CANOPY_SECURE_FILE_PATH: 'C:\\data\\token',
    });
    expect(input).toEqual(snapshot);
  });

  it('pins the System32 modules when none were inherited', () => {
    const env = windowsAclEnvironment(
      { TEMP: 'C:\\t' },
      ROOT,
      "it's $(x)",
      PROFILE,
    );
    expect(env).toEqual({
      TEMP: 'C:\\t',
      HOME: PROFILE,
      USERPROFILE: PROFILE,
      APPDATA: `${PROFILE}\\AppData\\Roaming`,
      LOCALAPPDATA: `${PROFILE}\\AppData\\Local`,
      PSModulePath: PINNED,
      PSModuleAnalysisCachePath: 'NUL',
      CANOPY_SECURE_FILE_PATH: "it's $(x)",
    });
  });
});

async function nativeAclFlow(): Promise<void> {
  const run = promisify(execFile);
  const system = path.win32.join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '',
    'System32',
  );
  const icacls = path.win32.join(system, 'icacls.exe');
  const ps = path.win32.join(system, 'WindowsPowerShell/v1.0/powershell.exe');
  const identity = await run(ps, ['-NoProfile', '-Command', SID_COMMAND]);
  const sid = identity.stdout.trim();
  // Path text that would execute if interpolated into a script.
  const sub = path.join(dir, "it's $(exit 7) [x]");
  const token = path.join(sub, 'token');
  await fs.mkdir(sub);
  await fs.writeFile(token, 'token');
  const secure = createSecureFileServices('win32');
  const result = (
    p: string,
    kind: Kind,
  ): Promise<Runtime.PlatformPermissionResult> =>
    secure.permissions({ ...BASE, path: p, kind });
  const fixtures = [
    [sub, 'directory', `*${sid}:(OI)(CI)F`],
    [token, 'file', `*${sid}:F`],
  ] as const;
  for (const [p, kind, grant] of fixtures) {
    await run(icacls, [p, '/setowner', `*${sid}`]);
    await run(icacls, [p, '/inheritance:r', '/grant:r', grant]);
    expect(await result(p, kind)).toEqual({ state: 'private' });
    expect(evaluateWindowsAcl(readWindowsAclSync(p), kind)).toEqual({
      state: 'private',
    });
  }
  // Direct read: a reader crash surfaces PowerShell's stderr here.
  const direct: unknown = JSON.parse(await readWindowsAcl(token));
  expect(direct).toMatchObject({ user: sid, owner: sid, directory: false });
  await run(icacls, [token, '/grant', '*S-1-5-11:R']);
  expect(evaluateWindowsAcl(readWindowsAclSync(token), 'file').state).toBe(
    'insecure',
  );
  expect(await result(token, 'file')).toEqual({
    state: 'insecure',
    reason: 'ACL grants access to S-1-5-11',
    cause: 'foreign_trustee',
  });
  // CAN-7915: an opted-in caller starts anyway, and nothing on disk changes.
  const before = await run(icacls, [token]);
  expect(
    await secure.permissions({
      ...BASE,
      path: token,
      action: 'restrict',
      foreignTrustees: 'accept',
    }),
  ).toEqual({
    state: 'private',
    accepted: { cause: 'accepted_foreign_trustee', trustees: ['S-1-5-11'] },
  });
  expect((await run(icacls, [token])).stdout).toBe(before.stdout);
}

describe('secure files: native Windows ACL', () => {
  jest.setTimeout(60_000);
  nativeIt('accepts a private ACL, rejects a broad grant', nativeAclFlow);

  nativeIt(
    'reads ACLs without creating a profile or cache under HOME',
    async () => {
      const home = path.join(dir, 'isolated-home');
      await fs.mkdir(home);
      const environment = process.env;
      const before = { ...process.env };
      Object.assign(process.env, {
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      });
      try {
        expect(await fs.readdir(home)).toEqual([]);
        expect(
          evaluateWindowsAcl(await readWindowsAcl(target), 'file').state,
        ).not.toBe('unverifiable');
        expect(
          evaluateWindowsAcl(readWindowsAclSync(target), 'file').state,
        ).not.toBe('unverifiable');
        expect(await fs.readdir(home)).toEqual([]);
      } finally {
        // Replacing process.env drops Windows' case-insensitive lookup.
        for (const key of Object.keys(process.env)) {
          if (!Object.hasOwn(before, key)) delete process.env[key];
        }
        Object.assign(process.env, before);
      }
      expect(process.env).toBe(environment);
      expect({ ...process.env }).toEqual(before);
    },
  );

  nativeIt('ignores inherited PowerShell 7 module paths', async () => {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const core = path.win32.join(programFiles, 'PowerShell', '7', 'Modules');
    const installed = await fs.stat(core).then(
      (stats) => stats.isDirectory(),
      () => false,
    );
    if (!installed) {
      if (process.env.CI) {
        throw new Error(`PowerShell 7 modules missing at ${core}`);
      }
      // eslint-disable-next-line no-console -- a local skip must be visible.
      console.warn(`Skipped: PowerShell 7 modules missing at ${core}`);
      return;
    }
    const inherited = process.env.PSModulePath;
    const system = path.win32.join(
      process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '',
      'System32',
    );
    process.env.PSModulePath = [
      core,
      path.win32.join(system, 'WindowsPowerShell/v1.0/Modules'),
    ].join(';');
    try {
      await nativeAclFlow();
    } finally {
      if (inherited === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = inherited;
    }
  });
});

it('closure refuses an unavailable ACL child rather than forgetting its failure', async () => {
  const before = process.env.SystemRoot;
  const witness = createWindowsClosureWitness();
  process.env.SystemRoot = 'C:\\can4576-nonexistent-system-root';
  try {
    await witness.run(async () => {
      await expect(readWindowsAcl(target)).rejects.toThrow();
    });
    const report = witness.finalize();
    expect(report.started).toBe(1);
    expect(witness.accepts(report)).toBe(false);
  } finally {
    if (before === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = before;
  }
});

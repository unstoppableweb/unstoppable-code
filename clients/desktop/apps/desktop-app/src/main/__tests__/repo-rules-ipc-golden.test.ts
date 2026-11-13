// CAN-4070 rule: captured on the unchanged `repo-rules:*` IPC handlers and
// repository-rule composition before CAN-4905 routed them through
// `core.workspace.repoRules.*`. Real data root, workspace records, Git
// checkouts and policy file; only IPC registration is mocked.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

// Jest runs tests in a separate realm, so built-in fs errors fail the
// production `instanceof Error` checks. Rethrow them as same-realm errors with
// the same fields, which is what Electron main sees.
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<Record<string, unknown>>('node:fs/promises');
  const sameRealm = (error: unknown): unknown =>
    typeof error === 'object' && error !== null && !(error instanceof Error)
      ? Object.assign(new Error(String(Reflect.get(error, 'message'))), error)
      : error;
  const wrapped = Object.fromEntries(
    [
      'access',
      'chmod',
      'lstat',
      'mkdir',
      'open',
      'readFile',
      'readdir',
      'readlink',
      'realpath',
      'rename',
      'rm',
      'stat',
      'unlink',
      'writeFile',
    ].map((name) => {
      const original = actual[name];
      if (typeof original !== 'function') throw new Error(name);
      return [
        name,
        async (...args: unknown[]): Promise<unknown> => {
          try {
            return await Reflect.apply(original, actual, args);
          } catch (error) {
            throw sameRealm(error);
          }
        },
      ];
    }),
  );
  return { ...actual, ...wrapped };
});

const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

import { registerRepoRulesHandlers } from '../ipc/repo-rules';
import { GIT_ELIGIBILITY_KEYS } from '../repo-rules/eligibility';
import { composeWorktreeRepoRules } from '../repo-rules/host';
import { selectSessionInstructions } from '../repo-rules/session';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';

jest.setTimeout(60_000);

// The grants every desktop IPC caller carries (desktop-ipc-caller.ts).
const DESKTOP_GRANTS: CanopyCallerDescriptor['grants'] = [
  'worker.filesystem.read',
  'core.workspace.read',
  'core.chat.read',
  'core.chat.write',
  'core.worktree.read',
  'core.chat.write',
];

function desktopCaller(
  principalId = 'local-desktop-user',
  clientInstanceId = 'electron-web-contents:1',
): CanopyCallerDescriptor {
  return {
    principalId,
    clientInstanceId,
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: [...DESKTOP_GRANTS],
  };
}

const RULES_WS = 'rules-ws';
const MULTI_WS = 'multi-ws';
const WIDE_WS = 'wide-ws';
const COWORK_WS = 'cowork-ws';
const LOCKED_WS = 'locked-ws';
const BIG_WS = 'big-ws';
const NO_REPO_WS = 'no-repo-ws';
const WORKTREE = 'feature-01';
const OTHER_WORKTREE = 'feature-02';

let dir: string;
let dataDir: string;
let repo: string;
let memberRepo: string;
let checkout: string;
let originalDataDir: string | undefined;
let globalConfig: string;
let home: string;
// Session reads read the user's Git config; the golden supplies its own.
const GIT_ENV = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'XDG_CONFIG_HOME',
  'HOME',
] as const;
const originalGitEnv = new Map<string, string | undefined>();
let runtime: DesktopCanopyDispatcher;
let caller: CanopyCallerDescriptor;

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function workspaceDir(id: string): string {
  return join(dataDir, 'workspaces', id);
}

function policyPath(id: string): string {
  return join(workspaceDir(id), 'repo-rules.json');
}

function initRepo(path: string, files: Record<string, string>): void {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['config', 'user.email', 'golden@example.com']);
  git(path, ['config', 'user.name', 'Golden']);
  writeFileSync(join(path, 'README.md'), 'golden\n');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(path, file, '..'), { recursive: true });
    writeFileSync(join(path, file), text);
  }
  git(path, ['add', '.']);
  git(path, ['commit', '-q', '-m', 'initial']);
}

const SOURCE_RULES = {
  '.cursorrules': 'Legacy root rule body.',
  '.cursor/rules/always.mdc': '---\nalwaysApply: true\n---\nAlways rule body.',
  '.cursor/rules/auto.mdc':
    '---\nglobs: "src/**/*.ts"\ndescription: TypeScript files\n---\nAuto rule body.',
  '.cursor/rules/agent.mdc':
    '---\ndescription: Use when writing release notes\n---\nAgent rule body.',
  '.cursor/rules/manual.mdc': 'Manual rule body.',
  '.cursor/rules/broken.mdc': '---\nglobs: [\n---\nBroken header body.',
};

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'repo-rules-ipc-golden-')));
  dataDir = join(dir, 'data');
  repo = join(dir, 'repo');
  memberRepo = join(dir, 'member');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  globalConfig = join(dir, 'gitconfig');
  home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(globalConfig, '');
  for (const name of GIT_ENV) originalGitEnv.set(name, process.env[name]);
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.XDG_CONFIG_HOME = join(dir, 'xdg');
  process.env.HOME = home;
  initRepo(repo, SOURCE_RULES);
  initRepo(memberRepo, {
    '.cursor/rules/member.mdc': '---\nalwaysApply: true\n---\nMember body.',
  });
  checkout = join(workspaceDir(RULES_WS), 'worktrees', WORKTREE);
  git(repo, ['worktree', 'add', '-q', '-b', WORKTREE, checkout]);
  writeFileSync(
    join(checkout, '.cursor/rules/checkout.mdc'),
    '---\nalwaysApply: true\n---\nCheckout-only body.',
  );
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      ...[
        [RULES_WS, 'single-repo'],
        [MULTI_WS, 'multi-repo'],
        [WIDE_WS, 'multi-repo'],
        [COWORK_WS, 'cowork'],
        [LOCKED_WS, 'single-repo'],
        [BIG_WS, 'single-repo'],
        [NO_REPO_WS, 'single-repo'],
      ].map(([id, type], order) => ({
        id,
        name: id,
        type,
        color: '#38BDF8',
        collapsed: false,
        order,
      })),
    ],
  });
  writeJson(join(workspaceDir(RULES_WS), 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: repo,
    repos: [],
  });
  writeJson(join(workspaceDir(RULES_WS), 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: WORKTREE,
        branchName: WORKTREE,
        createdAt: '2026-10-23T00:00:00.000Z',
      },
    ],
  });
  writeJson(join(workspaceDir(MULTI_WS), 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: repo,
    repos: [{ id: 'member', name: 'member', repoPath: memberRepo }],
  });
  writeJson(join(workspaceDir(MULTI_WS), 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: OTHER_WORKTREE,
        branchName: OTHER_WORKTREE,
        createdAt: '2026-10-23T00:00:00.000Z',
      },
    ],
  });
  writeJson(join(workspaceDir(WIDE_WS), 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: Array.from({ length: 32 }, (_, index) => ({
      id: `r${index}`,
      name: `r${index}`,
      repoPath: memberRepo,
    })),
  });
  writeJson(join(workspaceDir(COWORK_WS), 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
  });
  for (const id of [LOCKED_WS, BIG_WS])
    writeJson(join(workspaceDir(id), 'workspace.json'), {
      version: 1,
      type: 'single-repo',
      repoPath: memberRepo,
      repos: [],
    });
  writeJson(join(workspaceDir(NO_REPO_WS), 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repos: [],
  });
  // A directory where the policy file belongs: reads are unavailable and
  // every save fails.
  mkdirSync(policyPath(LOCKED_WS), { recursive: true });
  runtime = createDesktopRuntime();
  registerRepoRulesHandlers(runtime, (): CanopyCallerDescriptor => caller);
});

afterAll(async () => {
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  for (const [name, value] of originalGitEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  caller = desktopCaller();
  for (const id of [RULES_WS, MULTI_WS, WIDE_WS, COWORK_WS, BIG_WS])
    rmSync(policyPath(id), { force: true });
});

const UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

function scrub(value: string): string {
  return value
    .split(dir)
    .join('<root>')
    .replace(UUID, '<uuid>')
    .replace(ISO, '<time>');
}

function scrubbed(value: unknown): unknown {
  if (value === undefined) return value;
  return JSON.parse(scrub(JSON.stringify(value)));
}

function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { thrown: String(error) };
  const code: unknown = 'code' in error ? error.code : undefined;
  return {
    name: error.name,
    message: scrub(error.message),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

type Outcome = { result: unknown } | { error: Record<string, unknown> };

async function ipc(channel: string, request: unknown): Promise<Outcome> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  try {
    const event: Partial<IpcMainInvokeEvent> = {};
    return { result: await handler(event, request) };
  } catch (error) {
    return { error: describeError(error) };
  }
}

const scan = (request: unknown): Promise<Outcome> =>
  ipc(IPC_CHANNELS.repoRulesScan, request);
const preview = (request: unknown): Promise<Outcome> =>
  ipc(IPC_CHANNELS.repoRulesPreview, request);
const status = (request: unknown): Promise<Outcome> =>
  ipc(IPC_CHANNELS.repoRulesStatus, request);
const apply = (request: unknown): Promise<Outcome> =>
  ipc(IPC_CHANNELS.repoRulesApply, request);

function revisionOf(outcome: Outcome): Record<string, unknown> {
  if (!('result' in outcome)) return outcome;
  const revision: unknown = Reflect.get(Object(outcome.result), 'revision');
  return { revision };
}

interface ScanResult {
  scanId: string;
  proposals: Array<{ id: string; path: string }>;
}

function isScanResult(value: unknown): value is ScanResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'scanId' in value &&
    typeof value.scanId === 'string' &&
    'proposals' in value &&
    Array.isArray(value.proposals)
  );
}

async function scanned(request: unknown): Promise<ScanResult> {
  const outcome = await scan(request);
  if (!('result' in outcome) || !isScanResult(outcome.result))
    throw new Error(`scan failed: ${JSON.stringify(outcome)}`);
  return outcome.result;
}

function ruleId(result: ScanResult, path: string): string {
  const rule = result.proposals.find((proposal) => proposal.path === path);
  if (!rule) throw new Error(`no ${path} in ${JSON.stringify(result)}`);
  return rule.id;
}

function policyFile(id: string): unknown {
  try {
    return scrubbed(JSON.parse(readFileSync(policyPath(id), 'utf8')));
  } catch (error) {
    return `unreadable: ${String(Reflect.get(Object(error), 'code'))}`;
  }
}

function snapshotSourceBytes(): Record<string, string> {
  return Object.fromEntries(
    Object.keys(SOURCE_RULES).map((file) => [
      file,
      readFileSync(join(repo, file), 'utf8'),
    ]),
  );
}

describe('CAN-4905 repo-rules IPC golden', () => {
  it('reads the missing policy as disabled without a session binding', async () => {
    const first = await status({ workspaceId: RULES_WS });
    caller = desktopCaller('local-desktop-user', 'electron-web-contents:2');
    const second = await status({ workspaceId: RULES_WS });
    expect({ first, second }).toMatchSnapshot();
    expect(policyFile(RULES_WS)).toBe('unreadable: ENOENT');
  });

  it('scans the source repository, previews from the review, and writes nothing', async () => {
    const before = snapshotSourceBytes();
    const result = await scanned({ workspaceId: RULES_WS });
    const previews = await Promise.all(
      result.proposals.map(
        async (proposal): Promise<[string, Outcome]> => [
          proposal.path,
          await preview({
            workspaceId: RULES_WS,
            scanId: result.scanId,
            ruleId: proposal.id,
          }),
        ],
      ),
    );
    expect({
      scan: scrubbed(result),
      previews: Object.fromEntries(previews),
      missingRule: await preview({
        workspaceId: RULES_WS,
        scanId: result.scanId,
        ruleId: 'single:.cursor/rules/absent.mdc',
      }),
    }).toMatchSnapshot();
    expect(snapshotSourceBytes()).toEqual(before);
    expect(policyFile(RULES_WS)).toBe('unreadable: ENOENT');
  });

  it('binds a review to the scanning session and workspace', async () => {
    const result = await scanned({ workspaceId: RULES_WS });
    const request = {
      workspaceId: RULES_WS,
      scanId: result.scanId,
      ruleId: ruleId(result, '.cursorrules'),
    };
    caller = desktopCaller('local-desktop-user', 'electron-web-contents:2');
    const otherWindow = await preview(request);
    const otherWindowApply = await apply({
      workspaceId: RULES_WS,
      enabled: true,
      scanId: result.scanId,
      disabledRuleIds: [],
    });
    caller = desktopCaller();
    const otherWorkspace = await preview({ ...request, workspaceId: MULTI_WS });
    const unknownReview = await preview({
      ...request,
      scanId: '12345678-1234-4234-8234-123456789abc',
    });
    const sameSession = await preview(request);
    expect({
      otherWindow,
      otherWindowApply,
      otherWorkspace,
      unknownReview,
      sameSession,
    }).toMatchSnapshot();
  });

  it('applies a reviewed selection to the policy file only and composes the enabled rules', async () => {
    const before = snapshotSourceBytes();
    const result = await scanned({ workspaceId: RULES_WS });
    const disabled = [ruleId(result, '.cursor/rules/manual.mdc')];
    const applied = await apply({
      workspaceId: RULES_WS,
      enabled: true,
      scanId: result.scanId,
      disabledRuleIds: disabled,
    });
    const replay = await apply({
      workspaceId: RULES_WS,
      enabled: true,
      scanId: result.scanId,
      disabledRuleIds: disabled,
    });
    const afterApply = await status({ workspaceId: RULES_WS });
    const rescan = await scan({ workspaceId: RULES_WS });
    const composed = await composeWorktreeRepoRules(
      RULES_WS,
      WORKTREE,
      checkout,
    );
    const disabledApply = await apply({
      workspaceId: RULES_WS,
      enabled: false,
    });
    const composedAfterDisable = await composeWorktreeRepoRules(
      RULES_WS,
      WORKTREE,
      checkout,
    );
    expect({
      applied: scrubbed(applied),
      replay,
      afterApply: scrubbed(afterApply),
      rescan: scrubbed(rescan),
      policy: policyFile(RULES_WS),
      composed: scrub(composed),
      disabledApply: scrubbed(disabledApply),
      composedAfterDisable,
      policyAfterDisable: policyFile(RULES_WS),
    }).toMatchSnapshot();
    expect(snapshotSourceBytes()).toEqual(before);
  });

  it('pins every apply refusal message', async () => {
    const withoutReview = await apply({
      workspaceId: RULES_WS,
      enabled: true,
      disabledRuleIds: [],
    });
    const enableWithoutReview = await apply({
      workspaceId: RULES_WS,
      enabled: true,
    });
    const review = await scanned({ workspaceId: RULES_WS });
    const missingSelections = await apply({
      workspaceId: RULES_WS,
      enabled: true,
      scanId: review.scanId,
    });
    const duplicated = await apply({
      workspaceId: RULES_WS,
      enabled: true,
      scanId: review.scanId,
      disabledRuleIds: [
        ruleId(review, '.cursorrules'),
        ruleId(review, '.cursorrules'),
      ],
    });
    const foreign = await apply({
      workspaceId: RULES_WS,
      enabled: true,
      scanId: review.scanId,
      disabledRuleIds: ['single:.cursor/rules/elsewhere.mdc'],
    });
    const stale = await scanned({ workspaceId: RULES_WS });
    const fresh = await scanned({ workspaceId: RULES_WS });
    const freshApply = await apply({
      workspaceId: RULES_WS,
      enabled: false,
      scanId: fresh.scanId,
      disabledRuleIds: [],
    });
    const policyChanged = await apply({
      workspaceId: RULES_WS,
      enabled: true,
      scanId: stale.scanId,
      disabledRuleIds: [],
    });
    const changing = await scanned({ workspaceId: RULES_WS });
    const rulePath = join(repo, '.cursor/rules/always.mdc');
    writeFileSync(rulePath, '---\nalwaysApply: true\n---\nEdited body.');
    let rulesChanged: Outcome;
    try {
      rulesChanged = await apply({
        workspaceId: RULES_WS,
        enabled: true,
        scanId: changing.scanId,
        disabledRuleIds: [],
      });
    } finally {
      writeFileSync(rulePath, SOURCE_RULES['.cursor/rules/always.mdc']);
    }
    const afterRulesChanged = await status({ workspaceId: RULES_WS });
    expect({
      withoutReview,
      enableWithoutReview,
      missingSelections,
      duplicated,
      foreign,
      freshApply: scrubbed(freshApply),
      policyChanged,
      rulesChanged,
      afterRulesChanged: scrubbed(afterRulesChanged),
    }).toMatchSnapshot();
  });

  it('scans a selected checkout and a multi-repository workspace', async () => {
    const worktree = await scan({
      workspaceId: RULES_WS,
      worktreeId: WORKTREE,
    });
    const multi = await scan({ workspaceId: MULTI_WS });
    expect({
      worktree: scrubbed(worktree),
      multi: scrubbed(multi),
    }).toMatchSnapshot();
  });

  it('refuses unavailable workspaces and checkouts with the legacy messages', async () => {
    expect({
      cowork: await scan({ workspaceId: COWORK_WS }),
      coworkStatus: await status({ workspaceId: COWORK_WS }),
      unknownWorkspace: await scan({ workspaceId: 'ghost-ws' }),
      unknownWorkspaceStatus: await status({ workspaceId: 'ghost-ws' }),
      unknownWorktree: await scan({
        workspaceId: RULES_WS,
        worktreeId: 'feature-99',
      }),
      otherWorkspaceWorktree: await scan({
        workspaceId: RULES_WS,
        worktreeId: OTHER_WORKTREE,
      }),
      overScanLimit: await scan({ workspaceId: WIDE_WS }),
      overScanLimitStatus: await status({ workspaceId: WIDE_WS }),
    }).toMatchSnapshot();
  });

  it('refuses an apply whose reviewed checkouts changed', async () => {
    const configPath = join(workspaceDir(MULTI_WS), 'workspace.json');
    const original = readFileSync(configPath, 'utf8');
    const review = await scanned({ workspaceId: MULTI_WS });
    writeJson(configPath, { ...JSON.parse(original), repos: [] });
    let changed: Outcome;
    try {
      changed = await apply({
        workspaceId: MULTI_WS,
        enabled: true,
        scanId: review.scanId,
        disabledRuleIds: [],
      });
    } finally {
      writeFileSync(configPath, original);
    }
    expect({ changed, policy: policyFile(MULTI_WS) }).toMatchSnapshot();
  });

  it('reports unsaveable and oversized policy with the legacy messages', async () => {
    const lockedStatus = await status({ workspaceId: LOCKED_WS });
    const lockedDisable = await apply({
      workspaceId: LOCKED_WS,
      enabled: false,
    });
    const lockedReview = await scanned({ workspaceId: LOCKED_WS });
    const lockedApply = await apply({
      workspaceId: LOCKED_WS,
      enabled: true,
      scanId: lockedReview.scanId,
      disabledRuleIds: [],
    });
    const lockedRetry = await preview({
      workspaceId: LOCKED_WS,
      scanId: lockedReview.scanId,
      ruleId: ruleId(lockedReview, '.cursor/rules/member.mdc'),
    });
    // A saved policy just under the 256 KiB limit that a review pushes over it.
    const state = {
      version: 1,
      enabled: false,
      revision: 3,
      disabledRuleIds: [] as string[],
      reviewed: {},
      nestedDirectories: {},
    };
    const limit = 256 * 1024;
    while (Buffer.byteLength(JSON.stringify(state)) < limit - 3_900)
      state.disabledRuleIds.push(
        `gone-${state.disabledRuleIds.length}:${'x'.repeat(4_000)}`,
      );
    const room = limit - 100 - Buffer.byteLength(JSON.stringify(state));
    state.disabledRuleIds.push(`gone:${'y'.repeat(room - 3)}`);
    writeFileSync(policyPath(BIG_WS), JSON.stringify(state));
    const bigStatus = await status({ workspaceId: BIG_WS });
    const bigReview = await scanned({ workspaceId: BIG_WS });
    const bigApply = await apply({
      workspaceId: BIG_WS,
      enabled: true,
      scanId: bigReview.scanId,
      disabledRuleIds: [],
    });
    const bigAfter = await status({ workspaceId: BIG_WS });
    expect({
      lockedStatus,
      lockedDisable,
      lockedApply,
      lockedRetry,
      bigStatus: {
        ...revisionOf(bigStatus),
      },
      bigApply: scrubbed(bigApply),
      bigAfter: {
        ...revisionOf(bigAfter),
      },
    }).toMatchSnapshot();
  });

  it('refuses a single-repository workspace without a repository', async () => {
    expect({
      scan: await scan({ workspaceId: NO_REPO_WS }),
      status: await status({ workspaceId: NO_REPO_WS }),
      disable: scrubbed(
        await apply({ workspaceId: NO_REPO_WS, enabled: false }),
      ),
    }).toMatchSnapshot();
  });

  it.each([
    ['remote device', 'remote-device:controller-1', 'remote-bridge:7'],
    [
      'renderer relay surface',
      'local-desktop-renderer:main',
      'electron-web-contents:1',
    ],
  ])(
    'refuses a %s on every repo-rules channel before any effect',
    async (_name, principalId, clientInstanceId) => {
      const review = await scanned({ workspaceId: RULES_WS });
      caller = desktopCaller(principalId, clientInstanceId);
      const outcomes = {
        scan: await scan({ workspaceId: RULES_WS }),
        preview: await preview({
          workspaceId: RULES_WS,
          scanId: review.scanId,
          ruleId: ruleId(review, '.cursorrules'),
        }),
        status: await status({ workspaceId: RULES_WS }),
        apply: await apply({ workspaceId: RULES_WS, enabled: false }),
      };
      expect(outcomes).toEqual({
        scan: {
          error: {
            name: 'Error',
            message: 'Editor setup is available on the local desktop.',
          },
        },
        preview: {
          error: {
            name: 'Error',
            message: 'Editor setup is available on the local desktop.',
          },
        },
        status: {
          error: {
            name: 'Error',
            message: 'Editor setup is available on the local desktop.',
          },
        },
        apply: {
          error: {
            name: 'Error',
            message: 'Editor setup is available on the local desktop.',
          },
        },
      });
      expect(policyFile(RULES_WS)).toBe('unreadable: ENOENT');
    },
  );

  it('rejects malformed requests before authorization', async () => {
    caller = desktopCaller('remote-device:controller-1', 'remote-bridge:7');
    expect({
      scanRoot: await scan({ workspaceId: RULES_WS, root: '/tmp' }),
      scanBadId: await scan({ workspaceId: '../bad' }),
      scanMissing: await scan(undefined),
      statusExtra: await status({
        workspaceId: RULES_WS,
        worktreeId: WORKTREE,
      }),
      previewBadScan: await preview({
        workspaceId: RULES_WS,
        scanId: 'not-a-uuid',
        ruleId: 'x',
      }),
      applyMissingEnabled: await apply({ workspaceId: RULES_WS }),
      applyTooMany: await apply({
        workspaceId: RULES_WS,
        enabled: true,
        scanId: '12345678-1234-4234-8234-123456789abc',
        disabledRuleIds: Array.from({ length: 201 }, (_, i) => `r${i}`),
      }),
    }).toMatchSnapshot();
  });
});

describe('CAN-6352 Git config includes in session reads', () => {
  const ALWAYS = 'Always rule body.';
  const CHECKOUT_ONLY = 'Checkout-only body.';
  // A value for each eligibility key, so a key added to the reader is covered.
  const ELIGIBILITY_VALUES: Record<string, string> = {
    'core.excludesfile': 'excludes',
    'core.ignorecase': 'true',
    'extensions.objectformat': 'sha1',
    'extensions.worktreeconfig': 'false',
  };
  const written: string[] = [];

  function write(path: string, text: string): void {
    const file = join(dir, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
    written.push(file);
  }

  function composeWith(config: string): Promise<string> {
    writeFileSync(globalConfig, config);
    return composeWorktreeRepoRules(RULES_WS, WORKTREE, checkout);
  }

  // Jest's process.env is the test's own; child processes need it passed.
  /** Real Git under the same config: does it ignore the checkout-only rule? */
  function gitIgnoresCheckoutRule(): boolean {
    const result = spawnSync(
      'git',
      ['-C', checkout, 'check-ignore', '-q', '.cursor/rules/checkout.mdc'],
      { env: { ...process.env }, stdio: 'pipe' },
    );
    if (result.status !== 0 && result.status !== 1)
      throw new Error(`git check-ignore failed: ${String(result.stderr)}`);
    return result.status === 0;
  }

  beforeEach(async () => {
    const result = await scanned({ workspaceId: RULES_WS });
    const applied = await apply({
      workspaceId: RULES_WS,
      enabled: true,
      scanId: result.scanId,
      disabledRuleIds: [],
    });
    expect('result' in applied).toBe(true);
  });

  afterEach(() => {
    writeFileSync(globalConfig, '');
    for (const file of written.splice(0)) rmSync(file, { force: true });
  });

  it('composes the reviewed rules under an empty Git config', async () => {
    const composed = await composeWith('');
    expect(composed).toContain(ALWAYS);
    expect(composed).toContain(CHECKOUT_ONLY);
  });

  it('leaves out an includeIf target that sets no eligibility key, whatever its condition', async () => {
    const baseline = await composeWith('');
    write(
      'identity',
      '[user]\n\temail = work@example.com\n\tsigningkey = ABC\n',
    );
    for (const condition of [
      `gitdir:${dir}/elsewhere/`,
      'gitdir/i:~/',
      'onbranch:main',
      'hasconfig:remote.*.url:https://example.com/**',
    ]) {
      expect(
        await composeWith(`[includeIf "${condition}"]\n\tpath = identity\n`),
      ).toBe(baseline);
    }
  });

  it.each(GIT_ELIGIBILITY_KEYS)(
    'fails closed on an includeIf target that sets %s',
    async (key) => {
      const [section, name] = key.split('.');
      const value = ELIGIBILITY_VALUES[key];
      if (!section || !name || value === undefined)
        throw new Error(`no golden value for ${key}`);
      write('conditional', `[${section}]\n\t${name} = ${value}\n`);
      expect(
        await composeWith(
          `[includeIf "gitdir:${dir}/elsewhere/"]\n\tpath = conditional\n`,
        ),
      ).toBe('');
    },
  );

  it('follows a plain include relative to the including file, as Git does', async () => {
    write('excludes', '.cursor/rules/checkout.mdc\n');
    write('extra', `[core]\n\texcludesfile = ${join(dir, 'excludes')}\n`);
    const composed = await composeWith('[include]\n\tpath = extra\n');
    expect(gitIgnoresCheckoutRule()).toBe(true);
    expect(composed).toContain(ALWAYS);
    expect(composed).not.toContain(CHECKOUT_ONLY);
  });

  it('expands ~/ and nested relative includes, as Git does', async () => {
    write('excludes', '.cursor/rules/checkout.mdc\n');
    write(
      'home/dotfiles/ignore-rules',
      `[core]\n\texcludesfile = ${join(dir, 'excludes')}\n`,
    );
    write('home/dotfiles/main', '[include]\n\tpath = ignore-rules\n');
    const composed = await composeWith('[include]\n\tpath = ~/dotfiles/main\n');
    expect(gitIgnoresCheckoutRule()).toBe(true);
    expect(composed).toContain(ALWAYS);
    expect(composed).not.toContain(CHECKOUT_ONLY);
  });

  it('skips a missing include file, as Git does', async () => {
    const baseline = await composeWith('');
    expect(await composeWith('[include]\n\tpath = no-such-file\n')).toBe(
      baseline,
    );
    expect(gitIgnoresCheckoutRule()).toBe(false);
  });

  it("fails closed on an include cycle at Git's depth limit", async () => {
    write('cycle-a', '[include]\n\tpath = cycle-b\n');
    write('cycle-b', '[include]\n\tpath = cycle-a\n');
    expect(await composeWith('[include]\n\tpath = cycle-a\n')).toBe('');
    // Git refuses the same config.
    expect(
      spawnSync('git', ['-C', checkout, 'config', '--get', 'core.ignorecase'], {
        env: { ...process.env },
      }).status,
    ).toBe(128);
  });

  it('fails closed on an included file over the size bound', async () => {
    write('huge', `[core]\n${'# padding\n'.repeat(8_000)}`);
    expect(await composeWith('[include]\n\tpath = huge\n')).toBe('');
  });
});

describe('CAN-6368 blocked session reads', () => {
  // Check reaches core.workspace.repoRules.check, one bounded session read of
  // the source checkouts; status (core.workspace.repoRules.status) keeps
  // reading only the saved policy.
  const BLOCKING_INCLUDE = `[includeIf "gitdir:/elsewhere/"]\n\tpath = blocking\n`;
  const check = (request: unknown): Promise<Outcome> =>
    ipc(IPC_CHANNELS.repoRulesCheck, request);

  function resultOf(outcome: Outcome): unknown {
    if (!('result' in outcome)) throw new Error(JSON.stringify(outcome));
    return outcome.result;
  }

  async function enable(): Promise<void> {
    const result = await scanned({ workspaceId: RULES_WS });
    const applied = await apply({
      workspaceId: RULES_WS,
      enabled: true,
      scanId: result.scanId,
      disabledRuleIds: [],
    });
    expect('result' in applied).toBe(true);
  }

  afterEach(() => {
    writeFileSync(globalConfig, '');
    rmSync(join(dir, 'blocking'), { force: true });
  });

  it('check reports a blocked repository and its reason, and status reads only the policy', async () => {
    await enable();
    const clear = await check({ workspaceId: RULES_WS });
    writeFileSync(join(dir, 'blocking'), '[core]\n\texcludesfile = excludes\n');
    writeFileSync(globalConfig, BLOCKING_INCLUDE);
    const blocked = await check({ workspaceId: RULES_WS });
    const statusWhileBlocked = await status({ workspaceId: RULES_WS });
    const composed = await composeWorktreeRepoRules(
      RULES_WS,
      WORKTREE,
      checkout,
    );
    writeFileSync(globalConfig, '');
    const fixed = await check({ workspaceId: RULES_WS });
    expect({ clear, blocked, composed, fixed }).toEqual({
      clear: { result: { blocked: [] } },
      blocked: {
        result: {
          blocked: [{ repoId: '__single_repo__', reason: 'unsupported-git' }],
        },
      },
      composed: '',
      fixed: { result: { blocked: [] } },
    });
    // Status still returns the saved policy only, with no checkout read.
    const policy = resultOf(statusWhileBlocked);
    expect(policy).toHaveProperty('enabled', true);
    expect(
      typeof policy === 'object' && policy !== null
        ? Object.keys(policy).sort()
        : policy,
    ).toEqual(['disabledRuleIds', 'enabled', 'reviewedAt', 'revision']);
  });

  it('check reports a missing checkout as a reason, and status and turn-off still work', async () => {
    await enable();
    renameSync(repo, `${repo}.away`);
    try {
      const gone = await check({ workspaceId: RULES_WS });
      const statusGone = await status({ workspaceId: RULES_WS });
      const turnedOff = await apply({ workspaceId: RULES_WS, enabled: false });
      expect(gone).toEqual({
        result: {
          blocked: [{ repoId: '__single_repo__', reason: 'missing-checkout' }],
        },
      });
      expect(resultOf(statusGone)).toHaveProperty('enabled', true);
      expect(resultOf(turnedOff)).toHaveProperty('enabled', false);
    } finally {
      renameSync(`${repo}.away`, repo);
    }
  });

  // Root ignores directory permissions, so the unreadable root can't be built.
  const unlessRoot = process.getuid?.() === 0 ? it.skip : it;
  unlessRoot(
    'check reports an unreadable checkout as blocked, not as an error',
    async () => {
      await enable();
      const record = join(workspaceDir(RULES_WS), 'workspace.json');
      const saved = readFileSync(record, 'utf8');
      const sealed = join(dir, 'sealed');
      mkdirSync(join(sealed, 'repo'), { recursive: true });
      writeJson(record, {
        version: 1,
        type: 'single-repo',
        repoPath: join(sealed, 'repo'),
        repos: [],
      });
      chmodSync(sealed, 0o000);
      try {
        expect(await check({ workspaceId: RULES_WS })).toEqual({
          result: {
            blocked: [{ repoId: '__single_repo__', reason: 'unavailable' }],
          },
        });
      } finally {
        chmodSync(sealed, 0o700);
        writeFileSync(record, saved);
      }
    },
  );

  // Rules compose in process for each chat:send-message turn
  // (IPC_CHANNELS.chatSendMessage) through selectSessionInstructions.
  it('starts the chat without rules and records why when composing fails', async () => {
    await enable();
    const errors: unknown[] = [];
    const instructions = await selectSessionInstructions({
      provider: 'claude',
      isInteractiveCode: true,
      resumed: false,
      currentGlobal: 'Global instructions.',
      // The workspace's records are gone: resolving its checkout rejects.
      compose: () =>
        composeWorktreeRepoRules(RULES_WS, 'no-such-worktree', checkout),
      onComposeError: (error) => errors.push(error),
    });
    expect(instructions).toBe('Global instructions.');
    expect(errors).toHaveLength(1);
  });
});

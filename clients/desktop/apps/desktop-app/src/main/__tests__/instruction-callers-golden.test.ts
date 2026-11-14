import { installRoutedW5GoldenStore } from '../lib/__tests__/fixtures/w5-routed-golden-store';
// CAN-4070 rule: captured on the unchanged create/regenerate callers before
// CAN-4106 routed their instruction-file decisions through the core-runtime
// library functions. Each case runs a caller end to end against a real data
// root, real source folders and real Git; only telemetry side channels are
// mocked. Two injections: AGENTS.md link calls can be faulted, and the
// platform the desktop alias and restore helpers default to can be set to
// win32 (no changed caller passes a platform itself).
import type * as FsPromises from 'node:fs/promises';
import type { SourceChangeGit } from '../canopy-runtime/worker-git-worktree-adapter';
import type * as InstructionFiles from '../lib/instruction-files';
import type * as HardLinkHelpers from './helpers/host-independent-hard-links';

let mockPlatform: NodeJS.Platform = process.platform;
const mockFaults: Array<{ op: 'symlink' | 'link'; code: string }> = [];
const mockWrites: string[] = [];
const mockRoot = { path: '' };

// Jest runs tests in a separate realm, so built-in fs errors fail production
// `instanceof Error` checks. Rethrow them as same-realm errors with the same
// fields, which is what Electron main sees. Mutations of AGENTS.md and
// CLAUDE.md under the test root are logged in order. Hard links and copies
// give the same results on every host.
jest.mock('node:fs/promises', () => {
  const realFs = jest.requireActual<typeof FsPromises>('node:fs/promises');
  const actual: Record<string, unknown> = {
    ...realFs,
    ...jest
      .requireActual<
        typeof HardLinkHelpers
      >('./helpers/host-independent-hard-links')
      .hostIndependentHardLinkOps(realFs),
  };
  const sameRealm = (error: unknown): unknown =>
    typeof error === 'object' && error !== null && !(error instanceof Error)
      ? Object.assign(new Error(String(Reflect.get(error, 'message'))), error)
      : error;
  // The argument index of the path each mutation creates or removes.
  const MUTATIONS: Record<string, number> = {
    copyFile: 1,
    link: 1,
    rename: 1,
    rm: 0,
    symlink: 1,
    unlink: 0,
    writeFile: 0,
  };
  const instructionPath = (value: unknown): string | null => {
    const path = String(value);
    if (!mockRoot.path || !path.startsWith(mockRoot.path)) return null;
    return /(?:^|\/)(AGENTS|CLAUDE)\.md$/.test(path)
      ? path.slice(mockRoot.path.length)
      : null;
  };
  const wrapped = Object.fromEntries(
    [
      'access',
      'copyFile',
      'link',
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
      'symlink',
      'unlink',
      'writeFile',
    ].map((name) => {
      const original = actual[name];
      if (typeof original !== 'function') throw new Error(name);
      return [
        name,
        async (...args: unknown[]): Promise<unknown> => {
          const pathIndex = MUTATIONS[name];
          const logged =
            pathIndex === undefined ? null : instructionPath(args[pathIndex]);
          if (logged) {
            mockWrites.push(`${name} ${logged}`);
            const fault = mockFaults.find(
              (candidate) =>
                candidate.op === name && logged.endsWith('AGENTS.md'),
            );
            if (fault)
              throw Object.assign(new Error(`${fault.code}: faulted ${name}`), {
                code: fault.code,
              });
          }
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
jest.mock('../lib/instruction-files', () => {
  const actual = jest.requireActual<typeof InstructionFiles>(
    '../lib/instruction-files',
  );
  return {
    ...actual,
    ensureAgentsMdSymlink: (
      dir: string,
      platform?: NodeJS.Platform,
    ): Promise<void> =>
      actual.ensureAgentsMdSymlink(dir, platform ?? mockPlatform),
    restoreProjectInstructionFiles: (
      source: InstructionFiles.ProjectInstructionFile,
      target: InstructionFiles.ProjectInstructionFile,
      platform?: NodeJS.Platform,
    ): Promise<void> =>
      actual.restoreProjectInstructionFiles(
        source,
        target,
        platform ?? mockPlatform,
      ),
  };
});
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ClaudeMdConversionMode,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { getDefaultWorkspaceClaudeMd } from '@canopy/desktop-shared/constants/workspace-templates';
import { scaffoldDestinationRoot } from '../lib/adhoc-combine-core';
import {
  LEGACY_MULTI_REPO_GUIDANCE_HEADING,
  MULTI_REPO_GUIDANCE_HEADING,
} from '../lib/multi-repo-guidance';
import { getWorkspaceDir, getWorkspaceWorktreeRootRepoDir } from '../lib/paths';
import {
  __resetSidebarItemsStateForTests,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import {
  createAndPersistNewMultiRepoWorkspace,
  createTemporaryMultiRepoWorkspace,
} from '../lib/workspace-service';
import { applyWorkspaceSourceChangesToWorktree } from '../lib/workspace-source-change-apply';
import {
  initializeWorkspaceSourceRepo,
  prepareNewWorkspaceSourceRepo,
  repairWorkspaceRootWorktree,
} from '../lib/workspace-source-control';
import { convertWorkspaceType } from '../lib/workspace-type-conversion';

const realFs = jest.requireActual<typeof FsPromises>('node:fs/promises');

jest.setTimeout(60_000);

type Layout = (dir: string) => Promise<void>;

const write = (path: string, content: string): Promise<void> =>
  realFs.writeFile(path, content, 'utf8');

const LAYOUTS: Record<string, Layout> = {
  none: () => Promise.resolve(),
  'claude-user': (dir) => write(join(dir, 'CLAUDE.md'), '# User Claude\n'),
  'agents-user': (dir) => write(join(dir, 'AGENTS.md'), '# User Agents\n'),
  'agents-link': async (dir) => {
    await write(join(dir, 'CLAUDE.md'), '# Linked\n');
    await realFs.symlink('CLAUDE.md', join(dir, 'AGENTS.md'));
  },
  'claude-link': async (dir) => {
    await write(join(dir, 'AGENTS.md'), '# Linked Agents\n');
    await realFs.symlink('AGENTS.md', join(dir, 'CLAUDE.md'));
  },
  'equal-mirror': async (dir) => {
    await write(join(dir, 'AGENTS.md'), '# Mirror\n');
    await write(join(dir, 'CLAUDE.md'), '# Mirror\n');
  },
  unequal: async (dir) => {
    await write(join(dir, 'AGENTS.md'), '# Agents side\n');
    await write(join(dir, 'CLAUDE.md'), '# Claude side\n');
  },
  'claude-guidance': (dir) =>
    write(
      join(dir, 'CLAUDE.md'),
      `# Mine\n\nKeep this.\n\n${MULTI_REPO_GUIDANCE_HEADING}\n\nOld generated text.\n`,
    ),
  'claude-legacy-guidance': (dir) =>
    write(
      join(dir, 'CLAUDE.md'),
      `# Mine\n\n${LEGACY_MULTI_REPO_GUIDANCE_HEADING}\n\nOld legacy text.\n`,
    ),
  'agents-other-link': async (dir) => {
    await write(join(dir, 'OTHER.md'), '# Other\n');
    await realFs.symlink('OTHER.md', join(dir, 'AGENTS.md'));
  },
  'agents-dangling': (dir) =>
    realFs.symlink('CLAUDE.md', join(dir, 'AGENTS.md')),
  'claude-dangling': (dir) =>
    realFs.symlink('AGENTS.md', join(dir, 'CLAUDE.md')),
  'agents-escape': (dir) =>
    realFs.symlink('../outside.md', join(dir, 'AGENTS.md')),
  'agents-directory': (dir) => realFs.mkdir(join(dir, 'AGENTS.md')),
  'claude-directory': (dir) => realFs.mkdir(join(dir, 'CLAUDE.md')),
};

let root: string;
let originalDataDir: string | undefined;

let closeW5Store: (() => Promise<void>) | undefined;

beforeEach(async () => {
  __resetSidebarItemsStateForTests();
  mockPlatform = process.platform;
  mockFaults.length = 0;
  mockWrites.length = 0;
  root = await realFs.realpath(
    await realFs.mkdtemp(join(tmpdir(), 'instruction-callers-')),
  );
  mockRoot.path = root;
  const dataDir = join(root, 'data');
  await realFs.mkdir(dataDir);
  await write(join(root, 'outside.md'), '# Outside\n');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  closeW5Store = await installRoutedW5GoldenStore();
});

afterEach(async () => {
  await closeW5Store?.();
  mockRoot.path = '';
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  await realFs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

function scrub(value: string): string {
  return value.split(root).join('<root>');
}

/** Replace each default template body with a marker; pinned once below. */
function render(content: string, names: readonly string[]): string {
  let rendered = content;
  for (const name of names)
    rendered = rendered
      .split(getDefaultWorkspaceClaudeMd(name).trim())
      .join(`<default ${name}>`);
  return scrub(rendered);
}

/** Kind, link target, hard-link sharing and content of both root files. */
async function instructionFiles(
  dir: string,
  names: readonly string[] = [],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const inodes: Record<string, number> = {};
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const path = join(dir, name);
    let stats;
    try {
      stats = await realFs.lstat(path);
    } catch {
      result[name] = '<absent>';
      continue;
    }
    if (stats.isSymbolicLink()) {
      result[name] = `symlink -> ${await realFs.readlink(path)}`;
    } else if (stats.isDirectory()) {
      result[name] = '<directory>';
    } else {
      inodes[name] = stats.ino;
      result[name] = render(await realFs.readFile(path, 'utf8'), names);
    }
  }
  if (
    inodes['AGENTS.md'] !== undefined &&
    inodes['AGENTS.md'] === inodes['CLAUDE.md']
  )
    result['AGENTS.md'] = `hard link to CLAUDE.md: ${result['AGENTS.md']}`;
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    await realFs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

function trackedFiles(repo: string): string {
  return execFileSync('git', ['-C', repo, 'ls-files', '-s'], {
    encoding: 'utf8',
  });
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'resolved';
  } catch (error) {
    const code: unknown =
      typeof error === 'object' && error !== null
        ? Reflect.get(error, 'code')
        : undefined;
    return typeof code === 'string'
      ? `rejected ${code}`
      : `rejected ${scrub(error instanceof Error ? error.message : String(error))}`;
  }
}

async function makeDir(path: string, layout: string): Promise<string> {
  await realFs.mkdir(path, { recursive: true });
  await LAYOUTS[layout](path);
  return path;
}

function initRepo(path: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
}

it('pins the default workspace template', () => {
  expect(getDefaultWorkspaceClaudeMd('Alpha')).toMatchSnapshot();
});

describe('temporary workspace create (workspace-service)', () => {
  async function create(): Promise<Record<string, unknown>> {
    const repoPath = join(root, 'alpha');
    initRepo(repoPath);
    let id = '';
    const result = await outcome(async () => {
      ({ id } = await createTemporaryMultiRepoWorkspace([
        { id: 'alpha', name: 'Alpha', repoPath },
      ]));
    });
    const wsDir = getWorkspaceDir(id || 'alpha');
    return {
      result,
      id,
      workspaceDirExists: await exists(wsDir),
      files: (await exists(wsDir))
        ? await instructionFiles(wsDir, ['Alpha'])
        : null,
      writes: [...mockWrites],
    };
  }

  it('writes the default CLAUDE.md and an AGENTS.md symlink', async () => {
    expect(await create()).toMatchSnapshot();
  });

  it('hard-links AGENTS.md on win32', async () => {
    mockPlatform = 'win32';
    expect(await create()).toMatchSnapshot();
  });

  it('copies AGENTS.md on win32 when hard links fail', async () => {
    mockPlatform = 'win32';
    mockFaults.push({ op: 'link', code: 'EPERM' });
    expect(await create()).toMatchSnapshot();
  });

  it('fails and cleans up when the POSIX symlink is refused', async () => {
    mockFaults.push({ op: 'symlink', code: 'EPERM' });
    expect(await create()).toMatchSnapshot();
  });
});

describe('multi-repo create (workspace-service + source-control initialize)', () => {
  async function create(): Promise<Record<string, unknown>> {
    const workspace =
      await createAndPersistNewMultiRepoWorkspace('  Golden Multi  ');
    const sourceRepoPath = workspace.sourceRepoPath ?? '';
    return {
      id: workspace.id,
      sourceRepoPath: scrub(sourceRepoPath),
      workspaceCopy: await instructionFiles(getWorkspaceDir(workspace.id), [
        'Golden Multi',
      ]),
      sourceRepo: await instructionFiles(sourceRepoPath, ['Golden Multi']),
      tracked: trackedFiles(sourceRepoPath),
      writes: [...mockWrites],
    };
  }

  it('writes the local default without an alias and restores it into the source repo', async () => {
    expect(await create()).toMatchSnapshot();
  });

  it('hard-links the source repo alias on win32', async () => {
    mockPlatform = 'win32';
    expect(await create()).toMatchSnapshot();
  });
});

describe('combine destination scaffold (adhoc-combine-core)', () => {
  it.each([
    ['none', 'darwin'],
    ['claude-user', 'darwin'],
    ['agents-user', 'darwin'],
    ['agents-link', 'darwin'],
    ['agents-other-link', 'darwin'],
    ['agents-directory', 'darwin'],
    ['agents-dangling', 'darwin'],
    ['claude-link', 'darwin'],
    ['none', 'win32'],
    ['agents-user', 'win32'],
    ['agents-link', 'win32'],
    ['claude-link', 'win32'],
  ] as const)('scaffolds over %s on %s', async (layout, platform) => {
    mockPlatform = platform;
    const destination = await makeDir(join(root, 'destination'), layout);
    const result = await outcome(() =>
      scaffoldDestinationRoot(destination, 'Combined'),
    );
    expect({
      result,
      repos: await exists(join(destination, 'repos')),
      files: await instructionFiles(destination, ['Combined']),
      writes: mockWrites,
    }).toMatchSnapshot();
  });

  it.each([
    ['symlink', 'EPERM', 'darwin'],
    ['link', 'EPERM', 'win32'],
  ] as const)('pins a faulted %s (%s) on %s', async (op, code, platform) => {
    mockPlatform = platform;
    mockFaults.push({ op, code });
    const destination = await makeDir(join(root, 'destination'), 'none');
    const result = await outcome(() =>
      scaffoldDestinationRoot(destination, 'Combined'),
    );
    expect({
      result,
      files: await instructionFiles(destination, ['Combined']),
      writes: mockWrites,
    }).toMatchSnapshot();
  });
});

describe('single-repo to multi-repo conversion (workspace-type-conversion)', () => {
  const LAYOUT_NAMES = [
    'none',
    'claude-user',
    'agents-user',
    'agents-link',
    'claude-link',
    'equal-mirror',
    'unequal',
    'claude-guidance',
    'claude-legacy-guidance',
    'agents-escape',
    'claude-directory',
    'agents-other-link',
    'agents-dangling',
    'claude-dangling',
    'agents-directory',
  ];
  const MODES: Array<ClaudeMdConversionMode | undefined> = [
    'replace',
    'update',
    undefined,
    'unchanged',
  ];
  const cases = MODES.flatMap((mode) =>
    LAYOUT_NAMES.map((layout) => [String(mode), layout, mode] as const),
  );

  it.each(cases)('mode %s over %s', async (_label, layout, claudeMdMode) => {
    const repoPath = await makeDir(join(root, 'single'), layout);
    const item: SidebarItem = {
      id: 'single',
      name: 'Single',
      type: 'single-repo',
      color: '#0EA5E9',
      collapsed: false,
      order: 0,
      repoPath,
      worktrees: [],
    };
    await writeAllSidebarItems([item]);
    mockWrites.length = 0;
    const result = await outcome(() =>
      convertWorkspaceType({
        workspaceId: 'single',
        targetType: 'multi-repo',
        ...(claudeMdMode ? { claudeMdMode } : {}),
        source: 'workspace_settings',
      }),
    );
    expect({
      result,
      files: await instructionFiles(repoPath, ['Single']),
      outside: await realFs.readFile(join(root, 'outside.md'), 'utf8'),
      writes: mockWrites,
    }).toMatchSnapshot();
  });
});

describe('source change instruction apply (workspace-source-change-apply)', () => {
  const unexpectedGitEffect = (): never => {
    throw new Error('Existing-target instruction edits must not mutate Git.');
  };
  const git: SourceChangeGit = {
    createWorktree: unexpectedGitEffect,
    removeWorktree: unexpectedGitEffect,
    bestEffortPruneWorktrees: unexpectedGitEffect,
  };
  const WORKSPACE_ID = 'multi';
  const WORKTREE_ID = 'wt-one';

  async function arrange(layout: string): Promise<string> {
    const sourceRepoPath = join(root, 'source');
    initRepo(sourceRepoPath);
    const item: SidebarItem = {
      id: WORKSPACE_ID,
      name: 'Multi',
      type: 'multi-repo',
      color: '#0EA5E9',
      collapsed: false,
      order: 0,
      sourceRepoPath,
      repos: [],
      worktrees: [
        {
          id: WORKTREE_ID,
          branchName: 'wt-one',
          createdAt: '2026-10-23T00:00:00.000Z',
        },
      ],
    };
    await writeAllSidebarItems([item]);
    const worktreeRoot = await makeDir(
      getWorkspaceWorktreeRootRepoDir(WORKSPACE_ID, WORKTREE_ID),
      layout,
    );
    await write(
      join(worktreeRoot, 'canopy.json'),
      JSON.stringify({ version: 1, repos: [] }),
    );
    mockWrites.length = 0;
    return worktreeRoot;
  }

  // The content each layout's resolved instruction file reads as today.
  const CURRENT: Record<string, string> = {
    none: '',
    'claude-user': '# User Claude\n',
    'agents-user': '# User Agents\n',
    'agents-link': '# Linked\n',
    'claude-link': '# Linked Agents\n',
    'equal-mirror': '# Mirror\n',
    unequal: '# Agents side\n',
    'agents-escape': '# Outside\n',
    'claude-directory': '',
    'agents-other-link': '# Other\n',
    'agents-dangling': '',
    'claude-dangling': '',
    'agents-directory': '',
  };

  it.each(
    Object.keys(CURRENT).flatMap((layout) =>
      (['changed', 'equal'] as const).map((content) => [layout, content]),
    ),
  )('applies %s with %s content', async (layout, content) => {
    const worktreeRoot = await arrange(layout);
    const claudeMd = content === 'equal' ? CURRENT[layout] : '# Applied\n';
    const result = await outcome(() =>
      applyWorkspaceSourceChangesToWorktree(
        {
          workspaceId: WORKSPACE_ID,
          target: { mode: 'existing', worktreeId: WORKTREE_ID },
          claudeMd,
        },
        () => null,
        git,
      ),
    );
    expect({
      result,
      files: await instructionFiles(worktreeRoot),
      outside: await realFs.readFile(join(root, 'outside.md'), 'utf8'),
      writes: mockWrites,
    }).toMatchSnapshot();
  });

  it('leaves instructions alone when the change has none', async () => {
    const worktreeRoot = await arrange('claude-user');
    const result = await outcome(() =>
      applyWorkspaceSourceChangesToWorktree(
        {
          workspaceId: WORKSPACE_ID,
          target: { mode: 'existing', worktreeId: WORKTREE_ID },
          workspaceScripts: { dev: 'pnpm dev' },
        },
        () => null,
        git,
      ),
    );
    expect({
      result,
      files: await instructionFiles(worktreeRoot),
      writes: mockWrites,
    }).toEqual({
      result: 'resolved',
      files: { 'AGENTS.md': '<absent>', 'CLAUDE.md': '# User Claude\n' },
      writes: [],
    });
  });
});

describe('workspace root restore and alias (workspace-source-control)', () => {
  describe('initialize: new source repository from the local copy', () => {
    it.each([
      ['none', 'darwin', null],
      ['claude-user', 'darwin', null],
      ['agents-user', 'darwin', null],
      ['agents-link', 'darwin', null],
      ['claude-link', 'darwin', null],
      ['equal-mirror', 'darwin', null],
      ['agents-escape', 'darwin', null],
      ['unequal', 'darwin', null],
      ['agents-dangling', 'darwin', null],
      ['claude-dangling', 'darwin', null],
      ['claude-user', 'win32', null],
      ['agents-link', 'win32', null],
      ['claude-link', 'win32', null],
      ['claude-user', 'darwin', 'symlink'],
    ] as const)(
      'restores a %s local copy on %s (fault %s)',
      async (layout, platform, fault) => {
        mockPlatform = platform;
        if (fault) mockFaults.push({ op: fault, code: 'EPERM' });
        await makeDir(getWorkspaceDir('fresh'), layout);
        mockWrites.length = 0;
        const sourceRepoPath = join(root, 'new-source');
        const result = await outcome(() =>
          prepareNewWorkspaceSourceRepo(
            'fresh',
            'Fresh',
            { version: 1, type: 'multi-repo', repos: [] },
            sourceRepoPath,
          ),
        );
        expect({
          result,
          sourceRepo: await instructionFiles(sourceRepoPath),
          canopyJson: await exists(join(sourceRepoPath, 'canopy.json')),
          tracked: trackedFiles(sourceRepoPath),
          writes: mockWrites,
        }).toMatchSnapshot();
      },
    );
  });

  // The settings path also repairs recorded worktree roots: a root that is not
  // yet a Git checkout is shelved, recreated from the new source repository,
  // and repaired with restore on.
  describe('initialize from settings, then repair recorded worktree roots', () => {
    it.each([
      ['claude-user', null, 'darwin'],
      ['agents-link', null, 'darwin'],
      ['none', null, 'darwin'],
      ['claude-user', 'none', 'darwin'],
      ['claude-user', 'agents-user', 'darwin'],
      ['agents-link', 'agents-dangling', 'darwin'],
      ['claude-user', 'none', 'win32'],
    ] as const)(
      'initializes from a %s local copy with a %s worktree root on %s',
      async (localLayout, worktreeLayout, platform) => {
        mockPlatform = platform;
        const item: SidebarItem = {
          id: 'settings',
          name: 'Settings',
          type: 'multi-repo',
          color: '#0EA5E9',
          collapsed: false,
          order: 0,
          repos: [],
          worktrees: worktreeLayout
            ? [
                {
                  id: 'wt-old',
                  branchName: 'wt-old',
                  createdAt: '2026-10-23T00:00:00.000Z',
                },
              ]
            : [],
        };
        await writeAllSidebarItems([item]);
        await makeDir(getWorkspaceDir('settings'), localLayout);
        const worktreeRoot = getWorkspaceWorktreeRootRepoDir(
          'settings',
          'wt-old',
        );
        if (worktreeLayout) await makeDir(worktreeRoot, worktreeLayout);
        mockWrites.length = 0;
        let sourceRepoPath = '';
        const result = await outcome(async () => {
          ({ sourceRepoPath } = await initializeWorkspaceSourceRepo({
            workspaceId: 'settings',
            source: 'workspace_settings',
          }));
        });
        expect({
          result,
          sourceRepoPath: scrub(sourceRepoPath),
          sourceRepo: sourceRepoPath
            ? await instructionFiles(sourceRepoPath)
            : null,
          tracked: sourceRepoPath ? trackedFiles(sourceRepoPath) : null,
          worktreeRoot: worktreeLayout
            ? await instructionFiles(worktreeRoot)
            : null,
          writes: [...mockWrites],
        }).toMatchSnapshot();
      },
    );
  });

  describe('repair: an existing worktree root', () => {
    const WORKSPACE_ID = 'repair';
    const WORKTREE_ID = 'wt-fix';

    async function repair(
      targetLayout: string,
      sourceLayout: string,
      restore: boolean,
    ): Promise<Record<string, unknown>> {
      const referenceRepo = await makeDir(join(root, 'reference'), 'none');
      initRepo(referenceRepo);
      await LAYOUTS[sourceLayout](referenceRepo);
      const item: SidebarItem = {
        id: WORKSPACE_ID,
        name: 'Repair',
        type: 'multi-repo',
        color: '#0EA5E9',
        collapsed: false,
        order: 0,
        sourceRepoPath: referenceRepo,
        repos: [],
        worktrees: [],
      };
      await writeAllSidebarItems([item]);
      const worktreeRoot = await makeDir(
        getWorkspaceWorktreeRootRepoDir(WORKSPACE_ID, WORKTREE_ID),
        targetLayout,
      );
      mockWrites.length = 0;
      let issues: unknown = null;
      const result = await outcome(async () => {
        issues = await repairWorkspaceRootWorktree(
          WORKSPACE_ID,
          WORKTREE_ID,
          restore,
        );
      });
      return {
        result,
        issues,
        target: await instructionFiles(worktreeRoot),
        canopyJson: await exists(join(worktreeRoot, 'canopy.json')),
        gitignore: await exists(join(worktreeRoot, '.gitignore')),
        outside: await realFs.readFile(join(root, 'outside.md'), 'utf8'),
        writes: [...mockWrites],
      };
    }

    it.each(
      [
        'none',
        'claude-user',
        'agents-user',
        'agents-link',
        'claude-link',
        'equal-mirror',
        'agents-escape',
        'claude-directory',
        'agents-dangling',
        'claude-dangling',
      ].flatMap((target) =>
        [true, false].map((restore) => [target, restore] as const),
      ),
    )(
      'keeps or restores a %s target (restore %p) from a CLAUDE.md source',
      async (target, restore) => {
        expect(await repair(target, 'claude-user', restore)).toMatchSnapshot();
      },
    );

    it.each([
      'none',
      'agents-user',
      'agents-link',
      'claude-link',
      'equal-mirror',
      'agents-escape',
      'unequal',
      'agents-dangling',
      'claude-dangling',
    ])('restores an empty target from a %s source', async (source) => {
      expect(await repair('none', source, true)).toMatchSnapshot();
    });

    it.each(['agents-link', 'claude-link', 'unequal'])(
      'fills a dangling AGENTS.md alias target from a %s source',
      async (source) => {
        expect(await repair('agents-dangling', source, true)).toMatchSnapshot();
      },
    );

    it.each([
      ['claude-user', 'claude-user', 'win32', null],
      ['none', 'claude-user', 'win32', null],
      ['none', 'agents-link', 'win32', null],
      ['none', 'claude-link', 'win32', null],
      ['agents-dangling', 'claude-user', 'win32', null],
      ['claude-user', 'claude-user', 'darwin', 'symlink'],
      ['none', 'claude-user', 'darwin', 'symlink'],
      ['none', 'agents-link', 'darwin', 'symlink'],
    ] as const)(
      'pins a %s target from a %s source on %s (fault %s)',
      async (target, source, platform, fault) => {
        mockPlatform = platform;
        if (fault) mockFaults.push({ op: fault, code: 'EPERM' });
        expect(await repair(target, source, true)).toMatchSnapshot();
      },
    );
  });
});

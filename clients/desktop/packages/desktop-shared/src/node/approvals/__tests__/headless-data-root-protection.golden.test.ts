import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalCheck, ApprovalRule } from '../../../types';
import { evaluateApproval } from '../../../lib/approval-engine';
import { selectedCapabilityRoot } from '../../opencode/cli-capabilities';
import {
  createHeadlessApprovalSession,
  type HeadlessApprovalSession,
} from '../headless-session';

// CAN-7981: unattended OpenCode and Antigravity steps treat every path under
// the data root as protected, at any depth, except the working folders Canopy
// hands the agent. Headless turns a protected prompt into a refusal.

const REFUSED =
  'The saved approval policy does not allow this unattended action.';
const CREATED_AT = '2026-11-26T00:00:00.000Z';

const rule = (id: string, target: ApprovalRule['target']): ApprovalRule => ({
  id,
  behavior: 'allow',
  target,
  createdAt: CREATED_AT,
  origin: 'settings',
});

// A blanket file-write allow and a blanket command allow.
const BLANKET_RULES = [
  rule('write-anything', { kind: 'file-write', path: '/**' }),
  rule('run-anything', { kind: 'command', pattern: '*' }),
];

const READ_ONLY_RULES = ['Read', 'Grep', 'Glob'].map((toolName) =>
  rule(`read-only:${toolName}`, { kind: 'tool', toolName }),
);

describe('headless approvals protect the whole data root (CAN-7981)', () => {
  const savedDataDir = process.env.CANOPY_DATA_DIR;
  let dataDir = '';
  let outsideDir = '';
  let worktree = '';
  let profile = '';

  beforeEach(async () => {
    // Not canonical on macOS (/var -> /private/var): the session must resolve.
    dataDir = await mkdtemp(join(tmpdir(), 'headless-data-root-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'headless-outside-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    worktree = join(dataDir, 'workspaces', 'ws-own', 'worktrees', 'wt-1');
    profile = join(
      dataDir,
      'pipeline-executions',
      'exec-1',
      'opencode-sessions',
      'profile-1',
    );
    for (const folder of [
      join(worktree, 'src'),
      join(dataDir, 'workspaces', 'ws-other', 'worktrees'),
      join(dataDir, 'repos', 'app'),
      join(dataDir, 'repos', 'other'),
      join(dataDir, 'antigravity', 'config'),
      join(dataDir, 'storage-records', 'preferences'),
      join(selectedCapabilityRoot(profile), 'skills', 'skill-1'),
    ])
      await mkdir(folder, { recursive: true });
    await writeFile(
      join(dataDir, 'preferences.json'),
      JSON.stringify({
        version: 1,
        generation: 1,
        preferences: { globalApprovalRules: BLANKET_RULES },
      }),
    );
    await writeFile(
      join(dataDir, 'workspaces', 'index.json'),
      JSON.stringify({
        workspaces: [
          { id: 'ws-own', name: 'Own', type: 'single-repo', color: '#000000' },
        ],
      }),
    );
    await writeFile(
      join(dataDir, 'workspaces', 'ws-own', 'workspace.json'),
      JSON.stringify({
        version: 1,
        type: 'single-repo',
        repoPath: join(dataDir, 'repos', 'app'),
      }),
    );
  });

  afterEach(async () => {
    if (savedDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = savedDataDir;
    await rm(dataDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  const session = (
    sessionRules: ApprovalRule[] = [],
  ): HeadlessApprovalSession =>
    createHeadlessApprovalSession({
      cwd: worktree,
      projectId: 'ws-own',
      mode: 'ask',
      sessionRules,
      signal: new AbortController().signal,
    });

  const display = {
    title: 'Approval',
    details: { kind: 'tool' as const, toolName: 'Edit' },
  };

  const decide = async (
    approval: HeadlessApprovalSession,
    check: ApprovalCheck,
  ): Promise<{ decision: string; message?: string }> => {
    const { decision, message } = await approval.check(check, display);
    return message === undefined ? { decision } : { decision, message };
  };
  const write = (path: string): ApprovalCheck => ({ kind: 'file-write', path });
  const touch = (path: string): ApprovalCheck => ({
    kind: 'command',
    command: `touch ${path}`,
    cwd: worktree,
  });
  const read = (toolName: string, readPath: string): ApprovalCheck => ({
    kind: 'tool',
    toolName,
    readPath,
  });
  const refused = { decision: 'deny', message: REFUSED };
  const allowed = { decision: 'allow' };

  it('refuses writes and command operands anywhere in the data root, despite allow rules', async () => {
    const approval = session();
    for (const path of [
      join(dataDir, 'preferences.json'),
      join(dataDir, 'workspaces'),
      join(dataDir, 'workspaces', 'ws-other', 'approvals.json'),
      join(dataDir, 'workspaces', 'ws-own', 'approvals.json'),
      join(dataDir, 'antigravity', 'approval-hook.sh'),
      join(dataDir, 'antigravity', 'config', 'hooks.json'),
      join(dataDir, 'storage-records', 'preferences', 'owner-flip.json'),
      // The OpenCode profile's private config and hook plugins stay protected.
      join(profile, 'opencode.json'),
      join(profile, 'selected-hook-plugins', 'hooks.json'),
    ]) {
      await expect(decide(approval, write(path))).resolves.toEqual(refused);
      await expect(decide(approval, touch(path))).resolves.toEqual(refused);
    }
  });

  it('refuses read-only reads of a deep policy file and a Grep over a workspace folder', async () => {
    const approval = session(READ_ONLY_RULES);
    await expect(
      decide(
        approval,
        read('Read', join(dataDir, 'workspaces', 'ws-other', 'approvals.json')),
      ),
    ).resolves.toEqual(refused);
    // The folder holds an exempt worktree, but also the workspace's policy.
    await expect(
      decide(approval, read('Grep', join(dataDir, 'workspaces', 'ws-other'))),
    ).resolves.toEqual(refused);
    await expect(
      decide(approval, read('Glob', join(dataDir, 'workspaces', 'ws-own'))),
    ).resolves.toEqual(refused);
  });

  it('allows work inside managed worktrees, default clones, staged skills and outside the data root', async () => {
    const approval = session(READ_ONLY_RULES);
    for (const path of [
      join(worktree, 'src', 'index.ts'),
      join(dataDir, 'repos', 'other', 'README.md'),
    ]) {
      await expect(decide(approval, write(path))).resolves.toEqual(allowed);
      await expect(decide(approval, touch(path))).resolves.toEqual(allowed);
      await expect(decide(approval, read('Read', path))).resolves.toEqual(
        allowed,
      );
    }
    await expect(decide(approval, read('Grep', worktree))).resolves.toEqual(
      allowed,
    );
    await expect(
      decide(approval, write(join(outsideDir, 'notes.txt'))),
    ).resolves.toEqual(allowed);

    // The OpenCode host exempts the skills it staged for this step only.
    const skill = join(
      selectedCapabilityRoot(profile),
      'skills',
      'skill-1',
      'SKILL.md',
    );
    await expect(decide(approval, read('Read', skill))).resolves.toEqual(
      refused,
    );
    approval.exemptWorkingFolder(selectedCapabilityRoot(profile));
    await expect(decide(approval, read('Read', skill))).resolves.toEqual(
      allowed,
    );
    await expect(
      decide(approval, read('Read', join(profile, 'opencode.json'))),
    ).resolves.toEqual(refused);
  });

  it("keeps the desktop list's one-segment `*` entries unchanged", async () => {
    const root = await realpath(dataDir);
    const evaluate = (path: string): string =>
      evaluateApproval(
        { kind: 'file-write', path, resolvedPath: path },
        {
          mode: 'ask',
          rules: { session: [], project: [], global: BLANKET_RULES },
          protectedFileWritePaths: [join(root, 'preferences.backup-*.json')],
        },
      ).outcome;
    expect(evaluate(join(root, 'preferences.backup-2026-11-26.json'))).toBe(
      'prompt',
    );
    expect(
      evaluate(join(root, 'preferences.backup-2026-11-26.json', 'nested')),
    ).toBe('allow');
    expect(evaluate(join(root, 'nested', 'preferences.backup-1.json'))).toBe(
      'allow',
    );
  });
});

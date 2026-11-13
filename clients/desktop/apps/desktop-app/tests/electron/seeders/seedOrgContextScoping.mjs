import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

export const ORG_CONTEXT_A = '11111111-1111-4111-8111-111111111111';
export const ORG_CONTEXT_B = '22222222-2222-4222-8222-222222222222';
export const PERSONAL_CONTEXT_WORKSPACE = 'context-personal';
export const ORG_CONTEXT_WORKSPACE = 'context-organization';
/** Org B's workspace, seeded only with `organizationB: true` (CAN-3461). */
export const ORG_CONTEXT_B_WORKSPACE = 'context-organization-b';
export const ORG_CONTEXT_ORGANIZATIONS = [
  { id: ORG_CONTEXT_A, name: 'Acme' },
  { id: ORG_CONTEXT_B, name: 'Empty organization' },
].map((organization) => ({
  ...organization,
  role: 'MEMBER',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}));
export const ORG_CONTEXT_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-shared-org-projects-enabled': true,
  }),
  // These specs drive the same-repository relationship and explicit setup or
  // conversion by hand, so automatic conversion (CAN-3416) must not convert
  // their matching Personal checkouts first. Specs of automatic conversion
  // override this with 'on'.
  CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT: 'off',
};

/**
 * Seed two local repositories and a Personal chat before launch. All files stay in the isolated
 * user data directory and are removed by closeCanopy.
 * `extraPersonalWorkspaces` adds more Personal single-repo workspaces, each
 * with its own repository under `repos/<id>`.
 * `organizationB` adds a workspace owned by Org B, so Org B is no longer
 * empty, and `organizationWorktreeIds` gives each organization workspace
 * worktrees (`<id>` in Org A, `beta-<id>` in Org B) for the two-org fixture.
 * @param {string} userDataDir
 * @param {{
 *   personalWorktreeIds?: string[],
 *   extraPersonalWorkspaces?: { id: string, name: string }[],
 *   extraOrganizationWorkspaces?: { id: string, name: string, projectId: string, instanceId: string, organizationId?: string, remoteUrl?: string, worktreeIds?: string[] }[],
 *   personalRemoteUrl?: string,
 *   organizationB?: boolean,
 *   organizationWorktreeIds?: string[],
 * }} [options]
 * @returns {void}
 */
export function seedOrgContextScoping(
  userDataDir,
  {
    personalWorktreeIds = [],
    extraPersonalWorkspaces = [],
    extraOrganizationWorkspaces = [],
    personalRemoteUrl,
    organizationB = false,
    organizationWorktreeIds = [],
  } = {},
) {
  const workspaces = [
    { id: PERSONAL_CONTEXT_WORKSPACE, name: 'Personal repository' },
    { id: ORG_CONTEXT_WORKSPACE, name: 'Acme repository' },
    ...(organizationB
      ? [{ id: ORG_CONTEXT_B_WORKSPACE, name: 'Beta repository' }]
      : []),
    ...extraPersonalWorkspaces,
    ...extraOrganizationWorkspaces.map(({ id, name }) => ({ id, name })),
  ];

  for (const workspace of workspaces) {
    const extraOrganization = extraOrganizationWorkspaces.find(
      (extra) => extra.id === workspace.id,
    );
    const repoPath = path.join(userDataDir, 'repos', workspace.id);
    mkdirSync(repoPath, { recursive: true });
    const commands = [
      ['init', '--initial-branch=main'],
      ['add', 'README.md'],
      [
        '-c',
        'user.name=Canopy Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'initial',
      ],
    ];
    writeFileSync(
      path.join(repoPath, 'README.md'),
      `${workspace.name}\n`,
      'utf8',
    );
    for (const args of commands) {
      execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
    }
    const remoteUrl =
      extraOrganization?.remoteUrl ??
      (workspace.id === PERSONAL_CONTEXT_WORKSPACE
        ? personalRemoteUrl
        : undefined);
    if (typeof remoteUrl === 'string') {
      execFileSync('git', ['remote', 'add', 'origin', remoteUrl], {
        cwd: repoPath,
        stdio: 'pipe',
      });
    }
    const workspaceDir = path.join(userDataDir, 'workspaces', workspace.id);
    const worktreeIds =
      workspace.id === PERSONAL_CONTEXT_WORKSPACE
        ? personalWorktreeIds
        : workspace.id === ORG_CONTEXT_WORKSPACE
          ? organizationWorktreeIds
          : workspace.id === ORG_CONTEXT_B_WORKSPACE
            ? organizationWorktreeIds.map((id) => `beta-${id}`)
            : (extraOrganization?.worktreeIds ?? []);
    for (const id of worktreeIds) {
      execFileSync(
        'git',
        ['worktree', 'add', '-b', id, path.join(workspaceDir, 'worktrees', id)],
        { cwd: repoPath, stdio: 'pipe' },
      );
    }
    writeJson(path.join(workspaceDir, 'workspace.json'), {
      version: 1,
      type: 'single-repo',
      repoPath,
      repos: [],
      alwaysShow: true,
      ...(workspace.id === ORG_CONTEXT_WORKSPACE
        ? {
            owner: {
              type: 'organization',
              organizationId: ORG_CONTEXT_A,
              projectId: '33333333-3333-4333-8333-333333333333',
              instanceId: '44444444-4444-4444-8444-444444444444',
              bindingGeneration: 0,
            },
          }
        : workspace.id === ORG_CONTEXT_B_WORKSPACE
          ? {
              owner: {
                type: 'organization',
                organizationId: ORG_CONTEXT_B,
                projectId: '55555555-5555-4555-8555-555555555555',
                instanceId: '66666666-6666-4666-8666-666666666666',
                bindingGeneration: 0,
              },
            }
          : extraOrganization
            ? {
                owner: {
                  type: 'organization',
                  organizationId:
                    extraOrganization.organizationId ?? ORG_CONTEXT_A,
                  projectId: extraOrganization.projectId,
                  instanceId: extraOrganization.instanceId,
                  bindingGeneration: 0,
                },
              }
            : {}),
    });
    writeJson(path.join(workspaceDir, 'worktrees.json'), {
      version: 1,
      worktrees: worktreeIds.map((id) => ({
        id,
        branchName: id,
        createdAt: '2026-07-01T09:00:00.000Z',
      })),
    });
  }
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      ...workspaces.map((workspace, order) => ({
        ...workspace,
        type: 'single-repo',
        color: '#7C9B6D',
        collapsed: false,
        order,
      })),
      {
        id: 'cowork-default',
        name: 'Chats',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: workspaces.length,
        cowork: {
          createdAt: '2026-07-01T10:00:00.000Z',
          archiveRetentionDays: null,
        },
      },
    ],
  });
  const coworkDir = path.join(userDataDir, 'workspaces', 'cowork-default');
  writeJson(path.join(coworkDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork: {
      createdAt: '2026-07-01T10:00:00.000Z',
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(coworkDir, 'work-entries.json'), {
    version: 1,
    entries: [
      { id: 'context-personal-chat', createdAt: '2026-07-01T10:00:00.000Z' },
    ],
  });
  writeJson(path.join(coworkDir, 'chats', 'context-personal-chat.json'), {
    version: 1,
    activeTabId: 'context-chat-tab',
    tabs: [
      {
        id: 'context-chat-tab',
        title: 'Personal planning chat',
        createdAt: '2026-07-01T10:00:00.000Z',
        kind: 'chat',
        messages: [
          {
            id: 'context-chat-message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Plan my personal work.' }],
            timestamp: Date.parse('2026-07-01T10:00:00.000Z'),
          },
        ],
      },
    ],
  });
}

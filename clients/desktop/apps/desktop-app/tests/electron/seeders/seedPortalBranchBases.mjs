import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/** Isolated divergent refs and a local bare origin; no external network. */
export function seedPortalBranchBases(userDataDir) {
  const workspaceId = 'can-1782-bases';
  const worktreeId = 'can-1782-editor';
  const workspaceDir = path.join(userDataDir, 'workspaces', workspaceId);
  const repoPath = path.join(userDataDir, 'can-1782-reference');
  const originPath = path.join(userDataDir, 'can-1782-origin.git');
  mkdirSync(repoPath, { recursive: true });
  const git = (args) =>
    execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Branch base fixture']);
  git(['config', 'user.email', 'fixture@example.com']);
  const commit = (file, message) => {
    writeFileSync(path.join(repoPath, file), `${message}\n`);
    git(['add', file]);
    git(['commit', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };
  const common = commit('README.md', 'Common ancestor');
  const localName = 'audit/local-base';
  const remoteName = 'audit/remote-only';
  git(['checkout', '-b', localName, common]);
  const localCommit = commit('local-only.txt', 'Selected local base');
  git(['checkout', '-b', remoteName, common]);
  const remoteCommit = commit('remote-only.txt', 'Selected remote base');
  git(['checkout', 'main']);
  const defaultCommit = commit('default-only.txt', 'Default-only history');
  git(['init', '--bare', originPath]);
  git(['remote', 'add', 'origin', originPath]);
  git(['push', 'origin', 'main', remoteName]);
  git(['--git-dir', originPath, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['branch', '-D', remoteName]);
  git(['fetch', 'origin']);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  const worktreePath = path.join(workspaceDir, 'worktrees', worktreeId);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(['worktree', 'add', '-b', worktreeId, worktreePath, localName]);
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.workspaces.push({
    id: workspaceId,
    name: 'Branch base fixture',
    type: 'single-repo',
    color: index.workspaces[0].color,
    collapsed: false,
    order: index.workspaces.length,
  });
  writeJson(indexPath, index);
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath,
    repos: [],
    alwaysShow: true,
  });
  writeJson(path.join(workspaceDir, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: worktreeId,
        branchName: worktreeId,
        createdAt: '2026-10-30T00:00:00.000Z',
        trackedBaseBranch: localName,
      },
    ],
  });
  return {
    workspaceId,
    worktreeId,
    repoPath,
    localName,
    remoteName,
    localCommit,
    remoteCommit,
    defaultCommit,
  };
}

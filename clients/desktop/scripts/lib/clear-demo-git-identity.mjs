import { execFileSync } from 'node:child_process';

const DEMO_IDENTITY = [
  ['user.name', 'Canopy Demo'],
  ['user.email', 'canopy-demo@example.invalid'],
];

/**
 * Removes the demo identity that demo-apps seeds wrote into a checkout's
 * local config before they passed it per commit. Local config is shared by
 * every linked worktree, so it made everyone's commits "Canopy Demo". Only
 * an exact match of both values is cleared; answers whether it cleared one.
 */
export function clearDemoGitIdentity(cwd = process.cwd()) {
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    if (
      !DEMO_IDENTITY.every(
        ([key, value]) => git('config', '--local', '--get-all', key) === value,
      )
    )
      return false;
  } catch {
    // Not a git checkout, or a key is unset.
    return false;
  }
  for (const [key] of DEMO_IDENTITY) git('config', '--local', '--unset', key);
  return true;
}

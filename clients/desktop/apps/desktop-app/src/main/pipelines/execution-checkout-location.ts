import { isAbsolute, join, relative, sep } from 'node:path';
import { isRecord } from '../lib/type-guards';

interface CheckoutPathMapping {
  fromRoot: string;
  toRoot: string;
}

interface CheckoutRelocation {
  sourceWorkspaceId: string;
  sourceWorktreeId: string;
  destinationWorkspaceId: string;
  destinationWorktreeId: string;
  rewrites: readonly CheckoutPathMapping[];
}

/** Only a host-supplied source checkout has a replacement authority. */
export function relocateCheckoutPath(
  value: string,
  rewrites: readonly CheckoutPathMapping[],
): string {
  if (!isAbsolute(value)) return value;
  for (const { fromRoot, toRoot } of [...rewrites].sort(
    (a, b) => b.fromRoot.length - a.fromRoot.length,
  )) {
    if (!isAbsolute(fromRoot) || !isAbsolute(toRoot)) continue;
    const suffix = relative(fromRoot, value);
    if (
      suffix !== '..' &&
      !suffix.startsWith(`..${sep}`) &&
      !isAbsolute(suffix)
    ) {
      return join(toRoot, suffix);
    }
  }
  return value;
}

/** Rebase mapped checkout/source locations, never artifacts, policy contents or sessions. */
export function relocateExecutionCheckout<
  T extends {
    cwd?: unknown;
    execution_checkout_root?: unknown;
    repo_path?: unknown;
    pipeline_file_dir?: unknown;
    target?: unknown;
  },
>(state: T, relocation: CheckoutRelocation): T {
  const rewrite = (value: unknown): unknown =>
    typeof value === 'string'
      ? relocateCheckoutPath(value, relocation.rewrites)
      : value;
  const target = state.target;
  const sourceOwned =
    isRecord(target) &&
    target.scope === 'worktree' &&
    target.workspace_id === relocation.sourceWorkspaceId &&
    target.worktree_id === relocation.sourceWorktreeId;
  const nextTarget =
    isRecord(target) && (target.scope === 'directory' || sourceOwned)
      ? {
          ...target,
          ...('path' in target ? { path: rewrite(target.path) } : {}),
          ...(sourceOwned
            ? {
                workspace_id: relocation.destinationWorkspaceId,
                worktree_id: relocation.destinationWorktreeId,
              }
            : {}),
        }
      : target;
  return {
    ...state,
    ...('cwd' in state ? { cwd: rewrite(state.cwd) } : {}),
    ...('execution_checkout_root' in state
      ? { execution_checkout_root: rewrite(state.execution_checkout_root) }
      : {}),
    ...('repo_path' in state ? { repo_path: rewrite(state.repo_path) } : {}),
    ...('pipeline_file_dir' in state
      ? { pipeline_file_dir: rewrite(state.pipeline_file_dir) }
      : {}),
    ...('target' in state ? { target: nextTarget } : {}),
  };
}

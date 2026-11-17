/**
 * Build scheduler keys of workspace base graphs (`codeGraphBaseRunnerKey`).
 * Every other key names a worktree graph. Kept free of imports so the build
 * runner can tell them apart without loading the base store.
 */
export const CODE_GRAPH_BASE_RUNNER_KEY_PREFIX = 'base:';

/** Whether a build scheduler key names a workspace base graph, not a worktree's. */
export function isCodeGraphBaseRunnerKey(key: string): boolean {
  return key.startsWith(CODE_GRAPH_BASE_RUNNER_KEY_PREFIX);
}

import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';
import {
  AppErrorSchema,
  getAppErrorDefinition,
  type AppError,
} from '@canopy/protocol/app-errors';
import { githubAuthFailureCode } from './github-push-auth-failure';

/** Static app-error sources for per-repo git failures returned in `failedRepos`. */
export type GitFailureSource =
  | 'git.commit_and_push'
  | 'git.commit_message'
  | 'git.create_pr'
  | 'git.merge_local'
  | 'git.merge_pr'
  | 'git.pull'
  | 'git.push';

/**
 * Report a per-repo git failure that is returned rather than thrown. Only the
 * static `source` and the classified code leave the process; git output stays
 * in the raw error. An expected GitHub sign-in failure is not reported.
 *
 * Returns the recorded error in the same wire-safe form as an IPC rejection
 * (catalog copy, detail reduced to the code) so the renderer can link its
 * banner to it instead of recording the failure again.
 */
export function reportRepoGitFailure(
  error: unknown,
  source: GitFailureSource,
): AppError | undefined {
  if (githubAuthFailureCode(error)) return undefined;
  return recordWireSafeError(error, source);
}

/**
 * Report a deferred worktree git setup failure and return the recorded error
 * in wire-safe form, so the renderer links its notice to it.
 */
export function reportGitSetupFailure(error: unknown): AppError | undefined {
  return recordWireSafeError(error, 'worktree.git_setup');
}

function recordWireSafeError(
  error: unknown,
  source: GitFailureSource | 'worktree.git_setup',
): AppError | undefined {
  const report = reportMainAppError(error, { source });
  if (report === undefined || report.disposition === 'none') return undefined;
  return AppErrorSchema.parse({
    ...report.error,
    copy: getAppErrorDefinition(report.error.code).copy,
    detail: { message: report.error.code },
  });
}

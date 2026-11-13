import {
  hasRemoteTrackingBranch,
  hasUncommittedChanges,
  hasUnpushedCommits,
  getCurrentBranch,
  getUncommittedDiff,
  stageAllChanges,
  commitWithMessage,
  pushBranch,
} from '@canopy/desktop-shared/lib/git';
import { generateCommitMessageWithUsage } from '@canopy/desktop-shared/lib/commit-message-generator';
import { localMemoryEnabledFromEnv } from '@canopy/execution-engine/node/lib/native-memory';
import {
  type PrInstructionMode,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { setOutput, writeOutputFile } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';
import { parseThinkingLevelInput } from '@canopy/execution-engine/builtin-actions/_lib/thinking';
import {
  hydrateModelRegistryFromEnv,
  resolveConfiguredModel,
} from '@canopy/execution-engine/builtin-actions/_lib/model-registry';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import { redactValues } from '@canopy/execution-engine/lib/redaction';
import {
  redactNormalizedPreservingFormat,
  parseAgentSecretValuesEnv,
  redactNormalizedText,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import {
  discoverWorkspaceRepos,
  type DiscoveredRepo,
} from '../_lib/repo-discovery';

interface CommitPushConfig {
  model: string;
  thinkingLevel: ThinkingLevel | undefined;
  instructions: string;
  instructionMode: PrInstructionMode;
}

interface CommitPushRepoResult {
  repoId: string;
  repoName: string;
  repoPath: string;
  relativePath: string;
  branchName: string;
  status: 'committed_and_pushed' | 'pushed' | 'no_changes' | 'failed';
  hadUncommittedChanges: boolean;
  hadUnpushedCommits: boolean;
  model: string;
  commitMessage: string;
  commitHash: string;
  pushed: boolean;
  error: string;
  failurePhase?: 'commit' | 'other';
  precommitFailureError?: string;
}

const DEFAULT_COMMIT_MODEL = 'haiku';
const DEFAULT_COMMIT_INSTRUCTIONS =
  'Write a concise conventional-commit style commit message. ' +
  'Subject line under 72 characters. ' +
  'Include a body only when the changes are complex enough to warrant explanation.';

function resolveInstructionMode(
  raw: string | undefined,
  fallback: PrInstructionMode,
): PrInstructionMode {
  const trimmed = raw?.trim();
  if (trimmed === 'replace' || trimmed === 'append') {
    return trimmed;
  }
  return fallback;
}

function resolveCommitConfig(env: NodeJS.ProcessEnv): CommitPushConfig {
  return {
    model: resolveConfiguredModel(
      env.INPUT_COMMIT_MODEL ??
        getBrandEnv(env, 'PREF_COMMIT_GENERATION_MODEL'),
      DEFAULT_COMMIT_MODEL,
    ),
    thinkingLevel: parseThinkingLevelInput(
      env.INPUT_COMMIT_THINKING_LEVEL ??
        getBrandEnv(env, 'PREF_COMMIT_GENERATION_THINKING_LEVEL'),
      { field: 'commit_thinking_level', fallback: 'off' },
    ),
    instructions:
      env.INPUT_COMMIT_INSTRUCTIONS ??
      getBrandEnv(env, 'PREF_COMMIT_INSTRUCTIONS') ??
      '',
    instructionMode: resolveInstructionMode(
      env.INPUT_COMMIT_INSTRUCTION_MODE ??
        getBrandEnv(env, 'PREF_COMMIT_INSTRUCTION_MODE'),
      'append',
    ),
  };
}

function buildCommitInstructions(config: CommitPushConfig): string {
  if (config.instructionMode === 'replace' && config.instructions.trim()) {
    return config.instructions.trim();
  }

  if (config.instructions.trim()) {
    return `${DEFAULT_COMMIT_INSTRUCTIONS}\n\nAdditional instructions:\n${config.instructions.trim()}`;
  }

  return DEFAULT_COMMIT_INSTRUCTIONS;
}

function getUnderlyingErrorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const maybeStderr = (error as { stderr?: unknown }).stderr;
    if (typeof maybeStderr === 'string' && maybeStderr.trim().length > 0) {
      return maybeStderr.trim();
    }
  }

  return error instanceof Error ? error.message : String(error);
}

function renderSummary(results: CommitPushRepoResult[]): string {
  const committedCount = results.filter(
    (result) => result.status === 'committed_and_pushed',
  ).length;
  const pushedCount = results.filter(
    (result) => result.status === 'pushed',
  ).length;
  const noopCount = results.filter(
    (result) => result.status === 'no_changes',
  ).length;
  const failedCount = results.filter(
    (result) => result.status === 'failed',
  ).length;

  const repoLines = results.map((result) => {
    const details = [
      `id=${result.repoId}`,
      `path=${result.relativePath}`,
      `branch=${result.branchName || '(unknown)'}`,
    ];

    if (result.commitHash) {
      details.push(`commit=${result.commitHash}`);
    }

    if (result.error) {
      details.push(`error=${result.error}`);
    }

    return `- ${result.status}: ${result.repoName} (${details.join(', ')})`;
  });

  return [
    '# Git Commit + Push',
    '',
    `- Repo count: ${String(results.length)}`,
    `- Committed and pushed: ${String(committedCount)}`,
    `- Pushed only: ${String(pushedCount)}`,
    `- No changes: ${String(noopCount)}`,
    `- Failed: ${String(failedCount)}`,
    '',
    '## Repo Results',
    ...repoLines,
    '',
  ].join('\n');
}

async function processRepo(
  repo: DiscoveredRepo,
  config: CommitPushConfig,
  secretValues: readonly string[],
): Promise<CommitPushRepoResult> {
  let branchName = '';
  let commitMessage = '';
  let commitHash = '';
  let hadUncommittedChanges = false;
  let hadUnpushedCommits = false;
  let pushed = false;

  try {
    branchName = await getCurrentBranch(repo.repoPath);
    hadUncommittedChanges = await hasUncommittedChanges(repo.repoPath);

    const hasTracking = await hasRemoteTrackingBranch(repo.repoPath);
    if (hasTracking) {
      hadUnpushedCommits = await hasUnpushedCommits(repo.repoPath);
    } else {
      // No upstream tracking branch — always attempt a push.
      // git push -u origin HEAD is a no-op if origin is already up-to-date.
      hadUnpushedCommits = true;
    }

    if (!hadUncommittedChanges && !hadUnpushedCommits) {
      return {
        repoId: repo.repoId,
        repoName: repo.repoName,
        repoPath: repo.repoPath,
        relativePath: repo.relativePath,
        branchName,
        status: 'no_changes',
        hadUncommittedChanges: false,
        hadUnpushedCommits: false,
        model: config.model,
        commitMessage: '',
        commitHash: '',
        pushed: false,
        error: '',
      };
    }

    if (hadUncommittedChanges) {
      const diff = await getUncommittedDiff(repo.repoPath);
      const generatedCommitMessage = await generateCommitMessageWithUsage({
        repoPath: repo.repoPath,
        branchName,
        diff,
        model: config.model,
        thinkingLevel: config.thinkingLevel,
        // Builtin actions are plain Node subprocesses: the desktop step
        // runner projects the opt-in local memory preference into the
        // branded `PREF_LOCAL_MEMORY_ENABLED` env var; absent (CLI-native
        // runs) means OFF, keeping provider-native memory defaults
        // (CAN-1969).
        localMemoryEnabled: localMemoryEnabledFromEnv(),
        instructions: buildCommitInstructions(config),
        instructionMode: 'replace',
      });
      if (generatedCommitMessage.source !== 'model') {
        throw new Error(
          'Commit message generation returned fallback content instead of model output.',
        );
      }
      // Redacted BEFORE it becomes the actual commit, not just before it's
      // reported: the model generating this message inherits `secretEnv`
      // in its own process and can read a pipeline secret, and a secret
      // baked into a real commit that then gets pushed is permanent, public
      // history — reporting a redacted copy while committing the raw
      // message would leave that exfiltration wide open one step earlier
      // than this fix's own local-output redaction.
      // `redactNormalizedPreservingFormat`, not `redactNormalizedText`: a
      // commit message conventionally has a multi-line subject/body
      // structure, and `redactNormalizedText` collapses ALL whitespace in the
      // whole text. This matches the same whitespace-reformatted values but
      // splices the mask in at the original offsets, so the structure is
      // kept.
      commitMessage = redactNormalizedPreservingFormat(
        generatedCommitMessage.message,
        secretValues,
      );
      await stageAllChanges(repo.repoPath);
      try {
        commitHash = await commitWithMessage(repo.repoPath, commitMessage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const precommitFailureError = getUnderlyingErrorText(error);
        return {
          repoId: repo.repoId,
          repoName: repo.repoName,
          repoPath: repo.repoPath,
          relativePath: repo.relativePath,
          branchName,
          status: 'failed',
          hadUncommittedChanges,
          hadUnpushedCommits,
          model: config.model,
          commitMessage,
          commitHash,
          pushed,
          // `redactNormalizedText` (see its doc comment in
          // agent-prompt/logic.ts): a pre-commit hook's stderr can echo a
          // multi-line configured secret (e.g. a PEM key) verbatim, and a
          // single redact-then-normalize pass alone misses it — normalizing
          // first would collapse the secret's own newlines and break the
          // exact-string match, while redacting first alone misses a
          // secret whose internal whitespace differs from the raw echo.
          error: redactNormalizedText(message, secretValues),
          failurePhase: 'commit',
          precommitFailureError,
        };
      }
      hadUnpushedCommits = true;
    }

    if (hadUnpushedCommits) {
      await pushBranch(repo.repoPath);
      pushed = true;
    }

    return {
      repoId: repo.repoId,
      repoName: repo.repoName,
      repoPath: repo.repoPath,
      relativePath: repo.relativePath,
      branchName,
      status: hadUncommittedChanges ? 'committed_and_pushed' : 'pushed',
      hadUncommittedChanges,
      hadUnpushedCommits,
      model: config.model,
      commitMessage,
      commitHash,
      pushed,
      error: '',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      repoId: repo.repoId,
      repoName: repo.repoName,
      repoPath: repo.repoPath,
      relativePath: repo.relativePath,
      branchName,
      status: 'failed',
      hadUncommittedChanges,
      hadUnpushedCommits,
      model: config.model,
      commitMessage,
      commitHash,
      pushed,
      // `redactNormalizedText` — see the comment on the other `error:`
      // assignment above for why.
      error: redactNormalizedText(message, secretValues),
      failurePhase: 'other',
    };
  }
}

export async function runGitCommitPushAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    hydrateModelRegistryFromEnv();
    const config = resolveCommitConfig(env);
    const repos = await discoverWorkspaceRepos();
    const results: CommitPushRepoResult[] = [];
    // `generateCommitMessageWithUsage` invokes the configured model with
    // this subprocess's own env, which inherits `secretEnv` alongside
    // every other var — the model CAN read a pipeline secret, and if it
    // echoes one into the generated commit message, these outputs write
    // straight to disk, bypassing the parent process's stdout-level
    // `SecretValueRedactor` entirely. Threaded into `processRepo` so the
    // commit message is redacted BEFORE it becomes the actual commit that
    // gets pushed, not just before it's reported (see the comment there).
    const secretValues = parseAgentSecretValuesEnv(
      getBrandEnv(env, 'AGENT_SECRET_VALUES'),
    );

    for (const repo of repos) {
      results.push(await processRepo(repo, config, secretValues));
    }

    const committedCount = results.filter(
      (result) => result.status === 'committed_and_pushed',
    ).length;
    const pushedCount = results.filter(
      (result) => result.status === 'pushed',
    ).length;
    const noopCount = results.filter(
      (result) => result.status === 'no_changes',
    ).length;
    const failedCount = results.filter(
      (result) => result.status === 'failed',
    ).length;

    const redactedResults = results.map((result) => ({
      ...result,
      commitMessage: redactNormalizedPreservingFormat(
        result.commitMessage,
        secretValues,
      ),
      error: redactValues(result.error, secretValues),
      // `redactNormalizedPreservingFormat`, not `redactNormalizedText`:
      // it matches the same whitespace-reformatted values but splices at the
      // ORIGINAL offsets, so it gets the stronger matching without the
      // flattening. Unlike `error` (already whitespace-collapsed before this
      // pass), `precommitFailureError` preserves the pre-commit hook's raw,
      // newline-structured stderr verbatim on purpose — it is exported as
      // `CANOPY_WORKTREE_PRECOMMIT_FAILURE_ERROR` for user-authored hook
      // scripts and agent prompts (`execution-runtime-hooks.ts`), which can
      // depend on that structure (e.g. a multi-line lint report). Whole-text
      // normalization would silently collapse that structure on every run,
      // secrets or not; this keeps it and still masks reflowed values.
      precommitFailureError:
        result.precommitFailureError === undefined
          ? undefined
          : redactNormalizedPreservingFormat(
              result.precommitFailureError,
              secretValues,
            ),
    }));

    setOutput('results_json', JSON.stringify(redactedResults));
    writeOutputFile(
      'results_file',
      'git-commit-push-results.json',
      `${JSON.stringify(redactedResults, null, 2)}\n`,
    );
    writeOutputFile(
      'summary_file',
      'git-commit-push-summary.md',
      renderSummary(redactedResults),
    );
    setOutput('repo_count', String(results.length));
    setOutput('committed_count', String(committedCount));
    setOutput('pushed_count', String(pushedCount));
    setOutput('noop_count', String(noopCount));
    setOutput('failed_count', String(failedCount));
    setOutput('has_failures', failedCount > 0 ? 'true' : 'false');
  });
}

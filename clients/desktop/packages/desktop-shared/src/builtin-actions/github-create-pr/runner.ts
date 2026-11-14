import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  getCommitLog,
  getCurrentBranch,
  getFullDiff,
  getRemoteDefaultBranch,
  hasRemoteTrackingBranch,
  hasUncommittedChanges,
  hasUnpushedCommits,
  pushBranch,
} from '@canopy/desktop-shared/lib/git';
import { generatePrContentWithUsage } from '@canopy/desktop-shared/lib/github-pr-generator';
import { localMemoryEnabledFromEnv } from '@canopy/execution-engine/node/lib/native-memory';
import {
  type PrInstructionMode,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { parseRepoMap } from '@canopy/execution-engine/pipelines/base-branch-env';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import {
  describeJsonParseFailure,
  redactValues,
} from '@canopy/execution-engine/lib/redaction';
import { setOutput, writeOutputFile } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';
import { parseThinkingLevelInput } from '@canopy/execution-engine/builtin-actions/_lib/thinking';
import {
  redactNormalizedPreservingFormat,
  parseAgentSecretValuesEnv,
  redactNormalizedText,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import {
  hydrateModelRegistryFromEnv,
  resolveConfiguredModel,
} from '@canopy/execution-engine/builtin-actions/_lib/model-registry';
import {
  discoverWorkspaceRepos,
  type DiscoveredRepo,
} from '../_lib/repo-discovery';

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 1024 * 1024 * 16;
const DEFAULT_PR_MODEL = 'sonnet';

interface CreatePrConfig {
  model: string;
  thinkingLevel: ThinkingLevel | undefined;
  instructions: string;
  instructionMode: PrInstructionMode;
}

interface PullRequestRecord {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  isDraft: boolean;
}

interface CreatePrRepoResult {
  repoId: string;
  repoName: string;
  repoPath: string;
  relativePath: string;
  branchName: string;
  baseBranch: string;
  status: 'created' | 'existing' | 'no_changes' | 'failed';
  model: string;
  prNumber: number | null;
  prUrl: string;
  title: string;
  bodyFile: string;
  error: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const GH_OUTPUT_PREVIEW_CHARS = 200;

/**
 * Malformed `gh` output, carried WITHOUT its raw payload in `message`.
 *
 * The diagnostic this used to build truncated the raw output to its first
 * 200 characters inline, long before `processRepo`'s catch redacts the
 * message against the configured secret values. A secret straddling that
 * cut survived as a shorter fragment that the exact-value match could no
 * longer recognise, so a real key's prefix reached `results_json` —
 * reproduced by the controller with `sk-live-ab` left in a durable output.
 *
 * Keeping the raw payload in a dedicated field instead of the message means
 * no code path can stringify this error into a leak, and lets
 * `describeGhError` do the only safe ordering: redact the FULL output first,
 * truncate the already-masked result second.
 *
 * `parseMessage` is deliberately NOT V8's `JSON.parse` message: that embeds its
 * own shortened excerpt of the input, which reproduced the same fragment leak
 * one level down. See `describeJsonParseFailure`.
 */
class GhJsonParseError extends Error {
  constructor(
    readonly rawOutput: string,
    readonly parseMessage: string,
  ) {
    super(`Failed to parse gh JSON output: ${parseMessage}`);
    this.name = 'GhJsonParseError';
  }
}

/**
 * Renders a caught error for a durable result field, masking configured
 * secret values BEFORE any length-limiting so a truncation boundary can
 * never split a value out of the matcher's reach.
 *
 * The masking must be whitespace-insensitive here, not just verbatim.
 * Ordering redact-before-truncate is necessary but not sufficient: `gh` can
 * echo a configured value with its internal whitespace reformatted, which a
 * verbatim pass does not match, and the truncation then leaves a cleartext
 * prefix that the outer normalized pass at the result-construction site can
 * no longer match either: 29 characters of a real key survive into
 * `results_json` that way. `redactNormalizedText`
 * also collapses whitespace, which this preview wanted regardless.
 */
function describeGhError(
  error: unknown,
  secretValues: readonly string[],
): string {
  if (error instanceof GhJsonParseError) {
    const preview = redactNormalizedText(error.rawOutput, secretValues).slice(
      0,
      GH_OUTPUT_PREVIEW_CHARS,
    );
    const reason = redactNormalizedText(error.parseMessage, secretValues);
    return `Failed to parse gh JSON output: ${reason}. Raw output (first ${GH_OUTPUT_PREVIEW_CHARS} chars): ${preview}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function parseGhJson(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch (err) {
    // NOT `err.message`: V8 embeds a shortened excerpt of the input there,
    // which is a fragment no configured-value match can recognise and so
    // survived `describeGhError`'s masking into `results_json`.
    throw new GhJsonParseError(raw, describeJsonParseFailure(err));
  }
}

function isPullRequestRecord(value: unknown): value is PullRequestRecord {
  if (!isPlainObject(value)) {
    return false;
  }

  const entries = Object.entries(value);
  const numberEntry = entries.find(([key]) => key === 'number');
  const titleEntry = entries.find(([key]) => key === 'title');
  const urlEntry = entries.find(([key]) => key === 'url');
  const baseEntry = entries.find(([key]) => key === 'baseRefName');
  const headEntry = entries.find(([key]) => key === 'headRefName');
  const draftEntry = entries.find(([key]) => key === 'isDraft');

  return (
    typeof numberEntry?.[1] === 'number' &&
    typeof titleEntry?.[1] === 'string' &&
    typeof urlEntry?.[1] === 'string' &&
    typeof baseEntry?.[1] === 'string' &&
    typeof headEntry?.[1] === 'string' &&
    typeof draftEntry?.[1] === 'boolean'
  );
}

function isPullRequestRecordArray(
  value: unknown,
): value is PullRequestRecord[] {
  return Array.isArray(value) && value.every(isPullRequestRecord);
}

function parseInstructionMode(
  raw: string | undefined,
  fallback: PrInstructionMode,
): PrInstructionMode {
  const trimmed = raw?.trim();
  if (trimmed === 'append' || trimmed === 'replace') {
    return trimmed;
  }
  return fallback;
}

function resolveCreatePrConfig(env: NodeJS.ProcessEnv): CreatePrConfig {
  return {
    model: resolveConfiguredModel(
      env.INPUT_PR_MODEL ?? getBrandEnv(env, 'PREF_PR_GENERATION_MODEL'),
      DEFAULT_PR_MODEL,
    ),
    thinkingLevel: parseThinkingLevelInput(
      env.INPUT_PR_THINKING_LEVEL ??
        getBrandEnv(env, 'PREF_PR_GENERATION_THINKING_LEVEL'),
      { field: 'pr_thinking_level', fallback: 'high' },
    ),
    instructions:
      env.INPUT_PR_INSTRUCTIONS ??
      getBrandEnv(env, 'PREF_PR_INSTRUCTIONS') ??
      '',
    instructionMode: parseInstructionMode(
      env.INPUT_PR_INSTRUCTION_MODE ??
        getBrandEnv(env, 'PREF_PR_INSTRUCTION_MODE'),
      'append',
    ),
  };
}

function parseBooleanEnv(raw: string | undefined): boolean | null {
  if (raw === 'true') {
    return true;
  }

  if (raw === 'false') {
    return false;
  }

  return null;
}

function resolvePreferredBaseForRepo(
  env: NodeJS.ProcessEnv,
  repoId: string,
): { baseBranch: string | null; existsInRemote: boolean | null } {
  const baseBranchByRepo = parseRepoMap(
    getBrandEnv(env, 'BASE_BRANCH_BY_REPO'),
  );
  const existsInRemoteByRepo = parseRepoMap(
    getBrandEnv(env, 'BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO'),
  );
  const repoBaseBranch = baseBranchByRepo[repoId]?.trim();
  if (repoBaseBranch) {
    return {
      baseBranch: repoBaseBranch,
      existsInRemote: parseBooleanEnv(existsInRemoteByRepo[repoId]),
    };
  }

  const singularBaseBranch = getBrandEnv(env, 'BASE_BRANCH')?.trim();
  return {
    baseBranch: singularBaseBranch ? singularBaseBranch : null,
    existsInRemote: parseBooleanEnv(
      getBrandEnv(env, 'BASE_BRANCH_EXISTS_IN_REMOTE'),
    ),
  };
}

/**
 * Fetches the branch into its remote-tracking ref, which the diff and log
 * reads below use, and says whether the remote has it. A host that leaves a
 * preferred base's existence unset (a cloud run's recorded base, CAN-6739)
 * has it checked here, with the run's own credentials; any failure counts as
 * absent, so the pull request falls back to the default branch.
 */
async function fetchRemoteBranch(
  repoPath: string,
  branch: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      [
        'fetch',
        '--no-tags',
        'origin',
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      {
        cwd: repoPath,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: process.platform === 'win32',
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function runGh(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync('gh', args, {
    cwd,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: process.platform === 'win32',
  });
  return result.stdout.trim();
}

async function findExistingPullRequest(
  repoPath: string,
  branchName: string,
): Promise<PullRequestRecord | null> {
  return findPullRequest(repoPath, branchName, 'open');
}

async function findClosedPullRequest(
  repoPath: string,
  branchName: string,
): Promise<PullRequestRecord | null> {
  return findPullRequest(repoPath, branchName, 'closed');
}

async function findPullRequest(
  repoPath: string,
  branchName: string,
  state: 'open' | 'closed' | 'merged',
): Promise<PullRequestRecord | null> {
  const raw = await runGh(
    [
      'pr',
      'list',
      '--head',
      branchName,
      '--state',
      state,
      '--json',
      'number,title,url,baseRefName,headRefName,isDraft',
    ],
    repoPath,
  );
  const parsed = parseGhJson(raw);
  if (!isPullRequestRecordArray(parsed)) {
    throw new Error('github-create-pr received invalid JSON from gh pr list');
  }

  return parsed[0] ?? null;
}

async function getRepoNameWithOwner(repoPath: string): Promise<string> {
  const raw = await runGh(
    ['repo', 'view', '--json', 'nameWithOwner'],
    repoPath,
  );
  const parsed = parseGhJson(raw);
  if (!isPlainObject(parsed)) {
    throw new Error('github-create-pr received invalid JSON from gh repo view');
  }

  const nameWithOwnerEntry = Object.entries(parsed).find(
    ([key]) => key === 'nameWithOwner',
  );
  if (
    typeof nameWithOwnerEntry?.[1] !== 'string' ||
    nameWithOwnerEntry[1].trim().length === 0
  ) {
    throw new Error('github-create-pr could not resolve repository owner/name');
  }

  return nameWithOwnerEntry[1].trim();
}

function parseApiCreatedPullRequest(raw: string): PullRequestRecord {
  const parsed = parseGhJson(raw);
  if (!isPlainObject(parsed)) {
    throw new Error(
      'github-create-pr received invalid JSON from gh api create pull request',
    );
  }

  const numberEntry = Object.entries(parsed).find(([key]) => key === 'number');
  const titleEntry = Object.entries(parsed).find(([key]) => key === 'title');
  const urlEntry = Object.entries(parsed).find(([key]) => key === 'html_url');
  const headEntry = Object.entries(parsed).find(([key]) => key === 'head');
  const baseEntry = Object.entries(parsed).find(([key]) => key === 'base');
  const draftEntry = Object.entries(parsed).find(([key]) => key === 'draft');

  if (
    typeof numberEntry?.[1] !== 'number' ||
    typeof titleEntry?.[1] !== 'string' ||
    typeof urlEntry?.[1] !== 'string' ||
    !isPlainObject(headEntry?.[1]) ||
    !isPlainObject(baseEntry?.[1]) ||
    typeof draftEntry?.[1] !== 'boolean'
  ) {
    throw new Error(
      'github-create-pr received incomplete JSON from gh api create pull request',
    );
  }

  const headRefEntry = Object.entries(headEntry[1]).find(
    ([key]) => key === 'ref',
  );
  const baseRefEntry = Object.entries(baseEntry[1]).find(
    ([key]) => key === 'ref',
  );
  if (
    typeof headRefEntry?.[1] !== 'string' ||
    typeof baseRefEntry?.[1] !== 'string'
  ) {
    throw new Error(
      'github-create-pr received invalid branch refs from gh api create pull request',
    );
  }

  return {
    number: numberEntry[1],
    title: titleEntry[1],
    url: urlEntry[1],
    baseRefName: baseRefEntry[1],
    headRefName: headRefEntry[1],
    isDraft: draftEntry[1],
  };
}

async function createPullRequestViaApi(
  repoPath: string,
  branchName: string,
  baseBranch: string,
  title: string,
  body: string,
  requestFile: string,
): Promise<PullRequestRecord> {
  const nameWithOwner = await getRepoNameWithOwner(repoPath);
  await writeFile(
    requestFile,
    `${JSON.stringify({ title, head: branchName, base: baseBranch, body })}\n`,
    'utf8',
  );
  const raw = await runGh(
    [
      'api',
      `repos/${nameWithOwner}/pulls`,
      '--method',
      'POST',
      '--input',
      requestFile,
    ],
    repoPath,
  );
  return parseApiCreatedPullRequest(raw);
}

async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const raw = await runGh(
      ['repo', 'view', '--json', 'defaultBranchRef'],
      repoPath,
    );
    const parsed = parseGhJson(raw);
    if (isPlainObject(parsed)) {
      const defaultBranchEntry = Object.entries(parsed).find(
        ([key]) => key === 'defaultBranchRef',
      );
      const value = defaultBranchEntry?.[1];
      if (isPlainObject(value)) {
        const nameEntry = Object.entries(value).find(([key]) => key === 'name');
        if (typeof nameEntry?.[1] === 'string' && nameEntry[1].trim()) {
          return nameEntry[1].trim();
        }
      }
    }
  } catch {
    // Fall back to git remote detection below.
  }

  return (await getRemoteDefaultBranch(repoPath)) ?? 'main';
}

function parseCreatedPrUrl(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

async function createPullRequest(
  repoPath: string,
  branchName: string,
  baseBranch: string,
  title: string,
  body: string,
): Promise<{
  record: PullRequestRecord | null;
  bodyFile: string;
  createdUrl: string;
  wasExisting: boolean;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), 'canopy-pr-body-'));
  const bodyFile = join(tempDir, 'pull-request-body.md');
  const requestFile = join(tempDir, 'pull-request-create.json');

  await writeFile(bodyFile, body, 'utf8');

  try {
    try {
      const raw = await runGh(
        [
          'pr',
          'create',
          '--base',
          baseBranch,
          '--head',
          branchName,
          '--title',
          title,
          '--body-file',
          bodyFile,
        ],
        repoPath,
      );
      const createdUrl = parseCreatedPrUrl(raw);
      const record = await findExistingPullRequest(repoPath, branchName);
      return { record, bodyFile: '', createdUrl, wasExisting: false };
    } catch (error) {
      const openPr = await findExistingPullRequest(repoPath, branchName).catch(
        () => null,
      );
      if (openPr) {
        return {
          record: openPr,
          bodyFile: '',
          createdUrl: openPr.url,
          wasExisting: true,
        };
      }

      const closedPr = await findClosedPullRequest(repoPath, branchName).catch(
        () => null,
      );
      const mergedPr =
        closedPr ??
        (await findPullRequest(repoPath, branchName, 'merged').catch(
          () => null,
        ));
      if (!mergedPr) {
        throw error;
      }

      const createdRecord = await createPullRequestViaApi(
        repoPath,
        branchName,
        baseBranch,
        title,
        body,
        requestFile,
      );
      return {
        record: createdRecord,
        bodyFile: '',
        createdUrl: createdRecord.url,
        wasExisting: false,
      };
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function renderSummary(results: CreatePrRepoResult[]): string {
  const createdCount = results.filter(
    (result) => result.status === 'created',
  ).length;
  const existingCount = results.filter(
    (result) => result.status === 'existing',
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
      `base=${result.baseBranch || '(unknown)'}`,
    ];

    if (result.prNumber !== null) {
      details.push(`pr=#${String(result.prNumber)}`);
    }

    if (result.prUrl) {
      details.push(`url=${result.prUrl}`);
    }

    if (result.error) {
      details.push(`error=${result.error}`);
    }

    return `- ${result.status}: ${result.repoName} (${details.join(', ')})`;
  });

  return [
    '# GitHub Create PR',
    '',
    `- Repo count: ${String(results.length)}`,
    `- Created: ${String(createdCount)}`,
    `- Existing: ${String(existingCount)}`,
    `- No changes: ${String(noopCount)}`,
    `- Failed: ${String(failedCount)}`,
    '',
    '## Repo Results',
    ...repoLines,
    '',
  ].join('\n');
}

async function ensureBranchIsPushed(repoPath: string): Promise<void> {
  const hasTracking = await hasRemoteTrackingBranch(repoPath);
  const needsPush = hasTracking ? await hasUnpushedCommits(repoPath) : true; // No upstream: always push to ensure origin is current

  if (needsPush) {
    await pushBranch(repoPath);
  }
}

async function processRepo(
  repo: DiscoveredRepo,
  config: CreatePrConfig,
  secretValues: readonly string[],
): Promise<CreatePrRepoResult> {
  let branchName = '';
  let baseBranch = '';
  let bodyFile = '';

  try {
    branchName = await getCurrentBranch(repo.repoPath);
    const preferredBase = resolvePreferredBaseForRepo(process.env, repo.repoId);
    const defaultBase = await getDefaultBranch(repo.repoPath);
    const preferredOnRemote =
      preferredBase.existsInRemote ??
      (preferredBase.baseBranch !== null &&
        (await fetchRemoteBranch(repo.repoPath, preferredBase.baseBranch)));
    baseBranch =
      preferredBase.baseBranch && preferredOnRemote
        ? preferredBase.baseBranch
        : defaultBase;

    if (branchName === baseBranch) {
      return {
        repoId: repo.repoId,
        repoName: repo.repoName,
        repoPath: repo.repoPath,
        relativePath: repo.relativePath,
        branchName,
        baseBranch,
        status: 'no_changes',
        model: config.model,
        prNumber: null,
        prUrl: '',
        title: '',
        bodyFile: '',
        error: '',
      };
    }

    if (await hasUncommittedChanges(repo.repoPath)) {
      throw new Error(
        'Repository has uncommitted changes. Run builtin/git-commit-push before creating a PR.',
      );
    }

    const existingPr = await findExistingPullRequest(repo.repoPath, branchName);
    if (existingPr) {
      await ensureBranchIsPushed(repo.repoPath);
      return {
        repoId: repo.repoId,
        repoName: repo.repoName,
        repoPath: repo.repoPath,
        relativePath: repo.relativePath,
        branchName,
        baseBranch: existingPr.baseRefName,
        status: 'existing',
        model: config.model,
        prNumber: existingPr.number,
        prUrl: existingPr.url,
        title: existingPr.title,
        bodyFile: '',
        error: '',
      };
    }

    const [diff, commitLog] = await Promise.all([
      getFullDiff(repo.repoPath, baseBranch),
      getCommitLog(repo.repoPath, baseBranch),
    ]);

    if (!diff.trim() && !commitLog.trim()) {
      return {
        repoId: repo.repoId,
        repoName: repo.repoName,
        repoPath: repo.repoPath,
        relativePath: repo.relativePath,
        branchName,
        baseBranch,
        status: 'no_changes',
        model: config.model,
        prNumber: null,
        prUrl: '',
        title: '',
        bodyFile: '',
        error: '',
      };
    }

    await ensureBranchIsPushed(repo.repoPath);

    const generated = await generatePrContentWithUsage({
      repoPath: repo.repoPath,
      branchName,
      baseBranch,
      diff,
      commitLog,
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      // Builtin actions are plain Node subprocesses: the desktop step runner
      // projects the opt-in local memory preference into the branded
      // `PREF_LOCAL_MEMORY_ENABLED` env var; absent (CLI-native runs) means
      // OFF, keeping provider-native memory defaults (CAN-1969).
      localMemoryEnabled: localMemoryEnabledFromEnv(),
      instructions: config.instructions,
      instructionMode: config.instructionMode,
    });
    if (generated.source !== 'model') {
      throw new Error(
        'PR content generation returned fallback content instead of model output.',
      );
    }

    // Redacted BEFORE they become the actual PR title/body posted to
    // GitHub, not just before they're reported: the model generating this
    // content inherits `secretEnv` in its own process and can read a
    // pipeline secret, and a secret posted to a real (possibly shared or
    // public) PR is effectively permanent — reporting a redacted copy
    // while posting the raw content would leave that exfiltration wide
    // open one step earlier than this fix's own local-output redaction.
    // `title` uses `redactNormalizedText` (a PR title is single-line by
    // convention, so normalizing is safe and closes the
    // whitespace-reformatted-secret gap); `body` uses
    // `redactNormalizedPreservingFormat`, which gets the SAME matching
    // strength without flattening the multi-line markdown (paragraphs, lists,
    // code fences) a PR body legitimately contains. This comment used to say
    // the body stayed on plain `redactValues` as a deliberate tradeoff; that
    // tradeoff no longer exists and the sentence outlived it.
    const redactedTitle = redactNormalizedText(
      generated.content.title,
      secretValues,
    );
    // The body is posted to a possibly-public PR, so this is the site where a
    // reflowed value costs the most. Formatting-preserving normalized matching
    // gives the same strength as the inline title without flattening the body.
    const redactedBody = redactNormalizedPreservingFormat(
      generated.content.body,
      secretValues,
    );

    const created = await createPullRequest(
      repo.repoPath,
      branchName,
      baseBranch,
      redactedTitle,
      redactedBody,
    );
    bodyFile = created.bodyFile;

    return {
      repoId: repo.repoId,
      repoName: repo.repoName,
      repoPath: repo.repoPath,
      relativePath: repo.relativePath,
      branchName,
      baseBranch,
      status: created.wasExisting ? 'existing' : 'created',
      model: config.model,
      prNumber: created.record?.number ?? null,
      prUrl: created.record?.url ?? created.createdUrl,
      title: created.record?.title ?? redactedTitle,
      bodyFile,
      error: '',
    };
  } catch (error) {
    const message = describeGhError(error, secretValues);
    return {
      repoId: repo.repoId,
      repoName: repo.repoName,
      repoPath: repo.repoPath,
      relativePath: repo.relativePath,
      branchName,
      baseBranch,
      status: 'failed',
      model: config.model,
      prNumber: null,
      prUrl: '',
      title: '',
      bodyFile,
      // `redactNormalizedText` (see its doc comment in
      // agent-prompt/logic.ts): the underlying `gh`/git error can echo a
      // multi-line configured secret (e.g. a PEM key) verbatim, and a
      // single redact-then-normalize pass alone misses it — normalizing
      // first would collapse the secret's own newlines and break the
      // exact-string match, while redacting first alone misses a secret
      // whose internal whitespace differs from the raw echo.
      error: redactNormalizedText(message, secretValues),
    };
  }
}

export async function runGitHubCreatePrAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    hydrateModelRegistryFromEnv();
    const config = resolveCreatePrConfig(env);
    const repos = await discoverWorkspaceRepos();
    const results: CreatePrRepoResult[] = [];
    // generatePrContentWithUsage invokes the configured model with this
    // subprocess's own env, which inherits `secretEnv` alongside every
    // other var — the model CAN read a pipeline secret, and if it echoes
    // one into the generated PR title/body, these outputs write straight
    // to disk, bypassing the parent process's stdout-level
    // `SecretValueRedactor` entirely. Threaded into `processRepo` so the
    // title/body are redacted BEFORE they become the actual PR posted to
    // GitHub, not just before they're reported (see the comment there).
    const secretValues = parseAgentSecretValuesEnv(
      getBrandEnv(env, 'AGENT_SECRET_VALUES'),
    );

    for (const repo of repos) {
      results.push(await processRepo(repo, config, secretValues));
    }

    const createdCount = results.filter(
      (result) => result.status === 'created',
    ).length;
    const existingCount = results.filter(
      (result) => result.status === 'existing',
    ).length;
    const noopCount = results.filter(
      (result) => result.status === 'no_changes',
    ).length;
    const failedCount = results.filter(
      (result) => result.status === 'failed',
    ).length;

    const redactedResults = results.map((result) => ({
      ...result,
      title: redactValues(result.title, secretValues),
      error: redactValues(result.error, secretValues),
    }));

    setOutput('results_json', JSON.stringify(redactedResults));
    writeOutputFile(
      'results_file',
      'github-create-pr-results.json',
      `${JSON.stringify(redactedResults, null, 2)}\n`,
    );
    writeOutputFile(
      'summary_file',
      'github-create-pr-summary.md',
      renderSummary(redactedResults),
    );
    setOutput('repo_count', String(results.length));
    setOutput('created_count', String(createdCount));
    setOutput('existing_count', String(existingCount));
    setOutput('noop_count', String(noopCount));
    setOutput('failed_count', String(failedCount));
    setOutput('has_failures', failedCount > 0 ? 'true' : 'false');
  });
}

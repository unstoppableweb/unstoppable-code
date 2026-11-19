import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  WRITE_SECRETS_FILE_WARNING,
  type WriteSecretsFileInput,
  type WriteSecretsFileResult,
} from '@canopy/agent-actions';
import { getResolvedGitExecutableForSpawn } from '../lib/git-executable';
import {
  getChatSecretStore,
  SecretFileFullError,
  type ChatSecretScope,
} from './chat-secret-store';
import { registerRunningSecretCommand } from './running-commands';
import { isAgentSecretRequestsEnabled } from './feature-gate';
import { writePrivateFileAtomically } from './private-file';
import { SecretToolUnavailableError } from './run-with-secrets';
import { SecretsFileFormatError, secretsFileText } from './secrets-file-format';
import {
  AgentSecretToolError,
  approveSecretUse,
  missingSecretNames,
  redeemChatSecrets,
  resolveInside,
  resolveToolRoot,
  type AgentSecretToolCallOptions,
  type AgentSecretToolHost,
} from './secret-tool-host';

/*
 * WriteSecretsFile on desktop (CONTRACTS.md §2–§5). Writes the named secrets
 * into a file inside the chat's worktree, atomically and owner-only (0600).
 * A git-tracked path is refused, and a path git would not ignore is added to
 * the repository's info/exclude, so the file can't be committed by accident.
 * The path is then registered as secret-bearing: Canopy's own reads of it
 * are redacted and Claude's Read tool is sent to RunWithSecrets instead.
 */

/** Paths a person already approved per chat: Ask prompts once per path. */
const approvedPaths = new Set<string>();

function approvalKey(
  scope: ChatSecretScope,
  path: string,
  names: readonly string[],
): string {
  return [scope.projectId, scope.worktreeId, scope.chatId, path, ...names].join(
    '\0',
  );
}

/** Test seam: forgets every per-path approval. */
export function resetWriteSecretsFileApprovalsForTests(): void {
  approvedPaths.clear();
}

/** Runs git in `cwd`; resolves its exit code and trimmed output. */
async function git(
  cwd: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const executable = await getResolvedGitExecutableForSpawn();
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        // Untranslated messages, so "not a git repository" can be told apart.
        env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' },
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        resolve({
          code,
          // Only git's own line end: a path can end with spaces.
          stdout: String(stdout).replace(/\r?\n$/, ''),
          stderr: String(stderr),
        });
      },
    );
  });
}

interface GitPlacement {
  /** The repository's top folder. */
  top: string;
  /** The file's path inside it, `/`-separated. */
  repoPath: string;
  /** Whether git already ignores the path. */
  ignored: boolean;
}

/**
 * Where the file sits in git: null outside a repository. Refuses a tracked
 * path, which a commit would publish.
 */
async function gitPlacement(target: string): Promise<GitPlacement | null> {
  const top = await git(dirname(target), ['rev-parse', '--show-toplevel']);
  // Only git saying so proves the file is outside a repository; any other
  // failure (git missing, a damaged config) refuses the write.
  if (top.code === 128 && /not a git repository/i.test(top.stderr)) return null;
  if (top.code !== 0 || !top.stdout)
    throw new AgentSecretToolError(
      "git couldn't say whether this path is in a repository, so secrets were not written to it.",
    );
  // git may name the top through a link the target was resolved past.
  const topReal = await realpath(top.stdout).catch(() => top.stdout);
  const repoPath = relative(topReal, target).split(sep).join('/');
  // The target is inside the folder git ran in, so its repository holds it;
  // anything else means the path couldn't be placed, and nothing is written.
  if (!repoPath || repoPath.startsWith('../') || isAbsolute(repoPath))
    throw new AgentSecretToolError(
      "git couldn't place this path in its repository, so secrets were not written to it.",
    );
  // Case-insensitively: on macOS and Windows `agents.md` is the tracked
  // `AGENTS.md`, and the write would replace it.
  const tracked = await git(top.stdout, [
    'ls-files',
    '--error-unmatch',
    '--',
    `:(icase)${repoPath}`,
  ]);
  if (tracked.code === 0)
    throw new AgentSecretToolError(
      `${repoPath} is tracked by git, so secrets can't be written to it. Choose an untracked path, such as .env.local.`,
    );
  // Only "no such path" (exit 1) proves the file is untracked; any other
  // failure (a damaged index, say) refuses the write.
  if (tracked.code !== 1)
    throw new AgentSecretToolError(
      `git couldn't say whether ${repoPath} is tracked, so secrets were not written to it.`,
    );
  const ignored = await git(top.stdout, [
    'check-ignore',
    '-q',
    '--no-index',
    '--',
    repoPath,
  ]);
  return { top: top.stdout, repoPath, ignored: ignored.code === 0 };
}

/**
 * Adds the staging file's pattern, and with `file` the path itself, to the
 * repository's info/exclude.
 */
async function excludeFromGit(
  placement: GitPlacement,
  options: { file: boolean },
): Promise<void> {
  const exclude = await git(placement.top, [
    'rev-parse',
    '--git-path',
    'info/exclude',
  ]);
  if (exclude.code !== 0 || !exclude.stdout)
    throw new AgentSecretToolError(
      "This repository's exclude file couldn't be found, so the secrets file was not written.",
    );
  const excludePath = isAbsolute(exclude.stdout)
    ? exclude.stdout
    : join(placement.top, exclude.stdout);
  await mkdir(dirname(excludePath), { recursive: true });
  const current = await readFile(excludePath, 'utf8').catch(() => '');
  const escaped = (text: string): string =>
    text.replace(/([*?[\]\\!#])/g, '\\$1');
  const folder = dirname(placement.repoPath);
  // The file, and the staging file it is written through first, which holds
  // the same values until the rename (`.<name>.<uuid>.tmp`).
  const patterns = [
    ...(options.file ? [`/${escaped(placement.repoPath)}`] : []),
    `/${folder === '.' ? '' : `${escaped(folder)}/`}.${escaped(basename(placement.repoPath))}.*.tmp`,
  ];
  const lines = current.split(/\r?\n/);
  const missing = patterns.filter((pattern) => !lines.includes(pattern));
  if (missing.length)
    await appendFile(
      excludePath,
      `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`,
      'utf8',
    );
}

/**
 * Writes run one at a time per folder, so a merge never loses another: on a
 * case-insensitive filesystem `config.json` and `CONFIG.JSON` name one file,
 * and a folder (resolved, so its own aliases share it) covers every alias of
 * the files in it.
 */
const writesByPath = new Map<string, Promise<unknown>>();

/** The queue a write to `target` (in a resolved folder) waits in. */
export function secretsFileWriteQueue(target: string): string {
  return dirname(target);
}

function serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = writesByPath.get(path) ?? Promise.resolve();
  const result = previous.then(work, work);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  writesByPath.set(path, tail);
  void tail.then(() => {
    if (writesByPath.get(path) === tail) writesByPath.delete(path);
  });
  return result;
}

export async function writeSecretsFile(
  host: AgentSecretToolHost,
  input: WriteSecretsFileInput,
  options: AgentSecretToolCallOptions = {},
): Promise<WriteSecretsFileResult> {
  // The chat's Stop ends the call, whatever signal its provider passes.
  const stopped = new AbortController();
  const unregister = registerRunningSecretCommand(host.scope, () =>
    stopped.abort(),
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, stopped.signal])
    : stopped.signal;
  try {
    return await writeSecretsFileOnce(host, input, { ...options, signal });
  } finally {
    unregister();
  }
}

async function writeSecretsFileOnce(
  host: AgentSecretToolHost,
  input: WriteSecretsFileInput,
  options: AgentSecretToolCallOptions & { signal: AbortSignal },
): Promise<WriteSecretsFileResult> {
  if (!isAgentSecretRequestsEnabled()) throw new SecretToolUnavailableError();
  // Without secure storage, values live only in this app session: a file
  // would outlive that promise, and its values couldn't be kept to hide it.
  if (getChatSecretStore().storageMode() !== 'encrypted')
    throw new AgentSecretToolError(
      "Secure storage isn't available on this computer, so secrets stay in memory for this session and aren't written to files. Use RunWithSecrets instead.",
    );
  const keys = Object.keys(input.entries);
  const names = [...new Set(Object.values(input.entries))].sort();
  const missing = await missingSecretNames(host.scope, names);
  const sessionOnly = await getChatSecretStore().sessionOnlyNames(
    host.scope,
    names,
  );
  if (sessionOnly.length)
    throw new AgentSecretToolError(
      `These secrets are kept in memory for this session only, so they aren't written to files: ${sessionOnly.join(', ')}. Use RunWithSecrets instead.`,
    );
  if (missing.length)
    throw new AgentSecretToolError(
      `This chat doesn't hold ${missing.join(', ')}, so nothing was written. Ask for ${missing.length === 1 ? 'it' : 'them'} with RequestSecrets first.`,
    );
  const root = await resolveToolRoot(host.root);
  const parent = dirname(input.path);
  if (parent !== '.') {
    // Refuse a path whose folder would leave the worktree before creating it.
    const nearest = await nearestExistingFolder(root, parent);
    await resolveInside(root, nearest);
    await mkdir(join(root, parent), { recursive: true });
  }
  const folder = await resolveInside(root, parent);
  const target = join(folder, basename(input.path));
  return serialized(secretsFileWriteQueue(target), () =>
    writeResolvedSecretsFile(host, input, options, { names, keys, target }),
  );
}

async function writeResolvedSecretsFile(
  host: AgentSecretToolHost,
  input: WriteSecretsFileInput,
  options: AgentSecretToolCallOptions & { signal: AbortSignal },
  resolved: { names: string[]; keys: string[]; target: string },
): Promise<WriteSecretsFileResult> {
  const { names, keys, target } = resolved;
  const existing = await lstat(target).catch(() => null);
  if (existing && !existing.isFile())
    throw new AgentSecretToolError(
      `${input.path} is not a regular file, so secrets can't be written to it.`,
    );
  // Checked now to refuse a tracked path before asking, and again once the
  // person has answered: the file may have been added to git meanwhile.
  let placement = await gitPlacement(target);
  // Asks once per chat, path and set of secrets, and remembers only an
  // answer the person gave: a Full-access allow never stands in for one.
  const key = approvalKey(host.scope, target, names);
  if (!approvedPaths.has(key)) {
    const asked = await approveSecretUse(
      host,
      {
        kind: 'agent-secret-use',
        tool: 'WriteSecretsFile',
        path: input.path,
        secretNames: names,
      },
      options,
    );
    if (asked) approvedPaths.add(key);
  }
  if (!isAgentSecretRequestsEnabled()) throw new SecretToolUnavailableError();
  await assertFolderUnchanged(target, host.root, input.path);
  placement = await gitPlacement(target);
  // The file may have appeared, or changed kind, while the person decided.
  const present = await lstat(target).catch(() => null);
  if (present && !present.isFile())
    throw new AgentSecretToolError(
      `${input.path} is not a regular file, so secrets can't be written to it.`,
    );
  const gitExcluded = placement !== null && !placement.ignored;
  if (placement) {
    // The file, unless git ignores it already, and always the staging file
    // it is written through first, which its ignore rule may not cover.
    await excludeFromGit(placement, { file: gitExcluded });
    // A name git's patterns cannot spell exactly (a line break, trailing
    // spaces) would stay committable: check both before writing anything.
    const folder = dirname(placement.repoPath);
    const staging = `${folder === '.' ? '' : `${folder}/`}.${basename(placement.repoPath)}.${randomUUID()}.tmp`;
    for (const path of [placement.repoPath, staging]) {
      const ignored = await git(placement.top, [
        'check-ignore',
        '-q',
        '--no-index',
        '--',
        path,
      ]);
      if (ignored.code !== 0)
        throw new AgentSecretToolError(
          `${input.path} could not be excluded from git, so secrets were not written to it. Choose a simpler file name.`,
        );
    }
  }
  const merge =
    (input.mode ?? (input.format === 'raw' ? 'replace' : 'merge')) === 'merge';
  let current: string | null = null;
  if (merge && present) {
    try {
      current = await readFile(target, 'utf8');
    } catch {
      // A merge never replaces a file it couldn't read.
      throw new AgentSecretToolError(
        `${input.path} couldn't be read to merge into, so nothing was written. Use mode replace to overwrite it.`,
      );
    }
  }
  const stopped = (): void => {
    if (options.signal.aborted)
      throw new AgentSecretToolError('The call was stopped before it wrote.');
  };
  stopped();
  const values = await redeemChatSecrets(host.scope, names, options.signal);
  const entries = keys.map((entryKey): [string, string] => {
    const value = values.get(input.entries[entryKey] ?? '');
    if (value === undefined)
      throw new AgentSecretToolError(
        "This chat's secrets couldn't be read. Ask for them again with RequestSecrets.",
      );
    return [entryKey, value];
  });
  // A submission can have replaced a secret with a session-only one since
  // the check above: only values still held encrypted go into a file.
  if (
    !(await getChatSecretStore().holdsEncrypted(
      host.scope,
      entries.map(([entryKey, value]) => ({
        name: input.entries[entryKey] ?? entryKey,
        value,
      })),
    ))
  )
    throw new AgentSecretToolError(
      'These secrets changed or are kept in memory for this session only, so nothing was written. Use RunWithSecrets instead, or ask for them again.',
    );
  let text: string;
  try {
    text = secretsFileText(input.format, entries, current);
  } catch (error) {
    if (error instanceof SecretsFileFormatError)
      throw new AgentSecretToolError(error.message);
    throw error;
  }
  stopped();
  // Recorded before the write, with the values it writes, so the file is
  // redacted from its first byte on and stays so after the chat's secrets
  // change or go. Marked as being written, so the expiry sweep keeps the
  // record while the file doesn't exist yet.
  const store = getChatSecretStore();
  store.beginSecretFileWrite(target);
  try {
    return await recordAndWrite(host, input, store, {
      target,
      text,
      entries,
      merge,
      names,
      keys,
      gitExcluded,
      stopped,
      signal: options.signal,
    });
  } finally {
    store.finishSecretFileWrite(target);
  }
}

async function recordAndWrite(
  host: AgentSecretToolHost,
  input: WriteSecretsFileInput,
  store: ReturnType<typeof getChatSecretStore>,
  plan: {
    target: string;
    text: string;
    entries: Array<[string, string]>;
    merge: boolean;
    names: string[];
    keys: string[];
    gitExcluded: boolean;
    stopped: () => void;
    signal: AbortSignal;
  },
): Promise<WriteSecretsFileResult> {
  const { target, text, entries, merge, names, keys, gitExcluded, stopped } =
    plan;
  const written = entries.map(([entryKey, value]) => ({
    name: input.entries[entryKey] ?? entryKey,
    value,
  }));
  try {
    await store.registerSecretFile(host.scope, target, written, {
      replace: !merge,
    });
  } catch (error) {
    if (error instanceof SecretFileFullError)
      throw new AgentSecretToolError(
        `${input.path} has been given too many different secret values to keep hiding them. Write it with mode replace, or choose another path.`,
      );
    throw error;
  }
  stopped();
  // A folder on the way may have been swapped for a link while the person
  // decided: check it again right before the write.
  await assertFolderUnchanged(target, host.root, input.path);
  let installed: boolean;
  try {
    installed = await writePrivateFileAtomically(target, text, plan.signal);
  } catch (error) {
    // A stop while the file was being made private writes nothing.
    if (plan.signal.aborted) stopped();
    throw error;
  }
  if (!installed)
    throw new AgentSecretToolError(
      `${input.path} couldn't be made readable by you alone here, so secrets were not written to it.`,
    );
  if (!merge)
    await store
      .keepOnlySecretFileValues(target, written)
      .catch(() => undefined);
  await store.audit({
    event: 'used',
    scope: host.scope,
    names,
    tool: 'WriteSecretsFile',
    path: input.path,
  });
  return {
    path: input.path,
    written: keys,
    gitExcluded,
    warning: WRITE_SECRETS_FILE_WARNING,
  };
}

/**
 * Refuses the write when the file's folder no longer resolves to where it
 * did, inside the chat's root: a folder on the way was replaced by a link.
 */
async function assertFolderUnchanged(
  target: string,
  root: string,
  displayPath: string,
): Promise<void> {
  const folder = dirname(target);
  const [now, rootNow] = await Promise.all([
    realpath(folder).catch(() => null),
    resolveToolRoot(root),
  ]);
  const rest = now === null ? null : relative(rootNow, now);
  if (
    now !== folder ||
    rest === null ||
    rest === '..' ||
    rest.startsWith(`..${sep}`) ||
    isAbsolute(rest)
  )
    throw new AgentSecretToolError(
      `The folder of ${displayPath} changed while you decided, so secrets were not written to it.`,
    );
}

/** The deepest existing folder on the way to `relativeFolder`. */
async function nearestExistingFolder(
  root: string,
  relativeFolder: string,
): Promise<string> {
  let folder = relativeFolder;
  while (folder !== '.' && folder !== '') {
    const info = await lstat(join(root, folder)).catch(() => null);
    if (info) return folder;
    folder = dirname(folder);
  }
  return '.';
}

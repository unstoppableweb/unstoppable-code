import { lstat, opendir, readlink, realpath } from 'node:fs/promises';
import { join, posix, relative, sep, win32 } from 'node:path';
import type { RepoRuleSkipped } from '@canopy/protocol/repo-rules';
import type {
  RepoRuleCheckout,
  RepoRulesRead,
} from '@canopy/core-runtime/node/workspace/repo-rules';
import { listTrackedFiles } from '../lib/git';
import { isProjectInstructionFileReadable } from '../lib/instruction-files';
import { eligibility, eligible } from './eligibility';
import { isDuplicate, parseRepoRule, type ReadRepoRule } from './parsing';
import {
  MAX_ENTRIES,
  MAX_RULES,
  safePath,
  readBounded,
  readBoundedBytes,
  validRelativePath,
} from './safety';

/** Worker-owned trusted checkout descriptor. Never crosses IPC. */
export type RepoCheckout = RepoRuleCheckout;
export type RulesRead = RepoRulesRead;
export function isRulePath(path: string): boolean {
  return (
    path === '.cursorrules' || /(?:^|\/)\.cursor\/rules\/.+\.mdc$/.test(path)
  );
}
function reason(error: unknown): RepoRuleSkipped['reason'] {
  if (
    error instanceof Error &&
    [
      'unsafe-path',
      'too-large',
      'changed',
      'limit',
      'unsupported-git',
    ].includes(error.message)
  ) {
    switch (error.message) {
      case 'unsafe-path':
        return 'unsafe-path';
      case 'too-large':
        return 'too-large';
      case 'changed':
        return 'changed';
      case 'limit':
        return 'limit';
      case 'unsupported-git':
        return 'unsupported-git';
    }
  }
  return 'unavailable';
}
function sorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}
async function instructionBodies(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md'] as const) {
    try {
      if (!(await isProjectInstructionFileReadable(root, name))) continue;
      let path = name;
      // The existing helper permits exactly one alias to the other root file.
      const entry = await lstat(
        await safePath(root, name).catch(() => `${root}/${name}`),
      );
      if (entry.isSymbolicLink()) {
        const target = await readlink(`${root}/${name}`);
        if (target !== 'AGENTS.md' && target !== 'CLAUDE.md') continue;
        path = target;
      }
      result.push(await readBounded(root, path));
    } catch {
      /* Optional duplicate evidence never makes rules unreadable. */
    }
  }
  return result;
}
async function referencesMissing(
  repo: RepoCheckout,
  rule: ReadRepoRule,
): Promise<boolean> {
  const refs = Array.from(rule.body.matchAll(/(?:^|\s)@([^\s`<>"']+)/g)).slice(
    0,
    32,
  );
  for (const match of refs) {
    const ref = match[1];
    if (
      !ref ||
      /[$~:\\]/.test(ref) ||
      posix.isAbsolute(ref) ||
      win32.isAbsolute(ref)
    )
      continue;
    let found = false;
    for (const path of sorted([
      posix.normalize(posix.join(posix.dirname(rule.path), ref)),
      ref,
    ])) {
      if (!validRelativePath(path)) continue;
      try {
        if ((await lstat(await safePath(repo.root, path))).isFile())
          found = true;
      } catch {
        /* Metadata only; never open the reference. */
      }
    }
    if (!found) return true;
  }
  return false;
}
async function collect(
  repos: RepoCheckout[],
  candidates: (repo: RepoCheckout) => Promise<string[]>,
  diagnostics: boolean,
): Promise<RulesRead> {
  const result: RulesRead = { rules: [], skipped: [], nestedDirectories: {} };
  let count = 0;
  for (const repo of [...repos]
    .sort((a, b) => (a.repoId < b.repoId ? -1 : a.repoId > b.repoId ? 1 : 0))
    .slice(0, 32)) {
    try {
      const paths = sorted((await candidates(repo)).filter(isRulePath)).sort(
        (a, b) =>
          a === '.cursorrules'
            ? -1
            : b === '.cursorrules'
              ? 1
              : a < b
                ? -1
                : a > b
                  ? 1
                  : 0,
      );
      const instructions = diagnostics
        ? await instructionBodies(repo.root)
        : [];
      for (const path of paths) {
        if (count++ >= MAX_RULES) {
          if (result.skipped.length < MAX_RULES)
            result.skipped.push({
              repoId: repo.repoId,
              path: validRelativePath(path) ? path : '',
              reason: 'limit',
            });
          continue;
        }
        try {
          const bytes = await readBoundedBytes(repo.root, path);
          const rule = parseRepoRule(
            repo.repoId,
            path,
            bytes.toString('utf8'),
            bytes,
          );
          if (diagnostics && isDuplicate(rule.body, instructions)) {
            rule.flags.push('duplicate');
            rule.selected = false;
          }
          if (diagnostics && (await referencesMissing(repo, rule)))
            rule.flags.push('missing-file-reference');
          result.rules.push(rule);
          if (rule.scope) {
            const directories = result.nestedDirectories[repo.repoId] ?? [];
            directories.push(`${rule.scope}.cursor/rules`);
            result.nestedDirectories[repo.repoId] = sorted(directories);
          }
        } catch (e) {
          result.skipped.push({
            repoId: repo.repoId,
            path: validRelativePath(path) ? path : '',
            reason: reason(e),
          });
        }
      }
    } catch (e) {
      result.skipped.push({ repoId: repo.repoId, path: '', reason: reason(e) });
    }
  }
  return result;
}
/**
 * Keeps the first spelling of each physical file, in input order. Aliases are
 * resolved through the filesystem rather than by folding distinct file names,
 * so review offers exactly the spellings session reads use.
 */
async function firstSpellings(
  root: string,
  paths: string[],
): Promise<string[]> {
  const accepted: string[] = [];
  const identities = new Set<string>();
  for (const path of paths) {
    const identity = validRelativePath(path)
      ? await safePath(root, path)
          .then((file) => realpath(file))
          .catch(() => null)
      : null;
    if (identity !== null) {
      if (identities.has(identity)) continue;
      identities.add(identity);
    }
    accepted.push(path);
  }
  return accepted;
}
export async function discoverRules(repos: RepoCheckout[]): Promise<RulesRead> {
  const options = {
    pathspecs: [
      '.cursorrules',
      ':(glob)**/.cursor/rules/**/*.mdc',
      ':(glob).cursor/rules/**/*.mdc',
    ],
    maxBuffer: 2 * 1024 * 1024,
    timeoutMs: 5000,
  };
  return collect(
    repos,
    async (repo) => {
      // Git lists untracked files before index entries. Sessions prefer index
      // spellings, so put them first before folding aliases.
      const [tracked, all] = await Promise.all([
        listTrackedFiles(repo.root, { ...options, cachedOnly: true }),
        listTrackedFiles(repo.root, options),
      ]);
      const indexed = new Set(tracked);
      return firstSpellings(repo.root, [
        ...tracked,
        ...all.filter((path) => !indexed.has(path)),
      ]);
    },
    true,
  );
}
async function enumerate(
  repo: RepoCheckout,
  directories: string[],
): Promise<string[]> {
  const state = await eligibility(repo.root);
  const canonicalRoot = await realpath(repo.root);
  const pending = sorted(['.cursor/rules', ...directories]);
  const paths = Array.from(state.tracked).filter(
    (path) =>
      path === '.cursorrules' ||
      pending.some((dir) => path.startsWith(`${dir}/`)),
  );
  if (await lstat(join(repo.root, '.cursorrules')).catch(() => null))
    paths.push('.cursorrules');
  const visited = new Set<string>();
  let entries = 0;
  while (pending.length) {
    const dir = pending.shift();
    if (!dir || visited.has(dir)) continue;
    visited.add(dir);
    if (!validRelativePath(dir) || dir.split('/').length > 32)
      throw new Error('unsafe-path');
    let handle;
    let actualDir = dir;
    try {
      actualDir = relative(
        canonicalRoot,
        await realpath(await safePath(repo.root, dir)),
      )
        .split(sep)
        .join('/');
      // Match scanning's rule-location policy against physical directory names.
      if (!isRulePath(`${actualDir}/rule.mdc`)) continue;
      handle = await opendir(join(canonicalRoot, actualDir));
    } catch (e) {
      if (
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        (e.code === 'ENOENT' || e.code === 'ENOTDIR')
      )
        continue;
      throw e;
    }
    const children: string[] = [];
    for await (const entry of handle) {
      if (++entries > MAX_ENTRIES) throw new Error('limit');
      const path = `${actualDir}/${entry.name}`;
      if (entry.isDirectory()) children.push(path);
      else if (path.endsWith('.mdc')) paths.push(path);
    }
    pending.push(...children.sort());
    if (pending.length > MAX_ENTRIES) throw new Error('limit');
  }
  const candidates: string[] = [];
  for (const path of paths) {
    if (validRelativePath(path) && (await eligible(repo.root, path, state)))
      candidates.push(path);
  }
  // Tracked paths come first, preserving the IDs offered by review.
  return sorted(await firstSpellings(repo.root, candidates));
}
export async function readSessionRules(
  repos: RepoCheckout[],
  nestedDirectories: Record<string, string[]>,
): Promise<RulesRead> {
  return collect(
    repos,
    (repo) => enumerate(repo, nestedDirectories[repo.repoId] ?? []),
    false,
  );
}

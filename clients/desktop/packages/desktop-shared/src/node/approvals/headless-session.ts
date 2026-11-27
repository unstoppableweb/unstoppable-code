import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import { validateId } from '@canopy/execution-engine/node/lib/validation';
import { readPreferencesEnvelopeRecord } from '@canopy/protocol/preferences';
import type { ApprovalMode, ApprovalRule } from '../../types';
import {
  evaluateApproval,
  normalizeApprovalRules,
} from '../../lib/approval-engine';
import { createApprovalCanonicalizer } from './canonicalize';
import { resolveExistingAncestorPath } from './paths';
import { getWorkspaceItem } from '../lib/workspace-cli-reads';
import {
  getProjectConfigFileCandidates,
  parseCanopyJson,
} from '../lib/canopy-json';
import { getRepoRootFromWorktree } from '../../lib/git';
import type { NativeToolApprovalPort } from './native-tool-port';

async function referencePolicyRoot(
  configuredPath: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await getRepoRootFromWorktree(configuredPath, { signal });
  } catch (error) {
    // A non-Git workspace can own a manifest. An unreadable Git mapping cannot
    // silently substitute a worktree's manifest for the reference policy.
    for (let current = resolve(configuredPath); ; current = dirname(current)) {
      signal.throwIfAborted();
      const marker = await lstat(join(current, '.git')).catch((failure) => {
        if (isRecord(failure) && failure.code === 'ENOENT') return undefined;
        throw failure;
      });
      if (marker) throw error;
      if (dirname(current) === current) return configuredPath;
    }
  }
}

/** A missing config is optional; an unreadable or dangling config is not. */
async function readPolicyManifest(
  repoRoot: string,
): Promise<ReturnType<typeof parseCanopyJson> | null> {
  for (const candidate of getProjectConfigFileCandidates(repoRoot)) {
    let raw: string;
    try {
      raw = await readFile(candidate, 'utf8');
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      const marker = await lstat(candidate).catch((failure) => {
        if (isRecord(failure) && failure.code === 'ENOENT') return undefined;
        throw failure;
      });
      if (marker) throw error;
      continue;
    }
    return parseCanopyJson(raw, candidate);
  }
  return null;
}

function strictRules(value: unknown): ApprovalRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Approval rules are unreadable.');
  const rules = normalizeApprovalRules(value);
  if (
    rules.length !== value.length ||
    rules.some((rule, index) => {
      const saved: unknown = value[index];
      return (
        !isRecord(saved) ||
        saved.id !== rule.id ||
        saved.createdAt !== rule.createdAt ||
        saved.origin !== rule.origin
      );
    })
  )
    throw new Error('Approval rules are unreadable.');
  return rules;
}

/** Read-only: a CLI never repairs preferences or becomes their writer. */
export async function readHeadlessPreferences(): Promise<
  Record<string, unknown>
> {
  const preferences = readPreferencesEnvelopeRecord(
    JSON.parse(
      await readFile(join(getCanopyDataDir(), 'preferences.json'), 'utf8'),
    ),
  );
  if (!preferences) throw new Error('Preferences are unreadable.');
  return preferences;
}

/** The data-root trees Canopy hands agents as working folders. */
function managedWorkingFolders(root: string): string[] {
  return [
    join(root, 'workspaces', '*', 'worktrees', '*'),
    join(root, 'workspaces', '*', 'home'),
    join(root, 'app-workspaces', '*', 'home'),
    join(root, 'repos', '*'),
  ];
}

function isAtOrBelow(path: string, folder: string): boolean {
  const rest = relative(folder, path);
  return (
    rest === '' ||
    (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
  );
}

/**
 * Within the data root, only a folder 3+ levels down may exempt itself: any
 * shallower one can hold policy (a store, a workspace's `approvals.json`, the
 * Antigravity gate config). `*` is refused because the engine reads it as a
 * wildcard.
 */
function mayExemptSessionFolder(folder: string, root: string): boolean {
  if (folder.includes('*') || isAtOrBelow(root, folder)) return false;
  return (
    !isAtOrBelow(folder, root) || relative(root, folder).split(sep).length >= 3
  );
}

export interface HeadlessApprovalSession extends NativeToolApprovalPort {
  /** Exempts a folder the host stages for the agent, such as its skills. */
  exemptWorkingFolder(path: string): void;
}

/** No prompt transport: every decision requiring a person is denied. */
export function createHeadlessApprovalSession(options: {
  cwd: string;
  projectId?: string;
  mode: ApprovalMode;
  sessionRules: ApprovalRule[];
  signal: AbortSignal;
}): HeadlessApprovalSession {
  const dataRoot = getCanopyDataDir();
  if (options.projectId) validateId(options.projectId, 'projectId');
  const projectPath = options.projectId
    ? join(dataRoot, 'workspaces', options.projectId, 'approvals.json')
    : undefined;
  const stagedFolders: string[] = [];
  let canonicalDataRoot: Promise<string> | undefined;
  function canonicalRoot(): Promise<string> {
    canonicalDataRoot ??= resolveExistingAncestorPath(
      dataRoot,
      options.cwd,
    ).then((root) => {
      if (!root) throw new Error('Approval policy paths are unreadable.');
      return root;
    });
    return canonicalDataRoot;
  }
  const { canonicalizeCheck, canonicalProtectedFileWritePaths } =
    createApprovalCanonicalizer(options.cwd, async () => {
      // Protect all app policy and recovery files at any depth, including
      // other workspaces'; `protectedFileExemptPaths` carves out working trees.
      const root = await canonicalRoot();
      return [root, join(root, '**')];
    });
  async function exemptFolders(
    repoPath: string | undefined,
  ): Promise<string[]> {
    const root = await canonicalRoot();
    const sessionFolders = await Promise.all(
      [options.cwd, repoPath, ...stagedFolders]
        .filter((path): path is string => path !== undefined)
        .map((path) => resolveExistingAncestorPath(path, options.cwd)),
    );
    return [
      ...managedWorkingFolders(root),
      ...sessionFolders.filter(
        (folder): folder is string =>
          folder !== undefined && mayExemptSessionFolder(folder, root),
      ),
    ];
  }
  async function projectPolicy(): Promise<{
    rules: ApprovalRule[];
    repoPath: string | undefined;
  }> {
    let persisted: ApprovalRule[] = [];
    let repoRoot: string | undefined = options.cwd;
    if (options.projectId && projectPath) {
      const workspace = await getWorkspaceItem(options.projectId);
      repoRoot =
        workspace.type === 'single-repo'
          ? workspace.repoPath
          : workspace.type === 'multi-repo'
            ? workspace.sourceRepoPath
            : undefined;
      try {
        const value: unknown = JSON.parse(await readFile(projectPath, 'utf8'));
        if (
          !isRecord(value) ||
          value.version !== 1 ||
          !Array.isArray(value.rules)
        )
          throw new Error('Workspace approvals are unreadable.');
        persisted = strictRules(value.rules);
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      }
    }
    const referenceRoot = repoRoot
      ? await referencePolicyRoot(repoRoot, options.signal)
      : undefined;
    const manifest = referenceRoot
      ? await readPolicyManifest(referenceRoot)
      : null;
    return {
      rules: [
        ...persisted,
        ...(manifest?.approvals?.rules ?? []).filter(
          (rule) => rule.behavior === 'deny',
        ),
      ],
      repoPath: repoRoot,
    };
  }
  return {
    exemptWorkingFolder(path) {
      stagedFolders.push(path);
    },
    async check(check) {
      try {
        options.signal.throwIfAborted();
        const [preferences, project, canonical, protectedFileWritePaths] =
          await Promise.all([
            readHeadlessPreferences(),
            projectPolicy(),
            canonicalizeCheck(check),
            canonicalProtectedFileWritePaths(),
          ]);
        const protectedFileExemptPaths = await exemptFolders(project.repoPath);
        options.signal.throwIfAborted();
        const rules = {
          session: options.sessionRules,
          project: project.rules,
          global: strictRules(preferences.globalApprovalRules),
        };
        const failed =
          canonical.check.kind === 'file-write' &&
          canonical.check.resolvedPath === undefined;
        const evaluation = evaluateApproval(canonical.check, {
          mode: options.mode,
          rules: failed
            ? {
                session: rules.session.filter(
                  (rule) => rule.behavior === 'deny',
                ),
                project: rules.project.filter(
                  (rule) => rule.behavior === 'deny',
                ),
                global: rules.global.filter((rule) => rule.behavior === 'deny'),
              }
            : rules,
          workspaceRoot: canonical.workspaceRoot,
          pathCaseInsensitive: canonical.pathCaseInsensitive,
          protectedFileWritePaths,
          protectedFileExemptPaths,
        });
        return evaluation.outcome === 'allow'
          ? { decision: 'allow' }
          : {
              decision: 'deny',
              message:
                'The saved approval policy does not allow this unattended action.',
            };
      } catch {
        return { decision: 'deny', message: 'Approval policy is unavailable.' };
      }
    },
  };
}

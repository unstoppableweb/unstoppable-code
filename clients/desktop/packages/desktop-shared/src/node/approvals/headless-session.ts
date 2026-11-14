import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import { validateId } from '@canopy/execution-engine/node/lib/validation';
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
  const value: unknown = JSON.parse(
    await readFile(join(getCanopyDataDir(), 'preferences.json'), 'utf8'),
  );
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.preferences))
    throw new Error('Preferences are unreadable.');
  return value.preferences;
}

/** No prompt transport: every decision requiring a person is denied. */
export function createHeadlessApprovalSession(options: {
  cwd: string;
  projectId?: string;
  mode: ApprovalMode;
  sessionRules: ApprovalRule[];
  signal: AbortSignal;
}): NativeToolApprovalPort {
  const dataRoot = getCanopyDataDir();
  if (options.projectId) validateId(options.projectId, 'projectId');
  const projectPath = options.projectId
    ? join(dataRoot, 'workspaces', options.projectId, 'approvals.json')
    : undefined;
  const { canonicalizeCheck, canonicalProtectedFileWritePaths } =
    createApprovalCanonicalizer(options.cwd, async () => {
      // Protect all app policy and recovery files, including other workspaces.
      const root = await resolveExistingAncestorPath(dataRoot, options.cwd);
      if (!root) throw new Error('Approval policy paths are unreadable.');
      return [root, join(root, '**')];
    });
  async function projectRules(): Promise<ApprovalRule[]> {
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
    return [
      ...persisted,
      ...(manifest?.approvals?.rules ?? []).filter(
        (rule) => rule.behavior === 'deny',
      ),
    ];
  }
  return {
    async check(check) {
      try {
        options.signal.throwIfAborted();
        const [preferences, project, canonical, protectedFileWritePaths] =
          await Promise.all([
            readHeadlessPreferences(),
            projectRules(),
            canonicalizeCheck(check),
            canonicalProtectedFileWritePaths(),
          ]);
        options.signal.throwIfAborted();
        const rules = {
          session: options.sessionRules,
          project,
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

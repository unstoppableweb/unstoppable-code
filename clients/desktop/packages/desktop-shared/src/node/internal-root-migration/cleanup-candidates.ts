import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { internalRootMigrationProgress } from './progress';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { InternalRootIdentity } from '@canopy/core-runtime/node/internal-root-migration';
import {
  internalRootCleanupCategories as cleanupCategories,
  isInternalRootCleanupStagingName,
} from '@canopy/core-runtime/node/internal-root-journal';
import {
  isWithin,
  type RelocationGit,
} from '@canopy/core-runtime/node/relocation';
import {
  readWorkspaceIndex,
  readWorkspaceManifest,
  readWorktreeList,
  type WorkspaceFileRead,
} from '@canopy/core-runtime/node/workspace/read-formats';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '../../types';
import { abandonedArchivePaths } from './abandoned-paths';
import { inspectDestructiveJournals } from '../w5-destructive-journal';
import {
  inertArchiveGroup,
  archiveName,
  isAbandonedArchive,
} from './lifecycle-policy';
import {
  assertPrivateMigrationFile,
  durableJson,
  privateDirectory,
  statIfPresent,
} from './filesystem';
import {
  createPrivateMigrationDirectory,
  migrationNodeIdentity,
  type InternalRootFilesystemHost,
} from './filesystem-host';

type CleanupCategory = (typeof cleanupCategories)[number];
interface InternalRootCleanupCandidate {
  readonly path: string;
  readonly bytes: number;
  readonly category: CleanupCategory;
  readonly disposition: 'safe to drop' | 'review before deleting';
  readonly reason: string;
  readonly copy: 'old-root' | 'new-root' | 'external';
  readonly restoreSource: string;
  readonly worktreePath?: string;
}
export interface InternalRootCleanupReport {
  readonly version: 1;
  readonly title: 'Cleanup candidates';
  readonly notice: string;
  readonly reportPath: string;
  readonly restoreSource: {
    readonly path: string;
    readonly bytes: number | null;
  };
  readonly entries: readonly InternalRootCleanupCandidate[];
  readonly totals: readonly {
    category: CleanupCategory;
    entries: number;
    bytes: number;
  }[];
  readonly reclaimableBytes: number;
  readonly warnings: readonly string[];
}

const idPattern = /^[A-Za-z0-9_-]+$/;
const appManagedWorkspaceIds = new Set([
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
]);
const osMetadata = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const w5Owned = new Set([
  'commit-log.sqlite',
  'commit-log.sqlite-wal',
  'commit-log.sqlite-shm',
  'commit-log.sqlite-journal',
  'backups',
  'restore-evidence',
  'destructive-lifecycles',
  'quarantined-lifecycles',
]);

/** Never follows directory links, including links in an ancestor. */
async function canonicalDirectory(path: string): Promise<boolean> {
  const stat = await statIfPresent(path);
  return !!stat?.isDirectory() && (await realpath(path)) === path;
}

async function document(path: string): Promise<WorkspaceFileRead> {
  const stat = await statIfPresent(path);
  if (!stat) return { state: 'absent' };
  if (!stat.isFile() || (await realpath(path)) !== path)
    return { state: 'unreadable' };
  return { state: 'present', raw: await readFile(path, 'utf8') };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A row may retain external checkouts; absence of the conventional folder is not enough. */
function rowCheckoutPaths(row: Record<string, unknown>): string[] | null {
  const paths: unknown[] = row.path === undefined ? [] : [row.path];
  if (row.creation !== undefined) {
    if (
      !isRecord(row.creation) ||
      row.creation.state !== 'complete' ||
      !Array.isArray(row.creation.checkouts)
    )
      return null;
    for (const value of row.creation.checkouts) {
      const checkout: unknown = value;
      if (!isRecord(checkout)) return null;
      paths.push(checkout.checkoutPath);
    }
  }
  if (row.healthIssue !== undefined) {
    if (!isRecord(row.healthIssue)) return null;
    paths.push(row.healthIssue.worktreePath);
  }
  if (
    !paths.every(
      (path): path is string => typeof path === 'string' && isAbsolute(path),
    )
  )
    return null;
  return paths;
}

/** Logical file bytes, not allocated blocks; hard links count once per path. */
async function size(path: string): Promise<number> {
  const stat = await lstat(path);
  internalRootMigrationProgress('sizing cleanup candidates');
  if (!stat.isDirectory()) return stat.size;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await size(join(path, name));
  return bytes;
}

export async function collectInternalRootCleanupCandidates(
  identity: InternalRootIdentity,
  options: {
    readonly abandonArchives?: readonly string[];
    readonly abandonCheckouts?: readonly string[];
    readonly applied: boolean;
    readonly git: RelocationGit;
    /** Reuse the migration inventory; never walk the restore root just to size it. */
    readonly sourceBytes?: number;
  },
): Promise<InternalRootCleanupReport> {
  const entries = new Map<string, InternalRootCleanupCandidate>();
  const warnings: string[] = [];
  const abandoned = (
    await inspectDestructiveJournals(identity.source)
  ).records.filter(({ record }) =>
    isAbandonedArchive(record, options.abandonArchives ?? []),
  );
  const abandonedCheckouts = new Map<string, string>();
  for (const { name, record } of abandoned) {
    const archive = archiveName(record);
    if (!archive || !record.worktreeId) continue;
    for (const path of await abandonedArchivePaths(identity.source, [
      {
        name,
        abandoned: {
          workspaceId: record.workspaceId,
          worktreeId: record.worktreeId,
        },
      },
    ]))
      abandonedCheckouts.set(path, archive);
  }
  const checkedGit = new Set<string>();
  const opaqueDirectories = new Set<string>();
  const warn = (path: string): void => {
    warnings.push(
      `Could not fully inspect ${JSON.stringify(path)}; do not infer that unlisted data is disposable.`,
    );
  };
  const add = async (
    path: string,
    category: CleanupCategory,
    reason: string,
    copy: InternalRootCleanupCandidate['copy'],
    worktreePath?: string,
  ): Promise<void> => {
    if (entries.has(path)) return;
    if (
      [...entries.values()].some(
        (entry) =>
          entry.category === 'abandoned-archive' &&
          path.startsWith(`${entry.path}${sep}`),
      )
    )
      return;
    if (
      category !== 'abandoned-archive' &&
      [...entries.values()].some(
        (entry) =>
          entry.category === 'abandoned-archive' &&
          entry.path.startsWith(`${path}${sep}`),
      )
    ) {
      warn(path);
      return;
    }
    entries.set(path, {
      path,
      bytes: await size(path),
      category,
      disposition:
        category === 'os-metadata' ? 'safe to drop' : 'review before deleting',
      reason,
      copy,
      restoreSource: identity.source,
      ...(worktreePath ? { worktreePath } : {}),
    });
  };
  const inspectGit = async (checkout: string): Promise<void> => {
    if (
      (options.abandonCheckouts ?? []).some((path) => isWithin(path, checkout))
    )
      return;
    try {
      if (!isAbsolute(checkout) || !(await canonicalDirectory(checkout)))
        return;
      const dotGit = await statIfPresent(join(checkout, '.git'));
      if (!dotGit || dotGit.isSymbolicLink()) return;
      const common = resolve(
        (
          await options.git(checkout, [
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
          ])
        ).replace(/\r?\n$/, ''),
      );
      if (checkedGit.has(common)) return;
      checkedGit.add(common);
      for (const { record } of isWithin(identity.destination, common)
        ? []
        : abandoned) {
        const archive = archiveName(record);
        if (!archive) continue;
        for (const namespace of [
          'refs/app/archived-containers',
          'refs/canopy-migration-abandoned/archived-containers',
        ]) {
          const refs = await options.git(checkout, [
            'for-each-ref',
            '--format=%(refname) %(objectname)',
            `${namespace}/${archive}/`,
          ]);
          for (const line of refs.trim().split('\n').filter(Boolean)) {
            const [ref, oid] = line.split(' ');
            if (!ref || !oid) continue;
            const path = `${common}#${ref}`;
            entries.set(path, {
              path,
              bytes: 0,
              category: 'abandoned-archive',
              disposition: 'review before deleting',
              reason: `Abandoned archive ${archive}: Git ref ${ref} at ${oid}; review with git update-ref, not filesystem deletion.`,
              copy: isWithin(identity.source, common) ? 'old-root' : 'external',
              restoreSource: identity.source,
            });
          }
        }
      }
      const admin = join(common, 'worktrees');
      if (!(await canonicalDirectory(admin))) return;
      const listed = await options.git(checkout, [
        'worktree',
        'list',
        '--porcelain',
        '-z',
      ]);
      const missing = new Set<string>();
      for (const row of listed.split('\0\0')) {
        const fields = row.split('\0');
        const path = fields
          .find((field) => field.startsWith('worktree '))
          ?.slice(9);
        if (
          path &&
          fields.some(
            (field) => field === 'prunable' || field.startsWith('prunable '),
          ) &&
          !(await statIfPresent(path))
        )
          missing.add(resolve(path));
      }
      for (const name of await readdir(admin)) {
        const path = join(admin, name);
        if (!(await canonicalDirectory(path))) continue;
        const backlink = await document(join(path, 'gitdir'));
        if (backlink.state !== 'present') continue;
        const worktree = dirname(
          resolve(path, backlink.raw.replace(/\r?\n$/, '')),
        );
        const abandonedName = [...abandonedCheckouts].find(([root]) =>
          isWithin(root, worktree),
        )?.[1];
        if (!missing.has(worktree) && !abandonedName) continue;
        const inRoot = (root: string): boolean => {
          const part = relative(root, path);
          return (
            part !== '..' &&
            !part.startsWith('../') &&
            !part.startsWith('..\\') &&
            !isAbsolute(part)
          );
        };
        await add(
          path,
          abandonedName ? 'abandoned-archive' : 'prunable-git-worktree',
          abandonedName
            ? `Abandoned archive ${abandonedName}: retained Git worktree record; review before deleting.`
            : 'Git marks this absent checkout prunable; review retained index or staged state before dropping its administrative entry.',
          inRoot(identity.source)
            ? 'old-root'
            : inRoot(identity.destination)
              ? 'new-root'
              : 'external',
          worktree,
        );
      }
    } catch {
      warn(checkout);
    }
  };

  for (const path of options.abandonCheckouts ?? []) {
    if (!(await statIfPresent(path))) continue;
    if ((await realpath(dirname(path))) !== dirname(path)) {
      warn(path);
      continue;
    }
    await add(
      path,
      'abandoned-archive',
      `Broken checkout ${JSON.stringify(path)}: explicitly omitted from migration; retained in the old root.`,
      'old-root',
    );
  }

  for (const root of options.applied
    ? [identity.source, identity.destination]
    : [identity.source]) {
    const copy = root === identity.source ? 'old-root' : 'new-root';
    try {
      if (!(await canonicalDirectory(root))) {
        warn(root);
        continue;
      }
      for (const { name, record } of root === identity.source
        ? abandoned
        : []) {
        const worktreeId = record.worktreeId;
        if (!worktreeId) continue;
        const reason = `Abandoned archive ${archiveName(record)}: retained evidence or payload; review before deleting.`;
        const paths = await abandonedArchivePaths(root, [
          { name, abandoned: { workspaceId: record.workspaceId, worktreeId } },
        ]);
        for (const path of new Set(paths)) {
          if (!(await statIfPresent(path))) continue;
          if ((await realpath(dirname(path))) !== dirname(path)) {
            warn(path);
            continue;
          }
          await add(path, 'abandoned-archive', reason, copy);
        }
      }
      const w5 = join(root, 'w5');
      const inspectW5 = await canonicalDirectory(w5);
      const journals = inspectW5
        ? await inspectDestructiveJournals(root)
        : { records: [], issues: [] };
      if (journals.issues.length) warn(join(w5, 'destructive-lifecycles'));
      const lifecycleReadable = inspectW5 || !(await statIfPresent(w5));
      if (!lifecycleReadable) warn(w5);
      const workspaceRoot = join(root, 'workspaces');
      const pluginRoot = join(root, 'chat-plugins');
      const workspaceRootPresent = await statIfPresent(workspaceRoot);
      if (!workspaceRootPresent || (await canonicalDirectory(workspaceRoot))) {
        const index = readWorkspaceIndex(
          await document(join(workspaceRoot, 'index.json')),
          () => undefined,
        );
        if (index.authority !== 'ok' && index.authority !== 'absent') {
          warn(join(workspaceRoot, 'index.json'));
          opaqueDirectories.add(workspaceRoot);
          opaqueDirectories.add(pluginRoot);
        } else {
          const indexedIds = new Set(index.entries.map((entry) => entry.id));
          const ids = new Set(indexedIds);
          if (await canonicalDirectory(pluginRoot)) {
            for (const item of await readdir(pluginRoot, {
              withFileTypes: true,
            }))
              if (item.isDirectory()) ids.add(item.name);
          }
          for (const item of workspaceRootPresent
            ? await readdir(workspaceRoot, { withFileTypes: true })
            : []) {
            const path = join(workspaceRoot, item.name);
            if (item.isDirectory() && !indexedIds.has(item.name))
              await add(
                path,
                'unindexed-workspace',
                'Not in the workspace index; may contain unique chat history or other user data.',
                copy,
              );
            else if (
              item.isFile() &&
              !['index.json', 'index.json.bak'].includes(item.name) &&
              !osMetadata.has(item.name)
            )
              await add(
                path,
                'unrecognized-workspace-file',
                'Not a recognized workspace index file; inspect its contents and keep any needed history.',
                copy,
              );
          }
          for (const id of ids) {
            if (!idPattern.test(id)) {
              warn(workspaceRoot);
              continue;
            }
            // Plugin owners can outlive both their index entry and workspace directory.
            // Reserved app scopes have no Git worktree, even with no local metadata.
            if (appManagedWorkspaceIds.has(id)) continue;
            const workspace = join(workspaceRoot, id);
            if (
              (await statIfPresent(workspace)) &&
              !(await canonicalDirectory(workspace))
            ) {
              warn(workspace);
              continue;
            }
            const manifest = readWorkspaceManifest(
              await document(join(workspace, 'workspace.json')),
            );
            if (manifest.authority === 'unreadable') {
              warn(join(workspace, 'workspace.json'));
              continue;
            }
            // Cowork membership is not represented by worktrees.json.
            if (
              index.entries.some(
                (entry) => entry.id === id && entry.type === 'cowork',
              ) ||
              (manifest.authority === 'ok' &&
                manifest.document.type === 'cowork') ||
              (await statIfPresent(join(workspace, 'work-entries.json')))
            )
              continue;
            if (manifest.authority === 'ok') {
              const repos = manifest.document.repos;
              const repoPaths: unknown[] = [
                manifest.document.repoPath,
                manifest.document.sourceRepoPath,
              ];
              if (Array.isArray(repos))
                for (const value of repos) {
                  const repo: unknown = value;
                  if (
                    typeof repo === 'object' &&
                    repo !== null &&
                    'repoPath' in repo
                  )
                    repoPaths.push(repo.repoPath);
                }
              for (const path of repoPaths)
                if (typeof path === 'string') await inspectGit(path);
            }
            const list = readWorktreeList(
              await document(join(workspace, 'worktrees.json')),
            );
            if (
              list.authority === 'unreadable' ||
              (list.authority === 'ok' && !list.complete)
            ) {
              warn(join(workspace, 'worktrees.json'));
              continue;
            }
            const rows = list.authority === 'ok' ? list.worktrees : [];
            for (const row of rows) {
              if (typeof row.path === 'string') await inspectGit(row.path);
            }
            // Local unindexed sidecars are already sized by the opaque workspace entry.
            const localSidecars = indexedIds.has(id)
              ? ['worktree-data', 'attachments', 'script-runs', 'cost'].map(
                  (name) => join(workspace, name),
                )
              : [];
            for (const sidecars of [...localSidecars, join(pluginRoot, id)]) {
              if (!(await canonicalDirectory(sidecars))) continue;
              for (const item of await readdir(sidecars, {
                withFileTypes: true,
              })) {
                if (!item.isDirectory() || !idPattern.test(item.name)) continue;
                if (
                  await statIfPresent(
                    join(workspace, 'archived-containers', item.name),
                  )
                )
                  continue;
                if (!lifecycleReadable || journals.issues.length) continue;
                if (
                  journals.records.some(
                    ({ record }) =>
                      record.workspaceId === id &&
                      (record.worktreeId === undefined ||
                        record.worktreeId === item.name) &&
                      (record.state !== 'completed' ||
                        record.cleanupRequired === true),
                  ) ||
                  (await statIfPresent(
                    join(
                      workspace,
                      'worktree-data',
                      item.name,
                      'archive-recovery-evidence',
                    ),
                  ))
                ) {
                  warnings.push(
                    `Recovery evidence retains ${JSON.stringify(join(sidecars, item.name))}; sidecar data is not inferred to be orphaned.`,
                  );
                  continue;
                }
                const matchingRows = rows.filter((row) => row.id === item.name);
                if (matchingRows.length > 1) {
                  warn(join(workspace, 'worktrees.json'));
                  continue;
                }
                const row = matchingRows[0];
                // A retained row alone is not proof of a live worktree.
                if (row) {
                  const paths = rowCheckoutPaths(row);
                  if (
                    paths === null ||
                    row.replica !== undefined ||
                    row.setupPhase === 'git-pending' ||
                    row.splitRecoveryRequired === true ||
                    row.adhocTransitionSource !== undefined ||
                    row.pendingArchiveBranchDeletion !== undefined ||
                    row.pendingArchiveBranchDeletions !== undefined
                  ) {
                    warn(join(workspace, 'worktrees.json'));
                    continue;
                  }
                  let present = false;
                  for (const path of paths)
                    if (await statIfPresent(path)) present = true;
                  if (present) continue;
                }
                if (
                  await statIfPresent(join(workspace, 'worktrees', item.name))
                )
                  continue;
                await add(
                  join(sidecars, item.name),
                  'orphaned-worktree-data',
                  'No checkout or archive remains at the known worktree paths; sidecar data may still contain unique chats or execution history.',
                  copy,
                );
              }
            }
          }
        }
      } else {
        warn(workspaceRoot);
        opaqueDirectories.add(workspaceRoot);
        opaqueDirectories.add(pluginRoot);
      }
      if (inspectW5) {
        for (const item of await readdir(w5, { withFileTypes: true })) {
          if (
            item.isFile() &&
            !w5Owned.has(item.name) &&
            !osMetadata.has(item.name)
          )
            await add(
              join(w5, item.name),
              'unrecognized-w5-file',
              'Not used as W5 authority; may be a diagnostic log or backup needed for recovery.',
              copy,
            );
        }
        for (const { record } of journals.records) {
          if (
            (await inertArchiveGroup(root, record)) !== 'pre-quarantine' ||
            !record.worktreeId
          )
            continue;
          const path = join(
            root,
            'workspaces',
            record.workspaceId,
            'archived-containers',
            record.worktreeId,
          );
          if (await canonicalDirectory(path))
            await add(
              path,
              'inert-archive-staging',
              'Inert stranded archive staging has no committed container.json; compare captured payload with live data before dropping this copy.',
              copy,
            );
        }
      }
      const visit = async (path: string): Promise<string[]> => {
        // Size opaque candidates once, without scanning their contents again.
        if (entries.has(path) || opaqueDirectories.has(path)) return [];
        try {
          const children = await readdir(path, { withFileTypes: true });
          internalRootMigrationProgress('scanning cleanup directories');
          if (
            path !== w5 &&
            !path.startsWith(`${w5}/`) &&
            !path.startsWith(`${w5}\\`) &&
            children.some((item) => item.name === '.git')
          )
            await inspectGit(path);
          const directories: string[] = [];
          for (const item of children) {
            const child = join(path, item.name);
            if (item.isFile() && osMetadata.has(item.name))
              await add(
                child,
                'os-metadata',
                'OS-generated display or thumbnail metadata; the operating system can regenerate it.',
                copy,
              );
            else if (item.isDirectory() && item.name !== '.git')
              directories.push(child);
          }
          return directories;
        } catch {
          warn(path);
          return [];
        }
      };
      // Bound directory/Git work; ordinary checkout files need no per-file stat.
      for (const path of abandonedCheckouts.keys())
        if (path.startsWith(`${root}${sep}`)) await inspectGit(path);
      const pending = [root];
      while (pending.length) {
        const next = await Promise.all(pending.splice(-8).map(visit));
        for (const directories of next) pending.push(...directories);
      }
    } catch {
      warn(root);
    }
  }
  // Remove nested candidates, including Git records already covered by an opaque folder.
  const sorted = [...entries.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const unique = sorted.filter((entry) => {
    let parent = dirname(entry.path);
    while (true) {
      if (entries.has(parent)) return false;
      const next = dirname(parent);
      if (next === parent) return true;
      parent = next;
    }
  });
  const totals = cleanupCategories.map((category) => {
    const members = unique.filter((entry) => entry.category === category);
    return {
      category,
      entries: members.length,
      bytes: members.reduce((sum, entry) => sum + entry.bytes, 0),
    };
  });
  return {
    version: 1,
    title: 'Cleanup candidates',
    notice:
      'Removal is your choice. The script does not delete, move or rename cleanup candidates. Keep the old root as the restore source until the new installation checks out. Review before deleting may include unique user data. Sizes are logical bytes, not guaranteed disk savings. Totals sum the listed old-root, new-root and external copies, not the whole old root; old-root candidates already overlap the restore source size. Do not add that size to these totals.',
    reportPath: join(identity.coordination, 'cleanup-candidates.json'),
    restoreSource: {
      path: identity.source,
      bytes: options.sourceBytes ?? null,
    },
    entries: unique,
    totals,
    reclaimableBytes: totals.reduce((sum, total) => sum + total.bytes, 0),
    warnings: [...new Set(warnings)],
  };
}

/** Human-readable diagnostics belong on stderr; stdout remains machine-readable JSON. */
export function formatInternalRootCleanupReport(
  report: InternalRootCleanupReport,
): string {
  const lines = [
    report.title,
    report.notice,
    `Report: ${JSON.stringify(report.reportPath)}`,
    `Restore source (retained old root): ${JSON.stringify(report.restoreSource.path)} (${report.restoreSource.bytes === null ? 'size unavailable' : `${report.restoreSource.bytes} bytes, inventory snapshot`})`,
    'Totals by category (listed copies only):',
    ...report.totals.map(
      (total) =>
        `  ${total.category}: ${total.entries} entries; ${total.bytes} bytes`,
    ),
    `Overall potentially reclaimable: ${report.reclaimableBytes} bytes (review dispositions before removing anything)`,
    'Entries:',
  ];
  if (!report.entries.length) lines.push('  None identified.');
  for (const entry of report.entries) {
    lines.push(
      `  ${entry.copy} | ${entry.category} | ${entry.disposition} | ${entry.bytes} bytes`,
      `    Path: ${JSON.stringify(entry.path)}`,
      `    Reason: ${entry.reason}`,
      `    Restore source: ${JSON.stringify(entry.restoreSource)}`,
    );
    if (entry.worktreePath)
      lines.push(`    Absent checkout: ${JSON.stringify(entry.worktreePath)}`);
  }
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  return `${lines.join('\n')}\n`;
}

/** Caller holds migration coordination; neither payload tree is written. */
export async function saveInternalRootCleanupReport(
  report: InternalRootCleanupReport,
  host: InternalRootFilesystemHost,
): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(report)) + 1 > 16 * 1024 * 1024)
    throw new Error(
      'Cleanup report exceeds the supported size; retain both roots and the journal for review.',
    );
  const directory = dirname(report.reportPath);
  if (!(await statIfPresent(directory)))
    await createPrivateMigrationDirectory(directory, host);
  await privateDirectory(directory, host);
  const previous = await statIfPresent(report.reportPath);
  if (
    previous &&
    (!previous.isFile() ||
      previous.nlink !== 1 ||
      (await realpath(report.reportPath)) !== report.reportPath)
  )
    throw new Error('Unsafe cleanup report path; preserve the existing entry.');
  const staging = [];
  for (const name of (await readdir(directory)).filter(
    isInternalRootCleanupStagingName,
  )) {
    const path = join(directory, name);
    try {
      const stat = await assertPrivateMigrationFile(path, host);
      staging.push({
        path,
        stat,
        identity: await migrationNodeIdentity(path, stat),
      });
    } catch {
      // Unsafe or disappearing entries are not abandoned report outputs.
    }
  }
  await durableJson(report.reportPath, report, host, {
    removeTempOnFailure: true,
  });
  // Process death can bypass durableJson's failure cleanup. Preserve unsafe nodes.
  for (const prior of staging) {
    try {
      const stat = await assertPrivateMigrationFile(prior.path, host);
      if (
        (await migrationNodeIdentity(prior.path, stat)) !== prior.identity ||
        stat.size !== prior.stat.size ||
        stat.mode !== prior.stat.mode ||
        stat.mtimeMs !== prior.stat.mtimeMs ||
        stat.ctimeMs !== prior.stat.ctimeMs
      )
        continue;
      await rm(prior.path, { force: true });
    } catch {
      // A concurrent replacement or removal must not fail the saved report.
      continue;
    }
  }
}

import type { SidebarItem } from '@canopy/desktop-shared/types';
import { discoverProjectPipelines } from './project-pipeline-discovery';
import type { ProjectPipelineRequest } from '@canopy/execution-engine/types/pipeline';
import { getCoworkWorkspaceRootDir } from '../lib/paths';
import { getManagedCuratedPipeline } from './curated-pipeline-catalog';
import {
  getStoredPipelineBySource,
  getPipelineText,
  listPipelines,
} from './pipeline-service';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { getProjectPipelinesDirCandidates } from '@canopy/execution-engine/pipelines/config-paths';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { isPathInside } from '../lib/path-safety';
import type { PipelineShareSource } from '@canopy/execution-engine/types/pipeline';
import { parseSharedPipelineLocalId } from '@canopy/desktop-shared/pipelines/shared-pipeline-id';
import type {
  ResourceContextInput,
  InstallReceipt,
} from '@canopy/execution-engine/lib/resource-context-policy';
import { getResourceContextPolicyService } from '../services/resource-context-policy-service';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { createHash } from 'node:crypto';
import type { SharedPipelineDetail } from '@canopy/execution-engine/types/pipeline';
import { classifyResourceOwner } from '@canopy/execution-engine/lib/resource-context';
import { createResourceInstallReceiptsStore } from '../lib/resource-install-receipts';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';
import {
  assertPipelineContext,
  assertPipelineContextSnapshot,
  pipelineContextSnapshot,
  pipelineResourceContextEnabled,
} from './resource-lanes';
import {
  getSharedPipeline,
  getSharedPipelineForExecutionContext,
} from './canopy-server-client';
import { classifyInstalledResourceOrigin } from '../lib/resource-install-context';

export async function readStoredPipelineContext(
  localId: string,
  executionContext?: string,
): Promise<ResourceContextInput['resource']> {
  if (localId.startsWith('project--'))
    throw new Error('Workflow unavailable (unknown-provenance)');
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  const binding = await createResourceInstallReceiptsStore(
    accountId ?? 'signed-out',
  ).findLocal('pipelines', localId);
  if (!binding) {
    return { owner: { type: 'user', id: accountId ?? 'local', name: null } };
  }
  if (!accountId || binding.accountId !== accountId) {
    throw new Error('Workflow unavailable (access-removed)');
  }
  // An install receipt is provenance, never a grant: reauthorize the remote id.
  const detail = await (executionContext !== undefined
    ? getSharedPipelineForExecutionContext(binding.receipt.remoteId)
    : getSharedPipeline(binding.receipt.remoteId));
  return { owner: detail.owner, provenance: binding.receipt };
}

export async function assertStoredPipelineContext(
  localId: string,
  projectId?: string,
  executionContext?: string,
): Promise<void> {
  if (!pipelineResourceContextEnabled()) return;
  await assertPipelineContext(
    await readStoredPipelineContext(localId, executionContext),
    projectId,
    executionContext,
  );
}

async function assertPipelineInstallAccount(
  snapshot: string,
  accountId: string,
): Promise<void> {
  const account = await readCanopyCloudAccountWithStatus();
  try {
    await assertPipelineContextSnapshot(snapshot);
  } catch {
    throw new Error('Workflow unavailable (access-removed)');
  }
  if (account.status !== 'ok' || account.entry?.account?.id !== accountId)
    throw new Error('Workflow unavailable (access-removed)');
}

/** A receipt about to be recorded, for an install's intent record. */
export interface PipelineInstallReceiptEffect {
  accountId: string;
  receipt: InstallReceipt;
  previous: InstallReceipt | undefined;
}

export async function recordSharedPipelineInstall(
  detail: SharedPipelineDetail,
  localId: string,
  onRollback?: (undo: () => Promise<void>) => void,
  beforeRecord?: (effect: PipelineInstallReceiptEffect) => Promise<void>,
): Promise<void> {
  if (!pipelineResourceContextEnabled()) return;
  const snapshot = await pipelineContextSnapshot();
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  if (!accountId) throw new Error('Workflow unavailable (access-removed)');
  await recordSharedPipelineInstallInContext(
    detail,
    localId,
    snapshot,
    accountId,
    onRollback,
    beforeRecord,
  );
}

async function recordSharedPipelineInstallInContext(
  detail: SharedPipelineDetail,
  localId: string,
  snapshot: string,
  accountId: string,
  onRollback?: (undo: () => Promise<void>) => void,
  beforeRecord?: (effect: PipelineInstallReceiptEffect) => Promise<void>,
): Promise<void> {
  await assertPipelineContext({ owner: detail.owner });
  const owner = classifyResourceOwner(detail.owner, { strict: true });
  if (owner === 'unknown')
    throw new Error('Workflow unavailable (unknown-provenance)');
  const store = createResourceInstallReceiptsStore(accountId);
  const receipt: InstallReceipt = {
    family: 'pipelines',
    remoteId: detail.id,
    localResourceIds: [localId],
    shareScope: detail.shareScope ?? 'private',
    ownerContext:
      typeof owner === 'object'
        ? { kind: 'organization', organizationId: owner.organizationId }
        : { kind: 'personal' },
    hash: createHash('sha256').update(detail.rawPipeline).digest('hex'),
    authorizedAt: new Date().toISOString(),
  };
  const previous =
    onRollback || beforeRecord
      ? await store.find('pipelines', detail.id)
      : undefined;
  await assertPipelineInstallAccount(snapshot, accountId);
  await beforeRecord?.({ accountId, receipt, previous });
  if (onRollback) onRollback(() => store.rollbackInstall(receipt, previous));
  await store.record(receipt);
}

export async function copyPipelineInstallOrigin(
  source: string,
  destination: string,
  onRollback?: (undo: () => Promise<void>) => void,
): Promise<void> {
  if (!pipelineResourceContextEnabled()) return;
  const snapshot = await pipelineContextSnapshot();
  const account = await readCanopyCloudAccountWithStatus();
  const id = account.status === 'ok' ? account.entry?.account?.id : undefined;
  const shared = parseSharedPipelineLocalId(source);
  if (shared) {
    if (!id) throw new Error('Workflow unavailable (access-removed)');
    const detail = await getSharedPipeline(shared.remoteId);
    await recordSharedPipelineInstallInContext(
      detail,
      destination,
      snapshot,
      id,
      onRollback,
    );
    return;
  }
  await assertStoredPipelineContext(source);
  if (!id) return;
  const store = createResourceInstallReceiptsStore(id);
  const binding = await store.findLocal('pipelines', source);
  if (binding) {
    const receipt = { ...binding.receipt, localResourceIds: [destination] };
    await assertPipelineInstallAccount(snapshot, id);
    if (onRollback)
      onRollback(() => store.rollbackInstall(receipt, binding.receipt));
    await store.record(receipt);
  }
}

export async function filterStoredPipelineContexts<T extends { id: string }>(
  rows: T[],
  projectId?: string,
): Promise<T[]> {
  if (!pipelineResourceContextEnabled()) return rows;
  const snapshot = await pipelineContextSnapshot();
  const allowed = await Promise.all(
    rows.map(async (row): Promise<boolean> => {
      try {
        await assertStoredPipelineContext(row.id, projectId);
        return true;
      } catch {
        return false;
      }
    }),
  );
  await assertPipelineContextSnapshot(snapshot);
  return rows.filter((_row, index) => allowed[index]);
}

/** Context-independent Personal inventory used by desktop cloud sync. */
export async function filterPersonalStoredPipelines<T extends { id: string }>(
  rows: T[],
): Promise<T[]> {
  const origins = await Promise.all(
    rows.map((row) => classifyInstalledResourceOrigin('pipelines', row.id)),
  );
  return rows.filter((_row, index) => origins[index] !== 'excluded');
}

/** An organization-origin copy must not be republished as a portable private copy. */
export async function assertPipelineShareOrigin(
  localId: string,
  destinationOwner: unknown,
): Promise<void> {
  if (!pipelineResourceContextEnabled()) return;
  if (localId.startsWith('project--'))
    throw new Error('Workflow unavailable (unknown-provenance)');
  const shared = parseSharedPipelineLocalId(localId);
  let resource: ResourceContextInput['resource'];
  if (shared) {
    const detail = await getSharedPipeline(shared.remoteId);
    if (
      typeof classifyResourceOwner(detail.owner, { strict: true }) !== 'object'
    )
      return;
    resource = { owner: detail.owner };
  } else {
    const account = await readCanopyCloudAccountWithStatus();
    const accountId =
      account.status === 'ok' ? account.entry?.account?.id : undefined;
    const binding = await createResourceInstallReceiptsStore(
      accountId ?? 'signed-out',
    ).findLocal('pipelines', localId);
    if (binding?.receipt.ownerContext.kind !== 'organization') return;
    resource = { owner: { type: 'system' }, provenance: binding.receipt };
  }
  const owner = classifyResourceOwner(destinationOwner, { strict: true });
  const decision = await getResourceContextPolicyService().decide({
    resource,
    invocation: {
      mode: 'foreground',
      context: getWorkspaceContextService().getState().context,
    },
    target: {
      workspaceOwner:
        typeof owner === 'object'
          ? { kind: 'organization', organizationId: owner.organizationId }
          : { kind: 'personal' },
    },
  });
  if (!decision.allow)
    throw new Error(`Workflow unavailable (${decision.reason})`);
}

async function readSystemPipelineShareSource(
  source: 'bundled' | 'curated',
  id: string,
): Promise<string> {
  if (source === 'curated') {
    const pipeline = await getManagedCuratedPipeline(id);
    if (!pipeline.info.filePath)
      throw new Error('Workflow unavailable (unknown-provenance)');
    return readFile(pipeline.info.filePath, 'utf8');
  }
  const stored = getStoredPipelineBySource('bundled', id);
  if (!stored.success || !stored.data?.rawContent)
    throw new Error('Workflow unavailable (unknown-provenance)');
  return stored.data.rawContent;
}

/** Main-owned source lookup: caller YAML never overrides an existing definition. */
export async function readPipelineShareSource(
  source: PipelineShareSource | string,
): Promise<string> {
  if (typeof source !== 'string' && source.kind === 'project') {
    validateId(source.projectId, 'projectId');
    validateId(source.worktreeId, 'worktreeId');
    validateOptionalRepoId(source.repoId, 'repoId');
    // Defer the worktree resolver's heavy workspace-persistence/Portal graph.
    const { resolveWorktreeCwd } = await import('../lib/resolve-worktree');
    const cwd = resolveWorktreeCwd(
      source.projectId,
      source.worktreeId,
      source.repoId,
    );
    if (pipelineResourceContextEnabled()) {
      const resolved = await authorizeProjectPipelineRequest({
        id: 'project--share',
        cwd,
        filePath: source.pipelineFilePath,
      });
      if (resolved.projectId !== source.projectId)
        throw new Error('Workflow unavailable (unknown-provenance)');
    }
    const file = path.resolve(source.pipelineFilePath);
    const root = getProjectPipelinesDirCandidates(cwd).find((candidate) =>
      isPathInside(candidate, file),
    );
    if (
      !path.isAbsolute(source.pipelineFilePath) ||
      !root ||
      !['.yaml', '.yml'].includes(path.extname(file).toLowerCase())
    )
      throw new Error('Workflow unavailable (unknown-provenance)');
    const [realCwd, realRoot, realFile] = await Promise.all([
      realpath(cwd),
      realpath(root),
      realpath(file),
    ]);
    if (!isPathInside(realCwd, realRoot) || !isPathInside(realRoot, realFile))
      throw new Error('Workflow unavailable (unknown-provenance)');
    return readFile(realFile, 'utf8');
  }
  if (
    typeof source !== 'string' &&
    (source.source === 'bundled' || source.source === 'curated')
  )
    return readSystemPipelineShareSource(source.source, source.id);
  const localId = typeof source === 'string' ? source : source.id;
  if (localId.startsWith('project--'))
    throw new Error('Workflow unavailable (unknown-provenance)');
  const shared = parseSharedPipelineLocalId(localId);
  if (!shared) validateId(localId, 'sourcePipelineId');
  if (shared) return (await getSharedPipeline(shared.remoteId)).rawPipeline;
  const stored = getPipelineText(localId);
  if (!stored.success || !stored.data)
    throw new Error('Workflow unavailable (unknown-provenance)');
  return stored.data;
}

/** Shared trusted owner lookup for project-file dispatch and share locators. */
export async function readProjectPipelineOwner(
  projectId: string | undefined,
): Promise<{ type: 'organization' | 'user'; id: string; name: null }> {
  if (!projectId) throw new Error('Workflow unavailable (unknown-provenance)');
  validateId(projectId, 'projectId');
  // Defer workspace persistence's heavy Portal graph, which reaches pipeline handlers.
  const { readWorkspaceConfigDetailed } =
    await import('../lib/workspace-persistence');
  const { config, authority, ownerMalformed } =
    await readWorkspaceConfigDetailed(projectId);
  if (authority !== 'ok' || ownerMalformed)
    throw new Error('Workflow unavailable (unknown-provenance)');
  return config.owner?.type === 'organization'
    ? { type: 'organization', id: config.owner.organizationId, name: null }
    : { type: 'user', id: 'local', name: null };
}

export async function assertPipelineShareSourceContext(
  source: PipelineShareSource,
  destinationOwner?: unknown,
): Promise<void> {
  if (source.kind === 'stored') {
    if (source.source === 'bundled' || source.source === 'curated') {
      await readSystemPipelineShareSource(source.source, source.id);
      await assertPipelineContext({ owner: { type: 'system' } });
      return;
    }
    if (!parseSharedPipelineLocalId(source.id))
      validateId(source.id, 'sourcePipelineId');
    if (source.id.startsWith('project--'))
      throw new Error('Workflow unavailable (unknown-provenance)');
    await assertStoredPipelineContext(source.id);
    if (destinationOwner !== undefined)
      await assertPipelineShareOrigin(source.id, destinationOwner);
    return;
  }
  validateId(source.projectId, 'projectId');
  validateId(source.worktreeId, 'worktreeId');
  validateOptionalRepoId(source.repoId, 'repoId');
  // Defer the worktree resolver's workspace-persistence/Portal graph.
  const { resolveWorktreeCwd } = await import('../lib/resolve-worktree');
  const { owner, projectId } = await authorizeProjectPipelineRequest({
    id: 'project--share',
    cwd: resolveWorktreeCwd(source.projectId, source.worktreeId, source.repoId),
    filePath: source.pipelineFilePath,
  });
  if (projectId !== source.projectId)
    throw new Error('Workflow unavailable (unknown-provenance)');
  if (owner.type === 'organization' && destinationOwner !== undefined) {
    const destination = classifyResourceOwner(destinationOwner, {
      strict: true,
    });
    if (
      typeof destination !== 'object' ||
      destination.organizationId !== owner.id
    )
      throw new Error('Workflow unavailable (context-mismatch)');
  }
}

export async function assertNewPipelineShareContent(
  rawPipeline: string,
  destinationOwner?: unknown,
): Promise<void> {
  if (!pipelineResourceContextEnabled()) return;
  const account = await readCanopyCloudAccountWithStatus();
  const id = account.status === 'ok' ? account.entry?.account?.id : undefined;
  const hash = createHash('sha256').update(rawPipeline).digest('hex');
  const organizationIds = await createResourceInstallReceiptsStore(
    id ?? 'signed-out',
  ).listOrganizationContentOwners('pipelines', hash);
  if (organizationIds.length > 0) {
    const destination = classifyResourceOwner(destinationOwner, {
      strict: true,
    });
    if (
      typeof destination !== 'object' ||
      organizationIds.some(
        (organizationId) => organizationId !== destination.organizationId,
      )
    ) {
      throw new Error('Workflow unavailable (context-mismatch)');
    }
  }
  const stored = listPipelines();
  if (!stored.success || !stored.data)
    throw new Error('Workflow unavailable (unknown-provenance)');
  const pipeline = parsePipelineText(rawPipeline);
  // A changed serialization is not evidence of authorship. Existing definitions
  // must be shared through a trusted locator, including Advisor snapshots.
  if (
    stored.data.some(
      (row) =>
        row.name === pipeline.name ||
        ('id' in pipeline && row.id === pipeline.id),
    )
  )
    throw new Error('Workflow unavailable (context-mismatch)');
  // Catalog names and receipt hashes may predate edits. Compare the current
  // stored bytes too before treating source-less content as a new definition.
  for (const row of stored.data) {
    const content = await readPipelineShareSource({
      kind: 'stored',
      id: row.id,
      ...(row.source === 'bundled' || row.source === 'curated'
        ? { source: row.source }
        : {}),
    });
    if (content === rawPipeline)
      throw new Error('Workflow unavailable (context-mismatch)');
  }
  // Project files have no install receipt or stored-catalog row. Search every
  // host-known project root, including secondary repositories and worktrees.
  // Defer the sidebar's workspace-persistence/Portal graph until this check.
  const { readAllSidebarItems } = await import('../lib/sidebar-items');
  const roots = new Set<string>();
  for (const item of (await readAllSidebarItems()).items) {
    for (const root of await projectPipelineRoots(item)) roots.add(root);
  }
  for (const root of Array.from(roots)) {
    for (const row of await discoverProjectPipelines(root)) {
      if (
        row.name === pipeline.name ||
        ('id' in pipeline && row.id === pipeline.id)
      )
        throw new Error('Workflow unavailable (context-mismatch)');
      if (
        row.filePath &&
        (await readFile(row.filePath, 'utf8')) === rawPipeline
      )
        throw new Error('Workflow unavailable (context-mismatch)');
    }
  }
}

async function projectPipelineRoots(item: SidebarItem): Promise<string[]> {
  // Defer the resolver's workspace-persistence/Portal graph until project lookup.
  const { resolveWorktreeCwd } = await import('../lib/resolve-worktree');
  const roots: string[] = [];
  if (item.type === 'cowork') roots.push(getCoworkWorkspaceRootDir(item.id));
  if (item.externalPath) roots.push(item.externalPath);
  if (item.type === 'single-repo') roots.push(item.repoPath);
  if (item.type === 'multi-repo') {
    if (item.sourceRepoPath) roots.push(item.sourceRepoPath);
    roots.push(...item.repos.map((repo) => repo.repoPath));
  }
  if (item.type !== 'cowork') {
    for (const worktree of item.worktrees) {
      roots.push(resolveWorktreeCwd(item.id, worktree.id));
      if (item.type === 'multi-repo')
        roots.push(
          ...item.repos.map((repo) =>
            resolveWorktreeCwd(item.id, worktree.id, repo.id),
          ),
        );
    }
  }
  return roots;
}

export async function authorizeProjectPipelineRequest(
  request: ProjectPipelineRequest,
  executionContext?: string,
): Promise<{
  projectId: string;
  owner: Awaited<ReturnType<typeof readProjectPipelineOwner>>;
}> {
  // Defer the sidebar's heavy workspace-persistence/Portal graph until project lookup.
  const { readAllSidebarItems } = await import('../lib/sidebar-items');
  const cwd = await realpath(request.cwd).catch(() => undefined);
  if (!cwd) throw new Error('Workflow unavailable (unknown-provenance)');
  const file = await realpath(request.filePath).catch(() => undefined);
  if (!file || !isPathInside(cwd, file))
    throw new Error('Workflow unavailable (unsupported-target)');
  const projectIds = new Set<string>();
  for (const item of (await readAllSidebarItems()).items) {
    const roots = await projectPipelineRoots(item);
    for (const root of roots) {
      if ((await realpath(root).catch(() => undefined)) === cwd) {
        projectIds.add(item.id);
        break;
      }
    }
  }
  if (projectIds.size !== 1)
    throw new Error('Workflow unavailable (unknown-provenance)');
  const projectId = Array.from(projectIds)[0];
  if (!projectId) throw new Error('Workflow unavailable (unknown-provenance)');
  const owner = await readProjectPipelineOwner(projectId);
  try {
    await assertPipelineContext({ owner }, undefined, executionContext);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Workflow unavailable (unsupported-target)'
    )
      throw new Error('Workflow unavailable (context-mismatch)');
    throw error;
  }
  return { projectId, owner };
}

/**
 * Whether the selected owner may see project `projectId`'s pipelines,
 * decided from the project's saved owner alone, before any checkout is read
 * (CAN-965): the context check {@link authorizeProjectPipelineRequest} makes
 * for each file. It reads only the project's own config, never the sidebar
 * projection, so it changes nothing. Always true without resource contexts.
 */
export async function projectPipelinesVisible(
  projectId: string,
  executionContext?: string,
): Promise<boolean> {
  if (!pipelineResourceContextEnabled()) return true;
  try {
    const owner = await readProjectPipelineOwner(projectId);
    await assertPipelineContext({ owner }, undefined, executionContext);
    return true;
  } catch {
    return false;
  }
}

/** Discovery must not disclose project metadata before owner authorization. */
export async function filterProjectPipelineContexts<
  T extends { id: string; filePath?: string },
>(
  rows: T[],
  cwd: string,
  projectId?: string,
  executionContext?: string,
): Promise<T[]> {
  if (!pipelineResourceContextEnabled()) return rows;
  const allowed = await Promise.all(
    rows.map(async (row): Promise<boolean> => {
      if (!row.filePath) return false;
      try {
        const resolved = await authorizeProjectPipelineRequest(
          {
            id: row.id,
            cwd,
            filePath: row.filePath,
          },
          executionContext,
        );
        return projectId === undefined || resolved.projectId === projectId;
      } catch {
        return false;
      }
    }),
  );
  return rows.filter((_row, index) => allowed[index]);
}

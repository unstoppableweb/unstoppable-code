import { lstat, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import {
  assertOrganizationPipelineAllowed,
  organizationPipelinesSwitchedOff,
} from '../organization-capabilities/pipeline-gate';
import {
  createPipelineDefinitionService,
  PipelineDefinitionSourceError,
  type PipelineDefinitionService,
  type PipelineDefinitionSourceContext,
  type PipelineDefinitionSourceDocument,
  type PipelineDefinitionSourceEntry,
  type PipelineDefinitionCopy,
  type PipelineDefinitionInstall,
  type PipelineDefinitionRemote,
  type PipelineDefinitionRemoteReader,
  type PipelineDefinitionSourcePort,
  type PipelineDefinitionWritePort,
} from '@canopy/core-runtime/node/pipeline';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  type CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import {
  buildSharedPipelineId,
  isAddressableSharedPipelineRemoteId,
  parseSharedPipelineLocalId,
  type SharedPipelineDetail,
  type SharedPipelineSummary,
} from '@canopy/protocol/pipelines';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import { validateId } from '../lib/validation';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import { hashPipelinePackageYaml } from '@canopy/desktop-shared/node';
import {
  createStoredPipelineDefinitionPort,
  createStoredPipelineDefinitionWriter,
  localPipelineNormalizeOptions,
} from '@canopy/desktop-shared/node/pipelines/definition-sources';
import { backgroundExecutionDeniedMessage } from '@canopy/execution-engine/lib/automation-context-copy';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { inspectStoredPipelineDocument } from '@canopy/execution-engine/pipelines/store';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isPathInside } from '../lib/path-safety';
import { readPreferencesFile } from '../lib/preferences-store';
import { notifyDesktopInventoryChanged } from '../services/desktop-inventory-sync-signals';
import { recordSharedItemLocalUninstall } from '../canopy-cloud/shared-item-subscriptions';
import {
  assertCanopyCloudCapability,
  CanopyCloudClientError,
} from '../canopy-cloud/client';
import {
  getSharedPipeline,
  getSharedPipelineForExecutionContext,
  listSharedPipelines,
} from './canopy-server-client';
import {
  assertStoredPipelineContext,
  copyPipelineInstallOrigin,
  filterProjectPipelineContexts,
  projectPipelinesVisible,
  recordSharedPipelineInstall,
  filterStoredPipelineContexts,
  readProjectPipelineOwner,
} from './pipeline-install-context';
import {
  beginPipelineInstallIntent,
  isPipelineDefinitionClaimed,
  PipelineInstallCleanupPendingError,
  whenPipelineDefinitionRecovered,
} from './pipeline-install-intents';
import {
  deleteUserPipelineLocalMetadata,
  isPipelineLocalMetadataReadable,
  readPipelineLocalMetadata,
  takeRequiredUserPipelineMarkerWrite,
} from './pipeline-local-metadata-store';
import {
  copyPackageInstall,
  dropPackageInstallInBackground,
  listPackageInstalls,
  readPublicPipelineShareRemote,
  removePackageInstall,
} from './pipeline-package-service';
import {
  getUserPipelineOwner,
  isLocalUserPipeline,
  selectedOwnerContext,
  validatePipelineOwnerTargetsOnSave,
} from './pipeline-owner-policy';
import * as localPipelines from './pipeline-service';
import { deletePipelinePluginCollectionPreferences } from '@canopy/execution-engine/node/pipelines/plugin-collection-store';
import {
  discoverProjectPipelines,
  readProjectPipelinesWithinBounds,
  UNATTENDED_PROJECT_DISCOVERY_LIMITS,
} from './project-pipeline-discovery';
import { recordPipelineEnabled } from './pipeline-enablement-commit';
import {
  sharedProjectDiscovery,
  type ContainedProjectPipeline,
} from './shared-project-discovery';
import {
  presentedPipeline,
  presentPipeline,
  presentSourceFailure,
} from './pipeline-definition-presentation';
import {
  assertPipelineContext,
  isPipelineContextDenial,
  pipelineResourceContextEnabled,
} from './resource-lanes';
import { noteDefinitionRemoved } from './removed-definitions';

function isoTimestamp(value: string | undefined): string | null {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function infoEntry(
  info: PipelineInfo,
  source: PipelineDefinitionSourceEntry['source'],
): PipelineDefinitionSourceEntry {
  return {
    source,
    definitionId: info.id,
    name: info.name,
    description: info.description ?? '',
    icon: info.icon ?? '',
    readonly: info.readonly,
    revision: 0,
    owner: null,
    createdAt: isoTimestamp(info.createdAt),
    updatedAt: isoTimestamp(info.updatedAt),
    ...(info.triggerTypes ? { triggerTypes: info.triggerTypes } : {}),
    ...(info.scopes ? { executionScopes: info.scopes } : {}),
    ...(info.curatedContentHash
      ? { checksum: `sha256:${info.curatedContentHash}` }
      : {}),
  };
}

function storedOwner(definitionId: string): string | null {
  if (!isPipelineLocalMetadataReadable()) {
    // Without organization contexts every definition is Personal and its
    // saved owner is never read, so an unreadable store hides nothing.
    if (!pipelineResourceContextEnabled()) return null;
    // With them, never show an unreadable owner as none.
    throw new PipelineDefinitionSourceError(
      'core.pipeline.contextMismatch',
      backgroundExecutionDeniedMessage('unknown-provenance'),
    );
  }
  return (
    readPipelineLocalMetadata({
      type: 'stored',
      source: 'user',
      value: definitionId,
    }).owner ?? null
  );
}

/**
 * An owner-scoped read authorizes the definition against the run owner, as
 * the run start path does, and keeps a refusal's message.
 */
async function assertOwnerContext(assert: () => Promise<void>): Promise<void> {
  try {
    await assert();
  } catch (error) {
    if (isPipelineContextDenial(error))
      throw new PipelineDefinitionSourceError(
        'core.pipeline.contextMismatch',
        error.message,
        error,
      );
    throw error;
  }
}

/** The local store, with each user definition's saved owner and context. */
function storedPort(): PipelineDefinitionSourcePort {
  const store = createStoredPipelineDefinitionPort({ owner: storedOwner });
  return {
    sources: store.sources,
    list: async (
      context,
    ): Promise<readonly PipelineDefinitionSourceEntry[]> => {
      // While saved owners cannot be read, a listing leaves out the user
      // definitions it cannot attribute rather than failing the bundled ones.
      const entries = await store.list(
        pipelineResourceContextEnabled() && !isPipelineLocalMetadataReadable()
          ? {
              ...context,
              sources: context.sources.filter((source) => source !== 'user'),
            }
          : context,
      );
      const visible = new Set(
        (
          await filterStoredPipelineContexts(
            entries.map((entry) => ({ id: entry.definitionId })),
            context.scope.workspaceId,
          )
        ).map((row) => row.id),
      );
      return entries.filter((entry) => visible.has(entry.definitionId));
    },
    read: async (
      source,
      definitionId,
      context,
    ): Promise<PipelineDefinitionSourceDocument | null> => {
      const document = await store.read(source, definitionId, context);
      if (!document) return null;
      if (context.owner !== undefined) {
        await assertOwnerContext(() =>
          assertStoredPipelineContext(
            definitionId,
            context.scope.workspaceId,
            context.owner,
          ),
        );
        return document;
      }
      const [visible] = await filterStoredPipelineContexts(
        [{ id: definitionId }],
        context.scope.workspaceId,
      );
      if (!visible)
        throw new PipelineDefinitionSourceError(
          'core.pipeline.contextMismatch',
          'Workflow unavailable (context-mismatch)',
        );
      return document;
    },
  };
}

/**
 * The checkout a project scope names: the worktree root, or a multi-repo
 * workspace's member repository when `repoId` names one (CAN-5991).
 */
async function projectCheckout(scope: CanopyWorkspaceScope): Promise<string> {
  if (!scope.workspaceId || !scope.worktreeId)
    throw new PipelineDefinitionSourceError(
      'core.pipeline.scopeInvalid',
      'A project workflow needs a workspace and worktree scope.',
    );
  const member =
    scope.repoId !== undefined && scope.repoId !== WORKSPACE_ROOT_REPO_ID
      ? scope.repoId
      : undefined;
  const [
    { isCoworkWorkspace },
    { resolveRegisteredChatWorktree, resolveWorktreeCwd },
  ] = await Promise.all([
    import('../lib/workspace-registry'),
    import('../lib/resolve-worktree'),
  ]);
  // A registered chat scope (plan-explore, code review) reads the worktree
  // it borrows, as the agent tools resolved it (CAN-5991).
  let workspaceId: string;
  let worktreeId: string;
  try {
    ({ projectId: workspaceId, worktreeId } = resolveRegisteredChatWorktree(
      scope.workspaceId,
      scope.worktreeId,
    ));
  } catch (error) {
    throw new PipelineDefinitionSourceError(
      'core.pipeline.scopeInvalid',
      'The workflow scope names an unresolvable chat worktree.',
      error,
    );
  }
  // A Cowork project has no worktrees: its root is the managed home or the
  // attached folder, resolved as the agent tools resolved it (CAN-5991).
  if (isCoworkWorkspace(workspaceId) && member === undefined) {
    try {
      return resolveWorktreeCwd(workspaceId, worktreeId);
    } catch (error) {
      throw new PipelineDefinitionSourceError(
        'core.pipeline.scopeInvalid',
        'The workflow scope names an unknown Cowork project.',
        error,
      );
    }
  }
  const { getWorktreeDir, getWorkspaceWorktreeRootRepoDir } =
    await import('../lib/paths');
  const { readAllSidebarItems } = await import('../lib/sidebar-items');
  const item = (await readAllSidebarItems()).items.find(
    (candidate) => candidate.id === workspaceId,
  );
  const worktrees = item && 'worktrees' in item ? item.worktrees : [];
  if (!item || !worktrees.some((worktree) => worktree.id === worktreeId))
    throw new PipelineDefinitionSourceError(
      'core.pipeline.scopeInvalid',
      'The workflow scope names an unknown worktree.',
    );
  if (member === undefined)
    return item.type === 'single-repo'
      ? getWorktreeDir(workspaceId, worktreeId)
      : getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId);
  if (item.type === 'single-repo')
    throw new PipelineDefinitionSourceError(
      'core.pipeline.scopeInvalid',
      'A single-repository project has no member repositories.',
    );
  try {
    return resolveWorktreeCwd(workspaceId, worktreeId, member);
  } catch (error) {
    throw new PipelineDefinitionSourceError(
      'core.pipeline.scopeInvalid',
      'The workflow scope names an unknown repository.',
      error,
    );
  }
}

function visibleProjectPipelines(
  context: PipelineDefinitionSourceContext,
): Promise<ContainedProjectPipeline[]> {
  return sharedProjectDiscovery(
    JSON.stringify([
      context.scope.workspaceId,
      context.scope.worktreeId,
      context.scope.repoId,
      context.projectDiscovery ?? 'full',
    ]),
    () => discoverVisibleProjectPipelines(context),
  );
}

/**
 * Discovery for a `bounded` listing (CAN-965): the unattended-scan bounds,
 * and a failure when one cuts the scan short, so the listing names the
 * project source unavailable instead of counting part of the checkout. It
 * writes nothing: share links are neither attached nor reconciled.
 */
async function discoverWithinBounds(cwd: string): Promise<PipelineInfo[]> {
  const { pipelines, truncated } = await readProjectPipelinesWithinBounds(
    cwd,
    UNATTENDED_PROJECT_DISCOVERY_LIMITS,
  );
  if (truncated)
    throw new Error(
      'The project workflows exceed the bounds of an unattended read.',
    );
  return pipelines;
}

async function discoverVisibleProjectPipelines(
  context: PipelineDefinitionSourceContext,
): Promise<ContainedProjectPipeline[]> {
  if (context.projectDiscovery === 'bounded')
    return discoverBoundedProjectPipelines(context);
  const cwd = await projectCheckout(context.scope);
  const checkout = await realpath(cwd);
  const discovered = await discoverProjectPipelines(cwd);
  const canonical = await canonicalPathsInCheckout(discovered, checkout);
  const visible = new Set(
    await filterProjectPipelineContexts(
      discovered.filter((_info, index) => canonical[index] !== undefined),
      cwd,
      context.scope.workspaceId,
      context.owner,
    ),
  );
  return discovered.flatMap((info, index) => {
    const canonicalPath = canonical[index];
    return canonicalPath !== undefined && visible.has(info)
      ? [{ info, canonicalPath }]
      : [];
  });
}

/** Discovery follows links; a definition is read only from the checkout. */
function canonicalPathsInCheckout(
  discovered: readonly PipelineInfo[],
  checkout: string,
): Promise<(string | undefined)[]> {
  return Promise.all(
    discovered.map(async (info) => {
      if (!info.filePath) return undefined;
      const file = await realpath(info.filePath).catch(() => undefined);
      return file !== undefined && isPathInside(checkout, file)
        ? file
        : undefined;
    }),
  );
}

/**
 * A `bounded` listing (CAN-965), for a checkout nobody opened. It changes
 * nothing anywhere: visibility comes from the project's saved owner, the
 * checkout from the project's own worktree list (no sidebar projection,
 * whose reads may persist cleanup or prepare checkouts), and discovery
 * neither attaches nor reconciles share links. A project the owner can't
 * see lists nothing and is not read; one over a bound fails, so the source
 * is named unavailable. Visibility is checked again after the reads, and a
 * cancelled request stops before and after them. It reads a worktree root
 * only.
 */
async function discoverBoundedProjectPipelines(
  context: PipelineDefinitionSourceContext,
): Promise<ContainedProjectPipeline[]> {
  const { workspaceId, worktreeId, repoId } = context.scope;
  if (
    !workspaceId ||
    !worktreeId ||
    (repoId !== undefined && repoId !== WORKSPACE_ROOT_REPO_ID)
  )
    throw new PipelineDefinitionSourceError(
      'core.pipeline.scopeInvalid',
      'A bounded project listing needs a workspace and worktree scope and reads the worktree root only.',
    );
  if (!(await projectPipelinesVisible(workspaceId, context.owner))) return [];
  context.signal.throwIfAborted();
  let discovered: PipelineInfo[];
  let checkout: string;
  try {
    const cwd = await boundedProjectCheckout(workspaceId, worktreeId);
    checkout = await realpath(cwd);
    discovered = await discoverWithinBounds(cwd);
  } catch (error) {
    // A cut or failed read is reported only to an owner that can still see
    // the project; one that can't gets the same empty answer as before.
    if (!(await projectPipelinesVisible(workspaceId, context.owner))) return [];
    throw error;
  }
  const canonical = await canonicalPathsInCheckout(discovered, checkout);
  context.signal.throwIfAborted();
  // Checked again after the reads: the selected owner can change while they
  // run, and rows are returned only for the owner that can see them now.
  if (!(await projectPipelinesVisible(workspaceId, context.owner))) return [];
  return discovered.flatMap((info, index) => {
    const canonicalPath = canonical[index];
    return canonicalPath !== undefined ? [{ info, canonicalPath }] : [];
  });
}

/**
 * A code project's worktree root, built from the scope's ids without reading
 * any project or worktree record: interface code reaches no daemon-owned
 * store, and the ids are validated as path-safe. A worktree with no
 * checkout fails to read, so the source is reported unavailable.
 */
async function boundedProjectCheckout(
  workspaceId: string,
  worktreeId: string,
): Promise<string> {
  // Named imports only: `paths` also holds daemon-owned store resolvers.
  const { getWorkspaceType } = await import('../lib/workspace-registry');
  const { getWorktreeDir, getWorkspaceWorktreeRootRepoDir } =
    await import('../lib/paths');
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  const type = getWorkspaceType(workspaceId);
  if (type !== 'single-repo' && type !== 'multi-repo')
    throw new PipelineDefinitionSourceError(
      'core.pipeline.scopeInvalid',
      'A bounded project listing reads a code project worktree only.',
    );
  // The checkout must be this project's own: a worktree directory that is a
  // link (a compatibility link a worktree join leaves behind, say) or that
  // resolves outside the project's worktrees folder may be another
  // workspace's checkout, so it is not read.
  const worktreeDir = getWorktreeDir(workspaceId, worktreeId);
  const checkout =
    type === 'single-repo'
      ? worktreeDir
      : getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId);
  const [linkStats, worktreesRoot, realCheckout] = await Promise.all([
    lstat(worktreeDir),
    realpath(path.dirname(worktreeDir)),
    realpath(checkout),
  ]);
  if (linkStats.isSymbolicLink() || !isPathInside(worktreesRoot, realCheckout))
    throw new PipelineDefinitionSourceError(
      'core.pipeline.scopeInvalid',
      "The worktree's checkout is not inside its project.",
    );
  return checkout;
}

function projectPort(): PipelineDefinitionSourcePort {
  return {
    sources: ['project'],
    // A checkout that cannot be read never hides the local stores.
    optional: true,
    list: async (context) =>
      (await visibleProjectPipelines(context)).map(({ info }) => {
        presentPipeline('listed', 'project', info.id, { kind: 'info', info });
        return infoEntry(info, 'project');
      }),
    read: async (
      _source,
      definitionId,
      context,
    ): Promise<PipelineDefinitionSourceDocument | null> => {
      const found = (await visibleProjectPipelines(context)).find(
        (candidate) => candidate.info.id === definitionId,
      );
      if (!found) return null;
      presentPipeline('read', 'project', definitionId, {
        kind: 'info',
        info: found.info,
      });
      return {
        ...infoEntry(found.info, 'project'),
        format: 'yaml',
        text: await readFile(found.canonicalPath, 'utf8'),
      };
    },
  };
}

function curatedPort(): PipelineDefinitionSourcePort {
  return {
    sources: ['curated'],
    optional: true,
    list: async (): Promise<readonly PipelineDefinitionSourceEntry[]> => {
      const { listManagedCuratedPipelines } =
        await import('./curated-pipeline-catalog');
      const rows = await listManagedCuratedPipelines().catch(
        (error: unknown) => {
          presentSourceFailure('curated', error);
          throw error;
        },
      );
      return rows.map((info) => {
        presentPipeline('listed', 'curated', info.id, { kind: 'info', info });
        return infoEntry({ ...info, readonly: true }, 'curated');
      });
    },
    read: async (
      _source,
      definitionId,
    ): Promise<PipelineDefinitionSourceDocument | null> => {
      const { CuratedPipelineMissingError, readManagedCuratedPipeline } =
        await import('./curated-pipeline-catalog');
      const { data, rawPipeline } = await readManagedCuratedPipeline(
        definitionId,
      ).catch((error: unknown) => {
        throw error instanceof CuratedPipelineMissingError ||
          isCloudNotFound(error)
          ? new PipelineDefinitionSourceError(
              'core.pipeline.definitionNotFound',
              error.message,
              error,
            )
          : error;
      });
      presentPipeline('read', 'curated', definitionId, {
        kind: 'data',
        data,
        ...(data.pipelinePackage
          ? { pipelinePackage: data.pipelinePackage }
          : {}),
      });
      return {
        ...infoEntry({ ...data.info, readonly: true }, 'curated'),
        format: 'yaml',
        text: rawPipeline,
      };
    },
    remote: async (
      _source,
      definitionId,
    ): Promise<PipelineDefinitionRemote> => {
      const { readCuratedPipelineRemote } =
        await import('./curated-pipeline-catalog');
      try {
        return remoteKeepingMessages(
          await readCuratedPipelineRemote(definitionId),
        );
      } catch (error) {
        throw remoteSourceError(error);
      }
    },
  };
}

/**
 * A remote's failure with the message its install callers have always
 * shown: a missing remote is `remoteNotFound`, a resource-context refusal a
 * context mismatch, and anything else an unavailable source.
 */
function remoteSourceError(error: unknown): PipelineDefinitionSourceError {
  if (error instanceof PipelineDefinitionSourceError) return error;
  return new PipelineDefinitionSourceError(
    isCloudNotFound(error)
      ? 'core.pipeline.remoteNotFound'
      : isPipelineContextDenial(error)
        ? 'core.pipeline.contextMismatch'
        : 'core.pipeline.sourceUnavailable',
    errorMessage(error),
    error,
  );
}

function remoteKeepingMessages(
  remote: PipelineDefinitionRemote,
): PipelineDefinitionRemote {
  return {
    document: remote.document,
    remoteVersion: remote.remoteVersion,
    ...(remote.installTarget
      ? {
          installTarget: () =>
            (remote.installTarget?.() ?? Promise.resolve(null)).catch(
              (error: unknown) => {
                throw remoteSourceError(error);
              },
            ),
        }
      : {}),
    ...(remote.packageManifest
      ? {
          packageManifest: () =>
            (remote.packageManifest?.() ?? Promise.resolve(undefined)).catch(
              (error: unknown) => {
                throw remoteSourceError(error);
              },
            ),
        }
      : {}),
    install: (write, context) =>
      remote.install(write, context).catch((error: unknown) => {
        throw remoteSourceError(error);
      }),
  };
}

/**
 * Public shares as a remote core installs from: the share page's reviewed
 * revision, installed with its package, receipt and subscription.
 */
function publicShareRemoteReader(): PipelineDefinitionRemoteReader {
  return {
    source: 'publicShare',
    remote: async (
      definitionId,
      context,
    ): Promise<PipelineDefinitionRemote | null> => {
      let remote: Awaited<ReturnType<typeof readPublicPipelineShareRemote>>;
      try {
        remote = await readPublicPipelineShareRemote(
          definitionId,
          context.expectedRemoteVersion,
        );
      } catch (error) {
        throw remoteSourceError(error);
      }
      if (!remote) return null;
      const share = remote;
      return remoteKeepingMessages({
        document: {
          name: share.name,
          description: share.description,
          icon: share.icon,
          format: 'yaml',
          text: share.rawPipeline,
        },
        remoteVersion: share.remoteVersion,
        installTarget: () => share.installTarget(),
        packageManifest: () => share.packageManifest(),
        install: async (write): Promise<PipelineDefinitionSourceDocument> => {
          const info = await share.install(write);
          return {
            ...infoEntry(info, 'user'),
            revision: info.revision ?? 0,
            format: 'yaml',
            text: write.text,
          };
        },
      });
    },
  };
}

/**
 * Pipelines a capability package carries, as a remote core installs from
 * while an automation's Stage A install runs.
 */
function packagedPipelineRemoteReader(): PipelineDefinitionRemoteReader {
  return {
    source: 'package',
    remote: async (definitionId): Promise<PipelineDefinitionRemote | null> => {
      const { readPackagedPipelineRemote } =
        await import('./automation-pipeline-install');
      let remote: Awaited<ReturnType<typeof readPackagedPipelineRemote>>;
      try {
        remote = await readPackagedPipelineRemote(definitionId);
      } catch (error) {
        throw remoteSourceError(error);
      }
      if (!remote) return null;
      const packaged = remote;
      return remoteKeepingMessages({
        document: {
          name: packaged.name,
          description: packaged.description,
          icon: packaged.icon,
          format: 'yaml',
          text: packaged.rawPipeline,
        },
        remoteVersion: packaged.remoteVersion,
        install: async (write): Promise<PipelineDefinitionSourceDocument> => {
          const info = await packaged.install(write);
          return {
            ...infoEntry(info, 'user'),
            revision: info.revision ?? 0,
            format: 'yaml',
            text: write.text,
          };
        },
      });
    },
  };
}

/**
 * Installs a share as a user pipeline with its provenance, all or nothing:
 * the install receipt, a replaced pipeline's dropped package install and the
 * subscription ledger entry follow the definition, and a failure restores a
 * replaced pipeline or removes a created one before undoing the receipt.
 * Each write is noted in the install's intent record first, so an exit
 * partway is rolled back at startup instead of leaving an unlinked copy.
 */
export async function installSharedPipeline(
  detail: SharedPipelineDetail,
  write: PipelineDefinitionInstall,
): Promise<PipelineInfo> {
  const id = write.definitionId;
  // An existing pipeline keeps its owner; a new one takes the selected one.
  const ownerContext =
    write.replaces && isLocalUserPipeline(id)
      ? await getUserPipelineOwner(id)
      : await selectedOwnerContext();
  const ownerRefusal = await validatePipelineOwnerTargetsOnSave(
    write.pipeline,
    ownerContext,
  );
  if (ownerRefusal !== null)
    throw new PipelineDefinitionSourceError(
      'core.pipeline.contextMismatch',
      ownerRefusal,
    );
  const previous = write.replaces ? localPipelines.getPipeline(id) : undefined;
  const previousRaw = write.replaces
    ? localPipelines.getPipelineText(id)
    : undefined;
  const intent = await beginPipelineInstallIntent('shared');
  let savedDefinition = false;
  let savedId = id;
  let undoReceipt: (() => Promise<void>) | undefined;
  try {
    if (
      write.replaces &&
      (!previous?.success ||
        !previous.data ||
        !previousRaw?.success ||
        !previousRaw.data)
    )
      throw new Error('Workflow unavailable (unknown-provenance)');
    await intent.noteDefinition({
      definitionId: id,
      change: write.replaces ? 'replaced' : 'created',
      contentHash: hashPipelinePackageYaml(write.text),
    });
    savedDefinition = write.replaces;
    const result = localPipelines.savePipeline(
      {
        id,
        name: write.name,
        description: write.description,
        icon: write.icon,
        content: write.pipeline,
        rawContent: write.text,
      },
      write.replaces ? undefined : { id },
    );
    if (!result.success || !result.data)
      throw new Error(result.error ?? 'Failed to save the workflow');
    savedDefinition = true;
    savedId = result.data.id;
    if (result.data.id !== id)
      throw new Error('Pipeline create identity mismatch');
    await recordSharedPipelineInstall(
      detail,
      id,
      (undo) => {
        undoReceipt = undo;
      },
      (effect) => intent.noteReceipt(id, effect),
    );
    if (write.replaces) {
      await intent.noteInstallRecord(id, null);
      await removePackageInstall(id);
    }
    await intent.finish(
      [{ definitionId: result.data.id, revision: result.data.revision }],
      {
        remoteId: detail.id,
        sourceKind: 'shared',
        contentHash: detail.contentHash,
        localId: id,
      },
    );
    notifyDesktopInventoryChanged(['pipelines']);
    return result.data;
  } catch (error) {
    if (error instanceof PipelineInstallCleanupPendingError)
      throw new PipelineDefinitionSourceError(
        'core.pipeline.sourceUnavailable',
        error.message,
        error,
      );
    const failures = [errorMessage(error)];
    try {
      if (savedDefinition) {
        if (previous?.data && previousRaw?.data) {
          const restored = localPipelines.savePipeline({
            ...previous.data.info,
            content: previous.data.content,
            rawContent: previousRaw.data,
          });
          if (!restored.success)
            throw new Error(restored.error ?? 'Failed to restore workflow');
        } else {
          const removed = localPipelines.deletePipeline(savedId);
          if (!removed.success)
            throw new Error(removed.error ?? 'Failed to roll back workflow');
        }
      }
      await undoReceipt?.();
    } catch (rollbackError) {
      failures.push(errorMessage(rollbackError));
    }
    // The intent record undoes what the steps above left; it stays for
    // startup recovery when it cannot. Its failure is news only when the
    // steps above reported none.
    try {
      await intent.rollBack();
    } catch (rollbackError) {
      if (failures.length > 1)
        logMainProcessWarn(
          '[pipelines] Install intent rollback failed',
          rollbackError,
        );
      else failures.push(errorMessage(rollbackError));
    }
    throw new PipelineDefinitionSourceError(
      isPipelineContextDenial(error)
        ? 'core.pipeline.contextMismatch'
        : 'core.pipeline.sourceUnavailable',
      failures.join('; '),
      error,
    );
  }
}

/**
 * A share's display fields as the share landing page installs them: the
 * reviewed document's own, falling back to the share's description.
 */
export function sharedInstallDisplay(detail: SharedPipelineDetail): {
  name: string;
  description: string;
  icon: string;
} {
  try {
    const content = parsePipelineText(detail.rawPipeline);
    return {
      name: content.name,
      description: content.description ?? detail.description,
      icon: content.icon ?? '',
    };
  } catch {
    // Core refuses the document; nothing is installed.
    return { name: detail.name, description: detail.description, icon: '' };
  }
}

function isCloudNotFound(error: unknown): error is CanopyCloudClientError {
  return error instanceof CanopyCloudClientError && error.status === 404;
}

/** A missing share and a resource-context refusal keep their own codes. */
export function sharedPipelineReadError(error: unknown): unknown {
  if (isCloudNotFound(error))
    return new PipelineDefinitionSourceError(
      'core.pipeline.definitionNotFound',
      error.message,
      error,
    );
  if (isPipelineContextDenial(error))
    return new PipelineDefinitionSourceError(
      'core.pipeline.contextMismatch',
      error.message,
      error,
    );
  return error;
}

/** Shares a definition id can address; others could never be read back. */
export function sharedPipelineRows<Row extends { id: string }>(
  rows: readonly Row[],
): Row[] {
  return rows.filter((row) => isAddressableSharedPipelineRemoteId(row.id));
}

/** The definition id of a share, with its account details kept for display. */
function presentSharedPipeline(
  view: 'listed' | 'read',
  pipeline: SharedPipelineSummary,
): string {
  const definitionId = buildSharedPipelineId(
    CANOPY_CLOUD_SERVER_ID,
    pipeline.id,
  );
  presentPipeline(view, 'shared', definitionId, { kind: 'shared', pipeline });
  return definitionId;
}

function sharedPort(): PipelineDefinitionSourcePort {
  return {
    sources: ['shared'],
    optional: true,
    list: async (
      context,
    ): Promise<readonly PipelineDefinitionSourceEntry[]> => {
      let listed: Awaited<ReturnType<typeof listSharedPipelines>>;
      let switchedOff: ReadonlySet<string>;
      try {
        await assertCanopyCloudCapability('pipelines-crud-v1');
        [listed, switchedOff] = await Promise.all([
          listSharedPipelines({
            limit: 100,
            ...(context.query === undefined ? {} : { q: context.query }),
          }),
          // An organization project's switched-off defaults (CAN-6237).
          organizationPipelinesSwitchedOff(context.scope.workspaceId),
        ]);
      } catch (error) {
        presentSourceFailure('shared', error);
        throw error;
      }
      return sharedPipelineRows(listed.data)
        .filter((pipeline) => !switchedOff.has(pipeline.id))
        .map((pipeline) => ({
          source: 'shared',
          definitionId: presentSharedPipeline('listed', pipeline),
          name: pipeline.name,
          description: pipeline.description,
          icon: pipeline.icon,
          readonly: !pipeline.canUpdate,
          revision: 0,
          owner: null,
          createdAt: isoTimestamp(pipeline.createdAt),
          updatedAt: isoTimestamp(pipeline.updatedAt),
          triggerTypes: pipeline.triggerTypes,
          ...(pipeline.scopes ? { executionScopes: pipeline.scopes } : {}),
        }));
    },
    read: async (
      _source,
      definitionId,
      context,
    ): Promise<PipelineDefinitionSourceDocument | null> => {
      const parsed = parseSharedPipelineLocalId(definitionId);
      if (
        !parsed ||
        parsed.serverId !== CANOPY_CLOUD_SERVER_ID ||
        !isAddressableSharedPipelineRemoteId(parsed.remoteId)
      )
        return null;
      await assertCanopyCloudCapability('pipelines-crud-v1');
      let detail: Awaited<ReturnType<typeof getSharedPipeline>>;
      try {
        // A default the organization project switched off is not read for
        // it; answered as a context mismatch below.
        await assertOrganizationPipelineAllowed(
          context.scope.workspaceId,
          parsed.remoteId,
        );
        detail = await (context.owner === undefined
          ? getSharedPipeline(parsed.remoteId)
          : getSharedPipelineForExecutionContext(parsed.remoteId));
        await assertPipelineContext(
          { owner: detail.owner },
          context.scope.workspaceId,
          context.owner,
        );
      } catch (error) {
        throw sharedPipelineReadError(error);
      }
      presentSharedPipeline('read', detail);
      return {
        source: 'shared',
        definitionId,
        name: detail.name,
        description: detail.description,
        icon: detail.icon,
        readonly: !detail.canUpdate,
        revision: 0,
        owner: null,
        createdAt: isoTimestamp(detail.createdAt),
        updatedAt: isoTimestamp(detail.updatedAt),
        format: 'yaml',
        text: detail.rawPipeline,
      };
    },
    remote: async (
      _source,
      definitionId,
    ): Promise<PipelineDefinitionRemote | null> => {
      const parsed = parseSharedPipelineLocalId(definitionId);
      if (
        !parsed ||
        parsed.serverId !== CANOPY_CLOUD_SERVER_ID ||
        !isAddressableSharedPipelineRemoteId(parsed.remoteId)
      )
        return null;
      let detail: SharedPipelineDetail;
      try {
        detail = await getSharedPipeline(parsed.remoteId);
      } catch (error) {
        throw remoteSourceError(error);
      }
      return {
        document: {
          source: 'shared',
          definitionId,
          ...sharedInstallDisplay(detail),
          readonly: !detail.canUpdate,
          revision: 0,
          owner: null,
          createdAt: isoTimestamp(detail.createdAt),
          updatedAt: isoTimestamp(detail.updatedAt),
          format: 'yaml',
          text: detail.rawPipeline,
        },
        remoteVersion: detail.contentHash,
        install: async (write): Promise<PipelineDefinitionSourceDocument> => {
          const info = await installSharedPipeline(detail, write);
          return {
            ...infoEntry(info, 'user'),
            revision: info.revision ?? 0,
            format: 'yaml',
            text: write.text,
          };
        },
      };
    },
  };
}

/** Core pipeline definitions over the desktop's sources. */
export async function assertWritableContext(
  definitionId: string,
): Promise<void> {
  try {
    await assertStoredPipelineContext(definitionId);
  } catch (error) {
    if (isPipelineContextDenial(error))
      throw new PipelineDefinitionSourceError(
        'core.pipeline.contextMismatch',
        error.message,
        error,
      );
    throw error;
  }
}

/** Desktop effects of a saved user definition: an edit drops its stale package install record. */
export function applyUserPipelineSaveEffects(editedId: string | null): void {
  if (editedId !== null) dropPackageInstallInBackground(editedId);
  notifyDesktopInventoryChanged(['pipelines']);
}

/**
 * Desktop effects of a deleted user definition: its plugin collection
 * preferences, local owner metadata, subscription ledger entry and package
 * install go with it.
 */
export async function applyUserPipelineDeleteEffects(
  definitionId: string,
): Promise<void> {
  // CAN-7347: a start that still holds a copy of it is refused.
  noteDefinitionRemoved(definitionId, 'deleted');
  deleteUserPipelineLocalMetadata(definitionId);
  // The subscription ledger names every share this copy came from, even
  // after a local edit dropped its package record.
  recordSharedItemLocalUninstall({ kind: 'pipeline', localId: definitionId });
  dropPackageInstallInBackground(definitionId);
  notifyDesktopInventoryChanged(['pipelines']);
  await deletePipelinePluginCollectionPreferences(
    {
      type: 'stored',
      source: 'user',
      value: definitionId,
    },
    'electron_main',
  );
}

export async function assertPersonalProjectCopy(
  workspaceId: string | undefined,
): Promise<void> {
  let owner: Awaited<ReturnType<typeof readProjectPipelineOwner>>;
  try {
    owner = await readProjectPipelineOwner(workspaceId);
  } catch (error) {
    throw new PipelineDefinitionSourceError(
      'core.pipeline.contextMismatch',
      errorMessage(error),
      error,
    );
  }
  if (owner.type === 'organization')
    throw new PipelineDefinitionSourceError(
      'core.pipeline.contextMismatch',
      'Workflow unavailable (context-mismatch)',
    );
}

/**
 * What the desktop keeps about a copy's origin, keyed by the copy (CAN-7522):
 * a share's install receipt, or the install origin a stored source carries.
 * A project file has none. Recording it again changes nothing; `onRollback`
 * takes its undo.
 */
export async function recordPipelineCopyOrigin(
  origin: PipelineDefinitionCopy['origin'],
  definitionId: string,
  onRollback?: (undo: () => Promise<void>) => void,
): Promise<void> {
  // A share's read already fetched the detail its receipt records.
  const share = presentedPipeline('read', 'shared', origin.definitionId);
  if (
    origin.source === 'shared' &&
    share?.kind === 'shared' &&
    'rawPipeline' in share.pipeline
  )
    await recordSharedPipelineInstall(share.pipeline, definitionId, onRollback);
  else if (origin.source !== 'project')
    await copyPipelineInstallOrigin(
      origin.definitionId,
      definitionId,
      onRollback,
    );
}

/**
 * A copy's source as only this app can read it (CAN-7522): a curated, shared
 * or project definition, through the port that reads it here. `undefined`
 * for a bundled or user source, which the store's own reader reads.
 */
export async function readPipelineCopySource(
  origin: PipelineDefinitionCopy['origin'],
  scope: CanopyWorkspaceScope,
  signal: AbortSignal,
): Promise<
  | Pick<
      PipelineDefinitionSourceDocument,
      'name' | 'description' | 'icon' | 'format' | 'text'
    >
  | undefined
> {
  if (origin.source === 'user' || origin.source === 'bundled') return undefined;
  const port = [projectPort(), curatedPort(), sharedPort()].find((candidate) =>
    candidate.sources.includes(origin.source),
  );
  if (!port)
    throw new PipelineDefinitionSourceError(
      'core.pipeline.sourceUnavailable',
      `This app cannot read ${origin.source} workflows.`,
    );
  const document = await port.read(origin.source, origin.definitionId, {
    scope,
    signal,
    sources: [origin.source],
  });
  if (!document)
    throw new PipelineDefinitionSourceError(
      'core.pipeline.definitionNotFound',
      `Workflow not found: ${origin.definitionId}`,
    );
  const { name, description, icon, format, text } = document;
  return { name, description, icon, format, text };
}

/** The store steps of a copy, so a test can stand in for the store. */
export interface PipelineCopyStore<T> {
  /** Creates the copy under its assigned id. */
  create(): Promise<T>;
  /** The id the store saved the copy under. */
  idOf(created: T): string;
  remove(created: T): Promise<void>;
  /** Refuses a committed copy whose records no longer hold, before it answers. */
  verify?(created: T): Promise<void>;
}

/**
 * Creates a copy with what the desktop keeps about its origin, all or
 * nothing: a share or install receipt follows the copy, and a stored
 * source's package install carries over with the package's own bytes.
 * Everything is recorded before the copy commits, so nothing is written
 * after it: a crash before the commit leaves only records naming an id no
 * store holds, which a resend with the same key completes.
 */
export async function copyPipelineWithProvenance<T>(
  origin: PipelineDefinitionCopy['origin'],
  definitionId: string,
  store: PipelineCopyStore<T>,
): Promise<T> {
  let undoOrigin: (() => Promise<void>) | undefined;
  const onRollback = (undo: () => Promise<void>): void => {
    undoOrigin = undo;
  };
  let created: T | undefined;
  const packaged = origin.source === 'user' || origin.source === 'bundled';
  try {
    await recordPipelineCopyOrigin(origin, definitionId, onRollback);
    if (packaged) await copyPackageInstall(origin.definitionId, definitionId);
    created = await store.create();
    if (store.idOf(created) !== definitionId)
      throw new Error('Pipeline create identity mismatch');
    await store.verify?.(created);
    notifyDesktopInventoryChanged(['pipelines']);
    return created;
  } catch (error) {
    const failures = [errorMessage(error)];
    try {
      if (created !== undefined) await store.remove(created);
      // A write with an unknown outcome can have published the copy.
      if (inspectStoredPipelineDocument(definitionId).kind === 'absent') {
        if (packaged) await removePackageInstall(definitionId);
        await undoOrigin?.();
      }
    } catch (rollbackError) {
      failures.push(errorMessage(rollbackError));
    }
    throw new PipelineDefinitionSourceError(
      isPipelineContextDenial(error)
        ? 'core.pipeline.contextMismatch'
        : error instanceof PipelineDefinitionSourceError
          ? error.code
          : 'core.pipeline.sourceUnavailable',
      failures.join('; '),
      error instanceof PipelineDefinitionSourceError
        ? (error.sourceCause ?? error)
        : error,
    );
  }
}

/**
 * Refuses, for a retry with the same key, a copy of a package-installed
 * source whose install record doesn't pin the bytes it holds. Execution
 * removes a record that doesn't match its document, so one written before
 * the bytes can be gone once they land.
 */
async function assertRecordPinsCopy(
  origin: PipelineDefinitionCopy['origin'],
  definitionId: string,
  text: string,
): Promise<void> {
  const installs = await listPackageInstalls();
  if (
    !installs.some((install) => install.localPipelineId === origin.definitionId)
  )
    return;
  const record = installs.find(
    (install) => install.localPipelineId === definitionId,
  );
  if (record?.pipelineContentHash !== hashPipelinePackageYaml(text))
    throw new PipelineDefinitionSourceError(
      'core.pipeline.sourceUnavailable',
      'The workflow copy lost its package install while it was written.',
    );
}

/**
 * A package-installed source's own bytes, refused once they no longer match
 * the install record that pins them.
 */
function pinnedSourceText(sourceId: string, contentHash: string): string {
  const source = localPipelines.getPipelineText(sourceId);
  if (!source.success || source.data === undefined)
    throw new PipelineDefinitionSourceError(
      'core.pipeline.sourceUnavailable',
      source.error ?? 'Failed to read the source workflow',
    );
  if (hashPipelinePackageYaml(source.data) !== contentHash)
    throw new PipelineDefinitionSourceError(
      'core.pipeline.sourceUnavailable',
      'Source workflow no longer matches its installed package',
    );
  return source.data;
}

/** The document the store keeps for `text`, without a read-only marker. */
function storedDocument(text: string): ReturnType<typeof parsePipelineText> {
  const pipeline = { ...parsePipelineText(text) };
  delete pipeline.readonly;
  return pipeline;
}

/**
 * A copy as it commits: once its package install is recorded, it holds the
 * source's own bytes that the record pins, so one store write completes it.
 */
async function packagedCopy(
  copy: PipelineDefinitionCopy,
): Promise<PipelineDefinitionCopy> {
  if (copy.origin.source !== 'user' && copy.origin.source !== 'bundled')
    return copy;
  const record = (await listPackageInstalls()).find(
    (install) => install.localPipelineId === copy.definitionId,
  );
  if (!record) return copy;
  const text = pinnedSourceText(
    copy.origin.definitionId,
    record.pipelineContentHash,
  );
  return { ...copy, text, pipeline: storedDocument(text) };
}

/**
 * The user store's writer with the desktop effects. The caller records a
 * new definition's owner and agent author, which depend on who wrote it.
 */
export function desktopPipelineDefinitionWriter(): PipelineDefinitionWritePort {
  const store = createStoredPipelineDefinitionWriter({ owner: storedOwner });
  const stored = createStoredPipelineDefinitionPort({ owner: storedOwner });
  const installWriteRefusal =
    "Couldn't save the workflow while its installation is pending.";
  const currentWriter = (): PipelineDefinitionWritePort => {
    const marker = takeRequiredUserPipelineMarkerWrite();
    return marker
      ? createStoredPipelineDefinitionWriter({
          owner: storedOwner,
          prepare: marker.prepare,
          finalize: (saved) =>
            isPipelineDefinitionClaimed(saved.id)
              ? {
                  ok: false,
                  reason: 'finalization_failed',
                  message: installWriteRefusal,
                }
              : marker.finalize(saved),
        })
      : store;
  };
  return {
    copy: async (copy, context): Promise<PipelineDefinitionSourceDocument> => {
      // An organization's project workflow is never copied out as Personal.
      if (copy.origin.source === 'project' && pipelineResourceContextEnabled())
        await assertPersonalProjectCopy(context.scope.workspaceId);
      return copyPipelineWithProvenance(copy.origin, copy.definitionId, {
        create: async () =>
          currentWriter().copy(await packagedCopy(copy), context),
        idOf: (written) => written.definitionId,
        remove: async (written): Promise<void> => {
          await store.delete(written.definitionId, written.revision, context);
          deleteUserPipelineLocalMetadata(written.definitionId);
        },
        verify: (written) =>
          copy.origin.source === 'user' || copy.origin.source === 'bundled'
            ? assertRecordPinsCopy(copy.origin, copy.definitionId, written.text)
            : Promise.resolve(),
      });
    },
    // As copyPipelineWithProvenance stores it: a stored source with a
    // package install gives its copy the source's own bytes.
    copiedText: async (copy): Promise<string> => {
      if (copy.origin.source !== 'user' && copy.origin.source !== 'bundled')
        return copy.text;
      const installed = (await listPackageInstalls()).some(
        (install) => install.localPipelineId === copy.origin.definitionId,
      );
      if (!installed) return copy.text;
      const source = localPipelines.getPipelineText(copy.origin.definitionId);
      if (!source.success || source.data === undefined)
        throw new PipelineDefinitionSourceError(
          'core.pipeline.sourceUnavailable',
          source.error ?? 'Failed to read the source workflow',
        );
      return source.data;
    },
    // An older build committed a copy before its package bytes and install
    // record, so a crash could leave it without either. As a copy is made,
    // the record is written first and the bytes it pins second; the bytes
    // are rewritten through the store, refused if edited since they were
    // read. A copy whose record pins the bytes it holds is complete. When
    // the package moves on after the record is written, the record is taken
    // back, so the copy is left a plain copy whose record never disagrees
    // with its bytes.
    finishCopy: async (copy, context): Promise<void> => {
      if (copy.origin.source !== 'user' && copy.origin.source !== 'bundled')
        return;
      const recordOf = async (
        localPipelineId: string,
      ): Promise<
        Awaited<ReturnType<typeof listPackageInstalls>>[number] | undefined
      > =>
        (await listPackageInstalls()).find(
          (install) => install.localPipelineId === localPipelineId,
        );
      if (!(await recordOf(copy.origin.definitionId))) return;
      const copied = await stored.read('user', copy.definitionId, {
        ...context,
        sources: ['user'],
      });
      if (!copied)
        throw new PipelineDefinitionSourceError(
          'core.pipeline.definitionNotFound',
          `Workflow not found: ${copy.definitionId}`,
        );
      const pinned = await recordOf(copy.definitionId);
      if (pinned?.pipelineContentHash === hashPipelinePackageYaml(copied.text))
        return;
      await copyPackageInstall(copy.origin.definitionId, copy.definitionId);
      const record = await recordOf(copy.definitionId);
      if (!record) {
        if (!(await recordOf(copy.origin.definitionId))) return;
        throw new PipelineDefinitionSourceError(
          'core.pipeline.sourceUnavailable',
          'The workflow copy lost its package install while it was finished.',
        );
      }
      let text: string;
      try {
        text = pinnedSourceText(
          copy.origin.definitionId,
          record.pipelineContentHash,
        );
      } catch (error) {
        const failures = [errorMessage(error)];
        try {
          await removePackageInstall(copy.definitionId);
        } catch (undoError) {
          failures.push(errorMessage(undoError));
        }
        throw new PipelineDefinitionSourceError(
          error instanceof PipelineDefinitionSourceError
            ? error.code
            : 'core.pipeline.sourceUnavailable',
          failures.join('; '),
          error,
        );
      }
      if (copied.text !== text)
        await store.upsert(
          {
            definitionId: copy.definitionId,
            expectedRevision: copied.revision,
            name: copied.name,
            description: copied.description,
            icon: copied.icon,
            text,
            pipeline: storedDocument(text),
          },
          context,
        );
      await assertRecordPinsCopy(copy.origin, copy.definitionId, text);
    },
    upsert: async (
      write,
      context,
    ): Promise<PipelineDefinitionSourceDocument> => {
      const id = write.definitionId;
      if (id !== null) {
        await assertWritableContext(id);
        const recovery = isPipelineDefinitionClaimed(id)
          ? 'installing'
          : await whenPipelineDefinitionRecovered(id);
        if (recovery !== 'ready' && recovery !== 'removed')
          throw new PipelineDefinitionSourceError(
            'core.pipeline.sourceUnavailable',
            installWriteRefusal,
          );
      }
      const written = await currentWriter().upsert(write, context);
      applyUserPipelineSaveEffects(write.definitionId);
      return written;
    },
    revision: (definitionId): Promise<number | null> =>
      store.revision(definitionId),
    delete: async (
      definitionId,
      expectedRevision,
      context,
    ): Promise<number> => {
      await assertWritableContext(definitionId);
      const revision = await store.delete(
        definitionId,
        expectedRevision,
        context,
      );
      await applyUserPipelineDeleteEffects(definitionId);
      return revision;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDesktopPipelineDefinitionService(): PipelineDefinitionService {
  return createPipelineDefinitionService({
    ports: [storedPort(), projectPort(), curatedPort(), sharedPort()],
    remotes: [publicShareRemoteReader(), packagedPipelineRemoteReader()],
    writer: desktopPipelineDefinitionWriter(),
    setDefinitionEnabled: recordPipelineEnabled,
    disabledDefinitionIds: async () =>
      new Set((await readPreferencesFile()).disabledPipelineIds),
    normalizeOptions: localPipelineNormalizeOptions,
    servingTargetIds: [CANOPY_IN_PROCESS_WORKER_TARGET_ID],
  });
}

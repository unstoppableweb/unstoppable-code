import { COLLECTIONS_CHANNELS } from '@canopy/desktop-shared/constants/collection-channels';
import {
  ShareOperationError,
  toShareOperationResult,
  withShareStage,
} from '../sharing/share-operation-result';
import type {
  ApplyCollectionUpdateRequest,
  DuplicateLocalCollectionRequest,
  AnalyzeCollectionCapabilityPackageRequest,
  CommitCollectionCapabilityPackageRequest,
  CollectionConfig,
  CreateSharedCollectionRequest,
  DeleteSharedCollectionRequest,
  InstallCollectionCapabilityPackageRequest,
  ListSharedCollectionsRequest,
  SharedCollectionImportReadiness,
  UpdateSharedCollectionRequest,
  CollectionsAPI,
} from '@canopy/desktop-shared/types/collections';
import { BrowserWindow } from 'electron';
import { assertCanopyCloudCapability } from '../canopy-cloud/client';
import { registerIpcHandler } from '../ipc/register';
import {
  clearCollectionRemoteMetadataByRemoteId,
  deleteCollectionConfig,
  readCollectionConfig,
  readCollectionIndex,
  saveCollectionConfig,
  rollbackNewCollectionInstall,
  writeCollectionRemoteMetadata,
} from './collection-store';
import {
  createSharedCollection,
  deleteSharedCollection,
  getCollectionPackage,
  getCollectionPackageBlob,
  getSharedCollection,
  getPublicCollectionPackage,
  getPublicCollectionPackageBlob,
  publishCollectionPublicShare,
  revokeCollectionPublicShare,
  listSharedCollections,
  updateSharedCollection,
} from './canopy-server-client';
import {
  analyzeSubjectCapabilityPackage,
  cancelPackageAnalysis,
  createSubjectCapabilityPackage,
  evaluatePipelinePackageRequirements,
  probePipelinePackageRequirement,
} from '../pipelines/pipeline-package-service';
import { serializeSharedCollectionForHash } from '@canopy/protocol/collections';
import { installSubjectCapabilityPackage } from '../skills/skill-package-install';
import {
  getMcpServerStatusByCatalogId,
  getMcpServerStatusByName,
} from '../mcp/connection-status';
import type { PipelinePackageEnvironmentRequirement } from '@canopy/protocol/pipelines';
import type { McpServerStatusEntry } from '@canopy/execution-engine/types/mcp-servers';

const COLLECTIONS_CAPABILITY = 'collections-crud-v1';

async function assertCollectionsSupported(): Promise<void> {
  await assertCanopyCloudCapability(COLLECTIONS_CAPABILITY);
}

export async function resolveCollectionMcpRequirements(
  requirements: readonly PipelinePackageEnvironmentRequirement[],
  probes: {
    byCatalogId: (value: string) => Promise<McpServerStatusEntry | null>;
    byName: (value: string) => Promise<McpServerStatusEntry | null>;
  } = {
    byCatalogId: getMcpServerStatusByCatalogId,
    byName: getMcpServerStatusByName,
  },
): Promise<{
  mcpServerRefs: Array<{ serverId: string; configId: string }>;
  unmetRequirements: PipelinePackageEnvironmentRequirement[];
}> {
  const mcpServerRefs = new Map<
    string,
    { serverId: string; configId: string }
  >();
  const unmetRequirements: PipelinePackageEnvironmentRequirement[] = [];
  for (const requirement of requirements) {
    if (requirement.kind !== 'mcp') continue;
    const status =
      (await probes.byCatalogId(requirement.displayName)) ??
      (await probes.byName(requirement.displayName));
    const config = status?.configs[0];
    if (!status || !config) {
      unmetRequirements.push(requirement);
      continue;
    }
    mcpServerRefs.set(`${status.serverId}/${config.configId}`, {
      serverId: status.serverId,
      configId: config.configId,
    });
  }
  return {
    mcpServerRefs: Array.from(mcpServerRefs.values()),
    unmetRequirements,
  };
}

export async function inspectSharedCollectionImport(
  collectionId: string,
  dependencies: {
    getCollection: typeof getSharedCollection;
    probeRequirement: typeof probePipelinePackageRequirement;
  } = {
    getCollection: getSharedCollection,
    probeRequirement: probePipelinePackageRequirement,
  },
): Promise<SharedCollectionImportReadiness> {
  const collection = await dependencies.getCollection(collectionId);
  const readiness = collection.package
    ? await evaluatePipelinePackageRequirements(
        collection.package.environmentRequirements,
        dependencies.probeRequirement,
      )
    : null;
  return { collection, requirements: readiness?.requirements ?? [] };
}

/*
 * The window's collection calls as owners, so App Advisor's collection
 * actions in Electron main make the same ones (CAN-6003).
 */

export async function saveCollectionForCaller(
  collection: Partial<CollectionConfig> & { name: string },
): Promise<Awaited<ReturnType<CollectionsAPI['saveCollection']>>> {
  if (collection.id || !collection.sharedSource)
    return saveCollectionConfig(collection);
  let prepared: CollectionConfig | undefined;
  try {
    return await saveCollectionConfig(collection, (value) => {
      prepared = value;
    });
  } catch (error) {
    if (prepared) {
      try {
        await rollbackNewCollectionInstall(prepared);
      } catch (rollbackError) {
        throw new Error(
          `${error instanceof Error ? error.message : 'Install failed'}; rollback was incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    throw error;
  }
}

export async function listSharedCollectionsForCaller(
  request: ListSharedCollectionsRequest,
): Promise<Awaited<ReturnType<CollectionsAPI['listShared']>>> {
  await assertCollectionsSupported();
  return listSharedCollections(request);
}

export async function getSharedCollectionForCaller(
  collectionId: string,
): Promise<Awaited<ReturnType<CollectionsAPI['getShared']>>> {
  await assertCollectionsSupported();
  return getSharedCollection(collectionId);
}

export function createSharedCollectionForCaller(
  request: CreateSharedCollectionRequest,
): ReturnType<CollectionsAPI['createShared']> {
  return toShareOperationResult(async () => {
    await withShareStage('access', assertCollectionsSupported);
    const detail = await createSharedCollection(request);
    if (request.sourceCollectionId) {
      try {
        const persisted = await writeCollectionRemoteMetadata(
          request.sourceCollectionId,
          {
            accountId: detail.createdBy.id,
            remoteId: detail.id,
            contentHash: detail.contentHash,
            shareScope: detail.shareScope,
            sharedAt: detail.updatedAt,
          },
        );
        if (!persisted) {
          throw new Error('Failed to store Collection share link.');
        }
      } catch {
        await deleteSharedCollection({ collectionId: detail.id });
        // The share was removed again, so nothing stayed published.
        throw new ShareOperationError(
          'unknown',
          'Failed to store Collection share link.',
        );
      }
    }
    return detail;
  });
}

export function updateSharedCollectionForCaller(
  request: UpdateSharedCollectionRequest,
): ReturnType<CollectionsAPI['updateShared']> {
  return toShareOperationResult(async () => {
    await withShareStage('access', assertCollectionsSupported);
    const detail = await updateSharedCollection(request);
    const { sourceCollectionId } = request;
    if (sourceCollectionId) {
      // The update has landed; only storing its local link can fail here.
      await withShareStage('finish', async () => {
        const stored = await writeCollectionRemoteMetadata(sourceCollectionId, {
          accountId: detail.createdBy.id,
          remoteId: detail.id,
          contentHash: detail.contentHash,
          shareScope: detail.shareScope,
          sharedAt: detail.updatedAt,
        });
        if (!stored) {
          throw new Error('Failed to store Collection share link.');
        }
      });
    }
    return detail;
  });
}

export async function deleteSharedCollectionForCaller(
  request: DeleteSharedCollectionRequest,
): Promise<Awaited<ReturnType<CollectionsAPI['deleteShared']>>> {
  await assertCollectionsSupported();
  await deleteSharedCollection(request);
  await clearCollectionRemoteMetadataByRemoteId(request.collectionId);
}

export async function installCollectionPackageForCaller(
  request: InstallCollectionCapabilityPackageRequest,
): Promise<Awaited<ReturnType<CollectionsAPI['installCapabilityPackage']>>> {
  if (
    Boolean(request.localCollectionId) === Boolean(request.createCollection)
  ) {
    throw new Error(
      'Specify an existing collection or a new collection, exclusively.',
    );
  }
  if (
    request.createCollection &&
    (request.createCollection.sharedSource?.remoteId !== request.collectionId ||
      Boolean(request.createCollection.sharedSource.fromPublicShare) !==
        Boolean(request.fromPublicShare))
  )
    throw new Error('Collection install origin does not match the package.');
  const existing = request.localCollectionId
    ? await readCollectionConfig(request.localCollectionId)
    : undefined;
  if (request.localCollectionId && !existing)
    throw new Error('Collection not found');
  const download = request.fromPublicShare
    ? await getPublicCollectionPackage(
        request.collectionId,
        request.packageRef.digest,
      )
    : await getCollectionPackage(
        request.collectionId,
        request.packageRef.digest,
      );
  const { mcpServerRefs, unmetRequirements } =
    await resolveCollectionMcpRequirements(
      download.manifest.environmentRequirements,
    );
  let ownedWrite: CollectionConfig | undefined;
  let ownedInitial: CollectionConfig | undefined;
  try {
    const initial = request.createCollection
      ? await saveCollectionConfig(
          {
            name: request.createCollection.name,
            description: request.createCollection.description,
            sharedSource: request.createCollection.sharedSource,
            skills: [],
            plugins: [],
            mcpServers: [],
          },
          (value) => {
            ownedWrite = value;
          },
        )
      : existing?.collection;
    if (!initial) throw new Error('Collection not found');
    if (request.createCollection) {
      ownedWrite = initial;
      ownedInitial = initial;
    }
    const collection = { collection: initial };
    let savedCollection: CollectionConfig | undefined;
    const installed = await installSubjectCapabilityPackage({
      owner: { kind: 'collection', localId: initial.id },
      originExternalId: request.collectionId,
      packageRef: request.packageRef,
      download,
      fetchBlob: (sha256) =>
        request.fromPublicShare
          ? getPublicCollectionPackageBlob(
              request.collectionId,
              request.packageRef.digest,
              sha256,
            )
          : getCollectionPackageBlob(
              request.collectionId,
              request.packageRef.digest,
              sha256,
            ),
      finalizeInstall: async (result) => {
        const skills = new Map(
          collection.collection.skills.map((skill) => [
            `${skill.sourceId}/${skill.skillName}`,
            skill,
          ]),
        );
        for (const skill of result.installedSkills) {
          skills.set(`custom:app/${skill.localName}`, {
            sourceId: 'custom:app',
            skillName: skill.localName,
          });
        }
        const nextCollection = {
          ...collection.collection,
          skills: Array.from(skills.values()),
          mcpServers: mcpServerRefs,
        };
        savedCollection = request.createCollection
          ? await saveCollectionConfig(nextCollection, (value) => {
              ownedWrite = value;
            })
          : await saveCollectionConfig(nextCollection);
        if (request.createCollection) ownedWrite = savedCollection;
        return undefined;
      },
      rollbackFinalization: async () => {
        if (request.createCollection && ownedWrite) {
          await rollbackNewCollectionInstall(ownedWrite, ownedInitial);
        } else if (savedCollection) {
          await saveCollectionConfig(collection.collection, undefined, {
            expectedRevision: savedCollection.revision,
          });
        }
      },
    });
    if (!savedCollection) {
      throw new Error('Collection package install did not save the Collection');
    }
    return {
      ...installed,
      collection: savedCollection,
      mcpServerRefs,
      unmetRequirements,
    };
  } catch (error) {
    if (request.createCollection && ownedWrite) {
      try {
        await rollbackNewCollectionInstall(ownedWrite, ownedInitial);
      } catch (rollbackError) {
        throw new Error(
          `${error instanceof Error ? error.message : 'Install failed'}; rollback was incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    throw error;
  }
}

export function registerCollectionHandlers(): void {
  registerIpcHandler(
    COLLECTIONS_CHANNELS.DUPLICATE_COLLECTION,
    async (_event, request: DuplicateLocalCollectionRequest) => {
      const { duplicateLocalCollection } =
        await import('./collection-mutations');
      return duplicateLocalCollection(request);
    },
  );
  registerIpcHandler(
    COLLECTIONS_CHANNELS.APPLY_SHARED_UPDATE,
    async (_event, request: ApplyCollectionUpdateRequest) => {
      const { applyCollectionUpdate } = await import('./collection-mutations');
      return applyCollectionUpdate(request);
    },
  );

  registerIpcHandler(COLLECTIONS_CHANNELS.LOAD_INDEX, async () => {
    const index = await readCollectionIndex();
    return index.collections;
  });

  registerIpcHandler(
    COLLECTIONS_CHANNELS.LOAD_COLLECTION,
    async (_event, id: string) =>
      (await readCollectionConfig(id))?.collection ?? null,
  );

  registerIpcHandler(
    COLLECTIONS_CHANNELS.SAVE_COLLECTION,
    (_event, collection: Partial<CollectionConfig> & { name: string }) =>
      saveCollectionForCaller(collection),
  );

  registerIpcHandler(
    COLLECTIONS_CHANNELS.DELETE_COLLECTION,
    async (_event, id: string) => deleteCollectionConfig(id),
  );

  registerIpcHandler(
    COLLECTIONS_CHANNELS.SHARED_LIST,
    (_event, request: ListSharedCollectionsRequest) =>
      listSharedCollectionsForCaller(request),
  );

  registerIpcHandler(
    COLLECTIONS_CHANNELS.SHARED_GET,
    (_event, collectionId: string) =>
      getSharedCollectionForCaller(collectionId),
  );

  registerIpcHandler(
    COLLECTIONS_CHANNELS.SHARED_CREATE,
    (_event, request: CreateSharedCollectionRequest) =>
      createSharedCollectionForCaller(request),
  );

  registerIpcHandler(
    COLLECTIONS_CHANNELS.SHARED_UPDATE,
    (_event, request: UpdateSharedCollectionRequest) =>
      updateSharedCollectionForCaller(request),
  );

  registerIpcHandler(
    COLLECTIONS_CHANNELS.SHARED_DELETE,
    (_event, request: DeleteSharedCollectionRequest) =>
      deleteSharedCollectionForCaller(request),
  );

  registerIpcHandler(
    COLLECTIONS_CHANNELS.SHARED_PUBLIC_PUBLISH,
    async (_event, collectionId: string) => {
      await assertCollectionsSupported();
      return publishCollectionPublicShare(collectionId);
    },
  );

  registerIpcHandler(
    COLLECTIONS_CHANNELS.SHARED_PUBLIC_REVOKE,
    async (_event, collectionId: string) => {
      await assertCollectionsSupported();
      await revokeCollectionPublicShare(collectionId);
    },
  );

  registerIpcHandler(
    COLLECTIONS_CHANNELS.PACKAGE_ANALYZE,
    async (_event, request: AnalyzeCollectionCapabilityPackageRequest) => {
      const collection = await readCollectionConfig(request.collectionId);
      if (!collection) throw new Error('Collection not found');
      return analyzeSubjectCapabilityPackage({
        rawContent: serializeSharedCollectionForHash(request.rawCollection),
        scopeKey: `collection:${request.collectionId}`,
        selections: {
          collectionIds: [],
          skillRefs: collection.collection.skills,
          pluginRefs: collection.collection.plugins,
          mcpServerRefs: collection.collection.mcpServers,
        },
        dismissedInvocations: request.dismissedInvocations,
      });
    },
  );
  registerIpcHandler(
    COLLECTIONS_CHANNELS.PACKAGE_CANCEL_ANALYSIS,
    (_event, analysisId: string) => cancelPackageAnalysis(analysisId),
  );
  registerIpcHandler(
    COLLECTIONS_CHANNELS.PACKAGE_COMMIT,
    (event, request: CommitCollectionCapabilityPackageRequest) =>
      toShareOperationResult(async () => {
        await assertCollectionsSupported();
        return createSubjectCapabilityPackage(request, () =>
          BrowserWindow.fromWebContents(event.sender),
        );
      }, 'prepare'),
  );
  registerIpcHandler(
    COLLECTIONS_CHANNELS.IMPORT_READINESS,
    async (_event, collectionId: string) => {
      await assertCollectionsSupported();
      return inspectSharedCollectionImport(collectionId);
    },
  );
  registerIpcHandler(
    COLLECTIONS_CHANNELS.PACKAGE_INSTALL,
    (_event, request: InstallCollectionCapabilityPackageRequest) =>
      installCollectionPackageForCaller(request),
  );
}

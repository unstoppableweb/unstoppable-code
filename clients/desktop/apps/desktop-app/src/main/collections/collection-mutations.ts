import { isLocalCollectionConfig } from '@canopy/protocol/collections';
import type {
  ApplyCollectionUpdateRequest,
  ApplyCollectionUpdateResult,
  CollectionConfig,
  CollectionMcpRef,
  CollectionPluginRef,
  CollectionSkillRef,
  DuplicateLocalCollectionRequest,
  SharedCollectionDocument,
  SharedCollectionItem,
} from '@canopy/protocol/collections';
import type { PipelinePackageRef } from '@canopy/protocol/pipelines';
import type { CollectionSaveGuard } from './collection-store';
import { ResourceContextUnavailableError } from '../lib/resource-context-error';

export interface CollectionUpdateSnapshot {
  contentHash: string;
  collection: SharedCollectionDocument;
  customSkills: Array<{
    id: string;
    name: string;
    rawSkill: string;
    contentHash: string;
  }>;
  package?: PipelinePackageRef;
}

export interface CollectionMutationPorts {
  captureContext(): Promise<string>;
  assertContext(context: string): Promise<void>;
  read(id: string): Promise<CollectionConfig | null>;
  save(
    input: Partial<CollectionConfig> & { name: string },
    guard: CollectionSaveGuard,
  ): Promise<CollectionConfig>;
  live(
    source: NonNullable<CollectionConfig['sharedSource']>,
  ): Promise<CollectionUpdateSnapshot>;
  resolve(
    item: SharedCollectionItem,
    snapshot: CollectionUpdateSnapshot,
    source: NonNullable<CollectionConfig['sharedSource']>,
    assertCurrent: () => Promise<void>,
  ): Promise<CollectionSkillRef | CollectionPluginRef>;
  installPackage(
    snapshot: CollectionUpdateSnapshot,
    initial: CollectionConfig,
    assertCurrent: (expired?: () => boolean) => Promise<void>,
  ): Promise<{
    customSkills: Map<string, CollectionSkillRef>;
    skills: CollectionSkillRef[];
    mcpServers: CollectionMcpRef[];
    uninstalledResourceLabels?: string[];
    keptLocalFiles?: string[];
  }>;
}

export class CollectionUpdateError extends Error {
  constructor(
    readonly code:
      | 'invalid_payload'
      | 'not_found'
      | 'conflict'
      | 'permission_denied'
      | 'execution_failed',
    message: string,
    readonly partialResourceEffects: string[] = [],
  ) {
    super(message);
  }
}

const updates = new Map<
  string,
  { revision: string; result: Promise<ApplyCollectionUpdateResult> }
>();

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-f0-9-]+$/.test(id))
    throw new CollectionUpdateError(
      'invalid_payload',
      'Invalid Collection id.',
    );
}

function assertComplete(collection: CollectionConfig): void {
  if (
    !isLocalCollectionConfig({
      id: collection.id,
      name: collection.name,
      description: collection.description,
      skills: collection.skills,
      plugins: collection.plugins,
      mcpServers: collection.mcpServers,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
    })
  )
    throw new CollectionUpdateError(
      'invalid_payload',
      'A complete local Collection snapshot is required.',
    );
}

async function portsOrDefault(
  ports?: CollectionMutationPorts,
): Promise<CollectionMutationPorts> {
  return (
    ports ??
    (await import('./collection-mutation-ports')).collectionMutationPorts
  );
}

/** Creates exactly one detached copy. Refresh/open-editor are host concerns. */
export async function duplicateLocalCollection(
  request: DuplicateLocalCollectionRequest,
  ports?: CollectionMutationPorts,
): Promise<CollectionConfig> {
  assertId(request?.collectionId);
  const host = await portsOrDefault(ports);
  const context = await host.captureContext();
  const initial = await host.read(request.collectionId);
  if (!initial)
    throw new CollectionUpdateError('not_found', 'Collection not found.');
  assertComplete(initial);
  return host.save(
    {
      name: `${initial.name} copy`,
      description: initial.description,
      skills: initial.skills,
      plugins: initial.plugins,
      mcpServers: initial.mcpServers,
    },
    {
      expectedRevision: undefined,
      assertCurrent: () => host.assertContext(context),
    },
  );
}

/** Additional authority of an interface that delegates the existing operation. */
export interface CollectionUpdateAuthorization {
  readonly key: string;
  assertCurrent(): Promise<void>;
  validatePrepared?: CollectionSaveGuard['validatePrepared'];
}

/** Core-owned orchestration over the established collection and import writers. */
export async function applyCollectionUpdate(
  request: ApplyCollectionUpdateRequest,
  ports?: CollectionMutationPorts,
  authorization?: CollectionUpdateAuthorization,
): Promise<ApplyCollectionUpdateResult> {
  assertId(request?.collectionId);
  if (typeof request.expectedRevision !== 'string' || !request.expectedRevision)
    throw new CollectionUpdateError(
      'invalid_payload',
      'A Collection revision is required.',
    );
  const host = await portsOrDefault(ports);
  const context = await host.captureContext();
  await authorization?.assertCurrent();
  const key = JSON.stringify([
    context,
    request.collectionId,
    authorization?.key,
  ]);
  const pending = updates.get(key);
  if (pending) {
    if (pending.revision !== request.expectedRevision)
      throw new CollectionUpdateError(
        'conflict',
        'Another update is in progress.',
      );
    return pending.result;
  }
  const result = update(request, host, context, authorization);
  updates.set(key, { revision: request.expectedRevision, result });
  try {
    return await result;
  } finally {
    if (updates.get(key)?.result === result) updates.delete(key);
  }
}

async function update(
  request: ApplyCollectionUpdateRequest,
  host: CollectionMutationPorts,
  context: string,
  authorization?: CollectionUpdateAuthorization,
): Promise<ApplyCollectionUpdateResult> {
  const initial = await host.read(request.collectionId);
  if (!initial)
    throw new CollectionUpdateError('not_found', 'Collection not found.');
  assertComplete(initial);
  if (initial.revision !== request.expectedRevision || !initial.sharedSource)
    throw new CollectionUpdateError(
      'conflict',
      'Collection changed. Reload it before updating.',
    );
  const source = initial.sharedSource;
  const assertCurrent = async (): Promise<void> => {
    await authorization?.assertCurrent();
    await host.assertContext(context);
    const current = await host.read(initial.id);
    if (!current)
      throw new CollectionUpdateError('not_found', 'Collection was removed.');
    if (
      current.revision !== initial.revision ||
      current.sharedSource?.remoteId !== source.remoteId ||
      current.sharedSource?.contentHash !== source.contentHash ||
      Boolean(current.sharedSource?.fromPublicShare) !==
        Boolean(source.fromPublicShare)
    )
      throw new CollectionUpdateError(
        'conflict',
        'Collection changed during the update.',
      );
  };
  await assertCurrent();
  // Authorization and a coherent detail/package snapshot precede all effects.
  const snapshot = await host.live(source);
  if (!snapshot.contentHash)
    throw new CollectionUpdateError(
      'conflict',
      'The shared Collection has no verified revision.',
    );
  const effects: string[] = [];
  const assertAuthorizedCurrent = async (
    expired?: () => boolean,
  ): Promise<void> => {
    await assertCurrent();
    // A package install past its check budget has given up: fail closed
    // instead of starting the live read.
    if (expired?.())
      throw new CollectionUpdateError(
        'conflict',
        "Couldn't re-check the package in time. Try again.",
      );
    const latest = await host.live(source);
    if (
      latest.contentHash !== snapshot.contentHash ||
      latest.package?.digest !== snapshot.package?.digest
    )
      throw new CollectionUpdateError(
        'conflict',
        'The shared Collection changed during the update.',
      );
    await assertCurrent();
  };
  try {
    await assertCurrent();
    if (snapshot.package) effects.push('Collection capability package');
    const packaged = snapshot.package
      ? await host.installPackage(snapshot, initial, assertAuthorizedCurrent)
      : undefined;
    const skills = new Map<string, CollectionSkillRef>();
    const plugins = new Map<string, CollectionPluginRef>();
    for (const skill of packaged?.skills ?? [])
      skills.set(JSON.stringify([skill.sourceId, skill.skillName]), skill);
    const seen = new Set<string>();
    for (const item of snapshot.collection.items) {
      const identity = JSON.stringify(item);
      if (seen.has(identity)) continue;
      seen.add(identity);
      await assertAuthorizedCurrent();
      const packagedSkill =
        item.type === 'custom_skill'
          ? packaged?.customSkills.get(item.skillId)
          : undefined;
      // A packaged custom member must map by manifest resource/hash. Never run
      // the legacy importer again just because a display name did not match.
      if (packaged && item.type === 'custom_skill' && !packagedSkill)
        throw new CollectionUpdateError(
          'execution_failed',
          'A packaged custom skill could not be resolved.',
        );
      effects.push(
        item.type === 'claude_plugin' || item.type === 'codex_plugin'
          ? item.plugin_name
          : item.skill_name,
      );
      const ref =
        packagedSkill ??
        (await host.resolve(item, snapshot, source, assertAuthorizedCurrent));
      if ('sourceId' in ref)
        skills.set(JSON.stringify([ref.sourceId, ref.skillName]), ref);
      else
        plugins.set(JSON.stringify([ref.marketplaceId, ref.pluginName]), ref);
    }
    await assertAuthorizedCurrent();
    // No installer writes the grouping. Persist exact membership and hash once,
    // after all represented members and package provenance have succeeded.
    const collection = await host.save(
      {
        ...initial,
        skills: Array.from(skills.values()),
        plugins: Array.from(plugins.values()),
        mcpServers: packaged?.mcpServers ?? initial.mcpServers,
        sharedSource: {
          ...source,
          contentHash: snapshot.contentHash,
          fetchedAt: new Date().toISOString(),
        },
      },
      {
        expectedRevision: request.expectedRevision,
        assertCurrent: assertAuthorizedCurrent,
        validatePrepared: authorization?.validatePrepared,
      },
    );
    return {
      collection,
      preservedLegacyMcpRefs:
        !snapshot.package && initial.mcpServers.length > 0,
      ...(packaged?.uninstalledResourceLabels?.length
        ? { uninstalledResourceLabels: packaged.uninstalledResourceLabels }
        : {}),
      ...(packaged?.keptLocalFiles?.length
        ? { keptLocalFiles: packaged.keptLocalFiles }
        : {}),
    };
  } catch (error) {
    const code =
      error instanceof CollectionUpdateError
        ? error.code
        : error instanceof ResourceContextUnavailableError
          ? 'permission_denied'
          : error instanceof Error &&
              'code' in error &&
              (error.code === 'conflict' ||
                error.code === 'not_found' ||
                error.code === 'permission_denied')
            ? error.code
            : 'execution_failed';
    const message =
      error instanceof Error ? error.message : 'Collection update failed.';
    throw new CollectionUpdateError(
      code,
      effects.length
        ? `${message} Some resources may have been added; refresh the inventory before retrying.`
        : message,
      effects,
    );
  }
}

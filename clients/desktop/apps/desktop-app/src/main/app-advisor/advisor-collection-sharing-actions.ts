import { BRAND } from '@canopy/brand/current';
import type {
  EditableSharedCollection,
  SharedCollectionConversionResult,
} from '@canopy/desktop-shared/collections/shared-collection-payload';
import type { SharedCollectionImportResolution } from '@canopy/desktop-shared/lib/shared-import/shared-collection-import';
import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
} from '@canopy/desktop-shared/types';
import type {
  CollectionConfig,
  CreateSharedCollectionRequest,
  InstallCollectionCapabilityPackageRequest,
  InstallCollectionCapabilityPackageResult,
  ListSharedCollectionsRequest,
  ListSharedCollectionsResponse,
  SharedCollectionDetail,
  UpdateSharedCollectionRequest,
} from '@canopy/desktop-shared/types/collections';
import type { ShareOperationResult } from '@canopy/protocol/sharing';
import { agentResourceActionFailure } from '../canopy-tools/resource-actions';
import { toAdvisorJson } from './advisor-json';
import type { PersonConfirmation } from './advisor-records-actions';
import {
  resolveOrganization,
  shareFailure,
  type AdvisorSharingActionHost,
} from './advisor-sharing-actions';

/**
 * CAN-6003 part B: App Advisor's collection sharing actions, in Electron
 * main on the owners the window's collection, skill and plugin handlers use.
 * A share targets the organization by the part A rules; a person confirms
 * every import (S7), since it installs skills and plugins a later agent runs.
 */
export const ADVISOR_COLLECTION_SHARING_ACTION_TYPES = [
  'collections.share',
  'collections.list_shared',
  'collections.import_shared',
  'collections.update_shared',
  'collections.delete_shared',
] as const;

export type AdvisorCollectionSharingAction = Extract<
  AppAdvisorAction,
  { type: (typeof ADVISOR_COLLECTION_SHARING_ACTION_TYPES)[number] }
>;

export function isAdvisorCollectionSharingAction(
  action: AppAdvisorAction,
): action is AdvisorCollectionSharingAction {
  return ADVISOR_COLLECTION_SHARING_ACTION_TYPES.some(
    (type) => type === action.type,
  );
}

/** The window's collection owners in Electron main; tests substitute them. */
export interface AdvisorCollectionSharingHost extends Pick<
  AdvisorSharingActionHost,
  'memberOrganizationIds' | 'selectedOrganizationId'
> {
  loadCollection(id: string): Promise<CollectionConfig | null>;
  /** The local collection as the share dialog edits it. */
  editable(config: CollectionConfig): Promise<EditableSharedCollection>;
  payload(
    editable: EditableSharedCollection,
  ): Promise<SharedCollectionConversionResult>;
  listShared(
    request: ListSharedCollectionsRequest,
  ): Promise<ListSharedCollectionsResponse>;
  getShared(collectionId: string): Promise<SharedCollectionDetail>;
  createShared(
    request: CreateSharedCollectionRequest,
  ): Promise<ShareOperationResult<SharedCollectionDetail>>;
  updateShared(
    request: UpdateSharedCollectionRequest,
  ): Promise<ShareOperationResult<SharedCollectionDetail>>;
  deleteShared(collectionId: string): Promise<void>;
  /** Installs every member, as the window's import does. */
  resolveImport(
    detail: SharedCollectionDetail,
  ): Promise<SharedCollectionImportResolution>;
  saveCollection(
    collection: Partial<CollectionConfig> & { name: string },
  ): Promise<CollectionConfig>;
  installPackage(
    request: InstallCollectionCapabilityPackageRequest,
  ): Promise<InstallCollectionCapabilityPackageResult>;
  /** One AskUserQuestion; only a person's answer can confirm. */
  confirm(
    question: string,
    options: { confirm: string; decline: string },
  ): Promise<PersonConfirmation>;
}

type Response = Omit<AppAdvisorActionResponse, 'requestId'>;

export const IMPORT_COLLECTION = 'Import';
export const KEEP_COLLECTIONS = 'Cancel';

const MCP_SHARE_MESSAGE =
  'Collections with MCP server configs cannot be shared. Remove MCP servers before sharing.';

function failure(
  code: 'not_found' | 'invalid_target' | 'authorization_conflict',
  message: string,
): Response {
  return { ok: false, error: { code, message } };
}

/** The collection to share, unless it can't be shared from here. */
async function shareable(
  id: string,
  host: AdvisorCollectionSharingHost,
): Promise<CollectionConfig | Response> {
  const collection = await host.loadCollection(id);
  if (!collection)
    return failure('not_found', `Local collection ${id} was not found.`);
  if (collection.mcpServers.length > 0)
    return failure('invalid_target', MCP_SHARE_MESSAGE);
  return collection;
}

function isResponse(value: CollectionConfig | Response): value is Response {
  return 'ok' in value;
}

/**
 * A linked custom skill keeps the shared copy it already points at, as the
 * window's update does, so an update doesn't re-upload it.
 */
function keepLinkedCustomSkills(
  editable: EditableSharedCollection,
  current: SharedCollectionDetail,
): EditableSharedCollection {
  const linked = new Map(
    current.collection.items.flatMap((item) =>
      item.type === 'custom_skill' ? [[item.skill_name, item] as const] : [],
    ),
  );
  return {
    ...editable,
    remoteId: current.id,
    items: editable.items.map((item) => {
      if (item.kind !== 'draft_custom_skill') return item;
      const existing = linked.get(item.skillName);
      if (!existing) return item;
      const required = item.required ?? existing.required;
      return {
        kind: 'linked_custom_skill',
        skillId: existing.skillId,
        skillName: existing.skill_name,
        contentHash: existing.contentHash,
        ...(required !== undefined ? { required } : {}),
      };
    }),
  };
}

/** What an import installs, as a person is asked about it (S7). */
function importQuestion(detail: SharedCollectionDetail): string {
  const members = detail.collection.items.map((item) => {
    switch (item.type) {
      case 'skill':
        return item.source.type === 'builtin'
          ? `- Skill ${item.skill_name} (built in)`
          : `- Skill ${item.skill_name}, from ${item.source.repo}`;
      case 'custom_skill':
        return `- Custom skill ${item.skill_name}`;
      case 'claude_plugin':
        return item.marketplace.type === 'builtin'
          ? `- Claude plugin ${item.plugin_name} (built in)`
          : `- Claude plugin ${item.plugin_name}, from ${item.marketplace.repo}`;
      case 'codex_plugin':
        return `- Codex plugin ${item.plugin_name}`;
    }
  });
  return [
    `Import the shared collection "${detail.collection.name}" into ${BRAND.displayName}? It installs:`,
    ...members,
    ...(detail.package ? ['- Its packaged files'] : []),
  ].join('\n');
}

async function importShared(
  collectionId: string,
  host: AdvisorCollectionSharingHost,
): Promise<Response> {
  const detail = await host.getShared(collectionId);
  const answer = await host.confirm(importQuestion(detail), {
    confirm: IMPORT_COLLECTION,
    decline: KEEP_COLLECTIONS,
  });
  if (answer !== 'confirmed')
    return failure(
      'authorization_conflict',
      answer === 'declined'
        ? 'The person chose not to import the collection.'
        : 'Only a person can confirm this, and nobody did.',
    );
  const resolved = await host.resolveImport(detail);
  let saved = await host.saveCollection({
    name: detail.collection.name,
    description: detail.collection.description,
    skills: resolved.skills,
    plugins: resolved.plugins,
    mcpServers: [],
  });
  const failures = [...resolved.failures];
  if (detail.package) {
    try {
      const packaged = await host.installPackage({
        collectionId: detail.id,
        localCollectionId: saved.id,
        packageRef: {
          version: detail.package.version,
          digest: detail.package.digest,
        },
      });
      saved = packaged.collection;
      for (const requirement of packaged.unmetRequirements)
        failures.push({
          label: requirement.displayName,
          required: requirement.required,
          message: requirement.setupHint,
        });
    } catch (error) {
      failures.push({
        label: 'Packaged files',
        required: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    ok: true,
    result: toAdvisorJson({ ...saved, memberFailures: failures }),
  };
}

async function run(
  action: AdvisorCollectionSharingAction,
  host: AdvisorCollectionSharingHost,
): Promise<Response> {
  switch (action.type) {
    case 'collections.share': {
      const organization = await resolveOrganization(action, host);
      if ('response' in organization) return organization.response;
      const collection = await shareable(action.id, host);
      if (isResponse(collection)) return collection;
      const payload = await host.payload(await host.editable(collection));
      const created = await host.createShared({
        sourceCollectionId: collection.id,
        rawCollection: payload.rawCollection,
        ...(payload.customSkills.length > 0
          ? { customSkills: payload.customSkills }
          : {}),
        shareScope: action.shareScope,
        ...(action.teamId ? { teamId: action.teamId } : {}),
        ...(organization.organizationId
          ? { organizationId: organization.organizationId }
          : {}),
      });
      if (!created.ok) return shareFailure(created);
      return {
        ok: true,
        result: { sharedCollection: toAdvisorJson(created.value) },
      };
    }
    case 'collections.list_shared': {
      const response = await host.listShared({
        ...(action.query ? { query: action.query } : {}),
        ...(action.limit !== undefined ? { limit: action.limit } : {}),
        ...(action.cursor ? { cursor: action.cursor } : {}),
        ...(action.createdBy ? { createdBy: action.createdBy } : {}),
      });
      return {
        ok: true,
        result: {
          collections: toAdvisorJson(response.collections),
          ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
        },
      };
    }
    case 'collections.import_shared':
      return importShared(action.collectionId, host);
    case 'collections.update_shared': {
      const collection = await shareable(action.id, host);
      if (isResponse(collection)) return collection;
      const current = await host.getShared(action.collectionId);
      const payload = await host.payload(
        keepLinkedCustomSkills(await host.editable(collection), current),
      );
      const updated = await host.updateShared({
        collectionId: action.collectionId,
        rawCollection: payload.rawCollection,
        expectedContentHash: current.contentHash,
        ...(payload.customSkills.length > 0
          ? { customSkills: payload.customSkills }
          : {}),
      });
      if (!updated.ok) return shareFailure(updated);
      return { ok: true, result: toAdvisorJson(updated.value) };
    }
    case 'collections.delete_shared':
      await host.deleteShared(action.collectionId);
      return { ok: true, result: { collectionId: action.collectionId } };
  }
}

export async function dispatchAdvisorCollectionSharingAction(
  action: AdvisorCollectionSharingAction,
  host: AdvisorCollectionSharingHost,
): Promise<Response> {
  try {
    return await run(action, host);
  } catch (error) {
    return agentResourceActionFailure(error);
  }
}

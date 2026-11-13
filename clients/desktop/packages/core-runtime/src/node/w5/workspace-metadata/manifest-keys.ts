/**
 * Every top-level `workspace.json` field this version reads; a manifest write
 * keeps any other field. The written fields come first, in the order the
 * desktop config write emits them, then the legacy fields only read.
 */
export const WORKSPACE_MANIFEST_KEYS = [
  'privateMemory',
  'privateMemoryManagedBy',
  'version',
  'personalCatalogId',
  'type',
  'repoPath',
  'repos',
  'itemSortMode',
  'externalPath',
  'cowork',
  'defaultPluginSelections',
  'sharedTemplatePublicationKey',
  'sharedTemplateExternalId',
  'sharedTemplateContentHash',
  'installedFromTemplateExternalId',
  'installedFromTemplateContentHash',
  'seededFromBlueprintExternalId',
  'disabledGlobalPluginSelections',
  'sourceRepoPath',
  'scripts',
  'hooks',
  'suppressedRepoIds',
  'alwaysShow',
  'owner',
  'ownershipTransfer',
  'detachedOwner',
  'recommendedPluginOptOutKeys',
  'temporary',
  'planDetection',
  'archiveRetentionDays',
  'autoArchiveDays',
  'autoArchiveDeleteBranch',
  'startPage',
  'temporarySourceWorkspaceIds',
  'temporaryRepoIdentityKeys',
  /** @deprecated Read as `externalPath`. */
  'folderPath',
  'setupScript',
  'teardownScript',
  'runScript',
  'launchScript',
] as const;

/** The same for each `repos[]` entry. */
export const WORKSPACE_MANIFEST_REPOSITORY_KEYS = [
  'id',
  'name',
  'repoPath',
  'source',
  'manifestUrl',
  'scripts',
  'hooks',
  'setupScript',
  'teardownScript',
  'runScript',
  'launchScript',
] as const;

export type WorkspaceManifestKey = (typeof WORKSPACE_MANIFEST_KEYS)[number];
export type WorkspaceManifestRepositoryKey =
  (typeof WORKSPACE_MANIFEST_REPOSITORY_KEYS)[number];

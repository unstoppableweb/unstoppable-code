import {
  commitWorkspaceCreation,
  markWorkspaceCreationEffectsStarted,
  withLocalWorkspaceCreation,
  pendingWorkspaceCreationIds,
} from './w5-workspace-creation-commit';
import { afterW5Commit } from './w5-commit-scope';
import {
  CHAT_UNIT_LABEL_PLURAL,
  validateWorkspaceTemplateStarterPrompts,
} from '@canopy/protocol';
import { isProjectStartPage } from '@canopy/protocol/start-page';
import type {
  CoworkSidebarItem,
  CoworkWorkspaceSettings,
  WorkspaceConfigFile,
  WorkspaceOwnerBinding,
  UpdateChatProjectRequest,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import { getWorkspaceDir } from './paths';
import {
  getWorkspaceIndexRepository,
  readAllSidebarItems,
} from './sidebar-items';
import { IdentifierValidationError, validateId } from './validation';
import { PROJECT_W5_STORAGE, withStorageAdmission } from './w5-storage';
import {
  updateWorkspaceConfig,
  getWorkspaceManifestRepository,
  WorkspaceConfigUnreadableError,
} from './workspace-persistence';
import { scheduleDesktopStructureChanged } from '../services/desktop-structure-signal';
import {
  MAX_ARCHIVE_RETENTION_DAYS,
  resolveAutoArchiveDays,
} from '@canopy/desktop-shared/lib/archive-retention';
import { touchAllWorkspaceTargets } from './workspace-activity';
import {
  WorkspaceIndexUnreadableError,
  type WorkspaceIndexAuthority,
  type WorkspaceIndexSnapshot,
  type WorkspaceIndexChange,
} from './workspace-index-repository';
import {
  applyCoworkCreationAllocation,
  applyCoworkCreationDecision,
  applyCoworkCreationManifestDecision,
  applyCoworkDiscardDecision,
  applyCoworkIndexDecision,
  applyCoworkManifestDecision,
  applyCoworkMetadataDecision,
  applyCoworkProvisionDecision,
  applyCoworkPublishDecision,
  applyCoworkStageDecision,
} from './cowork-record-decision-port';
import {
  admitCoworkIndex,
  CoworkWorkspaceRecordRefusedError,
  withUnknownCoworkFields,
  type CoworkWorkspaceRecordRefusal,
} from './worktree-record-decision-apply';
import type { CoworkMetadataDecision } from './worktree-record-decisions';

export {
  CoworkWorkspaceRecordRefusedError,
  type CoworkWorkspaceRecordRefusal,
} from './worktree-record-decision-apply';

export const DEFAULT_COWORK_WORKSPACE_NAME = CHAT_UNIT_LABEL_PLURAL;
const DEFAULT_CREATED_AT = '2025-01-01T00:00:00.000Z';

function refuse(reason: CoworkWorkspaceRecordRefusal, message: string): never {
  throw new CoworkWorkspaceRecordRefusedError(reason, message);
}
function admitId(id: string): void {
  try {
    validateId(id, 'projectId');
  } catch (error) {
    if (error instanceof IdentifierValidationError)
      refuse('invalid-request', error.message);
    throw error;
  }
}
function authoritative(snapshot: WorkspaceIndexSnapshot): void {
  admitCoworkIndex(snapshot.authority, snapshot.unserved);
}
function inIndex<T>(
  change: (
    snapshot: WorkspaceIndexSnapshot,
  ) => Promise<WorkspaceIndexChange<T>>,
  manifestRefusal?: { reason: CoworkWorkspaceRecordRefusal; message: string },
): Promise<T> {
  return indexWork(
    () => getWorkspaceIndexRepository().update(change),
    manifestRefusal,
  );
}
/** Runs an index update admitted, in the workspace mutation queue, with its refusals typed. */
async function indexWork<T>(
  work: () => Promise<T>,
  manifestRefusal?: { reason: CoworkWorkspaceRecordRefusal; message: string },
): Promise<T> {
  try {
    return await withStorageAdmission(PROJECT_W5_STORAGE, () =>
      serializeWorkspaceMutation(work),
    );
  } catch (error) {
    if (error instanceof WorkspaceIndexUnreadableError)
      refuse('index-unavailable', error.message);
    if (error instanceof WorkspaceConfigUnreadableError)
      refuse(
        manifestRefusal?.reason ?? 'configuration-unavailable',
        manifestRefusal?.message ?? error.message,
      );
    throw error;
  }
}
async function afterCommit(): Promise<void> {
  await afterW5Commit(async (): Promise<void> => {
    await readAllSidebarItems();
    scheduleDesktopStructureChanged('structural.cowork-workspace-records');
  });
}

async function preserveCoworkFields(
  workspaceId: string,
  config: WorkspaceConfigFile,
): Promise<CoworkWorkspaceSettings> {
  const raw = await getWorkspaceManifestRepository().read(workspaceId);
  return withUnknownCoworkFields(
    raw.authority === 'ok' ? raw.document.cowork : undefined,
    config,
  );
}

export type CoworkMetadataChange =
  | { kind: 'settings'; request: UpdateChatProjectRequest }
  | {
      kind: 'import';
      color?: string;
      cowork?: CoworkWorkspaceSettings;
      defaultPluginSelections?: ChatTabPluginSelections;
    }
  | { kind: 'install'; externalId: string; contentHash: string }
  | { kind: 'blueprint'; externalId: string };
export interface CoworkMetadataRecord {
  source:
    | 'chat_project_update'
    | 'bundle_import'
    | 'template_install'
    | 'blueprint_create';
  workspaceId: string;
  change: CoworkMetadataChange;
}

export type CoworkTemplateShareChange =
  | { kind: 'publication'; publicationKey: string }
  | {
      kind: 'share';
      metadata: { externalId: string; pinnedContentHash: string } | null;
    };
/**
 * `internal.workspace.templateShare.record` (A26(a)): the local share
 * identity the host records around its share network effects. Revoke and get
 * only clear it; get's clear observes a remote share that is gone.
 */
export type CoworkTemplateShareRecord = { workspaceId: string } & (
  | { source: 'template_share_publish'; change: CoworkTemplateShareChange }
  | {
      source: 'template_share_revoke' | 'template_share_get';
      change: { kind: 'share'; metadata: null };
    }
);
export type CoworkTemplateShareRecordSource =
  CoworkTemplateShareRecord['source'];

function admitSettings(req: UpdateChatProjectRequest): void {
  if (req.starterPrompts !== undefined) {
    const parsed = validateWorkspaceTemplateStarterPrompts(req.starterPrompts);
    if (!parsed.ok) refuse('invalid-request', parsed.error);
  }
  if (
    req.startPage !== undefined &&
    req.startPage !== null &&
    !isProjectStartPage(req.startPage)
  ) {
    refuse('invalid-request', 'Invalid start page');
  }
  if (
    req.archiveRetentionDays !== undefined &&
    req.archiveRetentionDays !== null &&
    (!Number.isInteger(req.archiveRetentionDays) ||
      req.archiveRetentionDays < 0 ||
      req.archiveRetentionDays > MAX_ARCHIVE_RETENTION_DAYS)
  ) {
    refuse(
      'invalid-request',
      `Archive retention must be null or an integer from 0 to ${MAX_ARCHIVE_RETENTION_DAYS}`,
    );
  }
  if (
    req.autoArchiveDays !== undefined &&
    req.autoArchiveDays !== null &&
    (!Number.isInteger(req.autoArchiveDays) ||
      req.autoArchiveDays < 1 ||
      req.autoArchiveDays > MAX_ARCHIVE_RETENTION_DAYS)
  ) {
    refuse(
      'invalid-request',
      `Auto Delete inactivity must be null or an integer from 1 to ${MAX_ARCHIVE_RETENTION_DAYS}`,
    );
  }

  const trimmedName = req.name?.trim();
  if (req.name !== undefined && !trimmedName) {
    refuse('invalid-request', 'Project name is required');
  }
}

/**
 * The fields of a standalone `core.workspace.cowork.update` (A28′(a)): only
 * Cowork settings, with plugin defaults derived from the selected preset.
 */
export type CoworkSettingsPatch = Pick<
  UpdateChatProjectRequest,
  | 'description'
  | 'defaultModel'
  | 'defaultPresetId'
  | 'presets'
  | 'archiveRetentionDays'
  | 'autoArchiveDays'
  | 'starterPrompts'
  | 'startPage'
>;
// Owned by other operations: presentation, Always show, explicit plugin defaults.
const NON_SETTINGS_FIELDS = [
  'name',
  'color',
  'alwaysShow',
  'defaultPluginSelections',
] as const satisfies ReadonlyArray<keyof UpdateChatProjectRequest>;

/**
 * Admits a settings-only change before any receipt lookup or reservation and
 * returns its settings, without fields an untyped payload may carry.
 */
export function admitCoworkSettingsChange(
  req: UpdateChatProjectRequest,
): CoworkSettingsPatch {
  admitId(req.projectId);
  if (NON_SETTINGS_FIELDS.some((field) => req[field] !== undefined))
    refuse(
      'invalid-request',
      'Name, color, Always show and default plugins are updated separately from project settings',
    );
  admitSettings(req);
  return {
    description: req.description,
    defaultModel: req.defaultModel,
    defaultPresetId: req.defaultPresetId,
    presets: req.presets,
    archiveRetentionDays: req.archiveRetentionDays,
    autoArchiveDays: req.autoArchiveDays,
    starterPrompts: req.starterPrompts,
    startPage: req.startPage,
  };
}

/**
 * Admits a whole `chat-project:update` save before any of its owner parts
 * writes, so a refusal still leaves every part unwritten (W7b-1c).
 */
export function admitCoworkSaveRequest(req: UpdateChatProjectRequest): void {
  admitId(req.projectId);
  admitSettings(req);
}

/** The Auto Delete baseline: every Work Entry's recency, stamped before staging. */
async function stampAutoDeleteBaseline(workspaceId: string): Promise<void> {
  try {
    await touchAllWorkspaceTargets(workspaceId);
  } catch (error) {
    // No decision follows a failed stamp, so a keyed retry is safe.
    refuse(
      'activity-unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** The decision of a non-settings change, with only the fields it reads. */
function coworkMetadataDecision(
  workspaceId: string,
  change: Exclude<CoworkMetadataChange, { kind: 'settings' }>,
): CoworkMetadataDecision {
  switch (change.kind) {
    case 'import': {
      // The bundle import passes its whole manifest, whose name renames the entry.
      const presentation: { name?: string; color?: string } = change;
      return {
        kind: 'cowork.metadata.import',
        workspaceId,
        ...(presentation.name !== undefined ? { name: presentation.name } : {}),
        ...(presentation.color !== undefined
          ? { color: presentation.color }
          : {}),
        ...(change.cowork !== undefined ? { cowork: change.cowork } : {}),
        ...(change.defaultPluginSelections !== undefined
          ? { defaultPluginSelections: change.defaultPluginSelections }
          : {}),
      };
    }
    case 'install':
      return {
        kind: 'cowork.metadata.install',
        workspaceId,
        externalId: change.externalId,
        contentHash: change.contentHash,
      };
    case 'blueprint':
      return {
        kind: 'cowork.metadata.blueprint',
        workspaceId,
        externalId: change.externalId,
      };
  }
}

/**
 * Applies only this call's Cowork fields to the manifest read in its queue.
 * Import, install and blueprint changes go through the record decision port
 * (W6a2); settings stay on their own path.
 */
export async function recordCoworkWorkspaceMetadata(
  record: CoworkMetadataRecord,
): Promise<void> {
  admitId(record.workspaceId);
  const change = record.change;
  if (change.kind !== 'settings') {
    const decision = coworkMetadataDecision(record.workspaceId, change);
    await indexWork(() => applyCoworkMetadataDecision(decision));
    await afterCommit();
    return;
  }
  const req = change.request;
  admitSettings(req);
  await inIndex(async (snapshot): Promise<WorkspaceIndexChange<void>> => {
    authoritative(snapshot);
    const entry = snapshot.entries.find(
      (candidate) =>
        candidate.id === record.workspaceId && candidate.type === 'cowork',
    );
    if (!entry) refuse('not-found', 'Chat project not found');
    await updateWorkspaceConfig(
      record.workspaceId,
      async (config, read): Promise<void> => {
        if (read.authority === 'absent' || config.type !== 'cowork')
          refuse('not-found', 'Chat project not found');
        // Keep unknown nested Cowork fields as well as the fields normalized by this version.
        const settings = await preserveCoworkFields(record.workspaceId, config);
        const next: CoworkWorkspaceSettings = { ...settings };
        if (req.description !== undefined) next.description = req.description;
        if (req.defaultModel !== undefined)
          next.defaultModel = req.defaultModel;
        if (req.defaultPresetId !== undefined)
          next.defaultPresetId = req.defaultPresetId;
        if (req.presets !== undefined) next.presets = req.presets;
        if (req.archiveRetentionDays !== undefined)
          next.archiveRetentionDays = req.archiveRetentionDays;
        if (req.autoArchiveDays !== undefined)
          next.autoArchiveDays = req.autoArchiveDays;
        if (req.starterPrompts !== undefined)
          next.starterPrompts = req.starterPrompts;
        if (req.startPage === null) delete next.startPage;
        else if (req.startPage !== undefined) next.startPage = req.startPage;
        const preset = next.presets?.find(
          (candidate) => candidate.id === next.defaultPresetId,
        );
        config.defaultPluginSelections =
          preset?.pluginSelections ??
          req.defaultPluginSelections ??
          config.defaultPluginSelections;
        if (req.alwaysShow !== undefined) config.alwaysShow = req.alwaysShow;
        if (
          resolveAutoArchiveDays(
            'cowork',
            settings.archiveRetentionDays,
            settings.autoArchiveDays,
          ) === null &&
          resolveAutoArchiveDays(
            'cowork',
            next.archiveRetentionDays,
            next.autoArchiveDays,
          ) !== null
        )
          await stampAutoDeleteBaseline(record.workspaceId);
        config.cowork = next;
      },
    );
    return {
      result: undefined,
      ...(req.name !== undefined || req.color !== undefined
        ? {
            entries: snapshot.entries.map((candidate) =>
              candidate === entry
                ? {
                    ...entry,
                    ...(req.name !== undefined
                      ? { name: req.name.trim() }
                      : {}),
                    ...(req.color !== undefined ? { color: req.color } : {}),
                  }
                : candidate,
            ),
          }
        : {}),
    };
  });
  await afterCommit();
}

/**
 * Applies only the `sharedTemplate*` fields to the manifest read in its
 * queue. Unkeyed, with no revision: the host serializes it with the share
 * network effects around it.
 */
export async function recordCoworkTemplateShare(
  record: CoworkTemplateShareRecord,
): Promise<void> {
  admitId(record.workspaceId);
  await inIndex(async (snapshot): Promise<WorkspaceIndexChange<void>> => {
    authoritative(snapshot);
    if (
      !snapshot.entries.some(
        (candidate) =>
          candidate.id === record.workspaceId && candidate.type === 'cowork',
      )
    )
      refuse('not-found', 'Chat project not found');
    const change = record.change;
    await updateWorkspaceConfig(
      record.workspaceId,
      async (config, read): Promise<void> => {
        if (read.authority === 'absent' || config.type !== 'cowork')
          refuse('not-found', 'Chat project not found');
        const settings = await preserveCoworkFields(record.workspaceId, config);
        if (change.kind === 'publication') {
          config.sharedTemplatePublicationKey = change.publicationKey;
        } else {
          if (change.metadata === null)
            config.sharedTemplatePublicationKey = undefined;
          config.sharedTemplateExternalId = change.metadata?.externalId;
          config.sharedTemplateContentHash = change.metadata?.pinnedContentHash;
        }
        // Must not clear fields hidden from the sidebar projection.
        config.cowork = settings;
      },
    );
    return { result: undefined };
  });
  await afterCommit();
}

export interface CoworkCreationRecord {
  source: 'managed_create' | 'external_import';
  name: string;
  createdAt: string;
  externalPath?: string;
  installedFromTemplateExternalId?: string;
  owner?: WorkspaceOwnerBinding;
}
/**
 * Select under the index queue, reserve durably, then publish both canonical
 * files, through the record decision port (W6a2).
 */
export async function recordNewCoworkWorkspace(
  request: CoworkCreationRecord,
): Promise<CoworkSidebarItem> {
  return serializeWorkspaceMutation(async () => {
    const name = request.name.trim();
    if (!name) refuse('invalid-request', 'Project name is required');
    const pendingIds = await pendingWorkspaceCreationIds();
    const item = await indexWork(() =>
      applyCoworkCreationAllocation(
        {
          kind: 'cowork.create.allocate',
          name,
          createdAt: request.createdAt,
          ...(request.externalPath === undefined
            ? {}
            : { externalPath: request.externalPath }),
          ...(request.installedFromTemplateExternalId === undefined
            ? {}
            : {
                installedFromTemplateExternalId:
                  request.installedFromTemplateExternalId,
              }),
          ...(request.owner ? { owner: request.owner } : {}),
          pendingIds,
        },
        admitId,
      ),
    );
    return withLocalWorkspaceCreation(item.id, [getWorkspaceDir(item.id)], () =>
      commitWorkspaceCreation(() => stageNewCoworkWorkspace(item), [item.id]),
    );
  });
}

async function stageNewCoworkWorkspace(
  item: CoworkSidebarItem,
): Promise<CoworkSidebarItem> {
  await indexWork(() =>
    applyCoworkCreationDecision(
      { kind: 'cowork.create', item },
      markWorkspaceCreationEffectsStarted,
    ),
  );
  if (!item.owner)
    await applyCoworkCreationManifestDecision(item.id, {
      kind: 'cowork.create.manifest',
      item,
    });
  await afterCommit();
  return item;
}

export interface CoworkStageRecord {
  source: 'org_cowork_stage';
  item: CoworkSidebarItem;
}
/**
 * Stores or refreshes only the staged workspace's owner and initial manifest,
 * through the record decision port (W6a2).
 */
export async function recordStagedCoworkWorkspace(
  record: CoworkStageRecord,
): Promise<boolean> {
  const { item } = record;
  admitId(item.id);
  if (!item.owner)
    refuse('identity-changed', 'The local workspace id is already in use');
  const owner = item.owner;
  return indexWork(
    () => applyCoworkStageDecision({ kind: 'cowork.stage', item, owner }),
    {
      reason: 'identity-changed',
      message: 'The local workspace id is already in use',
    },
  );
}

export interface CoworkPublishRecord {
  source: 'org_cowork_publish';
  workspaceId: string;
  name: string;
  owner: WorkspaceOwnerBinding;
  precheck?: () => Promise<void>;
}
/**
 * Publishes a staged manifest, keeping other index entries and manifest
 * fields, through the record decision port (W6a2).
 */
export async function publishCoworkWorkspaceRecord(
  record: CoworkPublishRecord,
): Promise<CoworkSidebarItem> {
  admitId(record.workspaceId);
  const outcome = await indexWork(
    () =>
      applyCoworkPublishDecision(
        {
          kind: 'cowork.publish',
          workspaceId: record.workspaceId,
          name: record.name.trim(),
          owner: record.owner,
        },
        record.precheck,
      ),
    {
      reason: 'configuration-unavailable',
      message: 'The staged Cowork workspace is unavailable',
    },
  );
  if (outcome.changed) await afterCommit();
  return outcome.item;
}

export interface CoworkDiscardRecord {
  source: 'org_cowork_discard';
  workspaceId: string;
  projectId: string;
}
/**
 * Keeps published or rebound workspaces; removes only this unpublished
 * metadata directory, through the record decision port (W6a2).
 */
export async function discardCoworkWorkspaceRecord(
  record: CoworkDiscardRecord,
): Promise<void> {
  admitId(record.workspaceId);
  await indexWork(() =>
    applyCoworkDiscardDecision({
      kind: 'cowork.discard',
      workspaceId: record.workspaceId,
      projectId: record.projectId,
    }),
  );
}

export interface CoworkProvisionRecord {
  source: 'default_cowork_provision';
  workspaceId: string;
  owner?: WorkspaceOwnerBinding;
  publishToIndex?: boolean;
}
/**
 * Decides default provisioning from current index and manifest state, never a
 * caller's projection, through the record decision port (W5c2).
 */
export async function provisionCoworkWorkspaceRecord(
  record: CoworkProvisionRecord,
): Promise<{ item: CoworkSidebarItem; notify: boolean }> {
  return serializeWorkspaceMutation(
    async (): Promise<{ item: CoworkSidebarItem; notify: boolean }> => {
      admitId(record.workspaceId);
      const outcome = await indexWork(
        () =>
          applyCoworkProvisionDecision({
            kind: 'cowork.provision',
            workspaceId: record.workspaceId,
            ...(record.owner ? { owner: record.owner } : {}),
            publishToIndex: record.publishToIndex !== false,
            name: DEFAULT_COWORK_WORKSPACE_NAME,
            createdAt: DEFAULT_CREATED_AT,
          }),
        {
          reason: 'configuration-unavailable',
          message: `The ${DEFAULT_COWORK_WORKSPACE_NAME} project configuration is unavailable`,
        },
      );
      if (outcome.deferredManifest)
        await applyCoworkManifestDecision(record.workspaceId, {
          kind: 'cowork.provision.manifest',
          item: outcome.deferredManifest,
        });
      if (outcome.notify) await afterCommit();
      return outcome;
    },
  );
}

export interface CoworkMigrationRecord {
  source: 'legacy_cowork_migration';
  legacyId: string;
  candidateId: string;
  name: string;
  color?: string;
  cowork?: CoworkWorkspaceSettings;
}
/**
 * Allocates or reuses the migration identity under the index queue, through
 * the record decision port (W5c2); Cowork has no worktree list.
 */
export async function recordMigratedCoworkWorkspace(
  record: CoworkMigrationRecord,
): Promise<string> {
  return serializeWorkspaceMutation(async (): Promise<string> => {
    admitId(record.candidateId);
    const { id, created } = await indexWork(() =>
      applyCoworkIndexDecision({
        kind: 'cowork.migration',
        candidateId: record.candidateId,
        name: record.name,
        ...(record.color === undefined ? {} : { color: record.color }),
        ...(record.cowork === undefined ? {} : { cowork: record.cowork }),
      }),
    );
    if (!created) return id;
    await applyCoworkManifestDecision(id, {
      kind: 'cowork.migration.manifest',
      ...(record.cowork === undefined ? {} : { cowork: record.cowork }),
    });
    await afterCommit();
    return id;
  });
}
export interface CoworkNameMigrationRecord {
  source: 'default_cowork_name_migration';
  workspaceId: string;
  name: string;
  onlyWhenNamed: readonly string[];
}
export async function renameDefaultCoworkWorkspaceRecord(
  record: CoworkNameMigrationRecord,
): Promise<{ authority: WorkspaceIndexAuthority; renamed: boolean }> {
  admitId(record.workspaceId);
  return applyCoworkIndexDecision({
    kind: 'cowork.default-name',
    workspaceId: record.workspaceId,
    name: record.name,
    onlyWhenNamed: record.onlyWhenNamed,
  });
}

import { z } from 'zod';
import { destructiveStep } from './w5-destructive-recovery';
import { afterW5Commit, currentW5CommitScope } from './w5-commit-scope';
import type { W5CommitOptions } from './w5-commit-scope';
import {
  commitW5BoundaryStep,
  w5CompositionLocks,
} from './w5-composition-operation';
import {
  checkW5ExpectedRevision,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import { runW5DecisionOnlyUnit } from './w5-pre-effect-retry';
import {
  createW5SingleDecisionOperation,
  type W5WireDecisionCall,
} from './w5-single-decision-operation';
import {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from './w5-commit-log-file-store';
import { reconcileManifestPluginDefaults } from './workspace-plugin-defaults';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import { logMainProcessWarn } from './main-process-logging';
import {
  admitCoworkSettingsChange,
  CoworkWorkspaceRecordRefusedError,
  DEFAULT_COWORK_WORKSPACE_NAME,
  recordCoworkTemplateShare,
  recordCoworkWorkspaceMetadata,
  recordNewCoworkWorkspace,
  type CoworkTemplateShareRecordSource,
  recordStagedCoworkWorkspace,
  publishCoworkWorkspaceRecord,
  discardCoworkWorkspaceRecord,
  provisionCoworkWorkspaceRecord,
} from './cowork-workspace-records';
import { writeFile } from 'node:fs/promises';
import {
  removeWorkspaceNonW5Children,
  removeWorkspaceDirectoryAfterRecordRemoval,
} from './w5-workspace-directory-removal';
import {
  recordSharedItemInstall,
  recordSharedItemUninstall,
} from '../canopy-cloud/shared-item-subscriptions';
import { basename, join, resolve } from 'node:path';
import { PROJECT_COLORS } from '@canopy/desktop-shared/constants/project-colors';
import {
  isDefaultCoworkWorkspaceId,
  type SharedWorkspaceTemplateDocument,
} from '@canopy/protocol';
import {
  COWORK_HOME_WORKTREE_ID,
  DEFAULT_COWORK_WORKSPACE_ID,
  type ChatProjectData,
  type CoworkSidebarItem,
  type SidebarItem,
  type WorkspaceOwnerBinding,
  type UpdateChatProjectRequest,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  ensureCoworkHomeScaffold,
  syncChatProjectAgentsMd,
} from './chat-project-utils';
import {
  activateWorkEntryWorkspace,
  clearWorkEntrySummariesForWorkspace,
  listWorkEntryIds,
} from './cowork-work-entries';
import {
  w5RecordReadPaths,
  getCoworkWorkspaceRootDir,
  getWorkspaceDir,
} from './paths';
import { isPathInside } from './path-safety';
import { projectPluginDefaultsWritten } from '../plugins/project-plugin-defaults-cache';
import {
  readAllSidebarItems,
  readAllSidebarItemsSnapshot,
  readWorkspaceIndexEntry,
  type SidebarItemsSnapshot,
} from './sidebar-items';
import { getSidebarItemsPreserveWorkspaceIds } from './sidebar-items-preservation';
import { readWorkspaceConfigDetailed } from './workspace-persistence';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { sendToAllWindows } from './window-send';
import { IdentifierValidationError, validateId } from './validation';
import { cleanupPersistedWorktreeData } from './worktree-data-cleanup';
import { withArchivedWorkspaceOperationLock } from './archived-containers';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import { getWorkspaceContextService } from './workspace-context-service';
import { PROJECT_W5_STORAGE, withStorageAdmission } from './w5-storage';
import {
  detachedWorkCallback,
  settleAll,
} from '@canopy/desktop-shared/node/lib/detached-work';

const DEFAULT_COWORK_WORKSPACE_CREATED_AT = '2025-01-01T00:00:00.000Z';
/**
 * The default cowork workspace is the sidebar's top-level Chats section, so
 * its stored name must match the label that section renders — the New task
 * composer, the chat switcher, and App Advisor all show this name, and a
 * disagreement reads as two different places (CAN-2363 follow-up).
 *
 * Taken from the shared label constant rather than spelled out, so the unit
 * name stays defined in one place. The previous value, `'Personal'`, also
 * collided with the personal/organization context split (CAN-2952).
 */
export { DEFAULT_COWORK_WORKSPACE_NAME } from './cowork-workspace-records';

function isCoworkSidebarItem(item: SidebarItem): item is CoworkSidebarItem {
  return item.type === 'cowork';
}

/**
 * Maps a persisted cowork workspace (index entry + `workspace.json` cowork
 * settings block) to the `ChatProjectData` shape the chat-project CRUD IPC
 * contract still exposes to the renderer. `name`/`color` come from the
 * sidebar index entry; the rest comes from the `cowork` settings block.
 */
function toChatProjectData(item: CoworkSidebarItem): ChatProjectData {
  const settings = item.cowork;
  return {
    id: item.id,
    privateMemory: item.privateMemory,
    privateMemoryManagedBy: item.privateMemoryManagedBy,
    name: item.name,
    createdAt: settings?.createdAt ?? DEFAULT_COWORK_WORKSPACE_CREATED_AT,
    color: item.color,
    ...(item.defaultPluginSelections !== undefined
      ? { defaultPluginSelections: item.defaultPluginSelections }
      : {}),
    ...(item.sharedTemplatePublicationKey !== undefined
      ? { sharedTemplatePublicationKey: item.sharedTemplatePublicationKey }
      : {}),
    ...(item.sharedTemplateExternalId !== undefined
      ? { sharedTemplateExternalId: item.sharedTemplateExternalId }
      : {}),
    ...(item.sharedTemplateContentHash !== undefined
      ? { sharedTemplateContentHash: item.sharedTemplateContentHash }
      : {}),
    ...(item.installedFromTemplateExternalId !== undefined
      ? {
          installedFromTemplateExternalId: item.installedFromTemplateExternalId,
        }
      : {}),
    ...(item.installedFromTemplateContentHash !== undefined
      ? {
          installedFromTemplateContentHash:
            item.installedFromTemplateContentHash,
        }
      : {}),
    ...(item.seededFromBlueprintExternalId !== undefined
      ? {
          seededFromBlueprintExternalId: item.seededFromBlueprintExternalId,
        }
      : {}),
    ...(settings?.description !== undefined
      ? { description: settings.description }
      : {}),
    ...(settings?.defaultModel !== undefined
      ? { defaultModel: settings.defaultModel }
      : {}),
    ...(settings?.starterPrompts !== undefined
      ? { starterPrompts: settings.starterPrompts }
      : {}),
    ...(settings?.startPage !== undefined
      ? { startPage: settings.startPage }
      : {}),
    ...(settings?.defaultPresetId !== undefined
      ? { defaultPresetId: settings.defaultPresetId }
      : {}),
    ...(settings?.presets !== undefined ? { presets: settings.presets } : {}),
    archiveRetentionDays: settings?.archiveRetentionDays ?? null,
    autoArchiveDays: settings?.autoArchiveDays ?? null,
    alwaysShow: item.alwaysShow !== false,
  };
}

function sortChatProjects(projects: ChatProjectData[]): ChatProjectData[] {
  return projects.slice().sort((left, right) => {
    const leftDefault = isDefaultCoworkWorkspaceId(left.id);
    const rightDefault = isDefaultCoworkWorkspaceId(right.id);
    if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      sensitivity: 'base',
    });
  });
}

export interface OrgCoworkBlueprintSeed {
  externalId: string;
  document: SharedWorkspaceTemplateDocument;
  defaultPluginSelections: ChatTabPluginSelections;
}

export interface StageOrgCoworkWorkspaceInput {
  id: string;
  owner: WorkspaceOwnerBinding;
  externalPath?: string;
  blueprint?: OrgCoworkBlueprintSeed;
}

/** Persist an organization Cowork workspace without making it visible. */
export function stageOrgCoworkWorkspace(
  input: StageOrgCoworkWorkspaceInput,
): Promise<void> {
  return serializeWorkspaceMutation(async () => {
    validateId(input.id, 'workspaceId');
    const blueprint = input.blueprint;
    const staged: CoworkSidebarItem = {
      id: input.id,
      name: blueprint?.document.name ?? input.id,
      type: 'cowork',
      color: blueprint?.document.color ?? PROJECT_COLORS[0],
      collapsed: false,
      order: 0,
      ...(input.externalPath ? { externalPath: input.externalPath } : {}),
      cowork: {
        createdAt: new Date().toISOString(),
        archiveRetentionDays: 7,
        ...(blueprint
          ? {
              description: blueprint.document.description,
              starterPrompts: blueprint.document.starterPrompts,
            }
          : {}),
      },
      ...(blueprint
        ? {
            defaultPluginSelections: blueprint.defaultPluginSelections,
            seededFromBlueprintExternalId: blueprint.externalId,
          }
        : {}),
      owner: input.owner,
    };
    const created = await recordStagedCoworkWorkspace({
      source: 'org_cowork_stage',
      item: staged,
    });
    if (created && !input.externalPath) {
      await ensureCoworkHomeScaffold(input.id);
      if (blueprint) {
        await writeFile(
          join(getCoworkWorkspaceRootDir(input.id), 'CLAUDE.md'),
          blueprint.document.instructions,
          'utf8',
        );
        await syncChatProjectAgentsMd(input.id);
      }
    }
  });
}

/** Publish a staged organization Cowork workspace to the sidebar index. */
export function publishOrgCoworkWorkspace(input: {
  id: string;
  name: string;
  owner: WorkspaceOwnerBinding;
  precheck?: () => Promise<void>;
}): Promise<CoworkSidebarItem> {
  return serializeWorkspaceMutation(async () => {
    const item = await publishCoworkWorkspaceRecord({
      source: 'org_cowork_publish',
      workspaceId: input.id,
      name: input.name,
      owner: input.owner,
      precheck: input.precheck,
    });
    activateWorkEntryWorkspace(input.id);
    sendToAllWindows(IPC_CHANNELS.workspaceWorktreesUpdated, {
      workspaceId: input.id,
    });
    return item;
  });
}

/** Remove unpublished metadata for a failed organization Cowork setup. */
export function discardStagedOrgCoworkWorkspace(
  id: string,
  projectId: string,
): Promise<void> {
  return serializeWorkspaceMutation(async () => {
    await discardCoworkWorkspaceRecord({
      source: 'org_cowork_discard',
      workspaceId: id,
      projectId,
    });
  });
}

export async function ensureDefaultCoworkWorkspace(
  _items: SidebarItem[],
  _preserveWorkspaceIds: string[],
  target: { id: string; owner?: WorkspaceOwnerBinding } = {
    id: DEFAULT_COWORK_WORKSPACE_ID,
  },
  options: { publishToIndex?: boolean } = {},
): Promise<CoworkSidebarItem> {
  const outcome = await provisionCoworkWorkspaceRecord({
    source: 'default_cowork_provision',
    workspaceId: target.id,
    owner: target.owner,
    publishToIndex: options.publishToIndex,
  });
  if (outcome.notify)
    sendToAllWindows(IPC_CHANNELS.workspaceWorktreesUpdated, {
      workspaceId: outcome.item.id,
    });
  return outcome.item;
}

/**
 * Lists every cowork workspace as a `ChatProjectData` entry, guaranteeing the
 * always-present {@link DEFAULT_COWORK_WORKSPACE_ID} home workspace exists
 * (creating it on first call if absent) — the successor to the old
 * `DEFAULT_CHAT_PROJECT_ID` guarantee. The default/home workspace always
 * sorts first; the rest sort by name. A session snapshot can supply its
 * discovery evidence; provisioning still runs outside that snapshot's view.
 */
export async function listCoworkWorkspacesAsChatProjects(
  sidebarSnapshot?: SidebarItemsSnapshot,
  options: { provisionDefaults?: boolean } = {},
): Promise<ChatProjectData[]> {
  const context = getWorkspaceContextService().getState().context;
  if (options.provisionDefaults !== false && context.kind === 'organization') {
    detachedWorkCallback(() =>
      import('./org-cowork-binding-deps').then(
        ({ startOrgDefaultCoworkProvisioning }) =>
          startOrgDefaultCoworkProvisioning(context.organizationId),
        () => undefined,
      ),
    )();
  }
  const { file: sidebarItems, indexAuthority } =
    sidebarSnapshot ?? (await readAllSidebarItemsSnapshot());
  const { items } = sidebarItems;
  const coworkItems = items.filter(isCoworkSidebarItem);

  // Only a complete index read proves the default project is missing; a
  // degraded one would reset its settings or drop other projects (CAN-3329).
  // The next listing retries.
  const indexProvesDefaultMissing =
    indexAuthority === 'ok' || indexAuthority === 'absent';
  if (
    options.provisionDefaults !== false &&
    indexProvesDefaultMissing &&
    !coworkItems.some((item) => item.id === DEFAULT_COWORK_WORKSPACE_ID)
  ) {
    coworkItems.push(
      await ensureDefaultCoworkWorkspace(
        items,
        getSidebarItemsPreserveWorkspaceIds(sidebarItems),
      ),
    );
  }

  return sortChatProjects(coworkItems.map(toChatProjectData));
}

/**
 * Creates a new managed cowork workspace: allocates a fresh id (slugified
 * from `name`, de-duplicated against every existing sidebar item id), scaffolds
 * its managed `home/` directory (CLAUDE.md + platform-safe AGENTS.md link, via
 * {@link ensureCoworkHomeScaffold}), and appends it to the workspace index.
 * `createdAt` defaults to the current time but can be supplied explicitly
 * (tests pass a fixed value for determinism).
 */
export function createCoworkWorkspace(
  ...args: Parameters<typeof createAdmittedCoworkWorkspace>
): Promise<ChatProjectData> {
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    createAdmittedCoworkWorkspace(...args),
  );
}

async function createAdmittedCoworkWorkspace(
  name: string,
  createdAt: string = new Date().toISOString(),
  installedFromTemplateExternalId?: string,
  owner?: WorkspaceOwnerBinding,
): Promise<ChatProjectData> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Project name is required');
  }

  const newItem = await recordNewCoworkWorkspace({
    source: 'managed_create',
    name: trimmedName,
    createdAt,
    installedFromTemplateExternalId,
    owner,
  });
  const workspaceId = newItem.id;
  activateWorkEntryWorkspace(workspaceId);

  return toChatProjectData(newItem);
}

export async function createCoworkWorkspaceFromTemplate(
  template: SharedWorkspaceTemplateDocument,
  defaultPluginSelections: ChatTabPluginSelections,
  sourceTemplate: { externalId: string; contentHash: string },
  options: { deferInstallCompletion?: boolean; name?: string } = {},
): Promise<ChatProjectData> {
  const existingInstall = await findCoworkWorkspaceTemplateInstall(
    sourceTemplate.externalId,
  );
  if (existingInstall?.installedFromTemplateContentHash !== undefined) {
    return existingInstall;
  }
  const project =
    existingInstall ??
    (await createCoworkWorkspace(
      options.name ?? template.name,
      undefined,
      sourceTemplate.externalId,
    ));
  await updateCoworkWorkspace({
    projectId: project.id,
    description: template.description,
    ...(template.color === undefined ? {} : { color: template.color }),
    defaultPluginSelections,
    starterPrompts: template.starterPrompts,
    ...(template.startPage === undefined
      ? {}
      : { startPage: template.startPage }),
  });
  await writeFile(
    join(getCoworkWorkspaceRootDir(project.id), 'CLAUDE.md'),
    template.instructions,
    'utf8',
  );
  // Template seeding retains the managed-home CLAUDE.md pairing convention:
  // a CLAUDE.md write is only half the contract. Without the AGENTS.md
  // symlink/copy, an installed template's instructions never reach a Codex
  // session in the new workspace until the user re-saves them by hand.
  await syncChatProjectAgentsMd(project.id);
  if (!options.deferInstallCompletion) {
    await setCoworkWorkspaceTemplateInstallMetadata(project.id, sourceTemplate);
  }
  return {
    ...project,
    description: template.description,
    ...(template.color === undefined ? {} : { color: template.color }),
    defaultPluginSelections,
    starterPrompts: template.starterPrompts,
    ...(template.startPage === undefined
      ? {}
      : { startPage: template.startPage }),
    installedFromTemplateExternalId: sourceTemplate.externalId,
    ...(options.deferInstallCompletion
      ? {}
      : { installedFromTemplateContentHash: sourceTemplate.contentHash }),
  };
}

export async function createCoworkWorkspaceFromBlueprint(
  template: SharedWorkspaceTemplateDocument,
  defaultPluginSelections: ChatTabPluginSelections,
  sourceTemplate: { externalId: string; contentHash: string },
  name?: string,
): Promise<ChatProjectData> {
  const project = await createCoworkWorkspace(name ?? template.name);
  await updateCoworkWorkspace({
    projectId: project.id,
    description: template.description,
    ...(template.color === undefined ? {} : { color: template.color }),
    defaultPluginSelections,
    starterPrompts: template.starterPrompts,
    ...(template.startPage === undefined
      ? {}
      : { startPage: template.startPage }),
  });
  await writeFile(
    join(getCoworkWorkspaceRootDir(project.id), 'CLAUDE.md'),
    template.instructions,
    'utf8',
  );
  await syncChatProjectAgentsMd(project.id);
  await recordCoworkWorkspaceMetadata({
    source: 'blueprint_create',
    workspaceId: project.id,
    change: { kind: 'blueprint', externalId: sourceTemplate.externalId },
  });
  return {
    ...project,
    description: template.description,
    ...(template.color === undefined ? {} : { color: template.color }),
    defaultPluginSelections,
    starterPrompts: template.starterPrompts,
    ...(template.startPage === undefined
      ? {}
      : { startPage: template.startPage }),
    seededFromBlueprintExternalId: sourceTemplate.externalId,
  };
}

export async function findCoworkWorkspaceTemplateInstall(
  externalId: string,
): Promise<ChatProjectData | null> {
  const sidebarItems = await readAllSidebarItems();
  const installed = sidebarItems.items.find(
    (item): item is CoworkSidebarItem =>
      isCoworkSidebarItem(item) &&
      item.installedFromTemplateExternalId === externalId,
  );
  return installed ? toChatProjectData(installed) : null;
}

export async function setCoworkWorkspaceTemplateInstallMetadata(
  projectId: string,
  sourceTemplate: { externalId: string; contentHash: string },
): Promise<void> {
  await recordCoworkWorkspaceMetadata({
    source: 'template_install',
    workspaceId: projectId,
    change: { kind: 'install', ...sourceTemplate },
  });
  // Templates are addressed by their share id; the server ignores the kind.
  recordSharedItemInstall({
    kind: 'workspace-template',
    remoteId: sourceTemplate.externalId,
    sourceKind: 'shared',
    contentHash: sourceTemplate.contentHash,
    localId: projectId,
  });
}

/**
 * Every project installed from a template, for the one-time install
 * subscription backfill. The hash is missing while an install is still
 * completing its packaged capabilities.
 */
export async function listCoworkTemplateInstallsForBackfill(): Promise<
  Array<{ workspaceId: string; externalId: string; contentHash: string | null }>
> {
  const { items } = await readAllSidebarItems();
  const installs: Array<{
    workspaceId: string;
    externalId: string;
    contentHash: string | null;
  }> = [];
  for (const item of items) {
    if (
      !isCoworkSidebarItem(item) ||
      item.installedFromTemplateExternalId === undefined
    )
      continue;
    installs.push({
      workspaceId: item.id,
      externalId: item.installedFromTemplateExternalId,
      contentHash: item.installedFromTemplateContentHash ?? null,
    });
  }
  return installs;
}

/**
 * Attaches a non-git folder as an external cowork workspace: allocates a
 * fresh id (slugified from the folder's basename, de-duplicated against
 * every existing sidebar item id) and appends a {@link CoworkSidebarItem}
 * with `externalPath` pointing at the attached folder. Unlike
 * {@link createCoworkWorkspace}, this does NOT scaffold a managed `home/`
 * directory and does NOT seed a `.{brand}/` folder inside the attached
 * folder — those are created lazily the first time the workspace actually
 * needs them. `name` defaults to the folder's basename when omitted.
 */
export async function createExternalCoworkWorkspace(
  folderPath: string,
  name?: string,
  owner?: WorkspaceOwnerBinding,
): Promise<CoworkSidebarItem> {
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    serializeWorkspaceMutation(() =>
      createExternalCoworkWorkspaceSerialized(folderPath, name, owner),
    ),
  );
}

async function createExternalCoworkWorkspaceSerialized(
  folderPath: string,
  name?: string,
  owner?: WorkspaceOwnerBinding,
): Promise<CoworkSidebarItem> {
  const newItem = await recordNewCoworkWorkspace({
    source: 'external_import',
    name: name?.trim() || basename(folderPath),
    createdAt: new Date().toISOString(),
    externalPath: folderPath,
    owner,
  });
  const workspaceId = newItem.id;
  await afterW5Commit(() => activateWorkEntryWorkspace(workspaceId));

  return newItem;
}

/**
 * Updates a cowork workspace's `name`/`color` (sidebar index entry) and its
 * `cowork` settings block (description/model/presets/search/retention). Also
 * recomputes `defaultPluginSelections` from the selected preset, mirroring
 * the legacy chat-project mirrored-selection behavior.
 */
export async function updateCoworkWorkspace(
  req: UpdateChatProjectRequest,
  commit?: W5CommitOptions,
): Promise<void> {
  // The workspace queue first, then the archive lock: the order the IPC
  // handlers take them in (the queue is re-entrant), so a direct caller
  // cannot deadlock against an IPC update.
  await serializeWorkspaceMutation(() =>
    withArchivedWorkspaceOperationLock(req.projectId, async () => {
      await commitW5BoundaryStep(
        commit,
        commit
          ? w5CompositionLocks({ index: true, manifests: [req.projectId] })
          : [],
        () =>
          recordCoworkWorkspaceMetadata({
            source: 'chat_project_update',
            workspaceId: req.projectId,
            change: { kind: 'settings', request: req },
          }),
      );
    }),
  );
}

/**
 * `projectId` is the resolved Cowork workspace; `expectedRevision` is its
 * revision (`workspace:{id}`).
 */
export interface CoworkSettingsUpdateRequest
  extends UpdateChatProjectRequest, W5BoundaryOptions {}

export interface CoworkSettingsUpdateOutcome {
  workspaceId: string;
}

const coworkSettingsUpdateOutcomeSchema = z.object({ workspaceId: z.string() });

const isCoworkRecordRefusal = (error: unknown): boolean =>
  error instanceof CoworkWorkspaceRecordRefusedError;

const runCoworkSettingsCommand =
  createW5SingleDecisionOperation<'chat_project_update'>(isCoworkRecordRefusal);

/** The runner for one call: a wire call's receipts name its principal. */
function coworkSettingsRunner(
  wire: W5WireDecisionCall<never> | undefined,
): typeof runCoworkSettingsCommand {
  return wire
    ? createW5SingleDecisionOperation<'chat_project_update'>(
        isCoworkRecordRefusal,
        wire,
      )
    : runCoworkSettingsCommand;
}

/** A refused decision: nothing landed, so no refresh is owed. */
function isRefusedCoworkSettingsDecision(error: unknown): boolean {
  return (
    error instanceof CoworkWorkspaceRecordRefusedError ||
    error instanceof W5RevisionConflictError ||
    error instanceof W5FileWriteRefusedError ||
    error instanceof IdentifierValidationError
  );
}

async function reconcileCoworkSettings(
  workspaceId: string,
  replayed: boolean,
): Promise<void> {
  await reconcileManifestPluginDefaults(workspaceId, replayed);
  try {
    // A refresh must not turn a replay into a new cleanup decision.
    await readAllSidebarItems({ persistRemovalCleanup: false });
  } catch (error) {
    logMainProcessWarn('[cowork-settings] sidebar refresh failed', {
      workspaceId,
      error,
    });
  }
  schedulePortalStructuralSync();
  notifyPortalStructureChanged();
}

/**
 * The keyed `core.workspace.cowork.update` (CAN-4719, A28′(a)): Cowork
 * settings and their preset-derived plugin defaults, with an optional
 * workspace revision and retry key, through `updateCoworkWorkspace`'s
 * commit path. Name, color, Always show, explicit plugin defaults and an
 * enclosing commit scope are refused before reservation. Callers of
 * `updateCoworkWorkspace` stay unkeyed: it never reads retry fields. The
 * renderer's `chat-project:update` projects the registered operation for a
 * save's Cowork settings, unkeyed, and `wire` is its wire call (W7b-1c).
 *
 * Chat normalization and the Auto Delete Work Entry touch run before the
 * decision, so a refused attempt can leave fresher Work Entry recency.
 * A failed touch is a typed `activity-unavailable` refusal (CAN-4743). A
 * stale-file refusal reruns both within the decision-only bound (CAN-5535).
 */
export async function updateCoworkWorkspaceSettings(
  request: CoworkSettingsUpdateRequest,
  wire?: W5WireDecisionCall<CoworkSettingsUpdateOutcome>,
): Promise<CoworkSettingsUpdateOutcome> {
  const { projectId: workspaceId, expectedRevision, idempotencyKey } = request;
  if (currentW5CommitScope())
    throw new CoworkWorkspaceRecordRefusedError(
      'invalid-request',
      'Standalone Cowork settings changes cannot join a parent commit',
    );
  const settings = admitCoworkSettingsChange(request);
  const resource = { kind: 'workspace', workspaceId } as const;
  const outcome: CoworkSettingsUpdateOutcome = { workspaceId };
  let executed = false;
  let result: CoworkSettingsUpdateOutcome;
  try {
    result = await runW5DecisionOnlyUnit('core.workspace.cowork.update', () => {
      // A later attempt can replay a same-key decision made in between.
      executed = false;
      return coworkSettingsRunner(wire)(
        {
          operation: 'core.workspace.cowork.update',
          source: 'chat_project_update',
          idempotencyKey,
          parameters: () => ({ workspaceId, settings }),
          storage: PROJECT_W5_STORAGE,
        },
        () => Promise.resolve(),
        (saved) => coworkSettingsUpdateOutcomeSchema.parse(saved),
        // `updateCoworkWorkspace` takes these locks again (re-entrant); the early
        // revision check under them refuses before the host steps run.
        (_admitted, options) => {
          executed = true;
          return serializeWorkspaceMutation(() =>
            withArchivedWorkspaceOperationLock(workspaceId, async () => {
              await checkW5ExpectedRevision(resource, expectedRevision);
              await updateCoworkWorkspace(
                { projectId: workspaceId, ...settings },
                {
                  ...options,
                  expectedRevisions: w5ExpectedRevision(
                    resource,
                    expectedRevision,
                  ),
                  ...(options.receipt ? { outcome } : {}),
                },
              );
              return outcome;
            }),
          );
        },
      );
    });
  } catch (error) {
    // Any other failure may follow a landed decision (a lost response) whose
    // post-commit refreshes were dropped with its scope.
    if (executed && !isRefusedCoworkSettingsDecision(error))
      await reconcileCoworkSettings(workspaceId, false);
    throw error;
  }
  // A replay runs no writer, and its decision may have landed without that
  // refresh, possibly after a read cached the old layer.
  if (!executed) await reconcileCoworkSettings(workspaceId, true);
  return result;
}

/** Records the identity of the share a publish created or republished. */
export async function setCoworkWorkspaceTemplateShareMetadata(
  projectId: string,
  metadata: { externalId: string; pinnedContentHash: string },
): Promise<void> {
  await recordCoworkTemplateShare({
    source: 'template_share_publish',
    workspaceId: projectId,
    change: { kind: 'share', metadata },
  });
}

/** Clears the share identity together with its publication key. */
export async function clearCoworkWorkspaceTemplateShare(
  projectId: string,
  source: CoworkTemplateShareRecordSource,
): Promise<void> {
  await recordCoworkTemplateShare({
    source,
    workspaceId: projectId,
    change: { kind: 'share', metadata: null },
  });
}

/** Records the durable retry key a first publish sends. */
export async function setCoworkWorkspaceTemplatePublicationKey(
  projectId: string,
  publicationKey: string,
): Promise<void> {
  await recordCoworkTemplateShare({
    source: 'template_share_publish',
    workspaceId: projectId,
    change: { kind: 'publication', publicationKey },
  });
}

/**
 * Defense-in-depth guard for {@link deleteCoworkWorkspace}. `getWorkspaceDir`
 * always resolves to `<dataDir>/workspaces/{id}`, which can never
 * legitimately coincide with or contain a user's external `externalPath` (a
 * path the user picked outside Canopy's data directory) — but if a
 * misconfigured data directory ever made that true, deleting the metadata
 * tree here must not also destroy the user's folder. Throws instead of
 * silently proceeding so the bug surfaces immediately rather than as data
 * loss.
 */
function assertWorkspaceMetadataDirDisjointFromExternalFolder(
  workspaceMetadataDir: string,
  externalPath: string,
): void {
  const resolvedMetadataDir = resolve(workspaceMetadataDir);
  const resolvedFolderPath = resolve(externalPath);

  const metadataDirIsInsideFolder = isPathInside(
    resolvedFolderPath,
    resolvedMetadataDir,
  );
  const folderIsInsideMetadataDir = isPathInside(
    resolvedMetadataDir,
    resolvedFolderPath,
  );

  if (metadataDirIsInsideFolder || folderIsInsideMetadataDir) {
    throw new Error(
      'Refusing to delete cowork project: its metadata directory and external folder overlap.',
    );
  }
}

/**
 * Deletes or detaches a cowork workspace, depending on whether it is
 * managed or external:
 *
 * - **Managed** (no `externalPath`): purges persisted worktree-scoped data
 *   (chat tabs, archives, attachments, browser state, observability, etc. —
 *   everything `cleanupPersistedWorktreeData` already handles for the
 *   `(workspaceId, 'home')` pair), removes the entire `workspaces/{id}/`
 *   tree — which holds both the Canopy metadata and the managed `home/`
 *   folder the user was working in — and removes the workspace from the
 *   sidebar index.
 * - **External** (`externalPath` set): this is a detach, not a delete. The
 *   same `cleanupPersistedWorktreeData` purge and `workspaces/{id}/` removal
 *   run, but that tree only ever holds Canopy-side metadata for an external
 *   workspace (no `home/` folder is ever scaffolded there — see
 *   {@link createExternalCoworkWorkspace}). The attached folder itself, and
 *   its lazily-created `.{brand}/` managed subfolder, live entirely outside
 *   `workspaces/{id}/` at the user's own `externalPath` and are never touched.
 *   {@link assertWorkspaceMetadataDirDisjointFromExternalFolder} guards that
 *   invariant defensively before any removal happens.
 *
 * Rejects deleting {@link DEFAULT_COWORK_WORKSPACE_ID}: this is the one
 * cowork workspace `listCoworkWorkspacesAsChatProjects` guarantees always
 * exists, mirroring the old "Default project cannot be deleted" rule (minus
 * the old move-into-default chat disposition, which no longer has a
 * privileged merge target — see the cowork-workspace-unification design doc).
 */
export async function deleteCoworkWorkspace(
  workspaceId: string,
  options: {
    /**
     * Removes the index entry. The caller, `deleteWorkspace`, owns this
     * commit and the project's watcher fence, cancellation and commit.
     */
    commitIndexRemoval: () => Promise<void>;
  },
): Promise<void> {
  validateId(workspaceId, 'projectId');

  if (isDefaultCoworkWorkspaceId(workspaceId)) {
    throw new Error(
      `The ${DEFAULT_COWORK_WORKSPACE_NAME} project cannot be deleted`,
    );
  }

  const [indexEntry, { items }, config] = await settleAll([
    readWorkspaceIndexEntry(workspaceId),
    readAllSidebarItems(),
    readWorkspaceConfigDetailed(workspaceId),
  ]);
  const existing = items.find(
    (item): item is CoworkSidebarItem =>
      isCoworkSidebarItem(item) && item.id === workspaceId,
  );
  if (!existing && indexEntry?.type !== 'cowork') {
    throw new Error('Chat project not found');
  }
  // `deleteWorkspace` refuses this before any effect; this covers a
  // configuration that became unreadable since (CAN-4975).
  if (config.authority === 'unreadable') {
    throw new Error(
      'Refusing to delete cowork project: its configuration could not be read, so its external folder is unknown.',
    );
  }

  const workspaceMetadataDir = getWorkspaceDir(workspaceId);
  // The independent sidebar read may have lost this path to an unreadable config.
  if (config.config.externalPath !== undefined) {
    assertWorkspaceMetadataDirDisjointFromExternalFolder(
      workspaceMetadataDir,
      config.config.externalPath,
    );
  }

  // Defer browser lifecycle/session initialization until deletion actually
  // runs; importing this heavy Electron-main boundary during CRUD setup is unnecessary.
  const {
    prepareWorkspaceBrowserRetirement,
    commitTaskBrowserRetirement,
    abortTaskBrowserRetirement,
  } = await import('../browser/browser-profile-lifecycle');
  const browserRetirements =
    await prepareWorkspaceBrowserRetirement(workspaceId);
  let ownerCommitted = false;
  try {
    // Stop each entry before deleting the parent; native profile cleanup waits for the index commit.
    const entryIds = await listWorkEntryIds(workspaceId);
    for (const worktreeId of [...entryIds, COWORK_HOME_WORKTREE_ID]) {
      await cleanupPersistedWorktreeData(workspaceId, worktreeId, {
        deferLocalWatcherCancellationCommit: true,
      });
    }
    await destructiveStep('cowork-summaries-removal', () =>
      clearWorkEntrySummariesForWorkspace(workspaceId),
    );
    await destructiveStep('workspace-non-w5-children-removal', () =>
      removeWorkspaceNonW5Children(workspaceId),
    );
    await options.commitIndexRemoval();
    ownerCommitted = true;
    if (existing?.installedFromTemplateExternalId !== undefined)
      recordSharedItemUninstall({
        kind: 'workspace-template',
        remoteId: existing.installedFromTemplateExternalId,
        sourceKind: 'shared',
        localId: workspaceId,
      });
    for (const entry of browserRetirements)
      await destructiveStep('browser-retirement', () =>
        commitTaskBrowserRetirement(workspaceId, entry.worktreeId),
      );
    await destructiveStep('workspace-directory-removal', () =>
      removeWorkspaceDirectoryAfterRecordRemoval(workspaceId),
    );
  } catch (error) {
    if (!ownerCommitted) {
      for (const entry of browserRetirements)
        await abortTaskBrowserRetirement(entry.operationId);
      activateWorkEntryWorkspace(workspaceId);
    }
    throw error;
  } finally {
    if (ownerCommitted)
      projectPluginDefaultsWritten({
        configPath: w5RecordReadPaths.manifest(workspaceId),
        workspaceId,
        layerChanged: true,
      });
  }
}

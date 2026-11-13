import { broadcastOrgProjectOwnershipChanged } from './org-project-ownership-broadcast';
import { getOrganizationAccessLossService } from '../services/organization-access-loss-service';
import { registerPersonalOrganizationUpgradeHandlers } from './personal-organization-upgrade';
import { getObservabilityService } from '../observability';
import {
  listOrgProjectRelationships,
  decideOrgProjectRelationship,
} from '../services/org-project-relationship-service';
import type {
  OrgProjectConversionResult,
  OrgProjectConvertWorkspaceRequest,
  OrgProjectLinksListResult,
  OrgProjectMoveBackResult,
  OrgProjectMoveRequest,
  OrgProjectMoveResult,
  CreateOrgMemberCodeProjectRequest,
  CreateOrgMemberCodeProjectResult,
  CreateOrgMemberMultiRepoProjectRequest,
  CreateOrgMemberMultiRepoProjectResult,
  OrgMemberFolderInspection,
  OrgMultiRepoRepositoryCheckRequest,
  OrgMultiRepoRepositoryCheckResult,
  OrgRepositoryOwnerLookup,
  OrgRepositoryOwnerRequest,
} from '@canopy/desktop-shared/types';
import {
  ORG_REPOSITORY_OWNER_URL_MAX_LENGTH,
  type OrgProjectDeepLinkOpenEvent,
} from '@canopy/protocol/org-projects';
import { getOrgProjectMaterialization } from '../lib/org-project-materialization';
import { BrowserWindow } from 'electron';
import { isAbsolute } from 'node:path';
import {
  IPC_CHANNELS,
  isWorkspaceContext,
  type DesktopOrgProjectCatalogSnapshot,
  type OrgProjectsListRequest,
  type OrgProjectsRefreshRequest,
  type OrgProjectsSetPreferenceRequest,
} from '@canopy/desktop-shared/types';
import {
  isOrgProjectPreference,
  type OrgProjectSetupProgress,
} from '@canopy/protocol/org-projects';
import { validateAbsolutePath, validateId } from '../lib/validation';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';
import { registerIpcHandler } from './register';
import { sendToWebContents } from '../lib/web-contents-send';
import { getOrgMemberCodeEligibility } from '../lib/org-cowork-binding-deps';
import { getOrgMemberFolderInspector } from '../lib/org-member-folder-inspection';
import { getOrgRepositoryOwnerLookup } from '../lib/org-repository-owner';
import { getOrgMemberCodeCreator } from '../lib/org-member-code-create-deps';
import { getOrgMemberMultiRepoCreator } from '../lib/org-member-multi-repo-create-deps';
import { getOrgMemberMultiRepoSync } from '../lib/org-member-multi-repo-sync-deps';
import { getOrgProjectMover } from '../lib/org-project-move-deps';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { disabledOrgProjectCatalog as disabledCatalog } from '../lib/org-project-catalog-gate';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseContextRequest(value: unknown): OrgProjectsListRequest {
  if (!isRecord(value) || !isWorkspaceContext(value.context)) {
    throw new Error('Invalid workspace context.');
  }
  if (value.context.kind === 'organization') {
    validateId(value.context.organizationId, 'organization id');
  }
  return { context: value.context };
}

function parseRefreshRequest(value: unknown): OrgProjectsRefreshRequest {
  const { context } = parseContextRequest(value);
  const force = isRecord(value) && value.force === true;
  const repositories = isRecord(value) && value.repositories === true;
  return {
    context,
    ...(force ? { force: true } : {}),
    ...(repositories ? { repositories: true } : {}),
  };
}

function parseSetPreferenceRequest(
  value: unknown,
): OrgProjectsSetPreferenceRequest {
  const { context } = parseContextRequest(value);
  if (!isRecord(value)) {
    throw new Error('Invalid preference request.');
  }
  validateId(value.projectId, 'project id');
  if (!isOrgProjectPreference(value.preference)) {
    throw new Error('Invalid project preference.');
  }
  return { context, projectId: value.projectId, preference: value.preference };
}

function parseConvertRequest(
  value: unknown,
): OrgProjectConvertWorkspaceRequest {
  if (!isRecord(value)) throw new Error('Invalid conversion request');
  validateId(value.workspaceId, 'workspace id');
  validateId(value.organizationId, 'organization id');
  validateId(value.projectId, 'project id');
  return {
    workspaceId: value.workspaceId,
    organizationId: value.organizationId,
    projectId: value.projectId,
  };
}

function parseMoveRequest(value: unknown): OrgProjectMoveRequest {
  if (!isRecord(value)) throw new Error('Invalid move request');
  validateId(value.workspaceId, 'workspace id');
  validateId(value.organizationId, 'organization id');
  return {
    workspaceId: value.workspaceId,
    organizationId: value.organizationId,
  };
}

function parseMoveBackRequest(value: unknown): { workspaceId: string } {
  if (!isRecord(value)) throw new Error('Invalid move back request');
  validateId(value.workspaceId, 'workspace id');
  return { workspaceId: value.workspaceId };
}

function parseSetupRequest(value: unknown): { projectId: string } {
  if (!isRecord(value)) throw new Error('Invalid setup request');
  validateId(value.projectId, 'project id');
  return { projectId: value.projectId };
}

function parseOrganizationId(value: unknown): string {
  validateId(value, 'organization id');
  return value;
}

function parseFolderRequest(value: unknown): {
  organizationId: string;
  path: string;
} {
  if (!isRecord(value) || typeof value.path !== 'string')
    throw new Error('Invalid folder inspection request');
  return {
    organizationId: parseOrganizationId(value.organizationId),
    path: value.path,
  };
}

/** Host paths stay on the desktop-only request. */
const MAX_OWNER_LOOKUP_PATH_LENGTH = 4096;

/** Exactly one of an absolute folder path or a bounded clone URL. */
function parseRepositoryOwnerRequest(
  value: unknown,
): OrgRepositoryOwnerRequest {
  if (!isRecord(value)) throw new Error('Invalid repository owner request');
  const { path, remoteUrl } = value;
  if (path !== undefined && remoteUrl === undefined) {
    if (typeof path !== 'string' || path.length > MAX_OWNER_LOOKUP_PATH_LENGTH)
      throw new Error('Invalid repository owner request');
    validateAbsolutePath(path, 'folder path');
    return { path };
  }
  if (
    path === undefined &&
    typeof remoteUrl === 'string' &&
    remoteUrl.trim().length > 0 &&
    remoteUrl.length <= ORG_REPOSITORY_OWNER_URL_MAX_LENGTH
  )
    return { remoteUrl };
  throw new Error('Invalid repository owner request');
}

function parseCreateCodeRequest(
  value: unknown,
): CreateOrgMemberCodeProjectRequest {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    (value.folderPath !== undefined && typeof value.folderPath !== 'string') ||
    (value.privateMemory !== undefined &&
      typeof value.privateMemory !== 'boolean')
  )
    throw new Error('Invalid member Code project request');
  const organizationId = parseOrganizationId(value.organizationId);
  if (value.organizationProjectId !== undefined)
    validateId(value.organizationProjectId, 'project id');
  return {
    organizationId,
    name: value.name,
    ...(typeof value.privateMemory === 'boolean'
      ? { privateMemory: value.privateMemory }
      : {}),
    ...(typeof value.folderPath === 'string'
      ? { folderPath: value.folderPath }
      : {}),
    ...(typeof value.organizationProjectId === 'string'
      ? { organizationProjectId: value.organizationProjectId }
      : {}),
  };
}

function parseCreateMultiRepoRequest(
  value: unknown,
): CreateOrgMemberMultiRepoProjectRequest {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    (value.folderPath !== undefined && typeof value.folderPath !== 'string') ||
    (value.privateMemory !== undefined &&
      typeof value.privateMemory !== 'boolean')
  )
    throw new Error('Invalid member multi-repo project request');
  const organizationId = parseOrganizationId(value.organizationId);
  if (value.localWorkspaceId !== undefined)
    validateId(value.localWorkspaceId, 'workspaceId');
  return {
    organizationId,
    name: value.name,
    ...(typeof value.privateMemory === 'boolean'
      ? { privateMemory: value.privateMemory }
      : {}),
    ...(typeof value.folderPath === 'string'
      ? { folderPath: value.folderPath }
      : {}),
    ...(typeof value.localWorkspaceId === 'string'
      ? { localWorkspaceId: value.localWorkspaceId }
      : {}),
  };
}

/** Settings lists at most this many repositories to check at once. */
const MAX_CHECKED_REPOSITORIES = 500;
const MAX_CHECKED_REPOSITORY_LENGTH = 4096;

function parseCheckedStrings(
  value: unknown,
  absolutePaths: boolean,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_CHECKED_REPOSITORIES)
    throw new Error('Invalid repository check request');
  return value.map((entry: unknown): string => {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > MAX_CHECKED_REPOSITORY_LENGTH ||
      (absolutePaths && !isAbsolute(entry))
    )
      throw new Error('Invalid repository check request');
    return entry;
  });
}

function parseCheckRepositoriesRequest(
  value: unknown,
): OrgMultiRepoRepositoryCheckRequest {
  if (!isRecord(value)) throw new Error('Invalid repository check request');
  validateId(value.workspaceId, 'workspace id');
  const repoPaths = parseCheckedStrings(value.repoPaths, true);
  const remoteUrls = parseCheckedStrings(value.remoteUrls, false);
  return {
    workspaceId: value.workspaceId,
    ...(repoPaths ? { repoPaths } : {}),
    ...(remoteUrls ? { remoteUrls } : {}),
  };
}

let stopMaterializationOwnershipBroadcast: (() => void) | undefined;
let stopAccessLossOwnershipBroadcast: (() => void) | undefined;

export function registerOrgProjectsHandlers(): void {
  registerPersonalOrganizationUpgradeHandlers();
  registerIpcHandler<[], OrgProjectLinksListResult>(
    IPC_CHANNELS.orgProjectLinksList,
    async (): Promise<OrgProjectLinksListResult> => {
      try {
        const result = await listOrgProjectRelationships();
        if (result.status === 'unknown')
          getObservabilityService().recordSessionDiagnostic({
            version: 1,
            timestamp: new Date().toISOString(),
            kind: 'org_project_links_unknown',
            reason: result.reason,
            sessionKey: 'org-project-links',
            projectId: '',
            worktreeId: '',
            chatId: '',
            providerType: 'unknown',
          });
        return result;
      } catch (error) {
        getObservabilityService().recordSessionDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'org_project_links_unknown',
          reason: 'request-failed',
          sessionKey: 'org-project-links',
          projectId: '',
          worktreeId: '',
          chatId: '',
          providerType: 'unknown',
        });
        throw error;
      }
    },
  );
  registerIpcHandler<[unknown], OrgProjectDeepLinkOpenEvent | null>(
    IPC_CHANNELS.orgProjectLinksDecide,
    async (_event, request): Promise<OrgProjectDeepLinkOpenEvent | null> => {
      if (isRecord(request) === false)
        throw new Error('Invalid relationship request');
      validateId(request.projectId, 'project id');
      validateId(request.personalWorkspaceId, 'personal workspace id');
      const decision = request.decision;
      if (decision === 'dismiss' || decision === 'view') {
        return decideOrgProjectRelationship({
          projectId: request.projectId,
          personalWorkspaceId: request.personalWorkspaceId,
          decision,
        });
      }
      throw new Error('Invalid relationship decision');
    },
  );
  const materialization = getOrgProjectMaterialization();
  registerIpcHandler<[unknown], 'eligible' | 'ineligible'>(
    IPC_CHANNELS.orgProjectsMemberCodeEligibility,
    async (_event, organizationId) =>
      getOrgMemberCodeEligibility(parseOrganizationId(organizationId)),
  );
  registerIpcHandler<[unknown], OrgMemberFolderInspection>(
    IPC_CHANNELS.orgProjectsInspectFolder,
    async (_event, request) => {
      const parsed = parseFolderRequest(request);
      return getOrgMemberFolderInspector().inspect(
        parsed.organizationId,
        parsed.path,
      );
    },
  );
  // The hybrid model's create-time nudge: advisory, so the lookup answers
  // `none` on every failure and only a malformed request rejects.
  registerIpcHandler<[unknown], OrgRepositoryOwnerLookup>(
    IPC_CHANNELS.orgProjectsFindRepositoryOwner,
    async (_event, request) =>
      getOrgRepositoryOwnerLookup().find(parseRepositoryOwnerRequest(request)),
  );
  registerIpcHandler<[unknown], CreateOrgMemberCodeProjectResult>(
    IPC_CHANNELS.orgProjectsCreateMemberCodeProject,
    async (_event, request) =>
      getOrgMemberCodeCreator().create(parseCreateCodeRequest(request)),
  );
  registerIpcHandler<[unknown], CreateOrgMemberMultiRepoProjectResult>(
    IPC_CHANNELS.orgProjectsCreateMemberMultiRepoProject,
    async (_event, request) =>
      getOrgMemberMultiRepoCreator().create(
        parseCreateMultiRepoRequest(request),
      ),
  );
  registerIpcHandler<[unknown], OrgMultiRepoRepositoryCheckResult>(
    IPC_CHANNELS.orgProjectsCheckRepositories,
    async (_event, request) =>
      getOrgMemberMultiRepoSync().checkRepositories(
        parseCheckRepositoriesRequest(request),
      ),
  );
  registerIpcHandler<[unknown], OrgProjectSetupProgress>(
    IPC_CHANNELS.orgProjectsSetupFromFolder,
    async (_event, request) => {
      if (!isRecord(request) || typeof request.path !== 'string')
        throw new Error('Invalid setup from folder request');
      validateId(request.projectId, 'project id');
      const context = getWorkspaceContextService().getState().context;
      if (context.kind !== 'organization')
        throw new Error('Select an organization to set up this project');
      const inspection = await getOrgMemberFolderInspector().inspect(
        context.organizationId,
        request.path,
      );
      if (inspection.kind !== 'code')
        throw new Error('Choose the top folder of a git repository');
      if (inspection.personalWorkspaceId !== undefined) {
        const converted = await materialization.convertWorkspace(
          {
            workspaceId: inspection.personalWorkspaceId,
            organizationId: context.organizationId,
            projectId: request.projectId,
          },
          { memberCreated: true },
        );
        return {
          projectId: request.projectId,
          instanceId: converted.ok ? converted.owner.instanceId : null,
          state: converted.ok ? 'ready' : 'failed',
          message: converted.ok ? 'Ready' : 'Project setup failed',
          percent: null,
          updatedAt: new Date().toISOString(),
          ...(!converted.ok ? { errorCode: converted.code } : {}),
        };
      }
      return materialization.setupFromFolder(request.projectId, request.path);
    },
  );
  materialization.subscribe((progress): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        sendToWebContents(
          window.webContents,
          IPC_CHANNELS.orgProjectsSetupProgress,
          progress,
        );
    }
  });
  registerIpcHandler<[unknown], OrgProjectSetupProgress>(
    IPC_CHANNELS.orgProjectsSetupStart,
    async (_event, request: unknown): Promise<OrgProjectSetupProgress> => {
      const { projectId } = parseSetupRequest(request);
      // Filesystem validation and typed failures belong to the coordinator.
      const destinationRoot =
        isRecord(request) && typeof request.destinationRoot === 'string'
          ? request.destinationRoot
          : '';
      return materialization.startSetup(projectId, destinationRoot);
    },
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.orgProjectsSetupCancel,
    async (_event, request: unknown) =>
      materialization.cancelSetup(parseSetupRequest(request).projectId),
  );
  // The sidebar's Move to organization: the member picks the organization in
  // the dialog. The mover checks membership-scoped eligibility per
  // organization, so the selected context never widens or switches.
  registerIpcHandler<[unknown], OrgProjectMoveResult>(
    IPC_CHANNELS.orgProjectsMoveWorkspace,
    async (_event, request: unknown): Promise<OrgProjectMoveResult> =>
      getOrgProjectMover().move(parseMoveRequest(request)),
  );
  // CAN-3415: direct conversion stays service-level; the sidebar's Move goes
  // through the mover above. The coordinator refuses conversion while the
  // flag is off; moving back stays available as the rollback, like the
  // server's detach recovery route.
  registerIpcHandler<[unknown], OrgProjectConversionResult>(
    IPC_CHANNELS.orgProjectsConvertWorkspace,
    async (_event, request: unknown): Promise<OrgProjectConversionResult> =>
      materialization.convertWorkspace(parseConvertRequest(request)),
  );
  registerIpcHandler<[unknown], OrgProjectMoveBackResult>(
    IPC_CHANNELS.orgProjectsMoveBackToPersonal,
    async (_event, request: unknown): Promise<OrgProjectMoveBackResult> =>
      materialization.moveBackToPersonal(parseMoveBackRequest(request)),
  );
  stopMaterializationOwnershipBroadcast?.();
  stopAccessLossOwnershipBroadcast?.();
  stopMaterializationOwnershipBroadcast = materialization.onOwnershipChanged(
    broadcastOrgProjectOwnershipChanged,
  );
  stopAccessLossOwnershipBroadcast =
    getOrganizationAccessLossService().onOwnershipChanged(
      broadcastOrgProjectOwnershipChanged,
    );
  const service = getOrgProjectCatalogService();

  service.subscribe((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        sendToWebContents(
          window.webContents,
          IPC_CHANNELS.orgProjectsChanged,
          snapshot,
        );
      }
    }
  });

  // Async handlers so a validation failure rejects the invoke instead of
  // throwing synchronously into the IPC dispatcher.
  registerIpcHandler<[unknown], DesktopOrgProjectCatalogSnapshot>(
    IPC_CHANNELS.orgProjectsList,
    async (_event, request): Promise<DesktopOrgProjectCatalogSnapshot> => {
      const { context } = parseContextRequest(request);
      return disabledCatalog(context) ?? service.list(context);
    },
  );

  registerIpcHandler<[unknown], DesktopOrgProjectCatalogSnapshot>(
    IPC_CHANNELS.orgProjectsRefresh,
    async (_event, request) => {
      const parsed = parseRefreshRequest(request);
      return (
        disabledCatalog(parsed.context) ??
        service.refresh(parsed.context, {
          force: parsed.force === true,
          ...(parsed.repositories === true ? { repositories: true } : {}),
        })
      );
    },
  );

  registerIpcHandler<[unknown], DesktopOrgProjectCatalogSnapshot>(
    IPC_CHANNELS.orgProjectsSetPreference,
    async (_event, request) => {
      const parsed = parseSetPreferenceRequest(request);
      return (
        disabledCatalog(parsed.context) ??
        service.setPreference(
          parsed.context,
          parsed.projectId,
          parsed.preference,
        )
      );
    },
  );
}

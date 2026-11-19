import { randomUUID } from 'node:crypto';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { isRetiredTemporaryWorkspace } from '@canopy/desktop-shared/lib/workspace-visibility';
import { getCanopyCloudCredentials } from '../lib/canopy-cloud-account-store';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { readAllSidebarItemsSnapshot } from '../lib/sidebar-items';
import { readPersonalProjectPreviewRows } from './personal-project-preview-rows';
import { readWorkspaceOwnership } from '../lib/workspace-persistence';
import { getOrgMemberCodeCreator } from '../lib/org-member-code-create-deps';
import { getOrgMemberMultiRepoCreator } from '../lib/org-member-multi-repo-create-deps';
import { getOrgProjectCatalogService } from './org-project-catalog-service';
import { createPersonalOrganizationUpgradeJournal } from '../lib/personal-organization-upgrade-journal';
import {
  getPersonalOrganizationUpgradeFilePath,
  getOrgProjectMigrationPassesFilePath,
  getWorkspaceDir,
} from '../lib/paths';
import { createOrgProjectMigrationPassStore } from '../lib/org-project-migration-passes';
import {
  createPersonalOrganizationUpgradeService,
  type UpgradeWorkspace,
  type UpgradeIdentity,
  type PersonalOrganizationUpgradeService,
} from './personal-organization-upgrade';
import {
  personalOrganizationUpgradeCredentials,
  promotePersonalOrganization,
  inviteToOrganization,
  shareMemberProject,
  readPersonalProjectConversionPolicy,
  readOrganizationInvitationStatus,
} from '../canopy-cloud/personal-organization-upgrade';
import {
  requestCanopyCloudJson,
  CanopyCloudClientError,
} from '../canopy-cloud/client';
import type { OrgProjectDetail } from '@canopy/protocol/org-projects';
import { reprobeAndApplyCanopyCloudEnforcedSettings } from '../ipc/settings';
import { getObservabilityService } from '../observability';
import { isMovablePersonalProject } from './org-project-auto-conversion';
import { sendToAllWindows } from '../lib/window-send';
import {
  recordInviteSendTelemetry,
  recordOrganizationCreateTelemetry,
} from '../lib/desktop-telemetry';

let service:
  | ReturnType<typeof createPersonalOrganizationUpgradeService>
  | undefined;
export function getPersonalOrganizationUpgradeAccountEpoch(): number {
  return getWorkspaceContextService().accountEpoch();
}

async function identity(): Promise<UpgradeIdentity> {
  const context = getWorkspaceContextService();
  const epoch = getPersonalOrganizationUpgradeAccountEpoch();
  const credentials = await getCanopyCloudCredentials();
  const accountId = credentials.account?.id;
  if (!accountId || context.accountEpoch() !== epoch)
    throw new Error('account-changed');
  return {
    accountId,
    epoch,
    credentials: await personalOrganizationUpgradeCredentials(accountId),
  };
}
export function getPersonalOrganizationUpgradeService(): PersonalOrganizationUpgradeService {
  service ??= createPersonalOrganizationUpgradeService({
    identity,
    // Portal is retired (CAN-5986): no desktop session can be current, so
    // work bound to one never resumes.
    sessionCurrent: () => false,
    destination: async (organizationId, captured) => {
      const policy = await readPersonalProjectConversionPolicy(
        captured.accountId,
      );
      return (
        policy.organizationIds.includes(organizationId) &&
        captured.credentials.capabilities?.includes(
          'org-member-code-projects-v1',
        ) === true
      );
    },
    previewProjects: readPersonalProjectPreviewRows,
    async workspaces(selected) {
      const snapshot = await readAllSidebarItemsSnapshot();
      if (
        snapshot.indexAuthority !== 'ok' &&
        snapshot.indexAuthority !== 'absent'
      )
        throw new Error('Workspace index unavailable');
      if (selected) {
        const ids = new Set(selected.workspaceIds);
        for (const warning of snapshot.file.warnings ?? []) {
          if (
            warning.code !== 'invalid-canopy-json' ||
            !ids.has(warning.workspaceId)
          )
            continue;
          const ownership = await readWorkspaceOwnership(warning.workspaceId);
          if (ownership.authority === 'ok' && !ownership.owner)
            selected.reportInvalidConfig(warning.workspaceId);
        }
      }
      const workspaces: UpgradeWorkspace[] = [];
      for (const item of snapshot.file.items) {
        if (item.type !== 'single-repo' && item.type !== 'multi-repo') continue;
        if (isRetiredTemporaryWorkspace(item)) continue;
        const read = await readWorkspaceOwnership(item.id);
        if (read.authority !== 'ok') continue;
        if (
          !isMovablePersonalProject({
            id: item.id,
            repoPath: item.type === 'single-repo' ? item.repoPath : null,
            ...(item.type === 'multi-repo'
              ? { repoPaths: item.repos.map((repo) => repo.repoPath) }
              : {}),
          })
        )
          continue;
        const path =
          item.type === 'single-repo'
            ? item.repoPath
            : (item.sourceRepoPath ?? getWorkspaceDir(item.id));
        if (!path) continue;
        workspaces.push({
          workspaceId: item.id,
          name: item.name,
          kind: item.type,
          path,
          ...(read.owner
            ? {
                owner: {
                  organizationId: read.owner.organizationId,
                  projectId: read.owner.projectId,
                },
              }
            : {}),
        });
      }
      return workspaces;
    },
    promote: (request, captured) =>
      promotePersonalOrganization(request, captured.credentials),
    onPromotion: (result) => {
      if (!result.alreadyUpgraded)
        recordOrganizationCreateTelemetry({
          creationMethod: 'promote_personal',
          inviteIncluded: false,
          projectCount: 0,
        });
    },
    suppress: async (organizationId) => {
      const now = new Date().toISOString();
      await createOrgProjectMigrationPassStore(
        getOrgProjectMigrationPassesFilePath,
      ).update((file) => ({
        ...file,
        organizations: {
          ...file.organizations,
          [organizationId]: {
            ...file.organizations[organizationId],
            startedAt: file.organizations[organizationId]?.startedAt ?? now,
            eligibleWorkspaceIds:
              file.organizations[organizationId]?.eligibleWorkspaceIds ?? [],
            completedAt: now,
          },
        },
      }));
    },
    async refreshAccount(captured) {
      const before = await identity();
      if (
        before.accountId !== captured.accountId ||
        before.epoch !== captured.epoch
      )
        throw new Error('account-changed');
      await reprobeAndApplyCanopyCloudEnforcedSettings();
      await getWorkspaceContextService().whenIdle();
      const after = await identity();
      // This refresh may publish one same-account event; any further epoch is external.
      if (
        after.accountId !== before.accountId ||
        after.credentials.apiKey !== before.credentials.apiKey ||
        after.epoch < before.epoch ||
        after.epoch > before.epoch + 1
      )
        throw new Error('account-changed');
      return after;
    },
    async switchContext(organizationId) {
      await getWorkspaceContextService().whenIdle();
      await getWorkspaceContextService().setContext({
        kind: 'organization',
        organizationId,
      });
      sendToAllWindows(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, {
        requestId: randomUUID(),
      });
    },
    invite: (organizationId, request, captured) =>
      inviteToOrganization(organizationId, request, captured.credentials),
    onInvite: (result) =>
      recordInviteSendTelemetry({
        inviteType: 'organization',
        inviteId: result.inviteId,
        recipientKind: 'email',
        sendSurface: 'invite_dialog',
        delivery: result.status,
      }),
    inviteStatus: (organizationId, email, captured) =>
      readOrganizationInvitationStatus(
        organizationId,
        email,
        captured.credentials,
      ),
    createSingle: (
      workspace,
      organizationId,
      creationKey,
      projectId,
      options,
    ) =>
      getOrgMemberCodeCreator().create(
        {
          organizationId,
          name: workspace.name,
          folderPath: workspace.path,
          creationKey,
          ...(projectId ? { organizationProjectId: projectId } : {}),
        },
        options,
      ),
    createMulti: (workspace, organizationId, options) =>
      getOrgMemberMultiRepoCreator().create(
        {
          organizationId,
          name: workspace.name,
          localWorkspaceId: workspace.workspaceId,
          folderPath: workspace.path,
        },
        options,
      ),
    async share(organizationId, projectId, captured) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const detail = await requestCanopyCloudJson<OrgProjectDetail>(
          `/api/v1/projects/${encodeURIComponent(projectId)}/share-with-organization`,
          { credentialContext: captured.credentials },
        );
        if (detail.organizationId !== organizationId)
          throw new Error('Project destination changed');
        const current = await identity();
        if (
          current.accountId !== captured.accountId ||
          current.epoch !== captured.epoch
        )
          throw new Error('account-changed');
        try {
          await shareMemberProject(
            { projectId, authorizationVersion: detail.authorizationVersion },
            captured.credentials,
          );
          return;
        } catch (error) {
          if (
            !(error instanceof CanopyCloudClientError) ||
            error.serverCode !== 'conflict' ||
            attempt === 1
          )
            throw error;
        }
      }
    },
    async refreshCatalog(organizationId) {
      const snapshot = await getOrgProjectCatalogService().refresh(
        { kind: 'organization', organizationId },
        { force: true },
      );
      if (snapshot.error || snapshot.stale)
        throw new Error('Catalog refresh unavailable');
    },
    journal: createPersonalOrganizationUpgradeJournal(
      getPersonalOrganizationUpgradeFilePath,
    ),
    now: () => new Date().toISOString(),
  });
  return service;
}

export function startPersonalOrganizationUpgradeRecovery(): void {
  const context = getWorkspaceContextService();
  const resume = (): void => {
    void context
      .whenIdle()
      .then(() => getPersonalOrganizationUpgradeService().resume())
      .catch((error: unknown): void => {
        getObservabilityService().recordAppDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'startup_background_task_failed',
          reason: 'personal_organization_upgrade_recovery',
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
  context.subscribe(resume);
  resume();
}

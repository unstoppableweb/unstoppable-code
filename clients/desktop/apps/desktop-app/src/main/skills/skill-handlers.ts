import {
  annotateSharedSkillInstalls,
  assertStoredSkillContext,
  filterStoredSkillContexts,
  getSharedSkillWithInstallState,
} from './skill-install-context';
import {
  toShareOperationResult,
  withShareStage,
} from '../sharing/share-operation-result';
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import type {
  AnalyzeSkillCapabilityPackageRequest,
  CommitSkillCapabilityPackageRequest,
  InstallSkillCapabilityPackageRequest,
  CreateSharedSkillRequest,
  DeleteSharedSkillRequest,
  ListSharedSkillsRequest,
  SaveCustomSkillRequest,
  RecordSkillShareOriginRequest,
  SkillUpdateProgress,
  UpdateSharedSkillRequest,
  WriteRawSkillRequest,
} from '@canopy/desktop-shared/types/skills';
import type { IpcMainInvokeEvent } from 'electron';
import { BrowserWindow } from 'electron';
import {
  analyzeSkillCapabilityPackage,
  cancelPackageAnalysis,
  createSubjectCapabilityPackage,
} from '../pipelines/pipeline-package-service';
import { installSkillCapabilityPackage } from './skill-package-install';
import { analyzeSkillFromDisk } from './analyze-skill-package';
import {
  getSkillDependencyReadiness,
  normalizeSkillDependencyReadinessRequest,
} from './skill-dependency-readiness';
import {
  assertCanopyCloudCapability,
  resolveCanopyCloudCredentialContext,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import { registerIpcHandler } from '../ipc/register';
import { refreshInvocableInventoryAfterMutation } from '../plugins/invocable-inventory-service';
import * as service from './skill-service';
import {
  checkSkillUpdatesThroughCore,
  fetchAvailableSkillsThroughCore,
  installSkillsThroughCore,
  listSkillFilesThroughCore,
  readSkillFileThroughCore,
  removeSkillThroughCore,
  saveCustomSkillThroughCore,
  updateSkillThroughCore,
} from '../canopy-runtime/skill-catalog-dispatch';
import { listDesktopPublisherSkills } from './publisher-marketplace';
import {
  createSharedSkill,
  deleteSharedSkill,
  listSharedSkills,
  publishSkillPublicShare,
  revokeSkillPublicShare,
  updateSharedSkill,
} from './canopy-server-client';
import { insertCapabilityPackageInstallIfAbsent } from '../pipelines/pipeline-package-install-store';
import { getPipelinePackageInstallStorePath } from '../lib/paths';
import { sendToWebContents } from '../lib/web-contents-send';

const SKILLS_CAPABILITY = 'skills-crud-v1';

async function assertSkillsSupported(
  credentials?: CanopyCloudCredentialContext,
): Promise<void> {
  if (credentials) {
    await assertCanopyCloudCapability(SKILLS_CAPABILITY, credentials);
  } else {
    await assertCanopyCloudCapability(SKILLS_CAPABILITY);
  }
}

async function resolveSkillShareCredentials(): Promise<{
  credentialContext: CanopyCloudCredentialContext;
  accountId: string;
}> {
  const credentialContext = await resolveCanopyCloudCredentialContext();
  const accountId = credentialContext.account?.id.trim();
  if (!accountId) {
    throw new Error('The connected account could not be identified.');
  }
  return { credentialContext, accountId };
}

/*
 * The window's skill calls a shared import makes, as owners, so App Advisor's
 * imports in Electron main make the same ones (CAN-6003).
 */

export async function loadSkillsForCaller(): Promise<
  ReturnType<typeof service.loadSkills>
> {
  const result = service.loadSkills();
  if (result.success && result.data)
    return {
      ...result,
      data: await annotateSharedSkillInstalls(
        await filterStoredSkillContexts(result.data),
      ),
    };
  return result;
}

export async function writeRawSkillForCaller(
  input: WriteRawSkillRequest,
): Promise<Awaited<ReturnType<typeof service.writeRawSkillForContext>>> {
  const result = await service.writeRawSkillForContext(input);
  refreshInvocableInventoryAfterMutation('skills:write-raw');
  return result;
}

export async function getSharedSkillForCaller(
  skillId: string,
): Promise<Awaited<ReturnType<typeof getSharedSkillWithInstallState>>> {
  await assertSkillsSupported();
  return getSharedSkillWithInstallState(skillId);
}

export async function installSkillPackageForCaller(
  request: InstallSkillCapabilityPackageRequest,
): Promise<Awaited<ReturnType<typeof installSkillCapabilityPackage>>> {
  // A public share's package endpoints are anonymous, exactly like a
  // public pipeline or automation package, so a signed-out recipient of a
  // public link gets the whole skill. Only an owned team or organization
  // package needs the account and its skills capability.
  if (request.publicShare !== true) await assertSkillsSupported();
  const result = await installSkillCapabilityPackage(request);
  refreshInvocableInventoryAfterMutation('skills:package-install');
  return result;
}

export async function recordSkillShareOriginForCaller(
  request: RecordSkillShareOriginRequest,
): Promise<void> {
  const storePath = getPipelinePackageInstallStorePath();
  const owner = { kind: 'skill' as const, localId: request.localId };
  await insertCapabilityPackageInstallIfAbsent(storePath, {
    owner,
    originExternalId: request.originExternalId,
    pipelineContentHash: request.contentHash,
    distributionMode: 'definition_only',
    installedAt: new Date().toISOString(),
  });
}

export function registerSkillHandlers(): void {
  registerIpcHandler(SKILLS_CHANNELS.MARKETPLACE_LIST, () =>
    listDesktopPublisherSkills(),
  );
  const progressFor = (
    event: IpcMainInvokeEvent,
  ): ((progress: SkillUpdateProgress) => void) => {
    return (progress) => {
      sendToWebContents(
        event.sender,
        SKILLS_CHANNELS.UPDATE_PROGRESS,
        progress,
      );
    };
  };

  registerIpcHandler(SKILLS_CHANNELS.LOAD, () => loadSkillsForCaller());
  registerIpcHandler(
    SKILLS_CHANNELS.FETCH_AVAILABLE,
    (_event, source: string) => fetchAvailableSkillsThroughCore(source),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.INSTALL,
    (_event, source: string, skillNames: string[]) =>
      installSkillsThroughCore(source, skillNames),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.REMOVE,
    (_event, sourceId: string, skillName: string) =>
      removeSkillThroughCore(sourceId, skillName),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.UPDATE,
    (_event, sourceId: string, skillName: string) =>
      updateSkillThroughCore(sourceId, skillName),
  );
  registerIpcHandler(SKILLS_CHANNELS.CHECK_UPDATES, (event) =>
    checkSkillUpdatesThroughCore(progressFor(event)),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.READ_CONTENT,
    async (_event, sourceId: string, skillName: string) => {
      await assertStoredSkillContext(`${sourceId}/${skillName}`);
      return service.readSkillContent(sourceId, skillName);
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.LIST_FILES,
    (_event, sourceId: string, skillName: string) =>
      listSkillFilesThroughCore(sourceId, skillName),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.READ_FILE,
    (_event, sourceId: string, skillName: string, filePath: string) =>
      readSkillFileThroughCore(sourceId, skillName, filePath),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SAVE_CUSTOM,
    (_event, payload: SaveCustomSkillRequest) =>
      saveCustomSkillThroughCore(payload),
  );
  registerIpcHandler(SKILLS_CHANNELS.READ_RAW, (_event, skillId: string) =>
    service.readRawSkill(skillId),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.WRITE_RAW,
    (_event, input: WriteRawSkillRequest) => writeRawSkillForCaller(input),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SHARED_LIST,
    async (_event, request: ListSharedSkillsRequest) => {
      await assertSkillsSupported();
      return listSharedSkills(request);
    },
  );
  registerIpcHandler(SKILLS_CHANNELS.SHARED_GET, (_event, skillId: string) =>
    getSharedSkillForCaller(skillId),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SHARED_CREATE,
    (_event, request: CreateSharedSkillRequest) =>
      toShareOperationResult(async () => {
        const credentials = await withShareStage('access', async () => {
          const resolved = request.sourceSkillId
            ? await resolveSkillShareCredentials()
            : undefined;
          await assertSkillsSupported(resolved?.credentialContext);
          return resolved;
        });
        const detail = credentials
          ? await createSharedSkill(request, credentials.credentialContext)
          : await createSharedSkill(request);
        const { sourceSkillId } = request;
        if (sourceSkillId && credentials && detail.canUpdate) {
          // Skill creation is content-addressed and can return an older,
          // deduplicated row. A failed local write therefore cannot safely
          // compensate by deleting the returned remote id; the share landed.
          await withShareStage('finish', () => {
            service.writeSkillRemoteMetadata(sourceSkillId, {
              accountId: credentials.accountId,
              remoteId: detail.id,
              contentHash: detail.contentHash,
              shareScope: detail.shareScope,
              sharedAt: detail.updatedAt,
            });
            return Promise.resolve();
          });
        }
        return detail;
      }),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SHARED_UPDATE,
    (_event, request: UpdateSharedSkillRequest) =>
      toShareOperationResult(async () => {
        const credentials = await withShareStage('access', async () => {
          const resolved = request.sourceSkillId
            ? await resolveSkillShareCredentials()
            : undefined;
          await assertSkillsSupported(resolved?.credentialContext);
          return resolved;
        });
        const detail = credentials
          ? await updateSharedSkill(request, credentials.credentialContext)
          : await updateSharedSkill(request);
        const { sourceSkillId } = request;
        if (sourceSkillId && credentials) {
          // The update has landed; only storing its local link can fail here.
          await withShareStage('finish', () => {
            service.writeSkillRemoteMetadata(sourceSkillId, {
              accountId: credentials.accountId,
              remoteId: detail.id,
              contentHash: detail.contentHash,
              shareScope: detail.shareScope,
              sharedAt: detail.updatedAt,
            });
            return Promise.resolve();
          });
        }
        return detail;
      }),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SHARED_DELETE,
    async (_event, request: DeleteSharedSkillRequest) => {
      await assertSkillsSupported();
      await deleteSharedSkill(request);
      service.clearSkillRemoteMetadataByRemoteId(request.skillId);
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SHARED_PUBLISH_PUBLIC,
    async (_event, skillId: string) => {
      await assertSkillsSupported();
      return publishSkillPublicShare(skillId);
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.SHARED_REVOKE_PUBLIC,
    async (_event, skillId: string) => {
      await assertSkillsSupported();
      await revokeSkillPublicShare(skillId);
    },
  );

  // ---- Capability package -------------------------------------------------
  //
  // Analysis is local work over the skill folder and the invocable inventory,
  // so it deliberately does NOT assert the cloud capability: a publisher can
  // review what would travel before deciding to share. The commit uploads
  // blobs and does assert it.
  // The analysis reads the named skill's SKILL.md itself; the renderer's
  // copy must be that same file (CAN-6403).
  registerIpcHandler(
    SKILLS_CHANNELS.PACKAGE_ANALYZE,
    (_event, request: AnalyzeSkillCapabilityPackageRequest) =>
      analyzeSkillFromDisk(request, {
        readRawSkill: service.readRawSkill,
        analyze: analyzeSkillCapabilityPackage,
      }),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.PACKAGE_CANCEL_ANALYSIS,
    (_event, analysisId: string) => {
      cancelPackageAnalysis(analysisId);
    },
  );
  registerIpcHandler(
    SKILLS_CHANNELS.PACKAGE_INSTALL,
    (_event, request: InstallSkillCapabilityPackageRequest) =>
      installSkillPackageForCaller(request),
  );
  // Local-only, like analysis: a recipient sees what a shared skill needs on
  // this machine before deciding to install it, signed in or not.
  registerIpcHandler(
    SKILLS_CHANNELS.DEPENDENCY_READINESS,
    (_event, request: unknown) =>
      getSkillDependencyReadiness(
        normalizeSkillDependencyReadinessRequest(request),
      ),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.PACKAGE_COMMIT,
    (event, request: CommitSkillCapabilityPackageRequest) =>
      toShareOperationResult(async () => {
        await assertSkillsSupported();
        return createSubjectCapabilityPackage(request, () =>
          BrowserWindow.fromWebContents(event.sender),
        );
      }, 'prepare'),
  );
  registerIpcHandler(
    SKILLS_CHANNELS.RECORD_SHARE_ORIGIN,
    (_event, request: RecordSkillShareOriginRequest) =>
      recordSkillShareOriginForCaller(request),
  );
}

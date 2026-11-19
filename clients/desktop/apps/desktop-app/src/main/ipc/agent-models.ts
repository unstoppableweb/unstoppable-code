import { invalidateAgentCatalogCompatibility } from '../remote-projection/agent-catalog-compatibility';
import { BrowserWindow } from 'electron';
import {
  toShareOperationResult,
  withShareStage,
} from '../sharing/share-operation-result';
import { recordSharedAgentInstall } from '../agents/agent-install-context';
import {
  agentResourceContextEnabled,
  agentContextSnapshot,
  assertAgentContextSnapshot,
} from '../agents/resource-lanes';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  AgentModelDefinition,
  CreateSharedAgentRequest,
  AnalyzeAgentCapabilityPackageRequest,
  CommitAgentCapabilityPackageRequest,
  DeleteAgentModelRequest,
  DeleteSharedAgentRequest,
  ImportSharedAgentRequest,
  ListSharedAgentsRequest,
  SaveAgentModelRequest,
  SharedAgentDetail,
  SharedAgentDocument,
  UpdateSharedAgentRequest,
  DetectPublicAgentRequest,
  ImportPublicAgentRequest,
  UninstallPublicAgentRequest,
} from '@canopy/execution-engine/types/agent-models';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { requireProviderForModel } from '@canopy/desktop-shared/types';
import {
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/protocol/plugins';
import {
  isAgentDefaultBaseModel,
  serializeSharedAgentForHash,
  validateSharedAgentDocument,
} from '@canopy/protocol/agents';
import { assertCanopyCloudCapability } from '../canopy-cloud/client';
import { registerIpcHandler } from './register';
import { validateAgentModelId, validateId } from '../lib/validation';
import { refreshAgentModelsFromStore } from '../lib/agent-models';
import { broadcastModelRegistryUpdated } from '../models/model-registry';
import {
  loadShareablePluginCatalog,
  resolveShareablePluginRefs,
} from '../plugins/shareable-plugin-resolution';
import {
  createSharedAgent,
  deleteSharedAgent,
  getSharedAgent,
  getAgentPackage,
  getAgentPackageBlob,
  getPublicAgentPackage,
  getPublicAgentPackageBlob,
  listSharedAgents,
  updateSharedAgent,
  publishAgentPublicShare,
  revokeAgentPublicShare,
} from '../agents/canopy-server-client';
import {
  clearAgentRemoteMetadataByRemoteId,
  deleteAgentModel,
  getAgentModel,
  importSharedAgent,
  findInstalledPublicAgent,
  importPublicAgent,
  uninstallPublicAgent,
  listAgentModels,
  saveAgentModel,
  updateOrganizationAgentCopy,
  writeAgentRemoteMetadata,
} from '../agents/agent-model-store';
import { mapPluginSelectionsToPortable } from '../plugins/workspace-template-authoring';
import { prepareDesktopWorkspaceTemplateRefs } from '../plugins/workspace-template-import';
import {
  analyzeSubjectCapabilityPackage,
  cancelPackageAnalysis,
  createSubjectCapabilityPackage,
  evaluatePipelinePackageRequirements,
  probePipelinePackageRequirement,
} from '../pipelines/pipeline-package-service';
import { installSubjectCapabilityPackage } from '../skills/skill-package-install';
import { findCapabilityPackageInstallByOwner } from '../pipelines/pipeline-package-install-store';
import { getPipelinePackageInstallStorePath } from '../lib/paths';
import {
  getMcpServerStatusByCatalogId,
  getMcpServerStatusByName,
} from '../mcp/connection-status';
import { sendToWebContents } from '../lib/web-contents-send';
import { getMainWindow } from '../lib/main-window-focus';

const AGENTS_CAPABILITY = 'agents-crud-v1';

async function assertAgentsSupported(): Promise<void> {
  await assertCanopyCloudCapability(AGENTS_CAPABILITY);
}

async function refreshAfterAgentMutation(
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  invalidateAgentCatalogCompatibility();
  await refreshAgentModelsFromStore();
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    sendToWebContents(win.webContents, IPC_CHANNELS.agentsChanged);
  }
  broadcastModelRegistryUpdated();
}

function emptySelections(): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [] };
}

function validateOptionalAgentModelId(
  value: string | undefined,
  label: string,
): void {
  if (value !== undefined) {
    validateAgentModelId(value, label);
  }
}

function validateSaveAgentRequest(request: SaveAgentModelRequest): void {
  validateOptionalAgentModelId(request.id, 'agent id');
}

async function localSelectionsFromShareableRefs(
  refs: ShareablePluginRef[],
  detail: Pick<SharedAgentDetail, 'agent'>,
): Promise<ChatTabPluginSelections> {
  const resolved = await resolveAgentShareableRefs(refs, detail, false);
  if (resolved.unmatchedRefs.length > 0) {
    throw new Error(
      `Shared Agent references unavailable plugin "${resolved.unmatchedRefs[0]}". Install it before importing this Agent.`,
    );
  }
  return resolved.selections;
}

async function resolveAgentShareableRefs(
  refs: ShareablePluginRef[],
  detail: Pick<SharedAgentDetail, 'agent'>,
  installMissing: boolean,
): Promise<{
  selections: ChatTabPluginSelections;
  matchedRefs: string[];
  unmatchedRefs: string[];
}> {
  const selections = emptySelections();
  if (refs.length === 0)
    return { selections, matchedRefs: [], unmatchedRefs: [] };
  if (installMissing) await prepareDesktopWorkspaceTemplateRefs(refs);
  const catalog = await loadShareablePluginCatalog();
  // An inheriting Agent's provider is unknown until a chat starts.
  const matches = resolveShareablePluginRefs(
    refs,
    catalog,
    isAgentDefaultBaseModel(detail.agent.baseModel)
      ? {}
      : { providerType: requireProviderForModel(detail.agent.baseModel) },
  );
  const matchedRefs: string[] = [];
  const unmatchedRefs: string[] = [];
  for (const match of matches) {
    if (match.matchState === 'unmatched') {
      unmatchedRefs.push(getShareablePluginRefKey(match.ref));
      continue;
    }
    matchedRefs.push(match.catalogKey);
    if (match.selection.kind === 'skill') {
      selections.skillRefs.push({
        sourceId: match.selection.sourceId,
        skillName: match.selection.skillName,
      });
    } else {
      selections.pluginRefs.push({
        marketplaceId: match.selection.marketplaceId,
        pluginName: match.selection.pluginName,
      });
    }
  }
  if (installMissing && unmatchedRefs.length > 0) {
    throw new Error(
      `Shared Agent references unavailable skill or plugin "${unmatchedRefs[0]}". Check the source and try again.`,
    );
  }
  return { selections, matchedRefs, unmatchedRefs };
}

/**
 * Imports an organization's shared Agent for the organization capabilities
 * layer (CAN-6237, phase 10a): the shared Agent import a person's own
 * import uses, with no missing installs. It only saves the copy: the layer
 * records the copy first and then publishes it (`publishOrganizationAgentChanges`),
 * so a publication that fails never hides a copy it made.
 */
export function importSharedAgentForOrganization(
  detail: SharedAgentDetail,
): Promise<Awaited<ReturnType<typeof importSharedAgent>>> {
  return importSharedAgentDetail(() => null, detail, false, false);
}

/**
 * Updates the Agent copy the organization capabilities layer made for
 * `detail` in place when the share changed (CAN-6237, phase 10a), with the
 * share's skills and plugins resolved as an import resolves them. True when
 * the copy was updated; false when it can't be (gone, changed by the person,
 * or the share unchanged), and the layer imports as usual. Like the import,
 * it only saves: the layer publishes the change.
 */
export async function updateOrganizationAgentFromShare(
  agentId: string,
  detail: SharedAgentDetail,
): Promise<boolean> {
  const { selections } = await resolveAgentShareableRefs(
    detail.agent.plugins,
    detail,
    false,
  );
  return (
    (await updateOrganizationAgentCopy(agentId, detail, selections)) !== null
  );
}

/**
 * Publishes Agent copies the organization capabilities layer added or
 * removed (CAN-6237, phase 10a), as every Agent change is: the registry is
 * read again, the main window is told, and the model registry update is
 * broadcast, so the pickers offer exactly the copies on this computer.
 */
export function publishOrganizationAgentChanges(): Promise<void> {
  return refreshAfterAgentMutation(getMainWindow);
}

async function resolveAgentPackageMcpRefs(
  packageSummary: SharedAgentDetail['package'],
): Promise<Array<{ serverId: string; configId: string }>> {
  if (!packageSummary) return [];
  const refs = new Map<string, { serverId: string; configId: string }>();
  for (const requirement of packageSummary.environmentRequirements) {
    if (requirement.kind !== 'mcp') continue;
    const status =
      (await getMcpServerStatusByCatalogId(requirement.displayName)) ??
      (await getMcpServerStatusByName(requirement.displayName));
    const config = status?.configs[0];
    if (!status || !config) continue;
    refs.set(`${status.serverId}/${config.configId}`, {
      serverId: status.serverId,
      configId: config.configId,
    });
  }
  return Array.from(refs.values());
}

async function findInstalledPackagedPublicAgent(
  document: SharedAgentDocument,
  expectedSelections: ChatTabPluginSelections,
  request: DetectPublicAgentRequest,
): Promise<Awaited<ReturnType<typeof findInstalledPublicAgent>>> {
  const exact = await findInstalledPublicAgent(
    document,
    expectedSelections,
    request.externalId,
    request.contentHash,
  );
  if (!request.package) return exact;

  const candidatesById = new Map(
    [...(exact ? [exact] : []), ...(await listAgentModels())]
      .filter(
        (candidate) =>
          candidate.publicShareExternalId === request.externalId &&
          candidate.publicShareContentHash === request.contentHash,
      )
      .map((candidate) => [candidate.id, candidate]),
  );
  const candidates = Array.from(candidatesById.values());
  for (const candidate of candidates) {
    const install = await findCapabilityPackageInstallByOwner(
      getPipelinePackageInstallStorePath(),
      { kind: 'agent', localId: candidate.id },
    );
    if (
      !install ||
      install.distributionMode === 'definition_only' ||
      install.packageDigest !== request.package.digest ||
      install.originExternalId !== request.externalId ||
      install.localContentHash === undefined ||
      install.localContentHash !== candidate.contentHash
    ) {
      continue;
    }
    if (exact?.id === candidate.id) return exact;
    const packaged = await findInstalledPublicAgent(
      document,
      candidate.pluginSelections,
      request.externalId,
      request.contentHash,
    );
    if (packaged?.id === candidate.id) return packaged;
  }
  return null;
}

function validatedPublicAgent(request: unknown): SharedAgentDocument {
  const value: unknown =
    typeof request === 'object' && request !== null && 'agent' in request
      ? request.agent
      : undefined;
  const validation = validateSharedAgentDocument(value);
  if (!validation.ok) throw new Error(validation.error);
  return validation.document;
}

function validatePublicAgentProvenance(request: {
  externalId: string;
  contentHash: string;
}): void {
  validateId(request.externalId, 'public Agent share id');
  if (typeof request.contentHash !== 'string' || !request.contentHash.trim()) {
    throw new Error('Invalid public Agent content hash');
  }
}

async function importSharedAgentDetail(
  getWindow: () => BrowserWindow | null,
  detail: SharedAgentDetail,
  installMissing = false,
  // False only for the organization layer, which publishes after recording.
  publish = true,
): Promise<Awaited<ReturnType<typeof importSharedAgent>>> {
  const snapshot = agentResourceContextEnabled()
    ? await agentContextSnapshot()
    : undefined;
  const { selections } = await resolveAgentShareableRefs(
    detail.agent.plugins,
    detail,
    installMissing,
  );
  const pluginSelections = {
    ...selections,
    ...(installMissing && detail.package
      ? { mcpServerRefs: await resolveAgentPackageMcpRefs(detail.package) }
      : {}),
  };
  const packageSummary =
    installMissing && detail.package ? detail.package : undefined;
  const [download, agentsBeforeImport] = packageSummary
    ? await Promise.all([
        getAgentPackage(detail.id, packageSummary.digest),
        listAgentModels(),
      ])
    : [undefined, []];
  if (snapshot !== undefined) await assertAgentContextSnapshot(snapshot);
  let response = await importSharedAgent(detail, pluginSelections);
  if (packageSummary && download) {
    const existing = agentsBeforeImport.find(
      (agent) => agent.id === response.finalId,
    );
    await installSubjectCapabilityPackage({
      owner: { kind: 'agent', localId: response.finalId },
      originExternalId: detail.id,
      packageRef: {
        version: packageSummary.version,
        digest: packageSummary.digest,
      },
      download,
      fetchBlob: (sha256) =>
        getAgentPackageBlob(detail.id, packageSummary.digest, sha256),
      finalizeInstall: async (installed) => {
        const skillRefs = new Map(
          response.agent.pluginSelections.skillRefs.map((ref) => [
            `${ref.sourceId}/${ref.skillName}`,
            ref,
          ]),
        );
        for (const skill of installed.installedSkills) {
          skillRefs.set(`custom:app/${skill.localName}`, {
            sourceId: 'custom:app',
            skillName: skill.localName,
          });
        }
        const agent = await saveAgentModel(
          {
            id: response.finalId,
            name: response.agent.name,
            baseModel: response.agent.baseModel,
            instructions: response.agent.instructions,
            pluginSelections: {
              ...response.agent.pluginSelections,
              skillRefs: Array.from(skillRefs.values()),
            },
          },
          response.agent.importedContentHash,
        );
        response = { ...response, agent };
        return agent.contentHash;
      },
      rollbackFinalization: async () => {
        if (!existing) {
          await deleteAgentModel(
            response.finalId,
            undefined,
            response.agent.contentHash ?? '',
          );
          return;
        }
        const agent = await saveAgentModel(
          {
            id: existing.id,
            name: existing.name,
            baseModel: existing.baseModel,
            instructions: existing.instructions,
            pluginSelections: existing.pluginSelections,
          },
          response.agent.importedContentHash,
        );
        response = { ...response, agent };
      },
    });
  }
  if (publish) await refreshAfterAgentMutation(getWindow);
  return response;
}

/** The window's agent save, which App Advisor's agents.create and .update share (CAN-6002). */
export async function saveAgentForWindow(
  request: SaveAgentModelRequest,
  getWindow: () => BrowserWindow | null,
): Promise<AgentModelDefinition> {
  validateSaveAgentRequest(request);
  const agent = await saveAgentModel(request);
  await refreshAfterAgentMutation(getWindow);
  return agent;
}

/**
 * The window's agent delete, which App Advisor's agents.delete shares
 * (CAN-6002): the store refuses what it refuses for the window. Answers
 * whether an agent was removed.
 */
export async function deleteAgentForWindow(
  request: DeleteAgentModelRequest,
  getWindow: () => BrowserWindow | null,
): Promise<boolean> {
  validateAgentModelId(request.id, 'agent id');
  const changed =
    request.importedShare === undefined
      ? await deleteAgentModel(request.id)
      : await deleteAgentModel(request.id, request.importedShare);
  if (changed) await refreshAfterAgentMutation(getWindow);
  return changed;
}

/** The window's shared agent import, which App Advisor's agents.import_shared shares (CAN-6003). */
export async function importSharedAgentForWindow(
  request: ImportSharedAgentRequest,
  getWindow: () => BrowserWindow | null,
): Promise<Awaited<ReturnType<typeof importSharedAgentDetail>>> {
  validateId(request.agentId, 'shared agent id');
  await assertAgentsSupported();
  if (request.reviewedAgent && request.reviewedAgent.id !== request.agentId) {
    throw new Error('Reviewed Agent does not match the requested Agent');
  }
  const snapshot = agentResourceContextEnabled()
    ? await agentContextSnapshot()
    : undefined;
  let detail = request.reviewedAgent;
  if (!detail || snapshot !== undefined) {
    // Under workspace context the reviewed snapshot is only a pin: the
    // import still re-reads the share so its owner is authorized now.
    const current = await getSharedAgent(request.agentId);
    if (
      detail &&
      (detail.contentHash !== current.contentHash ||
        detail.package?.digest !== current.package?.digest)
    ) {
      throw new Error(
        'The shared Agent changed. Refresh and review it before importing.',
      );
    }
    detail = current;
  }
  if (snapshot !== undefined) await assertAgentContextSnapshot(snapshot);
  return importSharedAgentDetail(
    getWindow,
    detail,
    request.installMissing === true,
  );
}

/** The window's shared agent delete, which App Advisor's agents.delete_shared shares (CAN-6003). */
export async function deleteSharedAgentForWindow(
  request: DeleteSharedAgentRequest,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  validateId(request.agentId, 'shared agent id');
  await assertAgentsSupported();
  await deleteSharedAgent(request);
  const clearedCount = await clearAgentRemoteMetadataByRemoteId(
    request.agentId,
  );
  if (clearedCount > 0) {
    await refreshAfterAgentMutation(getWindow);
  }
}

/** The window's public agent link publish (CAN-6003). */
export async function publishAgentPublicShareForWindow(
  agentId: string,
): Promise<Awaited<ReturnType<typeof publishAgentPublicShare>>> {
  validateId(agentId, 'shared agent id');
  await assertAgentsSupported();
  return publishAgentPublicShare(agentId);
}

/** The window's public agent link revoke (CAN-6003). */
export async function revokeAgentPublicShareForWindow(
  agentId: string,
): Promise<void> {
  validateId(agentId, 'shared agent id');
  await assertAgentsSupported();
  await revokeAgentPublicShare(agentId);
}

export function registerAgentModelHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  getWorkspaceContextService().subscribe(() => {
    invalidateAgentCatalogCompatibility();
    if (!agentResourceContextEnabled()) return;
    // Clear the old projection immediately; asynchronous hydration is fenced.
    broadcastModelRegistryUpdated();
    const win = getWindow();
    if (win && !win.isDestroyed())
      sendToWebContents(win.webContents, IPC_CHANNELS.agentsChanged);
    void refreshAfterAgentMutation(getWindow).catch(() => {
      // A changed account/context invalidates the synchronous projection too.
      broadcastModelRegistryUpdated();
    });
  });
  registerIpcHandler(IPC_CHANNELS.agentsList, async () => ({
    agents: await listAgentModels(),
  }));

  registerIpcHandler(IPC_CHANNELS.agentsGet, (_event, id: string) => {
    validateAgentModelId(id, 'agent id');
    return getAgentModel(id);
  });

  registerIpcHandler(
    IPC_CHANNELS.agentsSave,
    (_event, request: SaveAgentModelRequest) =>
      saveAgentForWindow(request, getWindow),
  );

  registerIpcHandler(
    IPC_CHANNELS.agentsDelete,
    async (_event, request: DeleteAgentModelRequest) => {
      await deleteAgentForWindow(request, getWindow);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.agentsImportShared,
    (_event, request: ImportSharedAgentRequest) =>
      importSharedAgentForWindow(request, getWindow),
  );

  registerIpcHandler(
    IPC_CHANNELS.agentsImportReadiness,
    async (_event, agentId: string) => {
      validateId(agentId, 'shared agent id');
      await assertAgentsSupported();
      const agent = await getSharedAgent(agentId);
      const refs = await resolveAgentShareableRefs(
        agent.agent.plugins,
        agent,
        false,
      );
      const readiness = agent.package
        ? await evaluatePipelinePackageRequirements(
            agent.package.environmentRequirements,
            probePipelinePackageRequirement,
          )
        : null;
      return {
        agent,
        matchedRefs: refs.matchedRefs,
        unmatchedRefs: refs.unmatchedRefs,
        requirements: readiness?.requirements ?? [],
      };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.agentsPackageAnalyze,
    async (_event, request: AnalyzeAgentCapabilityPackageRequest) => {
      validateAgentModelId(request.agentModelId, 'agent id');
      const agent = await getAgentModel(request.agentModelId);
      if (!agent) throw new Error('Agent not found');
      const portable = await mapPluginSelectionsToPortable(
        agent.pluginSelections,
      );
      const document: SharedAgentDocument = {
        version: 1,
        id: agent.id,
        name: agent.name,
        baseModel: agent.baseModel,
        instructions: agent.instructions,
        plugins: portable.refs,
      };
      const analysis = await analyzeSubjectCapabilityPackage({
        rawContent: serializeSharedAgentForHash(document),
        scopeKey: `agent:${agent.id}`,
        selections: agent.pluginSelections,
        promptTexts: [agent.instructions],
        dismissedInvocations: request.dismissedInvocations,
      });
      const authorNotices = [
        ...portable.unresolved,
        ...((agent.pluginSelections.mcpHttpAuthPreferences?.length ?? 0) > 0
          ? [
              'MCP authentication preferences stay on this device and are not included in the share.',
            ]
          : []),
      ];
      return authorNotices.length > 0
        ? {
            ...analysis,
            unpackageableSelectionLabels: Array.from(
              new Set([
                ...(analysis.unpackageableSelectionLabels ?? []),
                ...authorNotices,
              ]),
            ),
          }
        : analysis;
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.agentsPackageCancelAnalysis,
    (_event, analysisId: string) => cancelPackageAnalysis(analysisId),
  );
  registerIpcHandler(
    IPC_CHANNELS.agentsPackageCommit,
    (event, request: CommitAgentCapabilityPackageRequest) =>
      toShareOperationResult(async () => {
        await assertAgentsSupported();
        return createSubjectCapabilityPackage(request, () =>
          BrowserWindow.fromWebContents(event.sender),
        );
      }, 'prepare'),
  );

  registerIpcHandler(
    IPC_CHANNELS.agentsDetectPublic,
    async (_event, request: DetectPublicAgentRequest) => {
      validatePublicAgentProvenance(request);
      const agent = validatedPublicAgent(request);
      const selections = await localSelectionsFromShareableRefs(agent.plugins, {
        agent,
      });
      return findInstalledPackagedPublicAgent(agent, selections, request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.agentsPublicImportReadiness,
    async (_event, request: DetectPublicAgentRequest) => {
      validatePublicAgentProvenance(request);
      validatedPublicAgent(request);
      if (!request.package) {
        return { status: 'ready' as const, requirements: [] };
      }
      return {
        ...(await evaluatePipelinePackageRequirements(
          request.package.environmentRequirements,
          probePipelinePackageRequirement,
        )),
        distributionMode: 'package' as const,
        ...(request.package.publisherNotes
          ? { publisherNotes: request.package.publisherNotes }
          : {}),
        includedResources: request.package.resources.map(
          ({ id, displayName, kind, executableFiles }) => ({
            id,
            displayName,
            kind,
            ...(executableFiles ? { executableFiles } : {}),
          }),
        ),
      };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.agentsImportPublic,
    async (_event, request: ImportPublicAgentRequest) => {
      validatePublicAgentProvenance(request);
      const agent = validatedPublicAgent(request);
      const { selections: portableSelections } =
        await resolveAgentShareableRefs(
          agent.plugins,
          { agent },
          request.installMissing === true,
        );
      const selections = {
        ...portableSelections,
        ...(request.installMissing && request.package
          ? {
              mcpServerRefs: await resolveAgentPackageMcpRefs(request.package),
            }
          : {}),
      };
      const installed =
        request.installMissing && request.package
          ? await findInstalledPackagedPublicAgent(agent, selections, request)
          : null;
      if (installed) return installed;
      const existing =
        request.installMissing && request.package
          ? await findInstalledPublicAgent(
              agent,
              selections,
              request.externalId,
              request.contentHash,
            )
          : null;
      const packageDownload =
        request.installMissing && request.package
          ? await getPublicAgentPackage(
              request.externalId,
              request.package.digest,
            )
          : undefined;
      let imported = await importPublicAgent(
        agent,
        selections,
        request.externalId,
        request.contentHash,
      );
      if (request.installMissing && request.package && packageDownload) {
        const packageSummary = request.package;
        await installSubjectCapabilityPackage({
          owner: { kind: 'agent', localId: imported.id },
          originExternalId: request.externalId,
          packageRef: {
            version: packageSummary.version,
            digest: packageSummary.digest,
          },
          download: packageDownload,
          fetchBlob: (sha256) =>
            getPublicAgentPackageBlob(
              request.externalId,
              packageSummary.digest,
              sha256,
            ),
          finalizeInstall: async (installed) => {
            const skillRefs = new Map(
              imported.pluginSelections.skillRefs.map((ref) => [
                `${ref.sourceId}/${ref.skillName}`,
                ref,
              ]),
            );
            for (const skill of installed.installedSkills) {
              skillRefs.set(`custom:app/${skill.localName}`, {
                sourceId: 'custom:app',
                skillName: skill.localName,
              });
            }
            imported = await saveAgentModel(
              {
                id: imported.id,
                name: imported.name,
                baseModel: imported.baseModel,
                instructions: imported.instructions,
                pluginSelections: {
                  ...imported.pluginSelections,
                  skillRefs: Array.from(skillRefs.values()),
                },
              },
              imported.importedContentHash,
            );
            return imported.contentHash;
          },
          rollbackFinalization: async () => {
            if (!existing) {
              await deleteAgentModel(
                imported.id,
                undefined,
                imported.contentHash ?? '',
              );
              return;
            }
            imported = await saveAgentModel(
              {
                id: existing.id,
                name: existing.name,
                baseModel: existing.baseModel,
                instructions: existing.instructions,
                pluginSelections: existing.pluginSelections,
              },
              imported.importedContentHash,
            );
          },
        });
      }
      await refreshAfterAgentMutation(getWindow);
      return imported;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.agentsUninstallPublic,
    async (_event, request: UninstallPublicAgentRequest) => {
      validateAgentModelId(request.agentId, 'agent id');
      validatePublicAgentProvenance(request);
      const changed = await uninstallPublicAgent(
        request.agentId,
        request.externalId,
        request.contentHash,
      );
      if (changed) await refreshAfterAgentMutation(getWindow);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.agentsSharedList,
    async (_event, request: ListSharedAgentsRequest) => {
      await assertAgentsSupported();
      return listSharedAgents(request);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.agentsSharedGet,
    async (_event, id: string) => {
      validateId(id, 'shared agent id');
      await assertAgentsSupported();
      return getSharedAgent(id);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.agentsSharedCreate,
    (_event, request: CreateSharedAgentRequest) =>
      toShareOperationResult(async () => {
        await withShareStage('access', assertAgentsSupported);
        const detail = await createSharedAgent(request);
        await recordSharedAgentInstall(detail, detail.agent.id);
        await writeAgentRemoteMetadata({
          id: detail.agent.id,
          remoteId: detail.id,
          remoteAccountId: detail.createdBy.id,
          remoteContentHash: detail.contentHash,
        });
        await refreshAfterAgentMutation(getWindow);
        return detail;
      }),
  );
  registerIpcHandler(
    IPC_CHANNELS.agentsSharedUpdate,
    (_event, request: UpdateSharedAgentRequest) => {
      validateId(request.agentId, 'shared agent id');
      return toShareOperationResult(async () => {
        await withShareStage('access', assertAgentsSupported);
        const detail = await updateSharedAgent(request);
        await recordSharedAgentInstall(detail, detail.agent.id);
        await writeAgentRemoteMetadata({
          id: detail.agent.id,
          remoteId: detail.id,
          remoteAccountId: detail.createdBy.id,
          remoteContentHash: detail.contentHash,
        });
        await refreshAfterAgentMutation(getWindow);
        return detail;
      });
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.agentsSharedDelete,
    async (_event, request: DeleteSharedAgentRequest) => {
      await deleteSharedAgentForWindow(request, getWindow);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.agentsPublicSharePublish,
    (_event, agentId: string) => publishAgentPublicShareForWindow(agentId),
  );
  registerIpcHandler(
    IPC_CHANNELS.agentsPublicShareRevoke,
    async (_event, agentId: string) => {
      await revokeAgentPublicShareForWindow(agentId);
    },
  );
}

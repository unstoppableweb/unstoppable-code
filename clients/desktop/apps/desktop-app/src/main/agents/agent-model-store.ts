import { agentResourceContextEnabled } from './resource-lanes';
import {
  assertStoredAgentContext,
  filterStoredAgentContexts,
  recordSharedAgentInstall,
  sharedAgentIsAuthoredByCurrentAccount,
} from './agent-install-context';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AGENT_MODEL_PREFIX,
  agentModelIdFromSlug,
  deriveAgentModelSlug,
  normalizeAgentModelSlug,
  resolveAgentModelIdCollision,
  type AgentModelDefinition,
  type DeleteAgentModelRequest,
  type ImportSharedAgentResponse,
  type SaveAgentModelRequest,
  type SharedAgentDetail,
  type SharedAgentDocument,
} from '@canopy/execution-engine/types/agent-models';
import {
  isAgentModel,
  isBaseModelSelectableForAgent,
  type ChatModel,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  isAgentDefaultBaseModel,
  validateSharedAgentDocument,
} from '@canopy/protocol/agents';
import { getAgentModelsFilePath } from '../lib/paths';
import {
  recordSharedItemInstall,
  recordSharedItemUninstall,
} from '../canopy-cloud/shared-item-subscriptions';

const FILE_VERSION = 1;
const MAX_AGENT_INSTRUCTIONS_BYTES = 64 * 1024;

interface AgentModelsFileV1 {
  version: 1;
  agents: AgentModelDefinition[];
}

interface RemoteMetadataUpdate {
  id: string;
  remoteId?: string;
  remoteAccountId?: string;
  remoteContentHash?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Agent name is required.');
  }
  return trimmed;
}

function assertInstructions(instructions: string): void {
  if (byteLength(instructions) > MAX_AGENT_INSTRUCTIONS_BYTES) {
    throw new Error(
      `Agent instructions exceed ${String(MAX_AGENT_INSTRUCTIONS_BYTES)} bytes.`,
    );
  }
}

function assertBaseModel(baseModel: ChatModel): void {
  if (isAgentModel(baseModel)) {
    throw new Error(
      'Agent base model must be a provider model, not another Agent.',
    );
  }
  if (
    !isAgentDefaultBaseModel(baseModel) &&
    !isBaseModelSelectableForAgent(baseModel)
  ) {
    throw new Error(`Base model "${String(baseModel)}" is not available.`);
  }
}

function isAgentModelDefinition(value: unknown): value is AgentModelDefinition {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    isAgentModel(value.id) &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    typeof value.baseModel === 'string' &&
    !isAgentModel(value.baseModel) &&
    typeof value.instructions === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.remoteId === undefined || typeof value.remoteId === 'string') &&
    (value.remoteAccountId === undefined ||
      typeof value.remoteAccountId === 'string') &&
    (value.importedFromRemoteId === undefined ||
      typeof value.importedFromRemoteId === 'string') &&
    (value.importedContentHash === undefined ||
      typeof value.importedContentHash === 'string') &&
    (value.contentHash === undefined ||
      typeof value.contentHash === 'string') &&
    (value.remoteContentHash === undefined ||
      typeof value.remoteContentHash === 'string') &&
    (value.publicShareExternalId === undefined ||
      typeof value.publicShareExternalId === 'string') &&
    (value.publicShareContentHash === undefined ||
      typeof value.publicShareContentHash === 'string')
  );
}

function normalizeAgent(value: unknown): AgentModelDefinition | null {
  if (!isAgentModelDefinition(value)) return null;
  const pluginSelections = normalizePluginSelections(value.pluginSelections);
  const importedFromRemoteId = value.importedFromRemoteId;
  return {
    id: value.id,
    name: value.name.trim(),
    baseModel: value.baseModel,
    instructions: value.instructions,
    pluginSelections,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.remoteId && !importedFromRemoteId
      ? { remoteId: value.remoteId }
      : {}),
    ...(value.remoteAccountId && !importedFromRemoteId
      ? { remoteAccountId: value.remoteAccountId }
      : {}),
    ...(importedFromRemoteId ? { importedFromRemoteId } : {}),
    ...(value.importedContentHash
      ? { importedContentHash: value.importedContentHash }
      : {}),
    contentHash:
      (agentResourceContextEnabled() ? undefined : value.contentHash) ??
      computeAgentContentHash({
        id: value.id,
        name: value.name.trim(),
        baseModel: value.baseModel,
        instructions: value.instructions,
        pluginSelections,
      }),
    ...(value.remoteContentHash
      ? { remoteContentHash: value.remoteContentHash }
      : {}),
    ...(value.publicShareExternalId
      ? { publicShareExternalId: value.publicShareExternalId }
      : {}),
    ...(value.publicShareContentHash
      ? { publicShareContentHash: value.publicShareContentHash }
      : {}),
  };
}

function readAgentsFromParsed(parsed: unknown): AgentModelDefinition[] {
  if (!isRecord(parsed) || parsed.version !== FILE_VERSION) {
    return [];
  }
  if (!Array.isArray(parsed.agents)) {
    return [];
  }
  return parsed.agents.flatMap((entry) => {
    const normalized = normalizeAgent(entry);
    return normalized ? [normalized] : [];
  });
}

async function readAgentModelsFile(): Promise<AgentModelDefinition[]> {
  const filePath = getAgentModelsFilePath();
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const raw = await readFile(filePath, 'utf8');
    return readAgentsFromParsed(JSON.parse(raw));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to read Agent models file:', error);
    return [];
  }
}

async function writeAgentModelsFile(
  agents: AgentModelDefinition[],
): Promise<void> {
  assertUniqueAgentModelIds(agents);
  const filePath = getAgentModelsFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  const payload: AgentModelsFileV1 = {
    version: FILE_VERSION,
    agents,
  };
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

function assertUniqueAgentModelIds(
  agents: readonly AgentModelDefinition[],
): void {
  if (new Set(agents.map((agent) => agent.id)).size !== agents.length) {
    throw new Error('Agent model IDs must be unique.');
  }
}

function slugFromAgentModelId(id: string): string {
  return id.startsWith(AGENT_MODEL_PREFIX)
    ? id.slice(AGENT_MODEL_PREFIX.length)
    : id;
}

function hasDuplicateName(
  agents: readonly AgentModelDefinition[],
  name: string,
  exceptId?: string,
): boolean {
  const key = name.trim().toLowerCase();
  return agents.some(
    (agent) => agent.id !== exceptId && agent.name.trim().toLowerCase() === key,
  );
}

function computeAgentContentHash(input: {
  id: string;
  name: string;
  baseModel: ChatModel;
  instructions: string;
  pluginSelections: ChatTabPluginSelections;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: input.id,
        name: input.name,
        baseModel: input.baseModel,
        instructions: input.instructions,
        pluginSelections: input.pluginSelections,
      }),
    )
    .digest('hex');
}

function withLocalHash(
  agent: Omit<AgentModelDefinition, 'contentHash'>,
): AgentModelDefinition {
  return {
    ...agent,
    contentHash: computeAgentContentHash(agent),
  };
}

function agentsEqual(
  left: AgentModelDefinition,
  right: AgentModelDefinition,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function agentLocalContentEqual(
  agent: AgentModelDefinition,
  input: {
    name: string;
    baseModel: ChatModel;
    instructions: string;
    pluginSelections: ChatTabPluginSelections;
  },
): boolean {
  return (
    agent.name === input.name &&
    agent.baseModel === input.baseModel &&
    agent.instructions === input.instructions &&
    JSON.stringify(agent.pluginSelections) ===
      JSON.stringify(input.pluginSelections)
  );
}

function resolveCopyName(
  desiredName: string,
  agents: readonly AgentModelDefinition[],
): string {
  const baseName = normalizeName(desiredName);
  if (!hasDuplicateName(agents, baseName)) {
    return baseName;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseName} (${String(suffix)})`;
    if (!hasDuplicateName(agents, candidate)) {
      return candidate;
    }
  }
}

export async function listAgentModels(): Promise<AgentModelDefinition[]> {
  return filterStoredAgentContexts(await readAgentModelsFile());
}

/**
 * Every stored Agent, across all contexts, for the one-time install
 * subscription backfill. Reads provenance only.
 */
export async function listAgentModelsForInstallBackfill(): Promise<
  AgentModelDefinition[]
> {
  return readAgentModelsFile();
}

/**
 * Drop the install subscriptions an Agent's provenance names: a team or
 * organization import and a Public import. The author's own share link
 * (`remoteId` alone) is not an install.
 */
function unregisterAgentInstalls(agent: AgentModelDefinition): void {
  if (agent.importedFromRemoteId !== undefined)
    recordSharedItemUninstall({
      kind: 'agent',
      remoteId: agent.importedFromRemoteId,
      sourceKind: 'shared',
      localId: agent.id,
    });
  if (agent.publicShareExternalId !== undefined)
    recordSharedItemUninstall({
      kind: 'agent',
      remoteId: agent.publicShareExternalId,
      sourceKind: 'public',
      localId: agent.id,
    });
}

/** Register a shared import, unless the copy is the author's own share. */
function registerSharedAgentImport(
  agent: AgentModelDefinition,
  detail: SharedAgentDetail,
): void {
  if (agent.importedFromRemoteId !== detail.id) return;
  recordSharedItemInstall({
    kind: 'agent',
    remoteId: detail.id,
    sourceKind: 'shared',
    contentHash: detail.contentHash,
    localId: agent.id,
  });
}

function registerPublicAgentImport(agent: AgentModelDefinition): void {
  if (agent.publicShareExternalId === undefined) return;
  recordSharedItemInstall({
    kind: 'agent',
    remoteId: agent.publicShareExternalId,
    sourceKind: 'public',
    contentHash: agent.publicShareContentHash ?? null,
    localId: agent.id,
  });
}

export async function getAgentModel(
  id: string,
  projectId?: string,
): Promise<AgentModelDefinition | null> {
  const agents = await readAgentModelsFile();
  const agent = agents.find((row) => row.id === id) ?? null;
  await assertStoredAgentContext(
    id,
    projectId,
    agent?.importedFromRemoteId ?? agent?.remoteId,
  );
  return agent;
}

export async function saveAgentModel(
  request: SaveAgentModelRequest,
  // Main-process package finalization only; never accepted from the IPC DTO.
  importedContentHash?: string,
): Promise<AgentModelDefinition> {
  const agents = await readAgentModelsFile();
  if (request.id)
    await assertStoredAgentContext(
      request.id,
      undefined,
      ((): string | undefined => {
        const stored = agents.find((row) => row.id === request.id);
        return stored?.importedFromRemoteId ?? stored?.remoteId;
      })(),
    );
  const now = new Date().toISOString();
  const name = normalizeName(request.name);
  const instructions = request.instructions ?? '';
  assertInstructions(instructions);
  assertBaseModel(request.baseModel);
  const pluginSelections = normalizePluginSelections(request.pluginSelections);

  if (request.id) {
    const existingIndex = agents.findIndex((agent) => agent.id === request.id);
    if (existingIndex >= 0) {
      if (hasDuplicateName(agents, name, request.id)) {
        throw new Error(`An Agent named "${name}" already exists.`);
      }
      const existing = agents[existingIndex];
      if (importedContentHash !== undefined) {
        assertImportedContentUnchanged(existing);
        if (
          existing.contentHash !== importedContentHash ||
          (!existing.importedFromRemoteId && !existing.publicShareExternalId)
        ) {
          throw new Error(
            'The imported Agent changed during package installation.',
          );
        }
      }
      if (
        request.modelIdSlug !== undefined &&
        normalizeAgentModelSlug(request.modelIdSlug) !==
          slugFromAgentModelId(existing.id)
      ) {
        throw new Error(
          'Agent model ID cannot be changed after the Agent is created.',
        );
      }
      if (
        agentLocalContentEqual(existing, {
          name,
          baseModel: request.baseModel,
          instructions,
          pluginSelections,
        })
      ) {
        return existing;
      }
      const next = withLocalHash({
        ...existing,
        name,
        baseModel: request.baseModel,
        instructions,
        pluginSelections,
        updatedAt: now,
      });
      if (importedContentHash !== undefined) {
        next.importedContentHash = next.contentHash;
      }
      const updated = [...agents];
      updated[existingIndex] = next;
      await writeAgentModelsFile(updated);
      return next;
    }
    throw new Error(`Agent model "${request.id}" does not exist.`);
  }

  if (hasDuplicateName(agents, name)) {
    throw new Error(`An Agent named "${name}" already exists.`);
  }
  const slug =
    request.modelIdSlug !== undefined
      ? normalizeAgentModelSlug(request.modelIdSlug)
      : deriveAgentModelSlug(name);
  const baseId = agentModelIdFromSlug(slug);
  const id = resolveAgentModelIdCollision(
    baseId,
    agents.map((agent) => agent.id),
  );
  const created = withLocalHash({
    id,
    name,
    baseModel: request.baseModel,
    instructions,
    pluginSelections,
    createdAt: now,
    updatedAt: now,
  });
  await writeAgentModelsFile([...agents, created]);
  return created;
}

function importedContentUnchanged(agent: AgentModelDefinition): boolean {
  return (
    agent.importedContentHash !== undefined &&
    agent.importedContentHash === computeAgentContentHash(agent)
  );
}

function assertImportedContentUnchanged(agent: AgentModelDefinition): void {
  if (!importedContentUnchanged(agent)) {
    throw new Error(
      'The imported Agent is locally changed or its original content is unknown. Delete it from the Agents page instead.',
    );
  }
}

export async function deleteAgentModel(
  id: string,
  importedShare?: DeleteAgentModelRequest['importedShare'],
  // Main-process package rollback only; never accepted from the IPC DTO.
  rollbackContentHash?: string,
): Promise<boolean> {
  let agents = await readAgentModelsFile();
  await assertStoredAgentContext(
    id,
    undefined,
    ((): string | undefined => {
      const stored = agents.find((row) => row.id === id);
      return stored?.importedFromRemoteId ?? stored?.remoteId;
    })(),
  );
  if (rollbackContentHash !== undefined) {
    // Authorization can await a remote read, so compare freshly persisted content.
    agents = await readAgentModelsFile();
    const installed = agents.find((agent) => agent.id === id);
    if (!installed) return false;
    if (computeAgentContentHash(installed) !== rollbackContentHash) {
      // Keep the user's copy without install markers. Retain shared access-control
      // provenance (remote metadata and receipts) for organization-origin content.
      const installMarkers = { ...installed };
      delete installed.importedContentHash;
      delete installed.importedFromRemoteId;
      delete installed.publicShareExternalId;
      delete installed.publicShareContentHash;
      await writeAgentModelsFile(agents);
      // The copy is no longer an install, so it no longer follows the share.
      unregisterAgentInstalls(installMarkers);
      return false;
    }
  }
  if (agentResourceContextEnabled() && importedShare !== undefined) {
    // Authorization may await a remote read; inspect the current persisted content.
    agents = await readAgentModelsFile();
    const installed = agents.find((agent) => agent.id === id);
    if (!installed) return false;
    if (
      installed.importedFromRemoteId !== importedShare.remoteId ||
      installed.remoteContentHash !== importedShare.contentHash
    ) {
      throw new Error('The Agent is not an installed copy of this share.');
    }
    assertImportedContentUnchanged(installed);
  }
  const removed = agents.find((agent) => agent.id === id);
  const next = agents.filter((agent) => agent.id !== id);
  if (!removed || next.length === agents.length) {
    return false;
  }
  await writeAgentModelsFile(next);
  unregisterAgentInstalls(removed);
  return true;
}

/**
 * Removes an Agent copy the organization capabilities layer made once its
 * organization's set no longer holds it (CAN-6237, phase 10a). A copy the
 * person changed, or that is not an import, is left as it is: it is theirs
 * now. No workspace context check: the layer removes only its own copies.
 */
export async function removeOrganizationAgentCopy(
  id: string,
): Promise<boolean> {
  const agents = await readAgentModelsFile();
  const removed = agents.find((agent) => agent.id === id);
  if (
    !removed ||
    removed.importedFromRemoteId === undefined ||
    !importedContentUnchanged(removed)
  )
    return false;
  await writeAgentModelsFile(agents.filter((agent) => agent.id !== id));
  unregisterAgentInstalls(removed);
  return true;
}

export async function writeAgentRemoteMetadata(
  update: RemoteMetadataUpdate,
): Promise<AgentModelDefinition | null> {
  const agents = await readAgentModelsFile();
  const index = agents.findIndex((agent) => agent.id === update.id);
  if (index < 0) {
    return null;
  }
  const existing = agents[index];
  const next: AgentModelDefinition = {
    ...existing,
    ...(update.remoteId ? { remoteId: update.remoteId } : {}),
    ...(update.remoteAccountId
      ? { remoteAccountId: update.remoteAccountId }
      : {}),
    ...(update.remoteContentHash
      ? { remoteContentHash: update.remoteContentHash }
      : {}),
  };
  if (update.remoteId === undefined) {
    delete next.remoteId;
    delete next.remoteAccountId;
  }
  if (update.remoteAccountId === undefined) delete next.remoteAccountId;
  if (update.remoteContentHash === undefined) {
    delete next.remoteContentHash;
  }
  if (agentsEqual(existing, next)) {
    return existing;
  }
  const updated = [...agents];
  updated[index] = next;
  await writeAgentModelsFile(updated);
  return next;
}

export async function clearAgentRemoteMetadataByRemoteId(
  remoteId: string,
): Promise<number> {
  const agents = await readAgentModelsFile();
  let clearedCount = 0;
  const updated = agents.map((agent) => {
    if (agent.remoteId !== remoteId) {
      return agent;
    }
    clearedCount += 1;
    const next: AgentModelDefinition = { ...agent };
    delete next.remoteId;
    delete next.remoteAccountId;
    delete next.remoteContentHash;
    return next;
  });

  if (clearedCount === 0) {
    return 0;
  }

  await writeAgentModelsFile(updated);
  return clearedCount;
}

/**
 * Updates an Agent copy the organization capabilities layer made when its
 * organization's share changed (CAN-6237, phase 10a): the same id, the name
 * kept unless the share renamed it, the new content and content hashes.
 * Null, with nothing written, when the copy is gone, is not an import of
 * this share, the person changed it (it is theirs now) or the share is
 * unchanged: the caller imports as usual then. Never used for a person's
 * own import.
 */
export async function updateOrganizationAgentCopy(
  id: string,
  detail: SharedAgentDetail,
  pluginSelections: ChatTabPluginSelections,
): Promise<AgentModelDefinition | null> {
  const validation = validateSharedAgentDocument(detail.agent);
  if (!validation.ok) throw new Error(validation.error);
  const agents = await readAgentModelsFile();
  const index = agents.findIndex((agent) => agent.id === id);
  const existing = index >= 0 ? agents[index] : undefined;
  if (
    !existing ||
    existing.importedFromRemoteId !== detail.id ||
    !importedContentUnchanged(existing) ||
    existing.remoteContentHash === detail.contentHash
  )
    return null;
  const document = validation.document;
  assertInstructions(document.instructions);
  assertBaseModel(document.baseModel);
  const updated = withLocalHash({
    ...existing,
    name: resolveCopyName(
      document.name,
      agents.filter((agent) => agent.id !== id),
    ),
    baseModel: document.baseModel,
    instructions: document.instructions,
    pluginSelections: normalizePluginSelections(pluginSelections),
    updatedAt: new Date().toISOString(),
    remoteContentHash: detail.contentHash,
  });
  updated.importedContentHash = updated.contentHash;
  await recordSharedAgentInstall(detail, id);
  // A save may have landed while the receipt was recorded: read the list
  // again and write only if the copy is still the unchanged import checked
  // above, so a person's edit is never overwritten (it is theirs then).
  const latest = await readAgentModelsFile();
  const current = latest.find((agent) => agent.id === id);
  if (
    !current ||
    current.contentHash !== existing.contentHash ||
    !importedContentUnchanged(current)
  )
    return null;
  await writeAgentModelsFile(
    latest.map((agent) => (agent.id === id ? updated : agent)),
  );
  registerSharedAgentImport(updated, detail);
  return updated;
}

export async function importSharedAgent(
  detail: SharedAgentDetail,
  pluginSelections: ChatTabPluginSelections,
): Promise<ImportSharedAgentResponse> {
  const validation = validateSharedAgentDocument(detail.agent);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const agents = await readAgentModelsFile();
  const document = validation.document;
  const scoped = agentResourceContextEnabled();
  const existingByRemoteMetadata = agents.find(
    (agent) =>
      (!scoped ||
        ((agent.importedFromRemoteId === detail.id ||
          (agent.importedFromRemoteId === undefined &&
            agent.remoteId === detail.id)) &&
          importedContentUnchanged(agent))) &&
      (agent.importedFromRemoteId === detail.id ||
        // Compatibility for copies imported before source provenance was
        // separated from the author's own share link.
        (agent.importedFromRemoteId === undefined &&
          agent.remoteId === detail.id)) &&
      agent.remoteContentHash === detail.contentHash,
  );
  if (existingByRemoteMetadata) {
    const legacyRemoteLink =
      existingByRemoteMetadata.importedFromRemoteId === undefined;
    const legacyImport =
      legacyRemoteLink &&
      !(await sharedAgentIsAuthoredByCurrentAccount(detail));
    const importedAgent = legacyImport
      ? { ...existingByRemoteMetadata }
      : existingByRemoteMetadata;
    if (legacyImport) {
      importedAgent.importedFromRemoteId = detail.id;
      delete importedAgent.remoteId;
      await writeAgentModelsFile(
        agents.map((agent) =>
          agent.id === importedAgent.id ? importedAgent : agent,
        ),
      );
    }
    await recordSharedAgentInstall(detail, importedAgent.id);
    registerSharedAgentImport(importedAgent, detail);
    return {
      agent: importedAgent,
      requestedId: document.id,
      finalId: importedAgent.id,
      idChanged: importedAgent.id !== document.id,
    };
  }

  const existingByDocumentId = agents.find((agent) => agent.id === document.id);
  if (
    existingByDocumentId &&
    (!scoped ||
      ((existingByDocumentId.importedFromRemoteId === detail.id ||
        (existingByDocumentId.importedFromRemoteId === undefined &&
          existingByDocumentId.remoteId === detail.id)) &&
        importedContentUnchanged(existingByDocumentId))) &&
    (existingByDocumentId.importedFromRemoteId === detail.id ||
      (existingByDocumentId.importedFromRemoteId === undefined &&
        existingByDocumentId.remoteId === detail.id)) &&
    existingByDocumentId.remoteContentHash === detail.contentHash
  ) {
    await recordSharedAgentInstall(detail, existingByDocumentId.id);
    registerSharedAgentImport(existingByDocumentId, detail);
    return {
      agent: existingByDocumentId,
      requestedId: document.id,
      finalId: existingByDocumentId.id,
      idChanged: existingByDocumentId.id !== document.id,
    };
  }

  assertInstructions(document.instructions);
  assertBaseModel(document.baseModel);

  const name = resolveCopyName(document.name, agents);
  const usedIds = agents.map((agent) => agent.id);
  const id = resolveAgentModelIdCollision(document.id, usedIds);
  const now = new Date().toISOString();
  const imported = withLocalHash({
    id,
    name,
    baseModel: document.baseModel,
    instructions: document.instructions,
    pluginSelections: normalizePluginSelections(pluginSelections),
    createdAt: now,
    updatedAt: now,
    importedFromRemoteId: detail.id,
    remoteContentHash: detail.contentHash,
  });
  if (scoped) imported.importedContentHash = imported.contentHash;
  await recordSharedAgentInstall(detail, id);
  await writeAgentModelsFile([...agents, imported]);
  registerSharedAgentImport(imported, detail);
  return {
    agent: imported,
    requestedId: document.id,
    finalId: imported.id,
    idChanged: imported.id !== document.id,
  };
}

function matchesPublicAgentDocument(
  agent: AgentModelDefinition,
  document: SharedAgentDocument,
  pluginSelections: ChatTabPluginSelections,
  externalId: string,
  contentHash: string,
): boolean {
  const normalizedName = normalizeName(document.name);
  const isResolvedCopy = (
    value: string,
    base: string,
    prefix: string,
    suffix = '',
  ): boolean => {
    const start = `${base}${prefix}`;
    if (!value.startsWith(start) || !value.endsWith(suffix)) return false;
    const digits = value.slice(
      start.length,
      suffix ? -suffix.length : undefined,
    );
    const copyNumber = Number(digits);
    return (
      Number.isSafeInteger(copyNumber) &&
      copyNumber >= 2 &&
      String(copyNumber) === digits
    );
  };
  return (
    (!agentResourceContextEnabled() || importedContentUnchanged(agent)) &&
    agent.publicShareExternalId === externalId &&
    agent.publicShareContentHash === contentHash &&
    (agent.id === document.id || isResolvedCopy(agent.id, document.id, '_')) &&
    (agent.name === normalizedName ||
      isResolvedCopy(agent.name, normalizedName, ' (', ')')) &&
    agent.baseModel === document.baseModel &&
    agent.instructions === document.instructions &&
    JSON.stringify(normalizePluginSelections(agent.pluginSelections)) ===
      JSON.stringify(normalizePluginSelections(pluginSelections))
  );
}

export async function findInstalledPublicAgent(
  document: SharedAgentDocument,
  pluginSelections: ChatTabPluginSelections,
  externalId: string,
  contentHash: string,
): Promise<AgentModelDefinition | null> {
  const validation = validateSharedAgentDocument(document);
  if (!validation.ok) throw new Error(validation.error);
  const agents = await readAgentModelsFile();
  return (
    agents.find((agent) =>
      matchesPublicAgentDocument(
        agent,
        validation.document,
        pluginSelections,
        externalId,
        contentHash,
      ),
    ) ?? null
  );
}

export async function importPublicAgent(
  document: SharedAgentDocument,
  pluginSelections: ChatTabPluginSelections,
  externalId: string,
  contentHash: string,
): Promise<AgentModelDefinition> {
  const validation = validateSharedAgentDocument(document);
  if (!validation.ok) throw new Error(validation.error);
  const normalizedDocument = validation.document;
  const normalizedSelections = normalizePluginSelections(pluginSelections);
  const agents = await readAgentModelsFile();
  const existing = agents.find((agent) =>
    matchesPublicAgentDocument(
      agent,
      normalizedDocument,
      normalizedSelections,
      externalId,
      contentHash,
    ),
  );
  if (existing) {
    registerPublicAgentImport(existing);
    return existing;
  }

  assertInstructions(normalizedDocument.instructions);
  assertBaseModel(normalizedDocument.baseModel);
  const now = new Date().toISOString();
  const imported = withLocalHash({
    id: resolveAgentModelIdCollision(
      normalizedDocument.id,
      agents.map((agent) => agent.id),
    ),
    name: resolveCopyName(normalizedDocument.name, agents),
    baseModel: normalizedDocument.baseModel,
    instructions: normalizedDocument.instructions,
    pluginSelections: normalizedSelections,
    createdAt: now,
    updatedAt: now,
    publicShareExternalId: externalId,
    publicShareContentHash: contentHash,
  });
  if (agentResourceContextEnabled())
    imported.importedContentHash = imported.contentHash;
  await writeAgentModelsFile([...agents, imported]);
  registerPublicAgentImport(imported);
  return imported;
}

export async function uninstallPublicAgent(
  agentId: string,
  externalId: string,
  contentHash: string,
): Promise<boolean> {
  await assertStoredAgentContext(agentId);
  const agents = await readAgentModelsFile();
  const installed = agents.find((agent) => agent.id === agentId);
  if (!installed) return false;
  if (
    installed.publicShareExternalId !== externalId ||
    installed.publicShareContentHash !== contentHash
  ) {
    throw new Error('The Agent is not an installed copy of this public share.');
  }
  if (agentResourceContextEnabled()) assertImportedContentUnchanged(installed);
  await writeAgentModelsFile(agents.filter((agent) => agent.id !== agentId));
  unregisterAgentInstalls(installed);
  return true;
}

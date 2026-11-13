import { constants as fsConstants } from 'node:fs';
import {
  ensureWorkspaceWriteDirectory,
  withWorkspaceDirectoryWrite,
} from './cowork-folder-guard';
import {
  detachInputDelivery,
  isInputLedger,
} from '@canopy/desktop-shared/chat-input-delivery';
import type { ModelHarness } from '@canopy/execution-engine/model-harnesses';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  cp,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { resolveAgentAttachmentsDir } from './agent-attachments';
import { app, type BrowserWindow } from 'electron';
import type { SessionExportUploadMetadata } from '@canopy/protocol/session-exports';
import { CHAT_CUSTOM_TITLE_MAX_LENGTH } from '@canopy/protocol';
import { CANOPY_CLOUD_DISPLAY_NAME } from '@canopy/desktop-shared/constants/canopy-cloud';
import { getResolvedGitExecutableForSpawn } from './git-executable';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { normalizeMemoryByMessageId } from '@canopy/desktop-shared/lib/org-memory';
import { normalizeAgentArtifactCarryByTurn } from '@canopy/desktop-shared/lib/agent-artifacts';
import {
  isCodexSpeed,
  readCodexSpeedRecord,
  withCodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import { readCodexRolloutSeedItems } from '@canopy/execution-engine/node/codex-runtime';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
  getModelSource,
  hasAnySelections,
  inferLegacyExecutionHarness,
  isThinkingLevel,
  isTerminalBackedInterfaceMode,
  type ChatSessionCloudExportDeleteResponse,
  type ChatSessionCloudExportListRequest,
  type ChatSessionCloudExportListResponse,
  type ChatSessionExportRequest,
  type ChatSessionExportResponse,
  type ChatSessionImportInspectRequest,
  type ChatSessionImportInspectResponse,
  type ChatSessionImportCapabilityReadiness,
  type ChatSessionImportManifestSummary,
  type ChatSessionImportRequest,
  type ChatSessionImportResponse,
  type ChatSessionImportWorkspaceSummary,
  type ChatSessionImportedEvent,
  type PersistedChatTab,
  type SessionExportManifest,
  type SessionExportRepoEntry,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import {
  mapPluginSelectionsToPortable,
  type PortablePluginSelections,
} from '../plugins/workspace-template-authoring';
import { prepareDesktopWorkspaceTemplateRefs } from '../plugins/workspace-template-import';
import {
  loadShareablePluginCatalog,
  resolveShareablePluginRefs,
} from '../plugins/shareable-plugin-resolution';
import {
  getMcpServerStatusByCatalogId,
  getMcpServerStatusByName,
} from '../mcp/connection-status';
import { getActiveChatIds } from '../agents/session-manager';
import type { CanopyCloudCredentialContext } from '../canopy-cloud/client';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import { publishCodexReconstructionSeed } from '../codex/reconstruction-seed-store';
import { getCodexRuntimeService } from '../codex/runtime-service';
import {
  deleteSessionExport as deleteCloudSessionExport,
  downloadSessionExportBundle,
  getSessionExport,
  listSessionExports as listCloudSessionExports,
  uploadSessionExport,
} from '../session-exports/canopy-server-client';
import {
  repoIdentityKey,
  resolveRepoIdentity,
  resolveWorkspaceRepoIdentities,
} from './adhoc-combine-core';
import { readChatTabsFile, readChatTranscript } from './chat-tabs-reader';
import { upsertPersistedChatTab } from './chat-tab-dispatch-utils';
import { createWorkEntry, removeWorkEntryRow } from './cowork-work-entries';
import { loadCanopyCloudAccount } from './canopy-cloud-account-store';
import {
  claudeProjectDirCandidates,
  getClaudeCodeProjectsDir,
  resolveClaudeCodeSessionTranscriptPath,
} from './claude-project-paths';
import { findCodexRolloutFiles } from './codex-session-artifacts';
import {
  applyPatch3Way,
  doesLocalBranchExist,
  doesRemoteBranchExist,
  fetchOrigin,
  getCheckedOutBranch,
  getHeadCommitSha,
  getUncommittedBinaryDiffText,
  hasCommitsAheadOfUpstream,
  listCheckedOutBranches,
  listUntrackedFiles,
} from './git';
import { isPathInside } from './path-safety';
import { getWorkspaceWorktreeRepoDir, getWorktreeDir } from './paths';
import { resolveWorktreeCwd } from './resolve-worktree';
import { readAllSidebarItems } from './sidebar-items';
import { isRecord } from './type-guards';
import { validateAbsolutePath } from './validation';
import { startProjectWorktreePostCreateSetup } from './project-worktree-runtime';
import { startWorkspaceWorktreePostCreateSetup } from './workspace-worktree-runtime';
import { detachedWorkCallback } from '@canopy/desktop-shared/node/lib/detached-work';
import { cleanupPersistedWorktreeData } from './worktree-data-cleanup';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  createMultiRepoWorktree,
  createSingleRepoWorktree,
} from './worktree-service';
import { sendToWindow } from './window-send';
import {
  packSessionBundle,
  unpackSessionBundle,
} from './session-bundle-archive';

const MANIFEST_FILE_NAME = 'canopy-session.json';
const CODEX_SESSION_BUNDLE_PREFIX = 'provider/codex/sessions/';
export const CODEX_SESSION_SCAN_ENTRY_LIMIT = 10_000;
const IMPORT_ID_PREFIX = 'chat-import';
const STAGED_IMPORT_PREFIX = 'canopy-session-import-';
const SESSION_EXPORT_PREFIX = 'canopy-session-export-';
const SESSION_TRANSFER_OWNER_SEPARATOR = '-';
let importedChatIdCounter = 0;
type StagedImportRecord = {
  accountIdentity: string;
  exportId: string;
  archivePath?: string;
};
const stagedImportDirs = new Map<string, StagedImportRecord>();

// Compile-time exhaustiveness guard: every new PersistedChatTab field must be
// consciously classified as kept, regenerated, or stripped for portability.
export const SESSION_TRANSFER_FIELD_EXHAUSTIVENESS: Record<
  keyof PersistedChatTab,
  true
> = {
  // Stripped: local authorization lineage cannot be imported as a grant.
  executionContext: true,
  // Stripped: in-flight activation belongs to the originating host and task.
  mcpActivation: true,
  id: true,
  inputDelivery: true,
  // Stripped: this receipt belongs to the local resume queue.
  lastAcceptedUserMessageId: true,
  // Stripped: local turn-lifecycle bookkeeping of this host's chat queue.
  unacceptedTurnEnds: true,
  turnEnds: true,
  rootTurnInputIds: true,
  reducedRootTerminalTurnIds: true,
  interruptedTurns: true,
  title: true,
  // Kept: user-owned naming metadata travels with the transcript.
  customTitle: true,
  automaticTitleState: true,
  modelSelectionMode: true,
  // Kept: per-turn Auto history is keyed by user message id, which travels
  // with the transferred messages (same as `turnFeedback`).
  autoRoutedModels: true,
  description: true,
  messages: true,
  // Regenerated from destination transcript storage; never portable authority.
  transcript: true,
  transcriptLoaded: true,
  transcriptWindow: true,
  memoryByMessageId: true,
  agentArtifactCarryByTurn: true,
  createdAt: true,
  kind: true,
  filePath: true,
  fileViewMode: true,
  fileDiffContext: true,
  pinned: true,
  planMode: true,
  // Stripped: approval mode/rules are safety-sensitive local state. An
  // exported/imported session should fall back to the destination
  // environment's own approval defaults rather than carrying over bypass
  // grants (e.g. allow rules) from the source machine.
  approvalMode: true,
  sessionApprovalRules: true,
  thinkingLevel: true,
  // Kept in canonical form: the exact `speed` with its derived `fastMode`.
  // The deprecated alias below folds into it instead of being exported.
  modelConfig: true,
  codexFastModeEnabled: true,
  // Kept: the Codex speed a chat retained while running another provider.
  retainedCodexSpeed: true,
  model: true,
  modelExplicitlyChosen: true,
  billingExplicitlyChosen: true,
  defaultStampModel: true,
  providerType: true,
  executionHarness: true,
  // Stripped: the empty-draft choice marker is local UI state. The captured
  // executionHarness above still travels with a started conversation.
  executionHarnessExplicitlyChosen: true,
  pendingPlanExit: true,
  pendingPlanExitRequestId: true,
  // Stripped with trackedPlanId: plan identity belongs to the source workspace.
  trackedPlanImplementation: true,
  trackedPlanId: true,
  trackedPlanSource: true,
  trackedPlanReviewStatus: true,
  pendingSystemInstructions: true,
  hasOutstandingProposal: true,
  latestRevisionNumber: true,
  proposalMode: true,
  sdkSessionId: true,
  // Kept with the provider continuation so resumed imports preserve the exact
  // instruction context under which that provider session was created.
  globalInstructionsSnapshot: true,
  codexReconstructionSeedId: true,
  claudeForkSessionOnNextSend: true,
  autoArchive: true,
  autoArchiveTurnId: true,
  newChatStartedWatcherPending: true,
  newChatStartedWatcherFiredAt: true,
  adhocMigrationSource: true,
  forkedFrom: true,
  sharedRun: true,
  pendingRevertAttachmentPath: true,
  // Stripped: correlation belongs to the live terminal session on the source
  // renderer and must not attach provenance after a portable session import.
  pendingClaudeTerminalWatcherMessages: true,
  scheduledSendDraft: true,
  readOnly: true,
  staleSessionDetected: true,
  llmProviderUsageLimitBanner: true,
  // Stripped: the billing-source failure belongs to the source account and
  // must be re-derived if a transferred chat encounters it again.
  aiCreditsNoBillingSource: true,
  dismissedLlmProviderUsageLimitBannerKey: true,
  // Deprecated read-compat aliases; canonical load migrates them away.
  claudeUsageLimitBanner: true,
  dismissedClaudeUsageLimitBannerKey: true,
  aiCreditsRouting: true,
  aiCreditsRouted: true,
  subscriptionBillingOverride: true,
  pluginSelections: true,
  portablePluginSelections: true,
  // Kept: chat-local rejections of inherited defaults remain meaningful on
  // the importing machine (they suppress its project and global defaults too).
  disabledGlobalPluginSelections: true,
  // Stripped: the importing project has its own defaults, so the imported
  // chat is normalized against them before they next change.
  inheritedPluginDefaultsVersion: true,
  deferredToolsAllowed: true,
  discovery: true,
  usage: true,
  agentUsage: true,
  turnDiffs: true,
  // Kept: turn ratings are the rating author's own, and the correlation key
  // (`userMessageId`) travels with the transferred messages.
  turnFeedback: true,
  attentionDismissedAt: true,
  // Kept: unread is a small UX flag that transfers cleanly with the tab.
  unread: true,
  // Kept: qualifies `unread` and travels with it.
  unreadMarkedManually: true,
  selectedRepoId: true,
  interfaceMode: true,
  claudeTerminal: true,
};
void SESSION_TRANSFER_FIELD_EXHAUSTIVENESS;

/**
 * Portable Codex speed settings in canonical form: the exact `speed`, read
 * speed-first from the record and then the deprecated `codexFastModeEnabled`
 * alias, with its derived `fastMode` (never `true` for Ultra fast), plus the
 * Codex speed a non-Codex chat retained. Import runs the same projection.
 */
function portableCodexSpeedSettings(
  tab: PersistedChatTab,
): Pick<PersistedChatTab, 'modelConfig' | 'retainedCodexSpeed'> {
  const speed = readCodexSpeedRecord(tab.modelConfig, tab.codexFastModeEnabled);
  const modelConfig =
    speed === undefined
      ? tab.modelConfig
      : withCodexSpeed(tab.modelConfig, speed);
  return {
    ...(modelConfig !== undefined ? { modelConfig } : {}),
    ...(isCodexSpeed(tab.retainedCodexSpeed)
      ? { retainedCodexSpeed: tab.retainedCodexSpeed }
      : {}),
  };
}

export function sanitizeTabForExport(
  tab: PersistedChatTab,
  portablePluginSelections = tab.portablePluginSelections,
): PersistedChatTab {
  const userMessageIds = new Set(
    tab.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.id),
  );
  const memoryByMessageId = normalizeMemoryByMessageId(
    tab.memoryByMessageId,
    userMessageIds,
  );
  const agentArtifactCarryByTurn = normalizeAgentArtifactCarryByTurn(
    tab.agentArtifactCarryByTurn,
    userMessageIds,
  );
  return {
    id: tab.id,
    ...(tab.inputDelivery
      ? {
          inputDelivery: detachInputDelivery(
            tab,
            { projectId: '', worktreeId: '', chatId: tab.id },
            () => randomUUID(),
          ),
        }
      : {}),
    title: tab.title,
    ...(tab.customTitle !== undefined ? { customTitle: tab.customTitle } : {}),
    ...(tab.automaticTitleState !== undefined
      ? { automaticTitleState: tab.automaticTitleState }
      : {}),
    ...(tab.description !== undefined ? { description: tab.description } : {}),
    messages: tab.messages,
    ...(memoryByMessageId ? { memoryByMessageId } : {}),
    ...(agentArtifactCarryByTurn ? { agentArtifactCarryByTurn } : {}),
    createdAt: tab.createdAt,
    ...(tab.planMode !== undefined ? { planMode: tab.planMode } : {}),
    ...(tab.thinkingLevel !== undefined
      ? { thinkingLevel: tab.thinkingLevel }
      : {}),
    ...portableCodexSpeedSettings(tab),
    ...(tab.model !== undefined ? { model: tab.model } : {}),
    ...(tab.providerType !== undefined
      ? { providerType: tab.providerType }
      : {}),
    ...(tab.executionHarness !== undefined
      ? { executionHarness: tab.executionHarness }
      : {}),
    ...(tab.sdkSessionId !== undefined
      ? { sdkSessionId: tab.sdkSessionId }
      : {}),
    ...(tab.globalInstructionsSnapshot !== undefined
      ? { globalInstructionsSnapshot: tab.globalInstructionsSnapshot }
      : {}),
    ...(tab.pluginSelections !== undefined
      ? { pluginSelections: tab.pluginSelections }
      : {}),
    ...(portablePluginSelections !== undefined
      ? { portablePluginSelections }
      : {}),
    ...(tab.disabledGlobalPluginSelections !== undefined
      ? { disabledGlobalPluginSelections: tab.disabledGlobalPluginSelections }
      : {}),
    ...(tab.deferredToolsAllowed !== undefined
      ? { deferredToolsAllowed: tab.deferredToolsAllowed }
      : {}),
    ...(tab.usage !== undefined ? { usage: tab.usage } : {}),
    ...(tab.agentUsage !== undefined ? { agentUsage: tab.agentUsage } : {}),
    ...(tab.turnDiffs !== undefined ? { turnDiffs: tab.turnDiffs } : {}),
    ...(tab.selectedRepoId !== undefined
      ? { selectedRepoId: tab.selectedRepoId }
      : {}),
    ...(tab.pinned !== undefined ? { pinned: tab.pinned } : {}),
    ...(tab.aiCreditsRouted !== undefined
      ? { aiCreditsRouted: tab.aiCreditsRouted }
      : {}),
    ...(tab.subscriptionBillingOverride !== undefined
      ? { subscriptionBillingOverride: tab.subscriptionBillingOverride }
      : {}),
  };
}

async function resolvePortableSessionSelections(
  portable: PortablePluginSelections,
  installMissing: boolean,
): Promise<{
  selections: NonNullable<PersistedChatTab['pluginSelections']>;
  readiness: ChatSessionImportCapabilityReadiness[];
}> {
  if (installMissing) {
    await prepareDesktopWorkspaceTemplateRefs(portable.refs);
  }
  const matches = resolveShareablePluginRefs(
    portable.refs,
    await loadShareablePluginCatalog(),
  );
  const selections: NonNullable<PersistedChatTab['pluginSelections']> = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
  const readiness: ChatSessionImportCapabilityReadiness[] = [];
  for (const match of matches) {
    if (match.matchState === 'unmatched') {
      readiness.push({
        kind: 'plugin',
        name: match.displayName,
        status: 'missing',
        installable: true,
      });
    } else if (match.selection.kind === 'skill') {
      selections.skillRefs.push({
        sourceId: match.selection.sourceId,
        skillName: match.selection.skillName,
      });
      readiness.push({
        kind: 'plugin',
        name: match.catalogKey,
        status: 'available',
        installable: true,
      });
    } else {
      selections.pluginRefs.push({
        marketplaceId: match.selection.marketplaceId,
        pluginName: match.selection.pluginName,
      });
      readiness.push({
        kind: 'plugin',
        name: match.catalogKey,
        status: 'available',
        installable: true,
      });
    }
  }
  for (const server of portable.mcpServers) {
    const status =
      (server.catalogId
        ? await getMcpServerStatusByCatalogId(server.catalogId)
        : null) ?? (await getMcpServerStatusByName(server.name));
    const config = status?.configs[0];
    if (status && config) {
      selections.mcpServerRefs?.push({
        serverId: status.serverId,
        configId: config.configId,
      });
    }
    const setupRequired =
      !status ||
      !config ||
      status.connectionStatus === 'unknown' ||
      status.connectionStatus === 'auth_required' ||
      status.connectionStatus === 'unreachable';
    readiness.push({
      kind: 'mcp',
      name: server.name,
      status: setupRequired ? 'missing' : 'available',
      installable: false,
      ...(setupRequired
        ? { setupHint: `Connect ${server.name} in Settings.` }
        : {}),
    });
  }
  for (const unresolved of portable.unresolved) {
    readiness.push({
      kind: 'plugin',
      name: unresolved,
      status: 'missing',
      installable: false,
    });
  }
  return { selections, readiness };
}

export const resolvePortableSessionSelectionsForTesting =
  resolvePortableSessionSelections;

interface WorkspaceRepoDescriptor {
  repoId: string;
  name: string;
  sourcePath: string;
  checkoutPath?: string;
  remoteUrlHint?: string;
  identityKey?: string;
  remoteUrl?: string;
}

interface ParsedBundle {
  rootPath: string;
  manifest: SessionExportManifest;
}

type InspectedBundleResponse = Omit<
  ChatSessionImportInspectResponse,
  'exportId'
>;

interface InspectedBundle extends ParsedBundle {
  workspace: SidebarItem;
  destinationRepos: WorkspaceRepoDescriptor[];
  response: InspectedBundleResponse;
}

function optionalProperty<T>(
  value: T | undefined,
  build: (entry: T) => object,
): object {
  return value === undefined ? {} : build(value);
}

function toBundlePath(...segments: string[]): string {
  return join(...segments)
    .split(sep)
    .join('/');
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const child = relative(rootPath, candidatePath);
  return (
    child === '' ||
    (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

async function isSafeInputAttachment(
  attachmentsDir: string,
  sourcePath: string,
): Promise<boolean> {
  try {
    const sourceEntry = await lstat(sourcePath);
    if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink()) return false;
    const [canonicalRoot, canonicalSource] = await Promise.all([
      realpath(attachmentsDir),
      realpath(sourcePath),
    ]);
    return isPathWithin(canonicalRoot, canonicalSource);
  } catch {
    return false;
  }
}

async function isRegularBundleFile(
  rootPath: string,
  referencedFile: string,
): Promise<boolean> {
  const destination = resolve(rootPath, referencedFile);
  let currentPath = rootPath;
  for (const segment of referencedFile.split('/')) {
    currentPath = join(currentPath, segment);
    try {
      const entry = await lstat(currentPath);
      if (entry.isSymbolicLink()) {
        return false;
      }
      if (currentPath === destination) {
        return entry.isFile();
      }
      if (!entry.isDirectory()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return false;
}

function credentialFreeRemoteUrl(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!trimmed.includes('://')) {
    const scpMatch = trimmed.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
    return scpMatch ? `${scpMatch[1]}:${scpMatch[2]}` : undefined;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

async function loadWorkspace(workspaceId: string): Promise<SidebarItem> {
  const sidebar = await readAllSidebarItems();
  const workspace = sidebar.items.find((item) => item.id === workspaceId);
  if (!workspace) {
    throw new Error(`Project ${workspaceId} was not found`);
  }
  return workspace;
}

function describeWorkspaceRepos(
  workspace: SidebarItem,
  worktreeId?: string,
): WorkspaceRepoDescriptor[] {
  if (workspace.type === 'cowork') {
    return [];
  }
  if (workspace.type === 'single-repo') {
    return [
      {
        repoId: workspace.id,
        name: workspace.name,
        sourcePath: workspace.repoPath,
        ...(worktreeId
          ? { checkoutPath: getWorktreeDir(workspace.id, worktreeId) }
          : {}),
      },
    ];
  }

  const descriptors: WorkspaceRepoDescriptor[] = [];
  if (workspace.sourceRepoPath) {
    descriptors.push({
      repoId: WORKSPACE_ROOT_REPO_ID,
      name: workspace.name,
      sourcePath: workspace.sourceRepoPath,
      ...(worktreeId
        ? { checkoutPath: getWorktreeDir(workspace.id, worktreeId) }
        : {}),
    });
  }
  for (const repo of workspace.repos) {
    descriptors.push({
      repoId: repo.id,
      name: repo.name,
      sourcePath: repo.repoPath,
      ...(repo.manifestUrl ? { remoteUrlHint: repo.manifestUrl } : {}),
      ...(worktreeId
        ? {
            checkoutPath: getWorkspaceWorktreeRepoDir(
              workspace.id,
              worktreeId,
              repo.id,
            ),
          }
        : {}),
    });
  }
  return descriptors;
}

async function resolveDescriptorIdentities(
  descriptors: WorkspaceRepoDescriptor[],
): Promise<WorkspaceRepoDescriptor[]> {
  return Promise.all(
    descriptors.map(async (descriptor): Promise<WorkspaceRepoDescriptor> => {
      const identity = await resolveRepoIdentity(
        descriptor.sourcePath,
        descriptor.remoteUrlHint,
      );
      return {
        ...descriptor,
        identityKey: repoIdentityKey(identity),
        ...(identity.kind === 'remote'
          ? { remoteUrl: identity.remoteUrl }
          : {}),
      };
    }),
  );
}

async function resolveWorkspaceDescriptorIdentities(
  workspace: SidebarItem,
  descriptors: WorkspaceRepoDescriptor[],
): Promise<WorkspaceRepoDescriptor[]> {
  if (workspace.type === 'cowork') {
    return [];
  }
  if (workspace.type === 'single-repo') {
    return resolveDescriptorIdentities(descriptors);
  }

  const childRepos = workspace.repos.filter(
    (repo) => repo.id !== WORKSPACE_ROOT_REPO_ID,
  );
  const childIdentities = await resolveWorkspaceRepoIdentities(workspace);
  const childIdentityByRepoId = new Map(
    childRepos.map((repo, index) => [repo.id, childIdentities[index]]),
  );
  return Promise.all(
    descriptors.map(async (descriptor): Promise<WorkspaceRepoDescriptor> => {
      const identity =
        descriptor.repoId === WORKSPACE_ROOT_REPO_ID
          ? await resolveRepoIdentity(
              descriptor.sourcePath,
              descriptor.remoteUrlHint,
            )
          : childIdentityByRepoId.get(descriptor.repoId);
      if (!identity) {
        throw new Error(
          `Repository identity was not resolved for ${descriptor.name}`,
        );
      }
      return {
        ...descriptor,
        identityKey: repoIdentityKey(identity),
        ...(identity.kind === 'remote'
          ? { remoteUrl: identity.remoteUrl }
          : {}),
      };
    }),
  );
}

function requireResolvedIdentity(descriptor: WorkspaceRepoDescriptor): string {
  if (!descriptor.identityKey) {
    throw new Error(
      `Repository identity was not resolved for ${descriptor.name}`,
    );
  }
  return descriptor.identityKey;
}

function requireCheckoutPath(descriptor: WorkspaceRepoDescriptor): string {
  if (!descriptor.checkoutPath) {
    throw new Error(
      `Worktree checkout was not resolved for ${descriptor.name}`,
    );
  }
  return descriptor.checkoutPath;
}

async function generateUntrackedPatch(
  repoPath: string,
  filePath: string,
): Promise<string> {
  const executable = await getResolvedGitExecutableForSpawn();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      executable,
      ['diff', '--no-index', '--binary', '--', '/dev/null', filePath],
      { cwd: repoPath, windowsHide: process.platform === 'win32' },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string): void => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string): void => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code): void => {
      if (code === 0 || code === 1) {
        resolvePromise(stdout);
        return;
      }
      reject(
        new Error(
          stderr.trim() || `Unable to export untracked file ${filePath}`,
        ),
      );
    });
  });
}

async function buildPortableDiff(repoPath: string): Promise<string> {
  // getUncommittedBinaryDiffText throws on failure and emits `--binary`
  // hunks: a swallowed tracked diff or a "Binary files differ" stub would
  // silently drop the user's changes from the bundle or make the whole
  // patch un-applyable on import.
  const [trackedDiff, untrackedFiles] = await Promise.all([
    getUncommittedBinaryDiffText(repoPath),
    listUntrackedFiles(repoPath),
  ]);
  const parts = trackedDiff.trim().length > 0 ? [trackedDiff] : [];
  const untrackedPatches = await Promise.all(
    [...untrackedFiles].sort().map(async (filePath): Promise<string> => {
      const candidate = resolve(repoPath, filePath);
      if (
        !isPathInside(repoPath, candidate) ||
        !(await pathIsFile(candidate))
      ) {
        return '';
      }
      return generateUntrackedPatch(repoPath, filePath);
    }),
  );
  for (const patch of untrackedPatches) {
    if (patch.trim().length > 0) {
      parts.push(patch);
    }
  }
  return parts.join(parts.length > 1 ? '\n' : '');
}

export { findCodexRolloutFiles } from './codex-session-artifacts';

async function copyProviderArtifactsForExport(args: {
  tab: PersistedChatTab;
  projectId: string;
  worktreeId: string;
  chatId: string;
  bundlePath: string;
  warnings: string[];
}): Promise<Pick<SessionExportManifest, 'claudeSession' | 'codexThread'>> {
  const sessionId = args.tab.sdkSessionId;
  if (!sessionId) {
    return {};
  }

  if (resolveTransferHarness(args.tab) === 'claude') {
    const cwd = resolveWorktreeCwd(
      args.projectId,
      args.worktreeId,
      args.tab.selectedRepoId,
    );
    const source = await resolveClaudeCodeSessionTranscriptPath(sessionId, cwd);
    if (!source) {
      args.warnings.push(
        `Claude session transcript ${sessionId} was not found; the visible transcript is included but provider resume data is not.`,
      );
      return {};
    }
    const file = toBundlePath('provider', 'claude', `${sessionId}.jsonl`);
    const destination = join(args.bundlePath, file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { force: false });
    return { claudeSession: { sessionId, file } };
  }

  if (resolveTransferHarness(args.tab) === 'codex') {
    const { codexHome } = await getCodexRuntimeService().getCanonicalState();
    const sessionsRoot = join(codexHome, 'sessions');
    // An unreadable sessions tree (EACCES/ENOTDIR) must degrade to the
    // rollout-not-found warning below, not fail the whole export.
    const rolloutFiles = await findCodexRolloutFiles(
      sessionsRoot,
      sessionId,
    ).catch(() => []);
    if (rolloutFiles.length === 0) {
      args.warnings.push(
        `Codex rollout files for thread ${sessionId} were not found; the visible transcript is included but provider resume data is not.`,
      );
      return {};
    }
    const files: string[] = [];
    for (const source of rolloutFiles) {
      const relativePath = relative(sessionsRoot, source);
      const file = toBundlePath('provider', 'codex', 'sessions', relativePath);
      const destination = join(args.bundlePath, file);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { force: false });
      files.push(file);
    }
    return { codexThread: { threadId: sessionId, files } };
  }

  return {};
}

async function requireSessionExportAccountContext(): Promise<{
  identity: string;
  credentials: CanopyCloudCredentialContext;
}> {
  const account = await loadCanopyCloudAccount();
  if (!account || isGuestAccount(account)) {
    throw new Error(
      `Sign in to ${CANOPY_CLOUD_DISPLAY_NAME} to transfer chat sessions.`,
    );
  }
  return {
    identity:
      account.account?.id ??
      account.serverApiKeyId ??
      createHash('sha256').update(account.apiKey).digest('hex'),
    credentials: {
      baseUrl: getCanopyCloudBaseUrl(),
      apiKey: account.apiKey,
      capabilities: [...account.capabilities],
    },
  };
}

async function requireSessionExportAccount(): Promise<string> {
  return (await requireSessionExportAccountContext()).identity;
}

export async function exportChatSession(
  request: ChatSessionExportRequest,
): Promise<ChatSessionExportResponse> {
  const exportAccount = await requireSessionExportAccountContext();
  const workspace = await loadWorkspace(request.projectId);
  const tabs = await readChatTabsFile(request.projectId, request.worktreeId);
  const sourceMetadata = tabs.tabs.find((tab) => tab.id === request.chatId);
  const sourceTab: PersistedChatTab | undefined = sourceMetadata
    ? { ...sourceMetadata, messages: [] }
    : undefined;
  if (!sourceTab) {
    throw new Error(`Chat ${request.chatId} was not found`);
  }
  if (sourceTab.kind === 'file') {
    throw new Error('File tabs cannot be exported as chat sessions');
  }
  if (isTerminalBackedInterfaceMode(sourceTab.interfaceMode)) {
    throw new Error(
      'Claude Code terminal sessions cannot be exported in this bundle format',
    );
  }
  if (
    getActiveChatIds(request.projectId, request.worktreeId).includes(
      request.chatId,
    )
  ) {
    throw new Error('Active chat sessions cannot be exported');
  }
  // Resolve canonical state only at this flush boundary to avoid the
  // transfer/chat-adapter initialization cycle.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  await getChatStateService().flushScope(request.projectId, request.worktreeId);
  // The bundle carries no delegate logs: delegated tasks carry their
  // children as rows.
  sourceTab.messages = await readChatTranscript(
    request.projectId,
    request.worktreeId,
    request.chatId,
    true,
    { inlineDelegationChildren: true },
  );

  const descriptors = await resolveWorkspaceDescriptorIdentities(
    workspace,
    describeWorkspaceRepos(workspace, request.worktreeId),
  );
  const localOnlyRepo = descriptors.find(
    (descriptor) => !descriptor.identityKey?.startsWith('remote:'),
  );
  if (localOnlyRepo) {
    throw new Error(
      `Repository "${localOnlyRepo.name}" has no remote and cannot be transferred`,
    );
  }

  const warnings: string[] = [];
  const tempRoot = await mkdtemp(
    join(
      tmpdir(),
      `${SESSION_EXPORT_PREFIX}${process.pid}${SESSION_TRANSFER_OWNER_SEPARATOR}`,
    ),
  );
  const bundlePath = join(tempRoot, 'bundle');
  const archivePath = join(tempRoot, 'bundle.tar.gz');
  try {
    await mkdir(bundlePath, { recursive: true });
    const repos: SessionExportRepoEntry[] = [];
    for (const descriptor of descriptors) {
      const checkoutPath = requireCheckoutPath(descriptor);
      const [branchName, headSha, commitsAhead, patchText] = await Promise.all([
        getCheckedOutBranch(checkoutPath),
        getHeadCommitSha(checkoutPath),
        hasCommitsAheadOfUpstream(checkoutPath),
        buildPortableDiff(checkoutPath),
      ]);
      if (!branchName) {
        throw new Error(`Repository "${descriptor.name}" has a detached HEAD`);
      }
      if (!headSha) {
        throw new Error(`Repository "${descriptor.name}" has no HEAD commit`);
      }
      if (commitsAhead) {
        warnings.push(
          `Repository "${descriptor.name}" has unpushed commits. Push before exporting or these commits won't transfer.`,
        );
      }
      const diffFile = toBundlePath('diffs', `${descriptor.repoId}.patch`);
      if (patchText.trim().length > 0) {
        const patchPath = join(bundlePath, diffFile);
        await mkdir(dirname(patchPath), { recursive: true });
        await writeFile(patchPath, patchText, 'utf8');
      }
      repos.push({
        repoId: descriptor.repoId,
        identityKey: requireResolvedIdentity(descriptor),
        ...optionalProperty(
          descriptor.remoteUrl
            ? credentialFreeRemoteUrl(descriptor.remoteUrl)
            : undefined,
          (remoteUrl) => ({ remoteUrl }),
        ),
        name: descriptor.name,
        branchName,
        headSha,
        ...(patchText.trim().length > 0 ? { diffFile } : {}),
      });
    }

    const portablePluginSelections = sourceTab.pluginSelections
      ? await mapPluginSelectionsToPortable(sourceTab.pluginSelections)
      : undefined;
    const tab = sanitizeTabForExport(sourceTab, portablePluginSelections);
    const inputAttachments: NonNullable<
      SessionExportManifest['inputAttachments']
    > = [];
    if (isInputLedger(tab.inputDelivery)) {
      const attachmentsDir = resolveAgentAttachmentsDir(
        request.projectId,
        request.worktreeId,
      );
      const paths = Array.from(
        new Set(
          tab.inputDelivery.rows.flatMap(
            (row) => row.payload.attachmentPaths ?? [],
          ),
        ),
      );
      for (const sourcePath of paths) {
        if (!(await isSafeInputAttachment(attachmentsDir, sourcePath))) {
          warnings.push(
            'An unsent message attachment cannot be exported safely. Its reference is retained, and it must be restored before resending.',
          );
          continue;
        }
        const extension = /^\.[a-zA-Z0-9]{1,12}$/.test(extname(sourcePath))
          ? extname(sourcePath)
          : '';
        const file = toBundlePath(
          'input-attachments',
          `${randomUUID()}${extension}`,
        );
        await mkdir(dirname(join(bundlePath, file)), { recursive: true });
        await cp(sourcePath, join(bundlePath, file), {
          dereference: false,
          errorOnExist: true,
          force: false,
        });
        inputAttachments.push({ sourcePath, file });
      }
    }
    const providerArtifacts = await copyProviderArtifactsForExport({
      tab,
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId: request.chatId,
      bundlePath,
      warnings,
    });
    const manifest: SessionExportManifest = {
      version: 1,
      appVersion: app.getVersion(),
      exportedAt: new Date().toISOString(),
      source: {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        workspaceName: workspace.name,
      },
      workspaceType: workspace.type,
      tab,
      repos,
      ...(inputAttachments.length ? { inputAttachments } : {}),
      ...providerArtifacts,
    };

    // Manifest-last makes an incomplete bundle impossible to mistake for a
    // completed export.
    await writeFile(
      join(bundlePath, MANIFEST_FILE_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    const packed = await packSessionBundle(bundlePath, archivePath);
    const metadata: SessionExportUploadMetadata = {
      title: manifest.tab.title,
      workspaceName: manifest.source.workspaceName,
      workspaceType: manifest.workspaceType,
      manifestVersion: manifest.version,
      appVersion: manifest.appVersion,
      sourceChatId: manifest.source.chatId,
      ...(manifest.claudeSession
        ? { claudeSessionId: manifest.claudeSession.sessionId }
        : {}),
      ...(manifest.codexThread
        ? { codexThreadId: manifest.codexThread.threadId }
        : {}),
      repos: manifest.repos.map((repo) => ({
        name: repo.name,
        branchName: repo.branchName,
        ...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl } : {}),
      })),
      contentHash: packed.contentHash,
    };
    const uploaded = await uploadSessionExport(
      metadata,
      { filePath: archivePath },
      exportAccount.credentials,
    );
    return {
      exportId: uploaded.id,
      title: uploaded.title,
      sizeBytes: uploaded.sizeBytes,
      warnings,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function listSessionExports(
  request: ChatSessionCloudExportListRequest,
): Promise<ChatSessionCloudExportListResponse> {
  await requireSessionExportAccount();
  const response = await listCloudSessionExports(request);
  return {
    data: response.data.map((record) => ({
      id: record.id,
      title: record.title,
      workspaceName: record.workspaceName,
      workspaceType: record.workspaceType,
      repos: record.repos.map((repo) => ({
        name: repo.name,
        branchName: repo.branchName,
        ...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl } : {}),
      })),
      sizeBytes: record.sizeBytes,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })),
    nextCursor: response.nextCursor,
  };
}

export async function deleteSessionExport(
  exportId: string,
): Promise<ChatSessionCloudExportDeleteResponse> {
  await requireSessionExportAccount();
  await deleteCloudSessionExport(exportId);
  return { deleted: true };
}

async function discardStagedSessionImportPath(
  sourcePath: string,
): Promise<void> {
  const record = stagedImportDirs.get(sourcePath);
  if (!record) {
    return;
  }
  await Promise.all([
    rm(sourcePath, { recursive: true, force: true }),
    ...(record.archivePath ? [rm(record.archivePath, { force: true })] : []),
  ]);
  stagedImportDirs.delete(sourcePath);
}

function findStagedSessionImport(
  exportId: string,
): { sourcePath: string; record: StagedImportRecord } | null {
  for (const [sourcePath, record] of Array.from(stagedImportDirs.entries())) {
    if (record.exportId === exportId) {
      return { sourcePath, record };
    }
  }
  return null;
}

export async function discardStagedSessionImport(
  exportId: string,
): Promise<void> {
  const stagedImport = findStagedSessionImport(exportId);
  if (!stagedImport) {
    return;
  }
  await discardStagedSessionImportPath(stagedImport.sourcePath);
}

export async function discardAllStagedSessionImports(): Promise<void> {
  const sourcePaths: string[] = Array.from(stagedImportDirs.keys());
  const results = await Promise.allSettled(
    sourcePaths.map((sourcePath) => discardStagedSessionImportPath(sourcePath)),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) {
    throw failure.reason;
  }
}

function sessionTransferArtifactOwnerPid(name: string): number | null {
  const prefix = [STAGED_IMPORT_PREFIX, SESSION_EXPORT_PREFIX].find((value) =>
    name.startsWith(value),
  );
  if (!prefix) {
    return null;
  }
  const ownerMatch = /^(\d+)-/.exec(name.slice(prefix.length));
  if (!ownerMatch) {
    return null;
  }
  const ownerPid = Number(ownerMatch[1]);
  return Number.isSafeInteger(ownerPid) && ownerPid > 0 ? ownerPid : null;
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}

export async function discardStaleSessionImportArtifacts(
  tempRoot: string = tmpdir(),
): Promise<void> {
  const entries = await readdir(tempRoot, { withFileTypes: true });
  const staleArtifactNames = entries
    .filter(
      (entry) =>
        (entry.name.startsWith(STAGED_IMPORT_PREFIX) &&
          (entry.name.endsWith('.tar.gz') || !entry.name.includes('.'))) ||
        (entry.isDirectory() && entry.name.startsWith(SESSION_EXPORT_PREFIX)),
    )
    .filter((entry) => {
      const ownerPid = sessionTransferArtifactOwnerPid(entry.name);
      return ownerPid === null || !isProcessAlive(ownerPid);
    })
    .map((entry) => entry.name);
  await Promise.allSettled(
    staleArtifactNames.map((name) =>
      rm(join(tempRoot, name), { recursive: true, force: true }),
    ),
  );
}

export async function stageCloudSessionExport(
  exportId: string,
): Promise<string> {
  const account = await requireSessionExportAccountContext();
  const record = await getSessionExport(exportId, account.credentials);
  const archiveBytes = await downloadSessionExportBundle(
    exportId,
    account.credentials,
  );
  const receivedContentHash = createHash('sha256')
    .update(archiveBytes)
    .digest('hex');
  if (receivedContentHash !== record.contentHash) {
    throw new Error(
      'Downloaded session export failed its integrity check. Try downloading it again.',
    );
  }

  await discardAllStagedSessionImports();
  const stagedDir = await mkdtemp(
    join(
      tmpdir(),
      `${STAGED_IMPORT_PREFIX}${process.pid}${SESSION_TRANSFER_OWNER_SEPARATOR}`,
    ),
  );
  // Keep the unredacted archive inside mkdtemp's private 0700 directory.
  // A sibling under the shared system temp root would inherit the process
  // umask and can be readable by other local users until extraction finishes.
  const archivePath = join(stagedDir, 'bundle.tar.gz');
  const stagedRecord: StagedImportRecord = {
    accountIdentity: account.identity,
    exportId,
    archivePath,
  };
  stagedImportDirs.set(stagedDir, stagedRecord);
  try {
    await writeFile(archivePath, archiveBytes, { mode: 0o600 });
    await unpackSessionBundle(archivePath, stagedDir);
    const canonicalStagedDir = await realpath(stagedDir);
    stagedImportDirs.delete(stagedDir);
    stagedImportDirs.set(canonicalStagedDir, stagedRecord);
    return canonicalStagedDir;
  } catch (error) {
    await discardStagedSessionImportPath(stagedDir).catch(() => undefined);
    throw error;
  } finally {
    await rm(archivePath, { force: true }).catch(() => undefined);
    delete stagedRecord.archivePath;
  }
}

function isPortablePluginSelections(
  value: unknown,
): value is PortablePluginSelections {
  return (
    isRecord(value) &&
    Array.isArray(value.refs) &&
    value.refs.length <= 100 &&
    value.refs.every(isRecord) &&
    Array.isArray(value.mcpServers) &&
    value.mcpServers.length <= 100 &&
    value.mcpServers.every(
      (server) =>
        isRecord(server) &&
        typeof server.name === 'string' &&
        server.name.length <= 256 &&
        (server.catalogId === undefined ||
          (typeof server.catalogId === 'string' &&
            server.catalogId.length <= 256)),
    ) &&
    Array.isArray(value.unresolved) &&
    value.unresolved.length <= 100 &&
    value.unresolved.every(
      (entry) => typeof entry === 'string' && entry.length <= 512,
    )
  );
}

function isPersistedChatTab(value: unknown): value is PersistedChatTab {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    (value.automaticTitleState === undefined ||
      value.automaticTitleState === 'pending' ||
      value.automaticTitleState === 'closed') &&
    (value.customTitle === undefined ||
      (typeof value.customTitle === 'string' &&
        value.customTitle.length > 0 &&
        value.customTitle.length <= CHAT_CUSTOM_TITLE_MAX_LENGTH &&
        value.customTitle.trim() === value.customTitle)) &&
    (value.description === undefined ||
      typeof value.description === 'string') &&
    Array.isArray(value.messages) &&
    typeof value.createdAt === 'string' &&
    (value.planMode === undefined || typeof value.planMode === 'boolean') &&
    (value.thinkingLevel === undefined ||
      (typeof value.thinkingLevel === 'string' &&
        isThinkingLevel(value.thinkingLevel))) &&
    (value.modelConfig === undefined ||
      (isRecord(value.modelConfig) &&
        (value.modelConfig.thinkingLevel === undefined ||
          (typeof value.modelConfig.thinkingLevel === 'string' &&
            isThinkingLevel(value.modelConfig.thinkingLevel))) &&
        (value.modelConfig.speed === undefined ||
          isCodexSpeed(value.modelConfig.speed)) &&
        (value.modelConfig.fastMode === undefined ||
          typeof value.modelConfig.fastMode === 'boolean'))) &&
    (value.retainedCodexSpeed === undefined ||
      isCodexSpeed(value.retainedCodexSpeed)) &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.providerType === undefined ||
      value.providerType === 'claude' ||
      value.providerType === 'codex' ||
      value.providerType === 'ollama' ||
      value.providerType === 'cursor' ||
      value.providerType === 'copilot' ||
      value.providerType === 'opencode') &&
    (value.executionHarness === undefined ||
      value.executionHarness === 'claude' ||
      value.executionHarness === 'codex' ||
      value.executionHarness === 'cursor' ||
      value.executionHarness === 'copilot' ||
      value.executionHarness === 'opencode') &&
    isCompatibleManagedModelHarness(value.model, value.executionHarness) &&
    (value.sdkSessionId === undefined ||
      isSafeProviderSessionId(value.sdkSessionId)) &&
    (value.pluginSelections === undefined ||
      isRecord(value.pluginSelections)) &&
    (value.portablePluginSelections === undefined ||
      isPortablePluginSelections(value.portablePluginSelections)) &&
    (value.deferredToolsAllowed === undefined ||
      typeof value.deferredToolsAllowed === 'boolean') &&
    (value.usage === undefined || isRecord(value.usage)) &&
    (value.agentUsage === undefined || isRecord(value.agentUsage)) &&
    (value.turnDiffs === undefined || isRecord(value.turnDiffs)) &&
    (value.selectedRepoId === undefined ||
      typeof value.selectedRepoId === 'string') &&
    (value.pinned === undefined || typeof value.pinned === 'boolean') &&
    (value.pendingSystemInstructions === undefined ||
      (Array.isArray(value.pendingSystemInstructions) &&
        value.pendingSystemInstructions.every(
          (instruction) =>
            isRecord(instruction) &&
            typeof instruction.id === 'string' &&
            typeof instruction.text === 'string',
        ))) &&
    (value.readOnly === undefined || typeof value.readOnly === 'boolean') &&
    (value.aiCreditsRouted === undefined ||
      typeof value.aiCreditsRouted === 'boolean') &&
    (value.subscriptionBillingOverride === undefined ||
      typeof value.subscriptionBillingOverride === 'boolean')
  );
}

function isCompatibleManagedModelHarness(
  model: unknown,
  harness: unknown,
): boolean {
  if (typeof model !== 'string' || harness === undefined) return true;
  const source = getModelSource(model);
  if (source === 'claude-managed') return harness === 'claude';
  if (source === 'codex-managed') return harness === 'codex';
  if (source === 'opencode-managed') return harness === 'opencode';
  if (source === 'copilot-managed') return harness === 'copilot';
  if (source === 'cursor-managed') return harness === 'cursor';
  return true;
}

function isSafeProviderSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function isCodexSessionBundleFile(file: string): boolean {
  if (!file.startsWith(CODEX_SESSION_BUNDLE_PREFIX)) {
    return false;
  }
  const relativePath = file.slice(CODEX_SESSION_BUNDLE_PREFIX.length);
  return (
    relativePath.length > 0 &&
    !relativePath.includes('\\') &&
    relativePath
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function resolveTransferHarness(tab: PersistedChatTab): ModelHarness {
  return (
    tab.executionHarness ??
    inferLegacyExecutionHarness({
      model: tab.model,
      providerType: tab.providerType,
      hasStarted: tab.messages.length > 0 || Boolean(tab.sdkSessionId),
    }) ??
    (tab.providerType === 'opencode'
      ? 'opencode'
      : tab.providerType === 'copilot'
        ? 'copilot'
        : tab.providerType === 'cursor'
          ? 'cursor'
          : tab.providerType === 'codex'
            ? 'codex'
            : 'claude')
  );
}

function parseManifestRepo(value: unknown): SessionExportRepoEntry | null {
  if (
    !isRecord(value) ||
    typeof value.repoId !== 'string' ||
    typeof value.identityKey !== 'string' ||
    !value.identityKey.startsWith('remote:') ||
    value.identityKey.length === 'remote:'.length ||
    typeof value.name !== 'string' ||
    typeof value.branchName !== 'string' ||
    typeof value.headSha !== 'string' ||
    (value.remoteUrl !== undefined && typeof value.remoteUrl !== 'string') ||
    (value.diffFile !== undefined && typeof value.diffFile !== 'string')
  ) {
    return null;
  }
  return {
    repoId: value.repoId,
    identityKey: value.identityKey,
    ...optionalProperty(value.remoteUrl, (remoteUrl) => ({ remoteUrl })),
    name: value.name,
    branchName: value.branchName,
    headSha: value.headSha,
    ...optionalProperty(value.diffFile, (diffFile) => ({ diffFile })),
  };
}

function parseSessionExportManifest(raw: string): SessionExportManifest | null {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.appVersion !== 'string' ||
    typeof parsed.exportedAt !== 'string' ||
    (parsed.workspaceType !== 'single-repo' &&
      parsed.workspaceType !== 'multi-repo' &&
      parsed.workspaceType !== 'cowork') ||
    !isRecord(parsed.source) ||
    typeof parsed.source.projectId !== 'string' ||
    typeof parsed.source.worktreeId !== 'string' ||
    typeof parsed.source.chatId !== 'string' ||
    typeof parsed.source.workspaceName !== 'string' ||
    !isPersistedChatTab(parsed.tab) ||
    !Array.isArray(parsed.repos) ||
    (parsed.workspaceType === 'cowork'
      ? parsed.repos.length !== 0
      : parsed.repos.length === 0) ||
    parsed.tab.kind === 'file' ||
    isTerminalBackedInterfaceMode(parsed.tab.interfaceMode)
  ) {
    return null;
  }
  const repos: SessionExportRepoEntry[] = [];
  for (const value of parsed.repos) {
    const repo = parseManifestRepo(value);
    if (!repo) {
      return null;
    }
    repos.push(repo);
  }

  let claudeSession: SessionExportManifest['claudeSession'];
  const inputAttachments: NonNullable<
    SessionExportManifest['inputAttachments']
  > = [];
  if (parsed.inputAttachments !== undefined) {
    if (!Array.isArray(parsed.inputAttachments)) return null;
    const sources = new Set<string>();
    const files = new Set<string>();
    for (const value of parsed.inputAttachments) {
      if (
        !isRecord(value) ||
        typeof value.sourcePath !== 'string' ||
        !value.sourcePath ||
        typeof value.file !== 'string' ||
        !/^input-attachments\/[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9]{1,12})?$/.test(
          value.file,
        ) ||
        sources.has(value.sourcePath) ||
        files.has(value.file)
      )
        return null;
      sources.add(value.sourcePath);
      files.add(value.file);
      inputAttachments.push({ sourcePath: value.sourcePath, file: value.file });
    }
  }
  if (parsed.claudeSession !== undefined) {
    if (
      !isRecord(parsed.claudeSession) ||
      !isSafeProviderSessionId(parsed.claudeSession.sessionId) ||
      typeof parsed.claudeSession.file !== 'string'
    ) {
      return null;
    }
    claudeSession = {
      sessionId: parsed.claudeSession.sessionId,
      file: parsed.claudeSession.file,
    };
  }

  let codexThread: SessionExportManifest['codexThread'];
  if (parsed.codexThread !== undefined) {
    if (
      !isRecord(parsed.codexThread) ||
      !isSafeProviderSessionId(parsed.codexThread.threadId) ||
      !Array.isArray(parsed.codexThread.files) ||
      parsed.codexThread.files.length === 0 ||
      !parsed.codexThread.files.every(
        (file) => typeof file === 'string' && isCodexSessionBundleFile(file),
      )
    ) {
      return null;
    }
    codexThread = {
      threadId: parsed.codexThread.threadId,
      files: parsed.codexThread.files.filter(
        (file): file is string => typeof file === 'string',
      ),
    };
  }

  if (
    (claudeSession && codexThread) ||
    (claudeSession &&
      (resolveTransferHarness(parsed.tab) !== 'claude' ||
        parsed.tab.sdkSessionId !== claudeSession.sessionId)) ||
    (codexThread &&
      (resolveTransferHarness(parsed.tab) !== 'codex' ||
        parsed.tab.sdkSessionId !== codexThread.threadId))
  ) {
    return null;
  }

  return {
    version: 1,
    appVersion: parsed.appVersion,
    exportedAt: parsed.exportedAt,
    source: {
      projectId: parsed.source.projectId,
      worktreeId: parsed.source.worktreeId,
      chatId: parsed.source.chatId,
      workspaceName: parsed.source.workspaceName,
    },
    workspaceType: parsed.workspaceType,
    tab: sanitizeTabForExport(parsed.tab),
    repos,
    ...(inputAttachments.length ? { inputAttachments } : {}),
    ...optionalProperty(claudeSession, (entry) => ({ claudeSession: entry })),
    ...optionalProperty(codexThread, (entry) => ({ codexThread: entry })),
  };
}

function referencedBundleFiles(manifest: SessionExportManifest): string[] {
  return [
    ...manifest.repos.flatMap((repo) => (repo.diffFile ? [repo.diffFile] : [])),
    ...(manifest.claudeSession ? [manifest.claudeSession.file] : []),
    ...(manifest.codexThread ? manifest.codexThread.files : []),
    ...(manifest.inputAttachments?.map((entry) => entry.file) ?? []),
  ];
}

async function validateCodexSessionBundleFiles(
  rootPath: string,
  manifest: SessionExportManifest,
): Promise<void> {
  const expectedFiles = new Set(manifest.codexThread?.files ?? []);
  if (expectedFiles.size === 0) {
    return;
  }

  const sessionsRoot = resolve(rootPath, CODEX_SESSION_BUNDLE_PREFIX);
  const pendingDirectories = [sessionsRoot];
  let visitedEntries = 0;
  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    if (!currentDirectory) {
      continue;
    }
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > CODEX_SESSION_SCAN_ENTRY_LIMIT) {
        throw new Error('Codex session bundle contains too many entries');
      }
      const entryPath = join(currentDirectory, entry.name);
      const bundlePath = relative(rootPath, entryPath).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Codex session bundle contains a symbolic link: ${bundlePath}`,
        );
      }
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !expectedFiles.has(bundlePath)) {
        throw new Error(
          `Codex session bundle contains an unlisted file: ${bundlePath}`,
        );
      }
    }
  }
}

async function readBundle(sourcePath: string): Promise<ParsedBundle> {
  validateAbsolutePath(sourcePath, 'sourcePath');
  if (!(await pathIsDirectory(sourcePath))) {
    throw new Error('Import source must be an existing directory');
  }
  const rootPath = await realpath(resolve(sourcePath));
  let manifest: SessionExportManifest | null = null;
  try {
    if (!(await isRegularBundleFile(rootPath, MANIFEST_FILE_NAME))) {
      throw new Error('Manifest must be a regular bundle file');
    }
    manifest = parseSessionExportManifest(
      await readFile(join(rootPath, MANIFEST_FILE_NAME), 'utf8'),
    );
  } catch {
    manifest = null;
  }
  if (!manifest) {
    throw new Error('Import source does not contain a valid session manifest');
  }

  const seenIdentityKeys = new Set<string>();
  for (const repo of manifest.repos) {
    if (seenIdentityKeys.has(repo.identityKey)) {
      throw new Error(`Session manifest repeats repository ${repo.name}`);
    }
    seenIdentityKeys.add(repo.identityKey);
  }
  for (const referencedFile of referencedBundleFiles(manifest)) {
    const resolvedPath = resolve(rootPath, referencedFile);
    if (!isPathInside(rootPath, resolvedPath)) {
      throw new Error(
        `Session bundle contains an unsafe file reference: ${referencedFile}`,
      );
    }
    if (!(await isRegularBundleFile(rootPath, referencedFile))) {
      throw new Error(
        `Session bundle contains an unsafe or missing referenced file: ${referencedFile}`,
      );
    }
  }
  await validateCodexSessionBundleFiles(rootPath, manifest);
  return { rootPath, manifest };
}

function buildManifestSummary(
  manifest: SessionExportManifest,
): ChatSessionImportManifestSummary {
  return {
    title: manifest.tab.title,
    ...(manifest.tab.providerType
      ? { provider: manifest.tab.providerType }
      : {}),
    exportedAt: manifest.exportedAt,
    workspaceType: manifest.workspaceType,
    repoCount: manifest.repos.length,
    repos: manifest.repos.map((repo) => ({
      name: repo.name,
      ...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl } : {}),
      branchName: repo.branchName,
    })),
  };
}

function buildWorkspaceSummary(
  workspace: SidebarItem,
  repos: WorkspaceRepoDescriptor[],
): ChatSessionImportWorkspaceSummary {
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceType: workspace.type,
    repoCount: repos.length,
    repos: repos.map((repo) => ({
      name: repo.name,
      ...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl } : {}),
    })),
  };
}

async function inspectBundleForWorkspace(
  sourcePath: string,
  workspaceId: string,
): Promise<InspectedBundle> {
  const [bundle, workspace] = await Promise.all([
    readBundle(sourcePath),
    loadWorkspace(workspaceId),
  ]);
  const destinationRepos =
    workspace.type === 'cowork'
      ? []
      : await resolveWorkspaceDescriptorIdentities(
          workspace,
          describeWorkspaceRepos(workspace),
        );
  const workspaceTypeCompatible =
    (bundle.manifest.workspaceType === 'cowork') ===
    (workspace.type === 'cowork');
  const destinationKeys = new Set(
    destinationRepos.map(requireResolvedIdentity),
  );
  const missingRepos = bundle.manifest.repos
    .filter((repo) => !destinationKeys.has(repo.identityKey))
    .map((repo) => ({
      name: repo.name,
      ...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl } : {}),
    }));
  const match =
    !workspaceTypeCompatible || missingRepos.length > 0
      ? 'mismatch'
      : destinationRepos.length === bundle.manifest.repos.length
        ? 'exact'
        : 'superset';
  const warnings: string[] = [];
  if (match === 'superset') {
    warnings.push(
      'The destination project contains additional repositories; only repositories referenced by the bundle will receive changes.',
    );
  }
  if (
    bundle.manifest.tab.sdkSessionId &&
    !bundle.manifest.claudeSession &&
    resolveTransferHarness(bundle.manifest.tab) === 'claude'
  ) {
    warnings.push(
      'Claude provider resume data is not included; import will start a fresh provider session.',
    );
  }
  if (
    bundle.manifest.tab.sdkSessionId &&
    !bundle.manifest.codexThread &&
    resolveTransferHarness(bundle.manifest.tab) === 'codex'
  ) {
    warnings.push(
      'Codex provider resume data is not included; import will start a fresh provider session.',
    );
  }
  const capabilityReadiness = bundle.manifest.tab.portablePluginSelections
    ? (
        await resolvePortableSessionSelections(
          bundle.manifest.tab.portablePluginSelections,
          false,
        )
      ).readiness
    : undefined;
  return {
    ...bundle,
    workspace,
    destinationRepos,
    response: {
      manifestSummary: buildManifestSummary(bundle.manifest),
      workspaceSummary: buildWorkspaceSummary(workspace, destinationRepos),
      match,
      workspaceTypeCompatible,
      missingRepos,
      warnings,
      ...(capabilityReadiness ? { capabilityReadiness } : {}),
    },
  };
}

export async function inspectChatSessionImport(
  request: ChatSessionImportInspectRequest,
): Promise<ChatSessionImportInspectResponse> {
  const sourcePath = await stageCloudSessionExport(request.exportId);
  try {
    const response = (
      await inspectBundleForWorkspace(sourcePath, request.workspaceId)
    ).response;
    return { exportId: request.exportId, ...response };
  } catch (error) {
    await discardStagedSessionImportPath(sourcePath).catch(() => undefined);
    throw error;
  }
}

export function getStagedSessionImportPathForTesting(
  exportId: string,
): string | null {
  return findStagedSessionImport(exportId)?.sourcePath ?? null;
}

function nextImportedChatId(existingIds: Set<string>): string {
  const timestamp = Date.now();
  importedChatIdCounter += 1;
  let candidate = `${IMPORT_ID_PREFIX}-${timestamp}-${importedChatIdCounter}`;
  while (existingIds.has(candidate)) {
    importedChatIdCounter += 1;
    candidate = `${IMPORT_ID_PREFIX}-${timestamp}-${importedChatIdCounter}`;
  }
  return candidate;
}

async function chooseExistingBranch(args: {
  workspace: Exclude<SidebarItem, { type: 'cowork' }>;
  manifest: SessionExportManifest;
  destinationRepos: WorkspaceRepoDescriptor[];
  warnings: string[];
}): Promise<string | undefined> {
  const branchNames = new Set(
    args.manifest.repos.map((repo) => repo.branchName),
  );
  if (branchNames.size !== 1) {
    args.warnings.push(
      'The exported repositories used different branches; a fresh worktree was created from the destination defaults.',
    );
    return undefined;
  }
  const branchName = args.manifest.repos[0]?.branchName;
  if (!branchName) {
    return undefined;
  }

  const availability = await Promise.all(
    args.destinationRepos.map(async (destination): Promise<boolean> => {
      await fetchOrigin(destination.sourcePath).catch(() => undefined);
      const [local, remote, checkedOut] = await Promise.all([
        doesLocalBranchExist(destination.sourcePath, branchName),
        doesRemoteBranchExist(destination.sourcePath, branchName),
        listCheckedOutBranches(destination.sourcePath),
      ]);
      return (local || remote) && !checkedOut.has(branchName);
    }),
  );
  const availableCount = availability.filter(Boolean).length;
  if (availableCount > 0 && availableCount < availability.length) {
    args.warnings.push(
      `Branch ${branchName} is usable in only some destination repositories; a fresh worktree was created from the destination defaults.`,
    );
    return undefined;
  }
  if (availableCount !== availability.length) {
    return undefined;
  }
  if (args.workspace.type === 'multi-repo' && !args.workspace.sourceRepoPath) {
    args.warnings.push(
      `Branch ${branchName} exists in the child repositories, but this project has no source-backed root; a fresh worktree was created from the destination defaults.`,
    );
    return undefined;
  }
  return branchName;
}

async function createImportDestination(args: {
  inspected: InspectedBundle;
  existingBranch?: string;
}): Promise<{ id: string }> {
  if (args.inspected.workspace.type === 'cowork') {
    const title =
      args.inspected.manifest.tab.description?.trim() ||
      args.inspected.manifest.tab.title.trim();
    const result = await createWorkEntry(args.inspected.workspace.id, {
      id: randomUUID(),
      ...(title ? { title } : {}),
    });
    return { id: result.entry.id };
  }
  return createImportWorktree({
    workspace: args.inspected.workspace,
    ...(args.existingBranch ? { existingBranch: args.existingBranch } : {}),
  });
}

async function createImportWorktree(args: {
  workspace: Exclude<SidebarItem, { type: 'cowork' }>;
  existingBranch?: string;
}): Promise<{ id: string }> {
  const options = {
    workspaceId: args.workspace.id,
    existingWorktreeIds: args.workspace.worktrees.map(
      (worktree) => worktree.id,
    ),
    ...(args.existingBranch ? { existingBranch: args.existingBranch } : {}),
  };
  if (args.workspace.type === 'single-repo') {
    return createSingleRepoWorktree(options);
  }
  const response = await createMultiRepoWorktree({
    ...options,
    // Without this flag a needs-repair root throws a CLI-worded `--repair`
    // error instead of returning the response shape guarded below.
    surfaceNeedsRepairInResponse: true,
  });
  if (response.needsRepair === true) {
    throw new Error(
      'The destination project root requires repair before a session can be imported',
    );
  }
  return response;
}

function remapSelectedRepoId(args: {
  sourceRepoId?: string;
  manifest: SessionExportManifest;
  destinationRepos: WorkspaceRepoDescriptor[];
}): string | undefined {
  if (!args.sourceRepoId) {
    return undefined;
  }
  const sourceRepo = args.manifest.repos.find(
    (repo) => repo.repoId === args.sourceRepoId,
  );
  if (!sourceRepo) {
    return undefined;
  }
  const destinationRepo = args.destinationRepos.find(
    (repo) => requireResolvedIdentity(repo) === sourceRepo.identityKey,
  );
  return destinationRepo?.repoId;
}

async function installClaudeSession(args: {
  bundle: ParsedBundle;
  cwd: string;
  warnings: string[];
}): Promise<boolean> {
  const session = args.bundle.manifest.claudeSession;
  if (!session) {
    return false;
  }
  const [projectDir] = await claudeProjectDirCandidates(args.cwd);
  if (!projectDir) {
    args.warnings.push('Claude transcript destination could not be resolved.');
    return false;
  }
  const destination = join(
    getClaudeCodeProjectsDir(),
    projectDir,
    `${session.sessionId}.jsonl`,
  );
  try {
    await access(destination);
    args.warnings.push(
      `Claude transcript ${destination} already exists and was not overwritten.`,
    );
    return true;
  } catch {
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(args.bundle.rootPath, session.file), destination, {
      force: false,
      errorOnExist: true,
    });
    return true;
  }
}

function withoutSessionId(tab: PersistedChatTab): PersistedChatTab {
  const {
    sdkSessionId: _sdkSessionId,
    codexReconstructionSeedId: _codexReconstructionSeedId,
    claudeForkSessionOnNextSend: _claudeForkSessionOnNextSend,
    ...rest
  } = tab;
  void _sdkSessionId;
  void _codexReconstructionSeedId;
  void _claudeForkSessionOnNextSend;
  return rest;
}

async function installProviderArtifacts(args: {
  bundle: ParsedBundle;
  tab: PersistedChatTab;
  projectId: string;
  worktreeId: string;
  chatId: string;
  cwd: string;
  warnings: string[];
}): Promise<PersistedChatTab> {
  if (resolveTransferHarness(args.tab) === 'claude') {
    const installed = await installClaudeSession({
      bundle: args.bundle,
      cwd: args.cwd,
      warnings: args.warnings,
    });
    return installed
      ? { ...args.tab, claudeForkSessionOnNextSend: true }
      : withoutSessionId(args.tab);
  }

  if (resolveTransferHarness(args.tab) === 'codex') {
    const thread = args.bundle.manifest.codexThread;
    if (!thread) {
      return withoutSessionId(args.tab);
    }
    try {
      const seedItems = (
        await Promise.all(
          thread.files.map((file) =>
            readCodexRolloutSeedItems(resolve(args.bundle.rootPath, file)),
          ),
        )
      ).flat();
      if (seedItems.length === 0) {
        args.warnings.push(
          'Codex provider history could not be reconstructed; the visible transcript will be used on the next turn.',
        );
        return withoutSessionId(args.tab);
      }
      const codexReconstructionSeedId =
        await publishCodexReconstructionSeed(seedItems);
      return {
        ...withoutSessionId(args.tab),
        codexReconstructionSeedId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      args.warnings.push(
        `Codex provider history could not be retained; the visible transcript will be used on the next turn. ${message}`,
      );
      return withoutSessionId(args.tab);
    }
  }

  return withoutSessionId(args.tab);
}

export async function importChatSession(
  request: ChatSessionImportRequest,
  getWindow: () => BrowserWindow | null,
): Promise<ChatSessionImportResponse> {
  const stagedImport = findStagedSessionImport(request.exportId);
  if (!stagedImport) {
    throw new Error(
      'This cloud export is not staged for import. Choose the export again.',
    );
  }
  const accountIdentity = await requireSessionExportAccount();
  if (stagedImport.record.accountIdentity !== accountIdentity) {
    throw new Error(
      'This staged session export belongs to a different cloud account. Choose the export again.',
    );
  }
  const inspected = await inspectBundleForWorkspace(
    stagedImport.sourcePath,
    request.workspaceId,
  );
  if (inspected.response.match === 'mismatch') {
    if (!inspected.response.workspaceTypeCompatible) {
      throw new Error(
        inspected.manifest.workspaceType === 'cowork'
          ? 'Cowork session exports can only be imported into a Cowork project'
          : 'Git-backed session exports can only be imported into a git-backed project',
      );
    }
    const missing = inspected.response.missingRepos
      .map((repo) => repo.remoteUrl ?? repo.name)
      .join(', ');
    throw new Error(`Destination project is missing repositories: ${missing}`);
  }

  const warnings = [...inspected.response.warnings];
  const existingBranch =
    inspected.workspace.type === 'cowork'
      ? undefined
      : await chooseExistingBranch({
          workspace: inspected.workspace,
          manifest: inspected.manifest,
          destinationRepos: inspected.destinationRepos,
          warnings,
        });
  const worktree = await createImportDestination({
    inspected,
    ...(existingBranch ? { existingBranch } : {}),
  });
  let result: ChatSessionImportResponse;
  try {
    result = await finalizeImportedSession({
      inspected,
      worktreeId: worktree.id,
      warnings,
      getWindow,
      installMissing: request.installMissing === true,
    });
  } catch (error) {
    // Nothing user-visible references the worktree yet (the tab write is the
    // last step), so roll it back instead of leaking an orphaned empty
    // worktree on every failed/retried import.
    const rollback =
      inspected.workspace.type === 'cowork'
        ? (async (): Promise<void> => {
            const { withBrowserTaskOwnerRemoval } =
              await import('../browser/browser-profile-lifecycle');
            await withBrowserTaskOwnerRemoval(
              inspected.workspace.id,
              worktree.id,
              async () => {
                try {
                  await cleanupPersistedWorktreeData(
                    inspected.workspace.id,
                    worktree.id,
                  );
                } finally {
                  await removeWorkEntryRow(inspected.workspace.id, worktree.id);
                }
              },
            );
          })()
        : inspected.workspace.type === 'single-repo'
          ? archiveSingleRepoWorktree({
              archiveTrigger: 'import',
              workspaceId: inspected.workspace.id,
              worktreeId: worktree.id,
              retainAsArchivedContainer: false,
            })
          : archiveMultiRepoWorktree({
              archiveTrigger: 'import',
              workspaceId: inspected.workspace.id,
              worktreeId: worktree.id,
              retainAsArchivedContainer: false,
            });
    await rollback.catch(() => {});
    throw error;
  }
  result.stagingRetained = result.warnings.some((warning) =>
    /\.patch\b/i.test(warning),
  );
  if (!result.stagingRetained) {
    try {
      await discardStagedSessionImport(request.exportId);
    } catch {
      result.stagingRetained = true;
      result.warnings.push(
        'The session was imported, but its temporary staging data could not be removed. Close this dialog to retry cleanup.',
      );
    }
  }
  return result;
}

async function finalizeImportedSession(args: {
  inspected: InspectedBundle;
  worktreeId: string;
  warnings: string[];
  getWindow: () => BrowserWindow | null;
  installMissing: boolean;
}): Promise<ChatSessionImportResponse> {
  const { inspected, worktreeId, warnings, getWindow, installMissing } = args;
  const worktree = { id: worktreeId };
  const destinationRepos =
    inspected.workspace.type === 'cowork'
      ? []
      : describeWorkspaceRepos(inspected.workspace, worktree.id);
  const destinationByIdentity = new Map(
    inspected.destinationRepos.map((repo) => [
      requireResolvedIdentity(repo),
      destinationRepos.find((candidate) => candidate.repoId === repo.repoId),
    ]),
  );

  for (const repo of inspected.manifest.repos) {
    if (!repo.diffFile) {
      continue;
    }
    const destination = destinationByIdentity.get(repo.identityKey);
    if (!destination) {
      warnings.push(
        `Changes for ${repo.name} were not applied; patch remains at ${resolve(inspected.rootPath, repo.diffFile)}.`,
      );
      continue;
    }
    const patchPath = resolve(inspected.rootPath, repo.diffFile);
    try {
      const { appliedWithConflicts } = await applyPatch3Way(
        requireCheckoutPath(destination),
        await readFile(patchPath, 'utf8'),
      );
      if (appliedWithConflicts) {
        warnings.push(
          `Changes for ${repo.name} were applied with conflict markers; resolve the conflicts in the new worktree before continuing.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(
        `Changes for ${repo.name} could not be applied; patch remains at ${patchPath}. ${message}`,
      );
    }
  }

  const existingTabs = await readChatTabsFile(
    inspected.workspace.id,
    worktree.id,
  );
  const chatId = nextImportedChatId(
    new Set(existingTabs.tabs.map((tab) => tab.id)),
  );
  const selectedRepoId = remapSelectedRepoId({
    sourceRepoId: inspected.manifest.tab.selectedRepoId,
    manifest: inspected.manifest,
    destinationRepos: inspected.destinationRepos,
  });
  const baseTab: PersistedChatTab = {
    ...inspected.manifest.tab,
    id: chatId,
    ...optionalProperty(selectedRepoId, (repoId) => ({
      selectedRepoId: repoId,
    })),
  };
  baseTab.inputDelivery = detachInputDelivery(
    baseTab,
    { projectId: inspected.workspace.id, worktreeId: worktree.id, chatId },
    () => randomUUID(),
  );
  if (isInputLedger(baseTab.inputDelivery)) {
    const copiedPaths = new Map<string, string>();
    const missingPaths = new Map<string, string>();
    const unresolvedReferencePaths = new Map<string, string>();
    const attachmentsDir = resolveAgentAttachmentsDir(
      inspected.workspace.id,
      worktree.id,
    );
    const destinationPath = (sourcePath: string): string => {
      const copied = copiedPaths.get(sourcePath);
      if (copied) return copied;
      const existing = missingPaths.get(sourcePath);
      if (existing) return existing;
      const extension = /^\.[a-zA-Z0-9]{1,12}$/.test(extname(sourcePath))
        ? extname(sourcePath)
        : '';
      const destination = join(attachmentsDir, `${randomUUID()}${extension}`);
      missingPaths.set(sourcePath, destination);
      return destination;
    };
    const inertReferencePath = (sourcePath: string): string => {
      const existing = unresolvedReferencePaths.get(sourcePath);
      if (existing) return existing;
      const extension = /^\.[a-zA-Z0-9]{1,12}$/.test(extname(sourcePath))
        ? extname(sourcePath)
        : '';
      const destination = join(attachmentsDir, `${randomUUID()}${extension}`);
      unresolvedReferencePaths.set(sourcePath, destination);
      return destination;
    };
    const repositoryReferencePath = (reference: {
      absolutePath: string;
      displayPath: string;
      repoName?: string;
      kind?: string;
    }): string | undefined => {
      const sourceRepo = reference.repoName
        ? inspected.manifest.repos.find(
            (candidate) => candidate.name === reference.repoName,
          )
        : reference.kind === undefined && inspected.manifest.repos.length === 1
          ? inspected.manifest.repos[0]
          : undefined;
      if (!sourceRepo) return undefined;
      const checkoutPath = destinationByIdentity.get(
        sourceRepo.identityKey,
      )?.checkoutPath;
      if (!checkoutPath) return undefined;
      const displaySegments = reference.displayPath.split(/[\\/]+/);
      const repositoryRelativeSegments =
        displaySegments.length > 1 && displaySegments[0] === sourceRepo.name
          ? displaySegments.slice(1)
          : displaySegments;
      const candidate = resolve(checkoutPath, ...repositoryRelativeSegments);
      return isPathWithin(checkoutPath, candidate) ? candidate : undefined;
    };
    for (const attachment of inspected.manifest.inputAttachments ?? []) {
      if (
        !baseTab.inputDelivery.rows.some((row) =>
          row.payload.attachmentPaths?.includes(attachment.sourcePath),
        )
      )
        continue;
      await ensureWorkspaceWriteDirectory(attachmentsDir);
      const destination = join(
        attachmentsDir,
        `${randomUUID()}${extname(attachment.file)}`,
      );
      await withWorkspaceDirectoryWrite(attachmentsDir, () =>
        copyFile(
          join(inspected.rootPath, attachment.file),
          destination,
          fsConstants.COPYFILE_EXCL,
        ),
      );
      copiedPaths.set(attachment.sourcePath, destination);
    }
    baseTab.inputDelivery = {
      ...baseTab.inputDelivery,
      rows: baseTab.inputDelivery.rows.map((row) => ({
        ...row,
        payload: {
          ...row.payload,
          ...(row.payload.attachmentPaths
            ? {
                attachmentPaths: row.payload.attachmentPaths.map((path) =>
                  destinationPath(path),
                ),
              }
            : {}),
          ...(row.payload.attachmentPromptContexts
            ? {
                attachmentPromptContexts:
                  row.payload.attachmentPromptContexts.map((context) => ({
                    ...context,
                    attachmentPath: destinationPath(context.attachmentPath),
                  })),
              }
            : {}),
          ...(row.payload.fileReferences
            ? {
                fileReferences: row.payload.fileReferences.map((reference) => ({
                  ...reference,
                  absolutePath: row.payload.attachmentPaths?.includes(
                    reference.absolutePath,
                  )
                    ? destinationPath(reference.absolutePath)
                    : (repositoryReferencePath(reference) ??
                      inertReferencePath(reference.absolutePath)),
                })),
              }
            : {}),
        },
      })),
    };
    if (missingPaths.size > 0) {
      warnings.push(
        'Some unsent message attachments were not included. Restore the missing files before resending.',
      );
    }
    if (unresolvedReferencePaths.size > 0) {
      warnings.push(
        'Some unsent repository file references could not be matched to the destination checkout. Reattach those files before resending.',
      );
    }
  }
  delete baseTab.pendingSystemInstructions;
  delete baseTab.readOnly;
  if (baseTab.portablePluginSelections) {
    const resolved = await resolvePortableSessionSelections(
      baseTab.portablePluginSelections,
      installMissing,
    );
    baseTab.pluginSelections = resolved.selections;
    const missing = resolved.readiness.filter(
      (requirement) => requirement.status === 'missing',
    );
    if (missing.length > 0) {
      warnings.push(
        `Some imported capabilities still need setup: ${missing
          .map((requirement) => requirement.name)
          .join(', ')}.`,
      );
    }
  } else {
    if (
      baseTab.pluginSelections &&
      hasAnySelections(baseTab.pluginSelections)
    ) {
      warnings.push(
        'Plugin selections from the imported bundle were removed for safety.',
      );
    }
    delete baseTab.pluginSelections;
  }
  delete baseTab.portablePluginSelections;
  if (!selectedRepoId) {
    delete baseTab.selectedRepoId;
  }
  const cwd = resolveWorktreeCwd(
    inspected.workspace.id,
    worktree.id,
    selectedRepoId,
  );
  const tab = await installProviderArtifacts({
    bundle: inspected,
    tab: baseTab,
    projectId: inspected.workspace.id,
    worktreeId: worktree.id,
    chatId,
    cwd,
    warnings,
  });

  await upsertPersistedChatTab({
    projectId: inspected.workspace.id,
    worktreeId: worktree.id,
    tab,
    activateTab: true,
  });
  // Keep the cycle-breaking state-service dependency local to final commit.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  await getChatStateService().flushScope(inspected.workspace.id, worktree.id);

  // Same fire-and-forget setup every UI-created worktree gets (setup script,
  // SDK discovery, code-graph build). Started last so a rollback of a failed
  // import never races a running setup script, and after the patch loop so
  // setup sees the applied changes.
  const workspace = inspected.workspace;
  if (workspace.type === 'single-repo') {
    detachedWorkCallback(() =>
      startProjectWorktreePostCreateSetup({
        projectId: workspace.id,
        worktreeId: worktree.id,
        project: {
          repoPath: workspace.repoPath,
          ...(workspace.scripts ? { scripts: workspace.scripts } : {}),
        },
        getWindow,
      }),
    )();
  } else if (workspace.type === 'multi-repo') {
    detachedWorkCallback(() =>
      startWorkspaceWorktreePostCreateSetup({
        workspaceId: workspace.id,
        worktreeId: worktree.id,
        repos: workspace.repos,
        getWindow,
      }),
    )();
  }

  const event: ChatSessionImportedEvent = {
    projectId: inspected.workspace.id,
    worktreeId: worktree.id,
    chatId,
    tab,
    activateTab: true,
  };
  sendToWindow(getWindow(), IPC_CHANNELS.chatSessionImported, event);
  return {
    projectId: inspected.workspace.id,
    worktreeId: worktree.id,
    chatId,
    warnings,
    stagingRetained: false,
  };
}

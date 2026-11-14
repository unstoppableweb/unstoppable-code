import { chatClaudeConfigDir } from './chat-claude-config-dir';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { z } from 'zod';
import type { W5CommitOptions } from './w5-commit-scope';
import type { W5KeyedAttempt } from './w5-keyed-operation';
import {
  runW5BoundaryOperation,
  w5ExpectedRevision,
  type W5BoundaryOptions,
  type W5WireCall,
} from './w5-boundary-operation';
import { W5RevisionConflictError } from './w5-commit-log-file-store';
import {
  admitW5Composition,
  checkW5CompositionRevisions,
  decodeW5CompositionOutcome,
} from './w5-composition-operation';

interface RestoreExecution {
  commit: W5CommitOptions;
  attempt?: W5KeyedAttempt;
}
import {
  finishArchivedContainerRecovery,
  restoreArchivedRecoveryFiles,
  restoreArchivedRecoveryWorkspaceRootFiles,
} from './archived-container-recovery';
import {
  access,
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { installRestoredExecutionState } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import { syncTreeDurably } from '@canopy/execution-engine/node/lib/atomic-file';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  resolvePersistedChatExecutionHarness,
  type ArchivedContainerManifest,
  type ArchivedContainerRestoreResponse,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { withWorktreeRelocationInstruction } from '@canopy/desktop-shared/lib/pending-system-instructions';
import {
  claudeProjectDirCandidates,
  findClaudeCodeSessionTranscriptCandidates,
  getClaudeCodeProjectsDir,
  resolveClaudeCodeSessionTranscriptPath,
} from './claude-project-paths';
import {
  getArchivedContainerAttachmentsDir,
  getArchivedContainerExecutionsDir,
  getArchivedContainerProviderSessionsDir,
  getArchivedContainerRecoveryEvidenceDir,
  getArchivedContainerSummaryPath,
  getWorktreeAttachmentsDir,
  getWorktreeSummaryFilePath,
  getWorkspaceWorktreeDir,
} from './paths';
import {
  broadcastArchivedContainersChanged,
  purgeArchivedContainerAfterRestore,
  readArchivedContainerChatArchives,
  readArchivedContainerChats,
  getArchivedContainerChatStorage,
  readArchivedContainerManifest,
  readArchivedContainerTrackedPlans,
  removeArchivedContainerPayloadsAfterPartialRestore,
  restoreArchivedContainerWorkspaceRootFiles,
  commitArchivedContainer,
  withArchivedContainerOperationLock,
} from './archived-containers';
import { installRestoredTrackedPlans } from './plan-persistence';
import { isTabWithinRestoreWindow } from './chat-archives';
import { getChatStateService } from '../services/chat-state-service';
import {
  notifyLedgerContainerRestored,
  recordLedgerRestoreIntent,
} from '../ledger/lifecycle';
import {
  archivedLedgerIncarnation,
  restoredLedgerIncarnation,
} from '../ledger/lifecycle-containers';
import {
  createMultiRepoWorktree,
  createSingleRepoWorktree,
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  retryDeferredTemporaryWorkspaceDeletion,
} from './worktree-service';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
} from './workspace-persistence';
import {
  recordRestoredWorktree,
  removeRestoredWorktreeRecord,
} from './archived-container-restore-records';
import { readEffectiveWorkspaceConfig } from './workspace-source';
import { resolveProjectReferenceRepoPath } from './project-reference-repo';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';
import {
  appendBranchSuffix,
  doesLocalBranchExist,
  doesRemoteBranchExist,
  fetchOrigin,
  isAncestor,
  isBranchNameAvailable,
  listCheckedOutBranches,
} from './git';
import { resolveWorktreeCwd } from './resolve-worktree';
import { relocateExecutionCheckout } from '../pipelines/execution-checkout-location';
import {
  findCodexRolloutFiles,
  resolveCodexHomeForTab,
} from './codex-session-artifacts';
import { forkCodexThreadByIdViaOneShot } from '../codex/fork-thread';
import { isPathInside } from './path-safety';
import { isErrnoException, isRecord } from './type-guards';
import {
  createWorkEntry,
  listWorkEntries,
  removeWorkEntryRow,
} from './cowork-work-entries';
import { cleanupPersistedWorktreeData } from './worktree-data-cleanup';
import { restoreEntryCostArchive } from '../cost-index/lifecycle';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import { relocateExecutionStateArtifactPaths } from '../pipelines/execution-state-relocation';
import { getChatSearchService } from '../chat-search/service';
import { startProjectWorktreePostCreateSetup } from './project-worktree-runtime';
import { startWorkspaceWorktreePostCreateSetup } from './workspace-worktree-runtime';
import { validateId } from './validation';
import {
  assertArchivedGitStateRestorable,
  resolveArchivedContainerRestoreBaseBranches,
  restoreArchivedContainerGitState,
} from './archived-container-git';
import {
  detachedWorkCallback,
  settleAll,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

function makeReadOnly(tab: PersistedChatTab): PersistedChatTab {
  // Strip every session-resumption field the renderer's `toPersistedTab`
  // whitelist can persist; the rest of the tab is preserved verbatim.
  const readOnlyTab: PersistedChatTab = { ...tab, readOnly: true };
  delete readOnlyTab.sdkSessionId;
  delete readOnlyTab.claudeForkSessionOnNextSend;
  delete readOnlyTab.providerSessions;
  delete readOnlyTab.providerSwitchSeedPending;
  delete readOnlyTab.staleSessionDetected;
  return readOnlyTab;
}

function tabIsFresh(tab: PersistedChatTab, now: number): boolean {
  return isTabWithinRestoreWindow(tab, now);
}

function withRestoredWorkingDirectory(args: {
  manifest: ArchivedContainerManifest;
  destinationId: string;
  tab: PersistedChatTab;
}): PersistedChatTab {
  if (args.tab.kind === 'file') return args.tab;

  return {
    ...args.tab,
    pendingSystemInstructions: withWorktreeRelocationInstruction(
      args.tab.pendingSystemInstructions
        ? structuredClone(args.tab.pendingSystemInstructions)
        : undefined,
      resolveWorktreeCwd(
        args.manifest.projectId,
        args.manifest.id,
        args.tab.selectedRepoId,
      ),
      resolveWorktreeCwd(
        args.manifest.projectId,
        args.destinationId,
        args.tab.selectedRepoId,
      ),
    ),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A managed Claude Code terminal chat resumes only when the launcher's own
 * transcript check finds the session; otherwise it starts a new one. Restore
 * treats such a chat as resumable only if that check passes, so a transcript
 * the launcher cannot see restores read-only instead (other chats: true).
 */
async function launcherCanResume(
  tab: PersistedChatTab,
  sessionId: string,
  cwd: string,
): Promise<boolean> {
  if (tab.interfaceMode !== 'claude-code' && tab.interfaceMode !== 'auto')
    return true;
  return Boolean(await resolveClaudeCodeSessionTranscriptPath(sessionId, cwd));
}

async function installCapturedClaudeTranscript(args: {
  projectId: string;
  containerId: string;
  destinationId: string;
  tab: PersistedChatTab;
  /** The Claude config folder the destination's provider reads; resolved
   * from the chat's runtime environment when omitted. */
  claudeConfigDir?: string;
}): Promise<boolean> {
  const sessionId = args.tab.sdkSessionId;
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return false;
  let source = join(
    getArchivedContainerProviderSessionsDir(args.projectId, args.containerId),
    'claude',
    `${sessionId}.jsonl`,
  );
  if (!(await pathExists(source))) {
    // Fallback for archives whose capture missed the transcript: Claude keeps
    // transcripts in the global per-cwd project store, keyed by the ORIGINAL
    // worktree path — that entry outlives the deleted checkout.
    const originalCwd = resolveWorktreeCwd(
      args.projectId,
      args.containerId,
      args.tab.selectedRepoId,
    );
    const fallback =
      (
        await findClaudeCodeSessionTranscriptCandidates(
          sessionId,
          originalCwd,
          await chatClaudeConfigDir({
            projectId: args.projectId,
            worktreeId: args.containerId,
            cwd: originalCwd,
            tab: args.tab,
          }),
        )
      ).paths[0] ??
      (await resolveClaudeCodeSessionTranscriptPath(sessionId, originalCwd));
    if (!fallback) return false;
    source = fallback;
  }
  const cwd = resolveWorktreeCwd(
    args.projectId,
    args.destinationId,
    args.tab.selectedRepoId,
  );
  const [projectDir] = await claudeProjectDirCandidates(cwd);
  if (!projectDir) return false;
  const claudeConfigDir =
    args.claudeConfigDir ??
    (await chatClaudeConfigDir({
      projectId: args.projectId,
      worktreeId: args.destinationId,
      cwd,
      tab: args.tab,
    }));
  const destination = join(
    getClaudeCodeProjectsDir(claudeConfigDir),
    projectDir,
    `${sessionId}.jsonl`,
  );
  await mkdir(dirname(destination), { recursive: true });
  if (!(await pathExists(destination))) {
    await copyFile(source, destination);
  }
  return launcherCanResume(args.tab, sessionId, cwd);
}

/** Whether a Work Entry Claude tab can resume its session in place: the
 * transcript is already in the destination's project directory, or a captured
 * or original-cwd copy installs there. */
async function ensureWorkEntryClaudeTranscript(args: {
  projectId: string;
  containerId: string;
  destinationId: string;
  tab: PersistedChatTab;
}): Promise<boolean> {
  const sessionId = args.tab.sdkSessionId;
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return false;
  const cwd = resolveWorktreeCwd(
    args.projectId,
    args.destinationId,
    args.tab.selectedRepoId,
  );
  // The provider reads the folder its runtime environment selects
  // (CLAUDE_CONFIG_DIR), not necessarily this process's.
  const claudeConfigDir = await chatClaudeConfigDir({
    projectId: args.projectId,
    worktreeId: args.destinationId,
    cwd,
    tab: args.tab,
  });
  // Only the destination's own project directory proves resume works; a copy
  // under an older cwd slug must still be installed there.
  for (const projectDir of await claudeProjectDirCandidates(cwd)) {
    if (
      await pathExists(
        join(
          getClaudeCodeProjectsDir(claudeConfigDir),
          projectDir,
          `${sessionId}.jsonl`,
        ),
      )
    )
      return launcherCanResume(args.tab, sessionId, cwd);
  }
  return installCapturedClaudeTranscript({ ...args, claudeConfigDir });
}

async function installCapturedCodexRollouts(args: {
  projectId: string;
  containerId: string;
  destinationId: string;
  tab: PersistedChatTab;
  warnings: string[];
}): Promise<{ codexHome: string; hasRollouts: boolean }> {
  const codexHome = await resolveCodexHomeForTab({
    tab: args.tab,
    projectId: args.projectId,
    worktreeId: args.destinationId,
    chatId: args.tab.id,
    warnings: args.warnings,
  });
  const capturedSessions = join(
    getArchivedContainerProviderSessionsDir(args.projectId, args.containerId),
    'codex',
    args.tab.id,
    'sessions',
  );
  const capturedFiles = args.tab.sdkSessionId
    ? await findCodexRolloutFiles(capturedSessions, args.tab.sdkSessionId)
    : [];
  for (const source of capturedFiles) {
    if (!isPathInside(capturedSessions, source)) continue;
    const destination = join(
      codexHome,
      'sessions',
      relative(capturedSessions, source),
    );
    await mkdir(dirname(destination), { recursive: true });
    if (!(await pathExists(destination))) await copyFile(source, destination);
  }
  const localFiles = args.tab.sdkSessionId
    ? await findCodexRolloutFiles(
        join(codexHome, 'sessions'),
        args.tab.sdkSessionId,
      )
    : [];
  return {
    codexHome,
    hasRollouts: capturedFiles.length > 0 || localFiles.length > 0,
  };
}

async function restoreTabs(args: {
  manifest: ArchivedContainerManifest;
  destinationId: string;
  workEntry: boolean;
  warnings: string[];
  portableWarnings?: boolean;
}): Promise<Awaited<ReturnType<typeof readArchivedContainerChats>>> {
  const chats = await readArchivedContainerChats(
    args.manifest.projectId,
    args.manifest.id,
  );
  const restoredTabs: PersistedChatTab[] = [];
  for (const tab of chats.tabs) {
    // Restoring a container makes its live chats usable again. Age alone
    // does not prove a provider session is unavailable; try its saved data
    // below and retain the recovery path when that data cannot be installed.
    if (!tab.sdkSessionId) {
      restoredTabs.push(
        withRestoredWorkingDirectory({
          manifest: args.manifest,
          destinationId: args.destinationId,
          tab: { ...tab, readOnly: false },
        }),
      );
      continue;
    }
    if (resolvePersistedChatExecutionHarness(tab) === 'codex') {
      try {
        const installed = await installCapturedCodexRollouts({
          projectId: args.manifest.projectId,
          containerId: args.manifest.id,
          destinationId: args.destinationId,
          tab,
          warnings: args.warnings,
        });
        if (!installed.hasRollouts) {
          args.warnings.push(
            `Codex provider data for chat ${tab.id} was not found; restored read-only.`,
          );
          restoredTabs.push(makeReadOnly(tab));
          continue;
        }
        try {
          const forked = await forkCodexThreadByIdViaOneShot({
            cwd: resolveWorktreeCwd(
              args.manifest.projectId,
              args.destinationId,
              tab.selectedRepoId,
            ),
            projectId: args.manifest.projectId,
            worktreeId: args.destinationId,
            chatId: tab.id,
            sourceThreadId: tab.sdkSessionId,
            ...(tab.pluginSelections
              ? { pluginSelections: tab.pluginSelections }
              : {}),
            ...(tab.modelConfig ? { modelConfig: tab.modelConfig } : {}),
          });
          restoredTabs.push(
            withRestoredWorkingDirectory({
              manifest: args.manifest,
              destinationId: args.destinationId,
              tab: { ...tab, sdkSessionId: forked, readOnly: false },
            }),
          );
        } catch (error) {
          args.warnings.push(
            `Codex thread fork failed for chat ${tab.id}; the preserved source thread will be used.${args.portableWarnings ? '' : ` ${error instanceof Error ? error.message : String(error)}`}`,
          );
          restoredTabs.push(
            withRestoredWorkingDirectory({
              manifest: args.manifest,
              destinationId: args.destinationId,
              tab: { ...tab, readOnly: false },
            }),
          );
        }
      } catch (error) {
        args.warnings.push(
          `Codex provider restore failed for chat ${tab.id}; restored read-only.${args.portableWarnings ? '' : ` ${error instanceof Error ? error.message : String(error)}`}`,
        );
        restoredTabs.push(makeReadOnly(tab));
      }
      continue;
    }

    // Other harnesses keep their native session in place; only Claude has a
    // transcript to verify.
    if (
      args.workEntry &&
      resolvePersistedChatExecutionHarness(tab) !== 'claude'
    ) {
      restoredTabs.push(
        withRestoredWorkingDirectory({
          manifest: args.manifest,
          destinationId: args.destinationId,
          tab: { ...tab, readOnly: false },
        }),
      );
      continue;
    }
    try {
      if (args.workEntry) {
        // A Work Entry keeps its Claude session in place; it stays editable
        // only while that session's transcript still exists.
        if (
          await ensureWorkEntryClaudeTranscript({
            projectId: args.manifest.projectId,
            containerId: args.manifest.id,
            destinationId: args.destinationId,
            tab,
          })
        ) {
          restoredTabs.push(
            withRestoredWorkingDirectory({
              manifest: args.manifest,
              destinationId: args.destinationId,
              tab: { ...tab, readOnly: false },
            }),
          );
        } else {
          args.warnings.push(
            `Claude provider data for chat ${tab.id} was not found; restored read-only.`,
          );
          restoredTabs.push(makeReadOnly(tab));
        }
        continue;
      }
      if (
        await installCapturedClaudeTranscript({
          projectId: args.manifest.projectId,
          containerId: args.manifest.id,
          destinationId: args.destinationId,
          tab,
        })
      ) {
        restoredTabs.push(
          withRestoredWorkingDirectory({
            manifest: args.manifest,
            destinationId: args.destinationId,
            tab: {
              ...tab,
              readOnly: false,
              claudeForkSessionOnNextSend: true,
            },
          }),
        );
      } else {
        args.warnings.push(
          `Claude provider data for chat ${tab.id} was not found; restored read-only.`,
        );
        restoredTabs.push(makeReadOnly(tab));
      }
    } catch (error) {
      args.warnings.push(
        `Claude provider restore failed for chat ${tab.id}; restored read-only.${args.portableWarnings ? '' : ` ${error instanceof Error ? error.message : String(error)}`}`,
      );
      restoredTabs.push(makeReadOnly(tab));
    }
  }
  return { ...chats, tabs: restoredTabs };
}

/**
 * Best-effort provider-data install for the container's PER-CHAT archived
 * chats. Their entries move to the destination verbatim (session ids intact),
 * so a later per-chat restore can only resume when the Claude transcript /
 * Codex rollouts exist under the DESTINATION's paths — install them now,
 * mirroring the live-tab installs. Failures degrade to warnings; a truly
 * missing session surfaces through the normal stale-session UX on resume.
 */
async function installArchivedChatProviderData(args: {
  manifest: ArchivedContainerManifest;
  destinationId: string;
  warnings: string[];
  archives: Awaited<ReturnType<typeof readArchivedContainerChatArchives>>;
  now?: number;
}): Promise<void> {
  const now = args.now ?? Date.now();
  for (const entry of args.archives.archived) {
    const tab = entry.tab;
    if (!isTabWithinRestoreWindow(tab, now) || !tab.sdkSessionId) {
      continue;
    }
    try {
      if (resolvePersistedChatExecutionHarness(tab) === 'codex') {
        await installCapturedCodexRollouts({
          projectId: args.manifest.projectId,
          containerId: args.manifest.id,
          destinationId: args.destinationId,
          tab,
          warnings: args.warnings,
        });
      } else {
        await installCapturedClaudeTranscript({
          projectId: args.manifest.projectId,
          containerId: args.manifest.id,
          destinationId: args.destinationId,
          tab,
        });
      }
    } catch {
      args.warnings.push(
        `Provider data for archived chat ${tab.id} could not be restored; it may resume read-only.`,
      );
    }
  }
}

async function installChatPayloads(args: {
  manifest: ArchivedContainerManifest;
  destinationId: string;
  destinationCreatedAt: string;
  workEntry: boolean;
  warnings: string[];
  portableWarnings?: boolean;
}): Promise<void> {
  const now = Date.now();
  const [chats, archives] = await settleAll([
    restoreTabs(args),
    readArchivedContainerChatArchives(
      args.manifest.projectId,
      args.manifest.id,
    ),
  ]);
  const relocatedArchives = {
    ...archives,
    archived: archives.archived.map((entry) =>
      tabIsFresh(entry.tab, now)
        ? {
            ...entry,
            tab: withRestoredWorkingDirectory({
              manifest: args.manifest,
              destinationId: args.destinationId,
              tab: entry.tab,
            }),
          }
        : entry,
    ),
  };
  await installArchivedChatProviderData({
    manifest: args.manifest,
    destinationId: args.destinationId,
    warnings: args.warnings,
    archives: relocatedArchives,
    now,
  });
  await getChatStateService().importStorageScope(
    {
      projectId: args.manifest.projectId,
      worktreeId: args.destinationId,
    },
    await getArchivedContainerChatStorage(
      args.manifest.projectId,
      args.manifest.id,
    ),
    chats,
    relocatedArchives,
  );
  const summarySource = getArchivedContainerSummaryPath(
    args.manifest.projectId,
    args.manifest.id,
  );
  const summaryDestination = getWorktreeSummaryFilePath(
    args.manifest.projectId,
    args.destinationId,
  );
  await mkdir(dirname(summaryDestination), { recursive: true });
  await copyFile(summarySource, summaryDestination).catch((error: unknown) => {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  });
  await restoreEntryCostArchive(
    args.manifest.projectId,
    args.manifest.id,
    args.destinationId,
    args.destinationCreatedAt,
  );
  // Attachments and tracked plans restore alongside the chats: an I/O failure
  // aborts (the caller rolls the destination back while the archive is still
  // intact), while a missing capture is simply an empty payload.
  await cp(
    getArchivedContainerAttachmentsDir(
      args.manifest.projectId,
      args.manifest.id,
    ),
    getWorktreeAttachmentsDir(args.manifest.projectId, args.destinationId),
    { recursive: true, force: true },
  ).catch((error: unknown) => {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  });
  const trackedPlans = await readArchivedContainerTrackedPlans(
    args.manifest.projectId,
    args.manifest.id,
  );
  await installRestoredTrackedPlans(
    args.manifest.projectId,
    args.destinationId,
    trackedPlans.plans,
  );
}

interface RestoreBranchResolution {
  branchName?: string;
  existingBranch?: string;
  existingBranchRepoPaths?: string[];
  reuseExistingBranch: boolean;
}

async function resolveAvailableRestoreBranch(
  repoPaths: readonly string[],
  preferredBranch: string,
  reservedBranches: ReadonlySet<string>,
  attempt?: W5KeyedAttempt,
): Promise<string | undefined> {
  if (repoPaths.length) attempt?.beforeEffects();
  await settleAll(repoPaths.map((repoPath) => fetchOrigin(repoPath)));
  const candidates = [
    preferredBranch,
    ...Array.from({ length: 99 }, (_, index) =>
      appendBranchSuffix(preferredBranch, index + 2),
    ),
  ];
  for (const candidate of candidates) {
    if (reservedBranches.has(candidate)) continue;
    const available = await settleAll(
      repoPaths.map(async (repoPath) => {
        const [localAvailable, remoteExists] = await settleAll([
          isBranchNameAvailable(repoPath, candidate),
          doesRemoteBranchExist(repoPath, candidate),
        ]);
        return localAvailable && !remoteExists;
      }),
    );
    if (available.every(Boolean)) return candidate;
  }
  return undefined;
}

async function doesBranchExistLocallyOrRemotely(
  repoPath: string,
  branchName: string,
  attempt?: W5KeyedAttempt,
): Promise<boolean> {
  attempt?.beforeEffects();
  await fetchOrigin(repoPath);
  const [localExists, remoteExists] = await settleAll([
    doesLocalBranchExist(repoPath, branchName),
    doesRemoteBranchExist(repoPath, branchName),
  ]);
  return localExists || remoteExists;
}

async function resolveRestoreBranch(
  manifest: ArchivedContainerManifest,
  warnings: string[],
  readOnly = false,
  attempt?: W5KeyedAttempt,
): Promise<RestoreBranchResolution> {
  const preferredBranch =
    manifest.branchName ??
    (manifest.version === 2 ? manifest.originalWorktree.branchName : undefined);
  if (!preferredBranch) return { reuseExistingBranch: false };
  const config = await readWorkspaceConfig(manifest.projectId);
  let repoPaths: string[];
  if (config.type === 'single-repo' && config.repoPath) {
    repoPaths = [await resolveProjectReferenceRepoPath(config.repoPath)];
  } else {
    // Multi-repo creation uses the effective repo set (including manifest
    // repos), so branch deduction must inspect that same set before passing an
    // explicit branch to the creator.
    const effective = await readEffectiveWorkspaceConfig(manifest.projectId);
    repoPaths = [
      ...(effective.sourceRepoPath
        ? [await resolveWorkspaceReferenceRepoPath(effective.sourceRepoPath)]
        : []),
      ...(manifest.restoreScope === 'workspace-root-only'
        ? []
        : effective.repos.map((repo) => repo.repoPath)),
    ];
  }
  const trackedWorktrees = await readWorkspaceWorktrees(
    manifest.projectId,
    readOnly ? { persistRemovalCleanup: false } : undefined,
  );
  const reservedBranches = new Set(
    trackedWorktrees.map((worktree) => worktree.branchName),
  );
  let reuseBlockedReason: string | undefined;
  const tracked = trackedWorktrees.find(
    (worktree) => worktree.branchName === preferredBranch,
  );
  if (tracked) {
    reuseBlockedReason = `it is already assigned to tracked worktree "${tracked.id}"`;
  }

  if (!reuseBlockedReason && manifest.version === 2) {
    const archivedRepositories = manifest.gitState.repositories;
    const localPresence = await settleAll(
      archivedRepositories.map((repository) =>
        doesLocalBranchExist(repository.referenceRepoPath, preferredBranch),
      ),
    );
    const anyLocal = localPresence.some(Boolean);
    if (anyLocal) {
      const archivedRepoPaths = new Set(
        archivedRepositories.map((repository) => repository.referenceRepoPath),
      );
      const archivedNamesMatch = archivedRepositories.every(
        (repository) => repository.branchName === preferredBranch,
      );
      if (!archivedNamesMatch) {
        reuseBlockedReason =
          'the archive used different branch names across its repositories';
      } else if (!localPresence.every(Boolean)) {
        reuseBlockedReason =
          'it is not present in every repository captured by the archive';
      } else {
        for (const repository of archivedRepositories) {
          const checkedOutAt = (
            await listCheckedOutBranches(repository.referenceRepoPath)
          ).get(preferredBranch);
          if (checkedOutAt) {
            reuseBlockedReason =
              'it is already checked out in another Git worktree';
            break;
          }
          if (
            !(await isAncestor(
              repository.referenceRepoPath,
              repository.headCommit,
              `refs/heads/${preferredBranch}`,
            ))
          ) {
            reuseBlockedReason = `its ${repository.repoName} history no longer contains archived commit ${repository.headCommit.slice(0, 8)}`;
            break;
          }
        }
        if (!reuseBlockedReason) {
          for (const repoPath of repoPaths) {
            const checkedOutAt = (await listCheckedOutBranches(repoPath)).get(
              preferredBranch,
            );
            if (checkedOutAt) {
              reuseBlockedReason =
                'it is already checked out in another Git worktree';
              break;
            }
            if (
              !archivedRepoPaths.has(repoPath) &&
              (await doesBranchExistLocallyOrRemotely(
                repoPath,
                preferredBranch,
                attempt,
              ))
            ) {
              reuseBlockedReason =
                'a repository added after archival already has a local or remote branch with that name';
              break;
            }
          }
        }
        if (!reuseBlockedReason) {
          return {
            existingBranch: preferredBranch,
            existingBranchRepoPaths: archivedRepositories.map(
              (repository) => repository.referenceRepoPath,
            ),
            reuseExistingBranch: true,
          };
        }
      }
    }
  } else if (!reuseBlockedReason) {
    const legacyBranchExists = (
      await settleAll(
        repoPaths.map((repoPath) =>
          doesLocalBranchExist(repoPath, preferredBranch),
        ),
      )
    ).some(Boolean);
    if (legacyBranchExists) {
      reuseBlockedReason =
        'this legacy archive does not contain the commit ancestry needed to validate that branch';
    }
  }

  const resolved = await resolveAvailableRestoreBranch(
    repoPaths,
    preferredBranch,
    reservedBranches,
    attempt,
  );
  if (!resolved) {
    warnings.push(
      `No available suffix remained for branch ${preferredBranch}; a generated branch was used.`,
    );
    return { reuseExistingBranch: false };
  }
  if (resolved !== preferredBranch) {
    warnings.push(
      reuseBlockedReason
        ? `Local branch "${preferredBranch}" could not be reused because ${reuseBlockedReason}; restored as "${resolved}" to preserve the existing branch.`
        : `Branch "${preferredBranch}" was already occupied; restored as "${resolved}".`,
    );
  }
  return { branchName: resolved, reuseExistingBranch: false };
}

async function createRestoredWorktree(
  manifest: ArchivedContainerManifest,
  warnings: string[],
  commit: W5CommitOptions,
  attempt?: W5KeyedAttempt,
): Promise<{
  id: string;
  branchName: string;
  createdAt: string;
  reuseExistingBranch: boolean;
}> {
  if (manifest.version === 3) {
    const restoreStaging =
      manifest.restoreStaging ??
      ({
        kind: 'worktree',
        id: `recovery-${randomUUID()}`,
        createdAt: new Date().toISOString(),
      } as const);
    if (!manifest.restoreStaging) {
      manifest.restoreStaging = restoreStaging;
      attempt?.beforeEffects();
      await commitArchivedContainer({ ...manifest, restoreStaging });
    }
    const { id, createdAt } = restoreStaging;
    validateId(id, 'restoreStaging.id');
    const destination = getWorkspaceWorktreeDir(manifest.projectId, id);
    // Recovery is deliberately independent of the missing source repository.
    const branchName = manifest.originalWorktree.branchName;
    warnings.push(
      'Restored the remaining files. Git history and staging are not restored automatically; saved Git metadata is kept separately.',
    );
    const existing = (
      await readWorkspaceWorktrees(
        manifest.projectId,
        commit.expectedRevisions || commit.beforeDecision
          ? { persistRemovalCleanup: false }
          : undefined,
      )
    ).find((worktree) => worktree.id === id);
    if (existing) {
      if (existing.createdAt !== createdAt) {
        throw new Error(
          `Staged recovery worktree ${id} no longer matches its destination identity; the archived container was preserved.`,
        );
      }
      return { id, branchName, createdAt, reuseExistingBranch: false };
    }
    try {
      attempt?.beforeEffects();
      await rm(destination, { recursive: true, force: true });
      await restoreArchivedRecoveryFiles(manifest, destination);
      // A concurrent restore of this archive that recorded the same staged
      // incarnation first is the same destination (`already-recorded`); the
      // record refuses any other row with this id.
      await recordRestoredWorktree(
        {
          source: 'archived_container_restore',
          workspaceId: manifest.projectId,
          archiveId: manifest.id,
          worktree: {
            id,
            branchName,
            createdAt,
            label: manifest.name,
            ...(manifest.originalWorktree.includedRepoIds === undefined
              ? {}
              : { includedRepoIds: manifest.originalWorktree.includedRepoIds }),
          },
        },
        commit,
      );
    } catch (error) {
      await settleAll([
        rm(destination, { recursive: true, force: true }),
        rm(
          getArchivedContainerRecoveryEvidenceDir(
            manifest.projectId,
            id,
            manifest.id,
          ),
          { recursive: true, force: true },
        ),
      ]);
      throw error;
    }
    return { id, branchName, createdAt, reuseExistingBranch: false };
  }
  const branch = await resolveRestoreBranch(
    manifest,
    warnings,
    !!commit.expectedRevisions || !!commit.beforeDecision,
    attempt,
  );
  const restoreBases =
    manifest.version === 2
      ? await resolveArchivedContainerRestoreBaseBranches(manifest)
      : { baseBranchesByRepo: {}, warnings: [] };
  warnings.push(...restoreBases.warnings);
  if (manifest.workspaceType === 'single-repo') {
    const baseBranch =
      manifest.version === 2
        ? restoreBases.baseBranchesByRepo[
            manifest.gitState.repositories[0]?.repoId ?? ''
          ]
        : undefined;
    return createSingleRepoWorktree({
      w5BoundaryCommit: commit,
      w5BoundaryAttempt: attempt,
      workspaceId: manifest.projectId,
      ...(branch.existingBranch
        ? { existingBranch: branch.existingBranch }
        : branch.branchName
          ? { branchName: branch.branchName }
          : {}),
      ...(baseBranch ? { baseBranch } : {}),
      allowBaseBranchNetwork: false,
      startPostCreateSetup: false,
      seedPanelLayoutMode: false,
      startProjectPostCreateSetup: startProjectWorktreePostCreateSetup,
      getWindow: () => null,
      deferGitSetup: false,
    }).then((created) => ({
      ...created,
      reuseExistingBranch: branch.reuseExistingBranch,
    }));
  }
  const created = await createMultiRepoWorktree({
    w5BoundaryCommit: commit,
    w5BoundaryAttempt: attempt,
    workspaceId: manifest.projectId,
    ...(manifest.restoreScope === 'workspace-root-only'
      ? { includedRepoIds: [] }
      : {}),
    ...(branch.existingBranch
      ? {
          existingBranch: branch.existingBranch,
          existingBranchRepoPaths: branch.existingBranchRepoPaths,
        }
      : branch.branchName
        ? { branchName: branch.branchName }
        : {}),
    ...(Object.keys(restoreBases.baseBranchesByRepo).length > 0
      ? { baseBranchesByRepo: restoreBases.baseBranchesByRepo }
      : {}),
    allowBaseBranchNetwork: false,
    startPostCreateSetup: false,
    seedPanelLayoutMode: false,
    startWorkspacePostCreateSetup: startWorkspaceWorktreePostCreateSetup,
    getWindow: () => null,
    deferGitSetup: false,
    surfaceNeedsRepairInResponse: true,
  });
  if (created.needsRepair === true) {
    await archiveMultiRepoWorktree({
      archiveTrigger: 'restore',
      workspaceId: manifest.projectId,
      worktreeId: created.id,
      expectedCreatedAt: created.createdAt,
      allowMissingRow: true,
      retainAsArchivedContainer: false,
      deleteBranch: false,
    });
    throw new Error(
      `Project root requires repair before this archive can be restored: ${created.repairIssues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return {
    ...created,
    reuseExistingBranch: branch.reuseExistingBranch,
  };
}

async function assertRestoredWorktreeDestination(
  manifest: ArchivedContainerManifest,
  readOnly = false,
): Promise<void> {
  const restoredTo = manifest.restoredTo;
  if (!restoredTo || restoredTo.kind !== 'worktree') return;
  const destination = (
    await readWorkspaceWorktrees(
      manifest.projectId,
      readOnly ? { persistRemovalCleanup: false } : undefined,
    )
  ).find((worktree) => worktree.id === restoredTo.id);
  if (
    !destination ||
    !restoredTo.createdAt ||
    destination.createdAt !== restoredTo.createdAt
  ) {
    throw new Error(
      `Restored worktree ${restoredTo.id} no longer matches the partial restore destination; the archived container was preserved.`,
    );
  }
}

async function assertRestoredWorkEntryDestination(
  manifest: ArchivedContainerManifest,
): Promise<void> {
  const restoredTo = manifest.restoredTo;
  if (!restoredTo || restoredTo.kind !== 'work-entry') return;
  const destination = (await listWorkEntries(manifest.projectId)).find(
    (entry) => entry.id === restoredTo.id,
  );
  if (
    !destination ||
    !restoredTo.createdAt ||
    destination.createdAt !== restoredTo.createdAt
  ) {
    throw new Error(
      `Restored work entry ${restoredTo.id} no longer matches the partial restore destination; the archived container was preserved.`,
    );
  }
}

async function startRestoredWorktreePostCreateSetup(
  manifest: ArchivedContainerManifest,
  destinationId: string,
  warnings: string[],
  portableWarnings = false,
): Promise<void> {
  try {
    if (manifest.workspaceType === 'single-repo') {
      const config = await readWorkspaceConfig(manifest.projectId);
      if (config.type !== 'single-repo' || !config.repoPath) {
        throw new Error('project is no longer single-repo');
      }
      const project = {
        repoPath: await resolveProjectReferenceRepoPath(config.repoPath),
        scripts: config.scripts,
      };
      detachedWorkCallback(() =>
        startProjectWorktreePostCreateSetup({
          projectId: manifest.projectId,
          worktreeId: destinationId,
          project,
          getWindow: () => null,
        }),
      )();
      return;
    }

    const effective = await readEffectiveWorkspaceConfig(manifest.projectId);
    detachedWorkCallback(() =>
      startWorkspaceWorktreePostCreateSetup({
        workspaceId: manifest.projectId,
        worktreeId: destinationId,
        workspaceRootPath: resolveWorktreeCwd(
          manifest.projectId,
          destinationId,
        ),
        repos:
          manifest.restoreScope === 'workspace-root-only'
            ? []
            : effective.repos,
        getWindow: () => null,
      }),
    )();
  } catch (error) {
    warnings.push(
      portableWarnings
        ? 'Post-create setup could not be started.'
        : `Post-create setup could not be started: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

async function rollbackRestoredWorktree(
  manifest: ArchivedContainerManifest,
  destinationId: string,
  destinationCreatedAt: string,
): Promise<void> {
  if (manifest.version === 3) {
    try {
      const { status } = await removeRestoredWorktreeRecord({
        source: 'archived_container_restore',
        workspaceId: manifest.projectId,
        worktreeId: destinationId,
        createdAt: destinationCreatedAt,
      });
      // Preserve destinations whose durable identity no longer matches the
      // staged recovery, and their files.
      if (status !== 'removed') return;
      await settleAll([
        cleanupPersistedWorktreeData(manifest.projectId, destinationId).catch(
          () => undefined,
        ),
        rm(getWorkspaceWorktreeDir(manifest.projectId, destinationId), {
          recursive: true,
          force: true,
        }).catch(() => undefined),
        rm(
          getArchivedContainerRecoveryEvidenceDir(
            manifest.projectId,
            destinationId,
            manifest.id,
          ),
          { recursive: true, force: true },
        ).catch(() => undefined),
      ]);
    } catch {
      // A list that cannot be read or written keeps the destination too. A
      // later retry or the user remains authoritative.
    }
    return;
  }
  const rollback =
    manifest.workspaceType === 'single-repo'
      ? archiveSingleRepoWorktree({
          archiveTrigger: 'restore',
          workspaceId: manifest.projectId,
          worktreeId: destinationId,
          retainAsArchivedContainer: false,
          deleteBranch: false,
        })
      : archiveMultiRepoWorktree({
          archiveTrigger: 'restore',
          workspaceId: manifest.projectId,
          worktreeId: destinationId,
          retainAsArchivedContainer: false,
          deleteBranch: false,
        });
  await rollback.catch(() => undefined);
}

function rewriteExecutionState(
  value: unknown,
  manifest: ArchivedContainerManifest,
  destinationId: string,
  cwd: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Invalid archived execution state');
  const sourceRoot = resolveWorktreeCwd(manifest.projectId, manifest.id);
  const next: Record<string, unknown> = {
    ...relocateExecutionCheckout(value, {
      sourceWorkspaceId: manifest.projectId,
      sourceWorktreeId: manifest.id,
      destinationWorkspaceId: manifest.projectId,
      destinationWorktreeId: destinationId,
      rewrites: [
        {
          fromRoot: sourceRoot,
          toRoot: cwd,
        },
      ],
    }),
    project_id: manifest.projectId,
    worktree_id: destinationId,
  };
  const target = value.target;
  if (
    (isRecord(target) &&
      target.scope === 'worktree' &&
      target.workspace_id === manifest.projectId &&
      target.worktree_id === manifest.id) ||
    (target === undefined &&
      value.project_id === manifest.projectId &&
      value.worktree_id === manifest.id)
  ) {
    const unmapped = (candidate: unknown): boolean => {
      if (typeof candidate !== 'string') return false;
      const suffix = relative(sourceRoot, candidate);
      return (
        suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)
      );
    };
    // Preserve archive-owned execution compatibility without inventing a
    // replacement for an unmatched retained instruction boundary.
    if (unmapped(value.cwd)) next.cwd = cwd;
    if (isRecord(target) && isRecord(next.target) && unmapped(target.path))
      next.target = { ...next.target, path: cwd };
  }
  return next;
}

async function listArchivedExecutionIds(
  manifest: ArchivedContainerManifest,
): Promise<string[]> {
  const directory = getArchivedContainerExecutionsDir(
    manifest.projectId,
    manifest.id,
  );
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      isErrnoException(error) &&
      error.code === 'ENOENT' &&
      manifest.executionCount === 0
    ) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => basename(entry.name, '.json'));
}

async function copyRestoredExecutionArtifacts(
  source: string,
  destination: string,
): Promise<void> {
  const stat = await lstat(source);
  if (stat.isDirectory()) {
    await cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (candidate) => candidate === source,
    });
    for (const entry of await readdir(source)) {
      await copyRestoredExecutionArtifacts(
        join(source, entry),
        join(destination, entry),
      );
    }
    return;
  }
  if (!stat.isFile()) {
    await cp(source, destination, { force: false, errorOnExist: false });
    return;
  }
  try {
    if ((await lstat(destination)).isDirectory()) {
      throw new Error('Artifact destination is a directory');
    }
    return;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }
  const staging = join(dirname(destination), `.restore-${randomUUID()}`);
  try {
    await copyFile(source, staging, fsConstants.COPYFILE_EXCL);
    try {
      await link(staging, destination);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') throw error;
      if ((await lstat(destination)).isDirectory()) throw error;
    }
  } finally {
    await rm(staging, { force: true });
  }
}

async function restoreExecutions(args: {
  manifest: ArchivedContainerManifest;
  destinationId: string;
  executionIds: string[];
}): Promise<string[]> {
  const failed: string[] = [];
  const archiveDir = getArchivedContainerExecutionsDir(
    args.manifest.projectId,
    args.manifest.id,
  );
  const liveDir = createElectronExecutionRuntime().executionsDir;
  const cwd = resolveWorktreeCwd(args.manifest.projectId, args.destinationId);
  for (const executionId of args.executionIds) {
    const sourceState = join(archiveDir, `${executionId}.json`);
    const sourceArtifacts = join(archiveDir, executionId);
    try {
      const parsed: unknown = JSON.parse(await readFile(sourceState, 'utf8'));
      const rewritten = rewriteExecutionState(
        parsed,
        args.manifest,
        args.destinationId,
        cwd,
      );
      const relocated = relocateExecutionStateArtifactPaths(
        rewritten,
        archiveDir,
        liveDir,
        executionId,
      );
      const installed = await installRestoredExecutionState(
        executionId,
        liveDir,
        relocated,
      );
      if (installed === 'already_present') {
        const live: unknown = JSON.parse(
          await readFile(join(liveDir, `${executionId}.json`), 'utf8'),
        );
        if (
          !isRecord(live) ||
          live.project_id !== args.manifest.projectId ||
          live.worktree_id !== args.destinationId ||
          (isRecord(relocated.target) &&
            relocated.target.scope === 'worktree' &&
            (!isRecord(live.target) ||
              live.target.scope !== 'worktree' ||
              live.target.workspace_id !== relocated.target.workspace_id ||
              live.target.worktree_id !== relocated.target.worktree_id))
        ) {
          throw new Error(
            'Live execution is not bound to the restore destination',
          );
        }
      }
      if (await pathExists(sourceArtifacts)) {
        await copyRestoredExecutionArtifacts(
          sourceArtifacts,
          join(liveDir, executionId),
        );
        // The archived copy is removed next; the live copy must survive power loss.
        await syncTreeDurably(join(liveDir, executionId));
      }
      await settleAll([
        rm(sourceState, { force: true }),
        rm(sourceArtifacts, { recursive: true, force: true }),
      ]);
    } catch {
      failed.push(executionId);
    }
  }
  return failed;
}

/**
 * Tells the Ledger that an archived container was restored, so its scope
 * rebinds to the restored container and becomes writable again. Call after
 * the restore destination is committed; repeating it is harmless. The
 * participant returns at once, so no archive lock is held while it waits on
 * Ledger storage.
 */
function notifyLedgerOfRestore(
  manifest: ArchivedContainerManifest,
  restored: { id: string; createdAt: string },
): void {
  try {
    notifyLedgerContainerRestored(
      // The manifest keeps the original container's verified creation time.
      archivedLedgerIncarnation(manifest),
      restoredLedgerIncarnation(manifest, restored),
    );
  } catch {
    // The participant never throws. A defect in it must not fail a committed
    // restore; startup reconciliation settles the scope.
  }
}

/**
 * Durably records, before the archive is purged, that its Ledger scope
 * belongs to the restored container: the archive is the only lasting record
 * of where the container went. Waits a bounded time, and only when the Ledger
 * database exists; never fails the restore. True when the archive may be
 * purged: the intent is durable, or no Ledger database exists.
 */
async function recordLedgerIntentOfRestore(
  manifest: ArchivedContainerManifest,
  restored: { id: string; createdAt: string },
): Promise<boolean> {
  try {
    const recording = await recordLedgerRestoreIntent(
      archivedLedgerIncarnation(manifest),
      restoredLedgerIncarnation(manifest, restored),
    );
    return recording !== 'not_durable';
  } catch {
    // Never fails a restore; the archive keeps its `restoredTo` instead.
    return false;
  }
}

/**
 * Restore gives the worktree a new id; move the legacy plan chats its archive
 * kept (their registry rows still name the archived id) onto the restored
 * worktree. Idempotent, so a retried restore can run it again.
 */
async function rebindLegacyPlanChats(
  manifest: ArchivedContainerManifest,
  destinationId: string,
): Promise<void> {
  // Deferred like the other legacy chat cleanup: keeps restore module
  // evaluation free of the registry until a worktree is actually restored.
  const { transferPlanExploreTargets } =
    await import('./plan-explore-registry');
  await transferPlanExploreTargets(
    { projectId: manifest.projectId, worktreeId: manifest.id },
    { projectId: manifest.projectId, worktreeId: destinationId },
  );
}

async function finishRestore(args: {
  manifest: ArchivedContainerManifest;
  destinationId: string;
  /** The restored container's creation time; unknown on old manifests. */
  restoredCreatedAt: string | undefined;
  response: ArchivedContainerRestoreResponse;
}): Promise<ArchivedContainerRestoreResponse> {
  if (args.manifest.version === 3 && args.manifest.recovery.gitCleanupPending) {
    await finishArchivedContainerRecovery(args.manifest);
    await commitArchivedContainer(args.manifest);
    if (args.manifest.recovery.gitCleanupPending) {
      args.response.warnings.push(
        'Files were restored. The archive retains its pending Git cleanup record until the source repository is available.',
      );
      broadcastArchivedContainersChanged(args.manifest.projectId);
      return args.response;
    }
  }
  trackDetachedWork(() =>
    getChatSearchService().worktreeContainerRestored(
      args.manifest.projectId,
      args.manifest.id,
      args.destinationId,
    ),
  );
  if (args.restoredCreatedAt !== undefined) {
    const restored = {
      id: args.destinationId,
      createdAt: args.restoredCreatedAt,
    };
    const archiveMayGo = await recordLedgerIntentOfRestore(
      args.manifest,
      restored,
    );
    // A resumed restore has not told the Ledger yet. After a fresh restore
    // this repeat finds the scope already rebound and clears the intent.
    notifyLedgerOfRestore(args.manifest, restored);
    if (!archiveMayGo) {
      // The Ledger database exists but holds no durable record of this
      // restore, so the archive's `restoredTo` stays the only lasting one:
      // keep it, as an interrupted restore does. The startup pass rebinds the
      // scope from it, and a later resume purges the archive once the intent
      // is recorded.
      broadcastArchivedContainersChanged(args.manifest.projectId);
      return args.response;
    }
  }
  await purgeArchivedContainerAfterRestore(
    args.manifest.projectId,
    args.manifest.id,
  );
  await retryDeferredTemporaryWorkspaceDeletion(args.manifest.projectId).catch(
    () => null,
  );
  broadcastArchivedContainersChanged(args.manifest.projectId);
  return args.response;
}

async function restoreWorktree(
  manifest: ArchivedContainerManifest,
  execution: RestoreExecution,
): Promise<ArchivedContainerRestoreResponse> {
  const warnings: string[] = [];
  if (manifest.version === 2 && !manifest.restoredTo) {
    // Source/ref/object failures must be reported before destination creation.
    await assertArchivedGitStateRestorable(manifest);
  }
  const executionIds = await listArchivedExecutionIds(manifest);
  if (manifest.restoredTo) {
    await assertRestoredWorktreeDestination(
      manifest,
      !!execution.commit.expectedRevisions || !!execution.attempt,
    );
    execution.attempt?.beforeEffects();
    const failed = await restoreExecutions({
      manifest,
      destinationId: manifest.restoredTo.id,
      executionIds,
    });
    await rebindLegacyPlanChats(manifest, manifest.restoredTo.id);
    if (failed.length > 0) {
      await commitArchivedContainer({
        ...manifest,
        executionRestorePending: true,
      });
      warnings.push(
        `Workflow executions still awaiting restore: ${failed.join(', ')}.`,
      );
      return {
        kind: 'worktree',
        restoredWorktreeId: manifest.restoredTo.id,
        warnings,
      };
    }
    const {
      executionRestorePending: _executionRestorePending,
      ...executionRestoredManifest
    } = manifest;
    void _executionRestorePending;
    return finishRestore({
      manifest: executionRestoredManifest,
      destinationId: manifest.restoredTo.id,
      restoredCreatedAt: manifest.restoredTo.createdAt,
      response: {
        kind: 'worktree',
        restoredWorktreeId: manifest.restoredTo.id,
        warnings,
      },
    });
  }

  const created = await createRestoredWorktree(
    manifest,
    warnings,
    execution.commit,
    execution.attempt,
  );
  let committedManifest = manifest;
  execution.attempt?.beforeEffects();
  try {
    if (manifest.version === 2) {
      await restoreArchivedContainerGitState({
        manifest,
        destinationId: created.id,
        destinationRootPath: getWorkspaceWorktreeDir(
          manifest.projectId,
          created.id,
        ),
        preserveDescendantHead: created.reuseExistingBranch,
      });
    }
    await installChatPayloads({
      manifest,
      destinationId: created.id,
      destinationCreatedAt: created.createdAt,
      workEntry: false,
      portableWarnings: !!execution.attempt,
      warnings,
    });
    const relocatedRepositories =
      manifest.version === 3
        ? await restoreArchivedRecoveryWorkspaceRootFiles(
            manifest,
            resolveWorktreeCwd(manifest.projectId, created.id),
          )
        : await restoreArchivedContainerWorkspaceRootFiles(
            manifest.projectId,
            manifest.id,
            resolveWorktreeCwd(manifest.projectId, created.id),
          );
    for (const repository of relocatedRepositories) {
      warnings.push(
        `Restored archived repository repos/${repository.originalName} to repos/${repository.restoredName} because its original path is already in use.`,
      );
    }
    let installedManifest: ArchivedContainerManifest = manifest;
    if (manifest.version === 3) {
      const { restoreStaging: _restoreStaging, ...installed } = manifest;
      void _restoreStaging;
      installedManifest = installed;
    }
    committedManifest = {
      ...installedManifest,
      restoredTo: {
        kind: 'worktree',
        id: created.id,
        restoredAt: new Date().toISOString(),
        createdAt: created.createdAt,
      },
    };
    await commitArchivedContainer(committedManifest);
  } catch (error) {
    await rollbackRestoredWorktree(manifest, created.id, created.createdAt);
    throw error;
  }
  // The destination is committed; a resumed restore finds `restoredTo` and
  // does not notify again.
  notifyLedgerOfRestore(manifest, created);

  const failed = await restoreExecutions({
    manifest,
    destinationId: created.id,
    executionIds,
  });
  if (manifest.version !== 3) {
    await startRestoredWorktreePostCreateSetup(
      manifest,
      created.id,
      warnings,
      !!execution.attempt,
    );
  }
  // Before either the partial-restore return or the final purge, so no
  // retained archive still names the archived id for the restored worktree's
  // legacy plan chats. A failure keeps the archive (`restoredTo` is committed)
  // and the retried restore rebinds on its `restoredTo` path.
  await rebindLegacyPlanChats(committedManifest, created.id);
  if (failed.length > 0) {
    await commitArchivedContainer({
      ...committedManifest,
      executionRestorePending: true,
    });
    await removeArchivedContainerPayloadsAfterPartialRestore(
      manifest.projectId,
      manifest.id,
    );
    trackDetachedWork(() =>
      getChatSearchService().worktreeContainerRestored(
        manifest.projectId,
        manifest.id,
        created.id,
      ),
    );
    warnings.push(
      `Workflow executions failed to restore: ${failed.join(', ')}.`,
    );
    return {
      kind: 'worktree',
      restoredWorktreeId: created.id,
      branchName: created.branchName,
      warnings,
    };
  }

  return finishRestore({
    manifest: committedManifest,
    destinationId: created.id,
    restoredCreatedAt: created.createdAt,
    response: {
      kind: 'worktree',
      restoredWorktreeId: created.id,
      branchName: created.branchName,
      warnings,
    },
  });
}

async function restoreWorkEntry(
  manifest: ArchivedContainerManifest,
  execution: RestoreExecution,
): Promise<ArchivedContainerRestoreResponse> {
  const warnings: string[] = [];
  if (manifest.restoredTo) {
    await assertRestoredWorkEntryDestination(manifest);
    execution.attempt?.beforeEffects();
    return finishRestore({
      manifest,
      destinationId: manifest.restoredTo.id,
      restoredCreatedAt: manifest.restoredTo.createdAt,
      response: {
        kind: 'work-entry',
        restoredEntryId: manifest.restoredTo.id,
        warnings,
      },
    });
  }

  execution.attempt?.beforeEffects();
  const created = await createWorkEntry(manifest.projectId, {
    title: manifest.name,
    seedPanelLayoutMode: false,
  });
  const destinationId = created.entry.id;
  try {
    await installChatPayloads({
      manifest,
      destinationId,
      destinationCreatedAt: created.entry.createdAt,
      workEntry: true,
      portableWarnings: !!execution.attempt,
      warnings,
    });
    await commitArchivedContainer({
      ...manifest,
      restoredTo: {
        kind: 'work-entry',
        id: destinationId,
        restoredAt: new Date().toISOString(),
        createdAt: created.entry.createdAt,
      },
    });
  } catch (error) {
    const { withBrowserTaskOwnerRemoval } =
      await import('../browser/browser-profile-lifecycle');
    await withBrowserTaskOwnerRemoval(
      manifest.projectId,
      destinationId,
      async () => {
        await cleanupPersistedWorktreeData(
          manifest.projectId,
          destinationId,
        ).catch(() => []);
        await removeWorkEntryRow(manifest.projectId, destinationId);
      },
    ).catch(() => undefined);
    throw error;
  }
  // The destination is committed; a resumed restore finds `restoredTo` and
  // does not notify again.
  notifyLedgerOfRestore(manifest, created.entry);
  return finishRestore({
    manifest,
    destinationId,
    restoredCreatedAt: created.entry.createdAt,
    response: {
      kind: 'work-entry',
      restoredEntryId: destinationId,
      warnings,
    },
  });
}

export async function restoreArchivedContainer(
  projectId: string,
  containerId: string,
  options: W5BoundaryOptions = {},
  wire?: W5WireCall,
): Promise<ArchivedContainerRestoreResponse> {
  return runW5BoundaryOperation<ArchivedContainerRestoreResponse>(
    {
      operation: 'core.archive.container.restore',
      caller: wire?.caller ?? 'desktop-host:archive-container-restore',
      idempotencyKey: options.idempotencyKey,
      parameters: { projectId, containerId },
      ...(wire?.admit && { admit: wire.admit }),
      recheckAtOutcome: true,
      isPreEffectRefusal: (error) => error instanceof W5RevisionConflictError,
    },
    (outcome) => decodeW5CompositionOutcome(restoreOutcomeSchema, outcome),
    async (commit, attempt) => {
      validateId(projectId, 'projectId');
      validateId(containerId, 'containerId');
      commit.expectedRevisions = w5ExpectedRevision(
        { kind: 'worktrees', workspaceId: projectId },
        options.expectedRevision,
      );
      await checkW5CompositionRevisions(commit);
      return admitW5Composition(attempt, () =>
        withArchivedContainerOperationLock(projectId, containerId, async () => {
          const manifest = await readArchivedContainerManifest(
            projectId,
            containerId,
          );
          return manifest.kind === 'worktree'
            ? restoreWorktree(manifest, { commit, attempt })
            : restoreWorkEntry(manifest, { commit, attempt });
        }),
      );
    },
  );
}

const restoreOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('worktree'),
    restoredWorktreeId: z.string(),
    branchName: z.string().optional(),
    warnings: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('work-entry'),
    restoredEntryId: z.string(),
    warnings: z.array(z.string()),
  }),
]);

import { logMainProcessError } from './main-process-logging';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type ChangedFileInfo,
  type PersistedChatMessage,
  type PersistedChatTab,
  type TurnDiffTreeRef,
} from '@canopy/desktop-shared/types';
import { readChatTabsFile } from './chat-tabs-reader';
import { resolveWorktreeCwd } from './resolve-worktree';
import { isCoworkWorkspace, isMultiRepoWorkspace } from './workspace-registry';
import { getWorktreeAttachmentsDir } from './paths';
import {
  listWorkspaceWorktreeRepoEntries,
  type WorktreeRepoEntry,
} from './worktree-repo-entries';
import { restoreSnapshotThroughWorker } from '../canopy-runtime/worker-git-local-mutations-dispatch';
import {
  captureWorkingTreeSha,
  diffTreeObjects,
  setGitTreeSnapshotRuntime,
} from './git-tree-snapshot';
import { getResolvedGitExecutableForSpawn } from './git-executable';

setGitTreeSnapshotRuntime({
  resolveExecutable: () => getResolvedGitExecutableForSpawn(process.env),
  environment: () => process.env,
});

interface ResolvedRepoTarget {
  repoPath: string;
  ref: TurnDiffTreeRef;
  repoName?: string;
}

function findTabIndexById(tabs: PersistedChatTab[], chatId: string): number {
  return tabs.findIndex((tab) => tab.id === chatId);
}

function findUserMessageIndex(
  messages: PersistedChatMessage[],
  userMessageId: string,
): number {
  return messages.findIndex(
    (message) => message.id === userMessageId && message.role === 'user',
  );
}

async function resolveRepoTargets(
  projectId: string,
  worktreeId: string,
  treeRefs: TurnDiffTreeRef[],
): Promise<ResolvedRepoTarget[]> {
  const worktreePath = resolveWorktreeCwd(projectId, worktreeId);
  if (!isMultiRepoWorkspace(projectId)) {
    if (treeRefs.length === 0) {
      throw new Error('No snapshot available for this message');
    }
    const ref = treeRefs.find((candidate) => !candidate.repoId) ?? treeRefs[0];
    return [{ repoPath: worktreePath, ref }];
  }

  const repoEntries: WorktreeRepoEntry[] =
    await listWorkspaceWorktreeRepoEntries(projectId, worktreePath);
  if (repoEntries.length === 0) {
    throw new Error('Project has no repos to restore');
  }

  const refByRepoId = new Map<string, TurnDiffTreeRef>();
  for (const ref of treeRefs) {
    if (ref.repoId) {
      refByRepoId.set(ref.repoId, ref);
    }
  }

  const targets: ResolvedRepoTarget[] = [];
  const missing: string[] = [];
  for (const entry of repoEntries) {
    const ref = refByRepoId.get(entry.repoId);
    if (!ref) {
      missing.push(entry.repoName ?? entry.repoId);
      continue;
    }
    targets.push({
      repoPath: entry.repoPath,
      ref,
      ...(entry.repoName ? { repoName: entry.repoName } : {}),
    });
  }

  if (missing.length > 0) {
    throw new Error(`No snapshot available for repo(s): ${missing.join(', ')}`);
  }

  return targets;
}

function summarizeFileLine(file: ChangedFileInfo): string {
  const repoPrefix = file.repoName ? `${file.repoName}/` : '';
  const path =
    file.status === 'renamed' && file.previousPath
      ? `${repoPrefix}${file.previousPath} → ${repoPrefix}${file.path}`
      : `${repoPrefix}${file.path}`;
  return `- ${file.status} \`${path}\` (+${file.insertions}, -${file.deletions})`;
}

function buildAttachmentMarkdown(
  reverted: PersistedChatMessage,
  files: ChangedFileInfo[],
  totalInsertions: number,
  totalDeletions: number,
): string {
  const userText = reverted.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text.trim()] : []))
    .filter((text) => text.length > 0)
    .join('\n')
    .trim();

  const sections: string[] = [
    '# Reverted turn',
    '',
    'The user clicked "Revert" on the prior turn. Git state has been rolled back to the snapshot taken before that turn began. The chat transcript is unchanged.',
    '',
    `**Reverted user message** (id: \`${reverted.id}\`, sent ${new Date(reverted.timestamp).toISOString()}):`,
    '',
    userText.length > 0
      ? `> ${userText.replace(/\n/g, '\n> ')}`
      : '> _(no text content)_',
    '',
    `**Files rolled back:** ${files.length} (+${totalInsertions}, -${totalDeletions})`,
    '',
  ];

  if (files.length > 0) {
    sections.push(...files.map(summarizeFileLine));
  } else {
    sections.push(
      '_No tracked file changes were captured in the diff. The reverted turn may have been read-only._',
    );
  }

  return sections.join('\n').trimEnd() + '\n';
}

async function writeRevertAttachment(
  projectId: string,
  worktreeId: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const dir = getWorktreeAttachmentsDir(projectId, worktreeId);
  const filename = `revert-${new Date(timestamp).toISOString().replace(/[:.]/g, '-')}.md`;
  const fullPath = join(dir, filename);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, body, 'utf8');
  return fullPath;
}

async function captureRevertDiffs(repoTargets: ResolvedRepoTarget[]): Promise<{
  preRevertTrees: (string | null)[];
}> {
  const preRevertTrees = await Promise.all(
    repoTargets.map(async (target): Promise<string | null> => {
      try {
        return await captureWorkingTreeSha(target.repoPath);
      } catch {
        return null;
      }
    }),
  );
  return { preRevertTrees };
}

async function computeRevertChanges(
  repoTargets: ResolvedRepoTarget[],
  preRevertTrees: (string | null)[],
): Promise<{
  files: ChangedFileInfo[];
  totalInsertions: number;
  totalDeletions: number;
}> {
  const aggregated: ChangedFileInfo[] = [];
  for (let i = 0; i < repoTargets.length; i += 1) {
    const target = repoTargets[i];
    const preTree = preRevertTrees[i];
    if (!preTree) continue;
    try {
      const diff = await diffTreeObjects(
        target.repoPath,
        preTree,
        target.ref.startTree,
      );
      for (const file of diff) {
        aggregated.push({
          ...file,
          ...(target.ref.repoId ? { repoId: target.ref.repoId } : {}),
          ...(target.repoName ? { repoName: target.repoName } : {}),
        });
      }
    } catch {
      // Diff failures are non-fatal; the revert_info banner just shows fewer files.
    }
  }
  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const file of aggregated) {
    totalInsertions += file.insertions;
    totalDeletions += file.deletions;
  }
  return { files: aggregated, totalInsertions, totalDeletions };
}

export interface ChatResetToPointParams {
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
}

export async function resetChatToPoint(
  params: ChatResetToPointParams,
): Promise<PersistedChatTab> {
  const { projectId, worktreeId, chatId, userMessageId } = params;

  // Worktree chats only — the feature is git-centric.
  if (isCoworkWorkspace(projectId)) {
    throw new Error('Revert is only supported for worktree chats');
  }

  const tabsFile = await readChatTabsFile(projectId, worktreeId, {
    chatIds: [chatId],
    fullTranscript: true,
  });
  const tabIndex = findTabIndexById(tabsFile.tabs, chatId);
  if (tabIndex === -1) {
    throw new Error(`Chat ${chatId} not found`);
  }

  const tab = tabsFile.tabs[tabIndex];
  const messageIndex = findUserMessageIndex(tab.messages, userMessageId);
  if (messageIndex === -1) {
    throw new Error('User message not found in chat');
  }
  const userMessage = tab.messages[messageIndex];
  const revertedAsyncQuestionIds = new Set(
    tab.messages
      .slice(messageIndex + 1)
      .flatMap((message) =>
        message.blocks.flatMap((block) =>
          block.type === 'text' && block.asyncQuestion
            ? [block.asyncQuestion.requestId]
            : [],
        ),
      ),
  );

  const turnRefs = tab.turnDiffs?.[userMessageId]?.treeRefs ?? [];
  if (turnRefs.length === 0) {
    throw new Error('No snapshot available for this message');
  }

  const repoTargets = await resolveRepoTargets(projectId, worktreeId, turnRefs);

  // Capture pre-revert state so we can compute the diff that's being undone.
  // Done before any restore so the snapshot reflects the user's actual
  // pre-click state. Non-fatal on failure.
  const { preRevertTrees } = await captureRevertDiffs(repoTargets);

  // Restore is sequential; on per-repo failure surface which repos already
  // restored so the user knows the workspace is partially restored.
  // Validation above guarantees every repo has a captured snapshot.
  for (let index = 0; index < repoTargets.length; index += 1) {
    const target = repoTargets[index];
    try {
      await restoreSnapshotThroughWorker(target.repoPath, {
        treeSha: target.ref.startTree,
        ...(target.ref.startHeadCommitSha
          ? { headCommitSha: target.ref.startHeadCommitSha }
          : {}),
      });
    } catch (cause) {
      try {
        logMainProcessError(
          '[chat-reset-to-point] repository restore failed',
          cause,
        );
      } catch {
        // Diagnostics must preserve the existing restore rejection.
      }
      const detail = cause instanceof Error ? cause.message : String(cause);
      const partial =
        index > 0
          ? ` ${index} repo(s) already restored — project state is inconsistent and may need manual recovery.`
          : '';
      const error = new Error(
        `Failed to restore ${target.repoPath} (repo ${index + 1} of ${repoTargets.length}).${partial} Cause: ${detail}`,
      );
      // `cause` would change readIpcOperationFailure and renderer behavior.
      Object.defineProperty(error, 'restoreError', {
        value: cause,
        enumerable: false,
      });
      throw error;
    }
  }

  // Compute the diff that was rolled back: from pre-revert state back to the
  // snapshot. Used both for the in-transcript banner and the attachment body.
  const { files, totalInsertions, totalDeletions } = await computeRevertChanges(
    repoTargets,
    preRevertTrees,
  );

  const timestamp = Date.now();

  let attachmentPath: string | undefined;
  try {
    attachmentPath = await writeRevertAttachment(
      projectId,
      worktreeId,
      timestamp,
      buildAttachmentMarkdown(
        userMessage,
        files,
        totalInsertions,
        totalDeletions,
      ),
    );
  } catch {
    // Attachment generation is best-effort. The revert still completes; the
    // next user message just won't carry the synthetic summary file.
    attachmentPath = undefined;
  }

  const revertMessage: PersistedChatMessage = {
    id: `msg-revert-${timestamp}-${randomUUID()}`,
    role: 'system',
    blocks: [
      {
        type: 'revert_info',
        timestamp,
        revertedFromMessageId: userMessageId,
        revertedFromTimestamp: userMessage.timestamp,
        files,
        totalInsertions,
        totalDeletions,
        ...(turnRefs.length > 0 ? { treeRefs: turnRefs } : {}),
        ...(attachmentPath ? { attachmentPath } : {}),
      },
    ],
    timestamp,
  };

  // Git restoration can outlive the snapshot read above. Apply the result
  // against the latest canonical state so concurrent messages survive and
  // question cleanup cannot be discarded as a stale compatibility write.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  const updated = await getChatStateService().updateCompatibilityTabs(
    { projectId, worktreeId },
    (current) => {
      if (!current.tabs.some((candidate) => candidate.id === chatId))
        throw new Error(`Chat ${chatId} no longer exists`);
      return {
        ...current,
        tabs: current.tabs.map((candidate) => {
          if (candidate.id !== chatId) return candidate;
          const nextTab: PersistedChatTab = {
            ...candidate,
            messages: [...candidate.messages, revertMessage],
          };
          if (attachmentPath)
            nextTab.pendingRevertAttachmentPath = attachmentPath;
          else delete nextTab.pendingRevertAttachmentPath;
          return nextTab;
        }),
        ...(current.pendingQuestions !== undefined
          ? {
              pendingQuestions: current.pendingQuestions.filter(
                (question) =>
                  question.chatId !== chatId ||
                  !revertedAsyncQuestionIds.has(question.requestId),
              ),
            }
          : {}),
      };
    },
    revertMessage.id,
    [chatId],
  );
  const updatedTab = updated.tabs.find((candidate) => candidate.id === chatId);
  if (!updatedTab) throw new Error(`Chat ${chatId} no longer exists`);
  return updatedTab;
}

// Exported for tests.
export const __testing = {
  buildAttachmentMarkdown,
  summarizeFileLine,
};

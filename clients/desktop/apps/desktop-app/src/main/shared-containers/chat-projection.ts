import { publishedChatToPersistedTab } from '@canopy/agent-transcript/remote-control/persisted-chat-projection';
import {
  COWORK_WORKSPACE_FILE_ROOT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ChatTabsFile,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { SharedContainerPublishedChat } from '@canopy/protocol/shared-containers';
import {
  getChatStateService,
  type ChatStateService,
} from '../services/chat-state-service';
import { getSharedContainerReader } from './read/reader';
import {
  assertSharedContainerViewerFileForRead,
  resolveSharedContainerViewerReadRoots,
  type SharedContainerViewerReadRoot,
} from './read/viewer-root';
import {
  applyInitialSharedContainerViewerLayout,
  createSharedContainerStartPageLayout,
  listSharedContainerPublishedLayoutFiles,
  repointSharedContainerViewerLayoutFileBindings,
  type SharedContainerViewerLayoutMode,
} from './layout-projection';
import { resolve } from 'node:path';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isStartPageFeatureEnabled } from '../lib/start-page-feature-flag';

export interface PublishedChatArtifact {
  artifactChatId: string;
  chat: SharedContainerPublishedChat;
}

export function projectPublishedChatsToTabs(options: {
  publishedChats: readonly PublishedChatArtifact[];
  projectId: string;
  worktreeId: string;
  resolveAttachment: (reference: string) => string | undefined;
  readOnly?: boolean;
}): { tabs: PersistedChatTab[]; warnings: string[] } {
  const warnings: string[] = [];
  const usedTabIds = new Set<string>();
  const tabs: PersistedChatTab[] = [];
  for (const { artifactChatId, chat } of options.publishedChats) {
    let localChatId = chat.chatId;
    if (usedTabIds.has(localChatId)) {
      localChatId = artifactChatId;
      let copyNumber = 2;
      while (usedTabIds.has(localChatId)) {
        localChatId = `${artifactChatId}-copy-${copyNumber}`;
        copyNumber += 1;
      }
      warnings.push(
        `Chat id ${chat.chatId} was duplicated; artifact ${artifactChatId} was imported as ${localChatId}.`,
      );
    }
    usedTabIds.add(localChatId);
    const result = publishedChatToPersistedTab(chat, {
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: localChatId,
      resolveAttachment: options.resolveAttachment,
    });
    warnings.push(...result.warnings);
    tabs.push(
      options.readOnly ? { ...result.tab, readOnly: true } : result.tab,
    );
  }
  return { tabs, warnings };
}

export function selectProjectedViewerActiveTabId(
  previousActiveTabId: string,
  tabs: readonly PersistedChatTab[],
  preferredActiveTabId?: string,
): string {
  if (
    preferredActiveTabId &&
    tabs.some((tab) => tab.id === preferredActiveTabId)
  ) {
    return preferredActiveTabId;
  }
  return tabs.some((tab) => tab.id === previousActiveTabId)
    ? previousActiveTabId
    : (tabs[0]?.id ?? '');
}

async function repointViewerFileTabs(
  tabs: readonly PersistedChatTab[],
  roots: readonly SharedContainerViewerReadRoot[],
  containerId: string,
): Promise<PersistedChatTab[]> {
  const projected = await Promise.all(
    tabs
      .filter((tab) => tab.kind === 'file')
      .map(async (tab): Promise<PersistedChatTab | null> => {
        if (!tab.filePath) return null;
        const normalizedPath = tab.filePath.replace(/\\/g, '/');
        for (const root of roots) {
          const marker =
            root.repoId === COWORK_WORKSPACE_FILE_ROOT_ID
              ? '/content/'
              : `/repos/${root.repoId}/`;
          const markerIndex = normalizedPath.indexOf(marker);
          if (markerIndex < 0) continue;
          const relativePath = normalizedPath.slice(
            markerIndex + marker.length,
          );
          const filePath = resolve(root.absolutePath, relativePath);
          try {
            await assertSharedContainerViewerFileForRead(containerId, filePath);
          } catch {
            continue;
          }
          const projectedTab: PersistedChatTab = {
            ...tab,
            // Compatibility reads may page transcript state. File tabs have
            // no transcript, so normalize them to complete empty content
            // before the authoritative revision replace validates the batch.
            messages: [],
            filePath,
            readOnly: true,
            ...(tab.fileDiffContext
              ? {
                  fileDiffContext: {
                    ...tab.fileDiffContext,
                    path: relativePath,
                    repoId: root.repoId,
                  },
                }
              : {}),
          };
          delete projectedTab.transcript;
          delete projectedTab.transcriptLoaded;
          delete projectedTab.transcriptWindow;
          return projectedTab;
        }
        return null;
      }),
  );
  return projected.filter((tab): tab is PersistedChatTab => !!tab);
}

/**
 * Replace the viewer's canonical chat scope with one promoted revision.
 *
 * `mode` is `reset` only for a sync the recipient's open started. When the
 * revision then carries the publisher's layout, that layout replaces the
 * recipient's own arrangement, wins over a start page, and decides the active
 * tab; the recipient's own file tabs are dropped so they do not come back as
 * panels. The viewer holds no recipient-owned chat tabs, so nothing else is
 * lost. `seed` (the default) keeps the recipient's layout and tabs, and is
 * what every other sync uses.
 */
export async function projectSharedContainerViewerChats(
  containerId: string,
  revisionId: string,
  chatState: ChatStateService = getChatStateService(),
  options: {
    mode?: SharedContainerViewerLayoutMode;
    stopViewerBrowsers?: (containerId: string) => Promise<void>;
  } = {},
): Promise<void> {
  const reader = getSharedContainerReader();
  const [{ root, layout }, publishedChats, roots] = await Promise.all([
    reader.readForkLayout({ containerId, revisionId }),
    reader.readForkChats({ containerId, revisionId }),
    resolveSharedContainerViewerReadRoots(containerId, reader),
  ]);
  const attachments = new Map<string, string>();
  for (const [reference, attachment] of Object.entries(
    layout.attachmentPaths,
  )) {
    const path = reader.store.resolvePathBelowForRead(
      root,
      'content',
      'attachments',
      attachment.displayName,
    );
    attachments.set(reference, path);
    attachments.set(attachment.artifactId, path);
  }
  const scope = {
    projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
    worktreeId: containerId,
  };
  const previous = await chatState.getCompatibilityTabs(scope);
  const { tabs: publishedTabs } = projectPublishedChatsToTabs({
    publishedChats,
    ...scope,
    resolveAttachment: (reference) => attachments.get(reference),
    readOnly: true,
  });
  const retainedFileTabs = await repointViewerFileTabs(
    previous.tabs,
    roots,
    containerId,
  );
  const publishedLayout = 'layout' in layout ? layout.layout : undefined;
  const startPage =
    isStartPageFeatureEnabled() && 'startPage' in layout
      ? layout.startPage
      : undefined;
  const projectedLayout = startPage
    ? createSharedContainerStartPageLayout(startPage)
    : publishedLayout;
  const publishedPathsByRepo = new Map<string, Set<string>>(
    layout.containerType === 'CODE_WORKTREE'
      ? layout.repositories.map((repository) => [
          repository.repoId,
          new Set([
            ...repository.files
              .filter((file) => file.status !== 'deleted')
              .map((file) => file.path),
            ...('committedFiles' in repository
              ? (repository.committedFiles ?? []).map((file) => file.path)
              : []),
          ]),
        ])
      : [
          [
            roots[0]?.repoId ?? '',
            new Set(
              layout.files
                .filter((file) => file.status !== 'deleted')
                .map((file) => file.path),
            ),
          ],
        ],
  );
  if (layout.containerType === 'CODE_WORKTREE') {
    // A code replica is a full checkout, so a publisher tab on an unchanged
    // tracked file is readable too. Admit each one the layout names only
    // after confirming it is a regular file inside the sealed replica.
    const rootsById = new Map(roots.map((entry) => [entry.repoId, entry]));
    const layoutsForAdmission = startPage
      ? [projectedLayout, publishedLayout]
      : [projectedLayout];
    await Promise.all(
      layoutsForAdmission.flatMap((candidateLayout) =>
        listSharedContainerPublishedLayoutFiles(candidateLayout).map(
          async ({ repoId, relativePath }) => {
            const readRoot = rootsById.get(repoId);
            const published = publishedPathsByRepo.get(repoId);
            if (!readRoot || !published || published.has(relativePath)) return;
            try {
              const resolved = await assertSharedContainerViewerFileForRead(
                containerId,
                resolve(readRoot.absolutePath, relativePath),
              );
              if (
                resolved.root.repoId === repoId &&
                resolved.relativePath === relativePath
              ) {
                published.add(relativePath);
              }
            } catch {
              // Absent or not a regular file in this revision: drop the tab.
            }
          },
        ),
      ),
    );
  }
  let initialLayout =
    options.mode === 'reset' && publishedLayout
      ? await applyInitialSharedContainerViewerLayout({
          containerId,
          mode: 'reset',
          stopViewerBrowsers: options.stopViewerBrowsers,
          layout: publishedLayout,
          roots,
          chatIds: new Set(publishedTabs.map((tab) => tab.id)),
          publishedPathsByRepo,
        })
      : null;
  // A layout that projects to no panels resets nothing; the open then seeds
  // exactly like any other sync.
  const layoutReset = initialLayout?.applied === true;
  if (!initialLayout?.applied) {
    initialLayout = await applyInitialSharedContainerViewerLayout({
      containerId,
      layout: projectedLayout,
      roots,
      chatIds: new Set(publishedTabs.map((tab) => tab.id)),
      publishedPathsByRepo,
    });
  }
  let startPageApplied = !layoutReset && !!startPage && initialLayout.applied;
  if (!layoutReset && startPage && !initialLayout.applied && publishedLayout) {
    initialLayout = await applyInitialSharedContainerViewerLayout({
      containerId,
      layout: publishedLayout,
      roots,
      chatIds: new Set(publishedTabs.map((tab) => tab.id)),
      publishedPathsByRepo,
    });
    startPageApplied = false;
  }
  try {
    const tabs = [
      ...publishedTabs,
      ...(layoutReset ? [] : retainedFileTabs),
      ...initialLayout.fileTabs,
    ].filter(
      (tab, index, all) =>
        all.findIndex((candidate) => candidate.id === tab.id) === index,
    );
    repointSharedContainerViewerLayoutFileBindings(containerId, tabs);
    const activeTabId = selectProjectedViewerActiveTabId(
      previous.activeTabId,
      tabs,
      layoutReset
        ? initialLayout.activeTabId
        : startPageApplied
          ? initialLayout.fileTabs[0]?.id
          : undefined,
    );
    const tabsFile: ChatTabsFile = {
      version: 1,
      tabs,
      activeTabId,
    };
    await chatState.replaceCompatibilityTabs(scope, tabsFile, {
      authoritative: true,
      activeTabId,
    });
  } catch (error) {
    await initialLayout
      .rollback()
      .catch((rollbackError: unknown) =>
        logMainProcessWarn(
          '[shared-containers] failed to restore the viewer layout',
          rollbackError,
        ),
      );
    throw error;
  }
}

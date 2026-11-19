import { fileViewerKey } from '@canopy/app-state';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { RemoteControlFileReadPayload } from '@canopy/protocol/remote-control/shell';
import { waitForChatScopeLive } from '@/stores/chat/slices/revisioned';
import type { ChatTab } from '@/stores/chat/types';
import { worktreeKey } from '@/stores/chat/utils';
import { useChatStore } from '@/stores/chatStore';
import { useFileTabUiStore } from '@/stores/fileTabUiStore';
import { desktopFileSessionController as controller } from './desktop-file-session-controller';

interface MovedFile {
  projectId: string;
  worktreeId: string;
  source: {
    absolutePath: string;
    relativePath: string;
    root: { repoId: string; absolutePath: string };
  };
  toRoot: { repoId: string; absolutePath: string };
  toRelativePath: string;
}

// As file-reference-paths parses roots: a leading / is always POSIX.
const isWindowsPath = (path: string): boolean =>
  /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\');

/** `path` after `from` (a file or folder) moved to `to`, or null. */
function movedPath(path: string, from: string, to: string): string | null {
  const fold = (value: string): string =>
    isWindowsPath(from) ? value.replace(/\\/g, '/').toLowerCase() : value;
  if (fold(path) !== fold(from) && !fold(path).startsWith(`${fold(from)}/`))
    return null;
  return to + path.slice(from.length);
}

const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** The open file tabs at or under the moved path. */
function tabsUnder(moved: MovedFile): Array<ChatTab & { filePath: string }> {
  const tabs =
    useChatStore.getState().worktreeChats[worktreeKey(moved)]?.tabs ?? [];
  return tabs.flatMap((tab) =>
    tab.kind === 'file' &&
    tab.filePath &&
    movedPath(tab.filePath, moved.source.absolutePath, '') !== null
      ? [{ ...tab, filePath: tab.filePath }]
      : [],
  );
}

/**
 * Only clean tabs follow a move (CAN-6540), so no unsaved draft ever has to
 * move. With Auto Save on, unsaved changes are saved where they are first;
 * otherwise, or when a save fails, the move is refused.
 */
async function saveOrRefuse(moved: MovedFile): Promise<void> {
  const { source, toRoot, toRelativePath } = moved;
  const parent = (path: string): string =>
    path.slice(0, Math.max(0, path.lastIndexOf('/')));
  const verb =
    toRoot.repoId === source.root.repoId &&
    parent(source.relativePath) === parent(toRelativePath)
      ? 'rename'
      : 'move';
  const headline = `Couldn't ${verb} ${nameOf(source.relativePath)}.`;
  const refusal = (path: string): Error =>
    new Error(
      `${headline} Save or discard your changes to ${nameOf(path)} first.`,
    );
  for (const tab of tabsUnder(moved)) {
    if (!controller.isDirty(tab.id)) continue;
    if (!useFileTabUiStore.getState().autoSaveEnabled)
      throw refusal(tab.filePath);
    if (!(await controller.saveTab(tab.id)) || controller.isDirty(tab.id)) {
      const session = controller.getSession(tab.id);
      // The write can succeed while an edit typed during it leaves it dirty.
      if (session && session.status !== 'error' && !session.saveConflict)
        throw refusal(tab.filePath);
      throw new Error(
        `${headline} Saving your changes to ${nameOf(tab.filePath)} failed.`,
      );
    }
  }
  // A tab checked above can be edited while a later save is awaited.
  const edited = tabsUnder(moved).find((tab) => controller.isDirty(tab.id));
  if (edited) throw refusal(edited.filePath);
}

/** Where each followed tab was, until its viewer switches to the new path. */
const followed = new Map<
  string,
  {
    target: { projectId: string; worktreeId: string };
    absolutePath: string;
    fileDiffContext: ChatTab['fileDiffContext'];
  }
>();

/**
 * A file tab's viewer switches files here. The controller keeps a tab with
 * unsaved changes on its session, so a followed tab edited after its retarget
 * doesn't switch: main is pointed back at the session's path instead.
 * Answers whether the viewer registered `request`.
 */
export function registerFileTab(
  tabId: string,
  request: RemoteControlFileReadPayload,
): boolean {
  const previous = controller.getFileKey(tabId);
  const key = controller.registerTab(tabId, request);
  if (key === fileViewerKey(request)) {
    if (key !== previous) followed.delete(tabId);
    return true;
  }
  const back = followed.get(tabId);
  if (back)
    void useChatStore
      .getState()
      .retargetFileTab(
        tabId,
        {
          absolutePath: back.absolutePath,
          filename: nameOf(back.absolutePath),
          ...(back.fileDiffContext
            ? { fileDiffContext: back.fileDiffContext }
            : {}),
        },
        back.target,
      )
      .catch(reportClientAppError);
  return false;
}

/**
 * Resolves once main's commit shows the tab on `path` (or the tab is gone),
 * so the next queued move starts from the path its viewer registers.
 */
function tabCommitted(
  scope: string,
  tabId: string,
  path: string,
): Promise<void> {
  const settled = (): boolean => {
    const tab = useChatStore
      .getState()
      .worktreeChats[scope]?.tabs.find((each) => each.id === tabId);
    return tab === undefined || tab.filePath === path;
  };
  if (settled()) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    const finish = (): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    // shortcut: a commit later than this lets the next move start early;
    // raise it if main's commits ever lag replies that long.
    const timer = setTimeout(finish, 15_000);
    unsubscribe = useChatStore.subscribe(() => {
      if (settled()) finish();
    });
  });
}

/** Points the clean tabs at the moved file; their viewers reopen it there. */
async function follow(moved: MovedFile): Promise<void> {
  const { projectId, worktreeId, source, toRoot, toRelativePath } = moved;
  const target = { projectId, worktreeId };
  if (!(await waitForChatScopeLive(projectId, worktreeId))) return;
  const separator = isWindowsPath(toRoot.absolutePath) ? '\\' : '/';
  const toAbsolute =
    toRoot.absolutePath.replace(separator === '\\' ? /[\\/]+$/ : /\/+$/, '') +
    separator +
    toRelativePath.split('/').join(separator);
  await Promise.all(
    tabsUnder(moved).map(async (tab) => {
      // Edited during the disk move: it stays on its path, as before.
      if (controller.isDirty(tab.id)) return;
      const absolutePath = movedPath(
        tab.filePath,
        source.absolutePath,
        toAbsolute,
      );
      if (absolutePath === null) return;
      const diff = tab.fileDiffContext;
      const diffPath =
        // A turn diff compares Git trees pinned to the old path.
        diff &&
        diff.source !== 'turn' &&
        (diff.repoId ?? source.root.repoId) === source.root.repoId
          ? movedPath(diff.path, source.relativePath, toRelativePath)
          : null;
      if (!followed.has(tab.id))
        followed.set(tab.id, {
          target,
          absolutePath: tab.filePath,
          fileDiffContext: diff,
        });
      const accepted = await useChatStore.getState().retargetFileTab(
        tab.id,
        {
          absolutePath,
          filename: nameOf(absolutePath),
          ...(diff && diffPath !== null
            ? {
                fileDiffContext: {
                  ...diff,
                  path: diffPath,
                  ...(toRoot.repoId === source.root.repoId
                    ? {}
                    : { repoId: toRoot.repoId }),
                },
              }
            : {}),
        },
        target,
      );
      if (accepted)
        await tabCommitted(worktreeKey(target), tab.id, absolutePath);
    }),
  );
}

// Files-tree moves run one at a time, each after the last one's tabs have
// followed, so a quick rename onward starts from the paths main committed.
let queue: Promise<unknown> = Promise.resolve();

/** Runs a Files-tree rename or move; its clean open file tabs follow it. */
export function moveWithFileTabs<T>(
  moved: MovedFile,
  mutate: () => Promise<T>,
): Promise<T> {
  const moving = queue.then(async () => {
    await saveOrRefuse(moved);
    return mutate();
  });
  // A refused or failed move reaches the caller; either way the next runs.
  queue = moving.then(
    () => follow(moved).catch(reportClientAppError),
    () => undefined,
  );
  return moving;
}

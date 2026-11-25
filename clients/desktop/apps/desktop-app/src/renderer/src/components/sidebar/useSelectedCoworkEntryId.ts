import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

/**
 * The Work Entry a cowork workspace's sidebar row shows as selected: the
 * active entry of the active project, on the chat page, once it is in the
 * project's live entry list. Null otherwise.
 *
 * One definition for the row that draws the selection and for the Chats
 * section, which keeps its rows block mounted through a collapse only while
 * the row has a selection to keep.
 */
export function useSelectedCoworkEntryId(
  workspaceId: string | undefined,
): string | null {
  // Read the page only for the active project, so moving to or from the chat
  // page renders no other workspace's row.
  const isActiveWorkspace = useStandaloneChatStore(
    (s) => workspaceId !== undefined && s.activeChatProjectId === workspaceId,
  );
  const onChatPage = useNavigationStore(
    (s) => isActiveWorkspace && s.activePage === 'chat',
  );
  return useStandaloneChatStore((s) => {
    const entryId = s.activeWorkEntryId;
    if (
      !onChatPage ||
      workspaceId === undefined ||
      s.activeChatProjectId !== workspaceId ||
      entryId === null
    ) {
      return null;
    }
    return s.workEntries.some((entry) => entry.id === entryId) ? entryId : null;
  });
}

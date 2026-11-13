import { useStore } from 'zustand';
import { useShallow } from 'zustand/shallow';
import { cloudCoworkStore } from '@/cloud-chats/cloud-cowork-store';
import { useProjectsStore } from '@/stores/projectsStore';

export interface CoworkWorkspaceIdentity {
  readonly name: string;
  readonly color?: string;
}

/** The name and colour the cowork page shows for a local or cloud project. */
export function useCoworkWorkspaceIdentity(
  workspaceId: string,
): CoworkWorkspaceIdentity | null {
  const local = useProjectsStore(
    useShallow((state) => {
      const project = state.projects.find((each) => each.id === workspaceId);
      return project === undefined
        ? null
        : { name: project.name, color: project.color };
    }),
  );
  const cloud = useStore(
    cloudCoworkStore,
    useShallow((state) => {
      const project = state.projects.find((each) => each.key === workspaceId);
      return project === undefined
        ? null
        : { name: project.name, color: project.color };
    }),
  );
  const identity = local ?? cloud;
  if (identity === null) return null;
  return identity.color === undefined
    ? { name: identity.name }
    : { name: identity.name, color: identity.color };
}

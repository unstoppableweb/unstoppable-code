import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  CloudProjectSetupPanel,
  type CloudProjectSetupPanelState,
  type CloudProjectSetupProgressLine,
} from '@canopy/ui-app';
import type {
  CloudProjectSetupCatalog,
  CloudProjectSetupProgress,
} from '@canopy/desktop-shared/types';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';

/**
 * The desktop host of the shared cloud project setup panel (CAN-5192), shown
 * in the Add project dialog's Personal "From your other computers" option.
 * Main owns the catalog, the repositories and the setup; this component only
 * carries the user's choices to it and its progress back.
 */

interface AddCloudProjectSetupProps {
  readonly onClose: () => void;
  readonly onWorkspaceCreated: (workspaceId: string) => void;
}

interface Choosing {
  projectId: string;
  projectName: string;
  repositories: Extract<
    CloudProjectSetupPanelState,
    { kind: 'choose' }
  >['repositories'];
  selectedIds: string[];
  destinationRoot: string | null;
}

function listState(
  catalog: CloudProjectSetupCatalog,
): CloudProjectSetupPanelState {
  return catalog.status === 'ok'
    ? { kind: 'list', projects: catalog.projects }
    : { kind: 'unavailable', reason: catalog.reason };
}

/**
 * The repositories the panel shows as kept, in its own order: the ones the
 * user selected, plus the project root, which is always cloned and has no
 * row to deselect.
 */
function repositoryIds(choosing: Choosing): string[] {
  const kept = new Set(choosing.selectedIds);
  return choosing.repositories
    .filter(
      (repository) => repository.root || kept.has(repository.repositoryId),
    )
    .map((repository) => repository.repositoryId);
}

function progressLine(
  progress: CloudProjectSetupProgress,
): CloudProjectSetupProgressLine | null {
  if (progress.state !== 'running') return null;
  if (progress.repository === undefined) return { repository: null };
  return {
    repository: {
      ...progress.repository,
      ...(progress.percent === undefined ? {} : { percent: progress.percent }),
    },
  };
}

export function AddCloudProjectSetup({
  onClose,
  onWorkspaceCreated,
}: AddCloudProjectSetupProps): JSX.Element {
  const [list, setList] = useState<CloudProjectSetupPanelState>({
    kind: 'loading',
  });
  const [choosing, setChoosing] = useState<Choosing | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] =
    useState<CloudProjectSetupProgressLine | null>(null);
  const [error, setError] =
    useState<Extract<CloudProjectSetupPanelState, { kind: 'choose' }>['error']>(
      null,
    );
  const mounted = useRef(true);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const catalog = await window.api.cloudProjects.setupCatalog();
      if (mounted.current) setList(listState(catalog));
    } catch (cause) {
      // The panel shows the failure in place; record it for diagnostics.
      reportClientAppError(cause, {
        surface: 'inline',
      });
      if (mounted.current) setList({ kind: 'unavailable', reason: 'offline' });
    }
  }, []);

  useEffect((): (() => void) => {
    mounted.current = true;
    void reload();
    return (): void => {
      mounted.current = false;
    };
  }, [reload]);

  useEffect(
    (): (() => void) =>
      window.api.cloudProjects.onSetupProgress((event): void => {
        if (event.projectId === choosing?.projectId)
          setProgress(progressLine(event));
      }),
    [choosing?.projectId],
  );

  const choose = async (projectId: string): Promise<void> => {
    setError(null);
    setProgress(null);
    const options = await window.api.cloudProjects
      .setupOptions(projectId)
      .catch((cause: unknown): null => {
        reportClientAppError(cause, {
          surface: 'inline',
        });
        return null;
      });
    if (!mounted.current) return;
    if (options === null || options.status !== 'ok') {
      setList({
        kind: 'unavailable',
        reason:
          options?.status === 'unavailable' && options.reason === 'offline'
            ? 'offline'
            : 'project-unavailable',
      });
      return;
    }
    setChoosing({
      projectId,
      projectName: options.name,
      repositories: options.repositories,
      selectedIds: options.repositories.map(
        (repository) => repository.repositoryId,
      ),
      destinationRoot: options.destinationRoot,
    });
  };

  const toggle = (repositoryId: string): void => {
    setChoosing((current) =>
      current === null
        ? current
        : {
            ...current,
            selectedIds: current.selectedIds.includes(repositoryId)
              ? current.selectedIds.filter((id) => id !== repositoryId)
              : [...current.selectedIds, repositoryId],
          },
    );
  };

  const changeDestination = async (): Promise<void> => {
    const result = await window.api.browseForCloneDirectory();
    if (result.canceled || !result.directoryPath) return;
    await window.api.savePreferences({
      orgProjectDefaultDestinationRoot: result.directoryPath,
    });
    const directoryPath = result.directoryPath;
    setChoosing((current) =>
      current === null
        ? current
        : { ...current, destinationRoot: directoryPath },
    );
  };

  const start = async (): Promise<void> => {
    if (choosing === null || choosing.destinationRoot === null || busy) return;
    // The panel turns Set up off with nothing kept; main would refuse the
    // empty selection anyway, so never send it.
    if (repositoryIds(choosing).length === 0) {
      setError('invalid-selection');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await window.api.cloudProjects
      .startSetup({
        projectId: choosing.projectId,
        repositoryIds: repositoryIds(choosing),
        destinationRoot: choosing.destinationRoot,
      })
      .catch((cause: unknown): { ok: false; code: 'setup-failed' } => {
        reportClientAppError(cause, {
          surface: 'inline',
        });
        return { ok: false, code: 'setup-failed' };
      });
    if (!mounted.current) return;
    setBusy(false);
    setProgress(null);
    if (!result.ok) {
      setError(result.code);
      return;
    }
    void useProjectsStore.getState().loadProjects({ silent: true });
    useGitHubStore
      .getState()
      .addToast(`Set up ${choosing.projectName}.`, 'success', undefined, {
        blockMessageFromReplay: true,
      });
    onClose();
    onWorkspaceCreated(result.workspaceId);
  };

  const state: CloudProjectSetupPanelState =
    choosing === null
      ? list
      : {
          kind: 'choose',
          projectName: choosing.projectName,
          repositories: choosing.repositories,
          selectedIds: choosing.selectedIds,
          destinationRoot: choosing.destinationRoot,
          busy,
          progress,
          error,
        };

  return (
    <CloudProjectSetupPanel
      state={state}
      onChoose={(projectId): void => {
        void choose(projectId);
      }}
      onBack={(): void => {
        setChoosing(null);
        setError(null);
        void reload();
      }}
      onToggleRepository={toggle}
      onChangeDestination={(): void => {
        void changeDestination();
      }}
      onStart={(): void => {
        void start();
      }}
    />
  );
}

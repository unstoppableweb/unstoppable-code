import { useEffect, useRef, useState, type JSX } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  dismissHomeSeedFallback,
  type HomeSeedFallbackNotice,
} from './homeSeedFallback';

interface HomeUnavailableProjectNoticeProps {
  readonly notice: HomeSeedFallbackNotice;
  /** Opens the project picker of the surface showing this notice. */
  readonly onChangeProject: () => void;
}

/**
 * CAN-7326: the last project failed to load, so Home's launch seed picked
 * another one. Names both, offers Reload and Change project, and stays out of
 * Send's way: the reporter asked for a notice, not a blocked composer.
 */
export function HomeUnavailableProjectNotice({
  notice,
  onChangeProject,
}: HomeUnavailableProjectNoticeProps): JSX.Element {
  const inventoryLoading = useProjectsStore(
    (state) => state.projectInventoryStatus === 'loading',
  );
  const [isReloading, setIsReloading] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const { unavailableWorkspaceId } = notice;
  const reload = async (): Promise<void> => {
    if (
      isReloading ||
      useProjectsStore.getState().projectInventoryStatus === 'loading'
    )
      return;
    setIsReloading(true);
    setReloadFailed(false);
    let threw = false;
    try {
      await useProjectsStore.getState().loadProjects({ silent: true });
    } catch (error) {
      threw = true;
      reportClientAppError(error, { source: 'home.seed_fallback_reload' });
    } finally {
      // A successful recovery re-selects the project, which unmounts this
      // notice during the await.
      if (mounted.current) {
        setIsReloading(false);
        setReloadFailed(
          threw ||
            useProjectsStore
              .getState()
              .failedWorkspaceIds.has(unavailableWorkspaceId),
        );
      }
    }
  };

  const failedName = (
    <span className={POSTHOG_REPLAY_MASK_CLASS}>{notice.failedName}</span>
  );
  const targetName = (
    <span className={POSTHOG_REPLAY_MASK_CLASS}>{notice.targetName}</span>
  );
  // Surface-specific copy: the config file's name comes from the load
  // warning, so the default brand reads "Its canopy.json is invalid." without
  // a literal product name here. The title's full stop comes from the
  // notice's inline title layout.
  return (
    <Notice
      data-testid="home-project-unavailable"
      intent="attention"
      className="pointer-events-auto"
      title={<>{failedName} couldn’t load</>}
      detail={reloadFailed ? 'It still couldn’t load.' : undefined}
      announceDetail={reloadFailed}
      onDismiss={(): void => dismissHomeSeedFallback(unavailableWorkspaceId)}
      dismissLabel="Dismiss"
      dismissTestId="home-project-unavailable-dismiss"
      actions={
        <>
          <NoticeButton
            data-testid="home-project-unavailable-change-project"
            onClick={onChangeProject}
          >
            Change project
          </NoticeButton>
          <NoticeButton
            variant="primary"
            data-testid="home-project-unavailable-reload"
            busy={isReloading || inventoryLoading}
            busyLabel="Reloading…"
            onClick={(): void => {
              void reload();
            }}
          >
            Reload
          </NoticeButton>
        </>
      }
    >
      {notice.failedCode === 'invalid-canopy-json' &&
      notice.failedFileName !== null ? (
        <>
          Its {notice.failedFileName} is invalid. New tasks will go to{' '}
          {targetName}.
        </>
      ) : (
        <>New tasks will go to {targetName}.</>
      )}
    </Notice>
  );
}

import {
  type JSX,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { LoadingSpinner } from '@canopy/ui-shared/components';
import { ErrorBanner } from '@canopy/ui-shared/components';
import { toAppError, type AppErrorCode } from '@canopy/protocol/app-errors';
import {
  CloseMediumIcon,
  DownloadIcon,
  RestartIcon,
  TerminalIcon,
  TimeslotIcon,
  WarningIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { linuxUpdateCopy } from '@canopy/desktop-shared/lib/linux-update-copy';
import { brand } from '@/lib/brand';
import { useUpdateState } from '@/hooks/useUpdateState';
import { formatVersionLabel } from '@/lib/version-label';
import { pt } from '@/lib/platform-text';
import {
  beginLinuxUpdateAction,
  openLinuxUpdateTerminal,
} from '@/lib/linux-update-terminal';
import { extractIpcErrorMessage } from '@/lib/errors';
import { useNavigationStore } from '@/stores/navigationStore';
import { useChatStore } from '@/stores/chatStore';
import {
  SidebarFooterBanner,
  SidebarFooterBannerIcon,
  type SidebarFooterBannerIconTone,
} from './SidebarFooterBanner';

type PendingAction = 'download' | 'install' | 'retry';

interface PromptTrailingAction {
  ariaLabel: string;
  icon: JSX.Element;
  onClick: () => void;
  testId: string;
  title?: string;
}

interface PromptView {
  icon: JSX.Element;
  iconTone?: SidebarFooterBannerIconTone;
  label: string;
  ariaLabel: string;
  title?: ReactNode;
  trailing?: JSX.Element;
  trailingAction?: PromptTrailingAction;
  onClick?: () => void;
}

/**
 * Sidebar footer banner covering the full update lifecycle: available (click
 * to download), starting/downloading progress, downloaded (click to restart,
 * trailing action to queue the install for when all agents are idle), queued
 * install (click to restart now, trailing action to cancel the schedule), and
 * download/check errors (click to retry). Only the idle, checking, and
 * not-available phases render nothing.
 */
export function UpdatePrompt(): JSX.Element {
  const { state } = useUpdateState();
  const updateOffer = `${state.phase}:${state.info?.version ?? ''}`;
  const currentUpdateOffer = useRef<string | null>(null);
  const systemUpdaterRequestId = useRef(0);
  const [systemUpdaterPending, setSystemUpdaterPending] = useState(false);
  useLayoutEffect(() => {
    currentUpdateOffer.current = updateOffer;
    return (): void => {
      currentUpdateOffer.current = null;
      systemUpdaterRequestId.current += 1;
    };
  }, [updateOffer]);
  const openSettings = useNavigationStore((s) => s.openSettings);
  const manualLinux = window.platform === 'linux';
  const linuxCopy = linuxUpdateCopy(brand, __CANOPY_RELEASE_FLAVOR__);
  const installed =
    manualLinux && state.info?.installedByPackageManager === true;
  const [actionError, setActionError] = useState<{
    message: string;
    code?: AppErrorCode;
  } | null>(null);
  // Local click acknowledgement. The updater phase only advances once the
  // main process emits its next event — the first download-progress event can
  // lag several seconds behind the click — so reflect the requested action
  // immediately instead of leaving the banner looking inert.
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );

  useEffect(() => {
    setPendingAction(null);
    setActionError(null);
  }, [state]);
  useEffect(() => {
    setSystemUpdaterPending(false);
  }, [updateOffer]);

  const showActionError = (error: unknown): void => {
    const classified = toAppError(error);
    setActionError({
      message: extractIpcErrorMessage(error),
      code: classified?.code,
    });
    setPendingAction(null);
  };
  const openUpdateTerminal = async (
    isCurrent: () => boolean,
  ): Promise<void> => {
    try {
      const result = await openLinuxUpdateTerminal(isCurrent);
      if (result.reason === 'no-local-worktree' && isCurrent())
        openSettings('canopy', { scrollTo: 'settings-linux-update-guidance' });
    } catch (error: unknown) {
      if (!isCurrent()) return;
      openSettings('canopy', { scrollTo: 'settings-linux-update-guidance' });
      const classified = toAppError(error);
      setActionError({
        message: extractIpcErrorMessage(error),
        code: classified?.code,
      });
    }
  };
  const openUpdateAction = async (useSystemUpdater: boolean): Promise<void> => {
    const navigationContext = useNavigationStore.getState();
    const selectedWorktree = useChatStore.getState().selectedWorktree;
    const requestId = ++systemUpdaterRequestId.current;
    const isCurrentRequest = (): boolean =>
      requestId === systemUpdaterRequestId.current &&
      currentUpdateOffer.current === updateOffer;
    const isLatestAction = beginLinuxUpdateAction((): void => {
      if (isCurrentRequest()) setSystemUpdaterPending(false);
    }, state.info?.version);
    const isCurrent = (): boolean => isLatestAction() && isCurrentRequest();
    setSystemUpdaterPending(true);
    setActionError(null);
    try {
      let opened = false;
      if (useSystemUpdater) {
        try {
          const result = await window.api.update.openSystemUpdater();
          opened = result.opened;
        } catch (error: unknown) {
          if (!isCurrent()) return;
          // Still offer the terminal and Settings after an unexpected failure.
          reportClientAppError(error);
        }
      }
      if (!isCurrent()) return;
      if (
        !opened &&
        useSystemUpdater &&
        (useNavigationStore.getState() !== navigationContext ||
          useChatStore.getState().selectedWorktree !== selectedWorktree)
      ) {
        setActionError({
          message:
            "Couldn't open Software Updater. Use the terminal or copy the command.",
        });
        return;
      }
      if (!opened) await openUpdateTerminal(isCurrent);
    } finally {
      if (isCurrentRequest()) setSystemUpdaterPending(false);
    }
  };

  const versionLabel = state.info?.version
    ? formatVersionLabel(state.info.version)
    : 'latest release';
  const percent = Math.round(state.progress?.percent ?? 0);

  const spinner = <LoadingSpinner tone="accent" />;

  let view: PromptView | null = null;

  const packageManagerUpdate = manualLinux
    ? state.info?.packageManagerUpdate
    : undefined;

  const hasSystemUpdater = state.info?.systemUpdater === 'update-manager';

  if (state.phase === 'available') {
    view = packageManagerUpdate
      ? {
          icon: <DownloadIcon size={16} aria-hidden="true" />,
          iconTone: 'accent',
          label: 'Update available',
          ariaLabel: `Update available (${versionLabel}): open update instructions`,
          title: (
            <>
              Version {versionLabel} is ready. {packageManagerUpdate.guidance}{' '}
              <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                {packageManagerUpdate.command}
              </span>
            </>
          ),
          onClick: (): void => {
            openSettings('canopy', {
              scrollTo: 'settings-linux-update-guidance',
            });
          },
        }
      : manualLinux && state.info?.manualDownload && linuxCopy.apt
        ? {
            icon: <DownloadIcon size={16} aria-hidden="true" />,
            iconTone: 'accent',
            label: 'Update available',
            ariaLabel: `Update available (${versionLabel}): ${hasSystemUpdater ? linuxCopy.softwareUpdater : 'open in terminal'}`,
            title: `Version ${versionLabel} is available.`,
            onClick: (): void => {
              void openUpdateAction(hasSystemUpdater);
            },
            trailingAction: hasSystemUpdater
              ? {
                  ariaLabel: linuxCopy.openInTerminal,
                  icon: <TerminalIcon size={16} aria-hidden="true" />,
                  onClick: (): void => {
                    void openUpdateAction(false);
                  },
                  testId: 'update-prompt-open-terminal',
                }
              : undefined,
          }
        : manualLinux
          ? {
              icon: <DownloadIcon size={16} aria-hidden="true" />,
              iconTone: 'accent',
              label: linuxCopy.downloadLabel,
              ariaLabel: `${linuxCopy.downloadLabel} (${versionLabel}): open the official download`,
              title: state.info?.manualDownload
                ? linuxCopy.downloadTooltip
                : undefined,
              onClick: state.info?.manualDownload
                ? (): void => {
                    const url = state.info?.manualDownload?.url;
                    if (url)
                      void window.api.browser
                        .openExternal({ url })
                        .catch(() => undefined);
                  }
                : undefined,
            }
          : pendingAction
            ? {
                icon: spinner,
                label: 'Starting download…',
                ariaLabel: `Starting download of ${versionLabel}`,
              }
            : {
                icon: <DownloadIcon size={16} aria-hidden="true" />,
                iconTone: 'accent',
                label: 'Update available',
                ariaLabel: `Update available (${versionLabel}): start download`,
                onClick: (): void => {
                  setPendingAction('download');
                  void window.api.update.downloadUpdate().catch(() => {
                    // Failures surface through the updater state stream as an
                    // error event, which re-renders this banner.
                    setPendingAction(null);
                  });
                },
              };
  } else if (state.phase === 'downloading' && !manualLinux) {
    view = {
      icon: spinner,
      label: 'Updating…',
      ariaLabel: `Downloading update ${versionLabel} (${percent}%)`,
      trailing: (
        <span
          className="text-2xs tabular-nums fg-primary"
          data-testid="update-prompt-percent"
        >
          {percent}%
        </span>
      ),
    };
  } else if (state.phase === 'downloaded' && (!manualLinux || installed)) {
    if (pendingAction) {
      view = {
        icon: spinner,
        label: pt({ default: 'Restarting…', linux: 'Relaunching…' }),
        ariaLabel: installed
          ? `Relaunching to finish ${versionLabel}`
          : `Restarting to install ${versionLabel}`,
      };
    } else if (state.installPending) {
      view = {
        icon: <TimeslotIcon size={16} aria-hidden="true" />,
        iconTone: 'accent',
        label: 'Update queued',
        ariaLabel: installed
          ? `Update queued (${versionLabel}): relaunches when agents are idle, click to relaunch now`
          : `Update queued (${versionLabel}): installs when agents are idle, click to restart now`,
        title: installed ? linuxCopy.installed.queued : undefined,
        onClick: (): void => {
          setPendingAction('install');
          void window.api.update.installUpdate().catch(showActionError);
        },
        trailingAction: {
          icon: <CloseMediumIcon size={16} aria-hidden="true" />,
          ariaLabel: `Cancel the scheduled install of ${versionLabel}`,
          title: 'Cancel scheduled install',
          testId: 'update-prompt-cancel-schedule',
          onClick: (): void => {
            void window.api.update
              .cancelScheduledUpdate()
              .catch(showActionError);
          },
        },
      };
    } else {
      view = {
        icon: <RestartIcon size={16} aria-hidden="true" />,
        iconTone: 'accent',
        label: pt({
          default: 'Restart to update',
          linux: linuxCopy.installed.label,
        }),
        ariaLabel: installed
          ? `Relaunch to finish (${versionLabel})`
          : `Update ready (${versionLabel}): restart to install`,
        title: installed ? linuxCopy.installed.title : undefined,
        onClick: (): void => {
          setPendingAction('install');
          void window.api.update.installUpdate().catch(showActionError);
        },
        trailingAction: {
          icon: <TimeslotIcon size={16} aria-hidden="true" />,
          ariaLabel: installed
            ? `Relaunch when idle (${versionLabel})`
            : `Install ${versionLabel} when all agents are idle`,
          title: pt({
            default: 'Install when idle',
            linux: linuxCopy.installed.relaunchWhenIdle,
          }),
          testId: 'update-prompt-schedule',
          onClick: (): void => {
            void window.api.update.scheduleUpdate().catch(showActionError);
          },
        },
      };
    }
  } else if (state.phase === 'error') {
    view = pendingAction
      ? {
          icon: spinner,
          label: 'Checking for updates…',
          ariaLabel: 'Checking for updates',
        }
      : {
          icon: <WarningIcon size={16} aria-hidden="true" />,
          iconTone: 'destructive',
          label: pt({ default: 'Update failed', linux: 'Check Linux updates' }),
          ariaLabel: pt({
            default: 'Update failed: click to retry',
            linux: 'Check Linux updates: click to retry',
          }),
          title: state.message ?? 'The update could not be completed.',
          onClick: (): void => {
            setPendingAction('retry');
            // A failed download/check leaves the updater outside the
            // downloadable phases, so recover by re-checking; a successful
            // check re-enters the available flow (and auto-download).
            void window.api.update.checkForUpdates().catch(() => {
              setPendingAction(null);
            });
          },
        };
  }

  const refusalMessage = installed ? state.message : undefined;
  if (!view && !refusalMessage) {
    return <></>;
  }

  return (
    <div className="flex flex-col gap-2">
      <ErrorBanner
        errorSource="sidebar-update-action"
        error={actionError?.message ?? refusalMessage}
        displayErrorCode={actionError?.code}
        testId="update-prompt-action-error"
      />
      {view && (
        <SidebarFooterBanner
          ariaLabel={view.ariaLabel}
          surface="status"
          onClick={view.onClick}
          disabled={state.phase === 'available' && systemUpdaterPending}
          testId="update-prompt"
          title={view.title ?? view.ariaLabel}
          trailingAction={view.trailingAction}
        >
          <SidebarFooterBannerIcon tone={view.iconTone}>
            {view.icon}
          </SidebarFooterBannerIcon>
          <span className="min-w-0 flex-1 truncate">{view.label}</span>
          {view.trailing}
        </SidebarFooterBanner>
      )}
    </div>
  );
}

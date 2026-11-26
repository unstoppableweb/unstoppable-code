import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BackgroundServiceNoticeProps } from '@canopy/ui-shared/components';
import { backgroundServiceRepairCommand } from '@canopy/ui-shared/lib';
import type {
  BackgroundServiceApi,
  BackgroundServiceStatus,
} from '@canopy/desktop-shared/lib/background-service-status';
import { formatBrandText } from '@/lib/brand';

function getApi(): BackgroundServiceApi | undefined {
  return typeof window !== 'undefined'
    ? window.api?.backgroundService
    : undefined;
}

/**
 * Restart app on this computer: resolves whether the restart was scheduled
 * (`false` in a dev build, or while a workflow has unsaved edits). The one
 * restart call for the background service notice and the Restart app action
 * beside a background-service error (CAN-7137).
 */
export function restartLocalApp(): Promise<boolean> {
  return window.api.restartApp();
}

/**
 * This computer's background service status for the shared notice
 * (CAN-5541, CAN-7061), with Try again and Restart app. Never calls the
 * blocked channels in a window that shows another computer: `local` false
 * returns nothing.
 */
export function useLocalBackgroundServiceNotice(
  local: boolean,
): Omit<BackgroundServiceNoticeProps, 'recovery'> | undefined {
  const [status, setStatus] = useState<BackgroundServiceStatus | null>(null);
  const [dataFolder, setDataFolder] = useState<string | undefined>();
  const dataFolderShared = status?.reason === 'data_folder_shared';

  // Pushes, the first read and retry answers can land in any order.
  const accept = useCallback((next: BackgroundServiceStatus): void => {
    setStatus((previous) =>
      previous && previous.sequence >= next.sequence ? previous : next,
    );
  }, []);

  useEffect(() => {
    const api = local ? getApi() : undefined;
    if (!api) return undefined;
    const unsubscribe = api.onStatusChanged(accept);
    // Off the critical path: the notice is never needed for first paint.
    api.getStatus().then(accept, () => undefined);
    return unsubscribe;
  }, [local, accept]);

  // The folder stays local: main's status carries codes only (CAN-7917).
  useEffect(() => {
    if (!local || !dataFolderShared || dataFolder !== undefined)
      return undefined;
    let current = true;
    window.api.loadPreferences().then(
      (preferences) => {
        if (current) setDataFolder(preferences.__dataDir?.path);
      },
      () => undefined,
    );
    return (): void => {
      current = false;
    };
  }, [local, dataFolderShared, dataFolder]);

  return useMemo(
    () =>
      local && status
        ? {
            status,
            repairCommand: backgroundServiceRepairCommand(
              formatBrandText('{cli}'),
            ),
            ...(dataFolder !== undefined && { dataFolder }),
            onRetry: async (): Promise<void> => {
              const next = await getApi()?.retry();
              if (next) accept(next);
            },
            onRestart: restartLocalApp,
          }
        : undefined,
    [local, status, dataFolder, accept],
  );
}

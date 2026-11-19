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
 * This computer's background service status for the shared notice
 * (CAN-5541, CAN-7061), with Try again and Restart app. Never calls the
 * blocked channels in a window that shows another computer: `local` false
 * returns nothing.
 */
export function useLocalBackgroundServiceNotice(
  local: boolean,
): Omit<BackgroundServiceNoticeProps, 'recovery'> | undefined {
  const [status, setStatus] = useState<BackgroundServiceStatus | null>(null);

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

  return useMemo(
    () =>
      local && status
        ? {
            status,
            repairCommand: backgroundServiceRepairCommand(
              formatBrandText('{cli}'),
            ),
            onRetry: async (): Promise<void> => {
              const next = await getApi()?.retry();
              if (next) accept(next);
            },
            onRestart: (): Promise<boolean> => window.api.restartApp(),
          }
        : undefined,
    [local, status, accept],
  );
}

import { useEffect, useState } from 'react';
import type { AutoDeleteAttention } from '@canopy/protocol/portal/auto-delete-attention';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';

export function useDesktopAutoDeleteAttention(): readonly AutoDeleteAttention[] {
  const [attention, setAttention] = useState<AutoDeleteAttention[]>([]);
  useEffect(() => {
    let live = true;
    const changed = new Map<string, readonly AutoDeleteAttention[]>();
    const unsubscribe = window.api.workEntryAutoDelete.onChanged((snapshot) => {
      if (!live) return;
      changed.set(snapshot.workspaceId, snapshot.attention ?? []);
      setAttention((current) => [
        ...current.filter((row) => row.workspaceId !== snapshot.workspaceId),
        ...(snapshot.attention ?? []),
      ]);
    });
    void window.api.workEntryAutoDelete
      .list()
      .then((snapshots) => {
        if (!live) return;
        for (const snapshot of snapshots)
          if (!changed.has(snapshot.workspaceId))
            changed.set(snapshot.workspaceId, snapshot.attention ?? []);
        setAttention([...changed.values()].flat());
      })
      .catch((error: unknown) => {
        reportClientAppError(error);
      });
    return (): void => {
      live = false;
      unsubscribe();
    };
  }, []);
  return attention;
}

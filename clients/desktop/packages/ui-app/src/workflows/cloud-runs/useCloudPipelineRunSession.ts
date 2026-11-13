'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createCloudPipelineRunSession,
  type CloudPipelineRunSession,
  type CloudRunControlKeys,
} from '@canopy/app-state/cloud-pipeline-runs';
import type { CoreCoworkInvoker } from '@canopy/app-state/core-cowork';
import type { WorkerPipelineExecutionView } from '@canopy/protocol/canopy-core';

/**
 * One cloud run's live session while the caller is mounted: opened on mount,
 * closed on unmount or when the run changes. Null until the first effect
 * runs, so a remount (React's strict mode included) never reuses a closed
 * session.
 */
export function useCloudPipelineRunSession(
  invoker: CoreCoworkInvoker,
  executionId: string,
  onView?: (view: WorkerPipelineExecutionView) => void,
  /** The host's control keys, shared with its other sessions. */
  controlKeys?: CloudRunControlKeys,
): CloudPipelineRunSession | null {
  const [session, setSession] = useState<CloudPipelineRunSession | null>(null);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  useEffect(() => {
    const opened = createCloudPipelineRunSession({
      invoker,
      executionId,
      onView: (view) => onViewRef.current?.(view),
      ...(controlKeys === undefined ? {} : { controlKeys }),
    });
    opened.open();
    setSession(opened);
    return (): void => {
      opened.close();
      setSession((current) => (current === opened ? null : current));
    };
  }, [controlKeys, executionId, invoker]);
  return session;
}

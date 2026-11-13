import { useEffect, useState } from 'react';
import type { CanopyCapabilities } from '@canopy/app-core';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { PipelineData } from '@canopy/execution-engine/types/pipeline';
import {
  CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
  CANOPY_CLOUD_SERVER_ID,
} from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  PIPELINE_RUN_CONTEXT_COPY,
  type PipelineRunOn,
} from '@canopy/ui-app/workflows';

/**
 * The Run dialog's "Run on" choice (CAN-6187): where the CAN-6085 axis comes
 * from on desktop, and the last choice per workflow.
 */

const STORAGE_KEY = 'canopy:workflows:run-on';
/** The most workflows whose last choice is kept; the oldest go first. */
const MAX_REMEMBERED = 200;

function readChoices(): [string, PipelineRunOn][] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? '[]',
    );
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): [string, PipelineRunOn][] =>
      Array.isArray(entry) &&
      typeof entry[0] === 'string' &&
      (entry[1] === 'local' || entry[1] === 'cloud')
        ? [[entry[0], entry[1]]]
        : [],
    );
  } catch (error) {
    // Corrupt or unavailable storage reads as no remembered choice.
    reportClientAppError(error);
    return [];
  }
}

/** The last "Run on" choice for this workflow, or null when there is none. */
export function loadPipelineRunOn(pipelineId: string): PipelineRunOn | null {
  return readChoices().find(([id]) => id === pipelineId)?.[1] ?? null;
}

export function savePipelineRunOn(
  pipelineId: string,
  runOn: PipelineRunOn,
): void {
  const choices = readChoices().filter(([id]) => id !== pipelineId);
  choices.push([pipelineId, runOn]);
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(choices.slice(-MAX_REMEMBERED)),
    );
  } catch (error) {
    // A full store only forgets the choice.
    reportClientAppError(error);
  }
}

/**
 * The CAN-6085 axis for this computer: main reads its web core manifest
 * through `pipelineCloudRunsFromManifest`. False until it answers, and on
 * any failure.
 */
export function usePipelineCloudRuns(): Pick<
  CanopyCapabilities,
  'pipelineCloudRuns'
> {
  const [pipelineCloudRuns, setPipelineCloudRuns] = useState(false);
  useEffect(() => {
    let live = true;
    let reads = 0;
    const read = (): void => {
      const current = ++reads;
      window.pipelines
        .cloudRunsAvailability()
        .then((answer): void => {
          if (live && current === reads)
            setPipelineCloudRuns(answer.pipelineCloudRuns === true);
        })
        .catch((error: unknown): void => {
          // Main answers false on every failure it knows; Cloud stays hidden.
          reportClientAppError(error);
        });
    };
    read();
    // Another account, or none, may see another manifest (CAN-6326).
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, read);
    return (): void => {
      live = false;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, read);
    };
  }, []);
  return { pipelineCloudRuns };
}

/**
 * Why this workflow can't run in the cloud yet, or undefined. The web core
 * reads shared and curated definitions only (CAN-6169); one that exists only
 * on this computer waits for CP-29.
 */
export function cloudRunSourceUnavailable(
  pipeline: PipelineData,
): string | undefined {
  return cloudRunPipelineId(pipeline) === null
    ? PIPELINE_RUN_CONTEXT_COPY.cloudSourceUnavailable
    : undefined;
}

/**
 * The `pipelineId` a cloud start sends, from which main names the web
 * core's definition: a curated workflow's `curated:<key>`, or the shared
 * workflow's id beside its `sharedPipeline`. Null for any other source.
 */
export function cloudRunPipelineId(pipeline: PipelineData): string | null {
  const { info } = pipeline;
  if (info.source === 'shared')
    return info.serverId === CANOPY_CLOUD_SERVER_ID &&
      info.remoteId !== undefined
      ? info.id
      : null;
  if (info.source !== 'curated') return null;
  if (info.curatedKey !== undefined) return `curated:${info.curatedKey}`;
  return info.id.startsWith('curated:') ? info.id : null;
}

import type { BrowserWindow } from 'electron';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { readPreferencesFile } from '../lib/preferences-store';
import { broadcastPipelineExecutionEvent } from './pipeline-execution-event-broadcaster';
import { resumePipelineExecutionFromMain } from './pipeline-resume-service';
import {
  listPipelineExecutionControls,
  listPipelineExecutionInitiatedRuns,
} from './pipeline-worker-dispatch';
import {
  listPausedPipelineExecutions,
  readStoredPipelineExecution,
} from './pipeline-worker-host';

/**
 * Start the runtime's automatic transient retries with the desktop's ports
 * (CAN-4175). Main calls this once the runtime exists and before it
 * registers the IPC handlers.
 */
export function startPipelineTransientRetries(
  runtime: Pick<DesktopCanopyDispatcher, 'pipelineTransientRetries'>,
  getWindow: () => BrowserWindow | null,
): void {
  runtime.pipelineTransientRetries.start({
    emitEvent: broadcastPipelineExecutionEvent,
    resume: resumePipelineExecutionFromMain,
    readPreferences: readPreferencesFile,
    listRetryRuns: listPipelineExecutionInitiatedRuns,
    listExecutionControls: listPipelineExecutionControls,
    readExecution: readStoredPipelineExecution,
    listPausedExecutions: listPausedPipelineExecutions,
    getWindow,
  });
}

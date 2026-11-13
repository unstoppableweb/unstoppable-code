import type { PipelineReadPort } from '@canopy/desktop-shared/lib/automation-share/port';

/** The window's preload APIs, read when a workflow is read. */
export function rendererPipelineReadPort(): PipelineReadPort {
  return { pipelines: window.pipelines, api: window.api };
}

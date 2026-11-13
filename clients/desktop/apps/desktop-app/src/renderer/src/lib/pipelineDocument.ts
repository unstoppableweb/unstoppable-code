import * as shared from '@canopy/desktop-shared/lib/automation-share/pipeline-document';
import type { AfterReadPort } from '@canopy/desktop-shared/lib/automation-share/port';
import { rendererPipelineReadPort } from './pipelineReadPort';

// Reading a workflow lives in desktop-shared so Electron main reads the same
// way when App Advisor shares an automation (CAN-6003); the window binds its
// own preload APIs.
export {
  hashPipelineDocumentYaml,
  pipelineInfoToDocumentLocator,
  projectPipelineRelativePath,
  serializePipelineDocument,
  sharedDetailToPipelineData,
  sharedDetailToPipelineInfo,
  type AutomationPipelineDocumentResult,
  type AutomationPipelineWorktree,
  type PipelineDocumentLocator,
  type PipelineDocumentResult,
  type StoredPipelineSource,
} from '@canopy/desktop-shared/lib/automation-share/pipeline-document';

export function loadAutomationPipelineDocument(
  ...args: AfterReadPort<
    Parameters<typeof shared.loadAutomationPipelineDocument>
  >
): ReturnType<typeof shared.loadAutomationPipelineDocument> {
  return shared.loadAutomationPipelineDocument(
    rendererPipelineReadPort(),
    ...args,
  );
}

export function loadPipelineShareTargetDocument(
  ...args: AfterReadPort<
    Parameters<typeof shared.loadPipelineShareTargetDocument>
  >
): ReturnType<typeof shared.loadPipelineShareTargetDocument> {
  return shared.loadPipelineShareTargetDocument(
    rendererPipelineReadPort(),
    ...args,
  );
}

export function loadPipelineDocument(
  ...args: AfterReadPort<Parameters<typeof shared.loadPipelineDocument>>
): ReturnType<typeof shared.loadPipelineDocument> {
  return shared.loadPipelineDocument(rendererPipelineReadPort(), ...args);
}

export function fetchPipelineDocument(
  ...args: AfterReadPort<Parameters<typeof shared.fetchPipelineDocument>>
): ReturnType<typeof shared.fetchPipelineDocument> {
  return shared.fetchPipelineDocument(rendererPipelineReadPort(), ...args);
}

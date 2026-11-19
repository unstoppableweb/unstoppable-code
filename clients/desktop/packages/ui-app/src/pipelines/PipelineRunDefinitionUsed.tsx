'use client';

import type { JSX } from 'react';
import type { RemoteControlPipelineDefinitionViewModel } from '@canopy/protocol/remote-control/shell';
import { PipelineReadDetail } from './PipelineReadDetail';
import { Surface } from '@canopy/ui-shared/components';

export interface PipelineRunDefinitionUsedProps {
  /**
   * The definition the run started with, from its recorded snapshot. `null`
   * when the run recorded none.
   */
  definition: RemoteControlPipelineDefinitionViewModel | null;
}

/**
 * A pipeline run's "Definition used" entry (CAN-4072): the recorded
 * definition, read-only, so a run can be compared with the pipeline as it is
 * now. Hosts convert their own snapshot to the portal view model.
 */
export function PipelineRunDefinitionUsed({
  definition,
}: PipelineRunDefinitionUsedProps): JSX.Element {
  return (
    <section
      aria-label="Definition used"
      data-testid="pipeline-run-definition-used"
    >
      {definition === null ? (
        <Surface variant="inset">
          <p
            className="px-4 py-6 text-center text-s fg-secondary"
            data-testid="pipeline-run-definition-used-not-recorded"
          >
            Not recorded
          </p>
        </Surface>
      ) : (
        <PipelineReadDetail definition={definition} flushTop />
      )}
    </section>
  );
}

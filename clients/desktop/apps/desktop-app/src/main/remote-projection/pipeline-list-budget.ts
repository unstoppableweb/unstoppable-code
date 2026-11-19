import type { RemoteControlPipelineListResult } from '@canopy/protocol/remote-control/shell';
import { fitListResult } from './result-budget';

/**
 * Prefix-cut a pipeline list to the portal catalog budget. Shared with the
 * cloud inventory sync (CAN-2830) so a synced document is byte-for-byte what
 * the live `portal.pipeline.list` command would have returned.
 */
export function fitPipelineListResult(
  pipelines: RemoteControlPipelineListResult['pipelines'],
  options: {
    /**
     * The list is already known to be incomplete (a discovery bound cut
     * it): the marker is part of the sized result, so forcing it can never
     * push a fitted payload past the budget.
     */
    truncated?: boolean;
  } = {},
): RemoteControlPipelineListResult {
  return fitListResult(
    pipelines,
    (rows, truncated): RemoteControlPipelineListResult => ({
      pipelines: rows,
      ...(truncated ? { truncated: true } : {}),
    }),
    options.truncated,
  );
}

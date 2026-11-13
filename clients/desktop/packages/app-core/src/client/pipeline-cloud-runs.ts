import type { CoreRuntimeManifestOperation } from '@canopy/protocol/canopy-core';
// The narrow subpath: the canopy-core barrel loads every protocol module,
// which shared UI importing @canopy/app-core must not pull in.
import { CORE_PIPELINE_CLOUD_RUN_OPERATIONS } from '@canopy/protocol/canopy-core/core/pipeline/cloud-runs';
import type { CanopyCapabilities } from './capabilities';

/**
 * `pipelineCloudRuns` from a web core manifest: true only when it reports
 * every cloud pipeline run operation available. An empty group is never
 * available.
 */
export function pipelineCloudRunsFromManifest(
  operations: readonly Pick<
    CoreRuntimeManifestOperation,
    'name' | 'available'
  >[],
): Pick<CanopyCapabilities, 'pipelineCloudRuns'> {
  const group: readonly string[] = CORE_PIPELINE_CLOUD_RUN_OPERATIONS;
  const available = new Set(
    operations
      .filter((operation) => operation.available)
      .map(({ name }) => name),
  );
  return {
    pipelineCloudRuns:
      group.length > 0 && group.every((name) => available.has(name)),
  };
}

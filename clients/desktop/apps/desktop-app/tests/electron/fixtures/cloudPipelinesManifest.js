import { CORE_PIPELINE_CLOUD_RUN_OPERATIONS } from '../../../src/main/canopy-runtime/renderer-relay/__tests__/web-core-wire.ts';

/**
 * The cloud run operations the fake web core for cloud workflow runs reports
 * (CAN-6187, CAN-6344): the protocol's own group, so the desktop sees cloud
 * runs available exactly when the real web core would, and a change to the
 * group can't leave the fake behind. It comes through `web-core-wire.ts`, as
 * the cloud chat fixture's protocol does, so both load it the same way
 * (CAN-6351).
 */
export const CLOUD_RUN_OPERATIONS = CORE_PIPELINE_CLOUD_RUN_OPERATIONS;

const kindOf = (name) =>
  name.endsWith('.events')
    ? 'stream'
    : /\.(get|list|read)$/.test(name)
      ? 'query'
      : 'instruction';

/**
 * The group's `core.runtime.manifest.get` rows; none while cloud runs are
 * off, as the web core leaves them out behind its rollout flag.
 */
export function cloudRunManifestOperations(available) {
  if (!available) return [];
  return CLOUD_RUN_OPERATIONS.map((name) => ({
    name,
    kind: kindOf(name),
    version: 1,
    placement: 'target-selectable',
    requiredGrants: [
      kindOf(name) === 'instruction'
        ? 'core.pipeline.write'
        : 'core.pipeline.read',
    ],
    available: true,
  }));
}

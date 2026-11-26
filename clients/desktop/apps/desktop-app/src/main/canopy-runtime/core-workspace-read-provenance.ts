import type { CoreWorkspaceReadProvenance as SharedReadProvenance } from '@canopy/core-runtime/node/workspace/core-workspace-read-provenance';
import type { W5ReadViewUncapturedReason } from '../lib/w5-read-view';

/*
 * Compatibility exports: the read provenance (CAN-5318) moved to
 * core-runtime beside the shared projection (CAN-7732). Electron main's
 * provenance names its read view's uncaptured reasons.
 */

export {
  coreWorkspaceResourceKey,
  type CoreWorkspaceReadFilter,
} from '@canopy/core-runtime/node/workspace/core-workspace-projection';
export { publishableRevisions } from '@canopy/core-runtime/node/workspace/core-workspace-read-provenance';

export type CoreWorkspaceReadProvenance =
  SharedReadProvenance<W5ReadViewUncapturedReason>;

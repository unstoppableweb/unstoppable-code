/** Reviewed telemetry vocabulary, not the operational code registry.
 * Git: canopy-core/worker/{git,git-changes,git-branch-writes}.ts error schemas.
 * Delegation: core-runtime/src/node/operations/local-worker.ts.
 * Chat: core-runtime/src/node/agent/turns/core-chat-turn-runs.ts.
 * Agent: canopy-core/worker/agent-turns.ts.
 * Keep literals here to avoid loading the operation registry in preload.
 * Other domains and dynamically constructed codes are intentionally omitted
 * until reviewed; their valid status still reaches telemetry.
 */
export const APP_ERROR_OPERATION_CODES: ReadonlySet<string> = new Set([
  'core.chat.turnRunActive',
  'core.delegation.notStarted',
  'core.delegation.outcomeUnknown',
  'worker.agent.turnFailed',
  'worker.git.branch.callerRefused',
  'worker.git.branch.checkedOut',
  'worker.git.branch.headChanged',
  'worker.git.branch.invalidName',
  'worker.git.branch.invalidScope',
  'worker.git.branch.invalidStartPoint',
  'worker.git.branch.nameUnavailable',
  'worker.git.branch.repositoryUnavailable',
  'worker.git.branch.scopeUnsupported',
  'worker.git.branch.uncommittedChanges',
  'worker.git.checkout.branchNotFound',
  'worker.git.checkout.branchOccupied',
  'worker.git.checkout.callerRefused',
  'worker.git.checkout.headChanged',
  'worker.git.checkout.invalidScope',
  'worker.git.checkout.scopeUnsupported',
  'worker.git.checkout.uncommittedChanges',
  'worker.git.diff.invalidRange',
  'worker.git.diff.invalidScope',
  'worker.git.diff.invalidState',
  'worker.git.diff.notFound',
  'worker.git.diff.revisionConflict',
  'worker.git.diff.scopeUnsupported',
  'worker.git.remote.invalidScope',
  'worker.git.remote.notRepository',
  'worker.git.remote.repositoryUnavailable',
  'worker.git.status.invalidState',
  'worker.git.status.notFound',
  'worker.git.status.revisionConflict',
]);

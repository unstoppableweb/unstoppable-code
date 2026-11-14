import { BRAND } from '@canopy/brand/current';
import type { AgentDelegationResult } from '@canopy/protocol/delegation';

/** Compatibility only: never add these names to a live tool list. */
export function isWatchDelegatesCompatibilityName(
  name: string,
  harness:
    | 'claude'
    | 'codex'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode',
): boolean {
  // All transports may carry the bare display name in retained calls.
  void harness;
  const namespaces = [BRAND.tools.namespace, ['cano', 'py'].join('')];
  return (
    name === 'WatchDelegates' ||
    namespaces.some(
      (namespace) =>
        name === `mcp__${namespace}__WatchDelegates` ||
        name === `${namespace}_watch_delegates`,
    )
  );
}

/** The phase 02 response, without a watcher, delegate lookup or broker call. */
export function watchDelegatesCompatibilityResult(
  input: unknown,
): AgentDelegationResult<{
  readonly watcherId: 'delegation-notices-automatic';
  readonly mode: 'any' | 'all';
  readonly deadlineAt: 0;
  readonly targets: readonly [];
  readonly message: string;
}> {
  const mode =
    typeof input === 'object' &&
    input !== null &&
    'mode' in input &&
    input.mode === 'all'
      ? 'all'
      : 'any';
  return {
    ok: true,
    value: {
      watcherId: 'delegation-notices-automatic',
      mode,
      deadlineAt: 0,
      targets: [],
      message:
        'Delegate completion notices now arrive automatically; no watch is needed.',
    },
  };
}

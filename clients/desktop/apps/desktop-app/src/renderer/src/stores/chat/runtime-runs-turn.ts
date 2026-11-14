import type { ChatRuntimeState } from '@canopy/desktop-shared/types';

const ACTIVE_RUNTIME_STATUSES: ReadonlySet<ChatRuntimeState['status']> =
  new Set<ChatRuntimeState['status']>([
    'starting',
    'streaming',
    'completing',
    'awaiting_input',
  ]);

/**
 * Whether one chat's canonical runtime holds a running turn. Kept free of
 * imports so the web core backend can read the store's runtime without a
 * cycle through the backend registry.
 */
export function runtimeRunsTurn(
  runtime: ChatRuntimeState | undefined,
): boolean {
  return runtime !== undefined && ACTIVE_RUNTIME_STATUSES.has(runtime.status);
}

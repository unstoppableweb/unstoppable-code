import type { JSX } from 'react';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

/**
 * Body of the Delete agent confirmation. The model ID is derived from the
 * agent's name, so it is masked from session replay even if the user cancels.
 */
export function DeleteAgentMessage({
  modelId,
}: {
  modelId: string;
}): JSX.Element {
  return (
    <>
      Existing chats and workflows that use{' '}
      <span className={POSTHOG_REPLAY_MASK_CLASS}>{modelId}</span> will fail
      until another model is selected.
    </>
  );
}

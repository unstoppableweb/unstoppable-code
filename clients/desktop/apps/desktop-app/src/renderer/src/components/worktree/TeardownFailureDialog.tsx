import { CodeBlock } from '@canopy/ui-shared/primitives/CodeBlock';
import { Stack, Button, Surface } from '@canopy/ui-shared/components';
import { type JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DialogModal } from '../shared';
import type { TeardownFailedError } from '@/stores/projectsStore';

interface TeardownFailureDialogProps {
  error: TeardownFailedError;
  onRetry: () => void;
  /** Skips the teardown script and runs the ordinary archive or delete. */
  onSkipTeardown: () => void;
  onCancel: () => void;
  isRetrying?: boolean;
}

export function TeardownFailureDialog({
  error,
  onRetry,
  onSkipTeardown,
  onCancel,
  isRetrying,
}: TeardownFailureDialogProps): JSX.Element {
  return (
    <DialogModal
      onClose={onCancel}
      title="Teardown failed"
      titleId="teardown-failure-title"
      maxWidth="lg"
    >
      <Stack gap="group">
        {error.repoName && (
          <p className="text-s fg-primary">
            Teardown script failed for repo{' '}
            <span className="font-medium">{error.repoName}</span>.
          </p>
        )}
        {!error.repoName && (
          <p className="text-s fg-primary">Teardown script failed.</p>
        )}
        {error.timedOut && (
          <p className="text-s fg-warning">
            The script timed out and was terminated.
          </p>
        )}
        {error.output.trim() && (
          <Surface variant="group" size="small" className="overflow-hidden">
            <div
              className={`max-h-48 overflow-auto p-3 ${POSTHOG_REPLAY_BLOCK_CLASS}`}
            >
              <CodeBlock
                variant="bare"
                size="xs"
                wrap="words"
                tone="secondary"
                replay="block"
                overflow="visible"
              >
                {error.output}
              </CodeBlock>
            </div>
          </Surface>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button size="compact" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="ghost-destructive"
            size="compact"
            onClick={onSkipTeardown}
          >
            {error.lockAfterArchive === true
              ? 'Archive without teardown'
              : 'Delete without teardown'}
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={onRetry}
            disabled={isRetrying}
          >
            {isRetrying ? 'Trying again…' : 'Try again'}
          </Button>
        </div>
      </Stack>
    </DialogModal>
  );
}

import { type JSX } from 'react';
import { formatByteSize } from '@canopy/ui-shared/lib';
import { Button } from '@/components/shared/Button';
import { DialogModal } from '@/components/shared/DialogModal';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { brandText } from '@/lib/brand';
import { shareSessionAction } from '@/lib/shareSessionAction';
import { useShareSessionStatusStore } from '@/stores/shareSessionStatusStore';
import { Stack, ErrorBanner } from '@canopy/ui-shared/components';

export function ShareSessionStatusModal(): JSX.Element | null {
  const target = useShareSessionStatusStore((state) => state.target);
  const ownerDocument = useShareSessionStatusStore(
    (state) => state.ownerDocument,
  );
  const status = useShareSessionStatusStore((state) => state.status);
  const close = useShareSessionStatusStore((state) => state.close);
  useCurrentUiStateReporter(
    'chat.shareSessionStatusModal',
    target && status ? { open: true, phase: status.phase } : null,
  );
  if (!target || !status) return null;

  const sharing = status.phase === 'sharing';
  return (
    <DialogModal
      title="Export session"
      ownerDocument={ownerDocument ?? undefined}
      onClose={sharing ? (): void => {} : close}
      closeOnBackdrop={!sharing}
      maxWidth="md"
      dataTestId="share-session-status-modal"
    >
      <Stack gap="group">
        {status.phase === 'sharing' && (
          <div
            className="flex items-center gap-3"
            data-testid="share-session-status-sharing"
          >
            <LoadingSpinner />
            <Stack gap="tight">
              <p className="text-s font-medium fg-primary">
                Uploading a secure session snapshot…
              </p>
              <p className="text-xs fg-secondary">
                Keep {brandText.appName} open until the upload finishes.
              </p>
            </Stack>
          </div>
        )}

        {status.phase === 'success' && (
          <Stack gap="group" data-testid="share-session-status-success">
            <Stack gap="item">
              <Stack gap="tight">
                <p className="text-s font-medium fg-primary">
                  Session snapshot exported
                </p>
                <p className="text-xs fg-secondary">
                  It is now available from <strong>Import session…</strong> in a
                  compatible project signed in to this {brandText.appName} Cloud
                  account. This private export does not create a public link.
                </p>
              </Stack>
              <p className="truncate text-xs fg-secondary">
                {status.response.title} ·{' '}
                {formatByteSize(status.response.sizeBytes)}
              </p>
            </Stack>
            {status.response.warnings.length > 0 && (
              <ul
                className="flex flex-col list-disc rounded-lg border border-line-attention/30 bg-warning-subtle px-7 py-2 text-xs fg-secondary gap-1"
                data-testid="share-session-status-warnings"
              >
                {status.response.warnings.map((warning, index) => (
                  <li key={`${index}:${warning}`}>{warning}</li>
                ))}
              </ul>
            )}
          </Stack>
        )}

        {status.phase === 'error' && (
          <ErrorBanner
            errorSource="share-session-status-error"
            className=""
            testId="share-session-status-error"
            error={`Couldn’t export this session. ${status.message}`}
          />
        )}

        {!sharing && (
          <div className="flex justify-end gap-2 border-t pt-4">
            {status.phase === 'error' && (
              <Button variant="outline" size="lg" onClick={close}>
                Close
              </Button>
            )}
            {status.phase === 'error' && (
              <Button
                variant="primary"
                size="lg"
                onClick={(): void => {
                  void shareSessionAction(target, {
                    ownerDocument: ownerDocument ?? undefined,
                  });
                }}
              >
                Try again
              </Button>
            )}
            {status.phase === 'success' && (
              <Button variant="primary" size="lg" onClick={close}>
                Done
              </Button>
            )}
          </div>
        )}
      </Stack>
    </DialogModal>
  );
}

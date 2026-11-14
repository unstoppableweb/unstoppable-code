'use client';

import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type {
  MarketplaceSourcesClient,
  MarketplaceSourceAddCompletion,
} from '@canopy/app-core/client';
import { useMarketplaceSourceAdd } from '@canopy/app-state';
import {
  Button,
  DialogFormField,
  DialogModal,
  TextInput,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { MarketplaceSourceAddPreview } from './MarketplaceSourceAddPreview';

const ADD_SOURCE_LEAD = 'Add a Claude or Codex marketplace.';
export interface MarketplaceSourceAddDialogProps {
  readonly client: MarketplaceSourcesClient;
  readonly initialInput?: string;
  readonly dataTestId?: string;
  readonly onClose: () => void;
  readonly onComplete: (
    result: MarketplaceSourceAddCompletion,
    isCurrent: () => boolean,
  ) => void | Promise<void>;
}

export function MarketplaceSourceAddDialog({
  client,
  initialInput = '',
  dataTestId = 'marketplace-source-add-dialog',
  onClose,
  onComplete,
}: MarketplaceSourceAddDialogProps): JSX.Element | null {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const repoInputId = useId();
  const closing = useRef(false);
  const [repoInput, setRepoInput] = useState(initialInput);
  const binding = useMarketplaceSourceAdd(client, onComplete);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const boundPhase = binding?.snapshot.phase;
  // A session the host invalidated (an account or client change) closes
  // itself; tell the host so its open state does not outlive the dialog.
  useEffect(() => {
    if (boundPhase !== 'closed' || closing.current) return;
    closing.current = true;
    onCloseRef.current();
  }, [boundPhase]);
  if (!binding) return null;
  const { session, snapshot } = binding;
  const phase = snapshot.phase;
  if (phase === 'closed') return null;
  const review = 'review' in snapshot ? snapshot.review : null;
  const busy =
    phase === 'registering' ||
    phase === 'previewing' ||
    phase === 'confirming' ||
    phase === 'reconciling' ||
    phase === 'cancelling' ||
    phase === 'complete';
  const valid = session.validate(repoInput) === null;
  const validationError =
    repoInput.trim() !== '' && !valid ? session.validate(repoInput) : null;
  const visibleError =
    binding.completionWarning ??
    validationError ??
    ('error' in snapshot ? snapshot.error : null);
  const previewHasNoUsablePlugins =
    review !== null && review.pluginsReported && !review.canConfirm;
  const close = (): void => {
    if (closing.current) return;
    closing.current = true;
    void session.cancel().catch(() => undefined);
    onClose();
  };
  return (
    <DialogModal
      onClose={close}
      title="Add marketplace"
      maxWidth={session.mode === 'direct' ? 'md' : 'lg'}
      headerBorder={false}
      dataTestId={dataTestId}
      trapFocus
      initialFocusRef={inputRef}
    >
      <div className="flex flex-col gap-4">
        {phase === 'complete' && !binding.completionWarning && (
          <p role="status" className="text-s fg-secondary">
            Marketplace added. Refreshing the list…
          </p>
        )}
        {phase !== 'complete' && (
          <>
            <p className="text-xs fg-secondary">
              {/* One lead sentence on every host; the rest names what this
                  client supports (capability-gated, CAN-4267). */}
              {session.mode === 'revision-review'
                ? `${ADD_SOURCE_LEAD} You can also use a skills repository or a skills.sh link. Preview the contents, then confirm the revision.`
                : `${ADD_SOURCE_LEAD} The repository is checked for Claude and Codex plugins when you add it.`}
            </p>
            <DialogFormField
              label={
                session.inputKind === 'github-or-skills'
                  ? 'Repository or skills.sh URL'
                  : 'Repository'
              }
              htmlFor={repoInputId}
            >
              <TextInput
                ref={inputRef}
                id={repoInputId}
                type="text"
                value={repoInput}
                disabled={review !== null || busy}
                onChange={(event) => setRepoInput(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    valid &&
                    review === null &&
                    !busy
                  ) {
                    void session.submit(repoInput);
                  }
                }}
                placeholder="owner/repo or https://github.com/owner/repo"
                data-testid="cloud-marketplace-add-input"
              />
            </DialogFormField>
          </>
        )}

        {visibleError && (
          <ErrorBanner
            errorSource="cloud-marketplace-add-error"
            className=""
            error={visibleError}
            blockMessageFromReplay
            testId="cloud-marketplace-add-error"
          />
        )}

        {review !== null && phase !== 'complete' && (
          <MarketplaceSourceAddPreview review={review} />
        )}

        <div className="flex items-center justify-end gap-2">
          {review &&
            review.pluginsReported &&
            !review.canConfirm &&
            phase === 'review' && (
              <Button
                type="button"
                size="compact"
                onClick={() => void session.retryPreview()}
                data-testid="cloud-marketplace-preview-retry"
              >
                Try again
              </Button>
            )}
          {phase !== 'complete' && (
            <>
              {phase === 'uncertain' || phase === 'reconciling' ? (
                <Button
                  type="button"
                  size="compact"
                  disabled={busy}
                  onClick={() => void session.retryReconciliation()}
                  data-testid="marketplace-add-reconcile"
                >
                  Check again
                </Button>
              ) : review === null ? (
                <Button
                  type="button"
                  variant="primary"
                  size="compact"
                  onClick={() => void session.submit(repoInput)}
                  disabled={!valid || busy}
                  data-testid="cloud-marketplace-add-submit"
                >
                  {phase === 'registering'
                    ? 'Registering…'
                    : session.mode === 'direct'
                      ? 'Add'
                      : 'Continue'}
                </Button>
              ) : !review.canConfirm && !review.pluginsReported ? (
                <Button
                  type="button"
                  size="compact"
                  onClick={() => void session.retryPreview()}
                  disabled={busy}
                  data-testid="cloud-marketplace-preview-retry"
                >
                  {phase === 'previewing' ? 'Previewing…' : 'Try again'}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  size="compact"
                  onClick={() => void session.confirm()}
                  disabled={busy || previewHasNoUsablePlugins}
                  data-testid="cloud-marketplace-confirm"
                >
                  {phase === 'previewing'
                    ? 'Previewing…'
                    : phase === 'confirming'
                      ? 'Confirming…'
                      : 'Confirm'}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </DialogModal>
  );
}

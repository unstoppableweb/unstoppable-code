'use client';

import { useId, useRef, useState, type JSX } from 'react';
import {
  isSharedArtifactsClientError,
  type SharedArtifactsClient,
} from '@canopy/app-core';
import type { SharedArtifact } from '@canopy/protocol/canopy-core';
import {
  Button,
  ConfirmDialog,
  ErrorBanner,
  Stack,
} from '@canopy/ui-shared/components';
import { Notice, ToggleSwitch } from '@canopy/ui-shared/primitives';
import { MakeArtifactPublicConfirmDialog } from './MakeArtifactPublicConfirmDialog';
import { SHARED_ARTIFACT_COPY } from './shared-artifact-copy';
import {
  isSharedArtifactPublicLinkPaused,
  newSharedArtifactIdempotencyKey,
} from './shared-artifact-view-model';

/** Whether a mutation failure means the loaded DTO is stale. */
export function sharedArtifactFailureNeedsReload(error: unknown): boolean {
  if (!isSharedArtifactsClientError(error)) return false;
  return (
    error.kind === 'not_found' ||
    error.code === 'core.sharedArtifact.takenDown' ||
    error.code === 'core.sharedArtifact.publicSharingDisabled'
  );
}

function publicFailureCopy(error: unknown): string {
  if (isSharedArtifactsClientError(error)) {
    if (error.code === 'core.sharedArtifact.publicSharingDisabled')
      return SHARED_ARTIFACT_COPY.publicSharingDisabled;
    if (error.code === 'core.sharedArtifact.takenDown')
      return SHARED_ARTIFACT_COPY.takenDownFailure;
    if (error.code === 'core.sharedArtifact.quotaExceeded')
      return SHARED_ARTIFACT_COPY.quotaExceeded;
  }
  return SHARED_ARTIFACT_COPY.publicLinkFailed;
}

/**
 * The public link control (CAN-8017). Rendered in the share dialog's
 * always-visible slot, so a personal account with no organization reaches
 * it. Follows `permissions.canSetPublic` and `publicSharingAllowed`; a
 * paused link can still be turned off. Off to on asks first; on to off is
 * immediate (the URL is stable, so it's reversible).
 *
 * With `offerUnshare`, also offers Stop sharing: a private artifact with a
 * public link has no `existingShare`, so the dialog's own footer action is
 * absent for it.
 */
export function SharedArtifactPublicLinkSection({
  artifact,
  client,
  offerUnshare,
  onArtifact,
  onReload,
  onUnshared,
}: {
  readonly artifact: SharedArtifact;
  readonly client: SharedArtifactsClient;
  readonly offerUnshare: boolean;
  readonly onArtifact: (artifact: SharedArtifact) => void;
  readonly onReload: () => void;
  readonly onUnshared: () => void;
}): JSX.Element | null {
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingUnshare, setConfirmingUnshare] = useState(false);
  const [unsharing, setUnsharing] = useState(false);
  const [unshareError, setUnshareError] = useState<string | null>(null);
  const keyRef = useRef<{ input: boolean; key: string } | null>(null);
  const unshareKeyRef = useRef<string | null>(null);
  const descriptionId = useId();

  const { permissions } = artifact;
  const enabled = artifact.public.enabled;
  const paused = isSharedArtifactPublicLinkPaused(artifact);
  const canTurnOn = artifact.publicSharingAllowed;
  const showSwitch = permissions.canSetPublic;
  const showUnshare = offerUnshare && permissions.canUnshare;
  if (!showSwitch && !showUnshare) return null;

  const setPublic = async (next: boolean): Promise<boolean> => {
    if (pending) return false;
    if (keyRef.current?.input !== next)
      keyRef.current = { input: next, key: newSharedArtifactIdempotencyKey() };
    setPending(true);
    setError(null);
    try {
      const updated = await client.setPublic({
        artifactId: artifact.id,
        public: next,
        idempotencyKey: keyRef.current.key,
      });
      keyRef.current = null;
      onArtifact(updated);
      return true;
    } catch (failure) {
      if (sharedArtifactFailureNeedsReload(failure)) {
        keyRef.current = null;
        onReload();
      }
      const message = publicFailureCopy(failure);
      if (next) setConfirmError(message);
      else setError(message);
      return false;
    } finally {
      setPending(false);
    }
  };

  const unshare = async (): Promise<void> => {
    unshareKeyRef.current ??= newSharedArtifactIdempotencyKey();
    setUnsharing(true);
    setUnshareError(null);
    try {
      await client.unshare({
        artifactId: artifact.id,
        idempotencyKey: unshareKeyRef.current,
      });
      unshareKeyRef.current = null;
      setConfirmingUnshare(false);
      onUnshared();
    } catch (failure) {
      if (sharedArtifactFailureNeedsReload(failure)) {
        unshareKeyRef.current = null;
        setConfirmingUnshare(false);
        onReload();
        return;
      }
      setUnshareError(SHARED_ARTIFACT_COPY.stopSharingFailed);
    } finally {
      setUnsharing(false);
    }
  };

  return (
    <Stack gap="item" data-testid="shared-artifact-public-link">
      {showSwitch && (
        <Stack gap="tight">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-s font-medium fg-primary">
                {SHARED_ARTIFACT_COPY.publicLinkLabel}
              </p>
              <p id={descriptionId} className="text-xs fg-tertiary">
                {!canTurnOn && !enabled
                  ? SHARED_ARTIFACT_COPY.publicLinkNotAllowed
                  : SHARED_ARTIFACT_COPY.publicLinkDescription}
              </p>
            </div>
            <ToggleSwitch
              checked={enabled}
              busy={pending}
              disabled={pending || (!enabled && !canTurnOn)}
              label={SHARED_ARTIFACT_COPY.publicLinkLabel}
              describedBy={descriptionId}
              dataTestId="shared-artifact-public-switch"
              onChange={(next): void => {
                if (next) {
                  setConfirmError(null);
                  setConfirming(true);
                } else {
                  void setPublic(false);
                }
              }}
            />
          </div>
          {paused && (
            <Notice
              intent="attention"
              data-testid="shared-artifact-public-paused"
            >
              {SHARED_ARTIFACT_COPY.pausedNotice}
            </Notice>
          )}
          {error !== null && (
            <ErrorBanner
              className=""
              errorSource="shared-artifact-set-public"
              blockMessageFromReplay={false}
              error={error}
            />
          )}
        </Stack>
      )}
      {showUnshare && (
        <Button
          type="button"
          variant="destructive"
          size="compact"
          className="self-start"
          disabled={unsharing}
          onClick={(): void => {
            setUnshareError(null);
            setConfirmingUnshare(true);
          }}
          data-testid="shared-artifact-public-unshare"
        >
          {SHARED_ARTIFACT_COPY.stopSharingLabel}
        </Button>
      )}
      {confirming && (
        <MakeArtifactPublicConfirmDialog
          busy={pending}
          errorMessage={confirmError}
          onCancel={(): void => {
            setConfirming(false);
            setConfirmError(null);
            keyRef.current = null;
          }}
          onConfirm={(): void => {
            void setPublic(true).then((ok) => {
              if (ok) setConfirming(false);
            });
          }}
        />
      )}
      {confirmingUnshare && (
        <ConfirmDialog
          title={SHARED_ARTIFACT_COPY.stopSharingTitle}
          message={SHARED_ARTIFACT_COPY.stopSharingBody}
          confirmLabel={SHARED_ARTIFACT_COPY.stopSharingLabel}
          busyLabel={SHARED_ARTIFACT_COPY.stopSharingBusy}
          busy={unsharing}
          errorMessage={unshareError}
          errorSource="shared-artifact-unshare"
          destructive
          onConfirm={(): void => {
            void unshare();
          }}
          onCancel={(): void => {
            setConfirmingUnshare(false);
            setUnshareError(null);
            unshareKeyRef.current = null;
          }}
        />
      )}
    </Stack>
  );
}

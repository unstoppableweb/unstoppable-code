'use client';

import { useCallback, useMemo, useRef, type JSX } from 'react';
import {
  isSharedArtifactsClientError,
  type SharedArtifactsClient,
} from '@canopy/app-core';
import type {
  SharedArtifact,
  SharedArtifactAudienceInput,
} from '@canopy/protocol/canopy-core';
import { sharedArtifactSharePath } from '@canopy/protocol/shared-artifacts';
import {
  ShareResourceDialog,
  type ShareResourceOutcome,
  type ShareResourceScope,
  type ShareResourceShareInput,
  type ShareStopSharing,
} from '../sharing';
import { SHARED_ARTIFACT_COPY } from './shared-artifact-copy';
import type { SharedArtifactShareHost } from './shared-artifacts-host';
import {
  sharedArtifactFailureNeedsReload,
  SharedArtifactPublicLinkSection,
} from './SharedArtifactPublicLinkSection';
import {
  newSharedArtifactIdempotencyKey,
  sharedArtifactExistingShare,
} from './shared-artifact-view-model';

const ARTIFACT_SCOPES: readonly ShareResourceScope[] = ['team', 'organization'];

function audienceInput(
  input: ShareResourceShareInput,
): SharedArtifactAudienceInput | null {
  if (input.scope === 'team' && input.teamId !== undefined)
    return { scope: 'team', teamId: input.teamId };
  if (input.scope === 'organization' && input.organizationId !== undefined)
    return { scope: 'organization', organizationId: input.organizationId };
  return null;
}

function shareFailureCopy(error: unknown): string {
  if (isSharedArtifactsClientError(error)) {
    if (error.code === 'core.sharedArtifact.quotaExceeded')
      return SHARED_ARTIFACT_COPY.quotaExceeded;
    if (error.code === 'core.sharedArtifact.takenDown')
      return SHARED_ARTIFACT_COPY.takenDownFailure;
    if (error.code === 'core.sharedArtifact.publicSharingDisabled')
      return SHARED_ARTIFACT_COPY.publicSharingDisabled;
  }
  return SHARED_ARTIFACT_COPY.shareFailed;
}

/**
 * The artifact share controls (CAN-8017): `ShareResourceDialog` for the
 * team and organization audience, plus the public link section in its
 * always-visible slot. Every control follows the server's `permissions`.
 */
export function SharedArtifactShareDialog({
  artifact,
  client,
  share: shareHost,
  absoluteUrl,
  copyText,
  onArtifact,
  onReload,
  onUnshared,
  onClose,
}: {
  readonly artifact: SharedArtifact;
  readonly client: SharedArtifactsClient;
  readonly share: SharedArtifactShareHost;
  readonly absoluteUrl: (path: string) => string;
  readonly copyText: (text: string) => Promise<boolean>;
  readonly onArtifact: (artifact: SharedArtifact) => void;
  readonly onReload: () => void;
  readonly onUnshared: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { permissions } = artifact;
  const keyRef = useRef<{ input: string; key: string } | null>(null);
  const unshareKeyRef = useRef<string | null>(null);
  const unsharedRef = useRef(false);
  const existingShare = useMemo(
    () => sharedArtifactExistingShare(artifact, absoluteUrl),
    [absoluteUrl, artifact],
  );

  const share = useCallback(
    async (input: ShareResourceShareInput): Promise<ShareResourceOutcome> => {
      const audience = audienceInput(input);
      if (audience === null) throw new Error(SHARED_ARTIFACT_COPY.shareFailed);
      const serialized = JSON.stringify(audience);
      if (keyRef.current?.input !== serialized)
        keyRef.current = {
          input: serialized,
          key: newSharedArtifactIdempotencyKey(),
        };
      try {
        const updated = await client.updateAudience({
          artifactId: artifact.id,
          audience,
          idempotencyKey: keyRef.current.key,
        });
        keyRef.current = null;
        onArtifact(updated);
        return { shareUrl: absoluteUrl(sharedArtifactSharePath(artifact.id)) };
      } catch (error) {
        if (sharedArtifactFailureNeedsReload(error)) {
          keyRef.current = null;
          onReload();
        }
        throw error;
      }
    },
    [absoluteUrl, artifact.id, client, onArtifact, onReload],
  );

  const stopSharing = useMemo((): ShareStopSharing | undefined => {
    if (!permissions.canUnshare) return undefined;
    return {
      label: SHARED_ARTIFACT_COPY.stopSharingLabel,
      confirm: {
        title: SHARED_ARTIFACT_COPY.stopSharingTitle,
        body: SHARED_ARTIFACT_COPY.stopSharingBody,
        busyLabel: SHARED_ARTIFACT_COPY.stopSharingBusy,
      },
      onStop: async (): Promise<void> => {
        unshareKeyRef.current ??= newSharedArtifactIdempotencyKey();
        try {
          await client.unshare({
            artifactId: artifact.id,
            idempotencyKey: unshareKeyRef.current,
          });
        } catch (error) {
          // The loaded DTO is stale (removed or taken down): reload it so the
          // viewer moves to the matching state, and keep the dialog's error.
          if (sharedArtifactFailureNeedsReload(error)) {
            unshareKeyRef.current = null;
            onReload();
          }
          throw error;
        }
        unshareKeyRef.current = null;
        // Entered when the dialog closes, so it finishes its own toast first.
        unsharedRef.current = true;
      },
      toast: SHARED_ARTIFACT_COPY.stopSharingToast,
    };
  }, [artifact.id, client, onReload, permissions.canUnshare]);

  const close = useCallback((): void => {
    onClose();
    if (unsharedRef.current) onUnshared();
  }, [onClose, onUnshared]);

  return (
    <ShareResourceDialog
      resourceNoun={SHARED_ARTIFACT_COPY.noun}
      testIdPrefix="share-artifact"
      scopes={ARTIFACT_SCOPES}
      subtitle={artifact.title}
      {...(existingShare === undefined ? {} : { existingShare })}
      {...(permissions.canChangeAudience
        ? {}
        : {
            audienceLocked: { hint: SHARED_ARTIFACT_COPY.audienceLockedHint },
          })}
      {...(stopSharing === undefined ? {} : { stopSharing })}
      standaloneOptions={
        <SharedArtifactPublicLinkSection
          artifact={artifact}
          client={client}
          offerUnshare={existingShare === undefined}
          onArtifact={onArtifact}
          onReload={onReload}
          onUnshared={(): void => {
            onClose();
            onUnshared();
          }}
        />
      }
      shareDisabled={!permissions.canChangeAudience}
      loadAccount={shareHost.loadAccount}
      {...(shareHost.subscribeAccountChanged === undefined
        ? {}
        : { subscribeAccountChanged: shareHost.subscribeAccountChanged })}
      listTeams={shareHost.listTeams}
      listOrganizations={shareHost.listOrganizations}
      share={share}
      copyText={copyText}
      notify={shareHost.notify}
      resolveErrorMessage={shareFailureCopy}
      onClose={close}
    />
  );
}

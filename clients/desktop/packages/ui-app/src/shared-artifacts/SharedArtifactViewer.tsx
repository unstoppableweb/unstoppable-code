'use client';

import { useCallback, useState, type JSX, type ReactNode } from 'react';
import {
  useSharedArtifact,
  useSharedArtifactContent,
  type SharedArtifactInitialState,
} from '@canopy/app-state/shared-artifacts';
import type { SharedArtifact } from '@canopy/protocol/canopy-core';
import { sharedArtifactSharePath } from '@canopy/protocol/shared-artifacts';
import { Button, ErrorBanner, Stack } from '@canopy/ui-shared/components';
import {
  DialogModal,
  Heading,
  Notice,
  TextLink,
} from '@canopy/ui-shared/primitives';
import { SharedArtifactContent } from './SharedArtifactContent';
import { SharedArtifactReportDialog } from './SharedArtifactReportDialog';
import { SharedArtifactShareDialog } from './SharedArtifactShareDialog';
import {
  SharedArtifactLoadingPanel,
  SharedArtifactStatePanel,
} from './SharedArtifactStatePanel';
import {
  SHARED_ARTIFACT_COPY,
  SHARED_ARTIFACT_TAKEDOWN_REASON_PHRASES,
} from './shared-artifact-copy';
import {
  canManageSharedArtifact,
  canReportSharedArtifact,
  deriveSharedArtifactViewerState,
  formatSharedArtifactTime,
  isOutsideSharedArtifactAudience,
  sharedArtifactAutomationLabel,
  sharedArtifactOwnerName,
  showsSharedArtifactPausedNotice,
} from './shared-artifact-view-model';
import {
  useSharedArtifactsHost,
  type SharedArtifactsHost,
} from './shared-artifacts-host';

export interface SharedArtifactViewerProps {
  readonly artifactId: string;
  /** A host that read on the server passes its result to skip the first read. */
  readonly initial?: SharedArtifactInitialState;
}

function UnavailablePanel(): JSX.Element {
  return (
    <SharedArtifactStatePanel
      testId="shared-artifact-unavailable"
      title={SHARED_ARTIFACT_COPY.unavailableTitle}
      body={SHARED_ARTIFACT_COPY.unavailableBody}
    />
  );
}

/**
 * The shared artifact viewer (CAN-8017): one component for every host. It
 * reads only the `SharedArtifactsHost` port, never a `CanopyClient`, and a
 * missing port renders the capability-gated state.
 */
export function SharedArtifactViewer(
  props: SharedArtifactViewerProps,
): JSX.Element {
  const host = useSharedArtifactsHost();
  if (host === null) return <UnavailablePanel />;
  return <SharedArtifactViewerWithHost {...props} host={host} />;
}

function UserGeneratedBanner(): JSX.Element {
  return (
    <Notice intent="attention" data-testid="shared-artifact-ugc-banner">
      {SHARED_ARTIFACT_COPY.userGeneratedBanner}
    </Notice>
  );
}

function SharedArtifactViewerWithHost({
  artifactId,
  initial,
  host,
}: SharedArtifactViewerProps & {
  readonly host: SharedArtifactsHost;
}): JSX.Element {
  const client = host.capabilities.view ? host.client : null;
  const { load, reload, applyArtifact, applyResult, markUnshared } =
    useSharedArtifact(client, artifactId, initial);
  const state = deriveSharedArtifactViewerState({
    view: host.capabilities.view,
    hasClient: client !== null,
    load,
    signedIn: host.viewer.signedIn,
  });
  const readyArtifact = state.status === 'ready' ? state.artifact : null;
  const { content, retry } = useSharedArtifactContent(client, readyArtifact, {
    onArtifactRefreshed: applyResult,
  });
  const reloadSoon = useCallback((): void => {
    void reload();
  }, [reload]);

  switch (state.status) {
    case 'unavailable':
      return <UnavailablePanel />;
    case 'unshared':
      return (
        <SharedArtifactStatePanel
          testId="shared-artifact-unshared"
          title={SHARED_ARTIFACT_COPY.unsharedTitle}
          body={SHARED_ARTIFACT_COPY.unsharedBody}
        />
      );
    case 'loading':
      return (
        <SharedArtifactLoadingPanel label={SHARED_ARTIFACT_COPY.loading} />
      );
    case 'signIn':
      return (
        <SharedArtifactStatePanel
          testId="shared-artifact-sign-in"
          title={SHARED_ARTIFACT_COPY.signInTitle}
          body={SHARED_ARTIFACT_COPY.signInBody}
          action={{
            label: SHARED_ARTIFACT_COPY.signInAction,
            href: host.signInHref(sharedArtifactSharePath(artifactId)),
          }}
        />
      );
    case 'noAccess':
      return (
        <SharedArtifactStatePanel
          testId="shared-artifact-no-access"
          title={SHARED_ARTIFACT_COPY.noAccessTitle}
          body={SHARED_ARTIFACT_COPY.noAccessBody}
        />
      );
    case 'error':
      return (
        <div
          className="mx-auto w-full max-w-md px-6 py-16"
          data-testid="shared-artifact-error"
        >
          <ErrorBanner
            className=""
            errorSource="shared-artifact-load"
            blockMessageFromReplay={false}
            error={SHARED_ARTIFACT_COPY.loadFailed}
            onRetry={reloadSoon}
          />
        </div>
      );
    case 'takenDown':
      return (
        <SharedArtifactStatePanel
          testId="shared-artifact-taken-down"
          title={SHARED_ARTIFACT_COPY.takenDownTitle}
          body={SHARED_ARTIFACT_COPY.takenDownBody(
            SHARED_ARTIFACT_TAKEDOWN_REASON_PHRASES[
              state.artifact.takedown?.reason ?? 'other'
            ],
          )}
        />
      );
    case 'ready':
      return (
        <ReadyArtifact
          artifact={state.artifact}
          host={host}
          content={
            <SharedArtifactContent
              artifact={state.artifact}
              content={content}
              host={host}
              onRetry={retry}
            />
          }
          onArtifact={applyArtifact}
          onReload={reloadSoon}
          onUnshared={markUnshared}
        />
      );
  }
}

function ReadyArtifact({
  artifact,
  host,
  content,
  onArtifact,
  onReload,
  onUnshared,
}: {
  readonly artifact: SharedArtifact;
  readonly host: SharedArtifactsHost;
  readonly content: ReactNode;
  readonly onArtifact: (artifact: SharedArtifact) => void;
  readonly onReload: () => void;
  readonly onUnshared: () => void;
}): JSX.Element {
  const [sharing, setSharing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);

  const outside = isOutsideSharedArtifactAudience(artifact.owner, host.viewer);
  const ownerName = sharedArtifactOwnerName(artifact, outside);
  const automationLabel = sharedArtifactAutomationLabel(artifact, outside);
  const updated = formatSharedArtifactTime(artifact.updatedAt);
  const client = host.client;
  const canShare =
    client !== null &&
    host.share !== undefined &&
    canManageSharedArtifact(artifact);
  const canReport = client !== null && canReportSharedArtifact(artifact);

  const exitFullScreen = useCallback((): void => setFullScreen(false), []);

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {canShare && (
        <Button
          type="button"
          variant="secondary"
          size="compact"
          onClick={(): void => setSharing(true)}
          data-testid="shared-artifact-share"
        >
          {SHARED_ARTIFACT_COPY.shareAction}
        </Button>
      )}
      {canReport &&
        (host.viewer.signedIn ? (
          <Button
            type="button"
            variant="ghost"
            size="compact"
            onClick={(): void => setReporting(true)}
            data-testid="shared-artifact-report"
          >
            {SHARED_ARTIFACT_COPY.reportAction}
          </Button>
        ) : (
          // Reporting needs an account; a signed-out viewer signs in first.
          <TextLink
            href={host.signInHref(sharedArtifactSharePath(artifact.id))}
            data-testid="shared-artifact-report-sign-in"
          >
            {SHARED_ARTIFACT_COPY.reportAction}
          </TextLink>
        ))}
      <Button
        type="button"
        variant="ghost"
        size="compact"
        onClick={(): void => setFullScreen(true)}
        data-testid="shared-artifact-full-screen"
      >
        {SHARED_ARTIFACT_COPY.enterFullScreen}
      </Button>
    </div>
  );

  return (
    <div className="flex w-full flex-col" data-testid="shared-artifact-viewer">
      <header className="flex flex-col gap-3 px-6 pt-6 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Stack gap="tight" className="min-w-0">
            <Heading level={1} variant="section">
              <span data-testid="shared-artifact-title">{artifact.title}</span>
            </Heading>
            <p className="text-xs fg-tertiary">
              {[
                ownerName === null
                  ? null
                  : SHARED_ARTIFACT_COPY.ownerLine(ownerName),
                updated === ''
                  ? null
                  : SHARED_ARTIFACT_COPY.updatedLine(updated),
              ]
                .filter((part) => part !== null)
                .join(' · ')}
            </p>
            {automationLabel !== null && (
              <p
                className="text-xs fg-tertiary"
                data-testid="shared-artifact-automation"
              >
                {SHARED_ARTIFACT_COPY.automationLine(automationLabel)}
              </p>
            )}
            {artifact.permissions.canViewAnalytics &&
              artifact.viewCounts !== undefined && (
                <p
                  className="text-xs fg-tertiary"
                  data-testid="shared-artifact-view-counts"
                >
                  {SHARED_ARTIFACT_COPY.viewCounts(
                    artifact.viewCounts.total,
                    artifact.viewCounts.unique,
                  )}
                </p>
              )}
          </Stack>
          {actions}
        </div>
        {outside && <UserGeneratedBanner />}
        {showsSharedArtifactPausedNotice(artifact) && (
          <Notice intent="attention" data-testid="shared-artifact-paused">
            {SHARED_ARTIFACT_COPY.pausedNotice}
          </Notice>
        )}
      </header>
      <div className="flex min-h-0 w-full flex-1 flex-col">
        {fullScreen ? null : content}
      </div>
      {fullScreen && (
        // The shared full-size dialog, not the Fullscreen API (the frame's
        // `allow` list denies it). Its header with the title and Close stays
        // above the content, so content can never cover our chrome, and Close
        // is reachable by Tab even while focus is inside the frame. It owns
        // focus return, Escape and the scroll lock; a dialog opened from it
        // stacks above it and takes Escape first.
        <DialogModal
          title={artifact.title}
          onClose={exitFullScreen}
          maxWidth="full"
          height="calc(100dvh - 2rem)"
          inset="flush"
          dataTestId="shared-artifact-full-screen-overlay"
        >
          <div className="flex h-full min-h-0 flex-col">
            {outside && (
              <div className="px-6 pb-3">
                <UserGeneratedBanner />
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto">{content}</div>
          </div>
        </DialogModal>
      )}
      {sharing && client !== null && host.share !== undefined && (
        <SharedArtifactShareDialog
          artifact={artifact}
          client={client}
          share={host.share}
          absoluteUrl={host.absoluteUrl}
          copyText={host.copyText}
          onArtifact={onArtifact}
          onReload={onReload}
          onUnshared={onUnshared}
          onClose={(): void => setSharing(false)}
        />
      )}
      {reporting && client !== null && (
        <SharedArtifactReportDialog
          client={client}
          artifactId={artifact.id}
          onClose={(): void => setReporting(false)}
        />
      )}
    </div>
  );
}

'use client';

import { lazy, Suspense, useEffect, useMemo, useState, type JSX } from 'react';
import type { SharedArtifactContentState } from '@canopy/app-state/shared-artifacts';
import type { SharedArtifact } from '@canopy/protocol/canopy-core';
import { CenteredLoadingSpinner } from '@canopy/ui-shared/primitives';
import { ErrorBanner } from '@canopy/ui-shared/components';
import { ImageArtifact } from './ImageArtifact';
import { SHARED_ARTIFACT_COPY } from './shared-artifact-copy';
import type { SharedArtifactsHost } from './shared-artifacts-host';

// Each renderer loads only for its kind, so the share page's first load
// stays small: the frame, markdown and PDF.js load on demand.
const HtmlArtifactFrame = lazy(() =>
  import('./HtmlArtifactFrame').then((module) => ({
    default: module.HtmlArtifactFrame,
  })),
);
const SvgArtifactFrame = lazy(() =>
  import('./HtmlArtifactFrame').then((module) => ({
    default: module.SvgArtifactFrame,
  })),
);
const MarkdownArtifact = lazy(() =>
  import('./MarkdownArtifact').then((module) => ({
    default: module.MarkdownArtifact,
  })),
);
const PdfArtifact = lazy(() =>
  import('./PdfArtifact').then((module) => ({ default: module.PdfArtifact })),
);

function decodeText(bytes: Uint8Array): string {
  // Non-fatal: invalid bytes become replacement characters.
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function failureCopy(
  content: Extract<SharedArtifactContentState, { status: 'failed' }>,
): string {
  if (content.reason === 'tooLarge')
    return SHARED_ARTIFACT_COPY.contentTooLarge;
  if (content.reason === 'mismatch')
    return SHARED_ARTIFACT_COPY.contentMismatch;
  return SHARED_ARTIFACT_COPY.contentFailed;
}

function Loading(): JSX.Element {
  return (
    <div className="flex min-h-80 w-full">
      <CenteredLoadingSpinner spacing="section" />
    </div>
  );
}

/**
 * The content area: one renderer per kind, or content failed with retry.
 * The chrome around it stays in every case.
 */
export function SharedArtifactContent({
  artifact,
  content,
  host,
  onRetry,
}: {
  readonly artifact: SharedArtifact;
  readonly content: SharedArtifactContentState;
  readonly host: SharedArtifactsHost;
  readonly onRetry: () => void;
}): JSX.Element {
  const [renderFailed, setRenderFailed] = useState(false);
  const bytes = content.status === 'ready' ? content.bytes : null;
  useEffect(() => setRenderFailed(false), [bytes]);
  const text = useMemo(
    () =>
      bytes !== null &&
      (artifact.kind === 'html' ||
        artifact.kind === 'markdown' ||
        (content.status === 'ready' && content.mediaType === 'image/svg+xml'))
        ? decodeText(bytes)
        : null,
    [artifact.kind, bytes, content],
  );

  if (content.status === 'idle' || content.status === 'loading')
    return <Loading />;
  if (content.status === 'failed' || renderFailed) {
    return (
      <div className="p-6" data-testid="shared-artifact-content-failed">
        <ErrorBanner
          className=""
          errorSource="shared-artifact-content"
          blockMessageFromReplay={false}
          error={
            content.status === 'failed'
              ? failureCopy(content)
              : SHARED_ARTIFACT_COPY.contentFailed
          }
          {...(content.status === 'failed' && content.reason === 'tooLarge'
            ? {}
            : {
                onRetry: (): void => {
                  setRenderFailed(false);
                  onRetry();
                },
              })}
        />
      </div>
    );
  }

  const fail = (): void => setRenderFailed(true);
  const body = ((): JSX.Element => {
    if (artifact.kind === 'html')
      return (
        <HtmlArtifactFrame
          markup={text ?? ''}
          title={artifact.title}
          frame={host.frame}
        />
      );
    if (artifact.kind === 'markdown')
      return (
        <MarkdownArtifact text={text ?? ''} openLink={host.frame.openLink} />
      );
    if (artifact.kind === 'pdf')
      return (
        <PdfArtifact
          bytes={content.bytes}
          title={artifact.title}
          resolveAssets={host.resolvePdfAssets}
          onFailure={fail}
        />
      );
    if (content.mediaType === 'image/svg+xml')
      return (
        <SvgArtifactFrame
          markup={text ?? ''}
          title={artifact.title}
          frame={host.frame}
        />
      );
    return (
      <ImageArtifact
        bytes={content.bytes}
        mediaType={content.mediaType}
        title={artifact.title}
        onFailure={fail}
      />
    );
  })();
  return <Suspense fallback={<Loading />}>{body}</Suspense>;
}

'use client';

import { useMemo, type JSX } from 'react';
import {
  AgentVisualFrame,
  useAgentVisualHostTheme,
} from '@canopy/ui-shared/components';
import {
  AGENT_VISUAL_LOAD_MAX_CHARS,
  buildAgentVisualSrcDoc,
} from '@canopy/ui-shared/lib';
import { SHARED_ARTIFACT_COPY } from './shared-artifact-copy';
import type { SharedArtifactFrameHost } from './shared-artifacts-host';

export const SHARED_ARTIFACT_FRAME_TEST_IDS = {
  frame: 'shared-artifact-frame',
  interactButton: 'shared-artifact-frame-interact',
  expandButton: 'shared-artifact-frame-expand',
  saveButton: 'shared-artifact-frame-save',
  unavailableState: 'shared-artifact-frame-unavailable',
  errorState: 'shared-artifact-frame-error',
  retryButton: 'shared-artifact-frame-retry',
} as const;

/**
 * Whether the built frame document fits the shell's load cap. The shell
 * drops a longer document silently, so a legal 8 MiB artifact plus the
 * builder's wrapper would otherwise show a blank frame.
 */
export function fitsSharedArtifactFrame(
  markup: string,
  remoteAssets: boolean,
): boolean {
  const built = buildAgentVisualSrcDoc(
    markup,
    { appearance: 'light', variables: {} },
    { remoteAssets },
  );
  return built.length <= AGENT_VISUAL_LOAD_MAX_CHARS;
}

/**
 * HTML and SVG artifacts render only inside the agent-visual sandbox
 * (`AgentVisualFrame`), never as a page of our origin and never through a
 * `srcdoc` this component builds.
 */
export function HtmlArtifactFrame({
  markup,
  title,
  frame,
}: {
  readonly markup: string;
  readonly title: string;
  readonly frame: SharedArtifactFrameHost;
}): JSX.Element {
  const theme = useAgentVisualHostTheme();
  const fits = useMemo(
    () => fitsSharedArtifactFrame(markup, frame.remoteAssets),
    [frame.remoteAssets, markup],
  );
  if (!fits) {
    return (
      <p
        className="p-6 text-s fg-secondary"
        role="status"
        data-testid="shared-artifact-content-too-large-for-frame"
      >
        {SHARED_ARTIFACT_COPY.contentTooLargeForFrame}
      </p>
    );
  }
  return (
    // Dynamic viewport units, so mobile browser bars don't clip the frame.
    <div className="flex h-[calc(100dvh-12rem)] min-h-80 w-full flex-col">
      <AgentVisualFrame
        document={markup}
        title={title}
        maxHeight={4096}
        theme={theme}
        onOpenLink={frame.openLink}
        variant="expanded"
        prioritized
        {...(frame.frameUrl === undefined ? {} : { frameUrl: frame.frameUrl })}
        remoteAssets={frame.remoteAssets}
        testIds={SHARED_ARTIFACT_FRAME_TEST_IDS}
      />
    </div>
  );
}

/**
 * An SVG inside a minimal document for the same frame, scaled to its width.
 * The XML declaration and doctype are stripped for looks only: the sandbox
 * is what keeps it contained.
 */
export function svgArtifactMarkup(svg: string): string {
  const body = svg
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[^>]*\?>/i, '')
    .replace(/^\s*<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/i, '');
  return `<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:auto;max-width:100%}</style>${body}`;
}

/** An SVG artifact, through the same sandbox as HTML. */
export function SvgArtifactFrame({
  markup,
  ...props
}: {
  readonly markup: string;
  readonly title: string;
  readonly frame: SharedArtifactFrameHost;
}): JSX.Element {
  const wrapped = useMemo(() => svgArtifactMarkup(markup), [markup]);
  return <HtmlArtifactFrame {...props} markup={wrapped} />;
}

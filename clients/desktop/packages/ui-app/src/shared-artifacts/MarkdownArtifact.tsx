'use client';

import {
  createContext,
  useContext,
  useMemo,
  type JSX,
  type ReactNode,
} from 'react';
import {
  Button,
  Markdown,
  TRANSCRIPT_PROSE_CLASS,
  type MarkdownOptions,
} from '@canopy/ui-shared/components';
import { SHARED_ARTIFACT_COPY } from './shared-artifact-copy';

const OpenLinkContext = createContext<((url: string) => void) | null>(null);

/**
 * A markdown link never navigates the page: it hands its (already
 * sanitized) target to the host's `openLink`, which checks it and opens it
 * without an opener or referrer. No `href` is placed in the app DOM, so a
 * middle click can't bypass that check.
 */
function ArtifactMarkdownLink({
  href,
  children,
}: {
  readonly href?: string;
  readonly children?: ReactNode;
}): JSX.Element {
  const openLink = useContext(OpenLinkContext);
  if (href === undefined || href === '' || openLink === null) {
    return <span>{children}</span>;
  }
  return (
    <Button variant="link" type="button" onClick={(): void => openLink(href)}>
      {children}
    </Button>
  );
}

/** Remote images are never loaded, for anyone: the alt text shows instead. */
function BlockedArtifactImage({ alt }: { readonly alt?: string }): JSX.Element {
  return (
    <span className="text-s fg-tertiary italic">
      {SHARED_ARTIFACT_COPY.imageBlocked(alt ?? '')}
    </span>
  );
}

const ARTIFACT_MARKDOWN_OPTIONS: MarkdownOptions = {
  overrides: {
    a: { component: ArtifactMarkdownLink },
    img: { component: BlockedArtifactImage },
  },
};

/**
 * A markdown artifact through the shared renderer. Raw HTML stays inert
 * (the renderer never parses it), links go through `openLink`, and remote
 * images are blocked.
 */
export function MarkdownArtifact({
  text,
  openLink,
}: {
  readonly text: string;
  readonly openLink: (url: string) => void;
}): JSX.Element {
  const options = useMemo(() => ARTIFACT_MARKDOWN_OPTIONS, []);
  return (
    <OpenLinkContext.Provider value={openLink}>
      <div
        className="mx-auto w-full max-w-3xl px-6 py-8"
        data-testid="shared-artifact-markdown"
      >
        {/* The prose typography desktop and web transcripts share. */}
        <div className={TRANSCRIPT_PROSE_CLASS}>
          <Markdown options={options}>{text}</Markdown>
        </div>
      </div>
    </OpenLinkContext.Provider>
  );
}

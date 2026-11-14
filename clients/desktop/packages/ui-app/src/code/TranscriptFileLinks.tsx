'use client';

import {
  createContext,
  useContext,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  TRANSCRIPT_MARKDOWN_OPTIONS,
  TranscriptMarkdownAnchor,
  isNavigableTranscriptHref,
  type MarkdownOptions,
  TRANSCRIPT_LINK_CLASS,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  parseFileLinkLineSuffix,
  type FileLinkLineLocation,
} from '@canopy/ui-shared/lib/file-link-line-suffix';
import type { TranscriptTurnFilesInteraction } from './TurnFiles';
import {
  FileLinkStatus,
  fileLinkFailureOf,
  type FileLinkFailure,
} from '../file-link-status/file-link-status';

export type { FileLinkLineLocation };

/**
 * Host surface for agent-authored links to workspace files (CAN-3172).
 *
 * Transcript markdown comes from an agent, so a path-like target
 * (`src/a.ts`, `/workspace/src/a.ts`, `file:///workspace/src/a.ts`) names a
 * file in the agent's working directory, never a site route. When a host can
 * resolve and show those files it supplies `openFileLink`; otherwise path-like
 * links render as inert, readable text (CAN-2440).
 */
export interface TranscriptFileLinkInteraction {
  readonly turnFiles?: TranscriptTurnFilesInteraction;
  /**
   * Open `href` in the host's file viewer. Resolves `false` when the target is
   * not an existing file inside the workspace (outside the working directory,
   * deleted, or not a file path at all). Rejections leave the link actionable
   * so transient transport failures can be retried. A rejection marked with
   * `withFileLinkFailure` says why beside the link: a missing file leaves it
   * inert, a sleeping project keeps it actionable (CAN-6665). Omit to keep
   * path-like links inert.
   *
   * A link with a line suffix (`src/a.ts:12-20`, `src/a.ts#L12`) arrives with
   * the suffix stripped from `href` and parsed into `location` (CAN-4275);
   * hosts resolve `href` unchanged and reveal `location` once the file is
   * shown. Links without a location are called with `href` alone.
   */
  readonly openFileLink?: (
    href: string,
    location?: FileLinkLineLocation,
  ) => Promise<boolean>;
}

const TranscriptFileLinkInteractionContext =
  createContext<TranscriptFileLinkInteraction | null>(null);

export function useTranscriptFileLinkInteraction(): TranscriptFileLinkInteraction | null {
  return useContext(TranscriptFileLinkInteractionContext);
}

/**
 * Opt a transcript subtree into the agent-transcript link policy. Absent (or
 * `null`) leaves agent prose on the default markdown options.
 */
export function TranscriptFileLinkInteractionProvider({
  value,
  children,
}: {
  value: TranscriptFileLinkInteraction | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <TranscriptFileLinkInteractionContext.Provider value={value}>
      {children}
    </TranscriptFileLinkInteractionContext.Provider>
  );
}

type AnchorProps = ComponentPropsWithoutRef<'a'>;
type LinkState = 'idle' | 'opening' | 'unavailable';

/** `12` or `12-20`, for the `data-file-link-line` attribute. */
function lineAttribute(location: FileLinkLineLocation): string {
  return location.lineEnd === undefined
    ? String(location.line)
    : `${location.line}-${location.lineEnd}`;
}

const FILE_LINK_CLASSES = `focus-ring inline cursor-pointer break-all rounded-sm disabled:cursor-progress ${TRANSCRIPT_LINK_CLASS}`;

function TranscriptFileLinkAnchor(props: AnchorProps): JSX.Element {
  const { href, children } = props;
  const interaction = useContext(TranscriptFileLinkInteractionContext);
  const [state, setState] = useState<LinkState>('idle');
  const [failure, setFailure] = useState<FileLinkFailure | null>(null);
  const pending = useRef(false);
  const openFileLink = interaction?.openFileLink;

  if (
    typeof href !== 'string' ||
    isNavigableTranscriptHref(href) ||
    openFileLink === undefined
  ) {
    return <TranscriptMarkdownAnchor {...props} />;
  }
  if (state === 'unavailable') {
    // Not an existing workspace file: fall back to the readable inert text.
    return (
      <span data-file-link-state="unavailable">
        <FileLinkStatus failure={failure}>
          <TranscriptMarkdownAnchor {...props} />
        </FileLinkStatus>
      </span>
    );
  }

  // External links were classified above on the full href; the suffix is
  // parsed only for local targets, and a stripped href that would navigate
  // keeps the original, unlocated link.
  const parsed = parseFileLinkLineSuffix(href);
  const location =
    parsed.location !== null && !isNavigableTranscriptHref(parsed.href)
      ? parsed.location
      : null;

  const onClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setState('opening');
    setFailure(null);
    const opening =
      location === null
        ? openFileLink(href)
        : openFileLink(parsed.href, location);
    void opening.then(
      (opened): void => {
        pending.current = false;
        setState(opened ? 'idle' : 'unavailable');
      },
      (error: unknown): void => {
        pending.current = false;
        const reason = fileLinkFailureOf(error);
        // A missing file is final; anything else can be tried again.
        setFailure(reason);
        setState(reason?.kind === 'missing' ? 'unavailable' : 'idle');
      },
    );
  };

  // A button, not an anchor: a path has no meaning as a site URL, so an
  // `href` would let middle-click or copy-link navigate to a 404.
  return (
    <FileLinkStatus failure={failure}>
      <Tooltip label={href} contentClassName="max-w-96 break-all" replayBlock>
        <button
          type="button"
          className={FILE_LINK_CLASSES}
          data-testid="markdown-file-link"
          data-file-link-state={state}
          data-file-link-line={
            location === null ? undefined : lineAttribute(location)
          }
          aria-busy={state === 'opening' || undefined}
          disabled={state === 'opening'}
          onClick={onClick}
        >
          {children}
        </button>
      </Tooltip>
    </FileLinkStatus>
  );
}

/**
 * Agent-transcript markdown options with workspace-file links. `file://`
 * targets survive URL sanitizing so the anchor can hand them to the host; it
 * never renders them as navigable anchors.
 */
export const TRANSCRIPT_FILE_LINK_MARKDOWN_OPTIONS: MarkdownOptions = {
  ...TRANSCRIPT_MARKDOWN_OPTIONS,
  allowLocalFileLinks: true,
  allowFileUrlLinks: true,
  overrides: {
    ...TRANSCRIPT_MARKDOWN_OPTIONS.overrides,
    a: TranscriptFileLinkAnchor,
  },
};

/**
 * The markdown options agent prose should use under the current provider, or
 * `undefined` when no host opted in (default markdown options).
 */
export function useTranscriptProseOptions(): MarkdownOptions | undefined {
  return useContext(TranscriptFileLinkInteractionContext) === null
    ? undefined
    : TRANSCRIPT_FILE_LINK_MARKDOWN_OPTIONS;
}

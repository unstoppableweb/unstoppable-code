'use client';

import {
  memo,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type JSX,
  type ReactNode,
  type UIEventHandler,
} from 'react';
import { Button } from '@canopy/ui-shared/primitives/Button';
import {
  TextLink,
  MARKDOWN_ROOT_PROPS,
  DocumentProse,
  Markdown,
  MermaidExportProvider,
  markdownOptions,
  type MarkdownOptions,
  type MarkdownOverrides,
  type MermaidSaveDestination,
} from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { FrontmatterBlock } from './FrontmatterBlock';
import { parseFrontmatterAndBody } from './frontmatter';

/** Absolute (navigable-as-is) URL schemes; everything else is host-relative. */
function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(href);
}

/** Local file reference only: no URL scheme, root path, or network path. */
function isRelativeAssetSrc(src: string): boolean {
  return !/^[a-z][a-z\d+.-]*:/i.test(src) && !/^[\\/]/.test(src);
}

/**
 * Read-only markdown preview built on the same shared markdown-to-jsx renderer
 * as the chat transcript. Ported from the desktop `MarkdownPreview` but
 * transport-neutral: relative link/image resolution is *injected* rather than
 * reaching into `window.api`, so the browser-safe package stays host-agnostic.
 *
 * - External links (`http(s)`/`mailto`/`tel`) render as normal new-tab anchors.
 * - Relative links call {@link onOpenRelativePath} when provided (desktop opens
 *   a file tab); otherwise they render as inert text.
 * - Relative image `src`s render only through {@link resolveAssetSrc}; remote
 *   and unresolved sources stay inert so opening a preview cannot issue an
 *   untrusted network request.
 */
export interface FileMarkdownPreviewProps {
  readonly content: string;
  /** Opens an in-app target for a relative markdown link (e.g. a file tab). */
  readonly onOpenRelativePath?: (path: string) => void;
  /** Rewrites a relative image `src` to a host-resolvable URL. */
  readonly resolveAssetSrc?: (
    src: string,
  ) => string | Promise<string | null> | null;
  readonly scrollBinding?: {
    readonly ref: (node: HTMLElement | null) => void;
    readonly onScroll: UIEventHandler<HTMLElement>;
    /** Re-applies a persisted scroll position after embedded images load. */
    readonly onContentLoaded?: () => void;
  };
  /**
   * Where diagram pictures go. Omitted, they inherit the host's destination
   * (a download).
   */
  readonly diagramSaveDestination?: MermaidSaveDestination;
}

function ResolvedMarkdownImage({
  src,
  alt,
  resolveAssetSrc,
}: {
  src: string;
  alt: string;
  resolveAssetSrc: NonNullable<FileMarkdownPreviewProps['resolveAssetSrc']>;
}): JSX.Element {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'unavailable' }
    | { status: 'ready'; src: string }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async (): Promise<void> => {
      try {
        const resolved = await resolveAssetSrc(src);
        if (!cancelled) {
          setState(
            resolved
              ? { status: 'ready', src: resolved }
              : { status: 'unavailable' },
          );
        }
      } catch {
        if (!cancelled) setState({ status: 'unavailable' });
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [resolveAssetSrc, src]);

  return state.status === 'loading' ? (
    <span className="text-xs fg-secondary">Loading image…</span>
  ) : state.status === 'unavailable' ? (
    <span className="text-xs fg-secondary">Image unavailable</span>
  ) : (
    <img src={state.src} alt={alt} className="max-w-full" />
  );
}

/**
 * Markdown options for file previews: link and image handling that keeps the
 * preview host-neutral (see {@link FileMarkdownPreview}). Shared with the
 * notebook preview so Markdown cells behave exactly like a Markdown file.
 */
const ATTACHMENT_SCHEME = 'attachment:';

export function useFileMarkdownOptions(
  onOpenRelativePath: FileMarkdownPreviewProps['onOpenRelativePath'],
  resolveAssetSrc: FileMarkdownPreviewProps['resolveAssetSrc'],
  /** Notebook cells: a validated `data:` URL for `attachment:<name>`. */
  resolveAttachmentSrc?: (name: string) => string | undefined,
): MarkdownOptions {
  return useMemo(() => {
    const options = markdownOptions({
      a({ href, children }: ComponentPropsWithoutRef<'a'>): JSX.Element {
        const target = typeof href === 'string' ? href : '';
        if (!target || isExternalHref(target)) {
          return (
            <TextLink
              variant="inherited"
              href={target}
              target="_blank"
              rel="noreferrer noopener"
            >
              {children}
            </TextLink>
          );
        }
        if (onOpenRelativePath) {
          const open = onOpenRelativePath;
          return (
            <Button variant="link" onClick={(): void => open(target)}>
              {children}
            </Button>
          );
        }
        // No resolver on this host: render the link text inert rather than as a
        // dead blue "link" the user would try to click.
        return (
          <span
            className="fg-secondary"
            aria-disabled="true"
            title={`Unresolved link: ${target}`}
          >
            {children}
          </span>
        );
      },
      img({ src, alt }: ComponentPropsWithoutRef<'img'>): ReactNode {
        const raw = typeof src === 'string' ? src : '';
        if (!raw) {
          return alt ? (
            <span className="text-xs fg-secondary">{alt}</span>
          ) : null;
        }
        if (resolveAttachmentSrc && raw.startsWith(ATTACHMENT_SCHEME)) {
          const attachmentSrc = resolveAttachmentSrc(
            raw.slice(ATTACHMENT_SCHEME.length),
          );
          if (attachmentSrc !== undefined) {
            return (
              <img src={attachmentSrc} alt={alt ?? ''} className="max-w-full" />
            );
          }
        }
        if (resolveAssetSrc && isRelativeAssetSrc(raw)) {
          return (
            <ResolvedMarkdownImage
              src={raw}
              alt={alt ?? ''}
              resolveAssetSrc={resolveAssetSrc}
            />
          );
        }
        return (
          <span className="text-xs fg-secondary">
            {alt || 'Image unavailable'}
          </span>
        );
      },
    } satisfies MarkdownOverrides);
    if (!resolveAttachmentSrc) return options;
    // The shared sanitizer drops unknown schemes; let `attachment:` image
    // sources reach the override above, which only resolves this cell's map.
    const sanitize = options.sanitizer;
    return {
      ...options,
      sanitizer: (value: string, tag: string, attribute: string) =>
        tag === 'img' && value.startsWith(ATTACHMENT_SCHEME)
          ? value
          : (sanitize?.(value, tag, attribute) ?? null),
    };
  }, [onOpenRelativePath, resolveAssetSrc, resolveAttachmentSrc]);
}

function FileMarkdownPreviewImpl({
  content,
  onOpenRelativePath,
  resolveAssetSrc,
  scrollBinding,
  diagramSaveDestination,
}: FileMarkdownPreviewProps): JSX.Element {
  const parsedContent = useMemo(
    () => parseFrontmatterAndBody(content),
    [content],
  );
  const options = useFileMarkdownOptions(onOpenRelativePath, resolveAssetSrc);

  return (
    <div
      ref={scrollBinding?.ref}
      onScroll={scrollBinding?.onScroll}
      onLoadCapture={scrollBinding?.onContentLoaded}
      className={`${REPLAY_BLOCK_CLASS} min-h-0 flex-1 overflow-auto`}
      data-testid="file-viewer-markdown-scroll"
    >
      <div
        className="flex flex-col min-w-0 px-6 py-6 gap-4"
        data-testid="file-markdown-preview"
      >
        <FrontmatterBlock frontmatter={parsedContent.frontmatter} />
        <DocumentProse variant="preview" {...MARKDOWN_ROOT_PROPS}>
          <MermaidExportProvider destination={diagramSaveDestination}>
            <Markdown options={options}>{parsedContent.body}</Markdown>
          </MermaidExportProvider>
        </DocumentProse>
      </div>
    </div>
  );
}

export const FileMarkdownPreview = memo(FileMarkdownPreviewImpl);

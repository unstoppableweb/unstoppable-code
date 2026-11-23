'use client';

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useOptionalCanopyClient } from '@canopy/app-state';
import type {
  RemoteControlFilePreview,
  RemoteControlFileReadPayload,
} from '@canopy/protocol/remote-control/shell';
import { turnFileHref } from '@canopy/protocol/turn-files';
import type { TurnFileRecord } from '@canopy/protocol/turn-files';
import {
  Button,
  Markdown,
  MarkdownCodeBlock,
  MarkdownTableBlock,
  Surface,
  markdownTableCellProps,
  TRANSCRIPT_MARKDOWN_OPTIONS,
  TRANSCRIPT_PROSE_CLASS,
} from '@canopy/ui-shared/components';
import { recordSurfacedError } from '@canopy/ui-shared/lib';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { parseCsvTableContent } from './file/FileCsvPreview';
import { fileExtension, resolveFileRenderKind } from './file/file-kind';

export interface InlineReplyPreviewContent extends Pick<
  RemoteControlFilePreview,
  'content' | 'language'
> {
  readonly truncated?: boolean;
  readonly rows?: readonly (readonly string[])[];
  readonly imageSource?: {
    readonly src: string;
    readonly dispose?: () => void;
  };
}

export type InlineReplyDocumentReader = (
  request: RemoteControlFileReadPayload,
  kind: 'pdf' | 'xlsx' | 'image',
  signal: AbortSignal,
) => Promise<InlineReplyPreviewContent | null>;

/** Saved and presented outputs get previews. Edit receipts stay in the files card. */
export function isInlineReplyOutput(
  file: Pick<TurnFileRecord, 'change' | 'saved'>,
): boolean {
  return file.change !== 'updated' || file.saved === true;
}

const CODE_EXTENSIONS = new Set([
  'txt',
  'js',
  'jsx',
  'mjs',
  'ts',
  'tsx',
  'py',
  'rb',
  'rs',
  'go',
  'java',
  'swift',
  'sh',
  'sql',
  'json',
  'jsonl',
  'xml',
  'yaml',
  'yml',
  'toml',
  'css',
  'scss',
  'html',
  'htm',
  'c',
  'h',
  'cpp',
]);
const MAX_INLINE_TEXT_LENGTH = 100_000;
const MAX_INLINE_TABLE_CELLS = 2_000;

// TODO(CAN-759): replace with a typed error code on the file read. A file
// deleted after lookup, one that cannot be read as text, or a cloud saved copy
// that has expired is an expected outcome: the preview just stays hidden.
function isExpectedPreviewOutcome(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('File not found:') ||
      error.message.includes('Binary files cannot be read') ||
      error.message.startsWith('Saved copy is no longer available'))
  );
}

export function InlineReplyFilePreview({
  path,
  projectId,
  worktreeId,
  chatId,
  readPreview,
  readDocument,
}: {
  readonly path: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId?: string;
  readonly readPreview?: (
    signal: AbortSignal,
  ) => Promise<InlineReplyPreviewContent | null>;
  readonly readDocument?: InlineReplyDocumentReader;
}): JSX.Element | null {
  const client = useOptionalCanopyClient();
  const marker = useRef<HTMLDivElement>(null);
  const [intersected, setIntersected] = useState(false);
  const [result, setResult] = useState<{
    scopeKey: symbol;
    preview: InlineReplyPreviewContent | null;
  }>();
  const scopeKey = useMemo(
    () => Symbol(),
    [projectId, worktreeId, chatId, path, client, readPreview, readDocument],
  );
  const fileName = path.split(/[\\/]/).pop() ?? path;
  // Saved paths are literal. URL syntax in the basename must not hide its extension.
  const literalPath = fileName.replace(/[?#]/g, '_');
  const extension = fileExtension(literalPath);
  const kind = resolveFileRenderKind({ path: literalPath });
  const markdown = kind === 'markdown';
  const image = kind === 'image' || kind === 'pdf';
  const documentKind =
    kind === 'xlsx' || kind === 'pdf' || (kind === 'image' && readDocument)
      ? kind
      : undefined;
  const table = extension === 'csv' || extension === 'tsv';
  const supported = documentKind
    ? !!(readPreview ?? readDocument)
    : image || markdown || table || CODE_EXTENSIONS.has(extension);
  const enabled =
    supported &&
    (readPreview !== undefined ||
      (client !== null && client.capabilities.fileSystemAccess !== 'none'));

  useEffect(() => {
    const node = marker.current;
    if (!enabled || !node || intersected) return;
    if (typeof IntersectionObserver === 'undefined') {
      setIntersected(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setIntersected(true);
    });
    observer.observe(node);
    return (): void => observer.disconnect();
  }, [enabled, intersected]);

  useEffect(() => {
    if (!enabled || !intersected) return;
    const controller = new AbortController();
    const { signal } = controller;
    let disposeImage: (() => void) | undefined;
    const show = (preview: InlineReplyPreviewContent | null): void => {
      if (signal.aborted) {
        preview?.imageSource?.dispose?.();
        return;
      }
      disposeImage = preview?.imageSource?.dispose;
      const oversizedText =
        !image &&
        preview !== null &&
        preview.content.length > MAX_INLINE_TEXT_LENGTH;
      setResult({
        scopeKey,
        preview: preview?.truncated || oversizedText ? null : preview,
      });
    };
    void (async (): Promise<void> => {
      if (readPreview) {
        show(await readPreview(signal));
        return;
      }
      if (!client) return;
      const target = await client.query('file.resolveLink', {
        projectId,
        worktreeId,
        href: turnFileHref(path),
        ...(chatId ? { chatId } : {}),
      });
      if (signal.aborted) return;
      if (!target) {
        setResult({ scopeKey, preview: null });
        return;
      }
      const request = {
        projectId,
        worktreeId,
        fileRootLocalId: target.fileRootLocalId,
        relativePath: target.relativePath,
      };
      const preview =
        documentKind && readDocument
          ? await readDocument(request, documentKind, signal)
          : await client.query('file.read', request);
      show(preview);
    })().catch((error: unknown) => {
      if (signal.aborted) return;
      setResult({ scopeKey, preview: null });
      if (isExpectedPreviewOutcome(error)) return;
      // The preview just stays hidden, so this records with no surface.
      recordSurfacedError({
        chokePoint: 'notice',
        identifier: 'inline-reply-file-preview',
        error,
      });
    });
    return (): void => {
      controller.abort();
      disposeImage?.();
    };
  }, [
    client,
    enabled,
    intersected,
    image,
    path,
    projectId,
    worktreeId,
    chatId,
    readPreview,
    readDocument,
    documentKind,
    scopeKey,
  ]);

  if (!enabled || (result?.scopeKey === scopeKey && result.preview === null))
    return null;
  const preview = result?.scopeKey === scopeKey ? result.preview : undefined;
  if (image && preview) {
    if (
      !preview.imageSource &&
      !/^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml);base64,/i.test(
        preview.content,
      )
    )
      return null;
    return (
      <Surface
        variant="transcript-well"
        replay="block"
        data-testid="inline-reply-file-preview"
        className="overflow-hidden"
      >
        <img
          className="block max-h-100 max-w-full object-contain"
          src={preview.imageSource?.src ?? preview.content}
          alt={fileName}
        />
      </Surface>
    );
  }
  return (
    <div ref={marker}>
      {preview ? (
        <PreviewBody
          key={path}
          preview={preview}
          markdown={markdown}
          language={preview.language ?? extension}
          delimiter={table ? (extension === 'tsv' ? '\t' : ',') : undefined}
        />
      ) : null}
    </div>
  );
}

function PreviewBody({
  preview,
  markdown,
  language,
  delimiter,
}: {
  readonly preview: InlineReplyPreviewContent;
  readonly markdown: boolean;
  readonly language: string;
  readonly delimiter?: string;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const tabular = delimiter !== undefined || preview.rows !== undefined;
  const rows =
    preview.rows ??
    (delimiter ? parseCsvTableContent(preview.content, delimiter).rows : null);
  const [head, ...body] = rows ?? [];
  const longText =
    !tabular &&
    (preview.content.length > 1800 || preview.content.split('\n').length > 24);
  const expandable = tabular ? body.length > 20 : longText;
  if (
    tabular &&
    (!head ||
      (rows?.reduce((total, row) => total + row.length, 0) ?? 0) >
        MAX_INLINE_TABLE_CELLS ||
      (rows?.reduce(
        (total, row) =>
          total + row.reduce((length, cell) => length + cell.length, 0),
        0,
      ) ?? 0) > MAX_INLINE_TEXT_LENGTH)
  )
    return null;

  const content = (
    <>
      <div
        className={`${TRANSCRIPT_PROSE_CLASS}${!expanded && longText ? ' max-h-150 overflow-hidden' : ''}`}
      >
        {head ? (
          <MarkdownTableBlock>
            <thead>
              <tr>
                {head.map((cell, index) => (
                  <th key={index} {...markdownTableCellProps(cell, true)}>
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(expanded ? body : body.slice(0, 20)).map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column} {...markdownTableCellProps(cell)}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </MarkdownTableBlock>
        ) : markdown ? (
          <Markdown options={TRANSCRIPT_MARKDOWN_OPTIONS}>
            {preview.content}
          </Markdown>
        ) : (
          <MarkdownCodeBlock>
            <code className={language ? `language-${language}` : undefined}>
              {preview.content}
            </code>
          </MarkdownCodeBlock>
        )}
      </div>
      {expandable ? (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            size="compact"
            aria-expanded={expanded}
            onClick={(): void => setExpanded(!expanded)}
          >
            {expanded
              ? 'Show less'
              : tabular
                ? `Show all ${body.length} rows`
                : 'Show more'}
          </Button>
        </div>
      ) : null}
    </>
  );

  if (tabular) {
    return (
      <div
        data-testid="inline-reply-file-preview"
        className={`min-w-0 ${REPLAY_BLOCK_CLASS}`}
      >
        <div className="flex min-w-0 max-w-full justify-start px-3">
          <div className="min-w-0 max-w-full">{content}</div>
        </div>
      </div>
    );
  }

  return (
    <Surface
      variant="transcript-well"
      replay="block"
      padding="compact"
      data-testid="inline-reply-file-preview"
      className="min-w-0"
    >
      {content}
    </Surface>
  );
}

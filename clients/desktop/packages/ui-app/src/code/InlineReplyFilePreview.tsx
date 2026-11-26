'use client';

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useOptionalCanopyClient } from '@canopy/app-state';
import type { RemoteControlFilePreview } from '@canopy/protocol/remote-control/shell';
import { turnFileHref } from '@canopy/protocol/turn-files';
import type { TurnFileRecord } from '@canopy/protocol/turn-files';
import {
  Button,
  MarkdownTableBlock,
  markdownTableCellProps,
  TRANSCRIPT_PROSE_CLASS,
} from '@canopy/ui-shared/components';
import { recordSurfacedError } from '@canopy/ui-shared/lib';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { parseCsvTableContent } from './file/FileCsvPreview';
import { fileExtension } from './file/file-kind';

export interface InlineReplyPreviewContent extends Pick<
  RemoteControlFilePreview,
  'content'
> {
  readonly truncated?: boolean;
}

/** Saved paths are literal: URL syntax in the basename must not hide its extension. */
function tableDelimiter(path: string): ',' | '\t' | undefined {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const extension = fileExtension(fileName.replace(/[?#]/g, '_'));
  if (extension === 'csv') return ',';
  if (extension === 'tsv') return '\t';
  return undefined;
}

/**
 * Saved and presented tables get previews. Other files, such as the code and
 * notes an agent writes while working, stay rows in the files card, and so do
 * edit receipts.
 */
export function isInlineReplyOutput(
  file: Pick<TurnFileRecord, 'path' | 'change' | 'saved'>,
): boolean {
  return (
    tableDelimiter(file.path) !== undefined &&
    (file.change !== 'updated' || file.saved === true)
  );
}

const MAX_INLINE_TEXT_LENGTH = 100_000;
const MAX_INLINE_TABLE_CELLS = 2_000;
const COLLAPSED_TABLE_ROWS = 20;

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
}: {
  readonly path: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId?: string;
  readonly readPreview?: (
    signal: AbortSignal,
  ) => Promise<InlineReplyPreviewContent | null>;
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
    [projectId, worktreeId, chatId, path, client, readPreview],
  );
  const delimiter = tableDelimiter(path);
  const enabled =
    delimiter !== undefined &&
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
    const show = (preview: InlineReplyPreviewContent | null): void => {
      if (signal.aborted) return;
      const complete =
        preview !== null &&
        !preview.truncated &&
        preview.content.length <= MAX_INLINE_TEXT_LENGTH;
      setResult({ scopeKey, preview: complete ? preview : null });
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
      show(
        await client.query('file.read', {
          projectId,
          worktreeId,
          fileRootLocalId: target.fileRootLocalId,
          relativePath: target.relativePath,
        }),
      );
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
    return (): void => controller.abort();
  }, [
    client,
    enabled,
    intersected,
    path,
    projectId,
    worktreeId,
    chatId,
    readPreview,
    scopeKey,
  ]);

  if (
    delimiter === undefined ||
    !enabled ||
    (result?.scopeKey === scopeKey && result.preview === null)
  )
    return null;
  const preview = result?.scopeKey === scopeKey ? result.preview : undefined;
  return (
    <div ref={marker}>
      {preview ? (
        <PreviewTable
          key={path}
          content={preview.content}
          delimiter={delimiter}
        />
      ) : null}
    </div>
  );
}

function PreviewTable({
  content,
  delimiter,
}: {
  readonly content: string;
  readonly delimiter: string;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const rows = parseCsvTableContent(content, delimiter).rows ?? [];
  const [head, ...body] = rows;
  if (
    !head ||
    rows.reduce((total, row) => total + row.length, 0) >
      MAX_INLINE_TABLE_CELLS ||
    rows.reduce(
      (total, row) =>
        total + row.reduce((length, cell) => length + cell.length, 0),
      0,
    ) > MAX_INLINE_TEXT_LENGTH
  )
    return null;

  return (
    <div
      data-testid="inline-reply-file-preview"
      className={`min-w-0 ${REPLAY_BLOCK_CLASS}`}
    >
      <div className="flex min-w-0 max-w-full justify-start px-3">
        <div className="min-w-0 max-w-full">
          <div className={TRANSCRIPT_PROSE_CLASS}>
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
                {(expanded ? body : body.slice(0, COLLAPSED_TABLE_ROWS)).map(
                  (row, index) => (
                    <tr key={index}>
                      {row.map((cell, column) => (
                        <td key={column} {...markdownTableCellProps(cell)}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ),
                )}
              </tbody>
            </MarkdownTableBlock>
          </div>
          {body.length > COLLAPSED_TABLE_ROWS ? (
            <div className="flex justify-center pt-2">
              <Button
                variant="secondary"
                size="compact"
                aria-expanded={expanded}
                onClick={(): void => setExpanded(!expanded)}
              >
                {expanded ? 'Show less' : `Show all ${body.length} rows`}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

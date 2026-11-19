'use client';

import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { fileViewerKey } from '@canopy/app-state';
import type { RemoteControlFileReadPayload } from '@canopy/protocol/remote-control/shell';
import {
  Surface,
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
} from '@canopy/ui-shared/components';
import type {
  FileContentScrollBinding,
  FileDocumentBytesResult,
} from './FileViewer';
import { NotebookView } from './notebook/NotebookView';
import { parseNotebook } from './notebook/parse-notebook';
import type {
  NotebookParseFailure,
  NotebookParseResult,
} from './notebook/notebook-types';

/** Short notice for a notebook whose JSON cannot be shown as a notebook. */
export function notebookParseFailureNotice(
  reason: NotebookParseFailure,
  truncated = false,
): string {
  const showing = sourceNotice(truncated);
  return reason === 'unsupported-version'
    ? `Only notebook format 4 can be formatted. ${showing}`
    : `This notebook can't be formatted. ${showing}`;
}

/** A truncated session shows only the file's head, so say so. */
function sourceNotice(truncated: boolean): string {
  return truncated ? 'Showing the start of its source.' : 'Showing its source.';
}

function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

export interface FileNotebookPreviewProps {
  readonly request: RemoteControlFileReadPayload;
  /** Parse of `content` already made by the viewer (untruncated files only). */
  readonly parsed: NotebookParseResult | null;
  readonly truncated: boolean;
  /** The file's version cookie; a change past a truncated head still bumps it. */
  readonly version: string;
  /** Loads the complete file when the text session is truncated. */
  readonly resolveDocumentBytes?: (
    request: RemoteControlFileReadPayload,
    signal: AbortSignal,
  ) => Promise<FileDocumentBytesResult>;
  readonly documentRetryGeneration: number;
  /** The viewer's source body, shown under a notice when preview fails. */
  readonly rawBody: ReactNode;
  readonly onOpenRelativePath?: (path: string) => void;
  readonly resolveAssetSrc?: (
    src: string,
  ) => string | Promise<string | null> | null;
  readonly scrollBinding?: FileContentScrollBinding;
}

type FullNotebookState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly result: NotebookParseResult }
  | { readonly status: 'too-large'; readonly maxBytes: number }
  | { readonly status: 'failed' };

function NotebookSourceFallback({
  notice,
  rawBody,
}: {
  readonly notice: string;
  readonly rawBody: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Surface variant="section" boundary="bottom">
        <div
          className="px-4 py-2 text-xs fg-secondary"
          data-testid="file-notebook-notice"
        >
          {notice}
        </div>
      </Surface>
      {rawBody}
    </div>
  );
}

/**
 * Loads the complete notebook through the host byte resolver when the text
 * session holds only the first part of a large file, then parses it once.
 */
function useFullNotebook(
  request: RemoteControlFileReadPayload,
  version: string,
  enabled: boolean,
  resolveDocumentBytes: FileNotebookPreviewProps['resolveDocumentBytes'],
  retryGeneration: number,
): FullNotebookState {
  const requestKey = fileViewerKey(request);
  const [state, setState] = useState<FullNotebookState>({ status: 'loading' });
  useEffect(() => {
    if (!enabled || resolveDocumentBytes === undefined) return;
    const controller = new AbortController();
    let active = true;
    setState({ status: 'loading' });
    void resolveDocumentBytes(request, controller.signal).then(
      (result) => {
        if (!active) return;
        if (result.status === 'ready') {
          const text = new TextDecoder('utf-8').decode(result.bytes);
          setState({ status: 'ready', result: parseNotebook(text) });
        } else if (result.status === 'too-large') {
          setState({ status: 'too-large', maxBytes: result.maxBytes });
        } else {
          setState({ status: 'failed' });
        }
      },
      () => {
        if (active) setState({ status: 'failed' });
      },
    );
    return (): void => {
      active = false;
      controller.abort();
    };
    // `requestKey` identifies the request. A truncated head can stay identical
    // when later cells change, so the file `version` drives the reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, version, enabled, resolveDocumentBytes, retryGeneration]);
  return state;
}

/**
 * The rendered view of a `.ipynb` file. It renders from the text session, so
 * it works on every host; a truncated session loads the complete file through
 * the host byte resolver. Any failure keeps the source on screen with a short
 * notice, so a notebook never renders worse than its raw JSON.
 */
export function FileNotebookPreview({
  request,
  parsed,
  truncated,
  version,
  resolveDocumentBytes,
  documentRetryGeneration,
  rawBody,
  onOpenRelativePath,
  resolveAssetSrc,
  scrollBinding,
}: FileNotebookPreviewProps): JSX.Element {
  const full = useFullNotebook(
    request,
    version,
    truncated,
    resolveDocumentBytes,
    documentRetryGeneration,
  );

  let result: NotebookParseResult | null = parsed;
  if (truncated) {
    if (resolveDocumentBytes === undefined) {
      return (
        <NotebookSourceFallback
          notice={`This notebook is too large to preview here. ${sourceNotice(true)}`}
          rawBody={rawBody}
        />
      );
    }
    if (full.status === 'loading') {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <DelayedLoadingPlaceholder>
            <CenteredLoadingSpinner spacing="section" />
          </DelayedLoadingPlaceholder>
        </div>
      );
    }
    if (full.status === 'too-large') {
      return (
        <NotebookSourceFallback
          notice={`This notebook exceeds the ${formatMegabytes(full.maxBytes)} preview limit. ${sourceNotice(true)}`}
          rawBody={rawBody}
        />
      );
    }
    if (full.status === 'failed') {
      return (
        <NotebookSourceFallback
          notice={`This notebook couldn't be loaded for preview. ${sourceNotice(true)}`}
          rawBody={rawBody}
        />
      );
    }
    result = full.result;
  }
  if (result === null) {
    return (
      <NotebookSourceFallback
        notice={`This notebook can't be formatted. ${sourceNotice(truncated)}`}
        rawBody={rawBody}
      />
    );
  }
  if (result.status === 'failed') {
    return (
      <NotebookSourceFallback
        notice={notebookParseFailureNotice(result.reason, truncated)}
        rawBody={rawBody}
      />
    );
  }
  return (
    <NotebookView
      notebook={result.notebook}
      onOpenRelativePath={onOpenRelativePath}
      resolveAssetSrc={resolveAssetSrc}
      scrollBinding={scrollBinding}
    />
  );
}

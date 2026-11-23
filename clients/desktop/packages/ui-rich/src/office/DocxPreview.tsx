'use client';

import {
  DEFAULT_OFFICE_PREVIEW_COPY,
  type OfficePreviewCopy,
  type OfficePreviewRenderFailure,
} from './office-preview-copy';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
} from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { useEffect, useState, type JSX } from 'react';
import { buildDocxPreviewSrcDoc, sanitizeDocxHtml } from './docx-sanitize';
import {
  officePreviewRenderFailure,
  parseOfficeDocument,
} from './office-parse-client';
import { OfficePreviewBanner } from './OfficePreviewBanner';
import { OfficeDocumentFrame } from './OfficeDocumentSurface';

export interface DocxPreviewProps {
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
  readonly createWorker: () => Worker;
  readonly copy?: OfficePreviewCopy;
  /** `error` accompanies a `worker-defect` only, for the host to record. */
  readonly onRenderFailure: (
    failure: OfficePreviewRenderFailure,
    error?: unknown,
  ) => void;
}

type State =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly bytes: ArrayBuffer;
      readonly srcDoc: string;
    };

export function DocxPreview({
  bytes,
  fileName,
  createWorker,
  copy = DEFAULT_OFFICE_PREVIEW_COPY,
  onRenderFailure,
}: DocxPreviewProps): JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    void (async (): Promise<void> => {
      try {
        const result = await parseOfficeDocument(
          { kind: 'docx', bytes },
          { createWorker, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (result.kind !== 'docx') throw new Error('Unexpected parse result.');
        setState({
          status: 'ready',
          bytes,
          srcDoc: buildDocxPreviewSrcDoc(sanitizeDocxHtml(result.html)),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (officePreviewRenderFailure(error) === 'worker-defect')
          onRenderFailure('worker-defect', error);
        else onRenderFailure('parse-failed');
      }
    })();
    return (): void => controller.abort();
  }, [bytes, createWorker, onRenderFailure]);

  return (
    <div
      className={`${REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 flex-col`}
      data-testid="docx-preview"
    >
      <OfficePreviewBanner text={copy.banner} />
      {state.status === 'loading' || state.bytes !== bytes ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center"
          data-testid="docx-preview-loading"
        >
          <DelayedLoadingPlaceholder>
            <CenteredLoadingSpinner spacing="section" />
          </DelayedLoadingPlaceholder>
        </div>
      ) : (
        <OfficeDocumentFrame
          title={fileName}
          srcDoc={state.srcDoc}
          data-testid="docx-preview-frame"
        />
      )}
    </div>
  );
}

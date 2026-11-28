'use client';

import { useMemo, type JSX } from 'react';
import type { PdfPreviewAssets } from '@canopy/ui-rich/pdf';
import { FindablePdfPreview } from '../pdf-preview';

/** A PDF artifact through the shared PDF preview. Loaded lazily by kind. */
export function PdfArtifact({
  bytes,
  title,
  resolveAssets,
  onFailure,
}: {
  readonly bytes: Uint8Array;
  readonly title: string;
  readonly resolveAssets: (pdfJsVersion: string) => PdfPreviewAssets;
  readonly onFailure: () => void;
}): JSX.Element {
  // PDF.js may transfer the buffer, so it gets its own copy.
  const buffer = useMemo(() => new Uint8Array(bytes).buffer, [bytes]);
  return (
    <div
      className="flex h-[calc(100dvh-12rem)] min-h-80 w-full flex-col"
      data-testid="shared-artifact-pdf"
    >
      <FindablePdfPreview
        bytes={buffer}
        fileName={title}
        resolveAssets={resolveAssets}
        onRenderFailure={onFailure}
      />
    </div>
  );
}

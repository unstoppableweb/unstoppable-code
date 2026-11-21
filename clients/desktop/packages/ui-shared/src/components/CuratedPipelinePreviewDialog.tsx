'use client';

import type { JSX, ReactNode } from 'react';
import {
  CuratedPipelineCatalog,
  type CuratedPipelineCatalogProps,
} from './CuratedPipelineCatalog';
import { DialogModal } from './DialogModal';
import { SPACE_ROLE_GAP_CLASS, type SpaceRole } from './Stack';

export interface CuratedPipelinePreviewDialogProps {
  catalog: CuratedPipelineCatalogProps;
  breadcrumbs?: ReactNode;
  /** Gap after margin-free breadcrumbs; omitted retains the existing placement. */
  breadcrumbsGap?: SpaceRole;
}

/**
 * The preview a curated pipeline row opens from a Browse list. Only the
 * selected template mounts; discovery stays in the host's unified list.
 */
export function CuratedPipelinePreviewDialog({
  catalog,
  breadcrumbs,
  breadcrumbsGap,
}: CuratedPipelinePreviewDialogProps): JSX.Element | null {
  if (!catalog.selectedKey) return null;
  return (
    <DialogModal
      title="Preview workflow"
      onClose={catalog.onBack}
      maxWidth="3xl"
      dataTestId="curated-pipeline-preview-dialog"
      trapFocus
    >
      <div
        className={
          breadcrumbsGap === undefined
            ? ''
            : `flex flex-col ${SPACE_ROLE_GAP_CLASS[breadcrumbsGap]}`
        }
      >
        {breadcrumbs}
        <CuratedPipelineCatalog {...catalog} rows={[]} />
      </div>
    </DialogModal>
  );
}

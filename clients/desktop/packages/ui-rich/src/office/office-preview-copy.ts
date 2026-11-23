/** Hosts supply complete recovery sentences. */
export interface OfficePreviewCopy {
  readonly banner: string;
  readonly truncationRecovery: string;
}

/**
 * `parse-failed` is a document the parser refused or could not finish;
 * `worker-defect` is a parser defect or worker crash, which hosts record.
 * Both show the same recovery card.
 */
export type OfficePreviewRenderFailure = 'parse-failed' | 'worker-defect';

export const DEFAULT_OFFICE_PREVIEW_COPY: OfficePreviewCopy = {
  banner:
    'Semantic preview: formatting may differ; download for the exact document.',
  truncationRecovery: 'Download the workbook to see everything.',
};

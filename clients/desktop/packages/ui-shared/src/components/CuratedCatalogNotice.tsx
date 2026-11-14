import type { JSX } from 'react';
import { Notice, NoticeButton } from './Notice';
import { curatedPipelineStaleMessage } from './CuratedPipelineCatalog';

export interface CuratedCatalogNoticeProps {
  readonly error: string | null;
  readonly stale: boolean;
  readonly onRetry: () => void;
  readonly cloudDisplayName: string;
}

/** The shared failure or saved-copy notice for the curated pipeline catalog. */
export function CuratedCatalogNotice({
  error,
  stale,
  onRetry,
  cloudDisplayName,
}: CuratedCatalogNoticeProps): JSX.Element | null {
  if (error)
    return (
      <Notice
        errorSource="plugins-curated-pipelines-error"
        intent="destructive"
        role="none"
        title="Couldn't load curated workflows."
        data-testid="plugins-curated-pipelines-error"
        actions={<NoticeButton onClick={onRetry}>Try again</NoticeButton>}
      >
        {error}
      </Notice>
    );
  if (stale)
    return (
      <Notice
        intent="neutral"
        role="none"
        data-testid="plugins-curated-pipelines-stale"
      >
        {curatedPipelineStaleMessage(cloudDisplayName)}
      </Notice>
    );
  return null;
}

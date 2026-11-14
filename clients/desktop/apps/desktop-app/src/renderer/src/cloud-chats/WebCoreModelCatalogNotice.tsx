import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { retryWebCoreModels } from '@/stores/chat/web-core';
import { useWebCoreModelCatalogStore } from '@/stores/chat/web-core/model-catalog';

/**
 * A cloud chat whose workspace models could not be read, after the loader's
 * own retries (CAN-6615): the composer says so and offers Try again, instead
 * of a raw model id and a Send that never enables. Nothing shows otherwise.
 */
export function WebCoreModelCatalogNotice({
  projectId,
}: {
  readonly projectId: string;
}): JSX.Element | null {
  const failed = useWebCoreModelCatalogStore(
    (state) => state.failed[projectId] === true,
  );
  if (!failed) return null;
  return (
    <Notice
      errorSource="cloud-model-catalog-load"
      intent="destructive"
      title="Models didn't load"
      data-testid="chat-input-cloud-models-failed"
      actions={
        <NoticeButton
          variant="secondary"
          onClick={(): void => {
            void retryWebCoreModels(projectId);
          }}
          data-testid="chat-input-cloud-models-retry"
        >
          Try again
        </NoticeButton>
      }
    >
      This chat can't send until its models load.
    </Notice>
  );
}

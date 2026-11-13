import type { JSX } from 'react';
import { Button } from '@canopy/ui-shared/components';
import { CloseIcon } from '@canopy/ui-shared/icons';
import { Surface } from '@canopy/ui-shared/components';

export interface PendingAttachmentChip {
  localId: string;
  filename: string;
  state: 'staged' | 'uploading' | 'ready' | 'error';
  error?: string;
}

export function PendingAttachmentRow({
  attachments,
  onRemove,
  onRetry,
}: {
  attachments: readonly PendingAttachmentChip[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}): JSX.Element | null {
  if (attachments.length === 0) return null;
  return (
    <div
      className="flex gap-2 overflow-x-auto px-3 pb-2"
      data-testid="portal-pending-attachments"
    >
      {attachments.map((attachment) => (
        <Surface
          variant="outline"
          className="max-w-64 shrink-0"
          key={attachment.localId}
          data-state={attachment.state}
          title={attachment.error ?? attachment.filename}
        >
          <div className="flex items-center gap-2 py-0.5 pl-2.5 pr-0.5 text-xs">
            {attachment.state === 'uploading' ? (
              <span
                className="h-3 w-3 animate-spin rounded-full border-2 border-fg-secondary border-t-transparent"
                aria-label="Uploading"
              />
            ) : null}
            <span className="truncate">{attachment.filename}</span>
            {attachment.state === 'error' ? (
              <Button
                variant="link"
                onClick={(): void => onRetry(attachment.localId)}
                aria-label={`Try again for ${attachment.filename}`}
              >
                Try again
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              onClick={(): void => onRemove(attachment.localId)}
              aria-label={`Remove ${attachment.filename}`}
            >
              <CloseIcon size={14} aria-hidden />
            </Button>
          </div>
        </Surface>
      ))}
    </div>
  );
}

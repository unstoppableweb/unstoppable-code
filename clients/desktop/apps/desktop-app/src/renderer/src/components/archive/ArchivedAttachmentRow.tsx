import type { JSX, MouseEvent } from 'react';
import { Button, Surface } from '@canopy/ui-shared/components';
import { FileTypeIcon } from '@canopy/ui-shared/icons';
import { formatDateOrEmpty } from '@/lib/format';

interface ArchivedAttachmentRowProps {
  readonly filename: string;
  readonly createdAt: string;
  readonly onReveal: () => void;
  readonly onMouseEnter?: (event: MouseEvent<HTMLDivElement>) => void;
  readonly onMouseLeave?: () => void;
}

/** One retained attachment: its file icon, name, date, and Reveal. */
export function ArchivedAttachmentRow({
  filename,
  createdAt,
  onReveal,
  onMouseEnter,
  onMouseLeave,
}: ArchivedAttachmentRowProps): JSX.Element {
  return (
    <Surface
      variant="group"
      size="small"
      className="group"
      data-testid={`archived-attachment-row-${filename}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <FileTypeIcon filename={filename} size="sm" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium fg-primary">
          {filename}
        </span>
        <span className="shrink-0 text-2xs fg-secondary">
          {formatDateOrEmpty(createdAt)}
        </span>
        {/* Hover-revealed, and shown while focused inside. */}
        <span className="shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Button
            size="compact"
            data-testid={`archived-attachment-reveal-${filename}`}
            onClick={onReveal}
          >
            Reveal
          </Button>
        </span>
      </div>
    </Surface>
  );
}

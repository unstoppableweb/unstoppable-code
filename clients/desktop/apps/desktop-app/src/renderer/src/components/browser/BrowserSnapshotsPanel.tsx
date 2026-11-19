import { ImageThumbnail } from '@canopy/ui-shared/components';
import { type JSX } from 'react';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { ChatIcon, TrashIcon } from '@canopy/ui-shared/icons';
import {
  useBrowserStore,
  type BrowserScreenshotEntry,
} from '@/stores/browserStore';
import { stageBrowserScreenshot } from '@/lib/browserChatStaging';
import { Button, Tooltip } from '@canopy/ui-shared';
import { EmptyState, Surface } from '@canopy/ui-shared/components';

interface BrowserSnapshotsPanelProps {
  browserId: string;
}

const EMPTY: BrowserScreenshotEntry[] = [];

export function BrowserSnapshotsPanel({
  browserId,
}: BrowserSnapshotsPanelProps): JSX.Element {
  const snapshots = useBrowserStore((s) => s.screenshots[browserId] ?? EMPTY);
  const markAttached = useBrowserStore((s) => s.markScreenshotAttached);
  const removeScreenshot = useBrowserStore((s) => s.removeScreenshot);

  const handleAttach = async (entry: BrowserScreenshotEntry): Promise<void> => {
    if (!entry.attachmentPath) {
      return;
    }
    if (await stageBrowserScreenshot(entry.attachmentPath)) {
      markAttached(browserId, entry.id);
    }
  };

  if (snapshots.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState inset="none" title="No snapshots yet" />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <ul className="flex flex-col gap-2">
        {[...snapshots].reverse().map((entry) => (
          <Surface
            as="li"
            variant="outline"
            size="small"
            padding="tight"
            key={entry.id}
          >
            <div className="flex items-center gap-2">
              {entry.dataUrl && (
                <ImageThumbnail
                  variant="browser-snapshot"
                  src={entry.dataUrl}
                  alt={entry.filename}
                />
              )}
              <span
                className="min-w-0 flex-1 truncate font-mono text-2xs"
                title={entry.filename}
              >
                {entry.filename}
              </span>
              {entry.attachmentPath &&
                (entry.attached ? (
                  <span className="shrink-0 text-2xs fg-secondary">
                    Attached
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={(): void => {
                      void handleAttach(entry);
                    }}
                  >
                    <ChatIcon size="sm" />
                    <span>{CHAT_UNIT_LABEL}</span>
                  </Button>
                ))}
              <Tooltip label="Delete snapshot">
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly
                  onClick={(): void => removeScreenshot(browserId, entry.id)}
                  aria-label="Delete snapshot"
                >
                  <TrashIcon size="sm" />
                </Button>
              </Tooltip>
            </div>
          </Surface>
        ))}
      </ul>
    </div>
  );
}

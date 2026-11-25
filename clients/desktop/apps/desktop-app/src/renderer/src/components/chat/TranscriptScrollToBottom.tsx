import { ScrollToBottomButton } from '@canopy/ui-shared/components';
import { memo, useSyncExternalStore, type JSX } from 'react';
import type { ScrollButtonVisibility } from './transcript-scroll-button-visibility';

export const TranscriptScrollToBottom = memo(function TranscriptScrollToBottom({
  visibility,
  onClick,
}: {
  visibility: ScrollButtonVisibility;
  onClick: () => void;
}): JSX.Element | null {
  const visible = useSyncExternalStore(visibility.subscribe, visibility.get);
  if (!visible) return null;
  return (
    // Above the pinned user bubble (z-20).
    <div className="absolute left-1/2 bottom-3 z-30 flex -translate-x-1/2">
      <ScrollToBottomButton
        onClick={onClick}
        dataTestId="chat-scroll-to-bottom"
        ariaLabel="Scroll to bottom"
      />
    </div>
  );
});

import type { JSX, ReactNode } from 'react';
import { CompactQueueProvider } from './chat/QueuedMessageRow';
import { PrHoverCardsProvider } from './pr-hover-cards';
import { SmoothStreamingProvider } from './streaming-text';

/** Graduated product presentation, shared by desktop and web, including guests. */
export function StandardPresentationProvider({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <PrHoverCardsProvider value>
      <SmoothStreamingProvider value>
        <CompactQueueProvider value>{children}</CompactQueueProvider>
      </SmoothStreamingProvider>
    </PrHoverCardsProvider>
  );
}

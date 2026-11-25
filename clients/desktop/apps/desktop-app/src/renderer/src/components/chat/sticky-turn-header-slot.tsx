import {
  createContext,
  useState,
  type JSX,
  type ReactNode,
  type RefCallback,
} from 'react';

/**
 * The slot under a section's sticky prompt that its head turn's header
 * renders into (through a portal), so the prompt and the header pin as one
 * box: one backing, one bottom edge at the header's hairline, no measured
 * offset between them. `null` until the head mounts, and outside sections.
 */
export const StickyTurnHeaderSlotContext = createContext<HTMLElement | null>(
  null,
);

/**
 * Holds one section's slot. The sticky head receives the ref; the section's
 * turns read the element from context.
 */
export function StickyTurnHeaderSlotScope({
  children,
}: {
  children: (slotRef: RefCallback<HTMLDivElement>) => ReactNode;
}): JSX.Element {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <StickyTurnHeaderSlotContext.Provider value={slot}>
      {children(setSlot)}
    </StickyTurnHeaderSlotContext.Provider>
  );
}

import { createContext } from 'react';

/** The lab's Light / Dark switch, read by every stage for its theme. */
export type LabColorMode = 'light' | 'dark';

export const LabColorModeContext = createContext<LabColorMode>('light');

/**
 * True inside the overview grid, where every stage is cropped to the same 4:3
 * card: the stage takes that ratio as its own design size, so the animation
 * fills the card edge to edge.
 */
export const LabOverviewContext = createContext(false);

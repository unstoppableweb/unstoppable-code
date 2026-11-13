'use client';
import { createContext } from 'react';
/** The legacy standalone tray keeps its established host behavior. */
export const DrawerRowPresentationContext = createContext<
  'legacy' | 'drawer' | 'modal'
>('legacy');

/**
 * A list of drawer rows. Rows touch, with no gap: every card's rows (and the
 * completed-work dialog's) share one 36px geometry and one rhythm, whatever
 * component builds them. Queued rows match it in `QueuedMessageStack`.
 */
export const DRAWER_ROW_LIST_CLASS = 'flex flex-col';

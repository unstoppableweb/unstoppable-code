'use client';

import { createContext, type JSX, type ReactNode } from 'react';
import type { LayoutTier } from '../lib/layout-tier';

/**
 * Carries a FIRST-PAINT SEED for {@link useLayoutTier}, and nothing else.
 *
 * `useMediaQuery` has no viewport during a server render, so it has always
 * answered `false` ("not mobile") for its server snapshot and for the
 * hydration pass. On a phone that means the browser paints the desktop shell —
 * no mobile top bar, inline composer chips instead of the overflow menu — and
 * then snaps to the mobile layout the moment `matchMedia` resolves.
 *
 * The server can do better than a guess: it has the request User Agent, which
 * is enough to know a phone from a desktop most of the time. Threading that
 * answer down through this provider makes the hydration render agree with the
 * frame the browser would have painted anyway.
 *
 * THIS IS A SEED, NOT A SOURCE OF TRUTH, and the distinction is the whole
 * design. A User Agent knows a device class; it cannot know a viewport width,
 * a split-screen tablet, or a desktop window dragged narrow. So the value here
 * is used for exactly one render — the hydration pass — and the client's
 * `matchMedia` subscription takes over immediately after and wins every
 * disagreement.
 *
 * `null` means unseeded, which is the correct state for every surface that
 * does not server-render (the marketing homepage mounts its composer through
 * `next/dynamic({ ssr: false })`) and for the Electron renderer. Unseeded
 * consumers behave exactly as they did before this module existed.
 */
export const LayoutTierContext = createContext<LayoutTier | null>(null);

export interface LayoutTierProviderProps {
  /**
   * The seed. Pass the server's User-Agent-derived tier. Passing `undefined`
   * is meaningful and supported: it means "no better information than the
   * client subscription", not "desktop".
   */
  readonly tier?: LayoutTier;
  readonly children: ReactNode;
}

/**
 * Publishes the server-seeded tier to the tree below.
 *
 * Deliberately renders no DOM. It sits at the top of a chat surface, and a
 * wrapper element there would land inside the `h-full`/`min-h-0` flex chains
 * the composer hero centres against — changing the very rectangle those
 * surfaces exist to hold fixed.
 */
export function LayoutTierProvider({
  tier,
  children,
}: LayoutTierProviderProps): JSX.Element {
  return (
    <LayoutTierContext.Provider value={tier ?? null}>
      {children}
    </LayoutTierContext.Provider>
  );
}

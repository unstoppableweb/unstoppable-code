import type { RemoteControlSessionShellState } from '@canopy/protocol/remote-control/shell';

/**
 * The neutral, transport-agnostic view-model the shared UI renders.
 *
 * The web app already projects this exact shape from Prisma
 * (`state-projection.ts`); the desktop adapter will project the same shape
 * from its in-memory stores. Sourcing it from the portal wire contract keeps a
 * single source of truth — the web adapter's mapping is then mostly identity.
 *
 * Re-exported as `SessionViewModel` so feature code reads it under a
 * transport-neutral name rather than the portal-flavoured one.
 */
export type SessionViewModel = RemoteControlSessionShellState;

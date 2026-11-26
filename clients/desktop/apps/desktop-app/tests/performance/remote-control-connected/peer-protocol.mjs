/**
 * What the runner and the scripted peer (`scripted-host.mjs`) share. Kept free of imports so their bundles
 * stay small.
 */

/** Every line a scripted peer writes for the runner starts with this. */
export const PEER_LINE_PREFIX = '@@canopy-perf-peer ';

/** The one-window `sidebar` capability's two channels. */
export const SESSION_SNAPSHOT_CHANNEL = 'desktop:session-snapshot';
export const SESSION_SNAPSHOT_STALE_CHANNEL = 'desktop:session-snapshot-stale';

/** A snapshot read still in flight this long after it started is stuck. */
export const STUCK_READ_MS = 5_000;

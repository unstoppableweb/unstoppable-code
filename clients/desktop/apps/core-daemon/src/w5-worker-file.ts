// Imported by scripts/build-core-daemon.mjs under plain Node: no imports.

/**
 * The W5 commit log worker bundle every daemon build stages beside the
 * executable (W5b, CAN-5450; CAN-5529).
 */
export const DAEMON_W5_WORKER_FILE = 'w5-commit-log-worker.js';

/**
 * win32: the owned-child addon every Windows build stages beside the daemon
 * executable, from which the W5 worker loads its handle-confined capture
 * reader (CAN-5530). The daemon never spawns through it.
 */
export const DAEMON_W5_CONFINEMENT_ADDON_FILE = 'core-owned-child.node';

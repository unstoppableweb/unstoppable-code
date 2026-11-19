import {
  LEGACY_PORTAL_STATE_FILE_MAX_BYTES,
  legacyPortalStateFilePath,
  readJsonFileForIdentity,
} from '../lib/install-identity';

/** The stop reasons the Portal store's normalizer kept. */
const KNOWN_STOP_REASONS: ReadonlySet<unknown> = new Set([
  'local_disconnect',
  'replaced',
  'app_shutdown',
  'server_disconnect',
]);

/**
 * The legacy Portal opt-in as `portal-state.json` records it.
 * `reliable: false` means the file could not be read this time, so the
 * one-time `allowIncoming` migration waits and retries.
 */
export type LegacyPortalOptInRead =
  | { reliable: true; active: boolean }
  | { reliable: false };

/**
 * Reads the Portal opt-in from `portal-state.json` without writing it: an
 * active session that was not stopped on purpose, the same test Portal's own
 * resume applied. A missing, oversized or unparseable file reads as "not
 * active" (the old store replaced an unparseable file with fresh state, so the
 * next launch already read it that way); only a transient read error is
 * unreliable.
 */
export async function readLegacyPortalOptIn(): Promise<LegacyPortalOptInRead> {
  let read: Awaited<ReturnType<typeof readJsonFileForIdentity>>;
  try {
    read = await readJsonFileForIdentity(
      legacyPortalStateFilePath(),
      LEGACY_PORTAL_STATE_FILE_MAX_BYTES,
    );
  } catch {
    return { reliable: false };
  }
  if (read.kind !== 'parsed') return { reliable: true, active: false };
  const state = read.value;
  // The same shape test the Portal store's normalizer applied: anything else
  // was replaced with fresh, inactive state on load.
  if (
    typeof state !== 'object' ||
    state === null ||
    Reflect.get(state, 'version') !== 1 ||
    typeof Reflect.get(state, 'clientDeviceId') !== 'string'
  ) {
    return { reliable: true, active: false };
  }
  // The normalizer kept only the stop reasons it knew and dropped any other
  // value, which then read as "not stopped".
  const storedStopReason: unknown = Reflect.get(state, 'lastStopReason');
  const lastStopReason = KNOWN_STOP_REASONS.has(storedStopReason)
    ? storedStopReason
    : undefined;
  const active =
    hasActiveSession(Reflect.get(state, 'activeSession')) &&
    (lastStopReason === undefined || lastStopReason === 'app_shutdown');
  return { reliable: true, active };
}

function hasActiveSession(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'serverId') === 'string' &&
    typeof Reflect.get(value, 'sessionId') === 'string' &&
    typeof Reflect.get(value, 'commandCursor') === 'number'
  );
}

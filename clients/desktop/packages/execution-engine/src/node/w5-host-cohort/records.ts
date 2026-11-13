import type { PlatformProcessInspection } from '@canopy/core-runtime';

// TRANSITIONAL (CAN-3797 W11): remove when the W5 rows move to `daemon` and the
// legacy writers are deleted (CAN-3795 / CAN-3802).

/** A process that may write W5 through a legacy host. */
export type W5HostKind = 'electron' | 'cli' | 'create-worktree' | 'lazy-writer';

export interface W5HostMemberRecord {
  readonly pid: number;
  /** `Date.now() − process.uptime()·1000` at registration. */
  readonly startEstimateMs: number;
  readonly hostKind: string;
}

export interface W5MaintenanceRecord {
  readonly pid: number;
  readonly startIdentity: string;
  readonly token: string;
}

export type W5ProcessLiveness = 'live' | 'departed' | 'unknown';

/**
 * Window, relative to `ps`'s whole-second start, in which a member's own
 * start estimate names the same process. Measured offsets were +163..+1121 ms
 * (Node, Electron main at whenReady, ELECTRON_RUN_AS_NODE; macOS, n=33). The
 * estimate cannot precede the truncated `ps` second, so the 1 s lower margin
 * only absorbs clock slew. Wider fails closed (a reused PID reads as live);
 * narrower would prune a live host.
 */
export const W5_START_MATCH_WINDOW_MS = { before: 1_000, after: 3_000 };

export const W5_RECORD_MAX_BYTES = 4096;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DARWIN_IDENTITY = /^darwin:v1:([1-9]\d*):(\d+)$/;

function field(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function isPid(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 2_147_483_647
  );
}

function parseObject(text: string): object | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw
    : null;
}

export function encodeMemberRecord(record: W5HostMemberRecord): string {
  return JSON.stringify({ version: 1, ...record });
}

export function encodeMaintenanceRecord(record: W5MaintenanceRecord): string {
  return JSON.stringify({ version: 1, ...record });
}

/** `null` for anything this version cannot read; callers treat it as live. */
export function decodeMemberRecord(text: string): W5HostMemberRecord | null {
  const raw = parseObject(text);
  if (!raw) return null;
  const pid = field(raw, 'pid');
  const startEstimateMs = field(raw, 'startEstimateMs');
  const hostKind = field(raw, 'hostKind');
  if (
    field(raw, 'version') !== 1 ||
    !isPid(pid) ||
    typeof startEstimateMs !== 'number' ||
    !Number.isSafeInteger(startEstimateMs) ||
    startEstimateMs <= 0 ||
    typeof hostKind !== 'string' ||
    hostKind.length === 0 ||
    hostKind.length > 64
  )
    return null;
  return { pid, startEstimateMs, hostKind };
}

export function decodeMaintenanceRecord(
  text: string,
): W5MaintenanceRecord | null {
  const raw = parseObject(text);
  if (!raw) return null;
  const pid = field(raw, 'pid');
  const startIdentity = field(raw, 'startIdentity');
  const token = field(raw, 'token');
  if (
    field(raw, 'version') !== 1 ||
    !isPid(pid) ||
    typeof startIdentity !== 'string' ||
    startIdentity.length === 0 ||
    startIdentity.length > 256 ||
    typeof token !== 'string' ||
    !UUID.test(token)
  )
    return null;
  return { pid, startIdentity, token };
}

/**
 * Only macOS identities carry a wall-clock start; Linux start ticks are
 * boot-relative, so a running Linux PID stays unknown and is never pruned.
 */
export function memberLiveness(
  record: W5HostMemberRecord,
  inspection: PlatformProcessInspection,
): W5ProcessLiveness {
  if (inspection.state === 'absent') return 'departed';
  if (inspection.state !== 'running') return 'unknown';
  const identity = DARWIN_IDENTITY.exec(inspection.startIdentity);
  if (!identity || Number(identity[1]) !== record.pid) return 'unknown';
  const offset = record.startEstimateMs - Number(identity[2]) * 1000;
  const { before, after } = W5_START_MATCH_WINDOW_MS;
  return offset >= -before && offset <= after ? 'live' : 'departed';
}

export function maintenanceOwnerLiveness(
  record: W5MaintenanceRecord,
  inspection: PlatformProcessInspection,
): W5ProcessLiveness {
  if (inspection.state === 'absent') return 'departed';
  if (inspection.state !== 'running') return 'unknown';
  return inspection.startIdentity === record.startIdentity
    ? 'live'
    : 'departed';
}

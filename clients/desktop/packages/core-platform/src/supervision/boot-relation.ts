import type {
  PlatformOperatingSystem,
  PlatformSupervisionServices,
} from '@canopy/core-runtime';
import { readProc } from './inspect';
import type { SupervisionOperations } from './shared';

/**
 * Evidence only for descriptors retained in this host's private runtime.
 * Different Linux boot IDs prove different boots, not chronology or host.
 * Darwin clock steps beyond the tolerance can falsely authorize recovery;
 * departed-owner proof does not independently establish socket provenance.
 */
export function createBootRelation(
  os: PlatformOperatingSystem,
  ops: SupervisionOperations,
): NonNullable<PlatformSupervisionServices['bootRelation']> {
  return async ({ startIdentity, signal }) => {
    signal?.throwIfAborted();
    try {
      if (os === 'darwin') {
        const match = /^darwin:v1:([1-9]\d*):([1-9]\d*)$/.exec(startIdentity);
        if (!match || !ops.now || !ops.uptimeSeconds) return 'unknown';
        const pid = Number(match[1]);
        const epoch = Number(match[2]);
        const now = ops.now() / 1000;
        const uptime = ops.uptimeSeconds();
        signal?.throwIfAborted();
        const boot = Math.floor(now - uptime);
        // Existing identities describe modern process starts; reject implausible clocks.
        if (
          !Number.isSafeInteger(pid) ||
          pid <= 1 ||
          !Number.isSafeInteger(epoch) ||
          !Number.isSafeInteger(Math.floor(now)) ||
          now > 253402300799 ||
          !Number.isFinite(uptime) ||
          uptime < 0 ||
          boot < 946684800 ||
          epoch < 946684800 ||
          epoch > now
        )
          return 'unknown';
        signal?.throwIfAborted();
        if (epoch < boot - 60) return 'before_boot';
        return epoch >= boot ? 'this_boot' : 'unknown';
      }
      if (os === 'linux') {
        const match =
          /^linux:v1:([1-9]\d*):([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}):(0|[1-9]\d{0,19})$/i.exec(
            startIdentity,
          );
        if (
          !match ||
          !Number.isSafeInteger(Number(match[1])) ||
          Number(match[1]) <= 1
        )
          return 'unknown';
        const raw = await readProc(
          '/proc/sys/kernel/random/boot_id',
          ops,
          signal,
        );
        signal?.throwIfAborted();
        if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}\n?$/i.test(raw))
          return 'unknown';
        return match[2]?.toLowerCase() === raw.trimEnd().toLowerCase()
          ? 'this_boot'
          : 'before_boot';
      }
      return 'unknown';
    } catch {
      signal?.throwIfAborted();
      return 'unknown';
    }
  };
}

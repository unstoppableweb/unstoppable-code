import type {
  PlatformOperatingSystem,
  PlatformProcessInspection,
  PlatformSupervisionServices,
} from '@canopy/core-runtime';
import {
  errorCode,
  processPresent,
  validatePid,
  type SupervisionOperations,
} from './shared';

import { windowsStartIdentity } from './windows-process';

type Inspection = PlatformProcessInspection;
type Observe = (pid: number, signal?: AbortSignal) => Promise<Inspection>;
const ABSENT: Inspection = { state: 'absent' };
const unverifiable = (reason: string): Inspection => ({
  state: 'unverifiable',
  reason,
});
const running = (startIdentity: string): Inspection => ({
  state: 'running',
  startIdentity,
});
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const WEEKDAYS = 'Sun Mon Tue Wed Thu Fri Sat'.split(' ');

/** Epoch milliseconds only when the UTC fields name a real calendar instant. */
function utcInstant(
  fields: readonly number[],
  weekday?: number,
): number | null {
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] =
    fields;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const same = [
    ...[date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()],
    ...[date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()],
  ].every((value, index) => value === fields[index]);
  const day0 = weekday ?? date.getUTCDay();
  return same && day0 === date.getUTCDay() ? date.getTime() : null;
}

/** `/proc/PID/stat`: comm ends at the last ')'; starttime is field 22. */
function parseStat(text: string, pid: number, boot: string): Inspection | null {
  const close = text.lastIndexOf(')');
  const fields = text
    .slice(close + 2)
    .trimEnd()
    .split(' ');
  const [state = '', start = ''] = [fields[0], fields[19]];
  const valid =
    text.startsWith(`${pid} (`) &&
    text[close + 1] === ' ' &&
    /^[RSDZTWtXxKPI]$/.test(state) &&
    /^(0|[1-9]\d{0,19})$/.test(start);
  if (!valid) return null;
  if (/^[ZXx]$/.test(state)) return ABSENT;
  return running(`linux:v1:${pid}:${boot}:${start}`);
}

// C-locale `lstart` is `%a %b %e %T %Y`; ps reports whole seconds only.
const PS_ROW =
  /^ *(\d+) +([A-Z][A-Za-z<>+]*) +([A-Z][a-z]{2}) ([A-Z][a-z]{2}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4}) *$/;
function parsePs(text: string, pid: number): Inspection {
  const row = PS_ROW.exec(text.trimEnd());
  if (!row || row[1] !== String(pid))
    return unverifiable('ps row is malformed');
  const [, , state = '', weekday = '', month = '', ...time] = row;
  const [year, ...dayAndTime] = [time[4], ...time.slice(0, 4)].map(Number);
  const months = MONTHS.indexOf(month) + 1;
  const days = WEEKDAYS.indexOf(weekday);
  const instant = utcInstant([year ?? 0, months, ...dayAndTime], days);
  if (instant === null) return unverifiable('ps start time is invalid');
  if (/^[ZX]/.test(state)) return ABSENT;
  return running(`darwin:v1:${pid}:${instant / 1000}`);
}

export async function readProc(
  file: string,
  ops: SupervisionOperations,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const stopped = new Promise<void>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(), {
      once: true,
    });
  }).then((): never => {
    const reason: unknown = controller.signal.reason;
    throw reason;
  });
  const cancel = (): void => controller.abort(signal?.reason);
  const timeout = Object.assign(new Error('Process read timed out'), {
    code: 'ETIMEDOUT',
  });
  const timer = setTimeout(() => controller.abort(timeout), 4000);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const reading = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return ops.readText(file, controller.signal);
    });
    return await Promise.race([stopped, reading]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}

/** One-PID start identity. Cancellation rejects; failed queries never report absent. */
export function createProcessInspector(
  os: PlatformOperatingSystem,
  ops: SupervisionOperations,
): PlatformSupervisionServices['inspectProcess'] {
  let bootId: string | undefined;
  const recheck = (pid: number, reason: string): Inspection =>
    processPresent(pid, ops) ? unverifiable(reason) : ABSENT;
  const failure = (error: unknown): string =>
    `process query failed (${errorCode(error) ?? 'unknown'})`;
  // Failed or empty reads report absent only after an independent probe.
  const query = async (
    pid: number,
    signal: AbortSignal | undefined,
    read: () => Promise<string>,
    parse: (text: string) => Inspection | null,
  ): Promise<Inspection> => {
    let text: string;
    try {
      text = await read();
    } catch (error) {
      signal?.throwIfAborted();
      return recheck(pid, failure(error));
    }
    signal?.throwIfAborted();
    return parse(text) ?? recheck(pid, 'no valid process row');
  };

  const linux: Observe = async (pid, signal) => {
    if (bootId === undefined) {
      const raw = await readProc(
        '/proc/sys/kernel/random/boot_id',
        ops,
        signal,
      );
      signal?.throwIfAborted();
      const uuid = /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}\n?$/i.exec(raw);
      if (!uuid) return unverifiable('boot_id is malformed');
      bootId = uuid[0].trimEnd().toLowerCase();
    }
    const boot = bootId;
    const read = (): Promise<string> =>
      readProc(`/proc/${pid}/stat`, ops, signal);
    return query(pid, signal, read, (text) => parseStat(text, pid, boot));
  };

  const darwin: Observe = (pid, signal) => {
    const args = ['-o', 'pid=,stat=,lstart=', '-p', String(pid)];
    const env = { LC_ALL: 'C', TZ: 'UTC0' };
    const read = (): Promise<string> => ops.run('/bin/ps', args, signal, env);
    return query(pid, signal, read, (text) =>
      text.trim() === '' ? null : parsePs(text, pid),
    );
  };

  // Query failures stay unverifiable; only a successful empty result is rechecked.
  const win32: Observe = async (pid, signal) => {
    if (!ops.windowsProcess)
      return unverifiable('Windows observer unavailable');
    const text = await ops.windowsProcess(pid, signal);
    signal?.throwIfAborted();
    if (
      text === 'canopy-process-v1 absent\n' ||
      text === 'canopy-process-v1 absent\r\n'
    )
      return recheck(pid, 'native observer found no process');
    const identity = windowsStartIdentity(text, pid);
    return identity
      ? running(identity)
      : unverifiable('native process receipt is malformed');
  };

  const observe = { linux, darwin, win32 }[os];
  return async ({ pid, signal }) => {
    validatePid(pid);
    if (os === 'win32' && pid > 2147483647)
      throw new Error('Invalid supervised PID');
    signal?.throwIfAborted();
    let result: Inspection;
    try {
      result = processPresent(pid, ops) ? await observe(pid, signal) : ABSENT;
    } catch (error) {
      signal?.throwIfAborted();
      return unverifiable(failure(error));
    }
    signal?.throwIfAborted();
    return result;
  };
}

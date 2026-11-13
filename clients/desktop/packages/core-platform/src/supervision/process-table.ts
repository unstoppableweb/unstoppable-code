import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { cpus } from 'node:os';
import type {
  PlatformOperatingSystem,
  PlatformProcessTable,
  PlatformProcessTableRequest,
  PlatformProcessTableRow,
  PlatformSupervisionServices,
} from '@canopy/core-runtime';

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const WINDOWS_TIMEOUT_MS = 15_000;
const WINDOWS_CPU_UNITS_PER_SECOND = 10_000_000;
// procfs reports CPU time in USER_HZ, which the kernel ABI fixes at 100.
const LINUX_TICKS_PER_SECOND = 100;
const LINUX_DEFAULT_PAGE_BYTES = 4096;
const AT_PAGESZ = 6;
const MAC_PS_ARGS = ['-axo', 'pid=,ppid=,pgid=,pcpu=,rss=,command='] as const;
const WINDOWS_PROCESS_TABLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$processes = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { [int]$_.ProcessId -ne $PID } | ForEach-Object {
  [pscustomobject]@{
    ProcessId = [int]$_.ProcessId
    ParentProcessId = [int]$_.ParentProcessId
    CpuTime100ns = ([UInt64]$_.KernelModeTime + [UInt64]$_.UserModeTime)
    WorkingSetSize = [UInt64]$_.WorkingSetSize
    Name = [string]$_.Name
    CommandLine = [string]$_.CommandLine
  }
}
@($processes) | ConvertTo-Json -Compress
`;

/** Host-only test seams; production composition uses the Node defaults. */
export interface ProcessTableOperations {
  readonly run: (
    file: string,
    args: readonly string[],
    options: { readonly timeoutMs?: number; readonly windowsHide: boolean },
  ) => Promise<string>;
  readonly listDirectory: (path: string) => Promise<readonly string[]>;
  readonly readText: (path: string) => Promise<string>;
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  readonly logicalCpuCount: () => number;
  readonly now: () => number;
}

const NODE_PROCESS_TABLE: ProcessTableOperations = {
  run: (file, args, options) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        {
          encoding: 'utf8',
          maxBuffer: MAX_BUFFER_BYTES,
          windowsHide: options.windowsHide,
          ...(options.timeoutMs === undefined
            ? {}
            : { timeout: options.timeoutMs }),
        },
        (error, stdout) => {
          if (error) {
            reject(
              error instanceof Error ? error : new Error('execFile failed'),
            );
            return;
          }
          resolve(stdout);
        },
      );
    }),
  listDirectory: (path) => readdir(path),
  readText: (path) => readFile(path, 'utf8'),
  readBytes: (path) => readFile(path),
  logicalCpuCount: () => cpus().length,
  now: () => Date.now(),
};

type Rows = Map<number, PlatformProcessTableRow>;

interface CpuSample {
  readonly identity: string;
  readonly cpuTime: number;
  readonly sampledAtMs: number;
}

function clampCpuPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(100, percent);
}

/** The executable's base name: never arguments, which may carry secrets. */
export function processCommandName(command: string): string {
  const firstToken = command.trim().split(/\s+/)[0] ?? '';
  const basename =
    firstToken.split(/[\\/]/).filter(Boolean).pop() ?? firstToken;
  return basename || 'process';
}

function cpuShare(
  current: CpuSample,
  previous: CpuSample | undefined,
  unitsPerSecond: number,
  cpuCount: number,
): number {
  if (!previous || previous.identity !== current.identity) return 0;
  const elapsedSeconds = (current.sampledAtMs - previous.sampledAtMs) / 1000;
  const cpuSeconds = (current.cpuTime - previous.cpuTime) / unitsPerSecond;
  if (elapsedSeconds <= 0 || cpuSeconds <= 0) return 0;
  return clampCpuPercent((cpuSeconds / elapsedSeconds / cpuCount) * 100);
}

/** `ps -axo pid=,ppid=,pgid=,pcpu=,rss=,command=`; pcpu is one core's share. */
export function parseMacProcessTable(output: string, cpuCount: number): Rows {
  const rows: Rows = new Map();
  for (const line of output.split('\n')) {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(\d+)\s*(.*)$/.exec(
      line.trim(),
    );
    if (!match) continue;
    const [pid, ppid, pgid, cpu, rssKib] = match.slice(1, 6).map(Number);
    if (
      pid === undefined ||
      ppid === undefined ||
      pgid === undefined ||
      cpu === undefined ||
      rssKib === undefined ||
      ![pid, ppid, pgid, cpu, rssKib].every(Number.isFinite)
    )
      continue;
    rows.set(pid, {
      pid,
      ppid,
      pgid,
      cpuPercent: clampCpuPercent(cpu / cpuCount),
      memoryRssBytes: rssKib * 1024,
      command: processCommandName(match[6] ?? ''),
    });
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberField(value: unknown, field: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[field];
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringField(value: unknown, field: string): string {
  if (!isRecord(value)) return '';
  const raw = value[field];
  return typeof raw === 'string' ? raw : '';
}

/** `Win32_Process` rows as JSON; CPU is the delta from the previous read. */
export function parseWindowsProcessTable(
  output: string,
  previous: ReadonlyMap<number, CpuSample>,
  sampledAtMs: number,
  cpuCount: number,
): { readonly rows: Rows; readonly samples: Map<number, CpuSample> } {
  const trimmed = output.trim();
  if (!trimmed) throw new Error('Windows process table output was empty');
  const parsed: unknown = JSON.parse(trimmed);
  const rows: Rows = new Map();
  const samples = new Map<number, CpuSample>();
  for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
    const pid = numberField(entry, 'ProcessId');
    const ppid = numberField(entry, 'ParentProcessId');
    const cpuTime = numberField(entry, 'CpuTime100ns');
    const workingSet = numberField(entry, 'WorkingSetSize');
    if (
      pid === undefined ||
      ppid === undefined ||
      cpuTime === undefined ||
      workingSet === undefined
    )
      continue;
    const sample: CpuSample = { identity: '', cpuTime, sampledAtMs };
    samples.set(pid, sample);
    rows.set(pid, {
      pid,
      ppid,
      // Windows has no POSIX process groups; the process anchors its own.
      pgid: pid,
      cpuPercent: cpuShare(
        sample,
        previous.get(pid),
        WINDOWS_CPU_UNITS_PER_SECOND,
        cpuCount,
      ),
      memoryRssBytes: Math.max(0, workingSet),
      command: processCommandName(
        stringField(entry, 'Name') || stringField(entry, 'CommandLine'),
      ),
    });
  }
  return { rows, samples };
}

interface LinuxStat {
  readonly pid: number;
  readonly comm: string;
  readonly ppid: number;
  readonly pgid: number;
  readonly cpuTicks: number;
  readonly startTicks: string;
  readonly rssPages: number;
}

/** `/proc/PID/stat`: comm ends at the last ')'; field numbers are proc(5)'s. */
export function parseLinuxStat(text: string): LinuxStat | null {
  const open = text.indexOf(' (');
  const close = text.lastIndexOf(')');
  if (open <= 0 || close < open) return null;
  const pid = Number(text.slice(0, open));
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // fields[0] is field 3 (state); field N is fields[N - 3].
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const startTicks = fields[19] ?? '';
  const rssPages = Number(fields[21]);
  if (
    ![pid, ppid, pgid, utime, stime, rssPages].every(Number.isFinite) ||
    /^[ZXx]$/.test(fields[0] ?? '') ||
    !/^\d+$/.test(startTicks)
  )
    return null;
  return {
    pid,
    comm: text.slice(open + 2, close),
    ppid,
    pgid,
    cpuTicks: utime + stime,
    startTicks,
    rssPages: Math.max(0, rssPages),
  };
}

/** AT_PAGESZ from a 64-bit `/proc/self/auxv`, or null when absent. */
export function auxvPageSize(auxv: Uint8Array): number | null {
  const view = new DataView(auxv.buffer, auxv.byteOffset, auxv.byteLength);
  for (let offset = 0; offset + 16 <= auxv.byteLength; offset += 16) {
    // Little-endian 64-bit words; the values that matter fit in the low half.
    const typeHigh = view.getUint32(offset + 4, true);
    const type = view.getUint32(offset, true);
    if (typeHigh === 0 && type === 0) return null;
    if (typeHigh === 0 && type === AT_PAGESZ) {
      const size = view.getUint32(offset + 8, true);
      const sizeHigh = view.getUint32(offset + 12, true);
      return sizeHigh === 0 && size > 0 ? size : null;
    }
  }
  return null;
}

function failureReason(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string')
    return `process table read failed (${error.code})`;
  return 'process table read failed';
}

/**
 * Reads the host process table for resource accounting: `ps` on macOS,
 * procfs on Linux and `Win32_Process` through PowerShell on Windows. Each
 * reader keeps the previous read's CPU times to measure CPU between reads.
 */
export function createProcessTableReader(
  os: PlatformOperatingSystem,
  operations: Partial<ProcessTableOperations> = {},
): PlatformSupervisionServices['readProcessTable'] {
  const ops: ProcessTableOperations = { ...NODE_PROCESS_TABLE, ...operations };
  const cpuCount = (): number => {
    const count = ops.logicalCpuCount();
    return Number.isInteger(count) && count > 0 ? count : 1;
  };
  let previous: ReadonlyMap<number, CpuSample> = new Map();
  let pageBytes: number | undefined;

  const darwin = async (): Promise<Rows> =>
    parseMacProcessTable(
      await ops.run('/bin/ps', MAC_PS_ARGS, { windowsHide: false }),
      cpuCount(),
    );

  const win32 = async (): Promise<Rows> => {
    const output = await ops.run(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_PROCESS_TABLE_SCRIPT,
      ],
      { windowsHide: true, timeoutMs: WINDOWS_TIMEOUT_MS },
    );
    const { rows, samples } = parseWindowsProcessTable(
      output,
      previous,
      ops.now(),
      cpuCount(),
    );
    previous = samples;
    return rows;
  };

  const linuxCommand = async (stat: LinuxStat): Promise<string> => {
    try {
      const cmdline = await ops.readText(`/proc/${stat.pid}/cmdline`);
      const argv0 = cmdline.split('\0')[0] ?? '';
      if (argv0.trim()) return processCommandName(argv0);
    } catch {
      // The process exited between reads; its stat name still applies.
    }
    return processCommandName(stat.comm);
  };

  const linux = async (): Promise<Rows> => {
    if (pageBytes === undefined) {
      try {
        pageBytes =
          auxvPageSize(await ops.readBytes('/proc/self/auxv')) ??
          LINUX_DEFAULT_PAGE_BYTES;
      } catch {
        pageBytes = LINUX_DEFAULT_PAGE_BYTES;
      }
    }
    const pageSize = pageBytes;
    const pids = (await ops.listDirectory('/proc')).filter((name) =>
      /^\d+$/.test(name),
    );
    const sampledAtMs = ops.now();
    const count = cpuCount();
    const samples = new Map<number, CpuSample>();
    const entries = await Promise.all(
      pids.map(async (name): Promise<PlatformProcessTableRow | null> => {
        let stat: LinuxStat | null;
        try {
          stat = parseLinuxStat(await ops.readText(`/proc/${name}/stat`));
        } catch {
          return null;
        }
        if (!stat) return null;
        const sample: CpuSample = {
          identity: stat.startTicks,
          cpuTime: stat.cpuTicks,
          sampledAtMs,
        };
        samples.set(stat.pid, sample);
        return {
          pid: stat.pid,
          ppid: stat.ppid,
          pgid: stat.pgid,
          cpuPercent: cpuShare(
            sample,
            previous.get(stat.pid),
            LINUX_TICKS_PER_SECOND,
            count,
          ),
          memoryRssBytes: stat.rssPages * pageSize,
          command: await linuxCommand(stat),
        };
      }),
    );
    previous = samples;
    const rows: Rows = new Map();
    for (const row of entries) if (row) rows.set(row.pid, row);
    if (rows.size === 0) throw new Error('procfs listed no processes');
    return rows;
  };

  const read = { darwin, linux, win32 }[os];
  return async (
    request: PlatformProcessTableRequest = {},
  ): Promise<PlatformProcessTable> => {
    request.signal?.throwIfAborted();
    try {
      const rows = await read();
      request.signal?.throwIfAborted();
      return { kind: 'sampled', rows };
    } catch (error) {
      request.signal?.throwIfAborted();
      return { kind: 'unavailable', reason: failureReason(error) };
    }
  };
}

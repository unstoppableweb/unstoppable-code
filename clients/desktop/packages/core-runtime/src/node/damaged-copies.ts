import * as fs from 'node:fs';
import * as path from 'node:path';

/** How many damaged copies of one store file are kept. */
export const DAMAGED_COPY_LIMIT = 5;

/** The next unused damaged-copy name at or after `now` (epoch milliseconds). */
export function damagedCopyPath(filePath: string, now = Date.now()): string {
  let stamp = now;
  let candidate = `${filePath}.damaged-${stamp}`;
  // Serialized store writers can recover twice within one clock tick.
  while (fs.existsSync(candidate)) {
    stamp += 1;
    candidate = `${filePath}.damaged-${stamp}`;
  }
  return candidate;
}

/**
 * How one store names its damaged copies: `<prefix><stamp>`, then, with
 * `uniqueTail`, any `-<token>` parts that keep names unique, then `suffix`.
 * The stamp is when the copy was taken, in epoch milliseconds or as an ISO
 * time with `:` and `.` turned into `-` (`2026-11-04T00-40-00-000Z`).
 */
export interface DamagedCopyNames {
  /** The folder the copies sit in. */
  readonly directory: string;
  /** How each name starts; a RegExp covers the copies of several files. */
  readonly prefix: string | RegExp;
  readonly suffix?: string;
  readonly uniqueTail?: boolean;
}

/** The copies of `filePath` named `<file><marker><stamp>`. */
export function damagedCopiesOf(
  filePath: string,
  marker = '.damaged-',
  options: Pick<DamagedCopyNames, 'suffix' | 'uniqueTail'> = {},
): DamagedCopyNames {
  return {
    directory: path.dirname(filePath),
    prefix: `${path.basename(filePath)}${marker}`,
    ...options,
  };
}

const ISO_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namePattern(names: DamagedCopyNames): RegExp {
  const prefix =
    typeof names.prefix === 'string'
      ? escapeRegExp(names.prefix)
      : `(?:${names.prefix.source})`;
  const stamp = `(?<stamp>${ISO_STAMP.source.slice(1, -1)}|\\d+)`;
  const tail = names.uniqueTail ? '(?:-[0-9A-Za-z]+)*' : '';
  return new RegExp(
    `^${prefix}${stamp}${tail}${escapeRegExp(names.suffix ?? '')}$`,
  );
}

function takenAt(stamp: string): number {
  const iso = ISO_STAMP.exec(stamp);
  if (!iso) return Number(stamp);
  const [year, month, day, hour, minute, second, ms] = iso.slice(1).map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second, ms);
}

function resolveNames(target: string | DamagedCopyNames): DamagedCopyNames {
  return typeof target === 'string' ? damagedCopiesOf(target) : target;
}

/**
 * The damaged copies' paths, oldest first. Only regular files whose whole
 * name fits the naming are counted.
 */
function orderedDamagedCopies(
  names: DamagedCopyNames,
  entries: readonly fs.Dirent[],
): string[] {
  const pattern = namePattern(names);
  const copies: { name: string; takenAt: number }[] = [];
  for (const entry of entries) {
    const stamp = entry.isFile()
      ? pattern.exec(entry.name)?.groups?.stamp
      : undefined;
    if (stamp !== undefined)
      copies.push({ name: entry.name, takenAt: takenAt(stamp) });
  }
  copies.sort((a, b) => a.takenAt - b.takenAt || a.name.localeCompare(b.name));
  return copies.map((copy) => path.join(names.directory, copy.name));
}

/** The surplus damaged copies, oldest first. */
function surplusDamagedCopies(
  names: DamagedCopyNames,
  entries: readonly fs.Dirent[],
  keep: number,
): string[] {
  const copies = orderedDamagedCopies(names, entries);
  return copies.slice(0, Math.max(0, copies.length - keep));
}

/**
 * The path of the newest of the named copies by the time in its name, or
 * undefined when there is none or the folder can't be listed.
 */
export async function newestDamagedCopy(
  names: DamagedCopyNames,
): Promise<string | undefined> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(names.directory, {
      withFileTypes: true,
    });
  } catch {
    return undefined;
  }
  const copies = orderedDamagedCopies(names, entries);
  return copies.length > 0 ? copies[copies.length - 1] : undefined;
}

/**
 * Removes the oldest damaged copies beyond the newest `keep`: of `target`'s
 * `.damaged-<ms>` copies when it is a file path, otherwise of the named
 * copies. Best effort: a copy that cannot be listed or removed stays, and
 * nothing is thrown. Returns how many copies were removed.
 */
export async function pruneDamagedCopies(
  target: string | DamagedCopyNames,
  keep = DAMAGED_COPY_LIMIT,
): Promise<number> {
  const names = resolveNames(target);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(names.directory, {
      withFileTypes: true,
    });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const copy of surplusDamagedCopies(names, entries, keep)) {
    try {
      await fs.promises.unlink(copy);
      removed += 1;
    } catch {
      // Left for the next prune.
    }
  }
  return removed;
}

/** The synchronous form of {@link pruneDamagedCopies}, for synchronous stores. */
export function pruneDamagedCopiesSync(
  target: string | DamagedCopyNames,
  keep = DAMAGED_COPY_LIMIT,
): number {
  const names = resolveNames(target);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(names.directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const copy of surplusDamagedCopies(names, entries, keep)) {
    try {
      fs.unlinkSync(copy);
      removed += 1;
    } catch {
      // Left for the next prune.
    }
  }
  return removed;
}

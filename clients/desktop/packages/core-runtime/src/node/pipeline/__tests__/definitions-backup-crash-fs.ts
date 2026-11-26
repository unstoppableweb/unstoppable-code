import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** A folder entry by inode, or a file entry by its bytes. */
type Entry = { readonly folder: number } | { readonly bytes: Buffer };

function entriesOf(folder: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    const stat = lstatSync(path);
    entries.set(
      name,
      stat.isDirectory() ? { folder: stat.ino } : { bytes: readFileSync(path) },
    );
  }
  return entries;
}

function sameEntry(a: Entry, b: Entry): boolean {
  return 'folder' in a
    ? 'folder' in b && a.folder === b.folder
    : 'bytes' in b && a.bytes.equals(b.bytes);
}

/** Thrown in place of the flush a crash point stops before. */
export class Crash extends Error {}

export interface CrashFs {
  /** The `syncDirectory` port: it flushes and records, refuses, or crashes. */
  readonly syncDirectory: (path: string) => Promise<'flushed' | 'unsupported'>;
  /** Counts flushes from here on, and crashes before the one numbered `at`. */
  crashBefore(at?: number): void;
  /** Refuses the first flush `when` matches, as a host that can't flush does. */
  refuseOnce(when: (path: string) => boolean): void;
  /** Crashes before the first flush `when` matches, wherever the count is. */
  crashOnce(when: (path: string) => boolean): void;
  /**
   * Makes one written path durable, as the writer's own flushes do: each
   * folder from it up to the root gains that entry and nothing else.
   */
  settle(path: string): void;
  /** The folders flushed since `crashBefore`, in order. */
  readonly flushed: readonly string[];
  /** A new data root holding only what a crash now would leave. */
  durableImage(): string;
}

/**
 * A crash model of folder flushes under `root`. A folder's entries are
 * durable as they stood at its last flush, or when the model began; a file's
 * bytes as they stood when its folder was flushed. Folders are known by
 * inode, so a renamed folder keeps its durable entries and a new one holds
 * none until it is flushed. A crash between two flushes leaves the same
 * durable state as one just before the second, so a crash before every flush
 * also covers every rename and journal write between them.
 */
export function crashFs(
  root: string,
  flush: (path: string) => Promise<'flushed'>,
): CrashFs {
  const durable = new Map<number, Map<string, Entry>>();
  const record = (folder: string): void => {
    durable.set(lstatSync(folder).ino, entriesOf(folder));
  };
  const walk = (folder: string): void => {
    record(folder);
    for (const name of readdirSync(folder))
      if (lstatSync(join(folder, name)).isDirectory()) walk(join(folder, name));
  };
  walk(root);
  const top = lstatSync(root).ino;
  const flushed: string[] = [];
  let crashAt: number | undefined;
  let refuse: ((path: string) => boolean) | undefined;
  let crashWhen: ((path: string) => boolean) | undefined;
  return {
    flushed,
    crashBefore: (at) => {
      crashAt = at;
      flushed.length = 0;
    },
    refuseOnce: (when) => {
      refuse = when;
    },
    crashOnce: (when) => {
      crashWhen = when;
    },
    settle: (path) => {
      for (let at = path; at !== root && at !== dirname(at); at = dirname(at)) {
        const parent = lstatSync(dirname(at)).ino;
        const entries = new Map(durable.get(parent) ?? []);
        const stat = lstatSync(at);
        const entry: Entry = stat.isDirectory()
          ? { folder: stat.ino }
          : { bytes: readFileSync(at) };
        // An ancestor already durable as something else would carry an
        // unflushed restore step with it.
        const held = entries.get(basename(at));
        if (at !== path && held !== undefined && !sameEntry(held, entry))
          throw new Error(
            'settle would make an unflushed restore step durable',
          );
        entries.set(basename(at), entry);
        durable.set(parent, entries);
      }
    },
    syncDirectory: async (path) => {
      if (refuse?.(path) === true) {
        refuse = undefined;
        return 'unsupported';
      }
      if (flushed.length === crashAt || crashWhen?.(path) === true) {
        crashWhen = undefined;
        throw new Crash(`crash before ${path}`);
      }
      const answer = await flush(path);
      record(path);
      flushed.push(path);
      return answer;
    },
    durableImage: () => {
      const image = mkdtempSync(join(tmpdir(), 'pipeline-definitions-crash-'));
      const build = (inode: number, at: string): void => {
        for (const [name, entry] of durable.get(inode) ?? []) {
          const path = join(at, name);
          if ('bytes' in entry) writeFileSync(path, entry.bytes);
          else {
            mkdirSync(path);
            build(entry.folder, path);
          }
        }
      };
      build(top, image);
      return image;
    },
  };
}

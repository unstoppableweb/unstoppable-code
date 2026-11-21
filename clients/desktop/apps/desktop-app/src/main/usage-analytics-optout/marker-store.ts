// The local last-sent marker of the usage analytics opt-out ping: one UTC
// date in `userData`, written only after the ping got a 2xx. It holds no id.
// A missing file is the normal "never sent"; any other failure is
// `unreadable`. A damaged file that is a regular file also reports the UTC
// date it was last replaced, so the ping can tell "not sent today" (replaced
// before today) from "unknown for today" instead of staying silent forever.

import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  isUtcDate,
  utcDateOf,
  type MarkerRead,
  type OptOutMarkerStore,
} from './ping';

export const OPT_OUT_PING_MARKER_FILE_NAME =
  'usage-analytics-optout-last-sent.json';

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** The marker's bytes, or null when they aren't a version-1 marker. */
function parseMarker(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    parsed.version === 1 &&
    'lastSentUtcDate' in parsed &&
    isUtcDate(parsed.lastSentUtcDate)
  ) {
    return parsed.lastSentUtcDate;
  }
  return null;
}

/** The UTC date a regular file was last replaced, or null. */
async function lastWrittenUtcDate(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    return info.isFile() && Number.isFinite(info.mtimeMs)
      ? utcDateOf(info.mtimeMs)
      : null;
  } catch {
    return null;
  }
}

export function createFileOptOutMarkerStore(
  userDataDir: () => string,
): OptOutMarkerStore {
  const filePath = (): string =>
    path.join(userDataDir(), OPT_OUT_PING_MARKER_FILE_NAME);
  return {
    async read(): Promise<MarkerRead> {
      const target = filePath();
      let text: string;
      try {
        text = await readFile(target, 'utf8');
      } catch (error) {
        return isMissingFile(error)
          ? { kind: 'missing' }
          : { kind: 'unreadable', lastWrittenUtcDate: null };
      }
      const utcDate = parseMarker(text);
      if (utcDate !== null) return { kind: 'present', utcDate };
      return {
        kind: 'unreadable',
        lastWrittenUtcDate: await lastWrittenUtcDate(target),
      };
    },
    async write(utcDate: string): Promise<void> {
      const target = filePath();
      await mkdir(path.dirname(target), { recursive: true });
      const tempPath = `${target}.${process.pid}.tmp`;
      try {
        await writeFile(
          tempPath,
          JSON.stringify({ version: 1, lastSentUtcDate: utcDate }),
        );
        await rename(tempPath, target);
      } catch (error) {
        // Leave no stray temporary file behind a failed write.
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
    },
  };
}

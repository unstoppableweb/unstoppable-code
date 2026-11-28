import { readFile } from 'node:fs/promises';

import { isRecord } from '../w5/commit-log/is-record';
import { newestDamagedCopy } from '../damaged-copies';
import {
  documentGeneration,
  type PreferencesGenerationRead,
} from './generation';

/*
 * The silent restore after a downgrade reset (CAN-8052, CAN-5722 slice R,
 * r4 section 5.2). Only a flip build writes envelope version 2, and only a
 * build from v1.16.1 or older resets a version 2 file: it backs up the
 * parsed envelope as a `preferences.backup-*` copy, writes version 1
 * defaults and never touches the generation record. A later save by a build
 * that does bump the record leaves that copy behind it. The rule needs no
 * owner record, and the daemon document applies it on every primary read, so
 * it also catches a reset made while the daemon runs.
 */

/** The envelope version the owner flip writes. */
export const PREFERENCES_FLIP_ENVELOPE_VERSION = 2;

export interface FlipBackupRestore {
  /** The primary text to serve: the backup's preferences as a version 2 envelope. */
  readonly text: string;
  /** The version 1 primary, as stored, this restore replaces. */
  readonly primaryText: string;
  readonly backupPath: string;
  readonly generation: number;
}

export interface FlipBackupRestoreInput {
  /** The folder holding the primary and its backups. */
  readonly directory: string;
  readonly backupPrefix: string;
  /** The primary as stored. */
  readonly primaryText: string;
  readonly readGeneration: () => Promise<PreferencesGenerationRead>;
  /**
   * The restore this reader served last. It stands while the primary and the
   * newest backup are unchanged: a save of the restored preferences raises
   * the generation record before it replaces the primary, and a read between
   * the two must not serve the reset.
   */
  readonly served?: FlipBackupRestore;
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The restore to serve instead of a version 1 primary: when the newest
 * backup is a version 2 envelope whose generation is at least the
 * generation record's (none counts as 0; an unreadable record proves
 * nothing). Otherwise null, and the version 1 data stays.
 */
export async function findFlipBackupRestore(
  input: FlipBackupRestoreInput,
): Promise<FlipBackupRestore | null> {
  if (parse(input.primaryText)?.version !== 1) return null;
  const backupPath = await newestDamagedCopy({
    directory: input.directory,
    prefix: input.backupPrefix,
    suffix: '.json',
    uniqueTail: true,
  });
  if (backupPath === undefined) return null;
  // Backups are written once under unique names, so the path names the bytes.
  if (
    input.served?.backupPath === backupPath &&
    input.served.primaryText === input.primaryText
  )
    return input.served;
  const backup = await readFile(backupPath, 'utf8').then(parse, () => null);
  if (
    backup?.version !== PREFERENCES_FLIP_ENVELOPE_VERSION ||
    !isRecord(backup.preferences)
  )
    return null;
  const generation = documentGeneration(backup);
  if (generation === null) return null;
  const recorded = await input.readGeneration();
  if (recorded.status === 'unreadable') return null;
  if (recorded.status === 'ok' && generation < recorded.generation) return null;
  return {
    text: JSON.stringify(
      {
        version: PREFERENCES_FLIP_ENVELOPE_VERSION,
        generation,
        preferences: backup.preferences,
      },
      null,
      2,
    ),
    primaryText: input.primaryText,
    backupPath,
    generation,
  };
}

import { dirname } from 'node:path';
import type { PreferencesDocument } from '@canopy/core-runtime/node/preferences';
import { assertRowWritable } from '@canopy/core-runtime/node/pipeline/store';

/**
 * Refuses, before any byte is written, an Electron-main write to the
 * preferences row once the row's owner record names another owner or can't
 * be read (CAN-5722, the CAN-7690 check). With no record the compiled
 * ownership table decides, as before. Preferences sit in the data root
 * itself, where the row's records are.
 */
export function assertPreferencesRowWritable(filePath: string): Promise<void> {
  return assertRowWritable(dirname(filePath), 'preferences', 'electron_main');
}

/** `document` with the row's owner check before each of its writes. */
export function withPreferencesOwnerCheck(
  document: PreferencesDocument,
): PreferencesDocument {
  const check = (): Promise<void> => assertPreferencesRowWritable(document.key);
  return {
    ...document,
    async install(slot, content): Promise<void> {
      await check();
      await document.install(slot, content);
    },
    async ensureFolder(): Promise<void> {
      await check();
      await document.ensureFolder();
    },
    async installBackup(location, content): Promise<void> {
      await check();
      await document.installBackup(location, content);
    },
    async pruneBackups(): Promise<void> {
      await check();
      await document.pruneBackups();
    },
  };
}

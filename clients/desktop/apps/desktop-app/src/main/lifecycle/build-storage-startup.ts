import { app, dialog } from 'electron';
import { writeSync } from 'node:fs';
import { BRAND } from '@canopy/brand/current';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import {
  BuildStorageStartupRefused,
  buildStorageRefusalDiagnostic,
} from '@canopy/core-runtime/node/build-storage-startup';

// Refuse before import-time services can turn maintenance into a crash dialog.
try {
  getCanopyDataDir();
} catch (error) {
  if (!(error instanceof BuildStorageStartupRefused)) throw error;
  if (!__CANOPY_E2E__)
    dialog.showErrorBox(`Couldn't open ${BRAND.displayName}`, error.message);
  writeSync(
    process.stderr.fd,
    `${error.message}\n${buildStorageRefusalDiagnostic(error)}`,
  );
  app.exit(1);
  process.exit(1);
}

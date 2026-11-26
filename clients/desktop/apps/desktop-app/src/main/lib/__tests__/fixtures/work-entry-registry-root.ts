import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fresh data root installed before any owner module loads, so the
 * CAN-4476 golden holds whether an owner resolves its roots per call
 * (develop) or once when its module loads.
 */
export const previousDataDir = process.env.CANOPY_DATA_DIR;
export const dataRoot = join(
  realpathSync.native(mkdtempSync(join(tmpdir(), 'can4476-'))),
  'data',
);
process.env.CANOPY_DATA_DIR = dataRoot;

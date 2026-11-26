import { basename, dirname, join } from 'node:path';

/** The copy of the last readable id-map, which recovery serves. */
export function createCoworkMigrationMapLastGoodPath(filePath: string): string {
  return join(dirname(filePath), 'cowork-migration.last-good.json');
}

/** Where recovery keeps an unreadable id-map's bytes. */
export function createCoworkMigrationMapDamagedPath(
  filePath: string,
  stamp: string,
): string {
  return join(dirname(filePath), `cowork-migration.damaged-${stamp}.json`);
}

export const COWORK_MIGRATION_MAP_DAMAGED_PREFIX = 'cowork-migration.damaged-';

export function isCoworkMigrationMapDamagedFileName(name: string): boolean {
  return /^cowork-migration\.damaged-.+\.json$/.test(basename(name));
}

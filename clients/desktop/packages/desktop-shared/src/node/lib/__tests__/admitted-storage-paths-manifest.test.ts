import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import yaml from 'js-yaml';
import { STORAGE_OWNERSHIP } from '@canopy/core-runtime/storage';
import {
  admittedStorageRowForPath,
  isAdmittedStorageCandidate,
} from '@canopy/execution-engine/node/lib/admitted-storage-paths';
import { writeFileAtomicallySync } from '@canopy/execution-engine/node/lib/atomic-file';

// Reads the planning census, so the desktop public export excludes this suite.
const MANIFEST = resolve(
  __dirname,
  '../../../../../../docs/planning/2026-07-31-desktop-core-daemon/artifacts/storage-ownership.yaml',
);
const ROOT = resolve('/data/canopy');
const SECURE = resolve('/secure/canopy');

interface ManifestRow {
  id: string;
  admittedWriters?: string[];
  patterns?: string[];
  pathPatterns?: string[];
}

function manifestRows(): ManifestRow[] {
  const document: unknown = yaml.load(readFileSync(MANIFEST, 'utf8'));
  if (
    typeof document !== 'object' ||
    document === null ||
    !('rows' in document) ||
    !Array.isArray(document.rows)
  )
    throw new Error('storage-ownership.yaml has no rows');
  const rows: unknown[] = document.rows;
  return rows.filter(isAdmittedManifestRow);
}

function isAdmittedManifestRow(row: unknown): row is ManifestRow {
  return (
    typeof row === 'object' &&
    row !== null &&
    'id' in row &&
    typeof row.id === 'string' &&
    'admittedWriters' in row &&
    Array.isArray(row.admittedWriters)
  );
}

it('classifies every manifest pattern of each admitted row, and only those rows', () => {
  const rows = manifestRows();
  expect(rows.map((row) => row.id).sort()).toEqual(
    STORAGE_OWNERSHIP.filter((row) => 'admittedWriters' in row)
      .map((row) => row.id)
      .sort(),
  );
  for (const row of rows) {
    const patterns = [...(row.patterns ?? []), ...(row.pathPatterns ?? [])];
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      const path = join(
        pattern.startsWith('<secure>/') ? SECURE : ROOT,
        ...pattern
          .replace(/^<(?:data|secure)>\//, '')
          .replaceAll('{}', 'id-1')
          .split('/'),
      );
      const dottedPath = `${dirname(path)}${sep}.${sep}${basename(path)}`;
      for (const spelling of [path, dottedPath]) {
        expect(isAdmittedStorageCandidate(spelling)).toBe(true);
        expect(admittedStorageRowForPath(spelling, ROOT, SECURE)).toBe(row.id);
        expect(admittedStorageRowForPath(spelling, null)).toBe(row.id);
        expect(
          admittedStorageRowForPath(
            spelling,
            join(ROOT, 'other'),
            join(SECURE, 'other'),
          ),
        ).toBeUndefined();
      }
      expect(
        admittedStorageRowForPath(
          join(dirname(path), 'unowned', basename(path)),
          ROOT,
          SECURE,
        ),
      ).toBeUndefined();
      if (pattern.startsWith('<secure>/')) {
        expect(isAdmittedStorageCandidate(`${path}.unowned`)).toBe(false);
        expect(
          admittedStorageRowForPath(`${path}.unowned`, ROOT, SECURE),
        ).toBeUndefined();
      }
    }
  }
});

it('does not admit secure files under the data root or an unrelated secure root', () => {
  for (const tail of [
    'github-pat-fence.json',
    'vault',
    'vault/vault.sqlite',
    'vault/vault.sqlite-wal',
    'vault/vault.sqlite-shm',
  ]) {
    expect(
      admittedStorageRowForPath(join(ROOT, tail), ROOT, SECURE),
    ).toBeUndefined();
    expect(admittedStorageRowForPath(join(SECURE, tail), ROOT)).toBeUndefined();
    expect(
      admittedStorageRowForPath(
        join(SECURE, tail),
        ROOT,
        join(SECURE, 'other'),
      ),
    ).toBeUndefined();
  }
});

it('guards native snapshot directories and exact members without admitting nested or unrelated paths', () => {
  for (const tail of [
    'native-artifacts',
    'native-artifacts/run-id',
    'native-artifacts/run-id/owner.json',
    'native-artifacts/run-id/core-secret-protection.node',
    'native-artifacts/native-artifacts',
    'native-artifacts/native-artifacts/owner.json',
    'native-artifacts/owner.json',
  ]) {
    const namedRoot = join(ROOT, 'native-artifacts');
    expect(admittedStorageRowForPath(join(namedRoot, tail), namedRoot)).toBe(
      'daemon_native_artifact_snapshots',
    );
    const target = join(ROOT, tail);
    expect(admittedStorageRowForPath(target, ROOT, SECURE)).toBe(
      'daemon_native_artifact_snapshots',
    );
    expect(() => writeFileAtomicallySync(target, 'unadmitted')).toThrow(
      /daemon_native_artifact_snapshots.*unadmitted_writer/,
    );
    expect(
      admittedStorageRowForPath(join(SECURE, tail), ROOT, SECURE),
    ).toBeUndefined();
  }
  for (const tail of [
    'native-artifacts/run-id/unowned.json',
    'native-artifacts/run-id/nested/owner.json',
    'native-artifacts/run-id/core-secret-protection.node.tmp',
    'runtime/run-id/owner.json',
    'other/native-artifacts/run-id/owner.json',
  ])
    expect(
      admittedStorageRowForPath(join(ROOT, tail), ROOT, SECURE),
    ).toBeUndefined();
});

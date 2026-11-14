import type { DatabaseSync } from 'node:sqlite';
import type { W5BackupPosition } from './commit-log';
import { W5CommitLogError, W5CommitRefusedError } from './errors';

function integer(value: unknown): number {
  const result = typeof value === 'bigint' ? Number(value) : value;
  if (typeof result === 'number' && Number.isSafeInteger(result) && result >= 0)
    return result;
  throw new W5CommitLogError(
    'STORAGE_UNAVAILABLE',
    'Unexpected backup position.',
  );
}
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new W5CommitLogError(
    'STORAGE_UNAVAILABLE',
    'Unexpected backup position.',
  );
}
/** The caller owns one consistent read transaction or the writer's exclusive connection. */
export function readW5BackupPosition(
  db: Pick<DatabaseSync, 'prepare'>,
): W5BackupPosition {
  const commitId = integer(
    db
      .prepare(
        'SELECT COALESCE(MAX(commit_id), 0) AS commit_id FROM w5_commits',
      )
      .get()?.commit_id,
  );
  const schemaVersion = integer(
    Number(
      text(
        db
          .prepare("SELECT value FROM w5_meta WHERE key = 'schema_version'")
          .get()?.value,
      ),
    ),
  );
  const revisions: Record<string, number> = {};
  for (const row of db
    .prepare('SELECT resource, revision FROM w5_revisions ORDER BY resource')
    .all())
    revisions[text(row.resource)] = integer(row.revision);
  const pending = db
    .prepare(
      "SELECT commit_id FROM w5_commits WHERE state != 'applied' ORDER BY commit_id LIMIT 1",
    )
    .get();
  if (pending)
    throw new W5CommitRefusedError(
      'recovery-required',
      'W5 backup requires completed file recovery.',
      { commitId: integer(pending.commit_id) },
    );
  return { commitId, schemaVersion, revisions };
}

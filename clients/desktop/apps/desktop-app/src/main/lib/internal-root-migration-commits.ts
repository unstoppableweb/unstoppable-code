import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  InternalRootMigrationRefused,
  type InternalRootColdRecovery,
} from '@canopy/core-runtime/node/internal-root-migration';
import {
  flush,
  privateDirectory,
} from '@canopy/desktop-shared/node/internal-root-migration/filesystem';
import type { InternalRootFilesystemHost } from '@canopy/desktop-shared/node/internal-root-migration/filesystem-host';
import {
  refuseW5MaintenanceDecisions,
  type W5MaintenanceDecision,
} from './w5-maintenance-decisions';
import {
  readW5CommitAbandonmentEvidence,
  type W5Diagnosis,
} from './w5-maintenance-diagnosis';
import { isRecord } from './type-guards';

function commitFailureReason(diagnostics: string | null): string {
  if (!diagnostics) return 'not recorded';
  try {
    const value: unknown = JSON.parse(diagnostics);
    if (isRecord(value) && typeof value.error === 'string' && value.error)
      return value.error;
    if (typeof value === 'string' && value) return value;
  } catch {
    // Older or malformed diagnostics remain reviewable rather than hiding the commit.
  }
  return diagnostics;
}

export function describeInternalRootCommit(
  source: string,
  row: W5Diagnosis['commits'][number],
): string {
  const paths = (row.paths ?? []).map((path): string => {
    const local = relative(source, path);
    return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
      ? local.split(sep).join('/')
      : path;
  });
  return `commit ${row.commitId}: ${row.operation} state=${row.state} paths=${JSON.stringify(paths)} reason=${JSON.stringify(commitFailureReason(row.diagnostics))}${row.state === 'recovery-required' ? `; to keep current files and drop this pending change, use --abandon-commit ${row.commitId}` : ''}`.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    ' ',
  );
}

export function internalRootCommitAbandonments(
  diagnosis: W5Diagnosis,
  commitIds: readonly number[],
): readonly W5MaintenanceDecision[] {
  const decisions = commitIds.map(
    (commitId): W5MaintenanceDecision => ({ kind: 'abandon-commit', commitId }),
  );
  if (!decisions.length) return decisions;
  for (const commitId of commitIds)
    if (
      !Number.isSafeInteger(commitId) ||
      commitId < 1 ||
      !diagnosis.commits.some(
        (row) => row.commitId === commitId && row.state === 'recovery-required',
      )
    )
      throw new InternalRootMigrationRefused(
        'recovery-required',
        `--abandon-commit ${commitId} does not match a recovery-required W5 commit at the original root.`,
      );
  // Inventory previews before ordinary launch recovery; settlement rechecks the full diagnosis.
  const refusal = refuseW5MaintenanceDecisions(
    {
      ...diagnosis,
      commits: diagnosis.commits.filter((row) =>
        commitIds.includes(row.commitId),
      ),
      reservations: [],
    },
    decisions,
  );
  if (refusal || new Set(commitIds).size !== commitIds.length)
    throw new InternalRootMigrationRefused(
      'recovery-required',
      `W5 commit abandonment refused (${refusal?.reason ?? 'duplicate commit'}); preserve the original root and use offline W5 diagnosis.`,
    );
  return decisions;
}

/** Persist complete deleted rows before any abandon; no journal schema change. */
export async function retainInternalRootCommits(
  qualification: InternalRootColdRecovery,
  host: InternalRootFilesystemHost,
  commitIds: readonly number[],
  assertHeld: () => Promise<void>,
): Promise<void> {
  await qualification.assertHeld();
  await assertHeld();
  const evidence = await readW5CommitAbandonmentEvidence(
    qualification.identity.source,
    commitIds,
  );
  const directory = qualification.identity.coordination;
  await privateDirectory(directory, host);
  const path = join(directory, `abandoned-w5-commits-${randomUUID()}.json`);
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(evidence);
    await file.sync();
  } finally {
    await file.close();
  }
  await flush(directory);
  await qualification.assertHeld();
  await assertHeld();
  process.stderr.write(
    `Internal-root migration: W5 abandonment evidence retained at ${JSON.stringify(path)} (review only; never replay).\n`,
  );
}

import {
  withW5BackupBootstrap,
  createW5BackupBootstrapContext,
  retireW5BackupBootstrap,
  type W5BackupBootstrapProtection,
} from './w5-backup-bootstrap';
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  publishW5RootEvidence,
  readW5RootEvidence,
  sameW5RootEvidenceScope,
  w5RootEvidenceId,
  w5RootEvidenceScope,
  type W5RootEvidenceScope,
} from '@canopy/core-runtime/node/w5/service-history';
import { CanopyClientError, toCanopyClientError } from '@canopy/core-client';
import {
  canopyDaemonRefusal,
  canopyDaemonRefusalError,
} from '@canopy/core-client/node';
import { W5CommitLogError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import {
  isW5CommitLogHostShutDown,
  runningW5CommitLogWorkers,
  shutdownW5CommitLogHost,
} from '../w5-commit-log/commit-log-host';
import { syncDirectory, writeFileAtomically } from './atomic-file';
import { getDataDir, getW5FlipBackupMarkerPath } from './paths';
import { isErrnoException, isRecord } from './type-guards';
import {
  captureW5Backup,
  desktopW5BackupContext,
  desktopW5BackupRootScope,
  requireVerifiedW5Backup,
  verifyW5Backup,
  W5BackupRefusedError,
  type W5BackupContext,
  type W5BackupReadContext,
} from './w5-backup';
import type { W5HandoffFailure } from './w5-handoff-store';

/*
 * TRANSITIONAL (CAN-5543, GB12): fresh preparation before each claimed POSIX
 * spawn or Windows spawn-capable connection attempt. Release-skip launches
 * still walk backup and confirmed in-process shutdown before spawning; only
 * capture is once per root, with independently verified completion. Remove at W15.
 */

/** `<data>/w5/flip-backup.json`. A support artifact, never a restore point. */
export type W5FlipBackupMarker =
  | {
      readonly version: 1;
      readonly state: 'captured';
      /** `w5/backups/<id>`, or `empty-root` for a root with nothing to keep. */
      readonly backup: string;
      readonly commitId: number;
      readonly capturedAt: string;
      readonly buildVersion: string;
      /** `captured-after-flip`: a daemon may have committed first (Q1(a)). */
      readonly capture: 'before-flip' | 'captured-after-flip';
    }
  | {
      /** A daemon already served W5 here before this build could capture. */
      readonly version: 1;
      readonly state: 'deferred';
      readonly deferredAt: string;
      readonly buildVersion: string;
    };

const BACKUP_PATH = /^w5\/backups\/[a-z0-9-]+$/;

function isMarker(value: unknown): value is W5FlipBackupMarker {
  if (!isRecord(value) || value.version !== 1) return false;
  if (typeof value.buildVersion !== 'string') return false;
  if (value.state === 'deferred') return typeof value.deferredAt === 'string';
  return (
    value.state === 'captured' &&
    typeof value.backup === 'string' &&
    (value.backup === 'empty-root' || BACKUP_PATH.test(value.backup)) &&
    typeof value.commitId === 'number' &&
    Number.isSafeInteger(value.commitId) &&
    value.commitId >= 0 &&
    (value.backup !== 'empty-root' || value.commitId === 0) &&
    typeof value.capturedAt === 'string' &&
    (value.capture === 'before-flip' || value.capture === 'captured-after-flip')
  );
}

/**
 * `null` when absent. An unreadable or invalid marker reads as deferred: its
 * history is unknown, so the next capture is labeled after the flip.
 */
export async function readW5FlipBackupMarker(): Promise<W5FlipBackupMarker | null> {
  const completed = await readCompletion();
  return completed ?? (await readCompatibilityMarker());
}

async function readCompatibilityMarker(): Promise<W5FlipBackupMarker | null> {
  let raw: string;
  try {
    raw = await readFile(getW5FlipBackupMarkerPath(), 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    return unknownHistory();
  }
  try {
    const value: unknown = JSON.parse(raw);
    return isMarker(value) ? value : unknownHistory();
  } catch {
    return unknownHistory();
  }
}

type CapturedMarker = Extract<W5FlipBackupMarker, { state: 'captured' }>;

async function completionLocation(): Promise<{
  readonly scope: W5RootEvidenceScope;
  readonly directoryScope: W5RootEvidenceScope;
  readonly path: string;
}> {
  const scope = await w5RootEvidenceScope(getDataDir());
  const directory = join(scope.canonicalDataRoot, 'w5');
  const directoryScope = await w5RootEvidenceScope(directory);
  if (directoryScope.canonicalDataRoot !== directory)
    throw new Error('Redirected W5 evidence directory.');
  return {
    scope,
    directoryScope,
    path: join(
      directory,
      `flip-backup-completion.${w5RootEvidenceId(scope)}.json`,
    ),
  };
}

function completionFailure(): CanopyClientError {
  return stepError(
    'backup_refused',
    'The workspace records backup failed.',
    'completion-invalid',
  );
}

async function publishCompletion(
  marker: CapturedMarker,
  capturedScope: W5RootEvidenceScope,
  expectedDirectoryScope?: W5RootEvidenceScope,
): Promise<void> {
  const { scope, directoryScope, path } = await completionLocation();
  if (!sameW5RootEvidenceScope(scope, capturedScope)) throw completionFailure();
  if (
    expectedDirectoryScope &&
    !sameW5RootEvidenceScope(directoryScope, expectedDirectoryScope)
  )
    throw completionFailure();
  await publishW5RootEvidence(
    path,
    { version: 1, scope, marker },
    (value) => {
      if (
        !isRecord(value) ||
        value.version !== 1 ||
        !sameW5RootEvidenceScope(value.scope, scope) ||
        !isMarker(value.marker) ||
        value.marker.state !== 'captured' ||
        JSON.stringify(value.marker) !== JSON.stringify(marker)
      )
        throw completionFailure();
    },
    syncDirectory,
  );
  const current = await completionLocation();
  if (
    !sameW5RootEvidenceScope(current.scope, capturedScope) ||
    !sameW5RootEvidenceScope(current.directoryScope, directoryScope)
  )
    throw completionFailure();
}

async function verifyHistoricalCapture(
  marker: CapturedMarker,
  scope: W5RootEvidenceScope,
): Promise<void> {
  if (marker.backup === 'empty-root') return;
  const context = await desktopW5BackupContext();
  const requireScope = async (): Promise<void> => {
    if (
      !sameW5RootEvidenceScope(
        await w5RootEvidenceScope(context.dataRoot),
        scope,
      )
    )
      throw completionFailure();
  };
  await requireScope();
  const record = await verifyW5Backup(context, marker.backup);
  if (record.position.commitId !== marker.commitId) throw completionFailure();
  await requireScope();
}

/** Advisory metadata only: neither backup verification nor spawn admission. */
async function readCompletionMetadata(): Promise<
  | {
      readonly marker: CapturedMarker;
      readonly scope: W5RootEvidenceScope;
      readonly directoryScope: W5RootEvidenceScope;
    }
  | undefined
> {
  let location: Awaited<ReturnType<typeof completionLocation>>;
  try {
    location = await completionLocation();
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw completionFailure();
  }
  try {
    const { scope, directoryScope, path } = location;
    const value = await readW5RootEvidence(path);
    if (value === undefined) return undefined;
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !sameW5RootEvidenceScope(value.scope, scope) ||
      !isMarker(value.marker) ||
      value.marker.state !== 'captured'
    )
      throw completionFailure();
    return { marker: value.marker, scope, directoryScope };
  } catch {
    throw completionFailure();
  }
}

/** Old publishers replace the compatibility marker, but never this evidence. */
async function readCompletion(): Promise<CapturedMarker | undefined> {
  const completed = await readCompletionMetadata();
  if (!completed) return undefined;
  const { marker, scope, directoryScope } = completed;
  try {
    await verifyHistoricalCapture(marker, scope);
    // Resolve an earlier directory-flush uncertainty before accepting completion.
    await publishCompletion(marker, scope, directoryScope);
    return marker;
  } catch {
    throw completionFailure();
  }
}

function unknownHistory(): W5FlipBackupMarker {
  return {
    version: 1,
    state: 'deferred',
    deferredAt: new Date(0).toISOString(),
    buildVersion: 'unknown',
  };
}

// `<data>/w5` exists by now: the capture or the daemon's commit log made it.
async function writeMarker(marker: W5FlipBackupMarker): Promise<void> {
  await writeFileAtomically(
    getW5FlipBackupMarkerPath(),
    `${JSON.stringify(marker, null, 2)}\n`,
    { durable: true, mode: 0o600 },
  );
}

/** Failures the step reports through the launch, in `details.w5Handoff`. */
const STEP_FAILURES = [
  'backup_refused',
  'in_process_host_running',
] as const satisfies readonly W5HandoffFailure[];
type StepFailure = (typeof STEP_FAILURES)[number];

function stepError(
  failure: StepFailure,
  message: string,
  detail?: string,
): CanopyClientError {
  return new CanopyClientError({
    kind: 'failed_precondition',
    message,
    retry: { kind: 'never' },
    details: { w5Handoff: failure, ...(detail !== undefined && { detail }) },
  });
}

/** The step failure a launch error carries, or `null`. */
export function w5FlipStepFailure(
  error: unknown,
): { readonly failure: StepFailure; readonly detail?: string } | null {
  const { details } = toCanopyClientError(error).payload;
  if (!isRecord(details)) return null;
  const failure = STEP_FAILURES.find((f) => f === details.w5Handoff);
  if (!failure) return null;
  return typeof details.detail === 'string'
    ? { failure, detail: details.detail }
    : { failure };
}

/** A fresh root: no index, no index backup, no workspace folder, no commit. */
async function isEmptyRoot(context: W5BackupReadContext): Promise<boolean> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(join(context.dataRoot, 'workspaces'), {
      withFileTypes: true,
    });
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') return false;
  }
  if (
    entries.some(
      (entry) =>
        entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name === 'index.json.bak',
    )
  )
    return false;
  return (await context.host.snapshot()).commitId === 0;
}

const writerHeld = (error: unknown): boolean =>
  error instanceof W5CommitLogError && error.code === 'WRITER_UNAVAILABLE';

/** Successful leased recovery in this process, bound to the served root. */
let daemonServedScope: W5RootEvidenceScope | undefined;

/** Call only after recovery succeeds, with the served root pinned before it. */
export async function noteW5DaemonServed(
  scope: W5RootEvidenceScope,
): Promise<void> {
  if (!sameW5RootEvidenceScope(await w5RootEvidenceScope(getDataDir()), scope))
    throw completionFailure();
  daemonServedScope = scope;
}

function daemonServedHere(scope: W5RootEvidenceScope): boolean {
  if (!sameW5RootEvidenceScope(daemonServedScope, scope)) {
    daemonServedScope = undefined;
    return false;
  }
  return true;
}

async function captureOnce(
  previous: W5FlipBackupMarker | null,
  buildVersion: string,
  protection?: W5BackupBootstrapProtection,
  bootstrapContext?: W5BackupContext,
): Promise<void> {
  let backup: string;
  let commitId: number;
  let scope: W5RootEvidenceScope;
  try {
    if (protection) {
      const rootScope = await desktopW5BackupRootScope();
      if (runningW5CommitLogWorkers() !== 0)
        throw new Error('The ordinary W5 host is running.');
      const context = createW5BackupBootstrapContext(
        rootScope.canonicalDataRoot,
      );
      await withW5BackupBootstrap(
        context,
        {
          claimHandle: protection.claimHandle,
          assertHeld: async (): Promise<void> => {
            await protection.assertHeld();
            if (
              !sameW5RootEvidenceScope(
                await desktopW5BackupRootScope(),
                rootScope,
              )
            )
              throw new W5BackupRefusedError('source-changed', 'data root');
          },
          retainClaim: (): void => protection.retainClaim(),
        },
        () => captureOnce(previous, buildVersion, undefined, context),
      );
      return;
    }
    const context = bootstrapContext ?? (await desktopW5BackupContext());
    scope = await w5RootEvidenceScope(context.dataRoot);
    try {
      backup = await captureW5Backup(context);
      commitId = (await requireVerifiedW5Backup(context, backup, 0)).position
        .commitId;
    } catch (error) {
      if (
        !(error instanceof W5BackupRefusedError) ||
        error.reason !== 'missing-source' ||
        error.resource !== 'index.json' ||
        !(await isEmptyRoot(context))
      )
        throw error;
      backup = 'empty-root';
      commitId = 0;
    }
  } catch (error) {
    // Preserve W5 classifications from recursive bootstrap capture only.
    if (canopyDaemonRefusal(error) || w5FlipStepFailure(error)) throw error;
    // Another writer holds the log, so a daemon spawned now could not open
    // it either. A later launch captures, labeled after the flip (Q1(a)).
    if (writerHeld(error)) {
      if (previous === null) await deferMarker(buildVersion).catch(() => {});
      throw canopyDaemonRefusalError(
        'writer_held',
        'Another app holds the workspace records.',
      );
    }
    throw stepError(
      'backup_refused',
      'The workspace records backup failed.',
      error instanceof W5BackupRefusedError ? error.reason : 'host-unavailable',
    );
  }
  // Written last: a launch that stops earlier captures again.
  try {
    const marker: CapturedMarker = {
      version: 1,
      state: 'captured',
      backup,
      commitId,
      capturedAt: new Date().toISOString(),
      buildVersion,
      // Neither absent history nor commit zero proves no pre-artifact service.
      capture: 'captured-after-flip',
    };
    await publishCompletion(marker, scope);
    await writeMarker(marker);
  } catch {
    throw stepError(
      'backup_refused',
      'The workspace records backup failed.',
      'marker-unwritable',
    );
  }
}

/**
 * Fresh evidence checks and confirmed ordinary-host shutdown for one spawn
 * attempt. POSIX runs under the startup claim; Windows runs at the connection
 * boundary after a non-spawning probe proves absence. No prepared permission
 * survives this attempt.
 */
export async function prepareW5FlipSpawn(
  buildVersion: string,
  protection?: W5BackupBootstrapProtection,
): Promise<void> {
  let scope: W5RootEvidenceScope;
  try {
    scope = await w5RootEvidenceScope(getDataDir());
  } catch {
    throw stepError(
      'backup_refused',
      'The workspace records backup failed.',
      'source-unreadable',
    );
  }
  const completed = await readCompletion();
  const marker = completed ?? (await readCompatibilityMarker());
  if (marker?.state === 'captured' && !completed) {
    // A legacy empty-root marker has no bytes to independently verify.
    if (marker.backup !== 'empty-root') {
      try {
        await verifyHistoricalCapture(marker, scope);
        await publishCompletion(marker, scope);
      } catch {
        throw completionFailure();
      }
    } else if (!isW5CommitLogHostShutDown())
      await captureOnce(marker, buildVersion, protection);
    else if (!daemonServedHere(scope)) throw completionFailure();
  }
  if (marker?.state !== 'captured') {
    if (!isW5CommitLogHostShutDown())
      await captureOnce(marker, buildVersion, protection);
    // A respawn after this process stopped its log, as after a daemon crash,
    // cannot capture; it proceeds only where a daemon already served W5, and
    // the next launch captures.
    else if (!daemonServedHere(scope))
      throw stepError(
        'backup_refused',
        'The workspace records backup failed.',
        'host-stopped',
      );
  }
  await stopInProcessW5Host();
  if (!sameW5RootEvidenceScope(await w5RootEvidenceScope(getDataDir()), scope))
    throw completionFailure();
}

/** Fences in-process W5 use; refuses while a worker may still hold the log. */
export async function stopInProcessW5Host(): Promise<void> {
  let bootstrapFailed = false;
  try {
    await retireW5BackupBootstrap();
  } catch {
    bootstrapFailed = true;
  }
  await shutdownW5CommitLogHost();
  if (bootstrapFailed || runningW5CommitLogWorkers() !== 0)
    throw stepError(
      'in_process_host_running',
      'The in-app workspace records host did not stop.',
    );
}

async function deferMarker(buildVersion: string): Promise<void> {
  const marker: W5FlipBackupMarker = {
    version: 1,
    state: 'deferred',
    deferredAt: new Date().toISOString(),
    buildVersion,
  };
  try {
    await writeFileAtomically(
      getW5FlipBackupMarkerPath(),
      `${JSON.stringify(marker, null, 2)}\n`,
      {
        durable: true,
        mode: 0o600,
        overwrite: false,
      },
    );
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'EEXIST') throw error;
  }
}

/**
 * A W5-capable daemon was discovered, so capture waits for a later launch.
 * Deferral records history, not successful service through this process.
 */
export async function deferW5FlipBackup(buildVersion: string): Promise<void> {
  if (await readCompletionMetadata()) return;
  if ((await readCompatibilityMarker()) !== null) return;
  await deferMarker(buildVersion);
}

import {
  withW5BackupBootstrap,
  createW5BackupBootstrapContext,
  retireW5BackupBootstrap,
  type W5BackupBootstrapProtection,
} from './w5-backup-bootstrap';
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readFile, readdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  publishW5RootEvidence,
  readW5RootEvidence,
  sameW5RootEvidenceScope,
  w5RootEvidenceId,
  w5RootEvidenceScope,
  type W5RootEvidenceScope,
} from '@canopy/core-runtime/node/w5/service-history';
import {
  observeW5LogBeforeWriters,
  w5LogMatchesObservation,
  type W5PreWriterLog,
} from '@canopy/core-runtime/node/w5/readonly-backup-position';
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
import {
  getDataDir,
  getW5FlipBackupMarkerPath,
  w5RecordReadPaths,
} from './paths';
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
import {
  BACKGROUND_SERVICE_BACKUP_WARNINGS,
  type BackgroundServiceBackupWarning,
} from '@canopy/desktop-shared/lib/background-service-status';

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
  return completed.kind === 'verified'
    ? completed.marker
    : await readCompatibilityMarker();
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

/**
 * Whether the backup a captured marker names still verifies. Only a root
 * change refuses; any other failure is evidence that cannot be relied on.
 */
async function historicalCaptureVerifies(
  marker: CapturedMarker,
  scope: W5RootEvidenceScope,
): Promise<boolean> {
  if (marker.backup === 'empty-root') return true;
  let context: W5BackupReadContext;
  try {
    context = await desktopW5BackupContext();
  } catch {
    throw completionFailure();
  }
  const requireScope = async (): Promise<void> => {
    let current: W5RootEvidenceScope;
    try {
      current = await w5RootEvidenceScope(context.dataRoot);
    } catch {
      throw completionFailure();
    }
    if (!sameW5RootEvidenceScope(current, scope)) throw completionFailure();
  };
  await requireScope();
  let verified: boolean;
  try {
    const record = await verifyW5Backup(context, marker.backup);
    verified = record.position.commitId === marker.commitId;
  } catch {
    verified = false;
  }
  await requireScope();
  return verified;
}

type CompletionMetadata =
  | { readonly kind: 'missing' }
  /** Present but unreadable or malformed. */
  | { readonly kind: 'unverified'; readonly path: string }
  | {
      readonly kind: 'found';
      readonly marker: CapturedMarker;
      readonly scope: W5RootEvidenceScope;
      readonly directoryScope: W5RootEvidenceScope;
      readonly path: string;
    };

/** Metadata only: neither backup verification nor spawn admission. */
async function readCompletionMetadata(): Promise<CompletionMetadata> {
  let location: Awaited<ReturnType<typeof completionLocation>>;
  try {
    location = await completionLocation();
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT')
      return { kind: 'missing' };
    throw completionFailure();
  }
  const { scope, directoryScope, path } = location;
  let value: unknown;
  try {
    value = await readW5RootEvidence(path);
  } catch {
    return { kind: 'unverified', path };
  }
  if (value === undefined) return { kind: 'missing' };
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !sameW5RootEvidenceScope(value.scope, scope) ||
    !isMarker(value.marker) ||
    value.marker.state !== 'captured'
  )
    return { kind: 'unverified', path };
  return { kind: 'found', marker: value.marker, scope, directoryScope, path };
}

/**
 * Old publishers replace the compatibility marker, but never this evidence.
 * Evidence that is unreadable, malformed or names a backup that no longer
 * verifies counts as no completion (CAN-7849): the launch captures again
 * instead of refusing every launch over the same file.
 */
type Completion =
  | { readonly kind: 'verified'; readonly marker: CapturedMarker }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unverified'; readonly path: string };

async function readCompletion(): Promise<Completion> {
  const completed = await readCompletionMetadata();
  if (completed.kind !== 'found') return completed;
  const { marker, scope, directoryScope, path } = completed;
  if (!(await historicalCaptureVerifies(marker, scope)))
    return { kind: 'unverified', path };
  try {
    // Resolve an earlier directory-flush uncertainty before accepting completion.
    await publishCompletion(marker, scope, directoryScope);
  } catch {
    throw completionFailure();
  }
  return { kind: 'verified', marker };
}

/**
 * Keeps unverified evidence beside its name, never deleted or overwritten,
 * right before a verified replacement publishes. Publication refuses over
 * evidence it cannot validate, so the old file must move first.
 */
async function setAsideUnverifiedEvidence(
  paths: readonly string[],
  scope: W5RootEvidenceScope,
): Promise<void> {
  if (paths.length === 0) return;
  if (!sameW5RootEvidenceScope(await w5RootEvidenceScope(getDataDir()), scope))
    throw completionFailure();
  for (const path of paths) {
    try {
      await rename(path, `${path}.unverified-${randomUUID()}`);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
    }
    await syncDirectory(dirname(path));
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
  underlying?: unknown,
): CanopyClientError {
  const error = new CanopyClientError({
    kind: 'failed_precondition',
    message,
    retry: { kind: 'never' },
    details: { w5Handoff: failure, ...(detail !== undefined && { detail }) },
  });
  if (underlying !== undefined)
    Object.defineProperty(error, 'cause', {
      value: underlying,
      configurable: true,
      writable: true,
    });
  return error;
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

/**
 * A fresh root: no index, no index backup, no workspace records, no commit.
 * A workspace directory without record files is admitted: a backup keeps only
 * the index, manifests and worktree lists, so it has nothing to keep, and the
 * `empty-root` marker removes nothing. This unsticks a root a degraded
 * handoff left with only a Cowork scaffold (CAN-7316).
 */
async function isEmptyRoot(context: W5BackupReadContext): Promise<boolean> {
  const workspacesRoot = join(context.dataRoot, 'workspaces');
  let entries: Dirent[] = [];
  try {
    entries = await readdir(workspacesRoot, { withFileTypes: true });
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') return false;
  }
  if (
    entries.some(
      (entry) => entry.isSymbolicLink() || entry.name === 'index.json.bak',
    )
  )
    return false;
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      !(await holdsNoW5Records(join(workspacesRoot, entry.name), entry.name))
    )
      return false;
  }
  return (await context.host.snapshot()).commitId === 0;
}

/**
 * Whether one workspace directory holds no W5 record file, read one level
 * deep: records sit directly under it, so `home/` is never entered. A record
 * name anywhere in a child's name counts, catching the atomic writer's
 * `.<record>.<pid>.<id>.tmp` siblings; so does any direct symlink. An
 * unreadable directory or an id the path helpers reject is not empty.
 */
async function holdsNoW5Records(
  directory: string,
  workspaceId: string,
): Promise<boolean> {
  let recordNames: readonly string[];
  try {
    recordNames = [
      basename(w5RecordReadPaths.manifest(workspaceId)),
      basename(w5RecordReadPaths.worktrees(workspaceId)),
    ];
  } catch {
    return false;
  }
  let children: Dirent[];
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  return !children.some(
    (child) =>
      child.isSymbolicLink() ||
      recordNames.some((record) => child.name.includes(record)),
  );
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

/**
 * A capture refusal a launch may survive (CAN-7274 B2): the backup's own
 * source or copy refused, never its root, host, claim, writer or peer.
 * `failure` is the refusal the base threw, for a launch that must still refuse.
 */
interface CaptureRefusal {
  readonly warning: BackgroundServiceBackupWarning;
  readonly failure: CanopyClientError;
}

/** Resolves only after any bootstrap worker exited and released exclusion. */
async function captureOnce(
  previous: W5FlipBackupMarker | null,
  buildVersion: string,
  unverified: readonly string[],
  protection?: W5BackupBootstrapProtection,
  bootstrapContext?: W5BackupContext,
): Promise<CaptureRefusal | undefined> {
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
      return await withW5BackupBootstrap(
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
        () =>
          captureOnce(previous, buildVersion, unverified, undefined, context),
      );
    }
    const context = bootstrapContext ?? (await desktopW5BackupContext());
    scope = await w5RootEvidenceScope(context.dataRoot);
    try {
      backup = await captureW5Backup(context);
      commitId = (await requireVerifiedW5Backup(context, backup, 0)).position
        .commitId;
    } catch (error) {
      if (!(error instanceof W5BackupRefusedError)) throw error;
      if (
        error.reason !== 'missing-source' ||
        error.resource !== 'index.json' ||
        !(await isEmptyRoot(context))
      ) {
        const warning = BACKGROUND_SERVICE_BACKUP_WARNINGS.find(
          (reason) => reason === error.reason,
        );
        if (warning === undefined) throw error;
        return {
          warning,
          failure: stepError(
            'backup_refused',
            'The workspace records backup failed.',
            error.reason,
            error,
          ),
        };
      }
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
      error,
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
    await setAsideUnverifiedEvidence(unverified, scope);
    await publishCompletion(marker, scope);
    await writeMarker(marker);
  } catch (error) {
    throw stepError(
      'backup_refused',
      'The workspace records backup failed.',
      'marker-unwritable',
      error,
    );
  }
  return undefined;
}

/**
 * First observation of each root's log in this process, before its writers.
 * Kept for every root: returning to a root must not observe its own writes.
 */
const logsBeforeWriters: {
  readonly scope: W5RootEvidenceScope;
  readonly log: Promise<W5PreWriterLog>;
}[] = [];

function observeLogBeforeWriters(
  scope: W5RootEvidenceScope,
  protection?: W5BackupBootstrapProtection,
): Promise<W5PreWriterLog> {
  const known = logsBeforeWriters.find((entry) =>
    sameW5RootEvidenceScope(entry.scope, scope),
  );
  if (known) return known.log;
  const log = observeW5LogBeforeWriters(
    scope.canonicalDataRoot,
    syncDirectory,
    () => admitLogSetAside(scope, protection),
  );
  logsBeforeWriters.push({ scope, log });
  return log;
}

/**
 * The one admission for moving an unopenable log aside, on every platform:
 * this process's first check of the root, before any writer of this launch,
 * with no in-process W5 worker or stopped host (a daemon may have served it)
 * and the startup claim, where there is one, still held. Another process
 * holding the log is excluded by the check's own locked read.
 */
async function admitLogSetAside(
  scope: W5RootEvidenceScope,
  protection?: W5BackupBootstrapProtection,
): Promise<boolean> {
  if (isW5CommitLogHostShutDown() || runningW5CommitLogWorkers() !== 0)
    return false;
  try {
    await protection?.assertHeld();
    return sameW5RootEvidenceScope(
      await w5RootEvidenceScope(getDataDir()),
      scope,
    );
  } catch {
    return false;
  }
}

/**
 * A refused capture launches only over the log as found before this launch's
 * first writer: none, one that passed the read-only check, or a damaged one
 * whose bytes were copied first, and still that file. The decision follows
 * that one observation, never what this launch's writers did to the log
 * since, so every launch decides the same log the same way. Linked, newer
 * or uncopied damaged logs keep the base refusal.
 */
function advisoryLogHolds(
  scope: W5RootEvidenceScope,
  log: W5PreWriterLog,
): Promise<boolean> {
  return w5LogMatchesObservation(scope.canonicalDataRoot, log);
}

/** This launch's advisory for a root; a crash respawn reuses it, never capture. */
let advisoryLaunch:
  | {
      readonly scope: W5RootEvidenceScope;
      readonly warning: BackgroundServiceBackupWarning;
      readonly log: W5PreWriterLog;
    }
  | undefined;

export type W5FlipPreparation =
  | { readonly kind: 'prepared' }
  | {
      readonly kind: 'advisory';
      readonly reason: BackgroundServiceBackupWarning;
    };

/**
 * Fresh evidence checks and confirmed ordinary-host shutdown for one spawn
 * attempt. POSIX runs under the startup claim; Windows runs at the connection
 * boundary after a non-spawning probe proves absence. No prepared permission
 * survives this attempt.
 */
export async function prepareW5FlipSpawn(
  buildVersion: string,
  protection?: W5BackupBootstrapProtection,
): Promise<W5FlipPreparation> {
  let scope: W5RootEvidenceScope;
  try {
    scope = await w5RootEvidenceScope(getDataDir());
  } catch (error) {
    throw stepError(
      'backup_refused',
      'The workspace records backup failed.',
      'source-unreadable',
      error,
    );
  }
  let advisory: (CaptureRefusal & { readonly log: W5PreWriterLog }) | undefined;
  /** A stopped host cannot capture; this launch's advisory may still respawn. */
  const respawnAdvisory = (failure: CanopyClientError): void => {
    const cached =
      advisoryLaunch && sameW5RootEvidenceScope(advisoryLaunch.scope, scope)
        ? advisoryLaunch
        : undefined;
    if (!cached) throw failure;
    advisory = { warning: cached.warning, failure, log: cached.log };
  };
  /** Evidence a verified replacement moves aside before it publishes. */
  const unverified: string[] = [];
  const capture = async (
    previous: W5FlipBackupMarker | null,
  ): Promise<void> => {
    // Before the capture starts the bootstrap, which opens the log.
    const log = await observeLogBeforeWriters(scope, protection);
    const refused = await captureOnce(
      previous,
      buildVersion,
      unverified,
      protection,
    );
    if (!refused) return;
    // The bootstrap has exited; refusing here keeps the base retry, which captures.
    if (!(await advisoryLogHolds(scope, log))) throw refused.failure;
    advisory = { ...refused, log };
  };
  const completed = await readCompletion();
  if (completed.kind === 'unverified') unverified.push(completed.path);
  const legacy =
    completed.kind === 'verified' ? null : await readCompatibilityMarker();
  let captured = completed.kind === 'verified';
  // A legacy empty-root marker has no bytes to independently verify.
  if (
    !captured &&
    legacy?.state === 'captured' &&
    legacy.backup !== 'empty-root'
  ) {
    if (await historicalCaptureVerifies(legacy, scope)) {
      try {
        await setAsideUnverifiedEvidence(unverified, scope);
        await publishCompletion(legacy, scope);
      } catch {
        throw completionFailure();
      }
      captured = true;
    } else unverified.push(getW5FlipBackupMarkerPath());
  }
  if (!captured) {
    if (!isW5CommitLogHostShutDown()) await capture(legacy);
    // A respawn after this process stopped its log, as after a daemon crash,
    // cannot capture; it proceeds only where a daemon already served W5 or
    // this launch's advisory stands, and the next launch captures.
    else if (!daemonServedHere(scope))
      respawnAdvisory(
        legacy?.state === 'captured' || unverified.length > 0
          ? completionFailure()
          : stepError(
              'backup_refused',
              'The workspace records backup failed.',
              'host-stopped',
            ),
      );
  }
  await stopInProcessW5Host();
  if (!sameW5RootEvidenceScope(await w5RootEvidenceScope(getDataDir()), scope))
    throw completionFailure();
  if (!advisory) return { kind: 'prepared' };
  // Retired and stopped: the daemon opens the log next. No completion is written.
  if (!(await advisoryLogHolds(scope, advisory.log))) throw advisory.failure;
  try {
    await protection?.assertHeld();
  } catch (error) {
    throw stepError(
      'backup_refused',
      'The workspace records backup failed.',
      'host-unavailable',
      error,
    );
  }
  advisoryLaunch = { scope, warning: advisory.warning, log: advisory.log };
  return { kind: 'advisory', reason: advisory.warning };
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
  if ((await readCompletionMetadata()).kind !== 'missing') return;
  if ((await readCompatibilityMarker()) !== null) return;
  await deferMarker(buildVersion);
}

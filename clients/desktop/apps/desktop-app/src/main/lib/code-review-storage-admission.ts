import {
  assertAdmittedWriter,
  STORAGE_OWNERSHIP,
} from '@canopy/core-runtime/storage';
import { failDesktopOperation } from '@canopy/desktop-instrumentation/electron/main';
import type { PredecessorAdoption } from './code-review-namespace-reconciliation';
import {
  logMainProcessError,
  logMainProcessWarn,
} from './main-process-logging';
import {
  getCodeReviewRegistryFilePath,
  getDataDir,
  withCodeReviewStorageIdentity,
} from './paths';

type ReviewNamespace =
  | 'code_review_registry'
  | 'code_review_chats_dir'
  | 'code_review_chats_legacy'
  | 'code_review_state';

/** Effects that proceed on the routed root when qualification failed. */
export type CodeReviewNamespaceEffect =
  | 'mutation'
  | 'cold_load'
  | 'promotion'
  | 'cleanup';

type QualificationReason =
  | 'unresolved'
  | 'routing_changed'
  | 'disk_full'
  | 'permission'
  | 'io';

function qualificationReason(error: unknown): QualificationReason {
  try {
    if (error === 'routing_changed') return 'routing_changed';
    const code: unknown =
      typeof error === 'object' && error !== null
        ? Reflect.get(error, 'code')
        : undefined;
    if (code === 'ENOSPC' || code === 'EDQUOT') return 'disk_full';
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
      return 'permission';
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return 'io';
  } catch {
    // Error getters and proxies are untrusted diagnostic input.
  }
  return 'unresolved';
}

/** A failed qualification. It is recorded and reported, never thrown. */
export class CodeReviewNamespaceQualificationError extends Error {
  readonly code = 'code_review_namespace_unqualified';
  readonly reason: QualificationReason;
  constructor(readonly detail: unknown) {
    super(
      `Code review namespace reconciliation did not complete: ${detail instanceof Error ? detail.message : String(detail)}`,
    );
    this.name = 'CodeReviewNamespaceQualificationError';
    this.reason = qualificationReason(detail);
  }
}

interface Qualification {
  settled: boolean;
  ready: Promise<void>;
  admission?: Promise<void>;
  failure?: CodeReviewNamespaceQualificationError;
  routingFailure?: CodeReviewNamespaceQualificationError;
  /** Effects already reported as proceeding unqualified, once per attempt. */
  proceeded: Set<CodeReviewNamespaceEffect>;
  /** Startup only: the Code Review workspace tree has not finished moving. */
  workspaceTreePending: boolean;
}

const namespaces = new Map<string, Qualification>();
const qualified = new Map<string, string>();
// One second caps advisory latency, not migration duration: real-worktree
// review state is outside the moved chat tree; registry writes and chat cold
// loads retain their fences. Revisit with reconciliation cancellation.
const QUALIFICATION_WAIT_MS = 1_000;

function report(
  effect: CodeReviewNamespaceEffect | 'qualification',
  failure: CodeReviewNamespaceQualificationError,
): void {
  try {
    if (effect === 'qualification')
      logMainProcessError(
        '[code-review] namespace qualification failed; Code Review keeps using its routed root',
        failure,
      );
    else
      logMainProcessWarn(
        '[code-review] proceeding on an unqualified namespace',
        { effect, reason: failure.reason },
      );
  } catch {
    // A logging failure must not suppress the independent telemetry attempt.
  }
  try {
    failDesktopOperation('canopy.chat_review_namespace', 'error', {
      context: { namespace_effect: effect, namespace_reason: failure.reason },
    });
  } catch {
    // Instrumentation must not change Code Review results.
  }
}

/**
 * Publishes the attempt synchronously, so waiters on `previous` move to it
 * before any of them can run between the two reconciliations.
 */
function startQualification(
  root: string,
  startup: boolean,
  previous?: Qualification,
): Qualification {
  const next: Qualification = {
    settled: false,
    ready: Promise.resolve(),
    // A queued startup retry must not restart an existing admission deadline.
    admission: previous?.admission,
    proceeded: new Set(),
    // Cleared only once reconciliation or the fallback accounts for the tree.
    workspaceTreePending: true,
  };
  let path = '';
  next.ready = (previous?.ready ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => {
      path = getCodeReviewRegistryFilePath();
      qualified.delete(root);
      return Promise.all([
        import('./code-review-namespace-reconciliation'),
        import('./code-review-registry'),
      ]);
    })
    .then(([reconciliation, registry]) =>
      // An operation admitted before this attempt may still be running, so
      // registry mutations wait from capture through publication.
      registry.withCodeReviewRegistryMutationsHeld(async () => {
        try {
          await reconciliation.reconcileCodeReviewNamespaces();
          // A qualified root has no predecessor left outside its namespace.
          next.workspaceTreePending = false;
          if (getDataDir() !== root || getCodeReviewRegistryFilePath() !== path)
            throw new CodeReviewNamespaceQualificationError('routing_changed');
          qualified.set(root, path);
        } catch (error) {
          next.failure =
            error instanceof CodeReviewNamespaceQualificationError
              ? error
              : new CodeReviewNamespaceQualificationError(error);
          report('qualification', next.failure);
          // Base moved predecessors only at startup, after routing was loaded.
          if (startup && next.failure.reason !== 'routing_changed')
            next.workspaceTreePending = await adoptPredecessors(reconciliation);
        }
      }),
    )
    .catch((error: unknown) => {
      next.failure = new CodeReviewNamespaceQualificationError(error);
      report('qualification', next.failure);
    })
    .finally(() => {
      next.settled = true;
    });
  namespaces.set(root, next);
  return next;
}

/** Moves predecessors; resolves whether the workspace tree is still pending. */
async function adoptPredecessors(reconciliation: {
  adoptUnqualifiedCodeReviewPredecessors: () => Promise<PredecessorAdoption>;
}): Promise<boolean> {
  try {
    const { adopted, failed, workspaceTreePending } =
      await reconciliation.adoptUnqualifiedCodeReviewPredecessors();
    try {
      if (failed > 0)
        logMainProcessError(
          '[code-review] some predecessor entries did not move; the next launch retries them',
          { adopted, failed },
        );
      else if (adopted > 0)
        logMainProcessWarn(
          '[code-review] moved predecessor entries missing from the unqualified namespace',
          { adopted },
        );
    } catch {
      // Logging must not change the qualification outcome.
    }
    return workspaceTreePending;
  } catch (error) {
    // Unmoved predecessors stay where they are until the next launch retries.
    try {
      logMainProcessError(
        '[code-review] could not move predecessor entries into the unqualified namespace',
        error,
      );
    } catch {
      // Logging must not change the qualification outcome.
    }
    return true;
  }
}

/**
 * Reconciles the routed root once per process; startup (`retry`) always runs
 * its own attempt after any in-flight one. Always resolves: q-34 makes a
 * failure a guardrail, so callers proceed as before this installment.
 */
export async function ensureCodeReviewNamespaceQualification(
  retry = false,
): Promise<CodeReviewNamespaceQualificationError | undefined> {
  try {
    const root = getDataDir();
    let entry = namespaces.get(root);
    // Startup always runs its own attempt, queued behind any in-flight one.
    if (!entry || retry)
      entry = startQualification(
        root,
        retry,
        entry && !entry.settled ? entry : undefined,
      );
    // A startup retry may replace the entry while this caller waits.
    for (;;) {
      await entry.ready;
      const latest = namespaces.get(root);
      if (!latest || latest === entry) break;
      entry = latest;
    }
    return currentFailure();
  } catch (error) {
    // Bookkeeping faults are guardrail failures too, never an operation error.
    const failure = new CodeReviewNamespaceQualificationError(error);
    report('qualification', failure);
    return failure;
  }
}

/** Bounds advisory admission only; reconciliation and its registry hold continue. */
export async function waitForCodeReviewNamespaceQualification(): Promise<void> {
  try {
    const root = getDataDir();
    const entry = namespaces.get(root) ?? startQualification(root, false);
    // Share one deadline/warning per pending chain: nested and later writes
    // must not each pay another timeout while it stays pending.
    entry.admission ??= waitForQualificationAdmission();
    await entry.admission;
  } catch (error) {
    report('qualification', new CodeReviewNamespaceQualificationError(error));
  }
}

async function waitForQualificationAdmission(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      ensureCodeReviewNamespaceQualification().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), QUALIFICATION_WAIT_MS);
      }),
    ]);
    if (!settled) {
      try {
        logMainProcessWarn(
          '[code-review] namespace qualification still pending; proceeding after bounded admission wait',
          { waitMs: QUALIFICATION_WAIT_MS },
        );
      } catch {
        // Logging must not turn advisory qualification into a refusal.
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/** The settled failure for the current root and routing, if any. */
function currentFailure(): CodeReviewNamespaceQualificationError | undefined {
  const entry = namespaces.get(getDataDir());
  if (!entry?.settled) return undefined;
  if (entry.failure) return entry.failure;
  if (qualified.get(getDataDir()) === getCodeReviewRegistryFilePath())
    return undefined;
  // Routing moved after a successful qualification; it may move back.
  if (!entry.routingFailure) {
    entry.routingFailure = new CodeReviewNamespaceQualificationError(
      'routing_changed',
    );
    report('qualification', entry.routingFailure);
  }
  return entry.routingFailure;
}

/**
 * Guardrail for an effect that used to refuse: logs and reports once per
 * effect and failed attempt, then lets the caller proceed. Silent before the
 * first qualification attempt settles, as before this installment.
 */
export function noteCodeReviewNamespaceEffect(
  effect: CodeReviewNamespaceEffect,
): void {
  try {
    const failure = currentFailure();
    const entry = namespaces.get(getDataDir());
    if (!failure || !entry || entry.proceeded.has(effect)) return;
    entry.proceeded.add(effect);
    report(effect, failure);
  } catch {
    // The guardrail must never become the refusal it replaces.
  }
}

/**
 * Whether startup must leave `app_workspaces` unrecorded so the next launch
 * retries the Code Review workspace-tree move, as base's throw did.
 */
export function isCodeReviewWorkspaceTreePending(): boolean {
  return namespaces.get(getDataDir())?.workspaceTreePending !== false;
}

/** Witness for the current root: the failure and the effects that proceeded. */
export function getCodeReviewNamespaceGuardrail(): {
  qualified: boolean;
  failure?: CodeReviewNamespaceQualificationError;
  proceeded: CodeReviewNamespaceEffect[];
} {
  const failure = currentFailure();
  return {
    qualified: qualified.get(getDataDir()) === getCodeReviewRegistryFilePath(),
    ...(failure ? { failure } : {}),
    proceeded: Array.from(namespaces.get(getDataDir())?.proceeded ?? []),
  };
}

/** Current-owner protection, not namespace qualification or a writer transfer. */
export function assertCodeReviewStorageWriter(
  namespace: ReviewNamespace,
  module: string,
): void {
  assertAdmittedWriter(namespace, 'electron_main', module, STORAGE_OWNERSHIP);
}

// A root/key lease spans teardown, never the global registry mutation queue.
const lifecycles = new Map<string, Promise<unknown>>();

export async function withCodeReviewTargetLifecycle<T>(
  registryPath: string,
  scopeKey: string,
  operation: (waited: boolean) => Promise<T>,
): Promise<T> {
  return withCodeReviewStorageIdentity(async () => {
    await waitForCodeReviewNamespaceQualification();
    noteCodeReviewNamespaceEffect('mutation');
    if (getCodeReviewRegistryFilePath() !== registryPath)
      throw new Error('Code review storage routing changed before admission.');
    const key = JSON.stringify([registryPath, scopeKey]);
    const previous = lifecycles.get(key);
    const next = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => operation(previous !== undefined));
    lifecycles.set(key, next);
    try {
      return await next;
    } finally {
      if (lifecycles.get(key) === next) lifecycles.delete(key);
    }
  });
}

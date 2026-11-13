import type { InternalRootMigrationWorker } from '@canopy/core-runtime/node/internal-root-migration';
import { AsyncLocalStorage } from 'node:async_hooks';
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

interface Progress {
  lastProgress: number;
  detail: string;
  readonly abort: AbortController;
}
const active = new AsyncLocalStorage<Progress>();

/** Completed work, never a timer tick or an outstanding filesystem request. */
export function internalRootMigrationProgress(detail: string): void {
  const progress = active.getStore();
  if (!progress) return;
  progress.lastProgress = performance.now();
  progress.detail = detail;
}

export function internalRootMigrationAbortSignal(): AbortSignal | undefined {
  return active.getStore()?.abort.signal;
}

/** Only the offline operator opts in; ordinary startup has no timers or output. */
export async function runInternalRootMigrationPhase<T>(
  phase: string,
  operation: () => Promise<T>,
  options: {
    readonly heartbeatMs?: number;
    readonly stallMs?: number;
    readonly announce?: boolean;
  } = {},
): Promise<T> {
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const stallMs = options.stallMs ?? 10 * 60_000;
  const started = performance.now();
  const progress: Progress = {
    lastProgress: started,
    detail: 'progress unknown',
    abort: new AbortController(),
  };
  const report = (): void => {
    process.stderr.write(
      `Migration: ${phase}; elapsed ${Math.floor((performance.now() - started) / 1000)}s; ${progress.detail}\n`,
    );
  };
  if (options.announce !== false) process.stderr.write(`Migration: ${phase}\n`);
  // Keep this referenced: a lost FS completion can leave no other active handles.
  const timer = setInterval(
    () => {
      report();
      if (performance.now() - progress.lastProgress < stallMs) return;
      clearInterval(timer);
      progress.abort.abort();
      const refusal = {
        kind: 'refused',
        reason: 'migration-stalled',
        recovery: `No progress in phase ${phase} for ${Math.floor(stallMs / 1000)}s. It is safe to re-run the same command; migration will resume from its journal. For a cleanup report, re-run --inventory instead. Keep both roots and all coordination evidence, and keep writers stopped.`,
      };
      // Do not race an uncancellable FS promise with finally/release: end this
      // process so outstanding writes cannot continue after exclusion is released.
      writeSync(2, `${JSON.stringify(refusal)}\n`);
      process.exit(1);
    },
    Math.min(heartbeatMs, stallMs),
  );
  try {
    return await active.run(progress, operation);
  } finally {
    clearInterval(timer);
  }
}

/** Offline composition only: startup uses the unmonitored worker. */
export function monitorInternalRootMigrationWorker(
  worker: InternalRootMigrationWorker,
  options: { readonly heartbeatMs?: number; readonly stallMs?: number } = {},
): InternalRootMigrationWorker {
  function phase<Args extends unknown[], Result>(
    name: string,
    operation: (...args: Args) => Promise<Result>,
    announce = true,
  ): (...args: Args) => Promise<Result> {
    return (...args) =>
      runInternalRootMigrationPhase(name, () => operation(...args), {
        ...options,
        announce,
      });
  }
  return {
    ...worker,
    ...(worker.diagnose
      ? { diagnose: phase('W5 diagnosis', worker.diagnose.bind(worker)) }
      : {}),
    readJournal: phase(
      'Reading journal',
      worker.readJournal.bind(worker),
      false,
    ),
    space: phase(
      'Checking destination space',
      worker.space.bind(worker),
      false,
    ),
    saveJournal: (journal) =>
      runInternalRootMigrationPhase(
        `${journal.phase}: saving journal`,
        () => worker.saveJournal(journal),
        { ...options, announce: false },
      ),
    coordinate: async (identity) => {
      const release = await phase(
        'Acquiring coordination',
        worker.coordinate.bind(worker),
        false,
      )(identity);
      return phase('Releasing coordination', release, false);
    },
    validateStaging: phase(
      'Validating staging',
      worker.validateStaging.bind(worker),
      false,
    ),
    validateExternal: phase(
      'Validating external files',
      worker.validateExternal.bind(worker),
      false,
    ),
    exposeStaging: phase(
      'Exposing staging',
      worker.exposeStaging.bind(worker),
      false,
    ),
    validateRebuild: phase(
      'Validating rebuild',
      worker.validateRebuild.bind(worker),
      false,
    ),
    discardDestination: phase(
      'Discarding destination',
      worker.discardDestination.bind(worker),
      false,
    ),
    preserveUnpublished: phase(
      'Preserving unpublished transaction',
      worker.preserveUnpublished.bind(worker),
      false,
    ),
    captureExternal: phase(
      'Capturing external files',
      worker.captureExternal.bind(worker),
      false,
    ),
    sealExternal: phase(
      'Sealing external files',
      worker.sealExternal.bind(worker),
      false,
    ),
    assertExternalPreimages: phase(
      'Checking external preimages',
      worker.assertExternalPreimages.bind(worker),
      false,
    ),
    restoreExternal: phase(
      'Restoring external files',
      worker.restoreExternal.bind(worker),
      false,
    ),
    validateSecureResume: phase(
      'Validating secure resume',
      worker.validateSecureResume.bind(worker),
      false,
    ),
    inventory: phase('Walking source', worker.inventory.bind(worker)),
    proveCold: phase('Cold proof', worker.proveCold.bind(worker)),
    recoverW5: phase('W5 recovery', worker.recoverW5.bind(worker)),
    build: phase('Building destination', worker.build.bind(worker)),
    seal: phase('Sealing destination', worker.seal.bind(worker)),
    publicationRoot: phase(
      'publishing: checking seal',
      worker.publicationRoot.bind(worker),
    ),
    publish: phase('Publishing destination', worker.publish.bind(worker)),
    assertExternalPostimages: phase(
      'publishing: external metadata',
      worker.assertExternalPostimages.bind(worker),
    ),
    relocateSecure: phase(
      'Secure relocation',
      worker.relocateSecure.bind(worker),
    ),
  };
}

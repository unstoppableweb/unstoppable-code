import { createAppError } from '@canopy/protocol/app-errors';
import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';
import {
  registerSpawnEnvironmentFailureReporter,
  type SpawnEnvironmentFailure,
} from '../pipelines/config-paths';
import { logMainProcessWarn } from '../lib/main-process-logging';

/** Allowlisted app-error source for a spawn environment injector failure. */
function spawnEnvironmentFailureSource(
  failure: Pick<SpawnEnvironmentFailure, 'source' | 'code'>,
): string {
  return `spawn-env.${failure.source}.${failure.code}`;
}

/**
 * Report a spawn environment injector failure through the main app-error
 * handler. Only the source and code leave; the latch in config-paths retries
 * an unrecorded report, so this returns whether it was recorded.
 */
function reportSpawnEnvironmentFailure(
  failure: SpawnEnvironmentFailure,
): boolean {
  if (failure.firstAttempt) {
    logMainProcessWarn(
      '[spawn-env] Spawns are starting without a stored environment part',
      { source: failure.source, code: failure.code },
    );
  }
  const report = reportMainAppError(
    createAppError('external.service_unavailable', {
      source: spawnEnvironmentFailureSource(failure),
    }),
  );
  return report !== undefined && report.disposition !== 'none';
}

/**
 * Wire main-process reporting for spawn environment injector failures. Each
 * injector registration calls this, so it is safe to call more than once.
 */
export function initializeSpawnEnvironmentFailureReporting(): void {
  registerSpawnEnvironmentFailureReporter(reportSpawnEnvironmentFailure);
}

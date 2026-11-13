import * as path from 'node:path';
import type { ExecutionState } from '@canopy/execution-engine/node/pipelines/executor/types';

function relocateValue(
  value: unknown,
  sourceOutputDir: string,
  destinationOutputDir: string,
): unknown {
  if (typeof value === 'string') {
    if (!path.isAbsolute(value)) return value;
    const relative = path.relative(sourceOutputDir, path.resolve(value));
    if (relative.startsWith('..') || path.isAbsolute(relative)) return value;
    return path.join(destinationOutputDir, relative);
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      relocateValue(entry, sourceOutputDir, destinationOutputDir),
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        relocateValue(entry, sourceOutputDir, destinationOutputDir),
      ]),
    );
  }
  return value;
}

/**
 * Rebase execution-owned artifact references when its state and artifact tree
 * move between the live and archived execution roots. The recursive walk also
 * preserves and relocates future path-bearing state fields that this app
 * version does not know about yet.
 */
export function relocateExecutionStateArtifactPaths(
  state: ExecutionState,
  sourceExecutionsDir: string,
  destinationExecutionsDir: string,
  executionId: string,
): ExecutionState;
export function relocateExecutionStateArtifactPaths(
  state: Record<string, unknown>,
  sourceExecutionsDir: string,
  destinationExecutionsDir: string,
  executionId: string,
): Record<string, unknown>;
export function relocateExecutionStateArtifactPaths(
  state: unknown,
  sourceExecutionsDir: string,
  destinationExecutionsDir: string,
  executionId: string,
): unknown {
  return relocateValue(
    state,
    path.resolve(sourceExecutionsDir, executionId),
    path.resolve(destinationExecutionsDir, executionId),
  );
}
